// Website "Statistics" tab — traffic and uptime on one page (replaces the old Traffic and Uptime tabs).
//   top:     health + uptime + response time + visitors at a glance
//   charts:  traffic (panel/lib/analytics.mjs), response time (panel/lib/monitor.mjs), resource usage (panel/lib/usage.mjs),
//            top pages and referrers
//   bottom:  Checks (Edit → check settings modal) and Incidents (Alert settings → text + Discord modal), views/monitor.js
// One range control (the traffic card's) drives every chart on the page.
import { html, raw, mount, $, $$, on, ago, fmtDate, fmtDuration, fmtCompact, plural, toast, toastError, confirmDialog, debounce, emptyState, skeletonRows } from "../util.js";
import { icon } from "../icons.js";
import { get, post } from "../api.js";
import { lineChart } from "../charts.js";
import { trafficCard, topList } from "../traffic.js";
import { usageCard } from "./site-usage.js";
import { moreList } from "../fold.js";
import { monitorState, fmtUptime, uptimeStrip, hourLabels, incidentItem, intervalLabel, smsState, discordState, checkSettingsModal, alertSettingsModal } from "./monitor.js";

const RANGE_TEXT = { "1h": "last hour", "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days" };

export async function statisticsTab(ctx, box, S) {
  mount(box, html`<div class="mini-stats">${[1, 2, 3, 4].map(() => html`<div class="skel" style="height:84px;border-radius:16px"></div>`)}</div>${skeletonRows(3, 90)}`);
  let range = "24h", D = null, monErr = null, traffic = null, rtChart = null;
  const loadMon = async () => { D = await get(`/api/sites/${S.id}/monitor?range=${range}`); monErr = null; return D; };
  try { await loadMon(); } catch (e) { monErr = e; }
  if (!ctx.alive()) return;

  mount(box, html`<div data-st-notes></div>
    <div class="mini-stats" data-st-kpis></div>
    <div data-traffic></div>
    <div class="card chart-card st-rt mt-20"><div class="chart-toolbar"><div><h3 style="margin:0">Response time</h3><div class="muted small" data-rt-sub>—</div></div><span class="badge" data-rt-range></span></div>
      <div class="chart" data-rt-chart></div></div>
    <div class="mt-20" data-usage></div>
    <div class="grid-2 mt-20">
      <div class="card"><div class="card-head"><h3>Top pages</h3><span class="sub" data-tp-sub>page views</span></div><div class="card-body" data-pages></div></div>
      <div class="card"><div class="card-head"><h3>Top referrers</h3><span class="sub" data-tr-sub>visits from other sites</span></div><div class="card-body" data-refs></div></div>
    </div>
    <div class="st-sec-head"><h2>Uptime</h2><p>Checked from this panel. Changes to how it checks and who gets alerts are in the two buttons below.</p></div>
    <div class="card" data-st-checks></div>
    <div class="card mt-20" data-st-inc></div>
    <p class="hint mt-16">${icon("info", "xs")} Visitors are counted from the front door's access log — no cookies or scripts on your site. They're identified by a daily-rotating
      hash of IP address and browser; raw IP addresses are never stored. Bots, assets, API calls and health checks are left out of visitors and page views.</p>`);

  /* ── top: notes + headline numbers ── */
  let tData = null;
  const paintNotes = () => {
    const m = D?.summary;
    mount($("[data-st-notes]", box), !m ? html`` : html`
      ${m.paused ? html`<div class="note warn" style="margin-bottom:14px;align-items:center">${icon("info")}<div style="flex:1">Monitoring is paused${m.since ? ` since ${fmtDate(m.since)}` : ""}${m.pauseUntil ? ` until ${fmtDate(m.pauseUntil)}` : ""}${D.settings.pausedBy ? ` by ${D.settings.pausedBy}` : ""} — no checks and no alerts.</div><button class="btn btn-sm" data-resume>${icon("play")}Resume</button></div>` : ""}
      ${m.state === "pending" ? html`<div class="note" style="margin-bottom:14px">${icon("info")}<div>Uptime checks start after the first deploy (or set a custom URL under Checks → Edit).</div></div>` : ""}`);
  };
  const paintKpis = () => {
    const m = D?.summary, st = monitorState(m), u = m?.uptime || {}, lc = m?.lastCheck;
    const T = tData?.totals;
    mount($("[data-st-kpis]", box), html`
      <div class="mini-stat"><div class="ms-l">${icon("activity", "xs")}Status</div><div class="ms-v row" style="gap:9px"><span class="dot ${st.tone}"></span>${m ? st.text : "Not monitored"}</div>
        <div class="ms-s">${!m ? "Uptime monitoring isn't available" : html`${m.since && (m.state === "up" || m.state === "down") ? html`for ${ago(m.since).replace(" ago", "")}` : ""}${lc ? html`${m.since && (m.state === "up" || m.state === "down") ? " · " : ""}checked ${ago(lc.at)}` : ""}`}</div></div>
      <div class="mini-stat"><div class="ms-l">${icon("check", "xs")}Uptime 24h</div><div class="ms-v">${fmtUptime(u.h24)}</div><div class="ms-s">7 days ${fmtUptime(u.d7)} · 30 days ${fmtUptime(u.d30)}</div></div>
      <div class="mini-stat"><div class="ms-l">${icon("gauge", "xs")}Response time</div><div class="ms-v">${m?.avgMs24h != null ? `${m.avgMs24h} ms` : "—"}</div>
        <div class="ms-s">${lc ? (lc.ok ? `last ${lc.ms} ms · HTTP ${lc.status}` : html`<span style="color:#ff8ea3">${lc.error}</span>`) : "24h average"}</div></div>
      <div class="mini-stat"><div class="ms-l">${icon("users", "xs")}Visitors</div><div class="ms-v">${T ? fmtCompact(T.uniques ?? 0) : "—"}</div>
        <div class="ms-s">${T ? `${fmtCompact(T.pageViews ?? 0)} page views · ${RANGE_TEXT[tData.range] || ""}` : "Loading…"}</div></div>`);
  };

  /* ── charts ── */
  const paintRt = () => {
    const el = $("[data-rt-chart]", box);
    const pts = (D?.series?.points || []).filter((p) => p.ms != null).map((p) => ({ t: p.t, v: p.ms }));
    const avg = pts.length ? Math.round(pts.reduce((a, p) => a + p.v, 0) / pts.length) : null;
    $("[data-rt-sub]", box).textContent = D ? `${avg != null ? `${avg} ms average` : "No data"} · time to first byte from this panel` : "Uptime monitoring isn't available";
    $("[data-rt-range]", box).textContent = RANGE_TEXT[range] || range;
    const data = { series: [{ name: "Response time", color: "#33d4c1", gradient: ["#33d4c1", "#6d8dff"], areaColor: "#33d4c1", points: pts, fmt: (v) => `${Math.round(v)} ms` }], range, fmt: (v) => `${Math.round(v)} ms`, empty: D ? "No successful checks in this period" : "—", aria: `Response time over the ${RANGE_TEXT[range]}` };
    if (!rtChart) { rtChart = lineChart(el, data); ctx.cleanup(() => rtChart.destroy()); } else rtChart.update(data);
  };
  const paintTops = () => {
    const d = tData;
    if (!d) return;
    const rt = RANGE_TEXT[d.range] || "";
    $("[data-tp-sub]", box).textContent = `page views · ${rt}`;
    $("[data-tr-sub]", box).textContent = `visits from other sites · ${rt}`;
    mount($("[data-pages]", box), topList((d.topPages || []).map((p) => ({ name: p.path, n: p.views })), { empty: "No page views in this period yet.", unit: "page views" }));
    mount($("[data-refs]", box), topList((d.topReferrers || []).map((r) => ({ name: r.host, n: r.visits })), { empty: "No visits from other websites in this period.", unit: "visits" }));
  };
  const usage = usageCard($("[data-usage]", box), { ctx, siteId: S.id });
  traffic = trafficCard($("[data-traffic]", box), { ctx, siteId: S.id, onData: (d) => {
    tData = d;
    paintKpis(); paintTops();
    usage.setRange(d.range);
    if (d.range && d.range !== range) { range = d.range; if (D) loadMon().then(() => ctx.alive() && paintRt()).catch(() => {}); }
  } });

  /* ── Checks ── */
  const paintChecks = () => {
    const el = $("[data-st-checks]", box);
    if (!D) {
      mount(el, html`<div class="card-head"><h3>Checks</h3></div>${emptyState({ ico: "activity", title: "Uptime monitoring isn't available", text: monErr?.message || "", sm: true })}`);
      return;
    }
    const m = D.summary, s = D.settings, servers = m.servers || [];
    const days = D.days || [];
    const withData = days.filter((d) => d.uptime != null);
    mount(el, html`<div class="card-head st-head">
        <div class="st-head-t"><h3>Checks</h3><div class="sub">${D.effective.url ? html`<span class="mono">GET ${D.effective.url}</span>` : "No address to check yet"}</div></div>
        <div class="right btn-row">
          ${m.paused ? html`<button class="btn btn-sm" data-resume>${icon("play")}Resume</button>`
            : html`<button class="btn btn-sm" data-check ${m.state === "pending" ? raw("disabled") : ""}>${icon("refresh")}<span class="hide-sm">Check now</span></button><button class="btn btn-sm" data-pause>${icon("stop")}<span class="hide-sm">Pause</span></button>`}
          <button class="btn btn-sm btn-primary" data-editchk>${icon("edit")}Edit</button></div></div>
      <div class="card-body">
        <div class="st-facts">
          <div><span>Every</span><b>${intervalLabel(s.intervalSec)}</b></div>
          <div><span>Timeout</span><b>${s.timeoutSec} s</b></div>
          <div><span>Expects</span><b class="mono">${s.expectMin === s.expectMax ? s.expectMin : `${s.expectMin}–${s.expectMax}`}</b></div>
          <div><span>Down after</span><b>${plural(s.failThreshold, "failure")}</b></div>
        </div>
        <div class="st-strip"><div class="st-strip-l"><span>Last 24 hours</span><span class="muted">${fmtUptime(m.uptime?.h24)}</span></div>
          ${uptimeStrip(m.bars24h || [], { labels: hourLabels(m.bars24hStart, (m.bars24h || []).length) })}</div>
        <div class="st-strip"><div class="st-strip-l"><span>Last 90 days</span><span class="muted">${fmtUptime(m.uptime?.d90)} · ${withData.length ? plural(days.reduce((a, d) => a + (d.downMinutes || 0), 0), "minute") + " down" : "no data yet"}</span></div>
          ${uptimeStrip(days.map((d) => (d.uptime == null ? (d.pausedMinutes ? -1 : null) : d.uptime / 100)), { cls: "big", labels: days.map((d) => `${d.day}${d.downMinutes ? ` · ${d.downMinutes} min down` : ""}${d.avgMs != null ? ` · ${d.avgMs} ms` : ""}`) })}
          <div class="up-legend"><span>90 days ago</span><span class="row" style="gap:12px;flex-wrap:wrap"><span><i class="up-b ok"></i>Up</span><span><i class="up-b warn"></i>Partial</span><span><i class="up-b err"></i>Down</span><span><i class="up-b none"></i>No data</span></span><span>Today</span></div></div>
        ${servers.length ? html`<div class="st-servers"><span class="muted small">${servers.length > 1 ? "Servers" : "Server"}</span>${servers.map((x) => html`<span class="status" title="${x.error || ""}"><span class="dot ${x.down || x.healthy === false ? "err" : !x.online ? "off" : x.healthy ? "ok" : "off"}"></span>${x.name}<span class="muted small">${x.down || x.healthy === false ? " unhealthy" : !x.online ? " offline" : x.healthy ? " healthy" : " not checked"}</span></span>`)}</div>` : ""}
      </div>`);
  };

  /* ── Incidents ── */
  const paintIncidents = () => {
    const el = $("[data-st-inc]", box);
    if (!D) { mount(el, html`<div class="card-head"><h3>Incidents</h3></div>${emptyState({ ico: "check", title: "No incidents", text: "Uptime monitoring isn't available on this panel.", sm: true })}`); return; }
    const opened = new Set($$("details.inc[open]", el).map((d) => d.dataset.inc)); // keep expanded logs open across live refreshes
    const inc = D.incidents || [];
    const gaps = (D.gaps || []).filter((g) => !inc.some((i) => (i.gaps || []).some((x) => x.from === g.from)));
    const sms = smsState(D), dsc = discordState(D);
    mount(el, html`<div class="card-head st-head">
        <div class="st-head-t"><h3>Incidents</h3><div class="sub st-alerts">
          <span class="st-al ${sms.tone}" title="Text messages">${icon("message", "xs")}${sms.text}</span>
          <span class="st-al ${dsc.tone}" title="Discord">${icon("discord", "xs")}${dsc.text}</span></div></div>
        <div class="right"><button class="btn btn-sm btn-primary" data-editalerts>${icon("bell")}Alert settings</button></div></div>
      <div class="list" data-inc-list>${inc.length || gaps.length ? html`${moreList(inc, incidentItem, { id: "site.incidents", limit: 5, noun: "incidents" })}${gaps.slice(0, 3).map((g) => html`<div class="list-item"><span class="li-ico">${icon("power", "sm")}</span><div class="li-main"><div class="li-title">No data for ${fmtDuration(Date.parse(g.to) - Date.parse(g.from))}</div><div class="li-sub">${fmtDate(g.from)} → ${fmtDate(g.to)} · the panel was not running, so nothing was checked</div></div></div>`)}`
        : emptyState({ ico: "check", title: "No incidents", text: "Outages show up here with every alert (text or Discord post) sent about them.", sm: true })}</div>`);
    $$("details.inc", el).forEach((d) => { if (opened.has(d.dataset.inc)) d.open = true; });
  };

  const paintMon = () => { paintNotes(); paintKpis(); paintRt(); paintChecks(); paintIncidents(); };
  paintMon();
  const refresh = debounce(async () => { try { await loadMon(); if (ctx.alive()) paintMon(); } catch {} }, 400);
  const afterSave = (r) => { if (!r) return; if (r.settings) D.settings = r.settings; if (r.summary) D.summary = r.summary; if (r.recipients) D.recipients = r.recipients; paintMon(); refresh(); };

  on(box, "click", "[data-editchk]", async () => { if (D) afterSave(await checkSettingsModal(S, D)); });
  on(box, "click", "[data-editalerts]", async () => { if (D) afterSave(await alertSettingsModal(S, D)); });
  on(box, "click", "[data-check]", async (e, b) => {
    b.classList.add("loading"); b.disabled = true;
    try {
      const r = await post(`/api/sites/${S.id}/monitor/check`);
      D.summary = r.summary; paintMon();
      const lc = r.summary.lastCheck;
      toast(lc?.ok ? `Responded in ${lc.ms} ms` : `Check failed: ${lc?.error || "unknown"}`, lc?.ok ? "ok" : "err");
      refresh();
    } catch (ex) { toastError(ex, "Couldn't run the check"); b.classList.remove("loading"); b.disabled = false; }
  });
  on(box, "click", "[data-pause]", async () => {
    const ok = await confirmDialog({ title: `Pause monitoring of ${S.name}?`, ico: "stop", confirmText: "Pause monitoring",
      message: "For maintenance: no checks and no alerts until you resume. An ongoing incident is closed without a \"back up\" alert. Paused time doesn't count against uptime." });
    if (!ok) return;
    try { await post(`/api/sites/${S.id}/monitor/pause`, {}); toast("Monitoring paused", "ok"); await loadMon(); if (ctx.alive()) paintMon(); }
    catch (ex) { toastError(ex, "Couldn't pause monitoring"); }
  });
  on(box, "click", "[data-resume]", async () => {
    try { await post(`/api/sites/${S.id}/monitor/resume`); toast("Monitoring resumed", "ok"); await loadMon(); if (ctx.alive()) paintMon(); }
    catch (ex) { toastError(ex, "Couldn't resume monitoring"); }
  });
  ctx.on("monitor", (d) => {
    if (d?.kind === "update") { if ((d.items || []).some((x) => x.siteId === S.id)) refresh(); }
    else if (d?.kind !== "sms" && (!d?.siteId || d.siteId === S.id)) refresh();
  });
  const t = setInterval(refresh, 60_000);
  ctx.cleanup(() => clearInterval(t));
  return traffic;
}
