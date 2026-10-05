import { html, raw, mount, $, on, colorOf, PROJECT_COLORS, ago, plural, emptyState, errorState, skeletonRows, toast, toastError, openModal, openMenu, confirmDialog, debounce } from "../util.js";
import { icon } from "../icons.js";
import { get, post, patch, del } from "../api.js";
import { pageHead, createDatabase } from "../components.js";
import { bindSiteRows } from "./sites.js";

/** Create / edit project dialog (shared with the project page). */
export async function projectDialog(project) {
  const isEdit = !!project;
  const m = openModal({
    title: isEdit ? "Edit project" : "New project", sub: isEdit ? "" : "Projects group websites, databases and their backups.", ico: "folder",
    body: html`<form class="form-stack" novalidate>
      <div class="field"><label>Name</label><input class="input" name="name" value="${project?.name || ""}" placeholder="Acme Storefront" autocomplete="off"/></div>
      <div class="field"><label>Description <span class="dim">(optional)</span></label><textarea class="textarea" name="description" style="min-height:76px" placeholder="What lives here?">${project?.description || ""}</textarea></div>
      <div class="field"><label>Color</label><div class="color-pick">${Object.entries(PROJECT_COLORS).map(([k, c]) => html`<label style="--c:${c}" title="${k}"><input type="radio" name="color" value="${k}" ${(project?.color || "blue") === k ? raw("checked") : ""}/><span></span></label>`)}</div></div>
      <div class="error-box" data-err hidden></div><button hidden type="submit"></button></form>`,
    foot: html`<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-ok>${isEdit ? "Save changes" : html`${icon("plus")}Create project`}</button>`,
    onMount(el, close) {
      const form = $("form", el), btn = $("[data-ok]", el), err = $("[data-err]", el);
      const go = async (e) => {
        e?.preventDefault();
        const body = { name: form.name.value.trim(), description: form.description.value.trim(), color: form.color.value };
        if (!body.name) { form.name.classList.add("invalid"); form.name.focus(); return; }
        btn.classList.add("loading"); err.hidden = true;
        try { close(isEdit ? await patch(`/api/projects/${project.id}`, body) : await post("/api/projects", body)); }
        catch (ex) { err.hidden = false; err.textContent = ex.message; }
        finally { btn.classList.remove("loading"); }
      };
      form.addEventListener("submit", go); btn.onclick = go;
    },
  });
  return m.result;
}

/** Last-touched line for a project row: edits bump updatedAt, otherwise creation time. */
function projectWhen(p) {
  const upd = p.updatedAt && p.updatedAt !== p.createdAt;
  const at = upd ? p.updatedAt : p.createdAt;
  // one element, so flex parents can't eat the space between the word and the time
  return html`<span title="${at ? new Date(at).toLocaleString() : ""}">${upd ? "Updated" : "Created"} ${ago(at)}</span>`;
}

/** One project in the list — same row shell, columns and breakpoints as the Websites list. */
export function projectRow(p) {
  const c = colorOf(p.color), n = p.counts || {};
  const count = (ico, v, one) => html`<span class="pc ${v ? "" : "zero"}" title="${plural(v || 0, one)}">${icon(ico, "xs")}<b>${v || 0}</b><span class="pc-l">${(v || 0) === 1 ? one : one + "s"}</span></span>`;
  return html`<div class="site-row proj-row" data-href="#/projects/${p.id}" role="link" tabindex="0" style="--c:${c}" aria-label="Open project ${p.name}">
    <div class="site-id"><span class="proj-ico" aria-hidden="true">${(p.name || "?").trim()[0].toUpperCase()}</span>
      <div style="min-width:0"><div class="site-name">${p.name}</div>
        <div class="site-dom">${p.description || html`<span class="dim">No description</span>`}</div></div></div>
    <div class="site-meta">
      <span class="proj-counts">${count("globe", n.sites, "website")}${count("database", n.databases, "database")}${count("archive", n.backups, "backup")}</span>
      ${n.sitesLoadBalanced
        ? html`<span class="tiny muted row" style="gap:8px"><span class="badge badge-lb">${icon("balance")}${n.sitesLoadBalanced} load balanced</span><span class="site-health-inline row" style="gap:8px"><span class="dim">·</span>${projectWhen(p)}</span></span>`
        : html`<span class="tiny muted site-health-inline">${projectWhen(p)}</span>`}</div>
    <div class="site-health tiny muted">${projectWhen(p)}</div>
    <div class="site-actions btn-row" style="flex-wrap:nowrap">
      <button class="icon-btn sm ghost" data-prow-menu="${p.id}" data-stop aria-label="Actions for ${p.name}">${icon("more")}</button>
      <span class="icon-btn sm ghost" aria-hidden="true">${icon("chevronRight")}</span></div>
  </div>`;
}

