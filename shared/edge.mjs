/**
 * Edge nodes — the agent side of docs/HA.md (task `cluster.sync`).
 *
 * An edge node runs the nginx front door for every website (the panel renders
 * the fcc-<siteId>.conf files for this server), a replica of every Cloudflare
 * Tunnel connector the panel runs, and small "shims" on 127.0.0.1:<port> that
 * proxy the panel (and phpMyAdmin) back to main. When main dies, Cloudflare
 * keeps sending tunnel traffic to the replicas here.
 *
 *   clusterSync(payload, o)   the task itself (called from shared/tasks.mjs)
 *   readEdgeState(dataDir)    what the last cluster.sync left behind
 *   edgeStatus(dataDir)       that state + live probes, for /agent/metrics
 *   edgeLogSites(dataDir)     site ids whose fcc-<siteId>.conf this server manages
 *   panelInstall / panelRemove  tasks panel.install / panel.remove (Phase 2: panel nodes)
 *   applyHostsBlock(map, opts)  the managed /etc/hosts block (Phase 3: database address)
 *   applyDbCutover(spec, opts)  cut clients off a failed database primary (3.10)
 *
 * Phase 3 (database replication) adds `hosts: { "fcc-mysql.internal": "<ip>" } | null`
 * to cluster.sync: a managed block in /etc/hosts (null or {} removes it; a
 * payload without the key leaves it alone). The panel on main calls
 * applyHostsBlock() in-process for main itself. panel.install also installs
 * the MySQL client of `mysqlFlavor` when the payload names one.
 *
 * 3.10 (fast database failover) adds `dbCutover: { blockIps: [ip…], port } | null`:
 * on every server, existing TCP connections to those ip:port are killed
 * (`ss -K`, needs a kernel with sock-destroy) and new ones are refused with a
 * TCP RST by a firewall rule (iptables/ip6tables OUTPUT, or an nft table
 * `inet fcc_db_cutover`), tagged "fcc-db-cutover"; null / [] removes them. It
 * is applied before anything else in the task — it is what moves websites off
 * a dead database primary within a second instead of a TCP timeout.
 *
 * Phase 2 (panel failover) adds two things to cluster.sync:
 *   - `frontDoor: true` — sent only to main's embedded agent while another
 *     server runs the active panel: `edge.files` are main's own front door
 *     files (Let's Encrypt paths) and replace main's fcc-*.conf set; no
 *     catch-all, no shims, no connectors; their access logs are shipped.
 *   - `shims[].targets: [url, …]` — every panel node; rendered as an nginx
 *     upstream with passive failover (the single `target` still works).
 *
 * Everything that shells out goes through panel/lib/sys.mjs: under
 * FCC_DRY_RUN=1 ufw/systemctl/openssl/nginx are only logged, nginx files go to
 * <dataDir>/nginx-edge and unit/env files to <dataDir>/edge-dry-run, and the
 * connectors are reported as simulated and active.
 *
 * Nothing in the payload is trusted to build a path or a unit file: file
 * names, connector ids, ports, targets and tokens are checked against strict
 * patterns first, and the task fails with a clear message when one does not fit.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

import { ensureDir, exists } from "./fsx.mjs";
import { nginxConfDir, nginxIsLive, reloadNginx } from "./tasks.mjs";
import * as sys from "../panel/lib/sys.mjs";

const NOOP = () => {};

/** The site files the panel renders reference these paths (docs/HA.md). */
export const EDGE_TLS_DIR = "/etc/fcc-node/edge-tls";
const EDGE_CRT = `${EDGE_TLS_DIR}/edge.crt`;
const EDGE_KEY = `${EDGE_TLS_DIR}/edge.key`;

const DEFAULT_FILE = "fcc-00-edge-default.conf";
const SHIM_RE = /^fcc-edge-shim-(\d{1,5})\.conf$/;
const FILE_RE = /^fcc-[A-Za-z0-9_-]+\.conf$/;
const CONNECTOR_ID_RE = /^cfc_[a-z0-9]{1,60}$/;
const UNIT_RE = /^fcc-cloudflared-(cfc_[a-z0-9]{1,60})\.service$/;
const ENV_RE = /^(cfc_[a-z0-9]{1,60})\.env$/;
const TOKEN_RE = /^[A-Za-z0-9+/=_-]{20,8192}$/;
const SHIM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;
const TARGET_RE = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\]):(\d{1,5})\/?$/;
const HASH_RE = /^[A-Fa-f0-9]{8,128}$/;
const PMA_FILE = "fcc-phpmyadmin.conf"; // DATA's phpMyAdmin vhost on main — never part of a front door set
const MAX_SHIM_TARGETS = 16;

const UFW_COMMENT = "fcc sites from edge";
const SITE_PORTS = "3000:3999";
const METRICS_PORT_BASE = 20241;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const CLOUDFLARED_RELEASE = "https://github.com/cloudflare/cloudflared/releases/latest/download";

// ------------------------------------------------------------------ paths

function edgePaths(dataDir) {
  const dry = sys.DRY_RUN ? path.join(dataDir, "edge-dry-run") : null;
  return {
    conf: nginxConfDir(dataDir, "nginx-edge"),
    tls: dry ? path.join(dry, "edge-tls") : EDGE_TLS_DIR,
    env: dry ? path.join(dry, "cloudflared") : "/etc/fcc-node/cloudflared",
    units: dry ? path.join(dry, "systemd") : "/etc/systemd/system",
    bin: path.join(dataDir, "bin", "cloudflared"),
    state: path.join(dataDir, "edge-state.json"),
  };
}

const unitName = (id) => `fcc-cloudflared-${id}.service`;

// ------------------------------------------------------------------ state

/** The persisted edge state, or a blank one. Never throws. */
export function readEdgeState(dataDir) {
  const blank = { edge: false, hash: null, appliedAt: null, error: null, nginx: false, nginxOkOnce: false, files: [], connectors: {}, shims: [] };
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dataDir, "edge-state.json"), "utf8"));
    if (!s || typeof s !== "object") return blank;
    return {
      ...blank,
      ...s,
      files: Array.isArray(s.files) ? s.files.filter((f) => typeof f === "string" && FILE_RE.test(f) && !f.startsWith("fcc-app-")) : [],
      connectors: s.connectors && typeof s.connectors === "object" ? s.connectors : {},
      shims: Array.isArray(s.shims) ? s.shims : [],
    };
  } catch {
    return blank;
  }
}

function writeEdgeState(file, state) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------------- validation

function bad(msg) {
  return new Error(`cluster.sync: ${msg} — nothing was changed on ${os.hostname()}.`);
}

function checkPort(v, what) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw bad(`${what} is not a valid port (${String(v).slice(0, 20)})`);
  return n;
}

