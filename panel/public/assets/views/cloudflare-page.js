// Cloudflare page (#/cloudflare): the connectors that carry traffic to Cloudflare and the domains
// the panel can route. The Cloudflare account itself is connected in Settings → Cloudflare.
// Written for a non-expert owner: every Cloudflare word gets a one-line explanation.
// Every user-supplied string goes through html``.
import { html, raw, mount, $, on, ago, plural, toast, toastError, confirmDialog, formDialog, openModal, openMenu, emptyState, errorState, skeletonRows, debounce } from "../util.js";
import { icon } from "../icons.js";
import { get, post, patch, del } from "../api.js";
import { pageHead } from "../components.js";
import { onEvent } from "../events.js";
import { foldCard, moreList } from "../fold.js";
import { CF_SETTINGS } from "./cloudflare.js";

const INTRO = "Cloudflare puts your websites on the internet without opening any ports on your servers, and it handles HTTPS for them. A connector on your server carries the traffic; your domains decide which addresses visitors use.";

/* ───────── connector status ───────── */
const tone = (c) => (c.fatal || c.lastError ? "err" : c.connected ? "ok" : c.running ? "warn" : "off");
const statusText = (c) => (c.fatal ? "Stopped — Cloudflare rejected its token" : c.connected ? "Running" : c.running ? "Starting…" : c.lastError ? "Error" : "Stopped");
const replicaTone = (r) => (r.running && r.connections > 0 ? "ok" : r.running ? "warn" : "off");
/** Connectors whose only copy runs on the main server. */
const mainOnly = (list) => list.filter((c) => Array.isArray(c.replicas) && c.replicas.length && c.replicas.every((r) => r.serverId === "main"));

/* ───────── domain status ───────── */
const zoneTone = (z) => (z.error ? "err" : z.status === "active" ? "ok" : "warn");
const zoneText = (z) => (z.error ? "Can't reach it" : z.status === "active" ? "Active" : z.status === "pending" ? "Waiting for nameservers" : z.status || "Unknown");
const inZone = (host, zone) => host === zone || host.endsWith("." + zone);

