#!/usr/bin/env node
/**
 * Forthway Command Center — Agent server agent (one per SERVER).
 *
 * Runs on every server other than the main one. It only ever dials OUT to the
 * panel — nothing on this machine needs to accept connections from it — and
 * it only executes the named task types in shared/tasks.mjs (deploy a site,
 * start/stop it, read its logs, report metrics, make a backup…). There is no
 * way for the panel to make it run an arbitrary command.
 *
 * Config: /etc/fcc-node/config.json  { panelUrl, serverId, token }
 *   (override with --config <file> or FCC_NODE_CONFIG)
 * Optional: dataDir (default /var/lib/fcc-node), maxConcurrent (default 4).
 *
 * Protocol (see panel/lib/cluster.mjs): hello → long-poll for tasks → stream
 * each task's log → post its result; metrics pushed every ~15s (with the edge
 * status when this server is an edge node, docs/HA.md, and the `mysql` status
 * when a database server is installed, Phase 3). An edge node also
 * ships its front-door access logs to POST /agent/edge/logs every 15s.
 *
 * Panel failover (docs/HA.md, Phase 2): when the hello says `ha: true` the
 * agent also learns the panel nodes (`panels`, kept in <dataDir>/panels.json),
 * runs this server's voter (shared/ha-voter.mjs, vote state in
 * <dataDir>/vote.json) and talks to the leader's directUrl when it knows it,
 * else to the next panel node, else to cfg.panelUrl — every one of them works,
 * because standbys forward to the active panel. A connection error or a
 * `503 { haSwitching: true }` moves it on to the next one; after a switch it
 * says hello again before polling.
 *
 * Main's embedded agent (`isMain: true` in its --config file; the panel on main
 * runs it while another server is the active panel) runs tasks with
 * isMain, never votes (main votes from its panel process) and never
 * self-updates (main's code follows the leader's).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

import { executeTask, collectMetrics, systemInfo, TASK_TYPES } from "../shared/tasks.mjs";
import { edgeStatus, edgeLogSites } from "../shared/edge.mjs";
import { createVoter, cleanPanels } from "../shared/ha-voter.mjs";
import { mysqlStatusCached } from "../shared/mysql-ha.mjs";

export const AGENT_VERSION = "3.4.0";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// ------------------------------------------------------------------ config

function loadConfig() {
  const i = process.argv.indexOf("--config");
  const file = path.resolve(i !== -1 ? process.argv[i + 1] : process.env.FCC_NODE_CONFIG || "/etc/fcc-node/config.json");
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`[fcc-node] cannot read ${file}: ${err.message}`);
    console.error("[fcc-node] add this server in the panel (Settings → Servers) and run the install command it gives you.");
    process.exit(78); // EX_CONFIG — systemd keeps retrying with RestartSec
  }
  if (!cfg.panelUrl || !cfg.serverId || !cfg.token) {
    console.error(`[fcc-node] ${file} needs panelUrl, serverId and token.`);
    process.exit(78);
  }
  cfg.panelUrl = String(cfg.panelUrl).replace(/\/+$/, "");
  cfg.dataDir = cfg.dataDir || process.env.FCC_NODE_DATA_DIR || "/var/lib/fcc-node";
  cfg.maxConcurrent = Number(cfg.maxConcurrent) || 4;
  cfg.isMain = cfg.isMain === true;
  return cfg;
}

const cfg = loadConfig();
fs.mkdirSync(cfg.dataDir, { recursive: true });

const log = (...a) => console.log(`[fcc-node] ${a.join(" ")}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ panel nodes
//
// With HA off (or a panel older than 3.8) the only address is cfg.panelUrl and
// everything behaves exactly as before.

const PANELS_FILE = path.join(cfg.dataDir, "panels.json");
const VOTE_FILE = path.join(cfg.dataDir, "vote.json");
const FAILED_COOLDOWN_MS = 30_000;

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

const haState = (() => {
  const j = readJsonFile(PANELS_FILE);
  return { on: j?.ha === true, panels: cleanPanels(j?.panels) };
})();

function savePanels() {
  try {
    writeJsonFile(PANELS_FILE, { ha: haState.on, panels: haState.panels, savedAt: new Date().toISOString() });
  } catch (err) {
    log(`could not save ${PANELS_FILE}: ${err.message}`);
  }
}

function setPanels(list, source) {
  const clean = cleanPanels(list);
  if (JSON.stringify(clean) === JSON.stringify(haState.panels)) return;
  haState.panels = clean;
  savePanels();
  log(`panel nodes (from ${source}): ${clean.map((p) => `${p.serverId}=${p.directUrl}`).join(", ") || "none"}`);
}

let voter = null;
function setHa(on) {
  const was = haState.on;
  haState.on = !!on;
  if (was !== haState.on) {
    savePanels();
    log(haState.on ? "panel failover is on." : "panel failover is off — talking to the panel address only.");
  }
  if (!haState.on) {
    voter?.stop();
    current = cfg.panelUrl;
    return;
  }
  if (cfg.isMain) return; // main votes from its own panel process, never twice
  if (!voter) {
    voter = createVoter({
      voterId: cfg.serverId,
      token: cfg.token,
      load: () => readJsonFile(VOTE_FILE),
      save: (st) => writeJsonFile(VOTE_FILE, st),
      panels: () => haState.panels,
      onPanels: (list) => setPanels(list, "vote reply"),
      log,
    });
  }
  voter.start();
}

// ------------------------------------------------------------- panel client

class PanelError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

let current = cfg.panelUrl; // the address that answered last
const failedAt = new Map(); // base -> Date.now() of its last connection failure
let needHello = false; // the agent now talks to a different panel (or a new leader): hello before the next poll
let lastLeaderKey = null;

/** Where to send the next request, best first. */
function bases() {
  const list = [];
  const add = (u) => {
    if (u && !list.includes(u)) list.push(u);
  };
  if (haState.on) add(voter?.leader()?.directUrl);
  add(current);
  if (haState.on) for (const p of haState.panels) add(p.directUrl);
  add(cfg.panelUrl);
  const cooling = (u) => Date.now() - (failedAt.get(u) || 0) < FAILED_COOLDOWN_MS;
  return [...list.filter((u) => !cooling(u)), ...list.filter(cooling)];
}

