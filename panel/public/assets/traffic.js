// Traffic card (unique visitors · page views · requests) used by the dashboard and the website "Traffic" tab.
// Data: GET /api/analytics?range=1h|24h|7d|30d[&siteId=] (panel/lib/analytics.mjs).
import { html, mount, $, on, fmtNum, fmtCompact, fmtDate } from "./util.js";
import { icon } from "./icons.js";
import { get } from "./api.js";
import { lineChart } from "./charts.js";

export const RANGES = ["1h", "24h", "7d", "30d"];
const RANGE_TEXT = { "1h": "last hour", "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days" };
const PREV_TEXT = { "1h": "previous hour", "24h": "previous 24 hours", "7d": "previous 7 days", "30d": "previous 30 days" };

const METRICS = {
  uniques: { tab: "Visitors", label: "Unique visitors", name: "Visitors", ico: "users", color: "#c6f36b", gradient: ["#c6f36b", "#6d8dff", "#9d7dff"], area: "#5a7dff" },
  pageViews: { tab: "Page views", label: "Page views", name: "Page views", ico: "eye", color: "#33d4c1", gradient: ["#33d4c1", "#6d8dff", "#9d7dff"], area: "#33d4c1" },
  requests: { tab: "Requests", label: "Requests", name: "Requests", ico: "globe", color: "#8aa4ff", gradient: ["#6d8dff", "#8aa4ff", "#9d7dff"], area: "#5a7dff" },
};

function niceMax(v) {
  if (v <= 0) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / e;
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((n) => f <= n) * e;
}

export const analyticsUrl = (range, siteId) => `/api/analytics?range=${range}${siteId ? `&siteId=${encodeURIComponent(siteId)}` : ""}`;

function delta(ch, prevText) {
  if (ch == null) return html`<span class="tr-delta" title="Nothing to compare with in the ${prevText}">—</span>`;
  const tone = ch > 0 ? "up" : ch < 0 ? "down" : "flat";
  const v = Math.abs(ch) >= 100 ? Math.round(Math.abs(ch)) : Math.abs(ch).toFixed(1).replace(/\.0$/, "");
  return html`<span class="tr-delta ${tone}" title="vs the ${prevText}">${tone === "up" ? icon("arrowUp", "xs") : tone === "down" ? icon("arrowDown", "xs") : ""}${v}%</span>`;
}

/**
 * Mount the traffic card into `el`.
 * opts: { ctx, siteId?, range?, cpu?: (range) => Promise<[{t, value}]> (adds a "CPU load" tab), refreshMs?, onData?(data) }
 */
