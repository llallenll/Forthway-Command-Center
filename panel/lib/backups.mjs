/**
 * DATA — database and server backups: manual + scheduled, retention,
 * download, restore, optional off-site copy to S3-compatible storage or an
 * SMB (Windows/Samba) share via smbclient (panel/lib/smb.mjs).
 *
 * Layout under dataDir/backups/ (records store the path relative to it):
 *   db/<projectSlug>/<db>-<stamp>.sql.gz          mysqldump | gzip
 *   server/<serverId>/server-<serverId>-<stamp>.tar.gz
 *   schedule-state.json                             last scheduled slot per kind
 *
 * A main-server archive is `tar -C / <paths…> -C <staging> fcc-backup`, where
 * fcc-backup/ holds manifest.json (what was included, from where) and, when
 * asked, all-databases.sql.gz. Restore reads the manifest and extracts only
 * site files and FCC nginx configs; panel data is never overwritten by a
 * running panel (download the archive and restore it by hand instead).
 *
 * Worker backups run as the CLUSTER task `server.backup`; the agent uploads
 * the archive through CLUSTER's /agent/upload/:taskId and we adopt the file.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";

import { httpError } from "./http.mjs";
import { run, which, forgetWhich, DRY_RUN } from "./sys.mjs";
import { projectPrefix } from "./mysql.mjs";
import { createS3 } from "./s3.mjs";
import { createSmb, smbInstalled, validServer, validShare, validFolder, validUsername, validPassword, validDomain, validPort, validMinProtocol } from "./smb.mjs";

const MAIN_ID = "main";
const FORBIDDEN_ROOTS = ["/", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/dev", "/proc", "/sys", "/run", "/var", "/root", "/home", "/srv", "/opt", "/tmp"];
const DEFAULTS = {
  database: { enabled: false, every: "daily", at: "03:00", day: 0, keep: 14 },
  server: { enabled: false, every: "weekly", at: "04:00", day: 0, keep: 4, include: { panel: true, sites: true, nginx: true, databases: true }, serverIds: [MAIN_ID] },
  destination: { type: "local" },
};

// ------------------------------------------------------------ schedule math
// Exported for tests. `sched` = { every: hourly|daily|weekly, at: "HH:MM", day: 0-6 (weekly, 0 = Sunday) }.
// All in server local time.

export function parseAt(at) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(at || ""));
  return m ? { h: Number(m[1]), m: Number(m[2]) } : { h: 3, m: 0 };
}

/** Most recent scheduled instant ≤ now. */
export function prevSlot(sched, now = new Date()) {
  const { h, m } = parseAt(sched?.at);
  const t = new Date(now.getTime());
  if (sched?.every === "hourly") {
    t.setMinutes(m, 0, 0);
    if (t > now) t.setTime(t.getTime() - 3600_000);
    return t;
  }
  t.setHours(h, m, 0, 0);
  if (sched?.every === "weekly") {
    const day = Number.isInteger(Number(sched.day)) ? ((Number(sched.day) % 7) + 7) % 7 : 0;
    t.setDate(t.getDate() - ((t.getDay() - day + 7) % 7));
    t.setHours(h, m, 0, 0);
    if (t > now) {
      t.setDate(t.getDate() - 7);
      t.setHours(h, m, 0, 0);
    }
    return t;
  }
  if (t > now) {
    t.setDate(t.getDate() - 1);
    t.setHours(h, m, 0, 0);
  }
  return t;
}

/** Next scheduled instant > now. */
export function nextSlot(sched, now = new Date()) {
  const { h, m } = parseAt(sched?.at);
  const t = new Date(now.getTime());
  if (sched?.every === "hourly") {
    t.setMinutes(m, 0, 0);
    if (t <= now) t.setTime(t.getTime() + 3600_000);
    return t;
  }
  t.setHours(h, m, 0, 0);
  if (sched?.every === "weekly") {
    const day = Number.isInteger(Number(sched.day)) ? ((Number(sched.day) % 7) + 7) % 7 : 0;
    t.setDate(t.getDate() + ((day - t.getDay() + 7) % 7));
    t.setHours(h, m, 0, 0);
    if (t <= now) {
      t.setDate(t.getDate() + 7);
      t.setHours(h, m, 0, 0);
    }
    return t;
  }
  if (t <= now) {
    t.setDate(t.getDate() + 1);
    t.setHours(h, m, 0, 0);
  }
  return t;
}

/** Should a scheduled run fire now? Returns { run, slot, init }. */
export function dueCheck(sched, lastSlotIso, now = new Date()) {
  if (!sched?.enabled) return { run: false, slot: null };
  const slot = prevSlot(sched, now);
  if (!lastSlotIso) return { run: false, slot, init: true }; // first tick after enabling: wait for the next slot
  return { run: slot.getTime() > Date.parse(lastSlotIso), slot };
}

/** Which records retention would remove: beyond the newest `keep` ok, unpinned ones. */
export function retentionVictims(records, keep) {
  if (!keep || keep < 1) return [];
  return records
    .filter((b) => b.status === "ok" && !b.pinned)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(keep);
}

export function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function normalizeInclude(inc, fallback = DEFAULTS.server.include) {
  const src = inc && typeof inc === "object" ? inc : fallback;
  return { panel: !!src.panel, sites: !!src.sites, nginx: !!src.nginx, databases: !!src.databases };
}

function validSchedule(input, kind, current) {
  const out = { ...DEFAULTS[kind], ...(current || {}) };
  if (!input || typeof input !== "object") return out;
  if ("enabled" in input) out.enabled = !!input.enabled;
  if ("every" in input) {
    if (!["hourly", "daily", "weekly"].includes(input.every)) throw httpError(400, "`every` must be hourly, daily or weekly.");
    out.every = input.every;
  }
  if ("at" in input) {
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(input.at))) throw httpError(400, "`at` must be HH:MM (24h).");
    out.at = String(input.at);
  }
  if ("day" in input) {
    const d = Number(input.day);
    if (!Number.isInteger(d) || d < 0 || d > 6) throw httpError(400, "`day` must be 0 (Sunday) … 6 (Saturday).");
    out.day = d;
  }
  if ("keep" in input) {
    const k = Number(input.keep);
    if (!Number.isInteger(k) || k < 0 || k > 1000) throw httpError(400, "`keep` must be a whole number 0–1000 (0 = keep everything).");
    out.keep = k;
  }
  if (kind === "server") {
    if ("include" in input) out.include = normalizeInclude(input.include);
    if ("serverIds" in input) {
      if (!Array.isArray(input.serverIds) || !input.serverIds.every((s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s)))
        throw httpError(400, "`serverIds` must be a list of server ids.");
      out.serverIds = [...new Set(input.serverIds)];
    }
  }
  return out;
}

async function sha256File(file) {
  const h = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), async function* (src) {
    for await (const c of src) h.update(c);
  });
  return h.digest("hex");
}

const relFromRoot = (p) => path.resolve(p).replace(/^\/+/, "");
const safeRel = (r) => typeof r === "string" && r && !r.startsWith("/") && !r.split("/").includes("..") && !/[\0\n]/.test(r);

