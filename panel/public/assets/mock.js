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
      edge: { enabled: true, implicit: true }, edgeStatus: null, panel: { enabled: true, directUrl: "http://10.0.0.10:4000" },
      lastSeenAt: ago(4e3), online: true, info: { hostname: "fcc-main", os: "Ubuntu 24.04 LTS", cpus: 8, memTotal: 16 * GB, diskTotal: 320 * GB }, createdAt: iso(NOW - 90 * DAY),
      metrics: { cpu: 23, mem: 6.2 * GB, memTotal: 16 * GB, disk: 118 * GB, diskTotal: 320 * GB, load: 0.84, uptime: 38 * DAY, at: ago(4e3) } },
    { id: "srv_fra1", name: "fra-agent-1", role: "worker", host: "203.0.113.21", privateHost: "10.0.0.21", weight: 2, enabled: true, lbEligible: true, agentVersion: "3.3.0",
      edge: { enabled: true }, edgeStatus: null, // filled in below (edge nodes)
      panel: { enabled: true, directUrl: "http://10.0.0.21:4000" }, // a standby panel (panel failover)
      lastSeenAt: ago(6e3), online: true, info: { hostname: "fra-agent-1", os: "Debian 12", cpus: 4, memTotal: 8 * GB, diskTotal: 160 * GB }, createdAt: iso(NOW - 60 * DAY),
      metrics: { cpu: 31, mem: 3.1 * GB, memTotal: 8 * GB, disk: 61 * GB, diskTotal: 160 * GB, load: 1.12, uptime: 21 * DAY, at: ago(6e3) } },
    { id: "srv_fra2", name: "fra-agent-2", role: "worker", host: "203.0.113.22", privateHost: "10.0.0.22", weight: 1, enabled: true, lbEligible: true, agentVersion: "3.3.0",
      edge: { enabled: false }, edgeStatus: null, panel: null,
      lastSeenAt: ago(3e3), online: true, info: { hostname: "fra-agent-2", os: "Ubuntu 22.04 LTS", cpus: 4, memTotal: 8 * GB, diskTotal: 160 * GB }, createdAt: iso(NOW - 45 * DAY),
      metrics: { cpu: 58, mem: 6.5 * GB, memTotal: 8 * GB, disk: 146 * GB, diskTotal: 160 * GB, load: 2.31, uptime: 9 * DAY, at: ago(3e3) } },
    { id: "srv_nyc1", name: "nyc-agent-1", role: "worker", host: "198.51.100.40", privateHost: null, weight: 1, enabled: true, lbEligible: false, agentVersion: "2.11.0",
      edge: { enabled: false }, edgeStatus: null, panel: null,
      lastSeenAt: ago(3 * HOUR + 12 * MIN), online: false, info: { hostname: "nyc-agent-1", os: "Ubuntu 22.04 LTS", cpus: 2, memTotal: 4 * GB, diskTotal: 80 * GB }, createdAt: iso(NOW - 20 * DAY),
      metrics: { cpu: 12, mem: 1.9 * GB, memTotal: 4 * GB, disk: 31 * GB, diskTotal: 80 * GB, load: 0.2, uptime: 2 * DAY, at: ago(3 * HOUR + 12 * MIN) } },
    { id: "srv_ams1", name: "ams-agent-1", role: "worker", host: "203.0.113.31", privateHost: "10.0.0.31", weight: 1, enabled: true, lbEligible: false, agentVersion: "3.3.0",
      edge: { enabled: true }, edgeStatus: null, panel: null,
      lastSeenAt: ago(5e3), online: true, info: { hostname: "ams-agent-1", os: "Debian 12", cpus: 2, memTotal: 4 * GB, diskTotal: 80 * GB }, createdAt: iso(NOW - 6 * DAY),
      metrics: { cpu: 9, mem: 1.2 * GB, memTotal: 4 * GB, disk: 14 * GB, diskTotal: 80 * GB, load: 0.18, uptime: 6 * DAY, at: ago(5e3) } },
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
// More load-balanced sites, so the collapsible lists (fold.js) have something to fold in ?mock=1.
for (const [id, projectId, name, domain, port, serverIds] of [
  ["site_acmecheckout", "prj_acme", "acme-checkout", "checkout.acme.com", 3009, ["main", "srv_fra1", "srv_fra2"]],
  ["site_acmesearch", "prj_acme", "acme-search", "search.acme.com", 3010, ["srv_fra1", "srv_fra2"]],
  ["site_acmeimg", "prj_acme", "acme-images", "img.acme.com", 3011, ["main", "srv_fra2"]],
  ["site_nwdocs", "prj_north", "northwind-docs", "docs.northwind.io", 3012, ["main", "srv_fra1"]],
  ["site_nwgql", "prj_north", "northwind-graphql", "graphql.northwind.io", 3013, ["main", "srv_fra1", "srv_fra2"]],
]) mkSite({ id, projectId, name, domains: [domain], port, loadBalanced: true, serverIds, lbMethod: "least_conn", github: { repo: `${name.split("-")[0]}/${name}`, branch: "main" },
  env: { NODE_ENV: "production" }, ssl: { enabled: true, status: "active", issuedAt: ago(20 * DAY), expiresAt: iso(NOW + 70 * DAY) } });

// Docker runtime (docs/DOCKER-AND-TESTS.md §1): two sites already in containers, the rest still legacy pm2.
const CONTAINERS = { site_acmeweb: { uid: 20001, gid: 20001, image: "node:20-bookworm-slim", memoryMb: 1024, cpus: 1.5 }, site_nwapi: { uid: 20002, gid: 20002, image: "node:20-bookworm-slim", memoryMb: 768, cpus: 1 } };
for (const s of db.sites) {
  s.runtime = s.type === "static" ? "none" : CONTAINERS[s.id] ? "docker" : "legacy";
  s.container = CONTAINERS[s.id] || null;
}
const COMMIT_MSGS = ["Checkout: show the order summary on mobile", "Fix cart total rounding for 3-decimal currencies", "Add password reset by email", "Bump next to 14.2.15", "Stripe: handle payment_intent.payment_failed",
  "Search: debounce queries and cache results", "Admin: export orders as CSV", "Move session store to MySQL", "Tighten CSP headers", "Products: lazy-load images below the fold"];
const AUTHORS = ["Jordan Reyes", "Sam Patel", "Alex Kim"];

// Releases
const SRC_VERS = { site_acmeweb: ["2.14.0", "2.13.2", "2.13.1", "2.13.0", "2.12.4", "2.12.3", "2.12.2", "2.12.0", "2.11.5", "2.11.4", "2.11.0", "2.10.2"], site_acmeadmin: ["1.6.3", "1.6.2", "1.6.0"], site_acmestg: ["2.15.0-rc.2", "2.15.0-rc.1"], site_nwapi: ["4.2.1", "4.2.0", "4.1.9", "4.1.8"],
  site_nwhooks: ["1.3.0", "1.2.7"], site_landing: ["2026.10.02", "2026.09.27", "2026.09.14"], site_blog: ["6.6.2"], site_status: ["1.0.4", "1.0.3"] };
for (const s of db.sites) {
  const vers = SRC_VERS[s.id] || ["1.0.0"];
  vers.forEach((v, i) => {
    const sha = s.github ? hex(40) : null;
    const r = { id: nid("rel"), siteId: s.id, filename: `${s.name}-${v}.zip`, size: Math.round((s.type === "node" ? 18 : 4) * MB * (0.8 + Math.random() * 0.5)), sha256: hex(64), version: v, commit: sha ? sha.slice(0, 7) : null,
      source: s.github && i !== 1 ? "github" : "upload", pinned: i === vers.length - 1 && vers.length > 2, createdAt: ago((i * 2.3 + 0.2) * DAY + Math.random() * 4 * HOUR) };
    if (r.source === "github") r.github = { repo: s.github.repo, ref: s.github.branch, sha, message: COMMIT_MSGS[(i * 3 + s.name.length) % COMMIT_MSGS.length], author: AUTHORS[i % AUTHORS.length] };
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
// A longer history for acme-web, so its Deploy history has several pages (5 per page) in ?mock=1.
for (let i = 0; i < 21; i++) {
  const ver = SRC_VERS.site_acmeweb[1 + (i % (SRC_VERS.site_acmeweb.length - 1))];
  const [type, title, status, error] = [
    ["site.deploy", `Deploy acme-web ${ver}`, "succeeded"], ["site.restart", "Restart acme-web", "succeeded"], ["site.deploy", `Deploy acme-web ${ver}`, "succeeded"],
    ["site.env", "Apply environment to acme-web", "succeeded"], ["site.deploy", `Deploy acme-web ${ver}`, i === 4 ? "failed" : "succeeded", i === 4 ? "Health check failed: GET /api/health returned 500 after 180s — rolled back" : null],
    ["site.ssl", "Renew certificate for acme.com", "succeeded"], ["site.deploy", `Pull & deploy acme-web ${ver}`, "succeeded"],
  ][i % 7];
  const at = DAY * (1.2 + i * 2.7), id = nid("job");
  db.jobs.push({ id, type, title, status, siteId: "site_acmeweb", projectId: "prj_acme", serverId: null, databaseId: null, adminId: "adm_1", startedAt: ago(at), finishedAt: ago(at - 40e3 - i * 3e3), error: error || null, result: null });
  db.logs[id] = linesFor(type, title, error || null);
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

/* ───────── mock switches ─────────
   ?mockdb=off  databases unavailable (main doesn't run the active panel) · ?mockdb=on undoes it
   ?mockha=open panel nodes can be added (otherwise nyc-agent-1, offline on agent 2.11, blocks it)
   Or from the console: fccMock.dbDown(true), fccMock.haOpen(true), then reload the view. */
const flags = { dbDown: false, haOpen: false };
{
  const q = new URLSearchParams(location.search);
  const ssGet = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
  const ssSet = (k, v) => { try { v ? sessionStorage.setItem(k, "1") : sessionStorage.removeItem(k); } catch {} };
  if (q.has("mockdb")) ssSet("fcc.mock.dbDown", q.get("mockdb") === "off");
  if (q.has("mockha")) ssSet("fcc.mock.haOpen", q.get("mockha") === "open");
  flags.dbDown = ssGet("fcc.mock.dbDown") === "1";
  flags.haOpen = ssGet("fcc.mock.haOpen") === "1";
  try { window.fccMock = { flags, dbDown: (on = true) => { flags.dbDown = !!on; ssSet("fcc.mock.dbDown", !!on); }, haOpen: (on = true) => { flags.haOpen = !!on; ssSet("fcc.mock.haOpen", !!on); } }; } catch {}
}
const DB_REASON = "Databases live on the main server, which is not running the active panel right now.";

/* panel failover (docs/HA.md, Phase 2): main is the active panel, fra-agent-1 a standby */
const ha = { enabled: true, armed: true, leaderId: "main", term: 7, switchingUntil: 0 };

/* ───────── event bus ───────── */
const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(type, data) { setTimeout(() => listeners.forEach((f) => f(type, clone(data))), 0); if (type === "site" && data?.stagingOf && !data.deleted) { const par = db.sites.find((x) => x.id === data.stagingOf); if (par) setTimeout(() => listeners.forEach((f) => f("site", clone(siteView(par)))), 0); } } // STAGING: the parent shows its copy

// metrics heartbeat
setInterval(() => {
  for (const s of db.servers) {
    if (!s.online) continue;
    const m = s.metrics;
    m.cpu = Math.max(3, Math.min(97, m.cpu + (Math.random() - 0.5) * 10));
    m.mem = Math.max(0.2 * m.memTotal, Math.min(0.97 * m.memTotal, m.mem + (Math.random() - 0.5) * 0.08 * GB));
    m.load = Math.max(0.05, +(m.load + (Math.random() - 0.5) * 0.3).toFixed(2));
    m.at = iso(Date.now()); s.lastSeenAt = m.at;
    if (s.edgeStatus) s.edgeStatus.reportedAt = m.at;
    emit("server", serverView(s));
  }
}, 5000);

/* ───────── jobs ───────── */
function runJob(meta, { lines, fail, onDone, speed = 260 } = {}) {
  const job = { id: nid("job"), status: "queued", siteId: null, projectId: null, serverId: null, databaseId: null, adminId: me.id, createdAt: iso(Date.now()), startedAt: iso(Date.now()), finishedAt: null, error: null, result: null, ...meta };
  db.jobs.unshift(job);
  db.logs[job.id] = [];
  emit("job", job);
  const L = lines || linesFor(job.type, job.title, fail);
  let i = 0;
  const begin = () => {
    job.status = "running"; job.startedAt = iso(Date.now()); emit("job", job);
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
        if (job.heavy) mqPump();
      }
    }, speed);
  };
  if (job.heavy) mqAdd(job, begin); else setTimeout(begin, 500);
  return job;
}

/* ───────── job queue (panel/lib/jobs.mjs): heavy jobs wait for a free slot per server ───────── */
const mq = { perServer: 1, waiting: [], begin: new Map(), slots: new Map() }; // slots: jobId -> { servers, forced }
function mqAdd(job, begin) {
  job.servers = job.servers?.length ? job.servers : [job.serverId || "main"];
  job.position = null; job.forced = false;
  mq.begin.set(job.id, begin);
  mq.waiting.push(job);
  mqPump();
}
function mqUsed(sid) { let n = 0; for (const s of mq.slots.values()) if (s.servers.includes(sid)) n++; return n; }
function mqPump() {
  for (const [id] of mq.slots) { const j = db.jobs.find((x) => x.id === id); if (!j || !["queued", "running"].includes(j.status)) mq.slots.delete(id); }
  mq.waiting = mq.waiting.filter((j) => j.status === "queued");
  const blocked = new Set();
  for (const j of [...mq.waiting]) {
    if (j.servers.every((sid) => !blocked.has(sid) && mqUsed(sid) < mq.perServer)) mqBegin(j, false);
    else j.servers.forEach((sid) => blocked.add(sid));
  }
  mq.waiting.forEach((j, i) => (j.position = i + 1));
  emit("queue", mqView());
}
function mqBegin(j, forced) {
  mq.waiting = mq.waiting.filter((x) => x !== j);
  mq.slots.set(j.id, { servers: j.servers, forced });
  j.position = null; j.forced = forced;
  const begin = mq.begin.get(j.id); mq.begin.delete(j.id);
  begin?.();
}
function mqView() {
  const named = (j) => ({ id: j.id, type: j.type, title: j.title, status: j.status, siteId: j.siteId, projectId: j.projectId, adminId: j.adminId, servers: j.servers, forced: !!j.forced, position: j.position ?? null,
    createdAt: j.createdAt, startedAt: j.status === "running" ? j.startedAt : null, lastLine: j.status === "running" ? (db.logs[j.id] || []).at(-1)?.replace(/^\[[^\]]+\] /, "") || "" : "",
    adminName: db.admins.find((a) => a.id === j.adminId)?.name || null, siteName: db.sites.find((x) => x.id === j.siteId)?.name || null,
    serverNames: j.servers.map((sid) => db.servers.find((x) => x.id === sid)?.name || sid),
    waitingFor: j.status === "queued" ? [...mq.slots.keys()].map((id) => db.jobs.find((x) => x.id === id)).filter((r) => r && r.servers.some((sid) => j.servers.includes(sid))).map((r) => r.title) : [] });
  const running = [...mq.slots.keys()].map((id) => db.jobs.find((x) => x.id === id)).filter((j) => j?.status === "running");
  return { perServer: mq.perServer, maxPerServer: 8, running: running.map(named), waiting: mq.waiting.map(named) };
}
// A busy moment to look at: two heavy jobs running (main, fra-agent-1) and three waiting behind them.
{
  const slow = (type, n) => Array.from({ length: n }, (_, k) => linesFor(type, "")[k % 15]).map((l) => l.replace(/^\[[^\]]+\] /, ""));
  runJob({ type: "site.deploy", title: "Deploy acme-web 2.15.0", siteId: "site_acmeweb", projectId: "prj_acme", heavy: true, servers: ["main"] }, { lines: slow("site.deploy", 60), speed: 2500 });
  runJob({ type: "backup.server", title: "Back up server fra-agent-1", serverId: "srv_fra1", heavy: true, servers: ["srv_fra1"], adminId: "adm_2" }, { lines: slow("backup.server", 7).concat(Array(40).fill("  …compressing")), speed: 3000 });
  runJob({ type: "site.deploy", title: "Deploy northwind-api 4.3.0", siteId: "site_nwapi", projectId: "prj_north", heavy: true, servers: ["srv_fra1"], adminId: "adm_2" }, { lines: slow("site.deploy", 30), speed: 900 });
  runJob({ type: "site.test", title: "Test landing 2026.10.30", siteId: "site_landing", projectId: "prj_mkt", heavy: true, servers: ["main"] }, { lines: slow("site.deploy", 30), speed: 900 });
  runJob({ type: "release.github", title: "Deploy acme-staging 2.15.0-rc.3", siteId: "site_acmestg", projectId: "prj_acme", heavy: true, servers: ["srv_fra1"] }, { lines: slow("site.deploy", 30), speed: 900 });
}

function activity(action, type, target, details) {
  const a = { id: nid("act"), at: iso(Date.now()), adminId: me.id, adminName: me.name, action, target: { type, id: target?.id, name: target?.name }, details: details || null,
    projectId: target?.projectId || (type === "project" ? target?.id : null) };
  db.activity.unshift(a);
  emit("activity", a);
}

