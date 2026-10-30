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
 * The job queue (heavy jobs). Installing packages and building a website eats
 * a server's CPU and memory; several at once can take the server down. A job
 * started with `heavy: true` and `servers: [serverId, …]` (the servers it will
 * load — default `[serverId || "main"]`) is only admitted while every one of
 * those servers has a free slot: `config.queue.perServer` heavy jobs per
 * server (1–8, default 1). Until then it waits in ONE ordered queue, in the
 * order it was started; admins can reorder it (`move`), force a job to run now
 * regardless of slots (`forceStart`, may exceed the limit on purpose) or
 * cancel it. Light jobs (restarts, env changes, status checks…) never wait in
 * this queue — only behind their lock, as before.
 *   - Order is kept per server and per lock: a later job never jumps a waiting
 *     earlier one that needs the same server slot or the same lock (it may
 *     overtake one that waits for a different server).
 *   - A heavy job started INSIDE a running heavy job (a sub-job) runs under its
 *     parent's slots: it neither claims slots nor waits for them.
 *   - Nothing is held while waiting: neither the lock nor a slot.
 *   - Waiting jobs live in memory (their functions can't be saved), so a panel
 *     restart cancels them (`recover()`), with a message saying so.
 *   - `start(meta, fn, { onDropped })`: onDropped(reason) runs when a job is
 *     cancelled before its function ever ran, so a caller that created records
 *     up front (a backup row, a test run) can close them.
 * SSE `queue` carries the queue (see `queue()`) whenever it changes.
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
export const QUEUE_DEFAULT_PER_SERVER = 1;
export const QUEUE_MAX_PER_SERVER = 8;
export const RESTART_DROPPED =
  "The panel restarted while this job was waiting in the job queue, so it never ran. Start it again when you're ready.";

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

/** A clean list of server ids (strings, unique, at most 32). */
function serverList(list, fallback) {
  const src = Array.isArray(list) ? list : list ? [list] : [];
  const out = [...new Set(src.map((s) => String(s || "").trim()).filter(Boolean))].slice(0, 32);
  return out.length ? out : [fallback];
}

/** Clamp a per-server limit to 1..8 (anything unusable → the default). */
export function clampPerServer(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return QUEUE_DEFAULT_PER_SERVER;
  return Math.min(QUEUE_MAX_PER_SERVER, n);
}

export class Jobs {
  constructor({ db, dataDir, events, config = null }) {
    this.db = db;
    this.events = events;
    this.config = config; // reads config.queue.perServer live
    this.logsDir = path.join(dataDir, "logs");
    fs.mkdirSync(this.logsDir, { recursive: true });
    this.live = new Map(); // id -> { controller, stream, finished, lock, owner, lastLine }
    this.waiters = new Map(); // id -> [resolve]
    this.lockOwner = new Map(); // lock -> jobId
    this.waiting = []; // ordered: { record, fn, held, lock, owner, heavy, servers, forced, onDropped }
    this.slots = new Map(); // jobId -> { servers, forced }: heavy jobs holding server slots
    this.pendingLines = new Map(); // id -> [line]
    this.flushTimer = null;
    this.als = new AsyncLocalStorage(); // store: { locks: Set, heavy: jobId | null }
    this._pumping = false;
    this._pumpAgain = false;
    this._queueSig = "";
  }

  /**
   * At boot nothing can still be running: whatever was is now failed. Heavy
   * jobs that were still waiting in the job queue never started: cancelled.
   */
  recover() {
    let changed = 0;
    for (const j of this.db.list("jobs")) {
      if (DONE.has(j.status)) continue;
      if (j.status === "queued" && j.heavy) {
        j.status = "cancelled";
        j.error = RESTART_DROPPED;
        j.position = null;
        try {
          fs.appendFileSync(this.logPath(j.id), `${RESTART_DROPPED}\n`, { mode: 0o600 });
        } catch { /* ignore */ }
      } else {
        j.status = "failed";
        j.error = "panel restarted";
      }
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

  start(meta = {}, fn, { onDropped = null } = {}) {
    if (typeof fn !== "function") throw new Error("jobs.start needs a function");
    const { lock: lockOpt, heavy: heavyOpt, servers: serversOpt, ...rest } = meta;
    const heavy = !!heavyOpt;
    const servers = heavy ? serverList(serversOpt, meta.serverId || "main") : null;
    const held = this.als.getStore();
    // Inside a running heavy job: run under its slots (never wait for them).
    const inherited = heavy && held?.heavy ? held.heavy : null;
    const record = {
      ...serializable(rest),
      id: this.db.newId("job"),
      type: String(meta.type || "job"),
      title: String(meta.title || meta.type || "Job"),
      status: "queued",
      ...Object.fromEntries(FIELDS.map((k) => [k, meta[k] ?? null])),
      ...(heavy ? { heavy: true, servers, position: null, forced: false, ...(inherited ? { parentJobId: inherited } : {}) } : {}),
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      error: null,
      result: null,
    };
    this.db.insert("jobs", record);
    this._prune();

    const lock = lockOpt === false ? null : lockOpt || (meta.siteId ? `site:${meta.siteId}` : meta.databaseId ? `database:${meta.databaseId}` : null);
    const reentrant = !!(lock && held?.locks?.has(lock));
    const w = {
      record,
      fn,
      held,
      lock,
      owner: !!lock && !reentrant,
      heavy: heavy && !inherited, // claims slots
      servers: servers || [],
      forced: false,
      onDropped: typeof onDropped === "function" ? onDropped : null,
    };
    this.waiting.push(w);
    this._pump();

    if (record.status === "queued") {
      const lockBlocker = w.owner && this.lockOwner.has(lock) ? this.db.get("jobs", this.lockOwner.get(lock)) : null;
      if (lockBlocker) this.log(record.id, `Queued — waiting for "${lockBlocker.title || "another job"}" to finish.`);
      else if (w.heavy) {
        const on = this._runningOn(w.servers).map((j) => `"${j.title}"`);
        this.log(
          record.id,
          `Waiting in the job queue (position ${record.position}) — at most ${this.perServer()} heavy job${this.perServer() === 1 ? "" : "s"} per server run at once` +
            (on.length ? `; ${on.slice(0, 3).join(", ")} ${on.length === 1 ? "is" : "are"} running there now.` : "."),
        );
      } else this.log(record.id, "Queued — waiting for an earlier job on the same thing to start first.");
      this._emit(record);
    }
    return record;
  }

  // ------------------------------------------------------------- admission

  /** Heavy jobs allowed per server at once (config.queue.perServer, 1–8). */
  perServer() {
    return clampPerServer(this.config?.queue?.perServer);
  }

  /** Change the limit (the caller saves config.json). Admits what now fits. */
  setPerServer(n) {
    const v = clampPerServer(n);
    if (this.config) this.config.queue = { ...(this.config.queue || {}), perServer: v };
    this._queueSig = ""; // the limit is part of the snapshot
    this._pump();
    return v;
  }

  _used(serverId) {
    let n = 0;
    for (const s of this.slots.values()) if (s.servers.includes(serverId)) n++;
    return n;
  }

  _runningOn(servers) {
    const out = [];
    for (const [id, s] of this.slots) {
      if (s.servers.some((x) => servers.includes(x))) {
        const j = this.get(id);
        if (j) out.push(j);
      }
    }
    return out;
  }

  /**
   * Start every waiting job that may run now, in queue order. A job that
   * can't start reserves its lock (and, when it is short of slots, its
   * servers) for itself, so nothing later in line overtakes it there.
   */
  _pump() {
    if (this._pumping) {
      this._pumpAgain = true;
      return;
    }
    this._pumping = true;
    try {
      do {
        this._pumpAgain = false;
        const limit = this.perServer();
        const blockedLocks = new Set();
        const blockedServers = new Set();
        for (const w of [...this.waiting]) {
          if (DONE.has(w.record.status)) {
            this._unqueue(w.record.id);
            continue;
          }
          const lockFree = !w.owner || (!this.lockOwner.has(w.lock) && !blockedLocks.has(w.lock));
          const slotsFree = !w.heavy || w.servers.every((s) => !blockedServers.has(s) && this._used(s) < limit);
          if (lockFree && slotsFree) {
            this._unqueue(w.record.id);
            this._begin(w);
            continue;
          }
          if (w.owner) blockedLocks.add(w.lock);
          if (w.heavy && !slotsFree) for (const s of w.servers) blockedServers.add(s);
        }
      } while (this._pumpAgain);
    } finally {
      this._pumping = false;
    }
    this._syncPositions();
    this._emitQueue();
  }

  _unqueue(id) {
    const i = this.waiting.findIndex((x) => x.record.id === id);
    if (i === -1) return null;
    return this.waiting.splice(i, 1)[0];
  }

  _begin(w) {
    if (w.owner) this.lockOwner.set(w.lock, w.record.id);
    if (w.heavy) this.slots.set(w.record.id, { servers: w.servers, forced: !!w.forced });
    if (w.record.heavy) w.record.position = null;
    this._run(w.record, w.fn, { lock: w.lock, owner: w.owner, held: w.held, heavyRoot: w.heavy });
  }

  _syncPositions() {
    let n = 0;
    for (const w of this.waiting) if (w.heavy) w.record.position = ++n;
  }

  _run(record, fn, { lock, owner, held, heavyRoot = false }) {
    const controller = new AbortController();
    const entry = { controller, stream: null, finished: false, lock, owner, graceTimer: null, lastLine: "" };
    this.live.set(record.id, entry);
    record.status = "running";
    record.startedAt = nowIso();
    this.db.save();
    this._emit(record);

    const store = { locks: new Set(held?.locks || []), heavy: heavyRoot ? record.id : held?.heavy || null };
    if (lock) store.locks.add(lock);
    const log = (line) => this.log(record.id, line);

    this.als.run(store, () => {
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
    if (record.heavy) record.position = null;
    this.db.save();
    this._emit(record);
    if (entry?.stream) entry.stream.end();
    this.live.delete(record.id);

    for (const resolve of this.waiters.get(record.id) || []) resolve(record);
    this.waiters.delete(record.id);

    if (entry?.owner && entry.lock && this.lockOwner.get(entry.lock) === record.id) this.lockOwner.delete(entry.lock);
    this.slots.delete(record.id);
    this._pump();
    this._prune();
  }

  // ------------------------------------------------------- queue control

  /**
   * The job queue: heavy jobs holding slots (running) and heavy jobs waiting,
   * in order. { perServer, running: [item], waiting: [item] } where item is
   * { id, type, title, status, projectId, siteId, serverId, adminId, servers,
   *   forced, position, createdAt, startedAt, lastLine, waitingFor: [title] }.
   */
  queue() {
    const item = (j, extra) => ({
      id: j.id,
      type: j.type,
      title: j.title,
      status: j.status,
      projectId: j.projectId ?? null,
      siteId: j.siteId ?? null,
      serverId: j.serverId ?? null,
      databaseId: j.databaseId ?? null,
      adminId: j.adminId ?? null,
      servers: j.servers || [],
      forced: !!j.forced,
      position: j.position ?? null,
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      ...extra,
    });
    const running = [];
    for (const [id, s] of this.slots) {
      const j = this.get(id);
      if (j) running.push(item(j, { servers: s.servers, forced: !!s.forced, lastLine: this.live.get(id)?.lastLine || "" }));
    }
    running.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const waiting = this.waiting
      .filter((w) => w.heavy)
      .map((w) => {
        const lockBy = w.owner && this.lockOwner.has(w.lock) ? this.get(this.lockOwner.get(w.lock)) : null;
        const waitingFor = lockBy ? [lockBy.title] : this._runningOn(w.servers).map((j) => j.title);
        return item(w.record, { waitingFor });
      });
    return { perServer: this.perServer(), maxPerServer: QUEUE_MAX_PER_SERVER, running, waiting };
  }

  _emitQueue() {
    const q = this.queue();
    const sig = JSON.stringify([q.perServer, q.running.map((r) => [r.id, r.forced]), q.waiting.map((w) => [w.id, w.waitingFor])]);
    if (sig === this._queueSig) return;
    this._queueSig = sig;
    this.events?.broadcast("queue", q);
  }

  _waitingHeavy(id) {
    const w = this.waiting.find((x) => x.record.id === id);
    if (!w) throw Object.assign(new Error("That job isn't waiting in the queue any more."), { code: "not_waiting" });
    if (!w.heavy) throw Object.assign(new Error("That job isn't in the job queue — it waits for another job on the same thing."), { code: "not_queued" });
    return w;
  }

  /**
   * Move a waiting job. `to`: "top" | "bottom" | "up" | "down", or `index`
   * (0-based among the waiting heavy jobs). Returns the queue.
   */
  move(id, { to = null, index = null } = {}) {
    this._waitingHeavy(id);
    const heavy = this.waiting.filter((w) => w.heavy);
    const spots = this.waiting.map((w, k) => (w.heavy ? k : -1)).filter((k) => k !== -1);
    const from = heavy.findIndex((w) => w.record.id === id);
    let dest =
      to === "top" ? 0 : to === "bottom" ? heavy.length - 1 : to === "up" ? from - 1 : to === "down" ? from + 1 : Number.isInteger(Number(index)) && index !== null && index !== "" ? Number(index) : NaN;
    if (Number.isNaN(dest)) throw Object.assign(new Error('Say where to move it: to "top", "bottom", "up", "down" or an index.'), { code: "bad_move" });
    dest = Math.max(0, Math.min(heavy.length - 1, dest));
    if (dest !== from) {
      const [w] = heavy.splice(from, 1);
      heavy.splice(dest, 0, w);
      spots.forEach((k, n) => (this.waiting[k] = heavy[n]));
      this.log(id, `Moved to position ${dest + 1} in the job queue.`);
      this._pump();
    }
    return this.queue();
  }

  /**
   * Run a waiting heavy job now, whatever the slots say (the server may run
   * more heavy jobs than the limit while it does). Its lock still applies: a
   * job can't be forced past another job on the same website.
   */
  forceStart(id, { by } = {}) {
    const w = this._waitingHeavy(id);
    if (w.owner && this.lockOwner.has(w.lock)) {
      const blocker = this.get(this.lockOwner.get(w.lock));
      throw Object.assign(new Error(`It can't start before "${blocker?.title || "another job"}" finishes — they work on the same thing.`), {
        code: "locked",
        jobId: blocker?.id || null,
      });
    }
    this._unqueue(id);
    w.forced = true;
    w.record.forced = true;
    const over = w.servers.filter((s) => this._used(s) >= this.perServer());
    this.log(id, `Force-started${by ? ` by ${by}` : ""}${over.length ? ` — running alongside other heavy jobs on ${over.join(", ")}` : ""}.`);
    this._begin(w);
    this._pump();
    return this.get(id);
  }

  /** Re-run admission (e.g. after config.queue changed elsewhere). */
  pump() {
    this._pump();
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
    if (entry) entry.lastLine = lines[lines.length - 1];
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
      const w = this._unqueue(id);
      this.log(id, `Cancelled${by ? ` by ${by}` : ""} before it started.`);
      this._dropped(w, "Cancelled before it started.");
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

  /** A job that never ran is gone: let its starter clean up after it. */
  _dropped(w, reason) {
    if (!w?.onDropped) return;
    try {
      w.onDropped(reason);
    } catch (err) {
      console.error(`[fcc] job ${w.record.id}: cleanup after cancel failed:`, err.message);
    }
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
    const waiting = this.waiting.splice(0);
    for (const w of waiting) {
      const { record } = w;
      if (w.heavy) {
        record.status = "cancelled";
        record.error = `${reason[0].toUpperCase()}${reason.slice(1)} while this job was waiting in the job queue, so it never ran. Start it again when you're ready.`;
        record.position = null;
      } else {
        record.status = "failed";
        record.error = reason;
      }
      record.finishedAt = nowIso();
      this._dropped(w, record.error);
    }
    if (waiting.length) this.db.save();
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
