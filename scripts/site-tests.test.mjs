// node --test scripts/ — commit testing: the event protocol, the verdict rule,
// rewriting a site's variables for its throw-away copy, and stream-json → activity.
import test from "node:test";
import assert from "node:assert/strict";

import {
  EVENT_PREFIX,
  formatEvent,
  parseEventLine,
  cleanEvent,
  decideVerdict,
  computeScore,
  rewriteEnv,
  planDatabases,
  testDatabaseName,
  testDatabasePreview,
  STANDARD_DB_KEYS,
  isLivePaymentValue,
  makeRedactor,
  streamJsonEvents,
  describeTool,
  cleanReport,
  containerArgs,
  firewallRules,
  runNames,
  parseDockerDate,
  fillTemplate,
  imageHash,
  runSiteTest,
} from "../shared/testenv.mjs";
import { applyEvent, finalizeRun, newRun, mergeTestEnv, checkToken, cleanTesterInput, runSummary } from "../panel/lib/site-tests.mjs";

// ------------------------------------------------------------ protocol

test("events round-trip through a log line", () => {
  const line = formatEvent({ t: "check", id: "auth.login", category: "auth", title: "Login", status: "pass", detail: "ok" });
  assert.ok(line.startsWith(EVENT_PREFIX));
  assert.deepEqual(parseEventLine(line), { t: "check", id: "auth.login", category: "auth", title: "Login", status: "pass", detail: "ok" });
  // An agent may prefix log lines (server tag); the event is still found.
  assert.equal(parseEventLine(`[VPS 2] ${line}`).id, "auth.login");
});

test("the parser refuses malformed, nested and unknown events", () => {
  assert.equal(parseEventLine("just a log line"), null);
  assert.equal(parseEventLine(`${EVENT_PREFIX}{not json`), null);
  assert.equal(parseEventLine(`${EVENT_PREFIX}[1,2]`), null);
  assert.equal(parseEventLine(`${EVENT_PREFIX}${JSON.stringify({ t: "check", title: "x", detail: { nested: true } })}`), null);
  assert.equal(parseEventLine(`${EVENT_PREFIX}${JSON.stringify({ t: "explode" })}`), null);
  assert.equal(parseEventLine(`${EVENT_PREFIX}${JSON.stringify({ t: "finding", severity: "high" })}`), null, "a finding needs a title");
});

test("events are normalised: enums, ids, lengths", () => {
  const f = cleanEvent({ t: "finding", severity: "HIGH", category: "nope", title: "Cart total trusts the browser", detail: "x".repeat(10_000) });
  assert.equal(f.severity, "high");
  assert.equal(f.category, "security");
  assert.equal(f.id, "security.cart-total-trusts-the-browser");
  assert.ok(f.detail.length <= 4000);
  const c = cleanEvent({ t: "check", title: "Checkout", category: "payments", status: "weird" });
  assert.equal(c.status, "running");
  assert.equal(c.id, "payments.checkout");
  assert.deepEqual(cleanEvent({ t: "note", text: "  hello  world " }), { t: "activity", kind: "info", text: "hello world" });
  assert.equal(cleanEvent({ t: "report", verdict: "maybe", score: 140 }).score, 100);
  assert.equal(cleanEvent({ t: "report", verdict: "maybe" }).verdict, null);
});

// ------------------------------------------------------------- verdict

test("verdict rule: critical/high findings or failed blocking checks mean not ready", () => {
  assert.equal(decideVerdict({ checks: [{ category: "auth", status: "pass" }], findings: [{ severity: "medium" }] }).verdict, "ready");
  assert.equal(decideVerdict({ findings: [{ severity: "high" }] }).verdict, "not_ready");
  assert.equal(decideVerdict({ findings: [{ severity: "critical" }] }).verdict, "not_ready");
  for (const category of ["payments", "auth", "features"]) {
    assert.equal(decideVerdict({ checks: [{ category, status: "fail" }] }).verdict, "not_ready", category);
  }
  // A failed check outside the blocking categories alone does not block…
  assert.equal(decideVerdict({ checks: [{ category: "security", status: "fail" }] }).verdict, "ready");
  // …but the tester's own "not ready" and an unfinished run do.
  assert.equal(decideVerdict({ reported: "not_ready" }).verdict, "not_ready");
  assert.equal(decideVerdict({ complete: false }).verdict, "not_ready");
  // The tester can't overrule the rule upwards.
  assert.equal(decideVerdict({ findings: [{ severity: "high" }], reported: "ready" }).verdict, "not_ready");
});

