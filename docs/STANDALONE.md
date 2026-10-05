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
| `site.scripts` | `{ spec }` | `{ scripts: { name: command } \| null, packageName, version, hasNodeModules, appDir, hostname, error? }` (deployed package.json on that server) |
| `site.script` | `{ spec, script }` | `{ script, code: 0, durationMs }`; `npm run <script>` in appDir, only if the deployed package.json defines it; non-zero exit = failure with the output tail |
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
                                     // DB_HOST: the panel address (see Changes: DATA — database host); 127.0.0.1 on main only as fallback
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
server: { enabled, every, at, keep, include }, destination: { type: "local"|"s3"|"smb", ..., smb?: {...} } },
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
GET    /api/sites/:id/scripts?serverId           { scripts: [{ name, command, kind, risky, runnable }], source: "deployed"|"release"|null, serverId, servers, note }
POST   /api/sites/:id/scripts/run { script, serverId? | allServers? }  → job (type site.script, locked per site)
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
  - **SMB destination** (`panel/lib/smb.mjs`, DATA): `destination.type: "smb"` with `config.backups.destination.smb =
    { server, share, path (optional subfolder), username, passwordEnc, domain (optional), minProtocol: "SMB2"|"SMB3"|"NT1"
    (default SMB2 → `client min protocol=SMB2_02`; max is always SMB3), port (default 445) }`. S3 fields are kept alongside, so
    switching types loses nothing. PUT `/api/backups/settings` takes `destination.smb.password` (write-only, encrypted with
    `ctx.secrets`) or `destination.smb.clearPassword: true`; GET returns `destination.smb` with `passwordSet` (never the
    password) plus `smbclient: { installed, canInstall, dryRun }`. Server = host name or IPv4 (no IPv6 yet); user name without
    `\` (domain goes in its own field); use `guest` + empty password for guest shares.
  - Uses the `smbclient` CLI — no mounts. One short session per operation: `smbclient //server/share -A <dataDir/tmp/smb-auth-*>
    -p <port> -m SMB3 --option="client min protocol=…" -t 60 -c "<cmd>"`. The auth file (`username/password/domain`, mode 0600,
    created `wx`) is removed in `finally` (and swept at boot); the password is never in argv/env/logs, and smbclient output is
    scrubbed of it. Names are validated (no `; " * ? : < > | \`, control characters, `..`, leading/trailing space) and quoted;
    remote paths are joined with `\`. Upload = `mkdir` per path level (collisions ignored) then `put` (a partial file is
    deleted on failure; session timeout 10 min + 1 s/MB); deleting a backup `del`s its SMB copy when the destination still
    points at the same server+share.
  - Backup record `remote: { type: "smb", key: "<subfolder>/db/<slug>/<file>", server, share, uploadedAt, dryRun? } |
    { type: "smb", error }`. Public view `remote` gains `location` (`//server/share/key` or `s3://bucket/key`), `dryRun`,
    `fetchable` (SMB copy on the current destination). `available` now resolves `file` against the backups folder (it used to
    be tested against cwd and was always false).
  - Missing local file + SMB copy: restore jobs fetch it first (`get` → `.part` → sha256 check → rename); new
    `POST /api/backups/:id/fetch` → job (`backup.fetch`) to pull it back for download (download returns 410 with a hint
    until then). S3 has no fetch-back yet.
  - New routes: `POST /api/backups/destination/test { type: "smb", smb: {…} }` (mkdir subfolder → put → ls → del a tiny file;
    400 `{ error, log, notInstalled }`); `GET /api/backups/destination/remote?path=` → `{ path, location, items: [{ name, dir,
    size, modifiedAt }] }` (browses the saved SMB destination); `POST /api/backups/destination/smb/install` → job
    (`apt-get install smbclient`, retried after `apt-get update`; 400 when there is no apt-get). Audit: `backup.fetch`,
    `backup.smbclient.install`.
  - Install: `FCC_SMB=1 install.sh` apt-installs smbclient (remembered in installer.env). Without smbclient, uploads fail with
    "smbclient is not installed … `apt install smbclient`" and Settings → Backups shows an Install smbclient button.
  - `FCC_DRY_RUN=1`: smbclient commands are logged (with the auth-file path, never the password), uploads/deletes/fetches
    succeed; fetched files are placeholders and skip the checksum.
- **UPDATES — panel self-update (`panel/lib/updates.mjs`, port of v2 hub/lib/updates.mjs).**
  - Channel: `version.json` in the install dir (`repo`, `ref`, `commit`, written by install.sh) → `config.updates.{repo,ref}` →
    `llallenll/Forthway-Command-Center@standalone`. Installed commit: version.json `commit`, else `.git` HEAD (dev checkout).
    A version.json whose `version` differs from the running `VERSION` is ignored (stale stamp → "update available").
  - Check = `GET /repos/:repo/commits/:ref` + `GET /repos/:repo/compare/<installed>...<latest>` (2 API calls; the new VERSION is
    read from raw.githubusercontent). Uses the panel GitHub token (`config.github.tokenEnc`, or legacy plain `token`).
    Runs 30 s after boot and every 6 h (cooldown 6 h), on page load (skipped if < 10 min old), on the button (≥ 20 s apart);
    a rate-limit answer pauses all checks until `x-ratelimit-reset`. Last result is kept in `dataDir/updates-state.json`.
  - Routes: `GET /api/updates` → `{ installed: { version, commit, shortCommit, repo, ref, installedAt, source, stale },
    repo, ref, latest: { commit, shortCommit, version, message, author, date, url } | null, available: true|false|null,
    reason, changes: [{ sha, shortSha, message, author, date, url }] (newest first, ≤ 100), totalChanges, compareUrl,
    lastCheckedAt, error, checking, rateLimitedUntil, tokenSet, simulate: "dry-run"|"git-checkout"|null,
    restartMode: "systemd"|"service"|"manual"|"simulated", job: { id, type, status } | null, restart, bootId }`.
    `POST /api/updates/check { force? }` → same. `POST /api/updates/apply` → job (`panel.update`, lock `panel:update`; 409 while
    one runs). `GET /api/updates/backups` → `{ items: [{ id, takenAt, reason, was, updatingTo, items, size, simulated, valid }] }`.
    `POST /api/updates/backups/:id/restore` → job (`panel.restore`). SSE `updates` = the status (plus `restarting: true` just
    before a restart). `ctx.updates = { status, check, listBackups, health }`.
  - Apply: tarball of the exact checked commit (codeload; API tarball when a token is set) → staged in `<FCC_DIR>/.update-staging.*`
    → must contain `panel/server.mjs` + `shared/` → `node --check` server.mjs, core-routes.mjs, updates.mjs → backup of
    `panel node shared scripts patches README.md install.sh LICENSE version.json` to `dataDir/update-backups/<timestamp>/`
    (+ `_backup.json`; last 3 kept) → per-item rename swap (rolled back on failure) → new version.json
    (`{ version, repo, ref, commit, source: "github", via: "panel", updatedFrom, backup }`). Never touches the data dir, /etc/fcc
    or sites (refuses if the data dir is inside a code item). Restore: `node --check` the backup → safety backup → swap back.
  - Restart after a successful job (2 s later, once the log/SSE flushed): under systemd (`INVOCATION_ID`) the process SIGTERMs
    itself (graceful shutdown → `Restart=always`); else if `systemctl is-active fcc` → detached `systemctl restart fcc`; else the
    job tells the admin to restart. Agents get new files from `/install/files` at their next hello.
  - Simulation: with `FCC_DRY_RUN=1` or when the panel runs from a git checkout, download/verify/backup are real (in the data
    dir) but the swap, version.json and restart are only logged — the working copy is never written.
  - CORE touch: `/healthz` also returns `bootId` and `commit` (from `ctx.updates.health()`); the UI polls it after an update
    and reloads when `bootId` changes. UI: Settings → Updates (`#/settings/updates`), top-bar "Update available" chip.
