/**
 * Cloudflare Zero Trust — Cloudflare Tunnel (CLOUDFLARE module).
 *
 * A website's domain can be delivered two ways:
 *   - Direct: a DNS A record points at the main server; nginx (the front
 *     door, lib/loadbalancer.mjs) answers on :80/:443 and certbot does HTTPS.
 *   - Cloudflare Tunnel: no open port and no A record. A `cloudflared`
 *     connector on the main server dials out to Cloudflare; a "public
 *     hostname" (an ingress rule on the tunnel + a proxied CNAME to
 *     <tunnelId>.cfargotunnel.com) sends visitors through it to the SAME nginx
 *     front door — `http://127.0.0.1:80` with the Host header set to the
 *     hostname — so load balancing and health checks work exactly as for
 *     direct domains. Cloudflare terminates HTTPS at its edge.
 *
 * Ported from the v2 hub (hub/lib/cloudflare.mjs + hub/lib/tunnel.mjs +
 * the cfLogin flow in hub/server.mjs). Three ways to connect:
 *   1. "Log in with Cloudflare": `cloudflared tunnel login` with a HOME of its
 *      own under dataDir; the origin certificate it writes carries an account
 *      id and an API token.
 *   2. An API token (Account·Cloudflare Tunnel·Edit, Zone·DNS·Edit, Zone·Zone·Read).
 *   3. Only a connector token (pasted from the dashboard): the connector runs,
 *      but public hostnames must be added in the Cloudflare dashboard by hand.
 *
 * What the panel writes in Cloudflare is recorded in the `cloudflareRoutes`
 * collection (the ledger). Only rules / DNS records in the ledger are ever
 * changed or deleted; rules made in the dashboard are kept as they are, and
 * the catch-all rule always stays last.
 *
 * Data:
 *   config.cloudflare = { apiTokenEnc, accountId, accountName, viaLogin,
 *                         connectors: [{ id, name, tokenEnc, autoStart, cfId }],
 *                         panel: { hostname, tunnelId } | null }
 *   site.cloudflare   = { enabled, tunnelId, hostnames: [] }   (owned/validated by SITES,
 *                        hostnames ⊆ site.domains; other domains are Direct)
 *   cloudflareRoutes  = { id, owner: "site:<id>"|"panel", siteId, hostname, tunnelId, zoneId,
 *                         zoneName, service, ruleKey, ingress: "created"|"adopted"|null,
 *                         dnsRecordId, dnsCreated, status: "active"|"error"|"manual", error, syncedAt }
 *
 * Dev: FCC_DRY_RUN=1 never spawns or downloads cloudflared (connectors are
 * simulated). FCC_DRY_RUN=1 + FCC_CLOUDFLARE_FAKE=1 also swaps the Cloudflare
 * API for an in-memory fake (zones example.com / example.org, any token but
 * "bad"), persisted in dataDir/cloudflare-fake.json — no network at all.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { httpError, HttpError } from "./http.mjs";

const API = "https://api.cloudflare.com/client/v4";
const RELEASE = "https://github.com/cloudflare/cloudflared/releases/latest/download";
const COLL = "cloudflareRoutes";
const MAX_LOG_LINES = 300;
const CACHE_MS = 60_000;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const now = () => new Date().toISOString();
const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

let instance = null;

export function register(router, ctx) {
  instance = createCloudflare(ctx);
  ctx.cloudflare = instance.api;
  instance.routes(router);
}

export async function start(ctx) {
  await instance?.start();
}

export async function stop() {
  await instance?.stop();
}

// ===================================================================== API

/** Turn the codes people actually hit into something actionable. */
function cfHint(code, message) {
  if (code === 10000 || code === 9109) {
    return `${message}. The API token is missing a permission — it needs Account · Cloudflare Tunnel · Edit, Zone · DNS · Edit and Zone · Zone · Read.`;
  }
  if (code === 81053) return `${message}. A DNS record with that name already exists.`;
  if (code === 1000) return `${message}. That looks like a Global API Key; this needs an API token instead.`;
  if (/Authorization header/i.test(message)) {
    return `${message}. Copy the whole token from the Cloudflare dashboard — it is shown once, when the token is created.`;
  }
  return message;
}

function cfError(code, message, status = 400) {
  const err = new Error(cfHint(code, message));
  err.code = code;
  err.status = status;
  return err;
}

async function realCf(token, p, { method = "GET", body, timeoutMs = 20_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${API}${p}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new Error(err.name === "AbortError" ? "Cloudflare did not answer in time." : `Could not reach Cloudflare: ${err.message}`);
  } finally {
    clearTimeout(t);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* handled below */
  }
  if (!json) throw new Error(`Cloudflare returned ${res.status} with nothing readable in it.`);
  if (!json.success) {
    const first = (json.errors || [])[0];
    const detail = first?.error_chain?.[0]?.message;
    const message = [first?.message, detail].filter(Boolean).join(" — ") || `HTTP ${res.status}`;
    throw cfError(first?.code, message, res.status);
  }
  return json.result;
}

/**
 * A stand-in for api.cloudflare.com, for development only (FCC_DRY_RUN=1 +
 * FCC_CLOUDFLARE_FAKE=1). Implements just the endpoints this module uses.
 */
