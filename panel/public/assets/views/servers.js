import { html, raw, mount, frag, $, $$, on, ago, plural, emptyState, errorState, skeletonRows, debounce, sleep, toast, toastError, confirmDialog, openModal, openMenu, secretBox } from "../util.js";
import { icon } from "../icons.js";
import { get, post, patch, del, MOCK } from "../api.js";
import { sparkline } from "../charts.js";
import { pageHead, serverKind, jobStarted, openJobLog, METHOD_LABEL, ubar } from "../components.js";
import { serverBackupDialog } from "./backups.js";

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
      : html`<p class="muted small" style="margin:0">${es ? "No connectors. Add a Cloudflare Tunnel connector in Settings → Cloudflare and it is copied here." : "Shown after the first sync."}</p>`}
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

/** Turn a panel node on/off: confirm, POST /api/servers/:id/panel, open the job log. Resolves true when started. */
async function setPanelNode(s, enabled) {
  const ok = await confirmDialog(enabled
    ? { title: `Make ${s.name} a panel node?`, ico: "layers", confirmText: "Install the panel",
      message: `${PANEL_HELP} ${s.name} downloads the panel code, starts a standby panel and joins the vote. Websites and the active panel keep running.` }
    : { title: `Stop running the panel on ${s.name}?`, ico: "layers", danger: true, confirmText: "Remove panel node",
      message: `${s.name} stops its standby panel. Its panel data is kept on the server in a renamed folder, because it holds secrets. Websites on it keep running.` });
  if (!ok) return false;
  try {
    const job = await post(`/api/servers/${s.id}/panel`, { enabled });
    if (job?.id) openJobLog(job.id); else toast(enabled ? "Panel node added" : "Panel node removed", "ok");
    return true;
  } catch (ex) { toastError(ex, enabled ? "Couldn't add the panel node" : "Couldn't remove the panel node"); return false; }
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

/** Servers page header strip: active panel, standbys, votes; standby rows with lag and "Make active panel". */
function haStrip(ha, items) {
  if (!ha?.enabled) return html``;
  const leader = nodeName(ha, items, ha.leaderId);
  const standbys = (ha.nodes || []).filter((n) => n.serverId !== ha.leaderId);
  const votes = (ha.votes || []).filter((v) => v.votedFor === ha.leaderId && v.reachable !== false && (v.leaseLeftMs == null || v.leaseLeftMs > 0)).length;
  const voters = ha.voters ?? (ha.votes || []).length;
  const short = ha.majority && votes < ha.majority;
  const warns = ha.warnings || [];
  const tone = ha.armed === false || short ? "warn" : warns.length ? "warn" : "ok";
  return html`<div class="card ha-strip ${tone === "warn" ? "is-warn" : ""}">
    <div class="ha-strip-head">
      <span class="ha-ico ${tone}">${icon("layers", "sm")}</span>
      <div class="ha-strip-t"><b>Active panel: ${leader}</b><span class="muted"> · ${standbys.length ? `${standbys.length} ${standbys.length === 1 ? "standby" : "standbys"}` : "no standbys"} · </span><span class="${short ? "ha-short" : "muted"}" title="${ha.majority ? `A majority is ${ha.majority} of ${voters}.` : ""}">votes ${votes}/${voters}</span>
        ${ha.armed === false ? html`<div class="muted small">Waiting for the servers to vote… Failover starts once a majority has voted.</div>` : ""}</div>
    </div>
    ${warns.length ? html`<ul class="ha-warns ha-strip-warns">${warns.map((w) => html`<li>${icon("alert", "xs")}<span>${w}</span></li>`)}</ul>` : ""}
    ${standbys.length ? html`<div class="edge-rows ha-nodes">${standbys.map((n) => {
      const can = n.online && ha.armed !== false;
      return html`<div class="edge-row ha-node">
        <span class="dot ${!n.online ? "err" : n.role === "candidate" ? "warn" : "ok"}"></span>
        <span class="edge-row-name">${n.name}<span class="muted small"> · ${!n.online ? "offline" : n.role === "candidate" ? "electing" : "standby"}${n.version ? ` · v${n.version}` : ""}</span></span>
        <span class="ha-node-meta muted small"><span title="How far its copy of the panel data is behind">lag ${n.online ? fmtLag(n.lagMs) : "—"}</span><span class="${n.codeInSync === false ? "ha-short" : ""}">${n.codeInSync === false ? "code updating" : "code in sync"}</span></span>
        <button class="btn btn-sm" type="button" data-ha-active="${n.serverId}" ${can ? "" : raw("disabled")} title="${!n.online ? `${n.name} is offline.` : ha.armed === false ? "Wait until the servers have voted." : "Hand the active panel over to this server."}">Make active panel</button>
      </div>`;
    })}</div>` : ""}
  </div>`;
}

async function serverForm(s, { edgeSupported = true, panel = null } = {}) {
  const isEdit = !!s;
  let result = null;
  const m = openModal({
    title: isEdit ? `Edit ${s.name}` : "Add an agent server", ico: "server", size: "lg",
    sub: isEdit ? "" : "Any Linux box running the Forthway agent can host single-server websites and join load-balanced pools.",
    body: html`<form class="form-grid" novalidate>
      <div class="field"><label>Name</label><input class="input" name="name" value="${s?.name || ""}" placeholder="fra-agent-3" ${s?.role === "main" ? "" : ""}/></div>
      <div class="field"><label>Public host or IP</label><input class="input mono" name="host" value="${s?.host || ""}" placeholder="203.0.113.30"/></div>
      <div class="field"><label>Private address <span class="dim">(optional)</span></label><input class="input mono" name="privateHost" value="${s?.privateHost || ""}" placeholder="10.0.0.30"/><div class="hint">Used by nginx and MySQL when servers share a private network.</div></div>
      <div class="field"><label>Load-balancing weight</label><input class="input" type="number" min="1" max="100" name="weight" value="${s?.weight ?? 1}"/><div class="hint">A server with weight 2 gets twice the traffic of weight 1.</div></div>
      <div class="field span-2"><label class="switch"><input type="checkbox" name="lbEligible" ${s?.lbEligible !== false ? raw("checked") : ""}/><span class="track"></span><span><b style="color:var(--text)">Available for load balancing</b> — offer this server when building load-balanced pools</span></label></div>
      ${!edgeSupported ? "" : s?.role === "main" ? html`<div class="field span-2"><div class="row" style="gap:10px;font-size:13px;color:var(--text-2)"><span class="badge blue">${icon("shield")}Edge</span><span><b style="color:var(--text)">Always an edge (front door)</b> — the main server runs nginx and the tunnel connectors</span></div></div>`
        : html`<div class="field span-2"><label class="switch"><input type="checkbox" name="edge" ${s?.edge?.enabled ? raw("checked") : ""}/><span class="track"></span><span><b style="color:var(--text)">Edge node</b> — ${EDGE_HELP}</span></label><div class="hint" style="padding-left:46px">Edges must reach each server's site ports (3000–3999) and main's panel port. The panel opens ufw automatically where it is active.</div></div>`}
      ${panel && isEdit && s.role !== "main" ? html`<div class="field span-2" data-panel-field><label class="switch"><input type="checkbox" name="panel" ${s.panel?.enabled ? raw("checked") : ""} ${panel.block(s.edge?.enabled) ? raw("disabled") : ""}/><span class="track"></span><span><b style="color:var(--text)">Panel node</b> — ${PANEL_HELP}</span></label><div class="hint" style="padding-left:46px" data-panel-why>${panel.block(s.edge?.enabled) || (s.panel?.enabled ? "Turning it off removes the standby panel from this server." : "Saving installs the panel here and opens the job log.")}</div></div>` : ""}
      ${isEdit && s.role !== "main" ? html`<div class="field span-2"><label class="switch"><input type="checkbox" name="enabled" ${s?.enabled !== false ? raw("checked") : ""}/><span class="track"></span><span><b style="color:var(--text)">Enabled</b> — when off, nginx stops sending traffic here and no new sites can be placed on it</span></label></div>` : ""}
      <div class="error-box span-2" data-err hidden></div><button type="submit" hidden></button></form>`,
    foot: html`<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-ok>${isEdit ? "Save changes" : html`${icon("plus")}Add server`}</button>`,
    onMount(el, close) {
      const form = $("form", el), btn = $("[data-ok]", el), err = $("[data-err]", el);
      // Panel node needs Edge node: keep the two switches consistent while editing.
      const syncPanel = () => {
        const f = form.elements; if (!f.panel || !panel) return;
        if (s.panel?.enabled && f.edge) { f.edge.disabled = true; f.edge.checked = true; }
        const why = panel.block(f.edge ? f.edge.checked : s.edge?.enabled);
        f.panel.disabled = !!why;
        if (why && !s.panel?.enabled) f.panel.checked = false;
        $("[data-panel-why]", el).textContent = why || (s.panel?.enabled ? "Turning it off removes the standby panel from this server." : "Saving installs the panel here and opens the job log.");
      };
      if (s?.panel?.enabled && form.elements.edge) $(".hint", form.elements.edge.closest(".field")).textContent = "Panel nodes must be edges. Remove the panel node first to turn this off.";
      syncPanel();
      form.addEventListener("change", (e) => { if (e.target.name === "edge" || e.target.name === "panel") syncPanel(); });
      const go = async (e) => {
        e?.preventDefault();
        const f = form.elements;
        const body = { name: f.name.value.trim(), host: f.host.value.trim(), privateHost: f.privateHost.value.trim() || null, weight: Math.max(1, Number(f.weight.value) || 1), lbEligible: f.lbEligible.checked };
        if (f.enabled) body.enabled = f.enabled.checked;
        if (f.edge) body.edge = f.edge.checked;
        if (!body.name) { f.name.classList.add("invalid"); f.name.focus(); return; }
        if (!body.host) { f.host.classList.add("invalid"); f.host.focus(); return; }
        btn.classList.add("loading"); err.hidden = true;
        try {
          if (isEdit) {
            result = await patch(`/api/servers/${s.id}`, body);
            const f2 = form.elements;
            if (f2.panel && !f2.panel.disabled && f2.panel.checked !== !!s.panel?.enabled) {
              close(result);
              await setPanelNode({ ...s, ...result }, f2.panel.checked);
              return;
            }
            close(result); return;
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

function serverCard(s, ha) {
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
  let items = [], lb = null, ha = null;
  const paintHa = () => mount(haBox, haStrip(ha, items));
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
    mount(lbBox, html`<div class="card"><div class="card-head" style="flex-wrap:wrap">
        <span class="li-ico" style="width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:${(lb.installed || lb.dryRun) && lb.configOk !== false ? "rgba(61,220,151,.12)" : "rgba(255,93,122,.12)"};color:${(lb.installed || lb.dryRun) && lb.configOk !== false ? "var(--ok)" : "var(--err)"}">${icon("balance")}</span>
        <div><h3>Front door · nginx ${lb.version ? html`<span class="muted" style="font-weight:500">v${lb.version}</span>` : ""}</h3>
          <div class="sub">${!lb.installed ? (lb.dryRun ? html`Dry run — configs are written but nginx isn't touched · applied ${ago(lb.lastAppliedAt)}` : "nginx is not installed on the main server") : lb.configOk === false ? "Last config test failed" : html`Config OK · applied ${ago(lb.lastAppliedAt)}`}</div></div>
        <div class="right"><button class="btn" data-apply>${icon("refresh")}Re-apply load balancer</button></div></div>
      ${lb.lastError ? html`<div class="card-body" style="padding-bottom:0"><div class="error-box">${icon("alert")}<div class="mono small">${lb.lastError}</div></div></div>` : ""}
      <div class="card-body">${sitesLb.length ? html`<div class="label" style="margin-bottom:10px">Load-balanced websites</div>
        <div class="stack" style="gap:8px">${sitesLb.map((x) => html`<a class="list-item" href="#/sites/${x.id}" style="border:1px solid var(--line);border-radius:12px;padding:10px 14px">
          <span class="li-ico">${icon("globe", "sm")}</span>
          <div class="li-main"><div class="li-title">${x.name}</div><div class="li-sub">${(x.domains || [])[0] || ""} · ${METHOD_LABEL[x.method] || x.method}</div></div>
          <div class="li-right">${(x.upstreams || []).map((u) => html`<span class="row tiny" style="gap:5px" title="${u.name}: ${!u.online ? "offline" : u.healthy ? "healthy" : "unhealthy"}"><span class="dot ${!u.online ? "off" : u.healthy ? "ok" : "err"}"></span><span class="hide-sm">${u.name}</span></span>`)}</div></a>`)}</div>`
        : html`<p class="muted small">No load-balanced websites yet. Turn on load balancing when creating a website or in its Settings tab.</p>`}</div></div>`);
  };

  const paint = () => {
    const on_ = items.filter((s) => s.online).length;
    const edges = items.filter((s) => s.role !== "main" && s.edge?.enabled).length;
    $("[data-sum]", root).textContent = `${on_} of ${items.length} online · ${items.filter((s) => s.lbEligible !== false).length} available for load balancing${items.some((s) => s.edge) ? ` · ${edges ? plural(edges, "edge node") : "no edge nodes besides main"}` : ""}`;
    mount(list, items.length ? html`<div class="cards">${items.map((x) => serverCard(x, ha))}
      <button class="ecard" data-add style="align-items:center;justify-content:center;gap:10px;border-style:dashed;cursor:pointer;min-height:240px;color:var(--muted);font:inherit">
        <span class="e-ico" style="width:46px;height:46px;border-radius:14px;display:grid;place-items:center;background:rgba(74,114,255,.12);color:var(--blue-3)">${icon("plus")}</span>
        <b style="color:var(--text)">Add an agent server</b><span class="small" style="max-width:220px;text-align:center">One command on any Ubuntu or Debian box.</span></button></div>`
      : emptyState({ ico: "server", title: "No servers", text: "The main server should always appear here." }));
    items.forEach((s) => (sparks[s.id] ? paintSpark(s.id) : loadSpark(s.id)));
  };
  const load = async () => {
    try {
      const [s, l, h] = await Promise.all([get("/api/servers"), get("/api/loadbalancer").catch(() => null), getHa()]);
      items = s.items || []; lb = l; ha = h && typeof h === "object" ? h : null;
      if (!ctx.alive()) return;
      paintHa(); paintLb(); paint();
    } catch (e) { if (ctx.alive()) { mount(list, errorState(e)); $("[data-retry]", list)?.addEventListener("click", load); } }
  };
  await load();

  const edgeSupported = () => items.some((x) => x.edge);
  const panelOpts = (s) => (panelSupported(ha, items) ? { block: (edge) => panelBlock(s, ha, items, { edge }) } : null);
  on(root, "click", "[data-add]", async () => { if (await serverForm(null, { edgeSupported: edgeSupported() })) load(); });
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
    if (el) { el.replaceWith(frag(serverCard(items[i], ha))); paintSpark(d.id); }
  });
  ctx.on("ha", debounce(async () => {
    const h = await getHa();
    if (!ctx.alive() || !h) return;
    ha = h; paintHa();
    // roles may have moved: repaint the cards' badges
    const fresh = await get("/api/servers").catch(() => null);
    if (fresh?.items && ctx.alive()) { items = fresh.items; paint(); }
  }, 500));
  ctx.on(["lb", "site"], debounce(async () => { lb = await get("/api/loadbalancer").catch(() => lb); if (ctx.alive()) paintLb(); }, 500));
}
