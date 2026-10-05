/**
 * Task executor — the one place that knows how to do things TO a server.
 *
 * The panel calls it in-process for the main server, and the node agent
 * (node/node-agent.mjs) calls it for tasks the panel hands an Agent server.
 * Same code on both sides, so a site on main behaves exactly like a site on
 * any other machine.
 *
 *   executeTask(type, payload, { log, signal, dataDir, isMain, uploadFile, authToken, panelUrl })
 *
 * Task types and their payload/result shapes are listed in docs/STANDALONE.md
 * (section 3, "ctx.cluster"). There is deliberately no "run a command" task:
 * site.script runs only `npm run <name>` for a script the deployed package.json defines.
 *
 * Everything that shells out goes through panel/lib/sys.mjs, so FCC_DRY_RUN=1
 * logs what would run instead of running it. The deploy engine spawns its own
 * build commands, so under DRY_RUN the site.* tasks are simulated end to end
 * (state is remembered in memory so start/stop/status still make sense).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { execFile, spawn } from "node:child_process";

import { Deployer } from "./deployer.mjs";
import { ensureDir, rmrf, exists } from "./fsx.mjs";
import * as sys from "../panel/lib/sys.mjs";

export const TASKS_VERSION = "3.0.0";

export const TASK_TYPES = [
  "site.deploy",
  "site.rollback",
  "site.start",
  "site.stop",
  "site.restart",
  "site.status",
  "site.env",
  "site.remove",
  "site.logs",
  "site.scripts",
  "site.script",
  "server.metrics",
  "server.backup",
];

/** A package.json script (site.script) is stopped after this long. */
export const SCRIPT_TIMEOUT_MS = 15 * 60_000;

/** Generous upper bounds, used by the panel to give up on a silent task. */
export const TASK_TIMEOUTS_MS = {
  "site.deploy": 60 * 60_000,
  "site.rollback": 30 * 60_000,
  "site.start": 15 * 60_000,
  "site.stop": 5 * 60_000,
  "site.restart": 15 * 60_000,
  "site.status": 60_000,
  "site.env": 60_000,
  "site.remove": 10 * 60_000,
  "site.logs": 60_000,
  "site.scripts": 60_000,
  "site.script": SCRIPT_TIMEOUT_MS + 2 * 60_000, // the task kills the script itself at SCRIPT_TIMEOUT_MS
  "server.metrics": 30_000,
  "server.backup": 6 * 60 * 60_000,
};

const NOOP = () => {};

// ------------------------------------------------------------------ entry

export async function executeTask(type, payload = {}, opts = {}) {
  const o = {
    log: opts.log || NOOP,
    signal: opts.signal || null,
    dataDir: opts.dataDir || defaultDataDir(),
    isMain: !!opts.isMain,
    uploadFile: opts.uploadFile || null,
    authToken: opts.authToken || null,
    panelUrl: opts.panelUrl || null,
    serverId: opts.serverId || null,
  };
  if (o.signal?.aborted) throw abortError();
  switch (type) {
    case "server.metrics":
      return collectMetrics();
    case "server.backup":
      return serverBackup(payload, o);
    case "site.status":
      return siteStatus(payload, o);
    case "site.logs":
      return siteLogs(payload, o);
    case "site.scripts":
      return siteScripts(payload, o);
    case "site.script":
      return withSiteLock(siteIdOf(payload), () => siteScript(payload, o));
    case "site.deploy":
    case "site.rollback":
    case "site.start":
    case "site.stop":
    case "site.restart":
    case "site.env":
    case "site.remove":
      return withSiteLock(siteIdOf(payload), () => siteAction(type, payload, o));
    default:
      throw new Error(`Unknown task type "${type}"`);
  }
}

function defaultDataDir() {
  return process.env.FCC_DATA_DIR || "/var/lib/fcc";
}

function abortError(reason = "Cancelled.") {
  const err = new Error(reason);
  err.aborted = true;
  return err;
}

function siteIdOf(payload) {
  const id = payload?.spec?.siteId;
  if (!id || !/^[A-Za-z0-9_-]+$/.test(String(id))) throw new Error("Task is missing a valid spec.siteId");
  return String(id);
}

