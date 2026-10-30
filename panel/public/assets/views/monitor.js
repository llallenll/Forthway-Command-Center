// Uptime monitoring + SMS alerts (server: panel/lib/monitor.mjs).
//   checkSettingsModal() / alertSettingsModal() / incidentItem()  website page → Statistics tab (views/site-stats.js)
//   notificationsSettings()  Settings → Notifications (channels: Twilio SMS, Discord webhooks; alert rules; cluster alerts)
//   bindUptime()             fills [data-uptime="<siteId>"] slots in website rows (Websites list, project page)
//   downBanner()             dashboard: "N websites down" card (renders nothing while everything is up)
// Every user-supplied string goes through html``.
import { html, raw, mount, $, $$, on, ago, fmtDate, fmtTime, fmtDuration, plural, toast, toastError, confirmDialog, debounce, emptyState, skeletonRows, copyText, openModal, openMenu } from "../util.js";
import { icon } from "../icons.js";
import { get, put, post, patch, del } from "../api.js";
import { moreList } from "../fold.js"; // long incident / sign-up lists show "Show all"

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
export function hourLabels(start, n = 24) {
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
      <div class="list">${down.map((m) => html`<a class="list-item" href="#/sites/${m.siteId}/statistics">
        <span class="dot err"></span>
        <div class="li-main"><div class="li-title">${m.name}</div><div class="li-sub">${m.domain || m.target || "no address"} · ${m.lastCheck?.error || "failing"}</div></div>
        <div class="li-right">down ${m.since ? ago(m.since).replace(" ago", "") : ""}${icon("chevronRight", "sm")}</div></a>`)}</div></div>`);
  };
  const load = async () => { try { const r = await get("/api/monitor"); if (ctx.alive()) paint(r); } catch { el.hidden = true; } };
  ctx.on("monitor", debounce((d) => { if (d?.kind !== "sms") load(); }, 500));
  await load();
}

/* ───────── website page → Statistics tab (views/site-stats.js) ─────────
   The tab paints the cards; the check and alert settings live in two modals here. */

const INTERVALS = [10, 30, 60, 120, 300, 600, 900, 1800, 3600];
export const intervalLabel = (s) => (s < 60 ? `${s} seconds` : s < 3600 ? `${s / 60} minute${s === 60 ? "" : "s"}` : "1 hour");
const KIND_LABEL = { down: "Down alert", reminder: "Still down", up: "Recovered" };
const NOTIF_LINK = "#/settings/notifications";

export function incidentItem(i) {
  const dur = fmtDuration(i.durationMs);
  const sent = (i.alerts || []).filter((a) => !a.skipped);
  const failed = sent.filter((a) => !a.ok).length;
  const nSms = sent.filter((a) => a.channel !== "discord").length, nDiscord = sent.length - nSms;
  const sentLabel = [nSms ? plural(nSms, "text") : "", nDiscord ? plural(nDiscord, "Discord post") : ""].filter(Boolean).join(" · ");
  return html`<details class="inc" data-inc="${i.id}">
    <summary class="list-item">
      <span class="li-ico" style="color:${i.open ? "var(--err)" : "var(--muted)"}">${icon(i.open ? "alert" : "check", "sm")}</span>
      <div class="li-main"><div class="li-title">${i.open ? "Down" : "Was down"} ${dur} · ${i.lastCause && i.lastCause !== i.cause ? `${i.cause} → ${i.lastCause}` : i.cause || "unknown cause"}</div>
        <div class="li-sub">${fmtDate(i.startedAt)}${i.endedAt ? html` → ${fmtDate(i.endedAt)}` : " → now"}${i.endedBy === "paused" ? " · closed by pausing monitoring" : ""}${(i.servers || []).length ? ` · unhealthy: ${i.servers.join(", ")}` : ""}${(i.gaps || []).length ? " · panel was offline during this incident" : ""}</div></div>
      <div class="li-right">${sent.length ? html`<span class="badge ${failed ? "warn" : ""}">${icon("bell")}${sentLabel}${failed ? ` · ${failed} failed` : ""}</span>` : ""}
        ${i.open ? html`<span class="badge err">Ongoing</span>` : html`<span class="badge ok">Resolved</span>`}</div>
    </summary>
    <div class="inc-log">
      ${(i.gaps || []).map((g) => html`<div class="inc-row"><span class="mono">${fmtDate(g.from)} → ${fmtTime(g.to)}</span><span class="muted">No data — the panel was not running</span></div>`)}
      ${(i.alerts || []).length ? (i.alerts || []).map((a) => html`<div class="inc-row">
          <span class="mono">${fmtDate(a.at)}</span>
          <span>${a.channel === "discord" ? html`<span class="badge ch-discord">${icon("discord")}Discord</span>` : html`<span class="badge">${icon("message")}SMS</span>`} ${KIND_LABEL[a.kind] || a.kind} → ${a.channel === "discord" ? html`<b>${a.to}</b>${a.attempts > 1 ? html` <span class="muted small">(${a.attempts} attempts${a.rateLimited ? `, rate limited ${a.rateLimited}×` : ""})</span>` : ""}` : html`<span class="mono">${a.to}</span>${a.name ? html` <span class="muted">(${a.name})</span>` : ""}`}</span>
          <span>${a.skipped ? html`<span class="badge">skipped</span> <span class="muted small">${a.error}</span>` : a.ok ? (a.simulated ? html`<span class="badge">simulated</span>` : html`<span class="badge ok">${icon("check")}sent</span>`) : html`<span class="badge err">failed</span> <span class="small" style="color:#ff8ea3">${a.error}</span>`}</span>
        </div>`) : html`<div class="inc-row"><span class="muted">No alerts were sent for this incident${i.open ? " yet" : ""}.</span></div>`}
    </div></details>`;
}

/** One-line state of a site's text alerts: { tone, text } (tone: ok | warn | off). */
export function smsState(D) {
  const n = D.notifications, s = D.settings;
  if (!n.enabled) return { tone: "off", text: "Off for the whole panel" };
  if (!s.smsEnabled) return { tone: "off", text: "Off for this website" };
  if (!D.recipients.length) return { tone: "warn", text: "On, but nobody to text" };
  if (!n.configured && !n.dryRun) return { tone: "warn", text: `On · ${plural(D.recipients.length, "number")} · Twilio not set up` };
  return { tone: "ok", text: `On · ${plural(D.recipients.length, "number")}${n.dryRun ? " · dry run" : ""}` };
}
/** One-line state of a site's Discord alerts: { tone, text }. */
export function discordState(D) {
  const dn = D.notifications.discord || { webhooks: [] };
  if (!dn.webhooks.length) return { tone: "off", text: "No webhooks set up" };
  if (D.settings.discordEnabled === false) return { tone: "off", text: "Off for this website" };
  const t = new Set(D.discordTargets || []);
  const names = dn.webhooks.filter((w) => t.has(w.id)).map((w) => w.name);
  return names.length ? { tone: "ok", text: `On · ${names.join(", ")}${D.notifications.dryRun && !dn.testEndpoint ? " · dry run" : ""}` } : { tone: "warn", text: "On, but no enabled webhook is selected" };
}

/** "Check settings" modal. Resolves after a save with the PUT response (or undefined when closed). */
export function checkSettingsModal(S, D) {
  const s = D.settings;
  const ivals = [...new Set([...INTERVALS.filter((x) => x >= (s.minIntervalSec || 10)), s.intervalSec])].sort((a, b) => a - b);
  const fid = `chk-${Math.random().toString(36).slice(2, 8)}`;
  const m = openModal({
    title: "Check settings", sub: `How the panel checks ${S.name}`, ico: "activity", size: "lg",
    body: html`<form id="${fid}" data-chk novalidate><div class="form-grid">
      ${field("Check every", html`<select class="select" name="intervalSec">${ivals.map((v) => html`<option value="${v}" ${v === s.intervalSec ? raw("selected") : ""}>${intervalLabel(v)}</option>`)}</select>`)}
      ${field("Timeout", html`<div class="row" style="gap:8px"><input class="input" type="number" name="timeoutSec" min="1" max="60" value="${s.timeoutSec}" style="max-width:110px"/><span class="muted small">seconds</span></div>`)}
      ${field("Path", html`<input class="input mono" name="path" value="${s.path || ""}" placeholder="${D.effective.healthPath || "/"}" autocomplete="off" spellcheck="false"/>`, html`Blank = the website's health check path${D.effective.healthPath ? html` (<span class="mono">${D.effective.healthPath}</span>)` : " or /"}.`)}
      ${field("Expected status", html`<input class="input mono" name="expect" value="${s.expectMin === s.expectMax ? s.expectMin : `${s.expectMin}-${s.expectMax}`}" placeholder="200-399" autocomplete="off"/>`, "Anything else counts as a failed check.")}
      ${field("Down after", html`<div class="row" style="gap:8px"><input class="input" type="number" name="failThreshold" min="1" max="20" value="${s.failThreshold}" style="max-width:110px"/><span class="muted small">failed checks in a row</span></div>`)}
      ${field("Up again after", html`<div class="row" style="gap:8px"><input class="input" type="number" name="recoverThreshold" min="1" max="20" value="${s.recoverThreshold}" style="max-width:110px"/><span class="muted small">good checks in a row</span></div>`)}
      <div class="span-2">${field("Custom URL", html`<input class="input mono" name="url" value="${s.url || ""}" placeholder="${D.effective.how === "custom" ? "" : D.effective.url || "https://example.com/health"}" autocomplete="off" spellcheck="false"/>`, "Optional. Check this exact address instead of the website's first domain.")}</div>
      <div class="error-box span-2" data-err hidden></div>
    </div></form>`,
    foot: html`<button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit" form="${fid}" data-save>${icon("check")}Save check settings</button>`,
    onMount(el, close) {
      const form = $("form", el), btn = $("[data-save]", el), err = $("[data-err]", el);
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = form.elements;
        showErr(err, ""); setBusy(btn, true);
        try {
          const r = await put(`/api/sites/${S.id}/monitor`, { intervalSec: +f.intervalSec.value, timeoutSec: +f.timeoutSec.value, path: f.path.value.trim(), expect: f.expect.value.trim() || "200-399", failThreshold: +f.failThreshold.value, recoverThreshold: +f.recoverThreshold.value, url: f.url.value.trim() });
          toast("Check settings saved", "ok");
          close(r);
        } catch (ex) { showErr(err, ex.message); setBusy(btn, false); }
      });
    },
  });
  return m.result;
}

