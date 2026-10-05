#!/usr/bin/env node
/**
 * Break-glass sign-in for the panel owner.
 *
 *   sudo node /opt/fcc/panel/recover.mjs
 *
 * Prints a one-time sign-in link, valid for 15 minutes, that signs in as the
 * owner without GitHub — for when the GitHub OAuth App is broken, deleted or
 * misconfigured. Open it, then fix things in Settings → Security.
 *
 * Only someone who can run commands as root on the server can make one: the
 * link's token is written (as a sha256, never in clear) to
 * <data dir>/recovery.json, mode 600, and the running panel redeems it at
 * GET /auth/recover once. Making a new link replaces any earlier one.
 *
 * The data dir is FCC_DATA_DIR, else the one fcc.service runs with, else
 * /var/lib/fcc. Options: --admin <id|github login|email> to sign in as
 * someone other than the owner; --url <base> to print a different address.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const TTL_MS = 15 * 60 * 1000;

function die(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** Environment of fcc.service (FCC_DATA_DIR, FCC_PANEL_URL, FCC_PORT…), when systemd has it. */
function serviceEnv() {
  try {
    const out = execFileSync("systemctl", ["show", "fcc", "--property=Environment", "--value"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    const env = {};
    for (const m of out.matchAll(/(?:^|\s)(FCC_[A-Z_]+)=("[^"]*"|\S*)/g)) env[m[1]] = m[2].replace(/^"|"$/g, "");
    return env;
  } catch {
    return {};
  }
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: sudo node /opt/fcc/panel/recover.mjs [--admin <id|github login|email>] [--url https://panel.example.com]");
  process.exit(0);
}

const svc = process.env.FCC_DATA_DIR ? {} : serviceEnv();
const dataDir = path.resolve(process.env.FCC_DATA_DIR || svc.FCC_DATA_DIR || "/var/lib/fcc");
const configPath = path.join(dataDir, "config.json");
const dbPath = path.join(dataDir, "db.json");

let config, db;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (err) {
  die(`Can't read ${configPath} (${err.code || err.message}). Run this as root on the panel server${process.env.FCC_DATA_DIR ? "" : ", or set FCC_DATA_DIR"}.`);
}
try {
  db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
} catch (err) {
  die(`Can't read ${dbPath} (${err.code || err.message}).`);
}

const admins = Array.isArray(db.admins) ? db.admins : [];
if (!admins.length) die("This panel has no admins yet — open it in a browser and finish setup instead.");

const want = arg("admin");
const admin = want
  ? admins.find((a) => a.id === want || a.github?.login?.toLowerCase() === want.replace(/^@/, "").toLowerCase() || (a.email && a.email.toLowerCase() === want.toLowerCase()))
  : admins.find((a) => a.role === "owner");
if (!admin) die(want ? `No admin matches "${want}".` : "No owner found in db.json.");

const token = crypto.randomBytes(32).toString("base64url");
const record = {
  tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
  adminId: admin.id,
  createdAt: new Date().toISOString(),
  exp: Date.now() + TTL_MS,
  createdBy: os.userInfo().username,
};
const file = path.join(dataDir, "recovery.json");
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
fs.renameSync(tmp, file);
fs.chmodSync(file, 0o600);

function firstIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === "IPv4" && !ni.internal) return ni.address;
  }
  return "127.0.0.1";
}
const port = Number(process.env.FCC_PORT || svc.FCC_PORT) || Number(config.port) || 4000;
const base = String(arg("url") || config.panelUrl || process.env.FCC_PANEL_URL || svc.FCC_PANEL_URL || `${config.tls ? "https" : "http"}://${firstIPv4()}:${port}`).replace(/\/+$/, "");
const who = admin.github?.login ? `@${admin.github.login}` : admin.email || admin.id;

console.log(`
  One-time sign-in link for ${admin.name || who} (${admin.role}, ${who}).
  It works once and expires in 15 minutes:

    ${base}/auth/recover?token=${token}

  Can't reach that address? Tunnel to the panel first:
    ssh -L ${port}:127.0.0.1:${port} root@<this server>
  and open http://127.0.0.1:${port}/auth/recover?token=${token}

  Once in, fix sign-in under Settings → Security.
`);
