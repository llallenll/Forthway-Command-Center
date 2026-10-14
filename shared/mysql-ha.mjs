/**
 * Database replication — the agent side of docs/HA.md, Phase 3.
 *
 * Runs on agent servers (through node/node-agent.mjs) and in-process on main
 * (shared/tasks.mjs → executeTask). Every task does one fixed job with
 * validated inputs; there is no "run this SQL" task.
 *
 *   mysql.primary.prepare  binlog + GTID + server_id + bind 0.0.0.0, fcc_repl / fcc_admin accounts, ufw 3306
 *   mysql.replica.setup    version preflight, install / upgrade the same flavor (same or newer series than the
 *                          primary; vendor APT repository when the distro's is too old), replica settings,
 *                          seed from the primary, start replication
 *   mysql.status           flavor, version, read_only, role, replica threads / lag / GTIDs
 *   mysql.replica.promote  drain the relay log, drop the replica settings, read_only OFF
 *   mysql.readonly         fence / unfence (runtime + managed config file), fast
 *   mysql.users.sync       create / re-password / grant / drop website users (sql_log_bin=0 on a replica)
 *   mysql.rebuild          safety dump + drop every database, then exactly mysql.replica.setup
 *
 * How it talks to MySQL (same rules as panel/lib/mysql.mjs, whose helpers are
 * mirrored here because agents only receive node/, shared/ and sys.mjs):
 *   - the local server as root over the unix socket (`mysql -u root`, OS root);
 *   - the primary over TCP as fcc_repl with the password in MYSQL_PWD;
 *   - SQL — which may carry a password — only ever on the client's stdin, every
 *     value through sqlString(), every identifier validated then backtick-quoted.
 *   Passwords never reach argv and never a log line (errors are scrubbed, dry-run
 *   SQL is printed with ••••).
 *
 * Managed configuration file (one per server, atomic, rewritten only when its
 * content differs; MySQL is restarted only when something other than read_only
 * changed, and the previous file is put back if the server does not come up):
 *   MySQL    /etc/mysql/mysql.conf.d/zzz-fcc-replication.cnf
 *   MariaDB  /etc/mysql/mariadb.conf.d/99-zz-fcc-replication.cnf
 * The names sort after the installer's own drop-in (zz-fcc.cnf / 99-fcc.cnf,
 * which sets bind-address), so our bind-address wins.
 *
 * FCC_DRY_RUN=1: every command and every SQL script (passwords masked) is
 * logged with "[dry-run]"; nothing outside dataDir is written. The server's
 * state is simulated in <dataDir>/mysql-ha-dry.json, so prepare / setup /
 * promote / readonly change what mysql.status reports.
 *
 * Dry-run simulation hook (read ONLY when FCC_DRY_RUN=1, ignored otherwise):
 * FCC_MYSQL_DRY_SIM is inline JSON or the path of a JSON file describing the
 * facts the version preflight would read from the machine and the primary:
 *   { "primary": "8.4.3",                  // primary's VERSION() (default: same as a fresh dry install)
 *     "primaryComment": "MySQL Community Server - GPL",
 *     "os": { "id": "ubuntu", "codename": "noble" },   "arch": "amd64",
 *     "distro": { "mysql-server": "8.0.39-0ubuntu0.24.04.2" },  // apt candidates before any repo is added
 *     "vendorCandidate": { "mysql-server": "8.4.3-1ubuntu24.04" }, // after the vendor repo (default: its series)
 *     "repoSuites": ["jammy", "noble", "bookworm"],   // codenames the vendor repo publishes
 *     "repoComponents": ["mysql-8.0", "mysql-8.4-lts", "mysql-9.7-lts", "mysql-innovation"],
 *     "installedPackages": ["mysql-community-server"], // dpkg answers
 *     "dump": "8.0.39",                              // mysqldump --version (default: the server's)
     "seedBytes": 2576980378, "seedSeconds": 24,     // the simulated copy (progress bar, 3.9.2)
     "catchUpChanges": 1480, "catchUpSeconds": 14 }  // then the simulated replica catching up
 * The local server itself is the simulated one in mysql-ha-dry.json (write
 * { "installed": true, "flavor", "version", "databases": [] } there first to
 * simulate an installed server).
 *
 * Test hook (inert in production): when FCC_MYSQL_TEST_DEFAULTS names a JSON
 * file and FCC_DRY_RUN is not set, "the local server" is whatever that file
 * says — used only to run these tasks against throwaway mysqld instances:
 *   { "client":  ["--socket=/tmp/a/mysql.sock", "-u", "root"],   // replaces ["-u", "root"]
 *     "cnfFile": "/tmp/a/fcc-replication.cnf",                    // replaces the managed path
 *     "restart": ["/bin/sh", "/tmp/a/restart.sh"] }               // replaces systemctl restart
 * With the hook nothing is installed with apt. Nothing sets this variable in
 * any unit file or installer; only someone who can already run commands as the
 * agent's user could.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { ensureDir, exists } from "./fsx.mjs";
import { syncUfwRules } from "./edge.mjs";
import * as sys from "../panel/lib/sys.mjs";

const NOOP = () => {};

export const REPL_USER = "fcc_repl";
export const ADMIN_USER = "fcc_admin";
export const CNF_FILES = Object.freeze({
  mysql: "/etc/mysql/mysql.conf.d/zzz-fcc-replication.cnf",
  mariadb: "/etc/mysql/mariadb.conf.d/99-zz-fcc-replication.cnf",
});
export const SAFETY_DUMP_DIR = "/var/backups";
const SERVICE = { mysql: "mysql", mariadb: "mariadb" };
const PACKAGES = {
  mysql: { server: ["mysql-server", "mysql-client"], client: ["mysql-client"] },
  mariadb: { server: ["mariadb-server", "mariadb-client"], client: ["mariadb-client"] },
};
const UFW_COMMENT = "fcc mysql from cluster";
const SYSTEM_DBS = new Set(["mysql", "information_schema", "performance_schema", "sys"]);
const USER_RE = /^[a-z][a-z0-9_]{0,31}$/;
const GRANT_DB_RE = /^[a-z][a-z0-9_]{0,63}$/; // panel-made database names (users.sync)
const ANY_DB_RE = /^[A-Za-z0-9_$][A-Za-z0-9_$@#-]{0,63}$/; // existing databases we dump / drop
const STATE_FILE = "mysql-ha.json";
const DRY_STATE_FILE = "mysql-ha-dry.json";
const DRY_PRIMARY_DBS = ["acme_shop", "acme_blog"]; // what a simulated primary holds
const READY_WAIT_MS = 180_000;
const RESTART_TIMEOUT_MS = 10 * 60_000;
const PROGRESS_EVERY_MS = 15_000;
const NOT_RUNNING_CODES = new Set([2002, 2003, 2006, 2013]);

// Every script starts by making backslash escapes active, so sqlString's `\\` is one backslash.
const PRELUDE = "SET SESSION sql_mode = (SELECT REPLACE(@@SESSION.sql_mode, 'NO_BACKSLASH_ESCAPES', ''));\n";

// =================================================================== the syntax table
//
// THE one place that knows which statement / variable / dump option each
// flavor and version uses. Everything else asks dialect(flavor, version).
//
//                       MySQL < 8.0.22   MySQL 8.0.22+     8.0.23+                 8.0.26+               8.2+ / 8.4 / 9.x       MariaDB 10.6 – 11.x
//   status              SHOW SLAVE STATUS SHOW REPLICA STATUS                                                                     SHOW SLAVE STATUS
//   start/stop/reset    START SLAVE …    START REPLICA …                                                                         START SLAVE …
//   point at primary    CHANGE MASTER TO MASTER_AUTO_POSITION=1  CHANGE REPLICATION SOURCE TO SOURCE_AUTO_POSITION=1             CHANGE MASTER TO MASTER_USE_GTID=slave_pos
//   wipe binlog+GTIDs   RESET MASTER                                                                      RESET BINARY LOGS AND GTIDS   RESET MASTER (+ gtid_slave_pos='')
//   cnf: log updates    log_slave_updates                                        log_replica_updates                                log_slave_updates
//   cnf: binlog_format  ROW (written)                                                                     (omitted: deprecated, ROW is the default)  ROW
//   cnf: GTID           gtid_mode=ON + enforce_gtid_consistency=ON                                                              (native, nothing)
//   dump position       --set-gtid-purged=ON --master-data=2                     --set-gtid-purged=ON --source-data=2           --gtid --master-data=1
//   status fields       Slave_IO_Running, Seconds_Behind_Master, Master_Host …   (8.0.22+) Replica_IO_Running, Seconds_Behind_Source, Source_Host …   Slave_* + Gtid_IO_Pos / Gtid_Slave_Pos
//   drain relay log     WAIT_FOR_EXECUTED_GTID_SET(set, s) → 0 ok, 1 timeout                                                    MASTER_GTID_WAIT(pos, s) → 0 ok, -1 timeout
//   executed GTIDs      @@GLOBAL.gtid_executed                                                                                  @@GLOBAL.gtid_current_pos

export function parseVersion(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atLeast(v, a, b, c) {
  for (const [x, y] of [[v[0], a], [v[1], b], [v[2], c]]) {
    if (x !== y) return x > y;
  }
  return true;
}

export function flavorOf(version) {
  return /mariadb/i.test(String(version || "")) ? "mariadb" : "mysql";
}

export function dialect(flavor, version) {
  if (flavor !== "mysql" && flavor !== "mariadb") throw new Error(`Unknown database flavor "${flavor}"`);
  const v = parseVersion(version) || (flavor === "mariadb" ? [10, 6, 0] : [8, 0, 0]);
  if (flavor === "mariadb") {
    return {
      flavor,
      version: v.join("."),
      showReplicaStatus: "SHOW SLAVE STATUS",
      startReplica: "START SLAVE",
      stopReplica: "STOP SLAVE",
      stopIoThread: "STOP SLAVE IO_THREAD",
      startIoThread: "START SLAVE IO_THREAD",
      resetReplicaAll: "RESET SLAVE ALL",
      resetBinlogs: "RESET MASTER",
      clearGtidState: ["RESET MASTER", "SET GLOBAL gtid_slave_pos = ''"],
      logReplicaUpdates: "log_slave_updates",
      binlogFormatLine: true,
      gtidCnf: [],
      logBinCnf: "log_bin = mysql-bin",
      dumpPositionFlags: ["--gtid", "--master-data=1"],
      executedGtidExpr: "@@GLOBAL.gtid_current_pos",
      sourceGtidExpr: "@@GLOBAL.gtid_binlog_pos",
      setSeedGtid: (pos) => `SET GLOBAL gtid_slave_pos = ${sqlString(cleanGtid("mariadb", pos))}`,
      fields: { io: "Slave_IO_Running", sql: "Slave_SQL_Running", lag: "Seconds_Behind_Master", source: "Master_Host", retrieved: "Gtid_IO_Pos", executed: "Gtid_Slave_Pos" },
      waitForGtid: (pos, sec) => `SELECT MASTER_GTID_WAIT(${sqlString(cleanGtid("mariadb", pos))}, ${Math.max(0, Math.floor(sec))})`,
      waitOk: (r) => String(r) === "0",
      appliedCheck: (pos) => `SELECT IF(MASTER_GTID_WAIT(${sqlString(cleanGtid("mariadb", pos))}, 0) = 0, 1, 0)`,
      superReadOnly: false,
      clientExtra: [],
      changeSource: ({ host, port, user, password, ssl }) =>
        `CHANGE MASTER TO MASTER_HOST = ${sqlString(host)}, MASTER_PORT = ${Number(port)}, MASTER_USER = ${sqlString(user)}, MASTER_PASSWORD = ${sqlString(password)}, MASTER_USE_GTID = slave_pos, MASTER_CONNECT_RETRY = 10${ssl ? ", MASTER_SSL = 1" : ""}`,
    };
  }
  const replicaKw = atLeast(v, 8, 0, 22);
  const sourceKw = atLeast(v, 8, 0, 23);
  const newNames = atLeast(v, 8, 0, 26);
  const resetBinlogs = atLeast(v, 8, 2, 0) ? "RESET BINARY LOGS AND GTIDS" : "RESET MASTER";
  return {
    flavor,
    version: v.join("."),
    showReplicaStatus: replicaKw ? "SHOW REPLICA STATUS" : "SHOW SLAVE STATUS",
    startReplica: replicaKw ? "START REPLICA" : "START SLAVE",
    stopReplica: replicaKw ? "STOP REPLICA" : "STOP SLAVE",
    stopIoThread: replicaKw ? "STOP REPLICA IO_THREAD" : "STOP SLAVE IO_THREAD",
    startIoThread: replicaKw ? "START REPLICA IO_THREAD" : "START SLAVE IO_THREAD",
    resetReplicaAll: replicaKw ? "RESET REPLICA ALL" : "RESET SLAVE ALL",
    resetBinlogs,
    clearGtidState: [resetBinlogs],
    logReplicaUpdates: newNames ? "log_replica_updates" : "log_slave_updates",
    binlogFormatLine: !atLeast(v, 8, 4, 0),
    gtidCnf: ["gtid_mode = ON", "enforce_gtid_consistency = ON"],
    logBinCnf: "log_bin = binlog",
    dumpPositionFlags: ["--set-gtid-purged=ON", newNames ? "--source-data=2" : "--master-data=2"],
    executedGtidExpr: "@@GLOBAL.gtid_executed",
    sourceGtidExpr: "@@GLOBAL.gtid_executed",
    setSeedGtid: (set) => `SET GLOBAL gtid_purged = ${sqlString(cleanGtid("mysql", set))}`,
    fields: replicaKw
      ? { io: "Replica_IO_Running", sql: "Replica_SQL_Running", lag: "Seconds_Behind_Source", source: "Source_Host", retrieved: "Retrieved_Gtid_Set", executed: "Executed_Gtid_Set" }
      : { io: "Slave_IO_Running", sql: "Slave_SQL_Running", lag: "Seconds_Behind_Master", source: "Master_Host", retrieved: "Retrieved_Gtid_Set", executed: "Executed_Gtid_Set" },
    waitForGtid: (set, sec) => `SELECT WAIT_FOR_EXECUTED_GTID_SET(${sqlString(cleanGtid("mysql", set))}, ${Math.max(0, Math.floor(sec))})`,
    waitOk: (r) => String(r) === "0",
    appliedCheck: (set) => `SELECT GTID_SUBSET(${sqlString(cleanGtid("mysql", set))}, @@GLOBAL.gtid_executed)`,
    superReadOnly: true,
    clientExtra: ["--get-server-public-key"],
    changeSource: ({ host, port, user, password, ssl }) =>
      sourceKw
        ? `CHANGE REPLICATION SOURCE TO SOURCE_HOST = ${sqlString(host)}, SOURCE_PORT = ${Number(port)}, SOURCE_USER = ${sqlString(user)}, SOURCE_PASSWORD = ${sqlString(password)}, SOURCE_AUTO_POSITION = 1, GET_SOURCE_PUBLIC_KEY = 1, SOURCE_CONNECT_RETRY = 10${ssl ? ", SOURCE_SSL = 1" : ""}`
        : `CHANGE MASTER TO MASTER_HOST = ${sqlString(host)}, MASTER_PORT = ${Number(port)}, MASTER_USER = ${sqlString(user)}, MASTER_PASSWORD = ${sqlString(password)}, MASTER_AUTO_POSITION = 1${atLeast(v, 8, 0, 4) ? ", GET_MASTER_PUBLIC_KEY = 1" : ""}, MASTER_CONNECT_RETRY = 10${ssl ? ", MASTER_SSL = 1" : ""}`,
  };
}

/** A GTID set / position as reported by the server, checked before it goes back into SQL. */
export function cleanGtid(flavor, s) {
  const t = String(s ?? "").replace(/\s+/g, "");
  const ok = flavor === "mariadb" ? /^[0-9,-]*$/.test(t) : /^[A-Za-z0-9_:,-]*$/.test(t);
  if (!ok || t.length > 65_000) throw new Error("Refusing an unexpected GTID value from the server.");
  return t;
}

// =================================================================== sync progress (pure; unit-testable)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse a GTID set into Map<key, [[from, to], …]> (sorted, merged, inclusive).
 *   MySQL    "uuid:1-5:7-9,uuid2:1-3"   (8.3+ tagged: "uuid:tag:1-5" — key "uuid:tag")
 *   MariaDB  "0-1-100,1-2-50"            (domain-server-seq — key "d<domain>", interval [1, seq])
 * MariaDB positions are per replication domain: everything up to `seq` in that domain.
 * Returns null for anything that is not a GTID set ("" → empty map).
 */
