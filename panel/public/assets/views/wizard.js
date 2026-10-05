import { html, raw, mount, $, $$, on, colorOf, slug, plural, fmtBytes, emptyState, errorState, toast, toastError } from "../util.js";
import { icon } from "../icons.js";
import { get, post } from "../api.js";
import { serverPicker, envEditor, METHOD_LABEL, TYPE_LABEL, lbBadge, serverKind, jobStarted } from "../components.js";

const TYPES = [
  { id: "node", icon: "node", title: "Node.js", desc: "Next.js, Express, Nuxt, Remix… built and kept running with pm2." },
  { id: "static", icon: "static", title: "Static", desc: "Plain HTML or a build output folder (Vite, Astro, Hugo…) served by nginx." },
  { id: "php", icon: "php", title: "PHP", desc: "WordPress, Laravel or plain PHP via PHP-FPM." },
];
const BUILD_DEFAULTS = {
  node: { install: "npm ci --no-audit --no-fund", build: "npm run build", start: "npm start", publicDir: "" },
  static: { install: "", build: "", start: "", publicDir: "" },
  php: { install: "", build: "", start: "", publicDir: "public" },
};
const STEPS = [
  { id: "basics", label: "Basics" },
  { id: "domains", label: "Domains" },
  { id: "source", label: "Source & build" },
  { id: "hosting", label: "Hosting" },
  { id: "data", label: "Database & env" },
  { id: "review", label: "Review" },
];

export function lbMethodSelect(value) {
  return html`<div class="field"><label>Balancing method</label><select class="select" data-method>
    ${Object.entries(METHOD_LABEL).map(([k, l]) => html`<option value="${k}" ${k === value ? raw("selected") : ""}>${l}</option>`)}</select>
    <div class="hint" data-method-hint>${methodHint(value)}</div></div>`;
}
export function methodHint(m) {
  return { round_robin: "Requests rotate through servers in turn, respecting each server's weight.", least_conn: "Each request goes to the server with the fewest active connections. Good for uneven request times.",
    ip_hash: "A visitor's IP always lands on the same server. Use when sessions are kept in memory." }[m] || "";
}

