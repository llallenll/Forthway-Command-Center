import { html, mount, $, on, fmtNum, fmtBytes, fmtCompact, plural, debounce, emptyState, errorState } from "../util.js";
import { icon } from "../icons.js";
import { get } from "../api.js";
import { sparkline } from "../charts.js";
import { trafficCard } from "../traffic.js";
import { jobItem, activityItem, bindJobClicks } from "../components.js";
import { downBanner } from "./monitor.js"; // MONITOR: "N websites down" card
import { getReplication, replSummary, syncBar, syncActive } from "./databases.js"; // Phase 3: database replication line

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Welcome back" : "Good evening";
}

function skeleton(name) {
  return html`<div class="hero-wrap"><section class="hero"><div class="hero-top"><div class="hero-title">Dashboard</div></div>
      <div class="hero-center"><div class="hello">${greeting()}</div><div class="name">${name || "…"}</div><div class="tagline">&nbsp;</div></div></section>
      <div class="stat-row">${[1, 2, 3, 4].map(() => html`<div class="stat" style="height:118px"><div class="skel" style="width:60%;height:16px"></div><div class="skel mt-16" style="height:46px"></div></div>`)}</div></div>
    <div class="section"><div class="skel" style="width:220px;height:22px"></div><div class="skel mt-16" style="height:320px;border-radius:18px"></div></div>`;
}

/* Availability (docs/HA.md): tunnel replicas, edge nodes, websites that live only on main and,
   with panel failover (Phase 2), the active panel and its standbys. Quiet one-liner while all is
   well; a full card when there is a warning. Each part is hidden on an older panel
   (GET /api/cluster/ha or /api/ha → 404). */
