# Forthway Command Center

A password-protected control panel for the sites you run on Linux.

Add a site, point it at its folder, and from then on you either drop a zip on
its card or pull a branch from GitHub. The Command Center unpacks it, installs,
builds, swaps it into place, restarts the app, checks that the version actually
serving traffic is the new one — and puts the old build back if it is not.

```
                    ┌────────────────────────────────┐
   you  ───────────▶│     Command Center (web)       │  ← one password
   zip / GitHub     │     sites · releases · logs    │
                    └───────────┬────────────────────┘
                                │
          ┌─────────────────────┴─────────────────────┐
          ▼                                           ▼
  sites on THIS machine                     sites on other machines
  (no agent — it just does it)              (an agent there dials out to here)
```

Most of the time every site is on the same box as the panel, so there is
nothing to install beyond the panel itself. Agents exist for the sites that are
somewhere else; they only ever make outbound connections, so nothing needs to
be opened up on those machines.

No npm dependencies anywhere. Node 18+ is the only requirement — deliberately,
because this is the tool you reach for when a build has gone wrong, and it must
not need a build of its own.

---

## Install

```bash
bash install.sh
```

That is the whole thing. It installs Node and pm2 if they are missing, puts the
files in place, starts the panel under pm2, and prints the address to open.
There is nothing to edit afterwards: **the first page you open asks you to
choose a password**, and everything else is done from the dashboard.

Run it again later to update in place — your password, sites and release
history are kept.

<details>
<summary>Options</summary>

| Variable | Default | What it does |
|---|---|---|
| `FCC_DIR` | `/opt/forthway`, or `./forthway` in a container | Where to install |
| `FCC_PORT` | `4000` | Port, when the environment does not set one |
| `FCC_HOST` | `0.0.0.0` | Address to bind |
| `FCC_NAME` | `forthway` | pm2 process name |
| `FCC_REPO` | — | `owner/repo` to fetch the source from, instead of the current folder |
| `FCC_NO_START` | — | Install the files but start nothing |

</details>

### In a Pterodactyl container

The installer notices it is in a container (no root, `/home/container`) and
adapts: it installs into the current directory and uses the panel's allocated
port. Set the server's **startup command** to:

```
cd /home/container/forthway && pm2-runtime start hub/server.mjs --name forthway
```

The port comes from the panel's `SERVER_PORT` variable automatically — that is
the first thing the panel reads, ahead of anything in `config.json`. The port
field in Settings shows as locked in that case, with a note saying where to
change it.

### Day to day

```bash
pm2 status
pm2 logs forthway
pm2 restart forthway
```

---

## Adding a site

**+ Add site** opens a walkthrough that asks one thing at a time and works out
the rest for itself:

1. **Name** it, and say whether it runs on this machine or another one.
2. **Folder and port** — apps live under `/home/container`, so this only asks
   for the folder name and fills it in from the site name. (Set `appRoot` in
   `hub/config.json`, or `FCC_APP_ROOT`, for a machine laid out differently;
   there is still a box for a path somewhere else entirely.) If the folder is
   not there yet it is created now, so the `.env` written two steps later has
   somewhere to go. The port is required — it is what the health and version
   checks after a deploy are pointed at.
3. **Code** — pull the repository from GitHub now. It is downloaded here and
   kept as a release, and the two steps after this one read the app's own
   `package.json` and `.env.example` straight out of it, so they can offer real
   answers instead of asking you to remember them. You can skip this and upload
   a zip later.
4. **Start** — pm2 by default, named after the site. The first start command is
   a list of what `package.json` actually declares, each shown with the command
   it runs; `npm start` is the default.
5. **Environment** — a row per variable the app expects, taken from its
   `.env.example`, prefilled from any `.env` already on disk, with room to add
   your own. A variable left blank is not written. Saving writes the app's
   `.env` there and then, inside a marked block that leaves the rest of the file
   alone.
6. **Done** — settings saved and, if you pulled a release, deployed.

Health checks, the build pipeline, which files survive a deploy and the GitHub
repo all live behind **Show advanced options** in the site's settings; the
defaults suit a Next.js app.

**On this machine** — the normal case. There is no agent, no token and nothing
to install; the panel runs the commands itself.

**On another machine** — you get a one-line installer with the site's id and
token already in it:

```bash
curl -fsSL "http://your-panel:4000/install/agent.sh?site=...&token=..." | sudo bash
```

Run that on the other box. It installs Node and pm2 if needed, starts the agent
under pm2 and checks in. Everything else about the site is still configured
here, in the browser.

### What you configure per site

