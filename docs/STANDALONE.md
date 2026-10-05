# Forthway Command Center — Standalone (v3) architecture contract

This branch turns FCC into a self-hosted control panel that runs on its own VPS.
**Nothing depends on Pterodactyl.** No `/home/container`, no `SERVER_PORT`, no
PIN-from-console, no egg. There is **no terminal / "run a command" box** anywhere
in the UI or API — every operation is a named, purpose-built action.

This file is the contract between the modules. If you need to change an
interface here, keep it backward compatible and note it at the bottom under
"Changes".

---

## 1. Product shape

- **One main server** runs the panel (`panel/server.mjs`), nginx (the public
  front door / load balancer for every website), MySQL, and backups.
- **Worker servers** (added in Settings → Servers) run a small node agent
  (`node/node-agent.mjs`) that dials out to the panel. They host copies of
  websites that are load balanced.
- **Admins** sign in with email + password. Multiple admins. First admin is
  created on the `/setup` page.
- **Projects** group things. A project contains:
  - **Websites** (many). Each website either runs on one server, or is
    **load balanced** across several servers (chosen when creating it, editable
    later). Every website shows its LB status.
  - **MySQL databases** (many), with **database backups**.
- **Backups**: database backups (mysqldump, gz) and **server backups**
  (tar.gz of panel data + site files + nginx config + optional full DB dump,
  for the main server or any worker), manual or scheduled, with retention.

Zero npm dependencies, Node 18+ only (as before). System programs are used via
`panel/lib/sys.mjs` (`run`, `which`, `DRY_RUN`). Target OS: Ubuntu 22.04/24.04
and Debian 12. The panel runs as root under systemd (`fcc.service`).

**Development on a Mac**: `FCC_DRY_RUN=1 FCC_DATA_DIR=./.devdata node panel/server.mjs`
must boot and the whole UI must be usable — system calls are logged, not run.
Modules must degrade gracefully when nginx / mysql / certbot are missing
(report `installed: false`, never crash).

---

## 2. Layout and ownership

Each file has exactly one owner. Do not edit files you don't own; if you need
something from another module, use the `ctx` interface below (call it
defensively: `ctx.cluster?.metrics?.()`), and mention the need in your report.

```
panel/
  server.mjs               CORE      boot, http(s), static files, SSE, module wiring
  lib/http.mjs             (done)    Router, httpError, send/sendJson/readBody
  lib/sys.mjs              (done)    run(), which(), DRY_RUN
  lib/store.mjs            CORE      JSON collections persistence
  lib/auth.mjs             CORE      admins, sessions, login throttle
  lib/secrets.mjs          CORE      encrypt/decrypt with the panel key
  lib/jobs.mjs             CORE      background jobs, logs, SSE events
  lib/core-routes.mjs      CORE      setup/login/me/admins/projects/settings/dashboard/jobs/activity/events
  lib/github.mjs           SITES     (port from hub/lib/github.mjs)
  lib/sites.mjs            SITES     websites, releases, deploy orchestration, env
  lib/cluster.mjs          CLUSTER   servers registry, task dispatch, node protocol, metrics
  lib/loadbalancer.mjs     CLUSTER   nginx config generation/apply, certbot SSL
  lib/mysql.mjs            DATA      MySQL server status, databases, users, grants
  lib/backups.mjs          DATA      database + server backups, schedules, retention, restore
  public/                  UI        index.html, login.html, setup.html, assets/*
  templates/node-install.sh CLUSTER  worker one-line installer
node/
  node-agent.mjs           CLUSTER   worker agent
shared/
  deployer.mjs             SITES     (existing engine; extend for static/php if needed)
  tasks.mjs                CLUSTER   task executor used by node agent AND in-process on main
  env.mjs fsx.mjs zip.mjs zipwrite.mjs   (existing, read-only unless you own them: SITES)
install.sh                 OPS       VPS installer
README.md                  OPS
docs/STANDALONE.md         lead
```

The old `hub/` and `agent/` directories are reference material only — port
code from them freely, but do not edit them; they are deleted at the end.

---

## 3. Module interface

Every lib module with routes exports:

```js
export function register(router, ctx) { ... }   // add routes; may attach ctx.<name> API
export async function start(ctx) { ... }        // optional: timers, schedulers (called after all register())
```

server.mjs calls, in order: core-routes, cluster, loadbalancer, sites, mysql,
backups — `register()` for all, then `start()` for all. Use other modules'
`ctx` APIs only inside handlers / timers, never at register time.

### `ctx` (built by CORE in server.mjs)

```js
ctx = {
  version: "3.0.0",
  rootDir,                     // repo root
  dataDir,                     // FCC_DATA_DIR || /var/lib/fcc  (dev: ./.devdata)
  config,                      // object persisted at dataDir/config.json
  saveConfig(),
  db,                          // Store (below)
  secrets,                     // { encrypt(str) -> str, decrypt(str) -> str }
  jobs,                        // Jobs (below)
  events,                      // { broadcast(event, data) }  -> SSE to all browsers
  activity(admin, action, target, details?) // append to audit log
  panelUrl(req?)               // public base URL of the panel (config.panelUrl || from req)
  sys,                         // panel/lib/sys.mjs exports
  // attached by modules:
  cluster, lb, sites, mysql, backups
}
```

