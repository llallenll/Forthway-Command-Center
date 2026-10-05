import { html, mount, $, on, fmtBytes, plural, emptyState, errorState, skeletonRows, debounce, toastError, openModal } from "../util.js";
import { icon } from "../icons.js";
import { get, post } from "../api.js";
import { pageHead, databasesTable, dbMenu, revealCredentials, createDatabase } from "../components.js";

export default async function databases(ctx) {
  const { root } = ctx;
  ctx.crumbs([{ label: "Databases" }]);
  let q = "", projectFilter = ctx.query.projectId || "";
  mount(root, html`${pageHead("Databases", "MySQL databases on the main server. Websites on agent servers connect over the private network.", html`<button class="btn btn-primary" data-new>${icon("plus")}New database</button>`)}
    <div data-mysql></div>
    <div class="toolbar"><select class="select" data-proj style="width:auto;height:34px;font-size:13px"><option value="">All projects</option></select><span class="grow"></span><div class="search">${icon("search")}<input placeholder="Search databases" data-q/></div></div>
    <div data-list>${skeletonRows(4, 60)}</div>`);
  const list = $("[data-list]", root);
  let items = [], projects = [], projectsById = {}, mysql = null;

  const paintMysql = () => {
    const box = $("[data-mysql]", root);
    if (!mysql) return mount(box, html``);
    if (!mysql.installed) return mount(box, html`<div class="note err" style="margin-bottom:16px">${icon("alert")}<div><b>MySQL isn't installed on the main server.</b> Run the panel installer again or install <span class="mono">mysql-server</span>, then reload this page.</div></div>`);
    if (!mysql.running) return mount(box, html`<div class="note err" style="margin-bottom:16px">${icon("alert")}<div><b>MySQL is not running.</b> ${mysql.error || ""}</div></div>`);
    if (mysql.rootOk === false) return mount(box, html`<div class="note warn" style="margin-bottom:16px;align-items:center">${icon("key")}<div style="flex:1">The panel can't log in to MySQL as root. Enter the root password once so it can manage databases.</div><button class="btn btn-sm" data-root>Set root password</button></div>`);
    const bindLocal = /^(127\.|localhost|::1)/.test(mysql.bindAddress || "");
    const remoteDbs = items.filter((d) => d.remoteAccess).length;
    mount(box, html`${bindLocal && remoteDbs ? html`<div class="note warn" style="margin-bottom:14px">${icon("alert")}<div>MySQL only listens on <span class="mono">${mysql.bindAddress}</span>, so websites on agent servers can't reach the ${plural(remoteDbs, "database")} that allow agent access. Reinstall with <span class="mono">FCC_MYSQL_REMOTE=1</span> (binds 0.0.0.0) and allow port 3306 from your agent servers' addresses only.</div></div>` : ""}
      <div class="row wrap" style="gap:10px;margin-bottom:18px"><span class="badge ok"><span class="dot ok" style="width:6px;height:6px"></span>${mysql.flavor === "mariadb" ? "MariaDB" : "MySQL"} ${mysql.version || ""} running</span>${mysql.bindAddress ? html`<span class="badge mono">bind ${mysql.bindAddress}</span>` : ""}
      <span class="badge">${icon("database")}${items.length} database${items.length === 1 ? "" : "s"}</span><span class="badge">${icon("hardDrive")}${fmtBytes(items.reduce((a, d) => a + (d.sizeBytes || 0), 0))} total</span></div>`);
  };
  const paint = () => {
    paintMysql();
    const f = items.filter((d) => (!projectFilter || d.projectId === projectFilter) && (!q || (d.name + " " + d.user).toLowerCase().includes(q)));
    if (!items.length) return mount(list, html`<div class="card">${emptyState({ ico: "database", title: "No databases yet", text: "Create a MySQL database inside a project, then link it to a website — credentials are injected as environment variables.", action: html`<button class="btn btn-primary" data-new>${icon("plus")}New database</button>` })}</div>`);
    if (!f.length) return mount(list, html`<div class="card">${emptyState({ ico: "search", title: "No matches", sm: true })}</div>`);
    mount(list, databasesTable(f, { projectsById, mysql }));
  };
  const load = async () => {
    try {
      const [d, p, m] = await Promise.all([get("/api/databases"), get("/api/projects").catch(() => ({ items: [] })), get("/api/mysql/status").catch(() => null)]);
      items = d.items || []; projects = p.items || []; mysql = m;
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
  on(root, "click", "[data-db-menu]", (e, b) => dbMenu(b, items.find((d) => d.id === b.dataset.dbMenu), load));
  on(root, "click", "[data-root]", () => {
    openModal({ title: "MySQL root password", sub: "Stored encrypted with the panel key. Only needed when socket authentication isn't available.", ico: "key",
      body: html`<div class="field"><label>Root password</label><input class="input" type="password" data-pw autocomplete="off"/></div>`,
      foot: html`<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-ok>Save</button>`,
      onMount(el, close) { $("[data-ok]", el).onclick = async () => { try { await post("/api/mysql/root", { password: $("[data-pw]", el).value }); close(true); load(); } catch (e) { toastError(e); } }; } });
  });
  ctx.on(["database", "backup", "site"], debounce(load, 500));
}