test("score: tester's score kept, computed otherwise, capped for not-ready", () => {
  assert.equal(computeScore({ reported: 91, verdict: "ready" }), 91);
  assert.equal(computeScore({ reported: 91, verdict: "not_ready" }), 69);
  assert.equal(computeScore({ findings: [{ severity: "medium" }, { severity: "low" }], verdict: "ready" }), 93);
  assert.equal(computeScore({ findings: Array(10).fill({ severity: "critical" }), verdict: "not_ready" }), 0);
});

// ------------------------------------------------------------ variables

const DB = { prefix: "", host: "db1", port: "3306", name: "shop", user: "t_abc", password: "throwaway-pw" };
const MAIL = { host: "mail", port: "1025" };

test("linked database variables are re-pointed at the throw-away database", () => {
  const linked = [{ prefix: "", vars: { DB_HOST: "10.0.0.5", DB_PORT: "3306", DB_NAME: "shop", DB_USER: "shop", DB_PASSWORD: "prod-secret", DATABASE_URL: "mysql://shop:prod-secret@10.0.0.5:3306/shop" } }];
  const env = { ...linked[0].vars, APP_NAME: "Shop" };
  const r = rewriteEnv({ env, linked, databases: [DB], mail: MAIL });
  assert.equal(r.env.DB_HOST, "db1");
  assert.equal(r.env.DB_USER, "t_abc");
  assert.equal(r.env.DB_PASSWORD, "throwaway-pw");
  assert.equal(r.env.DATABASE_URL, "mysql://t_abc:throwaway-pw@db1:3306/shop");
  assert.equal(r.env.APP_NAME, "Shop");
  assert.ok(!JSON.stringify(r.env).includes("prod-secret"));
  assert.ok(!JSON.stringify(r.env).includes("10.0.0.5"));
});

test("a second linked database keeps its prefix", () => {
  const linked = [
    { prefix: "", vars: { DB_HOST: "h", DATABASE_URL: "mysql://a:b@h:3306/one" } },
    { prefix: "ANALYTICS_", vars: { ANALYTICS_DB_HOST: "h", ANALYTICS_DATABASE_URL: "mysql://a:b@h:3306/two" } },
  ];
  const dbs = [DB, { ...DB, prefix: "ANALYTICS_", host: "db2", name: "two" }];
  const r = rewriteEnv({ env: { ...linked[0].vars, ...linked[1].vars }, linked, databases: dbs });
  assert.equal(r.env.DB_HOST, "db1");
  assert.equal(r.env.ANALYTICS_DB_HOST, "db2");
  assert.equal(r.env.ANALYTICS_DATABASE_URL, "mysql://t_abc:throwaway-pw@db2:3306/two");
});

test("database settings typed into the site's own variables are re-pointed too", () => {
  const env = { DATABASE_URL: "mysql://root:pw@prod.example.com:3306/shop", MYSQL_HOST: "prod.example.com", MYSQL_PASSWORD: "pw", REDIS_URL: "redis://prod:6379", PG: "postgres://u:p@h/db" };
  assert.deepEqual(planDatabases(env, []).map((d) => d.name), ["shop"]);
  const r = rewriteEnv({ env, databases: [DB] });
  assert.equal(r.env.DATABASE_URL, "mysql://t_abc:throwaway-pw@db1:3306/shop");
  assert.equal(r.env.MYSQL_HOST, "db1");
  assert.equal(r.env.MYSQL_PASSWORD, "throwaway-pw");
  assert.ok(!("REDIS_URL" in r.env) && !("PG" in r.env), "other production data stores are removed");
  // Without a throw-away database, nothing may keep pointing at production.
  const none = rewriteEnv({ env: { DATABASE_URL: "mysql://root:pw@prod:3306/shop", DB_HOST: "prod" } });
  assert.deepEqual(Object.keys(none.env).sort(), ["NODE_ENV"]);
});

test("the throw-away database is named test_<site slug>, MySQL-safe", () => {
  assert.equal(testDatabaseName("acme-web"), "test_acme_web");
  assert.equal(testDatabaseName("Acme Web!!"), "test_acme_web");
  assert.equal(testDatabaseName("shop", 1), "test_shop_2");
  assert.equal(testDatabaseName(""), "test_site");
  const long = testDatabaseName("x".repeat(90), 2);
  assert.ok(long.length <= 64 && long.endsWith("_3") && /^[a-z0-9_]+$/.test(long));
});

