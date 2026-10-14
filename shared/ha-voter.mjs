/**
 * Panel failover — the voter (docs/HA.md, "Voting and leases").
 *
 * Every enabled server has exactly one vote. Agent servers vote from fcc-node
 * (node/node-agent.mjs), main votes from its own panel process. A voter does
 * nothing clever: every HEARTBEAT_MS it POSTs /ha/vote to every panel node it
 * knows, and when a node's reply carries a `request` it decides, by the rules
 * below, whether to give that candidate its vote (a lease of LEASE_MS).
 *
 *   createVoter({ voterId, token, load, save, panels, onPanels, log })
 *     → { start(), stop(), status(), leader() }
 *
 * Why this cannot produce two active panels:
 *
 *   - A voter never grants a *different* candidate while its current grant is
 *     younger than LEASE_MS. Lease time is measured on this process's
 *     monotonic clock (performance.now()), so a wall-clock jump changes nothing.
 *   - The candidate counts a grant only until `nonce + LEASE_MS - MARGIN_MS`
 *     on *its* monotonic clock, where `nonce` is when it built the request —
 *     strictly before the voter could have granted the request. So every grant
 *     expires at the candidate MARGIN_MS before the voter would hand the same
 *     vote to someone else. Two majorities would need one voter in both: impossible.
 *   - A voter that restarts cannot know how long it was down, so it treats its
 *     lease as live for a full LEASE_MS after boot (whatever vote.json says).
 *   - The vote is persisted (save()) *before* the grant is sent. If saving
 *     fails, nothing is granted.
 *   - `term` never decreases; a request for an older term is refused.
 *   - A candidate whose replicated version is behind `knownCommitted` (the
 *     highest version any leader said a follower acknowledged) is refused,
 *     so a stale node can never take over and lose acknowledged writes.
 *   - During a planned handover only the named target can get the vote.
 *
 * Liveness: every panel node is heartbeated on its own timer with a ~2.5 s
 * request timeout, so a dead or slow node never delays the others.
 *
 * Zero dependencies; Node 18+.
 */

import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";

export const HEARTBEAT_MS = 3000;
export const LEASE_MS = 15000;
export const MARGIN_MS = 3000;
export const FAILOVER_MS = 20000;

const REQUEST_TIMEOUT_MS = 2500;
const MAX_REPLY_BYTES = 256 * 1024;
const SYNC_NODES_MS = 1000;
/**
 * How long a seen `handoverTo` restricts our vote to its target (refreshed
 * while the leader keeps sending it). The old leader stops renewing when it
 * starts the handover, so our lease for it ends within LEASE_MS; the target
 * then has two more heartbeats to itself before anyone else may ask.
 */
