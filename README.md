# Forthway Command Center

A self-hosted control panel for the websites you run, on a VPS you own.

Install it on one server and that server becomes the whole operation: the
panel, the nginx front door every website is served through, the MySQL server
their databases live in, and the backups of all of it. Add more machines when
you need them — to give a site a server of its own, or to load balance one
across several — and they join by running a single command.

```
                         ┌──────────────────────────────────────────┐
   you ── browser ──────▶│  MAIN SERVER                             │
                         │   Command Center panel   (fcc.service)   │
   visitors ── 80/443 ──▶│   nginx  — front door / load balancer    │
                         │   MySQL  — every project's databases     │
                         │   backups — databases, servers, schedule │
                         │   websites (pm2, or nginx for static/php)│
                         └───────┬───────────────────────┬──────────┘
                     proxies to  │                       │  agents dial out to
                    site ports   ▼                       ▼  the panel (HTTPS)
                         ┌──────────────┐        ┌──────────────┐
                         │ Agent server │  ...   │ Agent server │
                         │  node agent  │        │  node agent  │
                         │  websites    │        │  websites    │
                         └──────────────┘        └──────────────┘
```

There is no npm install and no build step. Node 18+ is the only requirement —
deliberately, because this is the tool you reach for when a build has gone
wrong, and it must not need a build of its own.

There is also **no terminal and no "run a command" box**, anywhere. Every
operation is a named action — deploy, restart, back up, restore, rotate a
password — so what the panel can do to your servers is exactly the list of
buttons it shows you.

---

## Install

