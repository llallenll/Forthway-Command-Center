/**
 * TESTS — commit testing (docs/DOCKER-AND-TESTS.md §2).
 *
 * "Test this commit": instead of deploying a release, the panel sends task
 * `site.test` to the server chosen for tests. There shared/testenv.mjs builds
 * a throw-away copy of the website (own containers, an empty database, a mail
 * catcher, live payment keys removed), runs Claude Code in a sandboxed tester
 * container against that copy only, and tears it all down. Production is
 * never touched.
 *
 * This module owns the panel side:
 *   - collections `testRuns` (one per run) and `testSettings` (per-site
 *     test-only variables, values encrypted at rest);
 *   - the tester settings in config.tester (Claude Code token encrypted —
 *     never returned by any route — model, time limit, test server);
 *   - the job that runs a test, turning the runner's `@@fcc-test {json}` log
 *     lines into the run record (applyEvent) and broadcasting it as the SSE
 *     event `testrun`, at most twice a second;
 *   - routes listed in the contract.
 *
 * The run's verdict is decided by the rule in shared/testenv.mjs
 * (decideVerdict): Claude's own verdict can only make it stricter.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { httpError } from "./http.mjs";
import { isEnvKey, cleanEnvValue } from "../../shared/env.mjs";
import {
  parseEventLine,
  decideVerdict,
  computeScore,
  isLivePaymentValue,
  CATEGORIES,
  TESTER_IMAGE,
  DEFAULT_MAX_MINUTES,
  DEFAULT_MAX_TURNS,
  STALE_MS,
} from "../../shared/testenv.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(HERE, "..", "templates", "tester");

export const RUNS = "testRuns";
export const SETTINGS = "testSettings";
export const ACTIVE_STATUSES = ["queued", "preparing", "testing", "reporting"];
const TERMINAL_CHECK = ["pass", "warn", "fail", "skip"];
const ACTIVITY_CAP = 300;
const CHECKS_CAP = 250;
const FINDINGS_CAP = 150;
const KEEP_RUNS_PER_SITE = 30;
const BROADCAST_MS = 500; // ≤ 2 updates a second per run
const MAX_TEST_VARS = 100;
const MAX_VALUE = 8 * 1024;

const now = () => new Date().toISOString();
const isActive = (run) => ACTIVE_STATUSES.includes(run?.status);

// ------------------------------------------------------------ pure parts

/** A new run record (before it has an id). */
export function newRun({ site, release, serverId, adminId }) {
  const g = release?.github || null;
  const sha = g?.sha || release?.commit || null;
  const author = g?.author && typeof g.author === "object" ? g.author.name || g.author.login || null : g?.author || null;
  return {
    siteId: site.id,
    projectId: site.projectId || null,
    releaseId: release.id,
    serverId,
    jobId: null,
    adminId: adminId || null,
    commit: sha ? { sha, shortSha: String(sha).slice(0, 7), message: String(g?.message || "").split("\n")[0].slice(0, 300), author } : null,
    version: release.version || null,
    status: "queued",
    phase: "Waiting to start",
    verdict: null,
    score: null,
    summary: "",
    checks: [],
    findings: [],
    activity: [],
    env: { url: "", database: false, mail: false },
    usage: null,
    complete: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}

/**
 * Fold one event from the runner into a run (mutates and returns it).
 * Events after the run has finished are ignored.
 */
export function applyEvent(run, ev, at = now()) {
  if (!run || !ev) return run;
  if (!isActive(run)) return run;
  switch (ev.t) {
    case "phase":
      run.status = ev.status;
      if (ev.phase) run.phase = ev.phase;
      if (!run.startedAt) run.startedAt = at;
      break;
    case "env":
      run.env = { url: ev.url, database: !!ev.database, mail: !!ev.mail };
      break;
    case "check": {
      const list = (run.checks ||= []);
      let c = list.find((x) => x.id === ev.id);
      if (!c) {
        if (list.length >= CHECKS_CAP) break;
        c = { id: ev.id, category: ev.category, title: ev.title, status: "pending", detail: "", startedAt: null, finishedAt: null };
        list.push(c);
      }
      c.category = ev.category || c.category;
      c.title = ev.title || c.title;
      if (ev.detail) c.detail = ev.detail;
      c.status = ev.status;
      if (ev.status === "running") {
        c.startedAt ||= at;
        c.finishedAt = null;
      } else if (TERMINAL_CHECK.includes(ev.status)) {
        c.startedAt ||= at;
        c.finishedAt = at;
      }
      break;
    }
    case "finding": {
      const list = (run.findings ||= []);
      const key = (f) => `${f.category}|${String(f.title).toLowerCase()}`;
      const f = list.find((x) => x.id === ev.id) || list.find((x) => key(x) === key(ev));
      const { t, ...data } = ev;
      if (f) {
        for (const [k, v] of Object.entries(data)) if (v !== "" && v != null && k !== "id") f[k] = v;
      } else if (list.length < FINDINGS_CAP) list.push(data);
      break;
    }
    case "activity": {
      const list = (run.activity ||= []);
      list.push({ at, kind: ev.kind, text: ev.text });
      if (list.length > ACTIVITY_CAP) list.splice(0, list.length - ACTIVITY_CAP);
      break;
    }
    case "usage":
      run.usage = { turns: ev.turns, durationMs: ev.durationMs };
      break;
    case "report": {
      const { verdict } = decideVerdict({ checks: run.checks, findings: run.findings, reported: ev.verdict, complete: ev.complete });
      run.verdict = verdict;
      run.score = computeScore({ checks: run.checks, findings: run.findings, reported: ev.score, verdict });
      run.summary = ev.summary || run.summary;
      run.complete = ev.complete;
      run.status = "reporting";
      break;
    }
  }
  return run;
}

/**
 * Close a run when its job ends. `cancelled` / `error` win; otherwise the run
 * is done, with a verdict (from the report event, or decided here from what
 * arrived if the runner never sent one). Checks still running are skipped.
 */
export function finalizeRun(run, { error = null, cancelled = false, result = null } = {}, at = now()) {
  for (const c of run.checks || []) {
    if (c.status === "running" || c.status === "pending") {
      c.status = "skip";
      c.detail = c.detail || "Not finished.";
      c.finishedAt = at;
    }
  }
  run.finishedAt = at;
  if (cancelled) {
    run.status = "cancelled";
    run.phase = "Cancelled — the test environment was removed.";
    run.verdict = null;
    run.score = null;
    return run;
  }
  if (error) {
    run.status = "error";
    run.error = String(error).slice(0, 2000);
    run.phase = "The test could not run.";
    run.verdict = null;
    run.score = null;
    return run;
  }
  if (!run.verdict) {
    const complete = result?.complete ?? false;
    const { verdict, reasons } = decideVerdict({ checks: run.checks, findings: run.findings, reported: result?.verdict || null, complete });
    run.verdict = verdict;
    run.score = computeScore({ checks: run.checks, findings: run.findings, reported: Number.isFinite(result?.score) ? result.score : null, verdict });
    run.summary = run.summary || result?.summary || (verdict === "ready" ? "No blocking problems were found." : `Not ready: ${reasons.join("; ")}.`);
    run.complete = complete;
  }
  if (result?.usage && !run.usage) run.usage = { turns: Number(result.usage.turns) || 0, durationMs: Number(result.usage.durationMs) || 0 };
  run.status = "done";
  run.phase = run.verdict === "ready" ? "Ready for production" : "Not ready for production";
  return run;
}

/** The list view of a run: no checklist, activity or finding text. */
export function runSummary(run) {
  const sev = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of run.findings || []) if (f.severity in sev) sev[f.severity]++;
  const cs = run.checks || [];
  return {
    id: run.id,
    siteId: run.siteId,
    releaseId: run.releaseId,
    serverId: run.serverId,
    jobId: run.jobId,
    commit: run.commit,
    version: run.version,
    status: run.status,
    phase: run.phase,
    verdict: run.verdict,
    score: run.score,
    summary: run.summary,
    counts: {
      checks: cs.length,
      passed: cs.filter((c) => c.status === "pass").length,
      warned: cs.filter((c) => c.status === "warn").length,
      failed: cs.filter((c) => c.status === "fail").length,
      findings: (run.findings || []).length,
      bySeverity: sev,
    },
    error: run.error,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const byNewest = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt));

