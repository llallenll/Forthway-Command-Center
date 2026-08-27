/**
 * The local runner.
 *
 * For a site whose runner is "local" — the app lives on this machine, which
 * is the normal case when the Command Center sits beside the sites it looks
 * after — there is no agent to dial in. The hub runs the same deploy engine
 * itself, in-process.
 *
 * Everything an agent would report over the wire (health, versions, the live
 * command output) is written into exactly the same places, so the dashboard
 * cannot tell the difference and neither can the rest of the server.
 */

import fs from "node:fs";
import { Deployer } from "../../shared/deployer.mjs";

export class LocalRunner {
  constructor({ store, listSites, onStateChange, broadcast }) {
    this.store = store;
    this.listSites = listSites;
    this.onStateChange = onStateChange || (() => {});
    this.broadcast = broadcast || (() => {});
    this.deployers = new Map(); // siteId -> Deployer
    this.busy = new Set();
    this._statusTimer = null;
  }

  /** Bring the set of deployers in line with the current site list. */
  sync() {
    const wanted = new Map(this.listSites().filter((s) => s.runner === "local").map((s) => [s.id, s]));
    for (const id of [...this.deployers.keys()]) {
      if (!wanted.has(id)) {
        this.deployers.get(id)?.stopChild();
        this.deployers.delete(id);
      }
    }
    for (const [id, site] of wanted) {
      const existing = this.deployers.get(id);
      if (existing) existing.setSettings(site.settings);
      else this.deployers.set(id, this._make(site));
    }
    // A newly added local site should show real numbers straight away.
    this.refreshStatus().catch(() => {});
  }

  _make(site) {
    const d = new Deployer({
      settings: site.settings,
      getArtifact: async (releaseId) => {
        const file = this.store.releasePath(releaseId);
        if (!fs.existsSync(file)) throw new Error("That release archive is no longer on this machine.");
        return fs.readFileSync(file);
      },
    });
    // When the engine is supervising the app itself, its console output is
    // worth seeing — pipe it to anyone watching the dashboard.
    d.onChildOutput = (text) => {
      this.broadcast("app-output", { siteId: site.id, text: text.slice(-4000) });
    };
    return d;
  }

  deployer(siteId) {
    return this.deployers.get(siteId) || null;
  }

  /** Run whatever is queued for this site, if it is local and idle. */
  async kick(siteId) {
    const d = this.deployers.get(siteId);
    if (!d || this.busy.has(siteId)) return;
    const job = this.store.nextQueuedJob(siteId);
    if (!job) return;
    if (this.store.runningJob(siteId)) return;

    this.busy.add(siteId);
    job.status = "running";
    job.startedAt = new Date().toISOString();
    this.store.save({ immediate: true });
    this.onStateChange();

    const log = this._logger(job);
    log.line(`Forthway Command Center — running "${job.type}" on this machine`);

    // The engine wants the release's details alongside the job, the same way
    // a remote agent is handed them over the wire.
    const rel = job.releaseId ? this.store.release(job.releaseId) : null;
    const enriched = {
      ...job,
      releaseFilename: rel?.filename || null,
      releaseVersion: rel?.version ?? job.releaseVersion ?? null,
      releaseSha256: rel?.sha256 || null,
      releasePrebuilt: !!rel?.prebuilt,
    };

    try {
      const result = await d.execute(enriched, log);
      await log.flush();
      this._finish(job, { ok: true, ...result });
    } catch (err) {
      log.line(`\n!! FAILED: ${err.message}`);
      await log.flush();
      this._finish(job, {
        ok: false,
        error: err.message,
        rolledBackTo: err.rolledBackTo || null,
        deployed: err.deployed ?? d.readDeployedInfo(),
        serving: err.serving ?? (await d.readServingInfo().catch(() => null)),
        health: err.health ?? (await d.checkHealth().catch(() => null)),
      });
    } finally {
      d.cleanup();
      this.busy.delete(siteId);
      // Anything queued behind this one runs next.
      setTimeout(() => this.kick(siteId).catch(() => {}), 50);
    }
  }

  _logger(job) {
    const store = this.store;
    const broadcast = this.broadcast;
    const onStateChange = this.onStateChange;
    let buffer = [];
    const flush = () => {
      if (!buffer.length) return;
      const lines = buffer;
      buffer = [];
      store.appendLog(job.id, lines);
      broadcast("log", { jobId: job.id, siteId: job.siteId, lines });
    };
    const timer = setInterval(flush, 400);
    timer.unref?.();
    return {
      line(text) {
        for (const l of String(text).replace(/\r/g, "").split("\n")) buffer.push(l);
        if (buffer.length > 40) flush();
      },
      setStep(step) {
        job.step = step;
        store.save();
        onStateChange();
        this.line(`\n── ${step} ─────────────────────────────`);
        flush();
      },
      async flush() {
        flush();
        clearInterval(timer);
      },
    };
  }

  _finish(job, body) {
    const state = this.store.site(job.siteId);
    job.status = body.ok ? "success" : "failed";
    job.finishedAt = new Date().toISOString();
    job.error = body.error || null;
    job.summary = body.summary || null;
    job.step = null;

    for (const key of ["deployed", "serving", "health", "migrations", "appRunning"]) {
      if (body[key] !== undefined) state[key] = body[key];
    }
    state.lastError = body.ok ? null : body.error || null;

    if (body.ok && (job.type === "deploy" || job.type === "rollback")) {
      if (state.currentReleaseId && state.currentReleaseId !== job.releaseId) {
        state.previousReleaseId = state.currentReleaseId;
      }
      state.currentReleaseId = job.releaseId;
      state.lastDeployAt = job.finishedAt;
      const rel = this.store.release(job.releaseId);
      if (rel) {
        rel.deployCount = (rel.deployCount || 0) + 1;
        rel.lastDeployedAt = job.finishedAt;
      }
    }
    if (body.rolledBackTo) state.currentReleaseId = body.rolledBackTo;

    this.store.save({ immediate: true });
    this.onStateChange();
    this.broadcast("job-finished", { jobId: job.id, siteId: job.siteId, ok: !!body.ok, error: job.error });
  }

  /** Refresh health and versions for every local site. */
  async refreshStatus() {
    let changed = false;
    for (const [id, d] of this.deployers) {
      if (this.busy.has(id)) continue; // a deploy is mid-flight; leave it alone
      try {
        const st = await d.status();
        const state = this.store.site(id);
        state.lastHeartbeat = new Date().toISOString();
        state.agentOnline = true;
        state.agentVersion = "local";
        state.deployed = st.deployed;
        state.serving = st.serving;
        state.health = st.health;
        state.appRunning = st.appRunning;
        state.migrations = st.migrations;
        state.runtime = st.runtime;
        changed = true;
      } catch {
        /* a site whose directory is missing is not a reason to stop */
      }
    }
    if (changed) {
      this.store.save();
      this.onStateChange();
    }
  }

  startPolling(intervalMs = 12_000) {
    if (this._statusTimer) clearInterval(this._statusTimer);
    this._statusTimer = setInterval(() => this.refreshStatus().catch(() => {}), intervalMs);
    this._statusTimer.unref?.();
    this.refreshStatus().catch(() => {});
  }

  stopAll() {
    for (const d of this.deployers.values()) d.stopChild();
  }
}