test("with a slug every database is test_<slug>; linked prefixes are kept", () => {
  const linked = [
    { prefix: "", name: "acme_prod", vars: { DB_HOST: "h", DB_NAME: "acme_prod", DATABASE_URL: "mysql://a:b@h:3306/acme_prod" } },
    { prefix: "QUEUE_", name: "acme_queue", vars: { QUEUE_DB_HOST: "h", QUEUE_DB_NAME: "acme_queue" } },
  ];
  const plan = planDatabases({ ...linked[0].vars, ...linked[1].vars }, linked, { slug: "acme-web", type: "node" });
  assert.deepEqual(plan.map((p) => [p.prefix, p.name]), [["", "test_acme_web"], ["QUEUE_", "test_acme_web_2"]]);
  assert.ok(plan.every((p) => !p.add));
  // Own variables: re-pointed, named after the site now.
  assert.deepEqual(planDatabases({ DATABASE_URL: "mysql://r:p@prod:3306/shop" }, [], { slug: "shop-site", type: "php" }).map((p) => p.name), ["test_shop_site"]);
  // Older callers (no slug/type): the production name, as before.
  assert.deepEqual(planDatabases({ DATABASE_URL: "mysql://r:p@prod:3306/shop" }, []).map((p) => p.name), ["shop"]);
});

test("a node/php site without any database still gets test_<slug> and the standard variables", () => {
  const plan = planDatabases({ APP_NAME: "Blog" }, [], { slug: "blog", type: "node" });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].name, "test_blog");
  assert.equal(plan[0].add, true);
  assert.deepEqual(planDatabases({}, [], { slug: "landing", type: "static" }), [], "static sites get none");
  assert.deepEqual(planDatabases({}, []), [], "older callers: none");
  const d = { ...DB, name: "test_blog", add: true };
  const r = rewriteEnv({ env: { APP_NAME: "Blog", DB_PORT: "3307" }, databases: [d] });
  for (const k of STANDARD_DB_KEYS) assert.ok(k in r.env, `${k} added`);
  assert.equal(r.env.DB_NAME, "test_blog");
  assert.equal(r.env.DB_HOST, "db1");
  assert.equal(r.env.DATABASE_URL, "mysql://t_abc:throwaway-pw@db1:3306/test_blog");
  assert.equal(r.env.DB_PORT, "3306", "an own DB_PORT is re-pointed too");
  assert.equal(r.env.APP_NAME, "Blog");
  // Test-only variables still win over the added ones.
  assert.equal(rewriteEnv({ env: {}, databases: [d], testEnv: { DB_NAME: "mine" } }).env.DB_NAME, "mine");
});

test("the Test view's database preview: host and name filled in, credentials random per run", () => {
  const none = testDatabasePreview({ APP: "x" }, [], { slug: "acme-web", type: "node" });
  assert.deepEqual(none.databases.map((d) => [d.name, d.host, d.added]), [["test_acme_web", "db1", true]]);
  const byKey = Object.fromEntries(none.vars.map((v) => [v.key, v]));
  assert.deepEqual(Object.keys(byKey).sort(), [...STANDARD_DB_KEYS].sort());
  assert.equal(byKey.DB_NAME.value, "test_acme_web");
  assert.equal(byKey.DB_HOST.value, "db1");
  assert.ok(byKey.DB_USER.random && byKey.DB_PASSWORD.random && byKey.DATABASE_URL.random);
  assert.ok(!byKey.DB_NAME.random);
  const linked = [{ prefix: "", name: "p", vars: { DB_HOST: "10.0.0.5", DB_PASSWORD: "prod-secret" } }];
  const one = testDatabasePreview(linked[0].vars, linked, { slug: "shop", type: "node" });
  assert.ok(!JSON.stringify(one).includes("prod-secret") && !JSON.stringify(one).includes("10.0.0.5"));
  assert.equal(one.databases[0].added, false);
});

