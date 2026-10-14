/**
 * CLUSTER — the servers registry, the node-agent protocol, task dispatch and
 * metrics.
 *
 * The main server (id "main") always exists and runs tasks in-process via
 * shared/tasks.mjs. Agent servers run node/node-agent.mjs, which only ever
 * dials OUT to the panel:
 *
 *   POST /agent/hello                 who am I, which agent files are stale
 *   GET  /agent/poll?running=a,b      long-poll (25s) → { tasks: [...], cancel: [...] }
 *   POST /agent/tasks/:id/log         { lines } → { ok, cancel }
 *   POST /agent/tasks/:id/result      { ok, result, error, aborted }
 *   POST /agent/metrics               latest server.metrics sample (+ `edge` status on edge nodes)
 *   POST /agent/edge/logs             { sites: { <siteId>: [access log lines] } } from an edge's nginx
 *   POST /agent/upload/:taskId        raw body: a server.backup archive, or the
 *                                     packaged build of a site.deploy (build once, ship everywhere)
 *
 * All agent routes authenticate with `Authorization: Bearer <server token>`;
 * only sha256(token) is stored. There is no endpoint that runs arbitrary
 * commands — an agent only executes the named task types in shared/tasks.mjs.
 *
 * Metrics: per-server samples (agents push every ~15s, main is sampled
 * in-process) and per-site request counts tailed from nginx access logs, kept
 * as 1-minute buckets for 24h and saved lightly to dataDir/metrics.json.
 *
 * Edge nodes (docs/HA.md): an agent server with `edge.enabled` also runs the
 * nginx front door and a replica of every Cloudflare Tunnel connector, so
 * tunnelled websites survive main going down. Every agent (edge or not) gets a
 * `cluster.sync` task whenever its payload hash changes, when it comes online,
 * and at least every 10 min; main does the equivalent in-process (local vhosts
 * open to edge IPs, ufw, trusted proxies). The connector token only ever leaves
 * the panel inside that task's payload, to the authenticated agent.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import crypto from "node:crypto";
import dns from "node:dns";

import { httpError, send } from "./http.mjs";
import * as sys from "./sys.mjs";
import { setTrustedProxies } from "./auth.mjs";
import * as sharedTasks from "../../shared/tasks.mjs";
import { executeTask, collectMetrics, systemInfo, TASK_TIMEOUTS_MS, TASK_TYPES } from "../../shared/tasks.mjs";

export const MAIN_ID = "main";
const ONLINE_MS = 45_000;
const POLL_WAIT_MS = 25_000;
const METRICS_INTERVAL_MS = 15_000;
const LOST_CONTACT_MS = 90_000;
// Long enough to cover an agent that is restarting to pick up the panel's newer
// files before it takes the task (an older agent waits 60s before reconnecting).
const PICKUP_TIMEOUT_MS = 180_000;
const CANCEL_GRACE_MS = 30_000;
const MINUTE = 60_000;
const KEEP_MS = 24 * 60 * MINUTE;
const MAX_BATCH = 8;
const DEFAULT_MAX_UPLOAD = 50 * 1024 ** 3; // 50 GiB
// Edge nodes (docs/HA.md)
const EDGE_MIN_AGENT = "3.1.0"; // first agent that knows cluster.sync; older ones self-update on hello
const EDGE_DEBOUNCE_MS = 2_000;
const EDGE_RECONCILE_MS = 60_000;
const EDGE_RESEND_MS = 10 * MINUTE;
const EDGE_UFW_COMMENT = "fcc sites from edge";
const EDGE_UFW_PORTS = "3000:3999";
const EDGE_LOG_LIMIT = 2 * 1024 * 1024 + 256 * 1024; // the agent sends ≤ 2 MB of lines; leave room for JSON
const DNS_CACHE_MS = 5 * MINUTE;

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const floorMinute = (ms) => Math.floor(ms / MINUTE) * MINUTE;
const nowIso = () => new Date().toISOString();

function tokenEquals(hashA, hashB) {
  if (!hashA || !hashB || hashA.length !== hashB.length) return false;
  return crypto.timingSafeEqual(Buffer.from(hashA), Buffer.from(hashB));
}

/** "3.1.0" >= "3.0.12"? Missing / unparsable versions are never new enough. */
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

function bearer(req) {
  const h = String(req.headers.authorization || "");
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
}

const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
function validHost(h) {
  if (typeof h !== "string") return false;
  const v = h.trim();
  return net.isIP(v) !== 0 || HOST_RE.test(v);
}

// =================================================================== module

export function register(router, ctx) {
  const cluster = createCluster(ctx);
  ctx.cluster = cluster;
  cluster._routes(router);
}

export async function start(ctx) {
  await ctx.cluster?._start();
}

export async function stop(ctx) {
  await ctx.cluster?._stop();
}

// ================================================================== cluster