// One mutating task per site at a time; status/logs never wait behind a deploy.
const siteLocks = new Map();
function withSiteLock(siteId, fn) {
  const prev = siteLocks.get(siteId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  siteLocks.set(siteId, tail);
  tail.then(() => {
    if (siteLocks.get(siteId) === tail) siteLocks.delete(siteId);
  });
  return next;
}

// --------------------------------------------------------------- spec → engine

function checkSpec(spec) {
  if (!spec || typeof spec !== "object") throw new Error("Task is missing its site spec");
  if (!["node", "static", "php"].includes(spec.type || "node")) throw new Error(`Unknown site type "${spec.type}"`);
  if (!spec.appDir || !path.isAbsolute(spec.appDir)) throw new Error("The site spec needs an absolute appDir");
  const norm = path.resolve(spec.appDir);
  if (norm.split(path.sep).filter(Boolean).length < 2) throw new Error(`Refusing to use ${norm} as an app directory`);
  const port = Number(spec.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The site spec needs a valid port");
  return { ...spec, type: spec.type || "node", appDir: norm, port };
}

function pm2NameOf(spec) {
  return String(spec.pm2Name || `fcc-${spec.siteId}`);
}

function healthUrlOf(spec) {
  const s = spec.settings || {};
  if (s.healthUrl) return s.healthUrl;
  const p = spec.healthPath || s.healthPath || (spec.type === "node" ? "/api/health" : "/");
  return `http://127.0.0.1:${spec.port}${p.startsWith("/") ? p : `/${p}`}`;
}

/** Deployer settings for this spec. */
function engineSettings(spec) {
  const s = spec.settings || {};
  const restart = s.restart || {};
  const build = s.build || {};
  const env = { ...(restart.env || {}), ...(spec.env || {}) };
  if (spec.type === "node") {
    return {
      ...s,
      appDir: spec.appDir,
      port: spec.port,
      healthUrl: healthUrlOf(spec),
      restart: {
        ...restart,
        mode: restart.mode && restart.mode !== "child" ? restart.mode : "pm2",
        service: restart.mode === "systemd" || restart.mode === "command" ? restart.service : pm2NameOf(spec),
        pm2Start: restart.pm2Start || restart.start || "npm start",
        env,
      },
    };
  }
  // static / php: nginx on this server serves the files; nothing to supervise.
  // Build commands only run when the site explicitly sets them.
  return {
    ...s,
    appDir: spec.appDir,
    port: spec.port,
    healthUrl: healthUrlOf(spec),
    restart: { mode: "command", start: "", stop: "", service: "", env },
    build: {
      install: build.install || "",
      prepare: build.prepare || "",
      build: build.build || "",
      artifact: build.artifact || "",
    },
    autoPrepare: false,
    writeEnvFile: spec.type === "php",
  };
}

const deployers = new Map(); // siteId -> Deployer

function deployerFor(spec, o) {
  let d = deployers.get(spec.siteId);
  const settings = engineSettings(spec);
  if (!d) {
    ensureDir(spec.appDir);
    d = new Deployer({ settings, getArtifact: () => Promise.reject(new Error("No release to download")) });
    deployers.set(spec.siteId, d);
  } else {
    d.setSettings(settings);
  }
  // static/php: nginx serves the files, so the engine must not wait on a
  // health/version URL mid-swap (the vhost root can change with the new files).
  // We write the vhost afterwards and probe it ourselves.
  if (spec.type !== "node") {
    d.healthUrl = () => "";
    d.versionUrl = () => "";
  } else {
    delete d.healthUrl;
    delete d.versionUrl;
  }
  return d;
}

function engineLog(log) {
  return {
    line(text) {
      for (const l of String(text ?? "").replace(/\r/g, "").split("\n")) log(l);
    },
    setStep(step) {
      log(`── ${step} ──`);
    },
  };
}

async function downloadRelease(release, o) {
  if (!release) throw new Error("No release given for this deploy");
  let buf;
  if (release.file && exists(release.file)) {
    buf = fs.readFileSync(release.file);
  } else if (release.url) {
    const url = new URL(release.url, o.panelUrl || undefined).toString();
    const token = release.token || o.authToken;
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: o.signal || undefined,
    });
    if (!res.ok) throw new Error(`Could not download the release: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    throw new Error("The release has neither a local file nor a download URL");
  }
  if (release.sha256) {
    const actual = crypto.createHash("sha256").update(buf).digest("hex");
    if (actual !== release.sha256) throw new Error("The release archive failed its sha256 check — aborting.");
  }
  return buf;
}

function normalize(spec, r = {}, extra = {}) {
  const health = r.health || null;
  return {
    ...r,
    running: r.appRunning ?? extra.running ?? (health ? health.ok !== false : null),
    healthy: health ? health.ok : null,
    version: r.serving?.version || r.deployed?.version || r.summary?.version || null,
    ...extra,
  };
}

// --------------------------------------------------------------- site actions

async function siteAction(type, payload, o) {
  const spec = checkSpec(payload.spec);
  const { log, signal } = o;
  if (sys.DRY_RUN) return dryRunSite(type, spec, payload, o);

  if (spec.type === "php" && ["site.deploy", "site.rollback", "site.start", "site.restart"].includes(type)) requirePhpFpm();
  const d = deployerFor(spec, o);
  const L = engineLog(log);
  const onAbort = () => d.abort("Cancelled from the panel.");
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    switch (type) {
      case "site.deploy": {
        const release = payload.release || {};
        d.getArtifact = () => downloadRelease(release, o);
        const r = await d.execute(
          {
            type: "deploy",
            releaseId: release.id || "release",
            releaseFilename: release.filename || `${release.id || "release"}.zip`,
            releaseVersion: release.version || null,
            releaseSha256: null, // verified in downloadRelease
          },
          L,
        );
        if (spec.type !== "node") {
          await writeSiteVhost(spec, o); // root may have changed (dist/, public/)
          if (spec.type === "php") await reloadPhpFpm(log);
          const st = await staticStatus(spec, d, o);
          log(`Serving ${siteRoot(spec)} on port ${spec.port} — ${st.healthy === null ? "not checked (nginx is not live here)" : st.healthy ? "responding" : "NOT responding yet"}.`);
          return { ...r, ...st };
        }
        if (spec.settings?.restart?.mode !== "systemd") await pm2Save(log);
        return normalize(spec, r);
      }
      case "site.rollback": {
        const r = await d.execute({ type: "rollback" }, L);
        if (spec.type !== "node") {
          await writeSiteVhost(spec, o);
          return { ...r, ...(await staticStatus(spec, d, o)) };
        }
        return normalize(spec, r);
      }
      case "site.start": {
        if (spec.type !== "node") {
          await writeSiteVhost(spec, o);
          return staticStatus(spec, d, o);
        }
        const r = await d.execute({ type: "start" }, L);
        await pm2Save(log);
        return normalize(spec, r);
      }
      case "site.stop": {
        if (spec.type !== "node") {
          await removeSiteVhost(spec, o);
          return { running: false, healthy: null, version: d.readDeployedInfo()?.version || null };
        }
        const r = await d.execute({ type: "stop" }, L);
        await pm2Save(log);
        return normalize(spec, r, { running: r.appRunning ?? false });
      }
      case "site.restart": {
        if (spec.type !== "node") {
          d.writeEnvFile(spec.appDir, L);
          await writeSiteVhost(spec, o, { force: true });
          if (spec.type === "php") await reloadPhpFpm(log);
          return staticStatus(spec, d, o);
        }
        const r = await d.execute({ type: "restart" }, L);
        await pm2Save(log);
        return normalize(spec, r);
      }
      case "site.env": {
        const env = payload.env || {};
        d.setSettings({ ...engineSettings(spec), writeEnvFile: spec.type !== "static", restart: { ...engineSettings(spec).restart, env } });
        if (spec.type === "static") {
          log("Static sites have no server-side environment — nothing written.");
          return { written: false };
        }
        ensureDir(spec.appDir);
        const file = d.writeEnvFile(spec.appDir, L);
        if (!Object.keys(env).length) log("No variables set.");
        return { written: !!file, file: file || null, keys: Object.keys(env).length };
      }
      case "site.remove": {
        if (spec.type === "node" && spec.settings?.restart?.mode !== "systemd") {
          await sys.run("pm2", ["delete", pm2NameOf(spec)], { log, allowFail: true, timeoutMs: 60_000 });
          await pm2Save(log);
        } else if (spec.type === "node") {
          await d.stopApp(L).catch(() => {});
        }
        if (spec.type !== "node") await removeSiteVhost(spec, o);
        deployers.delete(spec.siteId);
        if (payload.deleteFiles) {
          log(`Deleting ${spec.appDir}`);
          rmrf(spec.appDir);
        } else {
          log(`Files left in place at ${spec.appDir}`);
        }
        return { removed: true, deletedFiles: !!payload.deleteFiles };
      }
    }
    throw new Error(`Unknown task type "${type}"`);
  } catch (err) {
    if (err.aborted || signal?.aborted) throw abortError(err.message);
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    d.cleanup();
  }
}

async function pm2Save(log) {
  await sys.run("pm2", ["save"], { log: NOOP, allowFail: true, timeoutMs: 30_000 }).catch(() => {});
}

async function siteStatus(payload, o) {
  const spec = checkSpec(payload.spec);
  if (sys.DRY_RUN) {
    const st = dryState(spec.siteId);
    return { running: st.running, healthy: st.running ? true : null, version: st.version, checkedAt: new Date().toISOString(), dryRun: true };
  }
  const d = deployerFor(spec, o);
  if (spec.type !== "node") return staticStatus(spec, d, o);
  const health = await d.checkHealth().catch(() => null);
  const pm = await pm2Info(pm2NameOf(spec));
  let running = pm ? pm.status === "online" : await d.appRunning().catch(() => null);
  if (running == null && health) running = health.ok;
  const serving = await d.readServingInfo().catch(() => null);
  const deployed = d.readDeployedInfo();
  return {
    running: running ?? false,
    healthy: health?.ok ?? null,
    version: serving?.version || deployed?.version || null,
    pid: pm?.pid || undefined,
    memory: pm?.memory,
    cpu: pm?.cpu,
    restarts: pm?.restarts,
    deployed,
    checkedAt: new Date().toISOString(),
  };
}

async function staticStatus(spec, d, o) {
  const vhost = vhostFile(spec, o);
  const running = exists(vhost.file);
  const healthy = running ? await probeHealth(spec) : null;
  return {
    running,
    healthy,
    version: d.readDeployedInfo()?.version || null,
    checkedAt: new Date().toISOString(),
  };
}

/** Static/php health: an explicit healthPath must answer 2xx/3xx; otherwise anything below 500 counts. */
async function probeHealth(spec) {
  if (!nginxIsLive()) return null;
  const strict = !!(spec.healthPath || spec.settings?.healthPath || spec.settings?.healthUrl);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(healthUrlOf(spec), { signal: ctrl.signal, redirect: "manual" });
    await res.arrayBuffer().catch(() => {});
    return strict ? res.status < 400 : res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function pm2Info(name) {
  const r = await sys.run("pm2", ["jlist"], { allowFail: true, timeoutMs: 20_000 }).catch(() => null);
  if (!r || r.code !== 0 || !r.stdout) return null;
  try {
    const list = JSON.parse(r.stdout.slice(r.stdout.indexOf("[")));
    const p = list.find((x) => x.name === name);
    if (!p) return { status: "missing" };
    return {
      status: p.pm2_env?.status,
      pid: p.pid,
      memory: p.monit?.memory,
      cpu: p.monit?.cpu,
      restarts: p.pm2_env?.restart_time,
      outLog: p.pm2_env?.pm_out_log_path,
      errLog: p.pm2_env?.pm_err_log_path,
    };
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- site logs

async function siteLogs(payload, o) {
  const spec = checkSpec(payload.spec);
  const lines = Math.max(10, Math.min(5000, Number(payload.lines) || 200));
  if (sys.DRY_RUN) {
    return { text: `[dry-run] would show the last ${lines} lines of ${spec.name || spec.siteId}'s logs on ${os.hostname()}\n` };
  }
  const files = [];
  if (spec.type === "node") {
    const pm = await pm2Info(pm2NameOf(spec));
    const pm2Home = process.env.PM2_HOME || path.join(os.homedir(), ".pm2");
    const safe = pm2NameOf(spec).replace(/[^A-Za-z0-9_-]/g, "-");
    files.push(["stdout", pm?.outLog || path.join(pm2Home, "logs", `${safe}-out.log`)]);
    files.push(["stderr", pm?.errLog || path.join(pm2Home, "logs", `${safe}-error.log`)]);
  } else {
    files.push(["nginx errors", `/var/log/nginx/fcc-app-${spec.siteId}.error.log`]);
    if (spec.type === "php") {
      const laravel = path.join(spec.appDir, "storage/logs/laravel.log");
      if (exists(laravel)) files.push(["laravel", laravel]);
    }
  }
  let text = "";
  for (const [label, file] of files) {
    const body = tailFile(file, lines);
    text += `==> ${label} (${file}) <==\n${body ?? "(no log file yet)\n"}\n`;
  }
  return { text };
}

// ------------------------------------------------------- package.json scripts
//
// Not a terminal: the only thing that can run is `npm run <name>`, where <name>
// is a key of "scripts" in the package.json that is deployed on THIS server,
// checked against a strict pattern, and passed to npm as its own argument
// (no shell on our side). npm puts node_modules/.bin on PATH, so devDependency
// tools (prisma, drizzle-kit, knex…) work as they do on a laptop.

/** Letters, digits and : . _ + - ; must not start with "-" or "." (no flags, no paths). */
export const SCRIPT_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9:._+-]{0,99}$/;