test("live payment keys are removed; test-only variables applied on top", () => {
  const env = {
    STRIPE_SECRET_KEY: "sk_live_abcdefghijklmnop",
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_abcdefghijklmnop",
    STRIPE_RESTRICTED: "rk_live_abcdefghijklmnop",
    STRIPE_WEBHOOK_SECRET: "whsec_abcdefghijkl",
    MOLLIE_API_KEY: "live_abcdefghijklmnopqrstuvwx",
    PAYPAL_MODE: "live",
    PAYPAL_CLIENT_SECRET: "real-paypal-secret",
    STRIPE_LIVE_SECRET: "anything",
  };
  const testEnv = { STRIPE_SECRET_KEY: "sk_test_123456789", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_123456789", BAD: "sk_live_should_not_apply_x" };
  const r = rewriteEnv({ env, testEnv });
  assert.equal(r.env.STRIPE_SECRET_KEY, "sk_test_123456789");
  assert.equal(r.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, "pk_test_123456789");
  for (const k of ["STRIPE_RESTRICTED", "STRIPE_WEBHOOK_SECRET", "MOLLIE_API_KEY", "PAYPAL_CLIENT_SECRET", "STRIPE_LIVE_SECRET", "BAD"]) assert.ok(!(k in r.env), k);
  assert.equal(r.env.PAYPAL_MODE, "sandbox");
  assert.ok(!Object.values(r.env).some(isLivePaymentValue));
  assert.ok(r.notes.some((n) => /BAD.*NOT applied/.test(n)));
});

test("a test-mode webhook secret stays when there were no live keys", () => {
  const r = rewriteEnv({ env: { STRIPE_SECRET_KEY: "sk_test_x123456", STRIPE_WEBHOOK_SECRET: "whsec_test123456" } });
  assert.equal(r.env.STRIPE_WEBHOOK_SECRET, "whsec_test123456");
});

test("mail goes to the catcher; sending APIs, SMS and chat webhooks are removed", () => {
  const env = {
    SMTP_HOST: "smtp.gmail.com",
    SMTP_PORT: "465",
    SMTP_USER: "owner@example.com",
    SMTP_PASS: "app-password",
    SMTP_SECURE: "true",
    EMAIL_SERVER: "smtp://u:p@smtp.example.com:587",
    MAIL_ENCRYPTION: "tls",
    RESEND_API_KEY: "re_123",
    SENDGRID_API_KEY: "SG.123",
    TWILIO_AUTH_TOKEN: "tw",
    SLACK_URL: "https://hooks.slack.com/services/T/B/X",
    EMAIL_FROM: "shop@example.com",
  };
  const r = rewriteEnv({ env, mail: MAIL });
  assert.equal(r.env.SMTP_HOST, "mail");
  assert.equal(r.env.SMTP_PORT, "1025");
  assert.equal(r.env.SMTP_SECURE, "false");
  assert.equal(r.env.SMTP_PASS, "test");
  assert.equal(r.env.EMAIL_SERVER, "smtp://mail:1025");
  assert.equal(r.env.MAIL_ENCRYPTION, "");
  assert.equal(r.env.EMAIL_FROM, "shop@example.com", "a sender address is not a server");
  for (const k of ["RESEND_API_KEY", "SENDGRID_API_KEY", "TWILIO_AUTH_TOKEN", "SLACK_URL"]) assert.ok(!(k in r.env), k);
});

test("URLs of the production domain point at the test copy", () => {
  const env = { NEXTAUTH_URL: "https://www.acme.com", NEXT_PUBLIC_SITE_URL: "https://acme.com/shop", OTHER: "https://acme.com.evil.io/x", CDN: "https://cdn.other.com" };
  const r = rewriteEnv({ env, domains: ["acme.com", "www.acme.com"], testUrl: "http://site:3000", port: 3000 });
  assert.equal(r.env.NEXTAUTH_URL, "http://site:3000");
  assert.equal(r.env.NEXT_PUBLIC_SITE_URL, "http://site:3000/shop");
  assert.equal(r.env.OTHER, "https://acme.com.evil.io/x");
  assert.equal(r.env.CDN, "https://cdn.other.com");
  assert.equal(r.env.PORT, "3000");
});

// ------------------------------------------------------------ redaction

test("the redactor hides known secrets and secret-shaped text", () => {
  const redact = makeRedactor(["sk-ant-oat01-SUPERSECRETTOKEN", "throwaway-pw"]);
  const out = redact("token sk-ant-oat01-SUPERSECRETTOKEN pw=throwaway-pw sk_test_abcdefgh mysql://u:p4ss@db1/x Authorization: Bearer abcdefghijk password: hunter22");
  for (const s of ["SUPERSECRETTOKEN", "throwaway-pw", "abcdefgh", "p4ss", "abcdefghijk", "hunter22"]) assert.ok(!out.includes(s), `${s} leaked: ${out}`);
});

// ------------------------------------------------------ stream-json

test("stream-json lines become short activity", () => {
  const redact = makeRedactor(["sk_test_SECRET99"]);
  const init = streamJsonEvents(JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-4-5" }));
  assert.equal(init.activity[0].kind, "info");
  const a = streamJsonEvents(
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "Checking the checkout\nnow." },
          { type: "tool_use", name: "Bash", input: { command: "curl -H 'Authorization: Bearer sk_test_SECRET99' http://site:3000/api/x" } },
          { type: "tool_use", name: "mcp__playwright__browser_type", input: { element: "Password", text: "hunter2" } },
        ],
      },
    }),
    redact,
  );
  assert.deepEqual(a.activity.map((x) => x.kind), ["think", "tool", "tool"]);
  assert.equal(a.activity[0].text, "Checking the checkout now.");
  assert.ok(!a.activity[1].text.includes("SECRET99"));
  assert.ok(!JSON.stringify(a).includes("hunter2"), "typed text is never shown");
  assert.ok(!JSON.stringify(a).includes("private"), "thinking is not forwarded");
  const err = streamJsonEvents(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "boom" }] } }));
  assert.equal(err.activity[0].kind, "error");
  const done = streamJsonEvents(JSON.stringify({ type: "result", subtype: "error_max_turns", num_turns: 200, duration_ms: 1234, is_error: true }));
  assert.deepEqual(done.usage, { turns: 200, durationMs: 1234 });
  assert.equal(done.result.ok, false);
  assert.match(done.activity[0].text, /turn limit/);
  assert.equal(streamJsonEvents("not json at all").activity[0].kind, "info");
  assert.deepEqual(streamJsonEvents("").activity, []);
});

