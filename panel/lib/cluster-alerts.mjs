/**
 * CLUSTER ALERTS — SMS / Discord alerts when the panel or the database fails
 * over (docs/HA.md, Phase 3 "Cluster alerts"). Module `cluster-alerts`, listed
 * right after `monitor` in server.mjs.
 *
 *   ctx.clusterAlerts.send(kind, details) → Promise<result>  (never throws)
 *
 * | kind             | sent when                                                      | channels      |
 * |------------------|----------------------------------------------------------------|---------------|
 * | panel.failover   | this node took over and the previous active panel was lost     | SMS + Discord |
 * | panel.handover   | a planned "Make active panel" finished on this node            | Discord only  |
 * | panel.recovered  | after a failover, the previous active panel is back as standby | SMS + Discord |
 * | db.failover      | the database replica was promoted (mysql-ha.mjs)               | SMS + Discord |
 * | db.broken        | replication stopped with an error for 2 min (mysql-ha.mjs)     | SMS + Discord |
 * | db.rebuilt       | a server became the database replica again (mysql-ha.mjs)      | SMS + Discord |
 *
 * Delivery goes through ctx.monitor.clusterAlert (monitor.mjs): every enabled
 * Discord webhook and the DEFAULT text recipients only (never per-site ones),
 * with monitor's retries, rate limits, secret scrubbing and DRY_RUN
 * simulation. Settings: config.notifications.cluster = { enabled, sms, discord }
 * (all default on). The same kind + subject goes out at most once per 10 min
 * (FCC_CLUSTER_ALERT_DEDUPE_SEC overrides, for testing). Every alert — sent,
 * skipped or failed — is written to Activity as `cluster.alert` (no secrets,
 * phone numbers masked).
 *
 * Panel events come from ctx.ha: "promoted" (reason failover | handover) is
 * turned into panel.failover / panel.handover; after a failover the previous
 * leader is watched (ha.panelNodes(), cluster "servers-changed") and
 * panel.recovered is sent once when it is back online as a standby.
 *
 * Routes: GET/PATCH /api/notifications/cluster, POST /api/notifications/cluster/test.
 */

import { httpError } from "./http.mjs";
import * as sys from "./sys.mjs";

const MINUTE = 60_000;
const DEDUPE_MS = Number(process.env.FCC_CLUSTER_ALERT_DEDUPE_SEC) > 0 ? Number(process.env.FCC_CLUSTER_ALERT_DEDUPE_SEC) * 1000 : 10 * MINUTE;
const RECOVERY_CHECK_MS = 5000;
const RECOVERY_WATCH_MS = 7 * 24 * 60 * MINUTE; // stop waiting for the old leader after a week
const TEST_COOLDOWN_MS = 5000;
const RECENT_MAX = 50;
const MAIN = "main";

export const KINDS = Object.freeze({
  "panel.failover": { label: "The panel moved to another server because its server went down", sms: true, discord: true },
  "panel.handover": { label: "The panel was moved to another server as planned", sms: false, discord: true },
  "panel.recovered": { label: "The server that ran the panel is back online as a standby", sms: true, discord: true },
  "db.failover": { label: "The database moved to its replica", sms: true, discord: true },
  "db.broken": { label: "Database replication stopped with an error", sms: true, discord: true },
  "db.rebuilt": { label: "A server became the database replica again", sms: true, discord: true },
});

const SETTINGS_DEFAULTS = Object.freeze({ enabled: true, sms: true, discord: true });

const clean = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const iso = (t = Date.now()) => new Date(t).toISOString();

let api = null;

export function register(router, ctx) {
  api = createClusterAlerts(ctx);
  ctx.clusterAlerts = api.public;
  api.routes(router);
}

export async function start() {
  api?.start();
}

export async function stop() {
  api?.stop();
}

/**
 * Builds the alert text for a kind. Exported for tests.
 * `name(id)` maps a server id to its display name; `details` is what the caller passed.
 */
