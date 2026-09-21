/**
 * Cloudflare Tunnel.
 *
 * Paste a connector token from the Cloudflare dashboard and the Command
 * Center runs `cloudflared tunnel run` beside itself, so the panel and the
 * sites on this machine are reachable without opening a port, forwarding
 * anything, or knowing what the box's public address is. Which hostname
 * points at which local port is decided in the Cloudflare dashboard — that is
 * what a connector token is for — so there is nothing to configure here
 * beyond the token itself.
 *
 * The panel usually runs in a container with no root, so `apt install
 * cloudflared` is not an option: if the binary is not already on PATH it is
 * downloaded from Cloudflare's own releases into the data directory.
 *
 * The token is passed as TUNNEL_TOKEN in the environment rather than on the
 * command line, so it never shows up in `ps`.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { ensureDir } from "../../shared/fsx.mjs";

const RELEASE = "https://github.com/cloudflare/cloudflared/releases/latest/download";
const MAX_LOG_LINES = 300;

/** Which official build fits this machine. */
export function assetName() {
  const platform = os.platform();
  const arch = os.arch();
  const archName = { x64: "amd64", arm64: "arm64", arm: "arm" }[arch];
  if (!archName) return null;
  if (platform === "linux") return `cloudflared-linux-${archName}`;
  if (platform === "darwin") return null; // shipped as a .tgz; use brew instead
  return null;
}

export class Tunnel {
  constructor({ dataDir, onChange, onLog }) {
    this.binDir = ensureDir(path.join(dataDir, "bin"));
    this.binPath = path.join(this.binDir, "cloudflared");
    this.onChange = onChange || (() => {});
    this.onLog = onLog || (() => {});

    this.proc = null;
    this.wantRunning = false;
    this.restartTimer = null;
    this.backoffMs = 2000;
    this.log = [];
    this.connections = 0;
    this.startedAt = null;
    this.lastError = null;
    this.lastExit = null;
    this.fatal = false;
    this.version = null;
    this.downloading = false;
  }

  // ------------------------------------------------------------- the binary

  /** An installed cloudflared wins; otherwise the one we downloaded. */
  async resolveBinary({ download = true } = {}) {
    const onPath = await which("cloudflared");
    if (onPath) return onPath;
    if (fs.existsSync(this.binPath)) return this.binPath;
    if (!download) return null;
    await this.download();
    return fs.existsSync(this.binPath) ? this.binPath : null;
  }

