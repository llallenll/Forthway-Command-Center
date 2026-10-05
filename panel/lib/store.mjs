/**
 * The panel's database: one JSON file, `dataDir/db.json`.
 *
 * Collections are plain arrays of objects with a string `id`. Every module
 * reads and writes through `ctx.db`, which hands out the live objects — mutate
 * one and call `db.save()`, or use `db.update()` which does both.
 *
 * Writes are debounced (a deploy produces dozens of small changes) and
 * atomic: the file is written to a temporary name and renamed over the old
 * one, so a crash or power cut leaves either the old file or the new one,
 * never half of each.
 *
 * Losing this file must never look like a fresh install — that would hand the
 * /setup page (and with it an owner account) to whoever opens it first. So a
 * file that cannot be parsed is not silently replaced: the last good copy
 * (`db.json.bak`, taken at every boot) is tried, and if that fails too the
 * panel refuses to start and says why.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEBOUNCE_MS = 300;

export const COLLECTIONS = ["admins", "projects", "sites", "releases", "servers", "databases", "backups", "jobs", "activity"];

/** Short id prefixes, so an id says what it is when it shows up in a log. */
const PREFIX = {
  admins: "adm",
  projects: "prj",
  sites: "site",
  releases: "rel",
  servers: "srv",
  databases: "db",
  backups: "bak",
  jobs: "job",
  activity: "act",
};

/** Write a file atomically (tmp + rename), owner-readable only. */
export function writeFileAtomic(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  fs.writeFileSync(tmp, data, { mode });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
  try { fs.chmodSync(file, mode); } catch { /* not fatal (e.g. odd filesystems) */ }
}

function nowIso() {
  return new Date().toISOString();
}

function matcher(filter) {
  if (!filter) return () => true;
  if (typeof filter === "function") return filter;
  const entries = Object.entries(filter).filter(([, v]) => v !== undefined);
  return (o) => entries.every(([k, v]) => o[k] === v);
}

export class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, "db.json");
    this.data = {};
    this._timer = null;
    this._load();
  }

  _load() {
    const parse = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
    let loaded = null;
    if (fs.existsSync(this.file)) {
      try {
        loaded = parse(this.file);
      } catch (err) {
        const bak = `${this.file}.bak`;
        console.error(`[fcc] ${this.file} could not be read (${err.message}); trying ${bak}`);
        try {
          loaded = parse(bak);
          // Keep the broken file for forensics rather than overwriting it.
          fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          throw new Error(
            `${this.file} is unreadable and there is no usable backup (${bak}). ` +
              `Fix or restore it by hand; the panel will not start with an empty database.`,
          );
        }
      }
    }
    loaded = loaded && typeof loaded === "object" ? loaded : {};
    for (const c of COLLECTIONS) this.data[c] = Array.isArray(loaded[c]) ? loaded[c] : [];
    for (const [c, v] of Object.entries(loaded)) if (!(c in this.data) && Array.isArray(v)) this.data[c] = v;
    if (fs.existsSync(this.file)) {
      try {
        fs.copyFileSync(this.file, `${this.file}.bak`);
        fs.chmodSync(`${this.file}.bak`, 0o600);
      } catch { /* best effort */ }
    }
  }

  _coll(coll) {
    if (!this.data[coll]) this.data[coll] = [];
    return this.data[coll];
  }

  newId(prefix = "id") {
    return `${prefix}_${Date.now().toString(36).slice(-4)}${crypto.randomBytes(4).toString("hex")}`;
  }

  /** Array of matching records (a new array; the records themselves are live). */
  list(coll, filter) {
    return this._coll(coll).filter(matcher(filter));
  }

  get(coll, id) {
    if (id == null) return null;
    return this._coll(coll).find((o) => o.id === id) || null;
  }

  insert(coll, obj) {
    const arr = this._coll(coll);
    if (!obj.id) obj.id = this.newId(PREFIX[coll] || coll.slice(0, 3));
    if (arr.some((o) => o.id === obj.id)) throw new Error(`${coll}: id ${obj.id} already exists`);
    if (!obj.createdAt) obj.createdAt = nowIso();
    arr.push(obj);
    this.save();
    return obj;
  }

  update(coll, id, patch = {}) {
    const obj = this.get(coll, id);
    if (!obj) return null;
    const { id: _ignored, ...rest } = patch;
    Object.assign(obj, rest, { updatedAt: nowIso() });
    this.save();
    return obj;
  }

  remove(coll, id) {
    const arr = this._coll(coll);
    const i = arr.findIndex((o) => o.id === id);
    if (i === -1) return null;
    const [removed] = arr.splice(i, 1);
    this.save();
    return removed;
  }

  /** Remove many records at once (fn or equal-fields filter). Returns them. */
  removeWhere(coll, filter) {
    const arr = this._coll(coll);
    const test = matcher(filter);
    const removed = [];
    for (let i = arr.length - 1; i >= 0; i--) if (test(arr[i])) removed.unshift(...arr.splice(i, 1));
    if (removed.length) this.save();
    return removed;
  }

  save({ immediate = false } = {}) {
    if (immediate) {
      if (this._timer) clearTimeout(this._timer);
      this._timer = null;
      this._write();
      return;
    }
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      try {
        this._write();
      } catch (err) {
        console.error("[fcc] could not write db.json:", err.message);
      }
    }, DEBOUNCE_MS);
  }

  _write() {
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 1));
  }
}
