#!/usr/bin/env node
/**
 * Package a site folder into a release .zip you can upload to the Command Center.
 *
 * Optional — pulling from GitHub does the same job without a step on your Mac.
 * This is for the times you want to ship exactly what is on your disk.
 *
 * Run it from inside a site folder (or point it at one):
 *
 *   node /path/to/forthway/scripts/make-release.mjs
 *   node .../make-release.mjs --bump patch          # 0.1.0 -> 0.1.1, then zip
 *   node .../make-release.mjs --bump 1.4.0
 *   node .../make-release.mjs --prebuilt            # include a built .next (skips the server build)
 *   node .../make-release.mjs --dir ~/code/mysite --out ~/Desktop
 *
 * By default the zip contains source only — no node_modules, no .next, no .env.
 * The server installs dependencies and builds, which is the safe option because
 * native modules then match the server's OS and Node version.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { zipDirectory } from "../shared/zipwrite.mjs";
import { makeMatcher, humanBytes, readJson, writeJson, exists } from "../shared/fsx.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? true;
};
const has = (name) => args.includes(name);

const expand = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

const dir = path.resolve(expand(flag("--dir") || process.cwd()));
const outDir = path.resolve(expand(flag("--out") || dir));
const prebuilt = has("--prebuilt");
const bump = flag("--bump");

const pkgPath = path.join(dir, "package.json");
if (!exists(pkgPath)) {
  console.error(`No package.json in ${dir}. Point --dir at a site folder.`);
  process.exit(1);
}
const pkg = readJson(pkgPath);

// ---- optional version bump ------------------------------------------------
if (bump && bump !== true) {
  const cur = pkg.version || "0.0.0";
  let next;
  if (/^\d+\.\d+\.\d+/.test(bump)) {
    next = bump;
  } else {
    const [a, b, c] = cur.split(".").map((n) => parseInt(n, 10) || 0);
    next = bump === "major" ? `${a + 1}.0.0` : bump === "minor" ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
  }
  pkg.version = next;
  writeJson(pkgPath, pkg);
  console.log(`version ${cur} → ${next}`);
}

const version = pkg.version || "0.0.0";

// ---- what to leave out ----------------------------------------------------
const EXCLUDE = [
  "node_modules",
  ".git",
  ".gt",
  ".env",
  ".env.*",
  ".DS_Store",
  "*.tsbuildinfo",
  "npm-debug.log*",
  "_to_delete",
  "build-info.json",
  ...(prebuilt ? [".next/cache"] : [".next"]),
];
const skip = makeMatcher(EXCLUDE);

// ---- build the archive ----------------------------------------------------
console.log(`Packaging ${pkg.name || path.basename(dir)} v${version}${prebuilt ? " (prebuilt)" : " (source)"}…`);

if (prebuilt && !exists(path.join(dir, ".next/BUILD_ID"))) {
  console.error("--prebuilt was given but .next/BUILD_ID is missing. Run `npm run build` first.");
  process.exit(1);
}

const t0 = Date.now();
const { buffer, files } = zipDirectory(dir, { skip });

const safeName = (pkg.name || path.basename(dir)).replace(/[^\w.-]+/g, "-");
const outFile = path.join(outDir, `${safeName}-v${version}${prebuilt ? "-prebuilt" : ""}.zip`);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, buffer);

console.log(`${files.length} files · ${humanBytes(buffer.length)} · ${Math.round((Date.now() - t0) / 1000)}s`);
console.log(`\n  ${outFile}\n`);
console.log("Upload that file on the Update Hub.");
