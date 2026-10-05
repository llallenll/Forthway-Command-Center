// Shared UI pieces used by several views.
import { html, raw, $, $$, on, frag, mount, ago, fmtDate, fmtBytes, fmtUsage, fmtDuration, pct, toneFor, initials, plural,
  toast, toastError, openModal, confirmDialog, openMenu, secretBox, emptyState, colorOf } from "./util.js";
import { icon } from "./icons.js";
import { api, get, post, patch, del, upload, getText, download } from "./api.js";
import { onEvent } from "./events.js";

/* ───────── badges & small markup ───────── */

export const TYPE_LABEL = { node: "Node.js", static: "Static", php: "PHP" };
export const METHOD_LABEL = { round_robin: "Round robin", least_conn: "Least connections", ip_hash: "IP hash" };
export const serverKind = (s) => (s?.role === "main" ? "Main" : "Agent server");

export function typeIco(type, cls = "") {
  return html`<span class="type-ico ${type || "node"} ${cls}" title="${TYPE_LABEL[type] || type}">${icon(type === "static" ? "static" : type === "php" ? "php" : "node")}</span>`;
}

/** The badge every website shows: LB vs single server. */
export function lbBadge(site, serversById = {}) {
  const ids = site.serverIds || [];
  if (site.loadBalanced) {
    const n = site.lb?.servers ?? ids.length;
    return html`<span class="badge badge-lb" title="${METHOD_LABEL[site.lbMethod] || ""}">${icon("balance")}Load balanced · ${n} server${n === 1 ? "" : "s"}</span>`;
  }
  const sid = ids[0] || "main";
  const name = serversById[sid]?.name || (sid === "main" ? "main" : sid);
  return html`<span class="badge badge-single">${icon("server")}Single server · ${name}</span>`;
}

export function siteHealth(site) {
  const ids = site.loadBalanced ? site.serverIds || [] : [(site.serverIds || [])[0] || "main"];
  const st = site.state || {};
  const deployed = site.currentReleaseId || ids.some((i) => st[i]?.releaseId || st[i]?.deployedAt);
  if (!deployed) return { tone: "off", text: "Not deployed" };
  // healthy === null means "no health check" (static sites, healthPath off) — running is enough then.
  const healthy = ids.filter((i) => st[i]?.running && st[i]?.healthy !== false).length;
  const running = ids.filter((i) => st[i]?.running).length;
  const offline = ids.filter((i) => st[i]?.online === false).length;
  if (!running) return offline === ids.length ? { tone: "err", text: ids.length > 1 ? "Servers offline" : "Server offline" } : { tone: "off", text: "Stopped" };
  if (healthy === ids.length) return { tone: "ok", text: ids.length > 1 ? `${healthy}/${ids.length} healthy` : "Healthy" };
  if (healthy === 0) return { tone: "err", text: ids.length > 1 ? `0/${ids.length} healthy` : "Unhealthy" };
  return { tone: "warn", text: `${healthy}/${ids.length} healthy` };
}
export function healthChip(site) {
  const h = siteHealth(site);
  return html`<span class="status"><span class="dot ${h.tone}"></span>${h.text}</span>`;
}

export function jobStatusBadge(status) {
  const map = { succeeded: ["ok", "Succeeded"], failed: ["err", "Failed"], running: ["blue", "Running"], queued: ["", "Queued"], cancelled: ["", "Cancelled"] };
  const [cls, t] = map[status] || ["", status];
  return html`<span class="badge ${cls}">${status === "running" ? html`<span class="dot run" style="width:6px;height:6px"></span>` : ""}${t}</span>`;
}
const JOB_ICON = { "site.deploy": "rocket", "site.restart": "restart", "site.stop": "stop", "site.start": "play", "site.rollback": "rollback", "site.ssl": "lock", "release.github": "github",
  "backup.database": "archive", "backup.server": "hardDrive", "backup.restore": "history", "database.import": "upload", "lb.apply": "balance" };

export function jobItem(j) {
  const dur = j.finishedAt && j.startedAt ? fmtDuration(new Date(j.finishedAt) - new Date(j.startedAt)) : null;
  const ico = j.status === "running" || j.status === "queued" ? "refresh" : j.status === "failed" ? "x" : j.status === "cancelled" ? "stop" : JOB_ICON[j.type] || "check";
  return html`<div class="list-item clickable" data-job="${j.id}">
    <span class="job-ico ${j.status}">${icon(ico, "sm")}</span>
    <div class="li-main"><div class="li-title">${j.title || j.type}</div>
      <div class="li-sub">${j.status === "failed" && j.error ? j.error : html`${ago(j.startedAt)}${dur ? html` · ${dur}` : ""}`}</div></div>
    <div class="li-right">${jobStatusBadge(j.status)}</div></div>`;
}

