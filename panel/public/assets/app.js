// App shell: boot, hash router, sidebar, top bar.
import { html, raw, mount, $, on, initials, toast, toastError, openMenu, errorState, debounce } from "./util.js";
import { icon } from "./icons.js";
import { get, post, MOCK, exitMock, pageUrl, ApiError } from "./api.js";
import { startEvents, onEvent, onStatus } from "./events.js";

export const state = { me: null, settings: null, version: null };
const shortName = () => (state.settings?.panelName || "Forthway").replace(/\s*command\s*center\s*$/i, "") || "Forthway";
function paintBrand() { $("#brandName").textContent = shortName(); }

const NAV = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard", href: "#/" },
  { id: "projects", label: "Projects", icon: "folder", href: "#/projects" },
  { id: "sites", label: "Websites", icon: "globe", href: "#/sites" },
  { id: "databases", label: "Databases", icon: "database", href: "#/databases" },
  { id: "backups", label: "Backups", icon: "archive", href: "#/backups" },
  { id: "servers", label: "Servers", icon: "server", href: "#/servers" },
];
const NAV_BOTTOM = [
  { id: "activity", label: "Activity", icon: "activity", href: "#/activity" },
  { id: "settings", label: "Settings", icon: "settings", href: "#/settings" },
];

const ROUTES = [
  ["/", "dashboard", "dashboard"],
  ["/projects", "projects", "projects"],
  ["/projects/:id", "project", "projects"],
  ["/projects/:id/:tab", "project", "projects"],
  ["/sites", "sites", "sites"],
  ["/sites/new", "wizard", "sites"],
  ["/sites/:id", "site", "sites"],
  ["/sites/:id/:tab", "site", "sites"],
  ["/databases", "databases", "databases"],
  ["/backups", "backups", "backups"],
  ["/backups/:tab", "backups", "backups"],
  ["/servers", "servers", "servers"],
  ["/activity", "activity", "activity"],
  ["/settings", "settings", "settings"],
  ["/settings/:tab", "settings", "settings"],
].map(([p, view, nav]) => {
  const keys = [];
  const re = new RegExp("^" + p.replace(/:([a-z]+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "/?$");
  return { re, keys, view, nav };
});

function paintNav(active) {
  const item = (n) => html`<a class="nav-item ${n.id === active ? "active" : ""}" href="${n.href}">${icon(n.icon)}<span>${n.label}</span></a>`;
  mount($("#sbNav"), html`<div class="sb-label">Workspace</div>${NAV.map(item)}`);
  mount($("#sbNavBottom"), html`${NAV_BOTTOM.map(item)}`);
}

function paintTop() {
  const me = state.me || {};
  mount($("#topRight"), html`
    ${MOCK ? html`<button class="mock-chip" id="mockChip" title="Using fixture data. Click to switch to the real API.">${icon("sparkles", "xs")}Mock data</button>` : ""}
    <span class="live" id="liveChip" title="Live updates"><span class="dot off"></span><span class="live-t">Connecting</span></span>
    <button class="account-btn" id="accountBtn" aria-haspopup="menu"><span class="avatar">${initials(me.name)}</span><span class="acc-name">${me.name || "Account"}</span>${icon("chevronDown", "sm")}</button>`);
  $("#mockChip")?.addEventListener("click", exitMock);
  $("#accountBtn").onclick = (e) => openMenu(e.currentTarget, [
    { label: "Account", icon: "user", onClick: () => (location.hash = "#/settings/account") },
    { label: "Admins", icon: "users", onClick: () => (location.hash = "#/settings/admins") },
    { label: "Activity log", icon: "activity", onClick: () => (location.hash = "#/activity") },
    { sep: true },
    { label: "Sign out", icon: "logout", danger: true, onClick: logout },
  ], { head: html`<div class="menu-head"><div class="strong">${me.name || ""}</div><div class="muted small">${me.email || ""}</div></div>` });
}

async function logout() {
  try { await post("/api/logout"); } catch {}
  location.href = pageUrl("login.html");
}

async function paintSidebarStatus() {
  const [lb, my] = await Promise.all([get("/api/loadbalancer").catch(() => null), get("/api/mysql/status").catch(() => null)]);
  const row = (label, ok, txt) => html`<div class="row"><span><span class="dot ${ok === null ? "off" : ok ? "ok" : "err"}"></span>${label}</span><span>${txt}</span></div>`;
  mount($("#sbStatus"), html`
    ${row("nginx", lb ? (lb.installed || lb.dryRun) && lb.configOk !== false : null, lb ? (lb.installed ? (lb.configOk === false ? "config error" : "running") : lb.dryRun ? "dry run" : "not installed") : "—")}
    ${row("MySQL", my ? my.installed && my.running : null, my ? (my.installed ? (my.running ? "running" : "stopped") : "not installed") : "—")}
    <div class="ver"><span>${shortName()}</span><span>v${state.version || "3.0.0"}</span></div>`);
}

/* ───────── router ───────── */

let current = { cleanups: [], token: 0 };
const crumbsEl = () => $("#crumbs");

export function setCrumbs(list) {
  const home = html`<a class="crumb" href="#/">${icon("dashboard", "sm")}<span>${shortName()}</span></a>`;
  mount(crumbsEl(), html`${home}${list.map((c, i) => html`<span class="crumb-sep">${icon("chevronRight", "xs")}</span>${c.href && i < list.length - 1 ? html`<a class="crumb" href="${c.href}">${c.label}</a>` : html`<span class="crumb current">${c.label}</span>`}`)}`);
  document.title = `${list.length ? list[list.length - 1].label + " · " : ""}${shortName()} Command Center`;
}

function parseHash() {
  const h = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = h.split("?");
  return { path: path || "/", query: Object.fromEntries(new URLSearchParams(qs || "")) };
}

async function route() {
  const { path, query } = parseHash();
  current.cleanups.forEach((f) => { try { f(); } catch {} });
  const token = ++current.token;
  current = { cleanups: [], token };
  document.body.classList.remove("drawer-open");

  let match = null, params = {};
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (m) { match = r; r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]))); break; }
  }
  // Views bind delegated listeners on their root; give every route a fresh element so
  // handlers from the previous page (e.g. its [data-new] button) can't fire here too.
  const old = $("#view");
  const view = old.cloneNode(false);
  old.replaceWith(view);
  if (!match) {
    paintNav("");
    setCrumbs([{ label: "Not found" }]);
    mount(view, html`<div class="empty"><div class="e-ico">${icon("search")}</div><h3>Page not found</h3><p>There's nothing at <span class="mono">${path}</span>.</p><div class="btn-row"><a class="btn btn-primary" href="#/">Back to dashboard</a></div></div>`);
    return;
  }
  paintNav(match.nav);
  view.classList.remove("fade-in"); void view.offsetWidth; view.classList.add("fade-in");
  const ctx = {
    root: view, params, query, path,
    alive: () => current.token === token,
    on(type, fn) { const off = onEvent(type, (d, t) => { if (current.token === token) fn(d, t); }); current.cleanups.push(off); return off; },
    cleanup(fn) { current.cleanups.push(fn); },
    crumbs: setCrumbs,
    reload: () => route(),
    state,
  };
  try {
    const mod = await import(`./views/${match.view}.js`);
    if (current.token !== token) return;
    await mod.default(ctx);
  } catch (e) {
    if (current.token !== token) return;
    console.error(e);
    mount(view, errorState(e));
    view.querySelector("[data-retry]")?.addEventListener("click", route);
  }
  if (!query.keepScroll) window.scrollTo({ top: 0 });
}

