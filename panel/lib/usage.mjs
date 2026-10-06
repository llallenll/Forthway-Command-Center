/**
 * USAGE — CPU, memory and disk per website, per server.
 *
 * Every minute the panel runs the `sites.usage` task (shared/tasks.mjs) on
 * each online server with the websites it hosts — in-process on main, through
 * the agent elsewhere. Specs sent are minimal (id, type, appDir, port, pm2
 * name): never env values.
 *
 *   cpu  % of one core (100 = one full core), averaged over the minute
 *   mem  resident memory (bytes) of the app's processes and their children
 *   disk bytes under appDir on that server (refreshed every 15 min)
 *
 * Static and PHP websites are served by nginx / php-fpm, which are shared, so
 * only their disk usage is measured.
 *
 * Storage: dataDir/usage.json (saved every 5 min and on stop)
 *   minute: { "<siteId>|<serverId>": [[t, cpu, mem], …] }                24 h
 *   hourly: { "<siteId>|<serverId>": [[t, cpuAvg, cpuMax, memAvg, memMax, n], …] }  31 d
 *   latest: { "<siteId>|<serverId>": { at, cpu, mem, procs, source, disk, diskAt, error } }
 *   servers: { "<serverId>": { cores, memTotal } }
 *
 * API: GET /api/sites/:id/usage?range=1h|24h|7d|30d
 *   → { range, step, from, to, type, simulated, cores, memTotal,
 *       series: [{ t, cpu, mem }] (summed over servers, null = no data),
 *       perServer: { [serverId]: [{ t, cpu, mem }] } (only for 2+ servers),
 *       servers: [{ id, name, online, cores, memTotal, cpu, mem, disk, diskAt, procs, source, at, error }],
 *       current: { cpu, mem, disk, procs, at }, avg: { cpu, mem }, peak: { cpu, mem } }
 */

import fs from "node:fs";
import path from "node:path";

import { httpError } from "./http.mjs";
import { writeFileAtomic } from "./store.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SAMPLE_MS = MINUTE;
const FIRST_SAMPLE_MS = 20_000; // give agents time to check in after a restart
const SAVE_MS = 5 * MINUTE;
const KEEP_MINUTES_MS = DAY;
const KEEP_HOURLY_MS = 31 * DAY;
const FRESH_MS = 3 * MINUTE; // "current" only counts samples this recent
const RANGES = {
  "1h": { ms: HOUR, step: MINUTE, src: "minute" },
  "24h": { ms: DAY, step: 5 * MINUTE, src: "minute" },
  "7d": { ms: 7 * DAY, step: HOUR, src: "hourly" },
  "30d": { ms: 30 * DAY, step: 6 * HOUR, src: "hourly" },
};

const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const floorTo = (t, step) => Math.floor(t / step) * step;

let U = null;

export function register(router, ctx) {
  U = createUsage(ctx);
  ctx.usage = U.api;
  U.routes(router);
}

export async function start() {
  U?.start();
}

export async function stop() {
  U?.stop();
}

