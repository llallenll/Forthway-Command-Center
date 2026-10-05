/**
 * Running system programs (nginx, mysql, mysqldump, tar, certbot, pm2…).
 *
 * Every module that touches the machine goes through here so that:
 *   - arguments are always an array — never a shell string built from input;
 *   - output streams to a job log line by line;
 *   - FCC_DRY_RUN=1 (development on a laptop) logs what WOULD run and returns
 *     success, so the whole panel can be exercised without nginx or MySQL.
 */

import { spawn, execFileSync } from "node:child_process";

export const DRY_RUN = process.env.FCC_DRY_RUN === "1";

const whichCache = new Map();

/** Absolute path of a program on PATH, or null. Cached. */
export function which(bin) {
  if (whichCache.has(bin)) return whichCache.get(bin);
  let found = null;
  try {
    found = execFileSync("sh", ["-c", 'command -v "$1"', "sh", bin], { encoding: "utf8" }).trim() || null;
  } catch {
    found = null;
  }
  whichCache.set(bin, found);
  return found;
}

export function forgetWhich(bin) {
  if (bin) whichCache.delete(bin);
  else whichCache.clear();
}

/**
 * Run `cmd args…`. Resolves { code, stdout, stderr }; rejects on non-zero
 * exit unless `allowFail`. `log(line)` receives stdout+stderr as it arrives.
 * `input` (string|Buffer) is written to stdin. `stdoutFile` (a writable
 * stream) receives raw stdout instead of buffering it (for dumps/archives).
 */
export function run(cmd, args = [], opts = {}) {
  const {
    log = null,
    signal = null,
    input = null,
    env = null,
    cwd = undefined,
    allowFail = false,
    timeoutMs = 0,
    stdoutFile = null,
    redact = [],
  } = opts;

  const shown = [cmd, ...args].map((a) => (redact.includes(a) ? "••••" : a)).join(" ");
  if (DRY_RUN) {
    log?.(`[dry-run] ${shown}`);
    return Promise.resolve({ code: 0, stdout: "", stderr: "", dryRun: true });
  }

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timer = null;
    const lineSink = (stream, isErr) => {
      let buf = "";
      stream.on("data", (d) => {
        const s = d.toString("utf8");
        if (isErr) stderr += s;
        else stdout += s;
        if (!log) return;
        buf += s;
        let i;
        while ((i = buf.indexOf("\n")) !== -1) {
          log(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      stream.on("end", () => buf && log?.(buf));
    };
    if (stdoutFile) child.stdout.pipe(stdoutFile);
    else lineSink(child.stdout, false);
    lineSink(child.stderr, true);

    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs) timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err.code === "ENOENT" ? new Error(`${cmd} is not installed on this server`) : err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const result = { code, stdout, stderr };
      if (code !== 0 && !allowFail) {
        const tail = (stderr || stdout).trim().split("\n").slice(-5).join("\n");
        const err = new Error(`${shown} exited with code ${code}${tail ? `: ${tail}` : ""}`);
        err.result = result;
        return reject(err);
      }
      resolve(result);
    });

    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}
