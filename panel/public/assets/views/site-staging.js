// Website page → the Live build / Staging build switcher (panel/lib/staging.mjs).
//
// A website's staging build is its own website record (`stagingOf: parentId`; the
// parent has `stagingSiteId`) with its own address, variables and database that
// deploys the parent's releases. The website header's type icon is the switch:
// it opens a menu with "Live build" and "Staging build" (or "Create…"), and on
// the staging build the icon is purple. Everything else on the staging build is
// the ordinary website page working against the copy (views/site.js).
//
// Exported for site.js / site-env.js / sites.js:
//   buildSwitch(S)                 the header icon button (purple on a staging build)
//   openBuildMenu(btn, S, opts)    the Live build / Staging build menu
//   createStagingDialog(S, opts)   the "Create a staging build" dialog → navigates to it
//   removeStaging(child, opts)     typed confirm + "also drop the database" → DELETE /api/sites/:id/staging
//   stagingReleaseBtn(S, r)        "To staging" on the live site's release rows
//   stagingChip(s)                 the purple "Staging" chip on website rows
import { html, toast, toastError, confirmDialog, openMenu, formDialog } from "../util.js";
import { icon } from "../icons.js";
import { post, del } from "../api.js";
import { jobStarted, siteHealth, TYPE_LABEL } from "../components.js";