On a fresh **Ubuntu 22.04 / 24.04** or **Debian 12** VPS, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/llallenll/Forthway-Command-Center/standalone/install.sh | sudo bash
```

or, from a copy of this repository on the server, `sudo bash install.sh`.

It installs and configures everything the main server needs:

- **Node.js 20** (from NodeSource) if Node is missing or older than 18, and
  **pm2**, which keeps Node websites running and brings them back after a reboot.
- **nginx**, with the stock welcome page replaced by a catch-all that drops
  any request for a hostname no website claims. Point a stray domain at the
  server and it gets nothing, rather than whichever site happens to load first.
- **MySQL** (MariaDB on Debian 12, which has no MySQL package, or anywhere
  with `FCC_DB=mariadb`). Locked to `127.0.0.1`, no remote root, no anonymous
  users, no test database. Root keeps socket authentication, which is how the
  panel talks to it — no database root password is stored anywhere.
- **certbot** with the nginx plugin, for Let's Encrypt certificates.
- The panel itself in `/opt/fcc`, its data in `/var/lib/fcc` (root only), and
  websites under `/srv/fcc/sites`, running as the systemd service **`fcc`**.

At the end it prints the address to open. **The first page asks you to create
the first admin account** — do that straight away, because until an admin
exists, whoever opens the page first gets to.

Run the same command again to update. Code is replaced; admins, projects,
websites, databases and backups are not touched. The installer remembers the
options you gave it (in `/etc/fcc/installer.env`), so a plain re-run keeps
your port, domain and database choice.

### Options

Environment variables. Note `sudo` drops your environment, so put them after it:
`curl … | sudo FCC_PANEL_DOMAIN=panel.example.com FCC_EMAIL=you@example.com bash`.

| Variable | Default | What it does |
|---|---|---|
| `FCC_PANEL_DOMAIN` | — | Serve the panel at this name through nginx, with a Let's Encrypt certificate. Recommended. |
| `FCC_EMAIL` | — | Email for Let's Encrypt expiry notices. |
| `FCC_PORT` | `4000` | Port the panel listens on. |
| `FCC_HOST` | `0.0.0.0` | Address it binds. `127.0.0.1` makes it reachable only through the domain. |
| `FCC_DB` | `mysql` | `mariadb` to use MariaDB instead. An already installed server is always kept. |
| `FCC_MYSQL_REMOTE` | `0` | `1` lets MySQL listen on all interfaces, for websites on agent servers that use a database. Sticky until you set `0`. |
| `FCC_FIREWALL` | `0` | `1` turns on ufw allowing SSH, 80, 443 and the panel port. If ufw is already active those ports are opened regardless. |
| `FCC_PHP` | `0` | `1` installs php-fpm, for PHP websites. |
| `FCC_DIR` / `FCC_DATA_DIR` / `FCC_SITES_DIR` | `/opt/fcc` · `/var/lib/fcc` · `/srv/fcc/sites` | Where code, panel data and websites go. |
| `FCC_REPO` / `FCC_REF` | `llallenll/Forthway-Command-Center` · `standalone` | Where to fetch the code from. `FCC_GITHUB_TOKEN` for a private fork. |
| `FCC_NO_START` | — | Install everything but do not start the panel. |

### Day to day

```bash
systemctl status fcc          # is it up
journalctl -u fcc -f          # its log
systemctl restart fcc         # restart the panel — websites keep running
```

Restarting the panel never takes a website down: sites run under pm2 (or
nginx), not inside the panel process, and the service is set to stop only the
panel itself.

Extra environment for the service goes in `/etc/fcc/fcc.env`, which the
installer creates once and never overwrites.

### Uninstall

```bash
sudo bash /opt/fcc/install.sh --uninstall           # remove the service and code, keep data
sudo bash /opt/fcc/install.sh --uninstall --purge   # also delete /var/lib/fcc and FCC nginx configs
```

Neither touches website files, running sites, databases or installed
packages. `--purge` deletes local backups, so copy anything you want first.

---

## First login and admins

The setup page creates the **owner** account: name, email, password. After
that you sign in with email and password, and can add more admins under
**Settings → Admins**. Every admin can do everything; the owner just cannot be
deleted, and nobody can delete themselves, so there is always a way back in.

Sign-in attempts are throttled per address. Every change anyone makes — a
deploy, a restore, a revealed database password — goes into the **Activity**
log with who did it.

---

## Projects

A project is a folder for one piece of work: its websites, its databases and
their backups, and an activity feed of just that project. Projects have a
name, a description and a colour, and that is all — they exist so a server
running twenty sites for six clients stays readable.

A project with websites or databases still in it cannot be deleted. Remove
those first; it is deliberate that nothing disappears as a side effect.

---

## Websites

A website is a **Node app** (run under pm2), a **static site**, or a **PHP
site** (served by nginx and php-fpm). It has one or more domains, and it is
deployed from a zip you upload or straight from a GitHub branch or tag.

### Where it runs: one server, or load balanced

When you create a website you choose:

- **Single server** — the site runs on one machine. You pick it from a list
  of your servers, each showing its RAM and disk usage, so you can see which
  one has room. The main server is in that list; so is every agent server.
- **Load balanced** — the site runs on several servers at once, and nginx on
  the main server spreads visitors across them. You choose which servers (only
  those marked *Available for load balancing* are offered) and how traffic is
  shared: round robin, least connections, or by visitor IP (the same visitor
  keeps landing on the same server).

Either can be changed later. Add a server to a load balanced site and the
current release is deployed to it before it starts receiving traffic. Every
website shows whether it is load balanced, and its overview lists each server
it runs on with that copy's status.

### How the load balancing works

Every website — load balanced or not — gets its own nginx config on the main
server: an `upstream` listing the servers and ports the site runs on, and a
`server` block for its domains that proxies to it. A single-server site is
simply an upstream of one. That keeps the front door uniform: visitors always
arrive at the main server, and nginx always forwards them to *address:port*.

- **Health checks.** Each copy has a health path (default `/api/health`). The
  panel checks every copy and shows the result; nginx additionally takes a
  server out of rotation for ten seconds after three failed requests, so a
  copy that falls over stops getting traffic within moments, without anyone
  touching anything.
- **Rolling deploys.** A deploy to a load balanced site goes one server at a
  time: deploy, wait for it to come back healthy and serving the new version,
  then the next. At any moment the others are answering, so a release goes out
  without downtime — and a release that fails its checks on the first server
  stops there, rolled back, with the rest still on the old version.
- **Each site's config is tested before nginx is reloaded.** A bad change is
  refused and reported, never left half-applied.

> **Shared state.** When a site runs on several servers, each copy has its own
> disk and its own memory. Anything a visitor's next request might need must
> live somewhere all copies can see: **sessions in the database** (or a signed
> cookie), **uploads in object storage** (S3 or similar) or the database — never
> in the app's own folder or memory. Otherwise a visitor logs in on one server
> and is logged out on the next. Choosing *by visitor IP* hides this but does
> not fix it: when a server drops out, its visitors move. If an app cannot work
> that way yet, keep it on a single server.

### Deploying

**Upload a zip** or **pull from GitHub** — a branch or tag of `owner/name`.
Either way the archive is kept on the main server as a *release*, so rolling
back is a file operation rather than a bet on git history still looking the
way it did, and agent servers never need git or GitHub credentials. Private
repositories need a token in **Settings → GitHub**, or one set on the site.

For a Node site, a deploy:

1. unpacks into a staging directory, never over the live app;
2. installs and builds there — **a failed build never reaches the live app**;
3. stops the app, snapshots the current build, and swaps in only the files
   that changed (your `.env` and uploads are never touched);
4. starts it and waits for the health check;
5. **checks the version actually serving**, which is the part that matters: a
   restart that silently did nothing leaves the old process answering health
   checks perfectly while the new code never loads;
6. puts the previous build back if either check fails.

`patches/api-health-route.ts` and `patches/api-version-route.ts` are drop-in
Next.js routes for those two checks. Without the version route the panel still
works; it just cannot prove a restart took effect.

Every deploy, restart and rollback is a **job** with a live log you can watch,
and a history you can come back to.

`scripts/make-release.mjs` packages a folder into a release zip, for the times
you want to ship exactly what is on your disk.

### Environment

Each site has its own environment variables, written to the app's `.env`
inside a marked block that leaves the rest of the file alone. Linked database
variables appear alongside them, read-only (see below).

---

## Databases

Each project can have any number of MySQL databases. Creating one creates the
database and a user that can reach only that database, with a generated
password shown **once**. After that the password is stored encrypted with the
panel's key; you can reveal it (that is logged in Activity) or rotate it.

**Link a database to a website** and the site gets its connection details as
environment variables — `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`,
`DB_PASSWORD` and `DATABASE_URL` — with no copy-pasting. On the main server
`DB_HOST` is `127.0.0.1`; on an agent server it is the main server's address.
Rotate the password and every linked site's environment is rewritten.

You can import a `.sql` or `.sql.gz` dump into a database from its page.

---

## Backups

**Database backups** are a `mysqldump`, gzipped. **Server backups** are a
`tar.gz` of the things that make a server what it is — panel data, website
files, nginx configs, and optionally a full dump of every database — for the
main server or any agent server (the agent uploads its archive to the panel).

Both can be taken by hand or on a **schedule** — hourly, daily or weekly at a
time you choose — and each kind keeps the last *N* (the **retention**).
**Pinned** backups are never pruned, and can carry a note: "before the 2.0
migration".

Backups are stored in `/var/lib/fcc/backups` by default. Set an **S3**
destination (AWS, or anything S3-compatible: Backblaze B2, Cloudflare R2,
MinIO, Wasabi…) under **Settings → Backups** and they go off the machine too —
which they should, because a backup on the server it is backing up does not
survive losing that server.

**Restore** a database backup into its database, or a server backup onto the
main server (site files and nginx config). Panel data is not overwritten
while the panel is running from it.

---

## Agent servers

Any other Linux server can join as an **agent server**. Agent servers have
two uses, and one can do both:

- **Hosting websites of their own.** A single-server site can be placed on
  any agent server — the way to give a heavy site its own machine, or to put
  a site somewhere the main server is not.
- **Load balancing.** An agent server marked **Available for load balancing**
  can be one of the servers a load balanced site runs on.

**Settings → Servers → Add server**, give it a name and its address, and the
panel gives you a one-line installer with that server's token already in it:

```bash
curl -fsSL "https://panel.example.com/install/node.sh?server=...&token=..." | sudo bash
```

Run that on the new server. It installs Node and pm2 and starts a small agent
that dials **out** to the panel and checks in. The panel never connects to the
agent, so nothing on the agent server needs opening up *for the panel*. The
token is shown once; rotate it from the server's page if it leaks.

Two things do need to be reachable, and are worth knowing about if you run a
firewall:

- **Main → agent, on each website's port.** nginx on the main server proxies
  visitors to `agent-address:port`. Allow those ports **from the main
  server's address only** — or use a private network between your servers and
  set the agent's private address in the panel, so that traffic never touches
  the public interface.
- **Agent → main, on MySQL (3306)**, if a site on that agent uses a database.
  Install the main server with `FCC_MYSQL_REMOTE=1`, and allow 3306 from each
  agent server only (`ufw allow from <agent-ip> to any port 3306 proto tcp`).
  The panel grants database users to the agent servers' addresses
  specifically — never to `%` — and updates those grants when servers change.

Each server shows CPU, memory, disk and load, and how many websites it hosts.
A server that still hosts websites cannot be deleted; move them first.

---

## SSL

With `FCC_PANEL_DOMAIN` set, the installer gives the panel its own HTTPS vhost
and certificate. Point the name's DNS at the server *before* installing (or
re-run the installer once it is).

For websites, add the domains, point their DNS at the **main server** (it is
the front door even for sites that run elsewhere), and press **Issue
certificate** under the site's *Domains & SSL*. certbot does the rest, and its
systemd timer renews certificates on its own.

---

## Security notes

**The panel runs as root.** It has to: it writes nginx configs, manages MySQL,
runs certbot and takes server backups. That makes the admin password the key
to the machine. Use long, unique passwords, keep the admin list short, and
remove admins who no longer need access.

**Put it behind HTTPS.** You type a password into it and agents send their
tokens to it. Install with `FCC_PANEL_DOMAIN` (and then, if you like,
`FCC_HOST=127.0.0.1` so the plain-HTTP port is not exposed at all). Without a
domain, reach it over an SSH tunnel rather than over the open internet.

**There is no command runner, by design.** The previous version had a "run a
command" box; this one does not. A stolen session can still do damage —
it can deploy, delete and restore — but it cannot open a shell, read arbitrary
files or install software, because no button does those things.

**Secrets are encrypted at rest** with a key in `/var/lib/fcc`, which is mode
700. That directory *is* the panel: back it up (a server backup with *panel*
ticked does), and treat a copy of it as you would the root password.

---

## Development

On a Mac or any machine without nginx or MySQL:

```bash
FCC_DRY_RUN=1 FCC_DATA_DIR=./.devdata node panel/server.mjs
```

and open `http://localhost:4000`. In dry-run mode every system call (nginx,
mysql, certbot, pm2, tar) is logged instead of run, so the whole UI can be
clicked through safely. Modules report missing programs as "not installed"
rather than failing. `.devdata/` is git-ignored; delete it to start over.

---

## Layout

```
install.sh                  installer for the main server (also: --uninstall)
panel/                      the panel — runs on the MAIN server only
  server.mjs                boot, HTTP, static files, live events
  lib/                      auth, store, jobs, sites, cluster, load balancer,
                            mysql, backups, github, s3 — one module each
  public/                   the dashboard (vanilla JS, no build step)
  templates/node-install.sh the agent server installer, filled in per server
node/
  node-agent.mjs            the agent that runs on agent servers
shared/
  deployer.mjs              the deploy engine
  tasks.mjs                 site/server tasks — run by agents, and in-process on main
  env.mjs fsx.mjs zip.mjs zipwrite.mjs
scripts/
  make-release.mjs          package a folder into a release zip
patches/                    health and version routes to add to Next.js sites
docs/STANDALONE.md          architecture and module contract
```

On a server:

```
/opt/fcc                    code (replaced on update)
/var/lib/fcc                panel data, job logs, releases, backups  (700)
/srv/fcc/sites/<project>/<site>   website files
/etc/nginx/conf.d/fcc-*.conf      one front-door config per website
/etc/fcc/                   installer choices, extra service environment
/etc/systemd/system/fcc.service
```
