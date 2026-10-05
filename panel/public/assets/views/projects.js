import { html, raw, mount, $, on, colorOf, PROJECT_COLORS, ago, plural, emptyState, errorState, skeletonRows, toast, toastError, openModal, debounce } from "../util.js";
import { icon } from "../icons.js";
import { get, post, patch } from "../api.js";
import { pageHead } from "../components.js";

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

export function projectCard(p) {
  const c = colorOf(p.color), n = p.counts || {};
  return html`<a class="ecard" href="#/projects/${p.id}" style="--c:${c}">
    <span class="accent-glow"></span>
    <div class="ecard-head">
      <span class="ecard-ico" style="background:linear-gradient(135deg, ${c}, color-mix(in srgb, ${c} 55%, #1a2350));box-shadow:0 10px 24px -12px ${c}">${(p.name || "?").trim()[0].toUpperCase()}</span>
      <div style="min-width:0;flex:1"><div class="ecard-title">${p.name}</div><div class="ecard-sub">Created ${ago(p.createdAt)}</div></div>
      ${icon("chevronRight", "sm")}
    </div>
    <div class="ecard-desc">${p.description || html`<span class="dim">No description</span>`}</div>
    <div class="ecard-stats">
      <div><b>${n.sites ?? 0}</b><span>Websites</span></div>
      <div><b>${n.databases ?? 0}</b><span>Databases</span></div>
      <div><b>${n.backups ?? 0}</b><span>Backups</span></div>
    </div>
    ${n.sitesLoadBalanced ? html`<div class="ecard-foot"><span class="badge badge-lb">${icon("balance")}${plural(n.sitesLoadBalanced, "load-balanced site")}</span></div>` : ""}
  </a>`;
}

export default async function projects(ctx) {
  const { root } = ctx;
  ctx.crumbs([{ label: "Projects" }]);
  let q = ctx.query.q || "";
  mount(root, html`${pageHead("Projects", "Each project groups its websites, MySQL databases and backups.", html`<div class="search">${icon("search")}<input placeholder="Search projects" value="${q}" data-q/></div><button class="btn btn-primary" data-new>${icon("plus")}New project</button>`)}
    <div data-list>${html`<div class="cards">${[1, 2, 3].map(() => html`<div class="skel" style="height:208px;border-radius:18px"></div>`)}</div>`}</div>`);
  const list = $("[data-list]", root);
  let items = [];
  const paint = () => {
    const f = items.filter((p) => !q || (p.name + " " + (p.description || "")).toLowerCase().includes(q.toLowerCase()));
    if (!items.length) return mount(list, html`<div class="card">${emptyState({ ico: "folder", title: "No projects yet", text: "Create a project to start adding websites and databases.", action: html`<button class="btn btn-primary" data-new>${icon("plus")}New project</button>` })}</div>`);
    if (!f.length) return mount(list, html`<div class="card">${emptyState({ ico: "search", title: "No matches", text: `Nothing matches “${q}”.`, sm: true })}</div>`);
    mount(list, html`<div class="cards">${f.map(projectCard)}</div>`);
  };
  const load = async () => {
    try { items = (await get("/api/projects")).items || []; if (ctx.alive()) paint(); }
    catch (e) { if (ctx.alive()) { mount(list, errorState(e)); $("[data-retry]", list)?.addEventListener("click", load); } }
  };
  await load();
  on(root, "input", "[data-q]", debounce((e) => { q = e.target.value.trim(); paint(); }, 120));
  on(root, "click", "[data-new]", async () => {
    const p = await projectDialog();
    if (p?.id) { toast(`Project ${p.name} created`, "ok"); location.hash = `#/projects/${p.id}`; }
  });
  ctx.on(["project", "site", "database"], debounce(load, 400));
}
