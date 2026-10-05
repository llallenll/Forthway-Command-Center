/**
 * Background jobs: anything slower than a request (deploys, backups, certbot,
 * nginx applies, imports…) runs as a job.
 *
 *   const job = ctx.jobs.start(
 *     { type: "site.deploy", title: "Deploy acme.com", projectId, siteId, adminId },
 *     async ({ log, signal, job }) => { log("line"); return result; },
 *   );
 *
 * `start()` returns the record immediately and runs the function in the
 * background. The record lives in the `jobs` collection (last ~500 kept), the
 * output in `dataDir/logs/<jobId>.log`, and browsers follow along over SSE:
 * `job` (the record, on every status change) and `job.log` ({ id, lines },
 * batched every ~250 ms).
 *
 * Serialisation. Two deploys of the same site at once would trample each
 * other, so jobs that touch the same thing queue behind each other. The lock
 * key is `meta.lock` if given, otherwise `site:<siteId>` when there is a
 * siteId, otherwise `database:<databaseId>` when there is a databaseId,
 * otherwise none (runs immediately). Pass `lock: false` to opt out. Locks are
 * re-entrant: a job started from INSIDE a running job that holds the same lock
 * (e.g. a deploy that starts per-server sub-jobs, or a restore that first
 * takes a safety backup and waits for it) runs immediately instead of
 * deadlocking.
 *
 * Cancellation aborts `signal`; the function should stop promptly (sys.run
 * kills its child process on abort). A function that ignores the signal is
 * marked cancelled after a grace period anyway, and its lock released.
 */

import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

const MAX_KEPT = 500;
const LOG_FLUSH_MS = 250;
const CANCEL_GRACE_MS = 30_000;
const MAX_LINE = 16_000;
const MAX_LOG_READ = 8 * 1024 * 1024;

const FIELDS = ["projectId", "siteId", "serverId", "databaseId", "adminId"];
const DONE = new Set(["succeeded", "failed", "cancelled"]);

function nowIso() {
  return new Date().toISOString();
}

