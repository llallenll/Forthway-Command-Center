# High availability — Phase 1: Edge nodes (v3.7.0)

Contract between the modules for the edge-node feature. Read docs/STANDALONE.md
first; its rules (zero npm deps, Node 18+, FCC_DRY_RUN must boot and be fully
clickable, no command runner, one owner per file) all still apply.

## Problem

Today the main server is the only front door. `cloudflared` runs as a child of
the panel on main and every tunnel route points at `127.0.0.1` there, so when
main goes down **every** tunnelled website goes down — including websites
hosted on agent servers.

## What Phase 1 adds

Any agent server can be marked an **edge node**. An edge node runs:

1. **The nginx front door** — the same `fcc-<siteId>.conf` files main has,
   rendered for that server (upstream addresses as seen *from the edge*).
2. **A replica of every Cloudflare Tunnel connector** the panel runs
   (same tunnel token). Cloudflare spreads traffic across replicas and stops
   sending to a dead one within seconds — that is the failover.
3. **Port shims** on `127.0.0.1:<panelPort>` (and the phpMyAdmin port when it
   is published through a tunnel) that proxy to main, because the tunnel routes
   for the panel/phpMyAdmin point at `127.0.0.1:<port>` and Cloudflare will send
   some of those requests to the edge's replica.

Main is always an edge (unchanged behaviour). When main dies, the edges keep
serving with the last configuration they received; nginx's passive checks
(`max_fails=3 fail_timeout=10s`) take main's upstream entries out on their own.
Sites that run **only** on main still go down with main (documented — load
balance them). Panel failover is Phase 2; MySQL replication is Phase 3.

Out of scope for Phase 1: direct (non-tunnel) DNS domains still point at main;
Let's Encrypt certificates stay on main.

## Data

```
servers[].edge = { enabled: boolean }               // agent servers only; main is implicitly an edge
servers[].edgeSync = { hash, appliedAt, error }     // last cluster.sync result the panel received (persisted)
```

In memory on the panel (cluster.mjs): `edgeStatus` per server from `/agent/metrics`.

## Task: `cluster.sync` (shared/tasks.mjs — AGENT-SIDE owner)

Sent by the panel to **every** agent server (edge or not) whenever its payload
hash changes, when it comes online, and at least every 10 min as a reconcile.
Never run on main (main does the equivalent in-process).

```js
payload = {
  hash: "sha256 hex of the rest of the payload, computed by the panel",
  allowFrom: ["10.0.0.5", "203.0.113.7"],   // edge peer IPs that must reach this server's site ports
  edge: null | {                            // null => not an edge: remove all edge state from this server
    files: { "fcc-00-common.conf": "…", "fcc-00-realip.conf": "…", "fcc-site_ab12.conf": "…", … },
    connectors: [{ id: "cfc_…", name: "Cloudflare Tunnel", token: "<connector token>" }],
    shims: [{ name: "panel", listenPort: 4000, listenTls: false, target: "http://203.0.113.10:4000" }],
  },
}
result = { hash, appliedAt, nginx: true|false, error: null|string, connectors: [...], shims: [...] }
```

Agent behaviour, in this order:

1. **Firewall**: if `ufw` is active, `ufw allow from <ip> to any port 3000:3999 proto tcp comment "fcc sites from edge"`
   for each `allowFrom` IP; delete rules with that comment for IPs no longer listed.
   Skipped when `FCC_SKIP_UFW=1` is in the agent's environment.
