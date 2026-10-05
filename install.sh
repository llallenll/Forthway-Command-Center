#!/usr/bin/env bash
#
# Forthway Command Center (Standalone, v3) — installer for the MAIN server
#
#   From a copy of the repository:   sudo bash install.sh
#   Straight from GitHub:            curl -fsSL https://raw.githubusercontent.com/llallenll/Forthway-Command-Center/standalone/install.sh | sudo bash
#
# Supported: Ubuntu 22.04 / 24.04 and Debian 12, as root, on x86_64 or arm64.
#
# What it does, in order:
#   1. preflight (root, OS, architecture) and base packages
#   2. Node.js 20 (NodeSource) if Node is missing or older than 18, and pm2
#   3. nginx, with a catch-all that drops requests for hostnames it does not know
#   4. MySQL (or MariaDB) with a safe baseline, certbot
#   5. optional ufw firewall
#   6. the panel code in /opt/fcc, its data in /var/lib/fcc, sites in /srv/fcc/sites
#   7. a systemd unit, fcc.service, started and enabled
#   8. optional HTTPS vhost for the panel itself (FCC_PANEL_DOMAIN)
#
# Running it again updates the code in place. Panel data (admins, projects,
# sites, backups) is never touched by an update.
#
# Options (environment variables; remembered in /etc/fcc/installer.env, so a
# re-run without them keeps what you chose last time):
#   FCC_DIR=/opt/fcc               where the code goes
#   FCC_DATA_DIR=/var/lib/fcc      where the panel keeps its data (mode 700)
#   FCC_SITES_DIR=/srv/fcc/sites   where websites live
#   FCC_PORT=4000                  panel port
#   FCC_HOST=0.0.0.0               address the panel binds (127.0.0.1 = only via nginx)
#   FCC_PANEL_DOMAIN=panel.example.com   serve the panel on this name via nginx + Let's Encrypt
#   FCC_EMAIL=you@example.com      Let's Encrypt account email (optional but recommended)
#   FCC_DB=mysql|mariadb           database server (Debian 12 has no MySQL package → mariadb)
#   FCC_MYSQL_REMOTE=1             MySQL listens on 0.0.0.0 so agent servers can reach it (0 to revert)
#   FCC_FIREWALL=1                 enable ufw: allow SSH, 80, 443 and the panel port
#   FCC_PHP=1                      also install php-fpm (for "php" websites)
#   FCC_PHPMYADMIN=1               also install the PHP packages phpMyAdmin needs and allow its port
#                                  (8081) in ufw; then install it from Settings → phpMyAdmin
#   FCC_REPO=owner/repo            fetch the source from GitHub instead of this folder
#   FCC_REF=standalone             branch or tag to fetch
#   FCC_GITHUB_TOKEN=…             token for a private repository
#   FCC_NO_START=1                 install everything but do not (re)start the panel
#   FCC_FORCE_OS=1                 try anyway on an unsupported OS
#
# Flags:
#   --uninstall      stop and remove the panel service and code; keep data
#   --purge          with --uninstall: also delete panel data and FCC nginx configs
#   --yes            do not ask for confirmation (needed for --purge when piped)
#   --help
#
set -euo pipefail

FCC_VERSION_LINE="3"
DEFAULT_REPO="llallenll/Forthway-Command-Center"
DEFAULT_REF="standalone"
MIN_NODE_MAJOR=18
NODE_MAJOR_TO_INSTALL=20

ETC_DIR="/etc/fcc"
SAVED_ENV="${ETC_DIR}/installer.env"
USER_ENV="${ETC_DIR}/fcc.env"
UNIT_FILE="/etc/systemd/system/fcc.service"
NGINX_CATCHALL="/etc/nginx/conf.d/forthway-catchall.conf"
NGINX_PANEL="/etc/nginx/conf.d/forthway-panel.conf"
LOG_FILE="/var/log/fcc-install.log"

# ------------------------------------------------------------------ output

if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; N=$'\033[0m'
else
  B=""; DIM=""; G=""; Y=""; R=""; C=""; N=""
fi
STEP_NO=0
say()  { printf '%s\n' "    $*"; }
step() { STEP_NO=$((STEP_NO + 1)); printf '\n%s\n' "${B}${C}[${STEP_NO}]${N} ${B}$*${N}"; }
ok()   { printf '%s\n' "    ${G}✓${N} $*"; }
warn() { printf '%s\n' "    ${Y}!${N} $*"; }
die()  { printf '\n%s\n\n' "  ${R}✗ $*${N}" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Long, noisy commands go to the log; on failure the tail of it is shown.
quiet() {
  local desc="$1"; shift
  printf '\n==> %s\n$ %s\n' "$desc" "$*" >>"$LOG_FILE"
  if ! "$@" >>"$LOG_FILE" 2>&1; then
    printf '%s\n' "    ${R}✗${N} ${desc} failed. Last lines of ${LOG_FILE}:" >&2
    tail -n 25 "$LOG_FILE" | sed 's/^/      /' >&2
    exit 1
  fi
}

apt_install() {
  quiet "apt-get install $*" env DEBIAN_FRONTEND=noninteractive apt-get install -y -q \
    -o DPkg::Lock::Timeout=300 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"
}
pkg_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q "install ok installed"; }

usage() { sed -n '2,48p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null | sed 's/^# \{0,1\}//' || true; }

# ------------------------------------------------------------------- flags

MODE="install"; PURGE=0; ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) MODE="uninstall" ;;
    --purge)     PURGE=1 ;;
    --yes|-y)    ASSUME_YES=1 ;;
    --help|-h)   usage; exit 0 ;;
    *) die "Unknown option: $1  (try --help)" ;;
  esac
  shift
done
[ "$PURGE" -eq 1 ] && [ "$MODE" != "uninstall" ] && die "--purge only makes sense with --uninstall."

