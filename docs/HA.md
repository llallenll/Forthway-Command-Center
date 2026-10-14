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

Constants (v3.8–3.9): `HEARTBEAT_MS = 3000`, `LEASE_MS = 15000`, `MARGIN_MS = 3000`,
`FAILOVER_MS = 20000`. **Since 3.10 every duration is derived from
`config.ha.failoverSeconds`** — see "Failover speed" below; at the default (15 s):
heartbeat 1 s, lease 6.8 s, margin 1.4 s, standby silence 5.8 s. Durations use a
monotonic clock (`performance.now()`), never wall time.

Every voter, every `HEARTBEAT_MS`, POSTs to **every** panel node's directUrl (list
learned from `/agent/hello` and every `/ha/vote` reply; persisted in
`<dataDir>/panels.json` on agents):
```
POST /ha/vote   Authorization: Bearer <voter's server token>
  { voterId, term, votedFor, leaseLeftMs, knownCommitted: { term, seq },
    leaseMs, heartbeatMs, proto: 2,                     // 3.10: its current lease length / heartbeat
    grant?: { candidate, term, nonce, leaseMs } }       // 3.10: the lease this grant is for
  → { nodeId, role: "leader"|"follower"|"candidate", term, leaderId, proto: 2,
      committed?: { term, seq },                       // leader only
      timings?: { failoverSeconds, heartbeatMs, leaseMs }, // leader only (3.10)
      request?: { candidate, term, nonce, leaseMs, version: { term, seq } }, // leaseMs: 3.10
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
- **updates.mjs**: with standby panel nodes an update is a coordinated rolling
  update (see "Panel updates in a cluster" below); followers follow `codeDigest`
  otherwise.

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

---

# Phase 3: Database replication, cluster alerts, server dialog (v3.9.0)

## Goal

Databases keep working when main goes down: a MySQL/MariaDB **replica** on
another server takes over as **primary**, websites follow without a restart,
and the panel manages databases from whichever panel node is active. Admins
get an SMS / Discord alert when the panel or the database fails over.

## Data (replicated config.json)

```js
config.mysqlHa = {
  enabled: false,
  mode: "auto" | "manual",            // auto = promote after DETECT_MS of the primary being unreachable
  flavor: "mysql" | "mariadb",        // of the primary; the replica installs the same
  primary: "main" | "srv_…",          // the only writable server
  replica: "srv_…" | null,            // one replica in this version
  state: "off" | "preparing" | "seeding" | "replicating" | "broken" | "promoted" | "needs-rebuild",
  replUserEnc, replPasswordEnc,       // fcc_repl — replication + seeding (encrypted with ctx.secrets)
  adminPasswordEnc,                   // fcc_admin — the panel's remote root-equivalent user
  needsRebuild: ["srv_…"],            // old primaries fenced read-only, waiting to become the replica
  serverIds: { main: 1, "srv_…": 2 }, // MySQL server_id per server (stable, unique)
  history: [{ at, event, detail }],   // last 50: enabled, seeded, promoted, switchover, rebuilt, broken, fenced
}
```
Constants: `DETECT_MS = 60000` (3.10: derived from `config.ha.failoverSeconds`, 5 s at the
default — see "Failover speed"), `REPL_ALIAS = "fcc-mysql.internal"`, users `fcc_repl`, `fcc_admin`.

## Database address

When replication is enabled, every linked website's `DB_HOST` becomes
`fcc-mysql.internal` (one-time env update jobs, like a password rotation).
Every server gets an `/etc/hosts` managed block mapping the alias to the current
primary — `127.0.0.1` on the primary itself, else the primary's
`privateHost || host`. Failover only rewrites that block: no env change, no app
restart (clients reconnect and resolve again; Node / PHP read /etc/hosts per lookup).
Database users are granted from `localhost`, `127.0.0.1` and every server's
addresses (existing `grantHosts` logic, extended with main's and the replica's).

`cluster.sync` payload gains `hosts: { "fcc-mysql.internal": "<ip>" } | null`
(null removes the block). Main applies the same block in-process (or through
its embedded agent while it is a standby).

## Tasks (shared/mysql-ha.mjs — AGENT-SIDE; run on agents and in-process on main)

All SQL through the `mysql` CLI with stdin scripts and `MYSQL_PWD` env (never argv),
socket root locally. Under FCC_DRY_RUN: log, simulate, write nothing outside dataDir.
`TASKS_VERSION 3.3.2`, `AGENT_VERSION 3.3.2` (3.3.0 in v3.9.0, 3.3.1 in v3.9.1).

- `mysql.primary.prepare { serverId, replUser, replPassword, adminPassword, replicaIps, adminIps, allowFrom }`
  Ensures binlog (ROW), `server_id`, GTID (MySQL: `gtid_mode=ON`,
  `enforce_gtid_consistency=ON`; MariaDB: native GTID), `bind-address=0.0.0.0`
  via a managed file (`/etc/mysql/mysql.conf.d/zzz-fcc-replication.cnf` or
  `/etc/mysql/mariadb.conf.d/99-zz-fcc-replication.cnf` — named to load after the installer's file); restarts MySQL only if a
  setting changed. Creates/updates `fcc_repl@<each replica ip>` (REPLICATION SLAVE,
  REPLICATION CLIENT, SELECT, RELOAD, SHOW VIEW, EVENT, TRIGGER, LOCK TABLES, PROCESS)
  and `fcc_admin@<each admin ip>` (ALL WITH GRANT OPTION). ufw (if active): 3306 from `allowFrom`.
  → `{ flavor, version, restarted, gtid: true }`
- `mysql.replica.setup { flavor, serverId, primaryHost, primaryPort, replUser, replPassword, adminPassword, adminIps, allowFrom }`
  Installs the same flavor if missing (apt), writes the managed cnf (server_id,
  binlog + `log_replica_updates`/`log_slave_updates`, GTID, `read_only=ON`,
  `replicate-wild-ignore-table=mysql.%`, relay log, bind 0.0.0.0), restarts,
  creates `fcc_admin` locally (with `sql_log_bin=0`), seeds every non-system
  database from the primary (`mysqldump -h … --single-transaction --routines --events --triggers`
  + GTID position: MySQL `--set-gtid-purged=ON` after `RESET MASTER`/`RESET BINARY LOGS AND GTIDS`;
  MariaDB `--gtid --master-data` + `gtid_slave_pos`), then starts replication with
  auto-position (MySQL `CHANGE REPLICATION SOURCE TO … SOURCE_AUTO_POSITION=1, GET_SOURCE_PUBLIC_KEY=1`
  or `CHANGE MASTER TO … MASTER_AUTO_POSITION=1` on < 8.0.23; MariaDB `MASTER_USE_GTID=slave_pos`).
  → `{ flavor, version, seededAt, databases, gtidExecuted }`
- `mysql.status {}` → `{ installed, flavor, version, readOnly, role: "primary"|"replica"|"standalone",
   replica: { ioRunning, sqlRunning, lagSeconds, lastError, sourceHost, retrievedGtid, executedGtid } | null }`
   (also pushed every metrics tick by node-agent as `mysql` when MySQL is installed).
- `mysql.replica.promote { waitMs = 30000 }` — stop the IO thread, wait until the
  SQL thread has applied everything received (bounded by waitMs), `RESET REPLICA ALL`,
  `read_only=OFF` (runtime + cnf). → `{ promoted: true, executedGtid, appliedAll: bool }`
- `mysql.readonly { on }` — fence/unfence (runtime + cnf). Idempotent, fast (≤ 5 s).
- `mysql.users.sync { users: [{ user, password, hosts, databases }], remove: [{ user, host }] }`
  `CREATE USER IF NOT EXISTS / ALTER USER … IDENTIFIED BY / GRANT ALL ON db.*`,
  with `SET sql_log_bin=0` when the server is a replica (no errant GTIDs).
- `mysql.rebuild { …mysql.replica.setup payload }` — `mysqldump` every non-system
  database to `/var/backups/fcc-mysql-before-rebuild-<stamp>.sql.gz` (mode 600),
  drop them, then exactly `mysql.replica.setup`. → `{ safetyDump: path, …setup result }`
- `panel.install` also installs the MySQL client of the cluster's flavor (for remote admin/dumps).

## Panel (panel/lib/mysql-ha.mjs — new; mysql.mjs, backups.mjs changes)

- **Remote admin**: when the primary is not this machine, mysql.mjs connects to
  `REPL_ALIAS`/primary address over TCP as `fcc_admin` (password from config,
  `MYSQL_PWD`). So databases, imports, rotations and database backups work from any
  active panel; the Phase 2 `DB_REMOTE` 503s apply only when replication is off.
  phpMyAdmin and certificates stay main-only.
- **Enable** (`POST /api/mysql/replication { replicaServerId, mode }`, job): checks
  (replica is an online agent ≥ 3.3.0, not the primary, enough disk), generates users,
  prepare primary → setup replica → users.sync on the replica → hosts alias everywhere →
  DB_HOST env update jobs → state `replicating`.
- **Monitor** (every 10 s on the leader): from metrics / `mysql.status`. `broken`
  when the SQL or IO thread has been stopped with an error for 2 min (alert once).
- **Automatic failover** (`mode: "auto"`): the primary counts as down when, for
  `DETECT_MS` continuously, (a) the primary server is offline to the panel
  (agent/votes), (b) the leader cannot open a TCP connection to primary:3306, and
  (c) the replica reports its IO thread not connected. (3.10 replaces the detection with a
  fast probe loop and adds the immediate cut-over — see "Fast database failover".) Then: `mysql.replica.promote`
  on the replica → `primary = replica`, `replica = null`, old primary into
  `needsRebuild`, state `promoted` → hosts alias everywhere → users.sync on the new
  primary → alert. Never promotes a replica whose last status showed `lastError` with
  a stopped SQL thread (it may be missing data) unless done manually with `force`.
  `mode: "manual"`: same detection, but only alerts; `POST /api/mysql/replication/promote { force? }`.
- **Fencing**: (1) `ctx.ha.beforeFence(fn)` (ha.mjs hook, ≤ 3 s): when main fences
  and main is the primary, set local MySQL `read_only=ON`. The leader turns it back
  OFF when main is still the primary and leads/ is reachable again. (2) Any server in
  `needsRebuild` or any non-primary server that reports `readOnly: false` gets
  `mysql.readonly { on: true }` at once. (3) Main's panel at boot (follower or leader)
  sets its local MySQL read-only when config says another server is primary; as a
  standby it re-checks every replicated config.json (main's own copy is stale after
  a failover it missed), so it fences within seconds of rejoining.
- **Rebuild** (`POST /api/mysql/replication/rebuild { serverId }`, job; automatic
  in auto mode when a needs-rebuild server comes back online and no replica exists):
  `mysql.rebuild` on it → it becomes `replica`.
- **Switchover** (`POST /api/mysql/replication/switchover`, job; needs a healthy
  replica with lag 0): primary `read_only=ON` → wait for the replica to execute the
  primary's GTID set → promote → old primary re-pointed as replica (`CHANGE … SOURCE_AUTO_POSITION`
  via `mysql.replica.setup` with `seed: false`) → alias. No data loss, ~10 s of read-only.
- **Disable** (`DELETE /api/mysql/replication`, job): stop replication on the replica,
  keep its data, keep the alias pointing at the primary.
- `GET /api/mysql/replication` → `{ enabled, mode, state, flavor, primary: { serverId, name, address, readOnly },
  replica: { serverId, name, state, lagSeconds, ioRunning, sqlRunning, lastError, seededAt } | null,
  needsRebuild: [{ serverId, name, online }], history, canEnable: { ok, reason },
  candidates: [{ serverId, name, panelNode, recommended }], detect: { primaryDownForMs } | null }`
- SSE event `mysql-ha` on every state change.

## Cluster alerts (panel/lib/cluster-alerts.mjs — new module, listed after "monitor")

Uses the uptime alert channels from monitor.mjs: every enabled Discord webhook and
the **default** SMS recipients (not per-site ones), DRY_RUN simulated, never throws,
same secret hygiene. monitor.mjs exports `ctx.monitor.clusterAlert({ kind, title, text, color })`.
Settings: `config.notifications.cluster = { enabled: true, sms: true, discord: true }`,
`GET/PATCH /api/notifications/cluster`. Events (each logged in Activity):

| kind | when | sent by |
|---|---|---|
| `panel.failover` | a panel node promoted and the previous leader was lost (not a handover) — "Main went down. The panel is now running on <name>." | the new leader, once its modules started |
| `panel.handover` | planned handover finished (Discord only) | the new leader |
| `panel.recovered` | the previous leader's server is back online as a standby — "use Make active panel to move it back" | the leader |
| `db.failover` | the database replica was promoted | the leader |
| `db.broken` | replication stopped with an error for 2 min | the leader |
| `db.rebuilt` | a server became the replica again | the leader |

ha.mjs exposes `ctx.ha.on("promoted", ({ term, previousLeaderId, reason: "failover"|"handover" }))`
and remembers the previous leader across the promotion so the alert can name it.

## Server dialog (UI)

The edit/add server dialog replaces its row of switches with three menus:
- **Role**: Website host · Edge node · Edge + panel node (options disabled with the reason when
  not allowed; picking a panel role explains that saving installs the panel).
- **Load balancing**: In the pool · Not in the pool.
- **Status** (edit only, not main): Enabled · Disabled.
Main shows Role as "Main (front door, panel)" read-only.

## Panel updates in a cluster (coordinated rolling update)

### Why

Before this, Settings → Updates swapped the code on the leader only and
restarted it (SIGTERM, `Restart=always`). The restarted process booted as a
standby with a fresh `FAILOVER_MS` clock, while the real standby's clock had
started when the leader went quiet, so the standby won the election
(~20–25 s after the exit, although the restart took ~5 s). The updated
node then followed the new leader's `codeDigest` — the old code — downloaded
it and restarted on it: the panel moved, and the update was undone.

### Flow (leader, `panel.update` / `panel.restore` jobs)

1. Check, download, verify and back up once on the leader, as before.
2. Build the release tree: the leader's own code items after the swap (update
   items from the archive or backup, anything else copied from the running code)
   plus `version.json`. Its digest (same function as `codeDigest`) is the target.
   `ctx.ha.setCodeTarget({ updateId, digest, version, commit, dir })`.
3. Each standby panel node in turn (offline ones are skipped with a warning and
   catch up through `codeDigest` once the leader runs the new code; nodes that do
   not report `cap=rollout` are skipped the same way):
   `ctx.ha.releaseCodeTarget(id)` → its `/ha/state` replies now carry
   `codeTarget`; the leader answers its long poll at once. The standby downloads
   `GET /ha/update/<updateId>` (panel-node token; `X-FCC-Code-Digest`), checks the
   digest, `node --check`s `panel/server.mjs`, imports the boot-time modules in a
   child process, backs up its own code to `<dataDir>/update-backups/<id>` (same
   layout as updates.mjs, last 3 kept), swaps (code items the bundle lacks are
   removed), writes `version.json`, records `pendingUpdate` in ha-local.json and
   exits 75. The job waits (3 min per node) until the node polls again **from a
   new boot** (`boot=` poll parameter) with the target digest. A node that reports
   `failed` (it kept its code) or `rolled-back`, or does not come back in time,
   stops the update: the target is withdrawn, the leader keeps its old code and
   standbys that were already updated converge back to it through `codeDigest`.
4. The leader swaps itself, the job ends, and before exiting it calls
   `ctx.ha.prepareRestart(RESTART_WINDOW_MS = 60 s)`: `/ha/state` (body
   `restarting: { remainingMs }`, 204 header `X-FCC-Restarting-Ms`) and vote
   replies carry the window; each standby's poll is answered at once and the
   leader waits ≤ 4 s for every online standby to have heard it. It persists
   `local.version` (= its replicated version) and `restart: { untilWall }` in
   ha-local.json and exits.
5. Standbys inside the window do not stand for election. The restarted process
   finds `restart` in ha-local.json (local wall clock, same machine; capped at
   5 min) and stands **at once** (no `FAILOVER_MS` wait, no random delay) in
   term + 1. Voters still hold its lease (`votedFor` = it) or the lease has
   expired, so they grant; it promotes and keeps leading. Not a failover: no
   alert (cluster-alerts ignores a promotion whose previous leader is itself).
   If it is not back within the window, normal failover applies — the standbys
   already run the new code.

With HA off (no standby panel nodes) nothing here runs: the update is the
single-server path, unchanged.

### Safety

Unchanged Phase 2 properties: only a majority of voter leases makes a leader;
the window only stops followers from *asking*, it never makes a voter grant
anything it would not grant anyway. A graceful leader stop now writes its exact
replicated version to ha-local.json, so voters (`V >= knownCommitted`) accept it
again. A follower never moves to an older digest during an update: while
`codeTarget` is present it converges to it only; after a successful update the
leader's `codeDigest` is the target.

### Standby auto-rollback

`pendingUpdate.boots` is incremented on every boot of the new code; the first
successful `/ha/state` from a leader (from a process that did not do the swap)
clears it. After 3 boots without that, the next boot restores the backup taken
before the swap (synchronously, before the panel starts), adds the update to
`failedUpdates` (never retried) and exits 75; the leader hears `rolled-back`.
Limit: code that crashes before `createHa()` runs (e.g. an import error in a
module `node --check` and the import check do not reach) is not rolled back
automatically — the leader still stops the update after 3 minutes and keeps
its old code; reinstall that node from its backup (`update-backups/`) by hand.

### Wire additions

```
GET /ha/state?…&boot=<16 hex>&cap=rollout&upd=<updateId>|<state>|<msg>
  200 { …, codeTarget?: { digest, updateId, version, commit }, restarting?: { remainingMs } }
  204 + X-FCC-Restarting-Ms while the leader is restarting for an update
