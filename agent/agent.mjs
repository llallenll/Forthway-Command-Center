#!/usr/bin/env node
/**
 * Forthway Command Center — remote agent
 *
 * Only needed for a site that is NOT on the same machine as the Command
 * Center. It runs beside that app, dials OUT to the hub, and asks for work.
 * Nothing needs to be opened up on this machine.
 *
 * The actual deploying is done by shared/deployer.mjs — the same engine the
 * Command Center uses for local sites — so a remote site behaves exactly like
 * a local one.
 *
 * Its config file holds three things: where the hub is, which site this is,
 * and the token. Everything else — app directory, port, build commands, how
 * to restart — is pushed down from the browser on every poll.
 *
 * Usage:  node agent.mjs [--config ./agent.config.json]
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { Deployer } from "../shared/deployer.mjs";
import { readJson } from "../shared/fsx.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_VERSION = "2.0.0";

// ------------------------------------------------------------------ config

function loadLocalConfig() {
  const argIdx = process.argv.indexOf("--config");
  const file = path.resolve(
    argIdx !== -1 ? process.argv[argIdx + 1] : process.env.FCC_AGENT_CONFIG || path.join(HERE, "agent.config.json"),
  );
  const cfg = readJson(file, null);
  if (!cfg) {
    console.error(`[agent] config not found: ${file}`);
    console.error(`[agent] add the site in the Command Center and run the installer one-liner it gives you,`);
    console.error(`[agent] or copy agent.config.example.json to agent.config.json and fill it in.`);
    process.exit(1);
  }
  cfg.siteId = cfg.siteId || cfg.agentId;
  cfg.agentToken = cfg.agentToken || cfg.token;
  if (!cfg.hubUrl || !cfg.siteId || !cfg.agentToken) {
    console.error(`[agent] ${file} needs hubUrl, siteId and agentToken.`);
    process.exit(1);
  }
  cfg.__file = file;
  cfg.workDir = cfg.workDir || ".forthway";
  return cfg;
}

const local = loadLocalConfig();
let settingsHash = null;

// --------------------------------------------------------------- hub client

function hubUrl(p) {
  return new URL(p, local.hubUrl).toString();
}

async function hubPost(p, body, { timeoutMs = 40_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(hubUrl(p), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fcc-token": local.agentToken },
      body: JSON.stringify({ siteId: local.siteId, ...body }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`hub ${p} -> ${res.status} ${await res.text().catch(() => "")}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchArtifact(releaseId) {
  const res = await fetch(hubUrl(`/agent/artifact/${releaseId}?site=${encodeURIComponent(local.siteId)}`), {
    headers: { "x-fcc-token": local.agentToken },
  });
  if (!res.ok) throw new Error(`Could not download the release: ${res.status} ${await res.text().catch(() => "")}`);
  return Buffer.from(await res.arrayBuffer());
}

// ------------------------------------------------------------------ engine

const deployer = new Deployer({
  settings: { appDir: local.appDir || "" },
  getArtifact: fetchArtifact,
  workDirName: local.workDir,
});

/** Streams the engine's output back to the hub so you can watch it happen. */
class JobLogger {
  constructor(jobId) {
    this.jobId = jobId;
    this.buffer = [];
    this.step = null;
    this.timer = setInterval(() => this.flush(), 700);
    this.timer.unref?.();
  }
  line(text) {
    for (const l of String(text).replace(/\r/g, "").split("\n")) this.buffer.push(l);
    console.log(`[job ${this.jobId}] ${text}`);
    if (this.buffer.length > 60) this.flush();
  }
  setStep(step) {
    this.step = step;
    this.line(`\n-- ${step} -----------------------------`);
    this.flush();
  }
  async flush() {
    if (!this.buffer.length && !this.step) return;
    const lines = this.buffer.splice(0, this.buffer.length);
    try {
      await hubPost("/agent/log", { jobId: this.jobId, lines, step: this.step });
    } catch {
      // Losing a log line must never fail a deploy. Put them back so the next
      // flush retries once.
      if (lines.length < 500) this.buffer.unshift(...lines);
    }
  }
  async close() {
    clearInterval(this.timer);
    await this.flush();
  }
}

async function runJob(job) {
  const log = new JobLogger(job.id);
  log.line(`Forthway agent ${AGENT_VERSION} on ${os.hostname()} — job: ${job.type}`);
  try {
    const result = await deployer.execute(job, log);
    await log.close();
    await hubPost("/agent/result", { jobId: job.id, ok: true, ...result });
  } catch (err) {
    log.line(`\n!! FAILED: ${err.message}`);
    await log.close();
    await hubPost("/agent/result", {
      jobId: job.id,
      ok: false,
      error: err.message,
      rolledBackTo: err.rolledBackTo || null,
      deployed: err.deployed ?? deployer.readDeployedInfo(),
      serving: err.serving ?? (await deployer.readServingInfo().catch(() => null)),
      health: err.health ?? (await deployer.checkHealth().catch(() => null)),
    }).catch((e) => console.error("[agent] could not report the failure:", e.message));
  } finally {
    deployer.cleanup();
  }
}

// ------------------------------------------------------------- the poll loop

let busy = false;

async function pollOnce() {
  const status = await deployer.status().catch(() => ({}));

  const res = await hubPost(
    "/agent/poll",
    { agentVersion: AGENT_VERSION, settingsHash, ...status },
    { timeoutMs: 40_000 },
  );

  if (res.settings && res.settingsHash !== settingsHash) {
    const first = settingsHash === null;
    const s = { ...res.settings };
    // A local override wins for appDir, so a box with an unusual layout can
    // pin it and nobody can point this agent somewhere else remotely.
    if (local.appDir) s.appDir = local.appDir;
    deployer.setSettings(s);
    settingsHash = res.settingsHash;
    console.log(
      `[agent] ${first ? "loaded" : "updated"} settings from the Command Center` +
        (s.appDir ? ` · app dir ${s.appDir}` : " · no app directory set yet"),
    );
    if (s.restart?.mode === "child" && s.appDir && local.autoStart !== false && !deployer.child) {
      deployer.startChild();
    }
  }

  if (res.job) {
    busy = true;
    try {
      await runJob(res.job);
    } finally {
      busy = false;
    }
  }
}

async function main() {
  console.log(`[agent] Forthway agent v${AGENT_VERSION}`);
  console.log(`[agent] site "${local.siteId}" · hub ${local.hubUrl}`);
  console.log(`[agent] waiting for settings from the Command Center…`);

  let backoff = 1000;
  for (;;) {
    try {
      await pollOnce();
      backoff = 1000;
    } catch (err) {
      console.error(`[agent] poll failed: ${err.message} — retrying in ${Math.round(backoff / 1000)}s`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
    if (!busy) await new Promise((r) => setTimeout(r, 250));
  }
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    await deployer.stopChild();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[agent] fatal:", err);
  process.exit(1);
});
