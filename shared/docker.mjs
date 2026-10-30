/**
 * Docker — the one place that knows how FCC runs code inside a container.
 *
 * Websites (runtime "docker", docs/DOCKER-AND-TESTS.md) and the throw-away
 * test environments both go through here, so the hardening is written once:
 *
 *   - a non-root uid:gid per site (never root inside the container);
 *   - every Linux capability dropped, no-new-privileges, a pids limit;
 *   - the app folder bind-mounted at the SAME absolute path, so paths a build
 *     writes into its output (Next.js, prisma) stay valid outside it;
 *   - variables passed as `-e KEY` with the value in the docker CLI's own
 *     environment, never on the command line (ps would show them).
 *
 * Nothing here builds a shell string from input: args are arrays, and the one
 * command a container runs is handed to `sh -c` as a single argument.
 *
 * The builders (runArgs, appArgs, buildArgs) are pure so they can be unit
 * tested; the rest are thin wrappers over panel/lib/sys.mjs (FCC_DRY_RUN=1
 * logs instead of running).
 */

import * as sys from "../panel/lib/sys.mjs";

/** Default image for node websites: Debian with build tools, so native modules and prisma work. */
export const DEFAULT_NODE_IMAGE = "node:24-bookworm";

/** Per-site uids start here (well clear of real users and Debian's system range). */
export const UID_BASE = 20000;

/** Running app limits when the site sets none. */
export const DEFAULT_LIMITS = { memoryMb: 1024, cpus: 0, pids: 1024 };

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Container name of a website: fcc-<siteId>. */
export function containerName(siteId) {
  const name = `fcc-${siteId}`;
  if (!NAME_RE.test(name)) throw new Error(`"${siteId}" can't be used in a container name.`);
  return name;
}

export function validName(name) {
  return typeof name === "string" && NAME_RE.test(name);
}

function checkUid(n, what) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1000 || v > 2 ** 31 - 2) throw new Error(`${what} must be a non-root id (1000 or more).`);
  return v;
}

function checkPath(p) {
  const s = String(p || "");
  if (!s.startsWith("/") || /[\0\n:]/.test(s) || s.split("/").filter(Boolean).length < 2) throw new Error(`Refusing to mount ${s || "(nothing)"} into a container.`);
  return s;
}

/**
 * Split variables into `-e KEY` flags and the environment the docker CLI runs
 * with (it copies the value of every `-e KEY` without `=` from there).
 * Keys that are not plain identifiers are dropped with a note.
 */
export function envFlags(vars = {}) {
  const args = [];
  const env = {};
  const dropped = [];
  for (const [k, v] of Object.entries(vars || {})) {
    if (v == null) continue;
    // DOCKER_* would also land in the docker CLI's own environment (that is
    // how `-e KEY` values travel) and steer the CLI itself — DOCKER_HOST could
    // point it at another daemon. A website has no business setting those.
    if (!ENV_KEY_RE.test(k) || /^DOCKER_/i.test(k)) {
      dropped.push(k);
      continue;
    }
    args.push("-e", k);
    env[k] = String(v);
  }
  return { args, env, dropped };
}

/**
 * The hardening and mount flags shared by every container FCC starts.
 * opts: { uid, gid, mounts: [{ src, dst?, ro? }], workdir, network, memoryMb, cpus, pids, readOnly, tmpfsMb, labels }
 */
