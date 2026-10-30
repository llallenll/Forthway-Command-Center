/**
 * STAGING — one click from a website's page, a second, persistent copy of the
 * website that runs next to production (the website header's type icon → Staging build).
 *
 * A staging copy is an ordinary website record with `stagingOf: <parentId>`
 * (the parent gets `stagingSiteId`), so everything a website has — deploys,
 * Docker runtime, status, logs, variables, domains, SSL, Cloudflare delivery,
 * the job queue's heavy-job metadata — is the existing machinery in
 * panel/lib/sites.mjs. What this module adds:
 *
 *   POST   /api/sites/:id/staging  { domain?, serverId?, deploy?: true, releaseId? }
 *          → { site, staging, databases, job, warnings }
 *          Creates the copy: its own port and appDir (sites.mjs defaults),
 *          domain staging.<first domain> (editable; "" = none), not load
 *          balanced (it runs on the parent's first server unless `serverId`),
 *          runtime docker for node (php stays legacy, static none), the
 *          parent's build settings / container limits / Cloudflare delivery.
 *          When the parent uses a database (linked, or MySQL settings in its
 *          own variables): one MySQL database per parent database —
 *          `<project prefix>_staging_<slug>` (then `_2`, `_3`…) with its own
 *          user — created (or an unlinked one of that name reused), tagged
 *          `stagingOf`, and linked to the copy with the parent's variable
 *          prefixes (site.linkPrefixes). The parent's own variables are copied
 *          once (stagingEnv below): live payment keys stripped, database
 *          settings re-pointed at the staging database, URLs on the parent's
 *          domains re-pointed at the staging URL. From then on the staging
 *          variables are the copy's own (GET/PUT /api/sites/<copy>/env).
 *          Then the parent's current release (or `releaseId`) is deployed to
 *          the copy with the normal deploy job (ctx.sites.deploy — heavy, so it
 *          waits in the job queue like any deploy).
 *   DELETE /api/sites/:id/staging?dropDatabase=1&deleteFiles=1  → job
 *          Removes the copy (ctx.sites.remove) and, with dropDatabase=1, the
 *          databases this module made for it (tagged stagingOf; anything else
 *          linked by hand is kept).
 *
 * Everything else uses the copy's own website routes: deploy a release
 * (releases belong to the parent; sites.mjs lets a copy deploy its parent's),
 * stop / start / restart, env, PATCH domains, SSL.
 *
 * A parent with a staging copy cannot be deleted (409) until staging is
 * removed — deleting it silently would also have to decide about the staging
 * database, which deserves its own confirmation.
 *
 * The pure parts (naming, variable copying) are exported for
 * scripts/staging.test.mjs.
 */

import { httpError } from "./http.mjs";
import { isLivePaymentValue, planDatabases, DB_URL_RE, DB_KEY_RE, PAY_ENV_KEY_RE, SECRETISH_RE, STANDARD_DB_KEYS } from "../../shared/testenv.mjs";

// ------------------------------------------------------------- pure parts

/** The staging database's name before the project prefix: staging_<slug>, staging_<slug>_2… (MySQL-safe, ≤ 46 chars). */
export function stagingDbName(slug, index = 0) {
  const s =
    String(slug || "")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || "site";
  const tail = index > 0 ? `_${index + 1}` : "";
  // 64 (MySQL) − 16 (project prefix) − 1 ("_") − "staging_" → 39 for slug + tail.
  return `staging_${s.slice(0, 39 - tail.length).replace(/_+$/, "")}${tail}`;
}

/** Default staging domain: staging.<first domain> ("www." dropped), or "" when the parent has none. */
export function stagingDomain(domains = []) {
  const first = String((domains || [])[0] || "").trim().toLowerCase();
  if (!first) return "";
  const bare = first.replace(/^\*\./, "").replace(/^www\./, "");
  return bare.startsWith("staging.") ? `stg.${bare}` : `staging.${bare}`;
}

/**
 * The staging copy's variables, made once from the parent's own variables.
 *
 *   env         the parent's own variables (site.env — not linked database vars)
 *   linkedKeys  keys the staging database link provides (they are dropped from the copy)
 *   db          the staging database's { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DATABASE_URL }
 *               — other MySQL settings in the parent's variables are re-pointed at it
 *   domains     the parent's domains; URLs on them → stagingUrl
 *
 * Returns { env, removed: [{ key, why }], repointed: [key] }.
 */
