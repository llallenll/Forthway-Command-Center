// Testing hub: #/tests — every website's commit tests in one place (docs/DOCKER-AND-TESTS.md §2–3).
// GET /api/tests (summaries newest first + header stats), GET /api/tester (is it set up?), live over
// SSE `testrun` (full run on every change, `deleted: true` on delete). Running tests get a live mini
// card (category rings + progress) patched in place, like the test page itself (views/test-run.js).
import { html, raw, mount, frag, $, on, ago, fmtDate, fmtDuration, plural, emptyState, errorState, skeletonRows, debounce, toast, openModal } from "../util.js";
import { icon } from "../icons.js";
import { get } from "../api.js";
import { pageHead, typeIco } from "../components.js";
import { CATS, isActive, statusLabel, commitShort, verdictBadge, latestByRelease, startTest } from "./site-tests.js";

const SEV = [["critical", "Critical"], ["high", "High"], ["medium", "Medium"], ["low", "Low"], ["info", "Info"]];
const FILTERS = [
  ["all", "All", () => true],
  ["active", "Running", (r) => isActive(r)],
  ["ready", "Ready", (r) => r.status === "done" && r.verdict === "ready"],
  ["not_ready", "Not ready", (r) => r.status === "done" && r.verdict === "not_ready"],
  ["failed", "Failed / cancelled", (r) => r.status === "error" || r.status === "cancelled"],
];
const STAGE = { queued: "Waiting for a tester", preparing: "Building the copy", testing: "Claude is testing", reporting: "Writing the report" };
const FINISHED = new Set(["pass", "warn", "fail", "skip"]);
const R_MINI = 15, C_MINI = 2 * Math.PI * R_MINI;
const R_AVG = 22, C_AVG = 2 * Math.PI * R_AVG;
const DONE_LINGER = 12000; // a card that just finished shows its verdict this long, then folds away
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const clock = (ms) => {
  if (ms == null || ms < 0) return "00:00";
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : String(m).padStart(2, "0")) + ":" + String(x).padStart(2, "0");
};
const elapsed = (r) => {
  const t0 = r.startedAt || r.createdAt;
  return t0 ? (r.finishedAt ? new Date(r.finishedAt) : new Date()) - new Date(t0) : 0;
};
const sevCounts = (r) => {
  if (r.counts?.bySeverity) return r.counts.bySeverity;
  const c = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of r.findings || []) if (f.severity in c) c[f.severity]++;
  return c;
};