export function parseGtidSet(s) {
  const text = String(s ?? "").replace(/\s+/g, "");
  const out = new Map();
  if (!text) return out;
  const add = (key, a, b) => {
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < a) return false;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push([a, b]);
    return true;
  };
  for (const part of text.split(",")) {
    if (!part) continue;
    const maria = /^(\d+)-(\d+)-(\d+)$/.exec(part);
    if (maria) {
      const key = `d${Number(maria[1])}`;
      const seq = Number(maria[3]);
      if (seq === 0) continue;
      // Several entries for one domain (different server ids): the highest seq wins.
      const prev = out.get(key);
      if (prev) prev[0][1] = Math.max(prev[0][1], seq);
      else if (!add(key, 1, seq)) return null;
      continue;
    }
    const segs = part.split(":");
    if (!UUID_RE.test(segs[0])) return null;
    let key = segs[0].toLowerCase();
    for (const seg of segs.slice(1)) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(seg);
      if (!m) {
        if (!/^[a-z_][a-z0-9_]{0,31}$/i.test(seg)) return null;
        key = `${segs[0].toLowerCase()}:${seg.toLowerCase()}`; // a tag: the ranges after it belong to uuid:tag
        continue;
      }
      if (!add(key, Number(m[1]), Number(m[2] ?? m[1]))) return null;
    }
  }
  for (const [k, list] of out) {
    list.sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const [a, b] of list) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    out.set(k, merged);
  }
  return out;
}

/** Number of transactions in a GTID set (null when it can't be parsed). */
export function gtidCount(s) {
  const m = parseGtidSet(s);
  if (!m) return null;
  let n = 0;
  for (const list of m.values()) for (const [a, b] of list) n += b - a + 1;
  return n;
}

/** |A − B|: transactions in set `a` that are not in set `b` (null when either can't be parsed). */
export function gtidDiffCount(a, b) {
  const A = parseGtidSet(a);
  const B = parseGtidSet(b);
  if (!A || !B) return null;
  let n = 0;
  for (const [k, list] of A) {
    const sub = B.get(k) || [];
    for (const [a0, a1] of list) {
      let covered = 0;
      for (const [b0, b1] of sub) {
        if (b1 < a0) continue;
        if (b0 > a1) break;
        covered += Math.min(a1, b1) - Math.max(a0, b0) + 1;
      }
      n += a1 - a0 + 1 - covered;
    }
  }
  return n;
}

const DB_MARKER = Buffer.from("\n-- Current Database: `");
const DB_MARKER_SPAN = DB_MARKER.length + 66; // marker + a database name (≤ 64) + closing backtick

/**
 * Finds mysqldump's "-- Current Database: `name`" comments in a stream of
 * chunks without copying them (Buffer.indexOf; only the last few dozen bytes
 * of a chunk are kept to catch a marker split across two chunks). Calls
 * onDatabase(name, offset) once per marker, offset = where it starts in the stream.
 */
export class DumpScanner {
  constructor(onDatabase) {
    this.onDatabase = onDatabase;
    this.offset = 0; // stream bytes before the current chunk
    this.carry = Buffer.alloc(0);
    this.lastAt = -1;
  }
  /** Bytes that passed without being scanned (simulation). */
  skip(n) {
    this.offset += n;
    this.carry = Buffer.alloc(0);
  }
  push(chunk) {
    const base = this.offset;
    if (this.carry.length) {
      // A marker that starts in the carried tail and ends in this chunk.
      const head = Buffer.concat([this.carry, chunk.subarray(0, DB_MARKER_SPAN)]);
      this.#scan(head, base - this.carry.length, this.carry.length);
    }
    this.#scan(chunk, base, chunk.length);
    this.offset += chunk.length;
    // The last DB_MARKER_SPAN bytes of the stream so far — a copy: never pin a whole chunk.
    this.carry =
      chunk.length >= DB_MARKER_SPAN
        ? Buffer.from(chunk.subarray(chunk.length - DB_MARKER_SPAN))
        : Buffer.from(Buffer.concat([this.carry, chunk]).subarray(-DB_MARKER_SPAN));
  }
  #scan(buf, at, startBefore) {
    let i = buf.indexOf(DB_MARKER);
    while (i !== -1 && i < startBefore) {
      const nameStart = i + DB_MARKER.length;
      const end = buf.indexOf(0x60, nameStart); // closing backtick
      if (end === -1 || end - nameStart > 64) {
        if (end === -1) return; // split: the next chunk's head scan finds it
      } else if (at + i > this.lastAt) {
        this.lastAt = at + i;
        this.onDatabase(buf.toString("utf8", nameStart, end), at + i);
      }
      i = buf.indexOf(DB_MARKER, i + 1);
    }
  }
}

/**
 * Seed copy progress: bytes streamed through mysqldump | mysql against an
 * estimate from the primary's information_schema. A SQL dump is not the size
 * of the data on disk (no index pages, text numbers, hex blobs, page slack), so
 * the estimate starts from data_length × PRIOR and is recalibrated with the
 * observed dump-bytes-per-data-byte ratio as each database finishes. Never
 * reports more than 99 % — 100 % comes from done() once the import has exited.
 *
 * sizes: { [db]: { data, index, rows } } or null (no estimate → percent null).
 */
export class SeedEstimator {
  static PRIOR = 1.0;
  constructor({ databases = [], sizes = null, startedAt = Date.now() } = {}) {
    this.databases = databases.slice();
    this.sizes = sizes;
    this.startedAt = startedAt;
    this.bytes = 0;
    this.cur = null;
    this.curStart = 0;
    this.done = new Set();
    this.doneBytes = 0;
    this.doneBasis = 0;
    this.rate = null; // smoothed bytes/s
    this.rateAt = startedAt;
    this.rateBytes = 0;
    this.finished = false;
  }
  basisOf(db) {
    const s = this.sizes?.[db];
    return s ? Math.max(0, Number(s.data) || 0) : 0;
  }
  get totalBasis() {
    return this.databases.reduce((n, d) => n + this.basisOf(d), 0);
  }
  onDatabase(name, offset) {
    if (this.cur && !this.done.has(this.cur)) {
      this.done.add(this.cur);
      this.doneBytes += Math.max(0, offset - this.curStart);
      this.doneBasis += this.basisOf(this.cur);
    }
    this.cur = name;
    this.curStart = offset;
  }
  add(n, now = Date.now()) {
    this.bytes += n;
    this.#tickRate(now);
  }
  #tickRate(now) {
    const dt = (now - this.rateAt) / 1000;
    if (dt < 1) return;
    const inst = (this.bytes - this.rateBytes) / dt;
    // Exponential smoothing with a ~10 s time constant, whatever the sampling interval.
    const a = 1 - Math.exp(-dt / 10);
    this.rate = this.rate == null ? inst : this.rate + a * (inst - this.rate);
    this.rateAt = now;
    this.rateBytes = this.bytes;
  }
  /** Observed dump bytes per byte of data_length, once enough finished databases back it up. */
  ratio() {
    const total = this.totalBasis;
    if (this.doneBasis >= 8 * 1024 * 1024 || (total && this.doneBasis >= total * 0.1 && this.doneBytes >= 1024 * 1024)) {
      return Math.min(6, Math.max(0.15, this.doneBytes / Math.max(1, this.doneBasis)));
    }
    return SeedEstimator.PRIOR;
  }
  estimate() {
    if (!this.sizes || !this.totalBasis) return null;
    const r = this.ratio();
    let est = this.doneBytes;
    for (const d of this.databases) {
      if (this.done.has(d)) continue;
      const guess = this.basisOf(d) * r;
      if (d === this.cur) {
        const streamed = this.bytes - this.curStart;
        // Past its estimate: assume it is nearly done rather than jumping back.
        est += streamed > guess ? streamed * 1.03 + 65536 : guess;
      } else {
        est += guess + 2048; // DDL, routines, comments of an empty database
      }
    }
    return Math.max(Math.round(est), Math.round(this.bytes * 1.01) + 1);
  }
  snapshot(now = Date.now()) {
    this.#tickRate(now);
    const elapsed = (now - this.startedAt) / 1000;
    const enough = elapsed >= 4 && this.bytes >= 256 * 1024 && this.rate != null;
    const est = this.estimate();
    const idx = this.cur ? this.databases.indexOf(this.cur) : -1;
    const databasesDone = this.finished ? this.databases.length : this.done.size;
    let percent = null;
    let etaSeconds = null;
    if (this.finished) {
      percent = 100;
      etaSeconds = 0;
    } else if (est) {
      percent = Math.min(99, Math.floor((this.bytes / est) * 100));
      if (enough && this.rate > 0) etaSeconds = Math.max(1, Math.round((est - this.bytes) / this.rate));
    }
    return {
      phase: "copying",
      bytesDone: this.bytes,
      bytesEstimate: est,
      percent,
      rateBps: enough || this.finished ? Math.round(this.finished ? this.bytes / Math.max(0.001, elapsed) : this.rate) : null,
      etaSeconds,
      database: this.cur,
      databaseIndex: idx === -1 ? null : idx + 1,
      databasesDone,
      databasesTotal: this.databases.length,
      startedAt: new Date(this.startedAt).toISOString(),
    };
  }
  finish(now = Date.now()) {
    if (this.cur) this.onDatabase(null, this.bytes);
    this.cur = null;
    this.finished = true;
    return this.snapshot(now);
  }
}

// =================================================================== pure helpers (mirrors of panel/lib/mysql.mjs)

/** SQL string literal: printable ASCII only, quotes and backslashes doubled. */
export function sqlString(s) {
  if (typeof s !== "string" || !/^[\x20-\x7e]*$/.test(s)) throw new Error("Refusing to quote a value with non-printable characters.");
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/** Host part of an account / a server address: hostname, IPv4 or IPv6. No wildcards. */
export function validHost(h) {
  if (typeof h !== "string" || !h || h.length > 255) return false;
  if (h === "localhost") return true;
  if (net.isIP(h)) return true;
  return /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(h);
}

export function account(user, host) {
  if (typeof user !== "string" || !USER_RE.test(user)) throw new Error(`Invalid MySQL user name: ${JSON.stringify(String(user).slice(0, 40))}`);
  if (!validHost(host)) throw new Error(`Invalid host: ${JSON.stringify(String(host).slice(0, 80))}`);
  return `${sqlString(user)}@${sqlString(host)}`;
}

/** Backtick-quote the name of an existing database (validated with ANY_DB_RE). */
function quoteDb(name) {
  if (!ANY_DB_RE.test(name)) throw new Error(`Refusing unsafe database name: ${JSON.stringify(name)}`);
  return `\`${name}\``;
}

/** Database pattern for a db-level GRANT (escape `_` unless partial_revokes makes it literal). */
export function grantDbPattern(name, partialRevokes = false) {
  if (!GRANT_DB_RE.test(name) || SYSTEM_DBS.has(name)) throw new Error(`Refusing to grant on database ${JSON.stringify(name)}`);
  return `\`${partialRevokes ? name : name.replace(/_/g, "\\_")}\``;
}

/** Parse `mysql --batch --skip-column-names` output (tab separated, backslash escaped). */
export function parseRows(stdout) {
  if (!stdout) return [];
  const un = (v) => (v === "NULL" ? null : v.replace(/\\(.)/g, (_, c) => ({ n: "\n", t: "\t", 0: "\0", "\\": "\\" })[c] ?? c));
  return stdout
    .replace(/\n$/, "")
    .split("\n")
    .filter((l) => l.length)
    .map((l) => l.split("\t").map(un));
}

/** `mysql --batch` output with a header line → [{ column: value }]. */
function parseNamed(stdout) {
  const rows = parseRows(stdout);
  if (rows.length < 2) return [];
  const [head, ...data] = rows;
  return data.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? null])));
}

function validPassword(p) {
  return typeof p === "string" && p.length >= 8 && p.length <= 128 && /^[\x21-\x7e]+$/.test(p);
}

/** Replace every secret (raw and as sqlString escapes it) with ••••. */
export function maskSecrets(text, secrets = []) {
  let s = String(text ?? "");
  for (const x of secrets) {
    if (!x || x.length < 3) continue;
    const esc = x.replace(/\\/g, "\\\\").replace(/'/g, "''");
    s = s.split(esc).join("••••");
    s = s.split(x).join("••••");
  }
  return s;
}

function scrub(err, secrets) {
  const e = new Error(maskSecrets(err?.message || String(err), secrets));
  e.mysqlCode = mysqlCodeOf(err);
  if (err?.aborted) e.aborted = true;
  return e;
}

function mysqlCodeOf(err) {
  const m = /ERROR (\d{4})/.exec(String(err?.message || ""));
  return m ? Number(m[1]) : null;
}

function abortError() {
  const e = new Error("Cancelled.");
  e.aborted = true;
  return e;
}

function checkAbort(M) {
  if (M.signal?.aborted) throw abortError();
}

const sleep = (ms, signal) =>
  new Promise((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener?.("abort", () => (clearTimeout(t), res()), { once: true });
  });

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

function writeAtomic(file, content, mode) {
  ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// =================================================================== payload checks

function bad(task, msg) {
  return new Error(`${task}: ${msg} — nothing was changed on ${os.hostname()}.`);
}

function checkServerId(task, v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 4294967295) throw bad(task, `serverId must be a whole number from 1 to 4294967295 (got ${String(v).slice(0, 20)})`);
  return n;
}

function checkPort(task, v, def = 3306) {
  const n = Number(v ?? def);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw bad(task, `${String(v).slice(0, 20)} is not a valid port`);
  return n;
}

function checkUser(task, v, def) {
  const u = String(v ?? def);
  if (!USER_RE.test(u) || u === "root") throw bad(task, `${JSON.stringify(u.slice(0, 40))} is not an allowed MySQL user name`);
  return u;
}

function checkPassword(task, v, what) {
  if (!validPassword(v)) throw bad(task, `${what} must be 8–128 printable characters without spaces`);
  return v;
}

function checkHosts(task, list, what, { min = 0 } = {}) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const h = String(raw ?? "").trim();
    if (!validHost(h)) throw bad(task, `${what}: ${JSON.stringify(h.slice(0, 80))} is not a host name or IP address`);
    if (!out.includes(h)) out.push(h);
  }
  if (out.length < min) throw bad(task, `${what} must list at least ${min} address${min === 1 ? "" : "es"}`);
  if (out.length > 200) throw bad(task, `${what} lists too many addresses`);
  return out;
}

function checkIps(task, list, what) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const h = String(raw ?? "").trim();
    if (!net.isIP(h)) throw bad(task, `${what}: ${JSON.stringify(h.slice(0, 80))} is not an IP address`);
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

function checkFlavor(task, v) {
  if (v !== "mysql" && v !== "mariadb") throw bad(task, `flavor must be "mysql" or "mariadb" (got ${JSON.stringify(String(v).slice(0, 20))})`);
  return v;
}

