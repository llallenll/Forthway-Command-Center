// CI — the checkout fleet (which servers are running which checkouts, live), runs, and CI server settings.
import { html, raw, mount, $, on, fmtDuration, fmtBytes, plural, emptyState, errorState, skeletonRows, toast, toastError, openModal, debounce } from "../util.js";
import { icon } from "../icons.js";
import { get, put } from "../api.js";
import { pageHead } from "../components.js";
import { runRow, ciStatusBadge } from "../ci-ui.js";

const KIND_ICON = { build: "layers", verify: "code", tests: "check", php: "php" };

/** One checkout in a server slot: what it is, which step it is on, a segment per step. */
export function slotCard(c) {
  const pct = c.total ? Math.round((100 * c.done) / c.total) : 0;
  const el = c.startedAt ? fmtDuration(Date.now() - new Date(c.startedAt)) : "";
  return html`<a class="ci-slot busy kind-${c.kind}" href="#/ci/${c.runId}" title="${c.siteName} — ${c.name}">
    <div class="ci-slot-top"><span class="ci-slot-ico">${icon(KIND_ICON[c.kind] || "zap", "xs")}</span><span class="ci-slot-site ellipsis">${c.siteName}</span><span class="ci-slot-t num" data-since="${c.startedAt || ""}">${el}</span></div>
    <div class="ci-slot-name ellipsis">${c.name}${c.version ? html` <span class="dim mono">v${c.version}</span>` : ""}</div>
    <div class="ci-slot-step ellipsis"><span class="dot run" style="width:6px;height:6px"></span>${c.current || "Starting…"}</div>
    <div class="ci-segs" style="--n:${c.total || 1}" aria-label="${c.done} of ${c.total} steps">${Array.from({ length: c.total || 1 }, (_, i) => html`<i class="${i < c.done ? "done" : i === c.done ? "now" : ""}"></i>`)}</div>
    <div class="ci-slot-foot"><span>${c.done}/${c.total} steps · ${pct}%</span>${c.findings ? html`<span class="sev-text-high">${plural(c.findings, "finding")}</span>` : ""}</div>
  </a>`;
}

function lane(r) {
  const m = r.metrics || {};
  const memPct = m.memTotal ? Math.round((100 * (m.mem || 0)) / m.memTotal) : null;
  const slots = Array.from({ length: Math.max(r.slots, r.active.length) }, (_, i) => r.active[i] || null);
  const tone = !r.online ? "err" : r.active.length ? "run" : r.available ? "ok" : "off";
  return html`<div class="ci-lane ${r.active.length ? "is-busy" : ""} ${r.available ? "" : "is-idle-off"}">
    <div class="ci-lane-head">
      <span class="dot ${tone}"></span>
      <div style="min-width:0;flex:1"><div class="ci-lane-name ellipsis">${r.name}</div>
        <div class="ci-lane-sub">${r.role === "main" ? "Main server" : "Agent server"}${r.info?.cpus ? ` · ${r.info.cpus} vCPU` : ""}${r.info?.memTotal ? ` · ${fmtBytes(r.info.memTotal, 0)}` : ""}</div></div>
      ${r.role === "main" && r.fallback ? html`<span class="badge" title="${r.why}">Fallback</span>` : !r.online ? html`<span class="badge err">Offline</span>` : ""}
    </div>
    <div class="ci-lane-load">
      <div class="ci-meter"><span>CPU</span><div class="ci-meter-t"><i style="width:${Math.min(100, Math.round(m.cpu || 0))}%"></i></div><b class="num">${m.cpu != null ? `${Math.round(m.cpu)}%` : "—"}</b></div>
      <div class="ci-meter"><span>RAM</span><div class="ci-meter-t"><i style="width:${memPct ?? 0}%"></i></div><b class="num">${memPct != null ? `${memPct}%` : "—"}</b></div>
    </div>
    <div class="ci-slots">${slots.map((c) => (c ? slotCard(c) : html`<div class="ci-slot idle">${r.available ? html`${icon("check", "xs")}Free slot` : html`<span class="dim">${r.why || "Not used"}</span>`}</div>`))}</div>
  </div>`;
}

