/**
 * DATA — phpMyAdmin on the main server, with single sign-on from the panel.
 *
 * Layout (production; under FCC_DRY_RUN everything lives in dataDir/phpmyadmin
 * and nothing on the machine is touched):
 *   <FCC_DIR>/phpmyadmin/            (default /opt/fcc/phpmyadmin — install.sh never replaces it)
 *     app/                           the official release (files.phpmyadmin.net, sha256-verified)
 *     app/config.inc.php             generated, 0640 root:fcc-pma (auth_type "signon")
 *     app/fcc-signon.php             generated sign-on script
 *     fcc.php                        generated secrets, outside the web root, 0640 root:fcc-pma
 *     sessions/ tmp/                 0700 fcc-pma
 *   /etc/php/<v>/fpm/pool.d/fcc-phpmyadmin.conf   own php-fpm pool running as the system user
 *                                  fcc-pma (so PHP websites in the "www" pool can't read its
 *                                  secrets or sign-on sessions), socket /run/php/fcc-phpmyadmin.sock
 *   /etc/nginx/conf.d/fcc-phpmyadmin.conf         vhost on a separate port (default 8081),
 *                                  HTTPS when a Let's Encrypt certificate exists for the hostname
 *
 * Sign-on: POST /api/databases/:id/phpmyadmin (admin) → one-time URL
 *   <pma>/fcc-signon.php?token=<64 hex>, valid 60 s. The script POSTs the token to
 *   the panel over loopback (/internal/pma/redeem, with a shared secret header);
 *   the panel answers once with that database's own login, which the script puts
 *   into phpMyAdmin's signon session. The browser never sees the password, and the
 *   database user's grants limit phpMyAdmin to that one database.
 *
 * There is no "admin" (root) sign-in: root uses socket auth, which phpMyAdmin
 * (running as fcc-pma) cannot use, and a standing all-privileges MySQL account
 * with a password in a PHP session is not worth the risk.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";

import { httpError } from "./http.mjs";
import { run, which, DRY_RUN } from "./sys.mjs";
import { requestHost } from "./auth.mjs";
import { applyNginxFile, nginxConfDir, phpFpmSocket } from "../../shared/tasks.mjs";

const FILES_BASE = "https://files.phpmyadmin.net/phpMyAdmin";
const VERSION_URL = "https://www.phpmyadmin.net/home_page/version.json";
const FALLBACK_VERSION = "5.2.3";
const POOL = "fcc-phpmyadmin";
const SOCKET = "/run/php/fcc-phpmyadmin.sock";
const SYS_USER = "fcc-pma";
const NGINX_FILE = "fcc-phpmyadmin.conf";
const SIGNON_SESSION = "FCCSignonSession";
const TOKEN_TTL_MS = 60_000;
const MAX_TOKENS = 200;
const MAX_TARBALL = 200 * 1024 * 1024;
const DEFAULT_PORT = 8081;
const PACKAGES = ["php-fpm", "php-mysql", "php-mbstring", "php-xml", "php-zip", "php-gd", "php-curl", "php-intl"];
const RESERVED_PORTS = new Set([22, 25, 53, 80, 443, 3306, 33060]);

// ------------------------------------------------------------ pure helpers

export function validVersion(v) {
  return typeof v === "string" && /^\d{1,2}\.\d{1,2}\.\d{1,3}$/.test(v);
}

export function tarballName(v) {
  if (!validVersion(v)) throw new Error(`Invalid phpMyAdmin version: ${v}`);
  return `phpMyAdmin-${v}-all-languages.tar.gz`;
}

export function tarballUrl(v) {
  return `${FILES_BASE}/${v}/${tarballName(v)}`;
}

/** "<hex>  <file>" (or just "<hex>") → lower-case hex, checked against the file name when present. */
export function parseSha256File(text, filename) {
  const m = /^\s*([a-fA-F0-9]{64})(?:\s+\*?(\S+))?/.exec(String(text || ""));
  if (!m) return null;
  if (m[2] && filename && path.basename(m[2]) !== filename) return null;
  return m[1].toLowerCase();
}

export function validHostname(h) {
  if (typeof h !== "string" || !h || h.length > 253) return false;
  if (net.isIP(h)) return true;
  return /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(h);
}

/** PHP single-quoted string literal. */
export function phpStr(s) {
  return `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

const randomAlnum = (len) => {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  while (out.length < len) for (const b of crypto.randomBytes(len * 2)) if (b < 248 && out.length < len) out += A[b % 62];
  return out;
};

const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const urlHost = (h) => (net.isIPv6(h) ? `[${h}]` : h);

const isLoopbackAddr = (a) => {
  const s = String(a || "").replace(/^::ffff:/i, "");
  return s === "::1" || /^127\./.test(s);
};

export function renderFccPhp({ secret, blowfish, redeemUrl, panelUrl }) {
  return [
    "<?php",
    "// Managed by Forthway Command Center. Private (0640 root:fcc-pma): phpMyAdmin single sign-on secrets.",
    "// Regenerated by the panel; edits are overwritten.",
    "return [",
    `    'secret' => ${phpStr(secret)},`,
    `    'blowfish' => ${phpStr(blowfish)},`,
    `    'redeem_url' => ${phpStr(redeemUrl)},`,
    `    'panel_url' => ${phpStr(panelUrl || "")},`,
    "];",
    "",
  ].join("\n");
}

export function renderConfigInc({ base, mysqlPort = 3306 }) {
  return String.raw`<?php
// Managed by Forthway Command Center — regenerated on every install/update. Do not edit.
declare(strict_types=1);

$fcc = require dirname(__DIR__) . '/fcc.php';
$secure = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';

$cfg['blowfish_secret'] = $fcc['blowfish'];

$i = 1;
$cfg['Servers'][$i]['auth_type'] = 'signon';
$cfg['Servers'][$i]['SignonSession'] = '${SIGNON_SESSION}';
$cfg['Servers'][$i]['SignonCookieParams'] = ['lifetime' => 0, 'path' => '/', 'domain' => '', 'secure' => $secure, 'httponly' => true, 'samesite' => 'Lax'];
$cfg['Servers'][$i]['SignonURL'] = 'fcc-signon.php';
$cfg['Servers'][$i]['LogoutURL'] = 'fcc-signon.php?logout=1';
$cfg['Servers'][$i]['host'] = '127.0.0.1';
$cfg['Servers'][$i]['port'] = '${Number(mysqlPort) || 3306}';
$cfg['Servers'][$i]['connect_type'] = 'tcp';
$cfg['Servers'][$i]['compress'] = false;
$cfg['Servers'][$i]['AllowRoot'] = false;
$cfg['Servers'][$i]['AllowNoPassword'] = false;
$cfg['Servers'][$i]['hide_db'] = '^(information_schema|performance_schema|mysql|sys)$';

$cfg['ServerDefault'] = 1;
$cfg['AllowArbitraryServer'] = false;
$cfg['TempDir'] = ${phpStr(path.join(base, "tmp"))};
$cfg['UploadDir'] = '';
$cfg['SaveDir'] = '';
$cfg['VersionCheck'] = false;
$cfg['SendErrorReports'] = 'never';
$cfg['ShowPhpInfo'] = false;
// The panel stores each database's password; changing it here would break linked websites.
$cfg['ShowChgPassword'] = false;
$cfg['ShowCreateDb'] = false;
$cfg['LoginCookieValidity'] = 3600;
$cfg['ExecTimeLimit'] = 600;
$cfg['PmaNoRelation_DisableWarning'] = true;
$cfg['AllowThirdPartyFraming'] = false;
`;
}

export function renderSignon() {
  return String.raw`<?php
// Managed by Forthway Command Center: phpMyAdmin single sign-on. Regenerated on install/update.
// Exchanges a one-time token from the panel (over loopback) for one database's login and
// hands it to phpMyAdmin's "signon" authentication. Secrets live in ../fcc.php.
declare(strict_types=1);

$fcc = require dirname(__DIR__) . '/fcc.php';
header('Cache-Control: no-store');
header('Referrer-Policy: no-referrer');
header('X-Robots-Tag: noindex, nofollow');
header('X-Frame-Options: DENY');

$secure = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => $secure, 'httponly' => true, 'samesite' => 'Lax']);
session_name('${SIGNON_SESSION}');
session_start();

