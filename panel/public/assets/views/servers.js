import { html, raw, mount, frag, $, $$, on, ago, plural, emptyState, errorState, skeletonRows, debounce, sleep, toast, toastError, confirmDialog, openModal, openMenu, secretBox } from "../util.js";
import { icon } from "../icons.js";
import { get, post, patch, del, MOCK } from "../api.js";
import { sparkline } from "../charts.js";
import { pageHead, serverKind, jobStarted, openJobLog, METHOD_LABEL, ubar } from "../components.js";
import { serverBackupDialog } from "./backups.js";
import { getReplication, replSummary, replicaBroken, syncBar, syncActive, fmtLagS } from "./databases.js";
import { foldCard, moreList } from "../fold.js"; // the front-door card folds away; long site lists show "Show all"

function installBlock(cmd, warning) {
  return html`${warning ? html`<div class="note warn" style="margin-bottom:14px">${icon("alert")}<div>${warning} <a href="#/settings/general" style="color:var(--blue-3)">Set the panel URL →</a></div></div>` : ""}<ol class="small" style="margin:0 0 14px;padding-left:18px;color:var(--text-2);line-height:1.8">
      <li>SSH into the new server as root (Ubuntu 22.04/24.04 or Debian 12).</li>
      <li>Paste this one line. It installs Node if needed and starts the agent as a systemd service.</li>
      <li>The agent dials out to this panel — no inbound ports needed besides the site ports.</li></ol>
    ${secretBox(cmd, { big: true })}
    <p class="hint mt-12">${icon("lock", "xs")} The command contains this server's secret token and is shown once. Rotate the token if it leaks.</p>`;
}

/* ───────── edge nodes (docs/HA.md) ───────── */

export const EDGE_HELP = "Runs the website front door and a Cloudflare Tunnel replica, so websites stay up if the main server goes down.";
const isEdge = (s) => s?.role === "main" || !!s?.edge?.enabled;

/** Sync state of an edge agent: { tone, text }. Main is always an edge and syncs in-process. */
export function edgeState(s) {
  if (!s || s.role === "main") return { tone: "ok", text: "Always an edge" };
  const es = s.edgeStatus;
  if (es?.error) return { tone: "err", text: "Error" };
  if (es?.inSync) return { tone: "ok", text: "In sync" };
  if (es?.applying) return { tone: "run", text: "Applying" };
  return { tone: "off", text: "Out of date" };
}
const shortHash = (h) => (h ? String(h).slice(0, 8) : "");

function edgeBody(s) {
  const es = s.edgeStatus, st = edgeState(s);
  const conns = es?.connectors || [], shims = es?.shims || [];
  return html`<p class="muted" style="font-size:13.5px;line-height:1.55;margin:0 0 16px">${EDGE_HELP} It keeps serving with the last configuration it received while main is away.</p>
    ${es?.error ? html`<div class="error-box" style="margin-bottom:14px">${icon("alert")}<div class="mono small">${es.error}</div></div>` : ""}
    <dl class="kv">
      <dt>State</dt><dd><span class="status"><span class="dot ${st.tone}"></span>${st.text}</span>${!s.online ? html` <span class="muted small">· ${s.name} is offline</span>` : ""}</dd>
      <dt>Last applied</dt><dd>${es?.appliedAt ? ago(es.appliedAt) : html`<span class="muted">Never</span>`}${es?.appliedHash ? html` <span class="muted small mono">${shortHash(es.appliedHash)}</span>` : ""}${es && !es.inSync && es.hash ? html` <span class="muted small">· latest <span class="mono">${shortHash(es.hash)}</span></span>` : ""}</dd>
      <dt>nginx</dt><dd>${!es ? html`<span class="muted">No report yet</span>` : es.nginx ? html`<span class="status"><span class="dot ok"></span>Config OK</span>` : html`<span class="status"><span class="dot err"></span>Not applied</span>`}</dd>
      ${es?.reportedAt ? html`<dt>Reported</dt><dd>${ago(es.reportedAt)}</dd>` : ""}
    </dl>
    <div class="label mt-20" style="margin-bottom:8px">Tunnel replicas</div>
    ${conns.length ? html`<div class="edge-rows">${conns.map((c) => html`<div class="edge-row"><span class="dot ${c.active && c.readyConnections > 0 ? "ok" : c.active ? "warn" : "err"}"></span>
        <span class="edge-row-name">${c.name || c.id}</span><span class="muted small">${!c.active ? "Not running" : c.readyConnections > 0 ? plural(c.readyConnections, "connection") : "Starting…"}</span></div>`)}</div>`
      : html`<p class="muted small" style="margin:0">${es ? "No connectors. Add a Cloudflare Tunnel connector on the Cloudflare page and it is copied here." : "Shown after the first sync."}</p>`}
    ${shims.length ? html`<div class="label mt-20" style="margin-bottom:8px">Port shims to main</div>
      <div class="edge-rows">${shims.map((x) => html`<div class="edge-row"><span class="dot ${x.ok ? "ok" : "err"}"></span>
        <span class="edge-row-name">${x.name} <span class="muted mono small">127.0.0.1:${x.listenPort}</span></span><span class="muted small ${x.ok ? "" : "cf-err"}">${x.ok ? "OK" : x.error || "Not answering"}</span></div>`)}</div>` : ""}
    <div class="note mt-20">${icon("shield")}<div class="small">Edges must reach each server's site ports (3000–3999) and main's panel port. The panel opens these in ufw automatically where ufw is active; open them yourself in any other firewall or cloud security group.</div></div>`;
}

/** Edge details for one server, with Sync now. Updates live from `server` events. */
async function edgeDialog(s0) {
  let s = s0;
  const m = openModal({
    title: `${s.name} · Edge node`, ico: "shield", size: "lg",
    body: edgeBody(s),
    foot: html`<button class="btn btn-ghost" data-close>Close</button><button class="btn btn-primary" data-esync ${s.online ? "" : raw("disabled")}>${icon("refresh")}Sync now</button>`,
    onMount(el) {
      $("[data-esync]", el).onclick = async (e) => {
        const b = e.currentTarget; b.classList.add("loading");
        try { const job = await post(`/api/servers/${s.id}/edge/sync`); if (job?.id) openJobLog(job.id); else toast("Sync sent", "ok"); }
        catch (ex) { toastError(ex, "Couldn't sync"); }
        finally { b.classList.remove("loading"); }
      };
    },
  });
  const { onEvent } = await import("../events.js");
  const off = onEvent("server", (d) => {
    if (d?.id !== s.id || d.deleted) return;
    s = { ...s, ...d };
    mount($(".modal-body", m.el), edgeBody(s));
    const b = $("[data-esync]", m.el); if (b) b.disabled = !s.online;
  });
  await m.result; off();
}

/* ───────── panel failover (docs/HA.md, Phase 2) ───────── */

export const PANEL_HELP = "Runs a standby copy of the panel, so another server takes over if the active panel's server goes down.";
const PANEL_MIN_AGENT = "3.2.0";
const verLt = (a, b) => {
  const pa = String(a || "0").split(/[.-]/).map((x) => parseInt(x, 10) || 0), pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
};
/** Does this backend know about panel nodes? (/api/ha answered, or servers carry `panel`.) */
const panelSupported = (ha, items) => !!ha || items.some((x) => "panel" in x || "panelRole" in x);
const isPanelNode = (s, ha) => !!s?.panel?.enabled || !!s?.panelRole || (s?.role === "main" && !!ha?.enabled);
const nodeName = (ha, items, id) => (ha?.nodes || []).find((n) => n.serverId === id)?.name || items.find((x) => x.id === id)?.name || id;
const fmtLag = (ms) => (ms == null ? "—" : ms < 1000 ? `${(ms / 1000).toFixed(1)} s` : ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : `${Math.round(ms / 60_000)} min`);

