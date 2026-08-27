#!/usr/bin/env bash
#
# Forthway Command Center — installer
#
#   From a copy of this folder:   bash install.sh
#   From GitHub:                  curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/install.sh \
#                                   | FCC_REPO=OWNER/REPO bash
#
# Installs Node and pm2 if they are missing, puts the Command Center in place,
# starts it under pm2, and prints the address to open. There is nothing to
# edit afterwards: the first page asks you to pick a password, and sites are
# added from the dashboard.
#
# It adapts to where it is run:
#   • On a normal Ubuntu/Debian box as root  → installs to /opt/forthway and
#     asks pm2 to resurrect itself on boot.
#   • Inside a Pterodactyl container (or any /home/container-style sandbox)
#     → installs to the current directory, uses the panel's SERVER_PORT, and
#     prints the startup command to paste into the panel.
#
# Overrides:
#   FCC_DIR=/opt/forthway     where to install
#   FCC_PORT=4000             port (ignored if SERVER_PORT is set by the panel)
#   FCC_HOST=0.0.0.0          address to bind
#   FCC_NAME=forthway         pm2 process name
#   FCC_REPO=owner/repo       fetch the source from GitHub instead of ./
#   FCC_REF=main              branch or tag to fetch
#   FCC_NO_START=1            install the files but do not start anything
#
set -euo pipefail

MIN_NODE_MAJOR=18
FCC_NAME="${FCC_NAME:-forthway}"
FCC_REF="${FCC_REF:-main}"
FCC_HOST="${FCC_HOST:-0.0.0.0}"

if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
else
  B=""; DIM=""; G=""; Y=""; R=""; N=""
