/**
 * The deploy engine.
 *
 * This is the part that actually touches an app: unpack a release, install
 * and build it in a staging directory, swap it into place, restart it, prove
 * it came back, and roll back if it did not.
 *
 * It is deliberately unaware of where it is running. The Command Center uses
 * it directly for sites on its own machine, and the remote agent wraps it for
 * sites on other machines. Same code path either way, so a local site and a
 * remote one behave identically and there is only one place to fix a bug.
 *
 * Everything it needs from the outside:
 *   settings     — the site's configuration (see defaultSettings)
 *   log          — { line(text), setStep(name) }
 *   getArtifact  — async (releaseId) => Buffer of the release zip
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

import { extractZip, inspectZip } from "./zip.mjs";
import { ensureDir, rmrf, exists, readJson, writeJson, mirror, copyDir, hardlinkDir, makeMatcher, sha1File, humanBytes, walk } from "./fsx.mjs";
import { makeZip } from "./zipwrite.mjs";
import { mergeEnvFile, shadowedKeys, lintEnv } from "./env.mjs";

export const ENGINE_VERSION = "2.0.0";
// "none": there is no app process to manage (static / php sites served by
// nginx + php-fpm). Stop/start/restart are no-ops; deploy is unpack + swap.
export const RESTART_MODES = ["pm2", "systemd", "command", "child", "none"];

export function defaultSettings() {
  return {
    appDir: "",
    port: null, // the port the app listens on — drives the URLs below and PORT

    restart: {
      mode: "pm2", // pm2 | systemd | command | child
      service: "", // pm2 process name, or systemd unit name
      useSudo: false, // systemd only
      pm2Start: "", // used to register the process the first time pm2 sees it
      stop: "", // command mode
      start: "", // command mode / child mode
      env: {}, // extra environment for the app
    },

    healthUrl: "",
    versionUrl: "",
    healthCheck: true, // false: never probe a health URL (no derived default either)
    versionCheck: true, // false: never probe a version URL
    healthTimeoutMs: 180000,
    stopGraceMs: 10000,

    build: {
      install: "npm install --no-audit --no-fund",
      prepare: "", // e.g. npx prisma generate — auto-detected when blank
      build: "npm run build",
      artifact: "", // a path that must exist after a successful build
    },

    swapDirs: ["node_modules", ".next"],
    preserve: [".env", ".env.local", ".env.production", ".env.production.local", "public/uploads", "uploads", "logs"],

    smartInstall: true,
    autoRollback: true,
    autoPrepare: true,
    // Passing variables through the process environment reaches the running
    // app but not the tools that read a .env file for themselves — prisma
    // generate, prisma migrate, next build. So they are written there too.
    writeEnvFile: true,
    // Create appDir when it does not exist yet (a brand new site on a server).
    createAppDir: false,
  };
}

/** Fill in anything missing, so a partial settings object is always safe. */
export function withDefaults(input) {
  const d = defaultSettings();
  const s = input || {};
  return {
    ...d,
    ...s,
    restart: { ...d.restart, ...(s.restart || {}) },
    build: { ...d.build, ...(s.build || {}) },
    swapDirs: s.swapDirs?.length ? s.swapDirs : d.swapDirs,
    preserve: s.preserve?.length ? s.preserve : d.preserve,
  };
}

const NOOP_LOG = { line() {}, setStep() {} };

export class Deployer {
  constructor({ settings, log = NOOP_LOG, getArtifact, workDirName = ".forthway" } = {}) {
    this.log = log;
    this.getArtifact = getArtifact;
    this.workDirName = workDirName;
    this.child = null;
    this.childWantsRun = false;
    // Set while a job is being abandoned on purpose, so the step that is
    // running stops and the ones after it never start.
    this.aborted = null;
    this.jobChild = null; // the command a job is running right now
    this.childRestartTimer = null;
    this.childOutput = [];
    this.onChildOutput = null;
    this.setSettings(settings);
  }

  setSettings(settings) {
    this.S = withDefaults(settings);
    this.paths = this.S.appDir ? this._derivePaths(this.S.appDir) : null;
    return this.S;
  }

  _derivePaths(appDir) {
    const app = path.resolve(appDir);
    const work = path.resolve(app, this.workDirName);
    ensureDir(work);
    const workRel = path.relative(app, work).split(path.sep).join("/") || this.workDirName;
    return {
      appDir: app,
      workDir: work,
      staging: path.join(work, "staging"),
      previous: path.join(work, "previous"),
      manifest: path.join(work, "manifest.json"),
      downloads: ensureDir(path.join(work, "downloads")),
      buildInfo: path.join(app, "build-info.json"),
      protect: makeMatcher([...this.S.preserve, workRel]),
      skip: makeMatcher([...this.S.swapDirs, workRel, ".git", "*.log"]),
    };
  }

  _require(log) {
    if (!this.S.appDir) {
      throw new Error("No app directory is set for this site. Open its settings and fill that in first.");
    }
    if (!exists(this.S.appDir) && this.S.createAppDir) {
      ensureDir(this.S.appDir);
      log?.line?.(`Created the app directory ${this.S.appDir}.`);
    }
    if (!exists(this.S.appDir)) {
      throw new Error(`The app directory ${this.S.appDir} does not exist on this machine.`);
    }
    if (!this.paths) this.paths = this._derivePaths(this.S.appDir);
    return this.paths;
  }

  // ------------------------------------------------------------- commands

