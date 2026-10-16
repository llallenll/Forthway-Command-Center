// Website → CI tab: how this website's updates are checked before they reach production.
import { html, raw, mount, $, on, plural, emptyState, errorState, skeletonRows, toast, toastError, confirmDialog, formDialog } from "../util.js";
import { icon } from "../icons.js";
import { get, put, post, download } from "../api.js";
import { envEditor } from "../components.js";
import { SEVERITIES, SEV_LABEL, SEV_HINT, sevTag, runRow, ciStarted, ciStatusBadge } from "../ci-ui.js";

const MODES = [
  ["required", "Required", "A release deploys only after CI passes it. Admins can still bypass or override — it is recorded."],
  ["advisory", "Advisory", "CI runs and reports, but never stops a deploy."],
  ["off", "Off", "No CI for this website."],
];

const CAPS = (c, type) => [
  ["Build script", c.build, c.build ? "npm run build — proves it compiles" : 'No "build" script'],
  ...(type === "node" ? [["Start script", c.start, c.start ? "Used to smoke test the affected routes" : 'No "start" script — routes cannot be smoke tested']] : []),
  ["TypeScript", c.typescript, c.typescript ? (c.typecheckScript ? `npm run ${c.typecheckScript}` : "tsc --noEmit") : "Not used"],
  ["ESLint", c.lint, c.lint ? "Lints every affected file" : "Not set up"],
  ["Test runner", !!c.testRunner, c.testRunner ? `${c.testRunner}${c.testRunner !== "script" ? ` · ${plural(c.testFiles, "test file")}` : " (npm test, not split)"}` : "None — CI uses its built-in checks"],
  ...(type === "node" ? [["Health route", c.healthRoute, c.healthRoute ? "/api/health" : "Waits for / instead"]] : []),
  ["fcc-ci.json", !!c.fccCi && !c.fccCi.error, c.fccCi?.error || (c.fccCi ? `${plural(c.fccCi.suites || 0, "suite")} from the repository` : "Optional — suites and samples in the repo")],
];

function suiteDialog(suite) {
  const s = suite || { name: "", severity: "extreme", always: false, paths: [], command: "", probes: [] };
  return formDialog({
    title: suite ? `Edit ${suite.name}` : "Add a critical suite", ico: "shield", size: "lg", submitText: suite ? "Save suite" : "Add suite",
    intro: html`<p class="muted small span-2" style="margin:0 0 4px">A suite guards something that must never break — payments, sign-in, checkout. It runs on every update, or only when an update touches its paths, and a failure carries the severity you give it.</p>`,
    fields: [
      { name: "name", label: "Name", value: s.name, placeholder: "Payments", required: true },
      { name: "severity", label: "Severity when it fails", type: "select", value: s.severity, options: SEVERITIES.map((x) => ({ value: x, label: `${SEV_LABEL[x]} — ${SEV_HINT[x]}` })) },
      { name: "always", label: "Run on every update", type: "switch", value: s.always, hint: "Off: only when the update touches one of the paths below (or anything that imports them).", span: true },
      { name: "paths", label: "Paths it owns", type: "textarea", mono: true, value: (s.paths || []).join("\n"), placeholder: "lib/payments/**\napp/api/checkout/**\napp/api/webhooks/stripe/route.ts", hint: "One per line. ** = any folders, * = any name.", span: true },
      { name: "command", label: "Command (optional)", mono: true, value: s.command || "", placeholder: "npm run test:payments", hint: "Runs in the checkout after installing dependencies. Exit code 0 = pass. Use the CI variables below for test keys.", span: true },
      { name: "probes", label: "HTTP checks (optional)", type: "textarea", mono: true, value: (s.probes || []).map((p) => `${p.method} ${p.path}${p.expect ? ` ${p.expect}` : ""}${p.contains ? ` contains:${p.contains}` : ""}`).join("\n"), placeholder: "GET /api/health 200\nPOST /api/checkout 400\nGET /pricing 200 contains:Checkout", hint: "Against the freshly built app on a throwaway port. METHOD /path [status] [contains:text].", span: true },
    ],
    onSubmit: (v) => ({
      ...(suite?.id ? { id: suite.id } : {}),
      name: v.name, severity: v.severity, always: !!v.always,
      paths: v.paths.split("\n").map((x) => x.trim()).filter(Boolean),
      command: v.command, probes: v.probes.split("\n").map((x) => x.trim()).filter(Boolean),
    }),
  });
}

