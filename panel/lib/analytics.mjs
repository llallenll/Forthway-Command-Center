/**
 * ANALYTICS — unique visitors, page views and requests per website (and for
 * all websites together), from the nginx access logs of the front door.
 *
 * Input: CLUSTER's access-log tailer (cluster.mjs tailAccessLogs) hands every
 * batch of new lines to ctx.analytics.ingest(site, lines). Every website's
 * traffic passes nginx on the main server (load-balanced and Cloudflare Tunnel
 * sites too), so nothing is added to the websites themselves: no script, no
 * cookie.
 *
 * Log format (loadbalancer.mjs, conf.d/fcc-00-common.conf):
 *   log_format fcc_v2 escape=json '$msec $status $request_time "$upstream_addr" "$host" "$request_method"
 *     "$request_uri" $body_bytes_sent "$http_user_agent" "$remote_addr" "$sent_http_content_type"
 *     "$http_referer" "$http_sec_fetch_dest" "$http_sec_purpose$http_purpose" fcc2';
 * It starts like the older fcc_main format, so CLUSTER's own parser (request
 * counts, errors, per-server split) reads both. Older fcc_main / "combined"
 * lines count as requests only.
 *
 * Metrics
 *   requests   every logged request (bots, assets, API calls included).
 *   pageViews  real page loads by people: GET, 2xx (not 204/206) or 304, a
 *              text/html response (or, when nginx logged no Content-Type, a
 *              path that is not an asset), not /api/ /_next/ /static/ … nor
 *              favicon/robots/sitemap/health paths (incl. site.healthPath), not
 *              a prefetch/prerender, Sec-Fetch-Dest "document" when the browser
 *              sent it, and not a bot (isBot()).
 *   uniques    distinct visitors among page views. Visitor id = first 32 bits
 *              of HMAC-SHA256(daily salt, client IP + "\n" + User-Agent). The
 *              salt is random, kept in dataDir/analytics/salt.json (0600) and
 *              deleted 10 minutes after its UTC day ends — after that nobody
 *              (the panel included) can link the ids back to an IP or to the
 *              next day's ids. Raw IPs are never stored.
 *
 * Uniques are exact sets of those ids per minute / hour / UTC day; a set
 * switches to a HyperLogLog sketch (p=12, 4 KiB, ≈1.6 % standard error) above
 * EXACT_MAX ids, so busy sites stay memory-safe. Sets are unions, so a visitor
 * seen in three hours of a day is one visitor for the day. Because the salt
 * rotates daily, the same person on two days is two different ids:
 *   1h  headline = union of the minute sets of the last 60 minutes;
 *   24h headline = union of the hour sets of the last 24 hours (a visitor
 *                  active both before and after midnight UTC counts twice);
 *   7d / 30d     = SUM of daily unique visitors ("visitors per day", added up —
 *                  the honest number when ids are not linkable across days).
 * Chart points are unique visitors per bucket (minute, hour or day).
 *
 * Storage: dataDir/analytics/{all,site-<id>}.json, written atomically every
 * minute when something changed (and on stop). Per key: minute buckets for
 * 26 h, hour buckets for 32 days, day buckets for 400 days ([t, requests,
 * pageViews, uniques]); the live id sets (minutes 2 h, hours 49 h, days 2 d)
 * so a restart mid-day keeps counting the same visitors once; top paths and
 * referrer hosts per hour (26 h) and per day (31 days), capped.
 *
 * Route: GET /api/analytics?range=1h|24h|7d|30d[&siteId=] (admin).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { httpError } from "./http.mjs";
import { writeFileAtomic } from "./store.mjs";

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

const KEEP = { m: 26 * HOUR, h: 32 * DAY, d: 400 * DAY };
const SETS_KEEP = { m: 2 * HOUR + 5 * MINUTE, h: 49 * HOUR, d: 2 * DAY };
const PAGES_KEEP = { h: 26 * HOUR, d: 31 * DAY };
const PAGES_CAP = { h: 400, d: 1000 }; // distinct paths/hosts kept in memory per bucket (pruned to half)
const PAGES_SAVE = { h: 60, d: 200 }; // … and persisted
const SALT_GRACE_MS = 10 * MINUTE;
const SAVE_MS = 60_000;
const TOP_N = 10;

export const RANGES = {
  "1h": { step: MINUTE, n: 60, res: "m" },
  "24h": { step: HOUR, n: 24, res: "h" },
  "7d": { step: HOUR, n: 168, res: "h" },
  "30d": { step: DAY, n: 30, res: "d" },
};

const floor = (t, step) => Math.floor(t / step) * step;

// ------------------------------------------------------------ HyperLogLog

export const HLL_P = 12;
export const HLL_M = 1 << HLL_P;
export const EXACT_MAX = 1024;
const HLL_ALPHA = 0.7213 / (1 + 1.079 / HLL_M);
const POW2NEG = Float64Array.from({ length: 34 }, (_, i) => 2 ** -i);

export function hllAdd(reg, h) {
  const i = h >>> (32 - HLL_P);
  const w = (h << HLL_P) >>> 0;
  const rank = w === 0 ? 32 - HLL_P + 1 : Math.clz32(w) + 1;
  if (rank > reg[i]) reg[i] = rank;
}

export function hllCount(reg) {
  let sum = 0;
  let zeros = 0;
  for (let i = 0; i < HLL_M; i++) {
    sum += POW2NEG[reg[i]];
    if (reg[i] === 0) zeros++;
  }
  let e = (HLL_ALPHA * HLL_M * HLL_M) / sum;
  if (e <= 2.5 * HLL_M && zeros) e = HLL_M * Math.log(HLL_M / zeros);
  else if (e > 2 ** 32 / 30) e = -(2 ** 32) * Math.log(1 - e / 2 ** 32);
  return Math.round(e);
}

/** A set of 32-bit visitor ids: exact up to EXACT_MAX, then a HyperLogLog sketch. */
export class Uniq {
  constructor() {
    this.set = new Set();
    this.reg = null;
  }
  add(h) {
    if (this.reg) return hllAdd(this.reg, h);
    this.set.add(h);
    if (this.set.size > EXACT_MAX) this.#toHll();
  }
  #toHll() {
    this.reg = new Uint8Array(HLL_M);
    for (const h of this.set) hllAdd(this.reg, h);
    this.set = null;
  }
  get exact() {
    return !this.reg;
  }
  get size() {
    return this.reg ? hllCount(this.reg) : this.set.size;
  }
  toJSON() {
    if (this.reg) return { h: Buffer.from(this.reg).toString("base64") };
    const b = Buffer.alloc(this.set.size * 4);
    let o = 0;
    for (const h of this.set) o = b.writeUInt32LE(h, o);
    return { e: b.toString("base64") };
  }
  static from(j) {
    const u = new Uniq();
    if (j?.h) {
      const b = Buffer.from(j.h, "base64");
      if (b.length === HLL_M) {
        u.reg = new Uint8Array(b);
        u.set = null;
      }
    } else if (j?.e) {
      const b = Buffer.from(j.e, "base64");
      for (let o = 0; o + 4 <= b.length; o += 4) u.add(b.readUInt32LE(o));
    }
    return u;
  }
  /** Size of the union of several Uniq. Exact when every one is exact. */
  static unionSize(list) {
    if (!list.length) return { n: 0, exact: true };
    if (list.every((u) => !u.reg)) {
      const s = new Set();
      for (const u of list) for (const h of u.set) s.add(h);
      return { n: s.size, exact: true };
    }
    const reg = new Uint8Array(HLL_M);
    for (const u of list) {
      if (u.reg) {
        for (let i = 0; i < HLL_M; i++) if (u.reg[i] > reg[i]) reg[i] = u.reg[i];
      } else for (const h of u.set) hllAdd(reg, h);
    }
    return { n: hllCount(reg), exact: false };
  }
}

