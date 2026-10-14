/**
 * DATA — database replication (docs/HA.md Phase 3).
 *
 * One MySQL/MariaDB primary, one replica on another server. This module
 * orchestrates it from the active panel: enabling (prepare the primary → seed
 * the replica → users → hosts alias → DB_HOST env updates), the 10 s monitor on
 * the leader (automatic failover, broken detection, fencing, auto-rebuild),
 * manual promote / switchover / rebuild / disable, and the `/etc/hosts` alias
 * map cluster.mjs puts in every cluster.sync payload (`hostsMap(serverId)`).
 *
 * State lives in the replicated config.json (`config.mysqlHa`); passwords are
 * stored encrypted with ctx.secrets and only ever leave the panel decrypted
 * inside a task payload (never in logs, API responses or activity details).
 *
 * Safety rules:
 *   - every mutating operation is single-flight (`op`), and runs as a job on the
 *     "mysql.ha" lock;
 *   - automatic promotion needs, for DETECT_MS continuously: (a) the primary's
 *     server offline to the panel (agent + votes), (b) no TCP connection from the
 *     leader to primary:3306, (c) the replica reporting its IO thread not
 *     connected — re-checked right before acting, with a fresh replica status;
 *   - never promotes a replica whose SQL thread stopped with an error, unless an
 *     admin forces it;
 *   - fencing: servers that must not take writes are set read_only at once.
 *
 * Dry-run hook (FCC_DRY_RUN=1 only): `<dataDir>/dry-run/mysql-ha.json`
 *   { "offline": ["main"], "tcpDown": ["main"] }
 * makes the monitor treat those servers as offline to the panel / failing the
 * TCP probe (without it the dry-run probe always succeeds). It is re-read every
 * tick and ignored outside dry-run.
 */

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import dns from "node:dns/promises";
import crypto from "node:crypto";

import { httpError } from "./http.mjs";
import { DRY_RUN } from "./sys.mjs";
import { REPL_ALIAS, ADMIN_USER, validHost, cleanHost, generatePassword } from "./mysql.mjs";
import * as sharedTasks from "../../shared/tasks.mjs";

export const DETECT_MS = 60_000;
export const BROKEN_MS = 2 * 60_000;
export const REPL_USER = "fcc_repl";
export const MIN_AGENT = "3.3.0";
const TICK_MS = 10_000;
const HISTORY_MAX = 50;
const MAIN_ID = "main";
const STATUS_MAX_AGE_MS = 30_000;
const AGENT_STATUS_CACHE_MS = 30_000; // node-agent refreshes its `mysql` metrics block at most this often
const FENCE_RETRY_MS = 30_000;
const REBUILD_RETRY_MS = 10 * 60_000;
const USERS_RECONCILE_MS = 30 * 60_000;
const HA_OFF = Object.freeze({ enabled: false, localServerId: MAIN_ID, mainIsLocal: true, isLeader: () => true });
const NEEDED_TASKS = ["mysql.primary.prepare", "mysql.replica.setup", "mysql.status", "mysql.replica.promote", "mysql.readonly", "mysql.users.sync", "mysql.rebuild"];
const ACTIVITY_TARGET = { type: "mysql", id: "replication", name: "Database replication" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const taskTypes = () => (Array.isArray(sharedTasks.TASK_TYPES) ? sharedTasks.TASK_TYPES : []);
const tasksReady = () => NEEDED_TASKS.every((t) => taskTypes().includes(t));

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

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
      t.unref?.();
    }),
  ]);
}

/**
 * Rule (3): main's panel, at boot (follower or leader), sets its local MySQL
 * read-only when the replicated config says another server is the primary.
 * Exported so server.mjs can also call it in follower mode (where no module is
 * loaded). Never throws.
 */
export async function fenceAtBoot({ config, dataDir, log = (l) => console.log(`[mysql-ha] ${l}`) } = {}) {
  try {
    const c = config?.mysqlHa;
    if (!c || !c.primary || c.primary === MAIN_ID || !(c.enabled || c.aliasKept)) return { fenced: false };
    if (!taskTypes().includes("mysql.readonly")) {
      log("main is not the database primary, but this code has no mysql.readonly task — cannot fence main's MySQL");
      return { fenced: false };
    }
    log(`the database primary is ${c.primary}: setting main's local MySQL read-only`);
    await withTimeout(
      Promise.resolve(sharedTasks.executeTask("mysql.readonly", { on: true }, { log: (l) => log(`  ${l}`), dataDir, isMain: true, serverId: MAIN_ID })),
      15_000,
      "mysql.readonly",
    );
    return { fenced: true };
  } catch (err) {
    log(`could not set main's MySQL read-only at boot: ${err.message}`);
    return { fenced: false, error: err.message };
  }
}

// ==================================================================== module

export function register(router, ctx) {
  const api = createMysqlHa(ctx);
  ctx.mysqlHa = api;
  api._routes(router);
}

export async function start(ctx) {
  await ctx.mysqlHa?._start?.();
}

export async function stop(ctx) {
  await ctx.mysqlHa?._stop?.();
}