function fcc_page(int $code, string $title, string $text, string $panel): void
{
    http_response_code($code);
    header('Content-Type: text/html; charset=utf-8');
    $e = static function (string $s): string {
        return htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
    };
    echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
        '<title>', $e($title), '</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1020;color:#e6e9f5;',
        'font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:460px;margin:16px;padding:28px 30px;background:#131a33;',
        'border:1px solid #232c4d;border-radius:14px}h1{font-size:19px;margin:0 0 8px}p{margin:0 0 14px;color:#b7bfdc}a{color:#8fb0ff}</style></head>',
        '<body><main><h1>', $e($title), '</h1><p>', $e($text), '</p>',
        $panel !== '' ? '<p><a href="' . $e($panel) . '">Go to the panel</a></p>' : '',
        '</main><!-- FCC-PMA-SIGNON --></body></html>';
    exit;
}

$panel = (string)($fcc['panel_url'] ?? '');

if (isset($_GET['logout'])) {
    $_SESSION = [];
    session_destroy();
    fcc_page(200, 'Signed out of phpMyAdmin', 'To open a database again, choose "Open in phpMyAdmin" in the Forthway Command Center.', $panel);
}

$token = isset($_GET['token']) && is_string($_GET['token']) ? $_GET['token'] : '';
if (preg_match('/^[a-f0-9]{64}$/', $token) !== 1) {
    fcc_page(401, 'Sign in from the panel', 'phpMyAdmin opens from the Forthway Command Center: pick a database and choose "Open in phpMyAdmin".', $panel);
}

$context = stream_context_create([
    'http' => [
        'method' => 'POST',
        'header' => "Content-Type: application/json\r\nX-FCC-PMA-Secret: " . $fcc['secret'] . "\r\n",
        'content' => json_encode(['token' => $token]),
        'timeout' => 10,
        'ignore_errors' => true,
        'follow_location' => 0,
    ],
    // Loopback to the panel itself (its certificate is for the public name, if any).
    'ssl' => ['verify_peer' => false, 'verify_peer_name' => false],
]);
$raw = @file_get_contents((string)$fcc['redeem_url'], false, $context);
$headers = function_exists('http_get_last_response_headers') ? (http_get_last_response_headers() ?? []) : ($http_response_header ?? []);
$status = 0;
if (isset($headers[0]) && preg_match('#^HTTP/\S+\s+(\d{3})#', (string)$headers[0], $m) === 1) {
    $status = (int)$m[1];
}
$data = is_string($raw) ? json_decode($raw, true) : null;
if ($status !== 200 || !is_array($data) || !isset($data['user'], $data['password'], $data['db'])) {
    fcc_page(403, 'This link has expired', 'Sign-in links work once, for 60 seconds. Go back to the panel and choose "Open in phpMyAdmin" again.', $panel);
}

session_regenerate_id(true);
$_SESSION['PMA_single_signon_user'] = (string)$data['user'];
$_SESSION['PMA_single_signon_password'] = (string)$data['password'];
$_SESSION['PMA_single_signon_host'] = (string)($data['host'] ?? '127.0.0.1');
$_SESSION['PMA_single_signon_port'] = (string)($data['port'] ?? '3306');
session_write_close();

