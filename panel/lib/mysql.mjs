/**
 * DATA — MySQL / MariaDB on the main server.
 *
 * Everything goes through the `mysql` / `mysqldump` command line clients (no
 * npm driver). Root access is, in order of preference:
 *   1. unix-socket auth (`mysql -u root` as the OS root user — the Ubuntu and
 *      Debian default for both MySQL and MariaDB), or
 *   2. a root password stored encrypted in config.mysql.rootPasswordEnc,
 *      handed to the client in the MYSQL_PWD environment variable.
 * A password never appears in argv: SQL (which can contain one) is written to
 * the client's stdin, so neither `ps` nor job logs can show it.
 *
 * Injection surface. The only user input that reaches SQL is:
 *   - database / user names — normalised then validated against
 *     ^[a-z][a-z0-9_]*$ (64 / 32 chars) and always prefixed with the
 *     project's slug, then backtick-quoted (`quoteIdent`);
 *   - passwords — printable ASCII only, emitted with `sqlString`, which
 *     doubles quotes and backslashes so it is injection-safe whether or not
 *     NO_BACKSLASH_ESCAPES is on (and every script first turns it off);
 *   - worker host names / IPs — validated by `validHost`.
 * There is no arbitrary SQL endpoint.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import dns from "node:dns/promises";
import net from "node:net";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { finished } from "node:stream/promises";

import { httpError } from "./http.mjs";
import { run, which, DRY_RUN } from "./sys.mjs";

const MAIN_ID = "main";
const RESERVED = new Set(["mysql", "information_schema", "performance_schema", "sys", "test", "root", "mariadb.sys", "debian-sys-maint"]);
const DB_NAME_MAX = 64;
const USER_MAX = 32;
const PREFIX_MAX = 16;
const IMPORT_LIMIT = 4 * 1024 * 1024 * 1024; // 4 GB per upload

/** charset → allowed collations (first is the default). */
export const CHARSETS = {
  utf8mb4: ["utf8mb4_unicode_ci", "utf8mb4_general_ci", "utf8mb4_0900_ai_ci", "utf8mb4_unicode_520_ci", "utf8mb4_bin"],
  utf8mb3: ["utf8mb3_unicode_ci", "utf8mb3_general_ci", "utf8mb3_bin"],
  latin1: ["latin1_swedish_ci", "latin1_general_ci", "latin1_bin"],
  ascii: ["ascii_general_ci", "ascii_bin"],
};

// ------------------------------------------------------------ pure helpers
// Exported so they can be unit-tested in isolation.

/** Project slug used as name prefix: [a-z][a-z0-9_]{0,15}. */
export function projectPrefix(project) {
  let s = String(project?.slug || project?.name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(s)) s = `p${s}`;
  s = s.slice(0, PREFIX_MAX).replace(/_+$/, "");
  if (s === "p") s = `p${String(project?.id || "").replace(/[^a-z0-9]/g, "").slice(-6)}` || "p";
  return s;
}

/** Lower-case, spaces/hyphens/dots → "_", then strictly [a-z0-9_]. Returns null if invalid. */
export function normalizeName(input) {
  if (typeof input !== "string") return null;
  const s = input.trim().toLowerCase().replace(/[ .-]+/g, "_");
  if (!s || !/^[a-z0-9_]+$/.test(s)) return null;
  return s;
}

/** A final identifier we are willing to put between backticks. */
export function isValidIdent(s, max = DB_NAME_MAX) {
  return typeof s === "string" && s.length >= 1 && s.length <= max && /^[a-z][a-z0-9_]*$/.test(s) && !RESERVED.has(s);
}

/** `<prefix>_<name>` unless the name already carries the prefix. Throws 400 on anything off. */
export function prefixedName(prefix, input, max, what = "Name") {
  if (!isValidIdent(prefix, PREFIX_MAX)) throw httpError(400, "Project prefix is invalid.");
  const n = normalizeName(input);
  if (!n) throw httpError(400, `${what} may only contain letters, digits and underscores.`);
  const full = n === prefix || n.startsWith(`${prefix}_`) ? n : `${prefix}_${n}`;
  if (full.length > max) throw httpError(400, `${what} "${full}" is longer than ${max} characters.`);
  if (!isValidIdent(full, max)) throw httpError(400, `${what} "${full}" is not allowed.`);
  return full;
}

/** Backtick-quote an identifier that already passed validation (re-checked here). */
export function quoteIdent(s) {
  if (typeof s !== "string" || !/^[a-z0-9_]{1,64}$/.test(s)) throw new Error(`Refusing unsafe identifier: ${JSON.stringify(s)}`);
  return `\`${s}\``;
}

/**
 * Database pattern for a db-level GRANT. `_` and `%` are wildcards there, so
 * `acme_shop` would also match `acmeXshop`; escape them — unless MySQL 8's
 * partial_revokes is on, which makes them literal (escaping would then break).
 */
export function grantDbPattern(name, partialRevokes = false) {
  quoteIdent(name);
  return `\`${partialRevokes ? name : name.replace(/_/g, "\\_")}\``;
}

/**
 * SQL string literal. Only printable ASCII is accepted (no NUL / newline /
 * multibyte tricks). Quotes are doubled (`''`, safe in every sql_mode) and
 * backslashes doubled (`\\`; if NO_BACKSLASH_ESCAPES were somehow on, that is
 * two literal backslashes — wrong value, but still no way out of the string).
 */