export function baseFlags(o) {
  const uid = checkUid(o.uid, "uid");
  const gid = checkUid(o.gid ?? o.uid, "gid");
  const a = ["--user", `${uid}:${gid}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--init"];
  a.push("--pids-limit", String(Math.max(64, Number(o.pids) || DEFAULT_LIMITS.pids)));
  if (Number(o.memoryMb) > 0) a.push("--memory", `${Math.round(o.memoryMb)}m`, "--memory-swap", `${Math.round(o.memoryMb)}m`);
  if (Number(o.cpus) > 0) a.push("--cpus", String(o.cpus));
  if (o.network) a.push("--network", String(o.network));
  if (o.readOnly) a.push("--read-only");
  a.push("--tmpfs", `/tmp:rw,nosuid,nodev,size=${Math.max(16, Number(o.tmpfsMb) || 256)}m`);
  for (const m of o.mounts || []) {
    const src = checkPath(m.src);
    const dst = checkPath(m.dst || m.src);
    a.push("--mount", `type=bind,src=${src},dst=${dst}${m.ro ? ",readonly" : ""}`);
  }
  if (o.workdir) a.push("-w", checkPath(o.workdir));
  for (const [k, v] of Object.entries(o.labels || {})) a.push("--label", `${k}=${v}`);
  return a;
}

/**
 * `docker run --rm` of one shell command (install, build, a script) — the
 * argument list for sys.run("docker", …) and the environment to run it with.
 */
export function buildArgs({ image = DEFAULT_NODE_IMAGE, command, env = {}, name, ...o }) {
  if (typeof command !== "string" || !command.trim()) throw new Error("No command to run in the container.");
  const e = envFlags({ HOME: "/tmp", ...env });
  const args = ["run", "--rm", ...(name ? ["--name", name] : []), ...baseFlags(o), ...e.args, image, "sh", "-c", command];
  return { args, env: e.env, dropped: e.dropped };
}

/**
 * `docker run -d` of a long-running app (a website, a test copy of one).
 * restart: "unless-stopped" for websites (comes back after a reboot), "no" for tests.
 */
export function appArgs({ image = DEFAULT_NODE_IMAGE, name, command, env = {}, restart = "unless-stopped", ...o }) {
  if (!validName(name)) throw new Error(`"${name}" is not a valid container name.`);
  if (typeof command !== "string" || !command.trim()) throw new Error("No start command for the container.");
  const e = envFlags({ HOME: "/tmp", NODE_ENV: "production", ...env });
  const args = ["run", "-d", "--name", name, "--restart", restart, ...baseFlags(o), ...e.args, image, "sh", "-c", command];
  return { args, env: e.env, dropped: e.dropped };
}

/**
 * The smallest free per-site uid at or above UID_BASE. `used` is any iterable
 * of uids already handed out (numbers or numeric strings; junk is ignored).
 */
export function nextUid(used = []) {
  const taken = new Set();
  for (const u of used) {
    const n = Number(u);
    if (Number.isInteger(n)) taken.add(n);
  }
  let uid = UID_BASE;
  while (taken.has(uid)) uid++;
  return uid;
}

const IMAGE_RE = /^[a-z0-9][a-z0-9._\/-]{0,200}(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(@sha256:[a-f0-9]{64})?$/;

/** A docker image reference we are willing to pass to `docker run` (no flags, no spaces). */
export function validImage(image) {
  return typeof image === "string" && image.length <= 300 && IMAGE_RE.test(image) && !image.includes("..");
}

/**
 * Normalise a site's container record: { uid, gid, image, memoryMb, cpus }.
 * Missing limits fall back to DEFAULT_LIMITS; an invalid image to the default.
 */
export function containerSettings(c = {}) {
  const uid = Number(c?.uid);
  const memoryMb = Number(c?.memoryMb);
  const cpus = Number(c?.cpus);
  return {
    uid: Number.isInteger(uid) ? uid : null,
    gid: Number.isInteger(Number(c?.gid)) ? Number(c.gid) : Number.isInteger(uid) ? uid : null,
    image: validImage(c?.image) ? c.image : DEFAULT_NODE_IMAGE,
    memoryMb: Number.isFinite(memoryMb) && memoryMb >= 0 ? Math.round(memoryMb) : DEFAULT_LIMITS.memoryMb,
    cpus: Number.isFinite(cpus) && cpus >= 0 ? cpus : DEFAULT_LIMITS.cpus,
  };
}

/**
 * The environment to start the docker CLI with: the host's own (PATH, HOME…
 * so the CLI works) plus the values of the `-e KEY` flags. Only the keys named
 * by `-e` reach the container, so the rest of the panel's environment stays
 * outside. DOCKER_* never comes from a website (envFlags drops them).
 */
export function cliEnv(containerEnv = {}, base = process.env) {
  return { ...base, ...containerEnv };
}

// ------------------------------------------------------------ thin wrappers

/** Is the docker CLI here and its daemon answering? { installed, running, version, error } */
export async function status() {
  if (sys.DRY_RUN) return { installed: true, running: true, version: "dry-run", dryRun: true };
  if (!sys.which("docker")) return { installed: false, running: false, version: null };
  const r = await sys.run("docker", ["version", "--format", "{{.Server.Version}}"], { allowFail: true, timeoutMs: 15_000 }).catch((e) => ({ code: 1, stderr: e.message }));
  if (r.code !== 0) return { installed: true, running: false, version: null, error: String(r.stderr || "").trim().slice(0, 300) || "the docker daemon is not answering" };
  return { installed: true, running: true, version: String(r.stdout || "").trim() };
}

/**
 * Install Docker from the distribution's own packages when it is missing
 * (Ubuntu/Debian: docker.io) and make sure the daemon runs at boot.
 */
export async function ensureInstalled({ log } = {}) {
  let st = await status();
  if (st.running) return st;
  if (!st.installed) {
    if (!sys.which("apt-get")) throw new Error("Docker is not installed and this server has no apt-get to install it with. Install Docker, then try again.");
    log?.("Installing Docker (docker.io from the distribution's packages)…");
    const env = { ...process.env, DEBIAN_FRONTEND: "noninteractive" };
    await sys.run("apt-get", ["update"], { log, env, timeoutMs: 10 * 60_000 });
    await sys.run("apt-get", ["install", "-y", "docker.io"], { log, env, timeoutMs: 20 * 60_000 });
    sys.forgetWhich?.("docker");
  }
  await sys.run("systemctl", ["enable", "--now", "docker"], { log, allowFail: true, timeoutMs: 120_000 });
  st = await status();
  if (!st.running) throw new Error(`Docker is installed but not running${st.error ? `: ${st.error}` : ""}.`);
  log?.(`Docker ${st.version} is running.`);
  return st;
}

/** Pull `image` unless it is already here. */
export async function ensureImage(image, { log, signal } = {}) {
  const have = await sys.run("docker", ["image", "inspect", "--format", "{{.Id}}", image], { allowFail: true, timeoutMs: 30_000 });
  if (have.code === 0 && !have.dryRun) return { pulled: false };
  log?.(`Pulling ${image}…`);
  await sys.run("docker", ["pull", image], { log, signal, timeoutMs: 30 * 60_000 });
  return { pulled: true };
}

/** { exists, running, status, pid, restarts, startedAt } of a container. */
export async function inspect(name) {
  if (sys.DRY_RUN) return { exists: false, running: false, dryRun: true };
  const r = await sys.run("docker", ["inspect", "--format", "{{json .State}}|{{.RestartCount}}", name], { allowFail: true, timeoutMs: 20_000 }).catch(() => null);
  if (!r || r.code !== 0) return { exists: false, running: false };
  const [json, restarts] = String(r.stdout).trim().split("|");
  try {
    const s = JSON.parse(json);
    return { exists: true, running: !!s.Running, status: s.Status, pid: s.Pid || null, restarts: Number(restarts) || 0, startedAt: s.StartedAt || null, exitCode: s.ExitCode };
  } catch {
    return { exists: true, running: null };
  }
}

/** Remove a container if it exists (stops it first). */
export async function remove(name, { log, graceSec = 10 } = {}) {
  await sys.run("docker", ["stop", "-t", String(graceSec), name], { log: null, allowFail: true, timeoutMs: (graceSec + 30) * 1000 }).catch(() => {});
  await sys.run("docker", ["rm", "-f", name], { log, allowFail: true, timeoutMs: 60_000 }).catch(() => {});
}

/** The last `lines` lines a container printed (stdout and stderr together). */
export async function logs(name, lines = 200) {
  const r = await sys.run("docker", ["logs", "--tail", String(lines), name], { allowFail: true, timeoutMs: 30_000 }).catch((e) => ({ code: 1, stdout: "", stderr: e.message }));
  return `${r.stdout || ""}${r.stderr || ""}`;
}

/** Create a network unless it exists. `internal`: no way out to the internet. */
export async function ensureNetwork(name, { internal = false, log } = {}) {
  if (!validName(name)) throw new Error(`"${name}" is not a valid network name.`);
  const have = await sys.run("docker", ["network", "inspect", name], { allowFail: true, timeoutMs: 20_000 });
  if (have.code === 0 && !have.dryRun) return;
  await sys.run("docker", ["network", "create", ...(internal ? ["--internal"] : []), name], { log, timeoutMs: 60_000 });
}

export async function removeNetwork(name, { log } = {}) {
  await sys.run("docker", ["network", "rm", name], { log, allowFail: true, timeoutMs: 60_000 }).catch(() => {});
}

/** chown -R uid:gid dir — files the root-run engine unpacked become the container user's. */
export async function own(dir, uid, gid = uid, { log } = {}) {
  checkPath(dir);
  await sys.run("chown", ["-R", `${checkUid(uid, "uid")}:${checkUid(gid, "gid")}`, dir], { log, timeoutMs: 10 * 60_000 });
}
