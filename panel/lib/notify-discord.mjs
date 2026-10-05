/**
 * DISCORD — uptime alerts posted to Discord channel webhooks (used by monitor.mjs).
 *
 * A webhook URL is a secret (anyone who has it can post to the channel): it is
 * stored encrypted, never returned by the API, never logged, and scrubbed from
 * every error message. Only https URLs on Discord's own hosts are accepted, and
 * posts always go to https://discord.com/api/webhooks/<id>/<token> (the URL is
 * reduced to its id + token), so a saved value can't point the panel anywhere
 * else. Redirects are refused.
 *
 * FCC_DISCORD_API_BASE (e.g. http://127.0.0.1:4999/api) is honoured ONLY under
 * FCC_DRY_RUN=1 and only for a loopback host — it lets tests exercise real
 * HTTP (429 handling etc.) against a local fake. Without it, dry runs never post.
 */

import { DRY_RUN } from "./sys.mjs";

export const DISCORD_HOSTS = Object.freeze(["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com", "ptb.discordapp.com", "canary.discordapp.com"]);
const PROD_BASE = "https://discord.com/api";
const WEBHOOK_PATH_RE = /^\/api(?:\/v\d{1,2})?\/webhooks\/(\d{15,25})\/([A-Za-z0-9_-]{20,128})\/?$/;
const SNOWFLAKE = /^\d{15,25}$/;
export const MAX_RETRIES = 5;
const ATTEMPT_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_MS = 120_000;

export const COLORS = Object.freeze({ down: 0xff5d7a, reminder: 0xff5d7a, up: 0x3ddc97, test: 0x4a72ff });

/**
 * Parses a Discord webhook URL. Returns { id, token, threadId } or throws an
 * Error with a user-facing message (which never contains the token).
 */
export function parseWebhookUrl(input) {
  const raw = String(input ?? "").trim();
  const bad = (why) => new Error(`That isn't a Discord webhook URL${why ? ` (${why})` : ""}. Copy it from the channel's Settings → Integrations → Webhooks → Copy Webhook URL; it looks like https://discord.com/api/webhooks/123…/abc…`);
  if (!raw) throw bad("empty");
  if (raw.length > 400 || /[\s\u0000-\u001f\u007f\\]/.test(raw)) throw bad("unexpected characters");
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw bad("not a URL");
  }
  if (u.protocol !== "https:") throw bad("it must start with https://");
  if (u.username || u.password || raw.slice(8).split("/")[0].includes("@")) throw bad("it can't contain a user name");
  if (u.port) throw bad("it can't have a port");
  const host = u.hostname.toLowerCase();
  if (!DISCORD_HOSTS.includes(host)) throw bad("only discord.com and discordapp.com webhooks are allowed");
  if (u.hash) throw bad("it can't contain #");
  const m = WEBHOOK_PATH_RE.exec(u.pathname);
  if (!m) throw bad("the path should be /api/webhooks/<id>/<token>");
  let threadId = null;
  for (const [k, v] of u.searchParams) {
    if (k === "thread_id" && SNOWFLAKE.test(v)) threadId = v;
    else if (k === "wait") continue;
    else throw bad(`unsupported query parameter "${k.slice(0, 20)}"`);
  }
  return { id: m[1], token: m[2], threadId };
}

/** Canonical form that is stored (encrypted): always discord.com. */
export function canonicalWebhookUrl({ id, token, threadId }) {
  return `https://discord.com/api/webhooks/${id}/${token}${threadId ? `?thread_id=${threadId}` : ""}`;
}

/** "…/api/webhooks/1234…6789/••••" — safe to show. */
export function webhookHint(parsedOrUrl) {
  let p = parsedOrUrl;
  if (typeof p === "string") {
    try {
      p = parseWebhookUrl(p);
    } catch {
      return "••••";
    }
  }
  if (!p?.id) return "••••";
  return `…/api/webhooks/${p.id.slice(0, 4)}…${p.id.slice(-4)}/••••${p.threadId ? " (thread)" : ""}`;
}

/**
 * Validates the optional mention posted with DOWN alerts. Accepts up to 5 of
 * "@here", "@everyone", "<@userId>", "<@!userId>", "<@&roleId>" separated by
 * spaces or commas. Returns the normalised text ("" = none); throws otherwise.
 */
