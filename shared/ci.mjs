/**
 * Continuous Integration — one checkout (task `ci.checkout`).
 *
 * A checkout is a slice of a CI run that one server carries out: the panel
 * plans the run (shared/ci-impact.mjs) and hands each slice to an agent server
 * (or main, as a fallback) through the normal task queue. Here, on that server:
 *
 *   1. download the release the same way a deploy does (short-lived download
 *      token, sha256 checked) and unpack it into <dataDir>/ci/<run>-<checkout>/,
 *      a folder of its own that has nothing to do with any live website;
 *   2. run the planned steps — install, build, smoke test the affected routes on
 *      a throwaway port, type check, lint, related tests, critical suites — and
 *      turn their output into findings (severity low | medium | high | extreme);
 *   3. stop anything it started and DELETE THE FOLDER, whatever happened — the
 *      result says whether the delete worked (`cleaned`).
 *
 * The live app is never touched: a checkout has its own folder, its own port
 * and its own process group. Leftovers of a checkout interrupted by a crash are
 * swept by the next checkout on that server (folders older than STALE_MS).
 *
 * FCC_DRY_RUN=1 simulates the steps (logs what would run) unless FCC_CI_REAL=1,
 * which runs them for real — useful on a Mac against a real repository.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

import { extractZip } from "./zip.mjs";
import { ensureDir, rmrf, exists } from "./fsx.mjs";
import * as sys from "../panel/lib/sys.mjs";

export const CI_VERSION = "1.0.0";
const STALE_MS = 3 * 60 * 60_000;
const MAX_FINDINGS = 300;
const STEP_TIMEOUTS = { install: 15, build: 25, command: 15, typecheck: 10, lint: 10, tests: 20, suite: 15, smoke: 10, "php-lint": 5, "static-output": 1 };
const MINUTE = 60_000;
const SIMULATE = () => sys.DRY_RUN && process.env.FCC_CI_REAL !== "1";

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

function abortError() {
  const e = new Error("Cancelled.");
  e.aborted = true;
  return e;
}

/** Remove checkout folders left behind by a crash or a restart. */
export function sweepStale(root, maxAgeMs = STALE_MS) {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(root)) {
      const p = path.join(root, name);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) (rmrf(p), removed++);
      } catch {
        /* gone already */
      }
    }
  } catch {
    /* no ci dir yet */
  }
  return removed;
}

// ------------------------------------------------------------------ entry

