// The deploy engine runs as root over folders a containerised app can write
// to: a symlink the app plants must never turn a copy into a write (or read)
// outside the app folder. Run: node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { mirror, copyDir, insideRoot } from "../shared/fsx.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fcc-fsx-"));
}

test("mirror refuses to write through a symlinked folder in the app", () => {
  const root = tmp();
  const outside = path.join(root, "outside");
  const app = path.join(root, "app");
  const src = path.join(root, "src");
  fs.mkdirSync(outside);
  fs.mkdirSync(app);
  fs.mkdirSync(path.join(src, "public"), { recursive: true });
  fs.writeFileSync(path.join(src, "public", "x.txt"), "new");
  fs.symlinkSync(outside, path.join(app, "public")); // planted by the app
  assert.throws(() => mirror(src, app), /outside/);
  assert.equal(fs.existsSync(path.join(outside, "x.txt")), false);
});

test("a symlink at the destination is replaced, not written through", () => {
  const root = tmp();
  const secret = path.join(root, "secret");
  const app = path.join(root, "app");
  const src = path.join(root, "src");
  fs.writeFileSync(secret, "keep");
  fs.mkdirSync(app);
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "a.txt"), "release");
  fs.symlinkSync(secret, path.join(app, "a.txt"));
  mirror(src, app);
  assert.equal(fs.readFileSync(secret, "utf8"), "keep");
  assert.equal(fs.lstatSync(path.join(app, "a.txt")).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(app, "a.txt"), "utf8"), "release");
});

test("copying a symlink copies the link, never the file behind it", () => {
  const root = tmp();
  const secret = path.join(root, "secret");
  const app = path.join(root, "app");
  const backup = path.join(root, "backup");
  fs.writeFileSync(secret, "do not copy");
  fs.mkdirSync(app);
  fs.symlinkSync(secret, path.join(app, "leak"));
  copyDir(app, backup);
  assert.equal(fs.lstatSync(path.join(backup, "leak")).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(path.join(backup, "leak")), secret);
});

test("insideRoot resolves links and paths that do not exist yet", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "app"));
  fs.symlinkSync(os.tmpdir(), path.join(root, "app", "out"));
  assert.equal(insideRoot(path.join(root, "app"), path.join(root, "app", "new", "deep")), true);
  assert.equal(insideRoot(path.join(root, "app"), path.join(root, "app", "out", "x")), false);
});
