// Cloudflare Zero Trust (Cloudflare Tunnel).
//  - Settings → Cloudflare (cloudflareSettings): connect, connectors, routes, panel hostname, forget.
//  - The per-domain delivery picker (Direct vs Cloudflare Tunnel) shared by the website wizard
//    (Domains step) and a website's Domains & SSL tab.
// Every user-supplied string goes through html``.
import { html, raw, mount, $, on, ago, plural, toast, toastError, confirmDialog, formDialog, openModal, openMenu, emptyState, debounce } from "../util.js";
import { icon } from "../icons.js";
import { get, post, patch, put, del } from "../api.js";
import { openJobLog, jobStarted } from "../components.js";
import { onEvent } from "../events.js";

export const CF_SETTINGS = "#/settings/cloudflare";

/* ───────── delivery picker (wizard + Domains & SSL) ───────── */

/** Tunnels + zones a website can use. Never throws: a failure comes back as { error }. */
export async function loadCfOptions() {
  try { return await get("/api/cloudflare/options"); }
  catch (e) { return { connected: false, tunnels: [], zones: [], error: e.status === 404 ? "Cloudflare support isn't installed on this panel." : e.message, unavailable: e.status === 404 }; }
}

export function zoneOf(zones, host) {
  let best = null;
  for (const z of zones || []) if ((host === z || host.endsWith("." + z)) && (!best || z.length > best.length)) best = z;
  return best;
}

/**
 * D = { domains: [], hosts: Set(tunnel hostnames), tunnelId, opts (from loadCfOptions) | null }
 * Domains not in `hosts` are Direct.
 */
export function cfUsable(D) { return !!D.opts && !D.opts.unavailable && (D.opts.connected || (D.opts.tunnels || []).length > 0); }
export function tunnelHosts(D) { return D.domains.filter((d) => D.hosts.has(d)); }
export function pickDefaultTunnel(D) {
  const all = D.opts?.tunnels || [];
  // A tunnel only carries domains of its own account: prefer one in the tunnelled domains' account.
  const accts = new Set(tunnelHosts(D).map((h) => zoneAccount(D.opts, h)).filter(Boolean));
  const fit = accts.size === 1 ? all.filter((x) => x.accountId === [...accts][0]) : [];
  const t = fit.length ? fit : all;
  if (D.tunnelId && t.some((x) => x.id === D.tunnelId)) return;
  D.tunnelId = (t.find((x) => x.connectedHere) || t.find((x) => x.local) || t[0])?.id || D.tunnelId || "";
}
export function deliveryPayload(D) {
  const hostnames = tunnelHosts(D);
  return hostnames.length && D.tunnelId ? { enabled: true, tunnelId: D.tunnelId, hostnames } : { enabled: false, tunnelId: "", hostnames: [] };
}

/** Why this delivery choice can't be saved yet, or null. */
export function validateDelivery(D) {
  const hosts = tunnelHosts(D);
  if (!hosts.length) return null;
  if (!D.opts) return "Still checking your Cloudflare connection — try again in a second.";
  if (D.opts.error && !D.opts.tunnels?.length) return `Cloudflare: ${D.opts.error}`;
  if (!cfUsable(D)) return "Cloudflare isn't connected. Connect it in Settings → Cloudflare, or deliver these domains directly.";
  if (!D.opts.tunnels.length) return "There's no Cloudflare tunnel yet. Create one in Settings → Cloudflare.";
  if (!D.tunnelId) return "Pick which Cloudflare tunnel delivers these domains.";
  if (D.opts.connected) {
    const missing = hosts.filter((h) => !zoneOf(D.opts.zones, h));
    if (missing.length) return `${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} in your Cloudflare account — add the domain to Cloudflare, or switch ${missing.length === 1 ? "it" : "them"} to Direct.`;
    const t = D.opts.tunnels.find((x) => x.id === D.tunnelId);
    const other = t?.accountId ? hosts.filter((h) => zoneAccount(D.opts, h) && zoneAccount(D.opts, h) !== t.accountId) : [];
    if (other.length) return `${other.join(", ")} ${other.length === 1 ? "is" : "are"} in the Cloudflare account ${accountName(D.opts, zoneAccount(D.opts, other[0]))}, but tunnel “${t.name}” is in ${accountName(D.opts, t.accountId)}. A tunnel only carries domains of its own account — pick a tunnel there, or split the domains across websites.`;
  }
  return null;
}

/** The account a hostname's zone is in (options.zoneAccounts), or null. */
export function zoneAccount(o, host) { const z = zoneOf(o?.zones, host); return z ? o.zoneAccounts?.[z] || null : null; }
const accountName = (o, id) => (o?.accounts || []).find((a) => a.id === id)?.name || "another account";
const multiAccount = (o) => (o?.accounts || []).length > 1;

const tunnelLabel = (t, o) => `${multiAccount(o) && t.accountName ? `${t.accountName} · ` : ""}${t.name}${t.connectedHere ? " — connected on this server" : t.running ? " — starting on this server" : t.local ? " — connector stopped here" : " — not run by this panel"}`;