### `ctx.db` — Store (CORE)

JSON file `dataDir/db.json`, debounced atomic writes. Collections are arrays of
objects with string `id`.

```js
db.list(coll, filter?)        // filter: object of equal-fields, or fn
db.get(coll, id)
db.insert(coll, obj)          // assigns id (prefix_random) if missing, createdAt; returns obj
db.update(coll, id, patch)    // shallow merge, sets updatedAt; returns obj | null
db.remove(coll, id)           // returns removed | null
db.save({ immediate })
db.newId(prefix)              // e.g. "prj_k3j2h1"
```

Collections: `admins, projects, sites, releases, servers, databases, backups, jobs, activity`.

### `ctx.jobs` (CORE)

```js
const job = ctx.jobs.start(
  { type: "site.deploy", title: "Deploy acme.com", projectId, siteId, serverId, databaseId, adminId },
  async ({ log, signal, job }) => { log("line"); return result; }
);                                   // returns job record immediately; runs async
ctx.jobs.get(id); ctx.jobs.list({ siteId, projectId, serverId, databaseId, limit });
ctx.jobs.cancel(id);
ctx.jobs.wait(id) -> Promise<job>    // resolves when finished
```

Job record: `{ id, type, title, status: "queued"|"running"|"succeeded"|"failed"|"cancelled", projectId, siteId, serverId, databaseId, adminId, startedAt, finishedAt, error, result }`.
Logs at `dataDir/logs/<jobId>.log`. SSE events: `job` (record on every status change) and `job.log` (`{ id, lines: [] }`, batched ~250ms).

### `ctx.cluster` (CLUSTER)

```js
cluster.MAIN_ID                      // "main" — the main server is always a server record with id "main"
cluster.listServers()                // public records (no token)
cluster.getServer(id)
cluster.isOnline(id)
cluster.address(id)                  // host used to reach that server's site ports from main nginx ("127.0.0.1" for main)
cluster.runTask(serverId, type, payload, { log, signal }) -> Promise<result>
                                     // main: executes shared/tasks.mjs in-process; worker: queued to its agent
cluster.authenticateNode(req)        // -> server record | null  (Bearer token, for /agent/* routes)
cluster.metrics({ range })           // { servers: { [id]: [{ t, cpu, mem, disk, load }] }, requests: [{ t, count }], perSite: { [siteId]: [{ t, count }] } }
cluster.on("servers-changed", fn)
```

Task types handled by `shared/tasks.mjs` (payload → result):

| type | payload | result |
|---|---|---|
| `site.deploy` | `{ spec, release: { id, url, token, sha256 } }` | deployer result |
| `site.rollback` | `{ spec }` | |
| `site.start` / `site.stop` / `site.restart` | `{ spec }` | |
| `site.status` | `{ spec }` | `{ running, healthy, version, pid? }` |
| `site.env` | `{ spec, env }` | writes app `.env` block |
| `site.remove` | `{ spec, deleteFiles }` | |
| `site.logs` | `{ spec, lines }` | `{ text }` (read-only app logs) |
| `server.metrics` | `{}` | `{ cpu, mem, memTotal, disk, diskTotal, load, uptime, hostname, os }` |
| `server.backup` | `{ include, upload: { url, token } }` | `{ file, size, sha256 }` (worker uploads archive to panel) |

`spec` is produced by `ctx.sites.specFor(site)` — everything the node needs:
`{ siteId, name, type: "node"|"static"|"php", appDir, port, settings (deployer settings), env, pm2Name }`.
For `static`/`php` the task executor writes a local nginx vhost on that node
that listens on `spec.port` (so the main front door always proxies to
`address:port`, uniformly).

### `ctx.lb` (CLUSTER)

```js
lb.status()                          // { installed, version, configOk, lastAppliedAt, lastError }
lb.syncSite(site)  -> Promise        // (re)write that site's front-door vhost + upstream on main, test, reload
lb.removeSite(site) -> Promise
lb.applyAll()       -> Promise       // regenerate everything (after server changes)
lb.preview(site)                     // rendered nginx config text
lb.upstreams(site)                   // [{ serverId, name, address, port, weight, online, healthy }]
lb.issueCertificate(site, { log }) -> Promise   // certbot --nginx for site.domains
```

Front door: `/etc/nginx/conf.d/fcc-<siteId>.conf` (dev: `dataDir/nginx/`).
Each site gets `upstream fcc_<siteId> { <method>; server addr:port weight=w max_fails=3 fail_timeout=10s; ... }`
and `server { server_name <domains>; location / { proxy_pass http://fcc_<siteId>; ... } }`.
Non-LB sites have a single-server upstream. Access logs per site in
`/var/log/nginx/fcc-<siteId>.access.log` (used for request metrics).

### `ctx.sites` (SITES)

```js
sites.specFor(site, serverId?)       // task spec (see above), env merged incl. linked DB env
sites.get(id); sites.list({ projectId })
sites.targets(site)                  // serverIds it runs on: loadBalanced ? site.serverIds : [site.serverIds[0] || "main"]
```

### `ctx.mysql` (DATA)

