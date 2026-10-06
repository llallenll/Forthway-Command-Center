// "Resource usage" card on the website Traffic tab: CPU, memory and disk of the website's app (panel/lib/usage.mjs).
// Data: GET /api/sites/:id/usage?range=1h|24h|7d|30d — sampled every minute on each server that runs the website.
import { html, mount, $, on, fmtBytes, ago, plural } from "../util.js";
import { icon } from "../icons.js";
import { get } from "../api.js";
import { lineChart } from "../charts.js";

const RANGE_TEXT = { "1h": "last hour", "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days" };
const METRICS = {
  cpu: { label: "CPU", name: "CPU", color: "#33d4c1", gradient: ["#33d4c1", "#6d8dff", "#9d7dff"] },
  mem: { label: "Memory", name: "Memory", color: "#8aa4ff", gradient: ["#6d8dff", "#8aa4ff", "#9d7dff"] },
};
const fmtCpu = (v) => (v == null ? "—" : `${v >= 100 ? Math.round(v) : (+v).toFixed(1).replace(/\.0$/, "")}%`);
const SOURCE_TEXT = { pm2: "pm2 process", systemd: "systemd unit", port: "process on its port" };

function niceMax(v) {
  if (v <= 0) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((n) => v / e <= n) * e;
}

/**
 * Mount the usage card into `el`. opts: { ctx, siteId, range?, refreshMs? }
 * Returns { setRange(range) } so the Traffic card's range buttons drive it too.
 */
