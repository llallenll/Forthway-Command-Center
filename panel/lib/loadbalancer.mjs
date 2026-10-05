/**
 * CLUSTER — nginx front door / load balancer on the main server, plus SSL.
 *
 * Every website gets /etc/nginx/conf.d/fcc-<siteId>.conf (dev / no nginx:
 * dataDir/nginx/) with
 *
 *   upstream fcc_<siteId> { <method>; server addr:port weight=w max_fails=3 fail_timeout=10s [down]; … }
 *   server   { server_name <domains>; location / { proxy_pass http://fcc_<siteId>; … } }
 *
 * plus one shared fcc-00-common.conf (log format + websocket upgrade map).
 * Writes are atomic; `nginx -t` runs before every reload and a failed test
 * puts the previous files back. Only fcc-<siteId>.conf files and
 * fcc-00-common.conf are ever written or deleted here — never forthway-*.conf
 * (installer) or fcc-app-*.conf (local static/php vhosts from shared/tasks.mjs).
 *
 * Which upstream servers are `down`:
 *   - single-server sites: never (there is nothing to fail over to).
 *   - LB sites: only servers with lbEligible !== false are in the pool (if that
 *     leaves none, all targets are kept). A target is marked `down` when the
 *     server is disabled, or the active health check (every 30s) failed twice
 *     in a row. An offline AGENT alone does not mark it down — the agent
 *     process being gone says nothing about the app; the health check does.
 *   - if every target would be down, none is (nginx then still tries them all
 *     instead of answering 502 for certain).
 * nginx's own passive checks (max_fails=3 fail_timeout=10s) cover the gaps
 * between active checks.
 */

import fs from "node:fs";
import path from "node:path";

import { httpError } from "./http.mjs";
import * as sys from "./sys.mjs";
import { applyNginxFile, reloadNginx, nginxIsLive } from "../../shared/tasks.mjs";
import { cloudflareRanges, refreshCloudflareRanges, renderRealIpConf, renderRealIpDisabled, REFRESH_MS as CF_REFRESH_MS } from "./cfips.mjs";

const HEALTH_INTERVAL_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5_000;
const FAILS_TO_DOWN = 2;
const OKS_TO_UP = 2;
const COMMON_FILE = "fcc-00-common.conf";
const REALIP_FILE = "fcc-00-realip.conf"; // real client IP behind Cloudflare (panel/lib/cfips.mjs)
// fcc_v2 starts like fcc_main (CLUSTER's request counter reads both) and adds what
// panel/lib/analytics.mjs needs. fcc_main stays defined for files not yet regenerated.
const LOG_FORMAT = "fcc_v2";
const LEGACY_LOG_FORMAT = "fcc_main";
const UPGRADE_MAP = "$fcc_connection_upgrade";
const LE_LIVE = "/etc/letsencrypt/live";

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;

export function register(router, ctx) {
  const lb = createLb(ctx);
  ctx.lb = lb;
  lb._routes(router);
}

export async function start(ctx) {
  await ctx.lb?._start();
}

export async function stop(ctx) {
  ctx.lb?._stop();
}

