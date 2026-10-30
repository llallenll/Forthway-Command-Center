// Cloudflare Zero Trust (Cloudflare Tunnel).
//  - Settings → Cloudflare (cloudflareSettings): the account — connect, switch, disconnect, forget.
//    Connectors and domains have their own page: #/cloudflare (views/cloudflare-page.js).
//  - The per-domain delivery picker (Direct vs Cloudflare Tunnel) shared by the website wizard
//    (Domains step) and a website's Domains & SSL tab.
// Every user-supplied string goes through html``.
import { html, raw, mount, $, on, plural, toast, toastError, confirmDialog, openModal, debounce } from "../util.js";
import { icon } from "../icons.js";
import { get, post } from "../api.js";

export const CF_SETTINGS = "#/settings/cloudflare"; // the Cloudflare account
export const CF_PAGE = "#/cloudflare"; // connectors (tunnels) + domains

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
 * D = { domains: [], hosts: Set(tunnel hostnames), tunnelId, tunnelFor: { hostname: tunnelId }, opts (from loadCfOptions) | null }
 * Domains not in `hosts` are Direct. `tunnelId` is the website's tunnel; `tunnelFor` holds the
 * domains that go through another one (a domain in another Cloudflare account needs a tunnel there).
 */
export function cfUsable(D) { return !!D.opts && !D.opts.unavailable && (D.opts.connected || (D.opts.tunnels || []).length > 0); }
export function tunnelHosts(D) { return D.domains.filter((d) => D.hosts.has(d)); }
export function tunnelOfHost(D, h) { return D.tunnelFor?.[h] || D.tunnelId || ""; }
/** Picker state from a saved site.cloudflare. */
export function savedDelivery(domains, cf) {
  const on = cf?.enabled ? cf : { tunnelId: "", hostnames: [] };
  return { domains, hosts: new Set(on.hostnames || []), tunnelId: on.tunnelId || "", tunnelFor: { ...(on.tunnels || {}) }, opts: null };
}
/** Show a tunnel picker on each tunnelled domain (instead of one for the whole website)? */
export function perDomainTunnels(D) { return (D.opts?.tunnels || []).length > 1 && tunnelHosts(D).length > 1; }

/** Give every tunnelled domain a tunnel that can carry it: one in its own account, preferring the website's. */
export function pickDefaultTunnel(D) {
  const all = D.opts?.tunnels || [];
  if (!all.length) return;
  D.tunnelFor ||= {};
  const best = (acct) => {
    const fit = acct ? all.filter((x) => x.accountId === acct) : [];
    const t = fit.length ? fit : all;
    return (t.find((x) => x.connectedHere) || t.find((x) => x.local) || t[0])?.id || "";
  };
  const fits = (id, acct) => { const t = all.find((x) => x.id === id); return !!t && (!acct || !t.accountId || t.accountId === acct); };
  const hosts = tunnelHosts(D);
  const firstAcct = hosts.length ? zoneAccount(D.opts, hosts[0]) : null;
  if (!fits(D.tunnelId, firstAcct)) D.tunnelId = best(firstAcct) || D.tunnelId || "";
  for (const h of hosts) {
    const acct = zoneAccount(D.opts, h);
    if (D.tunnelFor[h] && fits(D.tunnelFor[h], acct)) continue;
    delete D.tunnelFor[h];
    if (!fits(D.tunnelId, acct)) D.tunnelFor[h] = best(acct);
  }
  for (const h of Object.keys(D.tunnelFor)) if (!D.hosts.has(h) || D.tunnelFor[h] === D.tunnelId) delete D.tunnelFor[h];
}
export function deliveryPayload(D) {
  const hostnames = tunnelHosts(D);
  const tunnelId = hostnames.length ? tunnelOfHost(D, hostnames[0]) : "";
  if (!hostnames.length || !tunnelId) return { enabled: false, tunnelId: "", hostnames: [] };
  const tunnels = {};
  for (const h of hostnames) if (tunnelOfHost(D, h) && tunnelOfHost(D, h) !== tunnelId) tunnels[h] = tunnelOfHost(D, h);
  return { enabled: true, tunnelId, hostnames, ...(Object.keys(tunnels).length ? { tunnels } : {}) };
}
/** The tunnels the tunnelled domains use, in order of first use. */
export function usedTunnels(D) {
  const ids = [...new Set(tunnelHosts(D).map((h) => tunnelOfHost(D, h)).filter(Boolean))];
  return ids.map((id) => (D.opts?.tunnels || []).find((t) => t.id === id) || { id, name: id.slice(0, 8) });
}