/** A normalised copy of the payload, or throws before anything is touched. */
function checkPayload(payload) {
  if (!payload || typeof payload !== "object") throw bad("the payload is missing");
  const hash = typeof payload.hash === "string" && HASH_RE.test(payload.hash) ? payload.hash.toLowerCase() : null;

  const allowFrom = [];
  const ignored = [];
  for (const ip of Array.isArray(payload.allowFrom) ? payload.allowFrom : []) {
    const s = String(ip ?? "").trim();
    if (net.isIP(s)) {
      if (!allowFrom.includes(s)) allowFrom.push(s);
    } else ignored.push(s.slice(0, 60));
  }

  // frontDoor (docs/HA.md, Phase 2): sent only to main's embedded agent while
  // another server runs the active panel — main's own front door files, nothing else.
  const frontDoor = payload.frontDoor === true;
  // hosts (Phase 3): undefined = leave /etc/hosts alone, null / {} = remove the block.
  let hosts;
  if (payload.hosts !== undefined) {
    try {
      hosts = checkHostsMap(payload.hosts);
    } catch (err) {
      throw bad(err.message);
    }
  }
  // dbCutover (3.10): undefined = leave alone, null = remove every block.
  let dbCutover;
  if (payload.dbCutover !== undefined) {
    try {
      dbCutover = checkDbCutover(payload.dbCutover);
    } catch (err) {
      throw bad(err.message);
    }
  }
  if (payload.edge == null) return { hash, allowFrom, ignored, notes: [], frontDoor, hosts, dbCutover, edge: null };
  const e = payload.edge;
  if (typeof e !== "object") throw bad("edge must be an object or null");

  // nginx files: only fcc-*.conf names, never a local vhost, never one we generate ourselves.
  const files = new Map();
  const fe = e.files && typeof e.files === "object" && !Array.isArray(e.files) ? Object.entries(e.files) : [];
  if (fe.length > MAX_FILES) throw bad(`too many nginx files (${fe.length})`);
  for (const [name, content] of fe) {
    if (!FILE_RE.test(name)) throw bad(`"${String(name).slice(0, 80)}" is not an allowed nginx file name`);
    if (name.startsWith("fcc-app-")) throw bad(`${name} is a local website vhost and cannot be set from the edge configuration`);
    if (name === DEFAULT_FILE || SHIM_RE.test(name)) throw bad(`${name} is generated on the edge itself`);
    if (name === PMA_FILE) throw bad(`${name} is the phpMyAdmin vhost and is not part of the front door`);
    if (typeof content !== "string") throw bad(`${name} has no text`);
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw bad(`${name} is larger than 2 MB`);
    if (content.includes("\0")) throw bad(`${name} contains a NUL byte`);
    files.set(name, content);
  }

  const connectors = [];
  for (const c of frontDoor ? [] : Array.isArray(e.connectors) ? e.connectors : []) {
    const id = String(c?.id ?? "");
    if (!CONNECTOR_ID_RE.test(id)) throw bad(`"${id.slice(0, 40)}" is not a valid connector id`);
    if (connectors.some((x) => x.id === id)) throw bad(`connector ${id} is listed twice`);
    const token = typeof c.token === "string" ? c.token.trim() : "";
    if (!TOKEN_RE.test(token)) throw bad(`connector ${id} has no valid tunnel token`);
    // Shown in the unit's Description= only: printable, one line, short.
    const name = String(c.name ?? "").replace(/[^A-Za-z0-9 _.,()'-]/g, "").trim().slice(0, 80) || id;
    connectors.push({ id, name, token });
  }

  const shims = [];
  for (const s of frontDoor ? [] : Array.isArray(e.shims) ? e.shims : []) {
    const name = String(s?.name ?? "");
    if (!SHIM_NAME_RE.test(name)) throw bad(`"${name.slice(0, 40)}" is not a valid shim name`);
    const listenPort = checkPort(s.listenPort, `shim ${name}'s listenPort`);
    if (listenPort === 80 || listenPort === 443) throw bad(`shim ${name} cannot listen on port ${listenPort} (the front door uses it)`);
    if (shims.some((x) => x.listenPort === listenPort)) throw bad(`two shims listen on port ${listenPort}`);
    // `targets` (Phase 2: every panel node) or the single `target` of 3.7.0.
    const raw = Array.isArray(s.targets) && s.targets.length ? s.targets : [s.target];
    if (raw.length > MAX_SHIM_TARGETS) throw bad(`shim ${name} has more than ${MAX_SHIM_TARGETS} targets`);
    const targets = [];
    let scheme = null;
    for (const t of raw) {
      const m = TARGET_RE.exec(String(t ?? ""));
      if (!m) throw bad(`shim ${name}'s target must look like http(s)://host:port`);
      const host = m[2].startsWith("[") ? m[2] : m[2].toLowerCase();
      if (host.startsWith("[") && net.isIP(host.slice(1, -1)) !== 6) throw bad(`shim ${name}'s target has an invalid IPv6 address`);
      const port = checkPort(m[3], `shim ${name}'s target`);
      if (scheme && scheme !== m[1]) throw bad(`shim ${name}'s targets mix http and https`);
      scheme = m[1];
      const url = `${m[1]}://${host}:${port}`;
      if (!targets.includes(url)) targets.push(url);
    }
    shims.push({ name, listenPort, listenTls: !!s.listenTls, target: targets[0], targets, https: scheme === "https" });
  }
  const notes = [];
  if (frontDoor && ((Array.isArray(e.shims) && e.shims.length) || (Array.isArray(e.connectors) && e.connectors.length))) {
    notes.push("Front door mode: the shims and connectors in the payload are not used on the main server.");
  }

  return { hash, allowFrom, ignored, notes, frontDoor, hosts, dbCutover, edge: { files, connectors, shims } };
}

// --------------------------------------------------------------- the task

export async function clusterSync(payload, o) {
  const log = o.log || NOOP;
  const p = checkPayload(payload);
  const P = edgePaths(o.dataDir);
  const prev = readEdgeState(o.dataDir);
  const errors = [];
  const checkAbort = () => {
    if (o.signal?.aborted) {
      const err = new Error("Cancelled.");
      err.aborted = true;
      throw err;
    }
  };

  // 1. Database address (Phase 3) first — after a database failover it is the urgent part:
  // the managed /etc/hosts block, then (3.10) cut every client off the old primary.
  let hosts;
  if (p.hosts !== undefined) {
    log("── /etc/hosts ──");
    try {
      hosts = await applyHostsBlock(Object.fromEntries(p.hosts), { log, dryRun: sys.DRY_RUN, file: sys.DRY_RUN ? path.join(o.dataDir, "edge-dry-run", "hosts") : HOSTS_FILE });
    } catch (err) {
      errors.push(`hosts: ${err.message}`);
      log(`!! ${err.message}`);
      hosts = { error: err.message };
    }
  }
  let dbCutover;
  if (p.dbCutover !== undefined) {
    log("── Database cut-over ──");
    try {
      dbCutover = await applyDbCutover(p.dbCutover, { log, dataDir: o.dataDir });
    } catch (err) {
      errors.push(`dbCutover: ${err.message}`);
      log(`!! ${err.message}`);
      dbCutover = { error: err.message };
    }
  }
  checkAbort();

  // 2. Firewall — on every agent, edge or not: the edges must reach its site ports.
  log("── Firewall ──");
  const firewall = await syncFirewall(p.allowFrom, log).catch((err) => {
    errors.push(`firewall: ${err.message}`);
    return { error: err.message };
  });
  if (p.ignored.length) log(`Ignored allowFrom entries that are not IP addresses: ${p.ignored.join(", ")}`);
  for (const n of p.notes) log(n);
  checkAbort();

  const state = { ...prev, edge: !!p.edge, frontDoor: !!p.edge && p.frontDoor, hash: p.hash, appliedAt: new Date().toISOString() };
  if (hosts && !hosts.error) {
    state.hosts = hosts.entries;
    state.hostsAppliedAt = state.appliedAt;
  }
  if (dbCutover && !dbCutover.error) state.dbCutover = dbCutover;
  let connectors = [];
  let shims = [];

  if (p.edge && p.frontDoor) {
    // 2'. Main's front door while another server runs the active panel: the
    // panel's usual fcc-*.conf set (Let's Encrypt paths), written over main's
    // own files. No catch-all, no shims, no connectors (main's panel process
    // runs those itself when it is active again).
    log("── nginx (main server front door) ──");
    try {
      const r = await applyEdgeFiles(P.conf, new Map(p.edge.files), frontDoorManaged(P.conf, prev), log);
      state.files = [...p.edge.files.keys()].sort();
      state.shims = [];
      state.nginx = true;
      log(r.changed ? `nginx: ${r.changed} file(s) changed${r.tested ? ", tested and reloaded" : ""}.` : "nginx configuration already up to date.");
    } catch (err) {
      if (err.aborted) throw err;
      state.nginx = false;
      errors.push(`nginx: ${err.message}`);
      log(`!! ${err.message}`);
    }
    if (Object.keys(prev.connectors || {}).length) {
      const r = await syncConnectors([], prev, P, o, log);
      for (const c of r.results) if (c.error) errors.push(`connector ${c.id}: ${c.error}`);
    }
    state.connectors = {};
  } else if (p.edge) {
    // 2. nginx front door
    log("── nginx ──");
    try {
      await ensureEdgeTls(P, log);
      checkAbort();
      const want = new Map(p.edge.files);
      want.set(DEFAULT_FILE, renderEdgeDefault(await nginxVersion()));
      for (const s of p.edge.shims) want.set(`fcc-edge-shim-${s.listenPort}.conf`, renderShim(s));
      const r = await applyEdgeFiles(P.conf, want, managedFiles(P.conf, prev), log);
      state.files = [...want.keys()].sort();
      state.nginx = true;
      state.nginxOkOnce = true;
      log(r.changed ? `nginx: ${r.changed} file(s) changed${r.tested ? ", tested and reloaded" : ""}.` : "nginx configuration already up to date.");
    } catch (err) {
      if (err.aborted) throw err;
      state.nginx = false;
      errors.push(`nginx: ${err.message}`);
      log(`!! ${err.message}`);
    }
    shims = p.edge.shims.map((s) => ({ name: s.name, listenPort: s.listenPort, listenTls: s.listenTls, target: s.target, ...(s.targets.length > 1 ? { targets: s.targets } : {}) }));
    if (state.nginx) state.shims = shims.map(({ name, listenPort, listenTls }) => ({ name, listenPort, listenTls }));
    checkAbort();

    // 3. Tunnel connector replicas — only once this server has a working front door.
    log("── Cloudflare Tunnel connectors ──");
    if (!state.nginxOkOnce) {
      log("Connectors are not started until nginx has accepted the edge configuration once.");
      connectors = p.edge.connectors.map((c) => ({ id: c.id, name: c.name, active: false, error: "waiting for nginx" }));
    } else {
      const r = await syncConnectors(p.edge.connectors, prev, P, o, log);
      connectors = r.results;
      state.connectors = r.ports;
      for (const c of connectors) if (c.error) errors.push(`connector ${c.id}: ${c.error}`);
    }
  } else if (prev.frontDoor) {
    // Main's own front door files are not ours to delete: the panel on main
    // rewrites them itself once it is the active panel again.
    log("── Front door mode ended ──");
    log("Main's nginx files are left in place; the panel on this server manages them again.");
    state.files = [];
    state.shims = [];
    state.connectors = {};
    state.nginx = false;
  } else {
    // 4. Not an edge (any more): take everything down, leave local vhosts alone.
    log("── Removing edge configuration ──");
    const r = await syncConnectors([], prev, P, o, log);
    state.connectors = {};
    for (const c of r.results) if (c.error) errors.push(`connector ${c.id}: ${c.error}`);
    try {
      const managed = managedFiles(P.conf, prev);
      const res = await applyEdgeFiles(P.conf, new Map(), managed, log);
      state.files = [];
      state.shims = [];
      state.nginx = false;
      state.nginxOkOnce = false;
      log(res.changed ? `Removed ${res.changed} edge nginx file(s).` : "No edge nginx files to remove.");
      if (!sys.DRY_RUN && exists(P.tls)) {
        fs.rmSync(P.tls, { recursive: true, force: true });
        log(`Removed ${P.tls}`);
      }
    } catch (err) {
      if (err.aborted) throw err;
      errors.push(`nginx: ${err.message}`);
      log(`!! ${err.message}`);
    }
  }

  // 5. Persist.
  state.error = errors.length ? errors.join("\n") : null;
  try {
    writeEdgeState(P.state, state);
  } catch (err) {
    log(`!! Could not save ${P.state}: ${err.message}`);
  }
  if (state.error) log(`Finished with problems:\n${state.error}`);
  else log(p.edge ? (p.frontDoor ? "Front door configuration applied." : "Edge configuration applied.") : "Done.");

  return {
    hash: state.hash,
    appliedAt: state.appliedAt,
    ...(state.frontDoor ? { frontDoor: true } : {}),
    nginx: !!p.edge && state.nginx,
    error: state.error,
    connectors,
    shims,
    firewall,
    ...(hosts !== undefined ? { hosts } : {}),
    ...(dbCutover !== undefined ? { dbCutover } : {}),
    ...(sys.DRY_RUN ? { dryRun: true } : {}),
  };
}

/**
 * This agent server just became the main server (3.12.0 "Change the main
 * server"): its panel now runs the front door and the tunnel connectors itself.
 * Take down what fcc-node set up as an edge — connector replica units, the
 * catch-all default, shims, the edge TLS pair — but keep the fcc-<siteId>.conf
 * files: the panel (loadbalancer.mjs) has already rewritten them as main's own.
 * `agentDataDir` is the old agent's data folder (edge-state.json lives there).
 */
export async function retireEdge(agentDataDir, { log = NOOP } = {}) {
  const P = edgePaths(agentDataDir);
  const prev = readEdgeState(agentDataDir);
  const errors = [];
  const r = await syncConnectors([], prev, P, { log, dataDir: agentDataDir }, log);
  for (const c of r.results) if (c.error) errors.push(`connector ${c.id}: ${c.error}`);
  const extras = new Set();
  try {
    for (const f of fs.readdirSync(P.conf)) if (f === DEFAULT_FILE || SHIM_RE.test(f)) extras.add(f);
  } catch {
    /* no conf dir */
  }
  try {
    const res = await applyEdgeFiles(P.conf, new Map(), extras, log);
    log(res.changed ? `Removed ${res.changed} edge-only nginx file(s).` : "No edge-only nginx files left.");
  } catch (err) {
    errors.push(`nginx: ${err.message}`);
  }
  if (!sys.DRY_RUN && exists(P.tls)) fs.rmSync(P.tls, { recursive: true, force: true });
  try {
    writeEdgeState(P.state, { ...prev, edge: false, frontDoor: false, files: [], shims: [], connectors: {}, nginx: false, nginxOkOnce: false, error: null, retiredAt: new Date().toISOString() });
  } catch {
    /* best effort */
  }
  return { connectorsStopped: Object.keys(prev.connectors || {}).length, error: errors.length ? errors.join("\n") : null };
}

// ------------------------------------------------------- database cut-over
//
// After a database failover the old primary may be half alive (a frozen VM, a
// network partition) and clients may still hold connections to it, or reconnect
// to it from a cached address. On every server: refuse new connections to the
// old primary's addresses with a TCP RST (a firewall rule, so a client fails
// over in milliseconds instead of waiting for a TCP timeout), then kill the
// existing ones (ss -K). Only connections *to* those addresses on the database
// port are touched: the old primary's own rebuild pulls from the new primary,
// and its agent and SSH are unaffected.

export const CUTOVER_COMMENT = "fcc-db-cutover";
const CUTOVER_FILE = "db-cutover.json";
const NFT_TABLE = "fcc_db_cutover";

/** { blockIps, port } | null → { blockIps: [ip…] sorted, port }; throws on anything else. */
export function checkDbCutover(v) {
  if (v == null) return { blockIps: [], port: 3306 };
  if (typeof v !== "object" || Array.isArray(v)) throw new Error("dbCutover must be an object { blockIps, port } or null");
  const port = v.port === undefined ? 3306 : Number(v.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`dbCutover.port is not a valid port (${String(v.port).slice(0, 20)})`);
  const list = v.blockIps == null ? [] : v.blockIps;
  if (!Array.isArray(list)) throw new Error("dbCutover.blockIps must be a list of IP addresses");
  if (list.length > 32) throw new Error("dbCutover.blockIps has too many entries");
  const ips = new Set();
  for (const raw of list) {
    const ip = String(raw ?? "").trim();
    if (!net.isIP(ip)) throw new Error(`dbCutover: ${JSON.stringify(ip.slice(0, 60))} is not an IP address`);
    if (ip === "0.0.0.0" || ip === "::") throw new Error(`dbCutover: ${ip} cannot be blocked`);
    ips.add(ip);
  }
  return { blockIps: [...ips].sort(), port };
}

function readCutoverState(dataDir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dataDir, CUTOVER_FILE), "utf8"));
    return checkDbCutover({ blockIps: s?.blockIps || [], port: s?.port });
  } catch {
    return { blockIps: [], port: 3306 };
  }
}

