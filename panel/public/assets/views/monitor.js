// Uptime monitoring + SMS alerts (server: panel/lib/monitor.mjs).
//   uptimeTab()              website page → Uptime tab
//   notificationsSettings()  Settings → Notifications (Bird)
//   bindUptime()             fills [data-uptime="<siteId>"] slots in website rows (Websites list, project page)
//   downBanner()             dashboard: "N websites down" card (renders nothing while everything is up)
// Every user-supplied string goes through html``.
import { html, raw, mount, $, $$, on, ago, fmtDate, fmtTime, fmtDuration, plural, toast, toastError, confirmDialog, debounce, emptyState, skeletonRows } from "../util.js";
import { icon } from "../icons.js";
import { get, put, post } from "../api.js";
import { lineChart } from "../charts.js";

/* ───────── shared bits ───────── */

const STATE = {
  up: { tone: "ok", text: "Up" },
  down: { tone: "err", text: "Down" },
  unknown: { tone: "off", text: "Checking…" },
  paused: { tone: "off", text: "Paused" },
  pending: { tone: "off", text: "Not deployed" },
};
export function monitorState(m) {
  if (!m) return { tone: "off", text: "—" };
  if (m.state === "up" && m.degraded) return { tone: "warn", text: "Degraded" };
  if (m.state === "up" && m.failing) return { tone: "warn", text: "Failing checks" };
  return STATE[m.state] || STATE.unknown;
}
export function fmtUptime(p) {
  if (p == null) return "—";
  if (p >= 100) return "100%";
  return `${p >= 99.99 ? p.toFixed(3) : p.toFixed(2)}%`;
}
const toneOf = (r) => (r == null ? "none" : r < 0 ? "paused" : r >= 0.999 ? "ok" : r >= 0.95 ? "warn" : "err");
const pctOf = (p) => (p == null ? null : p / 100);

/** Status-page style bar strip. values: ratio 0..1 | null (no data) | -1 (paused). */
export function uptimeStrip(values, { labels = [], cls = "" } = {}) {
  return html`<div class="up-strip ${cls}" role="img" aria-label="Uptime history">${values.map((v, i) => html`<i class="up-b ${toneOf(v)}" title="${labels[i] || ""}${labels[i] ? " · " : ""}${v == null ? "no data" : v < 0 ? "paused" : fmtUptime(v * 100)}"></i>`)}</div>`;
}

/** Labels for the 24 clock-hour cells of `bars24h` (the server sends where they start; the last cell is the current hour). */
function hourLabels(start, n = 24) {
  const s = Date.parse(start) || Math.floor(Date.now() / 3600e3) * 3600e3 - (n - 1) * 3600e3;
  return Array.from({ length: n }, (_, i) => {
    const t = s + i * 3600e3;
    return i === n - 1 ? `${fmtTime(t)}–now` : `${fmtTime(t)}–${fmtTime(t + 3600e3)}`;
  });
}

function recipientsEditor(el, list = [], { onDirty } = {}) {
  let rows = list.map((r) => ({ name: r.name || "", phone: r.phone || "" }));
  const paint = () => mount(el, html`<div class="rcp-list">${rows.map((r, i) => html`<div class="rcp-row">
      <input class="input" data-k="name" data-i="${i}" value="${r.name}" placeholder="Name (optional)" maxlength="60" autocomplete="off"/>
      <input class="input mono" data-k="phone" data-i="${i}" value="${r.phone}" placeholder="+15551234567" inputmode="tel" autocomplete="off" spellcheck="false"/>
      <button type="button" class="icon-btn ghost sm" data-rm="${i}" aria-label="Remove this number">${icon("trash", "sm")}</button></div>`)}
    ${rows.length ? "" : html`<p class="muted small" style="margin:2px 0 8px">No numbers yet.</p>`}
    <button type="button" class="btn btn-sm" data-addrcp ${rows.length >= 25 ? raw("disabled") : ""}>${icon("plus")}Add number</button></div>`);
  paint();
  el.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.k == null) return;
    rows[+t.dataset.i][t.dataset.k] = t.value;
    onDirty?.();
  });
  on(el, "click", "[data-rm]", (e, b) => { rows.splice(+b.dataset.rm, 1); paint(); onDirty?.(); });
  on(el, "click", "[data-addrcp]", () => { rows.push({ name: "", phone: "" }); paint(); $$('[data-k="phone"]', el).pop()?.focus(); onDirty?.(); });
  return {
    /** Normalised rows; throws with a readable message on a bad number. */
    value() {
      return rows.filter((r) => r.name.trim() || r.phone.trim()).map((r) => {
        let p = r.phone.trim().replace(/[\s().-]/g, "");
        if (p.startsWith("00")) p = "+" + p.slice(2);
        if (!/^\+[1-9]\d{6,14}$/.test(p)) throw new Error(`"${r.phone || r.name}" is not a valid phone number. Use international format, like +15551234567.`);
        return { name: r.name.trim(), phone: p };
      });
    },
    set(list2) { rows = (list2 || []).map((r) => ({ name: r.name || "", phone: r.phone || "" })); paint(); },
  };
}

