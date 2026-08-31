#!/usr/bin/env node
/**
 * Forthway Command Center
 *
 * A password-protected control panel for the sites you run. Add a site, point
 * it at a folder on this machine (or at a remote agent), then upload a zip or
 * pull a branch from GitHub and it does the rest: unpack, install, build,
 * swap, restart, confirm the version that is actually serving traffic, and
 * roll back if it did not come up.
 *
 * Design notes:
 *  - Zero npm dependencies. It must start on a bare Node install and must not
 *    need a build step of its own, because it is the thing you use when a
 *    build has gone wrong.
 *  - A site's app usually lives on this same machine, so the default runner is
 *    "local": the hub does the work itself, in-process, with no agent at all.
 *    Sites on other machines use an agent that dials OUT to the hub, so no
 *    ports need opening on them.
 *  - Nothing is hardcoded. A fresh install has no sites; everything is
 *    created, edited and removed from the dashboard.
 *  - The listen port is read from the environment first, so a Pterodactyl
 *    container's allocated port (SERVER_PORT) just works.
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { Store } from "./lib/store.mjs";
import { LocalRunner } from "./lib/runner.mjs";
import {
  hashPassword,
  verifyPassword,
  issueSession,
  isAuthed,
  sessionCookieHeader,
  clearCookieHeader,
  LoginThrottle,
  tokenMatches,
} from "./lib/auth.mjs";
import {
  createSite,
  sanitizeSettings,
  sanitizeGithub,
  safeUrl,
  publicSite,
  agentFacingSettings,
  settingsHash,
  newToken,
  RUNNERS,
} from "./lib/sites.mjs";
import { normalizeRepo, repoInfo, listRefs, resolveCommit, downloadZipball, checkToken } from "./lib/github.mjs";
import { Tunnel } from "./lib/tunnel.mjs";
import {
  DEFAULT_REPO as UPDATE_REPO,
  checkForUpdate,
  applyUpdate,
  installedVersion,
  listBackups,
  restoreBackup,
} from "./lib/updates.mjs";
import { inspectZip } from "../shared/zip.mjs";
import { ensureDir, readJson, writeJson, exists, humanBytes } from "../shared/fsx.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FCC_VERSION = "2.2.0";
const POLL_TIMEOUT_MS = 25_000;
const AGENT_OFFLINE_AFTER_MS = 45_000;

// ---------------------------------------------------------------- config

const CONFIG_PATH = process.env.FCC_CONFIG || path.join(HERE, "config.json");
let DATA_DIR_RAW = "./data";

/**
 * Pterodactyl hands a container its allocated port as SERVER_PORT, and most
 * other hosts use PORT. Either wins over the config file, because the config
 * file cannot know what the panel allocated.
 */
function envPort() {
  for (const key of ["FCC_PORT", "SERVER_PORT", "PORT"]) {
    const v = process.env[key];
    if (v && Number.isFinite(+v) && +v > 0 && +v < 65536) return { port: +v, source: key };
  }
  return null;
}

function defaultConfig() {
  return {
    port: 4000,
    host: "0.0.0.0",
    // Left null until the browser setup wizard runs. That is the point:
    // install, open the address, pick a password. Nothing to edit on disk.
    passwordHash: null,
    passwordSalt: null,
    sessionSecret: crypto.randomBytes(32).toString("hex"),
    dataDir: "./data",
    keepReleases: 8,
    tls: null, // { key: "/path/key.pem", cert: "/path/cert.pem" }
    github: { token: "", username: "" }, // optional hub-wide credential
    // Cloudflare Tunnel. One connector token for the whole machine; which
    // hostname points at which local port is decided in the Cloudflare
    // dashboard, which is what a connector token is for.
    tunnel: { token: "", autoStart: true },
    // Where this panel gets its own updates from. The repo is settable so a
    // fork stays updatable from its own origin; ref empty means "newest
    // release, or the default branch if the repo publishes none".
    update: { repo: UPDATE_REPO, ref: "", autoCheck: true },
    sites: [], // a fresh install has none
  };
}

function loadConfig() {
  let cfg = readJson(CONFIG_PATH, null);
  let dirty = false;
  if (!cfg) {
    cfg = defaultConfig();
    dirty = true;
    console.log(`[fcc] first run — created ${CONFIG_PATH}`);
  }
  // Fill in anything an older or hand-edited config is missing.
  const d = defaultConfig();
  for (const key of Object.keys(d)) {
    if (cfg[key] === undefined) {
      cfg[key] = d[key];
      dirty = true;
    }
  }
  if (!cfg.sessionSecret) {
    cfg.sessionSecret = crypto.randomBytes(32).toString("hex");
    dirty = true;
  }
  // Old Golden Threads configs called them "sites" with a different shape;
  // anything without an id and a runner is not something we can use.
  cfg.sites = (cfg.sites || []).filter((s) => s && s.id && RUNNERS.includes(s.runner));

  if (process.env.FCC_HOST) cfg.host = process.env.FCC_HOST;
  // A plaintext password (from an env var or a hand-edited file) is hashed and
  // scrubbed, so it never sits on disk in the clear.
  const plain = process.env.FCC_PASSWORD || cfg.password;
  if (plain) {
    const { salt, hash } = hashPassword(plain);
    cfg.passwordSalt = salt;
    cfg.passwordHash = hash;
    delete cfg.password;
    dirty = true;
  }
  if (dirty) writeJson(CONFIG_PATH, cfg);

  DATA_DIR_RAW = cfg.dataDir || "./data";
  cfg.dataDir = path.resolve(HERE, DATA_DIR_RAW);
  ensureDir(cfg.dataDir);
  return cfg;
}

const config = loadConfig();
const PORT_ENV = envPort();
const LISTEN_PORT = PORT_ENV?.port ?? config.port ?? 4000;

const store = new Store(config.dataDir);
const throttle = new LoginThrottle();
store.markInterruptedJobs();

function saveConfig() {
  const out = { ...config, dataDir: DATA_DIR_RAW };
  delete out.password;
  writeJson(CONFIG_PATH, out);
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* best effort */
  }
}

/** Enough of a token to recognise which one is stored, never enough to use. */
function tokenHint(token) {
  if (!token) return "";
  const t = String(token);
  return t.length <= 12 ? "..." : `${t.slice(0, 6)}…${t.slice(-4)} (${t.length} chars)`;
}

function setupComplete() {
  return !!(config.passwordHash && config.passwordSalt);
}

