/**
 * CORE routes: first-run setup, sign-in, the signed-in admin, other admins,
 * projects, panel settings, the dashboard summary, jobs, the audit log and
 * the live event stream.
 *
 * Also provides `ctx.activity(admin, action, target, details?)` — the audit
 * log every module writes to. server.mjs installs it on ctx before any module
 * registers (see createActivity), so it is safe to call from any handler.
 */

import os from "node:os";
import { httpError } from "./http.mjs";
import {
  hashPassword,
  verifyPassword,
  validatePassword,
  normalizeEmail,
  validEmail,
  publicAdmin,
  requestIp,
} from "./auth.mjs";

const ACTIVITY_KEPT = 5000;
const DASHBOARD_PROBE_MS = 3000;

// ----------------------------------------------------------------- helpers

function clean(value, max = 200) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

function slugify(s) {
  return (
    String(s || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project"
  );
}

/** Public sign-in/setup POSTs have no session, so refuse cross-site ones here. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host = null;
  try {
    host = new URL(origin).host;
  } catch {
    /* "null" or garbage */
  }
  if (host !== req.headers.host) throw httpError(403, "Cross-origin request refused.");
}

/** Run a probe into another module; any error, absence or slowness → null. */
async function probe(fn, ms = DASHBOARD_PROBE_MS) {
  try {
    let timer;
    const result = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
    clearTimeout(timer);
    return result ?? null;
  } catch {
    return null;
  }
}

function tokenHint(token) {
  if (!token) return null;
  const t = String(token);
  return t.length <= 8 ? "••••" : `${t.slice(0, 4)}…${t.slice(-4)}`;
}

function byNewest(a, b) {
  const x = a.at || a.createdAt || "";
  const y = b.at || b.createdAt || "";
  return x < y ? 1 : x > y ? -1 : 0;
}

// ---------------------------------------------------------------- activity

/**
 * Build ctx.activity(). `admin` is an admin object (public or full), an admin
 * id, or null for the system. `target` is { type, id, name } — add
 * `projectId` to it (or to `details`) when the target is not a project, site
 * or database and should still show up on a project's Activity tab.
 */
export function createActivity(ctx) {
  return function activity(admin, action, target = null, details = null) {
    const { db } = ctx;
    const a = typeof admin === "string" ? db.get("admins", admin) : admin;
    const t = target ? { type: target.type || null, id: target.id || null, name: target.name || null } : null;

    let projectId = target?.projectId || details?.projectId || null;
    if (!projectId && t?.id) {
      if (t.type === "project") projectId = t.id;
      else if (t.type === "site") projectId = db.get("sites", t.id)?.projectId || null;
      else if (t.type === "database") projectId = db.get("databases", t.id)?.projectId || null;
      else if (t.type === "backup") projectId = db.get("backups", t.id)?.projectId || null;
    }

    const entry = {
      at: new Date().toISOString(),
      adminId: a?.id || null,
      adminName: a ? a.name || a.email : "System",
      action: String(action),
      target: t,
      projectId,
      details: details ?? null,
    };
    try {
      db.insert("activity", entry);
      const all = db.list("activity");
      if (all.length > ACTIVITY_KEPT + 200) {
        const drop = new Set(all.slice(0, all.length - ACTIVITY_KEPT).map((e) => e.id));
        db.removeWhere("activity", (e) => drop.has(e.id));
      }
      ctx.events?.broadcast("activity", entry);
    } catch (err) {
      console.error("[fcc] could not record activity:", err.message);
    }
    return entry;
  };
}

// ---------------------------------------------------------------- register