/** "Alert settings" modal: this website's text (SMS) and Discord alerts. Resolves with the PUT response after a save. */
export function alertSettingsModal(S, D) {
  const s = D.settings, n = D.notifications, dn = n.discord || { webhooks: [] };
  const skip = new Set(s.discordSkip || []);
  const fid = `alr-${Math.random().toString(36).slice(2, 8)}`;
  const every = n.repeatMinutes === 60 ? "every hour" : `every ${n.repeatMinutes} min`;
  const gap = n.minGapMinutes >= 1 ? `${n.minGapMinutes} minutes` : `${Math.round(n.minGapMinutes * 60)} seconds`;
  const smsWarn = !n.enabled ? html`Text alerts are off for the whole panel, so nothing is sent until they're turned on in <a href="${NOTIF_LINK}" data-close>Settings → Notifications</a>.`
    : !n.configured && !n.dryRun ? html`Twilio isn't fully set up yet — <a href="${NOTIF_LINK}" data-close>finish it in Settings → Notifications</a>.` : "";
  let rcpEd = null;
  const m = openModal({
    title: "Alert settings", sub: `Who hears about it when ${S.name} goes down`, ico: "bell", size: "lg",
    body: html`<form id="${fid}" class="al-form" novalidate>
      <section class="al-sec" data-sec="sms">
        <div class="al-head"><span class="li-ico nch-tile">${icon("message", "sm")}</span>
          <div class="al-title"><b>Text messages</b><span class="muted small">A text when it goes down, ${every} while it stays down${n.notifyRecovery ? ", and one when it's back" : ""}.</span></div>
          <label class="switch"><input type="checkbox" name="smsEnabled" ${s.smsEnabled ? raw("checked") : ""}/><span class="track"></span><span class="sr-only">Send text alerts for this website</span></label></div>
        ${smsWarn ? html`<div class="note warn al-note">${icon("info")}<div>${smsWarn}</div></div>` : ""}
        <div class="al-body form-stack">
          ${field("Numbers for this website", html`<div data-rcp></div>`, "International format (E.164), like +15551234567.")}
          <label class="switch"><input type="checkbox" name="includeDefaults" ${s.includeDefaults !== false ? raw("checked") : ""}/><span class="track"></span><span>Also text the default numbers ${n.defaults?.length ? html`<span class="muted">(${n.defaults.map((d) => d.name || d.phone).join(", ")})</span>` : html`<span class="muted">(none set)</span>`}</span></label>
          ${field("Repeat while down", html`<div class="row" style="gap:8px;flex-wrap:wrap"><input class="input" type="number" name="repeatMinutes" min="1" max="1440" value="${s.repeatMinutes ?? ""}" placeholder="${n.repeatMinutes}" style="max-width:110px"/><span class="muted small">minutes (blank = panel default, ${n.repeatMinutes})</span></div>`, `Each number gets at most one text per ${gap} for this website (the "back up" text is always sent).`)}
        </div>
      </section>
      <section class="al-sec" data-sec="discord">
        <div class="al-head"><span class="li-ico nch-tile discord">${icon("discord", "sm")}</span>
          <div class="al-title"><b>Discord</b><span class="muted small">Posts to Discord channels on the same schedule as the texts.</span></div>
          <label class="switch"><input type="checkbox" name="discordEnabled" ${s.discordEnabled !== false ? raw("checked") : ""} ${dn.webhooks.length ? "" : raw("disabled")}/><span class="track"></span><span class="sr-only">Post Discord alerts for this website</span></label></div>
        <div class="al-body">
          ${dn.webhooks.length ? html`<div class="field"><label>Channels</label><div class="dsc-hooks">${dn.webhooks.map((w) => html`<label class="check dsc-hook"><input type="checkbox" name="hook" value="${w.id}" ${skip.has(w.id) ? "" : raw("checked")}/><span class="dsc-ico">${icon("discord", "sm")}</span><span>${w.name}${!w.enabled ? html` <span class="badge">off in Settings</span>` : !w.ready ? html` <span class="badge warn">no URL</span>` : ""}${w.mention ? html` <span class="muted small">pings on DOWN</span>` : ""}</span></label>`)}</div>
            <div class="hint">Webhooks added later in Settings are included automatically unless you untick them here.</div></div>`
          : html`<div class="note">${icon("info")}<div>No Discord webhooks yet — <a href="${NOTIF_LINK}" data-close>add one in Settings → Notifications</a>.</div></div>`}
        </div>
      </section>
      <p class="hint al-global">${icon("info", "xs")} The Twilio account, default numbers, Discord webhooks and the panel-wide rules (repeat interval, "back up" alerts) are shared by every website — change them in <a href="${NOTIF_LINK}" data-close>Settings → Notifications</a>.</p>
      <div class="error-box" data-err hidden></div>
    </form>`,
    foot: html`<span class="muted small left" data-al-sum></span><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit" form="${fid}" data-save>${icon("check")}Save alerts</button>`,
    onMount(el, close) {
      const form = $("form", el), btn = $("[data-save]", el), err = $("[data-err]", el), f = form.elements;
      rcpEd = recipientsEditor($("[data-rcp]", el), s.recipients || []);
      const sync = () => {
        $('[data-sec="sms"]', el).classList.toggle("is-off", !f.smsEnabled.checked);
        $('[data-sec="discord"]', el).classList.toggle("is-off", !f.discordEnabled.checked || !dn.webhooks.length);
        const parts = [f.smsEnabled.checked ? "Texts on" : "Texts off", dn.webhooks.length ? (f.discordEnabled.checked ? "Discord on" : "Discord off") : ""].filter(Boolean);
        $("[data-al-sum]", el).textContent = parts.join(" · ");
      };
      sync();
      form.addEventListener("change", sync);
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        showErr(err, "");
        let recipients;
        try { recipients = rcpEd.value(); } catch (ex) { showErr(err, ex.message); return; }
        if (f.smsEnabled.checked && !recipients.length && !(f.includeDefaults.checked && n.defaults?.length)) { showErr(err, "Add at least one number, or include the default numbers."); return; }
        const rv = f.repeatMinutes.value.trim();
        const body = { smsEnabled: f.smsEnabled.checked, includeDefaults: f.includeDefaults.checked, recipients, repeatMinutes: rv ? +rv : null };
        if (dn.webhooks.length) Object.assign(body, { discordEnabled: f.discordEnabled.checked, discordSkip: $$('input[name="hook"]', form).filter((c) => !c.checked).map((c) => c.value) });
        setBusy(btn, true);
        try {
          const r = await put(`/api/sites/${S.id}/monitor`, body);
          toast("Alert settings saved", "ok", { msg: [r.settings.smsEnabled ? `Texts on · ${plural((r.recipients || []).length, "number")}` : "Texts off", dn.webhooks.length ? (r.settings.discordEnabled !== false ? "Discord on" : "Discord off") : ""].filter(Boolean).join(" · ") });
          close(r);
        } catch (ex) { showErr(err, ex.message); setBusy(btn, false); }
      });
    },
  });
  return m.result;
}