export function visitorId(salt, ip, ua) {
  return crypto.createHmac("sha256", salt).update(`${ip}\n${ua}`).digest().readUInt32BE(0);
}

// ---------------------------------------------------------------- parsing

const TOKEN_RE = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function unescapeJson(s) {
  if (!s.includes("\\")) return s;
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}

/**
 * One access-log line → { v2, t, status, … } or null (blank).
 * v2 lines (fcc_v2) carry everything; fcc_main / combined lines only { t, status }.
 * Unknown non-blank lines count as a request "now" (same as CLUSTER's counter).
 */
export function parseLine(line, now = Date.now()) {
  if (!line) return null;
  if (line.endsWith("\r")) line = line.slice(0, -1);
  if (line.endsWith(" fcc2")) {
    const tok = [];
    for (const m of line.matchAll(TOKEN_RE)) tok.push(m[1] !== undefined ? unescapeJson(m[1]) : m[2]);
    if (tok.length === 15 && tok[14] === "fcc2" && /^\d{9,11}(\.\d+)?$/.test(tok[0])) {
      return {
        v2: true,
        t: Math.round(Number(tok[0]) * 1000),
        status: Number(tok[1]) || 0,
        upstream: tok[3],
        host: tok[4].toLowerCase(),
        method: tok[5],
        uri: tok[6],
        ua: tok[8],
        ip: tok[9],
        type: tok[10],
        referer: tok[11],
        dest: tok[12],
        purpose: tok[13],
      };
    }
  }
  let m = /^(\d{9,11})\.(\d{3}) (\d{3}) /.exec(line);
  if (m) return { v2: false, t: Number(m[1]) * 1000 + Number(m[2]), status: Number(m[3]) };
  m = /\[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})\] "[^"]*" (\d{3})/.exec(line);
  if (m) {
    const off = (m[7] === "-" ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9])) * 60_000;
    return { v2: false, t: Date.UTC(+m[3], MONTHS[m[2]] ?? 0, +m[1], +m[4], +m[5], +m[6]) - off, status: Number(m[10]) };
  }
  return line.trim() ? { v2: false, t: now, status: 0 } : null;
}

