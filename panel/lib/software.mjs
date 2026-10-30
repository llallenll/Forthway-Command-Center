/**
 * Server software updates (Settings → Updates → "Server software").
 *
 * For every server: which PHP, MySQL/MariaDB and cloudflared it runs and
 * whether a newer one is available, and a per-server "Update" that installs
 * it. The work happens on the server itself through the `server.software`
 * task (shared/software.mjs); this module keeps the last result per server
 * in <dataDir>/software-state.json and asks GitHub for the newest cloudflared
 * release (cloudflared has no package list to compare against).
 *
 *   GET  /api/software                     state for every server
 *   POST /api/software/check               job: check every online server (apt-get update)
 *   POST /api/software/upgrade { serverId, component }   job (heavy: waits in the job queue)
 *
 * A check runs on its own every 12 hours. Updating cloudflared on main
 * restarts the tunnel connectors the panel runs; on agents the task restarts
 * their fcc-cloudflared-* units.
 */

import fs from "node:fs";
import path from "node:path";

import { httpError } from "./http.mjs";
import { COMPONENTS, CLOUDFLARED_LATEST_API, compareDotted } from "../../shared/software.mjs";

const CHECK_EVERY_MS = 12 * 60 * 60_000;
const FIRST_CHECK_MS = 2 * 60_000;
const LATEST_TTL_MS = 6 * 60 * 60_000;
const NAMES = { php: "PHP", mysql: "MySQL", cloudflared: "cloudflared" };