export function validScriptName(name) {
  return typeof name === "string" && SCRIPT_NAME_RE.test(name) && !name.includes("..");
}

/** The deployed package.json's scripts, or { error }. */
export function readPackageScripts(appDir) {
  const file = path.join(appDir, "package.json");
  if (!exists(file)) return { error: `There is no package.json in ${appDir} on ${os.hostname()} — deploy the website first.` };
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { error: `${file} is not valid JSON.` };
  }
  const scripts = {};
  if (pkg && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)) {
    for (const [k, v] of Object.entries(pkg.scripts)) if (typeof v === "string") scripts[k] = v;
  }
  return {
    scripts,
    packageName: typeof pkg?.name === "string" ? pkg.name : null,
    version: typeof pkg?.version === "string" ? pkg.version : null,
    hasNodeModules: exists(path.join(appDir, "node_modules")),
  };
}

async function siteScripts(payload, o) {
  const spec = checkSpec(payload.spec);
  const r = readPackageScripts(spec.appDir);
  return { ...r, scripts: r.scripts || null, appDir: spec.appDir, hostname: os.hostname(), ...(sys.DRY_RUN ? { dryRun: true } : {}) };
}

/** The environment the app itself runs with (see Deployer._appEnv / pm2 start). */
function scriptEnv(spec) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^npm_/i.test(k)) env[k] = v; // not the panel's own npm context
  Object.assign(env, spec.settings?.restart?.env || {}, spec.env || {});
  env.PORT = String(spec.port);
  if (!env.NODE_ENV && spec.type === "node") env.NODE_ENV = "production";
  return env;
}