/**
 * GET /api/tests filtering. `runs` may be in any order; the result is newest first.
 * status: a run status, or "active" (queued → reporting) / "finished" (done, error, cancelled).
 * verdict: "ready" | "not_ready". limit: 1–500 (default 100).
 */
export function filterRuns(runs, { siteId = "", status = "", verdict = "", limit } = {}) {
  const n = Number(limit);
  const max = Number.isInteger(n) && n > 0 ? Math.min(n, 500) : 100;
  const st = String(status || "");
  return (runs || [])
    .filter((r) => !siteId || r.siteId === siteId)
    .filter((r) => !st || (st === "active" ? isActive(r) : st === "finished" ? !isActive(r) : r.status === st))
    .filter((r) => !verdict || r.verdict === verdict)
    .sort(byNewest)
    .slice(0, max);
}

/**
 * The header numbers of the Testing page. Rates and the average cover finished
 * runs with a verdict from the last 7 days (null when there are none).
 * `siteIds` = every website, for "never tested".
 */
export function testStats(runs, siteIds = [], at = Date.now()) {
  const all = runs || [];
  const since = at - 7 * DAY_MS;
  const week = all.filter((r) => Date.parse(r.createdAt) >= since);
  const judged = week.filter((r) => r.status === "done" && (r.verdict === "ready" || r.verdict === "not_ready"));
  const ready = judged.filter((r) => r.verdict === "ready").length;
  const scores = judged.map((r) => r.score).filter((s) => Number.isFinite(s));
  const tested = new Set(all.map((r) => r.siteId));
  const never = siteIds.filter((id) => !tested.has(id));
  return {
    total: all.length,
    last7d: week.length,
    judged7d: judged.length,
    ready7d: ready,
    notReady7d: judged.length - ready,
    failed7d: week.filter((r) => r.status === "error").length,
    readyRate: judged.length ? Math.round((ready / judged.length) * 100) : null,
    avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    active: all.filter(isActive).length,
    sites: siteIds.length,
    sitesTested: siteIds.length - never.length,
    sitesNeverTested: never.length,
    neverTestedIds: never,
  };
}