export default async function tests(ctx) {
  const { root, query } = ctx;
  ctx.crumbs([{ label: "Testing" }]);
  let filter = FILTERS.some(([k]) => k === query.filter) ? query.filter : "all";
  let siteFilter = query.siteId || "", q = "";
  let items = [], stats = null, tester = null, sites = [];
  const full = new Map(); // runId -> full run (checks) for the live cards
  const cards = new Map(); // runId -> { el, timer }

  mount(root, html`<div class="th-page">
    ${pageHead("Testing", "Before a commit goes live, Claude Code tries it on a throw-away copy of the website — its own empty database, captured email, no live payment keys — and says whether it's ready for production.",
      html`<a class="btn btn-ghost" href="#/settings/testing">${icon("settings")}Settings</a><button class="btn btn-primary" data-new>${icon("flask")}Test a release</button>`)}
    <div data-setupnote></div>
    <section class="th-stats" data-stats>${Array.from({ length: 5 }, () => html`<div class="skel" style="height:104px;border-radius:18px"></div>`)}</section>
    <section class="th-live" data-live hidden><div class="th-sec-h"><span class="tr-live" data-livelabel><span class="dot run"></span>Running now</span><span class="muted small" data-livecount></span></div><div class="th-live-grid" data-livegrid></div></section>
    <section class="th-runs">
      <div class="toolbar"><div class="pills" data-pills role="tablist" aria-label="Filter test runs"></div><span class="grow"></span>
        <select class="select" data-site style="width:auto;min-width:170px" aria-label="Filter by website"><option value="">All websites</option></select>
        <div class="search">${icon("search")}<input placeholder="Commit, version or message" data-q aria-label="Search test runs"/></div></div>
      <div data-list>${skeletonRows(6, 56)}</div>
    </section>
    <section class="th-info" data-info></section>
  </div>`);
  const listEl = $("[data-list]", root);

  /* ── load ── */
  try {
    const [t, tr, s] = await Promise.all([get("/api/tests?limit=300"), get("/api/tester").catch(() => null), get("/api/sites").catch(() => ({ items: [] }))]);
    items = t.items || []; stats = t.stats || null; tester = tr; sites = s.items || [];
  } catch (e) {
    if (!ctx.alive()) return;
    mount(listEl, errorState(e));
    $("[data-retry]", root)?.addEventListener("click", ctx.reload);
    mount($("[data-stats]", root), html``);
    return;
  }
  if (!ctx.alive()) return;
  // Full records for runs already going (summaries carry no checklist).
  await Promise.all(items.filter(isActive).map((r) => get(`/api/tests/${r.id}`).then((x) => full.set(x.id, x)).catch(() => {})));
  if (!ctx.alive()) return;

  /* ── painters ── */
  const siteName = (r) => r.siteName || sites.find((s) => s.id === r.siteId)?.name || "website";
  const siteType = (r) => r.siteType || sites.find((s) => s.id === r.siteId)?.type;

  const paintSetupNote = () => mount($("[data-setupnote]", root), tester && !tester.tokenSet ? html`<div class="note warn th-setup-note">${icon("alert")}<div style="flex:1;min-width:0">
      <strong>Testing isn't set up yet</strong><div class="small muted mt-8">Add a Claude Code token so tests can run: run <span class="mono">claude setup-token</span> on your own computer and paste the token in Settings → Website testing. Tests use your Claude subscription.</div></div>
      <a class="btn btn-sm btn-primary" href="#/settings/testing">${icon("key")}Add the token</a></div>` : html``);

  const paintStats = () => {
    const s = stats || {};
    const rate = s.readyRate, avg = s.avgScore;
    const tile = (ico, tone, label, big, cap, extra = "") => html`<div class="th-stat ${tone}"><div class="th-stat-h"><span class="th-stat-ico">${icon(ico, "sm")}</span>${label}</div>
      <div class="th-stat-b"><div><div class="th-big num">${big}</div><div class="th-cap">${cap}</div></div>${extra}</div></div>`;
    const avgRing = avg == null ? "" : html`<svg class="th-avg ${avg >= 70 ? "ok" : "err"}" viewBox="0 0 52 52" aria-hidden="true"><circle class="trk" cx="26" cy="26" r="${R_AVG}"/><circle class="arc" cx="26" cy="26" r="${R_AVG}" stroke-dasharray="${C_AVG.toFixed(2)}" stroke-dashoffset="${(C_AVG * (1 - avg / 100)).toFixed(2)}"/></svg>`;
    const split = s.judged7d ? html`<div class="th-split" aria-hidden="true"><i class="ok" style="width:${((s.ready7d / s.judged7d) * 100).toFixed(1)}%"></i><i class="err" style="width:${((s.notReady7d / s.judged7d) * 100).toFixed(1)}%"></i></div>` : "";
    const runningNames = [...new Set(items.filter(isActive).map(siteName))];
    mount($("[data-stats]", root), html`
      ${tile("flask", "", "Runs this week", s.last7d ?? 0, s.total ? `${plural(s.total, "run")} kept in all${s.failed7d ? ` · ${s.failed7d} couldn't run` : ""}` : "No tests yet")}
      ${tile("check", "ok", "Ready rate", rate == null ? "—" : html`${rate}<small>%</small>`, s.judged7d ? `${s.ready7d} ready · ${s.notReady7d} not ready, last 7 days` : "No verdicts in the last 7 days", split)}
      ${tile("gauge", "blue", "Average score", avg == null ? "—" : html`${avg}<small>/100</small>`, s.judged7d ? `Over ${plural(s.judged7d, "finished run")}, 7 days` : "Appears after the first verdict", avgRing)}
      ${tile("zap", s.active ? "on-air" : "", "Running now", s.active || 0, s.active ? runningNames.slice(0, 2).join(", ") + (runningNames.length > 2 ? ` +${runningNames.length - 2}` : "") : "Nothing running", s.active ? html`<span class="th-pulse" aria-hidden="true"></span>` : "")}
      ${tile("globe", s.sitesNeverTested ? "warn" : "", "Never tested", s.sitesNeverTested ?? 0, s.sites ? `of ${plural(s.sites, "website")}` : "No websites yet")}`);
  };

  /* live mini cards — built once per run, then patched so the rings animate per change */
  const cardHTML = (r) => html`<a class="th-card" href="#/tests/${r.id}" data-card="${r.id}">
      <span class="th-card-fx" aria-hidden="true"></span>
      <div class="th-card-top">${typeIco(siteType(r), "th-type")}<div class="th-card-id"><div class="strong ellipsis">${siteName(r)}</div>
        <div class="th-card-commit">${icon("github", "xs")}<span class="mono">${commitShort(r) || "—"}</span>${r.version ? html`<span class="badge mono">v${r.version}</span>` : ""}<span class="ellipsis muted">${r.commit?.message || ""}</span></div></div>
        <div class="th-card-clock"><span>Elapsed</span><b class="num" data-clock>00:00</b></div></div>
      <div class="th-card-phase"><span class="th-card-phase-t" data-phase aria-live="polite"></span><span class="num muted" data-progress></span></div>
      <div class="tr-bar" data-bar><div></div></div>
      <div class="th-rings">${CATS.map((c) => html`<span class="th-ring" data-cat="${c.id}" style="--c:${c.color}" title="${c.label}"><svg viewBox="0 0 40 40" aria-hidden="true"><circle class="trk" cx="20" cy="20" r="${R_MINI}"/><circle class="arc" cx="20" cy="20" r="${R_MINI}" stroke-dasharray="${C_MINI.toFixed(2)}" stroke-dashoffset="${C_MINI.toFixed(2)}"/></svg><span class="th-ring-i">${icon(c.icon, "xs")}</span><span class="th-ring-l">${c.label}</span></span>`)}</div>
      <div class="th-card-foot"><span data-stage></span><span class="th-watch">Watch live${icon("arrowRight", "xs")}</span></div></a>`;
  const patchCard = (el, r) => {
    const active = isActive(r);
    const checks = r.checks || [];
    const fin = checks.filter((x) => FINISHED.has(x.status)).length;
    el.classList.toggle("is-live", active);
    el.classList.toggle("is-done", !active);
    el.classList.toggle("v-ready", !active && r.verdict === "ready");
    el.classList.toggle("v-bad", !active && r.status === "done" && r.verdict !== "ready");
    el.classList.toggle("v-stop", r.status === "error" || r.status === "cancelled");
    $("[data-clock]", el).textContent = clock(elapsed(r));
    $("[data-phase]", el).textContent = active ? r.phase || `${statusLabel(r.status)}…`
      : r.status === "done" ? `${r.verdict === "ready" ? "Ready for production" : "Not ready for production"}${r.score != null ? ` · ${r.score}/100` : ""}`
      : r.status === "cancelled" ? "Cancelled" : r.error || "The test couldn't finish";
    $("[data-progress]", el).textContent = checks.length ? `${fin} / ${checks.length}` : "";
    const bar = $("[data-bar]", el);
    bar.classList.toggle("indet", active && !checks.length);
    $("div", bar).style.width = (checks.length ? (fin / checks.length) * 100 : r.status === "done" ? 100 : 0).toFixed(1) + "%";
    const by = {};
    for (const x of checks) (by[x.category] ||= []).push(x);
    for (const c of CATS) {
      const ring = $(`[data-cat="${c.id}"]`, el), list = by[c.id] || [];
      const f = list.filter((x) => FINISHED.has(x.status)).length;
      const done = list.length && f === list.length;
      const bad = list.some((x) => x.status === "fail"), warn = list.some((x) => x.status === "warn");
      ring.className = `th-ring${list.some((x) => x.status === "running") ? " is-active" : ""}${done ? (bad ? " is-fail" : warn ? " is-warn" : " is-ok") : ""}${list.length ? "" : " is-empty"}`;
      $(".arc", ring).setAttribute("stroke-dashoffset", (C_MINI * (1 - (list.length ? f / list.length : 0))).toFixed(2));
      ring.title = `${c.label}: ${list.length ? `${f}/${list.length} checks` : active ? "waiting" : "not checked"}`;
    }
    $("[data-stage]", el).textContent = active ? STAGE[r.status] || statusLabel(r.status) : r.status === "done" ? (r.findings?.length || r.counts?.findings ? plural(r.findings?.length ?? r.counts.findings, "finding") : "No findings") : "Nothing was deployed";
    $(".th-watch", el).firstChild.textContent = active ? "Watch live" : "Open the report";
  };
  const dropCard = (id) => {
    const c = cards.get(id);
    if (!c) return;
    clearTimeout(c.timer);
    cards.delete(id);
    if (reduced()) c.el.remove();
    else { c.el.classList.add("th-out"); setTimeout(() => c.el.remove(), 450); }
    setTimeout(paintLiveHead, 460);
  };
  const paintLiveHead = () => {
    const n = [...cards.keys()].filter((id) => isActive(full.get(id) || items.find((x) => x.id === id))).length;
    $("[data-live]", root).hidden = !cards.size;
    $("[data-livecount]", root).textContent = n ? plural(n, "test") + " in progress" : "";
    const lab = $("[data-livelabel]", root);
    lab.classList.toggle("idle", !n);
    lab.lastChild.textContent = n ? "Running now" : "Just finished";
  };
  const paintLive = () => {
    const grid = $("[data-livegrid]", root);
    for (const r of items.filter(isActive)) {
      const run = full.get(r.id) || r;
      let c = cards.get(r.id);
      if (!c) { c = { el: frag(cardHTML(run)), timer: null }; grid.prepend(c.el); cards.set(r.id, c); }
      patchCard(c.el, run);
    }
    for (const [id, c] of cards) {
      const r = full.get(id) || items.find((x) => x.id === id);
      if (!r) { dropCard(id); continue; }
      if (!isActive(r)) {
        patchCard(c.el, r);
        if (!c.timer) c.timer = setTimeout(() => dropCard(id), DONE_LINGER);
      }
    }
    paintLiveHead();
  };

  /* runs table */
  const counts = () => Object.fromEntries(FILTERS.map(([k, , fn]) => [k, items.filter((r) => (!siteFilter || r.siteId === siteFilter) && fn(r)).length]));
  const matches = (r) => {
    if (siteFilter && r.siteId !== siteFilter) return false;
    if (!FILTERS.find(([k]) => k === filter)[2](r)) return false;
    if (!q) return true;
    return [siteName(r), r.projectName, commitShort(r), r.commit?.sha, r.commit?.message, r.commit?.author, r.version && `v${r.version}`].filter(Boolean).join(" ").toLowerCase().includes(q);
  };
  const findingsCell = (r) => {
    if (isActive(r) && !(r.counts?.findings || r.findings?.length)) return html`<span class="dim small">so far none</span>`;
    if (r.status !== "done" && !(r.counts?.findings || r.findings?.length)) return html`<span class="dim">—</span>`;
    const c = sevCounts(r), shown = SEV.filter(([k]) => c[k]);
    if (!shown.length) return html`<span class="th-nofind">${icon("check", "xs")}None</span>`;
    return html`<span class="th-sevs">${shown.map(([k, l]) => html`<span class="sev-pill sev-${k}" title="${c[k]} ${l.toLowerCase()}">${c[k]} ${k === "critical" ? "crit" : k === "medium" ? "med" : l.toLowerCase()}</span>`)}</span>`;
  };
  const rowHTML = (r) => {
    const dur = r.startedAt ? fmtDuration(elapsed(r)) : "—";
    return html`<tr class="clickable${isActive(r) ? " th-row-live" : ""}" data-href="#/tests/${r.id}" data-row="${r.id}">
      <td>${verdictBadge(r)}${isActive(r) && r.phase ? html`<div class="t-sub ellipsis th-phase-sub">${r.phase}</div>` : ""}<div class="t-sub show-sm th-when-sm">${ago(r.createdAt)}</div></td>
      <td class="hide-sm"><div class="row" style="gap:9px;min-width:0">${typeIco(siteType(r), "th-type sm")}<div style="min-width:0"><a class="t-main ellipsis" href="#/sites/${r.siteId}/tests" style="display:block">${siteName(r)}</a>${r.projectName ? html`<div class="t-sub ellipsis">${r.projectName}</div>` : ""}</div></div></td>
      <td><div class="row small" style="gap:7px;min-width:0">${icon("github", "sm")}<span class="mono">${commitShort(r) || "—"}</span>${r.version ? html`<span class="badge mono">v${r.version}</span>` : ""}</div>
        <div class="t-sub ellipsis th-msg">${html`<span class="show-sm">${siteName(r)}${r.commit?.message || !r.commit ? " · " : ""}</span>`}${r.commit?.message || (r.commit ? "" : "Uploaded release")}</div></td>
      <td class="hide-sm">${findingsCell(r)}</td>
      <td class="hide-sm"><div class="small" title="${fmtDate(r.createdAt)}">${ago(r.createdAt)}</div><div class="t-sub hide-sm">${fmtDate(r.createdAt)}</div></td>
      <td class="hide-sm num muted small" ${isActive(r) ? raw(`data-dur="${r.id}"`) : ""}>${dur}</td>
      <td class="actions hide-sm"><a class="btn btn-sm" href="#/tests/${r.id}">${isActive(r) ? html`<span class="dot run" style="width:6px;height:6px"></span>Watch` : html`Open${icon("arrowRight", "sm")}`}</a></td></tr>`;
  };
  const paintList = () => {
    const c = counts();
    mount($("[data-pills]", root), html`${FILTERS.map(([k, l]) => html`<button class="pill ${filter === k ? "active" : ""}" data-f="${k}" role="tab" aria-selected="${filter === k ? "true" : "false"}">${k === "active" && c.active ? html`<span class="dot run" style="width:6px;height:6px"></span>` : ""}${l}<span class="n">${c[k]}</span></button>`)}`);
    const list = items.filter(matches);
    if (!items.length) {
      mount(listEl, html`<div class="card">${emptyState({ ico: "flask", title: "No tests yet", text: "Test a release before it goes live: Claude Code checks sign-in, payments, the database and the rest on a disposable copy, then tells you if it's ready for production.",
        action: html`<button class="btn btn-primary" data-new>${icon("flask")}Test a release</button>` })}</div>`);
      return;
    }
    if (!list.length) { mount(listEl, html`<div class="card">${emptyState({ ico: "filter", sm: true, title: "No matching test runs", text: "Try another filter or search." })}</div>`); return; }
    mount(listEl, html`<div class="card"><div class="table-wrap"><table class="table th-table"><thead><tr><th>Result</th><th class="hide-sm">Website</th><th>Commit</th><th class="hide-sm">Findings</th><th class="hide-sm">When</th><th class="hide-sm">Duration</th><th class="hide-sm"></th></tr></thead>
      <tbody>${list.map(rowHTML)}</tbody></table></div>
      ${list.length >= 300 ? html`<div class="card-foot muted small">Showing the newest 300 runs. Each website keeps its last 30.</div>` : ""}</div>`);
  };
  const paintSites = () => {
    const withRuns = new Set(items.map((r) => r.siteId));
    const opts = sites.filter((s) => withRuns.has(s.id) || s.id === siteFilter);
    mount($("[data-site]", root), html`<option value="">All websites</option>${opts.map((s) => html`<option value="${s.id}" ${s.id === siteFilter ? raw("selected") : ""}>${s.name}</option>`)}`);
  };

  /* how it works + is it set up */
  const paintInfo = () => {
    const t = tester || {};
    const never = stats?.neverTested || [];
    const row = (ok, label, value, href) => html`<div class="th-check-row"><span class="th-ok ${ok === null ? "" : ok ? "ok" : "warn"}">${icon(ok === false ? "alert" : "check", "xs")}</span><span class="th-cr-l">${label}</span><span class="th-cr-v">${href ? html`<a href="${href}">${value}</a>` : value}</span></div>`;
    mount($("[data-info]", root), html`<div class="grid-2 th-info-grid">
      <div class="card"><div class="card-head"><h3>How testing works</h3></div><div class="card-body"><ol class="th-steps">
        <li><span class="th-step-n">1</span><div><b>Pick a commit</b><p>Pull from GitHub and choose <i>Test it</i>, or test any release already on the panel with <i>Test a release</i>.</p></div></li>
        <li><span class="th-step-n">2</span><div><b>A disposable copy is built</b><p>Its own containers, an empty database and a mail catcher. Live payment keys are removed; production is never touched.</p></div></li>
        <li><span class="th-step-n">3</span><div><b>Claude Code tries it</b><p>Setup, sign-in, payments, the database, features, security and config — every step shows live on the test page.</p></div></li>
        <li><span class="th-step-n">4</span><div><b>You get a verdict</b><p><i>Ready for production</i> or <i>Not ready</i>, a score and findings with fixes. Nothing deploys until you say so.</p></div></li>
      </ol></div></div>
      <div class="card"><div class="card-head"><h3>Is testing set up?</h3><div class="right">${tester ? t.tokenSet ? html`<span class="badge ok">${icon("check")}Ready</span>` : html`<span class="badge warn">${icon("alert")}Needs a token</span>` : ""}</div></div>
        <div class="card-body">
          ${tester ? html`<div class="th-checks">
            ${row(!!t.tokenSet, "Claude Code token", t.tokenSet ? "Saved (encrypted)" : "Not set — add it", "#/settings/testing")}
            ${row(true, "Model", t.model || "Claude Code's default")}
            ${row(true, "Time limit", `${t.maxMinutes || 30} minutes per run`)}
            ${row(true, "Runs on", t.serverName || t.serverId || "Each website's own server")}
          </div>` : html`<p class="muted small">Couldn't read the tester settings.</p>`}
          <div class="note mt-16">${icon("card")}<div class="small">Payments? Give each website <b>test-only variables</b> (e.g. Stripe <span class="mono">sk_test_…</span> keys) in its <b>Environment</b> tab. Tests use them on top of the normal variables; live keys are always removed.</div></div>
          ${never.length ? html`<div class="th-never mt-16"><div class="th-never-h">${icon("globe", "sm")}Never tested<span class="dim num">${stats.sitesNeverTested}</span></div>
            <div class="th-never-list">${never.slice(0, 8).map((s) => html`<button class="th-chip-btn" data-newsite="${s.id}" title="Test a release of ${s.name}">${s.name}${icon("flask", "xs")}</button>`)}${stats.sitesNeverTested > 8 ? html`<span class="dim small">+${stats.sitesNeverTested - 8} more</span>` : ""}</div></div>` : ""}
        </div>
        <div class="card-foot"><a class="btn btn-sm ${t.tokenSet ? "btn-ghost" : "btn-primary"}" href="#/settings/testing">${icon("settings")}Settings → Website testing</a></div></div>
    </div>`);
  };

  const paintAll = () => { paintSetupNote(); paintStats(); paintLive(); paintSites(); paintList(); paintInfo(); };
  paintAll();

  /* ── live ── */
  const refreshStats = debounce(async () => {
    try { const r = await get("/api/tests?limit=1"); if (ctx.alive() && r?.stats) { stats = r.stats; paintStats(); paintInfo(); } } catch {}
  }, 700);
  const tick = setInterval(() => {
    for (const [id, c] of cards) { const r = full.get(id); if (r && isActive(r)) $("[data-clock]", c.el).textContent = clock(elapsed(r)); }
    root.querySelectorAll("[data-dur]").forEach((td) => { const r = items.find((x) => x.id === td.dataset.dur); if (r?.startedAt) td.textContent = fmtDuration(elapsed(r)); });
  }, 1000);
  ctx.cleanup(() => { clearInterval(tick); for (const c of cards.values()) clearTimeout(c.timer); });
  const paintRowsSoon = debounce(paintList, 250);
  ctx.on("testrun", (d) => {
    if (!d?.id) return;
    const i = items.findIndex((x) => x.id === d.id);
    if (d.deleted) {
      if (i >= 0) items.splice(i, 1);
      full.delete(d.id); dropCard(d.id);
      paintList(); refreshStats();
      return;
    }
    const prev = i >= 0 ? items[i] : null;
    const merged = { ...(prev || {}), ...d };
    if (!prev) {
      // A run started elsewhere: the event has no project / type; borrow them from the site.
      const s = sites.find((x) => x.id === d.siteId), other = items.find((x) => x.siteId === d.siteId);
      merged.siteName ||= s?.name || other?.siteName || null;
      merged.siteType ||= s?.type || other?.siteType || null;
      merged.projectName ||= other?.projectName || null;
    }
    if (d.checks) full.set(d.id, { ...(full.get(d.id) || {}), ...d });
    if (i >= 0) items[i] = merged; else items.unshift(merged);
    paintLive();
    const sub = root.querySelector(`tr[data-row="${d.id}"] .th-phase-sub`);
    if (sub && merged.phase) sub.textContent = merged.phase;
    // Rows only change when the status / verdict / findings do; the live card carries the rest.
    if (!prev || prev.status !== merged.status || prev.verdict !== merged.verdict || (prev.findings?.length ?? prev.counts?.findings) !== (merged.findings?.length ?? merged.counts?.findings)) paintRowsSoon();
    if (!prev || prev.status !== merged.status) {
      refreshStats();
      if (!prev) { stats = { ...(stats || {}), active: (stats?.active || 0) + 1 }; paintStats(); }
    }
  });

  /* ── actions ── */
  on(root, "click", "[data-f]", (e, b) => { filter = b.dataset.f; paintList(); });
  on(root, "change", "[data-site]", (e, s) => { siteFilter = s.value; paintList(); });
  $("[data-q]", root).addEventListener("input", debounce((e) => { q = e.target.value.trim().toLowerCase(); paintList(); }, 150));
  on(root, "click", "tr[data-href]", (e, tr) => { if (!e.target.closest("a,button")) location.hash = tr.dataset.href; });
  on(root, "click", "[data-new]", () => testReleaseDialog({ sites, items, tester }));
  on(root, "click", "[data-newsite]", (e, b) => testReleaseDialog({ sites, items, tester, siteId: b.dataset.newsite }));
}

/* ───────── "Test a release": pick a website, then one of its releases ───────── */

function testReleaseDialog({ sites, items, tester, siteId = "" }) {
  const list = [...sites].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  let pick = siteId || list.find((s) => !items.some((r) => r.siteId === s.id && isActive(r)))?.id || list[0]?.id || "";
  let rels = [], relId = null, loading = false, loadErr = null;
  const latest = latestByRelease(items);
  const m = openModal({
    title: "Test a release", ico: "flask", size: "lg",
    sub: "Claude Code tries it on a throw-away copy. Nothing is deployed.",
    body: html`${tester && !tester.tokenSet ? html`<div class="note warn" style="margin-bottom:14px">${icon("alert")}<div class="small">Add your Claude Code token in <a href="#/settings/testing" data-close style="color:var(--blue-3)">Settings → Website testing</a> first — tests can't start without it.</div></div>` : ""}
      ${list.length ? html`<div class="field"><label for="thSite">Website</label><select class="select" id="thSite" data-tsite>${list.map((s) => html`<option value="${s.id}" ${s.id === pick ? raw("selected") : ""}>${s.name}${s.domains?.[0] ? ` — ${s.domains[0]}` : ""}</option>`)}</select></div>
      <div class="field mt-16"><label>Release</label><div class="th-rels" data-rels role="radiogroup" aria-label="Release to test"></div></div>`
      : emptyState({ ico: "globe", sm: true, title: "No websites yet", text: "Create a website first, then test its releases here.", action: html`<a class="btn" href="#/sites/new" data-close>${icon("plus")}New website</a>` })}`,
    foot: html`<span class="muted small left" data-tnote></span><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-tstart disabled>${icon("flask")}Start test</button>`,
    onMount(el) {
      const relBox = $("[data-rels]", el), startBtn = $("[data-tstart]", el), note = $("[data-tnote]", el);
      const running = () => items.find((r) => r.siteId === pick && isActive(r));
      const paint = () => {
        if (!relBox) return;
        const site = sites.find((s) => s.id === pick);
        const busy = running();
        if (loading) mount(relBox, skeletonRows(3, 48));
        else if (loadErr) mount(relBox, html`<div class="error-box">${loadErr}</div>`);
        else if (!rels.length) mount(relBox, html`<div class="th-rel-empty muted small">${icon("info", "sm")}<span>${site?.name || "This website"} has no releases yet. Pull a commit from GitHub or upload a zip on its <a href="#/sites/${pick}/deployments" data-close style="color:var(--blue-3)">Deployments</a> tab.</span></div>`);
        else mount(relBox, html`${rels.slice(0, 12).map((r, i) => {
          const last = latest.get(r.id);
          const live = site?.currentReleaseId === r.id || (r.deployedOn || []).length;
          return html`<button type="button" class="th-rel ${r.id === relId ? "on" : ""}" data-rel="${r.id}" role="radio" aria-checked="${r.id === relId ? "true" : "false"}">
            <span class="th-rel-radio" aria-hidden="true"></span>
            <span class="th-rel-main"><span class="row" style="gap:7px;min-width:0"><b class="mono">v${r.version || "—"}</b>${r.github?.sha || r.commit ? html`<span class="mono muted small">${String(r.github?.sha || r.commit).slice(0, 7)}</span>` : ""}${i === 0 ? html`<span class="badge blue">Newest</span>` : ""}${live ? html`<span class="badge ok">Live</span>` : ""}</span>
              <span class="th-rel-sub ellipsis">${r.github?.message ? String(r.github.message).split("\n")[0] : r.filename || ""} · ${ago(r.createdAt)}</span></span>
            <span class="th-rel-last">${last ? verdictBadge(last) : html`<span class="dim small">Not tested</span>`}</span></button>`;
        })}`);
        startBtn.disabled = !relId || loading || !!busy;
        mount(note, busy ? html`<span class="row" style="gap:6px">${icon("info", "xs")}A test of this website is already running — <a href="#/tests/${busy.id}" data-close style="color:var(--blue-3)">watch it</a></span>` : html``);
      };
      const load = async () => {
        loading = true; loadErr = null; rels = []; relId = null; paint();
        const want = pick;
        try { const r = await get(`/api/sites/${want}/releases`); if (want !== pick) return; rels = r.items || []; relId = rels[0]?.id || null; }
        catch (e) { if (want === pick) loadErr = e.message || String(e); }
        loading = false; paint();
      };
      on(el, "change", "[data-tsite]", (e, s) => { pick = s.value; load(); });
      on(el, "click", "[data-rel]", (e, b) => { relId = b.dataset.rel; paint(); });
      on(el, "click", "[data-tstart]", async (e, b) => {
        if (!relId) return;
        const run = await startTest(pick, relId, { btn: b });
        if (run) { m.close(); toast("Test started", "info", { msg: `${sites.find((s) => s.id === pick)?.name || "Website"} — Claude is building the copy.` }); }
      });
      if (pick) load();
    },
  });
  return m;
}