export async function ciTab(ctx, box, S) {
  mount(box, skeletonRows(5, 60));
  let D;
  const load = async () => (D = await get(`/api/sites/${S.id}/ci`));
  try { await load(); } catch (e) { mount(box, errorState(e)); return; }
  if (!ctx.alive()) return;
  let st = structuredClone(D.settings);
  let envEd = null;

  const save = async (patchBody, msg = "CI settings saved") => {
    try {
      const next = await put(`/api/sites/${S.id}/ci`, patchBody);
      D.settings = next; st = structuredClone(next);
      toast(msg, "ok");
      return true;
    } catch (e) { toastError(e, "Couldn't save"); return false; }
  };

  const paint = () => {
    const r = D.readiness || {};
    const c = r.caps;
    const runners = D.runners || [];
    const online = runners.filter((x) => x.available);
    mount(box, html`<div class="grid-main ci-site">
      <div class="stack">
        <div class="card"><div class="card-head"><div><h3>Continuous Integration</h3><div class="sub">Every update is checked on your CI servers before it can go live.</div></div>
          <div class="right"><button class="btn btn-primary" data-runnow ${st.mode === "off" ? raw("disabled") : ""}>${icon("shield")}Run CI now</button></div></div>
          <div class="card-body form-stack">
            <div class="ci-modes">${MODES.map(([k, l, d]) => html`<button type="button" class="ci-mode ${st.mode === k ? "active" : ""}" data-mode="${k}"><span class="ci-mode-t">${l}</span><span class="ci-mode-d">${d}</span></button>`)}</div>
            <div class="grid-2" ${st.mode === "off" ? raw('style="opacity:.5;pointer-events:none"') : ""}>
              <div class="field"><label>Block deploys from</label><select class="select" data-blockon>${SEVERITIES.slice().reverse().map((x) => html`<option value="${x}" ${st.blockOn === x ? raw("selected") : ""}>${SEV_LABEL[x]} and worse</option>`)}</select><div class="hint">${SEV_HINT[st.blockOn]}. Extreme findings always need the website's name typed to override.</div></div>
              <div class="field"><label>Time limit per checkout (minutes)</label><input class="input" type="number" min="5" max="120" value="${st.timeoutMin}" data-timeout/><div class="hint">Up to ${st.maxCheckouts} checkouts run in parallel across ${plural(online.length, "CI server")}.</div></div>
            </div>
            <div class="stack" style="gap:12px">
              <label class="switch"><input type="checkbox" data-sw="autoRun" ${st.autoRun ? raw("checked") : ""}/><span class="track"></span>Start CI on every new release (GitHub pull or upload)</label>
              ${S.github?.repo ? html`<label class="switch"><input type="checkbox" data-sw="autoPull" ${st.autoPull ? raw("checked") : ""}/><span class="track"></span>Test new commits on <span class="mono">${S.github.branch || "the default branch"}</span> as soon as they land (never deploys)</label>` : ""}
              <label class="switch"><input type="checkbox" data-sw="inheritEnv" ${st.inheritEnv ? raw("checked") : ""}/><span class="track"></span>Give checkouts the website's environment variables</label>
              ${st.inheritEnv ? html`<div class="note warn small">${icon("alert")}<div>Checkouts then see live secrets (database URL, payment keys). Put test keys under <b>CI variables</b> below — they override the website's values inside checkouts.</div></div>` : ""}
            </div>
            <div class="row" style="justify-content:flex-end"><button class="btn btn-primary" data-savemain>${icon("check")}Save</button></div>
          </div></div>

        <div class="card"><div class="card-head"><div><h3>Critical suites</h3><div class="sub">What must never break. A failing extreme suite blocks the deploy outright.</div></div><div class="right"><button class="btn btn-sm" data-addsuite>${icon("plus")}Add suite</button></div></div>
          <div class="list">${st.suites.length ? st.suites.map((s, i) => html`<div class="list-item">
              <span class="li-ico">${icon("shield", "sm")}</span>
              <div class="li-main"><div class="li-title">${s.name} ${sevTag(s.severity)}</div>
                <div class="li-sub">${s.always ? "Every update" : html`When an update touches <span class="mono">${(s.paths || []).slice(0, 3).join(", ")}${(s.paths || []).length > 3 ? "…" : ""}</span>`}${s.command ? html` · <span class="mono">${s.command}</span>` : ""}${s.probes?.length ? ` · ${plural(s.probes.length, "HTTP check")}` : ""}</div></div>
              <div class="li-right"><button class="icon-btn sm" data-editsuite="${i}" title="Edit">${icon("edit", "sm")}</button><button class="icon-btn sm" data-delsuite="${i}" title="Remove">${icon("trash", "sm")}</button></div></div>`)
            : html`<div class="card-body">${emptyState({ ico: "shield", title: "No critical suites", text: "Add one for payments, sign-in or checkout: a command, HTTP checks against the built app, or both.", sm: true, action: html`<button class="btn btn-sm btn-primary" data-addsuite>${icon("plus")}Add a suite</button>` })}</div>`}
          ${(r.repoSuites || []).map((s) => html`<div class="list-item"><span class="li-ico">${icon("github", "sm")}</span><div class="li-main"><div class="li-title">${s.name} ${sevTag(s.severity)} <span class="badge">fcc-ci.json</span></div><div class="li-sub">${s.always ? "Every update" : `Paths: ${s.paths.join(", ")}`}${s.command ? ` · ${s.command}` : ""}</div></div></div>`)}
          </div></div>

        <div class="grid-2">
          <div class="card"><div class="card-head"><div><h3>Sample paths</h3><div class="sub">Dynamic routes need a real URL to smoke test.</div></div></div><div class="card-body form-stack">
            <textarea class="textarea mono" rows="5" data-samples placeholder="/blog/[slug] /blog/hello-world&#10;/shop/[id] /shop/1">${Object.entries(st.samples || {}).map(([k, v]) => `${k} ${[].concat(v).join(" ")}`).join("\n")}</textarea>
            <div class="hint" style="margin:0">One per line: the route, then up to three paths to request.</div>
            <div class="field"><label>Ignore changes to</label><textarea class="textarea mono" rows="3" data-ignore placeholder="**/*.md&#10;docs/**">${(st.ignore || []).join("\n")}</textarea></div>
            <div class="row" style="justify-content:flex-end"><button class="btn btn-sm btn-primary" data-savesamples>${icon("check")}Save</button></div></div></div>
          <div class="card"><div class="card-head"><div><h3>CI variables</h3><div class="sub">Only inside checkouts — test keys, a test database.</div></div></div><div class="card-body"><div data-env></div>
            <div class="row mt-12" style="justify-content:flex-end"><button class="btn btn-sm btn-primary" data-saveenv>${icon("check")}Save variables</button></div></div></div>
        </div>
      </div>

      <div class="stack">
        <div class="card"><div class="card-head"><div><h3>Readiness</h3><div class="sub">${r.version ? `From the latest release, v${r.version}` : "From the latest release"}</div></div>
          <div class="right"><button class="btn btn-sm btn-ghost" data-starter title="A starter fcc-ci.json for the repository">${icon("download")}fcc-ci.json</button></div></div>
          ${c ? html`<ul class="ci-ready">${CAPS(c, S.type).map(([l, ok, d]) => html`<li class="${ok ? "ok" : ""}"><span class="ci-ready-ico">${icon(ok ? "check" : "dot", "xs")}</span><div><div class="strong">${l}</div><div class="muted tiny">${d}</div></div></li>`)}</ul>` : ""}
          <div class="card-body" style="padding-top:${c ? "4px" : "18px"}">
            <div class="ci-builtin"><div class="strong small">Always on, whatever the codebase has</div><div class="muted tiny">Impact analysis · static scan of changed lines (typos, secrets, conflict markers, console.log) · install & build · smoke test of every affected route · your critical suites</div></div>
            ${(r.tips || []).map((t) => html`<div class="note ${t.level === "warn" ? "warn" : ""} small mt-8">${icon(t.level === "warn" ? "alert" : "info")}<div>${t.text}</div></div>`)}
          </div></div>

        <div class="card"><div class="card-head"><div><h3>CI servers</h3><div class="sub"><a href="#/ci">Live view →</a></div></div></div>
          <div class="list">${runners.map((x) => html`<div class="list-item"><span class="dot ${x.available ? "ok" : "off"}"></span><div class="li-main"><div class="li-title">${x.name}</div><div class="li-sub">${x.role === "main" ? "Main server" : "Agent server"}${x.why ? ` · ${x.why}` : ""}</div></div></div>`)}
          ${!runners.length ? html`<div class="card-body muted small">No servers can run checkouts.</div>` : ""}</div></div>

        <div class="card"><div class="card-head"><div><h3>Runs</h3>${D.live ? html`<div class="sub">Live release: ${ciStatusBadge(D.live.status, { short: true })}</div>` : ""}</div></div>
          <div class="list" data-runs>${D.runs.length ? D.runs.map((x) => runRow(x, { showSite: false })) : html`<div class="card-body">${emptyState({ ico: "shield", title: "No runs yet", text: "Pull or upload a release, or press Run CI now.", sm: true })}</div>`}</div></div>
      </div></div>`);
    envEd = envEditor($("[data-env]", box), st.env || {});
  };
  paint();

  on(box, "click", "[data-mode]", async (e, b) => { const prev = st.mode; st.mode = b.dataset.mode; if (await save({ mode: st.mode }, `CI is ${st.mode === "off" ? "off" : st.mode} for ${S.name}`)) paint(); else st.mode = prev; });
  on(box, "click", "[data-savemain]", async () => {
    const body = { blockOn: $("[data-blockon]", box).value, timeoutMin: Number($("[data-timeout]", box).value) };
    box.querySelectorAll("[data-sw]").forEach((x) => (body[x.dataset.sw] = x.checked));
    if (await save(body)) paint();
  });
  on(box, "change", "[data-sw=inheritEnv]", (e, el) => { st.inheritEnv = el.checked; });
  on(box, "click", "[data-addsuite]", async () => { const s = await suiteDialog(null); if (s && (await save({ suites: [...st.suites, s] }, `Suite "${s.name}" added`))) paint(); });
  on(box, "click", "[data-editsuite]", async (e, b) => { const i = Number(b.dataset.editsuite); const s = await suiteDialog(st.suites[i]); if (!s) return; const list = st.suites.slice(); list[i] = s; if (await save({ suites: list }, "Suite saved")) paint(); });
  on(box, "click", "[data-delsuite]", async (e, b) => {
    const s = st.suites[Number(b.dataset.delsuite)];
    if (!(await confirmDialog({ title: `Remove ${s.name}?`, message: "Updates are no longer checked against it.", danger: true, confirmText: "Remove suite" }))) return;
    if (await save({ suites: st.suites.filter((x) => x !== s) }, "Suite removed")) paint();
  });
  on(box, "click", "[data-savesamples]", async () => {
    const samples = {};
    for (const line of $("[data-samples]", box).value.split("\n")) {
      const [route, ...paths] = line.trim().split(/\s+/).filter(Boolean);
      if (route && paths.length) samples[route] = paths.length === 1 ? paths[0] : paths;
    }
    if (await save({ samples, ignore: $("[data-ignore]", box).value })) paint();
  });
  on(box, "click", "[data-saveenv]", async () => {
    const bad = envEd.validate();
    if (bad) return toast(bad, "warn");
    if (await save({ env: envEd.get() }, "CI variables saved")) paint();
  });
  on(box, "click", "[data-starter]", () => download(`/api/sites/${S.id}/ci/starter`));
  on(box, "click", "[data-runnow]", async (e, b) => {
    b.classList.add("loading");
    try { const r = await post("/api/ci/runs", { siteId: S.id }); ciStarted(r); location.hash = `#/ci/${r.id}`; } catch (ex) { toastError(ex, "Couldn't start CI"); } finally { b.classList.remove("loading"); }
  });
  ctx.on("ci", async (d) => {
    if (d?.siteId !== S.id) return;
    try { const fresh = await get(`/api/sites/${S.id}/ci`); D.runs = fresh.runs; D.live = fresh.live; const el = $("[data-runs]", box); if (el) mount(el, html`${D.runs.map((x) => runRow(x, { showSite: false }))}`); } catch {}
  });
}
