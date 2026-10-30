/**
 * Server software updates — task `server.software` (Settings → Updates).
 *
 * The panel updates itself (panel/lib/updates.mjs); this covers the software
 * the websites stand on, on every server:
 *
 *   php         the php* packages (php-fpm and its extensions)
 *   mysql       the MySQL / MariaDB server and client packages
 *   cloudflared the Cloudflare Tunnel binary the panel downloads to
 *               <dataDir>/bin/cloudflared (or a `cloudflared` apt package)
 *
 * PHP and MySQL go through apt with --only-upgrade: only packages that are
 * already installed move, and only within their series (php8.3 stays 8.3,
 * MySQL 8.0 stays 8.0) — a new major is a migration, not an update.
 *
 *   { action: "check", refresh? }   refresh runs `apt-get update` first
 *     → { at, apt, php, mysql, cloudflared, simulated? }
 *   { action: "upgrade", component, cloudflaredUrl? }
 *     → { component, upgraded: [names], restarted: [units], check }
 *
 * Under FCC_DRY_RUN=1 nothing is run: the check returns sample data marked
 * `simulated` and an upgrade only logs what it would do.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as sys from "../panel/lib/sys.mjs";

export const COMPONENTS = ["php", "mysql", "cloudflared"];
export const CLOUDFLARED_LATEST_API = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";
const CLOUDFLARED_RELEASE = "https://github.com/cloudflare/cloudflared/releases/latest/download";
const APT_ENV = { DEBIAN_FRONTEND: "noninteractive", NEEDRESTART_MODE: "a" };
const LOCK = ["-o", "DPkg::Lock::Timeout=300"];

/** Which component an apt package belongs to, or null. */
export function componentOf(pkg) {
  const p = String(pkg || "");
  if (/^php(\d+(\.\d+)?)?(-|$)/.test(p) || /^libapache2-mod-php/.test(p)) return "php";
  if (/^(mysql|mariadb|percona-server)-(server|client|common|community)/.test(p) || /^(mysql|mariadb)-server$/.test(p) || /^libmysqlclient\d*$/.test(p) || /^libmariadb\d*$/.test(p) || /^galera-/.test(p)) return "mysql";
  if (p === "cloudflared") return "cloudflared";
  return null;
}

/** `dpkg-query -W -f '${Package}\t${Version}\t${db:Status-Abbrev}\n'` → Map(name → version) of installed packages. */
export function parseDpkg(out) {
  const m = new Map();
  for (const line of String(out || "").split("\n")) {
    const [name, version, status] = line.split("\t");
    if (name && version && /^.i/.test(status || "ii")) m.set(name.split(":")[0], version.trim());
  }
  return m;
}

/**
 * `apt list --upgradable` →
 * [{ name, to, from }] from lines like
 * "php8.3-fpm/noble-updates 8.3.6-0ubuntu0.24.04.3 amd64 [upgradable from: 8.3.6-0ubuntu0.24.04.2]".
 */
export function parseUpgradable(out) {
  const list = [];
  for (const line of String(out || "").split("\n")) {
    const m = /^([a-z0-9][a-z0-9+.-]*)\/\S+\s+(\S+)\s+\S+\s+\[upgradable from:\s*([^\]]+)\]/.exec(line.trim());
    if (m) list.push({ name: m[1], to: m[2], from: m[3].trim() });
  }
  return list;
}

/** "cloudflared version 2025.8.0 (built 2025-08-12…)" → "2025.8.0". */
export function parseCloudflaredVersion(text) {
  const m = /(\d{4}\.\d{1,2}\.\d+)/.exec(String(text || ""));
  return m ? m[1] : null;
}

