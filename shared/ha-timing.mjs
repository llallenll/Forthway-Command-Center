/**
 * Failover timing (docs/HA.md, "Failover speed", v3.10.0).
 *
 * ONE cluster-wide setting, `config.ha.failoverSeconds` (10–300, default 15):
 * the target time from "the server running the panel and the database primary
 * goes down" to "the database replica is promoted and every server is cut
 * over". Every panel-failover and database-failover duration is derived from it
 * here, by one pure function, so the panel (panel/lib/ha.mjs, mysql-ha.mjs),
 * the voters (shared/ha-voter.mjs on agents and main) and the UI agree.
 *
 * Safety never depends on two processes using the same value: each vote grant
 * carries the lease length it was given under, and a leader counts a grant only
 * until nonce + min(grant lease, its own lease at request time) − margin.
 * See shared/ha-voter.mjs.
 *
 * Zero dependencies; Node 18+ and browsers (the UI previews the breakdown).
 */

export const FAILOVER_SECONDS_DEFAULT = 15;
export const FAILOVER_SECONDS_MIN = 10;
export const FAILOVER_SECONDS_MAX = 300;

/** Lease a voter grants when the request names none (voters/leaders before 3.10 / agent 3.4). */
export const LEGACY_LEASE_MS = 15_000;
export const LEGACY_HEARTBEAT_MS = 3000;
/** Bounds every node applies to a lease or heartbeat it is told about. */
export const LEASE_MIN_MS = 3000;
export const LEASE_MAX_MS = 180_000;
export const HEARTBEAT_MIN_MS = 1000;
export const HEARTBEAT_MAX_MS = 5000;

const r100 = (n) => Math.round(n / 100) * 100;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** A valid failoverSeconds, or null (not an integer in range). */
export function checkFailoverSeconds(v) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < FAILOVER_SECONDS_MIN || n > FAILOVER_SECONDS_MAX) return null;
  return n;
}

/** Whatever is stored → the value in force (default when missing or invalid). */
export function effectiveFailoverSeconds(v) {
  return checkFailoverSeconds(v) ?? FAILOVER_SECONDS_DEFAULT;
}

/**
 * Every duration (ms) derived from the target. T = failoverSeconds × 1000.
 *
 *   heartbeatMs      H = clamp(T/15, 1 s, 5 s)          voter → panel node, every H
 *   leaseMs          L = 0.45 T                         a vote is a lease of L
 *   marginMs         M = max(1 s, L/5)                  leader's grant view ends M early
 *   failoverMs       F = L − H                          standby silence before it may stand
 *   requestTimeoutMs     min(2.5 s, 0.9 H)              per vote request (below H)
 *   pollWaitS            clamp(⌊F/2.5 s⌋, 1, 5)         standby long-poll (well under F)
 *   voterFreshMs         2H + 2 s                       a voter message this young is "now"
 *   tieBreakMs           min(3 s, H/2)                  agent panel nodes wait 0…this (main 0)
 *   candidacyMs          max(10 s, L + 2H)              give up a candidacy after this
 *   fenceHooksMs         clamp(M − 250 ms, 0.75 s, 3 s) beforeFence hooks, all together
 *   dbSilentMs           3H                             primary's voter quiet ⇒ condition (a)
 *   dbProbeMs            max(0.5 s, H/2)                TCP probe interval while suspicious
 *   dbTcpTimeoutMs       clamp(0.8 H, 0.8 s, 3 s)       one TCP connect to primary:3306
 *   dbTcpFails           3                              consecutive failed connects ⇒ (b)
 *   detectMs         D = max(3 s, T/3)                  no sign of life from the primary for D
 *
 * Estimates (worst case, for the UI):
 *   panelTakeoverMs    = L + H + tieBreak + 0.5 s (modules start)
 *   databaseFailoverMs = max(panelTakeover, D) + (fails−1)·probe + 0.7 s (replica check)
 *                        + 1.5 s (promote + cut-over push)
 *   blipToleranceMs    = min(L − M − 2H, D)   a network outage between servers shorter than
 *                        this never moves the panel or the database
 */