test("tool descriptions are plain and short", () => {
  assert.equal(describeTool("Read", { file_path: "/app/src/x.ts" }), "Read src/x.ts");
  assert.equal(describeTool("Bash", { command: "ls", description: "List files" }), "Ran: List files");
  assert.equal(describeTool("mcp__playwright__browser_navigate", { url: "http://site:3000/cart" }), "Browser: navigate http://site:3000/cart");
});

test("report.json is validated and capped", () => {
  const r = cleanReport({ verdict: "ready", score: "88", summary: "ok", checks: [{ id: "a.b", category: "auth", title: "x", status: "pass" }, "junk"], findings: [{ title: "t", severity: "low", category: "config", fix: "f" }, { nope: 1 }] });
  assert.equal(r.score, 88);
  assert.equal(r.checks.length, 1);
  assert.equal(r.findings.length, 1);
  assert.equal(cleanReport(null), null);
});

// ------------------------------------------------------ container args

test("every test container is hardened, labelled and keeps secrets off the command line", () => {
  const n = runNames("trn_abc123");
  const a = containerArgs({ name: n.mail, image: "img", runId: "trn_abc123", uid: 29001, network: n.internal, alias: "mail", env: { SECRET: "s3cr3t" }, readOnly: true, groupAdd: 29001 });
  const s = a.args.join(" ");
  for (const want of ["--cap-drop ALL", "no-new-privileges", "--user 29001:29001", "--label fcc.test=trn_abc123", "--network fcc-t-trn_abc123", "--network-alias mail", "--read-only", "--restart no", "--group-add 29001", "-e SECRET"]) assert.ok(s.includes(want), want);
  assert.ok(!s.includes("s3cr3t"));
  assert.equal(a.env.SECRET, "s3cr3t");
  assert.throws(() => containerArgs({ name: "x", image: "i", runId: "r", uid: 0 }), /non-root/);
  assert.ok(n.internalIf.length <= 15 && n.egressIf.length <= 15);
  assert.throws(() => runNames("../etc"), /not a valid/);
});

test("firewall rules block the host, private ranges and cluster addresses", () => {
  const rules = firewallRules("trn_abc123", { internalIf: "fcctXi", egressIf: "fcctXx", blockIps: ["74.208.73.199", "::1", "74.208.73.199"] });
  const text = rules.map(([c, a]) => `${c} ${a.join(" ")}`);
  assert.ok(text.includes("INPUT -i fcctXi -m comment --comment fcc.test=trn_abc123 -j DROP"));
  assert.ok(text.includes("INPUT -i fcctXx -m comment --comment fcc.test=trn_abc123 -j DROP"));
  assert.ok(text.some((t) => t.includes("-d 169.254.0.0/16")));
  assert.ok(text.some((t) => t.includes("-d 10.0.0.0/8")));
  assert.equal(text.filter((t) => t.includes("74.208.73.199/32")).length, 1);
  assert.ok(!text.some((t) => t.includes("::1")));
});