GET /ha/update/<updateId>   → zip of the release tree + version.json (X-FCC-Code-Digest, X-FCC-Version)
POST /ha/vote reply (leader)  restarting?: { remainingMs }   (informational)
ha-local.json  restart?: { untilWall, term, at }, pendingUpdate?: { updateId, digest, version, backupId, at, boots, swappedBy },
               updateReport?: { updateId, state: swapped|ok|failed|rolled-back, msg }, failedUpdates?: [updateId]
GET /api/updates   servers: null | [{ serverId, name, role: active|standby, local, online, version, sameCode, upToDate }]
```

UI (Settings → Updates): the panel servers with their versions; the button says
**Update all panel servers** when there are standbys; the job log has one line
per node.

### Testing panel updates (test hooks, inert unless `FCC_DRY_RUN=1`)

- `FCC_TEST_UPDATE_SOURCE=<dir|.tar.gz>` — updates.mjs takes the update from
  there instead of GitHub (its "commit" is a hash of the bytes).
- `FCC_TEST_REAL_CODE_SWAP=1` — updates.mjs and ha.mjs really replace the code
  of a code dir that is **not** a git checkout and restart (process exit; run the
  panel under a loop that restarts it, like `Restart=always`). Every other system
  call stays dry-run.

Run per-node code copies (not the git checkout): main (copy A, its data dir,
`FCC_HA_DIRECT_URL`), a standby started from the dry-run-installed
`<agent dataDir>/panel-dry-run/var-lib-fcc` with `FCC_NODE_CONFIG` pointing at
its agent config, and two dry-run node agents for votes.

## Changes

- 3.10.0 — failover speed and fast database failover: see the next part.
- 3.9.0 — database replication, cluster alerts, server dialog menus (this section).
- 3.9.1 — version preflight for `mysql.replica.setup` / `mysql.rebuild` (TASKS/AGENT 3.3.1).
  Before touching the replica the task reads the primary's version (handshake, then
  `SELECT VERSION(), @@version_comment` as `fcc_repl`) and requires the replica's
  release series (major.minor; patch levels never matter) to be the same or newer. If the
  distro's candidate is older it adds the vendor repository — Oracle's (`repo.mysql.com/apt`,
  key BCA4 3417 C3B4 85DD 128E C6D4 B7B3 B788 A8D3 785C, component = the primary's series,
  else the next LTS, else `mysql-innovation`; amd64 only) or MariaDB's (`dlm.mariadb.com`,
  key 177F 4010 FE56 CA33 3630 0305 F165 6F24 C74C D1D8, the primary's series) — with the
  key fingerprint checked, `signed-by=` and `/etc/apt/sources.list.d/fcc-mysql.list`; a
  codename the repository does not publish gets a plain "install it by hand" message. An
  older installed server is replaced only when it holds no databases (or only partial
  copies from an unfinished seed, recorded as `seeding` in mysql-ha.json); Ubuntu's MySQL →
  Oracle's keeps the old data directory at `/var/lib/mysql.fcc-before-upgrade-<stamp>` and
  lets Oracle's package initialise a fresh one (root on auth_socket). mysqldump's series is
  checked before the copy, so the 8.0-client-vs-8.4-server `SHOW MASTER STATUS` (1064)
  failure is reported in plain words. The panel needs agent ≥ 3.3.1 on the replica to
  enable or rebuild; a failed enable leaves replication off and can simply be retried.
- 3.10.0 — coordinated panel updates in a cluster ("Panel updates in a cluster" above): standbys first, one
  at a time, then the leader, which keeps the panel through a restart window.
- 3.9.2 — replica sync progress (TASKS/AGENT 3.3.2). Websites keep reading and writing on
  the primary throughout; the progress only shows when the replica has caught up.
  - **Task progress (generic)**: `executeTask(type, payload, { progress })` — tasks call
    `o.progress(obj[, { force }])`, throttled to 1/s (latest wins, a trailing/forced call is
    never dropped). node-agent sends the newest object with its next log flush:
    `POST /agent/tasks/:id/log { lines, progress? }`. cluster.mjs keeps it as `task.progress`
    and calls `runTask(…, { onProgress })` (in-process on main: passed straight to
    executeTask). Flat objects only (≤ 40 keys of string ≤ 200 / finite number / bool / null,
    ≤ 4 KB), anything else dropped; agents < 3.3.2 never send it.
  - **Copy** (`mysql.replica.setup` / `mysql.rebuild` seed): before dumping, the primary's
    `information_schema.tables` per database (`SUM(data_length)`, `index_length`, `table_rows`;
    MySQL with `information_schema_stats_expiry = 0`). Bytes through `mysqldump | mysql` are
    counted and mysqldump's `-- Current Database: \`name\`` comments found in the stream
    (`DumpScanner`, Buffer.indexOf + a 89-byte carry across chunks). `SeedEstimator`: estimate
    = data_length × 1.0 until ≥ 8 MB (or 10 %) of finished databases give the real
    dump-bytes-per-data-byte ratio, then that ratio (0.15–6) for the rest; a database past its
    estimate counts as nearly done. Rate: exponential smoothing, 10 s time constant; ETA null
    until 4 s and 256 KB. Percent ≤ 99 until mysql has exited 0, then a forced 100. Reports
    `{ phase: "copying", bytesDone, bytesEstimate, percent, rateBps, etaSeconds, database,
    databaseIndex, databasesDone, databasesTotal, startedAt }`. No sizes → percent null
    (indeterminate bar). Dry run: a simulated 2.4 GB copy over ~24 s, then ~14 s of catch-up
    (`FCC_MYSQL_DRY_SIM { seedBytes, seedSeconds, catchUpChanges, catchUpSeconds }`; the
    simulated GTID position default is now `…:1-48120`).
  - **Catch-up** (panel): after the seed task returns, every 2.5 s, fresh `mysql.status` of
    the primary (gtid_executed) then the replica (Executed_Gtid_Set / Gtid_Slave_Pos,
    Seconds_Behind_Source). `transactionsBehind = |primary − replica|` (`gtidDiffCount`:
    MySQL `uuid:1-5:7-9,uuid2:1-3` incl. 8.3+ tags, MariaDB `domain-server-seq` per domain).
    ETA from the gap's shrink rate over ≤ 30 s; percent from the largest gap seen.
    In sync = lag 0 and gap ≤ what the primary commits during one poll, twice in a row.
    The monitor also starts a catch-up bar (kind `lag`) when a running replica is ≥ 30 s behind.
  - **API**: `GET /api/mysql/replication` gains `progress: { kind: "enable"|"rebuild"|"lag",
    phase: "preparing"|"copying"|"catching-up"|"in-sync", …copy fields, transactionsBehind,
    lagSeconds, phaseStartedAt, syncedAt, updatedAt, replicaServerId, replicaName } | null`
    (in memory on the leader; "in-sync" stays 10 min, 1 min for `lag`). SSE `mysql-ha` for
    progress is throttled to one per 2 s. Job logs get a line every ~10 % and end with
    "In sync — the replica has every change." — the enable/rebuild job waits up to 30 s for it,
    else says the card carries on and appends the line when it happens.
  - **UI**: progress bar (`role=progressbar`, `aria-valuenow`, indeterminate without an
    estimate, reduced-motion safe) with Copy → Catch up → In sync steps and "Your websites
    keep working normally while this runs." in the Replication card (also while turning on,
    before `enabled`); compact bar on the Databases page line and the dashboard availability
    card. Mock: `?mock=1&mockrepl=syncing`.

