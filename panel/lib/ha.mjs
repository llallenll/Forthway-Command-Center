/**
 * Panel failover — ctx.ha (docs/HA.md, "Phase 2: Panel failover").
 *
 * Several servers can run the panel process ("panel nodes"). Exactly one is
 * the **leader**: it runs every module and owns db.json. The others are
 * **followers**: they copy the leader's state, proxy every browser/agent
 * request to it, and stand ready to take over. This file is the HA core:
 *
 *   - local identity      <dataDir>/ha-local.json (never replicated)
 *   - election            leader/candidate side of the vote protocol (the voter
 *                         side is shared/ha-voter.mjs), fencing, arming, handover
 *   - replication server  GET /ha/state (long poll), POST /ha/ack, GET /ha/releases,
 *                         GET /ha/file/releases/<name>, GET /ha/code
 *   - replication client  the follower's pull loop: atomic file writes,
 *                         config.json keeps the local port/host/tls, release
 *                         fetch, code-digest follow (+ exit 75)
 *   - POST /ha/vote       every voter's heartbeat; the reply carries our role,
 *                         and a `request` for its vote when we lead or campaign
 *   - GET /api/ha, POST /api/ha/handover, SSE "ha" events
 *   - on main: the embedded voter (main has no fcc-node), and while main is a
 *     follower the embedded node agent child process (so the leader can still
 *     run tasks on main)
 *   - the follower's streaming reverse proxy and the 503 "switching" answer.
 *
 * Why there are never two active panels
 * -------------------------------------
 *  1. Every duration is measured on this process's monotonic clock
 *     (performance.now()). Nothing a peer sends is ever compared with our
 *     wall clock.
 *  2. A vote is a lease. When we ask for it we hand the voter a `nonce` =
 *     our performance.now() at that moment, and remember the nonces we issued
 *     to that voter. A grant only counts if it echoes one of *our* nonces, and
 *     it counts until `nonce + LEASE_MS - MARGIN_MS` on our clock. The voter
 *     granted strictly after we built the request and keeps the lease for
 *     LEASE_MS on its own clock, so our view of the grant always ends at least
 *     MARGIN_MS before the voter could give the vote to anyone else.
 *  3. A leader that has ever held a majority ("armed") checks every 250 ms and
 *     fences (flush db.json, stop, exit 75) the moment its valid grants drop
 *     below the majority — i.e. once the majority-th freshest grant is older
 *     than LEASE_MS - MARGIN_MS. It never keeps serving writes without a
 *     majority lease. An unarmed leader (HA just turned on, the voters not
 *     running yet) does not fence for lack of votes — but it does fence when
 *     a voter reports a live lease for someone else in a newer term.
 *  4. A follower opens db.json read-only (Store.readOnly) and only this file's
 *     replication client writes the replicated files; it never runs a module.
 *  5. A candidate promotes only with a majority of valid grants for its new
 *     term. The `request` carries its replicated version honestly (what it has
 *     written to disk, persisted in ha-local.json after the files); voters
 *     refuse anyone whose version is below the highest `committed` a leader
 *     reported (committed = highest version at least one follower acked).
 *  6. Majority = floor(N/2)+1 of the *enabled* servers in our db. A node whose
 *     db has fewer than 3 enabled servers, or does not contain itself, or has
 *     never received a replicated state (non-main), never campaigns.
 *  7. Every demotion is `exit 75`; systemd restarts the process and it boots
 *     as a follower. There is no in-process step-down path to get wrong.
 *  8. A follower applies a state only if its version is >= the one it has,
 *     so a deposed leader can never roll a follower back.
 *
 * HA off (no config.ha.enabled, no panel nodes, ha-local.json says main):
 * nothing here runs except a cheap 250 ms tick that keeps checking whether
 * HA was turned on. Zero npm dependencies; Node 18+.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import dns from "node:dns";
import { spawn, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import { writeFileAtomic } from "./store.mjs";
import { send, sendJson, readJsonBody, httpError, HttpError } from "./http.mjs";
import { setTrustedProxies, trustedRequest, requestIp, requestProto, requestHost } from "./auth.mjs";
import { makeZip } from "../../shared/zipwrite.mjs";
import { extractZip } from "../../shared/zip.mjs";

// ------------------------------------------------------------- the voter

let voterModule = null;
let voterLoadError = null;
try {
  voterModule = await import(new URL("../../shared/ha-voter.mjs", import.meta.url).href);
  if (typeof voterModule.createVoter !== "function") throw new Error("it does not export createVoter");
} catch (err) {
  voterModule = null;
  voterLoadError = err.code === "ERR_MODULE_NOT_FOUND" ? "it is not installed" : err.message;
}

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
/** Timing (docs/HA.md). Taken from shared/ha-voter.mjs; these are only the fallback values. */
export const HEARTBEAT_MS = num(voterModule?.HEARTBEAT_MS, 3000);
export const LEASE_MS = num(voterModule?.LEASE_MS, 15000);
export const MARGIN_MS = num(voterModule?.MARGIN_MS, 3000);
export const FAILOVER_MS = num(voterModule?.FAILOVER_MS, 20000);

// ------------------------------------------------------------- constants

