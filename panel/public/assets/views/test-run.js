// Commit test page: #/tests/:id (docs/DOCKER-AND-TESTS.md §3).
// Live over SSE `testrun` (the full run on every change). The page is built once and then
// patched in place — rings, checks, feed entries and findings are keyed — so CSS transitions
// play once per real change instead of restarting on every event.
import { html, mount, frag, $, on, ago, fmtDate, fmtTime, fmtDuration, plural, emptyState, errorState, toast, toastError, confirmDialog, openMenu } from "../util.js";
import { icon } from "../icons.js";
import { get, post, del } from "../api.js";
import { jobStarted, openJobLog, typeIco } from "../components.js";
import { CATS, catOf, isActive, statusLabel, commitShort } from "./site-tests.js";

const SEV = [
  { id: "critical", label: "Critical" },
  { id: "high", label: "High" },
  { id: "medium", label: "Medium" },
  { id: "low", label: "Low" },
  { id: "info", label: "Info" },
];
const STAGES = [
  { id: "prepare", label: "Build a disposable copy", short: "Copy" },
  { id: "test", label: "Claude tests it", short: "Test" },
  { id: "report", label: "Write the report", short: "Report" },
  { id: "verdict", label: "Verdict", short: "Verdict" },
];
const stageIndex = (s) => ({ queued: 0, preparing: 0, testing: 1, reporting: 2, done: 4, error: -1, cancelled: -1 })[s] ?? 0;
const FINISHED = new Set(["pass", "warn", "fail", "skip"]);
const CHECK_ICON = { pass: "check", warn: "alert", fail: "x", skip: "arrowRight" };
const FEED_ICON = { info: "info", tool: "code", think: "sparkles", error: "alert" };
const R_RING = 27, C_RING = 2 * Math.PI * R_RING;
const R_DIAL = 54, C_DIAL = 2 * Math.PI * R_DIAL;
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const clock = (ms) => {
  if (ms == null || ms < 0) return "00:00";
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : String(m).padStart(2, "0")) + ":" + String(x).padStart(2, "0");
};

