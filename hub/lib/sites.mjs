/**
 * The site registry.
 *
 * A "site" is one app the Command Center looks after. Each one names a
 * runner:
 *
 *   local  — the app is on this machine, so the Command Center does the work
 *            itself. No agent, no token, nothing to install.
 *   agent  — the app is on another machine, so an agent there dials in and
 *            does the work. Same engine, just at the other end of a wire.
 *
 * Sites are created and deleted from the browser, so everything here is about
 * turning whatever was posted into a record that is safe to persist and safe
 * to act on.
 *
 * A site's settings live here rather than on the target machine. The agent
 * holds only what it needs to phone home and receives the rest on every poll,
 * which is what makes a remote site as adjustable as a local one.
 */

import crypto from "node:crypto";
import { defaultSettings, RESTART_MODES } from "../../shared/deployer.mjs";

export const RUNNERS = ["local", "agent"];
export { RESTART_MODES, defaultSettings };

export function newSiteId(name, taken = []) {
  const base =
    String(name || "site")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 28) || "site";
  let id = base;
  let n = 2;
  while (taken.includes(id)) id = `${base}-${n++}`;
  return id;
}

export function newToken() {
  return crypto.randomBytes(24).toString("hex");
}

/** Deep-merge posted settings over a base, dropping anything unknown. */
export function sanitizeSettings(input = {}, base = defaultSettings()) {
  const out = structuredClone(base);
  const s = input || {};

  if (typeof s.appDir === "string") out.appDir = s.appDir.trim();
  if (typeof s.healthUrl === "string") out.healthUrl = s.healthUrl.trim();
  if (typeof s.versionUrl === "string") out.versionUrl = s.versionUrl.trim();

  if (s.port === null || s.port === "") out.port = null;
  else if (Number.isFinite(+s.port)) out.port = clamp(Math.round(+s.port), 1, 65535);

  if (Number.isFinite(+s.healthTimeoutMs)) out.healthTimeoutMs = clamp(+s.healthTimeoutMs, 10_000, 3_600_000);
  if (Number.isFinite(+s.stopGraceMs)) out.stopGraceMs = clamp(+s.stopGraceMs, 1_000, 300_000);

  if (s.restart) {
    const r = s.restart;
    if (RESTART_MODES.includes(r.mode)) out.restart.mode = r.mode;
    for (const key of ["service", "stop", "start", "pm2Start"]) {
      if (typeof r[key] === "string") out.restart[key] = r[key].trim();
    }
    if (typeof r.useSudo === "boolean") out.restart.useSudo = r.useSudo;
    if (r.env && typeof r.env === "object" && !Array.isArray(r.env)) {
      out.restart.env = {};
      for (const [k, v] of Object.entries(r.env)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) out.restart.env[k] = String(v).slice(0, 2000);
      }
    }
  }

  if (s.build) {
    for (const key of ["install", "prepare", "build", "artifact"]) {
      if (typeof s.build[key] === "string") out.build[key] = s.build[key].trim();
    }
  }

  if (Array.isArray(s.swapDirs)) out.swapDirs = cleanList(s.swapDirs, 20);
  if (Array.isArray(s.preserve)) out.preserve = cleanList(s.preserve, 60);

  for (const flag of ["smartInstall", "autoRollback", "autoPrepare"]) {
    if (typeof s[flag] === "boolean") out[flag] = s[flag];
  }
  return out;
}

function cleanList(list, max) {
  return list
    .map((x) => String(x).trim())
    .filter((x) => x && !x.startsWith("/") && !x.includes(".."))
    .slice(0, max);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** A brand new site, with nothing configured yet. */
export function createSite({ name, runner = "local", publicUrl = "", settings = {}, github = {} }, takenIds = []) {
  const clean = String(name || "").trim().slice(0, 60);
  if (!clean) throw new Error("A site needs a name.");
  if (!RUNNERS.includes(runner)) throw new Error("Pick where this site runs.");
  return {
    id: newSiteId(clean, takenIds),
    name: clean,
    runner,
    publicUrl: safeUrl(publicUrl),
    // Only meaningful for a remote site, but harmless to always have: it
    // means switching a site to an agent later needs no extra step.
    token: newToken(),
    createdAt: new Date().toISOString(),
    settings: sanitizeSettings(settings),
    github: sanitizeGithub(github),
  };
}

export function sanitizeGithub(g = {}) {
  return {
    repo: typeof g.repo === "string" ? g.repo.trim().slice(0, 140) : "",
    ref: typeof g.ref === "string" ? g.ref.trim().slice(0, 120) : "",
    // Per-site credential; falls back to the Command Center's own token.
    token: typeof g.token === "string" ? g.token.trim().slice(0, 255) : "",
    username: typeof g.username === "string" ? g.username.trim().slice(0, 80) : "",
  };
}

export function safeUrl(u) {
  const s = String(u || "").trim();
  if (!s) return "";
  try {
    const parsed = new URL(s);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

/** What a remote agent is allowed to see. Never anything about other sites. */
export function agentFacingSettings(site) {
  const { appDir, port, restart, healthUrl, versionUrl, healthTimeoutMs, stopGraceMs, build, swapDirs, preserve, smartInstall, autoRollback, autoPrepare } = site.settings;
  return {
    appDir,
    port,
    restart,
    healthUrl,
    versionUrl,
    healthTimeoutMs,
    stopGraceMs,
    build,
    swapDirs,
    preserve,
    smartInstall,
    autoRollback,
    autoPrepare,
  };
}

/** Cheap change-detector, so an agent only re-applies settings when they move. */
export function settingsHash(site) {
  return crypto.createHash("sha1").update(JSON.stringify(agentFacingSettings(site))).digest("hex").slice(0, 12);
}

/** Everything the dashboard may see. The token is included — this page is the vault. */
export function publicSite(site) {
  return {
    id: site.id,
    name: site.name,
    runner: site.runner,
    publicUrl: site.publicUrl,
    token: site.token,
    createdAt: site.createdAt,
    settings: site.settings,
    github: {
      repo: site.github?.repo || "",
      ref: site.github?.ref || "",
      username: site.github?.username || "",
      hasToken: !!site.github?.token,
    },
    configured: !!site.settings.appDir,
  };
}
