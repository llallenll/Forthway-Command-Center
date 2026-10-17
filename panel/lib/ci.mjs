/**
 * CI — Continuous Integration for website updates.
 *
 * When a website gets an update (a new release, pulled from GitHub or
 * uploaded), a CI run checks it before it can reach production:
 *
 *   plan     on the panel (shared/ci-impact.mjs): what changed against the live
 *            release, everything that imports it, the routes, tests and critical
 *            suites that touches, a static scan of the changed lines, and how to
 *            split the work into checkouts;
 *   checkout on agent servers (task ci.checkout → shared/ci.mjs): each slice runs
 *            in a throwaway folder that is deleted when it finishes — build &
 *            smoke test, types & lint, related tests, suites — in parallel;
 *   report   findings ranked low · medium · high · extreme, a verdict, and the
 *            gate: a website in "required" mode deploys a release only when its
 *            run passed — or when an admin bypasses CI or overrides the result,
 *            both recorded in Activity.
 *
 * Scheduler: checkouts queue here and go to the online CI servers with a free
 * slot (`perServer`, default 2), least loaded first (CPU, memory, checkouts
 * already running). Agent servers do the work; main joins only as a fallback
 * when no agent server is online (or always / never — Settings → CI).
 *
 * Records: collection `ci_runs` (last KEEP_PER_SITE per website); checkout
 * logs in dataDir/ci-logs/<runId>/<checkoutId>.log. Live updates: SSE `ci`.
 */

import fs from "node:fs";
import path from "node:path";

import { httpError } from "./http.mjs";
import { sanitizeEnv } from "./sites.mjs";
import { zipIndex, planRun, capabilities, readinessTips, starterConfig, cleanSuites, parseProbe, SEVERITIES, sevRank, isSeverity, worstOf, globToRegex } from "../../shared/ci-impact.mjs";

const MODES = ["required", "advisory", "off"];
const ACTIVE = new Set(["planning", "queued", "running"]);
const KEEP_PER_SITE = 30;
const NO_RUNNER_MS = 15 * 60_000;
const PUMP_EVERY_MS = 4000;
const EMIT_MS = 400;
const MAX_FINDINGS = 600;

export const DEFAULT_SITE_CI = Object.freeze({
  mode: "required",
  blockOn: "high",
  autoRun: true,
  autoPull: false,
  inheritEnv: true,
  env: {},
  suites: [],
  samples: {},
  ignore: [],
  timeoutMin: 30,
  maxCheckouts: 4,
});
export const DEFAULT_CI = Object.freeze({ runners: "auto", useMain: "fallback", perServer: 2 });

const now = () => new Date().toISOString();
const emptyCounts = () => Object.fromEntries(SEVERITIES.map((s) => [s, 0]));

