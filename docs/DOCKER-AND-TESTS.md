# Docker websites and commit testing

Two features, one contract. Read `docs/STANDALONE.md` first; everything there
still holds (zero npm dependencies, Node 18+, FCC_DRY_RUN=1 must boot and the
whole UI must be usable on a Mac, `sys.run` for every system call).

## Why

Before this, every website ran as **root** under pm2, started by the root panel
and inheriting its environment. One weak site meant the whole server and the
panel's secrets. Now a website runs in its own container as its own non-root
user, sees only its own folder, and gets only its own variables.

Commit testing lets an admin say "test this commit" after pulling from GitHub.
The commit is NOT deployed: a throw-away copy of the site (its own containers,
its own empty database, captured email) is built on a server, Claude Code runs
inside a sandboxed tester container against that copy only, and the panel
shows the run live and ends with a verdict: ready for production or not, and
what to improve.

## Ownership

| Area | Files | Owner |
|---|---|---|
| Docker helper (shared) | `shared/docker.mjs` | lead (done) |
| Docker runtime + migrate | `shared/deployer.mjs`, `shared/tasks.mjs`, `panel/lib/sites.mjs`, `panel/lib/usage.mjs`, `install.sh`, `panel/templates/node-install.sh`, `scripts/docker-runtime.test.mjs` | RUNTIME |
| Commit testing backend | `shared/testenv.mjs`, `panel/lib/site-tests.mjs`, `panel/templates/tester/*`, `scripts/site-tests.test.mjs`, the `MODULES` list in `panel/server.mjs` (add `"site-tests"` after `"sites"`) | TESTS |
| UI | everything under `panel/public/` | UI |
| This file | append notes only under your own heading at the bottom | all |

Do not edit another owner's files. If you need something, use the interfaces
below; if one is missing, say so in your report.

## 1. Docker runtime (RUNTIME)

### Site record additions

```js
site.runtime   = "docker" | "legacy"     // node + php sites. Missing = "legacy" (old sites)
                                         // static sites: always "none" (nginx serves files; no code runs)
site.container = { uid, gid, image, memoryMb, cpus }   // uid = gid, unique per site, from UID_BASE (20000) up
```

New node/php sites are created with `runtime: "docker"`. Existing sites stay
`legacy` until migrated.

### publicSite additions

```js
runtime: "docker" | "legacy" | "none",
container: { uid, image, memoryMb, cpus } | null,
canMigrate: boolean,          // legacy node/php site that can move to docker
```

### Routes

```
POST /api/sites/:id/migrate   { to: "docker" | "legacy" }  -> job
PATCH /api/sites/:id          accepts container: { image?, memoryMb?, cpus? }
GET  /api/servers/:id/docker  -> { installed, running, version, error? }   (task server.docker {check:true})
```

Migrating to docker, per target server, as one site job:
1. `server.docker` task: install docker.io if missing, `systemctl enable --now docker`, pull the image.
2. Set `runtime: "docker"`, allocate `container` if missing.
3. Redeploy the current release with the normal pipeline. Install/build run
   inside a `docker run --rm` (shared/docker.mjs `buildArgs`) as the site's
   uid; native modules are rebuilt for the container. When the engine stops
   the old app it also deletes the legacy pm2 process, so downtime is only the
   swap + start, not the build.
4. On failure: set `runtime` back to `legacy`, restart the old way (which also
   removes any half-made container), report clearly.

`to: "legacy"` is the way back (same shape, reversed).

### Running a docker website

- Container `fcc-<siteId>` (`containerName`), `--restart unless-stopped`
  (replaces `pm2 save` for reboots), `--network host` so the app still reaches
  MySQL on 127.0.0.1 with its existing grants and the server firewall still
  applies (docker `-p` publishing bypasses ufw — do not use it).
- appDir bind-mounted at the same path, owned by the site uid (`docker.own`),
  mode 0750; nothing else of the host is mounted.
- Env: the site's own variables + PORT + NODE_ENV only — never the panel's
  `process.env`.
- `--read-only` root filesystem, `/tmp` tmpfs, memory/pids limits from
  `site.container` (defaults in `DEFAULT_LIMITS`).
- Status / logs / usage / scripts (`site.script` runs inside a one-off
  container) / remove all have a docker branch. Usage: the container's main
  pid from `docker inspect` is the process-tree root.
- Under FCC_DRY_RUN everything is simulated like today.

### Task types (shared/tasks.mjs)

```
server.docker  { check?: bool, image?: string }  -> { installed, running, version, pulled? }
site.test      payload below — dispatched to shared/testenv.mjs runSiteTest(payload, o)
```

`site.test` timeout: 3 hours. Bump `TASKS_VERSION`.

### ctx.sites additions (for TESTS)

