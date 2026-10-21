// node --test scripts/ — the identity rewrite behind "Make main server" (panel/lib/main-switch.mjs).
import test from "node:test";
import assert from "node:assert/strict";

import { remapIdentity, remapKeys } from "../panel/lib/main-switch.mjs";

const X = "srv_x";
const R = "retired-main-20261021-1200";

function fixture() {
  return {
    servers: [
      { id: "main", name: "VPS 100", role: "main", host: "74.208.73.199", tokenHash: "old", panel: { enabled: true, directUrl: "http://74.208.73.199:4000" } },
      { id: X, name: "VPS 202", role: "worker", host: "72.60.114.162", tokenHash: "xhash", weight: 1, lbEligible: true, edge: { enabled: true }, panel: { enabled: true, directUrl: "http://72.60.114.162:4000" }, info: { os: "Ubuntu" }, createdAt: "2026-01-01" },
      { id: "srv_y", name: "VPS 200", role: "worker", host: "74.208.99.144", tokenHash: "yhash" },
    ],
    sites: [
      { id: "site_a", serverIds: [X], state: { [X]: { running: true } } },
      { id: "site_b", loadBalanced: true, serverIds: [X, "srv_y"], state: { [X]: { ok: 1 }, srv_y: { ok: 2 } }, weights: { [X]: 3 } },
      { id: "site_c", serverIds: ["srv_y", "main"], state: { srv_y: {}, main: { stale: true } } },
      { id: "site_d", serverIds: ["srv_y"], state: { srv_y: {} }, github: { branch: "main" } },
    ],
    releases: [
      { id: "rel_1", built: { builtOn: "main" } },
      { id: "rel_2", built: { builtOn: X } },
      { id: "rel_3" },
    ],
    backups: [
      { id: "bak_1", kind: "server", serverId: "main", file: "server/main/server-main-1.tar.gz" },
      { id: "bak_2", kind: "server", serverId: X, file: `server/${X}/server-${X}-1.tar.gz` },
      { id: "bak_3", kind: "database", databaseId: "db_1", file: "db/p/x.sql.gz" },
    ],
    config: {
      panelUrl: "https://panel.example.com",
      ha: { enabled: true, armed: true, failoverSeconds: 15, handover: { to: X, from: "main" } },
      mysqlHa: { enabled: true, primary: X, replica: "srv_y", needsRebuild: ["main", X], serverIds: { main: 1, [X]: 2, srv_y: 3 } },
      backups: { server: { serverIds: ["main", X] } },
      cluster: { mainIps: ["74.208.73.199"], mainNginx: { version: "1.24" }, other: 1 },
      mysql: { publicHost: "74.208.73.199", port: 3306 },
    },
  };
}

test("the agent server becomes main; the old main record is gone", () => {
  const out = remapIdentity(fixture(), { fromId: X, retiredId: R, now: "T" });
  assert.deepEqual(out.servers.map((s) => s.id), ["main", "srv_y"]);
  const m = out.servers[0];
  assert.equal(m.name, "VPS 202");
  assert.equal(m.host, "72.60.114.162");
  assert.equal(m.role, "main");
  assert.equal(m.tokenHash, "xhash");
  assert.equal(m.edge, undefined);
  assert.deepEqual(m.panel, { enabled: true, directUrl: "http://72.60.114.162:4000" });
  assert.equal(m.previousId, X);
  assert.equal(m.createdAt, "2026-01-01");
});

test("sites: ids and per-server keys follow; the old main's entries are dropped", () => {
  const { sites } = remapIdentity(fixture(), { fromId: X, retiredId: R });
  const by = Object.fromEntries(sites.map((s) => [s.id, s]));
  assert.deepEqual(by.site_a.serverIds, ["main"]);
  assert.deepEqual(by.site_a.state, { main: { running: true } });
  assert.deepEqual(by.site_b.serverIds, ["main", "srv_y"]);
  assert.deepEqual(by.site_b.state, { main: { ok: 1 }, srv_y: { ok: 2 } });
  assert.deepEqual(by.site_b.weights, { main: 3 });
  assert.deepEqual(by.site_c.serverIds, ["srv_y"]);
  assert.deepEqual(by.site_c.state, { srv_y: {} });
  assert.equal(by.site_d.github.branch, "main", "never touches strings that merely say main");
});

test("releases and backups: X → main, old main → retired", () => {
  const out = remapIdentity(fixture(), { fromId: X, retiredId: R });
  assert.deepEqual(out.releases.map((r) => r.built?.builtOn ?? null), [R, "main", null]);
  const b = Object.fromEntries(out.backups.map((x) => [x.id, x]));
  assert.equal(b.bak_1.serverId, R);
  assert.equal(b.bak_1.serverName, "VPS 100 (old main)");
  assert.equal(b.bak_1.file, "server/main/server-main-1.tar.gz", "files stay where they are");
  assert.equal(b.bak_2.serverId, "main");
  assert.equal(b.bak_3.serverId, undefined);
});

test("config: replication, schedules, HA off, old-machine facts gone", () => {
  const { config: c } = remapIdentity(fixture(), { fromId: X, retiredId: R, now: "T" });
  assert.equal(c.mysqlHa.primary, "main");
  assert.equal(c.mysqlHa.replica, "srv_y");
  assert.deepEqual(c.mysqlHa.needsRebuild, ["main"]);
  assert.deepEqual(c.mysqlHa.serverIds, { main: 2, srv_y: 3 });
  assert.deepEqual(c.backups.server.serverIds, ["main"]);
  assert.deepEqual(c.ha, { enabled: false, failoverSeconds: 15 });
  assert.deepEqual(c.cluster, { other: 1 });
  assert.deepEqual(c.mysql, { port: 3306 });
  assert.equal(c.panelUrl, "https://panel.example.com");
  assert.deepEqual(c.retiredServers, [{ id: R, name: "VPS 100", host: "74.208.73.199", retiredAt: "T", replacedBy: X }]);
});

test("old main as replica: replica cleared", () => {
  const f = fixture();
  f.config.mysqlHa.replica = "main";
  assert.equal(remapIdentity(f, { fromId: X, retiredId: R }).config.mysqlHa.replica, null);
});

test("the inputs are not modified", () => {
  const f = fixture();
  const before = JSON.stringify(f);
  remapIdentity(f, { fromId: X, retiredId: R });
  assert.equal(JSON.stringify(f), before);
});

test("bad ids are refused", () => {
  assert.throws(() => remapIdentity(fixture(), { fromId: "main", retiredId: R }));
  assert.throws(() => remapIdentity(fixture(), { fromId: "srv_nope", retiredId: R }));
  assert.throws(() => remapIdentity(fixture(), { fromId: X, retiredId: "main" }));
});

test("metrics/usage keys", () => {
  const tree = {
    servers: { main: [1], [X]: [2], srv_y: [3] },
    latest: { main: {}, [X]: { cpu: 1 } },
    requests: { "srv:main": [9], [`srv:${X}`]: [8], "site:site_a": [7] },
    minute: { [`site_a|${X}`]: 1, "site_a|main": 2, "site_b|srv_y": 3 },
  };
  assert.deepEqual(remapKeys(tree, X), {
    servers: { main: [2], srv_y: [3] },
    latest: { main: { cpu: 1 } },
    requests: { "srv:main": [8], "site:site_a": [7] },
    minute: { "site_a|main": 1, "site_b|srv_y": 3 },
  });
});