- **DATA — database host = panel address (mysql.mjs, additive).**
  - New settings `config.mysql.publicHost` (override; must not be loopback) and `config.mysql.mainSitesVia: "panel"|"localhost"`
    (default `"panel"`). Effective panel address = `publicHost` → main server `privateHost` → main server `host` → panel URL
    hostname → first non-internal interface address (loopback values are skipped at every step).
  - Credentials (`POST /api/databases/:id/credentials`), the public view's `host`, the create dialog and `DATABASE_URL` use the
    panel address. Credentials also return `mainSitesHost` and `listensOnPublic`; `remoteHost` is kept (= panel address).
  - `envFor(id, { serverId })`: agent servers → panel address. Main server → panel address when `mainSitesVia = "panel"` **and**
    MySQL's `bind_address` accepts it (0.0.0.0 / * / :: / the address itself); otherwise `127.0.0.1` (unknown bind = 127.0.0.1,
    so a site never gets a host it can't reach). The last seen bind address is persisted as `config.mysql.lastBindAddress`.
    `envFor(id, { host })` forces a host. Public db view adds `mainSitesHost`.
  - Accounts: with `mainSitesVia = "panel"` every database user is also created for this server's own addresses (the panel
    address' IPs + non-internal interface IPs), because a connection to the public/private IP appears from it. Synced by
    `syncRemoteHosts()` (boot, servers-changed, settings change, bind change); hosts are still never `%`.
  - `GET /api/mysql/status` also returns `publicHost, publicHostOverride, publicHostDefault, publicHostSource, mainSitesVia,
    mainSitesHost, listensOnPublic`. Under DRY_RUN `bindAddress` is simulated (`config.mysql.dryRunBind`, default 127.0.0.1).
  - `GET /api/mysql/settings` → the above + `{ port, bindAddress, bindConfigFile, flavor, sitesUsingDatabases, dryRun }`.
    `PUT /api/mysql/settings { publicHost?, mainSitesVia?, pushEnv = true }` → settings + `{ changed, sync, changedSites, jobs }`:
    re-syncs accounts first, then `ctx.sites.pushEnv()` for each linked website whose DB_HOST changed. Audit `mysql.settings.update`.
  - `POST /api/mysql/bind { mode: "network"|"local" }` → job `mysql.bind` (lock `mysql.server`): writes the installer's own drop-in
    (`/etc/mysql/mysql.conf.d/zz-fcc.cnf` or `/etc/mysql/mariadb.conf.d/99-fcc.cnf`, same content as `FCC_MYSQL_REMOTE`),
    sets `FCC_MYSQL_REMOTE=1|0` in `/etc/fcc/installer.env` so a re-run keeps it, `systemctl restart mysql|mariadb` (file
    restored on failure), waits for MySQL, re-syncs accounts, pushes env to websites whose DB_HOST changed. 3306 is not opened
    in ufw. Audit `mysql.bind.update`.
  - `ctx.mysql` extras: `publicHost()`, `mainSitesHost()`, `settings()`, `localLogin(id)` (login over 127.0.0.1 for local tools —
    never returned to a browser), `refreshAddresses()`. Create/rotate/credentials responses are `Cache-Control: no-store`.
  - UI: Settings → Databases (`#/settings/databases`, `views/settings-databases.js`) shows the effective hosts, the override,
    the main-server choice, and a "Listen on the network…" button when bind is local; the Databases page links there.
