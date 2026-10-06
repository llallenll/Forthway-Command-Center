// App shell: boot, hash router, sidebar, top bar.
import { html, raw, mount, $, on, initials, toast, toastError, openMenu, errorState, debounce } from "./util.js";
import { icon } from "./icons.js";
import { get, post, MOCK, exitMock, pageUrl, ApiError } from "./api.js";
import { startEvents, onEvent, onStatus, eventStatus } from "./events.js";

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
    <span id="updateChip" class="update-chip-slot">${updateChip()}</span>
    ${liveChip()}
    <button class="account-btn" id="accountBtn" aria-haspopup="menu"><span class="avatar">${initials(me.name)}</span><span class="acc-name">${me.name || "Account"}</span>${icon("chevronDown", "sm")}</button>`);
  $("#mockChip")?.addEventListener("click", exitMock);
  $("#liveChip").onclick = (e) => toggleLivePop(e.currentTarget);
  $("#accountBtn").onclick = (e) => openMenu(e.currentTarget, [
    { label: "Account", icon: "user", onClick: () => (location.hash = "#/settings/account") },
    { label: "Admins", icon: "users", onClick: () => (location.hash = "#/settings/admins") },
    { label: "Activity log", icon: "activity", onClick: () => (location.hash = "#/activity") },
    { sep: true },
    { label: "Sign out", icon: "logout", danger: true, onClick: logout },
  ], { head: html`<div class="menu-head"><div class="strong">${me.name || ""}</div><div class="muted small">${me.github ? `@${me.github.login}` : me.email || ""}</div></div>` });
}

/* ── live-updates chip: what the SSE / polling connection is doing ── */
const LIVE = {
  connecting: { dot: "warn", label: "Connecting…", tip: "Connecting to live updates…" },
  live: { dot: "ok", label: "Live", tip: "Live updates are on: this page updates itself." },
  polling: { dot: "poll", label: "Live (polling)", tip: "Live updates via polling: a proxy is buffering the stream." },
  offline: { dot: "err", label: "Offline", tip: "Live updates can't reach the panel. Retrying…" },
};
const liveOf = (s) => LIVE[s] || LIVE.connecting;
function liveChip() {
  const st = eventStatus(), s = liveOf(st);
  return html`<span class="live-wrap"><button type="button" class="live is-${st}" id="liveChip" aria-haspopup="dialog" aria-expanded="false" aria-describedby="liveTip"><span class="dot ${s.dot}"></span><span class="live-t" aria-live="polite">${s.label}</span></button><span class="live-tip" id="liveTip" role="tooltip">${s.tip} Click for details.</span></span>`;
}
function paintLive(st) {
  const chip = $("#liveChip"); if (!chip) return;
  const s = liveOf(st);
  chip.className = `live is-${st}`;
  chip.querySelector(".dot").className = `dot ${s.dot}`;
  chip.querySelector(".live-t").textContent = s.label;
  const tip = $("#liveTip"); if (tip) tip.textContent = `${s.tip} Click for details.`;
  if (livePop) fillLivePop(st);
}
let livePop = null, livePopOff = null;
function fillLivePop(st) {
  const s = liveOf(st);
  const note = {
    connecting: "Opening the live stream…",
    live: "Connected: changes show up instantly.",
    polling: "Connected by polling: the live stream is being held back on the way, so the page asks for updates instead.",
    offline: "The panel can't be reached right now. It keeps retrying on its own.",
  }[st] || "";
  mount(livePop, html`<div class="lp-head"><span class="dot ${s.dot}"></span><strong>${s.label}</strong></div>
    <p>Live updates: this page updates itself as deploys, backups and servers change.</p>
    <p class="lp-now">${note}</p>
    <p class="muted">Polling means a proxy (e.g. Cloudflare or nginx) is buffering the live stream; updates still arrive, a few seconds slower.</p>
    ${st === "polling" || st === "offline" ? html`<p class="muted small">Behind nginx? Add <code>proxy_buffering off;</code> to the panel's <code>location /api/events</code> block.</p>` : ""}`);
}
function closeLivePop() {
  if (!livePop) return;
  livePop.remove(); livePop = null;
  livePopOff?.(); livePopOff = null;
  $("#liveChip")?.setAttribute("aria-expanded", "false");
}
function toggleLivePop(btn) {
  if (livePop) return closeLivePop();
  livePop = document.createElement("div");
  livePop.className = "live-pop";
  livePop.setAttribute("role", "dialog");
  livePop.setAttribute("aria-label", "Live updates");
  fillLivePop(eventStatus());
  document.body.appendChild(livePop);
  const r = btn.getBoundingClientRect(), w = livePop.offsetWidth;
  livePop.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + "px";
  livePop.style.top = r.bottom + 8 + "px";
  btn.setAttribute("aria-expanded", "true");
  const down = (e) => { if (!livePop?.contains(e.target) && !btn.contains(e.target)) closeLivePop(); };
  const key = (e) => { if (e.key === "Escape") { closeLivePop(); btn.focus(); } };
  document.addEventListener("mousedown", down);
  document.addEventListener("keydown", key);
  window.addEventListener("resize", closeLivePop);
  livePopOff = () => {
    document.removeEventListener("mousedown", down);
    document.removeEventListener("keydown", key);
    window.removeEventListener("resize", closeLivePop);
  };
}

/* Password sign-in is being retired: nag until Settings → Security switches the panel to GitHub-only. */
function paintAuthBanner() {
  const el = $("#authBanner");
  if (!el) return;
  const on = !MOCK && state.settings?.authMode === "password";
  el.hidden = !on;
  if (!on) return mount(el, html``);
  mount(el, html`<div class="auth-banner" role="status">${icon("alert")}<div><div class="strong">Password sign-in is being retired — set up Sign in with GitHub in Settings → Security</div>
    <div class="muted">${state.me?.github ? "Your GitHub account is linked. Switch the panel to GitHub-only when every admin is linked." : "Link your GitHub account, then switch the panel to GitHub-only."}</div></div>
    <a class="btn btn-sm btn-primary" href="#/settings/security">${icon("github")}Open Security</a></div>`);
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
    <div class="ver"><span>${shortName()}</span><span>v${state.version || "3.1.0"}</span></div>`);
}

