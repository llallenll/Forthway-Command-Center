// Job queue: the "Queue" button next to the Live chip and its panel.
// Heavy jobs (builds, installs, server backups) run a few at a time per server
// (panel/lib/jobs.mjs); the rest wait here in order. Admins reorder them (drag,
// or the up/down buttons for keyboard and touch), force one to start now, or
// cancel. Kept current by the SSE `queue` event; GET /api/jobs/queue adds names.
import { html, mount, $, toast, toastError, confirmDialog, fmtDuration, ago, debounce } from "./util.js";
import { icon } from "./icons.js";
import { get, post } from "./api.js";
import { onEvent, onStatus } from "./events.js";

const Q = { data: null };
let pop = null, popOff = null, tick = null, dragging = null, pendingPaint = false;

const waitingCount = () => Q.data?.waiting?.length || 0;
const runningCount = () => Q.data?.running?.length || 0;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function chipLabel() {
  const w = waitingCount(), r = runningCount();
  if (!w && !r) return "Job queue: empty";
  return `Job queue: ${r ? `${r} running` : "nothing running"}${w ? `, ${w} waiting` : ""}`;
}

/** The top-bar button (app.js paints it next to the Live chip). */
export function queueChip() {
  const w = waitingCount(), r = runningCount();
  return html`<button type="button" class="q-chip${r ? " is-running" : ""}${w ? " has-waiting" : ""}" id="queueChip" aria-haspopup="dialog" aria-expanded="${pop ? "true" : "false"}" aria-label="${chipLabel()}" title="${chipLabel()}">
    ${icon("layers", "xs")}<span class="q-chip-t">Queue</span>${r ? html`<span class="q-run-dot" aria-hidden="true"></span>` : ""}<span class="q-count" aria-hidden="true" ${w ? "" : "hidden"}>${w}</span></button>`;
}

function paintChip() {
  const b = $("#queueChip");
  if (!b) return;
  const w = waitingCount(), r = runningCount();
  b.classList.toggle("is-running", !!r);
  b.classList.toggle("has-waiting", !!w);
  b.setAttribute("aria-label", chipLabel());
  b.title = chipLabel();
  const c = b.querySelector(".q-count");
  c.textContent = String(w);
  c.hidden = !w;
  const dot = b.querySelector(".q-run-dot");
  if (r && !dot) c.insertAdjacentHTML("beforebegin", '<span class="q-run-dot" aria-hidden="true"></span>');
  if (!r && dot) dot.remove();
}

async function load() {
  try {
    Q.data = await get("/api/jobs/queue");
  } catch {
    return; // an older panel without the queue: the button just stays empty
  }
  paintChip();
  if (pop) paintPop();
}
const reload = debounce(load, 150);

/* ───────── the panel ───────── */

const servers = (j) => (j.serverNames?.length ? j.serverNames : j.servers || []).join(", ");
const since = (t) => (t ? fmtDuration(Date.now() - new Date(t)) : "—");

function runningItem(j) {
  return html`<li class="q-item is-running" data-id="${j.id}">
    <span class="q-ico run" aria-hidden="true"><span class="dot run"></span></span>
    <div class="q-main">
      <div class="q-title">${j.title}${j.forced ? html` <span class="badge warn q-forced" title="Started with Force start: it runs beside other heavy jobs on the same server.">${icon("zap")}Forced</span>` : ""}</div>
      <div class="q-meta">${icon("server", "xs")}${servers(j)}<span class="q-sep">·</span>running <span data-since="${j.startedAt}">${since(j.startedAt)}</span>${j.adminName ? html`<span class="q-sep">·</span>${j.adminName}` : ""}</div>
      ${j.lastLine ? html`<div class="q-line mono" data-line>${j.lastLine}</div>` : html`<div class="q-line mono" data-line hidden></div>`}
    </div>
    <div class="q-acts">
      <button type="button" class="icon-btn ghost sm" data-log aria-label="Open the log of ${j.title}" title="Open log">${icon("fileText")}</button>
      <button type="button" class="icon-btn ghost sm q-danger" data-cancel aria-label="Cancel ${j.title}" title="Cancel">${icon("x")}</button>
    </div></li>`;
}

