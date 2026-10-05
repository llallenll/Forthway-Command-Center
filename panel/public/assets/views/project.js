import { html, mount, $, on, colorOf, ago, fmtNum, emptyState, errorState, skeletonRows, toast, toastError, confirmDialog, openMenu, debounce } from "../util.js";
import { icon } from "../icons.js";
import { get, del } from "../api.js";
import { tabsBar, databasesTable, dbMenu, revealCredentials, createDatabase, backupsTable, bindBackupActions, activityItem, openPhpMyAdmin } from "../components.js";
import { siteRow, bindSiteRows } from "./sites.js";
import { projectDialog } from "./projects.js";

export default async function project(ctx) {
  const { root, params } = ctx;
  const tab = params.tab || "websites";
  mount(root, html`<div class="skel" style="height:150px;border-radius:22px"></div><div class="skel mt-24" style="height:40px;width:420px"></div><div class="mt-20">${skeletonRows(3, 68)}</div>`);

  let p, servers = [], projects = [];
  try {
    [p, servers, projects] = await Promise.all([get(`/api/projects/${params.id}`), get("/api/servers").then((r) => r.items).catch(() => []), get("/api/projects").then((r) => r.items).catch(() => [])]);
  } catch (e) {
    if (!ctx.alive()) return;
    ctx.crumbs([{ label: "Projects", href: "#/projects" }, { label: "Not found" }]);
    mount(root, errorState(e)); $("[data-retry]", root)?.addEventListener("click", ctx.reload); return;
  }
  if (!ctx.alive()) return;
  ctx.crumbs([{ label: "Projects", href: "#/projects" }, { label: p.name, href: `#/projects/${p.id}` }]);
  const serversById = Object.fromEntries(servers.map((s) => [s.id, s]));
  const c = colorOf(p.color), n = p.counts || {};
  const base = `#/projects/${p.id}`;

  mount(root, html`
    <div class="proj-head" style="--c:${c}">
      <div class="ph-row">
        <span class="ecard-ico" style="width:52px;height:52px;border-radius:15px;font-size:20px;background:linear-gradient(135deg, ${c}, color-mix(in srgb, ${c} 55%, #1a2350));box-shadow:0 14px 30px -14px ${c}">${p.name.trim()[0].toUpperCase()}</span>
        <div style="flex:1;min-width:200px"><h1>${p.name}</h1><p>${p.description || "No description"}</p></div>
        <div class="btn-row">
          <a class="btn btn-primary" href="#/sites/new?project=${p.id}">${icon("plus")}New website</a>
          <button class="icon-btn" data-pmenu aria-label="Project actions">${icon("more")}</button>
        </div>
      </div>
      <div class="ph-stats">
        <div><b>${fmtNum(n.sites || 0)}</b><span>Websites</span></div>
        <div><b>${fmtNum(n.sitesLoadBalanced || 0)}</b><span>Load balanced</span></div>
        <div><b>${fmtNum(n.databases || 0)}</b><span>Databases</span></div>
        <div><b>${fmtNum(n.backups || 0)}</b><span>Backups</span></div>
        <div><b style="font-size:15px;line-height:30px">${ago(p.createdAt)}</b><span>Created</span></div>
      </div>
    </div>
    ${tabsBar([{ id: "websites", label: "Websites", icon: "globe", count: n.sites }, { id: "databases", label: "Databases", icon: "database", count: n.databases }, { id: "backups", label: "Backups", icon: "archive", count: n.backups }, { id: "activity", label: "Activity", icon: "activity" }], tab, base)}
    <div data-tab></div>`);

  on(root, "click", "[data-pmenu]", (e, b) => openMenu(b, [
    { label: "Edit project", icon: "edit", onClick: async () => { if (await projectDialog(p)) { toast("Project updated", "ok"); ctx.reload(); } } },
    { label: "New database", icon: "database", onClick: async () => { if (await createDatabase({ projectId: p.id })) ctx.reload(); } },
    { sep: true },
    { label: "Delete project", icon: "trash", danger: true, onClick: async () => {
      if (n.sites || n.databases) { toast("This project isn't empty", "warn", { msg: `Delete its ${n.sites} website(s) and ${n.databases} database(s) first.` }); return; }
      if (!(await confirmDialog({ title: `Delete ${p.name}?`, message: "The project is removed. This can't be undone.", danger: true, typed: p.name, confirmText: "Delete project" }))) return;
      try { await del(`/api/projects/${p.id}`); toast("Project deleted", "ok"); location.hash = "#/projects"; } catch (e) { toastError(e, "Couldn't delete the project"); }
    } },
  ]));

  const box = $("[data-tab]", root);

  if (tab === "websites") {
    const load = async () => {
      try {
        const items = (await get(`/api/sites?projectId=${p.id}`)).items || [];
        if (!ctx.alive()) return;
        mount(box, items.length ? html`<div class="site-list">${items.map((s) => siteRow(s, { serversById, showProject: false }))}</div>`
          : html`<div class="card">${emptyState({ ico: "globe", title: "No websites in this project", text: "Create a website — run it on one server or load balance it across several.", action: html`<a class="btn btn-primary" href="#/sites/new?project=${p.id}">${icon("plus")}New website</a>` })}</div>`);
      } catch (e) { mount(box, errorState(e)); }
    };
    mount(box, skeletonRows(3, 68));
    await load(); bindSiteRows(box);
    ctx.on("site", debounce(load, 400));
  }

  if (tab === "databases") {
    let items = [], mysql = null;
    const load = async () => {
      try {
        const [r, my] = await Promise.all([get(`/api/databases?projectId=${p.id}`), get("/api/mysql/status").catch(() => null)]);
        items = r.items || []; mysql = my;
        if (!ctx.alive()) return;
        mount(box, html`<div class="toolbar"><span class="muted small">${items.length} database${items.length === 1 ? "" : "s"} on the main server's MySQL</span><span class="grow"></span><button class="btn btn-primary" data-newdb>${icon("plus")}New database</button></div>
          ${items.length ? databasesTable(items, { showProject: false, mysql }) : html`<div class="card">${emptyState({ ico: "database", title: "No databases yet", text: "Create a MySQL database and link it to a website — its credentials are injected as environment variables.", sm: true })}</div>`}`);
      } catch (e) { mount(box, errorState(e)); }
    };
    mount(box, skeletonRows(3, 56));
    await load();
    on(box, "click", "[data-newdb]", async () => { if (await createDatabase({ projectId: p.id })) load(); });
    on(box, "click", "[data-db-creds]", (e, b) => revealCredentials(items.find((d) => d.id === b.dataset.dbCreds)));
    on(box, "click", "[data-db-pma]", (e, b) => openPhpMyAdmin(items.find((d) => d.id === b.dataset.dbPma)));
    on(box, "click", "[data-db-menu]", (e, b) => dbMenu(b, items.find((d) => d.id === b.dataset.dbMenu), load));
    ctx.on(["database", "backup", "site"], debounce(load, 400));
  }

  if (tab === "backups") {
    let items = [], dbs = {};
    const load = async () => {
      try {
        const [b, d] = await Promise.all([get(`/api/backups?kind=database&projectId=${p.id}`), get(`/api/databases?projectId=${p.id}`)]);
        items = b.items || []; dbs = Object.fromEntries((d.items || []).map((x) => [x.id, x]));
        if (!ctx.alive()) return;
        mount(box, items.length ? backupsTable(items, { dbsById: dbs, kind: "database" }) : html`<div class="card">${emptyState({ ico: "archive", title: "No backups yet", text: "Database backups for this project appear here — scheduled or on demand.", sm: true, action: html`<a class="btn" href="#/backups/schedule">${icon("calendar")}Backup schedule</a>` })}</div>`);
      } catch (e) { mount(box, errorState(e)); }
    };
    mount(box, skeletonRows(4, 56));
    await load();
    bindBackupActions(box, () => items, { dbsById: () => dbs, refresh: load });
    ctx.on("backup", debounce(load, 400));
  }

  if (tab === "activity") {
    const load = async () => {
      try {
        const items = (await get(`/api/activity?projectId=${p.id}&limit=100`)).items || [];
        if (!ctx.alive()) return;
        mount(box, html`<div class="card">${items.length ? html`<div class="list">${items.map((a) => activityItem(a))}</div>` : emptyState({ ico: "activity", title: "No activity yet", sm: true })}</div>`);
      } catch (e) { mount(box, errorState(e)); }
    };
    mount(box, skeletonRows(5, 52));
    await load();
    ctx.on("activity", debounce(load, 400));
  }
}
