import { html, raw, mount, $, $$, on, fmtBytes, ago, emptyState, errorState, skeletonRows, debounce, toast, toastError, openModal } from "../util.js";
import { icon } from "../icons.js";
import { get, post, put } from "../api.js";
import { pageHead, tabsBar, backupsTable, bindBackupActions, jobStarted, serverKind } from "../components.js";

const INCLUDES = [
  ["sites", "Website files", "Every app directory on the server"],
  ["nginx", "nginx config", "Front-door vhosts and upstreams"],
  ["panel", "Panel data", "Projects, settings, releases (main server only)"],
  ["databases", "Full database dump", "All MySQL databases (main server only)"],
];

export async function serverBackupDialog(servers, preselect) {
  const online = servers.filter((s) => s.enabled !== false);
  let sid = preselect || online.find((s) => s.online)?.id || "main";
  const m = openModal({
    title: "Create server backup", sub: "A tar.gz archive, stored with your other backups and kept by the retention policy.", ico: "hardDrive", size: "lg",
    body: html`<div class="form-stack">
      <div class="field"><label>Server</label><select class="select" data-srv>${online.map((s) => html`<option value="${s.id}" ${s.id === sid ? raw("selected") : ""} ${s.online ? "" : raw("disabled")}>${s.name} — ${serverKind(s)}${s.online ? "" : " (offline)"}</option>`)}</select></div>
      <div class="field"><label>Include</label><div class="choice-grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))" data-inc></div></div>
      <div class="error-box" data-err hidden></div></div>`,
    foot: html`<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-ok>${icon("archive")}Start backup</button>`,
    onMount(el, close) {
      const inc = { sites: true, nginx: true, panel: true, databases: false };
      const paint = () => {
        const isMain = sid === "main" || servers.find((s) => s.id === sid)?.role === "main";
        mount($("[data-inc]", el), html`${INCLUDES.map(([k, t, d]) => {
          const dis = !isMain && (k === "panel" || k === "databases");
          const on = inc[k] && !dis;
          return html`<label class="choice checkbox ${on ? "selected" : ""} ${dis ? "disabled" : ""}"><input type="checkbox" value="${k}" ${on ? raw("checked") : ""} ${dis ? raw("disabled") : ""}/><span class="c-mark"></span><span class="c-title" style="font-size:13.5px">${t}</span><span class="c-desc">${d}</span></label>`;
        })}`);
      };
      paint();
      $("[data-srv]", el).onchange = (e) => { sid = e.target.value; paint(); };
      on(el, "change", "[data-inc] input", (e) => { inc[e.target.value] = e.target.checked; paint(); });
      $("[data-ok]", el).onclick = async (e) => {
        const btn = e.currentTarget; const isMain = sid === "main";
        const include = { sites: inc.sites, nginx: inc.nginx, panel: isMain && inc.panel, databases: isMain && inc.databases };
        if (!Object.values(include).some(Boolean)) { const er = $("[data-err]", el); er.hidden = false; er.textContent = "Pick at least one thing to include."; return; }
        btn.classList.add("loading");
        try { const job = await post("/api/backups/server", { serverId: sid, include }); close(job); jobStarted(job, "Server backup started"); }
        catch (ex) { const er = $("[data-err]", el); er.hidden = false; er.textContent = ex.message; }
        finally { btn.classList.remove("loading"); }
      };
    },
  });
  return m.result;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export async function scheduleForm(box, ctx) {
  mount(box, skeletonRows(3, 120));
  let s, servers = [];
  try { [s, servers] = await Promise.all([get("/api/backups/settings"), get("/api/servers").then((r) => r.items || []).catch(() => [])]); } catch (e) { mount(box, errorState(e)); return; }
  if (ctx && !ctx.alive()) return;
  const dbS = s.database || {}, srvS = s.server || {}, dest = s.destination || { type: "local" };
  const smb = dest.smb || {}, smbTool = s.smbclient || { installed: true };
  const srvIds = srvS.serverIds || ["main"];
  const runInfo = (k) => {
    const n = s.nextRun?.[k], l = s.lastRun?.[k];
    if (!n && !l) return "";
    return html`<div class="row wrap tiny muted mt-12" style="gap:14px">${n ? html`<span class="row" style="gap:6px">${icon("clock", "xs")}Next ${fmtDateShort(n)}</span>` : ""}${l ? html`<span>Last ${ago(typeof l === "object" ? l.at || l.finishedAt : l)}</span>` : ""}</div>`;
  };
  const every = (v) => html`${[["hourly", "Every hour"], ["daily", "Every day"], ["weekly", "Every week"]].map(([k, l]) => html`<option value="${k}" ${v === k ? raw("selected") : ""}>${l}</option>`)}`;
  const daySel = (k, v) => html`<div class="field" data-day-wrap="${k}"><label>On</label><select class="select" data-f="${k}.day">${DAYS.map((d, i) => html`<option value="${i}" ${Number(v ?? 0) === i ? raw("selected") : ""}>${d}</option>`)}</select></div>`;
  mount(box, html`<div class="stack">
    ${s.usage ? html`<div class="row wrap" style="gap:10px"><span class="badge">${icon("archive")}${s.usage.count} backups</span><span class="badge">${icon("hardDrive")}${fmtBytes(s.usage.bytes)} used</span>${s.localPath ? html`<span class="badge mono" title="${s.localPath}" style="max-width:100%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;line-height:24px">${s.localPath}</span>` : ""}${s.timezone ? html`<span class="badge">${icon("clock")}${s.timezone}</span>` : ""}</div>` : ""}
    <div class="grid-2">
      <div class="card"><div class="card-head"><h3>Database backups</h3><div class="right"><label class="switch"><input type="checkbox" data-f="database.enabled" ${dbS.enabled ? raw("checked") : ""}/><span class="track"></span></label></div></div>
        <div class="card-body"><div class="form-grid">
          <div class="field"><label>Frequency</label><select class="select" data-f="database.every">${every(dbS.every || "daily")}</select></div>
          <div class="field"><label data-at-label="database">${dbS.every === "hourly" ? "At minute" : "At"}</label><input class="input mono" type="time" data-f="database.at" value="${dbS.at || "03:00"}"/></div>
          ${daySel("database", dbS.day)}
          <div class="field"><label>Keep the last</label><input class="input" type="number" min="0" data-f="database.keep" value="${dbS.keep ?? 14}"/></div>
        </div><p class="hint mt-12">Per database. 0 keeps everything. Pinned backups are never removed.</p>${runInfo("database")}</div></div>
      <div class="card"><div class="card-head"><h3>Server backups</h3><div class="right"><label class="switch"><input type="checkbox" data-f="server.enabled" ${srvS.enabled ? raw("checked") : ""}/><span class="track"></span></label></div></div>
        <div class="card-body"><div class="form-grid">
          <div class="field"><label>Frequency</label><select class="select" data-f="server.every">${every(srvS.every || "weekly")}</select></div>
          <div class="field"><label data-at-label="server">${srvS.every === "hourly" ? "At minute" : "At"}</label><input class="input mono" type="time" data-f="server.at" value="${srvS.at || "04:00"}"/></div>
          ${daySel("server", srvS.day)}
          <div class="field"><label>Keep the last</label><input class="input" type="number" min="0" data-f="server.keep" value="${srvS.keep ?? 4}"/></div>
          <div class="field"><label>Servers</label><div class="stack" style="gap:8px">${(servers.length ? servers : [{ id: "main", name: "main", role: "main" }]).map((x) => html`<label class="check"><input type="checkbox" data-srvsel="${x.id}" ${srvIds.includes(x.id) ? raw("checked") : ""}/>${x.name}<span class="dim small">${serverKind(x)}</span></label>`)}</div></div>
          <div class="field"><label>Include</label><div class="stack" style="gap:8px">${INCLUDES.map(([k, t]) => html`<label class="check"><input type="checkbox" data-inc="${k}" ${(srvS.include || {})[k] ? raw("checked") : ""}/>${t}</label>`)}</div></div>
        </div><p class="hint mt-12">Panel data and the database dump only apply to the main server.</p>${runInfo("server")}</div></div>
    </div>
    <div class="card"><div class="card-head"><h3>Destination</h3><span class="sub">Where archives are stored</span></div><div class="card-body">
      <div class="mode-switch" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr))">
        <label class="choice ${!["s3", "smb"].includes(dest.type) ? "selected" : ""}"><input type="radio" name="dest" value="local" ${!["s3", "smb"].includes(dest.type) ? raw("checked") : ""}/><span class="c-mark"></span><span class="c-title"><span class="c-ico">${icon("hardDrive")}</span>Main server disk</span><span class="c-desc" style="overflow-wrap:anywhere">${s.localPath || "/var/lib/fcc/backups"} — fast, but lost if the server is.</span></label>
        <label class="choice ${dest.type === "s3" ? "selected" : ""}"><input type="radio" name="dest" value="s3" ${dest.type === "s3" ? raw("checked") : ""}/><span class="c-mark"></span><span class="c-title"><span class="c-ico">${icon("cloud")}</span>S3-compatible storage</span><span class="c-desc">AWS S3, Backblaze B2, Cloudflare R2, Wasabi, MinIO… A local copy is kept too.</span></label>
        <label class="choice ${dest.type === "smb" ? "selected" : ""}"><input type="radio" name="dest" value="smb" ${dest.type === "smb" ? raw("checked") : ""}/><span class="c-mark"></span><span class="c-title"><span class="c-ico">${icon("folder")}</span>SMB share</span><span class="c-desc">A Windows or Samba file share — NAS, file server. A local copy is kept too.</span></label>
      </div>
      <div class="form-grid mt-20" data-s3 ${dest.type === "s3" ? "" : raw("hidden")}>
        <div class="field"><label>Endpoint</label><input class="input mono" data-d="endpoint" value="${dest.endpoint || ""}" placeholder="https://s3.eu-central-1.amazonaws.com"/></div>
        <div class="field"><label>Region</label><input class="input mono" data-d="region" value="${dest.region || ""}" placeholder="eu-central-1"/></div>
        <div class="field"><label>Bucket</label><input class="input mono" data-d="bucket" value="${dest.bucket || ""}" placeholder="my-backups"/></div>
        <div class="field"><label>Path prefix</label><input class="input mono" data-d="prefix" value="${dest.prefix || ""}" placeholder="fcc/"/></div>
        <div class="field"><label>Access key</label><input class="input mono" data-d="accessKey" value="${dest.accessKey || ""}" autocomplete="off"/></div>
        <div class="field"><label>Secret key</label><input class="input mono" type="password" data-secret placeholder="${dest.secretKeySet ? "•••••••• saved — leave blank to keep" : ""}" autocomplete="new-password"/></div>
        <div class="field span-2"><label class="check"><input type="checkbox" data-pathstyle ${dest.pathStyle !== false ? raw("checked") : ""}/>Path-style URLs (needed for MinIO and most non-AWS providers)</label></div>
        <div class="field span-2"><div class="row wrap"><button class="btn btn-sm" data-test type="button">${icon("zap")}Test connection</button><span class="small" data-test-res></span></div></div>
      </div>
      <div class="mt-20" data-smb ${dest.type === "smb" ? "" : raw("hidden")}>
        ${smbTool.installed ? "" : html`<div class="note warn" style="margin-bottom:16px">${icon("alert")}<div><b>smbclient is not installed on this server.</b> SMB copies need it. ${smbTool.canInstall ? html`Install it here, or run <span class="mono">apt install smbclient</span>.` : html`Install the <span class="mono">smbclient</span> package with your package manager.`}${smbTool.canInstall ? html`<div class="mt-12"><button class="btn btn-sm" type="button" data-smb-install>${icon("download")}Install smbclient</button></div>` : ""}</div></div>`}
        <div class="form-grid">
          <div class="field"><label>Server</label><input class="input mono" data-smb-f="server" value="${smb.server || ""}" placeholder="nas.local or 192.168.1.20" autocomplete="off"/></div>
          <div class="field"><label>Share</label><input class="input mono" data-smb-f="share" value="${smb.share || ""}" placeholder="Backups"/></div>
          <div class="field"><label>Subfolder <span class="dim">(optional)</span></label><input class="input mono" data-smb-f="path" value="${smb.path || ""}" placeholder="fcc/panel-1"/></div>
          <div class="field"><label>Domain / workgroup <span class="dim">(optional)</span></label><input class="input mono" data-smb-f="domain" value="${smb.domain || ""}" placeholder="WORKGROUP"/></div>
          <div class="field"><label>User name</label><input class="input mono" data-smb-f="username" value="${smb.username || ""}" autocomplete="off"/></div>
          <div class="field"><label>Password</label><input class="input mono" type="password" data-smb-pass placeholder="${smb.passwordSet ? "•••••••• saved — leave blank to keep" : ""}" autocomplete="new-password"/></div>
          <div class="field"><label>Minimum protocol</label><select class="select" data-smb-f="minProtocol">${[["SMB2", "SMB2+ (recommended)"], ["SMB3", "SMB3 only"], ["NT1", "SMB1 — legacy, insecure"]].map(([k, l]) => html`<option value="${k}" ${(smb.minProtocol || "SMB2") === k ? raw("selected") : ""}>${l}</option>`)}</select></div>
          <div class="field"><label>Port</label><input class="input mono" type="number" min="1" max="65535" data-smb-f="port" value="${smb.port || 445}"/></div>
          <div class="field span-2"><p class="hint">Files go to <span class="mono" data-smb-preview></span>. The account needs permission to create folders and write and delete files. Deleting a backup here also deletes its copy on the share; a missing local copy can be fetched back for download or restore.</p></div>
          <div class="field span-2"><div class="row wrap"><button class="btn btn-sm" data-smb-test type="button">${icon("zap")}Test connection</button><button class="btn btn-sm btn-ghost" data-smb-browse type="button" ${dest.type === "smb" && smb.server ? "" : raw("disabled")} title="Lists the saved share">${icon("folder")}Browse share</button><span class="small" data-smb-test-res></span></div></div>
        </div>
      </div>
    </div><div class="card-foot"><span class="muted small">Changes apply from the next scheduled slot.</span><span class="spacer"></span><button class="btn btn-primary" data-savesched>${icon("check")}Save schedule</button></div></div>
  </div>`);
  const syncDay = () => ["database", "server"].forEach((k) => {
    const ev = $(`[data-f="${k}.every"]`, box).value;
    $(`[data-day-wrap="${k}"]`, box).hidden = ev !== "weekly";
    $(`[data-at-label="${k}"]`, box).textContent = ev === "hourly" ? "At minute" : "At";
  });
  syncDay();
  on(box, "change", "[data-f$='.every']", syncDay);
  on(box, "change", "input[name=dest]", (e) => {
    $$("input[name=dest]", box).forEach((r) => r.closest(".choice").classList.toggle("selected", r.checked));
    $("[data-s3]", box).hidden = e.target.value !== "s3";
    $("[data-smb]", box).hidden = e.target.value !== "smb";
  });
  const smbPreview = () => {
    const v = (k) => $(`[data-smb-f="${k}"]`, box).value.trim();
    const sub = v("path").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    $("[data-smb-preview]", box).textContent = `\\\\${v("server") || "server"}\\${v("share") || "share"}${sub ? `\\${sub.replace(/\//g, "\\")}` : ""}\\db|server\\…`;
  };
  smbPreview();
  on(box, "input", "[data-smb-f]", smbPreview);
  const destBody = () => {
    const type = $("input[name=dest]:checked", box).value;
    const d = { type };
    if (type === "s3") {
      $$("[data-d]", box).forEach((i) => (d[i.dataset.d] = i.value.trim()));
      d.pathStyle = $("[data-pathstyle]", box).checked;
      const sk = $("[data-secret]", box).value; if (sk) d.secretKey = sk;
    }
    if (type === "smb") {
      d.smb = {};
      $$("[data-smb-f]", box).forEach((i) => (d.smb[i.dataset.smbF] = i.value.trim()));
      d.smb.port = Number(d.smb.port) || 445;
      const pw = $("[data-smb-pass]", box).value; if (pw) d.smb.password = pw;
    }
    return d;
  };
  on(box, "click", "[data-test]", async (e, b) => {
    const res = $("[data-test-res]", box);
    b.classList.add("loading"); res.textContent = "";
    try { await post("/api/backups/destination/test", destBody()); mount(res, html`<span class="status" style="color:#63e6ad"><span class="dot ok"></span>Connected — wrote and deleted a test object.</span>`); }
    catch (ex) { mount(res, html`<span class="status" style="color:#ff8ea3"><span class="dot err"></span>${ex.message}</span>`); }
    finally { b.classList.remove("loading"); }
  });
  on(box, "click", "[data-smb-test]", async (e, b) => {
    const res = $("[data-smb-test-res]", box);
    b.classList.add("loading"); res.textContent = "";
    try { const r = await post("/api/backups/destination/test", destBody()); mount(res, html`<span class="status" style="color:#63e6ad"><span class="dot ok"></span>${r.dryRun ? "Dry run — commands logged, nothing sent." : `Connected — wrote, listed and deleted a test file in ${r.location}.`}</span>`); }
    catch (ex) { mount(res, html`<span class="status" style="color:#ff8ea3;overflow-wrap:anywhere"><span class="dot err"></span>${ex.message}</span>`); }
    finally { b.classList.remove("loading"); }
  });
  on(box, "click", "[data-smb-install]", async (e, b) => {
    b.classList.add("loading");
    try { jobStarted(await post("/api/backups/destination/smb/install"), "Installing smbclient"); } catch (ex) { toastError(ex, "Couldn't start the install"); } finally { b.classList.remove("loading"); }
  });
  on(box, "click", "[data-smb-browse]", () => smbBrowser());
  on(box, "click", "[data-savesched]", async (e, b) => {
    const val = (k) => { const el = $(`[data-f="${k}"]`, box); return el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value; };
    const destination = destBody();
    if (destination.type === "s3" && !destination.bucket) { toast("Enter a bucket name", "warn"); return; }
    if (destination.type === "smb" && (!destination.smb.server || !destination.smb.share || !destination.smb.username)) { toast("Enter the SMB server, share and user name", "warn"); return; }
    const include = {}; $$("[data-inc]", box).forEach((i) => (include[i.dataset.inc] = i.checked));
    const serverIds = $$("[data-srvsel]", box).filter((i) => i.checked).map((i) => i.dataset.srvsel);
    const sched = (k) => ({ enabled: val(`${k}.enabled`), every: val(`${k}.every`), at: val(`${k}.at`), day: Number(val(`${k}.day`)), keep: val(`${k}.keep`) });
    const body = { database: sched("database"), server: { ...sched("server"), include, serverIds: serverIds.length ? serverIds : ["main"] }, destination };
    b.classList.add("loading");
    try { await put("/api/backups/settings", body); toast("Backup schedule saved", "ok"); } catch (ex) { toastError(ex, "Couldn't save"); } finally { b.classList.remove("loading"); }
  });
}
function smbBrowser() {
  openModal({ title: "SMB share", sub: "The saved destination — save first to browse new settings.", ico: "folder", size: "lg",
    body: html`<div data-smb-list>${skeletonRows(4, 40)}</div>`, foot: html`<button class="btn btn-ghost" data-close>Close</button>`,
    onMount(el) {
      const load = async (sub) => {
        const box = $("[data-smb-list]", el);
        mount(box, skeletonRows(4, 40));
        try {
          const r = await get(`/api/backups/destination/remote?path=${encodeURIComponent(sub)}`);
          const parts = sub ? sub.split("/") : [];
          const items = (r.items || []).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
          mount(box, html`<div class="row wrap small" style="gap:6px;margin-bottom:12px"><a href="#" data-go="">${r.location.split("/").slice(0, 4).join("/") || "share"}</a>${parts.map((p, i) => html`<span class="dim">/</span><a href="#" data-go="${parts.slice(0, i + 1).join("/")}">${p}</a>`)}</div>
            ${r.dryRun ? html`<div class="note">${icon("info")}<div>Dry run — smbclient isn't called, so the share looks empty.</div></div>` : items.length ? html`<div class="list">${items.map((x) => html`<div class="list-item">${icon(x.dir ? "folder" : "file", "sm")}${x.dir ? html`<a href="#" class="mono" data-go="${[...parts, x.name].join("/")}">${x.name}</a>` : html`<span class="mono">${x.name}</span>`}<span class="spacer"></span><span class="muted small">${x.dir ? "" : fmtBytes(x.size)}${x.modifiedAt ? ` · ${ago(x.modifiedAt)}` : ""}</span></div>`)}</div>` : html`<p class="muted small">This folder is empty.</p>`}`);
        } catch (e) { mount(box, errorState(e)); }
      };
      on(el, "click", "[data-go]", (e, a) => { e.preventDefault(); load(a.dataset.go); });
      load("");
    } });
}
function fmtDateShort(t) { return new Date(t).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }); }

export default async function backups(ctx) {
  const { root, params, query } = ctx;
  const tab = ["database", "server", "schedule"].includes(params.tab) ? params.tab : "database";
  ctx.crumbs([{ label: "Backups", href: "#/backups" }, { label: { database: "Database", server: "Server", schedule: "Schedule" }[tab] }]);
  mount(root, html`${pageHead("Backups", "Database dumps and full server archives — on demand or on a schedule, with retention.", html`<button class="btn" data-dbnow>${icon("database")}Back up a database</button><button class="btn btn-primary" data-srvnow>${icon("hardDrive")}Create server backup</button>`)}
    ${tabsBar([{ id: "database", label: "Database", icon: "database" }, { id: "server", label: "Server", icon: "hardDrive" }, { id: "schedule", label: "Schedule & destination", icon: "calendar" }], tab, "#/backups")}
    <div data-tab></div>`);
  const box = $("[data-tab]", root);
  let servers = [], dbs = [];
  const meta = Promise.all([get("/api/servers").then((r) => (servers = r.items || [])).catch(() => {}), get("/api/databases").then((r) => (dbs = r.items || [])).catch(() => {})]);

  on(root, "click", "[data-srvnow]", async () => { await meta; serverBackupDialog(servers); });
  on(root, "click", "[data-dbnow]", async () => {
    await meta;
    if (!dbs.length) { toast("No databases to back up", "warn"); return; }
    openModal({ title: "Back up a database", ico: "database", body: html`<div class="field"><label>Database</label><select class="select" data-db>${dbs.map((d) => html`<option value="${d.id}" ${d.id === query.databaseId ? raw("selected") : ""}>${d.name} — ${fmtBytes(d.sizeBytes)}${d.lastBackup ? ` · last ${ago(d.lastBackup.createdAt)}` : ""}</option>`)}</select></div>`,
      foot: html`<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-ok>${icon("archive")}Back up now</button>`,
      onMount(el, close) { $("[data-ok]", el).onclick = async () => { try { const job = await post(`/api/databases/${$("[data-db]", el).value}/backups`); close(true); jobStarted(job, "Database backup started"); } catch (e) { toastError(e); } }; } });
  });

  if (tab === "schedule") { await scheduleForm(box, ctx); return; }

  let items = [];
  const filterDb = query.databaseId || "";
  const load = async () => {
    try {
      await meta;
      const qs = new URLSearchParams({ kind: tab }); if (tab === "database" && filterDb) qs.set("databaseId", filterDb);
      items = (await get(`/api/backups?${qs}`)).items || [];
      if (!ctx.alive()) return;
      const dbsById = Object.fromEntries(dbs.map((d) => [d.id, d])), serversById = Object.fromEntries(servers.map((s) => [s.id, s]));
      const total = items.reduce((a, b) => a + (b.status === "ok" ? b.size || 0 : 0), 0);
      mount(box, html`<div class="toolbar">
        ${filterDb ? html`<span class="badge blue">${icon("filter")}${dbsById[filterDb]?.name || "database"}</span><a class="btn btn-sm btn-ghost" href="#/backups/database">Clear filter</a>` : ""}
        <span class="muted small">${items.length} backup${items.length === 1 ? "" : "s"} · ${fmtBytes(total)}</span><span class="grow"></span>
        <a class="btn btn-sm btn-ghost" href="#/backups/schedule">${icon("calendar")}Schedule</a></div>
        ${items.length ? backupsTable(items, { dbsById, serversById, kind: tab })
          : html`<div class="card">${emptyState({ ico: tab === "server" ? "hardDrive" : "archive", title: tab === "server" ? "No server backups yet" : "No database backups yet",
            text: tab === "server" ? "Archive site files, nginx config and panel data for any server." : "Back up a database now, or turn on the daily schedule.",
            action: tab === "server" ? html`<button class="btn btn-primary" data-srvnow>${icon("hardDrive")}Create server backup</button>` : html`<button class="btn btn-primary" data-dbnow>${icon("database")}Back up a database</button>` })}</div>`}`);
    } catch (e) { if (ctx.alive()) { mount(box, errorState(e)); $("[data-retry]", box)?.addEventListener("click", load); } }
  };
  mount(box, skeletonRows(5, 58));
  await load();
  bindBackupActions(box, () => items, { dbsById: () => Object.fromEntries(dbs.map((d) => [d.id, d])), serversById: () => Object.fromEntries(servers.map((s) => [s.id, s])), refresh: load });
  ctx.on("backup", debounce(load, 400));
}
