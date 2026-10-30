// node --test scripts/ — staging copies (panel/lib/staging.mjs): naming, and the
// variables a staging copy starts with (live payment keys stripped, database
// settings re-pointed at the staging database, own URLs re-pointed).
import test from "node:test";
import assert from "node:assert/strict";

import { stagingDbName, stagingDomain, stagingEnv, linkKeys } from "../panel/lib/staging.mjs";

const STG_DB = {
  DB_HOST: "10.0.0.10",
  DB_PORT: "3306",
  DB_NAME: "acme_staging_acme_web",
  DB_USER: "acme_staging_acme_web",
  DB_PASSWORD: "stg-pass",
  DATABASE_URL: "mysql://acme_staging_acme_web:stg-pass@10.0.0.10:3306/acme_staging_acme_web",
};

test("staging database names: staging_<slug>, MySQL-safe, room for the project prefix", () => {
  assert.equal(stagingDbName("acme-web"), "staging_acme_web");
  assert.equal(stagingDbName("Acme Web!"), "staging_acme_web");
  assert.equal(stagingDbName("acme-web", 1), "staging_acme_web_2");
  assert.equal(stagingDbName(""), "staging_site");
  const long = stagingDbName("y".repeat(100), 2);
  assert.ok(/^[a-z0-9_]+$/.test(long) && long.endsWith("_3"));
  assert.ok(`${"p".repeat(16)}_${long}`.length <= 64, "fits MySQL's 64 with a 16-char project prefix");
});

test("staging domain: staging.<first domain>, www dropped, none without domains", () => {
  assert.equal(stagingDomain(["acme.com", "www.acme.com"]), "staging.acme.com");
  assert.equal(stagingDomain(["www.acme.com"]), "staging.acme.com");
  assert.equal(stagingDomain(["shop.acme.com"]), "staging.shop.acme.com");
  assert.equal(stagingDomain(["staging.acme.com"]), "stg.staging.acme.com");
  assert.equal(stagingDomain([]), "");
});

test("variables are copied; live payment keys are stripped", () => {
  const env = {
    NODE_ENV: "production",
    SESSION_SECRET: "keep-me",
    STRIPE_SECRET_KEY: "sk_live_abc123",
    STRIPE_PUBLISHABLE_KEY: "pk_live_abc123",
    STRIPE_WEBHOOK_SECRET: "whsec_abc123",
    STRIPE_LIVE_SECRET: "anything",
    MOLLIE_KEY: "live_ABCDEFGHIJKLMNOPQRSTUVWX",
    PAYPAL_MODE: "live",
    PAYPAL_CLIENT_SECRET: "pp-secret",
  };
  const r = stagingEnv({ env });
  assert.equal(r.env.NODE_ENV, "production");
  assert.equal(r.env.SESSION_SECRET, "keep-me");
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_LIVE_SECRET", "MOLLIE_KEY", "PAYPAL_CLIENT_SECRET"]) assert.ok(!(k in r.env), `${k} stripped`);
  assert.equal(r.env.PAYPAL_MODE, "sandbox");
  assert.ok(r.removed.every((x) => x.key && x.why));
  // Test keys and a test-mode webhook secret stay.
  const t = stagingEnv({ env: { STRIPE_SECRET_KEY: "sk_test_1", STRIPE_WEBHOOK_SECRET: "whsec_t" } });
  assert.deepEqual(t.env, { STRIPE_SECRET_KEY: "sk_test_1", STRIPE_WEBHOOK_SECRET: "whsec_t" });
  // The parent's own record is never changed.
  assert.equal(env.STRIPE_SECRET_KEY, "sk_live_abc123");
});

test("database settings point at the staging database; linked keys are left to the link", () => {
  const env = {
    DATABASE_URL: "mysql2://root:prod@prod.db:3306/acme_prod",
    DB_HOST: "prod.db",
    MYSQL_PASSWORD: "prod",
    MYSQL_DATABASE: "acme_prod",
    REPORTS_DB_HOST: "prod.db",
    APP_NAME: "Acme",
  };
  const r = stagingEnv({ env, linkedKeys: linkKeys(""), db: STG_DB });
  assert.ok(!("DATABASE_URL" in r.env) && !("DB_HOST" in r.env), "standard keys come from the staging database link");
  assert.equal(r.env.MYSQL_PASSWORD, "stg-pass");
  assert.equal(r.env.MYSQL_DATABASE, "acme_staging_acme_web");
  assert.equal(r.env.REPORTS_DB_HOST, "10.0.0.10");
  assert.equal(r.env.APP_NAME, "Acme");
  assert.ok(!JSON.stringify(r.env).includes("prod"), "nothing points at production");
  // A MySQL URL under another name keeps its scheme.
  const u = stagingEnv({ env: { PRISMA_URL: "mysql2://u:p@prod:3306/x" }, db: STG_DB });
  assert.equal(u.env.PRISMA_URL, "mysql2://acme_staging_acme_web:stg-pass@10.0.0.10:3306/acme_staging_acme_web");
  // Without a staging database nothing may keep pointing at production.
  const none = stagingEnv({ env: { DATABASE_URL: "mysql://r:p@prod:3306/x", DB_HOST: "prod" } });
  assert.deepEqual(none.env, {});
  // A prefixed link (second database) drops its own keys.
  assert.deepEqual(linkKeys("QUEUE_").slice(0, 2), ["QUEUE_DATABASE_URL", "QUEUE_DB_HOST"]);
});

test("URLs on the website's domains point at the staging address", () => {
  const env = { NEXT_PUBLIC_SITE_URL: "https://acme.com", CALLBACK: "https://www.acme.com/api/cb?x=1", OTHER: "https://acme.com.evil.io", CDN: "https://cdn.example.com" };
  const r = stagingEnv({ env, domains: ["acme.com", "www.acme.com"], stagingUrl: "https://staging.acme.com" });
  assert.equal(r.env.NEXT_PUBLIC_SITE_URL, "https://staging.acme.com");
  assert.equal(r.env.CALLBACK, "https://staging.acme.com/api/cb?x=1");
  assert.equal(r.env.OTHER, "https://acme.com.evil.io", "only exact domains");
  assert.equal(r.env.CDN, "https://cdn.example.com");
  assert.deepEqual(r.repointed.sort(), ["CALLBACK", "NEXT_PUBLIC_SITE_URL"]);
});