export function buildAlert(kind, details = {}, { name = (id) => id || "a server", leaderName = "" } = {}) {
  const d = details && typeof details === "object" ? details : {};
  const n = (id) => clean(name(id), 60) || "a server";
  const err = clean(d.error || d.lastError || d.reason || "", 160);
  switch (kind) {
    case "panel.failover": {
      const prev = d.previousLeaderId ? n(d.previousLeaderId) : "The server running the panel";
      const now = n(d.newLeaderId);
      return {
        subject: d.previousLeaderId || "",
        title: `Panel failover: now running on ${now}`,
        text: `${prev} went down. The panel is now running on ${now}. Websites, sign-ins and agents keep working through it.`,
        smsText: `FCC panel failover: ${prev} went down. The panel is now running on ${now}.`,
        color: "danger",
        mention: true,
        fields: [
          { name: "Went down", value: prev },
          { name: "Active panel now", value: now },
          d.term != null ? { name: "Term", value: String(d.term) } : null,
        ].filter(Boolean),
        panelPath: "servers",
      };
    }
    case "panel.handover": {
      const prev = d.previousLeaderId ? n(d.previousLeaderId) : "the previous server";
      const now = n(d.newLeaderId);
      return {
        subject: `${d.previousLeaderId || ""}>${d.newLeaderId || ""}`,
        title: `Panel moved to ${now}`,
        text: `The panel was moved from ${prev} to ${now} as planned. Nothing else needs to be done.`,
        smsText: `FCC: the panel was moved from ${prev} to ${now} as planned.`,
        color: "info",
        mention: false,
        fields: [
          { name: "From", value: prev },
          { name: "To", value: now },
        ],
        panelPath: "servers",
      };
    }
    case "panel.recovered": {
      const back = n(d.serverId);
      const leader = clean(leaderName, 60) || n(d.leaderId);
      return {
        subject: d.serverId || "",
        title: `${back} is back online`,
        text: `${back} is back online as a standby panel node. The panel keeps running on ${leader}. To move it back, open Servers and use "Make active panel" on ${back}.`,
        smsText: `FCC: ${back} is back online as a standby. The panel stays on ${leader}; use "Make active panel" to move it back.`,
        color: "ok",
        mention: false,
        fields: [
          { name: "Back online", value: back },
          { name: "Active panel", value: leader },
        ],
        panelPath: "servers",
      };
    }
    case "db.failover": {
      const fromId = d.from ?? d.oldPrimary ?? d.previousPrimary ?? d.fromServerId ?? null;
      const toId = d.to ?? d.newPrimary ?? d.primary ?? d.toServerId ?? d.serverId ?? null;
      const from = fromId ? n(fromId) : "The primary database server";
      const to = toId ? n(toId) : "the replica";
      const manual = d.manual === true || d.promoted === false || d.action === "manual";
      if (manual) {
        return {
          subject: `manual:${fromId || ""}`,
          title: `Database down on ${from.replace(/^The /, "the ")}`,
          text: `${from} has not answered for over a minute. Automatic failover is off: open Databases → Replication and promote ${to} to bring databases back.`,
          smsText: `FCC database DOWN on ${from}. Automatic failover is off: promote ${to} in Databases > Replication.`,
          color: "danger",
          mention: true,
          fields: [{ name: "Primary", value: from }, { name: "Replica", value: to }],
          panelPath: "databases",
        };
      }
      const partial = d.appliedAll === false ? " Some of the very latest changes may not have reached it." : "";
      return {
        subject: `${fromId || ""}>${toId || ""}`,
        title: `Database failover: ${to} is now the primary`,
        text: `${from} stopped answering. ${to.charAt(0).toUpperCase() + to.slice(1)} is now the primary database and websites were switched to it automatically.${partial} ${from} will be rebuilt as the replica when it comes back.`,
        smsText: `FCC database failover: ${from} went down. ${to} is now the primary database.${d.appliedAll === false ? " Latest changes may be missing." : ""}`,
        color: "danger",
        mention: true,
        fields: [
          { name: "Went down", value: from },
          { name: "Primary now", value: to },
          d.appliedAll != null ? { name: "All changes applied", value: d.appliedAll ? "Yes" : "Not confirmed" } : null,
        ].filter(Boolean),
        panelPath: "databases",
      };
    }
    case "db.broken": {
      const replicaId = d.replica ?? d.serverId ?? null;
      const replica = replicaId ? n(replicaId) : "the replica";
      const primary = d.primary ? n(d.primary) : "the primary";
      return {
        subject: replicaId || "",
        title: `Database replication stopped on ${replica}`,
        text: `Replication from ${primary} to ${replica} stopped${err ? `: ${err.replace(/[.\s]+$/, "")}.` : "."} Websites keep using ${primary}, but ${replica} is no longer up to date, so it cannot take over safely until this is fixed.`,
        smsText: `FCC: database replication to ${replica} stopped${err ? `: ${err}` : ""}. Failover is not safe until fixed.`,
        color: "warn",
        mention: true,
        fields: [{ name: "Replica", value: replica }, { name: "Primary", value: primary }, err ? { name: "Error", value: err, inline: false } : null].filter(Boolean),
        panelPath: "databases",
      };
    }
    case "db.rebuilt": {
      const sid = d.serverId ?? d.replica ?? null;
      const who = sid ? n(sid) : "A server";
      const primary = d.primary ? n(d.primary) : "";
      return {
        subject: sid || "",
        title: `${who} is the database replica again`,
        text: `${who} was rebuilt as the database replica${primary ? ` of ${primary}` : ""} and replication is running. Databases can fail over again.`,
        smsText: `FCC: ${who} is the database replica again; replication is running.`,
        color: "ok",
        mention: false,
        fields: [{ name: "Replica", value: who }, primary ? { name: "Primary", value: primary } : null].filter(Boolean),
        panelPath: "databases",
      };
    }
    case "test":
      return {
        subject: `test:${Date.now()}`,
        title: "Test cluster alert",
        text: "Cluster alerts (panel and database failover) will be sent here. Nothing has failed.",
        smsText: "FCC test: cluster alerts (panel and database failover) will be texted to this number.",
        color: "info",
        mention: false,
        fields: [],
        panelPath: "settings/notifications",
      };
    default:
      return null;
  }
}