test("small helpers", () => {
  assert.equal(parseDockerDate("2026-10-30 12:00:00 +0000 UTC"), Date.parse("2026-10-30T12:00:00Z"));
  assert.ok(Number.isNaN(parseDockerDate("garbage")));
  assert.equal(fillTemplate("Hi {{URL}} {{MISSING}}!", { URL: "http://site:3000" }), "Hi http://site:3000 !");
  assert.equal(imageHash({ a: "1", b: "2" }), imageHash({ b: "2", a: "1" }));
  assert.notEqual(imageHash({ a: "1" }), imageHash({ a: "2" }));
});

// ------------------------------------------------------- panel side

const SITE = { id: "site_1", projectId: "prj_1", name: "Shop" };
const RELEASE = { id: "rel_1", version: "1.2.0", github: { sha: "0123456789abcdef", message: "Fix cart\n\nmore", author: "Ann" } };

function freshRun() {
  return { id: "trn_1", createdAt: "2026-10-30T10:00:00Z", ...newRun({ site: SITE, release: RELEASE, serverId: "main", adminId: "adm_1" }) };
}

test("a new run carries the commit", () => {
  const r = freshRun();
  assert.deepEqual(r.commit, { sha: "0123456789abcdef", shortSha: "0123456", message: "Fix cart", author: "Ann" });
  assert.equal(r.status, "queued");
});

test("events fold into the run; checks keep their timing, findings merge", () => {
  const r = freshRun();
  applyEvent(r, { t: "phase", status: "preparing", phase: "Starting" }, "T1");
  applyEvent(r, { t: "env", url: "http://site:3000", database: true, mail: true });
  applyEvent(r, { t: "check", id: "auth.login", category: "auth", title: "Login", status: "running", detail: "" }, "T2");
  applyEvent(r, { t: "check", id: "auth.login", category: "auth", title: "Login", status: "pass", detail: "ok" }, "T3");
  applyEvent(r, { t: "finding", id: "a", severity: "low", category: "config", title: "No rate limit", detail: "d", fix: "", location: "" });
  applyEvent(r, { t: "finding", id: "b", severity: "medium", category: "config", title: "no rate LIMIT", detail: "", fix: "add one", location: "x.ts" });
  for (let i = 0; i < 320; i++) applyEvent(r, { t: "activity", kind: "tool", text: `step ${i}` });
  assert.equal(r.status, "preparing");
  assert.equal(r.startedAt, "T1");
  assert.deepEqual(r.env, { url: "http://site:3000", database: true, mail: true });
  assert.deepEqual(r.checks[0], { id: "auth.login", category: "auth", title: "Login", status: "pass", detail: "ok", startedAt: "T2", finishedAt: "T3" });
  assert.equal(r.findings.length, 1, "same category + title is one finding");
  assert.equal(r.findings[0].severity, "medium");
  assert.equal(r.findings[0].fix, "add one");
  assert.equal(r.findings[0].detail, "d");
  assert.equal(r.activity.length, 300);
  assert.equal(r.activity.at(-1).text, "step 319");
});

test("the report applies the rule, and finishing closes the run", () => {
  const r = freshRun();
  applyEvent(r, { t: "phase", status: "testing", phase: "Testing" });
  applyEvent(r, { t: "check", id: "payments.checkout", category: "payments", title: "Checkout", status: "fail", detail: "" });
  applyEvent(r, { t: "check", id: "features.cart", category: "features", title: "Cart", status: "running", detail: "" });
  applyEvent(r, { t: "report", verdict: "ready", score: 95, summary: "Looks good", complete: true });
  assert.equal(r.verdict, "not_ready", "a failed payments check overrules the tester");
  assert.equal(r.score, 69);
  finalizeRun(r, {}, "T9");
  assert.equal(r.status, "done");
  assert.equal(r.checks[1].status, "skip", "unfinished checks are closed");
  // Events after the end are ignored.
  applyEvent(r, { t: "phase", status: "testing", phase: "again" });
  assert.equal(r.status, "done");
  const s = runSummary(r);
  assert.equal(s.counts.failed, 1);
  assert.ok(!("activity" in s));
});

