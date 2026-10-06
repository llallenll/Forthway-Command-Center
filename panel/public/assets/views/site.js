import { html, raw, mount, $, $$, on, colorOf, ago, fmtDate, fmtBytes, plural, emptyState, errorState, skeletonRows, toast, toastError, confirmDialog, openMenu, debounce, copyText } from "../util.js";
import { icon } from "../icons.js";
import { get, post, patch, put, del, upload, MOCK } from "../api.js";
import { tabsBar, lbBadge, healthChip, updateBadge, siteHealth, typeIco, TYPE_LABEL, METHOD_LABEL, serverKind, jobItem, bindJobClicks, jobStarted, openJobLog, serverPicker, envEditor, dropzone } from "../components.js";
import { lbMethodSelect, methodHint } from "./wizard.js";
import { siteUrl } from "./sites.js";
import { scriptsTab } from "./site-scripts.js";
import { uptimeTab } from "./monitor.js"; // Uptime tab (monitoring + SMS alerts)
import { trafficTab } from "./site-traffic.js"; // Traffic tab (visitors, page views — panel/lib/analytics.mjs)
import { loadCfOptions, pickDefaultTunnel, cfPanel, domainRows, dnsNote, bindDelivery, validateDelivery, deliveryPayload, tunnelHosts } from "./cloudflare.js";

export const refName = (x) => (typeof x === "string" ? x : x?.name || "");
const TABS = [
  { id: "overview", label: "Overview", icon: "dashboard" },
  { id: "traffic", label: "Traffic", icon: "users" },
  { id: "uptime", label: "Uptime", icon: "activity" },
  { id: "deployments", label: "Deployments", icon: "rocket" },
  { id: "environment", label: "Environment", icon: "key" },
  { id: "scripts", label: "Scripts", icon: "zap" },
  { id: "domains", label: "Domains & SSL", icon: "lock" },
  { id: "settings", label: "Settings", icon: "settings" },
  { id: "logs", label: "Logs", icon: "fileText" },
];

