// Commit testing + Docker runtime pieces of the website page (docs/DOCKER-AND-TESTS.md §3).
// The test page itself lives in views/test-run.js; this file has what views/site.js needs:
// the "test this commit?" question, starting a run, the Tests tab, release verdict badges,
// test-only variables, the runtime badge and the move-to-Docker dialogs.
import { html, mount, $, $$, on, ago, fmtDate, fmtDuration, emptyState, errorState, skeletonRows, toast, toastError, confirmDialog, openModal, openMenu } from "../util.js";
import { icon } from "../icons.js";
import { get, post, put, del } from "../api.js";
import { onEvent } from "../events.js";
import { jobStarted, openJobLog } from "../components.js";

/* ───────── shared vocabulary ───────── */

/** The fixed category list (contract §2). Colours come from app.css tokens. */
export const CATS = [
  { id: "setup", label: "Setup", icon: "layers", color: "var(--blue-3)" },
  { id: "payments", label: "Payments", icon: "card", color: "var(--green)" },
  { id: "database", label: "Database", icon: "database", color: "var(--cyan)" },
  { id: "auth", label: "Sign-in", icon: "lock", color: "var(--violet)" },
  { id: "features", label: "Features", icon: "sparkles", color: "var(--teal)" },
  { id: "security", label: "Security", icon: "shield", color: "var(--rose)" },
  { id: "config", label: "Config", icon: "settings", color: "var(--amber)" },
];
export const catOf = (id) => CATS.find((c) => c.id === id) || { id, label: id || "Other", icon: "dot", color: "var(--muted)" };

export const RUNNING = new Set(["queued", "preparing", "testing", "reporting"]);
export const isActive = (r) => !!r && RUNNING.has(r.status);
const STATUS_LABEL = { queued: "Queued", preparing: "Preparing", testing: "Testing", reporting: "Writing report", done: "Finished", error: "Failed", cancelled: "Cancelled" };
export const statusLabel = (s) => STATUS_LABEL[s] || s || "—";

export const commitShort = (r) => r?.commit?.shortSha || (r?.commit?.sha || "").slice(0, 7) || "";

/** Verdict / state badge for a run (release rows, Tests tab, test page). */
export function verdictBadge(r, { score = true } = {}) {
  if (!r) return html``;
  if (isActive(r)) return html`<span class="badge blue"><span class="dot run" style="width:6px;height:6px"></span>${r.status === "queued" ? "Queued" : "Testing…"}</span>`;
  if (r.status === "error") return html`<span class="badge err" title="${r.error || ""}">${icon("alert")}Test failed to run</span>`;
  if (r.status === "cancelled") return html`<span class="badge">${icon("stop")}Cancelled</span>`;
  if (r.verdict === "ready") return html`<span class="badge ok">${icon("check")}Ready${score && r.score != null ? html` · <span class="num">${r.score}</span>` : ""}</span>`;
  if (r.verdict === "not_ready") return html`<span class="badge err">${icon("x")}Not ready${score && r.score != null ? html` · <span class="num">${r.score}</span>` : ""}</span>`;
  return html`<span class="badge">${statusLabel(r.status)}</span>`;
}

/** items are newest first: the first run seen for a release is its latest. */
export function latestByRelease(items) {
  const m = new Map();
  for (const r of items || []) if (r.releaseId && !m.has(r.releaseId)) m.set(r.releaseId, r);
  return m;
}

/* ───────── starting a run ───────── */

/** Start a test of a release that is already on the panel, then open its page. */
export async function startTest(siteId, releaseId, { btn } = {}) {
  btn?.classList.add("loading");
  try {
    const run = await post(`/api/sites/${siteId}/tests`, { releaseId });
    location.hash = `#/tests/${run.id}`;
    return run;
  } catch (e) {
    if (e?.status === 409 && e.body?.runId) {
      toast("A test is already running for this website", "warn", { msg: e.message, action: { label: "Open it →", fn: () => (location.hash = `#/tests/${e.body.runId}`) } });
    } else toastError(e, "Couldn't start the test");
    return null;
  } finally { btn?.classList.remove("loading"); }
}