export function stagingEnv({ env = {}, linkedKeys = [], db = null, domains = [], stagingUrl = "" } = {}) {
  const out = { ...env };
  const removed = [];
  const repointed = new Set();
  const linked = new Set(linkedKeys);
  const drop = (k, why) => {
    if (!(k in out)) return;
    delete out[k];
    removed.push({ key: k, why });
  };
  const set = (k, v) => {
    if (out[k] === String(v)) return;
    out[k] = String(v);
    repointed.add(k);
  };

  let liveStripe = false;
  for (const k of Object.keys(out)) {
    const v = String(out[k] ?? "");
    // 1. Database settings: the link provides these keys; others point at the staging database.
    if (linked.has(k)) {
      drop(k, "comes from the staging database link");
      continue;
    }
    if (DB_URL_RE.test(v)) {
      if (db?.DATABASE_URL) set(k, db.DATABASE_URL.replace(/^[a-z0-9+]+:/i, `${DB_URL_RE.exec(v)[1]}${DB_URL_RE.exec(v)[2] || ""}:`));
      else drop(k, "it points at the production database");
      continue;
    }
    const m = DB_KEY_RE.exec(k);
    if (m) {
      const part = m[2];
      if (!db) drop(k, "it points at the production database");
      else if (["HOST", "HOSTNAME", "SERVER"].includes(part)) set(k, db.DB_HOST);
      else if (part === "PORT") set(k, db.DB_PORT);
      else if (["NAME", "DATABASE", "DB"].includes(part)) set(k, db.DB_NAME);
      else if (["USER", "USERNAME"].includes(part)) set(k, db.DB_USER);
      else set(k, db.DB_PASSWORD);
      continue;
    }
    // 2. Payments: never live money from staging.
    if (isLivePaymentValue(v)) {
      if (/^(sk|pk|rk)_live_/.test(v.trim())) liveStripe = true;
      drop(k, "live payment key");
      continue;
    }
    if (/LIVE/.test(k) && SECRETISH_RE.test(k) && /(STRIPE|PAY|SQUARE|BRAINTREE|ADYEN|MOLLIE|PADDLE|CHECKOUT|KLARNA|RAZORPAY)/.test(k)) {
      drop(k, "live payment credential");
      continue;
    }
    const pm = PAY_ENV_KEY_RE.exec(k);
    if (pm && /^(live|production|prod)$/i.test(v.trim())) {
      set(k, pm[1] === "ADYEN" ? "TEST" : "sandbox");
      for (const other of Object.keys(out)) if (other !== k && other.startsWith(`${pm[1]}_`) && SECRETISH_RE.test(other)) drop(other, `${pm[1]} was in live mode`);
    }
  }
  if (liveStripe) for (const k of Object.keys(out)) if (/^whsec_/.test(String(out[k]).trim())) drop(k, "webhook secret of the live payment account");

  // 3. The parent's own address → the staging address.
  const doms = (domains || []).map((d) => String(d).toLowerCase().replace(/^www\./, "")).filter(Boolean);
  if (stagingUrl && doms.length) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`https?://(?:www\\.)?(?:${[...new Set(doms)].map(esc).join("|")})(?::\\d+)?(?=[/?#"'\\s]|$)`, "gi");
    for (const k of Object.keys(out)) {
      const v = String(out[k]);
      const nv = v.replace(re, stagingUrl.replace(/\/+$/, ""));
      if (nv !== v) set(k, nv);
    }
  }
  return { env: out, removed, repointed: [...repointed] };
}

/** Keys a link with `prefix` provides (ctx.mysql.envFor). */
export const linkKeys = (prefix = "") => STANDARD_DB_KEYS.map((k) => `${prefix}${k}`);

// ------------------------------------------------------------- module