/** Database replication badge: DB primary / DB replica (with its state), only while replication is on or being set up. */
function dbBadge(s, repl) {
  if (!repl || !(repl.enabled || syncActive(repl.progress))) return "";
  if (repl.primary?.serverId === s.id) return html`<span class="badge" title="Holds the main copy of the databases; changes are replicated to ${repl.replica?.name || "the replica"}.">${icon("database")}DB primary</span>`;
  if (repl.replica?.serverId !== s.id) return "";
  const broken = replicaBroken(repl), seeding = syncActive(repl.progress);
  const lag = repl.replica.lagSeconds;
  return html`<span class="badge ${broken ? "err" : seeding ? "blue" : "ok"}" title="Keeps a live copy of the databases from ${repl.primary?.name || "the primary"}${lag != null ? ` · ${lag} s behind` : ""}.">${icon("database")}${broken ? "DB replica · stopped" : seeding ? "DB replica · syncing" : "DB replica"}</span>`;
}

/** Role badge for a panel node: Active panel / Standby. */
function panelBadge(s, ha) {
  if (!isPanelNode(s, ha)) return "";
  const role = s.panelRole || (ha?.leaderId ? (ha.leaderId === s.id ? "leader" : "follower") : s.role === "main" ? "leader" : "follower");
  if (role === "leader") return html`<span class="badge ok" title="This server runs the active panel.">${icon("layers")}Active panel</span>`;
  if (role === "candidate") return html`<span class="badge warn" title="Asking the other servers for votes to become the active panel.">${icon("layers")}Standby · electing</span>`;
  return html`<span class="badge" title="${PANEL_HELP}">${icon("layers")}Standby</span>`;
}

/** Why this server can't be switched on/off as a panel node right now (null = it can). */
export function panelBlock(s, ha, items, { edge } = {}) {
  if (!s || s.role === "main") return "The main server is always a panel node.";
  if (s.panel?.enabled) {
    if (ha?.leaderId === s.id || s.panelRole === "leader") return "This server runs the active panel. Make another panel node active first.";
    return null;
  }
  if (!(edge ?? s.edge?.enabled)) return "Turn on Edge node first. Panel nodes must be edges.";
  if (!s.online) return `${s.name} is offline.`;
  if (s.enabled === false) return `${s.name} is disabled.`;
  if (ha?.canEnable && !ha.canEnable.ok) return ha.canEnable.reason || "Panel nodes can't be added right now.";
  if (!ha?.canEnable) {
    const on = items.filter((x) => x.enabled !== false);
    if (on.length < 3) return "Needs at least 3 servers, so a majority can still vote when one is down.";
    const bad = on.find((x) => x.role !== "main" && (!x.online || verLt(x.agentVersion, PANEL_MIN_AGENT)));
    if (bad) return `${bad.name} must be online and run agent ${PANEL_MIN_AGENT} or newer.`;
  }
  return null;
}

/** Confirm turning a panel node on/off (`toHost`: the edge is removed afterwards too). */
function confirmPanel(s, enabled, { toHost = false } = {}) {
  if (enabled) return confirmDialog({ title: `Make ${s.name} a panel node?`, ico: "layers", confirmText: "Install the panel",
    message: `${PANEL_HELP} ${s.name} downloads the panel code, starts a standby panel and joins the vote. Websites and the active panel keep running.` });
  if (toHost) return confirmDialog({ title: `Make ${s.name} a website host?`, ico: "layers", danger: true, confirmText: "Remove panel and edge",
    message: `${s.name} stops its standby panel first, then its front door and tunnel replica. Its panel data is kept on the server in a renamed folder, because it holds secrets. Websites on it keep running.` });
  return confirmDialog({ title: `Stop running the panel on ${s.name}?`, ico: "layers", danger: true, confirmText: "Remove panel node",
    message: `${s.name} stops its standby panel. Its panel data is kept on the server in a renamed folder, because it holds secrets. Websites on it keep running.` });
}

/** POST /api/servers/:id/panel and open the job log. Resolves the job (or true without one), or null when it couldn't start. */
async function startPanelJob(s, enabled) {
  try {
    const job = await post(`/api/servers/${s.id}/panel`, { enabled });
    if (job?.id) openJobLog(job.id); else toast(enabled ? "Panel node added" : "Panel node removed", "ok");
    return job?.id ? job : true;
  } catch (ex) { toastError(ex, enabled ? "Couldn't add the panel node" : "Couldn't remove the panel node"); return null; }
}

/** Turn a panel node on/off: confirm, POST /api/servers/:id/panel, open the job log. Resolves true when started. */
async function setPanelNode(s, enabled) {
  if (!(await confirmPanel(s, enabled))) return false;
  return !!(await startPanelJob(s, enabled));
}

/** Resolves the finished job (succeeded / failed / cancelled), or null after `timeoutMs`. Live events first, polling as a fallback. */
async function waitForJob(id, timeoutMs = 20 * 60_000) {
  const { onEvent } = await import("../events.js");
  const done = (j) => j && ["succeeded", "failed", "cancelled"].includes(j.status);
  return new Promise((resolve) => {
    let finished = false;
    const finish = (j) => { if (finished) return; finished = true; off(); clearInterval(poll); clearTimeout(limit); resolve(j); };
    const off = onEvent("job", (j) => { if (j?.id === id && done(j)) finish(j); });
    const poll = setInterval(async () => { try { const j = await get(`/api/jobs/${id}`); if (done(j)) finish(j); } catch { /* keep waiting */ } }, 4000);
    const limit = setTimeout(() => finish(null), timeoutMs);
  });
}

/** Panel node → website host: once the panel removal job has finished, turn the edge off (panel nodes must be edges). */
async function edgeOffAfter(job, s) {
  if (job?.id) {
    const j = await waitForJob(job.id);
    if (j?.status !== "succeeded") { toast(`${s.name} is still an edge node`, "warn", { msg: "The panel wasn't removed, so the edge was left on. Try again once the panel removal works." }); return; }
  }
  try { await patch(`/api/servers/${s.id}`, { edge: false }); toast(`${s.name} is now a website host`, "ok"); }
  catch (ex) { toastError(ex, `Couldn't turn off the edge on ${s.name}`); }
}

/** Planned switchover: confirm, POST /api/ha/handover, then wait (through 503s and dropped connections) until the leader changes. */
async function makeActive(node, ha, ctx) {
  const ok = await confirmDialog({ title: `Make ${node.name} the active panel?`, ico: "layers", confirmText: "Make active panel",
    message: "The panel is unavailable for about 20 seconds while it switches. Websites keep running, and this page reloads when it's done." });
  if (!ok) return;
  const from = ha.leaderId;
  const box = document.createElement("div");
  box.className = "restart-banner"; box.setAttribute("role", "status");
  document.body.appendChild(box);
  const say = (title, msg, err = false) => { box.classList.toggle("err", err); mount(box, html`<span class="rb-spin" aria-hidden="true"></span><div><div class="strong">${title}</div><div class="muted small">${msg}</div></div>${err ? html`<button class="btn btn-sm" type="button" data-hreload>Reload</button>` : ""}`); $("[data-hreload]", box)?.addEventListener("click", () => location.reload()); };
  say(`Switching the panel to ${node.name}…`, "The panel is unavailable for about 20 seconds.");
  try { await post("/api/ha/handover", { serverId: node.serverId }); }
  catch (ex) { box.remove(); toastError(ex, "Couldn't switch the panel"); return; }
  const started = Date.now();
  for (;;) {
    await sleep(2000);
    let now = null;
    try { now = await get("/api/ha"); } catch { /* 503 haSwitching or connection refused while it switches */ }
    if (now?.leaderId && now.leaderId !== from) {
      say(`${nodeName(now, [], now.leaderId)} runs the active panel`, "Reloading…");
      setTimeout(() => { box.remove(); if (MOCK) ctx.reload(); else location.reload(); }, 800);
      return;
    }
    if (Date.now() - started > 120_000) { say("The switch is taking longer than expected", "Reload this page in a minute. If the old panel is still active, the switch was called off.", true); return; }
  }
}

