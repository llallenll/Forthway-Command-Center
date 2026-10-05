/**
 * SITES — websites, releases, deploy orchestration and environment.
 *
 * A website belongs to a project and runs either on one server (main or any
 * enabled agent server) or load balanced across ≥2 lbEligible servers. The
 * panel never touches a site's files itself: every operation is a named task
 * (`site.deploy`, `site.restart`, …) sent through ctx.cluster.runTask to each
 * target server, where shared/tasks.mjs drives shared/deployer.mjs.
 *
 * Releases are zips kept in dataDir/releases/<id>.zip. Agents fetch them from
 * GET /agent/releases/:id (node Bearer token, or the short-lived download
 * token that comes with each deploy task). The main server gets the local
 * file path as well, so it never has to download from itself.
 *
 * There is deliberately no "run a command" feature here. Logs are read-only.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";

import { httpError } from "./http.mjs";
import {
  normalizeRepo,
  cleanRef,
  repoInfo,
  listRefs,
  resolveCommit,
  downloadZipballToFile,
} from "./github.mjs";
import { inspectZip, readZipFile } from "../../shared/zip.mjs";
import { isEnvKey, cleanEnvValue, parseEnvText } from "../../shared/env.mjs";
import { ensureDir, humanBytes } from "../../shared/fsx.mjs";

export const SITE_TYPES = ["node", "static", "php"];
export const LB_METHODS = ["round_robin", "least_conn", "ip_hash"];
export const MAX_RELEASE_BYTES = 500 * 1024 * 1024;
const PORT_FIRST = 3001;
const PORT_LAST = 60999;
const DEFAULT_KEEP_RELEASES = 10;
const RESERVED_ENV = new Set(["PORT"]);
const STATUS_EVERY_MS = 120_000;
const STATUS_TIMEOUT_MS = 20_000;
const DOWNLOAD_TOKEN_TTL_MS = 6 * 60 * 60_000;
const ENV_EXAMPLE_NAMES = [".env.example", ".env.sample", ".env.template", ".env.dist", "env.example", ".env.local.example"];
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const FORBIDDEN_ROOTS = ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var/lib/mysql"];

const now = () => new Date().toISOString();
/** Base folder for default app directories (installer may override). */
const SITES_DIR = () => path.resolve(process.env.FCC_SITES_DIR || "/srv/fcc/sites");

// ------------------------------------------------------------- pure helpers

export function slugify(s, max = 40) {
  return (
    String(s || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/, "") || ""
  );
}