function checkDbList(task, list) {
  if (list == null) return null;
  if (!Array.isArray(list)) throw bad(task, "databases must be a list");
  const out = [];
  for (const d of list) {
    const s = String(d ?? "");
    if (!ANY_DB_RE.test(s) || SYSTEM_DBS.has(s.toLowerCase())) throw bad(task, `${JSON.stringify(s.slice(0, 70))} is not a database that can be copied`);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

export function checkSetupPayload(payload, task = "mysql.replica.setup") {
  if (!payload || typeof payload !== "object") throw bad(task, "the payload is missing");
  const primaryHost = String(payload.primaryHost ?? "").trim();
  if (!validHost(primaryHost) || primaryHost === "localhost") throw bad(task, "primaryHost must be the primary's host name or IP address");
  return {
    flavor: checkFlavor(task, payload.flavor),
    serverId: checkServerId(task, payload.serverId),
    primaryHost,
    primaryPort: checkPort(task, payload.primaryPort),
    replUser: checkUser(task, payload.replUser, REPL_USER),
    replPassword: checkPassword(task, payload.replPassword, "replPassword"),
    adminPassword: checkPassword(task, payload.adminPassword, "adminPassword"),
    adminIps: checkHosts(task, payload.adminIps, "adminIps"),
    allowFrom: checkIps(task, payload.allowFrom, "allowFrom"),
    seed: payload.seed !== false,
    databases: checkDbList(task, payload.databases),
  };
}

function checkPreparePayload(payload) {
  const task = "mysql.primary.prepare";
  if (!payload || typeof payload !== "object") throw bad(task, "the payload is missing");
  return {
    serverId: checkServerId(task, payload.serverId),
    replUser: checkUser(task, payload.replUser, REPL_USER),
    replPassword: checkPassword(task, payload.replPassword, "replPassword"),
    adminPassword: checkPassword(task, payload.adminPassword, "adminPassword"),
    replicaIps: checkHosts(task, payload.replicaIps, "replicaIps", { min: 1 }),
    adminIps: checkHosts(task, payload.adminIps, "adminIps"),
    allowFrom: checkIps(task, payload.allowFrom, "allowFrom"),
  };
}

// =================================================================== SQL builders (pure, exported for tests)

/**
 * Accounts script. `accounts`: [{ user, password, hosts, grants: ["…ON … "], grantOption }],
 * `drop`: [{ user, host }]. Returns { script, secrets }.
 */
export function buildAccountsSql({ accounts = [], drop = [], noBinlog = false } = {}) {
  const lines = [];
  const secrets = [];
  if (noBinlog) lines.push("SET SESSION sql_log_bin = 0;");
  for (const a of accounts) {
    secrets.push(a.password);
    for (const h of a.hosts) {
      const acct = account(a.user, h);
      lines.push(`CREATE USER IF NOT EXISTS ${acct} IDENTIFIED BY ${sqlString(a.password)};`);
      lines.push(`ALTER USER ${acct} IDENTIFIED BY ${sqlString(a.password)};`);
      for (const g of a.grants || []) lines.push(`GRANT ${g} TO ${acct}${a.grantOption ? " WITH GRANT OPTION" : ""};`);
    }
  }
  for (const d of drop) lines.push(`DROP USER IF EXISTS ${account(d.user, d.host)};`);
  return { script: lines.join("\n") + "\n", secrets: secrets.filter(Boolean) };
}

export const REPL_GRANT = "REPLICATION SLAVE, REPLICATION CLIENT, SELECT, RELOAD, SHOW VIEW, EVENT, TRIGGER, LOCK TABLES, PROCESS ON *.*";
export const ADMIN_GRANT = "ALL PRIVILEGES ON *.*";

/** mysql.users.sync payload → validated plan + script. Throws on anything off. */
export function buildUsersSyncSql(payload, { replica = false, partialRevokes = false } = {}) {
  const task = "mysql.users.sync";
  if (!payload || typeof payload !== "object") throw bad(task, "the payload is missing");
  const users = Array.isArray(payload.users) ? payload.users : [];
  const remove = Array.isArray(payload.remove) ? payload.remove : [];
  if (users.length > 2000 || remove.length > 5000) throw bad(task, "too many users in one sync");
  const accounts = [];
  for (const u of users) {
    const user = checkUser(task, u?.user);
    const password = checkPassword(task, u?.password, `the password of ${user}`);
    const hosts = checkHosts(task, u?.hosts, `hosts of ${user}`, { min: 1 });
    const dbs = [];
    for (const d of Array.isArray(u?.databases) ? u.databases : []) {
      const s = String(d ?? "");
      if (!GRANT_DB_RE.test(s) || SYSTEM_DBS.has(s)) throw bad(task, `${JSON.stringify(s.slice(0, 70))} is not a database a website user can be granted`);
      if (!dbs.includes(s)) dbs.push(s);
    }
    accounts.push({ user, password, hosts, grants: dbs.map((d) => `ALL PRIVILEGES ON ${grantDbPattern(d, partialRevokes)}.*`) });
  }
  const drop = [];
  for (const r of remove) {
    const user = checkUser(task, r?.user);
    const host = String(r?.host ?? "").trim();
    if (!validHost(host)) throw bad(task, `remove: ${JSON.stringify(host.slice(0, 80))} is not a host`);
    drop.push({ user, host });
  }
  return { ...buildAccountsSql({ accounts, drop, noBinlog: replica }), users: accounts.length, removed: drop.length };
}

/** Managed config file text. Only the read_only line may change without a restart. */
export function renderCnf({ flavor, version, serverId, readOnly }) {
  const d = dialect(flavor, version);
  return [
    "# Managed by Forthway Command Center (database replication, docs/HA.md Phase 3).",
    "# Rewritten by the panel — local edits are lost. Put your own settings in another file.",
    "[mysqld]",
    `server_id = ${Number(serverId)}`,
    d.logBinCnf,
    ...(d.binlogFormatLine ? ["binlog_format = ROW"] : []),
    `${d.logReplicaUpdates} = ON`,
    "binlog_expire_logs_seconds = 604800",
    ...d.gtidCnf,
    "relay_log = relay-bin",
    "relay_log_recovery = ON",
    "replicate-wild-ignore-table = mysql.%",
    "bind-address = 0.0.0.0",
    `read_only = ${readOnly ? "ON" : "OFF"}`,
    "",
  ].join("\n");
}

const READ_ONLY_LINE = /^\s*read[_-]only\s*=.*$/m;

function staticPart(text) {
  return String(text || "")
    .split("\n")
    .filter((l) => !/^\s*read[_-]only\s*=/.test(l) && !/^\s*#/.test(l) && l.trim())
    .join("\n");
}

function withReadOnly(text, on) {
  const line = `read_only = ${on ? "ON" : "OFF"}`;
  if (READ_ONLY_LINE.test(text)) return text.replace(READ_ONLY_LINE, line);
  return `${text.replace(/\n*$/, "\n")}${line}\n`;
}

// =================================================================== the task context

function testHook() {
  const f = process.env.FCC_MYSQL_TEST_DEFAULTS;
  if (!f || sys.DRY_RUN) return null;
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  const argOk = (a) => typeof a === "string" && /^[A-Za-z0-9_=/.:@+-]{1,300}$/.test(a);
  if (!Array.isArray(j.client) || !j.client.every(argOk)) throw new Error("FCC_MYSQL_TEST_DEFAULTS: client must be a list of plain arguments");
  if (typeof j.cnfFile !== "string" || !path.isAbsolute(j.cnfFile)) throw new Error("FCC_MYSQL_TEST_DEFAULTS: cnfFile must be an absolute path");
  if (!Array.isArray(j.restart) || !j.restart.length || !path.isAbsolute(j.restart[0]) || !j.restart.every(argOk)) {
    throw new Error("FCC_MYSQL_TEST_DEFAULTS: restart must be [absolute program, args…]");
  }
  return { client: j.client, cnfFile: j.cnfFile, restart: j.restart };
}

function ctxOf(o, task) {
  const M = {
    task,
    o,
    log: o.log || NOOP,
    progress: typeof o.progress === "function" ? o.progress : NOOP, // structured progress (executeTask throttles it)
    signal: o.signal || null,
    dataDir: o.dataDir || process.env.FCC_DATA_DIR || "/var/lib/fcc",
    dry: sys.DRY_RUN,
    hook: testHook(),
    sim: simOf(),
  };
  if (M.hook) M.log(`TEST HOOK: FCC_MYSQL_TEST_DEFAULTS is set — the local server is ${M.hook.client.join(" ")}.`);
  return M;
}

// ---- persisted state (role, server id) — real and simulated

function statePath(M) {
  return path.join(M.dataDir, STATE_FILE);
}

export function readHaState(dataDir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dataDir, STATE_FILE), "utf8"));
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

function saveState(M, patch) {
  const s = { ...readHaState(M.dataDir), ...patch, updatedAt: new Date().toISOString() };
  try {
    writeAtomic(statePath(M), JSON.stringify(s, null, 2) + "\n", 0o600);
  } catch (err) {
    M.log(`!! Could not save ${statePath(M)}: ${err.message}`);
  }
  return s;
}

function dryState(M) {
  const blank = { installed: true, running: true, flavor: "mysql", version: "8.0.36-dry-run", readOnly: false, serverId: 1, role: "standalone", replica: null, uuid: "3e11fa47-71ca-11e1-9e33-c80aa9429562", seq: 48120, databases: ["acme_shop", "acme_blog"] };
  try {
    return { ...blank, ...JSON.parse(fs.readFileSync(path.join(M.dataDir, DRY_STATE_FILE), "utf8")) };
  } catch {
    return blank;
  }
}

function saveDry(M, patch) {
  const s = { ...dryState(M), ...patch };
  writeAtomic(path.join(M.dataDir, DRY_STATE_FILE), JSON.stringify(s, null, 2) + "\n", 0o600);
  return s;
}

function dryGtid(s) {
  return s.flavor === "mariadb" ? `0-${s.serverId}-${s.seq}` : `${s.uuid}:1-${s.seq}`;
}

/**
 * The simulated replica's status. Right after a simulated seed it "catches up":
 * `catchUp { at, total, ms }` (FCC_MYSQL_DRY_SIM catchUpChanges / catchUpSeconds)
 * makes executedGtid trail the primary's default position and shrink to it.
 */
function dryReplicaNow(s) {
  if (!s.replica) return null;
  const r = { ...s.replica };
  const cu = s.catchUp;
  if (cu && cu.total > 0 && cu.ms > 0) {
    const f = Math.min(1, Math.max(0, (Date.now() - cu.at) / cu.ms));
    const remaining = f >= 1 ? 0 : Math.ceil(cu.total * (1 - f) ** 1.25);
    const done = Math.max(1, s.seq - remaining);
    r.executedGtid = s.flavor === "mariadb" ? `0-${s.serverId}-${done}` : `${s.uuid}:1-${done}`;
    r.lagSeconds = remaining ? Math.max(1, Math.round((cu.lagMax || 40) * (1 - f))) : 0;
  }
  return r;
}

// ---- clients

function clientBin() {
  return sys.which("mysql") || sys.which("mariadb") || "mysql";
}

function dumpBin() {
  return sys.which("mysqldump") || sys.which("mariadb-dump") || "mysqldump";
}

function localArgs(M) {
  return M.hook?.client || ["-u", "root"];
}

/** Run a script as local root on stdin. → rows (or named rows with { names: true }). */
async function sqlLocal(M, script, { secrets = [], timeoutMs = 60_000, names = false, connectTimeout = 5, quietDry = false } = {}) {
  const bin = clientBin();
  const args = [...localArgs(M), "--batch", ...(names ? [] : ["--skip-column-names"]), "--default-character-set=utf8mb4", `--connect-timeout=${connectTimeout}`];
  if (M.dry) {
    if (!quietDry) {
      M.log(`[dry-run] ${path.basename(bin)} ${args.join(" ")} <<SQL`);
      for (const l of maskSecrets(script, secrets).trim().split("\n")) M.log(`[dry-run]   ${l}`);
    }
    return [];
  }
  try {
    const r = await sys.run(bin, args, { input: PRELUDE + script, timeoutMs, signal: M.signal });
    return names ? parseNamed(r.stdout) : parseRows(r.stdout);
  } catch (e) {
    if (M.signal?.aborted) throw abortError();
    throw scrub(e, secrets);
  }
}

/** One statement that may fail harmlessly with one of `okCodes` (e.g. "already stopped"). */
async function sqlTolerant(M, stmt, okCodes = []) {
  try {
    await sqlLocal(M, `${stmt};\n`, { timeoutMs: 120_000 });
  } catch (e) {
    if (!okCodes.includes(e.mysqlCode)) throw e;
    M.log(`(${stmt}: ${e.message.split("\n").pop()})`);
  }
}

/** A script against the primary over TCP; the password travels in MYSQL_PWD. */
async function sqlRemote(M, conn, script, { timeoutMs = 60_000 } = {}) {
  const bin = clientBin();
  const args = ["-h", conn.host, "-P", String(conn.port), "-u", conn.user, ...conn.extra, "--batch", "--skip-column-names", "--default-character-set=utf8mb4", "--connect-timeout=10"];
  if (M.dry) {
    M.log(`[dry-run] ${path.basename(bin)} ${args.join(" ")} (password in MYSQL_PWD) <<SQL`);
    for (const l of script.trim().split("\n")) M.log(`[dry-run]   ${l}`);
    return [];
  }
  try {
    const r = await sys.run(bin, args, { input: PRELUDE + script, env: { MYSQL_PWD: conn.password }, timeoutMs, signal: M.signal });
    return parseRows(r.stdout);
  } catch (e) {
    if (M.signal?.aborted) throw abortError();
    throw scrub(e, [conn.password]);
  }
}

// ---- server facts

function serverBinary() {
  for (const b of ["mariadbd", "mysqld"]) {
    const p = sys.which(b) || [`/usr/sbin/${b}`, `/usr/bin/${b}`].find((f) => exists(f));
    if (p) return p;
  }
  return null;
}

async function installedFlavor(M) {
  // Simulated: a server that never ran a mysql.* task yet counts as "nothing installed" for setup.
  if (M.dry) return exists(path.join(M.dataDir, DRY_STATE_FILE)) && dryState(M).installed ? dryState(M).flavor : null;
  if (M.hook) return "unknown";
  const bin = serverBinary();
  if (!bin) return null;
  if (/mariadbd$/.test(bin)) return "mariadb";
  const r = await sys.run(bin, ["--version"], { allowFail: true, timeoutMs: 15_000 }).catch(() => null);
  return /mariadb/i.test(`${r?.stdout || ""}${r?.stderr || ""}`) ? "mariadb" : "mysql";
}

/** { flavor, version, readOnly, serverId, logBin, gtidMode } of the running local server. Throws when it is not reachable. */
async function serverInfo(M) {
  if (M.dry) {
    const s = dryState(M);
    return { flavor: s.flavor, version: s.version, readOnly: !!s.readOnly, serverId: s.serverId, logBin: true, gtidMode: "ON" };
  }
  const rows = await sqlLocal(M, "SELECT VERSION(), @@GLOBAL.read_only, @@GLOBAL.server_id, @@GLOBAL.log_bin;\n", { timeoutMs: 15_000 });
  const [version, ro, sid, logBin] = rows[0] || [];
  if (!version) throw new Error("MySQL did not answer SELECT VERSION().");
  const flavor = flavorOf(version);
  let gtidMode = null;
  if (flavor === "mysql") gtidMode = (await sqlLocal(M, "SELECT @@GLOBAL.gtid_mode;\n", { timeoutMs: 15_000 }))[0]?.[0] || null;
  return { flavor, version, readOnly: ro === "1", serverId: Number(sid), logBin: logBin === "1", gtidMode };
}

async function executedGtid(M, d) {
  if (M.dry) return dryGtid(dryState(M));
  return ((await sqlLocal(M, `SELECT ${d.executedGtidExpr};\n`, { timeoutMs: 15_000 }))[0]?.[0] || "").replace(/\s+/g, "");
}

/** Normalised replica status, or null when no replication is configured. */
async function replicaStatus(M, d) {
  if (M.dry) {
    const s = dryState(M);
    return s.role === "replica" && s.replica ? dryReplicaNow(s) : null;
  }
  const rows = await sqlLocal(M, `${d.showReplicaStatus};\n`, { names: true, timeoutMs: 15_000 });
  const r = rows[0];
  if (!r) return null;
  const F = d.fields;
  const lag = r[F.lag];
  const ioState = r[F.io] || null;
  return {
    ioRunning: ioState === "Yes",
    ioState,
    sqlRunning: r[F.sql] === "Yes",
    lagSeconds: lag == null || lag === "" ? null : Number(lag),
    lastError: r.Last_SQL_Error || r.Last_IO_Error || r.Last_Error || null,
    sqlError: r.Last_SQL_Error || null,
    ioError: r.Last_IO_Error || null,
    sourceHost: r[F.source] || null,
    retrievedGtid: (r[F.retrieved] || "").replace(/\s+/g, ""),
    executedGtid: (r[F.executed] || "").replace(/\s+/g, ""),
  };
}

async function waitReady(M, ms = READY_WAIT_MS) {
  if (M.dry) return;
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    checkAbort(M);
    try {
      await sqlLocal(M, "SELECT 1;\n", { timeoutMs: 10_000, connectTimeout: 3 });
      return;
    } catch (e) {
      last = e;
    }
    await sleep(1000, M.signal);
  }
  throw new Error(`MySQL did not accept connections within ${Math.round(ms / 1000)} s${last ? `: ${last.message}` : ""}`);
}

async function restartServer(M, flavor) {
  if (M.hook) {
    await sys.run(M.hook.restart[0], M.hook.restart.slice(1), { log: M.log, timeoutMs: RESTART_TIMEOUT_MS });
  } else {
    if (!M.dry && !sys.which("systemctl")) throw new Error("systemctl is not available, so MySQL cannot be restarted.");
    await sys.run("systemctl", ["restart", SERVICE[flavor]], { log: M.log, timeoutMs: RESTART_TIMEOUT_MS, signal: M.signal });
  }
  await waitReady(M);
}

/** Make sure the local server runs; start it once if it does not answer. */
async function requireRunning(M) {
  try {
    return await serverInfo(M);
  } catch (e) {
    if (!NOT_RUNNING_CODES.has(e.mysqlCode) || M.hook) {
      if (e.mysqlCode === 1045 || e.mysqlCode === 1698) {
        throw new Error("Cannot sign in to the local MySQL as root over the unix socket (socket authentication is off). Restore socket authentication for root on this server.");
      }
      throw e;
    }
    const flavor = await installedFlavor(M);
    if (!flavor) throw new Error("MySQL is not installed on this server.");
    M.log(`MySQL is not running — starting ${SERVICE[flavor]}…`);
    await sys.run("systemctl", ["start", SERVICE[flavor]], { log: M.log, timeoutMs: RESTART_TIMEOUT_MS, allowFail: true });
    await waitReady(M);
    return serverInfo(M);
  }
}

// ---- managed config file

function cnfPath(M, flavor) {
  if (M.hook) return M.hook.cnfFile;
  if (M.dry) return path.join(M.dataDir, "mysql-dry-run", path.basename(CNF_FILES[flavor]));
  return CNF_FILES[flavor];
}