export function sqlString(s) {
  if (typeof s !== "string" || !/^[\x20-\x7e]*$/.test(s)) throw new Error("Refusing to quote a value with non-printable characters.");
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

export function account(user, host) {
  if (typeof user !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(user)) throw new Error("Invalid user name.");
  if (!validHost(host)) throw new Error(`Invalid host: ${host}`);
  return `${sqlString(user)}@${sqlString(host)}`;
}

/** Host part of an account: hostname, IPv4 or IPv6. No wildcards. */
export function validHost(h) {
  if (typeof h !== "string" || !h || h.length > 255) return false;
  if (h === "localhost") return true;
  if (net.isIP(h)) return true;
  return /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(h);
}

/** User-chosen password: 8–128 printable ASCII, no spaces. */
export function validPassword(p) {
  return typeof p === "string" && p.length >= 8 && p.length <= 128 && /^[\x21-\x7e]+$/.test(p);
}

/** Strong random password, alphanumeric (safe in URLs, .env files and shells). */
export function generatePassword(len = 32) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; // 62
  let out = "";
  while (out.length < len) {
    for (const b of crypto.randomBytes(len * 2)) {
      if (b < 248 && out.length < len) out += A[b % 62]; // 248 = 62*4, no modulo bias
    }
  }
  return out;
}

/** Parse `mysql --batch --skip-column-names` output (tab separated, backslash escaped). */
export function parseRows(stdout) {
  if (!stdout) return [];
  const un = (v) =>
    v === "NULL" ? null : v.replace(/\\(.)/g, (_, c) => ({ n: "\n", t: "\t", "0": "\0", "\\": "\\" })[c] ?? c);
  return stdout
    .replace(/\n$/, "")
    .split("\n")
    .filter((l) => l.length)
    .map((l) => l.split("\t").map(un));
}

/** Strip a trailing :port and brackets from a server host string. */
export function cleanHost(h) {
  if (!h || typeof h !== "string") return null;
  let s = h.trim();
  if (/^\[.*\](:\d+)?$/.test(s)) s = s.slice(1, s.indexOf("]"));
  else if (/^[^:]+:\d+$/.test(s)) s = s.replace(/:\d+$/, "");
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return validHost(s) ? s : null;
}

function urlHost(h) {
  return net.isIPv6(h) ? `[${h}]` : h;
}

function scrub(err, secrets) {
  const list = secrets.filter((s) => s && s.length >= 4);
  if (!list.length) return err;
  const clean = (t) => list.reduce((acc, s) => acc.split(s).join("••••"), String(t || ""));
  const e = new Error(clean(err.message));
  e.status = err.status;
  e.mysqlCode = err.mysqlCode;
  return e;
}

function mysqlCodeOf(err) {
  const m = /ERROR (\d{4})/.exec(String(err?.message || ""));
  return m ? Number(m[1]) : null;
}

const NOT_RUNNING_CODES = new Set([2002, 2003, 2006, 2013]);
const ACCESS_DENIED_CODES = new Set([1044, 1045, 1698]);

// Every script starts by making backslash escapes active, so sqlString's
// `\\` means one backslash. (Statements are each on their own line, so the
// client re-reads the server status flag before parsing the rest.)
const PRELUDE = "SET SESSION sql_mode = (SELECT REPLACE(@@SESSION.sql_mode, 'NO_BACKSLASH_ESCAPES', ''));\n";

/** Run `cmd args` with a readable stream on stdin (run() only takes a buffer). Honours DRY_RUN. */
export function runWithStdin(cmd, args, { stdin, env = null, log = null, signal = null } = {}) {
  if (DRY_RUN) {
    log?.(`[dry-run] ${[cmd, ...args].join(" ")} < (stream)`);
    stdin?.resume?.();
    return Promise.resolve({ code: 0, stdout: "", stderr: "", dryRun: true });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: env ? { ...process.env, ...env } : process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    const onLine = (s, isErr) => {
      if (isErr) stderr += s;
      else stdout += s;
      if (stdout.length > 65536) stdout = stdout.slice(-65536);
      if (stderr.length > 65536) stderr = stderr.slice(-65536);
      for (const l of s.split("\n")) if (l.trim()) log?.(l);
    };
    child.stdout.on("data", (d) => onLine(d.toString("utf8"), false));
    child.stderr.on("data", (d) => onLine(d.toString("utf8"), true));
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    let pipeErr = null;
    pipeline(stdin, child.stdin).catch((e) => {
      // EPIPE when mysql exits early on an SQL error; the exit code tells the story.
      if (e.code !== "EPIPE" && e.code !== "ERR_STREAM_PREMATURE_CLOSE") pipeErr = e;
    });
    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(err.code === "ENOENT" ? new Error(`${cmd} is not installed on this server`) : err);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(new Error("Cancelled"));
      if (code !== 0) {
        const tail = (stderr || stdout).trim().split("\n").slice(-5).join("\n");
        return reject(new Error(`${path.basename(cmd)} exited with code ${code}${tail ? `: ${tail}` : ""}`));
      }
      if (pipeErr) return reject(pipeErr);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Readable for a .sql or .sql.gz file, gunzipping when the gzip magic is present, with progress. */
export function openSqlStream(file, { log } = {}) {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(2);
  fs.readSync(fd, head, 0, 2, 0);
  fs.closeSync(fd);
  const gz = head[0] === 0x1f && head[1] === 0x8b;
  const total = fs.statSync(file).size;
  let read = 0;
  let nextPct = 10;
  const progress = new Transform({
    transform(chunk, _enc, cb) {
      read += chunk.length;
      const pct = total ? Math.floor((read / total) * 100) : 100;
      if (pct >= nextPct) {
        log?.(`… ${pct}% read`);
        nextPct = pct - (pct % 10) + 10;
      }
      cb(null, chunk);
    },
  });
  const src = fs.createReadStream(file);
  src.on("error", (e) => progress.destroy(e));
  src.pipe(progress);
  if (!gz) return { stream: progress, gzipped: false, total };
  const gunzip = zlib.createGunzip();
  progress.on("error", (e) => gunzip.destroy(e));
  progress.pipe(gunzip);
  return { stream: gunzip, gzipped: true, total };
}

/** Stream a request body to `dest`, enforcing `limit`. Resolves { size, sha256 }. */
export async function receiveToFile(req, dest, limit) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const declared = Number(req.headers["content-length"] || 0);
  if (declared && declared > limit) throw httpError(413, "Upload is too large.");
  const hash = crypto.createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk, _e, cb) {
      size += chunk.length;
      if (size > limit) return cb(httpError(413, "Upload is too large."));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, meter, fs.createWriteStream(dest, { mode: 0o600 }));
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw e;
  }
  return { size, sha256: hash.digest("hex") };
}

