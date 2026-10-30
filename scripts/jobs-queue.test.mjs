// node --test scripts/ — the job queue in panel/lib/jobs.mjs: heavy jobs wait
// for a free slot on each of their servers; admins reorder, force start and
// cancel; sub-jobs of a heavy job never wait; a restart cancels what waited.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createJobs, RESTART_DROPPED, clampPerServer } from "../panel/lib/jobs.mjs";

function fakeDb(rows = []) {
  const data = { jobs: [...rows] };
  let n = 0;
  return {
    newId: (p) => `${p}_${++n}`,
    insert(coll, obj) {
      (data[coll] ||= []).push(obj);
      return obj;
    },
    get: (coll, id) => (data[coll] || []).find((x) => x.id === id) || null,
    list: (coll, filter) => (data[coll] || []).filter((x) => (typeof filter === "function" ? filter(x) : true)),
    removeWhere(coll, filter) {
      data[coll] = (data[coll] || []).filter((x) => !filter(x));
    },
    save() {},
  };
}

function setup({ perServer, rows } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fcc-jobs-"));
  const events = [];
  const config = perServer ? { queue: { perServer } } : {};
  const db = fakeDb(rows);
  const jobs = createJobs({ db, dataDir: dir, events: { broadcast: (type, data) => events.push({ type, data }) }, config });
  return { jobs, events, config, db, dir };
}

/** A job function that runs until release() is called. */
function gate() {
  let release;
  const done = new Promise((r) => (release = r));
  let started = false;
  return {
    fn: async ({ signal }) => {
      started = true;
      await Promise.race([done, new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))))]);
      return "ok";
    },
    release: () => release(),
    get started() {
      return started;
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));
const heavy = (title, servers, extra = {}) => ({ type: "site.deploy", title, heavy: true, servers, ...extra });

test("one heavy job per server by default; others wait in order", async () => {
  const { jobs } = setup();
  const a = gate(), b = gate(), c = gate();
  const ja = jobs.start(heavy("A", ["main"]), a.fn);
  const jb = jobs.start(heavy("B", ["main"]), b.fn);
  const jc = jobs.start(heavy("C", ["main"]), c.fn);
  assert.equal(ja.status, "running");
  assert.equal(jb.status, "queued");
  assert.equal(jb.position, 1);
  assert.equal(jc.position, 2);
  const q = jobs.queue();
  assert.deepEqual(q.running.map((x) => x.id), [ja.id]);
  assert.deepEqual(q.waiting.map((x) => x.id), [jb.id, jc.id]);
  assert.deepEqual(q.waiting[0].waitingFor, ["A"]);

  a.release();
  await jobs.wait(ja.id);
  await tick();
  assert.equal(jobs.get(jb.id).status, "running");
  assert.equal(jobs.get(jc.id).position, 1);
  b.release();
  await jobs.wait(jb.id);
  await tick();
  assert.equal(jobs.get(jc.id).status, "running");
  c.release();
  await jobs.wait(jc.id);
});

test("different servers run side by side; a multi-server job needs every slot", async () => {
  const { jobs } = setup();
  const a = gate(), b = gate(), c = gate(), d = gate();
  const ja = jobs.start(heavy("A", ["main"]), a.fn);
  const jb = jobs.start(heavy("B", ["srv1"]), b.fn);
  const jc = jobs.start(heavy("C", ["main", "srv2"]), c.fn);
  const jd = jobs.start(heavy("D", ["srv2"]), d.fn);
  assert.equal(ja.status, "running");
  assert.equal(jb.status, "running");
  assert.equal(jc.status, "queued");
  // D's server is free, but C is earlier in line and needs srv2 too: D waits behind it.
  assert.equal(jd.status, "queued");
  a.release();
  await jobs.wait(ja.id);
  await tick();
  assert.equal(jobs.get(jc.id).status, "running");
  assert.equal(jobs.get(jd.id).status, "queued");
  c.release();
  await jobs.wait(jc.id);
  await tick();
  assert.equal(jobs.get(jd.id).status, "running");
  b.release();
  d.release();
  await Promise.all([jobs.wait(jb.id), jobs.wait(jd.id)]);
});

test("light jobs never wait in the queue", async () => {
  const { jobs } = setup();
  const a = gate();
  jobs.start(heavy("A", ["main"]), a.fn);
  const light = jobs.start({ type: "site.restart", title: "Restart", serverId: "main" }, async () => "ok");
  assert.equal(light.status, "running");
  assert.equal(light.heavy, undefined);
  a.release();
});