---

# Failover speed and fast database failover (v3.10.0)

## Goal

"The automatic failover should happen within 15 seconds of the primary going down" —
for the database. Before 3.10, when main (panel leader + database primary) died, the
panel moved after ~20 s and the database monitor then needed 60 s of "primary offline"
(agent last-seen, 45 s) on top: ~80–100 s. Now one cluster-wide setting, **failover
speed**, sets the target, and the worst case fits it.

## Setting

`config.ha.failoverSeconds` (replicated): the target, in whole seconds, from "the
server running the panel and the database primary goes down" to "the replica is
promoted and every server is cut over". 10–300, default 15 (also for existing
installs: a missing value means 15).

```
GET   /api/ha/settings                       → { failoverSeconds, panelTakeoverSeconds, databaseFailoverSeconds,
                                                 heartbeatSeconds, blipToleranceSeconds, leaseSeconds, detectSeconds,
                                                 min: 10, max: 300, default: 15 }
GET   /api/ha/settings?failoverSeconds=N     → the same for N, `preview: true` (nothing saved; the UI while typing)
PATCH /api/ha/settings { failoverSeconds }   → the new summary (leader only; 400 outside 10–300 / not an integer)
GET   /api/ha                                → … + failover: <summary>
GET   /api/mysql/replication                 → … + failover: { …summary, detectMs }, detect.detectMs
```
Activity: `ha.failover-speed` `{ from, to }`. UI: a **Failover speed** box in the
Servers page HA strip (a number input, presets 10 / 15 / 30 / 60 / 120, Save, a live
one-line breakdown "Panel takes over in about 8.8 s, databases in about 12 s. Network
outages between servers shorter than about 3.4 s are ignored.", and below 15 s a warning
that short hiccups can trigger a failover and a private network helps); with panel
failover off the box stands alone on that page. Settings → Databases → Replication shows
a read-only summary and a link to it.