/* ───────── change the main server (3.12.0, panel/lib/main-switch.mjs) ───────── */

const MS_DOT = { ok: "ok", auto: "run", todo: "warn", warn: "warn", blocked: "err" };
const MS_TAG = { ok: "Ready", auto: "Automatic", todo: "Do this first", warn: "Note", blocked: "Blocked" };

function mainSwitchBody(pf) {
  const old = pf.oldMain?.name || "the main server";
  return html`<p class="muted small" style="margin:0 0 12px;line-height:1.55">${pf.target.name} takes over everything ${old} does: the website front door, Cloudflare Tunnels, certificates and the panel. ${old} is then retired and removed from this list. Websites behind Cloudflare Tunnels stay up throughout; the panel is unavailable for about a minute at the end while it restarts.</p>
    <div class="edge-rows ms-steps">${pf.steps.map((st) => html`<div class="edge-row ms-step">
      <span class="dot ${MS_DOT[st.state] || "off"}"></span>
      <div class="ms-step-t"><div><b>${st.title}</b> <span class="muted small">· ${MS_TAG[st.state] || st.state}</span></div>${st.detail ? html`<div class="muted small">${st.detail}</div>` : ""}</div>
    </div>`)}</div>
    ${pf.ok ? html`<div class="field mt-16"><label>Type <b class="mono" style="color:var(--text)">${pf.oldMain?.name || "Main"}</b> to retire it and make ${pf.target.name} the main server</label><input class="input" data-ms-confirm autocomplete="off" spellcheck="false"/></div>`
      : html`<div class="note warn mt-16">${icon("alert")}<div>Finish the steps marked <b>Do this first</b> or <b>Blocked</b>, then open this again.</div></div>`}`;
}

/** Wait (through the restart) until /api/servers shows the new main server, then reload. */
async function waitForNewMain(job, targetName) {
  const box = document.createElement("div");
  box.className = "restart-banner"; box.setAttribute("role", "status");
  document.body.appendChild(box);
  const say = (title, msg, err = false) => { box.classList.toggle("err", err); mount(box, html`<span class="rb-spin" aria-hidden="true"></span><div><div class="strong">${title}</div><div class="muted small">${msg}</div></div>${err ? html`<button class="btn btn-sm" type="button" data-hreload>Reload</button>` : ""}`); $("[data-hreload]", box)?.addEventListener("click", () => location.reload()); };
  say(`Making ${targetName} the main server…`, "Copying backups and certificates from the old main server. You can watch the job log.");
  const j = await waitForJob(job.id, 8 * 60 * 60_000);
  if (j && j.status !== "succeeded") { say("The main server was not changed", j.error || "See the job log.", true); return; }
  say(`${targetName} is the main server`, "The panel is restarting — this page reloads when it is back.");
  const started = Date.now();
  for (;;) {
    await sleep(3000);
    const list = await get("/api/servers").catch(() => null);
    const main = list?.items?.find((x) => x.role === "main");
    if (main?.name === targetName && Date.now() - started > 5000) { box.remove(); location.reload(); return; }
    if (Date.now() - started > 5 * 60_000) { say("The panel is taking a while to come back", "Reload this page in a minute. If it doesn't load, check: journalctl -u fcc on the new main server.", true); return; }
  }
}

async function makeMainDialog(s) {
  let pf;
  try { pf = await get(`/api/servers/${s.id}/make-main`); } catch (ex) { toastError(ex, "Couldn't check the server"); return; }
  const old = pf.oldMain?.name || "Main";
  const m = openModal({
    title: `Make ${s.name} the main server`, sub: `Replaces ${old}`, ico: "server", size: "lg",
    body: mainSwitchBody(pf),
    foot: html`<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-ghost" data-ms-refresh>${icon("refresh")}Check again</button>${pf.ok ? html`<button class="btn btn-danger" data-ms-go disabled>Make ${s.name} the main server</button>` : ""}`,
    onMount(el, close) {
      const wire = () => {
        const inp = $("[data-ms-confirm]", el), go = $("[data-ms-go]", el);
        if (inp && go) inp.oninput = () => { go.disabled = inp.value.trim() !== old; };
      };
      wire();
      $("[data-ms-refresh]", el).onclick = async (e) => {
        const b = e.currentTarget; b.classList.add("loading");
        try { pf = await get(`/api/servers/${s.id}/make-main`); mount($(".modal-body", el), mainSwitchBody(pf)); wire(); if (pf.ok && !$("[data-ms-go]", el)) close("recheck"); }
        catch (ex) { toastError(ex, "Couldn't check the server"); } finally { b.classList.remove("loading"); }
      };
      const go = $("[data-ms-go]", el);
      if (go) go.onclick = async () => {
        go.classList.add("loading");
        try {
          const job = await post(`/api/servers/${s.id}/make-main`, { confirm: $("[data-ms-confirm]", el).value.trim() });
          close("started");
          if (job?.id) { openJobLog(job.id); waitForNewMain(job, s.name); }
        } catch (ex) { toastError(ex, "Couldn't start"); go.classList.remove("loading"); }
      };
    },
  });
  if ((await m.result) === "recheck") makeMainDialog(s); // became ready: reopen with the confirm field
}

/** Servers page header strip: active panel, standbys, votes; standby rows with lag and "Make active panel". */
/* ───────── failover speed (3.10, docs/HA.md "Failover speed") ───────── */

const FO_PRESETS = [10, 15, 30, 60, 120];
const FO_MIN = 10, FO_MAX = 300;
const secsWord = (n) => (n == null ? "?" : n >= 90 ? `${Math.round(n / 60)} min` : n >= 10 ? `${Math.round(n)} s` : `${Math.round(n * 10) / 10} s`);
const foLine = (f) => `Panel takes over in about ${secsWord(f.panelTakeoverSeconds)}, databases in about ${secsWord(f.databaseFailoverSeconds)}. Network outages between servers shorter than about ${secsWord(f.blipToleranceSeconds)} are ignored.`;
const foValid = (v) => Number.isInteger(v) && v >= FO_MIN && v <= FO_MAX;
const foWarn = (v) => (v < 15 ? html`<div class="note warn ha-fo-warn">${icon("alert")}<div>At this speed a short network hiccup between your servers can be mistaken for an outage and start a failover. A private network between the servers makes that much less likely.</div></div>` : "");

/** The "Failover speed" box: one cluster-wide number of seconds (GET/PATCH /api/ha/settings). */
function failoverBox(f) {
  if (!f) return "";
  const v = f.failoverSeconds;
  return html`<div class="ha-fo" data-fo>
    <div class="ha-fo-head"><label for="ha-fo-secs"><b>Failover speed</b></label>
      <span class="muted small">How long from a server going down until the panel and the databases run elsewhere.</span></div>
    <div class="ha-fo-row">
      <span class="ha-fo-input"><input class="input" id="ha-fo-secs" type="number" inputmode="numeric" min="${FO_MIN}" max="${FO_MAX}" step="1" value="${v}" data-fo-input aria-describedby="ha-fo-line"/><span class="muted small">seconds</span></span>
      <span class="seg ha-fo-presets" role="group" aria-label="Presets">${FO_PRESETS.map((p) => html`<button type="button" class="${p === v ? "active" : ""}" aria-pressed="${p === v ? "true" : "false"}" data-fo-preset="${p}">${p} s</button>`)}</span>
      <button class="btn btn-sm btn-primary" type="button" data-fo-save disabled>Save</button>
    </div>
    <p class="small ha-fo-line" id="ha-fo-line" data-fo-line aria-live="polite">${foLine(f)}</p>
    <div data-fo-warn>${foWarn(v)}</div>
  </div>`;
}