async function siteScript(payload, o) {
  const spec = checkSpec(payload.spec);
  const { log, signal } = o;
  const name = payload.script;
  if (!validScriptName(name)) throw new Error(`"${String(name).slice(0, 60)}" is not a valid script name.`);
  const pkg = readPackageScripts(spec.appDir);
  if (pkg.error && !sys.DRY_RUN) throw new Error(pkg.error);
  if (pkg.scripts && !Object.prototype.hasOwnProperty.call(pkg.scripts, name)) {
    throw new Error(`The package.json deployed on ${os.hostname()} has no "${name}" script.`);
  }
  const started = Date.now();
  const body = pkg.scripts?.[name];
  log(`$ npm run ${name}${body ? `   # ${body}` : ""}`);
  log(`in ${spec.appDir} on ${os.hostname()}`);
  if (sys.DRY_RUN) {
    log(`[dry-run] would run npm run ${name} with the website's environment (${Object.keys(spec.env || {}).length} variable(s) + PORT)`);
    return { script: name, code: 0, durationMs: Date.now() - started, dryRun: true };
  }
  if (!pkg.hasNodeModules) log("Note: there is no node_modules folder here, so tools from devDependencies may be missing.");

  // Scripts like `prisma db push` read .env for themselves: make sure the
  // managed block holds the current variables (no write when unchanged).
  if (spec.type !== "static") {
    try {
      const d = deployerFor(spec, o);
      d.writeEnvFile(spec.appDir, engineLog(log));
    } catch (err) {
      log(`Could not refresh .env: ${err.message}`);
    }
  }

  const npm = sys.which("npm") || "npm";
  const timeoutMs = SCRIPT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(npm, ["run", name], {
      cwd: spec.appDir,
      env: scriptEnv(spec),
      detached: true, // own process group: cancel/timeout stop everything it started
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tail = [];
    let partial = { out: "", err: "" };
    const sink = (key) => (chunk) => {
      partial[key] += chunk.toString("utf8").replace(/\r(?!\n)/g, "\n");
      let i;
      while ((i = partial[key].indexOf("\n")) !== -1) {
        const line = partial[key].slice(0, i).replace(/\r$/, "");
        partial[key] = partial[key].slice(i + 1);
        log(line);
        tail.push(line);
        if (tail.length > 40) tail.shift();
      }
    };
    child.stdout.on("data", sink("out"));
    child.stderr.on("data", sink("err"));

    let stopReason = null;
    let killTimer = null;
    const stop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      log(`!! ${reason} — stopping npm run ${name}`);
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), 5000);
    };
    const onAbort = () => stop("Cancelled from the panel");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop(`Timed out after ${Math.round(timeoutMs / 60000)} min`), timeoutMs);

    let settled = false;
    const done = (err, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      for (const key of ["out", "err"]) if (partial[key]) (log(partial[key]), tail.push(partial[key]));
      partial = { out: "", err: "" };
      const durationMs = Date.now() - started;
      if (err) return reject(err.code === "ENOENT" ? new Error(`npm is not installed on ${os.hostname()}.`) : err);
      if (stopReason) {
        const e = new Error(`${stopReason}.`);
        if (signal?.aborted) e.aborted = true;
        return reject(e);
      }
      if (code === 0) {
        log(`✓ npm run ${name} finished in ${(durationMs / 1000).toFixed(1)}s`);
        return resolve({ script: name, code, durationMs });
      }
      const last = tail.filter((l) => l.trim()).slice(-12).join("\n");
      const e = new Error(`npm run ${name} exited with code ${code}.${last ? `\n${last}` : ""}`);
      e.code = code;
      e.durationMs = durationMs;
      reject(e);
    };
    child.on("error", (err) => done(err));
    child.on("close", (code, sig) => done(null, code ?? (sig ? 128 : 1)));
  });
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