/** Resolve with the job once it has finished (live event, with a slow poll as a safety net). */
export function waitForJob(jobId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (j) => {
      if (done || !j || j.id !== jobId || !["succeeded", "failed", "cancelled"].includes(j.status)) return;
      done = true; off(); clearInterval(t); resolve(j);
    };
    const off = onEvent("job", finish);
    const t = setInterval(() => get(`/api/jobs/${jobId}`).then(finish).catch(() => {}), 3000);
  });
}

/**
 * After the admin picks a commit to pull: "Do you want to test this commit?"
 * Resolves "test" | "deploy" | "pull" (only when allowPullOnly) | false (dismissed).
 */
export function askTestOrDeploy({ title = "Pull this commit?", what, commit, allowPullOnly = false, loadBalanced = false } = {}) {
  const m = openModal({
    title, ico: "github",
    body: html`${commit ? html`<div class="tq-commit">${icon("branch", "sm")}<div style="min-width:0"><div class="strong ellipsis">${commit.message || what || ""}</div>
        <div class="muted small">${commit.shortSha ? html`<span class="mono">${commit.shortSha}</span>` : ""}${commit.author ? html` · ${commit.author}` : ""}${commit.date ? html` · ${ago(commit.date)}` : ""}</div></div></div>` : what ? html`<div class="tq-commit">${icon("branch", "sm")}<span class="mono strong">${what}</span></div>` : ""}
      <h4 class="tq-q">Do you want to test this commit?</h4>
      <div class="tq-opts">
        <button class="tq-opt primary" data-pick="test">${icon("flask")}<span><b>Test it</b><span>Claude Code tries it on a throw-away copy with its own empty database. Nothing is deployed; you decide after the verdict.</span></span></button>
        <button class="tq-opt" data-pick="deploy">${icon("rocket")}<span><b>Deploy now</b><span>Pull and put it live right away${loadBalanced ? ", one server at a time" : ""}.</span></span></button>
      </div>`,
    foot: html`${allowPullOnly ? html`<button class="btn btn-ghost left" data-pick="pull">${icon("download")}Only pull</button>` : ""}<button class="btn btn-ghost" data-close>Cancel</button>`,
    onMount(el, close) {
      on(el, "click", "[data-pick]", (e, b) => close(b.dataset.pick));
      setTimeout(() => $("[data-pick=test]", el)?.focus(), 40);
    },
  });
  return m.result.then((v) => v || false);
}

/**
 * "Test it" after a GitHub pull: pull WITHOUT deploying, wait for the release,
 * start the run and open the test page. Shows the two steps in a small dialog.
 */