function findSite(siteId) {
  return config.sites.find((s) => s.id === siteId) || null;
}

// ------------------------------------------------------------ event bus

const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

let stateDirty = false;
function pushState() {
  stateDirty = true;
}
setInterval(() => {
  if (!stateDirty) return;
  stateDirty = false;
  broadcast("state", buildDashboardState());
}, 700).unref();

// ------------------------------------------------------------ local runner

const local = new LocalRunner({
  store,
  listSites: () => config.sites,
  onStateChange: pushState,
  broadcast,
});
local.sync();
local.startPolling();

// ------------------------------------------------------------ the tunnel

const tunnel = new Tunnel({
  dataDir: config.dataDir,
  onChange: () => pushState(),
  onLog: (line) => broadcast("tunnel-log", { line }),
});

tunnel.readVersion();

if (config.tunnel?.token && config.tunnel?.autoStart !== false) {
  tunnel.start(config.tunnel.token).catch((err) => {
    console.error(`[fcc] tunnel did not start: ${err.message}`);
  });
}

/** Agents parked on a long poll, keyed by site id. */
const pollWaiters = new Map();

function wakeSite(siteId) {
  const site = findSite(siteId);
  if (site?.runner === "local") {
    local.kick(siteId).catch((err) => console.error("[fcc] local runner:", err.message));
    return;
  }
  const waiters = pollWaiters.get(siteId);
  if (!waiters?.length) return;
  pollWaiters.set(siteId, []);
  for (const fn of waiters) fn();
}

// ------------------------------------------------------------ dashboard

function buildDashboardState() {
  const now = Date.now();
  return {
    version: FCC_VERSION,
    serverTime: new Date().toISOString(),
    hasGithubToken: !!config.github?.token,
    githubUser: config.github?.username || "",
    tunnel: { ...tunnel.status(), hasToken: !!config.tunnel?.token, autoStart: config.tunnel?.autoStart !== false },
    sites: config.sites.map((sc) => {
      const s = store.site(sc.id);
      const isLocal = sc.runner === "local";
      const online = isLocal || !!(s.lastHeartbeat && now - new Date(s.lastHeartbeat).getTime() < AGENT_OFFLINE_AFTER_MS);
      const running = store.runningJob(sc.id);
      const queued = store.state.jobs.filter((j) => j.siteId === sc.id && j.status === "queued").length;
      return {
        ...publicSite(sc),
        online,
        everConnected: isLocal || !!s.lastHeartbeat,
        lastHeartbeat: s.lastHeartbeat,
        runnerVersion: isLocal ? "in-process" : s.runnerVersion,
        settingsInSync: isLocal || s.settingsHash === settingsHash(sc),
        appRunning: s.appRunning ?? null,
        deployed: s.deployed || null,
        serving: s.serving || null,
        // Files on disk are newer than what the running process reports:
        // "you changed the version but haven't restarted yet".
        restartPending:
          !!(s.deployed?.version && s.serving?.version) &&
          (s.deployed.version !== s.serving.version || s.deployed.releaseId !== s.serving.releaseId),
        health: s.health || null,
        lastError: s.lastError || null,
        currentReleaseId: s.currentReleaseId,
        previousReleaseId: s.previousReleaseId,
        lastDeployAt: s.lastDeployAt,
        migrations: s.migrations || [],
        runtime: s.runtime || null,
        activeJob: running
          ? { id: running.id, type: running.type, startedAt: running.startedAt, step: running.step || null }
          : null,
        queuedJobs: queued,
        releases: store.releasesForSite(sc.id).map(publicRelease),
        jobs: store.jobsForSite(sc.id).map(publicJob),
      };
    }),
  };
}

function publicRelease(r) {
  return {
    id: r.id,
    siteId: r.siteId,
    filename: r.filename,
    size: r.size,
    sizeHuman: humanBytes(r.size),
    uploadedAt: r.uploadedAt,
    version: r.version,
    packageName: r.packageName,
    prebuilt: r.prebuilt,
    fileCount: r.fileCount,
    hasPrismaSchema: r.hasPrismaSchema,
    hasNodeModules: r.hasNodeModules,
    migrationScripts: r.migrationScripts || [],
    sha256: r.sha256?.slice(0, 12),
    notes: r.notes || "",
    pinned: !!r.pinned,
    deployCount: r.deployCount || 0,
    lastDeployedAt: r.lastDeployedAt || null,
    warnings: r.warnings || [],
    source: r.source || { type: "upload" },
  };
}

function publicJob(j) {
  return {
    id: j.id,
    siteId: j.siteId,
    type: j.type,
    status: j.status,
    step: j.step || null,
    releaseId: j.releaseId || null,
    releaseVersion: j.releaseVersion || null,
    script: j.script || null,
    command: j.command || null,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    error: j.error || null,
    summary: j.summary || null,
  };
}

// --------------------------------------------------------------- helpers

function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  const isObject = !isBuffer && typeof body === "object";
  const data = isBuffer || typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": isObject ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    ...headers,
  });
  res.end(data);
}

function sendJson(res, status, obj) {
  send(res, status, obj, { "Content-Type": "application/json; charset=utf-8" });
}

function redirect(res, to) {
  res.writeHead(302, { Location: to, "Cache-Control": "no-store" });
  res.end();
}

function clientIp(req) {
  return (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "?").trim();
}

async function readBody(req, limitBytes = 5 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString("utf8"));
}

// ------------------------------------------------- Command Center updates

let lastUpdateCheck = null;
let updateJob = { running: false, startedAt: null, lines: [], error: null, result: null };
const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60_000;

/** What the panel knows about its own version, without going to GitHub. */
function updateStatus() {
  return {
    repo: config.update?.repo || UPDATE_REPO,
    ref: config.update?.ref || "",
    autoCheck: config.update?.autoCheck !== false,
    installed: installedVersion(FCC_VERSION),
    last: lastUpdateCheck,
    running: updateJob.running,
    lines: updateJob.lines.slice(-200),
    error: updateJob.error,
    backups: listBackups(config.dataDir).slice(0, 5),
  };
}

/**
 * Ask GitHub what the newest version is, at most every six hours unless asked
 * to look again. Rate limits are per-IP for an anonymous check, and a panel
 * that polls on every page load would spend them on nothing.
 */