export async function runCheckout(payload = {}, o = {}) {
  const log = o.log || (() => {});
  const signal = o.signal || null;
  const started = Date.now();
  const co = payload.checkout;
  if (!co || !Array.isArray(co.steps)) throw new Error("ci.checkout: the payload has no checkout plan.");
  const runId = String(payload.runId || "").replace(/[^\w-]/g, "");
  const coId = String(co.id || co.key || "co").replace(/[^\w-]/g, "");
  if (!runId) throw new Error("ci.checkout: missing runId.");
  const root = ensureDir(path.join(o.dataDir || "/var/lib/fcc", "ci"));
  const swept = sweepStale(root);
  if (swept) log(`Removed ${swept} stale checkout folder${swept === 1 ? "" : "s"} from an earlier crash.`);
  const work = path.join(root, `${runId}-${coId}`);
  const deadline = started + (Number(payload.timeoutMs) || 30 * MINUTE);

  const steps = [{ id: "fetch", label: "Fetch release", kind: "fetch" }, ...co.steps].map((s) => ({
    id: s.id,
    label: s.label || s.id,
    kind: s.kind,
    status: "pending",
    startedAt: null,
    durationMs: null,
    summary: "",
  }));
  const findings = [];
  const add = (f) => {
    if (findings.length >= MAX_FINDINGS) return;
    // Paths inside the throwaway folder mean nothing once it is gone: show them relative to the app.
    const clean = (t) => String(t || "").split(`${work}/`).join("").split(`file://${work}/`).join("");
    findings.push({ severity: f.severity || "high", check: f.check, step: f.step, title: clean(f.title).slice(0, 300), detail: clean(f.detail).slice(0, 4000), file: f.file ? rel(work, f.file) : null, line: f.line ?? null });
  };
  // Progress travels flat (agents → panel accepts primitives only): one entry per step, comma-separated.
  const report = (force = false) => {
    try {
      o.progress?.({
        checkoutId: String(co.id),
        states: steps.map((s) => s.status).join(","),
        durations: steps.map((s) => (s.durationMs ?? (s.status === "running" && s.startedAt ? -(s.startedAt) : ""))).join(","),
        current: steps.find((s) => s.status === "running")?.label?.slice(0, 120) || "",
        findings: findings.length,
        at: Date.now(),
        ...(force ? { force: true } : {}),
      });
    } catch {
      /* progress is best effort */
    }
  };
  const ctx = {
    log,
    signal,
    work,
    env: buildEnv(payload),
    ciEnv: payload.ciEnv || {},
    deadline,
    add,
    procs: new Set(),
  };

  log(`Checkout "${co.name}" on ${os.hostname()} — ${co.steps.length} step${co.steps.length === 1 ? "" : "s"}, in ${work}`);
  let cleaned = false;
  let error = null;
  try {
    rmrf(work);
    ensureDir(work);
    let blocked = null;
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      const plan = i === 0 ? { id: "fetch", kind: "fetch" } : co.steps[i - 1];
      if (signal?.aborted) throw abortError();
      if (blocked) {
        st.status = "skipped";
        st.summary = `skipped — ${blocked}`;
        continue;
      }
      if (Date.now() > deadline) {
        st.status = "skipped";
        st.summary = "skipped — the checkout ran out of time";
        if (!blocked) add({ severity: "high", check: "ci", step: st.id, title: `CI timed out before "${st.label}"`, detail: "Raise the time limit under the website's CI settings, or split the work." });
        blocked = "out of time";
        continue;
      }
      st.status = "running";
      st.startedAt = Date.now();
      log(`── ${st.label} ──`);
      report();
      const before = findings.length;
      let out;
      try {
        out = SIMULATE() ? await simulateStep(plan, ctx, payload) : await runStep(plan, ctx, payload);
      } catch (err) {
        if (err.aborted || signal?.aborted) throw abortError();
        out = { ok: false, summary: err.message };
        add({ severity: "high", check: plan.kind, step: plan.id, title: `${st.label} could not run`, detail: err.message });
      }
      st.durationMs = Date.now() - st.startedAt;
      const newFindings = findings.length - before;
      st.status = out.skipped ? "skipped" : out.ok === false ? "failed" : newFindings ? "warning" : "passed";
      st.summary = out.summary || (newFindings ? `${newFindings} finding${newFindings === 1 ? "" : "s"}` : "");
      log(`${st.status === "passed" ? "✓" : st.status === "skipped" ? "–" : st.status === "warning" ? "!" : "✗"} ${st.label}${st.summary ? ` — ${st.summary}` : ""} (${(st.durationMs / 1000).toFixed(1)}s)`);
      if (st.status === "failed" && (plan.gate || plan.kind === "fetch")) blocked = `${st.label.toLowerCase()} failed`;
      report();
    }
  } catch (err) {
    error = err;
  } finally {
    for (const p of ctx.procs) await stopProc(p);
    rmrf(work);
    cleaned = !exists(work);
    log(cleaned ? `Checkout files deleted from ${os.hostname()} (${work}).` : `!! Could not delete ${work} — it will be swept by the next checkout.`);
    for (const st of steps) if (st.status === "running" || st.status === "pending") st.status = error?.aborted ? "cancelled" : "skipped";
    report(true);
  }
  if (error) {
    error.cleaned = cleaned;
    throw error;
  }
  return { checkoutId: co.id, hostname: os.hostname(), steps, findings, cleaned, durationMs: Date.now() - started, simulated: SIMULATE() || undefined };
}

function rel(work, file) {
  let f = String(file);
  if (f.startsWith(work)) f = f.slice(work.length + 1);
  return f.replace(/^\.\//, "");
}

function buildEnv(payload) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^npm_/i.test(k)) env[k] = v;
  Object.assign(env, payload.env || {});
  env.CI = "1";
  env.FCC_CI = "1";
  env.FCC_CI_RUN = String(payload.runId || "");
  env.NEXT_TELEMETRY_DISABLED = "1";
  env.npm_config_update_notifier = "false";
  delete env.PORT;
  return env;
}