2. **nginx** (edge != null): write `edge.files` into `/etc/nginx/conf.d` as one
   set, plus `fcc-00-edge-default.conf` (default_server on :80 and :443 that
   drops unknown hosts — `return 444;` / `ssl_reject_handshake on;` for nginx ≥ 1.19.4,
   else the self-signed cert) and one `fcc-edge-shim-<listenPort>.conf` per shim.
   Remove any `fcc-*.conf` it manages that is not in the set — **never** touch
   `fcc-app-*.conf` (local static/php vhosts). `nginx -t`; on failure restore
   every previous file and report the error (connectors keep running on the old,
   still-valid config). Then reload.
   TLS: site files reference `/etc/fcc-node/edge-tls/edge.crt` and `edge.key` (the
   panel renders those paths). The agent generates a self-signed pair with
   `openssl` once (10 years, CN=fcc-edge) if missing. The tunnel routes already
   use `noTLSVerify`.
   Shims: `listen 127.0.0.1:<listenPort>` (`ssl` with the self-signed pair when
   `listenTls`), `proxy_pass <target>` (`proxy_ssl_verify off` for https),
   SSE-safe (`proxy_buffering off; proxy_read_timeout 1h;`), websocket upgrade,
   `X-Forwarded-For/-Proto/-Host` and pass `CF-Connecting-IP` through.
3. **Connectors** (edge != null and nginx has been applied successfully at least
   once on this server): cloudflared binary at `/var/lib/fcc-node/bin/cloudflared`
   (download `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-<amd64|arm64|arm>` if missing).
   One systemd unit per connector, `fcc-cloudflared-<id>.service`,
   `EnvironmentFile=/etc/fcc-node/cloudflared/<id>.env` (mode 600, `TUNNEL_TOKEN=…` — never in argv),
   `ExecStart=<bin> --no-autoupdate --metrics 127.0.0.1:<port> tunnel run`,
   `Restart=always`. Metrics ports from 20241 upward, stable per connector id.
   These units are independent of fcc-node so the tunnel survives the agent
   (and the panel) being down. Units for connectors no longer listed are stopped,
   disabled and removed. Token unchanged → no restart.
4. **edge == null**: stop/remove all `fcc-cloudflared-*` units and env files,
   remove the edge-managed nginx files (not `fcc-app-*`), reload nginx.
5. Persist `{ hash, appliedAt, error }` in `<dataDir>/edge-state.json`.

FCC_DRY_RUN: log what would happen, write nginx files to the dry-run dir, never
spawn systemctl/ufw/cloudflared, report connectors as simulated active.

Edge status (node/node-agent.mjs): every `/agent/metrics` push gains
```js
edge: null | { hash, appliedAt, error, nginx: bool,
               connectors: [{ id, active: bool, readyConnections: number }],   // GET http://127.0.0.1:<metricsPort>/ready
               shims: [{ name, listenPort, ok: bool, error }] }                // GET the shim's listen port, any HTTP status = ok
```

Edge access logs (node/node-agent.mjs): every 15 s the agent tails
`/var/log/nginx/fcc-<siteId>.access.log` for each site file it manages and posts
`POST /agent/edge/logs { sites: { "<siteId>": ["line", …] } }` (≤ 2 MB per post,
start at end of file on first sight, handle rotation). The panel feeds those
lines into the same request counters and analytics as main's own logs.

Main's local static/php vhosts (shared/tasks.mjs): `renderSiteVhost(spec, { isMain, allowFrom })`.
When `isMain` and `allowFrom` is non-empty the vhost listens on all interfaces
with `allow 127.0.0.1; allow ::1; allow <ip>; … deny all;`; otherwise unchanged
(`127.0.0.1:` only). `executeTask` opts gain `edgeAllow: string[]`, passed to
`writeSiteVhost`. New export `refreshLocalVhosts(specs, opts)` rewrites the vhost
of each static/php spec whose vhost file already exists (it never starts a
stopped site).

`TASKS_VERSION` → `3.1.0`, `AGENT_VERSION` → `3.1.0`; `cluster.sync` added to
`TASK_TYPES` with a 10 min timeout.

## Panel (PANEL-SIDE owner: cluster.mjs, loadbalancer.mjs, cloudflare.mjs, auth.mjs, sites.mjs export only, server.mjs version)

- **loadbalancer.mjs** — `render(site, { forServer })`. When `forServer` is an
  edge (not main): upstream address of target T is `127.0.0.1` when T is that
  edge, else `T.privateHost || T.host` (for main too — never 127.0.0.1);
  SSL server blocks use the edge-tls paths above; everything else identical.
  New `ctx.lb.edgeFiles(serverId)` → `{ "fcc-00-common.conf": …, "fcc-00-realip.conf": …, "fcc-<id>.conf": … }`.
  After every successful `applyAll` / `syncSite` / `removeSite` and every health
  change that re-renders a file, call `ctx.cluster.edgesChanged?.()`.
