import { html, mount, $, on, fmtBytes, plural, emptyState, errorState, skeletonRows, debounce, toastError, openModal } from "../util.js";
import { icon } from "../icons.js";
import { get, post } from "../api.js";
import { pageHead, databasesTable, dbMenu, revealCredentials, createDatabase, openPhpMyAdmin } from "../components.js";

/* Panel failover (docs/HA.md): databases live on the main server. While main doesn't run the active
   panel, status endpoints answer { available: false, reason } and operations 503 with the reason.
   Show that reason calmly instead of errors. (A 503 { haSwitching } is retried by api.js instead.) */
export const DB_UNAVAILABLE = "Databases live on the main server, which is not running the active panel right now.";
export function dbUnavailable(x) {
  if (!x || typeof x !== "object") return null;
  if (!(x instanceof Error) && x.available === false) return x.reason || DB_UNAVAILABLE;
  if (x instanceof Error && x.status === 503 && x.body && typeof x.body === "object" && !x.body.haSwitching) return x.message || DB_UNAVAILABLE;
  return null;
}
export function unavailableState(reason, { title = "Databases are unavailable right now", ico = "database" } = {}) {
  return html`<div class="card db-unavailable">${emptyState({ ico, title, text: html`${reason} <span class="muted">They come back on their own when the main server runs the active panel again.</span>` })}</div>`;
}

/* ───────── database replication (docs/HA.md, Phase 3) ─────────
   GET /api/mysql/replication: null on an older panel (404) — then nothing about replication shows. */
export const getReplication = () => get("/api/mysql/replication").then((r) => (r && typeof r === "object" && "enabled" in r ? r : null)).catch(() => null);
export const REPL_STATE = {
  off: ["", "Off"], preparing: ["run", "Preparing"], seeding: ["run", "Seeding"], replicating: ["ok", "Replicating"],
  broken: ["err", "Broken"], promoted: ["warn", "Promoted"], "needs-rebuild": ["warn", "Needs rebuild"],
};
export function replBadge(state) {
  const [tone, text] = REPL_STATE[state] || ["", state || "Unknown"];
  return html`<span class="badge ${tone === "run" ? "blue" : tone}">${tone === "run" ? html`<span class="dot run" style="width:6px;height:6px"></span>` : tone === "ok" ? html`<span class="dot ok" style="width:6px;height:6px"></span>` : tone ? icon("alert") : ""}${text}</span>`;
}
export const fmtLagS = (s) => (s == null ? "—" : s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);
/** Replica can't be trusted to have everything: stopped with an error, or the cluster marked it broken. */
export const replicaBroken = (r) => !!r?.replica && (r.state === "broken" || r.replica.state === "broken" || (!!r.replica.lastError && r.replica.sqlRunning === false));
/** One-line summary + warnings for the Databases page and the dashboard. null when replication is off. */
export function replSummary(r) {
  if (!r?.enabled) return null;
  const rep = r.replica, warns = [];
  const pName = r.primary?.name || r.primary?.serverId || "the primary";
  if (r.detect?.primaryDownForMs) warns.push(`The database primary ${pName} hasn't answered for ${Math.max(1, Math.round(r.detect.primaryDownForMs / 1000))} s.`);
  if (replicaBroken(r)) warns.push(`Database replication to ${rep.name} is broken${rep.lastError ? `: ${rep.lastError}` : "."}`);
  for (const n of r.needsRebuild || []) warns.push(`${n.name} needs a rebuild to become the database replica again${n.online ? "." : " (it's offline)."}`);
  if (!rep && !(r.needsRebuild || []).length) warns.push("The databases have no replica right now.");
  const seeding = rep && (r.state === "seeding" || r.state === "preparing" || rep.state === "seeding");
  const text = rep ? (replicaBroken(r) ? `Replication to ${rep.name} has stopped` : seeding ? `Copying the databases to ${rep.name}…` : `Replicated to ${rep.name} · lag ${fmtLagS(rep.lagSeconds)}`) : `Primary ${pName} · no replica`;
  const tone = warns.length ? (replicaBroken(r) || r.detect?.primaryDownForMs ? "err" : "warn") : seeding ? "run" : "ok";
  return { text, tone, warns, primary: pName };
}