// Drop phpMyAdmin's own session so it doesn't keep a previous database's login.
foreach (['phpMyAdmin', 'phpMyAdmin_https'] as $cookie) {
    setcookie($cookie, '', ['expires' => time() - 3600, 'path' => '/', 'secure' => $secure, 'httponly' => true, 'samesite' => 'Lax']);
}
header('Location: index.php?route=/database/structure&db=' . rawurlencode((string)$data['db']), true, 302);
exit;
`;
}

export function renderPool({ base, socket = SOCKET, user = SYS_USER, listenOwner = "www-data" }) {
  return [
    "; Managed by Forthway Command Center — phpMyAdmin (Settings → phpMyAdmin). Do not edit by hand.",
    `; Own pool and user (${user}), so PHP websites in the "www" pool can't read phpMyAdmin's`,
    "; secrets or its sign-on sessions.",
    `[${POOL}]`,
    `user = ${user}`,
    `group = ${user}`,
    `listen = ${socket}`,
    `listen.owner = ${listenOwner}`,
    `listen.group = ${listenOwner}`,
    "listen.mode = 0660",
    "pm = ondemand",
    "pm.max_children = 6",
    "pm.process_idle_timeout = 60s",
    "pm.max_requests = 500",
    "chdir = /",
    `php_admin_value[session.save_path] = ${path.join(base, "sessions")}`,
    "php_admin_value[session.gc_probability] = 1",
    "php_admin_value[session.gc_divisor] = 100",
    "php_admin_value[session.gc_maxlifetime] = 3600",
    "php_admin_value[session.use_strict_mode] = 1",
    "php_admin_value[session.cookie_httponly] = 1",
    `php_admin_value[upload_tmp_dir] = ${path.join(base, "tmp")}`,
    `php_admin_value[sys_temp_dir] = ${path.join(base, "tmp")}`,
    "php_admin_value[upload_max_filesize] = 256M",
    "php_admin_value[post_max_size] = 256M",
    "php_admin_value[memory_limit] = 512M",
    "php_admin_value[max_execution_time] = 600",
    "php_admin_flag[allow_url_fopen] = on",
    "php_admin_flag[log_errors] = on",
    "",
  ].join("\n");
}

export function renderNginx({ port, hostname = "", root, socket = SOCKET, tls = null, ipv6 = false }) {
  const q = (v) => `"${String(v).replace(/["\\]/g, "\\$&")}"`;
  const ssl = tls ? " ssl" : "";
  const fastcgi = [
    "        include fastcgi_params;",
    "        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;",
    "        fastcgi_param DOCUMENT_ROOT $realpath_root;",
    `        fastcgi_pass unix:${socket};`,
    "        fastcgi_read_timeout 600s;",
    "        fastcgi_buffers 16 16k;",
    "        fastcgi_buffer_size 32k;",
  ];
  return [
    "# Managed by Forthway Command Center — phpMyAdmin (Settings → phpMyAdmin). Do not edit by hand.",
    "server {",
    `    listen ${port}${ssl};`,
    ...(ipv6 ? [`    listen [::]:${port}${ssl};`] : []),
    `    server_name ${hostname || "_"};`,
    ...(tls
      ? [
          `    ssl_certificate ${q(tls.cert)};`,
          `    ssl_certificate_key ${q(tls.key)};`,
          "    ssl_protocols TLSv1.2 TLSv1.3;",
          "    # plain http:// on this port → https://",
          "    error_page 497 =301 https://$host:$server_port$request_uri;",
        ]
      : []),
    `    root ${q(root)};`,
    "    index index.php;",
    "    charset utf-8;",
    "    server_tokens off;",
    "    client_max_body_size 256m;",
    "    access_log /var/log/nginx/fcc-phpmyadmin.access.log;",
    "    error_log /var/log/nginx/fcc-phpmyadmin.error.log warn;",
    "    add_header X-Content-Type-Options nosniff always;",
    "    add_header Referrer-Policy no-referrer always;",
    '    add_header X-Robots-Tag "noindex, nofollow" always;',
    "",
    "    location ~ /\\. { deny all; }",
    "    location ~ ^/(setup|libraries|templates|vendor|sql|examples|test|src|locale|tmp)(/|$) { deny all; }",
    "    location = /config.inc.php { deny all; }",
    "",
    "    # one-time sign-on links carry a token: keep them out of the access log",
    "    location = /fcc-signon.php {",
    "        access_log off;",
    ...fastcgi,
    "    }",
    "    location / {",
    "        try_files $uri $uri/ =404;",
    "    }",
    "    location ~ \\.php$ {",
    "        try_files $uri =404;",
    ...fastcgi,
    "    }",
    "}",
    "",
  ].join("\n");
}