export function parseMention(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return { text: "", allowed: { parse: [] } };
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  if (parts.length > 5) throw new Error("Mention at most 5 users or roles.");
  const users = [], roles = [];
  let everyone = false;
  const out = [];
  for (const p of parts) {
    let m;
    if (p === "@here" || p === "@everyone") {
      everyone = true;
      out.push(p);
    } else if ((m = /^<@!?(\d{15,25})>$/.exec(p))) {
      if (!users.includes(m[1])) users.push(m[1]);
      out.push(`<@${m[1]}>`);
    } else if ((m = /^<@&(\d{15,25})>$/.exec(p))) {
      if (!roles.includes(m[1])) roles.push(m[1]);
      out.push(`<@&${m[1]}>`);
    } else {
      throw new Error(`"${p.slice(0, 40)}" isn't a mention. Use @here, @everyone, <@userId> or <@&roleId> (right-click → Copy ID with Developer Mode on).`);
    }
  }
  const allowed = { parse: everyone ? ["everyone"] : [] };
  if (users.length) allowed.users = users;
  if (roles.length) allowed.roles = roles;
  return { text: [...new Set(out)].join(" "), allowed };
}

// ------------------------------------------------------------------ payload

const MD = /([\\`*_~|>\[\]()#<@:-])/g;
/** Escapes Discord markdown (and mention syntax) in user-controlled text. */
export function escapeMd(s) {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(MD, "\\$1");
}
const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const unix = (t) => Math.floor(new Date(t).getTime() / 1000);

export function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
}

/**
 * Builds the webhook JSON body.
 *   kind: "down" | "reminder" | "up" | "test"
 *   info: { name, domain, cause, since, durationMs, servers: [names], siteUrl, panelLink, mention, panelName, at }
 * The mention (already validated by parseMention) is only used for "down";
 * allowed_mentions always restricts pings to exactly what was configured.
 */
export function buildDiscordPayload(kind, info = {}) {
  const at = info.at || Date.now();
  const name = clip(info.name || "Website", 80);
  const fields = [];
  const add = (n, v, inline = true) => {
    if (v != null && v !== "") fields.push({ name: n, value: clip(v, 1024), inline });
  };
  let title, description;
  if (kind === "test") {
    title = "Test notification";
    description = `Uptime alerts from **${escapeMd(clip(info.panelName || "Forthway Command Center", 60))}** will be posted to this channel.`;
  } else {
    const label = { down: "🔴 Down", reminder: "🔴 Still down", up: "🟢 Back up" }[kind] || kind;
    title = clip(`${label}: ${name}`, 256);
    if (kind === "down") description = `**${escapeMd(name)}** is not responding.`;
    else if (kind === "reminder") description = `**${escapeMd(name)}** has been down for **${fmtDur(info.durationMs)}**.`;
    else description = `**${escapeMd(name)}** is back up after **${fmtDur(info.durationMs)}**.`;
    if (info.domain) add("Domain", escapeMd(clip(info.domain, 200)));
    if (kind !== "up") add("Cause", escapeMd(clip(info.cause || "unknown", 300)));
    if (info.since) add(kind === "up" ? "Was down since" : "Down since", `<t:${unix(info.since)}:f> (<t:${unix(info.since)}:R>)`);
    if (kind !== "down" && info.durationMs != null) add(kind === "up" ? "Downtime" : "Duration", fmtDur(info.durationMs));
    if (Array.isArray(info.servers) && info.servers.length) add("Unhealthy servers", escapeMd(clip(info.servers.join(", "), 500)), false);
  }
  if (info.panelLink && /^https?:\/\//i.test(info.panelLink)) add("Panel", `[Open in Forthway](${String(info.panelLink).replace(/[()\s<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)})`, false);
  const embed = {
    title,
    description: clip(description, 4096),
    color: COLORS[kind] ?? COLORS.test,
    timestamp: new Date(at).toISOString(),
    footer: { text: clip(info.panelName || "Forthway Command Center", 100) },
  };
  if (info.siteUrl && /^https?:\/\/[^\s]+$/i.test(info.siteUrl)) embed.url = clip(info.siteUrl, 500);
  if (fields.length) embed.fields = fields.slice(0, 25);
  const body = { username: "Forthway", embeds: [embed], allowed_mentions: { parse: [] } };
  if (kind === "down" && info.mention) {
    let m = { text: "" };
    try {
      m = parseMention(info.mention); // re-validated: never post anything that isn't a plain mention
    } catch { /* invalid stored mention: post without it */ }
    if (m.text) {
      body.content = m.text;
      body.allowed_mentions = m.allowed;
    }
  }
  return body;
}

// ------------------------------------------------------------------ sending

/** Removes the token / webhook path from any text (Discord or fetch errors). */
export function scrubSecret(text, hook) {
  let s = String(text ?? "");
  if (hook?.token) s = s.split(hook.token).join("***");
  return s.replace(/webhooks\/(\d+)\/[A-Za-z0-9_.-]+/gi, "webhooks/$1/***");
}

/** Readable message from a Discord error response, without secrets. */
export function discordError(status, bodyText, hook) {
  let msg = "";
  try {
    const j = JSON.parse(bodyText);
    msg = [j.message, j.code ? `code ${j.code}` : ""].filter(Boolean).join(", ");
    if (j.errors && typeof j.errors === "object") {
      const first = JSON.stringify(j.errors).match(/"message":"([^"]{1,120})"/);
      if (first) msg += ` — ${first[1]}`;
    }
  } catch {
    msg = String(bodyText || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  }
  const hint = status === 404 ? " — the webhook was deleted in Discord; add a new one" : status === 401 || status === 403 ? " — the webhook URL is no longer valid" : "";
  return scrubSecret(`Discord HTTP ${status}${msg ? `: ${msg}` : ""}${hint}`, hook).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
}

/**
 * API base. Production: always https://discord.com/api. Under DRY_RUN only,
 * FCC_DISCORD_API_BASE may point at a loopback test server.
 */
export function apiBase(env = process.env, dry = DRY_RUN) {
  const o = String(env.FCC_DISCORD_API_BASE || "").trim().replace(/\/+$/, "");
  if (!dry || !o) return { base: PROD_BASE, override: false };
  try {
    const u = new URL(o);
    if (/^https?:$/.test(u.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && !u.username && !u.password) return { base: o, override: true };
  } catch { /* ignored */ }
  return { base: PROD_BASE, override: false };
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

/**
 * Posts one payload, handling Discord's rate limits: 429 → wait `retry_after`
 * (body, seconds) or the Retry-After header; 5xx / network errors → exponential
 * backoff (1, 2, 4, 8, 16 s). At most MAX_RETRIES retries. Other 4xx stop at once.
 * Never throws. Returns { ok, status, attempts, rateLimited, error, messageId }.
 */
export async function postWebhook(hook, payload, opts = {}) {
  const base = opts.base || PROD_BASE;
  const sleep = opts.sleep || sleepMs;
  const fetchFn = opts.fetch || fetch;
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const log = opts.log || (() => {});
  if (!hook?.id || !hook?.token || !SNOWFLAKE.test(hook.id) || !/^[A-Za-z0-9_-]+$/.test(hook.token)) {
    return { ok: false, status: null, attempts: 0, rateLimited: 0, error: "No valid webhook URL is saved.", messageId: null };
  }
  const url = `${base}/webhooks/${hook.id}/${hook.token}?wait=true${hook.threadId ? `&thread_id=${hook.threadId}` : ""}`;
  const body = JSON.stringify(payload);
  let attempts = 0, rateLimited = 0, lastErr = "", lastStatus = null;
  for (;;) {
    attempts++;
    let wait = 0;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "ForthwayCommandCenter (uptime alerts, 3)" },
        body,
        signal: ctrl.signal,
        redirect: "error",
      });
      const text = await res.text().catch(() => "");
      lastStatus = res.status;
      if (res.ok) {
        let messageId = null;
        try {
          messageId = JSON.parse(text)?.id || null;
        } catch { /* 204 */ }
        return { ok: true, status: res.status, attempts, rateLimited, error: null, messageId };
      }
      if (res.status === 429) {
        rateLimited++;
        let ra = NaN;
        try {
          ra = Number(JSON.parse(text)?.retry_after);
        } catch { /* header below */ }
        if (!Number.isFinite(ra)) ra = Number(res.headers.get("retry-after"));
        const ms = Number.isFinite(ra) && ra >= 0 ? Math.ceil(ra * 1000) + 100 : 1000 * 2 ** (attempts - 1);
        lastErr = `rate limited by Discord (retry after ${(ms / 1000).toFixed(1)}s)`;
        if (ms > MAX_RETRY_AFTER_MS) {
          lastErr = `rate limited by Discord for ${Math.round(ms / 1000)}s — gave up`;
          break;
        }
        wait = ms;
      } else if (res.status >= 500) {
        lastErr = discordError(res.status, text, hook);
        wait = 1000 * 2 ** (attempts - 1);
      } else {
        return { ok: false, status: res.status, attempts, rateLimited, error: discordError(res.status, text, hook), messageId: null };
      }
    } catch (err) {
      const code = err?.cause?.code || err?.code || "";
      lastErr = err?.name === "AbortError" ? "Discord did not answer within 15s" : scrubSecret(`Could not reach Discord: ${code || err?.cause?.message || err?.message || "request failed"}`, hook).slice(0, 200);
      lastStatus = null;
      wait = 1000 * 2 ** (attempts - 1);
    } finally {
      clearTimeout(timer);
    }
    if (attempts > maxRetries) break;
    log(`attempt ${attempts} failed (${lastErr}); retrying in ${(wait / 1000).toFixed(1)}s`);
    await sleep(Math.min(wait, MAX_RETRY_AFTER_MS));
  }
  return { ok: false, status: lastStatus, attempts, rateLimited, error: `${lastErr} (after ${attempts} attempt${attempts === 1 ? "" : "s"})`, messageId: null };
}