function noteOk(base) {
  failedAt.delete(base);
  if (base === current) return;
  log(`now talking to the panel through ${base}`);
  current = base;
  needHello = true;
}

function noteFail(base, err) {
  if (!failedAt.has(base)) log(`panel at ${base} is not answering (${err.message})${haState.on ? " — trying the next panel node" : ""}`);
  failedAt.set(base, Date.now());
}

/** Did the leader change since the last hello? (Votes tell us before any request fails.) */
function leaderChanged() {
  const l = haState.on ? voter?.leader() : null;
  const key = l ? `${l.serverId}@${l.directUrl}` : null;
  if (!key || key === lastLeaderKey) return false;
  const first = lastLeaderKey === null;
  lastLeaderKey = key;
  return !first || current !== l.directUrl;
}

/** A failure that means "try another panel node": no answer at all, or a standby with no leader to forward to. */
function failoverError(err) {
  if (err instanceof PanelError) return err.status === 503 && err.body?.haSwitching === true;
  return true; // network error or timeout
}

/**
 * Run `fn(base)` against the best panel address; on a failover error move on
 * to the next. `once`: only the first address (the caller retries itself).
 * Timeouts are not retried elsewhere (the request may have been processed).
 */
async function withFailover(fn, { once = false } = {}) {
  const list = bases();
  let lastErr = null;
  for (const base of once ? list.slice(0, 1) : list) {
    try {
      const r = await fn(base);
      noteOk(base);
      return r;
    } catch (err) {
      if (!failoverError(err)) {
        noteOk(base); // it answered — just not with what we wanted
        throw err;
      }
      noteFail(base, err);
      lastErr = err;
      if (err.timedOut) break;
    }
  }
  if (lastErr) lastErr.failover = true;
  throw lastErr || new Error("no panel address configured");
}

