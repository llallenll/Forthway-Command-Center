import { html, raw, mount, frag, $, $$, on, ago, fmtUsage, pct, plural, emptyState, errorState, skeletonRows, debounce, toast, toastError, confirmDialog, openModal, openMenu, secretBox } from "../util.js";
import { icon } from "../icons.js";
import { get, post, patch, del } from "../api.js";
import { sparkline, meter } from "../charts.js";
import { pageHead, serverKind, jobStarted, METHOD_LABEL } from "../components.js";
import { serverBackupDialog } from "./backups.js";

function installBlock(cmd, warning) {
  return html`${warning ? html`<div class="note warn" style="margin-bottom:14px">${icon("alert")}<div>${warning} <a href="#/settings/general" style="color:var(--blue-3)">Set the panel URL →</a></div></div>` : ""}<ol class="small" style="margin:0 0 14px;padding-left:18px;color:var(--text-2);line-height:1.8">
      <li>SSH into the new server as root (Ubuntu 22.04/24.04 or Debian 12).</li>
      <li>Paste this one line. It installs Node if needed and starts the agent as a systemd service.</li>
      <li>The agent dials out to this panel — no inbound ports needed besides the site ports.</li></ol>
    ${secretBox(cmd, { big: true })}
    <p class="hint mt-12">${icon("lock", "xs")} The command contains this server's secret token and is shown once. Rotate the token if it leaks.</p>`;
}

async function serverForm(s) {
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
      ${isEdit && s.role !== "main" ? html`<div class="field span-2"><label class="switch"><input type="checkbox" name="enabled" ${s?.enabled !== false ? raw("checked") : ""}/><span class="track"></span><span><b style="color:var(--text)">Enabled</b> — when off, nginx stops sending traffic here and no new sites can be placed on it</span></label></div>` : ""}
      <div class="error-box span-2" data-err hidden></div><button type="submit" hidden></button></form>`,
    foot: html`<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-ok>${isEdit ? "Save changes" : html`${icon("plus")}Add server`}</button>`,
    onMount(el, close) {
      const form = $("form", el), btn = $("[data-ok]", el), err = $("[data-err]", el);
      const go = async (e) => {
        e?.preventDefault();
        const f = form.elements;
        const body = { name: f.name.value.trim(), host: f.host.value.trim(), privateHost: f.privateHost.value.trim() || null, weight: Math.max(1, Number(f.weight.value) || 1), lbEligible: f.lbEligible.checked };
        if (f.enabled) body.enabled = f.enabled.checked;
        if (!body.name) { f.name.classList.add("invalid"); f.name.focus(); return; }
        if (!body.host) { f.host.classList.add("invalid"); f.host.focus(); return; }
        btn.classList.add("loading"); err.hidden = true;
        try {
          if (isEdit) { result = await patch(`/api/servers/${s.id}`, body); close(result); return; }
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

function serverCard(s) {
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
    </div>
    <div class="srv-meters">
      ${meter("CPU", m.cpu, m.cpu != null ? `${Math.round(m.cpu)}%` : "—")}
      ${meter("RAM", pct(m.mem, memT), memT ? fmtUsage(m.mem, memT) : "—")}
      ${meter("Disk", pct(m.disk, diskT), diskT ? fmtUsage(m.disk, diskT) : "—")}
    </div>
    <div class="srv-spark" data-spark="${s.id}"><div class="skel" style="height:100%"></div></div>
    <div class="ecard-foot" style="justify-content:space-between;padding-top:12px;border-top:1px solid var(--line)">
      <span class="muted small row" style="gap:6px">${icon("globe", "xs")}${plural(s.siteCount || 0, "site")}</span>
      <span class="muted small">weight ${s.weight ?? 1}</span>
      <span class="muted small">${s.info?.os || (s.agentVersion ? "agent " + s.agentVersion : "")}</span>
    </div>
  </div>`;
}

export default async function servers(ctx) {
  const { root } = ctx;
  ctx.crumbs([{ label: "Servers" }]);
  mount(root, html`${pageHead("Servers & load balancing", "The main server runs the panel, nginx and MySQL. Agent servers host websites — on their own or as part of a load-balanced pool.", html`<button class="btn btn-primary" data-add>${icon("plus")}Add server</button>`)}
    <div data-lb></div>
    <div class="section-head mt-24"><div><h2>Servers</h2><p data-sum>Loading…</p></div></div>
    <div data-list><div class="cards">${[1, 2, 3].map(() => html`<div class="skel" style="height:290px;border-radius:18px"></div>`)}</div></div>`);
  const list = $("[data-list]", root), lbBox = $("[data-lb]", root);
  let items = [], lb = null;
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
    $("[data-sum]", root).textContent = `${on_} of ${items.length} online · ${items.filter((s) => s.lbEligible !== false).length} available for load balancing`;
    mount(list, items.length ? html`<div class="cards">${items.map(serverCard)}
      <button class="ecard" data-add style="align-items:center;justify-content:center;gap:10px;border-style:dashed;cursor:pointer;min-height:240px;color:var(--muted);font:inherit">
        <span class="e-ico" style="width:46px;height:46px;border-radius:14px;display:grid;place-items:center;background:rgba(74,114,255,.12);color:var(--blue-3)">${icon("plus")}</span>
        <b style="color:var(--text)">Add an agent server</b><span class="small" style="max-width:220px;text-align:center">One command on any Ubuntu or Debian box.</span></button></div>`
      : emptyState({ ico: "server", title: "No servers", text: "The main server should always appear here." }));
    items.forEach((s) => (sparks[s.id] ? paintSpark(s.id) : loadSpark(s.id)));
  };
  const load = async () => {
    try {
      const [s, l] = await Promise.all([get("/api/servers"), get("/api/loadbalancer").catch(() => null)]);
      items = s.items || []; lb = l;
      if (!ctx.alive()) return;
      paintLb(); paint();
    } catch (e) { if (ctx.alive()) { mount(list, errorState(e)); $("[data-retry]", list)?.addEventListener("click", load); } }
  };
  await load();

  on(root, "click", "[data-add]", async () => { if (await serverForm()) load(); });
  on(root, "click", "[data-apply]", async (e, b) => {
    b.classList.add("loading");
    try { jobStarted(await post("/api/loadbalancer/apply"), "Re-applying load balancer"); } catch (ex) { toastError(ex, "Couldn't apply"); } finally { b.classList.remove("loading"); }
  });
  on(root, "click", "[data-smenu]", (e, b) => {
    const s = items.find((x) => x.id === b.dataset.smenu); if (!s) return;
    openMenu(b, [
      { label: "Edit server", icon: "edit", onClick: async () => { if (await serverForm(s)) { toast("Server updated", "ok"); load(); } } },
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
    if (el) { el.replaceWith(frag(serverCard(items[i]))); paintSpark(d.id); }
  });
  ctx.on(["lb", "site"], debounce(async () => { lb = await get("/api/loadbalancer").catch(() => lb); if (ctx.alive()) paintLb(); }, 500));
}