/** Last `n` lines of a file without reading all of it. */
export function tailFile(file, n = 200, maxBytes = 2 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    let start = size;
    let chunks = [];
    let newlines = 0;
    const block = 64 * 1024;
    while (start > 0 && newlines <= n && size - start < maxBytes) {
      const len = Math.min(block, start);
      start -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      chunks.unshift(buf);
      for (const b of buf) if (b === 10) newlines++;
    }
    const all = Buffer.concat(chunks).toString("utf8").split("\n");
    if (all[all.length - 1] === "") all.pop();
    return all.slice(-n).join("\n") + "\n";
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// ---------------------------------------------------------- local nginx vhost

/** Where nginx files go on this machine: conf.d when nginx is real, else a scratch dir. */
export function nginxConfDir(dataDir, sub = "nginx") {
  if (!sys.DRY_RUN && sys.which("nginx") && exists("/etc/nginx/conf.d")) return "/etc/nginx/conf.d";
  return ensureDir(path.join(dataDir || defaultDataDir(), sub));
}

export function nginxIsLive() {
  return !sys.DRY_RUN && !!sys.which("nginx") && exists("/etc/nginx/conf.d");
}

/**
 * Atomically install an nginx file, test the whole config, reload. On a
 * failed test the previous file (or nothing) is put back and the error thrown.
 * `content === null` removes the file. Returns { changed, file, tested }.
 */
export async function applyNginxFile(file, content, { log = NOOP, force = false } = {}) {
  const previous = exists(file) ? fs.readFileSync(file, "utf8") : null;
  if (content === previous && !force) return { changed: false, file, tested: false };
  ensureDir(path.dirname(file));
  if (content === null) {
    if (previous === null) return { changed: false, file, tested: false };
    fs.rmSync(file, { force: true });
  } else {
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, content, { mode: 0o644 });
    fs.renameSync(tmp, file);
  }
  const live = nginxIsLive() && file.startsWith("/etc/nginx/");
  if (!live) {
    log(`${content === null ? "Removed" : "Wrote"} ${file}${sys.DRY_RUN ? " (dry-run: nginx not tested or reloaded)" : " (nginx not installed: not loaded)"}`);
    return { changed: true, file, tested: false };
  }
  const test = await sys.run("nginx", ["-t"], { allowFail: true, timeoutMs: 30_000 });
  if (test.code !== 0) {
    if (previous === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, previous);
    const why = (test.stderr || test.stdout || "").trim().split("\n").filter((l) => /emerg|error|fail/i.test(l)).join("\n");
    const err = new Error(`nginx rejected the new configuration; the previous file was restored.\n${why || test.stderr}`);
    err.nginxTest = test.stderr;
    throw err;
  }
  await reloadNginx(log);
  log(`${content === null ? "Removed" : "Installed"} ${file}; nginx reloaded.`);
  return { changed: true, file, tested: true };
}

export async function reloadNginx(log = NOOP) {
  if (sys.which("systemctl")) {
    const r = await sys.run("systemctl", ["reload", "nginx"], { allowFail: true, timeoutMs: 30_000, log });
    if (r.code === 0) return;
    // not running yet → start it
    const s = await sys.run("systemctl", ["start", "nginx"], { allowFail: true, timeoutMs: 30_000, log });
    if (s.code === 0) return;
  }
  await sys.run("nginx", ["-s", "reload"], { timeoutMs: 30_000, log });
}

function vhostFile(spec, o) {
  const dir = nginxIsLive() ? "/etc/nginx/conf.d" : path.join(o.dataDir || defaultDataDir(), "nginx-local");
  return { dir, file: path.join(dir, `fcc-app-${spec.siteId}.conf`) };
}

function siteRoot(spec) {
  const s = spec.settings || {};
  if (s.root) {
    const r = path.resolve(spec.appDir, String(s.root));
    if (r === spec.appDir || r.startsWith(spec.appDir + path.sep)) return r;
  }
  if (spec.type === "php") {
    const pub = path.join(spec.appDir, "public");
    return exists(path.join(pub, "index.php")) ? pub : spec.appDir;
  }
  for (const d of ["dist", "build", "out", "public", "_site"]) {
    const p = path.join(spec.appDir, d);
    if (exists(path.join(p, "index.html"))) return p;
  }
  return spec.appDir;
}