const ACT_VERB = {
  "site.deploy": "deployed", "site.update": "updated", "site.create": "created website", "site.delete": "deleted website", "site.restart": "restarted", "site.stop": "stopped",
  "site.start": "started", "site.rollback": "rolled back", "site.ssl": "requested a certificate for", "site.env": "edited environment of", "release.upload": "uploaded a release to",
  "database.create": "created database", "database.delete": "deleted database", "database.credentials": "revealed credentials for", "database.password": "rotated the password of",
  "database.import": "imported into", "backup.create": "backed up", "backup.restore": "restored", "backup.settings": "changed", "server.add": "added server", "server.update": "updated server",
  "server.remove": "removed server", "server.token": "rotated the token of", "lb.apply": "re-applied", "project.create": "created project", "project.update": "updated project",
  "project.delete": "deleted project", "admin.login": "signed in", "admin.create": "added admin", "admin.delete": "removed admin", "admin.update": "updated", "settings.update": "updated",
  "admin.logout": "signed out", "admin.password": "changed the password of", "setup.complete": "set up", "server.create": "added server", "server.delete": "removed server",
  "server.token.rotate": "rotated the token of", "database.credentials.reveal": "revealed credentials for", "database.password.rotate": "rotated the password of",
  "database.update": "updated database", "mysql.root.update": "updated the MySQL root login", "backup.database": "backed up", "backup.server": "backed up server",
  "backup.delete": "deleted a backup of", "backup.download": "downloaded a backup of", "backup.restore.start": "started restoring", "backup.update": "updated a backup of",
  "release.delete": "deleted a release of", "release.github": "pulled a release for", "job.cancel": "cancelled",
};
const ACT_ICON = { site: "globe", database: "database", server: "server", project: "folder", admin: "user", lb: "balance", loadbalancer: "balance", settings: "settings", backup: "archive" };
export function targetHref(t) {
  if (t?.type === "lb" || t?.type === "loadbalancer") return "#/settings/loadbalancer";
  if (t?.type === "settings") return "#/settings";
  if (!t?.id) return null;
  return { site: `#/sites/${t.id}`, database: "#/databases", server: "#/servers", project: `#/projects/${t.id}`, admin: "#/settings/admins", backup: "#/backups", release: null }[t.type] || null;
}
export function detailsText(d) {
  if (d == null || d === "") return "";
  if (typeof d !== "object") return String(d);
  if (d.message || d.summary || d.note) return String(d.message || d.summary || d.note);
  return Object.entries(d).filter(([k, v]) => v != null && typeof v !== "object" && !/id$|Id$/.test(k)).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(" · ");
}
export function activityItem(a, { compact = false } = {}) {
  const verb = ACT_VERB[a.action] || a.action;
  const href = targetHref(a.target);
  const tname = a.action === "admin.login" ? "" : a.target?.name || "";
  return html`<div class="list-item">
    <span class="avatar" style="width:32px;height:32px;border-radius:10px">${initials(a.adminName)}</span>
    <div class="li-main"><div class="li-title" style="font-weight:500;color:var(--text-2)"><b style="color:var(--text);font-weight:650">${a.adminName || "System"}</b> ${verb} ${href && tname ? html`<a href="${href}" style="color:var(--text);font-weight:600">${tname}</a>` : html`<b style="color:var(--text);font-weight:600">${tname}</b>`}</div>
      <div class="li-sub">${detailsText(a.details) ? html`${detailsText(a.details)} · ` : ""}${ago(a.at || a.createdAt)}</div></div>
    ${compact ? "" : html`<div class="li-right"><span class="badge">${icon(ACT_ICON[a.target?.type] || "activity")}${a.target?.type || "event"}</span><span class="hide-sm">${fmtDate(a.at || a.createdAt)}</span></div>`}</div>`;
}

/* ───────── job log viewer (SSE streamed, read-only) ───────── */

export function bindJobClicks(root) {
  return on(root, "click", "[data-job]", (e, el) => openJobLog(el.dataset.job));
}

function logLineHTML(l) {
  const cls = /✗|ERROR|error:|failed/i.test(l) ? "err" : /✓/.test(l) ? "ok" : /▸|━━|^\s*──/.test(l) ? "step" : "";
  return html`<div class="log-line ${cls}">${l}</div>`;
}