/* ───────── panel self-update: top-bar badge + restart watcher ───────── */

function updateChip() {
  const u = state.update;
  if (!u || u.available !== true || u.restart?.pending) return "";
  const to = u.latest ? `${u.latest.version ? `v${u.latest.version} · ` : ""}${u.latest.shortCommit || ""}` : "";
  return html`<a class="update-chip" href="#/settings/updates" title="${`A newer version of the panel is on GitHub${to ? ` (${to})` : ""}. Open Settings → Updates.`}">${icon("arrowUp", "xs")}<span>Update available</span></a>`;
}
function paintUpdateChip(u) {
  if (u && typeof u === "object" && u.installed) state.update = u;
  const slot = $("#updateChip");
  if (slot) mount(slot, html`${updateChip()}`);
}

/** After an update/restore, wait for the panel to come back (new bootId on /healthz), then reload. */
let restartWatch = null;
export function watchRestart(oldBootId) {
  if (restartWatch || MOCK) return;
  const el = document.createElement("div");
  el.className = "restart-banner";
  el.setAttribute("role", "status");
  document.body.appendChild(el);
  const paint = (title, msg, actions = "") => mount(el, html`<span class="rb-spin" aria-hidden="true"></span><div><div class="strong">${title}</div><div class="muted small">${msg}</div></div>${actions}`);
  paint("Restarting the panel…", "This page reloads by itself when the new version is running.");
  const started = Date.now();
  let sawDown = false;
  restartWatch = setInterval(async () => {
    let h = null;
    try {
      const res = await fetch("healthz", { cache: "no-store", credentials: "same-origin" });
      h = res.ok ? await res.json() : null;
    } catch { h = null; }
    if (!h) sawDown = true;
    const back = h && (h.bootId ? h.bootId !== oldBootId : sawDown);
    if (back) { clearInterval(restartWatch); paint("Panel is back", "Reloading…"); setTimeout(() => location.reload(), 600); return; }
    if (Date.now() - started > 180_000) {
      clearInterval(restartWatch);
      el.classList.add("err");
      paint("The panel hasn't come back yet", raw("Check <span class=\"mono\">systemctl status fcc</span> and <span class=\"mono\">journalctl -u fcc -n 50</span> on the server. You can roll back from Settings → Updates once it's up."),
        html`<button class="btn btn-sm" type="button" onclick="location.reload()">Reload</button>`);
    }
  }, 2000);
}

function initUpdates() {
  // Page load: a soft check (the server skips it when the last one is recent and honours GitHub's rate limit).
  post("/api/updates/check").then(paintUpdateChip).catch(() => get("/api/updates").then(paintUpdateChip).catch(() => {}));
  onEvent("updates", (u) => {
    paintUpdateChip(u);
    if (u?.restarting) watchRestart(u.bootId);
  });
  window.addEventListener("fcc:updates", (e) => paintUpdateChip(e.detail));
  window.addEventListener("fcc:restarting", (e) => watchRestart(e.detail?.bootId));
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
  initUpdates();
  onStatus(paintLive);
  onEvent("lb", debounce(paintSidebarStatus, 500));
  onEvent("job", (j) => {
    // Global heads-up when a job finishes while you're elsewhere.
    if (!j || !j.finishedAt || Date.now() - new Date(j.finishedAt) > 8000) return;
    if (j.status === "failed") toast(`${j.title || j.type} failed`, "err", { msg: j.error || "", action: { label: "View log →", fn: () => import("./components.js").then((c) => c.openJobLog(j.id)) } });
    else if (j.status === "succeeded") toast(`${j.title || j.type}`, "ok", { msg: "Finished successfully." });
  });
  onEvent("monitor", (d) => {
    // MONITOR: a website went down / came back (uptime checks).
    if (!d || (d.kind !== "down" && d.kind !== "up") || Date.now() - new Date(d.at) > 15000) return;
    const open = { label: "View uptime →", fn: () => (location.hash = `#/sites/${d.siteId}/uptime`) };
    if (d.kind === "down") toast(`${d.siteName} is down`, "err", { msg: d.cause || "", action: open });
    else toast(`${d.siteName} is back up`, "ok", { msg: d.durationMs ? `Down for ${Math.max(1, Math.round(d.durationMs / 60000))} min.` : "", action: open });
  });

  window.addEventListener("hashchange", route);
  window.addEventListener("fcc:me", () => { paintTop(); paintAuthBanner(); });
  window.addEventListener("fcc:settings", () => { paintBrand(); paintSidebarStatus(); paintAuthBanner(); });
  paintAuthBanner();
  route();
}

boot();
