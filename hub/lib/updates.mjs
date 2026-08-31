/**
 * Keeping the Command Center itself up to date.
 *
 * Every other part of this project updates something else. This part updates
 * the panel, which makes it the one place where a bad write takes away the
 * tool you would use to fix it. So the order is deliberate: fetch, verify the
 * archive really is a Command Center, take a full backup of what is on disk,
 * then write — and keep the backup so a bad release is one button to undo.
 *
 * The version on disk is identified two ways, because an install arrives two
 * ways. A git clone knows its commit from .git; a zip install does not, so
 * applying an update writes version.json with the commit it came from. After
 * the first update through the panel, either kind knows exactly what it is
 * running.
 *
 * No npm dependencies — GitHub's zipball is a real zip and shared/zip.mjs
 * already reads one.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeRepo, downloadZipball } from "./github.mjs";
import { extractZip } from "../../shared/zip.mjs";
import { ensureDir, rmrf, exists, readJson, writeJson, copyDir, mirror, makeMatcher, walk, humanBytes } from "../../shared/fsx.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

export const DEFAULT_REPO = "llallenll/Forthway-Command-Center";
const API = "https://api.github.com";
const UA = "forthway-command-center";

/**
 * Never overwritten by an update. Everything here is either this install's
 * identity (config, data, releases) or something an update has no business
 * touching (git metadata, installed dependencies).
 */
const KEEP = [
  "hub/config.json",
  "hub/data",
  "data",
  ".git",
  ".env",
  "node_modules",
  "**/node_modules",
  "agent/agent.config.json",
  "*.log",
];

const BASE_SKIP = ["node_modules", "**/node_modules", ".git", "hub/data", "data"];

/**
 * The data directory is configurable, so it is not always hub/data. If it sits
 * inside the install it has to be excluded by its real path — otherwise the
 * backup walks into the folder it is being written to.
 */
function relativeToRoot(dataDir) {
  if (!dataDir) return [];
  const rel = path.relative(ROOT, path.resolve(dataDir)).split(path.sep).join("/");
  return rel && !rel.startsWith("..") ? [rel] : [];
}

/** A file list this shallow is not a Command Center, whatever GitHub called it. */
const MUST_CONTAIN = ["hub/server.mjs", "shared/deployer.mjs"];

// ------------------------------------------------------------- identity

/**
 * What is installed right now.
 *
 * `version` is the panel's own constant, passed in by the server so there is
 * only one place it is declared. `sha` is whatever we can prove.
 */
export function installedVersion(fallbackVersion) {
  const stamp = readJson(path.join(ROOT, "version.json"), null);
  const git = gitHead();
  return {
    version: stamp?.version || fallbackVersion || null,
    sha: stamp?.sha || git?.sha || null,
    shortSha: (stamp?.sha || git?.sha || "").slice(0, 7) || null,
    ref: stamp?.ref || git?.ref || null,
    installedAt: stamp?.installedAt || null,
    // How we know: this decides what the panel can honestly claim.
    source: stamp?.sha ? "panel" : git?.sha ? "git" : "unknown",
    root: ROOT,
  };
}