```js
ctx.sites.releasePayload(release, serverId, base) // same object site.deploy gets
ctx.sites.linkedEnvSources(site, serverId)        // async -> [{ databaseId, name, prefix, vars }]
ctx.sites.deploy(siteId, releaseId, { admin, base }) -> job   // same as POST /api/sites/:id/deploy
ctx.sites.panelBase(req)                          // base URL agents download releases from
```

## 2. Commit testing (TESTS)

### Collections

```js
testRun {
  id, siteId, releaseId, serverId, jobId, adminId,
  commit: { sha, shortSha, message, author } | null, version,
  status: "queued" | "preparing" | "testing" | "reporting" | "done" | "error" | "cancelled",
  phase: string,                      // human words for what is happening now
  verdict: null | "ready" | "not_ready",
  score: null | 0..100,
  summary: string,
  checks: [{ id, category, title, status: "pending"|"running"|"pass"|"warn"|"fail"|"skip", detail, startedAt, finishedAt }],
  findings: [{ id, severity: "critical"|"high"|"medium"|"low"|"info", category, title, detail, fix, location }],
  activity: [{ at, kind: "info"|"tool"|"think"|"error", text }],    // newest last, capped at 300
  env: { url, database: bool, mail: bool },
  usage: { turns, durationMs } | null,
  error, createdAt, startedAt, finishedAt,
}
testSettings { id: siteId, env: { KEY: value } }   // per-site test-only variables (e.g. Stripe TEST keys), values encrypted at rest
```

Categories (fixed list, UI has an icon/colour for each):
`setup, payments, database, auth, features, security, config`.

A run is `not_ready` if any finding is critical or high, or any check in
`payments`, `auth` or `features` failed.

### Routes

```
GET    /api/sites/:id/tests                -> { items: [testRun summary, newest first] }
POST   /api/sites/:id/tests  { releaseId } -> testRun   (409 if a run is active for that site)
GET    /api/tests/:id                      -> testRun (full)
POST   /api/tests/:id/cancel               -> testRun
POST   /api/tests/:id/deploy               -> job      (deploy the tested release)
DELETE /api/tests/:id
GET    /api/sites/:id/test-env             -> { items: [{ key, set: true }] }   (values never returned)
PUT    /api/sites/:id/test-env  { env: { KEY: "value" | null } }   null removes
GET    /api/tester                         -> { tokenSet, model, maxMinutes, image, serverId }
PUT    /api/tester  { token?, clearToken?, model?, maxMinutes?, serverId? }
```

SSE: `testrun` with the full public run on every change (throttle to ≤ 2/s).

### What a run does (shared/testenv.mjs, task `site.test` on the chosen server)

All containers are labelled `fcc.test=<runId>` and removed at the end, on
cancel, and by a sweep at agent/panel start (anything older than 6 h).

1. Network `fcc-t-<runId>` (internal) + attach to the default bridge only the
   containers that need the internet.
2. Database: one throw-away MySQL container per linked database, random
   credentials, the site's variable names re-pointed at it (host/port/user/
   password/name/DATABASE_URL). Optionally the production schema (`--no-data`)
   — never production rows.
3. Mail: a mail-catcher container; SMTP_* / MAIL_* variables re-pointed at it,
   so nothing the test does ever emails a real person.
4. Site: unpack the release into `<dataDir>/tests/<runId>/app`, install + build
   in a `--rm` container (as runtime docker), run after-deploy scripts
   (migrations), start it on the test network. Variables: the site's env with
   live payment keys (sk_live_, pk_live_, rk_live_, whsec_ from live) REMOVED
   and the site's test variables (testSettings) applied on top.
5. Tester: the `fcc-tester` image (`panel/templates/tester/Dockerfile`, built
   once per server: node + Claude Code + Chromium via Playwright), non-root,
   with `CLAUDE_CODE_OAUTH_TOKEN` from settings. It can reach the test site,
   the mail catcher and the internet (Claude's API, the payment provider's
   TEST mode) — never the host, the panel, or production. `claude -p` with
   `--output-format stream-json`, a max-turn and max-minute budget.
6. Progress: the tester calls a small `fcc-report` CLI (in the image) that
   appends JSON lines to `/out/events.jsonl`; the runner tails it and the
   stream-json output and forwards each as a log line `@@fcc-test {json}` —
   flat objects — which site-tests.mjs parses into the run. Final report:
   `/out/report.json { verdict, score, summary, findings[] }`.
7. Teardown everything; the test folder is deleted.

The tester's instructions live in `panel/templates/tester/PROMPT.md`. They
describe an authorised assessment of the owner's own application, limited to
the disposable copy at the given URL, as a verification checklist by category
(see the categories above), and ask for a concrete fix with every finding.

Under FCC_DRY_RUN the run is simulated (≈40 s of realistic checks and a few
findings) so the UI can be built and demoed on a Mac.

