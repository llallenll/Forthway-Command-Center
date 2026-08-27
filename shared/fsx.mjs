/**
 * Filesystem helpers shared by the hub and the agents. No dependencies.
 *
 * The important one is `mirror()`, which implements the "replace only the
 * files that actually need replacing" behaviour: it walks a freshly built
 * staging tree, copies across only what differs from the live app, and
 * deletes files that the previous release installed but this one no longer
 * ships. Files the deploy never owned (uploads, .env, logs) are left alone.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

export function sha1File(p) {
  const h = crypto.createHash("sha1");
  h.update(fs.readFileSync(p));
  return h.digest("hex");
}

export function sha256Buf(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Turn a list of glob-ish patterns into a matcher.
 * Supports `name`, `dir/`, `dir/**`, `*.log` — deliberately simple, because
 * config files for this are written by hand.
 */
export function makeMatcher(patterns = []) {
  const res = patterns.filter(Boolean).map((raw) => {
    let p = raw.replace(/^\.\//, "").replace(/\/+$/, "");
    const rx = p
      .split("/")
      .map((seg) =>
        seg === "**"
          ? "(?:.+)"
          : seg
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*/g, "[^/]*")
              .replace(/\?/g, "[^/]"),
      )
      .join("/");
    // A pattern matches the path itself or anything beneath it.
    return new RegExp(`^${rx}(?:/.*)?$`);
  });
  return (rel) => res.some((re) => re.test(rel));
}

/** Recursively list relative file paths under `dir`, skipping matches. */
export function walk(dir, { skip = () => false, base = dir, out = [] } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs).split(path.sep).join("/");
    if (skip(rel)) continue;
    if (e.isDirectory()) {
      walk(abs, { skip, base, out });
    } else if (e.isFile() || e.isSymbolicLink()) {
      out.push(rel);
    }
  }
  return out;
}

function sameFile(a, b) {
  let sa, sb;
  try {
    sa = fs.statSync(a);
    sb = fs.statSync(b);
  } catch {
    return false;
  }
  if (sa.size !== sb.size) return false;
  // Same size — compare content. Cheap enough: this only runs for files that
  // survived the size check, which is the overwhelming majority of unchanged
  // files but a tiny fraction of total bytes moved.
  return sha1File(a) === sha1File(b);
}

export function copyFilePreserve(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  try {
    const st = fs.statSync(src);
    fs.chmodSync(dest, st.mode & 0o777);
  } catch {
    /* non-fatal */
  }
}

/** Plain recursive copy (used for backups and seeding node_modules). */
export function copyDir(src, dest, { skip = () => false } = {}) {
  const files = walk(src, { skip });
  for (const rel of files) {
    copyFilePreserve(path.join(src, rel), path.join(dest, rel));
  }
  return files;
}

/**
 * Copy a directory using hard links where possible. Used to seed a staging
 * node_modules from the live one: near-instant and near-zero disk, and npm
 * replaces (not mutates) files it updates, so the live tree stays intact.
 * Falls back to a real copy if the filesystem refuses to link.
 */
export function hardlinkDir(src, dest) {
  let linked = 0;
  let copied = 0;
  const files = walk(src);
  for (const rel of files) {
    const s = path.join(src, rel);
    const d = path.join(dest, rel);
    ensureDir(path.dirname(d));
    try {
      fs.linkSync(s, d);
      linked++;
    } catch {
      try {
        fs.copyFileSync(s, d);
        copied++;
      } catch {
        /* skip unreadable file */
      }
    }
  }
  return { linked, copied, total: files.length };
}

/**
 * Sync `srcDir` onto `destDir`.
 *
 * @param prevManifest file list installed by the previous release; anything in
 *   it that the new release does not ship gets deleted from dest.
 * @param protect matcher for paths the deploy must never touch (.env, uploads…)
 * @returns { manifest, added, updated, removed, unchanged }
 */
export function mirror(srcDir, destDir, { prevManifest = [], protect = () => false, skip = () => false } = {}) {
  const srcFiles = walk(srcDir, { skip });
  const manifest = [];
  let added = 0;
  let updated = 0;
  let unchanged = 0;

  for (const rel of srcFiles) {
    if (protect(rel)) continue;
    manifest.push(rel);
    const s = path.join(srcDir, rel);
    const d = path.join(destDir, rel);
    if (!exists(d)) {
      copyFilePreserve(s, d);
      added++;
    } else if (!sameFile(s, d)) {
      copyFilePreserve(s, d);
      updated++;
    } else {
      unchanged++;
    }
  }

  // Anything the last release owned but this one dropped.
  const nowHas = new Set(manifest);
  const removed = [];
  for (const rel of prevManifest) {
    if (nowHas.has(rel)) continue;
    if (protect(rel)) continue;
    const d = path.join(destDir, rel);
    if (exists(d)) {
      try {
        fs.rmSync(d);
        removed.push(rel);
      } catch {
        /* ignore */
      }
    }
  }
  pruneEmptyDirs(destDir, removed);

  return { manifest, added, updated, removed, unchanged };
}

function pruneEmptyDirs(root, removedRelPaths) {
  const dirs = new Set();
  for (const rel of removedRelPaths) {
    let d = path.dirname(rel);
    while (d && d !== "." && d !== "/") {
      dirs.add(d);
      d = path.dirname(d);
    }
  }
  // Deepest first so parents empty out naturally.
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    const abs = path.join(root, d);
    try {
      if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
    } catch {
      /* not empty or gone */
    }
  }
}

export function dirSizeBytes(dir, { skip = () => false } = {}) {
  let total = 0;
  for (const rel of walk(dir, { skip })) {
    try {
      total += fs.statSync(path.join(dir, rel)).size;
    } catch {
      /* ignore */
    }
  }
  return total;
}

export function humanBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
