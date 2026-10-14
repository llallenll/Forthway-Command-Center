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
