// Mock backend — only loaded with ?mock=1 (or localStorage fcc.mock=1).
// In-memory fixtures that behave like the real API: mutations stick for the
// session, actions spawn jobs that stream logs over the fake event bus.
import { ApiError } from "./api.js";

const NOW = Date.now();
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const GB = 1024 ** 3, MB = 1024 ** 2;
const iso = (t) => new Date(t).toISOString();
const ago = (ms) => iso(Date.now() - ms);
let seq = 100;
const nid = (p) => `${p}_${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
const clone = (x) => JSON.parse(JSON.stringify(x));

/* ───────── fixtures ───────── */

const me = { id: "adm_1", email: "jordan@forthway.dev", name: "Jordan Reyes", role: "owner", createdAt: iso(NOW - 90 * DAY), lastLoginAt: ago(5 * MIN) };
const db = {
  admins: [me, { id: "adm_2", email: "sam@forthway.dev", name: "Sam Patel", role: "admin", createdAt: iso(NOW - 40 * DAY), lastLoginAt: ago(2 * DAY) }],
  settings: { panelName: "Forthway", panelUrl: "https://panel.forthway.dev", githubTokenSet: true, githubTokenHint: "ghp_••••a91F" },
  servers: [
    { id: "main", name: "fcc-main", role: "main", host: "203.0.113.10", privateHost: "10.0.0.10", weight: 1, enabled: true, lbEligible: true, agentVersion: "3.0.0",
      lastSeenAt: ago(4e3), online: true, info: { hostname: "fcc-main", os: "Ubuntu 24.04 LTS", cpus: 8, memTotal: 16 * GB, diskTotal: 320 * GB }, createdAt: iso(NOW - 90 * DAY),
      metrics: { cpu: 23, mem: 6.2 * GB, memTotal: 16 * GB, disk: 118 * GB, diskTotal: 320 * GB, load: 0.84, uptime: 38 * DAY, at: ago(4e3) } },
    { id: "srv_fra1", name: "fra-agent-1", role: "worker", host: "203.0.113.21", privateHost: "10.0.0.21", weight: 2, enabled: true, lbEligible: true, agentVersion: "3.0.0",
      lastSeenAt: ago(6e3), online: true, info: { hostname: "fra-agent-1", os: "Debian 12", cpus: 4, memTotal: 8 * GB, diskTotal: 160 * GB }, createdAt: iso(NOW - 60 * DAY),
      metrics: { cpu: 31, mem: 3.1 * GB, memTotal: 8 * GB, disk: 61 * GB, diskTotal: 160 * GB, load: 1.12, uptime: 21 * DAY, at: ago(6e3) } },
    { id: "srv_fra2", name: "fra-agent-2", role: "worker", host: "203.0.113.22", privateHost: "10.0.0.22", weight: 1, enabled: true, lbEligible: true, agentVersion: "3.0.0",
      lastSeenAt: ago(3e3), online: true, info: { hostname: "fra-agent-2", os: "Ubuntu 22.04 LTS", cpus: 4, memTotal: 8 * GB, diskTotal: 160 * GB }, createdAt: iso(NOW - 45 * DAY),
      metrics: { cpu: 58, mem: 6.5 * GB, memTotal: 8 * GB, disk: 146 * GB, diskTotal: 160 * GB, load: 2.31, uptime: 9 * DAY, at: ago(3e3) } },
    { id: "srv_nyc1", name: "nyc-agent-1", role: "worker", host: "198.51.100.40", privateHost: null, weight: 1, enabled: true, lbEligible: false, agentVersion: "2.11.0",
      lastSeenAt: ago(3 * HOUR + 12 * MIN), online: false, info: { hostname: "nyc-agent-1", os: "Ubuntu 22.04 LTS", cpus: 2, memTotal: 4 * GB, diskTotal: 80 * GB }, createdAt: iso(NOW - 20 * DAY),
      metrics: { cpu: 12, mem: 1.9 * GB, memTotal: 4 * GB, disk: 31 * GB, diskTotal: 80 * GB, load: 0.2, uptime: 2 * DAY, at: ago(3 * HOUR + 12 * MIN) } },
  ],
  projects: [
    { id: "prj_acme", name: "Acme Storefront", description: "Customer-facing shop, admin console and a staging copy.", color: "blue", createdAt: iso(NOW - 80 * DAY) },
    { id: "prj_north", name: "Northwind API", description: "Public REST API plus the webhooks worker that feeds it.", color: "violet", createdAt: iso(NOW - 70 * DAY) },
    { id: "prj_mkt", name: "Marketing Sites", description: "Landing pages and the company blog.", color: "teal", createdAt: iso(NOW - 50 * DAY) },
    { id: "prj_int", name: "Internal Tools", description: "Status page and back-office bits.", color: "amber", createdAt: iso(NOW - 15 * DAY) },
  ],
  sites: [],
  releases: [],
  databases: [
    { id: "db_acmeprod", projectId: "prj_acme", name: "acme_prod", user: "acme_prod", charset: "utf8mb4", collation: "utf8mb4_unicode_ci", remoteAccess: true, sizeBytes: 1.42 * GB, createdAt: iso(NOW - 80 * DAY) },
    { id: "db_acmestg", projectId: "prj_acme", name: "acme_staging", user: "acme_stg", charset: "utf8mb4", collation: "utf8mb4_unicode_ci", remoteAccess: true, sizeBytes: 221 * MB, createdAt: iso(NOW - 60 * DAY) },
    { id: "db_nw", projectId: "prj_north", name: "northwind", user: "northwind", charset: "utf8mb4", collation: "utf8mb4_unicode_ci", remoteAccess: true, sizeBytes: 640 * MB, createdAt: iso(NOW - 70 * DAY) },
    { id: "db_nwq", projectId: "prj_north", name: "northwind_queue", user: "nw_queue", charset: "utf8mb4", collation: "utf8mb4_unicode_ci", remoteAccess: false, sizeBytes: 38 * MB, createdAt: iso(NOW - 30 * DAY) },
    { id: "db_wp", projectId: "prj_mkt", name: "wp_blog", user: "wp_blog", charset: "utf8mb4", collation: "utf8mb4_unicode_ci", remoteAccess: false, sizeBytes: 96 * MB, createdAt: iso(NOW - 50 * DAY) },
  ],
  backups: [],
  jobs: [],
  logs: {},
  activity: [],
  backupSettings: {
    database: { enabled: true, every: "daily", at: "03:00", keep: 14 },
    server: { enabled: true, every: "weekly", at: "04:00", keep: 4, include: { panel: true, sites: true, nginx: true, databases: false } },
    destination: { type: "local", path: "/var/lib/fcc/backups" },
  },
  lb: { installed: true, version: "1.24.0", configOk: true, lastAppliedAt: ago(2 * HOUR), lastError: null },
  mysql: { installed: true, running: true, version: "8.0.39", flavor: "mysql", authMode: "socket", bindAddress: "0.0.0.0", rootOk: true, error: null },
};

function mkSite(o) {
  const s = {
    type: "node", port: 3000, healthPath: "/api/health", loadBalanced: false, serverIds: ["main"], lbMethod: "round_robin",
    settings: { build: { install: "npm ci --no-audit --no-fund", prepare: "", build: "npm run build", artifact: "" }, restart: { mode: "pm2", start: "npm start" }, autoRollback: true, smartInstall: true, healthTimeoutMs: 180000 },
    github: null, env: {}, linkedDatabaseIds: [], ssl: { enabled: false, status: "none" }, state: {}, createdAt: iso(NOW - 40 * DAY), ...o,
  };
  s.appDir = s.appDir || `/srv/fcc/sites/${slug(projectName(s.projectId))}/${s.name}`;
  db.sites.push(s);
  return s;
}
const slug = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const projectName = (id) => db.projects.find((p) => p.id === id)?.name || "project";

mkSite({ id: "site_acmeweb", projectId: "prj_acme", name: "acme-web", domains: ["acme.com", "www.acme.com"], port: 3001, loadBalanced: true, serverIds: ["main", "srv_fra1", "srv_fra2"], lbMethod: "least_conn",
  github: { repo: "acme/storefront", branch: "main" }, linkedDatabaseIds: ["db_acmeprod"], env: { NODE_ENV: "production", STRIPE_PUBLIC_KEY: "pk_live_51Hx…", SESSION_SECRET: "c0ffee-8f2a-4b11", NEXT_PUBLIC_SITE_URL: "https://acme.com" },
  ssl: { enabled: true, status: "active", issuedAt: ago(32 * DAY), expiresAt: iso(NOW + 58 * DAY) } });
mkSite({ id: "site_acmeadmin", projectId: "prj_acme", name: "acme-admin", domains: ["admin.acme.com"], port: 3002, serverIds: ["main"], github: { repo: "acme/admin-console", branch: "main" }, linkedDatabaseIds: ["db_acmeprod"],
  env: { NODE_ENV: "production", ADMIN_SSO_DOMAIN: "acme.com" }, ssl: { enabled: true, status: "active", issuedAt: ago(32 * DAY), expiresAt: iso(NOW + 58 * DAY) } });
mkSite({ id: "site_acmestg", projectId: "prj_acme", name: "acme-staging", domains: ["staging.acme.com"], port: 3003, serverIds: ["srv_fra1"], github: { repo: "acme/storefront", branch: "develop" }, linkedDatabaseIds: ["db_acmestg"],
  env: { NODE_ENV: "staging" }, ssl: { enabled: false, status: "none" } });
mkSite({ id: "site_nwapi", projectId: "prj_north", name: "northwind-api", domains: ["api.northwind.io"], port: 3004, loadBalanced: true, serverIds: ["srv_fra1", "srv_fra2"], lbMethod: "round_robin",
  github: { repo: "northwind/api", branch: "main" }, linkedDatabaseIds: ["db_nw"], env: { NODE_ENV: "production", RATE_LIMIT: "600" }, ssl: { enabled: true, status: "active", issuedAt: ago(10 * DAY), expiresAt: iso(NOW + 80 * DAY) } });
mkSite({ id: "site_nwhooks", projectId: "prj_north", name: "webhooks-worker", domains: ["hooks.northwind.io"], port: 3005, serverIds: ["main"], github: { repo: "northwind/webhooks", branch: "main" }, linkedDatabaseIds: ["db_nw", "db_nwq"],
  env: { QUEUE_CONCURRENCY: "8" }, ssl: { enabled: true, status: "active", issuedAt: ago(10 * DAY), expiresAt: iso(NOW + 80 * DAY) } });
mkSite({ id: "site_landing", projectId: "prj_mkt", name: "landing", type: "static", domains: ["forthway.dev", "www.forthway.dev"], port: 3006, serverIds: ["srv_fra2"], healthPath: "/",
  settings: { build: { install: "npm ci", build: "npm run build", artifact: "dist" } }, github: { repo: "forthway/landing", branch: "main" }, ssl: { enabled: true, status: "active", issuedAt: ago(70 * DAY), expiresAt: iso(NOW + 20 * DAY) } });
mkSite({ id: "site_blog", projectId: "prj_mkt", name: "blog", type: "php", domains: ["blog.forthway.dev"], port: 3007, serverIds: ["main"], healthPath: "/", linkedDatabaseIds: ["db_wp"], settings: { build: { install: "", build: "" } },
  ssl: { enabled: true, status: "active", issuedAt: ago(70 * DAY), expiresAt: iso(NOW + 20 * DAY) } });
mkSite({ id: "site_status", projectId: "prj_int", name: "status-page", type: "static", domains: ["status.forthway.dev"], port: 3008, serverIds: ["srv_nyc1"], healthPath: "/",
  github: { repo: "forthway/status", branch: "main" }, ssl: { enabled: false, status: "failed", error: "DNS for status.forthway.dev does not point at this server." } });

// Releases
const SRC_VERS = { site_acmeweb: ["2.14.0", "2.13.2", "2.13.1", "2.13.0", "2.12.4"], site_acmeadmin: ["1.6.3", "1.6.2", "1.6.0"], site_acmestg: ["2.15.0-rc.2", "2.15.0-rc.1"], site_nwapi: ["4.2.1", "4.2.0", "4.1.9", "4.1.8"],
  site_nwhooks: ["1.3.0", "1.2.7"], site_landing: ["2026.10.02", "2026.09.27", "2026.09.14"], site_blog: ["6.6.2"], site_status: ["1.0.4", "1.0.3"] };
for (const s of db.sites) {
  const vers = SRC_VERS[s.id] || ["1.0.0"];
  vers.forEach((v, i) => {
    const r = { id: nid("rel"), siteId: s.id, filename: `${s.name}-${v}.zip`, size: Math.round((s.type === "node" ? 18 : 4) * MB * (0.8 + Math.random() * 0.5)), sha256: hex(64), version: v, commit: s.github ? hex(7) : null,
      source: s.github && i !== 1 ? "github" : "upload", pinned: i === vers.length - 1 && vers.length > 2, createdAt: ago((i * 2.3 + 0.2) * DAY + Math.random() * 4 * HOUR) };
    db.releases.push(r);
    if (i === 0) s.currentReleaseId = r.id;
    if (i === 1) s.previousReleaseId = r.id;
  });
  const cur = db.releases.find((r) => r.id === s.currentReleaseId);
  for (const sid of targets(s)) {
    const srv = db.servers.find((x) => x.id === sid);
    s.state[sid] = srv?.online
      ? { running: true, healthy: !(s.id === "site_nwapi" && sid === "srv_fra2" && false), version: cur?.version, checkedAt: ago(30e3), pid: 2000 + Math.floor(Math.random() * 8000) }
      : { running: false, healthy: false, version: cur?.version, checkedAt: srv?.lastSeenAt, error: "Server offline — last seen " + "3h ago" };
  }
}
function busy(s) {
  const j = db.jobs.find((x) => x.siteId === s.id && (x.status === "running" || x.status === "queued"));
  if (j) err(409, `${s.name} is busy: “${j.title}” is still running.`, { jobId: j.id });
}
function targets(s) { return s.loadBalanced ? s.serverIds : [s.serverIds[0] || "main"]; }

// Backups
for (const d of db.databases) {
  for (let i = 0; i < 5; i++) {
    db.backups.push({ id: nid("bak"), kind: "database", projectId: d.projectId, databaseId: d.id, file: `${d.name}-${iso(NOW - i * DAY).slice(0, 10)}.sql.gz`, size: Math.round(d.sizeBytes * 0.18 * (1 - i * 0.02)),
      sha256: hex(64), status: d.id === "db_nwq" && i === 1 ? "failed" : "ok", error: d.id === "db_nwq" && i === 1 ? "mysqldump: Got error 2013: Lost connection to MySQL server during query" : null,
      trigger: i === 0 && d.id === "db_acmeprod" ? "manual" : "schedule", pinned: i === 4 && d.id === "db_acmeprod", note: i === 4 && d.id === "db_acmeprod" ? "Before 2.0 migration" : "", createdAt: iso(NOW - i * DAY - 3 * HOUR - 12 * MIN) });
  }
}
[["main", 0, true], ["main", 7, false], ["main", 14, false], ["srv_fra1", 2, false], ["srv_fra2", 9, false]].forEach(([sid, d, pin], i) => {
  const srv = db.servers.find((x) => x.id === sid);
  db.backups.push({ id: nid("bak"), kind: "server", serverId: sid, include: { panel: sid === "main", sites: true, nginx: true, databases: sid === "main" && i === 0 },
    file: `server-${srv.name}-${iso(NOW - d * DAY).slice(0, 10)}.tar.gz`, size: Math.round((sid === "main" ? 3.4 : 1.1) * GB * (1 - d * 0.01)), sha256: hex(64),
    status: i === 4 ? "failed" : "ok", error: i === 4 ? "Agent disconnected during upload (connection reset)" : null, trigger: i === 0 ? "manual" : "schedule", pinned: pin, note: pin ? "Pre-upgrade snapshot" : "", createdAt: iso(NOW - d * DAY - 4 * HOUR) });
});

// Jobs + activity
const jobSeed = [
  ["site.deploy", "Deploy acme-web 2.14.0", "site_acmeweb", "prj_acme", "succeeded", 38 * MIN, 94e3],
  ["backup.database", "Back up acme_prod", null, "prj_acme", "succeeded", 3 * HOUR, 41e3, { databaseId: "db_acmeprod" }],
  ["site.deploy", "Deploy northwind-api 4.2.1", "site_nwapi", "prj_north", "succeeded", 5 * HOUR, 72e3],
  ["site.ssl", "Issue certificate for status.forthway.dev", "site_status", "prj_int", "failed", 7 * HOUR, 12e3, { error: "DNS for status.forthway.dev does not point at this server." }],
  ["site.restart", "Restart webhooks-worker", "site_nwhooks", "prj_north", "succeeded", 26 * HOUR, 6e3],
  ["site.deploy", "Deploy landing 2026.10.02", "site_landing", "prj_mkt", "succeeded", 2 * DAY, 51e3],
  ["backup.server", "Back up fcc-main", null, null, "succeeded", 2.2 * DAY, 210e3, { serverId: "main" }],
  ["site.deploy", "Deploy acme-staging 2.15.0-rc.2", "site_acmestg", "prj_acme", "failed", 2.5 * DAY, 48e3, { error: "Health check failed: GET /api/health returned 502 after 180s — rolled back to 2.15.0-rc.1" }],
];
for (const [type, title, siteId, projectId, status, at, dur, extra] of jobSeed) {
  const id = nid("job");
  db.jobs.push({ id, type, title, status, siteId, projectId, serverId: extra?.serverId || null, databaseId: extra?.databaseId || null, adminId: "adm_1",
    startedAt: ago(at), finishedAt: ago(at - dur), error: extra?.error || null, result: null });
  db.logs[id] = linesFor(type, title, status === "failed" ? extra?.error : null);
}
const actSeed = [
  [12 * MIN, "adm_1", "site.deploy", "site", "site_acmeweb", "acme-web", "Release 2.14.0 to 3 servers"],
  [40 * MIN, "adm_1", "site.update", "site", "site_acmeweb", "acme-web", "Load balancing method → least_conn"],
  [3 * HOUR, "adm_2", "database.credentials", "database", "db_acmeprod", "acme_prod", "Revealed credentials"],
  [5 * HOUR, "adm_2", "site.deploy", "site", "site_nwapi", "northwind-api", "Release 4.2.1 to 2 servers"],
  [7 * HOUR, "adm_1", "site.ssl", "site", "site_status", "status-page", "Certificate request failed"],
  [26 * HOUR, "adm_2", "site.restart", "site", "site_nwhooks", "webhooks-worker", null],
  [2 * DAY, "adm_1", "server.update", "server", "srv_fra2", "fra-agent-2", "Weight 2 → 1"],
  [2.2 * DAY, "adm_1", "backup.create", "server", "main", "fcc-main", "Manual server backup"],
  [3 * DAY, "adm_1", "database.create", "database", "db_nwq", "northwind_queue", null],
  [4 * DAY, "adm_1", "server.add", "server", "srv_nyc1", "nyc-agent-1", null],
  [6 * DAY, "adm_2", "admin.login", "admin", "adm_2", "Sam Patel", null],
  [9 * DAY, "adm_1", "project.create", "project", "prj_int", "Internal Tools", null],
];
for (const [at, adminId, action, type, id, name, details] of actSeed) {
  db.activity.push({ id: nid("act"), at: ago(at), adminId, adminName: db.admins.find((a) => a.id === adminId).name, action, target: { type, id, name }, details,
    projectId: type === "site" ? db.sites.find((s) => s.id === id)?.projectId : type === "database" ? db.databases.find((d) => d.id === id)?.projectId : type === "project" ? id : null });
}

function linesFor(type, title, error) {
  const t = (s) => `[${new Date().toISOString().slice(11, 19)}] ${s}`;
  let L;
  if (type === "site.deploy") L = ["▸ Preparing release", "  release archive verified (sha256 ok)", "▸ Extracting to staging directory", "  1,284 files, 46.2 MB", "▸ npm ci --no-audit --no-fund", "  added 612 packages in 21s",
    "▸ npm run build", "  ✓ Compiled successfully", "  ✓ Generating static pages (34/34)", "▸ Writing .env (14 keys, 6 from linked database)", "▸ Swapping directories", "▸ Restarting app (pm2)", "▸ Waiting for health check GET /api/health", "  200 OK in 1.8s", "✓ Live on this server"];
  else if (type.startsWith("backup")) L = ["▸ Starting backup", "  mysqldump --single-transaction --routines --triggers", "  dumping 48 tables", "▸ Compressing (gzip -6)", "  wrote 254.3 MB", "▸ Verifying checksum", "✓ Backup complete"];
  else if (type === "site.ssl") L = ["▸ Requesting certificate via certbot --nginx", "  Domains: " + title.split("for ").pop(), "  Performing http-01 challenge"];
  else if (type === "lb.apply") L = ["▸ Rendering upstreams for 8 websites", "▸ nginx -t", "  syntax is ok", "  test is successful", "▸ nginx -s reload", "✓ Load balancer applied"];
  else L = ["▸ " + title, "  sending signal", "  process online", "✓ Done"];
  if (error) L.push("✗ " + error);
  return L.map(t);
}

/* ───────── event bus ───────── */
const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(type, data) { setTimeout(() => listeners.forEach((f) => f(type, clone(data))), 0); }

// metrics heartbeat
setInterval(() => {
  for (const s of db.servers) {
    if (!s.online) continue;
    const m = s.metrics;
    m.cpu = Math.max(3, Math.min(97, m.cpu + (Math.random() - 0.5) * 10));
    m.mem = Math.max(0.2 * m.memTotal, Math.min(0.97 * m.memTotal, m.mem + (Math.random() - 0.5) * 0.08 * GB));
    m.load = Math.max(0.05, +(m.load + (Math.random() - 0.5) * 0.3).toFixed(2));
    m.at = iso(Date.now()); s.lastSeenAt = m.at;
    emit("server", serverView(s));
  }
}, 5000);

/* ───────── jobs ───────── */
function runJob(meta, { lines, fail, onDone, speed = 260 } = {}) {
  const job = { id: nid("job"), status: "queued", siteId: null, projectId: null, serverId: null, databaseId: null, adminId: me.id, startedAt: iso(Date.now()), finishedAt: null, error: null, result: null, ...meta };
  db.jobs.unshift(job);
  db.logs[job.id] = [];
  emit("job", job);
  const L = lines || linesFor(job.type, job.title, fail);
  let i = 0;
  setTimeout(() => {
    job.status = "running"; emit("job", job);
    const tick = setInterval(() => {
      if (job.status === "cancelled") { clearInterval(tick); return; }
      const batch = L.slice(i, i + 1 + Math.floor(Math.random() * 2)).map((l) => l.startsWith("[") ? l : `[${new Date().toISOString().slice(11, 19)}] ${l}`);
      i += batch.length;
      db.logs[job.id].push(...batch);
      emit("job.log", { id: job.id, lines: batch });
      if (i >= L.length) {
        clearInterval(tick);
        job.status = fail ? "failed" : "succeeded";
        job.error = fail || null;
        job.finishedAt = iso(Date.now());
        if (!fail) { try { job.result = onDone?.(job) ?? null; } catch (e) { console.error(e); } }
        emit("job", job);
      }
    }, speed);
  }, 500);
  return job;
}

function activity(action, type, target, details) {
  const a = { id: nid("act"), at: iso(Date.now()), adminId: me.id, adminName: me.name, action, target: { type, id: target?.id, name: target?.name }, details: details || null,
    projectId: target?.projectId || (type === "project" ? target?.id : null) };
  db.activity.unshift(a);
  emit("activity", a);
}

/* ───────── views ───────── */
function serverView(s) {
  return { ...clone(s), siteCount: db.sites.filter((x) => targets(x).includes(s.id)).length };
}
function lbSummary(s) { return { loadBalanced: !!s.loadBalanced, servers: targets(s).length, method: s.lbMethod }; }
function upstreams(s) {
  return targets(s).map((sid) => {
    const srv = db.servers.find((x) => x.id === sid);
    return { serverId: sid, name: srv?.name || sid, address: sid === "main" ? "127.0.0.1" : srv?.privateHost || srv?.host, port: s.port, weight: srv?.weight || 1, online: !!srv?.online, healthy: !!s.state?.[sid]?.healthy };
  });
}
function siteView(s) { const bj = db.jobs.find((x) => x.siteId === s.id && (x.status === "running" || x.status === "queued")); return { ...clone(s), busyJobId: bj?.id || null, envCount: Object.keys(s.env || {}).length, currentVersion: db.releases.find((r) => r.id === s.currentReleaseId)?.version || null, lb: lbSummary(s), currentRelease: clone(db.releases.find((r) => r.id === s.currentReleaseId) || null) }; }
function projectCounts(p) {
  const sites = db.sites.filter((s) => s.projectId === p.id);
  return { sites: sites.length, sitesLoadBalanced: sites.filter((s) => s.loadBalanced).length, databases: db.databases.filter((d) => d.projectId === p.id).length,
    backups: db.backups.filter((b) => b.projectId === p.id).length };
}
function projectView(p) { return { ...clone(p), counts: projectCounts(p) }; }
function dbView(d) {
  const last = db.backups.filter((b) => b.databaseId === d.id && b.status === "ok").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  return { ...clone(d), lastBackup: last ? { id: last.id, createdAt: last.createdAt, size: last.size } : null, linkedSites: db.sites.filter((s) => s.linkedDatabaseIds.includes(d.id)).map((s) => ({ id: s.id, name: s.name })) };
}

// Deterministic-ish wavy series
function series(range, kind) {
  const conf = { "1h": [60, MIN], "24h": [48, 30 * MIN], "7d": [84, 2 * HOUR], "30d": [60, 12 * HOUR] }[range] || [48, 30 * MIN];
  const [n, step] = conf;
  const end = Math.floor(Date.now() / step) * step;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = end - (n - 1 - i) * step;
    const h = new Date(t).getHours() + new Date(t).getMinutes() / 60;
    const diurnal = 0.55 + 0.45 * Math.sin(((h - 8) / 24) * Math.PI * 2);
    const wob = Math.sin(i / 3.1) * 0.12 + Math.sin(i / 7.7 + 1) * 0.18 + Math.sin(i * 1.7) * 0.04;
    if (kind === "requests") out.push({ t: iso(t), count: Math.round((range === "1h" ? 380 : range === "24h" ? 9800 : 19000) * Math.max(0.12, diurnal + wob)) });
    else out.push({ t: iso(t), value: Math.round(Math.max(4, Math.min(92, 28 + 26 * (diurnal - 0.5) + wob * 40)) * 10) / 10 });
  }
  return out;
}

/* ───────── routing ───────── */
const routes = [];
const R = (method, pattern, fn) => {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, re, keys, fn });
};
const err = (status, msg, body) => { throw new ApiError(status, msg, { error: msg, ...(body || {}) }); };
const find = (coll, id) => db[coll].find((x) => x.id === id) || err(404, "Not found");

// core
R("GET", "/api/setup", () => ({ needsSetup: false, version: "3.0.0", hostname: "fcc-main" }));
R("POST", "/api/setup", (p, b) => ({ ok: true, admin: { ...me, name: b.name || me.name } }));
R("POST", "/api/login", (p, b) => {
  if (!b.email || !b.password) err(400, "Email and password are required.");
  if (b.password === "wrong") err(401, "Wrong email or password.");
  return { ok: true, admin: me };
});
R("POST", "/api/logout", () => ({ ok: true }));
R("GET", "/api/auth", () => ({ githubOnly: false, githubConfigured: true, github: { clientId: "Ov23liMockClient", clientSecretSet: true, clientSecretHint: "••••9f2c", org: "" },
  callbackUrl: "https://panel.forthway.dev/auth/github/callback", homepageUrl: "https://panel.forthway.dev", panelUrlFixed: true, newAppUrl: "https://github.com/settings/applications/new",
  admins: clone(db.admins), unlinked: db.admins.filter((a) => !a.github).map((a) => a.name), canSwitch: false, blockers: ["Link your own GitHub account."], switchedAt: null }));
R("GET", "/api/me", () => clone(me));
R("PATCH", "/api/me", (p, b) => { Object.assign(me, pick(b, ["name", "email"])); activity("admin.update", "admin", me); return clone(me); });
R("POST", "/api/me/password", (p, b) => { if (!b.current) err(400, "Current password is required."); if ((b.next || "").length < 10) err(400, "New password must be at least 10 characters."); return { ok: true }; });
R("GET", "/api/admins", () => ({ items: clone(db.admins) }));
R("POST", "/api/admins", (p, b) => {
  if (db.admins.some((a) => a.email === b.email)) err(409, "An admin with that email already exists.");
  const a = { id: nid("adm"), name: b.name, email: b.email, role: "admin", createdAt: iso(Date.now()), lastLoginAt: null };
  db.admins.push(a); activity("admin.create", "admin", a); return a;
});
R("PATCH", "/api/admins/:id", (p, b) => Object.assign(find("admins", p.id), pick(b, ["name", "email"])));
R("DELETE", "/api/admins/:id", (p) => {
  const a = find("admins", p.id);
  if (a.role === "owner") err(409, "The owner can't be removed.");
  if (a.id === me.id) err(409, "You can't remove yourself.");
  db.admins = db.admins.filter((x) => x.id !== p.id); activity("admin.delete", "admin", a); return { ok: true };
});
R("GET", "/api/projects", () => ({ items: db.projects.map(projectView) }));
R("POST", "/api/projects", (p, b) => {
  if (!b.name) err(400, "Name is required.");
  const pr = { id: nid("prj"), name: b.name, description: b.description || "", color: b.color || "blue", createdAt: iso(Date.now()) };
  db.projects.push(pr); activity("project.create", "project", pr); emit("project", projectView(pr)); return projectView(pr);
});
R("GET", "/api/projects/:id", (p) => projectView(find("projects", p.id)));
R("PATCH", "/api/projects/:id", (p, b) => { const pr = Object.assign(find("projects", p.id), pick(b, ["name", "description", "color"])); activity("project.update", "project", pr); emit("project", projectView(pr)); return projectView(pr); });
R("DELETE", "/api/projects/:id", (p) => {
  const pr = find("projects", p.id); const c = projectCounts(pr);
  if (c.sites || c.databases) err(409, `This project still has ${c.sites} website(s) and ${c.databases} database(s). Delete those first.`);
  db.projects = db.projects.filter((x) => x.id !== p.id); activity("project.delete", "project", pr); emit("project", { id: p.id, deleted: true }); return { ok: true };
});
R("GET", "/api/dashboard", (p, b, q) => {
  const on = db.servers.filter((s) => s.online).length;
  return {
    admin: clone(me),
    counts: { projects: db.projects.length, sites: db.sites.length, sitesLoadBalanced: db.sites.filter((s) => s.loadBalanced).length, databases: db.databases.length,
      servers: db.servers.length, serversOnline: on, backups: db.backups.length, backupsSize: db.backups.reduce((a, b) => a + (b.size || 0), 0) },
    series: { requests: series(q.range || "24h", "requests"), cpu: series(q.range || "24h", "cpu") },
    recentJobs: clone(db.jobs.slice(0, 7)), recentActivity: clone(db.activity.slice(0, 8)),
    health: { nginx: { ...db.lb, running: true }, mysql: clone(db.mysql) },
  };
});
R("GET", "/api/analytics", (p, b, q) => { // ANALYTICS (panel/lib/analytics.mjs)
  const range = ["1h", "24h", "7d", "30d"].includes(q.range) ? q.range : "24h";
  const [n, step] = { "1h": [60, MIN], "24h": [24, HOUR], "7d": [168, HOUR], "30d": [30, 24 * HOUR] }[range];
  const scale = (q.siteId ? 0.3 : 1) * (step / HOUR);
  const to = Math.floor(Date.now() / step) * step, from = to - (n - 1) * step;
  const row = (t, k = 1) => { const h = new Date(t).getUTCHours(), d = 0.55 + 0.45 * Math.sin(((h - 8) / 24) * Math.PI * 2) + Math.sin(t / 7e6) * 0.1; const u = Math.round(140 * scale * k * Math.max(0.1, d)); return { t, uniques: u, pageViews: Math.round(u * 2.6), requests: Math.round(u * 31) }; };
  const series = Array.from({ length: n }, (_, i) => row(from + i * step));
  const previousSeries = series.map((s) => ({ ...row(s.t - n * step, 0.9), t: s.t }));
  const sum = (a, k) => a.reduce((x, y) => x + y[k], 0);
  const tot = (a) => ({ requests: sum(a, "requests"), pageViews: sum(a, "pageViews"), uniques: Math.round(sum(a, "uniques") * (range === "7d" || range === "30d" ? 1 : 0.7)) });
  const totals = tot(series), previous = tot(previousSeries);
  const change = Object.fromEntries(Object.keys(totals).map((k) => [k, Math.round(((totals[k] - previous[k]) / previous[k]) * 1000) / 10]));
  return { range, step, from, to, now: Date.now(), siteId: q.siteId || null, since: iso(Date.now() - 40 * 864e5), visitorsSince: iso(Date.now() - 40 * 864e5), uniquesMethod: range === "7d" || range === "30d" ? "daily-sum" : "exact",
    series, previousSeries, totals, previous, change,
    ...(q.siteId ? { topPages: ["/", "/pricing", "/blog", "/blog/launch-week", "/docs", "/about", "/contact"].map((path, i) => ({ path, views: Math.round(totals.pageViews / (i + 2.2)) })),
      topReferrers: ["www.google.com", "news.ycombinator.com", "github.com", "t.co", "duckduckgo.com"].map((host, i) => ({ host, visits: Math.round(totals.uniques / (i + 3)) })) }
      : { topSites: db.sites.slice(0, 5).map((s, i) => ({ siteId: s.id, name: s.name, uniques: Math.round(totals.uniques / (i + 1.5)), pageViews: Math.round(totals.pageViews / (i + 1.5)), requests: Math.round(totals.requests / (i + 1.5)) })) }) };
});
R("GET", "/api/settings", () => clone(db.settings));
R("PATCH", "/api/settings", (p, b) => {
  if ("githubToken" in b) { db.settings.githubTokenSet = !!b.githubToken; db.settings.githubTokenHint = b.githubToken ? b.githubToken.slice(0, 4) + "••••" + b.githubToken.slice(-4) : null; }
  Object.assign(db.settings, pick(b, ["panelName", "panelUrl"])); activity("settings.update", "settings", { id: "settings", name: "Panel settings" }); return clone(db.settings);
});
R("GET", "/api/jobs", (p, b, q) => {
  let items = db.jobs;
  for (const k of ["siteId", "projectId", "serverId", "databaseId"]) if (q[k]) items = items.filter((j) => j[k] === q[k]);
  return { items: clone(items.slice(0, Number(q.limit) || 50)) };
});
R("GET", "/api/jobs/:id", (p) => clone(find("jobs", p.id)));
R("POST", "/api/jobs/:id/cancel", (p) => { const j = find("jobs", p.id); if (j.status === "running" || j.status === "queued") { j.status = "cancelled"; j.finishedAt = iso(Date.now()); emit("job", j); } return clone(j); });
R("GET", "/api/activity", (p, b, q) => {
  let items = db.activity;
  if (q.projectId) items = items.filter((a) => a.projectId === q.projectId);
  return { items: clone(items.slice(0, Number(q.limit) || 100)) };
});

// sites
R("GET", "/api/sites", (p, b, q) => ({ items: db.sites.filter((s) => !q.projectId || s.projectId === q.projectId).map(siteView) }));
R("POST", "/api/projects/:projectId/sites", (p, b) => {
  find("projects", p.projectId);
  if (!b.name) err(400, "Name is required.");
  if (db.sites.some((s) => s.name === b.name && s.projectId === p.projectId)) err(409, "A website with that name already exists in this project.");
  if (b.loadBalanced && (b.serverIds || []).length < 2) err(400, "Load balancing needs at least 2 servers.");
  const s = mkSite({ id: nid("site"), projectId: p.projectId, name: b.name, type: b.type || "node", domains: b.domains || [], port: 3001 + db.sites.length + 8,
    loadBalanced: !!b.loadBalanced, serverIds: b.serverIds?.length ? b.serverIds : ["main"], lbMethod: b.lbMethod || "round_robin", github: b.github || null, env: b.env || {},
    linkedDatabaseIds: b.linkedDatabaseIds || [], settings: { ...(b.settings || {}) }, createdAt: iso(Date.now()), currentReleaseId: null, previousReleaseId: null, state: {} });
  activity("site.create", "site", s, s.loadBalanced ? `Load balanced on ${s.serverIds.length} servers` : `Single server`);
  emit("site", siteView(s));
  return siteView(s);
});
R("GET", "/api/sites/:id", (p) => {
  const s = find("sites", p.id);
  return { ...siteView(s), upstreams: upstreams(s), releases: clone(db.releases.filter((r) => r.siteId === s.id).slice(0, 20)) };
});
R("PATCH", "/api/sites/:id", (p, b) => {
  const s = find("sites", p.id);
  if (b.loadBalanced && (b.serverIds || s.serverIds).length < 2) err(400, "Load balancing needs at least 2 servers.");
  Object.assign(s, pick(b, ["name", "type", "domains", "loadBalanced", "serverIds", "lbMethod", "healthPath", "port", "github", "linkedDatabaseIds"]));
  if (b.settings) s.settings = { ...s.settings, ...b.settings, build: { ...(s.settings.build || {}), ...(b.settings.build || {}) }, restart: { ...(s.settings.restart || {}), ...(b.settings.restart || {}) } };
  for (const sid of targets(s)) if (!s.state[sid]) { const srv = db.servers.find((x) => x.id === sid); s.state[sid] = { running: !!srv?.online, healthy: !!srv?.online, version: db.releases.find((r) => r.id === s.currentReleaseId)?.version, checkedAt: iso(Date.now()) }; }
  activity("site.update", "site", s); emit("site", siteView(s));
  return { ...siteView(s), upstreams: upstreams(s) };
});
R("DELETE", "/api/sites/:id", (p) => { const s = find("sites", p.id); db.sites = db.sites.filter((x) => x.id !== p.id); activity("site.delete", "site", s); emit("site", { id: s.id, deleted: true }); return { ok: true }; });
R("POST", "/api/sites/:id/deploy", (p, b) => {
  const s = find("sites", p.id);
  busy(s);
  const rel = b.releaseId ? find("releases", b.releaseId) : db.releases.find((r) => r.id === s.currentReleaseId) || db.releases.find((r) => r.siteId === s.id);
  if (!rel) err(409, "Upload a release or pull from GitHub first.");
  const tg = targets(s);
  const lines = tg.flatMap((sid, i) => [`━━ ${db.servers.find((x) => x.id === sid)?.name || sid} (${i + 1}/${tg.length}) ━━`, ...linesFor("site.deploy", "").map((l) => l.replace(/^\[[^\]]+\] /, ""))]);
  activity("site.deploy", "site", s, `Release ${rel.version} to ${tg.length} server${tg.length > 1 ? "s" : ""}`);
  return runJob({ type: "site.deploy", title: `Deploy ${s.name} ${rel.version}`, siteId: s.id, projectId: s.projectId }, { lines, speed: 160, onDone() {
    if (s.currentReleaseId !== rel.id) { s.previousReleaseId = s.currentReleaseId; s.currentReleaseId = rel.id; }
    for (const sid of tg) s.state[sid] = { running: true, healthy: db.servers.find((x) => x.id === sid)?.online, version: rel.version, checkedAt: iso(Date.now()) };
    emit("site", siteView(s));
  } });
});
for (const act of ["restart", "stop", "start", "rollback"]) {
  R("POST", `/api/sites/:id/${act}`, (p) => {
    const s = find("sites", p.id);
    busy(s);
    if (act === "rollback" && !s.previousReleaseId) err(409, "There's no previous release to roll back to.");
    activity("site." + act, "site", s);
    const verb = { restart: "Restart", stop: "Stop", start: "Start", rollback: "Roll back" }[act];
    return runJob({ type: "site." + act, title: `${verb} ${s.name}`, siteId: s.id, projectId: s.projectId }, { onDone() {
      if (act === "rollback") { const c = s.currentReleaseId; s.currentReleaseId = s.previousReleaseId; s.previousReleaseId = c; }
      const ver = db.releases.find((r) => r.id === s.currentReleaseId)?.version;
      for (const sid of targets(s)) s.state[sid] = { ...s.state[sid], running: act !== "stop", healthy: act !== "stop" && db.servers.find((x) => x.id === sid)?.online, version: ver, checkedAt: iso(Date.now()) };
      emit("site", siteView(s));
    } });
  });
}
R("GET", "/api/sites/:id/status", (p) => {
  const s = find("sites", p.id);
  for (const sid of Object.keys(s.state)) s.state[sid].checkedAt = db.servers.find((x) => x.id === sid)?.online ? iso(Date.now()) : s.state[sid].checkedAt;
  return clone(s.state);
});
R("GET", "/api/sites/:id/logs", (p, b, q) => {
  const s = find("sites", p.id);
  const srv = db.servers.find((x) => x.id === (q.serverId || targets(s)[0]));
  if (!srv?.online) err(503, `${srv?.name || "Server"} is offline — logs unavailable.`);
  const lines = [];
  const n = Math.min(Number(q.lines) || 200, 400);
  const paths = ["/", "/products", "/api/cart", "/api/health", "/checkout", "/api/session", "/search?q=chair"];
  for (let i = n; i > 0; i--) {
    const t = new Date(Date.now() - i * 7000).toISOString();
    const r = Math.random();
    if (r < 0.04) lines.push(`${t} WARN  slow query 812ms: SELECT * FROM orders WHERE customer_id = ?`);
    else if (r < 0.055) lines.push(`${t} ERROR upstream timeout calling payments service (attempt 1/3)`);
    else lines.push(`${t} INFO  ${["GET", "GET", "GET", "POST"][i % 4]} ${paths[i % paths.length]} ${r < 0.9 ? 200 : 304} ${Math.round(4 + Math.random() * 90)}ms`);
  }
  return { text: `== ${s.name} on ${srv.name} (pm2: fcc-${s.name}) ==\n` + lines.join("\n") };
});
R("GET", "/api/sites/:id/env", (p) => {
  const s = find("sites", p.id);
  return { env: clone(s.env), linked: s.linkedDatabaseIds.map((id) => db.databases.find((d) => d.id === id)).filter(Boolean).map((d) => ({ databaseId: d.id, name: d.name,
    vars: { DB_HOST: "127.0.0.1", DB_PORT: "3306", DB_NAME: d.name, DB_USER: d.user, DB_PASSWORD: "••••••••", DATABASE_URL: `mysql://${d.user}:••••@127.0.0.1:3306/${d.name}` } })) };
});
R("PUT", "/api/sites/:id/env", (p, b) => { const s = find("sites", p.id); s.env = b.env || {}; activity("site.env", "site", s, `${Object.keys(s.env).length} variables`); return { env: clone(s.env) }; });
R("GET", "/api/sites/:id/releases", (p) => ({ items: clone(db.releases.filter((r) => r.siteId === p.id)) }));
R("POST", "/api/sites/:id/releases/upload", (p, b, q) => {
  const s = find("sites", p.id);
  const r = { id: nid("rel"), siteId: s.id, filename: q.filename || b?.name || "upload.zip", size: b?.size || 12 * MB, sha256: hex(64), version: (q.filename || "upload").replace(/\.zip$/, "").split("-").pop() || "upload", commit: null, source: "upload", pinned: false, createdAt: iso(Date.now()) };
  db.releases.unshift(r); activity("release.upload", "site", s, r.filename); emit("site", siteView(s)); return r;
});
R("POST", "/api/sites/:id/releases/github", (p, b) => {
  const s = find("sites", p.id);
  if (!s.github?.repo) err(400, "Set a GitHub repository in Settings first.");
  const ref = b.ref || s.github.branch || "main";
  return runJob({ type: "release.github", title: `Pull ${s.github.repo}@${ref}`, siteId: s.id, projectId: s.projectId }, {
    lines: [`▸ Resolving ${ref}`, `  ${ref} → ${hex(7)}`, "▸ Downloading archive from GitHub", "  14.8 MB", "▸ Verifying archive", "✓ Release created"],
    onDone() { const r = { id: nid("rel"), siteId: s.id, filename: `${s.name}-${ref}.zip`, size: 14.8 * MB, sha256: hex(64), version: ref.startsWith("v") ? ref.slice(1) : `${ref}-${hex(7)}`, commit: hex(7), source: "github", pinned: false, createdAt: iso(Date.now()) };
      db.releases.unshift(r); emit("site", siteView(s)); return { releaseId: r.id }; } });
});
R("PATCH", "/api/releases/:id", (p, b) => Object.assign(find("releases", p.id), pick(b, ["pinned"])));
R("DELETE", "/api/releases/:id", (p) => {
  const r = find("releases", p.id);
  if (db.sites.some((s) => s.currentReleaseId === r.id)) err(409, "That release is live. Deploy another one first.");
  db.releases = db.releases.filter((x) => x.id !== p.id); return { ok: true };
});
R("GET", "/api/github/refs", (p, b, q) => {
  if (!q.repo || !q.repo.includes("/")) err(400, "Use the owner/name form, e.g. acme/storefront.");
  return { branches: ["main", "develop", "release/2.15", "feat/checkout-v2"], tags: ["v2.14.0", "v2.13.2", "v2.13.1"] };
});