/**
 * Write the managed file when it differs. Restarts only when a setting other
 * than read_only changed; if the server does not come back, the previous file
 * is restored and the server restarted on it. → { changed, restarted, file }
 */
async function applyCnf(M, flavor, content) {
  const file = cnfPath(M, flavor);
  const old = readText(file);
  if (old === content) {
    M.log(`${file} is already up to date.`);
    return { changed: false, restarted: false, file };
  }
  if (!M.dry && !M.hook && !exists(path.dirname(file))) {
    throw new Error(`${path.dirname(file)} does not exist — this MySQL is not laid out like Debian/Ubuntu's.`);
  }
  writeAtomic(file, content, 0o644);
  const restartNeeded = staticPart(old) !== staticPart(content);
  M.log(`Wrote ${file}${restartNeeded ? " — restarting MySQL to apply it" : " (no restart needed)"}.`);
  if (!restartNeeded) return { changed: true, restarted: false, file };
  try {
    await restartServer(M, flavor);
  } catch (err) {
    if (err.aborted) throw err;
    M.log(`!! MySQL did not come back with the new settings (${err.message}) — restoring the previous file.`);
    if (old == null) fs.rmSync(file, { force: true });
    else writeAtomic(file, old, 0o644);
    try {
      await restartServer(M, flavor);
      M.log("MySQL is running again on the previous settings.");
    } catch (e2) {
      M.log(`!! MySQL does not start on the previous settings either: ${e2.message}`);
    }
    throw new Error(`MySQL did not start with the replication settings: ${err.message}. The previous settings were restored.`);
  }
  M.log("MySQL restarted and accepts connections.");
  return { changed: true, restarted: true, file };
}

/** Toggle only the read_only line of the managed file (create a minimal one if there is none). */
function setCnfReadOnly(M, flavor, on) {
  const file = cnfPath(M, flavor);
  const old = readText(file);
  const next =
    old == null
      ? `# Managed by Forthway Command Center (database replication, docs/HA.md Phase 3).\n[mysqld]\nread_only = ${on ? "ON" : "OFF"}\n`
      : withReadOnly(old, on);
  if (next === old) return { changed: false, file };
  if (!M.dry && !M.hook && !exists(path.dirname(file))) return { changed: false, file, skipped: `${path.dirname(file)} does not exist` };
  writeAtomic(file, next, 0o644);
  return { changed: true, file };
}

// ---- install

async function aptInstall(M, pkgs, { confNew = false } = {}) {
  const env = { DEBIAN_FRONTEND: "noninteractive" };
  // Never stop at a conffile question. A fresh install keeps any local file
  // (confold). Replacing the distro's server with a vendor's takes the vendor's
  // files (confnew), because the distro's leftovers describe the old server.
  const conf = confNew ? ["-o", "Dpkg::Options::=--force-confnew"] : ["-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold"];
  const args = ["install", "-y", "-q", "-o", "DPkg::Lock::Timeout=300", ...conf, ...pkgs];
  const r = await sys.run("apt-get", args, { log: M.log, env, timeoutMs: 30 * 60_000, allowFail: true, signal: M.signal });
  if (r.code === 0) return;
  await sys.run("apt-get", ["update", "-q", "-o", "DPkg::Lock::Timeout=300"], { log: M.log, env, timeoutMs: 15 * 60_000, signal: M.signal });
  await sys.run("apt-get", args, { log: M.log, env, timeoutMs: 30 * 60_000, signal: M.signal });
}

// =================================================================== version preflight (replica ≥ primary)
//
// MySQL and MariaDB support a replica that runs the same or a NEWER release
// series (major.minor) than its source — never an older one. An older
// mysqldump also cannot copy from a newer server (an 8.0 client sends
// SHOW MASTER STATUS, which 8.4 removed → error 1064). So before anything is
// changed on this server, mysql.replica.setup / mysql.rebuild:
//   1. read the primary's version (MySQL handshake over TCP, which needs no
//      client and no password; then SELECT VERSION(), @@version_comment as the
//      replication user when a client is installed here);
//   2. decide where a new enough server comes from: the distro when its
//      candidate (apt-cache policy) is the same series or newer, else the
//      vendor's APT repository (Oracle's for MySQL, MariaDB's for MariaDB) —
//      key downloaded over HTTPS, fingerprint checked against the one pinned
//      below, stored under /usr/share/keyrings/, used with signed-by=;
//   3. an installed server that is older is replaced only when it holds no
//      databases except ones an earlier, unfinished seed of this task created
//      (recorded in mysql-ha.json as `seeding`); otherwise refuse, unchanged.
//      Moving from the distro's MySQL to Oracle's packages puts the old data
//      directory aside (/var/lib/mysql.fcc-before-upgrade-<stamp>, kept) so
//      Oracle's package initialises a fresh one with root on auth_socket —
//      also the only safe route for series an in-place upgrade cannot skip.
//   4. after installing: the server's series and mysqldump's series must both
//      be ≥ the primary's, or the task stops with a plain explanation.
//
// Verified 2026-10-14 against repo.mysql.com / dlm.mariadb.com:
//   - Oracle: RPM-GPG-KEY-mysql-2025 = key BCA4 3417 C3B4 85DD 128E C6D4 B7B3 B788 A8D3 785C
//     ("MySQL Release Engineering", created 2023-10-23, self-signature valid until
//     2027-10-23); it signs dists/{jammy,noble,bookworm}/InRelease directly. Suites:
//     apt/ubuntu/dists/{jammy,noble}, apt/debian/dists/bookworm; architectures
//     i386 + amd64 only; components mysql-8.0, mysql-8.4-lts, mysql-9.7-lts,
//     mysql-innovation (26.x) … mysql-community-server's postinst initialises an
//     EMPTY /var/lib/mysql on a fresh install and, with the root-pass question left
//     blank, sets root@localhost to auth_socket.
//   - MariaDB: mariadb-keyring-2019.gpg holds 5 keys; the repository is signed by
//     177F 4010 FE56 CA33 3630 0305 F165 6F24 C74C D1D8 ("MariaDB Signing Key"), the
//     only one written to our keyring. Layout dlm.mariadb.com/repo/mariadb-server/
//     <series>/repo/<ubuntu|debian> <codename> main; amd64 + arm64. Its postinst
//     always runs mariadb-install-db (root via unix_socket on a new data directory).

const MYSQL_DATADIR = "/var/lib/mysql";
const APT_LIST = "/etc/apt/sources.list.d/fcc-mysql.list";
export const VENDOR_REPOS = Object.freeze({
  mysql: Object.freeze({
    name: "Oracle's MySQL APT repository",
    keyUrl: "https://repo.mysql.com/RPM-GPG-KEY-mysql-2025",
    fingerprint: "BCA43417C3B485DD128EC6D4B7B3B788A8D3785C",
    keyring: "/usr/share/keyrings/fcc-mysql-repo.gpg",
    base: "https://repo.mysql.com/apt",
    arches: ["amd64"],
  }),
  mariadb: Object.freeze({
    name: "MariaDB's APT repository",
    keyUrl: "https://supplychain.mariadb.com/mariadb-keyring-2019.gpg",
    fingerprint: "177F4010FE56CA3336300305F1656F24C74CD1D8",
    keyring: "/usr/share/keyrings/fcc-mariadb-repo.gpg",
    base: "https://dlm.mariadb.com/repo/mariadb-server",
    arches: ["amd64", "arm64"],
  }),
});
const DRY_DEFAULT_MYSQL_COMPONENTS = ["mysql-8.0", "mysql-8.4-lts", "mysql-9.7-lts", "mysql-innovation"];
const DRY_DEFAULT_SUITES = ["jammy", "noble", "bookworm"];
const FLAVOR_NAME = { mysql: "MySQL", mariadb: "MariaDB" };

/** [major, minor] of a version string (distro / vendor / server forms), or null. */
export function seriesOf(v) {
  const p = parseVersion(String(v ?? "").replace(/^5\.5\.5-/, ""));
  return p ? [p[0], p[1]] : null;
}

export function cmpSeries(a, b) {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}

/** Version from `mysqldump --version` / `mariadb-dump --version`. */
export function parseClientVersion(text) {
  const t = String(text || "");
  const m = /Distrib\s+(\d+\.\d+\.\d+)/.exec(t) || /\bfrom\s+(\d+\.\d+\.\d+)/.exec(t) || /\bVer\s+(\d+\.\d+\.\d+)/.exec(t);
  return m ? m[1] : null;
}

/**
 * Oracle component for a primary's version: the same series if the repository
 * carries it; else the next LTS series (innovation releases are dropped from
 * the repository once superseded, and the next LTS is their supported upgrade
 * and replica); else mysql-innovation (newer than every LTS). Null if none.
 */
export function pickMysqlComponent(primaryVersion, components) {
  const s = seriesOf(primaryVersion);
  if (!s) return null;
  const series = (components || [])
    .map((c) => {
      const m = /^mysql-(\d+)\.(\d+)(-lts)?$/.exec(c);
      return m ? { component: c, v: [Number(m[1]), Number(m[2])], lts: !!m[3] } : null;
    })
    .filter(Boolean);
  const exact = series.find((x) => cmpSeries(x.v, s) === 0);
  if (exact) return { component: exact.component, series: exact.v.join("."), why: `the ${exact.v.join(".")} series, like the primary` };
  const next = series.filter((x) => x.lts && cmpSeries(x.v, s) > 0).sort((a, b) => cmpSeries(a.v, b.v))[0];
  if (next) return { component: next.component, series: next.v.join("."), why: `${s.join(".")} is not in the repository any more; ${next.v.join(".")} LTS is the next long-term series, a supported replica of it` };
  if ((components || []).includes("mysql-innovation")) return { component: "mysql-innovation", series: null, why: `${s.join(".")} is newer than every LTS series` };
  return null;
}

// ---- OpenPGP (just enough to check a repository key's fingerprint; v4 keys)

/** ASCII armor → binary packets. */
export function dearmorPgp(text) {
  const lines = String(text).replace(/\r/g, "").split("\n");
  let i = lines.findIndex((l) => l.startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----"));
  if (i < 0) throw new Error("not an armored OpenPGP public key");
  i++;
  while (i < lines.length && /^[A-Za-z-]+: /.test(lines[i])) i++;
  const b64 = [];
  for (; i < lines.length && !lines[i].startsWith("-----END"); i++) {
    const l = lines[i].trim();
    if (l && !l.startsWith("=")) b64.push(l);
  }
  return Buffer.from(b64.join(""), "base64");
}

function pgpPackets(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const start = i;
    const h = buf[i++];
    if (!(h & 0x80)) throw new Error("malformed OpenPGP data");
    let tag;
    let len;
    if (h & 0x40) {
      tag = h & 0x3f;
      const o = buf[i++];
      if (o < 192) len = o;
      else if (o < 224) len = ((o - 192) << 8) + buf[i++] + 192;
      else if (o === 255) {
        len = buf.readUInt32BE(i);
        i += 4;
      } else throw new Error("unsupported OpenPGP packet length");
    } else {
      tag = (h >> 2) & 0x0f;
      const lt = h & 3;
      if (lt === 0) len = buf[i++];
      else if (lt === 1) {
        len = buf.readUInt16BE(i);
        i += 2;
      } else if (lt === 2) {
        len = buf.readUInt32BE(i);
        i += 4;
      } else throw new Error("unsupported OpenPGP packet length");
    }
    if (i + len > buf.length) throw new Error("truncated OpenPGP data");
    out.push({ tag, start, end: i + len, body: buf.subarray(i, i + len) });
    i += len;
  }
  return out;
}

function pgpFingerprint(body) {
  if (body[0] !== 4) return null;
  const h = crypto.createHash("sha1");
  h.update(Buffer.from([0x99, (body.length >> 8) & 0xff, body.length & 0xff]));
  h.update(body);
  return h.digest("hex").toUpperCase();
}

/**
 * The key with `fingerprint` (its packets up to the next primary key) out of a
 * downloaded key file. Throws, naming what was found, when it is not there.
 */
export function extractRepoKey(bytes, fingerprint) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const raw = buf.subarray(0, 64).toString("latin1").includes("-----BEGIN PGP") ? dearmorPgp(buf.toString("utf8")) : buf;
  const packets = pgpPackets(raw);
  const found = [];
  let from = -1;
  let to = raw.length;
  for (const p of packets) {
    if (p.tag !== 6) continue;
    const fp = pgpFingerprint(p.body);
    found.push(fp || "(not a v4 key)");
    if (from >= 0 && to === raw.length) to = p.start;
    if (fp === fingerprint && from < 0) from = p.start;
  }
  if (from < 0) throw new Error(`the downloaded key file holds ${found.join(", ") || "no key"}, not the expected ${fingerprint}`);
  return { keyring: Buffer.from(raw.subarray(from, to)), found };
}

// ---- facts about this machine (simulated under FCC_DRY_RUN with FCC_MYSQL_DRY_SIM)

function dryVersionDefault(flavor) {
  return flavor === "mariadb" ? "10.11.6-MariaDB-dry-run" : "8.0.36-dry-run";
}

function simOf() {
  const v = process.env.FCC_MYSQL_DRY_SIM;
  if (!v || !sys.DRY_RUN) return {};
  const j = JSON.parse(v.trim().startsWith("{") ? v : fs.readFileSync(v, "utf8"));
  return j && typeof j === "object" ? j : {};
}

async function osRelease(M) {
  if (M.dry) {
    const o = { id: "ubuntu", codename: "noble", ...(M.sim.os || {}) };
    M.log(`[dry-run] /etc/os-release → simulated ${o.id} ${o.codename}`);
    return o;
  }
  const t = readText("/etc/os-release") || "";
  const get = (k) => (new RegExp(`^${k}="?([^"\\n]*)"?`, "m").exec(t) || [])[1] || "";
  const id = get("ID").toLowerCase();
  const like = get("ID_LIKE").toLowerCase();
  return { id: id === "ubuntu" || id === "debian" ? id : /ubuntu/.test(like) ? "ubuntu" : /debian/.test(like) ? "debian" : id, codename: get("VERSION_CODENAME") || get("UBUNTU_CODENAME"), pretty: get("PRETTY_NAME") };
}

async function dpkgArch(M) {
  if (M.dry) return M.sim.arch || "amd64";
  const r = await sys.run("dpkg", ["--print-architecture"], { allowFail: true, timeoutMs: 15_000 }).catch(() => null);
  return (r?.stdout || "").trim() || os.arch();
}

async function pkgInstalled(M, pkg) {
  if (M.dry) return (M.sim.installedPackages || []).includes(pkg);
  const r = await sys.run("dpkg-query", ["-W", "-f=${Status}", pkg], { allowFail: true, timeoutMs: 15_000 }).catch(() => null);
  return /install ok installed/.test(r?.stdout || "");
}

/** apt's candidate version for a package, or null. */
async function aptCandidate(M, pkg, { which = "distro" } = {}) {
  if (M.dry) {
    const def = { "mysql-server": "8.0.36-0ubuntu0.24.04.1", "mariadb-server": "1:10.11.6-0ubuntu0.24.04.1" };
    const table = which === "vendor" ? M.sim.vendorCandidate : M.sim.distro;
    let v = table && typeof table === "object" ? table[pkg] : undefined;
    if (v === undefined && which === "vendor") v = M.vendorExpect || null;
    if (v === undefined) v = def[pkg] ?? null;
    M.log(`[dry-run] apt-cache policy ${pkg} → simulated candidate ${v || "(none)"}`);
    return v || null;
  }
  const r = await sys.run("apt-cache", ["policy", pkg], { allowFail: true, timeoutMs: 60_000 }).catch(() => null);
  const m = /Candidate:\s*(\S+)/.exec(r?.stdout || "");
  return m && m[1] !== "(none)" ? m[1] : null;
}

async function httpGet(url, { binary = false, timeoutMs = 60_000 } = {}) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "fcc-node mysql-ha" } });
  if (!res.ok) {
    const e = new Error(`${url} answered HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return binary ? Buffer.from(await res.arrayBuffer()) : res.text();
}

/** The primary's MySQL handshake: its version, with no client and no sign-in. */
export function handshakeVersion(host, port, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let done = false;
    const sock = net.connect({ host, port });
    const finish = (err, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(v);
    };
    const timer = setTimeout(() => finish(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    sock.on("error", (e) => finish(new Error(e.code === "ECONNREFUSED" ? "connection refused" : e.code === "EHOSTUNREACH" ? "host unreachable" : e.message)));
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4) return;
      const len = buf.readUIntLE(0, 3);
      if (buf.length < 4 + Math.min(len, 64)) return;
      const p = buf.subarray(4, 4 + len);
      if (p[0] === 0xff) return finish(new Error(`the server refused the connection: ${p.subarray(3).toString("utf8").replace(/^#\w{5}/, "")} (${p.readUInt16LE(1)})`));
      if (p[0] !== 0x0a) return finish(new Error("not a MySQL server (unexpected greeting)"));
      const end = p.indexOf(0, 1);
      if (end < 0) return buf.length >= 4 + len ? finish(new Error("malformed MySQL greeting")) : undefined;
      finish(null, p.subarray(1, end).toString("latin1").replace(/^5\.5\.5-/, ""));
    });
  });
}