// ---------------------------------------------------------- classification

/**
 * Bots and tools: anything whose User-Agent contains one of these (case-insensitive),
 * an empty UA, or a UA that does not look like a browser at all (no "Mozilla/" or "Opera").
 * Add tokens here — keep them lower-case.
 */
export const BOT_UA_TOKENS = [
  // crawlers, scrapers, AI fetchers ("bot" covers googlebot, bingbot, gptbot, claudebot, …)
  "bot", "crawl", "spider", "slurp", "scrape", "archiver", "facebookexternalhit", "embedly", "feedfetcher",
  "semrush", "ahrefs", "dataprovider", "bytespider", "perplexity", "anthropic", "ccbot", "yandex", "baidu",
  // link previews in chat apps
  "preview", "whatsapp", "telegram", "discord", "slack", "skype",
  // HTTP libraries and tools
  "curl", "wget", "python", "go-http", "java/", "okhttp", "libwww", "httpclient", "axios", "node-fetch", "undici",
  "postman", "insomnia", "nmap", "zgrab", "masscan", "scanner",
  // headless browsers, audits, uptime monitors (incl. this panel's own checks)
  "headless", "phantomjs", "selenium", "puppeteer", "playwright", "lighthouse", "pagespeed", "gtmetrix",
  "pingdom", "uptime", "monitor", "statuscake", "site24x7", "check_http", "fcc-", "forthway",
];
const BOT_RE = new RegExp(BOT_UA_TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|"), "i");

export function isBot(ua) {
  if (!ua || ua === "-") return true;
  if (!/mozilla\/|opera/i.test(ua)) return true;
  return BOT_RE.test(ua);
}

const ASSET_EXT_RE =
  /\.(?:m?js|cjs|css|map|json|xml|txt|ico|png|jpe?g|gif|svg|webp|avif|bmp|tiff?|woff2?|ttf|otf|eot|mp4|webm|og[gv]|mp3|wav|flac|m4a|aac|pdf|zip|t?gz|br|zst|rar|7z|wasm|csv|tsv|rss|atom|webmanifest|apk|dmg|exe|iso|bin)$/i;
const SKIP_PREFIX_RE =
  /^\/(?:api|_next|static|assets|_nuxt|_astro|_app|build|wp-json|wp-content|wp-includes|\.well-known|cdn-cgi|socket\.io|sockjs-node|@vite|@fs|@id|node_modules|__[\w-]*)(?:\/|$)/i;
const SKIP_EXACT = new Set(["/favicon.ico", "/robots.txt", "/health", "/healthz", "/livez", "/readyz", "/ping", "/api/health", "/api/version", "/wp-admin/admin-ajax.php", "/xmlrpc.php"]);

/** Path only: no query string or fragment, at most 300 chars. */
export function pathOf(uri) {
  let p = String(uri || "");
  if (!p.startsWith("/")) {
    try {
      p = new URL(p).pathname;
    } catch {
      return "";
    }
  }
  const q = p.search(/[?#]/);
  if (q !== -1) p = p.slice(0, q);
  return p.slice(0, 300) || "/";
}

export function sitePaths(site) {
  const hp = pathOf(String(site?.healthPath || "").trim());
  return hp && hp !== "/" ? [hp] : [];
}

/** Is this request a page view? (Bots are filtered separately with isBot().) */
export function isPageView(r, p, healthPaths = []) {
  if (r.method !== "GET") return false;
  const s = r.status;
  if (!((s >= 200 && s < 300 && s !== 204 && s !== 206) || s === 304)) return false;
  if (r.dest && r.dest !== "document") return false; // Sec-Fetch-Dest: image, script, empty (fetch/XHR), iframe, …
  if (r.purpose && /prefetch|prerender/i.test(r.purpose)) return false;
  if (!p || SKIP_EXACT.has(p.toLowerCase()) || healthPaths.includes(p) || SKIP_PREFIX_RE.test(p) || ASSET_EXT_RE.test(p)) return false;
  if (/[?&]_rsc=/.test(r.uri || "")) return false; // Next.js RSC payloads
  const ct = (r.type || "").trim();
  if (ct && ct !== "-") return /^(text\/html|application\/xhtml\+xml)\b/i.test(ct);
  return true;
}

/** Referrer host, or "" for none / the site itself. */
export function refHost(referer, host, domains = []) {
  if (!referer || referer === "-") return "";
  let h;
  try {
    const u = new URL(referer);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    h = u.hostname.toLowerCase();
  } catch {
    return "";
  }
  const own = new Set([String(host || "").toLowerCase().replace(/:\d+$/, ""), ...domains.map((d) => String(d).toLowerCase())]);
  const bare = (x) => x.replace(/^www\./, "");
  for (const d of own) if (d && bare(d) === bare(h)) return "";
  return h.slice(0, 200);
}

// ------------------------------------------------------------------ module

let A = null;

export function register(router, ctx) {
  A = createAnalytics(ctx);
  ctx.analytics = A.api;
  A.routes(router);
}

export async function start() {
  A?.start();
}

export async function stop() {
  A?.stop();
}

export function createAnalytics(ctx, { now: clock = () => Date.now() } = {}) {
  const dir = path.join(ctx.dataDir, "analytics");
  const keys = new Map(); // "all" | "site:<id>" -> key state
  const salts = new Map(); // UTC day start -> Buffer
  let timers = [];
  let startedAt = null;

  const safeId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, "");
  const fileOf = (id) => path.join(dir, id === "all" ? "all.json" : `site-${safeId(id.slice(5))}.json`);

  function newKey(id) {
    return {
      id,
      since: clock(),
      visitorsSince: null,
      m: new Map(), h: new Map(), d: new Map(), // t -> [requests, pageViews, uniques]
      ms: new Map(), hs: new Map(), ds: new Map(), // t -> Uniq
      ph: new Map(), pd: new Map(), rh: new Map(), rd: new Map(), // t -> Map(path|host -> count)
      dirty: true,
    };
  }
  const key = (id) => {
    let k = keys.get(id);
    if (!k) keys.set(id, (k = newKey(id)));
    return k;
  };

  // ------------------------------------------------------------ salts

  const saltFile = () => path.join(dir, "salt.json");
  function loadSalts() {
    try {
      const j = JSON.parse(fs.readFileSync(saltFile(), "utf8"));
      for (const [d, hex] of Object.entries(j.salts || {})) if (/^[0-9a-f]{64}$/.test(hex)) salts.set(Number(d), Buffer.from(hex, "hex"));
    } catch {
      /* none yet */
    }
    pruneSalts();
  }
  function saveSalts() {
    try {
      const out = {};
      for (const [d, b] of salts) out[d] = b.toString("hex");
      writeFileAtomic(saltFile(), JSON.stringify({ v: 1, note: "daily random salts for visitor ids; deleted after the day", salts: out }), 0o600);
    } catch (err) {
      console.warn("[analytics] could not save salt:", err.message);
    }
  }
  function pruneSalts() {
    const now = clock();
    const today = floor(now, DAY);
    let changed = false;
    for (const d of [...salts.keys()]) {
      if (d > today || d < today - DAY || (d < today && now - today >= SALT_GRACE_MS)) {
        salts.delete(d);
        changed = true;
      }
    }
    if (changed) saveSalts();
  }
  /** Salt for the UTC day of t: today, or yesterday during the grace period. null = too old. */
  function saltFor(day) {
    const now = clock();
    const today = floor(now, DAY);
    if (day > today || day < today - DAY || (day < today && now - today >= SALT_GRACE_MS)) return null;
    let s = salts.get(day);
    if (!s) {
      s = crypto.randomBytes(32);
      salts.set(day, s);
      saveSalts();
    }
    return s;
  }

  // ----------------------------------------------------------- ingest

  function bump(map, t, i) {
    let b = map.get(t);
    if (!b) map.set(t, (b = [0, 0, 0]));
    b[i]++;
  }
  function addCount(byT, t, name, cap) {
    let m = byT.get(t);
    if (!m) byT.set(t, (m = new Map()));
    m.set(name, (m.get(name) || 0) + 1);
    if (m.size > cap) {
      const keep = [...m].sort((a, b) => b[1] - a[1]).slice(0, cap >> 1);
      m.clear();
      for (const [k, v] of keep) m.set(k, v);
    }
  }

  /** Feed new access-log lines of one website (called by CLUSTER's tailer). */
  function ingest(site, lines) {
    if (!site?.id || !lines?.length) return;
    const now = clock();
    const ks = [key(`site:${site.id}`), key("all")];
    const sk = ks[0];
    const health = sitePaths(site);
    const domains = Array.isArray(site.domains) ? site.domains : [];
    const touched = new Map();
    for (const line of lines) {
      const r = parseLine(line, now);
      if (!r) continue;
      let t = r.t;
      if (!(t > 0) || t > now + 2 * MINUTE) t = now;
      if (t < now - KEEP.d) continue;
      const tm = floor(t, MINUTE);
      const th = floor(t, HOUR);
      const td = floor(t, DAY);
      for (const k of ks) {
        if (t >= now - KEEP.m) bump(k.m, tm, 0);
        if (t >= now - KEEP.h) bump(k.h, th, 0);
        bump(k.d, td, 0);
        k.dirty = true;
        if (r.v2 && !k.visitorsSince) k.visitorsSince = now;
      }
      if (!r.v2 || isBot(r.ua)) continue;
      const p = pathOf(r.uri);
      if (!isPageView(r, p, health)) continue;
      for (const k of ks) {
        if (t >= now - KEEP.m) bump(k.m, tm, 1);
        if (t >= now - KEEP.h) bump(k.h, th, 1);
        bump(k.d, td, 1);
      }
      if (t >= now - PAGES_KEEP.h) addCount(sk.ph, th, p, PAGES_CAP.h);
      if (t >= now - PAGES_KEEP.d) addCount(sk.pd, td, p, PAGES_CAP.d);
      const ref = refHost(r.referer, r.host, domains);
      if (ref) {
        if (t >= now - PAGES_KEEP.h) addCount(sk.rh, th, ref, PAGES_CAP.h);
        if (t >= now - PAGES_KEEP.d) addCount(sk.rd, td, ref, PAGES_CAP.d);
      }
      const salt = r.ip ? saltFor(td) : null;
      if (!salt) continue;
      const vid = visitorId(salt, r.ip, r.ua);
      for (const k of ks) {
        for (const [res, bt] of [["m", tm], ["h", th], ["d", td]]) {
          if (bt < now - SETS_KEEP[res]) continue;
          const sets = k[`${res}s`];
          let u = sets.get(bt);
          if (!u) sets.set(bt, (u = new Uniq()));
          u.add(vid);
          touched.set(`${k.id}|${res}|${bt}`, [k, res, bt]);
        }
      }
    }
    for (const [k, res, bt] of touched.values()) {
      let b = k[res].get(bt);
      if (!b) k[res].set(bt, (b = [0, 0, 0]));
      b[2] = k[`${res}s`].get(bt).size;
    }
  }

  // --------------------------------------------------------- retention

  function prune() {
    const now = clock();
    const cut = (map, keep) => {
      for (const t of map.keys()) if (t < now - keep) map.delete(t);
    };
    for (const k of keys.values()) {
      cut(k.m, KEEP.m);
      cut(k.h, KEEP.h);
      cut(k.d, KEEP.d);
      cut(k.ms, SETS_KEEP.m);
      cut(k.hs, SETS_KEEP.h);
      cut(k.ds, SETS_KEEP.d);
      cut(k.ph, PAGES_KEEP.h);
      cut(k.rh, PAGES_KEEP.h);
      cut(k.pd, PAGES_KEEP.d);
      cut(k.rd, PAGES_KEEP.d);
    }
    pruneSalts();
  }

  // ------------------------------------------------------------ query

  const sumWeighted = (map, step, a, b) => {
    let r = 0;
    let p = 0;
    for (const [t, v] of map) {
      const lo = Math.max(t, a);
      const hi = Math.min(t + step, b);
      if (hi <= lo) continue;
      const f = (hi - lo) / step;
      r += v[0] * f;
      p += v[1] * f;
    }
    return { requests: Math.round(r), pageViews: Math.round(p) };
  };

  /** Like sumWeighted over day buckets, but partly covered days use their hour buckets while those are kept. */
  const sumDays = (k, a, b) => {
    let r = 0;
    let p = 0;
    for (const [d, v] of k.d) {
      if (d + DAY <= a || d >= b) continue;
      if (d >= a && d + DAY <= b) {
        r += v[0];
        p += v[1];
      } else if (d >= clock() - KEEP.h) {
        const part = sumWeighted(new Map([...k.h].filter(([t]) => t >= d && t < d + DAY)), HOUR, a, b);
        r += part.requests;
        p += part.pageViews;
      } else {
        const f = (Math.min(d + DAY, b) - Math.max(d, a)) / DAY;
        r += v[0] * f;
        p += v[1] * f;
      }
    }
    return { requests: Math.round(r), pageViews: Math.round(p) };
  };

  /** Union of the id sets of buckets starting in [a, b); buckets whose set is gone add their stored count. */
  const unionUniques = (sets, map, a, b) => {
    const list = [];
    let extra = 0;
    let fallback = false;
    for (const [t, v] of map) {
      if (t < a || t >= b || !v[2]) continue;
      const u = sets.get(t);
      if (u) list.push(u);
      else {
        extra += v[2];
        fallback = true;
      }
    }
    const { n, exact } = Uniq.unionSize(list);
    return { n: n + extra, exact: exact && !fallback };
  };

  /** Σ daily uniques over [a, b); partly covered days are weighted by their share of the day's page views. */
  const dailySum = (k, a, b) => {
    let n = 0;
    for (const [d, v] of k.d) {
      if (!v[2] || d + DAY <= a || d >= b) continue;
      if (d >= a && d + DAY <= b) {
        n += v[2];
        continue;
      }
      let f = (Math.min(d + DAY, b) - Math.max(d, a)) / DAY;
      if (v[1] && d >= clock() - KEEP.h) {
        let inside = 0;
        for (let t = d; t < d + DAY; t += HOUR) {
          const hb = k.h.get(t);
          if (hb) inside += hb[1] * Math.max(0, Math.min(t + HOUR, b) - Math.max(t, a)) / HOUR;
        }
        f = Math.min(1, inside / v[1]);
      }
      n += v[2] * f;
    }
    return Math.round(n);
  };

  function totals(k, range, a, b) {
    const R = RANGES[range];
    if (!k) return { requests: 0, pageViews: 0, uniques: 0, exact: true };
    const out = R.res === "d" ? sumDays(k, a, b) : sumWeighted(k[R.res], R.step, a, b);
    if (range === "1h" || range === "24h") {
      const u = range === "1h" ? unionUniques(k.ms, k.m, a, b) : unionUniques(k.hs, k.h, a, b);
      return { ...out, uniques: u.n, exact: u.exact };
    }
    return { ...out, uniques: dailySum(k, a, b), exact: false };
  }

  function topOf(byT, a, n = TOP_N) {
    const sum = new Map();
    for (const [t, m] of byT) {
      if (t < a) continue;
      for (const [name, c] of m) sum.set(name, (sum.get(name) || 0) + c);
    }
    return [...sum].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, n);
  }

  const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

  /**
   * { range, step, from, to, now, siteId, since, visitorsSince, uniquesMethod,
   *   series: [{ t, requests, pageViews, uniques }], previousSeries: (same, t shifted forward one period),
   *   totals, previous, change: { requests, pageViews, uniques } (% or null),
   *   topPages: [{ path, views }], topReferrers: [{ host, visits }], topSites (all sites only) }
   */
  function query({ range = "24h", siteId = null } = {}) {
    if (!RANGES[range]) range = "24h";
    const R = RANGES[range];
    const now = clock();
    const k = keys.get(siteId ? `site:${siteId}` : "all") || null;
    const to = floor(now, R.step);
    const from = to - (R.n - 1) * R.step;
    const len = R.n * R.step;
    const row = (t, shift = 0) => {
      const b = k?.[R.res].get(t);
      return { t: t + shift, requests: b?.[0] || 0, pageViews: b?.[1] || 0, uniques: b?.[2] || 0 };
    };
    const series = [];
    const previousSeries = [];
    for (let t = from; t <= to; t += R.step) {
      series.push(row(t));
      previousSeries.push(row(t - len, len));
    }
    const cur = totals(k, range, from, to + R.step);
    const prev = totals(k, range, from - len, now - len);
    const out = {
      range,
      step: R.step,
      from,
      to,
      now,
      siteId: siteId || null,
      since: k?.since ? new Date(k.since).toISOString() : startedAt ? new Date(startedAt).toISOString() : null,
      visitorsSince: k?.visitorsSince ? new Date(k.visitorsSince).toISOString() : null,
      uniquesMethod: range === "7d" || range === "30d" ? "daily-sum" : cur.exact ? "exact" : "estimate",
      series,
      previousSeries,
      totals: { requests: cur.requests, pageViews: cur.pageViews, uniques: cur.uniques },
      previous: { requests: prev.requests, pageViews: prev.pageViews, uniques: prev.uniques },
      change: { requests: pct(cur.requests, prev.requests), pageViews: pct(cur.pageViews, prev.pageViews), uniques: pct(cur.uniques, prev.uniques) },
    };
    // No % change while the previous period predates collection (it would compare against a partial period).
    const prevFrom = from - len;
    if (!k?.since || k.since > prevFrom) out.change.requests = null;
    if (!k?.visitorsSince || k.visitorsSince > prevFrom) out.change.pageViews = out.change.uniques = null;
    if (siteId) {
      const hourly = R.res !== "d" && range !== "7d";
      out.topPages = topOf(k ? (hourly ? k.ph : k.pd) : new Map(), hourly ? floor(from, HOUR) : floor(from, DAY)).map(([p, views]) => ({ path: p, views }));
      out.topReferrers = topOf(k ? (hourly ? k.rh : k.rd) : new Map(), hourly ? floor(from, HOUR) : floor(from, DAY)).map(([host, visits]) => ({ host, visits }));
    } else {
      const rows = [];
      for (const [id, sk] of keys) {
        if (!id.startsWith("site:")) continue;
        const s = ctx.db?.get?.("sites", id.slice(5));
        if (!s) continue;
        const t = totals(sk, range, from, to + R.step);
        if (t.requests) rows.push({ siteId: s.id, name: s.name, uniques: t.uniques, pageViews: t.pageViews, requests: t.requests });
      }
      out.topSites = rows.sort((a, b) => b.uniques - a.uniques || b.pageViews - a.pageViews || b.requests - a.requests).slice(0, TOP_N);
    }
    return out;
  }

  // ------------------------------------------------------- persistence

  const rows = (map) => [...map].sort((a, b) => a[0] - b[0]).map(([t, v]) => [t, v[0], v[1], v[2]]);
  const setsOut = (map) => [...map].map(([t, u]) => [t, u.toJSON()]);
  const topsOut = (byT, n) => [...byT].map(([t, m]) => [t, [...m].sort((a, b) => b[1] - a[1]).slice(0, n)]);

  function serialize(k) {
    return JSON.stringify({
      v: 1,
      id: k.id,
      since: k.since,
      visitorsSince: k.visitorsSince,
      savedAt: clock(),
      m: rows(k.m), h: rows(k.h), d: rows(k.d),
      ms: setsOut(k.ms), hs: setsOut(k.hs), ds: setsOut(k.ds),
      ph: topsOut(k.ph, PAGES_SAVE.h), pd: topsOut(k.pd, PAGES_SAVE.d), rh: topsOut(k.rh, PAGES_SAVE.h), rd: topsOut(k.rd, PAGES_SAVE.d),
    });
  }

  function restore(j) {
    if (!j || j.v !== 1 || typeof j.id !== "string" || !(j.id === "all" || j.id.startsWith("site:"))) return;
    const k = newKey(j.id);
    k.since = Number(j.since) || clock();
    k.visitorsSince = Number(j.visitorsSince) || null;
    for (const res of ["m", "h", "d"]) {
      for (const [t, r, p, u] of j[res] || []) k[res].set(Number(t), [r | 0, p | 0, u | 0]);
      for (const [t, u] of j[`${res}s`] || []) k[`${res}s`].set(Number(t), Uniq.from(u));
    }
    for (const f of ["ph", "pd", "rh", "rd"]) for (const [t, list] of j[f] || []) k[f].set(Number(t), new Map(list));
    k.dirty = false;
    keys.set(k.id, k);
  }

  function load() {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /^(all|site-[A-Za-z0-9_-]+)\.json$/.test(f));
    } catch {
      /* first boot */
    }
    for (const f of files) {
      try {
        restore(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
      } catch (err) {
        console.warn(`[analytics] ignoring unreadable ${f}: ${err.message}`);
      }
    }
    loadSalts();
    prune();
  }

  function save({ all = false } = {}) {
    for (const [id, k] of keys) {
      if (id.startsWith("site:") && ctx.db && !ctx.db.get("sites", id.slice(5))) {
        keys.delete(id); // website deleted
        try {
          fs.rmSync(fileOf(id), { force: true });
        } catch {
          /* gone */
        }
        continue;
      }
      if (!k.dirty && !all) continue;
      try {
        writeFileAtomic(fileOf(id), serialize(k), 0o600);
        k.dirty = false;
      } catch (err) {
        console.warn(`[analytics] could not save ${id}:`, err.message);
      }
    }
  }

  // ----------------------------------------------------------- routes

  function routes(router) {
    router.get("/api/analytics", (req, res, { query: q }) => {
      const range = String(q.range || "24h");
      if (!RANGES[range]) throw httpError(400, "range must be one of 1h, 24h, 7d, 30d");
      const siteId = q.siteId ? String(q.siteId) : null;
      if (siteId && ctx.db && !ctx.db.get("sites", siteId)) throw httpError(404, "Website not found");
      return query({ range, siteId });
    });
  }

  function startTimers() {
    startedAt = clock();
    if (!keys.has("all")) key("all");
    const t = setInterval(() => {
      try {
        prune();
        save();
      } catch (err) {
        console.warn("[analytics] tick:", err.message);
      }
    }, SAVE_MS);
    t.unref?.();
    timers.push(t);
  }

  load();

  return {
    api: { ingest, query, save, prune, _keys: keys, _salts: salts },
    routes,
    start: startTimers,
    stop() {
      for (const t of timers) clearInterval(t);
      timers = [];
      save();
    },
  };
}