export function trafficCard(el, { ctx, siteId = null, range = "24h", cpu = null, refreshMs = 60_000, onData = null } = {}) {
  let metric = "uniques", compare = false, data = null, cpuPts = [];
  mount(el, html`<div class="card chart-card">
    <div class="chart-toolbar">
      <div class="pills" data-metric>
        ${Object.entries(METRICS).map(([k, m]) => html`<button class="pill ${k === metric ? "active" : ""}" data-m="${k}">${icon(m.ico, "sm")}${m.tab}</button>`)}
        ${cpu ? html`<button class="pill" data-m="cpu">${icon("cpu", "sm")}CPU load</button>` : ""}
      </div>
      <div class="row wrap">
        <div class="seg" data-range>${RANGES.map((r) => html`<button class="${r === range ? "active" : ""}" data-r="${r}">${r}</button>`)}</div>
        <button class="btn btn-sm" data-compare title="Overlay the previous period">${icon("compare")}Compare</button>
      </div>
    </div>
    <div class="tr-kpis" data-kpis></div>
    <div class="row tr-sub"><div class="muted small" data-note></div><div class="chart-legend" data-legend></div></div>
    <div class="chart" data-chart></div>
  </div>`);
  const chartEl = $("[data-chart]", el);

  const paintKpis = () => {
    const T = data?.totals || {}, C = data?.change || {};
    const daily = data?.uniquesMethod === "daily-sum";
    const kpi = (k, hint) => html`<button class="tr-kpi ${metric === k ? "active" : ""}" data-m="${k}" style="--c:${METRICS[k].color}">
      <div class="tr-kpi-l"><i></i>${METRICS[k].label}${hint ? html`<span class="dim" title="${hint}"> · per day</span>` : ""}</div>
      <div class="tr-kpi-v"><span>${fmtCompact(T[k] ?? 0)}</span>${delta(C[k], PREV_TEXT[range])}</div></button>`;
    mount($("[data-kpis]", el), html`${kpi("uniques", daily ? "Visitor ids rotate daily, so this is the sum of each day's unique visitors" : "")}${kpi("pageViews")}${kpi("requests")}`);
    const since = data?.visitorsSince || data?.since;
    const fresh = since && +new Date(since) > (data?.from ?? 0);
    let note = `${RANGE_TEXT[range][0].toUpperCase()}${RANGE_TEXT[range].slice(1)} · compared with the ${PREV_TEXT[range]}`;
    if (!data?.visitorsSince) note = since ? `Collecting since ${fmtDate(since)} — visitors and page views appear as people load your websites` : "Collecting visitor data…";
    else if (fresh) note = `Visitors and page views are counted since ${fmtDate(data.visitorsSince)}`;
    if (metric === "cpu" && (range === "7d" || range === "30d")) note = "CPU history covers the last 24 hours";
    $("[data-note]", el).textContent = note;
  };

  const build = () => {
    const shiftDay = data?.step >= 864e5 ? 432e5 : 0; // daily points at noon UTC so the date label matches the UTC day
    const pts = (rows, k) => (rows || []).map((p) => ({ t: p.t + shiftDay, v: p[k] }));
    const fmtInt = (v) => fmtNum(Math.round(v));
    let series, yMax, fmt = fmtCompact, legend;
    if (metric === "cpu") {
      const main = { name: "CPU", color: "#33d4c1", gradient: ["#33d4c1", "#6d8dff", "#9d7dff"], areaColor: "#33d4c1", points: cpuPts.map((p) => ({ t: p.t, v: p.value })), fmt: (v) => `${(+v).toFixed(1)}%` };
      series = [main];
      yMax = 100;
      fmt = (v) => `${Math.round(v)}%`;
      legend = html`<span><i style="background:linear-gradient(90deg,#33d4c1,#9d7dff)"></i>CPU (main server)</span>`;
    } else {
      const m = METRICS[metric];
      const main = { name: m.name, color: m.color, gradient: m.gradient, areaColor: m.area, points: pts(data?.series, metric), fmt: fmtInt };
      series = [main];
      if (metric === "uniques") series.push({ name: "Page views", color: "#33d4c1", gradient: ["#33d4c1", "#33d4c1"], points: pts(data?.series, "pageViews"), fmt: fmtInt });
      if (compare) series.push({ name: `${m.name}, ${PREV_TEXT[range]}`, color: "#ffb547", gradient: ["#ffb547", "#ffb547"], points: pts(data?.previousSeries, metric), dashed: true, fmt: fmtInt });
      yMax = niceMax(Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.v || 0))) * 1.12);
      legend = html`<span><i style="background:linear-gradient(90deg,${m.gradient[0]},${m.gradient[2]})"></i>${m.name}</span>
        ${metric === "uniques" ? html`<span><i style="background:#33d4c1"></i>Page views</span>` : ""}
        ${compare ? html`<span style="color:#ffb547"><i class="dashed"></i><span style="color:var(--muted)">Previous period</span></span>` : ""}`;
    }
    mount($("[data-legend]", el), legend);
    paintKpis();
    const any = data && series[0].points.some((p) => p.v);
    return {
      series: metric === "cpu" || any || (data?.totals?.requests ?? 0) > 0 ? series : [],
      range: metric === "cpu" ? "24h" : range,
      fmt, yMax,
      empty: data?.visitorsSince || metric === "requests" ? "No traffic in this period" : "No visitors recorded yet",
      aria: `${metric === "cpu" ? "CPU" : METRICS[metric].name} over the ${RANGE_TEXT[range]}`,
    };
  };

  const chart = lineChart(chartEl, { series: [], empty: "Loading…" });
  ctx?.cleanup?.(() => chart.destroy());

  let seq = 0;
  async function load({ quiet = false } = {}) {
    const my = ++seq;
    if (!quiet) chartEl.style.opacity = ".5";
    try {
      const [d, c] = await Promise.all([get(analyticsUrl(range, siteId)), cpu && metric === "cpu" ? cpu(range === "1h" ? "1h" : "24h").catch(() => cpuPts) : Promise.resolve(cpuPts)]);
      if (my !== seq || (ctx && !ctx.alive())) return;
      data = d;
      cpuPts = c || [];
      chart.update(build());
      onData?.(data);
    } catch (e) {
      if (my !== seq) return;
      if (!data) chart.update({ series: [], empty: e?.status === 404 ? "Traffic analytics are not available on this panel" : "Couldn't load traffic data" });
    } finally {
      if (my === seq) chartEl.style.opacity = "";
    }
  }

  on(el, "click", "[data-m]", (e, b) => {
    metric = b.dataset.m;
    el.querySelectorAll(".pill[data-m]").forEach((x) => x.classList.toggle("active", x.dataset.m === metric));
    if (metric === "cpu" && cpu) load();
    else chart.update(build());
  });
  on(el, "click", "[data-r]", (e, b) => {
    range = b.dataset.r;
    el.querySelectorAll("[data-r]").forEach((x) => x.classList.toggle("active", x === b));
    load();
  });
  on(el, "click", "[data-compare]", (e, b) => {
    compare = !compare;
    b.classList.toggle("btn-primary", compare);
    chart.update(build());
  });

  load();
  if (refreshMs) {
    const t = setInterval(() => { if (!ctx || ctx.alive()) load({ quiet: true }); }, refreshMs);
    ctx?.cleanup?.(() => clearInterval(t));
  }
  return { reload: load, get data() { return data; }, get range() { return range; } };
}

/** "Top pages" / "Top referrers" list card body (Safe html). rows: [{ name, n, href? }] */
export function topList(rows, { empty, unit }) {
  if (!rows?.length) return html`<div class="tr-empty muted small">${empty}</div>`;
  const max = Math.max(...rows.map((r) => r.n)) || 1;
  return html`<div class="tr-list">${rows.map((r) => html`<div class="tr-row" title="${r.name} · ${fmtNum(r.n)} ${unit}">
    <span class="tr-bar" style="width:${((r.n / max) * 100).toFixed(1)}%"></span>
    <span class="tr-name mono">${r.name}</span><span class="tr-n">${fmtCompact(r.n)}</span></div>`)}</div>`;
}
