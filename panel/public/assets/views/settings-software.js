// Settings → Updates → Server software: PHP, MySQL/MariaDB and cloudflared on every
// server (GET /api/software, POST /api/software/check, POST /api/software/upgrade).
import { html, raw, mount, on, ago, plural, toast, toastError, confirmDialog } from "../util.js";
import { icon } from "../icons.js";
import { get, post } from "../api.js";
import { openJobLog } from "../components.js";

const ICON = { php: "php", mysql: "database", cloudflared: "cloud" };
const ORDER = ["php", "mysql", "cloudflared"];
const short = (v) => String(v || "").replace(/^\d+:/, "");
const series = (v) => String(v || "").split(".").slice(0, 2).join(".");

function nameOf(c, x) {
  if (c === "php") return "PHP";
  if (c === "mysql") return x?.label || "MySQL";
  return "Cloudflare Tunnel";
}

function row(sv, c, x) {
  const name = nameOf(c, x);
  if (!x) return html`<div class="list-item"><span class="li-ico">${icon(ICON[c], "sm")}</span>
    <div class="li-main"><div class="li-title">${name}</div><div class="li-sub">Not checked yet</div></div></div>`;
  if (!x.installed) return html`<div class="list-item sw-off"><span class="li-ico">${icon(ICON[c], "sm")}</span>
    <div class="li-main"><div class="li-title">${name}</div><div class="li-sub">Not installed on this server</div></div>
    <div class="li-right"><span class="badge">Not installed</span></div></div>`;
  const n = x.upgrades?.length || 0;
  const sub = c === "cloudflared"
    ? x.available ? html`cloudflared ${x.latest} is out${x.managedBy === "apt" ? " (apt package)" : ""}` : x.managedBy === "other" ? html`Installed outside the panel at <span class="mono">${x.path}</span>` : "Newest version"
    : x.available
      ? html`${x.latest && x.latest !== x.version ? `Update to ${x.latest} · ` : "Security and bug fixes · "}${plural(n, "package")}`
      : html`Up to date for ${name} ${series(x.version)}`;
  const right = x.jobId
    ? html`<span class="badge blue">${icon("refresh")}Updating…</span><button class="btn btn-sm" type="button" data-sw-job="${x.jobId}">${icon("fileText")}Progress</button>`
    : x.available
      ? x.canUpdate ? html`<button class="btn btn-sm btn-primary" type="button" data-sw-up="${c}" data-sv="${sv.id}" ${sv.online ? "" : raw("disabled")}>${icon("arrowUp")}Update</button>` : html`<span class="badge warn">${icon("arrowUp")}Update available</span>`
      : html`<span class="badge ok">${icon("check")}Up to date</span>`;
  return html`<div class="list-item"><span class="li-ico">${icon(ICON[c], "sm")}</span>
    <div class="li-main"><div class="li-title">${name} <span class="muted" style="font-weight:500">${x.version || "version unknown"}</span></div><div class="li-sub">${sub}</div></div>
    <div class="li-right">${right}</div></div>`;
}

const WHAT_RESTARTS = {
  php: (sv) => `PHP-FPM restarts during the update, so PHP websites on ${sv.name} may pause for a few seconds.`,
  mysql: (sv) => `The database server restarts, so websites on ${sv.name} that use it are unavailable for a few seconds up to a minute. Take a database backup first if you want a safety net.`,
  cloudflared: (sv) => `The tunnel connectors on ${sv.name} restart on the new version. Replicas on other servers keep traffic flowing; with none, the tunnel blips for a few seconds.`,
};