| | |
|---|---|
| **App directory** | The folder the app lives in. The agent keeps its staging build, rollback snapshot and file manifest in `.forthway/` inside it, and deploys never touch that. |
| **Port** | Required. What the app listens on. It fills in the health and version checks, and is passed to the app as `PORT`. |
| **Restart mode** | **pm2** (name the process), **systemd** (name the unit), **command** (your own stop and start), or **supervised** (the panel runs the app itself and so knows for certain when it has stopped). |
| **Environment** | A row per variable, or a plain `KEY=value` block behind **Edit as text**. **Load from .env.example** re-reads the app's own list at any time. Written to the app's `.env` as soon as you save. |
| **Health / version URL** | Advanced. Left blank they default to `http://127.0.0.1:PORT/api/health` and `/api/version`. |
| **Build pipeline** | Advanced. Install, an optional prepare step, and build — each one a command, each one skippable. Defaults suit a Next.js app; blank them out for anything that does not need building. A Prisma schema is detected and generated for you. |
| **Files** | Advanced. Which generated directories get swapped whole (`node_modules`, `.next`), and which paths a deploy must never touch (`.env`, uploads, logs). |

Everything is editable at any time. For a remote site the change reaches the
agent on its next poll, a second or two later — you never edit a file on the
target machine.

---

## The dashboard

The panel is built in the Collective OS idiom: a warm cream ground, white
cards with a hairline border and no shadow, near-black as the action colour,
and a dark capsule header floating over the page. Every colour and radius
lives in one `:root` block at the top of `hub/public/index.html`.


Each site gets a small card: whether it is up, what version is on disk, what
version is actually serving, and anything that needs attention. Two menus sit
on it for the things you do without thinking —

- **Actions** — restart, stop, start, refresh, roll back, pull & deploy.
- **Run** — the app's own npm scripts, read from its `package.json`, minus the
  ones that run the app itself (`start`, `dev`). So `db:migrate`, `seed` or
  `typecheck` are one click, and the output streams into the console.

**Click the card** for everything else: uploading a zip, pulling a branch,
the release list, deploy and rollback, recent jobs and their logs, and a box
for any command you want to run in the app directory.

---

## Deploying

**Upload a zip** — drop it in the site's view (click its card). It reads the
version out of `package.json` and shows you `1.4.2 → 1.5.0` before you commit.

**Pull from GitHub** — give it `owner/name` and a branch or tag. The archive is
downloaded here and kept as a release, so rolling back is a file operation
rather than a bet on git history still looking the way it did. The target
machines never need git or any GitHub credentials.

*Private repositories*: put a personal access token in **Settings** for
panel-wide use, or set one per site under its GitHub section. Either one is
enough; the per-site token wins where both exist.

Once a repo is set, the card grows a **Pull & deploy** button — one click from
"pushed to main" to "live".

### What happens during a deploy

1. The archive is unpacked into a staging directory, never over the live app.
2. `node_modules` is hardlinked across from the running build, so an install is
   usually seconds rather than minutes. If `package.json` and the lockfile are
   unchanged, the install is skipped entirely.
3. Install → prepare → build, all in staging. **A failed build never reaches
   the live app**: nothing has moved yet, so there is nothing to undo.
4. The app stops, the current build is snapshotted, and only the files that
   actually changed are replaced. Files the previous release installed and this
   one drops are removed. Files a deploy never owned — `.env`, uploads — are
   left alone.
5. The app starts, and the panel waits for the health check.
6. **Then it checks the version**, which is the part that matters. A stop
   command that silently did nothing leaves the *old* process answering health
   checks perfectly while your new code never loads. That specific failure is
   caught and named.
7. If either check fails, the previous build is restored and restarted.

The full output of every step streams into the console at the bottom of the
page as it happens — the same for a site on this machine and one on an agent.

### The two routes worth adding

`patches/api-health-route.ts` and `patches/api-version-route.ts` are drop-in
Next.js routes. The version one is what makes the "serving now" number honest:
it reports what the *running process* loaded, not what is sitting on disk.
Without it the panel still works, it just cannot prove a restart took effect.

---

## The rest of the panel

**Restart · Stop · Start** — with the command output streaming, so you can see
what actually happened rather than guessing.

**Run a command** — a box on every card that runs a one-off command in the app
directory and streams it back. `pm2 logs --lines 50`, `git status`, `df -h`.

**Roll back** — one click for the build before this one, or pick any archive in
the release list. The previous build is kept as a snapshot on disk, so undoing
the last deploy is a rename rather than a rebuild.

**Migrations** — `runmigNN.cjs` scripts found in the app directory can be run on
demand, or ticked to run as part of a deploy. They are not undone by a
rollback, and the panel says so before you commit.

**Releases** — every archive is kept, up to a limit you set. Pin one to keep it
forever. The live release and the one before it are never pruned.