/** php-fpm socket: the newest /run/php/php*-fpm.sock, else common fallbacks. */
export function phpFpmSocket() {
  for (const dir of ["/run/php", "/var/run/php"]) {
    try {
      const socks = fs
        .readdirSync(dir)
        .filter((f) => /^php[\d.]*-fpm\.sock$/.test(f))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      if (socks.length) return `unix:${path.join(dir, socks[0])}`;
    } catch {
      /* not there */
    }
  }
  for (const s of ["/run/php-fpm/www.sock", "/var/run/php-fpm.sock"]) if (exists(s)) return `unix:${s}`;
  return "127.0.0.1:9000";
}

/** null when php-fpm is not installed on this server. */
export function phpFpmSocketOrNull() {
  const s = phpFpmSocket();
  if (s.startsWith("unix:")) return s;
  return sys.which("php-fpm") || fs.readdirSync("/usr/sbin", { withFileTypes: true }).some?.((e) => /^php-fpm[\d.]*$/.test(e.name)) ? s : null;
}

function requirePhpFpm() {
  let ok = false;
  try {
    ok = !!phpFpmSocketOrNull();
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new Error(
      `PHP-FPM is not installed on ${os.hostname()}, so PHP sites cannot run here. ` +
        `Install it (on the main server: re-run the installer with FCC_PHP=1; on an Agent server: re-run its install command with FCC_PHP=1, or apt install php-fpm) and try again.`,
    );
  }
}

async function reloadPhpFpm(log) {
  const sock = phpFpmSocket();
  const m = /php([\d.]+)-fpm\.sock/.exec(sock);
  const unit = m ? `php${m[1]}-fpm` : "php-fpm";
  if (sys.which("systemctl")) await sys.run("systemctl", ["reload", unit], { allowFail: true, log, timeoutMs: 30_000 });
}

export function renderSiteVhost(spec, { isMain = false } = {}) {
  const root = siteRoot(spec);
  const s = spec.settings || {};
  const bind = isMain ? "127.0.0.1:" : "";
  const maxBody = /^\d+[kmg]?$/i.test(String(s.clientMaxBodySize || "")) ? s.clientMaxBodySize : "100m";
  const q = (v) => `"${String(v).replace(/["\\]/g, "\\$&")}"`;
  const lines = [
    `# Managed by Forthway Command Center — do not edit by hand.`,
    `# Local ${spec.type} vhost for site ${spec.name || ""} (${spec.siteId}); the front door on the main server proxies here.`,
    `server {`,
    `    listen ${bind}${spec.port};`,
    `    server_name _;`,
    `    root ${q(root)};`,
    `    index ${spec.type === "php" ? "index.php " : ""}index.html index.htm;`,
    `    access_log off;`,
    `    error_log /var/log/nginx/fcc-app-${spec.siteId}.error.log warn;`,
    `    client_max_body_size ${maxBody};`,
    `    server_tokens off;`,
    ``,
    `    # never serve dotfiles (.env, .git) — except ACME/well-known`,
    `    location ~ /\\.(?!well-known) { deny all; }`,
    `    location ~* ^/(\\.forthway|storage/logs|vendor|node_modules)/ { deny all; }`,
  ];
  if (spec.type === "php") {
    const fpm = s.phpFpm && /^(unix:\/[\w./-]+|[\w.-]+:\d+)$/.test(s.phpFpm) ? s.phpFpm : phpFpmSocket();
    lines.push(
      ``,
      `    location / {`,
      `        try_files $uri $uri/ /index.php?$query_string;`,
      `    }`,
      `    location ~ \\.php$ {`,
      `        try_files $uri =404;`,
      `        include fastcgi_params;`,
      `        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;`,
      `        fastcgi_param DOCUMENT_ROOT $realpath_root;`,
      `        fastcgi_pass ${fpm};`,
      `        fastcgi_read_timeout 300s;`,
      `    }`,
    );
  } else {
    lines.push(
      ``,
      `    location / {`,
      `        try_files $uri $uri/ ${s.spa ? "/index.html" : "$uri.html =404"};`,
      `    }`,
      `    location ~* \\.(?:css|js|mjs|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico)$ {`,
      `        expires 7d;`,
      `        add_header Cache-Control "public";`,
      `        try_files $uri =404;`,
      `    }`,
    );
  }
  lines.push(`}`, ``);
  return lines.join("\n");
}

async function writeSiteVhost(spec, o, { force = false } = {}) {
  const { file } = vhostFile(spec, o);
  ensureDir(spec.appDir);
  return applyNginxFile(file, renderSiteVhost(spec, { isMain: o.isMain }), { log: o.log, force });
}

async function removeSiteVhost(spec, o) {
  const { file } = vhostFile(spec, o);
  return applyNginxFile(file, null, { log: o.log });
}

// ------------------------------------------------------------------ dry run

const dryStates = new Map();
function dryState(siteId) {
  if (!dryStates.has(siteId)) dryStates.set(siteId, { running: false, version: null });
  return dryStates.get(siteId);
}