async function runUpdateCheck({ force = false } = {}) {
  if (!force) {
    if (config.update?.autoCheck === false) return lastUpdateCheck;
    const age = lastUpdateCheck ? Date.now() - new Date(lastUpdateCheck.checkedAt).getTime() : Infinity;
    if (age < UPDATE_CHECK_EVERY_MS) return lastUpdateCheck;
  }
  try {
    lastUpdateCheck = await checkForUpdate({
      repo: config.update?.repo || UPDATE_REPO,
      ref: config.update?.ref || "",
      token: config.github?.token || "",
      currentVersion: FCC_VERSION,
    });
    lastUpdateCheck.error = null;
  } catch (err) {
    // A failed check must not look like "you are up to date".
    lastUpdateCheck = {
      checkedAt: new Date().toISOString(),
      repo: config.update?.repo || UPDATE_REPO,
      installed: installedVersion(FCC_VERSION),
      latest: null,
      updateAvailable: null,
      certainty: "unknown",
      error: err.message,
    };
    if (force) throw err;
  }
  pushState();
  return lastUpdateCheck;
}

function serveStatic(res, relPath, contentType) {
  const file = path.join(HERE, "public", relPath);
  if (!exists(file)) return send(res, 404, "Not found");
  send(res, 200, fs.readFileSync(file), { "Content-Type": contentType });
}

/** Every address this box can be reached on, for the "open this" hint. */
function localUrls() {
  const scheme = config.tls ? "https" : "http";
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      out.push(`${scheme}://${ni.address}:${LISTEN_PORT}`);
    }
  }
  out.push(`${scheme}://127.0.0.1:${LISTEN_PORT}`);
  return out;
}

/** The origin an agent should call back on, as seen from this browser. */
function hubOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || (config.tls ? "https" : "http");
  const host = req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${LISTEN_PORT}`;
  return `${proto}://${host}`;
}

// ----------------------------------------------------------- job helpers

function enqueueJob(siteId, type, extra = {}) {
  const job = {
    id: `j_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`,
    siteId,
    type,
    status: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    error: null,
    ...extra,
  };
  store.addJob(job);
  store.appendLog(job.id, [`[${new Date().toISOString()}] queued ${type}${extra.releaseId ? ` ${extra.releaseId}` : ""}`]);
  pushState();
  wakeSite(siteId);
  return job;
}

/** Shared by the upload path and the GitHub path. */
function registerRelease(siteId, buf, { filename, source }) {
  const releaseId = store.newReleaseId();
  const dest = store.releasePath(releaseId);
  fs.writeFileSync(dest, buf);

  let info;
  try {
    info = inspectZip(buf);
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw new Error(`Not a usable archive: ${err.message}`);
  }

  const warnings = [];
  if (!info.hasPackageJson) {
    warnings.push("No package.json at the root of the archive — check this is the right repository or folder.");
  }
  if (!info.version) warnings.push('No "version" field in package.json — the card will show "unversioned".');
  if (info.hasNodeModules) warnings.push("The archive contains node_modules; it is discarded and installed fresh.");
  if (info.prebuilt) warnings.push("The archive contains a prebuilt .next — the build step will be skipped.");

  const rel = store.addRelease({
    id: releaseId,
    siteId,
    filename,
    size: buf.length,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    uploadedAt: new Date().toISOString(),
    version: info.version,
    packageName: info.packageName,
    prebuilt: info.prebuilt,
    fileCount: info.fileCount,
    hasPrismaSchema: info.hasPrismaSchema,
    hasNodeModules: info.hasNodeModules,
    migrationScripts: info.migrationScripts,
    warnings,
    notes: "",
    deployCount: 0,
    source: source || { type: "upload" },
  });

  store.pruneReleases(siteId, config.keepReleases ?? 8);
  pushState();
  return rel;
}

function githubTokenFor(site, override) {
  return String(override || "").trim() || site?.github?.token || config.github?.token || "";
}

// ------------------------------------------------------------ HTTP routes