/** Row ⋯ menu: edit, add things, delete (only when empty). */
function projectMenu(anchor, p, reload) {
  const n = p.counts || {};
  openMenu(anchor, [
    { label: "Edit project", icon: "edit", onClick: async () => { if (await projectDialog(p)) { toast("Project updated", "ok"); reload(); } } },
    { label: "New website", icon: "globe", onClick: () => { location.hash = `#/sites/new?project=${p.id}`; } },
    { label: "New database", icon: "database", onClick: async () => { if (await createDatabase({ projectId: p.id })) reload(); } },
    { sep: true },
    { label: "Delete project", icon: "trash", danger: true, onClick: async () => {
      if (n.sites || n.databases) { toast("This project isn't empty", "warn", { msg: `Delete its ${plural(n.sites || 0, "website")} and ${plural(n.databases || 0, "database")} first.` }); return; }
      if (!(await confirmDialog({ title: `Delete ${p.name}?`, message: "The project is removed. This can't be undone.", danger: true, typed: p.name, confirmText: "Delete project" }))) return;
      try { await del(`/api/projects/${p.id}`); toast("Project deleted", "ok"); reload(); } catch (e) { toastError(e, "Couldn't delete the project"); }
    } },
  ]);
}

export default async function projects(ctx) {
  const { root } = ctx;
  ctx.crumbs([{ label: "Projects" }]);
  let q = ctx.query.q || "";
  mount(root, html`${pageHead("Projects", "Each project groups its websites, MySQL databases and backups.", html`<div class="search">${icon("search")}<input placeholder="Search projects" value="${q}" data-q/></div><button class="btn btn-primary" data-new>${icon("plus")}New project</button>`)}
    <div data-list>${skeletonRows(4, 68)}</div>`);
  const list = $("[data-list]", root);
  let items = [];
  const paint = () => {
    const f = items.filter((p) => !q || (p.name + " " + (p.description || "")).toLowerCase().includes(q.toLowerCase()));
    if (!items.length) return mount(list, html`<div class="card">${emptyState({ ico: "folder", title: "No projects yet", text: "Create a project to start adding websites and databases.", action: html`<button class="btn btn-primary" data-new>${icon("plus")}New project</button>` })}</div>`);
    if (!f.length) return mount(list, html`<div class="card">${emptyState({ ico: "search", title: "No matches", text: `Nothing matches “${q}”.`, sm: true })}</div>`);
    mount(list, html`<div class="site-list">${f.map(projectRow)}</div>`);
  };
  const load = async () => {
    try { items = (await get("/api/projects")).items || []; if (ctx.alive()) paint(); }
    catch (e) { if (ctx.alive()) { mount(list, errorState(e)); $("[data-retry]", list)?.addEventListener("click", load); } }
  };
  await load();
  bindSiteRows(root); // same click / Enter handling as website rows (skips [data-stop])
  on(root, "click", "[data-prow-menu]", (e, b) => { const p = items.find((x) => x.id === b.dataset.prowMenu); if (p) projectMenu(b, p, load); });
  on(root, "input", "[data-q]", debounce((e) => { q = e.target.value.trim(); paint(); }, 120));
  on(root, "click", "[data-new]", async () => {
    const p = await projectDialog();
    if (p?.id) { toast(`Project ${p.name} created`, "ok"); location.hash = `#/projects/${p.id}`; }
  });
  ctx.on(["project", "site", "database"], debounce(load, 400));
}