function createFakeCf(file) {
  const ACCOUNT = { id: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f", name: "Dev account (simulated)" };
  const ZONES = [
    { id: "zone0000000000000000000000000001", name: "example.com", status: "active" },
    { id: "zone0000000000000000000000000002", name: "example.org", status: "active" },
  ];
  let st = { tunnels: [], configs: {}, dns: [] };
  try {
    st = { ...st, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    /* fresh */
  }
  const save = () => {
    try {
      fs.writeFileSync(file, JSON.stringify(st, null, 2), { mode: 0o600 });
    } catch {
      /* dev only */
    }
  };
  const tunnelView = ({ secret, ...t }) => ({ ...t, connections: [], remote_config: true, status: "inactive" });

  return async function fakeCf(token, p, { method = "GET", body } = {}) {
    await new Promise((r) => setTimeout(r, 40));
    if (!token || token === "bad") throw cfError(10000, "Authentication error", 403);
    const u = new URL(p, "https://fake.local");
    const parts = u.pathname.split("/").filter(Boolean);
    const q = u.searchParams;
    const m = (re) => u.pathname.match(re);
    let x;
    if (u.pathname === "/user/tokens/verify") return { id: "fake-token", status: "active" };
    if (u.pathname === "/accounts") return [ACCOUNT];
    if (u.pathname === "/zones") return ZONES;
    if ((x = m(/^\/accounts\/([^/]+)\/cfd_tunnel$/))) {
      if (x[1] !== ACCOUNT.id) throw cfError(7003, "Could not route to account", 404);
      if (method === "POST") {
        const t = { id: crypto.randomUUID(), name: String(body?.name || "tunnel"), created_at: now(), secret: crypto.randomBytes(32).toString("base64") };
        st.tunnels.push(t);
        st.configs[t.id] = { ingress: [{ service: "http_status:404" }] };
        save();
        return tunnelView(t);
      }
      return st.tunnels.map(tunnelView);
    }
    if ((x = m(/^\/accounts\/([^/]+)\/cfd_tunnel\/([^/]+)(\/[a-z]+)?$/))) {
      const t = st.tunnels.find((y) => y.id === x[2]);
      if (!t) throw cfError(1003, "Tunnel not found", 404);
      if (!x[3]) return tunnelView(t);
      if (x[3] === "/token") return Buffer.from(JSON.stringify({ a: ACCOUNT.id, t: t.id, s: t.secret })).toString("base64");
      if (x[3] === "/configurations") {
        if (method === "PUT") {
          const ing = body?.config?.ingress || [];
          const last = ing[ing.length - 1];
          if (!last || last.hostname || last.path) throw cfError(1055, "The last ingress rule must match all URLs (no hostname or path)");
          st.configs[t.id] = body.config;
          save();
        }
        return { tunnel_id: t.id, config: st.configs[t.id] || { ingress: [{ service: "http_status:404" }] } };
      }
    }
    if ((x = m(/^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/))) {
      const zone = ZONES.find((z) => z.id === x[1]);
      if (!zone) throw cfError(7003, "Could not route to zone", 404);
      if (!x[2] && method === "GET") return st.dns.filter((r) => r.zoneId === zone.id && (!q.get("name") || r.name === q.get("name")));
      if (!x[2] && method === "POST") {
        if (st.dns.some((r) => r.zoneId === zone.id && r.name === body.name && (r.type === "CNAME" || body.type === "CNAME"))) {
          throw cfError(81053, "An A, AAAA, or CNAME record with that host already exists");
        }
        const r = { id: crypto.randomBytes(16).toString("hex"), zoneId: zone.id, ...body };
        st.dns.push(r);
        save();
        return r;
      }
      const rec = st.dns.find((r) => r.id === x[2] && r.zoneId === zone.id);
      if (!rec) throw cfError(81044, "Record does not exist", 404);
      if (method === "GET") return rec;
      if (method === "PUT") {
        Object.assign(rec, body);
        save();
        return rec;
      }
      if (method === "DELETE") {
        st.dns = st.dns.filter((r) => r !== rec);
        save();
        return { id: rec.id };
      }
    }
    throw cfError(7000, `No route for ${method} ${u.pathname} (simulated Cloudflare)`, 404);
  };
}

/** The zone a hostname belongs to: the longest suffix match wins. */
export function zoneForHostname(zones, hostname) {
  const host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  let best = null;
  for (const z of zones || []) {
    const name = String(z.name || "").toLowerCase();
    if (host === name || host.endsWith(`.${name}`)) if (!best || name.length > best.name.length) best = z;
  }
  return best;
}

/** What `cloudflared tunnel login` leaves behind (see hub/lib/cloudflare.mjs). */
export function readOriginCert(text) {
  const m = String(text || "").match(/-----BEGIN ARGO TUNNEL TOKEN-----([\s\S]*?)-----END ARGO TUNNEL TOKEN-----/);
  if (!m) return null;
  let json;
  try {
    json = JSON.parse(Buffer.from(m[1].replace(/\s+/g, ""), "base64").toString("utf8"));
  } catch {
    return null;
  }
  const accountId = json.accountID || json.accountTag || json.account_id || "";
  const apiToken = json.apiToken || json.api_token || "";
  if (!accountId || !apiToken) return null;
  return { accountId, apiToken };
}

/** A connector token is base64 JSON { a: accountTag, t: tunnelId, s: secret }. */
export function parseConnectorToken(token) {
  try {
    const j = JSON.parse(Buffer.from(String(token || "").trim(), "base64").toString("utf8"));
    if (j && typeof j.t === "string" && typeof j.a === "string") return { accountTag: j.a, tunnelId: j.t };
  } catch {
    /* not one */
  }
  return null;
}

function assetName() {
  const archName = { x64: "amd64", arm64: "arm64", arm: "arm" }[os.arch()];
  if (!archName || os.platform() !== "linux") return null; // macOS ships as .tgz: use brew
  return `cloudflared-linux-${archName}`;
}

const hint = (s) => (s ? `••••${String(s).slice(-4)}` : "");

// =============================================================== connector

/**
 * One cloudflared process (`tunnel run`, token in TUNNEL_TOKEN, never argv),
 * restarted with backoff. Under DRY_RUN nothing is spawned: the connector is
 * simulated so the UI can be exercised on a laptop.
 */
class Connector {
  constructor({ id, dryRun, pidFile, onChange, onLog }) {
    this.id = id;
    this.dryRun = dryRun;
    this.pidFile = pidFile;
    this.onChange = onChange;
    this.onLog = onLog;
    this.proc = null;
    this.simulated = false;
    this.wantRunning = false;
    this.restartTimer = null;
    this.backoffMs = 2000;
    this.log = [];
    this.connections = 0;
    this.startedAt = null;
    this.lastError = null;
    this.lastExit = null;
    this.fatal = false;
  }

  get running() {
    return !!this.proc || this.simulated;
  }

  line(text) {
    const entry = `[${now()}] ${text}`;
    this.log.push(entry);
    if (this.log.length > MAX_LOG_LINES) this.log.splice(0, this.log.length - MAX_LOG_LINES);
    this.onLog(entry);
  }

  async start(token, resolveBinary) {
    if (!token) throw new Error("This connector has no token.");
    if (this.running) return { alreadyRunning: true };
    this.wantRunning = true;
    this.lastError = null;
    this.fatal = false;
    this.backoffMs = 2000;
    this.connections = 0;
    if (this.dryRun) {
      this.simulated = true;
      this.startedAt = now();
      this.line("[dry-run] cloudflared --no-autoupdate tunnel run   (TUNNEL_TOKEN in env)");
      this.onChange();
      setTimeout(() => {
        if (!this.simulated) return;
        this.connections = 4;
        this.line("[dry-run] Registered tunnel connection ×4 (simulated)");
        this.onChange();
      }, 1200).unref?.();
      return { started: true, simulated: true };
    }
    const bin = await resolveBinary();
    this.spawn(bin, token);
    return { started: true };
  }

  spawn(bin, token) {
    if (this.proc) return;
    this.killStale();
    this.line(`Starting ${path.basename(bin)}…`);
    const proc = spawn(bin, ["--no-autoupdate", "tunnel", "run"], {
      // The token goes in the environment, never argv — argv shows up in `ps`.
      env: { ...process.env, TUNNEL_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    this.proc = proc;
    this.startedAt = now();
    const spawnedAt = Date.now();
    try {
      fs.writeFileSync(this.pidFile, String(proc.pid));
    } catch {
      /* best effort */
    }
    const onData = (chunk) => {
      for (const raw of chunk.toString().split("\n")) {
        const l = raw.trimEnd();
        if (!l) continue;
        this.line(l);
        if (/Registered tunnel connection/i.test(l)) {
          this.connections++;
          this.onChange();
        } else if (/Unregistered tunnel connection/i.test(l)) {
          this.connections = Math.max(0, this.connections - 1);
          this.onChange();
        }
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
    proc.stderr.on("data", onData);
    proc.once("error", (err) => {
      this.lastError = `could not run cloudflared: ${err.message}`;
      this.line(this.lastError);
    });
    proc.once("exit", (code, signal) => {
      const aliveMs = Date.now() - spawnedAt;
      this.proc = null;
      this.connections = 0;
      this.lastExit = { code, signal, at: now() };
      try {
        fs.unlinkSync(this.pidFile);
      } catch {
        /* gone */
      }
      this.line(`cloudflared exited (${signal || `code ${code}`}).`);
      if (this.fatal) {
        this.wantRunning = false;
        this.line("Not retrying — fix the token and start it again.");
        this.onChange();
        return;
      }
      this.onChange();
      if (!this.wantRunning) return;
      if (aliveMs > 20_000) this.backoffMs = 2000;
      this.line(`Retrying in ${Math.round(this.backoffMs / 1000)}s.`);
      this.restartTimer = setTimeout(() => this.spawn(bin, token), this.backoffMs);
      this.restartTimer.unref?.();
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    });
    this.onChange();
  }

  /** A connector left running by a panel that crashed would double up; stop it. */
  killStale() {
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(this.pidFile, "utf8").trim());
    } catch {
      return;
    }
    if (!pid) return;
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!/cloudflared/.test(cmd)) return;
      process.kill(pid, "SIGTERM");
      this.line(`Stopped a leftover cloudflared (pid ${pid}) from a previous run.`);
    } catch {
      /* not running / not linux */
    }
  }

  async stop() {
    this.wantRunning = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.simulated) {
      this.simulated = false;
      this.connections = 0;
      this.lastExit = { code: 0, signal: null, at: now() };
      this.line("[dry-run] cloudflared stopped (simulated)");
      this.onChange();
      return;
    }
    const proc = this.proc;
    if (!proc) return this.onChange();
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
      const kill = (sig) => {
        try {
          process.kill(-proc.pid, sig);
        } catch {
          try {
            proc.kill(sig);
          } catch {
            finish();
          }
        }
      };
      const hard = setTimeout(() => {
        kill("SIGKILL");
        finish();
      }, 8000);
      kill("SIGTERM");
    });
    this.proc = null;
    this.connections = 0;
    this.onChange();
  }

  status() {
    return {
      running: this.running,
      connections: this.connections,
      connected: this.running && this.connections > 0,
      startedAt: this.running ? this.startedAt : null,
      lastError: this.lastError,
      lastExit: this.lastExit,
      fatal: this.fatal,
      simulated: this.simulated,
    };
  }
}

// ================================================================ module

