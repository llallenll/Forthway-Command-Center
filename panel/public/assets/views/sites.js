import { html, mount, $, on, colorOf, ago, emptyState, errorState, skeletonRows, debounce } from "../util.js";
import { icon } from "../icons.js";
import { get } from "../api.js";
import { pageHead, lbBadge, healthChip, typeIco, TYPE_LABEL } from "../components.js";

/** Public URL of a site: https only once its certificate is active. */
export function siteUrl(s, domain) {
  const d = domain || (s.domains || [])[0];
  if (!d || d.startsWith("*.")) return "";
  const tunnel = s.cloudflare?.enabled && (s.cloudflare.hostnames || []).includes(d); // Cloudflare serves HTTPS
  return `${s.ssl?.status === "active" || tunnel ? "https" : "http"}://${d}`;
}

export function siteRow(s, { serversById = {}, projectsById = {}, showProject = true } = {}) {
  const p = projectsById[s.projectId];
  const ver = s.currentVersion || s.currentRelease?.version;
  const href = siteUrl(s);
  return html`<div class="site-row" data-href="#/sites/${s.id}" role="link" tabindex="0">
    <div class="site-id">${typeIco(s.type)}
      <div style="min-width:0"><div class="site-name">${s.name}</div>
        <div class="site-dom">${(s.domains || [])[0] || html`<span class="dim">No domain</span>`}${(s.domains || []).length > 1 ? html` <span class="dim">+${s.domains.length - 1}</span>` : ""}</div></div></div>
    <div class="site-meta">${lbBadge(s, serversById)}
      <span class="tiny muted row" style="gap:8px">${showProject && p ? html`<span class="row" style="gap:6px"><span class="dot" style="width:7px;height:7px;background:${colorOf(p.color)}"></span>${p.name}</span><span class="dim">·</span>` : ""}${TYPE_LABEL[s.type] || s.type}${ver ? html`<span class="dim">·</span><span class="mono">v${ver}</span>` : ""}<span class="site-health-inline row" style="gap:8px"><span class="dim">·</span>${healthChip(s)}</span></span></div>
    <div class="site-health">${healthChip(s)}${s.ssl?.status === "active" ? html`<div class="tiny muted row mt-8" style="gap:6px">${icon("lock", "xs")}HTTPS</div>` : ""}</div>
    <div class="site-actions btn-row" style="flex-wrap:nowrap">
      ${href ? html`<a class="icon-btn sm ghost" href="${href}" target="_blank" rel="noopener noreferrer" title="Open ${s.domains[0]}" data-stop>${icon("external")}</a>` : ""}
      <span class="icon-btn sm ghost" aria-hidden="true">${icon("chevronRight")}</span></div>
  </div>`;
}

export function bindSiteRows(root) {
  on(root, "click", ".site-row", (e, el) => { if (e.target.closest("[data-stop]")) return; location.hash = el.dataset.href; });
  on(root, "keydown", ".site-row", (e, el) => { if (e.key === "Enter") location.hash = el.dataset.href; });
}

export default async function sites(ctx) {
  const { root } = ctx;
  ctx.crumbs([{ label: "Websites" }]);
  let q = "", filter = ctx.query.filter || "all";
  mount(root, html`${pageHead("Websites", "Every website across your projects, with where it runs and how traffic reaches it.", html`<a class="btn btn-primary" href="#/sites/new">${icon("plus")}New website</a>`)}
    <div class="toolbar"><div class="pills" data-filters></div><span class="grow"></span><div class="search">${icon("search")}<input placeholder="Search name or domain" data-q/></div></div>
    <div data-list>${skeletonRows(5, 68)}</div>`);
  const list = $("[data-list]", root);
  let items = [], serversById = {}, projectsById = {};
  const paint = () => {
    const counts = { all: items.length, lb: items.filter((s) => s.loadBalanced).length, single: items.filter((s) => !s.loadBalanced).length };
    mount($("[data-filters]", root), html`${[["all", "All"], ["lb", "Load balanced"], ["single", "Single server"]].map(([k, l]) => html`<button class="pill ${filter === k ? "active" : ""}" data-f="${k}">${l}<span class="n">${counts[k]}</span></button>`)}`);
    const f = items.filter((s) => (filter === "all" || (filter === "lb") === !!s.loadBalanced) && (!q || (s.name + " " + (s.domains || []).join(" ")).toLowerCase().includes(q)));
    if (!items.length) return mount(list, html`<div class="card">${emptyState({ ico: "globe", title: "No websites yet", text: "Create a website, point a domain at this server, then deploy from GitHub or a zip upload.", action: html`<a class="btn btn-primary" href="#/sites/new">${icon("plus")}New website</a>` })}</div>`);
    if (!f.length) return mount(list, html`<div class="card">${emptyState({ ico: "search", title: "No matches", text: "Try a different search or filter.", sm: true })}</div>`);
    mount(list, html`<div class="site-list">${f.map((s) => siteRow(s, { serversById, projectsById }))}</div>`);
  };
  const load = async () => {
    try {
      const [s, sv, pr] = await Promise.all([get("/api/sites"), get("/api/servers").catch(() => ({ items: [] })), get("/api/projects").catch(() => ({ items: [] }))]);
      items = s.items || [];
      serversById = Object.fromEntries((sv.items || []).map((x) => [x.id, x]));
      projectsById = Object.fromEntries((pr.items || []).map((x) => [x.id, x]));
      if (ctx.alive()) paint();
    } catch (e) { if (ctx.alive()) { mount(list, errorState(e)); $("[data-retry]", list)?.addEventListener("click", load); } }
  };
  await load();
  bindSiteRows(root);
  on(root, "click", "[data-f]", (e, b) => { filter = b.dataset.f; paint(); });
  on(root, "input", "[data-q]", debounce((e) => { q = e.target.value.trim().toLowerCase(); paint(); }, 120));
  ctx.on(["site", "server"], debounce(load, 500));
}