export function fleet(o, { compact = false } = {}) {
  const busy = o.runners.some((r) => r.active.length) || o.queue.length || o.active.some((r) => r.status === "planning");
  const planning = o.active.filter((r) => r.status === "planning");
  return html`<div class="ci-fleet ${busy ? "is-live" : ""} ${compact ? "compact" : ""}">
    <div class="ci-hub">
      <div class="ci-hub-card">
        <div class="ci-hub-ico">${icon("shield")}</div>
        <div class="strong">Panel</div>
        <div class="muted tiny">Plans each update: diff, import graph, static scan</div>
        <div class="ci-hub-stats">
          <div><b class="num">${planning.length}</b><span>planning</span></div>
          <div><b class="num">${o.queue.length}</b><span>queued</span></div>
          <div><b class="num">${o.stats.activeCheckouts}</b><span>running</span></div>
        </div>
        ${o.queue.length ? html`<div class="ci-queue">${o.queue.slice(0, 6).map((q) => html`<a class="ci-q" href="#/ci/${q.runId}">${icon("clock", "xs")}<span class="ellipsis">${q.siteName} · ${q.name}</span></a>`)}${o.queue.length > 6 ? html`<span class="muted tiny">+${o.queue.length - 6} more</span>` : ""}</div>` : ""}
      </div>
      <div class="ci-wire" aria-hidden="true"><i></i><i></i><i></i></div>
    </div>
    <div class="ci-lanes">${o.runners.length ? o.runners.map(lane) : html`<div class="card">${emptyState({ ico: "server", title: "No CI servers", text: "Add an agent server under Servers — checkouts run there, never on a live website's folder.", sm: true })}</div>`}</div>
  </div>`;
}

async function settingsDialog(onSaved) {
  let s;
  try { s = await get("/api/ci/settings"); } catch (e) { toastError(e); return; }
  const listed = (id) => s.runners === "auto" || s.runners.includes(id);
  const agents = s.servers.filter((x) => x.role !== "main");
  const m = openModal({
    title: "CI servers", sub: "Where checkouts run. Agent servers do the work; each checkout gets a folder of its own that is deleted afterwards.", ico: "server", size: "lg",
    body: html`<div class="form-stack">
      <div class="field"><label>Agent servers that run checkouts</label>
        <div class="seg" data-mode><button type="button" class="${s.runners === "auto" ? "active" : ""}" data-m="auto">Every agent server</button><button type="button" class="${s.runners !== "auto" ? "active" : ""}" data-m="pick">Only these</button></div>
        <div class="ci-pick mt-12" data-pick ${s.runners === "auto" ? raw("hidden") : ""}>${agents.length ? agents.map((x) => html`<label class="check"><input type="checkbox" value="${x.id}" ${listed(x.id) ? raw("checked") : ""}/>${x.name} ${x.online ? "" : html`<span class="badge err">offline</span>`}</label>`) : html`<span class="muted small">No agent servers yet.</span>`}</div></div>
      <div class="field"><label>The main server</label>
        <select class="select" data-main>
          <option value="fallback" ${s.useMain === "fallback" ? raw("selected") : ""}>Only when no agent server is online (recommended)</option>
          <option value="always" ${s.useMain === "always" ? raw("selected") : ""}>Always, alongside the agent servers</option>
          <option value="never" ${s.useMain === "never" ? raw("selected") : ""}>Never — wait for an agent server</option>
        </select><div class="hint">Main also serves your websites, the panel and MySQL; a build there competes with them for CPU.</div></div>
      <div class="field"><label>Checkouts at once per server</label><input class="input" type="number" min="1" max="6" value="${s.perServer}" data-per style="max-width:120px"/><div class="hint">Each checkout installs dependencies and may build; 2 suits a 4 GB server.</div></div>
      <div class="error-box" data-err hidden></div></div>`,
    foot: html`<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-save>Save</button>`,
    onMount(el, close) {
      let mode = s.runners === "auto" ? "auto" : "pick";
      on(el, "click", "[data-m]", (e, b) => { mode = b.dataset.m; el.querySelectorAll("[data-m]").forEach((x) => x.classList.toggle("active", x === b)); $("[data-pick]", el).hidden = mode === "auto"; });
      $("[data-save]", el).onclick = async () => {
        const b = $("[data-save]", el);
        b.classList.add("loading");
        try {
          const runners = mode === "auto" ? "auto" : [...el.querySelectorAll("[data-pick] input:checked")].map((x) => x.value);
          await put("/api/ci/settings", { runners, useMain: $("[data-main]", el).value, perServer: Number($("[data-per]", el).value) });
          toast("CI servers saved", "ok"); close(true); onSaved?.();
        } catch (ex) { const err = $("[data-err]", el); err.hidden = false; err.textContent = ex.message; } finally { b.classList.remove("loading"); }
      };
    },
  });
  return m.result;
}

