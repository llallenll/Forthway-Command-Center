/**
 * Persistent state for the Forthway Command Center.
 *
 * Everything lives in one JSON file plus a directory of release archives and
 * job logs. No database on purpose: this is the tool you reach for on the day
 * the database is exactly what you broke.
 *
 * Site *definitions* live in config.json — they hold tokens and are edited
 * from the browser. What lives here is everything reported back about them,
 * whether by a remote agent or by the local runner in this same process.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, readJson, writeJson, rmrf } from "../../shared/fsx.mjs";

const MAX_JOBS_KEPT = 300;

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.stateFile = path.join(dataDir, "state.json");
    this.releasesDir = ensureDir(path.join(dataDir, "releases"));
    this.logsDir = ensureDir(path.join(dataDir, "logs"));
    const loaded = readJson(this.stateFile, null) || {};
    this.state = {
      sites: loaded.sites || {},
      releases: loaded.releases || [],
      jobs: loaded.jobs || [],
    };
    this._saveTimer = null;
  }

  /** Debounced write — a deploy generates a lot of small state changes. */
  save({ immediate = false } = {}) {
    if (immediate) {
      if (this._saveTimer) clearTimeout(this._saveTimer);
      this._saveTimer = null;
      writeJson(this.stateFile, this.state);
      return;
    }
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      writeJson(this.stateFile, this.state);
    }, 400);
  }

  // ---------------------------------------------------------------- sites

  site(siteId) {
    this.state.sites[siteId] ||= {
      id: siteId,
      online: false,
      lastHeartbeat: null,
      runnerVersion: null,
      settingsHash: null,
      deployed: null, // what the files on disk say
      serving: null, // what the running process reports
      health: null,
      appRunning: null,
      currentReleaseId: null,
      previousReleaseId: null,
      migrations: [],
      runtime: null,
      lastDeployAt: null,
      lastError: null,
    };
    return this.state.sites[siteId];
  }

  /** Called when a site is removed from the UI. */
  forgetSite(siteId) {
    delete this.state.sites[siteId];
    for (const rel of this.releasesForSite(siteId)) this.deleteRelease(rel.id);
    for (const job of this.state.jobs.filter((j) => j.siteId === siteId)) rmrf(this.logPath(job.id));
    this.state.jobs = this.state.jobs.filter((j) => j.siteId !== siteId);
    this.save({ immediate: true });
  }

  // ------------------------------------------------------------- releases

  releasePath(releaseId) {
    return path.join(this.releasesDir, `${releaseId}.zip`);
  }

  newReleaseId() {
    return `r_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
  }

  addRelease(rel) {
    this.state.releases.unshift(rel);
    this.save();
    return rel;
  }

  release(releaseId) {
    return this.state.releases.find((r) => r.id === releaseId) || null;
  }

  releasesForSite(siteId) {
    return this.state.releases.filter((r) => r.siteId === siteId);
  }

  deleteRelease(releaseId) {
    const idx = this.state.releases.findIndex((r) => r.id === releaseId);
    if (idx === -1) return false;
    rmrf(this.releasePath(releaseId));
    this.state.releases.splice(idx, 1);
    this.save({ immediate: true });
    return true;
  }

  /** Keep the archive directory from growing without bound. */
  pruneReleases(siteId, keep) {
    const site = this.site(siteId);
    const protectedIds = new Set([site.currentReleaseId, site.previousReleaseId].filter(Boolean));
    const prunable = this.releasesForSite(siteId).filter((r) => !protectedIds.has(r.id) && !r.pinned);
    const excess = prunable.slice(keep);
    for (const r of excess) this.deleteRelease(r.id);
    return excess.length;
  }

  // ----------------------------------------------------------------- jobs

  addJob(job) {
    this.state.jobs.unshift(job);
    if (this.state.jobs.length > MAX_JOBS_KEPT) {
      for (const old of this.state.jobs.splice(MAX_JOBS_KEPT)) rmrf(this.logPath(old.id));
    }
    this.save();
    return job;
  }

  job(jobId) {
    return this.state.jobs.find((j) => j.id === jobId) || null;
  }

  jobsForSite(siteId, limit = 25) {
    return this.state.jobs.filter((j) => j.siteId === siteId).slice(0, limit);
  }

  nextQueuedJob(siteId) {
    const queued = this.state.jobs.filter((j) => j.siteId === siteId && j.status === "queued");
    return queued.length ? queued[queued.length - 1] : null; // oldest first
  }

  runningJob(siteId) {
    return this.state.jobs.find((j) => j.siteId === siteId && j.status === "running") || null;
  }

  /**
   * A job whose runner died mid-flight would otherwise sit at "running"
   * forever and block every future job for that site.
   */
  reapStaleJobs(staleAfterMs = 45 * 60_000) {
    let changed = false;
    for (const j of this.state.jobs) {
      if (j.status !== "running") continue;
      const started = j.startedAt ? new Date(j.startedAt).getTime() : 0;
      if (started && Date.now() - started < staleAfterMs) continue;
      j.status = "failed";
      j.error = "The runner stopped reporting before this job finished.";
      j.finishedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) this.save({ immediate: true });
    return changed;
  }

  /** Called when the hub restarts: nothing can still be running. */
  markInterruptedJobs() {
    let changed = false;
    for (const j of this.state.jobs) {
      if (j.status !== "running") continue;
      j.status = "failed";
      j.error = "Interrupted — the Command Center restarted while this job was running.";
      j.finishedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) this.save({ immediate: true });
  }

  // ----------------------------------------------------------------- logs

  logPath(jobId) {
    return path.join(this.logsDir, `${jobId}.log`);
  }

  appendLog(jobId, lines) {
    if (!lines?.length) return;
    const text = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";
    fs.appendFileSync(this.logPath(jobId), text);
  }

  readLog(jobId) {
    try {
      return fs.readFileSync(this.logPath(jobId), "utf8");
    } catch {
      return "";
    }
  }
}