- **cloudflare.mjs** — `ctx.cloudflare.edgeConnectors()` → `[{ id, name, token, cfId }]`
  for connectors with a token and `autoStart !== false`. Call
  `ctx.cluster.edgesChanged?.()` after add / update / delete of a connector.
  `status().connectors[]` gains `replicas: [{ serverId, serverName, running, connections }]`
  (main from the local Connector, edges from `ctx.cluster.edgeReplicas(connectorId)`).
  Shims for the panel and (when published) phpMyAdmin come from
  `ctx.cloudflare.edgeShims()` → `[{ name, port, tls }]`.
- **cluster.mjs** — owns `edge` on server records (POST/PATCH `/api/servers` accept
  `edge: boolean`, main rejects it), builds each agent's `cluster.sync` payload
  (hash = sha256 of JSON without `hash`), pushes it debounced (2 s) via
  `runTask` on `edgesChanged()`, on servers-changed, when an agent says hello,
  and on a 60 s reconcile tick (push when `edgeSync.hash` differs; every 10 min
  regardless). Agents whose `agentVersion` is below 3.1.0 are skipped (they
  self-update on hello). Shim targets: `http(s)://<main privateHost||host>:<port>`.
  `allowFrom` = resolved IPs (`host` and `privateHost`) of every *enabled* edge
  other than the receiving server, plus main's IPs.
  On main: when the edge set changes, call `refreshLocalVhosts` with specs from
  `ctx.sites.specFor` for main-hosted static/php sites, pass `edgeAllow` in
  `runTask` to main, and if `ufw` is active on main allow 3000:3999 from edge
  IPs (same comment convention; remove stale ones).
  Ingest `edge` from `/agent/metrics`; `POST /agent/edge/logs`; refactor
  `tailAccessLogs` so lines from an edge map `127.0.0.1` upstreams to *that*
  edge's serverId. Tell auth the edge IPs (`setTrustedProxies`).
  New API: `ctx.cluster.edgesChanged()`, `ctx.cluster.edgeReplicas(connectorId)`,
  `ctx.cluster.edgeIps()`.