export async function openJobLog(jobId) {
  let job = null;
  const buffered = [];
  let ready = false;
  const m = openModal({
    title: "Job log", ico: "fileText", size: "xl",
    body: html`<div class="row wrap" data-meta style="margin-bottom:12px"><div class="skel" style="width:240px;height:22px"></div></div>
      <pre class="code wrap" data-log style="min-height:320px;max-height:60vh"><span class="muted">Loading…</span></pre>`,
    foot: html`<label class="check left"><input type="checkbox" data-follow checked/>Follow output</label>
      <button class="btn btn-danger" data-cancel hidden>${icon("stop")}Cancel job</button>
      <button class="btn" data-close>Close</button>`,
  });
  const el = m.el;
  const pre = $("[data-log]", el), meta = $("[data-meta]", el), follow = $("[data-follow]", el), cancelBtn = $("[data-cancel]", el);
  const paintMeta = () => {
    if (!job) return;
    $(".modal-head h3", el).textContent = job.title || "Job log";
    const dur = job.startedAt ? fmtDuration((job.finishedAt ? new Date(job.finishedAt) : new Date()) - new Date(job.startedAt)) : "";
    mount(meta, html`${jobStatusBadge(job.status)}<span class="muted small">${job.type}</span><span class="dim small">·</span><span class="muted small">Started ${fmtDate(job.startedAt)}${dur ? html` · ${dur}` : ""}</span>
      ${job.error ? html`<div class="error-box" style="width:100%;margin-top:8px">${icon("alert")}<div>${job.error}</div></div>` : ""}`);
    cancelBtn.hidden = !(job.status === "running" || job.status === "queued");
  };
  const append = (lines) => {
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
    pre.insertAdjacentHTML("beforeend", lines.map(logLineHTML).join(""));
    if (follow.checked || atBottom) pre.scrollTop = pre.scrollHeight;
  };
  const offLog = onEvent("job.log", (d) => {
    if (d?.id !== jobId) return;
    if (!ready) buffered.push(...(d.lines || [])); else append(d.lines || []);
  });
  const offJob = onEvent("job", (d) => { if (d?.id === jobId) { job = d; paintMeta(); } });
  const tick = setInterval(paintMeta, 1000);
  m.result.then(() => { offLog(); offJob(); clearInterval(tick); });
  cancelBtn.onclick = async () => {
    cancelBtn.classList.add("loading");
    try { job = await post(`/api/jobs/${jobId}/cancel`); paintMeta(); toast("Job cancelled", "ok"); } catch (e) { toastError(e); } finally { cancelBtn.classList.remove("loading"); }
  };
  try {
    const [j, text] = await Promise.all([get(`/api/jobs/${jobId}`), getText(`/api/jobs/${jobId}/log`)]);
    job = j; paintMeta();
    const lines = text ? text.replace(/\n$/, "").split("\n") : [];
    pre.innerHTML = "";
    if (!lines.length && !buffered.length) pre.innerHTML = `<span class="muted">${job.status === "queued" ? "Waiting to start…" : "No output yet."}</span>`;
    const seen = new Set(lines);
    append([...lines, ...buffered.filter((l) => !seen.has(l))]);
    ready = true;
  } catch (e) {
    mount(pre, html`<span class="log-line err">Couldn't load the log: ${e.message}</span>`);
  }
}

/** Toast for a started job, with a link to its log. */
export function jobStarted(job, title) {
  if (!job?.id) { toast(title || "Done", "ok"); return; }
  toast(title || job.title || "Job started", "info", { msg: "Running in the background.", action: { label: "View log →", fn: () => openJobLog(job.id) } });
}

/* ───────── usage bars + server picker ───────── */

export function ubar(label, used, total) {
  const p = pct(used, total);
  return html`<div class="ubar"><span class="u-l">${label}</span><div class="u-track"><div class="u-fill ${total ? toneFor(p) : ""}" style="width:${p.toFixed(1)}%"></div></div><span class="u-t">${total ? fmtUsage(used, total) : "—"}</span></div>`;
}

/**
 * Server picker cards. mode "single" = radio, "multi" = checkbox (lbEligible only, min 2).
 * Returns { get(), set(ids), el }.
 */
