/**
 * Change the main server (3.12.0) — move the "main" role to another server and
 * retire the old main machine.
 *
 * "main" is an identity, not a machine: the server record with id "main" is the
 * one that runs the front door, the tunnel connectors, Let's Encrypt and the
 * panel without an agent. Changing the main server gives that identity to an
 * agent server X that already runs the panel:
 *
 *   1. Preflight (GET /api/servers/:id/make-main): X must be the active panel
 *      (a standby panel node made active), no other standby panel nodes, no
 *      websites left on the old main, and the databases not living only on the
 *      old main. Every step that blocks says what to do.
 *   2. Databases: if the old main is the database primary and X its replica, a
 *      switchover first; if the old main is the replica, replication is turned
 *      off (it can be turned on again with another server afterwards).
 *   3. Transfer from the old main (through its embedded agent, task main.handoff):
 *      every local backup archive this server does not have, and /etc/letsencrypt.
 *      Panel data, releases and settings are already here (replication).
 *   4. Retire the old main (task main.retire): a moment later it stops and
 *      disables fcc.service and moves its data folder aside.
 *   5. Tell every agent the panel address to use from now on (config.agentPanelUrl,
 *      sent with each hello/poll reply; agents ≥ 3.5.0 save it).
 *   6. Rewrite the identity: X's record becomes "main" (sites, releases, backups,
 *      database replication, backup schedule, metrics, usage); the old main's
 *      server backups are kept under a retired id; panel failover is turned off
 *      (no standbys are left). ha-local.json says "main", fcc-node on X is stopped
 *      and disabled (main runs its tasks in the panel), and the panel restarts.
 *   7. After the restart (as main): once the in-process tunnel connectors are up,
 *      what fcc-node had set up as an edge (connector replicas, catch-all, shims)
 *      is taken down (shared/edge.mjs retireEdge). The site front door files were
 *      already rewritten by loadbalancer.mjs.
 *
 * Nothing on the old machine is deleted: its websites' files, nginx and MySQL stay
 * until the machine is shut down; its panel data folder is kept, renamed.
 */

import fs from "node:fs";
import path from "node:path";

import { httpError } from "./http.mjs";
import * as sys from "./sys.mjs";
import { writeFileAtomic } from "./store.mjs";

const MAIN_ID = "main";
const MARKER = "main-switch.json";
const AGENT_URL_MIN = "3.5.0"; // first agent that saves a new panel address (adoptPanelUrl)
const RETIRE_DELAY_S = 20;
const AGENT_URL_WAIT_MS = 30_000; // one long poll (25 s) and a little: every online agent hears the new address
const EDGE_CLEANUP_DELAY_MS = 20_000; // after boot: let cloudflare.mjs start its connectors first
const EXIT_DELAY_MS = 1500;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const HA_OFF = Object.freeze({ enabled: false, localServerId: MAIN_ID, mainIsLocal: true, isLeader: () => true });

function versionAtLeast(v, min) {
  const a = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ""));
  if (!a) return false;
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = Number(a[i + 1]);
    if (x !== b[i]) return x > b[i];
  }
  return true;
}

const stampOf = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
const mb = (n) => `${((Number(n) || 0) / 1048576).toFixed(1)} MB`;

