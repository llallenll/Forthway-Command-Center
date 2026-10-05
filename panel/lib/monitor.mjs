/**
 * MONITOR — website uptime monitoring + SMS alerts through Bird (bird.com).
 *
 * Checks (from the main server, default every 60 s, 10 s timeout):
 *   custom URL (per-site setting) → first domain (https when the site's
 *   certificate is active or the domain goes through a Cloudflare tunnel) →
 *   no domain: the first upstream's address:port (main = 127.0.0.1).
 *   Path = per-site path → site.healthPath → "/". Redirects are not followed;
 *   a check passes when the status is inside the expected range (200–399).
 *   A site is DOWN after `failThreshold` (3) failed checks in a row and UP
 *   again after `recoverThreshold` (2) good ones. Sites that were never
 *   deployed are "pending" (not checked) unless they have a custom URL.
 *   The load balancer's per-server health (ctx.lb.upstreams) is folded in:
 *   an up site with an unhealthy upstream is reported as `degraded`.
 *
 * Storage (db.json stays small):
 *   dataDir/monitor/state.json                 runtime state per site, SMS rate-limit map,
 *                                              heartbeat (savedAt) and "panel offline" gaps
 *   dataDir/monitor/sites/<siteId>/<UTC day>.json
 *        { v, day, s: 1440 chars, r: [1440 ints] }  one bucket per minute:
 *        "." no data · "u" up · "f" failed check (not yet down) · "d" down · "p" paused;
 *        r = average response time (ms) of good checks in that minute (0 = none).
 *        Files older than 90 days are deleted.
 *   db collection `monitors`  { id: siteId, …settings }   (per-site settings)
 *   db collection `incidents` { id, siteId, startedAt, confirmedAt, endedAt, durationMs,
 *        cause, lastCause, servers, notify: { [phone]: { lastAt, ok, name } }, alerts: [...], gaps: [...] }
 *
 * Uptime % = (u + f) / (u + f + d) over minutes with data. When the panel was
 * not running nothing is recorded ("no data"), and the gap is listed on the
 * site and on any incident that was open at the time.
 *
 * SMS (config.json `notifications`): when a site goes DOWN every recipient of
 * the site plus the default recipients (deduplicated) gets a text, then again
 * every `repeatMinutes` (60) while it stays down, and one "back up" text on
 * recovery (`notifyRecovery`). Never more than one text per recipient per site
 * per 10 minutes, except recovery texts. Every attempt is logged on the incident
 * and in the activity log. Sending never throws into the monitoring loop.
 * FCC_DRY_RUN=1 never calls Bird: sends are logged and recorded as simulated.
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";

import { httpError } from "./http.mjs";
import * as sys from "./sys.mjs";
import { writeFileAtomic } from "./store.mjs";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const KEEP_DAYS = 90;
const PER_DAY = 1440;
const TICK_MS = 1000;
const FLUSH_MS = 15_000;
const UPDATE_EVENT_MS = 5000;
const MAX_CONCURRENT = 16;
const GAP_AFTER_MS = 90_000; // heartbeat older than this at boot = the panel was offline
const MIN_INTERVAL_SEC = sys.DRY_RUN ? 2 : 10;
const SMS_MIN_GAP_MS = Number(process.env.FCC_MONITOR_SMS_MIN_GAP_SEC) > 0 ? Number(process.env.FCC_MONITOR_SMS_MIN_GAP_SEC) * 1000 : 10 * MINUTE;
const SMS_TIMEOUT_MS = 15_000;
const MAX_RECIPIENTS = 25;
const MAX_ALERTS_PER_INCIDENT = 300;
const MAX_INCIDENTS_PER_SITE = 300;

const DEFAULTS = Object.freeze({
  intervalSec: 60,
  timeoutSec: 10,
  failThreshold: 3,
  recoverThreshold: 2,
  expectMin: 200,
  expectMax: 399,
  path: "",
  url: "",
  smsEnabled: false,
  recipients: [],
  includeDefaults: true,
  repeatMinutes: null, // null = the panel-wide default
  paused: false,
});

const NOTIF_DEFAULTS = Object.freeze({ enabled: false, repeatMinutes: 60, notifyRecovery: true, defaults: [], bird: {} });

export const PHONE_RE = /^\+[1-9]\d{6,14}$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;
const ID_RE = /^[A-Za-z0-9-]{1,80}$/;
const CODE = { none: 46, u: 117, f: 102, d: 100, p: 112 }; // ".", "u", "f", "d", "p"
const RANK = { 46: 0, 112: 1, 117: 2, 102: 3, 100: 4 };

// ------------------------------------------------------------------ helpers

const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const dayStart = (key) => Date.parse(`${key}T00:00:00Z`);
const minuteOf = (t) => Math.floor((t % DAY) / MINUTE);
const floorTo = (t, step) => Math.floor(t / step) * step;
const iso = (t) => new Date(t).toISOString();
const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};
const cleanStr = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);

/** "+1 (555) 123-4567" → "+15551234567"; returns "" when it isn't E.164. */
export function normalizePhone(v) {
  let s = String(v ?? "").trim().replace(/[\s().\-]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  return PHONE_RE.test(s) ? s : "";
}

function maskPhone(p) {
  const s = String(p || "");
  return s.length > 6 ? `${s.slice(0, 4)}***${s.slice(-2)}` : "***";
}

export function fmtDuration(ms) {
  const m = Math.max(0, Math.round(ms / MINUTE));
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
}

function shortTime(t) {
  try {
    return new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" });
  } catch {
    return iso(t).slice(11, 16) + " UTC";
  }
}

/** GSM-7 friendly, single segment (≤ 160 chars). */
function smsText(s) {
  const plain = String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7e\n]/g, "");
  return plain.length > 160 ? `${plain.slice(0, 157)}...` : plain;
}
const cut = (s, n) => {
  const t = String(s || "");
  return t.length > n ? `${t.slice(0, n - 1)}~` : t;
};

export function buildMessage(kind, { name, domain, cause, since, durationMs, panelName } = {}) {
  const who = `${cut(name, 30)}${domain ? ` (${cut(domain, 40)})` : ""}`;
  if (kind === "down") return smsText(`DOWN: ${who}. Cause: ${cut(cause || "unknown", 40)}. Since ${shortTime(since)}.`);
  if (kind === "reminder") return smsText(`STILL DOWN: ${who}, down ${fmtDuration(durationMs)}. Cause: ${cut(cause || "unknown", 40)}.`);
  if (kind === "up") return smsText(`RESOLVED: ${who} is back up after ${fmtDuration(durationMs)}.`);
  return smsText(`Test from ${cut(panelName || "Forthway Command Center", 40)}: website alert texts are working.`);
}

function describeError(err) {
  const code = err?.code || err?.cause?.code || "";
  const map = {
    ENOTFOUND: "DNS lookup failed",
    EAI_AGAIN: "DNS lookup failed",
    ECONNREFUSED: "connection refused",
    ECONNRESET: "connection reset",
    EHOSTUNREACH: "host unreachable",
    ENETUNREACH: "network unreachable",
    EPIPE: "connection closed",
    ERR_INVALID_URL: "invalid URL",
  };
  if (map[code]) return map[code];
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) return `SSL certificate error (${code})`;
  return cleanStr(code || err?.message || "request failed", 80);
}

/**
 * One HTTP(S) request. Response time = time to response headers. The body is
 * not read; redirects are not followed (3xx is inside the default range).
 */