```js
mysql.status()                       // { installed, running, version, rootOk, error }
mysql.envFor(databaseId, { serverId })  // { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DATABASE_URL }
                                     // DB_HOST is 127.0.0.1 on main, the main server's private/public address on workers
mysql.syncRemoteHosts()              // re-grant users for current worker addresses (call on servers-changed)
mysql.dump(databaseId, { file, log, signal })  -> Promise
```

### `ctx.backups` (DATA)

```js
backups.backupDatabase(databaseId, { trigger, adminId }) -> job
backups.backupServer(serverId, { include, trigger, adminId }) -> job
```

---

## 4. Data model

```js
admin    { id, email, name, passwordSalt, passwordHash, role: "owner"|"admin", createdAt, lastLoginAt }
project  { id, name, description, color, createdAt }         // color: one of the UI accent tokens
site     { id, projectId, name, type: "node"|"static"|"php",
           domains: ["acme.com","www.acme.com"], port, appDir,
           loadBalanced: false, serverIds: ["main"], lbMethod: "round_robin"|"least_conn"|"ip_hash",
           healthPath: "/api/health", settings: {...deployer settings},
           github: { repo, branch, token? }, env: {}, linkedDatabaseIds: [],
           ssl: { enabled, status, issuedAt, error },
           currentReleaseId, previousReleaseId,
           state: { [serverId]: { running, healthy, version, checkedAt, error } },
           createdAt }
release  { id, siteId, filename, size, sha256, version, commit, source: "upload"|"github", pinned, createdAt }
server   { id, name, role: "main"|"worker", host, privateHost?, weight, enabled,
           tokenHash, agentVersion, lastSeenAt, info: { hostname, os, cpus, memTotal, diskTotal }, createdAt }
database { id, projectId, name, user, passwordEnc, charset, collation, remoteAccess, sizeBytes, createdAt }
backup   { id, kind: "database"|"server", projectId?, databaseId?, serverId?, include?, file, size, sha256,
           status: "running"|"ok"|"failed", trigger: "manual"|"schedule", pinned, note, error, createdAt }
activity { id, at, adminId, adminName, action, target: { type, id, name }, details }
```

Defaults: appDir `/srv/fcc/sites/<projectSlug>/<siteSlug>`; ports auto-assigned
from 3001 upward, unique across all sites; backups in `dataDir/backups/`.

`config.json` (dataDir): `{ panelName, panelUrl, port, host, sessionSecret, secretKey, github: { token },
backups: { database: { enabled, every: "daily"|"hourly"|"weekly", at: "03:00", keep: 14 },
server: { enabled, every, at, keep, include }, destination: { type: "local"|"s3", ... } },
mysql: { socket, rootUser: "root", rootPasswordEnc?, host: "127.0.0.1", port: 3306 }, tls? }`.

---

## 5. HTTP API

All JSON. All `/api/*` routes need an admin session unless marked *public*.
Errors: `{ error: "message" }` with 4xx/5xx. Lists return `{ items: [...] }`.
Secrets (tokens, passwords) are never returned except where stated ("once").

### CORE
```
GET    /healthz                                   public  { ok, version, setup }
GET    /api/setup                                 public  { needsSetup, version, hostname }
POST   /api/setup        { name, email, password, panelName? }   public, only when no admins → sets session
POST   /api/login        { email, password }      public  → session cookie
POST   /api/logout
GET    /api/me                                    { id, email, name, role }
PATCH  /api/me           { name, email }
POST   /api/me/password  { current, next }
GET    /api/admins       POST /api/admins { name, email, password }
PATCH  /api/admins/:id   DELETE /api/admins/:id   (owner cannot be deleted; cannot delete yourself)
GET    /api/projects                              items with counts { sites, sitesLoadBalanced, databases, backups }
POST   /api/projects     { name, description, color }
GET    /api/projects/:id                          project + counts
PATCH  /api/projects/:id DELETE /api/projects/:id (409 if it still has sites/databases)
GET    /api/dashboard                             { admin, counts: { projects, sites, sitesLoadBalanced, databases,
                                                    servers, serversOnline, backups, backupsSize },
                                                    series: { requests: [{t,count}], cpu: [{t,value}] },
                                                    recentJobs: [...], recentActivity: [...],
                                                    health: { nginx, mysql } }
GET    /api/settings     PATCH /api/settings      { panelName, panelUrl, githubTokenSet, githubTokenHint }
GET    /api/jobs?siteId&projectId&serverId&databaseId&limit
GET    /api/jobs/:id     GET /api/jobs/:id/log (text/plain)   POST /api/jobs/:id/cancel
GET    /api/activity?projectId&limit
GET    /api/events                                SSE: job, job.log, site, server, database, backup, project, lb
```

