// Activity log: who changed what, when. Filter by project / kind / text; new
// entries arrive over SSE (`activity`) and are prepended live.
import { html, raw, mount, $, on, ago, fmtDate, fmtBytes, initials, emptyState, errorState, skeletonRows, debounce, colorOf } from "../util.js";
import { icon } from "../icons.js";
import { get, qsOf } from "../api.js";
import { pageHead, openJobLog } from "../components.js";

const PAGE = 100, MAX = 500;

const KINDS = [
  ["", "Everything"],
  ["site", "Websites"],
  ["database", "Databases"],
  ["backup", "Backups"],
  ["server", "Servers"],
  ["project", "Projects"],
  ["admin", "Admins"],
  ["settings", "Settings"],
];
const kindOf = (a) => {
  const t = a.target?.type, act = String(a.action || "");
  if (act.startsWith("backup.") && act !== "backup.settings") return "backup";
  if (t === "loadbalancer" || t === "lb") return "server";
  if (t === "job") return "site";
  return t || "";
};
const KIND_ICON = { site: "globe", database: "database", backup: "archive", server: "server", project: "folder", admin: "user", settings: "settings", loadbalancer: "balance", job: "fileText", release: "rocket" };
const KIND_LABEL = { site: "website", database: "database", backup: "backup", server: "server", project: "project", admin: "admin", settings: "settings", loadbalancer: "nginx", job: "job" };

// Readable verbs for every action the backend records. Unknown ones fall back to "a.b" → "b a".
const VERB = {
  "setup.complete": "set up the panel",
  "admin.login": "signed in",
  "admin.logout": "signed out",
  "admin.create": "added admin",
  "admin.update": "updated admin",
  "admin.delete": "removed admin",
  "admin.password": "changed their password",
  "admin.transfer-owner": "made the owner:",
  "admin.promote": "made an owner:",
  "admin.demote": "made a regular admin:",
  "settings.update": "updated",
  "project.create": "created project",
  "project.update": "updated project",
  "project.delete": "deleted project",
  "site.create": "created website",
  "site.update": "changed settings of",
  "site.delete": "deleted website",
  "site.deploy": "deployed",
  "site.restart": "restarted",
  "site.stop": "stopped",
  "site.start": "started",
  "site.rollback": "rolled back",
  "site.env": "edited the environment of",
  "site.ssl": "requested an SSL certificate for",
  "release.upload": "uploaded a release to",
  "release.github": "pulled a release from GitHub for",
  "release.delete": "deleted a release of",
  "release.update": "updated a release of",
  "database.create": "created database",
  "database.update": "updated database",
  "database.delete": "deleted database",
  "database.import": "imported SQL into",
  "database.credentials.reveal": "revealed the credentials of",
  "database.password.rotate": "rotated the password of",
  "mysql.root.update": "updated MySQL root access",
  "backup.database": "backed up database",
  "backup.server": "backed up server",
  "backup.restore": "restored",
  "backup.restore.start": "started restoring",
  "backup.download": "downloaded backup",
  "backup.update": "updated backup",
  "backup.delete": "deleted backup",
  "backup.settings": "changed the backup schedule",
  "server.create": "added server",
  "server.update": "updated server",
  "server.delete": "removed server",
  "server.token.rotate": "rotated the agent token of",
  "lb.apply": "re-applied the load balancer",
  "job.cancel": "cancelled",
};
// Actions whose target name adds nothing after the verb.
const NO_TARGET = new Set(["admin.login", "admin.logout", "admin.password", "setup.complete", "backup.settings", "lb.apply", "mysql.root.update"]);
const GONE = new Set(["site.delete", "project.delete", "database.delete", "server.delete", "admin.delete", "backup.delete"]);

const isSelf = (a) => a.target?.type === "admin" && a.adminId && a.target?.id === a.adminId;
function verbOf(action, a) {
  if (a && action === "admin.update" && isSelf(a)) return "updated their profile";
  if (VERB[action]) return VERB[action];
  const [obj, ...rest] = String(action || "did something").split(".");
  return rest.length ? `${rest.join(" ").replace(/[-_]/g, " ")} ${obj}` : obj;
}

function hrefOf(a) {
  const t = a.target;
  if (!t || GONE.has(a.action)) return null;
  switch (t.type) {
    case "site": return t.id ? `#/sites/${encodeURIComponent(t.id)}` : null;
    case "project": return t.id ? `#/projects/${encodeURIComponent(t.id)}` : null;
    case "database": return "#/databases";
    case "server": return "#/servers";
    case "backup": return "#/backups";
    case "admin": return "#/settings/admins";
    case "settings": {
      if (t.id === "backups") return "#/settings/backups";
      const f = Array.isArray(a.details?.fields) ? a.details.fields : [];
      return f.length && f.every((x) => x === "githubToken") ? "#/settings/github" : "#/settings/general";
    }
    case "loadbalancer": case "lb": return "#/settings/servers";
    default: return null;
  }
}

