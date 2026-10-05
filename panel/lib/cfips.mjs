/**
 * Cloudflare's published edge IP ranges, for nginx's real_ip module
 * (conf.d/fcc-00-realip.conf, written by CLUSTER's loadbalancer.mjs).
 *
 * Source: https://www.cloudflare.com/ips-v4 and /ips-v6, refreshed at most
 * once a day and cached in dataDir/cloudflare-ips.json. A baked-in copy is
 * used until the first successful fetch (and whenever the fetch fails or
 * returns something that does not look like the list). Only these sources —
 * plus 127.0.0.1 / ::1 for Cloudflare Tunnel (cloudflared connects locally) —
 * are trusted to set CF-Connecting-IP.
 */

import fs from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "./store.mjs";

export const CF_URLS = { v4: "https://www.cloudflare.com/ips-v4", v6: "https://www.cloudflare.com/ips-v6" };
export const REFRESH_MS = 24 * 3_600_000;

// Baked-in fallback (Cloudflare's list as of 2026; it changes rarely).
export const FALLBACK = {
  v4: [
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
  ],
  v6: ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"],
};

export function isCidr4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(s);
  return !!m && m.slice(1, 5).every((o) => Number(o) <= 255) && Number(m[5]) <= 32;
}
export function isCidr6(s) {
  const m = /^([0-9a-f:]{2,39})\/(\d{1,3})$/i.exec(s);
  return !!m && m[1].includes(":") && (m[1].match(/::/g) || []).length <= 1 && Number(m[2]) <= 128;
}

/** Parse one ips-v4 / ips-v6 body. Returns null unless every line is a CIDR of that family and there are enough of them. */
export function parseList(text, family) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const ok = family === "v4" ? isCidr4 : isCidr6;
  if (lines.length < (family === "v4" ? 5 : 3) || lines.length > 200 || !lines.every(ok)) return null;
  return [...new Set(lines)];
}

const cacheFile = (dataDir) => path.join(dataDir, "cloudflare-ips.json");

/** { v4, v6, source: "cloudflare"|"builtin", fetchedAt } — never throws. */
export function cloudflareRanges(dataDir) {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(dataDir), "utf8"));
    const v4 = (c.v4 || []).filter(isCidr4);
    const v6 = (c.v6 || []).filter(isCidr6);
    if (v4.length >= 5 && v6.length >= 3) return { v4, v6, source: "cloudflare", fetchedAt: c.fetchedAt || null, checkedAt: c.checkedAt || null };
  } catch {
    /* no cache yet */
  }
  return { ...FALLBACK, source: "builtin", fetchedAt: null, checkedAt: null };
}

/**
 * Fetch both lists (unless the cache is younger than REFRESH_MS and !force).
 * Resolves { changed, ranges, error } — never rejects.
 */
export async function refreshCloudflareRanges(dataDir, { force = false, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const before = cloudflareRanges(dataDir);
  if (!force && before.checkedAt && Date.now() - Date.parse(before.checkedAt) < REFRESH_MS) return { changed: false, ranges: before, error: null };
  const get = async (url) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal, headers: { "User-Agent": "Forthway-Command-Center" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(t);
    }
  };
  try {
    const [t4, t6] = await Promise.all([get(CF_URLS.v4), get(CF_URLS.v6)]);
    const v4 = parseList(t4, "v4");
    const v6 = parseList(t6, "v6");
    if (!v4 || !v6) throw new Error("unexpected response from cloudflare.com/ips-v4|v6");
    const now = new Date().toISOString();
    const same = before.source === "cloudflare" && v4.join() === before.v4.join() && v6.join() === before.v6.join();
    writeFileAtomic(cacheFile(dataDir), JSON.stringify({ v: 1, v4, v6, fetchedAt: same ? before.fetchedAt || now : now, checkedAt: now }), 0o644);
    const after = cloudflareRanges(dataDir);
    const changed = v4.join() !== before.v4.join() || v6.join() !== before.v6.join();
    return { changed, ranges: after, error: null };
  } catch (err) {
    return { changed: false, ranges: before, error: err.name === "AbortError" ? "timed out" : err.message };
  }
}

/** The http-level nginx snippet. */
export function renderRealIpConf(ranges, { note = "" } = {}) {
  const r = ranges || FALLBACK;
  return [
    "# Managed by Forthway Command Center — real client IP behind Cloudflare. Do not edit.",
    "# CF-Connecting-IP is trusted only from Cloudflare's edge and from this machine (Cloudflare Tunnel);",
    "# $remote_addr then holds the visitor's address (logs, X-Real-IP, X-Forwarded-For).",
    `# Cloudflare ranges: ${r.source === "cloudflare" ? `cloudflare.com/ips-v4 + ips-v6, fetched ${r.fetchedAt || "?"}` : "built-in list"}${note ? ` · ${note}` : ""}`,
    "set_real_ip_from 127.0.0.1;",
    "set_real_ip_from ::1;",
    ...r.v4.map((c) => `set_real_ip_from ${c};`),
    ...r.v6.map((c) => `set_real_ip_from ${c};`),
    "real_ip_header CF-Connecting-IP;",
    "",
  ].join("\n");
}

/** Placeholder when real_ip must stay off (module missing, already configured elsewhere, or nginx rejected it). */
export function renderRealIpDisabled(reason) {
  return [
    "# Managed by Forthway Command Center — real client IP behind Cloudflare. Do not edit.",
    `# Disabled: ${String(reason || "unknown reason").replace(/[\r\n]+/g, " ").slice(0, 300)}`,
    "",
  ].join("\n");
}