export default async function testRun(ctx) {
  const { root, params } = ctx;
  mount(root, html`<div class="skel" style="height:170px;border-radius:22px"></div><div class="tr-orbits mt-20">${CATS.map(() => html`<div class="skel" style="height:132px;border-radius:16px"></div>`)}</div>
    <div class="tr-grid mt-20"><div class="skel" style="height:420px;border-radius:18px"></div><div class="skel" style="height:420px;border-radius:18px"></div></div>`);

  let run, S = null, project = null;
  try {
    run = await get(`/api/tests/${params.id}`);
    S = await get(`/api/sites/${run.siteId}`).catch(() => null);
    if (S?.projectId) project = await get(`/api/projects/${S.projectId}`).catch(() => null);
  } catch (e) {
    if (!ctx.alive()) return;
    ctx.crumbs([{ label: "Websites", href: "#/sites" }, { label: "Test not found" }]);
    mount(root, e?.status === 404 ? emptyState({ ico: "flask", title: "This test run doesn't exist", text: "It may have been deleted.", action: html`<a class="btn" href="#/sites">Back to websites</a>` }) : errorState(e));
    $("[data-retry]", root)?.addEventListener("click", ctx.reload);
    return;
  }
  if (!ctx.alive()) return;
  const siteName = S?.name || run.siteName || "website";
  const siteHref = `#/sites/${run.siteId}`;
  const label = commitShort(run) || (run.version ? `v${run.version}` : "release");
  ctx.crumbs([{ label: "Projects", href: "#/projects" }, ...(project ? [{ label: project.name, href: `#/projects/${project.id}` }] : []), { label: siteName, href: siteHref }, { label: "Tests", href: `${siteHref}/tests` }, { label: `Test ${label}` }]);

  /* ── skeleton of the page (built once) ── */
  mount(root, html`<div class="tr-page" data-page>
    <section class="tr-hero">
      <div class="tr-hero-fx" aria-hidden="true"></div>
      <div class="tr-hero-top">
        <div class="tr-hero-main">
          <a class="tr-eyebrow" href="${siteHref}/tests">${S ? typeIco(S.type, "tr-type") : ""}<span>${icon("flask", "xs")}Commit test · ${siteName}</span></a>
          <h1 data-title></h1>
          <div class="tr-meta">
            ${run.commit ? html`<span class="tr-commit" title="${run.commit.message || ""}">${icon("github", "sm")}<span class="mono">${commitShort(run)}</span><span class="tr-commit-msg">${run.commit.message || ""}</span></span>` : ""}
            ${run.version ? html`<span class="badge mono">v${run.version}</span>` : ""}
            ${run.commit?.author ? html`<span class="muted small">${run.commit.author}</span>` : ""}
            <span class="muted small" title="${fmtDate(run.createdAt)}">started ${ago(run.startedAt || run.createdAt)}</span>
          </div>
        </div>
        <div class="tr-hero-side">
          <div class="tr-clock"><span>Elapsed</span><b class="num" data-elapsed>00:00</b></div>
          <div class="btn-row" data-actions></div>
        </div>
      </div>
      <ol class="tr-stages" data-stages>${STAGES.map((s, i) => html`<li class="tr-stage" data-stage="${i}"><span class="tr-stage-dot">${icon("check", "xs")}</span><span class="tr-stage-l"><span class="hide-sm">${s.label}</span><span class="show-sm">${s.short}</span></span></li>`)}</ol>
      <div class="tr-phase"><span class="tr-phase-t" data-phase aria-live="polite"></span><span class="tr-phase-n num" data-progress-n></span></div>
      <div class="tr-bar" data-bar><div></div></div>
      <div class="tr-env" data-env></div>
    </section>
    <section data-verdict></section>
    <section class="tr-orbits" data-orbits>${CATS.map((c) => html`<div class="tr-orbit" data-cat="${c.id}" style="--c:${c.color}">
        <div class="tr-ring"><svg viewBox="0 0 64 64" aria-hidden="true"><circle class="trk" cx="32" cy="32" r="${R_RING}"/><circle class="arc" cx="32" cy="32" r="${R_RING}" stroke-dasharray="${C_RING.toFixed(2)}" stroke-dashoffset="${C_RING.toFixed(2)}"/></svg>
          <span class="tr-ring-orbit" aria-hidden="true"></span><span class="tr-ring-ico">${icon(c.icon)}</span><span class="tr-ring-badge" aria-hidden="true"></span></div>
        <div class="tr-orbit-l">${c.label}</div><div class="tr-orbit-n num" data-n>—</div></div>`)}</section>
    <div class="tr-grid">
      <div class="card tr-checks"><div class="card-head"><h3>Checklist</h3><span class="sub" data-checkcount></span></div><div class="tr-groups" data-groups>
        ${CATS.map((c) => html`<div class="tr-group" data-group="${c.id}" hidden style="--c:${c.color}"><div class="tr-group-h">${icon(c.icon, "sm")}<span>${c.label}</span><span class="tr-group-n num" data-gn></span></div><div class="tr-group-items" data-gitems></div></div>`)}
        <div class="tr-checks-empty" data-checksempty></div></div></div>
      <div class="card tr-feed"><div class="card-head"><h3>What Claude is doing</h3><span class="tr-live" data-live hidden><span class="dot run"></span>Live</span>
        <div class="right"><label class="check small"><input type="checkbox" data-follow checked/>Follow</label></div></div>
        <div class="tr-feed-list" data-feed role="log" aria-live="polite" aria-relevant="additions"></div></div>
    </div>
    <section data-findings></section>
  </div>`);

  const page = $("[data-page]", root);
  const feedEl = $("[data-feed]", root);
  const checkEls = new Map();
  let feedLastKey = null, feedCount = 0;
  let findSig = null;
  const seenFindings = new Set((run.findings || []).map((f) => f.id));
  let verdictShown = null;
  let first = true;

  /* ── painters ── */
  const elapsed = () => {
    const t0 = run.startedAt || run.createdAt;
    if (!t0) return 0;
    return (run.finishedAt ? new Date(run.finishedAt) : new Date()) - new Date(t0);
  };
  const paintClock = () => { const el = $("[data-elapsed]", root); if (el) el.textContent = clock(elapsed()); };

  const counts = () => {
    const ch = run.checks || [];
    const c = { total: ch.length, pass: 0, warn: 0, fail: 0, skip: 0, running: 0, pending: 0 };
    for (const x of ch) c[x.status] = (c[x.status] || 0) + 1;
    c.finished = c.pass + c.warn + c.fail + c.skip;
    return c;
  };

  const paintHero = () => {
    const active = isActive(run), c = counts();
    page.className = `tr-page st-${run.status}${run.verdict ? ` v-${run.verdict}` : ""}${active ? " is-live" : ""}`;
    $("[data-title]", root).textContent = active ? `Testing ${siteName}` : run.status === "done" ? (run.verdict === "ready" ? "Ready for production" : run.verdict === "not_ready" ? "Not ready for production" : "Test finished")
      : run.status === "cancelled" ? "Test cancelled" : "The test couldn't finish";
    $("[data-phase]", root).textContent = active ? (run.phase || statusLabel(run.status) + "…") : run.status === "done" ? (run.usage?.turns ? `Finished in ${fmtDuration(elapsed())} · ${plural(run.usage.turns, "step")} by Claude` : `Finished in ${fmtDuration(elapsed())}`) : run.status === "cancelled" ? "Stopped before the end." : run.error || "Something went wrong.";
    $("[data-progress-n]", root).textContent = c.total ? `${c.finished} / ${c.total} checks` : "";
    const bar = $("[data-bar]", root);
    bar.classList.toggle("indet", active && !c.total);
    $("div", bar).style.width = (c.total ? (c.finished / c.total) * 100 : run.status === "done" ? 100 : 0).toFixed(1) + "%";
    const si = stageIndex(run.status);
    const stopAt = (run.checks || []).length ? 1 : 0; // error / cancelled: where it stopped
    root.querySelectorAll("[data-stage]").forEach((li) => {
      const i = Number(li.dataset.stage);
      li.className = `tr-stage ${si < 0 ? (i < stopAt ? "done" : i === stopAt ? "stopped" : "") : i < si ? "done" : i === si ? "now" : ""}`;
    });
    const env = run.env || {};
    mount($("[data-env]", root), run.env ? html`
      ${env.url ? html`<span class="tr-chip" title="The disposable copy Claude is testing">${icon("globe", "xs")}<span class="mono">${env.url}</span></span>` : ""}
      <span class="tr-chip ${env.database ? "on" : ""}">${icon("database", "xs")}${env.database ? "Own empty database" : "No database"}</span>
      <span class="tr-chip ${env.mail ? "on" : ""}">${icon("message", "xs")}${env.mail ? "Email captured" : "No email"}</span>
      <span class="tr-chip on">${icon("shield", "xs")}Live payment keys removed</span>` : "");
    $("[data-live]", root).hidden = !active;
    // actions
    const acts = $("[data-actions]", root);
    mount(acts, html`${active ? html`<button class="btn btn-danger" data-cancel>${icon("stop")}Cancel</button>` : ""}
      ${!active && run.status !== "done" ? html`<button class="btn btn-primary" data-again>${icon("refresh")}Run again</button>` : ""}
      <button class="icon-btn" data-more aria-label="More">${icon("more")}</button>`);
  };

  const paintOrbits = () => {
    const by = {};
    for (const x of run.checks || []) (by[x.category] ||= []).push(x);
    for (const c of CATS) {
      const el = $(`[data-cat="${c.id}"]`, root);
      const list = by[c.id] || [];
      const fin = list.filter((x) => FINISHED.has(x.status)).length;
      const p = list.length ? fin / list.length : 0;
      const fail = list.some((x) => x.status === "fail"), warn = list.some((x) => x.status === "warn");
      const activeCat = list.some((x) => x.status === "running");
      const done = list.length && fin === list.length;
      el.className = `tr-orbit${activeCat ? " is-active" : ""}${done ? (fail ? " is-fail" : warn ? " is-warn" : " is-ok") : ""}${!list.length ? " is-empty" : ""}`;
      $(".arc", el).setAttribute("stroke-dashoffset", (C_RING * (1 - p)).toFixed(2));
      $("[data-n]", el).textContent = list.length ? `${fin}/${list.length}` : isActive(run) ? "waiting" : "not checked";
      const badge = $(".tr-ring-badge", el);
      const want = done ? (fail ? "x" : warn ? "alert" : "check") : "";
      if (badge.dataset.k !== want) { badge.dataset.k = want; mount(badge, want ? icon(want, "xs") : html``); }
    }
  };

  const checkInner = (x) => html`<span class="tr-ci">${CHECK_ICON[x.status] ? icon(CHECK_ICON[x.status], "xs") : ""}</span>
    <div class="tr-ct"><div class="tr-ct-t">${x.title}</div>${x.detail ? html`<div class="tr-ct-d">${x.detail}</div>` : ""}</div>
    <span class="tr-cd num">${x.status === "running" ? "running" : x.finishedAt && x.startedAt ? fmtDuration(new Date(x.finishedAt) - new Date(x.startedAt)) : ""}</span>`;
  const paintChecks = () => {
    const by = {};
    for (const x of run.checks || []) (by[x.category] ||= []).push(x);
    for (const c of CATS) {
      const g = $(`[data-group="${c.id}"]`, root), list = by[c.id] || [];
      g.hidden = !list.length;
      $("[data-gn]", g).textContent = list.length ? `${list.filter((x) => FINISHED.has(x.status)).length}/${list.length}` : "";
      const box = $("[data-gitems]", g);
      for (const x of list) {
        let el = checkEls.get(x.id);
        const sig = `${x.status}|${x.title}|${x.detail || ""}|${x.finishedAt || ""}`;
        if (!el) {
          el = frag(html`<div class="tr-check s-${x.status}${first ? "" : " tr-new"}" data-check="${x.id}"></div>`);
          box.appendChild(el); checkEls.set(x.id, el);
        }
        if (el.dataset.sig === sig) continue;
        const prev = el.dataset.status;
        el.dataset.sig = sig; el.dataset.status = x.status;
        mount(el, checkInner(x));
        el.className = `tr-check s-${x.status}${prev && prev !== x.status && FINISHED.has(x.status) ? " just" : ""}${el.classList.contains("tr-new") ? " tr-new" : ""}`;
      }
    }
    const c = counts();
    $("[data-checkcount]", root).textContent = c.total ? [c.pass && `${c.pass} passed`, c.warn && `${c.warn} warning${c.warn > 1 ? "s" : ""}`, c.fail && `${c.fail} failed`, (c.pending + c.running) && `${c.pending + c.running} to go`].filter(Boolean).join(" · ") : "";
    mount($("[data-checksempty]", root), c.total ? html`` : html`<div class="tr-wait">${isActive(run)
      ? html`<span class="tr-wait-orb" aria-hidden="true"></span><div><div class="strong">${run.status === "queued" ? "Waiting for a free tester…" : "Building the disposable copy…"}</div><div class="muted small">Claude writes its checklist once the copy is up.</div></div>`
      : html`<div class="muted small">No checks were run.</div>`}</div>`);
  };

  const feedKey = (a) => `${a.at}|${a.kind}|${a.text}`;
  const feedItem = (a, animate) => frag(html`<div class="tr-ev k-${a.kind || "info"}${animate ? " tr-new" : ""}"><span class="tr-ev-ico">${icon(FEED_ICON[a.kind] || "info", "xs")}</span><div class="tr-ev-t">${a.text}</div><time class="num">${a.at ? fmtTime(a.at) : ""}</time></div>`);
  const paintFeed = () => {
    const list = run.activity || [];
    let from = 0;
    if (feedLastKey) {
      let i = list.length - 1;
      while (i >= 0 && feedKey(list[i]) !== feedLastKey) i--;
      if (i < 0) { feedEl.innerHTML = ""; feedCount = 0; } else from = i + 1;
    }
    if (from >= list.length && feedLastKey) return;
    const atBottom = feedEl.scrollTop + feedEl.clientHeight >= feedEl.scrollHeight - 40;
    const f = document.createDocumentFragment();
    list.slice(from).forEach((a, k, arr) => f.appendChild(feedItem(a, !first && arr.length - k <= 6)));
    feedEl.appendChild(f);
    feedCount += list.length - from;
    while (feedCount > 300 && feedEl.firstElementChild) { feedEl.firstElementChild.remove(); feedCount--; }
    if (list.length) feedLastKey = feedKey(list[list.length - 1]);
    if (!list.length && !feedEl.children.length) mount(feedEl, html`<div class="tr-feed-empty muted small">${isActive(run) ? "Claude's steps appear here as they happen." : "No activity was recorded."}</div>`);
    else feedEl.querySelector(".tr-feed-empty")?.remove();
    if ($("[data-follow]", root).checked || atBottom || first) feedEl.scrollTop = feedEl.scrollHeight;
  };

  const findingHTML = (f, isNew) => {
    const cat = catOf(f.category);
    return html`<details class="tr-find sev-${f.severity}${isNew ? " tr-new" : ""}" data-fid="${f.id}">
      <summary><span class="sev-pill sev-${f.severity}">${SEV.find((s) => s.id === f.severity)?.label || f.severity}</span><span class="tr-find-t">${f.title}</span>
        <span class="tr-find-cat" style="--c:${cat.color}">${icon(cat.icon, "xs")}<span class="hide-sm">${cat.label}</span></span><span class="tr-find-chev">${icon("chevronDown", "sm")}</span></summary>
      <div class="tr-find-b">${f.detail ? html`<p>${f.detail}</p>` : ""}${f.location ? html`<div class="tr-loc">${icon("file", "xs")}<span class="mono">${f.location}</span></div>` : ""}
        ${f.fix ? html`<div class="tr-fix"><div class="tr-fix-h">${icon("wand", "sm")}How to fix</div><p>${f.fix}</p></div>` : ""}</div></details>`;
  };
  const paintFindings = () => {
    const fs = run.findings || [];
    const sig = `${isActive(run)}|${run.status}|` + fs.map((f) => `${f.id}:${f.severity}:${f.title}:${(f.fix || "").length}`).join("|");
    if (sig === findSig) return;
    findSig = sig;
    const box = $("[data-findings]", root);
    const open = new Set([...box.querySelectorAll("details[open]")].map((d) => d.dataset.fid));
    if (!fs.length) { mount(box, run.status === "done" ? html`<div class="card tr-findings"><div class="card-head"><h3>Findings</h3></div><div class="card-body"><div class="tr-nofind">${icon("check")}<span>Claude found nothing to fix.</span></div></div></div>` : html``); return; }
    const groups = SEV.map((s) => ({ ...s, items: fs.filter((f) => f.severity === s.id) })).filter((g) => g.items.length);
    mount(box, html`<div class="card tr-findings"><div class="card-head" style="flex-wrap:wrap"><h3>Findings</h3><span class="sub">${plural(fs.length, "thing")} to look at${isActive(run) ? " so far" : ""}</span>
        <div class="right tr-sevcounts">${groups.map((g) => html`<span class="sev-pill sev-${g.id}">${g.items.length} ${g.label.toLowerCase()}</span>`)}</div></div>
      <div class="card-body tr-find-groups">${groups.map((g) => html`<div class="tr-find-group"><div class="tr-find-gh"><span class="sev-dot sev-${g.id}"></span>${g.label}<span class="dim num">${g.items.length}</span></div>
        ${g.items.map((f) => findingHTML(f, !seenFindings.has(f.id)))}</div>`)}</div></div>`);
    for (const f of fs) seenFindings.add(f.id);
    box.querySelectorAll("details").forEach((d) => (d.open = open.has(d.dataset.fid)));
    if (first && !open.size && run.status === "done") { const d = box.querySelector("details"); if (d) d.open = true; }
  };

  const paintVerdict = () => {
    const box = $("[data-verdict]", root);
    const key = `${run.status}|${run.verdict}|${run.score}`;
    if (verdictShown === key) return;
    const wasLive = verdictShown !== null && verdictShown.startsWith("live");
    verdictShown = isActive(run) ? "live" : key;
    if (isActive(run)) { mount(box, html``); return; }
    if (run.status === "error" || run.status === "cancelled") {
      mount(box, html`<div class="note ${run.status === "error" ? "err" : ""} tr-endnote">${icon(run.status === "error" ? "alert" : "stop")}<div style="flex:1;min-width:0">
        <strong>${run.status === "error" ? "The test couldn't finish" : "This test was cancelled"}</strong>
        ${run.error ? html`<div class="small mt-8">${run.error}</div>` : ""}<div class="small muted mt-8">Nothing was deployed. Fix what's above (e.g. the Claude Code token in Settings → Website testing) and run it again.</div></div>
        <div class="btn-row" style="flex-wrap:nowrap">${run.jobId ? html`<button class="btn btn-sm" data-log>${icon("fileText")}Log</button>` : ""}<button class="btn btn-sm btn-primary" data-again>${icon("refresh")}Run again</button></div></div>`);
      return;
    }
    const ready = run.verdict === "ready";
    const c = counts();
    const fs = run.findings || [];
    const serious = fs.filter((f) => f.severity === "critical" || f.severity === "high").length;
    const score = Math.max(0, Math.min(100, Number(run.score) || 0));
    mount(box, html`<div class="tr-verdict ${ready ? "ok" : "bad"} ${wasLive ? "live-reveal" : ""}">
      <div class="tr-verdict-fx" aria-hidden="true">${ready ? Array.from({ length: 14 }, (_, i) => html`<i style="--a:${(i * 360) / 14}deg;--d:${(i % 4) * 60}ms"></i>`) : ""}</div>
      <div class="tr-dial" role="img" aria-label="Score ${score} out of 100">
        <svg viewBox="0 0 128 128" aria-hidden="true"><circle class="trk" cx="64" cy="64" r="${R_DIAL}"/><circle class="arc" cx="64" cy="64" r="${R_DIAL}" stroke-dasharray="${C_DIAL.toFixed(2)}" stroke-dashoffset="${C_DIAL.toFixed(2)}"/></svg>
        <div class="tr-dial-n"><b class="num" data-score>0</b><span>/ 100</span></div>
      </div>
      <div class="tr-v-text">
        <div class="tr-v-eyebrow">${icon(ready ? "shield" : "alert", "xs")}Verdict</div>
        <h2>${ready ? "Ready for production" : "Not ready"}</h2>
        <p>${run.summary || (ready ? "Every check that matters passed." : "Fix the findings below, then test again.")}</p>
        <div class="tr-v-stats">
          <span class="tr-chip on ok">${icon("check", "xs")}${c.pass} passed</span>
          ${c.warn ? html`<span class="tr-chip on warn">${icon("alert", "xs")}${plural(c.warn, "warning")}</span>` : ""}
          ${c.fail ? html`<span class="tr-chip on err">${icon("x", "xs")}${c.fail} failed</span>` : ""}
          ${serious ? html`<span class="tr-chip on err">${icon("alert", "xs")}${serious} critical/high</span>` : ""}
        </div>
      </div>
      <div class="tr-v-actions">
        <button class="btn btn-lg ${ready ? "btn-primary" : ""}" data-deploy>${icon("rocket")}Deploy this commit</button>
        <button class="btn ${ready ? "btn-ghost" : "btn-primary"}" data-again>${icon("refresh")}Run again</button>
      </div></div>`);
    const v = $(".tr-verdict", box), arc = $(".tr-dial .arc", box), n = $("[data-score]", box);
    const still = reduced();
    const delay = still ? 0 : 380;
    const dur = still ? 0 : wasLive ? 1600 : 1100;
    if (still) { arc.style.transition = "none"; arc.setAttribute("stroke-dashoffset", (C_DIAL * (1 - score / 100)).toFixed(2)); n.textContent = score; v.classList.add("in"); return; }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      v.classList.add("in");
      arc.style.transitionDuration = dur + "ms"; arc.style.transitionDelay = delay + "ms";
      arc.setAttribute("stroke-dashoffset", (C_DIAL * (1 - score / 100)).toFixed(2));
      const t0 = performance.now() + delay;
      const step = (t) => {
        if (!n.isConnected) return;
        const k = Math.max(0, Math.min(1, (t - t0) / dur)), e = 1 - Math.pow(1 - k, 3);
        n.textContent = Math.round(score * e);
        if (k < 1) requestAnimationFrame(step); else v.classList.add("settled");
      };
      requestAnimationFrame(step);
    }));
    if (wasLive) toast(ready ? "Ready for production" : "Not ready for production", ready ? "ok" : "warn", { msg: `${siteName} · ${label} scored ${score}/100.` });
  };

  const paint = () => {
    paintHero(); paintClock(); paintOrbits(); paintChecks(); paintFeed(); paintFindings(); paintVerdict();
    first = false;
  };
  paint();

  /* ── live ── */
  const tick = setInterval(() => { if (isActive(run)) paintClock(); }, 1000);
  // Safety net if the live stream is quiet for a while (events are the normal path).
  let lastEvent = Date.now();
  const poll = setInterval(async () => {
    if (!isActive(run) || Date.now() - lastEvent < 15000) return;
    try { const r = await get(`/api/tests/${run.id}`); if (ctx.alive()) { run = r; paint(); } } catch {}
  }, 15000);
  ctx.cleanup(() => { clearInterval(tick); clearInterval(poll); });
  ctx.on("testrun", (d) => {
    if (!d || d.id !== run.id) return;
    lastEvent = Date.now();
    if (d.deleted) { toast("This test run was deleted", "warn"); location.hash = `${siteHref}/tests`; return; }
    run = { ...run, ...d };
    paint();
  });

  /* ── actions ── */
  const again = async (b) => {
    b?.classList.add("loading");
    try { const r = await post(`/api/sites/${run.siteId}/tests`, { releaseId: run.releaseId }); location.hash = `#/tests/${r.id}`; }
    catch (e) { toastError(e, "Couldn't start the test"); }
    finally { b?.classList.remove("loading"); }
  };
  on(root, "click", "[data-again]", (e, b) => again(b));
  on(root, "click", "[data-log]", () => run.jobId && openJobLog(run.jobId));
  on(root, "click", "[data-cancel]", async (e, b) => {
    if (!(await confirmDialog({ title: "Cancel this test?", message: "Claude stops, and the disposable copy, its database and its mail catcher are removed. Nothing was deployed.", danger: true, confirmText: "Cancel test", ico: "stop" }))) return;
    b.classList.add("loading");
    try { run = { ...run, ...(await post(`/api/tests/${run.id}/cancel`)) }; paint(); toast("Test cancelled", "ok"); } catch (ex) { toastError(ex, "Couldn't cancel"); } finally { b.classList.remove("loading"); }
  });
  on(root, "click", "[data-deploy]", async (e, b) => {
    const ready = run.verdict === "ready";
    const fs = run.findings || [];
    const serious = fs.filter((f) => f.severity === "critical" || f.severity === "high");
    const where = S?.loadBalanced ? `all ${(S.serverIds || []).length} servers, one at a time` : "its server";
    const ok = ready
      ? await confirmDialog({ title: `Deploy ${label} to ${siteName}?`, ico: "rocket", confirmText: "Deploy", message: `The tested release${run.version ? ` (v${run.version})` : ""} goes live on ${where}.` })
      : await confirmDialog({ title: "Deploy a commit that isn't ready?", danger: true, ico: "alert", confirmText: "Deploy anyway",
        message: `Claude judged this commit not ready for production${serious.length ? ` — ${plural(serious.length, "critical or high finding")}` : ""}${(run.checks || []).some((x) => x.status === "fail") ? ", and some checks failed" : ""}. Visitors get it as soon as the deploy finishes.`,
        extra: serious.length ? html`<ul class="tq-list">${serious.slice(0, 4).map((f) => html`<li>${icon("alert", "sm")}<span>${f.title}</span></li>`)}</ul>` : "" });
    if (!ok) return;
    b.classList.add("loading");
    try { const job = await post(`/api/tests/${run.id}/deploy`); jobStarted(job, `Deploying ${label} to ${siteName}`); } catch (ex) { toastError(ex, "Couldn't deploy"); } finally { b.classList.remove("loading"); }
  });
  on(root, "click", "[data-more]", (e, b) => openMenu(b, [
    { label: "All tests of this website", icon: "list", onClick: () => (location.hash = `${siteHref}/tests`) },
    ...(run.jobId ? [{ label: "View the raw log", icon: "fileText", onClick: () => openJobLog(run.jobId) }] : []),
    ...(!isActive(run) && run.status === "done" ? [{ label: "Run again", icon: "refresh", onClick: () => again() }] : []),
    { sep: true },
    { label: "Delete this run", icon: "trash", danger: true, disabled: isActive(run), onClick: async () => {
      if (!(await confirmDialog({ title: "Delete this test run?", message: "Its checklist, findings and activity are removed. The release itself is kept.", danger: true, confirmText: "Delete run" }))) return;
      try { await del(`/api/tests/${run.id}`); toast("Test run deleted", "ok"); location.hash = `${siteHref}/tests`; } catch (ex) { toastError(ex, "Couldn't delete"); }
    } },
  ]));
}