export function probe(url, { timeoutMs = 10_000, expectMin = 200, expectMax = 399 } = {}) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) throw new Error("bad protocol");
    } catch {
      return resolve({ ok: false, status: null, ms: 0, error: "invalid URL" });
    }
    const mod = u.protocol === "https:" ? https : http;
    const started = Date.now();
    let done = false;
    let req = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { req?.destroy(); } catch { /* closed */ }
      resolve({ ms: Date.now() - started, ...r });
    };
    const timer = setTimeout(() => finish({ ok: false, status: null, error: `timed out after ${Math.round(timeoutMs / 1000)}s` }), timeoutMs);
    try {
      req = mod.request(
        u,
        {
          method: "GET",
          agent: false,
          headers: { "User-Agent": "ForthwayCommandCenter-Uptime/3", Accept: "*/*", "Cache-Control": "no-cache", Connection: "close" },
        },
        (res) => {
          const status = res.statusCode;
          const ok = status >= expectMin && status <= expectMax;
          res.resume();
          finish({ ok, status, error: ok ? null : `HTTP ${status}` });
        },
      );
      req.on("error", (err) => finish({ ok: false, status: null, error: describeError(err) }));
      req.end();
    } catch (err) {
      finish({ ok: false, status: null, error: describeError(err) });
    }
  });
}

// --------------------------------------------------------------------- Bird

/**
 * Builds the HTTP request for one SMS. Two Bird APIs exist and are picked by
 * the key's shape:
 *   - Bird platform API (keys "bk_<region>_…"):
 *       POST https://<region>.platform.bird.com/v1/sms/messages
 *       Authorization: Bearer <key>
 *       { to, from, text, category: "transactional" }
 *   - Channels API (workspace access keys):
 *       POST https://api.bird.com/workspaces/<workspaceId>/channels/<channelId>/messages
 *       Authorization: AccessKey <key>
 *       { receiver: { contacts: [{ identifierValue }] }, body: { type: "text", text: { text } } }
 * Throws (with a user-facing message) when the configuration is incomplete.
 * The returned headers contain the key — never log them.
 */
export function birdRequest(cfg, to, text) {
  const key = String(cfg?.accessKey || "").trim();
  if (!key) throw new Error("Add the Bird access key in Settings → Notifications.");
  if (/[\s\r\n]/.test(key)) throw new Error("The Bird access key contains spaces.");
  if (!PHONE_RE.test(to)) throw new Error(`${to} is not an E.164 phone number.`);
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  const platform = /^bk_([a-z0-9]{2,12})_/i.exec(key);
  if (platform) {
    const from = String(cfg.from || "").trim();
    if (!from) throw new Error("Bird platform keys need a sender (an E.164 number you own or an alphanumeric sender ID).");
    return {
      api: "platform",
      method: "POST",
      url: `https://${platform[1].toLowerCase()}.platform.bird.com/v1/sms/messages`,
      headers: { ...headers, Authorization: `Bearer ${key}` },
      body: { to, from, text, category: "transactional" },
    };
  }
  const ws = String(cfg.workspaceId || "").trim();
  const ch = String(cfg.channelId || "").trim();
  if (!ID_RE.test(ws)) throw new Error("Add the Bird workspace ID in Settings → Notifications.");
  if (!ID_RE.test(ch)) throw new Error("Add the Bird SMS channel ID in Settings → Notifications.");
  return {
    api: "channels",
    method: "POST",
    url: `https://api.bird.com/workspaces/${encodeURIComponent(ws)}/channels/${encodeURIComponent(ch)}/messages`,
    headers: { ...headers, Authorization: `AccessKey ${key}` },
    body: { receiver: { contacts: [{ identifierValue: to }] }, body: { type: "text", text: { text } } },
  };
}

/** Readable error from a Bird error body (both APIs), without echoing secrets. */
export function birdError(status, bodyText, key) {
  let msg = "";
  try {
    const j = JSON.parse(bodyText);
    const parts = [j.message, j.error?.message, typeof j.error === "string" ? j.error : "", j.detail, j.title, j.code, j.error?.code]
      .filter((x) => typeof x === "string" && x);
    msg = [...new Set(parts)].slice(0, 2).join(" — ");
    if (!msg && Array.isArray(j.errors)) msg = j.errors.map((e) => e.message || e.description || e.code).filter(Boolean).slice(0, 2).join("; ");
  } catch {
    msg = cleanStr(bodyText, 160);
  }
  let out = `Bird HTTP ${status}${msg ? `: ${msg}` : ""}`;
  if (key) out = out.split(key).join("***");
  return cleanStr(out, 300);
}

// ------------------------------------------------------------ minute store

/**
 * Per-site, per-UTC-day minute buckets. Open days are kept in memory; past
 * days are reduced to hourly aggregates (cached) and their raw arrays evicted.
 */
function createDayStore(root) {
  const open = new Map(); // `${siteId}|${day}` -> { s: Uint8Array, r: Uint32Array, c: Uint16Array, dirty, touched }
  const aggs = new Map(); // `${siteId}|${day}` -> { hours: [{ u, f, d, p, sum, cnt }] }
  const safe = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, "");
  const dir = (siteId) => path.join(root, safe(siteId));
  const file = (siteId, day) => path.join(dir(siteId), `${day}.json`);

  function load(siteId, day) {
    const key = `${siteId}|${day}`;
    let e = open.get(key);
    if (e) {
      e.touched = Date.now();
      return e;
    }
    e = { s: new Uint8Array(PER_DAY).fill(CODE.none), r: new Uint32Array(PER_DAY), c: new Uint16Array(PER_DAY), dirty: false, touched: Date.now() };
    try {
      const j = JSON.parse(fs.readFileSync(file(siteId, day), "utf8"));
      const s = String(j.s || "");
      for (let i = 0; i < PER_DAY && i < s.length; i++) {
        const code = s.charCodeAt(i);
        e.s[i] = code in RANK ? code : CODE.none;
      }
      if (Array.isArray(j.r)) for (let i = 0; i < PER_DAY && i < j.r.length; i++) {
        const v = Number(j.r[i]) || 0;
        e.r[i] = v > 0 ? Math.min(v, 4e9) : 0;
        e.c[i] = v > 0 ? 1 : 0;
      }
    } catch { /* no file yet (or unreadable) = no data */ }
    open.set(key, e);
    return e;
  }

  function set(siteId, t, code, ms) {
    const day = dayKey(t);
    const e = load(siteId, day);
    const m = minuteOf(t);
    if (RANK[code] >= RANK[e.s[m]]) e.s[m] = code;
    if (ms != null && ms >= 0) {
      const n = e.c[m];
      e.r[m] = Math.round((e.r[m] * n + Math.max(1, ms)) / (n + 1));
      e.c[m] = Math.min(65535, n + 1);
    }
    e.dirty = true;
    aggs.delete(`${siteId}|${day}`);
  }

  /** Visit every minute in [from, to) — fn(entry, minuteIndex, t). */
  function each(siteId, from, to, fn) {
    let t = floorTo(from, MINUTE);
    while (t < to) {
      const day = dayKey(t);
      const end = Math.min(to, dayStart(day) + DAY);
      const e = load(siteId, day);
      for (; t < end; t += MINUTE) fn(e, minuteOf(t), t);
    }
  }

  /** Fill minutes in [from, to) that have no data yet. */
  function fill(siteId, from, to, code) {
    each(siteId, from, to, (e, m, t) => {
      if (e.s[m] === CODE.none) {
        e.s[m] = code;
        e.dirty = true;
        aggs.delete(`${siteId}|${dayKey(t)}`);
      }
    });
  }

  function recode(siteId, from, to, fromCode, toCode) {
    each(siteId, from, to, (e, m, t) => {
      if (e.s[m] === fromCode) {
        e.s[m] = toCode;
        e.dirty = true;
        aggs.delete(`${siteId}|${dayKey(t)}`);
      }
    });
  }

  function agg(siteId, day) {
    const key = `${siteId}|${day}`;
    const today = dayKey(Date.now());
    if (day !== today && aggs.has(key)) return aggs.get(key);
    const e = load(siteId, day);
    const hours = Array.from({ length: 24 }, () => ({ u: 0, f: 0, d: 0, p: 0, sum: 0, cnt: 0 }));
    for (let m = 0; m < PER_DAY; m++) {
      const h = hours[(m / 60) | 0];
      const c = e.s[m];
      if (c === CODE.u) h.u++;
      else if (c === CODE.f) h.f++;
      else if (c === CODE.d) h.d++;
      else if (c === CODE.p) h.p++;
      if (e.r[m]) {
        h.sum += e.r[m];
        h.cnt++;
      }
    }
    const a = { hours };
    if (day !== today) {
      aggs.set(key, a);
      if (!e.dirty && day !== dayKey(Date.now() - DAY)) open.delete(key); // raw no longer needed
    }
    return a;
  }

  function flush() {
    for (const [key, e] of open) {
      if (!e.dirty) continue;
      const [siteId, day] = key.split("|");
      try {
        writeFileAtomic(file(siteId, day), JSON.stringify({ v: 1, day, s: String.fromCharCode(...e.s), r: Array.from(e.r) }), 0o600);
        e.dirty = false;
      } catch (err) {
        console.warn(`[monitor] could not write ${file(siteId, day)}: ${err.message}`);
      }
    }
    const now = Date.now();
    const keep = new Set([dayKey(now), dayKey(now - DAY)]);
    for (const [key, e] of open) if (!e.dirty && !keep.has(key.split("|")[1]) && now - e.touched > 2 * MINUTE) open.delete(key);
  }

  function prune(siteIds) {
    const oldest = dayKey(Date.now() - KEEP_DAYS * DAY);
    let names = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      return;
    }
    for (const name of names) {
      const d = path.join(root, name);
      if (!siteIds.has(name)) {
        fs.rmSync(d, { recursive: true, force: true });
        continue;
      }
      let files = [];
      try {
        files = fs.readdirSync(d);
      } catch {
        continue;
      }
      for (const f of files) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < oldest) fs.rmSync(path.join(d, f), { force: true });
    }
    for (const key of [...aggs.keys()]) if (key.split("|")[1] < oldest) aggs.delete(key);
  }

  function dropSite(siteId) {
    for (const key of [...open.keys()]) if (key.startsWith(`${siteId}|`)) open.delete(key);
    for (const key of [...aggs.keys()]) if (key.startsWith(`${siteId}|`)) aggs.delete(key);
    try {
      fs.rmSync(dir(siteId), { recursive: true, force: true });
    } catch { /* gone */ }
  }

  return { load, set, each, fill, recode, agg, flush, prune, dropSite };
}

