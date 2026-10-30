// node --test scripts/ — the pure parts of the Docker website runtime
// (docs/DOCKER-AND-TESTS.md section 1): docker argument builders, per-site uid
// allocation, and the deploy-engine settings for docker vs legacy sites.
import test from "node:test";
import assert from "node:assert/strict";

import * as docker from "../shared/docker.mjs";
import { engineSettings, runtimeOf } from "../shared/tasks.mjs";
import { Deployer, withDefaults, RESTART_MODES } from "../shared/deployer.mjs";

const APP = "/srv/fcc/sites/acme/web";

/** The value that follows `flag` in an argument list (first occurrence). */
const after = (args, flag) => args[args.indexOf(flag) + 1];
const all = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

// ------------------------------------------------------------ arg builders

test("buildArgs: non-root, hardened, same-path mount, command as one sh -c argument", () => {
  const b = docker.buildArgs({
    image: "node:24-bookworm",
    command: "npm install --include=dev",
    env: { DATABASE_URL: "mysql://u:secret@127.0.0.1/db", NPM_CONFIG_INCLUDE: "dev" },
    uid: 20001,
    mounts: [{ src: APP }],
    workdir: `${APP}/.forthway/staging`,
    network: "host",
  });
  const a = b.args;
  assert.deepEqual(a.slice(0, 2), ["run", "--rm"]);
  assert.equal(after(a, "--user"), "20001:20001");
  assert.equal(after(a, "--cap-drop"), "ALL");
  assert.equal(after(a, "--security-opt"), "no-new-privileges");
  assert.ok(a.includes("--init"));
  assert.equal(after(a, "--network"), "host");
  assert.equal(after(a, "--mount"), `type=bind,src=${APP},dst=${APP}`);
  assert.equal(after(a, "-w"), `${APP}/.forthway/staging`);
  // The image, then sh -c and the whole command as ONE argument, at the very end.
  assert.deepEqual(a.slice(-4), ["node:24-bookworm", "sh", "-c", "npm install --include=dev"]);
  // Variable names on the command line, values only in the CLI's environment.
  assert.deepEqual(all(a, "-e").sort(), ["DATABASE_URL", "HOME", "NPM_CONFIG_INCLUDE"]);
  assert.ok(!a.some((x) => String(x).includes("secret")), "a secret value leaked onto the command line");
  assert.equal(b.env.DATABASE_URL, "mysql://u:secret@127.0.0.1/db");
  assert.equal(b.env.HOME, "/tmp");
  assert.ok(!("NODE_ENV" in b.env), "builds must not get NODE_ENV=production (npm would drop devDependencies)");
});

test("appArgs: detached website container with restart policy, limits and a read-only root", () => {
  const b = docker.appArgs({
    name: "fcc-site_abc",
    command: "npm start",
    env: { PORT: "3001" },
    uid: 20002,
    gid: 20002,
    mounts: [{ src: APP }],
    workdir: APP,
    network: "host",
    memoryMb: 512,
    cpus: 1.5,
    readOnly: true,
  });
  const a = b.args;
  assert.deepEqual(a.slice(0, 4), ["run", "-d", "--name", "fcc-site_abc"]);
  assert.equal(after(a, "--restart"), "unless-stopped");
  assert.equal(after(a, "--memory"), "512m");
  assert.equal(after(a, "--memory-swap"), "512m");
  assert.equal(after(a, "--cpus"), "1.5");
  assert.ok(a.includes("--read-only"));
  assert.match(after(a, "--tmpfs"), /^\/tmp:rw,nosuid,nodev,size=\d+m$/);
  assert.ok(!a.includes("-p") && !a.includes("--publish"), "ports must not be published (that bypasses ufw)");
  assert.equal(b.env.NODE_ENV, "production");
  assert.equal(b.env.PORT, "3001");
  // The site's own NODE_ENV wins.
  assert.equal(docker.appArgs({ name: "fcc-x", command: "npm start", env: { NODE_ENV: "staging" }, uid: 20000 }).env.NODE_ENV, "staging");
});