/* ───────── views ───────── */
function serverView(s) {
  return { ...clone(s), siteCount: db.sites.filter((x) => targets(x).includes(s.id)).length, panelRole: s.panel?.enabled ? (s.id === ha.leaderId ? "leader" : "follower") : null };
}
function lbSummary(s) { return { loadBalanced: !!s.loadBalanced, servers: targets(s).length, method: s.lbMethod }; }
function upstreams(s) {
  return targets(s).map((sid) => {
    const srv = db.servers.find((x) => x.id === sid);
    return { serverId: sid, name: srv?.name || sid, address: sid === "main" ? "127.0.0.1" : srv?.privateHost || srv?.host, port: s.port, weight: srv?.weight || 1, online: !!srv?.online, healthy: !!s.state?.[sid]?.healthy };
  });
}
function siteView(s) { const bj = db.jobs.find((x) => x.siteId === s.id && (x.status === "running" || x.status === "queued")); return { ...clone(s), canMigrate: s.runtime === "legacy" && s.type !== "static", busyJobId: bj?.id || null, envCount: Object.keys(s.env || {}).length, currentVersion: db.releases.find((r) => r.id === s.currentReleaseId)?.version || null, lb: lbSummary(s), currentRelease: clone(db.releases.find((r) => r.id === s.currentReleaseId) || null), stagingOf: s.stagingOf || null, stagingSiteId: s.stagingSiteId || null, staging: stagingSummary(s) }; }
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
  if (q.offset == null && q.page == null) return { items: clone(items.slice(0, Number(q.limit) || 50)) };
  // paged (Deploy history): { items, total, offset, limit }, like panel/lib/core-routes.mjs
  const limit = Math.max(1, Math.min(100, Number(q.limit) || 10)), offset = q.page != null ? (Math.max(1, Number(q.page) || 1) - 1) * limit : Math.max(0, Number(q.offset) || 0);
  return { items: clone(items.slice(offset, offset + limit)), total: items.length, offset, limit };
});
// Updates → Server software (panel/lib/software.mjs)
const swPkg = (n, f, t) => ({ name: n, from: f, to: t });
const sw = {
  checking: null,
  cloudflaredLatest: { version: "2026.10.0", url: "https://github.com/cloudflare/cloudflared/releases", checkedAt: iso(Date.now() - 40 * 60_000), error: null },
  servers: {
    main: { checkedAt: iso(Date.now() - 40 * 60_000), error: null, apt: true,
      php: { installed: true, label: "PHP", version: "8.3.6", latest: "8.3.6", upgrades: [swPkg("php8.3-fpm", "8.3.6-0ubuntu0.24.04.2", "8.3.6-0ubuntu0.24.04.3"), swPkg("php8.3-cli", "8.3.6-0ubuntu0.24.04.2", "8.3.6-0ubuntu0.24.04.3"), swPkg("php8.3-mysql", "8.3.6-0ubuntu0.24.04.2", "8.3.6-0ubuntu0.24.04.3")] },
      mysql: { installed: true, label: "MySQL", version: "8.0.39", latest: "8.0.40", upgrades: [swPkg("mysql-server-core-8.0", "8.0.39-0ubuntu0.24.04.2", "8.0.40-0ubuntu0.24.04.1"), swPkg("mysql-client-core-8.0", "8.0.39-0ubuntu0.24.04.2", "8.0.40-0ubuntu0.24.04.1")] },
      cloudflared: { installed: true, version: "2025.8.0", managedBy: "panel", path: "/var/lib/fcc/bin/cloudflared" } },
  },
  jobs: {},
};
function swView() {
  const L = sw.cloudflaredLatest.version;
  const servers = db.servers.map((sv) => {
    const r = sw.servers[sv.id] || { checkedAt: iso(Date.now() - 40 * 60_000), error: null, apt: true,
      php: { installed: false, upgrades: [] }, mysql: { installed: true, label: "MySQL", version: "8.0.40", latest: "8.0.40", upgrades: [] }, cloudflared: { installed: true, version: L, managedBy: "panel" } };
    const comp = (c) => {
      const x = r[c]; const jobId = sw.jobs[`${sv.id}:${c}`] || null;
      if (c === "cloudflared") { const available = !!(x.installed && x.version !== L); return { ...x, latest: L, available, canUpdate: available && x.managedBy !== "other", jobId }; }
      const available = !!x.upgrades?.length; return { ...x, available, canUpdate: available, jobId };
    };
    return { id: sv.id, name: sv.name, role: sv.id === "main" ? "main" : "worker", online: sv.online !== false, checkedAt: r.checkedAt, error: r.error, apt: r.apt, php: comp("php"), mysql: comp("mysql"), cloudflared: comp("cloudflared") };
  });
  return { servers, cloudflaredLatest: sw.cloudflaredLatest, checking: sw.checking, updates: servers.reduce((n, s) => n + ["php", "mysql", "cloudflared"].filter((c) => s[c].available).length, 0) };
}
R("GET", "/api/software", () => swView());
R("POST", "/api/software/check", () => {
  const job = runJob({ type: "software.check", title: "Check PHP, MySQL and cloudflared for updates" }, { lines: ["Refreshing the package lists (apt-get update)…", "Newest cloudflared: 2026.10.0", "3 updates available."], onDone: () => { sw.checking = null; for (const r of Object.values(sw.servers)) r.checkedAt = iso(Date.now()); emit("software", swView()); } });
  sw.checking = job.id; emit("software", swView()); return job;
});
R("POST", "/api/software/upgrade", (p, b) => {
  const sv = find("servers", b.serverId); const c = b.component; const key = `${sv.id}:${c}`;
  if (sw.jobs[key]) err(409, "Already updating.");
  const names = { php: "PHP", mysql: "MySQL", cloudflared: "cloudflared" };
  const job = runJob({ type: "software.upgrade", title: `Update ${names[c]} on ${sv.name}`, serverId: sv.id, heavy: true, servers: [sv.id] }, {
    lines: c === "cloudflared" ? ["Downloading cloudflared-linux-amd64…", "Installed 2026.10.0 at /var/lib/fcc/bin/cloudflared.", "Restarted 1 tunnel connector on the new cloudflared."] : ["Refreshing the package lists (apt-get update)…", "Updating packages…", "Setting up packages…", "Done."],
    onDone: () => {
      delete sw.jobs[key];
      const r = sw.servers[sv.id];
      if (r) { if (c === "cloudflared") r.cloudflared.version = sw.cloudflaredLatest.version; else { r[c].version = r[c].latest; r[c].upgrades = []; } }
      emit("software", swView());
    },
  });
  sw.jobs[key] = job.id; emit("software", swView()); return job;
});
R("GET", "/api/jobs/queue", () => mqView()); // job queue (before /api/jobs/:id)
R("GET", "/api/jobs/:id", (p) => clone(find("jobs", p.id)));
R("POST", "/api/jobs/:id/cancel", (p) => { const j = find("jobs", p.id); if (j.status === "running" || j.status === "queued") { j.status = "cancelled"; j.finishedAt = iso(Date.now()); emit("job", j); if (j.heavy) mqPump(); } return clone(j); });
// job queue
R("PATCH", "/api/jobs/queue", (p, b) => {
  const n = Number(b.perServer);
  if (!Number.isInteger(n) || n < 1 || n > 8) err(400, "Heavy jobs per server must be a whole number from 1 to 8.");
  mq.perServer = n; mqPump(); return mqView();
});
R("POST", "/api/jobs/:id/move", (p, b) => {
  const j = find("jobs", p.id);
  const from = mq.waiting.indexOf(j);
  if (from === -1) err(409, "That job isn't waiting in the queue any more.");
  const last = mq.waiting.length - 1;
  const to = b.to === "top" ? 0 : b.to === "bottom" ? last : b.to === "up" ? from - 1 : b.to === "down" ? from + 1 : Number(b.index);
  if (!Number.isFinite(to)) err(400, 'Say where to move it: to "top", "bottom", "up", "down" or an index.');
  mq.waiting.splice(from, 1); mq.waiting.splice(Math.max(0, Math.min(last, to)), 0, j);
  mqPump(); return mqView();
});
R("POST", "/api/jobs/:id/force", (p) => {
  const j = find("jobs", p.id);
  if (!mq.waiting.includes(j)) err(409, "That job isn't waiting in the queue any more.");
  activity("job.force", "job", { id: j.id, name: j.title, projectId: j.projectId });
  mqBegin(j, true); mqPump(); return clone(j);
});
R("GET", "/api/activity", (p, b, q) => {
  let items = db.activity;
  if (q.projectId) items = items.filter((a) => a.projectId === q.projectId);
  return { items: clone(items.slice(0, Number(q.limit) || 100)) };
});