/** Non-system databases on the local server (running). */
async function localUserDbs(M) {
  if (M.dry) return [...(dryState(M).databases || [])];
  return (await sqlLocal(M, "SHOW DATABASES;\n", { timeoutMs: 30_000 })).map((r) => r[0]).filter((n) => n && !SYSTEM_DBS.has(n.toLowerCase()));
}

async function dumpVersion(M) {
  if (M.dry) {
    const v = M.sim.dump || dryState(M).version;
    M.log(`[dry-run] ${path.basename(dumpBin())} --version → simulated ${v}`);
    return v;
  }
  const bin = dumpBin();
  const r = await sys.run(bin, ["--version"], { allowFail: true, timeoutMs: 15_000 }).catch((e) => ({ stdout: "", stderr: e.message }));
  return parseClientVersion(`${r.stdout}\n${r.stderr}`);
}

// ---- 1. the primary's version

async function primaryVersionOf(M, p) {
  const where = `${p.primaryHost}:${p.primaryPort}`;
  const conn = { host: p.primaryHost, port: p.primaryPort, user: p.replUser, password: p.replPassword, extra: dialect(p.flavor, null).clientExtra };
  let version = null;
  let comment = null;
  let lowerCaseTableNames = null;
  if (M.dry) {
    version = M.sim.primary || dryVersionDefault(p.flavor);
    comment = M.sim.primaryComment || null;
    await sqlRemote(M, conn, "SELECT VERSION(), @@version_comment, @@lower_case_table_names;\n");
    M.log(`[dry-run] simulated primary version: ${version}${comment ? ` (${comment})` : ""}`);
  } else {
    let hsErr = null;
    try {
      version = await handshakeVersion(p.primaryHost, p.primaryPort);
    } catch (e) {
      hsErr = e;
    }
    if (sys.which("mysql") || sys.which("mariadb")) {
      try {
        const row = (await sqlRemote(M, conn, "SELECT VERSION(), @@version_comment, @@lower_case_table_names;\n", { timeoutMs: 30_000 }))[0] || [];
        if (row[0]) [version, comment, lowerCaseTableNames] = [row[0], row[1] || null, row[2] ?? null];
      } catch (e) {
        M.log(`(Signing in to the primary as ${p.replUser} to read its version failed: ${e.message.split("\n").pop()})`);
      }
    }
    if (!version) {
      throw new Error(
        `Cannot reach the database on the primary at ${where} to read its version (${hsErr?.message || "no answer"}). Check that MySQL there listens on 0.0.0.0 and that port ${p.primaryPort} is open to this server. Nothing was changed on ${os.hostname()}.`,
      );
    }
  }
  const s = seriesOf(version);
  if (!s) throw new Error(`The primary reported an unreadable version (${JSON.stringify(String(version).slice(0, 60))}). Nothing was changed on ${os.hostname()}.`);
  const flavor = flavorOf(version);
  if (flavor !== p.flavor) throw new Error(`The primary runs ${FLAVOR_NAME[flavor]} ${version}, but this task was asked to set up ${FLAVOR_NAME[p.flavor]}. Nothing was changed on ${os.hostname()}.`);
  M.log(`Primary ${where}: ${FLAVOR_NAME[flavor]} ${version}${comment ? ` (${comment})` : ""} → this server needs ${FLAVOR_NAME[flavor]} ${s.join(".")} or a newer series.`);
  return { version, comment, series: s, lowerCaseTableNames: lowerCaseTableNames == null ? null : Number(lowerCaseTableNames) };
}

// ---- 2. the plan

function tooOldMessage(flavor, req, what, ver) {
  return `${what} is ${FLAVOR_NAME[flavor]} ${ver} — older than the primary's ${req.join(".")} series`;
}

/** Where a new enough server comes from. → { source: "distro"|"vendor", … } (throws a plain message when nowhere). */
async function resolveSource(M, flavor, primary) {
  const req = primary.series;
  const pkg = PACKAGES[flavor].server[0];
  let cand = await aptCandidate(M, pkg);
  if (!cand && !M.dry) {
    await sys.run("apt-get", ["update", "-q", "-o", "DPkg::Lock::Timeout=300"], { log: M.log, env: { DEBIAN_FRONTEND: "noninteractive" }, timeoutMs: 15 * 60_000, allowFail: true, signal: M.signal });
    cand = await aptCandidate(M, pkg);
  }
  if (cand && cmpSeries(seriesOf(cand) || [0, 0], req) >= 0) {
    M.log(`apt offers ${pkg} ${cand} — the same series or newer: installing from the configured repositories.`);
    return { source: "distro", candidate: cand };
  }
  M.log(cand ? `apt offers ${pkg} ${cand} — too old for a replica of ${req.join(".")}.` : `apt has no ${pkg} package here.`);

  const V = VENDOR_REPOS[flavor];
  const osr = await osRelease(M);
  const arch = await dpkgArch(M);
  const hint = `Install ${FLAVOR_NAME[flavor]} ${req.join(".")} or newer on this server by hand (it must keep root signing in over the unix socket), then press Turn on replication again.`;
  if (osr.id !== "ubuntu" && osr.id !== "debian") throw new Error(`This server runs ${osr.pretty || osr.id || "an unknown OS"}; ${V.name} is only set up automatically on Ubuntu or Debian. ${hint}`);
  if (!osr.codename) throw new Error(`/etc/os-release names no release codename, so ${V.name} cannot be chosen. ${hint}`);
  if (!V.arches.includes(arch)) throw new Error(`${V.name} has no packages for ${arch} (only ${V.arches.join(", ")}). ${hint}`);

  if (flavor === "mysql") {
    const releaseUrl = `${V.base}/${osr.id}/dists/${osr.codename}/Release`;
    let components;
    if (M.dry) {
      const suites = M.sim.repoSuites || DRY_DEFAULT_SUITES;
      M.log(`[dry-run] GET ${releaseUrl} → simulated`);
      if (!suites.includes(osr.codename)) throw new Error(`${V.name} has no packages for ${osr.id} ${osr.codename} (no ${releaseUrl}). ${hint}`);
      components = M.sim.repoComponents || DRY_DEFAULT_MYSQL_COMPONENTS;
    } else {
      let text;
      try {
        text = await httpGet(releaseUrl);
      } catch (e) {
        if (e.status === 404) throw new Error(`${V.name} has no packages for ${osr.id} ${osr.codename} (no ${releaseUrl}). ${hint}`);
        throw new Error(`Could not read ${releaseUrl}: ${e.message}. Nothing was changed on ${os.hostname()}.`);
      }
      components = ((/^Components:\s*(.*)$/m.exec(text) || [])[1] || "").trim().split(/\s+/).filter(Boolean);
    }
    const pick = pickMysqlComponent(primary.version, components);
    if (!pick) throw new Error(`${V.name} for ${osr.codename} has no series that can replicate from MySQL ${primary.version} (components: ${components.join(", ") || "none"}). ${hint}`);
    M.log(`Using ${V.name}, component ${pick.component} (${pick.why}).`);
    return {
      source: "vendor",
      os: osr,
      arch,
      component: pick.component,
      line: `deb [arch=${arch} signed-by=${V.keyring}] ${V.base}/${osr.id} ${osr.codename} ${pick.component}`,
      expect: pick.series && pick.series !== req.join(".") ? `${pick.series}.0` : primary.version,
    };
  }
  // MariaDB: exactly the primary's series from MariaDB's own repository.
  const series = req.join(".");
  const releaseUrl = `${V.base}/${series}/repo/${osr.id}/dists/${osr.codename}/Release`;
  if (M.dry) {
    M.log(`[dry-run] GET ${releaseUrl} → simulated`);
    if (!(M.sim.repoSuites || DRY_DEFAULT_SUITES).includes(osr.codename)) throw new Error(`${V.name} has no MariaDB ${series} for ${osr.id} ${osr.codename} (no ${releaseUrl}). ${hint}`);
  } else {
    try {
      await httpGet(releaseUrl);
    } catch (e) {
      if (e.status === 404 || e.status === 403) throw new Error(`${V.name} has no MariaDB ${series} for ${osr.id} ${osr.codename} (no ${releaseUrl}). ${hint}`);
      throw new Error(`Could not read ${releaseUrl}: ${e.message}. Nothing was changed on ${os.hostname()}.`);
    }
  }
  M.log(`Using ${V.name}, MariaDB ${series}.`);
  return { source: "vendor", os: osr, arch, series, line: `deb [arch=${arch} signed-by=${V.keyring}] ${V.base}/${series}/repo/${osr.id} ${osr.codename} main`, expect: primary.version };
}

/**
 * Decide, changing nothing: keep the installed server, install one, or replace
 * an older one (only when it holds nothing but leftovers of an unfinished
 * seed — or, for mysql.rebuild, data that is safety-dumped and dropped first).
 */
async function planServer(M, p, primary, { rebuild = false } = {}) {
  const req = primary.series;
  if (M.hook) {
    const info = await serverInfo(M);
    if (cmpSeries(seriesOf(info.version) || [0, 0], req) < 0) throw new Error(`TEST HOOK: ${tooOldMessage(p.flavor, req, "the local test server", info.version)}; nothing is installed under the test hook.`);
    return { action: "keep", version: info.version };
  }
  const have = await installedFlavor(M);
  if (have && have !== p.flavor) {
    throw new Error(`This server already runs ${FLAVOR_NAME[have]}, but the primary runs ${FLAVOR_NAME[p.flavor]}. Remove it first or pick another server. Nothing was changed.`);
  }
  if (have) {
    const info = await requireRunning(M);
    const local = seriesOf(info.version) || [0, 0];
    if (cmpSeries(local, req) >= 0) {
      M.log(`This server runs ${FLAVOR_NAME[p.flavor]} ${info.version} — the ${local.join(".")} series, same as or newer than the primary's ${req.join(".")}: no install needed.`);
      return { action: "keep", version: info.version };
    }
    M.log(`!! ${tooOldMessage(p.flavor, req, "This server", info.version)} — a replica must run the same series or a newer one.`);
    const dbs = await localUserDbs(M);
    const seeding = readHaState(M.dataDir).seeding;
    const disposable = dbs.filter((d) => Array.isArray(seeding?.databases) && seeding.databases.includes(d));
    const keep = dbs.filter((d) => !disposable.includes(d));
    if (keep.length && !rebuild) {
      throw new Error(
        `This server runs ${FLAVOR_NAME[p.flavor]} ${info.version}, older than the primary's ${primary.version}, and it holds databases of its own (${keep.join(", ")}). ` +
          `It is not upgraded automatically while it holds data. Back up and remove those databases (or upgrade ${FLAVOR_NAME[p.flavor]} to ${req.join(".")} or newer yourself), then press Turn on replication again. Nothing was changed on ${os.hostname()}.`,
      );
    }
    if (disposable.length) M.log(`Databases left by an unfinished copy from the primary (safe to discard): ${disposable.join(", ")}.`);
    if (rebuild && keep.length) M.log(`Its databases (${keep.join(", ")}) are saved to a safety dump and dropped first, then it is upgraded.`);
    else if (!dbs.length) M.log("It holds no databases of its own, so it can be upgraded.");
    const src = await resolveSource(M, p.flavor, primary);
    return { action: "replace", version: info.version, ...src };
  }
  M.log(`${FLAVOR_NAME[p.flavor]} is not installed on this server.`);
  const src = await resolveSource(M, p.flavor, primary);
  return { action: "install", ...src };
}

// ---- 3. carrying it out

async function addVendorRepo(M, flavor, plan) {
  const V = VENDOR_REPOS[flavor];
  M.log(`── ${V.name} ──`);
  if (M.dry) {
    M.log(`[dry-run] GET ${V.keyUrl}; require key ${V.fingerprint}; write it to ${V.keyring} (0644)`);
    M.log(`[dry-run] write ${APT_LIST}: ${plan.line}`);
  } else {
    let bytes;
    try {
      bytes = await httpGet(V.keyUrl, { binary: true });
    } catch (e) {
      throw new Error(`Downloading the signing key of ${V.name} failed (${e.message}). Nothing was changed on ${os.hostname()}.`);
    }
    let key;
    try {
      key = extractRepoKey(bytes, V.fingerprint);
    } catch (e) {
      throw new Error(`Refusing ${V.name}: ${e.message}. Nothing was changed on ${os.hostname()}.`);
    }
    writeAtomic(V.keyring, key.keyring, 0o644);
    M.log(`Signing key ${V.fingerprint.replace(/(.{4})/g, "$1 ").trim()} verified and stored in ${V.keyring}.`);
    writeAtomic(APT_LIST, `# Added by Forthway Command Center (database replication): ${FLAVOR_NAME[flavor]} ≥ the primary's series.\n${plan.line}\n`, 0o644);
    M.log(`${APT_LIST}: ${plan.line}`);
  }
  const env = { DEBIAN_FRONTEND: "noninteractive" };
  const up = await sys.run("apt-get", ["update", "-q", "-o", "DPkg::Lock::Timeout=300"], { log: M.log, env, timeoutMs: 15 * 60_000, allowFail: true, signal: M.signal });
  const pkg = PACKAGES[flavor].server[0];
  M.vendorExpect = plan.expect;
  const cand = await aptCandidate(M, pkg, { which: "vendor" });
  const req = seriesOf(plan.expect) && plan.component !== "mysql-innovation" ? seriesOf(plan.expect) : null;
  const okCand = cand && (!req || cmpSeries(seriesOf(cand) || [0, 0], req) >= 0);
  if (up.code !== 0 || !okCand) {
    if (!M.dry) {
      fs.rmSync(APT_LIST, { force: true });
      fs.rmSync(V.keyring, { force: true });
      await sys.run("apt-get", ["update", "-q", "-o", "DPkg::Lock::Timeout=300"], { env, timeoutMs: 15 * 60_000, allowFail: true });
    }
    throw new Error(
      up.code !== 0
        ? `apt-get update failed after adding ${V.name} (exit ${up.code}); the repository was removed again. Nothing else was changed on ${os.hostname()}.`
        : `${V.name} offers ${pkg} ${cand || "(nothing)"}, not the expected series; the repository was removed again. Nothing else was changed on ${os.hostname()}.`,
    );
  }
  M.log(`apt now offers ${pkg} ${cand}.`);
  return cand;
}

async function preseed(M, flavor, plan, primary) {
  if (flavor !== "mysql" || plan.source !== "vendor") return;
  // Oracle's package asks for a root password: leaving it blank makes root@localhost
  // use auth_socket, exactly like Ubuntu's package (and how these tasks sign in).
  const lctn = primary.lowerCaseTableNames === 1 ? "Enabled" : "Disabled";
  const lines = [
    "mysql-community-server mysql-community-server/root-pass password ",
    "mysql-community-server mysql-community-server/re-root-pass password ",
    `mysql-community-server mysql-server/lowercase-table-names select ${lctn}`,
    "mysql-community-server mysql-community-server/remove-data-dir boolean false",
  ];
  if (M.dry) for (const l of lines) M.log(`[dry-run]   debconf: ${l.trim()}`);
  await sys.run("debconf-set-selections", [], { input: lines.join("\n") + "\n", log: M.log, timeoutMs: 60_000 });
}