/* Servers page header: a Panels section and a Databases section, each one tile per
   server with its role, plus a collapsible Failover speed box. */

let foOpen = (() => { try { return localStorage.getItem("fcc.ha.foOpen") === "1"; } catch { return false; } })();

const haTile = ({ dot, name, role, roleTone, meta = [], action = "", extra = "" }) => html`<div class="ha-tile">
  <div class="ha-tile-head"><span class="dot ${dot}"></span><span class="ha-tile-name">${name}</span><span class="badge ${roleTone}">${role}</span></div>
  ${meta.length ? html`<div class="ha-tile-meta muted small">${meta.map((m) => (typeof m === "string" ? html`<span>${m}</span>` : m))}</div>` : ""}
  ${extra}${action ? html`<div class="ha-tile-foot">${action}</div>` : ""}
</div>`;

const secHead = (ico, tone, title, sub, right = "") => html`<div class="ha-sec-head"><span class="ha-ico ${tone}">${icon(ico, "sm")}</span>
  <div class="ha-strip-t"><b>${title}</b>${sub ? html`<span class="muted"> · ${sub}</span>` : ""}</div>${right}</div>`;

const warnList = (warns) => (warns.length ? html`<ul class="ha-warns ha-strip-warns">${warns.map((w) => html`<li>${icon("alert", "xs")}<span>${w}</span></li>`)}</ul>` : "");

/** Panels: the active panel and every standby as tiles (null while panel failover is off). */
function panelsSection(ha, items) {
  if (!ha?.enabled) return "";
  const nodes = ha.nodes || [];
  const leader = nodes.find((n) => n.serverId === ha.leaderId) || { serverId: ha.leaderId, name: nodeName(ha, items, ha.leaderId), online: true };
  const standbys = nodes.filter((n) => n.serverId !== ha.leaderId);
  const votes = (ha.votes || []).filter((v) => v.votedFor === ha.leaderId && v.reachable !== false && (v.leaseLeftMs == null || v.leaseLeftMs > 0)).length;
  const voters = ha.voters ?? (ha.votes || []).length;
  const short = ha.majority && votes < ha.majority;
  const warns = ha.warnings || [];
  const tone = ha.armed === false || short || warns.length ? "warn" : "ok";
  const sub = html`${standbys.length ? `${standbys.length} ${standbys.length === 1 ? "standby" : "standbys"}` : "no standbys"} · <span class="${short ? "ha-short" : ""}" title="${ha.majority ? `A majority is ${ha.majority} of ${voters}.` : ""}">votes ${votes}/${voters}</span>`;
  return html`<section class="ha-sec">
    ${secHead("layers", tone, "Panels", sub)}
    ${ha.armed === false ? html`<div class="muted small">Waiting for the servers to vote… Failover starts once a majority has voted.</div>` : ""}
    ${warnList(warns)}
    <div class="ha-tiles">
      ${haTile({ dot: "ok", name: leader.name || nodeName(ha, items, leader.serverId), role: "Active", roleTone: "ok",
        meta: [leader.panelVersion ? `v${leader.panelVersion}` : null, "serving the panel", `${votes} of ${voters} votes`].filter(Boolean) })}
      ${standbys.map((n) => {
        const can = n.online && ha.armed !== false;
        return haTile({
          dot: !n.online ? "err" : n.role === "candidate" ? "warn" : "ok", name: n.name, role: !n.online ? "Offline" : n.role === "candidate" ? "Electing" : "Standby", roleTone: !n.online ? "err" : "",
          meta: [n.panelVersion ? `v${n.panelVersion}` : null,
            html`<span title="Panel data is copied to standbys as it changes; this is how far behind its copy is.">${!n.online ? "data lag —" : n.lagMs === 0 ? "data in sync" : `data lag ${fmtLag(n.lagMs)}`}</span>`,
            html`<span class="${n.codeInSync === false ? "ha-short" : ""}">${n.codeInSync === false ? "code updating" : "code in sync"}</span>`].filter(Boolean),
          action: html`<button class="btn btn-sm" type="button" data-ha-active="${n.serverId}" ${can ? "" : raw("disabled")} title="${!n.online ? `${n.name} is offline.` : ha.armed === false ? "Wait until the servers have voted." : "Hand the active panel over to this server."}">Make active panel</button>`,
        });
      })}
    </div>
  </section>`;
}

/** Databases: the primary and the replica as tiles (null when replication is off). */
function databasesSection(repl) {
  const sum = replSummary(repl);
  if (!sum) return "";
  const rep_ = repl?.replica, prog = repl?.progress, p = repl?.primary;
  const broken = replicaBroken(repl);
  const sub = repl.mode ? `${repl.mode === "auto" ? "automatic" : "manual"} failover` : sum.text;
  return html`<section class="ha-sec">
    ${secHead("database", sum.tone === "ok" ? "ok" : "warn", "Databases", sub, html`<a class="btn btn-sm" href="#/settings/databases">Replication</a>`)}
    ${warnList(sum.warns)}
    <div class="ha-tiles">
      ${haTile({ dot: repl.detect?.primaryDownForMs ? "err" : "ok", name: p?.name || sum.primary, role: "Primary", roleTone: "ok",
        meta: [p?.readOnly ? html`<span class="ha-short">read-only</span>` : "read & write", p?.address || null].filter(Boolean) })}
      ${rep_ ? haTile({ dot: broken ? "err" : syncActive(prog) ? "run" : "ok", name: rep_.name, role: "Replica", roleTone: broken ? "err" : "",
        meta: syncActive(prog) ? [sum.text] : [html`<span title="How far the replica's copy of the databases is behind (seconds behind the primary)">lag ${fmtLagS(rep_.lagSeconds)}</span>`,
          rep_.sqlRunning != null ? (rep_.ioRunning && rep_.sqlRunning ? "threads running" : html`<span class="ha-short">threads stopped</span>`) : null].filter(Boolean),
        extra: syncActive(prog) ? html`<div class="ha-db-bar">${syncBar(prog, { size: "sm" })}</div>` : "" })
      : html`<div class="ha-tile ha-tile-empty muted small">No replica — the databases have no copy right now.</div>`}
    </div>
  </section>`;
}

/** Failover speed, folded away behind a button (the choice is remembered per browser). */
function failoverSection(f) {
  if (!f) return "";
  return html`<section class="ha-sec ha-fo-sec">
    <button type="button" class="ha-fo-toggle" data-fo-toggle aria-expanded="${foOpen ? "true" : "false"}">
      <span class="ha-ico">${icon("zap", "sm")}</span>
      <span class="ha-strip-t"><b>Failover speed</b><span class="muted"> · ${f.failoverSeconds} s</span></span>
      <span class="ha-fo-chev">${icon(foOpen ? "chevronDown" : "chevronRight", "sm")}</span>
    </button>
    <div data-fo-body ${foOpen ? "" : raw("hidden")}>${failoverBox(f)}</div>
  </section>`;
}