export function serverPicker(container, { servers, mode = "single", selected = [], onChange } = {}) {
  let sel = new Set(selected);
  const list = () => (mode === "multi" ? servers.filter((s) => s.lbEligible !== false && s.enabled !== false) : servers.filter((s) => s.enabled !== false));
  function render() {
    const items = list();
    if (!items.length) {
      mount(container, emptyState({ ico: "server", title: mode === "multi" ? "No servers available for load balancing" : "No servers", sm: true,
        text: mode === "multi" ? "Mark at least two servers as “Available for load balancing” in Settings → Servers." : "Add a server in Settings → Servers.", action: html`<a class="btn btn-sm" href="#/servers">${icon("server")}Manage servers</a>` }));
      return;
    }
    const offSel = items.filter((s) => sel.has(s.id) && !s.online);
    mount(container, html`<div class="server-pick-grid">${items.map((s) => {
      const m = s.metrics || {};
      const on = sel.has(s.id);
      return html`<label class="choice spick ${mode === "multi" ? "checkbox" : ""} ${on ? "selected" : ""} ${s.online ? "" : "offline"}" data-sid="${s.id}">
        <input type="${mode === "multi" ? "checkbox" : "radio"}" name="srvpick" value="${s.id}" ${on ? raw("checked") : ""}/>
        <span class="c-mark"></span>
        <div class="sp-head"><span class="dot ${s.online ? "ok" : "off"}"></span><span class="sp-name">${s.name}</span></div>
        <div class="sp-sub"><span class="badge ${s.role === "main" ? "blue" : ""}" style="height:20px;font-size:11px">${serverKind(s)}</span>
          ${s.online ? "" : html`<span class="badge warn" style="height:20px;font-size:11px">offline</span>`}
          <span class="sp-host">${s.host || ""}</span></div>
        <div class="sp-sub">${icon("globe", "xs")}${plural(s.siteCount || 0, "site")}${m.cpu != null ? html` · CPU ${Math.round(m.cpu)}%` : ""}</div>
        <div class="sp-bars">${ubar("RAM", m.mem, m.memTotal || s.info?.memTotal)}${ubar("Disk", m.disk, m.diskTotal || s.info?.diskTotal)}</div>
      </label>`;
    })}</div>
    ${mode === "multi" && sel.size < 2 ? html`<div class="note mt-12">${icon("info")}<div>Pick at least <b>2 servers</b> — traffic is spread across every server you select.</div></div>` : ""}
    ${offSel.length ? html`<div class="note warn mt-12">${icon("alert")}<div><b>${offSel.map((s) => s.name).join(", ")}</b> ${offSel.length > 1 ? "are" : "is"} offline right now. You can still pick ${offSel.length > 1 ? "them" : "it"}, but deploys won't reach ${offSel.length > 1 ? "them" : "it"} until the agent reconnects.</div></div>` : ""}`);
  }
  container.addEventListener("change", (e) => {
    const inp = e.target.closest("input[name=srvpick]");
    if (!inp) return;
    if (mode === "multi") { inp.checked ? sel.add(inp.value) : sel.delete(inp.value); }
    else sel = new Set([inp.value]);
    render();
    onChange?.([...sel]);
  });
  render();
  return { get: () => [...sel].filter((id) => list().some((s) => s.id === id)), set(ids) { sel = new Set(ids); render(); }, setMode(mo) { mode = mo; render(); }, el: container };
}

/* ───────── env editor ───────── */

export function envEditor(container, env = {}, { onDirty } = {}) {
  let rows = Object.entries(env || {}).map(([k, v]) => ({ k, v: String(v ?? "") }));
  let reveal = false;
  function render() {
    mount(container, html`<div class="env-table">
      ${rows.length ? "" : html`<div class="muted small" style="padding:6px 0 4px">No variables yet.</div>`}
      ${rows.map((r, i) => html`<div class="env-row" data-i="${i}">
        <input class="input" data-k placeholder="KEY" value="${r.k}" spellcheck="false" autocomplete="off"/>
        <input class="input" data-v placeholder="value" value="${r.v}" spellcheck="false" autocomplete="off" style="${reveal ? "" : "-webkit-text-security:disc"}"/>
        <button class="icon-btn ghost" data-rm aria-label="Remove">${icon("trash", "sm")}</button></div>`)}
      </div>
      <div class="btn-row mt-12"><button class="btn btn-sm" data-add type="button">${icon("plus")}Add variable</button>
        <button class="btn btn-sm btn-ghost" data-paste type="button">${icon("fileText")}Paste .env</button>
        <span class="spacer"></span>
        <button class="btn btn-sm btn-ghost" data-reveal type="button">${icon(reveal ? "eyeOff" : "eye")}${reveal ? "Hide values" : "Show values"}</button></div>`);
  }
  container.addEventListener("input", (e) => {
    const row = e.target.closest(".env-row"); if (!row) return;
    const r = rows[+row.dataset.i];
    if (e.target.matches("[data-k]")) r.k = e.target.value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    if (e.target.matches("[data-v]")) r.v = e.target.value;
    onDirty?.();
  });
  container.addEventListener("change", (e) => { if (e.target.matches("[data-k]")) render(); });
  container.addEventListener("click", (e) => {
    if (e.target.closest("[data-add]")) { rows.push({ k: "", v: "" }); render(); $$(".env-row [data-k]", container).pop()?.focus(); onDirty?.(); }
    else if (e.target.closest("[data-rm]")) { rows.splice(+e.target.closest(".env-row").dataset.i, 1); render(); onDirty?.(); }
    else if (e.target.closest("[data-reveal]")) { reveal = !reveal; render(); }
    else if (e.target.closest("[data-paste]")) {
      const mm = openModal({ title: "Paste .env", sub: "KEY=value lines. Existing keys are overwritten.", ico: "fileText", size: "lg",
        body: html`<textarea class="textarea mono" style="min-height:220px" placeholder="NODE_ENV=production&#10;API_URL=https://…"></textarea>`,
        foot: html`<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-ok>Import</button>`,
        onMount(el, close) {
          $("[data-ok]", el).onclick = () => {
            const txt = $("textarea", el).value;
            for (const line of txt.split(/\r?\n/)) {
              const mt = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
              if (!mt) continue;
              let v = mt[2]; if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
              const ex = rows.find((r) => r.k === mt[1]);
              ex ? (ex.v = v) : rows.push({ k: mt[1], v });
            }
            close(true); render(); onDirty?.();
          };
        } });
      void mm;
    }
  });
  render();
  return {
    get() {
      const out = {};
      for (const r of rows) if (r.k) out[r.k] = r.v;
      return out;
    },
    validate() {
      const keys = rows.filter((r) => r.k).map((r) => r.k);
      const dup = keys.find((k, i) => keys.indexOf(k) !== i);
      return dup ? `Duplicate key ${dup}` : null;
    },
    set(env) { rows = Object.entries(env || {}).map(([k, v]) => ({ k, v: String(v ?? "") })); render(); },
  };
}

/* ───────── dropzone ───────── */

export function dropzone(el, { accept = "", onFile, title = "Drop a file here", hint = "or click to browse" }) {
  mount(el, html`<div class="dropzone" tabindex="0" role="button"><div class="dz-ico">${icon("upload", "lg")}</div><b>${title}</b><span>${hint}</span>
    <input type="file" accept="${accept}" hidden/></div>`);
  const dz = $(".dropzone", el), inp = $("input", el);
  dz.onclick = () => inp.click();
  dz.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inp.click(); } };
  inp.onchange = () => { if (inp.files[0]) onFile(inp.files[0]); inp.value = ""; };
  ["dragenter", "dragover"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); });
}

/* ───────── databases ───────── */