/* ───────── boot ───────── */

async function boot() {
  $("#menuBtn").innerHTML = icon("menu").toString();
  $("#sbClose").innerHTML = icon("x").toString();
  $("#menuBtn").onclick = () => document.body.classList.add("drawer-open");
  $("#sbClose").onclick = $("#sbOverlay").onclick = () => document.body.classList.remove("drawer-open");
  paintNav("");

  try {
    state.me = await get("/api/me", { quiet401: true });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      const s = await get("/api/setup").catch(() => null);
      location.href = pageUrl(s?.needsSetup ? "setup.html" : "login.html");
      return;
    }
    mount($("#view"), errorState(e));
    $("#view [data-retry]")?.addEventListener("click", () => location.reload());
    return;
  }
  const [settings, setup] = await Promise.all([get("/api/settings").catch(() => null), get("/api/setup").catch(() => null)]);
  state.settings = settings;
  state.version = setup?.version;
  paintBrand();
  paintTop();
  paintSidebarStatus();

  startEvents();
  onStatus((s) => {
    const chip = $("#liveChip"); if (!chip) return;
    chip.classList.toggle("on", s === "live");
    mount(chip, html`<span class="dot ${s === "live" ? "ok" : s === "offline" ? "err" : "off"}"></span><span class="live-t">${s === "live" ? "Live" : s === "offline" ? "Reconnecting" : "Connecting"}</span>`);
  });
  onEvent("lb", debounce(paintSidebarStatus, 500));
  onEvent("job", (j) => {
    // Global heads-up when a job finishes while you're elsewhere.
    if (!j || !j.finishedAt || Date.now() - new Date(j.finishedAt) > 8000) return;
    if (j.status === "failed") toast(`${j.title || j.type} failed`, "err", { msg: j.error || "", action: { label: "View log →", fn: () => import("./components.js").then((c) => c.openJobLog(j.id)) } });
    else if (j.status === "succeeded") toast(`${j.title || j.type}`, "ok", { msg: "Finished successfully." });
  });

  window.addEventListener("hashchange", route);
  window.addEventListener("fcc:me", () => paintTop());
  window.addEventListener("fcc:settings", () => { paintBrand(); paintSidebarStatus(); });
  route();
}

boot();