### SITES
```
GET    /api/sites?projectId                       items: site public view (+ lb summary: { loadBalanced, servers: n, method })
POST   /api/projects/:projectId/sites  { name, type, domains, loadBalanced, serverIds, lbMethod, port?, github?, settings?, env?, linkedDatabaseIds? }
GET    /api/sites/:id                             site + upstreams + releases(limit 20)
PATCH  /api/sites/:id                             any editable field; changing loadBalanced/serverIds/domains re-syncs nginx and deploys current release to newly added servers
DELETE /api/sites/:id?deleteFiles=1
POST   /api/sites/:id/deploy        { releaseId? }        → job (fan-out to every target server; LB sites deploy one server at a time = rolling)
POST   /api/sites/:id/restart|stop|start|rollback          → job
GET    /api/sites/:id/status                     { [serverId]: { running, healthy, version, checkedAt } }  (refreshes)
GET    /api/sites/:id/logs?serverId&lines        { text }
GET    /api/sites/:id/env         PUT /api/sites/:id/env { env }   (linked DB vars shown read-only)
GET    /api/sites/:id/releases
POST   /api/sites/:id/releases/upload?filename=  raw zip body (≤ 500 MB) → release
POST   /api/sites/:id/releases/github { ref? }   → job that downloads → release
PATCH  /api/releases/:id { pinned }   DELETE /api/releases/:id
GET    /api/github/refs?repo=                    { branches, tags }
GET    /agent/releases/:id                       agent route: node-auth (Bearer) → zip bytes
```

### CLUSTER
```
GET    /api/servers                              items: server + online + metrics latest + siteCount
POST   /api/servers      { name, host, privateHost?, weight? }   → { server, installCommand }  (token shown once, inside the command)
GET    /api/servers/:id  PATCH /api/servers/:id { name, host, privateHost, weight, enabled }
DELETE /api/servers/:id                          (409 if sites still target it; main cannot be deleted)
POST   /api/servers/:id/token                    rotate → { installCommand }
GET    /api/servers/:id/metrics?range=1h|24h
GET    /api/loadbalancer                         lb.status() + per-site summary
POST   /api/loadbalancer/apply                   → job
GET    /api/sites/:id/nginx                      { config } (preview, read-only)
POST   /api/sites/:id/ssl                        → job (certbot)
GET    /install/node.sh?server=&token=           public  installer script with values filled in
GET    /install/files/*                          public  node-agent.mjs + shared/*.mjs
POST   /agent/hello  GET /agent/poll  POST /agent/tasks/:id/log  POST /agent/tasks/:id/result
POST   /agent/metrics  POST /agent/upload/:taskId              agent routes (Bearer server token)
```

### DATA
```
GET    /api/mysql/status
POST   /api/mysql/root { password }              store root credentials if socket auth isn't available
GET    /api/databases?projectId                  items (no passwords) + sizeBytes + lastBackup
POST   /api/projects/:projectId/databases { name, user?, password?, remoteAccess?, charset? } → { database, password } (once)
GET    /api/databases/:id   DELETE /api/databases/:id
POST   /api/databases/:id/credentials            → { user, password, host, port, name, url } (reveal; audited)
POST   /api/databases/:id/password { password? } → rotate; { password } once; re-writes env of linked sites
POST   /api/databases/:id/import?filename=       raw .sql / .sql.gz body → job
POST   /api/databases/:id/backups                → job (backup now)
GET    /api/backups?kind&projectId&databaseId&serverId
POST   /api/backups/server { serverId, include: { panel, sites, nginx, databases } } → job
GET    /api/backups/:id/download
POST   /api/backups/:id/restore                  → job (database: into its DB; server: main only, extracts site files/nginx; panel data not overwritten while running)
PATCH  /api/backups/:id { pinned, note }   DELETE /api/backups/:id
GET    /api/backups/settings   PUT /api/backups/settings
```

---

## 6. UI