async function dryRunSite(type, spec, payload, o) {
  const { log } = o;
  const st = dryState(spec.siteId);
  const where = `${spec.appDir} (port ${spec.port}) on ${os.hostname()}`;
  const step = async (text) => {
    if (o.signal?.aborted) throw abortError();
    log(text);
    await new Promise((r) => setTimeout(r, 120));
  };
  switch (type) {
    case "site.deploy": {
      const rel = payload.release || {};
      await step(`── Download ──`);
      await step(`[dry-run] would download release ${rel.id || "?"} from ${rel.file || rel.url || "?"} and verify sha256 ${rel.sha256 ? rel.sha256.slice(0, 12) + "…" : "(none)"}`);
      await step(`── Build ──`);
      await step(`[dry-run] would unpack into ${where}, install and build (${spec.type})`);
      if (spec.type !== "node") await writeSiteVhost(spec, o);
      await step(`── Swap & restart ──`);
      await step(spec.type === "node" ? `[dry-run] pm2 start/restart ${pm2NameOf(spec)}` : `[dry-run] nginx serves ${siteRoot(spec)}`);
      await step(`── Health check ──`);
      await step(`[dry-run] ${healthUrlOf(spec)} → ok`);
      st.running = true;
      st.version = rel.version || st.version || "dry-run";
      return { running: true, healthy: true, version: st.version, dryRun: true, summary: { version: st.version, seconds: 1 } };
    }
    case "site.rollback":
      await step(`[dry-run] would restore the previous build snapshot in ${where}`);
      st.running = true;
      return { running: true, healthy: true, version: st.version, dryRun: true };
    case "site.start":
    case "site.restart":
      if (spec.type !== "node") await writeSiteVhost(spec, o);
      await step(`[dry-run] would ${type.split(".")[1]} ${spec.type === "node" ? `pm2 process ${pm2NameOf(spec)}` : "the nginx vhost"} for ${where}`);
      st.running = true;
      return { running: true, healthy: true, version: st.version, dryRun: true };
    case "site.stop":
      if (spec.type !== "node") await removeSiteVhost(spec, o);
      await step(`[dry-run] would stop ${spec.type === "node" ? `pm2 process ${pm2NameOf(spec)}` : "serving"} ${where}`);
      st.running = false;
      return { running: false, healthy: null, version: st.version, dryRun: true };
    case "site.env": {
      const n = Object.keys(payload.env || {}).length;
      await step(`[dry-run] would write ${n} variable(s) into ${path.join(spec.appDir, ".env")}`);
      return { written: false, keys: n, dryRun: true };
    }
    case "site.remove":
      if (spec.type !== "node") await removeSiteVhost(spec, o);
      await sys.run("pm2", ["delete", pm2NameOf(spec)], { log, allowFail: true });
      await step(payload.deleteFiles ? `[dry-run] would delete ${spec.appDir}` : `Files left in place at ${spec.appDir}`);
      dryStates.delete(spec.siteId);
      return { removed: true, deletedFiles: false, dryRun: true };
  }
  throw new Error(`Unknown task type "${type}"`);
}

// ------------------------------------------------------------------ metrics

let lastCpu = null; // { at, idle, total }

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { at: Date.now(), idle, total };
}

async function cpuPercent() {
  let prev = lastCpu;
  if (!prev || Date.now() - prev.at > 120_000) {
    prev = cpuTimes();
    await new Promise((r) => setTimeout(r, 500));
  }
  const now = cpuTimes();
  lastCpu = now;
  const dt = now.total - prev.total;
  if (dt <= 0) return 0;
  return round1(Math.max(0, Math.min(100, (1 - (now.idle - prev.idle) / dt) * 100)));
}

function memory() {
  const total = os.totalmem();
  try {
    const txt = fs.readFileSync("/proc/meminfo", "utf8");
    const m = /MemAvailable:\s+(\d+)\s*kB/.exec(txt);
    if (m) return { used: total - Number(m[1]) * 1024, total };
  } catch {
    /* not linux */
  }
  return { used: total - os.freemem(), total };
}

function disk(dir = "/") {
  try {
    const st = fs.statfsSync(dir);
    const total = st.blocks * st.bsize;
    return { used: total - st.bfree * st.bsize, total, free: st.bavail * st.bsize };
  } catch {
    return null;
  }
}

function dfDisk(dir = "/") {
  return new Promise((resolve) => {
    execFile("df", ["-kP", dir], { timeout: 5000 }, (err, out) => {
      if (err) return resolve(null);
      const cols = String(out).trim().split("\n").pop().split(/\s+/);
      const total = Number(cols[1]) * 1024;
      const used = Number(cols[2]) * 1024;
      resolve(Number.isFinite(total) ? { used, total, free: Number(cols[3]) * 1024 } : null);
    });
  });
}

let osName = null;
function osPretty() {
  if (osName) return osName;
  try {
    const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(fs.readFileSync("/etc/os-release", "utf8"));
    if (m) return (osName = m[1]);
  } catch {
    /* not linux */
  }
  return (osName = `${os.type()} ${os.release()} (${os.arch()})`);
}

const round1 = (n) => Math.round(n * 10) / 10;

/** { cpu %, mem bytes used, memTotal, disk bytes used, diskTotal, load (1m), uptime s, hostname, os, cpus, at } */
export async function collectMetrics() {
  const [cpu, d] = await Promise.all([cpuPercent(), Promise.resolve(disk("/")).then((x) => x || dfDisk("/"))]);
  const m = memory();
  const [l1, l5, l15] = os.loadavg();
  return {
    cpu,
    mem: m.used,
    memTotal: m.total,
    disk: d?.used ?? null,
    diskTotal: d?.total ?? null,
    load: Math.round(l1 * 100) / 100,
    loadavg: [l1, l5, l15].map((n) => Math.round(n * 100) / 100),
    cpus: os.cpus().length,
    uptime: Math.round(os.uptime()),
    hostname: os.hostname(),
    os: osPretty(),
    node: process.version,
    at: new Date().toISOString(),
  };
}

