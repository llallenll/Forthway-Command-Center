// Live updates. Views subscribe with onEvent(); the router drops a view's
// subscriptions when it navigates away.
//
// Transport: SSE at /api/events. When something between the browser and the
// panel (nginx, Cloudflare, a tunnel) buffers the stream so nothing arrives
// within OPEN_TIMEOUT, or the stream keeps dropping, we fall back to
// long-polling /api/events/poll and retry SSE every PROBE_EVERY in the
// background. Both transports read the same server-side ring buffer and every
// event has an increasing id, so switching never loses or repeats an event.
//
// Status: "connecting" (first seconds only) | "live" (SSE) |
//         "polling" (fallback working) | "offline" (both failing, retrying)
import { MOCK, mock } from "./api.js";

const TYPES = ["job", "job.log", "site", "server", "database", "backup", "project", "lb", "activity", "settings", "updates", "cloudflare", "monitor"];
const OPEN_TIMEOUT = 8000; // SSE must deliver its hello within this
const STALL_TIMEOUT = 45000; // server pings every 15s; silence this long = stalled
const PROBE_EVERY = 120000; // while polling, retry SSE this often
const POLL_WAIT = 25; // seconds the server may hold a poll

const subs = new Map();
const statusSubs = new Set();
let status = "connecting";

let mode = "sse"; // "sse" | "poll"
let es = null;
let lastId = 0;
let openTimer = null, stallTimer = null, probeTimer = null, retryTimer = null;
let errTimes = [];
let pollGen = 0;
let pollCtl = null;

function emit(type, data) {
  for (const fn of subs.get(type) || []) { try { fn(data, type); } catch (e) { console.error(e); } }
  for (const fn of subs.get("*") || []) { try { fn(data, type); } catch (e) { console.error(e); } }
}
function setStatus(s) {
  if (s === status) return;
  status = s;
  statusSubs.forEach((f) => { try { f(s); } catch (e) { console.error(e); } });
}
/** Deliver once: events at or below the last seen id were already emitted. */
function deliver(id, type, data) {
  const n = Number(id) || 0;
  if (n) {
    if (n <= lastId) return;
    lastId = n;
  }
  emit(type, data);
}

export function onEvent(type, fn) {
  const types = Array.isArray(type) ? type : [type];
  types.forEach((t) => { if (!subs.has(t)) subs.set(t, new Set()); subs.get(t).add(fn); });
  return () => types.forEach((t) => subs.get(t)?.delete(fn));
}
export function onStatus(fn) { statusSubs.add(fn); fn(status); return () => statusSubs.delete(fn); }
export function eventStatus() { return status; }

export async function startEvents() {
  if (MOCK) {
    const m = await mock();
    m.subscribe(emit);
    setStatus("live");
    return;
  }
  startSSE();
}

// ------------------------------------------------------------------ SSE

function closeSSE() {
  clearTimeout(openTimer); clearTimeout(stallTimer); clearTimeout(retryTimer);
  try { es?.close(); } catch {}
  es = null;
}

function startSSE() {
  closeSSE();
  clearTimeout(probeTimer);
  const src = new EventSource("api/events" + (lastId ? `?lastEventId=${lastId}` : ""));
  es = src;
  let up = false;
  const mine = () => es === src;
  const armOpen = () => { clearTimeout(openTimer); openTimer = setTimeout(() => mine() && fallback(), OPEN_TIMEOUT); };
  const alive = () => {
    if (!mine()) return;
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => mine() && fallback(), STALL_TIMEOUT);
    if (up) return;
    // Bytes are really arriving (not just headers), so the stream works.
    up = true;
    clearTimeout(openTimer);
    stopPolling();
    mode = "sse";
    setStatus("live");
  };
  src.addEventListener("hello", alive);
  src.addEventListener("ping", alive);
  for (const t of TYPES) {
    src.addEventListener(t, (e) => {
      alive();
      let data = null;
      try { data = JSON.parse(e.data); } catch { data = e.data; }
      deliver(e.lastEventId, t, data);
    });
  }
  src.onmessage = (e) => {
    alive();
    try { const d = JSON.parse(e.data); if (d && d.type) deliver(e.lastEventId, d.type, d.data ?? d); } catch {}
  };
  src.onerror = () => {
    if (!mine()) return;
    const now = Date.now();
    errTimes = errTimes.filter((t) => now - t < 60000);
    errTimes.push(now);
    if (up) {
      // Dropped after working: the browser reconnects on its own (sending
      // Last-Event-ID); give it OPEN_TIMEOUT before falling back.
      up = false;
      clearTimeout(stallTimer);
      if (mode === "sse") setStatus("connecting");
      armOpen();
    }
    if (errTimes.length >= 3) return fallback(); // keeps failing
    if (src.readyState === EventSource.CLOSED) {
      // Hard failure (non-200, wrong content type): the browser gives up.
      if (mode === "poll") return fallback();
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => mine() && startSSE(), 3000);
    }
  };
  armOpen();
}

/** SSE isn't getting through: poll instead and try SSE again later. */
function fallback() {
  closeSSE();
  errTimes = [];
  if (mode !== "poll") {
    mode = "poll";
    startPolling();
  }
  scheduleProbe(PROBE_EVERY);
}
function scheduleProbe(ms) {
  clearTimeout(probeTimer);
  probeTimer = setTimeout(() => { if (mode === "poll") startSSE(); }, ms);
}

// ------------------------------------------------------------- polling

function stopPolling() {
  pollGen++;
  try { pollCtl?.abort(); } catch {}
  pollCtl = null;
}
function startPolling() {
  stopPolling();
  pollLoop(pollGen);
}

async function pollLoop(gen) {
  let backoff = 2000;
  while (gen === pollGen) {
    const ctl = new AbortController();
    pollCtl = ctl;
    const timer = setTimeout(() => ctl.abort(), (POLL_WAIT + 15) * 1000);
    try {
      // Until a poll has succeeded, ask for an instant answer so the chip
      // flips to "Live (polling)" right away instead of after a full hold.
      const wait = status === "polling" ? POLL_WAIT : 0;
      const res = await fetch(`api/events/poll?wait=${wait}${lastId ? `&after=${lastId}` : ""}`, {
        cache: "no-store", credentials: "same-origin", signal: ctl.signal, headers: { Accept: "application/json" },
      });
      if (res.status === 401) {
        // Session ended: let the app's normal 401 handling take over.
        const { get } = await import("./api.js");
        await get("/api/me").catch(() => {});
        throw new Error("signed out");
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (gen !== pollGen) return;
      if (status === "offline") scheduleProbe(1500); // back from an outage: try SSE soon
      setStatus("polling");
      backoff = 2000;
      for (const ev of body.events || []) deliver(ev.id, ev.type, ev.data);
      if (Number(body.last)) lastId = Number(body.last);
    } catch {
      if (gen !== pollGen) return;
      setStatus("offline");
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 15000);
    } finally {
      clearTimeout(timer);
    }
  }
}