function validUrl(u) {
  try {
    const x = new URL(String(u || ""));
    return /^https?:$/.test(x.protocol) && x.hostname ? `${x.protocol}//${x.host}` : null;
  } catch {
    return null;
  }
}
const hostOf = (u) => {
  try {
    return new URL(String(u)).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
};

// ------------------------------------------------------------ identity rewrite

/**
 * Pure: give server `fromId` the "main" identity in plain copies of the db
 * collections and config.json. The old "main" record is dropped; references to it
 * that are kept (server backups, build records) move to `retiredId`.
 * Returns { servers, sites, releases, backups, config, counts }.
 */
export function remapIdentity({ servers = [], sites = [], releases = [], backups = [], config = {} }, { fromId, retiredId, now = new Date().toISOString() }) {
  if (!fromId || fromId === MAIN_ID || !ID_RE.test(fromId)) throw new Error("remapIdentity: fromId must be an agent server id");
  if (!retiredId || !ID_RE.test(retiredId) || retiredId === MAIN_ID || retiredId === fromId) throw new Error("remapIdentity: bad retiredId");
  const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
  const counts = { sites: 0, releases: 0, backups: 0 };
  const map = (id) => (id === fromId ? MAIN_ID : id);
  const dedupe = (arr) => [...new Set(arr)];

  const oldMain = servers.find((s) => s.id === MAIN_ID) || null;
  const x = servers.find((s) => s.id === fromId);
  if (!x) throw new Error(`remapIdentity: server ${fromId} not found`);
  const { edge, edgeSync, panel, role, ...keep } = clone(x);
  const newMain = {
    ...keep,
    id: MAIN_ID,
    role: "main",
    enabled: true,
    panel: { enabled: true, directUrl: panel?.directUrl || null },
    previousId: fromId,
    mainSince: now,
  };
  const outServers = [newMain, ...clone(servers.filter((s) => s.id !== MAIN_ID && s.id !== fromId))];

  const outSites = clone(sites).map((site) => {
    let changed = false;
    if (Array.isArray(site.serverIds)) {
      const next = dedupe(site.serverIds.filter((id) => id !== MAIN_ID).map(map));
      if (JSON.stringify(next) !== JSON.stringify(site.serverIds)) (site.serverIds = next), (changed = true);
    }
    for (const k of ["state", "weights"]) {
      const o = site[k];
      if (!o || typeof o !== "object" || Array.isArray(o)) continue;
      if (!(MAIN_ID in o) && !(fromId in o)) continue;
      const next = {};
      for (const [id, v] of Object.entries(o)) if (id !== MAIN_ID) next[map(id)] = v;
      site[k] = next;
      changed = true;
    }
    if (changed) counts.sites++;
    return site;
  });

  const outReleases = clone(releases).map((r) => {
    const b = r.built?.builtOn;
    if (b === MAIN_ID || b === fromId) {
      r.built.builtOn = b === MAIN_ID ? retiredId : MAIN_ID;
      counts.releases++;
    }
    return r;
  });

  const outBackups = clone(backups).map((b) => {
    if (b.serverId === MAIN_ID) {
      b.serverId = retiredId;
      b.serverName = b.serverName || (oldMain?.name ? `${oldMain.name} (old main)` : "Old main server");
      counts.backups++;
    } else if (b.serverId === fromId) {
      b.serverId = MAIN_ID;
      counts.backups++;
    }
    return b;
  });

  const c = clone(config) || {};
  // Database replication.
  if (c.mysqlHa && typeof c.mysqlHa === "object") {
    const m = c.mysqlHa;
    if (m.primary === MAIN_ID) m.primary = retiredId; // callers make sure this never happens with replication on
    if (m.primary === fromId) m.primary = MAIN_ID;
    if (m.replica === MAIN_ID) m.replica = null;
    if (m.replica === fromId) m.replica = MAIN_ID;
    if (Array.isArray(m.needsRebuild)) m.needsRebuild = dedupe(m.needsRebuild.filter((id) => id !== MAIN_ID).map(map));
    if (m.serverIds && typeof m.serverIds === "object") {
      const next = {};
      for (const [id, n] of Object.entries(m.serverIds)) if (id !== MAIN_ID) next[map(id)] = n;
      m.serverIds = next;
    }
  }
  // Scheduled server backups.
  if (Array.isArray(c.backups?.server?.serverIds)) {
    const next = dedupe(c.backups.server.serverIds.filter((id) => id !== MAIN_ID).map(map));
    c.backups.server.serverIds = next.length ? next : [MAIN_ID];
  }
  // Panel failover: no standby panel nodes are left (preflight), so it is off.
  if (c.ha && typeof c.ha === "object") {
    const { armed, handover, ...rest } = c.ha;
    c.ha = { ...rest, enabled: false };
  }
  // Facts about the old machine.
  if (c.cluster && typeof c.cluster === "object") {
    delete c.cluster.mainIps;
    delete c.cluster.mainNginx;
  }
  const oldHosts = new Set([oldMain?.host, oldMain?.privateHost].filter(Boolean).map((h) => String(h).toLowerCase()));
  if (c.mysql?.publicHost && oldHosts.has(String(c.mysql.publicHost).toLowerCase())) delete c.mysql.publicHost;
  c.retiredServers = [
    ...(Array.isArray(c.retiredServers) ? c.retiredServers : []),
    { id: retiredId, name: oldMain?.name || "Main", host: oldMain?.host || null, retiredAt: now, replacedBy: fromId },
  ].slice(-20);

  return { servers: outServers, sites: outSites, releases: outReleases, backups: outBackups, config: c, counts };
}

/**
 * Pure: rename object keys in a metrics.json / usage.json tree — `fromId` → "main",
 * "srv:<fromId>" → "srv:main", "<site>|<fromId>" → "<site>|main"; the old main's keys go.
 */
export function remapKeys(tree, fromId) {
  const oldKey = (k) => k === MAIN_ID || k === `srv:${MAIN_ID}` || k.endsWith(`|${MAIN_ID}`);
  const newKey = (k) => (k === fromId ? MAIN_ID : k === `srv:${fromId}` ? `srv:${MAIN_ID}` : k.endsWith(`|${fromId}`) ? `${k.slice(0, -fromId.length)}${MAIN_ID}` : k);
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) if (!oldKey(k)) out[newKey(k)] = walk(x);
    return out;
  };
  return walk(tree);
}