const HANDOVER_HOLD_MS = LEASE_MS + 2 * HEARTBEAT_MS;

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const URL_RE = /^https?:\/\/[^\s/?#]+\/?$/i;

const now = () => performance.now();
const NOOP = () => {};

// ------------------------------------------------------------------ helpers

function cleanVersion(v) {
  const term = Number(v?.term);
  const seq = Number(v?.seq);
  return {
    term: Number.isFinite(term) && term >= 0 ? Math.floor(term) : 0,
    seq: Number.isFinite(seq) && seq >= 0 ? Math.floor(seq) : 0,
  };
}

/** Lexicographic { term, seq } comparison: <0, 0, >0. */
export function compareVersion(a, b) {
  const x = cleanVersion(a);
  const y = cleanVersion(b);
  return x.term !== y.term ? x.term - y.term : x.seq - y.seq;
}

function cleanState(s) {
  const term = Number(s?.term);
  return {
    term: Number.isFinite(term) && term >= 0 ? Math.floor(term) : 0,
    votedFor: typeof s?.votedFor === "string" && ID_RE.test(s.votedFor) ? s.votedFor : null,
    grantedAt: typeof s?.grantedAt === "string" ? s.grantedAt : null, // wall time, informational only
    knownCommitted: cleanVersion(s?.knownCommitted),
  };
}

/** [{ serverId, directUrl }] with junk removed and duplicates (by url) dropped. */
export function cleanPanels(list) {
  const out = [];
  const seen = new Set();
  for (const p of Array.isArray(list) ? list : []) {
    const serverId = typeof p?.serverId === "string" && ID_RE.test(p.serverId) ? p.serverId : null;
    const directUrl = typeof p?.directUrl === "string" && URL_RE.test(p.directUrl.trim()) ? p.directUrl.trim().replace(/\/+$/, "") : null;
    if (!serverId || !directUrl || seen.has(directUrl)) continue;
    seen.add(directUrl);
    out.push({ serverId, directUrl });
  }
  return out;
}

/** POST JSON with a hard overall timeout. Resolves the parsed reply; rejects on anything else. */
function postJson(url, body, token, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error(`bad url ${url}`));
      return;
    }
    const data = Buffer.from(JSON.stringify(body));
    const mod = u.protocol === "https:" ? https : http;
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    };
    const req = mod.request(
      u,
      {
        method: "POST",
        agent: false, // a fresh connection per vote: a half-dead keep-alive socket must not eat a heartbeat
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": data.length,
          "User-Agent": "fcc-ha-voter",
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (d) => {
          size += d.length;
          if (size > MAX_REPLY_BYTES) req.destroy(new Error("reply too large"));
          else chunks.push(d);
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            /* not json */
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(json?.error || `HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            finish(err);
          } else if (!json || typeof json !== "object") finish(new Error("reply is not JSON"));
          else finish(null, json);
        });
        res.on("error", (err) => finish(err));
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error("timed out"));
      finish(new Error("timed out"));
    }, timeoutMs);
    req.on("error", (err) => finish(err));
    req.end(data);
  });
}

// -------------------------------------------------------------------- voter

export function createVoter(opts) {
  const voterId = String(opts?.voterId || "");
  const token = String(opts?.token || "");
  const load = opts?.load || (() => null);
  const save = opts?.save || NOOP;
  const panels = opts?.panels || (() => []);
  const onPanels = opts?.onPanels || NOOP;
  const log = opts?.log || NOOP;
  if (!ID_RE.test(voterId)) throw new Error("createVoter: voterId is required");
  if (!token) throw new Error("createVoter: token is required");

  let loaded = null;
  try {
    loaded = load();
  } catch (err) {
    log(`ha voter: could not read the saved vote (${err.message}) — starting with a blank one`);
  }
  const state = cleanState(loaded);
  // Restart rule: whatever was saved, the lease we may have granted just before
  // going down is treated as live for a full LEASE_MS from now.
  let grantedMono = now();

  const nodes = new Map(); // directUrl -> node record
  let handover = null; // { target, until }
  let handoverLogged = null;
  let running = false;
  let generation = 0; // bumped by start()/stop(): a heartbeat from an older run never reschedules itself
  let syncTimer = null;

  const leaseLeft = () => Math.max(0, Math.round(grantedMono + LEASE_MS - now()));
  const leaseExpired = () => now() - grantedMono >= LEASE_MS;
  const handoverPending = () => (handover && now() < handover.until ? handover : null);

  function persist() {
    save({ term: state.term, votedFor: state.votedFor, grantedAt: state.grantedAt, knownCommitted: { ...state.knownCommitted } });
  }

  function voteBody(grant) {
    return {
      voterId,
      term: state.term,
      votedFor: state.votedFor,
      leaseLeftMs: leaseLeft(),
      knownCommitted: { ...state.knownCommitted },
      ...(grant ? { grant } : {}),
    };
  }

  // --------------------------------------------------------- node set

  function syncNodes() {
    let list = [];
    try {
      list = cleanPanels(panels());
    } catch (err) {
      log(`ha voter: panels() failed: ${err.message}`);
    }
    const want = new Map(list.map((p) => [p.directUrl, p]));
    for (const [url, n] of nodes) {
      if (!want.has(url)) {
        n.removed = true;
        clearTimeout(n.timer);
        nodes.delete(url);
      }
    }
    for (const [url, p] of want) {
      let n = nodes.get(url);
      if (!n) {
        n = { serverId: p.serverId, directUrl: url, reachable: false, role: null, leaderId: null, term: null, lastOkAt: null, error: null, timer: null, removed: false };
        nodes.set(url, n);
        if (running) beat(n);
      } else n.serverId = p.serverId;
    }
  }

  // --------------------------------------------------------- heartbeat

  function beat(n) {
    if (!running || n.removed) return;
    const gen = generation;
    n.gen = gen; // this node's heartbeat chain belongs to the current run
    const started = now();
    send(n, null)
      .catch(() => {})
      .finally(() => {
        if (!running || n.removed || gen !== generation) return;
        n.timer = setTimeout(() => beat(n), Math.max(0, started + HEARTBEAT_MS - now()));
        n.timer.unref?.();
      });
  }

  async function send(n, grant) {
    let reply;
    try {
      reply = await postJson(`${n.directUrl}/ha/vote`, voteBody(grant), token);
    } catch (err) {
      if (n.reachable || n.error !== err.message) log(`ha voter: ${n.serverId} (${n.directUrl}) unreachable: ${err.message}`);
      n.reachable = false;
      n.error = err.message;
      return;
    }
    handleReply(n, reply, { followUp: !!grant });
  }

  function handleReply(n, r, { followUp }) {
    const nodeId = typeof r.nodeId === "string" && ID_RE.test(r.nodeId) ? r.nodeId : null;
    if (!nodeId || nodeId !== n.serverId) {
      n.reachable = false;
      n.error = `answered as "${String(r.nodeId).slice(0, 80)}", expected ${n.serverId}`;
      return;
    }
    const role = ["leader", "follower", "candidate"].includes(r.role) ? r.role : null;
    const term = Number.isFinite(Number(r.term)) ? Math.max(0, Math.floor(Number(r.term))) : null;
    const wasReachable = n.reachable;
    Object.assign(n, {
      reachable: true,
      role,
      term,
      leaderId: typeof r.leaderId === "string" && ID_RE.test(r.leaderId) ? r.leaderId : null,
      lastOkAt: Date.now(),
      error: null,
    });
    if (!wasReachable) log(`ha voter: ${n.serverId} reachable (${role || "?"}, term ${term ?? "?"})`);

    const isLeader = role === "leader" && n.leaderId === nodeId;
    if (isLeader) {
      if (r.committed && compareVersion(r.committed, state.knownCommitted) > 0) {
        state.knownCommitted = cleanVersion(r.committed);
        try {
          persist();
        } catch (err) {
          log(`ha voter: could not save knownCommitted: ${err.message}`);
        }
      }
      if (typeof r.handoverTo === "string" && ID_RE.test(r.handoverTo)) {
        if (handoverLogged !== `${nodeId}>${r.handoverTo}`) log(`ha voter: ${nodeId} is handing over to ${r.handoverTo}`);
        handoverLogged = `${nodeId}>${r.handoverTo}`;
        handover = { target: r.handoverTo, until: now() + HANDOVER_HOLD_MS };
      }
      if (r.panels !== undefined) {
        const list = cleanPanels(r.panels);
        const cur = cleanPanels(panels());
        if (list.length && JSON.stringify(list) !== JSON.stringify(cur)) {
          try {
            onPanels(list);
          } catch (err) {
            log(`ha voter: onPanels failed: ${err.message}`);
          }
        }
      }
    }

    // The reply to a grant carries the next request already; it is answered on
    // the next heartbeat, otherwise grant → reply → grant would never stop.
    if (followUp || !r.request || typeof r.request !== "object") return;
    const q = r.request;
    const candidate = typeof q.candidate === "string" ? q.candidate : null;
    const qTerm = Number(q.term);
    const nonce = Number(q.nonce);
    if (candidate !== nodeId || !Number.isInteger(qTerm) || qTerm < 0 || !Number.isFinite(nonce)) return; // a node only ever asks for itself
    const why = refusal(candidate, qTerm, q.version);
    if (why) {
      n.lastRefusal = why;
      return;
    }
    // Grant: remember it on disk first, then tell the candidate right away.
    const prev = { term: state.term, votedFor: state.votedFor, grantedAt: state.grantedAt };
    const prevMono = grantedMono;
    state.term = qTerm;
    state.votedFor = candidate;
    state.grantedAt = new Date().toISOString();
    grantedMono = now();
    try {
      persist();
    } catch (err) {
      Object.assign(state, prev);
      grantedMono = prevMono;
      log(`ha voter: could not save the vote (${err.message}) — not granting ${candidate}`);
      return;
    }
    if (prev.votedFor !== candidate || prev.term !== qTerm) log(`ha voter: voted for ${candidate} (term ${qTerm})`);
    if (handover && handover.target === candidate) handover = null;
    send(n, { candidate, term: qTerm, nonce }).catch(() => {});
  }

  /** Why a request is refused, or null to grant. */
  function refusal(candidate, term, version) {
    if (term < state.term) return `term ${term} is older than ${state.term}`;
    if (compareVersion(version, state.knownCommitted) < 0) return "its data is behind what was already committed";
    if (state.votedFor !== candidate && !leaseExpired()) return `lease for ${state.votedFor || "(restart hold)"} still has ${leaseLeft()} ms`;
    const h = handoverPending();
    if (h && h.target !== candidate) return `a handover to ${h.target} is pending`;
    return null;
  }

  // ------------------------------------------------------------ public

  function leader() {
    let best = null;
    for (const n of nodes.values()) {
      if (!n.reachable || n.role !== "leader" || n.leaderId !== n.serverId) continue;
      if (!best || (n.term ?? -1) > (best.term ?? -1)) best = n;
    }
    return best ? { serverId: best.serverId, directUrl: best.directUrl } : null;
  }

  function status() {
    const out = {};
    for (const n of nodes.values()) {
      out[n.serverId] = { reachable: n.reachable, role: n.role, leaderId: n.leaderId, term: n.term, lastOkAt: n.lastOkAt };
    }
    return {
      term: state.term,
      votedFor: state.votedFor,
      leaseLeftMs: leaseLeft(),
      knownCommitted: { ...state.knownCommitted },
      nodes: out,
    };
  }

  function start() {
    if (running) return;
    running = true;
    generation++;
    syncNodes(); // starts the chain of every node it adds
    for (const n of nodes.values()) if (n.gen !== generation) beat(n);
    syncTimer = setInterval(syncNodes, SYNC_NODES_MS);
    syncTimer.unref?.();
  }

  function stop() {
    running = false;
    generation++;
    clearInterval(syncTimer);
    syncTimer = null;
    for (const n of nodes.values()) clearTimeout(n.timer);
  }

  return { start, stop, status, leader };
}
