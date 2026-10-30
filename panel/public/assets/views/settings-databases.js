// Settings → Databases (MySQL connection address) and Settings → phpMyAdmin.
// Kept in its own file so settings.js only needs two SECTIONS entries.
import { html, raw, mount, $, $$, on, ago, fmtDate, fmtDuration, toast, toastError, confirmDialog, openModal, debounce, plural } from "../util.js";
import { icon } from "../icons.js";
import { get, post, put, patch, del } from "../api.js";
import { openJobLog, jobStarted } from "../components.js";
import { dbUnavailable, unavailableState, getReplication, replBadge, fmtLagS, replicaBroken, syncWords, syncBar, SYNC_PHASES } from "./databases.js";

const field = (label, control, hint) => html`<div class="field"><label>${label}</label>${control}${hint ? html`<div class="hint">${hint}</div>` : ""}</div>`;
function setBusy(btn, busy) { if (!btn) return; btn.classList.toggle("loading", busy); btn.disabled = busy; }
function showErr(el, msg) { el.hidden = !msg; mount(el, msg ? html`${icon("alert")}<div>${msg}</div>` : html``); }
const isLocalBind = (b) => /^(127\.|localhost|::1)/.test(String(b || "").trim());
const choice = (name, value, checked, ico, title, desc) => html`<label class="choice ${checked ? "selected" : ""}">
  <input type="radio" name="${name}" value="${value}" ${checked ? raw("checked") : ""}/>
  <div class="c-title"><span class="c-ico">${icon(ico, "sm")}</span>${title}</div><div class="c-desc">${desc}</div><span class="c-mark"></span></label>`;

/* ───────── Databases (MySQL connection) ───────── */