const field = (label, control, hint) => html`<div class="field"><label>${label}</label>${control}${hint ? html`<div class="hint">${hint}</div>` : ""}</div>`;
function setBusy(btn, busy) { if (!btn) return; btn.classList.toggle("loading", busy); btn.disabled = busy; }
function showErr(el, msg) { el.hidden = !msg; mount(el, msg ? html`${icon("alert")}<div>${msg}</div>` : html``); }

/* ───────── website rows (Websites list, project page) ───────── */

/**
 * Fills every `[data-uptime="<siteId>"]` inside root (now and whenever the list
 * re-renders) with a status dot + 24h uptime, and `data-compact` slots with a
 * shorter version. Keeps itself current from the `monitor` SSE event.
 */
export function bindUptime(root, ctx) {
  let byId = {};
  const paintSlot = (el) => {
    const m = byId[el.dataset.uptime];
    if (!m) { mount(el, html``); return; }
    const st = monitorState(m);
    const h24 = m.uptime?.h24;
    const title = `Uptime monitor: ${st.text}${m.since ? ` since ${fmtDate(m.since)}` : ""}${h24 != null ? ` · ${fmtUptime(h24)} in the last 24h` : ""}`;
    if (el.hasAttribute("data-compact")) {
      mount(el, html`<span class="up-inline" title="${title}"><span class="dot ${st.tone}"></span>${m.state === "up" || m.state === "down" ? fmtUptime(h24) : st.text}</span>`);
      return;
    }
    mount(el, html`<div class="up-slot" title="${title}">
      <span class="up-inline"><span class="dot ${st.tone}"></span>${m.state === "up" || m.state === "down" ? html`<b>${fmtUptime(h24)}</b><span class="dim">24h</span>` : st.text}</span>
      ${Array.isArray(m.bars24h) && m.state !== "pending" ? uptimeStrip(m.bars24h, { cls: "mini", labels: hourLabels(m.bars24hStart, m.bars24h.length) }) : ""}</div>`);
  };
  const paintAll = () => $$("[data-uptime]", root).forEach(paintSlot);
  const load = async () => {
    try {
      const r = await get("/api/monitor");
      byId = Object.fromEntries((r.items || []).map((m) => [m.siteId, m]));
      if (ctx.alive()) paintAll();
    } catch { /* monitor module not loaded: leave the slots empty */ }
  };
  const mo = new MutationObserver((recs) => {
    for (const rec of recs) for (const n of rec.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.matches?.("[data-uptime]")) paintSlot(n);
      n.querySelectorAll?.("[data-uptime]").forEach(paintSlot);
    }
  });
  mo.observe(root, { childList: true, subtree: true });
  ctx.cleanup?.(() => mo.disconnect());
  const reload = debounce(load, 400);
  ctx.on("monitor", (d) => {
    if (d?.kind === "update") {
      for (const it of d.items || []) byId[it.siteId] = { ...byId[it.siteId], ...it, uptime: { ...(byId[it.siteId]?.uptime || {}), ...(it.uptime || {}) } };
      paintAll();
    } else if (d?.kind !== "sms") reload();
  });
  const t = setInterval(load, 60_000);
  ctx.cleanup?.(() => clearInterval(t));
  load();
}

/* ───────── dashboard ───────── */

export async function downBanner(el, ctx) {
  const paint = (r) => {
    const down = (r.items || []).filter((m) => m.state === "down");
    if (!down.length) { mount(el, html``); el.hidden = true; return; }
    el.hidden = false;
    mount(el, html`<div class="card up-alert">
      <div class="card-head"><span class="up-alert-ico">${icon("alert")}</span>
        <div style="min-width:0"><h3>${plural(down.length, "website")} down</h3><div class="sub">${r.notifications?.enabled ? "Text alerts are on for websites that have them enabled." : html`Text alerts are off — <a href="#/settings/notifications">turn them on</a>.`}</div></div></div>
      <div class="list">${down.map((m) => html`<a class="list-item" href="#/sites/${m.siteId}/uptime">
        <span class="dot err"></span>
        <div class="li-main"><div class="li-title">${m.name}</div><div class="li-sub">${m.domain || m.target || "no address"} · ${m.lastCheck?.error || "failing"}</div></div>
        <div class="li-right">down ${m.since ? ago(m.since).replace(" ago", "") : ""}${icon("chevronRight", "sm")}</div></a>`)}</div></div>`);
  };
  const load = async () => { try { const r = await get("/api/monitor"); if (ctx.alive()) paint(r); } catch { el.hidden = true; } };
  ctx.on("monitor", debounce((d) => { if (d?.kind !== "sms") load(); }, 500));
  await load();
}

/* ───────── website page → Uptime tab ───────── */

const INTERVALS = [10, 30, 60, 120, 300, 600, 900, 1800, 3600];
const intervalLabel = (s) => (s < 60 ? `${s} seconds` : s < 3600 ? `${s / 60} minute${s === 60 ? "" : "s"}` : "1 hour");
const KIND_LABEL = { down: "Down alert", reminder: "Still down", up: "Recovered" };

