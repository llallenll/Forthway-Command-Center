#!/usr/bin/env node
/**
 * Forthway Command Center — Agent server agent (one per SERVER).
 *
 * Runs on every server other than the main one. It only ever dials OUT to the
 * panel — nothing on this machine needs to accept connections from it — and
 * it only executes the named task types in shared/tasks.mjs (deploy a site,
 * start/stop it, read its logs, report metrics, make a backup…). There is no
 * way for the panel to make it run an arbitrary command.
 *
 * Config: /etc/fcc-node/config.json  { panelUrl, serverId, token }
 *   (override with --config <file> or FCC_NODE_CONFIG)
 * Optional: dataDir (default /var/lib/fcc-node), maxConcurrent (default 4).
 *
 * Protocol (see panel/lib/cluster.mjs): hello → long-poll for tasks → stream
 * each task's log → post its result; metrics pushed every ~15s.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { executeTask, collectMetrics, systemInfo, TASK_TYPES } from "../shared/tasks.mjs";

export const AGENT_VERSION = "3.0.0";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// ------------------------------------------------------------------ config

function loadConfig() {
  const i = process.argv.indexOf("--config");
  const file = path.resolve(i !== -1 ? process.argv[i + 1] : process.env.FCC_NODE_CONFIG || "/etc/fcc-node/config.json");
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`[fcc-node] cannot read ${file}: ${err.message}`);
    console.error("[fcc-node] add this server in the panel (Settings → Servers) and run the install command it gives you.");
    process.exit(78); // EX_CONFIG — systemd keeps retrying with RestartSec
  }
  if (!cfg.panelUrl || !cfg.serverId || !cfg.token) {
    console.error(`[fcc-node] ${file} needs panelUrl, serverId and token.`);
    process.exit(78);
  }
  cfg.panelUrl = String(cfg.panelUrl).replace(/\/+$/, "");
  cfg.dataDir = cfg.dataDir || process.env.FCC_NODE_DATA_DIR || "/var/lib/fcc-node";
  cfg.maxConcurrent = Number(cfg.maxConcurrent) || 4;
  return cfg;
}

const cfg = loadConfig();
fs.mkdirSync(cfg.dataDir, { recursive: true });

const log = (...a) => console.log(`[fcc-node] ${a.join(" ")}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- panel client

class PanelError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function api(method, p, body, { timeoutMs = 30_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.panelUrl + p, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "User-Agent": `fcc-node/${AGENT_VERSION}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not json */
    }
    if (!res.ok) throw new PanelError(res.status, json?.error || `HTTP ${res.status}`, json);
    return json;
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`${method} ${p} timed out`);
    throw err;
  } finally {
    clearTimeout(t);
  }
}

/** Stream a file to the panel (backups can be many GB — never buffered). */
function uploadTo(urlPath, file, { sha256 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, cfg.panelUrl + "/");
    const size = fs.statSync(file).size;
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "Content-Type": "application/gzip",
          "Content-Length": size,
          "User-Agent": `fcc-node/${AGENT_VERSION}`,
          ...(sha256 ? { "X-FCC-Sha256": sha256 } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not json */
          }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json || {});
          else reject(new Error(`upload failed: ${json?.error || `HTTP ${res.statusCode}`}`));
        });
      },
    );
    req.on("error", reject);
    fs.createReadStream(file).on("error", reject).pipe(req);
  });
}

// ------------------------------------------------------------ self-update

function localFileHashes() {
  const out = {};
  const add = (rel) => {
    try {
      out[rel] = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, rel))).digest("hex");
    } catch {
      /* missing */
    }
  };
  for (const dir of ["node", "shared"]) {
    try {
      for (const f of fs.readdirSync(path.join(ROOT, dir))) if (f.endsWith(".mjs")) add(`${dir}/${f}`);
    } catch {
      /* missing dir */
    }
  }
  add("panel/lib/sys.mjs");
  return out;
}