/** Compare dotted numeric versions ("2025.10.1" vs "2025.8.0"). */
export function compareDotted(a, b) {
  const pa = String(a || "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Debian version "8.3.6-0ubuntu0.24.04.2" / "1:10.11.6-0ubuntu…" → "8.3.6" / "10.11.6". */
export function upstreamVersion(v) {
  const s = String(v || "").replace(/^\d+:/, "");
  const m = /^(\d+(?:\.\d+){0,3})/.exec(s);
  return m ? m[1] : s || null;
}

/** Summarise one apt component from the installed map and the upgradable list. */
export function summarize(component, installed, upgradable) {
  const names = [...installed.keys()].filter((n) => componentOf(n) === component);
  const upgrades = upgradable.filter((u) => componentOf(u.name) === component && installed.has(u.name));
  let main = null;
  let label = null;
  if (component === "php") {
    main = names.find((n) => /^php\d+\.\d+-fpm$/.test(n)) || names.find((n) => /^php\d+\.\d+-cli$/.test(n)) || names.find((n) => /^php\d+\.\d+-common$/.test(n));
    label = "PHP";
  } else if (component === "mysql") {
    main = ["mysql-server-core", "mysql-community-server", "mysql-server", "mariadb-server-core", "mariadb-server"]
      .map((p) => names.find((n) => n === p || n.startsWith(`${p}-`)))
      .find(Boolean) || names.find((n) => /client/.test(n) && !/^lib/.test(n));
    label = main && /mariadb/.test(main) ? "MariaDB" : "MySQL";
  }
  const up = main && upgrades.find((u) => u.name === main);
  return {
    installed: !!main,
    label,
    package: main || null,
    serverInstalled: component === "mysql" ? names.some((n) => /-server/.test(n)) : undefined,
    version: main ? upstreamVersion(installed.get(main)) : null,
    fullVersion: main ? installed.get(main) : null,
    latest: up ? upstreamVersion(up.to) : main ? upstreamVersion(installed.get(main)) : null,
    upgrades,
  };
}

// --------------------------------------------------------------- cloudflared

function cloudflaredAsset() {
  const a = { x64: "amd64", arm64: "arm64", arm: "arm" }[os.arch()];
  return a && os.platform() === "linux" ? `cloudflared-linux-${a}` : null;
}

/** Where cloudflared lives on this server, and who manages it. */
function findCloudflared(dataDir, installed) {
  const own = path.join(dataDir, "bin", "cloudflared");
  if (fs.existsSync(own)) return { path: own, managedBy: "panel" };
  if (installed.has("cloudflared")) return { path: sys.which("cloudflared"), managedBy: "apt" };
  const found = sys.which("cloudflared");
  return found ? { path: found, managedBy: "other" } : null;
}

async function cloudflaredInfo(dataDir, installed) {
  const where = findCloudflared(dataDir, installed);
  if (!where?.path) return { installed: false, version: null, managedBy: null, path: null };
  const r = await sys.run(where.path, ["--version"], { allowFail: true, timeoutMs: 15_000 }).catch(() => null);
  return { installed: true, version: parseCloudflaredVersion(`${r?.stdout || ""} ${r?.stderr || ""}`), managedBy: where.managedBy, path: where.path };
}

// --------------------------------------------------------------------- task

const simulated = () => ({
  at: new Date().toISOString(),
  simulated: true,
  apt: true,
  php: {
    installed: true, label: "PHP", package: "php8.3-fpm", version: "8.3.6", fullVersion: "8.3.6-0ubuntu0.24.04.2", latest: "8.3.6",
    upgrades: [
      { name: "php8.3-fpm", from: "8.3.6-0ubuntu0.24.04.2", to: "8.3.6-0ubuntu0.24.04.3" },
      { name: "php8.3-cli", from: "8.3.6-0ubuntu0.24.04.2", to: "8.3.6-0ubuntu0.24.04.3" },
      { name: "php8.3-mysql", from: "8.3.6-0ubuntu0.24.04.2", to: "8.3.6-0ubuntu0.24.04.3" },
    ],
  },
  mysql: { installed: true, label: "MySQL", package: "mysql-server-core-8.0", serverInstalled: true, version: "8.0.39", fullVersion: "8.0.39-0ubuntu0.24.04.2", latest: "8.0.40", upgrades: [{ name: "mysql-server-core-8.0", from: "8.0.39-0ubuntu0.24.04.2", to: "8.0.40-0ubuntu0.24.04.1" }, { name: "mysql-client-core-8.0", from: "8.0.39-0ubuntu0.24.04.2", to: "8.0.40-0ubuntu0.24.04.1" }] },
  cloudflared: { installed: true, version: "2025.8.0", managedBy: "panel", path: "/var/lib/fcc/bin/cloudflared" },
});

async function check({ refresh = false } = {}, o) {
  if (sys.DRY_RUN) {
    o.log("[dry-run] apt-get update; dpkg-query; apt list --upgradable; cloudflared --version");
    return simulated();
  }
  const apt = !!(sys.which("apt-get") && sys.which("dpkg-query"));
  let installed = new Map();
  let upgradable = [];
  if (apt) {
    if (refresh) {
      o.log("Refreshing the package lists (apt-get update)…");
      const r = await sys.run("apt-get", ["update", "-q", ...LOCK], { env: APT_ENV, timeoutMs: 10 * 60_000, allowFail: true, signal: o.signal });
      if (r.code !== 0) o.log(`!! apt-get update exited with ${r.code} — showing what the last lists know.`);
    }
    const q = await sys.run("dpkg-query", ["-W", "-f", "${Package}\t${Version}\t${db:Status-Abbrev}\n"], { allowFail: true, timeoutMs: 60_000 });
    installed = parseDpkg(q.stdout);
    const l = await sys.run("apt", ["list", "--upgradable"], { allowFail: true, timeoutMs: 60_000, env: { LC_ALL: "C" } });
    upgradable = parseUpgradable(l.stdout);
  }
  return {
    at: new Date().toISOString(),
    apt,
    php: summarize("php", installed, upgradable),
    mysql: summarize("mysql", installed, upgradable),
    cloudflared: await cloudflaredInfo(o.dataDir, installed),
  };
}

async function aptUpgrade(component, o) {
  if (!sys.which("apt-get")) throw new Error(`apt-get is not available on ${os.hostname()} — update ${component === "php" ? "PHP" : "MySQL"} by hand.`);
  o.log("Refreshing the package lists (apt-get update)…");
  await sys.run("apt-get", ["update", "-q", ...LOCK], { env: APT_ENV, log: o.log, timeoutMs: 10 * 60_000, allowFail: true, signal: o.signal });
  const before = await check({}, o);
  const names = before[component].upgrades.map((u) => u.name);
  if (!names.length) {
    o.log("Nothing to update — every package is already on its newest version.");
    return { upgraded: [], before };
  }
  o.log(`Updating ${names.length} package${names.length === 1 ? "" : "s"}: ${names.join(", ")}`);
  await sys.run(
    "apt-get",
    ["install", "-y", "-q", "--only-upgrade", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold", ...LOCK, ...names],
    { env: APT_ENV, log: o.log, timeoutMs: 30 * 60_000, signal: o.signal },
  );
  return { upgraded: names, before };
}

/** fcc-cloudflared-<id> units (edge replicas) on this server. */
function cloudflaredUnits() {
  try {
    return fs.readdirSync("/etc/systemd/system").filter((f) => /^fcc-cloudflared-cfc_[a-z0-9]{1,60}\.service$/.test(f));
  } catch {
    return [];
  }
}

async function cloudflaredUpgrade(payload, o) {
  const installed = sys.which("dpkg-query") ? parseDpkg((await sys.run("dpkg-query", ["-W", "-f", "${Package}\t${Version}\t${db:Status-Abbrev}\n"], { allowFail: true })).stdout) : new Map();
  const where = findCloudflared(o.dataDir, installed);
  if (where?.managedBy === "apt") {
    o.log("cloudflared comes from an apt package here — updating it with apt.");
    await sys.run("apt-get", ["update", "-q", ...LOCK], { env: APT_ENV, log: o.log, timeoutMs: 10 * 60_000, allowFail: true, signal: o.signal });
    await sys.run("apt-get", ["install", "-y", "-q", "--only-upgrade", ...LOCK, "cloudflared"], { env: APT_ENV, log: o.log, timeoutMs: 15 * 60_000, signal: o.signal });
  } else if (where?.managedBy === "other") {
    throw new Error(`cloudflared at ${where.path} was installed outside the panel — update it the way it was installed.`);
  } else {
    const asset = cloudflaredAsset();
    if (!asset) throw new Error(`There is no official cloudflared build for ${os.platform()}/${os.arch()}.`);
    const url = `${CLOUDFLARED_RELEASE}/${asset}`;
    const bin = path.join(o.dataDir, "bin", "cloudflared");
    o.log(`Downloading ${asset}…`);
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(5 * 60_000) });
    if (!res.ok) throw new Error(`Could not download cloudflared: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1_000_000) throw new Error("The downloaded file is too small to be cloudflared.");
    fs.mkdirSync(path.dirname(bin), { recursive: true, mode: 0o700 });
    const tmp = `${bin}.partial`;
    fs.writeFileSync(tmp, buf, { mode: 0o755 });
    const r = await sys.run(tmp, ["--version"], { allowFail: true, timeoutMs: 15_000 });
    if (r.code !== 0 || !parseCloudflaredVersion(`${r.stdout} ${r.stderr}`)) {
      fs.rmSync(tmp, { force: true });
      throw new Error("The downloaded cloudflared doesn't run on this server — the old one was kept.");
    }
    fs.renameSync(tmp, bin); // a running cloudflared keeps its old file until it restarts
    sys.forgetWhich("cloudflared");
    o.log(`Installed ${parseCloudflaredVersion(`${r.stdout} ${r.stderr}`)} at ${bin}.`);
  }
  // Edge replicas run as systemd units; the panel restarts its own in-process connectors itself.
  const restarted = [];
  for (const unit of cloudflaredUnits()) {
    o.log(`Restarting ${unit}…`);
    const r = await sys.run("systemctl", ["try-restart", unit], { allowFail: true, timeoutMs: 60_000 });
    if (r.code === 0) restarted.push(unit);
    else o.log(`!! ${unit} did not restart (exit ${r.code}).`);
  }
  return { upgraded: ["cloudflared"], restarted };
}

export async function runSoftwareTask(payload = {}, o) {
  const action = payload?.action || "check";
  if (action === "check") return check({ refresh: !!payload.refresh }, o);
  if (action !== "upgrade") throw new Error(`Unknown software action "${String(action).slice(0, 40)}".`);
  const component = String(payload.component || "");
  if (!COMPONENTS.includes(component)) throw new Error(`"${component.slice(0, 40)}" is not something the panel can update.`);
  if (sys.DRY_RUN) {
    const sample = simulated();
    const names = component === "cloudflared" ? ["cloudflared"] : sample[component].upgrades.map((u) => u.name);
    o.log(`[dry-run] would update ${names.join(", ")}`);
    if (component === "cloudflared") o.log("[dry-run] would download the latest cloudflared and restart the fcc-cloudflared-* units");
    else o.log(`[dry-run] apt-get install -y --only-upgrade ${names.join(" ")}`);
    return { component, upgraded: names, restarted: [], simulated: true, check: { ...sample, [component]: component === "cloudflared" ? { ...sample.cloudflared, version: payload.latest || sample.cloudflared.version } : { ...sample[component], version: sample[component].latest, upgrades: [] } } };
  }
  const r = component === "cloudflared" ? await cloudflaredUpgrade(payload, o) : await aptUpgrade(component, o);
  const after = await check({}, o);
  const left = component === "cloudflared" ? [] : after[component].upgrades;
  if (left.length) o.log(`!! ${left.length} package${left.length === 1 ? " was" : "s were"} held back: ${left.map((u) => u.name).join(", ")}`);
  else o.log("Done.");
  return { component, upgraded: r.upgraded, restarted: r.restarted || [], check: after };
}