  /**
   * Run a command, streaming its output into the job log so the operator can
   * watch it happen. Rejects on a non-zero exit so a failed build stops the
   * deploy right there.
   */
  run(cmd, { cwd, log = this.log, env = {}, unsetEnv = [], timeoutMs = 30 * 60_000, allowFail = false } = {}) {
    // Asked to stop between two commands: do not start another one.
    if (this.aborted) return Promise.reject(abortError(this.aborted));
    // `unsetEnv` is applied last, so a key the site's own variables set (e.g.
    // NODE_ENV=production) cannot sneak back in after the caller removed it.
    const childEnv = { ...process.env, ...this._appEnv(), ...env };
    for (const key of unsetEnv) delete childEnv[key];
    return new Promise((resolve, reject) => {
      log?.line(`$ ${cmd}`);
      const child = spawn(cmd, {
        cwd: cwd || this.S.appDir || process.cwd(),
        shell: true,
        detached: true, // own process group, so a timeout can kill the whole tree
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.jobChild = child;
      let out = "";
      const onData = (chunk) => {
        const text = chunk.toString();
        out += text;
        if (out.length > 400_000) out = out.slice(-200_000);
        log?.line(text.replace(/\n$/, ""));
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);

      const timer = setTimeout(() => {
        log?.line(`!! timed out after ${Math.round(timeoutMs / 1000)}s — killing`);
        signalGroup(child, "SIGKILL");
      }, timeoutMs);

      let settled = false;
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.jobChild === child) this.jobChild = null;
        reject(this.aborted ? abortError(this.aborted) : err);
      });
      const done = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.jobChild === child) this.jobChild = null;
        // A command that died because we killed it did not "fail" — saying so
        // would bury the reason under an exit code nobody can interpret.
        if (this.aborted) return reject(abortError(this.aborted));
        if (code === 0 || allowFail) resolve({ code, output: out });
        else reject(new Error(`Command failed (exit ${code}): ${cmd}`));
      };
      child.on("close", done);
      // Fall back to 'exit' in case a background grandchild holds the pipes open.
      child.on("exit", (code) => setTimeout(() => done(code), 300));
    });
  }

  _appEnv() {
    const env = { ...(this.S.restart.env || {}) };
    if (this.S.port) env.PORT = String(this.S.port);
    return env;
  }

  /**
   * Write this site's variables into the app's .env, inside a marked block.
   *
   * The process environment is not enough on its own. `prisma generate` reads
   * .env for itself, so does `prisma migrate`, and so does `next build` — a
   * variable that exists only in the environment of the restart command is
   * invisible to all three. Worse, it fails late and confusingly: the build
   * succeeds and the app dies on its first query.
   *
   * Everything the panel owns lives between two markers, so a hand-written
   * .env keeps its own lines and only the managed block is rewritten. PORT is
   * deliberately not included: it already reaches the app through the process
   * environment, and a second copy in a file is one more place for the two to
   * disagree.
   */
  writeEnvFile(dir, log = this.log) {
    if (this.S.writeEnvFile === false) return null;
    const env = { ...(this.S.restart.env || {}) };
    if (!Object.keys(env).length) return null;
    if (!dir || !exists(dir)) return null;

    const file = path.join(dir, ".env");
    const current = exists(file) ? fs.readFileSync(file, "utf8") : "";

    // Say the awkward things out loud rather than letting them be discovered
    // at 1am in a stack trace.
    for (const note of lintEnv(env)) log?.line(`.env: ${note}`);
    const shadowed = shadowedKeys(current, env);
    if (shadowed.length) {
      log?.line(
        `.env: ${shadowed.join(", ")} ${shadowed.length === 1 ? "is" : "are"} also set outside the managed ` +
          `block in this file. The panel's value wins, because the block is written last.`,
      );
    }

    const next = mergeEnvFile(current, env);
    if (next === null) return file; // already correct — leave the mtime alone
    fs.writeFileSync(file, next, { mode: 0o600 });
    const n = Object.keys(env).length;
    log?.line(`Wrote ${n} variable${n === 1 ? "" : "s"} into ${file}.`);
    return file;
  }

  // ------------------------------------------------------ process control

  _pm2Name() {
    const name = this.S.restart.service;
    if (!name) throw new Error('Restart mode is "pm2" but no pm2 process name is set for this site.');
    return JSON.stringify(name);
  }

  _systemdUnit(verb) {
    const unit = this.S.restart.service;
    if (!unit) throw new Error('Restart mode is "systemd" but no service name is set for this site.');
    return `${this.S.restart.useSudo ? "sudo " : ""}systemctl ${verb} ${JSON.stringify(unit)}`;
  }

  /** Is pm2 already tracking this process? */
  async _pm2Known(log) {
    const r = await this.run(`pm2 describe ${this._pm2Name()}`, { log: NOOP_LOG, timeoutMs: 20_000, allowFail: true });
    return r.code === 0;
  }

  startChild(log = this.log) {
    if (this.S.restart.mode !== "child") return;
    this.childWantsRun = true;
    if (this.child) return;
    const cmd = this.S.restart.start || "npm start";
    log?.line(`$ (supervised) ${cmd}`);
    // detached:true puts the app in its own process group. shell:true means the
    // direct child is /bin/sh, and signalling the shell does NOT reach the node
    // process underneath it — so we signal the whole group instead.
    const proc = spawn(cmd, {
      cwd: this.S.appDir,
      shell: true,
      detached: true,
      env: { ...process.env, NODE_ENV: "production", ...this._appEnv() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = proc;
    const pipe = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      this.childOutput.push(text);
      if (this.childOutput.length > 400) this.childOutput.splice(0, this.childOutput.length - 400);
      this.onChildOutput?.(text);
    };
    proc.stdout.on("data", pipe);
    proc.stderr.on("data", pipe);
    proc.once("exit", (code) => {
      log?.line(`app process exited with code ${code}`);
      if (this.child === proc) this.child = null;
      if (this.childWantsRun) {
        // Crash-loop guard: wait before respawning, so a broken build does not
        // spin the CPU.
        this.childRestartTimer = setTimeout(() => this.startChild(), 3000);
        this.childRestartTimer.unref?.();
      }
    });
  }

  stopChild(log = this.log) {
    return new Promise((resolve) => {
      this.childWantsRun = false;
      if (this.childRestartTimer) clearTimeout(this.childRestartTimer);
      if (!this.child) return resolve();
      log?.line("stopping the app process…");
      const proc = this.child;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(hardKill);
        clearTimeout(giveUp);
        this.child = null;
        resolve();
      };
      // 'exit' fires when the process dies; 'close' waits for its stdio pipes,
      // which a stray grandchild can hold open forever. Listen for both.
      proc.once("exit", () => setTimeout(finish, 150));
      proc.once("close", finish);

      const graceMs = this.S.stopGraceMs ?? 10_000;
      const hardKill = setTimeout(() => {
        log?.line(`the app did not exit in ${Math.round(graceMs / 1000)}s — sending SIGKILL`);
        signalGroup(proc, "SIGKILL");
      }, graceMs);
      const giveUp = setTimeout(() => {
        log?.line("the app process would not die — carrying on anyway");
        finish();
      }, graceMs + 8_000);

      if (!signalGroup(proc, "SIGTERM")) finish();
    });
  }

  async stopApp(log = this.log) {
    switch (this.S.restart.mode) {
      case "none":
        return;
      case "child":
        return this.stopChild(log);
      case "pm2":
        return this.run(`pm2 stop ${this._pm2Name()}`, { log, timeoutMs: 120_000, allowFail: true });
      case "systemd":
        return this.run(this._systemdUnit("stop"), { log, timeoutMs: 120_000, allowFail: true });
      default:
        if (this.S.restart.stop) await this.run(this.S.restart.stop, { log, timeoutMs: 120_000, allowFail: true });
    }
  }

  async startApp(log = this.log) {
    switch (this.S.restart.mode) {
      case "none":
        return;
      case "child":
        this.startChild(log);
        return;
      case "pm2": {
        // The first time round pm2 has never heard of this process, so start
        // it from the command instead of by name.
        if (!(await this._pm2Known(log))) {
          const boot = this.S.restart.pm2Start || this.S.restart.start;
          if (!boot) {
            throw new Error(
              `pm2 does not know a process called ${this.S.restart.service}. Set the "first start command" ` +
                `in this site's settings (for example: npm start) so it can be registered.`,
            );
          }
          log?.line(`pm2 has not seen ${this.S.restart.service} before — registering it.`);
          const envPrefix = this.S.port ? `PORT=${this.S.port} ` : "";
          return this.run(`${envPrefix}pm2 start ${JSON.stringify(boot)} --name ${this._pm2Name()}`, {
            log,
            cwd: this.S.appDir,
            timeoutMs: 120_000,
          });
        }
        return this.run(`pm2 start ${this._pm2Name()} --update-env`, { log, timeoutMs: 120_000 });
      }
      case "systemd":
        return this.run(this._systemdUnit("start"), { log, timeoutMs: 120_000 });
      default:
        if (this.S.restart.start) await this.run(this.S.restart.start, { log, timeoutMs: 120_000 });
    }
  }

  async restartApp(log = this.log) {
    if (this.S.restart.mode === "none") return;
    if (this.S.restart.mode === "pm2" && (await this._pm2Known(log))) {
      return this.run(`pm2 restart ${this._pm2Name()} --update-env`, { log, timeoutMs: 120_000 });
    }
    if (this.S.restart.mode === "systemd") return this.run(this._systemdUnit("restart"), { log, timeoutMs: 120_000 });
    await this.stopApp(log);
    await sleep(800);
    await this.startApp(log);
  }

  /** Is the app process there at all, regardless of whether it is healthy? */
  async appRunning() {
    try {
      if (this.S.restart.mode === "child") return !!this.child;
      if (this.S.restart.mode === "pm2" && this.S.restart.service) {
        const r = await this.run(
          `pm2 jlist`,
          { log: NOOP_LOG, timeoutMs: 15_000, allowFail: true },
        );
        if (r.code !== 0) return null;
        const list = JSON.parse(r.output.slice(r.output.indexOf("[")));
        const proc = list.find((p) => p.name === this.S.restart.service);
        return proc ? proc.pm2_env?.status === "online" : false;
      }
      if (this.S.restart.mode === "systemd" && this.S.restart.service) {
        const r = await this.run(`systemctl is-active ${JSON.stringify(this.S.restart.service)}`, {
          log: NOOP_LOG,
          timeoutMs: 10_000,
          allowFail: true,
        });
        return r.output.trim().startsWith("active");
      }
    } catch {
      return null;
    }
    return null;
  }

  // ------------------------------------------------------- health/version

  async checkHealth() {
    const url = this.healthUrl();
    if (!url) return { ok: null, note: "no health URL configured" };
    const started = Date.now();
    try {
      const r = await fetchJson(url, 8000);
      return { ok: r.ok, status: r.status, latencyMs: Date.now() - started, checkedAt: new Date().toISOString() };
    } catch (err) {
      return { ok: false, error: err.message, latencyMs: Date.now() - started, checkedAt: new Date().toISOString() };
    }
  }

  /** An explicit URL wins; otherwise derive one from the site's port. */
  healthUrl() {
    if (this.S.healthCheck === false) return "";
    if (this.S.healthUrl) return this.S.healthUrl;
    return this.S.port ? `http://127.0.0.1:${this.S.port}/api/health` : "";
  }

  versionUrl() {
    if (this.S.versionCheck === false || this.S.healthCheck === false) return "";
    if (this.S.versionUrl) return this.S.versionUrl;
    return this.S.port ? `http://127.0.0.1:${this.S.port}/api/version` : "";
  }

  async waitForHealthy(log = this.log, timeoutMs = this.S.healthTimeoutMs) {
    const url = this.healthUrl();
    if (!url) {
      log?.line(
        this.S.healthCheck === false
          ? "Health check is off for this site — skipping it."
          : "No health URL and no port configured — skipping the health check.",
      );
      return { ok: null };
    }
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    log?.line(`Waiting for ${url} to respond…`);
    while (Date.now() < deadline) {
      attempt++;
      const h = await this.checkHealth();
      if (h.ok) {
        log?.line(`Healthy after ${attempt} check${attempt === 1 ? "" : "s"} (${h.latencyMs}ms).`);
        return h;
      }
      if (attempt % 5 === 0) {
        log?.line(`…still waiting (${Math.round((deadline - Date.now()) / 1000)}s left) — ${h.status || h.error}`);
      }
      await sleep(2000);
    }
    log?.line(`!! The app did not become healthy within ${Math.round(timeoutMs / 1000)}s.`);
    return { ok: false, error: "health check timed out", checkedAt: new Date().toISOString() };
  }

  /**
   * When the app does not answer, "fetch failed" is useless on its own — the
   * reason is in the app's own output, which pm2 and systemd capture where the
   * operator cannot see it. Pull it into the job log so the failure explains
   * itself instead of just timing out.
   */
  async dumpAppLog(log, lines = 60) {
    if (!log) return;
    try {
      log.setStep?.("App log");
      log.line("The app did not answer. This is its own output:");
      const mode = this.S.restart.mode;
      if (mode === "pm2" && this.S.restart.service) {
        await this.run(`pm2 logs ${this._pm2Name()} --lines ${lines} --nostream`, {
          log,
          timeoutMs: 45_000,
          allowFail: true,
        });
      } else if (mode === "systemd" && this.S.restart.service) {
        const sudo = this.S.restart.useSudo ? "sudo " : "";
        await this.run(`${sudo}journalctl -u ${JSON.stringify(this.S.restart.service)} -n ${lines} --no-pager`, {
          log,
          timeoutMs: 45_000,
          allowFail: true,
        });
      } else if (mode === "none") {
        log.line("(no app process for this site type — check the web server's error log)");
      } else if (mode === "child") {
        const tail = this.childOutput.slice(-lines).join("");
        log.line(tail.trim() || "(the supervised process produced no output)");
      } else {
        log.line("(no log source for this restart mode — check the app's own logging)");
      }
    } catch (err) {
      log.line(`(could not read the app log: ${err.message})`);
    }
  }

  /** What the files on disk say. */
  readDeployedInfo() {
    if (!this.S.appDir || !exists(this.S.appDir)) return null;
    const p = this.paths || this._derivePaths(this.S.appDir);
    const info = readJson(p.buildInfo, null);
    const pkg = readJson(path.join(p.appDir, "package.json"), null);
    if (!info && !pkg) return null;
    return {
      version: info?.version ?? pkg?.version ?? null,
      name: pkg?.name ?? null,
      releaseId: info?.releaseId ?? null,
      deployedAt: info?.deployedAt ?? null,
      zipName: info?.zipName ?? null,
      buildMode: info?.buildMode ?? null,
      source: info ? "build-info.json" : "package.json",
    };
  }

  /** What the running process says — proof that a restart actually took. */
  async readServingInfo() {
    const url = this.versionUrl();
    if (!url) return null;
    try {
      const r = await fetchJson(url, 5000);
      if (!r.ok || !r.json) return null;
      return {
        version: r.json.version ?? null,
        releaseId: r.json.releaseId ?? null,
        deployedAt: r.json.deployedAt ?? null,
        startedAt: r.json.startedAt ?? null,
        uptimeSeconds: r.json.uptimeSeconds ?? null,
        checkedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  /**
   * A health check alone is not proof that the restart worked. If the old
   * process never died (a stop that silently failed, a stale pid file), the
   * new one cannot bind the port, exits, and the OLD process keeps answering
   * health checks perfectly. Confirm the version too.
   */
  async waitForVersion(expected, log = this.log, timeoutMs = 60_000) {
    if (!this.versionUrl() || !expected) return { confirmed: null };
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      const serving = await this.readServingInfo();
      last = serving;
      if (serving?.version === expected) return { confirmed: true, serving };
      if (serving == null) return { confirmed: null }; // no version route deployed yet
      await sleep(2000);
    }
    log?.line(
      `!! The app is answering, but it is still serving version ${last?.version ?? "?"} instead of ${expected}. ` +
        `The old process probably never shut down.`,
    );
    return { confirmed: false, serving: last };
  }

  listMigrationScripts() {
    if (!this.S.appDir) return [];
    try {
      return fs
        .readdirSync(this.S.appDir)
        .filter((f) => /^runmig[\w.-]*\.(cjs|mjs|js)$/i.test(f))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    } catch {
      return [];
    }
  }

  runtimeInfo() {
    return {
      host: os.hostname(),
      platform: `${os.platform()} ${os.arch()}`,
      node: process.version,
      appDir: this.S.appDir || null,
      restartMode: this.S.restart.mode,
      port: this.S.port || null,
      disk: this.S.appDir ? diskFree(this.S.appDir) : null,
      loadavg: os.loadavg().map((n) => Number(n.toFixed(2))),
      uptimeSeconds: Math.round(os.uptime()),
      totalMemBytes: os.totalmem(),
      freeMemBytes: os.freemem(),
    };
  }

  /** Everything the dashboard wants to know, in one call. */
  async status() {
    const [serving, health, running] = await Promise.all([
      this.readServingInfo().catch(() => null),
      this.checkHealth().catch(() => null),
      this.appRunning().catch(() => null),
    ]);
    return {
      deployed: this.readDeployedInfo(),
      serving,
      health,
      appRunning: running ?? health?.ok ?? null,
      migrations: this.listMigrationScripts(),
      runtime: this.runtimeInfo(),
    };
  }

  // --------------------------------------------------------- deploy steps

  _writeBuildInfo(dir, { version, releaseId, zipName, buildMode }) {
    writeJson(path.join(dir, "build-info.json"), {
      version: version ?? null,
      releaseId: releaseId ?? null,
      zipName: zipName ?? null,
      buildMode: buildMode ?? null,
      deployedAt: new Date().toISOString(),
      deployedBy: "forthway-command-center",
      engineVersion: ENGINE_VERSION,
    });
  }

  /** Carry over the files a build needs but an archive should never hold. */
  _seedPreserved(p, log) {
    let n = 0;
    for (const rel of this.S.preserve) {
      const src = path.join(p.appDir, rel);
      if (!exists(src)) continue;
      const dest = path.join(p.staging, rel);
      if (exists(dest)) continue;
      const st = fs.statSync(src);
      if (st.isDirectory()) copyDir(src, dest);
      else {
        ensureDir(path.dirname(dest));
        fs.copyFileSync(src, dest);
      }
      n++;
      log?.line(`carried over ${rel}`);
    }
    return n;
  }

  /**
   * Zip a freshly built tree so the other servers of a load-balanced site can
   * deploy exactly these files instead of building their own (separate builds
   * get different chunk hashes, build IDs and Server Action IDs).
   *
   * Left out: what every server makes or keeps for itself — dependencies (each
   * installs them from the lockfile), the engine's work folder, .env files,
   * the preserve list (uploads, logs) and Next.js's build cache.
   */
  packageBuild(dir, file, log = this.log) {
    const excluded = ["node_modules", this.workDirName, ".git", ".next/cache", "build-info.json", ...this.S.preserve];
    const byPath = makeMatcher(excluded);
    const skip = (rel) => byPath(rel) || /(^|\/)\.env(\.[^/]*)?$/.test(rel) || /\.log$/.test(rel);
    const MAX_FILES = 65_000; // no zip64 in shared/zipwrite.mjs
    const MAX_BYTES = 2 * 1024 ** 3;
    const entries = [];
    let bytes = 0;
    for (const rel of walk(dir, { skip })) {
      const abs = path.join(dir, rel);
      let st;
      try {
        st = fs.statSync(abs); // follows symlinks; a link to a directory is skipped
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      bytes += st.size;
      if (entries.length >= MAX_FILES || bytes > MAX_BYTES) {
        throw new Error(`the build is too big to package (more than ${MAX_FILES} files or ${humanBytes(MAX_BYTES)})`);
      }
      entries.push({ name: rel, data: fs.readFileSync(abs), mode: st.mode & 0o777 });
    }
    if (!entries.length) throw new Error("there is nothing to package");
    const buf = makeZip(entries);
    ensureDir(path.dirname(file));
    const part = `${file}.part`;
    fs.writeFileSync(part, buf, { mode: 0o600 });
    fs.renameSync(part, file);
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    log?.line(
      `Packaged the build for the other servers: ${entries.length} files, ${humanBytes(buf.length)} ` +
        `(left out: node_modules, .env files, ${excluded.filter((x) => !["node_modules", ".env"].includes(x)).join(", ")}).`,
    );
    return { file, size: buf.length, sha256, fileCount: entries.length };
  }

  async _buildStaging(p, job, log, zipInfo) {
    // Before anything reads it: prisma generate and next build both look for
    // a .env in the directory they are run from, which is staging.
    this.writeEnvFile(p.staging, log);

    const hashIf = (f) => (exists(f) ? sha1File(f) : null);
    const liveLock = hashIf(path.join(p.appDir, "package-lock.json"));
    const newLock = hashIf(path.join(p.staging, "package-lock.json"));
    const livePkg = hashIf(path.join(p.appDir, "package.json"));
    const newPkg = hashIf(path.join(p.staging, "package.json"));
    const liveSchema = hashIf(path.join(p.appDir, "prisma/schema.prisma"));
    const newSchema = hashIf(path.join(p.staging, "prisma/schema.prisma"));

    let depsUnchanged = false;

    // --- dependencies ---------------------------------------------------
    if (this.S.build.install) {
      log.setStep("Dependencies");
      const liveModules = path.join(p.appDir, "node_modules");
      let seeded = false;
      if (exists(liveModules)) {
        const t0 = Date.now();
        const r = hardlinkDir(liveModules, path.join(p.staging, "node_modules"));
        seeded = true;
        log.line(
          `Seeded node_modules from the running app: ${r.total} files ` +
            `(${r.linked} linked, ${r.copied} copied) in ${Date.now() - t0}ms.`,
        );
      } else {
        log.line("No existing node_modules — this will be a full install.");
      }
      depsUnchanged = seeded && !!liveLock && liveLock === newLock && livePkg === newPkg;
      if (depsUnchanged && !/--omit[= ]dev|--production|--only[= ]prod/.test(this.S.build.install)) {
        // A node_modules installed without devDependencies (an older engine,
        // NODE_ENV=production) must not be reused as-is: the build needs them.
        let missing = [];
        try {
          const dev = JSON.parse(fs.readFileSync(path.join(p.staging, "package.json"), "utf8")).devDependencies || {};
          missing = Object.keys(dev).filter((name) => !exists(path.join(p.staging, "node_modules", name, "package.json")));
        } catch {
          /* unreadable package.json: leave the decision to the lockfile check */
        }
        if (missing.length) {
          log.line(`node_modules lacks development dependencies (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}) — installing again.`);
          depsUnchanged = false;
        }
      }
      if (depsUnchanged && this.S.smartInstall) {
        log.line("package.json and the lockfile are unchanged — skipping the install step.");
      } else {
        // NODE_ENV must NOT be "production" here or npm drops devDependencies
        // (typescript, prisma, tailwindcss, bundlers) and the build fails. The
        // site's own variables usually set it, so it is removed after they are
        // merged, and npm is told outright to include dev dependencies.
        await this.run(this.S.build.install, {
          cwd: p.staging,
          log,
          // (Not NPM_CONFIG_PRODUCTION=false: npm 8+ ignores it apart from
          // printing a misleading "Use `--omit=dev` instead" warning.)
          env: { NPM_CONFIG_INCLUDE: "dev" },
          unsetEnv: ["NODE_ENV", "npm_config_production", "NPM_CONFIG_PRODUCTION", "npm_config_omit", "NPM_CONFIG_OMIT"],
          timeoutMs: 20 * 60_000,
        });
      }
    } else {
      log.line("No install command configured — skipping dependencies.");
    }

    // --- prepare (prisma generate, codegen, …) --------------------------
    let prepareCmd = this.S.build.prepare;
    if (!prepareCmd && this.S.autoPrepare && exists(path.join(p.staging, "prisma/schema.prisma"))) {
      prepareCmd = "npx prisma generate";
      log.line("Found prisma/schema.prisma — generating the client.");
    }
    if (prepareCmd) {
      if (liveSchema !== newSchema || !depsUnchanged || this.S.build.prepare) {
        log.setStep("Prepare");
        await this.run(prepareCmd, { cwd: p.staging, log, timeoutMs: 10 * 60_000 });
      } else {
        log.line("Nothing the prepare step depends on has changed — skipping it.");
      }
    }

    // --- build ----------------------------------------------------------
    log.setStep("Build");
    // job.prebuilt: the panel says outright that this archive is a build made
    // on another server of the same site (build once, ship everywhere). That
    // covers builds the .next/BUILD_ID heuristic cannot see (dist/, out/ …).
    if ((zipInfo.prebuilt || job.prebuilt) && !job.forceBuild) {
      log.line(
        job.prebuilt
          ? `The archive is the build made on ${job.builtOn || "the first server"} — using it as-is, so every server serves identical files.`
          : "The archive already contains a compiled build — using it as-is.",
      );
      return "prebuilt";
    }
    if (job.skipBuild) {
      log.line("Build skipped by request.");
      return "skipped";
    }
    if (!this.S.build.build) {
      log.line("No build command configured — nothing to build.");
      return "none";
    }
    await this.run(this.S.build.build, { cwd: p.staging, log, timeoutMs: 30 * 60_000 });
    if (this.S.build.artifact && !exists(path.join(p.staging, this.S.build.artifact))) {
      throw new Error(
        `The build finished but ${this.S.build.artifact} is missing — refusing to deploy a broken build.`,
      );
    }
    return "built";
  }

  /** Move the live app aside so a failed deploy can be undone instantly. */
  _snapshotPrevious(p, log) {
    rmrf(p.previous);
    ensureDir(p.previous);
    for (const dir of this.S.swapDirs) {
      const src = path.join(p.appDir, dir);
      if (!exists(src)) continue;
      try {
        fs.renameSync(src, path.join(p.previous, dir));
      } catch {
        copyDir(src, path.join(p.previous, dir)); // different filesystem
        rmrf(src);
      }
    }
    const files = copyDir(p.appDir, path.join(p.previous, "files"), { skip: p.skip });
    writeJson(path.join(p.previous, "meta.json"), {
      takenAt: new Date().toISOString(),
      buildInfo: readJson(p.buildInfo, null),
      manifest: readJson(p.manifest, { files: [] }).files || [],
      fileCount: files.length,
    });
    log?.line(`Snapshot of the current build saved (${files.length} source files + generated directories).`);
  }

  _swapIntoPlace(p, log) {
    for (const dir of this.S.swapDirs) {
      const src = path.join(p.staging, dir);
      if (!exists(src)) continue;
      const dest = path.join(p.appDir, dir);
      rmrf(dest);
      try {
        fs.renameSync(src, dest);
      } catch {
        copyDir(src, dest);
      }
      log?.line(`installed ${dir}/`);
    }
    const prevManifest = readJson(p.manifest, { files: [] }).files || [];
    const result = mirror(p.staging, p.appDir, { prevManifest, protect: p.protect, skip: p.skip });
    writeJson(p.manifest, { files: result.manifest, writtenAt: new Date().toISOString() });
    log?.line(
      `Files: ${result.added} added, ${result.updated} replaced, ${result.unchanged} unchanged, ` +
        `${result.removed.length} removed.`,
    );
    if (result.removed.length) {
      log?.line(`Removed: ${result.removed.slice(0, 20).join(", ")}${result.removed.length > 20 ? " …" : ""}`);
    }
    return result;
  }

  _restorePrevious(p, log) {
    if (!exists(p.previous)) throw new Error("There is no snapshot to roll back to.");
    log?.line("Restoring the previous build…");
    for (const dir of this.S.swapDirs) {
      const src = path.join(p.previous, dir);
      if (!exists(src)) continue;
      const dest = path.join(p.appDir, dir);
      rmrf(dest);
      try {
        fs.renameSync(src, dest);
      } catch {
        copyDir(src, dest);
      }
    }
    const meta = readJson(path.join(p.previous, "meta.json"), {});
    const currentManifest = readJson(p.manifest, { files: [] }).files || [];
    mirror(path.join(p.previous, "files"), p.appDir, {
      prevManifest: currentManifest,
      protect: p.protect,
      skip: p.skip,
    });
    writeJson(p.manifest, { files: meta.manifest || [], writtenAt: new Date().toISOString() });
    log?.line("Previous build restored.");
    return meta;
  }

  async _runMigrations(p, scripts, log) {
    const ran = [];
    for (const script of scripts) {
      const name = path.basename(script);
      if (!exists(path.join(p.appDir, name))) {
        log.line(`!! migration ${name} is not in the app directory — skipped`);
        continue;
      }
      log.line(`Running migration ${name}…`);
      await this.run(`node ${JSON.stringify(name)}`, { cwd: p.appDir, log, timeoutMs: 15 * 60_000 });
      ran.push(name);
    }
    return ran;
  }

  // --------------------------------------------------------------- jobs

  async doDeploy(job, log) {
    const p = this._require(log);
    const t0 = Date.now();

    log.setStep("Download");
    rmrf(p.staging);
    ensureDir(p.staging);

    const buf = await this.getArtifact(job.releaseId);
    log.line(`Got ${job.releaseFilename || job.releaseId} (${humanBytes(buf.length)}).`);

    if (job.releaseSha256) {
      const actual = crypto.createHash("sha256").update(buf).digest("hex");
      if (actual !== job.releaseSha256) throw new Error("The archive failed its checksum — aborting.");
      log.line("Checksum verified.");
    }

    const zipInfo = inspectZip(buf);

    log.setStep("Unpack");
    const written = extractZip(buf, p.staging, { stripRoot: true });
    log.line(
      `Unpacked ${written.length} files${zipInfo.rootPrefix ? ` (stripped the wrapper folder "${zipInfo.rootPrefix}")` : ""}.`,
    );
    if (zipInfo.hasNodeModules) {
      rmrf(path.join(p.staging, "node_modules"));
      log.line("Discarded node_modules from the archive — dependencies are installed here instead.");
    }

    const newVersion = zipInfo.version || job.releaseVersion || null;
    const current = this.readDeployedInfo();
    log.line(`Current version on disk: ${current?.version || "unknown"} → new version: ${newVersion || "unversioned"}`);

    this._seedPreserved(p, log);

    const buildMode = await this._buildStaging(p, job, log, zipInfo);

    // Build once, ship everywhere: zip the freshly built tree now — before the
    // downtime window, and before the app has run and written anything — so
    // the other servers of a load-balanced site get exactly these files.
    let packaged = null;
    if (job.packageTo) {
      log.setStep("Package");
      try {
        packaged = this.packageBuild(p.staging, job.packageTo, log);
      } catch (err) {
        // Not fatal for this server: the panel falls back to building on each.
        rmrf(job.packageTo);
        rmrf(`${job.packageTo}.part`);
        log.line(`!! Could not package the build: ${err.message}`);
        packaged = { error: err.message };
      }
    }

    this._writeBuildInfo(p.staging, {
      version: newVersion,
      releaseId: job.releaseId,
      zipName: job.releaseFilename,
      buildMode,
    });

    // --- the short downtime window starts here --------------------------
    log.setStep("Swap & restart");
    await this.stopApp(log);
    this._snapshotPrevious(p, log);
    const swap = this._swapIntoPlace(p, log);

    // The swap protects .env from being overwritten by the archive, which is
    // right — but it also means the staging copy never lands. Write it here.
    this.writeEnvFile(p.appDir, log);

    let migrationsRan = [];
    if (job.runMigrations && job.migrationScripts?.length) {
      log.setStep("Migrations");
      migrationsRan = await this._runMigrations(p, job.migrationScripts, log);
    }

    await this.startApp(log);

    log.setStep("Health check");
    const health = await this.waitForHealthy(log);
    const versionCheck = health.ok === false ? { confirmed: null } : await this.waitForVersion(newVersion, log);
    const failed = health.ok === false || versionCheck.confirmed === false;

    if (failed) await this.dumpAppLog(log);

    if (failed && this.S.autoRollback) {
      log.setStep("Automatic rollback");
      log.line("!! The new build did not come up. Rolling back to the previous one.");
      await this.stopApp(log);
      const meta = this._restorePrevious(p, log);
      await this.startApp(log);
      const recovered = await this.waitForHealthy(log, Math.min(this.S.healthTimeoutMs, 120_000));
      const why =
        versionCheck.confirmed === false
          ? `the app kept serving version ${versionCheck.serving?.version ?? "?"} after the restart`
          : "the app did not answer its health check";
      throw Object.assign(new Error(`Deploy rolled back — ${why}.`), {
        rolledBackTo: meta?.buildInfo?.releaseId || null,
        deployed: this.readDeployedInfo(),
        serving: await this.readServingInfo(),
        health: recovered,
      });
    }

    if (failed) {
      log.line("!! Automatic rollback is off, so the new build has been left in place.");
      throw new Error(
        versionCheck.confirmed === false
          ? `The restart did not take: still serving ${versionCheck.serving?.version ?? "?"} instead of ${newVersion}.`
          : "The app did not come back up after the restart.",
      );
    }

    const deployed = this.readDeployedInfo();
    const serving = await this.readServingInfo();
    rmrf(p.staging);

    const seconds = Math.round((Date.now() - t0) / 1000);
    log.setStep("Done");
    log.line(`Deploy finished in ${seconds}s. Now serving version ${serving?.version || deployed?.version || "?"}.`);

    return {
      deployed,
      serving,
      health,
      migrations: this.listMigrationScripts(),
      packaged,
      summary: {
        seconds,
        buildMode,
        filesAdded: swap.added,
        filesUpdated: swap.updated,
        filesRemoved: swap.removed.length,
        migrationsRan,
        version: newVersion,
      },
    };
  }

  async doRestart(job, log) {
    this._require(log);
    log.setStep("Restart");
    const onDisk = this.readDeployedInfo();
    this.writeEnvFile(this.S.appDir, log);
    await this.restartApp(log);
    const health = await this.waitForHealthy(log);
    if (health.ok === false) {
      await this.dumpAppLog(log);
      throw Object.assign(new Error("The app did not come back up after the restart."), {
        deployed: onDisk,
        serving: await this.readServingInfo(),
        health,
      });
    }
    const check = await this.waitForVersion(onDisk?.version, log);
    const deployed = this.readDeployedInfo();
    const serving = await this.readServingInfo();
    if (check.confirmed === false) {
      throw Object.assign(
        new Error(
          `The restart did not take: still serving ${check.serving?.version ?? "?"} instead of ${onDisk?.version}.`,
        ),
        { deployed, serving, health },
      );
    }
    log.line(`Back up. Serving version ${serving?.version || deployed?.version || "?"}.`);
    return { deployed, serving, health, summary: { version: serving?.version || deployed?.version } };
  }

  async doStop(job, log) {
    this._require(log);
    log.setStep("Stop");
    await this.stopApp(log);
    log.line("Stop command sent.");
    return { health: await this.checkHealth(), appRunning: await this.appRunning(), summary: { stopped: true } };
  }

  async doStart(job, log) {
    this._require(log);
    log.setStep("Start");
    this.writeEnvFile(this.S.appDir, log);
    await this.startApp(log);
    const health = await this.waitForHealthy(log);
    if (health.ok === false) await this.dumpAppLog(log);
    return {
      deployed: this.readDeployedInfo(),
      serving: await this.readServingInfo(),
      health,
      appRunning: await this.appRunning(),
      summary: { started: true },
    };
  }

  async doRollbackSnapshot(job, log) {
    const p = this._require(log);
    log.setStep("Rollback");
    await this.stopApp(log);
    this._restorePrevious(p, log);
    await this.startApp(log);
    const health = await this.waitForHealthy(log);
    const deployed = this.readDeployedInfo();
    const serving = await this.readServingInfo();
    return { deployed, serving, health, summary: { version: serving?.version || deployed?.version } };
  }

  async doMigrate(job, log) {
    const p = this._require(log);
    log.setStep("Migration");
    this.writeEnvFile(p.appDir, log);
    const ran = await this._runMigrations(p, [job.script], log);
    return { summary: { migrationsRan: ran }, migrations: this.listMigrationScripts() };
  }

  async doCommand(job, log) {
    this._require(log);
    log.setStep("Command");
    const r = await this.run(job.command, { cwd: this.S.appDir, log, timeoutMs: 15 * 60_000, allowFail: true });
    log.line(`\nExit code ${r.code}.`);
    if (r.code !== 0) throw new Error(`Command exited with code ${r.code}.`);
    return { summary: { exitCode: r.code } };
  }

  async doInspect(job, log) {
    log.setStep("Inspect");
    if (!this.S.appDir) {
      log.line("No app directory configured for this site yet.");
      return { deployed: null, serving: null, health: { ok: null, note: "not configured" }, migrations: [] };
    }
    const st = await this.status();
    log.line(`On disk: ${st.deployed?.version || "?"} · serving: ${st.serving?.version || "?"} · healthy: ${st.health?.ok}`);
    return st;
  }

  /** Dispatch by job type. Throws on failure; the caller reports it. */
  /**
   * Abandon whatever is running.
   *
   * The command has its own process group, so the whole tree goes rather than
   * just the shell that started it — a `npm install` abandoned by killing only
   * its parent leaves node processes holding the lock file.
   */
  abort(reason = "Cancelled.") {
    this.aborted = reason;
    const child = this.jobChild;
    if (child) {
      this.log?.line(`\n!! ${reason} — killing the running command.`);
      signalGroup(child, "SIGTERM");
      // Anything still alive a moment later is not going to exit politely.
      setTimeout(() => {
        if (this.jobChild === child) signalGroup(child, "SIGKILL");
      }, 4000).unref?.();
    }
    return !!child;
  }

  async execute(job, log = this.log) {
    this.aborted = null; // a new job is not born cancelled
    switch (job.type) {
      case "deploy":
        return this.doDeploy(job, log);
      case "rollback":
        // Rolling back to a specific release is just a deploy of that archive.
        // Rolling back with no release id means "undo the last deploy" and
        // uses the on-disk snapshot, which is far faster.
        return job.releaseId ? this.doDeploy({ ...job, type: "deploy" }, log) : this.doRollbackSnapshot(job, log);
      case "restart":
        return this.doRestart(job, log);
      case "stop":
        return this.doStop(job, log);
      case "start":
        return this.doStart(job, log);
      case "migrate":
        return this.doMigrate(job, log);
      case "command":
        return this.doCommand(job, log);
      case "inspect":
        return this.doInspect(job, log);
      default:
        throw new Error(`Unknown job type "${job.type}"`);
    }
  }

  cleanup() {
    if (this.paths) rmrf(this.paths.staging);
  }
}

// ------------------------------------------------------------------ utils

/** Tagged so a caller can tell "you stopped this" from "this broke". */
export function abortError(reason) {
  const err = new Error(reason || "Cancelled.");
  err.aborted = true;
  return err;
}

export function signalGroup(proc, signal) {
  try {
    process.kill(-proc.pid, signal);
    return true;
  } catch {
    try {
      proc.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchJson(url, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { ok: res.ok, status: res.status, json, text: text.slice(0, 300) };
  } finally {
    clearTimeout(t);
  }
}

export function diskFree(dir) {
  try {
    const st = fs.statfsSync(dir);
    return { freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize };
  } catch {
    return null;
  }
}