export const isStaging = (S) => !!S?.stagingOf;
export const relLabel = (r) => (r ? (r.version ? `v${r.version}` : (r.github?.sha || r.commit || r.id || "").slice(0, 7) || "unversioned") : "—");
const bare = (u) => String(u || "").replace(/^https?:\/\//, "");

/** Status of the staging build as the live site sees it (publicSite().staging, role "parent"). */
export function stagingStatus(st) {
  if (!st) return { tone: "off", text: "—" };
  if (st.deleting) return { tone: "warn", text: "Being removed" };
  if (st.deploying) return { tone: "run", text: "Deploying" };
  if (!st.currentReleaseId) return { tone: "off", text: st.busyJobId ? "First deploy running" : "Not deployed" };
  if (st.running === false) return { tone: "off", text: "Stopped" };
  if (st.running && st.healthy === false) return { tone: "err", text: "Unhealthy" };
  if (st.running) return { tone: "ok", text: st.healthy ? "Healthy" : "Running" };
  return { tone: "off", text: "Unknown" };
}

/** Default staging domain — same rule as panel/lib/staging.mjs stagingDomain(). */
export function defaultStagingDomain(domains = []) {
  const first = String((domains || [])[0] || "").trim().toLowerCase();
  if (!first) return "";
  const b = first.replace(/^\*\./, "").replace(/^www\./, "");
  return b.startsWith("staging.") ? `stg.${b}` : `staging.${b}`;
}

/* ───────── header: the type icon is the build switch ───────── */

export function buildSwitch(S) {
  const stg = isStaging(S);
  const which = stg ? "Staging build" : "Live build";
  return html`<button type="button" class="type-ico ${S.type || "node"} ${stg ? "staging" : ""} build-switch" data-buildswitch aria-haspopup="menu" aria-expanded="false"
      aria-label="${which} of ${stg ? S.staging?.parentName || "the website" : S.name} — switch between the live and staging build" title="${TYPE_LABEL[S.type] || S.type} · ${which} — click to switch">
    ${icon(S.type === "static" ? "static" : S.type === "php" ? "php" : "node")}<span class="bs-chev" aria-hidden="true">${icon("chevronDown", "xs")}</span></button>`;
}

const item = ({ stg, type, title, sub, status, current, add }) => html`<span class="bs-item">
  <span class="type-ico ${type || "node"} ${stg ? "staging" : ""} bs-ico">${icon(add ? "plus" : type === "static" ? "static" : type === "php" ? "php" : "node")}</span>
  <span class="bs-txt"><span class="bs-t">${title}</span><span class="bs-sub">${status ? html`<span class="dot ${status.tone}"></span>${status.text}<span class="dim">·</span>` : ""}<span class="${add ? "" : "mono"} ellipsis">${sub}</span></span></span>
  ${current ? html`<span class="bs-cur" title="You are here">${icon("check", "sm")}</span>` : ""}</span>`;

/**
 * The Live build / Staging build menu.
 *   S        the website on this page (live or its staging build)
 *   parent   on a staging build: the live website (publicSite), for its address and status
 *   tab      keep the same tab when switching
 */
export function openBuildMenu(btn, S, { parent = null, tab = "", servers = [], keyboard = false } = {}) {
  if (!keyboard && Date.now() - Number(btn.dataset.closedAt || 0) < 250) return; // the click whose mousedown just closed it — a toggle
  const stg = isStaging(S);
  const live = stg ? parent || { id: S.stagingOf, name: S.staging?.parentName || "Live site", type: S.type, domains: [] } : S;
  const st = stg ? null : S.staging?.role === "parent" ? S.staging : null;
  const tail = tab && tab !== "overview" ? `/${tab}` : "";
  const go = (id) => { location.hash = `#/sites/${id}${tail}`; };
  const liveStatus = live.state || live.currentReleaseId !== undefined ? siteHealth(live) : null;
  const items = [
    { label: item({ type: live.type, title: "Live build", sub: (live.domains || [])[0] || "no domain", status: liveStatus, current: !stg }), onClick: () => stg && go(live.id) },
    stg
      ? { label: item({ stg: true, type: S.type, title: "Staging build", sub: (S.domains || [])[0] || "no domain", status: siteHealth(S), current: true }), onClick: () => {} }
      : st
        ? { label: item({ stg: true, type: S.type, title: "Staging build", sub: (st.domains || [])[0] || "no domain", status: stagingStatus(st) }), onClick: () => go(st.id), disabled: !!st.deleting }
        : { label: item({ stg: true, add: true, title: "Staging build — Create…", sub: "a private copy to try changes on" }), onClick: () => createStagingDialog(S, { servers }) },
  ];
  btn.setAttribute("aria-expanded", "true");
  openMenu(btn, items, {
    align: "left", cls: "build-menu", focus: keyboard,
    head: html`<div class="menu-head"><div class="small strong">${live.name}</div><div class="tiny muted">Staging is a separate copy — changes there never touch the live site.</div></div>`,
    onClose: () => { btn.setAttribute("aria-expanded", "false"); btn.dataset.closedAt = String(Date.now()); },
  });
}

/* ───────── create ───────── */

export async function createStagingDialog(S, { servers = [] } = {}) {
  if (isStaging(S)) return null;
  const rels = (S.releases || []).filter((r) => r.available !== false);
  const liveRel = rels.find((r) => r.id === S.currentReleaseId);
  const usesDb = S.type !== "static" && (S.linkedDatabaseIds || []).length > 0;
  const nDb = (S.linkedDatabaseIds || []).length;
  const dbName = `staging_${String(S.slug || S.name || "site").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "")}`;
  const srvName = (id) => servers.find((x) => x.id === id)?.name || id;
  const own = (S.serverIds || []).length ? S.serverIds : ["main"];
  const live = (S.domains || [])[0] || "";
  const fields = [
    { name: "domain", label: "Staging address", mono: true, value: defaultStagingDomain(S.domains), placeholder: "staging.example.com",
      hint: "Point its DNS at the server like any website. Leave empty to add one later on the staging build's Domains & SSL." },
    { name: "releaseId", label: "Release to deploy", type: "select", value: liveRel?.id || rels[0]?.id || "",
      options: [...rels.slice(0, 20).map((r) => ({ value: r.id, label: `${relLabel(r)}${r.id === S.currentReleaseId ? " — live now" : ""}` })), { value: "", label: "Don't deploy yet" }],
      hint: rels.length ? "Staging deploys the live site's releases — upload or pull on the live site, then deploy any of them to staging." : "This website has no releases yet — deploy one to staging later." },
    ...(own.length > 1 ? [{ name: "serverId", label: "Runs on", type: "select", value: own[0], options: own.map((id) => ({ value: id, label: srvName(id) })), hint: "Staging isn't load balanced — it runs on one server." }] : []),
    { name: "_info", type: "html", html: html`<ul class="stg-list">
      <li>${icon("database", "sm")}<span>${S.type === "static" ? "No database — static websites don't use one."
        : usesDb ? html`Its own empty database${nDb > 1 ? "s" : ""} <span class="mono">${dbName}${nDb > 1 ? "…" : ""}</span> (with the project prefix) and user. The release's migrations or after-deploy scripts create the tables before the first build. Live data is never copied or touched.`
        : "No linked database. If its variables hold MySQL settings, a staging database is made for those too."}</span></li>
      <li>${icon("key", "sm")}<span>The live variables are copied once — live payment keys left out, database settings${live ? html` and links to <span class="mono">${live}</span>` : ""} pointed at staging. After that, staging's variables are its own.</span></li>
    </ul>` },
  ];
  let created = null;
  const r = await formDialog({
    title: `Create a staging build of ${S.name}`, ico: "layers", submitText: "Create staging build",
    intro: html`<p class="muted small" style="margin:0 0 4px;line-height:1.55">A staging build is a second copy of this website that runs next to the live one, with its own address, variables and database. Try a release or a setting there first — nothing you do on staging changes the live site.</p>`,
    fields,
    async onSubmit(v) {
      const domain = String(v.domain || "").toLowerCase();
      if (domain && !/^(\*\.)?([a-z0-9-]+\.)+[a-z0-9-]{2,}$/.test(domain)) throw new Error(`“${domain}” isn't a valid domain.`);
      if (domain && (S.domains || []).includes(domain)) throw new Error(`${domain} is the live site's address — pick another one for staging.`);
      created = await post(`/api/sites/${S.id}/staging`, { domain, deploy: !!v.releaseId, ...(v.releaseId ? { releaseId: v.releaseId } : {}), ...(v.serverId ? { serverId: v.serverId } : {}) });
      return created;
    },
  });
  if (!r) return null;
  const dbs = (r.databases || []).map((d) => d.name);
  toast("Staging build created", "ok", { msg: [dbs.length ? `Database ${dbs.join(", ")} ${r.databases.some((d) => d.created) ? "created" : "reused"}.` : "", r.job ? "The first deploy is on its way." : ""].filter(Boolean).join(" ") || `${r.staging?.name} is ready.` });
  if ((r.warnings || []).length) toast("Good to know", "info", { msg: r.warnings.join(" "), ms: 9000 });
  if (r.job?.id) jobStarted(r.job, "Deploying to staging");
  if (r.site) Object.assign(S, r.site);
  if (r.staging?.id) location.hash = `#/sites/${r.staging.id}`;
  return r;
}