export async function mysqlSettings(outer, ctx) {
  // Replication card first, then the connection settings. display:contents keeps the section's card spacing.
  mount(outer, html`<div data-repl-slot style="display:contents"></div><div data-conn-slot style="display:contents"></div>`);
  const box = $("[data-conn-slot]", outer);
  replicationCard($("[data-repl-slot]", outer), ctx); // renders nothing on a panel without replication
  let s = null;
  const load = async () => {
    try { s = await get("/api/mysql/settings"); } catch (e) { if (!dbUnavailable(e)) throw e; s = { available: false, reason: dbUnavailable(e) }; }
    if (ctx.alive()) paint();
  };

  const paint = () => {
    const why = dbUnavailable(s);
    if (why) return mount(box, unavailableState(why));
    const bindLocal = isLocalBind(s.bindAddress);
    const fallback = s.mainSitesVia === "panel" && s.mainSitesHost !== s.publicHost;
    mount(box, html`
      <form class="card" data-form novalidate>
        <div class="card-head"><div><h3>Database host</h3><div class="sub">The address shown in database credentials and handed to websites as <span class="mono">DB_HOST</span>.</div></div></div>
        <div class="card-body"><div class="form-stack">
          ${field("Database host", html`<input class="input mono" name="publicHost" value="${s.publicHostOverride || ""}" placeholder="${s.publicHostDefault || ""}" autocomplete="off" spellcheck="false"/>`,
            html`Leave blank to use <span class="mono">${s.publicHostDefault}</span> (${s.publicHostSource}). Use an address agent servers can reach — a private network address is best. A name behind a proxy such as Cloudflare's orange cloud won't work for MySQL.`)}
          <div class="field"><label>Websites on the main server connect via</label>
            <div class="choice-grid" data-via>
              ${choice("mainSitesVia", "panel", s.mainSitesVia === "panel", "globe", "Panel address", html`<span class="mono">${s.publicHost}</span> — the same host everywhere. MySQL must listen on the network.`)}
              ${choice("mainSitesVia", "localhost", s.mainSitesVia === "localhost", "server", "Localhost", html`<span class="mono">127.0.0.1</span> — works while MySQL only listens locally.`)}
            </div></div>
          <label class="check"><input type="checkbox" name="pushEnv" checked/>Rewrite the environment of linked websites whose database host changes (they restart)</label>
          <div class="error-box" data-err hidden></div>
        </div></div>
        <div class="card-foot"><span class="muted small">${plural(s.sitesUsingDatabases || 0, "website")} ${s.sitesUsingDatabases === 1 ? "uses" : "use"} a database</span><span class="spacer"></span><button class="btn btn-primary" type="submit" data-save>${icon("check")}Save changes</button></div>
      </form>

      <div class="card">
        <div class="card-head"><div><h3>What websites get</h3><div class="sub">Effective values right now.</div></div></div>
        <div class="card-body"><dl class="kv">
          <dt>Credentials & agent servers</dt><dd class="mono">${s.publicHost}:${s.port}</dd>
          <dt>Websites on the main server</dt><dd><span class="mono">${s.mainSitesHost}:${s.port}</span>${fallback ? html` <span class="badge warn">${icon("alert")}fallback</span>` : ""}</dd>
          <dt>MySQL listens on</dt><dd>${s.bindAddress ? html`<span class="mono">${s.bindAddress}</span>` : html`<span class="muted">unknown (MySQL not reachable)</span>`}${s.dryRun ? html` <span class="badge">simulated</span>` : ""}</dd>
        </dl>
        ${bindLocal ? html`<div class="note warn mt-16" style="align-items:flex-start">${icon("alert")}<div style="flex:1">
            <b>MySQL only accepts connections on ${s.bindAddress}.</b> ${s.mainSitesVia === "panel" ? html`Websites on the main server keep using <span class="mono">127.0.0.1</span> until it listens on <span class="mono">${s.publicHost}</span>; ` : ""}websites on agent servers can't connect at all.
            Let MySQL accept network connections (writes <span class="mono">bind-address = 0.0.0.0</span> to <span class="mono">${s.bindConfigFile}</span> — the file the installer's <span class="mono">FCC_MYSQL_REMOTE=1</span> writes — and restarts MySQL), or re-run the installer with <span class="mono">FCC_MYSQL_REMOTE=1</span>.
            <div class="mt-12"><button class="btn btn-sm" type="button" data-bind="network">${icon("zap")}Listen on the network…</button></div></div></div>`
          : s.bindAddress ? html`<div class="note mt-16">${icon("shield")}<div>Database users only accept logins from this server and agent servers (never <span class="mono">%</span>). Still, keep port ${s.port} closed in your firewall except for your agent servers: <span class="mono">ufw allow from &lt;agent-ip&gt; to any port ${s.port} proto tcp</span>.
            <div class="mt-12"><button class="btn btn-sm btn-ghost" type="button" data-bind="local">${icon("lock")}Listen on 127.0.0.1 only…</button></div></div></div>` : ""}
        </div>
      </div>`);
  };
  await load();

  on(box, "change", "[data-via] input", () => {
    box.querySelectorAll("[data-via] .choice").forEach((c) => c.classList.toggle("selected", c.querySelector("input").checked));
  });
  on(box, "submit", "[data-form]", async (e, form) => {
    e.preventDefault();
    const err = $("[data-err]", box), btn = $("[data-save]", box);
    showErr(err, ""); setBusy(btn, true);
    try {
      const r = await put("/api/mysql/settings", { publicHost: form.elements.publicHost.value.trim(), mainSitesVia: form.querySelector("[name=mainSitesVia]:checked")?.value, pushEnv: form.elements.pushEnv.checked });
      s = r;
      const n = (r.jobs || []).length;
      toast(r.changed?.length ? "Database settings saved" : "Nothing changed", "ok", n ? { msg: `Updating ${plural(n, "website")} in the background.` } : {});
      paint();
    } catch (ex) { showErr(err, ex.message); setBusy(btn, false); }
  });
  on(box, "click", "[data-bind]", async (e, b) => {
    const network = b.dataset.bind === "network";
    const ok = await confirmDialog({
      title: network ? "Let MySQL accept network connections?" : "Limit MySQL to this server?", ico: network ? "zap" : "lock", danger: !network,
      message: network
        ? `MySQL will listen on all addresses (0.0.0.0) and is restarted — open connections drop for a few seconds. Database users still only accept logins from this server and your agent servers. Make sure port ${s.port} is closed to the internet in your firewall.`
        : "MySQL will only listen on 127.0.0.1 and is restarted. Websites on agent servers lose their database connection, and websites on the main server switch to 127.0.0.1.",
      confirmText: network ? "Listen on the network" : "Listen locally only",
    });
    if (!ok) return;
    setBusy(b, true);
    try { const job = await post("/api/mysql/bind", { mode: network ? "network" : "local" }); jobStarted(job, job.title); if (job?.id) openJobLog(job.id); }
    catch (ex) { toastError(ex, "Couldn't change the MySQL listen address"); }
    finally { setBusy(b, false); }
  });
  const reload = debounce(() => load().catch(() => {}), 600);
  ctx.on(["database"], reload);
  ctx.on(["job"], (j) => { if (String(j?.type || "").startsWith("mysql.")) reload(); });
}

/* ───────── Replication (docs/HA.md, Phase 3) ───────── */

const MODE = {
  auto: { label: "Automatic failover", desc: "The replica takes over as soon as the primary is confirmed down (see Failover speed)." },
  manual: { label: "Manual", desc: "You get an alert when the primary is down, and promote the replica yourself." },
};
/** "12 s" / "3.4 s" / "2 min" (failover speed breakdown, 3.10). */
const secsWord = (n) => (n == null ? "?" : n >= 90 ? `${Math.round(n / 60)} min` : n >= 10 ? `${Math.round(n)} s` : `${Math.round(n * 10) / 10} s`);
/** Read-only mirror of the cluster-wide Failover speed setting (Servers page). */
function failoverSummary(f) {
  if (!f) return "";
  return html`<div class="repl-fo">
    <div class="label">Failover speed</div>
    <div class="repl-fo-v"><b>${f.failoverSeconds} s</b><span class="muted small"> · the database moves to the replica in about ${secsWord(f.databaseFailoverSeconds)}; network outages between servers shorter than about ${secsWord(f.blipToleranceSeconds)} are ignored.</span></div>
    <a class="small" href="#/servers">Change it on the Servers page →</a></div>`;
}
const HIST = { enabled: "Replication turned on", seeded: "Replica copied", promoted: "Replica promoted to primary", switchover: "Primary switched",
  rebuilt: "Rebuilt as the replica", broken: "Replication broke", fenced: "Old primary set to read-only", disabled: "Replication turned off", mode: "Failover mode changed" };
const thread = (on, err) => (on ? html`<span class="status"><span class="dot ok"></span>Running</span>` : html`<span class="status"><span class="dot ${err ? "err" : "off"}"></span>Stopped</span>`);

async function startJob(btn, req, fail) {
  setBusy(btn, true);
  try { const job = await req(); if (job?.id) openJobLog(job.id); else toast("Done", "ok"); return true; }
  catch (ex) { toastError(ex, fail); return false; }
  finally { setBusy(btn, false); }
}

/** Enable dialog: pick the replica (recommended first, panel nodes marked) and the failover mode. */
function enableDialog(r) {
  const cands = [...(r.candidates || [])].sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0));
  const first = cands[0]?.serverId;
  return openModal({
    title: "Turn on database replication", ico: "database", size: "lg",
    sub: `${r.primary?.name || "The main server"} stays the primary. The server you pick keeps a live copy of every database.`,
    body: html`<form class="form-stack" novalidate>
      <div class="field"><label>Replica server</label>
        ${cands.length ? html`<div class="choice-grid" data-pick>${cands.map((c) => choice("replica", c.serverId, c.serverId === first, "server", c.name,
          html`${c.recommended ? html`<span class="badge ok">Recommended</span> ` : ""}${c.panelNode ? html`<span class="badge">${icon("layers")}Panel node</span>` : ""}${!c.recommended && !c.panelNode ? "Agent server" : ""}`))}</div>
          <div class="hint">A panel node is a good choice: the panel and the databases can then fail over to the same server.</div>`
        : html`<div class="note warn">${icon("alert")}<div>No server can hold the replica yet. It needs an online agent server running agent 3.3.0 or newer, with enough free disk for a copy of the databases.</div></div>`}</div>
      <div class="field"><label>When the primary goes down</label>
        <div class="choice-grid" data-pick>${choice("mode", "auto", true, "zap", MODE.auto.label, MODE.auto.desc)}${choice("mode", "manual", false, "bell", MODE.manual.label, MODE.manual.desc)}</div></div>
      <div class="note">${icon("info")}<div>Copying the databases to the replica takes a while for large databases; websites keep running. Linked websites get the database address <span class="mono">fcc-mysql.internal</span> once, so they follow the primary on their own after that.</div></div>
      <div class="error-box" data-err hidden></div></form>`,
    foot: html`<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-ok ${cands.length ? "" : raw("disabled")}>${icon("database")}Turn on replication</button>`,
    onMount(el, close) {
      on(el, "change", "[data-pick] input", (e, inp) => $$(".choice", inp.closest("[data-pick]")).forEach((c) => c.classList.toggle("selected", $("input", c).checked)));
      $("[data-ok]", el).onclick = async (e) => {
        const b = e.currentTarget, f = $("form", el), err = $("[data-err]", el);
        const replicaServerId = $("[name=replica]:checked", f)?.value, mode = $("[name=mode]:checked", f)?.value || "auto";
        if (!replicaServerId) return showErr(err, "Pick a replica server.");
        showErr(err, ""); setBusy(b, true);
        try { const job = await post("/api/mysql/replication", { replicaServerId, mode }); close(true); if (job?.id) openJobLog(job.id); else toast("Replication turned on", "ok"); }
        catch (ex) { showErr(err, ex.message); setBusy(b, false); }
      };
    },
  }).result;
}