## 3. UI (UI)

- **Pull from GitHub**: after the admin picks a commit and confirms the pull,
  ask "Do you want to test this commit?" — **Test it** pulls WITHOUT deploying
  (`deploy: false`), then `POST /api/sites/:id/tests` with the new release and
  opens the test page. **Deploy now** keeps today's behaviour.
- Each release row: a **Test** button, and the latest run's verdict badge.
- **Test page** `#/tests/:id` — the showpiece: animated category rings filling
  as checks complete, a live checklist with per-check state transitions, a
  scrolling activity feed of what Claude is doing, findings grouped by
  severity, and a final verdict reveal (Ready for production / Not ready +
  score). Respects `prefers-reduced-motion`. Buttons: Cancel (while running),
  Deploy this commit (when done; extra confirm if not_ready), Run again.
- Site page: a **Tests** tab listing runs.
- Site page header: runtime badge (Docker / Legacy / —) and a **Move to
  Docker** button for `canMigrate` sites (confirm dialog explaining the brief
  restart). Settings tab: container memory/CPU/image.
- Settings: **Website testing** section — Claude Code token (from
  `claude setup-token`, write-only field), model, time limit, which server
  runs tests.
- Environment tab: **Test-only variables** (write-only values).
- `?mock=1` must show all of the above with fake data (assets/mock.js).

## Notes

(append under your own heading)

### RUNTIME

- **PHP stays on the host** (`runtime: "legacy"`, `canMigrate: false`, POST
  migrate → 409). The official `php:*-fpm` images ship without
  `pdo_mysql`/`mysqli` (they need a custom image build), and nginx serves a
  PHP site's static files straight from appDir — which a 0750 folder owned by
  the site uid would lock it out of. Node only, for now.
- New node sites: `runtime: "docker"` + a `container` record (POST may pass
  `runtime: "legacy"` to opt out). Legacy node sites also get a `container`
  (uid reserved) when created; old records get one on their first migrate.
  `nextUid` fills gaps left by deleted sites.
- Deploy engine (ENGINE 2.1.0): restart mode `docker`; `runApp()` = install /
  prepare / build / runmig / command in `docker run --rm` (named
  `fcc-<id>-job-xxxx`, `--network host`, removed on cancel/timeout). npm's
  cache lives in `<appDir>/.forthway/cache/npm` (left out of server backups).
  `node_modules/.fcc-runtime` records which runtime the packages were built
  for; a different one (host ↔ docker, or another image) means a full fresh
  install — that is how native modules get rebuilt on a migrate.
- Every deploy of a docker site first runs `server.docker {image}` on the
  target (idempotent), so a new server installs Docker on its own; an agent
  older than tasks 3.7.0 gets a clear "update the agent" error.
- PATCH `container`: limits → restart job; image → rebuild of the current
  release in the new image.
- `ctx.sites` also has `runtime(siteOrId)`.
- `docker.mjs` additions: `nextUid`, `validImage`, `containerSettings`,
  `cliEnv`; `envFlags` now also drops `DOCKER_*` keys (they would steer the
  docker CLI itself).
- Installers: docker.io + `systemctl enable --now docker` unless
  `FCC_DOCKER=0` (remembered by install.sh).

### TESTS

- Collections are named `testRuns` (ids `trn_…`) and `testSettings` (id =
  siteId). Runs are kept 30 per site; runs of deleted sites are dropped at
  start. Settings live in `config.tester { tokenEnc, model, maxMinutes,
  maxTurns, serverId }` (config.json, mode 600, token encrypted).
- Additive to the contract: `GET/PUT /api/tester` also carry `maxTurns`
  (20–1000, default 200) and GET returns `serverName` and `categories`;
  `GET /api/tests/:id` adds `serverName, siteName, adminName, releaseExists,
  canDeploy`; `GET /api/sites/:id/tests` items are summaries with
  `counts { checks, passed, warned, failed, findings, bySeverity }`.
  `POST /api/sites/:id/tests` without `releaseId` tests the newest release.
  Deleting a run broadcasts `testrun { id, siteId, deleted: true }`.
  `model: ""` = Claude Code's default model. `PUT /api/tester` refuses an
  Anthropic API key (`sk-ant-api…`); `PUT test-env` refuses live payment keys.
- Server for a run: `config.tester.serverId`, else the site's first server.
- Log protocol (`@@fcc-test {json}`, flat): `phase {status, phase}`,
  `env {url, database, mail}`, `check {id, category, title, status, detail}`,
  `finding {id, severity, category, title, detail, fix, location}`,
  `activity {kind, text}`, `usage {turns, durationMs}`,
  `report {verdict, score, summary, complete}`. Parser/formatter and the
  verdict rule are in shared/testenv.mjs; checks merge by id, findings by id
  or category+title. A not-ready run's score is capped at 69; a run that
  never wrote its report is never "ready".