// ------------------------------------------------------------------ module

export function register(router, ctx) {
  const db = ctx.db;
  const ha = () => ctx.ha || HA_OFF;
  const cluster = () => ctx.cluster;
  let running = null; // job id

  const server = (id) => db.get("servers", id);
  const nameOf = (id) => server(id)?.name || id;
  const targetsOf = (site) => {
    try {
      const t = ctx.sites?.targets?.(site);
      if (Array.isArray(t)) return t;
    } catch {
      /* fall through */
    }
    const ids = Array.isArray(site.serverIds) ? site.serverIds : [];
    return site.loadBalanced ? ids : [ids[0] || MAIN_ID];
  };
  const isOnline = (id) => {
    try {
      return !!cluster()?.isOnline?.(id);
    } catch {
      return false;
    }
  };
  const panelPortOf = (x) => {
    try {
      return Number(new URL(x.panel?.directUrl).port) || Number(ctx.config.port) || 4000;
    } catch {
      return Number(ctx.config.port) || 4000;
    }
  };
  const backupsRoot = () => path.join(ctx.dataDir, "backups");

  /** The address agents (and, when it pointed at the old main, browsers) use after the switch. */
  function addresses(x) {
    const old = server(MAIN_ID);
    const oldHosts = new Set([old?.host, old?.privateHost, ...(ctx.config.cluster?.mainIps || [])].filter(Boolean).map((h) => String(h).toLowerCase()));
    const port = panelPortOf(x);
    const direct = validUrl(x.panel?.directUrl) || `http://${x.privateHost || x.host}:${port}`;
    const cfgUrl = validUrl(ctx.config.panelUrl);
    const cfgOld = !!cfgUrl && oldHosts.has(hostOf(cfgUrl));
    return {
      agentUrl: cfgUrl && !cfgOld ? cfgUrl : direct,
      panelUrl: cfgOld ? `${new URL(cfgUrl).protocol}//${x.host}:${port}` : null, // null = leave config.panelUrl alone
    };
  }

  /** Local backup archives the old main has and this server does not. */
  function missingBackups() {
    const root = backupsRoot();
    return db
      .list("backups")
      .filter((b) => b.status === "ok" && typeof b.file === "string" && b.file)
      .filter((b) => {
        const abs = path.resolve(root, b.file);
        return abs.startsWith(root + path.sep) && !fs.existsSync(abs);
      });
  }

  function hasLetsEncrypt() {
    return db.list("sites").some((s) => s.ssl?.enabled || s.ssl?.status === "active" || s.ssl?.issuedAt);
  }

  /**
   * Everything the switch needs, as a checklist:
   * { ok, target, oldMain, steps: [{ id, state: "ok"|"auto"|"todo"|"blocked"|"warn", title, detail }], transfer, addresses }
   */
  function preflight(targetId) {
    const x = server(targetId);
    if (!x) throw httpError(404, "Server not found.");
    if (x.id === MAIN_ID) throw httpError(400, "This server is already the main server.");
    const old = server(MAIN_ID);
    const h = ha();
    const steps = [];
    const add = (id, state, title, detail = null) => steps.push({ id, state, title, detail });

    // 1. Online and the active panel.
    if (x.enabled === false) add("enabled", "blocked", `Enable ${x.name}`, "A disabled server cannot become the main server.");
    else if (!isOnline(x.id)) add("online", "blocked", `${x.name} is offline`, "Its agent must be connected.");
    if (!x.panel?.enabled) {
      add("panel", "todo", `Make ${x.name} a panel node`, `The new main server must already run the panel: use “Make panel node” on ${x.name} (it needs to be an edge node, and there must be at least 3 servers). Its copy of the panel data is what the main server keeps.`);
    } else if (h.localServerId !== x.id || !h.isLeader?.()) {
      add("active", "todo", `Make ${x.name} the active panel`, `Use “Make active panel” on ${x.name}, then open the panel again and come back here. The switch runs from the new main server's own panel.`);
    } else add("active", "ok", `${x.name} runs the active panel`);

    // 2. No other standby panel nodes.
    const others = db.list("servers").filter((s) => s.id !== MAIN_ID && s.id !== x.id && s.panel?.enabled);
    if (others.length) add("standbys", "blocked", `Remove the panel from ${others.map((s) => s.name).join(", ")}`, "Panel failover is switched off while the main server changes. Use “Remove panel node”; you can make it a standby again afterwards.");

    // 3. Websites on the old main.
    const onOld = db.list("sites").filter((site) => targetsOf(site).includes(MAIN_ID));
    if (onOld.length) add("sites", "blocked", `Move ${onOld.length === 1 ? "1 website" : `${onOld.length} websites`} off ${old?.name || "the main server"}`, `${onOld.map((s) => s.name).join(", ")} — website → Settings → Hosting. Put ${onOld.length === 1 ? "it" : "them"} on ${x.name} or another server.`);
    else add("sites", "ok", `No websites run only on ${old?.name || "the main server"}`);

    // 4. Databases.
    const m = ctx.config.mysqlHa || {};
    const dbCount = db.list("databases").length;
    const primary = m.primary || MAIN_ID;
    let dbPlan = null; // "switchover" | "disable" | "switchover+disable"
    if (m.enabled) {
      if (primary === MAIN_ID) {
        if (m.replica === x.id) {
          dbPlan = "switchover+disable";
          add("databases", "auto", `Switch the database primary to ${x.name}`, `${x.name} is the replica: a planned switchover (no data loss, about 10 s of read-only), then replication is turned off because the old main goes away. Turn it on again with another server afterwards.`);
        } else add("databases", "blocked", `Move the database primary to ${x.name}`, `The databases' primary is ${old?.name || "the main server"}. Make ${x.name} the replica (Settings → Databases → Replication) and come back.`);
      } else if (m.replica === MAIN_ID) {
        dbPlan = "disable";
        add("databases", "auto", "Turn off database replication", `${old?.name || "The old main server"} is the replica. Replication is turned off (the primary, ${nameOf(primary)}, keeps every database). Turn it on again with another server afterwards.`);
      } else add("databases", "ok", `Databases live on ${nameOf(primary)}`);
    } else if (primary === MAIN_ID && dbCount) {
      add("databases", "blocked", `Copy the databases to ${x.name}`, `${dbCount === 1 ? "1 database lives" : `${dbCount} databases live`} on ${old?.name || "the main server"}. Turn on database replication with ${x.name} as the replica (Settings → Databases), then come back: the switch moves the primary to ${x.name}.`);
    } else add("databases", "ok", dbCount ? `Databases live on ${nameOf(primary)}` : "No databases to move");

    // 5. Transfer from the old main.
    const oldOnline = isOnline(MAIN_ID);
    const files = missingBackups();
    const le = hasLetsEncrypt();
    const bytes = files.reduce((n, b) => n + (Number(b.size) || 0), 0);
    const what = [files.length ? `${files.length} backup archive${files.length === 1 ? "" : "s"} (${mb(bytes)})` : null, le ? "the Let's Encrypt certificates" : "any Let's Encrypt certificates"].filter(Boolean).join(" and ");
    const codeOk = (() => {
      try {
        const n = (h.panelNodes?.() || []).find((p) => p.serverId === MAIN_ID);
        return n ? n.codeInSync !== false : true;
      } catch {
        return true;
      }
    })();
    if (!oldOnline) add("transfer", "warn", `${old?.name || "The old main server"} is offline — nothing can be copied from it`, `${files.length ? `${files.length} local backup archive${files.length === 1 ? "" : "s"} and ` : ""}its Let's Encrypt certificates stay on it. Websites behind Cloudflare Tunnels are not affected; certificates for direct domains can be issued again on ${x.name}.`);
    else if (!codeOk) add("transfer", "blocked", `Wait for ${old?.name || "the old main server"} to update`, "It still runs older panel code. Standbys follow the active panel within a minute.");
    else add("transfer", "auto", `Copy ${what} from ${old?.name || "the old main server"}`, "Panel data, settings, releases and secrets are already here (they are replicated to every panel node).");

    // 6. Agents learn the new address.
    const addr = addresses(x);
    const agents = db.list("servers").filter((s) => s.id !== MAIN_ID && s.id !== x.id && s.enabled !== false);
    const old_ = agents.filter((s) => isOnline(s.id) && !versionAtLeast(s.agentVersion, AGENT_URL_MIN));
    const offline = agents.filter((s) => !isOnline(s.id));
    if (old_.length) add("agents", "blocked", `Wait for ${old_.map((s) => s.name).join(", ")} to update`, `Agents update themselves when they reconnect (agent v${AGENT_URL_MIN} or newer is needed to learn the new panel address).`);
    else add("agents", offline.length ? "warn" : "auto", `Point the agents at ${addr.agentUrl}`, offline.length ? `${offline.map((s) => s.name).join(", ")} ${offline.length === 1 ? "is" : "are"} offline and will not hear the new address. If ${offline.length === 1 ? "it" : "they"} used ${old?.name || "the old main"}'s address, run ${offline.length === 1 ? "its" : "their"} install command again (Rotate token) afterwards.` : null);
    if (addr.panelUrl) add("panelUrl", "auto", `Change the panel URL to ${addr.panelUrl}`, `It pointed at ${old?.name || "the old main server"}.`);

    // 7. Retire.
    add("retire", oldOnline ? "auto" : "warn", `Retire ${old?.name || "the old main server"}`, oldOnline
      ? "It stops and disables its panel and keeps its data folder (renamed — it holds secrets). Its websites' files, nginx and MySQL are left alone: shut the machine down when you are ready."
      : `When it comes back it cannot rejoin (its token stops working). Stop it there with: systemctl disable --now fcc`);

    const ok = !steps.some((s) => s.state === "blocked" || s.state === "todo");
    return {
      ok,
      busy: running,
      target: { id: x.id, name: x.name, host: x.host },
      oldMain: old ? { id: MAIN_ID, name: old.name, host: old.host, online: oldOnline } : null,
      steps,
      transfer: { backups: files.length, bytes, letsencrypt: le, oldOnline },
      dbPlan,
      addresses: addr,
    };
  }

  // -------------------------------------------------------------- the job

  async function waitJob(job, what, log) {
    if (!job?.id) return;
    log(`… ${what} (job ${job.id})`);
    const j = await ctx.jobs.wait(job.id);
    if (j.status !== "succeeded") throw new Error(`${what} did not finish (${j.status}${j.error ? `: ${j.error}` : ""}). Nothing else was changed.`);
  }

  async function transfer(pf, { log, signal }) {
    if (!pf.transfer.oldOnline) {
      log("The old main server is offline: nothing is copied from it.");
      return { backups: 0, letsencrypt: false };
    }
    const files = missingBackups();
    let copied = 0;
    let failed = 0;
    if (files.length) log(`Copying ${files.length} backup archive(s), ${mb(files.reduce((n, b) => n + (Number(b.size) || 0), 0))}…`);
    for (const b of files) {
      if (signal?.aborted) throw Object.assign(new Error("Cancelled."), { aborted: true });
      try {
        const r = await ctx.cluster.runTask(MAIN_ID, "main.handoff", { kind: "backup", file: b.file }, { log: (l) => log(`  ${l}`), signal });
        if (r?.missing) log(`  ${b.file}: not on the old main server either — skipped.`);
        else copied++;
      } catch (err) {
        if (err.aborted) throw err;
        failed++;
        log(`  !! ${b.file}: ${err.message}`);
      }
    }
    if (files.length) log(`Backups: ${copied} copied${failed ? `, ${failed} failed (they stay on the old main server)` : ""}.`);

    // Let's Encrypt
    let le = false;
    log("Copying /etc/letsencrypt…");
    try {
      const r = await ctx.cluster.runTask(MAIN_ID, "main.handoff", { kind: "letsencrypt" }, { log: (l) => log(`  ${l}`), signal });
      if (r?.missing) log("  The old main server has no Let's Encrypt certificates.");
      else le = await installLetsEncrypt(log, signal);
    } catch (err) {
      if (err.aborted) throw err;
      log(`  !! Could not copy the certificates: ${err.message}. Issue them again on this server (website → SSL) once DNS points here.`);
    }
    return { backups: copied, backupsFailed: failed, letsencrypt: le };
  }

  /** Unpack the uploaded /etc/letsencrypt next to (never over) what this server has. */
  async function installLetsEncrypt(log, signal) {
    const tmp = path.join(ctx.dataDir, "tmp");
    const archive = fs.existsSync(tmp) ? fs.readdirSync(tmp).filter((f) => /^handoff-letsencrypt-.+\.tar\.gz$/.test(f)).map((f) => path.join(tmp, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] : null;
    if (!archive) throw new Error("the archive did not arrive");
    const stage = path.join(tmp, `letsencrypt-stage-${Date.now()}`);
    try {
      fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
      await sys.run("tar", ["-xzpf", archive, "-C", stage], { log, signal, timeoutMs: 10 * 60_000 });
      const src = path.join(stage, "etc", "letsencrypt");
      if (sys.DRY_RUN) {
        await sys.run("cp", ["-an", `${src}/.`, "/etc/letsencrypt/"], { log });
      } else {
        if (!fs.existsSync(src)) throw new Error("the archive has no etc/letsencrypt");
        fs.mkdirSync("/etc/letsencrypt", { recursive: true, mode: 0o755 });
        // -a keeps the live/ → archive/ symlinks; -n never overwrites a certificate this server already has.
        await sys.run("cp", ["-an", `${src}/.`, "/etc/letsencrypt/"], { log, signal });
      }
      log("  Certificates installed in /etc/letsencrypt (existing files on this server were kept).");
      if (!sys.DRY_RUN && !sys.which("certbot")) {
        log("  certbot is not installed here — installing it so the certificates keep renewing…");
        const r = await sys.run("apt-get", ["install", "-y", "certbot", "python3-certbot-nginx"], { log, signal, allowFail: true, timeoutMs: 10 * 60_000, env: { DEBIAN_FRONTEND: "noninteractive" } });
        if (r.code !== 0) log("  !! Could not install certbot: run apt install certbot python3-certbot-nginx on this server.");
      }
      return true;
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
      fs.rmSync(archive, { force: true });
    }
  }

  function readAgentConfig() {
    const file = process.env.FCC_NODE_CONFIG || "/etc/fcc-node/config.json";
    try {
      const c = JSON.parse(fs.readFileSync(file, "utf8"));
      return { file, dataDir: c.dataDir || "/var/lib/fcc-node", serverId: c.serverId || null };
    } catch {
      return { file, dataDir: "/var/lib/fcc-node", serverId: null };
    }
  }

  /** Steps 6–7 of the header, on this machine. Returns what the restart needs. */
  function rewriteIdentity(x, { log, admin, addr, transferResult }) {
    const retiredId = `retired-main-${stampOf()}`;
    const old = server(MAIN_ID);
    const out = remapIdentity(
      { servers: db.list("servers"), sites: db.list("sites"), releases: db.list("releases"), backups: db.list("backups"), config: ctx.config },
      { fromId: x.id, retiredId },
    );
    // servers: replace wholesale
    for (const s of db.list("servers").slice()) db.remove("servers", s.id);
    for (const s of out.servers) db.insert("servers", s);
    // the others: patch what changed
    for (const coll of ["sites", "releases", "backups"]) {
      for (const rec of out[coll]) {
        const cur = db.get(coll, rec.id);
        if (cur && JSON.stringify(cur) !== JSON.stringify(rec)) db.update(coll, rec.id, rec);
      }
    }
    // config.json: same object (modules hold a reference to ctx.config)
    for (const k of Object.keys(ctx.config)) if (!(k in out.config)) delete ctx.config[k];
    Object.assign(ctx.config, out.config);
    ctx.config.agentPanelUrl = addr.agentUrl;
    if (addr.panelUrl) ctx.config.panelUrl = addr.panelUrl;
    db.save({ immediate: true });
    ctx.saveConfig();
    log(`${x.name} is now the main server: ${out.counts.sites} website(s), ${out.counts.backups} backup record(s), ${out.counts.releases} build record(s) updated; panel failover is off.`);
    log(`${old?.name || "The old main server"}'s server backups are kept under “${old?.name || "Main"} (old main)”.`);
    ctx.activity?.(admin, "server.main.change", { type: "server", id: MAIN_ID, name: x.name }, { from: old?.name || null, previousId: x.id, retiredId, transfer: transferResult });
    return { retiredId };
  }

  function rewriteSideFiles(fromId) {
    for (const rel of ["metrics.json", "usage.json"]) {
      const file = path.join(ctx.dataDir, rel);
      try {
        const tree = JSON.parse(fs.readFileSync(file, "utf8"));
        writeFileAtomic(file, JSON.stringify(remapKeys(tree, fromId)), 0o600);
      } catch {
        /* missing or unreadable: it starts fresh */
      }
    }
  }

  function start(targetId, admin, body) {
    if (running) throw httpError(409, "The main server is already being changed.", { jobId: running });
    const pf = preflight(targetId);
    if (!pf.ok) throw httpError(409, "Not ready yet: " + pf.steps.filter((s) => s.state === "blocked" || s.state === "todo").map((s) => s.title).join("; ") + ".", { preflight: pf });
    const oldName = pf.oldMain?.name || "Main";
    if (String(body?.confirm || "").trim() !== oldName) throw httpError(400, `Type ${oldName} to confirm.`);
    const x = server(targetId);
    const job = ctx.jobs.start(
      { type: "server.main.change", title: `Make ${x.name} the main server`, serverId: x.id, adminId: admin?.id || null, lock: "main-switch" },
      async ({ log, signal, job: rec }) => {
        running = rec.id;
        try {
          log(`Making ${x.name} the main server in place of ${oldName}.`);
          // Databases
          if (pf.dbPlan?.startsWith("switchover")) {
            log("── Databases ──");
            await waitJob(ctx.mysqlHa.switchover(admin), `Switching the database primary to ${x.name}`, log);
          }
          if (pf.dbPlan?.endsWith("disable")) {
            if (!pf.dbPlan.startsWith("switchover")) log("── Databases ──");
            await waitJob(ctx.mysqlHa.disable(admin), "Turning off database replication", log);
          }
          // The databases stay on another server: the new main manages them over TCP and needs a MySQL client.
          const mh = ctx.config.mysqlHa || {};
          if (mh.primary && mh.primary !== x.id && mh.primary !== MAIN_ID && (mh.enabled || mh.aliasKept) && !sys.which("mysql") && !sys.which("mariadb")) {
            log("── MySQL client ──");
            log(`The databases live on ${nameOf(mh.primary)}; installing the MySQL client here so the panel can manage them.`);
            const { ensureMysqlClient } = await import("../../shared/mysql-ha.mjs");
            const r = await ensureMysqlClient(mh.flavor === "mariadb" ? "mariadb" : "mysql", { log: (l) => log(`  ${l}`) });
            sys.forgetWhich();
            if (!r.installed) log(`  !! ${r.error} — install ${mh.flavor === "mariadb" ? "mariadb" : "mysql"}-client on ${x.name} by hand.`);
          }

          // Transfer
          log("── Copy from the old main server ──");
          const transferResult = await transfer(pf, { log, signal });
          if (signal?.aborted) throw Object.assign(new Error("Cancelled."), { aborted: true });

          // Retire the old main (it stops a moment after answering).
          log("── Retire the old main server ──");
          let retired = null;
          if (pf.transfer.oldOnline) {
            try {
              retired = await ctx.cluster.runTask(MAIN_ID, "main.retire", { delaySeconds: RETIRE_DELAY_S }, { log: (l) => log(`  ${l}`), signal });
            } catch (err) {
              log(`  !! ${err.message}`);
              log(`  Stop it by hand on that server: systemctl disable --now fcc`);
            }
          } else log(`  ${oldName} is offline. When it comes back it cannot rejoin; stop it there with: systemctl disable --now fcc`);

          // Agents learn the new address before HA turns off (they then talk only to it).
          const addr = addresses(server(x.id));
          log("── Agents ──");
          ctx.config.agentPanelUrl = addr.agentUrl;
          ctx.saveConfig();
          log(`Telling every agent to use ${addr.agentUrl} from now on…`);
          await new Promise((r) => setTimeout(r, sys.DRY_RUN ? 3000 : AGENT_URL_WAIT_MS));

          // Identity
          log("── Main server identity ──");
          const agent = readAgentConfig();
          const { retiredId } = rewriteIdentity(server(x.id), { log, admin, addr, transferResult });
          writeFileAtomic(
            path.join(ctx.dataDir, MARKER),
            JSON.stringify({ from: x.id, retiredId, oldName, at: new Date().toISOString(), agentDataDir: agent.dataDir, edgeCleanup: "pending" }, null, 2) + "\n",
            0o600,
          );
          ctx.ha?.setLocalServerId?.(MAIN_ID);
          log("This panel now says it runs on the main server (ha-local.json).");

          // fcc-node on this machine: main runs its tasks inside the panel.
          if (agent.serverId === x.id || sys.DRY_RUN) {
            await sys.run("systemctl", ["disable", "--now", "fcc-node"], { log, allowFail: true, timeoutMs: 60_000 });
            log("Stopped this server's agent (fcc-node) — the main server runs its tasks inside the panel. Websites keep running under pm2.");
          } else log(`No agent config for ${x.id} at ${agent.file} — fcc-node left alone.`);

          log(process.env.INVOCATION_ID ? "The panel restarts now as the main server (about 10 seconds)." : "Restart the panel now (it is not running under systemd, so it can't restart itself).");
          return { mainServer: x.name, previousId: x.id, retiredId, retired, transfer: transferResult, agentPanelUrl: addr.agentUrl, panelUrl: addr.panelUrl, restart: true };
        } finally {
          running = null;
        }
      },
    );
    running = job.id;
    // After the job has finished (its record saved): flush, rewrite the side files, restart.
    ctx.jobs.wait(job.id).then((j) => {
      if (j.status !== "succeeded" || !j.result?.restart) return;
      setTimeout(() => {
        try {
          db.save({ immediate: true });
          db.readOnly = true;
          rewriteSideFiles(x.id);
        } catch (err) {
          console.error("[main-switch] could not flush before restarting:", err.message);
        }
        console.log(`[main-switch] ${x.name} is the main server now — restarting`);
        process.exit(75); // systemd (Restart=always) brings the panel back as main
      }, EXIT_DELAY_MS);
    }).catch(() => {});
    ctx.activity?.(admin, "server.main.change.start", { type: "server", id: x.id, name: x.name }, { from: oldName });
    return job;
  }

  router.get("/api/servers/:id/make-main", (req, res, { params }) => preflight(params.id));
  router.post("/api/servers/:id/make-main", (req, res, { params, body, admin }) => start(params.id, admin, body));

  ctx.mainSwitch = { preflight, retiredServers: () => (Array.isArray(ctx.config.retiredServers) ? ctx.config.retiredServers : []) };
}

/** After the restart as main: take down what fcc-node set up as an edge on this machine. */
export async function start(ctx) {
  if (ctx.ha && ctx.ha.mainIsLocal === false) return;
  const file = path.join(ctx.dataDir, MARKER);
  let mark;
  try {
    mark = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return;
  }
  if (mark?.edgeCleanup !== "pending") return;
  const t = setTimeout(async () => {
    const lines = [];
    const log = (l) => {
      lines.push(l);
      console.log(`[main-switch] ${l}`);
    };
    try {
      const { retireEdge } = await import("../../shared/edge.mjs");
      const r = await retireEdge(mark.agentDataDir || "/var/lib/fcc-node", { log });
      mark.edgeCleanup = r.error ? "failed" : "done";
      mark.edgeCleanupError = r.error || null;
    } catch (err) {
      mark.edgeCleanup = "failed";
      mark.edgeCleanupError = err.message;
      log(`edge cleanup failed: ${err.message}`);
    }
    mark.edgeCleanupAt = new Date().toISOString();
    try {
      writeFileAtomic(file, JSON.stringify(mark, null, 2) + "\n", 0o600);
    } catch {
      /* best effort */
    }
    try {
      ctx.cluster?.edgesChanged?.();
    } catch {
      /* best effort */
    }
  }, EDGE_CLEANUP_DELAY_MS);
  t.unref?.();
}