function createLb(ctx) {
  const { db } = ctx;
  const health = new Map(); // `${siteId}|${serverId}` -> { healthy, fails, oks, checkedAt, latencyMs, error }
  const timers = [];
  let chain = Promise.resolve();
  let nginxVersion = null;
  let nginxRealIpModule = null; // from `nginx -V` (null = unknown / not live)
  let realIpError = null; // set when nginx rejected fcc-00-realip.conf — it then stays disabled until restart
  const state = { lastAppliedAt: null, lastError: null, configOk: null };

  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  // ------------------------------------------------------------ helpers

  function confDir() {
    if (nginxIsLive()) return "/etc/nginx/conf.d";
    const d = path.join(ctx.dataDir, "nginx");
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  const safeId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, "");
  const siteFile = (site) => path.join(confDir(), `fcc-${safeId(site.id)}.conf`);
  const upstreamName = (site) => `fcc_${String(site.id).replace(/[^A-Za-z0-9_]/g, "_")}`;
  const logDir = () => process.env.FCC_NGINX_LOG_DIR || "/var/log/nginx";

  function getSite(id) {
    try {
      const s = ctx.sites?.get?.(id);
      if (s) return s;
    } catch {
      /* fall through */
    }
    return db.get("sites", id);
  }
  function allSites() {
    try {
      const l = ctx.sites?.list?.({});
      if (Array.isArray(l)) return l;
    } catch {
      /* fall through */
    }
    return db.list("sites");
  }
  function targets(site) {
    try {
      const t = ctx.sites?.targets?.(site);
      if (Array.isArray(t)) return t;
    } catch {
      /* fall through */
    }
    const ids = Array.isArray(site.serverIds) ? site.serverIds : [];
    return site.loadBalanced ? ids : [ids[0] || "main"];
  }
  function domainsOf(site) {
    return [...new Set((site.domains || []).map((d) => String(d).trim().toLowerCase()).filter((d) => DOMAIN_RE.test(d)))];
  }
  function method(site) {
    return ["round_robin", "least_conn", "ip_hash"].includes(site.lbMethod) ? site.lbMethod : "round_robin";
  }
  function bodySize(site) {
    const v = String(site.clientMaxBodySize || site.settings?.clientMaxBodySize || "100m");
    return /^\d+[kmg]?$/i.test(v) ? v : "100m";
  }
  function healthPath(site) {
    const p = String(site.healthPath || "").trim();
    return p && /^\/[\w\-./?=&%]*$/.test(p) ? p : "";
  }

  function certPaths(site) {
    const dir = path.join(LE_LIVE, `fcc-${safeId(site.id)}`);
    return { cert: path.join(dir, "fullchain.pem"), key: path.join(dir, "privkey.pem") };
  }
  function sslActive(site) {
    if (!site.ssl?.enabled) return false;
    if (!nginxIsLive()) return true; // dev preview: show what it would be
    const c = certPaths(site);
    return fs.existsSync(c.cert) && fs.existsSync(c.key);
  }
  const ipv6 = () => !nginxIsLive() || fs.existsSync("/proc/net/if_inet6");
  function http2Directive() {
    const v = (nginxVersion || "0.0.0").split(".").map(Number);
    return v[0] > 1 || (v[0] === 1 && (v[1] > 25 || (v[1] === 25 && v[2] >= 1)));
  }

  // -------------------------------------------------------------- pool

  function upstreams(site) {
    if (!site) return [];
    const cl = ctx.cluster;
    let entries = [...new Set(targets(site))]
      .map((id) => {
        const s = db.get("servers", id);
        if (!s) return null;
        const h = health.get(`${site.id}|${id}`);
        return {
          serverId: id,
          name: s.name,
          address: cl?.address?.(id) ?? (id === "main" ? "127.0.0.1" : s.privateHost || s.host),
          port: Number(site.port) || null,
          weight: Math.max(1, Math.min(100, Number(site.weights?.[id]) || Number(s.weight) || 1)),
          enabled: s.enabled !== false,
          lbEligible: s.lbEligible !== false,
          online: cl?.isOnline ? !!cl.isOnline(id) : id === "main",
          healthy: h ? h.healthy : null,
          checkedAt: h?.checkedAt || null,
          latencyMs: h?.latencyMs ?? null,
          error: h?.error || null,
          down: false,
        };
      })
      .filter((e) => e && e.address);
    if (site.loadBalanced) {
      const eligible = entries.filter((e) => e.lbEligible);
      if (eligible.length) entries = eligible;
      if (entries.length > 1) {
        for (const e of entries) e.down = !e.enabled || e.healthy === false;
        if (entries.every((e) => e.down)) for (const e of entries) e.down = false;
      }
    }
    return entries;
  }

  // ------------------------------------------------------------ render

  function renderCommon() {
    return [
      "# Managed by Forthway Command Center — shared by every fcc-<siteId>.conf. Do not edit.",
      `log_format ${LEGACY_LOG_FORMAT} '$msec $status $request_time "$upstream_addr" "$host" "$request" $body_bytes_sent "$http_user_agent"';`,
      `log_format ${LOG_FORMAT}${logEscapeJson() ? " escape=json" : ""} '$msec $status $request_time "$upstream_addr" "$host" "$request_method" "$request_uri" $body_bytes_sent "$http_user_agent" "$remote_addr" "$sent_http_content_type" "$http_referer" "$http_sec_fetch_dest" "$http_sec_purpose$http_purpose" fcc2';`,
      `map $http_upgrade ${UPGRADE_MAP} {`,
      "    default upgrade;",
      "    ''      '';",
      "}",
      "",
    ].join("\n");
  }

  // log_format escape= needs nginx ≥ 1.11.8 (unknown version → assume a current one).
  function logEscapeJson() {
    if (!nginxVersion) return true;
    const v = nginxVersion.split(".").map(Number);
    return v[0] > 1 || (v[0] === 1 && (v[1] > 11 || (v[1] === 11 && v[2] >= 8)));
  }

  /** Why fcc-00-realip.conf must stay a comment, or null when it can be live. */
  function realIpBlocker() {
    if (realIpError) return `nginx rejected it (${realIpError})`;
    if (!nginxIsLive()) return null; // dev preview: show the real thing
    if (nginxRealIpModule === false) return "this nginx was built without ngx_http_realip_module";
    // real_ip_header twice in the http block fails `nginx -t`: leave an existing setup alone.
    const files = ["/etc/nginx/nginx.conf"];
    for (const d of ["/etc/nginx/conf.d", "/etc/nginx/sites-enabled"]) {
      try {
        for (const f of fs.readdirSync(d)) if (f !== REALIP_FILE) files.push(path.join(d, f));
      } catch {
        /* no such dir */
      }
    }
    for (const f of files) {
      try {
        if (/^\s*real_ip_header\s/m.test(fs.readFileSync(f, "utf8"))) return `real_ip_header is already set in ${f}`;
      } catch {
        /* unreadable — ignore */
      }
    }
    return null;
  }

  function renderRealIp() {
    const why = realIpBlocker();
    return why ? renderRealIpDisabled(why) : renderRealIpConf(cloudflareRanges(ctx.dataDir));
  }
  const realIpFile = () => path.join(confDir(), REALIP_FILE);
  const realIpFailed = (err) => String(err?.message || "").includes(REALIP_FILE);

  function proxyLocation(site, up) {
    const headers = [
      `        proxy_pass http://${up};`,
      "        proxy_http_version 1.1;",
      "        proxy_set_header Host $host;",
      "        proxy_set_header X-Real-IP $remote_addr;",
      "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
      "        proxy_set_header X-Forwarded-Proto $scheme;",
      "        proxy_set_header X-Forwarded-Host $host;",
      "        proxy_set_header X-Forwarded-Port $server_port;",
      "        proxy_set_header Upgrade $http_upgrade;",
      `        proxy_set_header Connection ${UPGRADE_MAP};`,
      "        proxy_connect_timeout 5s;",
      "        proxy_send_timeout 300s;",
      "        proxy_read_timeout 300s;",
    ];
    const out = [];
    if (site.loadBalanced) {
      // Hashed build files (Next.js chunks) only exist on a server that built or
      // received that exact release. While servers differ — mid rolling deploy,
      // or after one failed — a chunk can 404 on the server nginx picked; ask
      // the others before giving up. These are immutable GETs, safe to retry.
      out.push(
        "    location ^~ /_next/static/ {",
        ...headers,
        "        proxy_next_upstream error timeout http_404 http_502 http_503 http_504;",
        "        proxy_next_upstream_tries 0;",
        "    }",
        "",
      );
    }
    out.push(
      "    location / {",
      ...headers,
      site.loadBalanced ? "        proxy_next_upstream error timeout http_502 http_503 http_504;" : null,
      "    }",
    );
    return out.filter((l) => l !== null);
  }

  function render(site) {
    const up = upstreamName(site);
    const pool = upstreams(site);
    const domains = domainsOf(site);
    const port = Number(site.port);
    const m = method(site);
    const out = [
      "# Managed by Forthway Command Center — regenerated on every change; edits are overwritten.",
      `# Site: ${String(site.name || "").replace(/[\r\n]/g, " ")} (${site.id})`,
      `# Mode: ${site.loadBalanced ? `load balanced (${m}) across ${pool.length} server(s)` : "single server"}`,
      "",
    ];
    if (!port) {
      out.push("# No port assigned to this site yet — nothing to proxy.", "");
      return out.join("\n");
    }
    out.push(`upstream ${up} {`);
    if (site.loadBalanced && m !== "round_robin") out.push(`    ${m};`);
    if (!pool.length) {
      out.push(`    # no server is available for this site; requests will fail until one is assigned`);
      out.push(`    server 127.0.0.1:${port} down;`);
    }
    for (const e of pool) {
      const addr = e.address.includes(":") ? `[${e.address}]` : e.address;
      const why = e.down ? (!e.enabled ? "disabled" : "failing health checks") : "";
      out.push(
        `    server ${addr}:${port} weight=${e.weight} max_fails=3 fail_timeout=10s${e.down ? " down" : ""};  # ${e.name}${why ? ` — ${why}` : ""}`,
      );
    }
    out.push("    keepalive 16;", "}", "");

    if (!domains.length) {
      out.push("# No domains yet — add one to put this site on the front door.", "");
      return out.join("\n");
    }
    const names = domains.join(" ");
    const logs = [
      `    access_log ${logDir()}/fcc-${safeId(site.id)}.access.log ${LOG_FORMAT};`,
      `    error_log ${logDir()}/fcc-${safeId(site.id)}.error.log warn;`,
    ];
    const acme = ["    location ^~ /.well-known/acme-challenge/ {", "        root /var/www/html;", "    }"];
    const v6 = ipv6();
    const common = [`    client_max_body_size ${bodySize(site)};`, "    server_tokens off;"];

    if (sslActive(site)) {
      const c = certPaths(site);
      out.push(
        "server {",
        "    listen 80;",
        v6 ? "    listen [::]:80;" : null,
        `    server_name ${names};`,
        ...logs,
        ...acme,
        "    location / {",
        "        return 301 https://$host$request_uri;",
        "    }",
        "}",
        "",
        "server {",
        http2Directive() ? "    listen 443 ssl;" : "    listen 443 ssl http2;",
        v6 ? (http2Directive() ? "    listen [::]:443 ssl;" : "    listen [::]:443 ssl http2;") : null,
        http2Directive() ? "    http2 on;" : null,
        `    server_name ${names};`,
        `    ssl_certificate ${c.cert};`,
        `    ssl_certificate_key ${c.key};`,
        fs.existsSync("/etc/letsencrypt/options-ssl-nginx.conf") ? "    include /etc/letsencrypt/options-ssl-nginx.conf;" : "    ssl_protocols TLSv1.2 TLSv1.3;",
        fs.existsSync("/etc/letsencrypt/ssl-dhparams.pem") ? "    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;" : null,
        ...logs,
        ...common,
        ...proxyLocation(site, up),
        "}",
        "",
      );
    } else {
      out.push(
        "server {",
        "    listen 80;",
        v6 ? "    listen [::]:80;" : null,
        `    server_name ${names};`,
        ...logs,
        ...common,
        ...acme,
        ...proxyLocation(site, up),
        "}",
        "",
      );
    }
    return out.filter((l) => l !== null).join("\n");
  }

  // ------------------------------------------------------------- apply

  async function testAndReload(log) {
    if (!nginxIsLive()) {
      state.configOk = null;
      return;
    }
    const t = await sys.run("nginx", ["-t"], { allowFail: true, timeoutMs: 30_000 });
    if (t.code !== 0) {
      state.configOk = false;
      const err = new Error(`nginx -t failed:\n${(t.stderr || t.stdout).trim()}`);
      err.nginxTest = true;
      throw err;
    }
    state.configOk = true;
    await reloadNginx(log);
  }

  function ok() {
    state.lastAppliedAt = new Date().toISOString();
    state.lastError = null;
    broadcast({ applied: state.lastAppliedAt });
  }
  function fail(err) {
    state.lastError = err.message;
    if (/nginx/.test(err.message) && /fail|reject/.test(err.message)) state.configOk = false;
    broadcast({ error: err.message });
  }
  function broadcast(data) {
    try {
      ctx.events?.broadcast("lb", { ...data, status: status() });
    } catch {
      /* no SSE */
    }
  }

  async function ensureCommon(log) {
    const r = await applyNginxFile(path.join(confDir(), COMMON_FILE), renderCommon(), { log });
    try {
      await applyNginxFile(realIpFile(), renderRealIp(), { log });
    } catch (err) {
      // applyNginxFile already put the previous file back; keep real_ip off rather than block site changes.
      realIpError = String(err.message).split("\n").filter((l) => l.includes(REALIP_FILE))[0]?.trim().slice(0, 300) || "nginx -t failed";
      console.warn(`[lb] ${REALIP_FILE} rejected by nginx — real client IP stays off: ${realIpError}`);
      await applyNginxFile(realIpFile(), renderRealIp(), { log }).catch(() => {});
    }
    return r;
  }

  function syncSite(site, { log = () => {} } = {}) {
    return serial(async () => {
      const s = typeof site === "string" ? getSite(site) : site;
      if (!s?.id) throw new Error("syncSite: unknown site");
      try {
        await ensureCommon(log);
        const r = await applyNginxFile(siteFile(s), render(s), { log });
        if (r.tested) state.configOk = true;
        ok();
        return { file: r.file, changed: r.changed };
      } catch (err) {
        fail(err);
        throw err;
      }
    });
  }

  function removeSite(site, { log = () => {} } = {}) {
    return serial(async () => {
      const id = typeof site === "string" ? site : site?.id;
      if (!id) return { removed: false };
      for (const k of [...health.keys()]) if (k.startsWith(`${id}|`)) health.delete(k);
      try {
        const r = await applyNginxFile(path.join(confDir(), `fcc-${safeId(id)}.conf`), null, { log });
        ok();
        // A deleted website's certificate goes with it (the vhost referencing it is gone now).
        if (typeof site === "object" && (site.ssl?.enabled || site.ssl?.status === "failed")) {
          await removeCertFiles(`fcc-${safeId(id)}`, { log }).catch((err) => log(`Could not delete the certificate: ${err.message}`));
        }
        return { removed: r.changed };
      } catch (err) {
        fail(err);
        throw err;
      }
    });
  }

  /** Regenerate every site file (one test + one reload); drop files of deleted sites. */
  function applyAll({ log = () => {} } = {}) {
    return serial(async () => {
      try {
        return await applyAllOnce(log);
      } catch (err) {
        if (!realIpFailed(err) || realIpError) throw err;
        // Everything was rolled back. Retry once with fcc-00-realip.conf as a comment.
        realIpError = String(err.message).split("\n").filter((l) => l.includes(REALIP_FILE))[0]?.trim().slice(0, 300) || "nginx -t failed";
        log(`nginx rejected ${REALIP_FILE} — retrying with the real client IP setting turned off.`);
        return applyAllOnce(log);
      }
    });
  }

  async function applyAllOnce(log) {
    {
      const dir = confDir();
      const sites = allSites();
      const want = new Map([
        [path.join(dir, COMMON_FILE), renderCommon()],
        [path.join(dir, REALIP_FILE), renderRealIp()],
      ]);
      for (const s of sites) want.set(siteFile(s), render(s));
      const ownedRe = /^fcc-[A-Za-z0-9_-]+\.conf$/;
      for (const f of fs.readdirSync(dir)) {
        if (!ownedRe.test(f) || f === COMMON_FILE || f.startsWith("fcc-app-")) continue;
        if (f === "fcc-phpmyadmin.conf") continue; // DATA's phpMyAdmin vhost (panel/lib/phpmyadmin.mjs), not a website
        const full = path.join(dir, f);
        if (!want.has(full)) want.set(full, null);
      }
      const previous = new Map();
      let changed = 0;
      try {
        for (const [file, content] of want) {
          const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
          if (prev === content) continue;
          previous.set(file, prev);
          if (content === null) {
            fs.rmSync(file, { force: true });
            log(`removed ${file}`);
          } else {
            const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
            fs.writeFileSync(tmp, content, { mode: 0o644 });
            fs.renameSync(tmp, file);
            log(`wrote ${file}`);
          }
          changed++;
        }
        if (!changed) {
          log("nginx configuration already up to date.");
          ok();
          return { changed: 0, sites: sites.length };
        }
        await testAndReload(log);
        log(nginxIsLive() ? `nginx reloaded (${changed} file(s) changed).` : `${changed} file(s) written to ${dir} (nginx not live — not loaded).`);
        ok();
        return { changed, sites: sites.length };
      } catch (err) {
        for (const [file, prev] of previous) {
          try {
            if (prev === null) fs.rmSync(file, { force: true });
            else fs.writeFileSync(file, prev);
          } catch {
            /* best effort */
          }
        }
        if (previous.size) log("Restored the previous nginx files.");
        fail(err);
        throw err;
      }
    }
  }

  function status() {
    const installed = !!sys.which("nginx");
    return {
      installed,
      version: nginxVersion,
      configOk: state.configOk,
      lastAppliedAt: state.lastAppliedAt,
      lastError: state.lastError,
      live: nginxIsLive(),
      dryRun: sys.DRY_RUN,
      confDir: confDir(),
      certbot: !!sys.which("certbot"),
      realIp: (() => {
        const cf = cloudflareRanges(ctx.dataDir);
        const blocked = realIpBlocker();
        return { enabled: !blocked, reason: blocked, header: "CF-Connecting-IP", ranges: cf.source, fetchedAt: cf.fetchedAt, file: path.join(confDir(), REALIP_FILE) };
      })(),
    };
  }

  // ------------------------------------------------------------ certbot

  async function issueCertificate(site, { log = () => {}, email, signal } = {}) {
    const s = typeof site === "string" ? getSite(site) : site;
    if (!s) throw new Error("Site not found");
    // Domains delivered through a Cloudflare Tunnel are left off the certificate:
    // Cloudflare terminates HTTPS for them, the tunnel reaches nginx without
    // verifying the origin certificate, and Let's Encrypt's HTTP-01 renewal
    // checks could not reach them through the tunnel anyway.
    const tunnelled = (d) => !!ctx.cloudflare?.isTunnelHostname?.(d);
    const domains = domainsOf(s).filter((d) => !tunnelled(d));
    if (!domains.length) {
      throw new Error(
        domainsOf(s).length
          ? "Every domain on this website goes through a Cloudflare Tunnel — Cloudflare already provides HTTPS for them."
          : "Add a domain to this website before requesting a certificate.",
      );
    }
    if (!sys.DRY_RUN && !sys.which("certbot")) {
      throw new Error("certbot is not installed on the main server (apt install certbot python3-certbot-nginx).");
    }
    const mail = String(email || s.ssl?.email || ctx.config?.ssl?.email || ctx.config?.letsencryptEmail || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new Error("An email address is needed for Let's Encrypt.");

    const setSsl = (patch) => {
      const next = { ...(s.ssl || {}), ...patch };
      db.update("sites", s.id, { ssl: next });
      s.ssl = next;
      broadcast({ siteId: s.id, ssl: next });
    };
    setSsl({ status: "pending", error: null });
    try {
      log(`Making sure ${domains.join(", ")} ${domains.length === 1 ? "is" : "are"} on the front door…`);
      await syncSite(s, { log });
      const args = ["--nginx", "--cert-name", `fcc-${safeId(s.id)}`];
      for (const d of domains) args.push("-d", d);
      args.push("--non-interactive", "--agree-tos", "-m", mail, "--redirect", "--expand", "--keep-until-expiring");
      log(`Requesting a certificate for ${domains.join(", ")} from Let's Encrypt…`);
      await sys.run("certbot", args, { log, signal, timeoutMs: 10 * 60_000 });
      setSsl({ enabled: true, status: "active", issuedAt: new Date().toISOString(), error: null, domains, email: mail, ...(sys.DRY_RUN ? { dryRun: true } : {}) });
      // certbot edited our file; put our own (SSL-aware) template back.
      await syncSite(s, { log });
      log("Certificate installed. HTTP now redirects to HTTPS.");
      return { ok: true, domains, certName: `fcc-${safeId(s.id)}` };
    } catch (err) {
      setSsl({ status: "failed", error: err.message });
      // certbot may have left our file half-edited — restore the generated one.
      await syncSite(s, { log }).catch(() => {});
      throw err;
    }
  }

  /**
   * Remove a website's certificate. nginx is regenerated without HTTPS first,
   * so nothing references the certificate files when certbot deletes them
   * (the other order would leave nginx unable to reload).
   */
  async function deleteCertificate(site, { log = () => {}, signal } = {}) {
    const s = typeof site === "string" ? getSite(site) : site;
    if (!s) throw new Error("Site not found");
    const certName = `fcc-${safeId(s.id)}`;
    const before = s.ssl || {};
    const next = { enabled: false, status: "none", issuedAt: null, error: null, domains: [], email: before.email || null };
    db.update("sites", s.id, { ssl: next });
    s.ssl = next;
    broadcast({ siteId: s.id, ssl: next });
    log("Switching nginx back to plain HTTP for this website…");
    try {
      await syncSite(s, { log });
    } catch (err) {
      // Could not drop HTTPS from nginx — put the certificate state back and stop.
      db.update("sites", s.id, { ssl: before });
      s.ssl = before;
      broadcast({ siteId: s.id, ssl: before });
      throw err;
    }
    await removeCertFiles(certName, { log, signal });
    log("Certificate deleted. The website is served over HTTP until a new certificate is issued.");
    return { ok: true, certName };
  }

  async function removeCertFiles(certName, { log = () => {}, signal } = {}) {
    if (!sys.DRY_RUN && !sys.which("certbot")) {
      log("certbot is not installed here — nothing to delete.");
      return;
    }
    log(`Deleting certificate ${certName} from Let's Encrypt's store…`);
    const r = await sys.run("certbot", ["delete", "--cert-name", certName, "--non-interactive"], { log, signal, allowFail: true, timeoutMs: 2 * 60_000 });
    if (r.code !== 0 && !/No certificate found|not found/i.test(`${r.stdout}${r.stderr}`)) {
      throw new Error(`certbot could not delete ${certName}: ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ")}`);
    }
  }

  // ------------------------------------------------------- health checks

  async function probe(url, strict) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    const started = Date.now();
    try {
      const res = await fetch(url, { signal: ctrl.signal, redirect: "manual", headers: { "User-Agent": "fcc-healthcheck" } });
      await res.arrayBuffer().catch(() => {});
      const good = strict ? res.status < 400 : res.status < 500;
      return { ok: good, latencyMs: Date.now() - started, error: good ? null : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, error: err.name === "AbortError" ? "timed out" : err.cause?.code || err.message };
    } finally {
      clearTimeout(t);
    }
  }

  async function healthPass() {
    const changedSites = new Set();
    await Promise.all(
      allSites().map(async (site) => {
        const port = Number(site.port);
        if (!port) return;
        const hp = healthPath(site);
        const pool = upstreams(site);
        await Promise.all(
          pool.map(async (e) => {
            const key = `${site.id}|${e.serverId}`;
            const prev = health.get(key) || { healthy: null, fails: 0, oks: 0 };
            let r;
            if (sys.DRY_RUN) r = { ok: e.enabled && e.online, latencyMs: 0, error: e.online ? null : "offline (dry-run)" };
            else {
              const host = e.address.includes(":") ? `[${e.address}]` : e.address;
              r = await probe(`http://${host}:${port}${hp || "/"}`, !!hp);
            }
            const next = { ...prev, checkedAt: new Date().toISOString(), latencyMs: r.latencyMs, error: r.error };
            if (r.ok) {
              next.oks = prev.oks + 1;
              next.fails = 0;
              if (prev.healthy === null || next.oks >= OKS_TO_UP) next.healthy = true;
            } else {
              next.fails = prev.fails + 1;
              next.oks = 0;
              if (prev.healthy === null || next.fails >= FAILS_TO_DOWN) next.healthy = false;
            }
            health.set(key, next);
            if (next.healthy !== prev.healthy) changedSites.add(site.id);
          }),
        );
      }),
    );
    for (const id of changedSites) {
      const site = getSite(id);
      if (!site) continue;
      try {
        ctx.events?.broadcast("lb", { siteId: id, upstreams: upstreams(site) });
      } catch {
        /* no SSE */
      }
      if (site.loadBalanced) await syncSite(site).catch((err) => console.warn(`[lb] ${id}: ${err.message}`));
    }
  }

  // ------------------------------------------------------------- routes

  function requireSite(id) {
    const s = getSite(id);
    if (!s) throw httpError(404, "Website not found");
    return s;
  }

  function routes(router) {
    router.get("/api/loadbalancer", () => ({
      ...status(),
      sites: allSites().map((s) => ({
        id: s.id,
        name: s.name,
        projectId: s.projectId,
        domains: s.domains || [],
        loadBalanced: !!s.loadBalanced,
        method: method(s),
        port: s.port,
        ssl: s.ssl || null,
        upstreams: upstreams(s),
      })),
    }));

    router.post("/api/loadbalancer/apply", (req, res, { admin }) => {
      const job = ctx.jobs.start({ type: "lb.apply", title: "Apply load balancer configuration", adminId: admin?.id }, ({ log }) =>
        applyAll({ log }),
      );
      ctx.activity?.(admin, "lb.apply", { type: "loadbalancer", id: "nginx", name: "nginx" });
      return job;
    });

    router.get("/api/sites/:id/nginx", (req, res, { params }) => {
      const s = requireSite(params.id);
      return { config: render(s), file: siteFile(s), upstreams: upstreams(s) };
    });

    router.post("/api/sites/:id/ssl", (req, res, { params, body, admin }) => {
      const s = requireSite(params.id);
      if (!domainsOf(s).length) throw httpError(400, "Add a domain to this website first.");
      const email = body.email || admin?.email;
      const job = ctx.jobs.start(
        { type: "site.ssl", title: `SSL certificate for ${domainsOf(s)[0]}`, siteId: s.id, projectId: s.projectId, adminId: admin?.id },
        ({ log, signal }) => issueCertificate(s.id, { log, signal, email }),
      );
      ctx.activity?.(admin, "site.ssl", { type: "site", id: s.id, name: s.name }, { domains: domainsOf(s) });
      return job;
    });

    router.delete("/api/sites/:id/ssl", (req, res, { params, admin }) => {
      const s = requireSite(params.id);
      if (!s.ssl?.enabled && !["failed", "pending"].includes(s.ssl?.status)) throw httpError(409, "This website has no certificate to delete.");
      const job = ctx.jobs.start(
        { type: "site.ssl.delete", title: `Delete SSL certificate for ${domainsOf(s)[0] || s.name}`, siteId: s.id, projectId: s.projectId, adminId: admin?.id },
        ({ log, signal }) => deleteCertificate(s.id, { log, signal }),
      );
      ctx.activity?.(admin, "site.ssl.delete", { type: "site", id: s.id, name: s.name }, { domains: s.ssl?.domains || domainsOf(s) });
      return job;
    });
  }

  // ---------------------------------------------------------- lifecycle

  let pending = null;
  function scheduleApplyAll() {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      applyAll().catch((err) => console.warn("[lb] applyAll after server change failed:", err.message));
    }, 1000);
    pending.unref?.();
  }

  async function _start() {
    if (sys.which("nginx") && !sys.DRY_RUN) {
      const r = await sys.run("nginx", ["-V"], { allowFail: true, timeoutMs: 10_000 }).catch(() => null);
      const out = `${r?.stderr || ""}${r?.stdout || ""}`;
      nginxVersion = /nginx\/([\d.]+)/.exec(out)?.[1] || null;
      nginxRealIpModule = /configure arguments:/.test(out) ? /--with-http_realip_module\b/.test(out) : null;
    }
    // Cloudflare's IP ranges for real_ip: refreshed daily (never fetched in dry-run unless FCC_CF_IPS_FETCH=1).
    const refreshCf = async () => {
      if (sys.DRY_RUN && process.env.FCC_CF_IPS_FETCH !== "1") return;
      const r = await refreshCloudflareRanges(ctx.dataDir);
      if (r.error) console.warn(`[lb] Cloudflare IP ranges not refreshed (${r.error}); using the ${r.ranges.source === "cloudflare" ? "cached" : "built-in"} list.`);
      if (r.changed) {
        console.log("[lb] Cloudflare IP ranges changed — updating fcc-00-realip.conf");
        await applyAll().catch((err) => console.warn("[lb] apply after Cloudflare IP update failed:", err.message));
      }
    };
    const cfFirst = setTimeout(() => refreshCf().catch(() => {}), 20_000);
    cfFirst.unref?.();
    timers.push(cfFirst);
    const cfEvery = setInterval(() => refreshCf().catch(() => {}), Math.min(CF_REFRESH_MS, 6 * 3_600_000));
    cfEvery.unref?.();
    timers.push(cfEvery);
    ctx.cluster?.on?.("servers-changed", (e) => {
      if (e?.reason === "hello") return; // an agent reconnecting changes nothing in nginx
      scheduleApplyAll();
    });
    const first = setTimeout(() => {
      applyAll().catch((err) => console.warn("[lb] initial apply failed:", err.message));
      healthPass().catch(() => {});
    }, 3000);
    first.unref?.();
    timers.push(first);
    const t = setInterval(() => healthPass().catch((err) => console.warn("[lb] health pass:", err.message)), HEALTH_INTERVAL_MS);
    t.unref?.();
    timers.push(t);
  }

  function _stop() {
    for (const t of timers) clearTimeout(t);
    if (pending) clearTimeout(pending);
  }

  return {
    status,
    syncSite,
    removeSite,
    applyAll,
    preview: (site) => render(typeof site === "string" ? requireSite(site) : site),
    upstreams: (site) => upstreams(typeof site === "string" ? getSite(site) : site),
    issueCertificate,
    deleteCertificate,
    healthCheckNow: healthPass,
    _routes: routes,
    _start,
    _stop,
  };
}