const iptablesRule = (ip, port) => ["OUTPUT", "-p", "tcp", "-d", ip, "--dport", String(port), "-m", "comment", "--comment", CUTOVER_COMMENT, "-j", "REJECT", "--reject-with", "tcp-reset"];

function renderNftTable(blockIps, port) {
  const rules = blockIps.map((ip) => `    ${net.isIPv6(ip) ? "ip6" : "ip"} daddr ${ip} tcp dport ${port} reject with tcp reset comment "${CUTOVER_COMMENT}"`);
  // "add table" + "delete table" first: the script works whether or not the table exists.
  let out = `add table inet ${NFT_TABLE}\ndelete table inet ${NFT_TABLE}\n`;
  if (rules.length) out += `table inet ${NFT_TABLE} {\n  chain out {\n    type filter hook output priority 0; policy accept;\n${rules.join("\n")}\n  }\n}\n`;
  return out;
}

/**
 * Make the cut-over rules be exactly `spec` (null / [] removes them), and kill
 * existing connections to newly blocked addresses. Idempotent: rules are
 * re-checked every time (a reboot drops them), connections are only killed for
 * addresses that were not blocked before. → { blockIps, port, backend, killed, remaining, notes, appliedAt }
 */
export async function applyDbCutover(spec, { log = NOOP, dataDir, dryRun = sys.DRY_RUN } = {}) {
  const want = checkDbCutover(spec);
  const prev = dataDir ? readCutoverState(dataDir) : { blockIps: [], port: want.port };
  const samePort = prev.port === want.port;
  const added = want.blockIps.filter((ip) => !samePort || !prev.blockIps.includes(ip));
  const removed = prev.blockIps.filter((ip) => !samePort || !want.blockIps.includes(ip));
  const notes = [];
  const run = (cmd, args, extra = {}) => sys.run(cmd, args, { allowFail: true, timeoutMs: 10_000, log: dryRun ? log : null, ...extra });

  if (process.env.FCC_SKIP_UFW === "1") {
    log("FCC_SKIP_UFW=1 — no database cut-over firewall rules.");
    notes.push("firewall skipped (FCC_SKIP_UFW=1)");
  }
  const skipFw = process.env.FCC_SKIP_UFW === "1";
  const backend = skipFw ? null : dryRun ? "iptables" : sys.which("iptables") ? "iptables" : sys.which("nft") ? "nft" : null;
  if (!skipFw && !backend && (want.blockIps.length || prev.blockIps.length)) {
    notes.push("neither iptables nor nft is installed — connections are only reset, new ones are not refused");
    log("!! Neither iptables nor nft is installed: new connections to the old database primary cannot be refused here.");
  }

  // 1. Refuse new connections first, so a killed client cannot reconnect to the old primary.
  if (backend === "iptables") {
    for (const ip of [...new Set([...removed, ...want.blockIps])]) {
      const bin = net.isIPv6(ip) ? "ip6tables" : "iptables";
      if (!dryRun && !sys.which(bin)) {
        notes.push(`${bin} missing — ${ip} not handled`);
        continue;
      }
      const spec_ = iptablesRule(ip, removed.includes(ip) && !samePort ? prev.port : want.port);
      if (removed.includes(ip)) {
        // Delete every copy of our rule (there should be one).
        for (let i = 0; i < 5; i++) {
          const has = await run(bin, ["-w", "-C", ...spec_]);
          if (!dryRun && has.code !== 0) break;
          await run(bin, ["-w", "-D", ...spec_]);
          if (dryRun) break;
        }
        log(`${dryRun ? "[dry-run] " : ""}No longer refusing connections to ${ip}:${prev.port}.`);
        if (!want.blockIps.includes(ip)) continue;
      }
      const has = await run(bin, ["-w", "-C", ...iptablesRule(ip, want.port)]);
      if (dryRun || has.code !== 0) {
        const r = await run(bin, ["-w", "-I", ...iptablesRule(ip, want.port).slice(0, 1), "1", ...iptablesRule(ip, want.port).slice(1)]);
        if (!dryRun && r.code !== 0) notes.push(`${bin}: could not add the rule for ${ip} (${(r.stderr || "").trim().slice(0, 200)})`);
        else log(`${dryRun ? "[dry-run] " : ""}Refusing new connections to ${ip}:${want.port} (TCP reset).`);
      }
    }
  } else if (backend === "nft") {
    const r = await run("nft", ["-f", "-"], { input: renderNftTable(want.blockIps, want.port) });
    if (r.code !== 0) notes.push(`nft: ${(r.stderr || "").trim().slice(0, 200)}`);
    else log(want.blockIps.length ? `Refusing new connections to ${want.blockIps.join(", ")} on port ${want.port} (nft table ${NFT_TABLE}).` : `nft table ${NFT_TABLE} removed.`);
  }

  // 2. Kill what is already connected to a newly blocked address.
  const killed = [];
  let remaining = 0;
  if (added.length) {
    if (!dryRun && !sys.which("ss")) {
      notes.push("ss is not installed — existing connections were not reset");
    } else {
      for (const ip of added) {
        const dst = net.isIPv6(ip) ? `[${ip}]` : ip;
        await run("ss", ["-K", "-t", "dst", dst, "dport", "=", `:${want.port}`]);
        killed.push(ip);
        if (!dryRun) {
          const left = await run("ss", ["-H", "-t", "-n", "state", "established", "dst", dst, "dport", "=", `:${want.port}`]);
          const n = String(left.stdout || "").split("\n").filter((l) => l.trim()).length;
          if (n) {
            remaining += n;
            notes.push(`${n} connection(s) to ${ip}:${want.port} survived ss -K — this kernel lacks sock-destroy (CONFIG_INET_DIAG_DESTROY); they end when the client next uses them`);
          }
        }
      }
      log(`${dryRun ? "[dry-run] " : ""}Reset existing connections to ${added.join(", ")} on port ${want.port}${remaining ? ` (${remaining} could not be reset)` : ""}.`);
    }
  } else if (!want.blockIps.length && !removed.length) {
    log("No database cut-over in force.");
  } else if (!added.length && want.blockIps.length) {
    log(`Database cut-over unchanged: refusing ${want.blockIps.join(", ")} on port ${want.port}.`);
  }
  for (const n of notes) log(`note: ${n}`);

  const out = { blockIps: want.blockIps, port: want.port, backend, killed, remaining, notes, appliedAt: new Date().toISOString(), ...(dryRun ? { dryRun: true } : {}) };
  if (dataDir) {
    try {
      ensureDir(dataDir);
      const file = path.join(dataDir, CUTOVER_FILE);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      log(`!! could not save ${CUTOVER_FILE}: ${err.message}`);
    }
  }
  return out;
}