async function selfUpdate(files) {
  if (process.env.FCC_NODE_NO_UPDATE === "1") {
    log(`panel has newer agent files (${files.join(", ")}) — self-update disabled, continuing.`);
    return false;
  }
  const marker = path.join(cfg.dataDir, "last-update.json");
  try {
    const last = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (Date.now() - last.at < 5 * 60_000 && last.files.join() === files.join()) {
      log("skipping self-update (the same update was applied moments ago and did not settle).");
      return false;
    }
  } catch {
    /* no marker */
  }
  const staged = [];
  for (const rel of files) {
    if (!/^(node|shared)\/[\w.-]+\.mjs$/.test(rel) && rel !== "panel/lib/sys.mjs") continue;
    const res = await fetch(`${cfg.panelUrl}/install/files/${rel}`, { headers: { Authorization: `Bearer ${cfg.token}` } });
    if (!res.ok) throw new Error(`could not download ${rel}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const want = res.headers.get("x-fcc-sha256");
    const got = crypto.createHash("sha256").update(buf).digest("hex");
    if (want && want !== got) throw new Error(`${rel} failed its checksum`);
    staged.push([rel, buf]);
  }
  for (const [rel, buf] of staged) {
    const dest = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
  }
  fs.writeFileSync(marker, JSON.stringify({ at: Date.now(), files }));
  log(`updated ${staged.length} file(s) from the panel — restarting.`);
  return true;
}

// ------------------------------------------------------------------- tasks

const running = new Map(); // taskId -> { ctrl, settled }

class TaskLog {
  constructor(taskId, ctrl) {
    this.id = taskId;
    this.ctrl = ctrl;
    this.buf = [];
    this.flushing = null;
    this.timer = setInterval(() => this.flush(), 700);
  }
  line = (text) => {
    for (const l of String(text ?? "").replace(/\r/g, "").split("\n")) this.buf.push(l);
    if (this.buf.length > 200) this.flush();
  };
  async flush() {
    if (this.flushing) return this.flushing;
    if (!this.buf.length) return;
    const lines = this.buf.splice(0, this.buf.length);
    this.flushing = api("POST", `/agent/tasks/${this.id}/log`, { lines }, { timeoutMs: 20_000 })
      .then((r) => {
        if (r?.cancel && !this.ctrl.signal.aborted) {
          log(`task ${this.id}: cancelled by the panel`);
          this.ctrl.abort();
        }
      })
      .catch((err) => {
        if (err.status === 404) return; // panel forgot the task (restarted) — drop the lines
        if (lines.length < 2000) this.buf.unshift(...lines); // retry next tick
      })
      .finally(() => (this.flushing = null));
    return this.flushing;
  }
  async close() {
    clearInterval(this.timer);
    await this.flush();
    if (this.buf.length) await this.flush();
  }
}

async function runTask(t) {
  if (running.has(t.id)) return;
  const ctrl = new AbortController();
  running.set(t.id, { ctrl });
  const tl = new TaskLog(t.id, ctrl);
  const started = Date.now();
  log(`task ${t.id}: ${t.type} started`);
  let body;
  try {
    if (!TASK_TYPES.includes(t.type)) throw new Error(`This agent (v${AGENT_VERSION}) does not know the task "${t.type}".`);
    const result = await executeTask(t.type, t.payload || {}, {
      log: tl.line,
      signal: ctrl.signal,
      dataDir: cfg.dataDir,
      isMain: false,
      serverId: cfg.serverId,
      authToken: cfg.token,
      panelUrl: cfg.panelUrl,
      uploadFile: (file, meta) => uploadTo(t.payload?.upload?.url || `/agent/upload/${t.id}`, file, meta),
    });
    body = { ok: true, result: result ?? null };
  } catch (err) {
    tl.line(err.aborted ? `-- ${err.message}` : `!! ${err.message}`);
    body = { ok: false, error: err.message, aborted: !!err.aborted || ctrl.signal.aborted, result: err.result || null };
  }
  await tl.close();
  log(`task ${t.id}: ${t.type} ${body.ok ? "succeeded" : body.aborted ? "cancelled" : "failed"} in ${Math.round((Date.now() - started) / 1000)}s`);
  // Keep it in `running` until the panel has the result, so a poll in between
  // never makes the panel think the task was lost.
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await api("POST", `/agent/tasks/${t.id}/result`, body, { timeoutMs: 30_000 });
      break;
    } catch (err) {
      if (err.status === 404) break;
      await sleep(Math.min(30_000, 1000 * 2 ** attempt));
    }
  }
  running.delete(t.id);
}

// ------------------------------------------------------------------- loops

let pollWaitMs = 25_000;
let metricsIntervalMs = 15_000;
let stopping = false;

async function hello() {
  let backoff = 1000;
  for (;;) {
    try {
      const r = await api("POST", "/agent/hello", {
        agentVersion: AGENT_VERSION,
        info: systemInfo(),
        files: localFileHashes(),
      });
      pollWaitMs = Number(r?.pollWaitMs) || pollWaitMs;
      metricsIntervalMs = Number(r?.metricsIntervalMs) || metricsIntervalMs;
      log(`connected to ${cfg.panelUrl} as "${r?.name || cfg.serverId}" (panel ${r?.panelVersion || "?"})`);
      if (Array.isArray(r?.update) && r.update.length) {
        try {
          if (await selfUpdate(r.update)) process.exit(0); // systemd restarts us on the new code
        } catch (err) {
          log(`self-update failed: ${err.message} — continuing on the current version`);
        }
      }
      return;
    } catch (err) {
      const wait = err.status === 401 ? 60_000 : backoff;
      log(`hello failed: ${err.status === 401 ? "the panel rejected this server's token (re-run the install command)" : err.message} — retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

async function pollLoop() {
  let backoff = 1000;
  while (!stopping) {
    try {
      const qs = new URLSearchParams({ wait: String(Math.round(pollWaitMs / 1000)), running: [...running.keys()].join(",") });
      const r = await api("GET", `/agent/poll?${qs}`, undefined, { timeoutMs: pollWaitMs + 15_000 });
      backoff = 1000;
      for (const id of r?.cancel || []) running.get(id)?.ctrl.abort();
      for (const t of r?.tasks || []) runTask(t).catch((err) => log(`task ${t.id} crashed: ${err.message}`));
    } catch (err) {
      if (stopping) return;
      if (err.status === 401) {
        log("the panel rejected this server's token — was it rotated or the server removed? Retrying in 60s.");
        await sleep(60_000);
        await hello();
        continue;
      }
      log(`poll failed: ${err.message} — retrying in ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

async function metricsLoop() {
  while (!stopping) {
    try {
      const m = await collectMetrics();
      await api("POST", "/agent/metrics", m, { timeoutMs: 15_000 });
    } catch (err) {
      if (err.status && err.status !== 401) log(`metrics push failed: ${err.message}`);
    }
    await sleep(metricsIntervalMs);
  }
}

async function main() {
  log(`Forthway node agent v${AGENT_VERSION} on ${os.hostname()} · server ${cfg.serverId} · panel ${cfg.panelUrl}`);
  await hello();
  metricsLoop();
  await pollLoop();
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    if (stopping) process.exit(0);
    stopping = true;
    log(`${sig} — stopping${running.size ? ` (cancelling ${running.size} running task(s))` : ""}`);
    for (const r of running.values()) r.ctrl.abort();
    const deadline = Date.now() + 8000;
    while (running.size && Date.now() < deadline) await sleep(200);
    process.exit(0);
  });
}

process.on("unhandledRejection", (err) => log(`unhandled rejection: ${err?.stack || err}`));

main().catch((err) => {
  console.error("[fcc-node] fatal:", err);
  process.exit(1);
});