export default async function wizard(ctx) {
  const { root, query } = ctx;
  ctx.crumbs([{ label: "Websites", href: "#/sites" }, { label: "New website" }]);
  mount(root, html`<div class="skel" style="height:60px;width:360px"></div><div class="skel mt-24" style="height:420px;border-radius:18px"></div>`);

  let projects, servers, databases;
  try {
    [projects, servers, databases] = await Promise.all([get("/api/projects").then((r) => r.items), get("/api/servers").then((r) => r.items), get("/api/databases").then((r) => r.items).catch(() => [])]);
  } catch (e) { if (ctx.alive()) { mount(root, errorState(e)); $("[data-retry]", root)?.addEventListener("click", ctx.reload); } return; }
  if (!ctx.alive()) return;
  if (!projects.length) {
    mount(root, html`<div class="card">${emptyState({ ico: "folder", title: "Create a project first", text: "Websites live inside a project, next to their databases and backups.", action: html`<a class="btn btn-primary" href="#/projects">${icon("folder")}Go to projects</a>` })}</div>`);
    return;
  }

  const W = {
    step: 0,
    projectId: query.project && projects.some((p) => p.id === query.project) ? query.project : projects[0].id,
    name: "", type: "node", domains: [],
    source: "github", repo: "", branch: "main", refs: null,
    build: { ...BUILD_DEFAULTS.node },
    loadBalanced: false, single: (servers.find((s) => s.role === "main") || servers[0])?.id, multi: servers.filter((s) => s.lbEligible !== false && s.online).slice(0, 3).map((s) => s.id), lbMethod: "round_robin",
    healthPath: "/", linked: [], env: {}, pullNow: true,
  };
  let picker = null, envEd = null;

  mount(root, html`
    <div class="page-head"><div><h1>New website</h1><p>Six short steps. You can change any of this later in the website's settings.</p></div>
      <div class="right"><a class="btn btn-ghost" href="#/sites">Cancel</a></div></div>
    <div class="wizard">
      <nav class="steps" data-steps></nav>
      <div class="card wiz-body"><div class="card-body" data-body></div>
        <div class="card-foot"><button class="btn btn-ghost" data-back>${icon("chevronLeft")}Back</button><span class="spacer"></span><span class="muted small" data-stepn></span><button class="btn btn-primary" data-next>Continue${icon("chevronRight")}</button></div></div>
    </div>`);
  const body = $("[data-body]", root);

  const validate = (i) => {
    const s = STEPS[i].id;
    if (s === "basics") {
      if (!W.name) return "Give the website a name.";
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(W.name)) return "Use lowercase letters, numbers and dashes for the name.";
    }
    if (s === "domains" && !W.domains.length) return "Add at least one domain (you can use a temporary one).";
    if (s === "source" && W.source === "github" && !/^[\w.-]+\/[\w.-]+$/.test(W.repo)) return "Enter the repository as owner/name.";
    if (s === "hosting") {
      if (W.loadBalanced && W.multi.length < 2) return "Pick at least 2 servers to load balance across.";
      if (!W.loadBalanced && !W.single) return "Pick a server.";
    }
    if (s === "data" && envEd) { const e = envEd.validate(); if (e) return e; }
    return null;
  };

  const paintSteps = () => mount($("[data-steps]", root), html`${STEPS.map((s, i) => html`<button class="step ${i === W.step ? "active" : ""} ${i < W.step ? "done" : ""}" data-go="${i}"><span class="n">${i < W.step ? icon("check", "xs") : i + 1}</span>${s.label}</button>`)}`);

  function render() {
    paintSteps();
    $("[data-back]", root).style.visibility = W.step ? "" : "hidden";
    $("[data-stepn]", root).textContent = `Step ${W.step + 1} of ${STEPS.length}`;
    const last = W.step === STEPS.length - 1;
    mount($("[data-next]", root), last ? html`${icon("rocket")}Create website` : html`Continue${icon("chevronRight")}`);
    const id = STEPS[W.step].id;
    picker = null; envEd = null;

    if (id === "basics") {
      mount(body, html`<h2>Basics</h2><p class="lead">Which project it belongs to, what to call it, and what kind of app it is.</p>
        <div class="form-grid">
          <div class="field"><label>Project</label><select class="select" data-k="projectId">${projects.map((p) => html`<option value="${p.id}" ${p.id === W.projectId ? raw("selected") : ""}>${p.name}</option>`)}</select></div>
          <div class="field"><label>Name</label><input class="input mono" data-k="name" value="${W.name}" placeholder="acme-web" autocomplete="off" spellcheck="false"/><div class="hint">Lowercase, used for folders and the process name.</div></div>
        </div>
        <div class="field mt-20"><label>Type</label><div class="choice-grid">${TYPES.map((t) => html`<label class="choice ${W.type === t.id ? "selected" : ""}"><input type="radio" name="type" value="${t.id}" ${W.type === t.id ? raw("checked") : ""}/><span class="c-mark"></span>
          <span class="c-title"><span class="c-ico">${icon(t.icon)}</span>${t.title}</span><span class="c-desc">${t.desc}</span></label>`)}</div></div>`);
    }

    if (id === "domains") {
      const main = servers.find((s) => s.role === "main");
      mount(body, html`<h2>Domains</h2><p class="lead">Every domain is served by nginx on the main server${main?.host ? html` (<span class="mono">${main.host}</span>)` : ""}, which then forwards to wherever the site runs.</p>
        <div class="field"><label>Add a domain</label><div class="input-group"><input class="input mono" data-dom placeholder="example.com" autocomplete="off" spellcheck="false"/><button class="btn" data-adddom>${icon("plus")}Add</button></div>
          <div class="hint">Press Enter to add. Add both <span class="mono">example.com</span> and <span class="mono">www.example.com</span> if you want both.</div></div>
        <div class="chips mt-16" data-doms></div>
        <div class="note mt-20">${icon("info")}<div>Point each domain's DNS <b>A record</b> at <span class="mono">${main?.host || "the main server"}</span>. Once DNS resolves you can issue a free HTTPS certificate from the website's <b>Domains & SSL</b> tab.</div></div>`);
      const paintDoms = () => mount($("[data-doms]", body), W.domains.length ? html`${W.domains.map((d, i) => html`<span class="chip">${icon("globe", "xs")}<span class="mono">${d}</span><button data-rmdom="${i}" aria-label="Remove">${icon("x", "xs")}</button></span>`)}` : html`<span class="muted small">No domains yet.</span>`);
      const add = () => {
        const inp = $("[data-dom]", body);
        const vals = inp.value.split(/[\s,]+/).map((x) => x.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean);
        for (const v of vals) {
          if (!/^(\*\.)?([a-z0-9-]+\.)+[a-z0-9-]{2,}$/.test(v)) { toast(`“${v}” isn't a valid domain`, "warn"); continue; }
          if (!W.domains.includes(v)) W.domains.push(v);
        }
        inp.value = ""; paintDoms(); inp.focus();
      };
      paintDoms();
      $("[data-adddom]", body).onclick = add;
      $("[data-dom]", body).onkeydown = (e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } };
      on(body, "click", "[data-rmdom]", (e, b) => { W.domains.splice(+b.dataset.rmdom, 1); paintDoms(); });
    }

    if (id === "source") {
      mount(body, html`<h2>Source & build</h2><p class="lead">Where releases come from. Every deploy is a release you can roll back to.</p>
        <div class="mode-switch">
          <label class="choice ${W.source === "github" ? "selected" : ""}"><input type="radio" name="source" value="github" ${W.source === "github" ? raw("checked") : ""}/><span class="c-mark"></span>
            <span class="c-title"><span class="c-ico">${icon("github")}</span>GitHub repository</span><span class="c-desc">Pull a branch or tag as a release. Uses the panel's GitHub token for private repos.</span></label>
          <label class="choice ${W.source === "upload" ? "selected" : ""}"><input type="radio" name="source" value="upload" ${W.source === "upload" ? raw("checked") : ""}/><span class="c-mark"></span>
            <span class="c-title"><span class="c-ico">${icon("upload")}</span>Upload a zip later</span><span class="c-desc">Create the website now, then drag a .zip onto its Deployments tab.</span></label>
        </div>
        ${W.source === "github" ? html`<div class="form-grid mt-20">
          <div class="field"><label>Repository</label><div class="input-group"><input class="input mono" data-k="repo" value="${W.repo}" placeholder="owner/name" spellcheck="false" autocomplete="off"/><button class="btn" data-refs>${icon("refresh")}Branches</button></div></div>
          <div class="field"><label>Branch or tag</label>${W.refs ? html`<select class="select" data-k="branch">${[...W.refs.branches.map((b) => ["", b]), ...W.refs.tags.map((t) => ["tag", t])].map(([k, b]) => html`<option value="${b}" ${b === W.branch ? raw("selected") : ""}>${k ? "tag · " : ""}${b}</option>`)}</select>` : html`<input class="input mono" data-k="branch" value="${W.branch}" placeholder="main"/>`}</div>
        </div>` : ""}
        <div class="divider"></div>
        <h3 style="font-size:14.5px;font-weight:650">Build</h3><p class="muted small" style="margin:4px 0 14px">Defaults for ${TYPE_LABEL[W.type]}. These run inside the release folder on each server — never on your behalf anywhere else.</p>
        <div class="form-grid">
          ${W.type !== "php" ? html`<div class="field"><label>Install</label><input class="input mono" data-b="install" value="${W.build.install}" placeholder="(skip)"/></div>
          <div class="field"><label>Build</label><input class="input mono" data-b="build" value="${W.build.build}" placeholder="(skip)"/></div>` : ""}
          ${W.type === "node" ? html`<div class="field"><label>Start</label><input class="input mono" data-b="start" value="${W.build.start}" placeholder="npm start"/><div class="hint">The app must listen on <span class="mono">$PORT</span>.</div></div>` : ""}
          ${W.type !== "node" ? html`<div class="field"><label>Web root</label><input class="input mono" data-b="publicDir" value="${W.build.publicDir}" placeholder="auto-detect"/><div class="hint">Folder nginx serves, relative to the release. Empty = first of dist, build, out, public, _site with an index file.</div></div>` : ""}
        </div>`);
      $("[data-refs]", body)?.addEventListener("click", async (e) => {
        const b = e.currentTarget; W.repo = $("[data-k=repo]", body).value.trim();
        b.classList.add("loading");
        try {
          const r = await get(`/api/github/refs?repo=${encodeURIComponent(W.repo)}`);
          const nm = (x) => (typeof x === "string" ? x : x?.name || "");
          W.refs = { branches: (r.branches || []).map(nm).filter(Boolean), tags: (r.tags || []).map(nm).filter(Boolean), private: r.private };
          if (!W.refs.branches.includes(W.branch)) W.branch = r.defaultBranch || W.refs.branches[0] || "main";
          render();
          toast(`Found ${W.refs.branches.length} branches${W.refs.tags.length ? ` and ${W.refs.tags.length} tags` : ""}`, "ok", { msg: r.private ? "Private repository — the panel's GitHub token has access." : "" });
        }
        catch (ex) { toastError(ex, "Couldn't list branches"); }
        finally { b.classList.remove("loading"); }
      });
    }

    if (id === "hosting") {
      mount(body, html`<h2>Hosting</h2><p class="lead">Run it on one server, or load balance it across several so traffic is shared and one server going down doesn't take the site with it.</p>
        <div class="mode-switch">
          <label class="choice ${!W.loadBalanced ? "selected" : ""}"><input type="radio" name="lb" value="0" ${!W.loadBalanced ? raw("checked") : ""}/><span class="c-mark"></span>
            <span class="c-title"><span class="c-ico">${icon("server")}</span>Single server</span><span class="c-desc">One copy of the app on the server you pick — the main server or any agent server.</span></label>
          <label class="choice ${W.loadBalanced ? "selected" : ""}"><input type="radio" name="lb" value="1" ${W.loadBalanced ? raw("checked") : ""}/><span class="c-mark"></span>
            <span class="c-title"><span class="c-ico">${icon("balance")}</span>Load balanced</span><span class="c-desc">A copy on every selected server. nginx on the main server spreads requests and skips unhealthy ones.</span></label>
        </div>
        <div class="row mt-24" style="justify-content:space-between;flex-wrap:wrap"><div class="label">${W.loadBalanced ? "Servers in the pool" : "Server"}</div><span class="muted small">${W.loadBalanced ? "Only servers marked “Available for load balancing” are listed." : "RAM and disk are the latest readings."}</span></div>
        <div class="mt-12" data-picker></div>
        ${W.loadBalanced ? html`<div class="form-grid mt-20">${lbMethodSelect(W.lbMethod)}
          <div class="field"><label>Health check path</label><input class="input mono" data-k="healthPath" value="${W.healthPath}" placeholder="empty = no health check"/><div class="hint">Servers that fail this check are taken out of rotation.</div></div></div>`
        : html`<div class="form-grid mt-20"><div class="field"><label>Health check path</label><input class="input mono" data-k="healthPath" value="${W.healthPath}" placeholder="empty = no health check"/><div class="hint">Must answer 2xx after each deploy before it goes live. Leave empty to skip.</div></div></div>`}`);
      picker = serverPicker($("[data-picker]", body), { servers, mode: W.loadBalanced ? "multi" : "single", selected: W.loadBalanced ? W.multi : [W.single], onChange(ids) { if (W.loadBalanced) W.multi = ids; else W.single = ids[0]; } });
      on(body, "change", "[data-method]", (e) => { W.lbMethod = e.target.value; $("[data-method-hint]", body).textContent = methodHint(W.lbMethod); });
    }

    if (id === "data") {
      const pdbs = databases.filter((d) => d.projectId === W.projectId);
      mount(body, html`<h2>Database & environment</h2><p class="lead">Linked databases inject <span class="mono">DB_HOST</span>, <span class="mono">DB_NAME</span>, <span class="mono">DB_USER</span>, <span class="mono">DB_PASSWORD</span> and <span class="mono">DATABASE_URL</span> automatically.</p>
        <div class="label" style="margin-bottom:10px">Link databases</div>
        ${pdbs.length ? html`<div class="choice-grid">${pdbs.map((d) => html`<label class="choice checkbox ${W.linked.includes(d.id) ? "selected" : ""}"><input type="checkbox" data-link value="${d.id}" ${W.linked.includes(d.id) ? raw("checked") : ""}/><span class="c-mark"></span>
          <span class="c-title"><span class="c-ico">${icon("database")}</span><span class="mono" style="font-size:13px">${d.name}</span></span><span class="c-desc">${fmtBytes(d.sizeBytes)} · user ${d.user}</span></label>`)}</div>`
        : html`<div class="note">${icon("info")}<div>This project has no databases yet. You can create one later and link it from the website's Environment tab.</div></div>`}
        <div class="divider"></div>
        <div class="label" style="margin-bottom:10px">Environment variables</div>
        <div data-env></div>`);
      envEd = envEditor($("[data-env]", body), W.env);
      on(body, "change", "[data-link]", (e) => { const v = e.target.value; W.linked = e.target.checked ? [...new Set([...W.linked, v])] : W.linked.filter((x) => x !== v); e.target.closest(".choice").classList.toggle("selected", e.target.checked); });
    }

    if (id === "review") {
      const p = projects.find((x) => x.id === W.projectId);
      const sById = Object.fromEntries(servers.map((s) => [s.id, s]));
      const fake = { loadBalanced: W.loadBalanced, serverIds: W.loadBalanced ? W.multi : [W.single], lbMethod: W.lbMethod };
      const envN = Object.keys(W.env).length;
      mount(body, html`<h2>Review</h2><p class="lead">Check everything, then create. Nothing is deployed until a release exists.</p>
        <dl class="kv" style="grid-template-columns:150px 1fr;gap:14px 20px">
          <dt>Name</dt><dd class="mono">${W.name}</dd>
          <dt>Project</dt><dd><span class="row" style="gap:8px"><span class="dot" style="background:${colorOf(p?.color)}"></span>${p?.name}</span></dd>
          <dt>Type</dt><dd>${TYPE_LABEL[W.type]}</dd>
          <dt>Domains</dt><dd><div class="chips">${W.domains.map((d) => html`<span class="badge mono">${d}</span>`)}</div></dd>
          <dt>Source</dt><dd>${W.source === "github" ? html`<span class="row" style="gap:8px">${icon("github", "sm")}<span class="mono">${W.repo}@${W.branch}</span></span>` : "Zip upload"}</dd>
          <dt>Hosting</dt><dd><div class="stack" style="gap:8px">${lbBadge(fake, sById)}
            ${W.loadBalanced ? html`<span class="muted small">${fake.serverIds.map((i) => sById[i]?.name).join(", ")} · ${METHOD_LABEL[W.lbMethod]}</span>` : html`<span class="muted small">${serverKind(sById[W.single])} · ${sById[W.single]?.host || ""}</span>`}</div></dd>
          <dt>Databases</dt><dd>${W.linked.length ? W.linked.map((i) => databases.find((d) => d.id === i)?.name).join(", ") : html`<span class="muted">None</span>`}</dd>
          <dt>Environment</dt><dd>${envN ? plural(envN, "variable") : html`<span class="muted">None</span>`}</dd>
        </dl>
        ${W.source === "github" ? html`<div class="divider"></div><label class="switch"><input type="checkbox" data-pull ${W.pullNow ? raw("checked") : ""}/><span class="track"></span>Pull <span class="mono">${W.branch}</span> from GitHub and deploy right after creating</label>` : ""}
        <div class="error-box mt-16" data-err hidden></div>`);
      $("[data-pull]", body)?.addEventListener("change", (e) => (W.pullNow = e.target.checked));
    }
  }

  // two-way bind simple fields
  on(body, "input", "[data-k]", (e, el) => { W[el.dataset.k] = el.value.trim(); if (el.dataset.k === "name") { const v = slug(el.value); if (v !== el.value && el.value.endsWith(" ")) el.value = v; } });
  on(body, "change", "[data-k]", (e, el) => { W[el.dataset.k] = el.value.trim(); if (el.dataset.k === "name") { el.value = W.name = slug(el.value); } });
  on(body, "input", "[data-b]", (e, el) => (W.build[el.dataset.b] = el.value));
  on(body, "change", "input[name=type]", (e) => { W.type = e.target.value; W.build = { ...BUILD_DEFAULTS[W.type] }; if (W.type !== "node") W.healthPath = "/"; render(); });
  on(body, "change", "input[name=source]", (e) => { W.source = e.target.value; render(); });
  on(body, "change", "input[name=lb]", (e) => {
    if (picker) { const ids = picker.get(); if (W.loadBalanced) W.multi = ids; else W.single = ids[0] || W.single; }
    W.loadBalanced = e.target.value === "1";
    render();
  });

  const go = (i) => {
    if (i > W.step) for (let k = W.step; k < i; k++) { const err = validate(k); if (err) { W.step = k; render(); toast(err, "warn"); return; } }
    if (envEd) W.env = envEd.get();
    W.step = Math.max(0, Math.min(STEPS.length - 1, i));
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  on(root, "click", "[data-go]", (e, b) => go(+b.dataset.go));
  $("[data-back]", root).onclick = () => go(W.step - 1);
  $("[data-next]", root).onclick = async (e) => {
    if (W.step < STEPS.length - 1) return go(W.step + 1);
    for (let k = 0; k < STEPS.length - 1; k++) { const err = validate(k); if (err) { W.step = k; render(); toast(err, "warn"); return; } }
    const btn = e.currentTarget; btn.classList.add("loading");
    const settings = { build: { install: W.build.install, build: W.build.build }, start: W.type === "node" ? W.build.start || "npm start" : undefined, publicDir: W.type !== "node" ? W.build.publicDir : undefined };
    try {
      const site = await post(`/api/projects/${W.projectId}/sites`, {
        name: W.name, type: W.type, domains: W.domains, loadBalanced: W.loadBalanced, serverIds: W.loadBalanced ? W.multi : [W.single], lbMethod: W.lbMethod, healthPath: W.healthPath,
        github: W.source === "github" ? { repo: W.repo, branch: W.branch } : null, settings, env: W.env, linkedDatabaseIds: W.linked,
      });
      toast(`${site.name} created`, "ok", { msg: W.loadBalanced ? `Load balanced across ${W.multi.length} servers.` : "Single server." });
      if (W.source === "github" && W.pullNow) {
        try { const job = await post(`/api/sites/${site.id}/releases/github`, { ref: W.branch, deploy: true }); jobStarted(job, "Pulling & deploying from GitHub"); } catch (ex) { toastError(ex, "Couldn't start the GitHub pull"); }
      }
      location.hash = `#/sites/${site.id}/deployments`;
    } catch (ex) {
      const err = $("[data-err]", body); if (err) { err.hidden = false; err.textContent = ex.message; } else toastError(ex);
    } finally { btn.classList.remove("loading"); }
  };
  render();
}