// ------------------------------------------------------------------ module

let mon = null;

export function register(router, ctx) {
  mon = createMonitor(ctx);
  ctx.monitor = mon.api;
  mon.routes(router);
}

export async function start() {
  await mon?.start();
}

export async function stop() {
  mon?.stop();
}

function createMonitor(ctx) {
  const { db } = ctx;
  const root = path.join(ctx.dataDir, "monitor");
  const statePath = path.join(root, "state.json");
  const days = createDayStore(path.join(root, "sites"));
  const rt = new Map(); // siteId -> runtime
  let rate = {}; // `${siteId}|${phone}` -> last non-recovery send (ms)
  let gaps = []; // [{ from, to }] panel offline
  const inFlight = new Set();
  const sending = new Set();
  const changed = new Set();
  const timers = [];
  let lastTestAt = 0;
  let stateDirty = false;

  // ---------------------------------------------------------- settings

  function monitorRecord(siteId) {
    return db.get("monitors", siteId);
  }
  function settingsFor(siteId) {
    const rec = monitorRecord(siteId) || {};
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (rec[k] !== undefined) out[k] = rec[k];
    for (const k of ["pausedAt", "pausedBy", "pauseUntil", "pauseReason"]) out[k] = rec[k] ?? null;
    return out;
  }
  function saveSettings(siteId, patch) {
    if (monitorRecord(siteId)) return db.update("monitors", siteId, patch);
    return db.insert("monitors", { id: siteId, siteId, ...patch });
  }

  function notif() {
    const n = ctx.config.notifications || {};
    return { ...NOTIF_DEFAULTS, ...n, bird: { ...(n.bird || {}) } };
  }
  function birdKey() {
    const enc = ctx.config.notifications?.bird?.accessKeyEnc;
    if (!enc) return "";
    try {
      return ctx.secrets.decrypt(enc);
    } catch {
      return "";
    }
  }
  function birdConfig() {
    const n = notif();
    return { accessKey: birdKey(), workspaceId: n.bird.workspaceId || "", channelId: n.bird.channelId || "", from: n.bird.from || "" };
  }
  function birdStatus() {
    const cfg = birdConfig();
    try {
      const r = birdRequest(cfg, "+15550000000", "x");
      return { configured: true, api: r.api, problem: null };
    } catch (err) {
      return { configured: false, api: /^bk_/i.test(cfg.accessKey) ? "platform" : cfg.accessKey ? "channels" : null, problem: err.message };
    }
  }

  function sanitizeRecipients(list, label) {
    if (list == null) return [];
    if (!Array.isArray(list)) throw httpError(400, `${label} must be a list.`);
    const out = [];
    const seen = new Set();
    for (const item of list) {
      const raw = typeof item === "string" ? item : item?.phone;
      const name = typeof item === "string" ? "" : cleanStr(item?.name, 60);
      if (!String(raw ?? "").trim() && !name) continue;
      const phone = normalizePhone(raw);
      if (!phone) throw httpError(400, `"${cleanStr(raw, 40)}" is not a valid phone number. Use international (E.164) format, like +15551234567.`);
      if (seen.has(phone)) continue;
      seen.add(phone);
      out.push({ name, phone });
    }
    if (out.length > MAX_RECIPIENTS) throw httpError(400, `${label}: at most ${MAX_RECIPIENTS} numbers.`);
    return out;
  }

  function recipientsFor(siteId) {
    const s = settingsFor(siteId);
    const n = notif();
    const all = [...(s.recipients || []), ...(s.includeDefaults !== false ? n.defaults || [] : [])];
    const out = new Map();
    for (const r of all) {
      const phone = normalizePhone(r?.phone);
      if (phone && !out.has(phone)) out.set(phone, { phone, name: r.name || "" });
    }
    return [...out.values()];
  }

  // ------------------------------------------------------------ targets

  function getSite(id) {
    return db.get("sites", id);
  }
  function deployed(site) {
    return !!site.currentReleaseId || Object.values(site.state || {}).some((x) => x?.releaseId || x?.deployedAt);
  }
  function upstreams(site) {
    try {
      const list = ctx.lb?.upstreams?.(site);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
  function checkPath(site, s) {
    const p = s.path || String(site.healthPath || "").trim() || "/";
    return /^\/[^\s#]*$/.test(p) ? p : "/";
  }
  function targetFor(site, s = settingsFor(site.id)) {
    if (s.url) return { url: s.url, how: "custom" };
    const p = checkPath(site, s);
    const domain = (site.domains || []).map((d) => String(d).trim().toLowerCase()).find((d) => DOMAIN_RE.test(d));
    if (domain) {
      const tunnel = !!(site.cloudflare?.enabled && (site.cloudflare.hostnames || []).includes(domain));
      const secure = site.ssl?.status === "active" || tunnel;
      return { url: `${secure ? "https" : "http"}://${domain}${p}`, how: tunnel ? "tunnel" : "domain" };
    }
    const port = Number(site.port);
    if (!port) return { url: "", how: "none" };
    const up = upstreams(site).find((u) => u.enabled !== false && u.address) || null;
    const addr = up?.address || "127.0.0.1";
    const host = addr.includes(":") ? `[${addr}]` : addr;
    return { url: `http://${host}:${port}${p}`, how: "server", serverId: up?.serverId || "main" };
  }

  // ------------------------------------------------------------- runtime

  function runtime(siteId) {
    let r = rt.get(siteId);
    if (!r) {
      r = { state: "unknown", since: null, fails: 0, oks: 0, failSince: null, okSince: null, lastCheck: null, lastCheckAt: null, lastCode: null, incidentId: null, nextAt: Date.now() + Math.random() * 3000, lastCause: null };
      rt.set(siteId, r);
    }
    return r;
  }

  function loadState() {
    let j = null;
    try {
      j = JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch { /* first boot */ }
    const now = Date.now();
    rate = j?.rate && typeof j.rate === "object" ? j.rate : {};
    gaps = Array.isArray(j?.gaps) ? j.gaps.filter((g) => now - Date.parse(g.to) < KEEP_DAYS * DAY) : [];
    for (const [id, r] of Object.entries(j?.sites || {})) {
      if (!getSite(id)) continue;
      const x = runtime(id);
      Object.assign(x, {
        state: ["up", "down", "unknown"].includes(r.state) ? r.state : "unknown",
        since: r.since || null,
        fails: Number(r.fails) || 0,
        oks: Number(r.oks) || 0,
        failSince: r.failSince || null,
        okSince: r.okSince || null,
        lastCheck: r.lastCheck || null,
        lastCheckAt: r.lastCheckAt || null,
        lastCode: r.lastCode || null,
        incidentId: r.incidentId || null,
        lastCause: r.lastCause || null,
      });
      // the open incident must still exist and be open
      const inc = x.incidentId ? db.get("incidents", x.incidentId) : null;
      if (!inc || inc.endedAt) x.incidentId = null;
      if (x.state === "down" && !x.incidentId) x.state = "unknown";
      // next check: one interval after the last one (staggered at boot)
      const s = settingsFor(id);
      const last = x.lastCheckAt ? Date.parse(x.lastCheckAt) : 0;
      x.nextAt = Math.max(now + Math.random() * 3000, last + s.intervalSec * 1000);
    }
    // Panel offline? The heartbeat (savedAt) is written every FLUSH_MS.
    const savedAt = j?.savedAt ? Date.parse(j.savedAt) : 0;
    if (savedAt && now - savedAt > GAP_AFTER_MS) {
      const gap = { from: iso(savedAt), to: iso(now), reason: "panel offline" };
      gaps.push(gap);
      gaps = gaps.slice(-50);
      for (const inc of db.list("incidents", (i) => !i.endedAt)) {
        db.update("incidents", inc.id, { gaps: [...(inc.gaps || []), gap].slice(-20) });
      }
      // Counters across a gap mean nothing; the site keeps its state until new checks decide.
      for (const x of rt.values()) {
        x.fails = 0;
        x.oks = 0;
        x.failSince = x.state === "down" ? x.failSince : null;
        x.okSince = null;
        x.lastCheckAt = null; // never fill minutes across the gap
      }
      console.log(`[monitor] the panel was offline ${fmtDuration(now - savedAt)} — recorded as a gap (no data)`);
    }
    stateDirty = true;
  }

  function saveState() {
    const sites = {};
    for (const [id, r] of rt) {
      const { nextAt: _n, ...keep } = r;
      sites[id] = keep;
    }
    // drop rate-limit entries that no longer matter
    const now = Date.now();
    for (const [k, t] of Object.entries(rate)) if (now - t > Math.max(SMS_MIN_GAP_MS, DAY)) delete rate[k];
    try {
      writeFileAtomic(statePath, JSON.stringify({ v: 1, savedAt: iso(now), sites, rate, gaps }), 0o600);
      stateDirty = false;
    } catch (err) {
      console.warn(`[monitor] could not write state: ${err.message}`);
    }
  }

  // ------------------------------------------------------------- uptime

  /** Minute buckets [from, to) grouped by `step` (≥ 1 min). */
  function minuteBuckets(siteId, from, to, step) {
    from = floorTo(from, MINUTE);
    const n = Math.max(1, Math.ceil((to - from) / step));
    const out = Array.from({ length: n }, (_, i) => ({ t: from + i * step, u: 0, f: 0, d: 0, p: 0, sum: 0, cnt: 0 }));
    days.each(siteId, from, to, (e, m, t) => {
      const b = out[Math.floor((t - from) / step)];
      if (!b) return;
      const c = e.s[m];
      if (c === CODE.u) b.u++;
      else if (c === CODE.f) b.f++;
      else if (c === CODE.d) b.d++;
      else if (c === CODE.p) b.p++;
      if (e.r[m]) {
        b.sum += e.r[m];
        b.cnt++;
      }
    });
    return out;
  }

  /** Hour buckets [from, to) grouped by `step` (multiple of 1 h), from the daily aggregates. */
  function hourBuckets(siteId, from, to, step) {
    from = floorTo(from, HOUR);
    const n = Math.max(1, Math.ceil((to - from) / step));
    const out = Array.from({ length: n }, (_, i) => ({ t: from + i * step, u: 0, f: 0, d: 0, p: 0, sum: 0, cnt: 0 }));
    for (let d = floorTo(from, DAY); d < to; d += DAY) {
      const a = days.agg(siteId, dayKey(d));
      for (let h = 0; h < 24; h++) {
        const t = d + h * HOUR;
        if (t < from || t >= to) continue;
        const b = out[Math.floor((t - from) / step)];
        const x = a.hours[h];
        b.u += x.u;
        b.f += x.f;
        b.d += x.d;
        b.p += x.p;
        b.sum += x.sum;
        b.cnt += x.cnt;
      }
    }
    return out;
  }

  const ratio = (b) => {
    const total = b.u + b.f + b.d;
    return total ? (b.u + b.f) / total : null;
  };
  const sumOf = (list) => list.reduce((a, b) => ({ u: a.u + b.u, f: a.f + b.f, d: a.d + b.d, p: a.p + b.p, sum: a.sum + b.sum, cnt: a.cnt + b.cnt }), { u: 0, f: 0, d: 0, p: 0, sum: 0, cnt: 0 });
  const pct = (r) => (r == null ? null : Math.round(r * 100000) / 1000);

  function uptimeStats(siteId, now = Date.now()) {
    const day = sumOf(minuteBuckets(siteId, now - DAY, now, DAY));
    const w = (span) => sumOf(hourBuckets(siteId, now - span, now, span));
    const d7 = w(7 * DAY), d30 = w(30 * DAY), d90 = w(90 * DAY);
    return {
      uptime: { h24: pct(ratio(day)), d7: pct(ratio(d7)), d30: pct(ratio(d30)), d90: pct(ratio(d90)) },
      downMinutes: { h24: day.d, d7: d7.d, d30: d30.d, d90: d90.d },
      avgMs24h: day.cnt ? Math.round(day.sum / day.cnt) : null,
    };
  }

  /**
   * 24 hourly cells aligned to clock hours (UTC — the same as local hours in
   * whole-hour time zones): 23 closed hours plus the current hour so far, so a
   * cell never moves between reloads and the newest one includes the latest check.
   */
  function strip24h(siteId, now = Date.now()) {
    const start = floorTo(now, HOUR) - 23 * HOUR;
    const bars24h = minuteBuckets(siteId, start, start + DAY, HOUR).map((b) => {
      const r = ratio(b);
      return r == null ? (b.p ? -1 : null) : Math.round(r * 100000) / 100000; // same precision as the uptime %
    });
    return { bars24h, bars24hStart: iso(start) };
  }

  // ------------------------------------------------------------- views

  function servedState(site, s, r) {
    if (s.paused) return "paused";
    if (!s.url && !deployed(site)) return "pending";
    return r.state;
  }

  function lightSummary(site) {
    const s = settingsFor(site.id);
    const r = runtime(site.id);
    const state = servedState(site, s, r);
    const ups = upstreams(site).map((u) => ({ serverId: u.serverId, name: u.name, online: u.online, healthy: u.healthy, down: !!u.down, error: u.error || null, latencyMs: u.latencyMs ?? null }));
    const unhealthy = ups.filter((u) => u.healthy === false || u.down);
    return {
      siteId: site.id,
      name: site.name,
      projectId: site.projectId,
      domain: (site.domains || [])[0] || null,
      state,
      since: state === "paused" ? s.pausedAt : r.since,
      degraded: state === "up" && unhealthy.length > 0,
      unhealthyServers: unhealthy.map((u) => u.name),
      servers: ups,
      lastCheck: r.lastCheck,
      failing: state !== "down" && r.fails > 0 ? r.fails : 0,
      incidentId: r.incidentId,
      paused: !!s.paused,
      pauseUntil: s.pauseUntil || null,
      intervalSec: s.intervalSec,
      sms: { enabled: !!s.smsEnabled, recipients: recipientsFor(site.id).length },
      target: targetFor(site, s).url || null,
    };
  }

  function summary(site) {
    const now = Date.now();
    return { ...lightSummary(site), ...uptimeStats(site.id, now), ...strip24h(site.id, now) };
  }

  const RANGES = {
    "1h": { span: HOUR, step: MINUTE },
    "24h": { span: DAY, step: 5 * MINUTE },
    "7d": { span: 7 * DAY, step: HOUR },
    "30d": { span: 30 * DAY, step: 6 * HOUR },
    "90d": { span: 90 * DAY, step: DAY },
  };

  function series(siteId, range) {
    const R = RANGES[range] || RANGES["24h"];
    const now = Date.now();
    // Buckets on fixed step boundaries (stable across reloads); the last one is the current, still-open step.
    const to = floorTo(now, R.step) + R.step;
    const from = to - R.span;
    const list = R.step < HOUR ? minuteBuckets(siteId, from, to, R.step) : hourBuckets(siteId, from, to, R.step);
    return {
      range: RANGES[range] ? range : "24h",
      step: R.step,
      points: list.map((b) => ({ t: iso(b.t), ms: b.cnt ? Math.round(b.sum / b.cnt) : null, uptime: pct(ratio(b)), up: b.u + b.f, down: b.d, paused: b.p })),
    };
  }

  function dayStrip(siteId) {
    const today = floorTo(Date.now(), DAY);
    const out = [];
    for (let i = KEEP_DAYS - 1; i >= 0; i--) {
      const d = today - i * DAY;
      const a = sumOf(days.agg(siteId, dayKey(d)).hours);
      out.push({ day: dayKey(d), uptime: pct(ratio(a)), downMinutes: a.d, pausedMinutes: a.p, avgMs: a.cnt ? Math.round(a.sum / a.cnt) : null });
    }
    return out;
  }

  function publicIncident(i) {
    const end = i.endedAt ? Date.parse(i.endedAt) : Date.now();
    return { ...i, notify: undefined, open: !i.endedAt, durationMs: i.durationMs ?? end - Date.parse(i.startedAt), alerts: [...(i.alerts || [])].reverse() };
  }

  function incidentsOf(filter = {}) {
    let list = db.list("incidents", filter.siteId ? { siteId: filter.siteId } : undefined);
    if (filter.status === "open") list = list.filter((i) => !i.endedAt);
    if (filter.status === "closed") list = list.filter((i) => i.endedAt);
    list.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return list.slice(0, filter.limit || 50).map(publicIncident);
  }

  function settingsView(siteId) {
    const s = settingsFor(siteId);
    return { ...s, recipients: (s.recipients || []).map((r) => ({ ...r })), repeatMinutesDefault: notif().repeatMinutes, minIntervalSec: MIN_INTERVAL_SEC };
  }

  function notificationsView() {
    const n = notif();
    const key = birdKey();
    const st = birdStatus();
    return {
      enabled: !!n.enabled,
      provider: "bird",
      accessKeySet: !!key,
      accessKeyHint: key ? (key.length <= 10 ? "••••" : `${key.slice(0, key.startsWith("bk_") ? 7 : 3)}…${key.slice(-4)}`) : null,
      accessKeyUnreadable: !!n.bird.accessKeyEnc && !key,
      workspaceId: n.bird.workspaceId || "",
      channelId: n.bird.channelId || "",
      from: n.bird.from || "",
      api: st.api,
      configured: st.configured,
      problem: st.configured ? null : st.problem,
      defaults: (n.defaults || []).map((r) => ({ name: r.name || "", phone: r.phone })),
      repeatMinutes: n.repeatMinutes,
      notifyRecovery: n.notifyRecovery !== false,
      minGapMinutes: Math.round(SMS_MIN_GAP_MS / MINUTE * 10) / 10,
      dryRun: sys.DRY_RUN,
    };
  }

  // -------------------------------------------------------------- SMS

  async function sendSms(to, text) {
    if (sys.DRY_RUN) {
      console.log(`[monitor] [dry-run] would text ${to} : ${text}`);
      return { ok: true, simulated: true, id: null, error: null, api: birdStatus().api || null };
    }
    const cfg = birdConfig();
    let req;
    try {
      req = birdRequest(cfg, to, text);
    } catch (err) {
      return { ok: false, simulated: false, error: err.message, api: null };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SMS_TIMEOUT_MS);
    try {
      const res = await fetch(req.url, { method: req.method, headers: req.headers, body: JSON.stringify(req.body), signal: ctrl.signal, redirect: "error" });
      const body = await res.text().catch(() => "");
      if (!res.ok) return { ok: false, simulated: false, error: birdError(res.status, body, cfg.accessKey), status: res.status, api: req.api };
      let id = null;
      try {
        id = JSON.parse(body)?.id || null;
      } catch { /* 202 without JSON */ }
      return { ok: true, simulated: false, id, error: null, status: res.status, api: req.api };
    } catch (err) {
      const msg = err.name === "AbortError" ? "Bird did not answer within 15s" : `Could not reach Bird: ${describeError(err)}`;
      return { ok: false, simulated: false, error: msg.split(cfg.accessKey || "\u0000").join("***"), api: req.api };
    } finally {
      clearTimeout(timer);
    }
  }

  function logAlert(site, incId, entry) {
    const inc = db.get("incidents", incId);
    if (inc) {
      const alerts = [...(inc.alerts || []), entry];
      db.update("incidents", incId, { alerts: alerts.slice(-MAX_ALERTS_PER_INCIDENT), lastAlertAt: entry.at });
    }
    try {
      ctx.activity?.(null, "monitor.sms", { type: "site", id: site.id, name: site.name },
        { kind: entry.kind, to: entry.to, name: entry.name || undefined, ok: entry.ok, simulated: entry.simulated || undefined, skipped: entry.skipped || undefined, error: entry.error || undefined, incidentId: incId });
    } catch { /* audit is best effort */ }
    if (!entry.ok && !entry.skipped) console.warn(`[monitor] SMS to ${maskPhone(entry.to)} for ${site.name} failed: ${entry.error}`);
    ctx.events?.broadcast("monitor", { kind: "sms", siteId: site.id, incidentId: incId, ok: entry.ok, simulated: !!entry.simulated });
  }

  /**
   * Sends whatever is due for this incident. kind "down" right after it opened,
   * "check" after every check while down (reminders + recipients added later),
   * "up" on recovery. Never throws.
   */
  async function notify(siteId, incId, kind) {
    const lock = `${incId}|${kind === "up" ? "up" : "down"}`; // a recovery text never waits behind reminders
    if (sending.has(lock)) return;
    sending.add(lock);
    try {
      const site = getSite(siteId);
      const inc = db.get("incidents", incId);
      if (!site || !inc) return;
      const n = notif();
      const s = settingsFor(siteId);
      if (!n.enabled || !s.smsEnabled) return;
      const now = Date.now();
      const domain = (site.domains || [])[0] || "";
      const startedAt = Date.parse(inc.startedAt);

      if (kind === "up") {
        if (n.notifyRecovery === false) return;
        const notified = Object.entries(inc.notify || {}).filter(([, x]) => x.ok);
        for (const [phone, x] of notified) {
          const text = buildMessage("up", { name: site.name, domain, durationMs: (inc.endedAt ? Date.parse(inc.endedAt) : now) - startedAt });
          const r = await sendSms(phone, text);
          logAlert(site, incId, { at: iso(Date.now()), kind: "up", to: phone, name: x.name || "", ok: r.ok, simulated: r.simulated, error: r.error, messageId: r.id || null, api: r.api, text });
        }
        return;
      }

      const repeatMs = Math.max(1, Number(s.repeatMinutes) || Number(n.repeatMinutes) || 60) * MINUTE;
      for (const rcp of recipientsFor(siteId)) {
        const fresh = db.get("incidents", incId);
        if (!fresh || fresh.endedAt) return; // recovered meanwhile
        const prev = fresh.notify?.[rcp.phone];
        const rkey = `${siteId}|${rcp.phone}`;
        const lastRate = Number(rate[rkey]) || 0;
        let msgKind;
        if (!prev) msgKind = "down";
        else {
          const dueAt = prev.lastAt + (prev.ok ? repeatMs : SMS_MIN_GAP_MS);
          if (Date.now() < dueAt) continue;
          msgKind = prev.ok ? "reminder" : "down"; // a failed first text is retried as a "down" text
        }
        if (Date.now() - lastRate < SMS_MIN_GAP_MS) {
          if (!prev) {
            // First text of this incident is blocked by the per-recipient limit (site flapping):
            // log it once and let the reminder follow when the limit allows.
            const entry = { at: iso(Date.now()), kind: msgKind, to: rcp.phone, name: rcp.name, ok: false, skipped: true, error: `rate limited (one text per ${fmtDuration(SMS_MIN_GAP_MS)} per number)` };
            db.update("incidents", incId, { notify: { ...(fresh.notify || {}), [rcp.phone]: { lastAt: lastRate, ok: false, name: rcp.name, skipped: true } } });
            logAlert(site, incId, entry);
          }
          continue;
        }
        const text = msgKind === "down"
          ? buildMessage("down", { name: site.name, domain, cause: fresh.lastCause || fresh.cause, since: startedAt })
          : buildMessage("reminder", { name: site.name, domain, cause: fresh.lastCause || fresh.cause, durationMs: Date.now() - startedAt });
        rate[rkey] = Date.now();
        stateDirty = true;
        const r = await sendSms(rcp.phone, text);
        const cur = db.get("incidents", incId);
        if (cur) db.update("incidents", incId, { notify: { ...(cur.notify || {}), [rcp.phone]: { lastAt: Date.now(), ok: r.ok, name: rcp.name } } });
        logAlert(site, incId, { at: iso(Date.now()), kind: msgKind, to: rcp.phone, name: rcp.name, ok: r.ok, simulated: r.simulated, error: r.error, messageId: r.id || null, api: r.api, text });
      }
    } catch (err) {
      console.warn(`[monitor] alerting failed for ${siteId}: ${err.message}`);
    } finally {
      sending.delete(lock);
    }
  }

  // ------------------------------------------------------------ checks

  function openIncident(site, r, now, cause) {
    const startedAt = r.failSince ? Date.parse(r.failSince) : now;
    const ups = upstreams(site);
    const inc = db.insert("incidents", {
      id: db.newId("inc"),
      siteId: site.id,
      projectId: site.projectId,
      siteName: site.name,
      domain: (site.domains || [])[0] || null,
      target: r.lastCheck?.url || null,
      startedAt: iso(startedAt),
      confirmedAt: iso(now),
      endedAt: null,
      durationMs: null,
      cause,
      lastCause: cause,
      lastStatus: r.lastCheck?.status ?? null,
      servers: ups.filter((u) => u.healthy === false || u.down).map((u) => u.name),
      failedChecks: r.fails,
      notify: {},
      alerts: [],
      gaps: [],
      lastAlertAt: null,
    });
    // trim this site's history
    const mine = db.list("incidents", { siteId: site.id }).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    if (mine.length > MAX_INCIDENTS_PER_SITE) {
      const drop = new Set(mine.slice(MAX_INCIDENTS_PER_SITE).map((i) => i.id));
      db.removeWhere("incidents", (i) => drop.has(i.id));
    }
    return inc;
  }

  async function runCheck(site) {
    const s = settingsFor(site.id);
    const r = runtime(site.id);
    const target = targetFor(site, s);
    const res = target.url
      ? await probe(target.url, { timeoutMs: s.timeoutSec * 1000, expectMin: s.expectMin, expectMax: s.expectMax })
      : { ok: false, status: null, ms: 0, error: "no address to check (add a domain or a custom URL)" };
    // the site may have been deleted / paused while we waited
    const cur = getSite(site.id);
    if (!cur || settingsFor(site.id).paused) return;
    const now = Date.now();

    // minutes since the last check carry its result (continuous monitoring only)
    const last = r.lastCheckAt ? Date.parse(r.lastCheckAt) : 0;
    if (last && r.lastCode && now - last <= s.intervalSec * 1000 + GAP_AFTER_MS) {
      days.fill(site.id, floorTo(last, MINUTE) + MINUTE, floorTo(now, MINUTE), CODE[r.lastCode]);
    }

    if (res.ok) {
      r.oks += 1;
      r.fails = 0;
      r.failSince = null;
      r.okSince ||= iso(now);
    } else {
      r.fails += 1;
      r.oks = 0;
      r.okSince = null;
      r.failSince ||= iso(now);
      r.lastCause = res.error;
    }
    const code = res.ok ? "u" : r.state === "down" ? "d" : "f";
    days.set(site.id, now, CODE[code], res.ok ? res.ms : null);
    r.lastCode = code;
    r.lastCheckAt = iso(now);
    r.lastCheck = { at: iso(now), ok: res.ok, status: res.status, ms: res.ms, error: res.error, url: target.url };

    if (res.ok) {
      if (r.state === "down" && r.oks >= s.recoverThreshold) {
        r.state = "up";
        r.since = r.okSince;
        const incId = r.incidentId;
        r.incidentId = null;
        const inc = incId ? db.get("incidents", incId) : null;
        if (inc && !inc.endedAt) {
          const endedAt = Date.parse(r.okSince);
          db.update("incidents", incId, { endedAt: iso(endedAt), durationMs: endedAt - Date.parse(inc.startedAt), endedBy: "recovered" });
          ctx.activity?.(null, "monitor.up", { type: "site", id: cur.id, name: cur.name }, { incidentId: incId, downFor: fmtDuration(endedAt - Date.parse(inc.startedAt)) });
          ctx.events?.broadcast("monitor", { kind: "up", siteId: cur.id, siteName: cur.name, projectId: cur.projectId, incidentId: incId, durationMs: endedAt - Date.parse(inc.startedAt), at: iso(now) });
          notify(cur.id, incId, "up");
        }
      } else if (r.state === "unknown") {
        r.state = "up";
        r.since = r.okSince;
      }
    } else {
      if (r.state !== "down" && r.fails >= s.failThreshold) {
        r.state = "down";
        r.since = r.failSince;
        // the threshold's failed minutes were downtime after all
        days.recode(site.id, Date.parse(r.failSince), now + MINUTE, CODE.f, CODE.d);
        r.lastCode = "d";
        const inc = openIncident(cur, r, now, res.error);
        r.incidentId = inc.id;
        ctx.activity?.(null, "monitor.down", { type: "site", id: cur.id, name: cur.name }, { cause: res.error, incidentId: inc.id, url: target.url });
        ctx.events?.broadcast("monitor", { kind: "down", siteId: cur.id, siteName: cur.name, projectId: cur.projectId, incidentId: inc.id, cause: res.error, since: r.since, at: iso(now) });
        notify(cur.id, inc.id, "down");
      } else if (r.state === "down" && r.incidentId) {
        const inc = db.get("incidents", r.incidentId);
        if (inc && inc.lastCause !== res.error) db.update("incidents", inc.id, { lastCause: res.error, lastStatus: res.status });
        notify(cur.id, r.incidentId, "check");
      }
    }
    changed.add(site.id);
    stateDirty = true;
  }

  function tick() {
    const now = Date.now();
    for (const site of db.list("sites")) {
      if (site.deleting) continue;
      const s = settingsFor(site.id);
      const r = runtime(site.id);
      if (s.paused) {
        if (s.pauseUntil && Date.parse(s.pauseUntil) <= now) {
          resume(site, null, "schedule");
          continue;
        }
        const m = floorTo(now, MINUTE);
        if (r.pausedMinute !== m) {
          r.pausedMinute = m;
          days.set(site.id, now, CODE.p, null);
        }
        continue;
      }
      if (!s.url && !deployed(site)) continue;
      if (inFlight.has(site.id) || now < (r.nextAt || 0) || inFlight.size >= MAX_CONCURRENT) continue;
      r.nextAt = now + s.intervalSec * 1000;
      inFlight.add(site.id);
      runCheck(site)
        .catch((err) => console.warn(`[monitor] check of ${site.id} failed: ${err.message}`))
        .finally(() => inFlight.delete(site.id));
    }
  }

  function broadcastUpdates() {
    if (!changed.size) return;
    const items = [];
    for (const id of changed) {
      const site = getSite(id);
      if (!site) continue;
      const sum = lightSummary(site);
      sum.uptime = { h24: uptimeStats(id).uptime.h24 };
      Object.assign(sum, strip24h(id)); // rows' mini strips stay live too
      items.push(sum);
    }
    changed.clear();
    if (items.length) ctx.events?.broadcast("monitor", { kind: "update", items });
  }

  function flush() {
    days.flush();
    saveState();
  }

  function dropSite(siteId) {
    rt.delete(siteId);
    days.dropSite(siteId);
    if (monitorRecord(siteId)) db.remove("monitors", siteId);
    db.removeWhere("incidents", { siteId });
    for (const k of Object.keys(rate)) if (k.startsWith(`${siteId}|`)) delete rate[k];
    stateDirty = true;
  }

  function closeForPause(site, admin) {
    const r = runtime(site.id);
    if (r.incidentId) {
      const inc = db.get("incidents", r.incidentId);
      if (inc && !inc.endedAt) {
        const now = Date.now();
        db.update("incidents", inc.id, { endedAt: iso(now), durationMs: now - Date.parse(inc.startedAt), endedBy: "paused", endedByAdmin: admin?.name || admin?.email || null });
      }
    }
    Object.assign(r, { state: "unknown", since: null, fails: 0, oks: 0, failSince: null, okSince: null, incidentId: null, lastCheckAt: null, lastCode: null });
  }

  function resume(site, admin, how = "admin") {
    saveSettings(site.id, { paused: false, pausedAt: null, pausedBy: null, pauseUntil: null, pauseReason: null });
    const r = runtime(site.id);
    Object.assign(r, { state: "unknown", since: null, fails: 0, oks: 0, failSince: null, okSince: null, lastCheckAt: null, lastCode: null, nextAt: 0 });
    ctx.activity?.(admin, "monitor.resume", { type: "site", id: site.id, name: site.name }, how === "schedule" ? { automatic: true } : null);
    ctx.events?.broadcast("monitor", { kind: "settings", siteId: site.id });
    changed.add(site.id);
  }

  // ------------------------------------------------------------- routes

  function requireSite(id) {
    const s = getSite(id);
    if (!s) throw httpError(404, "Website not found");
    return s;
  }

  function sanitizeSettings(body, current) {
    const out = {};
    const has = (k) => body[k] !== undefined;
    if (has("intervalSec")) out.intervalSec = clampInt(body.intervalSec, MIN_INTERVAL_SEC, 3600, current.intervalSec);
    if (has("timeoutSec")) out.timeoutSec = clampInt(body.timeoutSec, 1, 60, current.timeoutSec);
    if (has("failThreshold")) out.failThreshold = clampInt(body.failThreshold, 1, 20, current.failThreshold);
    if (has("recoverThreshold")) out.recoverThreshold = clampInt(body.recoverThreshold, 1, 20, current.recoverThreshold);
    if (has("path")) {
      const p = cleanStr(body.path, 300);
      if (p && !/^\/[^\s#]*$/.test(p)) throw httpError(400, "The check path must start with / (for example /api/health).");
      out.path = p;
    }
    if (has("url")) {
      const u = cleanStr(body.url, 500);
      if (u) {
        let parsed;
        try {
          parsed = new URL(u);
        } catch {
          throw httpError(400, "The custom URL must be a full address, like https://example.com/health.");
        }
        if (!/^https?:$/.test(parsed.protocol)) throw httpError(400, "The custom URL must start with http:// or https://.");
        if (parsed.username || parsed.password) throw httpError(400, "The custom URL can't contain a username or password.");
      }
      out.url = u;
    }
    if (has("expect")) {
      const m = /^\s*(\d{3})\s*(?:-\s*(\d{3}))?\s*$/.exec(String(body.expect));
      if (!m) throw httpError(400, "Expected status must look like 200-399 or 200.");
      body.expectMin = m[1];
      body.expectMax = m[2] || m[1];
    }
    if (body.expectMin !== undefined || body.expectMax !== undefined) {
      const lo = clampInt(body.expectMin ?? current.expectMin, 100, 599, 200);
      const hi = clampInt(body.expectMax ?? current.expectMax, 100, 599, 399);
      if (hi < lo) throw httpError(400, "The expected status range is upside down.");
      out.expectMin = lo;
      out.expectMax = hi;
    }
    if (has("smsEnabled")) out.smsEnabled = !!body.smsEnabled;
    if (has("includeDefaults")) out.includeDefaults = !!body.includeDefaults;
    if (has("recipients")) out.recipients = sanitizeRecipients(body.recipients, "Recipients");
    if (has("repeatMinutes")) out.repeatMinutes = body.repeatMinutes === null || body.repeatMinutes === "" ? null : clampInt(body.repeatMinutes, 1, 1440, null);
    return out;
  }

  function routes(router) {
    router.get("/api/monitor", () => {
      const items = db.list("sites").filter((s) => !s.deleting).map(summary);
      const counts = { total: items.length, up: 0, down: 0, paused: 0, pending: 0, unknown: 0, degraded: 0 };
      for (const i of items) {
        counts[i.state] = (counts[i.state] || 0) + 1;
        if (i.degraded) counts.degraded++;
      }
      const n = notificationsView();
      return { items, counts, notifications: { enabled: n.enabled, configured: n.configured || n.dryRun, dryRun: n.dryRun } };
    });

    router.get("/api/sites/:id/monitor", (req, res, { params, query }) => {
      const site = requireSite(params.id);
      const n = notificationsView();
      return {
        summary: summary(site),
        settings: settingsView(site.id),
        effective: { ...targetFor(site), path: checkPath(site, settingsFor(site.id)), healthPath: site.healthPath || "" },
        recipients: recipientsFor(site.id),
        notifications: { enabled: n.enabled, configured: n.configured, dryRun: n.dryRun, defaults: n.defaults, repeatMinutes: n.repeatMinutes, notifyRecovery: n.notifyRecovery, minGapMinutes: n.minGapMinutes },
        series: series(site.id, query.range),
        days: dayStrip(site.id),
        incidents: incidentsOf({ siteId: site.id, limit: Math.min(100, Number(query.limit) || 25) }),
        gaps: gaps.slice(-10).reverse(),
      };
    });

    router.put("/api/sites/:id/monitor", (req, res, { params, body, admin }) => {
      const site = requireSite(params.id);
      const cur = settingsFor(site.id);
      const patch = sanitizeSettings(body || {}, cur);
      saveSettings(site.id, patch);
      const r = runtime(site.id);
      if (patch.intervalSec || patch.url !== undefined || patch.path !== undefined) r.nextAt = 0; // check soon with the new settings
      const fields = Object.keys(patch).filter((k) => JSON.stringify(patch[k]) !== JSON.stringify(cur[k]));
      if (fields.length) ctx.activity?.(admin, "monitor.settings.update", { type: "site", id: site.id, name: site.name }, { fields });
      ctx.events?.broadcast("monitor", { kind: "settings", siteId: site.id });
      changed.add(site.id);
      // a recipient added while the site is down gets the "down" text now
      if (r.incidentId && (patch.smsEnabled || patch.recipients || patch.includeDefaults)) notify(site.id, r.incidentId, "check");
      return { settings: settingsView(site.id), summary: summary(site), recipients: recipientsFor(site.id) };
    });

    router.post("/api/sites/:id/monitor/pause", (req, res, { params, body, admin }) => {
      const site = requireSite(params.id);
      const minutes = body?.minutes ? clampInt(body.minutes, 1, 60 * 24 * 30, null) : null;
      closeForPause(site, admin);
      saveSettings(site.id, {
        paused: true,
        pausedAt: iso(Date.now()),
        pausedBy: admin?.name || admin?.email || null,
        pauseUntil: minutes ? iso(Date.now() + minutes * MINUTE) : null,
        pauseReason: cleanStr(body?.reason, 200) || null,
      });
      ctx.activity?.(admin, "monitor.pause", { type: "site", id: site.id, name: site.name }, minutes ? { minutes } : null);
      ctx.events?.broadcast("monitor", { kind: "settings", siteId: site.id });
      changed.add(site.id);
      stateDirty = true;
      return { settings: settingsView(site.id), summary: summary(site) };
    });

    router.post("/api/sites/:id/monitor/resume", (req, res, { params, admin }) => {
      const site = requireSite(params.id);
      resume(site, admin);
      return { settings: settingsView(site.id), summary: summary(site) };
    });

    router.post("/api/sites/:id/monitor/check", async (req, res, { params }) => {
      const site = requireSite(params.id);
      if (settingsFor(site.id).paused) throw httpError(409, "Monitoring is paused for this website.");
      if (inFlight.has(site.id)) throw httpError(409, "A check is already running.");
      inFlight.add(site.id);
      try {
        runtime(site.id).nextAt = Date.now() + settingsFor(site.id).intervalSec * 1000;
        await runCheck(site);
      } finally {
        inFlight.delete(site.id);
      }
      broadcastUpdates();
      return { summary: summary(site) };
    });

    router.get("/api/incidents", (req, res, { query }) => ({
      items: incidentsOf({ siteId: query.siteId || null, status: query.status, limit: Math.min(500, Number(query.limit) || 50) }),
    }));

    router.get("/api/notifications/settings", () => notificationsView());

    router.put("/api/notifications/settings", (req, res, { body = {}, admin }) => {
      const n = ctx.config.notifications ? { ...ctx.config.notifications } : { ...NOTIF_DEFAULTS, defaults: [], bird: {} };
      const bird = { ...(n.bird || {}) };
      const fields = [];
      if (body.enabled !== undefined) { n.enabled = !!body.enabled; fields.push("enabled"); }
      if (body.accessKey !== undefined && String(body.accessKey).trim()) {
        const key = String(body.accessKey).trim();
        if (key.length > 400 || /\s/.test(key)) throw httpError(400, "That doesn't look like a Bird access key.");
        bird.accessKeyEnc = ctx.secrets.encrypt(key);
        fields.push("accessKey");
      }
      if (body.clearAccessKey) { delete bird.accessKeyEnc; fields.push("accessKey"); }
      for (const k of ["workspaceId", "channelId"]) {
        if (body[k] === undefined) continue;
        const v = cleanStr(body[k], 80);
        if (v && !ID_RE.test(v)) throw httpError(400, `The ${k === "workspaceId" ? "workspace" : "channel"} ID can only contain letters, digits and dashes.`);
        bird[k] = v;
        fields.push(k);
      }
      if (body.from !== undefined) {
        const v = cleanStr(body.from, 20);
        if (v && !normalizePhone(v) && !/^(?=.*[A-Za-z])[A-Za-z0-9 ]{3,11}$/.test(v) && !/^\d{5,6}$/.test(v)) {
          throw httpError(400, "The sender must be an E.164 number, a 3–11 character alphanumeric sender ID, or a short code.");
        }
        bird.from = normalizePhone(v) || v;
        fields.push("from");
      }
      if (body.defaults !== undefined) { n.defaults = sanitizeRecipients(body.defaults, "Default recipients"); fields.push("defaults"); }
      if (body.repeatMinutes !== undefined) { n.repeatMinutes = clampInt(body.repeatMinutes, 1, 1440, 60); fields.push("repeatMinutes"); }
      if (body.notifyRecovery !== undefined) { n.notifyRecovery = !!body.notifyRecovery; fields.push("notifyRecovery"); }
      n.bird = bird;
      n.provider = "bird";
      ctx.config.notifications = n;
      ctx.saveConfig();
      if (fields.length) ctx.activity?.(admin, "notifications.settings.update", { type: "settings", id: "notifications", name: "Notifications" }, { fields: [...new Set(fields)] });
      ctx.events?.broadcast("monitor", { kind: "notifications" });
      const view = notificationsView();
      return { ...view, warning: view.enabled && !view.configured && !view.dryRun ? `Alerts are on, but Bird isn't fully set up: ${view.problem}` : null };
    });

    router.post("/api/notifications/test", async (req, res, { body = {}, admin }) => {
      const to = normalizePhone(body.to);
      if (!to) throw httpError(400, "Enter a phone number in international (E.164) format, like +15551234567.");
      if (Date.now() - lastTestAt < 5000) throw httpError(429, "Wait a few seconds between test texts.");
      lastTestAt = Date.now();
      const text = buildMessage("test", { panelName: ctx.config.panelName });
      const r = await sendSms(to, text);
      ctx.activity?.(admin, "notifications.test", { type: "settings", id: "notifications", name: "Notifications" }, { to, ok: r.ok, simulated: r.simulated || undefined, error: r.error || undefined });
      return { ok: r.ok, simulated: !!r.simulated, error: r.error || null, api: r.api || null, messageId: r.id || null, to, text };
    });
  }

  // ---------------------------------------------------------- lifecycle

  function startAll() {
    fs.mkdirSync(path.join(root, "sites"), { recursive: true, mode: 0o700 });
    loadState();
    const ids = () => new Set(db.list("sites").map((s) => String(s.id).replace(/[^A-Za-z0-9_-]/g, "")));
    // forget monitor data of websites deleted while the panel was off
    for (const m of db.list("monitors")) if (!getSite(m.id)) db.remove("monitors", m.id);
    db.removeWhere("incidents", (i) => !getSite(i.siteId) || (i.endedAt && Date.now() - Date.parse(i.endedAt) > KEEP_DAYS * DAY));
    try {
      days.prune(ids());
    } catch (err) {
      console.warn(`[monitor] prune: ${err.message}`);
    }
    ctx.events?.on?.("site", (d) => {
      if (d?.deleted && d.id) dropSite(d.id);
      else if (d?.id) changed.add(d.id);
    });
    const every = (fn, ms) => {
      const t = setInterval(() => {
        try {
          fn();
        } catch (err) {
          console.warn(`[monitor] ${err.message}`);
        }
      }, ms);
      t.unref?.();
      timers.push(t);
    };
    every(tick, TICK_MS);
    every(flush, FLUSH_MS);
    every(broadcastUpdates, UPDATE_EVENT_MS);
    every(() => {
      days.prune(ids());
      db.removeWhere("incidents", (i) => i.endedAt && Date.now() - Date.parse(i.endedAt) > KEEP_DAYS * DAY);
    }, 6 * HOUR);
    flush(); // heartbeat right away
  }

  function stopAll() {
    for (const t of timers) clearInterval(t);
    timers.length = 0;
    try {
      flush();
    } catch { /* shutting down */ }
  }

  return {
    routes,
    start: startAll,
    stop: stopAll,
    api: {
      summary: (siteId) => {
        const s = getSite(siteId);
        return s ? summary(s) : null;
      },
      list: () => db.list("sites").map(lightSummary),
      downCount: () => db.list("sites").filter((s) => !s.deleting && servedState(s, settingsFor(s.id), runtime(s.id)) === "down").length,
      incidents: incidentsOf,
      checkNow: (siteId) => {
        const s = getSite(siteId);
        return s ? runCheck(s) : Promise.resolve();
      },
      sendSms,
    },
  };
}
