// One CI run: verdict and deploy gate, the run's pipeline (plan → checkouts per server → report),
// what the update touches, and the findings ranked by severity.
import { html, raw, mount, $, $$, on, fmtDate, fmtDuration, ago, plural, emptyState, errorState, toast, toastError, confirmDialog, openModal, debounce } from "../util.js";
import { icon } from "../icons.js";
import { get, post, patch, getText } from "../api.js";
import { jobStarted, openJobLog, logLineHTML } from "../components.js";
import { SEVERITIES, SEV_LABEL, SEV_HINT, ciStatusBadge, sevTag, ciGateDialog, ciStarted, runDuration } from "../ci-ui.js";

const STEP_ICON = { passed: "check", warning: "alert", failed: "x", skipped: "dot", cancelled: "stop", running: "refresh", pending: "clock" };
const CHECK_LABEL = { scan: "Static scan", install: "Install", build: "Build", command: "Command", typecheck: "Types", lint: "Lint", tests: "Tests", suite: "Critical suite", smoke: "Smoke test", "php-lint": "PHP", "static-output": "Build output", ci: "CI", fetch: "Fetch" };

function stepRow(s) {
  return html`<li class="ci-step st-${s.status}"><span class="ci-step-ico">${icon(STEP_ICON[s.status] || "dot", "xs")}</span><span class="ci-step-l ellipsis">${s.label}</span><span class="ci-step-r">${s.summary ? html`<span class="ellipsis" title="${s.summary}">${s.summary}</span>` : ""}${s.durationMs != null ? html`<span class="num">${fmtDuration(s.durationMs)}</span>` : ""}</span></li>`;
}

function checkoutCard(c, runId) {
  const tone = { passed: "ok", warning: "warn", failed: "err", error: "err", running: "run", queued: "off", cancelled: "off" }[c.status] || "off";
  return html`<div class="ci-co st-${c.status}">
    <div class="ci-co-head"><span class="dot ${tone}"></span><div style="min-width:0;flex:1"><div class="strong ellipsis">${c.name}</div>
      <div class="muted tiny ci-co-srv">${c.serverName ? html`${icon("server", "xs")}<span>${c.serverName}${c.hostname && c.hostname !== c.serverName ? ` (${c.hostname})` : ""}${c.attempts > 1 ? ` · attempt ${c.attempts}` : ""}</span>` : html`${icon("clock", "xs")}<span>Waiting for a free CI server…</span>`}</div></div>
      <button class="icon-btn sm ghost" data-colog="${c.id}" title="Checkout log">${icon("fileText", "sm")}</button></div>
    <ol class="ci-steps">${(c.steps || []).map(stepRow)}</ol>
    <div class="ci-co-foot">
      ${c.status === "queued" ? html`<span class="muted">Queued</span>` : c.status === "running" ? html`<span class="row" style="gap:6px"><span class="dot run" style="width:6px;height:6px"></span>${c.current || "Working"}</span>` : html`<span>${c.findings ? plural(c.findings, "finding") : "No findings"}</span>`}
      ${c.cleaned === true ? html`<span class="ci-clean" title="The checkout folder was deleted from ${c.serverName}">${icon("trash", "xs")}Files deleted</span>` : c.cleaned === false ? html`<span class="sev-text-medium" title="Swept by that server's next checkout">${icon("alert", "xs")}Files not deleted</span>` : ""}
      ${c.simulated ? html`<span class="badge" title="FCC_DRY_RUN: steps were simulated">Dry run</span>` : ""}
    </div>
    ${c.error ? html`<div class="error-box mt-8">${icon("alert")}<div>${c.error}</div></div>` : ""}
  </div>`;
}