/* ───────── Settings → Notifications ───────── */

const DISCORD_URL_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d{15,25}\/[A-Za-z0-9_-]{20,128}\/?(?:\?thread_id=\d{15,25})?$/i;
const MENTION_RE = /^(?:@here|@everyone|<@!?\d{15,25}>|<@&\d{15,25}>)$/;

/** Row status for a channel: { tone, label, sub, ready }. */
function twilioStatusOf(s) {
  const key = s.from && s.configured ? `from ${s.from}` : "";
  const nums = plural((s.defaults || []).length, "default number");
  if (s.enabled && s.lastSend && !s.lastSend.ok) return { tone: "err", label: "Error: last send failed", sub: `${s.lastSend.error || "Twilio didn't accept the text"} · ${ago(s.lastSend.at)}`, ready: true };
  if (!s.configured && !s.dryRun) return { tone: "warn", label: "Not set up", sub: s.accountSid || s.authTokenSet ? s.problem || "Finish the Twilio settings" : "Text alerts through Twilio (twilio.com) — add your Account SID and Auth Token", ready: false };
  if (!s.enabled) return { tone: "off", label: "Off", sub: ["Off", key || (s.dryRun ? "dry run" : ""), nums].filter(Boolean).join(" · "), ready: true };
  return { tone: "ok", label: "Active", sub: ["Active", nums, key || (s.dryRun ? "dry run: texts are simulated" : "")].filter(Boolean).join(" · "), ready: true };
}
function discordStatusOf(s) {
  const d = s.discord || { webhooks: [] };
  const hooks = d.webhooks || [];
  if (!hooks.length) return { tone: "warn", label: "Not set up", sub: "Post alerts to a Discord channel with a webhook", ready: false };
  const live = hooks.filter((w) => w.enabled && w.urlHint);
  const failed = live.filter((w) => w.last && !w.last.ok);
  const names = (list) => list.map((w) => w.name).slice(0, 3).join(", ") + (list.length > 3 ? ` +${list.length - 3}` : "");
  if (failed.length) return { tone: "err", label: "Error: last send failed", sub: `${names(failed)}: ${failed[0].last.error || "Discord didn't accept the post"} · ${ago(failed[0].last.at)}`, ready: true };
  if (!live.length) return { tone: "off", label: "Off", sub: `Off · ${plural(hooks.length, "webhook")}${hooks.some((w) => w.urlUnreadable) ? " · a saved URL can't be read" : ""}`, ready: true };
  const mentions = [...new Set(live.map((w) => w.mention).filter(Boolean))];
  return { tone: "ok", label: "Active", sub: `Active · ${plural(live.length, "webhook")} (${names(live)})${mentions.length ? ` · mentions ${mentions.join(" ")}` : ""}${s.dryRun && !d.testEndpoint ? " · dry run: posts are simulated" : ""}`, ready: true };
}

/* ───────── Cluster alerts (docs/HA.md, Phase 3) ─────────
   GET/PATCH /api/notifications/cluster { enabled, sms, discord }; POST …/test. 404 on an older panel → nothing shows. */