export function usageCard(el, { ctx, siteId, range = "24h", refreshMs = 60_000 } = {}) {
  let metric = "cpu", data = null;
  mount(el, html`<div class="card chart-card">
    <div class="chart-toolbar">
      <div><h3 style="margin:0">Resource usage</h3><div class="muted small" data-note>Loading…</div></div>
      <span data-badge></span>
    </div>
    <div class="tr-kpis" data-kpis></div>
    <div class="chart" data-chart></div>
    <div data-servers></div>
    <p class="hint mt-16" data-hint></p>
  </div>`);
  const chartEl = $("[data-chart]", el);
  const chart = lineChart(chartEl, { series: [], empty: "Loading…" });
  ctx?.cleanup?.(() => chart.destroy());

  const kpi = (k, value, sub, { clickable = true } = {}) => {
    const m = METRICS[k] || { label: "Disk", color: "#ffb547" };
    const inner = html`<div class="tr-kpi-l"><i></i>${m.label}</div><div class="tr-kpi-v"><span>${value}</span></div><div class="muted small" style="margin-top:2px">${sub}</div>`;
    return clickable
      ? html`<button class="tr-kpi ${metric === k ? "active" : ""}" data-m="${k}" style="--c:${m.color}">${inner}</button>`
      : html`<div class="tr-kpi" style="--c:${m.color};cursor:default">${inner}</div>`;
  };

  const paint = () => {
    const d = data;
    if (!d) return;
    const shared = d.type !== "node";
    const multi = d.servers.length > 1;
    const where = multi ? `across ${plural(d.servers.length, "server")}` : `on ${d.servers[0]?.name || "its server"}`;
    $("[data-note]", el).textContent = shared
      ? `Disk used by this website ${where}`
      : `This website's app processes ${where} · ${RANGE_TEXT[d.range]}`;
    mount($("[data-badge]", el), d.simulated ? html`<span class="badge">${icon("info")}Dry run — simulated</span>` : html``);

    const c = d.current;
    const diskSub = d.servers.find((s) => s.diskAt) ? `measured ${ago(d.servers.map((s) => s.diskAt).filter(Boolean).sort().pop())}` : "measuring…";
    mount($("[data-kpis]", el), shared
      ? html`${kpi("disk", fmtBytes(c.disk), diskSub, { clickable: false })}`
      : html`${kpi("cpu", fmtCpu(c.cpu), `avg ${fmtCpu(d.avg.cpu)} · peak ${fmtCpu(d.peak.cpu)}`)}
          ${kpi("mem", c.mem == null ? "—" : fmtBytes(c.mem), `avg ${fmtBytes(d.avg.mem)} · peak ${fmtBytes(d.peak.mem)}`)}
          ${kpi("disk", fmtBytes(c.disk), diskSub, { clickable: false })}`);
    $("[data-kpis]", el).style.gridTemplateColumns = shared ? "minmax(0, 1fr)" : "";

    chartEl.hidden = shared;
    if (!shared) {
      const m = METRICS[metric];
      const points = d.series.filter((p) => p[metric] != null).map((p) => ({ t: p.t, v: p[metric] }));
      const isCpu = metric === "cpu";
      chart.update({
        series: points.length ? [{ name: m.name, color: m.color, gradient: m.gradient, areaColor: m.color, points, fmt: isCpu ? fmtCpu : (v) => fmtBytes(v) }] : [],
        range: d.range,
        fmt: isCpu ? (v) => `${Math.round(v)}%` : (v) => fmtBytes(v, 0),
        yMax: niceMax(Math.max(isCpu ? 5 : 64 * 1024 * 1024, ...points.map((p) => p.v)) * 1.12),
        empty: c.procs === 0 ? "The app isn't running" : "No samples yet — the first one arrives within a minute",
        aria: `${m.name} over the ${RANGE_TEXT[d.range]}`,
      });
    }

    mount($("[data-servers]", el), multi || d.servers.some((s) => s.error || s.stale) ? html`<div class="table-wrap mt-16"><table class="table">
      <thead><tr><th>Server</th>${shared ? "" : html`<th>CPU</th><th>Memory</th><th class="hide-sm">Processes</th>`}<th>Disk</th></tr></thead><tbody>
      ${d.servers.map((s) => html`<tr>
        <td><b>${s.name}</b>${s.error ? html`<div class="small" style="color:#ff8ea3">${s.error}</div>` : s.stale ? html`<div class="muted small">No sample since ${ago(s.at)}${s.online === false ? " — server offline" : ""}</div>` : ""}</td>
        ${shared ? "" : html`<td class="mono">${fmtCpu(s.cpu)}</td><td class="mono">${s.mem == null ? "—" : fmtBytes(s.mem)}</td>
          <td class="hide-sm muted">${s.procs == null ? "—" : s.procs === 0 ? "not running" : `${s.procs} · ${SOURCE_TEXT[s.source] || s.source}`}</td>`}
        <td class="mono">${fmtBytes(s.disk)}</td></tr>`)}
      </tbody></table></div>` : html``);

    const cores = d.servers.map((s) => s.cores).filter(Boolean);
    mount($("[data-hint]", el), shared
      ? html`${icon("info", "xs")} ${d.type === "php" ? "PHP" : "Static"} websites are served by nginx${d.type === "php" ? " and php-fpm" : ""}, which every website on the server shares — so there's no CPU or memory to show for this one alone. Disk is the size of the app folder, checked every 15 minutes.`
      : html`${icon("info", "xs")} Sampled every minute. CPU is in percent of one core (100% = a full core${cores.length === 1 ? `; ${d.servers[0].name} has ${cores[0]}` : ""}). Memory is what the app's processes and their children hold in RAM. Disk is the app folder, checked every 15 minutes.`);
  };

  let seq = 0;
  async function load({ quiet = false } = {}) {
    const my = ++seq;
    if (!quiet) chartEl.style.opacity = ".5";
    try {
      const d = await get(`/api/sites/${encodeURIComponent(siteId)}/usage?range=${range}`);
      if (my !== seq || (ctx && !ctx.alive())) return;
      data = d;
      paint();
    } catch (e) {
      if (my !== seq) return;
      if (!data) {
        $("[data-note]", el).textContent = e?.status === 404 ? "Resource usage isn't available on this panel" : "Couldn't load resource usage";
        chart.update({ series: [], empty: "—" });
      }
    } finally {
      if (my === seq) chartEl.style.opacity = "";
    }
  }

  on(el, "click", "[data-m]", (e, b) => {
    metric = b.dataset.m;
    paint();
  });

  load();
  if (refreshMs) {
    const t = setInterval(() => { if (!ctx || ctx.alive()) load({ quiet: true }); }, refreshMs);
    ctx?.cleanup?.(() => clearInterval(t));
  }
  return {
    setRange(r) {
      if (!r || r === range) return;
      range = r;
      load();
    },
  };
}