fi
say()  { printf '%s\n' "  $*"; }
step() { printf '\n%s\n' "${B}> $*${N}"; }
ok()   { printf '%s\n' "  ${G}OK${N} $*"; }
warn() { printf '%s\n' "  ${Y}!${N}  $*"; }
die()  { printf '\n%s\n\n' "  ${R}x  $*${N}" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

IS_ROOT=0; [ "$(id -u)" -eq 0 ] && IS_ROOT=1
SUDO=""; [ "$IS_ROOT" -eq 0 ] && have sudo && SUDO="sudo"

# A Pterodactyl container gives you /home/container and no root. Detect that
# rather than failing halfway through a package install that cannot work.
CONTAINER=0
if [ -d /home/container ] || [ "${P_SERVER_UUID:-}" != "" ] || [ -n "${SERVER_PORT:-}" ]; then CONTAINER=1; fi
[ "$IS_ROOT" -eq 0 ] && [ -z "$SUDO" ] && CONTAINER=1

if [ "$CONTAINER" -eq 1 ]; then
  FCC_DIR="${FCC_DIR:-$(pwd)/forthway}"
  [ -d /home/container ] && [ "$(pwd)" = "/home/container" ] && FCC_DIR="${FCC_DIR:-/home/container/forthway}"
else
  FCC_DIR="${FCC_DIR:-/opt/forthway}"
fi
PORT="${SERVER_PORT:-${FCC_PORT:-4000}}"

printf '\n%s\n' "${B}Forthway Command Center — installer${N}"
printf '%s\n' "${DIM}  target: ${FCC_DIR}  ·  port: ${PORT}$([ "$CONTAINER" -eq 1 ] && echo '  ·  container mode')${N}"

# ------------------------------------------------------------------- node

node_major() { have node || { echo 0; return; }; node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

step "Checking prerequisites"
have curl || die "curl is required."

if [ "$(node_major)" -lt "$MIN_NODE_MAJOR" ]; then
  if [ "$CONTAINER" -eq 1 ]; then
    die "Node ${MIN_NODE_MAJOR}+ is required and this container cannot install it. Use a Node 20/22 egg, or install Node first."
  fi
  warn "installing Node.js"
  if have apt-get; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash - >/dev/null 2>&1 || true
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs >/dev/null 2>&1 || true
  elif have dnf; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO bash - >/dev/null 2>&1 || true
    $SUDO dnf install -y nodejs >/dev/null 2>&1 || true
  elif have yum; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO bash - >/dev/null 2>&1 || true
    $SUDO yum install -y nodejs >/dev/null 2>&1 || true
  elif have apk; then
    $SUDO apk add --no-cache nodejs npm >/dev/null 2>&1 || true
  elif have pacman; then
    $SUDO pacman -Sy --noconfirm nodejs npm >/dev/null 2>&1 || true
  fi
  [ "$(node_major)" -ge "$MIN_NODE_MAJOR" ] || die "Could not install Node ${MIN_NODE_MAJOR}+. Install it by hand and re-run this."
fi
ok "Node $(node -v)"

# --------------------------------------------------------------------- pm2

install_pm2() {
  have npm || die "npm is required to install pm2."
  if [ "$CONTAINER" -eq 1 ] || [ "$IS_ROOT" -eq 0 ]; then
    # No root: keep pm2 in the user's own prefix rather than fighting /usr/lib.
    npm install -g pm2 >/dev/null 2>&1 || {
      export NPM_CONFIG_PREFIX="$HOME/.npm-global"
      mkdir -p "$NPM_CONFIG_PREFIX"
      export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
      npm install -g pm2 >/dev/null 2>&1 || return 1
      grep -q 'npm-global/bin' "$HOME/.profile" 2>/dev/null || \
        echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$HOME/.profile"
    }
  else
    $SUDO npm install -g pm2 >/dev/null 2>&1 || return 1
  fi
  have pm2
}

USE_PM2=1
if ! have pm2; then
  warn "installing pm2"
  install_pm2 || { USE_PM2=0; warn "could not install pm2 — will fall back to running it directly"; }
fi
have pm2 && ok "pm2 $(pm2 -v 2>/dev/null | tail -1)"

# ----------------------------------------------------------------- source

SRC=""
for candidate in "$(pwd)" "$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd || true)"; do
  [ -n "$candidate" ] || continue
  if [ -f "$candidate/hub/server.mjs" ] && [ -f "$candidate/shared/deployer.mjs" ]; then SRC="$candidate"; break; fi
done

if [ -z "$SRC" ]; then
  [ -n "${FCC_REPO:-}" ] || die "Run this from inside the Command Center folder, or set FCC_REPO=owner/repo."
  step "Downloading ${FCC_REPO}@${FCC_REF}"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  AUTH=()
  [ -n "${FCC_GITHUB_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer ${FCC_GITHUB_TOKEN}")
  curl -fsSL "${AUTH[@]}" "https://codeload.github.com/${FCC_REPO}/tar.gz/${FCC_REF}" -o "$TMP/src.tar.gz" \
    || die "Could not download ${FCC_REPO}@${FCC_REF}."
  tar -xzf "$TMP/src.tar.gz" -C "$TMP"
  SRC="$(dirname "$(find "$TMP" -maxdepth 3 -type f -path '*/hub/server.mjs' | head -1)")/.."
  SRC="$(cd "$SRC" && pwd)"
  [ -f "$SRC/hub/server.mjs" ] || die "That archive does not look like the Command Center."
  ok "downloaded"
fi

# Installing over itself would delete the source mid-copy.
if [ "$(cd "$SRC" && pwd)" = "$FCC_DIR" ]; then
  ok "already installed here — updating in place"
  SAME_DIR=1
else
  SAME_DIR=0
fi
say "${DIM}source: ${SRC}${N}"

# ---------------------------------------------------------------- install

UPGRADE=0
[ -f "$FCC_DIR/hub/server.mjs" ] && UPGRADE=1

step "$([ "$UPGRADE" -eq 1 ] && echo Updating || echo Installing) in ${FCC_DIR}"

if [ "$USE_PM2" -eq 1 ] && pm2 describe "$FCC_NAME" >/dev/null 2>&1; then
  pm2 stop "$FCC_NAME" >/dev/null 2>&1 || true
  say "stopped the running instance"
fi

mkdir -p "$FCC_DIR"
if [ "$SAME_DIR" -eq 0 ]; then
  # Code directories are replaced wholesale. config.json and data/ are never
  # touched, so an update keeps your password, sites and release history.
  for d in hub/lib hub/public hub/templates agent shared scripts patches; do
    [ -d "$SRC/$d" ] || continue
    rm -rf "${FCC_DIR:?}/$d"
    mkdir -p "$FCC_DIR/$(dirname "$d")"
    cp -R "$SRC/$d" "$FCC_DIR/$d"
  done
  cp "$SRC/hub/server.mjs" "$FCC_DIR/hub/server.mjs"
  for f in README.md install.sh; do [ -f "$SRC/$f" ] && cp "$SRC/$f" "$FCC_DIR/$f"; done
fi
mkdir -p "$FCC_DIR/hub/data/releases" "$FCC_DIR/hub/data/logs"

# The first run writes config.json itself; we only pre-seed the port and host
# so the process starts where you asked for it.
if [ ! -f "$FCC_DIR/hub/config.json" ]; then
  cat > "$FCC_DIR/hub/config.json" <<JSON
{
  "port": ${PORT},
  "host": "${FCC_HOST}",
  "passwordHash": null,
  "passwordSalt": null,
  "dataDir": "./data",
  "keepReleases": 8,
  "tls": null,
  "github": { "token": "", "username": "" },
  "sites": []
}
JSON
  ok "wrote a fresh hub/config.json"
else
  ok "kept your existing hub/config.json (password, sites and history preserved)"
fi
chmod 600 "$FCC_DIR/hub/config.json" 2>/dev/null || true
ok "files in place"

# ------------------------------------------------------------------- start

if [ "${FCC_NO_START:-0}" = "1" ]; then
  step "Not starting it (FCC_NO_START=1)"
  say "start it with:  pm2 start ${FCC_DIR}/hub/server.mjs --name ${FCC_NAME}"
  exit 0
fi

step "Starting under pm2"
if [ "$USE_PM2" -eq 1 ]; then
  pm2 delete "$FCC_NAME" >/dev/null 2>&1 || true
  ( cd "$FCC_DIR" && SERVER_PORT="$PORT" pm2 start hub/server.mjs --name "$FCC_NAME" --time --update-env >/dev/null )
  pm2 save >/dev/null 2>&1 || true
  ok "running as pm2 process \"${FCC_NAME}\""
  if [ "$CONTAINER" -eq 0 ] && [ "$IS_ROOT" -eq 1 ]; then
    if pm2 startup systemd -u root --hp /root >/dev/null 2>&1; then
      pm2 save >/dev/null 2>&1 || true
      ok "pm2 will bring it back after a reboot"
    fi
  fi
else
  pkill -f "$FCC_DIR/hub/server.mjs" 2>/dev/null || true
  ( cd "$FCC_DIR" && SERVER_PORT="$PORT" nohup node hub/server.mjs >"$FCC_DIR/hub/data/console.log" 2>&1 & )
  sleep 2
  warn "running without pm2 — it will not come back on its own after a reboot"
fi

# --------------------------------------------------------------- firewall

if [ "$CONTAINER" -eq 0 ] && [ "$IS_ROOT" -eq 1 ]; then
  if have ufw && ufw status 2>/dev/null | head -1 | grep -qi active; then
    ufw allow "${PORT}/tcp" >/dev/null 2>&1 && ok "opened port ${PORT} in ufw"
  elif have firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1 \
      && ok "opened port ${PORT} in firewalld"
  fi
fi

# ------------------------------------------------------------------ verify

step "Waiting for it to answer"
UP=0
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then UP=1; break; fi
  sleep 0.5
done

if [ "$UP" -ne 1 ]; then
  warn "nothing answered on port ${PORT} yet."
  [ "$USE_PM2" -eq 1 ] && say "check the log:  pm2 logs ${FCC_NAME} --lines 50"
  exit 1
fi
ok "answering on port ${PORT}"

SETUP_DONE="$(curl -fsS "http://127.0.0.1:${PORT}/healthz" | grep -o '"setup":[a-z]*' | cut -d: -f2)"

printf '\n%s\n' "${B}  Ready.${N}"
printf '%s\n' "  ${DIM}Open the Command Center at:${N}"
for ip in $(hostname -I 2>/dev/null || ip -4 -o addr show scope global 2>/dev/null | awk '{split($4,a,"/"); print a[1]}'); do
  printf '%s\n' "    ${B}http://${ip}:${PORT}${N}"
done
printf '%s\n' "    http://127.0.0.1:${PORT}${DIM}   (from this machine)${N}"

if [ "$SETUP_DONE" != "true" ]; then
  printf '\n%s\n' "  ${DIM}The first page asks you to choose a password. After that, add a site,${N}"
  printf '%s\n'   "  ${DIM}point it at its folder on this machine, and deploy.${N}"
fi

if [ "$CONTAINER" -eq 1 ]; then
  printf '\n%s\n' "  ${B}Pterodactyl:${N} set this as the server's startup command so the panel"
  printf '%s\n'   "  keeps it running and the console shows its output:"
  printf '\n%s\n' "    ${B}cd ${FCC_DIR} && pm2-runtime start hub/server.mjs --name ${FCC_NAME}${N}"
  printf '\n%s\n' "  ${DIM}The port comes from the panel's SERVER_PORT variable automatically.${N}"
else
  printf '\n%s\n' "  ${DIM}pm2:  pm2 status   ·   pm2 logs ${FCC_NAME}   ·   pm2 restart ${FCC_NAME}${N}"
fi
printf '\n'