  async download() {
    const asset = assetName();
    if (!asset) {
      throw new Error(
        `No official cloudflared build for ${os.platform()}/${os.arch()}. Install cloudflared yourself and it will be used.`,
      );
    }
    this.downloading = true;
    this.onChange();
    this.line(`Downloading ${asset} from Cloudflare…`);
    try {
      const res = await fetch(`${RELEASE}/${asset}`, { redirect: "follow" });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1_000_000) throw new Error("the downloaded file is too small to be cloudflared");
      // Write beside the target and rename, so a half-written binary is never
      // left behind for the next start to trip over.
      const tmp = `${this.binPath}.partial`;
      fs.writeFileSync(tmp, buf);
      fs.chmodSync(tmp, 0o755);
      fs.renameSync(tmp, this.binPath);
      this.line(`Downloaded cloudflared (${(buf.length / 1e6).toFixed(1)} MB).`);
    } finally {
      this.downloading = false;
      this.onChange();
    }
    await this.readVersion();
  }

  async readVersion() {
    try {
      const bin = (await which("cloudflared")) || this.binPath;
      if (!fs.existsSync(bin) && !(await which("cloudflared"))) return null;
      const out = await run(bin, ["--version"]);
      this.version = out.trim().split("\n")[0] || null;
      return this.version;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------- lifecycle

  async start(token) {
    if (!token) throw new Error("No tunnel token. Paste the connector token from the Cloudflare dashboard first.");
    if (this.proc) return { alreadyRunning: true };

    const bin = await this.resolveBinary();
    if (!bin) throw new Error("Could not find or download cloudflared.");
    await this.readVersion();

    this.wantRunning = true;
    this.lastError = null;
    this.fatal = false;
    this.backoffMs = 2000;
    this.connections = 0;
    this.spawn(bin, token);
    return { started: true };
  }

  spawn(bin, token) {
    if (this.proc) return;
    this.line(`Starting ${path.basename(bin)}…`);
    const proc = spawn(bin, ["--no-autoupdate", "tunnel", "run"], {
      // The token goes in the environment, never argv — argv is world-readable
      // in /proc and shows up in `ps`.
      env: { ...process.env, TUNNEL_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    this.proc = proc;
    this.startedAt = new Date().toISOString();
    this.spawnedAt = Date.now();
    this.token = token;

    const onData = (chunk) => {
      for (const raw of chunk.toString().split("\n")) {
        const l = raw.trimEnd();
        if (!l) continue;
        this.line(l);
        // cloudflared says this once per edge connection it registers.
        if (/Registered tunnel connection/i.test(l)) {
          this.connections++;
          this.onChange();
        }
        if (/Unregistered tunnel connection/i.test(l)) {
          this.connections = Math.max(0, this.connections - 1);
          this.onChange();
        }
        // A bad token is fatal: cloudflared exits immediately and will do so
        // every time, so retrying is just noise. Say why and stop.
        if (/token is not valid|invalid token|token is invalid|Unauthorized/i.test(l)) {
          this.lastError = l.slice(0, 300);
          this.fatal = true;
          this.onChange();
        } else if (/failed to (?:connect|authenticate)|Couldn't (?:connect|start)|error parsing/i.test(l)) {
          this.lastError = l.slice(0, 300);
          this.onChange();
        }
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData); // cloudflared logs to stderr by default

    proc.once("exit", (code, signal) => {
      const aliveMs = Date.now() - this.spawnedAt;
      this.proc = null;
      this.connections = 0;
      this.lastExit = { code, signal, at: new Date().toISOString() };
      this.line(`cloudflared exited (${signal || `code ${code}`}).`);

      if (this.fatal) {
        this.wantRunning = false;
        this.line("Not retrying — fix the token and start it again.");
        this.onChange();
        return;
      }
      this.onChange();
      if (!this.wantRunning) return;

      // Reset the backoff only if it actually stayed up. Resetting on every
      // spawn means a process that dies in 200ms retries forever at 2s.
      if (aliveMs > 20_000) this.backoffMs = 2000;
      this.line(`Retrying in ${Math.round(this.backoffMs / 1000)}s.`);
      this.restartTimer = setTimeout(() => this.spawn(bin, token), this.backoffMs);
      this.restartTimer.unref?.();
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    });
    this.onChange();
  }

  async stop() {
    this.wantRunning = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const proc = this.proc;
    if (!proc) {
      this.onChange();
      return;
    }
    this.line("Stopping cloudflared…");
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(hard);
        resolve();
      };
      proc.once("exit", finish);
      const hard = setTimeout(() => {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
        finish();
      }, 8000);
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        try {
          proc.kill("SIGTERM");
        } catch {
          finish();
        }
      }
    });
    this.proc = null;
    this.connections = 0;
    this.onChange();
  }

  line(text) {
    const entry = `[${new Date().toISOString()}] ${text}`;
    this.log.push(entry);
    if (this.log.length > MAX_LOG_LINES) this.log.splice(0, this.log.length - MAX_LOG_LINES);
    this.onLog(entry);
  }

  status() {
    return {
      running: !!this.proc,
      connections: this.connections,
      connected: !!this.proc && this.connections > 0,
      startedAt: this.proc ? this.startedAt : null,
      lastError: this.lastError,
      lastExit: this.lastExit,
      fatal: !!this.fatal,
      version: this.version,
      downloading: this.downloading,
      binary: fs.existsSync(this.binPath) ? this.binPath : null,
      supported: !!assetName(),
    };
  }

  recentLog(lines = 80) {
    return this.log.slice(-lines);
  }
}

// ------------------------------------------------------------------ helpers

function which(cmd) {
  return new Promise((resolve) => {
    execFile("sh", ["-c", `command -v ${cmd}`], (err, stdout) => {
      if (err) return resolve(null);
      const p = String(stdout).trim();
      resolve(p || null);
    });
  });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(String(stdout || stderr || ""));
    });
  });
}