function pipeline(R) {
  const p = R.plan;
  const scanCount = R.findings.filter((f) => f.check === "scan").length;
  const planDone = R.status !== "planning";
  return html`<div class="ci-pipe">
    <div class="ci-pipe-col">
      <div class="ci-pipe-h">${icon("shield", "xs")}Plan · Panel</div>
      <div class="ci-co st-${planDone ? (scanCount ? "warning" : "passed") : "running"}">
        <div class="ci-co-head"><span class="dot ${planDone ? "ok" : "run"}"></span><div style="flex:1;min-width:0"><div class="strong">Impact analysis</div><div class="muted tiny">${p ? `${p.scope === "targeted" ? "Targeted" : p.scope === "global" ? "Project-wide change" : "Full check"} · ${plural(p.changedCount, "file")} changed` : "Reading the release…"}</div></div>
          ${R.jobId ? html`<button class="icon-btn sm ghost" data-job="${R.jobId}" title="Run log">${icon("fileText", "sm")}</button>` : ""}</div>
        <ol class="ci-steps">
          ${stepRow({ label: "Diff against the live release", status: planDone ? "passed" : "running", summary: p ? `${p.changedCount} changed${p.affectedCount ? `, +${p.affectedCount} via imports` : ""}` : "" })}
          ${stepRow({ label: "Routes, tests & suites", status: planDone ? "passed" : "pending", summary: p ? `${p.routes.length} routes · ${p.tests.length} tests · ${p.suites.filter((s) => s.reason).length} suites` : "" })}
          ${stepRow({ label: "Static scan of changed lines", status: planDone ? (scanCount ? "warning" : "passed") : "pending", summary: planDone ? (scanCount ? plural(scanCount, "finding") : "clean") : "" })}
        </ol>
      </div>
    </div>
    <div class="ci-pipe-arrow ${R.status === "running" || R.status === "queued" ? "live" : ""}" aria-hidden="true">${icon("arrowRight")}</div>
    <div class="ci-pipe-col grow">
      <div class="ci-pipe-h">${icon("server", "xs")}Checkouts · ${R.servers.length ? R.servers.join(", ") : "agent servers"}</div>
      <div class="ci-co-grid">${R.checkouts.length ? R.checkouts.map((c) => checkoutCard(c, R.id)) : html`<div class="ci-co st-skipped"><div class="muted small" style="padding:14px">${planDone ? "Nothing needed a checkout — the static scan covered this update." : "Planned once the release has been read."}</div></div>`}</div>
    </div>
    <div class="ci-pipe-arrow ${["passed", "warning", "failed", "error"].includes(R.status) ? "" : "wait"}" aria-hidden="true">${icon("arrowRight")}</div>
    <div class="ci-pipe-col">
      <div class="ci-pipe-h">${icon("fileText", "xs")}Report</div>
      <div class="ci-verdict v-${R.status}">${ciStatusBadge(R.status)}
        <div class="ci-verdict-n">${SEVERITIES.map((s) => html`<div class="sev-cell sev-${s} ${R.counts[s] ? "on" : ""}"><b class="num">${R.counts[s]}</b><span>${SEV_LABEL[s]}</span></div>`)}</div>
        <div class="muted tiny">Blocks from <b>${R.blockOn}</b> up${R.site?.mode === "required" ? "" : ` · ${R.site?.mode || "advisory"} mode`}</div></div>
    </div>
  </div>`;
}

