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