const HUMAN_KEY = { include: "includes", githubToken: "GitHub token", panelName: "panel name", panelUrl: "panel URL" };
const human = (k) => HUMAN_KEY[k] || String(k).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
function detailsOf(a) {
  const d = a.details;
  if (d == null || d === "") return "";
  if (typeof d !== "object") return String(d);
  if (d.message || d.summary) return String(d.message || d.summary);
  const parts = [];
  for (const [k, v] of Object.entries(d)) {
    if (v == null || v === "" || /(^id$|Id$|Ids$|^projectId$)/.test(k)) continue;
    let s;
    if (k === "ip") s = `from ${v}`;
    else if (k === "fields" && Array.isArray(v)) s = v.length ? `changed ${v.map(human).join(", ")}` : "";
    else if (k === "size" && typeof v === "number") s = fmtBytes(v);
    else if (k === "trigger") s = v === "schedule" ? "scheduled" : v === "safety" ? "safety copy" : String(v);
    else if (Array.isArray(v)) s = v.length ? `${human(k)}: ${v.slice(0, 3).join(", ")}${v.length > 3 ? ` +${v.length - 3}` : ""}` : "";
    else if (typeof v === "object") {
      if ("enabled" in v) s = `${k} ${v.enabled ? `${v.every || "on"}${v.at && v.every !== "hourly" ? ` at ${v.at}` : ""}` : "off"}`;
      else { const on_ = Object.entries(v).filter(([, x]) => x === true).map(([x]) => x); s = on_.length ? `${human(k)}: ${on_.join(", ")}` : ""; }
    } else if (typeof v === "boolean") s = v ? human(k) : "";
    else s = `${human(k)}: ${v}`;
    if (s) parts.push(s);
    if (parts.length >= 4) break;
  }
  return parts.join(" · ");
}

function dayLabel(t) {
  const d = new Date(t); if (isNaN(d)) return "Earlier";
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(new Date()) - start(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: diff < 7 ? "long" : undefined, month: "short", day: "numeric", year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined });
}

function row(a, projectsById, { fresh = false, showProject = true } = {}) {
  const at = a.at || a.createdAt;
  const href = hrefOf(a);
  const tname = NO_TARGET.has(a.action) || (a.action === "admin.update" && isSelf(a)) ? "" : a.target?.name || "";
  const job = a.target?.type === "job" && a.target?.id;
  const target = !tname ? "" : job ? html`<button class="t-link" data-job="${a.target.id}" style="all:unset;cursor:pointer;color:var(--text);font-weight:600">${tname}</button>`
    : href ? html`<a href="${href}" style="color:var(--text);font-weight:600">${tname}</a>` : html`<b style="color:var(--text);font-weight:600">${tname}</b>`;
  const det = detailsOf(a);
  const proj = showProject && a.projectId ? projectsById[a.projectId] : null;
  const kind = a.target?.type;
  return html`<div class="list-item" data-id="${a.id || ""}" ${fresh ? raw('style="animation:popIn .35s var(--ease)"') : ""}>
    <span class="avatar" style="width:32px;height:32px;border-radius:10px;flex:none" title="${a.adminName || "System"}">${a.adminId ? initials(a.adminName) : icon("zap", "sm")}</span>
    <div class="li-main"><div class="li-title" style="font-weight:500;color:var(--text-2)"><b style="color:var(--text);font-weight:650">${a.adminName || "System"}</b> ${verbOf(a.action, a)} ${target}</div>
      <div class="li-sub">${proj ? html`<a href="#/projects/${proj.id}" style="color:var(--text-2)"><span class="dot" style="width:7px;height:7px;background:${colorOf(proj.color)};margin-right:5px;vertical-align:1px"></span>${proj.name}</a> · ` : ""}${det ? html`${det} · ` : ""}<span data-ago="${at || ""}" title="${fmtDate(at)}">${ago(at)}</span></div></div>
    <div class="li-right">${kind ? html`<span class="badge hide-sm">${icon(KIND_ICON[kind] || "activity")}${KIND_LABEL[kind] || kind}</span>` : ""}<span class="hide-sm nowrap" title="${at ? new Date(at).toLocaleString() : ""}">${fmtDate(at)}</span></div></div>`;
}