// ------------------------------------------------------------ /etc/hosts
//
// One managed block, rewritten atomically; every other line is kept exactly.

export const HOSTS_FILE = "/etc/hosts";
export const HOSTS_BEGIN = "# >>> forthway command center >>>";
export const HOSTS_END = "# <<< forthway command center <<<";
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** { name: ip } | null → sorted [[name, ip]]; throws on anything that is not a plain host name / IP. */
export function checkHostsMap(map) {
  if (map == null) return [];
  if (typeof map !== "object" || Array.isArray(map)) throw new Error("hosts must be an object { name: ip } or null");
  const out = [];
  const entries = Object.entries(map);
  if (entries.length > 64) throw new Error("hosts has too many entries");
  for (const [rawName, rawIp] of entries) {
    const name = String(rawName).trim().toLowerCase();
    const ip = String(rawIp ?? "").trim();
    if (!HOSTNAME_RE.test(name) || name === "localhost") throw new Error(`hosts: ${JSON.stringify(String(rawName).slice(0, 80))} is not an allowed host name`);
    if (!net.isIP(ip)) throw new Error(`hosts: ${JSON.stringify(ip.slice(0, 80))} (for ${name}) is not an IP address`);
    out.push([name, ip]);
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

/** The whole hosts file with our block replaced by `entries` (removed when empty). Pure. */
export function renderHostsFile(current, entries) {
  const lines = String(current ?? "").split("\n");
  const hadTrailingNewline = String(current ?? "").endsWith("\n");
  if (hadTrailingNewline) lines.pop();
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== HOSTS_BEGIN) {
      kept.push(lines[i]);
      continue;
    }
    const end = lines.findIndex((l, j) => j > i && l.trim() === HOSTS_END);
    if (end === -1) continue; // a lone begin marker: drop just that line
    if (kept.length && kept[kept.length - 1].trim() === "") kept.pop(); // the blank line we put before it
    i = end;
  }
  while (kept.length && kept[kept.length - 1].trim() === "" && entries.length) kept.pop();
  if (entries.length) {
    if (kept.length) kept.push("");
    kept.push(HOSTS_BEGIN, "# Managed by Forthway Command Center (database address) — edits inside this block are lost.");
    for (const [name, ip] of entries) kept.push(`${ip}\t${name}`);
    kept.push(HOSTS_END);
  }
  return kept.length ? kept.join("\n") + "\n" : "";
}

/**
 * Apply the managed block (`map` null/{} removes it). Writes only when the
 * content changes, atomically (temp file + rename in the same directory,
 * falling back to an in-place write where /etc/hosts is a bind mount, as in
 * containers). With dryRun and no `file`, only logs. → { changed, entries, file }
 */
export async function applyHostsBlock(map, { log = NOOP, dryRun = sys.DRY_RUN, file } = {}) {
  const entries = checkHostsMap(map);
  const target = file || (dryRun ? null : HOSTS_FILE);
  const shown = entries.length ? entries.map(([n, ip]) => `${n} → ${ip}`).join(", ") : "(no entries — block removed)";
  if (!target) {
    log(`[dry-run] /etc/hosts block: ${shown}`);
    return { changed: null, entries: Object.fromEntries(entries), file: null, dryRun: true };
  }
  let current = "";
  let mode = 0o644;
  try {
    current = fs.readFileSync(target, "utf8");
    mode = fs.statSync(target).mode & 0o777;
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error(`cannot read ${target}: ${err.message}`);
  }
  const next = renderHostsFile(current, entries);
  if (next === current) {
    log(`${target}: already up to date (${shown}).`);
    return { changed: false, entries: Object.fromEntries(entries), file: target, ...(dryRun ? { dryRun: true } : {}) };
  }
  ensureDir(path.dirname(target));
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.fcc.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, next, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (!["EBUSY", "EXDEV", "EPERM", "EACCES"].includes(err.code)) throw new Error(`cannot write ${target}: ${err.message}`);
    fs.writeFileSync(target, next); // bind-mounted file: rename is not possible
  }
  log(`${dryRun ? "[dry-run] " : ""}${target}: ${shown}.`);
  return { changed: true, entries: Object.fromEntries(entries), file: target, ...(dryRun ? { dryRun: true } : {}) };
}

// --------------------------------------------------------------- firewall

async function syncFirewall(allowFrom, log) {
  const r = await syncUfwRules({ allowFrom, ports: SITE_PORTS, comment: UFW_COMMENT, log });
  if (!r.active) return r;
  const { added, removed } = r;
  log(
    added.length || removed.length
      ? `Site ports ${SITE_PORTS}: opened to ${added.join(", ") || "nobody new"}; closed to ${removed.join(", ") || "nobody"}.`
      : `Site ports ${SITE_PORTS} already open to ${allowFrom.length ? allowFrom.join(", ") : "no edge servers"}.`,
  );
  return { active: true, allowFrom, added, removed };
}

/**
 * Make the ufw rules tagged `comment` be exactly "allow `ports`/tcp from each
 * of `allowFrom`" (an empty list removes them all). Rules with other comments
 * are never touched. Resolves { active, added, removed } or { skipped } / { active: false }.
 */
export async function syncUfwRules({ allowFrom, ports, comment, log }) {
  if (process.env.FCC_SKIP_UFW === "1") {
    log("FCC_SKIP_UFW=1 — the firewall is left alone.");
    return { skipped: true };
  }
  if (!sys.DRY_RUN && !sys.which("ufw")) {
    log("ufw is not installed — no firewall rules to manage.");
    return { active: false };
  }
  const st = await sys.run("ufw", ["status"], { allowFail: true, timeoutMs: 30_000, log: sys.DRY_RUN ? log : null });
  if (!sys.DRY_RUN && !/Status:\s*active/i.test(st.stdout)) {
    log("ufw is not active — no firewall rules to manage.");
    return { active: false };
  }
  // "3000:3999/tcp   ALLOW   10.0.0.5   # fcc sites from edge"  (ALLOW IN with `ufw status verbose`)
  const have = []; // [{ ip, ports }]
  for (const line of String(st.stdout || "").split("\n")) {
    const m = /^(\S+)\s+ALLOW(?:\s+IN)?\s+(\S+)\s+#\s*(.*?)\s*$/.exec(line.trim());
    if (!m || m[3] !== comment || !net.isIP(m[2])) continue;
    const p = m[1].replace(/\/tcp$/, "");
    if (/^\d{1,5}(:\d{1,5})?$/.test(p)) have.push({ ip: m[2], ports: p });
  }
  const rule = (ip, p) => ["from", ip, "to", "any", "port", p, "proto", "tcp"];
  const added = [];
  const removed = [];
  for (const ip of allowFrom) {
    if (have.some((h) => h.ip === ip && h.ports === String(ports))) continue;
    await sys.run("ufw", ["allow", ...rule(ip, String(ports)), "comment", comment], { timeoutMs: 30_000, log });
    added.push(ip);
  }
  for (const h of have) {
    if (allowFrom.includes(h.ip) && h.ports === String(ports)) continue;
    await sys.run("ufw", ["--force", "delete", "allow", ...rule(h.ip, h.ports)], { timeoutMs: 30_000, log });
    removed.push(h.ip);
  }
  return { active: true, added, removed };
}

// ------------------------------------------------------------------ nginx