/** Static facts sent in the agent hello / main record. */
export function systemInfo() {
  const d = disk("/");
  return {
    hostname: os.hostname(),
    os: osPretty(),
    arch: os.arch(),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model || null,
    memTotal: os.totalmem(),
    diskTotal: d?.total ?? null,
    node: process.version,
  };
}

// ------------------------------------------------------------------- backup

/**
 * include: { panel, sites, nginx, paths: [...] } or an array of absolute paths.
 *   panel  → dataDir (main only; the backups directory itself is excluded)
 *   sites  → /srv/fcc/sites (+ payload.appDirs)
 *   nginx  → /etc/nginx and /etc/letsencrypt
 * Main: the archive is written to payload.file or dataDir/backups/. Agent
 * servers: written to a temp file, uploaded via opts.uploadFile, then deleted.
 */
async function serverBackup(payload, o) {
  const { log, signal } = o;
  const inc = payload.include ?? { sites: true, nginx: true };
  const paths = new Set();
  if (Array.isArray(inc)) inc.forEach((p) => paths.add(p));
  else {
    if (inc.panel && o.isMain) paths.add(o.dataDir);
    if (inc.sites) {
      paths.add(payload.sitesDir || process.env.FCC_SITES_DIR || "/srv/fcc/sites");
      for (const d of payload.appDirs || []) paths.add(d);
    }
    if (inc.nginx) {
      paths.add("/etc/nginx");
      paths.add("/etc/letsencrypt");
    }
    for (const p of inc.paths || []) paths.add(p);
  }
  const list = [...paths]
    .filter((p) => typeof p === "string" && path.isAbsolute(p) && path.resolve(p) !== "/")
    .map((p) => path.resolve(p));
  const present = list.filter((p) => exists(p));
  for (const p of list) if (!present.includes(p)) log(`(skipping ${p} — not on this server)`);
  if (!present.length && !sys.DRY_RUN) throw new Error("Nothing to back up: none of the selected paths exist on this server.");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
  const name = payload.file ? path.basename(payload.file) : `server-${o.serverId || (o.isMain ? "main" : os.hostname())}-${stamp}.tar.gz`;
  const localFile = o.isMain && payload.file && path.isAbsolute(payload.file)
    ? payload.file
    : path.join(o.uploadFile ? path.join(o.dataDir, "tmp") : path.join(o.dataDir, "backups"), name);
  ensureDir(path.dirname(localFile));

  log(`Archiving ${present.join(", ") || "(nothing)"} → ${localFile}`);
  const backupsDir = path.join(o.dataDir, "backups");
  const excludes = [
    backupsDir,
    path.join(o.dataDir, "tmp"),
    "*/.forthway/staging",
    "*/.forthway/previous",
    "*/.forthway/downloads",
  ].map((e) => `--exclude=${e.replace(/^\//, "")}`);
  const rel = present.map((p) => p.replace(/^\//, ""));

  if (sys.DRY_RUN) {
    await sys.run("tar", ["-czf", localFile, ...excludes, "-C", "/", ...rel], { log, signal });
    writeDryRunTarGz(localFile, `Dry-run server backup.\nWould have archived:\n${list.join("\n")}\n`);
  } else {
    const r = await sys.run("tar", ["-czf", localFile, ...excludes, "-C", "/", ...rel], {
      log,
      signal,
      allowFail: true,
      timeoutMs: 6 * 60 * 60_000,
    });
    // GNU tar exits 1 for "file changed as we read it" — the archive is still usable.
    if (r.code !== 0 && r.code !== 1) {
      fs.rmSync(localFile, { force: true });
      if (signal?.aborted) throw abortError();
      throw new Error(`tar failed (exit ${r.code}): ${(r.stderr || "").trim().split("\n").slice(-3).join(" ")}`);
    }
  }
  const size = fs.statSync(localFile).size;
  const sha256 = await sha256File(localFile);
  log(`Archive ready: ${(size / 1048576).toFixed(1)} MB, sha256 ${sha256.slice(0, 16)}…`);

  if (o.uploadFile) {
    log("Uploading the archive to the panel…");
    try {
      const up = await o.uploadFile(localFile, { name, size, sha256 });
      log(`Uploaded (${up?.file || "ok"}).`);
      return { file: up?.file || null, size: up?.size ?? size, sha256: up?.sha256 || sha256, paths: present };
    } finally {
      fs.rmSync(localFile, { force: true });
    }
  }
  return { file: localFile, size, sha256, paths: present };
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

/** A real (tiny) tar.gz with one text file, so dry-run backups can be downloaded and opened. */
function writeDryRunTarGz(file, text) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(512, 0);
  const put = (str, off, len) => header.write(str, off, len, "ascii");
  const oct = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
  put("DRY-RUN.txt", 0, 100);
  put(oct(0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(body.length, 12), 124, 12);
  put(oct(Math.floor(Date.now() / 1000), 12), 136, 12);
  put("        ", 148, 8);
  put("0", 156, 1);
  put("ustar\u000000", 257, 8);
  let sum = 0;
  for (const b of header) sum += b;
  put(oct(sum, 7) + " ", 148, 8);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
  const tar = Buffer.concat([header, body, pad, Buffer.alloc(1024, 0)]);
  fs.writeFileSync(file, zlib.gzipSync(tar));
}