# --------------------------------------------------------- remembered answers

# Anything set in the environment wins; otherwise the last run's choice;
# otherwise the default below.
load_saved() {
  [ -f "$SAVED_ENV" ] || return 0
  local k v
  while IFS='=' read -r k v || [ -n "$k" ]; do
    case "$k" in
      FCC_DIR|FCC_DATA_DIR|FCC_SITES_DIR|FCC_PORT|FCC_HOST|FCC_PANEL_DOMAIN|FCC_EMAIL|FCC_DB|FCC_MYSQL_REMOTE|FCC_FIREWALL|FCC_PHP|FCC_PHPMYADMIN|FCC_REPO|FCC_REF)
        if [ -z "${!k+x}" ]; then printf -v "$k" '%s' "$v"; export "${k?}"; fi ;;
    esac
  done <"$SAVED_ENV"
}
REPO_FROM_ENV="${FCC_REPO:-}"
if [ "$(id -u)" -eq 0 ]; then load_saved; fi

FCC_DIR="${FCC_DIR:-/opt/fcc}"
FCC_DATA_DIR="${FCC_DATA_DIR:-/var/lib/fcc}"
FCC_SITES_DIR="${FCC_SITES_DIR:-/srv/fcc/sites}"
FCC_PORT="${FCC_PORT:-4000}"
FCC_HOST="${FCC_HOST:-0.0.0.0}"
FCC_PANEL_DOMAIN="${FCC_PANEL_DOMAIN:-}"
FCC_EMAIL="${FCC_EMAIL:-}"
FCC_DB="${FCC_DB:-}"
FCC_MYSQL_REMOTE="${FCC_MYSQL_REMOTE:-}"
FCC_FIREWALL="${FCC_FIREWALL:-0}"
FCC_PHP="${FCC_PHP:-0}"
FCC_PHPMYADMIN="${FCC_PHPMYADMIN:-0}"
FCC_REPO="${FCC_REPO:-}"
FCC_REF="${FCC_REF:-$DEFAULT_REF}"