test("builders refuse root, bad mounts, bad names and empty commands", () => {
  assert.throws(() => docker.buildArgs({ command: "true", uid: 0 }), /non-root/);
  assert.throws(() => docker.buildArgs({ command: "true", uid: 999 }), /non-root/);
  assert.throws(() => docker.buildArgs({ command: "true", uid: 20000, gid: 0 }), /non-root/);
  assert.throws(() => docker.buildArgs({ command: "true", uid: 20000, mounts: [{ src: "/" }] }), /Refusing/);
  assert.throws(() => docker.buildArgs({ command: "true", uid: 20000, mounts: [{ src: "/srv" }] }), /Refusing/);
  assert.throws(() => docker.buildArgs({ command: "true", uid: 20000, mounts: [{ src: "relative/dir" }] }), /Refusing/);
  assert.throws(() => docker.buildArgs({ command: "true", uid: 20000, mounts: [{ src: "/srv/a:/etc" }] }), /Refusing/);
  assert.throws(() => docker.buildArgs({ command: "  ", uid: 20000 }), /No command/);
  assert.throws(() => docker.appArgs({ name: "bad name", command: "npm start", uid: 20000 }), /not a valid container name/);
  assert.throws(() => docker.containerName("../x"), /container name/);
  assert.equal(docker.containerName("site_abc-1"), "fcc-site_abc-1");
});

test("envFlags drops names a shell or the docker CLI would misread", () => {
  const e = docker.envFlags({ GOOD_1: "a", "BAD-NAME": "b", "1BAD": "c", DOCKER_HOST: "tcp://evil:2375", docker_config: "/x", SKIP: null });
  assert.deepEqual(e.args, ["-e", "GOOD_1"]);
  assert.deepEqual(e.env, { GOOD_1: "a" });
  assert.deepEqual(e.dropped.sort(), ["1BAD", "BAD-NAME", "DOCKER_HOST", "docker_config"].sort());
});

test("cliEnv keeps the host environment for the CLI and adds the container values", () => {
  const env = docker.cliEnv({ SECRET: "s" }, { PATH: "/usr/bin", HOME: "/root" });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/root", SECRET: "s" });
});

test("validImage and containerSettings", () => {
  for (const ok of ["node:24-bookworm", "node", "library/node:22", "ghcr.io/acme/app:1.2.3", "node@sha256:" + "a".repeat(64)]) assert.ok(docker.validImage(ok), ok);
  for (const bad of ["", " node", "--privileged", "node:24 bookworm", "node;rm -rf /", "../x", "Node:24"]) assert.ok(!docker.validImage(bad), bad);
  assert.deepEqual(docker.containerSettings({ uid: 20005 }), { uid: 20005, gid: 20005, image: docker.DEFAULT_NODE_IMAGE, memoryMb: 1024, cpus: 0 });
  assert.equal(docker.containerSettings({ uid: 20005, image: "--privileged" }).image, docker.DEFAULT_NODE_IMAGE);
  assert.equal(docker.containerSettings({ uid: 20005, memoryMb: 0 }).memoryMb, 0);
  assert.equal(docker.containerSettings({}).uid, null);
});

// ------------------------------------------------------------ uid allocation

test("nextUid: the smallest free uid from UID_BASE, unique across sites", () => {
  assert.equal(docker.UID_BASE, 20000);
  assert.equal(docker.nextUid([]), 20000);
  assert.equal(docker.nextUid([20000, 20001]), 20002);
  assert.equal(docker.nextUid([20001, 20000, 20003]), 20002, "fills a gap left by a deleted site");
  assert.equal(docker.nextUid([undefined, null, "x", 1000, "20000"]), 20001, "ignores junk; numeric strings count");
  // Allocating one after another never repeats.
  const used = [];
  for (let i = 0; i < 50; i++) used.push(docker.nextUid(used));
  assert.equal(new Set(used).size, 50);
  assert.ok(used.every((u) => u >= 20000));
});

// ------------------------------------------------------------ engine settings