async function handleApi(req, res, url) {
  if (url.pathname === "/api/logout" && req.method === "POST") {
    res.writeHead(200, { "Set-Cookie": clearCookieHeader(), "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (!isAuthed(req, config.sessionSecret)) return sendJson(res, 401, { error: "Not signed in" });

  // ---- dashboard state ------------------------------------------------
  if (url.pathname === "/api/state") return sendJson(res, 200, buildDashboardState());

  if (url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: state\ndata: ${JSON.stringify(buildDashboardState())}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* closed */
      }
    }, 20_000);
    req.on("close", () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
    return;
  }

  // ---- upload a release archive ---------------------------------------
  if (url.pathname === "/api/upload" && req.method === "POST") {
    const siteId = url.searchParams.get("site");
    if (!findSite(siteId)) return sendJson(res, 400, { error: "Unknown site" });
    const filename = path.basename(url.searchParams.get("filename") || "upload.zip");

    const chunks = [];
    let size = 0;
    try {
      await new Promise((resolve, reject) => {
        req.on("data", (c) => {
          size += c.length;
          if (size > 2 * 1024 * 1024 * 1024) {
            reject(new Error("Upload exceeds 2GB"));
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        req.on("end", resolve);
        req.on("error", reject);
      });
    } catch (err) {
      return sendJson(res, 500, { error: `Upload failed: ${err.message}` });
    }
    if (!size) return sendJson(res, 400, { error: "Empty upload" });

    try {
      const rel = registerRelease(siteId, Buffer.concat(chunks), { filename, source: { type: "upload" } });
      return sendJson(res, 200, { ok: true, release: publicRelease(rel) });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // ---- GitHub ----------------------------------------------------------
  if (url.pathname === "/api/github/refs" && req.method === "POST") {
    const body = await readJsonBody(req).catch(() => ({}));
    const repo = normalizeRepo(body.repo);
    if (!repo) return sendJson(res, 400, { error: "That does not look like a GitHub repository." });
    const token = githubTokenFor(body.siteId ? findSite(body.siteId) : null, body.token);
    try {
      const [info, refs] = await Promise.all([repoInfo(repo, token), listRefs(repo, token)]);
      return sendJson(res, 200, { ok: true, repo, info, ...refs });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (url.pathname === "/api/github/check" && req.method === "POST") {
    const body = await readJsonBody(req).catch(() => ({}));
    const result = await checkToken(String(body.token || "").trim() || config.github?.token || "");
    return sendJson(res, 200, result);
  }

  if (url.pathname === "/api/github/fetch" && req.method === "POST") {
    const body = await readJsonBody(req).catch(() => ({}));
    const site = findSite(body.siteId);
    if (!site) return sendJson(res, 400, { error: "Unknown site" });
    const repo = normalizeRepo(body.repo);
    if (!repo) return sendJson(res, 400, { error: "That does not look like a GitHub repository." });
    const token = githubTokenFor(site, body.token);

    try {
      const ref =
        String(body.ref || "").trim() ||
        (await repoInfo(repo, token)
          .then((i) => i.defaultBranch)
          .catch(() => "main"));
      const commit = await resolveCommit(repo, ref, token);
      const buf = await downloadZipball(repo, ref, token);
      const safeRef = ref.replace(/[^\w.-]+/g, "-");
      const rel = registerRelease(site.id, buf, {
        filename: `${repo.split("/")[1]}-${safeRef}${commit?.shortSha ? `-${commit.shortSha}` : ""}.zip`,
        source: {
          type: "github",
          repo,
          ref,
          sha: commit?.sha || null,
          shortSha: commit?.shortSha || null,
          message: commit?.message || "",
          author: commit?.author || null,
          committedAt: commit?.date || null,
          htmlUrl: commit?.htmlUrl || `https://github.com/${repo}`,
          fetchedAt: new Date().toISOString(),
        },
      });

      // Remember the repo and ref so the next pull is one click.
      site.github = sanitizeGithub({ ...site.github, repo, ref });
      if (body.saveToken && String(body.token || "").trim()) site.github.token = String(body.token).trim();
      saveConfig();
      pushState();

      let job = null;
      if (body.deploy) {
        if (!site.settings.appDir) {
          return sendJson(res, 200, {
            ok: true,
            release: publicRelease(rel),
            job: null,
            warning: "Downloaded, but not deployed: this site has no app directory set yet.",
          });
        }
        if (store.runningJob(site.id)) {
          return sendJson(res, 200, {
            ok: true,
            release: publicRelease(rel),
            job: null,
            warning: "Downloaded, but not deployed: a job is already running for this site.",
          });
        }
        job = enqueueJob(site.id, "deploy", {
          releaseId: rel.id,
          releaseVersion: rel.version,
          runMigrations: !!body.runMigrations,
          migrationScripts: body.migrationScripts || [],
        });
      }
      return sendJson(res, 200, { ok: true, release: publicRelease(rel), job: job ? publicJob(job) : null });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // ---- site registry ---------------------------------------------------
  if (url.pathname === "/api/sites/create" && req.method === "POST") {
    const body = await readJsonBody(req).catch(() => ({}));
    try {
      const site = createSite(body, config.sites.map((s) => s.id));
      config.sites.push(site);
      saveConfig();
      local.sync();
      pushState();
      return sendJson(res, 200, { ok: true, site: publicSite(site) });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (url.pathname === "/api/sites/update" && req.method === "POST") {
    const body = await readJsonBody(req).catch(() => ({}));
    const site = findSite(body.id);
    if (!site) return sendJson(res, 404, { error: "Unknown site" });
    if (store.runningJob(site.id)) return sendJson(res, 409, { error: "A job is running — try again when it finishes." });

    if (typeof body.name === "string" && body.name.trim()) site.name = body.name.trim().slice(0, 60);
    if (typeof body.publicUrl === "string") site.publicUrl = safeUrl(body.publicUrl);
    if (RUNNERS.includes(body.runner)) site.runner = body.runner;
    if (body.settings) site.settings = sanitizeSettings(body.settings, site.settings);
    if (body.github) {
      const g = sanitizeGithub(body.github);
      // A blank token in the form means "leave it alone", not "clear it".
      site.github = { ...g, token: body.github.clearToken ? "" : g.token || site.github?.token || "" };
    }
    saveConfig();
    local.sync();
    pushState();
    wakeSite(site.id); // a remote agent picks the change up within a second
    return sendJson(res, 200, { ok: true, site: publicSite(site) });
  }

  if (url.pathname === "/api/sites/delete" && req.method === "POST") {
    const body = await readJsonBody(req).catch(() => ({}));
    const idx = config.sites.findIndex((s) => s.id === body.id);
    if (idx === -1) return sendJson(res, 404, { error: "Unknown site" });
    const [gone] = config.sites.splice(idx, 1);
    saveConfig();
    local.sync();
    if (body.keepHistory !== true) store.forgetSite(gone.id);
    pushState();
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/api/sites/rotate-token" && req.method === "POST") {
    const body = await readJsonBody(req).catch(() => ({}));
    const site = findSite(body.id);
    if (!site) return sendJson(res, 404, { error: "Unknown site" });
    site.token = newToken();
    saveConfig();
    pushState();
    return sendJson(res, 200, { ok: true, site: publicSite(site) });
  }

  // ---- Command Center settings ----------------------------------------
  if (url.pathname === "/api/settings" && req.method === "GET") {
    return sendJson(res, 200, {
      version: FCC_VERSION,
      port: LISTEN_PORT,
      configuredPort: config.port,
      portSource: PORT_ENV ? PORT_ENV.source : "config",
      portLocked: !!PORT_ENV,
      host: config.host,
      keepReleases: config.keepReleases,
      hasGithubToken: !!config.github?.token,
      githubUser: config.github?.username || "",
      tunnel: {
        ...tunnel.status(),
        hasToken: !!config.tunnel?.token,
        tokenHint: tokenHint(config.tunnel?.token),
        autoStart: config.tunnel?.autoStart !== false,
      },
      update: updateStatus(),
      tls: !!config.tls,
      dataDir: config.dataDir,
      urls: localUrls(),
      node: process.version,
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.arch()}`,
      uptimeSeconds: Math.round(process.uptime()),
      managedByPm2: !!process.env.pm_id || !!process.env.PM2_HOME,
    });
  }

  if (url.pathname === "/api/settings" && req.method === "POST") {
    const body = await readJsonBody(req).catch(() => ({}));
    let restartNeeded = false;

    if (typeof body.githubToken === "string") {
      const token = body.githubToken.trim();
      config.github = { token, username: config.github?.username || "" };
      if (token) {
        const who = await checkToken(token);
        if (!who.ok) return sendJson(res, 400, { error: `That token did not work: ${who.error}` });
        config.github.username = who.login || "";
      } else {
        config.github.username = "";
      }
    }
    if (Number.isFinite(+body.keepReleases)) config.keepReleases = Math.max(1, Math.min(50, +body.keepReleases));

    // ---- where this panel updates from ------------------------------------
    if (body.update && typeof body.update === "object") {
      const u = { ...(config.update || {}) };
      if (typeof body.update.repo === "string") {
        const repo = body.update.repo.trim();
        if (!repo) u.repo = UPDATE_REPO;
        else {
          const norm = normalizeRepo(repo);
          if (!norm) return sendJson(res, 400, { error: `"${repo}" is not a GitHub repository this can read.` });
          u.repo = norm;
        }
      }
      if (typeof body.update.ref === "string") u.ref = body.update.ref.trim();
      if (typeof body.update.autoCheck === "boolean") u.autoCheck = body.update.autoCheck;
      config.update = u;
      lastUpdateCheck = null; // the answer we cached was about a different source
    }

    // ---- Cloudflare Tunnel ------------------------------------------------
    let tunnelAction = null;
    if (typeof body.tunnelToken === "string") {
      const token = body.tunnelToken.trim();
      config.tunnel = { ...(config.tunnel || {}), token };
      // A changed token means the running connector is using the old one.
      tunnelAction = token ? "restart" : "stop";
    }
    if (typeof body.tunnelAutoStart === "boolean") {
      config.tunnel = { ...(config.tunnel || {}), autoStart: body.tunnelAutoStart };
    }

    if (Number.isFinite(+body.port) && +body.port !== config.port) {
      if (PORT_ENV) {
        return sendJson(res, 400, {
          error: `The port is set by ${PORT_ENV.source} in this environment — change it there (in the Pterodactyl panel) rather than here.`,
        });
      }
      const p = Math.round(+body.port);
      if (p < 1 || p > 65535) return sendJson(res, 400, { error: "That is not a usable port." });
      config.port = p;
      restartNeeded = true;
    }

    if (body.newPassword) {
      if (!verifyPassword(body.currentPassword, config.passwordSalt, config.passwordHash)) {
        return sendJson(res, 401, { error: "Current password is incorrect." });
      }
      if (String(body.newPassword).length < 8) return sendJson(res, 400, { error: "Use at least 8 characters." });
      const { salt, hash } = hashPassword(String(body.newPassword));
      config.passwordSalt = salt;
      config.passwordHash = hash;
    }

    saveConfig();

    if (tunnelAction) {
      await tunnel.stop().catch(() => {});
      if (tunnelAction === "restart" && config.tunnel.autoStart !== false) {
        tunnel.start(config.tunnel.token).catch((err) => {
          tunnel.line(`Could not start: ${err.message}`);
          pushState();
        });
      }
    }

    pushState();
    sendJson(res, 200, {
      ok: true,
      restartNeeded,
      port: config.port,
      hasGithubToken: !!config.github?.token,
      githubUser: config.github?.username || "",
      tunnel: tunnel.status(),
    });

    if (restartNeeded) {
      // Under pm2 (or systemd) exiting cleanly is the restart. Give the
      // response a moment to reach the browser first.
      console.log(`[fcc] port changed to ${config.port} — exiting so the supervisor restarts us`);
      setTimeout(() => {
        store.save({ immediate: true });
        process.exit(0);
      }, 400);
    }
    return;
  }

  // ---- Cloudflare Tunnel controls --------------------------------------
  if (url.pathname === "/api/tunnel" && req.method === "GET") {
    return sendJson(res, 200, {
      ...tunnel.status(),
      hasToken: !!config.tunnel?.token,
      tokenHint: tokenHint(config.tunnel?.token),
      autoStart: config.tunnel?.autoStart !== false,
      log: tunnel.recentLog(120),
    });
  }

  if (url.pathname === "/api/tunnel/start" && req.method === "POST") {
    if (!config.tunnel?.token) return sendJson(res, 400, { error: "Add a tunnel token first." });
    try {
      await tunnel.start(config.tunnel.token);
      pushState();
      return sendJson(res, 200, { ok: true, ...tunnel.status() });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (url.pathname === "/api/tunnel/stop" && req.method === "POST") {
    await tunnel.stop();
    pushState();
    return sendJson(res, 200, { ok: true, ...tunnel.status() });
  }

  if (url.pathname === "/api/tunnel/install" && req.method === "POST") {
    try {
      await tunnel.download();
      return sendJson(res, 200, { ok: true, ...tunnel.status() });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // ---- updating the Command Center itself ------------------------------
  if (url.pathname === "/api/update" && req.method === "GET") {
    return sendJson(res, 200, updateStatus());
  }

  if (url.pathname === "/api/update/check" && req.method === "POST") {
    try {
      await runUpdateCheck({ force: true });
    } catch (err) {
      return sendJson(res, 400, { error: err.message, ...updateStatus() });
    }
    return sendJson(res, 200, updateStatus());
  }

  if (url.pathname === "/api/update/apply" && req.method === "POST") {
    const body = await readJsonBody(req).catch(() => ({}));
    if (updateJob.running) return sendJson(res, 409, { error: "An update is already running." });
    updateJob = { running: true, startedAt: new Date().toISOString(), lines: [], error: null, result: null };
    const log = (line) => {
      updateJob.lines.push(line);
      console.log(`[fcc:update] ${line}`);
      pushState();
    };
    try {
      const result = await applyUpdate({
        repo: config.update?.repo || UPDATE_REPO,
        ref: typeof body.ref === "string" && body.ref.trim() ? body.ref.trim() : config.update?.ref || "",
        token: config.github?.token || "",
        dataDir: config.dataDir,
        currentVersion: FCC_VERSION,
        dryRun: !!body.dryRun,
        log,
      });
      updateJob.running = false;
      updateJob.result = result;
      if (!result.dryRun) {
        lastUpdateCheck = null; // whatever we knew is now about the old version
        // A restart has to wait for this response to reach the browser, or the
        // page reloads into a closed socket and reads as a failed update.
        if (body.restart !== false) {
          sendJson(res, 200, { ok: true, ...result, restarting: true });
          console.log("[fcc] update applied — restarting");
          setTimeout(() => {
            store.save({ immediate: true });
            process.exit(0);
          }, 900);
          return;
        }
      }
      return sendJson(res, 200, { ok: true, ...result, restarting: false });
    } catch (err) {
      updateJob.running = false;
      updateJob.error = err.message;
      log(`Update failed: ${err.message}`);
      return sendJson(res, 400, { error: err.message, lines: updateJob.lines });
    }
  }

  if (url.pathname === "/api/update/backups" && req.method === "GET") {
    return sendJson(res, 200, { backups: listBackups(config.dataDir) });
  }

  if (url.pathname === "/api/update/rollback" && req.method === "POST") {
    const body = await readJsonBody(req).catch(() => ({}));
    try {
      const r = restoreBackup(body.id, { dataDir: config.dataDir, log: (l) => console.log(`[fcc:update] ${l}`) });
      sendJson(res, 200, { ok: true, ...r, restarting: true });
      setTimeout(() => {
        store.save({ immediate: true });
        process.exit(0);
      }, 900);
      return;
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (url.pathname === "/api/restart-hub" && req.method === "POST") {
    sendJson(res, 200, { ok: true });
    console.log("[fcc] restart requested from the dashboard");
    setTimeout(() => {
      store.save({ immediate: true });
      process.exit(0);
    }, 400);
    return;
  }

  // ---- actions ---------------------------------------------------------
  if (req.method === "POST") {
    const body = await readJsonBody(req).catch(() => ({}));

    const needSite = (id) => {
      const site = findSite(id);
      if (!site) {
        sendJson(res, 400, { error: "Unknown site" });
        return null;
      }
      if (!site.settings.appDir) {
        sendJson(res, 400, { error: "Set this site's app directory first." });
        return null;
      }
      if (store.runningJob(id)) {
        sendJson(res, 409, { error: "A job is already running for this site." });
        return null;
      }
      return site;
    };

    if (url.pathname === "/api/deploy") {
      const rel = store.release(body.releaseId);
      if (!rel) return sendJson(res, 404, { error: "Release not found" });
      const site = needSite(rel.siteId);
      if (!site) return;
      const job = enqueueJob(rel.siteId, "deploy", {
        releaseId: rel.id,
        releaseVersion: rel.version,
        runMigrations: !!body.runMigrations,
        migrationScripts: body.migrationScripts || [],
        skipBuild: !!body.skipBuild,
      });
      return sendJson(res, 200, { ok: true, job: publicJob(job) });
    }

    for (const [route, type] of [
      ["/api/restart", "restart"],
      ["/api/stop", "stop"],
      ["/api/start", "start"],
    ]) {
      if (url.pathname === route) {
        const site = needSite(body.siteId);
        if (!site) return;
        return sendJson(res, 200, { ok: true, job: publicJob(enqueueJob(site.id, type)) });
      }
    }

    if (url.pathname === "/api/rollback") {
      const site = needSite(body.siteId);
      if (!site) return;
      const state = store.site(site.id);
      const target = body.releaseId || state.previousReleaseId;
      if (!target) return sendJson(res, 400, { error: "There is no previous release to roll back to." });
      const rel = store.release(target);
      const job = enqueueJob(site.id, "rollback", { releaseId: target, releaseVersion: rel?.version || null });
      return sendJson(res, 200, { ok: true, job: publicJob(job) });
    }

    if (url.pathname === "/api/migrate") {
      const site = needSite(body.siteId);
      if (!site) return;
      if (!body.script || !/^[\w.-]+\.(cjs|mjs|js)$/.test(body.script)) {
        return sendJson(res, 400, { error: "That is not a valid migration script name." });
      }
      return sendJson(res, 200, { ok: true, job: publicJob(enqueueJob(site.id, "migrate", { script: body.script })) });
    }

    if (url.pathname === "/api/command") {
      const site = needSite(body.siteId);
      if (!site) return;
      const command = String(body.command || "").trim();
      if (!command) return sendJson(res, 400, { error: "Type a command to run." });
      if (command.length > 2000) return sendJson(res, 400, { error: "That command is too long." });
      return sendJson(res, 200, { ok: true, job: publicJob(enqueueJob(site.id, "command", { command })) });
    }

    if (url.pathname === "/api/refresh") {
      const site = findSite(body.siteId);
      if (!site) return sendJson(res, 400, { error: "Unknown site" });
      if (site.runner === "local") {
        await local.refreshStatus();
        return sendJson(res, 200, { ok: true, job: null });
      }
      return sendJson(res, 200, { ok: true, job: publicJob(enqueueJob(site.id, "inspect")) });
    }

    if (url.pathname === "/api/cancel") {
      const job = store.job(body.jobId);
      if (!job) return sendJson(res, 404, { error: "Job not found" });
      if (job.status !== "queued") return sendJson(res, 409, { error: "Only a queued job can be cancelled." });
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      store.save();
      pushState();
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/release/update") {
      const rel = store.release(body.releaseId);
      if (!rel) return sendJson(res, 404, { error: "Release not found" });
      if (typeof body.notes === "string") rel.notes = body.notes.slice(0, 500);
      if (typeof body.pinned === "boolean") rel.pinned = body.pinned;
      store.save();
      pushState();
      return sendJson(res, 200, { ok: true, release: publicRelease(rel) });
    }

    if (url.pathname === "/api/release/delete") {
      const rel = store.release(body.releaseId);
      if (!rel) return sendJson(res, 404, { error: "Release not found" });
      if (rel.id === store.site(rel.siteId).currentReleaseId) {
        return sendJson(res, 409, { error: "That release is currently live." });
      }
      store.deleteRelease(rel.id);
      pushState();
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- logs -------------------------------------------------------------
  if (url.pathname.startsWith("/api/log/")) {
    const jobId = url.pathname.split("/").pop();
    if (!store.job(jobId)) return sendJson(res, 404, { error: "Job not found" });
    return send(res, 200, store.readLog(jobId), { "Content-Type": "text/plain; charset=utf-8" });
  }

  return sendJson(res, 404, { error: "Unknown endpoint" });
}

// ------------------------------------------------------------ agent API

async function handleAgent(req, res, url) {
  const body = req.method === "POST" ? await readJsonBody(req).catch(() => ({})) : {};
  const siteId = body.siteId || body.agentId || url.searchParams.get("site") || url.searchParams.get("agent");
  const sc = findSite(siteId);
  const token = req.headers["x-fcc-token"];
  if (!sc || sc.runner !== "agent" || !tokenMatches(token, sc.token)) {
    return sendJson(res, 401, { error: "Bad site id or token" });
  }
  const state = store.site(siteId);

  // ---- long poll for work ---------------------------------------------
  if (url.pathname === "/agent/poll") {
    state.lastHeartbeat = new Date().toISOString();
    state.runnerVersion = body.agentVersion || state.runnerVersion;
    if (body.settingsHash !== undefined) state.settingsHash = body.settingsHash;
    for (const key of ["deployed", "serving", "health", "appRunning", "migrations", "runtime"]) {
      if (body[key] !== undefined) state[key] = body[key];
    }
    store.save();
    pushState();

    // Recomputed at send time, never captured: a parked long poll can be
    // answered seconds later, and handing back settings from when the poll
    // STARTED alongside the current hash would leave the agent believing it
    // was up to date while running the old configuration.
    const current = () => ({ settings: agentFacingSettings(sc), settingsHash: settingsHash(sc) });

    const dispatch = () => {
      if (store.runningJob(siteId)) return false; // never hand out two at once
      const job = store.nextQueuedJob(siteId);
      if (!job) return false;
      job.status = "running";
      job.startedAt = new Date().toISOString();
      store.save({ immediate: true });
      pushState();
      const rel = job.releaseId ? store.release(job.releaseId) : null;
      sendJson(res, 200, {
        ...current(),
        job: {
          id: job.id,
          type: job.type,
          releaseId: job.releaseId || null,
          releaseVersion: rel?.version || null,
          releaseFilename: rel?.filename || null,
          releaseSha256: rel?.sha256 || null,
          releasePrebuilt: rel?.prebuilt || false,
          script: job.script || null,
          command: job.command || null,
          runMigrations: !!job.runMigrations,
          migrationScripts: job.migrationScripts || [],
          skipBuild: !!job.skipBuild,
        },
      });
      return true;
    };

    if (dispatch()) return;

    // Settings moved since the agent last saw them — answer at once so an
    // edit in the browser takes effect within a second or two.
    if (body.settingsHash !== settingsHash(sc)) return sendJson(res, 200, { job: null, ...current() });

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!dispatch()) sendJson(res, 200, { job: null, ...current() });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sendJson(res, 200, { job: null, ...current() });
    }, POLL_TIMEOUT_MS);
    const list = pollWaiters.get(siteId) || [];
    list.push(finish);
    pollWaiters.set(siteId, list);
    req.on("close", () => {
      settled = true;
      clearTimeout(timer);
    });
    return;
  }

  // ---- download the release artifact -----------------------------------
  if (url.pathname.startsWith("/agent/artifact/")) {
    const releaseId = url.pathname.split("/").pop();
    const rel = store.release(releaseId);
    if (!rel || rel.siteId !== siteId) return sendJson(res, 404, { error: "Release not found" });
    const file = store.releasePath(releaseId);
    if (!exists(file)) return sendJson(res, 410, { error: "That release archive is no longer on the hub" });
    const stat = fs.statSync(file);
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Length": stat.size,
      "X-FCC-Sha256": rel.sha256,
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  // ---- streaming log lines ---------------------------------------------
  if (url.pathname === "/agent/log") {
    const job = store.job(body.jobId);
    if (!job || job.siteId !== siteId) return sendJson(res, 404, { error: "Job not found" });
    const lines = Array.isArray(body.lines) ? body.lines : [];
    if (body.step && body.step !== job.step) {
      job.step = body.step;
      store.save();
      pushState();
    }
    store.appendLog(job.id, lines);
    if (lines.length) broadcast("log", { jobId: job.id, siteId: job.siteId, lines });
    return sendJson(res, 200, { ok: true });
  }

  // ---- job finished ------------------------------------------------------
  if (url.pathname === "/agent/result") {
    const job = store.job(body.jobId);
    if (!job || job.siteId !== siteId) return sendJson(res, 404, { error: "Job not found" });
    job.status = body.ok ? "success" : "failed";
    job.finishedAt = new Date().toISOString();
    job.error = body.error || null;
    job.summary = body.summary || null;
    job.step = null;

    for (const key of ["deployed", "serving", "health", "migrations", "appRunning"]) {
      if (body[key] !== undefined) state[key] = body[key];
    }
    state.lastError = body.ok ? null : body.error || null;

    if (body.ok && (job.type === "deploy" || job.type === "rollback")) {
      if (state.currentReleaseId && state.currentReleaseId !== job.releaseId) {
        state.previousReleaseId = state.currentReleaseId;
      }
      state.currentReleaseId = job.releaseId;
      state.lastDeployAt = job.finishedAt;
      const rel = store.release(job.releaseId);
      if (rel) {
        rel.deployCount = (rel.deployCount || 0) + 1;
        rel.lastDeployedAt = job.finishedAt;
      }
      store.pruneReleases(siteId, config.keepReleases ?? 8);
    }
    if (body.rolledBackTo) state.currentReleaseId = body.rolledBackTo;

    store.save({ immediate: true });
    pushState();
    broadcast("job-finished", { jobId: job.id, siteId: job.siteId, ok: !!body.ok, error: job.error });
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: "Unknown agent endpoint" });
}

// ------------------------------------------- the agent installer one-liner

/**
 * Served unauthenticated but useless without the site's token — which is
 * exactly the credential the script is delivering. It bakes in the hub URL,
 * site id and token, so the operator's whole job on a new box is to paste one
 * line.
 */
function serveAgentInstaller(req, res, url) {
  const siteId = url.searchParams.get("site") || url.searchParams.get("agent");
  const token = url.searchParams.get("token");
  const sc = findSite(siteId);
  if (!sc || !tokenMatches(token, sc.token)) {
    return send(res, 401, "#!/bin/sh\necho 'Bad site id or token.' >&2\nexit 1\n", {
      "Content-Type": "text/plain; charset=utf-8",
    });
  }
  const template = fs.readFileSync(path.join(HERE, "templates", "agent-install.sh"), "utf8");
  const script = template
    .replaceAll("@@HUB_URL@@", url.searchParams.get("hub") || hubOrigin(req))
    .replaceAll("@@SITE_ID@@", sc.id)
    .replaceAll("@@SITE_TOKEN@@", sc.token)
    .replaceAll("@@SITE_NAME@@", sc.name.replace(/['"`$\\]/g, ""));
  return send(res, 200, script, { "Content-Type": "text/x-shellscript; charset=utf-8" });
}

/** The agent's own source, fetched by that installer. */
function serveAgentFile(req, res, url) {
  const siteId = url.searchParams.get("site") || url.searchParams.get("agent");
  const token = url.searchParams.get("token");
  const sc = findSite(siteId);
  if (!sc || !tokenMatches(token, sc.token)) return send(res, 401, "unauthorized");

  const rel = url.pathname.replace(/^\/install\/files\//, "");
  const allowed = ["agent/agent.mjs", "shared/deployer.mjs", "shared/zip.mjs", "shared/zipwrite.mjs", "shared/fsx.mjs"];
  if (!allowed.includes(rel)) return send(res, 404, "not found");
  const file = path.join(ROOT, rel);
  if (!exists(file)) return send(res, 404, "not found");
  return send(res, 200, fs.readFileSync(file), { "Content-Type": "text/plain; charset=utf-8" });
}

// ------------------------------------------------------------ the server

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    // Agents and installers work before and after setup.
    if (url.pathname.startsWith("/agent/")) return await handleAgent(req, res, url);
    if (url.pathname === "/install/agent.sh") return serveAgentInstaller(req, res, url);
    if (url.pathname.startsWith("/install/files/")) return serveAgentFile(req, res, url);
    if (url.pathname === "/healthz") {
      return sendJson(res, 200, { ok: true, version: FCC_VERSION, setup: setupComplete(), port: LISTEN_PORT });
    }

    // ---- first-run setup ------------------------------------------------
    if (!setupComplete()) {
      if (url.pathname === "/api/setup" && req.method === "POST") {
        const body = await readJsonBody(req).catch(() => ({}));
        const pw = String(body.password || "");
        if (pw.length < 8) return sendJson(res, 400, { error: "Use at least 8 characters." });
        if (pw !== body.confirm) return sendJson(res, 400, { error: "The two passwords do not match." });
        const { salt, hash } = hashPassword(pw);
        config.passwordSalt = salt;
        config.passwordHash = hash;
        if (typeof body.githubToken === "string" && body.githubToken.trim()) {
          const who = await checkToken(body.githubToken.trim());
          config.github = { token: body.githubToken.trim(), username: who.ok ? who.login || "" : "" };
        }
        saveConfig();
        const sessionToken = issueSession(config.sessionSecret);
        const secure = !!config.tls || req.headers["x-forwarded-proto"] === "https";
        res.writeHead(200, {
          "Set-Cookie": sessionCookieHeader(sessionToken, { secure }),
          "Content-Type": "application/json",
        });
        console.log("[fcc] setup complete — password set from the browser");
        return res.end(JSON.stringify({ ok: true }));
      }
      if (url.pathname === "/api/setup" && req.method === "GET") {
        return sendJson(res, 200, { setup: false, version: FCC_VERSION, hostname: os.hostname() });
      }
      if (url.pathname.startsWith("/api/")) return sendJson(res, 503, { error: "Setup has not been completed yet." });
      if (url.pathname === "/setup" || url.pathname === "/" || url.pathname === "/index.html") {
        return serveStatic(res, "setup.html", "text/html; charset=utf-8");
      }
      return redirect(res, "/setup");
    }

    if (url.pathname === "/setup") return redirect(res, "/");

    // ---- login ----------------------------------------------------------
    if (url.pathname === "/api/login" && req.method === "POST") {
      const ip = clientIp(req);
      const gate = throttle.check(ip);
      if (!gate.allowed) {
        return sendJson(res, 429, {
          error: `Too many attempts. Try again in ${Math.ceil(gate.retryAfterMs / 60000)} minutes.`,
        });
      }
      const body = await readJsonBody(req).catch(() => ({}));
      if (verifyPassword(body.password, config.passwordSalt, config.passwordHash)) {
        throttle.succeed(ip);
        const sessionToken = issueSession(config.sessionSecret);
        const secure = !!config.tls || req.headers["x-forwarded-proto"] === "https";
        res.writeHead(200, {
          "Set-Cookie": sessionCookieHeader(sessionToken, { secure }),
          "Content-Type": "application/json",
        });
        return res.end(JSON.stringify({ ok: true }));
      }
      throttle.fail(ip);
      return sendJson(res, 401, { error: "Incorrect password." });
    }

    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (!isAuthed(req, config.sessionSecret)) return serveStatic(res, "login.html", "text/html; charset=utf-8");
      return serveStatic(res, "index.html", "text/html; charset=utf-8");
    }
    if (url.pathname === "/login") return serveStatic(res, "login.html", "text/html; charset=utf-8");
    // The settings pane parses environment variables with exactly the same
    // code the server does, rather than a second implementation that drifts.
    if (url.pathname === "/lib/env.mjs") {
      return send(res, 200, fs.readFileSync(path.join(ROOT, "shared/env.mjs")), {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
      });
    }

    return send(res, 404, "Not found");
  } catch (err) {
    console.error("[fcc] unhandled", err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
  }
}

const server = config.tls
  ? https.createServer({ key: fs.readFileSync(config.tls.key), cert: fs.readFileSync(config.tls.cert) }, handler)
  : http.createServer(handler);

// Uploads can be big and builds are slow; do not let Node time them out.
server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 70_000;

server.listen(LISTEN_PORT, config.host, () => {
  console.log(`\n  Forthway Command Center v${FCC_VERSION}`);
  console.log(`  ${"-".repeat(46)}`);
  for (const u of localUrls()) console.log(`  open  ${u}`);
  if (PORT_ENV) console.log(`  port  ${LISTEN_PORT} (from ${PORT_ENV.source})`);
  console.log(`  data  ${config.dataDir}`);
  if (!setupComplete()) console.log(`\n  Not set up yet — open the address above and choose a password.`);
  else {
    const localCount = config.sites.filter((s) => s.runner === "local").length;
    console.log(
      `  sites ${config.sites.length} (${localCount} on this machine, ${config.sites.length - localCount} via agents)`,
    );
  }
  console.log("");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[fcc] port ${LISTEN_PORT} is already in use. Set SERVER_PORT/PORT, or edit hub/config.json.`);
    process.exit(1);
  }
  throw err;
});

// Check for a newer Command Center shortly after boot, then every few hours.
// Deliberately after listen: a slow or unreachable GitHub must never delay the
// panel coming up.
if (config.update?.autoCheck !== false) {
  setTimeout(() => runUpdateCheck().catch(() => {}), 8_000).unref();
  setInterval(() => runUpdateCheck().catch(() => {}), UPDATE_CHECK_EVERY_MS).unref();
}

// Keep the dashboard honest about which agents are actually there.
setInterval(() => {
  let changed = false;
  for (const sc of config.sites) {
    if (sc.runner === "local") continue;
    const s = store.site(sc.id);
    const online = !!(s.lastHeartbeat && Date.now() - new Date(s.lastHeartbeat).getTime() < AGENT_OFFLINE_AFTER_MS);
    if (s.online !== online) {
      s.online = online;
      changed = true;
    }
  }
  if (store.reapStaleJobs()) changed = true;
  if (changed) {
    store.save();
    pushState();
  }
}, 10_000).unref();

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    store.save({ immediate: true });
    // Leave no orphaned connector behind when the panel restarts.
    await tunnel.stop().catch(() => {});
    process.exit(0);
  });
}
