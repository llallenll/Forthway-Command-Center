// API client. Real mode calls the panel's JSON API with relative URLs.
// Mock mode (?mock=1, or localStorage fcc.mock=1) serves fixtures from mock.js
// so the UI can be developed and screenshotted without a backend.

function ls(k) { try { return localStorage.getItem(k); } catch { return null; } }
function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { return null; } }

const qs = new URLSearchParams(location.search);
if (qs.get("mock") === "1") ss("fcc.mock", "1");
if (qs.get("mock") === "0") { ss("fcc.mock", null); try { localStorage.removeItem("fcc.mock"); } catch {} }
export const MOCK = qs.get("mock") !== "0" && (qs.get("mock") === "1" || ls("fcc.mock") === "1" || ss("fcc.mock") === "1");

export function exitMock() {
  ss("fcc.mock", null);
  try { localStorage.removeItem("fcc.mock"); } catch {}
  location.href = "./?mock=0";
}
/** Keep the mock flag when moving between index/login/setup pages. */
export function pageUrl(file) { return MOCK ? `${file}?mock=1` : file; }

export class ApiError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

let mockMod = null;
export async function mock() { return (mockMod ||= await import("./mock.js")); }

const rel = (p) => p.replace(/^\//, "");

export async function api(method, path, body, { quiet401 = false } = {}) {
  if (MOCK) {
    const m = await mock();
    return m.handle(method, path, body);
  }
  const init = { method, headers: { Accept: "application/json" }, credentials: "same-origin" };
  if (body !== undefined && body !== null) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try { res = await fetch(rel(path), init); }
  catch (e) { throw new ApiError(0, "Can't reach the panel. Check your connection."); }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !quiet401 && !/\/api\/(login|setup)/.test(path)) {
      location.href = pageUrl("login.html") + (MOCK ? "&" : "?") + "next=" + encodeURIComponent(location.hash || "");
    }
    const msg = (data && typeof data === "object" && data.error) || (typeof data === "string" && data.slice(0, 200)) || `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, msg, data);
  }
  return data;
}

export const get = (p, o) => api("GET", p, undefined, o);
export const post = (p, b = {}) => api("POST", p, b);
export const patch = (p, b) => api("PATCH", p, b);
export const put = (p, b) => api("PUT", p, b);
export const del = (p) => api("DELETE", p);

export function qsOf(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null && v !== "") p.set(k, v);
  const s = p.toString();
  return s ? "?" + s : "";
}

/** POST a raw body with progress. Resolves with parsed JSON. */
function sendRaw(path, body, onProgress, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", rel(path));
    x.setRequestHeader("Content-Type", "application/octet-stream");
    if (timeoutMs) x.timeout = timeoutMs;
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => {
      let data = null;
      try { data = JSON.parse(x.responseText); } catch {}
      if (x.status >= 200 && x.status < 300) resolve(data);
      else reject(new ApiError(x.status, data?.error || (x.status === 413
        ? "Too large for the proxy in front of the panel (Cloudflare accepts at most 100 MB per upload)."
        : `Upload failed (${x.status})`), data));
    };
    x.onerror = () => reject(new ApiError(0, "Upload failed — connection lost."));
    x.ontimeout = () => reject(new ApiError(0, "Upload stalled — no answer from the panel."));
    x.send(body);
  });
}

/** Upload a raw file body with progress. Resolves with parsed JSON. */
export function upload(path, file, onProgress) {
  if (MOCK) {
    return new Promise((resolve, reject) => {
      let p = 0;
      const t = setInterval(async () => {
        p = Math.min(1, p + 0.08 + Math.random() * 0.12);
        onProgress?.(p);
        if (p >= 1) {
          clearInterval(t);
          try { resolve(await (await mock()).handle("POST", path, { size: file.size, name: file.name })); } catch (e) { reject(e); }
        }
      }, 120);
    });
  }
  return sendRaw(path, file, onProgress);
}

/**
 * Upload a file in pieces (`&upload=<id>&offset=&total=` on `path`), each small enough
 * for Cloudflare in front of the panel (it refuses request bodies over 100 MB). A piece
 * that fails on the network is retried; on 409 the server says where to resume.
 * Resolves with the answer to the last piece.
 */
export async function uploadChunked(path, file, onProgress, { chunkSize = 32 * 1024 * 1024 } = {}) {
  if (MOCK) return upload(path, file, onProgress);
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const sep = path.includes("?") ? "&" : "?";
  let offset = 0, retries = 0, resyncs = 0;
  for (;;) {
    const end = Math.min(file.size, offset + chunkSize);
    try {
      const r = await sendRaw(`${path}${sep}upload=${id}&offset=${offset}&total=${file.size}`, file.slice(offset, end),
        (p) => onProgress?.(file.size ? (offset + p * (end - offset)) / file.size : 1), { timeoutMs: 15 * 60_000 });
      retries = 0; resyncs = 0;
      if (end >= file.size) return r;
      offset = Number.isSafeInteger(r?.size) ? r.size : end;
    } catch (e) {
      if (e.status === 409 && Number.isSafeInteger(e.body?.size) && ++resyncs <= 5) { offset = e.body.size; continue; }
      if ((e.status === 0 || e.status === 502 || e.status === 504 || e.status === 520 || e.status === 524) && ++retries <= 4) {
        await new Promise((r) => setTimeout(r, 1500 * retries));
        continue;
      }
      throw e;
    }
  }
}

/** Fetch a text resource (job logs). */
export async function getText(path) {
  if (MOCK) return (await mock()).handleText(path);
  const res = await fetch(rel(path), { credentials: "same-origin" });
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
  return res.text();
}

/** Start a browser download of a panel URL. */
export async function download(path) {
  if (MOCK) {
    const { toast } = await import("./util.js");
    toast("Download started", "ok", { msg: "Mock mode — no file is produced." });
    return;
  }
  const a = document.createElement("a");
  a.href = rel(path);
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