export function register(router, ctx) {
  const file = path.join(ctx.dataDir, "software-state.json");
  let state = { servers: {}, cloudflaredLatest: null };
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (s && typeof s === "object") state = { servers: s.servers || {}, cloudflaredLatest: s.cloudflaredLatest || null };
  } catch {
    /* first run */
  }
  let checkJob = null;
  const upgrading = new Map(); // `${serverId}:${component}` -> jobId

  const save = () => {
    try {
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error(`[software] could not save ${file}: ${err.message}`);
    }
  };

  function githubToken() {
    const g = ctx.config.github || {};
    for (const v of [g.tokenEnc, g.token]) {
      if (!v) continue;
      try {
        return v === g.tokenEnc ? ctx.secrets.decrypt(v) : String(v).trim();
      } catch {
        /* try the next one */
      }
    }
    return "";
  }

  async function cloudflaredLatest({ force = false } = {}) {
    const L = state.cloudflaredLatest;
    if (!force && L?.checkedAt && Date.now() - Date.parse(L.checkedAt) < LATEST_TTL_MS) return L;
    try {
      const headers = { Accept: "application/vnd.github+json", "User-Agent": "forthway-command-center" };
      const token = githubToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(CLOUDFLARED_LATEST_API, { headers, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
      const j = await res.json();
      const version = String(j.tag_name || "").replace(/^v/, "");
      if (!/^\d{4}\.\d{1,2}\.\d+$/.test(version)) throw new Error("GitHub returned no version");
      state.cloudflaredLatest = { version, url: String(j.html_url || ""), publishedAt: j.published_at || null, checkedAt: new Date().toISOString(), error: null };
    } catch (err) {
      state.cloudflaredLatest = { ...(L || {}), checkedAt: new Date().toISOString(), error: `Couldn't ask GitHub for the newest cloudflared: ${err.message}` };
    }
    return state.cloudflaredLatest;
  }

  /** What the page shows for one server. */
  function publicServer(sv) {
    const rec = state.servers[sv.id] || {};
    const r = rec.result || null;
    const latest = state.cloudflaredLatest?.version || null;
    const comp = (c) => {
      const x = r?.[c];
      if (!x) return null;
      const jobId = upgrading.get(`${sv.id}:${c}`) || null;
      if (c === "cloudflared") {
        const available = !!(x.installed && x.version && latest && compareDotted(latest, x.version) > 0);
        return { ...x, latest: latest || x.version, available, canUpdate: available && x.managedBy !== "other", jobId };
      }
      const available = !!x.upgrades?.length;
      return { ...x, available, canUpdate: available, jobId };
    };
    return {
      id: sv.id,
      name: sv.name,
      role: sv.role,
      online: !!sv.online,
      checkedAt: rec.checkedAt || null,
      error: rec.error || null,
      simulated: !!r?.simulated,
      apt: r ? r.apt !== false : null,
      php: comp("php"),
      mysql: comp("mysql"),
      cloudflared: comp("cloudflared"),
    };
  }

  function status() {
    const servers = (ctx.cluster?.listServers?.() || [{ id: "main", name: "Main", role: "main", online: true }]).map(publicServer);
    const updates = servers.reduce((n, s) => n + COMPONENTS.filter((c) => s[c]?.available).length, 0);
    return { servers, cloudflaredLatest: state.cloudflaredLatest, checking: checkJob, updates };
  }
  const broadcast = () => {
    try {
      ctx.events?.broadcast?.("software", status());
    } catch {
      /* no SSE */
    }
  };

  async function checkServer(sv, { refresh, log, signal }) {
    try {
      const result = await ctx.cluster.runTask(sv.id, "server.software", { action: "check", refresh }, { log: (l) => log(`[${sv.name}] ${l}`), signal, timeoutMs: 15 * 60_000 });
      state.servers[sv.id] = { checkedAt: new Date().toISOString(), result, error: null };
    } catch (err) {
      const old = state.servers[sv.id] || {};
      state.servers[sv.id] = { ...old, checkedAt: new Date().toISOString(), error: /does not know the task/.test(err.message) ? `${sv.name}'s agent is too old to report this — it updates itself the next time it reconnects to the panel.` : err.message };
      log(`[${sv.name}] !! ${err.message}`);
    }
  }

  function startCheck({ admin = null, refresh = true } = {}) {
    if (checkJob) return ctx.jobs.get?.(checkJob) || { id: checkJob };
    const job = ctx.jobs.start({ type: "software.check", title: "Check PHP, MySQL and cloudflared for updates", adminId: admin?.id || null, lock: "software:check" }, async ({ log, signal }) => {
      try {
        const all = ctx.cluster?.listServers?.() || [];
        const online = all.filter((s) => s.online);
        for (const s of all.filter((x) => !x.online)) log(`${s.name} is offline — skipped.`);
        await Promise.all([cloudflaredLatest({ force: true }), ...online.map((sv) => checkServer(sv, { refresh, log, signal }))]);
        if (state.cloudflaredLatest?.version) log(`Newest cloudflared: ${state.cloudflaredLatest.version}`);
        save();
        const st = status();
        log(st.updates ? `${st.updates} update${st.updates === 1 ? "" : "s"} available.` : "Everything is up to date.");
        return { updates: st.updates };
      } finally {
        checkJob = null;
        broadcast();
      }
    });
    checkJob = job.id;
    broadcast();
    return job;
  }

  function startUpgrade({ serverId, component, admin }) {
    if (!COMPONENTS.includes(component)) throw httpError(400, "Pick PHP, MySQL or cloudflared.");
    const sv = (ctx.cluster?.listServers?.() || []).find((s) => s.id === serverId);
    if (!sv) throw httpError(404, "No such server.");
    if (!sv.online) throw httpError(409, `${sv.name} is offline.`);
    const key = `${serverId}:${component}`;
    if (upgrading.has(key)) throw httpError(409, `${NAMES[component]} is already being updated on ${sv.name}.`);
    const latest = state.cloudflaredLatest?.version || null;
    const job = ctx.jobs.start(
      {
        type: "software.upgrade",
        title: `Update ${NAMES[component]} on ${sv.name}`,
        serverId,
        adminId: admin?.id || null,
        lock: `software:${serverId}`,
        heavy: true,
        servers: [serverId],
      },
      async ({ log, signal }) => {
        try {
          const r = await ctx.cluster.runTask(serverId, "server.software", { action: "upgrade", component, latest }, { log, signal });
          if (r?.check) {
            // A dry run's check is sample data: only take the part that was "updated".
            const prev = state.servers[serverId]?.result;
            const result = r.check.simulated && prev ? { ...prev, [component]: r.check[component] } : r.check;
            state.servers[serverId] = { checkedAt: new Date().toISOString(), result, error: null };
          }
          save();
          if (component === "cloudflared" && serverId === "main") {
            const n = await ctx.cloudflare?.restartConnectors?.(log);
            if (n) log(`Restarted ${n} tunnel connector${n === 1 ? "" : "s"} on the new cloudflared.`);
          }
          return { upgraded: r?.upgraded || [], restarted: r?.restarted || [] };
        } finally {
          upgrading.delete(key);
          broadcast();
        }
      },
      // Cancelled while it waited in the job queue: it never ran.
      { onDropped: () => { upgrading.delete(key); broadcast(); } },
    );
    upgrading.set(key, job.id);
    broadcast();
    return job;
  }

  ctx.software = { status, startCheck, _state: { timers: [] } };

  router.get("/api/software", () => status());
  router.post("/api/software/check", (_req, _res, { admin }) => startCheck({ admin }));
  router.post("/api/software/upgrade", (_req, _res, { body, admin }) => startUpgrade({ serverId: String(body?.serverId || ""), component: String(body?.component || ""), admin }));
}

export async function start(ctx) {
  const sw = ctx.software;
  if (!sw) return;
  const tick = () => {
    try {
      sw.startCheck({ refresh: true });
    } catch (err) {
      console.error(`[software] scheduled check failed: ${err.message}`);
    }
  };
  const first = setTimeout(tick, FIRST_CHECK_MS);
  first.unref?.();
  const every = setInterval(tick, CHECK_EVERY_MS);
  every.unref?.();
  sw._state.timers.push(first, every);
}

export function stop(ctx) {
  for (const t of ctx.software?._state?.timers || []) {
    clearTimeout(t);
    clearInterval(t);
  }
}
