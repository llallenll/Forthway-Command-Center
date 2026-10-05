// Settings: General · Admins · Security · Servers & load balancing · Backups · GitHub · Updates · Account.
// Routed as #/settings/<section>. Every user-supplied string goes through html``.
import { html, raw, mount, $, on, ago, initials, plural, toast, toastError, confirmDialog, formDialog, openMenu, emptyState, errorState, skeletonRows, debounce } from "../util.js";
import { icon } from "../icons.js";
import { get, post, patch, del } from "../api.js";
import { pageHead, openJobLog, serverKind, METHOD_LABEL } from "../components.js";
import { scheduleForm } from "./backups.js";
import { cloudflareSettings } from "./cloudflare.js"; // Cloudflare section (lives in its own file)
import { mysqlSettings, phpMyAdminSettings } from "./settings-databases.js"; // Databases + phpMyAdmin sections
import { notificationsSettings } from "./monitor.js"; // Notifications section (uptime SMS alerts via Bird)
import { fmtBytes as updFmtBytes } from "../util.js"; // Updates section (aliased: avoids clashing with the shared import line)
import { admins, security, account } from "./settings-auth.js"; // Admins + Security + Account (Sign in with GitHub)

const SECTIONS = [
  { id: "general", label: "General", icon: "settings", render: general },
  { id: "admins", label: "Admins", icon: "users", render: admins },
  { id: "security", label: "Security", icon: "shield", render: security },
  { id: "servers", label: "Servers & load balancing", icon: "balance", render: serversLb },
  { id: "backups", label: "Backups", icon: "archive", render: backups },
  { id: "databases", label: "Databases", icon: "database", render: mysqlSettings },
  { id: "phpmyadmin", label: "phpMyAdmin", icon: "layers", render: phpMyAdminSettings },
  { id: "github", label: "GitHub", icon: "github", render: github },
  { id: "cloudflare", label: "Cloudflare", icon: "cloud", render: cloudflareSettings },
  { id: "notifications", label: "Notifications", icon: "bell", render: notificationsSettings },
  { id: "updates", label: "Updates", icon: "refresh", render: updates },
  { id: "account", label: "Account", icon: "user", render: account },
];
const ALIASES = { loadbalancer: "servers", lb: "servers", hosting: "servers", me: "account", profile: "account", auth: "security", login: "security", signin: "security", tunnel: "cloudflare", zerotrust: "cloudflare", sms: "notifications", alerts: "notifications" };

export default async function settings(ctx) {
  const { root, params } = ctx;
  const id = ALIASES[params.tab] || params.tab || "general";
  const sec = SECTIONS.find((s) => s.id === id) || SECTIONS[0];
  ctx.crumbs([{ label: "Settings", href: "#/settings" }, { label: sec.label }]);
  mount(root, html`${pageHead("Settings", "Panel-wide configuration, the people who can sign in, and where backups go.")}
    <div class="settings">
      <nav class="settings-nav" aria-label="Settings sections">${SECTIONS.map((s) => html`<a href="#/settings/${s.id}" class="${s.id === sec.id ? "active" : ""}" ${s.id === sec.id ? raw('aria-current="page"') : ""}>${icon(s.icon, "sm")}<span>${s.label}</span></a>`)}</nav>
      <div class="stack" data-sec style="min-width:0">${skeletonRows(3, 120)}</div>
    </div>`);
  const box = $("[data-sec]", root);
  try {
    await sec.render(box, ctx);
  } catch (e) {
    if (!ctx.alive()) return;
    console.error(e);
    mount(box, errorState(e));
    $("[data-retry]", box)?.addEventListener("click", () => ctx.reload());
  }
}

/* ───────── helpers ───────── */

function setBusy(btn, busy) { btn.classList.toggle("loading", busy); btn.disabled = busy; }
function showErr(el, msg) { el.hidden = !msg; mount(el, msg ? html`${icon("alert")}<div>${msg}</div>` : html``); }
function announce(name, patchObj, target) {
  Object.assign(target, patchObj);
  window.dispatchEvent(new Event(name));
}
const field = (label, control, hint) => html`<div class="field"><label>${label}</label>${control}${hint ? html`<div class="hint">${hint}</div>` : ""}</div>`;

/* ───────── General ───────── */