// cluster
R("GET", "/api/servers", () => ({ items: db.servers.map(serverView) }));
R("POST", "/api/servers", (p, b) => {
  if (!b.name || !b.host) err(400, "Name and host are required.");
  const s = { id: nid("srv"), name: b.name, role: "worker", host: b.host, privateHost: b.privateHost || null, weight: b.weight || 1, enabled: true, lbEligible: b.lbEligible !== false, agentVersion: null, lastSeenAt: null,
    online: false, info: null, metrics: null, createdAt: iso(Date.now()) };
  db.servers.push(s); activity("server.add", "server", s); emit("server", serverView(s));
  return { server: serverView(s), installCommand: installCmd(s) };
});
const installCmd = (s) => `curl -fsSL '${db.settings.panelUrl}/install/node.sh?server=${s.id}&token=fcc_${hex(40)}' | sudo bash`;
R("GET", "/api/servers/:id", (p) => serverView(find("servers", p.id)));
R("PATCH", "/api/servers/:id", (p, b) => { const s = Object.assign(find("servers", p.id), pick(b, ["name", "host", "privateHost", "weight", "enabled", "lbEligible"])); activity("server.update", "server", s); emit("server", serverView(s)); return serverView(s); });
R("DELETE", "/api/servers/:id", (p) => {
  const s = find("servers", p.id);
  if (s.id === "main") err(409, "The main server can't be removed.");
  const n = db.sites.filter((x) => targets(x).includes(s.id));
  if (n.length) err(409, `${n.length} website(s) still run on ${s.name}: ${n.map((x) => x.name).join(", ")}. Move them first.`);
  db.servers = db.servers.filter((x) => x.id !== s.id); activity("server.remove", "server", s); emit("server", { id: s.id, deleted: true }); return { ok: true };
});
R("POST", "/api/servers/:id/token", (p) => { const s = find("servers", p.id); activity("server.token", "server", s); return { installCommand: installCmd(s) }; });
R("GET", "/api/servers/:id/metrics", (p, b, q) => {
  const s = find("servers", p.id);
  const base = series(q.range || "1h", "cpu");
  const k = s.metrics ? s.metrics.cpu / 30 : 0.3;
  return { items: base.map((x, i) => ({ t: x.t, cpu: s.online || i < base.length * 0.6 ? Math.min(98, x.value * k + Math.sin(i / 2 + s.name.length) * 4) : null, mem: s.metrics?.mem, disk: s.metrics?.disk, load: s.metrics?.load })).filter((x) => x.cpu != null) };
});
R("GET", "/api/loadbalancer", () => ({ ...clone(db.lb), sites: db.sites.map((s) => ({ id: s.id, name: s.name, domains: s.domains, ...lbSummary(s), upstreams: upstreams(s) })) }));
R("POST", "/api/loadbalancer/apply", () => { activity("lb.apply", "lb", { id: "lb", name: "Load balancer" }); return runJob({ type: "lb.apply", title: "Re-apply load balancer" }, { onDone() { db.lb.lastAppliedAt = iso(Date.now()); emit("lb", db.lb); } }); });
R("GET", "/api/sites/:id/nginx", (p) => ({ config: nginxConf(find("sites", p.id)) }));
R("POST", "/api/sites/:id/ssl", (p) => {
  const s = find("sites", p.id);
  const fail = s.id === "site_status" ? "DNS for status.forthway.dev does not point at this server." : null;
  activity("site.ssl", "site", s);
  return runJob({ type: "site.ssl", title: `Issue certificate for ${s.domains.join(", ")}`, siteId: s.id, projectId: s.projectId }, {
    lines: fail ? undefined : ["▸ Requesting certificate via certbot --nginx", "  Domains: " + s.domains.join(", "), "  Performing http-01 challenge", "  Waiting for verification…", "  Deploying certificate", "✓ Certificate issued — renews automatically"], fail,
    onDone() { s.ssl = { enabled: true, status: "active", issuedAt: iso(Date.now()), expiresAt: iso(Date.now() + 90 * DAY) }; emit("site", siteView(s)); },
  });
});
function nginxConf(s) {
  const ups = upstreams(s);
  const m = s.lbMethod === "least_conn" ? "  least_conn;\n" : s.lbMethod === "ip_hash" ? "  ip_hash;\n" : "";
  return `# Managed by Forthway Command Center — do not edit by hand.
# ${s.name} (${s.id}) · ${s.loadBalanced ? `load balanced across ${ups.length} servers` : "single server"}

upstream fcc_${s.id} {
${m}${ups.map((u) => `  server ${u.address}:${u.port} weight=${u.weight} max_fails=3 fail_timeout=10s;`).join("\n")}
  keepalive 32;
}

server {
  listen 80;
  listen [::]:80;
  server_name ${s.domains.join(" ")};
${s.ssl?.status === "active" ? `
  listen 443 ssl http2;
  ssl_certificate     /etc/letsencrypt/live/${s.domains[0]}/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/${s.domains[0]}/privkey.pem;
` : ""}
  access_log /var/log/nginx/fcc-${s.id}.access.log;
  client_max_body_size 64m;

  location / {
    proxy_pass http://fcc_${s.id};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
`;
}

