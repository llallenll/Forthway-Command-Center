// Server software updates (shared/software.mjs): reading dpkg / apt output and
// deciding what belongs to PHP, MySQL and cloudflared. Run: node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";

import { componentOf, parseDpkg, parseUpgradable, parseCloudflaredVersion, compareDotted, upstreamVersion, summarize } from "../shared/software.mjs";

test("packages are sorted into PHP, MySQL and cloudflared", () => {
  for (const p of ["php8.3-fpm", "php8.3-mysql", "php-common", "php8.3", "libapache2-mod-php8.3"]) assert.equal(componentOf(p), "php", p);
  for (const p of ["mysql-server", "mysql-server-core-8.0", "mysql-client-core-8.0", "mysql-common", "mariadb-server", "mariadb-server-core", "libmysqlclient21", "mysql-community-server"]) assert.equal(componentOf(p), "mysql", p);
  assert.equal(componentOf("cloudflared"), "cloudflared");
  for (const p of ["phpmyadmin-themes", "nginx", "libphp-embed", "mysqltuner", "openssl"]) assert.equal(componentOf(p), null, p);
});

test("dpkg-query output keeps only installed packages", () => {
  const m = parseDpkg("php8.3-fpm\t8.3.6-0ubuntu0.24.04.2\tii \nphp8.2-fpm\t8.2.1-1\trc \nmysql-server-core-8.0:amd64\t8.0.39-0ubuntu0.24.04.2\tii \n");
  assert.equal(m.get("php8.3-fpm"), "8.3.6-0ubuntu0.24.04.2");
  assert.equal(m.has("php8.2-fpm"), false);
  assert.equal(m.get("mysql-server-core-8.0"), "8.0.39-0ubuntu0.24.04.2");
});

test("apt list --upgradable is parsed", () => {
  const out = [
    "Listing...",
    "php8.3-fpm/noble-updates,noble-security 8.3.6-0ubuntu0.24.04.3 amd64 [upgradable from: 8.3.6-0ubuntu0.24.04.2]",
    "mysql-server-core-8.0/noble-updates 8.0.40-0ubuntu0.24.04.1 amd64 [upgradable from: 8.0.39-0ubuntu0.24.04.2]",
    "WARNING: apt does not have a stable CLI interface.",
  ].join("\n");
  assert.deepEqual(parseUpgradable(out), [
    { name: "php8.3-fpm", to: "8.3.6-0ubuntu0.24.04.3", from: "8.3.6-0ubuntu0.24.04.2" },
    { name: "mysql-server-core-8.0", to: "8.0.40-0ubuntu0.24.04.1", from: "8.0.39-0ubuntu0.24.04.2" },
  ]);
});

test("versions", () => {
  assert.equal(parseCloudflaredVersion("cloudflared version 2025.8.0 (built 2025-08-12-1200 UTC)"), "2025.8.0");
  assert.equal(parseCloudflaredVersion("nothing"), null);
  assert.equal(compareDotted("2025.10.1", "2025.8.0"), 1);
  assert.equal(compareDotted("2025.8.0", "2025.8.0"), 0);
  assert.equal(compareDotted("2024.12.2", "2025.1.0"), -1);
  assert.equal(upstreamVersion("1:10.11.6-0ubuntu0.24.04.1"), "10.11.6");
  assert.equal(upstreamVersion("8.3.6-0ubuntu0.24.04.2"), "8.3.6");
});

test("summarize picks the main package and its upgrades", () => {
  const installed = new Map([
    ["php8.3-fpm", "8.3.6-0ubuntu0.24.04.2"],
    ["php8.3-cli", "8.3.6-0ubuntu0.24.04.2"],
    ["mysql-server-core-8.0", "8.0.39-0ubuntu0.24.04.2"],
    ["mysql-server", "8.0.39-0ubuntu0.24.04.2"],
  ]);
  const up = [
    { name: "php8.3-fpm", to: "8.3.6-0ubuntu0.24.04.3", from: "8.3.6-0ubuntu0.24.04.2" },
    { name: "mysql-server-core-8.0", to: "8.0.40-0ubuntu0.24.04.1", from: "8.0.39-0ubuntu0.24.04.2" },
    { name: "php8.4-fpm", to: "8.4.1-1", from: "8.4.0-1" }, // not installed: ignored
  ];
  const php = summarize("php", installed, up);
  assert.equal(php.package, "php8.3-fpm");
  assert.equal(php.version, "8.3.6");
  assert.deepEqual(php.upgrades.map((u) => u.name), ["php8.3-fpm"]);
  const my = summarize("mysql", installed, up);
  assert.equal(my.label, "MySQL");
  assert.equal(my.package, "mysql-server-core-8.0");
  assert.equal(my.latest, "8.0.40");
  assert.equal(summarize("php", new Map(), []).installed, false);
  assert.equal(summarize("mysql", new Map([["mariadb-server-core", "1:10.11.6-1"]]), []).label, "MariaDB");
});