- **auth.mjs** — `export function setTrustedProxies(ips)`; `trusted(req)` is also
  true when the socket address is in that set (edges' shims forward the
  visitor's headers to the panel).

### HTTP API (consumed by the UI)

```
GET  /api/servers            items[] gain:
       edge: { enabled }                    (main: { enabled: true, implicit: true })
       edgeStatus: null | { inSync, hash, appliedHash, appliedAt, error, nginx,
                            connectors: [{ id, name, active, readyConnections }],
                            shims: [{ name, listenPort, ok, error }], reportedAt }
POST /api/servers            body.edge?: boolean
PATCH /api/servers/:id       body.edge?: boolean   (400 for main)
POST /api/servers/:id/edge/sync   → job: push cluster.sync to that server now
GET  /api/cluster/ha         → { edges: [{ serverId, name, online, inSync, tunnelConnected }],
                                 tunnelReplicasOnline: n,   // servers (incl. main) with ≥1 connected connector
                                 connectors: n,             // connectors the panel runs
                                 mainOnlySites: [{ id, name }],  // sites whose only target is main
                                 warnings: ["…"] }         // e.g. "The Cloudflare Tunnel runs only on the main server."
GET  /api/cloudflare/status  connectors[].replicas (above)
```

## UI (UI owner: panel/public/assets/views/servers.js, cloudflare.js, dashboard.js, mock.js, app.css)

- Add/edit server: **Edge node** checkbox — "Runs the website front door and a
  Cloudflare Tunnel replica, so websites stay up if the main server goes down."
- Server list: an "Edge" badge; server detail: edge status (in sync / applying /
  error, connectors with ready connections, shims), a **Sync now** button.
- Cloudflare view: per connector, the replicas list; a warning when only main runs it.
- Dashboard: an availability card from `/api/cluster/ha` (warnings, main-only sites).
- mock.js: mock data for all of the above.

## Changes

- 3.7.0 — edge nodes (this document).

---

# Phase 2: Panel failover (v3.8.0)

## Goal

When the server running the panel goes down, another **panel node** takes over
within ~30–40 s: admins can sign in (same sessions — cookies are HMAC-signed
with the replicated `sessionSecret`), agents keep receiving work, and the
tunnel address of the panel keeps answering. Never two active panels at once.

## Vocabulary

- **Panel node** — a server that runs the panel process (`fcc.service`). Main
  is always one. An agent server can be made one when it is an edge
  (`servers[].panel = { enabled: true }`, requires `edge.enabled`).
- **Leader** — the one panel node that is active: runs every module, owns the
  database, dispatches tasks. **Followers** are the other panel nodes.
- **Voter** — every *enabled* server (main and every agent), one vote each.
  Agent servers vote through `fcc-node`; main votes from its panel process
  (main has no `fcc-node`).
- **N** — number of enabled servers (from the replicated db). **Majority** =
  `floor(N/2) + 1`. Panel nodes can only be added when `N >= 3`.
- **HA on** — `config.ha.enabled === true`, set when the first agent panel node
  is added, cleared when the last one is removed. With HA off nothing in this
  phase changes behaviour: main is the leader, no leases, no fencing.

## Local identity (never replicated)

`<dataDir>/ha-local.json` (mode 600) on every panel node:
```js
{ serverId: "main" | "srv_…",          // which server this process runs on
  token: "<agent token of this server>", // authenticates this node to other panel nodes; main gets one when HA is turned on
  directUrl: "http://10.0.0.5:4000",   // how other servers reach THIS panel process (FCC_HA_DIRECT_URL overrides; dev uses it)
  voter: { term, votedFor, grantedAt } } // main only: its own vote state (see Voting)
```
Missing file ⇒ `{ serverId: "main" }` (every pre-3.8 install). `servers[].panel.directUrl`
in the db mirrors each node's directUrl (the leader records what nodes report).

`ctx.ha` (panel/lib/ha.mjs, always present):
```js
ctx.ha = {
  enabled,                 // config.ha.enabled
  localServerId,           // ha-local.json serverId
  mainIsLocal,             // localServerId === "main"
  isLeader(),              // true in non-HA mode
  leaderId(), term(),
  status(),                // for /api/ha (below)
  panelNodes(),            // [{ serverId, name, directUrl, online, role, version, lagMs }]
  on(event, fn),           // "role" | "status"
  handover(serverId),      // planned switchover (leader only)
}
```

**Rule for every module:** "main" stops meaning "this machine". Use
`ctx.ha.mainIsLocal` for anything that touches the local machine on main's
behalf (local nginx front door files, certbot, in-process cloudflared, MySQL
socket, main's metrics/system info, nginx access-log tailing, local tasks).

## Boot and roles (panel/server.mjs + panel/lib/ha.mjs)

1. HA off ⇒ boot exactly as today (leader, all modules).
2. HA on ⇒ boot in **follower mode**: config + secrets + a read-only Store, the
   HTTP server with only `/ha/*` routes and the **follower proxy** (below), the
   replication client, the election client, and on main the embedded voter.
   No modules are registered or started.
3. **Promotion**: a follower that wins a majority lease (Election) reloads db.json
   and config.json from disk, then runs the normal `loadModules()` in-process
   and starts serving everything itself. Logged and broadcast as `ha` event.
4. **Demotion / fencing**: a leader that cannot confirm a majority for
   `LEASE_MS - MARGIN_MS` (12 s) flushes db.json and **exits with code 75**;
   systemd restarts it and it boots as a follower (2). It never keeps
   serving writes without a lease. Same on a planned handover.
5. On main with HA on, while main is a follower, the panel process also runs
   `node/node-agent.mjs` as a child process with
   `--config <dataDir>/ha-main-agent.json` (`{ panelUrl: <leader directUrl>, serverId: "main",
   token, dataDir: <dataDir>/agent, isMain: true }`), so the leader can still
   run tasks on main (sites on main, server backups, front door). Killed on promotion.

## Replication (leader → followers)

Authenticated with `Authorization: Bearer <node token>`; the leader accepts only
servers with `panel.enabled`. Leader state has a monotonic **version** (`{ term, seq }`
compared lexicographically) bumped whenever a tracked file changes (checked
every 1 s by stat + content hash).

```
GET /ha/state?have=<term>.<seq>&wait=25
  → 200 { leaderId, term, seq, codeDigest, files: { "<rel>": "<utf8 content>" } }  when newer than `have`
  → 204 after `wait` s with nothing new
POST /ha/ack { term, seq }              follower confirms it has written that version
GET /ha/releases                        → [{ name, size, sha256 }]  (dataDir/releases/*.zip)
GET /ha/file/releases/<name>            → stream (X-FCC-Sha256 header)
GET /ha/code                            → zip of the panel code (panel/, node/, shared/, scripts/, install.sh, README.md, docs/)
```
Tracked files (relative to dataDir): `db.json`, `config.json`, `cloudflare-ips.json`,
`cloudflared-home/cert.pem` (when present), `backups/schedule-state.json`,
`monitor/state.json`, `usage.json`; and, at most once a minute, `metrics.json`,
`analytics/all.json`. Not replicated: `logs/`, `backups/*.tar.gz|*.sql.gz` (use the
S3 destination — README says so), `tmp/`, `nginx/`, `run/`, `bin/`, `update-*`,
`phpmyadmin/`, `setup-code`, `recovery.json`, `ha-local.json`.

Follower writes every file atomically. `config.json` keeps the follower's own
`port`, `host` and `tls` (machine-specific). Releases are fetched by name when
missing or when sha256 differs. When `codeDigest` differs from the follower's
own code (same digest function as cluster's agentFiles, over the /ha/code file set),
the follower downloads `/ha/code`, unpacks it over `rootDir` (staging dir + rename,
like updates.mjs does), and exits 75 to restart on the new code.

`committed` = highest version acked by at least one follower (the leader keeps it
in memory and reports it to voters).

## Voting and leases (shared/ha-voter.mjs — used by node-agent and by main)

Constants: `HEARTBEAT_MS = 3000`, `LEASE_MS = 15000`, `MARGIN_MS = 3000`,
`FAILOVER_MS = 20000`. Durations use a monotonic clock
(`performance.now()`), never wall time.

Every voter, every `HEARTBEAT_MS`, POSTs to **every** panel node's directUrl (list
learned from `/agent/hello` and every `/ha/vote` reply; persisted in
`<dataDir>/panels.json` on agents):
```
POST /ha/vote   Authorization: Bearer <voter's server token>
  { voterId, term, votedFor, leaseLeftMs, knownCommitted: { term, seq },
    grant?: { candidate, term, nonce } }
  → { nodeId, role: "leader"|"follower"|"candidate", term, leaderId,
      committed?: { term, seq },                       // leader only
      request?: { candidate, term, nonce, version: { term, seq } },
      handoverTo?: serverId }                           // leader during a handover
```
`nonce` is the requesting node's monotonic timestamp when it built the reply.

Voter rules (persisted in `<dataDir>/vote.json` on agents, `ha-local.json voter` on main):
- Remember `knownCommitted` = the highest `committed` any leader reported.
- On a `request` from candidate C for term T with version V:
  grant iff `T >= term` AND `V >= knownCommitted` AND
  (`votedFor === C` OR the current lease has expired, i.e. no grant for
  `LEASE_MS`) AND (no `handoverTo` is pending, or C is the `handoverTo` target).
  Granting sets `term = T, votedFor = C, grantedAt = now` and immediately sends
  another `/ha/vote` to C carrying `grant { candidate: C, term: T, nonce }`.
- A voter that restarts treats its persisted lease as unexpired for a full
  `LEASE_MS` after boot (it cannot know how long it was down).
- Each voter heartbeats every node independently; an unreachable node never
  blocks the others.

Leader/candidate rules (panel/lib/ha.mjs):
- A grant counts until `nonce + LEASE_MS - MARGIN_MS` on the requester's own
  monotonic clock — so it always expires before the voter would grant anyone else.
- The leader puts a renewal `request` (current term) in every vote reply.
- **Leader**: while valid grants ≥ majority, it leads. When they drop below
  majority it fences (exit 75) as soon as it has had no majority for
  `LEASE_MS - MARGIN_MS`.
- **HA arming**: a leader that has never yet held a majority since HA was turned
  on (`config.ha.armed !== true`) does not fence; the first time it reaches
  majority it sets `armed = true` (replicated). The UI shows "Waiting for votes".
- **Follower → candidate**: when it has had no successful `/ha/state` from the
  leader for `FAILOVER_MS` *and* no voter reports a live lease for anyone else
  (from `leaseLeftMs`/`votedFor` in the votes it receives), it becomes a
  candidate with `term = max term seen + 1` and puts `request`s in its vote
  replies, with its replicated version. If it has no majority after 10 s it
  backs off a random 2–6 s and tries again with term + 1. Main (when a
  follower) waits 0 s extra; agent panel nodes add a random 0–3 s before their
  first candidacy so main wins ties.
- **Candidate → leader**: majority of valid grants for term T ⇒ promote.
- **No automatic failback**: a recovered old leader comes back as a follower.
- **Handover** (`POST /api/ha/handover { serverId }`, leader only, target must be
  a follower with `version == committed`): leader flushes, waits for the
  target's ack of the latest version, sets `handoverTo`, stops renewing, and
  fences itself right away; voters grant only to the target until the old
  leases expire, after which the target wins. ~15–20 s.

## Follower proxy (panel/server.mjs / ha.mjs)

A follower answers `/ha/*` itself and **forwards every other request**
(pages, `/api/*`, `/agent/*`, `/install/*`, SSE, uploads) to the leader's
directUrl as a streaming reverse proxy: original method, path, body, headers,
`Host` preserved, plus `X-Forwarded-For` (appended), `-Proto`, `-Host`,
`CF-Connecting-IP` passed through. No buffering, no timeouts on the response
stream (SSE). When there is no reachable leader it answers `503` with a small
HTML page "The panel is switching servers — this page retries in 5 s"
(auto-refresh) or JSON `{ error, haSwitching: true }` for `/api/*` / `/agent/*`.
The leader trusts proxy headers from panel-node and edge addresses
(`setTrustedProxies`).

## Agents (node/node-agent.mjs)

- Learn the panel nodes from `/agent/hello` (`panels: [{ serverId, directUrl }]`)
  and from `/ha/vote` replies; persist in `<dataDir>/panels.json`.
- Run the voter loop (shared/ha-voter.mjs) when the hello says `ha: true`.
- API calls go to the leader's directUrl when known (from votes), else the next
  panel node, else `cfg.panelUrl` — any of them works because followers proxy.
  On connection failure or a `503 haSwitching`, move to the next.
- `cfg.isMain === true` (main's embedded agent): `executeTask(..., { isMain: true })`.
- `AGENT_VERSION 3.2.0`. Panel nodes can only be enabled when every enabled
  agent reports ≥ 3.2.0 and is online (otherwise the majority could never form).

## Tasks (shared/tasks.mjs, shared/edge.mjs)

- `panel.install { codeUrl: "/ha/code", directUrl, port, host }` on an agent: downloads
  the code zip with the agent token, unpacks to `/opt/fcc` (staging + rename),
  writes `/var/lib/fcc/ha-local.json` (`serverId`, `token` from the agent config,
  `directUrl`), writes `/etc/systemd/system/fcc.service` (same unit as install.sh
  makes, `Restart=always`, `SuccessExitStatus=` not set so exit 75 restarts), with
  `FCC_DATA_DIR=/var/lib/fcc`, `FCC_PORT`, `FCC_HOST`; enables + starts it. If ufw is
  active, allows the panel port from every server IP in `allowFrom`.
  Result `{ installed: true, version }`. Dry run: logs, writes nothing outside dataDir.
- `panel.remove {}`: stops, disables, removes the unit and `/opt/fcc`; keeps
  `/var/lib/fcc` (renamed to `/var/lib/fcc.removed-<date>`, it holds secrets — the
  result says so).
- `cluster.sync` gains `frontDoor: true` (sent only to main, only while main is
  not the leader): `edge.files` are then main-style files (Let's Encrypt cert
  paths) written over main's own `fcc-<siteId>.conf` set; no default file, no
  shims, no connectors; access logs of those files are shipped like an edge's.
- Shims on non-panel edges: `target` may now be a list —
  `shims[].targets: ["http://10.0.0.5:4000", "http://10.0.0.1:4000"]` rendered as an
  nginx `upstream` (passive failover, `max_fails=1 fail_timeout=5s`) of every panel
  node's directUrl. Panel nodes get no panel shim (the panel listens there itself).
- `TASKS_VERSION 3.2.0`; `panel.install` (15 min), `panel.remove` (5 min) in TASK_TYPES.

## Panel modules when the leader is not on main

- **cluster.mjs**: `runTask` runs in-process only when `serverId === "main" && mainIsLocal`.
  `isOnline("main")`/`address("main")`/`ensureMain()`/`sampleMain()`/`tailAccessLogs()`
  only treat main as local when `mainIsLocal`; otherwise main is a remote server
  reached through its embedded agent. Owns `servers[].panel`, enabling/disabling
  panel nodes (validation: edge, N ≥ 3, agents ≥ 3.2.0 online), running
  `panel.install`/`panel.remove`, setting `config.ha.enabled`, generating main's
  token (hash in `servers.main.tokenHash`, plaintext only in main's ha-local.json),
  pushing `frontDoor` cluster.sync to main while main is not local, the shim
  target lists, `hello` gaining `{ ha, panels }`.
- **loadbalancer.mjs**: local nginx writes, certbot and `nginx -V` only when
  `mainIsLocal`. Otherwise `applyAll/syncSite/removeSite` just trigger
  `edgesChanged()` (main's files go out as `frontDoor` sync); issuing/deleting a
  certificate throws 409 "Certificates can only be changed while the main server
  runs the active panel."
- **cloudflare.mjs**: in-process connectors only when `mainIsLocal` (an agent leader
  is an edge — its systemd replicas already run). API features work everywhere.
- **mysql.mjs, backups.mjs (database backups), phpmyadmin.mjs**: when not
  `mainIsLocal`, operations throw 503 "Databases live on the main server, which is
  not running the active panel right now." and schedulers skip with a log line;
  status endpoints report `{ available: false, reason }`. (Phase 3 lifts this.)
- **updates.mjs**: unchanged on the leader; followers follow `codeDigest`.

## HTTP API (UI)

```
GET  /api/ha → { enabled, armed, leaderId, term, localServerId, majority, voters: N,
                 votes: [{ serverId, name, votedFor, leaseLeftMs, reachable }],
                 nodes: [{ serverId, name, role, directUrl, online, version, lagMs, codeInSync }],
                 committed, warnings: ["…"], canEnable: { ok, reason } }
POST /api/servers/:id/panel { enabled: boolean }   → job (panel.install / panel.remove)
POST /api/ha/handover { serverId }                 → { ok } (UI then waits for the switch)
SSE  "ha" event on role/leader/vote changes
```
`servers[]` gain `panel: { enabled, directUrl } | null` and `panelRole`.

## UI

- Server card/menu: **Panel node** toggle (disabled with the reason from
  `canEnable` when not possible), role badge (Active panel / Standby).
- Servers page header: an HA strip — "Active panel: <name> · 2 standbys · votes 4/5".
  Standby rows: replication lag, code in sync, **Make active panel** (confirm
  dialog: "The panel is unavailable for about 20 seconds while it switches").
- Dashboard availability card: active panel and standby count; warnings.
- A thin banner in the app shell when `/api/ha` reports the panel just switched
  servers or when `armed` is false while enabled ("Waiting for the servers to
  vote…").
- Databases pages: when `/api/mysql` (or equivalent) returns `available: false`,
  show the reason instead of errors.

## Changes

- 3.8.0 — panel failover (this section).
