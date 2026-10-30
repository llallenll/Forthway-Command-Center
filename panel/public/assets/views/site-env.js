// Website page → Environment tab: one switch for the website's variables.
//
// On a live website:
//   Live     the website's own variables, what the panel manages, linked databases.
//   Test     the test-only variables commit tests use (views/site-tests.js testEnvCard)
//            and, read-only, the throw-away database every test run gets (test_<slug>).
//   Staging  ONLY the staging build's own variables (saved to the staging build), or
//            "Create staging build" when there is none. Everything else about staging
//            (address, deploys, start/stop, database, remove) is on the staging build's
//            own page — the header's type icon switches to it (views/site-staging.js).
// On a staging build the switch is Staging / Test: its own variables (shown exactly like
// a live site's) and its own test-only variables. There is no "Live" segment there, so
// nothing on the staging page can change the live site's variables by accident.
//
// The chosen view is kept in the URL (#/sites/:id/environment?view=test) and
// remembered in this browser.
import { html, raw, mount, $, $$, on, fmtBytes, plural, errorState, skeletonRows, toast, toastError } from "../util.js";
import { icon } from "../icons.js";
import { get, patch, put } from "../api.js";
import { envEditor, jobStarted } from "../components.js";
import { foldCard } from "../fold.js";
import { testEnvCard } from "./site-tests.js";
import { createStagingDialog } from "./site-staging.js";

const VIEWS = [
  { id: "live", label: "Live", icon: "globe" },
  { id: "test", label: "Test", icon: "flask" },
  { id: "staging", label: "Staging", icon: "layers" },
];
// On a staging build: its own variables (the "live" pane, relabelled) and its test-only variables.
const COPY_VIEWS = [
  { id: "live", label: "Staging", icon: "layers" },
  { id: "test", label: "Test", icon: "flask" },
];
const VIEW_KEY = "fcc.env.view";
const remembered = () => { try { return localStorage.getItem(VIEW_KEY) || ""; } catch { return ""; } };
const remember = (v) => { try { localStorage.setItem(VIEW_KEY, v); } catch { /* private window */ } };

/* ───────── the tab ───────── */