// data
R("GET", "/api/mysql/status", () => clone(db.mysql));
R("POST", "/api/mysql/root", () => { db.mysql.rootOk = true; return clone(db.mysql); });
R("GET", "/api/databases", (p, b, q) => ({ items: db.databases.filter((d) => !q.projectId || d.projectId === q.projectId).map(dbView) }));
R("POST", "/api/projects/:projectId/databases", (p, b) => {
  find("projects", p.projectId);
  if (!/^[a-z0-9_]{1,64}$/i.test(b.name || "")) err(400, "Use letters, numbers and underscores only (max 64).");
  if (db.databases.some((d) => d.name === b.name)) err(409, "A database with that name already exists.");
  const d = { id: nid("db"), projectId: p.projectId, name: b.name, user: b.user || b.name.slice(0, 32), charset: b.charset || "utf8mb4", collation: "utf8mb4_unicode_ci", remoteAccess: !!b.remoteAccess, sizeBytes: 0, createdAt: iso(Date.now()) };
  db.databases.push(d); activity("database.create", "database", d); emit("database", dbView(d));
  return { database: dbView(d), password: b.password || genPw() };
});
const genPw = () => Array.from({ length: 24 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"[Math.floor(Math.random() * 57)]).join("");
R("GET", "/api/databases/:id", (p) => dbView(find("databases", p.id)));
R("PATCH", "/api/databases/:id", (p, b) => { const d = Object.assign(find("databases", p.id), pick(b, ["remoteAccess"])); emit("database", dbView(d)); return dbView(d); });
R("DELETE", "/api/databases/:id", (p, b, q) => { const d = find("databases", p.id);
  const linkedBy = db.sites.filter((s) => s.linkedDatabaseIds.includes(d.id)).map((s) => ({ id: s.id, name: s.name }));
  if (linkedBy.length && q.force !== "1") err(409, `${linkedBy.length} website(s) still use ${d.name}.`, { sites: linkedBy });
  if (q.deleteBackups === "1") db.backups = db.backups.filter((x) => x.databaseId !== d.id); db.databases = db.databases.filter((x) => x.id !== p.id); db.sites.forEach((s) => (s.linkedDatabaseIds = s.linkedDatabaseIds.filter((x) => x !== d.id))); activity("database.delete", "database", d); emit("database", { id: d.id, deleted: true }); return { ok: true }; });
R("POST", "/api/databases/:id/credentials", (p) => {
  const d = find("databases", p.id); activity("database.credentials", "database", d, "Revealed credentials");
  const pw = "Xq7" + genPw().slice(3);
  return { user: d.user, password: pw, host: "127.0.0.1", port: 3306, remoteHost: d.remoteAccess ? "10.0.0.10" : undefined, name: d.name, url: `mysql://${d.user}:${pw}@127.0.0.1:3306/${d.name}` };
});
R("POST", "/api/databases/:id/password", (p, b) => { const d = find("databases", p.id); activity("database.password", "database", d, "Password rotated");
  const sites = db.sites.filter((s) => s.linkedDatabaseIds.includes(d.id));
  const jobs = sites.map((s) => ({ id: runJob({ type: "site.env", title: `Update env of ${s.name}`, siteId: s.id, projectId: s.projectId }, { lines: ["▸ Writing .env", "▸ Restarting", "✓ Done"] }).id, siteId: s.id }));
  return { password: b.password || genPw(), jobs, sites: sites.map((s) => ({ id: s.id, name: s.name })) }; });
R("POST", "/api/databases/:id/import", (p, b, q) => {
  const d = find("databases", p.id); activity("database.import", "database", d, q.filename);
  return runJob({ type: "database.import", title: `Import ${q.filename || "dump.sql"} into ${d.name}`, databaseId: d.id, projectId: d.projectId }, {
    lines: ["▸ Receiving upload", "▸ Decompressing", "▸ mysql < dump", "  executed 18,204 statements", "✓ Import complete"], onDone() { d.sizeBytes += 12 * MB; emit("database", dbView(d)); } });
});
R("POST", "/api/databases/:id/backups", (p) => {
  const d = find("databases", p.id); activity("backup.create", "database", d);
  return runJob({ type: "backup.database", title: `Back up ${d.name}`, databaseId: d.id, projectId: d.projectId }, { onDone() {
    const bk = { id: nid("bak"), kind: "database", projectId: d.projectId, databaseId: d.id, file: `${d.name}-${iso(Date.now()).slice(0, 16).replace(":", "")}.sql.gz`, size: Math.round(d.sizeBytes * 0.18), sha256: hex(64), status: "ok", trigger: "manual", pinned: false, note: "", createdAt: iso(Date.now()) };
    db.backups.unshift(bk); emit("backup", bk); emit("database", dbView(d)); return { backupId: bk.id };
  } });
});
R("GET", "/api/backups", (p, b, q) => {
  let items = db.backups;
  for (const k of ["kind", "projectId", "databaseId", "serverId"]) if (q[k]) items = items.filter((x) => x[k] === q[k]);
  return { items: clone(items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))) };
});
R("POST", "/api/backups/server", (p, b) => {
  const s = find("servers", b.serverId || "main");
  if (!s.online) err(409, `${s.name} is offline.`);
  activity("backup.create", "server", s, "Manual server backup");
  return runJob({ type: "backup.server", title: `Back up ${s.name}`, serverId: s.id }, {
    lines: ["▸ Collecting " + Object.entries(b.include || {}).filter(([, v]) => v).map(([k]) => k).join(", "), "▸ tar czf (streaming)", "  site files: 2.1 GB", "  nginx config: 48 KB", s.id === "main" ? "  panel data: 12 MB" : "▸ Uploading archive to panel", "▸ Verifying checksum", "✓ Server backup complete"],
    onDone() { const bk = { id: nid("bak"), kind: "server", serverId: s.id, include: b.include, file: `server-${s.name}-${iso(Date.now()).slice(0, 10)}.tar.gz`, size: 2.2 * GB, sha256: hex(64), status: "ok", trigger: "manual", pinned: false, note: "", createdAt: iso(Date.now()) };
      db.backups.unshift(bk); emit("backup", bk); },
  });
});
R("GET", "/api/backups/settings", () => ({ ...clone(db.backupSettings), nextRun: { database: iso(Math.ceil(Date.now() / DAY) * DAY + 3 * HOUR), server: iso(Date.now() + 2.4 * DAY) }, lastRun: { database: ago(21 * HOUR), server: ago(4.6 * DAY) },
  usage: { count: db.backups.length, bytes: db.backups.reduce((a, b) => a + (b.size || 0), 0) }, localPath: "/var/lib/fcc/backups", timezone: "Europe/Berlin" }));