export function createUsage(ctx, { now: clock = () => Date.now() } = {}) {
  const file = path.join(ctx.dataDir, "usage.json");
  const minute = new Map();
  const hourly = new Map();
  const latest = new Map();
  const servers = new Map();
  const warned = new Map(); // serverId -> last error text (log each new error once)
  const timers = [];
  let sampling = false;
  let dirty = false;

  const key = (siteId, serverId) => `${siteId}|${serverId}`;
  const sites = () => ctx.sites?.list?.() || [];
  const targets = (site) => ctx.sites?.targets?.(site) || [];

  /** What the agent needs to find a website's processes — nothing secret. */
  function leanSpec(site) {
    const node = (site.type || "node") === "node";
    return { siteId: site.id, type: site.type || "node", appDir: site.appDir, port: site.port, pm2Name: `fcc-${site.id}`, restart: { mode: node ? "pm2" : "none" } };
  }

  // ------------------------------------------------------------ record

  function record(siteId, serverId, s, at) {
    const k = key(siteId, serverId);
    latest.set(k, { at: new Date(at).toISOString(), cpu: s.cpu ?? null, mem: s.mem ?? null, procs: s.procs ?? 0, source: s.source ?? null, disk: s.disk ?? null, diskAt: s.diskAt ?? null, error: null });
    dirty = true;
    if (s.cpu == null && s.mem == null) return;
    const t = floorTo(at, MINUTE);
    let m = minute.get(k);
    if (!m) minute.set(k, (m = []));
    const last = m[m.length - 1];
    if (last && last[0] === t) m[m.length - 1] = [t, s.cpu ?? last[1], s.mem ?? last[2]];
    else m.push([t, s.cpu ?? null, s.mem ?? null]);
    while (m.length && m[0][0] < at - KEEP_MINUTES_MS) m.shift();

    const ht = floorTo(at, HOUR);
    let h = hourly.get(k);
    if (!h) hourly.set(k, (h = []));
    let b = h[h.length - 1];
    if (!b || b[0] !== ht) h.push((b = [ht, null, null, null, null, 0]));
    const n = b[5];
    if (s.cpu != null) {
      b[1] = r1(((b[1] ?? s.cpu) * n + s.cpu) / (n + 1));
      b[2] = Math.max(b[2] ?? 0, s.cpu);
    }
    if (s.mem != null) {
      b[3] = Math.round(((b[3] ?? s.mem) * n + s.mem) / (n + 1));
      b[4] = Math.max(b[4] ?? 0, s.mem);
    }
    b[5] = n + 1;
    while (h.length && h[0][0] < at - KEEP_HOURLY_MS) h.shift();
  }

  function recordError(siteId, serverId, error, at) {
    const k = key(siteId, serverId);
    latest.set(k, { ...(latest.get(k) || {}), at: new Date(at).toISOString(), cpu: null, mem: null, procs: 0, error });
    dirty = true;
  }

  // ------------------------------------------------------------ sample

  async function sample() {
    if (sampling || !ctx.cluster?.runTask) return;
    sampling = true;
    try {
      const byServer = new Map();
      for (const site of sites()) {
        for (const sid of new Set(targets(site))) {
          if (!byServer.has(sid)) byServer.set(sid, []);
          byServer.get(sid).push(site);
        }
      }
      await Promise.all(
        [...byServer].map(async ([sid, list]) => {
          if (!ctx.cluster.isOnline(sid)) return;
          const at = clock();
          try {
            const r = await ctx.cluster.runTask(sid, "sites.usage", { specs: list.map(leanSpec) }, { timeoutMs: 50_000 });
            servers.set(sid, { cores: r?.cores ?? null, memTotal: r?.memTotal ?? null, simulated: !!r?.simulated });
            for (const site of list) {
              const s = r?.sites?.[site.id];
              if (s) record(site.id, sid, s, at);
            }
            warned.delete(sid);
          } catch (err) {
            const msg = /Unknown task type/.test(err.message) ? "This server's agent is out of date — it updates itself shortly." : err.message;
            for (const site of list) recordError(site.id, sid, msg, at);
            if (warned.get(sid) !== msg) console.warn(`[usage] ${sid}: ${msg}`);
            warned.set(sid, msg);
          }
        }),
      );
    } finally {
      sampling = false;
    }
  }

  // ------------------------------------------------------------ query

  /** Dense buckets for one site|server: [{ t, cpu, mem }] (null where nothing was sampled). */
  function bucketsFor(k, { from, to, step, src }) {
    const acc = new Map();
    const add = (t, cpu, mem, w) => {
      const bt = floorTo(t, step);
      if (bt < from || bt > to) return;
      let a = acc.get(bt);
      if (!a) acc.set(bt, (a = { cs: 0, cn: 0, ms: 0, mn: 0 }));
      if (cpu != null) { a.cs += cpu * w; a.cn += w; }
      if (mem != null) { a.ms += mem * w; a.mn += w; }
    };
    if (src === "minute") for (const [t, cpu, mem] of minute.get(k) || []) add(t, cpu, mem, 1);
    else for (const [t, cpu, , mem, , n] of hourly.get(k) || []) add(t, cpu, mem, n || 1);
    const out = [];
    for (let t = from; t <= to; t += step) {
      const a = acc.get(t);
      out.push({ t, cpu: a?.cn ? r1(a.cs / a.cn) : null, mem: a?.mn ? Math.round(a.ms / a.mn) : null });
    }
    return out;
  }

  function peakFor(k, { from, src }) {
    let cpu = null;
    let mem = null;
    if (src === "minute") {
      for (const [t, c, m] of minute.get(k) || []) {
        if (t < from) continue;
        if (c != null) cpu = Math.max(cpu ?? 0, c);
        if (m != null) mem = Math.max(mem ?? 0, m);
      }
    } else {
      for (const [t, , c, , m] of hourly.get(k) || []) {
        if (t < from) continue;
        if (c != null) cpu = Math.max(cpu ?? 0, c);
        if (m != null) mem = Math.max(mem ?? 0, m);
      }
    }
    return { cpu, mem };
  }

  function view(site, range) {
    const R = RANGES[range] || RANGES["24h"];
    const to = floorTo(clock(), R.step);
    const from = to - R.ms + R.step;
    const q = { from, to, step: R.step, src: R.src };
    const ids = targets(site);
    const per = {};
    for (const sid of ids) per[sid] = bucketsFor(key(site.id, sid), q);
    const sum = (vals) => (vals.some((v) => v != null) ? vals.reduce((a, v) => a + (v ?? 0), 0) : null);
    const series = [];
    for (let i = 0, t = from; t <= to; t += R.step, i++) {
      series.push({ t, cpu: r1(sum(ids.map((sid) => per[sid][i].cpu))), mem: sum(ids.map((sid) => per[sid][i].mem)) });
    }
    const avgOf = (k) => {
      const v = series.map((p) => p[k]).filter((x) => x != null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    // Peaks of the sum aren't stored; summing each server's peak is an upper bound and exact for one server.
    const peaks = ids.map((sid) => peakFor(key(site.id, sid), q));
    const now = clock();
    const rows = ids.map((sid) => {
      const l = latest.get(key(site.id, sid)) || {};
      const fresh = l.at && now - Date.parse(l.at) < FRESH_MS;
      const info = servers.get(sid) || {};
      return {
        id: sid,
        name: ctx.cluster?.getServer?.(sid)?.name || sid,
        online: ctx.cluster?.isOnline?.(sid) ?? null,
        cores: info.cores ?? null,
        memTotal: info.memTotal ?? null,
        cpu: fresh ? l.cpu ?? null : null,
        mem: fresh ? l.mem ?? null : null,
        procs: fresh ? l.procs ?? 0 : null,
        source: l.source ?? null,
        disk: l.disk ?? null,
        diskAt: l.diskAt ?? null,
        at: l.at || null,
        error: fresh ? l.error || null : null,
        stale: !!l.at && !fresh,
      };
    });
    const current = {
      cpu: r1(sum(rows.map((r) => r.cpu))),
      mem: sum(rows.map((r) => r.mem)),
      disk: rows.reduce((a, r) => (r.disk != null ? Math.max(a ?? 0, r.disk) : a), null),
      procs: sum(rows.map((r) => r.procs)),
      at: rows.map((r) => r.at).filter(Boolean).sort().pop() || null,
    };
    return {
      range: RANGES[range] ? range : "24h",
      step: R.step,
      from,
      to,
      type: site.type || "node",
      simulated: ids.some((sid) => servers.get(sid)?.simulated),
      cores: sum(rows.map((r) => r.cores)),
      memTotal: sum(rows.map((r) => r.memTotal)),
      series,
      perServer: ids.length > 1 ? per : undefined,
      servers: rows,
      current,
      avg: { cpu: r1(avgOf("cpu")), mem: avgOf("mem") == null ? null : Math.round(avgOf("mem")) },
      peak: { cpu: r1(sum(peaks.map((p) => p.cpu))), mem: sum(peaks.map((p) => p.mem)) },
    };
  }

  // ------------------------------------------------------------ persistence

  function load() {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return; // first boot
    }
    const now = clock();
    for (const [k, pts] of Object.entries(j.minute || {})) minute.set(k, pts.filter((p) => p[0] >= now - KEEP_MINUTES_MS));
    for (const [k, pts] of Object.entries(j.hourly || {})) hourly.set(k, pts.filter((p) => p[0] >= now - KEEP_HOURLY_MS));
    for (const [k, v] of Object.entries(j.latest || {})) latest.set(k, v);
    for (const [k, v] of Object.entries(j.servers || {})) servers.set(k, v);
  }

  function save() {
    if (!dirty) return;
    dirty = false;
    const live = new Set(sites().map((s) => s.id));
    const keep = (m) => Object.fromEntries([...m].filter(([k]) => live.has(k.split("|")[0])));
    try {
      writeFileAtomic(file, JSON.stringify({ v: 1, savedAt: new Date(clock()).toISOString(), minute: keep(minute), hourly: keep(hourly), latest: keep(latest), servers: Object.fromEntries(servers) }));
    } catch (err) {
      console.warn(`[usage] could not save ${file}: ${err.message}`);
    }
  }

  function dropSite(siteId) {
    for (const m of [minute, hourly, latest]) for (const k of [...m.keys()]) if (k.startsWith(`${siteId}|`)) m.delete(k);
    dirty = true;
  }

  // ------------------------------------------------------------ module

  function routes(router) {
    router.get("/api/sites/:id/usage", (req, res, { params, query }) => {
      const site = ctx.sites?.get?.(params.id);
      if (!site) throw httpError(404, "Website not found");
      return view(site, String(query.range || "24h"));
    });
  }

  function start() {
    load();
    ctx.events?.on?.("site", (d) => {
      if (d?.deleted && d.id) dropSite(d.id);
    });
    const later = setTimeout(() => {
      sample().catch((err) => console.warn(`[usage] ${err.message}`));
      const t = setInterval(() => sample().catch((err) => console.warn(`[usage] ${err.message}`)), SAMPLE_MS);
      t.unref?.();
      timers.push(t);
    }, FIRST_SAMPLE_MS);
    later.unref?.();
    timers.push(later);
    const s = setInterval(save, SAVE_MS);
    s.unref?.();
    timers.push(s);
  }

  function stop() {
    for (const t of timers) clearTimeout(t), clearInterval(t);
    save();
  }

  return { routes, start, stop, sample, view, api: { view: (siteId, range) => (ctx.sites?.get?.(siteId) ? view(ctx.sites.get(siteId), range) : null), sample } };
}