export default async function databases(ctx) {
  const { root } = ctx;
  ctx.crumbs([{ label: "Databases" }]);
  let q = "", projectFilter = ctx.query.projectId || "";
  mount(root, html`${pageHead("Databases", "MySQL databases on the main server. Websites on agent servers connect over the private network.", html`<button class="btn btn-primary" data-new>${icon("plus")}New database</button>`)}
    <div data-mysql></div>
    <div data-repl></div>
    <div class="toolbar"><select class="select" data-proj style="width:auto;height:34px;font-size:13px"><option value="">All projects</option></select><span class="grow"></span><div class="search">${icon("search")}<input placeholder="Search databases" data-q/></div></div>
    <div data-list>${skeletonRows(4, 60)}</div>`);
  const list = $("[data-list]", root);
  let items = [], projects = [], projectsById = {}, mysql = null, unavailable = null, repl = null;

  const paintRepl = () => {
    const box = $("[data-repl]", root), sum = unavailable ? null : replSummary(repl);
    if (!sum) return mount(box, html``);
    mount(box, html`<a class="repl-line ${sum.warns.length ? `is-${sum.tone}` : ""}" href="#/settings/databases" title="Replication settings">
      <span class="dot ${sum.tone}"></span><span class="repl-line-t"><b>${sum.text}</b>${sum.warns.length ? html`<span class="repl-line-w">${sum.warns[0]}${sum.warns.length > 1 ? ` (+${sum.warns.length - 1} more)` : ""}</span>` : ""}</span>
      <span class="repl-line-go"><span>Replication</span>${icon("chevronRight", "sm")}</span></a>`);
  };

  const paintMysql = () => {
    const box = $("[data-mysql]", root);
    if (!mysql) return mount(box, html``);
    if (!mysql.installed) return mount(box, html`<div class="note err" style="margin-bottom:16px">${icon("alert")}<div><b>MySQL isn't installed on the main server.</b> Run the panel installer again or install <span class="mono">mysql-server</span>, then reload this page.</div></div>`);
    if (!mysql.running) return mount(box, html`<div class="note err" style="margin-bottom:16px">${icon("alert")}<div><b>MySQL is not running.</b> ${mysql.error || ""}</div></div>`);
    if (mysql.rootOk === false) return mount(box, html`<div class="note warn" style="margin-bottom:16px;align-items:center">${icon("key")}<div style="flex:1">The panel can't log in to MySQL as root. Enter the root password once so it can manage databases.</div><button class="btn btn-sm" data-root>Set root password</button></div>`);
    const bindLocal = /^(127\.|localhost|::1)/.test(mysql.bindAddress || "");
    const remoteDbs = items.filter((d) => d.remoteAccess).length;
    mount(box, html`${bindLocal && (remoteDbs || mysql.mainSitesVia === "panel") ? html`<div class="note warn" style="margin-bottom:14px;align-items:center">${icon("alert")}<div style="flex:1">MySQL only listens on <span class="mono">${mysql.bindAddress}</span>${remoteDbs ? html`, so websites on agent servers can't reach the ${plural(remoteDbs, "database")} that allow agent access` : ""}${mysql.mainSitesVia === "panel" ? html`${remoteDbs ? " — and" : ","} websites on this server use <span class="mono">127.0.0.1</span> instead of the panel address <span class="mono">${mysql.publicHost}</span>` : ""}. Let it listen on the network from Settings → Databases (or reinstall with <span class="mono">FCC_MYSQL_REMOTE=1</span>), and allow port 3306 from your agent servers' addresses only.</div><a class="btn btn-sm" href="#/settings/databases">${icon("settings")}Fix in Settings</a></div>` : ""}
      <div class="row wrap" style="gap:10px;margin-bottom:18px"><span class="badge ok"><span class="dot ok" style="width:6px;height:6px"></span>${mysql.flavor === "mariadb" ? "MariaDB" : "MySQL"} ${mysql.version || ""} running</span>${mysql.bindAddress ? html`<span class="badge mono">bind ${mysql.bindAddress}</span>` : ""}${mysql.publicHost ? html`<a class="badge mono" href="#/settings/databases" title="Database host shown in credentials">host ${mysql.publicHost}</a>` : ""}
      <span class="badge">${icon("database")}${items.length} database${items.length === 1 ? "" : "s"}</span><span class="badge">${icon("hardDrive")}${fmtBytes(items.reduce((a, d) => a + (d.sizeBytes || 0), 0))} total</span></div>`);
  };
  const paint = () => {
    $(".toolbar", root).hidden = !!unavailable;
    $(".page-head [data-new]", root)?.toggleAttribute("disabled", !!unavailable);
    if (unavailable) { mount($("[data-mysql]", root), html``); return mount(list, unavailableState(unavailable)); }
    paintMysql(); paintRepl();
    const f = items.filter((d) => (!projectFilter || d.projectId === projectFilter) && (!q || (d.name + " " + d.user).toLowerCase().includes(q)));
    if (!items.length) return mount(list, html`<div class="card">${emptyState({ ico: "database", title: "No databases yet", text: "Create a MySQL database inside a project, then link it to a website — credentials are injected as environment variables.", action: html`<button class="btn btn-primary" data-new>${icon("plus")}New database</button>` })}</div>`);
    if (!f.length) return mount(list, html`<div class="card">${emptyState({ ico: "search", title: "No matches", sm: true })}</div>`);
    mount(list, databasesTable(f, { projectsById, mysql }));
  };
  const load = async () => {
    try {
      const [d, p, m, rp] = await Promise.all([
        get("/api/databases").catch((e) => { const why = dbUnavailable(e); if (why) return { items: [], unavailable: why }; throw e; }),
        get("/api/projects").catch(() => ({ items: [] })), get("/api/mysql/status").catch((e) => (dbUnavailable(e) ? { available: false, reason: dbUnavailable(e) } : null)), getReplication()]);
      items = d.items || []; projects = p.items || []; mysql = m; repl = rp;
      unavailable = d.unavailable || dbUnavailable(d) || dbUnavailable(m);
      projectsById = Object.fromEntries(projects.map((x) => [x.id, x]));
      if (!ctx.alive()) return;
      const sel = $("[data-proj]", root);
      if (sel.options.length === 1) mount(sel, html`<option value="">All projects</option>${projects.map((x) => html`<option value="${x.id}">${x.name}</option>`)}`), (sel.value = projectFilter);
      paint();
    } catch (e) { if (ctx.alive()) { mount(list, errorState(e)); $("[data-retry]", list)?.addEventListener("click", load); } }
  };
  await load();
  on(root, "click", "[data-new]", async () => {
    if (!projects.length) { location.hash = "#/projects"; return; }
    if (await createDatabase({ projects, projectId: projectFilter || undefined })) load();
  });
  on(root, "change", "[data-proj]", (e) => { projectFilter = e.target.value; paint(); });
  on(root, "input", "[data-q]", debounce((e) => { q = e.target.value.trim().toLowerCase(); paint(); }, 120));
  on(root, "click", "[data-db-creds]", (e, b) => revealCredentials(items.find((d) => d.id === b.dataset.dbCreds)));
  on(root, "click", "[data-db-pma]", (e, b) => openPhpMyAdmin(items.find((d) => d.id === b.dataset.dbPma)));
  on(root, "click", "[data-db-menu]", (e, b) => dbMenu(b, items.find((d) => d.id === b.dataset.dbMenu), load));
  on(root, "click", "[data-root]", () => {
    openModal({ title: "MySQL root password", sub: "Stored encrypted with the panel key. Only needed when socket authentication isn't available.", ico: "key",
      body: html`<div class="field"><label>Root password</label><input class="input" type="password" data-pw autocomplete="off"/></div>`,
      foot: html`<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-ok>Save</button>`,
      onMount(el, close) { $("[data-ok]", el).onclick = async () => { try { await post("/api/mysql/root", { password: $("[data-pw]", el).value }); close(true); load(); } catch (e) { toastError(e); } }; } });
  });
  ctx.on(["database", "backup", "site"], debounce(load, 500));
  const reloadRepl = debounce(async () => { repl = await getReplication(); if (ctx.alive()) paintRepl(); }, 500);
  ctx.on("mysql-ha", reloadRepl);
  ctx.on("job", (j) => { if (String(j?.type || "").startsWith("mysql.") && j.status !== "running" && j.status !== "queued") reloadRepl(); });
}
