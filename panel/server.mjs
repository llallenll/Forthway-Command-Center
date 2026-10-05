#!/usr/bin/env node
/**
 * Forthway Command Center — Standalone panel (v3).
 *
 * A self-hosted control panel that runs on its own VPS: websites (single
 * server or load balanced across workers behind nginx), MySQL databases and
 * backups, grouped into projects, managed by any number of admins.
 *
 * This file only boots and wires things together:
 *   1. config.json in the data dir (keys created on first run, mode 600);
 *   2. the JSON store, secrets, jobs, the live event stream, sessions;
 *   3. the feature modules, in contract order — register() all, then start()
 *      all. A module that is missing or throws is skipped with a warning so the
 *      panel always comes up (docs/STANDALONE.md §3);
 *   4. one http(s) server: API routes through the Router, then static pages.
 *
 * Zero npm dependencies, Node 18+. Development on a laptop:
 *   FCC_DRY_RUN=1 FCC_DATA_DIR=./.devdata node panel/server.mjs
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Router, sendJson, send, redirect } from "./lib/http.mjs";
import * as sys from "./lib/sys.mjs";
import { Store, writeFileAtomic } from "./lib/store.mjs";
import { createAuth, requestProto, requestHost, TRUST_PROXY } from "./lib/auth.mjs";
import { createSecrets } from "./lib/secrets.mjs";
import { createJobs } from "./lib/jobs.mjs";
import { createActivity } from "./lib/core-routes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PUBLIC_DIR = path.join(HERE, "public");
const VERSION = "3.0.0";

/** Contract order (docs/STANDALONE.md §3). core-routes is required; the rest are optional. */
const MODULES = ["core-routes", "cluster", "loadbalancer", "sites", "mysql", "backups"];
const START_TIMEOUT_MS = 15_000;
const SSE_PING_MS = 20_000;

function fatal(message) {
  console.error(`\n[fcc] ${message}\n`);
  process.exit(1);
}

// ------------------------------------------------------------- data + config

const DATA_DIR = path.resolve(
  process.env.FCC_DATA_DIR || (sys.DRY_RUN ? path.join(ROOT, ".devdata") : "/var/lib/fcc"),
);
try {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(DATA_DIR, 0o700);
} catch (err) {
  fatal(`Cannot use data directory ${DATA_DIR}: ${err.message}. Set FCC_DATA_DIR to a writable folder.`);
}

const CONFIG_PATH = path.join(DATA_DIR, "config.json");

function defaultConfig() {
  return {
    panelName: "Forthway Command Center",
    panelUrl: "",
    port: 4000,
    host: "0.0.0.0",
    sessionSecret: "",
    secretKey: "",
    github: { token: "" },
    backups: {
      database: { enabled: true, every: "daily", at: "03:00", keep: 14 },
      server: {
        enabled: false,
        every: "weekly",
        at: "04:00",
        keep: 4,
        include: { panel: true, sites: true, nginx: true, databases: false },
      },
      destination: { type: "local" },
    },
    mysql: { socket: "", rootUser: "root", host: "127.0.0.1", port: 3306 },
    tls: null, // { key: "/path/privkey.pem", cert: "/path/fullchain.pem" }
  };
}

/**
 * A config.json that exists but cannot be parsed is fatal, never replaced:
 * a fresh secretKey would make every encrypted secret in db.json unreadable.
 */
function loadConfig() {
  let cfg = null;
  let dirty = false;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch (err) {
      fatal(`${CONFIG_PATH} is not valid JSON (${err.message}). Fix it by hand; it holds the panel's keys.`);
    }
  } else {
    cfg = {};
    dirty = true;
  }
  const defaults = defaultConfig();
  for (const [k, v] of Object.entries(defaults)) {
    if (cfg[k] === undefined) {
      cfg[k] = v;
      dirty = true;
    }
  }
  if (!cfg.sessionSecret) {
    cfg.sessionSecret = crypto.randomBytes(32).toString("hex");
    dirty = true;
  }
  if (!cfg.secretKey) {
    cfg.secretKey = crypto.randomBytes(32).toString("hex");
    dirty = true;
  }
  if (dirty) writeFileAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2), 0o600);
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch { /* best effort */ }
  return cfg;
}