export async function pullAndTest(S, ref) {
  const steps = [["pull", "Pulling the commit from GitHub"], ["start", "Preparing the test"]];
  let closed = false;
  const m = openModal({
    title: "Getting the commit ready", ico: "flask",
    body: html`<div class="tq-steps">${steps.map(([k, t]) => html`<div class="tq-step" data-step="${k}"><span class="tq-s-ico"></span><span>${t}</span></div>`)}</div>
      <p class="hint mt-16" data-sub>Nothing goes live. You can close this — the test keeps going and you can open it from the Tests tab.</p>`,
    foot: html`<button class="btn btn-ghost left" data-joblog hidden>${icon("fileText")}View log</button><button class="btn" data-close>Close</button>`,
  });
  m.result.then(() => (closed = true));
  const step = (k, state) => { const el = $(`[data-step=${k}]`, m.el); if (el) el.className = `tq-step ${state}`; };
  const fail = (msg) => {
    if (closed) { toast("Couldn't start the test", "err", { msg }); return; }
    mount($("[data-sub]", m.el), html`<span class="err-text">${msg}</span>`);
  };
  step("pull", "run");
  let job;
  try { job = await post(`/api/sites/${S.id}/releases/github`, { ref: ref || undefined, deploy: false }); }
  catch (e) { step("pull", "fail"); if (e?.status === 409) { m.close(); toastError(e); } else fail(e.message || String(e)); return; }
  const jl = $("[data-joblog]", m.el);
  if (jl && job?.id) { jl.hidden = false; jl.onclick = () => openJobLog(job.id); }
  const fin = job?.status === "succeeded" ? job : await waitForJob(job.id);
  const releaseId = fin?.result?.releaseId;
  if (fin.status !== "succeeded" || !releaseId) { step("pull", "fail"); fail(fin.status === "cancelled" ? "The pull was cancelled." : fin.error || "The pull didn't produce a release."); return; }
  step("pull", "ok"); step("start", "run");
  let run;
  try { run = await post(`/api/sites/${S.id}/tests`, { releaseId }); }
  catch (e) { step("start", "fail"); fail(e.message || String(e)); return; }
  step("start", "ok");
  if (!closed) { m.close(); location.hash = `#/tests/${run.id}`; }
  else toast("Test started", "info", { msg: `${S.name} · the commit you pulled`, action: { label: "Watch it →", fn: () => (location.hash = `#/tests/${run.id}`) } });
}

/* ───────── Tests tab ───────── */