// ------------------------------------------------------------ the module

export function register(router, ctx) {
  const root = () => path.join(ctx.dataDir, "backups");
  const tmpRoot = () => path.join(ctx.dataDir, "tmp");
  const stateFile = () => path.join(root(), "schedule-state.json");
  const active = new Map(); // lock key → backup/job id

  const cfg = () => {
    const b = (ctx.config.backups = ctx.config.backups || {});
    b.database = { ...DEFAULTS.database, ...(b.database || {}) };
    b.server = { ...DEFAULTS.server, ...(b.server || {}) };
    b.server.include = normalizeInclude(b.server.include);
    b.destination = { ...DEFAULTS.destination, ...(b.destination || {}) };
    return b;
  };
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

  function absOf(rel) {
    const r = root();
    const abs = path.resolve(r, String(rel || ""));
    if (!abs.startsWith(r + path.sep)) throw httpError(400, "Backup path is outside the backups folder.");
    return abs;
  }

  function existsRel(rel) {
    try {
      return fs.existsSync(absOf(rel));
    } catch {
      return false;
    }
  }

  function readState() {
    try {
      return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    } catch {
      return {};
    }
  }
  function writeState(s) {
    fs.mkdirSync(root(), { recursive: true });
    const tmp = `${stateFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, stateFile());
  }

  function serverName(id) {
    try {
      return ctx.cluster?.getServer?.(id)?.name || (id === MAIN_ID ? "Main server" : id);
    } catch {
      return id;
    }
  }

  function publicView(b) {
    if (!b) return null;
    const db = b.databaseId ? ctx.db.get("databases", b.databaseId) : null;
    return {
      id: b.id,
      kind: b.kind,
      projectId: b.projectId || null,
      databaseId: b.databaseId || null,
      databaseName: db?.name || b.databaseName || null,
      serverId: b.serverId || null,
      serverName: b.serverId ? serverName(b.serverId) : null,
      include: b.include || null,
      filename: b.file ? path.basename(b.file) : null,
      size: b.size || 0,
      sha256: b.sha256 || null,
      status: b.status,
      // A finished backup whose archive has been removed from disk can no
      // longer be downloaded or restored; say so instead of listing it as ok.
      // (b.file is relative to the backups folder — resolve it, don't test it against cwd.)
      available: b.status === "ok" ? !!(b.file && existsRel(b.file)) : false,
      trigger: b.trigger,
      pinned: !!b.pinned,
      note: b.note || "",
      error: b.error || null,
      jobId: b.jobId || null,
      remote: b.remote
        ? {
            type: b.remote.type,
            key: b.remote.key || null,
            location: remoteLocation(b.remote),
            uploadedAt: b.remote.uploadedAt || null,
            error: b.remote.error || null,
            dryRun: !!b.remote.dryRun,
            fetchable: canFetch(b),
          }
        : null,
      downloadUrl: b.status === "ok" ? `/api/backups/${b.id}/download` : null,
      createdAt: b.createdAt,
      finishedAt: b.finishedAt || null,
    };
  }

  function getBackup(id) {
    const b = ctx.db.get("backups", id);
    if (!b) throw httpError(404, "Backup not found.");
    return b;
  }

  function update(id, patch) {
    const b = ctx.db.update("backups", id, patch);
    broadcast("backup", { action: "updated", backup: publicView(b) });
    return b;
  }

  function lock(key, holder) {
    if (active.has(key)) return false;
    active.set(key, holder);
    return true;
  }

  // ------------------------------------------------------------ destination

  function destinationClient() {
    const d = cfg().destination;
    if (d.type !== "s3") return null;
    let secretKey = "";
    try {
      secretKey = d.secretKeyEnc ? ctx.secrets.decrypt(d.secretKeyEnc) : "";
    } catch {}
    return createS3({ endpoint: d.endpoint, bucket: d.bucket, region: d.region, accessKey: d.accessKey, secretKey, prefix: d.prefix, pathStyle: d.pathStyle !== false });
  }

  // SMB: settings live in destination.smb (password as passwordEnc).
  function smbClient(d = cfg().destination) {
    const s = d.smb || {};
    let password = "";
    try {
      password = s.passwordEnc ? ctx.secrets.decrypt(s.passwordEnc) : "";
    } catch {}
    return createSmb({ ...s, password }, { tmpDir: tmpRoot() });
  }
  const sameSmb = (d, r) =>
    d.type === "smb" && !!d.smb && String(d.smb.server || "").toLowerCase() === String(r.server || "").toLowerCase() && String(d.smb.share || "").toLowerCase() === String(r.share || "").toLowerCase();

  function remoteLocation(r) {
    if (!r?.key) return null;
    if (r.type === "smb") return `//${r.server}/${r.share}/${r.key}`;
    if (r.type === "s3") return `s3://${r.bucket}/${r.key}`;
    return null;
  }

  /** Can a missing local file be pulled back from the off-site copy? (SMB only.) */
  function canFetch(b) {
    return b.status === "ok" && b.remote?.type === "smb" && !!b.remote.key && !b.remote.error && sameSmb(cfg().destination, b.remote);
  }

  async function uploadSmb(b, abs, log) {
    try {
      const smb = smbClient();
      const key = smb.keyFor(b.file);
      log?.(`Uploading to ${smb.location(key)}…`);
      await smb.putFile(b.file, abs, { log });
      update(b.id, { remote: { type: "smb", key, server: smb.server, share: smb.share, uploadedAt: new Date().toISOString(), ...(DRY_RUN ? { dryRun: true } : {}) } });
      log?.(DRY_RUN ? "[dry-run] Off-site copy simulated." : "Off-site copy uploaded.");
    } catch (e) {
      log?.(`Off-site upload failed (the local copy is fine): ${e.message}`);
      update(b.id, { remote: { type: "smb", error: e.message } });
    }
  }

  async function uploadRemote(b, abs, log) {
    const d = cfg().destination;
    if (d.type === "smb") return uploadSmb(b, abs, log);
    if (d.type !== "s3") return;
    if (DRY_RUN) {
      log?.(`[dry-run] upload to s3://${d.bucket}/${d.prefix ? `${d.prefix}/` : ""}${b.file}`);
      return;
    }
    try {
      const s3 = destinationClient();
      const key = s3.keyFor(b.file);
      log?.(`Uploading to s3://${d.bucket}/${key}…`);
      await s3.putFile(key, abs, { sha256: b.sha256, contentType: "application/gzip" });
      update(b.id, { remote: { type: "s3", key, bucket: d.bucket, endpoint: d.endpoint, uploadedAt: new Date().toISOString() } });
      log?.("Off-site copy uploaded.");
    } catch (e) {
      log?.(`Off-site upload failed (the local copy is fine): ${e.message}`);
      update(b.id, { remote: { type: "s3", error: e.message } });
    }
  }

  async function removeRemote(b) {
    if (!b.remote?.key) return;
    const d = cfg().destination;
    if (b.remote.type === "smb") {
      if (!sameSmb(d, b.remote)) return; // destination changed; leave the old file alone
      try {
        await smbClient(d).deleteFile(b.remote.key, { log: DRY_RUN ? (l) => console.log(`[fcc] backups: ${l}`) : null });
      } catch (e) {
        console.error(`[fcc] could not delete off-site copy ${remoteLocation(b.remote)}: ${e.message}`);
      }
      return;
    }
    if (DRY_RUN) return;
    if (d.type !== "s3" || d.bucket !== b.remote.bucket) return; // destination changed; leave the old object alone
    try {
      await destinationClient().deleteObject(b.remote.key);
    } catch (e) {
      console.error(`[fcc] could not delete off-site copy ${b.remote.key}: ${e.message}`);
    }
  }

  // ------------------------------------------------------------ bookkeeping

  async function removeBackup(id, { reason } = {}) {
    const b = getBackup(id);
    if (b.status === "running") throw httpError(409, "That backup is still running.");
    if (b.file) {
      try {
        fs.rmSync(absOf(b.file), { force: true });
      } catch {}
    }
    await removeRemote(b);
    ctx.db.remove("backups", id);
    broadcast("backup", { action: "deleted", id, reason: reason || null, kind: b.kind, databaseId: b.databaseId || null, serverId: b.serverId || null });
    return b;
  }

  async function applyRetention(kind, targetId, log) {
    const keep = Number(kind === "database" ? cfg().database.keep : cfg().server.keep) || 0;
    const mine = ctx.db.list("backups", (b) => b.kind === kind && (kind === "database" ? b.databaseId === targetId : b.serverId === targetId));
    for (const v of retentionVictims(mine, keep)) {
      log?.(`Retention (keep ${keep}): removing ${path.basename(v.file || v.id)}`);
      try {
        await removeBackup(v.id, { reason: "retention" });
      } catch {}
    }
    // Failed attempts: keep only the newest five as a trail.
    const failed = mine.filter((b) => b.status === "failed").sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    for (const f of failed.slice(5)) {
      try {
        await removeBackup(f.id, { reason: "retention" });
      } catch {}
    }
  }

  async function finalize(b, abs, log) {
    const st = fs.statSync(abs);
    const sha256 = await sha256File(abs);
    let rec = update(b.id, { status: "ok", size: st.size, sha256, finishedAt: new Date().toISOString(), error: null });
    log?.(`Wrote ${path.basename(abs)} (${st.size} bytes, sha256 ${sha256})`);
    await uploadRemote(rec, abs, log);
    rec = ctx.db.get("backups", b.id);
    await applyRetention(b.kind, b.kind === "database" ? b.databaseId : b.serverId, log);
    return rec;
  }

  function failRecord(id, err) {
    if (!ctx.db.get("backups", id)) return;
    update(id, { status: "failed", error: String(err?.message || err), finishedAt: new Date().toISOString() });
  }

  /** A real one-file tar.gz, so dry-run server archives open in any tool. */
  function writePlaceholderTar(abs, name, text) {
    const body = Buffer.from(text);
    const h = Buffer.alloc(512, 0);
    const put = (str, off, len) => h.write(str, off, len, "ascii");
    const oct = (n, len) => `${n.toString(8).padStart(len - 1, "0")}\0`;
    put(name, 0, 100);
    put(oct(0o600, 8), 100, 8);
    put(oct(0, 8), 108, 8);
    put(oct(0, 8), 116, 8);
    put(oct(body.length, 12), 124, 12);
    put(oct(Math.floor(Date.now() / 1000), 12), 136, 12);
    put("        ", 148, 8);
    put("0", 156, 1);
    put("ustar\u000000", 257, 8);
    let sum = 0;
    for (const b of h) sum += b;
    put(`${oct(sum, 7)} `, 148, 8);
    const pad = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, zlib.gzipSync(Buffer.concat([h, body, pad, Buffer.alloc(1024, 0)])), { mode: 0o600 });
  }

  function uniquePath(rel) {
    let r = rel;
    let i = 1;
    while (fs.existsSync(absOf(r))) r = rel.replace(/(\.sql\.gz|\.tar\.gz)$/, `-${i++}$1`);
    return r;
  }

  // ------------------------------------------------------------ database backups

  /** Dump one database into a new backup record (no job, no lock). */
  async function runDatabaseBackup(dbRec, { trigger = "manual", note = "", adminId = null, log, signal, jobId } = {}) {
    if (!ctx.mysql?.dump) throw new Error("The MySQL module is not loaded.");
    const project = ctx.db.get("projects", dbRec.projectId);
    const slug = projectPrefix(project || { id: dbRec.projectId });
    const rel = uniquePath(`db/${slug}/${dbRec.name}-${stamp()}.sql.gz`);
    const b = ctx.db.insert("backups", {
      kind: "database",
      projectId: dbRec.projectId,
      databaseId: dbRec.id,
      databaseName: dbRec.name,
      file: rel,
      size: 0,
      sha256: null,
      status: "running",
      trigger,
      pinned: false,
      note: String(note || "").slice(0, 500),
      error: null,
      adminId,
      jobId: jobId || null,
    });
    broadcast("backup", { action: "created", backup: publicView(b) });
    const abs = absOf(rel);
    try {
      await ctx.mysql.dump(dbRec.id, { file: abs, log, signal });
      return await finalize(b, abs, log);
    } catch (e) {
      fs.rmSync(abs, { force: true });
      failRecord(b.id, e);
      throw e;
    }
  }

  function backupDatabase(databaseId, { trigger = "manual", adminId = null, admin = null, note = "" } = {}) {
    const dbRec = ctx.db.get("databases", databaseId);
    if (!dbRec) throw httpError(404, "Database not found.");
    const key = `db:${databaseId}`;
    if (!lock(key, "pending")) throw httpError(409, `A backup or restore of ${dbRec.name} is already running.`);
    let job;
    try {
      job = ctx.jobs.start(
        { type: "backup.database", title: `Back up database ${dbRec.name}`, projectId: dbRec.projectId, databaseId, adminId: adminId || admin?.id || null },
        async ({ log, signal, job }) => {
          try {
            const b = await runDatabaseBackup(dbRec, { trigger, note, adminId: adminId || admin?.id || null, log, signal, jobId: job?.id });
            audit(admin, "backup.database", { type: "database", id: dbRec.id, name: dbRec.name }, { backupId: b.id, trigger, size: b.size });
            broadcast("database", { action: "backup", databaseId, backupId: b.id });
            return { backupId: b.id, file: path.basename(b.file), size: b.size, sha256: b.sha256 };
          } finally {
            active.delete(key);
          }
        },
      );
    } catch (e) {
      active.delete(key);
      throw e;
    }
    return job;
  }

  // ------------------------------------------------------------ server backups

  let gnuTar = null;
  async function isGnuTar() {
    if (gnuTar !== null) return gnuTar;
    if (DRY_RUN) return (gnuTar = true);
    try {
      gnuTar = /GNU tar/.test((await run(which("tar") || "tar", ["--version"], { timeoutMs: 5000 })).stdout);
    } catch {
      gnuTar = false;
    }
    return gnuTar;
  }

  function isSafeTreeRoot(p) {
    const r = path.resolve(p);
    if (FORBIDDEN_ROOTS.includes(r)) return false;
    if (/^\/(etc|usr|bin|sbin|lib|lib64|boot|dev|proc|sys|run)(\/|$)/.test(r)) return false;
    return r.split("/").filter(Boolean).length >= 2;
  }

  function siteRoots() {
    const roots = [];
    const add = (p) => {
      const r = path.resolve(p);
      if (!fs.existsSync(r) || !isSafeTreeRoot(r)) return;
      if (roots.some((x) => r === x || r.startsWith(x + path.sep))) return;
      for (let i = roots.length - 1; i >= 0; i--) if (roots[i].startsWith(r + path.sep)) roots.splice(i, 1);
      roots.push(r);
    };
    add(ctx.config.sitesRoot || process.env.FCC_SITES_DIR || "/srv/fcc/sites");
    for (const s of ctx.db.list("sites")) {
      const ids = Array.isArray(s.serverIds) && s.serverIds.length ? (s.loadBalanced ? s.serverIds : [s.serverIds[0]]) : [MAIN_ID];
      if (ids.includes(MAIN_ID) && typeof s.appDir === "string" && path.isAbsolute(s.appDir)) add(s.appDir);
    }
    return roots;
  }

  function nginxPaths() {
    const out = [];
    const confd = "/etc/nginx/conf.d";
    try {
      for (const f of fs.readdirSync(confd)) if (/^fcc-[A-Za-z0-9_.-]+$/.test(f)) out.push(path.join(confd, f));
    } catch {}
    for (const p of ["/etc/nginx/fcc", "/etc/letsencrypt"]) if (fs.existsSync(p)) out.push(p);
    return out;
  }

  async function buildMainArchive(b, abs, include, { log, signal }) {
    const stage = path.join(tmpRoot(), `backup-${b.id}`);
    const meta = path.join(stage, "fcc-backup");
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(meta, { recursive: true, mode: 0o700 });
    const tmpOut = `${abs}.part`;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    try {
      const manifest = {
        format: 1,
        panelVersion: ctx.version || null,
        createdAt: new Date().toISOString(),
        serverId: MAIN_ID,
        hostname: os.hostname(),
        include,
        dataDir: path.resolve(ctx.dataDir),
        paths: { panel: [], sites: [], nginx: [] },
        files: {},
        notes: [],
      };
      const excludes = ["--exclude=node_modules", "--exclude=.next/cache", "--exclude=*.sock"];
      const operands = [];
      if (include.panel) {
        try {
          await ctx.db.save?.({ immediate: true });
        } catch {}
        const dd = relFromRoot(ctx.dataDir);
        operands.push(dd);
        manifest.paths.panel.push(dd);
        for (const x of ["backups", "tmp", "releases", "update-backups"]) excludes.push(`--exclude=${dd}/${x}`);
        manifest.notes.push("panel: dataDir without backups/, tmp/, releases/ (re-download or redeploy releases).");
      }
      if (include.sites) {
        for (const p of siteRoots()) {
          operands.push(relFromRoot(p));
          manifest.paths.sites.push(relFromRoot(p));
        }
        manifest.notes.push("sites: node_modules and .next/cache are excluded — redeploy or reinstall after restoring.");
      }
      if (include.nginx) {
        for (const p of nginxPaths()) {
          operands.push(relFromRoot(p));
          manifest.paths.nginx.push(relFromRoot(p));
        }
      }
      if (include.databases) {
        const st = await ctx.mysql?.status?.().catch?.(() => null);
        if (st?.rootOk) {
          await ctx.mysql.dumpAll({ file: path.join(meta, "all-databases.sql.gz"), log, signal });
          manifest.files.databases = "fcc-backup/all-databases.sql.gz";
        } else {
          const why = st?.error || "MySQL is not available";
          log?.(`Skipping databases: ${why}`);
          manifest.notes.push(`databases skipped: ${why}`);
        }
      }
      fs.writeFileSync(path.join(meta, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });

      const tar = which("tar") || "tar";
      const gnu = await isGnuTar();
      const args = ["-czf", tmpOut, ...(gnu ? ["--ignore-failed-read", "--warning=no-file-changed", "--warning=no-file-removed"] : []), ...excludes];
      if (operands.length) args.push("-C", "/", ...operands);
      args.push("-C", stage, "fcc-backup");
      log?.(`Archiving: ${operands.length ? operands.map((o) => `/${o}`).join(", ") : "(manifest only)"}`);
      if (DRY_RUN) {
        await run(tar, args, { log, signal });
        writePlaceholderTar(tmpOut, "fcc-backup/manifest.json", `${JSON.stringify({ ...manifest, dryRun: true }, null, 2)}\n`);
      } else {
        const r = await run(tar, args, { log, signal, allowFail: true });
        if (r.code !== 0 && !(gnu && r.code === 1)) {
          const tail = (r.stderr || r.stdout).trim().split("\n").slice(-5).join("\n");
          throw new Error(`tar exited with code ${r.code}${tail ? `: ${tail}` : ""}`);
        }
        if (r.code === 1) log?.("tar: some files changed while being archived (archive is still usable).");
      }
      fs.chmodSync(tmpOut, 0o600);
      fs.renameSync(tmpOut, abs);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
      fs.rmSync(tmpOut, { force: true });
    }
  }

  /**
   * Worker archive via the CLUSTER task. CLUSTER rewrites payload.upload to its
   * own /agent/upload/:taskId, stores the archive as dataDir/backups/<file> and
   * returns { file: <absolute path on main>, size, sha256 }; we move it into place.
   */
  async function runWorkerBackup(b, abs, include, serverId, { log, signal }) {
    if (!ctx.cluster?.runTask) throw new Error("The cluster module is not loaded.");
    const appDirs = ctx.db
      .list("sites", (s) => (Array.isArray(s.serverIds) ? (s.loadBalanced ? s.serverIds : s.serverIds.slice(0, 1)) : []).includes(serverId))
      .map((s) => s.appDir)
      .filter((d) => typeof d === "string" && path.isAbsolute(d));
    log?.(`Asking ${serverName(serverId)} to build the archive…`);
    const result = await ctx.cluster.runTask(
      serverId,
      "server.backup",
      { include: { panel: false, sites: include.sites, nginx: include.nginx }, appDirs, file: path.basename(abs), upload: {} },
      { log, signal },
    );
    const f = result?.file;
    const dd = path.resolve(ctx.dataDir) + path.sep;
    if (f && path.isAbsolute(f) && path.resolve(f).startsWith(dd) && fs.existsSync(f)) {
      if (path.resolve(f) !== abs) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.renameSync(f, abs);
      }
    } else if (DRY_RUN) {
      writePlaceholderTar(abs, "DRY-RUN.txt", `FCC dry-run placeholder (worker ${serverId} backup ${b.id})\n`);
    } else {
      throw new Error("The worker finished but no archive arrived on the panel.");
    }
    if (result?.sha256 && !DRY_RUN) {
      const got = await sha256File(abs);
      if (got !== result.sha256) throw new Error("Uploaded archive checksum does not match what the worker reported.");
    }
  }

  function backupServer(serverId, { include, trigger = "manual", adminId = null, admin = null, note = "" } = {}) {
    let server = null;
    try {
      server = ctx.cluster?.getServer?.(serverId) || null;
    } catch {}
    if (!server && serverId !== MAIN_ID) throw httpError(404, "Server not found.");
    const inc = normalizeInclude(include, cfg().server.include);
    if (!Object.values(inc).some(Boolean)) throw httpError(400, "Choose at least one thing to include.");
    const key = `srv:${serverId}`;
    if (!lock(key, "pending")) throw httpError(409, `A backup of ${serverName(serverId)} is already running.`);
    const name = server?.name || serverName(serverId);
    try {
      const rel = uniquePath(`server/${serverId}/server-${serverId}-${stamp()}.tar.gz`);
      const b = ctx.db.insert("backups", {
        kind: "server",
        serverId,
        include: inc,
        file: rel,
        size: 0,
        sha256: null,
        status: "running",
        trigger,
        pinned: false,
        note: String(note || "").slice(0, 500),
        error: null,
        adminId: adminId || admin?.id || null,
      });
      broadcast("backup", { action: "created", backup: publicView(b) });
      const job = ctx.jobs.start(
        { type: "backup.server", title: `Back up server ${name}`, serverId, adminId: adminId || admin?.id || null },
        async ({ log, signal }) => {
          const abs = absOf(rel);
          try {
            if (serverId === MAIN_ID) await buildMainArchive(b, abs, inc, { log, signal });
            else await runWorkerBackup(b, abs, inc, serverId, { log, signal });
            const done = await finalize(b, abs, log);
            audit(admin, "backup.server", { type: "server", id: serverId, name }, { backupId: b.id, trigger, include: inc, size: done.size });
            return { backupId: b.id, file: path.basename(rel), size: done.size, sha256: done.sha256 };
          } catch (e) {
            fs.rmSync(abs, { force: true });
            failRecord(b.id, e);
            throw e;
          } finally {
            active.delete(key);
          }
        },
      );
      update(b.id, { jobId: job.id });
      return job;
    } catch (e) {
      active.delete(key);
      throw e;
    }
  }

  // ------------------------------------------------------------ restore

  /** Download a backup's SMB copy back into dataDir/backups (checksum-verified). */
  async function fetchRemote(b, { log, signal } = {}) {
    const abs = absOf(b.file);
    const key = `fetch:${b.id}`;
    if (!lock(key, "fetch")) throw new Error("This backup is already being downloaded from the SMB share.");
    const part = `${abs}.part`;
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.rmSync(part, { force: true });
      log?.(`Downloading ${remoteLocation(b.remote)}…`);
      await smbClient().getFile(b.remote.key, part, { log, signal, size: b.size });
      if (DRY_RUN) {
        if (!fs.existsSync(part)) {
          if (b.kind === "server") writePlaceholderTar(part, "DRY-RUN.txt", `FCC dry-run placeholder (fetched ${b.id} from SMB)\n`);
          else fs.writeFileSync(part, zlib.gzipSync(`-- FCC dry-run placeholder (fetched ${b.id} from SMB)\n`), { mode: 0o600 });
        }
        log?.("[dry-run] Simulated download — checksum not verified.");
      } else {
        if (!fs.existsSync(part)) throw new Error("smbclient finished but no file arrived.");
        if (b.sha256 && (await sha256File(part)) !== b.sha256) throw new Error("The SMB copy's checksum doesn't match this backup — refusing to use it.");
      }
      fs.chmodSync(part, 0o600);
      fs.renameSync(part, abs);
      log?.("Local copy restored from the SMB share.");
      broadcast("backup", { action: "updated", backup: publicView(ctx.db.get("backups", b.id)) });
      return abs;
    } finally {
      fs.rmSync(part, { force: true });
      active.delete(key);
    }
  }

  async function verifyFile(b, log, signal) {
    const abs = absOf(b.file);
    let fetched = false;
    if (!fs.existsSync(abs) && canFetch(b)) {
      log?.("The local copy is missing — fetching it from the SMB share first.");
      await fetchRemote(b, { log, signal });
      fetched = true;
    }
    if (!fs.existsSync(abs)) throw new Error("The backup file is missing from disk.");
    if (fetched && DRY_RUN) return abs;
    if (b.sha256) {
      const got = await sha256File(abs);
      if (got !== b.sha256) throw new Error("Backup file checksum does not match — refusing to restore a corrupted or altered file.");
      log?.("Checksum verified.");
    }
    return abs;
  }

  function restoreDatabase(b, admin) {
    const dbRec = ctx.db.get("databases", b.databaseId);
    if (!dbRec) throw httpError(409, "The database this backup belongs to no longer exists. Download the backup instead.");
    const key = `db:${dbRec.id}`;
    if (!lock(key, "restore")) throw httpError(409, `A backup or restore of ${dbRec.name} is already running.`);
    try {
      return ctx.jobs.start(
        { type: "backup.restore", title: `Restore ${dbRec.name} from ${path.basename(b.file)}`, projectId: dbRec.projectId, databaseId: dbRec.id, adminId: admin?.id || null },
        async ({ log, signal, job }) => {
          try {
            const abs = await verifyFile(b, log, signal);
            log("Taking a safety backup of the current data first…");
            const safety = await runDatabaseBackup(dbRec, {
              trigger: "safety",
              note: `Automatic copy before restoring ${path.basename(b.file)}`,
              adminId: admin?.id || null,
              log,
              signal,
              jobId: job?.id,
            });
            log(`Safety backup: ${path.basename(safety.file)}`);
            if (signal?.aborted) throw new Error("Cancelled");
            await ctx.mysql.recreate(dbRec.id, { log });
            await ctx.mysql.restore(dbRec.id, { file: abs, log, signal, as: "root" });
            audit(admin, "backup.restore", { type: "database", id: dbRec.id, name: dbRec.name }, { backupId: b.id, safetyBackupId: safety.id });
            broadcast("database", { action: "restored", databaseId: dbRec.id, backupId: b.id });
            return { restored: b.id, safetyBackupId: safety.id };
          } finally {
            active.delete(key);
          }
        },
      );
    } catch (e) {
      active.delete(key);
      throw e;
    }
  }

  async function readManifest(abs) {
    if (DRY_RUN) return null;
    const r = await run(which("tar") || "tar", ["-xzOf", abs, "fcc-backup/manifest.json"], { allowFail: true, timeoutMs: 10 * 60_000 });
    if (r.code !== 0) return null;
    try {
      return JSON.parse(r.stdout);
    } catch {
      return null;
    }
  }

  function restoreServer(b, opts, admin) {
    if (b.serverId !== MAIN_ID)
      throw httpError(400, "Only main-server backups can be restored from the panel. Download this archive and extract it on the worker.");
    const want = { sites: opts?.sites !== false, nginx: opts?.nginx !== false };
    if (!want.sites && !want.nginx) throw httpError(400, "Nothing selected to restore.");
    const key = "restore:main";
    if (!lock(key, "restore")) throw httpError(409, "A server restore is already running.");
    try {
      return ctx.jobs.start(
        { type: "backup.restore", title: `Restore main server from ${path.basename(b.file)}`, serverId: MAIN_ID, adminId: admin?.id || null },
        async ({ log, signal }) => {
          try {
            const abs = await verifyFile(b, log, signal);
            const manifest = await readManifest(abs);
            if (!manifest && !DRY_RUN) throw new Error("This archive has no FCC manifest; extract it by hand.");
            const panelRel = manifest?.dataDir ? relFromRoot(manifest.dataDir) : relFromRoot(ctx.dataDir);
            // Never the panel's data dir itself (or anything containing it); a site root
            // nested inside it (dev setups) is fine — it can't replace db.json/config.json.
            const notPanel = (r) => r !== panelRel && !panelRel.startsWith(`${r}/`);
            const members = [];
            if (want.sites) members.push(...(manifest?.paths?.sites || []).filter((r) => safeRel(r) && notPanel(r) && isSafeTreeRoot(`/${r}`)));
            if (want.nginx)
              members.push(...(manifest?.paths?.nginx || []).filter((r) => safeRel(r) && (/^etc\/nginx\/conf\.d\/fcc-[A-Za-z0-9_.-]+$/.test(r) || r === "etc/nginx/fcc")));
            if (!members.length && !DRY_RUN) {
              log("The archive contains nothing restorable for the selected parts.");
              return { restored: [] };
            }
            log(`Extracting: ${members.map((m) => `/${m}`).join(", ") || "(dry-run)"}`);
            const gnu = await isGnuTar();
            await run(which("tar") || "tar", ["-xzpf", abs, "-C", "/", ...(gnu ? ["--no-overwrite-dir"] : []), "--", ...members], { log, signal });
            if (want.nginx && which("nginx")) {
              const t = await run("nginx", ["-t"], { log, allowFail: true });
              if (t.code === 0) {
                if (which("systemctl")) await run("systemctl", ["reload", "nginx"], { log, allowFail: true });
                else await run("nginx", ["-s", "reload"], { log, allowFail: true });
              } else log("nginx -t failed after restore — not reloading. Check the configs or run Load balancer → Apply.");
            }
            log("Done. Panel data was not touched; site dependencies (node_modules) were not in the archive — redeploy the sites to rebuild them.");
            if (manifest?.files?.databases) log("The archive also contains fcc-backup/all-databases.sql.gz (not restored automatically).");
            audit(admin, "backup.restore", { type: "server", id: MAIN_ID, name: serverName(MAIN_ID) }, { backupId: b.id, ...want });
            return { restored: members };
          } finally {
            active.delete(key);
          }
        },
      );
    } catch (e) {
      active.delete(key);
      throw e;
    }
  }

  // ------------------------------------------------------------ settings view

  function settingsView() {
    const c = cfg();
    const state = readState();
    const d = c.destination;
    const all = ctx.db.list("backups", (b) => b.status === "ok");
    return {
      database: { ...c.database },
      server: { ...c.server, include: { ...c.server.include } },
      destination: {
        type: ["s3", "smb"].includes(d.type) ? d.type : "local",
        endpoint: d.endpoint || "",
        bucket: d.bucket || "",
        region: d.region || "",
        accessKey: d.accessKey || "",
        prefix: d.prefix || "",
        pathStyle: d.pathStyle !== false,
        secretKeySet: !!d.secretKeyEnc,
        smb: {
          server: d.smb?.server || "",
          share: d.smb?.share || "",
          path: d.smb?.path || "",
          username: d.smb?.username || "",
          domain: d.smb?.domain || "",
          minProtocol: d.smb?.minProtocol || "SMB2",
          port: d.smb?.port || 445,
          passwordSet: !!d.smb?.passwordEnc,
        },
      },
      smbclient: { installed: smbInstalled(), canInstall: DRY_RUN || !!which("apt-get"), dryRun: DRY_RUN },
      nextRun: {
        database: c.database.enabled ? nextSlot(c.database).toISOString() : null,
        server: c.server.enabled ? nextSlot(c.server).toISOString() : null,
      },
      lastRun: { database: state.database?.lastRunAt || null, server: state.server?.lastRunAt || null },
      usage: { count: all.length, bytes: all.reduce((n, b) => n + (b.size || 0), 0) },
      localPath: root(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    };
  }

  function validDestination(input, current) {
    const out = { ...current };
    if (!input || typeof input !== "object") return out;
    if ("type" in input) {
      if (!["local", "s3", "smb"].includes(input.type)) throw httpError(400, "Destination type must be local, s3 or smb.");
      out.type = input.type;
    }
    if (input.smb && typeof input.smb === "object") {
      try {
        out.smb = validSmb(input.smb, out.smb || {});
      } catch (e) {
        throw e.validation ? httpError(400, e.message) : e;
      }
    }
    if ("endpoint" in input) {
      const e = String(input.endpoint || "").trim();
      if (e) {
        let u;
        try {
          u = new URL(/^https?:\/\//.test(e) ? e : `https://${e}`);
        } catch {
          throw httpError(400, "Endpoint must be a URL such as https://s3.eu-central-1.amazonaws.com");
        }
        if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search) throw httpError(400, "Endpoint must be a plain http(s) URL.");
        out.endpoint = u.origin + u.pathname.replace(/\/+$/, "");
      } else out.endpoint = "";
    }
    if ("bucket" in input) {
      const v = String(input.bucket || "").trim();
      if (v && !/^[A-Za-z0-9][A-Za-z0-9._-]{1,254}$/.test(v)) throw httpError(400, "Invalid bucket name.");
      out.bucket = v;
    }
    if ("region" in input) {
      const v = String(input.region || "").trim();
      if (v && !/^[a-z0-9-]{1,40}$/.test(v)) throw httpError(400, "Invalid region.");
      out.region = v;
    }
    if ("accessKey" in input) {
      const v = String(input.accessKey || "").trim();
      if (v && !/^[\x21-\x7e]{1,256}$/.test(v)) throw httpError(400, "Invalid access key.");
      out.accessKey = v;
    }
    if ("prefix" in input) {
      const v = String(input.prefix || "").trim().replace(/^\/+|\/+$/g, "");
      if (v && !/^[A-Za-z0-9._\/-]{1,200}$/.test(v)) throw httpError(400, "Prefix may contain letters, digits, . _ - and /.");
      out.prefix = v;
    }
    if ("pathStyle" in input) out.pathStyle = !!input.pathStyle;
    if (typeof input.secretKey === "string" && input.secretKey) {
      if (!/^[\x21-\x7e]{1,256}$/.test(input.secretKey)) throw httpError(400, "Invalid secret key.");
      out.secretKeyEnc = ctx.secrets.encrypt(input.secretKey);
    }
    if (input.clearSecretKey) delete out.secretKeyEnc;
    delete out.secretKey;
    if (out.type === "s3" && (!out.endpoint || !out.bucket || !out.accessKey || !out.secretKeyEnc))
      throw httpError(400, "An S3 destination needs endpoint, bucket, access key and secret key.");
    if (out.type === "smb" && (!out.smb?.server || !out.smb?.share || !out.smb?.username))
      throw httpError(400, "An SMB destination needs server, share and user name.");
    return out;
  }

  /** destination.smb: { server, share, path, username, passwordEnc, domain, minProtocol, port }. */
  function validSmb(input, current) {
    const out = { minProtocol: "SMB2", port: 445, ...current };
    if ("server" in input) out.server = String(input.server || "").trim() ? validServer(input.server) : "";
    if ("share" in input) out.share = String(input.share || "").trim() ? validShare(input.share) : "";
    if ("path" in input) out.path = validFolder(input.path).join("/");
    if ("username" in input) out.username = String(input.username || "").trim() ? validUsername(input.username) : "";
    if ("domain" in input) out.domain = validDomain(input.domain);
    if ("minProtocol" in input) out.minProtocol = validMinProtocol(input.minProtocol);
    if ("port" in input) out.port = validPort(input.port);
    if (typeof input.password === "string" && input.password) out.passwordEnc = ctx.secrets.encrypt(validPassword(input.password));
    if (input.clearPassword) delete out.passwordEnc;
    delete out.password;
    return out;
  }

  // ------------------------------------------------------------ API object

  ctx.backups = {
    backupDatabase,
    backupServer,
    // additions
    removeBackup,
    publicView,
    settings: settingsView,
    _internal: { dueCheck, prevSlot, nextSlot, active },
  };

  // ------------------------------------------------------------ routes
  // (settings routes first so "settings" is never taken for an :id)

  router.get("/api/backups/settings", async () => settingsView());

  router.put("/api/backups/settings", async (req, res, { body, admin }) => {
    const c = cfg();
    const before = { database: JSON.stringify(c.database), server: JSON.stringify(c.server) };
    const next = {
      database: validSchedule(body?.database, "database", c.database),
      server: validSchedule(body?.server, "server", c.server),
      destination: validDestination(body?.destination, c.destination),
    };
    ctx.config.backups = { ...ctx.config.backups, ...next };
    await ctx.saveConfig?.();
    // A changed schedule starts counting from now (don't fire for a slot that just passed).
    const state = readState();
    for (const k of ["database", "server"]) {
      if (JSON.stringify(next[k]) !== before[k]) state[k] = { ...(state[k] || {}), lastSlot: next[k].enabled ? prevSlot(next[k]).toISOString() : null };
    }
    writeState(state);
    audit(admin, "backup.settings", { type: "settings", id: "backups", name: "Backups" }, {
      database: { enabled: next.database.enabled, every: next.database.every, at: next.database.at, keep: next.database.keep },
      server: { enabled: next.server.enabled, every: next.server.every, at: next.server.at, keep: next.server.keep },
      destination: next.destination.type,
    });
    broadcast("backup", { action: "settings" });
    return settingsView();
  });

  router.post("/api/backups/destination/test", async (req, res, { body }) => {
    if (body?.type === "smb") {
      const merged = validDestination({ ...body, type: "smb" }, cfg().destination);
      const lines = [];
      try {
        const r = await smbClient(merged).test({ log: (l) => lines.push(l) });
        return { ...r, dryRun: DRY_RUN, log: lines.slice(-40) };
      } catch (e) {
        throw httpError(400, e.message, { log: lines.slice(-20), notInstalled: !!e.notInstalled });
      }
    }
    const merged = validDestination({ type: "s3", ...(body || {}) }, cfg().destination);
    if (DRY_RUN) return { ok: true, dryRun: true };
    let secretKey = "";
    try {
      secretKey = ctx.secrets.decrypt(merged.secretKeyEnc);
    } catch {}
    try {
      const s3 = createS3({ ...merged, secretKey, pathStyle: merged.pathStyle !== false });
      return await s3.test();
    } catch (e) {
      throw httpError(400, e.message);
    }
  });

  // SMB extras: browse the share, install smbclient (apt, Debian/Ubuntu).
  router.get("/api/backups/destination/remote", async (req, res, { query }) => {
    const d = cfg().destination;
    if (d.type !== "smb") throw httpError(409, "Browsing is only available for an SMB destination.");
    try {
      return await smbClient(d).list(String(query.path || ""), { timeoutSec: 60 });
    } catch (e) {
      throw httpError(e.validation ? 400 : 502, e.message, { notInstalled: !!e.notInstalled });
    }
  });

  router.post("/api/backups/destination/smb/install", async (req, res, { admin }) => {
    if (!DRY_RUN && !which("apt-get")) throw httpError(400, "This system has no apt-get. Install smbclient with your package manager (it's the `smbclient` / `samba-client` package), then reload.");
    return ctx.jobs.start({ type: "backup.smbclient", title: "Install smbclient", lock: "apt", adminId: admin?.id || null }, async ({ log, signal }) => {
      const env = { DEBIAN_FRONTEND: "noninteractive" };
      const args = ["install", "-y", "--no-install-recommends", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold", "smbclient"];
      const first = await run("apt-get", args, { env, log, signal, allowFail: true, timeoutMs: 20 * 60_000 });
      if (first.code !== 0) {
        log("apt-get install failed — refreshing package lists and retrying…");
        await run("apt-get", ["update"], { env, log, signal, timeoutMs: 10 * 60_000 });
        await run("apt-get", args, { env, log, signal, timeoutMs: 20 * 60_000 });
      }
      forgetWhich("smbclient");
      if (!smbInstalled()) throw new Error("apt-get finished but smbclient is still not on PATH.");
      audit(admin, "backup.smbclient.install", { type: "settings", id: "backups", name: "Backups" }, {});
      broadcast("backup", { action: "settings" });
      return { installed: true };
    });
  });

  router.get("/api/backups", async (req, res, { query }) => {
    let items = ctx.db.list("backups");
    if (query.kind) items = items.filter((b) => b.kind === query.kind);
    if (query.projectId) {
      const dbIds = new Set(ctx.db.list("databases", (d) => d.projectId === query.projectId).map((d) => d.id));
      items = items.filter((b) => b.projectId === query.projectId || (b.databaseId && dbIds.has(b.databaseId)));
    }
    if (query.databaseId) items = items.filter((b) => b.databaseId === query.databaseId);
    if (query.serverId) items = items.filter((b) => b.serverId === query.serverId);
    if (query.status) items = items.filter((b) => b.status === query.status);
    items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const limit = Math.min(Math.max(Number(query.limit) || 500, 1), 5000);
    return { items: items.slice(0, limit).map(publicView) };
  });

  router.post("/api/backups/server", async (req, res, { body, admin }) => {
    const serverId = String(body?.serverId || MAIN_ID);
    const job = backupServer(serverId, { include: body?.include, trigger: "manual", admin, note: body?.note });
    return job;
  });

  router.post("/api/databases/:id/backups", async (req, res, { params, body, admin }) =>
    backupDatabase(params.id, { trigger: "manual", admin, note: body?.note }),
  );

  router.get("/api/backups/:id", async (req, res, { params }) => publicView(getBackup(params.id)));

  router.post("/api/backups/:id/fetch", async (req, res, { params, admin }) => {
    const b = getBackup(params.id);
    if (!canFetch(b)) throw httpError(409, "This backup has no SMB copy on the current destination.");
    if (fs.existsSync(absOf(b.file))) throw httpError(409, "The local copy is already on disk.");
    audit(admin, "backup.fetch", { type: "backup", id: b.id, name: path.basename(b.file || "") }, { from: remoteLocation(b.remote) });
    return ctx.jobs.start(
      { type: "backup.fetch", title: `Fetch ${path.basename(b.file)} from SMB`, lock: `backup:${b.id}`, adminId: admin?.id || null },
      async ({ log, signal }) => {
        await fetchRemote(b, { log, signal });
        return { backupId: b.id, file: path.basename(b.file) };
      },
    );
  });

  router.get("/api/backups/:id/download", async (req, res, { params, admin }) => {
    const b = getBackup(params.id);
    if (b.status !== "ok") throw httpError(409, "This backup is not complete.");
    const abs = absOf(b.file);
    if (!fs.existsSync(abs))
      throw httpError(410, canFetch(b) ? "The local copy is gone — use “Fetch from SMB share” first, then download." : "The backup file is no longer on disk.");
    const size = fs.statSync(abs).size;
    const name = path.basename(abs).replace(/[^A-Za-z0-9._-]/g, "_");
    audit(admin, "backup.download", { type: "backup", id: b.id, name }, { size });
    res.writeHead(200, {
      "Content-Type": "application/gzip",
      "Content-Length": String(size),
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") return void res.end();
    await pipeline(fs.createReadStream(abs), res).catch(() => res.destroy());
  });

  router.post("/api/backups/:id/restore", async (req, res, { params, body, admin }) => {
    const b = getBackup(params.id);
    if (b.status !== "ok") throw httpError(409, "Only completed backups can be restored.");
    audit(admin, "backup.restore.start", { type: "backup", id: b.id, name: path.basename(b.file || "") }, { kind: b.kind });
    return b.kind === "database" ? restoreDatabase(b, admin) : restoreServer(b, body || {}, admin);
  });

  router.patch("/api/backups/:id", async (req, res, { params, body, admin }) => {
    const b = getBackup(params.id);
    const patch = {};
    if (body && "pinned" in body) patch.pinned = !!body.pinned;
    if (body && "note" in body) patch.note = String(body.note ?? "").slice(0, 500);
    if (!Object.keys(patch).length) return publicView(b);
    const out = update(b.id, patch);
    audit(admin, "backup.update", { type: "backup", id: b.id, name: path.basename(b.file || "") }, patch);
    return publicView(out);
  });

  router.delete("/api/backups/:id", async (req, res, { params, admin }) => {
    const b = await removeBackup(params.id);
    audit(admin, "backup.delete", { type: "backup", id: b.id, name: path.basename(b.file || "") }, { kind: b.kind });
    return { ok: true };
  });
}

// ------------------------------------------------------------ scheduler

export async function start(ctx) {
  const root = path.join(ctx.dataDir, "backups");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  // Anything still "running" was interrupted by a restart.
  for (const b of ctx.db.list("backups", (x) => x.status === "running")) {
    ctx.db.update("backups", b.id, { status: "failed", error: "Interrupted by a panel restart.", finishedAt: new Date().toISOString() });
  }
  // Leftover staging dirs and partial files.
  try {
    for (const f of fs.readdirSync(path.join(ctx.dataDir, "tmp"))) {
      if (f.startsWith("backup-") || f.startsWith("smb-auth-") || f.startsWith("smb-test-")) fs.rmSync(path.join(ctx.dataDir, "tmp", f), { recursive: true, force: true });
    }
  } catch {}
  const sweep = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) sweep(p);
      else if (/\.(part|upload)$/.test(e.name)) fs.rmSync(p, { force: true });
    }
  };
  sweep(root);

  const stateFile = path.join(root, "schedule-state.json");
  const readState = () => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      return {};
    }
  };
  const writeState = (s) => {
    fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(s, null, 2));
    fs.renameSync(`${stateFile}.tmp`, stateFile);
  };

  const running = new Set();

  async function waitJob(job) {
    if (!job?.id) return;
    if (typeof ctx.jobs.wait === "function") {
      await ctx.jobs.wait(job.id).catch(() => {});
      return;
    }
    for (;;) {
      const j = ctx.jobs.get?.(job.id);
      if (!j || ["succeeded", "failed", "cancelled"].includes(j.status)) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async function runKind(kind) {
    const c = ctx.config.backups || {};
    if (kind === "database") {
      for (const d of ctx.db.list("databases")) {
        try {
          await waitJob(ctx.backups.backupDatabase(d.id, { trigger: "schedule" }));
        } catch (e) {
          console.error(`[fcc] scheduled backup of ${d.name} skipped: ${e.message}`);
        }
      }
    } else {
      const ids = Array.isArray(c.server?.serverIds) && c.server.serverIds.length ? c.server.serverIds : [MAIN_ID];
      for (const id of ids) {
        try {
          await waitJob(ctx.backups.backupServer(id, { include: c.server?.include, trigger: "schedule" }));
        } catch (e) {
          console.error(`[fcc] scheduled backup of server ${id} skipped: ${e.message}`);
        }
      }
    }
  }

  function tick() {
    const now = new Date();
    const c = ctx.config.backups || {};
    const state = readState();
    let dirty = false;
    for (const kind of ["database", "server"]) {
      const sched = { ...DEFAULTS[kind], ...(c[kind] || {}) };
      const { run: due, slot, init } = dueCheck(sched, state[kind]?.lastSlot, now);
      if (init) {
        state[kind] = { ...(state[kind] || {}), lastSlot: slot.toISOString() };
        dirty = true;
        continue;
      }
      if (!due || running.has(kind)) continue;
      // Record the slot before starting, so a crash/restart can't run it twice.
      state[kind] = { ...(state[kind] || {}), lastSlot: slot.toISOString(), lastRunAt: now.toISOString() };
      dirty = true;
      running.add(kind);
      runKind(kind)
        .catch((e) => console.error(`[fcc] scheduled ${kind} backups failed:`, e.message))
        .finally(() => running.delete(kind));
    }
    if (dirty) {
      try {
        writeState(state);
      } catch (e) {
        console.error("[fcc] could not write backup schedule state:", e.message);
      }
    }
  }

  // Check at the top of every minute.
  const first = setTimeout(() => {
    tick();
    const iv = setInterval(tick, 60_000);
    iv.unref?.();
  }, 60_000 - (Date.now() % 60_000) + 500);
  first.unref?.();
}
