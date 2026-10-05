/**
 * Website → Scripts tab: the app's own package.json scripts as named actions
 * (`npm run <name>`), never a free-form command. Lives in its own file so
 * site.js only needs a tab entry and one call.
 */
import { html, raw, mount, $, on, plural, emptyState, errorState, skeletonRows, toastError, confirmDialog } from "../util.js";
import { icon } from "../icons.js";
import { get, post } from "../api.js";
import { jobItem, bindJobClicks, openJobLog } from "../components.js";

const SEL = "height:32px;width:auto;font-size:12.5px";

export async function scriptsTab(ctx, box, S) {
  const base = `#/sites/${S.id}`;
  const lb = !!S.loadBalanced;
  let data = null, serverId = null, showAll = false, allServers = false;

  mount(box, html`<div class="stack">
      <div class="card"><div class="card-head" style="flex-wrap:wrap">
          <h3>package.json scripts</h3><span class="sub" data-src></span>
          <div class="right" style="flex-wrap:wrap"><span data-srvwrap></span><button class="btn btn-sm" data-reload>${icon("refresh")}Refresh</button></div></div>
        <div data-notes></div>
        <div class="list" data-list>${skeletonRows(3, 56)}</div>
        <div class="card-foot" data-foot hidden></div></div>
      <div class="card"><div class="card-head"><h3>Recent script runs</h3><span class="sub">Click a run to see its output</span></div><div class="list" data-jobs></div></div>
    </div>`);
  const list = $("[data-list]", box), notes = $("[data-notes]", box), foot = $("[data-foot]", box);

  const serverName = (id) => data?.servers?.find((s) => s.id === id)?.name || id;
  const where = () => (lb && allServers ? `all ${data.servers.length} servers, one at a time` : serverName(serverId || data?.serverId));

  const paint = () => {
    if (!data) return;
    const sel = serverId || data.serverId;
    mount($("[data-srvwrap]", box), data.servers.length > 1 ? html`<select class="select" data-srv style="${SEL}" aria-label="Server">${data.servers.map((s) => html`<option value="${s.id}" ${s.id === sel ? raw("selected") : ""}>${s.name}${s.online ? "" : " (offline)"}</option>`)}</select>` : "");
    mount($("[data-src]", box), data.source === "deployed" ? html`read from ${serverName(data.serverId)}${data.version ? html` · <span class="mono">v${data.version}</span>` : ""}` : data.source === "release" ? html`from the current release${data.version ? html` · <span class="mono">v${data.version}</span>` : ""}` : "");

    const n = [];
    if (data.source === "release") n.push(html`<div class="note warn">${icon("alert")}<div>Couldn't read the deployed package.json${data.note ? html` (${data.note})` : ""}, so this list comes from the release archive. The server checks the script again before it runs anything.</div></div>`);
    if (data.source === "deployed" && data.hasNodeModules === false) n.push(html`<div class="note warn">${icon("alert")}<div>There is no <span class="mono">node_modules</span> folder on ${serverName(data.serverId)}, so tools from devDependencies may be missing. Deploy again to install them.</div></div>`);
    if (lb) n.push(html`<div class="note">${icon("balance")}<div style="flex:1"><b style="color:var(--text)">This website runs on ${plural(data.servers.length, "server")}.</b> A script runs on <b style="color:var(--text)">one</b> server — the one picked above — which is what you want for database changes (<span class="mono">db:push</span>, migrations, seeds): every server shares the same database, so they must run once.
        <label class="check mt-12"><input type="checkbox" data-all ${allServers ? raw("checked") : ""}/>Run on every server instead, one at a time (for scripts that change files on each server)</label></div></div>`);
    mount(notes, n.length ? html`<div class="card-body stack" style="gap:10px;padding-bottom:4px">${n}</div>` : "");

    const scripts = data.scripts || [];
    const main = scripts.filter((s) => s.kind === "task");
    const extra = scripts.filter((s) => s.kind !== "task");
    const shown = showAll ? [...main, ...extra] : main;
    if (!data.deployed) {
      mount(list, emptyState({ ico: "rocket", title: "Not deployed yet", text: "Scripts run in the deployed app folder. Deploy this website first.", sm: true, action: html`<a class="btn btn-sm" href="${base}/deployments">${icon("rocket")}Open Deployments</a>` }));
    } else if (!scripts.length) {
      mount(list, emptyState({ ico: "code", title: data.source ? "No scripts" : "Couldn't read package.json", text: data.source ? "The app's package.json has no \"scripts\"." : data.note || "Try again when the server is online.", sm: true }));
    } else if (!shown.length) {
      mount(list, emptyState({ ico: "code", title: "Nothing to run here", text: "package.json only has scripts that run the app or npm hooks.", sm: true }));
    } else {
      mount(list, html`${shown.map((s) => html`<div class="list-item">
          <span class="li-ico" style="${s.risky ? "background:rgba(255,181,71,.1);color:var(--warn)" : ""}">${icon(s.risky ? "database" : s.kind === "app" ? "play" : "zap", "sm")}</span>
          <div class="li-main"><div class="li-title mono">${s.name}</div><div class="li-sub mono" title="${s.command}">${s.command}</div></div>
          <div class="li-right">${(S.settings?.afterDeployScripts || []).includes(s.name) ? html`<a class="badge blue hide-sm" href="${base}/settings" title="Runs once after every deploy (website settings)">after deploy</a>` : ""}${s.risky ? html`<span class="badge warn hide-sm">changes data</span>` : ""}${s.kind === "hook" ? html`<span class="badge hide-sm">npm hook</span>` : ""}
            ${s.runnable ? html`<button class="btn btn-sm" data-run="${s.name}">${icon("play")}Run</button>` : html`<button class="btn btn-sm" disabled title="Runs the app itself — use Start or Restart">${icon("play")}Run</button>`}</div></div>`)}`);
    }
    foot.hidden = !extra.length || !data.deployed;
    mount(foot, extra.length ? html`<span class="muted small">${showAll ? "Showing every script." : `${plural(extra.length, "more script")} — app start/dev scripts and npm hooks.`}</span><span class="spacer"></span><button class="btn btn-sm btn-ghost" data-toggle>${showAll ? "Show fewer" : "Show all"}</button>` : "");
  };

  const load = async () => {
    list.classList.add("loading");
    try {
      data = await get(`/api/sites/${S.id}/scripts${serverId ? `?serverId=${encodeURIComponent(serverId)}` : ""}`);
      if (!ctx.alive()) return;
      paint();
    } catch (e) {
      if (!ctx.alive()) return;
      mount(list, errorState(e)); $("[data-retry]", list)?.addEventListener("click", load);
    } finally { list.classList.remove("loading"); }
  };

  on(box, "change", "[data-srv]", (e) => { serverId = e.target.value; load(); });
  on(box, "change", "[data-all]", (e) => (allServers = e.target.checked));
  on(box, "click", "[data-reload]", load);
  on(box, "click", "[data-toggle]", () => { showAll = !showAll; paint(); });
  on(box, "click", "[data-run]", async (e, b) => {
    const s = (data?.scripts || []).find((x) => x.name === b.dataset.run);
    if (!s) return;
    const sid = serverId || data.serverId;
    const ok = await confirmDialog({
      title: `Run ${s.name}?`, danger: s.risky, ico: s.risky ? "alert" : "play", confirmText: `Run ${s.name}`,
      message: html`<span class="mono" style="color:var(--text)">npm run ${s.name}</span> runs <span class="mono" style="color:var(--text)">${s.command}</span> in the app folder on <b style="color:var(--text)">${where()}</b>, with this website's environment${S.linkedDatabaseIds?.length ? " and linked database" : ""}.${s.risky ? " It looks like it changes data — make sure you have a recent database backup." : ""}`,
    });
    if (!ok) return;
    b.classList.add("loading");
    try {
      const job = await post(`/api/sites/${S.id}/scripts/run`, lb && allServers ? { script: s.name, allServers: true } : { script: s.name, serverId: sid });
      if (job?.id) openJobLog(job.id);
    } catch (ex) { toastError(ex, `Couldn't run ${s.name}`); } finally { b.classList.remove("loading"); }
  });

  // recent runs
  const jobsEl = $("[data-jobs]", box);
  let jobs = [];
  const paintJobs = () => mount(jobsEl, jobs.length ? html`${jobs.slice(0, 10).map(jobItem)}` : emptyState({ ico: "zap", title: "No script runs yet", text: "Each run's output is kept here.", sm: true }));
  bindJobClicks(jobsEl);
  ctx.on("job", (j) => { if (j.siteId !== S.id || j.type !== "site.script") return; const i = jobs.findIndex((x) => x.id === j.id); i >= 0 ? (jobs[i] = j) : jobs.unshift(j); paintJobs(); });
  get(`/api/jobs?siteId=${S.id}&type=site.script&limit=10`).then((r) => { jobs = r.items || []; if (ctx.alive()) paintJobs(); }).catch(() => paintJobs());

  await load();
}