export async function testsTab(ctx, box, S) {
  mount(box, skeletonRows(4, 56));
  let items;
  try { items = (await get(`/api/sites/${S.id}/tests`)).items || []; } catch (e) { if (ctx.alive()) mount(box, errorState(e)); return; }
  if (!ctx.alive()) return;
  const rels = S.releases || [];
  const relOf = (id) => rels.find((r) => r.id === id);
  const latestRel = rels[0];
  const paint = () => mount(box, html`
    <div class="section-head" style="margin-bottom:12px"><div><h2 style="font-size:16px">Commit tests</h2>
      <p>Each run builds a throw-away copy of one release and lets Claude Code try it. Nothing is deployed until you say so.</p></div>
      <div class="right">${latestRel ? html`<button class="btn btn-primary" data-newtest="${latestRel.id}">${icon("flask")}Test v${latestRel.version || "latest"}</button>` : ""}</div></div>
    ${items.length ? html`<div class="card"><div class="table-wrap"><table class="table tr-runs"><thead><tr><th>Result</th><th>Commit</th><th class="hide-sm">Score</th><th class="hide-sm">Duration</th><th>When</th><th></th></tr></thead><tbody>
      ${items.map((r) => {
        const rel = relOf(r.releaseId);
        const dur = r.startedAt ? fmtDuration((r.finishedAt ? new Date(r.finishedAt) : new Date()) - new Date(r.startedAt)) : "—";
        return html`<tr class="clickable" data-href="#/tests/${r.id}"><td>${verdictBadge(r, { score: false })}${isActive(r) && r.phase ? html`<div class="t-sub ellipsis" style="max-width:240px">${r.phase}</div>` : ""}</td>
          <td><div class="row small" style="gap:7px;min-width:0">${icon("github", "sm")}<span class="mono">${commitShort(r) || (rel?.commit || "").slice(0, 7) || "—"}</span><span class="badge mono">v${r.version || rel?.version || "—"}</span></div>
            ${r.commit?.message ? html`<div class="t-sub ellipsis" style="max-width:320px">${r.commit.message}</div>` : ""}</td>
          <td class="hide-sm">${r.score != null ? html`<span class="tr-score-mini ${r.verdict === "ready" ? "ok" : "err"}"><b class="num">${r.score}</b><span>/100</span></span>` : html`<span class="dim">—</span>`}</td>
          <td class="hide-sm num muted small">${dur}</td>
          <td><div class="small">${ago(r.createdAt)}</div><div class="t-sub hide-sm">${fmtDate(r.createdAt)}</div></td>
          <td class="actions"><div class="btn-row"><a class="btn btn-sm" href="#/tests/${r.id}">${isActive(r) ? html`<span class="dot run" style="width:6px;height:6px"></span>Watch` : html`Open${icon("arrowRight", "sm")}`}</a>
            <button class="icon-btn sm" data-runmenu="${r.id}" aria-label="More">${icon("more", "sm")}</button></div></td></tr>`;
      })}</tbody></table></div></div>`
      : html`<div class="card">${emptyState({ ico: "flask", title: "No tests yet", text: latestRel ? "Test a release before it goes live: Claude Code checks sign-in, payments, the database and the rest on a disposable copy, then tells you if it's ready for production." : "Pull a commit from GitHub or upload a release, then test it here.", sm: true,
        action: latestRel ? html`<button class="btn btn-primary" data-newtest="${latestRel.id}">${icon("flask")}Test v${latestRel.version || "latest"}</button>` : html`<a class="btn" href="#/sites/${S.id}/deployments">${icon("rocket")}Open Deployments</a>` })}</div>`}
    <div class="note mt-16">${icon("info")}<div>Test runs use the test-only variables from the <a href="#/sites/${S.id}/environment" style="color:var(--blue-3)">Environment</a> tab (e.g. Stripe test keys). Live payment keys are always removed from the copy, and its email goes to a catcher, never to real people.</div></div>`);
  paint();
  on(box, "click", "[data-newtest]", (e, b) => startTest(S.id, b.dataset.newtest, { btn: b }));
  on(box, "click", "tr[data-href]", (e, tr) => { if (!e.target.closest("a,button")) location.hash = tr.dataset.href; });
  on(box, "click", "[data-runmenu]", (e, b) => {
    const r = items.find((x) => x.id === b.dataset.runmenu);
    openMenu(b, [
      { label: "Open", icon: "arrowRight", onClick: () => (location.hash = `#/tests/${r.id}`) },
      { label: "Run again", icon: "refresh", disabled: isActive(r) || !relOf(r.releaseId), onClick: () => startTest(S.id, r.releaseId) },
      ...(r.jobId ? [{ label: "View log", icon: "fileText", onClick: () => openJobLog(r.jobId) }] : []),
      { sep: true },
      { label: "Delete", icon: "trash", danger: true, disabled: isActive(r), onClick: async () => {
        if (!(await confirmDialog({ title: "Delete this test run?", message: "Its checklist, findings and activity are removed. The release itself is kept.", danger: true, confirmText: "Delete run" }))) return;
        try { await del(`/api/tests/${r.id}`); items = items.filter((x) => x.id !== r.id); paint(); toast("Test run deleted", "ok"); } catch (ex) { toastError(ex, "Couldn't delete"); }
      } },
    ]);
  });
  ctx.on("testrun", (d) => {
    if (!d || d.siteId !== S.id) return;
    const i = items.findIndex((x) => x.id === d.id);
    if (d.deleted) { if (i >= 0) items.splice(i, 1); } else if (i >= 0) items[i] = d; else items.unshift(d);
    paint();
  });
}

/* ───────── Environment tab: test-only variables (write-only) ───────── */