async function nginxVersion() {
  if (sys.DRY_RUN || !sys.which("nginx")) return null;
  const r = await sys.run("nginx", ["-v"], { allowFail: true, timeoutMs: 15_000 }).catch(() => null);
  const m = /nginx\/(\d+)\.(\d+)\.(\d+)/.exec(`${r?.stderr || ""} ${r?.stdout || ""}`);
  return m ? m.slice(1).map(Number) : null;
}

/** nginx ≥ 1.19.4 can refuse a TLS handshake without a certificate. */
function canRejectHandshake(v) {
  if (!v) return sys.DRY_RUN; // unknown on a real server: use the self-signed pair, which always works
  const [a, b, c] = v;
  return a > 1 || (a === 1 && (b > 19 || (b === 19 && c >= 4)));
}

const hasIpv6 = () => !nginxIsLive() || exists("/proc/net/if_inet6");

function renderEdgeDefault(version) {
  const v6 = hasIpv6();
  const reject = canRejectHandshake(version);
  return [
    `# Managed by Forthway Command Center — do not edit by hand.`,
    `# Edge node catch-all: requests for hostnames this server does not serve are dropped,`,
    `# plus the variables the edge shims (fcc-edge-shim-*.conf) use.`,
    `map $http_upgrade $fcc_edge_upgrade {`,
    `    default upgrade;`,
    `    ""      close;`,
    `}`,
    `map $http_x_forwarded_proto $fcc_edge_proto {`,
    `    default $http_x_forwarded_proto;`,
    `    ""      $scheme;`,
    `}`,
    `map $http_x_forwarded_host $fcc_edge_fwd_host {`,
    `    default $http_x_forwarded_host;`,
    `    ""      $host;`,
    `}`,
    ``,
    `server {`,
    `    listen 80 default_server;`,
    v6 ? `    listen [::]:80 default_server;` : null,
    `    listen 443 ssl default_server;`,
    v6 ? `    listen [::]:443 ssl default_server;` : null,
    `    server_name _;`,
    ...(reject ? [`    ssl_reject_handshake on;`] : [`    ssl_certificate ${EDGE_CRT};`, `    ssl_certificate_key ${EDGE_KEY};`]),
    `    access_log off;`,
    `    return 444;`,
    `}`,
    ``,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

function renderShim(s) {
  const many = Array.isArray(s.targets) && s.targets.length > 1;
  const upstream = `fcc_edge_shim_${s.listenPort}`;
  return [
    `# Managed by Forthway Command Center — do not edit by hand.`,
    `# Edge shim "${s.name}": tunnel routes for 127.0.0.1:${s.listenPort} reach this replica too,`,
    many ? `# so pass them on to a panel node (any of them works: standbys forward to the active one).` : `# so pass them on to the main server.`,
    ...(many
      ? [
          `upstream ${upstream} {`,
          ...s.targets.map((t) => `    server ${t.replace(/^https?:\/\//, "")} max_fails=1 fail_timeout=5s;`),
          `}`,
        ]
      : []),
    `server {`,
    `    listen 127.0.0.1:${s.listenPort}${s.listenTls ? " ssl" : ""};`,
    `    server_name _;`,
    ...(s.listenTls ? [`    ssl_certificate ${EDGE_CRT};`, `    ssl_certificate_key ${EDGE_KEY};`] : []),
    `    access_log off;`,
    `    client_max_body_size 0;`,
    `    server_tokens off;`,
    ``,
    `    location / {`,
    `        proxy_pass ${many ? `${s.https ? "https" : "http"}://${upstream}` : s.target};`,
    ...(many ? [`        proxy_connect_timeout 3s;`, `        proxy_next_upstream error timeout http_502 http_503;`] : []),
    `        proxy_http_version 1.1;`,
    `        proxy_set_header Host $host;`,
    `        proxy_set_header Upgrade $http_upgrade;`,
    `        proxy_set_header Connection $fcc_edge_upgrade;`,
    `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
    `        proxy_set_header X-Forwarded-Proto $fcc_edge_proto;`,
    `        proxy_set_header X-Forwarded-Host $fcc_edge_fwd_host;`,
    `        proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;`,
    `        # SSE / long requests (deploy logs, backups) stream straight through.`,
    `        proxy_buffering off;`,
    `        proxy_request_buffering off;`,
    `        proxy_read_timeout 1h;`,
    `        proxy_send_timeout 1h;`,
    ...(s.https ? [`        proxy_ssl_verify off;`, ...(many ? [] : [`        proxy_ssl_server_name on;`])] : []),
    `    }`,
    `}`,
    ``,
  ].join("\n");
}

/**
 * Files in conf.d that belong to the edge: what the last sync wrote, plus the
 * names only the edge ever generates (in case edge-state.json was lost).
 * Never fcc-app-* (local static/php vhosts).
 */
function managedFiles(dir, prev) {
  const out = new Set(prev.files);
  try {
    for (const f of fs.readdirSync(dir)) if (f === DEFAULT_FILE || SHIM_RE.test(f)) out.add(f);
  } catch {
    /* no dir yet */
  }
  for (const f of out) if (!FILE_RE.test(f) || f.startsWith("fcc-app-")) out.delete(f);
  return out;
}

/**
 * Files in conf.d that make up main's front door: every fcc-*.conf except the
 * local website vhosts (fcc-app-*) and DATA's phpMyAdmin vhost — the same set
 * panel/lib/loadbalancer.mjs owns on main — plus what the last sync wrote.
 */
function frontDoorManaged(dir, prev) {
  const out = new Set(prev.files);
  try {
    for (const f of fs.readdirSync(dir)) if (FILE_RE.test(f)) out.add(f);
  } catch {
    /* no dir yet */
  }
  for (const f of out) if (!FILE_RE.test(f) || f.startsWith("fcc-app-") || f === PMA_FILE) out.delete(f);
  return out;
}

/**
 * Write `want` (name → content) into `dir` as one set and delete the managed
 * files that are no longer wanted; one `nginx -t`, one reload. On any failure
 * every touched file is put back as it was and the error is thrown.
 */
async function applyEdgeFiles(dir, want, managed, log) {
  ensureDir(dir);
  const plan = new Map(want);
  for (const f of managed) if (!plan.has(f)) plan.set(f, null);
  const previous = new Map();
  let changed = 0;
  try {
    for (const [name, content] of plan) {
      if (!FILE_RE.test(name) || name.startsWith("fcc-app-")) continue; // belt and braces
      const file = path.join(dir, name);
      const prev = exists(file) ? fs.readFileSync(file, "utf8") : null;
      if (prev === content) continue;
      previous.set(file, prev);
      if (content === null) {
        fs.rmSync(file, { force: true });
        log(`removed ${file}`);
      } else {
        const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
        fs.writeFileSync(tmp, content, { mode: 0o644 });
        fs.renameSync(tmp, file);
        log(`wrote ${file}`);
      }
      changed++;
    }
    if (!changed) return { changed: 0, tested: false };
    if (!nginxIsLive()) {
      if (!sys.DRY_RUN) throw new Error(`nginx is not installed on ${os.hostname()} — re-run this server's install command.`);
      log(`[dry-run] nginx -t && systemctl reload nginx   (files are in ${dir})`);
      return { changed, tested: false };
    }
    const test = await sys.run("nginx", ["-t"], { allowFail: true, timeoutMs: 30_000 });
    if (test.code !== 0) {
      const why = (test.stderr || test.stdout || "").trim().split("\n").filter((l) => /emerg|error|fail/i.test(l)).join("\n");
      throw new Error(`nginx rejected the edge configuration; the previous files were restored.\n${why || test.stderr}`);
    }
    await reloadNginx(log);
    return { changed, tested: true };
  } catch (err) {
    for (const [file, prev] of previous) {
      try {
        if (prev === null) fs.rmSync(file, { force: true });
        else fs.writeFileSync(file, prev);
      } catch {
        /* best effort */
      }
    }
    if (previous.size && !/previous files were restored/.test(err.message)) log("Restored the previous nginx files.");
    throw err;
  }
}

/** Self-signed pair for the edge's TLS listeners (tunnel routes use noTLSVerify). */
async function ensureEdgeTls(P, log) {
  const crt = path.join(P.tls, "edge.crt");
  const key = path.join(P.tls, "edge.key");
  if (exists(crt) && exists(key)) return;
  if (!sys.DRY_RUN && !sys.which("openssl")) throw new Error(`openssl is not installed on ${os.hostname()} — re-run this server's install command (or apt install openssl).`);
  if (!sys.DRY_RUN) fs.mkdirSync(P.tls, { recursive: true, mode: 0o700 });
  log(`Creating a self-signed certificate for the edge in ${P.tls}`);
  await sys.run(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650", "-subj", "/CN=fcc-edge", "-keyout", key, "-out", crt],
    { timeoutMs: 60_000, log: sys.DRY_RUN ? log : null },
  );
  if (!sys.DRY_RUN) fs.chmodSync(key, 0o600);
}

// ------------------------------------------------------------- connectors

function cloudflaredAsset() {
  const a = { x64: "amd64", arm64: "arm64", arm: "arm" }[os.arch()];
  return a && os.platform() === "linux" ? `cloudflared-linux-${a}` : null;
}

async function ensureCloudflared(P, log) {
  if (exists(P.bin)) return P.bin;
  const asset = cloudflaredAsset();
  if (!asset) {
    const found = sys.which("cloudflared");
    if (found) return found;
    throw new Error(`there is no official cloudflared build for ${os.platform()}/${os.arch()} — install cloudflared yourself.`);
  }
  log(`Downloading ${asset}…`);
  fs.mkdirSync(path.dirname(P.bin), { recursive: true, mode: 0o700 });
  const res = await fetch(`${CLOUDFLARED_RELEASE}/${asset}`, { redirect: "follow", signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok) throw new Error(`could not download cloudflared: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000) throw new Error("the downloaded file is too small to be cloudflared");
  const tmp = `${P.bin}.partial`;
  fs.writeFileSync(tmp, buf, { mode: 0o755 });
  fs.renameSync(tmp, P.bin);
  log(`cloudflared saved to ${P.bin}`);
  return P.bin;
}

function renderUnit(c, bin, port, envFile) {
  return [
    `# Managed by Forthway Command Center — do not edit by hand.`,
    `[Unit]`,
    `Description=Forthway Command Center: Cloudflare Tunnel replica (${c.name})`,
    `After=network-online.target`,
    `Wants=network-online.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `# The tunnel token is in the environment file (mode 600), never on the command line.`,
    `EnvironmentFile=${envFile}`,
    `ExecStart=${bin} --no-autoupdate --metrics 127.0.0.1:${port} tunnel run`,
    `Restart=always`,
    `RestartSec=5`,
    `NoNewPrivileges=yes`,
    ``,
    `[Install]`,
    `WantedBy=multi-user.target`,
    ``,
  ].join("\n");
}

/** Write a file only when its content differs; true when it changed. */
function writeIfChanged(file, content, mode) {
  let prev = null;
  try {
    prev = fs.readFileSync(file, "utf8");
  } catch {
    /* new */
  }
  if (prev === content) {
    try {
      if ((fs.statSync(file).mode & 0o777) !== mode) fs.chmodSync(file, mode);
    } catch {
      /* best effort */
    }
    return false;
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode); // umask can strip bits from `mode`
  fs.renameSync(tmp, file);
  return true;
}

/**
 * Bring the fcc-cloudflared-<id> units in line with `list`. Metrics ports are
 * stable per connector id (kept in edge-state.json). A connector whose token
 * and unit did not change is left running as it is.
 * Returns { results: [{ id, name, metricsPort, active, ... }], ports: { id: { name, port } } }.
 */
async function syncConnectors(list, prev, P, o, log) {
  const results = [];
  const ports = {};
  const used = new Set();
  for (const c of list) {
    const p = Number(prev.connectors?.[c.id]?.port);
    if (Number.isInteger(p) && p >= METRICS_PORT_BASE && p <= 65535 && !used.has(p)) {
      ports[c.id] = { name: c.name, port: p };
      used.add(p);
    }
  }
  for (const c of list) {
    if (ports[c.id]) continue;
    let p = METRICS_PORT_BASE;
    while (used.has(p)) p++;
    ports[c.id] = { name: c.name, port: p };
    used.add(p);
  }

  // Units and env files on disk that are no longer wanted.
  const stale = new Set();
  for (const [dir, re] of [
    [P.units, UNIT_RE],
    [P.env, ENV_RE],
  ]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = re.exec(f);
        if (m && !ports[m[1]]) stale.add(m[1]);
      }
    } catch {
      /* no dir */
    }
  }
  for (const id of Object.keys(prev.connectors || {})) if (CONNECTOR_ID_RE.test(id) && !ports[id]) stale.add(id);

  if (!list.length && !stale.size) return { results, ports };
  const hasSystemd = sys.DRY_RUN || !!sys.which("systemctl");
  if (!hasSystemd) {
    for (const c of list) results.push({ id: c.id, name: c.name, metricsPort: ports[c.id].port, active: false, error: "systemd is not available on this server" });
    return { results, ports };
  }
  const ctl = (args, extra = {}) => sys.run("systemctl", args, { allowFail: true, timeoutMs: 60_000, log, ...extra });
  let daemonReload = false;

  for (const id of stale) {
    log(`Removing connector replica ${id}`);
    await ctl(["disable", "--now", unitName(id)]);
    fs.rmSync(path.join(P.units, unitName(id)), { force: true });
    fs.rmSync(path.join(P.env, `${id}.env`), { force: true });
    daemonReload = true;
  }

  let bin = null;
  let binError = null;
  if (list.length) {
    if (sys.DRY_RUN) {
      bin = P.bin;
      log(`[dry-run] would use ${P.bin} (downloaded from ${CLOUDFLARED_RELEASE} if missing)`);
    } else {
      try {
        bin = await ensureCloudflared(P, log);
      } catch (err) {
        binError = err.message;
        log(`!! ${err.message}`);
      }
    }
  }

  const todo = [];
  for (const c of list) {
    const port = ports[c.id].port;
    const r = { id: c.id, name: c.name, metricsPort: port, unit: unitName(c.id), active: false, error: null };
    results.push(r);
    if (!bin) {
      r.error = binError || "cloudflared is not installed";
      continue;
    }
    try {
      fs.mkdirSync(P.env, { recursive: true, mode: 0o700 });
      fs.mkdirSync(P.units, { recursive: true });
      const envFile = path.join(P.env, `${c.id}.env`);
      const envChanged = writeIfChanged(envFile, `TUNNEL_TOKEN=${c.token}\n`, 0o600);
      const unitChanged = writeIfChanged(path.join(P.units, unitName(c.id)), renderUnit(c, bin, port, envFile), 0o644);
      if (unitChanged) daemonReload = true;
      todo.push({ c, r, restart: envChanged || unitChanged });
    } catch (err) {
      r.error = `could not write its files: ${err.message}`;
    }
  }
  if (daemonReload) await ctl(["daemon-reload"]);

  for (const { c, r, restart } of todo) {
    if (o.signal?.aborted) break;
    const unit = unitName(c.id);
    try {
      if (restart) {
        log(`${unit}: configuration changed — (re)starting`);
        await ctl(["enable", unit], { log: NOOP });
        const s = await ctl(["restart", unit]);
        if (s.code !== 0) throw new Error(`systemctl restart ${unit} failed: ${(s.stderr || "").trim().split("\n").pop()}`);
      } else {
        const a = await ctl(["is-active", unit], { log: NOOP });
        if (sys.DRY_RUN || a.stdout.trim() !== "active") {
          const s = await ctl(["enable", "--now", unit]);
          if (s.code !== 0) throw new Error(`systemctl enable --now ${unit} failed: ${(s.stderr || "").trim().split("\n").pop()}`);
        }
      }
      if (sys.DRY_RUN) {
        Object.assign(r, { active: true, simulated: true });
      } else {
        const a = await ctl(["is-active", unit], { log: NOOP });
        r.active = a.stdout.trim() === "active";
        if (!r.active) r.error = `the unit is ${a.stdout.trim() || "not active"} — see: journalctl -u ${unit}`;
      }
      log(`${unit}: ${r.active ? "running" : "NOT running"} (metrics on 127.0.0.1:${r.metricsPort})`);
    } catch (err) {
      r.error = err.message;
      log(`!! ${err.message}`);
    }
  }
  return { results, ports };
}

// ------------------------------------------------------------ edge status

/** GET http(s)://127.0.0.1:<port><path>; resolves { status, body } or { error }. Never throws. */
function probe(port, { tls = false, path: p = "/", timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const mod = tls ? https : http;
    const req = mod.request(
      { host: "127.0.0.1", port, path: p, method: "GET", rejectUnauthorized: false, timeout: timeoutMs, headers: { "User-Agent": "fcc-node-edge-probe" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          if (body.length < 4096) body += d;
        });
        res.on("end", () => resolve({ status: res.statusCode, body }));
        res.on("error", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (err) => resolve({ error: err.code === "ECONNREFUSED" ? "nothing is listening" : err.message }));
    req.end();
  });
}

/**
 * The edge block of an /agent/metrics push: null when this server is not an
 * edge, else the last sync's outcome plus live connector/shim probes.
 */
export async function edgeStatus(dataDir) {
  const s = readEdgeState(dataDir);
  if (!s.edge) return null;
  const connectors = await Promise.all(
    Object.entries(s.connectors || {})
      .filter(([id]) => CONNECTOR_ID_RE.test(id))
      .map(async ([id, c]) => {
        if (sys.DRY_RUN) return { id, active: true, readyConnections: 4 };
        const port = Number(c?.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return { id, active: false, readyConnections: 0 };
        const r = await probe(port, { path: "/ready" });
        if (r.error) return { id, active: false, readyConnections: 0 };
        let ready = 0;
        try {
          ready = Number(JSON.parse(r.body).readyConnections) || 0;
        } catch {
          /* not json */
        }
        return { id, active: true, readyConnections: ready };
      }),
  );
  const shims = await Promise.all(
    (s.shims || [])
      .filter((x) => x && Number.isInteger(x.listenPort) && x.listenPort > 0 && x.listenPort < 65536)
      .map(async (x) => {
        if (sys.DRY_RUN) return { name: String(x.name), listenPort: x.listenPort, ok: true, error: null };
        const r = await probe(x.listenPort, { tls: !!x.listenTls });
        return { name: String(x.name), listenPort: x.listenPort, ok: !r.error, error: r.error || null };
      }),
  );
  return { hash: s.hash, appliedAt: s.appliedAt, error: s.error, nginx: !!s.nginx, connectors, shims, ...(s.frontDoor ? { frontDoor: true } : {}) };
}

/** Site ids whose front-door file (fcc-<siteId>.conf) this edge manages — for access-log shipping. */
export function edgeLogSites(dataDir) {
  const s = readEdgeState(dataDir);
  if (!s.edge) return [];
  const out = [];
  for (const f of s.files) {
    const m = /^fcc-([A-Za-z0-9_-]+)\.conf$/.exec(f);
    if (!m || f.startsWith("fcc-00-") || f.startsWith("fcc-app-") || f.startsWith("fcc-edge-") || f === "fcc-phpmyadmin.conf") continue;
    out.push(m[1]);
  }
  return out;
}


// ============================================================ panel nodes
//
// Phase 2 (docs/HA.md, "Tasks"): an edge can also run a standby copy of the
// panel. `panel.install` downloads the panel code from the active panel
// (GET /ha/code with this agent's token), unpacks it into /opt/fcc the way
// install.sh does (stage, check, swap), writes /var/lib/fcc/ha-local.json and
// the same fcc.service unit install.sh writes, and starts it. The new panel
// process boots as a follower and replicates everything else (db, config,
// secrets) from the leader itself. `panel.remove` undoes it but keeps the data
// directory (renamed), because it holds the panel's secrets.
//
// Under FCC_DRY_RUN=1 the code is still downloaded and checked, but everything
// lands in <dataDir>/panel-dry-run and systemctl/ufw are only logged.

const PANEL_CODE_DIR = "/opt/fcc";
const PANEL_DATA_DIR = "/var/lib/fcc";
const PANEL_SITES_DIR = "/srv/fcc/sites";
const PANEL_UNIT_FILE = "/etc/systemd/system/fcc.service";
const PANEL_USER_ENV = "/etc/fcc/fcc.env"; // install.sh's "extra environment" file — optional (EnvironmentFile=-)
const PANEL_UNIT = "fcc.service";
const PANEL_UFW_COMMENT = "fcc panel from cluster";
const PANEL_CODE_ITEMS = ["panel", "node", "shared", "scripts", "patches", "docs", "README.md", "install.sh", "LICENSE"];
const PANEL_REQUIRED = ["panel/server.mjs", "panel/lib/sys.mjs", "node/node-agent.mjs", "shared/tasks.mjs"];
const PANEL_MAX_ZIP = 300 * 1024 * 1024;
const CODE_URL_RE = /^\/ha\/code(?:\?[A-Za-z0-9=&._-]{0,200})?$/;
const DIRECT_URL_RE = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\]):(\d{1,5})\/?$/;