async function general(box, ctx) {
  const s = await get("/api/settings");
  if (!ctx.alive()) return;
  mount(box, html`
    <form class="card" data-form novalidate>
      <div class="card-head"><div><h3>Panel</h3><div class="sub">How this panel names itself and the address agents use to reach it.</div></div></div>
      <div class="card-body"><div class="form-stack">
        ${field("Panel name", html`<input class="input" name="panelName" maxlength="60" value="${s.panelName || ""}" placeholder="Forthway Command Center" autocomplete="off"/>`, "Shown in the sidebar, the browser tab and the sign-in page.")}
        ${field("Panel URL", html`<input class="input mono" name="panelUrl" value="${s.panelUrl || ""}" placeholder="${s.panelUrlEffective || "https://panel.example.com"}" autocomplete="off" spellcheck="false"/>`,
          html`Put into agent install commands and release download links. Leave blank to use ${s.panelUrlEffective ? html`<span class="mono">${s.panelUrlEffective}</span>` : "the address you opened the panel with"}.`)}
        <div class="error-box" data-err hidden></div>
      </div></div>
      <div class="card-foot"><span class="muted small" data-state></span><span class="spacer"></span><button class="btn btn-primary" type="submit" data-save>${icon("check")}Save changes</button></div>
    </form>
    <div class="card"><div class="card-head"><h3>About this panel</h3>${s.dryRun ? html`<div class="right"><span class="badge warn">${icon("alert")}Dry run</span></div>` : ""}</div>
      <div class="card-body"><dl class="kv">
        <dt>Version</dt><dd>v${s.version || "—"}</dd>
        <dt>Hostname</dt><dd class="mono">${s.hostname || "—"}</dd>
        <dt>Address in use</dt><dd class="mono">${s.panelUrlEffective || "—"}</dd>
        ${s.dryRun ? html`<dt>Mode</dt><dd>Dry run — system commands are simulated, nothing on this machine is changed.</dd>` : ""}
      </dl></div></div>`);
  const form = $("[data-form]", box), err = $("[data-err]", box), btn = $("[data-save]", box);
  let saved = { panelName: s.panelName || "", panelUrl: s.panelUrl || "" };
  const dirty = () => form.elements.panelName.value.trim() !== saved.panelName || form.elements.panelUrl.value.trim() !== saved.panelUrl;
  const paintState = () => ($("[data-state]", box).textContent = dirty() ? "Unsaved changes" : "");
  form.addEventListener("input", paintState);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showErr(err, "");
    const body = { panelName: form.elements.panelName.value.trim(), panelUrl: form.elements.panelUrl.value.trim() };
    setBusy(btn, true);
    try {
      const r = await patch("/api/settings", body);
      saved = { panelName: r.panelName || "", panelUrl: r.panelUrl || "" };
      form.elements.panelName.value = saved.panelName;
      form.elements.panelUrl.value = saved.panelUrl;
      announce("fcc:settings", r, (ctx.state.settings ||= {}));
      toast("Settings saved", "ok");
      paintState();
    } catch (ex) { showErr(err, ex.message); }
    finally { setBusy(btn, false); }
  });
}

/* Admins, Security and Account live in settings-auth.js. */

/* ───────── Servers & load balancing ───────── */

async function serversLb(box, ctx) {
  let lb = null, servers = [];
  const load = async () => {
    const [l, s] = await Promise.all([get("/api/loadbalancer"), get("/api/servers").catch(() => ({ items: [] }))]);
    lb = l; servers = s.items || [];
    if (ctx.alive()) paint();
  };
  const paint = () => {
    const sim = !lb.installed && lb.dryRun;
    const good = (lb.installed || sim) && lb.configOk !== false;
    const tone = lb.configOk === false ? "err" : sim ? "off" : !lb.installed ? "err" : lb.lastError ? "warn" : "ok";
    const lbSites = (lb.sites || []).filter((x) => x.loadBalanced);
    const online = servers.filter((x) => x.online).length;
    mount(box, html`
      <div class="card">
        <div class="card-head" style="flex-wrap:wrap">
          <div class="row" style="flex:1 1 240px;min-width:0;gap:12px"><span style="width:38px;height:38px;border-radius:11px;display:grid;place-items:center;flex:none;background:${good ? "rgba(61,220,151,.12)" : "rgba(255,93,122,.12)"};color:${good ? "var(--ok)" : "var(--err)"}">${icon("balance")}</span>
          <div style="min-width:0"><h3>Front door · nginx${lb.version ? html` <span class="muted" style="font-weight:500">v${lb.version}</span>` : ""}</h3>
            <div class="sub">${sim ? html`Dry run — config files are written but nginx is not touched${lb.lastAppliedAt ? html` · applied ${ago(lb.lastAppliedAt)}` : ""}` : !lb.installed ? "nginx is not installed on the main server" : lb.configOk === false ? "The last config test failed — websites keep the previous config" : lb.lastAppliedAt ? html`Config OK · applied ${ago(lb.lastAppliedAt)}` : "Config not applied yet since the panel started"}</div></div></div>
          <div class="right"><button class="btn" data-apply ${lb.installed || lb.dryRun ? "" : raw("disabled")}>${icon("refresh")}Re-apply load balancer</button></div>
        </div>
        ${lb.lastError ? html`<div class="card-body" style="padding-bottom:0"><div class="error-box">${icon("alert")}<div class="mono small">${lb.lastError}</div></div></div>` : ""}
        <div class="card-body"><dl class="kv">
          <dt>Status</dt><dd><span class="status"><span class="dot ${tone}"></span>${sim ? "Simulated (dry run)" : !lb.installed ? "Not installed" : lb.live ? "Running" : "Not running"}</span></dd>
          <dt>Config test</dt><dd>${lb.configOk === false ? html`<span class="badge err">Failed</span>` : lb.configOk ? html`<span class="badge ok">Passed</span>` : html`<span class="muted">Not run yet</span>`}</dd>
          <dt>Certificates</dt><dd>${lb.certbot ? "certbot available — request SSL from a website's Domains & SSL tab" : html`<span class="muted">certbot not installed</span>`}</dd>
          <dt>Config folder</dt><dd class="mono">${lb.confDir || "—"}</dd>
        </dl>
        <p class="hint mt-16">Re-applying rewrites every website's nginx file from the panel's records, tests it with <span class="mono">nginx -t</span> and reloads only if the test passes. Use it after editing nginx by hand or if a site's routing looks wrong.</p></div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>Load-balanced websites</h3><div class="sub">${lbSites.length ? `${plural(lbSites.length, "website")} spread across several servers` : "None yet"}</div></div></div>
        ${lbSites.length ? html`<div class="list">${lbSites.map((x) => html`<a class="list-item" href="#/sites/${x.id}">
            <span class="li-ico">${icon("globe", "sm")}</span>
            <div class="li-main"><div class="li-title">${x.name}</div><div class="li-sub">${(x.domains || [])[0] || "no domain"} · ${METHOD_LABEL[x.method] || x.method || ""}</div></div>
            <div class="li-right">${(x.upstreams || []).map((u) => html`<span class="row tiny" style="gap:5px" title="${u.name}: ${u.down ? "taken out of rotation" : !u.online ? "offline" : u.healthy === false ? "unhealthy" : u.healthy ? "healthy" : "not checked yet"}"><span class="dot ${u.down || u.healthy === false ? "err" : !u.online ? "off" : u.healthy ? "ok" : "off"}"></span><span class="hide-sm">${u.name}</span></span>`)}</div></a>`)}</div>`
          : html`<div class="card-body"><p class="muted small">Turn on load balancing when creating a website, or later from its Settings tab. You need at least two servers marked “Available for load balancing”.</p></div>`}
      </div>

      <div class="card">
        <div class="card-head"><div><h3>Servers</h3><div class="sub">${servers.length ? `${online} of ${servers.length} online · ${servers.filter((x) => x.lbEligible !== false).length} available for load balancing` : "Loading…"}</div></div>
          <div class="right"><a class="btn btn-sm" href="#/servers">${icon("server")}Manage servers</a></div></div>
        ${servers.length ? html`<div class="list">${servers.map((x) => html`<a class="list-item" href="#/servers">
            <span class="li-ico">${icon("server", "sm")}</span>
            <div class="li-main"><div class="li-title">${x.name}</div><div class="li-sub">${serverKind(x)}${x.host ? html` · <span class="mono">${x.host}</span>` : ""} · ${plural(x.siteCount || 0, "site")}</div></div>
            <div class="li-right">${x.lbEligible !== false ? html`<span class="badge badge-lb hide-sm">${icon("balance")}LB pool</span>` : ""}${x.enabled === false ? html`<span class="badge warn">Disabled</span>` : ""}
              <span class="status"><span class="dot ${x.online ? "ok" : "off"}"></span>${x.online ? "Online" : x.lastSeenAt ? `Seen ${ago(x.lastSeenAt)}` : "Offline"}</span></div></a>`)}</div>`
          : html`<div class="card-body"><p class="muted small">Add agent servers, rotate tokens and choose which servers join load-balanced pools on the Servers page.</p></div>`}
      </div>`);
  };
  await load();
  on(box, "click", "[data-apply]", async (e, b) => {
    setBusy(b, true);
    try { const job = await post("/api/loadbalancer/apply"); if (job?.id) openJobLog(job.id); else toast("Load balancer re-applied", "ok"); }
    catch (ex) { toastError(ex, "Couldn't re-apply the load balancer"); }
    finally { setBusy(b, false); }
  });
  ctx.on(["lb", "server", "site"], debounce(() => load().catch(() => {}), 600));
}

/* ───────── Backups ───────── */

async function backups(box, ctx) {
  mount(box, html`<div class="note">${icon("info")}<div>Schedules and storage for automatic backups. To create, download or restore a backup, go to <a href="#/backups" style="color:var(--text);font-weight:600">Backups</a>.</div></div><div data-sched></div>`);
  await scheduleForm($("[data-sched]", box), ctx);
}

/* ───────── GitHub ───────── */

async function github(box, ctx) {
  let s = await get("/api/settings");
  if (!ctx.alive()) return;
  const paint = () => {
    mount(box, html`<form class="card" data-form novalidate>
      <div class="card-head"><div><h3>GitHub access token</h3><div class="sub">Used to list branches and download releases from private repositories.</div></div>
        <div class="right">${s.githubTokenSet ? html`<span class="badge ok">${icon("check")}Saved</span>` : html`<span class="badge">Not set</span>`}</div></div>
      <div class="card-body"><div class="form-stack">
        ${s.githubTokenSet ? html`<div class="row" style="gap:10px"><span class="li-ico" style="width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:rgba(148,166,255,.07)">${icon("key", "sm")}</span>
          <div><div class="strong small">Panel-wide token</div><div class="muted small mono">${s.githubTokenHint || "••••"}</div></div></div>` : ""}
        ${field(s.githubTokenSet ? "Replace token" : "Token", html`<div class="pw-wrap"><input class="input mono" type="password" name="token" placeholder="github_pat_… or ghp_…" autocomplete="off" spellcheck="false"/><button type="button" class="icon-btn" data-toggle-pw aria-label="Show token">${icon("eye")}</button></div>`,
          html`A fine-grained token with <b>Contents: Read-only</b> on the repositories you deploy is enough. A website can also have its own token in its Settings tab, which wins over this one. The token is never shown again after saving.`)}
        <div class="error-box" data-err hidden></div>
      </div></div>
      <div class="card-foot">${s.githubTokenSet ? html`<button class="btn btn-danger" type="button" data-clear>${icon("trash")}Remove token</button>` : ""}<span class="spacer"></span>
        <button class="btn btn-primary" type="submit" data-save>${icon("check")}${s.githubTokenSet ? "Replace token" : "Save token"}</button></div>
    </form>
    <div class="note">${icon("info")}<div>Public repositories work without a token. Without one, GitHub limits the panel to 60 API requests an hour.</div></div>`);
  };
  paint();
  on(box, "click", "[data-toggle-pw]", (e, b) => {
    const inp = b.parentElement.querySelector("input");
    inp.type = inp.type === "password" ? "text" : "password";
    mount(b, html`${icon(inp.type === "password" ? "eye" : "eyeOff")}`);
  });
  on(box, "submit", "[data-form]", async (e, form) => {
    e.preventDefault();
    const err = $("[data-err]", box), btn = $("[data-save]", box);
    const token = form.elements.token.value.trim();
    if (!token) { showErr(err, "Paste a token first."); form.elements.token.focus(); return; }
    showErr(err, ""); setBusy(btn, true);
    try { s = await patch("/api/settings", { githubToken: token }); announce("fcc:settings", s, (ctx.state.settings ||= {})); toast("GitHub token saved", "ok"); paint(); }
    catch (ex) { showErr(err, ex.message); setBusy(btn, false); }
  });
  on(box, "click", "[data-clear]", async (e, b) => {
    const ok = await confirmDialog({ title: "Remove the GitHub token?", message: "Private repositories that don't have their own token stop deploying from GitHub until you add one again.", danger: true, confirmText: "Remove token" });
    if (!ok) return;
    setBusy(b, true);
    try { s = await patch("/api/settings", { githubToken: "" }); announce("fcc:settings", s, (ctx.state.settings ||= {})); toast("GitHub token removed", "ok"); paint(); }
    catch (ex) { toastError(ex, "Couldn't remove the token"); setBusy(b, false); }
  });
}

/* ───────── Updates (panel self-update) ───────── */

async function updates(box, ctx) {
  let u = await get("/api/updates");
  let backupsList = [];
  const loadBackups = async () => { try { backupsList = (await get("/api/updates/backups")).items || []; } catch { backupsList = []; } };
  await loadBackups();
  if (!ctx.alive()) return;
  const short = (sha) => (sha ? String(sha).slice(0, 7) : "");
  const ghLink = (url, text) => html`<a href="${url}" target="_blank" rel="noopener noreferrer" class="mono" style="color:var(--text)">${text}</a>`;
  const share = () => window.dispatchEvent(new CustomEvent("fcc:updates", { detail: u }));
  const RESTART_HINT = {
    systemd: "The panel restarts by itself and this page reloads when it's back (usually a few seconds).",
    service: "fcc.service is restarted for you and this page reloads when it's back.",
    manual: "This panel isn't running under systemd, so restart it yourself after updating.",
    simulated: "Development mode: the download and checks are real, but nothing in this folder is replaced and nothing restarts.",
  };

  const paint = () => {
    const inst = u.installed || {};
    const L = u.latest;
    const busy = u.job;
    const repoRef = `${u.repo}@${u.ref}`;
    const badge = u.restart?.pending ? html`<span class="badge blue">${icon("restart")}Restarting…</span>`
      : busy ? html`<span class="badge blue">${icon("refresh")}${busy.type === "panel.restore" ? "Restoring…" : "Updating…"}</span>`
      : u.available === true ? html`<span class="badge warn">${icon("arrowUp")}Update available</span>`
      : u.available === false ? html`<span class="badge ok">${icon("check")}Up to date</span>`
      : html`<span class="badge">${u.lastCheckedAt ? "Unknown" : "Not checked"}</span>`;
    const showUpdate = !!L && u.available !== false;
    mount(box, html`
      <div class="card">
        <div class="card-head" style="flex-wrap:wrap">
          <div class="row" style="flex:1 1 260px;min-width:0;gap:12px"><span style="width:38px;height:38px;border-radius:11px;display:grid;place-items:center;flex:none;background:rgba(74,114,255,.14);color:#9db3ff">${icon("sparkles")}</span>
            <div style="min-width:0"><h3>Panel version <span class="muted" style="font-weight:500;margin-left:6px">v${inst.version || "—"}</span></h3>
              <div class="sub">${inst.shortCommit ? html`Commit <span class="mono">${inst.shortCommit}</span> · ` : ""}from <span class="mono">${repoRef}</span></div></div></div>
          <div class="right row" style="gap:8px">${badge}<button class="btn btn-sm" type="button" data-check ${u.checking ? raw("disabled") : ""}>${icon("refresh")}Check for updates</button></div>
        </div>
        <div class="card-body">
          ${u.simulate ? html`<div class="note warn" style="margin-bottom:14px">${icon("info")}<div>${u.simulate === "dry-run" ? "Dry run" : "Running from a git checkout"} — checking GitHub is real, but <b>Update now</b> and <b>Restore</b> only simulate the swap: downloads, checks and backups go to the data folder and this folder is never overwritten.</div></div>` : ""}
          ${u.error ? html`<div class="error-box" style="margin-bottom:14px">${icon("alert")}<div>${u.error}</div></div>` : ""}
          <dl class="kv">
            <dt>Installed</dt><dd>v${inst.version || "—"}${inst.commit ? html` · ${ghLink(`https://github.com/${u.repo}/commit/${inst.commit}`, inst.shortCommit)}` : html` · <span class="muted">commit unknown</span>`}${inst.installedAt ? html` <span class="muted">· installed ${ago(inst.installedAt)}</span>` : ""}</dd>
            <dt>Channel</dt><dd><span class="mono">${repoRef}</span></dd>
            <dt>Latest on GitHub</dt><dd>${L ? html`${L.version ? `v${L.version} · ` : ""}${ghLink(L.url, L.shortCommit)} <span class="muted">— ${L.message}${L.date ? html` · ${ago(L.date)}` : ""}</span>` : html`<span class="muted">—</span>`}</dd>
            <dt>Last checked</dt><dd>${u.checking ? "Checking…" : u.lastCheckedAt ? ago(u.lastCheckedAt) : html`<span class="muted">never</span>`}${u.rateLimitedUntil ? html` <span class="badge warn">rate limited until ${new Date(u.rateLimitedUntil).toLocaleTimeString()}</span>` : ""}</dd>
          </dl>
          ${u.reason ? html`<p class="hint mt-16">${u.reason}${!u.tokenSet ? " Checks are anonymous (60 GitHub requests an hour); a token in Settings → GitHub raises that." : ""}</p>` : ""}
        </div>
      </div>

      ${showUpdate ? html`<div class="card">
        <div class="card-head"><div><h3>What's new</h3><div class="sub">${u.changes.length
          ? html`${u.totalChanges && u.totalChanges > u.changes.length ? `${u.totalChanges} commits (newest ${u.changes.length} shown)` : plural(u.changes.length, "new commit")} since ${inst.shortCommit || "your version"}`
          : `Updating to ${L.version ? `v${L.version} · ` : ""}${L.shortCommit}`}</div></div>
          ${u.compareUrl ? html`<div class="right"><a class="btn btn-sm" href="${u.compareUrl}" target="_blank" rel="noopener noreferrer">${icon("external")}Compare on GitHub</a></div>` : ""}</div>
        ${u.changes.length ? html`<div class="list">${u.changes.map((c) => html`<a class="list-item" href="${c.url}" target="_blank" rel="noopener noreferrer">
            <span class="li-ico">${icon("branch", "sm")}</span>
            <div class="li-main"><div class="li-title" style="white-space:normal">${c.message}</div><div class="li-sub"><span class="mono">${c.shortSha}</span>${c.author ? ` · ${c.author}` : ""}${c.date ? ` · ${ago(c.date)}` : ""}</div></div>
            <div class="li-right">${icon("external", "sm")}</div></a>`)}</div>`
          : html`<div class="card-body"><p class="muted small">GitHub can't list the commits between this install and ${L.shortCommit} (the installed commit is unknown to it). The newest commit is: <b style="color:var(--text)">${L.message}</b>.</p></div>`}
        <div class="card-foot" style="flex-wrap:wrap"><span class="muted small" style="flex:1 1 260px">${RESTART_HINT[u.restartMode] || ""} Agent servers pick up their new files automatically when they reconnect.</span>
          ${busy ? html`<button class="btn" type="button" data-view-job>${icon("fileText")}View progress</button>`
            : html`<button class="btn btn-primary" type="button" data-apply ${u.restart?.pending ? raw("disabled") : ""}>${icon("arrowUp")}${u.available === true ? "Update now" : "Install latest"}</button>`}</div>
      </div>` : ""}

      <div class="card">
        <div class="card-head"><div><h3>Roll back</h3><div class="sub">The panel's code is backed up before every update and restore (the last 3 are kept).</div></div></div>
        ${backupsList.length ? html`<div class="list">${backupsList.map((b) => html`<div class="list-item">
            <span class="li-ico">${icon("history", "sm")}</span>
            <div class="li-main"><div class="li-title">${b.was?.version ? `v${b.was.version}` : "Unknown version"}${b.was?.commit ? html` · <span class="mono">${short(b.was.commit)}</span>` : ""}</div>
              <div class="li-sub">${b.takenAt ? ago(b.takenAt) : b.id} · ${b.reason === "before-restore" ? "taken before a restore" : `taken before updating to ${short(b.updatingTo?.commit) || "a newer version"}`}${b.size ? ` · ${updFmtBytes(b.size)}` : ""}</div></div>
            <div class="li-right">${b.simulated ? html`<span class="badge hide-sm">simulated</span>` : ""}${!b.valid ? html`<span class="badge err">incomplete</span>` : ""}
              <button class="btn btn-sm" type="button" data-restore="${b.id}" ${busy || !b.valid || u.restart?.pending ? raw("disabled") : ""}>${icon("rollback")}Restore</button></div></div>`)}</div>`
          : html`<div class="card-body"><p class="muted small">No backups yet — one is taken automatically before each update.</p></div>`}
        <div class="card-body" style="padding-top:0"><p class="hint">Restoring puts that code back (panel, node, shared, scripts…) and restarts the panel. Your data, websites, databases and <span class="mono">/etc/fcc</span> are never touched by updates or restores.</p></div>
      </div>`);
  };
  paint();

  const refresh = async () => {
    try { [u] = await Promise.all([get("/api/updates"), loadBackups()]); } catch { return; }
    if (ctx.alive()) { paint(); share(); }
  };
  const followJob = (job) => {
    if (!job?.id) return;
    const off = ctx.on("job", (j) => {
      if (j?.id !== job.id || !j.finishedAt) return;
      off();
      if (j.status === "succeeded") {
        const mode = j.result?.restart;
        if (mode === "systemd" || mode === "service") window.dispatchEvent(new CustomEvent("fcc:restarting", { detail: { bootId: u.bootId } }));
        else if (mode === "simulated") toast("Simulated — nothing was replaced", "info", { msg: "Download, checks and backup ran for real; this folder was left alone." });
        else if (mode === "manual") toast("Panel code updated", "info", { msg: "Restart the panel process to run the new version." });
      }
      refresh();
    });
  };

  on(box, "click", "[data-check]", async (e, b) => {
    setBusy(b, true);
    try {
      u = await post("/api/updates/check", { force: true });
      share();
      if (!u.error) toast(u.available === true ? "An update is available" : u.available === false ? "The panel is up to date" : "Checked GitHub", u.available === true ? "info" : "ok");
    } catch (ex) { toastError(ex, "Couldn't check for updates"); }
    if (ctx.alive()) paint();
  });
  on(box, "click", "[data-view-job]", () => u.job && openJobLog(u.job.id));
  on(box, "click", "[data-apply]", async (e, b) => {
    const inst = u.installed || {}, L = u.latest || {};
    const ok = await confirmDialog({
      title: "Update the panel?", ico: "arrowUp", confirmText: "Update now",
      message: html`Install ${L.version ? `v${L.version} ` : ""}<span class="mono">${L.shortCommit || ""}</span> from <span class="mono">${u.repo}@${u.ref}</span> over v${inst.version}${inst.shortCommit ? html` <span class="mono">${inst.shortCommit}</span>` : ""}. The current code is backed up first and can be restored from this page. ${RESTART_HINT[u.restartMode] || ""}`,
    });
    if (!ok) return;
    setBusy(b, true);
    try { const job = await post("/api/updates/apply"); followJob(job); openJobLog(job.id); await refresh(); }
    catch (ex) { toastError(ex, "Couldn't start the update"); setBusy(b, false); }
  });
  on(box, "click", "[data-restore]", async (e, b) => {
    const bk = backupsList.find((x) => x.id === b.dataset.restore);
    if (!bk) return;
    const ok = await confirmDialog({
      title: "Restore this version?", danger: true, confirmText: "Restore and restart",
      message: html`Put back the panel code from ${bk.takenAt ? ago(bk.takenAt) : bk.id}${bk.was?.version ? ` (v${bk.was.version}${bk.was.commit ? ` · ${short(bk.was.commit)}` : ""})` : ""}. The code running now is backed up first. ${RESTART_HINT[u.restartMode] || ""}`,
    });
    if (!ok) return;
    setBusy(b, true);
    try { const job = await post(`/api/updates/backups/${encodeURIComponent(bk.id)}/restore`); followJob(job); openJobLog(job.id); await refresh(); }
    catch (ex) { toastError(ex, "Couldn't start the restore"); setBusy(b, false); }
  });
  ctx.on("updates", (d) => { if (d && d.installed) { u = d; paint(); } });
  ctx.on("job", (j) => { if (j && /^panel\.(update|restore)$/.test(j.type || "") && j.finishedAt) refresh(); });
}