/** Run the plan. → { installedNow, replaced, oldDataDir } */
async function applyServerPlan(M, p, plan, primary) {
  if (plan.action === "keep") return { installedNow: false };
  if (!M.dry && !sys.which("apt-get")) throw new Error(`apt-get is not available — install ${FLAVOR_NAME[p.flavor]} ${primary.series.join(".")} or newer by hand. Nothing was changed.`);
  if (plan.source === "vendor") await addVendorRepo(M, p.flavor, plan);
  checkAbort(M);
  await preseed(M, p.flavor, plan, primary);

  let oldDataDir = null;
  let confNew = false;
  if (plan.action === "replace") {
    M.log(`── Replacing ${FLAVOR_NAME[p.flavor]} ${plan.version} ──`);
    await sys.run("systemctl", ["stop", SERVICE[p.flavor]], { log: M.log, timeoutMs: RESTART_TIMEOUT_MS, allowFail: true });
    // Oracle's packages replacing the distro's: give them an empty data directory so
    // they initialise it themselves (root on auth_socket). The old one is kept.
    const fresh = p.flavor === "mysql" && plan.source === "vendor" && !(await pkgInstalled(M, "mysql-community-server"));
    if (fresh) {
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      oldDataDir = `${MYSQL_DATADIR}.fcc-before-upgrade-${stamp}`;
      if (M.dry) M.log(`[dry-run] mv ${MYSQL_DATADIR} ${oldDataDir}`);
      else if (exists(MYSQL_DATADIR)) fs.renameSync(MYSQL_DATADIR, oldDataDir);
      M.log(`The old data directory (no databases of its own) is kept at ${oldDataDir}.`);
      confNew = true;
    }
    // The managed file is rewritten for the new version right after this.
    const cnf = cnfPath(M, p.flavor);
    if (exists(cnf)) fs.rmSync(cnf, { force: true });
  }

  const pkgs = PACKAGES[p.flavor].server;
  M.log(`Installing ${pkgs.join(" ")}${plan.source === "vendor" ? ` from ${VENDOR_REPOS[p.flavor].name}` : ""}…`);
  try {
    await aptInstall(M, pkgs, { confNew });
  } catch (err) {
    if (err.aborted || M.signal?.aborted) throw abortError();
    throw new Error(
      `Installing ${FLAVOR_NAME[p.flavor]} failed: ${err.message}${oldDataDir ? ` (the old data directory is at ${oldDataDir})` : ""}. Fix the apt problem above, then press Turn on replication again.`,
    );
  }
  sys.forgetWhich();
  await sys.run("systemctl", ["enable", "--now", SERVICE[p.flavor]], { log: M.log, timeoutMs: RESTART_TIMEOUT_MS, allowFail: true });
  if (M.dry) {
    const v = plan.source === "vendor" ? M.sim.vendorCandidate?.[pkgs[0]] || plan.expect : M.sim.distro?.[pkgs[0]] || (plan.candidate ? plan.candidate : dryVersionDefault(p.flavor));
    saveDry(M, { installed: true, running: true, flavor: p.flavor, version: v, ...(oldDataDir ? { databases: [] } : {}) });
  }
  await waitReady(M);
  return { installedNow: true, replaced: plan.action === "replace", oldDataDir };
}

/** panel.install helper: the client of the cluster's flavor, for remote admin and dumps. Never throws. */
export async function ensureMysqlClient(flavor, { log = NOOP } = {}) {
  if (flavor !== "mysql" && flavor !== "mariadb") return { installed: false, error: `unknown flavor ${String(flavor).slice(0, 20)}` };
  const M = { log, dry: sys.DRY_RUN, signal: null };
  try {
    if (!sys.DRY_RUN) {
      const bin = sys.which("mysql") || sys.which("mariadb");
      if (bin) {
        const r = await sys.run(bin, ["--version"], { allowFail: true, timeoutMs: 15_000 });
        const have = /mariadb/i.test(`${r.stdout}${r.stderr}`) ? "mariadb" : "mysql";
        if (have === flavor) {
          log(`The ${flavor === "mariadb" ? "MariaDB" : "MySQL"} client is already installed.`);
          return { installed: true, already: true };
        }
        const srv = serverBinary();
        if (srv) {
          log(`!! This server runs its own ${have} server; the ${flavor} client is not installed next to it.`);
          return { installed: false, error: `a ${have} server is installed here` };
        }
      }
      if (!sys.which("apt-get")) {
        log("!! apt-get is not available — install the MySQL client by hand.");
        return { installed: false, error: "apt-get is not available" };
      }
    }
    await aptInstall(M, PACKAGES[flavor].client);
    sys.forgetWhich();
    log(`Installed ${PACKAGES[flavor].client.join(" ")}.`);
    return { installed: true, ...(sys.DRY_RUN ? { dryRun: true } : {}) };
  } catch (err) {
    log(`!! Could not install the MySQL client: ${err.message}`);
    return { installed: false, error: err.message };
  }
}

// ---- firewall

async function openFirewall(M, allowFrom) {
  M.log("── Firewall ──");
  try {
    const r = await syncUfwRules({ allowFrom, ports: "3306", comment: UFW_COMMENT, log: M.log });
    if (r.active) {
      M.log(r.added.length || r.removed.length
        ? `MySQL port 3306: opened to ${r.added.join(", ") || "nobody new"}; closed to ${r.removed.join(", ") || "nobody"}.`
        : `MySQL port 3306 already open to ${allowFrom.join(", ") || "nobody"}.`);
    }
    return r;
  } catch (err) {
    M.log(`!! firewall: ${err.message}`);
    return { error: err.message };
  }
}

// ---- accounts

async function existingHosts(M, user) {
  if (M.dry) return [];
  const rows = await sqlLocal(M, `SELECT Host FROM mysql.user WHERE User = ${sqlString(user)};\n`, { timeoutMs: 15_000 });
  return rows.map((r) => r[0]).filter((h) => typeof h === "string");
}

/** Create / re-password the fcc accounts on this server only (sql_log_bin=0), dropping stale hosts. */
async function syncFccAccounts(M, list) {
  const accounts = [];
  const drop = [];
  for (const a of list) {
    accounts.push(a);
    if (a.exclusive) {
      for (const h of await existingHosts(M, a.user)) {
        if (!a.hosts.includes(h) && validHost(h)) drop.push({ user: a.user, host: h });
      }
    }
  }
  const { script, secrets } = buildAccountsSql({ accounts, drop, noBinlog: true });
  await sqlLocal(M, script, { secrets, timeoutMs: 60_000 });
  for (const a of accounts) M.log(`${a.user}@{${a.hosts.join(", ") || "—"}}: up to date.`);
  if (drop.length) M.log(`Removed stale accounts: ${drop.map((d) => `${d.user}@${d.host}`).join(", ")}.`);
}

// =================================================================== tasks

// ---- mysql.primary.prepare

export async function primaryPrepare(payload, o) {
  const M = ctxOf(o, "mysql.primary.prepare");
  const p = checkPreparePayload(payload);
  M.log("── MySQL server ──");
  const info = await requireRunning(M);
  const d = dialect(info.flavor, info.version);
  M.log(`${info.flavor === "mariadb" ? "MariaDB" : "MySQL"} ${info.version} · server_id ${info.serverId} → ${p.serverId} · read_only ${info.readOnly ? "ON" : "OFF"}`);
  checkAbort(M);

  M.log("── Replication settings ──");
  // read_only is kept as it is right now: preparing never fences or unfences.
  const cnf = await applyCnf(M, info.flavor, renderCnf({ flavor: info.flavor, version: info.version, serverId: p.serverId, readOnly: info.readOnly }));
  if (!M.dry) {
    const now = await serverInfo(M);
    const problems = [];
    if (now.serverId !== p.serverId) problems.push(`server_id is ${now.serverId}, not ${p.serverId}`);
    if (!now.logBin) problems.push("the binary log is off");
    if (now.flavor === "mysql" && now.gtidMode !== "ON") problems.push(`gtid_mode is ${now.gtidMode}`);
    if (problems.length) throw new Error(`After writing ${cnf.file}: ${problems.join(", ")} — another configuration file overrides it${cnf.restarted ? "" : ", or MySQL needs a restart"}.`);
  }
  checkAbort(M);

  M.log("── Accounts ──");
  await syncFccAccounts(M, [
    { user: p.replUser, password: p.replPassword, hosts: p.replicaIps, grants: [REPL_GRANT], exclusive: true },
    { user: ADMIN_USER, password: p.adminPassword, hosts: p.adminIps, grants: [ADMIN_GRANT], grantOption: true, exclusive: true },
  ]);
  const firewall = await openFirewall(M, p.allowFrom);

  saveState(M, { role: "primary", flavor: info.flavor, serverId: p.serverId });
  if (M.dry) saveDry(M, { role: "primary", serverId: p.serverId, replica: null });
  M.log("This server is ready to be the primary.");
  return {
    flavor: info.flavor,
    version: info.version,
    serverId: p.serverId,
    restarted: cnf.restarted,
    cnfChanged: cnf.changed,
    readOnly: info.readOnly,
    gtid: true,
    gtidExecuted: await executedGtid(M, d),
    firewall,
    ...(M.dry ? { dryRun: true } : {}),
  };
}

// ---- mysql.replica.setup

async function replicaSetupInner(M, p, pre = null) {
  // Version preflight — decides everything before anything on this server changes.
  M.log("── Versions ──");
  const primaryV = pre?.primary || (await primaryVersionOf(M, p));
  const plan = await planServer(M, p, primaryV);
  checkAbort(M);

  M.log("── MySQL server ──");
  const inst = await applyServerPlan(M, p, plan, primaryV);
  const info = await requireRunning(M);
  if (info.flavor !== p.flavor) throw new Error(`This server runs ${info.flavor} ${info.version}, but the primary runs ${p.flavor}.`);
  if (cmpSeries(seriesOf(info.version) || [0, 0], primaryV.series) < 0) {
    throw new Error(`After installing, this server still runs ${FLAVOR_NAME[info.flavor]} ${info.version}, older than the primary's ${primaryV.version}. Install ${FLAVOR_NAME[info.flavor]} ${primaryV.series.join(".")} or newer here by hand, then press Turn on replication again.`);
  }
  const d = dialect(info.flavor, info.version);
  M.log(`${info.flavor === "mariadb" ? "MariaDB" : "MySQL"} ${info.version} · server_id ${info.serverId} → ${p.serverId}`);
  if (p.seed) {
    // An older mysqldump cannot copy from a newer server (8.0's sends SHOW MASTER STATUS, gone in 8.4).
    const dv = await dumpVersion(M);
    const ds = seriesOf(dv);
    if (!ds) throw new Error(`${path.basename(dumpBin())} is missing or did not report its version — install the ${FLAVOR_NAME[p.flavor]} client (${PACKAGES[p.flavor].client.join(" ")}) ${primaryV.series.join(".")} or newer, then press Turn on replication again.`);
    if (cmpSeries(ds, primaryV.series) < 0) {
      throw new Error(`This server's ${path.basename(dumpBin())} is ${dv}, older than the primary's ${FLAVOR_NAME[p.flavor]} ${primaryV.version}; it cannot copy the databases from it. Install the ${FLAVOR_NAME[p.flavor]} ${primaryV.series.join(".")} client (${PACKAGES[p.flavor].client.join(" ")}), then press Turn on replication again.`);
    }
    M.log(`${path.basename(dumpBin())} ${dv}: new enough to copy from ${primaryV.version}.`);
  }
  checkAbort(M);

  M.log("── Replica settings ──");
  const cnf = await applyCnf(M, info.flavor, renderCnf({ flavor: info.flavor, version: info.version, serverId: p.serverId, readOnly: true }));
  await sqlLocal(M, "SET GLOBAL read_only = ON;\n", { timeoutMs: 15_000 });
  checkAbort(M);

  // The primary: reachable, same flavor, GTIDs on, a different server_id; TLS when it offers it.
  M.log("── Primary ──");
  const conn = { host: p.primaryHost, port: p.primaryPort, user: p.replUser, password: p.replPassword, extra: d.clientExtra };
  let primary = { version: primaryV.version, serverId: 0, ssl: false, gtid: "" };
  let databases = [];
  if (M.dry) {
    databases = p.databases ?? DRY_PRIMARY_DBS;
    await sqlRemote(M, conn, "SELECT VERSION(), @@GLOBAL.server_id, @@GLOBAL.log_bin;\nSHOW DATABASES;\n");
  } else {
    const rows = await sqlRemote(M, conn, `SELECT 'v', VERSION(), @@GLOBAL.server_id, @@GLOBAL.log_bin;\n${info.flavor === "mysql" ? "SELECT 'g', @@GLOBAL.gtid_mode;\n" : ""}SHOW SESSION STATUS LIKE 'Ssl_cipher';\n`);
    const v = rows.find((r) => r[0] === "v") || [];
    const g = rows.find((r) => r[0] === "g");
    const ssl = rows.find((r) => r[0] === "Ssl_cipher");
    primary = { version: v[1], serverId: Number(v[2]), logBin: v[3] === "1", gtidMode: g?.[1] ?? null, ssl: !!(ssl && ssl[1]) };
    if (flavorOf(primary.version) !== info.flavor) throw new Error(`The primary runs ${primary.version}; this server runs ${info.version}. Both must be ${info.flavor}.`);
    if (primary.serverId === p.serverId) throw new Error(`The primary already uses server_id ${p.serverId}; every server needs its own.`);
    if (!primary.logBin) throw new Error("The primary has no binary log — run mysql.primary.prepare on it first.");
    if (info.flavor === "mysql" && primary.gtidMode !== "ON") throw new Error(`The primary's gtid_mode is ${primary.gtidMode} — run mysql.primary.prepare on it first.`);
    const ps = seriesOf(primary.version);
    if (ps && cmpSeries(seriesOf(info.version) || [0, 0], ps) < 0) {
      throw new Error(`This server (${info.version}) is older than the primary (${primary.version}); ${FLAVOR_NAME[info.flavor]} cannot replicate from a newer series.`);
    }
    const all = (await sqlRemote(M, conn, "SHOW DATABASES;\n")).map((r) => r[0]).filter((n) => n && !SYSTEM_DBS.has(n.toLowerCase()));
    const unsafe = all.filter((n) => !ANY_DB_RE.test(n));
    if (p.databases) {
      databases = p.databases.filter((n) => all.includes(n));
      const missing = p.databases.filter((n) => !all.includes(n));
      if (missing.length) M.log(`!! Not on the primary (skipped): ${missing.join(", ")}`);
    } else {
      if (unsafe.length) throw new Error(`The primary has databases whose names cannot be copied safely: ${unsafe.map((n) => JSON.stringify(n)).join(", ")}. Rename them first.`);
      databases = all;
    }
  }
  M.log(`Primary ${p.primaryHost}:${p.primaryPort} — ${primary.version}${primary.ssl ? ", TLS" : ""}.`);
  checkAbort(M);

  M.log("── Accounts on this server ──");
  // fcc_admin for the panel; fcc_repl from the primary's address so the roles can be swapped later.
  const replHosts = net.isIP(p.primaryHost) ? [p.primaryHost] : [];
  await syncFccAccounts(M, [
    { user: ADMIN_USER, password: p.adminPassword, hosts: p.adminIps, grants: [ADMIN_GRANT], grantOption: true, exclusive: true },
    ...(replHosts.length ? [{ user: p.replUser, password: p.replPassword, hosts: replHosts, grants: [REPL_GRANT], exclusive: false }] : []),
  ]);
  const firewall = await openFirewall(M, p.allowFrom);
  checkAbort(M);

  let seededAt = null;
  if (p.seed) {
    M.log("── Copying the databases from the primary ──");
    await sqlTolerant(M, d.stopReplica, [1198, 1199, 1200, 1255, 3084, 3085]);
    await sqlTolerant(M, d.resetReplicaAll, [1198, 1200, 1201]);
    for (const stmt of d.clearGtidState) await sqlLocal(M, `${stmt};\n`, { timeoutMs: 120_000 });
    if (!databases.length) {
      M.log("The primary has no databases yet — taking its GTID position.");
      const pos = M.dry ? "" : (await sqlRemote(M, conn, `SELECT ${d.sourceGtidExpr};\n`))[0]?.[0] || "";
      if (pos) await sqlLocal(M, `${d.setSeedGtid(pos)};\n`, { timeoutMs: 60_000 });
    } else {
      M.log(`Databases: ${databases.join(", ")}`);
      // Remembered until the copy finishes: if it does not, these databases are known
      // to be partial copies of the primary's, which a later run may discard.
      saveState(M, { seeding: { at: new Date().toISOString(), primaryHost: p.primaryHost, databases } });
      const r = await seedFromPrimary(M, d, conn, databases);
      M.log(`Copied ${fmtBytes(r.bytes)} in ${Math.round(r.ms / 1000)} s.`);
    }
    seededAt = new Date().toISOString();
  } else {
    M.log("── Re-pointing replication (no copy) ──");
    await sqlTolerant(M, d.stopReplica, [1198, 1199, 1200, 1255, 3084, 3085]);
    await sqlTolerant(M, d.resetReplicaAll, [1198, 1200, 1201]);
    if (info.flavor === "mariadb") {
      // An old primary's own transactions are in gtid_binlog_pos; continue from there.
      await sqlLocal(M, "SET GLOBAL gtid_slave_pos = IF(@@GLOBAL.gtid_binlog_pos = '', @@GLOBAL.gtid_slave_pos, @@GLOBAL.gtid_binlog_pos);\n", { timeoutMs: 60_000 });
    }
  }
  checkAbort(M);

  M.log("── Starting replication ──");
  const change = `${d.changeSource({ host: p.primaryHost, port: p.primaryPort, user: p.replUser, password: p.replPassword, ssl: primary.ssl })};\n${d.startReplica};\n`;
  await sqlLocal(M, change, { secrets: [p.replPassword], timeoutMs: 60_000 });
  if (M.dry) {
    const s = dryState(M);
    saveDry(M, {
      role: "replica",
      readOnly: true,
      serverId: p.serverId,
      databases,
      replica: { ioRunning: true, ioState: "Yes", sqlRunning: true, lagSeconds: 0, lastError: null, sqlError: null, ioError: null, sourceHost: p.primaryHost, retrievedGtid: dryGtid(s), executedGtid: dryGtid(s) },
      // Writes that reached the primary during the copy, applied after it (see dryReplicaNow).
      catchUp: p.seed
        ? { at: Date.now(), total: Math.min(s.seq - 1, Math.max(0, Number(M.sim?.catchUpChanges ?? 1480) || 0)), ms: Math.max(1, Number(M.sim?.catchUpSeconds) || 14) * 1000, lagMax: 40 }
        : null,
    });
  }
  const st = await waitReplicating(M, d);
  M.log(`Replicating from ${p.primaryHost}: IO ${st.ioState}, SQL ${st.sqlRunning ? "Yes" : "No"}, ${st.lagSeconds ?? "?"} s behind.`);

  saveState(M, { role: "replica", flavor: info.flavor, serverId: p.serverId, primaryHost: p.primaryHost, primaryPort: p.primaryPort, seeding: null, ...(seededAt ? { seededAt } : {}) });
  return {
    flavor: info.flavor,
    version: info.version,
    primaryVersion: primaryV.version,
    serverId: p.serverId,
    restarted: cnf.restarted,
    installed: inst.installedNow,
    ...(inst.replaced ? { replacedVersion: plan.version, oldDataDir: inst.oldDataDir } : {}),
    ...(plan.source === "vendor" ? { repository: plan.line } : {}),
    seeded: p.seed,
    seededAt,
    databases,
    gtidExecuted: await executedGtid(M, d),
    sourceSsl: primary.ssl,
    replica: st,
    firewall,
    ...(M.dry ? { dryRun: true } : {}),
  };
}

