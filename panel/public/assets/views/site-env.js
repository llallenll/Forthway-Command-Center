// Website page → Environment tab: one switch for Live / Test / Staging variables.
//
//   Live     the website's own variables, what the panel manages, linked databases.
//   Test     the test-only variables commit tests use (views/site-tests.js testEnvCard)
//            and, read-only, the throw-away database every test run gets (test_<slug>).
//   Staging  the staging copy's own variables and its controls (panel/lib/staging.mjs),
//            or "Start staging" when the website has none.
//
// The chosen view is kept in the URL (#/sites/:id/environment?view=test) and
// remembered in this browser. Also exported for site.js: the staging strip at
// the top of the Overview and the release rows' "Deploy to staging" button.
import { html, raw, mount, $, $$, on, ago, fmtBytes, plural, emptyState, errorState, skeletonRows, toast, toastError, confirmDialog, openMenu } from "../util.js";
import { icon } from "../icons.js";
import { get, post, patch, put, del } from "../api.js";
import { envEditor, jobStarted, jobItem, bindJobClicks } from "../components.js";
import { foldCard } from "../fold.js";
import { testEnvCard } from "./site-tests.js";

const VIEWS = [
  { id: "live", label: "Live", icon: "globe" },
  { id: "test", label: "Test", icon: "flask" },
  { id: "staging", label: "Staging", icon: "layers" },
];
const VIEW_KEY = "fcc.env.view";
const remembered = () => { try { return localStorage.getItem(VIEW_KEY) || ""; } catch { return ""; } };
const remember = (v) => { try { localStorage.setItem(VIEW_KEY, v); } catch { /* private window */ } };

const stagingStatus = (st) => {
  if (!st) return { tone: "off", text: "—" };
  if (st.deleting) return { tone: "warn", text: "Being removed" };
  if (st.deploying) return { tone: "run", text: "Deploying" };
  if (!st.currentReleaseId) return { tone: "off", text: st.busyJobId ? "First deploy running" : "Not deployed" };
  if (st.running === false) return { tone: "off", text: "Stopped" };
  if (st.running && st.healthy === false) return { tone: "err", text: "Unhealthy" };
  if (st.running) return { tone: "ok", text: st.healthy ? "Healthy" : "Running" };
  return { tone: "off", text: "Unknown" };
};
const relLabel = (r) => (r ? (r.version ? `v${r.version}` : (r.github?.sha || r.commit || r.id || "").slice(0, 7) || "unversioned") : "—");

/* ───────── Overview strip (site.js, top of the overview) ───────── */