/** Download over https with a byte limit; resolves { size, sha256 }. */
async function httpsDownload(url, dest, { signal, timeoutMs = 10 * 60_000, max = MAX_TARBALL, asText = false } = {}) {
  if (!/^https:\/\//.test(url)) throw new Error(`Refusing a non-https URL: ${url}`);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: "follow", headers: { "User-Agent": "Forthway-Command-Center" } });
    if (res.url && !res.url.startsWith("https://")) throw new Error(`${url} redirected to a non-https address.`);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > max) throw new Error(`${url} is larger than expected (${declared} bytes).`);
    if (asText) {
      const t = await res.text();
      if (t.length > max) throw new Error(`${url} is larger than expected.`);
      return t;
    }
    const hash = crypto.createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk, _e, cb) {
        size += chunk.length;
        if (size > max) return cb(new Error(`${url} is larger than expected.`));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(dest, { mode: 0o600 }));
    } catch (e) {
      fs.rmSync(dest, { force: true });
      throw e;
    }
    return { size, sha256: hash.digest("hex") };
  } catch (e) {
    if (signal?.aborted) throw new Error("Cancelled");
    if (ac.signal.aborted) throw new Error(`Timed out downloading ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Latest stable version from phpmyadmin.net. */
export async function fetchLatestVersion({ signal } = {}) {
  const text = await httpsDownload(VERSION_URL, null, { signal, timeoutMs: 20_000, max: 256 * 1024, asText: true });
  let v = null;
  try {
    v = JSON.parse(text)?.version;
  } catch {}
  if (!validVersion(v)) throw new Error("phpmyadmin.net did not return a version number.");
  return v;
}

/** Download the release tarball and verify it against the published .sha256. */
export async function downloadVerified(version, dir, { log = () => {}, signal } = {}) {
  const name = tarballName(version);
  const url = tarballUrl(version);
  log(`Fetching checksum ${url}.sha256`);
  const shaText = await httpsDownload(`${url}.sha256`, null, { signal, timeoutMs: 30_000, max: 4096, asText: true });
  const expected = parseSha256File(shaText, name);
  if (!expected) throw new Error(`Could not read the published checksum for ${name}.`);
  const file = path.join(dir, name);
  log(`Downloading ${url}`);
  const { size, sha256 } = await httpsDownload(url, file, { signal });
  log(`Downloaded ${size} bytes, sha256 ${sha256}`);
  if (!safeEqual(sha256, expected)) {
    fs.rmSync(file, { force: true });
    throw new Error(`Checksum mismatch for ${name}: expected ${expected}, got ${sha256}. Nothing was installed.`);
  }
  log("Checksum matches the published sha256.");
  return { file, size, sha256 };
}

// ------------------------------------------------------------- the module

export function register(router, ctx) {
  const cfg = () => {
    ctx.config.phpmyadmin = ctx.config.phpmyadmin || {};
    return ctx.config.phpmyadmin;
  };
  const audit = (admin, action, target, details) => {
    try {
      ctx.activity?.(admin, action, target, details);
    } catch {}
  };
  const broadcast = () => {
    try {
      ctx.events?.broadcast?.("phpmyadmin", { at: new Date().toISOString() });
    } catch {}
  };
  const save = async () => {
    try {
      await ctx.saveConfig?.();
    } catch {}
  };

  const tokens = new Map(); // sha256(token) → { databaseId, adminId, exp }
  let latest = { at: 0, version: null, error: null };
  let busyJobId = null;
  let lastCheck = null; // { ok, status, at, error }

  // ---------------------------------------------------------- places

  function baseDir() {
    if (DRY_RUN) return path.join(ctx.dataDir, "phpmyadmin");
    return path.join(process.env.FCC_DIR || ctx.rootDir || "/opt/fcc", "phpmyadmin");
  }
  const appDir = () => path.join(baseDir(), "app");
  const nginxFile = () => path.join(nginxConfDir(ctx.dataDir), NGINX_FILE);
  const portOf = () => {
    const p = Number(cfg().port);
    return Number.isInteger(p) && p > 0 && p < 65536 ? p : DEFAULT_PORT;
  };
  const panelPort = () => Number(process.env.FCC_PORT) || Number(ctx.config.port) || 4000;
  const panelTls = () => !!((process.env.FCC_TLS_KEY || ctx.config.tls?.key) && (process.env.FCC_TLS_CERT || ctx.config.tls?.cert));

  function redeemUrl() {
    const h = String(process.env.FCC_HOST || ctx.config.host || "0.0.0.0");
    const host = ["0.0.0.0", "::", "", "localhost"].includes(h) || isLoopbackAddr(h) ? "127.0.0.1" : h;
    return `${panelTls() ? "https" : "http"}://${urlHost(host)}:${panelPort()}/internal/pma/redeem`;
  }

  function panelUrl() {
    try {
      return ctx.panelUrl();
    } catch {
      return "";
    }
  }

  function panelDomain() {
    try {
      const h = new URL(panelUrl()).hostname.replace(/^\[|\]$/g, "");
      return h && !net.isIP(h) && h !== "localhost" ? h : null;
    } catch {
      return null;
    }
  }

  /** Name used for HTTPS: the configured hostname, else the panel's domain. */
  const tlsName = () => cfg().hostname || panelDomain();

  function tlsFor(name) {
    if (!name || net.isIP(name) || !validHostname(name) || DRY_RUN) return null;
    const dir = `/etc/letsencrypt/live/${name}`;
    const cert = `${dir}/fullchain.pem`;
    const key = `${dir}/privkey.pem`;
    return fs.existsSync(cert) && fs.existsSync(key) ? { name, cert, key } : null;
  }

  function hostFromRequest(req) {
    if (!req) return null;
    let h = String(requestHost(req) || "").trim();
    if (/^\[[^\]]+\](:\d+)?$/.test(h)) h = h.slice(1, h.indexOf("]"));
    else h = h.replace(/:\d+$/, "");
    return validHostname(h) ? h : null;
  }

  /** Browser-facing base URL of phpMyAdmin. */
  function baseUrl(req) {
    const c = cfg();
    const tls = c.vhost?.tls || null;
    const host = tls || c.hostname || hostFromRequest(req) || ctx.mysql?.publicHost?.() || "127.0.0.1";
    return `${tls ? "https" : "http"}://${urlHost(host)}:${portOf()}`;
  }

  function fpmInfo() {
    if (DRY_RUN) return { version: "8.3", poolDir: "/etc/php/8.3/fpm/pool.d", unit: "php8.3-fpm", bin: "/usr/sbin/php-fpm8.3", simulated: true };
    let versions = [];
    try {
      versions = fs.readdirSync("/etc/php").filter((v) => /^\d+\.\d+$/.test(v) && fs.existsSync(`/etc/php/${v}/fpm/pool.d`));
    } catch {}
    if (!versions.length) return null;
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    let v = versions[0];
    try {
      const m = /php([\d.]+)-fpm\.sock/.exec(phpFpmSocket());
      if (m && versions.includes(m[1])) v = m[1]; // the one websites already use
    } catch {}
    const bin = [`/usr/sbin/php-fpm${v}`, which(`php-fpm${v}`)].find((p) => p && fs.existsSync(p)) || null;
    return { version: v, poolDir: `/etc/php/${v}/fpm/pool.d`, unit: `php${v}-fpm`, bin };
  }

  function nginxUser() {
    try {
      const m = /^\s*user\s+([a-z_][a-z0-9_-]*)/m.exec(fs.readFileSync("/etc/nginx/nginx.conf", "utf8"));
      if (m) return m[1];
    } catch {}
    return "www-data";
  }

  function sysUser(name) {
    try {
      for (const l of fs.readFileSync("/etc/passwd", "utf8").split("\n")) {
        const p = l.split(":");
        if (p[0] === name) return { uid: Number(p[2]), gid: Number(p[3]) };
      }
    } catch {}
    return null;
  }

  const ipv6 = () => {
    try {
      return fs.existsSync("/proc/net/if_inet6");
    } catch {
      return false;
    }
  };

  // ---------------------------------------------------------- secrets / files

  function secretOf(key, make) {
    const c = cfg();
    if (c[key]) {
      try {
        const v = ctx.secrets.decrypt(c[key]);
        if (v) return v;
      } catch {}
    }
    const v = make();
    c[key] = ctx.secrets.encrypt(v);
    return v;
  }
  const sharedSecret = () => secretOf("secretEnc", () => crypto.randomBytes(32).toString("hex"));
  const blowfish = () => secretOf("blowfishEnc", () => randomAlnum(32)); // phpMyAdmin wants exactly 32 bytes

  function currentSecret() {
    const c = cfg();
    if (!c.secretEnc) return null;
    try {
      return ctx.secrets.decrypt(c.secretEnc) || null;
    } catch {
      return null;
    }
  }

  function mysqlPort() {
    return Number(ctx.config.mysql?.port) || 3306;
  }

  /** Generated files (path → { content, mode, private }). */
  function generated(base = baseDir(), app = path.join(base, "app")) {
    return [
      { file: path.join(base, "fcc.php"), mode: 0o640, private: true, content: renderFccPhp({ secret: sharedSecret(), blowfish: blowfish(), redeemUrl: redeemUrl(), panelUrl: panelUrl() }) },
      { file: path.join(app, "config.inc.php"), mode: 0o640, private: true, content: renderConfigInc({ base, mysqlPort: mysqlPort() }) },
      { file: path.join(app, "fcc-signon.php"), mode: 0o644, private: false, content: renderSignon() },
    ];
  }

  function writeFileAtomic(file, content, mode, owner) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, content, { mode });
    fs.chmodSync(tmp, mode);
    if (owner && !DRY_RUN) fs.chownSync(tmp, 0, owner.gid);
    fs.renameSync(tmp, file);
  }

  /** (Re)write fcc.php, config.inc.php and the sign-on script. Returns how many changed. */
  function writeGenerated({ base = baseDir(), app, log = () => {}, force = false } = {}) {
    const owner = DRY_RUN ? null : sysUser(SYS_USER);
    let changed = 0;
    for (const g of generated(base, app || path.join(base, "app"))) {
      let prev = null;
      try {
        prev = fs.readFileSync(g.file, "utf8");
      } catch {}
      if (prev === g.content && !force) continue;
      writeFileAtomic(g.file, g.content, g.mode, g.private ? owner : null);
      log(`Wrote ${g.file}${g.private ? ` (0640 root:${SYS_USER})` : ""}`);
      changed++;
    }
    return changed;
  }

  function vhostContent() {
    const tls = tlsFor(tlsName());
    return {
      tls,
      content: renderNginx({ port: portOf(), hostname: cfg().hostname || "", root: appDir(), socket: SOCKET, tls, ipv6: ipv6() }),
    };
  }

  async function applyVhost(log = () => {}) {
    const { tls, content } = vhostContent();
    const r = await applyNginxFile(nginxFile(), content, { log });
    cfg().vhost = { port: portOf(), hostname: cfg().hostname || "", tls: tls?.name || null, file: nginxFile(), appliedAt: new Date().toISOString() };
    await save();
    return r;
  }

  function portFree(port) {
    if (DRY_RUN) return Promise.resolve(true);
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", (e) => resolve(e.code !== "EADDRINUSE"));
      srv.listen({ port, host: "0.0.0.0", exclusive: true }, () => srv.close(() => resolve(true)));
    });
  }

  async function checkPort(port) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw httpError(400, "Port must be a number between 1024 and 65535.");
    if (port === panelPort()) throw httpError(400, `Port ${port} is the panel's own port.`);
    if (RESERVED_PORTS.has(port)) throw httpError(400, `Port ${port} is reserved for another service.`);
    const site = ctx.db.list("sites", (s) => Number(s.port) === port)[0];
    if (site) throw httpError(409, `Port ${port} is used by the website ${site.name}.`);
    const ours = cfg().installed && cfg().vhost?.port === port;
    if (!ours && !(await portFree(port))) throw httpError(409, `Something on this server already listens on port ${port}. Pick another port.`);
  }

  async function smokeTest(log) {
    if (DRY_RUN) {
      lastCheck = { ok: true, simulated: true, at: new Date().toISOString() };
      return lastCheck;
    }
    const tls = cfg().vhost?.tls || null;
    const host = tls || cfg().hostname || "localhost";
    const lib = tls ? https : http;
    lastCheck = await new Promise((resolve) => {
      const req = lib.request(
        {
          host: "127.0.0.1",
          port: portOf(),
          path: "/fcc-signon.php",
          method: "GET",
          headers: { Host: host },
          servername: tls || undefined,
          rejectUnauthorized: false,
          timeout: 10_000,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (d) => (body.length < 65536 ? (body += d) : null));
          res.on("end", () => {
            const ok = res.statusCode === 401 && body.includes("FCC-PMA-SIGNON");
            resolve({ ok, status: res.statusCode, at: new Date().toISOString(), error: ok ? null : `HTTP ${res.statusCode}${res.statusCode === 502 ? " (php-fpm pool not answering)" : ""}` });
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("timed out")));
      req.on("error", (e) => resolve({ ok: false, status: 0, at: new Date().toISOString(), error: e.message }));
      req.end();
    });
    log(lastCheck.ok ? "Check: the sign-on page answers through nginx and php-fpm." : `Check failed: ${lastCheck.error}`);
    return lastCheck;
  }

  // ---------------------------------------------------------- status

  function isInstalled() {
    const c = cfg();
    if (!c.installed) return false;
    if (DRY_RUN) return true;
    return fs.existsSync(path.join(appDir(), "index.php"));
  }

  function jobBusy() {
    if (!busyJobId) return null;
    try {
      if (ctx.jobs.isActive?.(busyJobId)) return busyJobId;
      const j = ctx.jobs.get?.(busyJobId);
      if (j && (j.status === "running" || j.status === "queued")) return busyJobId;
    } catch {}
    busyJobId = null;
    return null;
  }

  async function statusView(req, { check = false } = {}) {
    const c = cfg();
    const installed = isInstalled();
    if (check && !DRY_RUN && Date.now() - latest.at > 6 * 3600_000) {
      try {
        latest = { at: Date.now(), version: await fetchLatestVersion(), error: null };
      } catch (e) {
        latest = { at: Date.now(), version: null, error: e.message };
      }
    }
    let fpm = null;
    try {
      fpm = fpmInfo();
    } catch {}
    const nginxOk = DRY_RUN || !!which("nginx");
    const warnings = [];
    if (c.installed && !installed) warnings.push(`The phpMyAdmin files are missing from ${appDir()}. Install it again.`);
    if (installed && !c.vhost?.tls)
      warnings.push(
        "phpMyAdmin is served over plain HTTP, so database passwords and data cross the network unencrypted. Set a hostname that has a Let's Encrypt certificate on this server (for example the panel's domain) to switch to HTTPS.",
      );
    if (installed && lastCheck && !lastCheck.ok) warnings.push(`Last check failed: ${lastCheck.error}.`);
    if (!installed && !nginxOk) warnings.push("nginx is not installed on the main server.");
    const ver = c.installed?.version || null;
    return {
      installed,
      version: ver,
      installedAt: c.installed?.installedAt || null,
      sha256: c.installed?.sha256 || null,
      dir: baseDir(),
      port: portOf(),
      hostname: c.hostname || "",
      tlsName: tlsName() || null,
      tls: installed ? !!c.vhost?.tls : !!tlsFor(tlsName()),
      url: installed ? baseUrl(req) : null,
      nginx: { installed: nginxOk, file: nginxFile() },
      php: { fpm: !!fpm, version: fpm?.version || null, pool: fpm ? path.join(fpm.poolDir, `${POOL}.conf`) : null, socket: SOCKET },
      apt: DRY_RUN || !!which("apt-get"),
      packages: PACKAGES,
      latestVersion: latest.version,
      latestCheckedAt: latest.at ? new Date(latest.at).toISOString() : null,
      latestError: latest.error,
      updateAvailable: !!(installed && latest.version && ver && latest.version.localeCompare(ver, undefined, { numeric: true }) > 0),
      lastCheck,
      busyJobId: jobBusy(),
      warnings,
      dryRun: DRY_RUN,
    };
  }

  // ---------------------------------------------------------- install / update

  async function ensurePackages({ log, signal }) {
    if (DRY_RUN) {
      await run("apt-get", ["install", "-y", "--no-install-recommends", ...PACKAGES], { log });
      return;
    }
    if (which("apt-get") && which("dpkg-query")) {
      const missing = [];
      for (const p of PACKAGES) {
        const r = await run("dpkg-query", ["-W", "--showformat=${Status}", p], { allowFail: true, timeoutMs: 15_000 });
        if (!/install ok installed/.test(r.stdout)) missing.push(p);
      }
      if (!missing.length) return log("PHP packages are already installed.");
      log(`Installing ${missing.join(" ")}…`);
      const env = { DEBIAN_FRONTEND: "noninteractive" };
      const args = ["install", "-y", "--no-install-recommends", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold", ...missing];
      const first = await run("apt-get", args, { env, log, signal, allowFail: true, timeoutMs: 20 * 60_000 });
      if (first.code !== 0) {
        log("apt-get install failed — refreshing package lists and retrying…");
        await run("apt-get", ["update"], { env, log, signal, timeoutMs: 10 * 60_000 });
        await run("apt-get", args, { env, log, signal, timeoutMs: 20 * 60_000 });
      }
      return;
    }
    if (!fpmInfo())
      throw new Error(
        `PHP-FPM is not installed and this system has no apt-get. Install php-fpm with the mysqli, mbstring, xml, zip and gd extensions (Debian/Ubuntu: ${PACKAGES.join(" ")}), then try again.`,
      );
    log("No apt-get here — using the PHP-FPM that is already installed.");
  }

  async function ensureUser(log) {
    if (DRY_RUN) {
      await run("useradd", ["--system", "--user-group", "--no-create-home", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", SYS_USER], { log });
      return { uid: 0, gid: 0 };
    }
    let u = sysUser(SYS_USER);
    if (!u) {
      if (!which("useradd")) throw new Error("useradd is not available, so the phpMyAdmin system user can't be created.");
      await run("useradd", ["--system", "--user-group", "--no-create-home", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", SYS_USER], { log, timeoutMs: 30_000 });
      u = sysUser(SYS_USER);
      if (!u) throw new Error(`Could not create the system user ${SYS_USER}.`);
      log(`Created system user ${SYS_USER} (uid ${u.uid}).`);
    }
    return u;
  }

  function prepareDirs(base, user, log) {
    fs.mkdirSync(base, { recursive: true, mode: 0o755 });
    fs.chmodSync(base, 0o755);
    for (const d of ["sessions", "tmp"]) {
      const p = path.join(base, d);
      fs.mkdirSync(p, { recursive: true, mode: 0o700 });
      fs.chmodSync(p, 0o700);
      if (!DRY_RUN) fs.chownSync(p, user.uid, user.gid);
    }
    log(`Prepared ${base} (sessions/ and tmp/ private to ${SYS_USER}).`);
  }

  async function applyPool(fpm, base, log, signal) {
    const file = path.join(fpm.poolDir, `${POOL}.conf`);
    const content = renderPool({ base, listenOwner: DRY_RUN ? "www-data" : nginxUser() });
    if (DRY_RUN) {
      const preview = path.join(base, "dry-run", `${POOL}.pool.conf`);
      writeFileAtomic(preview, content, 0o644);
      log(`[dry-run] would write ${file} (preview: ${preview})`);
      await run(fpm.bin || `php-fpm${fpm.version}`, ["-t"], { log });
      await run("systemctl", ["reload", fpm.unit], { log });
      return file;
    }
    if (!fs.existsSync(fpm.poolDir)) throw new Error(`${fpm.poolDir} does not exist.`);
    const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (prev !== content) {
      writeFileAtomic(file, content, 0o644);
      if (fpm.bin) {
        const t = await run(fpm.bin, ["-t"], { allowFail: true, timeoutMs: 30_000 });
        if (t.code !== 0) {
          if (prev === null) fs.rmSync(file, { force: true });
          else fs.writeFileSync(file, prev);
          throw new Error(`php-fpm rejected the phpMyAdmin pool; the previous state was restored.\n${(t.stderr || t.stdout).trim().split("\n").slice(-5).join("\n")}`);
        }
      }
      log(`Wrote ${file}`);
    }
    if (which("systemctl")) {
      await run("systemctl", ["enable", fpm.unit], { allowFail: true, timeoutMs: 30_000 });
      const r = await run("systemctl", ["reload-or-restart", fpm.unit], { allowFail: true, log, signal, timeoutMs: 60_000 });
      if (r.code !== 0) await run("systemctl", ["restart", fpm.unit], { log, signal, timeoutMs: 60_000 });
    }
    for (let i = 0; i < 20 && !fs.existsSync(SOCKET); i++) await new Promise((r) => setTimeout(r, 500));
    if (!fs.existsSync(SOCKET)) throw new Error(`php-fpm did not create ${SOCKET}. Check: journalctl -u ${fpm.unit}`);
    log(`php-fpm pool "${POOL}" is up (${SOCKET}).`);
    return file;
  }

  async function runInstall({ version, update }, admin, { log, signal }) {
    const c = cfg();
    const base = baseDir();
    log(DRY_RUN ? "Dry run: every step is logged and nothing on this machine is installed." : `Installing into ${base}`);
    if (!DRY_RUN && process.platform !== "linux") throw new Error("phpMyAdmin can only be installed by the panel on Linux.");
    if (!DRY_RUN && !which("nginx")) throw new Error("nginx is not installed on the main server. Re-run the installer, then try again.");
    if (!DRY_RUN && !which("tar")) throw new Error("tar is not installed.");
    await checkPort(portOf());

    // 1. PHP
    await ensurePackages({ log, signal });
    const fpm = fpmInfo();
    if (!fpm) throw new Error(`PHP-FPM is still not installed. Install ${PACKAGES.join(" ")} and try again.`);
    log(`PHP ${fpm.version} (${fpm.unit})`);

    // 2. Which release
    let v = version;
    if (v && !validVersion(v)) throw new Error(`"${v}" is not a phpMyAdmin version number (like 5.2.2).`);
    if (!v) {
      if (DRY_RUN) {
        log(`[dry-run] would look up the latest release at ${VERSION_URL}`);
        v = FALLBACK_VERSION;
      } else {
        try {
          v = await fetchLatestVersion({ signal });
          latest = { at: Date.now(), version: v, error: null };
        } catch (e) {
          throw new Error(`Could not look up the latest phpMyAdmin version (${e.message}). Pass a version number to install a specific release.`);
        }
      }
    }
    if (update && c.installed?.version === v && !DRY_RUN) log(`phpMyAdmin ${v} is already installed — reinstalling it.`);
    log(`Release: phpMyAdmin ${v}`);

    // 3. Download + verify + extract into a staging folder
    const user = await ensureUser(log);
    prepareDirs(base, user, log);
    const work = path.join(base, `.work-${Date.now()}`);
    fs.mkdirSync(work, { recursive: true, mode: 0o700 });
    let staged;
    let sha256 = null;
    const rollback = [];
    try {
      if (DRY_RUN) {
        log(`[dry-run] download ${tarballUrl(v)}`);
        log(`[dry-run] verify sha256 against ${tarballUrl(v)}.sha256`);
        await run("tar", ["-xzf", path.join(work, tarballName(v)), "-C", work, "--no-same-owner"], { log });
        staged = path.join(work, `phpMyAdmin-${v}-all-languages`);
        fs.mkdirSync(staged, { recursive: true });
        fs.writeFileSync(path.join(staged, "index.php"), "<?php // dry-run placeholder for phpMyAdmin\n");
        sha256 = "dry-run";
      } else {
        const dl = await downloadVerified(v, work, { log, signal });
        sha256 = dl.sha256;
        await run("tar", ["-xzf", dl.file, "-C", work, "--no-same-owner"], { log, signal, timeoutMs: 10 * 60_000 });
        fs.rmSync(dl.file, { force: true });
        staged = path.join(work, `phpMyAdmin-${v}-all-languages`);
        if (!fs.existsSync(path.join(staged, "index.php"))) throw new Error("The archive does not look like a phpMyAdmin release (no index.php).");
        for (const d of ["setup", "examples", "test"]) fs.rmSync(path.join(staged, d), { recursive: true, force: true });
        await run("chown", ["-R", "root:root", staged], { allowFail: true, timeoutMs: 120_000 });
        await run("chmod", ["-R", "u=rwX,go=rX", staged], { allowFail: true, timeoutMs: 120_000 });
        log("Extracted (setup/ and examples/ removed).");
      }

      // 4. Generated files go into the staged release before it goes live.
      writeGenerated({ base, app: staged, log, force: true });
      await save();

      // 5. php-fpm pool
      const hadPool = !!c.installed;
      const poolFile = await applyPool(fpm, base, log, signal);
      if (!hadPool && !DRY_RUN) rollback.push(async () => removePool(fpm, () => {}));

      // 6. Swap the release in
      const app = appDir();
      const old = `${app}.old-${Date.now()}`;
      if (fs.existsSync(app)) {
        fs.renameSync(app, old);
        rollback.push(async () => {
          fs.rmSync(app, { recursive: true, force: true });
          fs.renameSync(old, app);
        });
      } else {
        rollback.push(async () => fs.rmSync(app, { recursive: true, force: true }));
      }
      fs.renameSync(staged, app);
      log(`phpMyAdmin ${v} is in ${app}`);

      // 7. nginx
      await applyVhost(log);
      rollback.length = 0; // live from here on
      fs.rmSync(old, { recursive: true, force: true });

      c.installed = { version: v, sha256, installedAt: new Date().toISOString(), phpVersion: fpm.version, poolFile, socket: SOCKET, dir: base, ...(DRY_RUN ? { dryRun: true } : {}) };
      await save();
      await smokeTest(log);
      const url = baseUrl(null);
      log(`phpMyAdmin ${v} is ready on port ${portOf()}${cfg().vhost?.tls ? ` (HTTPS, ${cfg().vhost.tls})` : " (plain HTTP)"} — open it from a database with "Open in phpMyAdmin".`);
      if (!DRY_RUN) log(`If a firewall is active, allow the port: ufw allow ${portOf()}/tcp`);
      return { version: v, sha256, url };
    } catch (e) {
      for (const fn of rollback.reverse()) {
        try {
          await fn();
        } catch {}
      }
      if (rollback.length) log("Rolled back to the previous state.");
      throw e;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
      broadcast();
    }
  }

  async function removePool(fpm, log) {
    if (!fpm) return;
    const file = path.join(fpm.poolDir, `${POOL}.conf`);
    if (DRY_RUN) {
      log(`[dry-run] rm ${file}`);
      await run("systemctl", ["reload", fpm.unit], { log });
      return;
    }
    if (!fs.existsSync(file)) return;
    fs.rmSync(file, { force: true });
    log(`Removed ${file}`);
    if (which("systemctl")) await run("systemctl", ["reload-or-restart", fpm.unit], { allowFail: true, log, timeoutMs: 60_000 });
  }

  async function runUninstall(admin, { log }) {
    const c = cfg();
    const base = baseDir();
    // 1. Stop serving it first.
    await applyNginxFile(nginxFile(), null, { log });
    // 2. Pool.
    let fpm = null;
    try {
      fpm = fpmInfo();
    } catch {}
    await removePool(fpm, log);
    // 3. Files. Only ever a folder named "phpmyadmin" that we created.
    if (path.basename(base) === "phpmyadmin" && path.isAbsolute(base) && base.split(path.sep).filter(Boolean).length >= 2) {
      fs.rmSync(base, { recursive: true, force: true });
      log(`Removed ${base}`);
    }
    // 4. System user.
    if (DRY_RUN) await run("userdel", [SYS_USER], { log });
    else if (sysUser(SYS_USER) && which("userdel")) await run("userdel", [SYS_USER], { allowFail: true, log, timeoutMs: 30_000 });
    tokens.clear();
    delete c.installed;
    delete c.vhost;
    delete c.secretEnc;
    delete c.blowfishEnc;
    lastCheck = null;
    await save();
    broadcast();
    log("phpMyAdmin was removed. MySQL databases and users are untouched.");
    return { removed: true };
  }

  function startJob(kind, body, admin) {
    const busy = jobBusy();
    if (busy) throw httpError(409, "A phpMyAdmin job is already running.", { jobId: busy });
    const version = body?.version ? String(body.version).trim() : "";
    if (version && !validVersion(version)) throw httpError(400, `"${version}" is not a phpMyAdmin version number (like 5.2.2).`);
    if (kind === "update" && !isInstalled()) throw httpError(409, "phpMyAdmin isn't installed yet.");
    if (kind === "uninstall" && !cfg().installed) throw httpError(409, "phpMyAdmin isn't installed.");
    const titles = {
      install: `Install phpMyAdmin${version ? ` ${version}` : ""}`,
      update: `Update phpMyAdmin${version ? ` to ${version}` : ""}`,
      uninstall: "Remove phpMyAdmin",
    };
    const job = ctx.jobs.start(
      { type: `phpmyadmin.${kind}`, title: titles[kind], lock: "phpmyadmin", adminId: admin?.id },
      async ({ log, signal }) =>
        kind === "uninstall" ? runUninstall(admin, { log, signal }) : runInstall({ version: version || null, update: kind === "update" }, admin, { log, signal }),
    );
    busyJobId = job?.id || null;
    audit(admin, `phpmyadmin.${kind}`, { type: "phpmyadmin", id: "phpmyadmin", name: "phpMyAdmin" }, { version: version || null, jobId: job?.id });
    broadcast();
    return job;
  }

  async function updateSettings(body, admin) {
    const c = cfg();
    const prev = { port: c.port, hostname: c.hostname };
    const changed = [];
    if (body.port !== undefined && body.port !== null && body.port !== "") {
      const port = Number(body.port);
      if (port !== portOf()) {
        await checkPort(port);
        c.port = port;
        changed.push("port");
      }
    }
    if (body.hostname !== undefined) {
      const h = String(body.hostname || "").trim().toLowerCase().replace(/\.$/, "");
      if (h && !validHostname(h)) throw httpError(400, "Hostname must be a domain name or an IP address.");
      if (h !== (c.hostname || "")) {
        if (h) c.hostname = h;
        else delete c.hostname;
        changed.push("hostname");
      }
    }
    if (!changed.length) return statusView(null);
    if (isInstalled()) {
      if (jobBusy()) {
        Object.assign(c, prev);
        throw httpError(409, "A phpMyAdmin job is running — try again when it has finished.");
      }
      try {
        await applyVhost(() => {});
      } catch (e) {
        if (prev.port === undefined) delete c.port;
        else c.port = prev.port;
        if (prev.hostname === undefined) delete c.hostname;
        else c.hostname = prev.hostname;
        throw httpError(400, e.message);
      }
    }
    await save();
    audit(admin, "phpmyadmin.settings.update", { type: "phpmyadmin", id: "phpmyadmin", name: "phpMyAdmin" }, { fields: changed, port: portOf(), hostname: c.hostname || "" });
    broadcast();
    return statusView(null);
  }

  // ---------------------------------------------------------- sign-on tokens

  function pruneTokens() {
    const now = Date.now();
    for (const [k, t] of tokens) if (t.exp <= now) tokens.delete(k);
    while (tokens.size >= MAX_TOKENS) tokens.delete(tokens.keys().next().value);
  }

  function issueToken(databaseId, admin, req) {
    if (!isInstalled()) throw httpError(409, "phpMyAdmin isn't installed. Install it under Settings → phpMyAdmin.", { notInstalled: true });
    if (jobBusy()) throw httpError(409, "phpMyAdmin is being installed or updated — try again in a moment.");
    const rec = ctx.db.get("databases", databaseId);
    if (!rec) throw httpError(404, "Database not found.");
    if (!currentSecret()) throw httpError(409, "phpMyAdmin's sign-on secret is missing. Update phpMyAdmin to regenerate it.");
    pruneTokens();
    const token = crypto.randomBytes(32).toString("hex");
    const exp = Date.now() + TOKEN_TTL_MS;
    tokens.set(hashToken(token), { databaseId: rec.id, adminId: admin?.id || null, exp });
    audit(admin, "database.phpmyadmin.open", { type: "database", id: rec.id, name: rec.name, projectId: rec.projectId });
    return { url: `${baseUrl(req)}/fcc-signon.php?token=${token}`, expiresAt: new Date(exp).toISOString(), database: rec.name, tls: !!cfg().vhost?.tls };
  }

  /** Only phpMyAdmin's sign-on script on this machine, talking to the panel directly. */
  function fromThisMachine(req) {
    const remote = String(req.socket?.remoteAddress || "").replace(/^::ffff:/i, "");
    const local = String(req.socket?.localAddress || "").replace(/^::ffff:/i, "");
    if (!(isLoopbackAddr(remote) || (remote && remote === local))) return false;
    // A request that came through a proxy (e.g. the panel's own nginx vhost) is not from the script.
    for (const h of ["x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host", "x-forwarded-proto", "via"]) if (req.headers[h] !== undefined) return false;
    return true;
  }

  function redeem(req, body, query) {
    if (!fromThisMachine(req)) throw httpError(403, "Forbidden");
    const secret = currentSecret();
    if (!secret || !isInstalled()) throw httpError(404, "Not found");
    if (!safeEqual(String(req.headers["x-fcc-pma-secret"] || ""), secret)) throw httpError(403, "Forbidden");
    const token = String(body?.token || query?.token || "");
    if (!/^[a-f0-9]{64}$/.test(token)) throw httpError(400, "Bad token");
    const key = hashToken(token);
    const t = tokens.get(key);
    tokens.delete(key); // single use, whatever happens next
    if (!t || t.exp < Date.now()) throw httpError(410, "This sign-in link has expired or was already used.");
    const login = ctx.mysql?.localLogin?.(t.databaseId);
    if (!login) throw httpError(410, "The database no longer exists.");
    audit(t.adminId, "database.phpmyadmin.signon", { type: "database", id: login.id, name: login.db, projectId: login.projectId });
    return { user: login.user, password: login.password, host: login.host, port: String(login.port), db: login.db };
  }

  // ---------------------------------------------------------- API + routes

  ctx.phpmyadmin = {
    status: () => statusView(null),
    issueToken: (databaseId, admin) => issueToken(databaseId, admin, null),
    // for start()
    _refresh: async () => {
      if (!cfg().installed || !isInstalled()) return;
      if (fs.existsSync(appDir())) writeGenerated({ log: () => {} });
      const { content } = vhostContent();
      let prev = null;
      try {
        prev = fs.readFileSync(nginxFile(), "utf8");
      } catch {}
      if (prev !== content && !jobBusy()) await applyVhost((l) => console.log(`[fcc] phpmyadmin: ${l}`));
    },
  };

  router.get("/api/phpmyadmin", async (req, res, { query }) => statusView(req, { check: query.check === "1" }));
  router.put("/api/phpmyadmin/settings", async (req, res, { body, admin }) => updateSettings(body || {}, admin));
  router.post("/api/phpmyadmin/install", async (req, res, { body, admin }) => startJob(isInstalled() ? "update" : "install", body, admin));
  router.post("/api/phpmyadmin/update", async (req, res, { body, admin }) => startJob("update", body, admin));
  router.delete("/api/phpmyadmin", async (req, res, { admin }) => startJob("uninstall", {}, admin));

  router.post("/api/databases/:id/phpmyadmin", async (req, res, { params, admin }) => {
    res.setHeader("Cache-Control", "no-store");
    return issueToken(params.id, admin, req);
  });

  router.post("/internal/pma/redeem", { public: true, limit: 4096 }, async (req, res, { body, query }) => {
    res.setHeader("Cache-Control", "no-store");
    return redeem(req, body, query);
  });
}

export async function start(ctx) {
  // Keep generated files in step with this panel version / port / URL (no-op when unchanged).
  const t = setTimeout(() => {
    Promise.resolve(ctx.phpmyadmin?._refresh?.()).catch((e) => console.warn(`[fcc] phpmyadmin refresh: ${e.message}`));
  }, 3000);
  t.unref?.();
}