/** Why this delivery choice can't be saved yet, or null. */
export function validateDelivery(D) {
  const hosts = tunnelHosts(D);
  if (!hosts.length) return null;
  if (!D.opts) return "Still checking your Cloudflare connection — try again in a second.";
  if (D.opts.error && !D.opts.tunnels?.length) return `Cloudflare: ${D.opts.error}`;
  if (!cfUsable(D)) return "Cloudflare isn't connected. Connect it in Settings → Cloudflare, or deliver these domains directly.";
  if (!D.opts.tunnels.length) return "There's no Cloudflare tunnel yet. Add a connector on the Cloudflare page (sidebar → Cloudflare).";
  const unpicked = hosts.find((h) => !tunnelOfHost(D, h));
  if (unpicked) return `Pick which Cloudflare tunnel delivers ${unpicked}.`;
  if (D.opts.connected) {
    const missing = hosts.filter((h) => !zoneOf(D.opts.zones, h));
    if (missing.length) return `${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} in your Cloudflare account — add the domain to Cloudflare, or switch ${missing.length === 1 ? "it" : "them"} to Direct.`;
    for (const h of hosts) {
      const t = D.opts.tunnels.find((x) => x.id === tunnelOfHost(D, h));
      const acct = zoneAccount(D.opts, h);
      if (t?.accountId && acct && acct !== t.accountId) return `${h} is in the Cloudflare account ${accountName(D.opts, acct)}, but tunnel “${t.name}” is in ${accountName(D.opts, t.accountId)}. A tunnel only carries domains of its own account — pick a tunnel in ${accountName(D.opts, acct)} for it.`;
    }
  }
  return null;
}

/** The account a hostname's zone is in (options.zoneAccounts), or null. */
export function zoneAccount(o, host) { const z = zoneOf(o?.zones, host); return z ? o.zoneAccounts?.[z] || null : null; }
const accountName = (o, id) => (o?.accounts || []).find((a) => a.id === id)?.name || "another account";
const multiAccount = (o) => (o?.accounts || []).length > 1;

/** <option>s for a tunnel <select>, grouped by account when there are several. */
function tunnelOptions(o, selected, label = (x) => tunnelLabel(x, o)) {
  const opt = (x) => html`<option value="${x.id}" ${x.id === selected ? raw("selected") : ""}>${label(x)}</option>`;
  if (!multiAccount(o)) return html`${o.tunnels.map(opt)}`;
  const groups = new Map();
  for (const x of o.tunnels) { const k = x.accountName || "Other"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
  return html`${[...groups].map(([name, list]) => html`<optgroup label="${name}">${list.map(opt)}</optgroup>`)}`;
}

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
      <a href="${CF_PAGE}" target="_blank" rel="noopener">Add a connector on the Cloudflare page</a> (opens in a new tab), then check again.<div class="btn-row mt-12">${recheck}</div></div></div>`;
  }
  const used = usedTunnels(D);
  const remote = used.filter((x) => x.id && o.tunnels.some((y) => y.id === x.id) && !x.local);
  const remoteNote = remote.length ? html`<div class="note warn mt-12">${icon("alert")}<div>This panel doesn't run a connector for <b>${remote.map((x) => x.name).join(", ")}</b>. Routes will be written, but traffic only flows while a connector for ${remote.length === 1 ? "this tunnel" : "these tunnels"} is running somewhere — start one on the <a href="${CF_PAGE}" target="_blank" rel="noopener">Cloudflare page</a>.</div></div>` : "";
  const sim = o.simulatedApi ? " · simulated" : "";
  if (perDomainTunnels(D)) {
    const accts = [...new Set(used.map((x) => x.accountName).filter(Boolean))];
    return html`<div class="cf-acct muted small" style="padding-bottom:0">${icon("check", "xs")} Each domain uses the tunnel picked on its row${used.length > 1 ? html` · ${plural(used.length, "tunnel")}` : ""}${multiAccount(o) && accts.length ? html` in <b>${accts.join(", ")}</b>` : ""}${sim}</div>${remoteNote}`;
  }
  const t = o.tunnels.find((x) => x.id === D.tunnelId);
  return html`<div class="cf-tunnel">
    <div class="field" style="flex:1;min-width:220px"><label>Tunnel</label>
      ${o.tunnels.length > 1 ? html`<select class="select" data-cftunnel>${tunnelOptions(o, D.tunnelId)}</select>`
        : html`<div class="cf-static">${icon("cloud", "sm")}<span class="strong">${o.tunnels[0].name}</span><span class="muted small">${tunnelLabel(o.tunnels[0]).slice(o.tunnels[0].name.length + 3)}</span></div>`}</div>
    <div class="cf-acct muted small">${o.connected ? html`${icon("check", "xs")} Account <b>${(t?.accountName) || o.accountName || "connected"}</b> · ${plural(multiAccount(o) && t?.accountId ? o.zones.filter((z) => o.zoneAccounts?.[z] === t.accountId).length : o.zones.length, "zone")}` : html`${icon("alert", "xs")} Connector token only — add the public hostnames in the Cloudflare dashboard`}${sim}</div>
  </div>${remoteNote}`;
}