function createClusterAlerts(ctx) {
  const dedupe = new Map(); // `${kind}|${subject}` -> ms
  const recent = []; // [{ at, kind, title, ok, skipped, sms, discord }]
  const timers = [];
  const unsubs = [];
  let pendingRecovery = null; // { serverId, since, term }
  let lastTestAt = 0;

  function settings() {
    const c = ctx.config.notifications?.cluster || {};
    return {
      enabled: c.enabled !== false,
      sms: c.sms !== false,
      discord: c.discord !== false,
    };
  }

  function serverName(id) {
    if (!id) return "";
    let s = null;
    try {
      s = ctx.db.get("servers", id);
    } catch { /* no db */ }
    return s?.name || (id === MAIN ? "Main" : id);
  }

  function localId() {
    return ctx.ha?.localServerId || MAIN;
  }

  function record(entry) {
    recent.unshift(entry);
    if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
  }

  function summarize(ch) {
    const r = ch?.results || [];
    return {
      attempted: !!ch?.attempted,
      reason: ch?.reason || null,
      sent: r.filter((x) => x.ok).length,
      failed: r.filter((x) => !x.ok && !x.skipped).length,
      skipped: r.filter((x) => x.skipped).length,
      simulated: r.some((x) => x.simulated),
    };
  }

  function audit(kind, title, details, admin = null) {
    try {
      ctx.activity?.(admin, "cluster.alert", { type: "cluster", id: kind, name: title }, details);
    } catch { /* audit is best effort */ }
  }

  /**
   * Sends one cluster alert. Never throws. Resolves
   * { ok, kind, skipped?: reason, title, sms: summary, discord: summary }.
   */
  async function send(kind, details = {}, { force = false, admin = null } = {}) {
    try {
      const meta = KINDS[kind] || (kind === "test" ? { sms: true, discord: true } : null);
      if (!meta) {
        console.warn(`[cluster-alerts] unknown alert kind "${clean(kind, 40)}" — ignored`);
        return { ok: false, kind, skipped: "unknown kind" };
      }
      const d = details && typeof details === "object" ? details : {};
      const leaderName = serverName(ctx.ha?.leaderId?.() || localId());
      const msg = buildAlert(kind, { newLeaderId: localId(), ...d }, { name: serverName, leaderName });
      const st = settings();
      const subjectKey = `${kind}|${clean(d.subject ?? msg.subject, 120)}`;
      const skip = (why) => {
        console.log(`[cluster-alerts] ${kind}: ${msg.title} — not sent (${why})`);
        audit(kind, msg.title, { kind, skipped: why, text: msg.text });
        record({ at: iso(), kind, title: msg.title, ok: false, skipped: why });
        return { ok: false, kind, title: msg.title, skipped: why };
      };
      if (!force && !st.enabled) return skip("cluster alerts are turned off");
      const useSms = meta.sms && st.sms;
      const useDiscord = meta.discord && st.discord;
      if (!useSms && !useDiscord) return skip("no channel is turned on for this alert");
      if (!force) {
        const last = dedupe.get(subjectKey) || 0;
        if (Date.now() - last < DEDUPE_MS) return skip(`the same alert was sent ${Math.round((Date.now() - last) / 1000)} s ago`);
        dedupe.set(subjectKey, Date.now());
        for (const [k, t] of dedupe) if (Date.now() - t > DEDUPE_MS * 2) dedupe.delete(k);
      }
      if (typeof ctx.monitor?.clusterAlert !== "function") return skip("the monitor module is not loaded");

      const out = await ctx.monitor.clusterAlert({
        kind,
        subject: subjectKey,
        title: msg.title,
        text: msg.text,
        smsText: msg.smsText,
        color: msg.color,
        sms: useSms,
        discord: useDiscord,
        mention: !!msg.mention,
        fields: msg.fields,
        panelPath: msg.panelPath,
      });
      const sms = summarize(out?.sms);
      const discord = summarize(out?.discord);
      const ok = sms.sent + discord.sent > 0;
      const errors = [...(out?.sms?.results || []), ...(out?.discord?.results || [])]
        .filter((x) => !x.ok && x.error)
        .map((x) => `${x.to}: ${clean(x.error, 200)}`)
        .slice(0, 10);
      const sim = sms.simulated || discord.simulated ? " (dry run: simulated)" : "";
      console.log(`[cluster-alerts] ${kind}: ${msg.title} — SMS ${sms.attempted ? `${sms.sent} sent, ${sms.failed} failed, ${sms.skipped} skipped` : `not sent (${sms.reason})`} · Discord ${discord.attempted ? `${discord.sent} sent, ${discord.failed} failed` : `not sent (${discord.reason})`}${sim}`);
      audit(kind, msg.title, {
        kind,
        text: msg.text,
        sms: { sent: sms.sent, failed: sms.failed, skipped: sms.skipped, simulated: sms.simulated || undefined, reason: sms.attempted ? undefined : sms.reason },
        discord: { sent: discord.sent, failed: discord.failed, simulated: discord.simulated || undefined, reason: discord.attempted ? undefined : discord.reason },
        errors: errors.length ? errors : undefined,
        test: kind === "test" || undefined,
      }, admin);
      record({ at: iso(), kind, title: msg.title, ok, sms, discord, errors });
      try {
        ctx.events?.broadcast("cluster-alert", { kind, title: msg.title, ok, at: iso() });
      } catch { /* no SSE */ }
      return { ok, kind, title: msg.title, text: msg.text, sms, discord, errors };
    } catch (err) {
      console.warn(`[cluster-alerts] ${kind}: ${err.message}`);
      return { ok: false, kind, error: err.message };
    }
  }

  // ------------------------------------------------------- panel events

  function onPromoted(e) {
    const ev = e && typeof e === "object" ? e : {};
    const me = localId();
    const prev = typeof ev.previousLeaderId === "string" && ev.previousLeaderId ? ev.previousLeaderId : null;
    if (ev.reason === "handover") {
      pendingRecovery = null;
      send("panel.handover", { previousLeaderId: prev, newLeaderId: me, term: ev.term });
      return;
    }
    if (prev && prev === me) {
      // This node led before and took over again after its own restart: not a failover.
      console.log(`[cluster-alerts] active panel again after a restart of this node (term ${ev.term}) — no failover alert`);
      return;
    }
    send("panel.failover", { previousLeaderId: prev, newLeaderId: me, term: ev.term });
    if (prev) {
      pendingRecovery = { serverId: prev, since: Date.now(), term: ev.term };
      checkRecovery();
    }
  }

  /** After a failover: is the previous leader back online as a standby? Sends panel.recovered once. */
  function checkRecovery() {
    const p = pendingRecovery;
    if (!p) return;
    try {
      if (Date.now() - p.since > RECOVERY_WATCH_MS) {
        pendingRecovery = null;
        return;
      }
      if (ctx.ha?.isLeader && !ctx.ha.isLeader()) return;
      if (p.serverId === localId()) {
        pendingRecovery = null;
        return;
      }
      const nodes = typeof ctx.ha?.panelNodes === "function" ? ctx.ha.panelNodes() : [];
      const node = nodes.find((x) => x.serverId === p.serverId);
      let back = false;
      if (node) back = node.online === true && node.role !== "leader";
      else {
        // No longer a panel node (removed meanwhile): its server being online is enough.
        const exists = !!ctx.db.get("servers", p.serverId);
        if (!exists) {
          pendingRecovery = null;
          return;
        }
        back = !!ctx.cluster?.isOnline?.(p.serverId);
      }
      if (!back) return;
      pendingRecovery = null;
      send("panel.recovered", { serverId: p.serverId, leaderId: localId() });
    } catch (err) {
      console.warn(`[cluster-alerts] recovery check: ${err.message}`);
    }
  }

  // ------------------------------------------------------------ routes

  function view() {
    let channels = null;
    try {
      channels = ctx.monitor?.clusterChannels?.() || null;
    } catch { /* monitor missing */ }
    return {
      ...settings(),
      kinds: Object.entries(KINDS).map(([kind, m]) => ({ kind, label: m.label, sms: m.sms, discord: m.discord })),
      channels,
      dedupeMinutes: Math.round((DEDUPE_MS / MINUTE) * 10) / 10,
      dryRun: sys.DRY_RUN,
      pendingRecovery: pendingRecovery ? { serverId: pendingRecovery.serverId, name: serverName(pendingRecovery.serverId), since: iso(pendingRecovery.since) } : null,
      recent: recent.slice(0, 20),
    };
  }

  function routes(router) {
    router.get("/api/notifications/cluster", () => view());

    router.patch("/api/notifications/cluster", (req, res, { body = {}, admin }) => {
      if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError(400, "Send a JSON object.");
      const cur = settings();
      const next = { ...cur };
      const fields = [];
      for (const k of ["enabled", "sms", "discord"]) {
        if (body[k] === undefined) continue;
        if (typeof body[k] !== "boolean") throw httpError(400, `"${k}" must be true or false.`);
        if (body[k] !== cur[k]) fields.push(k);
        next[k] = body[k];
      }
      const n = { ...(ctx.config.notifications || {}) };
      n.cluster = next;
      ctx.config.notifications = n;
      ctx.saveConfig();
      if (fields.length) {
        try {
          ctx.activity?.(admin, "notifications.cluster.update", { type: "settings", id: "notifications", name: "Notifications" }, { fields, ...Object.fromEntries(fields.map((f) => [f, next[f]])) });
        } catch { /* best effort */ }
      }
      try {
        ctx.events?.broadcast("monitor", { kind: "notifications" });
      } catch { /* no SSE */ }
      return view();
    });

    router.post("/api/notifications/cluster/test", async (req, res, { admin }) => {
      if (Date.now() - lastTestAt < TEST_COOLDOWN_MS) throw httpError(429, "Wait a few seconds between test alerts.");
      const st = settings();
      if (!st.sms && !st.discord) throw httpError(400, "Turn on texts or Discord for cluster alerts first.");
      lastTestAt = Date.now();
      const r = await send("test", {}, { force: true, admin });
      return r;
    });
  }

  // --------------------------------------------------------- lifecycle

  function startAll() {
    try {
      if (typeof ctx.ha?.on === "function") unsubs.push(ctx.ha.on("promoted", onPromoted));
      if (typeof ctx.ha?.on === "function") unsubs.push(ctx.ha.on("status", () => checkRecovery()));
    } catch (err) {
      console.warn(`[cluster-alerts] could not watch the panel's role: ${err.message}`);
    }
    try {
      const off = ctx.cluster?.on?.("servers-changed", (e) => {
        if (!e || e.reason === "online" || e.reason === "hello") checkRecovery();
      });
      if (typeof off === "function") unsubs.push(off);
    } catch { /* cluster missing */ }
    const t = setInterval(checkRecovery, RECOVERY_CHECK_MS);
    t.unref?.();
    timers.push(t);
  }

  function stopAll() {
    for (const t of timers) clearInterval(t);
    timers.length = 0;
    for (const u of unsubs.splice(0)) {
      try {
        u?.();
      } catch { /* gone */ }
    }
  }

  return {
    routes,
    start: startAll,
    stop: stopAll,
    public: {
      send: (kind, details) => send(kind, details),
      kinds: () => Object.keys(KINDS),
      settings,
      recent: () => recent.slice(),
      _onPromoted: onPromoted, // tests
    },
  };
}
