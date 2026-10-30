/**
 * Commit testing — the throw-away test environment and the tester run
 * (task `site.test`, docs/DOCKER-AND-TESTS.md §2).
 *
 *   runSiteTest(payload, { log, signal, dataDir, isMain, panelUrl, authToken })
 *
 * On the server chosen for tests, one run:
 *
 *   1. two docker networks per run: `fcc-t-<runId>` (internal — no way out)
 *      for everything, and `fcc-t-<runId>-x` (egress) only for the containers
 *      that need the internet (the build, the test copy, the tester). Host
 *      firewall rules (tagged fcc.test=<runId>) stop both bridges from reaching
 *      this host itself, and stop the egress bridge from reaching private
 *      ranges, cloud metadata and every server of the cluster — so nothing in
 *      a test can touch the panel, production websites or production MySQL;
 *   2. one empty MySQL container per database the site uses (random
 *      credentials); the site's variable names are re-pointed at it;
 *   3. a mail catcher (Mailpit); SMTP_* / MAIL_* variables are re-pointed at
 *      it and e-mail/SMS API keys are removed, so a test never reaches a person;
 *   4. the release unpacked into <dataDir>/tests/<runId>/app, installed and
 *      built in a `--rm` container, after-deploy scripts run, then started on
 *      the test network — with live payment keys REMOVED and the site's
 *      test-only variables applied on top;
 *   5. the `fcc-tester` image (panel/templates/tester, built once per server,
 *      rebuilt when its files change) runs Claude Code non-interactively
 *      against that copy only, with the owner's CLAUDE_CODE_OAUTH_TOKEN;
 *   6. progress goes back to the panel as log lines `@@fcc-test {json}` (flat
 *      objects — see formatEvent/parseEventLine), which panel/lib/site-tests.mjs
 *      folds into the test run;
 *   7. teardown in `finally` (also on cancel), plus a sweep of anything a
 *      crashed run left behind that is older than 6 hours.
 *
 * Every container: non-root, all capabilities dropped, no-new-privileges,
 * pids/memory limits, read-only root filesystem where the image allows it,
 * labelled fcc.test=<runId> (shared/docker.mjs baseFlags).
 *
 * The pure parts (event protocol, verdict rule, variable rewriting, the
 * stream-json → activity translation, argument builders) are exported for
 * scripts/site-tests.test.mjs. Under FCC_DRY_RUN the whole run is simulated
 * (about 40 s of realistic events, same protocol) so the UI works on a Mac.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dns from "node:dns";
import net from "node:net";

import * as sys from "../panel/lib/sys.mjs";
import * as docker from "./docker.mjs";
import { extractZip } from "./zip.mjs";
import { renderEnvBlock } from "./env.mjs";

// ------------------------------------------------------------- constants

export const EVENT_PREFIX = "@@fcc-test ";
export const CATEGORIES = ["setup", "payments", "database", "auth", "features", "security", "config"];
export const CHECK_STATUSES = ["pending", "running", "pass", "warn", "fail", "skip"];
export const SEVERITIES = ["critical", "high", "medium", "low", "info"];
export const RUN_STATUSES = ["queued", "preparing", "testing", "reporting", "done", "error", "cancelled"];
export const ACTIVITY_KINDS = ["info", "tool", "think", "error"];
/** A check failing in one of these makes the commit not ready, whatever its findings say. */
export const BLOCKING_CATEGORIES = ["payments", "auth", "features"];

export const TESTER_IMAGE = "fcc-tester:latest";
export const TESTER_UID = 10001; // the `tester` user baked into the image (Claude Code wants a passwd entry)
export const MYSQL_IMAGE = "mysql:8.4";
export const MAIL_IMAGE = "axllent/mailpit:latest";
export const PHP_IMAGE = "php:8.3-cli";
export const STALE_MS = 6 * 60 * 60_000;
export const DEFAULT_MAX_MINUTES = 45;
export const DEFAULT_MAX_TURNS = 200;

/** Where the tester finds things (filled into PROMPT.md). */
const MAIL_HOST = "mail";
const SITE_HOST = "site";
const MAIL_SMTP_PORT = 1025;
const MAIL_HTTP_PORT = 8025;
/** Public resolvers for the egress containers, so DNS never depends on a private-range resolver the firewall blocks. */
const PUBLIC_DNS = ["1.1.1.1", "9.9.9.9"];
/** Destinations the egress bridge may never reach (RFC 1918, CGNAT, link-local incl. cloud metadata, loopback). */
export const BLOCKED_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8"];

const NOOP = () => {};
const now = () => new Date().toISOString();
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,40}$/;

// ------------------------------------------------------------ small helpers

function clip(s, n) {
  const v = String(s ?? "");
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
}
function oneLine(s, n) {
  return clip(String(s ?? "").replace(/\s+/g, " ").trim(), n);
}
function slug(s, n = 48) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, n) || "item";
}
function abortError() {
  return Object.assign(new Error("Cancelled."), { aborted: true });
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}
const randomSecret = (bytes = 18) => crypto.randomBytes(bytes).toString("base64url");
const hashInt = (s) => crypto.createHash("sha256").update(String(s)).digest().readUInt32BE(0);

/** The uid:gid every container of a run (except the tester) runs as — unique-ish per run, well clear of site uids. */
export function testUid(runId) {
  return 29000 + (hashInt(runId) % 900);
}

/** Container, network and bridge names of a run. Bridge names must stay ≤ 15 characters (Linux interface names). */
export function runNames(runId) {
  if (!ID_RE.test(String(runId || ""))) throw new Error("That is not a valid test run id.");
  const base = `fcc-t-${runId}`;
  const h = crypto.createHash("sha256").update(String(runId)).digest("hex").slice(0, 8);
  return {
    base,
    internal: base,
    egress: `${base}-x`,
    internalIf: `fcct${h}i`,
    egressIf: `fcct${h}x`,
    mail: `${base}-mail`,
    site: `${base}-site`,
    tester: `${base}-tester`,
    db: (i) => `${base}-db${i + 1}`,
    step: (n) => `${base}-${n}`,
    label: `fcc.test=${runId}`,
  };
}

// ------------------------------------------------------- event protocol

const EVENT_FIELDS = {
  phase: ["status", "phase"],
  env: ["url", "database", "mail"],
  check: ["id", "category", "title", "status", "detail"],
  finding: ["id", "severity", "category", "title", "plain", "detail", "fix", "location"],
  activity: ["kind", "text"],
  usage: ["turns", "durationMs"],
  report: ["verdict", "score", "summary", "plainSummary", "complete"],
};

const pick = (v, list, dflt) => (list.includes(v) ? v : dflt);
const cleanId = (v, fallback) => {
  const s = String(v ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(s) ? s : fallback;
};

/**
 * Validate and normalise one event (from the runner, fcc-report, or a log
 * line). Returns a flat object or null when it is not a usable event.
 */
export function cleanEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const t = raw.t === "note" ? "activity" : raw.t;
  if (!EVENT_FIELDS[t]) return null;
  switch (t) {
    case "phase": {
      const status = pick(raw.status, ["preparing", "testing", "reporting"], null);
      if (!status) return null;
      return { t, status, phase: oneLine(raw.phase, 200) };
    }
    case "env":
      return { t, url: oneLine(raw.url, 200), database: !!raw.database, mail: !!raw.mail };
    case "check": {
      const title = oneLine(raw.title, 160);
      const category = pick(raw.category, CATEGORIES, "features");
      if (!title && !raw.id) return null;
      return {
        t,
        id: cleanId(raw.id, `${category}.${slug(title)}`),
        category,
        title: title || String(raw.id),
        status: pick(raw.status, CHECK_STATUSES, "running"),
        detail: clip(raw.detail, 2000),
      };
    }
    case "finding": {
      const title = oneLine(raw.title, 200);
      if (!title) return null;
      const category = pick(raw.category, CATEGORIES, "security");
      return {
        t,
        id: cleanId(raw.id, `${category}.${slug(title)}`),
        severity: pick(String(raw.severity || "").toLowerCase(), SEVERITIES, "medium"),
        category,
        title,
        plain: clip(raw.plain, 1500), // for the owner, in everyday words (PROMPT.md)
        detail: clip(raw.detail, 4000),
        fix: clip(raw.fix, 4000),
        location: oneLine(raw.location, 300),
      };
    }
    case "activity": {
      const text = oneLine(raw.text, 300);
      if (!text) return null;
      return { t, kind: pick(raw.kind, ACTIVITY_KINDS, "info"), text };
    }
    case "usage":
      return { t, turns: Math.max(0, Math.round(Number(raw.turns) || 0)), durationMs: Math.max(0, Math.round(Number(raw.durationMs) || 0)) };
    case "report": {
      const score = raw.score == null || raw.score === "" || !Number.isFinite(Number(raw.score)) ? null : Math.max(0, Math.min(100, Math.round(Number(raw.score))));
      return { t, verdict: pick(raw.verdict, ["ready", "not_ready"], null), score, summary: clip(raw.summary, 4000), plainSummary: clip(raw.plainSummary, 3000), complete: raw.complete !== false };
    }
  }
  return null;
}

/** One event as a log line. Only the fields of its type, flat primitives. */
export function formatEvent(ev) {
  const c = cleanEvent(ev);
  if (!c) return null;
  return EVENT_PREFIX + JSON.stringify(c);
}

/** The event in a log line, or null when the line is not one (or is malformed / not flat). */
export function parseEventLine(line) {
  const s = String(line ?? "");
  const at = s.indexOf(EVENT_PREFIX.trim());
  if (at === -1) return null;
  const json = s.slice(at + EVENT_PREFIX.trim().length).trim();
  if (!json.startsWith("{") || json.length > 20_000) return null;
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  for (const v of Object.values(obj)) if (v !== null && typeof v === "object") return null; // flat only
  return cleanEvent(obj);
}

// --------------------------------------------------------------- verdict

/**
 * The verdict rule (docs/DOCKER-AND-TESTS.md §2): not ready if any finding is
 * critical or high, or any check in payments, auth or features failed. The
 * tester's own verdict can only make it stricter, and an incomplete run is
 * never "ready".
 */