## Timing formula (shared/ha-timing.mjs — one pure function, used by ha.mjs, ha-voter.mjs, mysql-ha.mjs, cluster.mjs)

T = failoverSeconds × 1000.

| value | formula | meaning |
|---|---|---|
| heartbeat H | clamp(T/15, 1 s, 5 s) | voter → every panel node |
| lease L | 0.45 T (3–180 s) | a vote is a lease of L |
| margin M | max(1 s, L/5) | a leader's view of a grant ends M early |
| standby window F | L − H | a standby that heard nothing for F may stand (if no voter reports a live lease) |
| vote request timeout | min(2.5 s, 0.9 H) | always below H |
| standby long-poll | clamp(⌊F/2.5 s⌋, 1, 5) s | well under F |
| agent-node tie-break | 0…min(3 s, H/2) | main stands at once, agent panel nodes wait a random part of this |
| candidacy | max(10 s, L + 2H) | |
| beforeFence hooks | clamp(M − 250 ms, 0.75 s, 3 s) | all hooks together, inside the margin |
| DB: voter silent | 3H | condition (a) |
| DB: TCP probe | every max(0.5 s, H/2), timeout clamp(0.8H, 0.8 s, 3 s), 3 consecutive failures | condition (b) |
| DB: detect D | max(3 s, T/3) | no sign of life from the primary for D |