export async function softwareSettings(box, ctx) {
  let s = await get("/api/software");
  if (!ctx.alive()) return;

  const paint = () => {
    const multi = s.servers.length > 1;
    const L = s.cloudflaredLatest;
    mount(box, html`<div class="card">
      <div class="card-head" style="flex-wrap:wrap">
        <div style="flex:1 1 260px;min-width:0"><h3>Server software</h3><div class="sub">PHP, MySQL and the Cloudflare Tunnel on ${multi ? "each server" : "this server"}. Updates stay within the version you run (PHP 8.3 stays 8.3, MySQL 8.0 stays 8.0): security and bug fixes, never a new major version.</div></div>
        <div class="right row" style="gap:8px">${s.updates ? html`<span class="badge warn">${icon("arrowUp")}${plural(s.updates, "update")}</span>` : ""}
          <button class="btn btn-sm" type="button" data-sw-check ${s.checking ? raw("disabled") : ""}>${icon("refresh")}${s.checking ? "Checking…" : "Check now"}</button></div>
      </div>
      ${s.servers.some((sv) => sv.simulated) ? html`<div class="card-body" style="padding-bottom:0"><div class="note warn">${icon("info")}<div>Dry run — these versions are sample data and Update only logs what it would do.</div></div></div>` : ""}
      ${L?.error ? html`<div class="card-body" style="padding-bottom:0"><div class="note warn">${icon("alert")}<div>${L.error}</div></div></div>` : ""}
      ${s.servers.map((sv) => html`
        ${multi ? html`<div class="sw-server"><span class="row" style="gap:8px">${icon("server", "sm")}<b>${sv.name}</b>${sv.role === "main" ? html`<span class="badge blue">Main</span>` : ""}${!sv.online ? html`<span class="badge err">Offline</span>` : ""}</span>
          <span class="muted small">${sv.checkedAt ? `checked ${ago(sv.checkedAt)}` : "never checked"}</span></div>` : ""}
        ${sv.error ? html`<div class="card-body" style="padding-top:8px;padding-bottom:8px"><div class="error-box">${icon("alert")}<div>${sv.error}</div></div></div>` : ""}
        ${sv.apt === false ? html`<div class="card-body" style="padding-top:8px;padding-bottom:8px"><p class="hint">This server has no apt, so PHP and MySQL can't be checked here.</p></div>` : ""}
        <div class="list">${ORDER.map((c) => row(sv, c, sv[c]))}</div>`)}
      <div class="card-foot"><span class="muted small">${!multi && s.servers[0]?.checkedAt ? `Last checked ${ago(s.servers[0].checkedAt)} · rechecked` : "Rechecked"} every 12 hours${L?.version ? html` · newest cloudflared is <a href="${L.url || "https://github.com/cloudflare/cloudflared/releases"}" target="_blank" rel="noopener noreferrer" class="mono" style="color:var(--text)">${L.version}</a>` : ""}.</span></div>
    </div>`);
  };
  paint();

  const refresh = async () => {
    try { s = await get("/api/software"); } catch { return; }
    if (ctx.alive()) paint();
  };

  on(box, "click", "[data-sw-check]", async (e, b) => {
    b.disabled = true; b.classList.add("loading");
    try { await post("/api/software/check"); toast("Checking for updates", "info", { msg: "This takes up to a minute per server." }); await refresh(); }
    catch (ex) { toastError(ex, "Couldn't start the check"); b.disabled = false; b.classList.remove("loading"); }
  });
  on(box, "click", "[data-sw-job]", (e, b) => openJobLog(b.dataset.swJob));
  on(box, "click", "[data-sw-up]", async (e, b) => {
    const sv = s.servers.find((x) => x.id === b.dataset.sv);
    const c = b.dataset.swUp;
    const x = sv?.[c];
    if (!x) return;
    const name = nameOf(c, x);
    const list = (x.upgrades || []).slice(0, 12);
    const ok = await confirmDialog({
      title: `Update ${c === "cloudflared" ? "cloudflared" : name} on ${sv.name}?`, ico: "arrowUp", confirmText: "Update",
      message: html`${c === "cloudflared" ? html`From ${x.version} to <b>${x.latest}</b>. ` : ""}${WHAT_RESTARTS[c](sv)} It waits in the job queue if ${sv.name} is busy with a build.
        ${list.length ? html`<ul class="sw-pkgs">${list.map((u) => html`<li><span class="mono">${u.name}</span> <span class="muted">${short(u.from)} → ${short(u.to)}</span></li>`)}</ul>${x.upgrades.length > list.length ? html`<div class="muted small">…and ${x.upgrades.length - list.length} more</div>` : ""}` : ""}`,
    });
    if (!ok) return;
    b.disabled = true; b.classList.add("loading");
    try { const job = await post("/api/software/upgrade", { serverId: sv.id, component: c }); openJobLog(job.id); await refresh(); }
    catch (ex) { toastError(ex, "Couldn't start the update"); b.disabled = false; b.classList.remove("loading"); }
  });
  ctx.on("software", (d) => { if (d && Array.isArray(d.servers)) { s = d; paint(); } });
}