function haStrip(ha, items, repl) {
  const panels = panelsSection(ha, items);
  const dbs = databasesSection(repl);
  // Panel failover off: the speed still sets how fast the database fails over (shown once there is a second server).
  const fo = ha?.failover && (ha?.enabled || (items || []).length >= 2) ? failoverSection(ha.failover) : "";
  if (!panels && !dbs && !fo) return html``;
  const warn = ha?.enabled && (ha.armed === false || (ha.warnings || []).length);
  return html`<div class="card ha-strip ${warn ? "is-warn" : ""}">${panels}${dbs}${fo}</div>`;
}

/* ───────── add/edit server dialog (docs/HA.md, Phase 3: three menus instead of switches) ───────── */

const ROLE = {
  host: { label: "Website host", desc: "Runs the websites placed on it. Visitors reach them through the main server or an edge node." },
  edge: { label: "Edge node", desc: EDGE_HELP },
  panel: { label: "Edge + panel node", desc: "An edge node that also runs a standby copy of the panel, which takes over if the active panel's server goes down." },
};
const LB_OPT = {
  in: { label: "In the pool", desc: "Offered when you build a load-balanced pool." },
  out: { label: "Not in the pool", desc: "Not offered when you build a load-balanced pool." },
};
const STATUS_OPT = {
  on: { label: "Enabled", desc: "Takes traffic and can get new websites." },
  off: { label: "Disabled", desc: "nginx stops sending traffic here and no new websites can be placed on it." },
};
const roleOf = (s) => (s?.panel?.enabled ? "panel" : s?.edge?.enabled ? "edge" : "host");
const EDGE_FIREWALL = "Edges must reach every server's site ports (3000–3999) and main's panel port; the panel opens them in ufw where ufw is active.";

/** Which Role options exist and why some can't be picked: { options: [{ id, label, why }] }. */
function roleOptions(s, { panel }) {
  const was = s ? roleOf(s) : null;
  // A panel node can only step down when it isn't running the active panel (same reason Phase 2 computes).
  const down = was === "panel" && panel ? panel.block(true) : null;
  const opts = [
    { id: "host", label: ROLE.host.label, why: down },
    { id: "edge", label: ROLE.edge.label, why: down },
  ];
  if (panel) opts.push({ id: "panel", label: ROLE.panel.label, why: !s ? "Add the server first. Once its agent is connected, edit it to make it a panel node." : was === "panel" ? null : panel.block(true) });
  return opts;
}

/** What saving does when the role changes (null when nothing extra happens). */
function roleChangeNote(was, to, isEdit) {
  if (!isEdit) return to === "host" ? null : EDGE_FIREWALL;
  if (was === to) return null;
  if (to === "panel") return was === "host" ? "Saving makes it an edge node, then installs the panel and opens the job log." : "Saving installs the panel here and opens the job log.";
  if (was === "panel") return to === "host" ? "Saving removes the standby panel, then the front door and tunnel replica." : "Saving removes the standby panel from this server and opens the job log.";
  return to === "edge" ? `Saving sets up the front door and a tunnel replica here. ${EDGE_FIREWALL}` : "Saving removes the front door and tunnel replica from this server.";
}

const menuField = (name, label, options, value, extra = "", cls = "") => html`<div class="field srv-menu ${cls}"><label for="sf-${name}">${label}</label>
  <select class="select" id="sf-${name}" name="${name}">${options.map((o) => html`<option value="${o.id}" ${o.id === value ? raw("selected") : ""} ${o.why ? raw("disabled") : ""}>${o.label}</option>`)}</select>
  <div class="hint" data-desc="${name}"></div>${extra}</div>`;

async function serverForm(s, { edgeSupported = true, panel = null } = {}) {
  const isEdit = !!s, isMain = s?.role === "main";
  const was = isEdit ? roleOf(s) : "host";
  const roles = !isMain && edgeSupported ? roleOptions(s, { panel }) : null;
  let result = null;
  const roleField = isMain
    ? html`<div class="field srv-menu srv-role span-2"><label>Role</label><div class="srv-static">${icon("lock", "xs")}<span>Main (front door, panel)</span></div><div class="hint">Always runs the website front door, the tunnel connectors and the panel.</div></div>`
    : roles ? menuField("role", "Role", roles, was, html`<div class="hint srv-note" data-note hidden></div><div class="hint srv-why" data-why hidden></div>`, "srv-role span-2") : "";
  const m = openModal({
    title: isEdit ? `Edit ${s.name}` : "Add an agent server", ico: "server", size: "lg",
    sub: isEdit ? "" : "Any Linux box running the Forthway agent can host single-server websites and join load-balanced pools.",
    body: html`<form class="form-grid" novalidate>
      <div class="field"><label>Name</label><input class="input" name="name" value="${s?.name || ""}" placeholder="fra-agent-3"/></div>
      <div class="field"><label>Public host or IP</label><input class="input mono" name="host" value="${s?.host || ""}" placeholder="203.0.113.30"/></div>
      <div class="field"><label>Private address <span class="dim">(optional)</span></label><input class="input mono" name="privateHost" value="${s?.privateHost || ""}" placeholder="10.0.0.30"/><div class="hint">Used by nginx and MySQL when servers share a private network.</div></div>
      <div class="field"><label>Load-balancing weight</label><input class="input" type="number" min="1" max="100" name="weight" value="${s?.weight ?? 1}"/><div class="hint">A server with weight 2 gets twice the traffic of weight 1.</div></div>
      <div class="span-2 srv-sep"><span>Role and availability</span></div>
      ${roleField}
      ${menuField("lb", "Load balancing", [{ id: "in", label: LB_OPT.in.label }, { id: "out", label: LB_OPT.out.label }], s?.lbEligible !== false ? "in" : "out")}
      ${isEdit && !isMain ? menuField("status", "Status", [{ id: "on", label: STATUS_OPT.on.label }, { id: "off", label: STATUS_OPT.off.label }], s.enabled !== false ? "on" : "off") : ""}
      <div class="error-box span-2" data-err hidden></div><button type="submit" hidden></button></form>`,
    foot: html`<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-ok>${isEdit ? "Save changes" : html`${icon("plus")}Add server`}</button>`,
    onMount(el, close) {
      const form = $("form", el), btn = $("[data-ok]", el), err = $("[data-err]", el);
      // One short line under each menu describing the selected option; under Role also what saving does and why options are off.
      const describe = () => {
        const f = form.elements;
        const set = (name, text) => { const d = $(`[data-desc="${name}"]`, form); if (d) d.textContent = text || ""; };
        set("lb", LB_OPT[f.lb.value]?.desc);
        if (f.status) set("status", STATUS_OPT[f.status.value]?.desc);
        if (!f.role) return;
        set("role", ROLE[f.role.value]?.desc);
        const note = roleChangeNote(was, f.role.value, isEdit), noteEl = $("[data-note]", form);
        noteEl.hidden = !note; noteEl.textContent = note || "";
        // group blocked options by reason: "Website host and Edge node aren't available: …"
        const byWhy = new Map();
        for (const o of roles) if (o.why) byWhy.set(o.why, [...(byWhy.get(o.why) || []), o.label]);
        const whyEl = $("[data-why]", form);
        whyEl.hidden = !byWhy.size;
        mount(whyEl, html`${[...byWhy].map(([why, labels]) => html`<span class="srv-why-line">${icon("lock", "xs")}<span><b>${labels.join(" and ")}</b> ${labels.length > 1 ? "aren't" : "isn't"} available. ${why}</span></span>`)}`);
      };
      describe();
      form.addEventListener("change", (e) => { if (e.target.matches("select")) describe(); });
      form.addEventListener("input", (e) => e.target.classList?.remove("invalid"));
      const go = async (e) => {
        e?.preventDefault();
        const f = form.elements;
        const body = { name: f.name.value.trim(), host: f.host.value.trim(), privateHost: f.privateHost.value.trim() || null, weight: Math.max(1, Number(f.weight.value) || 1), lbEligible: f.lb.value === "in" };
        if (f.status) body.enabled = f.status.value === "on";
        const role = f.role ? f.role.value : null;
        if (role) body.edge = role !== "host";
        if (!body.name) { f.name.classList.add("invalid"); f.name.focus(); return; }
        if (!body.host) { f.host.classList.add("invalid"); f.host.focus(); return; }
        // Panel changes: confirm while the dialog is still open. Panel → website host keeps the edge
        // on in this save; it is turned off once the panel removal job has finished.
        const panelChange = isEdit && role && (role === "panel") !== (was === "panel") ? (role === "panel" ? "add" : "remove") : null;
        const toHost = panelChange === "remove" && role === "host";
        if (toHost) body.edge = true;
        if (panelChange && !(await confirmPanel(s, panelChange === "add", { toHost }))) return;
        btn.classList.add("loading"); err.hidden = true;
        try {
          if (isEdit) {
            result = await patch(`/api/servers/${s.id}`, body);
            close(result);
            if (panelChange) {
              const sv = { ...s, ...result };
              const job = await startPanelJob(sv, panelChange === "add");
              if (job && toHost) edgeOffAfter(job, sv);
            }
            return;
          }
          const r = await post("/api/servers", body);
          result = r.server;
          $(".modal-head h3", el).textContent = `Install the agent on ${r.server.name}`;
          $(".modal-head p", el) && ($(".modal-head p", el).textContent = "Run this on the new server. This dialog updates when the agent connects.");
          mount($(".modal-body", el), html`${installBlock(r.installCommand, r.warning)}<div class="note mt-16" data-wait style="align-items:center">${icon("clock")}<div style="flex:1">Waiting for the agent to connect…</div><span class="dot run"></span></div>`);
          mount($(".modal-foot", el), html`<button class="btn btn-primary" data-close>Done</button>`);
        } catch (ex) { err.hidden = false; err.textContent = ex.message; }
        finally { btn.classList.remove("loading"); }
      };
      form.addEventListener("submit", go); btn.onclick = go;
    },
  });
  // flip the waiting note when the new server comes online
  const { onEvent } = await import("../events.js");
  const off = onEvent("server", (d) => {
    if (!result || d?.id !== result.id || !d.online) return;
    const w = $("[data-wait]", m.el);
    if (w) mount(w, html`${icon("check")}<div style="flex:1"><b>${d.name}</b> is connected${d.info?.os ? ` — ${d.info.os}` : ""}.</div>`);
  });
  await m.result; off();
  return result;
}