function panelPaths(dataDir) {
  const dry = sys.DRY_RUN ? path.join(dataDir, "panel-dry-run") : null;
  return {
    dry,
    code: dry ? path.join(dry, "opt-fcc") : PANEL_CODE_DIR,
    data: dry ? path.join(dry, "var-lib-fcc") : PANEL_DATA_DIR,
    unit: dry ? path.join(dry, "systemd", PANEL_UNIT) : PANEL_UNIT_FILE,
  };
}

function panelBad(msg) {
  return new Error(`panel.install: ${msg} — nothing was changed on ${os.hostname()}.`);
}

function abortIf(signal) {
  if (signal?.aborted) {
    const err = new Error("Cancelled.");
    err.aborted = true;
    throw err;
  }
}

function writeAtomic(file, content, mode) {
  ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

/** fcc.service exactly as install.sh writes it (minus what only main has: MySQL ordering, the panel domain). */
function renderPanelUnit({ nodeBin, port, host }) {
  return [
    `# Managed by Forthway Command Center (panel.install on this panel node) — rewritten on every install.`,
    `# Put your own additions in ${PANEL_USER_ENV} (or: systemctl edit fcc).`,
    `[Unit]`,
    `Description=Forthway Command Center`,
    `After=network-online.target nginx.service pm2-root.service`,
    `Wants=network-online.target pm2-root.service`,
    ``,
    `[Service]`,
    `Type=simple`,
    `User=root`,
    `WorkingDirectory=${PANEL_CODE_DIR}`,
    `Environment=NODE_ENV=production`,
    `Environment=FCC_DIR=${PANEL_CODE_DIR}`,
    `Environment=FCC_DATA_DIR=${PANEL_DATA_DIR}`,
    `Environment=FCC_SITES_DIR=${PANEL_SITES_DIR}`,
    `Environment=FCC_PORT=${port}`,
    `Environment=FCC_HOST=${host}`,
    `Environment=HOME=/root`,
    `Environment=PM2_HOME=/root/.pm2`,
    `Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    `EnvironmentFile=-${PANEL_USER_ENV}`,
    `ExecStart=${nodeBin} ${PANEL_CODE_DIR}/panel/server.mjs`,
    `# Exit code 75 (fencing / restart on new code) is a failure on purpose: Restart=always brings it back.`,
    `Restart=always`,
    `RestartSec=3`,
    `# Only the panel process is stopped on restart; websites run under pm2.`,
    `KillMode=process`,
    `TimeoutStopSec=20`,
    `LimitNOFILE=65535`,
    ``,
    `[Install]`,
    `WantedBy=multi-user.target`,
    ``,
  ].join("\n");
}

function checkPanelPayload(payload, o) {
  if (!payload || typeof payload !== "object") throw panelBad("the payload is missing");
  const codeUrl = String(payload.codeUrl ?? "/ha/code");
  if (!CODE_URL_RE.test(codeUrl)) throw panelBad(`codeUrl must be /ha/code on the panel (got ${codeUrl.slice(0, 80)})`);
  const m = DIRECT_URL_RE.exec(String(payload.directUrl ?? "").trim());
  if (!m) throw panelBad("directUrl must look like http(s)://host:port");
  const port = checkPort(payload.port ?? m[3], "port");
  if (port === 80 || port === 443) throw panelBad(`the panel cannot listen on port ${port} (the front door uses it)`);
  const host = String(payload.host ?? "0.0.0.0").trim();
  if (!(net.isIP(host) || host === "localhost")) throw panelBad(`host must be an IP address (got ${host.slice(0, 60)})`);
  const allowFrom = [];
  for (const ip of Array.isArray(payload.allowFrom) ? payload.allowFrom : []) {
    const s = String(ip ?? "").trim();
    if (net.isIP(s) && !allowFrom.includes(s)) allowFrom.push(s);
  }
  if (!o.panelUrl) throw panelBad("this agent does not know the panel's address");
  if (!o.authToken) throw panelBad("this agent has no token to download the code with");
  if (!o.serverId) throw panelBad("this agent does not know its server id");
  const directUrl = `${m[1]}://${m[2].toLowerCase()}:${Number(m[3])}`;
  // Phase 3: the MySQL client of the cluster's flavor (remote admin and dumps from this panel node).
  const mysqlFlavor = payload.mysqlFlavor == null || payload.mysqlFlavor === "" ? null : String(payload.mysqlFlavor);
  if (mysqlFlavor && mysqlFlavor !== "mysql" && mysqlFlavor !== "mariadb") throw panelBad(`mysqlFlavor must be "mysql" or "mariadb" (got ${mysqlFlavor.slice(0, 20)})`);
  return { codeUrl, directUrl, port, host, allowFrom, mysqlFlavor };
}

async function downloadPanelCode(url, token, signal, log) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener?.("abort", onAbort);
  const timer = setTimeout(() => ctrl.abort(), 10 * 60_000);
  try {
    log(`Downloading the panel code from ${url.origin}${url.pathname}…`);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "User-Agent": "fcc-node panel.install" }, signal: ctrl.signal });
    if (!res.ok) {
      let why = "";
      try {
        why = (await res.json())?.error || "";
      } catch {
        /* not json */
      }
      throw new Error(`could not download the panel code: HTTP ${res.status}${why ? ` (${why})` : ""}`);
    }
    const len = Number(res.headers.get("content-length"));
    if (len > PANEL_MAX_ZIP) throw new Error("the panel code archive is unexpectedly large");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > PANEL_MAX_ZIP) throw new Error("the panel code archive is unexpectedly large");
    const want = String(res.headers.get("x-fcc-sha256") || "").toLowerCase();
    const got = crypto.createHash("sha256").update(buf).digest("hex");
    if (want && want !== got) throw new Error("the panel code failed its sha256 check");
    log(`Downloaded ${Math.round(buf.length / 1024)} KB${want ? " (sha256 verified)" : ""}.`);
    return buf;
  } catch (err) {
    if (signal?.aborted) abortIf(signal);
    if (err.name === "AbortError") throw new Error("downloading the panel code timed out");
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

function nodeCheck(file) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["--check", file], { timeout: 60_000 }, (err, _out, stderr) => {
      if (err) reject(new Error(`${path.basename(file)} does not parse: ${String(stderr || err.message).trim().split("\n").slice(0, 3).join(" ")}`));
      else resolve();
    });
  });
}