/** Validate a PUT /api/tester body against the current settings → the new settings (token handled by the caller). */
export function cleanTesterInput(body = {}, current = {}, { serverExists = () => true } = {}) {
  const out = { ...current };
  if ("model" in body) {
    const m = String(body.model ?? "").trim();
    if (m && !/^[A-Za-z0-9.:\[\]_-]{1,80}$/.test(m)) throw httpError(400, "That model name is not valid (for example: sonnet, opus, or a full model id).");
    out.model = m;
  }
  if ("maxMinutes" in body) {
    const n = Number(body.maxMinutes);
    if (!Number.isInteger(n) || n < 10 || n > 180) throw httpError(400, "The time limit must be a whole number of minutes between 10 and 180.");
    out.maxMinutes = n;
  }
  if ("maxTurns" in body) {
    const n = Number(body.maxTurns);
    if (!Number.isInteger(n) || n < 20 || n > 1000) throw httpError(400, "The turn limit must be a whole number between 20 and 1000.");
    out.maxTurns = n;
  }
  if ("serverId" in body) {
    const s = String(body.serverId ?? "").trim();
    if (s && !serverExists(s)) throw httpError(400, `There is no server "${s}".`);
    out.serverId = s;
  }
  return out;
}

/** A Claude Code token from `claude setup-token`; an Anthropic API key is refused (tests use the owner's subscription). */
export function checkToken(raw) {
  const t = String(raw ?? "").trim();
  if (/^sk-ant-api/i.test(t)) throw httpError(400, "That is an Anthropic API key. Tests run on your Claude subscription instead: run `claude setup-token` on your own computer and paste the token it prints.");
  if (t.length < 20 || t.length > 500 || /\s/.test(t)) throw httpError(400, "That doesn't look like a Claude Code token. Run `claude setup-token` and paste the whole token it prints.");
  return t;
}

/**
 * Merge a PUT /api/sites/:id/test-env body into the stored (encrypted) map.
 * `encrypt` turns a value into its stored form. Live payment keys are refused.
 */