async function apiOnce(base, method, p, body, timeoutMs, outerSignal = null) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  // The caller may give up early (pollLoop: the votes show a new leader — 3.4.0).
  const onOuter = () => ctrl.abort();
  if (outerSignal?.aborted) ctrl.abort();
  else outerSignal?.addEventListener("abort", onOuter, { once: true });
  try {
    const res = await fetch(base + p, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "User-Agent": `fcc-node/${AGENT_VERSION}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not json */
    }
    if (!res.ok) throw new PanelError(res.status, json?.error || `HTTP ${res.status}`, json);
    return json;
  } catch (err) {
    if (err.name === "AbortError") {
      if (outerSignal?.aborted) {
        const e = new Error(`${method} ${p.split("?")[0]} abandoned: a new active panel was elected`);
        e.leaderMoved = true; // a failover error (not a timeout): try the new leader at once
        throw e;
      }
      const e = new Error(`${method} ${p.split("?")[0]} timed out`);
      e.timedOut = true;
      throw e;
    }
    if (!(err instanceof PanelError) && err.cause?.code) err.message = `${err.message} (${err.cause.code})`;
    throw err;
  } finally {
    clearTimeout(t);
    outerSignal?.removeEventListener("abort", onOuter);
  }
}

function api(method, p, body, { timeoutMs = 30_000, once = false, signal = null } = {}) {
  return withFailover((base) => apiOnce(base, method, p, body, timeoutMs, signal), { once });
}

/** Stream a file to the panel (backups can be many GB — never buffered). */
function uploadOnce(base, urlPath, file, { sha256 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base + "/");
    const size = fs.statSync(file).size;
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "Content-Type": "application/gzip",
          "Content-Length": size,
          "User-Agent": `fcc-node/${AGENT_VERSION}`,
          ...(sha256 ? { "X-FCC-Sha256": sha256 } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not json */
          }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json || {});
          else reject(new PanelError(res.statusCode, `upload failed: ${json?.error || `HTTP ${res.statusCode}`}`, json));
        });
      },
    );
    req.on("error", reject);
    fs.createReadStream(file).on("error", reject).pipe(req);
  });
}

function uploadTo(urlPath, file, meta) {
  // An absolute upload URL from the panel is used as given; a path follows the active panel.
  if (/^https?:\/\//i.test(urlPath)) return uploadOnce(cfg.panelUrl, urlPath, file, meta);
  return withFailover((base) => uploadOnce(base, urlPath, file, meta));
}

// ------------------------------------------------------------ self-update

function localFileHashes() {
  const out = {};
  const add = (rel) => {
    try {
      out[rel] = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, rel))).digest("hex");
    } catch {
      /* missing */
    }
  };
  for (const dir of ["node", "shared"]) {
    try {
      for (const f of fs.readdirSync(path.join(ROOT, dir))) if (f.endsWith(".mjs")) add(`${dir}/${f}`);
    } catch {
      /* missing dir */
    }
  }
  add("panel/lib/sys.mjs");
  return out;
}

async function selfUpdate(files) {
  if (process.env.FCC_NODE_NO_UPDATE === "1") {
    log(`panel has newer agent files (${files.join(", ")}) — self-update disabled, continuing.`);
    return false;
  }
  if (cfg.isMain) {
    log(`panel has newer agent files (${files.join(", ")}) — main's embedded agent runs the panel's own code, which follows the active panel; not updating.`);
    return false;
  }
  const marker = path.join(cfg.dataDir, "last-update.json");
  try {
    const last = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (Date.now() - last.at < 5 * 60_000 && last.files.join() === files.join()) {
      log("skipping self-update (the same update was applied moments ago and did not settle).");
      return false;
    }
  } catch {
    /* no marker */
  }
  const staged = [];
  for (const rel of files) {
    if (!/^(node|shared)\/[\w.-]+\.mjs$/.test(rel) && rel !== "panel/lib/sys.mjs") continue;
    const { buf, want } = await withFailover(async (base) => {
      const res = await fetch(`${base}/install/files/${rel}`, { headers: { Authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(120_000) });
      if (!res.ok) {
        let body = null;
        try {
          body = await res.json();
        } catch {
          /* not json */
        }
        throw new PanelError(res.status, `could not download ${rel}: HTTP ${res.status}`, body);
      }
      return { buf: Buffer.from(await res.arrayBuffer()), want: res.headers.get("x-fcc-sha256") };
    });
    const got = crypto.createHash("sha256").update(buf).digest("hex");
    if (want && want !== got) throw new Error(`${rel} failed its checksum`);
    staged.push([rel, buf]);
  }
  for (const [rel, buf] of staged) {
    const dest = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
  }
  fs.writeFileSync(marker, JSON.stringify({ at: Date.now(), files }));
  log(`updated ${staged.length} file(s) from the panel — restarting.`);
  return true;
}

// ------------------------------------------------------------------- tasks

const running = new Map(); // taskId -> { ctrl, settled }

class TaskLog {
  constructor(taskId, ctrl) {
    this.id = taskId;
    this.ctrl = ctrl;
    this.buf = [];
    this.progressNext = null; // latest structured progress not yet sent (only the newest matters)
    this.flushing = null;
    this.timer = setInterval(() => this.flush(), 700);
  }
  line = (text) => {
    for (const l of String(text ?? "").replace(/\r/g, "").split("\n")) this.buf.push(l);
    if (this.buf.length > 200) this.flush();
  };
  /** executeTask's `progress` sink: rides along with the next log flush (POST …/log { lines, progress }). */
  progress = (obj) => {
    try {
      const json = JSON.stringify(obj);
      if (json && json.length <= 4096) this.progressNext = JSON.parse(json);
    } catch {
      /* not serialisable — skip */
    }
  };
  async flush() {
    if (this.flushing) return this.flushing;
    if (!this.buf.length && !this.progressNext) return;
    const lines = this.buf.splice(0, this.buf.length);
    const progress = this.progressNext;
    this.progressNext = null;
    this.flushing = api("POST", `/agent/tasks/${this.id}/log`, progress ? { lines, progress } : { lines }, { timeoutMs: 20_000 })
      .then((r) => {
        if (r?.cancel && !this.ctrl.signal.aborted) {
          log(`task ${this.id}: cancelled by the panel`);
          this.ctrl.abort();
        }
      })
      .catch((err) => {
        if (err.status === 404) return; // panel forgot the task (restarted) — drop the lines
        if (lines.length < 2000) this.buf.unshift(...lines); // retry next tick
        if (progress && !this.progressNext) this.progressNext = progress;
      })
      .finally(() => (this.flushing = null));
    return this.flushing;
  }
  async close() {
    clearInterval(this.timer);
    await this.flush();
    if (this.buf.length || this.progressNext) await this.flush();
  }
}

async function runTask(t) {
  if (running.has(t.id)) return;
  const ctrl = new AbortController();
  running.set(t.id, { ctrl });
  const tl = new TaskLog(t.id, ctrl);
  const started = Date.now();
  log(`task ${t.id}: ${t.type} started`);
  let body;
  try {
    if (!TASK_TYPES.includes(t.type)) throw new Error(`This agent (v${AGENT_VERSION}) does not know the task "${t.type}".`);
    const result = await executeTask(t.type, t.payload || {}, {
      log: tl.line,
      progress: tl.progress,
      signal: ctrl.signal,
      dataDir: cfg.dataDir,
      isMain: cfg.isMain,
      serverId: cfg.serverId,
      authToken: cfg.token,
      panelUrl: current,
      uploadFile: (file, meta) => uploadTo(t.payload?.upload?.url || `/agent/upload/${t.id}`, file, meta),
    });
    body = { ok: true, result: result ?? null };
  } catch (err) {
    tl.line(err.aborted ? `-- ${err.message}` : `!! ${err.message}`);
    body = { ok: false, error: err.message, aborted: !!err.aborted || ctrl.signal.aborted, result: err.result || null };
  }
  await tl.close();
  log(`task ${t.id}: ${t.type} ${body.ok ? "succeeded" : body.aborted ? "cancelled" : "failed"} in ${Math.round((Date.now() - started) / 1000)}s`);
  // Keep it in `running` until the panel has the result, so a poll in between
  // never makes the panel think the task was lost.
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await api("POST", `/agent/tasks/${t.id}/result`, body, { timeoutMs: 30_000 });
      break;
    } catch (err) {
      if (err.status === 404) break;
      await sleep(Math.min(30_000, 1000 * 2 ** attempt));
    }
  }
  running.delete(t.id);
}

// ------------------------------------------------------------------- loops

let pollWaitMs = 25_000;
let metricsIntervalMs = 15_000;
let stopping = false;

function leaderKeyNow() {
  const l = haState.on ? voter?.leader() : null;
  return l ? `${l.serverId}@${l.directUrl}` : null;
}

/** Sleep, but wake up early when the votes show a new leader (it is ready to take this agent right away). */
async function sleepUnlessNewLeader(ms) {
  const key = () => {
    const l = haState.on ? voter?.leader() : null;
    return l ? `${l.serverId}@${l.directUrl}` : null;
  };
  const before = key();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(Math.min(250, end - Date.now()));
    const k = key();
    if (k && k !== before) return;
  }
}

async function hello() {
  let backoff = 1000;
  for (;;) {
    try {
      const r = await api("POST", "/agent/hello", {
        agentVersion: AGENT_VERSION,
        info: systemInfo(),
        files: localFileHashes(),
      });
      pollWaitMs = Number(r?.pollWaitMs) || pollWaitMs;
      metricsIntervalMs = Number(r?.metricsIntervalMs) || metricsIntervalMs;
      needHello = false;
      if (r?.ha === true) {
        if (Array.isArray(r.panels)) setPanels(r.panels, "hello");
        setHa(true);
        if (r.haTimings) voter?.adopt?.(r.haTimings); // failover speed (3.10): the heartbeat the panel wants
      } else setHa(false);
      leaderChanged(); // remember who leads now
      log(`connected to ${current} as "${r?.name || cfg.serverId}" (panel ${r?.panelVersion || "?"}${haState.on ? `, failover on, ${haState.panels.length} panel node(s)` : ""})`);
      if (Array.isArray(r?.update) && r.update.length) {
        try {
          if (await selfUpdate(r.update)) process.exit(0); // systemd restarts us on the new code
        } catch (err) {
          log(`self-update failed: ${err.message} — continuing on the current version`);
        }
      }
      return;
    } catch (err) {
      const wait = err.status === 401 ? 60_000 : backoff;
      log(`hello failed: ${err.status === 401 ? "the panel rejected this server's token (re-run the install command)" : err.message} — retrying in ${Math.round(wait / 1000)}s`);
      await sleepUnlessNewLeader(wait);
      // While panels switch, retry quickly: the new leader is up within seconds of winning.
      backoff = Math.min(backoff * 2, haState.on ? 5_000 : 60_000);
    }
  }
}

async function pollLoop() {
  let backoff = 1000;
  while (!stopping) {
    try {
      if (leaderChanged()) needHello = true;
      if (needHello) {
        log(`saying hello to the panel again (${current}).`);
        await hello();
      }
      // v=2: this agent understands `rehello` (reconnect to pick up newer files).
      const qs = new URLSearchParams({ v: "2", wait: String(Math.round(pollWaitMs / 1000)), running: [...running.keys()].join(",") });
      // Only the best address: on failure the loop says hello to the next one before polling it.
      // A parked poll on a panel that just died (power off: no RST) would hang until its
      // timeout; the votes tell us within a heartbeat that another node leads — give up then.
      const ctrl = new AbortController();
      const leaderAtStart = leaderKeyNow();
      const watch = haState.on
        ? setInterval(() => {
            const k = leaderKeyNow();
            if (k && k !== leaderAtStart) ctrl.abort();
          }, 250)
        : null;
      let r;
      try {
        r = await api("GET", `/agent/poll?${qs}`, undefined, { timeoutMs: pollWaitMs + 15_000, once: haState.on, signal: ctrl.signal });
      } finally {
        clearInterval(watch);
      }
      backoff = 1000;
      if (r?.rehello && !running.size) {
        log("the panel has newer agent files — reconnecting to update.");
        await hello(); // exits (and systemd restarts us) when it applied an update
        continue;
      }
      // The panel repeats the failover state in every poll reply (it may have been turned on after our hello).
      if (r?.ha === true && Array.isArray(r.panels)) setPanels(r.panels, "poll");
      if (typeof r?.ha === "boolean" && r.ha !== haState.on) setHa(r.ha);
      if (r?.ha === true && r.haTimings) voter?.adopt?.(r.haTimings);
      for (const id of r?.cancel || []) running.get(id)?.ctrl.abort();
      for (const t of r?.tasks || []) runTask(t).catch((err) => log(`task ${t.id} crashed: ${err.message}`));
    } catch (err) {
      if (stopping) return;
      if (err.status === 401) {
        log("the panel rejected this server's token — was it rotated or the server removed? Retrying in 60s.");
        await sleep(60_000);
        await hello();
        continue;
      }
      if (err.failover && haState.on) {
        // That panel node is gone or has no leader: hello (which tries every node) then poll again.
        needHello = true;
        if (!err.leaderMoved) await sleepUnlessNewLeader(Math.min(backoff, 2000));
        backoff = Math.min(backoff * 2, 5_000);
        continue;
      }
      log(`poll failed: ${err.message} — retrying in ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, haState.on ? 5_000 : 60_000);
    }
  }
}