function waitingItem(j, i, n) {
  const why = j.waitingFor?.length ? `after ${j.waitingFor.slice(0, 2).join(", ")}${j.waitingFor.length > 2 ? ` +${j.waitingFor.length - 2}` : ""}` : "";
  return html`<li class="q-item" data-id="${j.id}" draggable="true">
    <span class="q-grip" aria-hidden="true" title="Drag to reorder"><svg viewBox="0 0 10 16"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg></span>
    <span class="q-pos" aria-label="Position ${i + 1}">${i + 1}</span>
    <div class="q-main">
      <div class="q-title">${j.title}</div>
      <div class="q-meta">${icon("server", "xs")}${servers(j)}<span class="q-sep">·</span>waiting <span data-since="${j.createdAt}">${since(j.createdAt)}</span>${j.adminName ? html`<span class="q-sep">·</span>${j.adminName}` : ""}</div>
      ${why ? html`<div class="q-why">${why}</div>` : ""}
    </div>
    <div class="q-acts">
      <button type="button" class="icon-btn ghost sm" data-move="up" ${i === 0 ? "disabled" : ""} aria-label="Move ${j.title} up" title="Move up">${icon("arrowUp")}</button>
      <button type="button" class="icon-btn ghost sm" data-move="down" ${i === n - 1 ? "disabled" : ""} aria-label="Move ${j.title} down" title="Move down">${icon("arrowDown")}</button>
      <button type="button" class="btn btn-sm q-force" data-force aria-label="Force start ${j.title}" title="Start now, without waiting">${icon("zap")}<span>Start now</span></button>
      <button type="button" class="icon-btn ghost sm q-danger" data-cancel aria-label="Cancel ${j.title}" title="Cancel">${icon("x")}</button>
    </div></li>`;
}