function haCard(el, ctx) {
  let last = "";
  const siteLinks = (list, max) => html`${list.slice(0, max).map((x, i) => html`${i ? ", " : ""}<a href="#/sites/${x.id}">${x.name}</a>`)}${list.length > max ? html` and ${list.length - max} more` : ""}`;
  const edgeTone = (e) => (!e.online ? "err" : !e.inSync ? (e.applying ? "run" : "warn") : e.tunnelConnected === false ? "warn" : "ok");
  const edgeText = (e) => (!e.online ? "Offline" : !e.inSync ? (e.applying ? "Applying" : "Out of date") : e.tunnelConnected === false ? "In sync · tunnel not connected" : "In sync");
  const paint = (r, p, d) => {
    const sig = JSON.stringify([r || null, p || null, d || null]);
    if (sig === last) return; last = sig;
    const panel = p?.enabled ? p : null;
    const dbs = replSummary(d); // null when replication is off or unknown to this panel
    if (!r && !panel && !dbs) { el.hidden = true; mount(el, html``); return; }
    el.hidden = false;
    const edges = r?.edges || [], solo = r?.mainOnlySites || [];
    const warns = [...(panel && panel.armed === false ? ["Waiting for the servers to vote… Panel failover starts once a majority has voted."] : []), ...(panel?.warnings || []), ...(r?.warnings || []), ...(dbs?.warns || [])];
    const reps = r?.tunnelReplicasOnline ?? 0, conns = r?.connectors ?? 0;
    const repText = conns ? `${plural(reps, "tunnel replica")} online` : "No tunnel connectors";
    const edgeLine = edges.length ? `${plural(edges.length, "edge node")} besides main` : "No edge nodes besides main";
    const soloText = solo.length ? html`${plural(solo.length, "website")} ${solo.length === 1 ? "runs" : "run"} only on the main server` : "";
    let panelText = "";
    if (panel) {
      const leader = (panel.nodes || []).find((n) => n.serverId === panel.leaderId)?.name || panel.leaderId;
      const sb = (panel.nodes || []).filter((n) => n.serverId !== panel.leaderId).length;
      panelText = `Active panel: ${leader} · ${sb ? `${sb} ${sb === 1 ? "standby" : "standbys"}` : "no standbys"}`;
    }
    const dbText = dbs ? (syncActive(dbs.progress) ? dbs.text : `Databases: ${dbs.text}`) : "";
    const dbBar = syncActive(dbs?.progress) ? html`<span class="ha-db-bar">${syncBar(dbs.progress, { size: "sm" })}</span>` : "";
    const sub = [panelText, r ? repText : "", r ? edgeLine : ""].filter(Boolean).join(" · ");
    const nodes = panel ? (panel.nodes || []).filter((n) => n.serverId !== panel.leaderId) : [];
    if (!warns.length) {
      mount(el, html`<div class="card ha-quiet">
        <span class="ha-ico ok">${icon("shield", "sm")}</span>
        <span class="ha-quiet-t"><b>Availability</b><span class="muted"> · ${sub}${solo.length ? html` · ${soloText}: ${siteLinks(solo, 3)}` : ""}</span>${dbs ? html`<span class="ha-db"><span class="dot ${dbs.tone}"></span><a href="#/settings/databases">${dbText}</a>${dbBar}</span>` : ""}</span>
        <a class="btn btn-sm btn-ghost" href="#/servers">Servers ${icon("arrowRight", "sm")}</a></div>`);
      return;
    }
    mount(el, html`<div class="card ha-alert">
      <div class="card-head"><span class="ha-ico warn">${icon("alert")}</span>
        <div class="ha-head-t"><h3>Availability needs attention</h3><div class="sub">${sub}</div>${dbs ? html`<div class="ha-db"><span class="dot ${dbs.tone}"></span><a href="#/settings/databases">${dbText}</a>${dbBar}</div>` : ""}</div>
        <div class="right"><a class="btn btn-sm" href="#/servers">${icon("server")}Servers</a></div></div>
      <div class="card-body ha-body">
        <ul class="ha-warns">${warns.map((w) => html`<li>${icon("alert", "xs")}<span>${w}</span></li>`)}</ul>
        ${nodes.length || edges.length ? html`<div class="ha-edges">
          ${nodes.map((n) => html`<a class="ha-edge" href="#/servers" title="${n.name}: standby panel"><span class="dot ${!n.online ? "err" : n.codeInSync === false ? "warn" : "ok"}"></span>${n.name}<span class="muted">${!n.online ? "Standby · offline" : "Standby panel"}</span></a>`)}
          ${edges.map((e) => html`<a class="ha-edge" href="#/servers" title="${e.name}: ${edgeText(e)}"><span class="dot ${edgeTone(e)}"></span>${e.name}<span class="muted">${edgeText(e)}</span></a>`)}</div>` : ""}
        ${solo.length ? html`<p class="small muted" style="margin:0">${soloText}: ${siteLinks(solo, 5)}. They go down with it — load balance them onto another server to keep them up.</p>` : ""}
      </div></div>`);
  };
  const load = async () => {
    const [r, p, d] = await Promise.all([get("/api/cluster/ha").catch(() => null), get("/api/ha").catch(() => null), getReplication()]);
    if (ctx.alive()) paint(r, p, d);
  };
  ctx.on(["server", "cloudflare", "site", "ha", "mysql-ha"], debounce((d) => { if (d?.kind !== "log") load(); }, 1500));
  load();
}