/** The replica's sync: phase, bar, steps and — while it runs — that websites are unaffected. */
function syncBlock(r) {
  const p = r.progress, w = syncWords(p);
  if (!w) return "";
  const done = p.phase === "in-sync";
  const at = SYNC_PHASES.findIndex(([k]) => k === p.phase); // -1 while preparing
  const took = done && p.startedAt && p.syncedAt ? new Date(p.syncedAt) - new Date(p.startedAt) : null;
  return html`<section class="sync ${done ? "is-ok" : ""}">
    <div class="sync-top">
      <span class="sync-ico">${icon(done ? "check" : "database", "sm")}</span>
      <div class="sync-t"><b>${w.long}</b>
        <span class="sync-meta">${done ? html`${p.replicaName || "The replica"} matches ${r.primary?.name || "the primary"} · synced <span title="${fmtDate(p.syncedAt)}">${ago(p.syncedAt)}</span>${took > 0 ? ` · took ${fmtDuration(took)}` : ""}` : w.meta.join(" · ")}</span></div>
      ${!done && w.pct != null ? html`<span class="sync-pct">${w.pct}%</span>` : ""}
    </div>
    ${syncBar(p)}
    <ol class="sync-steps">${SYNC_PHASES.map(([k, label], i) => html`<li class="${done || i < at ? "done" : i === at ? "now" : ""}">${done || i < at ? icon("check", "xs") : html`<span class="n">${i + 1}</span>`}${label}</li>`)}</ol>
    ${done ? "" : html`<p class="sync-note">${icon("shield", "sm")}<span><b>Your websites keep working normally while this runs.</b> They keep reading and writing on ${r.primary?.name || "the primary"} the whole time. The replica copies everything, then catches up on the changes made meanwhile.</span></p>`}
  </section>`;
}