const CLUSTER_TRIGGERS = [
  ["layers", "The active panel's server goes down and another panel node takes over."],
  ["layers", "A planned switch of the active panel finishes.", "Discord only"],
  ["server", "The server that went down is back as a standby. Use Make active panel to move the panel back."],
  ["database", "The database replica takes over as the primary."],
  ["alert", "Database replication has stopped with an error for 2 minutes."],
  ["check", "A server becomes the database replica again."],
];
async function clusterAlerts(slot, ctx, notif) {
  let c;
  try { c = await get("/api/notifications/cluster"); } catch { return; }
  if (!c || typeof c !== "object" || !ctx.alive()) return;
  const smsLine = () => {
    const n = notif(), nums = (n.defaults || []).length;
    if (!n.configured && !n.dryRun) return html`<span class="cl-warn">Twilio isn't set up yet</span>`;
    if (!nums) return html`<span class="cl-warn">No default numbers yet</span>`;
    return html`${plural(nums, "default number")}${n.enabled ? "" : html` · <span class="cl-warn">text alerts are off</span>`}${n.dryRun ? " · dry run: simulated" : ""}`;
  };
  const discordLine = () => {
    const live = (notif().discord?.webhooks || []).filter((w) => w.enabled && w.urlHint);
    return live.length ? html`${plural(live.length, "webhook")} · ${live.map((w) => w.name).slice(0, 3).join(", ")}${live.length > 3 ? ` +${live.length - 3}` : ""}` : html`<span class="cl-warn">No enabled webhooks yet</span>`;
  };
  const paint = () => {
    mount(slot, html`<form class="card" data-cluster novalidate>
      <div class="card-head"><div style="flex:1;min-width:0"><h3>Cluster alerts</h3><div class="sub">An alert when the panel or the databases switch servers.</div></div>
        <div class="right"><label class="switch"><input type="checkbox" name="enabled" ${c.enabled !== false ? raw("checked") : ""}/><span class="track"></span><span class="hide-sm">Send cluster alerts</span></label></div></div>
      <div class="card-body">
        <div class="cl-channels" data-cl-ch>
          <label class="cl-ch"><span class="switch"><input type="checkbox" name="sms" ${c.sms !== false ? raw("checked") : ""}/><span class="track"></span></span>
            <span class="li-ico nch-tile">${icon("message", "sm")}</span><span class="cl-ch-t"><b>Text the default numbers</b><span class="muted small">${smsLine()}</span></span></label>
          <label class="cl-ch"><span class="switch"><input type="checkbox" name="discord" ${c.discord !== false ? raw("checked") : ""}/><span class="track"></span></span>
            <span class="li-ico nch-tile discord">${icon("discord", "sm")}</span><span class="cl-ch-t"><b>Post to Discord</b><span class="muted small">${discordLine()}</span></span></label>
        </div>
        <div class="label mt-20" style="margin-bottom:8px">You get an alert when</div>
        <ul class="cl-triggers">${CLUSTER_TRIGGERS.map(([ico, t, note]) => html`<li>${icon(ico, "xs")}<span>${t}${note ? html` <span class="muted">(${note})</span>` : ""}</span></li>`)}</ul>
        <p class="hint mt-16" style="margin-bottom:0">Websites' own alert choices don't apply here: cluster alerts go to the default numbers and every enabled Discord webhook set up above. Each one is also logged in Activity.</p>
        <div class="error-box mt-16" data-err hidden></div>
      </div>
      <div class="card-foot cl-foot"><span class="muted small" data-cl-state></span><span class="spacer"></span>
        <button class="btn" type="button" data-cltest>${icon("bell")}Send test alert</button>
        <button class="btn btn-primary" type="submit" data-save>${icon("check")}Save</button></div>
    </form>`);
    syncOff();
  };
  const syncOff = () => {
    const f = $("[data-cluster]", slot)?.elements; if (!f) return;
    f.sms.disabled = f.discord.disabled = !f.enabled.checked;
    $("[data-cl-ch]", slot).classList.toggle("is-off", !f.enabled.checked);
  };
  paint();
  on(slot, "change", "[data-cluster] input", (e, inp) => { if (inp.name === "enabled") syncOff(); $("[data-cl-state]", slot).textContent = "Unsaved changes"; });
  on(slot, "submit", "[data-cluster]", async (e, form) => {
    e.preventDefault();
    const err = $("[data-err]", form), btn = $("[data-save]", form), f = form.elements;
    showErr(err, ""); setBusy(btn, true);
    try {
      const r = await patch("/api/notifications/cluster", { enabled: f.enabled.checked, sms: f.sms.checked, discord: f.discord.checked });
      c = r && typeof r === "object" && "enabled" in r ? r : { ...c, enabled: f.enabled.checked, sms: f.sms.checked, discord: f.discord.checked };
      toast(c.enabled ? "Cluster alerts saved" : "Cluster alerts turned off", "ok");
      paint();
    } catch (ex) { showErr(err, ex.message); setBusy(btn, false); }
  });
  on(slot, "click", "[data-cltest]", async (e, b) => {
    setBusy(b, true);
    try {
      const r = await post("/api/notifications/cluster/test", {});
      const sent = Array.isArray(r?.sent) ? r.sent : null;
      const bad = sent ? sent.filter((x) => x.ok === false) : [];
      if (sent && !sent.length) toast("Nothing was sent", "warn", { msg: r?.reason || "Turn on a channel with numbers or webhooks, and save first." });
      else if (bad.length) toast("Some test alerts failed", "err", { msg: bad.map((x) => `${x.channel === "discord" ? x.to || "Discord" : x.to}: ${x.error || "not accepted"}`).join(" · ") });
      else if (r?.ok === false) toast("Test alert failed", "err", { msg: r.error || r.reason || "" });
      else {
        const nSms = sent ? sent.filter((x) => x.channel !== "discord").length : 0, nD = sent ? sent.length - nSms : 0;
        toast(sent?.some((x) => x.simulated) || r?.simulated ? "Test alert simulated (dry run)" : "Test alert sent", "ok", sent ? { msg: [nSms ? plural(nSms, "text") : "", nD ? plural(nD, "Discord post") : ""].filter(Boolean).join(" · ") } : {});
      }
    } catch (ex) { toastError(ex, "Couldn't send the test alert"); }
    finally { setBusy(b, false); }
  });
  // channel lines follow the Twilio / Discord settings above
  ctx.on("monitor", debounce((d) => { if (d?.kind === "notifications" && ctx.alive() && !$("[data-cl-state]", slot)?.textContent) paint(); }, 800));
}