// sites
R("GET", "/api/sites", (p, b, q) => ({ items: db.sites.filter((s) => (!q.projectId || s.projectId === q.projectId) && !s.stagingOf).map(siteView) })); // STAGING: copies show inside their parent
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
R("GET", "/api/sites/:id/usage", (p, b, q) => { // USAGE (panel/lib/usage.mjs)
  const s = find("sites", p.id);
  const range = ["1h", "24h", "7d", "30d"].includes(q.range) ? q.range : "24h";
  const [n, step] = { "1h": [60, MIN], "24h": [288, 5 * MIN], "7d": [168, HOUR], "30d": [120, 6 * HOUR] }[range];
  const node = (s.type || "node") === "node";
  const ids = s.loadBalanced ? s.serverIds : [s.serverIds?.[0] || "main"];
  const to = Math.floor(Date.now() / step) * step;
  const wave = (t, k) => Math.sin(t / step / 9 + k) * 0.5 + 0.5;
  const per = Object.fromEntries(ids.map((sid, k) => [sid, Array.from({ length: n }, (_, i) => {
    const t = to - (n - 1 - i) * step;
    return { t, cpu: node ? Math.round((4 + wave(t, k) * 22 + Math.random() * 4) * 10) / 10 : null, mem: node ? Math.round((110 + wave(t, k) * 50) * MB) : null };
  })]));
  const series = per[ids[0]].map((pt, i) => ({ t: pt.t, cpu: node ? Math.round(ids.reduce((a, sid) => a + per[sid][i].cpu, 0) * 10) / 10 : null, mem: node ? ids.reduce((a, sid) => a + per[sid][i].mem, 0) : null }));
  const servers = ids.map((sid) => {
    const last = per[sid][n - 1], srv = db.servers.find((x) => x.id === sid);
    return { id: sid, name: srv?.name || sid, online: true, cores: srv?.info?.cpus || 4, memTotal: srv?.info?.memTotal || 8 * GB, cpu: last.cpu, mem: last.mem, procs: node ? 2 : 0, source: node ? "pm2" : "nginx", disk: 240 * MB, diskAt: ago(4 * MIN), at: ago(20e3), error: null, stale: false };
  });
  const vals = (k) => series.map((x) => x[k]).filter((v) => v != null);
  const avg = (k) => (vals(k).length ? vals(k).reduce((a, v) => a + v, 0) / vals(k).length : null);
  const max = (k) => (vals(k).length ? Math.max(...vals(k)) : null);
  return {
    range, step, from: to - (n - 1) * step, to, type: s.type || "node", simulated: false, cores: servers.reduce((a, x) => a + x.cores, 0), memTotal: servers.reduce((a, x) => a + x.memTotal, 0),
    series, perServer: ids.length > 1 ? per : undefined, servers,
    current: { cpu: series[n - 1].cpu, mem: series[n - 1].mem, disk: 240 * MB, procs: node ? 2 * ids.length : 0, at: ago(20e3) },
    avg: { cpu: avg("cpu") == null ? null : Math.round(avg("cpu") * 10) / 10, mem: avg("mem") == null ? null : Math.round(avg("mem")) },
    peak: { cpu: max("cpu"), mem: max("mem") },
  };
});
R("GET", "/api/sites/:id", (p) => {
  const s = find("sites", p.id);
  return { ...siteView(s), upstreams: upstreams(s), releases: clone(db.releases.filter((r) => r.siteId === (s.stagingOf || s.id)).slice(0, 20)) }; // STAGING: a copy deploys its parent's releases
});
R("PATCH", "/api/sites/:id", (p, b) => {
  const s = find("sites", p.id);
  if (b.loadBalanced && (b.serverIds || s.serverIds).length < 2) err(400, "Load balancing needs at least 2 servers.");
  const prevGithub = s.github || {};
  Object.assign(s, pick(b, ["name", "type", "domains", "loadBalanced", "serverIds", "lbMethod", "healthPath", "port", "github", "linkedDatabaseIds"]));
  if (b.github) s.github = { ...prevGithub, ...b.github }; // merged like the real server's sanitizeGithub
  if (b.container && s.runtime === "docker") s.container = { ...s.container, ...pick(b.container, ["image", "memoryMb", "cpus"]) };
  if (b.settings) s.settings = { ...s.settings, ...b.settings, build: { ...(s.settings.build || {}), ...(b.settings.build || {}) }, restart: { ...(s.settings.restart || {}), ...(b.settings.restart || {}) } };
  for (const sid of targets(s)) if (!s.state[sid]) { const srv = db.servers.find((x) => x.id === sid); s.state[sid] = { running: !!srv?.online, healthy: !!srv?.online, version: db.releases.find((r) => r.id === s.currentReleaseId)?.version, checkedAt: iso(Date.now()) }; }
  activity("site.update", "site", s); emit("site", siteView(s));
  return { ...siteView(s), upstreams: upstreams(s) };
});
R("DELETE", "/api/sites/:id", (p) => { const s = find("sites", p.id); if (s.stagingSiteId) err(409, `${s.name} has a staging copy. Remove staging first (open its staging build from the header's type icon → ⋯ → Remove staging), then delete the website.`); db.sites = db.sites.filter((x) => x.id !== p.id); activity("site.delete", "site", s); emit("site", { id: s.id, deleted: true }); return { ok: true }; });
R("POST", "/api/sites/:id/deploy", (p, b) => {
  const s = find("sites", p.id);
  busy(s);
  const rel = b.releaseId ? find("releases", b.releaseId) : db.releases.find((r) => r.id === s.currentReleaseId) || db.releases.find((r) => r.siteId === s.id);
  if (!rel) err(409, "Upload a release or pull from GitHub first.");
  const tg = targets(s);
  const lines = tg.flatMap((sid, i) => [`━━ ${db.servers.find((x) => x.id === sid)?.name || sid} (${i + 1}/${tg.length}) ━━`, ...linesFor("site.deploy", "").map((l) => l.replace(/^\[[^\]]+\] /, ""))]);
  activity("site.deploy", "site", s, `Release ${rel.version} to ${tg.length} server${tg.length > 1 ? "s" : ""}`);
  return runJob({ type: "site.deploy", title: `Deploy ${s.name} ${rel.version}`, siteId: s.id, projectId: s.projectId, heavy: true, servers: [tg[0]] }, { lines, speed: 160, onDone() {
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
R("GET", "/api/sites/:id/scripts", (p, b, q) => {
  const s = find("sites", p.id);
  const tg = targets(s), sid = q.serverId || tg[0];
  const deployed = !!s.currentReleaseId;
  return { serverId: sid, servers: tg.map((id) => ({ id, name: db.servers.find((x) => x.id === id)?.name || id, online: !!db.servers.find((x) => x.id === id)?.online })), loadBalanced: !!s.loadBalanced, deployed,
    source: deployed ? "deployed" : null, version: db.releases.find((r) => r.id === s.currentReleaseId)?.version || null, hasNodeModules: true, note: null,
    scripts: deployed ? [
      { name: "db:push", command: "prisma db push", kind: "task", runnable: true, risky: true },
      { name: "build", command: "next build", kind: "task", runnable: true, risky: false },
      { name: "start", command: "next start", kind: "app", runnable: false, risky: false },
    ] : [] };
});
R("POST", "/api/sites/:id/scripts/run", (p, b) => {
  const s = find("sites", p.id);
  const label = b.command != null ? String(b.command).trim() : `npm run ${b.script}`;
  if (b.command != null && (!label || /[\r\n]/.test(label))) err(400, "Type a command on one line (at most 2000 characters).");
  const where = b.allServers ? `all ${targets(s).length} servers` : db.servers.find((x) => x.id === (b.serverId || targets(s)[0]))?.name;
  return runJob({ type: "site.script", title: `${label} on ${where}`, siteId: s.id, projectId: s.projectId }, { lines: [`$ ${label}`, `in /srv/sites/${s.name}/app`, "  done", `✓ ${label} finished in 1.2s`] });
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
  if (s.stagingOf) err(409, "A staging copy deploys its website's releases — upload the release to the website itself.");
  const r = { id: nid("rel"), siteId: s.id, filename: q.filename || b?.name || "upload.zip", size: b?.size || 12 * MB, sha256: hex(64), version: (q.filename || "upload").replace(/\.zip$/, "").split("-").pop() || "upload", commit: null, source: "upload", pinned: false, createdAt: iso(Date.now()) };
  db.releases.unshift(r); activity("release.upload", "site", s, r.filename); emit("site", siteView(s)); return r;
});
R("POST", "/api/sites/:id/releases/github", (p, b) => {
  const s = find("sites", p.id);
  if (s.stagingOf) err(409, "A staging copy deploys its website's releases — pull from GitHub on the website itself.");
  if (!s.github?.repo) err(400, "Set a GitHub repository in Settings first.");
  const ref = b.ref || s.github.branch || "main";
  const sha = /^[0-9a-f]{40}$/.test(ref) ? ref : hex(40), message = COMMIT_MSGS[Math.floor(Math.random() * COMMIT_MSGS.length)];
  if (b.deploy) busy(s);
  return runJob({ type: "release.github", title: `Pull ${s.github.repo}@${ref.slice(0, 12)}${b.deploy ? " and deploy" : ""}`, siteId: s.id, projectId: s.projectId, ...(b.deploy ? { heavy: true, servers: [targets(s)[0]] } : {}) }, {
    lines: [`▸ Resolving ${ref}`, `  ${ref.slice(0, 12)} → ${sha.slice(0, 7)}: ${message}`, "▸ Downloading archive from GitHub", "  14.8 MB", "▸ Verifying archive", "✓ Release created", ...(b.deploy ? linesFor("site.deploy", "").map((l) => l.replace(/^\[[^\]]+\] /, "")) : [])],
    onDone() { const r = { id: nid("rel"), siteId: s.id, filename: `${s.name}-${sha.slice(0, 7)}.zip`, size: 14.8 * MB, sha256: hex(64), version: /^v\d/.test(ref) ? ref.slice(1) : `${(db.releases.find((x) => x.siteId === s.id)?.version || "1.0.0").replace(/-.*$/, "")}-${sha.slice(0, 7)}`, commit: sha.slice(0, 7), source: "github", pinned: false, createdAt: iso(Date.now()),
        github: { repo: s.github.repo, ref, sha, message, author: me.name } };
      db.releases.unshift(r);
      if (b.deploy) { s.previousReleaseId = s.currentReleaseId; s.currentReleaseId = r.id; for (const sid of targets(s)) s.state[sid] = { ...s.state[sid], running: true, healthy: true, version: r.version, checkedAt: iso(Date.now()) }; }
      emit("site", siteView(s)); return { releaseId: r.id, version: r.version }; } });
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

// edge nodes + Cloudflare connectors (docs/HA.md)
const EDGE_HASH = hex(64);
const cf = {
  connectors: [
    { id: "cfc_main", name: "Cloudflare Tunnel", cfId: "6f1c2b9e-7a1d-4c3e-9b55-2d8e0f3a4c11", autoStart: true, running: true, connections: 4, startedAt: ago(38 * DAY) },
    { id: "cfc_api", name: "Northwind tunnel", cfId: "a24e9d07-3b6c-4f8a-8e12-c5d7b9f0e6a2", autoStart: true, running: true, connections: 4, startedAt: ago(9 * DAY) },
    { id: "cfc_old", name: "Legacy tunnel", cfId: "0d7b3e51-9c2a-4b6f-a1e8-74f2c6d9b830", autoStart: false, running: true, connections: 2, startedAt: ago(2 * DAY) },
  ],
};
const edgeConnectors = () => cf.connectors.filter((c) => c.autoStart);
const edgeServers = () => db.servers.filter((s) => s.role !== "main" && s.edge?.enabled);
function appliedEdge(s, { shimError = null } = {}) {
  return { inSync: true, hash: EDGE_HASH, appliedHash: EDGE_HASH, appliedAt: iso(Date.now()), error: null, nginx: true, reportedAt: iso(Date.now()),
    connectors: edgeConnectors().map((c) => ({ id: c.id, name: c.name, active: true, readyConnections: 4 })),
    shims: [{ name: "panel", listenPort: 4000, ok: true, error: null }, { name: "phpmyadmin", listenPort: 8081, ok: !shimError, error: shimError }] };
}
// fra-agent-1: an edge in sync, both tunnels connected, phpMyAdmin shim failing (→ one warning on the dashboard)
db.servers.find((x) => x.id === "srv_fra1").edgeStatus = { ...appliedEdge(null, { shimError: "connect ECONNREFUSED 10.0.0.10:8081" }), appliedAt: ago(7 * MIN) };
db.servers.find((x) => x.id === "srv_ams1").edgeStatus = { ...appliedEdge(null), appliedAt: ago(12 * MIN) };
function edgeSync(s) {
  if (s.edgeStatus) { s.edgeStatus.inSync = false; s.edgeStatus.hash = EDGE_HASH; }
  emit("server", serverView(s));
  const files = db.sites.length + 2;
  return runJob({ type: "cluster.sync", title: `Sync edge ${s.name}`, serverId: s.id }, {
    lines: ["▸ Sending cluster.sync to " + s.name, `  ufw: allow 3000:3999 from ${db.servers.filter((x) => x.id !== s.id && (x.role === "main" || x.edge?.enabled)).map((x) => x.privateHost || x.host).join(", ")}`,
      `▸ Writing ${files} nginx files`, "  nginx -t: syntax is ok", "  nginx reloaded", ...edgeConnectors().map((c) => `▸ ${c.name}: fcc-cloudflared-${c.id}.service active · 4 connections`),
      "▸ Port shims: panel :4000, phpmyadmin :8081", "✓ Edge in sync"],
    onDone() { if (s.edge?.enabled) { s.edgeStatus = appliedEdge(s); emit("server", serverView(s)); emit("cloudflare", { kind: "status" }); } return { hash: EDGE_HASH }; },
  });
}
function cfConnectorView(c) {
  const main = db.servers.find((x) => x.id === "main");
  const replicas = [{ serverId: "main", serverName: main.name, running: c.running, connections: c.running ? c.connections : 0 }];
  if (c.autoStart) for (const s of edgeServers()) {
    const e = (s.edgeStatus?.connectors || []).find((x) => x.id === c.id);
    if (e) replicas.push({ serverId: s.id, serverName: s.name, running: !!(s.online && e.active), connections: s.online ? e.readyConnections : 0 });
  }
  return { id: c.id, name: c.name, cfId: c.cfId, accountId: cf.account.connected ? cf.account.id : "", autoStart: c.autoStart, hasToken: true, tokenHint: "eyJh••••" + c.id.slice(-3), running: c.running, connections: c.running ? c.connections : 0,
    connected: c.running && c.connections > 0, startedAt: c.running ? c.startedAt : null, lastError: null, lastExit: null, fatal: false, simulated: false, replicas };
}
// The Cloudflare account (Settings → Cloudflare) and the Cloudflare page (#/cloudflare): connectors, tunnels, domains.
cf.account = { connected: true, viaLogin: true, id: "acc_fw", name: "Forthway" };
cf.zones = [
  { id: "zone_acme", name: "acme.com", status: "active", source: "main" },
  { id: "zone_nw", name: "northwind.io", status: "active", source: "main" },
  { id: "zone_fw", name: "forthway.dev", status: "active", source: "dc_fw" },
];
cf.sources = [{ id: "dc_fw", viaLogin: true, addedAt: ago(20 * DAY) }];
cf.spare = [{ id: "7c3f8a21-5d4e-4b9a-8f60-1e2d3c4b5a69", name: "staging-tunnel", status: "inactive" }]; // in the account, no connector here
cf.toAdd = ["shop-demo.net", "example.org"]; // what "Add domain" adds next (the first one waits for its nameservers)
cf.login = { until: 0 };
cf.panel = { hostname: "panel.forthway.dev", tunnelId: "6f1c2b9e-7a1d-4c3e-9b55-2d8e0f3a4c11", route: { hostname: "panel.forthway.dev", status: "active", error: null } };
const cfSourceLabel = (src) => (src === "main" ? "Account login" : cf.sources.find((x) => x.id === src)?.viaLogin === false ? "API token ••••" + src.slice(-3) : "Domain login");
const cfTunnels = () => !cf.account.connected ? [] : [
  ...cf.connectors.filter((c) => c.cfId).map((c) => ({ id: c.cfId, name: c.name, status: c.running ? "healthy" : "down", createdAt: c.startedAt, connections: c.running ? c.connections : 0, remotelyManaged: true, accountId: cf.account.id, accountName: cf.account.name, connectorId: c.id })),
  ...cf.spare.map((t) => ({ ...t, createdAt: ago(60 * DAY), connections: 0, remotelyManaged: true, accountId: cf.account.id, accountName: cf.account.name, connectorId: null })),
];
function cfAddDomain(viaLogin) {
  const name = cf.toAdd.shift() || `site-${hex(3)}.com`;
  const src = { id: `dc_${hex(4)}`, viaLogin, addedAt: iso(Date.now()) };
  cf.sources.push(src);
  cf.zones.push({ id: `zone_${hex(4)}`, name, status: name === "shop-demo.net" ? "pending" : "active", source: src.id });
  emit("cloudflare", { kind: "status" });
  return { ok: true, done: true, added: [name], accounts: [], refused: [] };
}
function cfStatus() {
  const connectors = cf.connectors.map(cfConnectorView);
  const a = cf.account;
  return { connected: a.connected, mode: a.connected ? (a.viaLogin ? "login" : "token") : "connector", configured: true, hasToken: a.connected, tokenHint: a.connected ? "••••7f3a" : "", viaLogin: a.connected && a.viaLogin,
    accountId: a.connected ? a.id : "", accountName: a.connected ? a.name : "", managedAccounts: a.connected ? [{ id: a.id, name: a.name, main: true }] : [], connectors,
    running: connectors.filter((x) => x.running).length, connectedConnectors: connectors.filter((x) => x.connected).length, panel: cf.panel ? clone(cf.panel) : null, panelService: "http://127.0.0.1:4000",
    phpmyadmin: null, phpmyadminService: "http://127.0.0.1:8081", routes: 4, routeErrors: 0,
    binary: { installed: true, simulated: false, supported: true, version: "2026.9.1", path: "/var/lib/fcc/bin/cloudflared" }, login: { running: cf.login.until > 0, url: "" }, dryRun: false, simulatedApi: false };
}
R("GET", "/api/cloudflare", () => ({ ...cfStatus(), accounts: cf.account.connected ? [{ id: cf.account.id, name: cf.account.name }] : [], zones: cf.account.connected ? cf.zones.map((z) => ({ ...z, accountId: cf.account.id })) : [], tunnels: cfTunnels(), error: null }));
R("GET", "/api/cloudflare/status", () => cfStatus());
R("GET", "/api/cloudflare/options", () => {
  const s = cfStatus();
  const local = new Map(s.connectors.map((c) => [c.cfId, c]));
  return { connected: s.connected, mode: s.mode, accountName: s.accountName, accounts: s.managedAccounts, simulatedApi: false, error: null, panelHostname: cf.panel?.hostname || null,
    tunnels: cfTunnels().map((t) => ({ id: t.id, name: t.name, status: t.status, accountId: t.accountId, accountName: t.accountName, local: local.has(t.id), running: !!local.get(t.id)?.running, connectedHere: !!local.get(t.id)?.connected })),
    zones: s.connected ? cf.zones.map((z) => z.name) : [], zoneAccounts: s.connected ? Object.fromEntries(cf.zones.map((z) => [z.name, cf.account.id])) : {} };
});
R("GET", "/api/cloudflare/routes", () => ({ items: [], tunnels: [] }));
R("GET", "/api/cloudflare/domains", () => {
  if (!cf.account.connected) return { connected: false, items: [], sources: [] };
  return { connected: true, error: null, accounts: cfStatus().managedAccounts, addSiteUrl: `https://dash.cloudflare.com/${cf.account.id}/add-site`,
    items: cf.zones.map((z) => ({ id: z.id, name: z.name, status: z.status, accountId: cf.account.id, accountName: cf.account.name, source: z.source, sourceLabel: cfSourceLabel(z.source), removable: z.source !== "main", error: null,
      routes: db.sites.filter((s) => s.domains.some((d) => d === z.name || d.endsWith("." + z.name))).length })),
    sources: cf.sources.map((x) => ({ id: x.id, label: cfSourceLabel(x.id), viaLogin: x.viaLogin, accountId: cf.account.id, accountName: cf.account.name, zones: cf.zones.filter((z) => z.source === x.id).map((z) => z.name), addedAt: x.addedAt, error: null })) };
});
R("POST", "/api/cloudflare/domains", (p, b) => { if (!String(b.token || "").trim()) err(400, "Paste an API token first."); return cfAddDomain(false); });
R("POST", "/api/cloudflare/domains/login", () => { if (!cf.account.connected) err(400, "Connect Cloudflare first."); cf.login = { until: Date.now() + 4000, purpose: "domain" }; return { ok: true, url: "https://dash.cloudflare.com/argotunnel?mock=1" }; });
R("POST", "/api/cloudflare/login", () => { cf.login = { until: Date.now() + 3000, purpose: "connect" }; return { ok: true, url: "https://dash.cloudflare.com/argotunnel?mock=1" }; });
R("GET", "/api/cloudflare/login", () => {
  if (!cf.login.until) return { running: false, done: false, error: "" };
  if (Date.now() < cf.login.until) return { running: true, done: false, error: "", url: "https://dash.cloudflare.com/argotunnel?mock=1" };
  const purpose = cf.login.purpose; cf.login = { until: 0 };
  if (purpose === "domain") return cfAddDomain(true);
  cf.account.connected = true; cf.account.viaLogin = true; emit("cloudflare", { kind: "status" });
  return { running: false, done: true, error: "", accountName: cf.account.name };
});
R("POST", "/api/cloudflare/login/cancel", () => { cf.login = { until: 0 }; return { ok: true }; });
R("DELETE", "/api/cloudflare/domains/:id", (p) => {
  const src = cf.sources.find((x) => x.id === p.id) || err(404, "Not found.");
  const removed = cf.zones.filter((z) => z.source === src.id).map((z) => z.name);
  cf.sources = cf.sources.filter((x) => x !== src); cf.zones = cf.zones.filter((z) => z.source !== src.id);
  emit("cloudflare", { kind: "status" }); return { ok: true, removed };
});
R("POST", "/api/cloudflare/token", (p, b) => {
  if (!String(b.token || "").trim()) { cf.account.connected = false; cf.sources = []; cf.zones = cf.zones.filter((z) => z.source === "main"); emit("cloudflare", { kind: "status" }); return { ok: true, cleared: true, status: cfStatus() }; }
  cf.account.connected = true; cf.account.viaLogin = false; emit("cloudflare", { kind: "status" });
  return { ok: true, accounts: [{ id: cf.account.id, name: cf.account.name }], status: cfStatus() };
});
R("POST", "/api/cloudflare/tunnels", (p, b) => {
  if (!cf.account.connected) err(400, "Connect Cloudflare first.");
  let tun;
  if (b.tunnelId) { tun = cf.spare.find((t) => t.id === b.tunnelId) || err(400, "That tunnel isn't in your Cloudflare account."); cf.spare = cf.spare.filter((t) => t !== tun); }
  else {
    const name = String(b.name || "").trim().slice(0, 60) || "fcc-main";
    if (cf.connectors.some((c) => c.name === name)) err(400, `A tunnel named “${name}” already exists. Pick another name.`);
    tun = { id: [hex(4), hex(2), hex(2), hex(2), hex(6)].join("-"), name };
  }
  const c = { id: `cfc_${hex(3)}`, name: tun.name, cfId: tun.id, autoStart: b.autoStart !== false, running: b.autoStart !== false, connections: 4, startedAt: iso(Date.now()) };
  cf.connectors.push(c); emit("cloudflare", { kind: "status" });
  if (c.autoStart) for (const s of edgeServers()) if (s.online) setTimeout(() => edgeSync(s), 300); // edge nodes run a copy
  return { ok: true, tunnel: { id: tun.id, name: tun.name }, connector: cfConnectorView(c), started: c.running, startError: null };
});
R("POST", "/api/cloudflare/connectors", (p, b) => {
  const token = String(b.token || "").trim().replace(/^.*\s/, "");
  if (token.length < 40) err(400, "Paste the connector token from the Cloudflare dashboard (Zero Trust → Networks → Tunnels → Configure).");
  const c = { id: `cfc_${hex(3)}`, name: String(b.name || "").trim().slice(0, 60) || "Cloudflare Tunnel", cfId: [hex(4), hex(2), hex(2), hex(2), hex(6)].join("-"), autoStart: b.autoStart !== false, running: b.autoStart !== false, connections: 4, startedAt: iso(Date.now()) };
  cf.connectors.push(c); emit("cloudflare", { kind: "status" });
  if (c.autoStart) for (const s of edgeServers()) if (s.online) setTimeout(() => edgeSync(s), 300); // edge nodes run a copy
  return { ok: true, connector: cfConnectorView(c), startError: null };
});
R("DELETE", "/api/cloudflare/connectors/:id", (p) => {
  const c = cf.connectors.find((x) => x.id === p.id) || err(404, "No such connector.");
  cf.connectors = cf.connectors.filter((x) => x !== c);
  if (c.cfId && cf.account.connected) cf.spare.push({ id: c.cfId, name: c.name, status: "inactive" }); // the tunnel stays in the account
  emit("cloudflare", { kind: "status" }); return { ok: true, note: "The tunnel itself stays in your Cloudflare account." };
});
R("POST", "/api/cloudflare/reset", () => {
  const removed = ["Cloudflare login", ...cf.connectors.map((c) => `Connector token: ${c.name}`)];
  cf.connectors.length = 0; cf.account.connected = false; cf.sources = []; cf.panel = null; emit("cloudflare", { kind: "status" });
  return { ok: true, removed, remaining: [] };
});
R("GET", "/api/cloudflare/connectors/:id/logs", (p) => { const c = cf.connectors.find((x) => x.id === p.id) || err(404, "No such connector.");
  return { lines: c.running ? [`${iso(Date.now() - 60e3)} INF Starting tunnel tunnelID=${c.cfId}`, ...[0, 1, 2, 3].slice(0, c.connections).map((i) => `${iso(Date.now() - 50e3 + i * 1e3)} INF Registered tunnel connection connIndex=${i} location=fra0${i + 1} protocol=quic`)] : [] }; });
R("POST", "/api/cloudflare/connectors/:id/:act", (p) => {
  const c = cf.connectors.find((x) => x.id === p.id) || err(404, "No such connector.");
  if (p.act === "stop") c.running = false;
  else if (p.act === "start" || p.act === "restart") { c.running = true; c.connections = 4; c.startedAt = iso(Date.now()); }
  else err(404, "Unknown action.");
  emit("cloudflare", { kind: "status" }); return cfConnectorView(c);
});
R("PATCH", "/api/cloudflare/connectors/:id", (p, b) => {
  const c = Object.assign(cf.connectors.find((x) => x.id === p.id) || err(404, "No such connector."), pick(b, ["name", "autoStart"]));
  for (const s of edgeServers()) if (s.online) setTimeout(() => edgeSync(s), 300); // the edge set of connectors changed
  emit("cloudflare", { kind: "status" }); return cfConnectorView(c);
});
R("GET", "/api/cluster/ha", () => {
  const conns = edgeConnectors();
  const mainUp = conns.some((c) => c.running && c.connections > 0);
  const edges = edgeServers().map((s) => ({ serverId: s.id, name: s.name, online: !!s.online, inSync: !!s.edgeStatus?.inSync,
    tunnelConnected: !!(s.online && (s.edgeStatus?.connectors || []).some((c) => c.active && c.readyConnections > 0)) }));
  const warnings = [];
  if (conns.length && !edges.some((e) => e.online && e.tunnelConnected)) warnings.push("The Cloudflare Tunnel runs only on the main server.");
  for (const s of edgeServers()) {
    if (!s.online) warnings.push(`Edge node ${s.name} is offline.`);
    else if (s.edgeStatus?.error) warnings.push(`Edge node ${s.name} couldn't apply its configuration: ${s.edgeStatus.error}`);
    for (const x of s.edgeStatus?.shims || []) if (!x.ok) warnings.push(`On ${s.name}, the ${x.name} shim can't reach the main server (${x.error || "no answer"}).`);
  }
  return { edges, tunnelReplicasOnline: (mainUp ? 1 : 0) + edges.filter((e) => e.online && e.tunnelConnected).length, connectors: conns.length,
    mainOnlySites: db.sites.filter((x) => targets(x).length === 1 && targets(x)[0] === "main").map((x) => ({ id: x.id, name: x.name })), warnings };
});

// panel failover (docs/HA.md, Phase 2)
const panelNodes = () => db.servers.filter((x) => x.panel?.enabled);
function haCanEnable() {
  if (flags.haOpen) return { ok: true, reason: null };
  const on = db.servers.filter((x) => x.enabled !== false);
  if (on.length < 3) return { ok: false, reason: "Panel nodes need at least 3 servers, so a majority can still vote when one is down." };
  const bad = on.find((x) => x.role !== "main" && (!x.online || (x.agentVersion || "0") < "3.2.0"));
  if (bad) return { ok: false, reason: `${bad.name} must be online and run agent 3.2.0 or newer before you add a panel node.` };
  return { ok: true, reason: null };
}
// failover speed (3.10) — the same formula as shared/ha-timing.mjs (that file is not served to the browser)
let failoverSeconds = 15;
function foSummary(sec) {
  const T = sec * 1000, r100 = (n) => Math.round(n / 100) * 100, cl = (n, a, b) => Math.min(b, Math.max(a, n)), s1 = (ms) => Math.round(ms / 100) / 10;
  const H = cl(r100(T / 15), 1000, 5000), L = cl(r100(0.45 * T), 3000, 180000), M = Math.max(1000, r100(L / 5)), D = Math.max(3000, r100(T / 3));
  const probe = Math.max(500, Math.round(H / 2)), take = L + H + Math.min(3000, Math.round(H / 2)) + 500;
  return { failoverSeconds: sec, panelTakeoverSeconds: s1(take), databaseFailoverSeconds: s1(Math.max(take, D) + 2 * probe + 2200), heartbeatSeconds: s1(H),
    blipToleranceSeconds: s1(Math.max(0, Math.min(L - M - 2 * H, D))), leaseSeconds: s1(L), detectSeconds: s1(D), min: 10, max: 300, default: 15 };
}
const foCheck = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 10 && n <= 300 ? n : err(400, "failoverSeconds must be a whole number of seconds from 10 to 300."); };
R("GET", "/api/ha/settings", (p, b, q) => (q.failoverSeconds !== undefined ? { ...foSummary(foCheck(q.failoverSeconds)), preview: true } : foSummary(failoverSeconds)));
R("PATCH", "/api/ha/settings", (p, b) => {
  const v = foCheck(b.failoverSeconds);
  if (v !== failoverSeconds) { activity("ha.failover-speed", "ha", { id: "failover", name: "Failover speed" }, `${failoverSeconds} s → ${v} s`); failoverSeconds = v; emit("ha", { failoverSeconds: v }); }
  return foSummary(v);
});

function haView() {
  const voters = db.servers.filter((x) => x.enabled !== false);
  const majority = Math.floor(voters.length / 2) + 1;
  const votes = voters.map((x) => ({ serverId: x.id, name: x.name, votedFor: x.online ? ha.leaderId : null, leaseLeftMs: x.online ? 9000 + Math.round(Math.random() * 3000) : 0, reachable: !!x.online }));
  const nodes = panelNodes().map((x) => ({ serverId: x.id, name: x.name, role: x.id === ha.leaderId ? "leader" : "follower", directUrl: x.panel.directUrl, online: !!x.online,
    version: { term: ha.term, seq: 4182 }, panelVersion: "3.10.0", lagMs: x.id === ha.leaderId ? 0 : 400, codeInSync: true }));
  const warnings = voters.filter((x) => !x.online).map((x) => `${x.name} is offline, so it can't vote. The panel keeps running while ${majority} of ${voters.length} servers vote.`);
  return { enabled: ha.enabled, armed: ha.armed, leaderId: ha.leaderId, term: ha.term, localServerId: ha.leaderId, majority, voters: voters.length,
    votes, nodes, committed: { term: ha.term, seq: 4182 }, warnings, canEnable: haCanEnable(), failover: foSummary(failoverSeconds) };
}
R("GET", "/api/ha", () => haView());
R("POST", "/api/ha/handover", (p, b) => {
  const t = db.servers.find((x) => x.id === b.serverId);
  if (!ha.enabled) err(409, "Panel failover is off.");
  if (!t?.panel?.enabled) err(400, "That server isn't a panel node.");
  if (t.id === ha.leaderId) err(409, `${t.name} already runs the active panel.`);
  if (!t.online) err(409, `${t.name} is offline.`);
  // Simulated switch: the API answers 503 { haSwitching } until the new leader takes over at ~3 s.
  ha.switchingUntil = Date.now() + 3000;
  setTimeout(() => {
    ha.leaderId = t.id; ha.term += 1;
    activity("ha.handover", "server", t, "Now the active panel");
    emit("ha", { leaderId: ha.leaderId, term: ha.term });
    for (const x of panelNodes()) emit("server", serverView(x));
  }, 3000);
  return { ok: true };
});
R("POST", "/api/servers/:id/panel", (p, b) => {
  const s = find("servers", p.id);
  if (s.role === "main") err(400, "The main server is always a panel node.");
  const enabled = !!b.enabled;
  if (enabled) {
    if (s.panel?.enabled) err(409, `${s.name} is already a panel node.`);
    if (!s.edge?.enabled) err(400, "Turn on Edge node first. Panel nodes must be edges.");
    if (!s.online) err(409, `${s.name} is offline.`);
    const c = haCanEnable(); if (!c.ok) err(409, c.reason);
  } else {
    if (!s.panel?.enabled) err(409, `${s.name} isn't a panel node.`);
    if (s.id === ha.leaderId) err(409, "This server runs the active panel. Make another panel node active first.");
  }
  activity(enabled ? "server.panel.add" : "server.panel.remove", "server", s);
  const dir = `http://${s.privateHost || s.host}:4000`;
  return runJob({ type: enabled ? "panel.install" : "panel.remove", title: `${enabled ? "Install the panel on" : "Remove the panel from"} ${s.name}`, serverId: s.id }, {
    lines: enabled
      ? ["▸ Downloading the panel code from the active panel (/ha/code)", "  sha256 ok · 2,184 files", "▸ Unpacking to /opt/fcc", "▸ Writing /var/lib/fcc/ha-local.json", "▸ Writing fcc.service", "  systemctl enable --now fcc", `▸ ufw: allow 4000 from ${db.servers.filter((x) => x.id !== s.id).map((x) => x.privateHost || x.host).join(", ")}`, "▸ Waiting for the first copy of the panel data", "  replicated 9 files", "✓ Standby panel running"]
      : ["▸ systemctl disable --now fcc", "▸ Removing fcc.service and /opt/fcc", `▸ Kept the panel data in /var/lib/fcc.removed-${iso(Date.now()).slice(0, 10)} (it holds secrets)`, "✓ Panel node removed"],
    onDone() {
      s.panel = enabled ? { enabled: true, directUrl: dir } : null;
      ha.enabled = panelNodes().some((x) => x.role !== "main");
      if (ha.enabled && !ha.leaderId) ha.leaderId = "main";
      emit("server", serverView(s)); emit("ha", { leaderId: ha.leaderId });
      return enabled ? { installed: true, version: "3.8.0" } : { removed: true };
    },
  });
});
// Databases only answer here while main runs the active panel (flags.dbDown simulates the opposite).
const mysqlSettings = { publicHostOverride: "", mainSitesVia: "panel" };
function mysqlSettingsView() {
  const host = mysqlSettings.publicHostOverride || "10.0.0.10";
  return { publicHost: host, publicHostOverride: mysqlSettings.publicHostOverride, publicHostDefault: "10.0.0.10", publicHostSource: "the main server's private address",
    mainSitesVia: mysqlSettings.mainSitesVia, mainSitesHost: mysqlSettings.mainSitesVia === "panel" ? host : "127.0.0.1", port: 3306, bindAddress: db.mysql.bindAddress,
    bindConfigFile: "/etc/mysql/mysql.conf.d/zz-fcc-remote.cnf", sitesUsingDatabases: db.sites.filter((x) => (x.linkedDatabaseIds || []).length).length, dryRun: false };
}
R("GET", "/api/mysql/settings", () => (flags.dbDown ? { available: false, reason: DB_REASON } : mysqlSettingsView()));
R("PUT", "/api/mysql/settings", (p, b) => {
  const changed = [];
  if (typeof b.publicHost === "string" && b.publicHost !== mysqlSettings.publicHostOverride) { mysqlSettings.publicHostOverride = b.publicHost; changed.push("publicHost"); }
  if (b.mainSitesVia && b.mainSitesVia !== mysqlSettings.mainSitesVia) { mysqlSettings.mainSitesVia = b.mainSitesVia; changed.push("mainSitesVia"); }
  if (changed.length) activity("mysql.settings", "settings", { id: "mysql", name: "Database host" }, changed.join(", "));
  return { ...mysqlSettingsView(), changed, jobs: [] };
});

/* database replication (docs/HA.md, Phase 3)
   ?mockrepl=on (default) | off | seeding | syncing | broken | promoted | rebuild | down
   syncing: replication being turned on, live — preparing → copying 5 databases → catching up → in sync, ~40 s from page load
   on: main → fra-agent-1, lag 0 · broken: SQL thread stopped with an error · promoted: fra-agent-1 took over, fcc-main needs a rebuild
   rebuild: like promoted, but fcc-main is back online and can be rebuilt · down: main unreachable for 42 s, failover pending
   Or from the console: fccMock.repl("broken"), then reload the view. */
const replFlag = (() => { try { const q = new URLSearchParams(location.search); if (q.has("mockrepl")) sessionStorage.setItem("fcc.mock.repl", q.get("mockrepl")); return sessionStorage.getItem("fcc.mock.repl") || "on"; } catch { return "on"; } })();
const repl = { enabled: true, mode: "auto", flavor: "mysql", primary: "main", replica: "srv_fra1", state: "replicating", lag: 0, io: true, sql: true, lastError: null,
  seededAt: ago(6 * DAY), needsRebuild: [], downMs: 0, history: [
    { at: ago(6 * DAY + 40 * MIN), event: "enabled", detail: "Replica fra-agent-1 · automatic failover" },
    { at: ago(6 * DAY + 22 * MIN), event: "seeded", detail: "5 databases copied to fra-agent-1 (2.4 GB)" },
  ] };
const hist = (event, detail) => { repl.history.unshift({ at: iso(Date.now()), event, detail }); repl.history = repl.history.slice(0, 50); };
const srvName = (id) => db.servers.find((x) => x.id === id)?.name || id;
if (replFlag === "off") Object.assign(repl, { enabled: false, state: "off", replica: null, history: [] });
if (replFlag === "seeding") Object.assign(repl, { state: "seeding", lag: null, io: false, sql: false, seededAt: null, history: [{ at: ago(3 * MIN), event: "enabled", detail: "Replica fra-agent-1 · automatic failover" }] });
if (replFlag === "broken") {
  Object.assign(repl, { state: "broken", lag: null, sql: false, lastError: "Error 'Duplicate entry '1042' for key 'orders.PRIMARY'' on query. Default database: 'acme_prod'. Query: 'INSERT INTO orders …'" });
  repl.history.unshift({ at: ago(14 * MIN), event: "broken", detail: "SQL thread stopped with error 1062 on fra-agent-1" });
}
if (replFlag === "promoted") {
  Object.assign(repl, { primary: "srv_fra1", replica: null, state: "promoted", needsRebuild: ["main"] });
  repl.history.unshift({ at: ago(26 * MIN), event: "fenced", detail: "fcc-main set to read-only" }, { at: ago(27 * MIN), event: "promoted", detail: "fcc-main was unreachable for 60 s · fra-agent-1 is the primary" });
}
if (replFlag === "rebuild") { // promoted, and fcc-main is back online: ready to be rebuilt as the replica
  Object.assign(repl, { primary: "srv_fra1", replica: null, state: "needs-rebuild", needsRebuild: ["main"], mainBack: true });
  repl.history.unshift({ at: ago(3 * HOUR + 9 * MIN), event: "fenced", detail: "fcc-main set to read-only" }, { at: ago(3 * HOUR + 10 * MIN), event: "promoted", detail: "fcc-main was unreachable for 60 s · fra-agent-1 is the primary" });
}
if (replFlag === "down") repl.downMs = 42000;

/* syncing (3.9.2 progress): the whole sequence on a timeline, pushed over SSE `mysql-ha` every 2 s like the panel. */
const SYNC_T = { prep: 4000, copy: 24000, catchUp: 11000 };
const SYNC_DBS = [["acme_prod", 1.4 * GB], ["northwind", 640 * MB], ["acme_staging", 221 * MB], ["wp_blog", 96 * MB], ["northwind_queue", 38 * MB]];
const SYNC_BEHIND = 1480;
let sync = null, syncTimer = null;
function syncProgress() {
  if (!sync) return null;
  const t = Date.now() - sync.t0, base = { kind: "enable", replicaServerId: sync.replica, replicaName: srvName(sync.replica), startedAt: iso(sync.t0), updatedAt: iso(Date.now()) };
  if (t < SYNC_T.prep) return { ...base, phase: "preparing", percent: null, etaSeconds: null };
  if (t < SYNC_T.prep + SYNC_T.copy) {
    const el = (t - SYNC_T.prep) / 1000, f = el / (SYNC_T.copy / 1000);
    const total = SYNC_DBS.reduce((a, [, b]) => a + b, 0), done = Math.round(total * (f + 0.03 * Math.sin(el)) * 0.995);
    let acc = 0, i = 0;
    for (; i < SYNC_DBS.length - 1; i++) { if (done < acc + SYNC_DBS[i][1]) break; acc += SYNC_DBS[i][1]; }
    const rate = done / Math.max(1, el), known = el >= 4;
    return { ...base, phase: "copying", percent: el < 1.5 ? null : Math.min(99, Math.floor((done / total) * 100)), bytesDone: done, bytesEstimate: total, rateBps: known ? Math.round(rate) : null,
      etaSeconds: known ? Math.max(1, Math.round((total - done) / rate)) : null, database: SYNC_DBS[i][0], databaseIndex: i + 1, databasesDone: i, databasesTotal: SYNC_DBS.length };
  }
  if (t < SYNC_T.prep + SYNC_T.copy + SYNC_T.catchUp) {
    const el = (t - SYNC_T.prep - SYNC_T.copy) / 1000, f = el / (SYNC_T.catchUp / 1000);
    const behind = Math.max(1, Math.ceil(SYNC_BEHIND * (1 - f) ** 1.25)), shrink = (SYNC_BEHIND - behind) / Math.max(0.5, el);
    return { ...base, phase: "catching-up", transactionsBehind: el < 1 ? null : behind, lagSeconds: Math.max(1, Math.round(40 * (1 - f))), percent: el < 1 ? null : Math.min(99, Math.floor(((SYNC_BEHIND - behind) / SYNC_BEHIND) * 100)),
      etaSeconds: el >= 3 && shrink > 0 ? Math.max(1, Math.round(behind / shrink)) : null };
  }
  return { ...base, phase: "in-sync", percent: 100, etaSeconds: 0, transactionsBehind: 0, lagSeconds: 0, syncedAt: iso(sync.t0 + SYNC_T.prep + SYNC_T.copy + SYNC_T.catchUp) };
}
function syncStep() {
  const p = syncProgress();
  if (!p) return;
  if (p.phase === "preparing") Object.assign(repl, { enabled: false, state: "preparing" });
  else if (p.phase === "copying") Object.assign(repl, { enabled: false, state: "seeding" });
  else {
    if (!repl.enabled) { Object.assign(repl, { enabled: true, replica: sync.replica, state: "replicating", io: true, sql: true, seededAt: iso(Date.now()) }); hist("seeded", `5 databases copied to ${srvName(sync.replica)} (2.4 GB)`); }
    repl.lag = p.lagSeconds;
    if (p.phase === "in-sync") { clearInterval(syncTimer); syncTimer = null; }
  }
  replChanged();
}
function syncStart(replica = "srv_fra1", mode = "auto") {
  sync = { t0: Date.now(), replica };
  Object.assign(repl, { enabled: false, mode, state: "preparing", replica: null, lag: null, io: false, sql: false, lastError: null, seededAt: null, needsRebuild: [], downMs: 0 });
  clearInterval(syncTimer);
  syncTimer = setInterval(syncStep, 2000);
  setTimeout(syncStep, 50);
}
if (replFlag === "syncing") {
  repl.history = [{ at: iso(Date.now()), event: "enabled", detail: "Replica fra-agent-1 · automatic failover" }];
  syncStart();
}
try { window.fccMock.repl = (v = "on") => { try { sessionStorage.setItem("fcc.mock.repl", v); } catch {} }; } catch {}
const replCandidates = () => db.servers.filter((x) => x.role !== "main" && x.id !== repl.primary && x.online && x.enabled !== false && (x.agentVersion || "0") >= "3.3.0")
  .map((x) => ({ serverId: x.id, name: x.name, panelNode: !!x.panel?.enabled, recommended: !!x.panel?.enabled }));
function replView() {
  const prim = db.servers.find((x) => x.id === repl.primary);
  const cands = replCandidates();
  return {
    enabled: repl.enabled, mode: repl.mode, state: repl.state, flavor: repl.flavor,
    primary: { serverId: repl.primary, name: srvName(repl.primary), address: prim ? prim.privateHost || prim.host : null, readOnly: false },
    replica: repl.enabled && repl.replica ? { serverId: repl.replica, name: srvName(repl.replica), state: repl.state === "broken" ? "broken" : repl.state === "seeding" || repl.state === "preparing" ? "seeding" : "replicating",
      lagSeconds: repl.lag, ioRunning: repl.io, sqlRunning: repl.sql, lastError: repl.lastError, seededAt: repl.seededAt } : null,
    needsRebuild: repl.needsRebuild.map((id) => ({ serverId: id, name: srvName(id), online: id === "main" ? !!repl.mainBack : !!db.servers.find((x) => x.id === id)?.online })),
    history: clone(repl.history),
    canEnable: cands.length ? { ok: true, reason: null } : { ok: false, reason: "Add an agent server running agent 3.3.0 or newer to hold the replica." },
    candidates: cands, detect: repl.downMs ? { primaryDownForMs: repl.downMs, detectMs: foSummary(failoverSeconds).detectSeconds * 1000 } : null,
    failover: { ...foSummary(failoverSeconds), detectMs: foSummary(failoverSeconds).detectSeconds * 1000 },
    busy: syncTimer && !repl.enabled ? "enable" : null, progress: syncProgress(),
  };
}
const replChanged = () => emit("mysql-ha", replView());
const replJob = (type, title, lines, onDone) => runJob({ type, title, serverId: repl.replica || null }, { lines, onDone() { onDone(); replChanged(); return replView(); } });
R("GET", "/api/mysql/replication", () => replView());
R("POST", "/api/mysql/replication", (p, b) => {
  if (repl.enabled) err(409, "Replication is already on.");
  const t = replCandidates().find((x) => x.serverId === b.replicaServerId) || err(400, "That server can't hold the replica.");
  if (replFlag === "syncing") { // the live sequence, with its job log
    syncStart(t.serverId, b.mode === "manual" ? "manual" : "auto");
    return runJob({ type: "mysql.replication.enable", title: `Turn on database replication to ${t.name}`, serverId: t.serverId }, { speed: 3800, lines: [
      `Step 1/6 — preparing the primary ${srvName(repl.primary)}…`, `Step 2/6 — setting up the replica on ${t.name} and seeding it from the primary…`,
      `Websites keep working normally while this runs: they keep reading and writing on ${srvName(repl.primary)}.`, "Copying databases · 20% · acme_prod (1 of 5) · 110 MB/s · about 20 s left",
      "Copying databases · 50% · acme_prod (1 of 5) · 108 MB/s · about 10 s left", "Copying databases · 80% · northwind (2 of 5) · 109 MB/s · about 5 s left", "Replica seeded: 5 database(s).",
      "Catching up · 1,480 changes behind", "Step 3/6 … 6/6 — users, grants, fcc-mysql.internal, DB_HOST", "In sync — the replica has every change."] });
  }
  Object.assign(repl, { enabled: true, mode: b.mode === "manual" ? "manual" : "auto", replica: t.serverId, state: "seeding", lag: null, io: false, sql: false, lastError: null, seededAt: null });
  hist("enabled", `Replica ${t.name} · ${repl.mode === "auto" ? "automatic" : "manual"} failover`);
  activity("mysql.replication.enable", "settings", { id: "mysql-ha", name: "Database replication" }, `Replica ${t.name}`);
  replChanged();
  return replJob("mysql.replication.enable", `Turn on database replication to ${t.name}`, [
    `▸ Preparing ${srvName(repl.primary)} as the primary: binlog ROW, GTID on, server_id 1`, "  wrote /etc/mysql/mysql.conf.d/fcc-replication.cnf · restarted MySQL", "▸ Users fcc_repl and fcc_admin created",
    `▸ Setting up ${t.name}: installing mysql-server 8.0`, "▸ Copying 5 databases (mysqldump --single-transaction)", "  acme_prod 1.4 GB · northwind 640 MB · acme_staging 221 MB · wp_blog 96 MB · northwind_queue 38 MB",
    "▸ CHANGE REPLICATION SOURCE TO … SOURCE_AUTO_POSITION=1", "▸ /etc/hosts: fcc-mysql.internal → 10.0.0.10 on 5 servers", "▸ Linked websites: DB_HOST=fcc-mysql.internal (5 env updates queued)", "✓ Replicating · lag 0 s"],
  () => { Object.assign(repl, { state: "replicating", lag: 0, io: true, sql: true, seededAt: iso(Date.now()) }); hist("seeded", `5 databases copied to ${t.name}`); });
});
R("PATCH", "/api/mysql/replication", (p, b) => {
  if (!repl.enabled) err(409, "Replication is off.");
  if (b.mode && b.mode !== repl.mode) { repl.mode = b.mode === "manual" ? "manual" : "auto"; hist("mode", repl.mode === "auto" ? "Automatic failover" : "Manual failover"); replChanged(); }
  return replView();
});
R("POST", "/api/mysql/replication/promote", (p, b) => {
  if (!repl.replica) err(409, "There is no replica to promote.");
  if (repl.state === "broken" && !b.force) err(409, "Replication is broken, so the replica may be missing data. Promote it with force to do it anyway.");
  const from = repl.primary, to = repl.replica;
  return replJob("mysql.replica.promote", `Promote ${srvName(to)} to database primary`, ["▸ Stopping the IO thread", "▸ Waiting for the SQL thread to apply everything received", "▸ RESET REPLICA ALL · read_only=OFF", `▸ /etc/hosts: fcc-mysql.internal → ${srvName(to)} on every server`, `▸ ${srvName(from)} set to read-only`, "✓ Promoted"],
    () => { Object.assign(repl, { primary: to, replica: null, state: "promoted", lastError: null, io: true, sql: true, downMs: 0 }); repl.needsRebuild = [...new Set([...repl.needsRebuild, from])];
      hist("promoted", `${srvName(to)} is the primary${b.force ? " (forced)" : ""}`); hist("fenced", `${srvName(from)} set to read-only`); });
});
R("POST", "/api/mysql/replication/switchover", () => {
  if (!repl.replica || repl.state !== "replicating" || repl.lag !== 0) err(409, "Switching needs a healthy replica with no lag.");
  const from = repl.primary, to = repl.replica;
  return replJob("mysql.switchover", `Switch the database primary to ${srvName(to)}`, [`▸ ${srvName(from)}: read_only=ON`, `▸ Waiting for ${srvName(to)} to apply the primary's transactions`, "  caught up in 1.8 s", `▸ Promoting ${srvName(to)}`, `▸ ${srvName(from)} follows ${srvName(to)} as the replica`, "▸ /etc/hosts updated on every server", "✓ Switched · databases were read-only for 6 s"],
    () => { Object.assign(repl, { primary: to, replica: from, state: "replicating", lag: 0 }); hist("switchover", `${srvName(from)} → ${srvName(to)}`); });
});
R("POST", "/api/mysql/replication/rebuild", (p, b) => {
  if (!repl.needsRebuild.includes(b.serverId)) err(400, "That server doesn't need a rebuild.");
  if (repl.replica) err(409, `${srvName(repl.replica)} is already the replica. Turn replication off and on again to pick another one.`);
  const id = b.serverId, stamp = iso(Date.now()).slice(0, 16).replace(/[-:T]/g, "");
  return replJob("mysql.rebuild", `Rebuild ${srvName(id)} as the database replica`, [`▸ Safety dump: /var/backups/fcc-mysql-before-rebuild-${stamp}.sql.gz (mode 600)`, "▸ Dropping 5 databases", `▸ Copying 5 databases from ${srvName(repl.primary)}`, "▸ Starting replication (auto-position)", "✓ Replicating · lag 0 s"],
    () => { repl.needsRebuild = repl.needsRebuild.filter((x) => x !== id); Object.assign(repl, { replica: id, state: "replicating", lag: 0, io: true, sql: true, lastError: null, seededAt: iso(Date.now()) }); hist("rebuilt", `${srvName(id)} is the replica again`); });
});
R("DELETE", "/api/mysql/replication", () => {
  if (!repl.enabled) err(409, "Replication is already off.");
  const rep = repl.replica;
  return replJob("mysql.replication.disable", "Turn off database replication", [rep ? `▸ ${srvName(rep)}: STOP REPLICA · RESET REPLICA ALL` : "▸ No replica to stop", "  its copy of the data is kept", "✓ Replication off"],
    () => { Object.assign(repl, { enabled: false, state: "off", replica: null, needsRebuild: [], downMs: 0 }); hist("disabled", rep ? `${srvName(rep)} keeps its copy` : ""); });
});

/* notifications (Settings → Notifications) and cluster alerts (docs/HA.md, Phase 3) */
const notif = {
  enabled: true, configured: true, dryRun: false, api: "messages", accountSid: "AC4f2c9e0b7d1a", from: "+15557654321", authTokenSet: true, authTokenHint: "••••7e1c", authTokenUnreadable: false, problem: null,
  defaults: [{ name: "Jordan", phone: "+15551234567" }, { name: "Sam", phone: "+15559876543" }], lastSend: { ok: true, at: ago(3 * DAY) },
  discord: { testEndpoint: null, webhooks: [{ id: "dwh_ops", name: "#ops", enabled: true, urlHint: "…/9fA2", mention: "@here", last: { ok: true, at: ago(3 * DAY) } }, { id: "dwh_dev", name: "#dev-alerts", enabled: false, urlHint: "…/c71B", mention: "", last: null }] },
  repeatMinutes: 60, notifyRecovery: true, minGapMinutes: 5,
  legal: { brandName: "", contactEmail: "", brandShown: "Forthway", privacyUrl: "https://panel.forthway.dev/legal/privacy", termsUrl: "https://panel.forthway.dev/legal/terms", optInUrl: "https://panel.forthway.dev/sms/signup" },
  cluster: { enabled: true, sms: true, discord: true },
};
const notifView = () => { const { cluster, ...rest } = notif; return clone(rest); };
R("GET", "/api/notifications/settings", () => notifView());
R("PUT", "/api/notifications/settings", (p, b) => {
  const { authToken, clearAuthToken, legal, ...rest } = b;
  Object.assign(notif, pick(rest, ["enabled", "defaults", "accountSid", "from", "repeatMinutes", "notifyRecovery"]));
  if (legal) Object.assign(notif.legal, legal);
  if (authToken) Object.assign(notif, { authTokenSet: true, authTokenHint: "••••" + authToken.slice(-4) });
  if (clearAuthToken) Object.assign(notif, { authTokenSet: false, authTokenHint: "", configured: false });
  emit("monitor", { kind: "notifications" });
  return notifView();
});
R("GET", "/api/notifications/optins", () => ({ items: [] }));
R("POST", "/api/notifications/test", (p, b) => ({ ok: true, to: b.to, messageId: "SM" + hex(32) }));
R("GET", "/api/notifications/cluster", () => clone(notif.cluster));
R("PATCH", "/api/notifications/cluster", (p, b) => {
  Object.assign(notif.cluster, pick(b, ["enabled", "sms", "discord"]));
  activity("notifications.cluster", "settings", { id: "cluster-alerts", name: "Cluster alerts" }, notif.cluster.enabled ? "On" : "Off");
  return clone(notif.cluster);
});
R("POST", "/api/notifications/cluster/test", () => {
  const c = notif.cluster, sent = [];
  if (!c.enabled) return { ok: false, sent, reason: "Cluster alerts are off. Turn them on and save first." };
  if (c.sms && notif.enabled) for (const d of notif.defaults) sent.push({ channel: "sms", to: d.phone, name: d.name, ok: true });
  if (c.discord) for (const w of notif.discord.webhooks.filter((x) => x.enabled)) sent.push({ channel: "discord", to: w.name, ok: true });
  activity("notifications.cluster.test", "settings", { id: "cluster-alerts", name: "Cluster alerts" }, `${sent.length} sent`);
  return { ok: true, sent };
});
R("GET", "/api/phpmyadmin", () => (flags.dbDown ? { available: false, reason: DB_REASON } : err(404, "Mock: no route for GET /api/phpmyadmin")));

// cluster
R("GET", "/api/servers", () => ({ items: db.servers.map(serverView) }));
R("POST", "/api/servers", (p, b) => {
  if (!b.name || !b.host) err(400, "Name and host are required.");
  const s = { id: nid("srv"), name: b.name, role: "worker", host: b.host, privateHost: b.privateHost || null, weight: b.weight || 1, enabled: true, lbEligible: b.lbEligible !== false, agentVersion: null, lastSeenAt: null,
    online: false, info: null, metrics: null, createdAt: iso(Date.now()), edge: { enabled: !!b.edge }, edgeStatus: null };
  db.servers.push(s); activity("server.add", "server", s); emit("server", serverView(s));
  return { server: serverView(s), installCommand: installCmd(s) };
});
const installCmd = (s) => `curl -fsSL '${db.settings.panelUrl}/install/node.sh?server=${s.id}&token=fcc_${hex(40)}' | sudo bash`;
R("GET", "/api/servers/:id", (p) => serverView(find("servers", p.id)));
R("PATCH", "/api/servers/:id", (p, b) => {
  const s0 = find("servers", p.id);
  if ("edge" in b && s0.role === "main") err(400, "The main server is always an edge.");
  const s = Object.assign(s0, pick(b, ["name", "host", "privateHost", "weight", "enabled", "lbEligible"]));
  if ("edge" in b && !!b.edge !== !!s.edge?.enabled) {
    s.edge = { enabled: !!b.edge };
    s.edgeStatus = null;
    if (s.edge.enabled && s.online) setTimeout(() => edgeSync(s), 400);
  }
  activity("server.update", "server", s); emit("server", serverView(s)); return serverView(s);
});
R("POST", "/api/servers/:id/edge/sync", (p) => {
  const s = find("servers", p.id);
  if (s.role === "main") err(400, "The main server applies its configuration itself.");
  if (!s.online) err(409, `${s.name} is offline.`);
  return edgeSync(s);
});
R("DELETE", "/api/servers/:id", (p) => {
  const s = find("servers", p.id);
  if (s.id === "main") err(409, "The main server can't be removed.");
  const n = db.sites.filter((x) => targets(x).includes(s.id));
  if (n.length) err(409, `${n.length} website(s) still run on ${s.name}: ${n.map((x) => x.name).join(", ")}. Move them first.`);
  db.servers = db.servers.filter((x) => x.id !== s.id); activity("server.remove", "server", s); emit("server", { id: s.id, deleted: true }); return { ok: true };
});
// Change the main server (3.12.0): the checklist only; the switch itself needs real servers.
R("GET", "/api/servers/:id/make-main", (p) => {
  const s = find("servers", p.id), old = find("servers", "main");
  if (s.id === "main") err(400, "This server is already the main server.");
  const onOld = db.sites.filter((x) => targets(x).includes("main"));
  const steps = [
    s.panel?.enabled ? { id: "active", state: "ok", title: `${s.name} runs the active panel` } : { id: "panel", state: "todo", title: `Make ${s.name} a panel node`, detail: `The new main server must already run the panel: use “Make panel node” on ${s.name}.` },
    onOld.length ? { id: "sites", state: "blocked", title: `Move ${onOld.length} website(s) off ${old.name}`, detail: `${onOld.map((x) => x.name).join(", ")} — website → Settings → Hosting.` } : { id: "sites", state: "ok", title: `No websites run only on ${old.name}` },
    { id: "databases", state: "auto", title: "Turn off database replication", detail: `${old.name} is the replica. Replication is turned off (the primary keeps every database). Turn it on again with another server afterwards.` },
    { id: "transfer", state: "auto", title: `Copy 6 backup archives (412.3 MB) and the Let's Encrypt certificates from ${old.name}`, detail: "Panel data, settings, releases and secrets are already here (they are replicated to every panel node)." },
    { id: "agents", state: "auto", title: `Point the agents at http://${s.host}:4000` },
    { id: "retire", state: "auto", title: `Retire ${old.name}`, detail: "It stops and disables its panel and keeps its data folder (renamed — it holds secrets). Its websites' files, nginx and MySQL are left alone: shut the machine down when you are ready." },
  ];
  return { ok: !steps.some((x) => x.state === "blocked" || x.state === "todo"), target: { id: s.id, name: s.name, host: s.host }, oldMain: { id: "main", name: old.name, host: old.host, online: true }, steps, transfer: { backups: 6, bytes: 432340000, letsencrypt: true, oldOnline: true } };
});
R("POST", "/api/servers/:id/make-main", () => err(409, "Changing the main server needs real servers — it isn't simulated in the demo."));
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
R("GET", "/api/mysql/status", () => (flags.dbDown ? { available: false, reason: DB_REASON } : clone(db.mysql)));
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
R("GET", "/api/backups/settings", () => ({ ...clone(db.backupSettings), ...(flags.dbDown ? { database: { ...db.backupSettings.database, available: false, reason: DB_REASON } } : {}), nextRun: { database: iso(Math.ceil(Date.now() / DAY) * DAY + 3 * HOUR), server: iso(Date.now() + 2.4 * DAY) }, lastRun: { database: ago(21 * HOUR), server: ago(4.6 * DAY) },
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

/* ───────── Docker runtime: move a website in / out of its container ───────── */
R("POST", "/api/sites/:id/migrate", (p, b) => {
  const s = find("sites", p.id);
  const to = b.to === "legacy" ? "legacy" : "docker";
  if (s.type === "static") err(400, "Static websites have no runtime to move.");
  if (s.runtime === to) err(409, `${s.name} already runs ${to === "docker" ? "in Docker" : "the legacy way"}.`);
  busy(s);
  const names = targets(s).map((sid) => db.servers.find((x) => x.id === sid)?.name || sid);
  const lines = to === "docker"
    ? [...names.flatMap((n) => [`━━ ${n} ━━`, "▸ Checking Docker", "  docker 27.3.1 running", "▸ Pulling node:20-bookworm-slim", "  up to date"]), "▸ Allocating container user", `  uid ${20000 + db.sites.indexOf(s) + 3}`,
      "▸ Installing and building inside the container", "  added 612 packages in 24s", "  ✓ Compiled successfully", "▸ Stopping the pm2 process", "▸ Starting container fcc-" + s.id, "▸ Waiting for health check", "  200 OK in 1.4s", `✓ ${s.name} now runs in Docker`]
    : ["▸ Stopping container fcc-" + s.id, "▸ Removing the container", "▸ Starting under pm2", "▸ Waiting for health check", "  200 OK in 2.1s", `✓ ${s.name} runs the legacy way again`];
  activity("site.migrate", "site", s, to === "docker" ? "Moved to Docker" : "Moved back to legacy");
  return runJob({ type: "site.migrate", title: to === "docker" ? `Move ${s.name} to Docker` : `Move ${s.name} back to legacy`, siteId: s.id, projectId: s.projectId }, { lines, speed: 220, onDone() {
    s.runtime = to;
    if (to === "docker" && !s.container) s.container = { uid: 20000 + db.sites.indexOf(s) + 3, gid: 20000 + db.sites.indexOf(s) + 3, image: "node:20-bookworm-slim", memoryMb: 512, cpus: 1 };
    emit("site", siteView(s));
  } });
});

/* ───────── Commit testing (docs/DOCKER-AND-TESTS.md §2) ─────────
   Runs are simulated: a run steps through ~32 ticks (~1.15 s each) and emits `testrun`
   with the full run on every change, like the real panel. A release's first live run is
   "not ready"; running it again after that passes, so both verdict reveals can be seen. */
const tester = { tokenSet: true, model: "sonnet", maxMinutes: 30, image: "fcc-tester:1", serverId: "srv_fra1" };
const testEnv = { site_acmeweb: { STRIPE_SECRET_KEY: "sk_test_51Hx…", STRIPE_PUBLISHABLE_KEY: "pk_test_51Hx…", STRIPE_WEBHOOK_SECRET: "whsec_test…" } };
db.testRuns = [];
const testTimers = new Map();

const TEST_PLAN = [
  { cat: "setup", title: "App installs and builds", ok: "npm ci + next build finished in 41 s", tool: "npm run build" },
  { cat: "setup", title: "Health check answers", ok: "GET /api/health → 200 in 38 ms", tool: "curl -s http://site:3000/api/health" },
  { cat: "config", title: "Required variables are set", ok: "Every key in .env.example has a value", tool: "read .env.example", think: "The app expects 14 variables; checking each is present in the copy." },
  { cat: "database", title: "Migrations run on an empty database", ok: "14 migrations applied, 22 tables", tool: "npx prisma migrate deploy" },
  { cat: "database", title: "Data survives a restart", ok: "Order created before restart is still there", tool: "docker restart fcc-t-site" },
  { cat: "auth", title: "Sign up with email", ok: "Account created; welcome email captured", tool: "browser: open /signup", think: "Using a throw-away address — the mail catcher will receive the welcome email." },
  { cat: "auth", title: "Sign in and sign out", ok: "Session cookie set and cleared", tool: "browser: fill #email, #password → Sign in" },
  { cat: "auth", title: "Password reset link works", ok: "Reset email arrives and the link signs in", tool: "mail: GET /api/messages?to=test-7f3@example.test", bad: { status: "warn", detail: "Works, but the reset link never expires" } },
  { cat: "features", title: "Browse products and search", ok: "Search for “chair” returns 6 results in 120 ms", tool: "browser: open /search?q=chair" },
  { cat: "features", title: "Cart keeps items and updates totals", ok: "3 items, quantities and total update without reload", tool: "browser: click “Add to cart” ×3", think: "The cart total updates live. Next: change a quantity and remove an item." },
  { cat: "features", title: "Checkout page works on a phone", ok: "No horizontal scroll at 375 px; all buttons reachable", tool: "browser: set viewport 375×812" },
  { cat: "payments", title: "Card payment in Stripe test mode", ok: "Paid with 4242 4242 4242 4242 — order #1001 created", tool: "browser: Stripe Checkout → pay with test card", think: "Stripe is in test mode with the test keys from the panel. Paying with the standard test card." },
  { cat: "payments", title: "Webhook marks the order paid", ok: "checkout.session.completed → order #1001 is “paid”", tool: "stripe trigger checkout.session.completed", bad: { status: "fail", detail: "Webhook answered 400: signature verification failed" } },
  { cat: "payments", title: "Declined card shows an error", ok: "4000 0000 0000 0002 → “Your card was declined.”", tool: "browser: pay with 4000 0000 0000 0002" },
  { cat: "security", title: "Session cookie is HttpOnly and Secure", ok: "sid: HttpOnly; Secure; SameSite=Lax", tool: "inspect Set-Cookie on POST /api/login" },
  { cat: "security", title: "Admin pages need sign-in", ok: "/admin redirects to /login when signed out", tool: "curl -I http://site:3000/admin" },
  { cat: "security", title: "Sign-in is rate limited", ok: "429 after 10 attempts in a minute", tool: "20 × POST /api/login with a wrong password", bad: { status: "warn", detail: "No limit: 50 wrong passwords in 8 s were all answered" } },
  { cat: "config", title: "No secrets in the browser bundle", ok: "No sk_ / whsec_ / DATABASE_URL in .next/static", tool: "grep -r \"sk_\\|whsec_\" .next/static" },
];
const FINDINGS = {
  bad: [
    { severity: "high", category: "payments", title: "Paid orders never get marked as paid", plain: "Customers can pay, but the shop never hears back from Stripe that the money arrived. Their orders stay stuck on \u201cpending\u201d, so they won't get confirmations and you won't know which orders to fulfil.", location: "app/api/stripe/webhook/route.ts:18",
      detail: "The webhook reads the raw body after it has been parsed as JSON, so the signature check always fails. Orders stay “pending” after a successful payment.",
      fix: "Read the body with `await req.text()` before `stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET)`, and don't JSON-parse it first." },
    { severity: "medium", category: "security", title: "Anyone can guess passwords as fast as they like", plain: "The sign-in page never slows down repeated wrong passwords. Someone could try thousands of guesses and break into accounts that use weak passwords.", location: "app/api/login/route.ts",
      detail: "50 wrong passwords in 8 seconds were all answered, so passwords can be guessed quickly.",
      fix: "Limit attempts per IP and per email (e.g. 10 per minute) and answer 429 above that. A small in-memory or MySQL counter is enough for one server." },
    { severity: "low", category: "auth", title: "Old password-reset links keep working", plain: "A password-reset link still works even after it has been used. If an old reset email ever falls into the wrong hands, it could be used to take over that account.", location: "lib/auth/reset.ts:41",
      detail: "A reset link from the test still worked after the password had been changed.",
      fix: "Store an expiry (e.g. 1 hour) with the token and delete it once used." },
    { severity: "info", category: "features", title: "Product images are bigger than phones need", plain: "Phones download full-size product photos, which makes the shop slower on mobile data. Not a safety problem, just speed.", location: "components/ProductCard.tsx",
      detail: "Each card downloads a 1600 px image even at 375 px wide.", fix: "Use next/image with `sizes=\"(max-width: 640px) 50vw, 25vw\"`." },
  ],
  good: [
    { severity: "low", category: "security", title: "Sign-in allows quite a lot of attempts", plain: "The sign-in page does slow down guessing, but it allows more tries than a real person needs. Tightening it makes password guessing even harder.", location: "middleware.ts", detail: "Sign-in allows 30 attempts a minute per IP.", fix: "10 a minute is plenty for people and slows down guessing." },
    { severity: "info", category: "features", title: "Product images are bigger than phones need", plain: "Phones download full-size product photos, which makes the shop slower on mobile data. Not a safety problem, just speed.", location: "components/ProductCard.tsx",
      detail: "Each card downloads a 1600 px image even at 375 px wide.", fix: "Use next/image with `sizes=\"(max-width: 640px) 50vw, 25vw\"`." },
  ],
};
const PREP = [
  ["Creating an isolated test network", "Network fcc-t-%id created (internal)"],
  ["Starting a throw-away MySQL database", "mysql:8.0 started with random credentials; DATABASE_URL re-pointed"],
  ["Starting the mail catcher", "SMTP_HOST / MAIL_* re-pointed at the catcher: no real email can leave"],
  ["Installing and building the release", "npm ci (612 packages) and next build in a --rm container"],
  ["Running migrations", "npm run db:migrate on the empty database"],
  ["Starting the copy of the site", "Site answering on http://site:3000 — live payment keys removed, 3 test variables applied"],
];

function testView(r) { return clone(r); }
function testSummary(r) {
  const { activity: _a, ...rest } = r;
  const sev = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of r.findings || []) if (f.severity in sev) sev[f.severity]++;
  const cs = r.checks || [];
  return clone({ ...rest, counts: { checks: cs.length, passed: cs.filter((c) => c.status === "pass").length, warned: cs.filter((c) => c.status === "warn").length, failed: cs.filter((c) => c.status === "fail").length, findings: (r.findings || []).length, bySeverity: sev } });
}
const emitRun = (r) => emit("testrun", testView(r));

/** The steps of a simulated run; each is applied at one tick. */
function testScript(r, variant) {
  const plan = TEST_PLAN.map((x, i) => ({ ...x, id: `chk_${i + 1}` }));
  const say = (at, kind, text) => { r.activity.push({ at: iso(at), kind, text }); if (r.activity.length > 300) r.activity.shift(); };
  const steps = [];
  steps.push((at) => { r.status = "preparing"; r.startedAt = iso(at); r.phase = PREP[0][0] + "…"; say(at, "info", `Test run started on ${db.servers.find((x) => x.id === r.serverId)?.name || r.serverId}`); });
  PREP.forEach(([phase, done], i) => steps.push((at) => {
    say(at, "info", done.replace("%id", r.id.slice(-6)));
    r.phase = (PREP[i + 1]?.[0] || "Handing over to Claude Code") + "…";
    if (i === 3) r.env = { url: `http://${r.id.slice(-6)}.test.internal:3000`, database: true, mail: true };
  }));
  steps.push((at) => {
    r.status = "testing"; r.phase = "Claude is reading the app to plan its checks";
    say(at, "tool", "claude -p --output-format stream-json (max 30 min)");
    say(at, "think", "It's a Next.js shop with Stripe checkout, email sign-in and a MySQL database. I'll cover setup, sign-in, the cart, payments and the obvious security basics.");
  });
  steps.push((at) => {
    r.checks = plan.map((x) => ({ id: x.id, category: x.cat, title: x.title, status: "pending", detail: "", startedAt: null, finishedAt: null }));
    say(at, "info", `Checklist written: ${plan.length} checks in ${new Set(plan.map((x) => x.cat)).size} categories`);
  });
  plan.forEach((x, i) => steps.push((at) => {
    const prev = r.checks[i - 1], cur = r.checks[i], p = plan[i - 1];
    if (prev) {
      const res = variant === "bad" && p.bad ? p.bad : variant === "good" && p.bad?.status === "warn" && p.cat === "security" ? { status: "warn", detail: "Limited, but only after 30 attempts a minute" } : { status: "pass", detail: p.ok };
      Object.assign(prev, { status: res.status, detail: res.detail, finishedAt: iso(at) });
      say(at, res.status === "fail" ? "error" : "info", `${res.status === "pass" ? "✓" : res.status === "warn" ? "!" : "✗"} ${p.title}${res.status === "pass" ? "" : ` — ${res.detail}`}`);
      if (res.status !== "pass") {
        const f = FINDINGS[variant].find((y) => y.category === p.cat && !r.findings.some((z) => z.title === y.title));
        if (f) r.findings.push({ id: `fnd_${r.findings.length + 1}`, ...f });
      }
    }
    Object.assign(cur, { status: "running", startedAt: iso(at) });
    r.phase = `${catLabel(x.cat)}: ${x.title.toLowerCase()}`;
    if (x.think) say(at, "think", x.think);
    say(at, "tool", x.tool);
  }));
  steps.push((at) => {
    const last = r.checks[r.checks.length - 1], p = plan[plan.length - 1];
    Object.assign(last, { status: "pass", detail: p.ok, finishedAt: iso(at) });
    say(at, "info", `✓ ${p.title}`);
    r.status = "reporting"; r.phase = "Writing the report";
    say(at, "think", variant === "bad" ? "Payments don't complete: the webhook never confirms an order. That alone means this commit isn't ready." : "Everything that matters works end to end. A couple of small things are worth fixing later.");
  });
  steps.push((at) => {
    for (const f of FINDINGS[variant]) if (!r.findings.some((z) => z.title === f.title)) r.findings.push({ id: `fnd_${r.findings.length + 1}`, ...f });
    say(at, "tool", "fcc-report --final /out/report.json");
  });
  steps.push((at) => {
    r.status = "done"; r.phase = "Finished"; r.finishedAt = iso(at);
    r.verdict = variant === "bad" ? "not_ready" : "ready";
    r.score = variant === "bad" ? 62 : 94;
    r.summary = variant === "bad"
      ? "The site builds, signs people in and takes card payments, but the Stripe webhook rejects every event, so paid orders stay pending. Sign-in also has no rate limit."
      : "Sign-up, sign-in, the cart, checkout and Stripe test payments all work end to end on a fresh database. Two small improvements below; nothing blocks production.";
    r.plainSummary = variant === "bad"
      ? "Don't put this version live yet. The site works and customers can pay, but the shop never finds out the payment went through, so orders stay stuck as \u201cpending\u201d. Fix that first; the sign-in limit is the next most important thing."
      : "This version looks safe to put live. Customers can sign up, shop and pay (tested with Stripe's test cards), and nothing serious turned up. There are two small improvements you can do later.";
    r.usage = { turns: variant === "bad" ? 58 : 47, durationMs: new Date(at) - new Date(r.startedAt) };
    say(at, "info", `Verdict: ${r.verdict === "ready" ? "ready for production" : "not ready"} (${r.score}/100). Test copy removed.`);
  });
  return steps;
}
const catLabel = (c) => ({ setup: "Setup", payments: "Payments", database: "Database", auth: "Sign-in", features: "Features", security: "Security", config: "Config" })[c] || c;

function newRun(s, rel) {
  return {
    id: nid("tst"), siteId: s.id, releaseId: rel.id, serverId: tester.serverId, jobId: null, adminId: me.id,
    commit: rel.github?.sha ? { sha: rel.github.sha, shortSha: rel.github.sha.slice(0, 7), message: rel.github.message || "", author: rel.github.author || null } : rel.commit ? { sha: rel.commit, shortSha: rel.commit, message: "", author: null } : null,
    version: rel.version, status: "queued", phase: "Waiting for a free tester…", verdict: null, score: null, summary: "", checks: [], findings: [], activity: [],
    env: null, usage: null, error: null, createdAt: iso(Date.now()), startedAt: null, finishedAt: null,
  };
}
function startLiveRun(s, rel) {
  const r = newRun(s, rel);
  // Run again after a "not ready" verdict and the fix "worked": the same release now passes.
  const prev = db.testRuns.find((x) => x.releaseId === rel.id && x.status === "done");
  const variant = prev?.verdict === "not_ready" ? "good" : "bad";
  r.jobId = runJob({ type: "site.test", title: `Test ${s.name} ${rel.version}`, siteId: null, projectId: s.projectId }, { lines: ["▸ site.test dispatched to " + (db.servers.find((x) => x.id === r.serverId)?.name || r.serverId)], speed: 400 }).id;
  db.testRuns.unshift(r);
  const steps = testScript(r, variant);
  let i = 0;
  const t = setInterval(() => {
    if (r.status === "cancelled") { clearInterval(t); testTimers.delete(r.id); return; }
    steps[i++](Date.now());
    emitRun(r);
    if (i >= steps.length) { clearInterval(t); testTimers.delete(r.id); }
  }, 1150);
  testTimers.set(r.id, t);
  activity("site.test", "site", s, `Test of ${rel.version}`);
  return r;
}
// Seeded history: runs replayed instantly with past timestamps.
function seedRun(siteId, relIndex, variant, ageMs, { cancelAt, error } = {}) {
  const s = db.sites.find((x) => x.id === siteId);
  const rel = db.releases.filter((x) => x.siteId === siteId)[relIndex];
  if (!s || !rel) return;
  const r = newRun(s, rel);
  r.createdAt = iso(Date.now() - ageMs);
  const steps = testScript(r, variant);
  const n = cancelAt ?? (error ? 4 : steps.length);
  for (let i = 0; i < n; i++) steps[i](Date.now() - ageMs + 2000 + i * 1150 * 9);
  if (cancelAt != null) { r.status = "cancelled"; r.phase = "Cancelled"; r.finishedAt = iso(Date.now() - ageMs + 2000 + n * 1150 * 9); r.checks.forEach((c) => { if (c.status === "running" || c.status === "pending") c.status = "skip"; }); r.activity.push({ at: r.finishedAt, kind: "info", text: `Cancelled by ${me.name}` }); }
  if (error) { r.status = "error"; r.error = error; r.phase = "Failed"; r.finishedAt = iso(Date.now() - ageMs + 2000 + n * 1150 * 9); r.activity.push({ at: r.finishedAt, kind: "error", text: error }); }
  db.testRuns.push(r);
}
seedRun("site_acmeweb", 0, "good", 2 * HOUR);
seedRun("site_acmeweb", 1, "bad", 2.4 * DAY);
seedRun("site_acmeweb", 2, "good", 4.7 * DAY, { cancelAt: 14 });
seedRun("site_acmestg", 0, "bad", 2.6 * DAY, { error: "The copy didn't start: next build exited with code 1 (Type error in app/checkout/page.tsx:88)." });
seedRun("site_nwapi", 0, "good", 5 * HOUR);
db.testRuns.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

const activeRun = (siteId) => db.testRuns.find((x) => x.siteId === siteId && ["queued", "preparing", "testing", "reporting"].includes(x.status));
R("GET", "/api/sites/:id/tests", (p) => { find("sites", p.id); return { items: db.testRuns.filter((x) => x.siteId === p.id).map(testSummary) }; });
R("POST", "/api/sites/:id/tests", (p, b) => {
  const s = find("sites", p.id);
  const owner = s.stagingOf || s.id; // STAGING: a staging copy tests its parent's releases
  const rel = b.releaseId ? find("releases", b.releaseId) : db.releases.find((x) => x.siteId === owner);
  if (!rel || rel.siteId !== owner) err(400, "Pick a release of this website to test.");
  const a = activeRun(s.id);
  if (a) err(409, `A test of ${s.name} is already running.`, { runId: a.id });
  if (!tester.tokenSet) err(400, "Add a Claude Code token in Settings → Website testing first.");
  const r = startLiveRun(s, rel);
  emitRun(r);
  return testView(r);
});
// The Testing page (GET /api/tests): every website's runs + the header stats (panel/lib/site-tests.mjs testStats).
R("GET", "/api/tests", (p, b, q) => {
  const ACTIVE = ["queued", "preparing", "testing", "reporting"];
  const lim = Math.min(Number(q.limit) > 0 ? Number(q.limit) : 100, 500);
  const items = db.testRuns
    .filter((r) => (!q.siteId || r.siteId === q.siteId) && (!q.verdict || r.verdict === q.verdict))
    .filter((r) => !q.status || (q.status === "active" ? ACTIVE.includes(r.status) : q.status === "finished" ? !ACTIVE.includes(r.status) : r.status === q.status))
    .slice(0, lim)
    .map((r) => { const s = db.sites.find((x) => x.id === r.siteId); return { ...testSummary(r), siteName: s?.name || null, siteType: s?.type || null, projectId: s?.projectId || null, projectName: s ? projectName(s.projectId) : null, serverName: db.servers.find((x) => x.id === r.serverId)?.name || r.serverId }; });
  const week = db.testRuns.filter((r) => Date.now() - new Date(r.createdAt) < 7 * DAY);
  const judged = week.filter((r) => r.status === "done" && r.verdict);
  const ready = judged.filter((r) => r.verdict === "ready").length;
  const tested = new Set(db.testRuns.map((r) => r.siteId));
  const never = db.sites.filter((s) => !tested.has(s.id));
  return { items, stats: {
    total: db.testRuns.length, last7d: week.length, judged7d: judged.length, ready7d: ready, notReady7d: judged.length - ready, failed7d: week.filter((r) => r.status === "error").length,
    readyRate: judged.length ? Math.round((ready / judged.length) * 100) : null,
    avgScore: judged.length ? Math.round(judged.reduce((a, r) => a + (r.score || 0), 0) / judged.length) : null,
    active: db.testRuns.filter((r) => ACTIVE.includes(r.status)).length,
    sites: db.sites.length, sitesTested: db.sites.length - never.length, sitesNeverTested: never.length,
    neverTested: never.slice(0, 20).map((s) => ({ id: s.id, name: s.name })),
  } };
});
R("GET", "/api/tests/:id", (p) => testView(find("testRuns", p.id)));
R("POST", "/api/tests/:id/cancel", (p) => {
  const r = find("testRuns", p.id);
  if (["queued", "preparing", "testing", "reporting"].includes(r.status)) {
    clearInterval(testTimers.get(r.id)); testTimers.delete(r.id);
    r.status = "cancelled"; r.phase = "Cancelled"; r.finishedAt = iso(Date.now());
    r.checks.forEach((c) => { if (c.status === "running" || c.status === "pending") c.status = "skip"; });
    r.activity.push({ at: r.finishedAt, kind: "info", text: `Cancelled by ${me.name}. Test containers removed.` });
    emitRun(r);
  }
  return testView(r);
});
R("POST", "/api/tests/:id/deploy", (p) => {
  const r = find("testRuns", p.id);
  if (r.status !== "done") err(409, "Only a finished test can be deployed.");
  const s = find("sites", r.siteId), rel = find("releases", r.releaseId);
  busy(s);
  activity("site.deploy", "site", s, `Tested release ${rel.version}`);
  const tg = targets(s);
  return runJob({ type: "site.deploy", title: `Deploy ${s.name} ${rel.version} (tested)`, siteId: s.id, projectId: s.projectId }, { lines: linesFor("site.deploy", ""), speed: 160, onDone() {
    if (s.currentReleaseId !== rel.id) { s.previousReleaseId = s.currentReleaseId; s.currentReleaseId = rel.id; }
    for (const sid of tg) s.state[sid] = { running: true, healthy: db.servers.find((x) => x.id === sid)?.online, version: rel.version, checkedAt: iso(Date.now()) };
    emit("site", siteView(s));
  } });
});
R("DELETE", "/api/tests/:id", (p) => {
  const r = find("testRuns", p.id);
  if (testTimers.has(r.id)) err(409, "Cancel the test before deleting it.");
  db.testRuns = db.testRuns.filter((x) => x.id !== r.id);
  emit("testrun", { id: r.id, siteId: r.siteId, deleted: true });
  return { ok: true };
});
R("GET", "/api/sites/:id/test-env", (p) => { const s = find("sites", p.id); return { items: Object.keys(testEnv[p.id] || {}).sort().map((key) => ({ key, set: true })), database: testDbPreview(s) }; });
R("PUT", "/api/sites/:id/test-env", (p, b) => {
  const s = find("sites", p.id);
  const env = (testEnv[s.id] ||= {});
  for (const [k, v] of Object.entries(b.env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) err(400, `“${k}” isn't a valid variable name.`);
    if (v === null) delete env[k]; else env[k] = String(v);
  }
  activity("site.test-env", "site", s, `${Object.keys(env).length} test variables`);
  return { items: Object.keys(env).sort().map((key) => ({ key, set: true })) };
});
R("GET", "/api/tester", () => clone(tester));
R("PUT", "/api/tester", (p, b) => {
  if (b.token) tester.tokenSet = true;
  if (b.clearToken) tester.tokenSet = false;
  if (b.model !== undefined) tester.model = String(b.model || "");
  if (b.maxMinutes !== undefined) { const n = Number(b.maxMinutes); if (!(n >= 5 && n <= 180)) err(400, "maxMinutes must be from 5 to 180."); tester.maxMinutes = n; }
  if (b.serverId) { find("servers", b.serverId); tester.serverId = b.serverId; }
  return clone(tester);
});

/* Passkeys (Settings → Passkeys). Adding one needs the real browser prompt, so mock mode can list, rename and remove only. */
const myPasskeys = [
  { id: "pk_mac", name: "MacBook · Safari", createdAt: iso(NOW - 30 * DAY), lastUsedAt: ago(5 * MIN), rpId: "panel.forthway.dev", synced: true, backedUp: true, transports: ["internal", "hybrid"], counterWarning: false, current: true },
  { id: "pk_key", name: "YubiKey 5C", createdAt: iso(NOW - 28 * DAY), lastUsedAt: ago(9 * DAY), rpId: "panel.forthway.dev", synced: false, backedUp: false, transports: ["usb", "nfc"], counterWarning: false, current: false },
];
const passkeyCounts = { adm_1: 2, adm_2: 1 };
const passkeysView = () => ({ items: clone(myPasskeys), rp: { ok: true, rpId: "panel.forthway.dev", origin: "https://panel.forthway.dev" }, canRemove: myPasskeys.length > 1, recoverCmd: "sudo node /opt/fcc/panel/recover.mjs --reset-passkeys" });
R("GET", "/api/me/passkeys", () => passkeysView());
R("PATCH", "/api/me/passkeys/:id", (p, b) => {
  const k = myPasskeys.find((x) => x.id === p.id) || err(404, "Passkey not found.");
  k.name = String(b.name || "").trim().slice(0, 60) || k.name;
  return clone(k);
});
R("DELETE", "/api/me/passkeys/:id", (p) => {
  const i = myPasskeys.findIndex((x) => x.id === p.id);
  if (i === -1) err(404, "Passkey not found.");
  if (myPasskeys.length === 1) err(409, "This is your last passkey — add another before removing it.");
  myPasskeys.splice(i, 1);
  passkeyCounts[me.id] = myPasskeys.length;
  return { ok: true };
});
R("GET", "/api/passkeys/admins", () => ({
  canReset: true,
  items: db.admins.map((a) => ({ ...clone(a), passkeys: passkeyCounts[a.id] || 0, lastUsedAt: a.lastLoginAt, counterWarning: false })),
}));
R("DELETE", "/api/admins/:id/passkeys", (p) => {
  const a = find("admins", p.id);
  const removed = passkeyCounts[a.id] || 0;
  passkeyCounts[a.id] = 0;
  return { ok: true, removed };
});

/* ───────── Uptime monitoring (panel/lib/monitor.mjs) — website Statistics tab, website rows, dashboard ─────────
   Deterministic per site: acme-web has a history of short outages (with text + Discord alerts),
   status-page is down right now, everything else is up. Checks / pause / resume / settings work. */
const MON_DEFAULTS = { intervalSec: 60, timeoutSec: 10, failThreshold: 3, recoverThreshold: 2, expectMin: 200, expectMax: 399, path: "", url: "", smsEnabled: false, recipients: [], includeDefaults: true, repeatMinutes: null, discordEnabled: true, discordSkip: [], paused: false };
const monCfg = {}, monRt = {}, monInc = {};
const monHash = (id) => [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const monRand = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
function monSettings(id) {
  return (monCfg[id] ||= { ...clone(MON_DEFAULTS), pausedAt: null, pausedBy: null, pauseUntil: null, pauseReason: null,
    ...(id === "site_acmeweb" ? { smsEnabled: true, recipients: [{ name: "On-call phone", phone: "+15550104477" }], path: "/api/health" } : {}),
    ...(id === "site_status" ? { smsEnabled: true, discordSkip: [] } : {}) });
}
const monDeployed = (s) => !!s.currentReleaseId || Object.values(s.state || {}).some((x) => x?.releaseId || x?.version);
const monBase = (s) => 38 + (monHash(s.id) % 140);
function monTarget(s) {
  const c = monSettings(s.id);
  if (c.url) return { url: c.url, how: "custom" };
  const p = c.path || s.healthPath || "/";
  const d = (s.domains || [])[0];
  return d ? { url: `${s.ssl?.status === "active" ? "https" : "http"}://${d}${p}`, how: "domain" } : { url: "", how: "none" };
}
function monIncidents(s) {
  if (monInc[s.id]) return monInc[s.id];
  const out = [];
  const alertsFor = (startedAt, endedAt, open) => {
    const c = monSettings(s.id);
    const nums = c.smsEnabled ? [...c.recipients, ...(c.includeDefaults ? notif.defaults : [])] : [];
    const at = (t) => iso(Date.parse(startedAt) + t);
    const list = [];
    for (const n of nums) list.push({ at: at(3 * MIN), channel: "sms", kind: "down", to: n.phone, name: n.name, ok: true });
    list.push({ at: at(3 * MIN + 2000), channel: "discord", kind: "down", to: "#ops", ok: true, attempts: 1 });
    if (open) for (const n of nums) list.push({ at: at(63 * MIN), channel: "sms", kind: "reminder", to: n.phone, name: n.name, ok: n.phone !== "+15559876543", error: n.phone === "+15559876543" ? "Twilio error 21610: the number has opted out (STOP)" : null });
    if (endedAt) { for (const n of nums) list.push({ at: endedAt, channel: "sms", kind: "up", to: n.phone, name: n.name, ok: true }); list.push({ at: endedAt, channel: "discord", kind: "up", to: "#ops", ok: true, attempts: 1 }); }
    return list;
  };
  const add = (agoMs, durMs, cause, extra = {}) => {
    const startedAt = iso(NOW - agoMs), open = durMs == null, endedAt = open ? null : iso(NOW - agoMs + durMs);
    out.push({ id: nid("inc"), siteId: s.id, startedAt, endedAt, cause, lastCause: extra.lastCause || cause, servers: extra.servers || [], gaps: [], endedBy: endedAt ? "check" : null, alerts: alertsFor(startedAt, endedAt, open) });
  };
  if (s.id === "site_acmeweb") {
    add(26 * HOUR, 7 * MIN, "HTTP 502", { servers: ["fra-agent-2"] });
    add(3.2 * DAY, 4 * MIN, "Timed out after 10 s");
    add(9 * DAY, 18 * MIN, "HTTP 503", { lastCause: "Connection refused" });
    add(17 * DAY, 3 * MIN, "HTTP 500");
    add(29 * DAY, 41 * MIN, "Connection refused", { servers: ["fcc-main", "fra-agent-1"] });
    add(44 * DAY, 6 * MIN, "TLS handshake failed");
    add(61 * DAY, 12 * MIN, "HTTP 502");
    add(83 * DAY, 2 * MIN, "Timed out after 10 s");
  }
  if (s.id === "site_status") add(2.6 * HOUR, null, "DNS lookup failed", { lastCause: "Connection refused" });
  return (monInc[s.id] = out);
}
function monRuntime(s) {
  if (monRt[s.id]) return monRt[s.id];
  const down = s.id === "site_status";
  const r = { state: down ? "down" : "up", since: iso(NOW - (down ? 2.6 * HOUR : 26 * HOUR - 7 * MIN)), lastCheck: null };
  r.lastCheck = down ? { at: ago(25e3), ok: false, status: null, ms: null, error: "Connection refused" } : { at: ago(18e3), ok: true, status: 200, ms: monBase(s) + 9, error: null };
  return (monRt[s.id] = r);
}
function monState(s) {
  const c = monSettings(s.id);
  return c.paused ? "paused" : !c.url && !monDeployed(s) ? "pending" : monRuntime(s).state;
}
function monDays(s) {
  const inc = monIncidents(s), rnd = monRand(monHash(s.id));
  const today = Math.floor(NOW / DAY) * DAY, first = Date.parse(s.createdAt) || NOW - 40 * DAY;
  return Array.from({ length: 90 }, (_, k) => {
    const d = today - (89 - k) * DAY;
    if (d + DAY < first) return { day: iso(d).slice(0, 10), uptime: null, downMinutes: 0, pausedMinutes: 0, avgMs: null };
    const down = inc.reduce((a, i) => { const st = Date.parse(i.startedAt), en = i.endedAt ? Date.parse(i.endedAt) : NOW; return a + Math.max(0, Math.min(en, d + DAY) - Math.max(st, d)) / MIN; }, 0);
    const mins = Math.round(down);
    return { day: iso(d).slice(0, 10), uptime: +(100 - (mins / 1440) * 100).toFixed(3), downMinutes: mins, pausedMinutes: 0, avgMs: Math.round(monBase(s) + rnd() * 30) };
  });
}
function monUptime(s, spanMs) {
  if (monState(s) === "pending") return null;
  const from = NOW - spanMs, first = Date.parse(s.createdAt) || from, start = Math.max(from, first);
  const down = monIncidents(s).reduce((a, i) => { const st = Date.parse(i.startedAt), en = i.endedAt ? Date.parse(i.endedAt) : Date.now(); return a + Math.max(0, Math.min(en, Date.now()) - Math.max(st, start)); }, 0);
  return +(100 - (down / Math.max(1, Date.now() - start)) * 100).toFixed(3);
}
function monSummary(s) {
  const c = monSettings(s.id), r = monRuntime(s), state = monState(s);
  const hourStart = Math.floor(Date.now() / HOUR) * HOUR - 23 * HOUR;
  const inc = monIncidents(s);
  const bars24h = Array.from({ length: 24 }, (_, i) => {
    if (state === "pending") return null;
    const a = hourStart + i * HOUR, b = a + HOUR;
    const down = inc.reduce((n, x) => { const st = Date.parse(x.startedAt), en = x.endedAt ? Date.parse(x.endedAt) : Date.now(); return n + Math.max(0, Math.min(en, b) - Math.max(st, a)); }, 0);
    return c.paused && i === 23 ? -1 : +(1 - down / HOUR).toFixed(4);
  });
  const ups = targets(s).map((id) => { const srv = db.servers.find((x) => x.id === id); return { serverId: id, name: srvName(id), online: !!srv?.online, healthy: state === "down" ? false : srv?.online ? true : null, down: false, error: state === "down" ? r.lastCheck.error : null, latencyMs: srv?.online ? monBase(s) - 10 : null }; });
  const tgt = monTarget(s);
  const recips = monRecipients(s.id);
  return {
    siteId: s.id, name: s.name, projectId: s.projectId, domain: (s.domains || [])[0] || null, state, since: state === "paused" ? c.pausedAt : r.since,
    degraded: false, unhealthyServers: [], servers: ups, lastCheck: state === "pending" ? null : r.lastCheck, failing: 0, incidentId: inc.find((i) => !i.endedAt)?.id || null,
    paused: !!c.paused, pauseUntil: c.pauseUntil || null, intervalSec: c.intervalSec,
    sms: { enabled: !!c.smsEnabled, recipients: recips.length }, discord: { enabled: c.discordEnabled !== false, webhooks: monDiscordTargets(s.id).length }, target: tgt.url || null,
    uptime: { h24: monUptime(s, DAY), d7: monUptime(s, 7 * DAY), d30: monUptime(s, 30 * DAY), d90: monUptime(s, 90 * DAY) },
    avgMs24h: state === "pending" ? null : monBase(s) + 6, bars24h, bars24hStart: iso(hourStart),
  };
}
function monRecipients(id) {
  const c = monSettings(id), out = new Map();
  for (const r of [...(c.recipients || []), ...(c.includeDefaults !== false ? notif.defaults : [])]) if (r.phone && !out.has(r.phone)) out.set(r.phone, { phone: r.phone, name: r.name || "" });
  return [...out.values()];
}
function monDiscordTargets(id) {
  const c = monSettings(id);
  if (c.discordEnabled === false) return [];
  return notif.discord.webhooks.filter((w) => w.enabled && w.urlHint && !(c.discordSkip || []).includes(w.id));
}
const MON_RANGES = { "1h": [HOUR, MIN], "24h": [DAY, 5 * MIN], "7d": [7 * DAY, HOUR], "30d": [30 * DAY, 6 * HOUR], "90d": [90 * DAY, DAY] };
function monSeries(s, range) {
  const key = MON_RANGES[range] ? range : "24h", [span, step] = MON_RANGES[key];
  const to = Math.floor(Date.now() / step) * step + step, rnd = monRand(monHash(s.id) + span), inc = monIncidents(s), first = Date.parse(s.createdAt) || 0;
  const points = [];
  for (let t = to - span; t < to; t += step) {
    const down = inc.some((i) => Date.parse(i.startedAt) < t + step && (i.endedAt ? Date.parse(i.endedAt) : Date.now()) > t);
    const none = monState(s) === "pending" || t + step < first;
    const wave = Math.sin((t / DAY) * Math.PI * 2) * 0.18 + 1; // busier afternoons → a bit slower
    points.push({ t: iso(t), ms: none || (down && s.id === "site_status") ? null : Math.round(monBase(s) * wave + rnd() * 9 + (down ? 140 : 0)), uptime: none ? null : down ? 92.5 : 100, up: none ? 0 : step / MIN, down: down ? 1 : 0, paused: 0 });
  }
  return { range: key, step, points };
}
const monSettingsView = (id) => ({ ...clone(monSettings(id)), repeatMinutesDefault: notif.repeatMinutes, minIntervalSec: 10 });
function monNotif() {
  return { enabled: notif.enabled, configured: notif.configured, dryRun: notif.dryRun, defaults: clone(notif.defaults), repeatMinutes: notif.repeatMinutes, notifyRecovery: notif.notifyRecovery, minGapMinutes: notif.minGapMinutes,
    discord: { webhooks: notif.discord.webhooks.map((w) => ({ id: w.id, name: w.name, enabled: w.enabled, ready: !!w.urlHint, mention: !!w.mention })), active: notif.discord.webhooks.filter((w) => w.enabled && w.urlHint).length, testEndpoint: null } };
}
R("GET", "/api/monitor", () => {
  const items = db.sites.map(monSummary);
  const counts = { total: items.length, up: 0, down: 0, paused: 0, pending: 0, unknown: 0, degraded: 0 };
  for (const i of items) counts[i.state] = (counts[i.state] || 0) + 1;
  return { items, counts, notifications: { enabled: notif.enabled, configured: notif.configured || notif.dryRun, dryRun: notif.dryRun, discord: notif.discord.webhooks.filter((w) => w.enabled).length } };
});
R("GET", "/api/sites/:id/monitor", (p, b, q) => {
  const s = find("sites", p.id);
  return { summary: monSummary(s), settings: monSettingsView(s.id), effective: { ...monTarget(s), path: monSettings(s.id).path || s.healthPath || "/", healthPath: s.healthPath || "" },
    recipients: monRecipients(s.id), notifications: monNotif(), discordTargets: monDiscordTargets(s.id).map((w) => w.id),
    series: monSeries(s, q.range), days: monDays(s), incidents: monIncidents(s).map((i) => { const end = i.endedAt ? Date.parse(i.endedAt) : Date.now(); return { ...clone(i), open: !i.endedAt, durationMs: end - Date.parse(i.startedAt), alerts: [...i.alerts].reverse() }; }), gaps: [] };
});
R("PUT", "/api/sites/:id/monitor", (p, b) => {
  const s = find("sites", p.id), c = monSettings(s.id), out = {};
  const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  if ("intervalSec" in b) out.intervalSec = int(b.intervalSec, 10, 3600, c.intervalSec);
  if ("timeoutSec" in b) out.timeoutSec = int(b.timeoutSec, 1, 60, c.timeoutSec);
  if ("failThreshold" in b) out.failThreshold = int(b.failThreshold, 1, 20, c.failThreshold);
  if ("recoverThreshold" in b) out.recoverThreshold = int(b.recoverThreshold, 1, 20, c.recoverThreshold);
  if ("path" in b) { const v = String(b.path || "").trim(); if (v && !/^\/[^\s#]*$/.test(v)) err(400, "The check path must start with / (for example /api/health)."); out.path = v; }
  if ("url" in b) { const v = String(b.url || "").trim(); if (v && !/^https?:\/\/[^\s/]+/.test(v)) err(400, "The custom URL must be a full address, like https://example.com/health."); out.url = v; }
  if ("expect" in b) { const m = /^\s*(\d{3})\s*(?:-\s*(\d{3}))?\s*$/.exec(String(b.expect)); if (!m) err(400, "Expected status must look like 200-399 or 200."); out.expectMin = +m[1]; out.expectMax = +(m[2] || m[1]); if (out.expectMax < out.expectMin) err(400, "The expected status range is upside down."); }
  for (const k of ["smsEnabled", "includeDefaults", "discordEnabled"]) if (k in b) out[k] = !!b[k];
  if ("recipients" in b) out.recipients = (b.recipients || []).map((r) => { const ph = String(r.phone || "").trim(); if (!/^\+[1-9]\d{6,14}$/.test(ph)) err(400, `"${r.phone}" is not a valid phone number.`); return { name: String(r.name || "").trim().slice(0, 60), phone: ph }; });
  if ("discordSkip" in b) out.discordSkip = (b.discordSkip || []).filter((x) => notif.discord.webhooks.some((w) => w.id === x));
  if ("repeatMinutes" in b) out.repeatMinutes = b.repeatMinutes == null || b.repeatMinutes === "" ? null : int(b.repeatMinutes, 1, 1440, null);
  Object.assign(c, out);
  activity("monitor.settings.update", "site", s, Object.keys(out).join(", "));
  emit("monitor", { kind: "settings", siteId: s.id });
  return { settings: monSettingsView(s.id), summary: monSummary(s), recipients: monRecipients(s.id) };
});
R("POST", "/api/sites/:id/monitor/check", (p) => {
  const s = find("sites", p.id), c = monSettings(s.id), r = monRuntime(s);
  if (c.paused) err(409, "Monitoring is paused for this website.");
  r.lastCheck = r.state === "down" ? { at: iso(Date.now()), ok: false, status: null, ms: null, error: "Connection refused" } : { at: iso(Date.now()), ok: true, status: 200, ms: Math.round(monBase(s) + Math.random() * 30), error: null };
  return { summary: monSummary(s) };
});
R("POST", "/api/sites/:id/monitor/pause", (p, b) => {
  const s = find("sites", p.id);
  Object.assign(monSettings(s.id), { paused: true, pausedAt: iso(Date.now()), pausedBy: me.name, pauseUntil: b?.minutes ? iso(Date.now() + b.minutes * MIN) : null });
  emit("monitor", { kind: "settings", siteId: s.id });
  return { settings: monSettingsView(s.id), summary: monSummary(s) };
});
R("POST", "/api/sites/:id/monitor/resume", (p) => {
  const s = find("sites", p.id);
  Object.assign(monSettings(s.id), { paused: false, pausedAt: null, pausedBy: null, pauseUntil: null });
  emit("monitor", { kind: "settings", siteId: s.id });
  return { settings: monSettingsView(s.id), summary: monSummary(s) };
});

/* ───────── STAGING (panel/lib/staging.mjs): a staging copy = a child site record; test_<slug> test databases ───────── */
const stagingChild = (s) => (s?.stagingSiteId ? db.sites.find((x) => x.id === s.stagingSiteId) || null : null);
function stagingSummary(s) {
  if (s.stagingOf) return { role: "staging", parentId: s.stagingOf, parentName: db.sites.find((x) => x.id === s.stagingOf)?.name || null };
  const c = stagingChild(s);
  if (!c) return null;
  const sid = targets(c)[0], st = c.state[sid] || {};
  const bj = db.jobs.find((x) => x.siteId === c.id && (x.status === "running" || x.status === "queued"));
  return { role: "parent", id: c.id, name: c.name, url: c.domains[0] ? `${c.ssl?.enabled || s.ssl?.enabled ? "https" : "http"}://${c.domains[0]}` : null, domains: c.domains, port: c.port, serverId: sid,
    serverName: db.servers.find((x) => x.id === sid)?.name || sid, currentReleaseId: c.currentReleaseId || null, currentVersion: db.releases.find((r) => r.id === c.currentReleaseId)?.version || null,
    running: st.running ?? null, healthy: st.healthy ?? null, deploying: bj?.type === "site.deploy", error: st.error || null, busyJobId: bj?.id || null, deleting: !!c.deleting, databaseIds: c.linkedDatabaseIds, ssl: c.ssl, createdAt: c.createdAt };
}
const sqlName = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "site";
function testDbPreview(s) {
  if (s.type === "static" && !(s.linkedDatabaseIds || []).length) return null;
  const ids = s.linkedDatabaseIds || [];
  const dbs = (ids.length ? ids : [null]).map((id, i) => ({ name: `test_${sqlName(s.name)}${i ? `_${i + 1}` : ""}`, host: `db${i + 1}`, port: "3306", source: id ? db.databases.find((d) => d.id === id)?.name || id : "the test run (this website has no database of its own)", added: !id }));
  const d = dbs[0];
  return { databases: dbs, vars: [["DATABASE_URL", `mysql://‹random›:‹random›@${d.host}:3306/${d.name}`, true], ["DB_HOST", d.host, false], ["DB_NAME", d.name, false], ["DB_PASSWORD", "‹random›", true], ["DB_PORT", "3306", false], ["DB_USER", "‹random›", true]].map(([key, value, random]) => ({ key, value, random })) };
}
function stagingDb(parent, i) {
  const name = `${sqlName(projectName(parent.projectId)).slice(0, 16).replace(/_+$/, "")}_staging_${sqlName(parent.name)}${i ? `_${i + 1}` : ""}`;
  let d = db.databases.find((x) => x.name === name), created = false;
  if (!d) { d = { id: nid("db"), projectId: parent.projectId, name, user: name.slice(0, 32), charset: "utf8mb4", collation: "utf8mb4_unicode_ci", remoteAccess: true, sizeBytes: 0, createdAt: iso(Date.now()), stagingOf: parent.id }; db.databases.push(d); created = true; }
  return { d, created };
}
function stagingVars(parent, url) {
  const out = {}, removed = [];
  const doms = (parent.domains || []).map((x) => x.replace(/^www\./, ""));
  for (const [k, v] of Object.entries(parent.env || {})) {
    if (/^(sk|pk|rk)_live_/.test(v) || /^whsec_/.test(v)) { removed.push(`${k} was not copied: live payment key.`); continue; }
    out[k] = url ? doms.reduce((acc, dm) => acc.replace(new RegExp(`https?://(?:www\\.)?${dm.replace(/\./g, "\\.")}(?=[/?#]|$)`, "g"), url), v) : v;
  }
  return { env: out, removed };
}
function makeStaging(parent, { domain, serverId, releaseId = null, deployMs = 0 } = {}) {
  const made = parent.type === "static" ? [] : (parent.linkedDatabaseIds || []).map((_, i) => stagingDb(parent, i));
  const url = domain ? `${parent.ssl?.enabled ? "https" : "http"}://${domain}` : "";
  const { env, removed } = stagingVars(parent, url);
  const c = mkSite({ id: nid("site"), projectId: parent.projectId, name: `${parent.name}-staging`, type: parent.type, domains: domain ? [domain] : [], port: 3001 + db.sites.length + 20, serverIds: [serverId || targets(parent)[0]],
    healthPath: parent.healthPath, settings: clone(parent.settings), github: null, env, linkedDatabaseIds: made.map((m) => m.d.id), runtime: parent.type === "node" ? "docker" : parent.type === "static" ? "none" : "legacy",
    container: parent.container ? clone(parent.container) : parent.type === "node" ? { uid: 20100 + db.sites.length, gid: 20100 + db.sites.length, image: "node:20-bookworm-slim", memoryMb: 1024, cpus: 1 } : null,
    ssl: { enabled: false, status: "none" }, stagingOf: parent.id, currentReleaseId: releaseId, previousReleaseId: null, state: {}, createdAt: iso(Date.now() - deployMs) });
  parent.stagingSiteId = c.id;
  return { c, made, removed };
}
// Fixture: acme-web has staging running (one release behind live); northwind-api has none.
{
  const p = db.sites.find((x) => x.id === "site_acmeweb");
  const rel = db.releases.filter((r) => r.siteId === p.id)[1];
  const { c } = makeStaging(p, { domain: "staging-shop.acme.com", serverId: "main", releaseId: rel?.id || null, deployMs: 3 * DAY });
  c.env = { ...c.env, NODE_ENV: "staging", STRIPE_PUBLIC_KEY: "pk_test_51Hx…" };
  c.state.main = { running: true, healthy: true, version: rel?.version, releaseId: rel?.id, checkedAt: ago(40e3) };
}
R("POST", "/api/sites/:id/staging", (p, b) => {
  const s = find("sites", p.id);
  if (s.stagingOf) err(409, "This is already a staging copy.");
  if (stagingChild(s)) err(409, `${s.name} already has a staging copy.`);
  const first = String(s.domains?.[0] || "").replace(/^www\./, "");
  const domain = "domain" in b ? String(b.domain || "").trim().toLowerCase() : first ? `staging.${first}` : "";
  if (domain && !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) err(400, `"${domain}" is not a valid domain name.`);
  const other = domain && db.sites.find((x) => (x.domains || []).includes(domain));
  if (other) err(409, `${domain} is already used by website "${other.name}".`);
  const { c, made, removed } = makeStaging(s, { domain, serverId: b.serverId });
  activity("site.staging.start", "site", s, `Staging copy ${c.name}${made.length ? ` with ${made.map((m) => m.d.name).join(", ")}` : ""}`);
  for (const m of made) if (m.created) emit("database", { action: "created", database: dbView(m.d) });
  const rel = b.deploy !== false && (db.releases.find((r) => r.id === (b.releaseId || s.currentReleaseId)));
  let job = null;
  if (rel) {
    const sid = targets(c)[0];
    const lines = [`Deploying ${rel.version} to staging (${c.name}) on ${db.servers.find((x) => x.id === sid)?.name || sid}.`, ...linesFor("site.deploy", "").map((l) => l.replace(/^\[[^\]]+\] /, ""))];
    job = runJob({ type: "site.deploy", title: `Deploy ${c.name} ${rel.version}`, siteId: c.id, projectId: c.projectId, heavy: true, servers: [sid] }, { lines, speed: 140, onDone() {
      c.currentReleaseId = rel.id; c.state[sid] = { running: true, healthy: true, version: rel.version, releaseId: rel.id, checkedAt: iso(Date.now()) }; emit("site", siteView(c));
    } });
  }
  emit("site", siteView(c)); emit("site", siteView(s));
  const warnings = [...removed, ...(s.loadBalanced ? [`${s.name} is load balanced; staging runs on one server.`] : []), ...(!rel && b.deploy !== false ? [`${s.name} has no release deployed yet — deploy one to staging from the Deployments tab.`] : [])];
  return { site: siteView(s), staging: siteView(c), databases: made.map((m, i) => ({ id: m.d.id, name: m.d.name, created: m.created, prefix: i ? `DB${i + 1}_` : "" })), job, warnings };
});
R("DELETE", "/api/sites/:id/staging", (p, b, q) => {
  const s0 = find("sites", p.id);
  const s = s0.stagingOf ? find("sites", s0.stagingOf) : s0;
  const c = stagingChild(s) || err(404, `${s.name} has no staging copy.`);
  busy(c);
  c.deleting = true; emit("site", siteView(s));
  const drop = q.dropDatabase === "1" ? db.databases.filter((d) => d.stagingOf === s.id && c.linkedDatabaseIds.includes(d.id)) : [];
  activity("site.staging.remove", "site", s, drop.length ? `and dropped ${drop.map((d) => d.name).join(", ")}` : "database kept");
  const lines = [`Removing ${c.name}…`, `── ${db.servers.find((x) => x.id === targets(c)[0])?.name || "main"}: removing the website${q.deleteFiles !== "0" ? " and its files" : ""}`, "✓ front door (nginx) entry removed.", `✓ ${c.name} removed.`,
    ...drop.flatMap((d) => [`Dropping the staging database ${d.name} and its user ${d.user}…`, `✓ ${d.name} dropped.`])];
  return runJob({ type: "site.staging.remove", title: `Remove staging of ${s.name}`, siteId: s.id, projectId: s.projectId }, { lines, speed: 200, onDone() {
    db.sites = db.sites.filter((x) => x.id !== c.id); s.stagingSiteId = null;
    db.databases = db.databases.filter((d) => !drop.includes(d));
    for (const d of drop) emit("database", { action: "deleted", id: d.id, projectId: d.projectId });
    emit("site", { id: c.id, deleted: true }); emit("site", siteView(s));
  } });
});

function pick(o, keys) { const r = {}; for (const k of keys) if (o && k in o) r[k] = o[k]; return r; }

/* ───────── entry points ───────── */
export async function handle(method, path, body) {
  const [pathname, search] = path.split("?");
  const q = Object.fromEntries(new URLSearchParams(search || ""));
  await new Promise((r) => setTimeout(r, 120 + Math.random() * 260));
  // panel failover: while a simulated switch is under way, every API call gets what a panel node answers without a leader
  if (Date.now() < ha.switchingUntil) err(503, "The panel is switching servers.", { haSwitching: true });
  if (flags.dbDown && method !== "GET" && (/^\/api\/(mysql|phpmyadmin|databases)(\/|$)/.test(pathname) || /^\/api\/projects\/[^/]+\/databases$/.test(pathname))) err(503, DB_REASON);
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