export function haTimings(failoverSeconds) {
  const seconds = effectiveFailoverSeconds(failoverSeconds);
  const T = seconds * 1000;
  const heartbeatMs = clamp(r100(T / 15), HEARTBEAT_MIN_MS, HEARTBEAT_MAX_MS);
  const leaseMs = clamp(r100(0.45 * T), LEASE_MIN_MS, LEASE_MAX_MS);
  const marginMs = Math.max(1000, r100(leaseMs / 5));
  const failoverMs = leaseMs - heartbeatMs;
  const requestTimeoutMs = Math.min(2500, Math.round(0.9 * heartbeatMs));
  const pollWaitS = clamp(Math.floor(failoverMs / 2500), 1, 5);
  const voterFreshMs = 2 * heartbeatMs + 2000;
  const tieBreakMs = Math.min(3000, Math.round(heartbeatMs / 2));
  const candidacyMs = Math.max(10_000, leaseMs + 2 * heartbeatMs);
  const fenceHooksMs = clamp(marginMs - 250, 750, 3000);
  const dbSilentMs = 3 * heartbeatMs;
  const dbProbeMs = Math.max(500, Math.round(heartbeatMs / 2));
  const dbTcpTimeoutMs = clamp(Math.round(0.8 * heartbeatMs), 800, 3000);
  const dbTcpFails = 3;
  const detectMs = Math.max(3000, r100(T / 3));

  const panelTakeoverMs = leaseMs + heartbeatMs + tieBreakMs + 500;
  const databaseFailoverMs = Math.max(panelTakeoverMs, detectMs) + (dbTcpFails - 1) * dbProbeMs + 700 + 1500;
  const blipToleranceMs = Math.max(0, Math.min(leaseMs - marginMs - 2 * heartbeatMs, detectMs));

  return {
    failoverSeconds: seconds,
    heartbeatMs,
    leaseMs,
    marginMs,
    failoverMs,
    requestTimeoutMs,
    pollWaitS,
    voterFreshMs,
    tieBreakMs,
    candidacyMs,
    fenceHooksMs,
    dbSilentMs,
    dbProbeMs,
    dbTcpTimeoutMs,
    dbTcpFails,
    detectMs,
    panelTakeoverMs,
    databaseFailoverMs,
    blipToleranceMs,
  };
}

/** What the API / UI show (seconds, one decimal). */
export function timingSummary(failoverSeconds) {
  const t = haTimings(failoverSeconds);
  const s = (ms) => Math.round(ms / 100) / 10;
  return {
    failoverSeconds: t.failoverSeconds,
    panelTakeoverSeconds: s(t.panelTakeoverMs),
    databaseFailoverSeconds: s(t.databaseFailoverMs),
    heartbeatSeconds: s(t.heartbeatMs),
    blipToleranceSeconds: s(t.blipToleranceMs),
    leaseSeconds: s(t.leaseMs),
    detectSeconds: s(t.detectMs),
    min: FAILOVER_SECONDS_MIN,
    max: FAILOVER_SECONDS_MAX,
    default: FAILOVER_SECONDS_DEFAULT,
  };
}

/** The part a leader advertises to voters and agents (vote replies, hello, poll). */
export function advertised(failoverSeconds) {
  const t = haTimings(failoverSeconds);
  return { failoverSeconds: t.failoverSeconds, heartbeatMs: t.heartbeatMs, leaseMs: t.leaseMs };
}

/** A lease length a node was told about → a safe number (legacy default when absent). */
export function cleanLeaseMs(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? clamp(Math.round(n), LEASE_MIN_MS, LEASE_MAX_MS) : LEGACY_LEASE_MS;
}

/** A heartbeat interval a node was told about → a safe number, or null when absent/garbage. */
export function cleanHeartbeatMs(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? clamp(Math.round(n), HEARTBEAT_MIN_MS, HEARTBEAT_MAX_MS) : null;
}