R("POST", "/api/backups/destination/test", (p, b) => { if (b.type !== "s3") return { ok: true }; if (!b.bucket || !b.accessKey) err(400, "Access denied: check the access key and bucket."); return { ok: true }; });
R("PUT", "/api/backups/settings", (p, b) => { db.backupSettings = { ...db.backupSettings, ...b }; activity("backup.settings", "settings", { id: "backups", name: "Backup schedule" }); return clone(db.backupSettings); });
R("POST", "/api/backups/:id/restore", (p) => {
  const bk = find("backups", p.id);
  if (bk.kind === "server" && bk.serverId !== "main") err(409, "Server backups can only be restored on the main server.");
  const name = bk.kind === "database" ? db.databases.find((d) => d.id === bk.databaseId)?.name : db.servers.find((s) => s.id === bk.serverId)?.name;
  activity("backup.restore", bk.kind, { id: bk.id, name: bk.file }, `Into ${name}`);
  return runJob({ type: "backup.restore", title: `Restore ${bk.file}`, databaseId: bk.databaseId || null, serverId: bk.serverId || null, projectId: bk.projectId || null }, {
    lines: ["▸ Verifying archive checksum", "▸ Taking safety snapshot first", bk.kind === "database" ? "▸ gunzip | mysql " + name : "▸ Extracting site files + nginx config", "  done", "✓ Restore complete"] });
});
R("PATCH", "/api/backups/:id", (p, b) => { const bk = Object.assign(find("backups", p.id), pick(b, ["pinned", "note"])); emit("backup", bk); return clone(bk); });
R("DELETE", "/api/backups/:id", (p) => { const bk = find("backups", p.id); db.backups = db.backups.filter((x) => x.id !== p.id); emit("backup", { id: bk.id, deleted: true }); return { ok: true }; });

function pick(o, keys) { const r = {}; for (const k of keys) if (o && k in o) r[k] = o[k]; return r; }

/* ───────── entry points ───────── */
export async function handle(method, path, body) {
  const [pathname, search] = path.split("?");
  const q = Object.fromEntries(new URLSearchParams(search || ""));
  await new Promise((r) => setTimeout(r, 120 + Math.random() * 260));
  for (const rt of routes) {
    if (rt.method !== method) continue;
    const m = pathname.match(rt.re);
    if (!m) continue;
    const params = {};
    rt.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    const out = rt.fn(params, body || {}, q);
    return clone(out);
  }
  throw new ApiError(404, `Mock: no route for ${method} ${pathname}`);
}
export async function handleText(path) {
  await new Promise((r) => setTimeout(r, 120));
  const m = path.match(/^\/api\/jobs\/([^/]+)\/log/);
  if (m) return (db.logs[m[1]] || []).join("\n");
  return "";
}