function createCloudflare(ctx) {
  const { db, sys } = ctx;
  const DRY = !!sys?.DRY_RUN;
  const FAKE = DRY && process.env.FCC_CLOUDFLARE_FAKE === "1";
  const binDir = path.join(ctx.dataDir, "bin");
  const runDir = path.join(ctx.dataDir, "run");
  const binPath = path.join(binDir, "cloudflared");
  const loginHome = path.join(ctx.dataDir, "cloudflared-home");
  const cfCall = FAKE ? createFakeCf(path.join(ctx.dataDir, "cloudflare-fake.json")) : realCf;

  const panelPort = () => Number(process.env.FCC_PORT) || Number(ctx.config.port) || 4000;
  const panelTls = () => !!((process.env.FCC_TLS_KEY || ctx.config.tls?.key) && (process.env.FCC_TLS_CERT || ctx.config.tls?.cert));

  // ---------------------------------------------------------------- config

  function conf() {
    const c = ctx.config.cloudflare && typeof ctx.config.cloudflare === "object" ? ctx.config.cloudflare : {};
    if (!Array.isArray(c.connectors)) c.connectors = [];
    ctx.config.cloudflare = c;
    return c;
  }
  const save = () => ctx.saveConfig();
  const reveal = (enc) => {
    if (!enc) return "";
    try {
      return ctx.secrets.decrypt(enc);
    } catch {
      return "";
    }
  };
  /** { token, accountId } when the panel can manage tunnels + DNS, else null. */
  function creds() {
    const c = conf();
    const token = reveal(c.apiTokenEnc);
    return token && c.accountId ? { token, accountId: c.accountId } : null;
  }

  // ------------------------------------------------------------ events

  let emitTimer = null;
  function emit(kind, data = {}) {
    try {
      ctx.events?.broadcast?.("cloudflare", { kind, ...data });
    } catch {
      /* no SSE */
    }
  }
  /** Connector state changes come in bursts; coalesce them. */
  function emitStatusSoon() {
    if (emitTimer) return;
    emitTimer = setTimeout(() => {
      emitTimer = null;
      emit("status", { status: status() });
    }, 150);
    emitTimer.unref?.();
  }

  // ----------------------------------------------------------- binary

  let downloading = false;
  let version = null;

  function findBinary() {
    return sys.which?.("cloudflared") || (exists(binPath) ? binPath : null);
  }

  async function download() {
    if (DRY) throw new Error("Dry run — cloudflared is not downloaded. Connectors are simulated.");
    const asset = assetName();
    if (!asset) throw new Error(`No official cloudflared build for ${os.platform()}/${os.arch()}. Install cloudflared yourself and it will be used.`);
    downloading = true;
    emitStatusSoon();
    try {
      fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
      const res = await fetch(`${RELEASE}/${asset}`, { redirect: "follow" });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1_000_000) throw new Error("the downloaded file is too small to be cloudflared");
      const tmp = `${binPath}.partial`;
      fs.writeFileSync(tmp, buf, { mode: 0o755 });
      fs.renameSync(tmp, binPath);
      sys.forgetWhich?.("cloudflared");
    } finally {
      downloading = false;
      emitStatusSoon();
    }
    await readVersion();
    return binPath;
  }

  async function resolveBinary({ download: allowDownload = true } = {}) {
    const found = findBinary();
    if (found) return found;
    if (!allowDownload) throw new Error("cloudflared is not installed.");
    return download();
  }

  async function readVersion() {
    const bin = findBinary();
    if (!bin || DRY) return null;
    try {
      const r = await sys.run(bin, ["--version"], { allowFail: true, timeoutMs: 15_000 });
      version = String(r.stdout || r.stderr || "").trim().split("\n")[0] || null;
    } catch {
      version = null;
    }
    return version;
  }

  function binaryStatus() {
    const bin = findBinary();
    return { installed: !!bin, path: bin, version, downloading, supported: !!assetName() || !!bin, simulated: DRY };
  }

  // ---------------------------------------------------------- connectors

  const running = new Map(); // id -> Connector

  function connectorObj(id) {
    let c = running.get(id);
    if (!c) {
      fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
      c = new Connector({
        id,
        dryRun: DRY,
        pidFile: path.join(runDir, `cloudflared-${id.replace(/[^a-z0-9_]/gi, "")}.pid`),
        onChange: emitStatusSoon,
        onLog: (line) => emit("log", { id, line }),
      });
      running.set(id, c);
    }
    return c;
  }

  function entry(id) {
    const list = conf().connectors;
    if (!id && list.length === 1) return list[0];
    return list.find((t) => t.id === id) || null;
  }

  function publicConnector(e) {
    const s = running.get(e.id)?.status() || { running: false, connections: 0, connected: false, startedAt: null, lastError: null, lastExit: null, fatal: false, simulated: false };
    return { id: e.id, name: e.name || "Cloudflare Tunnel", cfId: e.cfId || "", autoStart: e.autoStart !== false, hasToken: !!e.tokenEnc, tokenHint: hint(reveal(e.tokenEnc)), ...s };
  }

  async function startConnector(id) {
    const e = entry(id);
    if (!e) throw httpError(404, "No such connector.");
    const token = reveal(e.tokenEnc);
    if (!token) throw httpError(400, "That connector has no token (or it can no longer be decrypted). Add it again.");
    try {
      return await connectorObj(e.id).start(token, () => resolveBinary());
    } catch (err) {
      throw httpError(400, err.message);
    }
  }

  async function stopConnector(id) {
    await running.get(id)?.stop();
  }

  function addConnector({ token, name, autoStart, cfId }) {
    const c = conf();
    const parsed = parseConnectorToken(token);
    const existing = c.connectors.find((t) => reveal(t.tokenEnc) === token || (parsed && t.cfId === parsed.tunnelId));
    const e = existing || { id: `cfc_${crypto.randomBytes(5).toString("hex")}`, autoStart: true };
    e.name = String(name || e.name || "").trim().slice(0, 60) || "Cloudflare Tunnel";
    e.tokenEnc = ctx.secrets.encrypt(token);
    e.cfId = cfId || parsed?.tunnelId || e.cfId || "";
    if (typeof autoStart === "boolean") e.autoStart = autoStart;
    if (!existing) c.connectors.push(e);
    save();
    return { entry: e, existing: !!existing };
  }

  // -------------------------------------------------------------- caches

  const cache = { zones: null, tunnels: null };
  function invalidate() {
    cache.zones = cache.tunnels = null;
  }
  async function zones({ fresh = false } = {}) {
    const c = creds();
    if (!c) return [];
    if (!fresh && cache.zones && cache.zones.accountId === c.accountId && Date.now() - cache.zones.at < CACHE_MS) return cache.zones.items;
    const all = [];
    for (let page = 1; page <= 20; page++) {
      const r = await cfCall(c.token, `/zones?account.id=${encodeURIComponent(c.accountId)}&per_page=50&page=${page}`);
      all.push(...r.map((z) => ({ id: z.id, name: z.name, status: z.status })));
      if (r.length < 50 || FAKE) break;
    }
    cache.zones = { at: Date.now(), accountId: c.accountId, items: all };
    return all;
  }
  async function accountTunnels({ fresh = false } = {}) {
    const c = creds();
    if (!c) return [];
    if (!fresh && cache.tunnels && cache.tunnels.accountId === c.accountId && Date.now() - cache.tunnels.at < CACHE_MS) return cache.tunnels.items;
    const r = await cfCall(c.token, `/accounts/${c.accountId}/cfd_tunnel?is_deleted=false&per_page=100`);
    const items = r.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status || null,
      createdAt: t.created_at || null,
      connections: (t.connections || []).length,
      remotelyManaged: t.remote_config !== false,
    }));
    cache.tunnels = { at: Date.now(), accountId: c.accountId, items };
    return items;
  }

  // ------------------------------------------------------------- ingress

  async function getConfig(c, tunnelId) {
    const r = await cfCall(c.token, `/accounts/${c.accountId}/cfd_tunnel/${tunnelId}/configurations`);
    const config = r?.config && typeof r.config === "object" ? { ...r.config } : {};
    config.ingress = Array.isArray(config.ingress) ? [...config.ingress] : [];
    return config;
  }

  /** Split off the catch-all (last rule, no hostname/path) so it can be put back last. */
  function splitCatchAll(ingress) {
    const last = ingress[ingress.length - 1];
    if (last && !last.hostname && !last.path) return { rules: ingress.slice(0, -1), catchAll: last };
    return { rules: [...ingress], catchAll: { service: "http_status:404" } };
  }

  async function putConfig(c, tunnelId, config, rules, catchAll) {
    const ingress = [...rules.filter((r) => r.hostname || r.path), catchAll || { service: "http_status:404" }];
    await cfCall(c.token, `/accounts/${c.accountId}/cfd_tunnel/${tunnelId}/configurations`, { method: "PUT", body: { config: { ...config, ingress } } });
  }

  const normService = (s) => String(s || "").trim().toLowerCase().replace("://localhost", "://127.0.0.1").replace(/\/+$/, "");
  function sameTarget(a, b) {
    return normService(a.service) === normService(b.service) && (a.originRequest?.httpHostHeader || "") === (b.originRequest?.httpHostHeader || "");
  }

  function ruleFor(hostname, kind, { https = false, port } = {}) {
    if (kind === "panel") {
      // The panel's SSE stream (/api/events, pings every 15 s) must survive the tunnel:
      // never set disableChunkedEncoding or short timeouts here (cloudflared's defaults keep
      // streams open), and the panel creates no cache / Rocket Loader rules for this hostname.
      return https
        ? { hostname, service: `https://127.0.0.1:${port}`, originRequest: { noTLSVerify: true } }
        : { hostname, service: `http://127.0.0.1:${port}` };
    }
    // A website: the nginx front door, which picks the vhost by Host header.
    // With an active certificate nginx's :80 block only redirects to https,
    // which through a tunnel would loop — so go to :443 with SNI instead.
    return https
      ? { hostname, service: "https://127.0.0.1:443", originRequest: { httpHostHeader: hostname, originServerName: hostname, noTLSVerify: true } }
      : { hostname, service: "http://127.0.0.1:80", originRequest: { httpHostHeader: hostname } };
  }
  const ruleKey = (r) => JSON.stringify([r.hostname, r.service, r.originRequest || null]);

  // ----------------------------------------------------------------- DNS

  async function ensureDns(c, zone, d, prev, replaceExisting, log) {
    const content = `${d.tunnelId}.cfargotunnel.com`;
    const recs = await cfCall(c.token, `/zones/${zone.id}/dns_records?name=${encodeURIComponent(d.hostname)}&per_page=50`);
    const mine = recs.find((r) => r.type === "CNAME" && String(r.content).toLowerCase() === content);
    if (mine) {
      if (!mine.proxied && prev?.dnsCreated && prev.dnsRecordId === mine.id) {
        await cfCall(c.token, `/zones/${zone.id}/dns_records/${mine.id}`, { method: "PUT", body: { type: "CNAME", name: d.hostname, content, proxied: true, ttl: 1 } });
      }
      return { id: mine.id, created: prev?.dnsRecordId === mine.id ? !!prev.dnsCreated : false };
    }
    const ours = prev?.dnsCreated && recs.find((r) => r.id === prev.dnsRecordId);
    if (ours) {
      const r = await cfCall(c.token, `/zones/${zone.id}/dns_records/${ours.id}`, { method: "PUT", body: { type: "CNAME", name: d.hostname, content, proxied: true, ttl: 1, comment: "Forthway Command Center" } });
      log(`   DNS: moved our CNAME to ${content}`);
      return { id: r.id, created: true };
    }
    const clashes = recs.filter((r) => ["A", "AAAA", "CNAME"].includes(r.type));
    if (clashes.length && !replaceExisting) {
      const x = clashes[0];
      const e = new Error(
        `${d.hostname} already has ${/^A/.test(x.type) ? "an" : "a"} ${x.type} record → ${x.content}${clashes.length > 1 ? ` (+${clashes.length - 1} more)` : ""}. ` +
          `Delete it in Cloudflare DNS, or use “Replace existing records” to let the panel swap it for the tunnel's CNAME.`,
      );
      e.code = "dns_conflict";
      throw e;
    }
    for (const x of clashes) {
      await cfCall(c.token, `/zones/${zone.id}/dns_records/${x.id}`, { method: "DELETE" });
      log(`   DNS: deleted the existing ${x.type} record → ${x.content} (replace requested)`);
    }
    const made = await cfCall(c.token, `/zones/${zone.id}/dns_records`, {
      method: "POST",
      body: { type: "CNAME", name: d.hostname, content, proxied: true, ttl: 1, comment: "Forthway Command Center" },
    });
    log(`   DNS: created proxied CNAME ${d.hostname} → ${content}`);
    return { id: made.id, created: true };
  }

  // ------------------------------------------------------------ reconcile

  let chain = Promise.resolve();
  /** Every read-modify-write of a tunnel's ingress goes through here, one at a time. */
  function serial(fn) {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  }

  const ledger = (owner) => db.list(COLL, (r) => r.owner === owner);
  const siteOwner = (id) => `site:${id}`;

  function desiredForSite(site) {
    const c = site?.cloudflare;
    if (!c?.enabled || !c.tunnelId || !Array.isArray(c.hostnames)) return [];
    const doms = new Set(site.domains || []);
    const https = !!site.ssl?.enabled && site.ssl?.status === "active";
    return c.hostnames.filter((h) => doms.has(h)).map((h) => ({ hostname: h, tunnelId: c.tunnelId, rule: ruleFor(h, "site", { https }) }));
  }
  function desiredForPanel() {
    const p = conf().panel;
    if (!p?.hostname || !p.tunnelId) return [];
    return [{ hostname: p.hostname, tunnelId: p.tunnelId, rule: ruleFor(p.hostname, "panel", { https: panelTls(), port: panelPort() }) }];
  }

  function inSync(desired, current) {
    if (desired.length !== current.length) return false;
    return desired.every((d) => current.some((e) => e.hostname === d.hostname && e.tunnelId === d.tunnelId && e.ruleKey === ruleKey(d.rule) && e.status === "active"));
  }

  function manualHint(d) {
    const r = d.rule;
    return `Add a public hostname in the Cloudflare dashboard (Zero Trust → Networks → Tunnels → this tunnel): ${d.hostname} → ${r.service}` +
      (r.originRequest?.httpHostHeader ? `, with HTTP Host Header = ${r.originRequest.httpHostHeader}` : "") +
      (r.originRequest?.noTLSVerify ? ", and No TLS Verify on" : "") + ".";
  }

  /**
   * Bring Cloudflare in line with `desired` for one owner (a site, or the
   * panel itself). Removals first, then additions; ingress per tunnel in one
   * PUT; DNS per hostname. Per-hostname failures are recorded in the ledger
   * and summarised in the thrown error, so the job shows as failed.
   */
  async function reconcile(owner, desired, { log = () => {}, replaceExisting = false, siteId = null } = {}) {
    const current = ledger(owner);
    const key = (x) => `${x.hostname}|${x.tunnelId}`;
    const want = new Set(desired.map(key));
    const removing = current.filter((e) => !want.has(key(e)));
    const prevOf = (d) => current.find((e) => key(e) === key(d));
    const c = creds();
    const errors = new Map(); // hostname -> message
    const outcome = new Map(); // key -> { ingress }

    if (!c) {
      for (const e of removing) {
        db.remove(COLL, e.id);
        log(`${e.hostname}: forgotten. The panel isn't connected to Cloudflare with an API token, so remove its public hostname and DNS record in the Cloudflare dashboard yourself.`);
      }
      for (const d of desired) {
        upsert(owner, siteId, d, prevOf(d), { status: "manual", error: manualHint(d), ingress: null, dnsRecordId: null, dnsCreated: false, zone: null });
        log(`${d.hostname}: ${manualHint(d)}`);
      }
      emit("routes", { owner, siteId });
      return { manual: desired.length };
    }

    // 1. ingress, one GET + at most one PUT per tunnel
    const tunnels = [...new Set([...removing.map((e) => e.tunnelId), ...desired.map((d) => d.tunnelId)])];
    for (const tid of tunnels) {
      const rm = removing.filter((e) => e.tunnelId === tid);
      const add = desired.filter((d) => d.tunnelId === tid);
      let config;
      try {
        config = await getConfig(c, tid);
      } catch (err) {
        if (rm.length) log(`!! tunnel ${tid}: could not read its routes (${err.message}) — leaving them as they are.`);
        for (const d of add) errors.set(d.hostname, `Could not read the tunnel's routes: ${err.message}`);
        continue;
      }
      let { rules, catchAll } = splitCatchAll(config.ingress);
      let changed = false;
      for (const e of rm) {
        if (e.ingress !== "created") {
          if (e.ingress === "adopted") log(`${e.hostname}: route was there before the panel — left in place.`);
          continue;
        }
        const before = rules.length;
        rules = rules.filter((r) => !(r.hostname === e.hostname && !r.path));
        if (rules.length !== before) {
          changed = true;
          log(`${e.hostname}: removed its route from the tunnel.`);
        }
      }
      for (const d of add) {
        const prev = prevOf(d);
        const idx = rules.findIndex((r) => r.hostname === d.hostname && !r.path);
        if (idx === -1) {
          rules.push(d.rule);
          changed = true;
          outcome.set(key(d), { ingress: prev?.ingress === "adopted" ? "adopted" : "created" });
          log(`${d.hostname}: route → ${d.rule.service}${d.rule.originRequest?.httpHostHeader ? ` (Host: ${d.hostname})` : ""}`);
        } else if (prev?.ingress) {
          if (ruleKey(rules[idx]) !== ruleKey(d.rule)) {
            rules[idx] = { ...rules[idx], ...d.rule };
            changed = true;
            log(`${d.hostname}: route updated → ${d.rule.service}`);
          }
          outcome.set(key(d), { ingress: prev.ingress });
        } else if (sameTarget(rules[idx], d.rule)) {
          outcome.set(key(d), { ingress: "adopted" });
          log(`${d.hostname}: already routed the same way — adopted.`);
        } else if (replaceExisting) {
          log(`${d.hostname}: replacing the existing route → ${rules[idx].service} (replace requested)`);
          rules[idx] = d.rule;
          changed = true;
          outcome.set(key(d), { ingress: "created" });
        } else {
          errors.set(d.hostname, `${d.hostname} is already routed in this tunnel to ${rules[idx].service} (set up outside the panel). Remove that public hostname in the Cloudflare dashboard, or use “Replace existing records”.`);
        }
      }
      if (changed) {
        try {
          await putConfig(c, tid, config, rules, catchAll);
        } catch (err) {
          for (const d of add) if (!errors.has(d.hostname)) errors.set(d.hostname, `Saving the tunnel's routes failed: ${err.message}`);
          for (const d of add) outcome.delete(key(d));
          log(`!! saving the tunnel's routes failed: ${err.message}`);
          continue;
        }
      }
      // A removal whose ingress could be dealt with: forget the ledger row
      // once DNS is handled below.
    }

    // 2. DNS: removals (only records we created), then additions
    for (const e of removing) {
      if (e.dnsCreated && e.dnsRecordId && e.zoneId) {
        try {
          const r = await cfCall(c.token, `/zones/${e.zoneId}/dns_records/${e.dnsRecordId}`);
          if (r?.type === "CNAME" && /\.cfargotunnel\.com$/i.test(r.content || "")) {
            await cfCall(c.token, `/zones/${e.zoneId}/dns_records/${e.dnsRecordId}`, { method: "DELETE" });
            log(`${e.hostname}: deleted the DNS record the panel created.`);
          } else {
            log(`${e.hostname}: DNS record was changed outside the panel — left in place.`);
          }
        } catch (err) {
          if (err.status !== 404) log(`!! ${e.hostname}: could not delete its DNS record: ${err.message}`);
        }
      }
      db.remove(COLL, e.id);
    }

    let zoneList = [];
    if (desired.length) {
      try {
        zoneList = await zones({ fresh: true });
      } catch (err) {
        for (const d of desired) if (!errors.has(d.hostname)) errors.set(d.hostname, `Could not list your Cloudflare zones: ${err.message}`);
      }
    }
    for (const d of desired) {
      const prev = prevOf(d);
      if (errors.has(d.hostname)) {
        upsert(owner, siteId, d, prev, { status: "error", error: errors.get(d.hostname), ingress: outcome.get(key(d))?.ingress ?? prev?.ingress ?? null });
        continue;
      }
      const zone = zoneForHostname(zoneList, d.hostname);
      if (!zone) {
        const msg = `${d.hostname} is not in the connected Cloudflare account (zones: ${zoneList.map((z) => z.name).join(", ") || "none"}).`;
        errors.set(d.hostname, msg);
        upsert(owner, siteId, d, prev, { status: "error", error: msg, ingress: outcome.get(key(d))?.ingress ?? null });
        continue;
      }
      try {
        const dns = await ensureDns(c, zone, d, prev, replaceExisting, log);
        upsert(owner, siteId, d, prev, { status: "active", error: null, ingress: outcome.get(key(d))?.ingress ?? prev?.ingress ?? "created", dnsRecordId: dns.id, dnsCreated: dns.created, zone });
        log(`✓ ${d.hostname} is served through the tunnel.`);
      } catch (err) {
        errors.set(d.hostname, err.message);
        upsert(owner, siteId, d, prev, { status: "error", error: err.message, code: err.code || null, ingress: outcome.get(key(d))?.ingress ?? prev?.ingress ?? null, zone });
      }
    }
    emit("routes", { owner, siteId });
    if (errors.size) {
      const e = new Error([...errors.values()].join(" "));
      e.hostnames = [...errors.keys()];
      throw e;
    }
    return { active: desired.length, removed: removing.length };
  }

  function upsert(owner, siteId, d, prev, f) {
    const rec = {
      owner,
      siteId,
      hostname: d.hostname,
      tunnelId: d.tunnelId,
      service: d.rule.service,
      ruleKey: f.status === "active" ? ruleKey(d.rule) : null,
      ingress: f.ingress ?? null,
      dnsRecordId: f.dnsRecordId ?? prev?.dnsRecordId ?? null,
      dnsCreated: f.dnsCreated ?? prev?.dnsCreated ?? false,
      zoneId: f.zone?.id ?? prev?.zoneId ?? null,
      zoneName: f.zone?.name ?? prev?.zoneName ?? null,
      status: f.status,
      error: f.error || null,
      code: f.code || null,
      syncedAt: now(),
    };
    if (prev) db.update(COLL, prev.id, rec);
    else db.insert(COLL, { id: db.newId("cfr"), ...rec });
  }

  // ---------------------------------------------------------- site API

  function siteRecord(siteOrId) {
    const id = typeof siteOrId === "string" ? siteOrId : siteOrId?.id;
    return (id && db.get("sites", id)) || (typeof siteOrId === "object" ? siteOrId : null);
  }

  /**
   * (Re)write the tunnel routes of one website. Returns the job record, or
   * null when there is nothing to do (a Direct-only site with no leftovers).
   */
  function syncSite(siteOrId, { replaceExisting = false, admin = null, force = false } = {}) {
    const site = siteRecord(siteOrId);
    if (!site?.id) return null;
    const desired = desiredForSite(site);
    const current = ledger(siteOwner(site.id));
    if (!force && !desired.length && !current.length) return null;
    if (!force && !replaceExisting && inSync(desired, current)) return null;
    return ctx.jobs.start(
      { type: "cloudflare.sync", title: `Cloudflare routes for ${site.name}`, siteId: site.id, projectId: site.projectId, adminId: admin?.id || null, lock: false },
      ({ log }) => serial(() => reconcile(siteOwner(site.id), desiredForSite(siteRecord(site.id) || site), { log, replaceExisting, siteId: site.id })),
    );
  }

  /** Take every route of a website out of Cloudflare (ours only). Resolves; never rejects for "nothing to do". */
  function removeSite(siteOrId, { log = () => {} } = {}) {
    const id = typeof siteOrId === "string" ? siteOrId : siteOrId?.id;
    if (!id || !ledger(siteOwner(id)).length) return Promise.resolve({ removed: 0 });
    return serial(() => reconcile(siteOwner(id), [], { log, siteId: id }));
  }

  /**
   * Can this site.cloudflare be honoured? Called by SITES before create /
   * update; throws httpError(400) with a friendly message (and `code`).
   */
  async function validateSite(cfg, { domains = [], siteId = null } = {}) {
    if (!cfg?.enabled) return { ok: true };
    const hostnames = (cfg.hostnames || []).filter((h) => domains.includes(h));
    if (!hostnames.length) return { ok: true };
    const panelHost = conf().panel?.hostname;
    if (panelHost && hostnames.includes(panelHost)) throw httpError(409, `${panelHost} is the panel's own Cloudflare hostname.`, { code: "cloudflare_hostname_taken" });
    const local = conf().connectors.find((t) => t.cfId === cfg.tunnelId);
    const c = creds();
    if (!c) {
      if (local) return { ok: true, manual: true };
      throw httpError(400, "Cloudflare isn't connected. Connect it in Settings → Cloudflare first, or deliver these domains directly.", { code: "cloudflare_not_connected" });
    }
    let tunnels, zoneList;
    try {
      [tunnels, zoneList] = await Promise.all([accountTunnels(), zones()]);
    } catch (err) {
      throw httpError(502, `Couldn't check with Cloudflare: ${err.message}`, { code: "cloudflare_unreachable" });
    }
    const t = tunnels.find((x) => x.id === cfg.tunnelId);
    if (!t) throw httpError(400, "That tunnel isn't in the connected Cloudflare account. Pick another one, or create one in Settings → Cloudflare.", { code: "cloudflare_tunnel_missing" });
    if (!t.remotelyManaged) throw httpError(400, `Tunnel “${t.name}” is configured from a local config file, so the panel can't add routes to it. Pick a dashboard-managed tunnel.`, { code: "cloudflare_tunnel_local" });
    const missing = hostnames.filter((h) => !zoneForHostname(zoneList, h));
    if (missing.length) {
      throw httpError(400, `${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} in your Cloudflare account. Add the domain to Cloudflare (or deliver it directly).`, {
        code: "cloudflare_zone_missing",
        hostnames: missing,
        zones: zoneList.map((z) => z.name),
      });
    }
    void siteId;
    return { ok: true };
  }

  function siteRoutes(siteId) {
    return ledger(siteOwner(siteId)).map(publicRoute);
  }
  function publicRoute(r) {
    return { id: r.id, owner: r.owner, siteId: r.siteId, hostname: r.hostname, tunnelId: r.tunnelId, zoneName: r.zoneName, service: r.service, status: r.status, error: r.error, code: r.code || null, ingress: r.ingress, dnsCreated: !!r.dnsCreated, syncedAt: r.syncedAt };
  }

  function isTunnelHostname(hostname) {
    const h = String(hostname || "").toLowerCase();
    return db.list("sites").some((s) => s.cloudflare?.enabled && (s.cloudflare.hostnames || []).includes(h) && (s.domains || []).includes(h));
  }

  // ------------------------------------------------------------- status

  function status() {
    const c = conf();
    const api = !!(reveal(c.apiTokenEnc) && c.accountId);
    const connectors = c.connectors.map(publicConnector);
    return {
      connected: api,
      mode: api ? (c.viaLogin ? "login" : "token") : connectors.length ? "connector" : null,
      configured: api || connectors.length > 0 || !!c.apiTokenEnc,
      hasToken: !!c.apiTokenEnc,
      tokenHint: hint(reveal(c.apiTokenEnc)),
      viaLogin: !!c.viaLogin,
      accountId: c.accountId || "",
      accountName: c.accountName || "",
      connectors,
      running: connectors.filter((x) => x.running).length,
      connectedConnectors: connectors.filter((x) => x.connected).length,
      panel: c.panel?.hostname ? { hostname: c.panel.hostname, tunnelId: c.panel.tunnelId, route: ledger("panel").map(publicRoute)[0] || null } : null,
      panelService: `${panelTls() ? "https" : "http"}://127.0.0.1:${panelPort()}`,
      routes: db.list(COLL).length,
      routeErrors: db.list(COLL, (r) => r.status === "error").length,
      binary: binaryStatus(),
      login: { running: !!login.proc || login.fakeUntil > 0, url: login.url || "" },
      dryRun: DRY,
      simulatedApi: FAKE,
    };
  }

  /** Tunnels a website can use: the account's (API) or the local connectors' (connector-only mode). */
  async function options() {
    const s = status();
    const out = { connected: s.connected, mode: s.mode, accountName: s.accountName, tunnels: [], zones: [], panelHostname: s.panel?.hostname || null, error: null, simulatedApi: FAKE };
    const local = new Map(s.connectors.filter((x) => x.cfId).map((x) => [x.cfId, x]));
    if (s.connected) {
      try {
        const [t, z] = await Promise.all([accountTunnels(), zones()]);
        out.tunnels = t.filter((x) => x.remotelyManaged).map((x) => ({ id: x.id, name: x.name, status: x.status, local: local.has(x.id), running: !!local.get(x.id)?.running, connectedHere: !!local.get(x.id)?.connected }));
        out.zones = z.map((x) => x.name);
      } catch (err) {
        out.error = err.message;
      }
    } else {
      out.tunnels = [...local.values()].map((x) => ({ id: x.cfId, name: x.name, status: null, local: true, running: x.running, connectedHere: x.connected, manual: true }));
    }
    return out;
  }

  // ---------------------------------------------------------------- login

  /**
   * `cloudflared tunnel login`, driven from the panel: cloudflared prints a
   * URL, the admin opens it, Cloudflare writes an origin certificate into a
   * HOME of our own (dataDir/cloudflared-home) carrying an account + token.
   */
  const login = {
    proc: null,
    url: "",
    error: "",
    startedAt: 0,
    output: [],
    fakeUntil: 0,
    get certPath() {
      return path.join(loginHome, ".cloudflared", "cert.pem");
    },
    candidateCerts() {
      const homes = [loginHome, process.env.HOME, os.homedir()].filter(Boolean);
      return [...new Set(homes.map((h) => path.join(h, ".cloudflared", "cert.pem")))];
    },
    async adoptExistingCert() {
      if (DRY) return null; // never read a developer's real certificate in dev
      for (const file of this.candidateCerts()) {
        if (!exists(file)) continue;
        let cr = null;
        try {
          cr = readOriginCert(fs.readFileSync(file, "utf8"));
        } catch {
          continue;
        }
        if (!cr) continue;
        if (!(await canManage(cr.apiToken, cr.accountId)).ok) continue;
        await storeCreds(cr, { viaLogin: true });
        return { certPath: file, accountName: conf().accountName };
      }
      return null;
    },
    async start() {
      this.cancel();
      this.url = "";
      this.error = "";
      this.output = [];
      if (FAKE) {
        this.url = "https://dash.cloudflare.com/argotunnel?simulated=1";
        this.fakeUntil = Date.now() + 2500;
        this.startedAt = Date.now();
        return { ok: true, url: this.url, simulated: true };
      }
      const already = await this.adoptExistingCert();
      if (already) return { ok: true, done: true, ...already };
      if (DRY && !findBinary()) throw httpError(400, "cloudflared isn't installed here (dry run: nothing is downloaded). Use an API token instead.");
      fs.mkdirSync(path.dirname(this.certPath), { recursive: true, mode: 0o700 });
      try {
        fs.unlinkSync(this.certPath);
      } catch {
        /* normal */
      }
      let bin;
      try {
        bin = await resolveBinary();
      } catch (err) {
        throw httpError(400, `cloudflared is not available: ${err.message}`);
      }
      const proc = spawn(bin, ["tunnel", "login"], { env: { ...process.env, HOME: loginHome, TUNNEL_ORIGIN_CERT: this.certPath }, stdio: ["ignore", "pipe", "pipe"] });
      this.proc = proc;
      const onData = (chunk) => {
        const text = chunk.toString();
        for (const l of text.split("\n").map((x) => x.trim()).filter(Boolean)) {
          this.output.push(l);
          if (this.output.length > 40) this.output.shift();
        }
        const m = text.match(/https:\/\/dash\.cloudflare\.com\/argotunnel\S*/);
        if (m && !this.url) this.url = m[0];
      };
      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);
      proc.once("error", (err) => {
        this.output.push(`could not run cloudflared: ${err.message}`);
        this.proc = null;
      });
      proc.once("exit", () => {
        this.proc = null;
      });
      const deadline = Date.now() + 12_000;
      while (!this.url && Date.now() < deadline && this.proc) await new Promise((r) => setTimeout(r, 200));
      if (!this.url) {
        const said = this.lastWords();
        this.cancel();
        throw httpError(400, `cloudflared did not print a login link${said ? `: ${said}` : "."} Use an API token instead.`);
      }
      this.startedAt = Date.now();
      return { ok: true, url: this.url };
    },
    lastWords() {
      const noise = /Version |GOOS|GOARCH|settings:|cloudflared will not automatically update/i;
      return this.output.filter((l) => !noise.test(l)).slice(-2).join(" ").slice(0, 300);
    },
    async poll() {
      if (FAKE && this.fakeUntil) {
        if (Date.now() < this.fakeUntil) return { running: true, url: this.url, done: false, error: "" };
        this.fakeUntil = 0;
        await storeCreds({ apiToken: "simulated-login-token", accountId: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f" }, { viaLogin: true });
        return { running: false, url: this.url, done: true, error: "", accountName: conf().accountName };
      }
      const waiting = { running: !!this.proc, url: this.url, done: false, error: this.error };
      if (!exists(this.certPath)) {
        if (!this.proc && this.startedAt) {
          const said = this.lastWords();
          this.startedAt = 0;
          return { ...waiting, error: this.error || (said ? `cloudflared stopped before the login finished: ${said}` : "cloudflared stopped before the login finished.") };
        }
        return waiting;
      }
      let cr = null;
      try {
        cr = readOriginCert(fs.readFileSync(this.certPath, "utf8"));
      } catch (err) {
        this.error = `Could not read the certificate Cloudflare wrote: ${err.message}`;
      }
      this.cancel();
      if (!cr) return { ...waiting, running: false, error: this.error || "You are logged in, but that certificate does not carry an API token this panel can use. Use an API token instead." };
      const can = await canManage(cr.apiToken, cr.accountId);
      if (!can.ok) return { ...waiting, running: false, error: `Logged in, but those credentials cannot manage tunnels — ${can.reason} Use an API token instead.` };
      await storeCreds(cr, { viaLogin: true });
      return { running: false, url: this.url, done: true, error: "", accountName: conf().accountName };
    },
    cancel() {
      this.startedAt = 0;
      this.fakeUntil = 0;
      if (!this.proc) return;
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* gone */
      }
      this.proc = null;
    },
  };

  async function canManage(token, accountId) {
    try {
      await cfCall(token, `/accounts/${accountId}/cfd_tunnel?per_page=1`);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  async function storeCreds(cr, { viaLogin }) {
    const c = conf();
    c.apiTokenEnc = ctx.secrets.encrypt(cr.apiToken);
    c.accountId = cr.accountId;
    c.accountName = "";
    c.viaLogin = !!viaLogin;
    try {
      const accounts = await cfCall(cr.apiToken, "/accounts?per_page=50");
      c.accountName = accounts.find((a) => a.id === cr.accountId)?.name || "";
    } catch {
      /* a nicety */
    }
    save();
    invalidate();
    emitStatusSoon();
  }

  // --------------------------------------------------------------- routes

  function routes(router) {
    const audit = (admin, action, details) => {
      try {
        ctx.activity?.(admin, action, { type: "cloudflare", id: "cloudflare", name: "Cloudflare" }, details);
      } catch {
        /* never block */
      }
    };
    const needCreds = () => {
      const c = creds();
      if (!c) throw httpError(400, "Connect Cloudflare first (log in, or paste an API token).", { code: "cloudflare_not_connected" });
      return c;
    };
    const wrap = async (fn) => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw httpError(/Could not reach Cloudflare|did not answer in time/.test(err.message) ? 502 : 400, err.message);
      }
    };

    router.get("/api/cloudflare", async () => {
      const out = { ...status(), accounts: [], zones: [], tunnels: [], error: null };
      if (!reveal(conf().apiTokenEnc)) return out;
      try {
        const token = reveal(conf().apiTokenEnc);
        out.accounts = (await cfCall(token, "/accounts?per_page=50")).map((a) => ({ id: a.id, name: a.name }));
        if (!conf().accountId && out.accounts.length === 1) {
          conf().accountId = out.accounts[0].id;
          conf().accountName = out.accounts[0].name;
          save();
          Object.assign(out, status());
        }
        if (creds()) {
          const [z, t] = await Promise.all([zones(), accountTunnels({ fresh: true })]);
          out.zones = z;
          const local = new Map(conf().connectors.filter((x) => x.cfId).map((x) => [x.cfId, x.id]));
          out.tunnels = t.map((x) => ({ ...x, connectorId: local.get(x.id) || null }));
          const gone = conf().connectors.filter((x) => x.cfId && !t.some((y) => y.id === x.cfId));
          if (gone.length) out.warning = `No longer in this Cloudflare account: ${gone.map((x) => x.name).join(", ")}.`;
        }
      } catch (err) {
        out.error = err.message;
      }
      return out;
    });

    router.get("/api/cloudflare/status", async () => status());
    router.get("/api/cloudflare/options", async () => options());
    router.get("/api/cloudflare/zones", async () => {
      if (!creds()) return { items: [], connected: false };
      try {
        return { items: await zones(), connected: true };
      } catch (err) {
        throw httpError(502, `Couldn't list zones: ${err.message}`);
      }
    });

    // ---- connecting
    router.post("/api/cloudflare/token", async (req, res, { body, admin }) => {
      const token = String(body.token || "").trim();
      const c = conf();
      if (!token) {
        c.apiTokenEnc = "";
        c.accountId = "";
        c.accountName = "";
        c.viaLogin = false;
        save();
        invalidate();
        audit(admin, "cloudflare.disconnect", {});
        emitStatusSoon();
        return { ok: true, cleared: true, status: status() };
      }
      return wrap(async () => {
        const who = await cfCall(token, "/user/tokens/verify");
        if (who.status !== "active") throw new Error(`That token is ${who.status}.`);
        const accounts = (await cfCall(token, "/accounts?per_page=50")).map((a) => ({ id: a.id, name: a.name }));
        c.apiTokenEnc = ctx.secrets.encrypt(token);
        c.viaLogin = false;
        if (accounts.length === 1 || !accounts.some((a) => a.id === c.accountId)) {
          c.accountId = accounts.length === 1 ? accounts[0].id : "";
          c.accountName = accounts.length === 1 ? accounts[0].name : "";
        }
        save();
        invalidate();
        audit(admin, "cloudflare.connect", { via: "token", account: c.accountName });
        emitStatusSoon();
        return { ok: true, accounts, expiresOn: who.expires_on || null, status: status() };
      });
    });

    router.post("/api/cloudflare/account", async (req, res, { body, admin }) => {
      const token = reveal(conf().apiTokenEnc);
      if (!token) throw httpError(400, "Connect Cloudflare first.");
      return wrap(async () => {
        const accounts = await cfCall(token, "/accounts?per_page=50");
        const picked = accounts.find((a) => a.id === body.accountId);
        if (!picked) throw new Error("That account is not one this token can see.");
        conf().accountId = picked.id;
        conf().accountName = picked.name;
        save();
        invalidate();
        audit(admin, "cloudflare.account", { account: picked.name });
        emitStatusSoon();
        return { ok: true, account: { id: picked.id, name: picked.name } };
      });
    });

    router.post("/api/cloudflare/login", async (req, res, { admin }) => {
      const r = await login.start();
      if (r.done) audit(admin, "cloudflare.connect", { via: "login" });
      return r;
    });
    router.get("/api/cloudflare/login", async (req, res, { admin }) => {
      const r = await login.poll();
      if (r.done) audit(admin, "cloudflare.connect", { via: "login", account: r.accountName });
      return r;
    });
    router.post("/api/cloudflare/login/cancel", async () => {
      login.cancel();
      return { ok: true };
    });

    // ---- tunnels in the account
    router.post("/api/cloudflare/tunnels", async (req, res, { body, admin }) => {
      const c = needCreds();
      return wrap(async () => {
        let tun;
        if (body.tunnelId) {
          tun = await cfCall(c.token, `/accounts/${c.accountId}/cfd_tunnel/${encodeURIComponent(body.tunnelId)}`);
        } else {
          const name = String(body.name || "").trim().slice(0, 60) || `fcc-${os.hostname()}`;
          tun = await cfCall(c.token, `/accounts/${c.accountId}/cfd_tunnel`, { method: "POST", body: { name, config_src: "cloudflare" } });
        }
        if (tun.remote_config === false) throw new Error(`Tunnel “${tun.name}” is configured from a local file, so the panel can't manage its routes.`);
        const token = await cfCall(c.token, `/accounts/${c.accountId}/cfd_tunnel/${tun.id}/token`);
        if (typeof token !== "string" || !token) throw new Error("Cloudflare did not return a connector token for that tunnel.");
        const { entry: e } = addConnector({ token, name: tun.name, cfId: tun.id, autoStart: body.autoStart !== false });
        invalidate();
        let started = false;
        let startError = null;
        if (body.start !== false) {
          try {
            await stopConnector(e.id);
            await startConnector(e.id);
            started = true;
          } catch (err) {
            startError = err.message;
          }
        }
        audit(admin, body.tunnelId ? "cloudflare.tunnel.adopt" : "cloudflare.tunnel.create", { tunnel: tun.name, tunnelId: tun.id });
        emitStatusSoon();
        return { ok: true, tunnel: { id: tun.id, name: tun.name }, connector: publicConnector(e), started, startError };
      });
    });

    // ---- connectors run here
    router.get("/api/cloudflare/connectors", async () => ({ items: conf().connectors.map(publicConnector), binary: binaryStatus() }));

    router.post("/api/cloudflare/connectors", async (req, res, { body, admin }) => {
      const token = String(body.token || "").trim().replace(/^.*\s/, ""); // tolerate a pasted `cloudflared ... run <token>` line
      if (!token || token.length < 40) throw httpError(400, "Paste the connector token from the Cloudflare dashboard (Zero Trust → Networks → Tunnels → Configure).");
      const { entry: e, existing } = addConnector({ token, name: body.name, autoStart: typeof body.autoStart === "boolean" ? body.autoStart : undefined });
      let startError = null;
      if (e.autoStart !== false) {
        try {
          if (existing) await stopConnector(e.id);
          await startConnector(e.id);
        } catch (err) {
          startError = err.message;
        }
      }
      audit(admin, "cloudflare.connector.add", { name: e.name, tunnelId: e.cfId || null });
      emitStatusSoon();
      return { ok: true, connector: publicConnector(e), startError };
    });

    router.patch("/api/cloudflare/connectors/:id", async (req, res, { params, body, admin }) => {
      const e = entry(params.id);
      if (!e) throw httpError(404, "No such connector.");
      if (typeof body.name === "string" && body.name.trim()) e.name = body.name.trim().slice(0, 60);
      if (typeof body.autoStart === "boolean") e.autoStart = body.autoStart;
      save();
      audit(admin, "cloudflare.connector.update", { name: e.name, autoStart: e.autoStart !== false });
      emitStatusSoon();
      return publicConnector(e);
    });

    router.delete("/api/cloudflare/connectors/:id", async (req, res, { params, admin }) => {
      const e = entry(params.id);
      if (!e) throw httpError(404, "No such connector.");
      await stopConnector(e.id).catch(() => {});
      running.delete(e.id);
      conf().connectors = conf().connectors.filter((x) => x.id !== e.id);
      save();
      audit(admin, "cloudflare.connector.remove", { name: e.name });
      emitStatusSoon();
      return { ok: true, note: "The tunnel itself stays in your Cloudflare account." };
    });

    for (const verb of ["start", "stop", "restart"]) {
      router.post(`/api/cloudflare/connectors/:id/${verb}`, async (req, res, { params, admin }) => {
        const e = entry(params.id);
        if (!e) throw httpError(404, "No such connector.");
        if (verb !== "start") await stopConnector(e.id);
        if (verb !== "stop") await startConnector(e.id);
        audit(admin, `cloudflare.connector.${verb}`, { name: e.name });
        emitStatusSoon();
        return publicConnector(e);
      });
    }

    router.get("/api/cloudflare/connectors/:id/logs", async (req, res, { params, query }) => {
      const e = entry(params.id);
      if (!e) throw httpError(404, "No such connector.");
      const n = Math.max(1, Math.min(MAX_LOG_LINES, Number(query.lines) || 150));
      return { lines: running.get(e.id)?.log.slice(-n) || [] };
    });

    router.post("/api/cloudflare/install", async (req, res, { admin }) => {
      return wrap(async () => {
        await download();
        audit(admin, "cloudflare.install", { version });
        return binaryStatus();
      });
    });

    // ---- routes
    function siteTargets(site) {
      if (!site) return null;
      try {
        const ups = ctx.lb?.upstreams?.(site) || [];
        return ups.map((u) => ({ server: u.name || u.serverId, address: `${u.address}:${u.port}`, healthy: u.healthy ?? null }));
      } catch {
        return null;
      }
    }

    router.get("/api/cloudflare/routes", async () => {
      const all = db.list(COLL);
      const sitesById = Object.fromEntries(db.list("sites").map((s) => [s.id, s]));
      const ledgerItems = all.map((r) => ({ ...publicRoute(r), siteName: sitesById[r.siteId]?.name || null }));
      const c = creds();
      const tunnelIds = [...new Set([...conf().connectors.map((x) => x.cfId).filter(Boolean), ...all.map((r) => r.tunnelId)])];
      const names = new Map(conf().connectors.filter((x) => x.cfId).map((x) => [x.cfId, x.name]));
      const tunnels = [];
      for (const tid of tunnelIds) {
        const t = { tunnelId: tid, name: names.get(tid) || tid.slice(0, 8), rules: [], error: null };
        if (!c) {
          t.error = "Connect an API token or log in to read this tunnel's routes.";
        } else {
          try {
            const cfg = await getConfig(c, tid);
            t.rules = cfg.ingress.map((r) => {
              const mine = all.find((x) => x.tunnelId === tid && x.hostname === r.hostname && !r.path);
              return {
                hostname: r.hostname || null,
                path: r.path || "",
                service: r.service,
                catchAll: !r.hostname && !r.path,
                managed: !!mine && mine.ingress === "created",
                adopted: !!mine && mine.ingress === "adopted",
                siteId: mine?.siteId || null,
                siteName: mine?.siteId ? sitesById[mine.siteId]?.name || null : null,
                // The tunnel hands site traffic to nginx (the front door); these are
                // where nginx sends it on, so the UI can show the whole route.
                targets: mine?.siteId ? siteTargets(sitesById[mine.siteId]) : null,
                loadBalanced: mine?.siteId ? !!sitesById[mine.siteId]?.loadBalanced : false,
                panel: mine?.owner === "panel",
              };
            });
          } catch (err) {
            t.error = err.message;
          }
        }
        tunnels.push(t);
      }
      return { items: ledgerItems, tunnels };
    });

    router.get("/api/cloudflare/sites/:id", async (req, res, { params }) => {
      const site = db.get("sites", params.id);
      if (!site) throw httpError(404, "Website not found.");
      const cfg = site.cloudflare || { enabled: false, tunnelId: "", hostnames: [] };
      const recs = siteRoutes(site.id);
      const tunnelHosts = new Set(cfg.enabled ? cfg.hostnames || [] : []);
      return {
        cloudflare: cfg,
        connected: !!creds(),
        domains: (site.domains || []).map((d) => {
          const r = recs.find((x) => x.hostname === d) || null;
          return { hostname: d, mode: tunnelHosts.has(d) ? "tunnel" : "direct", route: r };
        }),
        leftovers: recs.filter((r) => !tunnelHosts.has(r.hostname)),
      };
    });

    router.post("/api/cloudflare/sites/:id/sync", async (req, res, { params, body, admin }) => {
      const site = db.get("sites", params.id);
      if (!site) throw httpError(404, "Website not found.");
      const job = syncSite(site, { replaceExisting: !!body.replaceExisting, admin, force: true });
      if (body.replaceExisting) audit(admin, "cloudflare.site.replace", { site: site.name });
      return job || { ok: true, nothing: true };
    });

    // ---- the panel itself on a hostname
    router.put("/api/cloudflare/panel", async (req, res, { body, admin }) => {
      const hostname = String(body.hostname || "").trim().toLowerCase().replace(/\.$/, "");
      const c = conf();
      if (hostname) {
        if (!HOST_RE.test(hostname)) throw httpError(400, "That is not a usable hostname.");
        const tunnelId = String(body.tunnelId || c.connectors.find((x) => x.cfId)?.cfId || "");
        if (!UUID_RE.test(tunnelId)) throw httpError(400, "Pick which tunnel publishes the panel.");
        const clash = db.list("sites").find((s) => (s.domains || []).includes(hostname));
        if (clash) throw httpError(409, `${hostname} is a domain of website “${clash.name}”.`);
        if (creds()) {
          const z = await wrap(() => zones());
          if (!zoneForHostname(z, hostname)) throw httpError(400, `${hostname} isn't in your Cloudflare account.`, { code: "cloudflare_zone_missing" });
        }
        c.panel = { hostname, tunnelId };
      } else {
        c.panel = null;
      }
      save();
      audit(admin, hostname ? "cloudflare.panel.publish" : "cloudflare.panel.unpublish", { hostname: hostname || null });
      const job = ctx.jobs.start(
        { type: "cloudflare.sync", title: hostname ? `Publish the panel on ${hostname}` : "Unpublish the panel from Cloudflare", adminId: admin?.id || null, lock: false },
        ({ log }) => serial(() => reconcile("panel", desiredForPanel(), { log })),
      );
      emitStatusSoon();
      return { ok: true, panel: status().panel, job };
    });

    /**
     * Forget everything about Cloudflare, locally. Routes, DNS records and
     * tunnels stay in the Cloudflare account (deleting them would take sites
     * off the internet); what goes is what this panel holds.
     */
    router.post("/api/cloudflare/reset", async (req, res, { admin }) => {
      const removed = [];
      const remaining = [];
      const wasRunning = [...running.values()].some((x) => x.running);
      await Promise.allSettled([...running.keys()].map((id) => stopConnector(id)));
      running.clear();
      login.cancel();
      const c = conf();
      if (c.apiTokenEnc) removed.push(c.viaLogin ? "the Cloudflare login credentials" : "the Cloudflare API token");
      if (c.accountId) removed.push("which account to use");
      if (c.connectors.length) removed.push(`${c.connectors.length} connector token${c.connectors.length === 1 ? "" : "s"}`);
      if (c.panel?.hostname) removed.push(`the panel hostname ${c.panel.hostname}`);
      const routesN = db.list(COLL).length;
      if (routesN) {
        db.removeWhere(COLL, () => true);
        removed.push(`the record of ${routesN} route${routesN === 1 ? "" : "s"} the panel made`);
        remaining.push(`${routesN} public hostname${routesN === 1 ? "" : "s"} and their DNS records are still in your Cloudflare account — remove them in the dashboard if you no longer want them.`);
      }
      ctx.config.cloudflare = { apiTokenEnc: "", accountId: "", accountName: "", viaLogin: false, connectors: [], panel: null };
      save();
      invalidate();
      for (const file of login.candidateCerts()) {
        if (!exists(file)) continue;
        if (!file.startsWith(ctx.dataDir)) {
          remaining.push(`${file} (not created by the panel, left alone)`);
          continue;
        }
        try {
          fs.unlinkSync(file);
          removed.push(`the login certificate at ${file}`);
        } catch (err) {
          remaining.push(`${file} (could not be removed: ${err.message})`);
        }
      }
      audit(admin, "cloudflare.reset", { removed: removed.length });
      emitStatusSoon();
      return { ok: true, removed, remaining, tunnelStopped: wasRunning, note: "Websites set to Cloudflare Tunnel keep that setting; reconnect to manage their routes again." };
    });
  }

  // ------------------------------------------------------------ lifecycle

  let onLb = null;
  async function startModule() {
    conf();
    readVersion().catch(() => {});
    for (const e of conf().connectors) {
      if (e.autoStart === false || !e.tokenEnc) continue;
      try {
        await startConnector(e.id);
      } catch (err) {
        connectorObj(e.id).line(`Could not start: ${err.message}`);
      }
    }
    // A certificate turning on/off changes how a tunnel must reach nginx (:80 vs :443).
    onLb = (d) => {
      if (!d?.siteId || !d.ssl) return;
      const site = db.get("sites", d.siteId);
      if (site?.cloudflare?.enabled) {
        try {
          syncSite(site);
        } catch {
          /* recorded in the ledger */
        }
      }
    };
    ctx.events?.on?.("lb", onLb);
  }

  async function stopModule() {
    if (onLb) ctx.events?.off?.("lb", onLb);
    login.cancel();
    await Promise.allSettled([...running.keys()].map((id) => stopConnector(id)));
  }

  return {
    routes,
    start: startModule,
    stop: stopModule,
    api: {
      status,
      options,
      zones: (o) => zones(o),
      syncSite,
      removeSite,
      validateSite,
      siteRoutes,
      isTunnelHostname,
    },
  };
}