// ------------------------------------------------------------------- steps

async function runStep(step, c, payload) {
  const timeout = () => Math.max(5000, Math.min(c.deadline - Date.now(), (STEP_TIMEOUTS[step.kind] || 15) * MINUTE));
  switch (step.kind) {
    case "fetch":
      return fetchRelease(payload.release, c);
    case "install": {
      const r = await shell(step.cmd, c, { timeoutMs: timeout(), env: { NODE_ENV: c.env.NODE_ENV || "development" } });
      if (r.code === 0) return { ok: true };
      c.add({ severity: "high", check: "install", step: step.id, title: "Dependencies failed to install", detail: r.tail || r.error });
      return { ok: false, summary: `exit ${r.code}` };
    }
    case "build":
    case "command": {
      const r = await shell(step.cmd, c, { timeoutMs: timeout(), env: { NODE_ENV: "production" } });
      if (r.code === 0) return { ok: true };
      const errs = parseTsErrors(r.out, c.work);
      for (const e of errs.slice(0, 40)) c.add({ severity: step.severity || "high", check: step.kind, step: step.id, ...e });
      c.add({ severity: step.severity || "high", check: step.kind, step: step.id, title: step.kind === "build" ? "Build failed — this release would not deploy" : `${step.label} failed`, detail: r.tail || r.error });
      return { ok: false, summary: errs.length ? `${errs.length} error${errs.length === 1 ? "" : "s"}` : `exit ${r.code}` };
    }
    case "typecheck": {
      const r = await shell(step.cmd, c, { timeoutMs: timeout() });
      if (r.code === 0) return { ok: true, summary: "no type errors" };
      const errs = parseTsErrors(r.out, c.work);
      for (const e of errs.slice(0, 60)) c.add({ severity: "high", check: "typecheck", step: step.id, ...e });
      if (!errs.length) c.add({ severity: "high", check: "typecheck", step: step.id, title: "Type check failed", detail: r.tail || r.error });
      return { ok: false, summary: `${errs.length || "some"} type error${errs.length === 1 ? "" : "s"}` };
    }
    case "lint":
      return lintStep(step, c, timeout());
    case "tests":
      return testsStep(step, c, timeout());
    case "suite": {
      const r = await shell(step.cmd, c, { timeoutMs: timeout(), env: { NODE_ENV: c.ciEnv.NODE_ENV || "test" } });
      if (r.code === 0) return { ok: true };
      c.add({ severity: step.severity || "extreme", check: "suite", step: step.id, title: `${step.label} failed`, detail: `$ ${step.cmd}\n${r.tail || r.error}` });
      return { ok: false, summary: r.timedOut ? "timed out" : `exit ${r.code}` };
    }
    case "smoke":
      return smokeStep(step, c, timeout());
    case "static-output":
      return staticOutputStep(step, c);
    case "php-lint":
      return phpLintStep(step, c, timeout());
    default:
      return { skipped: true, summary: `unknown step kind "${step.kind}" — newer panel than this server's agent?` };
  }
}

