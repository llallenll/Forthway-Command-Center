// Live updates over SSE (/api/events). Views subscribe with onEvent(); the
// router drops a view's subscriptions when it navigates away.
import { MOCK, mock } from "./api.js";

const TYPES = ["job", "job.log", "site", "server", "database", "backup", "project", "lb", "activity", "settings"];
const subs = new Map();
const statusSubs = new Set();
let status = "connecting";
let es = null;

function emit(type, data) {
  for (const fn of subs.get(type) || []) { try { fn(data, type); } catch (e) { console.error(e); } }
  for (const fn of subs.get("*") || []) { try { fn(data, type); } catch (e) { console.error(e); } }
}
function setStatus(s) { status = s; statusSubs.forEach((f) => f(s)); }

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
  connect();
}

let retry = 1000;
function connect() {
  try { es?.close(); } catch {}
  es = new EventSource("api/events");
  es.onopen = () => { retry = 1000; setStatus("live"); };
  es.onerror = () => {
    setStatus("offline");
    if (es.readyState === EventSource.CLOSED) {
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 20000);
    }
  };
  for (const t of TYPES) {
    es.addEventListener(t, (e) => {
      let data = null;
      try { data = JSON.parse(e.data); } catch { data = e.data; }
      emit(t, data);
    });
  }
  es.onmessage = (e) => {
    try { const d = JSON.parse(e.data); if (d && d.type) emit(d.type, d.data ?? d); } catch {}
  };
}