Estimates (worst case) shown in the UI: panel takeover = L + H + tie-break + 0.5 s;
database = max(panel takeover, D) + 2 probes + 0.7 s (replica check) + 1.5 s (promote +
push); outages ignored = min(L − M − 2H, D).

| failoverSeconds | H | L | M | F | D | panel | database | ignored |
|---|---|---|---|---|---|---|---|---|
| 10 | 1 s | 4.5 s | 1 s | 3.5 s | 3.3 s | 6.5 s | 9.7 s | 1.5 s |
| 15 | 1 s | 6.8 s | 1.4 s | 5.8 s | 5 s | 8.8 s | 12 s | 3.4 s |
| 30 | 2 s | 13.5 s | 2.7 s | 11.5 s | 10 s | 17 s | 21.2 s | 6.8 s |
| 60 | 4 s | 27 s | 5.4 s | 23 s | 20 s | 33.5 s | 39.7 s | 13.6 s |
| 120 | 5 s | 54 s | 10.8 s | 49 s | 40 s | 62 s | 69.2 s | 33.2 s |

60 s is roughly the pre-3.10 behaviour. `scripts/ha-timing.test.mjs` (`node --test scripts/`)
checks the invariants for every value 10–300 (request timeout < H, L − M ≥ 2H + 0.5 s,
long-poll + 1 s < F, fence hooks < M, D ≥ 3H, estimate ≤ T, monotonic) and the voter's
lease rules against a fake candidate.