async function fetchRelease(release, c) {
  if (!release) throw new Error("No release in the payload.");
  let buf;
  if (release.file && exists(release.file)) buf = fs.readFileSync(release.file);
  else if (release.url) {
    const res = await fetch(release.url, { headers: release.token ? { Authorization: `Bearer ${release.token}` } : {}, signal: c.signal || undefined });
    if (!res.ok) throw new Error(`Could not download the release: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } else throw new Error("The release has neither a local file nor a download URL.");
  if (release.sha256 && crypto.createHash("sha256").update(buf).digest("hex") !== release.sha256) throw new Error("The release archive failed its sha256 check.");
  const files = extractZip(buf, c.work, { stripRoot: true });
  // A shipped node_modules or .next would make the checkout test something other than the source.
  rmrf(path.join(c.work, "node_modules"));
  return { ok: true, summary: `${files.length} files, ${(buf.length / 1048576).toFixed(1)} MB` };
}

async function lintStep(step, c, timeoutMs) {
  const r = await shell(step.cmd, c, { timeoutMs, capture: true, quiet: true });
  let results = null;
  const i = r.stdout.indexOf("[");
  if (i !== -1) {
    try {
      results = JSON.parse(r.stdout.slice(i));
    } catch {
      results = null;
    }
  }
  if (!Array.isArray(results)) {
    if (r.code === 0) return { ok: true };
    c.add({ severity: "medium", check: "lint", step: step.id, title: "ESLint could not run", detail: r.tail || r.error });
    return { ok: false, summary: `exit ${r.code}` };
  }
  let errors = 0;
  let warnings = 0;
  for (const f of results) {
    for (const m of f.messages || []) {
      if (/^File ignored/.test(m.message || "")) continue;
      const sev = m.severity === 2 || m.fatal ? "medium" : "low";
      sev === "medium" ? errors++ : warnings++;
      c.add({ severity: m.fatal ? "high" : sev, check: "lint", step: step.id, title: `${m.ruleId ? `${m.ruleId}: ` : ""}${m.message}`, file: f.filePath, line: m.line ?? null });
    }
  }
  c.log(`ESLint: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"} in ${results.length} file${results.length === 1 ? "" : "s"}.`);
  return { ok: true, summary: errors || warnings ? `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}` : `${results.length} file${results.length === 1 ? "" : "s"} clean` };
}

async function testsStep(step, c, timeoutMs) {
  if (step.report) ensureDir(path.dirname(path.join(c.work, step.report)));
  const r = await shell(step.cmd, c, { timeoutMs, env: { NODE_ENV: c.ciEnv.NODE_ENV || "test" } });
  const sevOf = (file) => step.severityOf?.[rel(c.work, file)] || "high";
  let passed = 0;
  let failed = 0;
  let parsed = false;
  if (step.report && exists(path.join(c.work, step.report))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(c.work, step.report), "utf8"));
      parsed = true;
      for (const tr of j.testResults || []) {
        const file = tr.name || tr.testFilePath || "";
        const asserts = tr.assertionResults || [];
        for (const a of asserts) {
          if (a.status === "passed") passed++;
          else if (a.status === "failed") {
            failed++;
            c.add({ severity: sevOf(file), check: "tests", step: step.id, title: `Test failed: ${a.fullName || a.title}`, detail: (a.failureMessages || []).join("\n").replace(/\x1b\[[0-9;]*m/g, "").slice(0, 3000), file, line: a.location?.line ?? null });
          }
        }
        if (!asserts.length && (tr.status === "failed" || tr.message)) {
          failed++;
          c.add({ severity: sevOf(file), check: "tests", step: step.id, title: `Test file failed to run: ${rel(c.work, file)}`, detail: String(tr.message || tr.failureMessage || "").replace(/\x1b\[[0-9;]*m/g, "").slice(0, 3000), file });
        }
      }
    } catch {
      parsed = false;
    }
  } else if (step.runner === "node") {
    for (const m of r.out.matchAll(/^\s*not ok \d+ - (.+)$/gm)) {
      parsed = true;
      failed++;
      c.add({ severity: "high", check: "tests", step: step.id, title: `Test failed: ${m[1]}`, detail: "" });
    }
    const p = /# pass (\d+)/.exec(r.out);
    if (p) (parsed = true, (passed = Number(p[1])));
  }
  if (r.code === 0) return { ok: true, summary: parsed ? `${passed} passed` : "passed" };
  if (!failed) c.add({ severity: worstOfMap(step.severityOf) || "high", check: "tests", step: step.id, title: r.timedOut ? "Tests timed out" : "Tests failed", detail: r.tail || r.error });
  return { ok: false, summary: `${failed || "some"} failed${passed ? `, ${passed} passed` : ""}` };
}
const ORDER = ["low", "medium", "high", "extreme"];
const worstOfMap = (m) => Object.values(m || {}).reduce((w, s) => (ORDER.indexOf(s) > ORDER.indexOf(w) ? s : w), null);

async function smokeStep(step, c, timeoutMs) {
  const port = await freePort();
  const until = Date.now() + timeoutMs;
  c.log(`Starting the app on 127.0.0.1:${port}: ${step.start}`);
  const proc = startProc(step.start, c, { PORT: String(port), HOSTNAME: "127.0.0.1", NODE_ENV: "production" });
  c.procs.add(proc);
  const base = `http://127.0.0.1:${port}`;
  // Wait for it to answer anything at all.
  let up = false;
  const waitUntil = Math.min(until, Date.now() + 120_000);
  while (!up && Date.now() < waitUntil && !c.signal?.aborted) {
    if (proc.exited) break;
    try {
      const res = await fetch(base + (step.healthPath || "/"), { redirect: "manual", signal: AbortSignal.timeout(3000) });
      await res.arrayBuffer().catch(() => {});
      up = true;
    } catch {
      await sleep(700, c.signal);
    }
  }
  if (c.signal?.aborted) throw abortError();
  if (!up) {
    c.add({ severity: "high", check: "smoke", step: step.id, title: proc.exited ? `The app exits right after starting (code ${proc.code})` : "The app did not start answering within 2 minutes", detail: proc.tail.slice(-30).join("\n") });
    await stopProc(proc);
    return { ok: false, summary: "app did not start" };
  }
  c.log(`App is up — probing ${step.probes.length} route${step.probes.length === 1 ? "" : "s"}${step.suites?.length ? ` and ${step.suites.length} critical suite${step.suites.length === 1 ? "" : "s"}` : ""}.`);
  let ok = 0;
  let bad = 0;
  for (const p of step.probes || []) {
    if (c.signal?.aborted) throw abortError();
    const r = await probe(base, p);
    const isPage = p.kind === "page";
    if (r.error) {
      bad++;
      c.add({ severity: "high", check: "smoke", step: step.id, title: `${p.path} did not respond`, detail: r.error, file: p.file });
    } else if (r.status >= 500) {
      bad++;
      c.add({ severity: "high", check: "smoke", step: step.id, title: `${p.path} returns ${r.status}`, detail: `${isPage ? "Page" : "API route"} ${p.route} crashes on GET.\n${r.snippet}`, file: p.file });
    } else if (isPage && r.status === 404) {
      bad++;
      c.add({ severity: "medium", check: "smoke", step: step.id, title: `${p.path} returns 404`, detail: `The page file exists (${p.file}) but the route is not found.`, file: p.file });
    } else {
      ok++;
      if (r.ms > 8000) c.add({ severity: "low", check: "smoke", step: step.id, title: `${p.path} is slow (${(r.ms / 1000).toFixed(1)}s)`, file: p.file });
    }
    c.log(`  ${r.error ? "ERR" : r.status} ${p.method} ${p.path} ${r.ms != null ? `${r.ms}ms` : ""}`);
  }
  for (const s of step.suites || []) {
    for (const p of s.probes) {
      const r = await probe(base, p);
      const want = p.expect;
      const pass = !r.error && (want ? r.status === want : r.status < 500) && (!p.contains || r.body.includes(p.contains));
      c.log(`  [${s.name}] ${r.error ? "ERR" : r.status} ${p.method} ${p.path}${pass ? "" : "  ✗"}`);
      if (pass) ok++;
      else {
        bad++;
        const why = r.error ? r.error : want && r.status !== want ? `expected ${want}, got ${r.status}` : p.contains && !r.body.includes(p.contains) ? `the response does not contain "${p.contains}"` : `got ${r.status}`;
        c.add({ severity: s.severity, check: "suite", step: step.id, title: `${s.name}: ${p.method} ${p.path} — ${why}`, detail: r.snippet || "" });
      }
    }
  }
  await stopProc(proc);
  c.procs.delete(proc);
  return { ok: bad === 0, summary: `${ok} ok${bad ? `, ${bad} failing` : ""}` };
}

async function probe(base, p) {
  const t = Date.now();
  try {
    const res = await fetch(base + p.path, {
      method: p.method || "GET",
      redirect: "manual",
      headers: { "user-agent": "fcc-ci", ...(p.body ? { "content-type": "application/json" } : {}) },
      body: p.body && !/^(GET|HEAD)$/.test(p.method || "GET") ? p.body : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.text().catch(() => "")).slice(0, 200_000);
    return { status: res.status, ms: Date.now() - t, body, snippet: body.replace(/\s+/g, " ").slice(0, 400) };
  } catch (err) {
    return { error: err.name === "TimeoutError" ? "timed out after 20s" : err.message, ms: Date.now() - t, body: "", snippet: "" };
  }
}

function staticOutputStep(step, c) {
  const dirs = step.root ? [step.root] : ["dist", "build", "out", "public", "_site", ""];
  const hit = dirs.find((d) => exists(path.join(c.work, d, "index.html")));
  if (hit != null) return { ok: true, summary: `${hit || "."}/index.html` };
  c.add({ severity: "high", check: "static-output", step: step.id, title: "The build produced no index.html", detail: `Looked in ${dirs.map((d) => d || ".").join(", ")}.` });
  return { ok: false, summary: "no index.html" };
}

async function phpLintStep(step, c, timeoutMs) {
  const php = sys.which("php");
  if (!php) return { skipped: true, summary: "php is not installed on this server" };
  let bad = 0;
  for (const f of step.files || []) {
    if (Date.now() > c.deadline) break;
    const r = await shell(`${php} -l ${JSON.stringify(f)}`, c, { timeoutMs: Math.min(timeoutMs, 30_000), quiet: true });
    if (r.code !== 0) {
      bad++;
      const m = /on line (\d+)/.exec(r.out);
      c.add({ severity: "high", check: "php-lint", step: step.id, title: `PHP syntax error in ${f}`, detail: r.out.trim().split("\n").slice(0, 4).join("\n"), file: f, line: m ? Number(m[1]) : null });
    }
  }
  return { ok: bad === 0, summary: bad ? `${bad} file${bad === 1 ? "" : "s"} with errors` : `${(step.files || []).length} files ok` };
}

/** `app/page.tsx(12,5): error TS2322: …` and Next's `./app/page.tsx:12:5` + `Type error: …`. */
export function parseTsErrors(out, work = "") {
  const errs = [];
  const text = String(out || "").replace(/\x1b\[[0-9;]*m/g, "");
  for (const m of text.matchAll(/^(?:\s*)([^\s(:][^():\n]*\.(?:[cm]?[jt]sx?))\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm)) {
    errs.push({ file: rel(work, m[1]), line: Number(m[2]), title: `${m[4]}: ${m[5].trim()}` });
  }
  if (!errs.length) {
    for (const m of text.matchAll(/^\.?\/?([^\s:]+\.(?:[cm]?[jt]sx?)):(\d+):(\d+)\s*\n(?:.*\n){0,2}?\s*Type error:\s*(.+)$/gm)) {
      errs.push({ file: rel(work, m[1]), line: Number(m[2]), title: `Type error: ${m[4].trim()}` });
    }
  }
  return errs;
}

// ------------------------------------------------------------- processes

function shell(cmd, c, { timeoutMs = 15 * MINUTE, env = {}, capture = false, quiet = false } = {}) {
  return new Promise((resolve) => {
    c.log(`$ ${cmd.length > 300 ? cmd.slice(0, 297) + "…" : cmd}`);
    const bin = exists("/bin/bash") ? "/bin/bash" : "/bin/sh";
    const childEnv = { ...c.env, ...env, ...c.ciEnv };
    childEnv.PATH = [path.join(c.work, "node_modules", ".bin"), childEnv.PATH].filter(Boolean).join(path.delimiter);
    let child;
    try {
      child = spawn(bin, ["-c", cmd], { cwd: c.work, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return resolve({ code: 127, error: err.message, out: "", stdout: "", tail: err.message });
    }
    const tail = [];
    let out = "";
    let stdout = "";
    let partial = "";
    const onData = (isOut) => (chunk) => {
      const s = chunk.toString("utf8");
      if (capture && isOut) {
        if (stdout.length < 30 * 1024 * 1024) stdout += s;
        return;
      }
      if (out.length < 4 * 1024 * 1024) out += s;
      partial += s.replace(/\r(?!\n)/g, "\n");
      let i;
      while ((i = partial.indexOf("\n")) !== -1) {
        const line = partial.slice(0, i);
        partial = partial.slice(i + 1);
        if (!quiet) c.log(line);
        tail.push(line);
        if (tail.length > 60) tail.shift();
      }
    };
    child.stdout.on("data", onData(true));
    child.stderr.on("data", onData(false));
    let timedOut = false;
    let killer = null;
    const stop = () => {
      killGroup(child, "SIGTERM");
      killer = setTimeout(() => killGroup(child, "SIGKILL"), 5000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      c.log(`!! timed out after ${Math.round(timeoutMs / 1000)}s — stopping`);
      stop();
    }, timeoutMs);
    const onAbort = () => stop();
    c.signal?.addEventListener?.("abort", onAbort, { once: true });
    const finish = (code, error) => {
      clearTimeout(timer);
      clearTimeout(killer);
      c.signal?.removeEventListener?.("abort", onAbort);
      if (partial) (tail.push(partial), quiet || c.log(partial));
      resolve({ code: timedOut ? 124 : code, timedOut, error, out, stdout, tail: tail.filter((l) => l.trim()).slice(-40).join("\n") });
    };
    child.on("error", (err) => finish(127, err.message));
    child.on("close", (code, sig) => finish(code ?? (sig ? 128 : 1)));
  });
}

function startProc(cmd, c, env) {
  const bin = exists("/bin/bash") ? "/bin/bash" : "/bin/sh";
  const childEnv = { ...c.env, ...c.ciEnv, ...env };
  childEnv.PATH = [path.join(c.work, "node_modules", ".bin"), childEnv.PATH].filter(Boolean).join(path.delimiter);
  const child = spawn(bin, ["-c", cmd], { cwd: c.work, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const p = { child, exited: false, code: null, tail: [], done: null };
  const sink = (chunk) => {
    for (const l of chunk.toString("utf8").split("\n")) {
      if (!l.trim()) continue;
      p.tail.push(l);
      if (p.tail.length > 80) p.tail.shift();
      c.log(`  [app] ${l}`);
    }
  };
  child.stdout.on("data", sink);
  child.stderr.on("data", sink);
  p.done = new Promise((resolve) => {
    const end = (code) => {
      p.exited = true;
      p.code = code;
      resolve();
    };
    child.on("close", (code, sig) => end(code ?? (sig ? 128 : 1)));
    child.on("error", () => end(127));
  });
  return p;
}

async function stopProc(p) {
  if (!p || p.exited) return;
  killGroup(p.child, "SIGTERM");
  const t = setTimeout(() => killGroup(p.child, "SIGKILL"), 5000);
  await Promise.race([p.done, sleep(8000)]);
  clearTimeout(t);
}

function killGroup(child, sig) {
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// --------------------------------------------------------------- dry run

async function simulateStep(step, c, payload) {
  const wait = (ms) => sleep(ms, c.signal).then(() => { if (c.signal?.aborted) throw abortError(); });
  switch (step.kind) {
    case "fetch": {
      if (payload.release?.file && exists(payload.release.file)) {
        const files = extractZip(fs.readFileSync(payload.release.file), c.work, { stripRoot: true });
        await wait(400);
        return { ok: true, summary: `${files.length} files (dry run)` };
      }
      await wait(800);
      return { ok: true, summary: "dry run" };
    }
    case "smoke": {
      c.log(`[dry-run] would start "${step.start}" on a free port and probe:`);
      for (const p of step.probes || []) (c.log(`[dry-run]   GET ${p.path}`), await wait(250));
      for (const s of step.suites || []) for (const p of s.probes) (c.log(`[dry-run]   [${s.name}] ${p.method} ${p.path}`), await wait(250));
      const n = (step.probes || []).length;
      return { ok: true, summary: `${n} route${n === 1 ? "" : "s"} (dry run)` };
    }
    default: {
      if (step.cmd) c.log(`[dry-run] would run: ${step.cmd.length > 200 ? step.cmd.slice(0, 197) + "…" : step.cmd}`);
      const ms = { install: 3500, build: 4500, typecheck: 2500, lint: 1800, tests: 3000, suite: 2200 }[step.kind] || 1200;
      await wait(ms + Math.round(Math.random() * 1200));
      return { ok: true, summary: "dry run" };
    }
  }
}
