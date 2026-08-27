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

**+ Add site**, give it a name, and say where it runs.

**On this machine** — the normal case. Fill in the app directory and you are
done; there is no agent, no token and nothing to install. The panel runs the
commands itself.

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
| **Port** | What the app listens on. It fills in the health and version checks, and is passed to the app as `PORT`. |
| **Restart mode** | **pm2** (name the process), **systemd** (name the unit), **command** (your own stop and start), or **supervised** (the panel runs the app itself and so knows for certain when it has stopped). |
| **Health / version URL** | Optional. Left blank they default to `http://127.0.0.1:PORT/api/health` and `/api/version`. |
| **Build pipeline** | Install, an optional prepare step, and build — each one a command, each one skippable. Defaults suit a Next.js app; blank them out for anything that does not need building. A Prisma schema is detected and generated for you. |
| **Files** | Which generated directories get swapped whole (`node_modules`, `.next`), and which paths a deploy must never touch (`.env`, uploads, logs). |

Everything is editable at any time. For a remote site the change reaches the
agent on its next poll, a second or two later — you never edit a file on the
target machine.

---

## Deploying

**Upload a zip** — drop it on the card. It reads the version out of
`package.json` and shows you `1.4.2 → 1.5.0` before you commit.

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

## Layout

```
Forthway Command Center/
  install.sh          one-command installer
  hub/                the panel — runs on ONE machine
    server.mjs
    lib/              sites, storage, auth, GitHub, the local runner
    public/           setup · login · dashboard
    templates/        the agent installer, with tokens filled in per site
    config.json       created on first run; holds sites and the password hash
    data/             release archives, job logs, state
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