function serializable(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

export class Jobs {
  constructor({ db, dataDir, events }) {
    this.db = db;
    this.events = events;
    this.logsDir = path.join(dataDir, "logs");
    fs.mkdirSync(this.logsDir, { recursive: true });
    this.live = new Map(); // id -> { controller, stream, finished, lock, owner }
    this.waiters = new Map(); // id -> [resolve]
    this.lockOwner = new Map(); // lock -> jobId
    this.queues = new Map(); // lock -> [{ record, fn }]
    this.pendingLines = new Map(); // id -> [line]
    this.flushTimer = null;
    this.als = new AsyncLocalStorage();
  }

  /** At boot nothing can still be running: whatever was is now failed. */
  recover() {
    let changed = 0;
    for (const j of this.db.list("jobs")) {
      if (DONE.has(j.status)) continue;
      j.status = "failed";
      j.error = "panel restarted";
      j.finishedAt = nowIso();
      changed++;
    }
    if (changed) this.db.save({ immediate: true });
    return changed;
  }

  logPath(id) {
    return path.join(this.logsDir, `${String(id).replace(/[^\w.-]/g, "_")}.log`);
  }

  // ---------------------------------------------------------------- start

  start(meta = {}, fn) {
    if (typeof fn !== "function") throw new Error("jobs.start needs a function");
    const { lock: lockOpt, ...rest } = meta;
    const record = {
      ...serializable(rest),
      id: this.db.newId("job"),
      type: String(meta.type || "job"),
      title: String(meta.title || meta.type || "Job"),
      status: "queued",
      ...Object.fromEntries(FIELDS.map((k) => [k, meta[k] ?? null])),
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      error: null,
      result: null,
    };
    this.db.insert("jobs", record);
    this._prune();

    const lock = lockOpt === false ? null : lockOpt || (meta.siteId ? `site:${meta.siteId}` : meta.databaseId ? `database:${meta.databaseId}` : null);
    const held = this.als.getStore();
    const reentrant = !!(lock && held?.has(lock));

    if (!lock || reentrant || !this.lockOwner.has(lock)) {
      if (lock && !reentrant) this.lockOwner.set(lock, record.id);
      this._run(record, fn, { lock, owner: !!lock && !reentrant, held });
    } else {
      const q = this.queues.get(lock) || [];
      q.push({ record, fn, held });
      this.queues.set(lock, q);
      const blocker = this.db.get("jobs", this.lockOwner.get(lock));
      this.log(record.id, `Queued — waiting for "${blocker?.title || "another job"}" to finish.`);
      this._emit(record);
    }
    return record;
  }

  _run(record, fn, { lock, owner, held }) {
    const controller = new AbortController();
    const entry = { controller, stream: null, finished: false, lock, owner, graceTimer: null };
    this.live.set(record.id, entry);
    record.status = "running";
    record.startedAt = nowIso();
    this.db.save();
    this._emit(record);

    const heldNow = new Set(held || []);
    if (lock) heldNow.add(lock);
    const log = (line) => this.log(record.id, line);

    this.als.run(heldNow, () => {
      Promise.resolve()
        .then(() => {
          // Cancelled in the same tick it was started: never call fn.
          if (controller.signal.aborted) throw new Error("Cancelled");
          return fn({ log, signal: controller.signal, job: record });
        })
        .then(
          (result) => {
            if (controller.signal.aborted) this._finish(record, "cancelled", { error: "Cancelled" });
            else this._finish(record, "succeeded", { result: serializable(result) });
          },
          (err) => {
            if (controller.signal.aborted) {
              this._finish(record, "cancelled", { error: "Cancelled" });
            } else {
              const message = err?.message || String(err);
              log(`Error: ${message}`);
              this._finish(record, "failed", { error: message });
            }
          },
        );
    });
  }

  _finish(record, status, { result = null, error = null } = {}) {
    if (DONE.has(record.status)) return; // already settled (e.g. by the cancel grace timer)
    const entry = this.live.get(record.id);
    if (entry) {
      entry.finished = true;
      if (entry.graceTimer) clearTimeout(entry.graceTimer);
    }
    this._flushLogs(record.id);
    record.status = status;
    record.result = result;
    record.error = error;
    record.finishedAt = nowIso();
    this.db.save();
    this._emit(record);
    if (entry?.stream) entry.stream.end();
    this.live.delete(record.id);

    for (const resolve of this.waiters.get(record.id) || []) resolve(record);
    this.waiters.delete(record.id);

    if (entry?.owner && entry.lock) this._release(entry.lock, record.id);
    this._prune();
  }

  _release(lock, jobId) {
    if (this.lockOwner.get(lock) !== jobId) return;
    this.lockOwner.delete(lock);
    const q = this.queues.get(lock);
    const next = q?.shift();
    if (!q?.length) this.queues.delete(lock);
    if (!next) return;
    this.lockOwner.set(lock, next.record.id);
    this._run(next.record, next.fn, { lock, owner: true, held: next.held });
  }

  // ------------------------------------------------------------------ logs

  /** Append one or more lines to a job's log (also used by modules directly). */
  log(id, line) {
    const text = typeof line === "string" ? line : line instanceof Error ? line.message : JSON.stringify(line);
    const lines = String(text ?? "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l));
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    if (!lines.length) return;
    const chunk = lines.join("\n") + "\n";

    const entry = this.live.get(id);
    try {
      if (entry) {
        entry.stream ||= fs.createWriteStream(this.logPath(id), { flags: "a", mode: 0o600 });
        entry.stream.write(chunk);
      } else {
        fs.appendFileSync(this.logPath(id), chunk, { mode: 0o600 });
      }
    } catch (err) {
      console.error(`[fcc] job ${id}: could not write log:`, err.message);
    }

    const pending = this.pendingLines.get(id) || [];
    pending.push(...lines);
    this.pendingLines.set(id, pending);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        for (const jobId of [...this.pendingLines.keys()]) this._flushLogs(jobId);
      }, LOG_FLUSH_MS);
      this.flushTimer.unref?.();
    }
  }

  _flushLogs(id) {
    const lines = this.pendingLines.get(id);
    if (!lines?.length) return;
    this.pendingLines.delete(id);
    const MAX = 2000;
    const out = lines.length > MAX ? [`… ${lines.length - MAX} lines omitted (see full log)`, ...lines.slice(-MAX)] : lines;
    this.events?.broadcast("job.log", { id, lines: out });
  }

  /** Full log text (the last 8 MB if it is larger). */
  readLog(id) {
    const file = this.logPath(id);
    try {
      const { size } = fs.statSync(file);
      if (size <= MAX_LOG_READ) return fs.readFileSync(file, "utf8");
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(MAX_LOG_READ);
        fs.readSync(fd, buf, 0, MAX_LOG_READ, size - MAX_LOG_READ);
        return `… (earlier output truncated)\n${buf.toString("utf8")}`;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return "";
    }
  }

  // ------------------------------------------------------------- queries

  get(id) {
    return this.db.get("jobs", id);
  }

  list({ siteId, projectId, serverId, databaseId, adminId, type, status, limit = 50 } = {}) {
    const want = { siteId, projectId, serverId, databaseId, adminId, type, status };
    const keys = Object.keys(want).filter((k) => want[k] != null && want[k] !== "");
    const n = Math.max(1, Math.min(MAX_KEPT, Number(limit) || 50));
    return this.db
      .list("jobs", (j) => keys.every((k) => j[k] === want[k]))
      .reverse() // newest-inserted first when timestamps tie
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, n);
  }

  isActive(id) {
    const j = this.get(id);
    return !!j && !DONE.has(j.status);
  }

  /** Resolves with the record once the job has finished (null if unknown). */
  wait(id) {
    const j = this.get(id);
    if (!j) return Promise.resolve(null);
    if (DONE.has(j.status)) return Promise.resolve(j);
    return new Promise((resolve) => {
      const list = this.waiters.get(id) || [];
      list.push(resolve);
      this.waiters.set(id, list);
    });
  }

  /** Cancel a queued or running job. Returns the record, or null if unknown. */
  cancel(id, { by } = {}) {
    const record = this.get(id);
    if (!record || DONE.has(record.status)) return record;

    if (record.status === "queued") {
      for (const [lock, q] of this.queues) {
        const i = q.findIndex((x) => x.record.id === id);
        if (i === -1) continue;
        q.splice(i, 1);
        if (!q.length) this.queues.delete(lock);
      }
      this.log(id, `Cancelled${by ? ` by ${by}` : ""} before it started.`);
      this._finish(record, "cancelled", { error: "Cancelled" });
      return record;
    }

    const entry = this.live.get(id);
    if (!entry || entry.controller.signal.aborted) return record;
    this.log(id, `Cancellation requested${by ? ` by ${by}` : ""}…`);
    entry.controller.abort();
    entry.graceTimer = setTimeout(() => {
      if (entry.finished) return;
      this.log(id, "The job did not stop on its own; marked cancelled.");
      this._finish(record, "cancelled", { error: "Cancelled" });
    }, CANCEL_GRACE_MS);
    entry.graceTimer.unref?.();
    return record;
  }

  // --------------------------------------------------------------- upkeep

  _prune() {
    const all = this.db.list("jobs");
    if (all.length <= MAX_KEPT) return;
    const removable = all
      .filter((j) => DONE.has(j.status))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .slice(0, all.length - MAX_KEPT);
    const ids = new Set(removable.map((j) => j.id));
    this.db.removeWhere("jobs", (j) => ids.has(j.id));
    for (const id of ids) fs.rm(this.logPath(id), { force: true }, () => {});
  }

  _emit(record) {
    this.events?.broadcast("job", { ...record });
  }

  /** Panel is stopping: abort what is running and record why. */
  shutdown(reason = "panel stopped") {
    for (const q of this.queues.values()) {
      for (const { record } of q) {
        record.status = "failed";
        record.error = reason;
        record.finishedAt = nowIso();
      }
    }
    this.queues.clear();
    for (const [id, entry] of [...this.live]) {
      const record = this.get(id);
      try {
        entry.controller.abort();
      } catch { /* ignore */ }
      if (record) {
        this.log(id, `Interrupted: ${reason}.`);
        this._finish(record, "failed", { error: reason });
      }
    }
  }
}

export function createJobs(opts) {
  return new Jobs(opts);
}