const config = loadConfig();

function saveConfig() {
  writeFileAtomic(CONFIG_PATH, JSON.stringify(config, null, 2), 0o600);
}

const PORT = Number(process.env.FCC_PORT) || Number(config.port) || 4000;
const HOST = process.env.FCC_HOST || config.host || "0.0.0.0";

const TLS = (() => {
  const key = process.env.FCC_TLS_KEY || config.tls?.key;
  const cert = process.env.FCC_TLS_CERT || config.tls?.cert;
  if (!key || !cert) return null;
  try {
    return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  } catch (err) {
    fatal(`TLS is configured but the key/cert cannot be read: ${err.message}`);
  }
})();

// -------------------------------------------------------------- event bus

/**
 * Server-sent events to every signed-in browser. `broadcast()` also emits
 * in-process (`ctx.events.on(name, fn)`) for modules that want to react to
 * each other's changes without importing each other.
 */
function createEvents(db) {
  const clients = new Set(); // { res, adminId, ping }
  const local = new EventEmitter();
  local.setMaxListeners(100);

  function write(client, chunk) {
    try {
      client.res.write(chunk);
    } catch {
      drop(client);
    }
  }

  function drop(client) {
    clearInterval(client.ping);
    clients.delete(client);
    try {
      client.res.end();
    } catch { /* already closed */ }
  }

  return {
    broadcast(event, data) {
      const chunk = `event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
      for (const c of clients) write(c, chunk);
      if (event !== "error" && local.listenerCount(event)) {
        try {
          local.emit(event, data);
        } catch (err) {
          console.error(`[fcc] event listener for "${event}" failed:`, err);
        }
      }
    },

    subscribe(req, res, admin) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.socket?.setNoDelay?.(true);
      const client = { res, adminId: admin?.id || null, ping: null };
      clients.add(client);
      res.write(`retry: 3000\n\nevent: hello\ndata: ${JSON.stringify({ version: VERSION, at: new Date().toISOString() })}\n\n`);
      client.ping = setInterval(() => {
        // A deleted admin's open stream is closed at the next ping.
        if (client.adminId && !db.get("admins", client.adminId)) return drop(client);
        write(client, `: ping ${Date.now()}\n\n`);
      }, SSE_PING_MS);
      client.ping.unref?.();
      req.on("close", () => drop(client));
    },

    on: (event, fn) => local.on(event, fn),
    off: (event, fn) => local.off(event, fn),
    clientCount: () => clients.size,
    closeAll() {
      for (const c of [...clients]) drop(c);
    },
  };
}

// ------------------------------------------------------------ build ctx

let db;
try {
  db = new Store(DATA_DIR);
} catch (err) {
  fatal(err.message);
}
const secrets = createSecrets(config.secretKey);
const events = createEvents(db);
const jobs = createJobs({ db, dataDir: DATA_DIR, events });
const interrupted = jobs.recover();
const auth = createAuth({ db, config });

function firstIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === "IPv4" && !ni.internal) return ni.address;
  }
  return "127.0.0.1";
}

/**
 * Public base URL of the panel (used in agent install commands):
 * config.panelUrl, else FCC_PANEL_URL (set by install.sh with a panel
 * domain), else how this request reached us, else first LAN address.
 */
function panelUrl(req) {
  const fixed = config.panelUrl || process.env.FCC_PANEL_URL;
  if (fixed) return String(fixed).replace(/\/+$/, "");
  if (req) {
    const host = requestHost(req);
    if (host) return `${requestProto(req, config)}://${host}`;
  }
  return `${TLS ? "https" : "http"}://${firstIPv4()}:${PORT}`;
}

const ctx = {
  version: VERSION,
  rootDir: ROOT,
  dataDir: DATA_DIR,
  config,
  saveConfig,
  db,
  secrets,
  jobs,
  events,
  activity: null,
  panelUrl,
  sys,
  auth, // CORE extra: { authenticate(req), ... } — see docs/STANDALONE.md "Changes"
  // cluster, lb, sites, mysql, backups are attached by their modules.
};
ctx.activity = createActivity(ctx);

// ------------------------------------------------------------- modules

const router = new Router();
const loaded = []; // [{ name, mod }]

async function loadModules() {
  for (const name of MODULES) {
    const file = path.join(HERE, "lib", `${name}.mjs`);
    let mod;
    try {
      if (!fs.existsSync(file)) throw Object.assign(new Error("file not found"), { code: "MISSING" });
      mod = await import(pathToFileURL(file).href);
    } catch (err) {
      if (name === "core-routes") fatal(`core-routes failed to load: ${err.stack || err.message}`);
      console.warn(`[fcc] module ${name}: not loaded (${err.code === "MISSING" ? "not installed" : err.message})`);
      continue;
    }
    try {
      if (typeof mod.register === "function") mod.register(router, ctx);
      loaded.push({ name, mod });
    } catch (err) {
      if (name === "core-routes") fatal(`core-routes failed to register: ${err.stack || err.message}`);
      console.warn(`[fcc] module ${name}: register() failed — skipped.`, err);
    }
  }

  for (const { name, mod } of loaded) {
    if (typeof mod.start !== "function") continue;
    let timer;
    try {
      const outcome = await Promise.race([
        Promise.resolve().then(() => mod.start(ctx)).then(() => "ok"),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("slow"), START_TIMEOUT_MS);
        }),
      ]);
      if (outcome === "slow") console.warn(`[fcc] module ${name}: start() still running after ${START_TIMEOUT_MS / 1000}s — continuing.`);
    } catch (err) {
      console.warn(`[fcc] module ${name}: start() failed.`, err);
    } finally {
      clearTimeout(timer);
    }
  }
}

