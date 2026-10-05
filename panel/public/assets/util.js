// DOM + formatting helpers. Every interpolation in html`` is escaped unless it
// is itself an html`` result (or raw()), so user data can never inject markup.

export class Safe {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Safe(String(s ?? ""));

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
export function esc(v) { return String(v ?? "").replace(/[&<>"'`]/g, (c) => ESC[c]); }

function part(v) {
  if (v == null || v === false || v === true) return "";
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(part).join("");
  return esc(v);
}
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += part(vals[i]) + strings[i + 1];
  return new Safe(out);
}
export function mount(el, safe) {
  if (!(safe instanceof Safe)) throw new Error("mount() needs html``");
  el.innerHTML = safe.s;
  return el;
}
export function frag(safe) {
  const t = document.createElement("template");
  t.innerHTML = safe.s;
  return t.content.firstElementChild;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export function on(root, type, sel, fn) {
  const h = (e) => {
    const t = e.target.closest(sel);
    if (t && root.contains(t)) fn(e, t);
  };
  root.addEventListener(type, h);
  return () => root.removeEventListener(type, h);
}
export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── formatting ── */

export function fmtNum(n) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US");
}
export function fmtCompact(n) {
  if (n == null || isNaN(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (a >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return fmtNum(Math.round(n));
}
export function fmtBytes(b, digits = 1) {
  if (b == null || isNaN(b)) return "—";
  if (b < 1024) return b + " B";
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return b.toFixed(b >= 100 ? 0 : digits).replace(/\.0$/, "") + " " + u[i];
}
/** "3.1 / 8 GB" — both numbers in the unit of the total. */
export function fmtUsage(used, total) {
  if (!total) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, t = total;
  while (t >= 1024 && i < u.length - 1) { t /= 1024; i++; }
  const div = Math.pow(1024, i);
  const f = (x) => { const v = x / div; return v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, ""); };
  return `${f(used || 0)} / ${f(total)} ${u[i]}`;
}
export function pct(used, total) { return total ? Math.max(0, Math.min(100, (used / total) * 100)) : 0; }
export function toneFor(p) { return p >= 90 ? "err" : p >= 75 ? "warn" : "ok"; }

function toDate(t) { return t instanceof Date ? t : new Date(typeof t === "number" ? t : String(t)); }
export function ago(t) {
  if (!t) return "never";
  const d = toDate(t); const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (isNaN(s)) return "—";
  if (s < 0) return "in " + agoInner(-s);
  if (s < 10) return "just now";
  return agoInner(s) + " ago";
}
function agoInner(s) {
  if (s < 60) return s + "s";
  const m = Math.round(s / 60); if (m < 60) return m + "m";
  const h = Math.round(m / 60); if (h < 24) return h + "h";
  const d = Math.round(h / 24); if (d < 30) return d + "d";
  const mo = Math.round(d / 30); if (mo < 12) return mo + "mo";
  return Math.round(mo / 12) + "y";
}
export function fmtDate(t, withTime = true) {
  if (!t) return "—";
  const d = toDate(t); if (isNaN(d)) return "—";
  const o = { month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date().getFullYear()) o.year = "numeric";
  if (withTime) { o.hour = "2-digit"; o.minute = "2-digit"; o.hour12 = false; }
  return d.toLocaleString("en-US", o);
}
export function fmtTime(t) {
  const d = toDate(t);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}
export function fmtDuration(ms) {
  if (ms == null || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60); if (m < 60) return m + "m " + (s % 60) + "s";
  const h = Math.floor(m / 60); if (h < 24) return h + "h " + (m % 60) + "m";
  return Math.floor(h / 24) + "d " + (h % 24) + "h";
}
export function initials(name) {
  const p = String(name || "?").trim().split(/\s+/);
  return ((p[0]?.[0] || "?") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}
export function plural(n, one, many) { return `${fmtNum(n)} ${n === 1 ? one : many || one + "s"}`; }
export function slug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

export const PROJECT_COLORS = {
  blue: "#4a72ff", violet: "#9d7dff", teal: "#33d4c1", green: "#3ddc97",
  amber: "#ffb547", rose: "#ff6b8e", cyan: "#4cc9f0", orange: "#ff8a4c",
};
export function colorOf(name) { return PROJECT_COLORS[name] || (/^#[0-9a-f]{3,8}$/i.test(name || "") ? name : PROJECT_COLORS.blue); }

/* ── clipboard ── */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement("textarea");
    t.value = text; t.style.position = "fixed"; t.style.opacity = "0";
    document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); } finally { t.remove(); }
  }
  toast("Copied to clipboard", "ok");
}

/* ── toasts ── */
import { icon } from "./icons.js";
const TOAST_ICON = { ok: "check", err: "alert", warn: "alert", info: "info" };
export function toast(title, type = "info", opts = {}) {
  const box = document.getElementById("toasts");
  if (!box) return;
  const el = frag(html`<div class="toast ${type}" role="status">
    <span class="t-ico">${icon(TOAST_ICON[type] || "info")}</span>
    <div class="t-body"><div class="t-title">${title}</div>${opts.msg ? html`<div class="t-msg">${opts.msg}</div>` : ""}
    ${opts.action ? html`<button class="t-link">${opts.action.label}</button>` : ""}</div>
    <button class="icon-btn ghost sm" aria-label="Dismiss">${icon("x", "sm")}</button></div>`);
  const kill = () => { el.classList.add("out"); setTimeout(() => el.remove(), 220); };
  el.querySelector(".icon-btn").onclick = kill;
  if (opts.action) el.querySelector(".t-link").onclick = () => { opts.action.fn(); kill(); };
  box.appendChild(el);
  while (box.children.length > 4) box.firstElementChild.remove();
  setTimeout(kill, opts.ms || (type === "err" ? 7000 : 4200));
}
export function toastError(e, title = "Something went wrong") {
  // A busy website answers 409 { error, jobId } — point at the job that holds it.
  const jobId = e?.body?.jobId;
  if (e?.status === 409 && jobId) {
    toast("Another operation is running", "warn", { msg: e.message || "Wait for it to finish, then try again.", action: { label: "View its log →", fn: () => import("./components.js").then((c) => c.openJobLog(jobId)) } });
    return;
  }
  toast(title, "err", { msg: e?.message || String(e) });
}

/* ── modals ── */
export function openModal({ title, sub, ico, tone, body, foot, size = "", onMount, dismissable = true } = {}) {
  const host = document.getElementById("modals");
  let resolve;
  const result = new Promise((r) => (resolve = r));
  const el = frag(html`<div class="modal-backdrop">
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${title || ""}">
      <div class="modal-head">
        ${ico ? html`<div class="m-ico ${tone || ""}">${icon(ico)}</div>` : ""}
        <div style="min-width:0;flex:1"><h3>${title}</h3>${sub ? html`<p>${sub}</p>` : ""}</div>
        <button class="icon-btn ghost sm" data-close aria-label="Close">${icon("x", "sm")}</button>
      </div>
      <div class="modal-body">${body || ""}</div>
      ${foot ? html`<div class="modal-foot">${foot}</div>` : ""}
    </div></div>`);
  let closed = false;
  const prevFocus = document.activeElement;
  const close = (v) => {
    if (closed) return; closed = true;
    el.classList.add("closing");
    document.removeEventListener("keydown", onKey);
    setTimeout(() => { el.remove(); prevFocus?.focus?.(); }, 160);
    resolve(v);
  };
  const onKey = (e) => { if (e.key === "Escape" && dismissable) close(undefined); };
  document.addEventListener("keydown", onKey);
  el.addEventListener("mousedown", (e) => { if (e.target === el && dismissable) close(undefined); });
  el.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(undefined); });
  host.appendChild(el);
  const modal = el.querySelector(".modal");
  onMount?.(modal, close);
  setTimeout(() => (modal.querySelector("[autofocus]") || modal.querySelector("input:not([type=hidden]):not([type=checkbox]):not([type=radio]),select,textarea"))?.focus(), 30);
  return { el: modal, close, result };
}

/** Ask for confirmation. `typed` requires the user to type that exact string. */
export function confirmDialog({ title, message, confirmText = "Confirm", danger = false, typed, ico, extra } = {}) {
  const m = openModal({
    title, ico: ico || (danger ? "alert" : "info"), tone: danger ? "danger" : "",
    body: html`${message ? html`<p class="muted" style="font-size:13.5px;line-height:1.55">${message}</p>` : ""}
      ${extra || ""}
      ${typed ? html`<div class="field mt-16"><label>Type <b class="mono" style="color:var(--text)">${typed}</b> to confirm</label>
        <input class="input mono" data-typed autocomplete="off" spellcheck="false" /></div>` : ""}`,
    foot: html`<button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn ${danger ? "btn-danger solid" : "btn-primary"}" data-ok ${typed ? "disabled" : ""}>${confirmText}</button>`,
    onMount(el, close) {
      const ok = el.querySelector("[data-ok]");
      const inp = el.querySelector("[data-typed]");
      if (inp) inp.addEventListener("input", () => (ok.disabled = inp.value.trim() !== typed));
      inp?.addEventListener("keydown", (e) => { if (e.key === "Enter" && !ok.disabled) ok.click(); });
      ok.onclick = () => {
        const vals = {};
        el.querySelectorAll("[data-extra]").forEach((x) => (vals[x.name] = x.type === "checkbox" ? x.checked : x.value));
        close(extra ? vals : true);
      };
      if (!inp) setTimeout(() => ok.focus(), 40);
    },
  });
  return m.result.then((v) => v || false);
}

/**
 * Generic form dialog.
 * fields: [{ name, label, type, value, placeholder, hint, options:[{value,label}], required, span, attrs }]
 * onSubmit(values, modal) → may throw; returning a value closes and resolves with it.
 */
export function formDialog({ title, sub, ico = "edit", fields, submitText = "Save", onSubmit, size = "", danger = false, intro }) {
  const f = (x) => {
    const id = "f_" + x.name;
    const common = html`id="${id}" name="${x.name}" ${x.required ? raw("required") : ""} ${x.attrs ? raw(x.attrs) : ""}`;
    let control;
    if (x.type === "select") {
      control = html`<select class="select" ${common}>${(x.options || []).map((o) => html`<option value="${o.value}" ${String(o.value) === String(x.value ?? "") ? raw("selected") : ""}>${o.label}</option>`)}</select>`;
    } else if (x.type === "textarea") {
      control = html`<textarea class="textarea ${x.mono ? "mono" : ""}" ${common} placeholder="${x.placeholder || ""}">${x.value ?? ""}</textarea>`;
    } else if (x.type === "switch") {
      return html`<div class="field ${x.span ? "span-2" : ""}"><label class="switch"><input type="checkbox" ${common} ${x.value ? raw("checked") : ""}/><span class="track"></span>${x.label}</label>${x.hint ? html`<div class="hint">${x.hint}</div>` : ""}</div>`;
    } else if (x.type === "html") {
      return html`<div class="field ${x.span ? "span-2" : ""}">${x.html}</div>`;
    } else {
      control = html`<input class="input ${x.mono ? "mono" : ""}" type="${x.type || "text"}" ${common} value="${x.value ?? ""}" placeholder="${x.placeholder || ""}" autocomplete="${x.autocomplete || "off"}" spellcheck="false"/>`;
    }
    return html`<div class="field ${x.span ? "span-2" : ""}"><label for="${id}">${x.label}</label>${control}${x.hint ? html`<div class="hint">${x.hint}</div>` : ""}</div>`;
  };
  const twoCol = fields.length > 3 && size;
  const m = openModal({
    title, sub, ico, tone: danger ? "danger" : "", size,
    body: html`<form class="${twoCol ? "form-grid" : "form-stack"}" novalidate>${intro || ""}${fields.map(f)}<div class="error-box span-2" data-err hidden></div><button type="submit" hidden></button></form>`,
    foot: html`<button class="btn btn-ghost" data-close>Cancel</button><button class="btn ${danger ? "btn-danger solid" : "btn-primary"}" data-submit>${submitText}</button>`,
    onMount(el, close) {
      const form = el.querySelector("form");
      const btn = el.querySelector("[data-submit]");
      const err = el.querySelector("[data-err]");
      const submit = async (e) => {
        e?.preventDefault();
        const vals = {};
        for (const x of fields) {
          const inp = form.elements[x.name];
          if (!inp) continue;
          vals[x.name] = inp.type === "checkbox" ? inp.checked : x.type === "number" ? (inp.value === "" ? null : Number(inp.value)) : inp.value.trim();
          if (x.required && !vals[x.name] && vals[x.name] !== 0) {
            inp.classList.add("invalid"); inp.focus();
            err.hidden = false; err.textContent = `${x.label} is required.`;
            return;
          }
        }
        btn.classList.add("loading"); err.hidden = true;
        try {
          const r = await onSubmit(vals, el);
          close(r === undefined ? vals : r);
        } catch (ex) {
          err.hidden = false; err.textContent = ex.message || String(ex);
        } finally { btn.classList.remove("loading"); }
      };
      form.addEventListener("submit", submit);
      btn.onclick = submit;
      form.addEventListener("input", (e) => e.target.classList?.remove("invalid"));
    },
  });
  return m.result;
}

/* ── dropdown menu ── */
let openMenuEl = null;
export function closeMenu() { openMenuEl?.remove(); openMenuEl = null; }
export function openMenu(anchor, items, { align = "right", head } = {}) {
  closeMenu();
  const el = frag(html`<div class="menu" role="menu">${head || ""}${items.filter(Boolean).map((it, i) =>
    it.sep ? html`<hr/>` : html`<button role="menuitem" data-i="${i}" class="${it.danger ? "danger" : ""}" ${it.disabled ? raw("disabled style='opacity:.4;pointer-events:none'") : ""}>${it.icon ? icon(it.icon, "sm") : ""}<span>${it.label}</span></button>`)}</div>`);
  const list = items.filter(Boolean);
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    closeMenu();
    list[Number(b.dataset.i)].onClick?.();
  });
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = align === "right" ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  el.style.left = left + "px"; el.style.top = top + "px";
  openMenuEl = el;
  setTimeout(() => {
    const off = (e) => { if (!el.contains(e.target)) { closeMenu(); document.removeEventListener("mousedown", off); } };
    document.addEventListener("mousedown", off);
  }, 0);
  return el;
}
window.addEventListener("resize", closeMenu);
window.addEventListener("scroll", closeMenu, true);