## Distribution and safety while the value changes (vote protocol 2)

- The leader puts `timings { failoverSeconds, heartbeatMs, leaseMs }` in every vote reply,
  and `haTimings` in agent hello and poll replies (while HA is on).
- **Voters** (shared/ha-voter.mjs, agent 3.4.0, and main's embedded voter) heartbeat at the
  leader's `heartbeatMs` (applied to the very next beat). The **lease of a grant is the one
  the request names** (`request.leaseMs`, bounded to 3–180 s); a request without it (a
  3.8/3.9 leader) gets 15 s. Each grant echoes it (`grant.leaseMs`) and the voter keeps
  `leaseUntil = max(leaseUntil, now + lease)`: a renewal under a shorter lease never shortens
  one already given. It refuses any other candidate before `leaseUntil`. The length is saved
  with the vote before the grant is sent; after a restart the saved length (15 s for an older
  vote.json) is held in full.
- **Leaders/candidates** (ha.mjs) remember for every request they issue (nonce, L, M as of
  that moment) and count a grant until `nonce + min(grant.leaseMs ?? 15 s, L) − M`. Fencing,
  handover and status use that per-grant end.
- **Followers** derive their windows from the last replicated `config.json`
  (`followerFailoverSeconds`); a voter message counts as fresh for 2·max(our H, its H) + 2 s.

Why this can never produce two leaders, whatever the values and whenever they change:
the voter granted strictly after the nonce and keeps the vote until at least
grant time + grant.leaseMs > nonce + grant.leaseMs ≥ nonce + min(grant.leaseMs, L) =
the leader's end + M. Every grant carries its own numbers, so no node ever needs to know
another node's setting; changing failoverSeconds only changes the numbers in *new*
requests. Lowering it cannot shorten a lease already granted (the max rule), raising it
cannot make a leader count longer than the voter holds (the min rule). A pre-3.10 voter
ignores `leaseMs` and holds 15 s, and the leader counts min(15 s, L); a pre-3.10 leader sends
no `leaseMs`, a 3.10 voter holds 15 s and that leader counts 15 s − 3 s. The heartbeat and
the standby window only affect *when* someone asks — never whether a vote is granted twice.
Only liveness is affected by a change: after lowering the value, a failover in the next
old-lease period still waits for the old (longer) leases to run out.

## Fast database failover (panel/lib/mysql-ha.mjs)

A probe loop runs every 250 ms on the leader while replication is on (beside the 10 s
monitor, which keeps broken-replication detection, fencing, rebuild, users):
- **(a) liveness**: `ctx.ha.voterSeenMs(primary)` — every enabled server heartbeats every
  panel node, so even a standby that just took over knows when the primary's server last
  voted; silent after 3H. Without a voter (HA off) the agent's last request
  (`ctx.cluster.lastSeenMs`), silent after 35 s. The leader's own server never counts as silent.
- **(b) TCP**: only while (a) holds — connects to primary:3306 every max(0.5 s, H/2) while
  they fail, every 10 s while they succeed (each probe is an unauthenticated connect, which
  MySQL counts towards `max_connect_errors`); 3 consecutive failures.
- **Window**: the primary's last sign of life = max(its last vote / agent request, our last
  good connect). Nothing happens before it is D old.