---

## Reaching it from outside: Cloudflare Tunnel

**Settings → Cloudflare.** This machine dials out to Cloudflare, so the panel
and the sites on it are reachable by name without port-forwarding anything or
having a public address.

**Log in with Cloudflare** and the panel does the rest itself. If that machine
has already been through a `cloudflared tunnel login` at some point, its
certificate is read and you are connected without a browser at all. Otherwise
it runs the login, opens the approval page for you (and shows the link, for
when the panel is somewhere a browser is not), and takes the credentials out of
the certificate Cloudflare writes back.

cloudflared is given a home directory of its own under `hub/data/`, so a
certificate already sitting in yours is neither overwritten nor read by
accident.

1. **The connector.** Create one, or adopt a tunnel already in the account. It
   is created remotely-managed, so its routes live in Zero Trust → Networks →
   Tunnels and stay editable there as well as here. The panel takes its
   connector token, stores it, and starts running it.
2. **Host routes.** Type a name, pick the domain from the list of zones your
   account actually owns, and choose what it reaches — this panel, or any local
   site, by name and port. These are Zero Trust public hostnames pointing at
   `127.0.0.1`, so the app itself never has to listen on anything but localhost.
   The panel writes both halves: the tunnel's ingress rule *and* the proxied
   CNAME that makes the name resolve. Removing a route removes both again.

It only ever touches DNS records it created (a CNAME to `*.cfargotunnel.com`);
anything else in the zone is left alone and reported rather than overwritten.

Two other ways in, if the login does not suit:

- **An API token** — Account · Cloudflare Tunnel · Edit, Zone · DNS · Edit,
  Zone · Zone · Read — under "Use an API token instead". Identical from there on.
- **A connector token** (Zero Trust → Networks → Tunnels → your tunnel → Install
  connector) under "Paste a connector token instead". No account access at all;
  hostnames are then set in the Cloudflare dashboard rather than here.

`127.0.0.1` rather than `localhost`, deliberately: on a dual-stack machine
`localhost` can resolve to `::1` first, and an app bound only to IPv4 then
refuses the connector's connection for reasons that look like nothing at all.

- **cloudflared installs itself.** If it is not already on PATH the panel
  downloads the official build into `hub/data/bin/`, which matters in a
  container with no root. There is also an explicit install button.
- **The token never reaches the process list.** It is passed as `TUNNEL_TOKEN`
  in the environment, not as an argument, so it does not show up in `ps`.
  Stored in `hub/config.json`, and the UI only ever shows you a masked hint.
- **A bad token stops rather than spins.** cloudflared exits immediately on an
  invalid token; the panel notices, says so, and does not retry. A connection
  that drops for any other reason is retried with a growing backoff.
- The header shows a tunnel indicator with the live connection count, and
  **Show log** puts cloudflared's own output in the console at the bottom of
  the page.

---

## Starting a new site

`template/` is a Next.js + TypeScript starter, ready to deploy from here. Push
it to its own GitHub repository once; after that a new test site is: fork the
repo, add a site in the panel, point it at the fork, **Pull & deploy**.

It already has the `/api/health` and `/api/version` routes, so the version
confirmation and automatic rollback work from the very first deploy — and a
`CLAUDE.md` explaining the project to Claude. See `template/README.md`.

---

## Layout

```
Forthway Command Center/
  install.sh          one-command installer
  template/           Next.js starter for new sites — push it as its own repo
  hub/                the panel — runs on ONE machine
    server.mjs
    lib/              sites, storage, auth, GitHub, the local runner, the tunnel
    public/           setup · login · dashboard
    templates/        the agent installer, with tokens filled in per site
    config.json       created on first run; holds sites and the password hash
    data/             release archives, job logs, state, cloudflared
  agent/              only for sites on OTHER machines
    agent.mjs
  shared/
    deployer.mjs      the deploy engine — used by the panel and the agent alike
    zip.mjs fsx.mjs   archive and filesystem helpers
  scripts/
    make-release.mjs  package a folder into a release zip, if you prefer that
  patches/            the two Next.js routes to add to each site
```

---

## Notes on running it safely

**Put it behind HTTPS if it is reachable from the internet.** You type a
password into it and agents send their tokens in a header. Either point nginx
at it, or set `"tls": { "key": "...", "cert": "..." }` in `hub/config.json`.

**It runs commands you give it, as the user it runs as.** That is the job — but
it means the password is the only thing between someone and a shell on that
box. Use a long one.

**`hub/config.json` holds the site tokens and your GitHub token.** The
installer sets it to mode 600. Back it up somewhere sensible; losing it means
re-running the agent installers.