export const LOCAL_FILE = "ha-local.json";
const MAIN = "main";
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const URL_RE = /^https?:\/\/[^\s/?#]+\/?$/i;
const TICK_MS = 250;
const POLL_WAIT_S = 5; // follower long-poll; well under FAILOVER_MS so a quiet leader is never mistaken for a dead one
const CANDIDACY_MS = 10_000;
const ONLINE_MS = 30_000; // a follower that polled within this is online
const VOTER_FRESH_MS = HEARTBEAT_MS * 2 + 2000; // a voter message younger than this describes the voter now
const SLOW_EVERY_MS = 60_000;
const RELEASE_SYNC_MS = 5 * 60_000;
const MAX_STATE_BYTES = 512 * 1024 * 1024;
const MAX_CODE_BYTES = 300 * 1024 * 1024;

/** Replicated files (relative to dataDir). SLOW ones at most once a minute. */
const TRACKED = ["db.json", "config.json", "cloudflare-ips.json", "cloudflared-home/cert.pem", "backups/schedule-state.json", "monitor/state.json", "usage.json"];
const SLOW = ["metrics.json", "analytics/all.json"];
const REPLICATED = new Set([...TRACKED, ...SLOW]);
/** config.json keys that describe this machine, never taken from the leader. */
const LOCAL_CONFIG_KEYS = ["port", "host", "tls"];

/** What /ha/code ships (the install's code items, as updates.mjs/install.sh know them). */
const CODE_ITEMS = ["panel", "node", "shared", "scripts", "patches", "docs", "install.sh", "README.md", "LICENSE"];
const skipCodeName = (name) =>
  name === ".DS_Store" || name === "node_modules" || name === ".git" || name === ".devdata" || name.startsWith(".update-") || name.startsWith(".ha-") || name.startsWith(".staging.");

const HOP_HEADERS = ["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip", "cf-connecting-ip", "cf-visitor", "cf-ipcountry", "cf-ray"];

const mono = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const log = (msg) => console.log(`[ha] ${msg}`);
const warn = (msg) => console.warn(`[ha] ${msg}`);

function cleanV(v) {
  const t = Number(v?.term);
  const s = Number(v?.seq);
  return { term: Number.isFinite(t) && t > 0 ? Math.floor(t) : 0, seq: Number.isFinite(s) && s > 0 ? Math.floor(s) : 0 };
}
/** Lexicographic { term, seq } comparison. */
function cmpV(a, b) {
  const x = cleanV(a);
  const y = cleanV(b);
  return x.term !== y.term ? x.term - y.term : x.seq - y.seq;
}
const fmtV = (v) => `${cleanV(v).term}.${cleanV(v).seq}`;
function parseV(s) {
  const m = /^(\d{1,15})\.(\d{1,15})$/.exec(String(s || ""));
  return m ? { term: Number(m[1]), seq: Number(m[2]) } : { term: 0, seq: 0 };
}

function bearer(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ""));
  return m ? m[1] : null;
}
function hashEquals(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
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
function firstIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === "IPv4" && !ni.internal) return ni.address;
  }
  return "127.0.0.1";
}
const cleanUrl = (u) => (typeof u === "string" && URL_RE.test(u.trim()) ? u.trim().replace(/\/+$/, "") : null);
function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch { /* best effort */ }
}
function statSig(file) {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ local file

/**
 * <dataDir>/ha-local.json — { serverId, token, directUrl, voter, term, version }.
 * Missing ⇒ { serverId: "main" } (every pre-3.8 install). A file that exists but
 * cannot be read is fatal: guessing "main" on an agent panel node would make
 * two nodes claim to be main.
 */
export function readHaLocal(dataDir) {
  const file = path.join(dataDir, LOCAL_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { serverId: MAIN };
    throw new Error(`${file} cannot be read (${err.message}).`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}). Fix it by hand; it says which server this panel runs on.`);
  }
  if (!obj || typeof obj !== "object") obj = {};
  const serverId = obj.serverId === undefined ? MAIN : obj.serverId;
  if (typeof serverId !== "string" || !ID_RE.test(serverId)) throw new Error(`${file}: "serverId" must be "main" or a server id.`);
  return { ...obj, serverId };
}

// ---------------------------------------------------------- http client

const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 64 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 64, rejectUnauthorized: false });

/**
 * Small request helper (directUrls may be https with a self-signed or IP-less
 * certificate, so verification is off — see "open risks" in the report/README).
 * Resolves { status, headers, body } — or streams a 200 body into `toFile`.
 */
function httpRequest(urlStr, { method = "GET", headers = {}, body = null, timeoutMs = 15_000, maxBytes = 16 * 1024 * 1024, toFile = null } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      reject(new Error(`bad url ${urlStr}`));
      return;
    }
    const https_ = u.protocol === "https:";
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    };
    const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = (https_ ? https : http).request(
      u,
      {
        method,
        agent: false,
        rejectUnauthorized: false,
        headers: { "User-Agent": "fcc-ha", ...(data ? { "Content-Length": data.length } : {}), ...headers },
      },
      (res) => {
        if (toFile && res.statusCode === 200) {
          const hash = crypto.createHash("sha256");
          let size = 0;
          const out = fs.createWriteStream(toFile, { mode: 0o600 });
          res.on("data", (c) => {
            size += c.length;
            hash.update(c);
            if (size > maxBytes) req.destroy(new Error("download too large"));
          });
          res.on("error", (err) => finish(err));
          out.on("error", (err) => finish(err));
          out.on("finish", () => finish(null, { status: 200, headers: res.headers, size, sha256: hash.digest("hex") }));
          res.pipe(out);
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > maxBytes) req.destroy(new Error("reply too large"));
          else chunks.push(c);
        });
        res.on("end", () => finish(null, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", (err) => finish(err));
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error("timed out"));
      finish(new Error("timed out"));
    }, timeoutMs);
    req.on("error", (err) => finish(err));
    req.end(data || undefined);
  });
}

function parseJson(buf) {
  try {
    return JSON.parse(Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf));
  } catch {
    return null;
  }
}

// ================================================================= createHa

/**
 * @param ctx     the panel ctx (db, config, saveConfig, events, dataDir, rootDir, version, sys)
 * @param opts.follower   boot in follower mode (HA on)
 * @param opts.port/tls   how this process listens (for the default directUrl)
 * @param opts.onPromote  async () => void — server.mjs reloads db/config and runs loadModules()
 * @param opts.onFence    (reason) => void — flush, stop, exit 75 (never returns in practice)
 * @param opts.onExit     (code, reason) => void — follower restart (new code)
 */
export function createHa(ctx, { follower = false, port = 4000, tls = false, onPromote, onFence, onExit } = {}) {
  const { dataDir, rootDir, config } = ctx;
  const db = ctx.db;
  const localPath = path.join(dataDir, LOCAL_FILE);

  let local = readHaLocal(dataDir);
  let localSig = statSig(localPath);
  const me = local.serverId;
  const mainIsLocal = me === MAIN;
  local.term = Math.max(0, Math.floor(Number(local.term) || 0));
  local.version = cleanV(local.version);
  const haBoot = !!follower;

  // ---------------------------------------------------------------- state
  let role = haBoot ? "follower" : "leader"; // "leader" | "follower" | "candidate"
  let term = local.term; // the term we lead / campaign in
  let maxTermSeen = local.term;
  let leaderId = haBoot ? null : me;
  let haLeading = false; // leader: HA mode entered (term chosen, tracker running, requests sent)
  let promoting = false;
  let fencing = false;
  let stopped = false;
  let candidate = null; // { term, since, until }
  let backoffUntil = 0;
  let condSince = 0;
  let firstDelay = null;
  let lastStateOkAt = mono();
  let handoverExpectedUntil = 0; // follower: the leader told us we are its handover target
  let handover = null; // leader: { to, at, notified:Set, waitFor:Set }
  let switchedAt = null; // wall time of our last promotion (UI banner)
  let committed = { term: 0, seq: 0 };
  let lastBlockLog = { why: null, at: -Infinity };

  const grants = new Map(); // voterId -> { term, nonce }
  const issued = new Map(); // voterId -> [{ term, nonce }]
  const voterMsgs = new Map(); // voterId -> { term, votedFor, leaseLeftMs, knownCommitted, at }
  const nodes = new Map(); // (leader) serverId -> { lastPollAt, url, codeDigest, have, acked, ackAt, panelVersion }
  const learnedUrls = new Map(); // serverId -> directUrl (from polls / voter lists)
  const listeners = new Map(); // event -> Set<fn>

  // ---------------------------------------------------------- local file

  /** Pick up a token/directUrl written by someone else (cluster.mjs gives main its token). */
  function adoptLocalFromDisk() {
    const sig = statSig(localPath);
    if (sig === localSig) return;
    localSig = sig;
    let disk;
    try {
      disk = JSON.parse(fs.readFileSync(localPath, "utf8"));
    } catch {
      return;
    }
    if (!disk || typeof disk !== "object") return;
    if (disk.serverId && disk.serverId !== me) warn(`${LOCAL_FILE} now says serverId "${disk.serverId}" — ignored until the panel restarts.`);
    for (const k of ["token", "directUrl"]) {
      if (typeof disk[k] === "string" && disk[k] && disk[k] !== local[k]) {
        local[k] = disk[k];
        log(`${LOCAL_FILE}: picked up a new ${k}`);
      }
    }
  }

  function saveLocal() {
    adoptLocalFromDisk();
    const out = {};
    for (const [k, v] of Object.entries(local)) if (v !== undefined) out[k] = v;
    writeFileAtomic(localPath, JSON.stringify(out, null, 2) + "\n", 0o600);
    localSig = statSig(localPath);
  }
  let saveLocalTimer = null;
  function saveLocalSoon() {
    if (saveLocalTimer) return;
    saveLocalTimer = setTimeout(() => {
      saveLocalTimer = null;
      try {
        saveLocal();
      } catch (err) {
        warn(`could not write ${LOCAL_FILE}: ${err.message}`);
      }
    }, 200);
  }

  const localDirectUrl = () =>
    cleanUrl(process.env.FCC_HA_DIRECT_URL) || cleanUrl(local.directUrl) || `${tls ? "https" : "http"}://${firstIPv4()}:${port}`;

  // ------------------------------------------------------------- servers

  const servers = () => db.list("servers");
  const enabledServers = () => servers().filter((s) => s.enabled !== false);
  const majority = () => Math.floor(enabledServers().length / 2) + 1;
  const isPanelServer = (s) => !!s && (s.id === MAIN || s.panel?.enabled === true);

  /** HA is "active" when booted as a follower, turned on, or a panel node exists. */
  function haActive() {
    if (haBoot) return true;
    if (config.ha?.enabled === true) return true;
    return servers().some((s) => s.id !== MAIN && s.panel?.enabled === true);
  }

  function urlOf(id) {
    if (id === me) return localDirectUrl();
    const s = db.get("servers", id);
    return cleanUrl(s?.panel?.directUrl) || learnedUrls.get(id) || null;
  }

  function panelIds() {
    if (!haActive()) return [MAIN];
    const ids = servers().filter(isPanelServer).map((s) => s.id);
    if (!ids.includes(MAIN)) ids.unshift(MAIN);
    if (!ids.includes(me)) ids.push(me);
    return ids;
  }

  /** [{ serverId, directUrl }] — what voters and agents should heartbeat. */
  function panelList() {
    return panelIds()
      .map((id) => ({ serverId: id, directUrl: urlOf(id) }))
      .filter((p) => p.directUrl);
  }

  /** The server record behind a node token (sha256 hash compare), or null. */
  function authNode(req, { panelOnly = false } = {}) {
    const token = bearer(req);
    if (!token || token.length < 16) return null;
    const h = sha256(token);
    for (const s of servers()) {
      if (!s.tokenHash || !hashEquals(s.tokenHash, h)) continue;
      if (s.enabled === false) return null;
      if (panelOnly && !isPanelServer(s)) return null;
      return s;
    }
    return null;
  }

  const authHeaders = () => (local.token ? { Authorization: `Bearer ${local.token}` } : {});

  // -------------------------------------------------------------- events

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  }
  function emit(event, data) {
    for (const fn of listeners.get(event) || []) {
      try {
        fn(data);
      } catch (err) {
        warn(`listener for "${event}" failed: ${err.message}`);
      }
    }
  }
  let lastSig = null;
  let lastBroadcastAt = -Infinity;
  function brief() {
    return {
      enabled: config.ha?.enabled === true,
      armed: config.ha?.armed === true,
      role,
      leaderId,
      term,
      localServerId: me,
      granted: role === "follower" ? null : validGrantCount(term),
      majority: majority(),
      handoverTo: handover?.to || null,
      switchedAt,
    };
  }
  function maybeAnnounce(force = false) {
    const b = brief();
    const nodesOnline = role === "leader" ? panelIds().map((id) => (id === me ? 1 : nodes.get(id) && mono() - nodes.get(id).lastPollAt < ONLINE_MS ? 1 : 0)).join("") : "";
    const votes = [...voterMsgs].map(([id, m]) => `${id}:${m.votedFor}:${mono() - m.at < VOTER_FRESH_MS ? 1 : 0}`).sort().join(",");
    const sig = JSON.stringify([b.enabled, b.armed, b.role, b.leaderId, b.term, b.granted, b.majority, b.handoverTo, nodesOnline, votes]);
    if (!force && sig === lastSig) return;
    if (!force && mono() - lastBroadcastAt < 1000) return; // coalesce; the next tick catches up
    lastSig = sig;
    lastBroadcastAt = mono();
    emit("status", b);
    if (role === "leader" && !fencing) {
      try {
        ctx.events?.broadcast?.("ha", b);
      } catch { /* events not ready */ }
    }
  }
  function setRole(next, why) {
    if (role === next) return;
    const prev = role;
    role = next;
    log(`role ${prev} → ${next}${why ? ` (${why})` : ""}`);
    emit("role", { role, prev, term, leaderId });
    maybeAnnounce(true);
  }

  function noteTerm(t) {
    const n = Math.floor(Number(t) || 0);
    if (n > maxTermSeen) {
      maxTermSeen = n;
      if (n > local.term) {
        local.term = n;
        saveLocalSoon();
      }
    }
  }

  // ================================================================ voting

  function validIssued(voterId, t, nonce) {
    const now = mono();
    if (!(nonce <= now) || now - nonce >= LEASE_MS - MARGIN_MS) return false;
    return (issued.get(voterId) || []).some((e) => e.term === t && e.nonce === nonce);
  }

  function recordIssued(voterId, t, nonce) {
    const now = mono();
    const list = (issued.get(voterId) || []).filter((e) => now - e.nonce < LEASE_MS);
    list.push({ term: t, nonce });
    while (list.length > 32) list.shift();
    issued.set(voterId, list);
  }

  /** Grants that count now: for term `t`, from an enabled server, younger than LEASE_MS - MARGIN_MS on OUR clock. */
  function validGrantCount(t) {
    const enabled = new Set(enabledServers().map((s) => s.id));
    const now = mono();
    let n = 0;
    for (const [id, g] of grants) {
      if (enabled.has(id) && g.term === t && now < g.nonce + LEASE_MS - MARGIN_MS) n++;
    }
    return n;
  }

  const fresh = (m) => mono() - m.at < VOTER_FRESH_MS;
  const leaseLeft = (m) => Math.max(0, (Number(m.leaseLeftMs) || 0) - (mono() - m.at));

  /** A voter that currently holds a live lease for a node other than us: { voterId, votedFor, term } or null. */
  function otherLease(minTerm = 0) {
    for (const [id, m] of voterMsgs) {
      if (fresh(m) && m.votedFor && m.votedFor !== me && leaseLeft(m) > 0 && m.term >= minTerm) return { voterId: id, votedFor: m.votedFor, term: m.term };
    }
    return null;
  }

  function myVersion() {
    if (role === "leader" && tracker.started) return { ...tracker.version };
    return { ...local.version };
  }

  function buildVoteReply(voterId, { omitRequest = false } = {}) {
    const replyRole = role === "leader" && !fencing ? "leader" : role === "candidate" ? "candidate" : "follower";
    const r = {
      nodeId: me,
      role: replyRole,
      term: replyRole === "follower" ? maxTermSeen : term,
      leaderId: replyRole === "leader" ? me : replyRole === "candidate" ? null : leaderId,
    };
    if (replyRole === "leader") {
      r.committed = { ...committed };
      r.panels = panelList();
      if (handover) r.handoverTo = handover.to;
    }
    const wantRequest = !omitRequest && ((replyRole === "leader" && haLeading && !handover && !promoting) || (replyRole === "candidate" && candidate));
    if (wantRequest) {
      const nonce = mono();
      recordIssued(voterId, term, nonce);
      r.request = { candidate: me, term, nonce, version: myVersion() };
    }
    return r;
  }

  async function handleVote(req, res) {
    const s = authNode(req);
    if (!s) return sendJson(res, 401, { error: "Unknown or disabled server token." });
    const body = await readJsonBody(req, 64 * 1024);
    if (String(body.voterId || "") !== s.id) return sendJson(res, 403, { error: "voterId does not match the token." });
    const t = Math.max(0, Math.floor(Number(body.term) || 0));
    noteTerm(t);
    const votedFor = typeof body.votedFor === "string" && ID_RE.test(body.votedFor) ? body.votedFor : null;
    voterMsgs.set(s.id, { term: t, votedFor, leaseLeftMs: Math.max(0, Number(body.leaseLeftMs) || 0), knownCommitted: cleanV(body.knownCommitted), at: mono() });

    // A voter that moved on (newer term, or now voting for someone else) takes its grant with it.
    const had = grants.get(s.id);
    if (had && (t > had.term || (votedFor && votedFor !== me))) grants.delete(s.id);

    const g = body.grant && typeof body.grant === "object" ? body.grant : null;
    if (g) {
      const gTerm = Math.floor(Number(g.term));
      const nonce = Number(g.nonce);
      if (g.candidate === me && (role === "leader" || role === "candidate") && !fencing && gTerm === term && validIssued(s.id, gTerm, nonce)) {
        const prev = grants.get(s.id);
        if (!prev || prev.term !== gTerm || prev.nonce < nonce) grants.set(s.id, { term: gTerm, nonce });
      }
    }
    if (handover) handover.notified.add(s.id);
    evaluate();
    const reply = buildVoteReply(s.id, { omitRequest: !!g });
    sendJson(res, 200, reply);
  }

  // ============================================================ election

  function arm() {
    if (promoting || role !== "leader" || fencing) return;
    config.ha = { ...(config.ha || {}), armed: true };
    try {
      ctx.saveConfig();
      log(`armed: first majority lease for term ${term} — from now on this panel fences itself without one`);
    } catch (err) {
      warn(`could not save config.ha.armed: ${err.message}`);
    }
  }

  /** Leader: enter HA mode (pick a fresh term, start the state tracker). */
  function ensureHaLeading() {
    if (haLeading || role !== "leader" || fencing || !haActive()) return;
    term = Math.max(local.term, maxTermSeen, term) + 1;
    maxTermSeen = term;
    local.term = term;
    try {
      saveLocal();
    } catch (err) {
      warn(`could not write ${LOCAL_FILE}: ${err.message}`);
    }
    haLeading = true;
    trackerStart();
    log(`HA active: leading as ${me} in term ${term} — asking the servers for their votes`);
    maybeAnnounce(true);
  }

  function fence(reason) {
    if (fencing) return;
    fencing = true;
    console.error(`[ha] FENCING — ${reason}. Flushing and exiting with code 75 to restart as a standby.`);
    stopVoter();
    stopMainAgent();
    for (const w of [...tracker.waiters]) w();
    try {
      onFence?.(reason);
    } catch (err) {
      console.error("[ha] fence hook failed:", err);
      process.exit(75);
    }
  }

  function evaluate() {
    if (fencing || stopped) return;
    if (role === "leader") {
      if (promoting) {
        // Modules are being started on the strength of the votes we just won: they must not outlive them.
        const n = validGrantCount(term);
        if (n < majority()) return fence(`lost the majority lease while taking over (${n}/${majority()})`);
        return;
      }
      if (!haActive()) {
        if (config.ha?.armed === true && !promoting) {
          config.ha = { ...(config.ha || {}), armed: false };
          try {
            ctx.saveConfig();
          } catch { /* next tick */ }
        }
        return;
      }
      ensureHaLeading();
      const n = validGrantCount(term);
      const need = majority();
      if (n >= need) {
        if (config.ha?.enabled === true && config.ha?.armed !== true && !handover) arm();
      } else if (config.ha?.enabled === true && config.ha?.armed === true) {
        return fence(`lost the majority lease (${n}/${need} valid votes in term ${term})`);
      }
      // Someone else holds a live lease in a newer term: whatever our own view, step down.
      const other = otherLease(term + 1);
      if (other) return fence(`${other.voterId} holds a lease for ${other.votedFor} in term ${other.term}`);
      return;
    }

    if (role === "candidate") {
      const n = validGrantCount(candidate.term);
      if (n >= majority()) {
        promote(n);
        return;
      }
      const handoverMode = mono() < handoverExpectedUntil;
      const other = handoverMode ? null : otherLease(candidate.term);
      if (other) {
        candidate = null;
        setRole("follower", `${other.voterId} holds a lease for ${other.votedFor}`);
        return;
      }
      if (mono() > candidate.until) {
        candidate = null;
        backoffUntil = mono() + rand(2000, 6000);
        grants.clear();
        setRole("follower", `no majority within ${CANDIDACY_MS / 1000} s — backing off`);
      }
      return;
    }

    maybeCandidate();
  }

  function candidacyBlocker() {
    const enabled = enabledServers();
    if (enabled.length < 3) return `only ${enabled.length} enabled server(s) in the replicated database (failover needs 3)`;
    const self = db.get("servers", me);
    if (!self) return "this server is not in the replicated database";
    if (self.enabled === false) return "this server is disabled";
    if (!isPanelServer(self)) return "this server is not a panel node";
    if (!mainIsLocal && local.version.term === 0 && local.version.seq === 0) return "no state has been replicated to this node yet";
    return null;
  }

  function maybeCandidate() {
    if (mono() < backoffUntil) return;
    const handoverMode = mono() < handoverExpectedUntil;
    const silentFor = mono() - lastStateOkAt;
    const ready = handoverMode || (silentFor >= FAILOVER_MS && !otherLease());
    if (!ready) {
      condSince = 0;
      return;
    }
    const why = candidacyBlocker();
    if (why) {
      if (why !== lastBlockLog.why || mono() - lastBlockLog.at > 60_000) {
        warn(`no active panel reachable for ${Math.round(silentFor / 1000)} s, but not standing for election: ${why}`);
        lastBlockLog = { why, at: mono() };
      }
      return;
    }
    if (!condSince) condSince = mono();
    if (firstDelay === null) firstDelay = mainIsLocal || handoverMode ? 0 : rand(0, 3000); // main wins ties
    if (mono() - condSince < firstDelay) return;
    becomeCandidate(handoverMode);
  }

  function becomeCandidate(handoverMode) {
    const t = Math.max(maxTermSeen, local.term, term) + 1;
    term = t;
    maxTermSeen = t;
    local.term = t;
    try {
      saveLocal(); // the term is on disk before we ask anyone for it
    } catch (err) {
      warn(`could not write ${LOCAL_FILE} (${err.message}) — not standing for election`);
      backoffUntil = mono() + 5000;
      return;
    }
    grants.clear();
    leaderId = null;
    candidate = { term: t, since: mono(), until: mono() + (handoverMode ? Math.max(CANDIDACY_MS, handoverExpectedUntil - mono()) : CANDIDACY_MS) };
    setRole("candidate", `${handoverMode ? "handover target" : `no active panel for ${Math.round((mono() - lastStateOkAt) / 1000)} s`} — term ${t}, version ${fmtV(local.version)}`);
  }

  async function promote(votes) {
    if (promoting || role !== "candidate") return;
    promoting = true;
    const t = candidate.term;
    candidate = null;
    leaderId = me;
    haLeading = true;
    handoverExpectedUntil = 0;
    firstDelay = null;
    switchedAt = new Date().toISOString();
    stopMainAgent();
    setRole("leader", `won ${votes}/${enabledServers().length} votes for term ${t}`);
    trackerStart(); // serve /ha/state from the replicated files right away
    try {
      await onPromote?.();
    } catch (err) {
      console.error("[ha] promotion failed:", err);
      promoting = false;
      fence(`promotion failed: ${err.message}`);
      return;
    }
    promoting = false;
    if (config.ha?.armed !== true && validGrantCount(term) >= majority()) arm();
    log(`now the active panel (term ${t})`);
    maybeAnnounce(true);
  }

  // ========================================================== replication

  /** Leader's view of the replicated files. */
  const tracker = { started: false, frozen: false, version: { term: 0, seq: 0 }, files: new Map(), lastSlowAt: -Infinity, times: new Map(), waiters: new Set() };

  function trackerStart() {
    tracker.started = true;
    tracker.frozen = false;
    tracker.version = { term, seq: 0 };
    tracker.files.clear();
    tracker.times.clear();
    tracker.lastSlowAt = -Infinity;
    scan({ initial: true });
    local.version = { ...tracker.version };
    try {
      saveLocal();
    } catch (err) {
      warn(`could not write ${LOCAL_FILE}: ${err.message}`);
    }
  }

  /** stat every tracked file; read + hash the ones whose stat changed; bump seq when any content changed. */
  function scan({ initial = false } = {}) {
    if (!tracker.started || (tracker.frozen && !initial)) return false;
    const slowDue = mono() - tracker.lastSlowAt >= SLOW_EVERY_MS;
    if (slowDue) tracker.lastSlowAt = mono();
    const list = slowDue ? [...TRACKED, ...SLOW] : TRACKED;
    const changed = [];
    for (const rel of list) {
      const abs = path.join(dataDir, rel);
      const sig = statSig(abs) || "missing";
      const cur = tracker.files.get(rel);
      if (cur && cur.sig === sig) continue;
      let content = null;
      if (sig !== "missing") {
        try {
          content = fs.readFileSync(abs, "utf8");
        } catch {
          continue; // vanished between stat and read: next scan
        }
      }
      const hash = content === null ? null : sha256(content);
      if (cur && cur.hash === hash) {
        cur.sig = sig;
        continue;
      }
      if (!cur && content === null && !initial) {
        tracker.files.set(rel, { sig, hash, content, seq: tracker.version.seq });
        continue;
      }
      tracker.files.set(rel, { sig, hash, content, seq: 0 });
      changed.push(rel);
    }
    if (!changed.length) return false;
    if (!initial) tracker.version = { term: tracker.version.term, seq: tracker.version.seq + 1 };
    for (const rel of changed) tracker.files.get(rel).seq = tracker.version.seq;
    tracker.times.set(tracker.version.seq, Date.now());
    if (tracker.times.size > 4000) for (const k of [...tracker.times.keys()].slice(0, 1000)) tracker.times.delete(k);
    if (!initial) {
      local.version = { ...tracker.version };
      saveLocalSoon();
    }
    for (const w of [...tracker.waiters]) w();
    return true;
  }

  function stateReply(have) {
    const v = tracker.version;
    const full = have.term !== v.term || have.seq > v.seq;
    const files = {};
    for (const [rel, e] of tracker.files) if (full || e.seq > have.seq) files[rel] = e.content;
    return { leaderId: me, term: v.term, seq: v.seq, electionTerm: term, codeDigest: codeDigest(), committed: { ...committed }, panels: panelList(), files };
  }

  const notLeader = () => ({ error: "This panel node is not the active panel.", notLeader: true, leaderId: role === "leader" ? null : leaderId, leaderUrl: role === "leader" || !leaderId ? null : urlOf(leaderId), haSwitching: true });

  function noteNode(s, q) {
    const n = nodes.get(s.id) || { lastPollAt: 0, url: null, codeDigest: null, have: null, acked: null, ackAt: 0, panelVersion: null };
    n.lastPollAt = mono();
    const u = cleanUrl(q.url);
    if (u) {
      n.url = u;
      learnedUrls.set(s.id, u);
      recordDirectUrl(s.id, u);
    }
    if (typeof q.code === "string" && /^[0-9a-f]{64}$/.test(q.code)) n.codeDigest = q.code;
    if (q.v) n.panelVersion = String(q.v).slice(0, 40);
    if (q.have) n.have = parseV(q.have);
    nodes.set(s.id, n);
    return n;
  }

  /** servers[].panel.directUrl mirrors what each node reports (leader writes it). */
  function recordDirectUrl(id, u) {
    if (role !== "leader" || promoting || fencing || db.readOnly) return;
    const s = db.get("servers", id);
    if (!s) return;
    if (id !== MAIN && !s.panel?.enabled) return;
    if (s.panel?.directUrl === u) return;
    db.update("servers", id, { panel: { ...(s.panel || { enabled: true }), directUrl: u } });
  }

  async function handleState(req, res, url) {
    const s = authNode(req, { panelOnly: true });
    if (!s) return sendJson(res, 401, { error: "Unknown server token, or the server is not a panel node." });
    if (s.id === me) return sendJson(res, 409, { error: "That is this node." });
    if (role !== "leader" || fencing || !tracker.started) {
      if (role === "leader" && !fencing) ensureHaLeading();
      if (role !== "leader" || fencing || !tracker.started) return sendJson(res, 409, notLeader());
    }
    const q = Object.fromEntries(url.searchParams);
    const have = parseV(q.have);
    const wait = Math.max(0, Math.min(30, Number(q.wait) || 0));
    const n = noteNode(s, q);
    const newer = () => cmpV(tracker.version, have) > 0;
    if (!newer() && wait > 0) {
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          tracker.waiters.delete(done);
          res.off("close", done);
          resolve();
        };
        const timer = setTimeout(done, wait * 1000);
        tracker.waiters.add(done);
        res.on("close", done);
      });
    }
    if (res.destroyed || res.writableEnded) return;
    if (role !== "leader" || fencing) return sendJson(res, 409, notLeader());
    n.lastPollAt = mono();
    if (!newer()) {
      res.writeHead(204, { "Cache-Control": "no-store", "X-FCC-Leader-Id": me });
      return res.end();
    }
    return sendJson(res, 200, stateReply(have));
  }

  async function handleAck(req, res) {
    const s = authNode(req, { panelOnly: true });
    if (!s) return sendJson(res, 401, { error: "Unknown server token, or the server is not a panel node." });
    const body = await readJsonBody(req, 16 * 1024);
    if (role !== "leader" || fencing) return sendJson(res, 409, notLeader());
    const v = cleanV(body);
    const n = nodes.get(s.id) || noteNode(s, {});
    if (cmpV(v, tracker.version) <= 0 && cmpV(v, n.acked) > 0) {
      n.acked = v;
      n.ackAt = mono();
      if (cmpV(v, committed) > 0) committed = v;
    }
    n.lastPollAt = mono();
    return sendJson(res, 200, { ok: true, committed });
  }

  // -------------------------------------------------------------- releases

  const releasesDir = () => path.join(dataDir, "releases");
  const RELEASE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,200}\.zip$/;
  const shaCache = new Map(); // abs -> { sig, hash }

  async function fileSha256(abs) {
    const st = await fs.promises.stat(abs);
    const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
    const c = shaCache.get(abs);
    if (c && c.sig === sig) return { hash: c.hash, size: st.size };
    const h = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(abs)) h.update(chunk);
    const hash = h.digest("hex");
    shaCache.set(abs, { sig, hash });
    if (shaCache.size > 5000) shaCache.delete(shaCache.keys().next().value);
    return { hash, size: st.size };
  }

  async function listReleases() {
    let names = [];
    try {
      names = fs.readdirSync(releasesDir()).filter((n) => RELEASE_RE.test(n));
    } catch {
      return [];
    }
    const out = [];
    for (const name of names.sort()) {
      try {
        const { hash, size } = await fileSha256(path.join(releasesDir(), name));
        out.push({ name, size, sha256: hash });
      } catch { /* vanished */ }
    }
    return out;
  }

  async function handleReleaseFile(req, res, name) {
    const s = authNode(req, { panelOnly: true });
    if (!s) return sendJson(res, 401, { error: "Unknown server token, or the server is not a panel node." });
    if (!RELEASE_RE.test(name)) return sendJson(res, 400, { error: "Bad release name." });
    const abs = path.join(releasesDir(), name);
    let info;
    try {
      info = await fileSha256(abs);
    } catch {
      return sendJson(res, 404, { error: "No such release." });
    }
    res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": info.size, "X-FCC-Sha256": info.hash, "Cache-Control": "no-store" });
    fs.createReadStream(abs).on("error", () => res.destroy()).pipe(res);
  }

  let relBusy = false;
  let relAgain = false;
  let relLastAt = -Infinity;
  async function syncReleases(baseUrl) {
    if (relBusy) {
      relAgain = true;
      return;
    }
    relBusy = true;
    relLastAt = mono();
    try {
      const r = await httpRequest(`${baseUrl}/ha/releases`, { headers: authHeaders(), timeoutMs: 120_000 });
      const list = r.status === 200 ? parseJson(r.body) : null;
      if (!Array.isArray(list)) throw new Error(`release list: HTTP ${r.status}`);
      const dir = releasesDir();
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const want = new Set();
      let fetched = 0;
      for (const item of list) {
        const name = String(item?.name || "");
        const hash = String(item?.sha256 || "");
        if (!RELEASE_RE.test(name) || !/^[0-9a-f]{64}$/.test(hash)) continue;
        want.add(name);
        const abs = path.join(dir, name);
        try {
          if ((await fileSha256(abs)).hash === hash) continue;
        } catch { /* missing */ }
        if (role !== "follower" && role !== "candidate") return;
        const tmp = `${abs}.ha-tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
        try {
          const d = await httpRequest(`${baseUrl}/ha/file/releases/${encodeURIComponent(name)}`, { headers: authHeaders(), timeoutMs: 30 * 60_000, maxBytes: 64 * 1024 ** 3, toFile: tmp });
          if (d.status !== 200) throw new Error(`HTTP ${d.status}`);
          if (d.sha256 !== hash || (d.headers["x-fcc-sha256"] && d.headers["x-fcc-sha256"] !== hash)) throw new Error("checksum mismatch");
          fs.renameSync(tmp, abs);
          fetched++;
        } catch (err) {
          warn(`release ${name}: ${err.message}`);
        } finally {
          rmrf(tmp);
        }
      }
      let removed = 0;
      for (const f of fs.readdirSync(dir)) {
        if (RELEASE_RE.test(f) && !want.has(f)) {
          rmrf(path.join(dir, f));
          removed++;
        }
      }
      if (fetched || removed) log(`releases: fetched ${fetched}, removed ${removed} (${want.size} on the active panel)`);
    } catch (err) {
      warn(`release sync from ${baseUrl}: ${err.message}`);
    } finally {
      relBusy = false;
      if (relAgain) {
        relAgain = false;
        setTimeout(() => syncReleases(baseUrl), 2000).unref?.();
      }
    }
  }

  // ------------------------------------------------------------------ code

  const codeHashCache = new Map(); // abs -> { sig, hash }
  let digestCache = { at: -Infinity, value: null };
  let zipCache = { digest: null, buf: null };

  function walkCode(root) {
    const out = [];
    const visit = (rel) => {
      const abs = path.join(root, rel);
      let st;
      try {
        st = fs.lstatSync(abs);
      } catch {
        return;
      }
      if (st.isDirectory()) {
        let names = [];
        try {
          names = fs.readdirSync(abs);
        } catch {
          return;
        }
        for (const name of names) if (!skipCodeName(name)) visit(`${rel}/${name}`);
      } else if (st.isFile()) out.push({ rel, abs, st });
    };
    for (const item of CODE_ITEMS) visit(item);
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  /** Same shape as cluster.mjs's agent filesDigest: sha256 over sorted "rel:sha256\n", over the /ha/code file set. */
  function digestOf(root, cache = null) {
    const h = crypto.createHash("sha256");
    for (const f of walkCode(root)) {
      const sig = `${f.st.size}:${f.st.mtimeMs}`;
      let sum = cache?.get(f.abs);
      if (!sum || sum.sig !== sig) {
        try {
          sum = { sig, hash: crypto.createHash("sha256").update(fs.readFileSync(f.abs)).digest("hex") };
        } catch {
          continue;
        }
        cache?.set(f.abs, sum);
      }
      h.update(`${f.rel}:${sum.hash}\n`);
    }
    return h.digest("hex");
  }

  function codeDigest() {
    if (digestCache.value && mono() - digestCache.at < 10_000) return digestCache.value;
    digestCache = { at: mono(), value: digestOf(rootDir, codeHashCache) };
    return digestCache.value;
  }

  function codeZip() {
    const digest = codeDigest();
    if (zipCache.digest === digest && zipCache.buf) return { digest, buf: zipCache.buf };
    const entries = walkCode(rootDir).map((f) => ({ name: f.rel, data: fs.readFileSync(f.abs), mode: f.st.mode & 0o777 }));
    zipCache = { digest, buf: makeZip(entries) };
    return { digest, buf: zipCache.buf };
  }

  async function handleCode(req, res) {
    // Any enabled server: panel.install fetches it with the agent token before the node runs the panel.
    const s = authNode(req);
    if (!s) return sendJson(res, 401, { error: "Unknown or disabled server token." });
    const { digest, buf } = codeZip();
    res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": buf.length, "X-FCC-Code-Digest": digest, "X-FCC-Version": ctx.version, "Cache-Control": "no-store" });
    res.end(buf);
  }

  let codeBusy = false;
  const codeTried = new Map(); // digest -> mono
  async function followCode(baseUrl, wanted) {
    if (codeBusy || !wanted || stopped) return;
    const last = codeTried.get(wanted);
    if (last !== undefined && mono() - last < 10 * 60_000) return;
    codeTried.set(wanted, mono());
    const simulated = ctx.sys?.DRY_RUN ? "dry run" : fs.existsSync(path.join(rootDir, ".git")) ? "git checkout" : null;
    if (simulated) {
      log(`the active panel runs different code (${wanted.slice(0, 12)} vs ${codeDigest().slice(0, 12)}) — ${simulated}: not replacing the working copy`);
      return;
    }
    codeBusy = true;
    const stage = path.join(rootDir, `.ha-staging.${Date.now()}`);
    try {
      log(`the active panel runs different code (${wanted.slice(0, 12)}) — downloading it`);
      const r = await httpRequest(`${baseUrl}/ha/code`, { headers: authHeaders(), timeoutMs: 10 * 60_000, maxBytes: MAX_CODE_BYTES });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const served = String(r.headers["x-fcc-code-digest"] || "");
      extractZip(r.body, stage, { stripRoot: false });
      const got = digestOf(stage);
      if (got !== served) throw new Error("the unpacked code does not match the digest the active panel sent");
      if (!fs.existsSync(path.join(stage, "panel", "server.mjs"))) throw new Error("the archive has no panel/server.mjs");
      const chk = spawnSync(process.execPath, ["--check", path.join(stage, "panel", "server.mjs")], { encoding: "utf8", timeout: 120_000 });
      if (chk.status !== 0) throw new Error(`node --check panel/server.mjs failed: ${(chk.stderr || "").trim().slice(0, 300)}`);
      swapIn(stage);
      log(`code updated to ${got.slice(0, 12)} — restarting (exit 75)`);
      stopMainAgent();
      onExit?.(75, "code updated");
    } catch (err) {
      warn(`could not follow the active panel's code: ${err.message}`);
    } finally {
      rmrf(stage);
      codeBusy = false;
    }
  }

  /** Replace each code item present in `stage` by rename (same filesystem); put everything back on failure. */
  function swapIn(stage) {
    const oldDir = path.join(rootDir, `.ha-old.${Date.now()}`);
    fs.mkdirSync(oldDir, { recursive: true });
    const done = [];
    try {
      for (const item of CODE_ITEMS) {
        const from = path.join(stage, item);
        if (!fs.existsSync(from)) continue;
        const live = path.join(rootDir, item);
        const had = fs.existsSync(live);
        if (had) fs.renameSync(live, path.join(oldDir, item));
        done.push({ item, had });
        fs.renameSync(from, live);
      }
    } catch (err) {
      for (const { item, had } of done.reverse()) {
        try {
          if (fs.existsSync(path.join(oldDir, item)) || !had) rmrf(path.join(rootDir, item));
          if (had) fs.renameSync(path.join(oldDir, item), path.join(rootDir, item));
        } catch (e) {
          console.error(`[ha] could not put ${item} back: ${e.message}`);
        }
      }
      rmrf(oldDir);
      throw err;
    }
    rmrf(oldDir);
  }

  // ------------------------------------------------------ follower: apply

  /** Merge an incoming config.json with this machine's port/host/tls. */
  function mergeLocalConfig(content) {
    const incoming = JSON.parse(content);
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) throw new Error("config.json from the active panel is not an object");
    let cur = {};
    try {
      cur = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8")) || {};
    } catch { /* none yet */ }
    for (const k of LOCAL_CONFIG_KEYS) {
      if (cur[k] !== undefined) incoming[k] = cur[k];
      else delete incoming[k];
    }
    return JSON.stringify(incoming, null, 2);
  }

  function writeReplicated(rel, content) {
    const abs = path.resolve(dataDir, rel);
    if (!abs.startsWith(path.resolve(dataDir) + path.sep)) return;
    if (content === null) {
      try {
        fs.unlinkSync(abs);
      } catch { /* already gone */ }
      return;
    }
    writeFileAtomic(abs, content, 0o600);
  }

  /** Write a state reply to disk (db.json last), then persist the version. Throws on bad content (nothing advances). */
  function applyState(st, v) {
    const files = st.files && typeof st.files === "object" ? st.files : {};
    const todo = [];
    let dbContent;
    for (const [rel, content] of Object.entries(files)) {
      if (!REPLICATED.has(rel) || (content !== null && typeof content !== "string")) continue;
      if (rel === "db.json") {
        if (content === null) continue; // never delete the database
        const parsed = JSON.parse(content); // throws on garbage: nothing is written
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("db.json from the active panel is not an object");
        dbContent = content;
        continue;
      }
      todo.push([rel, rel === "config.json" && content !== null ? mergeLocalConfig(content) : content]);
    }
    for (const [rel, content] of todo) writeReplicated(rel, content);
    if (dbContent !== undefined) {
      writeReplicated("db.json", dbContent);
      try {
        db.reload({ backup: false }); // read-only store: majority, panel nodes and tokens come from here
      } catch (err) {
        warn(`could not re-read the replicated db.json: ${err.message}`);
      }
    }
    local.version = cleanV(v);
    saveLocal();
    return { dbChanged: dbContent !== undefined, count: todo.length + (dbContent !== undefined ? 1 : 0) };
  }

  // ------------------------------------------------- follower: pull loop

  let pulling = false;
  let pickIndex = 0;
  let hintLeader = null;
  let proxyUrl = null; // directUrl of the leader that last answered /ha/state

  /**
   * Where a standby with nothing replicated yet can look for the active panel:
   * FCC_HA_SEED_URLS (dev), ha-local.json `seeds`, and — on an agent server —
   * what its node agent knows (panels.json, and the panelUrl it was installed
   * with). Any panel node will do: a standby answers /ha/state with 409 and
   * the leader's id and directUrl.
   */
  let seedCache = { at: -Infinity, list: [] };
  function seedTargets() {
    if (mono() - seedCache.at < 10_000) return seedCache.list;
    const out = [];
    const own = localDirectUrl();
    const add = (serverId, u) => {
      const url = cleanUrl(typeof u === "string" ? u : "");
      if (!url || url === own || out.some((x) => x.url === url)) return;
      out.push({ id: typeof serverId === "string" && ID_RE.test(serverId) && serverId !== me ? serverId : null, url });
    };
    const readQuiet = (f) => {
      try {
        return JSON.parse(fs.readFileSync(f, "utf8"));
      } catch {
        return null;
      }
    };
    for (const u of String(process.env.FCC_HA_SEED_URLS || "").split(",")) add(null, u.trim());
    for (const x of Array.isArray(local.seeds) ? local.seeds : []) add(x?.serverId, typeof x === "string" ? x : x?.directUrl);
    if (!mainIsLocal) {
      const acfg = readQuiet(process.env.FCC_NODE_CONFIG || "/etc/fcc-node/config.json");
      const agentData = (typeof acfg?.dataDir === "string" && acfg.dataDir) || process.env.FCC_NODE_DATA_DIR || "/var/lib/fcc-node";
      const pj = readQuiet(path.join(agentData, "panels.json"));
      for (const x of Array.isArray(pj?.panels) ? pj.panels : []) if (x?.serverId !== me) add(x?.serverId, x?.directUrl);
      if (typeof acfg?.panelUrl === "string") add(null, acfg.panelUrl.replace(/\/+$/, ""));
    }
    seedCache = { at: mono(), list: out };
    return out;
  }

  function pullTargets() {
    const ids = [];
    const add = (id) => {
      if (id && id !== me && !ids.includes(id) && urlOf(id)) ids.push(id);
    };
    add(leaderId);
    add(hintLeader);
    // what the voters say (their live leases)
    const counts = new Map();
    for (const m of voterMsgs.values()) if (fresh(m) && m.votedFor && leaseLeft(m) > 0) counts.set(m.votedFor, (counts.get(m.votedFor) || 0) + 1);
    for (const [id] of [...counts].sort((a, b) => b[1] - a[1])) add(id);
    for (const p of panelList()) add(p.serverId);
    const out = ids.map((id) => ({ id, url: urlOf(id) }));
    for (const sd of seedTargets()) if (!out.some((t) => t.url === sd.url) && !(sd.id && ids.includes(sd.id))) out.push(sd);
    return out;
  }

  function stateOk(id, url) {
    if (!id || id === me) return;
    lastStateOkAt = mono();
    condSince = 0;
    firstDelay = null;
    proxyUrl = urlOf(id) || url;
    if (leaderId !== id) {
      leaderId = id;
      log(`following ${id} (${url})`);
      emit("role", { role, prev: role, term, leaderId });
      maybeAnnounce(true);
    }
    if (role === "candidate" && !(mono() < handoverExpectedUntil)) {
      candidate = null;
      setRole("follower", `${id} answered as the active panel`);
    }
  }

  async function pullOnce(target) {
    const q = new URLSearchParams({ have: fmtV(local.version), wait: String(POLL_WAIT_S), node: me, url: localDirectUrl(), code: codeDigest(), v: ctx.version || "" });
    const r = await httpRequest(`${target.url}/ha/state?${q}`, { headers: authHeaders(), timeoutMs: (POLL_WAIT_S + 10) * 1000, maxBytes: MAX_STATE_BYTES });
    if (role === "leader" || fencing || stopped) return true;
    if (r.status === 204) {
      const lid = String(r.headers["x-fcc-leader-id"] || target.id || "");
      if (!ID_RE.test(lid)) return false;
      stateOk(lid, target.url);
      return true;
    }
    if (r.status === 409) {
      const b = parseJson(r.body);
      if (b?.leaderId && b.leaderId !== target.id && ID_RE.test(b.leaderId)) {
        hintLeader = b.leaderId;
        if (cleanUrl(b.leaderUrl)) learnedUrls.set(b.leaderId, cleanUrl(b.leaderUrl));
      }
      if (target.id && leaderId === target.id) leaderId = null;
      return false;
    }
    if (r.status !== 200) throw new Error(r.status === 401 ? "the active panel refused this node's token" : `HTTP ${r.status}`);
    const st = parseJson(r.body);
    if (!st || typeof st !== "object") throw new Error("state reply is not JSON");
    const v = cleanV({ term: st.term, seq: st.seq });
    if (cmpV(v, local.version) < 0) {
      warn(`${target.id || target.url} offered version ${fmtV(v)}, older than ours (${fmtV(local.version)}) — ignored`);
      if (target.id && leaderId === target.id) leaderId = null;
      return false;
    }
    noteTerm(st.electionTerm ?? st.term);
    for (const p of Array.isArray(st.panels) ? st.panels : []) {
      const u = cleanUrl(p?.directUrl);
      if (u && typeof p.serverId === "string" && ID_RE.test(p.serverId) && p.serverId !== me) learnedUrls.set(p.serverId, u);
    }
    const lid = typeof st.leaderId === "string" && ID_RE.test(st.leaderId) && st.leaderId !== me ? st.leaderId : target.id;
    if (!lid) throw new Error("state reply names no leader");
    const before = fmtV(local.version);
    const { dbChanged, count } = applyState(st, v);
    if (count) log(`replicated ${before} → ${fmtV(v)} from ${lid} (${count} file${count === 1 ? "" : "s"})`);
    stateOk(lid, target.url);
    httpRequest(`${target.url}/ha/ack`, { method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: v, timeoutMs: 5000 }).catch(() => {});
    if (dbChanged || mono() - relLastAt > RELEASE_SYNC_MS) syncReleases(target.url);
    if (typeof st.codeDigest === "string" && /^[0-9a-f]{64}$/.test(st.codeDigest) && st.codeDigest !== codeDigest()) {
      digestCache.at = -Infinity; // re-check before deciding
      if (st.codeDigest !== codeDigest()) followCode(target.url, st.codeDigest);
    }
    return true;
  }

  async function pullLoop() {
    if (pulling) return;
    pulling = true;
    let failures = 0;
    try {
      while (!stopped && !fencing && role !== "leader") {
        if (!local.token) {
          await sleep(2000);
          continue;
        }
        const targets = pullTargets();
        if (!targets.length) {
          await sleep(1000);
          continue;
        }
        const target = targets[pickIndex % targets.length];
        let ok = false;
        try {
          ok = await pullOnce(target);
        } catch (err) {
          if (failures === 0 || failures % 20 === 0) warn(`state from ${target.id || "?"} (${target.url}): ${err.message}`);
          if (target.id && leaderId === target.id && mono() - lastStateOkAt > 5000) proxyUrl = null;
        }
        if (ok) {
          failures = 0;
          pickIndex = 0;
        } else {
          failures++;
          pickIndex++;
          await sleep(Math.min(2000, 250 * failures));
        }
      }
    } finally {
      pulling = false;
    }
  }

  // ------------------------------------------------------------- handover

  async function startHandover(targetId) {
    if (role !== "leader" || fencing || promoting) throw httpError(409, "Only the active panel can hand over.");
    if (config.ha?.enabled !== true) throw httpError(409, "Panel failover is not turned on.");
    if (handover) throw httpError(409, `A switch to ${handover.to} is already under way.`);
    const id = String(targetId || "");
    if (!id || id === me) throw httpError(400, "Choose a standby panel node to hand over to.");
    const s = db.get("servers", id);
    if (!isPanelServer(s) || s.enabled === false) throw httpError(400, "That server is not a panel node.");
    const n = nodes.get(id);
    if (!n || mono() - n.lastPollAt > ONLINE_MS) throw httpError(409, `${s.name || id} is not online as a standby.`);
    if (n.codeDigest && n.codeDigest !== codeDigest()) throw httpError(409, `${s.name || id} runs different panel code — wait until it has caught up.`);
    if (validGrantCount(term) < majority()) throw httpError(409, "This panel does not hold a majority of the votes right now.");

    // Freeze: flush everything, stop producing versions, and wait for the target to have exactly what we have.
    db.save({ immediate: true });
    db.readOnly = true;
    scan();
    tracker.frozen = true;
    const want = { ...tracker.version };
    log(`handover to ${id}: frozen at ${fmtV(want)}, waiting for its ack`);
    const deadline = mono() + 15_000;
    while (cmpV(nodes.get(id)?.acked, want) < 0) {
      if (mono() > deadline || role !== "leader" || fencing) {
        tracker.frozen = false;
        db.readOnly = false;
        db.save();
        throw httpError(409, `${s.name || id} did not confirm the latest data in time — nothing was switched.`);
      }
      await sleep(100);
    }
    if (cmpV(want, committed) > 0) committed = { ...want };
    const waitFor = new Set();
    const now = mono();
    for (const [vid, g] of grants) if (g.term === term && now < g.nonce + LEASE_MS - MARGIN_MS) waitFor.add(vid);
    handover = { to: id, at: mono(), notified: new Set(), waitFor };
    log(`handover to ${id}: telling the voters, then stepping down`);
    maybeAnnounce(true);

    // Tell the target it should stand right away (best effort; it also notices on its own after FAILOVER_MS).
    const targetUrl = urlOf(id);
    (async () => {
      for (let i = 0; i < 3 && targetUrl; i++) {
        try {
          const r = await httpRequest(`${targetUrl}/ha/handover`, { method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: { from: me, term, version: want }, timeoutMs: 3000 });
          if (r.status === 200) break;
        } catch { /* retry */ }
        await sleep(500);
      }
    })();

    // Step down once every voter that backed us has seen handoverTo (or after ~1.5 heartbeats).
    (async () => {
      const until = mono() + HEARTBEAT_MS * 1.5 + 1000;
      while (mono() < until) {
        if ([...handover.waitFor].every((v) => handover.notified.has(v))) break;
        await sleep(100);
      }
      await sleep(300); // let the last replies leave
      fence(`planned handover to ${id}`);
    })();
    return { ok: true, serverId: id, name: s.name || id };
  }

  async function handleHandoverNotice(req, res) {
    const s = authNode(req, { panelOnly: true });
    if (!s) return sendJson(res, 401, { error: "Unknown server token, or the server is not a panel node." });
    const body = await readJsonBody(req, 16 * 1024);
    if (role === "leader") return sendJson(res, 409, { error: "This node is the active panel." });
    if (cmpV(body.version, local.version) > 0) return sendJson(res, 409, { error: "This node does not have that version." });
    handoverExpectedUntil = mono() + LEASE_MS + FAILOVER_MS;
    backoffUntil = 0;
    log(`${s.id} is handing the panel over to this node`);
    evaluate();
    return sendJson(res, 200, { ok: true });
  }

  // ------------------------------------------------------- /ha/* dispatch

  /** Every /ha/* request, in every mode. */
  async function handle(req, res, url) {
    const p = url.pathname;
    try {
      if (!haActive()) return sendJson(res, 404, { error: "Not found" });
      if (p === "/ha/vote" && req.method === "POST") return await handleVote(req, res);
      if (p === "/ha/state" && req.method === "GET") return await handleState(req, res, url);
      if (p === "/ha/ack" && req.method === "POST") return await handleAck(req, res);
      if (p === "/ha/handover" && req.method === "POST") return await handleHandoverNotice(req, res);
      if (p === "/ha/releases" && req.method === "GET") {
        if (!authNode(req, { panelOnly: true })) return sendJson(res, 401, { error: "Unknown server token, or the server is not a panel node." });
        return sendJson(res, 200, await listReleases());
      }
      if (p.startsWith("/ha/file/releases/") && req.method === "GET") {
        let name;
        try {
          name = decodeURIComponent(p.slice("/ha/file/releases/".length));
        } catch {
          return sendJson(res, 400, { error: "Bad release name." });
        }
        return await handleReleaseFile(req, res, name);
      }
      if (p === "/ha/code" && req.method === "GET") return await handleCode(req, res);
      return sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(`[ha] ${req.method} ${p}`, err);
      if (!res.headersSent) sendJson(res, status, { error: err.message });
      else res.end();
    }
  }

  // ---------------------------------------------------------- the proxy

  function switching(req, res, url) {
    const p = url?.pathname || "/";
    if (p === "/api" || p.startsWith("/api/") || p.startsWith("/agent/") || p.startsWith("/ha/") || p.startsWith("/install/")) {
      return send(res, 503, { error: "The panel is switching servers. Try again in a few seconds.", haSwitching: true }, { "Retry-After": "5" });
    }
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>Switching servers</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#f6f7f9;color:#1d2330}@media (prefers-color-scheme:dark){body{background:#12151b;color:#e6e9ef}}main{max-width:28rem;padding:2rem 16px;text-align:center}p{opacity:.75}</style></head>
<body><main><h1>The panel is switching servers</h1><p>This page retries in 5 s.</p></main></body></html>`;
    return send(res, 503, req.method === "HEAD" ? "" : html, { "Retry-After": "5" });
  }

  /** Where the follower proxy sends requests now (null → 503 switching). */
  function proxyTarget() {
    if (role === "leader") return null;
    if (proxyUrl && leaderId && leaderId !== me) return proxyUrl;
    return null;
  }

  /** Streaming reverse proxy to the leader: method, path, body, headers and Host kept; no buffering, no timeouts. */
  function proxy(req, res, url) {
    const target = proxyTarget();
    if (!target || req.headers["x-fcc-ha-proxied"]) return switching(req, res, url);
    let u;
    try {
      u = new URL(target);
    } catch {
      return switching(req, res, url);
    }
    const trustedSrc = trustedRequest(req);
    const clientIp = requestIp(req);
    const headers = { ...req.headers };
    for (const h of HOP_HEADERS) delete headers[h];
    if (!trustedSrc) for (const h of PROXY_HEADERS) delete headers[h];
    headers["x-forwarded-for"] = trustedSrc && req.headers["x-forwarded-for"] ? `${req.headers["x-forwarded-for"]}, ${clientIp}` : clientIp;
    headers["x-forwarded-proto"] = requestProto(req, config);
    headers["x-forwarded-host"] = requestHost(req) || req.headers.host || "";
    headers["x-fcc-ha-proxied"] = me;
    const isHttps = u.protocol === "https:";
    const upstream = (isHttps ? https : http).request({
      protocol: u.protocol,
      hostname: u.hostname.replace(/^\[|\]$/g, ""),
      port: u.port || (isHttps ? 443 : 80),
      method: req.method,
      path: req.url,
      headers,
      setHost: false,
      agent: isHttps ? keepAliveHttps : keepAliveHttp,
      rejectUnauthorized: false,
    });
    let upRes = null;
    upstream.on("response", (ur) => {
      upRes = ur;
      const h = { ...ur.headers };
      for (const k of HOP_HEADERS) delete h[k];
      res.writeHead(ur.statusCode || 502, ur.statusMessage, h);
      if (String(ur.headers["content-type"] || "").startsWith("text/event-stream")) {
        res.socket?.setNoDelay?.(true);
        res.flushHeaders?.();
      }
      ur.on("error", () => res.destroy());
      ur.pipe(res);
    });
    upstream.on("error", (err) => {
      if (!res.headersSent) {
        if (leaderId && mono() - lastStateOkAt > 3000) proxyUrl = null;
        warn(`proxy ${req.method} ${url.pathname} → ${target}: ${err.message}`);
        switching(req, res, url);
      } else res.destroy();
    });
    res.on("close", () => {
      if (!upRes || !upRes.complete) upstream.destroy();
    });
    req.on("error", () => upstream.destroy());
    req.pipe(upstream);
  }

  // ----------------------------------------------- main: voter + agent

  let voter = null;
  let voterWarned = false;
  function stopVoter() {
    if (!voter) return;
    try {
      voter.stop();
    } catch { /* stopping */ }
    voter = null;
  }

  function ensureVoter() {
    const want = mainIsLocal && !!local.token && !fencing && !stopped && haActive() && (haBoot || config.ha?.enabled === true);
    if (!want) return stopVoter();
    if (voter) return;
    if (!voterModule) {
      if (!voterWarned) warn(`shared/ha-voter.mjs could not be loaded (${voterLoadError}) — main does not cast its vote.`);
      voterWarned = true;
      return;
    }
    try {
      voter = voterModule.createVoter({
        voterId: MAIN,
        token: local.token,
        load: () => local.voter || null,
        save: (state) => {
          local.voter = state;
          saveLocal(); // synchronous: the voter must not grant unless this succeeded
        },
        panels: () => panelList(),
        onPanels: (list) => {
          for (const p of Array.isArray(list) ? list : []) {
            const u = cleanUrl(p?.directUrl);
            if (u && p.serverId && p.serverId !== me && ID_RE.test(p.serverId)) learnedUrls.set(p.serverId, u);
          }
        },
        log: (m) => console.log(`[ha-voter] ${m}`),
      });
      voter.start();
      log("main's vote: started");
    } catch (err) {
      voter = null;
      warn(`could not start main's voter: ${err.message}`);
    }
  }

  let agentChild = null;
  let agentUrl = null;
  let agentRestartAt = 0;
  function stopMainAgent() {
    const c = agentChild;
    agentChild = null;
    agentUrl = null;
    if (!c) return;
    try {
      c.kill("SIGTERM");
    } catch { /* gone */ }
    setTimeout(() => {
      try {
        if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
      } catch { /* gone */ }
    }, 3000).unref?.();
  }

  function ensureMainAgent() {
    const want = mainIsLocal && role !== "leader" && !promoting && !fencing && !stopped && !!local.token && process.env.FCC_HA_NO_MAIN_AGENT !== "1";
    if (!want) return stopMainAgent();
    if (agentChild) return;
    const target = leaderId && leaderId !== me ? urlOf(leaderId) : null;
    if (!target || mono() < agentRestartAt) return;
    const agentFile = path.join(rootDir, "node", "node-agent.mjs");
    if (!fs.existsSync(agentFile)) return;
    const cfgFile = path.join(dataDir, "ha-main-agent.json");
    try {
      writeFileAtomic(cfgFile, JSON.stringify({ panelUrl: target, serverId: MAIN, token: local.token, dataDir: path.join(dataDir, "agent"), isMain: true }, null, 2) + "\n", 0o600);
    } catch (err) {
      warn(`could not write ${cfgFile}: ${err.message}`);
      agentRestartAt = mono() + 10_000;
      return;
    }
    const child = spawn(process.execPath, [agentFile, "--config", cfgFile], {
      cwd: rootDir,
      env: { ...process.env, FCC_NODE_NO_UPDATE: "1" }, // its code follows the panel's (codeDigest), never self-updates
      stdio: ["ignore", "pipe", "pipe"],
    });
    agentChild = child;
    agentUrl = target;
    log(`main's node agent started (pid ${child.pid}) → ${target}`);
    const pipeLines = (stream, write) => {
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) !== -1) {
          write(`[main-agent] ${buf.slice(0, i)}`);
          buf = buf.slice(i + 1);
        }
        if (buf.length > 64 * 1024) buf = "";
      });
    };
    pipeLines(child.stdout, (l) => console.log(l));
    pipeLines(child.stderr, (l) => console.error(l));
    child.on("exit", (code, sig) => {
      if (agentChild === child) {
        agentChild = null;
        agentUrl = null;
        agentRestartAt = mono() + 5000;
        warn(`main's node agent exited (${sig || code}) — restarting in 5 s while this node is a standby`);
      }
    });
    child.on("error", (err) => warn(`main's node agent: ${err.message}`));
  }
  process.on("exit", () => {
    try {
      agentChild?.kill("SIGKILL");
    } catch { /* gone */ }
  });

  // ---------------------------------------------------- trusted proxies

  let proxiesAt = -Infinity;
  async function refreshTrustedProxies() {
    proxiesAt = mono();
    if (!haActive()) return setTrustedProxies([], "panels");
    const hosts = new Set();
    for (const id of panelIds()) {
      if (id === me) continue;
      const s = db.get("servers", id);
      for (const h of [s?.host, s?.privateHost]) if (h) hosts.add(String(h).trim());
      const u = urlOf(id);
      if (u) {
        try {
          hosts.add(new URL(u).hostname.replace(/^\[|\]$/g, ""));
        } catch { /* bad url */ }
      }
    }
    const ips = new Set();
    for (const h of hosts) {
      try {
        for (const a of await dns.promises.lookup(h, { all: true })) ips.add(a.address);
      } catch { /* unresolvable */ }
    }
    // Loopback is always trusted; a panel node on this machine (dev) needs nothing extra.
    setTrustedProxies([...ips], "panels");
  }

  // ------------------------------------------------------------- status

  function lagMs(n) {
    if (!n?.acked) return null;
    if (cmpV(n.acked, tracker.version) >= 0) return 0;
    const nextSeq = n.acked.term === tracker.version.term ? n.acked.seq + 1 : 0;
    const t = tracker.times.get(nextSeq);
    return t ? Math.max(0, Date.now() - t) : null;
  }

  function panelNodes() {
    const ids = panelIds();
    const out = [];
    for (const id of ids) {
      const s = db.get("servers", id);
      const base = { serverId: id, name: s?.name || (id === MAIN ? "Main" : id), directUrl: urlOf(id) };
      if (id === me) {
        out.push({ ...base, online: true, role: role === "leader" && !fencing ? "leader" : role === "candidate" ? "candidate" : "follower", version: myVersion(), lagMs: role === "leader" ? 0 : null, codeInSync: true, local: true });
      } else if (role === "leader") {
        const n = nodes.get(id);
        out.push({ ...base, online: !!n && mono() - n.lastPollAt < ONLINE_MS, role: "follower", version: n?.acked || null, lagMs: lagMs(n), codeInSync: n?.codeDigest ? n.codeDigest === codeDigest() : null, panelVersion: n?.panelVersion || null });
      } else {
        const isLeader = id === leaderId;
        out.push({ ...base, online: isLeader ? mono() - lastStateOkAt < FAILOVER_MS : null, role: isLeader ? "leader" : "follower", version: null, lagMs: null, codeInSync: null });
      }
    }
    return out;
  }

  function canEnable() {
    if (typeof ctx.cluster?.panelCanEnable === "function") {
      try {
        const r = ctx.cluster.panelCanEnable();
        if (r && typeof r === "object") return { ok: !!r.ok, reason: r.reason || null };
      } catch { /* fall through */ }
    }
    const enabled = enabledServers();
    if (enabled.length < 3) return { ok: false, reason: "Panel failover needs at least 3 enabled servers — each one has a vote." };
    for (const s of enabled) {
      if (s.id === MAIN) continue;
      const online = typeof ctx.cluster?.isOnline === "function" ? ctx.cluster.isOnline(s.id) : !!s.lastSeenAt && Date.now() - Date.parse(s.lastSeenAt) < 90_000;
      if (!online) return { ok: false, reason: `${s.name || s.id} is offline — every enabled server must be online to vote.` };
      if (!versionAtLeast(s.agentVersion, "3.2.0")) return { ok: false, reason: `${s.name || s.id} runs agent ${s.agentVersion || "?"} — panel failover needs 3.2.0 or newer.` };
    }
    return { ok: true, reason: null };
  }

  function status() {
    const enabled = enabledServers();
    const now = mono();
    const votes = enabled.map((s) => {
      const m = voterMsgs.get(s.id);
      const g = grants.get(s.id);
      return {
        serverId: s.id,
        name: s.name || s.id,
        votedFor: m?.votedFor ?? null,
        term: m?.term ?? null,
        leaseLeftMs: m ? Math.round(leaseLeft(m)) : 0,
        reachable: !!m && fresh(m),
        granted: !!g && g.term === term && now < g.nonce + LEASE_MS - MARGIN_MS && role !== "follower",
      };
    });
    const nodesList = panelNodes();
    const warnings = [];
    const on = config.ha?.enabled === true;
    if (on && config.ha?.armed !== true) warnings.push("Waiting for the servers to vote…");
    if (on && role === "leader") {
      const granted = validGrantCount(term);
      const need = majority();
      if (config.ha?.armed === true && granted - 1 < need) warnings.push("One more server going offline would stop the panel (not enough votes left for a majority).");
      for (const n of nodesList) {
        if (n.serverId === me) continue;
        if (!n.online) warnings.push(`Standby ${n.name} is not replicating.`);
        else if (n.codeInSync === false) warnings.push(`Standby ${n.name} runs different panel code.`);
        else if (n.lagMs != null && n.lagMs > 60_000) warnings.push(`Standby ${n.name} is ${Math.round(n.lagMs / 1000)} s behind.`);
      }
    }
    if (mainIsLocal && on && !voterModule) warnings.push("Main cannot vote: shared/ha-voter.mjs is missing.");
    return {
      enabled: on,
      armed: config.ha?.armed === true,
      role: fencing ? "fenced" : role,
      leaderId: role === "leader" && !fencing ? me : leaderId,
      term,
      localServerId: me,
      mainIsLocal,
      majority: majority(),
      voters: enabled.length,
      granted: role === "follower" ? null : validGrantCount(term),
      votes,
      nodes: nodesList,
      committed: { ...committed },
      version: myVersion(),
      handoverTo: handover?.to || null,
      switchedAt,
      warnings,
      canEnable: canEnable(),
    };
  }

  function registerRoutes(router) {
    router.get("/api/ha", () => status());
    router.post("/api/ha/handover", async (req, res, { body, admin }) => {
      const out = await startHandover(body?.serverId);
      try {
        ctx.activity?.(admin, "ha.handover", { type: "server", id: out.serverId, name: out.name });
      } catch { /* activity is best effort */ }
      return out;
    });
  }

  // --------------------------------------------------------------- tick

  let tickTimer = null;
  let slowTickAt = -Infinity;
  function tick() {
    if (stopped) return;
    evaluate();
    if (mono() - slowTickAt < 1000) return;
    slowTickAt = mono();
    adoptLocalFromDisk();
    if (role === "leader" && tracker.started && !fencing) {
      scan();
      if (haLeading) recordDirectUrl(me, localDirectUrl());
    }
    if (role !== "leader" && !pulling && !fencing) pullLoop();
    ensureVoter();
    ensureMainAgent();
    if (role === "leader" && mono() - proxiesAt > 30_000) refreshTrustedProxies().catch(() => {});
    maybeAnnounce();
  }

  function start() {
    if (tickTimer) return;
    if (haBoot) log(`booting as a standby panel node (${me}, ${localDirectUrl()}); version ${fmtV(local.version)}, term ${local.term}`);
    tickTimer = setInterval(() => {
      try {
        tick();
      } catch (err) {
        console.error("[ha] tick failed:", err);
      }
    }, TICK_MS);
    tick();
  }

  function stop() {
    stopped = true;
    clearInterval(tickTimer);
    tickTimer = null;
    stopVoter();
    stopMainAgent();
    for (const w of [...tracker.waiters]) w();
  }

  // -------------------------------------------------------------- ctx.ha

  return {
    get enabled() {
      return config.ha?.enabled === true;
    },
    localServerId: me,
    mainIsLocal,
    isLeader: () => role === "leader" && !fencing,
    leaderId: () => (role === "leader" && !fencing ? me : leaderId),
    term: () => term,
    status,
    panelNodes,
    on,
    handover: (serverId) => startHandover(serverId),
    directUrl: localDirectUrl,
    /** cluster.mjs: give this node (main) its token without racing our own writes of ha-local.json. */
    setLocalToken(token) {
      if (typeof token !== "string" || token.length < 16) throw new Error("setLocalToken: token too short");
      local.token = token;
      saveLocal();
    },
    // server.mjs plumbing
    _handle: handle,
    _proxy: proxy,
    _switching: switching,
    _registerRoutes: registerRoutes,
    _start: start,
    _stop: stop,
    _haActive: haActive,
  };
}