Dark, premium dashboard in the style of the reference image: deep navy
background, left sidebar (logo, nav, bottom: Settings / Support-style links),
top breadcrumb bar with account menu, a vivid blue gradient hero ("Welcome back,
<name>") with stat cards overlapping its bottom edge (sparklines), then content
sections in dark cards with pill tabs, search and a large line chart.

Sidebar: Dashboard · Projects · Websites · Databases · Backups · Servers ·
(bottom) Activity · Settings. Project page: tabs Websites / Databases /
Backups / Activity. Website page: Overview (per-server status, **Load balanced**
badge + upstream list), Deployments, Environment, Domains & SSL, Settings, Logs.
Settings: General · Admins · Servers & Load balancing · Backups · GitHub · Account.
Vanilla JS ES modules + CSS, no build step. No terminal / command box anywhere.

---

## Changes
(append interface changes here, with module + reason)

- **lead — servers are general agent hosts, not only LB nodes.** Any server running the
  node agent can host single-server (non-LB) websites as well as be a member of LB pools.
  The agent is the "just in case" way to put a site on another machine. Server record gains
  `lbEligible: true` (UI label "Available for load balancing"); LB server pickers only offer
  `lbEligible` servers, single-server pickers offer every enabled server incl. main.
  Server kinds in UI copy: "Main" and "Agent server" (not "worker").
- **lead — capacity in server pickers.** `GET /api/servers` items MUST include
  `online` and `metrics: { cpu, mem, memTotal, disk, diskTotal, load, at } | null` (latest sample,
  bytes for mem/disk = used), plus `siteCount`. The website create wizard and the Settings →
  Hosting tab show, for "Single server", a selectable list of servers (radio cards); each card
  has two thin bars at the bottom: RAM used / total and Disk used / total (with text like
  "3.1 / 8 GB"), offline servers greyed with "offline" and still selectable but warned. The LB
  multi-select uses the same cards (checkbox style).
- **OPS — install.sh environment for fcc.service.** The unit sets `FCC_DATA_DIR`, `FCC_PORT`,
  `FCC_HOST`, `FCC_DIR`, `FCC_SITES_DIR` (default `/srv/fcc/sites`), `NODE_ENV=production`,
  `HOME=/root`, `PM2_HOME=/root/.pm2` (same pm2 daemon as `pm2-root.service`, which resurrects
  sites on boot — SITES/tasks should `pm2 save` after start/stop/remove so a reboot restores the
  right set). With `FCC_PANEL_DOMAIN` it also sets `FCC_PANEL_URL=https://<domain>` and
  `FCC_TRUST_PROXY=1`. CORE: please honour `FCC_PORT`/`FCC_HOST` (env beats config.json),
  `FCC_PANEL_URL` as the default for `config.panelUrl` (used in agent install commands), and
  `FCC_TRUST_PROXY=1` → take client IP from `X-Forwarded-For` (login throttle). SITES: honour
  `FCC_SITES_DIR` as the appDir root if set. Extra user env: `/etc/fcc/fcc.env` (EnvironmentFile).
  `KillMode=process`, so restarting the panel doesn't kill a pm2 daemon it spawned.
- **OPS — nginx files the installer owns (CLUSTER: don't touch / don't glob-delete).**
  `/etc/nginx/conf.d/forthway-catchall.conf` declares `default_server` on :80 (444) and, on
  nginx ≥ 1.19.4, :443 with `ssl_reject_handshake on`. So **site vhosts must not use
  `default_server`** (duplicate → nginx -t fails). `/etc/nginx/conf.d/forthway-panel.conf`
  (panel vhost) defines `upstream fcc_panel_upstream` and `map $http_upgrade $fcc_panel_connection`
  — LB must not reuse those names (if LB needs an upgrade map, name it e.g. `$fcc_connection_upgrade`).
  The stock `sites-enabled/default` is removed. The catch-all serves `/.well-known/acme-challenge/`
  from `/var/www/html` for any host. `--uninstall --purge` removes `/etc/nginx/conf.d/fcc-*.conf`.
- **OPS — MySQL baseline.** Root uses socket auth (panel as root → `mysql` with no password).
  Bind config lives in `/etc/mysql/mysql.conf.d/zz-fcc.cnf` (MySQL) or
  `/etc/mysql/mariadb.conf.d/99-fcc.cnf` (MariaDB): `127.0.0.1` unless `FCC_MYSQL_REMOTE=1` →
  `0.0.0.0`. 3306 is never opened in ufw by the installer — DATA/CLUSTER may want to surface
  "allow 3306 from <agent ip>" in the UI. Debian 12 has no mysql-server package → MariaDB.
- **OPS — version.json.** install.sh writes `<FCC_DIR>/version.json`
  `{ version, repo, ref, commit, source: "github"|"local", installedAt }` (same idea as v2
  hub/lib/updates.mjs) for a future self-update check. Code is copied to FCC_DIR as:
  `panel node shared scripts patches README.md install.sh` (+ LICENSE); `hub/`, `agent/`, `docs/`
  are not installed. Re-running `/opt/fcc/install.sh` re-downloads from the remembered
  `FCC_REPO`/`FCC_REF` (default `llallenll/Forthway-Command-Center@standalone`).
- **OPS — PHP.** php-fpm is only installed with `FCC_PHP=1` on main. SITES/CLUSTER: report a clear
  error for `type: "php"` when no php-fpm socket exists (and node-install.sh may want the same flag).
- **CORE — additions (all backward compatible).**
  - `ctx.panelUrl(req?)` = `config.panelUrl` → `FCC_PANEL_URL` → request host → first LAN IP.
    **Read the URL through `ctx.panelUrl()`, not `ctx.config.panelUrl`** (the env default lives only there).
  - Proxy headers are trusted only with `FCC_TRUST_PROXY=1`; use `requestIp(req)`,
    `requestProto(req, config)`, `requestHost(req)` from `lib/auth.mjs` (not `http.mjs` `clientIp`, which trusts XFF).
  - `ctx.auth` = `{ authenticate(req) → public admin | null, throttle, setSession, clearSession, … }`.
    The `admin` handed to route handlers is the public view `{ id, email, name, role, createdAt, lastLoginAt }`.
  - `ctx.events.on(name, fn)` / `off` — in-process listeners for anything `broadcast()`. Extra SSE
    events: `hello` (on connect), `activity` (each audit entry). `project` event = `{ action: "created"|"updated"|"deleted", project }`.
  - `ctx.jobs`: jobs with a `siteId` (else `databaseId`) are serialised per site/database; override with
    `meta.lock: "<key>"` or opt out with `lock: false`. Re-entrant: a job started *inside* a running job
    holding the same lock runs immediately (no deadlock when a job starts + waits for a sub-job).
    Also `jobs.log(id, line)`, `jobs.readLog(id)`, `jobs.cancel(id, { by })`, `jobs.isActive(id)`,
    `jobs.list({ …, type, status, adminId })`. Extra meta fields passed to `start()` are kept on the record.
  - `ctx.db.removeWhere(coll, filter)` → removed records. Unknown collections are created on first use.
  - `ctx.secrets.isEncrypted(v)`; `decrypt()` returns "" for empty input and **throws** on tampered / wrong-key values.
  - `ctx.activity(admin|adminId|null, action, { type, id, name, projectId? }, details?)` — entries get a
    `projectId` (from target.projectId / details.projectId, or looked up for project/site/database/backup
    targets). `GET /api/activity` also filters by `adminId`, `targetType`, `targetId`.
  - Project records get a stable `slug` (unique, not changed on rename) — use it for appDir defaults.
  - Modules may export `stop(ctx)` — called (3 s max each, reverse order) on SIGTERM before jobs are marked failed.
  - Pages: `/` → index.html (signed in) or login.html; `/setup` only while no admins exist (everything else
    redirects there); any other extension-less GET path serves index.html when signed in (client-side
    routes like `/projects/prj_x`) or redirects to `/login?next=…`. `/assets/*` and other files in `public/`
    are served with ETags. `POST /api/logout` is public. `POST /api/login` before setup → 409 `{ needsSetup: true }`.
  - `GET /api/settings` also returns `panelUrlEffective`, `version`, `hostname`, `dryRun`; `PATCH` takes
    `{ panelName, panelUrl, githubToken }` (`""` clears the token). `GET /api/dashboard?range=1h|24h` also returns `panelName`.
  - Dev: with `FCC_DRY_RUN=1` and no `FCC_DATA_DIR`, data goes to `<repo>/.devdata`.
- **SITES — deployer (shared/deployer.mjs), backward compatible.** New restart mode `"none"`
  (stop/start/restart are no-ops; for static/php). New settings: `healthCheck` (default true; false →
  no health URL, not even the port-derived one), `versionCheck` (default true), `createAppDir`
  (default false; true → `mkdir -p appDir` before a deploy instead of failing).
- **SITES — spec additions.** `specFor(site, serverId)` also returns `projectId, docRoot, domains,
  healthPath, phpVersion (php), serverId`. `spec.settings` is complete deployer settings:
  node → pm2 (`service = pm2Name`, `pm2Start = settings.start || "npm start"`), health URL
  `http://127.0.0.1:<port><healthPath>` (empty healthPath → `healthCheck: false`); static/php →
  `restart.mode "none"`, `healthCheck: false`, empty install/build unless set, `settings.root =
  site.settings.publicDir` when set. `createAppDir: true`. Merged env is in both `spec.env` and
  `spec.settings.restart.env`. Linked DB env: first linked DB as returned by `mysql.envFor`
  (`DB_HOST…`), further ones prefixed with their name (`ANALYTICS_DB_HOST`). `specFor` is sync (skips
  linked env if `envFor` returns a Promise); `sites.specForAsync()` awaits it — SITES uses that internally.
- **SITES — release payload.** `site.deploy` gets `release: { id, url, token, sha256, size, filename,
  version, file? }`. `token` is a short-lived (6 h) download token accepted by `GET /agent/releases/:id`
  as `Authorization: Bearer <token>` or `?token=`; node Bearer auth (`cluster.authenticateNode`) also
  works, restricted to servers that host the site. `file` (absolute path) is set only for the main server.
- **SITES — ctx.sites extras.** `publicSite(site)`, `publicRelease(r)`, `releaseFile(id)`,
  `forDatabase(dbId)` → sites linking it, `pushEnv(siteOrId, { admin, restart=true })` → job that
  re-writes `.env` on every target (DATA: call after a password rotation), `unlinkDatabase(dbId)` (DATA:
  call when deleting a database), `refreshStatus(siteId)`.
- **SITES — HTTP details for UI.** Create returns the public site. `PATCH /api/sites/:id` returns the
  public site plus `job` (null, or the job that deploys to added servers → syncs nginx → `site.remove`s
  dropped servers; body may add `removeFilesFromOldServers: true`). `type`/`appDir` are only editable
  before the first deploy. Turning LB off without `serverIds` keeps the first server. Deploy/restart/stop/
  start/rollback/github/DELETE return the job record. `POST …/rollback { releaseId? }`: with an id →
  redeploy that release; without → snapshot rollback to `previousReleaseId` (falls back to redeploying it).
  `POST …/releases/github { ref?, repo?, deploy? }` (`deploy: true` deploys the new release in the same job).
  `PUT …/env { env } | { text }` (+ `restart: false` to skip the restart) → `{ env, linked, reserved,
  warnings, job }`; keys provided by linked DBs and `PORT` are dropped with a warning; `GET …/env` masks
  linked passwords. A second mutating operation on a busy site → 409 `{ error, jobId }`. Public site has
  `state[serverId]` (`running, healthy, version, releaseId, deployedAt, error, online, serverName`),
  `lb`, `currentVersion`, `busyJobId`, `envCount`, `github: { repo, branch, hasToken }`. Site `github`
  token is stored encrypted as `github.tokenEnc` (PATCH `github: { token }` / `{ clearToken: true }`);
  fallback is `config.github.token` (plain or encrypted). Releases carry `envExample: { file, entries:
  [{ key, value, comment }] }` from `.env.example` for env suggestions, `warnings`, `deployedOn: [serverId]`.
  `GET /api/github/refs?repo=&siteId=` → `{ repo, private, defaultBranch, branches, tags }`.
  Default appDir base honours `FCC_SITES_DIR` (default `/srv/fcc/sites`) + project `slug`.
- **CLUSTER — servers, tasks, metrics (implementation notes).**
  Server records: agent servers are stored with `role: "worker"`; public views (`listServers`,
  `getServer`, `/api/servers*`) add `kind` ("Main" | "Agent server"), `online`, `address`,
  `hasToken`, `siteCount`, `pendingTasks`, `metrics` (latest `{cpu %, mem, memTotal, disk, diskTotal, load, at}`,
  bytes used, or null). `lbEligible` (default true) is settable on POST/PATCH; main cannot be disabled
  or deleted. `POST /api/servers` / token rotate also return `warning` when the panel URL is loopback.
  `GET /api/servers/:id` adds `sites: [{ id, name, projectId, loadBalanced, port }]`.
  `cluster.metrics({ range })`: range `"1h"|"6h"|"24h"`; returns `{ range, step, from, to, servers, requests,
  perSite, perServer }`; server points are only minutes with samples (24h is 5-min buckets), request series are
  dense and items are `{ t, count, errors }` (errors = 5xx). `perServer` comes from `$upstream_addr`.
  `cluster.on("servers-changed", fn)` gets `{ reason, serverId }` (reason: created|updated|deleted|token|hello|online|offline).
  DATA: subscribe to it yourself for `mysql.syncRemoteHosts()` — cluster does not call it.
  `cluster.latestMetrics(id)`, `cluster.agentFiles()` are extras. Modules may export `stop(ctx)` (cluster saves metrics.json).
- **CLUSTER — task payload details (SITES/DATA).** `site.deploy` `release`: `file` (absolute path, used on main),
  else `url` (absolute or panel-relative) fetched with `Bearer release.token || <agent's server token>`; sha256 verified.
  `spec.healthPath` (optional) → health URL `http://127.0.0.1:<port><healthPath>` (node default `/api/health`);
  `spec.settings.healthUrl` wins. static/php: build/install commands run only if set explicitly in
  `spec.settings.build`; nginx root = `settings.root` or first of dist/build/out/public/_site with index.html
  (php: public/ with index.php), `settings.spa: true` → SPA fallback, `settings.phpFpm` overrides the socket.
  Local vhosts are `conf.d/fcc-app-<siteId>.conf` (main binds 127.0.0.1:<port>, agent servers bind :<port>).
  PHP tasks fail with a clear message when php-fpm is absent. All site tasks return `{ running, healthy, version, … }`.
  `server.backup` include: `{ panel, sites, nginx, paths: [] }` or an array of absolute paths — panel = dataDir
  (main only, backups/ excluded), sites = `/srv/fcc/sites` + `payload.appDirs`, nginx = /etc/nginx + /etc/letsencrypt.
  `payload.file`: on main the archive path; on agents only its basename is used for the uploaded file in
  `dataDir/backups/`. Result `file` is always a path on the main server. `upload` is filled in by `runTask`.
  Upload limit `config.cluster.maxUploadBytes` (default 50 GiB). Under DRY_RUN site tasks are simulated and
  backups are a tiny valid tar.gz.
- **CLUSTER — agent protocol.** `GET /agent/poll?wait=25&running=<ids>` → `{ tasks: [{ id, type, payload, timeoutMs }], cancel: [ids] }`;
  `POST /agent/tasks/:id/log { lines }` → `{ ok, cancel }`; `POST /agent/tasks/:id/result { ok, result, error, aborted }`;
  `POST /agent/upload/:taskId` raw gzip (+ `X-FCC-Sha256`) → `{ file, size, sha256 }`. `/install/files/*` needs
  `?server=&token=` or the Bearer token; `/install/files/` lists `sha256  path` of the agent closure
  (node-agent + its relative imports: shared/*.mjs, panel/lib/sys.mjs). The agent self-updates at hello when
  hashes differ (exit 0 → systemd restarts it). Worker layout: `/opt/fcc-node/{node,shared,panel/lib}`,
  `/etc/fcc-node/config.json` (600), `/var/lib/fcc-node`, unit `fcc-node.service`. Installer option `FCC_PHP=1`.
- **CLUSTER — load balancer.** Shared `conf.d/fcc-00-common.conf` defines `log_format fcc_main` and
  `map $http_upgrade $fcc_connection_upgrade`. LB pools use only `lbEligible` targets (all targets if none are).
  `down` = server disabled or 2 failed health checks in a row (LB sites with >1 target only; never all down;
  an offline agent alone does not mark it down). Optional `site.weights[serverId]` overrides server weight;
  optional `site.clientMaxBodySize` (default 100m). SSL: `certbot --nginx --cert-name fcc-<siteId>`, then the
  file is regenerated from our template with an SSL server + :80 redirect; lb writes `site.ssl = { enabled, status:
  pending|active|failed, issuedAt, error, domains, email }`. SSL email: body.email → admin email. Jobs: `lb.apply`, `site.ssl`.
- **DATA — mysql (all additive).**
  - Names: `<projectPrefix>_<name>` where prefix = project `slug` (or name) → `[a-z][a-z0-9_]{0,15}`; input is
    lower-cased, spaces/`-`/`.` → `_`, then strictly `^[a-z][a-z0-9_]*$` (db ≤ 64, user ≤ 32). `user` defaults to the db
    name. Charset whitelist `utf8mb4|utf8mb3|latin1|ascii` (+ optional `collation` from a per-charset whitelist).
    User passwords: 8–128 printable ASCII, no spaces; generated ones are 32 alphanumerics.
  - Database record gains `hosts` (account hosts), `sizeCheckedAt`, `passwordRotatedAt`. Public view adds
    `host, port, lastBackup, linkedSites: [{ id, name }]`.
  - `GET /api/mysql/status` also returns `flavor` ("mysql"|"mariadb"), `authMode` ("socket"|"password"),
    `bindAddress` (UI: warn when a DB has `remoteAccess` but bind is 127.0.0.1 — see OPS `FCC_MYSQL_REMOTE`),
    and on failure `clientVersion`, `rootPasswordSet`. `POST /api/mysql/root { password, user? }` verifies before
    storing; `password: ""` clears.
  - New `PATCH /api/databases/:id { remoteAccess }` → public db (re-syncs account hosts).
  - `DELETE /api/databases/:id` → 409 `{ error, sites }` while websites link it, unless `?force=1` (then
    `ctx.sites.unlinkDatabase()` is called). `&deleteBackups=1` also removes its backups (kept by default).
  - `POST /api/databases/:id/password { password? }` → `{ password, job, jobs: [{ id, siteId }], sites }` — one
    `ctx.sites.pushEnv()` job per linked site.
  - `POST /api/databases/:id/import?filename=` (`.sql`/`.sql.gz`/`.gz`, gzip detected by magic, ≤ 4 GB) → job record.
    Imports run as the **database's own user** over 127.0.0.1 (a dump can't touch other schemas); backup restores run as root.
  - `POST /api/databases/:id/credentials` also returns `remoteHost` (address agent servers use) when remoteAccess.
  - `ctx.mysql` extras: `dumpAll({ file, log, signal })`, `restore(dbId, { file, log, signal, as: "root"|"user" })`,
    `recreate(dbId)`, `refreshSizes({ force })`, `publicView(dbId)`. `envFor()` is synchronous.
- **DATA — backups (all additive).**
  - Routes return the **job record** (`POST /api/databases/:id/backups`, `POST /api/backups/server`, `…/restore`).
  - Backup record: `file` is relative to `dataDir/backups/`; extra fields `databaseName, jobId, finishedAt, adminId,
    remote: { type: "s3", key, bucket, uploadedAt } | { type, error }`. `trigger` may also be `"safety"` (automatic copy
    taken before a database restore). Public view adds `filename, databaseName, serverName, downloadUrl`.
  - `GET /api/backups` also filters `status`, `limit`; `GET /api/backups/:id` exists.
  - Schedules: `config.backups.database|server` gain `day` (0 = Sunday, weekly only); `every: "hourly"` uses the minute of
    `at`. `server.serverIds` (default `["main"]`) = which servers the server schedule backs up. `keep: 0` = unlimited;
    retention applies to all non-pinned `ok` backups of that database/server (manual included), and keeps the 5 newest
    failed records. Changing a schedule starts counting from now (no immediate run). State in
    `dataDir/backups/schedule-state.json`; a missed slot (panel down) runs once on the next minute tick.
  - `GET/PUT /api/backups/settings`: `{ database, server, destination: { type, endpoint, bucket, region, accessKey, prefix,
    pathStyle (default true), secretKeySet } }` + read-only `nextRun, lastRun, usage: { count, bytes }, localPath, timezone`.
    PUT takes `destination.secretKey` (write-only, stored as `secretKeyEnc`) or `clearSecretKey: true`.
    New `POST /api/backups/destination/test { …destination fields }` → `{ ok }` (PUT+DELETE of a tiny object) or 400.
    S3 uploads are single PUTs (≤ 5 GB per file); deleting a backup also deletes its off-site copy.
  - Main server archive: `tar -C / <paths> -C <staging> fcc-backup`; `fcc-backup/manifest.json` lists what was included
    (`paths.panel|sites|nginx`) and `fcc-backup/all-databases.sql.gz` when databases were included. panel = dataDir minus
    `backups/ tmp/ releases/ update-backups/`; sites = `FCC_SITES_DIR` (or `config.sitesRoot`) + appDirs of sites on main;
    nginx = `/etc/nginx/conf.d/fcc-*`, `/etc/nginx/fcc`, `/etc/letsencrypt`; `node_modules` and `.next/cache` excluded.
  - Server restore (`POST /api/backups/:id/restore { sites?: true, nginx?: true }`) is main-only, extracts site roots and
    `etc/nginx/conf.d/fcc-*` from the manifest, `nginx -t` then reload; never panel data (download the archive instead),
    never the bundled DB dump. Database restore: checksum check → safety backup → drop/recreate schema (grants survive) → load.
  - Agent server backups: `cluster.runTask(id, "server.backup", { include: { panel: false, sites, nginx }, appDirs, file })`,
    then the archive CLUSTER stored at `result.file` is moved to `backups/server/<id>/` and its sha256 checked.