export async function environmentTab(ctx, box, S, { databases = [], servers = [] } = {}) {
  const base = `#/sites/${S.id}`;
  const isCopy = !!S.stagingOf;
  const views = isCopy ? COPY_VIEWS : VIEWS;
  const want = ctx.query?.view || (isCopy ? "" : remembered());
  let view = views.some((v) => v.id === want) ? want : "live";
  let cur = S; // kept fresh from `site` events (site.js keeps its own copy)

  mount(box, html`<div class="env-switch"><div class="seg env-seg" role="tablist" aria-label="Which variables">${views.map((v) => html`<button type="button" role="tab" data-envview="${v.id}" aria-selected="${v.id === view ? "true" : "false"}" class="${v.id === view ? "active" : ""} ${isCopy && v.id === "live" ? "stg" : ""}">${icon(v.icon, "sm")}${v.label}</button>`)}</div>
      <p class="muted small env-switch-sub" data-envsub></p></div>
    <div data-envpane></div>`);
  const pane = $("[data-envpane]", box);
  const SUB = isCopy
    ? { live: html`What this staging build runs with — its own copy, separate from <a href="#/sites/${S.stagingOf}/environment" style="color:var(--blue-3)">${S.staging?.parentName || "the live site"}</a>.`, test: "Extra variables and the throw-away database every commit test of the staging build gets." }
    : { live: "What the website runs with in production.", test: "Extra variables and the throw-away database every commit test gets.", staging: "The staging build's own variables. Changing them never touches the live site." };
  let gen = 0; // ignore a slow load when the view was switched meanwhile
  const show = async (v) => {
    view = v; if (!isCopy) remember(v);
    const my = ++gen;
    $$("[data-envview]", box).forEach((b) => { const a = b.dataset.envview === v; b.classList.toggle("active", a); b.setAttribute("aria-selected", a ? "true" : "false"); });
    const sub = $("[data-envsub]", box); if (sub) mount(sub, html`${SUB[v]}`);
    history.replaceState(null, "", `${base}/environment${v === "live" ? "" : `?view=${v}`}`);
    const el = document.createElement("div");
    pane.replaceChildren(el);
    mount(el, skeletonRows(3, 44));
    const alive = () => ctx.alive() && my === gen;
    if (v === "live") await liveView(ctx, el, cur, { databases, alive });
    else if (v === "test") await testView(ctx, el, cur, { alive });
    else await stagingView(ctx, el, cur, { alive, servers });
  };
  on(box, "click", "[data-envview]", (e, b) => { if (b.dataset.envview !== view) show(b.dataset.envview); });
  ctx.on("site", (d) => {
    if (!d || d.deleted || d.id !== S.id) return;
    const had = cur.staging?.role === "parent" ? cur.staging.id : null;
    cur = { ...cur, ...d };
    const has = cur.staging?.role === "parent" ? cur.staging.id : null;
    if (view === "staging" && had !== has) show("staging"); // staging was created or removed meanwhile
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

/* ───────── Staging (on the live site): only the staging build's variables ───────── */

async function stagingView(ctx, el, S, { alive, servers }) {
  const st = S.staging?.role === "parent" ? S.staging : null;
  if (!st) {
    mount(el, html`<div class="card"><div class="card-body stg-none">
      <span class="type-ico ${S.type || "node"} staging">${icon("layers")}</span>
      <p class="muted small" style="margin:0;flex:1;min-width:200px">${S.name} has no staging build yet — a separate copy with its own address, variables and database to try changes on before they go live.</p>
      <button class="btn btn-primary btn-sm" data-stgcreate>${icon("plus")}Create staging build</button></div></div>`);
    on(el, "click", "[data-stgcreate]", () => createStagingDialog(S, { servers }));
    return;
  }
  let envData;
  try { envData = await get(`/api/sites/${st.id}/env`); } catch (e) { if (alive()) mount(el, errorState(e, false)); return; }
  if (!alive()) return;
  mount(el, html`<div class="card"><div class="card-head" style="flex-wrap:wrap"><h3>Staging variables</h3><span class="sub" data-dirty></span>
      <div class="right btn-row"><a class="btn btn-sm btn-ghost" href="#/sites/${st.id}/environment">${icon("layers")}Open staging build</a><button class="btn btn-primary btn-sm" data-stgsave>${icon("check")}Save & apply</button></div></div>
    <div class="card-body"><div data-env></div>
      <div class="note mt-16">${icon("info")}<div>Copied from Live when the staging build was created (live payment keys left out, database settings pointed at the staging database) and edited separately since. Saving restarts the staging app only — the live site is not touched.${st.url ? html` Staging answers at <a class="mono" href="${st.url}" target="_blank" rel="noopener noreferrer" style="color:var(--blue-3)">${st.url.replace(/^https?:\/\//, "")}</a>.` : ""}</div></div></div></div>`);
  const dirty = $("[data-dirty]", el);
  const ed = envEditor($("[data-env]", el), envData.env || {}, { onDirty: () => (dirty.textContent = "Unsaved changes") });
  on(el, "click", "[data-stgsave]", async (e, b) => {
    const err = ed.validate(); if (err) { toast(err, "warn"); return; }
    b.classList.add("loading");
    try {
      const r = await put(`/api/sites/${st.id}/env`, { env: ed.get() }); dirty.textContent = "";
      if (r?.env) ed.set(r.env);
      if ((r?.warnings || []).length) toast("Saved with warnings", "warn", { msg: r.warnings.join(" ") });
      else toast("Staging variables saved", "ok", { msg: r?.job ? "The staging app restarts to apply them." : "They apply on the next staging deploy." });
      if (r?.job?.id) jobStarted(r.job, "Applying staging variables");
    } catch (ex) { toastError(ex, "Couldn't save"); } finally { b.classList.remove("loading"); }
  });
}