// --------------------------------------------------------- static files

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const PAGES = new Set(["index.html", "login.html", "setup.html"]);

/**
 * Map a URL path to a file inside panel/public, or null. Refuses anything
 * that decodes to a path outside public/ (.., encoded slashes, symlinks out),
 * dotfiles, and NUL bytes.
 */
function resolvePublic(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/").filter(Boolean);
  if (!segments.length || segments.some((s) => s.startsWith(".") || s === "..")) return null;
  const full = path.resolve(PUBLIC_DIR, ...segments);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return null;
  let real;
  try {
    real = fs.realpathSync(full);
    if (!real.startsWith(fs.realpathSync(PUBLIC_DIR) + path.sep)) return null;
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

function serveFile(req, res, file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return sendJson(res, 404, { error: "Not found" });
  }
  const etag = `W/"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
  const headers = {
    "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-cache",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, "Content-Length": stat.size });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
}

function servePage(req, res, name) {
  const file = path.join(PUBLIC_DIR, name);
  let html;
  try {
    html = fs.readFileSync(file);
  } catch {
    return send(res, 503, `<!doctype html><title>Forthway Command Center</title><p>The panel UI (panel/public/${name}) is not installed.</p>`);
  }
  send(res, 200, req.method === "HEAD" ? "" : html, {
    "Content-Type": "text/html; charset=utf-8",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
  });
}

async function serveStaticOrPage(req, res, url) {
  const p = url.pathname;

  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed" });

  // Plain files: /assets/* and anything else with an extension that exists
  // in public/ (favicon, manifest…). The three HTML pages are only served
  // through the page logic below, never by file name.
  const base = path.posix.basename(p);
  if (p.startsWith("/assets/") || (path.posix.extname(p) && !PAGES.has(base))) {
    const file = resolvePublic(p);
    if (file) return serveFile(req, res, file);
    return sendJson(res, 404, { error: "Not found" });
  }

  const needsSetup = db.list("admins").length === 0;
  if (needsSetup) {
    if (p === "/setup") return servePage(req, res, "setup.html");
    return redirect(res, "/setup");
  }
  if (p === "/setup") return redirect(res, "/");

  const admin = await auth.authenticate(req);
  if (p === "/login" || p === "/login.html") {
    return admin ? redirect(res, "/") : servePage(req, res, "login.html");
  }
  if (p === "/" || p === "/index.html") return servePage(req, res, admin ? "index.html" : "login.html");
  if (p === "/setup.html") return redirect(res, "/");

  // Anything else is a client-side route of the app (e.g. /projects/prj_x).
  if (path.posix.extname(p)) return sendJson(res, 404, { error: "Not found" });
  if (admin) return servePage(req, res, "index.html");
  return redirect(res, `/login?next=${encodeURIComponent(p + url.search)}`);
}

// ------------------------------------------------------------- server

async function handler(req, res) {
  let url;
  try {
    url = new URL(req.url || "/", "http://panel.local");
  } catch {
    return sendJson(res, 400, { error: "Bad request" });
  }
  try {
    const handled = await router.handle(req, res, url, { authenticate: auth.authenticate });
    if (handled) return;
    const p = url.pathname;
    if (p === "/api" || p.startsWith("/api/") || p.startsWith("/agent/") || p.startsWith("/install/")) {
      return sendJson(res, 404, { error: "Not found" });
    }
    await serveStaticOrPage(req, res, url);
  } catch (err) {
    console.error(`[fcc] ${req.method} ${url.pathname}`, err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message || "Internal error" });
    else res.end();
  }
}

const server = TLS ? https.createServer(TLS, handler) : http.createServer(handler);
// Uploads can be big and SSE streams are long-lived; do not time them out.
server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 70_000;

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") fatal(`Port ${PORT} is already in use. Set FCC_PORT or "port" in ${CONFIG_PATH}.`);
  if (err.code === "EACCES") fatal(`No permission to listen on ${HOST}:${PORT}.`);
  fatal(`Server error: ${err.stack || err.message}`);
});

process.on("unhandledRejection", (err) => {
  console.error("[fcc] unhandled promise rejection:", err);
});

// -------------------------------------------------------------- shutdown

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[fcc] ${signal} — shutting down`);
  const force = setTimeout(() => {
    try {
      db.save({ immediate: true });
    } catch { /* nothing more to do */ }
    process.exit(0);
  }, 8000);
  force.unref();

  server.close();
  events.closeAll();
  server.closeIdleConnections?.();

  for (const { name, mod } of [...loaded].reverse()) {
    if (typeof mod.stop !== "function") continue;
    try {
      await Promise.race([Promise.resolve().then(() => mod.stop(ctx)), new Promise((r) => setTimeout(r, 3000))]);
    } catch (err) {
      console.warn(`[fcc] module ${name}: stop() failed.`, err.message);
    }
  }

  jobs.shutdown("panel stopped");
  try {
    db.save({ immediate: true });
  } catch (err) {
    console.error("[fcc] could not save db.json on shutdown:", err.message);
  }
  server.closeAllConnections?.();
  clearTimeout(force);
  process.exit(0);
}
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => shutdown(sig));

// ----------------------------------------------------------------- boot

await loadModules();

server.listen(PORT, HOST, () => {
  const scheme = TLS ? "https" : "http";
  console.log(`\n  Forthway Command Center v${VERSION} (standalone)`);
  console.log(`  ${"-".repeat(46)}`);
  const fixed = config.panelUrl || process.env.FCC_PANEL_URL;
  console.log(`  open  ${fixed ? panelUrl() : `${scheme}://${HOST === "0.0.0.0" ? firstIPv4() : HOST}:${PORT}`}`);
  console.log(`  bind  ${HOST}:${PORT}${TRUST_PROXY ? " (trusting X-Forwarded-* from the proxy)" : ""}`);
  console.log(`  data  ${DATA_DIR}`);
  console.log(`  mods  ${loaded.map((m) => m.name).join(", ")}`);
  if (sys.DRY_RUN) console.log("  mode  DRY RUN — system commands are logged, not run");
  if (interrupted) console.log(`  jobs  ${interrupted} interrupted job(s) marked failed (panel restarted)`);
  if (!db.list("admins").length) console.log("\n  Not set up yet — open the address above to create the first admin.");
  console.log("");
});