export default async function ci(ctx) {
  const { root } = ctx;
  ctx.crumbs([{ label: "CI" }]);
  mount(root, html`${pageHead("Continuous Integration", "Every update is planned on the panel, checked out on your agent servers in parallel, and reported back before it can reach production.", html`<button class="btn" data-settings>${icon("settings")}CI servers</button><a class="btn btn-primary" href="#/sites">${icon("globe")}Websites</a>`)}
    <div data-stats class="mini-stats">${[1, 2, 3, 4].map(() => html`<div class="skel" style="height:78px;border-radius:16px"></div>`)}</div>
    <div class="card ci-fleet-card"><div class="card-head"><div><h3>Checkouts</h3><div class="sub">Where each slice of a CI run is happening right now. A checkout's files are deleted from its server as soon as it finishes.</div></div><div class="right" data-live></div></div><div class="card-body" data-fleet>${skeletonRows(2, 120)}</div></div>
    <div class="card mt-24"><div class="card-head"><div><h3>Runs</h3><div class="sub">Newest first. Click one for its report.</div></div><div class="right"><div class="pills" data-f></div></div></div><div class="list" data-runs>${skeletonRows(4, 56)}</div></div>`);
  let o = null, filter = ctx.query.filter || "all";
  const paint = () => {
    if (!o) return;
    const s = o.stats;
    mount($("[data-stats]", root), html`
      <div class="mini-stat"><div class="ms-l">${icon("server", "xs")}CI servers online</div><div class="ms-v">${s.runnersOnline}</div><div class="ms-s">${o.settings.perServer} checkout${o.settings.perServer === 1 ? "" : "s"} at once each</div></div>
      <div class="mini-stat"><div class="ms-l">${icon("zap", "xs")}Running now</div><div class="ms-v">${s.activeCheckouts}${s.queued ? html` <span class="muted small">+${s.queued} queued</span>` : ""}</div><div class="ms-s">${plural(o.active.length, "run")} in progress</div></div>
      <div class="mini-stat"><div class="ms-l">${icon("check", "xs")}Pass rate · 7 days</div><div class="ms-v">${s.passRate7d == null ? "—" : `${s.passRate7d}%`}</div><div class="ms-s">${plural(s.week, "finished run")}</div></div>
      <div class="mini-stat"><div class="ms-l">${icon("activity", "xs")}Runs · 24 h</div><div class="ms-v">${s.runs24h}</div><div class="ms-s">${s.blockedDeploys ? `${plural(s.blockedDeploys, "override")} recorded` : "No overrides"}</div></div>`);
    mount($("[data-live]", root), o.stats.activeCheckouts || o.queue.length ? html`<span class="badge blue"><span class="dot run" style="width:6px;height:6px"></span>Live</span>` : html`<span class="badge">Idle</span>`);
    mount($("[data-fleet]", root), fleet(o));
    const runs = o.recent;
    const counts = { all: runs.length, active: runs.filter((r) => ["planning", "queued", "running"].includes(r.status)).length, blocked: runs.filter((r) => ["failed", "error"].includes(r.status)).length, passed: runs.filter((r) => ["passed", "warning"].includes(r.status)).length };
    mount($("[data-f]", root), html`${[["all", "All"], ["active", "Running"], ["blocked", "Blocked"], ["passed", "Passed"]].map(([k, l]) => html`<button class="pill ${filter === k ? "active" : ""}" data-fk="${k}">${l}<span class="n">${counts[k]}</span></button>`)}`);
    const pick = (r) => filter === "all" || (filter === "active" ? ["planning", "queued", "running"].includes(r.status) : filter === "blocked" ? ["failed", "error"].includes(r.status) : ["passed", "warning"].includes(r.status));
    const list = runs.filter(pick);
    mount($("[data-runs]", root), list.length ? html`${list.map((r) => runRow(r))}` : emptyState({ ico: "shield", title: runs.length ? "Nothing here" : "No CI runs yet", text: runs.length ? "Try another filter." : "Pull an update or upload a release on a website: CI starts by itself, or press Update to test and deploy.", sm: true }));
  };
  const load = async () => {
    try { o = await get("/api/ci/overview"); if (ctx.alive()) paint(); }
    catch (e) { if (ctx.alive()) mount($("[data-fleet]", root), errorState(e)); }
  };
  await load();
  on(root, "click", "[data-fk]", (e, b) => { filter = b.dataset.fk; paint(); });
  on(root, "click", "[data-settings]", () => settingsDialog(load));
  ctx.on(["ci", "server"], debounce(load, 350));
  // Elapsed clocks tick without refetching; a slow poll covers progress between events.
  const tick = setInterval(() => root.querySelectorAll("[data-since]").forEach((x) => { if (x.dataset.since) x.textContent = fmtDuration(Date.now() - new Date(x.dataset.since)); }), 1000);
  const poll = setInterval(() => { if (o && (o.stats.activeCheckouts || o.queue.length || o.active.length)) load(); }, 5000);
  ctx.cleanup(() => (clearInterval(tick), clearInterval(poll)));
}

export { ciStatusBadge };