/** Connection state + tunnel picker. Empty when no domain uses the tunnel. */
export function cfPanel(D, { always = false } = {}) {
  if (!always && !tunnelHosts(D).length) return html``;
  const o = D.opts;
  if (!o) return html`<div class="note">${icon("refresh")}<div>Checking your Cloudflare connection…</div></div>`;
  const recheck = html`<button class="btn btn-sm" type="button" data-cfrecheck>${icon("refresh")}Check again</button>`;
  if (o.unavailable) return html`<div class="note err">${icon("alert")}<div>${o.error}</div></div>`;
  if (!cfUsable(D)) {
    return html`<div class="note err cf-connect">${icon("cloud")}<div><b>Cloudflare isn't connected.</b> Connect your Cloudflare account in
      <a href="${CF_SETTINGS}" target="_blank" rel="noopener">Settings → Cloudflare</a> (opens in a new tab — this form keeps what you typed), then check again.
      ${o.error ? html`<div class="small mt-8 mono">${o.error}</div>` : ""}<div class="btn-row mt-12">${recheck}<a class="btn btn-sm" href="${CF_SETTINGS}" target="_blank" rel="noopener">${icon("external")}Open Settings → Cloudflare</a></div></div></div>`;
  }
  if (!o.tunnels.length) {
    return html`<div class="note warn">${icon("alert")}<div>Connected to <b>${o.accountName || "Cloudflare"}</b>, but there's no tunnel to route through yet.
      <a href="${CF_SETTINGS}" target="_blank" rel="noopener">Create one in Settings → Cloudflare</a>, then check again.<div class="btn-row mt-12">${recheck}</div></div></div>`;
  }
  const t = o.tunnels.find((x) => x.id === D.tunnelId);
  return html`<div class="cf-tunnel">
    <div class="field" style="flex:1;min-width:220px"><label>Tunnel</label>
      ${o.tunnels.length > 1 ? html`<select class="select" data-cftunnel>${o.tunnels.map((x) => html`<option value="${x.id}" ${x.id === D.tunnelId ? raw("selected") : ""}>${tunnelLabel(x, o)}</option>`)}</select>`
        : html`<div class="cf-static">${icon("cloud", "sm")}<span class="strong">${o.tunnels[0].name}</span><span class="muted small">${tunnelLabel(o.tunnels[0]).slice(o.tunnels[0].name.length + 3)}</span></div>`}</div>
    <div class="cf-acct muted small">${o.connected ? html`${icon("check", "xs")} Account <b>${(t?.accountName) || o.accountName || "connected"}</b> · ${plural(multiAccount(o) && t?.accountId ? o.zones.filter((z) => o.zoneAccounts?.[z] === t.accountId).length : o.zones.length, "zone")}` : html`${icon("alert", "xs")} Connector token only — add the public hostnames in the Cloudflare dashboard`}${o.simulatedApi ? " · simulated" : ""}</div>
  </div>
  ${t && !t.local ? html`<div class="note warn mt-12">${icon("alert")}<div>This panel doesn't run a connector for <b>${t.name}</b>. Routes will be written, but traffic only flows while a connector for this tunnel is running somewhere — start one in <a href="${CF_SETTINGS}" target="_blank" rel="noopener">Settings → Cloudflare</a>.</div></div>` : ""}`;
}