- Isolation: two networks per run (internal + an egress bridge with ICC off,
  fixed bridge names `fcct<hash>i/x`), and iptables rules tagged
  `fcc.test=<runId>`: INPUT drop from both bridges (no access to the host —
  panel, MySQL, sites), DOCKER-USER drop from the egress bridge to RFC 1918 /
  CGNAT / link-local (cloud metadata) and every cluster server address (+
  panel host, MySQL host). If iptables / DOCKER-USER is missing the run
  refuses to start. Egress containers use public DNS (1.1.1.1, 9.9.9.9).
  DB and mail catcher are internal only; build, the copy (node/php) and the
  tester get egress.
- Variables for the copy (`rewriteEnv`): linked DB keys + any MySQL URL /
  `*_DB_HOST`-style keys → the throw-away MySQL 8.4 (data on tmpfs);
  postgres/redis/mongo/amqp URLs removed; SMTP/MAIL keys → Mailpit; e-mail
  APIs, SMS/push providers and chat webhooks removed; `sk_/pk_/rk_live_`,
  Mollie `live_`, `*LIVE*` payment secrets removed, `whsec_` removed when
  live Stripe keys were present, PayPal/Braintree/Square/Adyen `*_MODE=live`
  → sandbox (their secrets removed); URLs on the site's domains → the copy's
  URL; test-only variables on top.
- The copy: node = the site's image + its start command; static = python
  http.server in the node image; php = `php:8.3-cli` built-in server (no
  pdo_mysql — enough for a smoke test only). The production schema copy
  (`--no-data`) is NOT implemented: the schema comes from the commit's own
  after-deploy scripts / migrations.
- Not-starting / build-failing commits end early with a critical finding and
  `not_ready` (Claude isn't run).
- Tester: `fcc-tester:latest` from panel/templates/tester (node 22 slim,
  `@anthropic-ai/claude-code`, `playwright` + Chromium, mariadb-client),
  user `tester` uid 10001 with `--group-add <run uid>` to read /app
  (read-only). The panel sends the template files in the payload, so agents
  need nothing on disk; image rebuilt when Dockerfile/fcc-report change
  (label `fcc.tester.hash`), PROMPT.md is per-run at /brief.
  Invocation: `docker exec … claude -p … --output-format stream-json
  --verbose --max-turns N --permission-mode bypassPermissions --add-dir /app
  [--model M]`, killed after maxMinutes.
- Cleanup: teardown in `finally` (containers → networks → firewall rules →
  folder); `sweepTestLeftovers()` at panel start on main (plus the ids of
  runs the restart interrupted) and at the start of every run on any server
  (older than 6 h + `staleRunIds` the panel sends).
- `ctx.siteTests = { latestFor(releaseId), summary(run) }` for anyone who
  wants the latest verdict per release.

### UI

- Files: `views/test-run.js` (the `#/tests/:id` page, route in `app.js`),
  `views/site-tests.js` (test-or-deploy question, pull-and-test, Tests tab,
  release verdict badges, test-only variables card, runtime badge, migrate
  dialogs, Container card), `views/settings-tester.js` (Settings → Website
  testing, `#/settings/testing`), edits in `views/site.js`,
  `views/settings.js`, `events.js` (`testrun` added to the SSE types),
  `icons.js` (`flask`, `card`, `container`), a "Commit testing" section at
  the end of `app.css`, and `mock.js` (fixtures + simulated runs).
- Pull flow: the Update button, the overview's Pull & deploy and the
  Deployments "Pull" button all ask "Do you want to test this commit?"
  (Deployments also offers "Only pull"; its old "Deploy right away" checkbox
  is gone). Test it = `releases/github {ref, deploy:false}` → wait for the
  job (`job` event, `GET /api/jobs/:id` poll as fallback) → `result.releaseId`
  → `POST /api/sites/:id/tests` → open the page. When an update is already a
  pulled release (`update.kind === "release"`) it tests that release directly.
- The test page patches the DOM in place per event (checks keyed by id,
  feed appended by `at|kind|text`, findings re-rendered only when they
  change) so animations play once. Checks may arrive all at once or one by
  one. Score counts up with requestAnimationFrame; everything else is CSS.
  `prefers-reduced-motion` turns animations off. A 15 s poll of
  `GET /api/tests/:id` covers a quiet event stream.
- The panel has only a dark theme; the new pages use its tokens and look the
  same with a light `prefers-color-scheme`.
- Fields used beyond the contract (all optional): 409 body `runId` on
  `POST /api/sites/:id/tests` (TESTS sends it), run `siteName`, `jobId`
  (raw log), `usage.turns`. Container memory/CPU/image save with
  `PATCH /api/sites/:id {container}`; the Settings tab reloads when the
  runtime changes after a migrate.