export function decideVerdict({ checks = [], findings = [], reported = null, complete = true } = {}) {
  const reasons = [];
  const serious = findings.filter((f) => f.severity === "critical" || f.severity === "high");
  if (serious.length) reasons.push(`${serious.length} critical or high finding${serious.length === 1 ? "" : "s"}`);
  const failed = checks.filter((c) => c.status === "fail" && BLOCKING_CATEGORIES.includes(c.category));
  if (failed.length) reasons.push(`${failed.length} failed check${failed.length === 1 ? "" : "s"} in payments, sign-in or core features`);
  if (!complete) reasons.push("the test did not finish");
  if (reported === "not_ready" && !reasons.length) reasons.push("the tester judged it not ready");
  return { verdict: reasons.length ? "not_ready" : "ready", reasons };
}

/** 0..100: the tester's score when it gave one, else from findings and checks; never high for a not-ready run. */
export function computeScore({ checks = [], findings = [], reported = null, verdict = "ready" } = {}) {
  let score;
  if (Number.isFinite(reported)) score = reported;
  else {
    const w = { critical: 30, high: 15, medium: 5, low: 2, info: 0 };
    score = 100;
    for (const f of findings) score -= w[f.severity] ?? 0;
    for (const c of checks) score -= c.status === "fail" ? 8 : c.status === "warn" ? 2 : 0;
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  return verdict === "not_ready" ? Math.min(score, 69) : score;
}

// ------------------------------------------------------- variable rewrite

export const DB_URL_RE = /^(mysql|mysql2|mariadb)(\+[a-z0-9]+)?:\/\//i;
const OTHER_DATA_URL_RE = /^(postgres|postgresql|mongodb(\+srv)?|redis|rediss|amqp|amqps|mssql|sqlserver):\/\//i;
export const DB_KEY_RE = /^(.*?)(?:DB|MYSQL|DATABASE|MARIADB)_(HOST|HOSTNAME|SERVER|PORT|NAME|DATABASE|DB|USER|USERNAME|PASS|PASSWORD|PWD)$/;
const MAIL_KEY_RE = /^(?:.*_)?(?:SMTP|MAIL|EMAIL|MAILER)_(HOST|HOSTNAME|SERVER|PORT|USER|USERNAME|LOGIN|PASS|PASSWORD|SECURE|TLS|SSL|ENCRYPTION|SCHEME)$/;
const MAIL_URL_KEY_RE = /^(?:.*_)?(?:SMTP|MAIL|EMAIL|MAILER)_(URL|DSN|SERVER|TRANSPORT|CONNECTION)$/;
const SMTP_URL_RE = /^smtps?:\/\//i;
const MAIL_API_RE = /(SENDGRID|RESEND|POSTMARK|MAILGUN|MAILJET|SPARKPOST|BREVO|SENDINBLUE|MANDRILL|MAILERSEND|MAILCHIMP|LOOPS|PLUNK|CUSTOMERIO|CUSTOMER_IO)/;
const MESSAGING_RE = /^(TWILIO|VONAGE|NEXMO|MESSAGEBIRD|PLIVO|SINCH|TELNYX|PUSHOVER|ONESIGNAL)_/;
export const SECRETISH_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASS|SID|AUTH)/;
const WEBHOOK_URL_RE = /(hooks\.slack\.com|discord(app)?\.com\/api\/webhooks|outlook\.office\.com\/webhook|webhook\.office\.com|api\.telegram\.org\/bot)/i;
const LIVE_PAY_VALUE_RE = /^(sk|pk|rk)_live_/;
export const PAY_ENV_KEY_RE = /^(PAYPAL|BRAINTREE|SQUARE|ADYEN|MOLLIE|PADDLE|LEMONSQUEEZY|RAZORPAY|AUTHORIZE(?:NET)?|CHECKOUT|KLARNA)_(MODE|ENV|ENVIRONMENT|SANDBOX|LIVE)$/;

/** Is a variable value a live payment key, whatever the variable is called? */
export function isLivePaymentValue(v) {
  const s = String(v ?? "").trim();
  return LIVE_PAY_VALUE_RE.test(s) || /^live_[A-Za-z0-9]{20,}$/.test(s); // Stripe; Mollie live_…
}

/** The variables a test copy gets when the site has no database of its own (prefix-less). */
export const STANDARD_DB_KEYS = ["DATABASE_URL", "DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"];

/**
 * MySQL-safe name of a site's throw-away test database: `test_<slug>` for the
 * first (or only) one, `test_<slug>_2`, `test_<slug>_3`… for further linked
 * databases. Lower-case letters, digits and `_`, at most 64 characters.
 */
export function testDatabaseName(slug, index = 0) {
  const s =
    String(slug || "")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || "site";
  const tail = index > 0 ? `_${index + 1}` : "";
  return `test_${s.slice(0, 64 - 5 - tail.length).replace(/_+$/, "")}${tail}`;
}

/**
 * Which throw-away databases a run needs: one per linked database, or one for
 * a site that carries its own MySQL settings in its variables.
 * linked: [{ databaseId, name, prefix, vars }] from ctx.sites.linkedEnvSources.
 *
 * With `{ slug, type }` (what the panel sends since staging/test-database
 * naming): every database is named `test_<slug>` (see testDatabaseName), and a
 * node/php site with no database at all still gets one — `add: true`, meaning
 * rewriteEnv adds the standard variables (STANDARD_DB_KEYS) for it. Without
 * them (older callers) the names come from the production database as before
 * and a site without a database gets none.
 */