function paintPop() {
  if (!pop) return;
  if (dragging) { pendingPaint = true; return; }
  const d = Q.data || { running: [], waiting: [], perServer: 1 };
  const per = d.perServer || 1;
  const focusId = document.activeElement?.closest?.(".q-item")?.dataset.id;
  const focusAct = document.activeElement?.dataset?.move ? `[data-move="${document.activeElement.dataset.move}"]` : null;
  mount(pop, html`
    <div class="q-head">
      <div><strong>Job queue</strong><div class="q-sub">${plural(per, "build or server backup", "builds or server backups")} per server at a time; the rest wait here in order.</div></div>
      <a class="icon-btn ghost sm" href="#/settings/queue" data-settings aria-label="Job queue settings" title="Settings">${icon("settings")}</a>
    </div>
    ${!d.running.length && !d.waiting.length
      ? html`<div class="q-empty">${icon("check")}<div><div class="strong">Nothing in the queue</div><div class="muted small">When you deploy several websites at once, the builds line up here and run one after another per server, so the server isn't overloaded.</div></div></div>`
      : html`
        <section class="q-sec" aria-label="Running now">
          <h4>Running now <span class="q-n">${d.running.length}</span></h4>
          ${d.running.length ? html`<ul class="q-list">${d.running.map(runningItem)}</ul>` : html`<p class="muted small q-none">Nothing heavy is running.</p>`}
        </section>
        <section class="q-sec" aria-label="Waiting">
          <h4>Waiting <span class="q-n">${d.waiting.length}</span>${d.waiting.length > 1 ? html`<span class="q-hint">drag or use the arrows to reorder</span>` : ""}</h4>
          ${d.waiting.length ? html`<ol class="q-list" data-waiting>${d.waiting.map((j, i) => waitingItem(j, i, d.waiting.length))}</ol>` : html`<p class="muted small q-none">Nothing is waiting.</p>`}
        </section>`}`);
  if (focusId) $(`.q-item[data-id="${focusId}"] ${focusAct || "button:not([disabled])"}`, pop)?.focus();
}

function findJob(id) {
  return Q.data?.running?.find((j) => j.id === id) || Q.data?.waiting?.find((j) => j.id === id) || null;
}

async function move(id, body) {
  // Optimistic: reorder locally, the server confirms over SSE.
  const w = Q.data?.waiting || [];
  const from = w.findIndex((j) => j.id === id);
  if (from !== -1) {
    const to = body.to === "up" ? from - 1 : body.to === "down" ? from + 1 : body.to === "top" ? 0 : body.index ?? from;
    const [j] = w.splice(from, 1);
    w.splice(Math.max(0, Math.min(w.length, to)), 0, j);
    paintPop();
  }
  try {
    Q.data = await post(`/api/jobs/${id}/move`, body);
    paintChip();
    paintPop();
  } catch (e) {
    toastError(e, "Couldn't move it");
    load();
  }
}

async function forceStart(id) {
  const j = findJob(id);
  if (!j) return;
  const busy = (Q.data?.running || []).filter((r) => r.servers.some((s) => j.servers.includes(s)));
  const ok = await confirmDialog({
    title: "Start it now?",
    ico: "zap",
    message: busy.length
      ? `"${j.title}" will start right away, beside ${busy.map((r) => `"${r.title}"`).join(", ")} on ${servers(j)}. Running several builds on one server at once uses much more CPU and memory and can overload it — that is what the queue prevents.`
      : `"${j.title}" will start right away instead of waiting its turn. Running several builds on one server at once can overload it.`,
    confirmText: "Start now",
  });
  if (!ok) return;
  try {
    await post(`/api/jobs/${id}/force`);
    toast("Started", "ok", { msg: j.title });
    load();
  } catch (e) {
    toastError(e, "Couldn't start it");
  }
}

async function cancel(id) {
  const j = findJob(id);
  if (!j) return;
  const running = j.status === "running";
  if (running && !(await confirmDialog({ title: "Cancel this job?", message: `"${j.title}" stops where it is. A deploy that stops half-way leaves the website on its current release.`, confirmText: "Cancel job", danger: true }))) return;
  try {
    await post(`/api/jobs/${id}/cancel`);
    toast(running ? "Cancelling…" : "Removed from the queue", "ok", { msg: j.title });
    load();
  } catch (e) {
    toastError(e, "Couldn't cancel it");
  }
}

function bindPop() {
  pop.addEventListener("click", (e) => {
    const b = e.target.closest("button, a");
    if (!b || b.disabled) return;
    const id = b.closest(".q-item")?.dataset.id;
    if (b.matches("[data-settings]")) return closePop();
    if (!id) return;
    if (b.matches("[data-move]")) move(id, { to: b.dataset.move });
    else if (b.matches("[data-force]")) forceStart(id);
    else if (b.matches("[data-cancel]")) cancel(id);
    else if (b.matches("[data-log]")) import("./components.js").then((c) => c.openJobLog(id));
  });
  // Drag and drop (pointer); the arrow buttons cover keyboard and touch.
  pop.addEventListener("dragstart", (e) => {
    const li = e.target.closest?.(".q-item[draggable]");
    if (!li) return;
    dragging = li.dataset.id;
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", dragging); } catch {}
  });
  pop.addEventListener("dragover", (e) => {
    if (!dragging) return;
    const list = $("[data-waiting]", pop);
    const over = e.target.closest?.(".q-item[draggable]");
    if (!list || !over || over.dataset.id === dragging) { if (list?.contains(e.target)) e.preventDefault(); return; }
    e.preventDefault();
    const li = $(`.q-item[data-id="${dragging}"]`, list);
    const r = over.getBoundingClientRect();
    over[e.clientY > r.top + r.height / 2 ? "after" : "before"](li);
  });
  pop.addEventListener("drop", (e) => { if (dragging) e.preventDefault(); });
  pop.addEventListener("dragend", () => {
    const id = dragging;
    const list = $("[data-waiting]", pop);
    $$items(list).forEach((x) => x.classList.remove("dragging"));
    dragging = null;
    const index = $$items(list).findIndex((x) => x.dataset.id === id);
    const before = (Q.data?.waiting || []).findIndex((j) => j.id === id);
    if (id && index !== -1 && index !== before) move(id, { index });
    else if (pendingPaint) { pendingPaint = false; paintPop(); }
  });
}
const $$items = (list) => (list ? Array.from(list.querySelectorAll(".q-item")) : []);

function placePop(btn) {
  const r = btn.getBoundingClientRect(), w = pop.offsetWidth;
  pop.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + "px";
  pop.style.top = r.bottom + 8 + "px";
  pop.style.maxHeight = `calc(100dvh - ${Math.round(r.bottom + 16)}px)`;
}

function closePop() {
  if (!pop) return;
  pop.remove(); pop = null;
  popOff?.(); popOff = null;
  clearInterval(tick); tick = null;
  $("#queueChip")?.setAttribute("aria-expanded", "false");
}

function openPop(btn) {
  if (pop) return;
  pop = document.createElement("div");
  pop.className = "q-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Job queue");
  paintPop();
  document.body.appendChild(pop);
  placePop(btn);
  bindPop();
  btn.setAttribute("aria-expanded", "true");
  load();
  tick = setInterval(() => {
    if (!pop) return;
    pop.querySelectorAll("[data-since]").forEach((el) => (el.textContent = since(el.dataset.since)));
  }, 1000);
  // Clicks in a dialog opened from here (confirm, job log) don't close it.
  // (The list repaints live, so the pressed element may already be gone: go by the panel's box too.)
  const inside = (e) => { const r = pop?.getBoundingClientRect(); return !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; };
  const down = (e) => { if (pop && !pop.contains(e.target) && !inside(e) && !$("#queueChip")?.contains(e.target) && !e.target.closest?.("#modals, .toasts")) closePop(); };
  const key = (e) => { if (e.key === "Escape" && !document.querySelector("#modals .modal")) { closePop(); btn.focus(); } };
  const resize = () => { const b = $("#queueChip"); if (b && pop) placePop(b); else closePop(); };
  document.addEventListener("mousedown", down);
  document.addEventListener("keydown", key);
  window.addEventListener("resize", resize);
  window.addEventListener("hashchange", closePop);
  popOff = () => {
    document.removeEventListener("mousedown", down);
    document.removeEventListener("keydown", key);
    window.removeEventListener("resize", resize);
    window.removeEventListener("hashchange", closePop);
  };
}

/** Start: load the queue, follow it live, and open the panel from the button or a toast. */
export function initQueue() {
  load();
  onEvent("queue", (d) => {
    if (d && Array.isArray(d.waiting)) {
      // Counts at once; names (admins, servers) come with the refetch.
      const byId = new Map([...(Q.data?.running || []), ...(Q.data?.waiting || [])].map((j) => [j.id, j]));
      const keep = (j) => ({ ...(byId.get(j.id) || {}), ...j });
      Q.data = { ...d, running: d.running.map(keep), waiting: d.waiting.map(keep) };
      paintChip();
      if (pop) paintPop();
    }
    reload();
  });
  onEvent("job.log", (d) => {
    if (!pop || !d?.id || !d.lines?.length) return;
    const j = Q.data?.running?.find((x) => x.id === d.id);
    if (!j) return;
    j.lastLine = d.lines[d.lines.length - 1];
    const el = $(`.q-item[data-id="${d.id}"] [data-line]`, pop);
    if (el) { el.textContent = j.lastLine; el.hidden = false; }
  });
  let prev = null;
  onStatus((st) => { if ((st === "live" || st === "polling") && prev === "offline") load(); prev = st; });
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("#queueChip");
    if (!b) return;
    if (pop) closePop(); else openPop(b);
  });
  window.addEventListener("fcc:queue-open", () => { const b = $("#queueChip"); if (b && !pop) openPop(b); });
}
