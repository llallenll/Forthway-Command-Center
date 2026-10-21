/**
 * Replacing the main server — the old main's side (docs/STANDALONE.md, 3.12.0
 * "Change the main server"). Both tasks only run on main's embedded agent
 * (`isMain`), i.e. while another server runs the active panel:
 *
 *   main.handoff { kind: "backup", file }   upload one local backup archive
 *                                           (<panel data>/backups/<file>) to the panel
 *   main.handoff { kind: "letsencrypt" }    upload /etc/letsencrypt as a tar.gz
 *   main.retire  { delaySeconds }           a moment after answering: stop and
 *                                           disable fcc.service, move the panel's
 *                                           data folder aside (it holds secrets)
 *
 * The panel decides what is copied and where it lands (/agent/upload/:taskId);
 * nothing here takes a path from the payload without checking it stays inside
 * the backups folder. Under FCC_DRY_RUN the letsencrypt archive and the retire
 * step are simulated; backup files are uploaded for real (they live in the
 * dev data folder).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

import { ensureDir, exists } from "./fsx.mjs";
import * as sys from "../panel/lib/sys.mjs";

const NOOP = () => {};
const REL_RE = /^[\w][\w./-]{0,300}$/;
const LETSENCRYPT = "/etc/letsencrypt";
const PANEL_UNIT = "fcc.service";

/** The panel's data folder on main: main's embedded agent keeps its own data in <panel data>/agent. */
export function panelDataDirOf(o) {
  const own = path.resolve(o.dataDir || "");
  if (path.basename(own) === "agent") return path.dirname(own);
  return path.resolve(process.env.FCC_DATA_DIR || "/var/lib/fcc");
}

function requireMain(o, what) {
  if (!o.isMain) throw new Error(`${what}: only the main server's own agent runs this.`);
}

export async function mainHandoff(payload, o) {
  const log = o.log || NOOP;
  requireMain(o, "main.handoff");
  if (!o.uploadFile) throw new Error("main.handoff: this agent cannot upload files to the panel.");
  const kind = payload?.kind;

  if (kind === "backup") {
    const rel = String(payload.file || "");
    if (!REL_RE.test(rel) || rel.split("/").includes("..")) throw new Error(`main.handoff: "${rel}" is not a backup file name.`);
    const root = path.join(panelDataDirOf(o), "backups");
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep)) throw new Error("main.handoff: that file is outside the backups folder.");
    if (!exists(abs)) return { uploaded: false, missing: true, file: rel };
    const size = fs.statSync(abs).size;
    log(`Sending ${rel} (${(size / 1048576).toFixed(1)} MB)…`);
    const up = await o.uploadFile(abs, { name: path.basename(rel), size });
    return { uploaded: true, file: rel, size: up?.size ?? size, sha256: up?.sha256 || null };
  }

  if (kind === "letsencrypt") {
    if (!sys.DRY_RUN && !exists(path.join(LETSENCRYPT, "live")) && !exists(path.join(LETSENCRYPT, "renewal"))) {
      log("No Let's Encrypt certificates on this server.");
      return { uploaded: false, missing: true };
    }
    const tmp = ensureDir(path.join(o.dataDir, "tmp"));
    const file = path.join(tmp, `letsencrypt-${Date.now()}.tar.gz`);
    try {
      if (sys.DRY_RUN) {
        await sys.run("tar", ["-czf", file, "-C", "/", "etc/letsencrypt"], { log });
        fs.writeFileSync(file, ""); // nothing to extract in a dry run
      } else {
        // -p keeps modes; live/ is symlinks into archive/, which tar keeps as symlinks.
        await sys.run("tar", ["-czpf", file, "-C", "/", "etc/letsencrypt"], { log, signal: o.signal, timeoutMs: 30 * 60_000 });
      }
      const size = fs.statSync(file).size;
      log(`Sending the Let's Encrypt folder (${(size / 1024).toFixed(0)} KB)…`);
      const up = await o.uploadFile(file, { name: path.basename(file), size });
      return { uploaded: true, size: up?.size ?? size, sha256: up?.sha256 || null };
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  throw new Error(`main.handoff: unknown kind "${kind}".`);
}

export async function mainRetire(payload, o) {
  const log = o.log || NOOP;
  requireMain(o, "main.retire");
  const delay = Math.min(300, Math.max(5, Math.floor(Number(payload?.delaySeconds) || 15)));
  const data = panelDataDirOf(o);
  // Only move a folder that really is a panel data folder.
  const looksLikePanel = exists(path.join(data, "config.json")) && exists(path.join(data, "db.json"));
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const kept = `${data}.retired-${stamp}`;
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const steps = [`systemctl disable --now ${PANEL_UNIT}`];
  if (looksLikePanel) steps.push(`mv ${q(data)} ${q(kept)}`);
  const script = steps.join("; ");

  if (sys.DRY_RUN) {
    log(`[dry-run] in ${delay}s: ${script}`);
    return { scheduled: true, delaySeconds: delay, keptData: looksLikePanel ? kept : null, hostname: os.hostname(), dryRun: true };
  }
  if (sys.which("systemd-run")) {
    // A transient unit outlives fcc.service (the embedded agent is its child, so it is stopped too).
    await sys.run("systemd-run", [`--on-active=${delay}`, `--unit=fcc-retire-${stamp}`, "--collect", "/bin/sh", "-c", script], { log, timeoutMs: 30_000 });
  } else {
    const child = spawn("setsid", ["/bin/sh", "-c", `sleep ${delay}; ${script}`], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  }
  log(`In ${delay} seconds this server stops and disables the panel (${PANEL_UNIT})${looksLikePanel ? ` and moves ${data} to ${kept}` : ""}.`);
  log("Websites, nginx and MySQL on this server are left alone — shut the machine down when you are ready.");
  return { scheduled: true, delaySeconds: delay, keptData: looksLikePanel ? kept : null, hostname: os.hostname() };
}