/** One row per domain with a Direct / Cloudflare Tunnel switch. `routes`: [{ hostname, status, error, code }] from the server. */
export function domainRows(D, { removable = true, routes = null, mainHost = "" } = {}) {
  if (!D.domains.length) return html`<div class="cf-rows"><div class="list-item"><span class="muted small">No domains yet.</span></div></div>`;
  const usable = cfUsable(D);
  const o = D.opts;
  const perRow = perDomainTunnels(D);
  return html`<div class="cf-rows">${D.domains.map((d, i) => {
    const tun = D.hosts.has(d);
    const tunnelAcct = tun ? o?.tunnels?.find((x) => x.id === tunnelOfHost(D, d))?.accountId || null : null;
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
        ${tun && perRow ? html`<select class="select cf-row-tunnel" data-cfhosttunnel="${d}" aria-label="Tunnel for ${d}">${tunnelOptions(o, tunnelOfHost(D, d), (x) => x.name)}</select>` : ""}
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
  on(root, "change", "[data-cftunnel]", (e) => { D.tunnelId = e.target.value; D.tunnelFor = {}; repaint?.(); onChange?.(); });
  on(root, "change", "[data-cfhosttunnel]", (e) => {
    const h = e.target.dataset.cfhosttunnel;
    D.tunnelFor ||= {};
    D.tunnelFor[h] = e.target.value;
    if (h === tunnelHosts(D)[0]) { // the first domain's tunnel is the website's tunnel
      const others = Object.fromEntries(tunnelHosts(D).slice(1).map((x) => [x, tunnelOfHost(D, x)]));
      D.tunnelId = e.target.value;
      D.tunnelFor = Object.fromEntries(Object.entries(others).filter(([, id]) => id !== D.tunnelId));
    } else if (e.target.value === D.tunnelId) delete D.tunnelFor[h];
    repaint?.(); onChange?.();
  });
  on(root, "click", "[data-cfrecheck]", async (e, b) => {
    b.classList.add("loading");
    D.opts = await loadCfOptions();
    pickDefaultTunnel(D);
    repaint?.(); onChange?.();
  });
}

/* ───────── Settings → Cloudflare: the account only ─────────
   Connectors and domains live on their own page (#/cloudflare, views/cloudflare-page.js).
   Routes, "Publish this panel" and "Publish phpMyAdmin" are no longer in the UI; their API
   routes stay, so anything already published keeps working (shown read-only below). */

export async function cloudflareSettings(box, ctx) {
  let S = null, domainCount = null, loginTimer = null;
  const alive = () => ctx.alive();
  const load = async () => {
    const [s, d] = await Promise.all([get("/api/cloudflare"), get("/api/cloudflare/domains").catch(() => null)]);
    S = s; domainCount = d ? (d.items || []).length : null;
    if (alive()) paint();
  };

  const paint = () => {
    const via = S.connected ? (S.viaLogin ? "Signed in with Cloudflare" : "API token") : S.connectors.length ? "Connector token only" : "Not connected";
    const tone = S.connected ? "ok" : S.connectors.length ? "warn" : "off";
    const running = S.connectors.filter((c) => c.connected).length;
    const published = [S.panel && { what: "The panel", ...S.panel }, S.phpmyadmin && { what: "phpMyAdmin", ...S.phpmyadmin }].filter(Boolean);
    mount(box, html`
      ${S.dryRun ? html`<div class="note warn">${icon("alert")}<div><b>Dry run.</b> cloudflared is never started or downloaded — connectors are simulated.${S.simulatedApi ? html` The Cloudflare API is simulated too (zones <span class="mono">example.com</span>, <span class="mono">example.org</span>; “Add domain” adds <span class="mono">example.net</span>, then <span class="mono">example.ca</span> from a second, shared account); nothing leaves this machine.` : ""}</div></div>` : ""}

      <div class="card">
        <div class="card-head" style="flex-wrap:wrap">
          <div class="row" style="flex:1 1 260px;min-width:0;gap:12px"><span class="cf-badge-ico ${tone}">${icon("cloud")}</span>
            <div style="min-width:0"><h3>Cloudflare account</h3><div class="sub">${S.connected ? html`${S.accountName || S.accountId} · ${via}${S.tokenHint ? html` <span class="mono">${S.tokenHint}</span>` : ""}` : "Deliver websites through Cloudflare — no open ports, HTTPS by Cloudflare."}</div></div></div>
          <div class="right"><span class="status"><span class="dot ${tone}"></span>${via}</span></div>
        </div>
        ${S.error ? html`<div class="card-body" style="padding-bottom:0"><div class="error-box">${icon("alert")}<div>${S.error}</div></div></div>` : ""}
        ${S.warning ? html`<div class="card-body" style="padding-bottom:0"><div class="note warn">${icon("alert")}<div>${S.warning}</div></div></div>` : ""}
        <div class="card-body">${S.connected ? html`
          <dl class="kv">
            <dt>Account</dt><dd>${(S.accounts || []).length > 1 ? html`<select class="select" data-account style="max-width:340px">${S.accounts.map((a) => html`<option value="${a.id}" ${a.id === S.accountId ? raw("selected") : ""}>${a.name}</option>`)}</select>` : html`${S.accountName || S.accountId}`}</dd>
            <dt>Connected with</dt><dd>${via}</dd>
            ${others().length ? html`<dt>Other accounts</dt><dd>${others().map((a) => a.name).join(", ")} <span class="muted small">— reached through domains added on the <a href="${CF_PAGE}">Cloudflare page</a></span></dd>` : ""}
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

      <a class="card cf-moved" href="${CF_PAGE}">
        <span class="cf-badge-ico ${S.connectors.length ? "ok" : ""}">${icon("globe")}</span>
        <div style="flex:1;min-width:0"><div class="strong">Connectors and domains have their own page</div>
          <div class="muted small">${S.connectors.length ? `${running} of ${plural(S.connectors.length, "connector")} running` : "No connectors yet"}${domainCount != null && S.connected ? ` · ${plural(domainCount, "domain")}` : ""} — view and add them under <b>Cloudflare</b> in the sidebar.</div></div>
        <span class="btn btn-sm">Open${icon("arrowRight", "sm")}</span>
      </a>

      ${published.length ? html`<div class="note cf-published">${icon("info")}<div>${published.map((p) => html`<div><b>${p.what}</b> is published through Cloudflare on <a class="mono" href="https://${p.hostname}" target="_blank" rel="noopener noreferrer">${p.hostname}</a>${p.route?.status && p.route.status !== "active" ? html` <span class="muted">(${p.route.status === "error" ? "route error" : p.route.status === "manual" ? "add it in the Cloudflare dashboard" : "pending"})</span>` : ""}.</div>`)}
        <div class="muted small mt-8">Set up earlier; it keeps working. To take it down, remove that public hostname from the tunnel in the Cloudflare dashboard, or use <b>Forget Cloudflare</b> below.</div></div></div>` : ""}

      ${S.configured || S.connectors.length || S.routes ? html`<div class="card cf-danger">
        <div class="card-head"><div><h3>Forget everything</h3><div class="sub">Stops every connector and deletes the panel's Cloudflare credentials, connector tokens, login certificate and route records. Tunnels, routes and DNS records stay in your Cloudflare account.</div></div>
          <div class="right"><button class="btn btn-danger" data-reset>${icon("trash")}Forget Cloudflare</button></div></div></div>` : ""}`);
  };

  /** Accounts other than the main one that the panel reaches (through domain credentials). */
  function others() { return (S.managedAccounts || []).filter((a) => !a.main); }

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
    try { const r = await post("/api/cloudflare/connectors", { token }); toast("Connector added", r.startError ? "warn" : "ok", { msg: r.startError || "Starting it now — see it on the Cloudflare page." }); load(); }
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
