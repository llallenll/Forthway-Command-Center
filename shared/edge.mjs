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

  if (payload.edge == null) return { hash, allowFrom, ignored, edge: null };
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
    if (typeof content !== "string") throw bad(`${name} has no text`);
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw bad(`${name} is larger than 2 MB`);
    if (content.includes("\0")) throw bad(`${name} contains a NUL byte`);
    files.set(name, content);
  }

  const connectors = [];
  for (const c of Array.isArray(e.connectors) ? e.connectors : []) {
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
  for (const s of Array.isArray(e.shims) ? e.shims : []) {
    const name = String(s?.name ?? "");
    if (!SHIM_NAME_RE.test(name)) throw bad(`"${name.slice(0, 40)}" is not a valid shim name`);
    const listenPort = checkPort(s.listenPort, `shim ${name}'s listenPort`);
    if (listenPort === 80 || listenPort === 443) throw bad(`shim ${name} cannot listen on port ${listenPort} (the front door uses it)`);
    if (shims.some((x) => x.listenPort === listenPort)) throw bad(`two shims listen on port ${listenPort}`);
    const m = TARGET_RE.exec(String(s.target ?? ""));
    if (!m) throw bad(`shim ${name}'s target must look like http(s)://host:port`);
    const host = m[2].startsWith("[") ? m[2] : m[2].toLowerCase();
    if (host.startsWith("[") && net.isIP(host.slice(1, -1)) !== 6) throw bad(`shim ${name}'s target has an invalid IPv6 address`);
    const port = checkPort(m[3], `shim ${name}'s target`);
    shims.push({ name, listenPort, listenTls: !!s.listenTls, target: `${m[1]}://${host}:${port}`, https: m[1] === "https" });
  }

  return { hash, allowFrom, ignored, edge: { files, connectors, shims } };
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

  // 1. Firewall — on every agent, edge or not: the edges must reach its site ports.
  log("── Firewall ──");
  const firewall = await syncFirewall(p.allowFrom, log).catch((err) => {
    errors.push(`firewall: ${err.message}`);
    return { error: err.message };
  });
  if (p.ignored.length) log(`Ignored allowFrom entries that are not IP addresses: ${p.ignored.join(", ")}`);
  checkAbort();

  const state = { ...prev, edge: !!p.edge, hash: p.hash, appliedAt: new Date().toISOString() };
  let connectors = [];
  let shims = [];

  if (p.edge) {
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
    shims = p.edge.shims.map((s) => ({ name: s.name, listenPort: s.listenPort, listenTls: s.listenTls, target: s.target }));
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
  else log(p.edge ? "Edge configuration applied." : "Done.");

  return {
    hash: state.hash,
    appliedAt: state.appliedAt,
    nginx: !!p.edge && state.nginx,
    error: state.error,
    connectors,
    shims,
    firewall,
    ...(sys.DRY_RUN ? { dryRun: true } : {}),
  };
}

// --------------------------------------------------------------- firewall

async function syncFirewall(allowFrom, log) {
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
  const have = new Set();
  for (const line of String(st.stdout || "").split("\n")) {
    const m = /^\S+\s+ALLOW(?:\s+IN)?\s+(\S+)\s+#\s*(.*?)\s*$/.exec(line.trim());
    if (m && m[2] === UFW_COMMENT && net.isIP(m[1])) have.add(m[1]);
  }
  const rule = (ip) => ["from", ip, "to", "any", "port", SITE_PORTS, "proto", "tcp"];
  const added = [];
  const removed = [];
  for (const ip of allowFrom) {
    if (have.has(ip)) continue;
    await sys.run("ufw", ["allow", ...rule(ip), "comment", UFW_COMMENT], { timeoutMs: 30_000, log });
    added.push(ip);
  }
  for (const ip of have) {
    if (allowFrom.includes(ip)) continue;
    await sys.run("ufw", ["--force", "delete", "allow", ...rule(ip)], { timeoutMs: 30_000, log });
    removed.push(ip);
  }
  log(
    added.length || removed.length
      ? `Site ports ${SITE_PORTS}: opened to ${added.join(", ") || "nobody new"}; closed to ${removed.join(", ") || "nobody"}.`
      : `Site ports ${SITE_PORTS} already open to ${allowFrom.length ? allowFrom.join(", ") : "no edge servers"}.`,
  );
  return { active: true, allowFrom, added, removed };
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
  return [
    `# Managed by Forthway Command Center — do not edit by hand.`,
    `# Edge shim "${s.name}": tunnel routes for 127.0.0.1:${s.listenPort} reach this replica too,`,
    `# so pass them on to the main server.`,
    `server {`,
    `    listen 127.0.0.1:${s.listenPort}${s.listenTls ? " ssl" : ""};`,
    `    server_name _;`,
    ...(s.listenTls ? [`    ssl_certificate ${EDGE_CRT};`, `    ssl_certificate_key ${EDGE_KEY};`] : []),
    `    access_log off;`,
    `    client_max_body_size 0;`,
    `    server_tokens off;`,
    ``,
    `    location / {`,
    `        proxy_pass ${s.target};`,
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
    ...(s.https ? [`        proxy_ssl_verify off;`, `        proxy_ssl_server_name on;`] : []),
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
  return { hash: s.hash, appliedAt: s.appliedAt, error: s.error, nginx: !!s.nginx, connectors, shims };
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

