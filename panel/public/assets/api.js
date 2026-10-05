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
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", rel(path));
    x.setRequestHeader("Content-Type", "application/octet-stream");
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => {
      let data = null;
      try { data = JSON.parse(x.responseText); } catch {}
      if (x.status >= 200 && x.status < 300) resolve(data);
      else reject(new ApiError(x.status, data?.error || `Upload failed (${x.status})`, data));
    };
    x.onerror = () => reject(new ApiError(0, "Upload failed — connection lost."));
    x.send(file);
  });
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