function touched(R) {
  const p = R.plan;
  if (!p) return html`<div class="card-body">${emptyState({ ico: "search", title: "Planning…", text: "Reading the release and the live one.", sm: true })}</div>`;
  const kindTag = (k) => html`<span class="ci-kind k-${k}">${k === "added" ? "+" : k === "removed" ? "−" : "~"}</span>`;
  return html`<div class="card-body ci-touch">
    ${p.notes.length ? html`<div class="note mb-12">${icon("info")}<div>${p.notes.map((n) => html`<div>${n}</div>`)}</div></div>` : ""}
    <div class="grid-2">
      <div><h4 class="ci-h4">Changed files <span class="muted">${p.changedCount}</span></h4>
        <ul class="ci-files">${p.changed.slice(0, 60).map((c) => html`<li>${kindTag(c.kind)}<span class="mono ellipsis">${c.path}</span></li>`)}${p.changed.length > 60 ? html`<li class="muted">… ${p.changed.length - 60} more</li>` : ""}${!p.changed.length ? html`<li class="muted">Same files as the live release.</li>` : ""}</ul>
        ${p.affectedCount ? html`<details class="mt-12"><summary class="small">${plural(p.affectedCount, "more file")} reached through imports</summary><ul class="ci-files mt-8">${p.affected.slice(0, 120).map((f) => html`<li>${icon("link", "xs")}<span class="mono ellipsis">${f}</span></li>`)}</ul></details>` : ""}
      </div>
      <div><h4 class="ci-h4">Routes smoke tested <span class="muted">${p.probes.length}/${p.routes.length}</span></h4>
        <ul class="ci-files">${p.routes.slice(0, 40).map((r) => html`<li><span class="badge mono ${r.kind === "api" ? "violet" : ""}" style="min-width:34px;justify-content:center">${r.kind === "api" ? "API" : "Page"}</span><span class="mono">${r.route}</span><span class="muted tiny ellipsis" title="${r.file}">${r.dynamic && !p.probes.some((x) => x.route === r.route) ? "needs a sample path" : r.reason}</span></li>`)}${!p.routes.length ? html`<li class="muted">No page or API route is affected.</li>` : ""}</ul>
        <h4 class="ci-h4 mt-16">Critical suites</h4>
        <ul class="ci-files">${p.suites.map((s) => html`<li>${sevTag(s.severity)}<span class="strong">${s.name}</span><span class="muted tiny ellipsis">${s.reason || "not touched — skipped"}${s.source === "repo" ? " · fcc-ci.json" : ""}</span></li>`)}${!p.suites.length ? html`<li class="muted">None defined. Add one (payments, sign-in…) in the website's CI tab.</li>` : ""}</ul>
        <h4 class="ci-h4 mt-16">Related tests <span class="muted">${p.tests.length}</span></h4>
        <ul class="ci-files">${p.tests.slice(0, 30).map((t) => html`<li>${icon("check", "xs")}<span class="mono ellipsis">${t}</span></li>`)}${!p.tests.length ? html`<li class="muted">${p.caps?.testRunner ? "No test imports what changed." : "No test runner in this codebase."}</li>` : ""}</ul>
      </div>
    </div></div>`;
}

function findingsList(R, sev) {
  const list = R.findings.filter((f) => !sev || f.severity === sev);
  if (!R.findings.length) return emptyState({ ico: "check", title: ["passed", "warning", "failed", "error"].includes(R.status) ? "No findings" : "Nothing yet", text: ["passed"].includes(R.status) ? "Every check this update needed came back clean." : "Findings appear here as checkouts report back.", sm: true });
  return html`${list.map((f) => html`<details class="ci-finding sev-${f.severity}">
    <summary>${sevTag(f.severity)}<span class="ci-f-title">${f.title}</span><span class="ci-f-meta">${f.file ? html`<span class="mono ellipsis">${f.file}${f.line ? `:${f.line}` : ""}</span>` : ""}<span class="badge" title="${(f.alsoIn || []).length ? `Also reported by: ${f.alsoIn.map((c) => CHECK_LABEL[c] || c).join(", ")}` : ""}">${CHECK_LABEL[f.check] || f.check}${(f.alsoIn || []).length ? ` +${f.alsoIn.length}` : ""}</span>${f.serverName ? html`<span class="muted tiny hide-sm">${f.serverName}</span>` : ""}</span></summary>
    ${f.detail ? html`<pre class="code wrap ci-f-detail">${f.detail}</pre>` : html`<div class="muted small ci-f-detail">No more detail.</div>`}
  </details>`)}`;
}

async function checkoutLog(R, cid) {
  const c = R.checkouts.find((x) => x.id === cid);
  const m = openModal({ title: `${c?.name || cid} · log`, sub: c?.serverName ? `on ${c.serverName}` : "", ico: "fileText", size: "xl",
    body: html`<pre class="code wrap" data-log style="min-height:320px;max-height:62vh"><span class="muted">Loading…</span></pre>`,
    foot: html`<label class="check left"><input type="checkbox" data-follow checked/>Follow output</label><button class="btn" data-close>Close</button>` });
  const pre = $("[data-log]", m.el);
  let last = "";
  const load = async () => {
    try {
      const t = await getText(`/api/ci/runs/${R.id}/checkouts/${cid}/log`);
      if (t === last) return;
      last = t;
      pre.innerHTML = t.replace(/\n$/, "").split("\n").map((l) => logLineHTML(l.replace(/^\d\d:\d\d:\d\d /, "")).toString()).join("");
      if ($("[data-follow]", m.el).checked) pre.scrollTop = pre.scrollHeight;
    } catch (e) { mount(pre, html`<span class="log-line err">Couldn't load the log: ${e.message}</span>`); }
  };
  await load();
  const t = setInterval(load, 1500);
  m.result.then(() => clearInterval(t));
}

