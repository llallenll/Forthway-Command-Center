/**
 * Updating the panel itself ("Check for updates", ported from v2 hub/lib/updates.mjs).
 *
 * Every other module updates something else; this one replaces the code that is
 * running, so a bad write takes away the tool you would use to fix it. The
 * order is deliberate and mirrors install.sh:
 *
 *   1. ask GitHub for the newest commit on the install's repo@ref (version.json),
 *      and what changed since the installed commit (compare API);
 *   2. download the tarball of exactly that commit, check it really is the
 *      Standalone panel (panel/server.mjs + shared/), `node --check` it;
 *   3. back up the installed code dirs to dataDir/update-backups/<id> (last 3 kept);
 *   4. swap the staged dirs in by rename (same filesystem), write version.json;
 *   5. restart: under systemd the process exits after the job has finished and
 *      its log reached the browsers (Restart=always brings it back); otherwise
 *      the admin is told to restart.
 *
 * Only the code items install.sh copies are touched (panel node shared scripts
 * patches README.md install.sh LICENSE + version.json) — never the data dir,
 * /etc/fcc or the websites.
 *
 * Development (FCC_DRY_RUN=1, or the panel running from a git checkout): the
 * check is real (read-only), the download/verify/backup run against the data
 * dir, but the working copy is never written — the swap, version.json and the
 * restart are only logged.
 *
 * GitHub rate limits (60 req/h per IP without a token): a check costs 2 API
 * calls (commit + compare; the version string comes from raw.githubusercontent,
 * which is not rate limited). Checks run 30 s after boot and every 6 h, on page
 * load (skipped when the last one is < 10 min old) and on the button (≥ 20 s
 * apart). A rate-limit answer pauses all checks until GitHub's reset time.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile, execFileSync } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { httpError } from "./http.mjs";

export const DEFAULT_REPO = "llallenll/Forthway-Command-Center";
export const DEFAULT_REF = "standalone";

const API = "https://api.github.com";
const UA = "forthway-command-center";
const CHECK_EVERY_MS = 6 * 60 * 60_000;
const FIRST_CHECK_MS = 30_000;
const PAGELOAD_COOLDOWN_MS = 10 * 60_000;
const FORCE_FLOOR_MS = 20_000;
const KEEP_BACKUPS = 3;
const MAX_TARBALL = 300 * 1024 * 1024;
const MAX_CHANGES = 100;
const RESTART_DELAY_MS = 2000;

/** What install.sh copies into FCC_DIR (CODE_ITEMS) — the only things an update replaces. */
const CODE_ITEMS = ["panel", "node", "shared", "scripts", "patches", "README.md", "install.sh", "LICENSE"];
/** Backed up and restored together with the code. */
const BACKUP_ITEMS = [...CODE_ITEMS, "version.json"];
/** Parsed with `node --check` in the staged copy before anything is swapped. */
const SYNTAX_CHECK = ["panel/server.mjs", "panel/lib/core-routes.mjs", "panel/lib/updates.mjs"];
const COPY_SKIP = new Set([".DS_Store", ".devdata", "node_modules", ".git"]);

const BOOT_ID = crypto.randomBytes(8).toString("hex");

// ------------------------------------------------------------- helpers

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch { /* best effort */ }
}

const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Recursive copy keeping modes and symlinks (no fs.cp — still experimental on Node 18). */
function copyTree(src, dst) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), dst);
  } else if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true, mode: st.mode & 0o777 });
    for (const name of fs.readdirSync(src)) {
      if (COPY_SKIP.has(name)) continue;
      copyTree(path.join(src, name), path.join(dst, name));
    }
  } else if (st.isFile()) {
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, st.mode & 0o777);
  }
}

function dirSize(p) {
  let total = 0;
  try {
    const st = fs.lstatSync(p);
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) total += dirSize(path.join(p, n));
    else total += st.size;
  } catch { /* gone */ }
  return total;
}

function humanBytes(n) {
  if (!Number.isFinite(n)) return "?";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** Run a program for real (sys.run is a no-op under DRY_RUN; these steps only read). */
function runReal(cmd, args, { cwd, log, signal, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, signal }, (err, stdout, stderr) => {
      const out = `${stdout || ""}${stderr || ""}`.trim();
      if (out && log) for (const l of out.split("\n").slice(-20)) log(`  ${l}`);
      if (err) {
        const e = new Error(`${path.basename(cmd)} ${args.join(" ")} failed${out ? `: ${out.split("\n").slice(-3).join(" ")}` : ` (${err.message})`}`);
        return reject(e);
      }
      resolve({ stdout, stderr });
    });
    child.stdin?.end();
  });
}