async function metricsLoop() {
  while (!stopping) {
    try {
      const m = await collectMetrics();
      m.edge = await edgeStatus(cfg.dataDir).catch((err) => {
        log(`edge status failed: ${err.message}`);
        return null;
      });
      // Database replication (docs/HA.md Phase 3): mysql.status, refreshed at most every 30 s,
      // only when a MySQL/MariaDB server is installed here.
      const my = await mysqlStatusCached(cfg.dataDir, 30_000).catch(() => null);
      if (my) m.mysql = my;
      await api("POST", "/agent/metrics", m, { timeoutMs: 15_000 });
    } catch (err) {
      if (err.status && err.status !== 401 && !err.failover) log(`metrics push failed: ${err.message}`);
    }
    await sleep(metricsIntervalMs);
  }
}

// --------------------------------------------------------- edge access logs
//
// An edge node's front door writes /var/log/nginx/fcc-<siteId>.access.log for
// every website, like main does. The panel only sees main's own files, so new
// lines are shipped to it every 15s and counted into the same analytics.
// Only for sites whose fcc-<siteId>.conf the last cluster.sync wrote here.

const EDGE_LOG_EVERY_MS = 15_000;
const EDGE_LOG_MAX_BYTES = 1536 * 1024; // raw bytes per post — stays under the panel's 2 MB limit once JSON-encoded
const EDGE_LOG_MAX_LINE = 16 * 1024;
const edgeLogDir = () => process.env.FCC_NGINX_LOG_DIR || "/var/log/nginx";
const tails = new Map(); // siteId -> { file, fd, ino, pos, partial, dec }