/** Settings → Databases → Replication card. Live on SSE `mysql-ha`. */
export async function replicationCard(box, ctx) {
  let r = null, showAll = false;
  const load = async () => { r = await getReplication(); if (ctx.alive()) paint(); };

  const histList = () => {
    const h = [...(r.history || [])].sort((a, b) => new Date(b.at) - new Date(a.at));
    if (!h.length) return "";
    const shown = showAll ? h : h.slice(0, 4);
    return html`<div class="repl-sec"><div class="label">History</div>
      <ul class="repl-hist">${shown.map((x) => html`<li><span class="repl-hist-at muted" title="${fmtDate(x.at)}">${ago(x.at)}</span><span class="repl-hist-t"><b>${HIST[x.event] || x.event}</b>${x.detail ? html`<span class="muted"> · ${x.detail}</span>` : ""}</span></li>`)}</ul>
      ${h.length > 4 ? html`<button class="btn btn-sm btn-ghost repl-more" type="button" data-rhist>${showAll ? "Show less" : `Show all ${h.length}`}</button>` : ""}</div>`;
  };

  const paintOff = () => {
    const can = r.canEnable || { ok: true };
    mount(box, html`<div class="card repl-card">
      <div class="card-head"><span class="repl-ico">${icon("database")}</span><div class="repl-head-t"><h3>Replication</h3><div class="sub">Off</div></div></div>
      <div class="card-body">
        <p class="repl-intro">Keep a live copy of every database on one more server, the replica. If ${r.primary?.name || "the main server"} goes down, websites switch to the replica automatically, with no restart.</p>
        ${!can.ok ? html`<div class="note warn mt-16">${icon("info")}<div>${can.reason || "Replication can't be turned on right now."}</div></div>` : ""}
        ${histList()}
      </div>
      <div class="card-foot"><span class="muted small">One replica per cluster.</span><span class="spacer"></span><button class="btn btn-primary" data-renable ${can.ok ? "" : raw("disabled")} title="${can.ok ? "" : can.reason || ""}">${icon("database")}Turn on replication…</button></div>
    </div>`);
  };

  // Turning replication on: not enabled until the copy is done, but the copy is the news.
  const paintSyncing = () => {
    const p = r.progress;
    mount(box, html`<div class="card repl-card">
      <div class="card-head"><span class="repl-ico on">${icon("database")}</span>
        <div class="repl-head-t"><h3>Replication</h3><div class="sub">Turning on · ${r.primary?.name || "Primary"} → ${p.replicaName || "replica"}</div></div>
        <div class="right">${replBadge(r.state === "off" ? "seeding" : r.state)}</div></div>
      <div class="card-body">${syncBlock(r)}${histList()}</div>
    </div>`);
  };

  const paint = () => {
    if (!r) return mount(box, html``);
    if (!r.enabled) return r.progress && r.progress.phase !== "in-sync" ? paintSyncing() : paintOff();
    const p = r.primary || {}, rep = r.replica, broken = replicaBroken(r);
    const flavor = r.flavor === "mariadb" ? "MariaDB" : "MySQL";
    const down = r.detect?.primaryDownForMs;
    const seeding = !!rep && (r.state === "seeding" || r.state === "preparing" || rep.state === "seeding");
    const canSwitch = !!rep && !down && r.state === "replicating" && rep.lagSeconds === 0 && rep.ioRunning !== false && rep.sqlRunning !== false;
    const switchWhy = !rep ? "There is no replica." : down ? `${p.name} isn't answering. Promote the replica instead.` : canSwitch ? "" : "Needs a healthy replica with no lag.";
    const repState = rep ? rep.state || r.state : null;
    mount(box, html`<div class="card repl-card">
      <div class="card-head"><span class="repl-ico on">${icon("database")}</span>
        <div class="repl-head-t"><h3>Replication</h3><div class="sub">${MODE[r.mode]?.label || r.mode} · ${flavor}</div></div>
        <div class="right">${replBadge(r.state)}</div></div>
      ${down ? html`<div class="card-body" style="padding-bottom:0"><div class="note err">${icon("alert")}<div><b>${p.name} hasn't answered for ${fmtDuration(down)}.</b> ${r.mode === "auto" && rep ? `${rep.name} takes over once it has been down for about ${secsWord(r.failover?.detectSeconds ?? 60)} and the replica confirms it, unless it answers again.` : rep ? "Promote the replica if it stays down." : ""}</div></div></div>` : ""}
      <div class="card-body">
        ${r.progress ? syncBlock(r) : ""}
        <div class="repl-pair">
          <div class="repl-node">
            <div class="repl-node-h"><span class="label">Primary</span><span class="badge ${p.readOnly ? "warn" : "ok"}">${p.readOnly ? "Read-only" : "Writable"}</span></div>
            <div class="repl-node-name">${p.name || p.serverId || "—"}</div>
            ${p.address ? html`<div class="mono muted small">${p.address}</div>` : ""}
            <p class="hint" style="margin:10px 0 0">The only server websites write to.</p>
          </div>
          <div class="repl-node ${broken ? "is-err" : ""}">
            ${rep ? html`<div class="repl-node-h"><span class="label">Replica</span>${repState !== r.state ? replBadge(repState) : ""}</div>
              <div class="repl-node-name">${rep.name}</div>
              <dl class="kv repl-kv">
                <dt>Lag</dt><dd>${rep.ioRunning === false || rep.sqlRunning === false ? html`<span class="muted">—</span>` : fmtLagS(rep.lagSeconds)}</dd>
                <dt>IO thread</dt><dd>${thread(rep.ioRunning, rep.lastError)}</dd>
                <dt>SQL thread</dt><dd>${thread(rep.sqlRunning, rep.lastError)}</dd>
                <dt>Last copied</dt><dd>${rep.seededAt ? html`<span title="${fmtDate(rep.seededAt)}">${ago(rep.seededAt)}</span>` : html`<span class="muted">Not yet</span>`}</dd>
              </dl>
              ${rep.lastError ? html`<div class="error-box mt-12">${icon("alert")}<div class="mono small">${rep.lastError}</div></div>` : ""}`
            : html`<div class="repl-node-h"><span class="label">Replica</span></div>
              <div class="repl-node-name muted">None</div>
              <p class="hint" style="margin:10px 0 0">${(r.needsRebuild || []).length ? "Rebuild the old primary below to get a live copy again." : "There is no live copy of the databases right now."}</p>`}
          </div>
        </div>
        ${(r.needsRebuild || []).length ? html`<div class="repl-sec"><div class="label">Needs rebuild</div><div class="edge-rows">${r.needsRebuild.map((n) => html`<div class="edge-row repl-rb">
            <span class="dot ${n.online ? "warn" : "off"}"></span>
            <span class="edge-row-name">${n.name}<span class="muted small"> · ${n.online ? "read-only, waiting to become the replica" : "offline, rebuild it once it's back"}</span></span>
            <button class="btn btn-sm" type="button" data-rrebuild="${n.serverId}" ${n.online && !rep ? "" : raw("disabled")} title="${!n.online ? `${n.name} is offline.` : rep ? `${rep.name} is already the replica. There is one replica per cluster.` : ""}">${icon("refresh")}Rebuild ${n.name}</button></div>`)}</div></div>` : ""}
        <div class="repl-sec repl-mode">
          <div class="field"><label for="repl-mode">Failover</label>
            <select class="select" id="repl-mode" data-rmode>${Object.entries(MODE).map(([k, v]) => html`<option value="${k}" ${k === r.mode ? raw("selected") : ""}>${v.label}</option>`)}</select>
            <div class="hint" data-rmode-desc>${MODE[r.mode]?.desc || ""}</div></div>
          ${failoverSummary(r.failover)}
        </div>
        ${histList()}
      </div>
      <div class="card-foot repl-foot">
        ${rep ? html`<button class="btn" data-rswitch ${canSwitch ? "" : raw("disabled")} title="${switchWhy}">${icon("refresh")}Switch primary</button>
          ${seeding ? "" : html`<button class="btn btn-danger" data-rpromote>${icon("zap")}Promote replica now</button>`}` : ""}
        <span class="spacer"></span>
        <button class="btn btn-ghost" data-rdisable>${icon("power")}Turn off replication</button>
      </div>
    </div>`);
  };

  try { await load(); } catch { r = null; }

  on(box, "click", "[data-rhist]", () => { showAll = !showAll; paint(); });
  on(box, "click", "[data-renable]", async () => { if (await enableDialog(r)) load(); });
  on(box, "change", "[data-rmode]", async (e, sel) => {
    const mode = sel.value; $("[data-rmode-desc]", box).textContent = MODE[mode]?.desc || "";
    sel.disabled = true;
    try { const res = await patch("/api/mysql/replication", { mode }); if (res && typeof res === "object" && "enabled" in res) r = res; else r = { ...r, mode }; toast(mode === "auto" ? "Automatic failover is on" : "Failover is manual now", "ok"); }
    catch (ex) { toastError(ex, "Couldn't change the failover mode"); }
    finally { if (ctx.alive()) paint(); }
  });
  on(box, "click", "[data-rswitch]", async (e, b) => {
    const p = r.primary?.name, rep = r.replica?.name;
    const ok = await confirmDialog({ title: `Make ${rep} the primary?`, ico: "refresh", confirmText: "Switch primary",
      message: `Databases are read-only for about 10 seconds while ${rep} catches up and takes over. Nothing is lost. ${p} then becomes the replica.` });
    if (ok) startJob(b, () => post("/api/mysql/replication/switchover", {}), "Couldn't switch the primary");
  });
  on(box, "click", "[data-rpromote]", async (e, b) => {
    const p = r.primary?.name, rep = r.replica?.name, broken = replicaBroken(r);
    const res = await confirmDialog({ title: `Promote ${rep} now?`, danger: true, confirmText: "Promote replica",
      message: `${rep} becomes the primary right away and websites switch to it. If ${p} is still up, anything written to it that hasn't reached ${rep} yet is lost, and ${p} is set read-only until you rebuild it. When both servers are healthy, use Switch primary instead.`,
      extra: broken ? html`<div class="note err mt-16">${icon("alert")}<div>Replication is broken, so ${rep} may be missing data.
        <label class="check mt-12"><input type="checkbox" name="force" data-extra/>Promote it anyway</label></div></div>` : undefined });
    if (!res) return;
    if (broken && !res.force) { toast("Not promoted", "warn", { msg: `Tick "Promote it anyway" to promote a replica whose replication is broken.` }); return; }
    startJob(b, () => post("/api/mysql/replication/promote", broken ? { force: true } : {}), "Couldn't promote the replica");
  });
  on(box, "click", "[data-rrebuild]", async (e, b) => {
    const n = (r.needsRebuild || []).find((x) => x.serverId === b.dataset.rrebuild); if (!n) return;
    const ok = await confirmDialog({ title: `Rebuild ${n.name} as the replica?`, ico: "refresh", confirmText: `Rebuild ${n.name}`,
      message: `Its databases are replaced with a fresh copy from ${r.primary?.name}, and it then follows the primary as the replica. First, a safety dump of what it holds now is saved on ${n.name} in /var/backups.` });
    if (ok) startJob(b, () => post("/api/mysql/replication/rebuild", { serverId: n.serverId }), `Couldn't rebuild ${n.name}`);
  });
  on(box, "click", "[data-rdisable]", async (e, b) => {
    const rep = r.replica?.name;
    const ok = await confirmDialog({ title: "Turn off replication?", danger: true, confirmText: "Turn off replication",
      message: `${rep ? `Replication stops on ${rep}. Its copy of the databases stays there but is no longer updated. ` : ""}Websites keep using ${r.primary?.name}. If it goes down, there is no copy to switch to.` });
    if (ok) startJob(b, () => del("/api/mysql/replication"), "Couldn't turn off replication");
  });
  const reload = debounce(() => load().catch(() => {}), 400);
  ctx.on("mysql-ha", reload);
  ctx.on("server", (d) => { if (r?.needsRebuild?.some((n) => n.serverId === d?.id && n.online !== !!d.online)) reload(); });
  ctx.on("job", (j) => { if (String(j?.type || "").startsWith("mysql.") && j.status !== "running" && j.status !== "queued") reload(); });
}

