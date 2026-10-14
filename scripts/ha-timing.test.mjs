// Unit tests for the failover timing (shared/ha-timing.mjs) and the voter's lease rules
// (shared/ha-voter.mjs). Run: node --test scripts/ha-timing.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  haTimings,
  timingSummary,
  checkFailoverSeconds,
  effectiveFailoverSeconds,
  cleanLeaseMs,
  LEGACY_LEASE_MS,
  FAILOVER_SECONDS_MIN,
  FAILOVER_SECONDS_MAX,
} from "../shared/ha-timing.mjs";
import { createVoter } from "../shared/ha-voter.mjs";

test("validation", () => {
  assert.equal(checkFailoverSeconds(15), 15);
  assert.equal(checkFailoverSeconds("30"), 30);
  for (const bad of [9, 301, 15.5, "abc", "", null, undefined, -1, NaN, Infinity, {}, []]) assert.equal(checkFailoverSeconds(bad), null, String(bad));
  assert.equal(effectiveFailoverSeconds(undefined), 15);
  assert.equal(effectiveFailoverSeconds(7), 15);
  assert.equal(effectiveFailoverSeconds(120), 120);
});

test("the 15 s budget", () => {
  const t = haTimings(15);
  assert.deepEqual(
    { H: t.heartbeatMs, L: t.leaseMs, M: t.marginMs, F: t.failoverMs, req: t.requestTimeoutMs, poll: t.pollWaitS, D: t.detectMs },
    { H: 1000, L: 6800, M: 1400, F: 5800, req: 900, poll: 2, D: 5000 },
  );
  assert.ok(t.databaseFailoverMs <= 15_000, `estimate ${t.databaseFailoverMs}`);
  assert.ok(t.blipToleranceMs >= 3000, "a 3 s outage between servers is ignored");
});

test("invariants for every allowed value", () => {
  let prev = null;
  for (let s = FAILOVER_SECONDS_MIN; s <= FAILOVER_SECONDS_MAX; s++) {
    const t = haTimings(s);
    const T = s * 1000;
    assert.ok(t.heartbeatMs >= 1000 && t.heartbeatMs <= 5000, `${s}: heartbeat`);
    assert.ok(t.requestTimeoutMs < t.heartbeatMs, `${s}: request timeout below the heartbeat`);
    assert.ok(t.marginMs >= 1000, `${s}: margin`);
    // A leader renews every H; its grant view (L − M) must outlast two heartbeats.
    assert.ok(t.leaseMs - t.marginMs >= 2 * t.heartbeatMs + 500, `${s}: renewal room`);
    assert.ok(t.failoverMs > 0 && t.pollWaitS * 1000 + 1000 < t.failoverMs, `${s}: long poll well under the standby window`);
    assert.ok(t.fenceHooksMs < t.marginMs, `${s}: fence hooks finish inside the margin`);
    assert.ok(t.dbTcpTimeoutMs >= 800, `${s}: tcp timeout`);
    assert.ok(t.detectMs >= t.dbSilentMs, `${s}: detection window covers the silence threshold`);
    assert.ok(t.databaseFailoverMs <= T, `${s}: worst-case estimate ${t.databaseFailoverMs} fits ${T}`);
    assert.ok(t.blipToleranceMs > 0, `${s}: some blip tolerance`);
    if (prev) {
      assert.ok(t.leaseMs >= prev.leaseMs && t.detectMs >= prev.detectMs && t.heartbeatMs >= prev.heartbeatMs, `${s}: monotonic`);
    }
    prev = t;
  }
  // 60 s is roughly the pre-3.10 behaviour (heartbeat 3 s, lease 15 s, standby 20 s).
  const old = haTimings(60);
  assert.ok(old.leaseMs >= 15_000 && old.failoverMs >= 20_000, "60 s ≈ the old timings");
});

test("summary", () => {
  const s = timingSummary(15);
  assert.equal(s.failoverSeconds, 15);
  assert.equal(s.heartbeatSeconds, 1);
  assert.ok(s.panelTakeoverSeconds < s.databaseFailoverSeconds && s.databaseFailoverSeconds <= 15);
});

test("a leader's view of a grant always ends before the voter's lease (any mix of versions and values)", () => {
  const leases = [undefined, 1000, 3000, 4500, 6800, 15000, 27000, 135000, 999999];
  for (let s = FAILOVER_SECONDS_MIN; s <= FAILOVER_SECONDS_MAX; s += 7) {
    const t = haTimings(s);
    for (const g of leases) {
      // what the voter holds: the request's lease (legacy 15 s without one), bounded
      const voterHolds = g === undefined ? LEGACY_LEASE_MS : cleanLeaseMs(g);
      // what the leader counts (panel/lib/ha.mjs grantUntil), from the same nonce
      const leaderCounts = Math.min(g === undefined ? LEGACY_LEASE_MS : cleanLeaseMs(g), t.leaseMs) - t.marginMs;
      assert.ok(leaderCounts + t.marginMs <= voterHolds, `${s}/${g}`);
    }
  }
});

// ---- the voter against a fake candidate panel

function fakePanel({ nodeId, leaseMs, onGrant }) {
  let nonce = 1;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const b = JSON.parse(body);
      if (b.grant) onGrant(b.grant, b);
      const reply = { nodeId, role: "leader", term: 5, leaderId: nodeId, proto: 2, timings: { heartbeatMs: 1000 } };
      if (!b.grant) reply.request = { candidate: nodeId, term: 5, nonce: nonce++, ...(server.leaseMs !== undefined ? { leaseMs: server.leaseMs } : {}), version: { term: 0, seq: 0 } };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  server.leaseMs = leaseMs;
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

test("voter: grants echo the requested lease, a shorter renewal never shortens the lease, legacy = 15 s", async () => {
  const grants = [];
  const srv = await fakePanel({ nodeId: "p1", leaseMs: 20_000, onGrant: (g) => grants.push(g) });
  let saved = null;
  const v = createVoter({
    voterId: "v1",
    token: "x".repeat(32),
    load: () => ({ term: 1, votedFor: "p1", leaseMs: 1000 }), // a short restart hold so the test does not wait
    save: (st) => (saved = st),
    panels: () => [{ serverId: "p1", directUrl: `http://127.0.0.1:${srv.address().port}` }],
  });
  try {
    v.start();
    const wait = async (pred, ms = 5000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("timed out");
    };
    await wait(() => grants.length >= 1);
    assert.equal(grants[0].leaseMs, 20_000);
    assert.equal(saved.leaseMs >= 20_000 - 100, true, "saved before the grant");
    const left1 = v.status().leaseLeftMs;
    assert.ok(left1 > 18_000);
    srv.leaseMs = 4000; // the leader lowers its failover speed
    const n = grants.length;
    await wait(() => grants.length > n && grants.at(-1).leaseMs === 4000);
    assert.ok(v.status().leaseLeftMs > 15_000, "the 20 s lease already given is not shortened");
    srv.leaseMs = undefined; // a pre-3.10 leader: no leaseMs in the request
    const m = grants.length;
    await wait(() => grants.length > m && grants.at(-1).leaseMs === LEGACY_LEASE_MS);
  } finally {
    v.stop();
    srv.close();
  }
});