function createCluster(ctx) {
  const { db } = ctx;
  const listeners = new Map(); // event -> Set<fn>
  const queues = new Map(); // serverId -> [task]
  const tasks = new Map(); // taskId -> task
  const parked = new Map(); // serverId -> { finish }
  const seen = new Map(); // serverId -> ms
  const onlineWas = new Map(); // serverId -> bool
  const latest = new Map(); // serverId -> sample
  const series = new Map(); // serverId -> [{ t, cpu, mem, memTotal, disk, diskTotal, load, n }]
  const reqSeries = new Map(); // key ("site:<id>" | "srv:<id>") -> [{ t, count, errors }]
  const tails = new Map(); // siteId -> { ino, pos }
  // Edge nodes — in memory only (edgeSync, the last task result, is persisted on the record).
  const edgeStatus = new Map(); // serverId -> sanitised `edge` from /agent/metrics + reportedAt
  const edgeDesired = new Map(); // serverId -> payload hash the panel wants it to have
  const edgePushed = new Map(); // serverId -> { hash, at } of the last cluster.sync sent
  const edgeInflight = new Map(); // serverId -> Promise of the push chain
  const edgeInflightHash = new Map(); // serverId -> hash being applied right now
  const edgeQueued = new Set(); // serverIds with a push waiting behind the current one
  const edgeConnectorNames = new Map(); // connectorId -> name (from the last payload build)
  const edgeOldAgentNoted = new Map(); // serverId -> agentVersion we already logged as too old
  let edgeIpList = []; // resolved addresses of every enabled edge (sorted)
  let edgeIpKey = null; // JSON of edgeIpList at the last main-side apply (null = never)
  let edgeTimer = null;
  const edgeForce = new Set();
  let started = false;
  const timers = [];
  let metricsDirty = false;

  // ------------------------------------------------------------- events

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  }
  function emit(event, data) {
    for (const fn of listeners.get(event) || []) {
      try {
        const r = fn(data);
        if (r?.catch) r.catch((err) => console.error(`[cluster] ${event} listener failed:`, err.message));
      } catch (err) {
        console.error(`[cluster] ${event} listener failed:`, err.message);
      }
    }
  }
  function serversChanged(reason, serverId) {
    emit("servers-changed", { reason, serverId });
    const s = serverId && db.get("servers", serverId);
    try {
      ctx.events?.broadcast("server", s ? publicServer(s) : { id: serverId, deleted: true, reason });
    } catch {
      /* no SSE yet */
    }
  }

  // ------------------------------------------------------------- records

  function mainHostGuess() {
    try {
      const h = new URL(ctx.panelUrl()).hostname.replace(/^\[|\]$/g, "");
      if (h && h !== "localhost" && !h.startsWith("127.") && h !== "::1") return h;
    } catch {
      /* not a URL */
    }
    return localAddresses()[0] || "127.0.0.1";
  }

  function ensureMain() {
    const existing = db.get("servers", MAIN_ID);
    const info = systemInfo();
    if (!existing) {
      db.insert("servers", {
        id: MAIN_ID,
        name: "Main",
        role: "main",
        host: mainHostGuess(),
        privateHost: null,
        weight: 1,
        enabled: true,
        lbEligible: true,
        tokenHash: null,
        agentVersion: ctx.version,
        lastSeenAt: nowIso(),
        info,
      });
    } else {
      const patch = { role: "main", agentVersion: ctx.version, info, lastSeenAt: nowIso() };
      if (existing.lbEligible === undefined) patch.lbEligible = true;
      if (existing.enabled === undefined) patch.enabled = true;
      if (existing.weight === undefined) patch.weight = 1;
      db.update("servers", MAIN_ID, patch);
    }
    seen.set(MAIN_ID, Date.now());
  }

  function lastSeenMs(id) {
    if (id === MAIN_ID) return Date.now();
    const mem = seen.get(id);
    if (mem) return mem;
    const s = db.get("servers", id);
    return s?.lastSeenAt ? Date.parse(s.lastSeenAt) || 0 : 0;
  }

  function isOnline(id) {
    if (id === MAIN_ID) return true;
    if (!db.get("servers", id)) return false;
    return Date.now() - lastSeenMs(id) < ONLINE_MS;
  }

  function address(id) {
    if (id === MAIN_ID) return "127.0.0.1";
    const s = db.get("servers", id);
    if (!s) return null;
    return (s.privateHost || s.host || "").trim() || null;
  }

  function latestMetrics(id) {
    const m = latest.get(id);
    if (!m) return null;
    return {
      cpu: m.cpu ?? null,
      mem: m.mem ?? null,
      memTotal: m.memTotal ?? null,
      disk: m.disk ?? null,
      diskTotal: m.diskTotal ?? null,
      load: m.load ?? null,
      at: m.at,
    };
  }

  function siteTargets(site) {
    try {
      const t = ctx.sites?.targets?.(site);
      if (Array.isArray(t)) return t;
    } catch {
      /* fall through */
    }
    const ids = Array.isArray(site.serverIds) ? site.serverIds : [];
    return site.loadBalanced ? ids : [ids[0] || MAIN_ID];
  }

  function allSites() {
    try {
      const l = ctx.sites?.list?.({});
      if (Array.isArray(l)) return l;
    } catch {
      /* fall through */
    }
    return db.list("sites");
  }

  function siteCount(id) {
    return allSites().filter((s) => siteTargets(s).includes(id)).length;
  }

  function publicServer(s, counts) {
    if (!s) return null;
    const { tokenHash, ...rest } = s;
    const last = lastSeenMs(s.id);
    return {
      ...rest,
      role: s.id === MAIN_ID ? "main" : "worker",
      kind: s.id === MAIN_ID ? "Main" : "Agent server",
      weight: Number(s.weight) || 1,
      enabled: s.enabled !== false,
      lbEligible: s.lbEligible !== false,
      hasToken: s.id === MAIN_ID ? false : !!tokenHash,
      online: isOnline(s.id),
      lastSeenAt: last ? new Date(last).toISOString() : null,
      address: address(s.id),
      metrics: latestMetrics(s.id),
      siteCount: counts ? counts.get(s.id) || 0 : siteCount(s.id),
      pendingTasks: [...tasks.values()].filter((t) => t.serverId === s.id).length,
      edge: s.id === MAIN_ID ? { enabled: true, implicit: true } : { enabled: !!s.edge?.enabled },
      edgeStatus: publicEdgeStatus(s),
    };
  }

  function listServers() {
    const counts = new Map();
    for (const site of allSites()) for (const id of new Set(siteTargets(site))) counts.set(id, (counts.get(id) || 0) + 1);
    return db
      .list("servers")
      .slice()
      .sort((a, b) => (a.id === MAIN_ID ? -1 : b.id === MAIN_ID ? 1 : String(a.name).localeCompare(String(b.name))))
      .map((s) => publicServer(s, counts));
  }

  function getServer(id) {
    return publicServer(db.get("servers", id));
  }

  function authenticateNode(req) {
    const token = bearer(req);
    if (!token || token.length < 16) return null;
    const h = sha256(token);
    for (const s of db.list("servers")) {
      if (s.id !== MAIN_ID && s.tokenHash && tokenEquals(s.tokenHash, h)) return s;
    }
    return null;
  }

  function authByQuery(query) {
    const s = query.server && db.get("servers", String(query.server));
    if (!s || s.id === MAIN_ID || !s.tokenHash || !query.token) return null;
    return tokenEquals(s.tokenHash, sha256(query.token)) ? s : null;
  }

  function touch(s) {
    const now = Date.now();
    seen.set(s.id, now);
    const persisted = s.lastSeenAt ? Date.parse(s.lastSeenAt) : 0;
    if (now - persisted > 60_000) db.update("servers", s.id, { lastSeenAt: new Date(now).toISOString() });
    if (onlineWas.get(s.id) === false) checkOnline();
  }

  function checkOnline() {
    for (const s of db.list("servers")) {
      const now = isOnline(s.id);
      const was = onlineWas.get(s.id);
      onlineWas.set(s.id, now);
      if (was !== undefined && was !== now) {
        console.log(`[cluster] ${s.name} (${s.id}) is ${now ? "online" : "offline"}`);
        serversChanged(now ? "online" : "offline", s.id);
      }
    }
  }

  // -------------------------------------------------------------- tasks

  function newToken() {
    return crypto.randomBytes(32).toString("base64url");
  }

  function installCommand(req, serverId, token) {
    const base = ctx.panelUrl(req);
    return `curl -fsSL "${base}/install/node.sh?server=${encodeURIComponent(serverId)}&token=${encodeURIComponent(token)}" | sudo bash`;
  }

  function installWarning(req) {
    try {
      const h = new URL(ctx.panelUrl(req)).hostname;
      if (h === "localhost" || h.startsWith("127.") || h === "::1" || h === "[::1]") {
        return "The panel URL is a loopback address — set the public panel URL in Settings so other servers can reach it.";
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function runTask(serverId, type, payload = {}, { log = () => {}, signal = null, timeoutMs } = {}) {
    const server = db.get("servers", serverId);
    if (!server) return Promise.reject(httpError(404, `Server ${serverId} not found`));
    if (!TASK_TYPES.includes(type)) return Promise.reject(new Error(`Unknown task type "${type}"`));

    if (serverId === MAIN_ID) {
      return executeTask(type, payload, {
        log,
        signal,
        dataDir: ctx.dataDir,
        isMain: true,
        serverId: MAIN_ID,
        panelUrl: safePanelUrl(),
        // Main's local static/php vhosts must also answer the edge nodes' nginx.
        edgeAllow: edgeIpList.slice(),
      });
    }

    if (!isOnline(serverId)) {
      const ago = lastSeenMs(serverId);
      return Promise.reject(
        new Error(
          `${server.name} is offline — its agent ${ago ? `was last seen ${Math.round((Date.now() - ago) / 1000)}s ago` : "has never checked in"}.`,
        ),
      );
    }
    if (signal?.aborted) return Promise.reject(Object.assign(new Error("Cancelled."), { aborted: true }));

    return new Promise((resolve, reject) => {
      const id = db.newId("tsk");
      // server.backup and a site.deploy that packages its build (build once,
      // ship everywhere) send a file back through /agent/upload/:taskId.
      const uploads = type === "server.backup" || (type === "site.deploy" && payload?.package);
      const p = uploads ? { ...payload, upload: { url: `/agent/upload/${id}` } } : payload;
      const task = {
        id,
        serverId,
        type,
        payload: p,
        status: "queued",
        createdAt: Date.now(),
        sentAt: 0,
        lastActivity: Date.now(),
        cancelRequested: false,
        timeoutMs: timeoutMs || TASK_TIMEOUTS_MS[type] || 15 * MINUTE,
        log,
        settle: null,
      };
      let done = false;
      const onAbort = () => {
        if (task.status === "queued") return finish(Object.assign(new Error("Cancelled."), { aborted: true }));
        task.cancelRequested = true;
        log("Cancel requested — telling the agent…");
        kick(serverId);
        task.cancelTimer = setTimeout(
          () => finish(Object.assign(new Error("Cancelled (the agent did not confirm in time)."), { aborted: true })),
          CANCEL_GRACE_MS,
        );
      };
      const finish = (err, result) => {
        if (done) return;
        done = true;
        clearTimeout(task.cancelTimer);
        signal?.removeEventListener("abort", onAbort);
        tasks.delete(id);
        const q = queues.get(serverId);
        if (q) {
          const i = q.indexOf(task);
          if (i !== -1) q.splice(i, 1);
        }
        if (err) reject(err);
        else resolve(result);
      };
      task.settle = finish;
      signal?.addEventListener("abort", onAbort, { once: true });
      tasks.set(id, task);
      if (!queues.has(serverId)) queues.set(serverId, []);
      queues.get(serverId).push(task);
      kick(serverId);
    });
  }

  function safePanelUrl() {
    try {
      return ctx.panelUrl();
    } catch {
      return null;
    }
  }

  function sweepTasks() {
    const now = Date.now();
    for (const task of [...tasks.values()]) {
      const server = db.get("servers", task.serverId);
      const name = server?.name || task.serverId;
      if (!server) {
        task.settle(new Error(`${name} was removed.`));
      } else if (task.status === "queued" && now - task.createdAt > PICKUP_TIMEOUT_MS && !isOnline(task.serverId)) {
        task.settle(new Error(`${name} went offline before it picked up the task.`));
      } else if (task.status === "sent" && now - lastSeenMs(task.serverId) > LOST_CONTACT_MS) {
        task.settle(new Error(`Lost contact with ${name} while it was running ${task.type}.`));
      } else if (now - (task.sentAt || task.createdAt) > task.timeoutMs) {
        task.cancelRequested = true;
        kick(task.serverId);
        task.settle(new Error(`${task.type} on ${name} timed out after ${Math.round(task.timeoutMs / 60000)} min.`));
      }
    }
  }

  /** Answer this server's parked poll now (new task or a cancel). */
  function kick(serverId) {
    const p = parked.get(serverId);
    if (p) p.finish();
  }

  function takeWork(serverId) {
    const q = queues.get(serverId) || [];
    const out = [];
    while (q.length && out.length < MAX_BATCH) {
      const t = q.shift();
      t.status = "sent";
      t.sentAt = Date.now();
      out.push({ id: t.id, type: t.type, payload: t.payload, timeoutMs: t.timeoutMs });
    }
    const cancel = [...tasks.values()]
      .filter((t) => t.serverId === serverId && t.status === "sent" && t.cancelRequested)
      .map((t) => t.id);
    return { tasks: out, cancel };
  }

  function reconcile(serverId, running) {
    // Tasks we handed out that the agent no longer knows about (it restarted).
    const now = Date.now();
    for (const t of tasks.values()) {
      if (t.serverId !== serverId || t.status !== "sent") continue;
      if (running.has(t.id) || now - t.sentAt < 15_000) continue;
      t.settle(new Error("The agent lost this task (it probably restarted). Try again."));
    }
  }

  // ------------------------------------------------------------ metrics

  function recordSample(serverId, sample) {
    const at = nowIso();
    latest.set(serverId, { ...sample, at });
    const t = floorMinute(Date.now());
    let arr = series.get(serverId);
    if (!arr) series.set(serverId, (arr = []));
    const last = arr[arr.length - 1];
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    if (last && last.t === t) {
      const n = last.n || 1;
      if (num(sample.cpu) != null) last.cpu = Math.round(((last.cpu ?? sample.cpu) * n + sample.cpu) / (n + 1) * 10) / 10;
      if (num(sample.load) != null) last.load = Math.round(((last.load ?? sample.load) * n + sample.load) / (n + 1) * 100) / 100;
      last.mem = num(sample.mem) ?? last.mem;
      last.memTotal = num(sample.memTotal) ?? last.memTotal;
      last.disk = num(sample.disk) ?? last.disk;
      last.diskTotal = num(sample.diskTotal) ?? last.diskTotal;
      last.n = n + 1;
    } else {
      arr.push({
        t,
        cpu: num(sample.cpu),
        mem: num(sample.mem),
        memTotal: num(sample.memTotal),
        disk: num(sample.disk),
        diskTotal: num(sample.diskTotal),
        load: num(sample.load),
        n: 1,
      });
      trim(arr);
    }
    metricsDirty = true;
  }

  function trim(arr) {
    const cutoff = Date.now() - KEEP_MS;
    let i = 0;
    while (i < arr.length && arr[i].t < cutoff) i++;
    if (i) arr.splice(0, i);
  }

  function addRequests(key, t, count, errors) {
    let arr = reqSeries.get(key);
    if (!arr) reqSeries.set(key, (arr = []));
    if (t < Date.now() - KEEP_MS) return;
    let i = arr.length - 1;
    while (i >= 0 && arr[i].t > t) i--;
    if (i >= 0 && arr[i].t === t) {
      arr[i].count += count;
      arr[i].errors += errors;
    } else {
      arr.splice(i + 1, 0, { t, count, errors });
      trim(arr);
    }
    metricsDirty = true;
  }

  const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  function parseLogLine(line) {
    // fcc format (loadbalancer.mjs): $msec $status $request_time "$upstream_addr" "$host" "$request" …
    let m = /^(\d{9,11})\.(\d{3}) (\d{3}) \S+ "([^"]*)"/.exec(line);
    if (m) return { t: Number(m[1]) * 1000 + Number(m[2]), status: Number(m[3]), upstream: m[4] };
    // nginx "combined": … [04/Oct/2026:22:01:05 +0000] "GET / HTTP/1.1" 200 …
    m = /\[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})\] "[^"]*" (\d{3})/.exec(line);
    if (m) {
      const off = (m[7] === "-" ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9])) * 60_000;
      const t = Date.UTC(+m[3], MONTHS[m[2]] ?? 0, +m[1], +m[4], +m[5], +m[6]) - off;
      return { t, status: Number(m[10]), upstream: "" };
    }
    return line.trim() ? { t: Date.now(), status: 0, upstream: "" } : null;
  }

  function logDir() {
    return process.env.FCC_NGINX_LOG_DIR || "/var/log/nginx";
  }

  /**
   * Upstream address → serverId, for "$upstream_addr" in an access log line.
   * Main's own nginx dials main as 127.0.0.1; an edge's nginx (edgeId) dials
   * itself as 127.0.0.1 and main on its privateHost || host (loadbalancer.mjs).
   */
  function upstreamMap(edgeId = null) {
    const byAddr = new Map();
    for (const s of db.list("servers")) {
      const a = address(s.id);
      if (a) byAddr.set(a, s.id);
    }
    if (edgeId) {
      const main = db.get("servers", MAIN_ID);
      const ma = String(main?.privateHost || main?.host || "").trim();
      if (ma && !byAddr.has(ma)) byAddr.set(ma, MAIN_ID);
      byAddr.set("127.0.0.1", edgeId);
      byAddr.set("::1", edgeId);
    }
    return byAddr;
  }

  /** Count a batch of one site's access log lines (main's own, or shipped by an edge). */
  function ingestLines(site, lines, byAddr) {
    if (!lines.length) return;
    const counts = new Map(); // key|t -> { count, errors }
    const bump = (key, t, err) => {
      const k = `${key}|${t}`;
      const c = counts.get(k) || { key, t, count: 0, errors: 0 };
      c.count++;
      if (err) c.errors++;
      counts.set(k, c);
    };
    try {
      ctx.analytics?.ingest?.(site, lines); // visitors / page views (panel/lib/analytics.mjs)
    } catch (err) {
      console.warn("[cluster] analytics ingest:", err.message);
    }
    for (const line of lines) {
      const r = parseLogLine(line);
      if (!r) continue;
      const t = floorMinute(r.t);
      const err = r.status >= 500;
      bump(`site:${site.id}`, t, err);
      // "$upstream_addr" can list several attempts: "10.0.0.2:3001, 127.0.0.1:3001" — the last one answered.
      const up = r.upstream.split(",").pop().trim();
      const host = up.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
      const sid = byAddr.get(host);
      if (sid) bump(`srv:${sid}`, t, err);
    }
    for (const c of counts.values()) addRequests(c.key, c.t, c.count, c.errors);
  }

  function tailAccessLogs() {
    const dir = logDir();
    const byAddr = upstreamMap();
    for (const site of allSites()) {
      const file = path.join(dir, `fcc-${site.id}.access.log`);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      let tail = tails.get(site.id);
      if (!tail) {
        // First sight: start at the end — history before the panel was watching is not counted.
        tails.set(site.id, { ino: st.ino, pos: st.size });
        continue;
      }
      if (tail.ino !== st.ino || st.size < tail.pos) tail = { ino: st.ino, pos: 0 }; // rotated / truncated
      if (st.size === tail.pos) {
        tails.set(site.id, tail);
        continue;
      }
      const len = Math.min(st.size - tail.pos, 16 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      let fd;
      try {
        fd = fs.openSync(file, "r");
        fs.readSync(fd, buf, 0, len, tail.pos);
      } catch {
        continue;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      const lastNl = buf.lastIndexOf(10);
      if (lastNl === -1) {
        tails.set(site.id, tail);
        continue;
      }
      tail.pos += lastNl + 1;
      tails.set(site.id, tail);
      ingestLines(site, buf.subarray(0, lastNl).toString("utf8").split("\n"), byAddr);
    }
  }

  function parseRange(range) {
    const m = /^(\d+)(m|h)$/.exec(String(range || "1h"));
    let ms = m ? Number(m[1]) * (m[2] === "h" ? 60 : 1) * MINUTE : 60 * MINUTE;
    ms = Math.max(5 * MINUTE, Math.min(KEEP_MS, ms));
    const step = ms > 6 * 60 * MINUTE ? 5 * MINUTE : MINUTE;
    return { ms, step };
  }

  function bucketServer(points, from, step) {
    const out = new Map();
    for (const p of points || []) {
      if (p.t < from) continue;
      const t = Math.floor(p.t / step) * step;
      const b = out.get(t);
      if (!b) out.set(t, { ...p, t, n: 1 });
      else {
        b.cpu = p.cpu == null ? b.cpu : Math.round((((b.cpu ?? p.cpu) * b.n + p.cpu) / (b.n + 1)) * 10) / 10;
        b.load = p.load == null ? b.load : Math.round((((b.load ?? p.load) * b.n + p.load) / (b.n + 1)) * 100) / 100;
        b.mem = p.mem ?? b.mem;
        b.memTotal = p.memTotal ?? b.memTotal;
        b.disk = p.disk ?? b.disk;
        b.diskTotal = p.diskTotal ?? b.diskTotal;
        b.n++;
      }
    }
    return [...out.values()].map(({ n, ...rest }) => rest);
  }

  function denseRequests(keys, from, to, step) {
    const out = [];
    const idx = new Map();
    for (let t = from; t <= to; t += step) {
      idx.set(t, out.length);
      out.push({ t, count: 0, errors: 0 });
    }
    for (const key of keys) {
      for (const p of reqSeries.get(key) || []) {
        if (p.t < from) continue;
        const t = Math.floor(p.t / step) * step;
        const i = idx.get(t);
        if (i === undefined) continue;
        out[i].count += p.count;
        out[i].errors += p.errors;
      }
    }
    return out;
  }

  /**
   * { range, step, from, to,
   *   servers: { [id]: [{ t, cpu, mem, memTotal, disk, diskTotal, load }] }   (only minutes with samples)
   *   requests: [{ t, count, errors }]                                        (dense, every step)
   *   perSite: { [siteId]: [{ t, count, errors }] }                           (dense)
   *   perServer: { [serverId]: [{ t, count, errors }] } }                     (dense; from $upstream_addr)
   */
  function metrics({ range = "1h" } = {}) {
    const { ms, step } = parseRange(range);
    const to = Math.floor(Date.now() / step) * step;
    const from = to - ms + step;
    const servers = {};
    for (const s of db.list("servers")) servers[s.id] = bucketServer(series.get(s.id), from, step);
    const siteKeys = [...reqSeries.keys()].filter((k) => k.startsWith("site:"));
    const perSite = {};
    for (const k of siteKeys) perSite[k.slice(5)] = denseRequests([k], from, to, step);
    const perServer = {};
    for (const k of [...reqSeries.keys()].filter((k) => k.startsWith("srv:"))) perServer[k.slice(4)] = denseRequests([k], from, to, step);
    return { range, step, from, to, servers, requests: denseRequests(siteKeys, from, to, step), perSite, perServer };
  }

  function metricsFile() {
    return path.join(ctx.dataDir, "metrics.json");
  }

  function loadMetrics() {
    try {
      const data = JSON.parse(fs.readFileSync(metricsFile(), "utf8"));
      const cutoff = Date.now() - KEEP_MS;
      for (const [id, pts] of Object.entries(data.servers || {})) {
        series.set(id, pts.filter((p) => p.t >= cutoff));
      }
      for (const [key, pts] of Object.entries(data.requests || {})) {
        reqSeries.set(key, pts.filter((p) => p[0] >= cutoff).map(([t, count, errors]) => ({ t, count, errors: errors || 0 })));
      }
      for (const [id, m] of Object.entries(data.latest || {})) latest.set(id, m);
    } catch {
      /* first boot or unreadable — start empty */
    }
  }

  function saveMetrics() {
    if (!metricsDirty) return;
    metricsDirty = false;
    const data = { v: 1, savedAt: nowIso(), servers: {}, requests: {}, latest: Object.fromEntries(latest) };
    for (const [id, pts] of series) data.servers[id] = pts;
    for (const [key, pts] of reqSeries) {
      if (key.startsWith("site:") && !db.get("sites", key.slice(5))) continue; // deleted site
      data.requests[key] = pts.map((p) => [p.t, p.count, p.errors]);
    }
    try {
      fs.mkdirSync(ctx.dataDir, { recursive: true });
      const tmp = `${metricsFile()}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, metricsFile());
    } catch (err) {
      console.warn("[cluster] could not save metrics.json:", err.message);
    }
  }

  async function sampleMain() {
    try {
      const m = await collectMetrics();
      recordSample(MAIN_ID, m);
      seen.set(MAIN_ID, Date.now());
    } catch (err) {
      console.warn("[cluster] main metrics failed:", err.message);
    }
  }

  // --------------------------------------------------------- agent files

  /** One hash over every file the agents run, so "is this agent current?" is a compare. */
  function filesDigest() {
    const h = crypto.createHash("sha256");
    for (const [rel, sum] of [...agentFiles()].sort(([a], [b]) => a.localeCompare(b))) h.update(`${rel}:${sum}\n`);
    return h.digest("hex");
  }
  // serverId -> the files digest that agent was confirmed to be running at its
  // last hello. Agents long-poll and only say hello when they start, so after
  // the panel's files change (a panel update) an agent would otherwise keep
  // deploying with the old engine until someone restarted it.
  const currentAt = new Map();
  // serverId -> { digest, at } of the last time we asked it to reconnect, so an
  // agent that cannot update (FCC_NODE_NO_UPDATE, a failing download) is asked
  // at most once per digest per 10 minutes and still gets its work.
  const nudged = new Map();
  function agentIsStale(serverId) {
    const digest = filesDigest();
    if (currentAt.get(serverId) === digest) return false;
    const last = nudged.get(serverId);
    if (last && last.digest === digest && Date.now() - last.at < 10 * MINUTE) return false;
    nudged.set(serverId, { digest, at: Date.now() });
    return true;
  }

  let filesCache = null;
  function agentFiles() {
    if (filesCache && Date.now() - filesCache.at < 10_000) return filesCache.files;
    const root = ctx.rootDir;
    const ok = (rel) => /^(node|shared)\/[\w.-]+\.mjs$/.test(rel) || rel === "panel/lib/sys.mjs";
    const files = new Map(); // rel -> sha256
    const todo = ["node/node-agent.mjs"];
    while (todo.length) {
      const rel = todo.shift();
      if (files.has(rel) || !ok(rel)) continue;
      let src;
      try {
        src = fs.readFileSync(path.join(root, rel));
      } catch {
        continue;
      }
      files.set(rel, crypto.createHash("sha256").update(src).digest("hex"));
      const re = /(?:import|export)\s[^"']*?from\s*["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
      for (const m of src.toString("utf8").matchAll(re)) {
        const spec = m[1] || m[2];
        const next = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
        if (!next.startsWith("..")) todo.push(next);
      }
    }
    filesCache = { at: Date.now(), files };
    return files;
  }

  async function mainIps() {
    const out = new Set(localAddresses());
    const main = db.get("servers", MAIN_ID);
    for (const h of [main?.host, main?.privateHost, ...(ctx.config?.cluster?.mainIps || [])]) {
      if (!h) continue;
      if (net.isIP(h)) out.add(h);
      else {
        try {
          for (const r of await dns.promises.lookup(h, { all: true })) out.add(r.address);
        } catch {
          /* unresolvable — skip */
        }
      }
    }
    return [...out].filter((ip) => net.isIP(ip) && !ip.startsWith("127.") && ip !== "::1");
  }

  // -------------------------------------------------------------- edges
  //
  // docs/HA.md. Every agent server gets a cluster.sync payload:
  //   { hash, allowFrom: [edge + main IPs that must reach its site ports],
  //     edge: null | { files, connectors: [{ id, name, token }], shims } }
  // pushed (debounced 2 s) on edgesChanged(), servers-changed and hello, and
  // re-checked every 60 s (pushed when its hash differs from what the agent
  // last applied; every 10 min regardless). Main is implicitly an edge and
  // never gets the task — the panel does main's part here (see applyMainEdges).

  const isEdge = (s) => !!s && s.id !== MAIN_ID && !!s.edge?.enabled;
  const syncSupported = () => TASK_TYPES.includes("cluster.sync");
  const bracket = (h) => (net.isIP(h) === 6 ? `[${h}]` : h);
  const isLoopback = (ip) => ip.startsWith("127.") || ip === "::1";

  const dnsCache = new Map(); // host -> { at, ips }
  async function resolveHost(h) {
    const v = String(h || "").trim();
    if (!v) return [];
    if (net.isIP(v)) return [v];
    const c = dnsCache.get(v);
    if (c && Date.now() - c.at < DNS_CACHE_MS) return c.ips;
    let ips = c?.ips || [];
    try {
      ips = [...new Set((await dns.promises.lookup(v, { all: true })).map((r) => r.address))];
    } catch {
      /* unresolvable right now — keep what we had */
    }
    dnsCache.set(v, { at: Date.now(), ips });
    return ips;
  }

  async function serverIps(s) {
    const out = new Set();
    for (const h of [s?.host, s?.privateHost]) for (const ip of await resolveHost(h)) if (!isLoopback(ip)) out.add(ip);
    return [...out];
  }

  /** serverId -> resolved IPs, for every enabled edge (main excluded — it is handled apart). */
  async function edgeIpMap() {
    const m = new Map();
    for (const s of db.list("servers")) if (isEdge(s)) m.set(s.id, await serverIps(s));
    return m;
  }

  /** The cluster.sync payload for agent server `s`. Contains the connector tokens: never log or return it. */
  async function buildEdgePayload(s, { ipMap, mainIpList }) {
    const allow = new Set(mainIpList);
    for (const [id, ips] of ipMap) if (id !== s.id) for (const ip of ips) allow.add(ip);
    const allowFrom = [...allow].filter((ip) => net.isIP(ip) && !isLoopback(ip)).sort();
    let edge = null;
    if (isEdge(s)) {
      const main = db.get("servers", MAIN_ID);
      const mainAddr = bracket(String(main?.privateHost || main?.host || "").trim() || "127.0.0.1");
      let connectors = [];
      let shims = [];
      try {
        connectors = (ctx.cloudflare?.edgeConnectors?.() || []).map((c) => ({ id: c.id, name: c.name, token: c.token }));
      } catch (err) {
        console.warn("[cluster] edge connectors:", err.message);
      }
      try {
        shims = (ctx.cloudflare?.edgeShims?.() || []).map((x) => ({
          name: x.name,
          listenPort: Number(x.port),
          listenTls: !!x.tls,
          target: `${x.tls ? "https" : "http"}://${mainAddr}:${Number(x.port)}`,
        }));
      } catch (err) {
        console.warn("[cluster] edge shims:", err.message);
      }
      for (const c of connectors) edgeConnectorNames.set(c.id, c.name);
      edge = { files: ctx.lb?.edgeFiles?.(s.id) || {}, connectors, shims };
    }
    const body = { allowFrom, edge };
    return { hash: sha256(JSON.stringify(body)), ...body };
  }

  /** Persist what the agent reported for a cluster.sync (or why it failed) and tell the UI. */
  function recordEdgeSync(serverId, sync) {
    if (!db.get("servers", serverId)) return;
    const updated = db.update("servers", serverId, { edgeSync: sync });
    try {
      ctx.events?.broadcast("server", publicServer(updated)); // not servers-changed: nothing for nginx to redo
    } catch {
      /* no SSE yet */
    }
  }

  /** The agent's cluster.sync result without anything it should not have sent back. */
  function cleanSyncResult(r) {
    const o = r && typeof r === "object" ? r : {};
    const str = (v, n) => (v == null ? null : String(v).slice(0, n));
    return {
      hash: /^[a-f0-9]{64}$/.test(String(o.hash || "")) ? o.hash : null,
      appliedAt: str(o.appliedAt, 40),
      nginx: o.nginx === undefined ? null : !!o.nginx,
      error: str(o.error, 2000),
      connectors: (Array.isArray(o.connectors) ? o.connectors : []).slice(0, 50).map((c) => ({
        id: str(c?.id, 60),
        name: edgeConnectorNames.get(String(c?.id)) || str(c?.name, 60),
        active: c?.active === undefined ? null : !!c.active,
        error: str(c?.error, 300),
      })),
      shims: (Array.isArray(o.shims) ? o.shims : []).slice(0, 20).map((x) => ({
        name: str(x?.name, 40),
        listenPort: Number(x?.listenPort) || null,
        ok: x?.ok === undefined ? null : !!x.ok,
        error: str(x?.error, 300),
      })),
    };
  }

  /** Why server `s` cannot take a cluster.sync right now, or null. */
  function edgePushBlocker(s) {
    if (!s || s.id === MAIN_ID) return "The main server applies its edge configuration itself.";
    if (!syncSupported()) return "This panel's task engine (shared/tasks.mjs) does not know cluster.sync yet — update the panel.";
    if (!versionAtLeast(s.agentVersion, EDGE_MIN_AGENT)) {
      return `${s.name} runs agent v${s.agentVersion || "?"}; edge sync needs v${EDGE_MIN_AGENT} or newer. It updates itself the next time it reconnects to the panel.`;
    }
    if (!isOnline(s.id)) return `${s.name} is offline.`;
    return null;
  }

  async function pushEdgeOnce(serverId, { force = false, log = () => {}, signal = null } = {}) {
    const s = db.get("servers", serverId);
    if (!s) throw httpError(404, "Server not found");
    const blocked = edgePushBlocker(s);
    if (blocked) throw new Error(blocked);
    const payload = await buildEdgePayload(s, { ipMap: await edgeIpMap(), mainIpList: await mainIps() });
    edgeDesired.set(s.id, payload.hash);
    if (!force && s.edgeSync?.hash === payload.hash && !s.edgeSync?.error) return { skipped: true, hash: payload.hash };
    edgePushed.set(s.id, { hash: payload.hash, at: Date.now() });
    edgeInflightHash.set(s.id, payload.hash);
    const what = payload.edge
      ? `edge: ${Object.keys(payload.edge.files).length} nginx file(s), ${payload.edge.connectors.length} connector(s), ${payload.edge.shims.length} shim(s)`
      : "not an edge";
    console.log(`[cluster] cluster.sync → ${s.name} (${s.id}) ${payload.hash.slice(0, 12)} · ${what} · ${payload.allowFrom.length} allowed IP(s)`);
    log(`Sending the cluster configuration to ${s.name} (${what}; ${payload.allowFrom.length} peer address(es) allowed to reach its websites)…`);
    let recorded = false;
    try {
      const raw = await runTask(s.id, "cluster.sync", payload, { log, signal });
      const r = cleanSyncResult(raw);
      recordEdgeSync(s.id, { hash: r.hash || payload.hash, appliedAt: r.appliedAt || nowIso(), error: r.error });
      recorded = true;
      if (r.error) throw Object.assign(new Error(`${s.name} could not apply the edge configuration: ${r.error}`), { result: r });
      log(`${s.name} applied configuration ${payload.hash.slice(0, 12)}.`);
      return r;
    } catch (err) {
      if (!recorded) {
        const r = err.result ? cleanSyncResult(err.result) : null;
        // The agent ran it and failed: that hash was attempted (retried by the 10 min resend or "Sync now").
        if (r?.hash) recordEdgeSync(s.id, { hash: r.hash, appliedAt: r.appliedAt, error: r.error || err.message });
        // Never reached / lost the agent: keep the old hash so the next round tries again.
        else recordEdgeSync(s.id, { hash: s.edgeSync?.hash || null, appliedAt: s.edgeSync?.appliedAt || null, error: err.message });
      }
      throw err;
    } finally {
      if (edgeInflightHash.get(s.id) === payload.hash) edgeInflightHash.delete(s.id);
    }
  }

  /** One push at a time per server; a newer request runs after the current one (and is skipped if nothing changed). */
  function pushEdge(serverId, opts = {}) {
    const prev = edgeInflight.get(serverId) || Promise.resolve();
    edgeQueued.add(serverId);
    const p = prev.catch(() => {}).then(() => {
      edgeQueued.delete(serverId);
      return pushEdgeOnce(serverId, opts);
    });
    edgeInflight.set(serverId, p);
    p.catch(() => {}).finally(() => {
      if (edgeInflight.get(serverId) === p) edgeInflight.delete(serverId);
    });
    return p;
  }

  /**
   * Main's half: main's local static/php vhosts and ufw must let the edges'
   * nginx reach main's site ports, and auth must believe the edges' shims.
   * Runs when the edge IP set changes (and once at start, to clean up).
   */
  async function applyMainEdges(ips) {
    const log = (l) => console.log(`[cluster] main edge access: ${l}`);
    setTrustedProxies(ips);
    if (typeof sharedTasks.refreshLocalVhosts === "function") {
      const specs = [];
      for (const site of allSites()) {
        if (!["static", "php"].includes(site.type) || !siteTargets(site).includes(MAIN_ID)) continue;
        try {
          const spec = ctx.sites?.specFor?.(site, MAIN_ID);
          if (spec) specs.push(spec);
        } catch (err) {
          console.warn(`[cluster] spec for ${site.id}:`, err.message);
        }
      }
      try {
        await sharedTasks.refreshLocalVhosts(specs, { log, dataDir: ctx.dataDir, isMain: true, serverId: MAIN_ID, edgeAllow: ips.slice() });
      } catch (err) {
        console.warn("[cluster] could not refresh main's local vhosts for the edge nodes:", err.message);
      }
    } else if (ips.length) {
      console.warn("[cluster] shared/tasks.mjs has no refreshLocalVhosts yet — main's static/php vhosts are not opened to edge nodes.");
    }
    await mainUfw(ips, log).catch((err) => console.warn("[cluster] ufw on main:", err.message));
  }

  /** ufw on main (when active): allow 3000:3999 from each edge IP, drop our rules for IPs no longer edges. */
  async function mainUfw(ips, log) {
    if (process.env.FCC_SKIP_UFW === "1") return;
    let existing = [];
    if (!sys.DRY_RUN) {
      if (!sys.which("ufw")) return;
      const st = await sys.run("ufw", ["status"], { allowFail: true, timeoutMs: 20_000 });
      if (st.code !== 0 || !/^Status:\s*active/im.test(st.stdout)) return;
      const re = new RegExp(`^${EDGE_UFW_PORTS}/tcp(?: \\(v6\\))?\\s+ALLOW(?: IN)?\\s+(\\S+).*#\\s*${EDGE_UFW_COMMENT}\\s*$`, "i");
      existing = [...new Set(st.stdout.split("\n").map((l) => re.exec(l.trim())?.[1]).filter((ip) => ip && net.isIP(ip)))];
    }
    const want = new Set(ips);
    for (const ip of ips) {
      if (existing.includes(ip)) continue;
      await sys.run("ufw", ["allow", "from", ip, "to", "any", "port", EDGE_UFW_PORTS, "proto", "tcp", "comment", EDGE_UFW_COMMENT], { log, allowFail: true, timeoutMs: 20_000 });
    }
    for (const ip of existing) {
      if (want.has(ip)) continue;
      await sys.run("ufw", ["delete", "allow", "from", ip, "to", "any", "port", EDGE_UFW_PORTS, "proto", "tcp"], { log, allowFail: true, timeoutMs: 20_000 });
    }
  }

  let roundChain = Promise.resolve();
  /**
   * Recompute every agent's payload; push where it changed, where `forced`, or
   * (resend) where the last push is older than 10 min. Also keeps main's side
   * and the trusted proxies in step with the edge IP set.
   */
  function edgeRound(opts) {
    const p = roundChain.catch(() => {}).then(() => edgeRoundOnce(opts));
    roundChain = p.catch(() => {});
    return p;
  }
  async function edgeRoundOnce({ forced = new Set(), resend = false } = {}) {
    {
      const ipMap = await edgeIpMap();
      const flat = [...new Set([...ipMap.values()].flat())].sort();
      const key = JSON.stringify(flat);
      if (key !== edgeIpKey) {
        const first = edgeIpKey === null;
        edgeIpKey = key;
        edgeIpList = flat;
        if (!first) console.log(`[cluster] edge node addresses now: ${flat.join(", ") || "(none)"}`);
        await applyMainEdges(flat);
      }
      if (!syncSupported()) return;
      const mainIpList = await mainIps();
      for (const s of db.list("servers")) {
        if (s.id === MAIN_ID) continue;
        let payload;
        try {
          payload = await buildEdgePayload(s, { ipMap, mainIpList });
        } catch (err) {
          console.warn(`[cluster] edge payload for ${s.name}:`, err.message);
          continue;
        }
        edgeDesired.set(s.id, payload.hash);
        if (!isOnline(s.id)) continue;
        if (!versionAtLeast(s.agentVersion, EDGE_MIN_AGENT)) {
          if (edgeOldAgentNoted.get(s.id) !== s.agentVersion) {
            edgeOldAgentNoted.set(s.id, s.agentVersion);
            console.log(`[cluster] ${s.name} (${s.id}) runs agent v${s.agentVersion || "?"} — no cluster.sync until it updates to v${EDGE_MIN_AGENT}+`);
          }
          continue;
        }
        if (edgeInflightHash.get(s.id) === payload.hash) continue;
        // One already waits behind the running push; it rebuilds the payload when its turn comes.
        if (edgeQueued.has(s.id)) continue;
        const pushed = edgePushed.get(s.id);
        const lastAt = Math.max(pushed?.at || 0, Date.parse(s.edgeSync?.appliedAt || "") || 0);
        const reported = edgeStatus.get(s.id);
        const differs = s.edgeSync?.hash !== payload.hash;
        // The agent says it runs something else (it lost its state): resend, at most every 2 min.
        const drifted = reported?.hash && reported.hash !== payload.hash && Date.now() - (pushed?.at || 0) > 2 * MINUTE;
        const due = resend && Date.now() - lastAt > EDGE_RESEND_MS;
        if (!(forced.has(s.id) || differs || drifted || due)) continue;
        // Only "it differs" may be dropped when its turn comes and the agent has meanwhile applied it.
        pushEdge(s.id, { force: forced.has(s.id) || !!drifted || due }).catch((err) => console.warn(`[cluster] cluster.sync on ${s.name} failed: ${err.message}`));
      }
    }
  }

  /** Something that goes into the edge payloads changed: re-check every agent in 2 s. */
  function edgesChanged(forceServerId = null) {
    if (forceServerId) edgeForce.add(forceServerId);
    if (!started || edgeTimer) return;
    edgeTimer = setTimeout(() => {
      edgeTimer = null;
      const forced = new Set(edgeForce);
      edgeForce.clear();
      edgeRound({ forced }).catch((err) => console.warn("[cluster] edge sync round:", err.message));
    }, EDGE_DEBOUNCE_MS);
    edgeTimer.unref?.();
  }

  /** Sanitise the `edge` object an agent sends with its metrics. */
  function cleanEdgeReport(e) {
    if (!e || typeof e !== "object") return null;
    const str = (v, n) => (v == null ? null : String(v).slice(0, n));
    return {
      hash: /^[a-f0-9]{64}$/.test(String(e.hash || "")) ? e.hash : null,
      appliedAt: str(e.appliedAt, 40),
      error: str(e.error, 2000),
      nginx: !!e.nginx,
      connectors: (Array.isArray(e.connectors) ? e.connectors : []).slice(0, 50).map((c) => ({
        id: str(c?.id, 60),
        active: !!c?.active,
        readyConnections: Math.max(0, Math.min(1000, Number(c?.readyConnections) || 0)),
      })),
      shims: (Array.isArray(e.shims) ? e.shims : []).slice(0, 20).map((x) => ({
        name: str(x?.name, 40),
        listenPort: Number(x?.listenPort) || null,
        ok: !!x?.ok,
        error: str(x?.error, 300),
      })),
    };
  }

  function ingestEdgeReport(s, edge) {
    const next = cleanEdgeReport(edge);
    const prev = edgeStatus.get(s.id) || null;
    const changed = JSON.stringify(next) !== JSON.stringify(prev ? { ...prev, reportedAt: undefined } : null);
    if (next) edgeStatus.set(s.id, { ...next, reportedAt: nowIso() });
    else edgeStatus.delete(s.id);
    if (changed) {
      try {
        ctx.events?.broadcast("server", publicServer(db.get("servers", s.id)));
      } catch {
        /* no SSE yet */
      }
    }
  }

  /** GET /api/servers edgeStatus: null for main and for servers that are not (and do not report being) an edge. */
  function publicEdgeStatus(s) {
    if (!s || s.id === MAIN_ID) return null;
    const r = edgeStatus.get(s.id) || null;
    if (!isEdge(s) && !r) return null;
    const desired = edgeDesired.get(s.id) || null;
    const appliedHash = r?.hash || s.edgeSync?.hash || null;
    const error = r?.error || s.edgeSync?.error || null;
    return {
      inSync: !!desired && appliedHash === desired && !error,
      hash: desired,
      appliedHash,
      appliedAt: r?.appliedAt || s.edgeSync?.appliedAt || null,
      applying: edgeInflightHash.has(s.id),
      error,
      nginx: r ? r.nginx : null,
      connectors: (r?.connectors || []).map((c) => ({ id: c.id, name: edgeConnectorNames.get(c.id) || c.id, active: c.active, readyConnections: c.readyConnections })),
      shims: r?.shims || [],
      reportedAt: r?.reportedAt || null,
    };
  }

  /** Where connector `connectorId` runs on edge nodes (cloudflare.mjs adds main's own). */
  function edgeReplicas(connectorId) {
    const out = [];
    for (const s of db.list("servers")) {
      if (!isEdge(s)) continue;
      const online = isOnline(s.id);
      const r = edgeStatus.get(s.id);
      const c = r?.connectors?.find((x) => x.id === connectorId);
      out.push({
        serverId: s.id,
        serverName: s.name,
        running: online && !!c?.active,
        connections: online && c ? c.readyConnections : 0,
        online,
        reportedAt: r?.reportedAt || null,
      });
    }
    return out.sort((a, b) => String(a.serverName).localeCompare(String(b.serverName)));
  }

  /** GET /api/cluster/ha — how much of the front door survives main going down. */
  function haSummary() {
    const edgesList = db
      .list("servers")
      .filter(isEdge)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const edges = edgesList.map((s) => {
      const st = publicEdgeStatus(s);
      const online = isOnline(s.id);
      return {
        serverId: s.id,
        name: s.name,
        online,
        inSync: !!st?.inSync,
        tunnelConnected: online && !!st?.connectors?.some((c) => c.active && c.readyConnections > 0),
        applying: !!st?.applying,
        error: st?.error || null,
        agentVersion: s.agentVersion || null,
      };
    });
    let connectorsN = 0;
    let mainConnected = false;
    try {
      const cf = ctx.cloudflare?.status?.();
      const list = Array.isArray(cf?.connectors) ? cf.connectors : [];
      connectorsN = list.filter((c) => c.autoStart !== false && c.hasToken).length;
      mainConnected = list.some((c) => c.connected);
    } catch {
      /* no Cloudflare module */
    }
    const mainOnlySites = allSites()
      .filter((site) => {
        const t = [...new Set(siteTargets(site))];
        return t.length === 1 && t[0] === MAIN_ID;
      })
      .map((site) => ({ id: site.id, name: site.name }));

    const warnings = [];
    const tunnel = connectorsN === 1 ? "The Cloudflare Tunnel" : "The Cloudflare Tunnels";
    if (edges.length && !syncSupported()) {
      warnings.push("This panel's task engine does not include cluster.sync yet, so edge nodes cannot be configured. Update the panel.");
    }
    if (connectorsN && !edges.length) {
      warnings.push(`${tunnel} ${connectorsN === 1 ? "runs" : "run"} only on the main server. Mark an agent server as an edge node so tunnelled websites stay up if the main server goes down.`);
    } else if (connectorsN && !edges.some((e) => e.tunnelConnected)) {
      warnings.push(`No edge node has a connected Cloudflare Tunnel replica right now — if the main server goes down, every tunnelled website goes down with it.`);
    }
    if (!connectorsN && edges.length) {
      warnings.push("Edge nodes are set up, but the panel runs no Cloudflare Tunnel connector. Failover only covers tunnelled websites — domains on direct DNS still point at the main server.");
    }
    for (const e of edges) {
      const s = db.get("servers", e.serverId);
      if (!e.online) {
        const ago = lastSeenMs(e.serverId);
        warnings.push(`${e.name} is an edge node, but its agent is offline${ago ? ` (last seen ${new Date(ago).toISOString().replace("T", " ").slice(0, 16)} UTC)` : " and has never checked in"}.`);
      } else if (!versionAtLeast(s?.agentVersion, EDGE_MIN_AGENT)) {
        warnings.push(`${e.name} runs agent v${s?.agentVersion || "?"} — edge nodes need v${EDGE_MIN_AGENT} or newer. It updates itself the next time it reconnects.`);
      } else if (e.error) {
        warnings.push(`${e.name} could not apply the edge configuration: ${e.error}`);
      } else if (!e.inSync) {
        warnings.push(e.applying ? `${e.name} is applying the latest edge configuration.` : `${e.name} has not applied the latest edge configuration yet. Use “Sync now” on the server if it stays this way.`);
      } else if (connectorsN && !e.tunnelConnected) {
        warnings.push(`${e.name} is in sync, but its Cloudflare Tunnel replica is not connected.`);
      }
    }
    if (edges.length && mainOnlySites.length) {
      const names = mainOnlySites.slice(0, 5).map((x) => x.name).join(", ") + (mainOnlySites.length > 5 ? ` and ${mainOnlySites.length - 5} more` : "");
      warnings.push(
        `${mainOnlySites.length === 1 ? "1 website runs" : `${mainOnlySites.length} websites run`} only on the main server and go${mainOnlySites.length === 1 ? "es" : ""} down with it: ${names}. Load balance ${mainOnlySites.length === 1 ? "it" : "them"} across servers to keep ${mainOnlySites.length === 1 ? "it" : "them"} up.`,
      );
    }
    return {
      edges,
      tunnelReplicasOnline: (mainConnected ? 1 : 0) + edges.filter((e) => e.tunnelConnected).length,
      connectors: connectorsN,
      mainOnlySites,
      warnings,
    };
  }

  /** Resolved edge IPs (as last applied on main). */
  const edgeIps = () => edgeIpList.slice();

  // ------------------------------------------------------------- routes

  function requireServer(id) {
    const s = db.get("servers", id);
    if (!s) throw httpError(404, "Server not found");
    return s;
  }

  function cleanPatch(body, { creating = false, isMain = false } = {}) {
    const patch = {};
    if (body.name !== undefined || creating) {
      const name = String(body.name ?? "").trim();
      if (!name || name.length > 80) throw httpError(400, "Give the server a name (up to 80 characters).");
      patch.name = name;
    }
    if (body.host !== undefined || creating) {
      const host = String(body.host ?? "").trim();
      if (!validHost(host)) throw httpError(400, "Enter the server's IP address or hostname.");
      patch.host = host;
    }
    if (body.privateHost !== undefined) {
      const ph = body.privateHost == null ? "" : String(body.privateHost).trim();
      if (ph && !validHost(ph)) throw httpError(400, "The private address must be an IP address or hostname.");
      patch.privateHost = ph || null;
    }
    if (body.weight !== undefined) {
      const w = Number(body.weight);
      if (!Number.isInteger(w) || w < 1 || w > 100) throw httpError(400, "Weight must be a whole number from 1 to 100.");
      patch.weight = w;
    } else if (creating) patch.weight = 1;
    if (body.enabled !== undefined) {
      if (isMain && body.enabled === false) throw httpError(400, "The main server cannot be disabled.");
      patch.enabled = !!body.enabled;
    } else if (creating) patch.enabled = true;
    if (body.lbEligible !== undefined) patch.lbEligible = !!body.lbEligible;
    else if (creating) patch.lbEligible = true;
    if (body.edge !== undefined) {
      if (isMain) throw httpError(400, "The main server is always an edge node — there is nothing to switch.");
      if (typeof body.edge !== "boolean") throw httpError(400, "Edge node must be true or false.");
      patch.edge = { enabled: body.edge };
    } else if (creating) patch.edge = { enabled: false };
    return patch;
  }

  function routes(router) {
    // --------------------------------------------------- admin API
    router.get("/api/servers", () => ({ items: listServers() }));

    router.post("/api/servers", (req, res, { body, admin }) => {
      const patch = cleanPatch(body, { creating: true });
      if (db.list("servers").some((s) => s.host === patch.host)) {
        throw httpError(409, `A server with the address ${patch.host} already exists.`);
      }
      const token = newToken();
      const server = db.insert("servers", {
        id: db.newId("srv"),
        role: "worker",
        privateHost: null,
        ...patch,
        tokenHash: sha256(token),
        agentVersion: null,
        lastSeenAt: null,
        info: null,
      });
      db.save({ immediate: true });
      ctx.activity?.(admin, "server.create", { type: "server", id: server.id, name: server.name }, { host: server.host, edge: !!server.edge?.enabled });
      serversChanged("created", server.id);
      return {
        server: publicServer(server),
        installCommand: installCommand(req, server.id, token),
        warning: installWarning(req),
      };
    });

    router.get("/api/servers/:id", (req, res, { params }) => {
      const s = requireServer(params.id);
      const out = publicServer(s);
      out.sites = allSites()
        .filter((site) => siteTargets(site).includes(s.id))
        .map((site) => ({ id: site.id, name: site.name, projectId: site.projectId, loadBalanced: !!site.loadBalanced, port: site.port }));
      return out;
    });

    router.patch("/api/servers/:id", (req, res, { params, body, admin }) => {
      const s = requireServer(params.id);
      const isMain = s.id === MAIN_ID;
      const patch = cleanPatch(body, { isMain });
      if (patch.host && db.list("servers").some((o) => o.id !== s.id && o.host === patch.host)) {
        throw httpError(409, `A server with the address ${patch.host} already exists.`);
      }
      const wasEdge = !!s.edge?.enabled;
      const updated = db.update("servers", s.id, patch);
      const details = { fields: Object.keys(patch) };
      if (patch.edge) details.edge = patch.edge.enabled;
      ctx.activity?.(admin, "server.update", { type: "server", id: s.id, name: updated.name }, details);
      if (patch.edge && patch.edge.enabled !== wasEdge) {
        console.log(`[cluster] ${updated.name} (${s.id}) is ${patch.edge.enabled ? "now an edge node" : "no longer an edge node"}`);
        edgesChanged(s.id); // push right away (debounced), even if its hash happened to match
      }
      serversChanged("updated", s.id);
      return publicServer(updated);
    });

    router.delete("/api/servers/:id", (req, res, { params, admin }) => {
      const s = requireServer(params.id);
      if (s.id === MAIN_ID) throw httpError(400, "The main server cannot be removed.");
      const using = allSites().filter((site) => siteTargets(site).includes(s.id));
      if (using.length) {
        throw httpError(409, `Move or delete the websites on this server first: ${using.map((x) => x.name).join(", ")}.`, {
          sites: using.map((x) => ({ id: x.id, name: x.name })),
        });
      }
      for (const t of [...tasks.values()]) if (t.serverId === s.id) t.settle(new Error(`${s.name} was removed.`));
      kick(s.id);
      db.remove("servers", s.id);
      db.save({ immediate: true });
      seen.delete(s.id);
      latest.delete(s.id);
      series.delete(s.id);
      reqSeries.delete(`srv:${s.id}`);
      onlineWas.delete(s.id);
      edgeStatus.delete(s.id);
      edgeDesired.delete(s.id);
      edgePushed.delete(s.id);
      edgeOldAgentNoted.delete(s.id);
      ctx.activity?.(admin, "server.delete", { type: "server", id: s.id, name: s.name });
      serversChanged("deleted", s.id);
      return { ok: true };
    });

    router.post("/api/servers/:id/token", (req, res, { params, admin }) => {
      const s = requireServer(params.id);
      if (s.id === MAIN_ID) throw httpError(400, "The main server has no agent token.");
      const token = newToken();
      db.update("servers", s.id, { tokenHash: sha256(token) });
      db.save({ immediate: true });
      ctx.activity?.(admin, "server.token.rotate", { type: "server", id: s.id, name: s.name });
      kick(s.id); // its parked poll is answered; the next one fails with the old token
      serversChanged("token", s.id);
      return { installCommand: installCommand(req, s.id, token), warning: installWarning(req) };
    });

    router.post("/api/servers/:id/edge/sync", (req, res, { params, admin }) => {
      const s = requireServer(params.id);
      if (s.id === MAIN_ID) throw httpError(400, "The main server applies its edge configuration itself — there is nothing to send it.");
      const blocked = edgePushBlocker(s);
      if (blocked) throw httpError(409, blocked);
      const job = ctx.jobs.start(
        { type: "server.edge.sync", title: `Sync ${isEdge(s) ? "edge" : "cluster"} configuration to ${s.name}`, serverId: s.id, adminId: admin?.id, lock: false },
        ({ log, signal }) => pushEdge(s.id, { force: true, log, signal }),
      );
      ctx.activity?.(admin, "server.edge.sync", { type: "server", id: s.id, name: s.name }, { edge: isEdge(s) });
      return job;
    });

    router.get("/api/cluster/ha", () => haSummary());

    router.get("/api/servers/:id/metrics", (req, res, { params, query }) => {
      const s = requireServer(params.id);
      const range = ["1h", "6h", "24h"].includes(query.range) ? query.range : "1h";
      const m = metrics({ range });
      return {
        serverId: s.id,
        range,
        step: m.step,
        from: m.from,
        to: m.to,
        latest: latestMetrics(s.id),
        points: m.servers[s.id] || [],
        requests: m.perServer[s.id] || denseRequests([], m.from, m.to, m.step),
      };
    });

    // --------------------------------------------------- installer
    router.get("/install/node.sh", { public: true }, async (req, res, { query }) => {
      const s = authByQuery(query);
      const shell = (code, msg) =>
        send(res, code, `#!/bin/sh\necho "${msg}" >&2\nexit 1\n`, { "Content-Type": "text/x-shellscript; charset=utf-8" });
      if (!s) return shell(401, "Forthway: unknown server or invalid token. Copy a fresh install command from Settings > Servers.");
      const base = ctx.panelUrl(req);
      if (!/^https?:\/\/[A-Za-z0-9.\-:[\]]+(\/[\w.\-/]*)?$/.test(base)) return shell(500, "Forthway: the panel URL is not usable. Set it in Settings.");
      let tpl;
      try {
        tpl = fs.readFileSync(path.join(ctx.rootDir, "panel", "templates", "node-install.sh"), "utf8");
      } catch {
        return shell(500, "Forthway: the installer template is missing on the panel.");
      }
      const ips = await mainIps();
      const script = tpl
        .replaceAll("@@PANEL_URL@@", base)
        .replaceAll("@@SERVER_ID@@", s.id)
        .replaceAll("@@SERVER_TOKEN@@", String(query.token).replace(/[^A-Za-z0-9_-]/g, ""))
        .replaceAll("@@SERVER_NAME@@", String(s.name).replace(/[^\w .()-]/g, ""))
        .replaceAll("@@MAIN_IPS@@", ips.join(" "))
        .replaceAll("@@PANEL_VERSION@@", String(ctx.version || ""))
        .replaceAll("@@AGENT_FILES@@", [...agentFiles().keys()].join(" "));
      return send(res, 200, script, { "Content-Type": "text/x-shellscript; charset=utf-8" });
    });

    router.get("/install/files/*", { public: true }, (req, res, { params, query }) => {
      const s = authByQuery(query) || authenticateNode(req);
      if (!s) return send(res, 401, "unauthorized\n", { "Content-Type": "text/plain; charset=utf-8" });
      const files = agentFiles();
      const rel = String(params.rest || "");
      if (rel === "" || rel === "manifest") {
        const text = [...files].map(([f, h]) => `${h}  ${f}`).join("\n") + "\n";
        return send(res, 200, text, { "Content-Type": "text/plain; charset=utf-8" });
      }
      if (!files.has(rel)) return send(res, 404, "not found\n", { "Content-Type": "text/plain; charset=utf-8" });
      const buf = fs.readFileSync(path.join(ctx.rootDir, rel));
      return send(res, 200, buf, { "Content-Type": "text/javascript; charset=utf-8", "X-FCC-Sha256": files.get(rel) });
    });

    // --------------------------------------------------- agent protocol
    const node = (req) => {
      const s = authenticateNode(req);
      if (!s) throw httpError(401, "Unknown server or invalid token.");
      touch(s);
      return s;
    };

    router.post("/agent/hello", { agent: true, limit: 256 * 1024 }, (req, res, { body }) => {
      const s = node(req);
      const info = body.info && typeof body.info === "object" ? body.info : null;
      const patch = { agentVersion: String(body.agentVersion || "").slice(0, 40) || null, lastSeenAt: nowIso() };
      if (info) {
        patch.info = {
          hostname: String(info.hostname || "").slice(0, 120),
          os: String(info.os || "").slice(0, 120),
          arch: String(info.arch || "").slice(0, 20),
          cpus: Number(info.cpus) || null,
          cpuModel: String(info.cpuModel || "").slice(0, 120) || null,
          memTotal: Number(info.memTotal) || null,
          diskTotal: Number(info.diskTotal) || null,
          node: String(info.node || "").slice(0, 20),
        };
      }
      db.update("servers", s.id, patch);
      const have = body.files && typeof body.files === "object" ? body.files : {};
      const update = [];
      for (const [rel, h] of agentFiles()) if (have[rel] !== h) update.push(rel);
      if (body.files && !update.length) currentAt.set(s.id, filesDigest());
      else currentAt.delete(s.id);
      console.log(`[cluster] agent hello from ${s.name} (${s.id}) v${patch.agentVersion || "?"}${update.length ? ` — ${update.length} file(s) to update` : ""}`);
      serversChanged("hello", s.id);
      checkOnline();
      edgesChanged(s.id); // (re)connected: make sure it runs the current cluster configuration
      return {
        serverId: s.id,
        name: s.name,
        panelVersion: ctx.version,
        pollWaitMs: POLL_WAIT_MS,
        metricsIntervalMs: METRICS_INTERVAL_MS,
        update: body.files ? update : [],
      };
    });

    router.get("/agent/poll", { agent: true }, (req, res, { query }) => {
      const s = node(req);
      const running = new Set(String(query.running || "").split(",").filter(Boolean));
      reconcile(s.id, running);
      // Out of date and idle: have it reconnect (which updates it) before it
      // takes any work. Newer agents understand `rehello`; older ones only
      // reconnect after a 401, which they wait 60s on — once.
      const staleReply = () => {
        if (running.size || !agentIsStale(s.id)) return null;
        console.log(`[cluster] ${s.name} (${s.id}) is running older agent files — asking it to reconnect and update`);
        if (query.v) return { tasks: [], cancel: [], rehello: true };
        throw httpError(401, "This agent is out of date — reconnect to fetch the panel's newer files.");
      };
      const stale = staleReply();
      if (stale) return stale;
      const first = takeWork(s.id);
      if (first.tasks.length || first.cancel.length) return first;
      const wait = Math.max(0, Math.min(POLL_WAIT_MS, Number(query.wait) * 1000 || POLL_WAIT_MS));
      // Only one parked poll per server; a newer one replaces it.
      parked.get(s.id)?.finish(true);
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (empty = false) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (parked.get(s.id)?.finish === finish) parked.delete(s.id);
          if (empty) return resolve({ tasks: [], cancel: [] });
          // The panel's files can change while this poll is parked: check
          // again, so work that arrives now still waits for the update.
          try {
            resolve(staleReply() || takeWork(s.id));
          } catch (err) {
            reject(err);
          }
        };
        const timer = setTimeout(() => finish(true), wait);
        parked.set(s.id, { finish });
        req.on("close", () => {
          if (!res.writableEnded && !settled) {
            settled = true;
            clearTimeout(timer);
            if (parked.get(s.id)?.finish === finish) parked.delete(s.id);
            resolve(undefined);
          }
        });
      });
    });

    router.post("/agent/tasks/:id/log", { agent: true, limit: 2 * 1024 * 1024 }, (req, res, { params, body }) => {
      const s = node(req);
      const t = tasks.get(params.id);
      if (!t || t.serverId !== s.id) throw httpError(404, "Unknown task", { cancel: false });
      t.lastActivity = Date.now();
      const lines = Array.isArray(body.lines) ? body.lines : [];
      for (const l of lines.slice(0, 5000)) {
        try {
          t.log(String(l).slice(0, 4000));
        } catch {
          /* a broken log sink must not fail the agent */
        }
      }
      return { ok: true, cancel: !!t.cancelRequested };
    });

    router.post("/agent/tasks/:id/result", { agent: true, limit: 20 * 1024 * 1024 }, (req, res, { params, body }) => {
      const s = node(req);
      const t = tasks.get(params.id);
      if (!t || t.serverId !== s.id) throw httpError(404, "Unknown task");
      if (body.ok) t.settle(null, body.result ?? null);
      else {
        const err = new Error(String(body.error || "The task failed on the agent."));
        if (body.aborted || t.cancelRequested) err.aborted = true;
        if (body.result) err.result = body.result;
        t.settle(err);
      }
      return { ok: true };
    });

    router.post("/agent/metrics", { agent: true, limit: 256 * 1024 }, (req, res, { body }) => {
      const s = node(req);
      const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      recordSample(s.id, {
        cpu: n(body.cpu),
        mem: n(body.mem),
        memTotal: n(body.memTotal),
        disk: n(body.disk),
        diskTotal: n(body.diskTotal),
        load: n(body.load),
        uptime: n(body.uptime),
      });
      if (body.edge !== undefined) ingestEdgeReport(s, body.edge);
      return { ok: true };
    });

    // An edge's nginx access log lines (the agent tails fcc-<siteId>.access.log
    // every 15 s). Counted exactly like main's own, with 127.0.0.1 upstreams
    // meaning that edge. Only for websites that exist, only from edge nodes.
    router.post("/agent/edge/logs", { agent: true, limit: EDGE_LOG_LIMIT }, (req, res, { body }) => {
      const s = node(req);
      if (!isEdge(db.get("servers", s.id))) return { ok: true, accepted: 0, ignored: "This server is not an edge node." };
      const sites = body?.sites && typeof body.sites === "object" && !Array.isArray(body.sites) ? body.sites : {};
      const byId = new Map(allSites().map((x) => [x.id, x]));
      const byAddr = upstreamMap(s.id);
      let accepted = 0;
      for (const [siteId, lines] of Object.entries(sites).slice(0, 5000)) {
        const site = byId.get(siteId);
        if (!site || !Array.isArray(lines)) continue;
        const clean = lines
          .slice(0, 50_000)
          .filter((l) => typeof l === "string" && l.trim())
          .map((l) => l.slice(0, 16_384));
        ingestLines(site, clean, byAddr);
        accepted += clean.length;
      }
      return { ok: true, accepted };
    });

    router.post("/agent/upload/:taskId", { agent: true, raw: true }, async (req, res, { params }) => {
      const s = node(req);
      const t = tasks.get(params.taskId);
      // A packaged build (site.deploy with payload.package) lands where the
      // panel asked for it — releases/<releaseId>-built.zip — never at a path
      // the agent chooses. Only once per task.
      const isBuild = t?.type === "site.deploy" && !!t.payload?.package && !t.uploaded;
      if (!t || t.serverId !== s.id || !(t.type === "server.backup" || isBuild) || t.status !== "sent") {
        throw httpError(404, "No task is waiting for this upload.");
      }
      const max = Number(ctx.config?.cluster?.maxUploadBytes) || DEFAULT_MAX_UPLOAD;
      const declared = Number(req.headers["content-length"]);
      if (declared && declared > max) throw httpError(413, `The archive is larger than the ${Math.round(max / 1024 ** 3)} GB limit.`);

      let dir;
      let name;
      if (isBuild) {
        const rid = String(t.payload.package.releaseId || "");
        if (!/^[\w-]{1,80}$/.test(rid)) throw httpError(400, "The task does not name a valid release for the packaged build.");
        dir = path.join(ctx.dataDir, "releases");
        name = `${rid}.zip`;
      } else {
        dir = path.join(ctx.dataDir, "backups");
        const wanted = t.payload.file ? path.basename(String(t.payload.file)) : "";
        name = /^[\w.-]+\.tar\.gz$/.test(wanted)
          ? wanted
          : `server-${s.id}-${new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "")}.tar.gz`;
      }
      fs.mkdirSync(dir, { recursive: true });
      const final = path.join(dir, name);
      const part = path.join(dir, `.upload-${t.id}.part`);
      const hash = crypto.createHash("sha256");
      let size = 0;
      const out = fs.createWriteStream(part, { mode: 0o600 });
      try {
        await new Promise((resolve, reject) => {
          req.on("data", (chunk) => {
            size += chunk.length;
            t.lastActivity = Date.now();
            seen.set(s.id, Date.now());
            if (size > max) {
              req.destroy();
              return reject(httpError(413, "The archive is larger than the upload limit."));
            }
            hash.update(chunk);
            if (!out.write(chunk)) {
              req.pause();
              out.once("drain", () => req.resume());
            }
          });
          req.on("end", resolve);
          req.on("error", reject);
          req.on("aborted", () => reject(new Error("The upload was interrupted.")));
          out.on("error", reject);
        });
        await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      } catch (err) {
        out.destroy();
        fs.rmSync(part, { force: true });
        throw err;
      }
      const digest = hash.digest("hex");
      const claimed = String(req.headers["x-fcc-sha256"] || "");
      if (claimed && claimed !== digest) {
        fs.rmSync(part, { force: true });
        throw httpError(400, "The uploaded archive does not match its checksum.");
      }
      fs.renameSync(part, final);
      t.uploaded = { file: final, size, sha256: digest };
      t.log(`Received the archive on the panel: ${final} (${(size / 1048576).toFixed(1)} MB).`);
      return t.uploaded;
    });
  }

  // ------------------------------------------------------- lifecycle

  async function _start() {
    ensureMain();
    loadMetrics();
    for (const s of db.list("servers")) onlineWas.set(s.id, isOnline(s.id));
    await sampleMain();
    const every = (ms, fn) => {
      const t = setInterval(() => {
        try {
          const r = fn();
          if (r?.catch) r.catch((err) => console.warn("[cluster] timer:", err.message));
        } catch (err) {
          console.warn("[cluster] timer:", err.message);
        }
      }, ms);
      t.unref?.();
      timers.push(t);
    };
    every(METRICS_INTERVAL_MS, sampleMain);
    every(15_000, tailAccessLogs);
    every(5_000, () => {
      checkOnline();
      sweepTasks();
    });
    every(2 * MINUTE, saveMetrics);
    // Edge nodes: payloads follow every change to servers (and agents coming online).
    on("servers-changed", (e) => {
      if (e?.reason === "online" && e.serverId) return edgesChanged(e.serverId);
      if (e?.reason === "hello") return; // the hello route already asked for a forced push
      edgesChanged();
    });
    started = true;
    every(EDGE_RECONCILE_MS, () => edgeRound({ resend: true }));
    // First round once loadbalancer.mjs has rendered (its initial apply runs at +3 s).
    const firstEdge = setTimeout(() => edgeRound({ resend: true }).catch((err) => console.warn("[cluster] edge sync round:", err.message)), 5_000);
    firstEdge.unref?.();
    timers.push(firstEdge);
    if (!syncSupported()) console.warn("[cluster] shared/tasks.mjs has no cluster.sync task yet — edge nodes are not configured until it does.");
  }

  async function _stop() {
    started = false;
    if (edgeTimer) clearTimeout(edgeTimer);
    for (const t of timers) clearInterval(t);
    for (const p of [...parked.values()]) p.finish(true);
    saveMetrics();
  }

  ensureMain();

  return {
    MAIN_ID,
    listServers,
    getServer,
    isOnline,
    address,
    runTask,
    authenticateNode,
    metrics,
    latestMetrics,
    on,
    off: (event, fn) => listeners.get(event)?.delete(fn),
    // extras (documented under "Changes")
    agentFiles: () => Object.fromEntries(agentFiles()),
    // edge nodes (docs/HA.md)
    edgesChanged: () => edgesChanged(),
    edgeReplicas,
    edgeIps,
    haSummary,
    _routes: routes,
    _start,
    _stop,
  };
}

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.internal) continue;
      if (ni.family === "IPv4" || ni.family === 4) out.push(ni.address);
    }
  }
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.internal || ni.family === "IPv4" || ni.family === 4) continue;
      if (!ni.address.startsWith("fe80")) out.push(ni.address);
    }
  }
  return out;
}