/** Replace each item present in `stage` inside `root` (rename, same filesystem); put everything back on failure. */
function swapPanelCode(root, stage, items, log) {
  const oldDir = path.join(root, `.install-old.${Date.now()}`);
  fs.mkdirSync(oldDir, { recursive: true });
  const done = [];
  try {
    for (const item of items) {
      const from = path.join(stage, item);
      if (!exists(from)) continue;
      const live = path.join(root, item);
      const had = exists(live);
      if (had) fs.renameSync(live, path.join(oldDir, item));
      done.push({ item, had });
      fs.renameSync(from, live);
    }
  } catch (err) {
    log(`!! Swapping the code in failed (${err.message}) — putting the previous files back.`);
    for (const { item, had } of done.reverse()) {
      try {
        if (exists(path.join(oldDir, item)) || !had) fs.rmSync(path.join(root, item), { recursive: true, force: true });
        if (had) fs.renameSync(path.join(oldDir, item), path.join(root, item));
      } catch (e) {
        log(`!! Could not put ${item} back: ${e.message}`);
      }
    }
    fs.rmSync(oldDir, { recursive: true, force: true });
    throw err;
  }
  fs.rmSync(oldDir, { recursive: true, force: true });
  return done.map((d) => d.item);
}

export async function panelInstall(payload, o) {
  const log = o.log || NOOP;
  if (o.isMain) throw new Error("panel.install: the main server always runs the panel — nothing to install.");
  const p = checkPanelPayload(payload, o);
  const P = panelPaths(o.dataDir);
  if (sys.DRY_RUN) log(`[dry-run] the panel is installed under ${P.dry} instead of ${PANEL_CODE_DIR} / ${PANEL_DATA_DIR}`);

  // 1. Code: download, verify, stage, check, swap.
  log("── Panel code ──");
  const url = new URL(p.codeUrl, String(o.panelUrl).replace(/\/+$/, "") + "/");
  const buf = await downloadPanelCode(url, o.authToken, o.signal, log);
  abortIf(o.signal);
  const { listZipEntries, extractZip, readZipFile } = await import("./zip.mjs");
  let names;
  try {
    names = new Set(listZipEntries(buf).map((e) => e.name));
  } catch (err) {
    throw new Error(`the panel code is not a valid zip archive: ${err.message}`);
  }
  for (const rel of PANEL_REQUIRED) if (!names.has(rel)) throw new Error(`the panel code archive has no ${rel} — refusing to install it`);
  const serverSrc = String(readZipFile(buf, "panel/server.mjs") || "");
  const version = /version[a-z_]*\s*[:=]\s*"(\d+\.\d+\.\d+[^"]*)"/i.exec(serverSrc)?.[1] || null;

  ensureDir(P.code);
  fs.chmodSync(P.code, 0o755);
  const stage = path.join(P.code, `.staging.${process.pid}.${Date.now()}`);
  let swapped;
  try {
    fs.mkdirSync(stage, { recursive: true });
    extractZip(buf, stage, { stripRoot: false });
    const items = PANEL_CODE_ITEMS.filter((i) => exists(path.join(stage, i)));
    const extra = fs.readdirSync(stage).filter((i) => !PANEL_CODE_ITEMS.includes(i));
    if (extra.length) log(`Not installing unexpected top-level entries: ${extra.slice(0, 10).join(", ")}`);
    await nodeCheck(path.join(stage, "panel", "server.mjs"));
    await nodeCheck(path.join(stage, "node", "node-agent.mjs"));
    abortIf(o.signal);
    swapped = swapPanelCode(P.code, stage, items, log);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  writeAtomic(
    path.join(P.code, "version.json"),
    JSON.stringify({ version: version || "unknown", source: "ha", from: url.origin, installedAt: new Date().toISOString() }, null, 2) + "\n",
    0o644,
  );
  log(`Panel v${version || "?"} in ${P.code} (${swapped.join(", ")}).`);
  abortIf(o.signal);

  // 2. Local identity — never replicated; holds this server's token.
  log("── Panel data ──");
  ensureDir(P.data);
  fs.chmodSync(P.data, 0o700);
  const haFile = path.join(P.data, "ha-local.json");
  let prevLocal = {};
  try {
    prevLocal = JSON.parse(fs.readFileSync(haFile, "utf8")) || {};
  } catch {
    /* new */
  }
  const local = { ...(prevLocal && typeof prevLocal === "object" && prevLocal.serverId === o.serverId ? prevLocal : {}), serverId: o.serverId, token: o.authToken, directUrl: p.directUrl };
  writeAtomic(haFile, JSON.stringify(local, null, 2) + "\n", 0o600);
  log(`Wrote ${haFile} (server ${o.serverId}, reachable at ${p.directUrl}).`);
  if (!sys.DRY_RUN) ensureDir(PANEL_SITES_DIR);

  // 2b. MySQL client (Phase 3) — before the panel starts, so it can reach the database at once.
  let mysqlClient = null;
  if (p.mysqlFlavor) {
    log("── MySQL client ──");
    abortIf(o.signal);
    mysqlClient = await (await import("./mysql-ha.mjs")).ensureMysqlClient(p.mysqlFlavor, { log });
  }

  // 3. fcc.service
  log("── fcc.service ──");
  const unit = renderPanelUnit({ nodeBin: process.execPath, port: p.port, host: p.host });
  const unitChanged = writeIfChangedEnsuring(P.unit, unit, 0o644);
  log(`${unitChanged ? "Wrote" : "Unchanged:"} ${P.unit}`);
  let active = null;
  if (sys.DRY_RUN || sys.which("systemctl")) {
    const ctl = (args, extra = {}) => sys.run("systemctl", args, { allowFail: true, timeoutMs: 60_000, log, ...extra });
    await ctl(["daemon-reload"]);
    await ctl(["enable", PANEL_UNIT]);
    const r = await ctl(["restart", PANEL_UNIT]);
    if (!sys.DRY_RUN) {
      if (r.code !== 0) throw new Error(`systemctl restart ${PANEL_UNIT} failed: ${(r.stderr || "").trim().split("\n").pop()}`);
      await new Promise((res) => setTimeout(res, 2000));
      const a = await ctl(["is-active", PANEL_UNIT], { log: NOOP });
      active = a.stdout.trim() === "active";
      log(active ? `${PANEL_UNIT} is running.` : `!! ${PANEL_UNIT} is ${a.stdout.trim() || "not active"} — see: journalctl -u fcc`);
    } else active = true;
  } else {
    log("!! systemd is not available on this server — start the panel yourself.");
  }

  // 4. Firewall: the other servers must reach this panel's port (votes, replication, the follower proxy).
  log("── Firewall ──");
  const firewall = await syncUfwRules({ allowFrom: p.allowFrom, ports: String(p.port), comment: PANEL_UFW_COMMENT, log }).catch((err) => {
    log(`!! firewall: ${err.message}`);
    return { error: err.message };
  });
  if (firewall.active) {
    log(firewall.added.length || firewall.removed.length
      ? `Panel port ${p.port}: opened to ${firewall.added.join(", ") || "nobody new"}; closed to ${firewall.removed.join(", ") || "nobody"}.`
      : `Panel port ${p.port} already open to ${p.allowFrom.join(", ") || "nobody"}.`);
  }

  return {
    installed: true,
    version,
    directUrl: p.directUrl,
    port: p.port,
    host: p.host,
    active,
    codeDir: P.code,
    dataDir: P.data,
    firewall,
    ...(mysqlClient ? { mysqlClient } : {}),
    ...(sys.DRY_RUN ? { dryRun: true } : {}),
  };
}