- **(c) the replica confirms**, at most once a second, both at once and bounded (4 s): a fresh
  `mysql.status` with the IO thread not running, **or** `mysql.probe { host: primary, port,
  timeoutMs }` (new task, agent 3.4.0: one TCP connect from the replica, closed on the greeting)
  failing. The probe matters for a primary that vanished without a reset (power loss): the IO
  thread can take up to `replica_net_timeout` (60 s) to notice.
- Then (auto mode) the single-flight promotion job re-checks all three with a fresh replica
  status, skips fencing the old primary when it is silent (a task to a dead agent only waits),
  promotes (`mysql.replica.promote`), saves the new primary, and pushes the cluster.sync **at
  once** (`ctx.cluster.pushEdgesNow()`: no 2 s debounce) before refreshing statuses, syncing
  users and alerting (`db.failover`, unchanged). A replica whose SQL thread stopped with an
  error is still never promoted automatically: one history entry + alert, promote with force.
  Manual mode: the same detection, an alert with the seconds down.
- `GET /api/mysql/replication` `detect = { primaryDownForMs, detectMs, conditions: { a, b, c, quietMs, source } }`.

Agents (node-agent 3.4.0) abandon a parked `/agent/poll` as soon as the votes show a new
leader (a dead leader's poll would otherwise hang until its 40 s timeout after a power loss),
and wait for a new leader instead of a fixed back-off.

## Cut-over (`dbCutover`, shared/edge.mjs)

cluster.sync gains `dbCutover: { blockIps: [ip…], port } | null` (same for every server; main
applies it in-process, or through its frontDoor sync while it is a standby). `blockIps` =
the addresses of every server in `needsRebuild` (old primaries), minus any address of the
current primary or replica, never loopback; persisted as `config.mysqlHa.cutoverIps`.
Applied **first** in the task (with the hosts block), on every server:
1. refuse new connections with a TCP RST — `iptables`/`ip6tables -I OUTPUT 1 -p tcp -d <ip>
   --dport <port> -m comment --comment fcc-db-cutover -j REJECT --reject-with tcp-reset`
   (checked with `-C`, idempotent, re-checked every sync since a reboot drops it), else an
   nft table `inet fcc_db_cutover` (rewritten atomically with `nft -f -`);
2. kill existing connections to addresses newly blocked: `ss -K -t dst <ip> dport = :<port>`;
   when some survive (kernel without CONFIG_INET_DIAG_DESTROY) it says so in the task log.
State in `<dataDir>/db-cutover.json`; `edge-state.json` gets `dbCutover` and `hostsAppliedAt`.
All through sys.run with fixed argument lists (no shell), dry-run safe (logged only), inputs
validated (IP addresses, port 1–65535, ≤ 32 entries, never 0.0.0.0/::). Only OUTPUT is touched:
containers that reach MySQL through FORWARD are not covered.

Lifted when the old primary is rebuilt as the replica (rebuild → hostsChanged) or becomes the
replica in a switchover (excluded as the replica, and the switchover refreshes the list
before it starts). The rebuild runs `mysqldump` *from* the old primary *against the new
primary*, and replication connects replica → primary, so blocking connections *to* the old
primary never blocks its own rebuild.

## Measured (dry run, real processes: main 5501 + standby panel on agent A 5502 + agents A, B)

`kill -9` of main (panel leader + database primary), failoverSeconds 15, three runs —
new leader 7.8 / 7.9 / 7.8 s, replica promoted 9.0 / 9.0 / 8.9 s, hosts + cut-over on both
surviving agents 9.0 / 9.0 / 8.9 s. At 30: leader 15.8 s, promoted and cut over 18.1 s. Database primary on agent A
(leader on main), A killed: promoted 5.1 s, cut over 5.1 s. Main frozen (SIGSTOP) 3 s: nothing
moves; 10 s: standby leads at 7.9 s, main fences itself when it resumes, and (database also
unreachable) the replica is promoted at 9.0 s. 15 → 60 → 10 → 15 at runtime: one leader
(term 1) throughout, no candidacy, voters followed the heartbeat (1 → 4 → 1 s) and kept the
26 s leases granted at 60 until they ran out.

## Versions

Panel 3.10.0; TASKS_VERSION / AGENT_VERSION 3.4.0 (`mysql.probe`, `dbCutover`, voter protocol 2,
poll abandon). The replica probe needs agent ≥ 3.4.0 on the replica (else the IO-thread state
alone); agents update themselves from the leader.