function incidentItem(i) {
  const dur = fmtDuration(i.durationMs);
  const texts = (i.alerts || []).filter((a) => !a.skipped);
  const failed = texts.filter((a) => !a.ok).length;
  return html`<details class="inc" data-inc="${i.id}">
    <summary class="list-item">
      <span class="li-ico" style="color:${i.open ? "var(--err)" : "var(--muted)"}">${icon(i.open ? "alert" : "check", "sm")}</span>
      <div class="li-main"><div class="li-title">${i.open ? "Down" : "Was down"} ${dur} · ${i.lastCause && i.lastCause !== i.cause ? `${i.cause} → ${i.lastCause}` : i.cause || "unknown cause"}</div>
        <div class="li-sub">${fmtDate(i.startedAt)}${i.endedAt ? html` → ${fmtDate(i.endedAt)}` : " → now"}${i.endedBy === "paused" ? " · closed by pausing monitoring" : ""}${(i.servers || []).length ? ` · unhealthy: ${i.servers.join(", ")}` : ""}${(i.gaps || []).length ? " · panel was offline during this incident" : ""}</div></div>
      <div class="li-right">${texts.length ? html`<span class="badge ${failed ? "warn" : ""}">${icon("bell")}${plural(texts.length, "text")}${failed ? ` · ${failed} failed` : ""}</span>` : ""}
        ${i.open ? html`<span class="badge err">Ongoing</span>` : html`<span class="badge ok">Resolved</span>`}</div>
    </summary>
    <div class="inc-log">
      ${(i.gaps || []).map((g) => html`<div class="inc-row"><span class="mono">${fmtDate(g.from)} → ${fmtTime(g.to)}</span><span class="muted">No data — the panel was not running</span></div>`)}
      ${(i.alerts || []).length ? (i.alerts || []).map((a) => html`<div class="inc-row">
          <span class="mono">${fmtDate(a.at)}</span>
          <span>${KIND_LABEL[a.kind] || a.kind} → <span class="mono">${a.to}</span>${a.name ? html` <span class="muted">(${a.name})</span>` : ""}</span>
          <span>${a.skipped ? html`<span class="badge">skipped</span> <span class="muted small">${a.error}</span>` : a.ok ? (a.simulated ? html`<span class="badge">simulated</span>` : html`<span class="badge ok">${icon("check")}sent</span>`) : html`<span class="badge err">failed</span> <span class="small" style="color:#ff8ea3">${a.error}</span>`}</span>
        </div>`) : html`<div class="inc-row"><span class="muted">No text messages were sent for this incident${i.open ? " yet" : ""}.</span></div>`}
    </div></details>`;
}