/** Read the checked-out commit without shelling out to git. */
function gitHead() {
  try {
    const gitDir = path.join(ROOT, ".git");
    if (!exists(gitDir)) return null;
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    const m = /^ref:\s*(.+)$/.exec(head);
    if (!m) return /^[0-9a-f]{40}$/i.test(head) ? { sha: head, ref: null } : null;
    const ref = m[1];
    const refFile = path.join(gitDir, ref);
    if (exists(refFile)) {
      return { sha: fs.readFileSync(refFile, "utf8").trim(), ref: ref.replace(/^refs\/heads\//, "") };
    }
    // A packed ref — the loose file is gone once git has packed it.
    const packed = path.join(gitDir, "packed-refs");
    if (exists(packed)) {
      for (const line of fs.readFileSync(packed, "utf8").split("\n")) {
        const [sha, name] = line.trim().split(/\s+/);
        if (name === ref) return { sha, ref: ref.replace(/^refs\/heads\//, "") };
      }
    }
    return { sha: null, ref: ref.replace(/^refs\/heads\//, "") };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- check

async function ghJson(pathname, token, { timeoutMs = 20_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API}${pathname}`, { headers, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    if (res.status === 404) return null; // "no releases yet" is a normal answer
    if (!res.ok) {
      const msg = json?.message || `HTTP ${res.status}`;
      if (res.status === 403 && /rate limit/i.test(msg)) {
        throw new Error(
          token
            ? "GitHub rate limit reached for this token — try again in a few minutes."
            : "GitHub rate limit reached. Adding a GitHub token in Settings raises it considerably.",
        );
      }
      if (res.status === 401) throw new Error("GitHub rejected the token (401).");
      throw new Error(`GitHub error ${res.status}: ${msg}`);
    }
    return json;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("GitHub did not answer in time.");
    throw err;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Ask GitHub what the newest version is.
 *
 * Releases are preferred when the repo publishes them, because a release is
 * someone saying "this one is ready". Falling back to the newest commit on the
 * branch means the check still works for a repo that never tags anything —
 * which is most repos, most of the time.
 */
export async function checkForUpdate({ repo = DEFAULT_REPO, ref = "", token = "", currentVersion = null } = {}) {
  const target = normalizeRepo(repo) || DEFAULT_REPO;
  const installed = installedVersion(currentVersion);

  let latest = null;
  let channel = "branch";

  if (!ref) {
    const release = await ghJson(`/repos/${target}/releases/latest`, token);
    if (release && !release.draft) {
      channel = "release";
      const tagCommit = await ghJson(`/repos/${target}/commits/${encodeURIComponent(release.tag_name)}`, token).catch(
        () => null,
      );
      latest = {
        ref: release.tag_name,
        version: String(release.tag_name || "").replace(/^v/i, "") || null,
        name: release.name || release.tag_name,
        notes: (release.body || "").slice(0, 4000),
        publishedAt: release.published_at,
        htmlUrl: release.html_url,
        sha: tagCommit?.sha || null,
      };
    }
  }

  if (!latest) {
    const repoMeta = await ghJson(`/repos/${target}`, token);
    if (!repoMeta) throw new Error(`GitHub has no repository called ${target}, or this install cannot see it.`);
    const branch = ref || repoMeta.default_branch || "main";
    const commit = await ghJson(`/repos/${target}/commits/${encodeURIComponent(branch)}`, token);
    if (!commit) throw new Error(`GitHub has no branch, tag or commit called "${branch}" in ${target}.`);
    channel = ref ? "ref" : "branch";
    latest = {
      ref: branch,
      version: null,
      name: (commit.commit?.message || "").split("\n")[0].slice(0, 120),
      notes: "",
      publishedAt: commit.commit?.author?.date || null,
      htmlUrl: commit.html_url,
      sha: commit.sha,
      author: commit.commit?.author?.name || commit.author?.login || null,
    };
  }

  const decision = compare(installed, latest);

  return {
    repo: target,
    channel,
    checkedAt: new Date().toISOString(),
    installed,
    latest: { ...latest, shortSha: latest.sha ? latest.sha.slice(0, 7) : null },
    ...decision,
  };
}

/**
 * Is the thing on GitHub newer than the thing on disk?
 *
 * The honest answer is sometimes "cannot tell" — a zip install that has never
 * been updated through the panel has no commit to compare — and the panel says
 * so rather than inventing a badge either way.
 */
function compare(installed, latest) {
  if (installed.sha && latest.sha) {
    if (installed.sha === latest.sha) {
      return { updateAvailable: false, certainty: "exact", reason: "Running the same commit as GitHub." };
    }
    // A release channel can still be behind on version even with a new sha.
    return {
      updateAvailable: true,
      certainty: "exact",
      reason: latest.version
        ? `GitHub has ${latest.version}; this panel is at ${installed.version || "an unknown version"}.`
        : "GitHub has a newer commit than the one this panel was installed from.",
    };
  }

  if (installed.version && latest.version) {
    const cmp = compareVersions(latest.version, installed.version);
    return {
      updateAvailable: cmp > 0,
      certainty: "version",
      reason:
        cmp > 0
          ? `GitHub has ${latest.version}; this panel reports ${installed.version}.`
          : `This panel reports ${installed.version}, which is not behind ${latest.version}.`,
    };
  }

  return {
    updateAvailable: null,
    certainty: "unknown",
    reason:
      "This install has no recorded commit, so there is nothing to compare against. " +
      "Updating once through this panel records it, and every check after that is exact.",
  };
}

/** Compare 1.2.10 against 1.2.9 the way a person would, not the way a string sort does. */
export function compareVersions(a, b) {
  const parse = (v) =>
    String(v || "")
      .replace(/^v/i, "")
      .split(/[.\-+]/)
      .map((x) => (/^\d+$/.test(x) ? +x : x));
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

// ---------------------------------------------------------------- apply

/**
 * Download the chosen version and write it over this install.
 *
 * `log(line)` is called as it goes, so the panel can show the same running
 * commentary a deploy shows. Returns what changed and where the backup went;
 * restarting is the caller's decision, because only the caller knows whether
 * it can answer the browser first.
 */
export async function applyUpdate({
  repo = DEFAULT_REPO,
  ref = "",
  token = "",
  dataDir,
  currentVersion = null,
  dryRun = false,
  log = () => {},
} = {}) {
  const target = normalizeRepo(repo) || DEFAULT_REPO;
  const info = await checkForUpdate({ repo: target, ref, token, currentVersion });
  const wanted = ref || info.latest.ref;

  log(`Updating from ${target} @ ${wanted}${info.latest.shortSha ? ` (${info.latest.shortSha})` : ""}.`);

  const staging = path.join(ensureDir(path.join(dataDir || path.join(ROOT, "hub/data"), "updates")), "staging");
  rmrf(staging);
  ensureDir(staging);

  log("Downloading the archive from GitHub…");
  const buf = await downloadZipball(target, wanted, token);
  log(`Got ${humanBytes(buf.length)}.`);

  const written = extractZip(buf, staging, { stripRoot: true });
  log(`Unpacked ${written.length} files.`);

  // --- refuse anything that is not recognisably this project ------------
  for (const rel of MUST_CONTAIN) {
    if (!exists(path.join(staging, rel))) {
      rmrf(staging);
      throw new Error(
        `That archive does not look like a Command Center — it has no ${rel}. Nothing was changed. ` +
          `Check the repository name in Settings.`,
      );
    }
  }

  const protect = makeMatcher([...KEEP, ...relativeToRoot(dataDir)]);
  const skip = makeMatcher([...BASE_SKIP, ...relativeToRoot(dataDir)]);
  const incoming = walk(staging, { skip });
  log(`${incoming.length} files in the new version.`);

  if (dryRun) {
    const changed = incoming.filter((rel) => !protect(rel) && !sameOnDisk(path.join(staging, rel), path.join(ROOT, rel)));
    rmrf(staging);
    return {
      dryRun: true,
      from: info.installed,
      to: info.latest,
      wouldChange: changed.length,
      files: changed.slice(0, 200),
      skipped: KEEP,
    };
  }

  // --- back up before writing a single byte -----------------------------
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = ensureDir(path.join(dataDir || path.join(ROOT, "hub/data"), "update-backups"));
  const backup = path.join(backupRoot, stamp);
  log("Backing up the current install…");
  const backedUp = copyDir(ROOT, backup, { skip: (rel) => skip(rel) || protect(rel) });
  writeJson(path.join(backup, "_backup.json"), {
    takenAt: new Date().toISOString(),
    was: info.installed,
    updatingTo: info.latest,
    fileCount: backedUp.length,
  });
  log(`Backup of ${backedUp.length} files saved as ${stamp}.`);

  // --- write ------------------------------------------------------------
  const prev = readJson(path.join(ROOT, "version.json"), null)?.files || [];
  const result = mirror(staging, ROOT, { prevManifest: prev, protect, skip });
  log(
    `Files: ${result.added} added, ${result.updated} replaced, ${result.unchanged} unchanged, ` +
      `${result.removed.length} removed.`,
  );

  const stampFile = {
    version: readPackageVersion(staging) || info.latest.version || currentVersion || null,
    sha: info.latest.sha,
    ref: wanted,
    repo: target,
    channel: info.channel,
    installedAt: new Date().toISOString(),
    installedFrom: info.installed,
    backup: stamp,
    files: result.manifest,
  };
  writeJson(path.join(ROOT, "version.json"), stampFile);

  rmrf(staging);
  pruneBackups(backupRoot, 5);

  const dependencyChange = result.manifest.some((rel) => /(^|\/)package(-lock)?\.json$/.test(rel));

  return {
    dryRun: false,
    from: info.installed,
    to: { ...info.latest, version: stampFile.version },
    added: result.added,
    updated: result.updated,
    removed: result.removed,
    unchanged: result.unchanged,
    backup: stamp,
    backupPath: backup,
    dependencyChange,
  };
}

function readPackageVersion(dir) {
  return readJson(path.join(dir, "package.json"), null)?.version || null;
}

function sameOnDisk(a, b) {
  try {
    if (!exists(b)) return false;
    const x = fs.statSync(a);
    const y = fs.statSync(b);
    if (x.size !== y.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

/** Keep the last few backups; a panel is small, but not free. */
function pruneBackups(root, keep) {
  try {
    const dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const name of dirs.slice(0, Math.max(0, dirs.length - keep))) rmrf(path.join(root, name));
  } catch {
    /* a failed prune is not a failed update */
  }
}

/** What backups are on disk, newest first — the undo list. */
export function listBackups(dataDir) {
  const root = path.join(dataDir || path.join(ROOT, "hub/data"), "update-backups");
  if (!exists(root)) return [];
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const meta = readJson(path.join(root, d.name, "_backup.json"), null);
        return {
          id: d.name,
          takenAt: meta?.takenAt || null,
          was: meta?.was || null,
          updatingTo: meta?.updatingTo || null,
          fileCount: meta?.fileCount || null,
        };
      })
      .sort((a, b) => String(b.id).localeCompare(String(a.id)));
  } catch {
    return [];
  }
}

/** Put a backup back. The same protect list applies, so config and data survive. */
export function restoreBackup(id, { dataDir, log = () => {} } = {}) {
  const root = path.join(dataDir || path.join(ROOT, "hub/data"), "update-backups");
  const dir = path.join(root, String(id || "").replace(/[^\w.-]/g, ""));
  if (!exists(dir)) throw new Error(`There is no backup called ${id}.`);
  const protect = makeMatcher([...KEEP, ...relativeToRoot(dataDir)]);
  const skip = makeMatcher([...BASE_SKIP, "_backup.json", ...relativeToRoot(dataDir)]);
  log(`Restoring the install from backup ${id}…`);
  const result = mirror(dir, ROOT, { prevManifest: [], protect, skip });
  const meta = readJson(path.join(dir, "_backup.json"), null);
  if (meta?.was) {
    writeJson(path.join(ROOT, "version.json"), {
      ...meta.was,
      restoredFrom: id,
      installedAt: new Date().toISOString(),
    });
  } else {
    rmrf(path.join(ROOT, "version.json"));
  }
  log(`Restored ${result.added + result.updated} files.`);
  return { restored: id, added: result.added, updated: result.updated };
}