export function planDatabases(env = {}, linked = [], { slug = null, type = null } = {}) {
  const named = slug != null || type != null;
  const safeName = (n) => (/^[A-Za-z0-9_]{1,64}$/.test(String(n || "")) ? String(n) : "app");
  const nameFor = (i, fallback) => (named ? testDatabaseName(slug || "site", i) : safeName(fallback));
  if (linked.length) return linked.map((l, i) => ({ index: i, prefix: String(l.prefix || ""), name: nameFor(i, l.vars?.[`${l.prefix || ""}DB_NAME`] || l.name), source: l.name || l.databaseId }));
  const keys = Object.keys(env);
  const url = keys.find((k) => DB_URL_RE.test(String(env[k] || "")));
  const hostKey = keys.find((k) => {
    const m = DB_KEY_RE.exec(k);
    return m && (m[2] === "HOST" || m[2] === "HOSTNAME" || m[2] === "SERVER");
  });
  if (!url && !hostKey) {
    if (!named || type === "static") return [];
    return [{ index: 0, prefix: "", name: testDatabaseName(slug || "site", 0), source: "the test run (this website has no database of its own)", add: true }];
  }
  let name = "app";
  if (url) {
    try {
      name = decodeURIComponent(new URL(String(env[url]).replace(/^[a-z0-9+]+:/i, "http:")).pathname.replace(/^\//, "")) || "app";
    } catch {
      /* keep app */
    }
  } else {
    const nameKey = keys.find((k) => /(?:DB|MYSQL|DATABASE)_(NAME|DATABASE|DB)$/.test(k));
    if (nameKey) name = env[nameKey];
  }
  return [{ index: 0, prefix: "", name: nameFor(0, name), source: "the site's own variables" }];
}

/**
 * What the Environment tab's Test view shows, read-only: the database
 * variables a commit test of this site gets (host and name filled in; user
 * and password are random per run). `env` is the site's deployed variables
 * (own + linked database vars), `linked` as for planDatabases.
 * Returns { databases: [{ name, host, port, source, added }], vars: [{ key, value, random }] }.
 */
export function testDatabasePreview(env = {}, linked = [], { slug = null, type = null } = {}) {
  const U = "__random_user__";
  const P = "__random_password__";
  const plan = planDatabases(env, linked, { slug: slug || "site", type });
  const databases = plan.map((p) => ({ prefix: p.prefix, host: `db${p.index + 1}`, port: "3306", name: p.name, user: U, password: P, add: !!p.add }));
  const r = rewriteEnv({ env, linked, databases });
  const linkedKeys = new Set(linked.flatMap((l) => Object.keys(l.vars || {})));
  const vars = r.repointed
    .filter((k) => k in r.env && (linkedKeys.has(k) || DB_KEY_RE.test(k) || DB_URL_RE.test(String(r.env[k])) || STANDARD_DB_KEYS.some((s) => k.endsWith(s))))
    .sort()
    .map((key) => {
      const v = String(r.env[key]);
      const random = v.includes(U) || v.includes(P);
      return { key, value: v.split(U).join("‹random›").split(P).join("‹random›"), random };
    });
  return { databases: databases.map((d, i) => ({ name: d.name, host: d.host, port: d.port, source: plan[i].source, added: d.add })), vars };
}

function dbUrl(scheme, d) {
  return `${scheme}://${encodeURIComponent(d.user)}:${encodeURIComponent(d.password)}@${d.host}:${d.port}/${encodeURIComponent(d.name)}`;
}

/**
 * The variables the test copy runs with.
 *
 *   env       the site's variables as deployed (site env + linked database vars)
 *   linked    [{ prefix, vars }] — which keys came from which linked database
 *   databases [{ prefix, host, port, name, user, password }] the throw-away ones (same order as linked)
 *   mail      { host, port } of the mail catcher
 *   testEnv   the site's test-only variables (win over everything, live keys refused)
 *   domains   production domains — URLs pointing at them are re-pointed at testUrl
 *   testUrl   where the test copy answers (http://site:<port>)
 *
 * Returns { env, notes[], removed[], repointed[] }. Never leaves a value that
 * reaches production data, a real mailbox/phone, or a live payment account.
 */
export function rewriteEnv({ env = {}, linked = [], databases = [], mail = null, testEnv = {}, domains = [], testUrl = "", port = null } = {}) {
  const out = { ...env };
  const notes = [];
  const removed = new Set();
  const repointed = new Set();
  const drop = (k, why) => {
    if (!(k in out)) return;
    delete out[k];
    removed.add(k);
    if (why) notes.push(`${k} removed — ${why}.`);
  };
  const set = (k, v) => {
    out[k] = String(v);
    repointed.add(k);
  };
  const dbFor = (prefix) => databases.find((d) => d.prefix === prefix) || databases.find((d) => !d.prefix) || databases[0] || null;

  // 1. Linked databases: their keys are known exactly.
  const handled = new Set();
  linked.forEach((l, i) => {
    const d = databases[i] || dbFor(l.prefix || "");
    for (const k of Object.keys(l.vars || {})) {
      handled.add(k);
      if (!(k in out)) continue;
      if (!d) {
        drop(k, "no throw-away database for it");
        continue;
      }
      const suffix = k.slice(String(l.prefix || "").length);
      if (suffix === "DB_HOST") set(k, d.host);
      else if (suffix === "DB_PORT") set(k, d.port);
      else if (suffix === "DB_NAME") set(k, d.name);
      else if (suffix === "DB_USER") set(k, d.user);
      else if (suffix === "DB_PASSWORD") set(k, d.password);
      else if (suffix === "DATABASE_URL") set(k, dbUrl((DB_URL_RE.exec(out[k]) || [])[1] || "mysql", d));
      else drop(k, "it came from the production database link");
    }
  });

  let liveStripe = false;
  for (const k of Object.keys(out)) {
    if (handled.has(k)) continue;
    const v = String(out[k] ?? "");

    // 2. Data stores named in the site's own variables.
    if (DB_URL_RE.test(v)) {
      const d = dbFor("");
      if (d) set(k, dbUrl(DB_URL_RE.exec(v)[1], d));
      else drop(k, "it points at a production database");
      continue;
    }
    if (OTHER_DATA_URL_RE.test(v)) {
      drop(k, `it points at a production ${v.split(":")[0]} service the test copy must not use`);
      continue;
    }
    const m = DB_KEY_RE.exec(k);
    if (m) {
      const d = dbFor(m[1]);
      const part = m[2];
      if (!d) drop(k, "it points at a production database");
      else if (["HOST", "HOSTNAME", "SERVER"].includes(part)) set(k, d.host);
      else if (part === "PORT") set(k, d.port);
      else if (["NAME", "DATABASE", "DB"].includes(part)) set(k, d.name);
      else if (["USER", "USERNAME"].includes(part)) set(k, d.user);
      else set(k, d.password);
      continue;
    }

    // 3. Mail: SMTP to the catcher, sending APIs and messaging removed.
    // A connection URL first (EMAIL_SERVER=smtp://user:pass@host is a URL, not a host name).
    if (mail && (SMTP_URL_RE.test(v) || (MAIL_URL_KEY_RE.test(k) && /:\/\//.test(v)))) {
      set(k, `smtp://${mail.host}:${mail.port}`);
      continue;
    }
    const mm = MAIL_KEY_RE.exec(k);
    if (mm && mail) {
      const part = mm[1];
      if (["HOST", "HOSTNAME", "SERVER"].includes(part)) set(k, mail.host);
      else if (part === "PORT") set(k, mail.port);
      else if (["USER", "USERNAME", "LOGIN"].includes(part)) set(k, "test");
      else if (["PASS", "PASSWORD"].includes(part)) set(k, "test");
      else if (part === "ENCRYPTION" || part === "SCHEME") set(k, part === "SCHEME" ? "smtp" : "");
      else set(k, "false");
      continue;
    }
    if (MAIL_API_RE.test(k) && SECRETISH_RE.test(k)) {
      drop(k, "an e-mail sending service would reach real people; mail goes to the mail catcher instead");
      continue;
    }
    if (MESSAGING_RE.test(k) && SECRETISH_RE.test(k)) {
      drop(k, "SMS/push messages would reach real people");
      continue;
    }
    if (WEBHOOK_URL_RE.test(v)) {
      drop(k, "it posts to a real chat webhook");
      continue;
    }

    // 4. Payments: live keys never reach a test.
    if (isLivePaymentValue(v)) {
      if (/^(sk|pk|rk)_live_/.test(v.trim())) liveStripe = true;
      drop(k, "live payment key");
      continue;
    }
    if (/LIVE/.test(k) && SECRETISH_RE.test(k) && /(STRIPE|PAY|SQUARE|BRAINTREE|ADYEN|MOLLIE|PADDLE|CHECKOUT|KLARNA|RAZORPAY)/.test(k)) {
      drop(k, "live payment credential");
      continue;
    }
    const pm = PAY_ENV_KEY_RE.exec(k);
    if (pm && /^(live|production|prod)$/i.test(v.trim())) {
      const provider = pm[1];
      set(k, provider === "ADYEN" ? "TEST" : "sandbox");
      for (const other of Object.keys(out)) {
        if (other !== k && other.startsWith(`${provider}_`) && SECRETISH_RE.test(other)) drop(other, `${provider} was in live mode`);
      }
      notes.push(`${k} switched to the provider's test mode.`);
      continue;
    }
  }
  // A webhook signing secret that belongs to a live Stripe account goes with its keys.
  if (liveStripe) {
    for (const k of Object.keys(out)) if (/^whsec_/.test(String(out[k]).trim())) drop(k, "webhook secret of the live payment account");
  }

  // 4b. A site without a database of its own still gets one for the test
  // (planDatabases `add: true`): the standard variables, where not set already.
  for (const d of databases) {
    if (!d?.add) continue;
    const p = String(d.prefix || "");
    const vals = { DATABASE_URL: dbUrl("mysql", d), DB_HOST: d.host, DB_PORT: d.port, DB_NAME: d.name, DB_USER: d.user, DB_PASSWORD: d.password };
    const added = STANDARD_DB_KEYS.filter((k) => !(p + k in out));
    for (const k of added) set(p + k, vals[k]);
    if (added.length) notes.push(`Throw-away database ${d.name} added for the test (${added.map((k) => p + k).join(", ")}).`);
  }

  // 5. The site's own address → the test copy.
  const doms = (domains || []).map((d) => String(d).toLowerCase().replace(/^www\./, "")).filter(Boolean);
  if (testUrl && doms.length) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`https?://(?:www\\.)?(?:${[...new Set(doms)].map(esc).join("|")})(?::\\d+)?(?=[/?#"'\\s]|$)`, "gi");
    for (const k of Object.keys(out)) {
      const v = String(out[k]);
      const nv = v.replace(re, testUrl);
      if (nv !== v) set(k, nv);
    }
  }

  // 6. Test-only variables win. A live key there is refused, not applied.
  let applied = 0;
  for (const [k, v] of Object.entries(testEnv || {})) {
    if (v == null) continue;
    if (isLivePaymentValue(v)) {
      notes.push(`Test-only variable ${k} holds a live payment key and was NOT applied.`);
      continue;
    }
    out[k] = String(v);
    removed.delete(k);
    repointed.add(k);
    applied++;
  }
  if (applied) notes.push(`${applied} test-only variable${applied === 1 ? "" : "s"} applied.`);

  if (port) out.PORT = String(port);
  out.NODE_ENV = out.NODE_ENV || "production";
  return { env: out, notes, removed: [...removed], repointed: [...repointed] };
}

// ------------------------------------------------------------- redaction

/**
 * A function that hides secrets in text shown in the panel: every known
 * secret value, plus anything shaped like a key, token, password or
 * credentials in a URL.
 */
export function makeRedactor(secrets = []) {
  const known = [...new Set(secrets.map((s) => String(s ?? "")).filter((s) => s.length >= 6))].sort((a, b) => b.length - a.length);
  return (text) => {
    let s = String(text ?? "");
    for (const k of known) if (s.includes(k)) s = s.split(k).join("••••");
    return s
      .replace(/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{6,}/g, "$1_$2_••••")
      .replace(/\bwhsec_[A-Za-z0-9]{6,}/g, "whsec_••••")
      .replace(/\bsk-ant-[A-Za-z0-9_-]{6,}/g, "sk-ant-••••")
      .replace(/\b(gh[pousr]_)[A-Za-z0-9]{10,}/g, "$1••••")
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ••••")
      .replace(/(\/\/[^\s:/@]+:)[^\s@/]+@/g, "$1••••@")
      .replace(/\b([A-Za-z_]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey))(["']?\s*[:=]\s*["']?)([^\s"'&,;]{3,})/gi, "$1$2••••");
  };
}

// ---------------------------------------------------- stream-json → activity

/** Short, safe words for one Claude Code tool call. Typed text and file contents are never shown. */
export function describeTool(name, input = {}) {
  const i = input && typeof input === "object" ? input : {};
  const file = (p) => String(p || "").replace(/^\/app\//, "");
  const n = String(name || "tool");
  if (n === "Bash") return `Ran: ${oneLine(i.description || i.command, 140)}`;
  if (n === "Read") return `Read ${oneLine(file(i.file_path), 140)}`;
  if (n === "Write" || n === "Edit" || n === "MultiEdit" || n === "NotebookEdit") return `Wrote ${oneLine(file(i.file_path || i.notebook_path), 140)}`;
  if (n === "Grep") return `Searched the code for ${oneLine(i.pattern, 100)}`;
  if (n === "Glob") return `Listed files matching ${oneLine(i.pattern, 100)}`;
  if (n === "WebFetch") return `Fetched ${oneLine(i.url, 140)}`;
  if (n === "WebSearch") return `Searched the web: ${oneLine(i.query, 120)}`;
  if (n === "TodoWrite") return "Updated its checklist";
  if (n === "Task" || n === "Agent") return `Started a helper: ${oneLine(i.description, 120)}`;
  if (n.startsWith("mcp__")) {
    const parts = n.split("__");
    const action = (parts[2] || parts[1] || n).replace(/^browser_/, "").replace(/_/g, " ");
    const target = i.url || i.element || "";
    return `Browser: ${action}${target ? ` ${oneLine(target, 120)}` : ""}`;
  }
  return n;
}

/**
 * One line of `claude -p --output-format stream-json` → { activity: [{ kind, text }], usage?, result? }.
 * Text is redacted and kept short; thinking blocks and tool output are not forwarded.
 */
export function streamJsonEvents(line, redact = (s) => s) {
  const s = String(line ?? "").trim();
  const out = { activity: [] };
  if (!s) return out;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    out.activity.push({ kind: "info", text: oneLine(redact(s), 200) });
    return out;
  }
  if (!msg || typeof msg !== "object") return out;
  if (msg.type === "system" && msg.subtype === "init") {
    out.activity.push({ kind: "info", text: `Claude Code started${msg.model ? ` (${oneLine(msg.model, 60)})` : ""}.` });
  } else if (msg.type === "assistant") {
    for (const b of Array.isArray(msg.message?.content) ? msg.message.content : []) {
      if (b?.type === "tool_use") out.activity.push({ kind: "tool", text: oneLine(redact(describeTool(b.name, b.input)), 200) });
      else if (b?.type === "text" && String(b.text || "").trim()) out.activity.push({ kind: "think", text: oneLine(redact(b.text), 240) });
    }
  } else if (msg.type === "user") {
    for (const b of Array.isArray(msg.message?.content) ? msg.message.content : []) {
      if (b?.type === "tool_result" && b.is_error) {
        const c = Array.isArray(b.content) ? b.content.map((x) => x?.text || "").join(" ") : b.content;
        out.activity.push({ kind: "error", text: `A step failed: ${oneLine(redact(c), 180)}` });
      }
    }
  } else if (msg.type === "result") {
    out.usage = { turns: Number(msg.num_turns) || 0, durationMs: Number(msg.duration_ms) || 0 };
    const why = {
      error_max_turns: "it reached the turn limit",
      error_during_execution: "an error stopped it",
    }[msg.subtype];
    out.result = { ok: msg.subtype === "success" && !msg.is_error, subtype: String(msg.subtype || ""), text: oneLine(redact(msg.result || ""), 300) };
    out.activity.push(
      out.result.ok
        ? { kind: "info", text: `Claude finished after ${out.usage.turns} turns.` }
        : { kind: "error", text: `Claude stopped early${why ? ` — ${why}` : ""}.` },
    );
  }
  return out;
}

// --------------------------------------------------------- report file

/** /out/report.json → { verdict, score, summary, checks[], findings[] } (validated, capped). */
export function cleanReport(raw) {
  if (!raw || typeof raw !== "object") return null;
  const checks = (Array.isArray(raw.checks) ? raw.checks : []).slice(0, 200).map((c) => cleanEvent({ ...c, t: "check" })).filter(Boolean);
  const findings = (Array.isArray(raw.findings) ? raw.findings : []).slice(0, 150).map((f) => cleanEvent({ ...f, t: "finding" })).filter(Boolean);
  const head = cleanEvent({ t: "report", verdict: raw.verdict, score: raw.score, summary: raw.summary, plainSummary: raw.plainSummary });
  return { verdict: head.verdict, score: head.score, summary: head.summary, plainSummary: head.plainSummary, checks, findings };
}

// ------------------------------------------------------- argument builders

/**
 * `docker run -d` / `docker create` arguments for one container of a run:
 * the shared hardening (docker.baseFlags) plus the per-run bits — label,
 * network alias, DNS, extra tmpfs, shm, supplementary group. The image's own
 * entrypoint is kept unless `command` is given (then `sh -c command`).
 */
export function containerArgs({ mode = "run", name, image, runId, alias, dns = [], command, args: tail = [], env = {}, tmpfs = [], shmMb = 0, groupAdd = null, ...o }) {
  if (!docker.validName(name)) throw new Error(`"${name}" is not a valid container name.`);
  const e = docker.envFlags(env);
  const a = mode === "create" ? ["create", "--name", name] : ["run", "-d", "--name", name, "--restart", "no"];
  a.push(...docker.baseFlags({ ...o, labels: { ...(o.labels || {}), "fcc.test": runId } }));
  if (alias) a.push("--network-alias", alias);
  for (const d of dns) a.push("--dns", d);
  for (const t of tmpfs) a.push("--tmpfs", t);
  if (shmMb) a.push("--shm-size", `${Math.round(shmMb)}m`);
  if (groupAdd != null) a.push("--group-add", String(groupAdd));
  a.push(...e.args, image);
  if (command) a.push("sh", "-c", command);
  a.push(...tail);
  return { args: a, env: e.env, dropped: e.dropped };
}

/**
 * Host firewall rules that keep a run's containers away from this host, the
 * cluster and private networks. Each is [chain, args] for `iptables -I chain 1 args`
 * (and `iptables -D chain args` to remove). All carry the comment fcc.test=<runId>.
 */
export function firewallRules(runId, { internalIf, egressIf, blockIps = [] }) {
  const tag = ["-m", "comment", "--comment", `fcc.test=${runId}`];
  const rules = [
    ["INPUT", ["-i", internalIf, ...tag, "-j", "DROP"]],
    ["INPUT", ["-i", egressIf, ...tag, "-j", "DROP"]],
  ];
  const dests = [...new Set([...BLOCKED_RANGES, ...blockIps.filter((ip) => net.isIPv4(ip)).map((ip) => `${ip}/32`)])];
  for (const d of dests) rules.push(["DOCKER-USER", ["-i", egressIf, "-d", d, ...tag, "-j", "DROP"]]);
  return rules;
}

/** `docker … --format '{{.CreatedAt}}'` ("2026-10-30 12:00:00 +0000 UTC") → ms, or NaN. */
export function parseDockerDate(s) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? ([+-]\d{2})(\d{2})/.exec(String(s || "").trim());
  return m ? Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`) : NaN;
}

/** Fill {{NAME}} placeholders of the tester brief. Unknown ones become "". */
export function fillTemplate(text, vars = {}) {
  return String(text || "").replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])));
}

/** Content hash of the tester image's build files (Dockerfile, fcc-report). */
export function imageHash(files = {}) {
  const h = crypto.createHash("sha256");
  for (const k of Object.keys(files).sort()) h.update(`${k}\0${files[k]}\0`);
  return h.digest("hex").slice(0, 16);
}

// --------------------------------------------------------------- runtime

/** Runs being executed by this process — the sweep never touches them. */
const active = new Set();

/**
 * Remove what crashed or abandoned runs left behind: containers, networks and
 * firewall rules labelled fcc.test, and their folders. Anything older than
 * `olderThanMs`, plus any run in `runIds` (runs the panel knows are dead).
 */
/**
 * How the test copy's empty database gets its tables: the site's own
 * after-deploy scripts when it has any; otherwise, for a Prisma app, Prisma's
 * migrations (or `db push` when the app keeps no migrations folder). Each entry
 * is [id, title, command, "schema"].
 */
export function schemaSteps(afterDeployScripts, appDir, type) {
  const scripts = (Array.isArray(afterDeployScripts) ? afterDeployScripts : []).filter((n) => /^[A-Za-z0-9_][A-Za-z0-9:._+-]{0,99}$/.test(n));
  if (scripts.length) return scripts.map((name, i) => [`migrate${i ? i + 1 : ""}`, `After deploy: npm run ${name}`, `npm run ${name}`, "schema"]);
  if (type !== "node" || !fs.existsSync(path.join(appDir, "prisma", "schema.prisma"))) return [];
  const migrations = path.join(appDir, "prisma", "migrations");
  let hasMigrations = false;
  try {
    hasMigrations = fs.readdirSync(migrations, { withFileTypes: true }).some((e) => e.isDirectory());
  } catch {
    /* no migrations folder */
  }
  return hasMigrations
    ? [["migrate", "Database migrations", "npx prisma migrate deploy", "schema"]]
    : [["migrate", "Database schema", "npx prisma db push --skip-generate", "schema"]];
}

/**
 * The owner's summary when Claude did not write one (it stopped early, or the
 * run ended before it started): the verdict and the worst findings' titles,
 * which PROMPT.md asks to be in everyday words.
 */
export function plainFallback(verdict, findings = []) {
  if (verdict === "ready") return "No serious problems were found. This version looks safe to put live.";
  const order = ["critical", "high", "medium", "low", "info"];
  const worst = [...findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity)).slice(0, 3).map((f) => f.title);
  return worst.length
    ? `This version isn't ready to go live yet. The most important things to fix first: ${worst.join("; ")}.`
    : "This version isn't ready to go live yet: some of the checks failed.";
}