export default async function dashboard(ctx) {
  const { root, state } = ctx;
  ctx.crumbs([{ label: "Dashboard" }]);
  mount(root, skeleton(state.me?.name));

  const range = "24h";
  let data, dbs = [], backups = [];
  try {
    [data, dbs, backups] = await Promise.all([
      get(`/api/dashboard?range=${range}`),
      get("/api/databases").then((r) => r.items).catch(() => []),
      get("/api/backups").then((r) => r.items).catch(() => []),
    ]);
  } catch (e) {
    if (!ctx.alive()) return;
    mount(root, errorState(e)); $("[data-retry]", root)?.addEventListener("click", ctx.reload); return;
  }
  if (!ctx.alive()) return;

  const c = data.counts || {};
  const name = data.admin?.name || state.me?.name || "there";
  const reqVals = (data.series?.requests || []).map((p) => p.count);
  const cpuVals = (data.series?.cpu || []).map((p) => p.value);
  // backups per day, last 14 days
  const perDay = Array.from({ length: 14 }, (_, i) => {
    const d0 = new Date(); d0.setHours(0, 0, 0, 0); d0.setDate(d0.getDate() - (13 - i));
    const d1 = +d0 + 864e5;
    return backups.filter((b) => { const t = +new Date(b.createdAt); return t >= +d0 && t < d1; }).length;
  });
  const dbSizes = dbs.map((d) => d.sizeBytes || 0).sort((a, b) => a - b);
  const running = (data.recentJobs || []).filter((j) => j.status === "running" || j.status === "queued").length;
  const h = data.health || {};
  const nginxOk = h.nginx && (h.nginx.installed !== false || h.nginx.dryRun) && h.nginx.configOk !== false;
  const mysqlOk = h.mysql && h.mysql.installed !== false && h.mysql.running !== false;
  const allOk = nginxOk && mysqlOk && c.serversOnline === c.servers;

  const stat = (o) => html`<a class="stat" href="${o.href}" style="--c:${o.color}">
    <div class="stat-head"><span class="stat-ico" style="color:${o.color}">${icon(o.icon)}</span>${o.label}</div>
    <div class="stat-body"><div class="stat-spark">${o.spark}</div>
      <div class="stat-val"><div class="cap">${o.cap}</div><div class="big">${o.big}</div></div></div></a>`;

  mount(root, html`
    <div class="hero-wrap">
      <section class="hero">
        <div class="hero-top">
          <div class="hero-title">Dashboard</div>
          <div class="hero-actions">
            <span class="hchip"><span class="dot ${nginxOk ? "ok" : "err"}"></span>nginx <span class="dim-w">${h.nginx?.version ? "v" + h.nginx.version : h.nginx?.dryRun && !h.nginx?.installed ? "dry run" : nginxOk ? "running" : h.nginx?.installed === false ? "not installed" : "down"}</span></span>
            <span class="hchip"><span class="dot ${mysqlOk ? "ok" : "err"}"></span>MySQL <span class="dim-w">${h.mysql?.version && /^\d/.test(h.mysql.version) ? "v" + h.mysql.version : h.mysql?.dryRun ? "dry run" : mysqlOk ? "running" : h.mysql?.installed === false ? "not installed" : "down"}</span></span>
            <a class="btn btn-white btn-sm" href="#/sites/new">${icon("plus")}New website</a>
          </div>
        </div>
        <div class="hero-center">
          <div class="hello">${greeting()}</div>
          <div class="name">${name}</div>
          <div class="tagline"><span data-sys>${allOk ? "All systems operational" : "Some services need attention"}</span> · ${plural(c.projects || 0, "project")} · ${running ? `${running} job${running > 1 ? "s" : ""} running` : "no jobs running"}</div>
        </div>
      </section>
      <div class="stat-row">
        ${stat({ href: "#/sites", label: "Websites", icon: "globe", color: "#c6f36b", spark: sparkline(reqVals, { color: "#c6f36b" }), cap: html`${fmtNum(c.sitesLoadBalanced || 0)} load balanced`, big: fmtNum(c.sites || 0) })}
        ${stat({ href: "#/databases", label: "Databases", icon: "database", color: "#33d4c1", spark: sparkline(dbSizes.length > 1 ? dbSizes : [0, 0], { color: "#33d4c1" }), cap: html`${fmtBytes(dbSizes.reduce((a, b) => a + b, 0))} stored`, big: fmtNum(c.databases || 0) })}
        ${stat({ href: "#/servers", label: "Servers", icon: "server", color: "#6d8dff", spark: sparkline(cpuVals, { color: "#6d8dff" }), cap: c.serversOnline === c.servers ? "All online" : `${fmtNum((c.servers || 0) - (c.serversOnline || 0))} offline`, big: html`${fmtNum(c.serversOnline || 0)}<small> / ${fmtNum(c.servers || 0)}</small>` })}
        ${stat({ href: "#/backups", label: "Backups", icon: "archive", color: "#9d7dff", spark: sparkline(perDay, { color: "#9d7dff" }), cap: html`${fmtBytes(c.backupsSize || 0)} total`, big: fmtNum(c.backups || 0) })}
      </div>
    </div>

    <section class="section" data-down hidden></section>
    <section class="section" data-ha hidden></section>

    <section class="section">
      <div class="section-head">
        <div><h2>Traffic overview</h2><p>Unique visitors, page views and requests through the front door, across all your websites.</p></div>
      </div>
      <div data-traffic></div>
    </section>

    <section class="section grid-2">
      <div class="card">
        <div class="card-head"><h3>Recent deployments & jobs</h3><div class="right"><a class="btn btn-sm btn-ghost" href="#/sites">All websites ${icon("arrowRight", "sm")}</a></div></div>
        <div class="list" data-jobs></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Recent activity</h3><div class="right"><a class="btn btn-sm btn-ghost" href="#/activity">View all ${icon("arrowRight", "sm")}</a></div></div>
        <div class="list" data-activity></div>
      </div>
    </section>`);

  downBanner($("[data-down]", root), ctx); // MONITOR: shown only while a website is down
  haCard($("[data-ha]", root), ctx); // HA: availability (active panel + standbys, edges, tunnel replicas, main-only websites)
  // Hero status line: live website states (GET /api/monitor + SSE `monitor`), then panel services.
  const sysEl = $("[data-sys]", root);
  const paintSys = (m) => {
    const n = m?.counts || {};
    const down = n.down || 0, degraded = n.degraded || 0;
    if (down || degraded) {
      mount(sysEl, html`${down ? html`<span style="color:#ff9fb2;font-weight:650">${plural(down, "website")} down</span>` : ""}${down && degraded ? " · " : ""}${degraded ? html`<span style="color:#ffd08a;font-weight:650">${fmtNum(degraded)} degraded</span>` : ""}`);
    } else sysEl.textContent = allOk ? "All systems operational" : "Some services need attention";
  };
  const loadSys = async () => { try { const m = await get("/api/monitor"); if (ctx.alive()) paintSys(m); } catch { /* monitor not installed: keep the services line */ } };
  ctx.on("monitor", debounce((d) => { if (d?.kind !== "sms") loadSys(); }, 500));
  loadSys();
  const jobsEl = $("[data-jobs]", root), actEl = $("[data-activity]", root);
  let jobs = data.recentJobs || [], acts = data.recentActivity || [];
  const paintJobs = () => mount(jobsEl, jobs.length ? html`${jobs.slice(0, 7).map(jobItem)}` : emptyState({ ico: "rocket", title: "No jobs yet", text: "Deploys, backups and certificate requests show up here.", sm: true }));
  const paintActs = () => mount(actEl, acts.length ? html`${acts.slice(0, 7).map((a) => activityItem(a, { compact: true }))}` : emptyState({ ico: "activity", title: "Nothing yet", text: "Changes made by admins appear here.", sm: true }));
  paintJobs(); paintActs();
  bindJobClicks(jobsEl);

  // traffic (visitors · page views · requests from /api/analytics; CPU from /api/dashboard, kept 24h)
  trafficCard($("[data-traffic]", root), {
    ctx,
    cpu: async (r) => (r === range ? data.series?.cpu : (await get(`/api/dashboard?range=${r}`)).series?.cpu) || [],
  });

  // live
  const refreshLists = debounce(async () => {
    try {
      const d = await get(`/api/dashboard?range=${range}`);
      if (!ctx.alive()) return;
      jobs = d.recentJobs || jobs; acts = d.recentActivity || acts;
      paintJobs(); paintActs();
    } catch {}
  }, 600);
  ctx.on("job", (j) => {
    const i = jobs.findIndex((x) => x.id === j.id);
    if (i >= 0) jobs[i] = j; else jobs.unshift(j);
    paintJobs();
  });
  ctx.on("activity", (a) => { acts.unshift(a); paintActs(); });
  ctx.on(["site", "database", "backup", "project"], refreshLists);
}