/* ───────── phpMyAdmin ───────── */

export async function phpMyAdminSettings(box, ctx) {
  let s = null;
  const load = async (check = false) => {
    try { s = await get(`/api/phpmyadmin${check ? "?check=1" : ""}`); } catch (e) { if (!dbUnavailable(e)) throw e; s = { available: false, reason: dbUnavailable(e) }; }
    if (ctx.alive()) paint();
  };

  const paint = () => {
    const why = dbUnavailable(s);
    if (why) return mount(box, unavailableState(why, { title: "phpMyAdmin is unavailable right now" }));
    const busy = !!s.busyJobId;
    const tone = s.installed ? (s.lastCheck && !s.lastCheck.ok ? "warn" : "ok") : "off";
    mount(box, html`
      <div class="card">
        <div class="card-head" style="flex-wrap:wrap">
          <div class="row" style="flex:1 1 240px;min-width:0;gap:12px"><span style="width:38px;height:38px;border-radius:11px;display:grid;place-items:center;flex:none;background:${s.installed ? "rgba(61,220,151,.12)" : "rgba(148,166,255,.08)"};color:${s.installed ? "var(--ok)" : "var(--text-2)"}">${icon("database")}</span>
            <div style="min-width:0"><h3>phpMyAdmin${s.version ? html` <span class="muted" style="font-weight:500">v${s.version}</span>` : ""}</h3>
              <div class="sub">${busy ? "A phpMyAdmin job is running…" : s.installed ? html`Installed ${s.installedAt ? ago(s.installedAt) : ""} · opens from a database with “Open in phpMyAdmin”` : "Browse and edit a database's tables in the browser, signed in automatically from the panel."}</div></div></div>
          <div class="right btn-row">${s.installed
            ? html`<button class="btn" data-check ${busy ? raw("disabled") : ""}>${icon("refresh")}Check for updates</button><button class="btn" data-update ${busy ? raw("disabled") : ""}>${icon("download")}${s.updateAvailable ? `Update to ${s.latestVersion}` : "Reinstall / update"}</button><button class="btn btn-danger" data-remove ${busy ? raw("disabled") : ""}>${icon("trash")}Remove</button>`
            : html`<button class="btn btn-primary" data-install ${busy || !s.nginx?.installed ? raw("disabled") : ""}>${icon("download")}Install phpMyAdmin</button>`}
            ${busy ? html`<button class="btn btn-ghost" data-log="${s.busyJobId}">${icon("list")}View log</button>` : ""}</div>
        </div>
        ${s.warnings?.length ? html`<div class="card-body" style="padding-bottom:0">${s.warnings.map((w) => html`<div class="note warn" style="margin-bottom:10px">${icon("alert")}<div>${w}</div></div>`)}</div>` : ""}
        <div class="card-body"><dl class="kv">
          <dt>Status</dt><dd><span class="status"><span class="dot ${tone}"></span>${s.installed ? (s.dryRun ? "Installed (simulated)" : "Installed") : "Not installed"}</span>${s.updateAvailable ? html` <span class="badge blue">${s.latestVersion} available</span>` : s.latestVersion && s.installed ? html` <span class="badge ok">${icon("check")}Up to date</span>` : ""}</dd>
          <dt>Address</dt><dd>${s.url ? html`<span class="mono">${s.url}</span> ${s.tls ? html`<span class="badge ok">${icon("lock")}HTTPS</span>` : html`<span class="badge warn">HTTP</span>`}${s.tunnel ? html` <span class="badge blue">${icon("cloud")}Cloudflare Tunnel</span>` : ""}` : html`<span class="mono">port ${s.port}</span>${s.tlsName ? html` · <span class="muted">HTTPS ${s.tls ? `with the certificate for ${s.tlsName}` : `not available (no certificate for ${s.tlsName})`}</span>` : ""}`}</dd>
          <dt>PHP-FPM</dt><dd>${s.php?.fpm ? html`PHP ${s.php.version} · own pool <span class="mono">${s.php.socket}</span>` : s.apt ? html`<span class="muted">Not installed — the install job adds ${s.packages.join(", ")}</span>` : html`<span class="muted">Not installed. Install php-fpm with mysqli, mbstring, xml, zip and gd first.</span>`}</dd>
          <dt>nginx</dt><dd>${s.nginx?.installed ? html`<span class="mono">${s.nginx.file}</span>` : html`<span class="muted">not installed</span>`}</dd>
          <dt>Files</dt><dd class="mono">${s.dir}</dd>
          ${s.sha256 && s.sha256 !== "dry-run" ? html`<dt>Release sha256</dt><dd class="mono small" style="word-break:break-all">${s.sha256}</dd>` : ""}
          ${s.latestError ? html`<dt>Update check</dt><dd class="muted">${s.latestError}</dd>` : ""}
        </dl>
        ${s.dryRun ? html`<p class="hint mt-16">Dry run — the install job logs every step and renders the generated files under <span class="mono">${s.dir}</span>; nothing is downloaded or installed.</p>` : ""}</div>
      </div>

      <form class="card" data-form novalidate>
        <div class="card-head"><div><h3>Where it's served</h3><div class="sub">A separate nginx site on the main server, on its own port.</div></div></div>
        ${s.tunnel || s.panelTunnel ? html`<div class="card-body" style="padding-bottom:0"><div class="note">${icon("cloud")}<div>${s.tunnel
          ? html`Published through Cloudflare Tunnel on <span class="mono">${s.tunnel.hostname}</span> — links use that hostname, and the port below is only where the tunnel reaches it on this server.`
          : html`The panel is reached through a Cloudflare Tunnel, which only carries hostnames — not port ${s.port}. phpMyAdmin is reachable on this port from your own network (or over an SSH tunnel), not through Cloudflare.`}</div></div></div>` : ""}
        <div class="card-body"><div class="form-grid">
          ${field("Port", html`<input class="input mono" name="port" inputmode="numeric" value="${s.port}" autocomplete="off"/>`, html`Allow it in your firewall: <span class="mono">ufw allow ${s.port}/tcp</span>`)}
          ${field("Hostname (optional)", html`<input class="input mono" name="hostname" value="${s.hostname || ""}" placeholder="${s.tlsName || "any"}" autocomplete="off" spellcheck="false"/>`,
            "With a Let's Encrypt certificate for this name on the server (the panel's domain has one), phpMyAdmin is served over HTTPS. Blank = the panel's domain.")}
          <div class="error-box span-2" data-err hidden></div>
        </div></div>
        <div class="card-foot"><span class="muted small">How sign-in works: “Open in phpMyAdmin” on a database creates a one-time link (60 seconds) that signs you in as that database's own user — only that database is visible.</span><span class="spacer"></span><button class="btn btn-primary" type="submit" data-save>${icon("check")}Save</button></div>
      </form>`);
  };
  await load();

  const start = async (b, path, method = "POST") => {
    setBusy(b, true);
    try { const job = method === "DELETE" ? await del(path) : await post(path, {}); jobStarted(job, job.title); if (job?.id) openJobLog(job.id); await load(); }
    catch (ex) { toastError(ex, "Couldn't start the job"); }
    finally { setBusy(b, false); }
  };
  on(box, "click", "[data-install]", async (e, b) => {
    const ok = await confirmDialog({ title: "Install phpMyAdmin?", ico: "download", confirmText: "Install",
      message: `Downloads the latest phpMyAdmin from files.phpmyadmin.net, checks its published sha256, installs the PHP packages it needs, and serves it on port ${s.port}${s.tls ? " over HTTPS" : " (plain HTTP — set a hostname with a certificate for HTTPS)"}.` });
    if (ok) start(b, "/api/phpmyadmin/install");
  });
  on(box, "click", "[data-update]", async (e, b) => {
    const ok = await confirmDialog({ title: s.updateAvailable ? `Update phpMyAdmin to ${s.latestVersion}?` : "Reinstall phpMyAdmin?", ico: "download", confirmText: s.updateAvailable ? "Update" : "Reinstall",
      message: "Downloads and verifies the latest release, swaps it in and regenerates its configuration. Anyone using phpMyAdmin right now may need to open it again." });
    if (ok) start(b, "/api/phpmyadmin/update");
  });
  on(box, "click", "[data-remove]", async (e, b) => {
    const ok = await confirmDialog({ title: "Remove phpMyAdmin?", danger: true, ico: "trash", confirmText: "Remove",
      message: "Removes its nginx site, its PHP-FPM pool, its files and its system user. Your MySQL databases are not touched. You can install it again any time." });
    if (ok) start(b, "/api/phpmyadmin", "DELETE");
  });
  on(box, "click", "[data-check]", async (e, b) => { setBusy(b, true); try { await load(true); toast(s.updateAvailable ? `phpMyAdmin ${s.latestVersion} is available` : s.latestError ? "Couldn't check for updates" : "phpMyAdmin is up to date", s.latestError ? "warn" : "ok"); } catch (ex) { toastError(ex); } finally { setBusy(b, false); } });
  on(box, "click", "[data-log]", (e, b) => openJobLog(b.dataset.log));
  on(box, "submit", "[data-form]", async (e, form) => {
    e.preventDefault();
    const err = $("[data-err]", box), btn = $("[data-save]", box);
    showErr(err, ""); setBusy(btn, true);
    try { s = await put("/api/phpmyadmin/settings", { port: Number(form.elements.port.value), hostname: form.elements.hostname.value.trim() }); toast("phpMyAdmin settings saved", "ok"); paint(); }
    catch (ex) { showErr(err, ex.message); setBusy(btn, false); }
  });
  const reload = debounce(() => load().catch(() => {}), 500);
  ctx.on(["phpmyadmin"], reload);
  ctx.on(["job"], (j) => { if (String(j?.type || "").startsWith("phpmyadmin.")) reload(); });
}