export function connectionDetails(c) {
  return html`<div class="form-stack">
    <div class="grid-2" style="gap:12px">
      <div class="field"><label>Host</label>${secretBox(`${c.host}:${c.port}`)}</div>
      <div class="field"><label>Database</label>${secretBox(c.name)}</div>
      <div class="field"><label>User</label>${secretBox(c.user)}</div>
      <div class="field"><label>Password</label>${secretBox(c.password)}</div>
    </div>
    ${c.url ? html`<div class="field"><label>Connection URL</label>${secretBox(c.url, { big: true })}</div>` : ""}
  </div>`;
}

function dbConn(d, password) {
  const host = d.host || "127.0.0.1", port = d.port || 3306;
  return { host, port, name: d.name, user: d.user, password, url: `mysql://${d.user}:${encodeURIComponent(password || "")}@${host}:${port}/${d.name}` };
}

export async function createDatabase({ projects, projectId } = {}) {
  const projOpts = (projects || []).map((p) => ({ value: p.id, label: p.name }));
  let created = null;
  const m = openModal({
    title: "New database", sub: "MySQL database with its own user. The password is shown once.", ico: "database",
    body: html`<form class="form-stack" novalidate>
      ${projectId ? "" : html`<div class="field"><label>Project</label><select class="select" name="projectId">${projOpts.map((o) => html`<option value="${o.value}">${o.label}</option>`)}</select></div>`}
      <div class="field"><label>Database name</label><input class="input mono" name="name" placeholder="prod" autocomplete="off" spellcheck="false"/><div class="hint">Lowercase letters, numbers and underscores. The project prefix is added automatically (e.g. <span class="mono">acme_prod</span>).</div></div>
      <div class="grid-2" style="gap:14px">
        <div class="field"><label>User <span class="dim">(optional)</span></label><input class="input mono" name="user" placeholder="same as name" autocomplete="off"/></div>
        <div class="field"><label>Charset</label><select class="select" name="charset"><option value="utf8mb4">utf8mb4</option><option value="utf8mb3">utf8mb3</option><option value="latin1">latin1</option><option value="ascii">ascii</option></select></div>
      </div>
      <div class="field"><label>Password <span class="dim">(optional)</span></label><input class="input mono" name="password" placeholder="Leave blank to generate a strong one" autocomplete="new-password"/></div>
      <label class="switch"><input type="checkbox" name="remoteAccess" checked/><span class="track"></span>Allow agent servers to connect</label>
      <div class="hint" style="margin-top:-8px">Needed when a website using this database runs on an agent server.</div>
      <div class="error-box" data-err hidden></div><button type="submit" hidden></button>
    </form>`,
    foot: html`<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-ok>${icon("plus")}Create database</button>`,
    onMount(el, close) {
      const form = $("form", el), btn = $("[data-ok]", el), errBox = $("[data-err]", el);
      const go = async (e) => {
        e?.preventDefault();
        const f = form.elements;
        const pid = projectId || f.projectId.value;
        const body = { name: f.name.value.trim(), user: f.user.value.trim() || undefined, password: f.password.value || undefined, charset: f.charset.value, remoteAccess: f.remoteAccess.checked };
        if (!body.name) { f.name.classList.add("invalid"); f.name.focus(); return; }
        btn.classList.add("loading"); errBox.hidden = true;
        try {
          const r = await post(`/api/projects/${pid}/databases`, body);
          created = r.database;
          mount($(".modal-body", el), html`<div class="note" style="margin-bottom:16px">${icon("check")}<div><b>${r.database.name}</b> is ready. Copy the password now — it won't be shown again. You can rotate it later.</div></div>
            ${connectionDetails(dbConn(r.database, r.password))}`);
          mount($(".modal-foot", el), html`<button class="btn btn-primary" data-close>Done</button>`);
          $(".modal-head h3", el).textContent = "Database created";
        } catch (ex) { errBox.hidden = false; errBox.textContent = ex.message; }
        finally { btn.classList.remove("loading"); }
      };
      form.addEventListener("submit", go);
      btn.onclick = go;
    },
  });
  await m.result;
  return created;
}

export async function revealCredentials(d) {
  const ok = await confirmDialog({ title: `Reveal credentials for ${d.name}?`, message: "The password will be shown on screen. This is recorded in the activity log.", confirmText: "Reveal", ico: "eye" });
  if (!ok) return;
  try {
    const c = await post(`/api/databases/${d.id}/credentials`);
    openModal({ title: `${d.name} credentials`, sub: "Host is for apps on the main server.", ico: "key", size: "lg",
      body: html`${connectionDetails(c)}${c.remoteHost ? html`<div class="note mt-16">${icon("server")}<div>Apps on agent servers connect to <span class="mono">${c.remoteHost}:${c.port}</span> — linked websites get this automatically.</div></div>` : ""}`,
      foot: html`<button class="btn btn-primary" data-close>Done</button>` });
  } catch (e) { toastError(e, "Couldn't reveal credentials"); }
}