async function waitReplicating(M, d, ms = 45_000) {
  const until = Date.now() + ms;
  let st = null;
  while (Date.now() < until) {
    checkAbort(M);
    st = await replicaStatus(M, d);
    if (!st) throw new Error("Replication is not configured after CHANGE … SOURCE — this should not happen.");
    if (st.ioRunning && st.sqlRunning) return st;
    if (!st.sqlRunning && st.sqlError) throw new Error(`Replication's SQL thread stopped: ${st.sqlError}`);
    if (st.ioState === "No" && st.ioError) throw new Error(`Replication cannot connect to the primary: ${st.ioError}`);
    await sleep(1000, M.signal);
  }
  throw new Error(`Replication did not start within ${Math.round(ms / 1000)} s (IO ${st?.ioState || "?"}${st?.lastError ? `: ${st.lastError}` : ""}).`);
}

/**
 * mysqldump on the primary | mysql here, streamed (no buffering), with
 * progress lines; the abort signal kills both processes.
 */
async function seedFromPrimary(M, d, conn, databases) {
  const dumpArgs = [
    "-h", conn.host, "-P", String(conn.port), "-u", conn.user, ...conn.extra,
    "--single-transaction", "--quick", "--routines", "--events", "--triggers",
    "--hex-blob", "--no-tablespaces", "--add-drop-database",
    "--default-character-set=utf8mb4", "--max-allowed-packet=1073741824",
    ...d.dumpPositionFlags,
    "--databases", ...databases,
  ];
  const loadBin = clientBin();
  const loadArgs = [...localArgs(M), "--batch", "--default-character-set=utf8mb4", "--max-allowed-packet=1073741824"];
  // The copy never goes into this server's binary log (no GTIDs of its own).
  const prelude = PRELUDE + "SET SESSION sql_log_bin = 0;\n";
  const sizes = await seedSizes(M, d, conn, databases);
  const est = new SeedEstimator({ databases, sizes });
  const scanner = new DumpScanner((name, at) => est.onDatabase(name, at));
  M.progress(est.snapshot());
  if (M.dry) return drySeedCopy(M, d, conn, databases, { est, scanner, dumpArgs, loadBin, loadArgs });
  let lastEmit = 0;
  const onChunk = (chunk) => {
    scanner.push(chunk);
    const now = Date.now();
    est.add(chunk.length, now);
    if (now - lastEmit >= 1000) {
      lastEmit = now;
      M.progress(est.snapshot(now));
    }
  };
  try {
    const r = await streamPipe(M, {
      from: { bin: dumpBin(), args: dumpArgs, env: { MYSQL_PWD: conn.password }, secrets: [conn.password] },
      to: { bin: loadBin, args: loadArgs, prelude },
      label: "copied",
      onChunk,
      describe: () => progressWords(est.snapshot()),
    });
    // Only now — mysql has exited 0 — is the copy complete.
    M.progress(est.finish(), { force: true });
    return r;
  } catch (err) {
    if (/MASTER STATUS|BINARY LOG STATUS/.test(err.message) && /1064|syntax/.test(err.message)) {
      throw new Error(`${err.message} — this server's ${path.basename(dumpBin())} speaks an older MySQL dialect than the primary; install the client of the primary's series here, then press Turn on replication again.`);
    }
    throw err;
  }
}

/**
 * Size of each database on the primary (information_schema, as fcc_repl —
 * SELECT on *.*), the basis of the copy's progress estimate. null when it
 * can't be read: the copy still runs, the progress bar is indeterminate.
 */
async function seedSizes(M, d, conn, databases) {
  if (!databases.length) return null;
  if (M.dry) {
    const sim = drySeedPlan(M, databases);
    // The simulated on-disk figures are deliberately off from the dump size, like real ones.
    return Object.fromEntries(sim.map((x) => [x.name, { data: Math.round(x.bytes * x.diskFactor), index: Math.round(x.bytes * 0.3), rows: Math.round(x.bytes / 180) }]));
  }
  try {
    // MySQL 8 caches table statistics for a day by default; ask for current ones.
    const fresh = d.flavor === "mysql" ? "SET SESSION information_schema_stats_expiry = 0;\n" : "";
    const rows = await sqlRemote(
      M,
      conn,
      `${fresh}SELECT table_schema, COALESCE(SUM(data_length), 0), COALESCE(SUM(index_length), 0), COALESCE(SUM(table_rows), 0) FROM information_schema.tables WHERE table_schema IN (${databases.map(sqlString).join(", ")}) GROUP BY table_schema;\n`,
      { timeoutMs: 120_000 },
    );
    const sizes = {};
    for (const r of rows) if (databases.includes(r[0])) sizes[r[0]] = { data: Number(r[1]) || 0, index: Number(r[2]) || 0, rows: Number(r[3]) || 0 };
    for (const n of databases) sizes[n] ||= { data: 0, index: 0, rows: 0 };
    const data = Object.values(sizes).reduce((a, x) => a + x.data, 0);
    const index = Object.values(sizes).reduce((a, x) => a + x.index, 0);
    M.log(`On the primary: ${fmtBytes(data)} of table data (+ ${fmtBytes(index)} of indexes, which are rebuilt here, not copied).`);
    return data > 0 ? sizes : null;
  } catch (err) {
    M.log(`(Could not read the databases' sizes from the primary — no time estimate: ${err.message.split("\n").pop()})`);
    return null;
  }
}

/** "42% · forthway (3 of 8) · 18 MB/s · about 4 min left" — for the 15 s log lines. */
function progressWords(p) {
  const bits = [];
  if (p.percent != null) bits.push(`${p.percent}%`);
  if (p.database) bits.push(`${p.database}${p.databaseIndex ? ` (${p.databaseIndex} of ${p.databasesTotal})` : ""}`);
  if (p.etaSeconds != null) bits.push(`about ${fmtEta(p.etaSeconds)} left`);
  return bits.join(" · ");
}

export function fmtEta(s) {
  if (s == null) return "";
  if (s < 45) return `${Math.max(5, Math.round(s / 5) * 5)} s`;
  if (s < 90) return "1 min";
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Simulated databases for a dry-run copy: FCC_MYSQL_DRY_SIM { seedBytes, seedSeconds }. */
function drySeedPlan(M, databases) {
  const total = Number(M.sim?.seedBytes) > 0 ? Number(M.sim.seedBytes) : 2.4 * 1024 ** 3;
  const weights = databases.map((_, i) => [0.58, 0.27, 0.09, 0.04, 0.02][i] ?? 0.01);
  const sum = weights.reduce((a, b) => a + b, 0);
  return databases.map((name, i) => ({ name, bytes: Math.round((total * weights[i]) / sum), diskFactor: 1.35 }));
}

/**
 * FCC_DRY_RUN: a believable copy (default 2.4 GB over ~24 s; FCC_MYSQL_DRY_SIM
 * seedSeconds / seedBytes) through the same scanner + estimator as a real one,
 * so the progress bar can be exercised end to end.
 */
async function drySeedCopy(M, d, conn, databases, { est, scanner, dumpArgs, loadBin, loadArgs }) {
  M.log(`[dry-run] ${path.basename(dumpBin())} ${dumpArgs.join(" ")} (password in MYSQL_PWD)`);
  M.log(`[dry-run]   | ${path.basename(loadBin)} ${loadArgs.join(" ")}  (stdin starts with: SET SESSION sql_log_bin = 0)`);
  const plan = drySeedPlan(M, databases);
  const total = plan.reduce((a, x) => a + x.bytes, 0);
  const seconds = Math.min(600, Math.max(2, Number(M.sim?.seedSeconds) || 24));
  const started = Date.now();
  const stepMs = 250;
  const perStep = total / ((seconds * 1000) / stepMs);
  let lastLog = started;
  let lastEmit = 0;
  for (const db of plan) {
    const marker = Buffer.from(`\n--\n-- Current Database: \`${db.name}\`\n--\n`);
    scanner.push(marker);
    est.add(marker.length);
    let left = db.bytes;
    while (left > 0) {
      checkAbort(M);
      await sleep(stepMs, M.signal);
      checkAbort(M);
      // Uneven, like a real import: big tables crawl, small ones fly.
      const n = Math.min(left, Math.round(perStep * (0.6 + Math.random() * 0.8)));
      left -= n;
      scanner.skip(n); // the bytes "went through" the pipe
      const now = Date.now();
      est.add(n, now);
      if (now - lastEmit >= 1000) {
        lastEmit = now;
        M.progress(est.snapshot(now));
      }
      if (now - lastLog >= PROGRESS_EVERY_MS) {
        lastLog = now;
        M.log(`[dry-run] … ${fmtBytes(est.bytes)} copied · ${progressWords(est.snapshot(now))}`);
      }
    }
  }
  M.progress(est.finish(), { force: true });
  return { bytes: est.bytes, ms: Date.now() - started, dryRun: true };
}

/**
 * Spawn `from` and pipe its stdout into `to` (a process, or a file via
 * `toFile` with optional gzip). Resolves { bytes, ms }. `onChunk(chunk)` sees
 * every chunk (progress); `describe()` adds words to the 15 s log lines.
 */
function streamPipe(M, { from, to, toFile, label, onChunk, describe }) {
  const fromShown = `${path.basename(from.bin)} ${from.args.join(" ")}`;
  if (M.dry) {
    M.log(`[dry-run] ${fromShown}${from.env?.MYSQL_PWD ? " (password in MYSQL_PWD)" : ""}`);
    if (to) M.log(`[dry-run]   | ${path.basename(to.bin)} ${to.args.join(" ")}  (stdin starts with: SET SESSION sql_log_bin = 0)`);
    if (toFile) M.log(`[dry-run]   | gzip > ${toFile.file}`);
    return Promise.resolve({ bytes: 0, ms: 0, dryRun: true });
  }
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(from.env || {}) };
    const src = spawn(from.bin, from.args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const dst = to ? spawn(to.bin, to.args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] }) : null;
    let bytes = 0;
    let lastLog = Date.now();
    let srcErr = "";
    let dstErr = "";
    const codes = {};
    let aborted = false;
    let settled = false;
    const counter = new Transform({
      transform(chunk, _e, cb) {
        bytes += chunk.length;
        if (onChunk) {
          try {
            onChunk(chunk);
          } catch {
            /* progress must never break the copy */
          }
        }
        if (Date.now() - lastLog >= PROGRESS_EVERY_MS) {
          lastLog = Date.now();
          let more = "";
          try {
            more = describe ? describe() : "";
          } catch {
            more = "";
          }
          M.log(`… ${fmtBytes(bytes)} ${label} (${fmtBytes(Math.round(bytes / Math.max(1, (Date.now() - started) / 1000)))}/s)${more ? ` · ${more}` : ""}`);
        }
        cb(null, chunk);
      },
    });
    // Kill both and tear the pipe down: a paused, backpressured stdout would
    // otherwise never end, and the child's 'close' event would never come.
    const killAll = () => {
      for (const c of [src, dst]) {
        try {
          if (c && c.exitCode == null && c.signalCode == null) c.kill("SIGTERM");
        } catch {
          /* gone */
        }
      }
      for (const st of [src.stdout, counter, dst?.stdin]) {
        try {
          st?.destroy();
        } catch {
          /* already closed */
        }
      }
    };
    const onAbort = () => {
      aborted = true;
      killAll();
    };
    M.signal?.addEventListener?.("abort", onAbort, { once: true });

    let fileDone = toFile ? null : Promise.resolve();
    if (dst) {
      dst.stdin.on("error", () => {}); // EPIPE when mysql exits early; its exit code tells the story
      dst.stdin.write(to.prelude || "");
      src.stdout.pipe(counter).pipe(dst.stdin);
      dst.stdout.resume();
      dst.stderr.on("data", (b) => {
        const s = b.toString("utf8");
        dstErr = (dstErr + s).slice(-8192);
        for (const l of s.split("\n")) if (l.trim()) M.log(`mysql: ${maskSecrets(l, from.secrets)}`);
      });
    } else {
      const stages = [src.stdout, counter];
      if (toFile.gzip) stages.push(zlib.createGzip({ level: 6 }));
      stages.push(fs.createWriteStream(toFile.file, { mode: 0o600 }));
      fileDone = pipeline(...stages);
      fileDone.catch(() => killAll());
    }
    src.stderr.on("data", (b) => {
      const s = b.toString("utf8");
      srcErr = (srcErr + s).slice(-8192);
      for (const l of s.split("\n")) if (l.trim()) M.log(l.startsWith(path.basename(from.bin)) ? maskSecrets(l, from.secrets) : `${path.basename(from.bin)}: ${maskSecrets(l, from.secrets)}`);
    });

    const tail = (t) => maskSecrets(t, from.secrets).trim().split("\n").slice(-4).join(" | ");
    const finish = async () => {
      if (settled) return;
      if (!("src" in codes) || (dst && !("dst" in codes))) return;
      settled = true;
      let fileErr = null;
      try {
        await fileDone;
      } catch (e) {
        fileErr = e;
      }
      M.signal?.removeEventListener?.("abort", onAbort);
      if (aborted || M.signal?.aborted) return reject(abortError());
      if (codes.src !== 0) return reject(new Error(`${path.basename(from.bin)} failed (exit ${codes.src})${srcErr ? `: ${tail(srcErr)}` : ""}`));
      if (dst && codes.dst !== 0) return reject(new Error(`Loading into the local MySQL failed (exit ${codes.dst})${dstErr ? `: ${tail(dstErr)}` : ""}`));
      if (fileErr) return reject(new Error(`Writing ${toFile.file} failed: ${fileErr.message}`));
      resolve({ bytes, ms: Date.now() - started });
    };
    const mark = (k, code) => {
      if (k in codes) return;
      codes[k] = code;
      if (code !== 0) killAll();
      finish();
    };
    src.on("error", (e) => {
      srcErr += e.code === "ENOENT" ? `${from.bin} is not installed` : e.message;
      mark("src", -1);
    });
    src.on("close", (code) => mark("src", code ?? -1));
    if (dst) {
      dst.on("error", (e) => {
        dstErr += e.code === "ENOENT" ? `${to.bin} is not installed` : e.message;
        mark("dst", -1);
      });
      dst.on("close", (code) => mark("dst", code ?? -1));
    }
  });
}

export async function replicaSetup(payload, o) {
  const M = ctxOf(o, "mysql.replica.setup");
  const p = checkSetupPayload(payload);
  return replicaSetupInner(M, p);
}

// ---- mysql.status

export async function mysqlStatus(_payload, o) {
  const M = ctxOf(o || {}, "mysql.status");
  const st = readHaState(M.dataDir);
  if (M.dry) {
    const s = dryState(M);
    const role = s.role === "replica" && s.replica ? "replica" : s.role === "primary" ? "primary" : "standalone";
    return {
      installed: !!s.installed,
      running: true,
      flavor: s.flavor,
      version: s.version,
      readOnly: !!s.readOnly,
      serverId: s.serverId,
      role,
      gtidExecuted: dryGtid(s),
      replica: role === "replica" ? dryReplicaNow(s) : null,
      managed: exists(cnfPath(M, s.flavor)),
      dryRun: true,
    };
  }
  if (!M.hook && !serverBinary()) return { installed: false, running: false, flavor: null, version: null, readOnly: null, role: "standalone", replica: null };
  let info;
  try {
    info = await serverInfo(M);
  } catch (e) {
    return {
      installed: true,
      running: !NOT_RUNNING_CODES.has(e.mysqlCode),
      flavor: st.flavor || null,
      version: null,
      readOnly: null,
      role: st.role === "primary" || st.role === "replica" ? st.role : "standalone",
      replica: null,
      error: e.message,
    };
  }
  const d = dialect(info.flavor, info.version);
  const [gtid, rep] = await Promise.all([executedGtid(M, d).catch(() => null), replicaStatus(M, d).catch((e) => ({ error: e.message }))]);
  const replica = rep && !rep.error ? rep : null;
  const role = replica ? "replica" : st.role === "primary" ? "primary" : "standalone";
  return {
    installed: true,
    running: true,
    flavor: info.flavor,
    version: info.version,
    readOnly: info.readOnly,
    serverId: info.serverId,
    role,
    gtidExecuted: gtid,
    replica,
    managed: exists(cnfPath(M, info.flavor)),
    ...(rep?.error ? { error: rep.error } : {}),
  };
}