export default async function site(ctx) {
  const { root, params } = ctx;
  const tab = TABS.some((t) => t.id === params.tab) ? params.tab : "overview";
  mount(root, html`<div class="row"><div class="skel" style="width:52px;height:52px;border-radius:15px"></div><div style="flex:1"><div class="skel" style="width:260px;height:26px"></div><div class="skel mt-8" style="width:380px;height:16px"></div></div></div>
    <div class="skel mt-24" style="height:40px"></div><div class="mini-stats mt-20">${[1, 2, 3, 4].map(() => html`<div class="skel" style="height:84px;border-radius:16px"></div>`)}</div><div class="skel" style="height:260px;border-radius:18px"></div>`);

  let S, servers = [], project = null, databases = [];
  const loadSite = async () => { S = await get(`/api/sites/${params.id}`); return S; };
  try {
    [S, servers] = await Promise.all([loadSite(), get("/api/servers").then((r) => r.items).catch(() => [])]);
    [project, databases] = await Promise.all([get(`/api/projects/${S.projectId}`).catch(() => null), get(`/api/databases?projectId=${S.projectId}`).then((r) => r.items).catch(() => [])]);
  } catch (e) {
    if (!ctx.alive()) return;
    ctx.crumbs([{ label: "Websites", href: "#/sites" }, { label: "Not found" }]);
    mount(root, errorState(e)); $("[data-retry]", root)?.addEventListener("click", ctx.reload); return;
  }
  if (!ctx.alive()) return;
  const serversById = () => Object.fromEntries(servers.map((s) => [s.id, s]));
  const deployed = () => !!S.currentReleaseId || Object.values(S.state || {}).some((x) => x?.releaseId);
  const base = `#/sites/${S.id}`;
  ctx.crumbs([{ label: "Projects", href: "#/projects" }, ...(project ? [{ label: project.name, href: `#/projects/${project.id}` }] : []), { label: S.name, href: base }, ...(tab !== "overview" ? [{ label: TABS.find((t) => t.id === tab).label }] : [])]);

  mount(root, html`<div data-head></div>${tabsBar(TABS, tab, base)}<div data-tab></div>`);
  const head = $("[data-head]", root), box = $("[data-tab]", root);

  /* ── header + actions ── */
  const updateTitle = () => {
    const u = S.update;
    return u ? [u.version && u.version !== u.currentVersion ? `v${u.version}` : u.shortSha, u.message].filter(Boolean).join(" — ") : "";
  };
  const paintHead = () => mount(head, html`<div class="site-head">
      ${typeIco(S.type)}
      <div style="min-width:0;flex:1">
        <h1>${S.name} ${lbBadge(S, serversById())} ${updateBadge(S)}</h1>
        <div class="sh-meta">${healthChip(S)}<span class="dim">·</span>
          ${project ? html`<a href="#/projects/${project.id}" class="row" style="gap:6px"><span class="dot" style="width:7px;height:7px;background:${colorOf(project.color)}"></span>${project.name}</a><span class="dim">·</span>` : ""}
          ${(S.domains || []).slice(0, 2).map((d, i) => html`${i ? html`<span class="dim">·</span>` : ""}<a href="${siteUrl(S, d) || "#"}" target="_blank" rel="noopener noreferrer" class="row" style="gap:5px">${d}${icon("external", "xs")}</a>`)}
          ${(S.domains || []).length > 2 ? html`<span class="dim">+${S.domains.length - 2}</span>` : ""}
        </div>
      </div>
      ${S.busyJobId ? html`<div class="note" style="width:100%;order:3;align-items:center">${icon("refresh")}<div style="flex:1">An operation is running on this website — other actions wait until it finishes.</div><button class="btn btn-sm" data-job="${S.busyJobId}">View log</button></div>` : ""}
      <div class="right btn-row">
        ${S.update ? html`<button class="btn btn-primary" data-update title="${updateTitle()}">${icon("arrowUp")}Update</button>`
          : !deployed() ? html`<button class="btn btn-primary" ${S.github?.repo && !(S.releases || []).length ? raw("data-update") : raw('data-act="deploy"')}>${icon("rocket")}Deploy</button>` : ""}
        <button class="btn" data-act="restart">${icon("restart")}Restart</button>
        <button class="icon-btn" data-more aria-label="More actions">${icon("more")}</button>
      </div></div>`);
  paintHead();
  bindJobClicks(head);

  const runAction = async (act, opts = {}) => {
    const verbs = { deploy: "Deploy", restart: "Restart", stop: "Stop", start: "Start", rollback: "Roll back" };
    if (act === "stop" && !(await confirmDialog({ title: `Stop ${S.name}?`, message: S.loadBalanced ? `The app is stopped on all ${S.serverIds.length} servers. Visitors get an error until you start it again.` : "Visitors get an error until you start it again.", danger: true, confirmText: "Stop website", ico: "stop" }))) return;
    if (act === "rollback") {
      const prev = (S.releases || []).find((r) => r.id === S.previousReleaseId);
      if (!(await confirmDialog({ title: "Roll back?", message: prev ? `Switch back to v${prev.version} on every server.` : "Switch back to the previous release on every server.", confirmText: "Roll back", ico: "rollback" }))) return;
    }
    if (act === "deploy" && !opts.releaseId && !S.currentReleaseId && !(S.releases || []).length) {
      toast("Nothing to deploy yet", "warn", { msg: "Upload a zip or pull from GitHub first.", action: { label: "Open Deployments →", fn: () => (location.hash = `${base}/deployments`) } });
      return;
    }
    try {
      const job = await post(`/api/sites/${S.id}/${act}`, act === "deploy" ? { releaseId: opts.releaseId } : {});
      jobStarted(job, `${verbs[act]} started${S.loadBalanced && act === "deploy" ? " — rolling, one server at a time" : ""}`);
    } catch (e) { toastError(e, `Couldn't ${verbs[act].toLowerCase()}`); }
  };
  on(head, "click", "[data-act]", (e, b) => runAction(b.dataset.act));

  /* ── updates: the tracked branch (or a newer release) is ahead of what's live ── */
  /** Pull the tracked branch and deploy it (or deploy the newer release that's already here). */
  const pullDeploy = async (b) => {
    const u = S.update;
    if (u?.kind === "release" && u.releaseId) return runAction("deploy", { releaseId: u.releaseId });
    if (!S.github?.repo) { location.hash = `${base}/deployments`; return; }
    b?.classList.add("loading");
    try {
      const job = await post(`/api/sites/${S.id}/releases/github`, { deploy: true });
      jobStarted(job, `Pulling ${S.github.branch || "the default branch"} & deploying${S.loadBalanced ? " — rolling, one server at a time" : ""}`);
    } catch (e) { toastError(e, "Couldn't pull & deploy"); }
    finally { b?.classList.remove("loading"); }
  };
  const checkUpdates = async (b) => {
    b?.classList.add("loading");
    try {
      const r = await post(`/api/sites/${S.id}/update-check`);
      S.update = r.update;
      toast(r.update ? "Update available" : "Up to date", r.update ? "info" : "ok", { msg: r.update ? updateTitle() : `${S.name} is on the latest commit of ${S.github.branch || "its branch"}.` });
      paintHead(); if (tab === "overview") paintOverview();
    } catch (e) { toastError(e, "Couldn't check for updates"); }
    finally { b?.classList.remove("loading"); }
  };
  on(root, "click", "[data-update]", (e, b) => pullDeploy(b));
  on(root, "click", "[data-checkupdate]", (e, b) => checkUpdates(b));
  on(head, "click", "[data-more]", (e, b) => openMenu(b, [
    { label: "Start", icon: "play", onClick: () => runAction("start") },
    { label: "Stop", icon: "stop", onClick: () => runAction("stop") },
    { label: "Roll back", icon: "rollback", disabled: !S.previousReleaseId, onClick: () => runAction("rollback") },
    ...(S.github?.repo ? [{ label: "Check for updates", icon: "refresh", onClick: () => checkUpdates() }] : []),
    { sep: true },
    { label: "Run a script…", icon: "zap", onClick: () => (location.hash = `${base}/scripts`) },
    { label: "Open nginx config", icon: "code", onClick: () => (location.hash = `${base}/domains`) },
    { label: "Website settings", icon: "settings", onClick: () => (location.hash = `${base}/settings`) },
  ]));

  const jobsCard = async (el, limit = 8) => {
    let jobs = [];
    const paint = () => mount(el, jobs.length ? html`${jobs.slice(0, limit).map(jobItem)}` : emptyState({ ico: "rocket", title: "No jobs yet", text: "Deploys, restarts and certificate requests for this website appear here.", sm: true }));
    try { jobs = (await get(`/api/jobs?siteId=${S.id}&limit=${limit}`)).items || []; } catch {}
    paint(); bindJobClicks(el);
    ctx.on("job", (j) => { if (j.siteId !== S.id) return; const i = jobs.findIndex((x) => x.id === j.id); i >= 0 ? (jobs[i] = j) : jobs.unshift(j); paint(); });
  };

  const refresh = debounce(async () => {
    try { await loadSite(); if (!ctx.alive()) return; paintHead(); if (tab === "overview") paintOverview(); if (tab === "deployments") paintReleases?.(); } catch {}
  }, 300);
  ctx.on("site", (d) => { if (d?.id === S.id) { if (d.deleted) { toast(`${S.name} was deleted`, "warn"); location.hash = "#/sites"; } else refresh(); } });
  ctx.on("server", debounce(async () => { servers = (await get("/api/servers").catch(() => ({ items: servers }))).items || servers; }, 2000));

  /* ── overview ── */
  let paintOverview = () => {};
  let paintReleases = null;
  if (tab === "overview") {
    mount(box, html`<div data-ov></div>
      <div class="grid-main mt-20">
        <div class="card"><div class="card-head"><h3>Recent jobs</h3><div class="right"><a class="btn btn-sm btn-ghost" href="${base}/deployments">Deployments ${icon("arrowRight", "sm")}</a></div></div><div class="list" data-jobs></div></div>
        <div class="card"><div class="card-head"><h3>Quick actions</h3></div><div class="card-body">
          <div class="stack" style="gap:10px">
            ${S.github?.repo ? html`<button class="btn btn-primary btn-block" data-qpull>${icon("github")}Pull & deploy</button>`
              : html`<a class="btn btn-primary btn-block" href="${base}/deployments">${icon("upload")}Upload a release</a>`}
            <div class="grid-2" style="gap:10px"><button class="btn" data-qa="restart">${icon("restart")}Restart</button><button class="btn" data-qa="rollback" ${S.previousReleaseId ? "" : raw("disabled")}>${icon("rollback")}Roll back</button>
            <button class="btn" data-qa="start">${icon("play")}Start</button><button class="btn btn-danger" data-qa="stop">${icon("stop")}Stop</button></div>
            <p class="hint">${S.loadBalanced ? "Load-balanced deploys roll through servers one at a time, so the site stays up." : "Deploys build in a staging folder and swap in only when the health check passes."}</p>
          </div></div></div>
      </div>`);
    on(box, "click", "[data-qa]", (e, b) => runAction(b.dataset.qa));
    on(box, "click", "[data-qpull]", (e, b) => pullDeploy(b));
    paintOverview = () => {
      const rel = (S.releases || []).find((r) => r.id === S.currentReleaseId) || S.currentRelease || (S.currentVersion ? { version: S.currentVersion } : null);
      const h = siteHealth(S);
      const ups = S.upstreams || [];
      const sById = serversById();
      const spread = S.releasesInLine === false ? S.releaseSpread || [] : [];
      const u = S.update;
      mount($("[data-ov]", box), html`
        ${u ? html`<div class="note" style="margin-bottom:16px;align-items:center">${icon("arrowUp")}<div style="flex:1;min-width:0">
          <strong>Update available${u.version && u.version !== u.currentVersion ? html` — v${u.version}` : ""}</strong>${u.currentVersion ? html` <span class="muted small">(live: v${u.currentVersion})</span>` : ""}
          <div class="small" style="margin-top:4px">${u.shortSha ? html`${u.htmlUrl ? html`<a class="mono" href="${u.htmlUrl}" target="_blank" rel="noopener noreferrer">${u.shortSha}</a>` : html`<span class="mono">${u.shortSha}</span>`} · ` : ""}${u.message || ""}${u.author ? html` <span class="muted">— ${u.author}</span>` : ""}${u.date ? html` <span class="muted">· ${ago(u.date)}</span>` : ""}${u.ref ? html` <span class="muted">· ${u.ref}</span>` : ""}</div></div>
          <div class="btn-row" style="flex-wrap:nowrap"><button class="btn btn-sm btn-primary" data-update>${icon("arrowUp")}Update</button></div></div>` : ""}
        ${spread.length ? html`<div class="note warn" style="margin-bottom:16px">${icon("alert")}<div><strong>Servers are on different releases — redeploy to bring them in line.</strong>
          <div class="small" style="margin-top:4px">${spread.map((g) => `${g.servers.map((x) => x.name).join(", ")}: ${g.releaseId ? (g.version ? "v" + g.version : g.releaseId) : "nothing deployed"}`).join(" · ")}</div>
          <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn btn-sm" data-qa="deploy">${icon("rocket")}Deploy the latest release everywhere</button><a class="btn btn-sm btn-ghost" href="${base}/deployments">Pick a release ${icon("arrowRight", "sm")}</a></div></div></div>` : ""}
        <div class="mini-stats">
          <div class="mini-stat"><div class="ms-l">${icon("rocket", "xs")}Current release</div><div class="ms-v mono">${rel ? (rel.version ? "v" + rel.version : (rel.github?.sha || rel.commit || "").slice(0, 7) || "unversioned") : "—"}</div><div class="ms-s">${rel ? html`${rel.source === "github" ? "GitHub" : "Upload"}${rel.createdAt ? html` · ${ago(rel.createdAt)}` : ""}` : "Nothing deployed yet"}</div></div>
          <div class="mini-stat"><div class="ms-l">${icon("activity", "xs")}Status</div><div class="ms-v row" style="gap:9px"><span class="dot ${h.tone}"></span>${h.text}</div><div class="ms-s">Checked ${ago(Object.values(S.state || {}).map((x) => x?.checkedAt).filter(Boolean).sort().pop())}</div></div>
          <div class="mini-stat"><div class="ms-l">${icon(S.loadBalanced ? "balance" : "server", "xs")}Hosting</div><div class="ms-v">${S.loadBalanced ? `${ups.length} servers` : sById[(S.serverIds || [])[0]]?.name || "main"}</div><div class="ms-s">${S.loadBalanced ? METHOD_LABEL[S.lbMethod] : "Single server"} · port ${S.port || "—"}</div></div>
          <div class="mini-stat"><div class="ms-l">${icon("lock", "xs")}HTTPS</div><div class="ms-v">${S.ssl?.status === "active" ? "Active" : S.ssl?.status === "failed" ? "Failed" : S.ssl?.status === "pending" ? "Pending" : "Not set up"}</div><div class="ms-s">${S.ssl?.expiresAt ? `Renews before ${fmtDate(S.ssl.expiresAt, false)}` : html`<a href="${base}/domains" style="color:var(--blue-3)">Issue a certificate →</a>`}</div></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>${S.loadBalanced ? "Load balancer upstreams" : "Server"}</h3><span class="sub">${S.loadBalanced ? html`${METHOD_LABEL[S.lbMethod]} · health check ${S.healthPath ? html`<span class="mono">${S.healthPath}</span>` : "off"}` : html`health check ${S.healthPath ? html`<span class="mono">${S.healthPath}</span>` : "off"}`}</span>
            <div class="right"><button class="btn btn-sm" data-status>${icon("refresh")}Check now</button></div></div>
          <div class="table-wrap"><table class="table"><thead><tr><th>Server</th><th class="hide-sm">Upstream</th>${S.loadBalanced ? html`<th class="hide-sm">Weight</th>` : ""}<th>Health</th><th class="hide-sm">Version</th><th class="hide-sm">Checked</th></tr></thead><tbody>
          ${(ups.length ? ups : (S.serverIds || ["main"]).map((id) => ({ serverId: id, name: sById[id]?.name || id, address: "—", port: S.port, online: sById[id]?.online }))).map((u) => {
            const st = (S.state || {})[u.serverId] || {};
            const srv = sById[u.serverId];
            const notDeployed = !st.releaseId && !st.deployedAt && !st.version;
            const tone = !u.online ? "off" : notDeployed ? "off" : st.running && st.healthy !== false ? "ok" : st.running ? "warn" : "err";
            const label = !u.online ? "Server offline" : notDeployed ? "Not deployed" : st.running && st.healthy !== false ? (st.healthy ? "Healthy" : "Running") : st.running ? "Unhealthy" : "Stopped";
            return html`<tr><td><div class="row"><span class="li-ico" style="width:32px;height:32px;border-radius:10px;display:grid;place-items:center;background:rgba(74,114,255,.1);color:var(--blue-3)">${icon("server", "sm")}</span><div><div class="t-main">${u.name}</div><div class="t-sub">${serverKind(srv)}</div></div></div></td>
              <td class="hide-sm mono small">${u.address}:${u.port}</td>
              ${S.loadBalanced ? html`<td class="hide-sm num">${u.weight ?? srv?.weight ?? 1}</td>` : ""}
              <td><span class="status" title="${st.error || ""}"><span class="dot ${tone}"></span>${label}</span>${S.loadBalanced && u.down ? html` <span class="badge warn" style="height:20px;font-size:11px" title="nginx is not sending traffic here">out of rotation</span>` : ""}${st.error ? html`<div class="t-sub" style="color:#ff8ea3;max-width:280px">${st.error}</div>` : ""}</td>
              <td class="hide-sm mono small">${st.version ? "v" + st.version : "—"}</td>
              <td class="hide-sm muted small">${ago(st.checkedAt)}</td></tr>`;
          })}</tbody></table></div>
        </div>`);
    };
    paintOverview();
    on(box, "click", "[data-status]", async (e, b) => {
      b.classList.add("loading");
      try { S.state = await get(`/api/sites/${S.id}/status`); paintOverview(); paintHead(); } catch (ex) { toastError(ex, "Status check failed"); } finally { b.classList.remove("loading"); }
    });
    await jobsCard($("[data-jobs]", box), 6);
  }

  /* ── deployments ── */
  if (tab === "deployments") {
    mount(box, html`<div class="grid-2">
        <div class="card"><div class="card-head"><h3>Upload a release</h3><span class="sub">.zip, up to 500 MB</span></div><div class="card-body"><div data-dz></div>
          <div data-up hidden><div class="row small" style="justify-content:space-between;margin-bottom:8px"><span class="strong ellipsis" data-upname></span><span class="muted num" data-uppct>0%</span></div><div class="progress"><div style="width:0%"></div></div></div></div></div>
        <div class="card"><div class="card-head"><h3>Pull from GitHub</h3>${S.github?.repo ? html`<span class="sub mono">${S.github.repo}</span>` : ""}</div><div class="card-body">
          ${S.github?.repo ? html`<div class="form-stack"><div class="field"><label>Branch, tag or commit</label><div class="input-group"><input class="input mono" data-ref value="${S.github.branch || "main"}" list="refs_dl" spellcheck="false"/><button class="btn btn-primary" data-pull>${icon("github")}Pull</button></div><datalist id="refs_dl"></datalist>
            <div class="hint">Downloads the archive and creates a release.</div></div>
            <label class="check"><input type="checkbox" data-pulldeploy/>Deploy it right away</label></div>`
          : emptyState({ ico: "github", title: "No repository set", text: "Connect a GitHub repository in Settings to pull releases.", sm: true, action: html`<a class="btn btn-sm" href="${base}/settings">${icon("settings")}Open settings</a>` })}
        </div></div>
      </div>
      <div class="section-head mt-24" style="margin-bottom:12px"><div><h2 style="font-size:16px">Releases</h2><p>Pinned releases are never cleaned up. The live release can't be deleted.</p></div></div>
      <div data-rel></div>
      <div class="card mt-24"><div class="card-head"><h3>Deploy history</h3><span class="sub">Click a job to see its log</span></div><div class="list" data-jobs></div></div>`);

    dropzone($("[data-dz]", box), { accept: ".zip,application/zip", title: "Drop a .zip here", hint: "or click to choose — the archive becomes a new release", async onFile(file) {
      if (!/\.zip$/i.test(file.name)) { toast("Releases must be .zip files", "warn"); return; }
      if (file.size > 500 * 1024 * 1024) { toast("That file is over 500 MB", "warn"); return; }
      const up = $("[data-up]", box), dz = $("[data-dz]", box);
      up.hidden = false; dz.hidden = true; $("[data-upname]", box).textContent = file.name;
      try {
        const rel = await upload(`/api/sites/${S.id}/releases/upload?filename=${encodeURIComponent(file.name)}`, file, (p) => { $(".progress > div", up).style.width = (p * 100).toFixed(0) + "%"; $("[data-uppct]", box).textContent = (p * 100).toFixed(0) + "%"; });
        toast(`Uploaded ${file.name}`, "ok", { msg: rel?.version ? `Release v${rel.version} is ready to deploy.` : "Release is ready to deploy.", action: rel?.id ? { label: "Deploy now →", fn: () => runAction("deploy", { releaseId: rel.id }) } : undefined });
        await loadSite(); paintReleases();
      } catch (e) { toastError(e, "Upload failed"); }
      finally { up.hidden = true; dz.hidden = false; $(".progress > div", up).style.width = "0%"; }
    } });

    if (S.github?.repo) {
      get(`/api/github/refs?repo=${encodeURIComponent(S.github.repo)}`).then((r) => {
        const dl = $("#refs_dl", box); if (!dl) return;
        mount(dl, html`${[...(r.branches || []), ...(r.tags || [])].map(refName).map((b) => html`<option value="${b}"></option>`)}`);
      }).catch(() => {});
      on(box, "click", "[data-pull]", async (e, b) => {
        b.classList.add("loading");
        try { const dep = $("[data-pulldeploy]", box).checked;
          const job = await post(`/api/sites/${S.id}/releases/github`, { ref: $("[data-ref]", box).value.trim() || undefined, deploy: dep || undefined }); jobStarted(job, dep ? "Pulling & deploying from GitHub" : "Pulling from GitHub"); }
        catch (ex) { toastError(ex, "Couldn't pull"); } finally { b.classList.remove("loading"); }
      });
    }

    paintReleases = () => {
      const rels = S.releases || [];
      mount($("[data-rel]", box), rels.length ? html`<div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Release</th><th>Source</th><th class="hide-sm">Size</th><th class="hide-sm">Created</th><th></th></tr></thead><tbody>
        ${rels.map((r) => {
          const live = r.id === S.currentReleaseId, prev = r.id === S.previousReleaseId;
          return html`<tr><td><div class="row" style="gap:8px;flex-wrap:wrap"><span class="t-main mono">v${r.version || "—"}</span>${live ? html`<span class="badge ok"><span class="dot ok" style="width:6px;height:6px"></span>Live</span>` : ""}${prev ? html`<span class="badge">Previous</span>` : ""}${r.available === false ? html`<span class="badge err" title="The zip for this release is no longer on the panel">${icon("alert")}Archive missing</span>` : ""}${r.pinned ? html`<span class="badge violet">${icon("pin")}Pinned</span>` : ""}${r.built?.available ? html`<span class="badge" title="Built once on ${r.built.builtOnName}; the other servers deploy this same build (${r.built.sizeHuman})">Shared build</span>` : ""}${(r.warnings || []).length ? html`<span class="badge warn" title="${r.warnings.join("\n")}">${icon("alert")}${r.warnings.length} warning${r.warnings.length > 1 ? "s" : ""}</span>` : ""}</div>
            <div class="t-sub mono ellipsis" style="max-width:300px">${r.filename}</div></td>
            <td>${r.source === "github" ? html`<span class="row small" style="gap:7px">${icon("github", "sm")}<span class="mono">${r.commit || "—"}</span></span>` : html`<span class="row small" style="gap:7px">${icon("upload", "sm")}Upload</span>`}</td>
            <td class="hide-sm num">${fmtBytes(r.size)}</td>
            <td class="hide-sm"><div class="small">${fmtDate(r.createdAt)}</div><div class="t-sub">${ago(r.createdAt)}</div></td>
            <td class="actions"><div class="btn-row">
              ${r.available === false ? "" : live ? html`<button class="btn btn-sm" data-rdeploy="${r.id}">${icon("restart")}Redeploy</button>` : html`<button class="btn btn-sm btn-primary" data-rdeploy="${r.id}">${icon("rocket")}Deploy</button>`}
              <button class="icon-btn sm" data-rpin="${r.id}" title="${r.pinned ? "Unpin" : "Pin"}" style="${r.pinned ? "color:var(--violet)" : ""}">${icon("pin")}</button>
              <button class="icon-btn sm" data-rdel="${r.id}" title="Delete" ${live ? raw("disabled style='opacity:.35;pointer-events:none'") : ""}>${icon("trash")}</button></div></td></tr>`;
        })}</tbody></table></div></div>`
        : html`<div class="card">${emptyState({ ico: "rocket", title: "No releases yet", text: S.github?.repo ? "Pull a branch from GitHub or upload a zip to create the first release." : "Upload a zip to create the first release.", sm: true })}</div>`);
    };
    paintReleases();
    on(box, "click", "[data-rdeploy]", (e, b) => runAction("deploy", { releaseId: b.dataset.rdeploy }));
    on(box, "click", "[data-rpin]", async (e, b) => {
      const r = S.releases.find((x) => x.id === b.dataset.rpin);
      try { await patch(`/api/releases/${r.id}`, { pinned: !r.pinned }); r.pinned = !r.pinned; paintReleases(); toast(r.pinned ? "Release pinned" : "Release unpinned", "ok"); } catch (ex) { toastError(ex); }
    });
    on(box, "click", "[data-rdel]", async (e, b) => {
      const r = S.releases.find((x) => x.id === b.dataset.rdel);
      if (!(await confirmDialog({ title: `Delete v${r.version}?`, message: `${r.filename} is removed from the panel. You won't be able to roll back to it.`, danger: true, confirmText: "Delete release" }))) return;
      try { await del(`/api/releases/${r.id}`); S.releases = S.releases.filter((x) => x.id !== r.id); paintReleases(); toast("Release deleted", "ok"); } catch (ex) { toastError(ex, "Couldn't delete"); }
    });
    await jobsCard($("[data-jobs]", box), 15);
  }

  /* ── environment ── */
  if (tab === "environment") {
    mount(box, skeletonRows(4, 44));
    let envData;
    try { envData = await get(`/api/sites/${S.id}/env`); } catch (e) { mount(box, errorState(e)); return; }
    if (!ctx.alive()) return;
    const linked = Array.isArray(envData.linked) ? envData.linked : Object.entries(envData.linked || {}).map(([k, v]) => ({ name: k, vars: v }));
    mount(box, html`<div class="grid-main">
      <div class="card"><div class="card-head"><h3>Environment variables</h3><span class="sub" data-dirty></span><div class="right"><button class="btn btn-primary btn-sm" data-save>${icon("check")}Save & apply</button></div></div>
        <div class="card-body"><div data-suggest></div><div data-env></div>
        <div class="note mt-16">${icon("info")}<div>Saved to the app's <span class="mono">.env</span> on ${S.loadBalanced ? `all ${S.serverIds.length} servers` : "its server"} and passed to the process. The app restarts to pick up changes.</div></div></div></div>
      <div class="stack">
        ${(envData.managed || []).length ? html`<div class="card"><div class="card-head"><h3>Managed by the panel</h3><span class="sub">read-only</span></div>
          <div class="card-body"><div class="env-table">${envData.managed.map((m) => html`<div class="env-row ro" style="grid-template-columns:minmax(0,1.2fr) minmax(0,.9fr)"><input class="input mono" value="${m.key}" readonly/><input class="input" value="${m.pending ? "(created on first deploy)" : m.value}" readonly/></div>`)}</div>
          ${envData.managed.map((m) => html`<div class="note mt-16">${icon("info")}<div>${m.note}</div></div>`)}</div></div>` : ""}
        <div class="card"><div class="card-head"><h3>From linked databases</h3><span class="sub">read-only</span></div>
          <div class="card-body">${linked.length ? html`<div class="stack" style="gap:16px">${linked.map((l) => html`<div><div class="row small strong" style="gap:8px;margin-bottom:8px">${icon("database", "sm")}<span class="mono">${l.name}</span>${l.prefix ? html`<span class="badge mono">${l.prefix}*</span>` : ""}</div>
            ${l.error ? html`<div class="error-box">${icon("alert")}<div>${l.error}</div></div>` : html`<div class="env-table">${Object.entries(l.vars || {}).map(([k, v]) => html`<div class="env-row ro" style="grid-template-columns:minmax(0,.9fr) minmax(0,1.2fr)"><input class="input" value="${k}" readonly/><input class="input" value="${v}" readonly/></div>`)}</div>`}</div>`)}</div>`
            : html`<p class="muted small">No databases linked. Link one below and its connection variables are added automatically.</p>`}</div></div>
        <div class="card"><div class="card-head"><h3>Linked databases</h3></div><div class="card-body">
          ${databases.length ? html`<div class="stack" style="gap:10px">${databases.map((d) => html`<label class="check"><input type="checkbox" data-ldb value="${d.id}" ${(S.linkedDatabaseIds || []).includes(d.id) ? raw("checked") : ""}/><span class="mono">${d.name}</span><span class="dim small">${fmtBytes(d.sizeBytes)}</span></label>`)}</div>
            <button class="btn btn-sm mt-16" data-savelinks>${icon("link")}Update links</button>`
          : html`<p class="muted small">This project has no databases. <a href="#/projects/${S.projectId}/databases" style="color:var(--blue-3)">Create one →</a></p>`}
        </div></div>
      </div></div>`);
    const dirty = $("[data-dirty]", box);
    const ed = envEditor($("[data-env]", box), envData.env || {}, { onDirty: () => (dirty.textContent = "Unsaved changes") });
    const ex = (S.releases || []).find((r) => r.id === S.currentReleaseId)?.envExample || (S.releases || []).find((r) => r.envExample)?.envExample;
    const linkedKeys = new Set(linked.flatMap((l) => Object.keys(l.vars || {})));
    const missing = (ex?.entries || []).filter((x) => x.key && !(x.key in (envData.env || {})) && !linkedKeys.has(x.key) && x.key !== "PORT");
    if (missing.length) {
      mount($("[data-suggest]", box), html`<div class="note" style="margin-bottom:16px;align-items:center">${icon("sparkles")}<div style="flex:1"><b>${ex.file || ".env.example"}</b> in the latest release lists ${plural(missing.length, "key")} not set here: <span class="mono small">${missing.slice(0, 6).map((x) => x.key).join(", ")}${missing.length > 6 ? "…" : ""}</span></div><button class="btn btn-sm" data-addex>${icon("plus")}Add them</button></div>`);
      on(box, "click", "[data-addex]", () => { ed.set({ ...ed.get(), ...Object.fromEntries(missing.map((x) => [x.key, x.value || ""])) }); dirty.textContent = "Unsaved changes"; $("[data-suggest]", box).innerHTML = ""; });
    }
    on(box, "click", "[data-save]", async (e, b) => {
      const err = ed.validate(); if (err) { toast(err, "warn"); return; }
      b.classList.add("loading");
      try {
        const r = await put(`/api/sites/${S.id}/env`, { env: ed.get() }); dirty.textContent = "";
        if (r?.env) ed.set(r.env);
        if ((r?.warnings || []).length) toast("Saved with warnings", "warn", { msg: r.warnings.join(" ") });
        else toast("Environment saved", "ok", { msg: "The app restarts to apply it." });
        if (r?.job?.id) jobStarted(r.job, "Applying environment");
      } catch (ex) { toastError(ex, "Couldn't save"); } finally { b.classList.remove("loading"); }
    });
    on(box, "click", "[data-savelinks]", async (e, b) => {
      const ids = $$("[data-ldb]", box).filter((x) => x.checked).map((x) => x.value);
      b.classList.add("loading");
      try { await patch(`/api/sites/${S.id}`, { linkedDatabaseIds: ids }); toast("Database links updated", "ok"); ctx.reload(); } catch (ex) { toastError(ex); } finally { b.classList.remove("loading"); }
    });
  }

  /* ── domains & SSL ── */
  if (tab === "domains") {
    let domains = [...(S.domains || [])];
    const mainHost = servers.find((s) => s.role === "main")?.host || "";
    // Per-domain delivery: Direct (A record → main) or Cloudflare Tunnel (views/cloudflare.js).
    const savedCf = () => (S.cloudflare?.enabled ? S.cloudflare : { enabled: false, tunnelId: "", hostnames: [] });
    const CF = { domains, hosts: new Set(savedCf().hostnames), tunnelId: savedCf().tunnelId || "", opts: null };
    let cfRoutes = null;
    const tunnelOnly = () => (S.domains || []).length > 0 && (S.domains || []).every((d) => savedCf().hostnames.includes(d));
    mount(box, html`<div class="grid-2">
      <div class="card"><div class="card-head"><h3>Domains</h3><div class="right"><button class="btn btn-sm btn-primary" data-savedom disabled>${icon("check")}Save</button></div></div>
        <div class="card-body"><div class="input-group"><input class="input mono" data-dom placeholder="www.example.com" spellcheck="false" autocomplete="off"/><button class="btn" data-adddom>${icon("plus")}Add</button></div>
        <div class="mt-16" data-doms></div>
        <div class="mt-16" data-cf></div>
        <div class="mt-16" data-dnsnote></div>
        <div class="btn-row mt-12" data-cfactions></div>
        <p class="hint mt-12">Each domain is delivered <b>Direct</b> (DNS A record → the main server) or through a <b>Cloudflare Tunnel</b>. Saving rewrites the nginx config and the tunnel routes.</p></div></div>
      <div class="card"><div class="card-head"><h3>HTTPS certificate</h3><span class="sub" data-sslsub>Let's Encrypt via certbot</span></div><div data-sslcard></div></div>
      </div>
      <div class="card mt-20"><div class="card-head"><h3>nginx configuration</h3><span class="sub">Generated — read-only</span><div class="right"><button class="btn btn-sm" data-copyconf>${icon("copy")}Copy</button></div></div>
        <div class="card-body"><pre class="code" data-conf><span class="muted">Loading…</span></pre></div></div>`);
    const paintSsl = () => { const ssl = S.ssl || {};
      $("[data-sslsub]", box).textContent = tunnelOnly() ? "Handled by Cloudflare" : "Let's Encrypt via certbot";
      if (tunnelOnly()) {
        mount($("[data-sslcard]", box), html`<div class="card-body"><div class="row" style="gap:14px;align-items:flex-start">
          <span class="li-ico cf-ico-tun" style="width:44px;height:44px;border-radius:13px;display:grid;place-items:center;flex:none">${icon("cloud")}</span>
          <div style="flex:1;min-width:0"><div class="strong">Cloudflare terminates HTTPS</div>
            <div class="muted small mt-8">Every domain of this website is delivered through a Cloudflare Tunnel. Visitors get Cloudflare's edge certificate and traffic reaches this server through the tunnel, so no certbot certificate is needed here.</div></div></div></div>`);
        return;
      }
      const mixed = savedCf().hostnames.length > 0;
      mount($("[data-sslcard]", box), html`<div class="card-body">
          <div class="row" style="gap:14px;align-items:flex-start">
            <span class="li-ico" style="width:44px;height:44px;border-radius:13px;display:grid;place-items:center;flex:none;${ssl.status === "active" ? "background:rgba(61,220,151,.12);color:var(--ok)" : ssl.status === "failed" ? "background:rgba(255,93,122,.12);color:var(--err)" : "background:rgba(148,166,255,.08);color:var(--muted)"}">${icon(ssl.status === "failed" ? "alert" : "lock")}</span>
            <div style="flex:1;min-width:0"><div class="strong">${ssl.status === "active" ? "Certificate active" : ssl.status === "failed" ? "Last request failed" : ssl.status === "pending" ? "Request in progress" : "No certificate yet"}</div>
              <div class="muted small mt-8">${ssl.status === "active" ? html`Issued ${fmtDate(ssl.issuedAt, false)}${ssl.expiresAt ? html` · expires ${fmtDate(ssl.expiresAt, false)} (auto-renews)` : ""}` : ssl.status === "failed" ? ssl.error || "certbot reported an error." : "Issue a free certificate once every direct domain resolves to this server."}</div>
              ${mixed ? html`<div class="muted small mt-8 cf-sub">${icon("cloud", "xs")} Tunnel domains get HTTPS from Cloudflare; the certificate is for the Direct domains.</div>` : ""}</div>
          </div>
          <div class="btn-row mt-20"><button class="btn ${ssl.status === "active" ? "" : "btn-primary"}" data-ssl>${icon("shield")}${ssl.status === "active" ? "Re-issue certificate" : "Issue certificate"}</button>${ssl.enabled || ssl.status === "failed" ? html`<button class="btn btn-danger" data-ssldel>${icon("trash")}Delete certificate</button>` : ""}</div>
        </div>`); };
    paintSsl();
    ctx.on(["site", "lb"], (d) => { if ((d?.id === S.id || d?.siteId === S.id) && d?.ssl) { S.ssl = d.ssl; paintSsl(); if (d.id) loadConf(); } });
    const dirty = () => JSON.stringify(domains) !== JSON.stringify(S.domains || []) || JSON.stringify(deliveryPayload(CF)) !== JSON.stringify(deliveryPayload({ domains: S.domains || [], hosts: new Set(savedCf().hostnames), tunnelId: savedCf().tunnelId }));
    const paintDoms = () => {
      mount($("[data-doms]", box), domainRows(CF, { routes: dirty() ? null : cfRoutes, mainHost }));
      mount($("[data-cf]", box), cfPanel(CF));
      mount($("[data-dnsnote]", box), dnsNote(CF, mainHost));
      const errs = (cfRoutes || []).filter((r) => r.status === "error");
      const conflict = errs.some((r) => r.code === "dns_conflict" || /already (?:has|routed)/.test(r.error || ""));
      mount($("[data-cfactions]", box), !dirty() && savedCf().hostnames.length && CF.opts?.connected ? html`<button class="btn btn-sm" data-cfsync>${icon("refresh")}${errs.length ? "Retry Cloudflare routes" : "Re-sync Cloudflare routes"}</button>
        ${conflict ? html`<button class="btn btn-sm btn-danger" data-cfreplace>${icon("alert")}Replace existing records</button>` : ""}` : html``);
      $("[data-savedom]", box).disabled = !dirty();
    };
    const loadCf = async () => {
      const [o, r] = await Promise.all([loadCfOptions(), get(`/api/cloudflare/sites/${S.id}`).catch(() => null)]);
      if (!ctx.alive()) return;
      CF.opts = o; pickDefaultTunnel(CF);
      cfRoutes = r ? r.domains.map((x) => x.route).filter(Boolean) : null;
      paintDoms();
    };
    paintDoms(); loadCf();
    bindDelivery(box, CF, { repaint: paintDoms });
    ctx.on(["cloudflare"], (d) => { if (d?.kind === "routes" && d.siteId === S.id) loadCf(); });
    const add = () => {
      const inp = $("[data-dom]", box);
      const allTunnel = domains.length > 0 && domains.every((d) => CF.hosts.has(d));
      for (const v of inp.value.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)) {
        if (!/^(\*\.)?([a-z0-9-]+\.)+[a-z0-9-]{2,}$/.test(v)) { toast(`“${v}” isn't a valid domain`, "warn"); continue; }
        if (!domains.includes(v)) { domains.push(v); if (allTunnel) CF.hosts.add(v); }
      }
      inp.value = ""; paintDoms();
    };
    $("[data-adddom]", box).onclick = add;
    $("[data-dom]", box).onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } };
    on(box, "click", "[data-rmdom]", (e, b) => { const d = domains[+b.dataset.rmdom]; domains.splice(+b.dataset.rmdom, 1); CF.hosts.delete(d); paintDoms(); });
    const loadConf = async () => { try { const r = await get(`/api/sites/${S.id}/nginx`); $("[data-conf]", box).textContent = r.config || "# (empty)"; } catch (e) { $("[data-conf]", box).textContent = "# Couldn't load: " + e.message; } };
    on(box, "click", "[data-savedom]", async (e, b) => {
      if (!domains.length) { toast("Keep at least one domain", "warn"); return; }
      const cfErr = validateDelivery(CF); if (cfErr) { toast(cfErr, "warn"); return; }
      b.classList.add("loading");
      try {
        const r = await patch(`/api/sites/${S.id}`, { domains, cloudflare: deliveryPayload(CF) });
        if (r?.job?.id) jobStarted(r.job, "Applying domains");
        S.domains = [...domains]; S.cloudflare = r.cloudflare || deliveryPayload(CF);
        paintDoms(); paintHead(); paintSsl(); loadConf(); setTimeout(loadCf, 800);
        toast("Domains saved", "ok", { msg: tunnelHosts(CF).length ? "nginx reloaded; Cloudflare routes are being written." : "nginx was reloaded." });
      } catch (ex) { toastError(ex, "Couldn't save domains"); } finally { b.classList.remove("loading"); }
    });
    on(box, "click", "[data-cfsync],[data-cfreplace]", async (e, b) => {
      const replace = !!b.dataset.cfreplace;
      if (replace && !(await confirmDialog({ title: "Replace existing DNS records and routes?", danger: true, confirmText: "Replace",
        message: "For the tunnel domains that failed, the panel deletes their existing A / AAAA / CNAME records (and any route on this tunnel for the same hostname) in Cloudflare and replaces them with the tunnel's. Anything else on those hostnames stops receiving traffic." }))) return;
      b.classList.add("loading");
      try { const job = await post(`/api/cloudflare/sites/${S.id}/sync`, { replaceExisting: replace }); if (job?.id) jobStarted(job, "Writing Cloudflare routes"); } catch (ex) { toastError(ex); } finally { b.classList.remove("loading"); }
    });
    on(box, "click", "[data-ssl]", async (e, b) => {
      b.classList.add("loading");
      try { const job = await post(`/api/sites/${S.id}/ssl`); jobStarted(job, "Requesting certificate"); if (job?.id) openJobLog(job.id); } catch (ex) { toastError(ex, "Couldn't request a certificate"); } finally { b.classList.remove("loading"); }
    });
    on(box, "click", "[data-ssldel]", async (e, b) => {
      if (!(await confirmDialog({
        title: "Delete the HTTPS certificate?", danger: true, confirmText: "Delete certificate", ico: "trash",
        message: "nginx switches this website back to plain HTTP and the certificate is removed from the server. Visitors using https:// will see an error until a new certificate is issued. Domains on a Cloudflare Tunnel keep HTTPS from Cloudflare.",
      }))) return;
      b.classList.add("loading");
      try { const job = await del(`/api/sites/${S.id}/ssl`); jobStarted(job, "Deleting certificate"); if (job?.id) openJobLog(job.id); } catch (ex) { toastError(ex, "Couldn't delete the certificate"); } finally { b.classList.remove("loading"); }
    });
    on(box, "click", "[data-copyconf]", () => copyText($("[data-conf]", box).textContent));
    loadConf();
  }

  /* ── settings ── */
  if (tab === "settings") {
    const st = S.settings || {};
    const b = st.build || {}, rs = st.restart || {};
    let lb = !!S.loadBalanced;
    mount(box, html`<div class="stack">
      <div class="card"><div class="card-head"><h3>General</h3></div><div class="card-body"><div class="form-grid">
        <div class="field"><label>Name</label><input class="input mono" data-g="name" value="${S.name}"/></div>
        <div class="field"><label>Type</label><select class="select" data-g="type" ${deployed() ? raw("disabled title='Fixed after the first deploy'") : ""}>${Object.entries(TYPE_LABEL).map(([k, l]) => html`<option value="${k}" ${k === S.type ? raw("selected") : ""}>${l}</option>`)}</select></div>
        <div class="field"><label>GitHub repository</label><input class="input mono" data-g="repo" value="${S.github?.repo || ""}" placeholder="owner/name"/></div>
        <div class="field"><label>Default branch</label><input class="input mono" data-g="branch" value="${S.github?.branch || ""}" placeholder="main"/></div>
        <div class="field span-2"><label>GitHub access token <span class="dim">(optional, for this repo only)</span></label><div class="input-group"><input class="input mono" type="password" data-g="token" placeholder="${S.github?.hasToken ? "•••••••• saved — leave blank to keep" : "Uses the panel-wide token from Settings → GitHub when empty"}" autocomplete="new-password"/>${S.github?.hasToken ? html`<button class="btn" data-cleartoken type="button">Remove</button>` : ""}</div></div>
        <div class="field"><label>App port</label><input class="input mono" value="${S.port || ""}" readonly/><div class="hint">Assigned by the panel; the app gets it as <span class="mono">$PORT</span>.</div></div>
        <div class="field"><label>App directory</label><input class="input mono" value="${S.appDir || ""}" readonly/></div>
      </div></div><div class="card-foot"><span class="spacer"></span><button class="btn btn-primary btn-sm" data-save-general>${icon("check")}Save</button></div></div>

      <div class="card"><div class="card-head"><h3>Hosting & load balancing</h3><span class="sub">${lbBadge(S, serversById())}</span></div><div class="card-body">
        <label class="switch"><input type="checkbox" data-lb ${lb ? raw("checked") : ""}/><span class="track"></span><span><b style="color:var(--text)">Load balanced</b> — run a copy on several servers behind nginx</span></label>
        <div class="row mt-20" style="justify-content:space-between;flex-wrap:wrap"><div class="label" data-pick-label>${lb ? "Servers in the pool" : "Server"}</div><span class="muted small" data-pick-hint>${lb ? "Only servers marked “Available for load balancing” are listed." : "Pick where this website runs."}</span></div>
        <div class="mt-12" data-picker></div>
        <div class="form-grid mt-20"><div data-method-wrap ${lb ? "" : raw("hidden")}>${lbMethodSelect(S.lbMethod || "round_robin")}</div>
          <div class="field"><label>Health check path</label><input class="input mono" data-hp value="${S.healthPath || ""}" placeholder="empty = no health check"/><div class="hint">Must answer 2xx after each deploy. Leave empty to skip the check.</div></div></div>
        <div class="note mt-16">${icon("info")}<div>Saving re-writes the nginx upstream and reloads it. Servers you add get the current release deployed automatically; servers you remove stop serving traffic first, then the app is stopped there.</div></div>
      </div><div class="card-foot"><span class="spacer"></span><button class="btn btn-primary btn-sm" data-save-hosting>${icon("check")}Save hosting</button></div></div>

      <div class="card"><div class="card-head"><h3>Build & run</h3></div><div class="card-body"><div class="form-grid">
        ${S.type !== "php" ? html`<div class="field"><label>Install</label><input class="input mono" data-bs="install" value="${b.install || ""}" placeholder="(skip)"/></div>
        <div class="field"><label>Build</label><input class="input mono" data-bs="build" value="${b.build || ""}" placeholder="(skip)"/></div>
        <div class="field"><label>Prepare <span class="dim">(optional)</span></label><input class="input mono" data-bs="prepare" value="${b.prepare || ""}" placeholder="auto-detected (e.g. prisma generate)"/></div>
        <div class="field"><label>Must exist after build <span class="dim">(optional)</span></label><input class="input mono" data-bs="artifact" value="${b.artifact || ""}" placeholder=".next/BUILD_ID"/></div>` : ""}
        ${S.type === "node" ? html`<div class="field"><label>Start</label><input class="input mono" data-ps="start" value="${st.start || rs.start || ""}" placeholder="npm start"/><div class="hint">Run under pm2. The app must listen on <span class="mono">$PORT</span>.</div></div>` : html`<div class="field"><label>Web root</label><input class="input mono" data-ps="publicDir" value="${st.publicDir || ""}" placeholder="."/></div>`}
        <div class="field"><label>Health timeout (seconds)</label><input class="input mono" type="number" min="10" data-ht value="${Math.round((st.healthTimeoutMs || 180000) / 1000)}"/></div>
        ${S.type !== "php" ? html`<div class="field"><label>After deploy, run <span class="dim">(optional)</span></label><input class="input mono" data-ads value="${(st.afterDeployScripts || []).join(", ")}" placeholder="e.g. db:migrate" spellcheck="false"/><div class="hint">package.json scripts, run once per deploy on the first server only, before the other servers get the release. A failure stops the deploy. <a href="${base}/scripts" style="color:var(--blue-3)">Scripts →</a></div></div>` : ""}
        <div class="field span-2"><div class="row wrap" style="gap:22px">
          <label class="switch"><input type="checkbox" data-sw="autoRollback" ${st.autoRollback !== false ? raw("checked") : ""}/><span class="track"></span>Roll back automatically if the health check fails</label>
          <label class="switch"><input type="checkbox" data-sw="smartInstall" ${st.smartInstall !== false ? raw("checked") : ""}/><span class="track"></span>Skip install when the lockfile is unchanged</label></div></div>
      </div></div><div class="card-foot"><span class="muted small">Applies from the next deploy.</span><span class="spacer"></span><button class="btn btn-primary btn-sm" data-save-build>${icon("check")}Save</button></div></div>

      <div class="card danger-zone"><div class="card-head"><h3>Delete website</h3></div><div class="card-body row wrap" style="justify-content:space-between;gap:16px">
        <p class="muted small" style="max-width:560px">Removes the nginx config, stops the app on ${plural((S.serverIds || []).length || 1, "server")} and deletes its releases. Linked databases are kept.</p>
        <button class="btn btn-danger" data-delete>${icon("trash")}Delete website</button></div></div>
    </div>`);
    const picker = serverPicker($("[data-picker]", box), { servers, mode: lb ? "multi" : "single", selected: lb ? S.serverIds : [(S.serverIds || [])[0] || "main"] });
    let keepSingle = (S.serverIds || [])[0] || "main", keepMulti = S.loadBalanced ? [...S.serverIds] : servers.filter((s) => s.lbEligible !== false && s.online).slice(0, 2).map((s) => s.id);
    on(box, "change", "[data-lb]", (e) => {
      if (lb) keepMulti = picker.get(); else keepSingle = picker.get()[0] || keepSingle;
      lb = e.target.checked;
      picker.setMode(lb ? "multi" : "single"); picker.set(lb ? keepMulti : [keepSingle]);
      $("[data-method-wrap]", box).hidden = !lb;
      $("[data-pick-label]", box).textContent = lb ? "Servers in the pool" : "Server";
      $("[data-pick-hint]", box).textContent = lb ? "Only servers marked “Available for load balancing” are listed." : "Pick where this website runs.";
    });
    on(box, "change", "[data-method]", (e) => ($("[data-method-hint]", box).textContent = methodHint(e.target.value)));
    const save = async (btn, body, msg) => {
      btn.classList.add("loading");
      try {
        const r = await patch(`/api/sites/${S.id}`, body);
        const { job, ...rest } = r || {};
        S = { ...S, ...rest }; paintHead();
        if (job?.id) jobStarted(job, `${msg} — syncing servers`); else toast(msg, "ok");
        return true;
      } catch (ex) { toastError(ex, "Couldn't save"); return false; } finally { btn.classList.remove("loading"); }
    };
    on(box, "click", "[data-save-general]", (e, btn) => {
      const v = (k) => $(`[data-g=${k}]`, box).value.trim();
      const github = { repo: v("repo"), branch: v("repo") ? v("branch") || "main" : "", ...(v("token") ? { token: v("token") } : {}) };
      const body = { name: v("name"), github };
      if (!deployed()) body.type = v("type");
      save(btn, body, "Settings saved").then((ok) => ok && ($(`[data-g=token]`, box).value = ""));
    });
    on(box, "click", "[data-cleartoken]", async (e, btn) => { if (await save(btn, { github: { ...(S.github || {}), clearToken: true } }, "Repository token removed")) ctx.reload(); });
    on(box, "click", "[data-save-hosting]", async (e, btn) => {
      const ids = picker.get();
      if (lb && ids.length < 2) { toast("Pick at least 2 servers to load balance", "warn"); return; }
      if (!ids.length) { toast("Pick a server", "warn"); return; }
      const before = new Set(S.loadBalanced ? S.serverIds : [(S.serverIds || [])[0]]);
      const added = ids.filter((i) => !before.has(i)), removed = [...before].filter((i) => !ids.includes(i));
      const names = (a) => a.map((i) => serversById()[i]?.name || i).join(", ");
      if ((added.length || removed.length || lb !== !!S.loadBalanced) && !(await confirmDialog({ title: "Apply hosting changes?", confirmText: "Apply", ico: "balance",
        message: [lb !== !!S.loadBalanced ? (lb ? "Load balancing will be turned on." : "Load balancing will be turned off.") : "", added.length ? `The current release is deployed to ${names(added)}.` : "", removed.length ? `${names(removed)} stop${removed.length === 1 ? "s" : ""} serving this site.` : ""].filter(Boolean).join(" ") }))) return;
      if (await save(btn, { loadBalanced: lb, serverIds: ids, lbMethod: lb ? $("[data-method]", box).value : S.lbMethod, healthPath: $("[data-hp]", box).value.trim() }, "Hosting updated")) {
        mount($(".card-head .sub", $("[data-save-hosting]", box).closest(".card")), lbBadge(S, serversById()));
      }
    });
    on(box, "click", "[data-save-build]", (e, btn) => {
      const settings = { build: {} };
      $$("[data-bs]", box).forEach((i) => (settings.build[i.dataset.bs] = i.value.trim()));
      $$("[data-ps]", box).forEach((i) => (settings[i.dataset.ps] = i.value.trim()));
      $$("[data-sw]", box).forEach((i) => (settings[i.dataset.sw] = i.checked));
      settings.healthTimeoutMs = Math.max(10, Number($("[data-ht]", box).value) || 180) * 1000;
      const ads = $("[data-ads]", box);
      if (ads) settings.afterDeployScripts = ads.value.split(/[\s,]+/).filter(Boolean);
      save(btn, { settings }, "Build settings saved");
    });
    on(box, "click", "[data-delete]", async () => {
      const r = await confirmDialog({ title: `Delete ${S.name}?`, danger: true, typed: S.name, confirmText: "Delete website",
        message: "The website is removed from every server and nginx. This can't be undone.",
        extra: html`<label class="check mt-16"><input type="checkbox" data-extra name="deleteFiles" checked/>Also delete the app files on the servers</label>` });
      if (!r) return;
      try { await del(`/api/sites/${S.id}${r.deleteFiles ? "?deleteFiles=1" : ""}`); toast(`${S.name} deleted`, "ok"); location.hash = project ? `#/projects/${project.id}` : "#/sites"; } catch (ex) { toastError(ex, "Couldn't delete"); }
    });
  }

  /* ── scripts (views/site-scripts.js) ── */
  if (tab === "scripts") await scriptsTab(ctx, box, S);
  if (tab === "uptime") await uptimeTab(box, ctx, S);
  if (tab === "traffic") await trafficTab(ctx, box, S);

  /* ── logs ── */
  if (tab === "logs") {
    const targets = S.loadBalanced ? S.serverIds : [(S.serverIds || [])[0] || "main"];
    const sById = serversById();
    let auto = false, timer = null;
    mount(box, html`<div class="card"><div class="card-head" style="flex-wrap:wrap">
        <h3>Application logs</h3><span class="sub">read-only · newest at the bottom</span>
        <div class="right" style="flex-wrap:wrap">
          <select class="select" data-srv style="height:32px;width:auto;font-size:12.5px">${targets.map((id) => html`<option value="${id}">${sById[id]?.name || id}${sById[id] && !sById[id].online ? " (offline)" : ""}</option>`)}</select>
          <select class="select" data-lines style="height:32px;width:auto;font-size:12.5px">${[100, 200, 500, 1000].map((n) => html`<option value="${n}" ${n === 200 ? raw("selected") : ""}>${n} lines</option>`)}</select>
          <label class="switch small"><input type="checkbox" data-auto/><span class="track"></span>Auto-refresh</label>
          <button class="btn btn-sm" data-reload>${icon("refresh")}Refresh</button></div></div>
      <div class="card-body"><pre class="code wrap" data-logs style="min-height:360px;max-height:65vh"><span class="muted">Loading…</span></pre></div></div>`);
    const pre = $("[data-logs]", box);
    const load = async () => {
      const sid = $("[data-srv]", box).value, n = $("[data-lines]", box).value;
      try {
        const r = await get(`/api/sites/${S.id}/logs?serverId=${encodeURIComponent(sid)}&lines=${n}`);
        if (!ctx.alive()) return;
        const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
        mount(pre, html`${(r.text || "").split("\n").map((l) => html`<div class="log-line ${/\bERROR\b|\berror\b|✗/.test(l) ? "err" : /\bWARN/.test(l) ? "step" : ""}">${l || " "}</div>`)}`);
        if (atBottom || !pre.dataset.loaded) pre.scrollTop = pre.scrollHeight;
        pre.dataset.loaded = "1";
      } catch (e) { mount(pre, html`<span class="log-line err">${e.message}</span>`); }
    };
    on(box, "change", "[data-srv],[data-lines]", () => { delete pre.dataset.loaded; load(); });
    on(box, "click", "[data-reload]", load);
    on(box, "change", "[data-auto]", (e) => { auto = e.target.checked; clearInterval(timer); if (auto) timer = setInterval(load, 5000); });
    ctx.cleanup(() => clearInterval(timer));
    load();
  }
}