export async function rotatePassword(d) {
  const sites = d.linkedSites || [];
  const ok = await confirmDialog({ title: `Rotate password for ${d.name}?`, ico: "key", confirmText: "Rotate password",
    message: sites.length ? `A new password is generated and written to the environment of ${sites.map((s) => s.name).join(", ")}. Those websites are restarted to pick it up.` : "A new password is generated. Anything using the old one stops working." });
  if (!ok) return;
  try {
    const r = await post(`/api/databases/${d.id}/password`, {});
    const n = (r.jobs || []).length || (r.sites || []).length;
    openModal({ title: "New password", ico: "key",
      body: html`<div class="note warn" style="margin-bottom:14px">${icon("alert")}<div>Copy it now — <b>it won't be shown again</b>. You can rotate it again any time.</div></div>${secretBox(r.password)}
        ${n ? html`<p class="hint mt-12">Updating the environment of ${plural(n, "linked website")} in the background.</p>` : ""}`,
      foot: html`<button class="btn btn-primary" data-close>Done</button>` });
  } catch (e) { toastError(e, "Couldn't rotate the password"); }
}

export async function importSql(d) {
  const m = openModal({ title: `Import into ${d.name}`, sub: "Upload a .sql or .sql.gz dump. It runs against the existing database.", ico: "upload", size: "lg",
    body: html`<div data-dz></div><div data-prog hidden class="mt-16"><div class="row small" style="justify-content:space-between;margin-bottom:8px"><span data-fname class="strong"></span><span data-pct class="muted num">0%</span></div><div class="progress"><div style="width:0%"></div></div></div>
      <div class="note warn mt-16">${icon("alert")}<div>Statements in the dump can overwrite or drop tables. Take a backup first if you're unsure.</div></div>`,
    foot: html`<button class="btn btn-ghost" data-close>Cancel</button>`,
    onMount(el, close) {
      dropzone($("[data-dz]", el), { accept: ".sql,.gz,.sql.gz", title: "Drop a .sql or .sql.gz file", hint: "or click to browse", async onFile(file) {
        if (!/\.(sql|sql\.gz|gz)$/i.test(file.name)) { toast("That doesn't look like a SQL dump", "warn", { msg: "Use a .sql or .sql.gz file." }); return; }
        $("[data-prog]", el).hidden = false; $("[data-fname]", el).textContent = file.name; $("[data-dz]", el).hidden = true;
        try {
          const job = await upload(`/api/databases/${d.id}/import?filename=${encodeURIComponent(file.name)}`, file, (p) => {
            $(".progress > div", el).style.width = (p * 100).toFixed(0) + "%"; $("[data-pct]", el).textContent = (p * 100).toFixed(0) + "%";
          });
          close(true);
          jobStarted(job, `Importing ${file.name}`);
          if (job?.id) openJobLog(job.id);
        } catch (e) { toastError(e, "Import failed"); $("[data-dz]", el).hidden = false; $("[data-prog]", el).hidden = true; }
      } });
    } });
  return m.result;
}

export async function backupDatabaseNow(d) {
  try { const job = await post(`/api/databases/${d.id}/backups`); jobStarted(job, `Backing up ${d.name}`); } catch (e) { toastError(e, "Couldn't start the backup"); }
}

export async function deleteDatabase(d) {
  const r = await confirmDialog({ title: `Delete ${d.name}?`, danger: true, typed: d.name, confirmText: "Delete database",
    message: "The database, its user and all its data are dropped.",
    extra: html`<label class="check mt-16"><input type="checkbox" data-extra name="deleteBackups"/>Also delete its backups (kept by default)</label>` });
  if (!r) return false;
  const q = r.deleteBackups ? "&deleteBackups=1" : "";
  try { await del(`/api/databases/${d.id}?${q.slice(1)}`); toast(`${d.name} deleted`, "ok"); return true; }
  catch (e) {
    const sites = e?.body?.sites;
    if (e?.status === 409 && Array.isArray(sites)) {
      const force = await confirmDialog({ title: `${d.name} is still in use`, ico: "link", danger: true, confirmText: "Delete anyway (unlink)",
        message: "These websites are linked to it. Deleting unlinks them — their DB_* variables disappear on the next restart and they will likely break.",
        extra: html`<div class="chips mt-12">${sites.map((x) => html`<a class="badge" href="#/sites/${x.id}">${icon("globe")}${x.name || x.id}</a>`)}</div>` });
      if (!force) return false;
      try { await del(`/api/databases/${d.id}?force=1${q}`); toast(`${d.name} deleted`, "ok", { msg: `Unlinked from ${plural(sites.length, "website")}.` }); return true; }
      catch (e2) { toastError(e2, "Couldn't delete the database"); return false; }
    }
    toastError(e, "Couldn't delete the database"); return false;
  }
}

export async function toggleRemoteAccess(d) {
  try { await patch(`/api/databases/${d.id}`, { remoteAccess: !d.remoteAccess }); toast(d.remoteAccess ? "Agent servers can no longer connect" : "Agent servers can now connect", "ok"); return true; }
  catch (e) { toastError(e, "Couldn't change remote access"); return false; }
}

export function dbMenu(anchor, d, after) {
  openMenu(anchor, [
    { label: "Reveal credentials", icon: "eye", onClick: () => revealCredentials(d) },
    { label: "Rotate password", icon: "key", onClick: () => rotatePassword(d).then(after) },
    { label: "Import .sql / .sql.gz", icon: "upload", onClick: () => importSql(d) },
    { label: "Back up now", icon: "archive", onClick: () => backupDatabaseNow(d) },
    { label: "View backups", icon: "history", onClick: () => (location.hash = `#/backups/database?databaseId=${d.id}`) },
    { label: d.remoteAccess ? "Block agent servers" : "Allow agent servers", icon: "server", onClick: () => toggleRemoteAccess(d).then((x) => x && after?.()) },
    { sep: true },
    { label: "Delete database", icon: "trash", danger: true, onClick: () => deleteDatabase(d).then((x) => x && after?.()) },
  ]);
}