function createMysqlHa(ctx) {
  const ha = () => ctx.ha || HA_OFF;
  const isLeader = () => {
    try {
      return typeof ha().isLeader === "function" ? ha().isLeader() : true;
    } catch {
      return false;
    }
  };
  const localServerId = () => ha().localServerId || MAIN_ID;

  function cfg() {
    if (!ctx.config.mysqlHa || typeof ctx.config.mysqlHa !== "object") {
      ctx.config.mysqlHa = { enabled: false, mode: "auto", state: "off", primary: MAIN_ID, replica: null, needsRebuild: [], serverIds: { [MAIN_ID]: 1 }, history: [] };
    }
    const c = ctx.config.mysqlHa;
    if (!Array.isArray(c.needsRebuild)) c.needsRebuild = [];
    if (!Array.isArray(c.history)) c.history = [];
    if (!c.serverIds || typeof c.serverIds !== "object") c.serverIds = { [MAIN_ID]: 1 };
    if (!c.primary) c.primary = MAIN_ID;
    if (!["auto", "manual"].includes(c.mode)) c.mode = "auto";
    if (!c.state) c.state = c.enabled ? "replicating" : "off";
    return c;
  }
  const save = () => {
    try {
      ctx.saveConfig?.();
    } catch (err) {
      console.error("[mysql-ha] could not save config:", err.message);
    }
  };
  const decrypt = (v) => (v ? ctx.secrets.decrypt(v) : "");
  const audit = (admin, action, details) => {
    try {
      ctx.activity?.(admin || null, action, ACTIVITY_TARGET, details);
    } catch {}
  };
  const alert = (kind, details) => {
    try {
      Promise.resolve(ctx.clusterAlerts?.send?.(kind, details)).catch((err) => console.error(`[mysql-ha] alert ${kind}:`, err.message));
    } catch (err) {
      console.error(`[mysql-ha] alert ${kind}:`, err.message);
    }
  };
  let lastBroadcastKey = null;
  function broadcast(force = false) {
    try {
      const view = statusView();
      const key = JSON.stringify(view);
      if (!force && key === lastBroadcastKey) return;
      lastBroadcastKey = key;
      ctx.events?.broadcast?.("mysql-ha", view);
    } catch {}
  }
  function history(event, detail) {
    const c = cfg();
    c.history.push({ at: nowIso(), event, detail: String(detail || "").slice(0, 500) });
    if (c.history.length > HISTORY_MAX) c.history.splice(0, c.history.length - HISTORY_MAX);
    console.log(`[mysql-ha] ${event}: ${detail || ""}`);
    save();
    broadcast(true);
  }

  // ------------------------------------------------------------ servers

  const server = (id) => {
    try {
      return ctx.db.get("servers", id) || null;
    } catch {
      return null;
    }
  };
  const nameOf = (id) => server(id)?.name || id;
  const enabledServers = () => ctx.db.list("servers").filter((s) => s && s.enabled !== false);

  function dryHook() {
    if (!DRY_RUN) return { offline: [], tcpDown: [] };
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, "dry-run", "mysql-ha.json"), "utf8"));
      return { offline: Array.isArray(j.offline) ? j.offline.map(String) : [], tcpDown: Array.isArray(j.tcpDown) ? j.tcpDown.map(String) : [] };
    } catch {
      return { offline: [], tcpDown: [] };
    }
  }

  /** Can the panel run a task there right now? */
  function serverOnline(id) {
    if (dryHook().offline.includes(id)) return false;
    if (id === MAIN_ID && ha().mainIsLocal !== false) return true;
    try {
      return !!ctx.cluster?.isOnline?.(id);
    } catch {
      return false;
    }
  }

  /** Condition (a): the server is offline to the panel — its agent is silent AND (with HA) its vote doesn't arrive. */
  function offlineToPanel(id) {
    if (dryHook().offline.includes(id)) return true;
    if (id === localServerId()) return false;
    if (serverOnline(id)) return false;
    try {
      const votes = ha().status?.()?.votes;
      if (Array.isArray(votes)) {
        const v = votes.find((x) => x && x.serverId === id);
        if (v && v.reachable === true) return false;
      }
    } catch {}
    return true;
  }

  function agentOk(id) {
    if (id === MAIN_ID && ha().mainIsLocal !== false) return true; // in-process tasks
    return versionAtLeast(server(id)?.agentVersion, MIN_AGENT);
  }

  /** Network address of a server as other servers see it (privateHost || host), no port. */
  function addressOf(id) {
    const s = server(id);
    for (const raw of [s?.privateHost, s?.host]) {
      const h = cleanHost(raw);
      if (h) return h;
    }
    return null;
  }

  const ipCache = new Map(); // host -> [ips]
  async function resolveIps(host) {
    if (!host) return [];
    if (net.isIP(host)) return [host];
    try {
      const r = await withTimeout(dns.lookup(host, { all: true }), 3000, `resolving ${host}`);
      const ips = [...new Set(r.map((a) => a.address))].filter(validHost);
      ipCache.set(host, ips);
      return ips;
    } catch {
      return ipCache.get(host) || [];
    }
  }
  const isLoop = (ip) => /^127\./.test(ip) || ip === "::1";
  async function serverIps(id) {
    const s = server(id);
    const out = new Set();
    for (const raw of [s?.privateHost, s?.host]) {
      for (const ip of await resolveIps(cleanHost(raw))) if (DRY_RUN || !isLoop(ip)) out.add(ip);
    }
    return [...out];
  }
  async function allServerIps() {
    const out = new Set();
    for (const s of enabledServers()) for (const ip of await serverIps(s.id)) out.add(ip);
    return [...out].sort();
  }

  // ------------------------------------------------------------ hosts alias

  /** IP the alias resolves to on servers other than the primary (persisted, so hostsMap stays sync). */
  async function refreshAliasIp() {
    const c = cfg();
    const addr = addressOf(c.primary);
    const ips = await resolveIps(addr);
    const ip = ips.find((x) => net.isIPv4(x)) || ips[0] || null;
    if (ip && c.aliasIp !== ip) {
      c.aliasIp = ip;
      save();
    }
    return ip;
  }

  const aliasActive = () => {
    const c = cfg();
    return !!c.primary && (c.enabled === true || c.aliasKept === true);
  };

  /** cluster.sync `hosts` for a server: { "fcc-mysql.internal": ip } | null (null removes the block). */
  function hostsMap(serverId) {
    if (!aliasActive()) return null;
    const c = cfg();
    if (serverId === c.primary) return { [REPL_ALIAS]: "127.0.0.1" };
    const addr = addressOf(c.primary);
    const ip = net.isIP(addr || "") ? addr : c.aliasIp || null;
    return ip ? { [REPL_ALIAS]: ip } : null;
  }

  async function hostsChanged(log = () => {}) {
    await refreshAliasIp();
    try {
      ctx.cluster?.edgesChanged?.();
    } catch {}
    const lines = enabledServers().map((s) => `${s.name}: ${JSON.stringify(hostsMap(s.id))}`);
    log(`Hosts alias ${REPL_ALIAS} → ${lines.join(" · ")}`);
  }

  /** Wait (bounded) until every online agent server confirmed a cluster.sync applied after `since`. */
  async function waitHostsApplied(since, { log = () => {}, timeoutMs = 45_000, signal } = {}) {
    const deadline = Date.now() + timeoutMs;
    const want = () =>
      enabledServers().filter((s) => s.id !== MAIN_ID && serverOnline(s.id) && versionAtLeast(s.agentVersion, MIN_AGENT));
    let pending = [];
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Cancelled");
      pending = want().filter((s) => {
        const at = Date.parse(server(s.id)?.edgeSync?.appliedAt || "") || 0;
        return at < since;
      });
      if (!pending.length) {
        log("Every online server applied the hosts block.");
        return true;
      }
      await sleep(2000);
    }
    log(`Not confirmed yet by: ${pending.map((s) => s.name).join(", ")} — they get it with their next cluster.sync.`);
    return false;
  }

  // ------------------------------------------------------------ MySQL status

  const statusCache = new Map(); // serverId -> { at, value }
  const statusInflight = new Map();

  function metricsStatus(id, maxAgeMs) {
    let m = null;
    try {
      m = ctx.cluster?.mysqlStatus?.(id) || null;
    } catch {}
    if (!m || typeof m !== "object") return null;
    const raw = m.reportedAt ?? m.at ?? m.receivedAt ?? null;
    const at = typeof raw === "number" ? raw : Date.parse(raw || "") || null;
    if (at && Date.now() - at > maxAgeMs) return null;
    // The agent refreshes this block at most every 30 s: a task result we fetched
    // ourselves since then (e.g. right after an operation) is more current.
    const own = statusCache.get(id);
    if (own && own.value && at && own.at > at - AGENT_STATUS_CACHE_MS) return null;
    return m;
  }

  /** mysql.status of a server: agent metrics when fresh, else a mysql.status task. null when unknown. */
  async function mysqlStatusOf(id, { fresh = false, maxAgeMs = STATUS_MAX_AGE_MS } = {}) {
    if (!fresh) {
      const m = metricsStatus(id, maxAgeMs);
      if (m) return m;
      const c = statusCache.get(id);
      if (c && Date.now() - c.at < maxAgeMs) return c.value;
    }
    if (!serverOnline(id) || !agentOk(id) || !taskTypes().includes("mysql.status")) return statusCache.get(id)?.value && !fresh ? statusCache.get(id).value : null;
    if (statusInflight.has(id)) return statusInflight.get(id);
    const p = (async () => {
      try {
        const v = await withTimeout(Promise.resolve(ctx.cluster.runTask(id, "mysql.status", {}, { timeoutMs: 20_000 })), 20_000, "mysql.status");
        statusCache.set(id, { at: Date.now(), value: v || null });
        return v || null;
      } catch (err) {
        statusCache.set(id, { at: Date.now(), value: null, error: err.message });
        return null;
      } finally {
        statusInflight.delete(id);
      }
    })();
    statusInflight.set(id, p);
    return p;
  }
  const lastKnown = (id) => metricsStatus(id, 5 * 60_000) || statusCache.get(id)?.value || null;
  /** After an operation touched these servers: fetch fresh statuses so views and the monitor don't use pre-operation reports. */
  const refreshStatuses = (...ids) => Promise.all(ids.filter(Boolean).map((id) => mysqlStatusOf(id, { fresh: true }).catch(() => null)));

  function probeTcp(id, port = 3306, ms = 3000) {
    if (DRY_RUN) return Promise.resolve(!dryHook().tcpDown.includes(id));
    const host = id === localServerId() ? "127.0.0.1" : addressOf(id);
    if (!host) return Promise.resolve(false);
    return new Promise((resolve) => {
      const sock = net.connect({ host, port });
      const done = (ok) => {
        sock.destroy();
        resolve(ok);
      };
      sock.setTimeout(ms, () => done(false));
      sock.once("connect", () => done(true));
      sock.once("error", () => done(false));
    });
  }

  const ioDisconnected = (st) => !!st && !!st.replica && st.replica.ioRunning !== true;
  const sqlErrored = (st) => !!st && !!st.replica && st.replica.sqlRunning !== true && !!st.replica.lastError;

  /** The three failover conditions, evaluated now. */
  async function conditions({ freshReplica = false } = {}) {
    const c = cfg();
    const out = { a: false, b: null, c: null, all: false };
    if (!c.replica) return out;
    out.a = offlineToPanel(c.primary);
    if (!out.a) return out;
    out.b = !(await probeTcp(c.primary));
    if (!out.b) return out;
    const rst = await mysqlStatusOf(c.replica, { fresh: freshReplica, maxAgeMs: 20_000 });
    out.c = ioDisconnected(rst);
    out.replicaStatus = rst;
    out.all = !!(out.a && out.b && out.c);
    return out;
  }

  // ------------------------------------------------------------ payloads

  async function credentials({ create = false } = {}) {
    const c = cfg();
    if (create) {
      if (!c.replUserEnc) c.replUserEnc = ctx.secrets.encrypt(REPL_USER);
      if (!c.replPasswordEnc) c.replPasswordEnc = ctx.secrets.encrypt(generatePassword(32));
      if (!c.adminPasswordEnc) c.adminPasswordEnc = ctx.secrets.encrypt(generatePassword(32));
      save();
    }
    return { replUser: decrypt(c.replUserEnc) || REPL_USER, replPassword: decrypt(c.replPasswordEnc), adminPassword: decrypt(c.adminPasswordEnc) };
  }

  function mysqlServerId(id) {
    const c = cfg();
    if (!c.serverIds[MAIN_ID]) c.serverIds[MAIN_ID] = 1;
    if (!c.serverIds[id]) c.serverIds[id] = Math.max(0, ...Object.values(c.serverIds).map(Number).filter(Number.isFinite)) + 1;
    return c.serverIds[id];
  }

  async function preparePayload(primary, replicaIds, creds) {
    const all = await allServerIps();
    const replicaIps = new Set();
    for (const r of replicaIds) for (const ip of await serverIps(r)) replicaIps.add(ip);
    return {
      serverId: mysqlServerId(primary),
      replUser: creds.replUser,
      replPassword: creds.replPassword,
      adminPassword: creds.adminPassword,
      replicaIps: [...replicaIps],
      // fcc_admin from every server: any of them may run the active panel later.
      adminIps: all,
      // ufw 3306: websites on every server reach the primary through the alias.
      allowFrom: all,
    };
  }

  async function setupPayload(replica, primary, creds, extra = {}) {
    const all = await allServerIps();
    const host = addressOf(primary);
    if (!host) throw new Error(`${nameOf(primary)} has no address the replica could connect to.`);
    return {
      flavor: cfg().flavor || "mysql",
      serverId: mysqlServerId(replica),
      primaryHost: host,
      primaryPort: Number(ctx.config.mysql?.port) || 3306,
      replUser: creds.replUser,
      replPassword: creds.replPassword,
      adminPassword: creds.adminPassword,
      adminIps: all,
      allowFrom: all,
      ...extra,
    };
  }

  /** mysql.users.sync payload: every database user with its password (decrypted only here, into the task). */
  function usersPayload(remove = []) {
    const users = [];
    for (const rec of ctx.db.list("databases")) {
      let password = "";
      try {
        password = decrypt(rec.passwordEnc);
      } catch {
        continue;
      }
      const hosts = (Array.isArray(rec.hosts) && rec.hosts.length ? rec.hosts : ["localhost", "127.0.0.1"]).filter(validHost);
      users.push({ user: rec.user, password, hosts, databases: [rec.name] });
    }
    return { users, remove: remove.filter((r) => r && r.user && validHost(r.host)) };
  }

  // ------------------------------------------------------------ user sync

  let usersDirty = false;
  let usersRemove = [];
  let usersTimer = null;
  let usersSyncedAt = 0;
  let usersChain = Promise.resolve();

  function usersChanged({ remove = [] } = {}) {
    if (!cfg().enabled) return;
    usersDirty = true;
    usersRemove.push(...remove);
    clearTimeout(usersTimer);
    usersTimer = setTimeout(() => flushUsers().catch(() => {}), 1500);
    usersTimer.unref?.();
  }

  /** Run mysql.users.sync on `target` (default: the replica). Never logs a password. */
  function syncUsersTo(target, { log = () => {}, remove = [] } = {}) {
    const run = async () => {
      const p = usersPayload(remove);
      log(`Syncing ${p.users.length} database user(s)${p.remove.length ? ` and removing ${p.remove.length} account(s)` : ""} on ${nameOf(target)}.`);
      await ctx.cluster.runTask(target, "mysql.users.sync", p, { log });
      usersSyncedAt = Date.now();
    };
    const pr = usersChain.then(run);
    usersChain = pr.catch(() => {});
    return pr;
  }

  async function flushUsers() {
    const c = cfg();
    if (!usersDirty || !c.enabled || !c.replica || !isLeader()) return;
    if (!serverOnline(c.replica) || !agentOk(c.replica)) return; // retried by the monitor
    const remove = usersRemove;
    usersDirty = false;
    usersRemove = [];
    try {
      await syncUsersTo(c.replica, { remove });
    } catch (err) {
      usersDirty = true;
      usersRemove.push(...remove);
      console.error(`[mysql-ha] user sync on ${nameOf(c.replica)} failed: ${err.message}`);
    }
  }

  // ------------------------------------------------------------ operations

  let op = null; // name of the running operation (single-flight)

  function runOp(name, meta, fn) {
    if (op) throw httpError(409, `A database replication operation is already running (${op}).`);
    if (!isLeader()) throw httpError(409, "Only the active panel can change database replication.");
    if (!tasksReady()) throw httpError(503, "This panel's task executor does not know the database replication tasks yet (shared/tasks.mjs 3.3.0 is needed).");
    op = name;
    try {
      return ctx.jobs.start({ type: `mysql.replication.${name}`, lock: "mysql.ha", ...meta }, async (h) => {
        op = name;
        broadcast(true);
        try {
          return await fn(h);
        } finally {
          op = null;
          broadcast(true);
        }
      });
    } catch (err) {
      op = null;
      throw err;
    }
  }

  function requireAgent(id, what) {
    const s = server(id);
    if (!s) throw httpError(404, `Server ${id} not found.`);
    if (s.enabled === false) throw httpError(400, `${s.name} is disabled.`);
    if (!serverOnline(id)) throw httpError(409, `${s.name} is offline.`);
    if (!agentOk(id)) throw httpError(409, `${s.name} runs agent v${s.agentVersion || "?"}; ${what} needs v${MIN_AGENT} or newer (it updates itself when it reconnects).`);
    return s;
  }

  function diskCheck(id) {
    let m = null;
    try {
      m = ctx.cluster?.latestMetrics?.(id) || null;
    } catch {}
    const need = ctx.db.list("databases").reduce((n, d) => n + (Number(d.sizeBytes) || 0), 0) * 2 + 1024 ** 3;
    if (!m || !m.diskTotal) return { ok: true, unknown: true, need };
    const free = m.diskTotal - (m.disk || 0);
    return { ok: free >= need, free, need };
  }
  const gb = (n) => `${(n / 1024 ** 3).toFixed(1)} GB`;

  // ---- enable

  function enable({ replicaServerId, mode = "auto" }, admin) {
    const c = cfg();
    if (c.enabled) throw httpError(409, "Database replication is already on.");
    if (!["auto", "manual"].includes(mode)) throw httpError(400, 'mode must be "auto" or "manual".');
    const replica = String(replicaServerId || "");
    if (!replica) throw httpError(400, "Choose the server for the replica (replicaServerId).");
    const primary = c.primary || MAIN_ID;
    if (replica === primary) throw httpError(400, "The replica must be a different server from the primary.");
    if (replica === MAIN_ID) throw httpError(400, "Pick an agent server for the replica.");
    requireAgent(replica, "a database replica");
    if (primary !== MAIN_ID || ha().mainIsLocal === false) requireAgent(primary, "the database primary");
    const disk = diskCheck(replica);
    if (!disk.ok) throw httpError(409, `${nameOf(replica)} has ${gb(disk.free)} free; the databases need about ${gb(disk.need)}.`);

    const job = runOp("enable", { title: `Turn on database replication to ${nameOf(replica)}`, serverId: replica, adminId: admin?.id || null }, async ({ log, signal }) => {
      const before = ctx.mysql?.envHostsSnapshot?.() || new Map();
      c.mode = mode;
      c.state = "preparing";
      c.replica = null;
      c.primary = primary;
      mysqlServerId(primary);
      mysqlServerId(replica);
      save();
      broadcast(true);
      const creds = await credentials({ create: true });
      try {
        log(`Primary: ${nameOf(primary)} (${addressOf(primary) || "no address"}). Replica: ${nameOf(replica)} (${addressOf(replica) || "no address"}). Mode: ${mode}.`);
        if (disk.unknown) log(`Free disk on ${nameOf(replica)} is unknown — make sure it has room for about ${gb(disk.need)}.`);

        log(`Step 1/6 — preparing the primary (binlog, GTID, server_id, users ${REPL_USER} / ${ADMIN_USER}, firewall)…`);
        const prep = await ctx.cluster.runTask(primary, "mysql.primary.prepare", await preparePayload(primary, [replica], creds), { log, signal });
        c.flavor = prep?.flavor || c.flavor || "mysql";
        log(`Primary ready: ${c.flavor} ${prep?.version || ""}${prep?.restarted ? " (MySQL was restarted)" : ""}.`);

        c.state = "seeding";
        save();
        broadcast(true);
        log(`Step 2/6 — setting up the replica on ${nameOf(replica)} and seeding it from the primary (this can take a while)…`);
        const setup = await ctx.cluster.runTask(replica, "mysql.replica.setup", await setupPayload(replica, primary, creds), { log, signal });
        c.seededAt = setup?.seededAt || nowIso();
        log(`Replica seeded: ${Array.isArray(setup?.databases) ? setup.databases.length : setup?.databases ?? "?"} database(s).`);
        history("seeded", `${nameOf(replica)} seeded from ${nameOf(primary)}`);

        log("Step 3/6 — creating the website database users on the replica…");
        await syncUsersTo(replica, { log });

        c.enabled = true;
        c.aliasKept = false;
        c.replica = replica;
        c.needsRebuild = (c.needsRebuild || []).filter((x) => x !== replica && x !== primary);
        c.state = "replicating";
        save();
        ctx.mysql?.resetConnection?.();

        log("Step 4/6 — granting every server access to the databases…");
        try {
          const r = await ctx.mysql?.syncRemoteHosts?.({ log });
          if (r?.error) log(`Account sync: ${r.error}`);
        } catch (err) {
          log(`Account sync failed: ${err.message}`);
        }

        log(`Step 5/6 — pointing ${REPL_ALIAS} at the primary on every server…`);
        const since = Date.now();
        await hostsChanged(log);
        await waitHostsApplied(since, { log, signal });

        log("Step 6/6 — switching linked websites to DB_HOST=" + REPL_ALIAS + "…");
        const env = ctx.mysql?.pushEnvForChanged?.(before, admin) || { sites: [], jobs: [] };
        log(env.sites.length ? `Env update jobs for ${env.sites.map((s) => s.name).join(", ")}.` : "No linked website needs a change.");

        history("enabled", `replica ${nameOf(replica)}, mode ${mode}`);
        audit(admin, "mysql.replication.enable", { replica, primary, mode });
        return { primary, replica, flavor: c.flavor, envJobs: env.jobs };
      } catch (err) {
        c.state = "off";
        c.enabled = false;
        c.replica = null;
        save();
        history("enable-failed", err.message);
        throw err;
      }
    });
    return job;
  }

  // ---- promote (failover)

  async function promoteNow({ force = false, auto = false, admin = null, log = () => {}, signal } = {}) {
    const c = cfg();
    const oldPrimary = c.primary;
    const replica = c.replica;
    if (!c.enabled || !replica) throw new Error("There is no replica to promote.");

    // Re-check right before acting.
    const cond = await conditions({ freshReplica: true });
    log(`Checks: primary offline to the panel=${cond.a}, TCP ${nameOf(oldPrimary)}:3306 failing=${cond.b}, replica IO not connected=${cond.c}.`);
    if (auto && !cond.all) throw new Error("The primary is reachable again — automatic promotion cancelled.");
    if (!auto && !force && !(cond.a && cond.b)) throw new Error(`${nameOf(oldPrimary)} is still reachable. Use a switchover (no data loss), or force the promotion.`);

    const rst = cond.replicaStatus || (await mysqlStatusOf(replica, { fresh: true }));
    if (!rst) throw new Error(`${nameOf(replica)} did not report its MySQL status — cannot promote it.`);
    if (sqlErrored(rst) && !force) throw new Error(`${nameOf(replica)}'s SQL thread stopped with an error (${rst.replica.lastError}); it may be missing data. Promote with force to accept that.`);
    if (sqlErrored(rst)) log(`Forced: the replica's SQL thread had stopped with an error (${rst.replica.lastError}).`);

    // Best effort: fence the old primary in case it is only partly gone.
    if (serverOnline(oldPrimary) && agentOk(oldPrimary)) {
      try {
        await withTimeout(Promise.resolve(ctx.cluster.runTask(oldPrimary, "mysql.readonly", { on: true }, { log, timeoutMs: 8000 })), 8000, "fencing the old primary");
        log(`${nameOf(oldPrimary)} set read-only.`);
      } catch (err) {
        log(`Could not fence ${nameOf(oldPrimary)} (${err.message}); it goes on the rebuild list and is fenced when it reports in.`);
      }
    }

    log(`Promoting ${nameOf(replica)}…`);
    const res = await ctx.cluster.runTask(replica, "mysql.replica.promote", { waitMs: 30_000 }, { log, signal });
    log(`Promoted${res?.appliedAll === false ? " (not everything received had been applied within 30 s)" : ""}.`);

    c.primary = replica;
    c.replica = null;
    c.needsRebuild = [...new Set([...(c.needsRebuild || []).filter((x) => x !== replica), oldPrimary])];
    c.state = "promoted";
    c.promotedAt = nowIso();
    save();
    statusCache.clear();
    ctx.mysql?.resetConnection?.();
    detect.since = null;
    await hostsChanged(log);
    await refreshStatuses(replica);
    history("promoted", `${nameOf(replica)} is the database primary; ${nameOf(oldPrimary)} needs a rebuild${auto ? " (automatic failover)" : force ? " (forced)" : ""}`);

    try {
      log("Making sure every website user exists on the new primary…");
      await syncUsersTo(replica, { log });
    } catch (err) {
      log(`User sync on the new primary failed: ${err.message}`);
    }
    alert("db.failover", {
      title: "Database failed over",
      text: `${nameOf(oldPrimary)}'s database stopped answering. ${nameOf(replica)} is now the database primary${auto ? " (automatic failover)" : ""}.`,
      previousPrimary: oldPrimary,
      previousPrimaryName: nameOf(oldPrimary),
      primary: replica,
      primaryName: nameOf(replica),
      automatic: !!auto,
      appliedAll: res?.appliedAll ?? null,
    });
    audit(admin, auto ? "mysql.replication.failover" : "mysql.replication.promote", { primary: replica, previousPrimary: oldPrimary, force: !!force, automatic: !!auto });
    return { primary: replica, previousPrimary: oldPrimary, appliedAll: res?.appliedAll ?? null, executedGtid: res?.executedGtid ?? null };
  }

  function promote({ force = false } = {}, admin) {
    const c = cfg();
    if (!c.enabled || !c.replica) throw httpError(409, "There is no replica to promote.");
    return runOp("promote", { title: `Promote ${nameOf(c.replica)} to database primary${force ? " (forced)" : ""}`, serverId: c.replica, adminId: admin?.id || null }, ({ log, signal }) =>
      promoteNow({ force: !!force, admin, log, signal }),
    );
  }

  // ---- switchover (planned, no data loss)

  function switchover(admin) {
    const c = cfg();
    if (!c.enabled || !c.replica) throw httpError(409, "There is no replica to switch over to.");
    const oldPrimary = c.primary;
    const target = c.replica;
    requireAgent(target, "a switchover");
    if (!serverOnline(oldPrimary)) throw httpError(409, `${nameOf(oldPrimary)} is offline — use promote instead.`);
    const last = lastKnown(target);
    if (last && (sqlErrored(last) || last.replica?.ioRunning !== true || Number(last.replica?.lagSeconds) > 0))
      throw httpError(409, `${nameOf(target)} is not a healthy, caught-up replica right now (lag ${last.replica?.lagSeconds ?? "?"} s${last.replica?.lastError ? `, ${last.replica.lastError}` : ""}).`);

    return runOp("switchover", { title: `Switch the database primary to ${nameOf(target)}`, serverId: target, adminId: admin?.id || null }, async ({ log, signal }) => {
      const pre = await mysqlStatusOf(target, { fresh: true });
      if (!pre?.replica || pre.replica.ioRunning !== true || pre.replica.sqlRunning !== true || Number(pre.replica.lagSeconds) > 0)
        throw new Error(`${nameOf(target)} is not caught up (io=${pre?.replica?.ioRunning}, sql=${pre?.replica?.sqlRunning}, lag=${pre?.replica?.lagSeconds}).`);
      const creds = await credentials();
      let promoted = false;
      c.switching = true;
      try {
        log(`Step 1/5 — setting ${nameOf(oldPrimary)} read-only (writes pause from here)…`);
        await ctx.cluster.runTask(oldPrimary, "mysql.readonly", { on: true }, { log, signal });
        const pst = await mysqlStatusOf(oldPrimary, { fresh: true });
        const want = pst?.gtidExecuted || pst?.executedGtid || null;

        log(`Step 2/5 — waiting for ${nameOf(target)} to apply everything${want ? ` (${want})` : ""}…`);
        const deadline = Date.now() + 60_000;
        let caught = false;
        while (Date.now() < deadline) {
          if (signal?.aborted) throw new Error("Cancelled");
          const st = await mysqlStatusOf(target, { fresh: true });
          const r = st?.replica;
          if (r && Number(r.lagSeconds) === 0 && (!want || r.executedGtid === want || (r.retrievedGtid && r.executedGtid === r.retrievedGtid))) {
            caught = true;
            break;
          }
          await sleep(1000);
        }
        if (!caught) throw new Error(`${nameOf(target)} did not catch up within 60 s.`);

        log(`Step 3/5 — promoting ${nameOf(target)}…`);
        const res = await ctx.cluster.runTask(target, "mysql.replica.promote", { waitMs: 30_000 }, { log, signal });
        if (res?.appliedAll === false) log("Warning: the promote task reports not everything was applied.");
        promoted = true;
        c.primary = target;
        c.replica = null;
        c.needsRebuild = [...new Set([...(c.needsRebuild || []).filter((x) => x !== target), oldPrimary])];
        c.state = "needs-rebuild";
        save();
        statusCache.clear();
        ctx.mysql?.resetConnection?.();
        await hostsChanged(log);

        log(`Step 4/5 — re-pointing ${nameOf(oldPrimary)} as the replica (no re-seed)…`);
        await ctx.cluster.runTask(target, "mysql.primary.prepare", await preparePayload(target, [oldPrimary], creds), { log, signal });
        await ctx.cluster.runTask(oldPrimary, "mysql.replica.setup", await setupPayload(oldPrimary, target, creds, { seed: false }), { log, signal });
        c.replica = oldPrimary;
        c.needsRebuild = c.needsRebuild.filter((x) => x !== oldPrimary);
        c.state = "replicating";
        save();

        log("Step 5/5 — syncing website users on the new replica…");
        await syncUsersTo(oldPrimary, { log }).catch((err) => log(`User sync failed: ${err.message}`));
        await refreshStatuses(target, oldPrimary);
        history("switchover", `${nameOf(target)} is the primary, ${nameOf(oldPrimary)} the replica`);
        audit(admin, "mysql.replication.switchover", { primary: target, replica: oldPrimary });
        return { primary: target, replica: oldPrimary };
      } catch (err) {
        if (!promoted) {
          log(`Switchover aborted (${err.message}) — making ${nameOf(oldPrimary)} writable again.`);
          await Promise.resolve(ctx.cluster.runTask(oldPrimary, "mysql.readonly", { on: false }, { log })).catch((e) => log(`Could not make it writable: ${e.message}`));
        } else {
          history("switchover", `${nameOf(target)} is the primary; re-pointing ${nameOf(oldPrimary)} failed (${err.message}) — it needs a rebuild`);
        }
        throw err;
      } finally {
        c.switching = false;
        save();
      }
    });
  }

  // ---- rebuild

  const rebuildFailedAt = new Map();

  function rebuild({ serverId }, admin, { auto = false } = {}) {
    const c = cfg();
    if (!c.enabled) throw httpError(409, "Database replication is off.");
    const id = String(serverId || "");
    if (!id) throw httpError(400, "serverId is required.");
    if (id === c.primary) throw httpError(400, "That server is the primary.");
    if (c.replica && c.replica !== id) throw httpError(409, `${nameOf(c.replica)} is already the replica (one replica in this version).`);
    requireAgent(id, "a database rebuild");
    const primary = c.primary;
    if (!serverOnline(primary)) throw httpError(409, `The primary ${nameOf(primary)} is offline.`);

    return runOp("rebuild", { title: `Rebuild ${nameOf(id)} as the database replica${auto ? " (automatic)" : ""}`, serverId: id, adminId: admin?.id || null }, async ({ log, signal }) => {
      const creds = await credentials({ create: true });
      try {
        if (c.replica === id) {
          c.replica = null;
          c.needsRebuild = [...new Set([...(c.needsRebuild || []), id])];
        }
        c.state = "seeding";
        save();
        broadcast(true);
        log(`Step 1/3 — preparing the primary ${nameOf(primary)} for ${nameOf(id)}…`);
        const prep = await ctx.cluster.runTask(primary, "mysql.primary.prepare", await preparePayload(primary, [id], creds), { log, signal });
        if (prep?.flavor) c.flavor = prep.flavor;
        log(`Step 2/3 — rebuilding ${nameOf(id)}: safety dump, drop, re-seed from ${nameOf(primary)}…`);
        const res = await ctx.cluster.runTask(id, "mysql.rebuild", await setupPayload(id, primary, creds), { log, signal });
        if (res?.safetyDump) log(`Safety dump of its old data: ${res.safetyDump}`);
        c.replica = id;
        c.needsRebuild = c.needsRebuild.filter((x) => x !== id);
        c.seededAt = res?.seededAt || nowIso();
        c.state = "replicating";
        save();
        await refreshStatuses(id, primary);
        log("Step 3/3 — syncing website users…");
        await syncUsersTo(id, { log }).catch((err) => log(`User sync failed: ${err.message}`));
        rebuildFailedAt.delete(id);
        history("rebuilt", `${nameOf(id)} is the replica of ${nameOf(primary)}`);
        alert("db.rebuilt", { title: "Database replica rebuilt", text: `${nameOf(id)} is the database replica again (primary: ${nameOf(primary)}).`, serverId: id, serverName: nameOf(id), primary, primaryName: nameOf(primary), automatic: !!auto });
        audit(admin, "mysql.replication.rebuild", { serverId: id, primary, automatic: !!auto });
        return { replica: id, primary, safetyDump: res?.safetyDump || null };
      } catch (err) {
        rebuildFailedAt.set(id, Date.now());
        c.state = c.replica ? c.state : c.needsRebuild.length ? "needs-rebuild" : "promoted";
        save();
        history("rebuild-failed", `${nameOf(id)}: ${err.message}`);
        throw err;
      }
    });
  }

  // ---- disable

  function disable(admin) {
    const c = cfg();
    if (!c.enabled) throw httpError(409, "Database replication is already off.");
    return runOp("disable", { title: "Turn off database replication", adminId: admin?.id || null }, async ({ log, signal }) => {
      const replica = c.replica;
      if (replica && serverOnline(replica)) {
        // No dedicated "stop" task in the contract: promote (stop IO, apply, RESET REPLICA ALL)
        // then fence it read-only again — replication stops, its data stays, it takes no writes.
        log(`Stopping replication on ${nameOf(replica)} (its data is kept)…`);
        try {
          await ctx.cluster.runTask(replica, "mysql.replica.promote", { waitMs: 10_000 }, { log, signal });
          await ctx.cluster.runTask(replica, "mysql.readonly", { on: true }, { log, signal });
          log(`${nameOf(replica)} keeps a read-only copy of the data as of now.`);
        } catch (err) {
          log(`Could not stop replication on ${nameOf(replica)}: ${err.message}`);
        }
      } else if (replica) {
        log(`${nameOf(replica)} is offline; replication there stops being managed (it stays read-only).`);
      }
      c.enabled = false;
      c.aliasKept = true; // websites keep DB_HOST=alias, which keeps pointing at the primary
      c.replica = null;
      c.state = "off";
      save();
      await hostsChanged(log);
      history("disabled", `primary ${nameOf(c.primary)} stays; ${REPL_ALIAS} keeps pointing at it`);
      audit(admin, "mysql.replication.disable", { primary: c.primary, replica });
      return { primary: c.primary };
    });
  }

  // ------------------------------------------------------------ fencing

  /** ha.mjs beforeFence hook (≤ 3 s): this panel is about to fence itself; if its machine is the primary, stop writes. */
  async function onFence() {
    try {
      const c = cfg();
      if (!c.enabled || c.primary !== localServerId()) return { fenced: false };
      if (!taskTypes().includes("mysql.readonly")) return { fenced: false };
      const isMain = localServerId() === MAIN_ID;
      await withTimeout(
        Promise.resolve(sharedTasks.executeTask("mysql.readonly", { on: true }, { log: (l) => console.log(`[mysql-ha] ${l}`), dataDir: ctx.dataDir, isMain, serverId: localServerId() })),
        2500,
        "mysql.readonly",
      );
      console.log("[mysql-ha] panel is fencing itself: local MySQL set read-only (the new leader re-enables writes if this server is still the primary)");
      return { fenced: true };
    } catch (err) {
      console.error("[mysql-ha] fence hook:", err.message);
      return { fenced: false, error: err.message };
    }
  }

  const fencedAt = new Map(); // serverId -> ms of the last readonly push
  async function fenceIfWritable(id, st, why) {
    if (!st || st.readOnly !== false) return;
    if (Date.now() - (fencedAt.get(id) || 0) < FENCE_RETRY_MS) return;
    if (!serverOnline(id) || !agentOk(id)) return;
    fencedAt.set(id, Date.now());
    // Metrics can be up to ~45 s old: confirm with a fresh status before acting.
    const now = await mysqlStatusOf(id, { fresh: true });
    if (!now || now.readOnly !== false || id === cfg().primary) return;
    try {
      await withTimeout(Promise.resolve(ctx.cluster.runTask(id, "mysql.readonly", { on: true }, { timeoutMs: 15_000 })), 15_000, "mysql.readonly");
      statusCache.delete(id);
      history("fenced", `${nameOf(id)} set read-only (${why})`);
    } catch (err) {
      console.error(`[mysql-ha] fencing ${nameOf(id)} failed: ${err.message}`);
    }
  }

  let unfencedAt = 0;
  async function unfencePrimary(st) {
    const c = cfg();
    if (!st || st.readOnly !== true || c.switching || op) return;
    if (Date.now() - unfencedAt < FENCE_RETRY_MS) return;
    unfencedAt = Date.now();
    const now = await mysqlStatusOf(c.primary, { fresh: true });
    if (!now || now.readOnly !== true || c.switching || op) return;
    try {
      await withTimeout(Promise.resolve(ctx.cluster.runTask(c.primary, "mysql.readonly", { on: false }, { timeoutMs: 15_000 })), 15_000, "mysql.readonly");
      statusCache.delete(c.primary);
      history("unfenced", `${nameOf(c.primary)} is still the primary — writes re-enabled`);
    } catch (err) {
      console.error(`[mysql-ha] re-enabling writes on ${nameOf(c.primary)} failed: ${err.message}`);
    }
  }

  // ------------------------------------------------------------ monitor

  const detect = { since: null, alerted: false, last: null };
  const broken = { since: null, alerted: false };
  let adminIpsCheckedAt = 0;
  let ticking = false;
  let timer = null;

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await tickOnce();
    } catch (err) {
      console.error("[mysql-ha] monitor:", err.message);
    } finally {
      ticking = false;
    }
  }

  async function tickOnce() {
    if (!isLeader()) {
      detect.since = null;
      broken.since = null;
      return;
    }
    const c = cfg();
    if (!c.enabled || !tasksReady()) {
      detect.since = null;
      return;
    }
    if (op) return; // the running operation does its own checks

    const primary = c.primary;
    const replica = c.replica;
    const pst = serverOnline(primary) ? await mysqlStatusOf(primary) : null;
    const rst = replica && serverOnline(replica) ? await mysqlStatusOf(replica) : null;

    // --- failover detection
    if (replica) {
      const cond = await conditions();
      detect.last = { a: cond.a, b: cond.b, c: cond.c };
      if (cond.all) {
        if (!detect.since) {
          detect.since = Date.now();
          console.log(`[mysql-ha] primary ${nameOf(primary)} looks down (offline, no TCP, replica IO disconnected) — watching for ${DETECT_MS / 1000} s`);
          broadcast(true);
        }
        if (Date.now() - detect.since >= DETECT_MS) {
          if (c.mode === "auto") {
            startAutoPromotion();
          } else if (!detect.alerted) {
            detect.alerted = true;
            history("primary-down", `${nameOf(primary)} has been unreachable for ${Math.round((Date.now() - detect.since) / 1000)} s — manual mode: promote ${nameOf(replica)} when ready`);
            alert("db.failover", {
              title: "Database primary is down",
              text: `${nameOf(primary)}'s database has been unreachable for over a minute. Manual mode: promote ${nameOf(replica)} from the panel.`,
              promoted: false,
              primary,
              primaryName: nameOf(primary),
              replica,
              replicaName: nameOf(replica),
            });
          }
        }
      } else {
        if (detect.since) broadcast(true);
        detect.since = null;
        detect.alerted = false;
      }

      // --- broken replication (not while the primary is down: that is the failover path)
      const primaryDownish = detect.last?.a === true;
      const stoppedWithError = !!rst && !primaryDownish && (!rst.replica || ((rst.replica.ioRunning !== true || rst.replica.sqlRunning !== true) && !!rst.replica.lastError));
      if (stoppedWithError) {
        if (!broken.since) broken.since = Date.now();
        if (Date.now() - broken.since >= BROKEN_MS && !broken.alerted) {
          broken.alerted = true;
          const why = rst.replica?.lastError || "replication is not configured on the replica";
          c.state = "broken";
          save();
          history("broken", `${nameOf(replica)}: ${why}`);
          alert("db.broken", { title: "Database replication stopped", text: `Replication to ${nameOf(replica)} has been stopped with an error for 2 minutes: ${why}`, replica, replicaName: nameOf(replica), error: why });
        }
      } else if (rst?.replica?.ioRunning === true && rst.replica.sqlRunning === true) {
        broken.since = null;
        broken.alerted = false;
        if (c.state === "broken") {
          c.state = "replicating";
          save();
          history("recovered", `${nameOf(replica)} is replicating again`);
        }
      }
    } else {
      detect.since = null;
      detect.last = null;
    }

    // --- fencing (2): no server but the primary may be writable
    const fenceSet = new Set([...(c.needsRebuild || []), ...(replica ? [replica] : []), ...Object.keys(c.serverIds || {})]);
    fenceSet.delete(primary);
    for (const id of fenceSet) {
      if (!server(id) || !serverOnline(id)) continue;
      const st = (c.needsRebuild || []).includes(id) || id === replica ? await mysqlStatusOf(id) : metricsStatus(id, STATUS_MAX_AGE_MS);
      await fenceIfWritable(id, st, (c.needsRebuild || []).includes(id) ? "old primary waiting for a rebuild" : "not the primary");
    }

    // --- writes back on for a primary fenced by beforeFence that is still the primary
    if (pst) await unfencePrimary(pst);

    // --- automatic rebuild
    if (c.mode === "auto" && !c.replica && (c.needsRebuild || []).length && !op && serverOnline(primary)) {
      const id = c.needsRebuild.find((x) => server(x) && serverOnline(x) && agentOk(x) && Date.now() - (rebuildFailedAt.get(x) || 0) > REBUILD_RETRY_MS);
      if (id) {
        try {
          console.log(`[mysql-ha] ${nameOf(id)} is back online — rebuilding it as the replica (auto mode)`);
          rebuild({ serverId: id }, null, { auto: true });
        } catch (err) {
          rebuildFailedAt.set(id, Date.now());
          console.error(`[mysql-ha] auto-rebuild of ${nameOf(id)}: ${err.message}`);
        }
      }
    }

    // --- users on the replica (pending changes, and a periodic reconcile)
    if (c.replica && !op && (usersDirty || Date.now() - usersSyncedAt > USERS_RECONCILE_MS)) {
      usersDirty = true;
      await flushUsers();
    }

    // --- new servers: fcc_admin / firewall on the primary must include them
    if (!op && Date.now() - adminIpsCheckedAt > 60_000 && serverOnline(primary)) {
      adminIpsCheckedAt = Date.now();
      const key = crypto.createHash("sha256").update(JSON.stringify(await allServerIps())).digest("hex").slice(0, 16);
      if (c.adminIpsKey && c.adminIpsKey !== key) {
        try {
          const creds = await credentials();
          await ctx.cluster.runTask(primary, "mysql.primary.prepare", await preparePayload(primary, c.replica ? [c.replica] : [], creds), {});
          c.adminIpsKey = key;
          save();
          console.log("[mysql-ha] server addresses changed — primary re-prepared (fcc_admin hosts, firewall)");
        } catch (err) {
          console.error(`[mysql-ha] re-preparing the primary for new server addresses failed: ${err.message}`);
        }
      } else if (!c.adminIpsKey) {
        c.adminIpsKey = key;
        save();
      }
    }

    if (Date.now() - (lastAliasRefresh || 0) > 5 * 60_000) {
      lastAliasRefresh = Date.now();
      refreshAliasIp().catch(() => {});
    }
    broadcast();
  }
  let lastAliasRefresh = 0;

  function startAutoPromotion() {
    if (op) return;
    try {
      const c = cfg();
      console.log(`[mysql-ha] primary ${nameOf(c.primary)} down for ${DETECT_MS / 1000} s — promoting ${nameOf(c.replica)} (auto mode)`);
      runOp("failover", { title: `Automatic database failover to ${nameOf(c.replica)}`, serverId: c.replica }, ({ log, signal }) => promoteNow({ auto: true, log, signal }));
    } catch (err) {
      console.error("[mysql-ha] automatic promotion:", err.message);
    }
  }

  // ------------------------------------------------------------ views

  function replicaState(st, id) {
    if (!serverOnline(id)) return "offline";
    if (!st) return "unknown";
    if (!st.replica) return "not-replicating";
    if (st.replica.lastError && (st.replica.ioRunning !== true || st.replica.sqlRunning !== true)) return "error";
    if (st.replica.ioRunning !== true || st.replica.sqlRunning !== true) return "stopped";
    if (Number(st.replica.lagSeconds) > 30) return "lagging";
    return "replicating";
  }

  function candidates() {
    const c = cfg();
    const list = enabledServers()
      .filter((s) => s.id !== MAIN_ID && s.role !== "main" && s.id !== c.primary)
      .map((s) => {
        const online = serverOnline(s.id);
        const ok = online && agentOk(s.id);
        const reason = !online ? "offline" : !agentOk(s.id) ? `agent v${s.agentVersion || "?"} (needs ${MIN_AGENT})` : null;
        return { serverId: s.id, name: s.name, panelNode: !!s.panel?.enabled, online, ok, reason, recommended: false };
      });
    const pick = list.find((x) => x.ok && x.panelNode) || list.find((x) => x.ok);
    if (pick) pick.recommended = true;
    return list;
  }

  function canEnable() {
    const c = cfg();
    if (c.enabled) return { ok: false, reason: "Replication is already on." };
    if (!isLeader()) return { ok: false, reason: "Only the active panel can turn on replication." };
    if (!tasksReady()) return { ok: false, reason: `The panel's task executor needs the database replication tasks (v${MIN_AGENT}).` };
    if (op) return { ok: false, reason: `An operation is running (${op}).` };
    const cand = candidates();
    if (!cand.length) return { ok: false, reason: "Add an agent server first: the replica runs on another server." };
    if (!cand.some((x) => x.ok)) return { ok: false, reason: `No agent server is online with agent v${MIN_AGENT} or newer.` };
    return { ok: true, reason: null };
  }

  function statusView() {
    const c = cfg();
    const pst = lastKnown(c.primary);
    const rst = c.replica ? lastKnown(c.replica) : null;
    const hosts = {};
    for (const s of enabledServers()) hosts[s.id] = hostsMap(s.id)?.[REPL_ALIAS] || null;
    return {
      enabled: c.enabled === true,
      mode: c.mode,
      state: c.state,
      flavor: c.flavor || null,
      alias: REPL_ALIAS,
      aliasKept: c.aliasKept === true,
      busy: op,
      primary: {
        serverId: c.primary,
        name: nameOf(c.primary),
        address: addressOf(c.primary),
        readOnly: pst ? pst.readOnly ?? null : null,
        online: serverOnline(c.primary),
      },
      replica: c.replica
        ? {
            serverId: c.replica,
            name: nameOf(c.replica),
            state: replicaState(rst, c.replica),
            lagSeconds: rst?.replica?.lagSeconds ?? null,
            ioRunning: rst?.replica?.ioRunning ?? null,
            sqlRunning: rst?.replica?.sqlRunning ?? null,
            lastError: rst?.replica?.lastError ?? null,
            seededAt: c.seededAt || null,
            online: serverOnline(c.replica),
          }
        : null,
      needsRebuild: (c.needsRebuild || []).map((id) => ({ serverId: id, name: nameOf(id), online: serverOnline(id) })),
      history: [...c.history].reverse(),
      canEnable: canEnable(),
      candidates: candidates(),
      detect: detect.since ? { primaryDownForMs: Date.now() - detect.since, detectMs: DETECT_MS, conditions: detect.last } : null,
      hosts,
    };
  }

  // ------------------------------------------------------------ routes

  function routes(router) {
    router.get("/api/mysql/replication", async () => statusView());
    router.post("/api/mysql/replication", async (req, res, { body, admin }) => enable(body || {}, admin));
    router.patch("/api/mysql/replication", async (req, res, { body, admin }) => {
      const c = cfg();
      if (!isLeader()) throw httpError(409, "Only the active panel can change database replication.");
      if (body?.mode !== undefined) {
        if (!["auto", "manual"].includes(body.mode)) throw httpError(400, 'mode must be "auto" or "manual".');
        if (c.mode !== body.mode) {
          c.mode = body.mode;
          save();
          history("mode", `failover mode: ${body.mode}`);
          audit(admin, "mysql.replication.mode", { mode: body.mode });
        }
      }
      return statusView();
    });
    router.delete("/api/mysql/replication", async (req, res, { admin }) => disable(admin));
    router.post("/api/mysql/replication/promote", async (req, res, { body, admin }) => promote({ force: body?.force === true }, admin));
    router.post("/api/mysql/replication/switchover", async (req, res, { admin }) => switchover(admin));
    router.post("/api/mysql/replication/rebuild", async (req, res, { body, admin }) => rebuild({ serverId: body?.serverId }, admin));
  }

  // ------------------------------------------------------------ lifecycle

  async function _start() {
    cfg();
    try {
      if (typeof ctx.ha?.beforeFence === "function") ctx.ha.beforeFence(onFence);
    } catch (err) {
      console.error("[mysql-ha] could not register the fence hook:", err.message);
    }
    // Rule (3), leader side (server.mjs may also call fenceAtBoot in follower mode).
    if (ha().mainIsLocal !== false) await fenceAtBoot({ config: ctx.config, dataDir: ctx.dataDir });
    await refreshAliasIp().catch(() => {});
    timer = setInterval(() => tick(), TICK_MS);
    timer.unref?.();
    const first = setTimeout(() => tick(), 3000);
    first.unref?.();
    try {
      ctx.cluster?.on?.("servers-changed", () => {
        adminIpsCheckedAt = 0;
        refreshAliasIp().catch(() => {});
      });
    } catch {}
  }

  async function _stop() {
    clearInterval(timer);
    clearTimeout(usersTimer);
    timer = null;
  }

  return {
    REPL_ALIAS,
    DETECT_MS,
    status: statusView,
    hostsMap,
    primaryId: () => cfg().primary || MAIN_ID,
    replicaId: () => cfg().replica || null,
    isEnabled: () => cfg().enabled === true,
    onFence,
    usersChanged,
    _routes: routes,
    _start,
    _stop,
    _tick: tick,
  };
}