export default async function ciRun(ctx) {
  const { root, params } = ctx;
  let R;
  try { R = await get(`/api/ci/runs/${params.id}`); } catch (e) { ctx.crumbs([{ label: "CI", href: "#/ci" }, { label: "Not found" }]); mount(root, errorState(e)); return; }
  if (!ctx.alive()) return;
  let sev = "";
  const what = () => [R.version ? `v${R.version}` : null, R.shortSha].filter(Boolean).join(" · ") || R.releaseId;
  ctx.crumbs([{ label: "CI", href: "#/ci" }, { label: R.siteName, href: `#/sites/${R.siteId}/ci` }, { label: what() }]);
  mount(root, html`<div data-head></div><div data-gate></div>
    <div class="card"><div class="card-head"><div><h3>Pipeline</h3><div class="sub">Planned on the panel, checked out on the CI servers in parallel, reported back here.</div></div></div><div class="card-body" data-pipe></div></div>
    <div class="card mt-24"><div class="card-head" style="flex-wrap:wrap"><div><h3>Findings</h3><div class="sub">Worst first. Click one for the detail.</div></div><div class="right"><div class="pills" data-sev></div></div></div><div class="ci-findings" data-findings></div></div>
    <div class="card mt-24"><div class="card-head"><div><h3>What this update touches</h3><div class="sub">From the import graph of the new release, walked back from every changed file.</div></div></div><div data-touch></div></div>`);

  const paint = () => {
    const live = ["planning", "queued", "running"].includes(R.status);
    const done = !live;
    const finished = ["passed", "warning", "failed", "error"].includes(R.status);
    mount($("[data-head]", root), html`<div class="page-head ci-run-head"><div style="min-width:0">
        <h1 class="row" style="gap:12px;flex-wrap:wrap">${R.siteName} <span class="mono" style="font-weight:600;color:var(--text-2)">${what()}</span> ${ciStatusBadge(R.status)}</h1>
        <p>${R.message ? html`<span class="ellipsis">${R.message}</span> · ` : ""}${R.baseReleaseId ? html`compared with live ${R.baseVersion ? `v${R.baseVersion}` : R.baseReleaseId}` : "nothing live to compare with"} · ${{ auto: "started automatically", update: "started by Update", manual: "started by hand", rerun: "re-run" }[R.trigger] || R.trigger}${R.adminName ? ` by ${R.adminName}` : ""} · ${fmtDate(R.createdAt)}${runDuration(R) ? ` · ${runDuration(R)}` : ""}</p></div>
      <div class="right btn-row">
        ${live ? html`<button class="btn btn-danger" data-cancel>${icon("stop")}Cancel</button>` : html`<button class="btn" data-rerun>${icon("refresh")}Run again</button>`}
        <a class="btn btn-ghost" href="#/sites/${R.siteId}/ci">${icon("settings")}CI settings</a>
      </div></div>`);

    // Deploy gate
    const dep = R.deploy;
    const ov = (R.overrides || []).slice(-1)[0];
    let gate;
    if (R.isLive) gate = html`<div class="note ok">${icon("check")}<div>This release is live${ov ? html` — deployed with CI <b>${ov.mode === "override" ? "overridden" : "bypassed"}</b> by ${ov.by || "an admin"} ${ago(ov.at)}` : dep?.jobId ? " — deployed automatically when CI passed" : ""}.</div></div>`;
    else if (live) gate = html`<div class="note">${icon("refresh")}<div style="flex:1">CI is checking this update. ${R.deployOnPass ? html`<b>It deploys automatically if it passes.</b>` : "Nothing deploys until you say so."}</div>
      ${R.release?.available !== false ? html`<label class="switch"><input type="checkbox" data-dop ${R.deployOnPass ? raw("checked") : ""}/><span class="track"></span>Deploy if it passes</label>` : ""}</div>`;
    else if (!finished) gate = html`<div class="note warn">${icon("alert")}<div style="flex:1">This run ${R.status === "cancelled" ? "was cancelled" : "did not finish"}${R.error ? `: ${R.error}` : ""}. Run it again to check this update.</div></div>`;
    else if (!R.blocking) gate = html`<div class="ci-gate ok"><div class="ci-gate-ico">${icon("check")}</div><div style="flex:1;min-width:0"><div class="strong">${R.status === "warning" ? "Cleared to deploy — with notes" : "Cleared to deploy"}</div><div class="muted small">${R.status === "warning" ? `Nothing at ${R.blockOn} or worse. Worth reading the findings below.` : "Every check came back clean."}${dep?.error ? html` <span class="sev-text-high">Auto-deploy didn't start: ${dep.error}</span>` : ""}</div></div>
      ${R.release?.available === false ? html`<span class="badge err">Archive missing</span>` : html`<button class="btn btn-primary" data-deploy>${icon("rocket")}Deploy ${what()}</button>`}</div>`;
    else gate = html`<div class="ci-gate err"><div class="ci-gate-ico">${icon("alert")}</div><div style="flex:1;min-width:0"><div class="strong">${R.site?.mode === "required" ? "Deploy blocked by CI" : "CI found blocking issues (advisory mode — deploys are not stopped)"}</div><div class="muted small">${SEVERITIES.filter((s) => R.counts[s]).map((s) => `${R.counts[s]} ${s}`).join(" · ")}. Fix them and push a new update${R.site?.mode === "required" ? ", or override if you are certain" : ""}.${ov ? ` Last ${ov.mode} by ${ov.by || "an admin"} ${ago(ov.at)}.` : ""}</div></div>
      ${R.release?.available === false ? "" : html`<button class="btn btn-danger" data-override>${icon("alert")}Override and deploy…</button>`}</div>`;
    mount($("[data-gate]", root), html`<div class="mb-18">${gate}</div>`);

    mount($("[data-pipe]", root), pipeline(R));
    mount($("[data-sev]", root), html`<button class="pill ${sev ? "" : "active"}" data-s="">All<span class="n">${R.findings.length}</span></button>${SEVERITIES.map((s) => html`<button class="pill sevp-${s} ${sev === s ? "active" : ""}" data-s="${s}" title="${SEV_HINT[s]}">${SEV_LABEL[s]}<span class="n">${R.counts[s]}</span></button>`)}`);
    mount($("[data-findings]", root), findingsList(R, sev));
    mount($("[data-touch]", root), touched(R));
    void done;
  };
  paint();

  const reload = async () => { try { R = await get(`/api/ci/runs/${R.id}`); if (ctx.alive()) paint(); } catch {} };
  ctx.on("ci", (d) => { if (d?.id === R.id) reload(); });
  ctx.on("site", (d) => { if (d?.id === R.siteId) reload(); });
  const poll = setInterval(() => { if (["planning", "queued", "running"].includes(R.status)) reload(); }, 4000);
  ctx.cleanup(() => clearInterval(poll));

  on(root, "click", "[data-s]", (e, b) => { sev = b.dataset.s; paint(); });
  on(root, "click", "[data-colog]", (e, b) => checkoutLog(R, b.dataset.colog));
  on(root, "click", "[data-job]", (e, b) => openJobLog(b.dataset.job));
  on(root, "click", "[data-cancel]", async (e, b) => {
    if (!(await confirmDialog({ title: "Cancel this CI run?", message: "Running checkouts are stopped and their files deleted. Nothing is deployed.", confirmText: "Cancel run", danger: true, ico: "stop" }))) return;
    try { await post(`/api/ci/runs/${R.id}/cancel`); toast("CI run cancelled", "ok"); reload(); } catch (ex) { toastError(ex); }
  });
  on(root, "click", "[data-rerun]", async (e, b) => {
    b.classList.add("loading");
    try { const r = await post(`/api/ci/runs/${R.id}/rerun`, {}); ciStarted(r); location.hash = `#/ci/${r.id}`; } catch (ex) { toastError(ex, "Couldn't start CI"); } finally { b.classList.remove("loading"); }
  });
  on(root, "change", "[data-dop]", async (e, el) => {
    try { await patch(`/api/ci/runs/${R.id}`, { deployOnPass: el.checked }); toast(el.checked ? "Will deploy when CI passes" : "Won't deploy automatically", "ok"); } catch (ex) { el.checked = !el.checked; toastError(ex); }
  });
  const site = () => ({ id: R.siteId, name: R.siteName });
  const retry = (extra) => post(`/api/ci/runs/${R.id}/deploy`, extra.ci === "override" ? { override: true, confirm: extra.confirm } : extra.ci === "bypass" ? { bypass: true } : {});
  on(root, "click", "[data-deploy]", async (e, b) => {
    b.classList.add("loading");
    try { const j = await retry({}); jobStarted(j, `Deploying ${R.siteName} ${what()}`); }
    catch (ex) { if (ex?.status === 409 && /^ci_/.test(ex.body?.code || "")) await ciGateDialog(site(), ex, { releaseId: R.releaseId, retry }); else toastError(ex, "Couldn't deploy"); }
    finally { b.classList.remove("loading"); }
  });
  on(root, "click", "[data-override]", async () => {
    // Ask the server: it answers with the gate (and whether the name must be typed), which the dialog shows.
    try { const j = await retry({}); jobStarted(j, `Deploying ${R.siteName}`); }
    catch (ex) { if (ex?.status === 409 && /^ci_/.test(ex.body?.code || "")) await ciGateDialog(site(), ex, { releaseId: R.releaseId, retry }); else toastError(ex, "Couldn't deploy"); }
  });
}