test("a run without a report is never ready; cancel and error are recorded", () => {
  const r = freshRun();
  applyEvent(r, { t: "phase", status: "testing", phase: "Testing" });
  finalizeRun(r, { result: { complete: false } });
  assert.equal(r.verdict, "not_ready");
  const c = freshRun();
  finalizeRun(c, { cancelled: true });
  assert.equal(c.status, "cancelled");
  const e = freshRun();
  finalizeRun(e, { error: "Docker is not running" });
  assert.equal(e.status, "error");
  assert.equal(e.error, "Docker is not running");
});

test("test-only variables: validated, encrypted, live keys refused, null removes", () => {
  const enc = (v) => `enc(${v})`;
  const env = mergeTestEnv({ OLD: "enc(x)" }, { STRIPE_SECRET_KEY: "sk_test_1", OLD: null }, enc);
  assert.deepEqual(env, { STRIPE_SECRET_KEY: "enc(sk_test_1)" });
  assert.throws(() => mergeTestEnv({}, { STRIPE_SECRET_KEY: "sk_live_abc" }, enc), /LIVE/);
  assert.throws(() => mergeTestEnv({}, { "BAD KEY": "x" }, enc), /not a valid/);
});

test("tester settings: token shape, API keys refused, limits", () => {
  assert.equal(checkToken("  sk-ant-oat01-abcdefghijklmnopqrstuvwxyz  "), "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz");
  assert.throws(() => checkToken("sk-ant-api03-abcdefghijklmnopqrstuvwxyz"), /API key/);
  assert.throws(() => checkToken("short"), /doesn't look like/);
  assert.deepEqual(cleanTesterInput({ model: "opus", maxMinutes: 30, serverId: "" }, { tokenEnc: "x" }), { tokenEnc: "x", model: "opus", maxMinutes: 30, serverId: "" });
  assert.throws(() => cleanTesterInput({ maxMinutes: 5 }), /between 10 and 180/);
  assert.throws(() => cleanTesterInput({ model: "rm -rf" }), /not valid/);
  assert.throws(() => cleanTesterInput({ serverId: "srv_x" }, {}, { serverExists: () => false }), /no server/);
});

// --------------------------------------------- the runner's input checks

test("the runner refuses a bad run id before touching anything", async () => {
  await assert.rejects(() => runSiteTest({ runId: "../../x" }, {}), /not a valid test run id/);
});

// ---- regressions from the first real runs

test("the tester's in-container mounts (/app, /out) are accepted; host paths still need two levels", async () => {
  const docker = await import("../shared/docker.mjs");
  const flags = docker.baseFlags({ uid: 20000, mounts: [{ src: "/var/lib/fcc/tests/x/app", dst: "/app", ro: true }], workdir: "/out" });
  assert.ok(flags.includes("type=bind,src=/var/lib/fcc/tests/x/app,dst=/app,readonly"));
  assert.throws(() => docker.baseFlags({ uid: 20000, mounts: [{ src: "/srv" }] }), /Refusing/);
  assert.throws(() => docker.baseFlags({ uid: 20000, mounts: [{ src: "/srv/a,dst=/etc" }] }), /Refusing/);
  assert.throws(() => docker.baseFlags({ uid: 20000, mounts: [{ src: "/srv/a", dst: "/" }] }), /container/);
});

test("schemaSteps: after-deploy scripts first, then Prisma migrations, then db push", async () => {
  const { schemaSteps } = await import("../shared/testenv.mjs");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fcc-schema-"));
  assert.deepEqual(schemaSteps([], dir, "node"), []);
  fs.mkdirSync(path.join(dir, "prisma"));
  fs.writeFileSync(path.join(dir, "prisma", "schema.prisma"), "");
  assert.equal(schemaSteps([], dir, "node")[0][2], "npx prisma db push --skip-generate");
  fs.mkdirSync(path.join(dir, "prisma", "migrations", "20260101_init"), { recursive: true });
  assert.equal(schemaSteps(undefined, dir, "node")[0][2], "npx prisma migrate deploy");
  assert.equal(schemaSteps(["db:migrate"], dir, "node")[0][2], "npm run db:migrate");
  assert.deepEqual(schemaSteps([], dir, "php"), []);
});

// ---- the Testing page (GET /api/tests)

import { filterRuns, testStats } from "../panel/lib/site-tests.mjs";

test("filterRuns: newest first, by site / status / verdict, limit capped", () => {
  const runs = [
    { id: "a", siteId: "s1", status: "done", verdict: "ready", createdAt: "2026-10-01T10:00:00Z" },
    { id: "b", siteId: "s2", status: "testing", verdict: null, createdAt: "2026-10-03T10:00:00Z" },
    { id: "c", siteId: "s1", status: "done", verdict: "not_ready", createdAt: "2026-10-02T10:00:00Z" },
    { id: "d", siteId: "s1", status: "error", verdict: null, createdAt: "2026-09-30T10:00:00Z" },
  ];
  assert.deepEqual(filterRuns(runs).map((r) => r.id), ["b", "c", "a", "d"]);
  assert.deepEqual(filterRuns(runs, { siteId: "s1" }).map((r) => r.id), ["c", "a", "d"]);
  assert.deepEqual(filterRuns(runs, { status: "active" }).map((r) => r.id), ["b"]);
  assert.deepEqual(filterRuns(runs, { status: "finished" }).map((r) => r.id), ["c", "a", "d"]);
  assert.deepEqual(filterRuns(runs, { status: "error" }).map((r) => r.id), ["d"]);
  assert.deepEqual(filterRuns(runs, { verdict: "ready" }).map((r) => r.id), ["a"]);
  assert.deepEqual(filterRuns(runs, { limit: "2" }).map((r) => r.id), ["b", "c"]);
  assert.equal(filterRuns(runs, { limit: "nope" }).length, 4);
  assert.equal(filterRuns(Array.from({ length: 600 }, (_, i) => ({ id: String(i), createdAt: "" })), { limit: 9999 }).length, 500);
});

test("testStats: last 7 days, ready rate and average over judged runs, active and never-tested sites", () => {
  const at = Date.parse("2026-10-30T12:00:00Z");
  const ago = (d) => new Date(at - d * 86400000).toISOString();
  const runs = [
    { siteId: "s1", status: "done", verdict: "ready", score: 94, createdAt: ago(0.1) },
    { siteId: "s1", status: "done", verdict: "not_ready", score: 62, createdAt: ago(2) },
    { siteId: "s2", status: "error", verdict: null, score: null, createdAt: ago(3) },
    { siteId: "s2", status: "testing", verdict: null, score: null, createdAt: ago(0) },
    { siteId: "s1", status: "done", verdict: "ready", score: 40, createdAt: ago(9) }, // older than a week
  ];
  const s = testStats(runs, ["s1", "s2", "s3"], at);
  assert.equal(s.total, 5);
  assert.equal(s.last7d, 4);
  assert.equal(s.judged7d, 2);
  assert.equal(s.ready7d, 1);
  assert.equal(s.notReady7d, 1);
  assert.equal(s.failed7d, 1);
  assert.equal(s.readyRate, 50);
  assert.equal(s.avgScore, 78);
  assert.equal(s.active, 1);
  assert.equal(s.sitesTested, 2);
  assert.equal(s.sitesNeverTested, 1);
  assert.deepEqual(s.neverTestedIds, ["s3"]);
  const empty = testStats([], [], at);
  assert.equal(empty.readyRate, null);
  assert.equal(empty.avgScore, null);
});

// ---- plain-English findings (owner) next to the technical detail (agent)

test("findings and reports carry the owner's plain-English text", async () => {
  const { cleanEvent, cleanReport, plainFallback } = await import("../shared/testenv.mjs");
  const f = cleanEvent({ t: "finding", severity: "high", category: "auth", title: "Old reset links keep working", plain: "A used reset link still works.", detail: "GET /reset/abc → 200 after use", fix: "Delete the token once used." });
  assert.equal(f.plain, "A used reset link still works.");
  assert.equal(f.fix, "Delete the token once used.");
  const r = cleanReport({ verdict: "not_ready", score: 40, summary: "Tokens are not invalidated.", plainSummary: "Don't put this live yet.", findings: [{ severity: "low", category: "config", title: "x", plain: "y", fix: "z" }] });
  assert.equal(r.plainSummary, "Don't put this live yet.");
  assert.equal(r.findings[0].plain, "y");
  assert.match(plainFallback("not_ready", [{ severity: "low", title: "Small thing" }, { severity: "critical", title: "Big thing" }]), /Big thing; Small thing/);
  assert.match(plainFallback("ready", []), /safe to put live/);
});

test("the run keeps the plain summary from the report event", async () => {
  const { applyEvent } = await import("../panel/lib/site-tests.mjs");
  const run = { status: "testing", checks: [], findings: [], activity: [] };
  applyEvent(run, { t: "report", verdict: "ready", score: 90, summary: "tech", plainSummary: "plain", complete: true });
  assert.equal(run.plainSummary, "plain");
  assert.equal(run.summary, "tech");
});