export function mergeTestEnv(prev = {}, input = {}, encrypt = (v) => v) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError(400, "Send the variables as { env: { KEY: \"value\" } }.");
  const out = { ...prev };
  for (const [k, v] of Object.entries(input)) {
    if (!isEnvKey(k)) throw httpError(400, `"${k}" is not a valid variable name.`);
    if (v == null) {
      delete out[k];
      continue;
    }
    const val = cleanEnvValue(String(v));
    if (val.length > MAX_VALUE) throw httpError(400, `${k} is too long.`);
    if (isLivePaymentValue(val)) throw httpError(400, `${k} holds a LIVE payment key. Test-only variables must use your provider's test-mode keys (for Stripe: sk_test_… / pk_test_…).`);
    out[k] = encrypt(val);
  }
  if (Object.keys(out).length > MAX_TEST_VARS) throw httpError(400, `At most ${MAX_TEST_VARS} test-only variables.`);
  return out;
}

// ------------------------------------------------------------------ module

export function register(router, ctx) {
  const db = ctx.db;
  const MAIN = () => ctx.cluster?.MAIN_ID || "main";
  const live = new Map(); // runId -> in-memory run while its job runs
  const timers = new Map(); // runId -> pending broadcast timer

  // ---------------------------------------------------------- helpers

  function encrypt(v) {
    return v ? (ctx.secrets?.encrypt ? ctx.secrets.encrypt(v) : v) : "";
  }
  function decrypt(v) {
    if (!v) return "";
    if (!ctx.secrets?.decrypt) return v;
    try {
      return ctx.secrets.decrypt(v);
    } catch {
      return "";
    }
  }
  function audit(admin, action, target, details) {
    try {
      ctx.activity?.(admin, action, target, details);
    } catch {
      /* never break an operation */
    }
  }
  const siteTarget = (site) => ({ type: "site", id: site.id, name: site.name });
  const getSite = (id) => ctx.sites?.get?.(id) || db.get("sites", id);
  function mustSite(id) {
    const s = getSite(id);
    if (!s || s.deleting) throw httpError(404, "Website not found.");
    return s;
  }
  function getServer(id) {
    if (!id) return null;
    if (ctx.cluster?.getServer) return ctx.cluster.getServer(id) || null;
    return id === MAIN() ? { id, name: "Main", role: "main" } : null;
  }
  const serverName = (id) => getServer(id)?.name || id;
  function isOnline(id) {
    try {
      return ctx.cluster?.isOnline ? !!ctx.cluster.isOnline(id) : id === MAIN();
    } catch {
      return false;
    }
  }
  const cfg = () => ctx.config.tester || {};
  function saveTester(next) {
    ctx.config.tester = next;
    ctx.saveConfig?.();
  }
  function testerView() {
    const c = cfg();
    return {
      tokenSet: !!c.tokenEnc,
      model: c.model || "",
      maxMinutes: c.maxMinutes || DEFAULT_MAX_MINUTES,
      maxTurns: c.maxTurns || DEFAULT_MAX_TURNS,
      image: TESTER_IMAGE,
      serverId: c.serverId || "",
      serverName: c.serverId ? serverName(c.serverId) : null,
      categories: CATEGORIES,
    };
  }

  const runRecord = (id) => live.get(id) || db.get(RUNS, id);
  function mustRun(id) {
    const r = runRecord(id);
    if (!r) throw httpError(404, "Test run not found.");
    return r;
  }
  function publicRun(run) {
    const release = db.get("releases", run.releaseId);
    return {
      ...run,
      serverName: run.serverId ? serverName(run.serverId) : null,
      siteName: getSite(run.siteId)?.name || null,
      adminName: run.adminId ? db.get("admins", run.adminId)?.name || null : null,
      releaseExists: !!release,
      canDeploy: run.status === "done" && !!release && !!ctx.sites?.deploy,
    };
  }
  function broadcastNow(run) {
    clearTimeout(timers.get(run.id));
    timers.delete(run.id);
    try {
      ctx.events?.broadcast?.("testrun", publicRun(run));
    } catch {
      /* SSE hiccups never break a run */
    }
  }
  /** Persist and broadcast, at most every BROADCAST_MS (the last state always goes out). */
  function touch(run, { now: immediate = false } = {}) {
    const save = () => {
      const { id, ...rest } = run;
      db.update(RUNS, id, rest);
      broadcastNow(run);
    };
    if (immediate) return save();
    if (timers.has(run.id)) return;
    timers.set(run.id, setTimeout(save, BROADCAST_MS));
  }

  function siteRuns(siteId) {
    return db.list(RUNS, { siteId }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  function activeRun(siteId) {
    return siteRuns(siteId).find(isActive) || null;
  }
  function pruneRuns(siteId) {
    const old = siteRuns(siteId).filter((r) => !isActive(r)).slice(KEEP_RUNS_PER_SITE);
    for (const r of old) db.remove(RUNS, r.id);
  }

  function pickServer(site) {
    const wanted = cfg().serverId;
    if (wanted && getServer(wanted)) return wanted;
    return ctx.sites?.targets?.(site)?.[0] || site.serverIds?.[0] || MAIN();
  }

  function readTemplates() {
    const read = (f) => fs.readFileSync(path.join(TEMPLATE_DIR, f), "utf8");
    return { Dockerfile: read("Dockerfile"), "fcc-report.mjs": read("fcc-report.mjs"), "PROMPT.md": read("PROMPT.md") };
  }

  /** Every address a test container must never reach: cluster servers, the panel, remote database hosts. */
  function blockHosts(spec) {
    const out = new Set();
    for (const s of ctx.cluster?.listServers?.() || []) {
      if (s.host) out.add(String(s.host));
      if (s.privateHost) out.add(String(s.privateHost));
    }
    try {
      out.add(new URL(ctx.panelUrl?.() || "http://x").hostname);
    } catch { /* ignore */ }
    const mh = ctx.config?.mysql?.host;
    if (mh) out.add(String(mh));
    for (const [k, v] of Object.entries(spec?.env || {})) {
      if (/(^|_)(DB|MYSQL|DATABASE)_HOST$/.test(k) && v) out.add(String(v));
    }
    out.delete("x");
    return [...out].filter((h) => h && !/^(localhost|127\.|::1$)/.test(h));
  }

  /** Release payload: the sites module's own (download URL + token, or the local file on main). */
  function releaseFor(release, serverId, base) {
    if (ctx.sites?.releasePayload) return ctx.sites.releasePayload(release, serverId, base);
    // Fallback while the sites module does not expose releasePayload: main only, local file.
    if (serverId !== MAIN()) throw new Error("This panel can't send a release to another server for testing yet — choose the main server for tests in Settings → Website testing.");
    const file = ctx.sites?.releaseFile?.(release.id) || path.join(ctx.dataDir, "releases", `${release.id}.zip`);
    return { id: release.id, file, sha256: release.sha256, size: release.size, filename: release.filename, version: release.version || null };
  }

  /** Run the task on the server; on main, fall back to running it in-process if the executor doesn't know site.test yet. */
  async function runTestTask(serverId, payload, { log, signal, base, timeoutMs }) {
    const inProcess = async () => {
      const { runSiteTest } = await import("../../shared/testenv.mjs");
      return runSiteTest(payload, { log, signal, dataDir: ctx.dataDir, isMain: true, panelUrl: base });
    };
    if (!ctx.cluster?.runTask) {
      if (serverId !== MAIN()) throw new Error("The server cluster module is not available.");
      return inProcess();
    }
    try {
      return await ctx.cluster.runTask(serverId, "site.test", payload, { log, signal, timeoutMs });
    } catch (err) {
      if (/Unknown task type/i.test(err?.message || "") && serverId === MAIN() && (ctx.ha ? ctx.ha.mainIsLocal !== false : true)) return inProcess();
      throw err;
    }
  }

  // ------------------------------------------------------------ a run

  function startRun(site, release, admin, req) {
    const serverId = pickServer(site);
    const server = getServer(serverId);
    if (!server) throw httpError(400, `The test server "${serverId}" no longer exists. Pick another in Settings → Website testing.`);
    if (!isOnline(serverId)) throw httpError(409, `${server.name || serverId} is offline, so it can't run tests right now.`);
    const tester = cfg();
    const token = decrypt(tester.tokenEnc);
    if (!token && !ctx.sys?.DRY_RUN) throw httpError(400, "Add your Claude Code token in Settings → Website testing first (run `claude setup-token` on your own computer to make one).");
    if (!ctx.jobs?.start) throw httpError(503, "The jobs module is not available.");

    const base = ctx.sites?.panelBase ? ctx.sites.panelBase(req) : String(ctx.panelUrl?.(req) || "").replace(/\/+$/, "");
    const run = db.insert(RUNS, { id: db.newId ? db.newId("trn") : undefined, ...newRun({ site, release, serverId, adminId: admin?.id }) });
    live.set(run.id, run);
    const label = release.version ? `v${release.version}` : run.commit?.shortSha || release.id;

    const job = ctx.jobs.start(
      { type: "site.test", title: `Test ${site.name} ${label}`, projectId: site.projectId, siteId: site.id, serverId, adminId: admin?.id || null },
      async ({ log, signal }) => {
        run.status = "preparing";
        run.phase = "Getting the test environment ready";
        run.startedAt = now();
        touch(run, { now: true });
        let result = null;
        try {
          const fresh = getSite(site.id);
          if (!fresh) throw new Error("The website was deleted.");
          if (!ctx.sites?.specForAsync && !ctx.sites?.specFor) throw new Error("The websites module is not available.");
          const spec = ctx.sites.specForAsync ? await ctx.sites.specForAsync(fresh, serverId) : ctx.sites.specFor(fresh, serverId);
          const linked = ctx.sites.linkedEnvSources ? (await ctx.sites.linkedEnvSources(fresh, serverId)) || [] : [];
          const stored = db.get(SETTINGS, site.id)?.env || {};
          const testEnv = Object.fromEntries(Object.entries(stored).map(([k, v]) => [k, decrypt(v)]).filter(([, v]) => v !== ""));
          const maxMinutes = tester.maxMinutes || DEFAULT_MAX_MINUTES;
          const staleRunIds = db
            .list(RUNS, (r) => r.serverId === serverId && (r.status === "error" || r.status === "cancelled") && r.finishedAt && Date.now() - Date.parse(r.finishedAt) < STALE_MS)
            .map((r) => r.id)
            .slice(0, 50);
          const payload = {
            runId: run.id,
            siteId: site.id,
            siteName: fresh.name,
            spec,
            release: releaseFor(release, serverId, base),
            linked: linked.map((l) => ({ databaseId: l.databaseId, name: l.name, prefix: l.prefix || "", vars: l.vars || {} })),
            testEnv,
            afterDeployScripts: fresh.settings?.afterDeployScripts || [],
            tester: { token, model: tester.model || "", maxMinutes, maxTurns: tester.maxTurns || DEFAULT_MAX_TURNS },
            files: readTemplates(),
            blockHosts: blockHosts(spec),
            staleRunIds,
            commit: run.commit ? { shortSha: run.commit.shortSha, message: run.commit.message } : null,
          };
          const onLine = (text) => {
            for (const line of String(text ?? "").split("\n")) {
              const ev = parseEventLine(line);
              if (ev) {
                applyEvent(run, ev);
                touch(run);
              } else if (line) log(line);
            }
          };
          log(`Testing ${fresh.name} ${label} on ${serverName(serverId)} — production is not touched.`);
          result = await runTestTask(serverId, payload, { log: onLine, signal, base, timeoutMs: (maxMinutes + 120) * 60_000 });
          finalizeRun(run, { result });
          log(`Verdict: ${run.verdict === "ready" ? "ready for production" : "not ready"} (score ${run.score}).`);
          return { runId: run.id, verdict: run.verdict, score: run.score };
        } catch (err) {
          if (signal?.aborted || err?.aborted) finalizeRun(run, { cancelled: true });
          else finalizeRun(run, { error: err?.message || String(err) });
          throw err;
        } finally {
          touch(run, { now: true });
          live.delete(run.id);
          audit(admin, "test.finish", siteTarget(site), { runId: run.id, status: run.status, verdict: run.verdict, score: run.score });
        }
      },
    );
    run.jobId = job?.id || null;
    touch(run, { now: true });
    pruneRuns(site.id);
    return run;
  }

  // ------------------------------------------------------------ routes

  router.get("/api/sites/:id/tests", async (req, res, { params }) => {
    const site = mustSite(params.id);
    return { items: siteRuns(site.id).map((r) => runSummary(live.get(r.id) || r)) };
  });

  router.post("/api/sites/:id/tests", async (req, res, { params, body, admin }) => {
    const site = mustSite(params.id);
    const releaseId = body?.releaseId ? String(body.releaseId) : null;
    const release = releaseId
      ? db.get("releases", releaseId)
      : db.list("releases", { siteId: site.id }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (!release || release.siteId !== site.id) throw httpError(releaseId ? 404 : 409, releaseId ? "Release not found." : "This website has no releases yet. Pull a commit from GitHub or upload a zip first.");
    const file = ctx.sites?.releaseFile?.(release.id) || path.join(ctx.dataDir, "releases", `${release.id}.zip`);
    if (!fs.existsSync(file)) throw httpError(409, "That release's archive is missing.");
    const running = activeRun(site.id);
    if (running) throw httpError(409, "A test is already running for this website. Wait for it to finish or cancel it.", { runId: running.id });
    const run = startRun(site, release, admin, req);
    audit(admin, "test.start", siteTarget(site), { runId: run.id, releaseId: release.id, version: release.version || null, serverId: run.serverId });
    return publicRun(run);
  });

  // Every website's runs (the Testing page): summaries newest first + header stats.
  router.get("/api/tests", async (req, res, { query }) => {
    const q = query || {};
    const sites = db.list("sites", (s) => !s.deleting);
    const siteById = new Map(sites.map((s) => [s.id, s]));
    const runs = db.list(RUNS, (r) => siteById.has(r.siteId)).map((r) => live.get(r.id) || r);
    const projectName = new Map();
    const projectOf = (id) => {
      if (!id) return null;
      if (!projectName.has(id)) projectName.set(id, db.get("projects", id)?.name || null);
      return projectName.get(id);
    };
    const items = filterRuns(runs, { siteId: q.siteId ? String(q.siteId) : "", status: q.status ? String(q.status) : "", verdict: q.verdict ? String(q.verdict) : "", limit: q.limit }).map((r) => {
      const site = siteById.get(r.siteId);
      const projectId = site?.projectId || r.projectId || null;
      return { ...runSummary(r), siteName: site?.name || null, siteType: site?.type || null, projectId, projectName: projectOf(projectId), serverName: r.serverId ? serverName(r.serverId) : null };
    });
    const stats = testStats(runs, sites.map((s) => s.id));
    stats.neverTested = stats.neverTestedIds.slice(0, 20).map((id) => ({ id, name: siteById.get(id)?.name || id }));
    delete stats.neverTestedIds;
    return { items, stats };
  });

  router.get("/api/tests/:id", async (req, res, { params }) => publicRun(mustRun(params.id)));

  router.post("/api/tests/:id/cancel", async (req, res, { params, admin }) => {
    const run = mustRun(params.id);
    if (!isActive(run)) return publicRun(run);
    const job = run.jobId ? ctx.jobs?.get?.(run.jobId) : null;
    if (job && (job.status === "queued" || job.status === "running")) {
      ctx.jobs.cancel(run.jobId, { by: admin?.id });
      run.phase = "Cancelling — removing the test environment…";
      touch(run, { now: true });
    } else {
      // No job behind it (lost in a restart): just close the record.
      const rec = { ...run };
      finalizeRun(rec, { cancelled: true });
      const { id, ...rest } = rec;
      db.update(RUNS, id, rest);
      broadcastNow(rec);
    }
    const site = getSite(run.siteId);
    if (site) audit(admin, "test.cancel", siteTarget(site), { runId: run.id });
    return publicRun(runRecord(run.id));
  });

  router.post("/api/tests/:id/deploy", async (req, res, { params, admin }) => {
    const run = mustRun(params.id);
    if (run.status !== "done") throw httpError(409, "Only a finished test can be deployed from.");
    const site = mustSite(run.siteId);
    const release = db.get("releases", run.releaseId);
    if (!release) throw httpError(404, "The tested release has been deleted.");
    if (!ctx.sites?.deploy) throw httpError(501, "This panel's websites module can't deploy from a test yet. Deploy the release from the website's Releases tab.");
    const base = ctx.sites.panelBase ? ctx.sites.panelBase(req) : ctx.panelUrl?.(req);
    const job = await ctx.sites.deploy(site.id, release.id, { admin, base });
    audit(admin, "test.deploy", siteTarget(site), { runId: run.id, releaseId: release.id, verdict: run.verdict, score: run.score });
    return job;
  });

  router.delete("/api/tests/:id", async (req, res, { params, admin }) => {
    const run = mustRun(params.id);
    if (isActive(run)) throw httpError(409, "Cancel the test before deleting it.");
    db.remove(RUNS, run.id);
    try {
      ctx.events?.broadcast?.("testrun", { id: run.id, siteId: run.siteId, deleted: true });
    } catch { /* ignore */ }
    const site = getSite(run.siteId);
    if (site) audit(admin, "test.delete", siteTarget(site), { runId: run.id });
    return { ok: true };
  });

  // ---- test-only variables

  const testEnvView = (siteId) => ({
    items: Object.keys(db.get(SETTINGS, siteId)?.env || {})
      .sort()
      .map((key) => ({ key, set: true })),
  });

  router.get("/api/sites/:id/test-env", async (req, res, { params }) => testEnvView(mustSite(params.id).id));

  router.put("/api/sites/:id/test-env", async (req, res, { params, body, admin }) => {
    const site = mustSite(params.id);
    const prev = db.get(SETTINGS, site.id);
    const env = mergeTestEnv(prev?.env || {}, body?.env, encrypt);
    if (prev) db.update(SETTINGS, site.id, { env });
    else db.insert(SETTINGS, { id: site.id, env });
    const changed = Object.keys(body?.env || {});
    audit(admin, "test.env", siteTarget(site), { keys: changed, removed: changed.filter((k) => body.env[k] == null) });
    return testEnvView(site.id);
  });

  // ---- tester settings

  router.get("/api/tester", async () => testerView());

  router.put("/api/tester", async (req, res, { body, admin }) => {
    const b = body || {};
    const next = cleanTesterInput(b, cfg(), { serverExists: (id) => !!getServer(id) });
    let tokenChanged = false;
    if (b.clearToken) {
      next.tokenEnc = "";
      tokenChanged = true;
    } else if (typeof b.token === "string" && b.token.trim()) {
      next.tokenEnc = encrypt(checkToken(b.token));
      tokenChanged = true;
    }
    saveTester(next);
    audit(admin, "tester.update", { type: "settings", id: "tester", name: "Website testing" }, { tokenChanged, cleared: !!b.clearToken, model: next.model || "", maxMinutes: next.maxMinutes || DEFAULT_MAX_MINUTES, serverId: next.serverId || "" });
    return testerView();
  });

  ctx.siteTests = {
    /** Latest run of a release (for the releases list badge). */
    latestFor: (releaseId) => db.list(RUNS, { releaseId }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null,
    summary: runSummary,
  };
}

// ----------------------------------------------------------------- start

export async function start(ctx) {
  const db = ctx.db;
  // Runs that were in flight when the panel stopped can't be resumed.
  const interrupted = [];
  for (const r of db.list(RUNS, (x) => ACTIVE_STATUSES.includes(x.status))) {
    const rec = finalizeRun({ ...r }, { error: "The panel restarted while this test was running. Run it again." });
    const { id, ...rest } = rec;
    db.update(RUNS, id, rest);
    interrupted.push(r);
  }
  // Runs of deleted websites go with them.
  for (const r of db.list(RUNS, (x) => !db.get("sites", x.siteId))) db.remove(RUNS, r.id);
  for (const s of db.list(SETTINGS, (x) => !db.get("sites", x.id))) db.remove(SETTINGS, s.id);

  // Clean what interrupted or crashed runs left on this server (main) in the
  // background; agent servers clean up at the start of their next run.
  const mainLocal = ctx.ha ? ctx.ha.mainIsLocal !== false : true;
  if (mainLocal && !ctx.sys?.DRY_RUN) {
    const main = ctx.cluster?.MAIN_ID || "main";
    import("../../shared/testenv.mjs")
      .then(({ sweepTestLeftovers }) => sweepTestLeftovers({ dataDir: ctx.dataDir, runIds: interrupted.filter((r) => r.serverId === main).map((r) => r.id), log: (l) => console.log(`[fcc] tests: ${l}`) }))
      .catch((err) => console.warn(`[fcc] tests: cleanup skipped (${err.message})`));
  }
}
