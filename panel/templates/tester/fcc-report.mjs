#!/usr/bin/env node
/**
 * fcc-report — how the tester tells the panel what it is doing, as it goes.
 *
 * Installed in the fcc-tester image as /usr/local/bin/fcc-report. Each call
 * appends one JSON line to $FCC_EVENTS (/out/events.jsonl); the runner on the
 * host tails that file and forwards every line to the panel, where it shows
 * up live on the test page. Values are plain strings — no nesting.
 *
 *   fcc-report check   --id auth.login --category auth --status running --title "Login"
 *   fcc-report check   --id auth.login --category auth --status pass --title "Login" --detail "Works; wrong passwords are refused."
 *   fcc-report finding --severity high --category auth --title "…" --detail "…" --fix "…" --location "src/x.ts:12"
 *   fcc-report note    "Mapped 14 pages; starting with the checkout."
 *
 * Categories: setup payments database auth features security config
 * Check status: running pass warn fail skip
 * Severity: critical high medium low info
 */

import fs from "node:fs";

const CATEGORIES = ["setup", "payments", "database", "auth", "features", "security", "config"];
const STATUSES = ["pending", "running", "pass", "warn", "fail", "skip"];
const SEVERITIES = ["critical", "high", "medium", "low", "info"];
const FILE = process.env.FCC_EVENTS || "/out/events.jsonl";

function usage(msg) {
  if (msg) console.error(`fcc-report: ${msg}`);
  console.error(`usage:
  fcc-report check   --id <id> --category <${CATEGORIES.join("|")}> --status <${STATUSES.join("|")}> --title <text> [--detail <text>]
  fcc-report finding --severity <${SEVERITIES.join("|")}> --category <category> --title <text> --detail <text> --fix <text> [--location <file:line or URL>] [--id <id>]
  fcc-report note    <text>`);
  process.exit(2);
}

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) usage(`unexpected "${a}" (values go after a --flag)`);
    const eq = a.indexOf("=");
    if (eq > 2) out[a.slice(2, eq)] = a.slice(eq + 1);
    else {
      if (i + 1 >= argv.length) usage(`${a} needs a value`);
      out[a.slice(2)] = argv[++i];
    }
  }
  return out;
}

const clip = (s, n) => String(s ?? "").slice(0, n);
const [kind, ...rest] = process.argv.slice(2);
let ev;

if (kind === "check") {
  const f = flags(rest);
  if (!f.title && !f.id) usage("a check needs --title (and preferably --id)");
  if (f.category && !CATEGORIES.includes(f.category)) usage(`unknown category "${f.category}"`);
  if (f.status && !STATUSES.includes(f.status)) usage(`unknown status "${f.status}"`);
  ev = { t: "check", id: clip(f.id, 64), category: f.category || "features", title: clip(f.title || f.id, 160), status: f.status || "running", detail: clip(f.detail, 2000) };
} else if (kind === "finding") {
  const f = flags(rest);
  for (const k of ["severity", "category", "title", "fix"]) if (!f[k]) usage(`a finding needs --${k}`);
  if (!SEVERITIES.includes(f.severity)) usage(`unknown severity "${f.severity}"`);
  if (!CATEGORIES.includes(f.category)) usage(`unknown category "${f.category}"`);
  ev = { t: "finding", id: clip(f.id, 64), severity: f.severity, category: f.category, title: clip(f.title, 200), detail: clip(f.detail, 4000), fix: clip(f.fix, 4000), location: clip(f.location, 300) };
} else if (kind === "note") {
  const text = rest.join(" ").trim();
  if (!text) usage("a note needs some text");
  ev = { t: "note", kind: "info", text: clip(text, 300) };
} else {
  usage(kind ? `unknown kind "${kind}"` : "");
}

fs.appendFileSync(FILE, `${JSON.stringify(ev)}\n`);
console.log("reported");