- **DATA — phpMyAdmin (`panel/lib/phpmyadmin.mjs`, module `phpmyadmin`).**
  - Files: `<FCC_DIR>/phpmyadmin/` (dev: `dataDir/phpmyadmin/`): `app/` = official release from
    `https://files.phpmyadmin.net/phpMyAdmin/<v>/phpMyAdmin-<v>-all-languages.tar.gz`, verified against the published `.sha256`
    (latest version from `https://www.phpmyadmin.net/home_page/version.json`); `setup/ examples/ test/` removed;
    `app/config.inc.php` (0640 root:fcc-pma, `auth_type 'signon'`, session `FCCSignonSession`, 127.0.0.1:<mysql port>, no root,
    no password change, no arbitrary server, version check off); `app/fcc-signon.php`; `fcc.php` (outside the web root,
    0640 root:fcc-pma: shared secret, 32-byte `blowfish_secret`, loopback redeem URL, panel URL — secrets are stored encrypted
    in `config.phpmyadmin.secretEnc/blowfishEnc` and survive updates); `sessions/`, `tmp/` (0700 fcc-pma).
    Not in install.sh's / updates' code items, so panel updates keep it.
  - Runs in its own php-fpm pool `/etc/php/<v>/fpm/pool.d/fcc-phpmyadmin.conf` as system user `fcc-pma`
    (socket `/run/php/fcc-phpmyadmin.sock`, listen owner = nginx user), so PHP websites in the `www` pool can't read its
    secrets or sign-on sessions. Tested with `php-fpm<v> -t` before reload (restored on failure).
  - nginx: `/etc/nginx/conf.d/fcc-phpmyadmin.conf` (dev: `dataDir/nginx/`), `listen <port>` (default 8081, `[::]` too when IPv6
    exists), `server_name <hostname|_>`, never `default_server`. HTTPS automatically when `/etc/letsencrypt/live/<name>/` exists
    for `name` = configured hostname, else the panel URL's domain (497 → https redirect); otherwise plain HTTP with a UI warning.
    Denies dotfiles, `setup|libraries|templates|vendor|sql|examples|test|src|locale|tmp`, `config.inc.php`; the sign-on URL is
    not access-logged. CLUSTER: `loadbalancer.applyAll()` skips `fcc-phpmyadmin.conf` (it is not a website file).
  - Routes: `GET /api/phpmyadmin[?check=1]` → `{ installed, version, installedAt, sha256, dir, port, hostname, tlsName, tls, url,
    nginx: { installed, file }, php: { fpm, version, pool, socket }, apt, packages, latestVersion, latestCheckedAt, latestError,
    updateAvailable, lastCheck, busyJobId, warnings, dryRun }` (check=1 looks up the latest version, cached 6 h).
    `PUT /api/phpmyadmin/settings { port, hostname }` (1024–65535, not the panel port / 3306 / a site's port / a busy port;
    re-applies the vhost when installed, reverted on nginx -t failure). `POST /api/phpmyadmin/install { version? }`,
    `POST /api/phpmyadmin/update { version? }`, `DELETE /api/phpmyadmin` → job (`phpmyadmin.install|update|uninstall`, lock
    `phpmyadmin`, 409 while one runs). Install: apt packages (`php-fpm php-mysql php-mbstring php-xml php-zip php-gd php-curl
    php-intl`, only missing ones; without apt-get an existing php-fpm is required) → version → download + sha256 → extract to a
    staging dir → generated files → pool → swap `app/` (old one restored on failure) → nginx (test + reload, rollback) → a
    loopback request to `fcc-signon.php` must answer 401 with the sign-on page. Uninstall removes vhost, pool, files and the
    `fcc-pma` user; databases are untouched. Under DRY_RUN every step is logged, nothing is downloaded or installed, generated
    files + a pool preview are written under `dataDir/phpmyadmin/`.
  - Sign-on: `POST /api/databases/:id/phpmyadmin` (admin) → `{ url, expiresAt, database, tls }`; `url` =
    `<scheme>://<cert name | hostname | the host the admin used for the panel | panel address>:<port>/fcc-signon.php?token=<64 hex>`,
    single use, 60 s, kept in memory (hashed). The script POSTs `{ token }` to `http(s)://127.0.0.1:<FCC_PORT>/internal/pma/redeem`
    with `X-FCC-PMA-Secret`. That public route only answers requests from loopback / this machine without any proxy headers
    (`X-Forwarded-*`, `X-Real-IP`, `Forwarded`, `Via` → 403), with the right secret; the token is deleted on first use (410 when
    expired/used) and it returns the database user's own login `{ user, password, host: "127.0.0.1", port, db }`. phpMyAdmin then
    shows only that database (the user's grants). No root/"admin" sign-in on purpose (root is socket-auth only).
  - Audit: `phpmyadmin.install|update|uninstall`, `phpmyadmin.settings.update`, `database.phpmyadmin.open` (link issued),
    `database.phpmyadmin.signon` (link redeemed). SSE `phpmyadmin` on changes. UI: Settings → phpMyAdmin
    (`#/settings/phpmyadmin`), "phpMyAdmin" button + "Open in phpMyAdmin" menu item per database.
  - OPS: `install.sh` `FCC_PHPMYADMIN=1` installs the PHP packages (same as `FCC_PHP=1`) and allows 8081/tcp in ufw; the panel
    job does the rest.
- **CLOUDFLARE — Cloudflare Zero Trust / Cloudflare Tunnel (`panel/lib/cloudflare.mjs`, new module, loaded after backups).**
  Ported from v2 (`hub/lib/cloudflare.mjs`, `hub/lib/tunnel.mjs`, the cfLogin flow in `hub/server.mjs`).
  - **Delivery per domain.** A website's domain is either *Direct* (DNS A record → main server, nginx :80/:443, certbot) or
    *Cloudflare Tunnel* (Zero Trust public hostname). New site field, owned/shape-checked by SITES (`sanitizeCloudflare` in
    sites.mjs): `site.cloudflare = { enabled, tunnelId (Cloudflare tunnel UUID), hostnames: [] }`; `hostnames ⊆ domains` are
    delivered through the tunnel, every other domain stays Direct. Accepted on `POST /api/projects/:id/sites` and
    `PATCH /api/sites/:id` (`cloudflare` key); changing `domains` re-intersects `hostnames` (empty → `enabled: false`). Public site
    view has `cloudflare` (always an object) and `url` is `https://` for tunnel domains. When `enabled`, SITES awaits
    `ctx.cloudflare.validateSite(cf, { domains, siteId })` before saving: 400 `{ error, code }` with `code` one of
    `cloudflare_not_connected | cloudflare_tunnel_missing | cloudflare_tunnel_local | cloudflare_zone_missing (+ hostnames, zones)`,
    409 `cloudflare_hostname_taken` (the panel's own hostname), 502 `cloudflare_unreachable`. After create / a change of
    `cloudflare` or `domains`, SITES calls `ctx.cloudflare.syncSite(site)`; the delete job calls `await ctx.cloudflare.removeSite(site, { log })`.
  - **Routing.** Each tunnel hostname = ingress rule `{ hostname, service: "http://127.0.0.1:80", originRequest: { httpHostHeader: hostname } }`
    + proxied CNAME `hostname → <tunnelId>.cfargotunnel.com` (comment "Forthway Command Center"). Traffic therefore enters the
    same nginx front door as Direct domains (LB, health checks, access logs unchanged). When the site's `ssl.status === "active"`
    the rule becomes `https://127.0.0.1:443` with `originServerName` + `noTLSVerify` (nginx's :80 block only redirects to https,
    which would loop through a tunnel); CLOUDFLARE listens to `lb` events with `ssl` and re-syncs. Only rules / DNS records the
    panel created are changed or deleted; dashboard-made rules are kept in order, an identical pre-existing rule or CNAME is
    *adopted* (never deleted), and the catch-all (existing one, else `http_status:404`) is always written last. A clashing
    A/AAAA/CNAME record or a different existing rule is an error on that hostname unless the admin asks to replace it
    (`replaceExisting`). All ingress read-modify-writes are serialised.
  - **Ledger** collection `cloudflareRoutes`: `{ id, owner: "site:<id>"|"panel", siteId, hostname, tunnelId, zoneId, zoneName,
    service, ruleKey, ingress: "created"|"adopted"|null, dnsRecordId, dnsCreated, status: "active"|"error"|"manual", error, code, syncedAt }`.
  - **config.json** `cloudflare: { apiTokenEnc, accountId, accountName, viaLogin, connectors: [{ id, name, tokenEnc, autoStart, cfId }],
    panel: { hostname, tunnelId } | null }` — tokens encrypted with `ctx.secrets`. Connecting: (1) *Log in with Cloudflare* —
    `cloudflared tunnel login` with `HOME=dataDir/cloudflared-home`, the origin cert carries account + API token;
    (2) API token (Account·Cloudflare Tunnel·Edit, Zone·DNS·Edit, Zone·Zone·Read); (3) connector token only — the connector runs,
    hostnames get `status: "manual"` with dashboard instructions. Connectors run `cloudflared --no-autoupdate tunnel run` with
    `TUNNEL_TOKEN` in env (never argv), detached, backoff 2 s → 60 s, fatal on a rejected token, pid files in `dataDir/run/`
    (a leftover connector from a crashed panel is stopped). cloudflared is taken from PATH, else `dataDir/bin/cloudflared`,
    downloaded from Cloudflare's GitHub releases on first use (linux amd64/arm64/arm).
  - **`ctx.cloudflare`**: `status()`, `options()` (tunnels + zone names for pickers), `zones({ fresh })`, `syncSite(site, { replaceExisting, admin, force })`
    → job record (`type: "cloudflare.sync"`, `lock: false`) or null when nothing to do, `removeSite(site, { log })` → Promise,
    `validateSite(cf, { domains, siteId })`, `siteRoutes(siteId)`, `isTunnelHostname(h)`. Exports `stop()` (stops connectors).
  - **Routes** (admin): `GET /api/cloudflare` (status + accounts, zones, account tunnels, `warning`, `error`) ·
    `GET /api/cloudflare/status` · `GET /api/cloudflare/options` · `GET /api/cloudflare/zones` ·
    `POST /api/cloudflare/token { token }` (`""` disconnects) · `POST /api/cloudflare/account { accountId }` ·
    `POST|GET /api/cloudflare/login` (start → `{ url }` / poll → `{ done, error }`), `POST /api/cloudflare/login/cancel` ·
    `POST /api/cloudflare/tunnels { name? | tunnelId?, start?, autoStart? }` (create or adopt a dashboard-managed tunnel, run it here) ·
    `GET|POST /api/cloudflare/connectors` (`{ token, name?, autoStart? }`), `PATCH|DELETE /api/cloudflare/connectors/:id`,
    `POST /api/cloudflare/connectors/:id/start|stop|restart`, `GET /api/cloudflare/connectors/:id/logs?lines=` ·
    `POST /api/cloudflare/install` · `GET /api/cloudflare/routes` (`{ items: ledger, tunnels: [{ tunnelId, name, rules: [{ hostname, path,
    service, catchAll, managed, adopted, siteId, siteName, panel }], error }] }`) · `GET /api/cloudflare/sites/:id`
    (`{ cloudflare, connected, domains: [{ hostname, mode: "direct"|"tunnel", route }], leftovers }`) ·
    `POST /api/cloudflare/sites/:id/sync { replaceExisting? }` → job · `PUT /api/cloudflare/panel { hostname, tunnelId }`
    (publish the panel → `http(s)://127.0.0.1:<panel port>`; `""` unpublishes) → `{ panel, job }` ·
    `POST /api/cloudflare/reset` → `{ removed, remaining, tunnelStopped }` (local only: stops connectors, deletes credentials,
    connector tokens, the login cert under dataDir and the ledger; tunnels, routes and DNS stay in Cloudflare).
  - **SSE `cloudflare`**: `{ kind: "status", status }` (coalesced), `{ kind: "log", id, line }` (connector output),
    `{ kind: "routes", owner, siteId }` (after a sync). Added to `events.js` TYPES. Audit actions `cloudflare.*`.
  - **Panel hostname & SSE**: the panel's rule sets no `disableChunkedEncoding` and no short timeouts (the `/api/events`
    stream must survive; cloudflared defaults keep it open); the panel creates no cache / Rocket Loader rules.
  - **UI**: wizard Domains step — "How visitors reach it" (Direct / Cloudflare Tunnel cards), per-domain Direct/Tunnel switch,
    tunnel picker, zone check, not-connected notice linking to Settings → Cloudflare, DNS box text per mode; website
    Domains & SSL tab — per-domain delivery + live route status, retry / "Replace existing records", certbot card replaced by
    "Cloudflare terminates HTTPS" when every domain is tunnelled; Settings → Cloudflare (`#/settings/cloudflare`). Code in
    `public/assets/views/cloudflare.js`; small hooks in wizard.js, site.js, settings.js, sites.js (`siteUrl`), app.css (`.cf-*`).
  - **Dev**: `FCC_DRY_RUN=1` never spawns or downloads cloudflared (connectors simulated) and never reads a cert from `$HOME`.
    `FCC_DRY_RUN=1 FCC_CLOUDFLARE_FAKE=1` also replaces api.cloudflare.com with an in-memory fake (account "Dev account
    (simulated)", zones example.com / example.org, any token except `bad`, login completes after ~2 s), persisted in
    `dataDir/cloudflare-fake.json` — no network.
  - CLUSTER, please: `lb.issueCertificate()` requests every `site.domains` entry; consider skipping tunnel hostnames
    (`ctx.cloudflare?.isTunnelHostname(d)`) — they don't need a certificate (validation would still go through the tunnel).
- **SITES — package.json scripts (named actions, still no terminal).** "Run `db:push`" and friends:
  - **Tasks** (shared/tasks.mjs, both main and agents): `site.scripts { spec }` reads `<appDir>/package.json` on that
    server; `site.script { spec, script }` runs `npm run <script>` — spawned without a shell, the name passed as its own
    argument after a strict check (`/^[A-Za-z0-9_][A-Za-z0-9:._+-]{0,99}$/`, no `..`), and refused unless it is a key of
    the deployed package.json's `scripts`. cwd = appDir; env = the app's own (process env minus `npm_*`, site env + linked
    DB vars, `PORT`, `NODE_ENV=production` unless the site sets it); the managed `.env` block is refreshed first (prisma &
    co. read it); npm puts `node_modules/.bin` on PATH. Output streams to the job log. Killed (whole process group) after
    15 min (`SCRIPT_TIMEOUT_MS`; cluster timeout 17 min) or on cancel. Holds the per-site task lock on that server.
    `FCC_DRY_RUN=1`: logs what would run. Agents pick the new task up via the existing stale-files self-update.
  - **Routes**: `GET /api/sites/:id/scripts?serverId` — deployed package.json via `site.scripts` on that server (default:
    first target), falling back to the release record's `scripts` when the server is offline/old (`source: "release"`,
    `note` says why). Each script gets `kind`: `"task"` (default list), `"hook"` (npm lifecycle + pre/post hooks of other
    scripts; under "Show all", runnable) or `"app"` (`start`, `dev`, `serve`, `preview`, `watch` and their pre/post —
    shown, never run: they'd fight pm2 for the port), and `risky` (name/command matches push, migrate, reset, drop, seed,
    truncate, wipe, purge, destroy, fresh, rollback, `--force-reset`, `--accept-data-loss`, `--force` → the UI asks with
    a danger confirm). `POST /api/sites/:id/scripts/run { script, serverId? }` → job `site.script` titled
    "npm run db:push on VPS 200"; 409 while another site job runs (deploy, restart…), 409 if not deployed / server offline,
    400 for invalid names, app scripts, or names the deployed release's package.json lacks. Load-balanced sites run on
    ONE server (picked, default first target) — DB changes must run once; `allServers: true` runs on every target one at
    a time (stops at the first failure). Audit action `site.script` `{ script, servers }`.
  - **After-deploy scripts (opt-in)**: website setting `settings.afterDeployScripts: string[]` (≤ 5 names, validated; app
    scripts refused; default `[]`). On `POST /api/sites/:id/deploy` and GitHub pull-and-deploy (not on rollbacks), they run
    once, on the first target only, right after it serves the new release and before any other server is deployed. A
    failure fails the deploy there (other servers keep the old release; the first server keeps the new one).
  - **UI**: website tab **Scripts** (`#/sites/:id/scripts`, code in `views/site-scripts.js`; site.js only adds the tab,
    a "Run a script…" item in the header ⋯ menu and the "After deploy, run" field in Settings → Build & run): list with
    command text, Run buttons, server picker + "run on every server" checkbox for LB sites, confirm (danger for risky),
    output in the standard job log modal, "Recent script runs" (`/api/jobs?siteId&type=site.script`). components.js:
    `site.script` job icon + activity verb. (views/sites.js has no row menu, so nothing was added there.)
- **MONITOR — uptime monitoring + SMS alerts via Bird (`panel/lib/monitor.mjs`, module `monitor`, new).**
  - **Checks** from the main server (default every 60 s, timeout 10 s; `node:http(s)`, no redirects followed, response time = time to
    headers). Target: per-site custom `url` → first domain (`https` when `ssl.status === "active"` or the domain is a Cloudflare tunnel
    hostname) → no domain: first upstream `address:port` from `ctx.lb.upstreams(site)` (main = 127.0.0.1). Path: per-site `path` →
    `site.healthPath` → `/`. Pass = status inside `expectMin..expectMax` (default 200–399); network error / timeout / TLS error / other
    status = fail. DOWN after `failThreshold` (3) fails in a row, UP after `recoverThreshold` (2) good checks. Never-deployed sites are
    `pending` (not checked) unless they have a custom URL. LB per-server health is folded in: an up site with an unhealthy/`down`
    upstream is `degraded` (`unhealthyServers`). Real requests also under DRY_RUN (unresolvable dev domains simply fail).
  - **Storage** (db.json stays small): `dataDir/monitor/state.json` (runtime per site, SMS rate-limit map, heartbeat `savedAt` every 15 s,
    `gaps`), `dataDir/monitor/sites/<siteId>/<UTC-day>.json` = `{ v, day, s: 1440 chars, r: [1440 ms] }` per-minute buckets
    (`.` no data · `u` up · `f` failed check before DOWN · `d` down · `p` paused; worst result in a minute wins; when DOWN is confirmed
    the streak's `f` minutes become `d`), 90 days kept. Collections: `monitors` (`{ id: siteId, …settings }`), `incidents`
    (`{ id, siteId, projectId, siteName, domain, target, startedAt (first failed check), confirmedAt, endedAt, durationMs, endedBy:
    "recovered"|"paused", cause, lastCause, lastStatus, servers, failedChecks, notify: { [phone]: { lastAt, ok, name } }, alerts: [{ at, kind:
    "down"|"reminder"|"up", to, name, ok, simulated, skipped, error, messageId, api, text }], gaps, lastAlertAt }`; ≤ 300 per site, closed ones
    pruned after 90 days). Uptime % = (u+f)/(u+f+d) over minutes with data (paused and no-data minutes excluded); 24 h from minute buckets,
    7/30/90 d from cached hourly aggregates. Panel offline (heartbeat older than 90 s at boot) → `{ from, to, reason: "panel offline" }` gap on
    the monitor and on every open incident; minutes in it stay "no data". State and open incidents (incl. `notify.lastAt`) survive restarts.
    Deleting a website (SSE `site` with `deleted`) drops its files, settings and incidents.
  - **SMS** (`config.json` → `notifications: { enabled, provider: "bird", bird: { accessKeyEnc, workspaceId, channelId, from }, defaults:
    [{ name, phone }], repeatMinutes: 60, notifyRecovery: true }`; key encrypted with `ctx.secrets`, never returned or logged). Bird API is
    picked from the key: `bk_<region>_…` → platform API `POST https://<region>.platform.bird.com/v1/sms/messages`, `Authorization: Bearer`,
    `{ to, from, text, category: "transactional" }` (needs a sender); any other key → Channels API `POST https://api.bird.com/workspaces/
    <workspaceId>/channels/<channelId>/messages`, `Authorization: AccessKey <key>`, `{ receiver: { contacts: [{ identifierValue }] }, body:
    { type: "text", text: { text } } }`. Recipients = site `recipients` + `defaults` (if `includeDefaults`, default on), deduplicated by E.164
    number. On DOWN: one text each; while down: again every `repeatMinutes` (site override → panel default 60); on recovery: one "back up after
    X" text to everyone who was texted successfully (`notifyRecovery`). Never more than one non-recovery text per number per site per 10 min
    (`FCC_MONITOR_SMS_MIN_GAP_SEC` overrides, for testing); a first text blocked by that limit is logged as `skipped` and sent when allowed;
    a failed send is retried after the same window. Texts are ≤ 160 GSM-7 chars. Every attempt → incident `alerts` + activity `monitor.sms`
    (failures also to the console, number masked). Sending runs beside the check loop and never throws into it. **DRY_RUN never calls Bird**:
    `[monitor] [dry-run] would text +1… : message` in the log, recorded as `simulated`.
  - **Routes**: `GET /api/monitor` → `{ items: summary[], counts: { total, up, down, paused, pending, unknown, degraded }, notifications }`;
    summary = `{ siteId, name, projectId, domain, state: "up"|"down"|"unknown"|"paused"|"pending", since, degraded, unhealthyServers, servers,
    lastCheck: { at, ok, status, ms, error, url }, failing, incidentId, paused, pauseUntil, intervalSec, sms: { enabled, recipients }, target,
    uptime: { h24, d7, d30, d90 } (%, null = no data), downMinutes, avgMs24h, bars24h: [24 × ratio|null|-1 paused] }` ·
    `GET /api/sites/:id/monitor?range=24h|7d|30d|90d` → `{ summary, settings, effective: { url, how, path, healthPath }, recipients,
    notifications, series: { range, step, points: [{ t, ms, uptime, up, down, paused }] }, days: [90 × { day, uptime, downMinutes,
    pausedMinutes, avgMs }], incidents (25), gaps }` · `PUT /api/sites/:id/monitor { intervalSec (10–3600; 2 under DRY_RUN), timeoutSec,
    path, url, expect: "200-399" | expectMin/expectMax, failThreshold, recoverThreshold, smsEnabled, recipients: [{ name, phone }],
    includeDefaults, repeatMinutes|null }` · `POST /api/sites/:id/monitor/pause { minutes?, reason? }` (closes an open incident with
    `endedBy: "paused"`, no text; auto-resumes at `pauseUntil`) · `POST /api/sites/:id/monitor/resume` · `POST /api/sites/:id/monitor/check`
    (check now) · `GET /api/incidents?siteId&status=open|closed&limit` · `GET|PUT /api/notifications/settings` (`accessKey` write-only,
    `clearAccessKey: true`; view has `accessKeySet, accessKeyHint, api, configured, problem, defaults, repeatMinutes, notifyRecovery,
    minGapMinutes, dryRun`) · `POST /api/notifications/test { to }` → `{ ok, simulated, error, api, messageId, to, text }` (5 s cooldown).
    Phone numbers must be E.164 (spaces, dashes, brackets and a leading 00 are normalised). Audit: `monitor.down|up|sms|pause|resume|
    settings.update`, `notifications.settings.update|test`.
  - **SSE `monitor`** (added to events.js TYPES): `{ kind: "down", siteId, siteName, projectId, incidentId, cause, since, at }`,
    `{ kind: "up", …, durationMs }`, `{ kind: "update", items: [light summaries with uptime.h24] }` (coalesced, ≤ every 5 s),
    `{ kind: "sms", siteId, incidentId, ok, simulated }`, `{ kind: "settings", siteId }`, `{ kind: "notifications" }`.
    `ctx.monitor = { summary(siteId), list(), downCount(), incidents(filter), checkNow(siteId), sendSms(to, text) }`.
  - **UI** (`views/monitor.js`): website tab **Uptime** (`#/sites/:id/uptime`: status, uptime 24h/7d/30d/90d, 24 h + 90-day bar strips,
    response-time chart, incidents with their SMS log, check + text-alert settings, Check now / Pause / Resume); Settings → **Notifications**
    (`#/settings/notifications`); Websites list + project page rows get a `[data-uptime]` slot (dot, 24 h %, mini 24 h strip) filled by
    `bindUptime()` — no `.site-row` grid changes; dashboard "N websites down" card (`downBanner`); global toast on down/up (app.js).
    Small hooks in site.js, sites.js, project.js, settings.js, dashboard.js, app.js, events.js, icons.js (`bell`), app.css (`.up-*`, `.inc*`, `.rcp-*`).
- **ANALYTICS — unique visitors, page views, requests (new module `panel/lib/analytics.mjs`, in MODULES after `monitor`).**
  - **Input**: CLUSTER's access-log tailer hands each batch of new lines to `ctx.analytics.ingest(site, lines)` (one hook in
    `cluster.mjs tailAccessLogs`). Nothing is added to the websites: no script, no cookie.
  - **Log format (CLUSTER, loadbalancer.mjs)**: site files now use `log_format fcc_v2 escape=json '$msec $status $request_time
    "$upstream_addr" "$host" "$request_method" "$request_uri" $body_bytes_sent "$http_user_agent" "$remote_addr"
    "$sent_http_content_type" "$http_referer" "$http_sec_fetch_dest" "$http_sec_purpose$http_purpose" fcc2'` (no `escape=` on
    nginx < 1.11.8). It starts like `fcc_main`, so CLUSTER's request/error/per-server counter is unchanged; `fcc_main` stays
    defined in `fcc-00-common.conf` for files not yet regenerated. Old `fcc_main` / `combined` lines count as requests only.
  - **Real client IP (CLUSTER)**: new `conf.d/fcc-00-realip.conf` (http level, owned by loadbalancer.mjs, part of `applyAll`
    and `syncSite`): `set_real_ip_from` 127.0.0.1, ::1 (Cloudflare Tunnel) and Cloudflare's ranges, `real_ip_header
    CF-Connecting-IP`. Ranges come from cloudflare.com/ips-v4 + ips-v6 (`panel/lib/cfips.mjs`), refreshed daily, cached in
    `dataDir/cloudflare-ips.json`, built-in fallback list; a change triggers `applyAll` (nginx -t + rollback). Not fetched under
    `FCC_DRY_RUN=1` unless `FCC_CF_IPS_FETCH=1`. The file is written as a comment ("Disabled: …") when nginx lacks
    `--with-http_realip_module`, when `real_ip_header` is already set in nginx.conf / conf.d / sites-enabled, or when nginx
    rejected it (applyAll then retries once without it, so site changes never get blocked). `proxyLocation()` is unchanged:
    after real_ip, `X-Real-IP $remote_addr` is the visitor and `X-Forwarded-For` ends with the visitor (Cloudflare's own XFF
    entry may precede it). `GET /api/loadbalancer` gains `realIp: { enabled, reason, header, ranges, fetchedAt, file }`.
  - **Definitions**: *requests* = every line. *Page views* = GET, 2xx (not 204/206) or 304, `text/html` (or no Content-Type
    logged and a non-asset path), Sec-Fetch-Dest `document` when sent, not prefetch/prerender, not `/api/ /_next/ /static/
    /assets/ …`, asset extensions, favicon/robots, `/api/health`, `/api/version`, `/healthz`…, `site.healthPath`, `?_rsc=`;
    and not a bot. *Bots* = empty UA, UA without `Mozilla/`/`Opera`, or a token from `BOT_UA_TOKENS` (bot, crawl, spider,
    curl, python, go-http, headless, uptime, monitor, preview, `fcc-`, `forthway` …). *Unique visitors* = distinct
    `HMAC-SHA256(daily salt, IP + "\n" + UA)` (first 32 bits) among page views. The salt is random per UTC day, kept in
    `dataDir/analytics/salt.json` (0600) and deleted 10 min after the day ends; raw IPs are never stored.
  - **Uniques method**: exact id sets per minute (kept 2 h), hour (49 h) and UTC day (2 d), switching to a HyperLogLog sketch
    (p=12, 4 KiB, ≈1.6 % error) above 1024 ids. 1h / 24h headline = union of the minute / hour sets (a visitor on both sides of
    midnight UTC counts twice in 24h); **7d / 30d = sum of daily unique visitors** (ids rotate daily — labelled "per day" in
    the UI). Chart points are unique visitors per bucket. "Previous period" = the same length immediately before, ending at
    the same point in time (partial buckets weighted).
  - **Storage**: `dataDir/analytics/{all,site-<id>}.json` (atomic, every minute when dirty + on stop): minute buckets 26 h,
    hour buckets 32 d, day buckets 400 d (`[t, requests, pageViews, uniques]`), live id sets, top paths / referrer hosts per
    hour (26 h) and per day (31 d), capped. Deleted sites' files are removed on the next save. Restarts mid-day keep counting
    each visitor once (sets + salt persisted); lines written while the panel is down are not counted (the tailer starts at EOF).
  - **Route** (admin): `GET /api/analytics?range=1h|24h|7d|30d[&siteId=]` → `{ range, step, from, to, now, siteId, since,
    visitorsSince, uniquesMethod: "exact"|"estimate"|"daily-sum", series: [{ t, requests, pageViews, uniques }],
    previousSeries (t shifted onto the current period), totals, previous, change: { requests, pageViews, uniques } (% or null),
    topPages: [{ path, views }], topReferrers: [{ host, visits }] (site only; path without query, referrer host only, own
    domains excluded) | topSites: [{ siteId, name, uniques, pageViews, requests }] (all sites) }`. Steps: 1h = minute,
    24h / 7d = hour, 30d = UTC day.
  - **UI**: `public/assets/traffic.js` (`trafficCard`, `topList`): dashboard "Traffic overview" = tabs Visitors (default; visitors
    + page views lines) / Page views / Requests / CPU load, ranges 1h / 24h / 7d / 30d, headline Unique visitors / Page views /
    Requests with % vs the previous period, Compare overlays the previous period, "Collecting since …" note; website **Traffic**
    tab (`views/site-traffic.js`; hooks in site.js) with the same card + Top pages + Top referrers. Styles `.tr-*` in app.css;
    `charts.js` shows date-only tooltips for 30d; mock route in mock.js. `/api/dashboard` is unchanged (CPU is still kept 24 h).
- **SITES / TASKS / CLUSTER — build once, ship everywhere (load-balanced sites).** Building a
  release separately on every server gave each server its own Next.js chunk hashes, build ID and
  Server Action IDs, so HTML from one server asked for chunks only it had (`ChunkLoadError`, 404 on
  `/_next/static/chunks/…`) and Server Action POSTs to another server failed ("Failed to find Server
  Action"). Now, for a site with `loadBalanced` + ≥2 targets + a build command (and a release that
  is not already prebuilt):
  - **First server builds and packages.** `site.deploy` payload gains `package: { releaseId:
    "<rel>-built", file? }`. The engine (`Deployer.packageBuild`, run right after the build, before
    the swap) zips the staging tree *with* build output but *without* `node_modules`, the work dir
    (`.forthway`), `.git`, `.env*` files, the preserve list (uploads, logs), `.next/cache`,
    `build-info.json`, `*.log` (limit 65 000 files / 2 GiB — zipwrite has no zip64). Main writes it
    straight to `dataDir/releases/<rel>-built.zip`; an agent uploads it via `POST /agent/upload/:taskId`
    (now also accepted for a `site.deploy` that carries `payload.package`; the panel picks the
    destination, never the agent). Result field `packaged: { size, sha256, fileCount, uploaded? } |
    { error }`. A packaging/upload failure does not fail that server's deploy; the panel logs it and
    the remaining servers build for themselves (the old behaviour) — also what happens with an agent
    too old to package.
  - **Other servers deploy the package.** `release` payload gains `prebuilt: true, builtOn`; the
    engine treats `job.prebuilt` like a detected `.next/BUILD_ID` (works for `dist/`/`out/` builds
    too): it still installs dependencies (`--include=dev` kept) and runs prepare (an explicit
    prepare, or the auto `npx prisma generate` when deps/schema changed — the generated client lives
    in `node_modules/.prisma`, which is never shipped), and skips the build. `forceBuild` still wins.
  - **Storage.** Not a release of its own: recorded on the source release as `release.built = { sha256,
    size, fileCount, builtOn, builtAt, fingerprint }`, file `releases/<rel>-built.zip`, deleted with the
    release by retention/delete. `GET /agent/releases/<rel>-built` serves it (same token/node auth).
    `publicRelease` gains `built: { builtOn, builtOnName, builtAt, size, sizeHuman, fileCount,
    available } | null` (UI badge "Shared build").
  - **Reuse.** Redeploys, `rollback` (with or without `releaseId`) and servers added through
    `PATCH /api/sites/:id` deploy the stored build to every server when its `fingerprint` (sha of the
    site's variables incl. the managed key, build settings, publicDir) still matches; otherwise the
    release is built once on the first server and shipped again (`PATCH` add-server then redeploys all
    targets). Rollback without `releaseId` on such a site redeploys the previous release this way instead
    of restoring each server's own snapshot. After-deploy scripts still run once, on the first server.
    Single-server sites are unchanged.
  - **Server Actions key.** Node sites get a panel-managed `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`
    (32 random bytes, base64), created on the first deploy unless the site's own env defines it, stored
    encrypted as `site.actionsKeyEnc`, merged under the site's env in every task spec (site env and
    linked DB vars win). `GET /api/sites/:id/env` gains `managed: [{ key, value (masked), pending, note }]`,
    shown read-only in the Environment tab.
  - **Mixed releases.** `publicSite` gains `releasesInLine` and `releaseSpread: [{ releaseId, version,
    servers: [{ id, name }] }]` (non-empty only when targets disagree); server state gains `build`
    ("built" | "prebuilt" | "shipped from <server>"). A rolling deploy that stops part-way logs and
    returns "Servers are on different releases — redeploy to bring them in line" with who is on what,
    and the site Overview shows that warning with a redeploy button. The nginx `/_next/static/` retry
    on 404 (`proxy_next_upstream http_404`) stays as a safety net.
- **CORE — Sign in with GitHub replaces passwords** (`panel/lib/login.mjs`, registered from
  core-routes; `panel/recover.mjs`). GitHub OAuth App web flow with PKCE S256; admins are matched
  on the numeric GitHub user id (login/avatar refreshed at each sign-in), the GitHub access token
  is revoked and dropped right after the identity check, never stored.
  - **Config.** `config.auth = { provider: "github" | undefined, github: { clientId, clientSecretEnc,
    org? }, switchedAt?, switchedBy? }`. `provider: "github"` = GitHub-only (password routes refuse);
    undefined = a panel from before this change, which keeps password sign-in until switched.
    The secret is `ctx.secrets`-encrypted and only ever returned as a hint. Scope `read:user user:email`
    (+ `read:org` when `org` is set). Callback URL = `ctx.panelUrl(req) + "/auth/github/callback"`
    (config.panelUrl → FCC_PANEL_URL → the request, honouring FCC_TRUST_PROXY).
  - **Admin record.** `admin { …, email (may be "" for GitHub admins), github: { id, login, avatarUrl,
    linkedAt, via?: "org" } | null, sessionVersion }`; `passwordSalt/passwordHash` only until
    GitHub-only (then deleted). `publicAdmin` adds `github: { id, login, avatarUrl } | null` and
    `hasPassword`.
  - **Sessions.** Same signed cookie, but `pv` (password fingerprint) is replaced by
    `sv = admin.sessionVersion`; bumped by sign-out-everywhere, GitHub (un)link/change, password
    change/reset. Old `pv` cookies stay valid until GitHub-only. `ctx.auth` gains `mode()`,
    `bumpSessions(id)`, `seal(purpose, payload)` / `unseal(purpose, token)` (domain-separated HMAC,
    with `exp`), and `setSession/clearSession` now append Set-Cookie headers.
  - **Routes** (public unless noted):
    `GET /auth/github?mode=login|link|setup&next=` → state+verifier in signed `fcc_oauth` cookie
    (HttpOnly, SameSite=Lax, Path=/auth/github, 10 min) → 302 to GitHub; redirects first to the panel
    URL's host if the browser is on another host. `GET /auth/github/callback` → on success a tiny HTML
    page that `location.replace()`s (a Strict cookie isn't sent on a navigation started on github.com);
    on failure 302 to `/login?error=<code>[&login=]`, `/setup?error=`, or
    `/?auth_error=<code>#/settings/security` (link). Codes: not_admin, state, denied, github_error,
    client, redirect, not_configured, throttled, session, taken, origin, recovery, recovery_expired.
    Callback failures count in the login throttle. `next` must be a panel path; it always lands on
    `/#<path>` (no open redirect).
    `GET /auth/recover?token=` — redeems the one-time link from `recover.mjs` (sha256 in
    `dataDir/recovery.json`, 600, 15 min, deleted on use).
    `GET /api/setup` adds `auth: { github, githubOnly, passwordLogin, devLogin }` and, while setting up
    with a verified code, `{ setupVerified, panelName, panelUrl, suggestedPanelUrl, callbackPath,
    clientId, clientSecretSet, setupCodeFile }`. `POST /api/setup/verify { code }` → `fcc_setup` cookie
    (Strict, 2 h). `POST /api/setup { panelName, panelUrl, clientId, clientSecret }` (needs that
    cookie) — the old `{ name, email, password }` setup is gone; the first GitHub sign-in in setup
    mode creates the owner, sets provider "github" and deletes `dataDir/setup-code` (created at boot
    while there are no admins, mode 600, printed to the journal). `POST /api/auth/dev` — only with
    FCC_DRY_RUN=1 **and** FCC_DEV_LOGIN=1 (404 otherwise).
    Session routes: `GET /api/auth` (security view: OAuth app incl. hint, callback/homepage URL,
    admins + linked state, `canSwitch`, `blockers`), `PATCH /api/auth { clientId?, clientSecret?, org? }`,
    `POST /api/auth/github-only` (needs the OAuth app, the caller linked and the owner linked; drops
    password hashes), `DELETE /api/me/github` (not when GitHub-only), `POST /api/me/sessions/revoke`.
    `POST /api/admins { githubLogin, name? }` (resolved with `api.github.com/users/<login>`, panel
    token if set); `PATCH /api/admins/:id { githubLogin }` sets/changes someone else's account (ends
    their sessions). `POST /api/login`, `/api/me/password` and password fields refuse when GitHub-only.
    `GET /api/settings` adds `authMode: "password"|"github"` and `githubSignInReady`.
  - **Test hooks.** `FCC_GITHUB_OAUTH_BASE` / `FCC_GITHUB_API_BASE` replace github.com /
    api.github.com — honoured only with FCC_DRY_RUN=1.
  - **UI.** login.html = one "Sign in with GitHub" button (+ the password form only during the
    migration window, + dev button), callback error messages (`assets/login-errors.js`), recovery hint.
    setup.html = setup code → name/URL → OAuth App instructions with copyable URLs → sign in.
    Settings gains **Security** (`views/settings-auth.js`, which now also holds Admins and Account);
    the app shell shows a "Password sign-in is being retired" banner while `authMode` is "password".
    Styles in `assets/auth.css` (not app.css).