// ---------------------------------------------------------------- many

/**
 * More than one connector at a time.
 *
 * One tunnel per machine is the common case, but not the only one: separate
 * Cloudflare accounts, a connector shared with another box, or a spare kept
 * warm while a hostname is moved across. Each entry is an independent
 * cloudflared process with its own token and its own log; they share only the
 * binary, which is downloaded once.
 */
export class TunnelPool {
  constructor({ dataDir, onChange, onLog }) {
    this.dataDir = dataDir;
    this.onChange = onChange || (() => {});
    this.onLog = onLog || (() => {});
    this.byId = new Map();
    this.meta = new Map(); // id -> { name, autoStart, cfId }
    // Downloading and version-checking need a Tunnel but not a token, so one
    // instance stands in for the toolbox the others share.
    this.tools = new Tunnel({ dataDir, onChange: () => {}, onLog: () => {} });
  }

  /** Bring the running set in line with what is configured. */
  sync(entries = []) {
    const wanted = new Map(entries.filter((e) => e && e.id).map((e) => [e.id, e]));
    for (const id of [...this.byId.keys()]) {
      if (!wanted.has(id)) {
        this.byId.get(id).stop().catch(() => {});
        this.byId.delete(id);
        this.meta.delete(id);
      }
    }
    for (const [id, e] of wanted) {
      this.meta.set(id, { name: e.name || "Tunnel", autoStart: e.autoStart !== false, cfId: e.cfId || "", token: e.token || "" });
      if (!this.byId.has(id)) {
        this.byId.set(
          id,
          new Tunnel({
            dataDir: this.dataDir,
            onChange: () => this.onChange(id),
            onLog: (line) => this.onLog(id, line),
          }),
        );
      }
    }
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  /** Every connector, with the configuration that produced it. */
  statuses() {
    return [...this.byId.entries()].map(([id, t]) => {
      const m = this.meta.get(id) || {};
      return {
        id,
        name: m.name || "Tunnel",
        cfId: m.cfId || "",
        autoStart: m.autoStart !== false,
        hasToken: !!m.token,
        ...t.status(),
      };
    });
  }

  /** One line for the header pill: are they all up? */
  summary() {
    const all = this.statuses();
    return {
      count: all.length,
      running: all.filter((t) => t.running).length,
      connected: all.filter((t) => t.connected).length,
      anyError: all.some((t) => t.lastError) || null,
    };
  }

  async start(id) {
    const t = this.byId.get(id);
    const m = this.meta.get(id);
    if (!t || !m) throw new Error("No such tunnel.");
    if (!m.token) throw new Error("That tunnel has no connector token.");
    return t.start(m.token);
  }

  async stop(id) {
    const t = this.byId.get(id);
    if (t) await t.stop();
  }

  async restart(id) {
    await this.stop(id);
    return this.start(id);
  }

  async startAutos() {
    for (const [id, m] of this.meta) {
      if (m.autoStart === false || !m.token) continue;
      try {
        await this.start(id);
      } catch (err) {
        this.byId.get(id)?.line(`Could not start: ${err.message}`);
      }
    }
  }

  async stopAll() {
    await Promise.allSettled([...this.byId.keys()].map((id) => this.stop(id)));
  }

  recentLog(id, lines = 120) {
    return this.byId.get(id)?.recentLog(lines) || [];
  }

  // ---- the shared binary
  resolveBinary(opts) {
    return this.tools.resolveBinary(opts);
  }
  download() {
    return this.tools.download();
  }
  readVersion() {
    return this.tools.readVersion();
  }
  binaryStatus() {
    const s = this.tools.status();
    return { version: s.version, binary: s.binary, supported: s.supported, downloading: s.downloading };
  }
}