export async function sweepTestLeftovers({ dataDir, olderThanMs = STALE_MS, runIds = [], log = NOOP } = {}) {
  if (sys.DRY_RUN) return { removed: 0 };
  const st = await docker.status();
  if (!st.running) return { removed: 0 };
  const cutoff = Date.now() - olderThanMs;
  const named = new Set(runIds.filter((id) => ID_RE.test(String(id))));
  const dead = new Set();
  const isDead = (id, created) => !active.has(id) && (named.has(id) || (Number.isFinite(created) && created < cutoff));

  const ps = await sys.run("docker", ["ps", "-a", "--filter", "label=fcc.test", "--format", '{{.Names}}\t{{.Label "fcc.test"}}\t{{.CreatedAt}}'], { allowFail: true, timeoutMs: 30_000 });
  let removed = 0;
  for (const row of String(ps.stdout || "").split("\n").filter(Boolean)) {
    const [name, id, created] = row.split("\t");
    if (!isDead(id, parseDockerDate(created))) continue;
    dead.add(id);
    await docker.remove(name, { graceSec: 2 });
    removed++;
  }
  const nets = await sys.run("docker", ["network", "ls", "--filter", "label=fcc.test", "--format", '{{.Name}}\t{{.Label "fcc.test"}}\t{{.CreatedAt}}'], { allowFail: true, timeoutMs: 30_000 });
  const liveNets = new Set();
  for (const row of String(nets.stdout || "").split("\n").filter(Boolean)) {
    const [name, id, created] = row.split("\t");
    if (dead.has(id) || isDead(id, parseDockerDate(created))) {
      dead.add(id);
      await docker.removeNetwork(name);
    } else liveNets.add(id);
  }
  // Firewall rules whose run has no network any more.
  for (const chain of ["INPUT", "DOCKER-USER"]) {
    const r = await sys.run("iptables", ["-S", chain], { allowFail: true, timeoutMs: 15_000 }).catch(() => ({ stdout: "" }));
    for (const line of String(r.stdout || "").split("\n")) {
      const m = /--comment "?fcc\.test=([A-Za-z0-9_-]+)"?/.exec(line);
      if (!m || active.has(m[1]) || liveNets.has(m[1])) continue;
      const args = line.trim().replace(/"/g, "").split(/\s+/);
      if (args[0] !== "-A") continue;
      args[0] = "-D";
      await sys.run("iptables", args, { allowFail: true, timeoutMs: 15_000 }).catch(() => {});
    }
  }
  // Folders.
  const root = dataDir ? path.join(dataDir, "tests") : null;
  if (root && fs.existsSync(root)) {
    for (const id of fs.readdirSync(root)) {
      if (!ID_RE.test(id) || active.has(id)) continue;
      let mtime = NaN;
      try {
        mtime = fs.statSync(path.join(root, id)).mtimeMs;
      } catch { /* gone */ }
      if (dead.has(id) || isDead(id, mtime)) fs.rmSync(path.join(root, id), { recursive: true, force: true });
    }
  }
  if (removed || dead.size) log(`Cleaned up ${dead.size} abandoned test environment${dead.size === 1 ? "" : "s"}.`);
  return { removed, runs: [...dead] };
}

/**
 * Task `site.test`. payload:
 *   { runId, siteId, siteName, spec, release, linked, testEnv, afterDeployScripts,
 *     tester: { token, model, maxMinutes, maxTurns }, files: { Dockerfile, "fcc-report.mjs", "PROMPT.md" },
 *     blockHosts: [host], staleRunIds: [runId], commit: { shortSha, message } }
 * Result: { verdict, score, summary, complete, checks, findings, usage }.
 */
export async function runSiteTest(payload = {}, o = {}) {
  const log = o.log || NOOP;
  const signal = o.signal || null;
  const runId = String(payload.runId || "");
  const names = runNames(runId);
  const emit = (ev) => {
    const line = formatEvent(ev);
    if (line) log(line);
  };
  if (sys.DRY_RUN) return simulateRun(payload, { emit, log, signal });
  active.add(runId);
  try {
    return await realRun(payload, { ...o, log, signal, emit, names });
  } finally {
    active.delete(runId);
  }
}

// ------------------------------------------------------------- real run

async function realRun(payload, o) {
  const { log, signal, emit, names } = o;
  const runId = payload.runId;
  const spec = payload.spec || {};
  const type = spec.type || "node";
  const port = Number(spec.port) || 3000;
  const dataDir = o.dataDir || process.env.FCC_DATA_DIR || "/var/lib/fcc";
  const root = path.join(dataDir, "tests", runId);
  const appDir = path.join(root, "app");
  const outDir = path.join(root, "out");
  const briefDir = path.join(root, "brief");
  const uid = testUid(runId);
  const testUrl = `http://${SITE_HOST}:${port}`;
  const tester = payload.tester || {};
  const secrets = [tester.token];
  let redact = makeRedactor(secrets);
  const checks = new Map();
  const findings = new Map();
  const check = (id, category, title, status, detail = "") => {
    const ev = cleanEvent({ t: "check", id, category, title, status, detail: redact(detail) });
    checks.set(ev.id, ev);
    emit(ev);
  };
  const finding = (f) => {
    const ev = cleanEvent({ t: "finding", ...f, plain: redact(f.plain), detail: redact(f.detail), fix: redact(f.fix) });
    if (!ev) return;
    findings.set(ev.id, ev);
    emit(ev);
  };
  const activity = (kind, text) => emit({ t: "activity", kind, text: redact(text) });
  const phase = (status, text) => {
    emit({ t: "phase", status, phase: text });
    log(`── ${text}`);
  };
  // Teardown runs in a fixed order whatever got created: containers, networks,
  // firewall rules (last, so no container ever runs without them), folder.
  const made = { containers: false, networks: [], rules: null, root: false };
  let usage = null;

  try {
    if (!tester.token) throw new Error("No Claude Code token is set. Add one in Settings → Website testing (run `claude setup-token` on your own computer to make one).");
    phase("preparing", "Checking Docker on this server");
    await docker.ensureInstalled({ log });
    await sweepTestLeftovers({ dataDir, runIds: payload.staleRunIds || [], log }).catch((e) => log(`(cleanup of old test environments skipped: ${e.message})`));

    // --- tester image (built once per server, rebuilt when its files change)
    const files = payload.files || {};
    if (!files.Dockerfile || !files["fcc-report.mjs"]) throw new Error("The panel did not send the tester image files.");
    const imgFiles = { Dockerfile: files.Dockerfile, "fcc-report.mjs": files["fcc-report.mjs"] };
    const hash = imageHash(imgFiles);
    const have = await sys.run("docker", ["image", "inspect", "--format", '{{index .Config.Labels "fcc.tester.hash"}}', TESTER_IMAGE], { allowFail: true, timeoutMs: 30_000 });
    if (have.code !== 0 || String(have.stdout).trim() !== hash) {
      phase("preparing", "Building the tester image (first run on this server — a few minutes)");
      const ctxDir = path.join(dataDir, "tests", ".image");
      fs.rmSync(ctxDir, { recursive: true, force: true });
      fs.mkdirSync(ctxDir, { recursive: true });
      for (const [k, v] of Object.entries(imgFiles)) fs.writeFileSync(path.join(ctxDir, k), v);
      await sys.run("docker", ["build", "--pull", "-t", TESTER_IMAGE, "--label", `fcc.tester.hash=${hash}`, ctxDir], { log, signal, timeoutMs: 45 * 60_000 });
    }

    // --- folders
    fs.rmSync(root, { recursive: true, force: true });
    for (const d of [appDir, outDir, briefDir]) fs.mkdirSync(d, { recursive: true });
    made.root = true;

    // --- networks + firewall
    phase("preparing", "Creating an isolated network for this test");
    made.containers = true;
    made.networks.push(names.internal);
    await createNetwork(names.internal, names.internalIf, runId, { internal: true, log });
    made.networks.push(names.egress);
    await createNetwork(names.egress, names.egressIf, runId, { internal: false, log });
    const blockIps = await resolveHosts(payload.blockHosts || []);
    const rules = firewallRules(runId, { internalIf: names.internalIf, egressIf: names.egressIf, blockIps });
    made.rules = rules;
    await applyRules(rules, log);

    // --- databases
    const linked = Array.isArray(payload.linked) ? payload.linked : [];
    // test_<site slug> for every node/php site, even one without a database (then DATABASE_URL, DB_* are added).
    const plan = planDatabases(spec.env || {}, linked, { slug: payload.siteSlug || payload.siteName || spec.name || "site", type });
    const databases = plan.map((p) => ({ prefix: p.prefix, host: `db${p.index + 1}`, port: "3306", name: p.name, add: !!p.add, user: `t_${randomSecret(4).replace(/[^A-Za-z0-9]/g, "x")}`, password: randomSecret(18), rootPassword: randomSecret(18), source: p.source, container: names.db(p.index) }));
    for (const d of databases) secrets.push(d.password, d.rootPassword);
    redact = makeRedactor(secrets);
    if (databases.length) phase("preparing", `Starting ${databases.length === 1 ? "an empty throw-away database" : `${databases.length} empty throw-away databases`}`);
    for (const d of databases) {
      const a = containerArgs({
        name: d.container,
        image: MYSQL_IMAGE,
        runId,
        uid,
        network: names.internal,
        alias: d.host,
        memoryMb: 768,
        readOnly: true,
        // The data lives in memory and dies with the container; the image runs as any uid when these are writable.
        tmpfs: [`/var/lib/mysql:rw,nosuid,nodev,size=2048m,uid=${uid},gid=${uid}`, `/var/run/mysqld:rw,nosuid,nodev,size=16m,uid=${uid},gid=${uid}`, `/var/lib/mysql-files:rw,nosuid,nodev,size=16m,uid=${uid},gid=${uid}`],
        env: { MYSQL_ROOT_PASSWORD: d.rootPassword, MYSQL_DATABASE: d.name, MYSQL_USER: d.user, MYSQL_PASSWORD: d.password },
      });
      await docker.ensureImage(MYSQL_IMAGE, { log, signal });
      await sys.run("docker", a.args, { env: a.env, log, signal, timeoutMs: 120_000 });
    }
    for (const d of databases) await waitForMysql(d, { signal, log });

    // --- mail catcher
    phase("preparing", "Starting the mail catcher");
    await docker.ensureImage(MAIL_IMAGE, { log, signal });
    const mailArgs = containerArgs({ name: names.mail, image: MAIL_IMAGE, runId, uid, network: names.internal, alias: MAIL_HOST, memoryMb: 256, readOnly: true, env: { MP_SMTP_AUTH_ACCEPT_ANY: "1", MP_SMTP_AUTH_ALLOW_INSECURE: "1", MP_MAX_MESSAGES: "2000" } });
    await sys.run("docker", mailArgs.args, { env: mailArgs.env, log, signal, timeoutMs: 120_000 });

    // --- variables
    const testEnv = payload.testEnv || {};
    for (const v of Object.values(testEnv)) secrets.push(v);
    for (const v of Object.values(spec.env || {})) if (/(KEY|SECRET|TOKEN|PASS)/i.test(String(v)) || String(v).length >= 16) secrets.push(v);
    redact = makeRedactor(secrets);
    const rw = rewriteEnv({ env: spec.env || {}, linked, databases, mail: { host: MAIL_HOST, port: String(MAIL_SMTP_PORT) }, testEnv, domains: spec.domains || [], testUrl, port });
    for (const n of rw.notes) log(`note: ${n}`);
    for (const v of Object.values(rw.env)) if (String(v).length >= 8 && /[A-Za-z].*\d|\d.*[A-Za-z]/.test(String(v))) secrets.push(v);
    redact = makeRedactor(secrets.filter((s) => !/^(true|false|production|development|\d+|https?:\/\/(site|mail|db\d)\b.*)$/i.test(String(s))));
    emit({ t: "env", url: testUrl, database: databases.length > 0, mail: true });

    // --- the release
    phase("preparing", "Unpacking the commit");
    const buf = await fetchRelease(payload.release, o);
    extractZip(buf, appDir, { stripRoot: true });
    const settings = spec.settings || {};
    if (settings.writeEnvFile !== false && type !== "static") fs.writeFileSync(path.join(appDir, ".env"), `${renderEnvBlock(rw.env)}\n`, { mode: 0o640 });
    await docker.own(root, uid, uid, { log: null });
    await sys.run("chmod", ["-R", "g+rX,o-rwx", appDir], { timeoutMs: 120_000 });
    await docker.own(outDir, TESTER_UID, TESTER_UID, { log: null });
    fs.chmodSync(root, 0o755);

    // --- install + build
    const image = type === "php" ? PHP_IMAGE : spec.container?.image || docker.DEFAULT_NODE_IMAGE;
    const build = settings.build || {};
    const steps = [];
    if (build.install) steps.push(["install", "Dependencies install", build.install]);
    let prepare = build.prepare || "";
    if (!prepare && type === "node" && settings.autoPrepare !== false && fs.existsSync(path.join(appDir, "prisma", "schema.prisma"))) prepare = "npx prisma generate";
    if (prepare) steps.push(["prepare", "Prepare step", prepare]);
    if (build.build) steps.push(["build", "Build", build.build]);
    // The database schema is created between prepare and build, not after the
    // copy starts like a real deploy's after-deploy scripts: the test database
    // is empty, and a Next.js build that pre-renders pages reading the database
    // would otherwise bake "table does not exist" into them.
    const schema = schemaSteps(payload.afterDeployScripts, appDir, type);
    const buildAt = steps.findIndex(([id]) => id === "build");
    if (schema.length) steps.splice(buildAt === -1 ? steps.length : buildAt, 0, ...schema);
    if (steps.length) {
      await docker.ensureImage(image, { log, signal });
      for (const [id, title, cmd, kind] of steps) {
        phase("preparing", `${title}: ${clip(cmd, 80)}`);
        check(`setup.${id}`, "setup", title, "running");
        try {
          await runStep(names.step(id), { image, runId, uid, appDir, env: { ...rw.env, HOME: "/tmp" }, command: cmd, networks: kind === "schema" ? [names.internal] : [names.internal, names.egress], log: (l) => log(redact(l)), signal, timeoutMs: (kind === "schema" ? 15 : 30) * 60_000 });
          check(`setup.${id}`, "setup", title, "pass");
        } catch (err) {
          if (signal?.aborted) throw err;
          check(`setup.${id}`, "setup", title, "fail", err.message);
          if (kind === "schema") {
            // The copy may still run (and show what breaks without its tables).
            finding({ id: `setup.${id}`, severity: "high", category: "setup", title: `${title} fails on an empty database`, plain: "The step that creates the website's database tables failed on a brand-new, empty database. The site may not work at all on a fresh server, or after restoring from a backup.", detail: clip(redact(err.message), 1500), fix: "Make the migrations work from an empty database — a new server or a restore would hit the same error.", location: cmd });
            continue;
          }
          finding({ id: `setup.${id}`, severity: "critical", category: "setup", title: `${title} fails for this commit`, plain: "This version of the website could not be built, so it can't go live. Deploying it would fail the same way, and the site would stay on the old version.", detail: clip(redact(err.message), 1500), fix: `Run \`${cmd}\` locally on a clean checkout of this commit and fix the error before deploying.`, location: "build" });
          return finish({ complete: true, reportedSummary: `${title} failed, so the commit could not be tested. It would also fail to deploy.` });
        }
      }
    }

    // --- start the copy
    phase("preparing", "Starting the test copy of the website");
    check("setup.start", "setup", "Site starts and answers", "running");
    await startSite({ names, runId, uid, type, image, appDir, settings, port, env: rw.env, log, signal });

    // --- tester container (started now: it also probes the site's health)
    const testerArgs = containerArgs({
      name: names.tester,
      image: TESTER_IMAGE,
      runId,
      uid: TESTER_UID,
      network: names.internal,
      dns: PUBLIC_DNS,
      memoryMb: 4096,
      pids: 4096,
      readOnly: true,
      tmpfsMb: 2048,
      shmMb: 1024,
      groupAdd: uid,
      mounts: [{ src: appDir, dst: "/app", ro: true }, { src: outDir, dst: "/out" }, { src: briefDir, dst: "/brief", ro: true }],
      workdir: "/out",
      env: { HOME: "/tmp", CLAUDE_CODE_OAUTH_TOKEN: tester.token, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", FCC_TEST_URL: testUrl, FCC_EVENTS: "/out/events.jsonl" },
      command: "sleep infinity",
    });
    await sys.run("docker", testerArgs.args, { env: testerArgs.env, log: null, signal, timeoutMs: 120_000, redact: [tester.token] });
    await sys.run("docker", ["network", "connect", names.egress, names.tester], { log, timeoutMs: 60_000 });

    const healthPath = spec.healthPath || (type === "node" ? "" : "/");
    const up = await waitForSite(names.tester, `${testUrl}${healthPath && healthPath.startsWith("/") ? healthPath : "/"}`, { strict: !!healthPath, timeoutMs: Math.min(Number(settings.healthTimeoutMs) || 180_000, 5 * 60_000), signal });
    if (!up.ok) {
      const tail = redact(await docker.logs(names.site, 60));
      check("setup.start", "setup", "Site starts and answers", "fail", `${up.error}\n${tail}`);
      finding({ id: "setup.start", severity: "critical", category: "setup", title: "The commit does not start", plain: "This version of the website was built, but it crashed or never answered when started. Putting it live would take the website down.", detail: clip(`${up.error}\n\nLast lines it printed:\n${tail}`, 3000), fix: "Start this commit locally with production settings (NODE_ENV=production, an empty database) and fix the startup error.", location: "start" });
      return finish({ complete: true, reportedSummary: "The website did not start from this commit, so nothing else could be tested. Deploying it would take the site down." });
    }
    check("setup.start", "setup", "Site starts and answers", "pass", `${testUrl} answered with HTTP ${up.status}.`);

    // --- the brief
    const brief = fillTemplate(files["PROMPT.md"] || "Test the website at {{URL}} and write /out/report.json.", {
      SITE_NAME: payload.siteName || spec.name || "the website",
      SITE_TYPE: type,
      URL: testUrl,
      MAIL_UI: `http://${MAIL_HOST}:${MAIL_HTTP_PORT}`,
      MAIL_API: `http://${MAIL_HOST}:${MAIL_HTTP_PORT}/api/v1/messages`,
      DATABASES: databases.length ? databases.map((d) => `- host \`${d.host}\`, port 3306, database \`${d.name}\`, user \`${d.user}\`, password \`${d.password}\` (empty throw-away copy of ${d.source})`).join("\n") : "- none — this site has no database.",
      TEST_VARS: Object.keys(testEnv).length ? Object.keys(testEnv).map((k) => `\`${k}\``).join(", ") : "none",
      ENV_NOTES: rw.notes.length ? rw.notes.map((n) => `- ${n}`).join("\n") : "- nothing was changed beyond the database and mail settings.",
      COMMIT: payload.commit?.shortSha ? `${payload.commit.shortSha} — ${oneLine(payload.commit.message, 120)}` : "unknown",
      MAX_MINUTES: String(tester.maxMinutes || DEFAULT_MAX_MINUTES),
      CATEGORIES: CATEGORIES.join(", "),
    });
    fs.writeFileSync(path.join(briefDir, "PROMPT.md"), brief, { mode: 0o644 });

    // --- Claude Code
    phase("testing", "Claude is testing the copy");
    const maxMinutes = Math.max(5, Math.min(240, Number(tester.maxMinutes) || DEFAULT_MAX_MINUTES));
    const maxTurns = Math.max(10, Math.min(1000, Number(tester.maxTurns) || DEFAULT_MAX_TURNS));
    const claudeArgs = ["exec", "-w", "/out", names.tester, "claude", "-p", "You are running an authorised, automated quality and security assessment of the owner's own website, on a disposable copy. Read /brief/PROMPT.md first and follow it exactly. Report progress with fcc-report as you go and finish by writing /out/report.json.", "--output-format", "stream-json", "--verbose", "--max-turns", String(maxTurns), "--permission-mode", "bypassPermissions", "--add-dir", "/app"];
    if (tester.model && /^[A-Za-z0-9.:\[\]_-]{1,80}$/.test(tester.model)) claudeArgs.push("--model", tester.model);

    const eventsFile = path.join(outDir, "events.jsonl");
    let offset = 0;
    let partial = "";
    const pump = () => {
      try {
        const st = fs.statSync(eventsFile);
        if (st.size <= offset) return;
        const fd = fs.openSync(eventsFile, "r");
        const len = Math.min(st.size - offset, 1024 * 1024);
        const b = Buffer.alloc(len);
        fs.readSync(fd, b, 0, len, offset);
        fs.closeSync(fd);
        offset += len;
        const text = partial + b.toString("utf8");
        const lines = text.split("\n");
        partial = lines.pop();
        for (const l of lines) {
          let obj;
          try {
            obj = JSON.parse(l);
          } catch {
            continue;
          }
          const ev = cleanEvent(obj);
          if (!ev || !["check", "finding", "activity"].includes(ev.t)) continue;
          if (ev.t === "check") check(ev.id, ev.category, ev.title, ev.status, ev.detail);
          else if (ev.t === "finding") finding(ev);
          else activity(ev.kind, ev.text);
        }
      } catch {
        /* no events yet */
      }
    };
    const tail = setInterval(pump, 1000);
    let claudeResult = null;
    let lastSeen = 0;
    try {
      const r = await sys.run("docker", claudeArgs, {
        signal,
        allowFail: true,
        timeoutMs: maxMinutes * 60_000,
        log: (line) => {
          const ev = streamJsonEvents(line, redact);
          for (const a of ev.activity) {
            // The same thought or tool line twice in a row is noise.
            const key = `${a.kind}:${a.text}`;
            if (key === lastSeen) continue;
            lastSeen = key;
            activity(a.kind, a.text);
          }
          if (ev.usage) {
            usage = ev.usage;
            emit({ t: "usage", ...usage });
          }
          if (ev.result) claudeResult = ev.result;
        },
      });
      if (signal?.aborted) throw abortError();
      if (r.code !== 0 && !claudeResult) {
        const why = /401|unauthori[sz]ed|invalid.*token|OAuth/i.test(`${r.stderr}${r.stdout}`) ? "the Claude Code token was refused — make a new one with `claude setup-token`" : clip(redact(String(r.stderr || "").trim().split("\n").slice(-3).join(" ")), 300) || `exit code ${r.code}`;
        activity("error", `Claude Code stopped: ${why}`);
        if (/token was refused/.test(why)) throw new Error(`Claude Code could not sign in: ${why}.`);
      }
    } finally {
      clearInterval(tail);
      pump();
    }

    // --- the report
    phase("reporting", "Reading Claude's report");
    let report = null;
    try {
      const file = path.join(outDir, "report.json");
      if (fs.statSync(file).size <= 2 * 1024 * 1024) report = cleanReport(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      report = null;
    }
    if (!report) activity("error", "Claude did not write a readable /out/report.json — the result below is built from the checks it reported.");
    for (const c of report?.checks || []) check(c.id, c.category, c.title, c.status, c.detail);
    for (const f of report?.findings || []) finding(f);
    return finish({ complete: !!report && claudeResult?.subtype !== "error_max_turns", reportedVerdict: report?.verdict, reportedScore: report?.score, reportedSummary: report?.summary, reportedPlainSummary: report?.plainSummary });
  } finally {
    // Teardown always runs — success, error or cancel.
    const steps = [
      made.containers && (() => teardownContainers(runId, log)),
      ...made.networks.map((n) => () => docker.removeNetwork(n)),
      made.rules && (() => removeRules(made.rules)),
      made.root && (() => fs.rmSync(root, { recursive: true, force: true })),
    ].filter(Boolean);
    for (const fn of steps) {
      try {
        await fn();
      } catch (err) {
        log(`(cleanup: ${err.message})`);
      }
    }
    if (steps.length) log("Test environment removed.");
  }

  function finish({ complete, reportedVerdict = null, reportedScore = null, reportedSummary = "", reportedPlainSummary = "" }) {
    const cs = [...checks.values()];
    const fs_ = [...findings.values()];
    const { verdict, reasons } = decideVerdict({ checks: cs, findings: fs_, reported: reportedVerdict, complete });
    const score = computeScore({ checks: cs, findings: fs_, reported: reportedScore, verdict });
    const summary = reportedSummary || (verdict === "ready" ? "No blocking problems were found." : `Not ready: ${reasons.join("; ")}.`);
    const plainSummary = reportedPlainSummary || plainFallback(verdict, fs_);
    emit({ t: "report", verdict, score, summary, plainSummary, complete });
    return { verdict, score, summary, plainSummary, complete, checks: cs.length, findings: fs_.length, usage };
  }
}

async function teardownContainers(runId, log) {
  const r = await sys.run("docker", ["ps", "-aq", "--filter", `label=fcc.test=${runId}`], { allowFail: true, timeoutMs: 30_000 });
  const ids = String(r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (ids.length) await sys.run("docker", ["rm", "-f", ...ids], { allowFail: true, timeoutMs: 120_000 });
  if (ids.length) log?.(`Removed ${ids.length} test container${ids.length === 1 ? "" : "s"}.`);
}

async function createNetwork(name, bridge, runId, { internal, log }) {
  if (!docker.validName(name)) throw new Error(`"${name}" is not a valid network name.`);
  const a = ["network", "create", "--driver", "bridge", "--label", `fcc.test=${runId}`, "-o", `com.docker.network.bridge.name=${bridge}`];
  // Containers on the egress network never talk to each other there — only out.
  if (!internal) a.push("-o", "com.docker.network.bridge.enable_icc=false");
  else a.push("--internal");
  await sys.run("docker", [...a, name], { log, timeoutMs: 60_000 });
}

async function applyRules(rules, log) {
  const chain = await sys.run("iptables", ["-n", "-L", "DOCKER-USER"], { allowFail: true, timeoutMs: 15_000 }).catch((e) => ({ code: 1, stderr: e.message }));
  if (chain.code !== 0) {
    throw new Error("This server's firewall can't isolate test containers (iptables or Docker's DOCKER-USER chain is missing). Tests are not run without isolation.");
  }
  for (const [c, args] of rules) await sys.run("iptables", ["-I", c, "1", ...args], { timeoutMs: 15_000 });
  log(`Firewall: test containers can't reach this server, private networks or the ${rules.length - 2 - BLOCKED_RANGES.length > 0 ? `${rules.length - 2 - BLOCKED_RANGES.length} cluster address(es)` : "cluster"}.`);
}

async function removeRules(rules) {
  for (const [c, args] of rules) {
    // Remove every copy (a retried insert could have added two).
    for (let i = 0; i < 3; i++) {
      const r = await sys.run("iptables", ["-D", c, ...args], { allowFail: true, timeoutMs: 15_000 }).catch(() => ({ code: 1 }));
      if (r.code !== 0) break;
    }
  }
}

async function resolveHosts(hosts) {
  const out = new Set();
  for (const h of hosts) {
    const s = String(h || "").trim().replace(/^\[|\]$/g, "");
    if (!s) continue;
    if (net.isIP(s)) {
      out.add(s);
      continue;
    }
    try {
      for (const a of await dns.promises.lookup(s, { all: true })) out.add(a.address);
    } catch {
      /* unresolvable: nothing to block */
    }
  }
  return [...out];
}

async function fetchRelease(release, o) {
  if (!release) throw new Error("No release was given to test.");
  let buf;
  if (release.file && fs.existsSync(release.file)) buf = fs.readFileSync(release.file);
  else if (release.url) {
    const url = new URL(release.url, o.panelUrl || undefined).toString();
    const token = release.token || o.authToken;
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: o.signal || undefined });
    if (!res.ok) throw new Error(`Could not download the release: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } else throw new Error("The release has neither a local file nor a download URL.");
  if (release.sha256 && crypto.createHash("sha256").update(buf).digest("hex") !== release.sha256) throw new Error("The release archive failed its checksum.");
  return buf;
}

/** A one-off step (install, build, a script) in a container on `networks`, removed afterwards. */
async function runStep(name, { image, runId, uid, appDir, env, command, networks, log, signal, timeoutMs }) {
  await docker.remove(name, { graceSec: 1 });
  const a = containerArgs({ mode: "create", name, image, runId, uid, network: networks[0], memoryMb: 3072, tmpfsMb: 2048, mounts: [{ src: appDir }], workdir: appDir, env, command, dns: networks.length > 1 ? PUBLIC_DNS : [] });
  try {
    await sys.run("docker", a.args, { env: a.env, log: null, signal, timeoutMs: 60_000 });
    for (const n of networks.slice(1)) await sys.run("docker", ["network", "connect", n, name], { timeoutMs: 60_000 });
    await sys.run("docker", ["start", "-a", name], { log, signal, timeoutMs });
  } finally {
    await docker.remove(name, { graceSec: 1 });
  }
}

async function startSite({ names, runId, uid, type, image, appDir, settings, port, env, log, signal }) {
  let command;
  const docroot = settings.root ? path.join(appDir, settings.root) : appDir;
  if (type === "node") command = settings.restart?.pm2Start || settings.restart?.start || "npm start";
  else if (type === "php") command = `exec php -S 0.0.0.0:${port} -t ${JSON.stringify(docroot)}`;
  else command = `exec python3 -m http.server ${port} --bind 0.0.0.0 --directory ${JSON.stringify(docroot)}`;
  await docker.ensureImage(image, { log, signal });
  const a = containerArgs({ name: names.site, image, runId, uid, network: names.internal, alias: SITE_HOST, dns: PUBLIC_DNS, memoryMb: 2048, readOnly: true, tmpfsMb: 512, mounts: [{ src: appDir }], workdir: appDir, env: { HOME: "/tmp", ...env }, command });
  await sys.run("docker", a.args, { env: a.env, log: null, signal, timeoutMs: 120_000 });
  // The copy needs the internet for the payment provider's test mode and other APIs.
  if (type !== "static") await sys.run("docker", ["network", "connect", names.egress, names.site], { log, timeoutMs: 60_000 });
}

async function waitForMysql(d, { signal, log }) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const r = await sys.run("docker", ["exec", "-e", "MYSQL_PWD", d.container, "mysqladmin", "ping", "-h", "127.0.0.1", "-uroot", "--silent"], { env: { MYSQL_PWD: d.rootPassword }, allowFail: true, timeoutMs: 15_000 }).catch(() => ({ code: 1 }));
    if (r.code === 0) return log(`Database ${d.name} is ready (empty).`);
    await sleep(2000, signal);
  }
  throw new Error(`The throw-away database ${d.name} did not start in time.`);
}

/** Poll the site from inside the tester container (the only place that can reach it). */
async function waitForSite(tester, url, { strict, timeoutMs, signal }) {
  const deadline = Date.now() + timeoutMs;
  const probe = `fetch(process.argv[1],{redirect:"manual",signal:AbortSignal.timeout(8000)}).then(r=>{console.log(r.status)}).catch(e=>{console.log("ERR "+(e.cause?.code||e.message));process.exit(2)})`;
  let last = "no answer yet";
  while (Date.now() < deadline) {
    const r = await sys.run("docker", ["exec", tester, "node", "-e", probe, url], { allowFail: true, timeoutMs: 20_000 }).catch((e) => ({ code: 1, stdout: e.message }));
    const out = String(r.stdout || "").trim();
    const status = Number(out);
    if (r.code === 0 && status) {
      if (strict ? status >= 200 && status < 400 : status < 500) return { ok: true, status };
      last = `HTTP ${status} from ${url}`;
    } else last = out || "no answer";
    await sleep(3000, signal);
  }
  return { ok: false, error: `The website did not answer at ${url} in time (${last}).` };
}

// ------------------------------------------------------------- dry run

/** ≈40 s of realistic progress with the same protocol, for building the UI on a Mac. */
async function simulateRun(payload, { emit, log, signal }) {
  const ready = hashInt(payload.runId || "x") % 2 === 0; // half the demo runs pass, half don't
  const port = Number(payload.spec?.port) || 3000;
  const url = `http://${SITE_HOST}:${port}`;
  const redact = makeRedactor([payload.tester?.token]);
  const checks = new Map();
  const findings = new Map();
  const step = (ms) => sleep(ms, signal);
  const check = (id, category, title, status, detail = "") => {
    const ev = cleanEvent({ t: "check", id, category, title, status, detail });
    checks.set(ev.id, ev);
    emit(ev);
  };
  const tool = (name, input) => {
    for (const a of streamJsonEvents(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } }), redact).activity) emit({ t: "activity", ...a });
  };
  const think = (text) => emit({ t: "activity", kind: "think", text });
  const phase = (status, text) => {
    emit({ t: "phase", status, phase: text });
    log(`── ${text}`);
  };
  log("[dry-run] simulating a commit test — nothing is built or run.");
  phase("preparing", "Creating an isolated network for this test");
  await step(1200);
  const spec = payload.spec || {};
  const plan = planDatabases(spec.env || {}, Array.isArray(payload.linked) ? payload.linked : [], { slug: payload.siteSlug || payload.siteName || spec.name || "site", type: spec.type || "node" });
  if (plan.length) {
    phase("preparing", `Starting an empty throw-away database: ${plan.map((p) => p.name).join(", ")}`);
    for (const [i, p] of plan.entries()) {
      log(`[dry-run] database ${p.name} on host db${i + 1}:3306 (random user and password) — for ${p.source}${p.add ? "; DATABASE_URL and DB_* added for the copy" : ""}`);
    }
    await step(1500);
  }
  phase("preparing", "Starting the mail catcher");
  emit({ t: "env", url, database: plan.length > 0, mail: true });
  await step(800);
  for (const [id, title] of [["install", "Dependencies install"], ["build", "Build"]]) {
    phase("preparing", `${title}`);
    check(`setup.${id}`, "setup", title, "running");
    await step(1800);
    check(`setup.${id}`, "setup", title, "pass");
  }
  phase("preparing", "Starting the test copy of the website");
  check("setup.start", "setup", "Site starts and answers", "running");
  await step(1500);
  check("setup.start", "setup", "Site starts and answers", "pass", `${url} answered with HTTP 200.`);

  phase("testing", "Claude is testing the copy");
  for (const a of streamJsonEvents(JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet" })).activity) emit({ t: "activity", ...a });
  const script = [
    () => think("I'll start by mapping the site: reading package.json and the routes, then crawling the home page."),
    () => tool("Read", { file_path: "/app/package.json" }),
    () => tool("Glob", { pattern: "app/**/page.tsx" }),
    () => tool("Bash", { command: `curl -s ${url}/ | head -50`, description: `Fetch the home page of ${url}` }),
    () => think("It's a shop: product pages, a cart, Stripe checkout, accounts with email + password. Building my checklist from that."),
    () => check("features.discover", "features", "Feature map", "pass", "Shop, cart, checkout (Stripe), accounts, password reset, contact form."),
    () => check("config.env", "config", "Production configuration", "running"),
    () => tool("Grep", { pattern: "NODE_ENV|debug", path: "/app/src" }),
    () => check("config.env", "config", "Production configuration", "pass", "No debug output, error pages hide stack traces."),
    () => check("auth.signup", "auth", "Sign-up and login", "running"),
    () => tool("mcp__playwright__browser_navigate", { url: `${url}/register` }),
    () => tool("mcp__playwright__browser_type", { element: "Password field", text: "never-shown" }),
    () => tool("Bash", { command: "mysql -h db1 -e 'select email, password from users limit 1'", description: "Check how passwords are stored" }),
    () => check("auth.signup", "auth", "Sign-up and login", "pass", "Passwords are stored as bcrypt hashes; login works."),
    () => check("auth.session", "auth", "Session cookies", "running"),
    () => tool("Bash", { command: `curl -si ${url}/api/auth/session`, description: "Inspect the session cookie flags" }),
    () => check("auth.session", "auth", "Session cookies", ready ? "pass" : "warn", ready ? "HttpOnly, SameSite=Lax." : "Session cookie lacks HttpOnly."),
    () => check("auth.reset", "auth", "Password reset", "running"),
    () => tool("WebFetch", { url: "http://mail:8025/api/v1/messages" }),
    () => check("auth.reset", "auth", "Password reset", "pass", "Reset mail arrives in the mail catcher; the link works once."),
    () => check("features.cart", "features", "Cart", "running"),
    () => tool("mcp__playwright__browser_click", { element: "Add to cart" }),
    () => check("features.cart", "features", "Cart", "pass", "Quantities, removal and totals are correct."),
    () => check("payments.checkout", "payments", "Checkout in test mode", "running"),
    () => think("Paying with the published Stripe test card 4242… in test mode."),
    () => tool("mcp__playwright__browser_navigate", { url: `${url}/checkout` }),
    () => check("payments.checkout", "payments", "Checkout in test mode", "pass", "Test payment succeeds, order is created, confirmation e-mail sent."),
    () => check("payments.price", "payments", "Server decides the price", "running"),
    () => tool("Read", { file_path: "/app/src/app/api/checkout/route.ts" }),
    () => check("payments.price", "payments", "Server decides the price", ready ? "pass" : "fail", ready ? "Prices are looked up on the server." : "The amount charged comes from the browser's request body."),
    () => check("payments.webhook", "payments", "Webhook signature", "running"),
    () => tool("Bash", { command: `curl -s -X POST ${url}/api/stripe/webhook -d '{}'`, description: "Send an unsigned webhook event" }),
    () => check("payments.webhook", "payments", "Webhook signature", "pass", "Unsigned events are rejected with 400."),
    () => check("database.queries", "database", "Query safety", "running"),
    () => tool("Grep", { pattern: "\\$queryRawUnsafe|query\\(`", path: "/app/src" }),
    () => check("database.queries", "database", "Query safety", "pass", "All queries go through Prisma with parameters."),
    () => check("database.access", "database", "Data access rules", "running"),
    () => tool("Bash", { command: `curl -s ${url}/api/orders/2`, description: "Try to read another customer's order" }),
    () => check("database.access", "database", "Data access rules", "pass", "Other customers' orders return 404."),
    () => check("security.headers", "security", "Security headers", "running"),
    () => tool("Bash", { command: `curl -sI ${url}/`, description: "Read the response headers" }),
    () => check("security.headers", "security", "Security headers", "warn", "No Content-Security-Policy."),
    () => check("security.deps", "security", "Dependencies", "running"),
    () => tool("Bash", { command: "cd /app && npm audit --omit=dev --json | head -40", description: "Audit production dependencies" }),
    () => check("security.deps", "security", "Dependencies", "pass", "No known high-severity advisories."),
    () => check("features.contact", "features", "Contact form", "running"),
    () => tool("mcp__playwright__browser_click", { element: "Send message" }),
    () => check("features.contact", "features", "Contact form", "pass", "Message delivered to the mail catcher."),
  ];
  const per = Math.max(250, Math.round(24_000 / script.length));
  for (const fn of script) {
    fn();
    await step(per);
  }
  const fl = [
    { id: "security.csp", severity: "medium", category: "security", title: "No Content-Security-Policy header", plain: "The site doesn't tell browsers which scripts it trusts. If an attacker ever slipped a script onto a page, nothing would stop it running for your customers. It's an extra safety net rather than an open door.", detail: "Pages are served without a CSP, so an injected script would run unrestricted.", fix: "Add a Content-Security-Policy in next.config.js headers(), starting with default-src 'self' and the Stripe domains you load.", location: "next.config.js" },
    { id: "config.rate-limit", severity: "low", category: "config", title: "Login has no rate limit", plain: "Anyone can try passwords on the sign-in page as fast as they like. That makes it easier to guess weak passwords and break into customer accounts.", detail: "20 wrong passwords in a row were all answered normally.", fix: "Limit /api/auth/login to ~5 attempts per minute per IP and per account (e.g. a small in-memory or Redis token bucket).", location: "src/app/api/auth/login/route.ts" },
  ];
  if (!ready) {
    fl.unshift(
      { id: "payments.client-price", severity: "critical", category: "payments", title: "The browser decides how much is charged", plain: "The checkout takes the price from the customer's own browser. Anyone with a little know-how can change it and pay one cent for a €49 order. This would cost you real money as soon as someone notices.", detail: "POST /api/checkout uses `amount` from the request body; changing it to 1 charged €0.01 for a €49 order (test mode).", fix: "Ignore client amounts: load the cart's products from the database on the server and compute line items and total there before creating the Stripe session.", location: "src/app/api/checkout/route.ts:18" },
      { id: "auth.cookie-httponly", severity: "high", category: "auth", title: "Session cookie readable by JavaScript", plain: "The pass that keeps a customer signed in can be read by scripts on the page. If any script ever got onto the site, it could steal those passes and use customers' accounts.", detail: "The `session` cookie is set without HttpOnly, so any XSS can steal sessions.", fix: "Set httpOnly: true (and secure: true, sameSite: 'lax') where the session cookie is created.", location: "src/lib/session.ts:41" },
    );
  }
  for (const f of fl) {
    const ev = cleanEvent({ t: "finding", ...f });
    findings.set(ev.id, ev);
    emit(ev);
    await step(300);
  }
  emit({ t: "usage", turns: 64, durationMs: 31_000 });
  for (const a of streamJsonEvents(JSON.stringify({ type: "result", subtype: "success", num_turns: 64, duration_ms: 31_000 })).activity) emit({ t: "activity", ...a });
  phase("reporting", "Reading Claude's report");
  await step(1200);
  const cs = [...checks.values()];
  const fs_ = [...findings.values()];
  const { verdict } = decideVerdict({ checks: cs, findings: fs_, complete: true });
  const score = computeScore({ checks: cs, findings: fs_, verdict });
  const summary = verdict === "ready"
    ? "Checkout, accounts and the shop work end to end in test mode and no blocking problems were found. Two hardening improvements are listed."
    : "Not ready: the checkout trusts a price sent by the browser and session cookies are readable by scripts. Fix those two before deploying.";
  const plainSummary = verdict === "ready"
    ? "This version looks safe to put live. Customers can sign up, shop and pay (with test cards), and nothing serious turned up. There are two smaller safety improvements worth doing when you have time."
    : "Don't put this version live yet. Most of the site works, but customers can change the price they pay at checkout, and the way sign-ins are stored makes accounts easier to steal. Fix those two first; the rest can wait.";
  emit({ t: "report", verdict, score, summary, plainSummary, complete: true });
  log("[dry-run] simulated test finished.");
  return { verdict, score, summary, plainSummary, complete: true, checks: cs.length, findings: fs_.length, usage: { turns: 64, durationMs: 31_000 }, simulated: true };
}