/* ── shared bits of markup ── */
export function emptyState({ ico = "sparkles", title, text, action, sm = false }) {
  return html`<div class="empty ${sm ? "sm" : ""}"><div class="e-ico">${icon(ico)}</div><h3>${title}</h3>${text ? html`<p>${text}</p>` : ""}${action ? html`<div class="btn-row">${action}</div>` : ""}</div>`;
}
export function errorState(e, retry = true) {
  return html`<div class="card card-pad"><div class="empty sm"><div class="e-ico" style="color:var(--err);background:rgba(255,93,122,.1);border-color:rgba(255,93,122,.25)">${icon("alert")}</div>
    <h3>Couldn't load this</h3><p>${e?.message || String(e)}</p>${retry ? html`<div class="btn-row"><button class="btn" data-retry>${icon("refresh")}Try again</button></div>` : ""}</div></div>`;
}
export function skeletonRows(n = 4, h = 52) {
  return html`<div class="stack" style="gap:10px">${Array.from({ length: n }, () => html`<div class="skel" style="height:${h}px;border-radius:14px"></div>`)}</div>`;
}
export function secretBox(value, { big = false } = {}) {
  return html`<div class="secret ${big ? "big" : ""}"><code>${value}</code><button class="btn btn-sm" type="button" data-copy="${value}">${icon("copy")}Copy</button></div>`;
}
// Global handler for any [data-copy] button.
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-copy]");
  if (b) { e.preventDefault(); copyText(b.getAttribute("data-copy")); }
});