/* ───────── remove (on the staging build: ⋯ menu and Settings) ───────── */

export async function removeStaging(child, { parentName = "", dbNames = [] } = {}) {
  const pName = parentName || child.staging?.parentName || "the live site";
  const r = await confirmDialog({
    title: `Remove the staging build of ${pName}?`, danger: true, ico: "trash", confirmText: "Remove staging", typed: "staging",
    message: `${child.name} is stopped and removed from its server and nginx${(child.domains || [])[0] ? `, and ${child.domains[0]} stops answering` : ""}. ${pName} itself is not touched.`,
    extra: html`<label class="check mt-16"><input type="checkbox" data-extra name="deleteFiles" checked/>Delete the staging app files on the server</label>
      ${dbNames.length ? html`<label class="check mt-12"><input type="checkbox" data-extra name="dropDatabase"/>Also drop the staging database${dbNames.length > 1 ? "s" : ""} <span class="mono">${dbNames.join(", ")}</span> — everything in ${dbNames.length > 1 ? "them" : "it"} is deleted for good</label>
        <p class="hint" style="margin:6px 0 0 26px">Leave it unticked to keep the data; it stays under Databases and is reused if you create staging again.</p>` : ""}`,
  });
  if (!r) return false;
  try {
    const job = await del(`/api/sites/${child.stagingOf || child.id}/staging?deleteFiles=${r.deleteFiles ? "1" : "0"}${r.dropDatabase ? "&dropDatabase=1" : ""}`);
    jobStarted(job, r.dropDatabase ? "Removing staging and its database" : "Removing staging");
    if (child.stagingOf) location.hash = `#/sites/${child.stagingOf}`;
    return true;
  } catch (ex) { toastError(ex, "Couldn't remove staging"); return false; }
}

/* ───────── live site's release rows: "To staging" ───────── */

export function stagingReleaseBtn(S, r) {
  const st = S.staging;
  if (st?.role !== "parent" || r.available === false || st.deleting) return "";
  const on = st.currentReleaseId === r.id;
  return html`<button class="btn btn-sm btn-stg" data-stgdeploy="${st.id}" data-stgrel="${r.id}" data-stgver="${relLabel(r)}" title="${on ? "The staging build runs this release — deploy it there again" : `Deploy this release to the staging build${st.url ? ` (${bare(st.url)})` : ""}`}">${icon("layers")}<span class="hide-sm">${on ? "Redeploy staging" : "To staging"}</span></button>`;
}
async function deployToStaging(stagingId, releaseId, label, btn) {
  btn?.classList.add("loading");
  try { jobStarted(await post(`/api/sites/${stagingId}/deploy`, { releaseId }), `Deploying ${label || "the release"} to staging`); }
  catch (e) { toastError(e, "Couldn't deploy to staging"); }
  finally { btn?.classList.remove("loading"); }
}
// One delegated handler for every page (the release rows are re-rendered often).
document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-stgdeploy]");
  if (b) deployToStaging(b.dataset.stgdeploy, b.dataset.stgrel, b.dataset.stgver, b);
});

/* ───────── website rows: a purple chip that opens the staging build ───────── */

export function stagingChip(s) {
  const st = s?.staging;
  if (st?.role !== "parent") return "";
  const t = stagingStatus(st);
  return html`<a class="stg-chip" href="#/sites/${st.id}" data-stop title="Open the staging build${st.url ? ` — ${bare(st.url)}` : ""} (${t.text})">${icon("layers", "xs")}Staging<span class="dot ${t.tone}"></span></a>`;
}

/** "Staging" badge next to the name on a staging build. */
export const stagingBadge = (S) => (isStaging(S) ? html`<span class="badge stg-badge">${icon("layers")}Staging</span>` : "");