export function register(router, ctx) {
  const db = ctx.db;
  const live = new Map(); // runId -> { ctrl, base, checkouts: Map(cid -> AbortController), done }
  const queue = []; // { runId, cid, since, exclude: Set, attempts }
  const busyOn = new Map(); // serverId -> Set("runId:cid")
  const emitTimers = new Map();
  const logBufs = new Map(); // file -> [lines]
  const logsDir = () => path.join(ctx.dataDir, "ci-logs");

  // ---------------------------------------------------------- settings

  function cfg() {
    const c = { ...DEFAULT_CI, ...(ctx.config?.ci || {}) };
    if (c.runners !== "auto" && !Array.isArray(c.runners)) c.runners = "auto";
    c.perServer = Math.max(1, Math.min(6, Number(c.perServer) || 2));
    if (!["fallback", "always", "never"].includes(c.useMain)) c.useMain = "fallback";
    return c;
  }

  function siteCfg(site) {
    const c = { ...DEFAULT_SITE_CI, ...(site?.ci || {}) };
    if (!MODES.includes(c.mode)) c.mode = DEFAULT_SITE_CI.mode;
    if (!isSeverity(c.blockOn)) c.blockOn = "high";
    return c;
  }

  function sanitizeSiteCi(input = {}, prev = {}) {
    const out = { ...DEFAULT_SITE_CI, ...prev };
    if ("mode" in input) {
      if (!MODES.includes(input.mode)) throw httpError(400, "mode is required, advisory or off.");
      out.mode = input.mode;
    }
    if ("blockOn" in input) {
      if (!isSeverity(input.blockOn)) throw httpError(400, `blockOn is one of ${SEVERITIES.join(", ")}.`);
      out.blockOn = input.blockOn;
    }
    for (const k of ["autoRun", "autoPull", "inheritEnv"]) if (k in input) out[k] = !!input[k];
    if ("env" in input) out.env = sanitizeEnv(input.env);
    if ("suites" in input) {
      if (!Array.isArray(input.suites) || input.suites.length > 30) throw httpError(400, "suites must be a list (at most 30).");
      const clean = cleanSuites(
        input.suites.map((s) => ({ ...s, probes: Array.isArray(s?.probes) ? s.probes : typeof s?.probes === "string" ? s.probes.split("\n").filter((l) => l.trim()) : [] })),
        "panel",
      ).map(({ source, ...s }) => s);
      const ids = new Set();
      for (const s of clean) {
        if (ids.has(s.id)) throw httpError(400, `Two suites are called "${s.name}".`);
        ids.add(s.id);
      }
      const dropped = input.suites.length - clean.length;
      if (dropped) throw httpError(400, "Every suite needs a name and a command or at least one probe (e.g. GET /api/health 200).");
      out.suites = clean;
    }
    if ("samples" in input) {
      const s = input.samples && typeof input.samples === "object" && !Array.isArray(input.samples) ? input.samples : {};
      const clean = {};
      for (const [route, v] of Object.entries(s).slice(0, 100)) {
        const vals = (Array.isArray(v) ? v : [v]).map((x) => String(x || "").trim()).filter(Boolean);
        if (!route.startsWith("/") || !vals.length || vals.some((x) => !x.startsWith("/"))) throw httpError(400, `Sample for ${route}: routes and paths start with "/".`);
        clean[route.trim()] = vals.length === 1 ? vals[0].slice(0, 300) : vals.slice(0, 3).map((x) => x.slice(0, 300));
      }
      out.samples = clean;
    }
    if ("ignore" in input) {
      out.ignore = (Array.isArray(input.ignore) ? input.ignore : String(input.ignore || "").split("\n")).map((x) => String(x).trim()).filter(Boolean).slice(0, 50);
      for (const g of out.ignore) {
        try {
          globToRegex(g);
        } catch {
          throw httpError(400, `"${g}" is not a usable pattern.`);
        }
      }
    }
    if ("timeoutMin" in input) out.timeoutMin = Math.max(5, Math.min(120, Math.round(Number(input.timeoutMin)) || 30));
    if ("maxCheckouts" in input) out.maxCheckouts = Math.max(1, Math.min(8, Math.round(Number(input.maxCheckouts)) || 4));
    return out;
  }

  // ------------------------------------------------------------ servers

  function allServers() {
    try {
      return ctx.cluster?.listServers?.() || [];
    } catch {
      return [];
    }
  }

  /** Servers that may run checkouts, with whether they can right now. */
  function runnerServers() {
    const g = cfg();
    const all = allServers();
    const main = all.find((s) => s.role === "main") || { id: "main", name: "Main", role: "main", online: true, enabled: true };
    const listed = (id) => g.runners === "auto" || g.runners.includes(id);
    const agents = all.filter((s) => s.role !== "main" && s.enabled !== false && listed(s.id));
    const agentsOnline = agents.filter((s) => s.online).length;
    const out = agents.map((s) => ({ server: s, available: !!s.online, why: s.online ? "" : "offline" }));
    const mainIn = g.useMain === "always" || (Array.isArray(g.runners) && g.runners.includes("main")) || (g.useMain === "fallback" && !agentsOnline);
    if (g.useMain !== "never" && (mainIn || g.useMain === "fallback")) {
      out.push({ server: { ...main, online: true }, available: mainIn, why: mainIn ? (g.useMain === "fallback" && !agentsOnline ? "fallback — no agent server is online" : "") : "standby — used only when no agent server is online", fallback: g.useMain === "fallback" });
    }
    return out;
  }

  function load(s) {
    const m = s.metrics || {};
    const mem = m.memTotal ? (100 * (m.mem || 0)) / m.memTotal : 0;
    return (Number(m.cpu) || 0) + mem * 0.6 + (busyOn.get(s.id)?.size || 0) * 35 + (s.role === "main" ? 25 : 0);
  }

  // --------------------------------------------------------------- runs

  const getRun = (id) => db.get("ci_runs", id);
  function mustRun(id) {
    const r = getRun(id);
    if (!r) throw httpError(404, "CI run not found.");
    return r;
  }
  const runsOf = (siteId) => db.list("ci_runs", siteId ? { siteId } : undefined).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const latestRun = (releaseId) => db.list("ci_runs", { releaseId }).filter((r) => r.status !== "cancelled").sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
  const isActive = (r) => ACTIVE.has(r?.status);

  /** Verdict under the website's current threshold (changing it re-judges old runs). */
  function evaluate(run, site = ctx.sites?.get(run.siteId)) {
    const sc = siteCfg(site);
    const counts = emptyCounts();
    for (const f of run.findings || []) if (counts[f.severity] != null) counts[f.severity]++;
    const worst = worstOf((run.findings || []).map((f) => f.severity));
    const incomplete = (run.checkouts || []).some((c) => c.status === "error" || c.status === "cancelled") || run.status === "error";
    const blocking = isActive(run) || incomplete || run.status === "cancelled" || (!!worst && sevRank(worst) >= sevRank(sc.blockOn));
    const status = isActive(run) ? run.status : run.status === "cancelled" ? "cancelled" : incomplete ? "error" : blocking ? "failed" : (run.findings || []).length ? "warning" : "passed";
    return { counts, worst, incomplete, blocking, status, blockOn: sc.blockOn };
  }

  function lightRun(run) {
    if (!run) return null;
    const site = ctx.sites?.get(run.siteId);
    const ev = evaluate(run, site);
    const cos = run.checkouts || [];
    return {
      id: run.id,
      siteId: run.siteId,
      siteName: site?.name || run.siteName || run.siteId,
      projectId: run.projectId,
      releaseId: run.releaseId,
      baseReleaseId: run.baseReleaseId || null,
      version: run.version || null,
      baseVersion: run.baseVersion || null,
      shortSha: run.shortSha || null,
      message: run.message || "",
      trigger: run.trigger,
      adminName: run.adminName || null,
      deployOnPass: !!run.deployOnPass,
      status: ev.status,
      counts: ev.counts,
      worst: ev.worst,
      blocking: ev.blocking,
      blockOn: ev.blockOn,
      scope: run.plan?.scope || null,
      changedCount: run.plan?.changedCount ?? null,
      checkouts: { total: cos.length, done: cos.filter((c) => !["queued", "running"].includes(c.status)).length, running: cos.filter((c) => c.status === "running").length },
      servers: [...new Set(cos.map((c) => c.serverName).filter(Boolean))],
      deploy: run.deploy || null,
      overrides: run.overrides || [],
      jobId: run.jobId || null,
      error: run.error || null,
      createdAt: run.createdAt,
      startedAt: run.startedAt || null,
      finishedAt: run.finishedAt || null,
      durationMs: run.finishedAt && run.startedAt ? new Date(run.finishedAt) - new Date(run.startedAt) : null,
    };
  }

  function publicCheckout(c) {
    return {
      id: c.id,
      key: c.key,
      name: c.name,
      kind: c.kind,
      status: c.status,
      serverId: c.serverId || null,
      serverName: c.serverName || null,
      hostname: c.hostname || null,
      steps: c.steps || [],
      current: c.status === "running" ? (c.steps || []).find((s) => s.status === "running")?.label || c.currentLabel || (c.steps || []).find((s) => s.status === "pending")?.label || null : null,
      findings: c.findings || 0,
      cleaned: c.cleaned ?? null,
      attempts: c.attempts || 0,
      error: c.error || null,
      queuedAt: c.queuedAt || null,
      startedAt: c.startedAt || null,
      finishedAt: c.finishedAt || null,
      simulated: !!c.simulated,
    };
  }

  function fullRun(run) {
    const site = ctx.sites?.get(run.siteId);
    const rel = db.get("releases", run.releaseId);
    return {
      ...lightRun(run),
      plan: run.plan || null,
      checkouts: (run.checkouts || []).map(publicCheckout),
      findings: run.findings || [],
      release: rel ? { id: rel.id, version: rel.version || null, filename: rel.filename, source: rel.source, github: rel.github || null, createdAt: rel.createdAt, available: fs.existsSync(ctx.sites.releaseFile(rel.id)) } : null,
      site: site ? { id: site.id, name: site.name, currentReleaseId: site.currentReleaseId || null, mode: siteCfg(site).mode, busy: !!ctx.sites.publicSite(site)?.busyJobId } : null,
      isLive: !!site && site.currentReleaseId === run.releaseId,
    };
  }

  function emitRun(run, { now: immediate = false } = {}) {
    const fire = () => {
      emitTimers.delete(run.id);
      const r = getRun(run.id);
      if (!r) return;
      try {
        ctx.events?.broadcast?.("ci", lightRun(r));
      } catch {
        /* never let SSE break a run */
      }
    };
    if (immediate) {
      clearTimeout(emitTimers.get(run.id));
      return fire();
    }
    if (!emitTimers.has(run.id)) emitTimers.set(run.id, setTimeout(fire, EMIT_MS));
  }
  const touch = (run, opts) => (db.update("ci_runs", run.id, {}), emitRun(run, opts));

  function emitSite(siteId) {
    try {
      const s = ctx.sites?.get(siteId);
      if (s) ctx.events?.broadcast?.("site", ctx.sites.publicSite(s));
    } catch {
      /* ignore */
    }
  }

  function audit(admin, action, site, details) {
    try {
      ctx.activity?.(admin, action, { type: "site", id: site.id, name: site.name }, details);
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- logs

  const logFile = (runId, cid) => path.join(logsDir(), runId, `${cid}.log`);
  function appendLog(file, line) {
    let buf = logBufs.get(file);
    if (!buf) {
      buf = [];
      logBufs.set(file, buf);
      setTimeout(() => {
        const lines = logBufs.get(file) || [];
        logBufs.delete(file);
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.appendFileSync(file, lines.join("\n") + "\n");
        } catch {
          /* best effort */
        }
      }, 300).unref?.();
    }
    buf.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  }

  // ------------------------------------------------------------ starting

  function serverName(id) {
    return allServers().find((s) => s.id === id)?.name || id;
  }

  /**
   * Start a CI run for a release. Returns the run record (light). An active run
   * for the same release is reused rather than started twice.
   */
  function startRun(siteId, releaseId, { trigger = "manual", admin = null, deployOnPass = false, base = null } = {}) {
    const site = ctx.sites?.get(siteId);
    if (!site || site.deleting) throw httpError(404, "Website not found.");
    const release = db.get("releases", releaseId);
    if (!release || release.siteId !== site.id) throw httpError(404, "Release not found.");
    if (!fs.existsSync(ctx.sites.releaseFile(release.id))) throw httpError(409, "That release's archive is missing.");
    const existing = db.list("ci_runs", { releaseId }).find(isActive);
    if (existing) {
      if (deployOnPass && !existing.deployOnPass) {
        existing.deployOnPass = true;
        existing.deployBy = admin?.id || existing.deployBy || null;
        touch(existing, { now: true });
      }
      return lightRun(existing);
    }
    const baseId = site.currentReleaseId && site.currentReleaseId !== release.id ? site.currentReleaseId : null;
    const baseRel = baseId ? db.get("releases", baseId) : null;
    const run = db.insert("ci_runs", {
      id: db.newId ? db.newId("ci") : `ci_${Date.now().toString(36)}`,
      siteId: site.id,
      siteName: site.name,
      projectId: site.projectId,
      releaseId: release.id,
      baseReleaseId: baseRel && fs.existsSync(ctx.sites.releaseFile(baseRel.id)) ? baseRel.id : null,
      version: release.version || null,
      baseVersion: baseRel?.version || null,
      commit: release.github?.sha || release.commit || null,
      shortSha: (release.github?.sha || release.commit || "").slice(0, 7) || null,
      message: release.github?.message || release.filename || "",
      trigger,
      adminId: admin?.id || null,
      adminName: admin?.name || admin?.github?.login || null,
      deployOnPass: !!deployOnPass,
      deployBy: deployOnPass ? admin?.id || null : null,
      status: "planning",
      plan: null,
      checkouts: [],
      findings: [],
      overrides: [],
      startedAt: now(),
      finishedAt: null,
    });
    live.set(run.id, { ctrl: new AbortController(), base: base || panelBase(), checkouts: new Map(), done: null });
    const label = release.version ? `v${release.version}` : run.shortSha || release.id;
    const job = ctx.jobs.start(
      { type: "ci.run", title: `CI ${site.name} ${label}${deployOnPass ? " → deploy" : ""}`, projectId: site.projectId, siteId: site.id, adminId: admin?.id || null, lock: false },
      ({ log, signal }) => executeRun(run.id, { log, signal }),
    );
    run.jobId = job?.id || null;
    touch(run, { now: true });
    emitSite(site.id);
    audit(admin, "ci.run", site, { runId: run.id, releaseId: release.id, version: release.version || null, trigger });
    prune(site.id);
    return lightRun(run);
  }

  function panelBase() {
    try {
      return String(ctx.panelUrl?.() || `http://127.0.0.1:${ctx.config?.port || 4000}`).replace(/\/+$/, "");
    } catch {
      return `http://127.0.0.1:${ctx.config?.port || 4000}`;
    }
  }

  async function executeRun(runId, { log, signal }) {
    const run = getRun(runId);
    const L = live.get(runId);
    const onAbort = () => cancelRun(runId, null, { fromJob: true });
    signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      const site = ctx.sites.get(run.siteId);
      const release = db.get("releases", run.releaseId);
      const sc = siteCfg(site);
      log(`CI for ${site.name}: ${release.version ? `v${release.version}` : release.id}${run.shortSha ? ` (${run.shortSha})` : ""}${run.baseReleaseId ? ` against the live ${run.baseVersion ? `v${run.baseVersion}` : run.baseReleaseId}` : " — nothing live to compare with"}.`);

      // ---- plan
      const next = zipIndex(fs.readFileSync(ctx.sites.releaseFile(release.id)));
      const prev = run.baseReleaseId ? zipIndex(fs.readFileSync(ctx.sites.releaseFile(run.baseReleaseId))) : null;
      const spec = await ctx.sites.specForAsync(site).catch(() => null);
      const b = spec?.settings?.build || {};
      const runners = runnerServers().filter((r) => r.available).length || 1;
      const plan = planRun({
        next,
        prev,
        site: { type: site.type },
        ci: sc,
        runners,
        buildCommands: {
          install: b.install || undefined,
          prepare: b.prepare || "",
          autoPrepare: spec?.settings?.autoPrepare,
          build: typeof b.build === "string" ? b.build : undefined,
          start: spec?.settings?.restart?.start || site.settings?.start || undefined,
          healthPath: site.healthPath || null,
          root: site.settings?.publicDir || "",
        },
      });
      if (signal?.aborted || run.status === "cancelled") return { cancelled: true };
      const { findings, checkouts, ...planRest } = plan;
      run.plan = planRest;
      run.findings = findings.map((f, i) => ({ id: `scan-${i + 1}`, checkoutId: null, serverName: "Panel", ...f }));
      run.checkouts = checkouts.map((c, i) => ({
        id: `${c.key}`,
        key: c.key,
        name: c.name,
        kind: c.kind,
        plan: c,
        status: "queued",
        steps: [{ id: "fetch", label: "Fetch release", kind: "fetch", status: "pending" }, ...c.steps.map((s) => ({ id: s.id, label: s.label, kind: s.kind, status: "pending" }))],
        attempts: 0,
        queuedAt: now(),
        order: i,
      }));
      log(`What changed: ${plan.changedCount} file${plan.changedCount === 1 ? "" : "s"}${plan.affectedCount ? `, reaching ${plan.affectedCount} more through imports` : ""} (${plan.scope} check).`);
      for (const c of plan.changed.slice(0, 15)) log(`  ${c.kind === "added" ? "+" : c.kind === "removed" ? "−" : "~"} ${c.path}`);
      if (plan.changed.length > 15) log(`  … and ${plan.changed.length - 15} more`);
      if (plan.routes.length) log(`Routes in scope: ${plan.routes.map((r) => r.route).slice(0, 12).join(", ")}${plan.routes.length > 12 ? "…" : ""}`);
      if (plan.tests.length) log(`Related tests: ${plan.tests.length}`);
      for (const s of plan.suites) log(`Suite "${s.name}" (${s.severity}): ${s.reason || "not touched — skipped"}`);
      for (const n of plan.notes) log(`note: ${n}`);
      log(`Static scan: ${findings.length} finding${findings.length === 1 ? "" : "s"}.`);
      log(`${run.checkouts.length} checkout${run.checkouts.length === 1 ? "" : "s"}: ${run.checkouts.map((c) => c.name).join(" · ") || "none needed"}.`);
      run.status = run.checkouts.length ? "queued" : "running";
      touch(run, { now: true });

      // ---- checkouts
      if (run.checkouts.length) {
        const done = new Promise((resolve) => (L.done = resolve));
        for (const c of run.checkouts) queue.push({ runId, cid: c.id, since: Date.now(), exclude: new Set(), attempts: 0, log, timeoutMs: sc.timeoutMin * 60_000 });
        pump();
        await done;
      }

      // ---- verdict
      return finalize(runId, log);
    } catch (err) {
      const r = getRun(runId);
      if (r && isActive(r)) {
        r.status = signal?.aborted ? "cancelled" : "error";
        r.error = err.message;
        r.finishedAt = now();
        touch(r, { now: true });
        emitSite(r.siteId);
      }
      throw err;
    } finally {
      signal?.removeEventListener?.("abort", onAbort);
      live.delete(runId);
    }
  }

  function finalize(runId, log) {
    const run = getRun(runId);
    if (run.status === "cancelled") return { cancelled: true };
    // The same error seen by two checkouts (tsc in "Types & lint" and in the build) is one finding.
    const seen = new Map();
    for (const f of run.findings || []) {
      const key = `${f.title}|${f.file || ""}|${f.line || ""}`;
      const prev = seen.get(key);
      if (!prev) seen.set(key, { ...f, alsoIn: [] });
      else {
        if (sevRank(f.severity) > sevRank(prev.severity)) prev.severity = f.severity;
        if (f.check !== prev.check && !prev.alsoIn.includes(f.check)) prev.alsoIn.push(f.check);
      }
    }
    run.findings = [...seen.values()]
      .sort((a, b) => sevRank(b.severity) - sevRank(a.severity))
      .slice(0, MAX_FINDINGS);
    run.status = "done";
    run.finishedAt = now();
    const ev = evaluate(run);
    run.status = ev.status;
    touch(run, { now: true });
    emitSite(run.siteId);
    const c = ev.counts;
    const parts = SEVERITIES.slice().reverse().filter((s) => c[s]).map((s) => `${c[s]} ${s}`);
    log(`Verdict: ${ev.status.toUpperCase()}${parts.length ? ` — ${parts.join(", ")}` : " — no findings"}. Blocks deploys from ${ev.blockOn} up.`);
    const cleanedAll = run.checkouts.every((x) => x.cleaned !== false);
    log(cleanedAll ? "Every checkout's files were deleted from its server." : "!! Some checkout folders could not be deleted (they are swept on that server's next checkout).");

    if (run.deployOnPass) {
      if (!ev.blocking) autoDeploy(run, log);
      else log("Not deploying: CI blocked this release. Open the report to override if you are sure.");
    }
    if (ev.blocking) {
      const site = ctx.sites.get(run.siteId);
      const err = new Error(ev.incomplete ? "CI could not finish every checkout." : `CI found ${parts.join(", ")} — ${siteCfg(site).mode === "required" ? "deploy blocked" : "advisory only"}.`);
      err.result = { runId, status: ev.status };
      throw err;
    }
    return { runId, status: ev.status, counts: c };
  }

  function autoDeploy(run, log) {
    const admin = (run.deployBy && db.get("admins", run.deployBy)) || (run.adminId && db.get("admins", run.adminId)) || null;
    try {
      const job = ctx.sites.startDeploy(run.siteId, run.releaseId, { admin, base: live.get(run.id)?.base || panelBase() });
      run.deploy = { jobId: job?.id || null, at: now(), mode: "auto", by: admin?.name || null };
      log(`CI passed — deploying (job ${job?.id}).`);
    } catch (err) {
      run.deploy = { error: err.message, at: now(), mode: "auto" };
      log(`CI passed, but the deploy could not start: ${err.message} Deploy it from the report.`);
    }
    touch(run, { now: true });
  }

  // ------------------------------------------------------------ scheduler

  let pumping = false;
  function pump() {
    if (pumping) return;
    pumping = true;
    try {
      const g = cfg();
      const avail = runnerServers().filter((r) => r.available).map((r) => r.server);
      for (let i = 0; i < queue.length; i++) {
        const q = queue[i];
        const run = getRun(q.runId);
        const co = run?.checkouts?.find((c) => c.id === q.cid);
        if (!run || !co || run.status === "cancelled" || co.status !== "queued") {
          queue.splice(i--, 1);
          continue;
        }
        const cands = avail.filter((s) => !q.exclude.has(s.id) && (busyOn.get(s.id)?.size || 0) < g.perServer).sort((a, b) => load(a) - load(b));
        if (!cands.length) {
          if (Date.now() - q.since > NO_RUNNER_MS) {
            queue.splice(i--, 1);
            settleCheckout(run, co, { status: "error", error: "No CI server was free or online for 15 minutes." });
          }
          continue;
        }
        queue.splice(i--, 1);
        dispatch(q, run, co, cands[0]);
      }
    } finally {
      pumping = false;
    }
  }

  async function dispatch(q, run, co, server) {
    const key = `${run.id}:${co.id}`;
    if (!busyOn.has(server.id)) busyOn.set(server.id, new Set());
    busyOn.get(server.id).add(key);
    const L = live.get(run.id);
    const ctrl = new AbortController();
    L?.checkouts.set(co.id, ctrl);
    co.status = "running";
    co.serverId = server.id;
    co.serverName = server.name || server.id;
    co.attempts = (co.attempts || 0) + 1;
    co.startedAt = now();
    co.error = null;
    if (run.status === "queued") run.status = "running";
    touch(run);
    const file = logFile(run.id, co.id);
    const tag = `[${co.serverName} · ${co.name}]`;
    appendLog(file, `── ${co.name} on ${co.serverName} (attempt ${co.attempts}) ──`);
    q.log?.(`${tag} started`);
    const runLog = (line) => {
      for (const l of String(line ?? "").split("\n")) {
        appendLog(file, l);
        if (/^(✓|✗|!|–) |Checkout files deleted|Could not delete/.test(l)) q.log?.(`${tag} ${l}`);
      }
    };
    try {
      const site = ctx.sites.get(run.siteId);
      const release = db.get("releases", run.releaseId);
      const sc = siteCfg(site);
      let env = {};
      if (sc.inheritEnv) env = { ...((await ctx.sites.specForAsync(site, server.id).catch(() => null))?.env || {}) };
      const payload = {
        runId: run.id,
        checkout: { id: co.id, key: co.key, name: co.name, kind: co.kind, steps: co.plan.steps },
        release: ctx.sites.releasePayload(release, server.id, L?.base || panelBase()),
        env: { ...env, ...sc.env },
        ciEnv: { ...sc.env },
        timeoutMs: q.timeoutMs || sc.timeoutMin * 60_000,
      };
      // Flat progress from shared/ci.mjs: states/durations are comma-separated, one per step (fetch first).
      const onProgress = (p) => {
        if (!p || typeof p.states !== "string") return;
        const states = p.states.split(",");
        const durs = String(p.durations || "").split(",");
        co.steps = (co.steps || []).map((s, i) => {
          const d = Number(durs[i]);
          return { ...s, status: states[i] || s.status, durationMs: durs[i] !== "" && d >= 0 ? d : s.durationMs ?? null, startedAt: d < 0 ? new Date(-d).toISOString() : s.startedAt || null };
        });
        co.liveFindings = Number(p.findings) || 0;
        co.currentLabel = String(p.current || "") || null;
        touch(run);
      };
      const result = await ctx.cluster.runTask(server.id, "ci.checkout", payload, { log: runLog, signal: ctrl.signal, onProgress, timeoutMs: payload.timeoutMs + 10 * 60_000 });
      settleCheckout(run, co, { status: "done", result });
    } catch (err) {
      if (err.aborted || ctrl.signal.aborted || run.status === "cancelled") {
        settleCheckout(run, co, { status: "cancelled", error: "Cancelled.", cleaned: err.cleaned });
      } else if (/offline|never checked in|does not know the task|Unknown task|not found|ECONN|socket hang up/i.test(err.message) && co.attempts < 3) {
        runLog(`!! ${err.message} — trying another server.`);
        q.exclude.add(server.id);
        co.status = "queued";
        co.serverId = null;
        co.serverName = null;
        queue.push({ ...q, since: Date.now() });
        touch(run);
      } else {
        runLog(`✗ ${err.message}`);
        settleCheckout(run, co, { status: "error", error: err.message, cleaned: err.cleaned });
      }
    } finally {
      busyOn.get(server.id)?.delete(key);
      L?.checkouts.delete(co.id);
      setImmediate(pump);
    }
  }

  function settleCheckout(run, co, { status, result = null, error = null, cleaned }) {
    if (["done", "error", "cancelled"].includes(co.status) || ["passed", "failed", "warning"].includes(co.status)) return;
    co.finishedAt = now();
    co.error = error;
    if (result) {
      co.steps = result.steps || co.steps;
      co.hostname = result.hostname || null;
      co.cleaned = result.cleaned !== false;
      co.simulated = !!result.simulated;
      const fs_ = (result.findings || []).map((f, i) => ({ id: `${co.id}-${co.attempts}-${i + 1}`, checkoutId: co.id, serverName: co.serverName, ...f, severity: isSeverity(f.severity) ? f.severity : "high" }));
      co.findings = fs_.length;
      run.findings = [...(run.findings || []), ...fs_];
      const failedStep = (co.steps || []).some((s) => s.status === "failed");
      co.status = failedStep ? "failed" : fs_.length ? "warning" : "passed";
    } else {
      co.status = status === "cancelled" ? "cancelled" : "error";
      if (cleaned !== undefined) co.cleaned = cleaned !== false;
      if (status === "error") {
        run.findings = [...(run.findings || []), { id: `${co.id}-infra`, checkoutId: co.id, serverName: co.serverName || null, severity: "high", check: "ci", title: `Checkout "${co.name}" did not finish`, detail: error || "", file: null, line: null }];
        co.findings = 1;
      }
      for (const s of co.steps || []) if (s.status === "running" || s.status === "pending") s.status = status === "cancelled" ? "cancelled" : "skipped";
    }
    touch(run);
    const L = live.get(run.id);
    if (run.checkouts.every((c) => !["queued", "running"].includes(c.status))) L?.done?.();
  }

  function cancelRun(runId, admin, { fromJob = false } = {}) {
    const run = getRun(runId);
    if (!run || !isActive(run)) return run;
    run.status = "cancelled";
    run.finishedAt = now();
    run.cancelledBy = admin?.name || null;
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].runId === runId) queue.splice(i, 1);
    const L = live.get(runId);
    for (const c of run.checkouts || []) {
      if (c.status === "queued") {
        c.status = "cancelled";
        for (const s of c.steps || []) if (s.status === "pending") s.status = "cancelled";
      }
    }
    for (const ctrl of L?.checkouts.values() || []) ctrl.abort();
    L?.done?.();
    if (!fromJob && run.jobId) ctx.jobs.cancel?.(run.jobId);
    touch(run, { now: true });
    emitSite(run.siteId);
    return run;
  }

  function prune(siteId) {
    const list = runsOf(siteId);
    for (const r of list.slice(KEEP_PER_SITE)) {
      if (isActive(r)) continue;
      db.remove("ci_runs", r.id);
      fs.rmSync(path.join(logsDir(), r.id), { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------- gate

  /** Where a release stands with CI, for the deploy buttons and the gate. */
  function gate(site, releaseId) {
    const sc = siteCfg(site);
    const run = releaseId ? latestRun(releaseId) : null;
    const ev = run ? evaluate(run, site) : null;
    const rel = releaseId ? db.get("releases", releaseId) : null;
    return {
      mode: sc.mode,
      enforced: sc.mode === "required",
      blockOn: sc.blockOn,
      status: run ? ev.status : "none",
      blocking: run ? ev.blocking : sc.mode === "required",
      worst: ev?.worst || null,
      counts: ev?.counts || emptyCounts(),
      run: lightRun(run),
      bypassed: rel?.ciBypass || null,
    };
  }

  /**
   * Called by every deploy path before a release goes out. Returns how the
   * deploy is allowed ({ mode: passed|advisory|off|bypass|override, runId }),
   * or throws 409 with { code, ci } for the UI to offer the choices.
   *   body.ci = "bypass"   — deploy without CI (no run, or one still running / that could not finish)
   *   body.ci = "override" — deploy although CI blocked it; extreme findings also need body.confirm = the website's name
   */
  function authorizeDeploy(site, release, body = {}, admin = null) {
    const g = gate(site, release.id);
    const choice = body?.ci;
    if (!g.enforced) return { mode: g.mode === "off" ? "off" : "advisory", runId: g.run?.id || null, gate: g };
    if (!g.blocking) return { mode: "passed", runId: g.run.id, gate: g };
    const failed = g.status === "failed";
    if (!failed && (choice === "bypass" || choice === "override")) {
      record(site, release, g, "bypass", admin);
      return { mode: "bypass", runId: g.run?.id || null, gate: g };
    }
    if (failed && choice === "override") {
      if (g.worst === "extreme" && String(body.confirm || "").trim() !== site.name) {
        throw httpError(409, `CI found extreme issues. Type the website's name (${site.name}) to deploy anyway.`, { code: "ci_confirm", ci: g });
      }
      record(site, release, g, "override", admin);
      return { mode: "override", runId: g.run.id, gate: g };
    }
    const code = g.status === "none" ? "ci_required" : isActive(g.run) ? "ci_running" : failed ? "ci_blocked" : "ci_incomplete";
    const msg = {
      ci_required: "This release has not been through CI yet. Run CI first, or bypass it.",
      ci_running: "CI is still checking this release.",
      ci_blocked: `CI blocked this release (${SEVERITIES.slice().reverse().filter((s) => g.counts[s]).map((s) => `${g.counts[s]} ${s}`).join(", ")}).`,
      ci_incomplete: "CI could not finish checking this release. Run it again, or bypass it.",
    }[code];
    throw httpError(409, msg, { code, ci: g });
  }

  function record(site, release, g, mode, admin) {
    const entry = { mode, at: now(), by: admin?.name || admin?.github?.login || null, adminId: admin?.id || null, status: g.status, worst: g.worst, counts: g.counts };
    if (g.run) {
      const run = getRun(g.run.id);
      if (run) {
        run.overrides = [...(run.overrides || []), entry];
        touch(run, { now: true });
      }
    }
    if (mode === "bypass") db.update("releases", release.id, { ciBypass: entry });
    audit(admin, mode === "bypass" ? "ci.bypass" : "ci.override", site, { releaseId: release.id, version: release.version || null, runId: g.run?.id || null, status: g.status, worst: g.worst });
  }

  /** Small CI summary for a website card / header. */
  function siteSummary(site) {
    const sc = siteCfg(site);
    const latest = runsOf(site.id)[0] || null;
    const cur = site.currentReleaseId ? latestRun(site.currentReleaseId) : null;
    return { mode: sc.mode, blockOn: sc.blockOn, autoRun: sc.autoRun, latest: lightRun(latest), live: cur ? { status: evaluate(cur, site).status, runId: cur.id } : null };
  }

  function releaseSummary(releaseId) {
    const run = latestRun(releaseId);
    const rel = db.get("releases", releaseId);
    if (!run && !rel?.ciBypass) return null;
    const ev = run ? evaluate(run) : null;
    return { runId: run?.id || null, status: ev?.status || "none", counts: ev?.counts || null, worst: ev?.worst || null, blocking: ev ? ev.blocking : true, bypass: rel?.ciBypass || null, overrides: run?.overrides || [] };
  }

  /** Should creating this release start CI on its own? */
  const wantsAutoRun = (site) => siteCfg(site).mode !== "off" && siteCfg(site).autoRun;
  const requiresCi = (site) => siteCfg(site).mode === "required";

  ctx.ci = { gate, authorizeDeploy, startRun, siteSummary, releaseSummary, wantsAutoRun, requiresCi, cancelRun, siteSettings: siteCfg, lightRun };

  // ---------------------------------------------------------------- routes

  router.get("/api/ci/overview", async () => {
    const g = cfg();
    const runs = runsOf();
    const today = new Date(Date.now() - 24 * 3600_000).toISOString();
    const week = runs.filter((r) => String(r.createdAt) > new Date(Date.now() - 7 * 86400_000).toISOString() && !isActive(r) && r.status !== "cancelled");
    const passed = week.filter((r) => ["passed", "warning"].includes(evaluate(r).status)).length;
    const ref = (key) => {
      const [runId, cid] = key.split(":");
      const run = getRun(runId);
      const c = run?.checkouts?.find((x) => x.id === cid);
      if (!run || !c) return null;
      const steps = c.steps || [];
      return { runId, checkoutId: cid, siteId: run.siteId, siteName: ctx.sites.get(run.siteId)?.name || run.siteName, version: run.version, shortSha: run.shortSha, name: c.name, kind: c.kind, status: c.status, current: steps.find((s) => s.status === "running")?.label || c.currentLabel || steps.find((s) => s.status === "pending")?.label || null, done: steps.filter((s) => !["pending", "running"].includes(s.status)).length, total: steps.length, startedAt: c.startedAt, findings: c.liveFindings || 0 };
    };
    const runners = runnerServers().map(({ server: s, available, why, fallback }) => ({
      id: s.id,
      name: s.name || s.id,
      role: s.role,
      online: !!s.online,
      available,
      why,
      fallback: !!fallback,
      metrics: s.metrics || null,
      info: s.info ? { cpus: s.info.cpus, memTotal: s.info.memTotal, os: s.info.os } : null,
      slots: g.perServer,
      active: [...(busyOn.get(s.id) || [])].map(ref).filter(Boolean),
    }));
    const queued = queue.map((q) => {
      const run = getRun(q.runId);
      const c = run?.checkouts?.find((x) => x.id === q.cid);
      return run && c ? { runId: run.id, checkoutId: c.id, siteId: run.siteId, siteName: ctx.sites.get(run.siteId)?.name || run.siteName, name: c.name, kind: c.kind, since: new Date(q.since).toISOString() } : null;
    }).filter(Boolean);
    return {
      settings: g,
      runners,
      queue: queued,
      active: runs.filter(isActive).map(lightRun),
      recent: runs.slice(0, 30).map(lightRun),
      stats: {
        runs24h: runs.filter((r) => String(r.createdAt) > today).length,
        passRate7d: week.length ? Math.round((100 * passed) / week.length) : null,
        week: week.length,
        activeCheckouts: runners.reduce((n, r) => n + r.active.length, 0),
        queued: queued.length,
        runnersOnline: runners.filter((r) => r.available).length,
        blockedDeploys: runs.reduce((n, r) => n + (r.overrides || []).filter((o) => o.mode === "override").length, 0),
      },
    };
  });

  router.get("/api/ci/runs", async (req, res, { query }) => {
    const limit = Math.max(1, Math.min(200, Number(query.limit) || 50));
    return { items: runsOf(query.siteId || null).slice(0, limit).map(lightRun) };
  });

  router.get("/api/ci/runs/:id", async (req, res, { params }) => fullRun(mustRun(params.id)));

  router.post("/api/ci/runs", async (req, res, { body, admin }) => {
    const site = ctx.sites?.get(body.siteId);
    if (!site) throw httpError(404, "Website not found.");
    let releaseId = body.releaseId;
    if (!releaseId) {
      const pub = ctx.sites.publicSite(site);
      releaseId = pub?.update?.releaseId || db.list("releases", { siteId: site.id }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0]?.id;
    }
    if (!releaseId) throw httpError(409, "This website has no releases yet. Pull from GitHub or upload a zip first.");
    return startRun(site.id, releaseId, { trigger: "manual", admin, deployOnPass: !!body.deployOnPass, base: ctx.panelUrl?.(req) || null });
  });

  router.patch("/api/ci/runs/:id", async (req, res, { params, body, admin }) => {
    const run = mustRun(params.id);
    if ("deployOnPass" in body) {
      if (!isActive(run)) throw httpError(409, "This run has finished. Deploy from the report instead.");
      run.deployOnPass = !!body.deployOnPass;
      run.deployBy = run.deployOnPass ? admin?.id || null : null;
      touch(run, { now: true });
    }
    return lightRun(run);
  });

  router.post("/api/ci/runs/:id/cancel", async (req, res, { params, admin }) => {
    const run = mustRun(params.id);
    if (!isActive(run)) throw httpError(409, "This run is not running.");
    cancelRun(run.id, admin);
    const site = ctx.sites.get(run.siteId);
    if (site) audit(admin, "ci.cancel", site, { runId: run.id });
    return lightRun(getRun(run.id));
  });

  router.post("/api/ci/runs/:id/rerun", async (req, res, { params, admin, body }) => {
    const run = mustRun(params.id);
    if (isActive(run)) throw httpError(409, "This run is still going.");
    return startRun(run.siteId, run.releaseId, { trigger: "rerun", admin, deployOnPass: !!body?.deployOnPass, base: ctx.panelUrl?.(req) || null });
  });

  router.post("/api/ci/runs/:id/deploy", async (req, res, { params, body, admin }) => {
    const run = mustRun(params.id);
    const site = ctx.sites.get(run.siteId);
    const release = db.get("releases", run.releaseId);
    if (!site || !release) throw httpError(404, "The website or release no longer exists.");
    const ci = body?.override ? { ci: "override", confirm: body.confirm } : body?.bypass ? { ci: "bypass" } : {};
    return ctx.sites.startDeploy(site.id, release.id, { admin, base: ctx.panelUrl?.(req) || null, body: ci });
  });

  router.get("/api/ci/runs/:id/checkouts/:cid/log", async (req, res, { params }) => {
    const run = mustRun(params.id);
    if (!/^[\w-]{1,40}$/.test(params.cid) || !run.checkouts.some((c) => c.id === params.cid)) throw httpError(404, "Checkout not found.");
    let text = "";
    try {
      text = fs.readFileSync(logFile(run.id, params.cid), "utf8");
    } catch {
      text = "(no log yet)\n";
    }
    for (const l of logBufs.get(logFile(run.id, params.cid)) || []) text += l + "\n";
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(text);
  });

  router.get("/api/ci/settings", async () => ({ ...cfg(), servers: runnerServers().map(({ server: s, available, why }) => ({ id: s.id, name: s.name, role: s.role, online: !!s.online, available, why })) }));

  router.put("/api/ci/settings", async (req, res, { body, admin }) => {
    const next = { ...cfg() };
    if ("runners" in body) {
      if (body.runners === "auto") next.runners = "auto";
      else if (Array.isArray(body.runners)) {
        const known = new Set(allServers().map((s) => s.id));
        next.runners = [...new Set(body.runners.map(String))].filter((id) => known.has(id));
      } else throw httpError(400, 'runners is "auto" or a list of server ids.');
    }
    if ("useMain" in body) {
      if (!["fallback", "always", "never"].includes(body.useMain)) throw httpError(400, "useMain is fallback, always or never.");
      next.useMain = body.useMain;
    }
    if ("perServer" in body) next.perServer = Math.max(1, Math.min(6, Math.round(Number(body.perServer)) || 2));
    ctx.config.ci = next;
    ctx.saveConfig?.();
    try {
      ctx.activity?.(admin, "ci.settings", { type: "settings", id: "ci", name: "CI" }, next);
    } catch {
      /* ignore */
    }
    setImmediate(pump);
    return cfg();
  });

  const readinessCache = new Map(); // releaseId -> caps
  function readiness(site) {
    const rel = db.list("releases", { siteId: site.id }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (!rel || !fs.existsSync(ctx.sites.releaseFile(rel.id))) return { releaseId: null, caps: null, tips: [{ level: "info", text: "Pull from GitHub or upload a release and CI will show what this codebase brings for testing." }] };
    let caps = readinessCache.get(rel.id);
    if (!caps) {
      try {
        caps = capabilities(zipIndex(fs.readFileSync(ctx.sites.releaseFile(rel.id))));
      } catch (err) {
        return { releaseId: rel.id, caps: null, tips: [{ level: "warn", text: `Could not read the release: ${err.message}` }] };
      }
      readinessCache.set(rel.id, caps);
      if (readinessCache.size > 50) readinessCache.delete(readinessCache.keys().next().value);
    }
    return { releaseId: rel.id, version: rel.version || null, caps: { ...caps, fccCi: caps.fccCi ? (caps.fccCi.error ? { error: caps.fccCi.error } : { present: true, suites: Array.isArray(caps.fccCi.suites) ? caps.fccCi.suites.length : 0 }) : null }, tips: readinessTips(caps, site.type), repoSuites: caps.fccCi && !caps.fccCi.error ? cleanSuites(caps.fccCi.suites, "repo") : [] };
  }

  router.get("/api/sites/:id/ci", async (req, res, { params }) => {
    const site = ctx.sites?.get(params.id);
    if (!site) throw httpError(404, "Website not found.");
    const pub = ctx.sites.publicSite(site);
    const target = pub?.update?.releaseId || null;
    return {
      settings: siteCfg(site),
      readiness: readiness(site),
      gate: target ? gate(site, target) : null,
      live: site.currentReleaseId ? gate(site, site.currentReleaseId) : null,
      runners: runnerServers().map(({ server: s, available, why }) => ({ id: s.id, name: s.name, role: s.role, available, why })),
      runs: runsOf(site.id).slice(0, 15).map(lightRun),
    };
  });

  router.put("/api/sites/:id/ci", async (req, res, { params, body, admin }) => {
    const site = ctx.sites?.get(params.id);
    if (!site) throw httpError(404, "Website not found.");
    const before = siteCfg(site);
    const next = sanitizeSiteCi(body || {}, site.ci || {});
    db.update("sites", site.id, { ci: next });
    emitSite(site.id);
    const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
    audit(admin, "ci.settings", site, { changed, mode: next.mode, blockOn: next.blockOn });
    return siteCfg(db.get("sites", site.id));
  });

  router.get("/api/sites/:id/ci/starter", async (req, res, { params }) => {
    const site = ctx.sites?.get(params.id);
    if (!site) throw httpError(404, "Website not found.");
    const r = readiness(site);
    const body = JSON.stringify(starterConfig(r.caps || {}, siteCfg(site).suites), null, 2) + "\n";
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": 'attachment; filename="fcc-ci.json"', "Cache-Control": "no-store" });
    res.end(body);
  });

  router.post("/api/ci/probe-parse", async (req, res, { body }) => ({ probe: parseProbe(body?.line) }));

  // Settle anything a restart interrupted, and keep the scheduler ticking.
  ctx._ciPump = pump;
  ctx._ciRecover = () => {
    for (const r of db.list("ci_runs").filter(isActive)) {
      r.status = "error";
      r.error = "The panel restarted while this run was in progress. Run it again.";
      r.finishedAt = now();
      for (const c of r.checkouts || []) {
        if (c.status === "queued" || c.status === "running") {
          c.status = "error";
          c.error = "Interrupted by a panel restart.";
          for (const s of c.steps || []) if (s.status === "pending" || s.status === "running") s.status = "skipped";
        }
      }
      db.update("ci_runs", r.id, {});
    }
  };
  ctx.cluster?.on?.("servers-changed", () => setImmediate(pump));
}

export async function start(ctx) {
  ctx._ciRecover?.();
  const t = setInterval(() => ctx._ciPump?.(), PUMP_EVERY_MS);
  t.unref?.();
}