function serverCard(s, ha, repl) {
  const m = s.metrics || {};
  const memT = m.memTotal || s.info?.memTotal, diskT = m.diskTotal || s.info?.diskTotal;
  return html`<div class="ecard server-card ${s.online ? "" : "is-offline"}" data-server="${s.id}" style="--c:${s.online ? "#4a72ff" : "#46507a"}">
    <span class="accent-glow"></span>
    <div class="srv-head">
      <span class="srv-ico">${icon("server")}</span>
      <div style="min-width:0;flex:1"><div class="ecard-title row" style="gap:8px">${s.name}</div>
        <div class="ecard-sub mono" style="font-size:11.5px">${s.host || "—"}${s.privateHost ? ` · ${s.privateHost}` : ""}</div></div>
      <button class="icon-btn sm" data-smenu="${s.id}" aria-label="Server actions">${icon("more")}</button>
    </div>
    <div class="row wrap mt-12" style="gap:6px">
      <span class="badge ${s.role === "main" ? "blue" : ""}">${serverKind(s)}</span>
      ${s.online ? html`<span class="badge ok"><span class="dot ok" style="width:6px;height:6px"></span>Online</span>` : html`<span class="badge err">Offline · ${s.lastSeenAt ? `seen ${ago(s.lastSeenAt)}` : "never connected"}</span>`}
      ${s.enabled === false ? html`<span class="badge warn">Disabled</span>` : ""}
      ${s.lbEligible !== false ? html`<span class="badge badge-lb">${icon("balance")}LB pool</span>` : ""}
      ${isEdge(s) && s.edge ? html`<span class="badge blue" title="${s.role === "main" ? "Always an edge (front door)" : EDGE_HELP}">${icon("shield")}Edge</span>` : ""}
      ${panelBadge(s, ha)}
      ${dbBadge(s, repl)}
    </div>
    ${s.role !== "main" && s.edge?.enabled ? edgeStrip(s) : ""}
    <div class="srv-meters ubars">
      ${ubar("CPU", m.cpu, m.cpu != null ? 100 : 0, m.cpu != null ? `${Math.round(m.cpu)}%` : undefined)}
      ${ubar("RAM", m.mem, memT)}
      ${ubar("Disk", m.disk, diskT)}
    </div>
    <div class="srv-spark" data-spark="${s.id}"><div class="skel" style="height:100%"></div></div>
    <div class="ecard-foot" style="justify-content:space-between;padding-top:12px;border-top:1px solid var(--line)">
      <span class="muted small row" style="gap:6px">${icon("globe", "xs")}${plural(s.siteCount || 0, "site")}</span>
      <span class="muted small">weight ${s.weight ?? 1}</span>
      <span class="muted small">${s.info?.os || (s.agentVersion ? "agent " + s.agentVersion : "")}</span>
    </div>
  </div>`;
}

function edgeStrip(s) {
  const st = edgeState(s), es = s.edgeStatus;
  const conns = es?.connectors || [];
  const up = conns.filter((c) => c.active && c.readyConnections > 0).length;
  const detail = es?.error ? es.error : conns.length ? `${up} of ${plural(conns.length, "tunnel replica")} connected` : es?.appliedAt ? `applied ${ago(es.appliedAt)}` : "waiting for the first sync";
  return html`<button type="button" class="edge-strip" data-edge="${s.id}" aria-label="Edge node details for ${s.name}">
    <span class="dot ${st.tone}"></span><span class="edge-strip-t"><b>${st.text}</b> <span class="muted">· ${detail}</span></span>${icon("chevronRight", "sm")}</button>`;
}