export function databasesTable(items, { projectsById = {}, showProject = true, mysql = null } = {}) {
  const bindLocal = mysql && /^(127\.|localhost|::1)/.test(mysql.bindAddress || "");
  return html`<div class="card"><div class="table-wrap"><table class="table">
    <thead><tr><th>Database</th>${showProject ? html`<th class="hide-sm">Project</th>` : ""}<th class="hide-sm">User</th><th>Size</th><th class="hide-sm">Last backup</th><th class="hide-sm">Used by</th><th></th></tr></thead>
    <tbody>${items.map((d) => {
      const p = projectsById[d.projectId];
      return html`<tr>
        <td><div class="row"><span class="li-ico" style="width:32px;height:32px;border-radius:10px;display:grid;place-items:center;background:rgba(51,212,193,.1);color:#5fe0cf">${icon("database", "sm")}</span>
          <div><div class="t-main mono">${d.name}</div><div class="t-sub">${d.charset || "utf8mb4"}${d.remoteAccess ? " · agent access" : ""}</div>
          ${d.remoteAccess && bindLocal ? html`<span class="badge warn mt-8" title="MySQL listens on ${mysql.bindAddress} only, so agent servers can't reach it.">${icon("alert")}Agents can't connect</span>` : ""}</div></div></td>
        ${showProject ? html`<td class="hide-sm">${p ? html`<a href="#/projects/${p.id}" class="row" style="gap:8px"><span class="dot" style="background:${colorOf(p.color)}"></span>${p.name}</a>` : html`<span class="dim">—</span>`}</td>` : ""}
        <td class="hide-sm mono small">${d.user}</td>
        <td class="num">${fmtBytes(d.sizeBytes)}</td>
        <td class="hide-sm">${d.lastBackup ? html`<span class="status"><span class="dot ok"></span>${ago(d.lastBackup.createdAt)}</span>` : html`<span class="status"><span class="dot warn"></span>Never</span>`}</td>
        <td class="hide-sm">${(d.linkedSites || []).length ? html`<div class="chips">${d.linkedSites.slice(0, 2).map((s) => html`<a class="badge" href="#/sites/${s.id}">${icon("globe")}${s.name}</a>`)}${d.linkedSites.length > 2 ? html`<span class="badge">+${d.linkedSites.length - 2}</span>` : ""}</div>` : html`<span class="dim small">Not linked</span>`}</td>
        <td class="actions"><div class="btn-row"><button class="btn btn-sm hide-sm" data-db-creds="${d.id}">${icon("eye")}Credentials</button><button class="icon-btn sm" data-db-menu="${d.id}" aria-label="More actions">${icon("more")}</button></div></td>
      </tr>`;
    })}</tbody></table></div></div>`;
}

/* ───────── backups ───────── */

export function backupsTable(items, { serversById = {}, dbsById = {}, kind } = {}) {
  return html`<div class="card"><div class="table-wrap"><table class="table">
    <thead><tr><th>${kind === "server" ? "Server backup" : "Backup"}</th><th>Status</th><th>Size</th><th class="hide-sm">Trigger</th><th class="hide-sm">Created</th><th></th></tr></thead>
    <tbody>${items.map((b) => {
      const src = b.kind === "database" ? dbsById[b.databaseId]?.name || b.databaseName || "deleted database" : serversById[b.serverId]?.name || b.serverName || b.serverId;
      const inc = b.include ? Object.entries(b.include).filter(([, v]) => v).map(([k]) => k) : [];
      return html`<tr>
        <td><div class="row"><span class="li-ico" style="width:32px;height:32px;border-radius:10px;display:grid;place-items:center;background:rgba(74,114,255,.1);color:var(--blue-3)">${icon(b.kind === "server" ? "hardDrive" : "archive", "sm")}</span>
          <div style="min-width:0"><div class="t-main row" style="gap:8px">${src}${b.pinned ? html`<span class="badge violet" title="Pinned — never removed by retention">${icon("pin")}Pinned</span>` : ""}</div>
          <div class="t-sub mono ellipsis" style="max-width:340px">${b.filename || String(b.file || "").split("/").pop()}${inc.length ? html` · <span style="font-family:var(--font)">${inc.join(", ")}</span>` : ""}</div>${b.note ? html`<div class="t-sub">“${b.note}”</div>` : ""}</div></div></td>
        <td>${b.status === "ok" && b.available === false ? html`<span class="badge warn" title="The archive is no longer on disk">${icon("alert")}File missing</span>` : b.status === "ok" ? html`<span class="badge ok">${icon("check")}OK</span>` : b.status === "running" ? html`<span class="badge blue"><span class="dot run" style="width:6px;height:6px"></span>Running</span>` : html`<span class="badge err" title="${b.error || ""}">${icon("alert")}Failed</span>`}</td>
        <td class="num">${b.status === "ok" ? fmtBytes(b.size) : html`<span class="dim">—</span>`}</td>
        <td class="hide-sm"><span class="muted small">${b.trigger === "schedule" ? "Scheduled" : b.trigger === "safety" ? "Safety copy" : "Manual"}</span>${b.remote?.type === "s3" && !b.remote.error ? html`<div class="t-sub row" style="gap:5px">${icon("cloud", "xs")}Off-site</div>` : b.remote?.error ? html`<div class="t-sub" style="color:#ffc46b" title="${b.remote.error}">Upload failed</div>` : ""}</td>
        <td class="hide-sm"><div class="small">${fmtDate(b.createdAt)}</div><div class="t-sub">${ago(b.createdAt)}</div></td>
        <td class="actions"><div class="btn-row">
          <button class="icon-btn sm hide-sm" data-bk-dl="${b.id}" title="Download" ${b.status !== "ok" || b.available === false ? raw("disabled") : ""}>${icon("download")}</button>
          <button class="icon-btn sm" data-bk-menu="${b.id}" aria-label="More actions">${icon("more")}</button></div></td>
      </tr>`;
    })}</tbody></table></div></div>`;
}