function closeTail(t) {
  try {
    fs.closeSync(t.fd);
  } catch {
    /* already closed */
  }
}

/** Read up to `budget` bytes of complete lines from a tail; advances it. */
function readTail(t, budget, out) {
  let size;
  try {
    size = fs.fstatSync(t.fd).size;
  } catch {
    return 0;
  }
  if (size < t.pos) {
    // truncated in place (copytruncate): start over
    t.pos = 0;
    t.partial = "";
    t.dec = new StringDecoder("utf8");
  }
  let used = 0;
  while (t.pos < size && used < budget) {
    const len = Math.min(64 * 1024, size - t.pos, budget - used);
    const buf = Buffer.alloc(len);
    let n;
    try {
      n = fs.readSync(t.fd, buf, 0, len, t.pos);
    } catch {
      break;
    }
    if (!n) break;
    t.pos += n;
    used += n;
    const parts = (t.partial + t.dec.write(buf.subarray(0, n))).split("\n");
    t.partial = parts.pop();
    if (t.partial.length > EDGE_LOG_MAX_LINE) t.partial = ""; // not a log line — drop it
    for (const l of parts) if (l) out.push(l);
  }
  return used;
}

function collectEdgeLogs() {
  const want = new Set(edgeLogSites(cfg.dataDir));
  for (const [id, t] of tails) {
    if (!want.has(id)) {
      closeTail(t);
      tails.delete(id);
    }
  }
  const sites = {};
  let budget = EDGE_LOG_MAX_BYTES;
  for (const id of want) {
    const file = path.join(edgeLogDir(), `fcc-${id}.access.log`);
    let st = null;
    try {
      st = fs.statSync(file);
    } catch {
      /* not there yet (or rotated away) */
    }
    let t = tails.get(id);
    if (!t) {
      if (!st) continue;
      try {
        // First sight: start at the end, the past is not ours to count.
        tails.set(id, { file, fd: fs.openSync(file, "r"), ino: st.ino, pos: st.size, partial: "", dec: new StringDecoder("utf8") });
      } catch {
        /* unreadable */
      }
      continue;
    }
    const lines = [];
    if (budget > 0) budget -= readTail(t, budget, lines);
    if (st && st.ino !== t.ino && budget > 0) {
      // Rotated: the old file is drained above (nginx writes to it until it reopens), then follow the new one from its start.
      if (t.pos >= (fs.fstatSync(t.fd).size || 0)) {
        closeTail(t);
        try {
          t = { file, fd: fs.openSync(file, "r"), ino: st.ino, pos: 0, partial: "", dec: new StringDecoder("utf8") };
          tails.set(id, t);
          budget -= readTail(t, budget, lines);
        } catch {
          tails.delete(id);
        }
      }
    }
    if (lines.length) sites[id] = lines;
  }
  return sites;
}