/** 1.2.10 vs 1.2.9 the way a person reads them. */
export function compareVersions(a, b) {
  const parse = (v) => String(v || "").replace(/^v/i, "").split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? +x : x));
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i];
    const y = B[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") return x > y ? 1 : -1;
    return String(x) > String(y) ? 1 : -1;
  }
  return 0;
}

function versionFromSource(src) {
  return /(?:^|\n)\s*const\s+(?:FCC_)?VERSION\s*=\s*"([^"]+)"/.exec(String(src || ""))?.[1] || null;
}

const firstLine = (s, n = 200) => String(s || "").split("\n")[0].slice(0, n);

// ------------------------------------------------------------- module

let state = null; // set by register()

export function register(router, ctx) {
  const root = ctx.rootDir;
  const stateFile = path.join(ctx.dataDir, "updates-state.json");
  const backupsRoot = path.join(ctx.dataDir, "update-backups");

  const s = (state = {
    last: null, // { latest, changes, totalChanges, compareStatus, compareUrl, checkedAt, checkedFor, repo, ref, error, reason, available }
    lastAttemptAt: 0,
    inflight: null,
    rateLimitedUntil: 0,
    restart: null, // { pending, mode, at, by }
    timers: [],
  });

  // ---- identity -----------------------------------------------------------

  function gitHead() {
    try {
      const gitDir = path.join(root, ".git");
      if (!exists(gitDir)) return null;
      const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
      const m = /^ref:\s*(.+)$/.exec(head);
      if (!m) return /^[0-9a-f]{40}$/i.test(head) ? { sha: head, ref: null } : null;
      const ref = m[1];
      const short = ref.replace(/^refs\/heads\//, "");
      const loose = path.join(gitDir, ref);
      if (exists(loose)) return { sha: fs.readFileSync(loose, "utf8").trim(), ref: short };
      const packed = path.join(gitDir, "packed-refs");
      if (exists(packed)) {
        for (const line of fs.readFileSync(packed, "utf8").split("\n")) {
          const [sha, name] = line.trim().split(/\s+/);
          if (name === ref) return { sha, ref: short };
        }
      }
      return { sha: null, ref: short };
    } catch {
      return null;
    }
  }

  const isGitCheckout = () => exists(path.join(root, ".git"));

  /** Why apply/restore only pretend here (null = they run for real). */
  function simulateReason() {
    if (ctx.sys?.DRY_RUN) return "dry-run";
    if (isGitCheckout()) return "git-checkout";
    return null;
  }

  /**
   * What is installed. version.json is a record of what was downloaded; the
   * compiled-in VERSION is what is actually running. If they disagree the
   * stamp describes code that is not here, and its commit is dropped with it.
   */
  function installed() {
    const stamp = readJson(path.join(root, "version.json"), null);
    const git = gitHead();
    const running = ctx.version || null;
    const stale = !!(stamp?.version && running && stamp.version !== running);
    const commit = (stale ? null : stamp?.commit || stamp?.sha) || git?.sha || null;
    return {
      version: running,
      commit,
      shortCommit: commit ? commit.slice(0, 7) : null,
      repo: (!stale && stamp?.repo) || null,
      ref: (!stale && stamp?.ref) || null,
      installedAt: (!stale && stamp?.installedAt) || null,
      source: stale ? "mismatch" : stamp?.commit || stamp?.sha ? stamp.source || "version.json" : git?.sha ? "git" : "unknown",
      stale,
      gitRef: git?.ref || null,
    };
  }

  function target() {
    const inst = installed();
    const cfg = ctx.config.updates || {};
    const repo = inst.repo || cfg.repo || DEFAULT_REPO;
    const ref = inst.ref || cfg.ref || DEFAULT_REF;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw httpError(400, `Update repository "${repo}" does not look like owner/repo.`);
    if (!/^[\w./@+-]{1,200}$/.test(ref) || ref.includes("..")) throw httpError(400, `Update ref "${ref}" has unexpected characters.`);
    return { repo, ref, inst };
  }

  function githubToken() {
    const g = ctx.config.github || {};
    for (const v of [g.tokenEnc, g.token]) {
      if (!v) continue;
      try {
        return ctx.secrets.isEncrypted?.(v) || v === g.tokenEnc ? ctx.secrets.decrypt(v) : String(v).trim();
      } catch {
        /* wrong key / tampered — try the next one */
      }
    }
    return "";
  }

  function restartMode() {
    if (simulateReason()) return "simulated";
    if (process.env.INVOCATION_ID) return "systemd";
    try {
      if (systemctlActive()) return "service";
    } catch { /* no systemctl */ }
    return "manual";
  }

  // `systemctl is-active fcc` (sync, cheap) — only when not obviously under systemd.
  let systemctlCache = null;
  function systemctlActive() {
    if (systemctlCache && Date.now() - systemctlCache.at < 60_000) return systemctlCache.active;
    let active = false;
    try {
      const r = execFileSync("systemctl", ["is-active", "fcc"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      active = r.trim() === "active";
    } catch {
      active = false;
    }
    systemctlCache = { at: Date.now(), active };
    return active;
  }

  // ---- GitHub ---------------------------------------------------------------

  async function gh(pathname, token, { accept = "application/vnd.github+json", text = false, timeoutMs = 20_000, signal } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const headers = { Accept: accept, "User-Agent": UA, "X-GitHub-Api-Version": "2022-11-28" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const url = pathname.startsWith("https://") ? pathname : `${API}${pathname}`;
      const res = await fetch(url, { headers, signal: ctrl.signal });
      const body = await res.text();
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          msg = JSON.parse(body).message || msg;
        } catch { /* not json */ }
        const remaining = res.headers.get("x-ratelimit-remaining");
        if ((res.status === 403 || res.status === 429) && (remaining === "0" || /rate limit/i.test(msg))) {
          const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
          s.rateLimitedUntil = reset > Date.now() ? reset : Date.now() + 15 * 60_000;
          const e = new Error(
            token
              ? `GitHub rate limit reached for the panel's token — checks resume after ${new Date(s.rateLimitedUntil).toLocaleTimeString()}.`
              : `GitHub rate limit reached (60 requests an hour without a token). Checks resume after ${new Date(s.rateLimitedUntil).toLocaleTimeString()}; adding a GitHub token in Settings → GitHub raises the limit.`,
          );
          e.rateLimited = true;
          throw e;
        }
        const e = new Error(
          res.status === 404
            ? `GitHub says ${pathname.split("?")[0]} does not exist${token ? "" : " (or it is private — add a token in Settings → GitHub)"}.`
            : res.status === 401
              ? "GitHub rejected the panel's token (401). Replace it in Settings → GitHub."
              : `GitHub error ${res.status}: ${msg}`,
        );
        e.status = res.status;
        throw e;
      }
      if (text) return body;
      return JSON.parse(body);
    } catch (err) {
      if (err.name === "AbortError") throw new Error(signal?.aborted ? "Cancelled." : "GitHub did not answer in time.");
      throw err;
    } finally {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function latestCommit(repo, ref, token, opts) {
    const c = await gh(`/repos/${repo}/commits/${encodeURIComponent(ref)}`, token, opts);
    return {
      commit: c.sha,
      shortCommit: c.sha.slice(0, 7),
      message: firstLine(c.commit?.message),
      author: c.commit?.author?.name || c.author?.login || null,
      date: c.commit?.committer?.date || c.commit?.author?.date || null,
      url: c.html_url || `https://github.com/${repo}/commit/${c.sha}`,
    };
  }

  /** The VERSION constant at that commit (raw.githubusercontent is not API-rate-limited). */
  async function versionAt(repo, sha, token) {
    try {
      const src = await gh(`https://raw.githubusercontent.com/${repo}/${sha}/panel/server.mjs`, token, { accept: "text/plain", text: true, timeoutMs: 15_000 });
      return versionFromSource(src);
    } catch (err) {
      if (err.rateLimited) throw err;
      return null;
    }
  }

  // ---- check ----------------------------------------------------------------

  function decide(inst, latest, cmp) {
    if (!latest) return { available: null, reason: "Not checked yet." };
    if (inst.stale) {
      return {
        available: true,
        reason: `version.json records a different version than the running code (${inst.version}) — re-applying the update fixes the record.`,
      };
    }
    if (inst.commit && latest.commit) {
      if (inst.commit === latest.commit) return { available: false, reason: "Running the newest commit." };
      if (cmp) {
        if (cmp.status === "identical") return { available: false, reason: "Running the newest commit." };
        if (cmp.status === "behind") return { available: false, reason: "This install is newer than the branch on GitHub." };
        if (cmp.aheadBy > 0) {
          return {
            available: true,
            reason: cmp.status === "diverged"
              ? `GitHub has ${cmp.aheadBy} new commit(s); this install also has ${cmp.behindBy} commit(s) GitHub doesn't (they would be replaced).`
              : `GitHub has ${cmp.aheadBy} new commit(s).`,
          };
        }
        return { available: false, reason: "Nothing new on GitHub." };
      }
      return {
        available: true,
        reason: "GitHub's branch is at a different commit, and GitHub does not know the installed one (a local build?), so the changes can't be listed.",
      };
    }
    if (inst.version && latest.version) {
      const c = compareVersions(latest.version, inst.version);
      if (c > 0) return { available: true, reason: `GitHub has v${latest.version}; this panel runs v${inst.version}.` };
      return {
        available: c < 0 ? false : null,
        reason: "This install has no recorded commit, so only the version number can be compared. Updating once records it.",
      };
    }
    return { available: null, reason: "This install has no recorded commit to compare with. Updating once records it." };
  }

  async function doCheck() {
    const { repo, ref, inst } = target();
    const token = githubToken();
    s.lastAttemptAt = Date.now();
    const checkedAt = new Date().toISOString();
    try {
      const latest = await latestCommit(repo, ref, token);
      const [version, cmp] = await Promise.all([
        versionAt(repo, latest.commit, token),
        inst.commit && inst.commit !== latest.commit
          ? gh(`/repos/${repo}/compare/${inst.commit}...${latest.commit}?per_page=${MAX_CHANGES}`, token)
              .then((c) => ({
                status: c.status,
                aheadBy: c.ahead_by || 0,
                behindBy: c.behind_by || 0,
                url: c.html_url || `https://github.com/${repo}/compare/${inst.commit}...${latest.commit}`,
                commits: (c.commits || []).slice(-MAX_CHANGES).reverse().map((x) => ({
                  sha: x.sha,
                  shortSha: x.sha.slice(0, 7),
                  message: firstLine(x.commit?.message),
                  author: x.commit?.author?.name || x.author?.login || null,
                  date: x.commit?.committer?.date || x.commit?.author?.date || null,
                  url: x.html_url,
                })),
              }))
              .catch((err) => {
                if (err.rateLimited) throw err;
                return null; // 404: GitHub doesn't know the installed commit
              })
          : null,
      ]);
      latest.version = version;
      let d = decide(inst, latest, cmp);
      // GitHub doesn't know the installed commit: in a git checkout, ask git
      // (read-only) whether GitHub's commit is already part of what's here.
      if (!cmp && inst.commit && inst.commit !== latest.commit && isGitCheckout()) {
        const ahead = await runReal("git", ["-C", root, "merge-base", "--is-ancestor", latest.commit, inst.commit], { timeoutMs: 10_000 })
          .then(() => true, () => false);
        if (ahead) d = { available: false, reason: "This checkout already contains GitHub's newest commit (it has local commits on top)." };
      }
      s.last = {
        repo,
        ref,
        latest,
        changes: d.available ? cmp?.commits || [] : [],
        totalChanges: d.available ? cmp?.aheadBy ?? null : 0,
        compareStatus: cmp?.status || (inst.commit === latest.commit ? "identical" : null),
        compareUrl: cmp?.url || null,
        checkedAt,
        checkedFor: inst.commit,
        error: null,
        ...d,
      };
    } catch (err) {
      // A failed check must never read as "you are up to date".
      s.last = {
        ...(s.last && s.last.checkedFor === inst.commit && s.last.repo === repo && s.last.ref === ref ? s.last : { repo, ref, latest: null, changes: [], available: null, reason: "" }),
        checkedAt,
        error: err.message,
      };
    }
    persist();
    ctx.events.broadcast("updates", status());
    return s.last;
  }

  /**
   * force=false: page load / timer — skipped when checked recently.
   * force=true: the button — at most every 20 s. Both pause while rate-limited.
   */
  async function check({ force = false, cooldownMs = PAGELOAD_COOLDOWN_MS } = {}) {
    if (s.inflight) return s.inflight;
    const now = Date.now();
    if (now < s.rateLimitedUntil) return s.last;
    const lastOk = s.last?.checkedAt && !s.last.error ? new Date(s.last.checkedAt).getTime() : 0;
    if (force) {
      if (now - s.lastAttemptAt < FORCE_FLOOR_MS) return s.last;
    } else if (now - Math.max(lastOk, s.lastAttemptAt) < cooldownMs) {
      return s.last;
    }
    s.inflight = doCheck().finally(() => {
      s.inflight = null;
    });
    return s.inflight;
  }

  function persist() {
    try {
      const { latest, changes, totalChanges, compareStatus, compareUrl, checkedAt, checkedFor, repo, ref, error, reason, available } = s.last || {};
      writeJsonAtomic(stateFile, { latest, changes, totalChanges, compareStatus, compareUrl, checkedAt, checkedFor, repo, ref, error, reason, available, rateLimitedUntil: s.rateLimitedUntil || 0 });
    } catch { /* not important */ }
  }

  function restore() {
    const saved = readJson(stateFile, null);
    if (!saved) return;
    s.rateLimitedUntil = Number(saved.rateLimitedUntil) || 0;
    const inst = installed();
    // Only valid for the code that is installed now (an update or restore changes it).
    if (saved.checkedFor !== inst.commit || !saved.latest) return;
    s.last = saved;
  }

  // ---- status ---------------------------------------------------------------

  function activeJob() {
    const j = ["panel.update", "panel.restore"]
      .flatMap((type) => ctx.jobs.list({ type, limit: 5 }))
      .find((x) => x.status === "running" || x.status === "queued");
    return j ? { id: j.id, type: j.type, status: j.status, title: j.title } : null;
  }

  function status() {
    let repo;
    let ref;
    let inst;
    try {
      ({ repo, ref, inst } = target());
    } catch (err) {
      inst = installed();
      repo = inst.repo || DEFAULT_REPO;
      ref = inst.ref || DEFAULT_REF;
    }
    const last = s.last && s.last.repo === repo && s.last.ref === ref ? s.last : null;
    const sim = simulateReason();
    return {
      installed: inst,
      repo,
      ref,
      latest: last?.latest || null,
      available: last ? last.available ?? null : null,
      reason: last?.reason || (last?.error ? "" : "Not checked yet."),
      changes: last?.changes || [],
      totalChanges: last?.totalChanges ?? null,
      compareUrl: last?.compareUrl || null,
      lastCheckedAt: last?.checkedAt || null,
      error: last?.error || null,
      checking: !!s.inflight,
      rateLimitedUntil: s.rateLimitedUntil > Date.now() ? new Date(s.rateLimitedUntil).toISOString() : null,
      tokenSet: !!githubToken(),
      simulate: sim, // "dry-run" | "git-checkout" | null
      restartMode: restartMode(), // systemd | service | manual | simulated
      job: activeJob(),
      restart: s.restart,
      bootId: BOOT_ID,
    };
  }

  // ---- apply / restore --------------------------------------------------------

  function assertSafeLayout() {
    const data = path.resolve(ctx.dataDir);
    for (const item of BACKUP_ITEMS) {
      const p = path.resolve(root, item);
      if (data === p || data.startsWith(p + path.sep)) {
        throw httpError(409, `The data directory (${data}) is inside ${item}/ of the install — refusing to replace it.`);
      }
    }
  }

  function listBackups() {
    let names = [];
    try {
      names = fs.readdirSync(backupsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
    return names
      .sort()
      .reverse()
      .map((id) => {
        const meta = readJson(path.join(backupsRoot, id, "_backup.json"), {}) || {};
        return {
          id,
          takenAt: meta.takenAt || null,
          reason: meta.reason || "update",
          was: meta.was || null,
          updatingTo: meta.updatingTo || null,
          items: meta.items || [],
          size: meta.size ?? null,
          simulated: !!meta.simulated,
          valid: exists(path.join(backupsRoot, id, "panel", "server.mjs")),
        };
      });
  }

  function pruneBackups(log) {
    const all = listBackups();
    for (const b of all.slice(KEEP_BACKUPS)) {
      rmrf(path.join(backupsRoot, b.id));
      log?.(`Removed old backup ${b.id} (keeping the last ${KEEP_BACKUPS}).`);
    }
  }

  function takeBackup({ reason, was, updatingTo, simulated, log }) {
    fs.mkdirSync(backupsRoot, { recursive: true, mode: 0o700 });
    const id = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.join(backupsRoot, id);
    const tmp = `${dir}.partial`;
    rmrf(tmp);
    fs.mkdirSync(tmp, { recursive: true });
    const items = [];
    for (const item of BACKUP_ITEMS) {
      const src = path.join(root, item);
      if (!exists(src)) continue;
      copyTree(src, path.join(tmp, item));
      items.push(item);
    }
    const size = dirSize(tmp);
    writeJsonAtomic(path.join(tmp, "_backup.json"), { id, takenAt: new Date().toISOString(), reason, was, updatingTo, items, size, simulated: !!simulated });
    fs.renameSync(tmp, dir);
    log(`✓ Backed up ${items.join(", ")} (${humanBytes(size)}) to ${dir}`);
    pruneBackups(log);
    return id;
  }

  /**
   * Replace each item present in `stageDir` (rename, same filesystem). On any
   * failure the items already moved are put back. Items missing from the new
   * release are left as they are (same as install.sh).
   */
  function swapIn(stageDir, items, { log }) {
    const oldDir = path.join(root, `.update-old.${Date.now()}`);
    fs.mkdirSync(oldDir, { recursive: true });
    const done = [];
    try {
      for (const item of items) {
        const from = path.join(stageDir, item);
        if (!exists(from)) continue;
        const live = path.join(root, item);
        const had = exists(live);
        if (had) fs.renameSync(live, path.join(oldDir, item));
        done.push({ item, had });
        fs.renameSync(from, live);
      }
    } catch (err) {
      log(`✗ Swap failed (${err.message}) — putting the previous files back.`);
      for (const { item, had } of done.reverse()) {
        try {
          if (exists(path.join(root, item)) && exists(path.join(oldDir, item))) rmrf(path.join(root, item));
          if (had) fs.renameSync(path.join(oldDir, item), path.join(root, item));
          else rmrf(path.join(root, item));
        } catch (e) {
          log(`✗ Could not put ${item} back: ${e.message}. Restore it from the backup.`);
        }
      }
      rmrf(oldDir);
      throw err;
    }
    rmrf(oldDir);
    log(`✓ Replaced ${done.map((d) => d.item).join(", ")}`);
  }

  async function syntaxCheck(dir, { log, signal }) {
    for (const rel of SYNTAX_CHECK) {
      const file = path.join(dir, rel);
      if (!exists(file)) continue;
      await runReal(process.execPath, ["--check", file], { log, signal, timeoutMs: 120_000 });
      log(`✓ node --check ${rel}`);
    }
  }

  async function download(repo, sha, token, file, { log, signal }) {
    // Pinned to the exact commit that was checked. codeload needs no API quota;
    // with a token use the API endpoint (works for private repos, redirects to codeload).
    const url = token ? `${API}/repos/${repo}/tarball/${sha}` : `https://codeload.github.com/${repo}/tar.gz/${sha}`;
    log(`Downloading ${repo}@${sha.slice(0, 7)}…`);
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const t = setTimeout(() => ctrl.abort(), 10 * 60_000);
    try {
      const headers = { "User-Agent": UA };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(url, { headers, signal: ctrl.signal, redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}${res.status === 404 ? " (private repository? add a GitHub token)" : ""}`);
      let size = 0;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          size += chunk.length;
          if (size > MAX_TARBALL) return cb(new Error(`The archive is larger than ${humanBytes(MAX_TARBALL)} — refusing.`));
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(file));
      log(`✓ Downloaded ${humanBytes(size)}`);
      return size;
    } catch (err) {
      if (err.name === "AbortError") throw new Error(signal?.aborted ? "Cancelled." : "The download took too long.");
      throw err;
    } finally {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  function findSourceRoot(dir) {
    if (exists(path.join(dir, "panel", "server.mjs"))) return dir;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory() && exists(path.join(p, "panel", "server.mjs"))) return p;
    }
    return null;
  }

  function scheduleRestart(jobId, by) {
    ctx.jobs.wait(jobId).then((job) => {
      if (job.status !== "succeeded") return;
      const mode = job.result?.restart;
      if (mode !== "systemd" && mode !== "service") return;
      s.restart = { pending: true, mode, at: new Date().toISOString(), by, bootId: BOOT_ID };
      ctx.events.broadcast("updates", { ...status(), restarting: true });
      // Let the job's last log lines, the `job` event and this one reach the browsers.
      setTimeout(() => {
        console.log(`[fcc] panel ${job.type === "panel.restore" ? "restored" : "updated"} — restarting (${mode})`);
        if (mode === "systemd") {
          process.kill(process.pid, "SIGTERM"); // graceful shutdown; Restart=always starts the new code
        } else {
          const child = spawn("systemctl", ["restart", "fcc"], { detached: true, stdio: "ignore" });
          child.on("error", (err) => console.error("[fcc] systemctl restart fcc failed:", err.message));
          child.unref();
        }
      }, RESTART_DELAY_MS);
    }).catch(() => {});
  }

  function restartNote(mode, log) {
    if (mode === "simulated") log("[simulated] The panel would restart now (systemd: exit → Restart=always).");
    else if (mode === "systemd") log("The panel restarts in a moment (systemd brings it back with the new code).");
    else if (mode === "service") log("Restarting fcc.service in a moment (systemctl restart fcc).");
    else log("⚠ Restart the panel to run the new code (it is not running under systemd, so it can't restart itself).");
  }

  function startApply(admin) {
    assertSafeLayout();
    if (activeJob()) throw httpError(409, "An update or restore is already running.", { jobId: activeJob().id });
    const { repo, ref, inst } = target();
    const sim = simulateReason();
    const token = githubToken();

    const job = ctx.jobs.start(
      { type: "panel.update", title: `Update panel from ${repo}@${ref}`, adminId: admin?.id || null, lock: "panel:update" },
      async ({ log, signal }) => {
        if (sim) log(`[simulated] ${sim === "dry-run" ? "FCC_DRY_RUN is set" : `${root} is a git checkout`} — download and checks are real, the install is not touched.`);
        if (!sim) {
          try {
            fs.accessSync(root, fs.constants.W_OK);
          } catch {
            throw new Error(`${root} is not writable by the panel process.`);
          }
        }

        log(`▸ Checking ${repo}@${ref}`);
        const latest = await latestCommit(repo, ref, token, { signal });
        log(`Latest commit ${latest.shortCommit}: ${latest.message}`);
        if (inst.commit && inst.commit === latest.commit && !inst.stale) log("(This is the installed commit — re-installing it.)");

        const stageBase = sim ? path.join(ctx.dataDir, "update-staging") : root;
        fs.mkdirSync(stageBase, { recursive: true });
        const stage = path.join(stageBase, `.update-staging.${Date.now()}`);
        rmrf(stage);
        fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
        try {
          log("▸ Download");
          const tarball = path.join(stage, "src.tar.gz");
          await download(repo, latest.commit, token, tarball, { log, signal });
          const extract = path.join(stage, "src");
          fs.mkdirSync(extract);
          await runReal("tar", ["-xzf", tarball, "-C", extract], { signal, timeoutMs: 5 * 60_000 });
          rmrf(tarball);
          const src = findSourceRoot(extract);
          if (!src || !exists(path.join(src, "shared")) || !fs.statSync(path.join(src, "shared")).isDirectory()) {
            throw new Error(`${repo}@${ref} does not contain panel/server.mjs and shared/ — is that the Standalone branch? Nothing was changed.`);
          }
          const newVersion = versionFromSource(fs.readFileSync(path.join(src, "panel", "server.mjs"), "utf8"));
          log(`✓ Archive looks like the Standalone panel${newVersion ? ` (v${newVersion})` : ""}`);
          for (const name of fs.readdirSync(src)) if (COPY_SKIP.has(name)) rmrf(path.join(src, name));

          log("▸ Verify");
          await syntaxCheck(src, { log, signal });
          if (signal.aborted) throw new Error("Cancelled.");

          log("▸ Backup");
          const backupId = takeBackup({
            reason: "update",
            was: { version: inst.version, commit: inst.commit, ref: inst.ref || ref, repo: inst.repo || repo },
            updatingTo: { version: newVersion, commit: latest.commit, ref, repo },
            simulated: !!sim,
            log,
          });
          if (signal.aborted) throw new Error("Cancelled.");

          log("▸ Install");
          const stamp = {
            version: newVersion || latest.version || null,
            repo,
            ref,
            commit: latest.commit,
            source: "github",
            installedAt: new Date().toISOString(),
            via: "panel",
            updatedFrom: { version: inst.version, commit: inst.commit },
            backup: backupId,
          };
          if (sim) {
            const present = CODE_ITEMS.filter((i) => exists(path.join(src, i)));
            log(`[simulated] Would replace ${present.map((i) => path.join(root, i)).join(", ")}`);
            log(`[simulated] Would write ${path.join(root, "version.json")}: ${JSON.stringify({ version: stamp.version, ref, commit: stamp.commit })}`);
          } else {
            swapIn(src, CODE_ITEMS, { log });
            writeJsonAtomic(path.join(root, "version.json"), stamp);
            log(`✓ version.json → ${stamp.version ? `v${stamp.version} ` : ""}${latest.shortCommit}`);
          }

          const mode = restartMode();
          log("▸ Restart");
          restartNote(mode, log);
          log("Agent servers pick up their new files automatically when they reconnect to the restarted panel.");
          ctx.activity(admin, "panel.update", { type: "panel", id: "panel", name: "Panel" }, { from: inst.shortCommit || inst.version, to: latest.shortCommit, version: stamp.version, simulated: !!sim });
          if (!sim) {
            s.last = null; // describes the old code now
            persist();
          }
          return { from: inst, to: { ...latest, version: stamp.version }, backup: backupId, restart: mode, simulated: !!sim };
        } finally {
          rmrf(stage);
        }
      },
    );
    scheduleRestart(job.id, admin?.id || null);
    return job;
  }

  function startRestore(id, admin) {
    assertSafeLayout();
    if (!/^[\w.-]+$/.test(String(id || ""))) throw httpError(400, "Bad backup id.");
    const dir = path.join(backupsRoot, id);
    if (!exists(path.join(dir, "_backup.json"))) throw httpError(404, "No such update backup.");
    if (!exists(path.join(dir, "panel", "server.mjs"))) throw httpError(409, "That backup has no panel/server.mjs — it can't be restored.");
    if (activeJob()) throw httpError(409, "An update or restore is already running.", { jobId: activeJob().id });
    const meta = readJson(path.join(dir, "_backup.json"), {}) || {};
    const inst = installed();
    const sim = simulateReason();

    const job = ctx.jobs.start(
      { type: "panel.restore", title: `Restore panel from backup ${id}`, adminId: admin?.id || null, lock: "panel:update" },
      async ({ log, signal }) => {
        if (sim) log(`[simulated] ${sim === "dry-run" ? "FCC_DRY_RUN is set" : `${root} is a git checkout`} — checks are real, the install is not touched.`);
        const items = (meta.items?.length ? meta.items : BACKUP_ITEMS).filter((i) => BACKUP_ITEMS.includes(i) && exists(path.join(dir, i)));
        log(`Backup ${id}: ${meta.was?.version ? `v${meta.was.version} ` : ""}${meta.was?.commit ? meta.was.commit.slice(0, 7) : ""} (taken ${meta.takenAt || "?"})`);

        log("▸ Verify");
        await syntaxCheck(dir, { log, signal });
        if (signal.aborted) throw new Error("Cancelled.");

        log("▸ Backup of the current code");
        const safetyId = takeBackup({
          reason: "before-restore",
          was: { version: inst.version, commit: inst.commit, ref: inst.ref, repo: inst.repo },
          updatingTo: meta.was || null,
          simulated: !!sim,
          log,
        });

        log("▸ Restore");
        if (sim) {
          log(`[simulated] Would replace ${items.map((i) => path.join(root, i)).join(", ")} from ${dir}`);
        } else {
          const stage = path.join(root, `.update-staging.${Date.now()}`);
          rmrf(stage);
          fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
          try {
            for (const item of items) copyTree(path.join(dir, item), path.join(stage, item));
            swapIn(stage, items, { log });
            if (!items.includes("version.json")) rmrf(path.join(root, "version.json"));
          } finally {
            rmrf(stage);
          }
        }

        const mode = restartMode();
        log("▸ Restart");
        restartNote(mode, log);
        log("Agent servers pick up their files automatically when they reconnect to the restarted panel.");
        ctx.activity(admin, "panel.restore", { type: "panel", id: "panel", name: "Panel" }, { backup: id, to: meta.was?.commit?.slice(0, 7) || meta.was?.version || null, simulated: !!sim });
        if (!sim) {
          s.last = null;
          persist();
        }
        return { backup: id, safetyBackup: safetyId, to: meta.was || null, restart: mode, simulated: !!sim };
      },
    );
    scheduleRestart(job.id, admin?.id || null);
    return job;
  }

  // ---- routes -------------------------------------------------------------------

  router.get("/api/updates", () => status());

  router.post("/api/updates/check", async (req, res, { body }) => {
    await check({ force: !!body?.force });
    return status();
  });

  router.post("/api/updates/apply", (_req, _res, { admin }) => startApply(admin));

  router.get("/api/updates/backups", () => ({ items: listBackups(), keep: KEEP_BACKUPS, dir: backupsRoot }));

  router.post("/api/updates/backups/:id/restore", (_req, _res, { params, admin }) => startRestore(params.id, admin));

  ctx.updates = {
    status,
    check,
    listBackups,
    bootId: BOOT_ID,
    /** Extra public fields for /healthz so a browser can tell the panel restarted. */
    health: () => ({ bootId: BOOT_ID, commit: installed().shortCommit }),
    _restore: restore,
    _state: s,
  };
}

export async function start(ctx) {
  const u = ctx.updates;
  if (!u) return;
  u._restore();
  const s = u._state;
  const tick = () => u.check({ force: false, cooldownMs: CHECK_EVERY_MS }).catch(() => {});
  const first = setTimeout(tick, FIRST_CHECK_MS);
  first.unref?.();
  const every = setInterval(tick, CHECK_EVERY_MS);
  every.unref?.();
  s.timers.push(first, every);
}

export function stop(ctx) {
  for (const t of ctx.updates?._state?.timers || []) {
    clearTimeout(t);
    clearInterval(t);
  }
}