export function bindBackupActions(root, getItems, { dbsById = () => ({}), serversById = () => ({}), refresh } = {}) {
  const byId = (id) => getItems().find((b) => b.id === id);
  const restore = async (b) => {
    const target = b.kind === "database" ? dbsById()[b.databaseId]?.name || b.databaseName : serversById()[b.serverId]?.name || b.serverName;
    const isDb = b.kind === "database";
    const r = await confirmDialog({ title: "Restore this backup?", danger: true, confirmText: "Restore", ico: "history", typed: isDb ? target : undefined,
      message: isDb ? `The current contents of ${target || "the database"} are replaced with this backup from ${fmtDate(b.createdAt)}. A safety backup is taken first.`
        : `Restores onto the main server from the archive of ${fmtDate(b.createdAt)}. Panel data and the bundled database dump are never restored here — download the archive for those.`,
      extra: isDb ? undefined : html`<div class="stack mt-16" style="gap:10px"><label class="check"><input type="checkbox" data-extra name="sites" checked/>Website files</label><label class="check"><input type="checkbox" data-extra name="nginx" checked/>nginx config (tested before reload)</label></div>` });
    if (!r) return;
    const body = isDb ? {} : { sites: !!r.sites, nginx: !!r.nginx };
    if (!isDb && !body.sites && !body.nginx) { toast("Nothing selected to restore", "warn"); return; }
    try { jobStarted(await post(`/api/backups/${b.id}/restore`, body), "Restore started"); } catch (e) { toastError(e, "Couldn't restore"); }
  };
  const dlUrl = (b) => (b?.downloadUrl ? b.downloadUrl : `/api/backups/${b.id}/download`);
  const editNote = async (b) => {
    const m = openModal({ title: "Backup note", ico: "edit", body: html`<input class="input" value="${b.note || ""}" placeholder="e.g. Before 2.0 migration" data-note/>`,
      foot: html`<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-ok>Save</button>`,
      onMount(el, close) { $("[data-ok]", el).onclick = async () => { try { await patch(`/api/backups/${b.id}`, { note: $("[data-note]", el).value.trim() }); close(true); refresh?.(); } catch (e) { toastError(e); } }; } });
    await m.result;
  };
  on(root, "click", "[data-bk-dl]", (e, el) => download(dlUrl(byId(el.dataset.bkDl) || { id: el.dataset.bkDl })));
  on(root, "click", "[data-bk-menu]", (e, el) => {
    const b = byId(el.dataset.bkMenu); if (!b) return;
    openMenu(el, [
      { label: "Download", icon: "download", disabled: b.status !== "ok", onClick: () => download(dlUrl(b)) },
      { label: "Restore…", icon: "history", disabled: b.status !== "ok" || (b.kind === "server" && b.serverId !== "main"), onClick: () => restore(b) },
      { label: b.pinned ? "Unpin" : "Pin (keep forever)", icon: "pin", onClick: async () => { try { await patch(`/api/backups/${b.id}`, { pinned: !b.pinned }); toast(b.pinned ? "Unpinned" : "Pinned — retention will keep it", "ok"); refresh?.(); } catch (e) { toastError(e); } } },
      { label: "Edit note", icon: "edit", onClick: () => editNote(b) },
      { sep: true },
      { label: "Delete", icon: "trash", danger: true, onClick: async () => {
        if (!(await confirmDialog({ title: "Delete this backup?", message: `${b.filename || b.file} is removed permanently${b.remote?.type === "s3" ? ", including its off-site copy" : ""}.`, danger: true, confirmText: "Delete backup" }))) return;
        try { await del(`/api/backups/${b.id}`); toast("Backup deleted", "ok"); refresh?.(); } catch (e) { toastError(e); }
      } },
    ]);
  });
}

/* ───────── page bits ───────── */

export function tabsBar(items, active, base) {
  return html`<nav class="tabs" role="tablist">${items.map((t) => html`<a class="tab ${t.id === active ? "active" : ""}" role="tab" href="${base}/${t.id}">${t.icon ? icon(t.icon, "sm") : ""}${t.label}${t.count != null ? html`<span class="n">${t.count}</span>` : ""}</a>`)}</nav>`;
}
export function pageHead(title, sub, right) {
  return html`<div class="page-head"><div><h1>${title}</h1>${sub ? html`<p>${sub}</p>` : ""}</div>${right ? html`<div class="right">${right}</div>` : ""}</div>`;
}