// ------------------------------------------------------------- the module

export function register(router, ctx) {
  const mcfg = () => {
    ctx.config.mysql = ctx.config.mysql || {};
    return ctx.config.mysql;
  };
  const bin = () => which("mysql") || which("mariadb");
  const dumpBin = () => which("mysqldump") || which("mariadb-dump");
  const broadcast = (event, data) => {
    try {
      ctx.events?.broadcast?.(event, data);
    } catch {}
  };
  const audit = (admin, action, target, details) => {
    try {
      ctx.activity?.(admin, action, target, details);
    } catch {}
  };
  const decrypt = (v) => (v ? ctx.secrets.decrypt(v) : "");

  // ---------------------------------------------------------- connection

  let connCache = null;
  let partialRevokes = null;

  async function rootConn({ fresh = false } = {}) {
    if (!fresh && connCache && Date.now() - connCache.at < 5 * 60_000) return connCache;
    const b = bin();
    if (!b && !DRY_RUN) throw httpError(503, "MySQL is not installed on this server.");
    const cfg = mcfg();
    const rootUser = /^[A-Za-z0-9_.-]{1,32}$/.test(cfg.rootUser || "") ? cfg.rootUser : "root";
    const tries = [
      {
        mode: "socket",
        args: ["-u", rootUser, ...(cfg.socket && /^\/[A-Za-z0-9_./-]+$/.test(cfg.socket) ? [`--socket=${cfg.socket}`] : [])],
        env: null,
        secret: null,
      },
    ];
    if (cfg.rootPasswordEnc) {
      let pw = "";
      try {
        pw = decrypt(cfg.rootPasswordEnc);
      } catch {}
      if (pw) tries.push({ mode: "password", args: tcpArgs(cfg, rootUser), env: { MYSQL_PWD: pw }, secret: pw });
    }
    let lastErr = null;
    for (const t of tries) {
      try {
        await run(b || "mysql", [...t.args, "--batch", "--skip-column-names", "--connect-timeout=5"], {
          input: "SELECT 1;\n",
          env: t.env,
          timeoutMs: 15_000,
        });
        connCache = { ...t, bin: b || "mysql", at: Date.now() };
        return connCache;
      } catch (e) {
        lastErr = scrub(e, [t.secret]);
        lastErr.mysqlCode = mysqlCodeOf(e);
      }
    }
    connCache = null;
    const code = lastErr?.mysqlCode;
    const err = httpError(
      503,
      NOT_RUNNING_CODES.has(code)
        ? "MySQL is not running."
        : ACCESS_DENIED_CODES.has(code)
          ? "The panel cannot sign in to MySQL as root. Socket authentication is not available — store the root password under Databases → MySQL."
          : `Cannot reach MySQL: ${lastErr?.message || "unknown error"}`,
    );
    err.mysqlCode = code;
    throw err;
  }

  function tcpArgs(cfg, user) {
    const host = cfg.host && validHost(cfg.host) ? cfg.host : "127.0.0.1";
    const port = Number(cfg.port) > 0 && Number(cfg.port) < 65536 ? String(Number(cfg.port)) : "3306";
    return ["-h", host, "-P", port, "-u", user];
  }

  /** Execute a script as root via stdin. Returns parsed rows of the last result sets. */
  async function sql(script, { secrets = [], timeoutMs = 120_000, signal } = {}) {
    const c = await rootConn();
    try {
      const r = await run(c.bin, [...c.args, "--batch", "--skip-column-names", "--default-character-set=utf8mb4"], {
        input: PRELUDE + script,
        env: c.env,
        timeoutMs,
        signal,
      });
      return parseRows(r.stdout);
    } catch (e) {
      const code = mysqlCodeOf(e);
      if (NOT_RUNNING_CODES.has(code) || ACCESS_DENIED_CODES.has(code)) connCache = null;
      const out = scrub(e, [...secrets, c.secret]);
      out.mysqlCode = code;
      throw out;
    }
  }

  async function getPartialRevokes() {
    if (partialRevokes !== null) return partialRevokes;
    if (DRY_RUN) return (partialRevokes = false);
    try {
      const rows = await sql("SELECT @@GLOBAL.partial_revokes;\n");
      partialRevokes = rows[0]?.[0] === "1";
    } catch {
      partialRevokes = false; // MariaDB / older MySQL: variable doesn't exist
    }
    return partialRevokes;
  }

  // ---------------------------------------------------------- status

  let statusCache = null;
  async function status({ fresh = false } = {}) {
    if (!fresh && statusCache && Date.now() - statusCache.at < 10_000) return statusCache.value;
    let value;
    if (DRY_RUN) {
      value = { installed: true, running: true, rootOk: true, version: "dry-run", flavor: "mysql", authMode: "dry-run", error: null, dryRun: true };
    } else if (!bin()) {
      value = { installed: false, running: false, rootOk: false, version: null, error: "MySQL is not installed on this server." };
    } else {
      try {
        const c = await rootConn({ fresh });
        const rows = await sql("SELECT VERSION(), @@hostname;\n");
        let bind = null;
        try {
          bind = (await sql("SELECT @@GLOBAL.bind_address;\n"))[0]?.[0] ?? null;
        } catch {}
        const version = rows[0]?.[0] || null;
        value = {
          installed: true,
          running: true,
          rootOk: true,
          version,
          flavor: /mariadb/i.test(version || "") ? "mariadb" : "mysql",
          authMode: c.mode,
          bindAddress: bind,
          error: null,
        };
      } catch (e) {
        let clientVersion = null;
        try {
          clientVersion = (await run(bin(), ["--version"], { timeoutMs: 5000 })).stdout.trim();
        } catch {}
        value = {
          installed: true,
          running: !NOT_RUNNING_CODES.has(e.mysqlCode),
          rootOk: false,
          version: null,
          clientVersion,
          rootPasswordSet: !!mcfg().rootPasswordEnc,
          error: e.message,
        };
      }
    }
    statusCache = { at: Date.now(), value };
    return value;
  }

  // ---------------------------------------------------------- hosts

  async function workerHosts() {
    let servers = [];
    try {
      servers = (await ctx.cluster?.listServers?.()) || [];
    } catch {}
    const out = new Set();
    for (const s of servers) {
      if (!s || s.id === MAIN_ID || s.role === "main") continue;
      for (const raw of [s.privateHost, s.host]) {
        const h = cleanHost(raw);
        if (!h) continue;
        out.add(h);
        if (!net.isIP(h)) {
          // Most MySQL installs run with skip-name-resolve, so grant the IPs too.
          try {
            const addrs = await Promise.race([
              dns.lookup(h, { all: true }),
              new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
            ]);
            for (const a of addrs) if (validHost(a.address)) out.add(a.address);
          } catch {}
        }
      }
    }
    return [...out];
  }

  async function desiredHosts(remoteAccess) {
    const base = ["localhost", "127.0.0.1"];
    if (!remoteAccess) return base;
    return [...new Set([...base, ...(await workerHosts())])];
  }

  async function existingHosts(user) {
    if (DRY_RUN) return null;
    const rows = await sql(`SELECT Host FROM mysql.user WHERE User = ${sqlString(user)};\n`);
    return rows.map((r) => r[0]);
  }

  function grantScript(rec, hosts, password, pr) {
    let s = "";
    for (const h of hosts) {
      s += `CREATE USER IF NOT EXISTS ${account(rec.user, h)} IDENTIFIED BY ${sqlString(password)};\n`;
      s += `GRANT ALL PRIVILEGES ON ${grantDbPattern(rec.name, pr)}.* TO ${account(rec.user, h)};\n`;
    }
    return s;
  }

  let syncChain = Promise.resolve();
  function syncRemoteHosts({ log } = {}) {
    syncChain = syncChain.then(async () => {
      const dbs = ctx.db.list("databases");
      if (!dbs.length) return { changed: 0 };
      try {
        await rootConn();
      } catch (e) {
        log?.(`Skipping MySQL host sync: ${e.message}`);
        return { changed: 0, error: e.message };
      }
      const pr = await getPartialRevokes();
      let changed = 0;
      for (const rec of dbs) {
        try {
          const want = await desiredHosts(rec.remoteAccess);
          const have = (await existingHosts(rec.user)) ?? rec.hosts ?? [];
          const add = want.filter((h) => !have.includes(h));
          const drop = have.filter((h) => !want.includes(h) && validHost(h));
          if (!add.length && !drop.length) continue;
          const pw = decrypt(rec.passwordEnc);
          let script = grantScript(rec, add, pw, pr);
          for (const h of drop) script += `DROP USER IF EXISTS ${account(rec.user, h)};\n`;
          await sql(script, { secrets: [pw] });
          ctx.db.update("databases", rec.id, { hosts: want });
          changed++;
          log?.(`${rec.name}: +[${add.join(", ")}] -[${drop.join(", ")}]`);
        } catch (e) {
          log?.(`${rec.name}: host sync failed: ${e.message}`);
          console.error(`[fcc] mysql host sync ${rec.name}:`, e.message);
        }
      }
      if (changed) broadcast("database", { action: "hosts-synced" });
      return { changed };
    });
    const p = syncChain;
    syncChain = syncChain.catch(() => {});
    return p;
  }

  // ---------------------------------------------------------- records

  function lastBackupOf(id) {
    const list = ctx.db.list("backups", (b) => b.databaseId === id && b.kind === "database");
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const b = list.find((x) => x.status === "ok") || list[0];
    return b ? { id: b.id, status: b.status, createdAt: b.createdAt, size: b.size, trigger: b.trigger } : null;
  }

  function linkedSites(id) {
    return ctx.db.list("sites", (s) => Array.isArray(s.linkedDatabaseIds) && s.linkedDatabaseIds.includes(id));
  }

  function publicDb(rec) {
    if (!rec) return null;
    const cfg = mcfg();
    return {
      id: rec.id,
      projectId: rec.projectId,
      name: rec.name,
      user: rec.user,
      charset: rec.charset,
      collation: rec.collation,
      remoteAccess: !!rec.remoteAccess,
      hosts: rec.hosts || [],
      host: "127.0.0.1",
      port: Number(cfg.port) || 3306,
      sizeBytes: rec.sizeBytes || 0,
      sizeCheckedAt: rec.sizeCheckedAt || null,
      passwordRotatedAt: rec.passwordRotatedAt || null,
      lastBackup: lastBackupOf(rec.id),
      linkedSites: linkedSites(rec.id).map((s) => ({ id: s.id, name: s.name })),
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    };
  }

  function getRec(id) {
    const rec = ctx.db.get("databases", id);
    if (!rec) throw httpError(404, "Database not found.");
    return rec;
  }

  let sizesAt = 0;
  async function refreshSizes({ force = false } = {}) {
    if (DRY_RUN) return;
    if (!force && Date.now() - sizesAt < 60_000) return;
    sizesAt = Date.now();
    const dbs = ctx.db.list("databases");
    if (!dbs.length) return;
    try {
      const names = dbs.map((d) => sqlString(d.name)).join(", ");
      const rows = await sql(
        `SELECT table_schema, COALESCE(SUM(data_length + index_length), 0) FROM information_schema.TABLES WHERE table_schema IN (${names}) GROUP BY table_schema;\n`,
      );
      const map = new Map(rows.map((r) => [r[0], Number(r[1]) || 0]));
      const now = new Date().toISOString();
      for (const d of dbs) ctx.db.update("databases", d.id, { sizeBytes: map.get(d.name) || 0, sizeCheckedAt: now });
    } catch (e) {
      sizesAt = 0;
      // Not fatal: the list still renders, with the last known sizes.
    }
  }

  // ---------------------------------------------------------- operations

  async function createDatabase({ projectId, name, user, password, remoteAccess = false, charset, collation }, admin) {
    const project = ctx.db.get("projects", projectId);
    if (!project) throw httpError(404, "Project not found.");
    if (!name) throw httpError(400, "Give the database a name.");
    const prefix = projectPrefix(project);
    const dbName = prefixedName(prefix, String(name), DB_NAME_MAX, "Database name");
    let dbUser;
    if (user) dbUser = prefixedName(prefix, String(user), USER_MAX, "User name");
    else dbUser = dbName.length <= USER_MAX ? dbName : `${dbName.slice(0, USER_MAX - 5).replace(/_+$/, "")}_${generatePassword(4).toLowerCase()}`;
    if (!isValidIdent(dbUser, USER_MAX)) throw httpError(400, "Could not derive a valid user name; pass `user`.");

    const cs = charset ? String(charset) : "utf8mb4";
    if (!CHARSETS[cs]) throw httpError(400, `Charset must be one of: ${Object.keys(CHARSETS).join(", ")}.`);
    const coll = collation ? String(collation) : CHARSETS[cs][0];
    if (!CHARSETS[cs].includes(coll)) throw httpError(400, `Collation for ${cs} must be one of: ${CHARSETS[cs].join(", ")}.`);

    if (password != null && password !== "" && !validPassword(password))
      throw httpError(400, "Password must be 8–128 printable ASCII characters without spaces.");
    const pw = password ? password : generatePassword(32);

    if (ctx.db.list("databases", (d) => d.name === dbName).length) throw httpError(409, `A database called ${dbName} already exists.`);
    if (ctx.db.list("databases", (d) => d.user === dbUser).length) throw httpError(409, `A database user called ${dbUser} already exists.`);

    const st = await status({ fresh: true });
    if (!st.rootOk) throw httpError(503, st.error || "MySQL is not available.");

    if (!DRY_RUN) {
      const rows = await sql(
        `SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${sqlString(dbName)};\n` +
          `SELECT COUNT(*) FROM mysql.user WHERE User = ${sqlString(dbUser)};\n`,
      );
      if (Number(rows[0]?.[0]) > 0) throw httpError(409, `MySQL already has a database called ${dbName}.`);
      if (Number(rows[1]?.[0]) > 0) throw httpError(409, `MySQL already has a user called ${dbUser}.`);
    }

    const pr = await getPartialRevokes();
    const hosts = await desiredHosts(!!remoteAccess);
    const rec0 = { name: dbName, user: dbUser };
    const script =
      `CREATE DATABASE ${quoteIdent(dbName)} CHARACTER SET ${cs} COLLATE ${coll};\n` + grantScript(rec0, hosts, pw, pr);
    try {
      await sql(script, { secrets: [pw] });
    } catch (e) {
      // We checked neither existed, so everything named here is ours to undo.
      let undo = "";
      for (const h of hosts) undo += `DROP USER IF EXISTS ${account(dbUser, h)};\n`;
      undo += `DROP DATABASE IF EXISTS ${quoteIdent(dbName)};\n`;
      await sql(undo).catch(() => {});
      throw httpError(500, `Creating the database failed: ${e.message}`);
    }

    const rec = ctx.db.insert("databases", {
      ...(typeof ctx.db.newId === "function" ? { id: ctx.db.newId("db") } : {}),
      projectId,
      name: dbName,
      user: dbUser,
      passwordEnc: ctx.secrets.encrypt(pw),
      charset: cs,
      collation: coll,
      remoteAccess: !!remoteAccess,
      hosts,
      sizeBytes: 0,
    });
    audit(admin, "database.create", { type: "database", id: rec.id, name: dbName }, { projectId, user: dbUser, remoteAccess: !!remoteAccess });
    broadcast("database", { action: "created", database: publicDb(rec) });
    return { database: publicDb(rec), password: pw };
  }

  async function setRemoteAccess(rec, remoteAccess, admin) {
    ctx.db.update("databases", rec.id, { remoteAccess: !!remoteAccess });
    await syncRemoteHosts();
    const fresh = ctx.db.get("databases", rec.id);
    audit(admin, "database.update", { type: "database", id: rec.id, name: rec.name }, { remoteAccess: !!remoteAccess });
    broadcast("database", { action: "updated", database: publicDb(fresh) });
    return publicDb(fresh);
  }

  async function rotatePassword(rec, password, admin) {
    if (password != null && password !== "" && !validPassword(password))
      throw httpError(400, "Password must be 8–128 printable ASCII characters without spaces.");
    const pw = password || generatePassword(32);
    const st = await status({ fresh: true });
    if (!st.rootOk) throw httpError(503, st.error || "MySQL is not available.");
    const hosts = (await existingHosts(rec.user)) ?? rec.hosts ?? ["localhost", "127.0.0.1"];
    let script = "";
    for (const h of hosts.filter(validHost)) script += `ALTER USER ${account(rec.user, h)} IDENTIFIED BY ${sqlString(pw)};\n`;
    if (script) await sql(script, { secrets: [pw] });
    ctx.db.update("databases", rec.id, { passwordEnc: ctx.secrets.encrypt(pw), passwordRotatedAt: new Date().toISOString() });
    audit(admin, "database.password.rotate", { type: "database", id: rec.id, name: rec.name });
    broadcast("database", { action: "updated", database: publicDb(ctx.db.get("databases", rec.id)) });

    // Every linked website needs the new DB_PASSWORD. SITES exposes pushEnv()
    // (one job per site, restarts node apps); otherwise fall back to tasks.
    const sites = linkedSites(rec.id);
    const jobs = [];
    if (sites.length && typeof ctx.sites?.pushEnv === "function") {
      for (const s of sites) {
        try {
          const j = ctx.sites.pushEnv(s, { admin, restart: true });
          if (j?.id) jobs.push({ id: j.id, siteId: s.id });
        } catch (e) {
          console.error(`[fcc] env push for ${s.name} failed: ${e.message}`);
        }
      }
    } else if (sites.length && ctx.jobs?.start) {
      const j = ctx.jobs.start(
        { type: "database.env", title: `Update env for sites using ${rec.name}`, projectId: rec.projectId, databaseId: rec.id, adminId: admin?.id },
        async ({ log, signal }) => pushEnvForLinkedSites(rec, { log, signal }),
      );
      jobs.push({ id: j.id, siteId: null });
    }
    return { password: pw, job: jobs[0] || null, jobs, sites: sites.map((s) => ({ id: s.id, name: s.name })) };
  }

  /**
   * After a password change every linked website needs the new DB_PASSWORD.
   * Prefer a SITES hook (it knows about rolling restarts); otherwise use the
   * contract primitives: specFor() already merges our envFor(), so write the
   * env on each target with site.env and restart.
   */
  async function pushEnvForLinkedSites(rec, { log = () => {}, signal } = {}) {
    const sites = linkedSites(rec.id);
    const results = [];
    for (const site of sites) {
      if (signal?.aborted) throw new Error("Cancelled");
      log(`Website ${site.name}:`);
      try {
        if (ctx.sites?.specFor && ctx.cluster?.runTask) {
          const targets = ctx.sites.targets?.(site) || (site.loadBalanced ? site.serverIds : [site.serverIds?.[0] || MAIN_ID]);
          for (const serverId of targets) {
            const spec = await ctx.sites.specFor(site, serverId);
            log(`  ${serverId}: writing env`);
            await ctx.cluster.runTask(serverId, "site.env", { spec, env: spec.env }, { log, signal });
            log(`  ${serverId}: restarting`);
            await ctx.cluster.runTask(serverId, "site.restart", { spec }, { log, signal });
          }
        } else {
          throw new Error("the sites module does not expose an env update yet — redeploy the site to apply the new password");
        }
        results.push({ siteId: site.id, ok: true });
      } catch (e) {
        log(`  failed: ${e.message}`);
        results.push({ siteId: site.id, ok: false, error: e.message });
      }
    }
    const failed = results.filter((r) => !r.ok);
    if (failed.length) throw new Error(`${failed.length} of ${results.length} website(s) could not be updated`);
    return { sites: results };
  }

  async function dropDatabase(rec, admin) {
    const st = await status({ fresh: true });
    if (!st.rootOk) throw httpError(503, st.error || "MySQL is not available.");
    const hosts = (await existingHosts(rec.user)) ?? rec.hosts ?? ["localhost", "127.0.0.1"];
    let script = "";
    for (const h of hosts.filter(validHost)) script += `DROP USER IF EXISTS ${account(rec.user, h)};\n`;
    script += `DROP DATABASE IF EXISTS ${quoteIdent(rec.name)};\n`;
    await sql(script);
    ctx.db.remove("databases", rec.id);
    audit(admin, "database.delete", { type: "database", id: rec.id, name: rec.name }, { projectId: rec.projectId });
    broadcast("database", { action: "deleted", id: rec.id, projectId: rec.projectId });
  }

  /** Drop and re-create the schema (same charset); db-level grants survive since they're keyed by name. */
  async function recreate(databaseId, { log } = {}) {
    const rec = getRec(databaseId);
    const cs = CHARSETS[rec.charset] ? rec.charset : "utf8mb4";
    const coll = CHARSETS[cs].includes(rec.collation) ? rec.collation : CHARSETS[cs][0];
    log?.(`Re-creating ${rec.name} (${cs} / ${coll})`);
    await sql(`DROP DATABASE IF EXISTS ${quoteIdent(rec.name)};\nCREATE DATABASE ${quoteIdent(rec.name)} CHARACTER SET ${cs} COLLATE ${coll};\n`);
  }

  async function dumpTo(args, { file, log, signal, secret, env, label }) {
    const b = dumpBin();
    if (!b && !DRY_RUN) throw new Error("mysqldump is not installed on this server.");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.part`;
    const out = fs.createWriteStream(tmp, { mode: 0o600 });
    const gz = zlib.createGzip({ level: 6 });
    gz.pipe(out);
    const done = finished(out);
    done.catch(() => {}); // awaited below; avoid an unhandled rejection when we bail out early
    try {
      if (DRY_RUN) {
        log?.(`[dry-run] ${b || "mysqldump"} ${args.join(" ")} | gzip > ${file}`);
        gz.end(`-- FCC dry-run placeholder for ${label}\n-- ${new Date().toISOString()}\n`);
      } else {
        await run(b, args, { stdoutFile: gz, log, signal, env: env || null, redact: secret ? [secret] : [] });
      }
      await done;
      fs.renameSync(tmp, file);
    } catch (e) {
      gz.destroy();
      out.destroy();
      fs.rmSync(tmp, { force: true });
      throw scrub(e, [secret]);
    }
    const st = fs.statSync(file);
    return { file, size: st.size };
  }

  // MySQL's mysqldump writes SET @@GLOBAL.GTID_PURGED into dumps when GTIDs are
  // on, which makes a single-database dump fail to load back into the same
  // server. MariaDB's client doesn't know the flag, so detect it.
  let gtidFlag = null;
  async function extraDumpFlags() {
    if (gtidFlag === null) {
      gtidFlag = false;
      if (!DRY_RUN && dumpBin()) {
        try {
          const r = await run(dumpBin(), ["--help"], { allowFail: true, timeoutMs: 10_000 });
          gtidFlag = /set-gtid-purged/.test(r.stdout);
        } catch {}
      }
    }
    return gtidFlag ? ["--set-gtid-purged=OFF"] : [];
  }

  const DUMP_FLAGS = ["--single-transaction", "--routines", "--triggers", "--events", "--hex-blob", "--default-character-set=utf8mb4"];

  async function dump(databaseId, { file, log, signal } = {}) {
    const rec = getRec(databaseId);
    if (!file) throw new Error("dump() needs a file");
    const c = DRY_RUN ? { args: ["-u", "root"], env: null, secret: null } : await rootConn();
    quoteIdent(rec.name);
    log?.(`Dumping ${rec.name}…`);
    return dumpTo([...c.args, ...DUMP_FLAGS, ...(await extraDumpFlags()), rec.name], { file, log, signal, secret: c.secret, env: c.env, label: rec.name });
  }

  async function dumpAll({ file, log, signal } = {}) {
    const c = DRY_RUN ? { args: ["-u", "root"], env: null, secret: null } : await rootConn();
    log?.("Dumping all databases…");
    return dumpTo([...c.args, ...DUMP_FLAGS, ...(await extraDumpFlags()), "--all-databases"], { file, log, signal, secret: c.secret, env: c.env, label: "all databases" });
  }

  /**
   * Load a .sql / .sql.gz file into a database.
   *  as: "root" (our own backups — they carry DEFINER clauses) or "user"
   *      (uploaded imports — least privilege, so a dump can't touch other schemas).
   */
  async function restore(databaseId, { file, log, signal, as = "root" } = {}) {
    const rec = getRec(databaseId);
    quoteIdent(rec.name);
    if (!fs.existsSync(file)) throw new Error("The SQL file is missing.");
    const b = bin() || "mysql";
    let args;
    let env = null;
    let secret = null;
    if (as === "user") {
      secret = decrypt(rec.passwordEnc);
      args = [...tcpArgs({ host: "127.0.0.1", port: mcfg().port }, rec.user)];
      env = { MYSQL_PWD: secret };
    } else {
      const c = DRY_RUN ? { args: ["-u", "root"], env: null, secret: null } : await rootConn();
      args = [...c.args];
      env = c.env;
      secret = c.secret;
    }
    args.push("--batch", "--default-character-set=utf8mb4", "--max-allowed-packet=1073741824", rec.name);
    const { stream, gzipped, total } = openSqlStream(file, { log });
    log?.(`Importing ${gzipped ? "gzipped " : ""}SQL (${total} bytes) into ${rec.name} as ${as === "user" ? rec.user : "root"}…`);
    try {
      await runWithStdin(b, args, { stdin: stream, env, log, signal });
    } catch (e) {
      throw scrub(e, [secret]);
    } finally {
      stream.destroy?.();
    }
    sizesAt = 0;
    refreshSizes({ force: true }).catch(() => {});
    log?.("Import finished.");
  }

  function mainAddress() {
    let m = null;
    try {
      m = ctx.cluster?.getServer?.(ctx.cluster?.MAIN_ID || MAIN_ID);
    } catch {}
    return cleanHost(m?.privateHost) || cleanHost(m?.host) || cleanHost(mcfg().publicHost) || "127.0.0.1";
  }

  /** Env vars for a website on `serverId`. Synchronous so SITES can call it from specFor(). */
  function envFor(databaseId, { serverId } = {}) {
    const rec = ctx.db.get("databases", databaseId);
    if (!rec) return null;
    const pw = decrypt(rec.passwordEnc);
    const host = !serverId || serverId === MAIN_ID ? "127.0.0.1" : mainAddress();
    const port = String(Number(mcfg().port) || 3306);
    return {
      DB_HOST: host,
      DB_PORT: port,
      DB_NAME: rec.name,
      DB_USER: rec.user,
      DB_PASSWORD: pw,
      DATABASE_URL: `mysql://${encodeURIComponent(rec.user)}:${encodeURIComponent(pw)}@${urlHost(host)}:${port}/${encodeURIComponent(rec.name)}`,
    };
  }

  async function setRootPassword({ password, user }, admin) {
    const cfg = mcfg();
    if (password === "" || password == null) {
      delete cfg.rootPasswordEnc;
    } else {
      if (typeof password !== "string" || password.length > 256 || /[\0\n\r]/.test(password)) throw httpError(400, "Invalid password.");
      const rootUser = user ? String(user) : cfg.rootUser || "root";
      if (!/^[A-Za-z0-9_.-]{1,32}$/.test(rootUser)) throw httpError(400, "Invalid user name.");
      if (!DRY_RUN) {
        const b = bin();
        if (!b) throw httpError(503, "MySQL is not installed on this server.");
        try {
          await run(b, [...tcpArgs(cfg, rootUser), "--batch", "--skip-column-names", "--connect-timeout=5"], {
            input: "SELECT CURRENT_USER();\n",
            env: { MYSQL_PWD: password },
            timeoutMs: 15_000,
          });
        } catch (e) {
          throw httpError(400, `MySQL rejected those credentials: ${scrub(e, [password]).message}`);
        }
      }
      cfg.rootUser = rootUser;
      cfg.rootPasswordEnc = ctx.secrets.encrypt(password);
    }
    await ctx.saveConfig?.();
    connCache = null;
    statusCache = null;
    partialRevokes = null;
    audit(admin, "mysql.root.update", { type: "mysql", id: "root", name: cfg.rootUser || "root" }, { set: !!cfg.rootPasswordEnc });
    return status({ fresh: true });
  }

  // ---------------------------------------------------------- API object

  ctx.mysql = {
    status,
    envFor,
    syncRemoteHosts,
    dump,
    // additions (see docs/STANDALONE.md "Changes")
    dumpAll,
    restore,
    recreate,
    refreshSizes,
    pushEnvForLinkedSites: (id, opts) => pushEnvForLinkedSites(getRec(id), opts),
    publicView: (id) => publicDb(ctx.db.get("databases", id)),
  };

  // ---------------------------------------------------------- routes

  router.get("/api/mysql/status", async () => status({ fresh: true }));

  router.post("/api/mysql/root", async (req, res, { body, admin }) => setRootPassword(body || {}, admin));

  router.get("/api/databases", async (req, res, { query }) => {
    await refreshSizes();
    let items = ctx.db.list("databases");
    if (query.projectId) items = items.filter((d) => d.projectId === query.projectId);
    items.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return { items: items.map(publicDb) };
  });

  router.post("/api/projects/:projectId/databases", async (req, res, { params, body, admin }) =>
    createDatabase({ ...(body || {}), projectId: params.projectId }, admin),
  );

  router.get("/api/databases/:id", async (req, res, { params }) => {
    getRec(params.id);
    await refreshSizes();
    const backups = ctx.db
      .list("backups", (b) => b.databaseId === params.id)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 10);
    return { ...publicDb(ctx.db.get("databases", params.id)), backups: backups.map((b) => ctx.backups?.publicView?.(b) || b) };
  });

  router.patch("/api/databases/:id", async (req, res, { params, body, admin }) => {
    const rec = getRec(params.id);
    if (body && "remoteAccess" in body) return setRemoteAccess(rec, !!body.remoteAccess, admin);
    return publicDb(rec);
  });

  router.delete("/api/databases/:id", async (req, res, { params, query, admin }) => {
    const rec = getRec(params.id);
    const sites = linkedSites(rec.id);
    if (sites.length && query.force !== "1")
      throw httpError(409, `Linked to ${sites.map((s) => s.name).join(", ")}. Unlink it first, or delete with ?force=1.`, {
        sites: sites.map((s) => ({ id: s.id, name: s.name })),
      });
    await dropDatabase(rec, admin);
    try {
      ctx.sites?.unlinkDatabase?.(rec.id);
    } catch {}
    if (query.deleteBackups === "1") {
      for (const b of ctx.db.list("backups", (x) => x.databaseId === rec.id)) {
        try {
          await ctx.backups?.removeBackup?.(b.id);
        } catch {}
      }
    }
    return { ok: true };
  });

  router.post("/api/databases/:id/credentials", async (req, res, { params, admin }) => {
    const rec = getRec(params.id);
    const env = envFor(rec.id, { serverId: MAIN_ID });
    audit(admin, "database.credentials.reveal", { type: "database", id: rec.id, name: rec.name });
    return {
      user: rec.user,
      password: env.DB_PASSWORD,
      host: env.DB_HOST,
      port: Number(env.DB_PORT),
      name: rec.name,
      url: env.DATABASE_URL,
      remoteHost: rec.remoteAccess ? mainAddress() : null,
    };
  });

  router.post("/api/databases/:id/password", async (req, res, { params, body, admin }) =>
    rotatePassword(getRec(params.id), body?.password, admin),
  );

  router.post("/api/databases/:id/import", { raw: true }, async (req, res, { params, query, admin }) => {
    const rec = getRec(params.id);
    const filename = String(query.filename || "import.sql").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
    if (!/\.(sql|sql\.gz|gz)$/i.test(filename)) throw httpError(400, "Upload a .sql or .sql.gz file.");
    const st = await status({ fresh: true });
    if (!st.rootOk) throw httpError(503, st.error || "MySQL is not available.");
    const tmp = path.join(ctx.dataDir, "tmp", "imports", `${rec.id}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
    const { size, sha256 } = await receiveToFile(req, tmp, IMPORT_LIMIT);
    if (!size) {
      fs.rmSync(tmp, { force: true });
      throw httpError(400, "The upload was empty.");
    }
    audit(admin, "database.import", { type: "database", id: rec.id, name: rec.name }, { filename, size, sha256 });
    const job = ctx.jobs.start(
      { type: "database.import", title: `Import ${filename} into ${rec.name}`, projectId: rec.projectId, databaseId: rec.id, adminId: admin?.id },
      async ({ log, signal }) => {
        try {
          log(`Received ${filename}: ${size} bytes, sha256 ${sha256}`);
          await restore(rec.id, { file: tmp, log, signal, as: "user" });
          broadcast("database", { action: "updated", database: publicDb(ctx.db.get("databases", rec.id)) });
          return { filename, size };
        } finally {
          fs.rmSync(tmp, { force: true });
        }
      },
    );
    return job;
  });
}

export async function start(ctx) {
  // Remove import temp files left by a crash.
  try {
    const dir = path.join(ctx.dataDir, "tmp", "imports");
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  } catch {}

  let timer = null;
  const onChange = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctx.mysql?.syncRemoteHosts?.().catch?.(() => {}), 2000);
    timer.unref?.();
  };
  try {
    ctx.cluster?.on?.("servers-changed", onChange);
  } catch {}
  // Reconcile once after boot (workers may have changed while we were down).
  const t = setTimeout(onChange, 15_000);
  t.unref?.();
}