export default async function cloudflarePage(ctx) {
  const { root } = ctx;
  ctx.crumbs([{ label: "Cloudflare" }]);
  const settingsBtn = html`<a class="btn" href="${CF_SETTINGS}">${icon("settings")}Account settings</a>`;
  mount(root, html`${pageHead("Cloudflare", INTRO, settingsBtn)}<div class="stack" data-cfbody>${skeletonRows(3, 120)}</div>`);
  const body = $("[data-cfbody]", root);

  let S = null, D = null, sites = [], servers = [], logOff = null;
  const alive = () => ctx.alive();

  const load = async () => {
    const [s, d, si, sv] = await Promise.all([
      get("/api/cloudflare"),
      get("/api/cloudflare/domains").catch((e) => ({ error: e.message, items: [], sources: [] })),
      get("/api/sites").then((r) => r.items || []).catch(() => []),
      get("/api/servers").then((r) => r.items || []).catch(() => []),
    ]);
    S = s; D = d; sites = si; servers = sv;
    if (alive()) paint();
  };

  /* ── helpers over the loaded state ── */
  const others = () => (S.managedAccounts || []).filter((a) => !a.main);
  const multi = () => others().length > 0;
  const acctName = (id) => (S.managedAccounts || []).find((a) => a.id === id)?.name || "";
  const tunnelOf = (c) => (S.tunnels || []).find((t) => t.id === c.cfId) || null;
  const spareTunnels = () => {
    const here = new Set(S.connectors.map((c) => c.cfId).filter(Boolean));
    return (S.tunnels || []).filter((t) => !here.has(t.id) && t.remotelyManaged);
  };
  /** Websites whose traffic goes through this tunnel. */
  const sitesOnTunnel = (id) => (id ? sites.filter((s) => s.cloudflare?.enabled && (s.cloudflare.tunnelId === id || Object.values(s.cloudflare.tunnels || {}).includes(id))) : []);
  /** Websites with at least one domain on this zone. */
  const sitesOnZone = (zone) => sites.filter((s) => (s.domains || []).some((h) => inZone(h, zone)));
  const mainServer = () => servers.find((s) => s.role === "main");
  const edgeServers = () => servers.filter((s) => s.role !== "main" && s.edge?.enabled);
  const siteLinks = (list) => html`${list.slice(0, 4).map((s) => html`<a class="cf-site" href="#/sites/${s.id}">${icon("globe", "xs")}${s.name}</a>`)}${list.length > 4 ? html`<span class="muted small">+${list.length - 4} more</span>` : ""}`;

  /* ───────── paint ───────── */
  const paint = () => {
    const hasAccount = !!S.connected;
    const anything = hasAccount || S.connectors.length > 0;
    mount(body, html`
      ${S.dryRun ? html`<div class="note warn">${icon("alert")}<div><b>Dry run.</b> Connectors are simulated — nothing is started or downloaded.${S.simulatedApi ? " The Cloudflare account is simulated too; nothing leaves this machine." : ""}</div></div>` : ""}
      ${S.error ? html`<div class="error-box">${icon("alert")}<div>${S.error}</div></div>` : ""}
      ${S.warning ? html`<div class="note warn">${icon("alert")}<div>${S.warning}</div></div>` : ""}
      ${anything ? html`${accountStrip()}${flow()}${connectorsCard()}${domainsCard()}` : notConnected()}`);
  };

  function notConnected() {
    return html`<div class="card cf-hero">${emptyState({
      ico: "cloud", title: "Connect your Cloudflare account first",
      text: html`Your Cloudflare account lives in <b>Settings → Cloudflare</b>. Sign in there once (it takes a minute) and come back here to add connectors and domains. A free Cloudflare plan is enough.`,
      action: html`<a class="btn btn-primary" href="${CF_SETTINGS}">${icon("settings")}Connect in Settings</a><a class="btn" href="https://dash.cloudflare.com/sign-up" target="_blank" rel="noopener noreferrer">${icon("external")}No account? Sign up free</a>`,
    })}${flow(true)}</div>`;
  }

  function accountStrip() {
    const via = S.connected ? (S.viaLogin ? "Signed in with Cloudflare" : "Connected with an API token") : "Connectors run from pasted tokens";
    return html`<div class="card cf-strip">
      <span class="cf-badge-ico ${S.connected ? "ok" : "warn"}">${icon("cloud")}</span>
      <div class="cf-strip-main"><div class="strong">${S.connected ? html`Cloudflare account: ${S.accountName || S.accountId}` : "No Cloudflare account connected"}</div>
        <div class="muted small">${via}${multi() ? html` · also reaches ${others().map((a) => a.name).join(", ")}` : ""}${!S.connected ? " — connect one to add domains and create tunnels from here." : ""}</div></div>
      <div class="cf-strip-stats">
        <span><b class="num">${S.connectors.filter((c) => c.connected).length}</b>/<span class="num">${S.connectors.length}</span> connectors running</span>
        ${S.connected ? html`<span><b class="num">${(D?.items || []).length}</b> ${(D?.items || []).length === 1 ? "domain" : "domains"}</span>` : ""}
      </div>
      <a class="btn btn-sm" href="${CF_SETTINGS}">${S.connected ? "Manage account" : html`${icon("plus")}Connect account`}</a>
    </div>`;
  }

  /** The three moving parts, in one line. */
  function flow(inHero = false) {
    const step = (ico, title, text) => html`<div class="cf-step"><span class="cf-step-ico">${icon(ico, "sm")}</span><div><div class="strong">${title}</div><div class="muted small">${text}</div></div></div>`;
    const arrow = html`<span class="cf-step-arrow" aria-hidden="true">${icon("arrowRight", "sm")}</span>`;
    return html`<div class="cf-flow ${inHero ? "in-hero" : ""}" aria-label="How Cloudflare delivers your websites">
      ${step("globe", "Your domain", "Lives on Cloudflare, which answers for it and gives it HTTPS.")}${arrow}
      ${step("cloud", "Tunnel", "A private road from Cloudflare to your server. Nothing is opened on the server.")}${arrow}
      ${step("server", "Connector", "A small program on your server that keeps the road open and passes visitors to your website.")}
    </div>`;
  }

  function connectorsCard() {
    const list = S.connectors;
    const b = S.binary || {};
    const install = !b.installed && !b.simulated && b.supported ? html`<button class="btn btn-sm" data-install>${icon("download")}Install cloudflared</button>` : "";
    const row = (c) => {
      const t = tunnelOf(c);
      const carried = sitesOnTunnel(c.cfId);
      const reps = Array.isArray(c.replicas) && c.replicas.length ? c.replicas : null;
      return html`<div class="list-item cf-conn">
        <span class="li-ico ${c.connected ? "cf-ico-tun" : ""}">${icon("cloud", "sm")}</span>
        <div class="li-main">
          <div class="li-title">${c.name}</div>
          <div class="li-sub">Tunnel${t?.name && t.name !== c.name ? html` <b>${t.name}</b>` : ""}${multi() && (t?.accountName || c.accountId) ? html` · ${t?.accountName || acctName(c.accountId) || "another account"}` : ""}${c.cfId ? html` <span class="mono muted">${c.cfId.slice(0, 8)}</span>` : ""}${c.running && c.startedAt ? html` · up ${ago(c.startedAt).replace(/ ago$/, "")}` : ""}</div>
          ${c.lastError ? html`<div class="li-sub cf-err cf-wrap">${icon("alert", "xs")} ${c.lastError}</div>` : ""}
          <div class="cf-meta">
            <span class="cf-meta-label">Runs on</span>
            ${reps ? reps.map((r) => html`<span class="cf-replica" title="${r.serverName || r.serverId}: ${!r.running ? "not running" : r.connections > 0 ? plural(r.connections, "connection") + " to Cloudflare" : "starting"}"><span class="dot ${replicaTone(r)}"></span>${r.serverName || r.serverId}<span class="muted">${r.running ? (r.connections > 0 ? "" : " · starting") : " · off"}</span></span>`)
              : html`<span class="cf-replica"><span class="dot ${tone(c)}"></span>${mainServer()?.name || "This server"}</span>`}
          </div>
          ${carried.length ? html`<div class="cf-meta"><span class="cf-meta-label">Carries</span>${siteLinks(carried)}</div>` : ""}
        </div>
        <div class="li-right">
          <span class="status"><span class="dot ${tone(c)}"></span>${statusText(c)}</span>
          ${c.running ? html`<button class="btn btn-sm" data-cstop="${c.id}">${icon("stop")}<span class="hide-sm">Stop</span></button>` : html`<button class="btn btn-sm" data-cstart="${c.id}">${icon("play")}<span class="hide-sm">Start</span></button>`}
          <button class="icon-btn ghost sm" data-cmenu="${c.id}" aria-label="More for ${c.name}">${icon("more", "sm")}</button>
        </div></div>`;
    };
    const mo = mainOnly(list);
    const content = html`
      ${list.length ? html`<div class="list">${moreList(list, row, { id: "cf.connectors", limit: 5, noun: "connectors" })}</div>`
        : html`<div class="card-body">${emptyState({ ico: "cloud", title: "No connectors yet", sm: true,
          text: S.connected ? "Add one and the panel creates a tunnel in your Cloudflare account and starts its connector on this server — one click." : "Paste a connector token from the Cloudflare dashboard, or connect your account in Settings for the one-click way.",
          action: html`<button class="btn btn-primary" data-addconn>${icon("plus")}Add connector</button>` })}</div>`}
      ${mo.length ? html`<div class="card-body" style="padding-top:0"><div class="note warn cf-mainonly">${icon("alert")}<div style="flex:1;min-width:0"><b>${mo.length === list.length ? "Your connectors run" : html`${mo.map((c) => c.name).join(", ")} ${mo.length === 1 ? "runs" : "run"}`} only on the main server.</b> If it goes down, the websites behind ${mo.length === 1 ? "it" : "them"} go down too. Mark another server as an <i>edge node</i> and it runs a copy automatically.</div>
        <a class="btn btn-sm" href="#/servers">${icon("server")}Servers</a></div></div>` : ""}
      <div class="card-foot"><span class="muted small">${b.simulated ? "cloudflared (Cloudflare's connector program) is simulated." : b.installed ? html`cloudflared ${b.version || ""} is installed on this server.` : "cloudflared (Cloudflare's connector program) is downloaded the first time a connector starts."}</span></div>`;
    return foldCard({
      cls: "cf-fold", id: "cf.connectors", title: "Connectors", count: list.length,
      sub: "A connector is a small program on your server that keeps a private connection open to Cloudflare. Visitors reach your websites through it, so your server needs no open ports.",
      actions: html`${install}<button class="btn btn-sm btn-primary" data-addconn>${icon("plus")}Add connector</button>`,
      body: content,
    });
  }

  function domainsCard() {
    if (!S.connected) {
      return foldCard({ cls: "cf-fold", id: "cf.domains", title: "Domains", sub: "The domains on your Cloudflare account that websites can use.",
        body: html`<div class="card-body">${emptyState({ ico: "globe", title: "Connect your Cloudflare account to add domains", sm: true,
          text: "With only a connector token the panel can't see your domains. Connect the account in Settings, then add domains here.",
          action: html`<a class="btn btn-primary" href="${CF_SETTINGS}">${icon("settings")}Connect in Settings</a>` })}</div>` });
    }
    const items = D?.items || [];
    const row = (z) => {
      const used = sitesOnZone(z.name);
      return html`<div class="list-item cf-dom">
        <span class="li-ico">${icon("globe", "sm")}</span>
        <div class="li-main">
          <div class="li-title mono">${z.name}</div>
          <div class="li-sub">${multi() && z.accountName ? html`Account <b>${z.accountName}</b> · ` : ""}${z.source === "main" ? "Comes with your account" : `Added with ${z.sourceLabel ? z.sourceLabel.toLowerCase() : "its own sign-in"}`}</div>
          ${z.error ? html`<div class="li-sub cf-err cf-wrap">${icon("alert", "xs")} ${z.error}</div>` : z.status === "pending" ? html`<div class="li-sub cf-warn cf-wrap">${icon("info", "xs")} Point this domain's nameservers at Cloudflare (at the company you bought it from). It turns Active by itself.</div>` : ""}
          <div class="cf-meta"><span class="cf-meta-label">Used by</span>${used.length ? siteLinks(used) : html`<span class="muted small">No website yet</span>`}</div>
        </div>
        <div class="li-right">
          <span class="status"><span class="dot ${zoneTone(z)}"></span>${zoneText(z)}</span>
          ${z.removable ? html`<button class="icon-btn ghost sm" data-dommenu="${z.source}" aria-label="More for ${z.name}">${icon("more", "sm")}</button>`
            : html`<span class="icon-btn ghost sm cf-lock" title="Part of your main Cloudflare account — remove it in Cloudflare, or disconnect the account in Settings.">${icon("lock", "sm")}</span>`}
        </div></div>`;
    };
    return foldCard({
      cls: "cf-fold", id: "cf.domains", title: "Domains", count: items.length,
      sub: "Domains on Cloudflare that your websites can use. Once a domain is here, the panel creates its DNS records and HTTPS for you when a website uses it.",
      actions: html`<button class="btn btn-sm btn-primary" data-adddomain>${icon("plus")}Add domain</button>`,
      body: html`
        ${D?.error ? html`<div class="card-body" style="padding-bottom:0"><div class="error-box">${icon("alert")}<div>${D.error}</div></div></div>` : ""}
        ${items.length ? html`<div class="list">${moreList(items, row, { id: "cf.domains", limit: 6, noun: "domains" })}</div>`
          : html`<div class="card-body">${emptyState({ ico: "globe", title: "No domains yet", sm: true, text: "Add a domain that's on your Cloudflare account, then pick “Cloudflare” for it when you set up a website.",
            action: html`<button class="btn btn-primary" data-adddomain>${icon("plus")}Add domain</button>` })}</div>`}
        <div class="card-foot cf-foot"><span class="muted small">Not on Cloudflare yet? <a href="${D?.addSiteUrl || "https://dash.cloudflare.com/"}" target="_blank" rel="noopener noreferrer">Add it in Cloudflare</a> first, then add it here.</span></div>`,
    });
  }

  const busy = (b, v) => { if (!b) return; b.classList.toggle("loading", v); b.disabled = v; };

  try { await load(); }
  catch (e) {
    if (!alive()) return;
    mount(body, e.status === 404 ? html`<div class="card">${emptyState({ ico: "cloud", title: "Cloudflare support isn't installed on this panel", text: "Update the panel to use Cloudflare." })}</div>` : errorState(e));
    $("[data-retry]", body)?.addEventListener("click", () => ctx.reload());
    return;
  }

  /* ───────── connectors ───────── */
  on(body, "click", "[data-install]", async (e, b) => {
    busy(b, true);
    try { await post("/api/cloudflare/install"); toast("cloudflared installed", "ok"); load(); } catch (ex) { toastError(ex, "Couldn't install cloudflared"); busy(b, false); }
  });
  on(body, "click", "[data-addconn]", () => addConnector());
  on(body, "click", "[data-cstart],[data-cstop]", async (e, b) => {
    const id = b.dataset.cstart || b.dataset.cstop;
    busy(b, true);
    try { await post(`/api/cloudflare/connectors/${id}/${b.dataset.cstart ? "start" : "stop"}`); await load(); } catch (ex) { toastError(ex); busy(b, false); }
  });
  on(body, "click", "[data-cmenu]", (e, b) => {
    const c = S.connectors.find((x) => x.id === b.dataset.cmenu);
    if (!c) return;
    openMenu(b, [
      { label: "View log", icon: "fileText", onClick: () => connectorLog(c) },
      ...(c.running ? [{ label: "Restart", icon: "restart", onClick: async () => { try { await post(`/api/cloudflare/connectors/${c.id}/restart`); toast("Restarting", "ok"); load(); } catch (ex) { toastError(ex); } } }] : []),
      { label: "Rename", icon: "edit", onClick: async () => { const r = await formDialog({ title: "Rename connector", fields: [{ name: "name", label: "Name", value: c.name, required: true, attrs: 'maxlength="60"' }], onSubmit: (v) => patch(`/api/cloudflare/connectors/${c.id}`, { name: v.name }) }); if (r) load(); } },
      { label: c.autoStart ? "Don't start automatically" : "Start automatically", icon: "power", onClick: async () => {
        try { await patch(`/api/cloudflare/connectors/${c.id}`, { autoStart: !c.autoStart }); toast(c.autoStart ? "Won't start by itself" : "Starts with the panel", "ok", { msg: c.autoStart ? "Edge-node servers stop running a copy too." : "Edge-node servers run a copy too." }); load(); } catch (ex) { toastError(ex); }
      } },
      { sep: true },
      { label: "Remove connector", icon: "trash", danger: true, onClick: async () => {
        const carried = sitesOnTunnel(c.cfId);
        const ok = await confirmDialog({ title: `Remove ${c.name}?`, danger: true, confirmText: "Remove",
          message: `The connector stops and the panel forgets its token. The tunnel stays in your Cloudflare account.${carried.length ? ` ${carried.map((s) => s.name).join(", ")} ${carried.length === 1 ? "goes" : "go"} offline until a connector for this tunnel runs again.` : ""}` });
        if (!ok) return;
        try { await del(`/api/cloudflare/connectors/${c.id}`); toast("Connector removed", "ok"); load(); } catch (ex) { toastError(ex); }
      } },
    ]);
  });

  async function connectorLog(c) {
    const m = openModal({ title: `${c.name} — log`, sub: "What the connector program (cloudflared) printed most recently.", ico: "fileText", size: "xl",
      body: html`<pre class="code wrap" data-log style="min-height:300px;max-height:60vh"><span class="muted">Loading…</span></pre>`,
      foot: html`<button class="btn" data-close>Close</button>` });
    const pre = $("[data-log]", m.el);
    try {
      const r = await get(`/api/cloudflare/connectors/${c.id}/logs?lines=300`);
      pre.textContent = r.lines.length ? r.lines.join("\n") + "\n" : c.running ? "No output yet.\n" : "The connector isn't running, so there's nothing to show. Start it and open the log again.\n";
      pre.scrollTop = pre.scrollHeight;
    } catch (ex) { pre.textContent = `Couldn't load the log: ${ex.message}`; }
    logOff?.();
    logOff = onEvent("cloudflare", (d) => { if (d?.kind === "log" && d.id === c.id) { pre.textContent += d.line + "\n"; pre.scrollTop = pre.scrollHeight; } });
    m.result.then(() => { logOff?.(); logOff = null; });
  }
  ctx.cleanup(() => logOff?.());

  /** Add connector: create a tunnel, run one you already have, or paste a connector token. */
  function addConnector() {
    const spare = spareTunnels();
    const ways = S.connected
      ? [
          { id: "new", ico: "plus", title: "Create a new tunnel", desc: "Recommended. The panel makes a tunnel in your Cloudflare account and starts its connector." },
          ...(spare.length ? [{ id: "existing", ico: "link", title: "Use a tunnel you already have", desc: `${plural(spare.length, "tunnel")} in your account ${spare.length === 1 ? "has" : "have"} no connector on this panel.` }] : []),
          { id: "token", ico: "token", title: "Paste a connector token", desc: "For a tunnel you set up yourself in the Cloudflare dashboard." },
        ]
      : [{ id: "token", ico: "token", title: "Paste a connector token", desc: "From the Cloudflare dashboard: Zero Trust → Networks → Tunnels → your tunnel." }];
    let way = ways[0].id;
    const main = mainServer(), edges = edgeServers();
    const host = (ctx.state.settings?.hostname || main?.name || "server").split(".")[0];
    const fields = {
      new: html`${multi() ? html`<div class="field"><label for="cfAcct">Cloudflare account</label><select class="select" id="cfAcct" name="accountId">${S.managedAccounts.map((a) => html`<option value="${a.id}" ${a.id === S.accountId ? raw("selected") : ""}>${a.name}</option>`)}</select><div class="hint">A tunnel can only carry domains from its own account.</div></div>` : ""}
        <div class="field"><label for="cfName">Tunnel name</label><input class="input" id="cfName" name="name" value="${/^fcc\b/.test(host) ? `${host}-tunnel` : `fcc-${host}`}" maxlength="60" autocomplete="off" spellcheck="false"/><div class="hint">Only you see this name, in the panel and in Cloudflare.</div></div>`,
      existing: html`<div class="field"><label for="cfTun">Tunnel</label><select class="select" id="cfTun" name="tunnelId">${spare.map((t) => html`<option value="${t.id}">${multi() && t.accountName ? `${t.accountName} · ` : ""}${t.name}${t.status ? ` (${t.status})` : ""}</option>`)}</select><div class="hint">The panel fetches its connector token from Cloudflare.</div></div>`,
      token: html`<div class="field"><label for="cfCName">Name</label><input class="input" id="cfCName" name="cname" value="Cloudflare Tunnel" maxlength="60" autocomplete="off"/></div>
        <div class="field"><label for="cfTok">Connector token</label><input class="input mono" id="cfTok" type="password" name="token" placeholder="eyJh…" autocomplete="off" spellcheck="false"/><div class="hint">Stored encrypted. You can also paste the whole <span class="mono">cloudflared … run &lt;token&gt;</span> line.</div></div>`,
    };
    const m = openModal({
      title: "Add a connector", ico: "cloud", size: "lg",
      sub: "Pick a tunnel for it. The connector starts right away on your server.",
      body: html`<form class="form-stack" novalidate data-addform>
        ${ways.length > 1 ? html`<div class="choice-grid cf-ways-pick" role="radiogroup" aria-label="How to add it">${ways.map((w) => html`<label class="choice ${w.id === way ? "selected" : ""}"><input type="radio" name="way" value="${w.id}" ${w.id === way ? raw("checked") : ""}/><span class="c-mark"></span><span class="c-title"><span class="c-ico">${icon(w.ico)}</span>${w.title}</span><span class="c-desc">${w.desc}</span></label>`)}</div>` : ""}
        <div data-wayfields></div>
        <div class="cf-where">
          <div class="label">Where it runs</div>
          <div class="cf-meta" style="margin-top:6px">
            <span class="cf-replica"><span class="dot ok"></span>${main?.name || "Main server"}<span class="muted"> · main</span></span>
            ${edges.map((s) => html`<span class="cf-replica"><span class="dot ${s.online ? "ok" : "off"}"></span>${s.name}<span class="muted"> · edge node</span></span>`)}
          </div>
          <div class="hint">${edges.length ? "It runs on the main server, and every edge-node server runs a copy, so websites stay up if one server goes down." : html`It runs on the main server. To keep websites up when the main server is down, mark another server as an edge node in <a href="#/servers">Servers</a> — it then runs a copy automatically.`}</div>
          <label class="switch mt-12"><input type="checkbox" name="autoStart" checked/><span class="track"></span>Start automatically (with the panel, and on edge nodes)</label>
        </div>
        <div class="error-box" data-err hidden></div><button type="submit" hidden></button>
      </form>`,
      foot: html`<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-submit>${icon("plus")}Add connector</button>`,
      onMount(el, close) {
        const form = $("[data-addform]", el), err = $("[data-err]", el), btn = $("[data-submit]", el);
        const showWay = () => { mount($("[data-wayfields]", el), fields[way]); };
        showWay();
        form.addEventListener("change", (e) => {
          if (e.target.name !== "way") return;
          way = e.target.value;
          el.querySelectorAll(".cf-ways-pick .choice").forEach((c) => c.classList.toggle("selected", c.querySelector("input").checked));
          showWay(); err.hidden = true;
        });
        const submit = async (e) => {
          e?.preventDefault();
          const v = (n) => form.elements[n]?.value?.trim() || "";
          const autoStart = form.elements.autoStart.checked;
          let req;
          if (way === "new") { if (!v("name")) return fail("Give the tunnel a name.", "name"); req = () => post("/api/cloudflare/tunnels", { name: v("name"), accountId: v("accountId") || undefined, autoStart }); }
          else if (way === "existing") req = () => post("/api/cloudflare/tunnels", { tunnelId: v("tunnelId"), autoStart });
          else { if (!v("token")) return fail("Paste the connector token first.", "token"); req = () => post("/api/cloudflare/connectors", { name: v("cname"), token: v("token"), autoStart }); }
          btn.classList.add("loading"); btn.disabled = true; err.hidden = true;
          try { close(await req()); }
          catch (ex) { fail(ex.message); }
          finally { btn.classList.remove("loading"); btn.disabled = false; }
        };
        const fail = (msg, field) => { err.hidden = false; err.textContent = msg; if (field) form.elements[field]?.focus(); };
        form.addEventListener("submit", submit);
        btn.onclick = submit;
      },
    });
    m.result.then((r) => {
      if (!r) return;
      const name = r.tunnel?.name || r.connector?.name || "Connector";
      toast(`${name} added`, r.startError ? "warn" : "ok", { msg: r.startError || (r.connector?.autoStart === false ? "Start it when you're ready." : "It's starting now — it shows Running in a few seconds.") });
      load();
    });
  }

  /* ───────── domains ───────── */
  const domainAdded = (r) => toast(r.added?.length ? `Added ${r.added.join(", ")}` : "Domain added", "ok", {
    msg: r.accounts?.length ? `It's in another Cloudflare account (${r.accounts.join(", ")}). Add a connector with a tunnel in that account to use it.` : r.refused?.length ? r.refused.join(" ") : "It's listed under Domains. If it says “Waiting for nameservers”, finish that step at your domain company.",
  });
  on(body, "click", "[data-adddomain]", () => addDomain());
  on(body, "click", "[data-dommenu]", (e, b) => {
    const src = (D?.sources || []).find((x) => x.id === b.dataset.dommenu);
    if (!src) return;
    openMenu(b, [
      { label: src.zones.length > 1 ? `Remove ${src.zones.length} domains` : "Remove domain", icon: "trash", danger: true, onClick: async () => {
        const ok = await confirmDialog({ title: `Remove ${src.zones.join(", ")}?`, danger: true, confirmText: "Remove",
          message: `The panel forgets the sign-in that reaches ${src.zones.length === 1 ? "this domain" : "these domains"}${src.zones.length > 1 ? " (they were added together)" : ""}. Nothing changes in Cloudflare, and you can add ${src.zones.length === 1 ? "it" : "them"} again any time.` });
        if (!ok) return;
        try { await del(`/api/cloudflare/domains/${src.id}`); toast(src.zones.length > 1 ? "Domains removed" : "Domain removed", "ok"); load(); } catch (ex) { toastError(ex, "Couldn't remove it"); }
      } },
    ]);
  });

  /** Add domain: sign in to Cloudflare and pick the domain (or paste an API token). */
  function addDomain() {
    let timer = null, pending = false;
    const m = openModal({
      title: "Add a domain", ico: "globe", size: "lg",
      sub: "Let the panel manage a domain that's on Cloudflare.",
      body: html`<ol class="cf-steps">
          <li><div class="strong">Make sure the domain is on Cloudflare</div>
            <div class="muted small">If it isn't yet, <a href="${D?.addSiteUrl || "https://dash.cloudflare.com/"}" target="_blank" rel="noopener noreferrer">add it in Cloudflare</a> and change the domain's nameservers to the two Cloudflare gives you (at the company you bought the domain from).</div></li>
          <li><div class="strong">Sign in to Cloudflare and pick the domain</div>
            <div class="muted small">Cloudflare opens in a new tab. Choose the domain to add and click <b>Authorize</b>. This window notices by itself.</div>
            <div class="mt-12" data-loginbox><button class="btn btn-primary" type="button" data-startlogin>${icon("external")}Sign in to Cloudflare</button></div></li>
        </ol>
        <div class="error-box mt-12" data-err hidden></div>
        <details class="cf-alt mt-16"><summary>Use an API token instead</summary>
          <form class="form-stack mt-12" data-tokform novalidate>
            <p class="muted small" style="margin:0">Handy for several domains at once. The token needs <b>Zone · DNS · Edit</b> and <b>Zone · Zone · Read</b> (for a domain in another account, also <b>Account · Cloudflare Tunnel · Edit</b>). Stored encrypted.</p>
            <div class="input-group"><input class="input mono" type="password" name="token" placeholder="API token" autocomplete="off" spellcheck="false"/><button class="btn" type="submit" data-tokbtn>Add domains</button></div>
          </form></details>`,
      foot: html`<button class="btn btn-ghost" data-close>Close</button>`,
      onMount(el, close) {
        const err = $("[data-err]", el);
        const fail = (msg) => { err.hidden = !msg; err.textContent = msg || ""; };
        const box = $("[data-loginbox]", el);
        const startBtn = () => mount(box, html`<button class="btn btn-primary" type="button" data-startlogin>${icon("external")}${pending ? "Try again" : "Sign in to Cloudflare"}</button>`);
        el.addEventListener("click", async (e) => {
          const b = e.target.closest("[data-startlogin]");
          if (!b) return;
          b.classList.add("loading"); b.disabled = true; fail("");
          try {
            const r = await post("/api/cloudflare/domains/login");
            if (r.done) { close(r); return; }
            pending = true;
            mount(box, html`<div class="cf-wait"><a class="btn btn-primary" href="${r.url}" target="_blank" rel="noopener noreferrer">${icon("external")}Open Cloudflare</a>
              <span class="muted small"><span class="rb-spin" aria-hidden="true"></span> Waiting for you to authorize the domain in the Cloudflare tab…</span></div>`);
            clearInterval(timer);
            timer = setInterval(async () => {
              if (!alive()) return clearInterval(timer);
              try {
                const p = await get("/api/cloudflare/login");
                if (p.done) { clearInterval(timer); pending = false; close(p); }
                else if (p.error) { clearInterval(timer); fail(p.error); startBtn(); }
              } catch (ex) { clearInterval(timer); fail(ex.message); startBtn(); }
            }, 2000);
          } catch (ex) { fail(ex.message); b.classList.remove("loading"); b.disabled = false; }
        });
        $("[data-tokform]", el).addEventListener("submit", async (e) => {
          e.preventDefault();
          const token = e.target.elements.token.value.trim();
          if (!token) return fail("Paste an API token first.");
          const b = $("[data-tokbtn]", el); b.classList.add("loading"); b.disabled = true; fail("");
          try { close(await post("/api/cloudflare/domains", { token })); }
          catch (ex) { fail(ex.message); b.classList.remove("loading"); b.disabled = false; }
        });
      },
    });
    m.result.then((r) => {
      clearInterval(timer);
      if (pending) post("/api/cloudflare/login/cancel").catch(() => {});
      if (r) { domainAdded(r); load(); }
    });
  }

  /* ───────── live updates ───────── */
  ctx.on(["cloudflare"], debounce((d) => { if (d?.kind !== "log" && alive()) load().catch(() => {}); }, 500));
  // Edge copies of a connector come and go with the servers: reload when an edge's tunnel state changes.
  const edgeSig = {};
  const reloadSoon = debounce(() => { if (alive()) load().catch(() => {}); }, 800);
  ctx.on("server", (d) => {
    if (!d?.id) return;
    const sig = d.deleted ? "x" : JSON.stringify([d.online, d.edge?.enabled, (d.edgeStatus?.connectors || []).map((c) => [c.id, c.active, c.readyConnections])]);
    if (d.id in edgeSig && edgeSig[d.id] !== sig) reloadSoon();
    edgeSig[d.id] = sig;
  });
}