/** One row per domain with a Direct / Cloudflare Tunnel switch. `routes`: [{ hostname, status, error, code }] from the server. */
export function domainRows(D, { removable = true, routes = null, mainHost = "" } = {}) {
  if (!D.domains.length) return html`<div class="cf-rows"><div class="list-item"><span class="muted small">No domains yet.</span></div></div>`;
  const usable = cfUsable(D);
  const o = D.opts;
  const tunnelAcct = o?.tunnels?.find((x) => x.id === D.tunnelId)?.accountId || null;
  return html`<div class="cf-rows">${D.domains.map((d, i) => {
    const tun = D.hosts.has(d);
    const r = routes?.find((x) => x.hostname === d) || null;
    const zone = o?.connected ? zoneOf(o.zones, d) : null;
    let sub;
    if (!tun) sub = html`DNS A record → <span class="mono">${mainHost || "the main server"}</span> · HTTPS via Let's Encrypt`;
    else if (r?.status === "error") sub = html`<span class="cf-err">${icon("alert", "xs")} ${r.error}</span>`;
    else if (r?.status === "manual") sub = html`<span class="cf-warn">${icon("alert", "xs")} Add this public hostname in the Cloudflare dashboard → <span class="mono">http://127.0.0.1:80</span>, HTTP Host Header <span class="mono">${d}</span></span>`;
    else if (o?.connected && !zone) sub = html`<span class="cf-err">${icon("alert", "xs")} Not in your Cloudflare account${o.zones.length ? html` (zones: ${o.zones.slice(0, 4).join(", ")}${o.zones.length > 4 ? "…" : ""})` : ""}</span>`;
    else if (o?.connected && tunnelAcct && o.zoneAccounts?.[zone] && o.zoneAccounts[zone] !== tunnelAcct) sub = html`<span class="cf-err">${icon("alert", "xs")} In ${accountName(o, o.zoneAccounts[zone])} — pick a tunnel in that account</span>`;
    else if (r?.status === "active") sub = html`<span class="cf-ok">${icon("check", "xs")} Live through the tunnel</span> · zone <span class="mono">${r.zoneName || zone || ""}</span> · HTTPS by Cloudflare`;
    else sub = html`${zone ? html`Zone <span class="mono">${zone}</span> · ` : ""}proxied CNAME → tunnel · HTTPS by Cloudflare`;
    return html`<div class="list-item cf-row">
      <span class="li-ico ${tun ? "cf-ico-tun" : ""}">${icon(tun ? "cloud" : "globe", "sm")}</span>
      <div class="li-main"><div class="li-title mono">${d}</div><div class="li-sub cf-sub">${sub}</div></div>
      <div class="li-right">
        <div class="seg" role="group" aria-label="Delivery for ${d}">
          <button type="button" class="${tun ? "" : "active"}" data-cfmode="direct" data-dom="${d}" aria-pressed="${tun ? "false" : "true"}">Direct</button>
          <button type="button" class="${tun ? "active" : ""}" data-cfmode="tunnel" data-dom="${d}" aria-pressed="${tun ? "true" : "false"}" ${!usable && !tun ? raw('title="Connect Cloudflare first (Settings → Cloudflare)"') : ""}>${icon("cloud", "xs")}Tunnel</button>
        </div>
        ${removable ? html`<button class="icon-btn ghost sm" type="button" data-rmdom="${i}" aria-label="Remove ${d}">${icon("x", "sm")}</button>` : ""}
      </div></div>`;
  })}</div>`;
}

/** The DNS instructions box under the domain list. */
export function dnsNote(D, mainHost) {
  const tun = tunnelHosts(D), direct = D.domains.filter((d) => !D.hosts.has(d));
  const host = mainHost ? html`<span class="mono">${mainHost}</span>` : "the main server";
  if (tun.length && !direct.length) {
    return html`<div class="note">${icon("cloud")}<div><b>No A record needed.</b> The panel adds each hostname to the tunnel (→ nginx on the main server, so load balancing works as usual) and creates a proxied CNAME in Cloudflare. Cloudflare terminates HTTPS — no certbot certificate is needed, and the server needs no open ports for these domains.</div></div>`;
  }
  if (tun.length) {
    return html`<div class="note">${icon("info")}<div><b>Mixed delivery.</b> Point the Direct domains' DNS <b>A record</b> at ${host} and issue a certificate from the website's <b>Domains & SSL</b> tab. The Tunnel domains need no A record: the panel creates their proxied CNAME in Cloudflare and Cloudflare handles their HTTPS.</div></div>`;
  }
  return html`<div class="note">${icon("info")}<div>Point each domain's DNS <b>A record</b> at ${host}. Once DNS resolves you can issue a free HTTPS certificate from the website's <b>Domains & SSL</b> tab.</div></div>`;
}

/** Wire the picker. `repaint()` re-renders; `onChange()` runs after any change. */
export function bindDelivery(root, D, { repaint, onChange } = {}) {
  on(root, "click", "[data-cfmode]", (e, b) => {
    const d = b.dataset.dom;
    if (b.dataset.cfmode === "tunnel") {
      if (!cfUsable(D) && D.opts) { toast("Connect Cloudflare first", "warn", { msg: "Settings → Cloudflare: log in, or paste an API token." }); }
      D.hosts.add(d);
      pickDefaultTunnel(D);
    } else D.hosts.delete(d);
    repaint?.(); onChange?.();
  });
  on(root, "change", "[data-cftunnel]", (e) => { D.tunnelId = e.target.value; repaint?.(); onChange?.(); });
  on(root, "click", "[data-cfrecheck]", async (e, b) => {
    b.classList.add("loading");
    D.opts = await loadCfOptions();
    pickDefaultTunnel(D);
    repaint?.(); onChange?.();
  });
}

/* ───────── Settings → Cloudflare ───────── */

const STATUS_TONE = (c) => (c.fatal || c.lastError ? "err" : c.connected ? "ok" : c.running ? "warn" : "off");
const STATUS_TEXT = (c) => (c.fatal ? "Stopped — token rejected" : c.connected ? `Connected · ${plural(c.connections, "edge connection")}` : c.running ? "Starting…" : c.lastError ? "Error" : "Stopped");

export async function cloudflareSettings(box, ctx) {
  let S = null, routes = null, domains = null, loginTimer = null, domainTimer = null, logOff = null;
  const alive = () => ctx.alive();
  const load = async () => {
    const [s, r, d] = await Promise.all([
      get("/api/cloudflare"),
      get("/api/cloudflare/routes").catch((e) => ({ error: e.message, items: [], tunnels: [] })),
      get("/api/cloudflare/domains").catch((e) => ({ error: e.message, items: [], sources: [] })),
    ]);
    S = s; routes = r; domains = d;
    if (alive()) paint();
  };

  const paint = () => {
    const via = S.connected ? (S.viaLogin ? "Signed in with Cloudflare" : "API token") : S.connectors.length ? "Connector token only" : "Not connected";
    const tone = S.connected ? "ok" : S.connectors.length ? "warn" : "off";
    const localIds = new Set(S.connectors.map((c) => c.cfId).filter(Boolean));
    const spare = (S.tunnels || []).filter((t) => !localIds.has(t.id) && t.remotelyManaged);
    mount(box, html`
      ${S.dryRun ? html`<div class="note warn">${icon("alert")}<div><b>Dry run.</b> cloudflared is never started or downloaded — connectors are simulated.${S.simulatedApi ? html` The Cloudflare API is simulated too (zones <span class="mono">example.com</span>, <span class="mono">example.org</span>; “Add domain” adds <span class="mono">example.net</span>, then <span class="mono">example.ca</span> from a second, shared account); nothing leaves this machine.` : ""}</div></div>` : ""}

      <div class="card">
        <div class="card-head" style="flex-wrap:wrap">
          <div class="row" style="flex:1 1 260px;min-width:0;gap:12px"><span class="cf-badge-ico ${tone}">${icon("cloud")}</span>
            <div style="min-width:0"><h3>Cloudflare account</h3><div class="sub">${S.connected ? html`${S.accountName || S.accountId} · ${via}${S.tokenHint ? html` <span class="mono">${S.tokenHint}</span>` : ""}` : "Deliver websites through Cloudflare Tunnel — no open ports, HTTPS by Cloudflare."}</div></div></div>
          <div class="right"><span class="status"><span class="dot ${tone}"></span>${via}</span></div>
        </div>
        ${S.error ? html`<div class="card-body" style="padding-bottom:0"><div class="error-box">${icon("alert")}<div>${S.error}</div></div></div>` : ""}
        ${S.warning ? html`<div class="card-body" style="padding-bottom:0"><div class="note warn">${icon("alert")}<div>${S.warning}</div></div></div>` : ""}
        <div class="card-body">${S.connected ? html`
          <dl class="kv">
            <dt>Account</dt><dd>${(S.accounts || []).length > 1 ? html`<select class="select" data-account style="max-width:340px">${S.accounts.map((a) => html`<option value="${a.id}" ${a.id === S.accountId ? raw("selected") : ""}>${a.name}</option>`)}</select>` : html`${S.accountName || S.accountId}`}</dd>
            <dt>Connected with</dt><dd>${via}</dd>
            ${others().length ? html`<dt>Other accounts</dt><dd>${others().map((a) => a.name).join(", ")} <span class="muted small">— through their domains below</span></dd>` : ""}
            <dt>Domains</dt><dd>${(S.zones || []).length ? html`${plural(S.zones.length, "domain")} — <a href="#" data-godomains>manage below</a>` : html`<span class="muted">None yet — add one under Domains below</span>`}</dd>
          </dl>
          <div class="btn-row mt-20"><button class="btn" data-disconnect>${icon("logout")}Disconnect account</button><span class="muted small">Connectors keep running on their own tokens.</span></div>`
        : html`
          <div class="cf-ways">
            <div class="cf-way"><div class="strong">${icon("user", "sm")} Log in with Cloudflare</div><p class="muted small">Opens Cloudflare in a new tab; pick the account and a domain to authorise. Recommended.</p>
              <div data-loginbox><button class="btn btn-primary" data-login>${icon("external")}Log in with Cloudflare</button></div></div>
            <form class="cf-way" data-tokenform novalidate><div class="strong">${icon("key", "sm")} Use an API token</div><p class="muted small">Needs <b>Account · Cloudflare Tunnel · Edit</b>, <b>Zone · DNS · Edit</b> and <b>Zone · Zone · Read</b>.</p>
              <div class="input-group"><input class="input mono" type="password" name="token" placeholder="API token" autocomplete="off" spellcheck="false"/><button class="btn" type="submit" data-savetoken>Connect</button></div></form>
            <form class="cf-way" data-connform novalidate><div class="strong">${icon("token", "sm")} Only a connector token</div><p class="muted small">Runs the tunnel here, but you add public hostnames in the Cloudflare dashboard yourself.</p>
              <div class="input-group"><input class="input mono" type="password" name="token" placeholder="eyJh… connector token" autocomplete="off" spellcheck="false"/><button class="btn" type="submit">Add</button></div></form>
          </div>
          <div class="error-box mt-16" data-cferr hidden></div>`}
        </div>
      </div>

      <div class="card">
        <div class="card-head" style="flex-wrap:wrap"><div style="flex:1 1 240px"><h3>Connectors on this server</h3><div class="sub">cloudflared ${S.binary.simulated ? "(simulated)" : S.binary.installed ? html`${S.binary.version || "installed"} · <span class="mono">${S.binary.path}</span>` : "isn't installed — it's downloaded from Cloudflare the first time a connector starts"}</div></div>
          <div class="right btn-row">${!S.binary.installed && !S.binary.simulated && S.binary.supported ? html`<button class="btn btn-sm" data-install>${icon("download")}Install cloudflared</button>` : ""}
            ${S.connected ? html`<button class="btn btn-sm btn-primary" data-newtunnel>${icon("plus")}Create tunnel</button>${spare.length ? html`<button class="btn btn-sm" data-adopt>${icon("link")}Use existing tunnel</button>` : ""}` : ""}
            ${S.connected || S.connectors.length ? html`<button class="btn btn-sm" data-addconn>${icon("token")}Paste connector token</button>` : ""}</div></div>
        ${S.connectors.length ? html`<div class="list">${S.connectors.map((c) => html`<div class="list-item">
            <span class="li-ico">${icon("cloud", "sm")}</span>
            <div class="li-main"><div class="li-title">${c.name}</div><div class="li-sub">${others().length && c.accountId ? html`${acctName(c.accountId)} · ` : ""}${c.cfId ? html`Tunnel <span class="mono">${c.cfId.slice(0, 8)}</span>` : "Tunnel id unknown"}${c.startedAt ? html` · up since ${ago(c.startedAt)}` : ""}${c.lastError ? html` · <span class="cf-err">${c.lastError}</span>` : ""}</div></div>
            <div class="li-right">
              <label class="switch hide-sm" title="Start this connector whenever the panel starts"><input type="checkbox" data-auto="${c.id}" ${c.autoStart ? raw("checked") : ""}/><span class="track"></span>With panel</label>
              <span class="status"><span class="dot ${STATUS_TONE(c)}"></span>${STATUS_TEXT(c)}</span>
              ${c.running ? html`<button class="btn btn-sm" data-cstop="${c.id}">${icon("stop")}Stop</button>` : html`<button class="btn btn-sm" data-cstart="${c.id}">${icon("play")}Start</button>`}
              <button class="icon-btn ghost sm" data-cmenu="${c.id}" aria-label="More for ${c.name}">${icon("more", "sm")}</button>
            </div></div>`)}</div>`
          : html`<div class="card-body">${emptyState({ ico: "cloud", title: "No connectors yet", text: S.connected ? "Create a tunnel — the panel takes its connector token and runs it here." : "Connect your Cloudflare account above, or paste a connector token.", sm: true })}</div>`}
      </div>

      ${S.connected ? domainsCard() : ""}

      <form class="card" data-panelform novalidate>
        <div class="card-head"><div><h3>Publish this panel</h3><div class="sub">Reach the panel itself on a hostname through the tunnel (→ <span class="mono">${S.panelService}</span>).</div></div>
          ${S.panel ? html`<div class="right"><span class="badge ${S.panel.route?.status === "active" ? "ok" : S.panel.route?.status === "error" ? "err" : "warn"}">${S.panel.route?.status === "active" ? "Live" : S.panel.route?.status === "error" ? "Error" : S.panel.route?.status === "manual" ? "Add in dashboard" : "Pending"}</span></div>` : ""}</div>
        <div class="card-body">
          ${S.connectors.some((c) => c.cfId) || (S.tunnels || []).length ? html`<div class="form-grid">
            <div class="field"><label>Hostname</label><input class="input mono" name="hostname" value="${S.panel?.hostname || ""}" placeholder="panel.example.com" autocomplete="off" spellcheck="false"/></div>
            <div class="field"><label>Tunnel</label><select class="select" name="tunnelId">${panelTunnels().map((t) => html`<option value="${t.id}" ${t.id === S.panel?.tunnelId ? raw("selected") : ""}>${t.name}</option>`)}</select></div>
          </div>
          ${S.panel?.route?.error ? html`<div class="${S.panel.route.status === "manual" ? "note warn" : "error-box"} mt-16">${icon("alert")}<div>${S.panel.route.error}</div></div>` : ""}
          <p class="hint mt-12">Protect it with a Cloudflare Access policy for extra safety. Leave the hostname empty and save to unpublish.</p>`
          : html`<p class="muted small">Add a connector first.</p>`}
        </div>
        ${S.connectors.some((c) => c.cfId) || (S.tunnels || []).length ? html`<div class="card-foot"><span class="spacer"></span><button class="btn btn-primary" type="submit" data-savepanel>${icon("check")}${S.panel ? "Save" : "Publish panel"}</button></div>` : ""}
      </form>

      <form class="card" data-pmaform novalidate>
        <div class="card-head"><div><h3>Publish phpMyAdmin</h3><div class="sub">A tunnel carries hostnames, not ports — so phpMyAdmin needs a hostname of its own (→ <span class="mono">${S.phpmyadminService}</span>).</div></div>
          ${S.phpmyadmin ? html`<div class="right"><span class="badge ${S.phpmyadmin.route?.status === "active" ? "ok" : S.phpmyadmin.route?.status === "error" ? "err" : "warn"}">${S.phpmyadmin.route?.status === "active" ? "Live" : S.phpmyadmin.route?.status === "error" ? "Error" : S.phpmyadmin.route?.status === "manual" ? "Add in dashboard" : "Pending"}</span></div>` : ""}</div>
        <div class="card-body">
          ${S.connectors.some((c) => c.cfId) || (S.tunnels || []).length ? html`<div class="form-grid">
            <div class="field"><label>Hostname</label><input class="input mono" name="hostname" value="${S.phpmyadmin?.hostname || ""}" placeholder="${S.panel?.hostname ? `pma.${S.panel.hostname.split(".").slice(1).join(".")}` : "pma.example.com"}" autocomplete="off" spellcheck="false"/></div>
            <div class="field"><label>Tunnel</label><select class="select" name="tunnelId">${panelTunnels().map((t) => html`<option value="${t.id}" ${t.id === (S.phpmyadmin?.tunnelId || S.panel?.tunnelId) ? raw("selected") : ""}>${t.name}</option>`)}</select></div>
          </div>
          ${S.phpmyadmin?.route?.error ? html`<div class="${S.phpmyadmin.route.status === "manual" ? "note warn" : "error-box"} mt-16">${icon("alert")}<div>${S.phpmyadmin.route.error}</div></div>` : ""}
          <p class="hint mt-12">“Open in phpMyAdmin” then links to <span class="mono">https://${S.phpmyadmin?.hostname || "this hostname"}</span>. Sign-in still only works through the panel's one-time links. Leave the hostname empty and save to unpublish.</p>`
          : html`<p class="muted small">Add a connector first.</p>`}
        </div>
        ${S.connectors.some((c) => c.cfId) || (S.tunnels || []).length ? html`<div class="card-foot"><span class="spacer"></span><button class="btn btn-primary" type="submit" data-savepma>${icon("check")}${S.phpmyadmin ? "Save" : "Publish phpMyAdmin"}</button></div>` : ""}
      </form>

      <div class="card">
        <div class="card-head"><div><h3>Routes</h3><div class="sub">Public hostnames on your tunnels. The panel only changes the ones it created; dashboard-made routes and the catch-all are kept.</div></div>
          <div class="right"><button class="btn btn-sm" data-reloadroutes>${icon("refresh")}Refresh</button></div></div>
        ${routesView()}
      </div>

      ${S.configured || S.connectors.length || S.routes ? html`<div class="card cf-danger">
        <div class="card-head"><div><h3>Forget everything</h3><div class="sub">Stops every connector and deletes the panel's Cloudflare credentials, connector tokens, login certificate and route records. Tunnels, routes and DNS records stay in your Cloudflare account.</div></div>
          <div class="right"><button class="btn btn-danger" data-reset>${icon("trash")}Forget Cloudflare</button></div></div></div>` : ""}`);
  };

  function domainsCard() {
    const D = domains || { items: [], sources: [] };
    const tone = (z) => (z.error ? "err" : z.status === "active" ? "ok" : "warn");
    const label = (z) => (z.error ? "Can't reach" : z.status === "active" ? "Active" : z.status === "pending" ? "Pending nameservers" : z.status || "Unknown");
    return html`<div class="card" id="cf-domains">
      <div class="card-head" style="flex-wrap:wrap"><div style="flex:1 1 240px"><h3>Domains</h3><div class="sub">Domains the panel can route through your tunnels. Cloudflare's login authorises one domain at a time — add each one you want to use. A domain in another account you belong to works too; route it through a tunnel in that account.</div></div>
        <div class="right btn-row"><button class="btn btn-sm btn-primary" data-adddomain>${icon("plus")}Add domain</button><button class="btn btn-sm" data-domtoken>${icon("key")}Paste API token</button></div></div>
      <div data-domlogin hidden></div>
      ${D.error ? html`<div class="card-body" style="padding-bottom:0"><div class="error-box">${icon("alert")}<div>${D.error}</div></div></div>` : ""}
      ${D.items.length ? html`<div class="list">${D.items.map((z) => html`<div class="list-item">
          <span class="li-ico">${icon("globe", "sm")}</span>
          <div class="li-main"><div class="li-title mono">${z.name}</div><div class="li-sub">${others().length ? html`${z.accountName} · ` : ""}${z.sourceLabel}${z.routes ? html` · ${plural(z.routes, "route")}` : ""}${z.error ? html` · <span class="cf-err">${z.error}</span>` : ""}</div></div>
          <div class="li-right">
            <span class="status"><span class="dot ${tone(z)}"></span>${label(z)}</span>
            ${z.removable ? html`<button class="icon-btn ghost sm" data-dommenu="${z.source}" aria-label="More for ${z.name}">${icon("more", "sm")}</button>` : html`<span class="icon-btn ghost sm" style="visibility:hidden"></span>`}
          </div></div>`)}</div>`
        : html`<div class="card-body">${emptyState({ ico: "globe", title: "No domains yet", text: "Add a domain to route hostnames on it through a tunnel.", sm: true })}</div>`}
      <div class="card-foot"><span class="muted small">Not on Cloudflare yet? <a href="${D.addSiteUrl || "https://dash.cloudflare.com/"}" target="_blank" rel="noopener noreferrer">Add the site in Cloudflare</a>, point its nameservers there, then add it here.</span></div>
    </div>`;
  }

  function panelTunnels() {
    const m = new Map();
    const pre = (id) => (others().length && id ? `${acctName(id)} · ` : "");
    for (const c of S.connectors) if (c.cfId) m.set(c.cfId, { id: c.cfId, name: `${pre(c.accountId)}${c.name}` });
    for (const t of S.tunnels || []) if (t.remotelyManaged && !m.has(t.id)) m.set(t.id, { id: t.id, name: `${pre(t.accountId)}${t.name} (not run here)` });
    return [...m.values()];
  }
  /** Accounts other than the main one that the panel reaches (through domain credentials). */
  function others() { return (S.managedAccounts || []).filter((a) => !a.main); }
  function acctName(id) { return (S.managedAccounts || []).find((a) => a.id === id)?.name || id.slice(0, 8); }

  // A website's tunnel rule points at nginx on this server; nginx then forwards
  // to the site's port (or every server in its pool). Show both hops so ":80"
  // isn't mistaken for the app's port.
  function routeText(r) {
    if (!r.siteId || !r.targets?.length) return html`→ ${r.service}`;
    const shown = r.targets.slice(0, 3).map((t) => `${t.address}${t.server ? ` (${t.server})` : ""}`).join(", ");
    const more = r.targets.length > 3 ? ` +${r.targets.length - 3} more` : "";
    return html`→ nginx ${r.service.replace(/^https?:\/\//, "")} → ${shown}${more}${r.loadBalanced ? html` <span class="muted">· load balanced</span>` : ""}`;
  }

  function routesView() {
    if (!routes) return html`<div class="card-body"><span class="muted small">Loading…</span></div>`;
    if (routes.error) return html`<div class="card-body"><div class="error-box">${icon("alert")}<div>${routes.error}</div></div></div>`;
    const errs = (routes.items || []).filter((r) => r.status !== "active");
    const tunnels = routes.tunnels || [];
    if (!tunnels.length && !errs.length) return html`<div class="card-body"><p class="muted small">No routes yet. Choose <b>Cloudflare Tunnel</b> for a domain in a website's Domains step (or its Domains & SSL tab).</p></div>`;
    return html`${errs.length ? html`<div class="card-body" style="padding-bottom:0">${errs.map((r) => html`<div class="${r.status === "manual" ? "note warn" : "error-box"} mt-8">${icon("alert")}<div><b class="mono">${r.hostname}</b>${r.siteName ? html` · <a href="#/sites/${r.siteId}/domains">${r.siteName}</a>` : r.owner === "panel" ? " · panel" : r.owner === "phpmyadmin" ? " · phpMyAdmin" : ""} — ${r.error || r.status}</div></div>`)}</div>` : ""}
      ${tunnels.map((t) => html`<div class="cf-routes-head"><span class="strong">${t.name}</span> <span class="muted small mono">${t.tunnelId.slice(0, 8)}</span>${others().length && t.accountName ? html` <span class="muted small">· ${t.accountName}</span>` : ""}</div>
        ${t.error ? html`<div class="card-body" style="padding-top:0"><span class="muted small">${t.error}</span></div>`
        : html`<div class="list">${t.rules.map((r) => html`<div class="list-item">
            <span class="li-ico">${icon(r.catchAll ? "x" : r.panel ? "dashboard" : r.phpmyadmin ? "database" : r.siteId ? "globe" : "link", "sm")}</span>
            <div class="li-main"><div class="li-title ${r.catchAll ? "muted" : "mono"}">${r.catchAll ? "Everything else (catch-all)" : html`${r.hostname}${r.path ? html`<span class="muted">${r.path}</span>` : ""}`}</div><div class="li-sub mono">${routeText(r)}</div></div>
            <div class="li-right">${r.catchAll ? html`<span class="badge">Always last</span>` : r.panel ? html`<span class="badge blue">Panel</span>` : r.phpmyadmin ? html`<span class="badge blue">phpMyAdmin</span>` : r.siteId ? html`<a class="badge blue" href="#/sites/${r.siteId}/domains">${r.siteName || "Website"}</a>${r.adopted ? html`<span class="badge" title="Existed before the panel managed it; it won't be deleted">Adopted</span>` : ""}` : html`<span class="badge" title="Made in the Cloudflare dashboard — the panel leaves it alone">Dashboard</span>`}</div></div>`)}</div>`}`)}`;
  }

  const errBox = () => $("[data-cferr]", box);
  const showErr = (msg) => { const el = errBox(); if (!el) return toast(msg, "err"); el.hidden = !msg; mount(el, msg ? html`${icon("alert")}<div>${msg}</div>` : html``); };
  const busy = (b, v) => { if (!b) return; b.classList.toggle("loading", v); b.disabled = v; };

  await load();

  // ---- connect
  on(box, "click", "[data-login]", async (e, b) => {
    busy(b, true); showErr("");
    try {
      const r = await post("/api/cloudflare/login");
      if (r.done) { toast("Connected to Cloudflare", "ok", { msg: r.accountName || "" }); return load(); }
      mount($("[data-loginbox]", box), html`<div class="stack" style="gap:10px"><a class="btn btn-primary" href="${r.url}" target="_blank" rel="noopener noreferrer">${icon("external")}Open the Cloudflare login page</a>
        <span class="muted small" data-loginstate>Waiting for you to authorise in the Cloudflare tab…</span><button class="btn btn-sm btn-ghost" type="button" data-logincancel>Cancel</button></div>`);
      window.open(r.url, "_blank", "noopener");
      clearInterval(loginTimer);
      loginTimer = setInterval(async () => {
        if (!alive()) return clearInterval(loginTimer);
        try {
          const p = await get("/api/cloudflare/login");
          if (p.done) { clearInterval(loginTimer); toast("Connected to Cloudflare", "ok", { msg: p.accountName || "" }); load(); }
          else if (p.error) { clearInterval(loginTimer); showErr(p.error); load(); }
        } catch (ex) { clearInterval(loginTimer); showErr(ex.message); }
      }, 2000);
    } catch (ex) { showErr(ex.message); busy(b, false); }
  });
  on(box, "click", "[data-logincancel]", async () => { clearInterval(loginTimer); await post("/api/cloudflare/login/cancel").catch(() => {}); load(); });
  on(box, "submit", "[data-tokenform]", async (e, form) => {
    e.preventDefault();
    const token = form.elements.token.value.trim();
    if (!token) return showErr("Paste an API token first.");
    const b = $("[data-savetoken]", form); busy(b, true); showErr("");
    try { const r = await post("/api/cloudflare/token", { token }); toast("Connected to Cloudflare", "ok", { msg: r.status?.accountName || (r.accounts?.length > 1 ? "Pick which account to use." : "") }); load(); }
    catch (ex) { showErr(ex.message); busy(b, false); }
  });
  on(box, "submit", "[data-connform]", async (e, form) => {
    e.preventDefault();
    const token = form.elements.token.value.trim();
    if (!token) return showErr("Paste the connector token first.");
    try { const r = await post("/api/cloudflare/connectors", { token }); toast("Connector added", r.startError ? "warn" : "ok", { msg: r.startError || "Starting it now." }); load(); }
    catch (ex) { showErr(ex.message); }
  });
  on(box, "change", "[data-account]", async (e) => {
    try { await post("/api/cloudflare/account", { accountId: e.target.value }); toast("Account switched", "ok"); load(); } catch (ex) { toastError(ex); }
  });
  on(box, "click", "[data-disconnect]", async () => {
    const ok = await confirmDialog({ title: "Disconnect the Cloudflare account?", message: "The panel stops managing routes and DNS. Connectors keep running; existing routes keep working.", confirmText: "Disconnect" });
    if (!ok) return;
    try { await post("/api/cloudflare/token", { token: "" }); toast("Disconnected", "ok"); load(); } catch (ex) { toastError(ex); }
  });

  // ---- domains
  on(box, "click", "[data-godomains]", (e) => { e.preventDefault(); $("#cf-domains", box)?.scrollIntoView({ behavior: "smooth", block: "start" }); });
  const domainAdded = (r) => toast(r.added?.length ? `Added ${r.added.join(", ")}` : "Domain added", "ok", {
    msg: r.accounts?.length ? `Now linked: ${r.accounts.join(", ")}. Route it through a tunnel in that account — create one under Connectors.` : r.refused?.length ? r.refused.join(" ") : "Its hostnames can now be routed through your tunnels.",
  });
  on(box, "click", "[data-adddomain]", async (e, b) => {
    busy(b, true);
    try {
      const r = await post("/api/cloudflare/domains/login");
      const lb = $("[data-domlogin]", box);
      lb.hidden = false;
      mount(lb, html`<div class="card-body" style="padding-bottom:0"><div class="note">${icon("external")}<div class="stack" style="gap:8px">
        <div>In the Cloudflare tab, pick the <b>domain to add</b> and authorise it. This page updates by itself.</div>
        <div class="btn-row"><a class="btn btn-sm btn-primary" href="${r.url}" target="_blank" rel="noopener noreferrer">${icon("external")}Open the Cloudflare login page</a><button class="btn btn-sm btn-ghost" type="button" data-domlogincancel>Cancel</button></div></div></div></div>`);
      window.open(r.url, "_blank", "noopener");
      clearInterval(domainTimer);
      domainTimer = setInterval(async () => {
        if (!alive()) return clearInterval(domainTimer);
        try {
          const p = await get("/api/cloudflare/login");
          if (p.done) { clearInterval(domainTimer); domainAdded(p); load(); }
          else if (p.error) { clearInterval(domainTimer); toast("Couldn't add the domain", "err", { msg: p.error }); load(); }
        } catch (ex) { clearInterval(domainTimer); toastError(ex); load(); }
      }, 2000);
    } catch (ex) { toastError(ex, "Couldn't start the Cloudflare login"); busy(b, false); }
  });
  on(box, "click", "[data-domlogincancel]", async () => { clearInterval(domainTimer); await post("/api/cloudflare/login/cancel").catch(() => {}); load(); });
  on(box, "click", "[data-domtoken]", async () => {
    const r = await formDialog({
      title: "Add domains with an API token", ico: "key", sub: "A token for more domains — for example one with Zone Resources set to several zones. Needs Zone · DNS · Edit and Zone · Zone · Read; for domains in another account you belong to, also Account · Cloudflare Tunnel · Edit on that account. Stored encrypted.",
      fields: [{ name: "token", label: "API token", type: "password", required: true, autocomplete: "off" }],
      submitText: "Add domains", onSubmit: (v) => post("/api/cloudflare/domains", { token: v.token }),
    });
    if (r) { domainAdded(r); load(); }
  });
  on(box, "click", "[data-dommenu]", (e, b) => {
    const src = (domains?.sources || []).find((x) => x.id === b.dataset.dommenu);
    if (!src) return;
    openMenu(b, [
      { label: src.zones.length > 1 ? `Remove ${src.zones.length} domains` : "Remove domain", icon: "trash", danger: true, onClick: async () => {
        const ok = await confirmDialog({ title: `Remove ${src.zones.join(", ")}?`, danger: true, confirmText: "Remove",
          message: `The panel forgets the credentials (${src.label}) that reach ${src.zones.length === 1 ? "this domain" : "these domains"}. Nothing changes in Cloudflare; you can add ${src.zones.length === 1 ? "it" : "them"} again any time.` });
        if (!ok) return;
        try { await del(`/api/cloudflare/domains/${src.id}`); toast("Domain removed", "ok"); load(); } catch (ex) { toastError(ex, "Couldn't remove it"); }
      } },
    ]);
  });

  // ---- tunnels + connectors
  on(box, "click", "[data-install]", async (e, b) => {
    busy(b, true);
    try { await post("/api/cloudflare/install"); toast("cloudflared installed", "ok"); load(); } catch (ex) { toastError(ex, "Couldn't install cloudflared"); busy(b, false); }
  });
  on(box, "click", "[data-newtunnel]", async () => {
    const r = await formDialog({
      title: "Create a tunnel", ico: "cloud", sub: "Made in your Cloudflare account and run by this server. Its routes are managed from the panel.",
      fields: [
        ...(others().length ? [{ name: "accountId", label: "Cloudflare account", type: "select", value: S.accountId, options: S.managedAccounts.map((a) => ({ value: a.id, label: a.name })), hint: "A tunnel carries domains of its own account only." }] : []),
        { name: "name", label: "Name", value: `fcc-${(ctx.state.settings?.hostname || "server").split(".")[0]}`, required: true, attrs: 'maxlength="60"' },
      ],
      submitText: "Create & start", onSubmit: (v) => post("/api/cloudflare/tunnels", { name: v.name, accountId: v.accountId || undefined }),
    });
    if (r) { toast(`Tunnel ${r.tunnel?.name} created`, r.startError ? "warn" : "ok", { msg: r.startError || "The connector is starting." }); load(); }
  });
  on(box, "click", "[data-adopt]", async () => {
    const localIds = new Set(S.connectors.map((c) => c.cfId));
    const spare = (S.tunnels || []).filter((t) => !localIds.has(t.id) && t.remotelyManaged);
    const r = await formDialog({
      title: "Run an existing tunnel here", ico: "link", sub: "The panel fetches its connector token and starts it on this server.",
      fields: [{ name: "tunnelId", label: "Tunnel", type: "select", value: spare[0]?.id, options: spare.map((t) => ({ value: t.id, label: `${others().length ? `${acctName(t.accountId)} · ` : ""}${t.name}${t.status ? ` (${t.status})` : ""}` })) }],
      submitText: "Use this tunnel", onSubmit: (v) => post("/api/cloudflare/tunnels", { tunnelId: v.tunnelId }),
    });
    if (r) { toast(`Running ${r.tunnel?.name}`, r.startError ? "warn" : "ok", { msg: r.startError || "" }); load(); }
  });
  on(box, "click", "[data-addconn]", async () => {
    const r = await formDialog({
      title: "Add a connector token", ico: "token", sub: "From Zero Trust → Networks → Tunnels → your tunnel → Configure. The token is stored encrypted and passed to cloudflared in its environment, never on the command line.",
      fields: [{ name: "name", label: "Name", value: "Cloudflare Tunnel", attrs: 'maxlength="60"' }, { name: "token", label: "Connector token", type: "password", required: true, autocomplete: "off" }],
      submitText: "Add & start", onSubmit: (v) => post("/api/cloudflare/connectors", { name: v.name, token: v.token }),
    });
    if (r) { toast("Connector added", r.startError ? "warn" : "ok", { msg: r.startError || "" }); load(); }
  });
  on(box, "click", "[data-cstart],[data-cstop]", async (e, b) => {
    const id = b.dataset.cstart || b.dataset.cstop;
    busy(b, true);
    try { await post(`/api/cloudflare/connectors/${id}/${b.dataset.cstart ? "start" : "stop"}`); load(); } catch (ex) { toastError(ex); busy(b, false); }
  });
  on(box, "change", "[data-auto]", async (e) => {
    try { await patch(`/api/cloudflare/connectors/${e.target.dataset.auto}`, { autoStart: e.target.checked }); toast(e.target.checked ? "Starts with the panel" : "Won't start with the panel", "ok"); } catch (ex) { toastError(ex); e.target.checked = !e.target.checked; }
  });
  on(box, "click", "[data-cmenu]", (e, b) => {
    const c = S.connectors.find((x) => x.id === b.dataset.cmenu);
    if (!c) return;
    openMenu(b, [
      { label: "View log", icon: "fileText", onClick: () => connectorLog(c) },
      { label: "Restart", icon: "restart", onClick: async () => { try { await post(`/api/cloudflare/connectors/${c.id}/restart`); toast("Restarting", "ok"); load(); } catch (ex) { toastError(ex); } } },
      { label: "Rename", icon: "edit", onClick: async () => { const r = await formDialog({ title: "Rename connector", fields: [{ name: "name", label: "Name", value: c.name, required: true }], onSubmit: (v) => patch(`/api/cloudflare/connectors/${c.id}`, { name: v.name }) }); if (r) load(); } },
      { sep: true },
      { label: "Remove from this server", icon: "trash", danger: true, onClick: async () => {
        const ok = await confirmDialog({ title: `Remove ${c.name}?`, message: "Stops the connector and forgets its token. The tunnel and its routes stay in your Cloudflare account — websites routed through it go offline until a connector runs again.", danger: true, confirmText: "Remove" });
        if (!ok) return;
        try { await del(`/api/cloudflare/connectors/${c.id}`); toast("Connector removed", "ok"); load(); } catch (ex) { toastError(ex); }
      } },
    ]);
  });

  async function connectorLog(c) {
    const m = openModal({ title: `${c.name} — cloudflared log`, ico: "fileText", size: "xl",
      body: html`<pre class="code wrap" data-log style="min-height:300px;max-height:60vh"><span class="muted">Loading…</span></pre>`,
      foot: html`<button class="btn" data-close>Close</button>` });
    const pre = $("[data-log]", m.el);
    try {
      const r = await get(`/api/cloudflare/connectors/${c.id}/logs?lines=300`);
      pre.textContent = r.lines.length ? r.lines.join("\n") + "\n" : "No output yet.\n";
      pre.scrollTop = pre.scrollHeight;
    } catch (ex) { pre.textContent = `Couldn't load the log: ${ex.message}`; }
    logOff?.();
    logOff = onEvent("cloudflare", (d) => { if (d?.kind === "log" && d.id === c.id) { pre.textContent += d.line + "\n"; pre.scrollTop = pre.scrollHeight; } });
    m.result.then(() => { logOff?.(); logOff = null; });
  }

  // ---- routes + panel
  on(box, "click", "[data-reloadroutes]", async (e, b) => { busy(b, true); try { routes = await get("/api/cloudflare/routes"); paint(); } catch (ex) { toastError(ex); busy(b, false); } });
  on(box, "submit", "[data-panelform]", async (e, form) => {
    e.preventDefault();
    const b = $("[data-savepanel]", form); busy(b, true);
    try {
      const r = await put("/api/cloudflare/panel", { hostname: form.elements.hostname.value.trim(), tunnelId: form.elements.tunnelId?.value });
      if (r.job) jobStarted(r.job, r.panel ? `Publishing the panel on ${r.panel.hostname}` : "Unpublishing the panel");
      if (r.panelUrlSet) toast("Panel URL updated", "info", { msg: `Set to ${r.panelUrlSet} — use it for Sign in with GitHub (callback ${r.panelUrlSet}/auth/github/callback).` });
      setTimeout(load, 1200);
    } catch (ex) { toastError(ex, "Couldn't save"); busy(b, false); }
  });

  on(box, "submit", "[data-pmaform]", async (e, form) => {
    e.preventDefault();
    const b = $("[data-savepma]", form); busy(b, true);
    try {
      const r = await put("/api/cloudflare/phpmyadmin", { hostname: form.elements.hostname.value.trim(), tunnelId: form.elements.tunnelId?.value });
      if (r.job) jobStarted(r.job, r.phpmyadmin ? `Publishing phpMyAdmin on ${r.phpmyadmin.hostname}` : "Unpublishing phpMyAdmin");
      setTimeout(load, 1200);
    } catch (ex) { toastError(ex, "Couldn't save"); busy(b, false); }
  });

  on(box, "click", "[data-reset]", async () => {
    const ok = await confirmDialog({ title: "Forget everything about Cloudflare?", danger: true, confirmText: "Forget Cloudflare", typed: "forget",
      message: "Every connector on this server stops, and the panel deletes its Cloudflare login, API token, connector tokens and route records. Websites delivered through a tunnel go offline until you reconnect. Nothing is deleted in your Cloudflare account." });
    if (!ok) return;
    try {
      const r = await post("/api/cloudflare/reset");
      openModal({ title: "Cloudflare forgotten", ico: "check",
        body: html`${r.removed.length ? html`<div class="label">Removed</div><ul class="small" style="margin:6px 0 14px 18px">${r.removed.map((x) => html`<li>${x}</li>`)}</ul>` : html`<p class="muted">Nothing was stored.</p>`}
          ${r.remaining.length ? html`<div class="label">Still there</div><ul class="small" style="margin:6px 0 0 18px">${r.remaining.map((x) => html`<li>${x}</li>`)}</ul>` : ""}`,
        foot: html`<button class="btn btn-primary" data-close>Done</button>` });
      load();
    } catch (ex) { toastError(ex); }
  });

  ctx.on(["cloudflare"], debounce((d) => { if (d?.kind !== "log" && alive()) load().catch(() => {}); }, 500));
}
