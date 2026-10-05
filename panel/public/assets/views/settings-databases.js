// Settings → Databases (MySQL connection address) and Settings → phpMyAdmin.
// Kept in its own file so settings.js only needs two SECTIONS entries.
import { html, raw, mount, $, on, ago, toast, toastError, confirmDialog, debounce, plural } from "../util.js";
import { icon } from "../icons.js";
import { get, post, put, del } from "../api.js";
import { openJobLog, jobStarted } from "../components.js";

const field = (label, control, hint) => html`<div class="field"><label>${label}</label>${control}${hint ? html`<div class="hint">${hint}</div>` : ""}</div>`;
function setBusy(btn, busy) { if (!btn) return; btn.classList.toggle("loading", busy); btn.disabled = busy; }
function showErr(el, msg) { el.hidden = !msg; mount(el, msg ? html`${icon("alert")}<div>${msg}</div>` : html``); }
const isLocalBind = (b) => /^(127\.|localhost|::1)/.test(String(b || "").trim());
const choice = (name, value, checked, ico, title, desc) => html`<label class="choice ${checked ? "selected" : ""}">
  <input type="radio" name="${name}" value="${value}" ${checked ? raw("checked") : ""}/>
  <div class="c-title"><span class="c-ico">${icon(ico, "sm")}</span>${title}</div><div class="c-desc">${desc}</div><span class="c-mark"></span></label>`;

/* ───────── Databases (MySQL connection) ───────── */

export async function mysqlSettings(box, ctx) {
  let s = null;
  const load = async () => { s = await get("/api/mysql/settings"); if (ctx.alive()) paint(); };

  const paint = () => {
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

/* ───────── phpMyAdmin ───────── */

export async function phpMyAdminSettings(box, ctx) {
  let s = null;
  const load = async (check = false) => { s = await get(`/api/phpmyadmin${check ? "?check=1" : ""}`); if (ctx.alive()) paint(); };

  const paint = () => {
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
          <dt>Address</dt><dd>${s.url ? html`<span class="mono">${s.url}</span> ${s.tls ? html`<span class="badge ok">${icon("lock")}HTTPS</span>` : html`<span class="badge warn">HTTP</span>`}` : html`<span class="mono">port ${s.port}</span>${s.tlsName ? html` · <span class="muted">HTTPS ${s.tls ? `with the certificate for ${s.tlsName}` : `not available (no certificate for ${s.tlsName})`}</span>` : ""}`}</dd>
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
