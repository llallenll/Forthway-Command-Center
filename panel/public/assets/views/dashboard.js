import { html, mount, $, on, fmtNum, fmtBytes, fmtCompact, plural, debounce, emptyState, errorState } from "../util.js";
import { icon } from "../icons.js";
import { get } from "../api.js";
import { sparkline, lineChart } from "../charts.js";
import { jobItem, activityItem, bindJobClicks } from "../components.js";

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

export default async function dashboard(ctx) {
  const { root, state } = ctx;
  ctx.crumbs([{ label: "Dashboard" }]);
  mount(root, skeleton(state.me?.name));

  let range = "24h", metric = "requests", compare = false;
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
  const totalReq = reqVals.reduce((a, b) => a + b, 0);
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
          <div class="tagline">${allOk ? "All systems operational" : "Some services need attention"} · ${plural(c.projects || 0, "project")} · ${running ? `${running} job${running > 1 ? "s" : ""} running` : "no jobs running"}</div>
        </div>
      </section>
      <div class="stat-row">
        ${stat({ href: "#/sites", label: "Websites", icon: "globe", color: "#c6f36b", spark: sparkline(reqVals, { color: "#c6f36b" }), cap: html`${fmtNum(c.sitesLoadBalanced || 0)} load balanced`, big: fmtNum(c.sites || 0) })}
        ${stat({ href: "#/databases", label: "Databases", icon: "database", color: "#33d4c1", spark: sparkline(dbSizes.length > 1 ? dbSizes : [0, 0], { color: "#33d4c1" }), cap: html`${fmtBytes(dbSizes.reduce((a, b) => a + b, 0))} stored`, big: fmtNum(c.databases || 0) })}
        ${stat({ href: "#/servers", label: "Servers", icon: "server", color: "#6d8dff", spark: sparkline(cpuVals, { color: "#6d8dff" }), cap: c.serversOnline === c.servers ? "All online" : `${fmtNum((c.servers || 0) - (c.serversOnline || 0))} offline`, big: html`${fmtNum(c.serversOnline || 0)}<small> / ${fmtNum(c.servers || 0)}</small>` })}
        ${stat({ href: "#/backups", label: "Backups", icon: "archive", color: "#9d7dff", spark: sparkline(perDay, { color: "#9d7dff" }), cap: html`${fmtBytes(c.backupsSize || 0)} total`, big: fmtNum(c.backups || 0) })}
      </div>
    </div>

    <section class="section">
      <div class="section-head">
        <div><h2>Traffic overview</h2><p>Requests through the front door and average CPU across your servers.</p></div>
      </div>
      <div class="card chart-card">
        <div class="chart-toolbar">
          <div class="pills" data-metric>
            <button class="pill active" data-m="requests">${icon("globe", "sm")}Requests</button>
            <button class="pill" data-m="cpu">${icon("cpu", "sm")}CPU load</button>
          </div>
          <div class="row wrap">
            <div class="seg" data-range>${["1h", "24h"].map((r) => html`<button class="${r === range ? "active" : ""}" data-r="${r}">${r}</button>`)}</div>
            <button class="btn btn-sm" data-compare>${icon("compare")}Compare</button>
          </div>
        </div>
        <div class="row" style="justify-content:space-between;align-items:flex-end;margin:6px 0 4px;flex-wrap:wrap;gap:10px">
          <div><div class="muted small" data-kpi-l>Requests · last 24h</div><div style="font-size:26px;font-weight:750;letter-spacing:-.03em" data-kpi>${fmtCompact(totalReq)}</div></div>
          <div class="chart-legend" data-legend></div>
        </div>
        <div class="chart" data-chart></div>
      </div>
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

  const jobsEl = $("[data-jobs]", root), actEl = $("[data-activity]", root);
  let jobs = data.recentJobs || [], acts = data.recentActivity || [];
  const paintJobs = () => mount(jobsEl, jobs.length ? html`${jobs.slice(0, 7).map(jobItem)}` : emptyState({ ico: "rocket", title: "No jobs yet", text: "Deploys, backups and certificate requests show up here.", sm: true }));
  const paintActs = () => mount(actEl, acts.length ? html`${acts.slice(0, 7).map((a) => activityItem(a, { compact: true }))}` : emptyState({ ico: "activity", title: "Nothing yet", text: "Changes made by admins appear here.", sm: true }));
  paintJobs(); paintActs();
  bindJobClicks(jobsEl);

  // chart
  const chartEl = $("[data-chart]", root);
  const COLORS = { requests: ["#c6f36b", "#6d8dff", "#9d7dff"], cpu: ["#33d4c1", "#6d8dff", "#9d7dff"] };
  const build = () => {
    const req = (data.series?.requests || []).map((p) => ({ t: p.t, v: p.count }));
    const cpu = (data.series?.cpu || []).map((p) => ({ t: p.t, v: p.value }));
    const main = metric === "requests"
      ? { name: "Requests", color: "#8aa4ff", gradient: COLORS.requests, areaColor: "#5a7dff", points: req, fmt: (v) => fmtNum(Math.round(v)) }
      : { name: "CPU", color: "#33d4c1", gradient: COLORS.cpu, areaColor: "#33d4c1", points: cpu, fmt: (v) => `${(+v).toFixed(1)}%` };
    const other = metric === "requests"
      ? { name: "CPU", color: "#ffb547", points: cpu, dashed: true, ownScale: true, fmt: (v) => `${(+v).toFixed(1)}%` }
      : { name: "Requests", color: "#ffb547", points: req, dashed: true, ownScale: true, fmt: (v) => fmtNum(Math.round(v)) };
    const series = compare ? [main, other] : [main];
    const total = metric === "requests" ? req.reduce((a, b) => a + b.v, 0) : cpu.length ? cpu.reduce((a, b) => a + b.v, 0) / cpu.length : 0;
    $("[data-kpi]", root).textContent = metric === "requests" ? fmtCompact(total) : `${total.toFixed(1)}%`;
    $("[data-kpi-l]", root).textContent = `${metric === "requests" ? "Requests" : "Average CPU"} · last ${range}`;
    mount($("[data-legend]", root), html`<span><i style="background:linear-gradient(90deg,${main.gradient[0]},${main.gradient[2]})"></i>${main.name}</span>${compare ? html`<span style="color:${other.color}"><i class="dashed"></i><span style="color:var(--muted)">${other.name} (own scale)</span></span>` : ""}`);
    return { series, range, fmt: metric === "requests" ? fmtCompact : (v) => `${Math.round(v)}%`, yMax: metric === "cpu" ? 100 : undefined, empty: "No traffic recorded yet", aria: `${main.name} over the last ${range}` };
  };
  const chart = lineChart(chartEl, build());
  ctx.cleanup(() => chart.destroy());

  on(root, "click", "[data-m]", (e, b) => {
    metric = b.dataset.m;
    root.querySelectorAll("[data-m]").forEach((x) => x.classList.toggle("active", x === b));
    chart.update(build());
  });
  on(root, "click", "[data-r]", async (e, b) => {
    range = b.dataset.r;
    root.querySelectorAll("[data-r]").forEach((x) => x.classList.toggle("active", x === b));
    chartEl.style.opacity = ".5";
    try { data = { ...data, series: (await get(`/api/dashboard?range=${range}`)).series }; chart.update(build()); } catch {}
    chartEl.style.opacity = "";
  });
  on(root, "click", "[data-compare]", (e, b) => {
    compare = !compare;
    b.classList.toggle("btn-primary", compare);
    chart.update(build());
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