case "$FCC_PORT" in ''|*[!0-9]*) die "FCC_PORT must be a number (got '$FCC_PORT')." ;; esac
[ "$FCC_PORT" -ge 1 ] && [ "$FCC_PORT" -le 65535 ] || die "FCC_PORT out of range."
[[ "$FCC_REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "FCC_REF has unexpected characters: '$FCC_REF'."
[[ "$FCC_EMAIL" =~ ^[^[:space:]\"\']*$ ]] || die "FCC_EMAIL has unexpected characters."
case "$FCC_DIR" in /*) ;; *) die "FCC_DIR must be an absolute path." ;; esac
case "$FCC_DATA_DIR" in /*) ;; *) die "FCC_DATA_DIR must be an absolute path." ;; esac
case "$FCC_DIR" in /|/usr|/etc|/var|/opt|/root|/home|/srv) die "FCC_DIR=$FCC_DIR is not a safe place to install into." ;; esac
case "$FCC_DATA_DIR" in /|/usr|/etc|/var|/opt|/root|/home|/srv|/var/lib) die "FCC_DATA_DIR=$FCC_DATA_DIR is not a safe data directory." ;; esac
if [ -n "$FCC_PANEL_DOMAIN" ]; then
  [[ "$FCC_PANEL_DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$ ]] \
    || die "FCC_PANEL_DOMAIN='$FCC_PANEL_DOMAIN' does not look like a hostname."
fi

# ---------------------------------------------------------------- preflight

preflight() {
  [ "$(uname -s)" = "Linux" ] || die "This installer is for Linux servers. For development on a Mac: FCC_DRY_RUN=1 FCC_DATA_DIR=./.devdata node panel/server.mjs"
  [ "$(id -u)" -eq 0 ] || die "Run it as root:  sudo bash install.sh   (or  curl … | sudo bash)"
  if ! have systemctl || [ ! -d /run/systemd/system ]; then die "systemd is required (this does not look like a full VM or VPS)."; fi
  mkdir -p "$(dirname "$LOG_FILE")"; : >>"$LOG_FILE"; chmod 600 "$LOG_FILE"
}

check_os() {
  # shellcheck disable=SC1091
  [ -r /etc/os-release ] && . /etc/os-release
  OS_ID="${ID:-unknown}"; OS_VER="${VERSION_ID:-?}"; OS_NAME="${PRETTY_NAME:-$OS_ID $OS_VER}"
  local supported=0
  case "$OS_ID:$OS_VER" in
    ubuntu:22.04|ubuntu:24.04|debian:12) supported=1 ;;
  esac
  if [ "$supported" -eq 1 ]; then
    ok "$OS_NAME"
  elif [ "${FCC_FORCE_OS:-0}" = "1" ] && have apt-get; then
    warn "$OS_NAME is not a supported OS — continuing because FCC_FORCE_OS=1"
  else
    die "$OS_NAME is not supported. Use Ubuntu 22.04/24.04 or Debian 12 (or set FCC_FORCE_OS=1 on another apt-based system, at your own risk)."
  fi
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64|aarch64|arm64) ok "architecture $ARCH" ;;
    *) die "Architecture $ARCH is not supported (x86_64 or arm64 only)." ;;
  esac
}

# ---------------------------------------------------------------- uninstall

confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  local answer=""
  if [ -r /dev/tty ]; then
    printf '%s' "    $1 [y/N] " >/dev/tty
    read -r answer </dev/tty || true
  else
    die "$1 — re-run with --yes to confirm non-interactively."
  fi
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

uninstall() {
  printf '\n%s\n' "${B}Forthway Command Center — uninstall${N}"
  step "Stopping the panel"
  if [ -f "$UNIT_FILE" ] || systemctl list-unit-files fcc.service >/dev/null 2>&1; then
    systemctl disable --now fcc.service >/dev/null 2>&1 || true
    rm -f "$UNIT_FILE"
    systemctl daemon-reload
    ok "fcc.service stopped and removed"
  else
    ok "no fcc.service installed"
  fi

  step "Removing code from ${FCC_DIR}"
  if [ -d "$FCC_DIR" ]; then rm -rf "${FCC_DIR:?}"; ok "removed ${FCC_DIR}"; else ok "nothing there"; fi

  if [ -f "$NGINX_PANEL" ]; then
    rm -f "$NGINX_PANEL"
    ok "removed the panel's nginx vhost"
  fi

  if [ "$PURGE" -eq 1 ]; then
    step "Purging data"
    say "This deletes ${FCC_DATA_DIR} (admins, projects, settings, ${B}local backups${N}),"
    say "${ETC_DIR}, and every FCC-generated nginx site config (fcc-*.conf)."
    say "Website files in ${FCC_SITES_DIR}, pm2 processes and MySQL databases are NOT touched."
    if confirm "Delete panel data permanently?"; then
      rm -rf "${FCC_DATA_DIR:?}" "${ETC_DIR:?}"
      rm -f /etc/nginx/conf.d/fcc-*.conf "$NGINX_CATCHALL"
      ok "panel data and FCC nginx configs removed"
    else
      warn "kept the data"
    fi
  else
    say "${DIM}Kept: ${FCC_DATA_DIR} (data and backups), ${FCC_SITES_DIR}, nginx site configs, databases.${N}"
    say "${DIM}Use --uninstall --purge to delete panel data as well.${N}"
  fi

  if have nginx && nginx -t >/dev/null 2>&1; then systemctl reload nginx >/dev/null 2>&1 || true; fi
  say "${DIM}Packages (nginx, MySQL, Node, pm2, certbot) were left installed.${N}"
  printf '\n'
}

# ------------------------------------------------------------------ packages

install_base() {
  quiet "apt-get update" env DEBIAN_FRONTEND=noninteractive apt-get update -q -o DPkg::Lock::Timeout=300
  apt_install ca-certificates curl gnupg tar gzip unzip openssl iproute2 procps logrotate
  ok "base packages"
}

node_major() { have node || { echo 0; return; }; node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

install_node() {
  if [ "$(node_major)" -lt "$MIN_NODE_MAJOR" ]; then
    say "installing Node.js ${NODE_MAJOR_TO_INSTALL} from NodeSource"
    local setup
    setup="$(mktemp)"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_TO_INSTALL}.x" -o "$setup" \
      || die "Could not download the NodeSource setup script."
    quiet "NodeSource repository" bash "$setup"
    rm -f "$setup"
    apt_install nodejs
    hash -r
    [ "$(node_major)" -ge "$MIN_NODE_MAJOR" ] || die "Node ${MIN_NODE_MAJOR}+ is still missing after install. See ${LOG_FILE}."
  fi
  have npm || apt_install npm
  ok "Node $(node -v), npm $(npm -v 2>/dev/null)"
  NODE_BIN="$(command -v node)"

  if ! have pm2; then
    say "installing pm2"
    quiet "npm install -g pm2" npm install -g pm2 --no-fund --no-audit
    hash -r
  fi
  have pm2 || die "pm2 did not install. See ${LOG_FILE}."
  # Site processes run under root's pm2. pm2-root.service brings them back on boot.
  export PM2_HOME=/root/.pm2 HOME="${HOME:-/root}"
  if [ ! -f /etc/systemd/system/pm2-root.service ]; then
    quiet "pm2 startup" pm2 startup systemd -u root --hp /root
  fi
  systemctl enable pm2-root.service >/dev/null 2>&1 || true
  systemctl start pm2-root.service >/dev/null 2>&1 || true
  ok "pm2 $(pm2 -v 2>/dev/null | tail -1) (resurrects sites on boot via pm2-root.service)"
}

nginx_version_ge() { # nginx_version_ge 1.19.4
  local v
  v="$(nginx -v 2>&1 | sed -n 's|.*nginx/\([0-9.]*\).*|\1|p')"
  [ -n "$v" ] && [ "$(printf '%s\n%s\n' "$1" "$v" | sort -V | head -1)" = "$1" ]
}

install_nginx() {
  pkg_installed nginx || apt_install nginx
  # Ubuntu/Debian ship a "default" site that answers every hostname with the
  # welcome page. Replace it with a catch-all that closes the connection, so
  # only domains the panel configured are ever served.
  if [ -L /etc/nginx/sites-enabled/default ]; then
    rm -f /etc/nginx/sites-enabled/default
    say "disabled the stock default site"
  fi
  local v6=0; [ -f /proc/net/if_inet6 ] && v6=1
  {
    echo "# Managed by the Forthway Command Center installer — rewritten on every install."
    echo "# Requests for hostnames no website claims are dropped (444) instead of"
    echo "# falling through to whichever site happens to load first."
    echo "server {"
    echo "    listen 80 default_server;"
    [ "$v6" -eq 1 ] && echo "    listen [::]:80 default_server;"
    echo "    server_name _;"
    echo "    location /.well-known/acme-challenge/ { root /var/www/html; }"
    echo "    location / { return 444; }"
    echo "}"
    if nginx_version_ge 1.19.4; then
      echo "server {"
      echo "    listen 443 ssl default_server;"
      [ "$v6" -eq 1 ] && echo "    listen [::]:443 ssl default_server;"
      echo "    server_name _;"
      echo "    ssl_reject_handshake on;"
      echo "}"
    fi
  } >"${NGINX_CATCHALL}.tmp"
  mv "${NGINX_CATCHALL}.tmp" "$NGINX_CATCHALL"
  mkdir -p /var/www/html

  if ! nginx -t >>"$LOG_FILE" 2>&1; then
    warn "nginx -t failed; see ${LOG_FILE}. Leaving nginx as it was."
    rm -f "$NGINX_CATCHALL"
    nginx -t >>"$LOG_FILE" 2>&1 || die "nginx configuration is broken (not by this installer). Fix it and re-run."
  fi
  systemctl enable nginx >/dev/null 2>&1 || true
  if ! systemctl restart nginx >>"$LOG_FILE" 2>&1; then
    if have ss && ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq '[:.]80$'; then
      die "nginx could not start: something else is listening on port 80 (apache2?). Stop it and re-run."
    fi
    die "nginx could not start. See: journalctl -u nginx -n 50"
  fi
  ok "nginx $(nginx -v 2>&1 | sed -n 's|.*nginx/||p') with a catch-all for unknown hosts"
}

# Decide MySQL vs MariaDB. An existing server always wins.
pick_db() {
  if pkg_installed mariadb-server; then DB_ENGINE=mariadb
  elif pkg_installed mysql-server || pkg_installed mysql-server-8.0 || pkg_installed mysql-community-server; then DB_ENGINE=mysql
  else
    case "${FCC_DB:-mysql}" in
      mariadb) DB_ENGINE=mariadb ;;
      mysql)
        if apt-cache show mysql-server >/dev/null 2>&1; then DB_ENGINE=mysql
        elif [ -n "$FCC_DB" ]; then
          die "This OS has no mysql-server package. Use FCC_DB=mariadb, or add Oracle's MySQL APT repository first."
        else
          DB_ENGINE=mariadb
          warn "no mysql-server package on ${OS_NAME:-this OS}; using MariaDB (MySQL-compatible)"
        fi ;;
      *) die "FCC_DB must be mysql or mariadb (got '$FCC_DB')." ;;
    esac
  fi
  if [ -n "$FCC_DB" ] && [ "$FCC_DB" != "$DB_ENGINE" ]; then
    warn "FCC_DB=$FCC_DB requested, but ${DB_ENGINE} is already installed — keeping ${DB_ENGINE}"
  fi
}

install_db() {
  pick_db
  local svc conf
  if [ "$DB_ENGINE" = "mariadb" ]; then
    pkg_installed mariadb-server || apt_install mariadb-server mariadb-client
    svc=mariadb; conf=/etc/mysql/mariadb.conf.d/99-fcc.cnf
  else
    pkg_installed mysql-server || apt_install mysql-server mysql-client
    svc=mysql; conf=/etc/mysql/mysql.conf.d/zz-fcc.cnf
  fi
  DB_SERVICE="$svc"
  mkdir -p "$(dirname "$conf")"

  # Remote access is sticky: an earlier FCC_MYSQL_REMOTE=1 is kept until you
  # say FCC_MYSQL_REMOTE=0, so a plain re-run never cuts agent servers off.
  if [ -z "$FCC_MYSQL_REMOTE" ]; then
    if [ -f "$conf" ] && grep -q '^bind-address *= *0\.0\.0\.0' "$conf"; then FCC_MYSQL_REMOTE=1; else FCC_MYSQL_REMOTE=0; fi
  fi
  local bind=127.0.0.1; [ "$FCC_MYSQL_REMOTE" = "1" ] && bind=0.0.0.0
  {
    echo "# Managed by the Forthway Command Center installer."
    echo "# FCC_MYSQL_REMOTE=1 → 0.0.0.0 (agent servers connect); otherwise local only."
    echo "[mysqld]"
    echo "bind-address = ${bind}"
    [ "$DB_ENGINE" = "mysql" ] && echo "mysqlx-bind-address = 127.0.0.1"
  } >"${conf}.new"
  local changed=1
  if [ -f "$conf" ] && cmp -s "$conf" "${conf}.new"; then changed=0; fi
  mv "${conf}.new" "$conf"; chmod 644 "$conf"

  systemctl enable "$svc" >/dev/null 2>&1 || true
  if [ "$changed" -eq 1 ]; then
    quiet "restart $svc" systemctl restart "$svc"
  else
    quiet "start $svc" systemctl start "$svc"
  fi

  # Baseline: no anonymous users, no root login from anywhere but this box,
  # no "test" database. Root keeps socket auth, which is how the panel
  # (running as root) talks to it — no password is stored anywhere.
  if mysql -NBe 'SELECT 1' >/dev/null 2>&1; then
    local u
    while IFS= read -r u; do
      [ -n "$u" ] && mysql -e "DROP USER IF EXISTS ${u}" >>"$LOG_FILE" 2>&1 || true
    done < <(mysql -NBe "SELECT CONCAT(QUOTE(User),'@',QUOTE(Host)) FROM mysql.user WHERE User='' OR (User='root' AND Host NOT IN ('localhost','127.0.0.1','::1'))" 2>/dev/null || true)
    mysql -e "DROP DATABASE IF EXISTS test; DELETE FROM mysql.db WHERE Db='test' OR Db='test\\_%'; FLUSH PRIVILEGES;" >>"$LOG_FILE" 2>&1 || true
    ok "${DB_ENGINE} $(mysql -NBe 'SELECT VERSION()' 2>/dev/null) — root via socket, no remote root, no anonymous users"
  else
    warn "${DB_ENGINE} is running but root cannot log in over the socket (a root password was set)."
    say  "${DIM}Give the panel the root password later under Databases → MySQL server.${N}"
  fi
  if [ "$bind" = "0.0.0.0" ]; then
    ok "listening on 0.0.0.0:3306 for agent servers (users are granted per host, never %)"
  else
    ok "listening on 127.0.0.1 only ${DIM}(FCC_MYSQL_REMOTE=1 to let agent servers connect)${N}"
  fi
}

install_certbot() {
  if ! pkg_installed certbot || ! pkg_installed python3-certbot-nginx; then apt_install certbot python3-certbot-nginx; fi
  ok "certbot $(certbot --version 2>&1 | awk '{print $2}')"
}

install_php() {
  [ "$FCC_PHP" = "1" ] || [ "$FCC_PHPMYADMIN" = "1" ] || return 0
  apt_install php-fpm php-cli php-mysql php-curl php-mbstring php-xml php-zip php-gd php-intl
  local fpm
  fpm="$(systemctl list-unit-files 'php*-fpm.service' --no-legend 2>/dev/null | awk '{print $1}' | sort -V | tail -1)"
  if [ -n "$fpm" ]; then systemctl enable --now "$fpm" >/dev/null 2>&1 || true; fi
  ok "PHP $(php -r 'echo PHP_VERSION;' 2>/dev/null) with ${fpm:-php-fpm}"
}

ssh_port() {
  local p=""
  have sshd && p="$(sshd -T 2>/dev/null | awk '$1=="port"{print $2; exit}')"
  echo "${p:-22}"
}

setup_firewall() {
  local active=0
  have ufw && ufw status 2>/dev/null | head -1 | grep -qi 'status: active' && active=1
  if [ "$FCC_FIREWALL" != "1" ] && [ "$active" -eq 0 ]; then
    say "${DIM}skipped (set FCC_FIREWALL=1 to enable ufw)${N}"
    return 0
  fi
  pkg_installed ufw || apt_install ufw
  local sp; sp="$(ssh_port)"
  # SSH first, always — enabling a firewall without it locks you out.
  ufw allow "${sp}/tcp" comment 'SSH' >/dev/null
  [ "$sp" != "22" ] && ufw allow 22/tcp comment 'SSH' >/dev/null
  ufw allow 80/tcp comment 'FCC nginx http' >/dev/null
  ufw allow 443/tcp comment 'FCC nginx https' >/dev/null
  ufw allow "${FCC_PORT}/tcp" comment 'FCC panel' >/dev/null
  if [ "$FCC_PHPMYADMIN" = "1" ]; then ufw allow 8081/tcp comment 'FCC phpMyAdmin' >/dev/null; fi
  if [ "$active" -eq 0 ]; then
    ufw --force enable >/dev/null
    ok "ufw enabled: SSH (${sp}), 80, 443, ${FCC_PORT}"
  else
    ok "ufw already active: allowed SSH (${sp}), 80, 443, ${FCC_PORT}"
  fi
  if [ "$FCC_MYSQL_REMOTE" = "1" ]; then
    warn "MySQL (3306) is NOT opened to the world. For each agent server run:"
    say  "    ufw allow from <agent-ip> to any port 3306 proto tcp"
  fi
}

# --------------------------------------------------------------------- source

SRC=""; SRC_TMP=""; SRC_COMMIT=""; SRC_FROM=""
cleanup() { [ -n "$SRC_TMP" ] && rm -rf "$SRC_TMP"; return 0; }
trap cleanup EXIT

is_source() { [ -f "$1/panel/server.mjs" ] && [ -d "$1/shared" ]; }

# Where the code comes from:
#   FCC_REPO given on the command line      → GitHub
#   run from a checkout (not FCC_DIR itself) → that checkout
#   otherwise (curl | bash, or re-running /opt/fcc/install.sh to update)
#                                            → GitHub: the remembered repo, or the default
find_source() {
  if [ -z "$REPO_FROM_ENV" ]; then
    local here="" c installed
    installed="$(cd "$FCC_DIR" 2>/dev/null && pwd -P || echo "$FCC_DIR")"
    if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
      here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
    fi
    for c in "$here" "$(pwd -P)"; do
      if [ -n "$c" ] && [ "$c" != "$installed" ] && is_source "$c"; then SRC="$c"; break; fi
    done
  fi
  if [ -n "$SRC" ]; then
    SRC_FROM="local folder ${SRC}"
    if have git && [ -d "$SRC/.git" ]; then SRC_COMMIT="$(git -C "$SRC" rev-parse HEAD 2>/dev/null || true)"; fi
    ok "using ${SRC_FROM}"
    return 0
  fi

  local repo="${FCC_REPO:-$DEFAULT_REPO}"
  [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "FCC_REPO must look like owner/repo (got '$repo')."
  local auth=()
  [ -n "${FCC_GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer ${FCC_GITHUB_TOKEN}")
  say "downloading ${repo}@${FCC_REF}"
  SRC_TMP="$(mktemp -d)"
  curl -fsSL ${auth[@]+"${auth[@]}"} "https://codeload.github.com/${repo}/tar.gz/${FCC_REF}" -o "$SRC_TMP/src.tar.gz" \
    || die "Could not download ${repo}@${FCC_REF}. Private repository? Set FCC_GITHUB_TOKEN."
  tar -xzf "$SRC_TMP/src.tar.gz" -C "$SRC_TMP"
  local server
  server="$(find "$SRC_TMP" -mindepth 3 -maxdepth 3 -type f -path '*/panel/server.mjs' | head -1)"
  [ -n "$server" ] || die "${repo}@${FCC_REF} does not contain panel/server.mjs — is that the Standalone branch?"
  SRC="$(cd "$(dirname "$server")/.." && pwd)"
  is_source "$SRC" || die "That archive does not look like the Command Center."
  SRC_COMMIT="$(curl -fsS ${auth[@]+"${auth[@]}"} -H 'Accept: application/vnd.github.sha' \
    "https://api.github.com/repos/${repo}/commits/${FCC_REF}" 2>/dev/null | head -c 40 || true)"
  [[ "$SRC_COMMIT" =~ ^[0-9a-f]{40}$ ]] || SRC_COMMIT=""
  FCC_REPO="$repo"
  SRC_FROM="github ${repo}@${FCC_REF}${SRC_COMMIT:+ (${SRC_COMMIT:0:7})}"
  ok "downloaded ${SRC_FROM}"
}

# What gets copied into FCC_DIR. Everything else in the repo (hub/, agent/,
# docs, dev data) stays behind.
CODE_ITEMS=(panel node shared scripts patches README.md install.sh LICENSE)

install_code() {
  mkdir -p "$FCC_DIR"
  local same=0
  [ "$(cd "$SRC" && pwd -P)" = "$(cd "$FCC_DIR" && pwd -P)" ] && same=1

  if [ "$same" -eq 1 ]; then
    ok "running from ${FCC_DIR} itself — code is already in place"
  else
    # Stage next to the live copy, sanity-check, then swap item by item, so a
    # broken download never replaces a working install.
    local stage="${FCC_DIR}/.staging.$$" item
    rm -rf "$stage"; mkdir -p "$stage"
    for item in "${CODE_ITEMS[@]}"; do
      if [ -e "$SRC/$item" ]; then cp -R "$SRC/$item" "$stage/$item"; fi
    done
    find "$stage" \( -name '.DS_Store' -o -name '.devdata' \) -prune -exec rm -rf {} + 2>/dev/null || true
    if ! node --check "$stage/panel/server.mjs" >>"$LOG_FILE" 2>&1; then
      rm -rf "$stage"
      die "panel/server.mjs in the new source does not parse. Nothing was changed. See ${LOG_FILE}."
    fi
    for item in "${CODE_ITEMS[@]}"; do
      if [ -e "$stage/$item" ]; then
        rm -rf "${FCC_DIR:?}/${item}"
        mv "$stage/$item" "$FCC_DIR/$item"
      fi
    done
    rm -rf "$stage"
    ok "code in ${FCC_DIR}"
  fi

  chmod 755 "$FCC_DIR"
  chmod +x "$FCC_DIR/install.sh" 2>/dev/null || true

  # Identity of what is installed, for the panel's own update check.
  local ver
  ver="$(grep -Eio 'version[a-z_]* *[:=] *"[0-9]+\.[0-9]+\.[0-9]+[^"]*"' "$FCC_DIR/panel/server.mjs" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
  cat >"$FCC_DIR/version.json" <<JSON
{
  "version": "${ver:-${FCC_VERSION_LINE}}",
  "repo": "${FCC_REPO:-}",
  "ref": "${FCC_REF}",
  "commit": "${SRC_COMMIT}",
  "source": "$( [ -n "$SRC_TMP" ] && echo github || echo local )",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

  # Data: created once, never overwritten. Root only — it holds the panel's
  # encryption key, session secret and database credentials.
  mkdir -p "$FCC_DATA_DIR"
  chmod 700 "$FCC_DATA_DIR"
  chown root:root "$FCC_DATA_DIR"
  mkdir -p "$FCC_SITES_DIR"
  chmod 755 "$FCC_SITES_DIR" "$(dirname "$FCC_SITES_DIR")" 2>/dev/null || true
  ok "data in ${FCC_DATA_DIR} (700), websites in ${FCC_SITES_DIR}"
}

save_answers() {
  FCC_DB="${DB_ENGINE:-$FCC_DB}"   # record what is actually installed
  mkdir -p "$ETC_DIR"; chmod 755 "$ETC_DIR"
  {
    echo "# Written by install.sh — the choices a plain re-run reuses. Environment variables override."
    local k
    for k in FCC_DIR FCC_DATA_DIR FCC_SITES_DIR FCC_PORT FCC_HOST FCC_PANEL_DOMAIN FCC_EMAIL FCC_DB FCC_MYSQL_REMOTE FCC_FIREWALL FCC_PHP FCC_PHPMYADMIN FCC_REPO FCC_REF; do
      printf '%s=%s\n' "$k" "${!k:-}"
    done
  } >"${SAVED_ENV}.tmp"
  mv "${SAVED_ENV}.tmp" "$SAVED_ENV"; chmod 600 "$SAVED_ENV"
  if [ ! -f "$USER_ENV" ]; then
    cat >"$USER_ENV" <<'ENV'
# Extra environment for fcc.service. Never touched by install.sh after creation.
# Edit, then: systemctl restart fcc
#
# FCC_TRUST_PROXY=1
ENV
    chmod 600 "$USER_ENV"
  fi
}

# -------------------------------------------------------------------- service

panel_url() {
  if [ -n "$FCC_PANEL_DOMAIN" ]; then
    if [ -f "/etc/letsencrypt/live/${FCC_PANEL_DOMAIN}/fullchain.pem" ]; then echo "https://${FCC_PANEL_DOMAIN}"
    else echo "http://${FCC_PANEL_DOMAIN}"; fi
  fi
}

write_unit() {
  local url; url="$(panel_url)"
  cat >"${UNIT_FILE}.tmp" <<UNIT
# Managed by the Forthway Command Center installer — rewritten on every install.
# Put your own additions in ${USER_ENV} (or: systemctl edit fcc).
[Unit]
Description=Forthway Command Center
Documentation=https://github.com/${FCC_REPO:-$DEFAULT_REPO}
After=network-online.target nginx.service ${DB_SERVICE:-mysql}.service pm2-root.service
Wants=network-online.target pm2-root.service

[Service]
Type=simple
User=root
WorkingDirectory=${FCC_DIR}
Environment=NODE_ENV=production
Environment=FCC_DIR=${FCC_DIR}
Environment=FCC_DATA_DIR=${FCC_DATA_DIR}
Environment=FCC_SITES_DIR=${FCC_SITES_DIR}
Environment=FCC_PORT=${FCC_PORT}
Environment=FCC_HOST=${FCC_HOST}
${url:+Environment=FCC_PANEL_URL=${url}
}${FCC_PANEL_DOMAIN:+Environment=FCC_TRUST_PROXY=1
}Environment=HOME=/root
Environment=PM2_HOME=/root/.pm2
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=-${USER_ENV}
ExecStart=${NODE_BIN} ${FCC_DIR}/panel/server.mjs
Restart=always
RestartSec=3
# Only the panel process is stopped on restart. Anything it started that
# outlives it (a pm2 daemon spawned on first use, a running backup) is left
# alone, so restarting the panel never takes websites down.
KillMode=process
TimeoutStopSec=20
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT
  mv "${UNIT_FILE}.tmp" "$UNIT_FILE"
  chmod 644 "$UNIT_FILE"
  systemctl daemon-reload
  systemctl enable fcc.service >/dev/null 2>&1
  ok "fcc.service written and enabled"
}

port_holder() { have ss && ss -ltnpH "sport = :$1" 2>/dev/null | sed -n 's/.*users:((\("[^"]*"\).*/\1/p' | head -1; }

start_panel() {
  if [ "${FCC_NO_START:-0}" = "1" ]; then
    warn "not starting (FCC_NO_START=1). Start it with: systemctl start fcc"
    return 0
  fi
  systemctl stop fcc.service >/dev/null 2>&1 || true
  local holder; holder="$(port_holder "$FCC_PORT")"
  if [ -n "$holder" ]; then
    warn "port ${FCC_PORT} is already in use by ${holder}."
    if PM2_HOME=/root/.pm2 pm2 describe forthway >/dev/null 2>&1; then
      say "the v2 Command Center is still running under pm2 as \"forthway\". Remove it with: pm2 delete forthway && pm2 save"
    fi
    die "Free port ${FCC_PORT} or choose another with FCC_PORT=…, then re-run."
  fi
  if ! systemctl start fcc.service; then
    journalctl -u fcc.service -n 30 --no-pager 2>/dev/null | sed 's/^/      /' || true
    die "fcc.service failed to start. Check: journalctl -u fcc -f"
  fi

  local probe_host="$FCC_HOST" up=0 i
  case "$probe_host" in 0.0.0.0|::|'') probe_host=127.0.0.1 ;; esac
  for i in $(seq 1 60); do
    if curl -fsS --max-time 2 "http://${probe_host}:${FCC_PORT}/healthz" >/dev/null 2>&1; then up=1; break; fi
    if [ "$i" -gt 6 ] && ! systemctl is-active --quiet fcc.service; then break; fi
    sleep 0.5
  done
  if [ "$up" -ne 1 ]; then
    warn "the panel did not answer on port ${FCC_PORT}. Last log lines:"
    journalctl -u fcc.service -n 30 --no-pager 2>/dev/null | sed 's/^/      /' || true
    die "fcc.service is not healthy. Check: journalctl -u fcc -f"
  fi
  SETUP_STATE="$(curl -fsS --max-time 2 "http://${probe_host}:${FCC_PORT}/api/setup" 2>/dev/null || true)"
  ok "panel answering on ${probe_host}:${FCC_PORT}"
}

# ------------------------------------------------------------ panel vhost/TLS

write_panel_vhost() { # $1 = with_tls (0/1)
  local tls="$1" v6=0 d="$FCC_PANEL_DOMAIN" up="127.0.0.1"
  [ -f /proc/net/if_inet6 ] && v6=1
  case "$FCC_HOST" in 0.0.0.0|::|127.0.0.1|'') ;; *) up="$FCC_HOST" ;; esac
  local L80="    listen 80;" L443="    listen 443 ssl http2;"
  [ "$v6" -eq 1 ] && L80="${L80}
    listen [::]:80;" && L443="${L443}
    listen [::]:443 ssl http2;"
  local proxy
  proxy="    client_max_body_size 600m;   # release zips are up to 500 MB

    location / {
        proxy_pass http://fcc_panel_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$fcc_panel_connection;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_request_buffering off;
    }

    # Server-sent events: no buffering, no gzip, long-lived.
    location = /api/events {
        proxy_pass http://fcc_panel_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection \"\";
        proxy_buffering off;
        proxy_cache off;
        gzip off;
        proxy_read_timeout 24h;
    }"
  {
    cat <<CONF
# Managed by the Forthway Command Center installer — rewritten on every install.
# The panel itself at ${d}. Website vhosts live in fcc-<siteId>.conf.
map \$http_upgrade \$fcc_panel_connection { default upgrade; '' ''; }

upstream fcc_panel_upstream {
    server ${up}:${FCC_PORT};
    keepalive 8;
}

CONF
    if [ "$tls" -eq 1 ]; then
      cat <<CONF
server {
${L80}
    server_name ${d};
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
${L443}
    server_name ${d};
    ssl_certificate /etc/letsencrypt/live/${d}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${d}/privkey.pem;
CONF
      [ -f /etc/letsencrypt/options-ssl-nginx.conf ] && echo "    include /etc/letsencrypt/options-ssl-nginx.conf;"
      [ -f /etc/letsencrypt/ssl-dhparams.pem ] && echo "    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"
      echo "    add_header Strict-Transport-Security \"max-age=31536000\" always;"
      echo ""
      echo "$proxy"
      echo "}"
    else
      cat <<CONF
server {
${L80}
    server_name ${d};
    location /.well-known/acme-challenge/ { root /var/www/html; }

CONF
      echo "$proxy"
      echo "}"
    fi
  } >"${NGINX_PANEL}.tmp"
  mv "${NGINX_PANEL}.tmp" "$NGINX_PANEL"
  if ! nginx -t >>"$LOG_FILE" 2>&1; then
    rm -f "$NGINX_PANEL"
    nginx -t >>"$LOG_FILE" 2>&1 || true
    die "the panel's nginx vhost failed nginx -t; removed it. See ${LOG_FILE}."
  fi
  systemctl reload nginx
}

setup_panel_domain() {
  if [ -z "$FCC_PANEL_DOMAIN" ]; then
    if [ -f "$NGINX_PANEL" ]; then rm -f "$NGINX_PANEL"; nginx -t >/dev/null 2>&1 && systemctl reload nginx; fi
    say "${DIM}skipped (set FCC_PANEL_DOMAIN=panel.example.com to serve the panel over HTTPS)${N}"
    return 0
  fi
  local d="$FCC_PANEL_DOMAIN" live="/etc/letsencrypt/live/${FCC_PANEL_DOMAIN}/fullchain.pem"
  if [ -f "$live" ]; then
    write_panel_vhost 1
    ok "https://${d} → panel (existing certificate; renewed by certbot.timer)"
    return 0
  fi
  write_panel_vhost 0
  ok "http://${d} → panel"
  # certonly + our own vhost (rather than letting certbot edit it), so re-runs
  # can rewrite the file without losing the TLS lines.
  local email_args=(--register-unsafely-without-email)
  [ -n "$FCC_EMAIL" ] && email_args=(-m "$FCC_EMAIL")
  if certbot certonly --nginx -d "$d" --non-interactive --agree-tos "${email_args[@]}" \
       --deploy-hook "systemctl reload nginx" >>"$LOG_FILE" 2>&1; then
    write_panel_vhost 1
    ok "certificate issued — https://${d}"
  else
    warn "certbot could not get a certificate for ${d} (DNS not pointing here yet? port 80 blocked?)."
    say  "the panel is reachable on http://${d} for now. Fix DNS, then re-run this installer."
    tail -n 8 "$LOG_FILE" | sed 's/^/      /'
  fi
}

# --------------------------------------------------------------------- summary

public_ip() {
  local ip=""
  [ -n "${FCC_PUBLIC_IP:-}" ] && { echo "$FCC_PUBLIC_IP"; return; }
  ip="$(curl -fsS4 --max-time 4 https://api.ipify.org 2>/dev/null || true)"
  [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || ip="$(curl -fsS4 --max-time 4 https://ifconfig.me 2>/dev/null || true)"
  [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"
  echo "$ip"
}

summary() {
  printf '\n%s\n' "${B}${G}  Forthway Command Center is ${UPDATED_WORD}.${N}"
  if [ "${FCC_NO_START:-0}" = "1" ]; then printf '\n'; return 0; fi
  local url ip
  url="$(panel_url)"
  ip="$(public_ip)"
  printf '\n%s\n' "  Open it:"
  [ -n "$url" ] && printf '%s\n' "    ${B}${url}${N}"
  if [ "$FCC_HOST" != "127.0.0.1" ]; then
    [ -n "$ip" ] && printf '%s\n' "    ${B}http://${ip}:${FCC_PORT}${N}$([ -n "$url" ] && echo "${DIM}   (direct)${N}")"
  fi
  printf '%s\n' "    ${DIM}http://127.0.0.1:${FCC_PORT}   (from this machine / an SSH tunnel)${N}"

  case "${SETUP_STATE:-}" in
    *'"needsSetup":false'*) ;;
    *) printf '\n%s\n' "  ${B}Next:${N} open that address and create the first admin account on the setup page."
       printf '%s\n'   "  ${DIM}Do it now — until an admin exists, whoever opens the page first claims the panel.${N}" ;;
  esac
  if [ -z "$url" ] || [ "${url#https}" = "$url" ]; then
    printf '\n%s\n' "  ${Y}!${N} The panel is on plain HTTP. Re-run with FCC_PANEL_DOMAIN=panel.example.com FCC_EMAIL=you@… for HTTPS."
  fi
  printf '\n%s\n' "  ${DIM}Service:  systemctl status fcc   ·   journalctl -u fcc -f   ·   systemctl restart fcc${N}"
  printf '%s\n'   "  ${DIM}Code ${FCC_DIR}  ·  data ${FCC_DATA_DIR}  ·  sites ${FCC_SITES_DIR}  ·  log ${LOG_FILE}${N}"
  printf '%s\n\n' "  ${DIM}Update: re-run this installer. Remove: bash ${FCC_DIR}/install.sh --uninstall${N}"
}

# ------------------------------------------------------------------------ main

preflight

if [ "$MODE" = "uninstall" ]; then
  uninstall
  exit 0
fi

UPDATED_WORD="installed"
[ -f "$FCC_DIR/panel/server.mjs" ] && UPDATED_WORD="updated"
printf '\n%s\n' "${B}Forthway Command Center — Standalone installer${N}"
printf '%s\n' "${DIM}  code ${FCC_DIR}  ·  data ${FCC_DATA_DIR}  ·  port ${FCC_PORT}${FCC_PANEL_DOMAIN:+  ·  ${FCC_PANEL_DOMAIN}}  ·  log ${LOG_FILE}${N}"
printf '\n=== %s install.sh run ===\n' "$(date -u +%FT%TZ)" >>"$LOG_FILE"

step "Checking this machine";        check_os
step "Base packages";                install_base
step "Node.js and pm2";              install_node
step "Fetching the Command Center";  find_source
step "nginx";                        install_nginx
step "Database server";              install_db
step "certbot";                      install_certbot
if [ "$FCC_PHP" = "1" ] || [ "$FCC_PHPMYADMIN" = "1" ]; then step "PHP"; install_php; fi
step "Firewall";                     setup_firewall
step "Installing files";             install_code
save_answers
step "Panel domain";                 setup_panel_domain
step "Service";                      write_unit; start_panel
summary
