// node --test scripts/ — Cloudflare Tunnel routes (panel/lib/cloudflare.mjs): the
// ledger says what the panel wrote; these checks decide whether Cloudflare really
// has it (a staging hostname showed "Live through the tunnel" while the tunnel had
// no route for it).
import test from "node:test";
import assert from "node:assert/strict";

import { ingressHas, routeDrift, lostRoutes, DRIFT_CODES } from "../panel/lib/cloudflare.mjs";

const T1 = "de6d1677-e8f7-489b-bc48-5685d4bfcb50";
const T2 = "54b57743-cd55-44e4-b3c5-51342eb2fe84";
const rule = (hostname, extra = {}) => ({ hostname, service: "http://127.0.0.1:80", originRequest: { httpHostHeader: hostname }, ...extra });
const CATCH_ALL = { service: "http_status:404" };
const cname = (name, tunnelId = T1) => ({ type: "CNAME", name, content: `${tunnelId}.cfargotunnel.com`, proxied: true });
const row = (hostname, extra = {}) => ({ id: `cfr_${hostname}`, hostname, tunnelId: T1, status: "active", code: null, ...extra });

test("ingressHas: whole-hostname rules only, case-insensitive, never the catch-all", () => {
  const ingress = [rule("Shop.Example.com"), rule("api.example.com", { path: "/v1" }), CATCH_ALL];
  assert.equal(ingressHas(ingress, "shop.example.com"), true);
  assert.equal(ingressHas(ingress, "api.example.com"), false, "a path rule is not the hostname's route");
  assert.equal(ingressHas(ingress, "staging.shop.example.com"), false);
  assert.equal(ingressHas(ingress, ""), false);
  assert.equal(ingressHas(null, "shop.example.com"), false);
});

test("lostRoutes: the hostnames the panel wrote that are not there on read-back", () => {
  const after = [rule("shop.example.com"), CATCH_ALL];
  assert.deepEqual(lostRoutes(after, ["shop.example.com", "staging.shop.example.com"]), ["staging.shop.example.com"]);
  assert.deepEqual(lostRoutes(after, []), []);
});

test("routeDrift: an active row whose route is gone from the tunnel is route_missing", () => {
  const rows = [row("shop.example.com"), row("staging.shop.example.com")];
  const ingress = new Map([[T1, [rule("shop.example.com"), CATCH_ALL]]]);
  const dns = new Map([["shop.example.com", [cname("shop.example.com")]], ["staging.shop.example.com", [cname("staging.shop.example.com")]]]);
  const out = routeDrift(rows, ingress, dns);
  assert.deepEqual(out.map((x) => [x.hostname, x.route, x.dns, x.drift]), [
    ["shop.example.com", true, true, null],
    ["staging.shop.example.com", false, true, "route_missing"],
  ]);
});

test("routeDrift: a missing or foreign CNAME is dns_missing; a route problem wins over DNS", () => {
  const rows = [row("a.example.com"), row("b.example.com"), row("c.example.com")];
  const ingress = new Map([[T1, [rule("a.example.com"), rule("b.example.com"), CATCH_ALL]]]);
  const dns = new Map([
    ["a.example.com", []],
    ["b.example.com", [cname("b.example.com", T2), { type: "A", name: "b.example.com", content: "1.2.3.4" }]],
    ["c.example.com", []],
  ]);
  assert.deepEqual(routeDrift(rows, ingress, dns).map((x) => x.drift), ["dns_missing", "dns_missing", "route_missing"]);
});

test("routeDrift: what couldn't be read is not judged", () => {
  const rows = [row("shop.example.com"), row("other.example.org", { tunnelId: T2 })];
  const out = routeDrift(rows, new Map([[T1, [CATCH_ALL]]]), new Map());
  assert.deepEqual(out.map((x) => [x.route, x.dns, x.drift]), [
    [false, null, "route_missing"],
    [null, null, null],
  ]);
});

test("routeDrift: only active rows and rows an earlier check marked are looked at", () => {
  const rows = [
    row("a.example.com", { status: "error", code: "dns_conflict" }),
    row("b.example.com", { status: "manual" }),
    row("c.example.com", { status: "error", code: "route_missing" }),
  ];
  const ingress = new Map([[T1, [rule("c.example.com"), CATCH_ALL]]]);
  const dns = new Map([["c.example.com", [cname("c.example.com")]]]);
  const out = routeDrift(rows, ingress, dns);
  assert.deepEqual(out.map((x) => [x.hostname, x.drift]), [["c.example.com", null]], "a marked row that is back in Cloudflare has no drift any more");
  assert.deepEqual([...DRIFT_CODES], ["route_missing", "dns_missing"]);
});