test("the per-server limit is configurable, and raising it admits waiting jobs", async () => {
  const { jobs, config } = setup({ perServer: 2 });
  const g = [gate(), gate(), gate()];
  const r = g.map((x, i) => jobs.start(heavy(`J${i}`, ["main"]), x.fn));
  assert.deepEqual(r.map((x) => x.status), ["running", "running", "queued"]);
  assert.equal(jobs.setPerServer(3), 3);
  assert.equal(config.queue.perServer, 3);
  assert.equal(r[2].status, "running");
  assert.equal(clampPerServer(0), 1);
  assert.equal(clampPerServer(99), 8);
  assert.equal(clampPerServer("x"), 1);
  g.forEach((x) => x.release());
  await Promise.all(r.map((x) => jobs.wait(x.id)));
});

test("reorder: up, down, top, bottom and by index", async () => {
  const { jobs, events } = setup();
  const a = gate();
  const ja = jobs.start(heavy("A", ["main"]), a.fn);
  const w = ["B", "C", "D"].map((t) => jobs.start(heavy(t, ["main"]), gate().fn));
  const order = () => jobs.queue().waiting.map((x) => x.title);
  assert.deepEqual(order(), ["B", "C", "D"]);
  jobs.move(w[2].id, { to: "top" });
  assert.deepEqual(order(), ["D", "B", "C"]);
  assert.equal(jobs.get(w[2].id).position, 1);
  jobs.move(w[2].id, { to: "down" });
  assert.deepEqual(order(), ["B", "D", "C"]);
  jobs.move(w[0].id, { to: "bottom" });
  assert.deepEqual(order(), ["D", "C", "B"]);
  jobs.move(w[0].id, { index: 0 });
  assert.deepEqual(order(), ["B", "D", "C"]);
  jobs.move(w[0].id, { to: "up" }); // already first: stays
  assert.deepEqual(order(), ["B", "D", "C"]);
  assert.throws(() => jobs.move(ja.id, { to: "top" }), /isn't waiting/);
  assert.throws(() => jobs.move(w[1].id, {}), /Say where/);
  // Every change reached the browsers.
  const last = events.filter((e) => e.type === "queue").at(-1).data;
  assert.deepEqual(last.waiting.map((x) => x.title), ["B", "D", "C"]);

  // The new order is the order they start in.
  a.release();
  await jobs.wait(ja.id);
  await tick();
  assert.equal(jobs.get(w[0].id).status, "running");
  for (const x of w) jobs.cancel(x.id);
});

test("force start runs a waiting job now, past the limit", async () => {
  const { jobs } = setup();
  const a = gate(), b = gate(), c = gate();
  const ja = jobs.start(heavy("A", ["main"]), a.fn);
  const jb = jobs.start(heavy("B", ["main"]), b.fn);
  const jc = jobs.start(heavy("C", ["main"]), c.fn);
  const r = jobs.forceStart(jc.id, { by: "Tryce" });
  assert.equal(r.status, "running");
  assert.equal(r.forced, true);
  await tick();
  assert.ok(c.started);
  const q = jobs.queue();
  assert.deepEqual(q.running.map((x) => x.title).sort(), ["A", "C"]);
  assert.equal(q.running.find((x) => x.title === "C").forced, true);
  assert.deepEqual(q.waiting.map((x) => x.title), ["B"]);
  // B still needs a free slot: both A and C must finish (2 running > limit 1).
  a.release();
  await jobs.wait(ja.id);
  await tick();
  assert.equal(jobs.get(jb.id).status, "queued");
  c.release();
  await jobs.wait(jc.id);
  await tick();
  assert.equal(jobs.get(jb.id).status, "running");
  b.release();
  await jobs.wait(jb.id);
  assert.match(jobs.readLog(jc.id), /Force-started by Tryce/);
});

test("force start can't jump a job on the same website", async () => {
  const { jobs } = setup();
  const a = gate();
  const ja = jobs.start(heavy("A", ["main"], { siteId: "s1" }), a.fn);
  const jb = jobs.start(heavy("B", ["main"], { siteId: "s1" }), gate().fn);
  assert.throws(() => jobs.forceStart(jb.id), (e) => e.code === "locked" && e.jobId === ja.id);
  jobs.cancel(jb.id);
  a.release();
  await jobs.wait(ja.id);
});

test("cancelling a waiting job removes it, runs its cleanup and never calls it", async () => {
  const { jobs } = setup();
  const a = gate();
  const ja = jobs.start(heavy("A", ["main"]), a.fn);
  let called = false, dropped = null;
  const jb = jobs.start(heavy("B", ["main"]), async () => (called = true), { onDropped: (why) => (dropped = why) });
  const jc = jobs.start(heavy("C", ["main"]), gate().fn);
  jobs.cancel(jb.id, { by: "Tryce" });
  assert.equal(jobs.get(jb.id).status, "cancelled");
  assert.equal(jobs.get(jb.id).position, null);
  assert.match(dropped, /before it started/);
  assert.deepEqual(jobs.queue().waiting.map((x) => x.title), ["C"]);
  assert.equal(jobs.get(jc.id).position, 1);
  a.release();
  await jobs.wait(ja.id);
  await tick();
  assert.equal(called, false);
  assert.equal(jobs.get(jc.id).status, "running");
  jobs.cancel(jc.id);
  await jobs.wait(jc.id);
});

test("cancelling a running heavy job frees its slot", async () => {
  const { jobs } = setup();
  const ja = jobs.start(heavy("A", ["main"]), gate().fn);
  const b = gate();
  const jb = jobs.start(heavy("B", ["main"]), b.fn);
  jobs.cancel(ja.id);
  await jobs.wait(ja.id);
  await tick();
  assert.equal(jobs.get(ja.id).status, "cancelled");
  assert.equal(jobs.get(jb.id).status, "running");
  b.release();
  await jobs.wait(jb.id);
});

test("a heavy sub-job inside a running heavy job neither waits nor claims a slot", async () => {
  const { jobs } = setup();
  const other = gate();
  let parentId;
  const parent = jobs.start(heavy("Parent", ["main"], { siteId: "s1" }), async () => {
    // Same server, same site lock: must run at once, not deadlock.
    const sub = jobs.start(heavy("Sub", ["main"], { siteId: "s1" }), async () => "sub done");
    assert.equal(sub.status, "running");
    assert.equal(sub.parentJobId, parentId);
    const fin = await jobs.wait(sub.id);
    assert.equal(fin.status, "succeeded");
    return "parent done";
  });
  parentId = parent.id;
  // Something else waiting on main stays queued meanwhile (only one slot).
  const queued = jobs.start(heavy("Other", ["main"]), other.fn);
  const fin = await jobs.wait(parent.id);
  assert.equal(fin.status, "succeeded", fin.error);
  assert.equal(fin.result, "parent done");
  assert.ok(!jobs.queue().running.some((x) => x.title === "Sub"));
  await tick();
  assert.equal(jobs.get(queued.id).status, "running");
  other.release();
  await jobs.wait(queued.id);
});

test("the per-site lock still serialises jobs, and is not held while waiting", async () => {
  const { jobs } = setup();
  const a = gate(), b = gate();
  const ja = jobs.start(heavy("Deploy s1", ["main"], { siteId: "s1" }), a.fn);
  // Different site, same server: waits for the slot.
  const jb = jobs.start(heavy("Deploy s2", ["main"], { siteId: "s2" }), b.fn);
  // The lock is first-come-first-served: a light job on s2 started after s2's
  // deploy waits behind it (siteJob refuses such a start anyway, 409).
  const jl = jobs.start({ type: "site.restart", title: "Restart s2", siteId: "s2" }, async () => "ok");
  assert.equal(jb.status, "queued");
  assert.equal(jl.status, "queued");
  // ...and it does not count as part of the job queue.
  assert.deepEqual(jobs.queue().waiting.map((x) => x.title), ["Deploy s2"]);
  // A light job on s1 waits for s1's lock as before.
  const js1 = jobs.start({ type: "site.env", title: "Env s1", siteId: "s1" }, async () => "ok");
  assert.equal(js1.status, "queued");
  a.release();
  await jobs.wait(ja.id);
  await jobs.wait(js1.id);
  await tick();
  assert.equal(jobs.get(jb.id).status, "running");
  b.release();
  await jobs.wait(jb.id);
  await jobs.wait(jl.id);
});

test("a panel restart cancels jobs that were waiting in the queue", () => {
  const rows = [
    { id: "job_w", type: "site.deploy", title: "Deploy", status: "queued", heavy: true, servers: ["main"], position: 1 },
    { id: "job_r", type: "site.deploy", title: "Running", status: "running", heavy: true, servers: ["main"] },
    { id: "job_l", type: "site.env", title: "Light", status: "queued" },
    { id: "job_d", type: "site.env", title: "Done", status: "succeeded" },
  ];
  const { jobs, db } = setup({ rows });
  assert.equal(jobs.recover(), 3);
  assert.equal(db.get("jobs", "job_w").status, "cancelled");
  assert.equal(db.get("jobs", "job_w").error, RESTART_DROPPED);
  assert.equal(db.get("jobs", "job_w").position, null);
  assert.match(jobs.readLog("job_w"), /panel restarted while this job was waiting/);
  assert.equal(db.get("jobs", "job_r").status, "failed");
  assert.equal(db.get("jobs", "job_l").status, "failed");
  assert.equal(db.get("jobs", "job_d").status, "succeeded");
});

test("shutdown cancels waiting heavy jobs and runs their cleanup", async () => {
  const { jobs } = setup();
  const ja = jobs.start(heavy("A", ["main"]), gate().fn);
  let dropped = false;
  const jb = jobs.start(heavy("B", ["main"]), async () => {}, { onDropped: () => (dropped = true) });
  jobs.shutdown("panel stopped");
  assert.equal(jobs.get(jb.id).status, "cancelled");
  assert.match(jobs.get(jb.id).error, /^Panel stopped while this job was waiting/);
  assert.equal(jobs.get(ja.id).status, "failed");
  assert.ok(dropped);
});