let edgeLogsWarned = false;
async function edgeLogsLoop() {
  while (!stopping) {
    await sleep(EDGE_LOG_EVERY_MS);
    let sites;
    try {
      sites = collectEdgeLogs();
    } catch (err) {
      log(`edge logs: ${err.message}`);
      continue;
    }
    if (!Object.keys(sites).length) continue;
    try {
      await api("POST", "/agent/edge/logs", { sites }, { timeoutMs: 20_000 });
      edgeLogsWarned = false;
    } catch (err) {
      // 404: a panel older than 3.7.0 — the lines are simply dropped.
      if (err.status === 404 || err.status === 401) continue;
      if (!edgeLogsWarned) log(`edge logs not delivered (${err.message}) — those lines are dropped; will keep trying.`);
      edgeLogsWarned = true;
    }
  }
}

async function main() {
  log(`Forthway node agent v${AGENT_VERSION} on ${os.hostname()} · server ${cfg.serverId} · panel ${cfg.panelUrl}${cfg.isMain ? " · main's embedded agent" : ""}`);
  // Vote from the start when failover was on last time: if the panel we knew
  // is the one that died, the others need this vote to take over.
  if (haState.on) setHa(true);
  await hello();
  metricsLoop();
  edgeLogsLoop().catch((err) => log(`edge log shipping stopped: ${err.message}`));
  await pollLoop();
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    if (stopping) process.exit(0);
    stopping = true;
    log(`${sig} — stopping${running.size ? ` (cancelling ${running.size} running task(s))` : ""}`);
    for (const r of running.values()) r.ctrl.abort();
    const deadline = Date.now() + 8000;
    while (running.size && Date.now() < deadline) await sleep(200);
    process.exit(0);
  });
}

process.on("unhandledRejection", (err) => log(`unhandled rejection: ${err?.stack || err}`));

main().catch((err) => {
  console.error("[fcc-node] fatal:", err);
  process.exit(1);
});