export async function testEnvCard(ctx, el, S) {
  let keys = [];
  const load = async () => { keys = (await get(`/api/sites/${S.id}/test-env`)).items || []; };
  const paint = () => mount(el, html`<div class="card"><div class="card-head"><div><h3 class="row" style="gap:8px">${icon("flask", "sm")}Test-only variables</h3>
      <div class="sub">Used only by commit tests, on top of the variables above — e.g. Stripe <span class="mono">sk_test_…</span> keys. Values are write-only.</div></div></div>
    <div class="card-body">
      ${keys.length ? html`<div class="te-list">${keys.map((k) => html`<div class="te-row"><span class="mono strong ellipsis">${k.key}</span><span class="badge ok">${icon("lock")}Set</span>
        <span class="spacer"></span><button class="btn btn-sm btn-ghost" data-tereplace="${k.key}">${icon("edit")}Replace</button><button class="icon-btn sm" data-tedel="${k.key}" aria-label="Remove ${k.key}">${icon("trash")}</button></div>`)}</div>`
        : html`<p class="muted small">No test-only variables yet. Without them the copy runs with your normal variables, minus any live payment keys.</p>`}
      <form class="te-add mt-16" data-teadd novalidate>
        <input class="input mono" name="key" placeholder="STRIPE_SECRET_KEY" autocomplete="off" spellcheck="false" aria-label="Variable name"/>
        <input class="input mono" name="value" type="password" placeholder="sk_test_…" autocomplete="new-password" spellcheck="false" aria-label="Value"/>
        <button class="btn" type="submit">${icon("plus")}Add</button>
      </form>
      <p class="hint mt-12">Live payment keys (<span class="mono">sk_live_</span>, <span class="mono">pk_live_</span>, <span class="mono">rk_live_</span>, live <span class="mono">whsec_</span>) are always removed from a test copy, whether you set a replacement or not.</p>
    </div></div>`);
  const save = async (env, msg) => {
    try { const r = await put(`/api/sites/${S.id}/test-env`, { env }); keys = r?.items || (await get(`/api/sites/${S.id}/test-env`)).items || []; paint(); toast(msg, "ok"); return true; }
    catch (e) { toastError(e, "Couldn't save"); return false; }
  };
  try { await load(); } catch (e) { mount(el, errorState(e, false)); return; }
  if (!ctx.alive()) return;
  paint();
  on(el, "submit", "[data-teadd]", async (e, form) => {
    e.preventDefault();
    const key = form.elements.key.value.trim(), value = form.elements.value.value;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { toast("Use letters, digits and _ for the name", "warn"); form.elements.key.focus(); return; }
    if (!value) { toast("Type a value", "warn"); form.elements.value.focus(); return; }
    const btn = $("button[type=submit]", form); btn.classList.add("loading");
    await save({ [key]: value }, `${key} saved for tests`);
    btn.classList.remove("loading");
  });
  on(el, "click", "[data-tereplace]", (e, b) => {
    const f = $("[data-teadd]", el);
    f.elements.key.value = b.dataset.tereplace; f.elements.value.value = ""; f.elements.value.focus();
  });
  on(el, "click", "[data-tedel]", async (e, b) => {
    const k = b.dataset.tedel;
    if (!(await confirmDialog({ title: `Remove ${k}?`, message: "Future test runs won't get this variable.", danger: true, confirmText: "Remove" }))) return;
    save({ [k]: null }, `${k} removed`);
  });
}

/* ───────── runtime: Docker / Legacy ───────── */

export function runtimeBadge(S) {
  if (S.runtime === "docker") return html`<span class="badge blue" title="${S.container?.image ? `Runs in its own container (${S.container.image}) as its own user` : "Runs in its own container as its own user"}">${icon("container")}Docker</span>`;
  if (S.runtime === "legacy" || (!S.runtime && S.type !== "static" && S.canMigrate)) return html`<span class="badge warn" title="Runs under pm2 as root, sharing the server with the panel">${icon("server")}Legacy</span>`;
  return html``;
}