export async function uptimeTab(box, ctx, S) {
  let range = "24h", D = null, chart = null;
  mount(box, skeletonRows(3, 90));
  const load = async () => { D = await get(`/api/sites/${S.id}/monitor?range=${range}`); return D; };
  try { await load(); } catch (e) { if (ctx.alive()) mount(box, html`<div class="card">${emptyState({ ico: "activity", title: "Uptime monitoring isn't available", text: e.message, sm: true })}</div>`); return; }
  if (!ctx.alive()) return;

  mount(box, html`<div data-up-head></div>
    <div class="card mt-20"><div class="card-head"><div><h3>Last 90 days</h3><div class="sub" data-up-90sub></div></div></div>
      <div class="card-body" data-up-90></div></div>
    <div class="card mt-20 chart-card"><div class="chart-toolbar"><div><h3 style="margin:0">Response time</h3><div class="sub muted small" data-up-csub></div></div>
      <div class="seg" data-range>${["1h", "24h", "7d", "30d", "90d"].map((r) => html`<button class="${r === range ? "active" : ""}" data-r="${r}">${r}</button>`)}</div></div>
      <div class="chart" data-up-chart style="height:240px"></div></div>
    <div class="card mt-20"><div class="card-head"><div><h3>Incidents</h3><div class="sub">Outages and every text message sent about them</div></div></div><div class="list" data-up-inc></div></div>
    <div class="grid-2 mt-20 up-forms" data-up-forms></div>`);

  const paintHead = () => {
    const m = D.summary, st = monitorState(m), u = m.uptime || {};
    const lc = m.lastCheck;
    const servers = m.servers || [];
    mount($("[data-up-head]", box), html`
      ${m.paused ? html`<div class="note warn" style="margin-bottom:14px">${icon("info")}<div style="flex:1">Monitoring is paused${m.since ? ` since ${fmtDate(m.since)}` : ""}${m.pauseUntil ? ` until ${fmtDate(m.pauseUntil)}` : ""}${D.settings.pausedBy ? ` by ${D.settings.pausedBy}` : ""} — no checks and no text messages.</div><button class="btn btn-sm" data-resume>${icon("play")}Resume</button></div>` : ""}
      ${m.state === "pending" ? html`<div class="note" style="margin-bottom:14px">${icon("info")}<div>Monitoring starts after the first deploy (or set a custom URL below).</div></div>` : ""}
      <div class="mini-stats">
        <div class="mini-stat"><div class="ms-l">${icon("activity", "xs")}Status</div><div class="ms-v row" style="gap:9px"><span class="dot ${st.tone}"></span>${st.text}</div>
          <div class="ms-s">${m.since && (m.state === "up" || m.state === "down") ? html`for ${ago(m.since).replace(" ago", "")}` : ""}${lc ? html`${m.since ? " · " : ""}checked ${ago(lc.at)}` : ""}</div></div>
        <div class="mini-stat"><div class="ms-l">${icon("check", "xs")}Uptime 24h</div><div class="ms-v">${fmtUptime(u.h24)}</div><div class="ms-s">7 days ${fmtUptime(u.d7)}</div></div>
        <div class="mini-stat"><div class="ms-l">${icon("calendar", "xs")}Uptime 30 days</div><div class="ms-v">${fmtUptime(u.d30)}</div><div class="ms-s">90 days ${fmtUptime(u.d90)}</div></div>
        <div class="mini-stat"><div class="ms-l">${icon("gauge", "xs")}Response time</div><div class="ms-v">${m.avgMs24h != null ? `${m.avgMs24h} ms` : "—"}</div><div class="ms-s">${lc ? (lc.ok ? `last ${lc.ms} ms · HTTP ${lc.status}` : html`<span style="color:#ff8ea3">${lc.error}</span>`) : "24h average"}</div></div>
      </div>
      <div class="card"><div class="card-head" style="flex-wrap:wrap"><div style="min-width:0;flex:1 1 260px"><h3>Checks</h3>
          <div class="sub">${D.effective.url ? html`<span class="mono">GET ${D.effective.url}</span>` : "No address to check"} · every ${intervalLabel(D.settings.intervalSec)} · expects ${D.settings.expectMin}–${D.settings.expectMax}</div></div>
        <div class="right btn-row">${m.paused ? html`<button class="btn btn-sm" data-resume>${icon("play")}Resume</button>` : html`<button class="btn btn-sm" data-check ${m.state === "pending" ? raw("disabled") : ""}>${icon("refresh")}Check now</button><button class="btn btn-sm" data-pause>${icon("stop")}Pause</button>`}</div></div>
        <div class="card-body"><dl class="kv">
          <dt>Last 24 hours</dt><dd>${uptimeStrip(m.bars24h || [], { labels: hourLabels(m.bars24hStart, (m.bars24h || []).length) })}</dd>
          ${servers.length ? html`<dt>${servers.length > 1 ? "Servers" : "Server"}</dt><dd class="row wrap" style="gap:12px">${servers.map((x) => html`<span class="status" title="${x.error || ""}"><span class="dot ${x.down || x.healthy === false ? "err" : !x.online ? "off" : x.healthy ? "ok" : "off"}"></span>${x.name}<span class="muted small">${x.down || x.healthy === false ? " unhealthy" : !x.online ? " offline" : x.healthy ? " healthy" : " not checked"}</span></span>`)}</dd>` : ""}
          <dt>Text alerts</dt><dd>${!D.notifications.enabled ? html`<span class="muted">Off for the whole panel — </span><a href="#/settings/notifications" style="color:var(--blue-3)">Settings → Notifications</a>` : D.settings.smsEnabled ? html`On · ${plural(D.recipients.length, "number")}${D.notifications.dryRun ? html` <span class="badge">dry run: simulated</span>` : !D.notifications.configured ? html` <span class="badge warn">Bird not set up</span>` : ""}` : html`<span class="muted">Off for this website</span>`}</dd>
        </dl></div></div>`);
  };

  const paint90 = () => {
    const days = D.days || [];
    const withData = days.filter((d) => d.uptime != null);
    mount($("[data-up-90sub]", box), html`${fmtUptime(D.summary.uptime?.d90)} uptime · ${withData.length ? plural(days.reduce((a, d) => a + (d.downMinutes || 0), 0), "minute") + " down" : "no data yet"}`);
    mount($("[data-up-90]", box), html`${uptimeStrip(days.map((d) => (d.uptime == null ? (d.pausedMinutes ? -1 : null) : d.uptime / 100)), { cls: "big", labels: days.map((d) => `${d.day}${d.downMinutes ? ` · ${d.downMinutes} min down` : ""}${d.avgMs != null ? ` · ${d.avgMs} ms` : ""}`) })}
      <div class="up-legend"><span>90 days ago</span><span class="row" style="gap:12px"><span><i class="up-b ok"></i>Up</span><span><i class="up-b warn"></i>Partial</span><span><i class="up-b err"></i>Down</span><span><i class="up-b none"></i>No data</span></span><span>Today</span></div>`);
  };

  const chartData = () => {
    const pts = (D.series?.points || []).filter((p) => p.ms != null).map((p) => ({ t: p.t, v: p.ms }));
    return { series: [{ name: "Response time", color: "#33d4c1", gradient: ["#33d4c1", "#6d8dff"], areaColor: "#33d4c1", points: pts, fmt: (v) => `${Math.round(v)} ms` }], range, fmt: (v) => `${Math.round(v)} ms`, empty: "No successful checks in this period", aria: `Response time over the last ${range}` };
  };
  const paintChart = () => {
    const pts = (D.series?.points || []).filter((p) => p.ms != null);
    const avg = pts.length ? Math.round(pts.reduce((a, p) => a + p.ms, 0) / pts.length) : null;
    mount($("[data-up-csub]", box), html`${avg != null ? `${avg} ms average` : "—"} · time to first byte from this server`);
    if (!chart) { chart = lineChart($("[data-up-chart]", box), chartData()); ctx.cleanup(() => chart.destroy()); } else chart.update(chartData());
  };

  const paintIncidents = () => {
    const inc = D.incidents || [];
    const opened = new Set($$("details.inc[open]", box).map((d) => d.dataset.inc)); // keep expanded logs open across live refreshes
    const gaps = (D.gaps || []).filter((g) => !inc.some((i) => (i.gaps || []).some((x) => x.from === g.from)));
    mount($("[data-up-inc]", box), inc.length || gaps.length ? html`${inc.map(incidentItem)}${gaps.slice(0, 3).map((g) => html`<div class="list-item"><span class="li-ico">${icon("power", "sm")}</span><div class="li-main"><div class="li-title">No data for ${fmtDuration(Date.parse(g.to) - Date.parse(g.from))}</div><div class="li-sub">${fmtDate(g.from)} → ${fmtDate(g.to)} · the panel was not running, so nothing was checked</div></div></div>`)}`
      : emptyState({ ico: "check", title: "No incidents", text: "Outages show up here with every text message sent about them.", sm: true }));
    $$("details.inc", box).forEach((d) => { if (opened.has(d.dataset.inc)) d.open = true; });
  };

  /* settings forms */
  let rcpEd = null;
  const paintForms = () => {
    const s = D.settings, n = D.notifications;
    const ivals = [...new Set([...INTERVALS.filter((x) => x >= s.minIntervalSec), s.intervalSec])].sort((a, b) => a - b);
    mount($("[data-up-forms]", box), html`
      <form class="card" data-chk novalidate>
        <div class="card-head"><div><h3>Check settings</h3><div class="sub">How this server checks the website</div></div></div>
        <div class="card-body"><div class="form-grid">
          ${field("Check every", html`<select class="select" name="intervalSec">${ivals.map((v) => html`<option value="${v}" ${v === s.intervalSec ? raw("selected") : ""}>${intervalLabel(v)}</option>`)}</select>`)}
          ${field("Timeout", html`<div class="row" style="gap:8px"><input class="input" type="number" name="timeoutSec" min="1" max="60" value="${s.timeoutSec}" style="max-width:110px"/><span class="muted small">seconds</span></div>`)}
          ${field("Path", html`<input class="input mono" name="path" value="${s.path || ""}" placeholder="${D.effective.healthPath || "/"}" autocomplete="off" spellcheck="false"/>`, html`Blank = the website's health check path${D.effective.healthPath ? html` (<span class="mono">${D.effective.healthPath}</span>)` : " or /"}.`)}
          ${field("Expected status", html`<input class="input mono" name="expect" value="${s.expectMin === s.expectMax ? s.expectMin : `${s.expectMin}-${s.expectMax}`}" placeholder="200-399" autocomplete="off"/>`, "Anything else counts as a failed check.")}
          ${field("Down after", html`<div class="row" style="gap:8px"><input class="input" type="number" name="failThreshold" min="1" max="20" value="${s.failThreshold}" style="max-width:110px"/><span class="muted small">failed checks in a row</span></div>`)}
          ${field("Up again after", html`<div class="row" style="gap:8px"><input class="input" type="number" name="recoverThreshold" min="1" max="20" value="${s.recoverThreshold}" style="max-width:110px"/><span class="muted small">good checks in a row</span></div>`)}
          <div class="span-2">${field("Custom URL", html`<input class="input mono" name="url" value="${s.url || ""}" placeholder="${D.effective.how === "custom" ? "" : D.effective.url || "https://example.com/health"}" autocomplete="off" spellcheck="false"/>`, "Optional. Check this exact address instead of the website's first domain.")}</div>
          <div class="error-box span-2" data-err hidden></div>
        </div></div>
        <div class="card-foot"><span class="spacer"></span><button class="btn btn-primary" type="submit" data-save>${icon("check")}Save check settings</button></div>
      </form>
      <form class="card" data-sms novalidate>
        <div class="card-head"><div><h3>Text alerts</h3><div class="sub">A text when it goes down, ${n.repeatMinutes === 60 ? "every hour" : `every ${n.repeatMinutes} min`} while it stays down${n.notifyRecovery ? ", and one when it's back" : ""}</div></div>
          <div class="right"><label class="switch"><input type="checkbox" name="smsEnabled" ${s.smsEnabled ? raw("checked") : ""}/><span class="track"></span><span class="hide-sm">Enabled</span></label></div></div>
        <div class="card-body"><div class="form-stack">
          ${!n.enabled ? html`<div class="note warn">${icon("info")}<div>Text alerts are turned off for the whole panel. Turn them on in <a href="#/settings/notifications" style="color:var(--text);font-weight:600">Settings → Notifications</a>.</div></div>` : !n.configured && !n.dryRun ? html`<div class="note warn">${icon("info")}<div>Bird isn't fully set up yet — <a href="#/settings/notifications" style="color:var(--text);font-weight:600">finish it in Settings → Notifications</a>.</div></div>` : ""}
          ${field("Numbers for this website", html`<div data-rcp></div>`, "International format (E.164), like +15551234567.")}
          <label class="switch"><input type="checkbox" name="includeDefaults" ${s.includeDefaults !== false ? raw("checked") : ""}/><span class="track"></span>Also text the default numbers ${n.defaults?.length ? html`<span class="muted">(${n.defaults.map((d) => d.name || d.phone).join(", ")})</span>` : html`<span class="muted">(none set)</span>`}</label>
          ${field("Repeat while down", html`<div class="row" style="gap:8px"><input class="input" type="number" name="repeatMinutes" min="1" max="1440" value="${s.repeatMinutes ?? ""}" placeholder="${n.repeatMinutes}" style="max-width:110px"/><span class="muted small">minutes (blank = panel default, ${n.repeatMinutes})</span></div>`, `Each number gets at most one text per ${n.minGapMinutes >= 1 ? `${n.minGapMinutes} minutes` : `${Math.round(n.minGapMinutes * 60)} seconds`} for this website (the "back up" text is always sent).`)}
          <div class="error-box" data-err hidden></div>
        </div></div>
        <div class="card-foot"><span class="muted small">${D.recipients.length ? `${plural(D.recipients.length, "number")} will be texted` : "Nobody will be texted"}</span><span class="spacer"></span><button class="btn btn-primary" type="submit" data-save>${icon("check")}Save alerts</button></div>
      </form>`);
    rcpEd = recipientsEditor($("[data-rcp]", box), s.recipients || []);
  };

  const paintAll = () => { paintHead(); paint90(); paintChart(); paintIncidents(); };
  paintAll(); paintForms();

  const refresh = debounce(async () => { try { await load(); if (ctx.alive()) paintAll(); } catch {} }, 400);

  on(box, "submit", "[data-chk]", async (e, form) => {
    e.preventDefault();
    const err = $("[data-err]", form), btn = $("[data-save]", form), f = form.elements;
    showErr(err, ""); setBusy(btn, true);
    try {
      const r = await put(`/api/sites/${S.id}/monitor`, { intervalSec: +f.intervalSec.value, timeoutSec: +f.timeoutSec.value, path: f.path.value.trim(), expect: f.expect.value.trim() || "200-399", failThreshold: +f.failThreshold.value, recoverThreshold: +f.recoverThreshold.value, url: f.url.value.trim() });
      D.settings = r.settings; D.summary = r.summary;
      toast("Check settings saved", "ok");
      await load(); if (ctx.alive()) { paintAll(); paintForms(); }
    } catch (ex) { showErr(err, ex.message); } finally { setBusy(btn, false); }
  });
  on(box, "submit", "[data-sms]", async (e, form) => {
    e.preventDefault();
    const err = $("[data-err]", form), btn = $("[data-save]", form), f = form.elements;
    showErr(err, "");
    let recipients;
    try { recipients = rcpEd.value(); } catch (ex) { showErr(err, ex.message); return; }
    if (f.smsEnabled.checked && !recipients.length && !(f.includeDefaults.checked && D.notifications.defaults?.length)) { showErr(err, "Add at least one number, or include the default numbers."); return; }
    setBusy(btn, true);
    try {
      const rv = f.repeatMinutes.value.trim();
      const r = await put(`/api/sites/${S.id}/monitor`, { smsEnabled: f.smsEnabled.checked, includeDefaults: f.includeDefaults.checked, recipients, repeatMinutes: rv ? +rv : null });
      D.settings = r.settings; D.summary = r.summary; D.recipients = r.recipients;
      toast(r.settings.smsEnabled ? "Text alerts saved" : "Text alerts turned off", "ok");
      paintHead(); paintForms();
    } catch (ex) { showErr(err, ex.message); } finally { setBusy(btn, false); }
  });
  on(box, "click", "[data-check]", async (e, b) => {
    setBusy(b, true);
    try { const r = await post(`/api/sites/${S.id}/monitor/check`); D.summary = r.summary; paintHead(); const lc = r.summary.lastCheck; toast(lc?.ok ? `Responded in ${lc.ms} ms` : `Check failed: ${lc?.error || "unknown"}`, lc?.ok ? "ok" : "err"); refresh(); }
    catch (ex) { toastError(ex, "Couldn't run the check"); setBusy(b, false); }
  });
  on(box, "click", "[data-pause]", async () => {
    const ok = await confirmDialog({ title: `Pause monitoring of ${S.name}?`, ico: "stop", confirmText: "Pause monitoring",
      message: "For maintenance: no checks and no text messages until you resume. An ongoing incident is closed without a \"back up\" text. Paused time doesn't count against uptime." });
    if (!ok) return;
    try { await post(`/api/sites/${S.id}/monitor/pause`, {}); toast("Monitoring paused", "ok"); await load(); if (ctx.alive()) paintAll(); }
    catch (ex) { toastError(ex, "Couldn't pause monitoring"); }
  });
  on(box, "click", "[data-resume]", async () => {
    try { await post(`/api/sites/${S.id}/monitor/resume`); toast("Monitoring resumed", "ok"); await load(); if (ctx.alive()) paintAll(); }
    catch (ex) { toastError(ex, "Couldn't resume monitoring"); }
  });
  on(box, "click", "[data-r]", async (e, b) => {
    range = b.dataset.r;
    $$("[data-r]", box).forEach((x) => x.classList.toggle("active", x === b));
    try { await load(); if (ctx.alive()) paintChart(); } catch {}
  });
  ctx.on("monitor", (d) => {
    if (d?.kind === "update") { const it = (d.items || []).find((x) => x.siteId === S.id); if (it) refresh(); }
    else if (!d?.siteId || d.siteId === S.id) refresh();
  });
  const t = setInterval(refresh, 60_000);
  ctx.cleanup(() => clearInterval(t));
}

/* ───────── Settings → Notifications ───────── */

export async function notificationsSettings(box, ctx) {
  let s = await get("/api/notifications/settings");
  if (!ctx.alive()) return;
  let defEd = null;
  const apiLabel = (a) => (a === "platform" ? "Bird platform API" : a === "channels" ? "Bird Channels API" : "");
  const paint = () => {
    const badge = s.dryRun ? html`<span class="badge">${icon("info")}Dry run — texts are simulated</span>`
      : s.configured ? html`<span class="badge ok">${icon("check")}${apiLabel(s.api)}</span>` : html`<span class="badge warn">Not set up</span>`;
    mount(box, html`
      <form class="card" data-form novalidate>
        <div class="card-head" style="flex-wrap:wrap"><div style="flex:1 1 260px;min-width:0"><h3>Text message alerts</h3><div class="sub">Websites with text alerts on send an SMS through Bird when they go down, again while they stay down, and when they're back.</div></div>
          <div class="right row" style="gap:10px">${badge}<label class="switch"><input type="checkbox" name="enabled" ${s.enabled ? raw("checked") : ""}/><span class="track"></span><span class="hide-sm">Enabled</span></label></div></div>
        <div class="card-body"><div class="form-grid">
          ${field("Repeat while down", html`<div class="row" style="gap:8px"><input class="input" type="number" name="repeatMinutes" min="1" max="1440" value="${s.repeatMinutes}" style="max-width:110px"/><span class="muted small">minutes</span></div>`, "Default for every website (a website can override it).")}
          <div class="field"><label>When it's back</label><label class="switch" style="margin-top:8px"><input type="checkbox" name="notifyRecovery" ${s.notifyRecovery ? raw("checked") : ""}/><span class="track"></span>Send a "back up after …" text</label></div>
          <div class="span-2">${field("Default numbers", html`<div data-defs></div>`, html`Texted for every website with alerts on (unless the website turns "Also text the default numbers" off). Each number gets at most one text per website every ${s.minGapMinutes >= 1 ? `${s.minGapMinutes} minutes` : `${Math.round(s.minGapMinutes * 60)} seconds`}, except "back up" texts.`)}</div>
        </div></div>

        <div class="card-head" style="border-top:1px solid var(--line)"><div><h3>Bird account</h3><div class="sub">From <a href="https://bird.com" target="_blank" rel="noopener noreferrer" style="color:var(--blue-3)">bird.com</a>. The key is stored encrypted and never shown again.</div></div></div>
        <div class="card-body"><div class="form-grid">
          <div class="span-2">${field(s.accessKeySet ? "Replace access key" : "Access key", html`<div class="row" style="gap:10px;flex-wrap:wrap">
              ${s.accessKeySet ? html`<span class="row" style="gap:8px"><span class="li-ico" style="width:32px;height:32px;border-radius:10px;display:grid;place-items:center;background:rgba(148,166,255,.07)">${icon("key", "sm")}</span><span class="mono small">${s.accessKeyHint}</span></span>` : ""}
              <div class="pw-wrap" style="flex:1 1 260px"><input class="input mono" type="password" name="accessKey" placeholder="${s.accessKeySet ? "Leave blank to keep the saved key" : "bk_us1_… or a workspace access key"}" autocomplete="off" spellcheck="false"/><button type="button" class="icon-btn" data-toggle-pw aria-label="Show key">${icon("eye")}</button></div>
              ${s.accessKeySet ? html`<button type="button" class="btn btn-sm btn-danger" data-clear-key>${icon("trash")}Remove</button>` : ""}</div>`,
            html`${s.accessKeyUnreadable ? html`<span style="color:#ff8ea3">The saved key can't be decrypted (the panel key changed) — paste it again. </span>` : ""}A <b>bk_…</b> API key uses Bird's platform SMS API and needs a sender. A workspace <b>access key</b> uses the Channels API and needs the workspace and SMS channel IDs.`)}</div>
          ${field("Workspace ID", html`<input class="input mono" name="workspaceId" value="${s.workspaceId}" placeholder="Channels API only" autocomplete="off" spellcheck="false"/>`)}
          ${field("SMS channel ID", html`<input class="input mono" name="channelId" value="${s.channelId}" placeholder="Channels API only" autocomplete="off" spellcheck="false"/>`)}
          ${field("Sender", html`<input class="input mono" name="from" value="${s.from}" placeholder="+15557654321 or MyBrand" autocomplete="off" spellcheck="false"/>`, "Platform API only: a number you own on Bird, an alphanumeric sender ID or a short code.")}
          <div class="error-box span-2" data-err hidden></div>
          ${s.problem && !s.dryRun && (s.enabled || s.accessKeySet) ? html`<div class="note warn span-2">${icon("info")}<div>${s.problem}</div></div>` : ""}
        </div></div>
        <div class="card-foot"><span class="muted small" data-state></span><span class="spacer"></span><button class="btn btn-primary" type="submit" data-save>${icon("check")}Save notifications</button></div>
      </form>

      <form class="card" data-test novalidate>
        <div class="card-head"><div><h3>Send a test text</h3><div class="sub">${s.dryRun ? "Dry run: nothing is sent — the text is written to the panel log." : "Uses the saved settings above (save first)."}</div></div></div>
        <div class="card-body"><div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-start">
          <input class="input mono" name="to" placeholder="+15551234567" inputmode="tel" autocomplete="off" style="flex:1 1 220px;max-width:320px"/>
          <button class="btn" type="submit" data-send>${icon("bell")}Send test SMS</button></div>
          <div data-result class="mt-16" hidden></div></div>
      </form>`);
    defEd = recipientsEditor($("[data-defs]", box), s.defaults || [], { onDirty: () => ($("[data-state]", box).textContent = "Unsaved changes") });
  };
  paint();

  on(box, "input", "[data-form]", () => ($("[data-state]", box).textContent = "Unsaved changes"));
  on(box, "click", "[data-toggle-pw]", (e, b) => {
    const inp = b.parentElement.querySelector("input");
    inp.type = inp.type === "password" ? "text" : "password";
    mount(b, html`${icon(inp.type === "password" ? "eye" : "eyeOff")}`);
  });
  on(box, "submit", "[data-form]", async (e, form) => {
    e.preventDefault();
    const err = $("[data-err]", form), btn = $("[data-save]", form), f = form.elements;
    showErr(err, "");
    let defaults;
    try { defaults = defEd.value(); } catch (ex) { showErr(err, ex.message); return; }
    const body = { enabled: f.enabled.checked, repeatMinutes: +f.repeatMinutes.value || 60, notifyRecovery: f.notifyRecovery.checked, defaults, workspaceId: f.workspaceId.value.trim(), channelId: f.channelId.value.trim(), from: f.from.value.trim() };
    if (f.accessKey.value.trim()) body.accessKey = f.accessKey.value.trim();
    setBusy(btn, true);
    try {
      s = await put("/api/notifications/settings", body);
      if (s.warning) toast("Saved — but not ready yet", "warn", { msg: s.warning }); else toast("Notification settings saved", "ok");
      paint();
    } catch (ex) { showErr(err, ex.message); setBusy(btn, false); }
  });
  on(box, "click", "[data-clear-key]", async (e, b) => {
    const ok = await confirmDialog({ title: "Remove the Bird access key?", message: "No text messages can be sent until you add a key again.", danger: true, confirmText: "Remove key" });
    if (!ok) return;
    setBusy(b, true);
    try { s = await put("/api/notifications/settings", { clearAccessKey: true }); toast("Access key removed", "ok"); paint(); }
    catch (ex) { toastError(ex, "Couldn't remove the key"); setBusy(b, false); }
  });
  on(box, "submit", "[data-test]", async (e, form) => {
    e.preventDefault();
    const btn = $("[data-send]", form), out = $("[data-result]", form);
    const to = form.elements.to.value.trim();
    if (!to) { form.elements.to.focus(); return; }
    setBusy(btn, true);
    try {
      const r = await post("/api/notifications/test", { to });
      out.hidden = false;
      mount(out, r.ok ? html`<div class="note">${icon("check")}<div>${r.simulated ? html`Simulated (dry run) — the panel log shows: <span class="mono">${r.text}</span>` : html`Bird accepted the text to <span class="mono">${r.to}</span>${r.messageId ? html` (id <span class="mono">${r.messageId}</span>)` : ""}. It should arrive within a minute.`}</div></div>`
        : html`<div class="error-box">${icon("alert")}<div>${r.error || "Bird didn't accept the text."}</div></div>`);
    } catch (ex) { out.hidden = false; mount(out, html`<div class="error-box">${icon("alert")}<div>${ex.message}</div></div>`); }
    finally { setBusy(btn, false); }
  });
}