export default async function activity(ctx) {
  const { root, query } = ctx;
  ctx.crumbs([{ label: "Activity" }]);
  let projectId = query.projectId || "", kind = KINDS.some(([k]) => k === query.type) ? query.type : "", q = "";
  let limit = PAGE, items = [], projects = [], hasMore = false, freshIds = new Set();

  mount(root, html`${pageHead("Activity log", "Every change made in the panel — who did it and when. Entries can't be edited; the newest few thousand are kept.")}
    <div class="toolbar">
      <select class="select" data-project style="width:auto;min-width:180px" aria-label="Filter by project"><option value="">All projects</option></select>
      <div class="pills" data-kinds role="tablist"></div><span class="grow"></span>
      <div class="search">${icon("search")}<input placeholder="Search admin, action or target" data-q aria-label="Search activity"/></div>
    </div>
    <div data-list>${skeletonRows(8, 52)}</div>`);
  const list = $("[data-list]", root), sel = $("[data-project]", root);
  const byId = () => Object.fromEntries(projects.map((p) => [p.id, p]));

  const paintKinds = () => mount($("[data-kinds]", root), html`${KINDS.map(([k, l]) => html`<button class="pill ${kind === k ? "active" : ""}" data-k="${k}" role="tab" aria-selected="${kind === k ? "true" : "false"}">${l}</button>`)}`);
  const paintProjects = () => mount(sel, html`<option value="">All projects</option>${projects.map((p) => html`<option value="${p.id}" ${p.id === projectId ? raw("selected") : ""}>${p.name}</option>`)}`);
  const matches = (a) => (!kind || kindOf(a) === kind) &&
    (!q || [a.adminName, a.action, verbOf(a.action, a), a.target?.name, a.target?.type, detailsOf(a)].join(" ").toLowerCase().includes(q));

  const paint = () => {
    paintKinds();
    const f = items.filter(matches);
    const pmap = byId();
    if (!f.length) {
      mount(list, html`<div class="card">${emptyState({ ico: "activity", sm: true,
        title: items.length ? "No matching activity" : projectId ? "No activity in this project yet" : "No activity yet",
        text: items.length ? "Try another filter or search." : "Changes made by admins and scheduled tasks show up here." })}</div>`);
      return;
    }
    const groups = [];
    for (const a of f) {
      const label = dayLabel(a.at || a.createdAt);
      if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, rows: [] });
      groups[groups.length - 1].rows.push(a);
    }
    mount(list, html`<div class="card"><div class="list">${groups.map((g) => html`
        <div class="tiny" style="padding:12px 20px 8px;color:var(--muted);font-weight:650;letter-spacing:.06em;text-transform:uppercase;border-bottom:1px solid var(--line);background:rgba(148,166,255,.025)">${g.label}</div>
        ${g.rows.map((a) => row(a, pmap, { fresh: freshIds.has(a.id), showProject: !projectId }))}`)}</div>
      ${hasMore ? html`<div class="card-foot" style="justify-content:center"><button class="btn btn-sm" data-more>${icon("arrowDown")}Load older entries</button></div>`
        : items.length >= PAGE ? html`<div class="card-foot" style="justify-content:center"><span class="muted small">${items.length >= MAX ? `Showing the newest ${MAX} entries.` : "That's everything."}</span></div>` : ""}
    </div>`);
    freshIds = new Set();
  };

  const load = async () => {
    try {
      const r = await get(`/api/activity${qsOf({ limit, projectId })}`);
      if (!ctx.alive()) return;
      items = r.items || [];
      hasMore = items.length >= limit && limit < MAX;
      paint();
    } catch (e) {
      if (!ctx.alive()) return;
      mount(list, errorState(e));
      $("[data-retry]", list)?.addEventListener("click", load);
    }
  };

  paintKinds();
  get("/api/projects").then((r) => { projects = r.items || []; if (!ctx.alive()) return; paintProjects(); if (items.length) paint(); }).catch(() => {});
  await load();

  const syncHash = () => {
    const qs = qsOf({ projectId, type: kind });
    try { history.replaceState(null, "", `#/activity${qs}`); } catch {}
  };
  sel.addEventListener("change", () => { projectId = sel.value; limit = PAGE; syncHash(); mount(list, skeletonRows(6, 52)); load(); });
  on(root, "click", "[data-k]", (e, b) => { kind = b.dataset.k; syncHash(); paint(); });
  on(root, "input", "[data-q]", debounce((e) => { q = e.target.value.trim().toLowerCase(); paint(); }, 120));
  on(root, "click", "[data-more]", (e, b) => { b.classList.add("loading"); limit = Math.min(MAX, limit + PAGE); load(); });
  on(root, "click", "[data-job]", (e, b) => { e.preventDefault(); openJobLog(b.dataset.job); });

  ctx.on("activity", (a) => {
    if (!a || typeof a !== "object" || !a.action) return;
    if (a.id && items.some((x) => x.id === a.id)) return;
    if (projectId && a.projectId !== projectId) return;
    items.unshift(a);
    if (a.id) freshIds.add(a.id);
    paint();
  });
  ctx.on("project", debounce(() => get("/api/projects").then((r) => { projects = r.items || []; if (ctx.alive()) { paintProjects(); paint(); } }).catch(() => {}), 400));

  // keep "5m ago" honest without re-rendering the list
  const tick = setInterval(() => {
    if (!ctx.alive()) return clearInterval(tick);
    root.querySelectorAll("[data-ago]").forEach((el) => { if (el.dataset.ago) el.textContent = ago(el.dataset.ago); });
  }, 30000);
  ctx.cleanup(() => clearInterval(tick));
}