export function normalizeDomains(input) {
  const list = Array.isArray(input) ? input : String(input ?? "").split(/[\s,]+/);
  const out = [];
  for (const raw of list) {
    let d = String(raw ?? "").trim().toLowerCase();
    if (!d) continue;
    d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
    if (!DOMAIN_RE.test(d)) throw httpError(400, `"${String(raw).trim()}" is not a valid domain name.`);
    if (!out.includes(d)) out.push(d);
  }
  if (out.length > 50) throw httpError(400, "A website can have at most 50 domains.");
  return out;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function cleanList(list, max) {
  return (Array.isArray(list) ? list : [])
    .map((x) => String(x).trim())
    .filter((x) => x && !x.startsWith("/") && !x.split("/").includes(".."))
    .slice(0, max);
}

function cleanRelDir(v) {
  const s = String(v ?? "").trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (!s) return "";
  if (s.split("/").some((p) => p === ".." || p === "") || s.length > 200 || !/^[\w./@+-]+$/.test(s)) {
    throw httpError(400, `"${v}" is not a valid folder inside the app directory.`);
  }
  return s;
}

function cleanCommand(v, max = 500) {
  return String(v ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

export function defaultSiteSettings(type) {
  const node = type === "node";
  return {
    start: node ? "npm start" : "",
    publicDir: "",
    phpVersion: "",
    build: {
      install: node ? "npm install --no-audit --no-fund" : "",
      prepare: "",
      build: node ? "npm run build" : "",
      artifact: "",
    },
    healthTimeoutMs: 180_000,
    stopGraceMs: 10_000,
    swapDirs: [],
    preserve: [],
    smartInstall: true,
    autoRollback: true,
    autoPrepare: node,
    writeEnvFile: true,
    keepReleases: DEFAULT_KEEP_RELEASES,
  };
}

/** Merge posted settings over a base, dropping anything unknown. */
export function sanitizeSettings(input, base) {
  const out = structuredClone(base);
  const s = input && typeof input === "object" ? input : {};
  if (typeof s.start === "string") out.start = cleanCommand(s.start);
  if ("publicDir" in s) out.publicDir = cleanRelDir(s.publicDir);
  if (typeof s.phpVersion === "string") {
    const v = s.phpVersion.trim();
    if (v && !/^\d\.\d$/.test(v)) throw httpError(400, "PHP version looks like 8.3.");
    out.phpVersion = v;
  }
  if (s.build && typeof s.build === "object") {
    for (const k of ["install", "prepare", "build"]) if (typeof s.build[k] === "string") out.build[k] = cleanCommand(s.build[k]);
    if (typeof s.build.artifact === "string") out.build.artifact = s.build.artifact.trim() ? cleanRelDir(s.build.artifact) : "";
  }
  if (Number.isFinite(+s.healthTimeoutMs) && s.healthTimeoutMs !== null && s.healthTimeoutMs !== "") {
    out.healthTimeoutMs = clamp(Math.round(+s.healthTimeoutMs), 10_000, 3_600_000);
  }
  if (Number.isFinite(+s.stopGraceMs) && s.stopGraceMs !== null && s.stopGraceMs !== "") {
    out.stopGraceMs = clamp(Math.round(+s.stopGraceMs), 1_000, 300_000);
  }
  if (Number.isFinite(+s.keepReleases) && s.keepReleases !== null && s.keepReleases !== "") {
    out.keepReleases = clamp(Math.round(+s.keepReleases), 1, 100);
  }
  if (Array.isArray(s.swapDirs)) out.swapDirs = cleanList(s.swapDirs, 20);
  if (Array.isArray(s.preserve)) out.preserve = cleanList(s.preserve, 60);
  for (const f of ["smartInstall", "autoRollback", "autoPrepare", "writeEnvFile"]) {
    if (typeof s[f] === "boolean") out[f] = s[f];
  }
  return out;
}

export function sanitizeEnv(input) {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw httpError(400, "env must be an object of NAME: value.");
  const entries = Object.entries(input);
  if (entries.length > 500) throw httpError(400, "At most 500 variables per website.");
  const out = {};
  for (const [rawKey, v] of entries) {
    const k = String(rawKey).trim();
    if (!isEnvKey(k)) throw httpError(400, `"${k}" is not a usable variable name — letters, digits and underscores, not starting with a digit.`);
    if (RESERVED_ENV.has(k)) continue; // PORT is set by the panel
    out[k] = cleanEnvValue(v == null ? "" : String(v)).slice(0, 16_000);
  }
  return out;
}

function sanitizeHealthPath(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (!s.startsWith("/") || s.length > 200 || /\s/.test(s)) throw httpError(400, "Health path must start with / (for example /api/health), or be empty to turn the check off.");
  return s;
}

function cleanFilename(v) {
  const base = path.basename(String(v || "")).replace(/[^\w.+-]+/g, "_").slice(0, 120);
  return base && base !== "." && base !== ".." ? base : "";
}

/** .env-style text → [{ key, value, comment }], keeping the comment above each key. */
function parseEnvEntries(text) {
  const out = [];
  let comment = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      comment = [];
      continue;
    }
    if (line.startsWith("#")) {
      comment.push(line.replace(/^#+\s?/, ""));
      continue;
    }
    const body = line.replace(/^export\s+/, "");
    const eq = body.indexOf("=");
    const key = eq > 0 ? body.slice(0, eq).trim() : "";
    if (!isEnvKey(key)) {
      comment = [];
      continue;
    }
    let value = body.slice(eq + 1);
    const m = /^([^#"'`]*?)\s+#\s?(.*)$/.exec(value);
    let inline = "";
    if (m) {
      value = m[1];
      inline = m[2].trim();
    }
    out.push({
      key,
      value: cleanEnvValue(value).slice(0, 4000),
      comment: [...comment, inline].filter(Boolean).join(" ").slice(0, 200),
    });
    comment = [];
    if (out.length >= 300) break;
  }
  return out;
}

function parsePackageJson(raw) {
  try {
    const pkg = JSON.parse(raw);
    const scripts = {};
    for (const [k, v] of Object.entries(pkg.scripts || {})) {
      if (typeof v === "string") scripts[String(k).slice(0, 60)] = v.slice(0, 300);
    }
    return {
      name: typeof pkg.name === "string" ? pkg.name.slice(0, 80) : "",
      version: typeof pkg.version === "string" ? pkg.version.slice(0, 40) : "",
      scripts,
    };
  } catch {
    return { error: "package.json is there but is not valid JSON." };
  }
}

function maskEnv(vars) {
  const out = {};
  for (const [k, v] of Object.entries(vars || {})) {
    if (/PASSWORD|SECRET|TOKEN/i.test(k)) out[k] = v ? "••••••••" : "";
    else if (/URL$/i.test(k) && typeof v === "string") out[k] = v.replace(/(\/\/[^:/@]+:)[^@]*@/, "$1••••••••@");
    else out[k] = v;
  }
  return out;
}

// ------------------------------------------------------------------ module

export function register(router, ctx) {
  const db = ctx.db;
  const busy = new Map(); // siteId -> jobId of the operation holding the site
  const DL_KEY = crypto.randomBytes(32);

  const MAIN = () => ctx.cluster?.MAIN_ID || "main";
  const releasesDir = () => ensureDir(path.join(ctx.dataDir, "releases"));
  const releaseFile = (id) => path.join(releasesDir(), `${id}.zip`);
  const newId = (prefix) => (db.newId ? db.newId(prefix) : `${prefix}_${crypto.randomBytes(5).toString("hex")}`);

  // ---------------------------------------------------------- servers

  function getServer(id) {
    if (!id) return null;
    if (ctx.cluster?.getServer) return ctx.cluster.getServer(id) || null;
    return id === MAIN() ? { id, name: "Main", role: "main", enabled: true } : null;
  }
  const serverName = (id) => getServer(id)?.name || id;
  function isOnline(id) {
    if (ctx.cluster?.isOnline) {
      try {
        return !!ctx.cluster.isOnline(id);
      } catch {
        return false;
      }
    }
    return id === MAIN();
  }

  /**
   * Single-server sites: exactly one existing, enabled server (main or any
   * agent server). Load-balanced sites: ≥2 distinct existing, enabled servers
   * with lbEligible !== false. `keep` are ids already used by the site, which
   * stay acceptable even if they have since been disabled.
   */
  function validatePlacement(loadBalanced, serverIds, keep = []) {
    let ids = [...new Set((Array.isArray(serverIds) ? serverIds : serverIds ? [serverIds] : []).map((x) => String(x).trim()).filter(Boolean))];
    const check = (id) => {
      const s = getServer(id);
      if (!s) throw httpError(400, `There is no server "${id}".`);
      if (s.enabled === false && !keep.includes(id)) throw httpError(400, `Server "${s.name || id}" is disabled.`);
      return s;
    };
    if (!loadBalanced) {
      if (!ids.length) ids = [MAIN()];
      if (ids.length > 1) {
        throw httpError(400, "A website that is not load balanced runs on exactly one server. Pick one, or turn on load balancing.");
      }
      check(ids[0]);
      return ids;
    }
    if (ids.length < 2) throw httpError(400, "A load-balanced website needs at least two servers.");
    for (const id of ids) {
      const s = check(id);
      if (s.lbEligible === false && !keep.includes(id)) {
        throw httpError(400, `Server "${s.name || id}" is not available for load balancing.`);
      }
    }
    return ids;
  }

  // ------------------------------------------------------------ sites

  const getSite = (id) => db.get("sites", id);
  function mustSite(id) {
    const s = getSite(id);
    if (!s || s.deleting) throw httpError(404, "Website not found.");
    return s;
  }
  function listSites(filter = {}) {
    const f = {};
    if (filter.projectId) f.projectId = filter.projectId;
    return db.list("sites", f);
  }
  function targets(site) {
    if (!site) return [];
    const ids = Array.isArray(site.serverIds) ? site.serverIds : [];
    return site.loadBalanced ? [...ids] : [ids[0] || MAIN()];
  }
  const pm2Name = (site) => `fcc-${site.id}`;
  const docRoot = (site) => path.posix.join(site.appDir, site.settings?.publicDir || "");

  function publicSite(site) {
    if (!site) return null;
    const t = targets(site);
    const rel = site.currentReleaseId ? db.get("releases", site.currentReleaseId) : null;
    const { github = {}, env = {} } = site;
    return {
      id: site.id,
      projectId: site.projectId,
      projectName: db.get("projects", site.projectId)?.name || null,
      name: site.name,
      slug: site.slug,
      type: site.type,
      domains: site.domains || [],
      url: site.domains?.[0] ? `${site.ssl?.enabled ? "https" : "http"}://${site.domains[0]}` : null,
      port: site.port,
      appDir: site.appDir,
      docRoot: site.type === "node" ? null : docRoot(site),
      loadBalanced: !!site.loadBalanced,
      serverIds: t,
      lbMethod: site.lbMethod || "round_robin",
      lb: { loadBalanced: !!site.loadBalanced, servers: t.length, method: site.lbMethod || "round_robin" },
      healthPath: site.healthPath ?? "",
      settings: site.settings,
      github: { repo: github.repo || "", branch: github.branch || "", hasToken: !!github.tokenEnc },
      envCount: Object.keys(env).length,
      linkedDatabaseIds: site.linkedDatabaseIds || [],
      ssl: site.ssl || { enabled: false, status: "none" },
      currentReleaseId: site.currentReleaseId || null,
      previousReleaseId: site.previousReleaseId || null,
      currentVersion: rel?.version || null,
      state: Object.fromEntries(t.map((id) => [id, { ...(site.state?.[id] || {}), serverName: serverName(id), online: isOnline(id) }])),
      busyJobId: busyJob(site.id),
      deleting: !!site.deleting,
      createdAt: site.createdAt,
      updatedAt: site.updatedAt || null,
    };
  }

  function publicRelease(r, site = getSite(r.siteId)) {
    const deployedOn = site
      ? Object.entries(site.state || {})
          .filter(([sid, st]) => st?.releaseId === r.id && targets(site).includes(sid))
          .map(([sid]) => sid)
      : [];
    return {
      id: r.id,
      siteId: r.siteId,
      filename: r.filename,
      size: r.size,
      sizeHuman: humanBytes(r.size || 0),
      sha256: r.sha256,
      version: r.version || null,
      commit: r.commit || null,
      source: r.source,
      github: r.github || null,
      packageName: r.packageName || null,
      fileCount: r.fileCount || 0,
      prebuilt: !!r.prebuilt,
      warnings: r.warnings || [],
      envExample: r.envExample || null,
      pinned: !!r.pinned,
      note: r.note || "",
      deployCount: r.deployCount || 0,
      lastDeployedAt: r.lastDeployedAt || null,
      isCurrent: site?.currentReleaseId === r.id,
      isPrevious: site?.previousReleaseId === r.id,
      deployedOn,
      available: fs.existsSync(releaseFile(r.id)),
      createdAt: r.createdAt,
    };
  }

  function emit(siteOrId) {
    const site = typeof siteOrId === "string" ? getSite(siteOrId) : siteOrId;
    if (!site) return;
    try {
      ctx.events?.broadcast?.("site", publicSite(site));
    } catch {
      /* never let an SSE hiccup break an operation */
    }
  }

  function audit(admin, action, site, details) {
    try {
      ctx.activity?.(admin, action, { type: "site", id: site.id, name: site.name }, details);
    } catch {
      /* ignore */
    }
  }

  function setServerState(siteId, serverId, patch, { silent = false } = {}) {
    const site = getSite(siteId);
    if (!site) return;
    const state = { ...(site.state || {}) };
    state[serverId] = { ...(state[serverId] || {}), ...patch, checkedAt: now() };
    db.update("sites", siteId, { state });
    if (!silent) emit(siteId);
  }

  function dropServerState(siteId, serverIds) {
    const site = getSite(siteId);
    if (!site) return;
    const state = { ...(site.state || {}) };
    for (const id of serverIds) delete state[id];
    db.update("sites", siteId, { state });
  }

  // ------------------------------------------------- validation helpers

  function usedPorts(exceptId) {
    return new Set(db.list("sites").filter((s) => s.id !== exceptId && s.port).map((s) => +s.port));
  }
  function reservedPorts() {
    return new Set([+ctx.config?.port || 0, 3306, 4000, 4124].filter(Boolean));
  }
  function allocatePort() {
    const used = usedPorts();
    const reserved = reservedPorts();
    for (let p = PORT_FIRST; p <= PORT_LAST; p++) if (!used.has(p) && !reserved.has(p)) return p;
    throw httpError(409, "No free port left for a new website.");
  }
  function validatePort(p, exceptId) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) throw httpError(400, "Port must be a whole number between 1024 and 65535.");
    if (reservedPorts().has(n)) throw httpError(409, `Port ${n} is reserved.`);
    const other = db.list("sites").find((s) => s.id !== exceptId && +s.port === n);
    if (other) throw httpError(409, `Port ${n} is already used by website "${other.name}".`);
    return n;
  }

  function assertDomainsFree(domains, exceptId) {
    for (const s of db.list("sites")) {
      if (s.id === exceptId) continue;
      for (const d of domains) {
        if ((s.domains || []).includes(d)) throw httpError(409, `${d} is already used by website "${s.name}".`);
      }
    }
  }

  function validateAppDir(dir, exceptId) {
    const s = String(dir || "").trim();
    if (!s.startsWith("/")) throw httpError(400, "The app directory must be a full path, like /srv/fcc/sites/acme/web.");
    const norm = path.posix.normalize(s).replace(/\/+$/, "");
    if (norm !== s.replace(/\/+$/, "") || norm.split("/").filter(Boolean).length < 2 || /[\0\n]/.test(norm)) {
      throw httpError(400, "That app directory is not allowed.");
    }
    const inside = (root) => norm === root || norm.startsWith(root + "/");
    const blocked = [...FORBIDDEN_ROOTS, ctx.dataDir && path.resolve(ctx.dataDir), ctx.rootDir && path.resolve(ctx.rootDir)].filter(Boolean);
    if (blocked.some(inside)) throw httpError(400, `${norm} is inside a system or panel directory.`);
    for (const o of db.list("sites")) {
      if (o.id === exceptId || !o.appDir) continue;
      if (o.appDir === norm || norm.startsWith(o.appDir + "/") || o.appDir.startsWith(norm + "/")) {
        throw httpError(409, `${norm} overlaps the app directory of website "${o.name}".`);
      }
    }
    return norm;
  }

  function validateLinkedDatabases(ids, projectId) {
    if (ids == null) return [];
    if (!Array.isArray(ids)) throw httpError(400, "linkedDatabaseIds must be a list.");
    const out = [];
    for (const raw of ids) {
      const id = String(raw);
      const rec = db.get("databases", id);
      if (!rec) throw httpError(400, `There is no database "${id}".`);
      if (rec.projectId && rec.projectId !== projectId) throw httpError(400, `Database "${rec.name}" belongs to another project.`);
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  // ----------------------------------------------------------- secrets

  function encrypt(v) {
    if (!v) return "";
    return ctx.secrets?.encrypt ? ctx.secrets.encrypt(v) : v;
  }
  function decrypt(v) {
    if (!v) return "";
    if (!ctx.secrets?.decrypt) return v;
    if (ctx.secrets.isEncrypted && !ctx.secrets.isEncrypted(v)) return v;
    try {
      return ctx.secrets.decrypt(v);
    } catch {
      return "";
    }
  }
  function sanitizeGithub(input, prev = {}) {
    const g = input && typeof input === "object" ? input : {};
    const out = { repo: prev.repo || "", branch: prev.branch || "", tokenEnc: prev.tokenEnc || "" };
    if ("repo" in g) {
      const raw = String(g.repo || "").trim();
      if (raw) {
        const repo = normalizeRepo(raw);
        if (!repo) throw httpError(400, "That does not look like a GitHub repository (owner/name).");
        out.repo = repo;
      } else out.repo = "";
    }
    if ("branch" in g || "ref" in g) {
      const ref = cleanRef(g.branch ?? g.ref);
      if (ref === null) throw httpError(400, "That branch name is not valid.");
      out.branch = ref;
    }
    if (typeof g.token === "string" && g.token.trim()) out.tokenEnc = encrypt(g.token.trim().slice(0, 255));
    if (g.clearToken) out.tokenEnc = "";
    return out;
  }
  function githubToken(site) {
    const own = decrypt(site?.github?.tokenEnc);
    if (own) return own;
    const g = ctx.config?.github || {};
    return decrypt(g.tokenEnc) || decrypt(g.token) || "";
  }

  // ------------------------------------------------- env + task spec

  function linkedPrefix(dbRec, i) {
    if (i === 0) return "";
    const p = slugify(dbRec?.name || `db${i + 1}`, 30).toUpperCase().replace(/-/g, "_");
    return p ? `${/^\d/.test(p) ? "DB_" : ""}${p}_` : `DB${i + 1}_`;
  }

  /** Linked database variables, keyed and prefixed. `resolve` returns the vars (maybe a Promise). */
  function collectLinked(site, serverId, values) {
    const env = {};
    const sources = [];
    (site.linkedDatabaseIds || []).forEach((id, i) => {
      const rec = db.get("databases", id);
      const prefix = linkedPrefix(rec, i);
      const v = values[i];
      const vars = {};
      if (v && typeof v === "object" && !v.then) for (const [k, val] of Object.entries(v)) if (val != null) vars[prefix + k] = String(val);
      Object.assign(env, vars);
      sources.push({ databaseId: id, name: rec?.name || id, prefix, vars, error: v?.error || (rec ? null : "database not found") });
    });
    return { env, sources };
  }
  function envForSafe(id, serverId) {
    try {
      return ctx.mysql?.envFor ? ctx.mysql.envFor(id, { serverId }) : { error: "database module not loaded" };
    } catch (err) {
      return { error: err.message };
    }
  }
  function linkedEnvSync(site, serverId) {
    return collectLinked(site, serverId, (site.linkedDatabaseIds || []).map((id) => envForSafe(id, serverId)));
  }
  async function linkedEnvAsync(site, serverId) {
    const values = await Promise.all(
      (site.linkedDatabaseIds || []).map(async (id) => {
        try {
          return await envForSafe(id, serverId);
        } catch (err) {
          return { error: err.message };
        }
      }),
    );
    return collectLinked(site, serverId, values);
  }

  /** Settings for shared/deployer.mjs, derived from the site record. */
  function deployerSettings(site, env) {
    const st = { ...defaultSiteSettings(site.type), ...(site.settings || {}) };
    const node = site.type === "node";
    const healthPath = site.healthPath ?? (node ? "/api/health" : "");
    const start = st.start || "npm start";
    const out = {
      appDir: site.appDir,
      port: site.port,
      restart: node
        ? { mode: "pm2", service: pm2Name(site), pm2Start: start, start, stop: "", useSudo: false, env }
        : { mode: "none", service: "", pm2Start: "", start: "", stop: "", useSudo: false, env },
      healthUrl: healthPath ? `http://127.0.0.1:${site.port}${healthPath}` : "",
      versionUrl: "",
      healthCheck: !!healthPath,
      versionCheck: node,
      healthTimeoutMs: st.healthTimeoutMs,
      stopGraceMs: st.stopGraceMs,
      build: { ...defaultSiteSettings(site.type).build, ...(st.build || {}) },
      smartInstall: st.smartInstall !== false,
      autoRollback: st.autoRollback !== false,
      autoPrepare: node ? st.autoPrepare !== false : !!st.autoPrepare,
      writeEnvFile: st.writeEnvFile !== false,
      createAppDir: true,
    };
    if (st.publicDir) out.root = st.publicDir; // document root inside appDir (static/php), read by shared/tasks.mjs
    if (st.swapDirs?.length) out.swapDirs = st.swapDirs;
    if (st.preserve?.length) out.preserve = st.preserve;
    return out;
  }

  function buildSpec(site, serverId, linkedVars) {
    const env = { ...(site.env || {}), ...linkedVars };
    return {
      siteId: site.id,
      projectId: site.projectId,
      name: site.name,
      type: site.type,
      appDir: site.appDir,
      docRoot: docRoot(site),
      port: site.port,
      pm2Name: pm2Name(site),
      domains: site.domains || [],
      healthPath: site.healthPath ?? "",
      phpVersion: site.type === "php" ? site.settings?.phpVersion || "" : undefined,
      serverId,
      settings: deployerSettings(site, env),
      env,
    };
  }

  /** Contract: sync. Linked DB env is included when ctx.mysql.envFor is synchronous. */
  function specFor(siteOrId, serverId) {
    const site = typeof siteOrId === "string" ? getSite(siteOrId) : siteOrId;
    if (!site) return null;
    const sid = serverId || targets(site)[0];
    return buildSpec(site, sid, linkedEnvSync(site, sid).env);
  }
  async function specForAsync(siteOrId, serverId) {
    const site = typeof siteOrId === "string" ? getSite(siteOrId) : siteOrId;
    if (!site) return null;
    const sid = serverId || targets(site)[0];
    return buildSpec(site, sid, (await linkedEnvAsync(site, sid)).env);
  }

  // ------------------------------------------------------------ tasks

  async function runTask(serverId, type, payload, opts = {}) {
    if (!ctx.cluster?.runTask) throw new Error("The server cluster module is not available, so nothing can run on servers yet.");
    return ctx.cluster.runTask(serverId, type, payload, opts);
  }

  function assertOnline(serverId) {
    if (!isOnline(serverId)) throw new Error(`${serverName(serverId)} is offline.`);
  }

  function prefixed(log, serverId, multi) {
    if (!multi) return log;
    const tag = `[${serverName(serverId)}] `;
    return (line) => String(line ?? "").split("\n").forEach((l) => log(tag + l));
  }

  function withTimeout(signal, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    return { signal: ctrl.signal, done: () => (clearTimeout(t), signal?.removeEventListener?.("abort", onAbort)) };
  }

  function downloadToken(releaseId) {
    const exp = (Date.now() + DOWNLOAD_TOKEN_TTL_MS).toString(36);
    const sig = crypto.createHmac("sha256", DL_KEY).update(`${releaseId}:${exp}`).digest("base64url");
    return `${exp}.${sig}`;
  }
  function verifyDownloadToken(releaseId, token) {
    const m = /^([0-9a-z]+)\.([\w-]+)$/.exec(String(token || ""));
    if (!m || parseInt(m[1], 36) < Date.now()) return false;
    const want = crypto.createHmac("sha256", DL_KEY).update(`${releaseId}:${m[1]}`).digest();
    const got = Buffer.from(m[2], "base64url");
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  function panelBase(req) {
    let base = "";
    try {
      base = ctx.panelUrl?.(req) || "";
    } catch {
      /* ignore */
    }
    return String(base || `http://127.0.0.1:${ctx.config?.port || 4000}`).replace(/\/+$/, "");
  }

  function releasePayload(release, serverId, base) {
    return {
      id: release.id,
      url: `${base}/agent/releases/${release.id}`,
      token: downloadToken(release.id),
      sha256: release.sha256,
      size: release.size,
      filename: release.filename,
      version: release.version || null,
      ...(serverId === MAIN() ? { file: releaseFile(release.id) } : {}),
    };
  }

  function stateFromResult(site, res) {
    const healthy = res?.health?.ok ?? res?.healthy ?? null;
    return {
      running: res?.appRunning ?? res?.running ?? (site.type === "node" ? healthy : true),
      healthy,
      version: res?.serving?.version || res?.deployed?.version || res?.summary?.version || res?.version || null,
      error: null,
    };
  }

  const releaseLabel = (id) => {
    if (!id) return "nothing deployed";
    const r = db.get("releases", id);
    return r ? `${r.version ? `v${r.version}` : "unversioned"} (${id})` : id;
  };

  /**
   * Deploy one release to `serverIds`, one server at a time. Stops on the
   * first failure and reports where every server stands.
   */
  async function deployTo(siteId, release, serverIds, { log, signal, base, multi }) {
    const done = [];
    for (let i = 0; i < serverIds.length; i++) {
      const sid = serverIds[i];
      if (signal?.aborted) throw new Error("Cancelled.");
      const site = getSite(siteId);
      if (!site) throw new Error("The website was deleted.");
      log(`── ${serverName(sid)} (${i + 1}/${serverIds.length}): deploying ${releaseLabel(release.id)}`);
      setServerState(siteId, sid, { deploying: release.id });
      try {
        assertOnline(sid);
        const spec = await specForAsync(site, sid);
        const res = await runTask(sid, "site.deploy", { spec, release: releasePayload(release, sid, base) }, { log: prefixed(log, sid, multi), signal });
        setServerState(siteId, sid, { ...stateFromResult(site, res), releaseId: release.id, deploying: null, deployedAt: now() });
        done.push(sid);
        log(`✓ ${serverName(sid)} is serving ${releaseLabel(release.id)}`);
      } catch (err) {
        const rolledBack = err?.rolledBackTo !== undefined;
        setServerState(siteId, sid, { deploying: null, error: err.message, healthy: rolledBack ? err.health?.ok ?? null : false });
        const pending = serverIds.slice(i + 1);
        log(`!! ${serverName(sid)} failed: ${err.message}`);
        const after = getSite(siteId);
        log("Where every server stands now:");
        for (const t of targets(after)) log(`   ${serverName(t)}: ${releaseLabel(after.state?.[t]?.releaseId)}`);
        const e = new Error(
          serverIds.length > 1
            ? `Deploy failed on ${serverName(sid)}: ${err.message} Updated: ${done.map(serverName).join(", ") || "none"}. Not attempted: ${pending.map(serverName).join(", ") || "none"}.`
            : `Deploy failed on ${serverName(sid)}: ${err.message}`,
        );
        e.cause = err;
        throw e;
      }
    }
    return done;
  }

  async function syncLb(siteId, log) {
    const site = getSite(siteId);
    if (!site || !ctx.lb?.syncSite) {
      if (!ctx.lb?.syncSite) log?.("(load balancer module not loaded — front door not updated)");
      return;
    }
    log?.("Updating the front door (nginx)…");
    try {
      await ctx.lb.syncSite(site);
      log?.("✓ nginx updated.");
    } catch (err) {
      throw new Error(`Updating the front door (nginx) failed: ${err.message}`);
    }
  }

  function markCurrent(siteId, releaseId) {
    const site = getSite(siteId);
    if (!site) return;
    if (site.currentReleaseId !== releaseId) {
      db.update("sites", siteId, {
        previousReleaseId: site.currentReleaseId || site.previousReleaseId || null,
        currentReleaseId: releaseId,
      });
    }
    const rel = db.get("releases", releaseId);
    if (rel) db.update("releases", releaseId, { deployCount: (rel.deployCount || 0) + 1, lastDeployedAt: now() });
    emit(siteId);
  }

  /** Full deploy of `release` to every target, then the front door. */
  async function deployRelease(siteId, release, { log, signal, base }) {
    const site = getSite(siteId);
    if (!fs.existsSync(releaseFile(release.id))) throw new Error(`The archive for release ${release.id} is missing.`);
    const ids = targets(site);
    log(
      `Deploying ${releaseLabel(release.id)} of ${site.name} to ${ids.length} server${ids.length === 1 ? "" : "s"}` +
        (site.loadBalanced ? " — rolling, one server at a time." : "."),
    );
    await deployTo(siteId, release, ids, { log, signal, base, multi: ids.length > 1 });
    markCurrent(siteId, release.id);
    await syncLb(siteId, log);
    pruneReleases(siteId);
    log(`Done. ${site.name} is on ${releaseLabel(release.id)} everywhere.`);
    return { releaseId: release.id, version: release.version || null, servers: ids };
  }

  /** restart / stop / start fan-out (sequential = rolling for LB sites). */
  async function fanOut(siteId, type, { log, signal, stopOnError = false, servers }) {
    const site = getSite(siteId);
    const ids = servers || targets(site);
    const multi = ids.length > 1;
    const errors = [];
    for (const sid of ids) {
      if (signal?.aborted) throw new Error("Cancelled.");
      log(`── ${serverName(sid)}: ${type.replace("site.", "")}`);
      try {
        assertOnline(sid);
        const spec = await specForAsync(getSite(siteId), sid);
        const res = await runTask(sid, type, { spec }, { log: prefixed(log, sid, multi), signal });
        const patch =
          type === "site.stop" ? { running: false, healthy: null, error: null } : stateFromResult(site, res);
        setServerState(siteId, sid, patch);
        log(`✓ ${serverName(sid)} done.`);
      } catch (err) {
        setServerState(siteId, sid, { error: err.message });
        log(`!! ${serverName(sid)}: ${err.message}`);
        errors.push(`${serverName(sid)}: ${err.message}`);
        if (stopOnError) break;
      }
    }
    if (errors.length) throw new Error(`${type.replace("site.", "")} failed — ${errors.join("; ")}`);
    return { servers: ids };
  }

  async function refreshStatus(siteId, { silent = false } = {}) {
    const site = getSite(siteId);
    if (!site) return {};
    const ids = targets(site);
    await Promise.all(
      ids.map(async (sid) => {
        if (!isOnline(sid)) {
          setServerState(siteId, sid, { online: false, running: null, healthy: null, error: `${serverName(sid)} is offline.` }, { silent: true });
          return;
        }
        const t = withTimeout(null, STATUS_TIMEOUT_MS);
        try {
          const spec = await specForAsync(site, sid);
          const res = await runTask(sid, "site.status", { spec }, { log: () => {}, signal: t.signal });
          setServerState(
            siteId,
            sid,
            {
              online: true,
              running: res?.running ?? null,
              healthy: res?.healthy ?? null,
              version: res?.version ?? site.state?.[sid]?.version ?? null,
              pid: res?.pid ?? null,
              error: null,
            },
            { silent: true },
          );
        } catch (err) {
          setServerState(siteId, sid, { error: t.signal.aborted ? "Status check timed out." : err.message }, { silent: true });
        } finally {
          t.done();
        }
      }),
    );
    const after = getSite(siteId);
    if (!silent) emit(after);
    return Object.fromEntries(ids.map((id) => [id, after?.state?.[id] || {}]));
  }

  // ------------------------------------------------------------ jobs

  function busyJob(siteId) {
    const jid = busy.get(siteId);
    if (!jid) return null;
    const j = ctx.jobs?.get?.(jid);
    if (j && j.status !== "queued" && j.status !== "running") {
      busy.delete(siteId);
      return null;
    }
    return jid;
  }
  function assertIdle(siteId) {
    const jid = busyJob(siteId);
    if (jid) throw httpError(409, "Another operation is already running on this website. Wait for it to finish.", { jobId: jid });
  }

  /** Start a job for a site. `lock` makes it exclusive with other locking jobs. */
  function siteJob(site, admin, { type, title, serverId }, fn, { lock = true } = {}) {
    if (!ctx.jobs?.start) throw httpError(503, "The jobs module is not available.");
    if (lock) assertIdle(site.id);
    let jobId = null;
    const job = ctx.jobs.start(
      { type, title, projectId: site.projectId, siteId: site.id, serverId: serverId || null, adminId: admin?.id || null },
      async (args) => {
        try {
          return await fn(args);
        } finally {
          if (lock && busy.get(site.id) === (jobId || args?.job?.id)) busy.delete(site.id);
          emit(site.id);
        }
      },
    );
    jobId = job?.id || null;
    if (lock && jobId) busy.set(site.id, jobId);
    emit(site.id);
    return job;
  }

  // -------------------------------------------------------- releases

  function listReleases(siteId) {
    return db.list("releases", { siteId }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  function deleteReleaseRecord(r) {
    fs.rmSync(releaseFile(r.id), { force: true });
    db.remove("releases", r.id);
  }

  /** Keep the newest N (per site), plus anything pinned, current, previous or still running somewhere. */
  function pruneReleases(siteId) {
    const site = getSite(siteId);
    if (!site) return [];
    const keep = site.settings?.keepReleases ?? ctx.config?.keepReleases ?? DEFAULT_KEEP_RELEASES;
    const live = new Set([site.currentReleaseId, site.previousReleaseId, ...Object.values(site.state || {}).map((s) => s?.releaseId)].filter(Boolean));
    const removed = [];
    listReleases(siteId).forEach((r, i) => {
      if (i < keep || r.pinned || live.has(r.id)) return;
      deleteReleaseRecord(r);
      removed.push(r.id);
    });
    return removed;
  }

  /** Turn a downloaded/uploaded .part file into a release record. */
  function finalizeRelease(siteId, partFile, { filename, source, size, sha256, commit = null, github = null, adminId = null }) {
    const site = getSite(siteId);
    if (!site) {
      fs.rmSync(partFile, { force: true });
      throw httpError(404, "Website not found.");
    }
    const id = newId("rel");
    const dest = releaseFile(id);
    fs.renameSync(partFile, dest);

    let info;
    let buf;
    try {
      buf = fs.readFileSync(dest);
      info = inspectZip(buf);
    } catch (err) {
      fs.rmSync(dest, { force: true });
      throw httpError(400, `That is not a usable zip archive: ${err.message}`);
    }
    const text = (name) => {
      try {
        const b = readZipFile(buf, name);
        return b && b.length <= 512 * 1024 ? b.toString("utf8") : null;
      } catch {
        return null;
      }
    };

    let envExample = null;
    for (const name of ENV_EXAMPLE_NAMES) {
      const body = text(name);
      if (body === null) continue;
      envExample = { file: name, entries: parseEnvEntries(body) };
      break;
    }
    const pkgRaw = info.hasPackageJson ? text("package.json") : null;
    const pkg = pkgRaw ? parsePackageJson(pkgRaw) : null;

    const warnings = [];
    if (site.type === "node") {
      if (!info.hasPackageJson) warnings.push("No package.json at the root of the archive — check this is the right repository or folder.");
      else if (!info.version) warnings.push('No "version" in package.json — this release will show as "unversioned".');
      if (pkg?.error) warnings.push(pkg.error);
      else if (pkg && site.settings?.start === "npm start" && !pkg.scripts?.start) warnings.push('package.json has no "start" script, but the start command is "npm start".');
      if (info.hasNodeModules) warnings.push("The archive contains node_modules; it is discarded and installed fresh.");
      if (info.prebuilt) warnings.push("The archive contains a prebuilt .next — the build step will be skipped.");
    } else {
      const pub = site.settings?.publicDir || "";
      const index = site.type === "php" ? ["index.php", "index.html"] : ["index.html"];
      const hasBuild = !!site.settings?.build?.build;
      // Without an explicit folder the node auto-detects these (shared/tasks.mjs siteRoot).
      const dirs = pub ? [pub] : site.type === "php" ? ["", "public"] : ["", "dist", "build", "out", "public", "_site"];
      if (!hasBuild && !dirs.some((d) => index.some((n) => text(path.posix.join(d, n)) !== null))) {
        warnings.push(`No ${index.join(" or ")} in ${pub ? `${pub}/` : "the root of the archive"} — the site may show an error page.`);
      }
    }

    const rec = db.insert("releases", {
      id,
      siteId,
      filename: filename || `${id}.zip`,
      size,
      sha256,
      version: info.version || null,
      commit,
      source,
      github,
      packageName: info.packageName || null,
      fileCount: info.fileCount,
      prebuilt: !!info.prebuilt,
      warnings,
      envExample,
      scripts: pkg?.scripts || null,
      pinned: false,
      note: "",
      deployCount: 0,
      adminId,
      createdAt: now(),
    });
    pruneReleases(siteId);
    emit(siteId);
    return rec;
  }

  async function receiveUpload(req, siteId, filename, admin) {
    const declared = Number(req.headers["content-length"] || 0);
    const tooBig = () => {
      try {
        req.res?.setHeader?.("Connection", "close");
      } catch {
        /* ignore */
      }
      return httpError(413, `Archives are limited to ${Math.round(MAX_RELEASE_BYTES / 1024 / 1024)} MB.`);
    };
    if (declared > MAX_RELEASE_BYTES) throw tooBig();
    const part = path.join(releasesDir(), `.upload-${crypto.randomBytes(6).toString("hex")}.part`);
    const out = fs.createWriteStream(part, { mode: 0o600 });
    const hash = crypto.createHash("sha256");
    let size = 0;
    let head = null;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_RELEASE_BYTES) throw tooBig();
        if (!head) head = chunk.subarray(0, 4);
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    } catch (err) {
      out.destroy();
      fs.rmSync(part, { force: true });
      if (err.status) throw err;
      throw httpError(400, `Upload interrupted: ${err.message}`);
    }
    if (!size) {
      fs.rmSync(part, { force: true });
      throw httpError(400, "The upload was empty. Send the zip as the request body.");
    }
    if (!head || head[0] !== 0x50 || head[1] !== 0x4b) {
      fs.rmSync(part, { force: true });
      throw httpError(400, "That is not a zip archive.");
    }
    return finalizeRelease(siteId, part, {
      filename: filename || `upload-${now().slice(0, 19).replace(/[:T]/g, "-")}.zip`,
      source: "upload",
      size,
      sha256: hash.digest("hex"),
      adminId: admin?.id || null,
    });
  }

  // ------------------------------------------------------------- API

  ctx.sites = {
    specFor,
    specForAsync,
    get: (id) => getSite(id),
    list: (filter) => listSites(filter),
    targets,
    publicSite,
    publicRelease: (r) => publicRelease(r),
    releaseFile,
    /** Sites that use a database (for DATA: re-push env after a password rotation). */
    forDatabase: (databaseId) => db.list("sites").filter((s) => (s.linkedDatabaseIds || []).includes(databaseId)),
    /** Re-write the app .env block on every target (and restart node sites if `restart`). Returns a job. */
    pushEnv: (siteOrId, { admin = null, restart = true } = {}) => {
      const site = typeof siteOrId === "string" ? getSite(siteOrId) : siteOrId;
      return site ? startEnvJob(site, admin, { restart }) : null;
    },
    /** Remove a database from every site's links (call when a database is deleted). */
    unlinkDatabase: (databaseId) => {
      for (const s of db.list("sites")) {
        if ((s.linkedDatabaseIds || []).includes(databaseId)) {
          db.update("sites", s.id, { linkedDatabaseIds: s.linkedDatabaseIds.filter((x) => x !== databaseId) });
          emit(s.id);
        }
      }
    },
    refreshStatus: (id) => refreshStatus(id),
  };

  function startEnvJob(site, admin, { restart = true } = {}) {
    return siteJob(site, admin, { type: "site.env", title: `Update environment of ${site.name}` }, async ({ log, signal }) => {
      const ids = targets(getSite(site.id));
      const multi = ids.length > 1;
      const errors = [];
      for (const sid of ids) {
        if (signal?.aborted) throw new Error("Cancelled.");
        log(`── ${serverName(sid)}: writing environment`);
        try {
          assertOnline(sid);
          const spec = await specForAsync(getSite(site.id), sid);
          await runTask(sid, "site.env", { spec, env: spec.env }, { log: prefixed(log, sid, multi), signal });
          log(`✓ ${Object.keys(spec.env).length} variables written on ${serverName(sid)}.`);
        } catch (err) {
          errors.push(`${serverName(sid)}: ${err.message}`);
          log(`!! ${serverName(sid)}: ${err.message}`);
        }
      }
      if (errors.length) throw new Error(`Environment update failed — ${errors.join("; ")}`);
      const fresh = getSite(site.id);
      if (restart && fresh.type === "node" && fresh.currentReleaseId) {
        log("Restarting so the app picks up the new values…");
        await fanOut(site.id, "site.restart", { log, signal, stopOnError: true });
      }
      return { servers: ids };
    });
  }

  // ---- list / read

  router.get("/api/sites", async (req, res, { query }) => {
    return { items: listSites({ projectId: query.projectId }).filter((s) => !s.deleting).map(publicSite) };
  });

  router.get("/api/sites/:id", async (req, res, { params }) => {
    const site = mustSite(params.id);
    let upstreams = null;
    try {
      upstreams = ctx.lb?.upstreams ? await ctx.lb.upstreams(site) : null;
    } catch {
      upstreams = null;
    }
    if (!upstreams) {
      upstreams = targets(site).map((sid) => ({
        serverId: sid,
        name: serverName(sid),
        address: ctx.cluster?.address?.(sid) || (sid === MAIN() ? "127.0.0.1" : null),
        port: site.port,
        weight: getServer(sid)?.weight || 1,
        online: isOnline(sid),
        healthy: site.state?.[sid]?.healthy ?? null,
      }));
    }
    return {
      ...publicSite(site),
      upstreams,
      releases: listReleases(site.id).slice(0, 20).map((r) => publicRelease(r, site)),
    };
  });

  // ---- create

  router.post("/api/projects/:projectId/sites", async (req, res, { params, body, admin }) => {
    const project = db.get("projects", params.projectId);
    if (!project) throw httpError(404, "Project not found.");
    const name = String(body.name || "").trim().slice(0, 60);
    if (!name) throw httpError(400, "A website needs a name.");
    const type = body.type || "node";
    if (!SITE_TYPES.includes(type)) throw httpError(400, `Website type must be one of: ${SITE_TYPES.join(", ")}.`);

    const domains = normalizeDomains(body.domains);
    assertDomainsFree(domains);
    const loadBalanced = !!body.loadBalanced;
    const serverIds = validatePlacement(loadBalanced, body.serverIds ?? body.serverId);
    const lbMethod = body.lbMethod || "round_robin";
    if (!LB_METHODS.includes(lbMethod)) throw httpError(400, `Load-balancing method must be one of: ${LB_METHODS.join(", ")}.`);
    const port = body.port != null && body.port !== "" ? validatePort(body.port) : allocatePort();

    const taken = db.list("sites", { projectId: project.id }).map((s) => s.slug);
    const base = slugify(name) || "site";
    let slug = base;
    for (let n = 2; taken.includes(slug); n++) slug = `${base}-${n}`;

    let appDir = body.appDir || body.settings?.appDir;
    if (appDir) appDir = validateAppDir(appDir);
    else {
      const root = `${SITES_DIR()}/${project.slug || slugify(project.name) || project.id}`;
      appDir = `${root}/${slug}`;
      for (let n = 2; db.list("sites").some((s) => s.appDir === appDir || s.appDir?.startsWith(appDir + "/")); n++) appDir = `${root}/${slug}-${n}`;
    }

    const settings = sanitizeSettings(body.settings, defaultSiteSettings(type));
    const healthPath = body.healthPath !== undefined ? sanitizeHealthPath(body.healthPath) : type === "node" ? "/api/health" : "";
    const site = {
      id: newId("site"),
      projectId: project.id,
      name,
      slug,
      type,
      domains,
      port,
      appDir,
      loadBalanced,
      serverIds,
      lbMethod,
      healthPath,
      settings,
      github: sanitizeGithub(body.github),
      env: sanitizeEnv(body.env),
      linkedDatabaseIds: validateLinkedDatabases(body.linkedDatabaseIds, project.id),
      ssl: { enabled: false, status: "none", issuedAt: null, error: null },
      currentReleaseId: null,
      previousReleaseId: null,
      state: {},
      createdAt: now(),
    };
    db.insert("sites", site);
    audit(admin, "site.create", site, { type, domains, loadBalanced, serverIds });
    emit(site);
    return publicSite(site);
  });

  // ---- edit

  router.patch("/api/sites/:id", async (req, res, { params, body, admin }) => {
    const site = mustSite(params.id);
    const b = body || {};
    const patch = {};
    const deployed = !!site.currentReleaseId || Object.values(site.state || {}).some((s) => s?.releaseId);

    if ("name" in b) {
      const name = String(b.name || "").trim().slice(0, 60);
      if (!name) throw httpError(400, "A website needs a name.");
      patch.name = name;
    }
    if ("type" in b && b.type !== site.type) {
      if (!SITE_TYPES.includes(b.type)) throw httpError(400, `Website type must be one of: ${SITE_TYPES.join(", ")}.`);
      if (deployed) throw httpError(409, "The type of a website cannot change after it has been deployed. Create a new website instead.");
      patch.type = b.type;
      patch.settings = sanitizeSettings(b.settings, defaultSiteSettings(b.type));
    }
    if ("appDir" in b && b.appDir !== site.appDir) {
      if (deployed) throw httpError(409, "The app directory cannot change after the website has been deployed.");
      patch.appDir = validateAppDir(b.appDir, site.id);
    }
    if ("domains" in b) {
      patch.domains = normalizeDomains(b.domains);
      assertDomainsFree(patch.domains, site.id);
    }
    if ("lbMethod" in b) {
      if (!LB_METHODS.includes(b.lbMethod)) throw httpError(400, `Load-balancing method must be one of: ${LB_METHODS.join(", ")}.`);
      patch.lbMethod = b.lbMethod;
    }
    if ("port" in b && +b.port !== +site.port) patch.port = validatePort(b.port, site.id);
    if ("healthPath" in b) patch.healthPath = sanitizeHealthPath(b.healthPath);
    if ("settings" in b && !patch.settings) {
      patch.settings = sanitizeSettings(b.settings, { ...defaultSiteSettings(site.type), ...(site.settings || {}) });
    }
    if ("github" in b) patch.github = sanitizeGithub(b.github, site.github || {});
    if ("env" in b) patch.env = sanitizeEnv(b.env);
    if ("linkedDatabaseIds" in b) patch.linkedDatabaseIds = validateLinkedDatabases(b.linkedDatabaseIds, site.projectId);
    if ("loadBalanced" in b || "serverIds" in b || "serverId" in b) {
      const lb = "loadBalanced" in b ? !!b.loadBalanced : !!site.loadBalanced;
      let ids = b.serverIds ?? (b.serverId ? [b.serverId] : site.serverIds);
      // Turning LB off without choosing: keep the first server.
      if (!lb && site.loadBalanced && !("serverIds" in b) && !("serverId" in b)) ids = [targets(site)[0]];
      patch.loadBalanced = lb;
      patch.serverIds = validatePlacement(lb, ids, targets(site));
    }

    const before = targets(site);
    const after = targets({ ...site, ...patch });
    const added = after.filter((x) => !before.includes(x));
    const removed = before.filter((x) => !after.includes(x));
    const changed = (k) => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(site[k]);
    const portChanged = changed("port");
    const frontDoorChanged = changed("domains") || changed("lbMethod") || changed("loadBalanced") || added.length || removed.length || portChanged;
    const envChanged = changed("env") || changed("linkedDatabaseIds");
    const needsJob = deployed && (frontDoorChanged || envChanged);
    if (needsJob) assertIdle(site.id);

    const updated = db.update("sites", site.id, patch);
    const changedKeys = Object.keys(patch).filter(changed);
    if (changedKeys.length) audit(admin, "site.update", updated, { fields: changedKeys, added, removed });
    emit(updated);

    let job = null;
    if (needsJob) {
      const base = panelBase(req);
      const removeFiles = !!b.removeFilesFromOldServers;
      job = siteJob(updated, admin, { type: "site.reconfigure", title: `Apply changes to ${updated.name}` }, async ({ log, signal }) => {
        const cur = getSite(site.id);
        const rel = cur.currentReleaseId ? db.get("releases", cur.currentReleaseId) : null;
        // 1. New servers (and, on a port change, all servers) get the current release first.
        const deployToIds = portChanged ? targets(cur) : added;
        if (deployToIds.length) {
          if (!rel || !fs.existsSync(releaseFile(rel.id))) {
            throw new Error("The current release archive is missing, so it cannot be put on the new server(s). Deploy a release first.");
          }
          log(`Putting ${releaseLabel(rel.id)} on ${deployToIds.map(serverName).join(", ")}…`);
          await deployTo(site.id, rel, deployToIds, { log, signal, base, multi: deployToIds.length > 1 });
        } else if (envChanged) {
          log("Environment changed — writing it to every server and restarting.");
          for (const sid of targets(cur)) {
            assertOnline(sid);
            const spec = await specForAsync(cur, sid);
            await runTask(sid, "site.env", { spec, env: spec.env }, { log: prefixed(log, sid, targets(cur).length > 1), signal });
          }
          if (cur.type === "node") await fanOut(site.id, "site.restart", { log, signal, stopOnError: true });
        }
        // 2. The front door now points at the new set of servers.
        if (frontDoorChanged) await syncLb(site.id, log);
        // 3. Only then take the site off the servers it left.
        const warnings = [];
        for (const sid of removed) {
          log(`── ${serverName(sid)}: removing the website${removeFiles ? " and its files" : ""}`);
          try {
            assertOnline(sid);
            const spec = await specForAsync(getSite(site.id), sid);
            await runTask(sid, "site.remove", { spec, deleteFiles: removeFiles }, { log: prefixed(log, sid, true), signal });
            log(`✓ removed from ${serverName(sid)}.`);
          } catch (err) {
            warnings.push(`${serverName(sid)}: ${err.message}`);
            log(`!! could not remove it from ${serverName(sid)}: ${err.message} (it no longer receives traffic)`);
          }
        }
        if (removed.length) dropServerState(site.id, removed);
        emit(site.id);
        return { added, removed, warnings };
      });
    }
    return { ...publicSite(getSite(site.id)), job };
  });

  // ---- delete

  router.delete("/api/sites/:id", async (req, res, { params, query, admin }) => {
    const site = mustSite(params.id);
    assertIdle(site.id);
    const deleteFiles = query.deleteFiles === "1" || query.deleteFiles === "true";
    const job = siteJob(site, admin, { type: "site.delete", title: `Delete ${site.name}` }, async ({ log, signal }) => {
      const cur = getSite(site.id);
      const servers = [...new Set([...targets(cur), ...Object.keys(cur.state || {})])];
      for (const sid of servers) {
        log(`── ${serverName(sid)}: removing the website${deleteFiles ? " and its files" : ""}`);
        try {
          if (!getServer(sid)) {
            log("   (that server no longer exists — skipped)");
            continue;
          }
          assertOnline(sid);
          const spec = await specForAsync(cur, sid);
          await runTask(sid, "site.remove", { spec, deleteFiles }, { log: prefixed(log, sid, true), signal });
          log(`✓ removed from ${serverName(sid)}.`);
        } catch (err) {
          log(`!! ${serverName(sid)}: ${err.message} — carrying on.`);
        }
      }
      if (ctx.lb?.removeSite) {
        try {
          await ctx.lb.removeSite(cur);
          log("✓ front door (nginx) entry removed.");
        } catch (err) {
          log(`!! removing the nginx entry failed: ${err.message}`);
        }
      }
      const rels = listReleases(site.id);
      for (const r of rels) deleteReleaseRecord(r);
      log(`Deleted ${rels.length} release archive${rels.length === 1 ? "" : "s"}.`);
      db.remove("sites", site.id);
      busy.delete(site.id);
      try {
        ctx.events?.broadcast?.("site", { id: site.id, projectId: site.projectId, deleted: true });
      } catch {
        /* ignore */
      }
      return { deleted: site.id };
    });
    db.update("sites", site.id, { deleting: true });
    audit(admin, "site.delete", site, { deleteFiles });
    return job;
  });

  // ---- operations

  router.post("/api/sites/:id/deploy", async (req, res, { params, body, admin }) => {
    const site = mustSite(params.id);
    const release = body.releaseId ? db.get("releases", body.releaseId) : listReleases(site.id)[0];
    if (!release || release.siteId !== site.id) {
      throw httpError(body.releaseId ? 404 : 409, body.releaseId ? "Release not found." : "This website has no releases yet. Upload a zip or pull from GitHub first.");
    }
    if (!fs.existsSync(releaseFile(release.id))) throw httpError(409, "That release's archive is missing.");
    const base = panelBase(req);
    const job = siteJob(site, admin, { type: "site.deploy", title: `Deploy ${site.name} ${release.version ? `v${release.version}` : release.id}` }, ({ log, signal }) =>
      deployRelease(site.id, release, { log, signal, base }),
    );
    audit(admin, "site.deploy", site, { releaseId: release.id, version: release.version });
    return job;
  });

  for (const op of ["restart", "stop", "start"]) {
    router.post(`/api/sites/:id/${op}`, async (req, res, { params, admin }) => {
      const site = mustSite(params.id);
      const verb = op[0].toUpperCase() + op.slice(1);
      const job = siteJob(site, admin, { type: `site.${op}`, title: `${verb} ${site.name}` }, ({ log, signal }) =>
        fanOut(site.id, `site.${op}`, { log, signal, stopOnError: op === "restart" }),
      );
      audit(admin, `site.${op}`, site);
      return job;
    });
  }

  router.post("/api/sites/:id/rollback", async (req, res, { params, body, admin }) => {
    const site = mustSite(params.id);
    const base = panelBase(req);
    if (body.releaseId) {
      const rel = db.get("releases", body.releaseId);
      if (!rel || rel.siteId !== site.id) throw httpError(404, "Release not found.");
      if (!fs.existsSync(releaseFile(rel.id))) throw httpError(409, "That release's archive is missing.");
      const job = siteJob(site, admin, { type: "site.rollback", title: `Roll ${site.name} back to ${rel.version ? `v${rel.version}` : rel.id}` }, ({ log, signal }) =>
        deployRelease(site.id, rel, { log, signal, base }),
      );
      audit(admin, "site.rollback", site, { releaseId: rel.id });
      return job;
    }
    if (!site.previousReleaseId) throw httpError(409, "There is no previous release to roll back to.");
    const prevId = site.previousReleaseId;
    const job = siteJob(site, admin, { type: "site.rollback", title: `Roll back ${site.name}` }, async ({ log, signal }) => {
      const cur = getSite(site.id);
      const prev = db.get("releases", prevId);
      const ids = targets(cur);
      const multi = ids.length > 1;
      log(`Rolling back to ${releaseLabel(prevId)} on ${ids.map(serverName).join(", ")}${multi ? " — one server at a time" : ""}.`);
      for (const sid of ids) {
        if (signal?.aborted) throw new Error("Cancelled.");
        log(`── ${serverName(sid)}`);
        assertOnline(sid);
        try {
          const spec = await specForAsync(getSite(site.id), sid);
          const res = await runTask(sid, "site.rollback", { spec }, { log: prefixed(log, sid, multi), signal });
          setServerState(site.id, sid, { ...stateFromResult(cur, res), releaseId: prevId });
          log(`✓ ${serverName(sid)} restored from its snapshot.`);
        } catch (err) {
          if (!prev || !fs.existsSync(releaseFile(prevId))) throw new Error(`Rollback failed on ${serverName(sid)}: ${err.message}`);
          log(`!! snapshot rollback failed (${err.message}) — redeploying ${releaseLabel(prevId)} instead.`);
          await deployTo(site.id, prev, [sid], { log, signal, base, multi });
        }
      }
      const now2 = getSite(site.id);
      db.update("sites", site.id, { currentReleaseId: prevId, previousReleaseId: now2.currentReleaseId || null });
      await syncLb(site.id, log);
      emit(site.id);
      return { releaseId: prevId, servers: ids };
    });
    audit(admin, "site.rollback", site, { releaseId: prevId });
    return job;
  });

  router.get("/api/sites/:id/status", async (req, res, { params }) => {
    const site = mustSite(params.id);
    return refreshStatus(site.id);
  });

  router.get("/api/sites/:id/logs", async (req, res, { params, query }) => {
    const site = mustSite(params.id);
    const ids = targets(site);
    const sid = query.serverId || ids[0];
    if (!ids.includes(sid)) throw httpError(400, "That server does not run this website.");
    if (!isOnline(sid)) throw httpError(409, `${serverName(sid)} is offline.`);
    const lines = clamp(parseInt(query.lines, 10) || 200, 1, 2000);
    const t = withTimeout(null, 30_000);
    try {
      const spec = await specForAsync(site, sid);
      const out = await runTask(sid, "site.logs", { spec, lines }, { log: () => {}, signal: t.signal });
      return { serverId: sid, lines, text: typeof out === "string" ? out : out?.text ?? "" };
    } catch (err) {
      throw httpError(502, t.signal.aborted ? "Reading the logs timed out." : err.message);
    } finally {
      t.done();
    }
  });

  // ---- environment

  async function envView(site) {
    const linked = await linkedEnvAsync(site, targets(site)[0]);
    return {
      env: site.env || {},
      linked: linked.sources.map((s) => ({ ...s, vars: maskEnv(s.vars), keys: Object.keys(s.vars) })),
      reserved: [...RESERVED_ENV],
    };
  }

  router.get("/api/sites/:id/env", async (req, res, { params }) => envView(mustSite(params.id)));

  router.put("/api/sites/:id/env", async (req, res, { params, body, admin }) => {
    const site = mustSite(params.id);
    let input = body.env;
    if (input == null && typeof body.text === "string") {
      const parsed = parseEnvText(body.text);
      if (parsed.errors.length) throw httpError(400, `Line ${parsed.errors[0].line}: ${parsed.errors[0].error}`, { errors: parsed.errors });
      input = parsed.env;
    }
    const env = sanitizeEnv(input || {});
    const linked = await linkedEnvAsync(site, targets(site)[0]);
    const warnings = [];
    for (const k of Object.keys(env)) {
      if (k in linked.env) {
        delete env[k];
        warnings.push(`${k} comes from a linked database and was not saved here.`);
      }
    }
    if (input && "PORT" in input) warnings.push("PORT is set by the panel and was not saved.");
    db.update("sites", site.id, { env });
    audit(admin, "site.env", site, { keys: Object.keys(env).length });
    emit(site.id);
    const fresh = getSite(site.id);
    const deployed = !!fresh.currentReleaseId || Object.values(fresh.state || {}).some((s) => s?.releaseId);
    const job = deployed ? startEnvJob(fresh, admin, { restart: body.restart !== false }) : null;
    return { ...(await envView(fresh)), warnings, job };
  });

  // ---- releases

  router.get("/api/sites/:id/releases", async (req, res, { params }) => {
    const site = mustSite(params.id);
    return { items: listReleases(site.id).map((r) => publicRelease(r, site)) };
  });

  router.post("/api/sites/:id/releases/upload", { raw: true }, async (req, res, { params, query, admin }) => {
    const site = mustSite(params.id);
    req.res = res;
    const rec = await receiveUpload(req, site.id, cleanFilename(query.filename), admin);
    audit(admin, "release.upload", site, { releaseId: rec.id, version: rec.version, size: rec.size });
    return publicRelease(rec);
  });

  router.post("/api/sites/:id/releases/github", async (req, res, { params, body, admin }) => {
    const site = mustSite(params.id);
    const repo = normalizeRepo(body.repo || site.github?.repo);
    if (!repo) throw httpError(400, "This website has no GitHub repository set. Add one in its settings first.");
    const ref = cleanRef(body.ref);
    if (ref === null) throw httpError(400, "That branch, tag or commit name is not valid.");
    const deploy = !!body.deploy;
    const base = panelBase(req);
    const token = githubToken(site);
    const job = siteJob(
      site,
      admin,
      { type: "site.github", title: `Pull ${repo}${ref ? `@${ref}` : ""} for ${site.name}${deploy ? " and deploy" : ""}` },
      async ({ log, signal }) => {
        let useRef = ref || getSite(site.id)?.github?.branch || "";
        if (!useRef) {
          const info = await repoInfo(repo, token, { signal });
          useRef = info.defaultBranch;
          log(`Using the default branch: ${useRef}`);
        }
        const commit = await resolveCommit(repo, useRef, token, { signal });
        if (commit) log(`${repo}@${useRef} is at ${commit.shortSha}: ${commit.message}${commit.author ? ` — ${commit.author}` : ""}`);
        const part = path.join(releasesDir(), `.github-${crypto.randomBytes(6).toString("hex")}.part`);
        log("Downloading the archive from GitHub…");
        const { size, sha256 } = await downloadZipballToFile(repo, commit?.sha || useRef, token, part, {
          signal,
          maxBytes: MAX_RELEASE_BYTES,
          onProgress: (n) => log(`  … ${humanBytes(n)}`),
        });
        log(`Downloaded ${humanBytes(size)}.`);
        const rec = finalizeRelease(site.id, part, {
          filename: `${repo.split("/")[1]}-${commit?.shortSha || slugify(useRef) || "head"}.zip`,
          source: "github",
          size,
          sha256,
          commit: commit?.sha || null,
          github: { repo, ref: useRef, sha: commit?.sha || null, message: commit?.message || "", author: commit?.author || null, htmlUrl: commit?.htmlUrl || `https://github.com/${repo}` },
          adminId: admin?.id || null,
        });
        log(`Release ${rec.id} created (${rec.version ? `v${rec.version}` : "unversioned"}).`);
        for (const w of rec.warnings) log(`note: ${w}`);
        if (!deploy) return { releaseId: rec.id, version: rec.version };
        const out = await deployRelease(site.id, rec, { log, signal, base });
        return { ...out, releaseId: rec.id };
      },
      { lock: deploy },
    );
    audit(admin, "release.github", site, { repo, ref: ref || null, deploy });
    return job;
  });

  router.patch("/api/releases/:id", async (req, res, { params, body, admin }) => {
    const rel = db.get("releases", params.id);
    const site = rel && getSite(rel.siteId);
    if (!rel || !site) throw httpError(404, "Release not found.");
    const patch = {};
    if ("pinned" in body) patch.pinned = !!body.pinned;
    if ("note" in body) patch.note = String(body.note || "").slice(0, 500);
    db.update("releases", rel.id, patch);
    if ("pinned" in patch) audit(admin, patch.pinned ? "release.pin" : "release.unpin", site, { releaseId: rel.id });
    pruneReleases(site.id);
    emit(site.id);
    return publicRelease(db.get("releases", rel.id), site);
  });

  router.delete("/api/releases/:id", async (req, res, { params, admin }) => {
    const rel = db.get("releases", params.id);
    const site = rel && getSite(rel.siteId);
    if (!rel || !site) throw httpError(404, "Release not found.");
    if (site.currentReleaseId === rel.id) throw httpError(409, "That is the release the website is running. Deploy another one first.");
    const onServer = Object.entries(site.state || {}).find(([sid, st]) => st?.releaseId === rel.id && targets(site).includes(sid));
    if (onServer) throw httpError(409, `${serverName(onServer[0])} is still running that release.`);
    deleteReleaseRecord(rel);
    if (site.previousReleaseId === rel.id) db.update("sites", site.id, { previousReleaseId: null });
    audit(admin, "release.delete", site, { releaseId: rel.id, version: rel.version });
    emit(site.id);
    return { ok: true };
  });

  // ---- GitHub helpers

  router.get("/api/github/refs", async (req, res, { query }) => {
    const site = query.siteId ? getSite(query.siteId) : null;
    const repo = normalizeRepo(query.repo || site?.github?.repo);
    if (!repo) throw httpError(400, "Give a repository as owner/name or a GitHub URL.");
    try {
      return await listRefs(repo, githubToken(site));
    } catch (err) {
      throw httpError(502, err.message);
    }
  });

  // ---- agent download

  router.get("/agent/releases/:id", { agent: true }, async (req, res, { params, query }) => {
    const id = params.id;
    if (!/^[\w-]{1,80}$/.test(id)) throw httpError(404, "Release not found.");
    const rel = db.get("releases", id);
    if (!rel) throw httpError(404, "Release not found.");
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "")?.[1]?.trim();
    let allowed = verifyDownloadToken(id, query.token) || verifyDownloadToken(id, bearer);
    if (!allowed) {
      const node = ctx.cluster?.authenticateNode ? await ctx.cluster.authenticateNode(req) : null;
      if (!node) throw httpError(401, "Not authorised.");
      const site = getSite(rel.siteId);
      allowed = node.id === MAIN() || (site && (targets(site).includes(node.id) || node.id in (site.state || {})));
      if (!allowed) throw httpError(403, "This server does not host that website.");
    }
    const file = releaseFile(id);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      throw httpError(404, "The release archive is missing.");
    }
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Length": st.size,
      "Content-Disposition": `attachment; filename="${id}.zip"`,
      "Cache-Control": "no-store",
      "X-Release-Sha256": rel.sha256 || "",
    });
    if (req.method === "HEAD") return void res.end();
    await pipeline(fs.createReadStream(file), res);
  });
}

// ----------------------------------------------------------------- timers

export async function start(ctx) {
  const dir = path.join(ctx.dataDir, "releases");
  // Leftovers from uploads/downloads interrupted by a restart.
  try {
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".part")) fs.rmSync(path.join(dir, f), { force: true });
  } catch {
    /* no releases dir yet */
  }
  // Keep per-server status fresh for deployed sites.
  let running = false;
  const timer = setInterval(async () => {
    if (running || !ctx.sites?.refreshStatus) return;
    running = true;
    try {
      for (const s of ctx.sites.list({})) {
        if (!s.currentReleaseId || s.deleting) continue;
        await ctx.sites.refreshStatus(s.id).catch(() => {});
      }
    } finally {
      running = false;
    }
  }, STATUS_EVERY_MS);
  timer.unref?.();
}