export default async function servers(ctx) {
  const { root } = ctx;
  ctx.crumbs([{ label: "Servers" }]);
  mount(root, html`${pageHead("Servers & load balancing", "The main server runs the panel, nginx and MySQL. Agent servers host websites — on their own or as part of a load-balanced pool.", html`<button class="btn btn-primary" data-add>${icon("plus")}Add server</button>`)}
    <div data-ha></div>
    <div data-lb></div>
    <div class="section-head mt-24"><div><h2>Servers</h2><p data-sum>Loading…</p></div></div>
    <div data-list><div class="cards">${[1, 2, 3].map(() => html`<div class="skel" style="height:290px;border-radius:18px"></div>`)}</div></div>`);
  const list = $("[data-list]", root), lbBox = $("[data-lb]", root), haBox = $("[data-ha]", root);
  let items = [], lb = null, ha = null, repl = null;
  const paintHa = () => mount(haBox, haStrip(ha, items, repl));
  // GET /api/ha: null on an older panel (404) — then nothing about panel nodes shows.
  const getHa = () => get("/api/ha").catch(() => null);
  const sparks = {};

  const loadSpark = async (id) => {
    try {
      const r = await get(`/api/servers/${id}/metrics?range=1h`);
      const pts = (Array.isArray(r) ? r : r.points || r.items || r.series || []).map((p) => p.cpu).filter((v) => v != null);
      sparks[id] = pts;
      paintSpark(id);
    } catch { sparks[id] = []; paintSpark(id); }
  };
  const paintSpark = (id) => {
    const el = $(`[data-spark="${id}"]`, list); if (!el) return;
    const s = items.find((x) => x.id === id);
    mount(el, html`<div class="row tiny muted" style="justify-content:space-between;margin-bottom:4px"><span>CPU · last hour</span></div><div style="height:32px">${sparkline(sparks[id] || [], { color: s?.online ? "#6d8dff" : "#46507a", h: 32, w: 260 })}</div>`);
  };

  const paintLb = () => {
    if (!lb) return mount(lbBox, html``);
    const sitesLb = (lb.sites || []).filter((x) => x.loadBalanced);
    const lbOk = (lb.installed || lb.dryRun) && lb.configOk !== false;
    // Folds away (closed by default) — but stays open while nginx reports an error.
    mount(lbBox, foldCard({ id: "servers.frontDoor", open: false, forceOpen: !!lb.lastError || lb.configOk === false, count: sitesLb.length || null,
      title: html`<span class="li-ico" style="width:30px;height:30px;border-radius:9px;place-items:center;background:${lbOk ? "rgba(61,220,151,.12)" : "rgba(255,93,122,.12)"};color:${lbOk ? "var(--ok)" : "var(--err)"}">${icon("balance", "sm")}</span>Front door · nginx ${lb.version ? html`<span class="muted" style="font-weight:500">v${lb.version}</span>` : ""}`,
      sub: html`${!lb.installed ? (lb.dryRun ? html`Dry run — configs are written but nginx isn't touched · applied ${ago(lb.lastAppliedAt)}` : "nginx is not installed on the main server") : lb.configOk === false ? "Last config test failed" : html`Config OK · applied ${ago(lb.lastAppliedAt)}`}${sitesLb.length ? ` · ${plural(sitesLb.length, "load-balanced website")}` : ""}`,
      actions: html`<button class="btn" data-apply>${icon("refresh")}<span class="hide-sm">Re-apply load balancer</span><span class="show-sm">Re-apply</span></button>`,
      body: html`
      ${lb.lastError ? html`<div class="card-body" style="padding-bottom:0"><div class="error-box">${icon("alert")}<div class="mono small">${lb.lastError}</div></div></div>` : ""}
      <div class="card-body">${sitesLb.length ? html`<div class="label" style="margin-bottom:10px">Load-balanced websites</div>
        ${moreList(sitesLb, (x) => html`<a class="list-item" href="#/sites/${x.id}" style="border:1px solid var(--line);border-radius:12px;padding:10px 14px">
          <span class="li-ico">${icon("globe", "sm")}</span>
          <div class="li-main"><div class="li-title">${x.name}</div><div class="li-sub">${(x.domains || [])[0] || ""} · ${METHOD_LABEL[x.method] || x.method}</div></div>
          <div class="li-right">${(x.upstreams || []).map((u) => html`<span class="row tiny" style="gap:5px" title="${u.name}: ${!u.online ? "offline" : u.healthy ? "healthy" : "unhealthy"}"><span class="dot ${!u.online ? "off" : u.healthy ? "ok" : "err"}"></span><span class="hide-sm">${u.name}</span></span>`)}</div></a>`, { id: "servers.lbSites", limit: 5, cls: "stack lb-site-stack", noun: "websites" })}`
        : html`<p class="muted small">No load-balanced websites yet. Turn on load balancing when creating a website or in its Settings tab.</p>`}</div>` }));
  };

  const paint = () => {
    const on_ = items.filter((s) => s.online).length;
    const edges = items.filter((s) => s.role !== "main" && s.edge?.enabled).length;
    $("[data-sum]", root).textContent = `${on_} of ${items.length} online · ${items.filter((s) => s.lbEligible !== false).length} available for load balancing${items.some((s) => s.edge) ? ` · ${edges ? plural(edges, "edge node") : "no edge nodes besides main"}` : ""}`;
    mount(list, items.length ? html`<div class="cards">${items.map((x) => serverCard(x, ha, repl))}
      <button class="ecard" data-add style="align-items:center;justify-content:center;gap:10px;border-style:dashed;cursor:pointer;min-height:240px;color:var(--muted);font:inherit">
        <span class="e-ico" style="width:46px;height:46px;border-radius:14px;display:grid;place-items:center;background:rgba(74,114,255,.12);color:var(--blue-3)">${icon("plus")}</span>
        <b style="color:var(--text)">Add an agent server</b><span class="small" style="max-width:220px;text-align:center">One command on any Ubuntu or Debian box.</span></button></div>`
      : emptyState({ ico: "server", title: "No servers", text: "The main server should always appear here." }));
    items.forEach((s) => (sparks[s.id] ? paintSpark(s.id) : loadSpark(s.id)));
  };
  const load = async () => {
    try {
      const [s, l, h, d] = await Promise.all([get("/api/servers"), get("/api/loadbalancer").catch(() => null), getHa(), getReplication()]);
      items = s.items || []; lb = l; ha = h && typeof h === "object" ? h : null; repl = d;
      if (!ctx.alive()) return;
      paintHa(); paintLb(); paint();
    } catch (e) { if (ctx.alive()) { mount(list, errorState(e)); $("[data-retry]", list)?.addEventListener("click", load); } }
  };
  await load();

  const edgeSupported = () => items.some((x) => x.edge);
  const panelOpts = (s) => (panelSupported(ha, items) ? { block: (edge) => panelBlock(s, ha, items, { edge }) } : null);
  on(root, "click", "[data-add]", async () => { if (await serverForm(null, { edgeSupported: edgeSupported(), panel: panelSupported(ha, items) ? { block: () => null } : null })) load(); });
  on(root, "click", "[data-ha-active]", (e, b) => { const n = (ha?.nodes || []).find((x) => x.serverId === b.dataset.haActive); if (n) makeActive(n, ha, ctx); });
  on(root, "click", "[data-edge]", (e, b) => { const s = items.find((x) => x.id === b.dataset.edge); if (s) edgeDialog(s); });
  on(root, "click", "[data-apply]", async (e, b) => {
    b.classList.add("loading");
    try { jobStarted(await post("/api/loadbalancer/apply"), "Re-applying load balancer"); } catch (ex) { toastError(ex, "Couldn't apply"); } finally { b.classList.remove("loading"); }
  });
  on(root, "click", "[data-smenu]", (e, b) => {
    const s = items.find((x) => x.id === b.dataset.smenu); if (!s) return;
    openMenu(b, [
      { label: "Edit server", icon: "edit", onClick: async () => { if (await serverForm(s, { edgeSupported: edgeSupported(), panel: panelOpts(s) })) { toast("Server updated", "ok"); load(); } } },
      s.role !== "main" && panelSupported(ha, items) && (() => {
        const why = panelBlock(s, ha, items), on_ = !!s.panel?.enabled;
        return { label: html`<span class="menu-t">${on_ ? "Remove panel node" : "Make panel node"}${why ? html`<small class="menu-why">${why}</small>` : ""}</span>`, icon: "layers", disabled: !!why,
          onClick: async () => { if (await setPanelNode(s, !on_)) load(); } };
      })(),
      s.role !== "main" && ha?.enabled && s.panel?.enabled && s.id !== ha.leaderId && { label: "Make active panel", icon: "zap", disabled: !s.online || ha.armed === false,
        onClick: () => { const n = (ha.nodes || []).find((x) => x.serverId === s.id) || { serverId: s.id, name: s.name }; makeActive(n, ha, ctx); } },
      s.role !== "main" && { label: "Make main server", icon: "server", onClick: () => makeMainDialog(s) },
      s.role !== "main" && s.edge?.enabled && { label: "Edge node details", icon: "shield", onClick: () => edgeDialog(s) },
      s.role !== "main" && s.edge?.enabled && { label: "Sync edge now", icon: "refresh", disabled: !s.online, onClick: async () => {
        try { const job = await post(`/api/servers/${s.id}/edge/sync`); if (job?.id) openJobLog(job.id); else toast("Sync sent", "ok"); } catch (ex) { toastError(ex, "Couldn't sync"); } } },
      { label: s.lbEligible !== false ? "Remove from LB pool" : "Make available for LB", icon: "balance", onClick: async () => { try { await patch(`/api/servers/${s.id}`, { lbEligible: s.lbEligible === false }); load(); } catch (ex) { toastError(ex); } } },
      s.role !== "main" && { label: s.enabled === false ? "Enable" : "Disable", icon: "power", onClick: async () => {
        if (s.enabled !== false && !(await confirmDialog({ title: `Disable ${s.name}?`, message: "nginx stops sending traffic to it. Websites that only run here go offline.", confirmText: "Disable", danger: true }))) return;
        try { await patch(`/api/servers/${s.id}`, { enabled: s.enabled === false }); load(); } catch (ex) { toastError(ex); } } },
      { label: "Back up this server", icon: "hardDrive", disabled: !s.online, onClick: () => serverBackupDialog(items, s.id) },
      s.role !== "main" && { label: "Rotate token", icon: "key", onClick: async () => {
        if (!(await confirmDialog({ title: `Rotate ${s.name}'s token?`, message: "The agent disconnects until you run the new install command on that server. Websites keep running meanwhile.", confirmText: "Rotate token", ico: "key" }))) return;
        try { const r = await post(`/api/servers/${s.id}/token`); openModal({ title: `New install command for ${s.name}`, ico: "key", size: "lg", body: installBlock(r.installCommand, r.warning), foot: html`<button class="btn btn-primary" data-close>Done</button>` }); } catch (ex) { toastError(ex); } } },
      s.role !== "main" && { sep: true },
      s.role !== "main" && { label: "Remove server", icon: "trash", danger: true, onClick: async () => {
        if (s.siteCount) { toast(`${s.name} still hosts ${plural(s.siteCount, "website")}`, "warn", { msg: "Move them to another server first (website → Settings → Hosting)." }); return; }
        if (!(await confirmDialog({ title: `Remove ${s.name}?`, message: "The panel forgets this server and its token stops working. Uninstall the agent on the machine afterwards.", danger: true, typed: s.name, confirmText: "Remove server" }))) return;
        try { await del(`/api/servers/${s.id}`); toast(`${s.name} removed`, "ok"); load(); } catch (ex) { toastError(ex, "Couldn't remove"); } } },
    ]);
  });

  // live metrics: patch the one card in place
  ctx.on("server", (d) => {
    if (!d?.id) return;
    if (d.deleted || !items.some((x) => x.id === d.id)) return debounce(load, 300)();
    const i = items.findIndex((x) => x.id === d.id);
    items[i] = { ...items[i], ...d };
    const el = $(`[data-server="${d.id}"]`, list);
    if (el) { el.replaceWith(frag(serverCard(items[i], ha, repl))); paintSpark(d.id); }
  });
  ctx.on("ha", debounce(async () => {
    const h = await getHa();
    if (!ctx.alive() || !h) return;
    ha = h; paintHa();
    // roles may have moved: repaint the cards' badges
    const fresh = await get("/api/servers").catch(() => null);
    if (fresh?.items && ctx.alive()) { items = fresh.items; paint(); }
  }, 500));
  // Background repaints of the strip skip while someone is changing the failover speed (it would reset the box).
  const quietPaintHa = () => {
    const fo = $("[data-fo-save]", haBox);
    if ((fo && !fo.disabled) || $("[data-fo-input]", haBox) === document.activeElement) return;
    paintHa();
  };
  // Database replication: the SSE payload is the full status view (same as GET /api/mysql/replication).
  ctx.on("mysql-ha", debounce(async (d) => {
    const r = d && typeof d === "object" && "enabled" in d ? d : await getReplication();
    if (!ctx.alive()) return;
    const roles = (x) => JSON.stringify([x?.enabled, x?.primary?.serverId, x?.replica?.serverId, x?.replica?.state, syncActive(x?.progress)]);
    const moved = roles(r) !== roles(repl);
    repl = r; quietPaintHa();
    if (moved) paint(); // card badges
  }, 500));
  // Lag numbers: refresh the strip while the page is open (standby lag isn't pushed on its own).
  const lagTimer = setInterval(async () => {
    if (document.hidden || !ctx.alive()) return;
    const [h, d] = await Promise.all([getHa(), getReplication()]);
    if (!ctx.alive()) return;
    if (h) ha = h;
    repl = d; quietPaintHa();
  }, 10_000);
  ctx.cleanup?.(() => clearInterval(lagTimer));
  // Failover speed: preview the breakdown while typing (GET /api/ha/settings?failoverSeconds=N), save with PATCH.
  const foSaved = () => ha?.failover?.failoverSeconds;
  const foState = (v, f) => {
    const box = $("[data-fo]", haBox); if (!box) return;
    const ok = foValid(v);
    $("[data-fo-input]", box).classList.toggle("invalid", !ok);
    $("[data-fo-save]", box).disabled = !ok || v === foSaved();
    $$("[data-fo-preset]", box).forEach((b) => { const on_ = Number(b.dataset.foPreset) === v; b.classList.toggle("active", on_); b.setAttribute("aria-pressed", on_ ? "true" : "false"); });
    $("[data-fo-line]", box).textContent = !ok ? `Enter a whole number of seconds from ${FO_MIN} to ${FO_MAX}.` : f ? foLine(f) : "…";
    mount($("[data-fo-warn]", box), ok ? foWarn(v) : html``);
  };
  let foSeq = 0;
  const foPreview = debounce(async (v) => {
    const seq = ++foSeq;
    if (!foValid(v)) return foState(v, null);
    const f = await get(`/api/ha/settings?failoverSeconds=${v}`).catch(() => null);
    if (seq === foSeq && ctx.alive()) foState(v, f);
  }, 200);
  const foValue = () => Math.round(Number($("[data-fo-input]", haBox)?.value));
  on(root, "input", "[data-fo-input]", () => { const v = foValue(); foState(v, null); foPreview(v); });
  on(root, "click", "[data-fo-toggle]", (e, b) => {
    foOpen = !foOpen;
    try { localStorage.setItem("fcc.ha.foOpen", foOpen ? "1" : "0"); } catch { /* per-browser nicety */ }
    b.setAttribute("aria-expanded", foOpen ? "true" : "false");
    mount($(".ha-fo-chev", b), icon(foOpen ? "chevronDown" : "chevronRight", "sm"));
    const body = $("[data-fo-body]", haBox); if (body) body.hidden = !foOpen;
  });
  on(root, "click", "[data-fo-preset]", (e, b) => { const inp = $("[data-fo-input]", haBox); if (!inp) return; inp.value = b.dataset.foPreset; const v = foValue(); foState(v, null); foPreview(v); });
  on(root, "click", "[data-fo-save]", async (e, b) => {
    const v = foValue(); if (!foValid(v)) return;
    b.classList.add("loading");
    try {
      const f = await patch("/api/ha/settings", { failoverSeconds: v });
      ha = { ...(ha || {}), failover: f };
      paintHa();
      toast(`Failover speed: ${f.failoverSeconds} s`, "ok", { msg: foLine(f) });
    } catch (ex) { toastError(ex, "Couldn't change the failover speed"); }
    finally { b.classList.remove("loading"); }
  });
  ctx.on(["lb", "site"], debounce(async () => { lb = await get("/api/loadbalancer").catch(() => lb); if (ctx.alive()) paintLb(); }, 500));
}