export async function notificationsSettings(box, ctx) {
  let s = await get("/api/notifications/settings");
  if (!ctx.alive()) return;
  let defEd = null;
  let openId = null; // the one expanded channel row
  let hooks = []; // Discord editor rows: { id|null, key, name, enabled, url, mention, urlHint, urlSet, urlUnreadable, last, clearUrl }
  let hookSeq = 0;
  const loadHooks = () => { hooks = (s.discord?.webhooks || []).map((w) => ({ ...w, key: `h${++hookSeq}`, url: "", clearUrl: false })); };
  loadHooks();
  const apiLabel = (a) => (a === "messaging-service" ? "Twilio Messaging Service" : "Twilio");
  const CHANNELS = [
    { id: "twilio", title: "Twilio SMS", tile: html`<span class="li-ico nch-tile">${icon("message")}</span>`, status: () => twilioStatusOf(s) },
    { id: "discord", title: "Discord", tile: html`<span class="li-ico nch-tile discord">${icon("discord")}</span>`, status: () => discordStatusOf(s) },
  ];

  const headInner = (c) => {
    const st = c.status();
    const isOpen = openId === c.id;
    return html`${c.tile}
      <span class="li-main"><span class="li-title">${c.title}</span><span class="li-sub">${st.sub}</span></span>
      <span class="li-right"><span class="badge ${st.tone === "off" ? "" : st.tone}">${st.tone === "ok" ? icon("check") : st.tone === "err" ? icon("alert") : ""}${st.tone === "err" ? html`Error<span class="nch-long">: last send failed</span>` : st.label}</span>
        <span class="btn btn-sm nch-btn hide-sm">${isOpen ? "Close" : st.ready ? "Edit" : "Set up"}</span>${icon("chevronDown", "sm nch-chev")}</span>`;
  };

  mount(box, html`
    <div class="card">
      <div class="card-head"><div><h3>Notification channels</h3><div class="sub">Where uptime alerts go. Each website picks which channels it uses under Statistics → Alert settings.</div></div></div>
      <div class="list nch-list">${CHANNELS.map((c) => html`<div class="nch" data-ch="${c.id}">
        <button type="button" class="list-item nch-head" id="nch-h-${c.id}" aria-expanded="false" aria-controls="nch-p-${c.id}" data-nch="${c.id}"></button>
        <div class="nch-panel" id="nch-p-${c.id}" role="region" aria-labelledby="nch-h-${c.id}" inert><div class="nch-inner"><div class="nch-body" data-body="${c.id}"></div></div></div>
      </div>`)}</div>
    </div>
    <form class="card" data-rules novalidate>
      <div class="card-head"><div><h3>Alert rules</h3><div class="sub">Apply to every channel.</div></div></div>
      <div class="card-body" data-rules-body></div>
      <div class="card-foot"><span class="muted small" data-rules-state></span><span class="spacer"></span><button class="btn btn-primary" type="submit" data-save>${icon("check")}Save rules</button></div>
    </form>
    <div data-cluster-slot style="display:contents"></div>
    <form class="card" data-legal novalidate>
      <div class="card-head"><div><h3>SMS compliance pages</h3><div class="sub">Public Privacy Policy and Terms &amp; Conditions pages for your Twilio campaign registration. Anyone can open them — no sign-in.</div></div></div>
      <div class="card-body" data-legal-body></div>
      <div class="card-foot"><span class="muted small" data-legal-state></span><span class="spacer"></span><button class="btn btn-primary" type="submit" data-save>${icon("check")}Save</button></div>
    </form>
    <div class="card" data-optins>
      <div class="card-head"><div><h3>SMS sign-ups</h3><div class="sub">People who opted in on the public sign-up page. Approving one adds the number to the default recipients and texts a confirmation.</div></div></div>
      <div data-optins-body><div class="card-body"><span class="muted small">Loading…</span></div></div>
    </div>`);

  const paintHeads = () => {
    for (const c of CHANNELS) {
      const b = $(`[data-nch="${c.id}"]`, box);
      mount(b, headInner(c));
      const isOpen = openId === c.id;
      b.setAttribute("aria-expanded", String(isOpen));
      b.closest(".nch").classList.toggle("open", isOpen);
      const panel = $(`#nch-p-${c.id}`, box);
      if (isOpen) panel.removeAttribute("inert"); else panel.setAttribute("inert", "");
    }
  };

  const paintRules = () => {
    mount($("[data-rules-body]", box), html`<div class="form-grid">
      ${field("Repeat while down", html`<div class="row" style="gap:8px"><input class="input" type="number" name="repeatMinutes" min="1" max="1440" value="${s.repeatMinutes}" style="max-width:110px"/><span class="muted small">minutes</span></div>`, "Default for every website (a website can override it).")}
      <div class="field"><label>When it's back</label><label class="switch" style="margin-top:8px"><input type="checkbox" name="notifyRecovery" ${s.notifyRecovery ? raw("checked") : ""}/><span class="track"></span>Send a "back up after …" alert</label></div>
      <div class="span-2 hint">At most one alert per ${s.minGapMinutes >= 1 ? `${s.minGapMinutes} minutes` : `${Math.round(s.minGapMinutes * 60)} seconds`} per number or webhook for each website (a website that keeps flapping doesn't flood you); "back up" alerts are always sent.</div>
      <div class="error-box span-2" data-err hidden></div></div>`);
  };

  /* Twilio — SMS through the Messages API. */
  const paintTwilio = () => {
    const badge = s.dryRun ? html`<span class="badge">${icon("info")}Dry run — texts are simulated</span>`
      : s.configured ? html`<span class="badge ok">${icon("check")}${apiLabel(s.api)}</span>` : html`<span class="badge warn">Not set up</span>`;
    mount($('[data-body="twilio"]', box), html`
      <form data-twilio novalidate>
        <div class="nch-row"><label class="switch"><input type="checkbox" name="enabled" ${s.enabled ? raw("checked") : ""}/><span class="track"></span>Send text alerts</label><span class="spacer"></span>${badge}</div>
        <p class="hint" style="margin:0 0 14px">Websites with text alerts on send an SMS through Twilio when they go down, again while they stay down, and when they're back. The Account SID and Auth Token are on the <a href="https://console.twilio.com" target="_blank" rel="noopener noreferrer" style="color:var(--blue-3)">Twilio Console</a> home page; the token is stored encrypted and never shown again.</p>
        <div class="form-grid">
          ${field("Account SID", html`<input class="input mono" name="accountSid" value="${s.accountSid}" placeholder="AC…" autocomplete="off" spellcheck="false"/>`)}
          ${field("Sender", html`<input class="input mono" name="from" value="${s.from}" placeholder="+15557654321 or MG…" autocomplete="off" spellcheck="false"/>`, "A number you own on Twilio, a Messaging Service SID (MG…), an alphanumeric sender ID or a short code.")}
          <div class="span-2">${field(s.authTokenSet ? "Replace Auth Token" : "Auth Token", html`<div class="row" style="gap:10px;flex-wrap:wrap">
              ${s.authTokenSet ? html`<span class="row" style="gap:8px"><span class="li-ico" style="width:32px;height:32px;border-radius:10px;display:grid;place-items:center;background:rgba(148,166,255,.07)">${icon("key", "sm")}</span><span class="mono small">${s.authTokenHint}</span></span>` : ""}
              <div class="pw-wrap" style="flex:1 1 260px"><input class="input mono" type="password" name="authToken" placeholder="${s.authTokenSet ? "Leave blank to keep the saved token" : "Auth Token from the Twilio Console"}" autocomplete="off" spellcheck="false"/><button type="button" class="icon-btn" data-toggle-pw aria-label="Show token">${icon("eye")}</button></div>
              ${s.authTokenSet ? html`<button type="button" class="btn btn-sm btn-danger" data-clear-key>${icon("trash")}Remove</button>` : ""}</div>`,
            s.authTokenUnreadable ? html`<span style="color:#ff8ea3">The saved token can't be decrypted (the panel key changed) — paste it again.</span>` : "")}</div>
          <div class="span-2">${field("Default numbers", html`<div data-defs></div>`, html`Texted for every website with text alerts on (unless the website turns "Also text the default numbers" off).`)}</div>
          <div class="error-box span-2" data-err hidden></div>
          ${s.problem && !s.dryRun && (s.enabled || s.authTokenSet) ? html`<div class="note warn span-2">${icon("info")}<div>${s.problem}</div></div>` : ""}
        </div>
        <div class="nch-foot"><span class="muted small" data-state></span><span class="spacer"></span><button class="btn btn-primary" type="submit" data-save>${icon("check")}Save Twilio settings</button></div>
      </form>
      <form class="nch-test" data-test novalidate>
        <div class="nch-sub-h">Send a test text <span class="muted small">${s.dryRun ? "— dry run: nothing is sent, the text is written to the panel log" : "— uses the saved settings (save first)"}</span></div>
        <div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-start">
          <input class="input mono" name="to" placeholder="+15551234567" inputmode="tel" autocomplete="off" aria-label="Phone number for the test text" style="flex:1 1 220px;max-width:320px"/>
          <button class="btn" type="submit" data-send>${icon("bell")}Send test SMS</button></div>
        <div data-result class="mt-16" hidden></div>
      </form>`);
    defEd = recipientsEditor($("[data-defs]", box), s.defaults || [], { onDirty: () => ($("[data-twilio] [data-state]", box).textContent = "Unsaved changes") });
  };

  /* Discord — webhooks list editor. */
  const lastLine = (w) => {
    if (!w.last) return w.id ? "Nothing sent yet" : "Not saved yet";
    const when = ago(w.last.at);
    if (!w.last.ok) return html`<span style="color:#ff8ea3">${icon("alert", "xs")} Last ${w.last.test ? "test " : ""}post failed ${when}: ${w.last.error || "unknown error"}</span>`;
    return html`<span>${icon("check", "xs")} Last ${w.last.test ? "test " : ""}post ${w.last.simulated ? "simulated" : "delivered"} ${when}</span>`;
  };
  const paintDiscord = () => {
    const d = s.discord || {};
    mount($('[data-body="discord"]', box), html`
      <form data-discord novalidate>
        <p class="hint" style="margin:0 0 14px">In Discord: channel <b>Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL</b>. Anyone with the URL can post to the channel, so it's stored encrypted and never shown again. ${s.dryRun ? (d.testEndpoint ? html`<b>Dry run:</b> posts go to the local test endpoint.` : html`<b>Dry run:</b> nothing is posted — posts are written to the panel log.`) : ""}</p>
        <div class="dwh-list">${hooks.map((w, i) => html`<div class="dwh" data-hk="${w.key}">
          <div class="dwh-top">
            <input class="input" data-f="name" value="${w.name}" placeholder="Name, like #alerts" maxlength="60" aria-label="Webhook name" autocomplete="off"/>
            <label class="switch"><input type="checkbox" data-f="enabled" ${w.enabled !== false ? raw("checked") : ""}/><span class="track"></span><span class="hide-sm">Enabled</span></label>
            <button type="button" class="icon-btn ghost sm" data-rmhook="${w.key}" aria-label="Remove ${w.name || `webhook ${i + 1}`}">${icon("trash", "sm")}</button>
          </div>
          <div class="form-grid">
            <div class="span-2">${field(w.urlSet ? "Replace webhook URL" : "Webhook URL", html`<div class="row" style="gap:10px;flex-wrap:wrap">
              ${w.urlSet && !w.clearUrl ? html`<span class="row" style="gap:8px"><span class="li-ico dwh-key">${icon("link", "sm")}</span><span class="mono small">${w.urlHint || "can't be read — paste it again"}</span></span>` : ""}
              <input class="input mono" type="password" data-f="url" value="${w.url}" style="flex:1 1 260px" placeholder="${w.urlSet && !w.clearUrl ? "Leave blank to keep the saved URL" : "https://discord.com/api/webhooks/…"}" autocomplete="off" spellcheck="false" aria-label="Webhook URL"/></div>`)}</div>
            ${field("Mention on DOWN", html`<input class="input mono" data-f="mention" value="${w.mention || ""}" placeholder="@here or <@&roleId>" autocomplete="off" spellcheck="false"/>`, "Optional. @here, @everyone, <@userId> or <@&roleId>. Only the first DOWN alert pings.")}
            <div class="field"><label>Status</label><div class="dwh-last small muted">${lastLine(w)}</div></div>
          </div>
          <div class="dwh-foot"><span class="spacer"></span><button type="button" class="btn btn-sm" data-testhook="${w.id || ""}" ${w.id && w.urlSet ? "" : raw('disabled title="Save the webhook first"')}>${icon("discord")}Send test</button></div>
          <div data-hres hidden></div>
        </div>`)}</div>
        ${hooks.length ? "" : html`<p class="muted small" style="margin:0 0 10px">No webhooks yet.</p>`}
        <button type="button" class="btn btn-sm" data-addhook ${hooks.length >= (d.max || 10) ? raw("disabled") : ""}>${icon("plus")}Add webhook</button>
        <div class="error-box mt-16" data-err hidden></div>
        <div class="nch-foot"><span class="muted small" data-state></span><span class="spacer"></span><button class="btn btn-primary" type="submit" data-save>${icon("check")}Save Discord settings</button></div>
      </form>`);
  };

  paintHeads(); paintRules(); paintTwilio(); paintDiscord();

  const toggle = (id) => {
    openId = openId === id ? null : id;
    paintHeads();
    if (openId) {
      const body = $(`[data-body="${openId}"]`, box);
      if (openId === "discord" && !hooks.length) { hooks.push({ id: null, key: `h${++hookSeq}`, name: "", enabled: true, url: "", mention: "", urlSet: false }); paintDiscord(); }
      setTimeout(() => body.closest(".nch")?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }), 260);
    }
  };
  on(box, "click", "[data-nch]", (e, b) => toggle(b.dataset.nch));

  const reload = debounce(async () => {
    try { s = { ...s, ...(await get("/api/notifications/settings")) }; if (ctx.alive()) { paintHeads(); for (const w of hooks) { const f = (s.discord?.webhooks || []).find((x) => x.id === w.id); if (f) { w.last = f.last; const el = $(`[data-hk="${w.key}"] .dwh-last`, box); if (el) mount(el, lastLine(w)); } } } } catch {}
  }, 500);
  ctx.on("monitor", (d) => { if (d?.kind === "notifications" || d?.kind === "sms") reload(); });

  /* SMS compliance pages (server: lib/legal.mjs) */
  const paintLegal = () => {
    const l = s.legal || {};
    const local = /^https?:\/\/(localhost|127\.|\d+\.\d+\.\d+\.\d+|\[)/.test(l.privacyUrl || "");
    const link = (label, url) => html`<div class="field span-2"><label>${label}</label><div class="input-group"><input class="input mono" value="${url}" readonly/><a class="btn" href="${url}" target="_blank" rel="noopener noreferrer">${icon("external")}Open</a><button class="btn" type="button" data-copy="${url}">${icon("copy")}Copy</button></div></div>`;
    mount($("[data-legal-body]", box), html`<div class="form-grid">
      ${field("Brand name", html`<input class="input" name="brandName" value="${l.brandName}" placeholder="${l.brandShown}" maxlength="120" autocomplete="organization"/>`, "Exactly as registered with Twilio (your A2P brand). Empty uses the panel name.")}
      ${field("Support email", html`<input class="input" name="contactEmail" type="email" value="${l.contactEmail}" placeholder="support@example.com" maxlength="200" autocomplete="email"/>`, "Shown on both pages for questions and help. Optional.")}
      ${link("Privacy Policy", l.privacyUrl)}
      ${link("Terms & Conditions", l.termsUrl)}
      ${link("Opt-in (sign-up) page", l.optInUrl)}
      <div class="span-2 hint">For Twilio's <b>opt-in method proof</b>, give the sign-up page link (or a screenshot of it). Sample confirmation text: <span class="mono">${l.brandShown}: You're signed up for website alerts. Msg frequency varies. Msg &amp; data rates may apply. Reply HELP for help, STOP to opt out.</span></div>
      ${local ? html`<div class="note warn span-2">${icon("alert")}<div>These links use a local address, so Twilio can't open them. Give the panel a public hostname or set the Panel URL in Settings → General, then copy them again.</div></div>` : ""}
      <div class="error-box span-2" data-err hidden></div></div>`);
  };
  paintLegal();
  clusterAlerts($("[data-cluster-slot]", box), ctx, () => s); // renders nothing on a panel without cluster alerts
  /* SMS sign-ups (opt-ins from the public page) */
  let optins = null;
  const OPT_BADGE = { pending: ["warn", "Waiting for approval"], approved: ["ok", "Approved"], declined: ["", "Declined"], "opted-out": ["", "Opted out"] };
  const paintOptins = () => {
    const el = $("[data-optins-body]", box);
    if (!optins) return;
    if (!optins.length) return mount(el, html`<div class="card-body">${emptyState({ ico: "message", title: "No sign-ups yet", text: "Share the sign-up page link above with the people who should get alert texts.", sm: true })}</div>`);
    // Ones waiting for approval first, so they never end up behind "Show all".
    const ordered = [...optins.filter((r) => r.status === "pending"), ...optins.filter((r) => r.status !== "pending")];
    mount(el, moreList(ordered, (r) => {
      const [tone, label] = OPT_BADGE[r.status] || ["", r.status];
      const conf = r.confirmation;
      return html`<div class="list-item cf-row">
        <span class="li-ico">${icon("message", "sm")}</span>
        <div class="li-main"><div class="li-title">${r.name || "—"} <span class="mono muted small">${r.phone}</span></div>
          <div class="li-sub">Opted in ${ago(r.consent?.at || r.createdAt)}${r.decidedBy ? html` · ${r.status} by ${r.decidedBy}` : ""}${r.status === "approved" ? (conf?.ok ? html` · confirmation sent${conf.simulated ? " (simulated)" : ""}` : conf ? html` · <span class="cf-err">confirmation failed: ${conf.error}</span>` : "") : ""}${r.status === "approved" && !r.recipient ? " · not a default recipient" : ""}</div></div>
        <div class="li-right">
          <span class="badge ${tone}">${label}</span>
          ${r.status === "pending" ? html`<button class="btn btn-sm btn-primary" data-optapprove="${r.id}">${icon("check")}Approve</button><button class="btn btn-sm" data-optdecline="${r.id}">Decline</button>` : ""}
          <button class="icon-btn ghost sm" data-optmenu="${r.id}" aria-label="More for ${r.name || r.phone}">${icon("more", "sm")}</button>
        </div></div>`;
    }, { id: "notify.optins", limit: 6, cls: "list", noun: "sign-ups" }));
  };
  const loadOptins = async () => {
    try { const r = await get("/api/notifications/optins"); optins = r.items || []; if (ctx.alive()) paintOptins(); }
    catch (ex) { mount($("[data-optins-body]", box), html`<div class="card-body"><div class="error-box">${icon("alert")}<div>${ex.message}</div></div></div>`); }
  };
  loadOptins();
  ctx.on("monitor", (d) => { if (d?.kind === "optins") loadOptins(); });
  const refreshAfterApprove = async () => {
    try { s = { ...s, ...(await get("/api/notifications/settings")) }; } catch {}
    paintHeads();
    if (openId === "twilio" && !$("[data-twilio] [data-state]", box)?.textContent) paintTwilio();
  };
  const approve = async (id, b) => {
    setBusy(b, true);
    try {
      const r = await post(`/api/notifications/optins/${id}/approve`, { addToDefaults: true });
      if (r.warning) toast("Approved — confirmation not sent", "warn", { msg: r.warning }); else toast("Approved", "ok", { msg: `${r.optIn.name || r.optIn.phone} now gets alert texts.` });
      await loadOptins(); refreshAfterApprove();
    } catch (ex) { toastError(ex, "Couldn't approve"); setBusy(b, false); }
  };
  on(box, "click", "[data-optapprove]", (e, b) => approve(b.dataset.optapprove, b));
  on(box, "click", "[data-optdecline]", async (e, b) => {
    setBusy(b, true);
    try { await post(`/api/notifications/optins/${b.dataset.optdecline}/decline`); toast("Declined", "ok"); loadOptins(); }
    catch (ex) { toastError(ex, "Couldn't decline"); setBusy(b, false); }
  });
  on(box, "click", "[data-optmenu]", (e, b) => {
    const r = (optins || []).find((x) => x.id === b.dataset.optmenu);
    if (!r) return;
    openMenu(b, [
      { label: "View consent record", icon: "fileText", onClick: () => openModal({ title: "Consent record", ico: "fileText",
        body: html`<dl class="kv">
          <dt>Name</dt><dd>${r.name || "—"}</dd><dt>Mobile number</dt><dd class="mono">${r.phone}</dd>
          <dt>Opted in</dt><dd>${fmtDate(r.consent?.at)} <span class="muted small mono">${r.consent?.at || ""}</span></dd>
          <dt>Page</dt><dd class="mono">${r.consent?.page || "/sms-alerts"}</dd>
          <dt>IP address</dt><dd class="mono">${r.consent?.ip || "—"}</dd><dt>Browser</dt><dd class="small">${r.consent?.userAgent || "—"}</dd>
          <dt>Status</dt><dd>${(OPT_BADGE[r.status] || ["", r.status])[1]}${r.decidedAt ? html` · ${fmtDate(r.decidedAt)}${r.decidedBy ? html` by ${r.decidedBy}` : ""}` : ""}</dd>
          ${r.confirmation ? html`<dt>Confirmation text</dt><dd>${r.confirmation.ok ? `Sent ${fmtDate(r.confirmation.at)}${r.confirmation.simulated ? " (simulated)" : ""}` : `Failed: ${r.confirmation.error}`}</dd>` : ""}
        </dl>
        <div class="label mt-16">They agreed to</div><p class="small" style="margin:6px 0 0">${r.consent?.text || ""}</p>`,
        foot: html`<button class="btn btn-primary" data-close>Close</button>` }) },
      ...(r.status !== "pending" && r.status !== "approved" ? [{ label: "Approve", icon: "check", onClick: () => approve(r.id) }] : []),
      { sep: true },
      { label: "Remove record", icon: "trash", danger: true, onClick: async () => {
        const ok = await confirmDialog({ title: `Remove ${r.name || r.phone}'s sign-up?`, danger: true, confirmText: "Remove",
          message: "Deletes the sign-up and its consent record. It does not remove the number from your recipients — do that in the Twilio SMS settings." });
        if (!ok) return;
        try { await del(`/api/notifications/optins/${r.id}`); toast("Sign-up removed", "ok"); loadOptins(); } catch (ex) { toastError(ex, "Couldn't remove it"); }
      } },
    ]);
  });

  on(box, "input", "[data-legal]", () => ($("[data-legal-state]", box).textContent = "Unsaved changes"));
  on(box, "click", "[data-copy]", async (e, b) => { try { await copyText(b.dataset.copy); toast("Link copied", "ok"); } catch (ex) { toastError(ex, "Couldn't copy"); } });
  on(box, "submit", "[data-legal]", async (e, form) => {
    e.preventDefault();
    const err = $("[data-err]", form), btn = $("[data-save]", form), f = form.elements;
    showErr(err, ""); setBusy(btn, true);
    try {
      s = await put("/api/notifications/settings", { legal: { brandName: f.brandName.value.trim(), contactEmail: f.contactEmail.value.trim() } });
      toast("Compliance pages updated", "ok");
      paintLegal(); $("[data-legal-state]", box).textContent = "";
    } catch (ex) { showErr(err, ex.message); } finally { setBusy(btn, false); }
  });

  /* rules */
  on(box, "input", "[data-rules]", () => ($("[data-rules-state]", box).textContent = "Unsaved changes"));
  on(box, "submit", "[data-rules]", async (e, form) => {
    e.preventDefault();
    const err = $("[data-err]", form), btn = $("[data-save]", form), f = form.elements;
    showErr(err, ""); setBusy(btn, true);
    try {
      s = await put("/api/notifications/settings", { repeatMinutes: +f.repeatMinutes.value || 60, notifyRecovery: f.notifyRecovery.checked });
      toast("Alert rules saved", "ok");
      paintRules(); paintHeads(); $("[data-rules-state]", box).textContent = "";
    } catch (ex) { showErr(err, ex.message); } finally { setBusy(btn, false); }
  });

  /* twilio */
  on(box, "input", "[data-twilio]", () => ($("[data-twilio] [data-state]", box).textContent = "Unsaved changes"));
  on(box, "click", "[data-toggle-pw]", (e, b) => {
    const inp = b.parentElement.querySelector("input");
    inp.type = inp.type === "password" ? "text" : "password";
    mount(b, html`${icon(inp.type === "password" ? "eye" : "eyeOff")}`);
  });
  on(box, "submit", "[data-twilio]", async (e, form) => {
    e.preventDefault();
    const err = $("[data-err]", form), btn = $("[data-save]", form), f = form.elements;
    showErr(err, "");
    let defaults;
    try { defaults = defEd.value(); } catch (ex) { showErr(err, ex.message); return; }
    const body = { enabled: f.enabled.checked, defaults, accountSid: f.accountSid.value.trim(), from: f.from.value.trim() };
    if (f.authToken.value.trim()) body.authToken = f.authToken.value.trim();
    setBusy(btn, true);
    try {
      s = await put("/api/notifications/settings", body);
      if (s.warning) toast("Saved — but not ready yet", "warn", { msg: s.warning }); else toast("Twilio settings saved", "ok");
      paintTwilio(); paintHeads();
    } catch (ex) { showErr(err, ex.message); setBusy(btn, false); }
  });
  on(box, "click", "[data-clear-key]", async (e, b) => {
    const ok = await confirmDialog({ title: "Remove the Twilio Auth Token?", message: "No text messages can be sent until you add a token again.", danger: true, confirmText: "Remove token" });
    if (!ok) return;
    setBusy(b, true);
    try { s = await put("/api/notifications/settings", { clearAuthToken: true }); toast("Auth Token removed", "ok"); paintTwilio(); paintHeads(); }
    catch (ex) { toastError(ex, "Couldn't remove the token"); setBusy(b, false); }
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
      mount(out, r.ok ? html`<div class="note">${icon("check")}<div>${r.simulated ? html`Simulated (dry run) — the panel log shows: <span class="mono">${r.text}</span>` : html`Twilio accepted the text to <span class="mono">${r.to}</span>${r.messageId ? html` (id <span class="mono">${r.messageId}</span>)` : ""}. It should arrive within a minute.`}</div></div>`
        : html`<div class="error-box">${icon("alert")}<div>${r.error || "Twilio didn't accept the text."}</div></div>`);
      reload();
    } catch (ex) { out.hidden = false; mount(out, html`<div class="error-box">${icon("alert")}<div>${ex.message}</div></div>`); }
    finally { setBusy(btn, false); }
  });

  /* discord */
  const hookOf = (el) => hooks.find((w) => w.key === el.closest("[data-hk]")?.dataset.hk);
  const dirtyDiscord = () => { const el = $("[data-discord] [data-state]", box); if (el) el.textContent = "Unsaved changes"; };
  on(box, "input", "[data-discord] [data-f]", (e, inp) => {
    const w = hookOf(inp); if (!w) return;
    w[inp.dataset.f] = inp.type === "checkbox" ? inp.checked : inp.value;
    dirtyDiscord();
  });
  on(box, "change", "[data-discord] [data-f]", (e, inp) => { const w = hookOf(inp); if (w && inp.type === "checkbox") { w.enabled = inp.checked; dirtyDiscord(); } });
  on(box, "click", "[data-addhook]", () => {
    hooks.push({ id: null, key: `h${++hookSeq}`, name: "", enabled: true, url: "", mention: "", urlSet: false });
    paintDiscord(); dirtyDiscord();
    $$('[data-discord] [data-f="name"]', box).pop()?.focus();
  });
  on(box, "click", "[data-rmhook]", async (e, b) => {
    const w = hooks.find((x) => x.key === b.dataset.rmhook);
    if (!w) return;
    if (w.id && !(await confirmDialog({ title: `Remove ${w.name || "this webhook"}?`, message: "Alerts stop going to that channel once you save. The webhook itself stays in Discord.", danger: true, confirmText: "Remove" }))) return;
    hooks = hooks.filter((x) => x !== w);
    paintDiscord(); dirtyDiscord();
  });
  on(box, "submit", "[data-discord]", async (e, form) => {
    e.preventDefault();
    const err = $("[data-err]", form), btn = $("[data-save]", form);
    showErr(err, "");
    const list = [];
    for (const [i, w] of hooks.entries()) {
      const label = w.name.trim() || `Webhook ${i + 1}`;
      const url = (w.url || "").trim();
      if (!w.id && !url) { showErr(err, `${label}: paste the webhook URL.`); return; }
      if (url && !DISCORD_URL_RE.test(url)) { showErr(err, `${label}: that isn't a Discord webhook URL — it should look like https://discord.com/api/webhooks/123…/abc…`); return; }
      const mention = (w.mention || "").trim();
      if (mention && !mention.split(/[\s,]+/).every((m) => MENTION_RE.test(m))) { showErr(err, `${label}: the mention must be @here, @everyone, <@userId> or <@&roleId>.`); return; }
      const item = { name: w.name.trim(), enabled: w.enabled !== false, mention };
      if (w.id) item.id = w.id;
      if (url) item.url = url;
      list.push(item);
    }
    setBusy(btn, true);
    try {
      s = await put("/api/notifications/settings", { discord: { webhooks: list } });
      toast("Discord settings saved", "ok");
      loadHooks(); paintDiscord(); paintHeads();
    } catch (ex) { showErr(err, ex.message); setBusy(btn, false); }
  });
  on(box, "click", "[data-testhook]", async (e, b) => {
    const w = hookOf(b); if (!w?.id) return;
    const out = $("[data-hres]", b.closest("[data-hk]"));
    setBusy(b, true);
    try {
      const r = await post("/api/notifications/test", { channel: "discord", webhookId: w.id });
      out.hidden = false;
      mount(out, r.ok ? html`<div class="note">${icon("check")}<div>${r.simulated ? "Simulated (dry run) — the panel log shows the post." : html`Posted to ${w.name}${r.attempts > 1 ? ` (after ${r.attempts} attempts)` : ""}. Check the channel.`}</div></div>`
        : html`<div class="error-box">${icon("alert")}<div>${r.error || "Discord didn't accept the post."}</div></div>`);
      reload();
    } catch (ex) { out.hidden = false; mount(out, html`<div class="error-box">${icon("alert")}<div>${ex.message}</div></div>`); }
    finally { setBusy(b, false); }
  });
}