export function register(router, ctx) {
  const db = ctx.db;
  const getSite = (id) => (id ? db.get("sites", id) : null);
  const sites = () => {
    if (!ctx.sites?.create || !ctx.sites?.remove) throw httpError(503, "The websites module is not available.");
    return ctx.sites;
  };
  function mustSite(id) {
    const s = getSite(id);
    if (!s || s.deleting) throw httpError(404, "Website not found.");
    return s;
  }
  /** :id may be the website or its staging copy. */
  function parentOf(id) {
    const s = mustSite(id);
    return s.stagingOf ? mustSite(s.stagingOf) : s;
  }
  const broadcast = (site) => {
    try {
      if (site) ctx.events?.broadcast?.("site", ctx.sites.publicSite(getSite(site.id) || site));
    } catch {
      /* ignore */
    }
  };
  const audit = (admin, action, site, details) => {
    try {
      ctx.activity?.(admin, action, { type: "site", id: site.id, name: site.name }, details);
    } catch {
      /* ignore */
    }
  };
  const isLinkedElsewhere = (dbId, exceptSiteId) => db.list("sites").some((s) => s.id !== exceptSiteId && (s.linkedDatabaseIds || []).includes(dbId));

  // ---- start

  router.post("/api/sites/:id/staging", async (req, res, { params, body, admin }) => {
    const S = sites();
    const parent = mustSite(params.id);
    const b = body || {};
    if (parent.stagingOf) throw httpError(409, "This is already a staging copy.");
    const existing = getSite(parent.stagingSiteId);
    if (existing) throw httpError(409, `${parent.name} already has a staging copy (${existing.name}).`, { stagingSiteId: existing.id });
    if (parent.stagingSiteId) db.update("sites", parent.id, { stagingSiteId: null }); // a stale pointer

    const warnings = [];
    const serverId = b.serverId ? String(b.serverId) : S.targets(parent)[0] || "main";
    const domain = "domain" in b ? String(b.domain || "").trim().toLowerCase() : stagingDomain(parent.domains);
    const tls = !!(parent.ssl?.enabled || parent.cloudflare?.enabled);
    const stagingUrl = domain ? `${tls ? "https" : "http"}://${domain}` : "";

    // 1. Databases: one staging database per database the parent uses.
    const sources = parent.type === "static" ? [] : (await S.linkedEnvSources(parent, serverId)) || [];
    const ownDb = parent.type !== "static" && !sources.length && planDatabases(parent.env || {}, []).length > 0;
    const wanted = sources.length
      ? sources.map((l, i) => ({ prefix: l.prefix || "", from: l.databaseId, fromName: l.name, name: stagingDbName(parent.slug || parent.name, i) }))
      : ownDb
        ? [{ prefix: "", from: null, fromName: "its own variables", name: stagingDbName(parent.slug || parent.name, 0) }]
        : [];
    if (wanted.length && (!ctx.mysql?.createDatabase || !ctx.mysql?.envFor)) throw httpError(503, "The database module is not available, so the staging database can't be made.");
    const made = []; // { id, name, created, prefix }
    const undo = async () => {
      for (const m of made.filter((x) => x.created).reverse()) await ctx.mysql.dropDatabase(m.id, admin).catch(() => {});
    };
    try {
      for (const w of wanted) {
        const prefix = ctx.mysql.projectPrefix ? ctx.mysql.projectPrefix(parent.projectId) : "";
        const full = prefix && !w.name.startsWith(`${prefix}_`) ? `${prefix}_${w.name}` : w.name;
        const found = db.list("databases", (d) => d.name === full)[0];
        if (found) {
          if (found.projectId && found.projectId !== parent.projectId) throw httpError(409, `A database called ${full} already exists in another project.`);
          if (isLinkedElsewhere(found.id, null)) throw httpError(409, `A database called ${full} already exists and is used by another website. Remove that link or rename the database first.`);
          made.push({ id: found.id, name: found.name, created: false, prefix: w.prefix, from: w.fromName });
          warnings.push(`Reused the existing database ${found.name} (it was not linked to any website).`);
          continue;
        }
        const src = w.from ? db.get("databases", w.from) : null;
        const r = await ctx.mysql.createDatabase({ projectId: parent.projectId, name: w.name, remoteAccess: !!src?.remoteAccess || serverId !== (ctx.cluster?.MAIN_ID || "main") }, admin);
        made.push({ id: r.database.id, name: r.database.name, created: true, prefix: w.prefix, from: w.fromName });
      }
      for (const m of made) db.update("databases", m.id, { stagingOf: parent.id });
    } catch (err) {
      await undo();
      throw err.status ? err : httpError(500, `Creating the staging database failed: ${err.message}`);
    }

    // 2. Variables: the parent's own, copied once.
    const primary = made.find((m) => !m.prefix) || made[0] || null;
    let dbVars = null;
    try {
      dbVars = primary ? ctx.mysql.envFor(primary.id, { serverId }) : null;
    } catch {
      dbVars = null;
    }
    const copy = stagingEnv({ env: parent.env || {}, linkedKeys: made.flatMap((m) => linkKeys(m.prefix)), db: dbVars, domains: parent.domains || [], stagingUrl });

    // 3. The website record (sites.mjs does ports, appDir, runtime, validation).
    const cf = parent.cloudflare?.enabled && domain && (parent.cloudflare.hostnames || []).includes(parent.domains?.[0])
      ? { enabled: true, tunnelId: parent.cloudflare.tunnelId, hostnames: [domain], ...(parent.cloudflare.tunnels?.[parent.domains[0]] ? { tunnels: { [domain]: parent.cloudflare.tunnels[parent.domains[0]] } } : {}) }
      : null;
    const childBody = {
      name: `${parent.name} staging`.slice(0, 60),
      type: parent.type,
      domains: domain ? [domain] : [],
      loadBalanced: false,
      serverIds: [serverId],
      settings: parent.settings || undefined,
      healthPath: parent.healthPath ?? undefined,
      env: copy.env,
      linkedDatabaseIds: made.map((m) => m.id),
      ...(parent.type === "node" && parent.container ? { container: { image: parent.container.image, memoryMb: parent.container.memoryMb, cpus: parent.container.cpus } } : {}),
      ...(cf ? { cloudflare: cf } : {}),
    };
    const extra = { stagingOf: parent.id, linkPrefixes: Object.fromEntries(made.map((m) => [m.id, m.prefix])) };
    let child;
    try {
      try {
        child = await S.create(parent.projectId, childBody, { admin, extra });
      } catch (err) {
        if (!cf) throw err;
        warnings.push(`Cloudflare Tunnel delivery could not be set up for ${domain} (${err.message}) — it is delivered Direct; change it on the staging site's Domains & SSL.`);
        child = await S.create(parent.projectId, { ...childBody, cloudflare: undefined }, { admin, extra });
      }
    } catch (err) {
      await undo();
      throw err;
    }
    db.update("sites", parent.id, { stagingSiteId: child.id });
    broadcast(parent);
    for (const r of copy.removed) warnings.push(`${r.key} was not copied: ${r.why}.`);
    if (parent.loadBalanced) warnings.push(`${parent.name} is load balanced; staging runs on one server (${child.serverIds?.[0] || serverId}).`);
    if (parent.ssl?.enabled && !cf && domain) warnings.push(`Point ${domain} at the server, then issue its HTTPS certificate on the staging site's Domains & SSL.`);

    // 4. Deploy the parent's release to it (normal deploy job — heavy, queued like any deploy).
    let job = null;
    const releaseId = b.releaseId || parent.currentReleaseId || null;
    if (b.deploy !== false && releaseId) {
      try {
        job = S.deploy(child.id, releaseId, { admin, base: S.panelBase(req) });
      } catch (err) {
        warnings.push(`Staging was created but its first deploy didn't start: ${err.message}`);
      }
    } else if (b.deploy !== false) {
      warnings.push(`${parent.name} has no release deployed yet — deploy one to staging from the Deployments tab.`);
    }
    audit(admin, "site.staging.start", parent, { stagingSiteId: child.id, domain: domain || null, databases: made.map((m) => m.name), releaseId: job ? releaseId : null });
    return {
      site: S.publicSite(getSite(parent.id)),
      staging: S.publicSite(getSite(child.id)),
      databases: made.map((m) => ({ id: m.id, name: m.name, created: m.created, prefix: m.prefix, from: m.from })),
      job,
      warnings,
    };
  });

  // ---- remove

  router.delete("/api/sites/:id/staging", async (req, res, { params, query, admin }) => {
    const S = sites();
    const parent = parentOf(params.id);
    const child = getSite(parent.stagingSiteId);
    if (!child) {
      if (parent.stagingSiteId) db.update("sites", parent.id, { stagingSiteId: null });
      throw httpError(404, `${parent.name} has no staging copy.`);
    }
    if (child.deleting) throw httpError(409, "Staging is already being removed.");
    const deleteFiles = query.deleteFiles !== "0";
    const dropIds = query.dropDatabase === "1" ? (child.linkedDatabaseIds || []).filter((id) => db.get("databases", id)?.stagingOf === parent.id && !isLinkedElsewhere(id, child.id)) : [];
    const removal = S.remove(child.id, { admin, deleteFiles }); // 409 when the copy is busy
    audit(admin, "site.staging.remove", parent, { stagingSiteId: child.id, deleteFiles, dropDatabases: dropIds.map((id) => db.get("databases", id)?.name || id) });
    if (!dropIds.length || !ctx.jobs?.start) return removal;
    // Then drop its databases, once the copy is gone (nothing connects to them any more).
    return ctx.jobs.start(
      // Listed with the website, but it doesn't touch it: not behind the website's own jobs (a running test, a deploy).
      { type: "site.staging.remove", title: `Remove staging of ${parent.name}`, projectId: parent.projectId, siteId: parent.id, adminId: admin?.id || null, lock: `staging:${parent.id}` },
      async ({ log }) => {
        log(`Removing ${child.name} — job ${removal.id}…`);
        const done = ctx.jobs.wait ? await ctx.jobs.wait(removal.id) : null;
        if (done && done.status !== "succeeded") throw new Error(`Removing the staging site failed (${done.error || done.status}), so its database${dropIds.length === 1 ? " was" : "s were"} kept.`);
        log(`✓ ${child.name} removed.`);
        const dropped = [];
        for (const id of dropIds) {
          const rec = db.get("databases", id);
          if (!rec) continue;
          if (isLinkedElsewhere(id, null)) {
            log(`!! ${rec.name} is linked to another website now — kept.`);
            continue;
          }
          log(`Dropping the staging database ${rec.name} and its user ${rec.user}…`);
          await ctx.mysql.dropDatabase(id, admin);
          ctx.sites?.unlinkDatabase?.(id);
          dropped.push(rec.name);
          log(`✓ ${rec.name} dropped.`);
        }
        return { removed: child.id, dropped };
      },
    );
  });
}