/** Ask, then POST /api/sites/:id/migrate { to }. */
export async function migrateSite(S, to) {
  const toDocker = to === "docker";
  const ok = await confirmDialog(toDocker ? {
    title: `Move ${S.name} to Docker?`, ico: "container", confirmText: "Move to Docker",
    message: "The website moves into its own container, running as its own user and seeing only its own folder and variables — one weak website can no longer reach the server or the panel.",
    extra: html`<ul class="tq-list"><li>${icon("clock", "sm")}<span>It restarts once. The new copy is built first, so visitors only notice the few seconds of the swap.</span></li>
      <li>${icon("server", "sm")}<span>Docker is installed on ${(S.serverIds || []).length > 1 ? `its ${S.serverIds.length} servers` : "its server"} if it isn't there yet.</span></li>
      <li>${icon("rollback", "sm")}<span>If anything fails it goes back the old way by itself, and you can always move it back from this menu.</span></li></ul>`,
  } : {
    title: `Move ${S.name} back to the legacy runtime?`, ico: "rollback", confirmText: "Move back", danger: true,
    message: "The container is removed and the website runs under pm2 again, as root, like before. It restarts once while it switches. You can move it to Docker again later.",
  });
  if (!ok) return null;
  try {
    const job = await post(`/api/sites/${S.id}/migrate`, { to });
    jobStarted(job, toDocker ? `Moving ${S.name} to Docker` : `Moving ${S.name} back to the legacy runtime`);
    return job;
  } catch (e) { toastError(e, "Couldn't start the move"); return null; }
}

/** Settings tab card: runtime + container limits. Returns markup; bind with bindRuntimeCard. */
export function runtimeCard(S) {
  if (S.runtime === "none" || S.type === "static") return html``;
  const c = S.container || {};
  if (S.runtime !== "docker") {
    return html`<div class="card"><div class="card-head"><h3>Runtime</h3><div class="right">${runtimeBadge(S)}</div></div>
      <div class="card-body row wrap" style="justify-content:space-between;gap:16px">
        <p class="muted small" style="max-width:600px">This website runs under pm2 as <b>root</b> and inherits the server's environment. In a container it runs as its own user, sees only its own folder, gets only its own variables and has memory and CPU limits.</p>
        ${S.canMigrate ? html`<button class="btn btn-primary" data-migrate="docker">${icon("container")}Move to Docker</button>` : html`<span class="muted small">Can't be moved right now.</span>`}</div></div>`;
  }
  return html`<div class="card"><div class="card-head"><h3>Container</h3><span class="sub">${c.uid ? html`runs as uid <span class="mono">${c.uid}</span>` : ""}</span><div class="right">${runtimeBadge(S)}</div></div>
    <div class="card-body"><div class="form-grid">
      <div class="field"><label>Memory limit (MB)</label><input class="input mono" type="number" min="64" step="64" data-ct="memoryMb" value="${c.memoryMb ?? ""}" placeholder="default"/></div>
      <div class="field"><label>CPUs</label><input class="input mono" type="number" min="0.1" step="0.1" data-ct="cpus" value="${c.cpus ?? ""}" placeholder="default"/></div>
      <div class="field span-2"><label>Image</label><input class="input mono" data-ct="image" value="${c.image || ""}" placeholder="node:20-bookworm-slim" spellcheck="false"/><div class="hint">The base image the website is installed, built and run in. Leave as is unless the app needs a different Node version.</div></div>
    </div></div>
    <div class="card-foot"><button class="btn btn-ghost" data-migrate="legacy">${icon("rollback")}Move back to legacy</button><span class="spacer"></span><span class="muted small hide-sm">Used the next time the container starts.</span><button class="btn btn-primary btn-sm" data-save-container>${icon("check")}Save</button></div></div>`;
}

export function bindRuntimeCard(box, getS, { save, onMigrate } = {}) {
  on(box, "click", "[data-migrate]", async (e, b) => { const job = await migrateSite(getS(), b.dataset.migrate); if (job) onMigrate?.(job); });
  on(box, "click", "[data-save-container]", (e, btn) => {
    const container = {};
    $$("[data-ct]", box).forEach((i) => {
      const v = i.value.trim();
      if (i.dataset.ct === "image") { if (v) container.image = v; }
      else if (v !== "") container[i.dataset.ct] = Number(v);
    });
    if (container.memoryMb != null && !(container.memoryMb >= 64)) { toast("Give the container at least 64 MB", "warn"); return; }
    if (container.cpus != null && !(container.cpus > 0)) { toast("CPUs must be more than 0", "warn"); return; }
    save(btn, { container }, "Container settings saved");
  });
}