export async function panelRemove(payload, o) {
  const log = o.log || NOOP;
  if (o.isMain) throw new Error("panel.remove: the main server always runs the panel — it cannot be removed from it.");
  const P = panelPaths(o.dataDir);
  const own = path.resolve(o.dataDir || "");
  if (own === path.resolve(P.data) || own.startsWith(path.resolve(P.data) + path.sep) || own === path.resolve(P.code) || own.startsWith(path.resolve(P.code) + path.sep)) {
    throw new Error(`panel.remove: this agent keeps its own data in ${own}, inside the panel's directories — refusing.`);
  }
  if (sys.DRY_RUN) log(`[dry-run] working under ${P.dry}`);

  log("── fcc.service ──");
  if (sys.DRY_RUN || sys.which("systemctl")) {
    const ctl = (args) => sys.run("systemctl", args, { allowFail: true, timeoutMs: 60_000, log });
    await ctl(["disable", "--now", PANEL_UNIT]);
    if (exists(P.unit)) {
      fs.rmSync(P.unit, { force: true });
      log(`Removed ${P.unit}`);
    }
    await ctl(["daemon-reload"]);
  } else if (exists(P.unit)) {
    fs.rmSync(P.unit, { force: true });
    log(`Removed ${P.unit}`);
  }
  abortIf(o.signal);

  log("── Panel code ──");
  if (exists(P.code)) {
    fs.rmSync(P.code, { recursive: true, force: true });
    log(`Removed ${P.code}`);
  } else log(`No code in ${P.code}.`);

  log("── Panel data ──");
  let keptData = null;
  if (exists(P.data)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    keptData = `${P.data}.removed-${stamp}`;
    fs.renameSync(P.data, keptData);
    log(`Moved ${P.data} to ${keptData} — it holds the panel's secrets (encryption key, session secret, this server's token). Delete it when you no longer need it.`);
  } else log(`No data in ${P.data}.`);

  log("── Firewall ──");
  const firewall = await syncUfwRules({ allowFrom: [], ports: "0", comment: PANEL_UFW_COMMENT, log }).catch((err) => {
    log(`!! firewall: ${err.message}`);
    return { error: err.message };
  });
  if (firewall.active) log(firewall.removed.length ? `Closed the panel port to ${firewall.removed.join(", ")}.` : "No panel firewall rules to remove.");

  return {
    removed: true,
    keptData,
    note: keptData ? `The panel's data was kept in ${keptData}: it holds secrets (encryption key, session secret, token). Delete it when you no longer need it.` : null,
    firewall,
    ...(sys.DRY_RUN ? { dryRun: true } : {}),
  };
}

function writeIfChangedEnsuring(file, content, mode) {
  ensureDir(path.dirname(file));
  return writeIfChanged(file, content, mode);
}