const spec = (extra = {}) => ({
  siteId: "site_abc",
  name: "Acme",
  type: "node",
  appDir: APP,
  port: 3001,
  pm2Name: "fcc-site_abc",
  healthPath: "/api/health",
  settings: { restart: { mode: "pm2", service: "fcc-site_abc", start: "npm start", pm2Start: "npm start", env: {} }, build: { install: "npm install" } },
  env: { DATABASE_URL: "mysql://x" },
  ...extra,
});

test("runtimeOf: docker only for node sites that say so; static is none", () => {
  assert.equal(runtimeOf(spec({ runtime: "docker" })), "docker");
  assert.equal(runtimeOf(spec()), "legacy");
  assert.equal(runtimeOf(spec({ runtime: "legacy" })), "legacy");
  assert.equal(runtimeOf(spec({ type: "php", runtime: "docker" })), "legacy");
  assert.equal(runtimeOf(spec({ type: "static", runtime: "docker" })), "none");
});

test("engineSettings: a docker node site runs in its container as its own uid", () => {
  const s = engineSettings(spec({ runtime: "docker", container: { uid: 20007, gid: 20007, image: "node:22-bookworm", memoryMb: 768, cpus: 2 } }));
  assert.equal(s.restart.mode, "docker");
  assert.equal(s.restart.service, "fcc-site_abc");
  assert.equal(s.restart.start, "npm start");
  assert.deepEqual(s.restart.env, { DATABASE_URL: "mysql://x" });
  assert.deepEqual(s.docker, { image: "node:22-bookworm", uid: 20007, gid: 20007, memoryMb: 768, cpus: 2, legacyPm2: "fcc-site_abc" });
  assert.equal(s.leftoverContainer, "");
  assert.equal(s.healthUrl, "http://127.0.0.1:3001/api/health");
  assert.ok(RESTART_MODES.includes("docker"));
});

test("engineSettings: a legacy node site stays on pm2 and cleans up a leftover container", () => {
  for (const extra of [{}, { runtime: "legacy" }, { runtime: "legacy", container: { uid: 20007 } }]) {
    const s = engineSettings(spec(extra));
    assert.equal(s.restart.mode, "pm2");
    assert.equal(s.restart.service, "fcc-site_abc");
    assert.equal(s.leftoverContainer, "fcc-site_abc");
    assert.equal(s.docker, undefined);
  }
  // A stale "docker" restart mode in the settings never leaks into a legacy site.
  const s = engineSettings(spec({ settings: { restart: { mode: "docker" } } }));
  assert.equal(s.restart.mode, "pm2");
});

test("engineSettings: static and php sites are unchanged by the runtime", () => {
  const st = engineSettings(spec({ type: "static", runtime: "docker" }));
  assert.equal(st.restart.mode, "command");
  const php = engineSettings(spec({ type: "php", runtime: "docker" }));
  assert.equal(php.restart.mode, "command");
  assert.equal(php.writeEnvFile, true);
});

test("Deployer: docker settings merge with defaults; no container user means no run", () => {
  const S = withDefaults({ appDir: "", restart: { mode: "docker", service: "fcc-x" }, docker: { uid: 20010 } });
  assert.equal(S.docker.uid, 20010);
  assert.equal(S.docker.image, docker.DEFAULT_NODE_IMAGE);
  assert.equal(S.docker.memoryMb, docker.DEFAULT_LIMITS.memoryMb);

  const d = new Deployer({ settings: { appDir: "", restart: { mode: "docker", service: "fcc-x" }, docker: { uid: null } } });
  assert.throws(() => d._dockerUser(), /no container user/);
  const ok = new Deployer({ settings: { appDir: "", restart: { mode: "docker", service: "fcc-x" }, docker: { uid: 20010, image: "node:22-bookworm" } } });
  assert.deepEqual(ok._dockerUser(), { uid: 20010, gid: 20010 });
  // node_modules installed for one runtime are never reused by another.
  assert.match(ok.runtimeTag(), /^docker node:22-bookworm /);
  const host = new Deployer({ settings: { appDir: "", restart: { mode: "pm2", service: "fcc-x" } } });
  assert.match(host.runtimeTag(), /^host node v\d+ /);
  assert.notEqual(ok.runtimeTag(), host.runtimeTag());
});