export function stagingStrip(S, base = `#/sites/${S.id}`) {
  const st = S.staging;
  if (st?.role === "staging") {
    return html`<div class="stg-strip">${icon("layers", "sm")}<div class="stg-strip-t">This is the <b>staging copy</b> of <a href="#/sites/${st.parentId}">${st.parentName || "its website"}</a> — its releases come from there.</div>
      <a class="btn btn-sm btn-ghost" href="#/sites/${st.parentId}/environment?view=staging">Staging controls ${icon("arrowRight", "sm")}</a></div>`;
  }
  if (st?.role !== "parent") return "";
  const s = stagingStatus(st);
  return html`<div class="stg-strip">
    <span class="badge violet">${icon("layers")}Staging</span>
    <span class="status"><span class="dot ${s.tone}"></span>${s.text}</span>
    <span class="dim hide-sm">·</span><span class="mono small">${st.currentVersion ? `v${st.currentVersion}` : st.currentReleaseId ? "unversioned" : "no release"}</span>
    ${st.url ? html`<span class="dim hide-sm">·</span><a class="mono small ellipsis stg-strip-url" href="${st.url}" target="_blank" rel="noopener noreferrer">${st.url.replace(/^https?:\/\//, "")}${icon("external", "xs")}</a>` : ""}
    <span class="spacer"></span>
    <a class="btn btn-sm btn-ghost" href="${base}/environment?view=staging">Manage ${icon("arrowRight", "sm")}</a></div>`;
}

/* ───────── release rows: "Deploy to staging" (site.js Deployments) ───────── */

export function stagingReleaseBtn(S, r) {
  const st = S.staging;
  if (st?.role !== "parent" || r.available === false || st.deleting) return "";
  const on = st.currentReleaseId === r.id;
  return html`<button class="btn btn-sm" data-stgdeploy="${st.id}" data-stgrel="${r.id}" data-stgver="${relLabel(r)}" title="${on ? "Staging runs this release — deploy it there again" : `Deploy this release to staging${st.url ? ` (${st.url.replace(/^https?:\/\//, "")})` : ""}`}">${icon("layers")}<span class="hide-sm">${on ? "Redeploy staging" : "To staging"}</span></button>`;
}

async function deployToStaging(stagingId, releaseId, label, btn) {
  btn?.classList.add("loading");
  try { jobStarted(await post(`/api/sites/${stagingId}/deploy`, { releaseId }), `Deploying ${label || "the release"} to staging`); }
  catch (e) { toastError(e, "Couldn't deploy to staging"); }
  finally { btn?.classList.remove("loading"); }
}
// One delegated handler for every page (the release rows are re-rendered often).
document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-stgdeploy]");
  if (b) deployToStaging(b.dataset.stgdeploy, b.dataset.stgrel, b.dataset.stgver, b);
});

/* ───────── the tab ───────── */

export async function environmentTab(ctx, box, S, { databases = [] } = {}) {
  const base = `#/sites/${S.id}`;
  const isCopy = !!S.stagingOf;
  let view = isCopy ? "live" : VIEWS.some((v) => v.id === ctx.query?.view) ? ctx.query.view : VIEWS.some((v) => v.id === remembered()) ? remembered() : "live";
  let cur = S; // kept fresh from `site` events (site.js keeps its own copy)

  mount(box, html`${isCopy ? html`<div class="note" style="margin-bottom:16px">${icon("layers")}<div>These are the variables of the <b>staging copy</b> of <a href="#/sites/${S.staging?.parentId}" style="color:var(--blue-3)">${S.staging?.parentName || "its website"}</a>. Its live and test variables are on that website's Environment tab.</div></div>`
      : html`<div class="env-switch"><div class="seg env-seg" role="tablist" aria-label="Which variables">${VIEWS.map((v) => html`<button type="button" role="tab" data-envview="${v.id}" aria-selected="${v.id === view ? "true" : "false"}" class="${v.id === view ? "active" : ""}">${icon(v.icon, "sm")}${v.label}</button>`)}</div>
        <p class="muted small env-switch-sub" data-envsub></p></div>`}
    <div data-envpane></div>`);
  const pane = $("[data-envpane]", box);
  const SUB = {
    live: "What the website runs with in production.",
    test: "Extra variables and the throw-away database every commit test gets.",
    staging: "A second, persistent copy of the website with its own variables and database.",
  };
  let gen = 0; // ignore a slow load when the view was switched meanwhile
  const show = async (v) => {
    view = v; remember(v);
    const my = ++gen;
    $$("[data-envview]", box).forEach((b) => { const a = b.dataset.envview === v; b.classList.toggle("active", a); b.setAttribute("aria-selected", a ? "true" : "false"); });
    const sub = $("[data-envsub]", box); if (sub) sub.textContent = SUB[v];
    if (!isCopy) history.replaceState(null, "", `${base}/environment${v === "live" ? "" : `?view=${v}`}`);
    const el = document.createElement("div");
    pane.replaceChildren(el);
    mount(el, skeletonRows(3, 44));
    const alive = () => ctx.alive() && my === gen;
    if (v === "live") await liveView(ctx, el, cur, { databases, alive });
    else if (v === "test") await testView(ctx, el, cur, { alive });
    else await stagingView(ctx, el, () => cur, { alive, reload: () => show("staging") });
  };
  on(box, "click", "[data-envview]", (e, b) => { if (b.dataset.envview !== view) show(b.dataset.envview); });
  ctx.on("site", (d) => {
    if (!d || d.deleted || d.id !== S.id) return;
    const had = cur.staging?.role === "parent" ? cur.staging.id : null;
    cur = { ...cur, ...d };
    const has = cur.staging?.role === "parent" ? cur.staging.id : null;
    if (view === "staging" && had !== has && !box.querySelector("[data-stgstart].loading")) show("staging");
    else if (view === "staging") paintStagingStatus(box, cur);
  });
  await show(view);
}

/* ───────── Live ───────── */

async function liveView(ctx, el, S, { databases, alive }) {
  let envData;
  try { envData = await get(`/api/sites/${S.id}/env`); } catch (e) { if (alive()) mount(el, errorState(e, false)); return; }
  if (!alive()) return;
  const linked = Array.isArray(envData.linked) ? envData.linked : Object.entries(envData.linked || {}).map(([k, v]) => ({ name: k, vars: v }));
  mount(el, html`<div class="grid-main">
    <div class="card"><div class="card-head"><h3>${S.stagingOf ? "Staging variables" : "Environment variables"}</h3><span class="sub" data-dirty></span><div class="right"><button class="btn btn-primary btn-sm" data-save>${icon("check")}Save & apply</button></div></div>
      <div class="card-body"><div data-suggest></div><div data-env></div>
      <div class="note mt-16">${icon("info")}<div>Saved to the app's <span class="mono">.env</span> on ${S.loadBalanced ? `all ${S.serverIds.length} servers` : "its server"} and passed to the process. The app restarts to pick up changes.</div></div></div></div>
    <div class="stack">
      ${(envData.managed || []).length ? foldCard({ id: "site.env.managed", title: "Managed by the panel", sub: "read-only", count: envData.managed.length, open: false, body: html`
        <div class="card-body"><div class="env-table">${envData.managed.map((m) => html`<div class="env-row ro" style="grid-template-columns:minmax(0,1.2fr) minmax(0,.9fr)"><input class="input mono" value="${m.key}" readonly/><input class="input" value="${m.pending ? "(created on first deploy)" : m.value}" readonly/></div>`)}</div>
        ${envData.managed.map((m) => html`<div class="note mt-16">${icon("info")}<div>${m.note}</div></div>`)}</div>` }) : ""}
      ${foldCard({ id: "site.env.linked", title: "From linked databases", sub: "read-only", count: linked.length ? linked.reduce((n, l) => n + Object.keys(l.vars || {}).length, 0) : null, open: false, forceOpen: linked.some((l) => l.error), body: html`
        <div class="card-body">${linked.length ? html`<div class="stack" style="gap:16px">${linked.map((l) => html`<div><div class="row small strong" style="gap:8px;margin-bottom:8px">${icon("database", "sm")}<span class="mono">${l.name}</span>${l.prefix ? html`<span class="badge mono">${l.prefix}*</span>` : ""}</div>
          ${l.error ? html`<div class="error-box">${icon("alert")}<div>${l.error}</div></div>` : html`<div class="env-table">${Object.entries(l.vars || {}).map(([k, v]) => html`<div class="env-row ro" style="grid-template-columns:minmax(0,.9fr) minmax(0,1.2fr)"><input class="input" value="${k}" readonly/><input class="input" value="${v}" readonly/></div>`)}</div>`}</div>`)}</div>`
          : html`<p class="muted small">No databases linked. Link one below and its connection variables are added automatically.</p>`}</div>` })}
      <div class="card"><div class="card-head"><h3>Linked databases</h3></div><div class="card-body">
        ${databases.length ? html`<div class="stack" style="gap:10px">${databases.map((d) => html`<label class="check"><input type="checkbox" data-ldb value="${d.id}" ${(S.linkedDatabaseIds || []).includes(d.id) ? raw("checked") : ""}/><span class="mono">${d.name}</span><span class="dim small">${fmtBytes(d.sizeBytes)}</span></label>`)}</div>
          <button class="btn btn-sm mt-16" data-savelinks>${icon("link")}Update links</button>`
        : html`<p class="muted small">This project has no databases. <a href="#/projects/${S.projectId}/databases" style="color:var(--blue-3)">Create one →</a></p>`}
      </div></div>
    </div></div>`);
  const dirty = $("[data-dirty]", el);
  const ed = envEditor($("[data-env]", el), envData.env || {}, { onDirty: () => (dirty.textContent = "Unsaved changes") });
  const ex = (S.releases || []).find((r) => r.id === S.currentReleaseId)?.envExample || (S.releases || []).find((r) => r.envExample)?.envExample;
  const linkedKeys = new Set(linked.flatMap((l) => Object.keys(l.vars || {})));
  const missing = (ex?.entries || []).filter((x) => x.key && !(x.key in (envData.env || {})) && !linkedKeys.has(x.key) && x.key !== "PORT");
  if (missing.length) {
    mount($("[data-suggest]", el), html`<div class="note" style="margin-bottom:16px;align-items:center">${icon("sparkles")}<div style="flex:1"><b>${ex.file || ".env.example"}</b> in the latest release lists ${plural(missing.length, "key")} not set here: <span class="mono small">${missing.slice(0, 6).map((x) => x.key).join(", ")}${missing.length > 6 ? "…" : ""}</span></div><button class="btn btn-sm" data-addex>${icon("plus")}Add them</button></div>`);
    on(el, "click", "[data-addex]", () => { ed.set({ ...ed.get(), ...Object.fromEntries(missing.map((x) => [x.key, x.value || ""])) }); dirty.textContent = "Unsaved changes"; $("[data-suggest]", el).innerHTML = ""; });
  }
  on(el, "click", "[data-save]", async (e, b) => {
    const err = ed.validate(); if (err) { toast(err, "warn"); return; }
    b.classList.add("loading");
    try {
      const r = await put(`/api/sites/${S.id}/env`, { env: ed.get() }); dirty.textContent = "";
      if (r?.env) ed.set(r.env);
      if ((r?.warnings || []).length) toast("Saved with warnings", "warn", { msg: r.warnings.join(" ") });
      else toast("Environment saved", "ok", { msg: "The app restarts to apply it." });
      if (r?.job?.id) jobStarted(r.job, "Applying environment");
    } catch (ex2) { toastError(ex2, "Couldn't save"); } finally { b.classList.remove("loading"); }
  });
  on(el, "click", "[data-savelinks]", async (e, b) => {
    const ids = $$("[data-ldb]", el).filter((x) => x.checked).map((x) => x.value);
    b.classList.add("loading");
    try { await patch(`/api/sites/${S.id}`, { linkedDatabaseIds: ids }); toast("Database links updated", "ok"); ctx.reload(); } catch (ex2) { toastError(ex2); } finally { b.classList.remove("loading"); }
  });
}

/* ───────── Test ───────── */

async function testView(ctx, el, S, { alive }) {
  mount(el, html`<div class="grid-main"><div data-testenv></div><div data-testdb></div></div>`);
  const dbEl = $("[data-testdb]", el);
  const [, info] = await Promise.all([
    testEnvCard(ctx, $("[data-testenv]", el), S),
    get(`/api/sites/${S.id}/test-env`).catch((e) => ({ error: e })),
  ]);
  if (!alive()) return;
  if (info?.error) { mount(dbEl, errorState(info.error, false)); return; }
  const d = info?.database;
  mount(dbEl, html`<div class="card"><div class="card-head"><div><h3 class="row" style="gap:8px">${icon("database", "sm")}Test database</h3><div class="sub">Created for every test run, then thrown away · read-only</div></div></div>
    <div class="card-body">${!d ? html`<p class="muted small">${S.type === "static" ? "Static websites run no code of their own, so their tests get no database." : "This website's tests get no database."}</p>`
      : html`<div class="stack" style="gap:8px">${d.databases.map((x) => html`<div class="row small" style="gap:8px;flex-wrap:wrap">${icon("database", "sm")}<span class="mono strong">${x.name}</span><span class="dim">on</span><span class="mono">${x.host}:${x.port}</span>${x.added ? html`<span class="badge blue" title="This website has no database of its own; the test copy gets one anyway">added for tests</span>` : html`<span class="muted">empty copy for ${x.source}</span>`}</div>`)}</div>
        <div class="env-table mt-16">${d.vars.map((v) => html`<div class="env-row ro" style="grid-template-columns:minmax(0,.9fr) minmax(0,1.2fr)"><input class="input" value="${v.key}" readonly aria-label="Variable"/>${v.random && !/:\/\//.test(v.value) ? html`<input class="input env-random" value="random per run" readonly aria-label="${v.key} value"/>` : html`<input class="input" value="${v.value.replace(/‹random›/g, "…")}" title="${v.random ? "User and password are random for every run" : ""}" readonly aria-label="${v.key} value"/>`}</div>`)}</div>
        <p class="hint mt-12">An empty MySQL database with random credentials, on the test's own network — it never sees production data. Your schema comes from the release's after-deploy scripts or migrations.${d.databases.some((x) => x.added) ? " The website has no database of its own, so these standard variables are added for the copy." : ""}</p>`}
    </div></div>`);
}

/* ───────── Staging ───────── */

function paintStagingStatus(root, S) {
  const el = $("[data-stgstatus]", root);
  const st = S.staging;
  if (!el || st?.role !== "parent") return;
  const s = stagingStatus(st);
  mount(el, html`<div class="stg-facts">
    <div><div class="ms-l">Status</div><div class="row" style="gap:8px"><span class="dot ${s.tone}"></span><b>${s.text}</b></div>${st.error ? html`<div class="t-sub" style="color:#ff8ea3">${st.error}</div>` : ""}</div>
    <div><div class="ms-l">Release</div><div class="mono">${st.currentVersion ? `v${st.currentVersion}` : st.currentReleaseId ? "unversioned" : "—"}</div>${S.currentVersion ? html`<div class="t-sub">live: v${S.currentVersion}</div>` : ""}</div>
    <div><div class="ms-l">Address</div>${st.url ? html`<a class="mono ellipsis" style="display:block" href="${st.url}" target="_blank" rel="noopener noreferrer">${st.url.replace(/^https?:\/\//, "")}</a>` : html`<span class="muted">no domain</span>`}<div class="t-sub">${st.serverName} · port ${st.port}</div></div>
  </div>
  ${st.busyJobId ? html`<div class="note mt-16" style="align-items:center">${icon("refresh")}<div style="flex:1">A job is running on staging.</div><button class="btn btn-sm" data-job="${st.busyJobId}">View log</button></div>` : ""}`);
  bindJobClicks(el);
  const run = $("[data-stgrun]", root);
  if (run) {
    const running = st.running !== false && !!st.currentReleaseId;
    run.dataset.stgrun = running ? "stop" : "start";
    mount(run, html`${icon(running ? "stop" : "play")}${running ? "Stop" : "Start"}`);
    run.disabled = !st.currentReleaseId;
  }
}

async function stagingView(ctx, el, getS, { alive, reload }) {
  const S = getS();
  const st = S.staging;
  if (st?.role !== "parent") return startCta(ctx, el, S, { reload });

  let child = null, envData = null;
  try { [child, envData] = await Promise.all([get(`/api/sites/${st.id}`), get(`/api/sites/${st.id}/env`)]); }
  catch (e) { if (alive()) mount(el, errorState(e, false)); return; }
  if (!alive()) return;
  const linked = envData.linked || [];
  const dbNames = linked.map((l) => l.name);
  mount(el, html`<div class="card stg-card"><div class="card-head" style="flex-wrap:wrap"><div style="min-width:0"><h3 class="row" style="gap:8px">${icon("layers", "sm")}${child.name}</h3><div class="sub">Runs next to production · releases come from ${S.name}</div></div>
      <div class="right btn-row">
        ${st.url ? html`<a class="btn btn-sm" href="${st.url}" target="_blank" rel="noopener noreferrer">${icon("external")}Open</a>` : ""}
        <button class="btn btn-sm btn-primary" data-stgdeploymenu>${icon("rocket")}Deploy a release</button>
        <button class="btn btn-sm" data-stgrun>${icon("play")}Start</button>
        <button class="icon-btn sm" data-stgmore aria-label="More staging actions">${icon("more")}</button></div></div>
      <div class="card-body" data-stgstatus></div></div>
    <div class="grid-main mt-20">
      <div class="card"><div class="card-head"><h3>Staging variables</h3><span class="sub" data-dirty></span><div class="right"><button class="btn btn-primary btn-sm" data-stgsave>${icon("check")}Save & apply</button></div></div>
        <div class="card-body"><div data-env></div>
        <div class="note mt-16">${icon("info")}<div>Staging's own variables — copied from Live when staging started (live payment keys left out, database settings pointed at the staging database) and edited separately since. Saving restarts the staging app only.</div></div></div></div>
      <div class="stack">
        ${foldCard({ id: "site.env.stglinked", title: "From the staging database", sub: "read-only", count: linked.reduce((n, l) => n + Object.keys(l.vars || {}).length, 0) || null, open: false, forceOpen: linked.some((l) => l.error), body: html`
          <div class="card-body">${linked.length ? html`<div class="stack" style="gap:16px">${linked.map((l) => html`<div><div class="row small strong" style="gap:8px;margin-bottom:8px">${icon("database", "sm")}<span class="mono">${l.name}</span>${l.prefix ? html`<span class="badge mono">${l.prefix}*</span>` : ""}</div>
            ${l.error ? html`<div class="error-box">${icon("alert")}<div>${l.error}</div></div>` : html`<div class="env-table">${Object.entries(l.vars || {}).map(([k, v]) => html`<div class="env-row ro" style="grid-template-columns:minmax(0,.9fr) minmax(0,1.2fr)"><input class="input" value="${k}" readonly/><input class="input" value="${v}" readonly/></div>`)}</div>`}</div>`)}</div>`
            : html`<p class="muted small">Staging has no database — ${S.name} doesn't use one.</p>`}</div>` })}
        <div class="card"><div class="card-head"><h3>Staging domain</h3></div><div class="card-body">
          <div class="input-group"><input class="input mono" data-stgdomain value="${(child.domains || [])[0] || ""}" placeholder="staging.example.com" spellcheck="false" autocomplete="off" aria-label="Staging domain"/><button class="btn" data-stgdomsave>${icon("check")}Save</button></div>
          <p class="hint mt-12">Point its DNS at the server like any website.${child.cloudflare?.enabled ? " Delivered through your Cloudflare Tunnel, like the live site." : ""}</p>
          ${!child.cloudflare?.enabled && (child.domains || []).length ? html`<div class="row mt-12" style="gap:8px;flex-wrap:wrap"><span class="small">${child.ssl?.status === "active" ? html`<span class="status"><span class="dot ok"></span>HTTPS active</span>` : html`<span class="muted">No HTTPS certificate yet.</span>`}</span><span class="spacer"></span><button class="btn btn-sm" data-stgssl>${icon("shield")}${child.ssl?.status === "active" ? "Re-issue" : "Issue certificate"}</button></div>` : ""}
          <a class="btn btn-sm btn-ghost mt-12" href="#/sites/${child.id}">${icon("settings")}Logs, settings & more ${icon("arrowRight", "sm")}</a>
        </div></div>
        <div class="card"><div class="card-head"><h3>Staging jobs</h3></div><div class="list" data-stgjobs></div></div>
      </div></div>`);
  paintStagingStatus(el, S);
  const dirty = $("[data-dirty]", el);
  const ed = envEditor($("[data-env]", el), envData.env || {}, { onDirty: () => (dirty.textContent = "Unsaved changes") });

  // jobs of the staging copy
  let jobs = [];
  const jobsEl = $("[data-stgjobs]", el);
  const paintJobs = () => { mount(jobsEl, jobs.length ? html`${jobs.slice(0, 5).map(jobItem)}` : emptyState({ ico: "rocket", title: "No staging jobs yet", text: "Deploys and restarts of staging appear here.", sm: true })); bindJobClicks(jobsEl); };
  try { jobs = (await get(`/api/jobs?siteId=${child.id}&limit=5`)).items || []; } catch {}
  if (!alive()) return;
  paintJobs();
  ctx.on("job", (j) => { if (!alive() || j.siteId !== child.id) return; const i = jobs.findIndex((x) => x.id === j.id); i >= 0 ? (jobs[i] = j) : jobs.unshift(j); paintJobs(); });

  const S2 = () => getS();
  on(el, "click", "[data-stgdeploymenu]", (e, b) => {
    const rels = (S2().releases || []).filter((r) => r.available !== false);
    if (!rels.length) { toast("No releases yet", "warn", { msg: `Upload or pull a release on ${S.name} first.` }); return; }
    const cur = S2().staging || {};
    openMenu(b, rels.slice(0, 12).map((r) => ({
      label: `${relLabel(r)}${r.id === S2().currentReleaseId ? " · live" : ""}${r.id === cur.currentReleaseId ? " · on staging" : ""}`,
      icon: r.id === cur.currentReleaseId ? "check" : "rocket",
      onClick: () => deployToStaging(cur.id, r.id, relLabel(r), b),
    })), { head: "Deploy to staging" });
  });
  on(el, "click", "[data-stgrun]", async (e, b) => {
    const act = b.dataset.stgrun;
    if (act === "stop" && !(await confirmDialog({ title: "Stop staging?", message: `${child.name} stops answering until you start it again. Production is not affected.`, confirmText: "Stop staging", danger: true, ico: "stop" }))) return;
    b.classList.add("loading");
    try { jobStarted(await post(`/api/sites/${child.id}/${act}`), act === "stop" ? "Stopping staging" : "Starting staging"); }
    catch (ex) { toastError(ex, `Couldn't ${act} staging`); } finally { b.classList.remove("loading"); }
  });
  on(el, "click", "[data-stgsave]", async (e, b) => {
    const err = ed.validate(); if (err) { toast(err, "warn"); return; }
    b.classList.add("loading");
    try {
      const r = await put(`/api/sites/${child.id}/env`, { env: ed.get() }); dirty.textContent = "";
      if (r?.env) ed.set(r.env);
      if ((r?.warnings || []).length) toast("Saved with warnings", "warn", { msg: r.warnings.join(" ") });
      else toast("Staging variables saved", "ok", { msg: r?.job ? "The staging app restarts to apply them." : "They apply on the first deploy." });
      if (r?.job?.id) jobStarted(r.job, "Applying staging variables");
    } catch (ex) { toastError(ex, "Couldn't save"); } finally { b.classList.remove("loading"); }
  });
  on(el, "click", "[data-stgdomsave]", async (e, b) => {
    const d = $("[data-stgdomain]", el).value.trim().toLowerCase();
    b.classList.add("loading");
    try { const r = await patch(`/api/sites/${child.id}`, { domains: d ? [d] : [] }); if (r?.job?.id) jobStarted(r.job, "Applying the staging domain"); else toast("Staging domain saved", "ok"); reload(); }
    catch (ex) { toastError(ex, "Couldn't save the domain"); } finally { b.classList.remove("loading"); }
  });
  on(el, "click", "[data-stgssl]", async (e, b) => {
    b.classList.add("loading");
    try { jobStarted(await post(`/api/sites/${child.id}/ssl`), "Requesting the staging certificate"); } catch (ex) { toastError(ex, "Couldn't request a certificate"); } finally { b.classList.remove("loading"); }
  });
  on(el, "click", "[data-stgmore]", (e, b) => openMenu(b, [
    { label: "Restart staging", icon: "restart", onClick: async () => { try { jobStarted(await post(`/api/sites/${child.id}/restart`), "Restarting staging"); } catch (ex) { toastError(ex); } } },
    { label: "Staging logs", icon: "fileText", onClick: () => (location.hash = `#/sites/${child.id}/logs`) },
    { sep: true },
    { label: "Remove staging…", icon: "trash", danger: true, onClick: () => removeStaging(S2(), child, dbNames, reload) },
  ]));
}

async function removeStaging(S, child, dbNames, reload) {
  const r = await confirmDialog({
    title: `Remove staging of ${S.name}?`, danger: true, ico: "trash", confirmText: "Remove staging", typed: "staging",
    message: `${child.name} is stopped and removed from its server and nginx${(child.domains || [])[0] ? `, and ${child.domains[0]} stops answering` : ""}. ${S.name} itself is not touched.`,
    extra: html`<label class="check mt-16"><input type="checkbox" data-extra name="deleteFiles" checked/>Delete the staging app files on the server</label>
      ${dbNames.length ? html`<label class="check mt-12"><input type="checkbox" data-extra name="dropDatabase"/>Also drop the staging database${dbNames.length > 1 ? "s" : ""} <span class="mono">${dbNames.join(", ")}</span> — everything in ${dbNames.length > 1 ? "them" : "it"} is deleted for good</label>
        <p class="hint" style="margin:6px 0 0 26px">Leave it unticked to keep the data; it stays under Databases and is reused if you start staging again.</p>` : ""}`,
  });
  if (!r) return;
  try {
    const job = await del(`/api/sites/${S.id}/staging?deleteFiles=${r.deleteFiles ? "1" : "0"}${r.dropDatabase ? "&dropDatabase=1" : ""}`);
    jobStarted(job, r.dropDatabase ? "Removing staging and its database" : "Removing staging");
    setTimeout(reload, 600);
  } catch (ex) { toastError(ex, "Couldn't remove staging"); }
}

function startCta(ctx, el, S, { reload }) {
  const first = (S.domains || [])[0] || "";
  const bare = first.replace(/^\*\./, "").replace(/^www\./, "");
  const dflt = bare ? (bare.startsWith("staging.") ? `stg.${bare}` : `staging.${bare}`) : "";
  const usesDb = S.type !== "static" && (S.linkedDatabaseIds || []).length > 0;
  const nDb = (S.linkedDatabaseIds || []).length || 1;
  const dbName = `staging_${String(S.slug || S.name || "site").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "")}`;
  const rel = (S.releases || []).find((r) => r.id === S.currentReleaseId);
  mount(el, html`<div class="card stg-cta"><div class="card-body">
    <div class="stg-cta-head"><span class="stg-cta-ico">${icon("layers")}</span><div><h3>Start a staging copy of ${S.name}</h3>
      <p class="muted small">A second copy that runs next to production, with its own address, variables and database — try a release there before it goes live.</p></div></div>
    <ul class="stg-list">
      <li>${icon("globe", "sm")}<span>Its own address and port on ${S.loadBalanced ? "the first of its servers (staging isn't load balanced)" : "the same server"}.</span></li>
      <li>${icon("database", "sm")}<span>${S.type === "static" ? "No database — static websites don't use one." : usesDb ? html`Its own database${nDb > 1 ? "s" : ""} <span class="mono">${dbName}${nDb > 1 ? "…" : ""}</span> (with the project prefix) and user — created now and linked, so it never touches live data.` : "No linked database. If its own variables hold MySQL settings, a staging database is made for those too."}</span></li>
      <li>${icon("key", "sm")}<span>Live variables copied once — live payment keys left out, database settings and links to ${bare || "the live domain"} pointed at staging. Edit them here afterwards.</span></li>
      <li>${icon("rocket", "sm")}<span>${rel ? html`Then ${relLabel(rel)} — what's live now — is deployed to it.` : "Nothing is deployed yet; deploy a release to staging when you have one."}</span></li>
    </ul>
    <div class="form-grid mt-16">
      <div class="field"><label>Staging domain</label><input class="input mono" data-stgnewdomain value="${dflt}" placeholder="staging.example.com" spellcheck="false" autocomplete="off"/><div class="hint">Leave empty for none — you can add one later.</div></div>
      ${rel ? html`<div class="field"><label>&nbsp;</label><label class="check"><input type="checkbox" data-stgdeploynow checked/>Deploy ${relLabel(rel)} right away</label></div>` : ""}
    </div>
    <div class="btn-row mt-20"><button class="btn btn-primary" data-stgstart>${icon("layers")}Start staging</button></div>
  </div></div>`);
  on(el, "click", "[data-stgstart]", async (e, b) => {
    const domain = $("[data-stgnewdomain]", el).value.trim().toLowerCase();
    const deploy = $("[data-stgdeploynow]", el)?.checked !== false;
    b.classList.add("loading"); b.disabled = true;
    try {
      const r = await post(`/api/sites/${S.id}/staging`, { domain, deploy });
      const dbs = (r.databases || []).map((d) => d.name);
      toast("Staging started", "ok", { msg: [dbs.length ? `Database ${dbs.join(", ")} ${r.databases.some((d) => d.created) ? "created" : "reused"}.` : "", r.job ? "The first deploy is on its way." : ""].filter(Boolean).join(" ") || `${r.staging?.name} is ready.` });
      if ((r.warnings || []).length) toast("Good to know", "info", { msg: r.warnings.join(" ") });
      if (r.job?.id) jobStarted(r.job, "Deploying to staging");
      if (r.site) Object.assign(S, r.site);
      reload();
    } catch (ex) { toastError(ex, "Couldn't start staging"); b.classList.remove("loading"); b.disabled = false; }
  });
}