export function register(router, ctx) {
  const { db } = ctx;
  if (!ctx.activity) ctx.activity = createActivity(ctx);
  const auth = ctx.auth;

  const needsSetup = () => db.list("admins").length === 0;

  const projectCounts = (projectId) => {
    const sites = db.list("sites", { projectId });
    return {
      sites: sites.length,
      sitesLoadBalanced: sites.filter((s) => s.loadBalanced).length,
      databases: db.list("databases", { projectId }).length,
      backups: db.list("backups", { projectId }).length,
    };
  };
  const publicProject = (p) => ({ ...p, counts: projectCounts(p.id) });

  const getProject = (id) => {
    const p = db.get("projects", id);
    if (!p) throw httpError(404, "Project not found.");
    return p;
  };

  const getAdmin = (id) => {
    const a = db.get("admins", id);
    if (!a) throw httpError(404, "Admin not found.");
    return a;
  };

  const emailTaken = (email, exceptId) => db.list("admins").some((a) => a.email === email && a.id !== exceptId);

  function readEmail(raw, exceptId) {
    const email = normalizeEmail(raw);
    if (!validEmail(email)) throw httpError(400, "Enter a valid email address.");
    if (emailTaken(email, exceptId)) throw httpError(409, "An admin with that email already exists.");
    return email;
  }

  function readName(raw, fallback) {
    const name = clean(raw, 80);
    if (!name && !fallback) throw httpError(400, "Enter a name.");
    return name || fallback;
  }

  function readPassword(raw) {
    const problem = validatePassword(raw);
    if (problem) throw httpError(400, problem);
    return String(raw);
  }

  // ------------------------------------------------------------ public

  router.get("/healthz", { public: true }, () => ({ ok: true, version: ctx.version, setup: !needsSetup() }));

  router.get("/api/setup", { public: true }, () => ({
    needsSetup: needsSetup(),
    version: ctx.version,
    hostname: os.hostname(),
    panelName: ctx.config.panelName || "Forthway Command Center",
  }));

  router.post("/api/setup", { public: true }, async (req, res, { body }) => {
    sameOrigin(req);
    if (!needsSetup()) throw httpError(409, "This panel is already set up. Sign in instead.");
    const name = readName(body.name);
    const email = readEmail(body.email);
    const password = readPassword(body.password);
    const { salt, hash } = await hashPassword(password);
    // Re-check after the (async) hash: two browsers racing the setup page
    // must not both become owner.
    if (!needsSetup()) throw httpError(409, "This panel is already set up. Sign in instead.");
    const admin = db.insert("admins", {
      email,
      name,
      passwordSalt: salt,
      passwordHash: hash,
      role: "owner",
      lastLoginAt: new Date().toISOString(),
    });
    const panelName = clean(body.panelName, 60);
    if (panelName) {
      ctx.config.panelName = panelName;
      ctx.saveConfig();
    }
    db.save({ immediate: true });
    auth.setSession(res, req, admin);
    ctx.activity(admin, "setup.complete", { type: "admin", id: admin.id, name: admin.name });
    console.log(`[fcc] setup complete — owner ${admin.email}`);
    return { ok: true, admin: publicAdmin(admin) };
  });

  router.post("/api/login", { public: true }, async (req, res, { body }) => {
    sameOrigin(req);
    const ip = requestIp(req);
    const gate = auth.throttle.check(ip);
    if (!gate.allowed) {
      const minutes = Math.max(1, Math.ceil(gate.retryAfterMs / 60000));
      res.setHeader("Retry-After", String(Math.ceil(gate.retryAfterMs / 1000)));
      throw httpError(429, `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
    }
    if (needsSetup()) throw httpError(409, "No admin exists yet. Open /setup first.", { needsSetup: true });
    const admin = await auth.checkCredentials(body.email, body.password);
    if (!admin) {
      auth.throttle.fail(ip);
      throw httpError(401, "Incorrect email or password.");
    }
    auth.throttle.succeed(ip);
    db.update("admins", admin.id, { lastLoginAt: new Date().toISOString() });
    auth.setSession(res, req, admin);
    ctx.activity(admin, "admin.login", { type: "admin", id: admin.id, name: admin.name }, { ip });
    return { ok: true, admin: publicAdmin(admin) };
  });

  // Public so an expired session can still clear its cookie.
  router.post("/api/logout", { public: true }, async (req, res) => {
    const admin = await auth.authenticate(req);
    auth.clearSession(res, req);
    if (admin) ctx.activity(admin, "admin.logout", { type: "admin", id: admin.id, name: admin.name });
    return { ok: true };
  });

  // ---------------------------------------------------------------- me

  router.get("/api/me", (req, res, { admin }) => admin);

  router.patch("/api/me", (req, res, { admin, body }) => {
    const patch = {};
    if (body.name !== undefined) patch.name = readName(body.name);
    if (body.email !== undefined) patch.email = readEmail(body.email, admin.id);
    const fields = Object.keys(patch).filter((k) => patch[k] !== admin[k]);
    const updated = db.update("admins", admin.id, patch);
    if (fields.length) ctx.activity(admin, "admin.update", { type: "admin", id: admin.id, name: updated.name }, { fields });
    return publicAdmin(updated);
  });

  router.post("/api/me/password", async (req, res, { admin, body }) => {
    const key = `pw:${admin.id}`;
    const gate = auth.throttle.check(key);
    if (!gate.allowed) throw httpError(429, "Too many attempts. Try again later.");
    const full = db.get("admins", admin.id);
    if (!(await verifyPassword(body.current, full.passwordSalt, full.passwordHash))) {
      auth.throttle.fail(key);
      throw httpError(400, "Your current password is not right.");
    }
    auth.throttle.succeed(key);
    const next = readPassword(body.next);
    const { salt, hash } = await hashPassword(next);
    const updated = db.update("admins", admin.id, { passwordSalt: salt, passwordHash: hash });
    db.save({ immediate: true });
    // Other sessions for this admin are now invalid; keep this one going.
    auth.setSession(res, req, updated);
    ctx.activity(admin, "admin.password", { type: "admin", id: admin.id, name: admin.name });
    return { ok: true };
  });

  // ------------------------------------------------------------ admins
  //
  // Rules: any admin can add admins and remove non-owner admins (but never
  // themselves). Only the owner can edit the owner, change roles, or hand
  // ownership to someone else (which makes the old owner a plain admin), so
  // there is always exactly one owner.

  router.get("/api/admins", () => ({
    items: db
      .list("admins")
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map(publicAdmin),
  }));

  router.post("/api/admins", async (req, res, { admin, body }) => {
    const name = readName(body.name);
    const email = readEmail(body.email);
    const password = readPassword(body.password);
    const { salt, hash } = await hashPassword(password);
    if (emailTaken(email)) throw httpError(409, "An admin with that email already exists.");
    const created = db.insert("admins", { email, name, passwordSalt: salt, passwordHash: hash, role: "admin", lastLoginAt: null });
    ctx.activity(admin, "admin.create", { type: "admin", id: created.id, name: created.name }, { email });
    return publicAdmin(created);
  });

  router.get("/api/admins/:id", (req, res, { params }) => publicAdmin(getAdmin(params.id)));

  router.patch("/api/admins/:id", async (req, res, { admin, params, body }) => {
    const target = getAdmin(params.id);
    const self = target.id === admin.id;
    const callerIsOwner = admin.role === "owner";
    if (target.role === "owner" && !self && !callerIsOwner) throw httpError(403, "Only the owner can edit the owner.");

    const patch = {};
    if (body.name !== undefined) patch.name = readName(body.name);
    if (body.email !== undefined) patch.email = readEmail(body.email, target.id);
    if (body.password !== undefined && body.password !== "") {
      if (self) throw httpError(400, "Change your own password from your account settings.");
      const { salt, hash } = await hashPassword(readPassword(body.password));
      patch.passwordSalt = salt;
      patch.passwordHash = hash;
    }
    let transferred = false;
    if (body.role !== undefined && body.role !== target.role) {
      if (!callerIsOwner) throw httpError(403, "Only the owner can change roles.");
      if (body.role === "owner") {
        if (self) throw httpError(400, "You are already the owner.");
        transferred = true;
        patch.role = "owner";
      } else if (body.role === "admin") {
        throw httpError(400, "To step down as owner, make another admin the owner.");
      } else {
        throw httpError(400, "Role must be owner or admin.");
      }
    }

    const updated = db.update("admins", target.id, patch);
    if (transferred) db.update("admins", admin.id, { role: "admin" });
    db.save({ immediate: true });
    const fields = Object.keys(patch).filter((k) => k !== "passwordSalt");
    ctx.activity(admin, transferred ? "admin.transfer-owner" : "admin.update", { type: "admin", id: target.id, name: updated.name }, {
      fields: fields.map((f) => (f === "passwordHash" ? "password" : f)),
    });
    return publicAdmin(updated);
  });

  router.delete("/api/admins/:id", (req, res, { admin, params }) => {
    const target = getAdmin(params.id);
    if (target.id === admin.id) throw httpError(400, "You cannot delete yourself.");
    if (target.role === "owner") throw httpError(400, "The owner cannot be deleted. Transfer ownership first.");
    db.remove("admins", target.id);
    db.save({ immediate: true });
    ctx.activity(admin, "admin.delete", { type: "admin", id: target.id, name: target.name }, { email: target.email });
    return { ok: true };
  });

  // ---------------------------------------------------------- projects

  router.get("/api/projects", () => ({
    items: db
      .list("projects")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(publicProject),
  }));

  router.post("/api/projects", (req, res, { admin, body }) => {
    const name = clean(body.name, 80);
    if (!name) throw httpError(400, "Give the project a name.");
    if (db.list("projects").some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw httpError(409, "A project with that name already exists.");
    }
    let slug = slugify(name);
    const slugs = new Set(db.list("projects").map((p) => p.slug));
    for (let i = 2; slugs.has(slug); i++) slug = `${slugify(name).slice(0, 36)}-${i}`;
    const project = db.insert("projects", {
      name,
      slug,
      description: clean(body.description, 500),
      color: readColor(body.color) || "blue",
    });
    ctx.activity(admin, "project.create", { type: "project", id: project.id, name });
    ctx.events.broadcast("project", { action: "created", project: publicProject(project) });
    return publicProject(project);
  });

  router.get("/api/projects/:id", (req, res, { params }) => publicProject(getProject(params.id)));

  router.patch("/api/projects/:id", (req, res, { admin, params, body }) => {
    const project = getProject(params.id);
    const patch = {};
    if (body.name !== undefined) {
      const name = clean(body.name, 80);
      if (!name) throw httpError(400, "Give the project a name.");
      if (db.list("projects").some((p) => p.id !== project.id && p.name.toLowerCase() === name.toLowerCase())) {
        throw httpError(409, "A project with that name already exists.");
      }
      patch.name = name;
    }
    if (body.description !== undefined) patch.description = clean(body.description, 500);
    if (body.color !== undefined) {
      const color = readColor(body.color);
      if (!color) throw httpError(400, "That is not a valid color.");
      patch.color = color;
    }
    // slug is deliberately NOT renamed: site folders are built from it.
    const updated = db.update("projects", project.id, patch);
    ctx.activity(admin, "project.update", { type: "project", id: project.id, name: updated.name }, { fields: Object.keys(patch) });
    ctx.events.broadcast("project", { action: "updated", project: publicProject(updated) });
    return publicProject(updated);
  });

  router.delete("/api/projects/:id", (req, res, { admin, params }) => {
    const project = getProject(params.id);
    const counts = projectCounts(project.id);
    if (counts.sites || counts.databases) {
      throw httpError(
        409,
        `Delete this project's ${[counts.sites && `${counts.sites} website(s)`, counts.databases && `${counts.databases} database(s)`]
          .filter(Boolean)
          .join(" and ")} first.`,
        { counts },
      );
    }
    db.remove("projects", project.id);
    ctx.activity(admin, "project.delete", { type: "project", id: project.id, name: project.name });
    ctx.events.broadcast("project", { action: "deleted", project: { id: project.id, name: project.name } });
    return { ok: true };
  });

  // --------------------------------------------------------- dashboard

  router.get("/api/dashboard", async (req, res, { admin, query }) => {
    const range = query.range === "1h" ? "1h" : "24h";
    const mainId = ctx.cluster?.MAIN_ID || "main";
    const sites = db.list("sites");
    const backups = db.list("backups");

    const [metrics, servers, nginx, mysql] = await Promise.all([
      probe(() => ctx.cluster?.metrics?.({ range })),
      probe(() => ctx.cluster?.listServers?.()),
      probe(() => ctx.lb?.status?.()),
      probe(() => ctx.mysql?.status?.()),
    ]);
    const serverList = Array.isArray(servers) ? servers : db.list("servers");
    let online = 0;
    for (const s of serverList) {
      let up = typeof s.online === "boolean" ? s.online : null;
      if (up === null) {
        try {
          up = !!ctx.cluster?.isOnline?.(s.id);
        } catch {
          up = false;
        }
      }
      if (up) online++;
    }

    return {
      admin,
      panelName: ctx.config.panelName || "Forthway Command Center",
      counts: {
        projects: db.list("projects").length,
        sites: sites.length,
        sitesLoadBalanced: sites.filter((s) => s.loadBalanced).length,
        databases: db.list("databases").length,
        servers: serverList.length,
        serversOnline: online,
        backups: backups.length,
        backupsSize: backups.reduce((n, b) => n + (b.status === "failed" ? 0 : Number(b.size) || 0), 0),
      },
      series: {
        requests: Array.isArray(metrics?.requests) ? metrics.requests : [],
        cpu: (metrics?.servers?.[mainId] || []).map((p) => ({ t: p.t, value: p.cpu ?? null })),
      },
      recentJobs: ctx.jobs.list({ limit: 8 }),
      recentActivity: db.list("activity").reverse().sort(byNewest).slice(0, 10),
      health: { nginx, mysql },
    };
  });

  // ---------------------------------------------------------- settings

  // The panel-wide GitHub token is kept encrypted (tokenEnc); a plain `token`
  // from an older config is still read, and is encrypted on the next save.
  const githubTokenPlain = () => {
    const g = ctx.config.github || {};
    if (g.tokenEnc) {
      try {
        return ctx.secrets.decrypt(g.tokenEnc);
      } catch {
        return "";
      }
    }
    return g.token || "";
  };

  const settingsView = () => ({
    panelName: ctx.config.panelName || "Forthway Command Center",
    panelUrl: ctx.config.panelUrl || "",
    panelUrlEffective: ctx.panelUrl(),
    githubTokenSet: !!githubTokenPlain(),
    githubTokenHint: tokenHint(githubTokenPlain()),
    version: ctx.version,
    hostname: os.hostname(),
    dryRun: !!ctx.sys?.DRY_RUN,
  });

  router.get("/api/settings", () => settingsView());

  router.patch("/api/settings", (req, res, { admin, body }) => {
    const changed = [];
    if (body.panelName !== undefined) {
      const next = clean(body.panelName, 60) || "Forthway Command Center";
      if (next !== ctx.config.panelName) changed.push("panelName");
      ctx.config.panelName = next;
    }
    if (body.panelUrl !== undefined) {
      const raw = clean(body.panelUrl, 300).replace(/\/+$/, "");
      if (raw) {
        let u;
        try {
          u = new URL(raw);
        } catch {
          throw httpError(400, "Panel URL must be a full address, like https://panel.example.com");
        }
        if (!/^https?:$/.test(u.protocol)) throw httpError(400, "Panel URL must start with http:// or https://");
      }
      if (raw !== (ctx.config.panelUrl || "")) changed.push("panelUrl");
      ctx.config.panelUrl = raw;
    }
    if (body.githubToken !== undefined) {
      const token = clean(body.githubToken, 500);
      const { token: _plain, tokenEnc: _enc, ...rest } = ctx.config.github || {};
      ctx.config.github = token ? { ...rest, tokenEnc: ctx.secrets.encrypt(token) } : rest;
      changed.push("githubToken");
    }
    ctx.saveConfig();
    if (changed.length) ctx.activity(admin, "settings.update", { type: "settings", id: "panel", name: "Panel settings" }, { fields: changed });
    return settingsView();
  });

  // -------------------------------------------------------------- jobs

  router.get("/api/jobs", (req, res, { query }) => ({
    items: ctx.jobs.list({
      siteId: query.siteId,
      projectId: query.projectId,
      serverId: query.serverId,
      databaseId: query.databaseId,
      type: query.type,
      status: query.status,
      limit: query.limit || 50,
    }),
  }));

  const getJob = (id) => {
    const job = ctx.jobs.get(id);
    if (!job) throw httpError(404, "Job not found.");
    return job;
  };

  router.get("/api/jobs/:id", (req, res, { params }) => getJob(params.id));

  router.get("/api/jobs/:id/log", (req, res, { params }) => {
    getJob(params.id);
    const text = ctx.jobs.readLog(params.id);
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : text);
  });

  router.post("/api/jobs/:id/cancel", (req, res, { admin, params }) => {
    const job = getJob(params.id);
    if (["succeeded", "failed", "cancelled"].includes(job.status)) throw httpError(409, "That job has already finished.");
    ctx.jobs.cancel(job.id, { by: admin.name || admin.email });
    ctx.activity(admin, "job.cancel", { type: "job", id: job.id, name: job.title, projectId: job.projectId });
    return ctx.jobs.get(job.id);
  });

  // ---------------------------------------------------------- activity

  router.get("/api/activity", (req, res, { query }) => {
    const limit = Math.max(1, Math.min(500, Number(query.limit) || 50));
    const items = db
      .list("activity", (e) => {
        if (query.projectId && e.projectId !== query.projectId) return false;
        if (query.adminId && e.adminId !== query.adminId) return false;
        if (query.targetType && e.target?.type !== query.targetType) return false;
        if (query.targetId && e.target?.id !== query.targetId) return false;
        return true;
      })
      .reverse()
      .sort(byNewest)
      .slice(0, limit);
    return { items };
  });

  // ------------------------------------------------------------ events

  router.get("/api/events", (req, res, { admin }) => {
    ctx.events.subscribe(req, res, admin);
  });
}

function readColor(value) {
  const c = String(value ?? "").trim();
  if (!c) return null;
  return /^(#[0-9a-f]{3,8}|[a-z][a-z0-9-]{0,23})$/i.test(c) ? c : null;
}

export async function start() {}