let statusCache = null;
let statusInflight = null;
/** For node-agent metrics: null when no database server is installed; refreshed at most every maxAgeMs. */
export async function mysqlStatusCached(dataDir, maxAgeMs = 30_000) {
  if (sys.DRY_RUN) {
    if (!exists(path.join(dataDir, DRY_STATE_FILE))) return null;
  } else if (!process.env.FCC_MYSQL_TEST_DEFAULTS && !serverBinary()) return null;
  if (statusCache && statusCache.dataDir === dataDir && Date.now() - statusCache.at < maxAgeMs) return statusCache.value;
  if (!statusInflight) {
    statusInflight = mysqlStatus({}, { dataDir })
      .catch((e) => ({ installed: true, running: false, error: e.message, role: "standalone", replica: null }))
      .then((value) => {
        statusCache = { at: Date.now(), dataDir, value };
        return value;
      })
      .finally(() => {
        statusInflight = null;
      });
  }
  return statusInflight;
}

function forgetStatus() {
  statusCache = null;
}

// ---- mysql.replica.promote

export async function replicaPromote(payload, o) {
  const M = ctxOf(o, "mysql.replica.promote");
  const waitMs = Math.min(Math.max(Number(payload?.waitMs ?? 30_000) || 0, 0), 100_000);
  forgetStatus();
  const info = await requireRunning(M);
  const d = dialect(info.flavor, info.version);
  let st = await replicaStatus(M, d);
  const done = [];
  const where = { ioStopped: false, replicationRemoved: false, writable: false };

  const fail = async (step, err) => {
    if (err.aborted) M.log("-- cancelled in the middle of promoting");
    let state;
    if (!where.replicationRemoved) {
      let restarted = false;
      if (where.ioStopped) {
        try {
          await sqlLocal(M, `${d.startReplica};\n`, { timeoutMs: 20_000 });
          restarted = true;
        } catch (e2) {
          M.log(`!! Could not restart replication: ${e2.message}`);
        }
      }
      state = restarted || !where.ioStopped
        ? "still a read-only replica — replication is running again and nothing was changed"
        : "still a read-only replica, but replication is STOPPED (its settings are intact): start it again with mysql.replica.setup { seed: false } or retry the promotion";
    } else if (!where.writable) {
      state = "replication settings are already REMOVED but the server is still READ-ONLY: run mysql.replica.promote again (safe to repeat) or mysql.readonly { on: false }";
    } else {
      state = "promoted and writable";
    }
    const e = new Error(`Promotion failed while ${step}: ${err.message}. This server is ${state}.`);
    e.aborted = !!err.aborted;
    e.result = { promoted: where.writable, state, steps: done, ...where };
    M.log(`!! ${e.message}`);
    throw e;
  };

  if (!st) {
    M.log("No replication is configured here — only making the server writable.");
  } else {
    M.log(`Replica of ${st.sourceHost}: IO ${st.ioState}, SQL ${st.sqlRunning ? "Yes" : "No"}${st.lastError ? `, last error: ${st.lastError}` : ""}.`);
    try {
      await sqlLocal(M, `${d.stopIoThread};\n`, { timeoutMs: 20_000 });
      where.ioStopped = true;
      done.push("io-stopped");
      M.log("Stopped receiving from the old primary.");
    } catch (err) {
      await fail("stopping the IO thread", err);
    }
  }

  let appliedAll = true;
  if (st) {
    try {
      st = (await replicaStatus(M, d)) || st;
      const pending = st.retrievedGtid;
      const appliedNow = async () => (M.dry ? true : (await sqlLocal(M, `${d.appliedCheck(pending)};\n`, { timeoutMs: 15_000 }))[0]?.[0] === "1");
      if (!pending) {
        appliedAll = true;
      } else if (!st.sqlRunning || waitMs < 1000) {
        if (!st.sqlRunning) M.log(`!! The SQL thread is not running${st.sqlError ? ` (${st.sqlError})` : ""} — checking whether everything received was applied.`);
        appliedAll = await appliedNow();
        M.log(appliedAll ? "Everything received from the old primary is applied." : "!! Some received transactions were NOT applied.");
      } else {
        M.log(`Waiting up to ${Math.round(waitMs / 1000)} s for everything received to be applied…`);
        const r = await sqlLocal(M, `${d.waitForGtid(pending, waitMs / 1000)};\n`, { timeoutMs: waitMs + 15_000 });
        appliedAll = M.dry ? true : d.waitOk(r[0]?.[0]);
        M.log(appliedAll ? "Everything received from the old primary is applied." : "!! Timed out — some received transactions were not applied yet.");
      }
      done.push("drained");
      await sqlTolerant(M, d.stopReplica, [1198, 1199, 1200, 1255, 3084, 3085]);
      await sqlLocal(M, `${d.resetReplicaAll};\n`, { timeoutMs: 30_000 });
      where.replicationRemoved = true;
      done.push("replication-removed");
      M.log("Replication settings removed.");
    } catch (err) {
      await fail(where.replicationRemoved ? "removing the replication settings" : "draining the relay log", err);
    }
  }

  try {
    await sqlLocal(M, d.superReadOnly ? "SET GLOBAL super_read_only = OFF;\nSET GLOBAL read_only = OFF;\n" : "SET GLOBAL read_only = OFF;\n", { timeoutMs: 15_000 });
    where.writable = true;
    done.push("writable");
    M.log("read_only is OFF — this server is the primary now.");
  } catch (err) {
    await fail("turning read_only off", err);
  }

  let cnfWarning = null;
  try {
    const c = setCnfReadOnly(M, info.flavor, false);
    if (c.skipped) cnfWarning = c.skipped;
    else M.log(c.changed ? `${c.file}: read_only = OFF.` : `${c.file} already says read_only = OFF.`);
  } catch (err) {
    cnfWarning = `could not update the configuration file: ${err.message} — MySQL would come back read-only after a restart`;
    M.log(`!! ${cnfWarning}`);
  }
  saveState(M, { role: "primary", flavor: info.flavor, promotedAt: new Date().toISOString() });
  if (M.dry) saveDry(M, { role: "primary", readOnly: false, replica: null, seq: dryState(M).seq + 1 });
  return {
    promoted: true,
    wasReplica: !!st,
    appliedAll,
    executedGtid: await executedGtid(M, d).catch(() => null),
    steps: done,
    ...(cnfWarning ? { warning: cnfWarning } : {}),
    ...(M.dry ? { dryRun: true } : {}),
  };
}

// ---- mysql.readonly

export async function setReadOnly(payload, o) {
  const M = ctxOf(o, "mysql.readonly");
  if (typeof payload?.on !== "boolean") throw bad("mysql.readonly", "on must be true or false");
  const on = payload.on;
  forgetStatus();
  let flavor = readHaState(M.dataDir).flavor;
  let before = null;
  if (M.dry) {
    const s = dryState(M);
    flavor = s.flavor;
    before = !!s.readOnly;
  } else {
    const rows = await sqlLocal(M, "SELECT VERSION(), @@GLOBAL.read_only;\n", { timeoutMs: 4000, connectTimeout: 2 });
    flavor = flavorOf(rows[0]?.[0]);
    before = rows[0]?.[1] === "1";
  }
  const sql = on ? "SET GLOBAL read_only = ON;\n" : flavor === "mysql" ? "SET GLOBAL super_read_only = OFF;\nSET GLOBAL read_only = OFF;\n" : "SET GLOBAL read_only = OFF;\n";
  await sqlLocal(M, sql, { timeoutMs: 4000, connectTimeout: 2 });
  let cnf = null;
  try {
    cnf = setCnfReadOnly(M, flavor, on);
  } catch (err) {
    cnf = { error: err.message };
    M.log(`!! ${err.message}`);
  }
  if (M.dry) saveDry(M, { readOnly: on });
  M.log(`read_only ${on ? "ON" : "OFF"}${before === on ? " (it already was)" : ""}${cnf?.changed ? `; ${cnf.file} updated` : ""}.`);
  return { readOnly: on, changed: before !== on, cnfChanged: !!cnf?.changed, ...(cnf?.error || cnf?.skipped ? { warning: cnf.error || cnf.skipped } : {}), ...(M.dry ? { dryRun: true } : {}) };
}

// ---- mysql.users.sync

export async function usersSync(payload, o) {
  const M = ctxOf(o, "mysql.users.sync");
  let replica = false;
  let partialRevokes = false;
  if (M.dry) {
    replica = dryState(M).role === "replica";
  } else {
    const info = await serverInfo(M);
    const d = dialect(info.flavor, info.version);
    replica = !!(await replicaStatus(M, d));
    if (info.flavor === "mysql") {
      try {
        partialRevokes = (await sqlLocal(M, "SELECT @@GLOBAL.partial_revokes;\n", { timeoutMs: 15_000 }))[0]?.[0] === "1";
      } catch {
        partialRevokes = false;
      }
    }
  }
  const plan = buildUsersSyncSql(payload, { replica, partialRevokes });
  if (!plan.users && !plan.removed) return { users: 0, removed: 0, replica };
  M.log(`${plan.users} user(s) to create/update, ${plan.removed} to remove${replica ? " — this server is a replica, so nothing goes into its binary log" : ""}.`);
  await sqlLocal(M, plan.script, { secrets: plan.secrets, timeoutMs: 120_000 });
  return { users: plan.users, removed: plan.removed, replica, noBinlog: replica, ...(M.dry ? { dryRun: true } : {}) };
}

// ---- mysql.rebuild

export async function rebuild(payload, o) {
  const M = ctxOf(o, "mysql.rebuild");
  const p = checkSetupPayload(payload, "mysql.rebuild");
  p.seed = true; // a rebuild always copies everything again
  forgetStatus();
  // Versions first: refuse an impossible upgrade before any database is dumped or dropped.
  M.log("── Versions ──");
  const primaryV = await primaryVersionOf(M, p);
  const plan = await planServer(M, p, primaryV, { rebuild: true });
  checkAbort(M);
  M.log("── Safety copy of this server's databases ──");
  const info = await requireRunning(M);
  const d = dialect(info.flavor, info.version);
  let dbs;
  if (M.dry) dbs = dryState(M).databases || [];
  else dbs = (await sqlLocal(M, "SHOW DATABASES;\n", { timeoutMs: 30_000 })).map((r) => r[0]).filter((n) => n && !SYSTEM_DBS.has(n.toLowerCase()));
  const unsafe = dbs.filter((n) => !ANY_DB_RE.test(n));
  if (unsafe.length) throw new Error(`mysql.rebuild: databases with names that cannot be handled safely: ${unsafe.map((n) => JSON.stringify(n)).join(", ")} — nothing was changed.`);

  // Fence first: nothing may write here while it is copied and dropped.
  await sqlLocal(M, "SET GLOBAL read_only = ON;\n", { timeoutMs: 15_000 });
  let safetyDump = null;
  if (dbs.length) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const dir = M.dry ? path.join(M.dataDir, "mysql-dry-run", "backups") : M.hook ? path.dirname(M.hook.cnfFile) : SAFETY_DUMP_DIR;
    ensureDir(dir);
    safetyDump = path.join(dir, `fcc-mysql-before-rebuild-${stamp}.sql.gz`);
    const tmp = `${safetyDump}.partial`;
    const args = [...localArgs(M), "--single-transaction", "--quick", "--routines", "--events", "--triggers", "--hex-blob", "--no-tablespaces", "--default-character-set=utf8mb4", "--max-allowed-packet=1073741824", ...(info.flavor === "mysql" ? ["--set-gtid-purged=OFF"] : []), "--databases", ...dbs];
    M.log(`Dumping ${dbs.join(", ")} to ${safetyDump}…`);
    try {
      const r = await streamPipe(M, { from: { bin: dumpBin(), args, secrets: [] }, toFile: { file: tmp, gzip: true }, label: "dumped" });
      if (M.dry) fs.writeFileSync(tmp, zlib.gzipSync(`-- dry-run safety dump of ${dbs.join(", ")}\n`), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, safetyDump);
      M.log(`Safety copy: ${safetyDump} (${fmtBytes(fs.statSync(safetyDump).size)}${r.bytes ? ` from ${fmtBytes(r.bytes)} of SQL` : ""}).`);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      const e = new Error(`mysql.rebuild: the safety copy ${err.aborted ? "was cancelled" : `failed (${err.message})`} — no database was dropped; the server stays read-only.`);
      e.aborted = !!err.aborted;
      throw e;
    }
    checkAbort(M);
    M.log("── Dropping the old databases ──");
    await sqlTolerant(M, d.stopReplica, [1198, 1199, 1200, 1255, 3084, 3085]);
    await sqlLocal(M, `SET SESSION sql_log_bin = 0;\n${dbs.map((n) => `DROP DATABASE IF EXISTS ${quoteDb(n)};`).join("\n")}\n`, { timeoutMs: 30 * 60_000 });
    M.log(`Dropped ${dbs.length} database(s).`);
  } else {
    M.log("This server has no databases of its own — nothing to keep.");
  }
  if (M.dry) saveDry(M, { databases: [] });
  checkAbort(M);
  const r = await replicaSetupInner(M, p, { primary: primaryV });
  return { safetyDump, droppedDatabases: dbs, ...r };
}

// ---- mysql.probe (3.10, fast failover: the replica's view of the primary)

/**
 * mysql.probe { host, port = 3306, timeoutMs = 800 } → { reachable, ms, error }
 * One TCP connect from this server to host:port, closed as soon as the MySQL
 * greeting (or anything) arrives — no sign-in, nothing sent. Used by the panel
 * to confirm "the primary is down" from the replica's side of the network
 * (the IO thread can take a minute to notice a primary that vanished without a
 * reset). Dry run: reachable unless this server is a simulated replica whose
 * IO thread is not running (mysql-ha-dry.json replica.ioRunning === false).
 */
export async function mysqlProbe(payload, o) {
  const host = String(payload?.host ?? "").trim();
  if (!validHost(host)) throw new Error("mysql.probe: host must be an IP address or host name");
  const port = payload?.port === undefined ? 3306 : Number(payload.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("mysql.probe: port is not a valid port");
  const timeoutMs = Math.min(5000, Math.max(200, Number(payload?.timeoutMs) || 800));
  const t0 = Date.now();
  if (sys.DRY_RUN) {
    const s = dryState({ dataDir: (o || {}).dataDir || process.env.FCC_DATA_DIR || "/var/lib/fcc" });
    const reachable = !(s.role === "replica" && s.replica && s.replica.ioRunning === false);
    return { reachable, ms: 1, host, port, dryRun: true, ...(reachable ? {} : { error: "simulated: the replica's IO thread is not running" }) };
  }
  return new Promise((resolve) => {
    let done = false;
    const sock = net.connect({ host, port });
    const finish = (reachable, error = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ reachable, ms: Date.now() - t0, host, port, ...(error ? { error } : {}) });
    };
    const timer = setTimeout(() => finish(false, `no answer within ${timeoutMs} ms`), timeoutMs);
    // Connected is enough to call it reachable; wait briefly for the greeting so the
    // server does not log an aborted handshake for every probe, then close.
    sock.once("connect", () => setTimeout(() => finish(true), 150));
    sock.once("data", () => finish(true));
    sock.once("error", (e) => finish(false, e.code || e.message));
  });
}

// =================================================================== dispatcher (shared/tasks.mjs)

export const MYSQL_TASKS = {
  "mysql.primary.prepare": primaryPrepare,
  "mysql.replica.setup": replicaSetup,
  "mysql.status": mysqlStatus,
  "mysql.replica.promote": replicaPromote,
  "mysql.readonly": setReadOnly,
  "mysql.users.sync": usersSync,
  "mysql.rebuild": rebuild,
  "mysql.probe": mysqlProbe,
};

export async function runMysqlTask(type, payload, o) {
  const fn = MYSQL_TASKS[type];
  if (!fn) throw new Error(`Unknown task type "${type}"`);
  try {
    return await fn(payload || {}, o);
  } finally {
    if (type !== "mysql.status" && type !== "mysql.probe") forgetStatus();
  }
}
