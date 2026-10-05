/**
 * Sign in with GitHub, first-run setup, break-glass recovery and the dev
 * sign-in. Registered by core-routes (it is part of CORE, not an optional
 * module).
 *
 * GitHub sign-in is the OAuth App web flow with PKCE (S256):
 *
 *   GET /auth/github?mode=login|link|setup&next=
 *       → state + PKCE verifier in a short-lived signed cookie (fcc_oauth,
 *         HttpOnly, SameSite=Lax so it survives GitHub's redirect back)
 *       → 302 github.com/login/oauth/authorize
 *   GET /auth/github/callback?code&state
 *       → check state, swap the code for a token, read /user (+ verified
 *         primary email, + org membership when an org is configured), throw
 *         the token away, then sign in / link / create the owner.
 *
 * Admins are matched on the numeric GitHub user id, never on the login
 * (logins can be renamed); the stored login and avatar are refreshed on every
 * sign-in. Only admin records grant access — plus, when config.auth.github.org
 * is set, active members of that org (they get an admin record on their first
 * sign-in, marked via: "org", and lose access when they leave the org).
 *
 * The session cookie is SameSite=Strict, and a browser does not send Strict
 * cookies on a navigation that started on github.com — not even after our
 * own 302. So a successful callback answers with a tiny page that moves on
 * with location.replace(): a same-origin navigation that does carry it.
 *
 * config.auth = { provider: "github" | undefined,
 *                 github: { clientId, clientSecretEnc, org? } }
 * provider "github" = GitHub-only: password sign-in is gone. Undefined (a
 * panel installed before this) keeps password sign-in for the migration.
 *
 * Setup is only possible while there are no admins, and only for a browser
 * that typed the one-time setup code (dataDir/setup-code, mode 600, also
 * printed to the journal at boot). Recovery is a one-time link printed by
 * `node panel/recover.mjs` on the server (dataDir/recovery.json holds only
 * its sha256). Nothing on the web can create either.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { httpError, send, redirect } from "./http.mjs";
import { publicAdmin, readCookies, requestIp, isSecureRequest, tokenMatches, appendSetCookie, requestHost } from "./auth.mjs";

const DRY = process.env.FCC_DRY_RUN === "1";
const stripSlash = (s) => String(s || "").replace(/\/+$/, "");
// Test hooks: a fake GitHub can stand in for the real one, in dry-run mode only.
export const OAUTH_BASE = (DRY && stripSlash(process.env.FCC_GITHUB_OAUTH_BASE)) || "https://github.com";
export const API_BASE = (DRY && stripSlash(process.env.FCC_GITHUB_API_BASE)) || "https://api.github.com";
/** "Dev sign-in" button: FCC_DEV_LOGIN=1 AND dry run. Never on a real panel. */
export const DEV_LOGIN = DRY && process.env.FCC_DEV_LOGIN === "1";
export const NEW_APP_URL = "https://github.com/settings/applications/new";

const OAUTH_COOKIE = "fcc_oauth";
const SETUP_COOKIE = "fcc_setup";
const OAUTH_TTL_MS = 10 * 60 * 1000;
const SETUP_TTL_MS = 2 * 60 * 60 * 1000;
const UA = "forthway-command-center";
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const ORG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const rand = (n = 32) => b64url(crypto.randomBytes(n));
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest();
const sha256hex = (s) => sha256(s).toString("hex");

function clean(value, max = 200) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

export function validGithubLogin(login) {
  return LOGIN_RE.test(String(login || ""));
}

function cookie(name, value, req, config, { maxAgeMs, sameSite = "Lax", path: p = "/" }) {
  const parts = [`${name}=${value}`, `Path=${p}`, "HttpOnly", `SameSite=${sameSite}`, `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`];
  if (isSecureRequest(req, config)) parts.push("Secure");
  return parts.join("; ");
}

/**
 * `next` from the sign-in page → a path inside this panel, or "". Accepts
 * "/projects/x", "#/projects/x" and "/#/projects/x"; anything else (other
 * hosts, "//x", backslashes, odd characters) is dropped. The caller always
 * lands on "/#" + next, so it can only ever be a route of this app.
 */
export function safeNext(raw) {
  let n = String(raw ?? "").trim();
  if (!n || n.length > 400) return "";
  if (n.startsWith("/#/")) n = n.slice(2);
  else if (n.startsWith("#/")) n = n.slice(1);
  if (!n.startsWith("/") || n.startsWith("//")) return "";
  if (!/^\/[A-Za-z0-9\-._~/?=&%:+,]*$/.test(n)) return "";
  if (/%(?:[01][0-9a-f]|7f|5c)/i.test(n)) return ""; // encoded control characters or backslashes
  if (n === "/" || /^\/(login|setup)(\/|\?|$)/.test(n)) return "";
  return n;
}
const landing = (next) => (next ? `/#${next}` : "/");

/** Small JSON fetch with a timeout. Never throws on HTTP status; throws on network errors. */
async function ghFetch(url, { method = "GET", headers = {}, body, timeoutMs = 15_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers: { "User-Agent": UA, ...headers }, body, signal: ctrl.signal, redirect: "error" });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch { /* not json */ }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

const apiHeaders = (token) => ({
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

const safeAvatar = (u) => {
  const s = String(u || "");
  return /^https:\/\//.test(s) || (DRY && /^http:\/\//.test(s)) ? s.slice(0, 500) : "";
};

/**
 * Resolve a GitHub username to { id, login, name, avatarUrl } with the public
 * API (the panel-wide GitHub token, when set, only raises the rate limit).
 */
export async function lookupGithubUser(rawLogin, token) {
  const login = String(rawLogin || "").trim().replace(/^@/, "");
  if (!validGithubLogin(login)) throw httpError(400, "That isn't a valid GitHub username.");
  const url = `${API_BASE}/users/${encodeURIComponent(login)}`;
  let r;
  try {
    r = await ghFetch(url, { headers: apiHeaders(token) });
    if (r.status === 401 && token) r = await ghFetch(url, { headers: apiHeaders("") }); // bad panel token: try anonymously
  } catch {
    throw httpError(502, "Couldn't reach GitHub to look that user up. Try again.");
  }
  if (r.status === 404) throw httpError(404, `There's no GitHub user called @${login}.`);
  if (r.status === 403 || r.status === 429) throw httpError(502, "GitHub is rate limiting the panel. Add a token in Settings → GitHub, or try again later.");
  if (r.status !== 200 || !r.json?.id) throw httpError(502, `GitHub answered ${r.status} when looking up @${login}.`);
  if (r.json.type && r.json.type !== "User") throw httpError(400, `@${r.json.login || login} is an organization, not a person.`);
  return {
    id: Number(r.json.id),
    login: String(r.json.login || login),
    name: clean(r.json.name, 80),
    avatarUrl: safeAvatar(r.json.avatar_url),
  };
}

// ------------------------------------------------------------- setup code

function newSetupCode() {
  const bytes = crypto.randomBytes(12);
  let s = "";
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length]; // 32 divides 256: no bias
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The setup code for a fresh panel: kept across restarts until setup finishes. */
export function ensureSetupCode(dataDir) {
  const file = path.join(dataDir, "setup-code");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(existing)) {
      try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
      return existing;
    }
  } catch { /* none yet */ }
  const code = newSetupCode();
  fs.writeFileSync(file, `${code}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return code;
}

function removeSetupCode(dataDir) {
  try { fs.unlinkSync(path.join(dataDir, "setup-code")); } catch { /* already gone */ }
}

// ---------------------------------------------------------------- routes

export function registerLogin(router, ctx, { needsSetup, panelToken }) {
  const { db, config } = ctx;
  const auth = ctx.auth;
  const recoveryFile = path.join(ctx.dataDir, "recovery.json");

  const ghConf = () => config.auth?.github || {};
  const clientSecret = () => {
    try {
      return ctx.secrets.decrypt(ghConf().clientSecretEnc || "");
    } catch {
      return "";
    }
  };
  const githubReady = () => !!(ghConf().clientId && clientSecret());
  const callbackUrl = (req) => `${ctx.panelUrl(req)}/auth/github/callback`;
  const panelUrlFixed = () => !!(config.panelUrl || process.env.FCC_PANEL_URL);
  const owner = () => db.list("admins").find((a) => a.role === "owner") || null;
  const byGithubId = (id) => db.list("admins").find((a) => a.github && Number(a.github.id) === Number(id)) || null;

  function setupGranted(req) {
    return !!auth.unseal("setup", readCookies(req)[SETUP_COOKIE]);
  }

  /** Where a failed attempt lands: the page it started from, with an error code. */
  function errorTarget(mode, code, extra = {}) {
    const q = new URLSearchParams({ error: code });
    if (extra.login && validGithubLogin(extra.login)) q.set("login", extra.login);
    if (mode === "setup") return `/setup?${q}`;
    if (mode === "link") {
      q.delete("error");
      q.set("auth_error", code);
      return `/?${q}#/settings/security`;
    }
    return `/login?${q}`;
  }

  /** Answer with a page that continues via a same-origin navigation (see the header). */
  function finish(res, req, to, admin) {
    if (admin) auth.setSession(res, req, admin);
    const js = JSON.stringify(to).replace(/</g, "\\u003c");
    const href = to.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    send(res, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="0;url=${href}"><title>Signing in…</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#050916;color:#aab6dd;font:14px/1.5 system-ui,sans-serif"><p>Signing you in… <a href="${href}" style="color:#9db3ff">Continue</a></p><script>location.replace(${js})</script></body></html>`, {
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
    });
  }

  function signIn(res, req, admin, via, details = {}) {
    const ip = requestIp(req);
    auth.throttle.succeed(ip);
    const updated = db.update("admins", admin.id, { lastLoginAt: new Date().toISOString() });
    db.save({ immediate: true });
    ctx.activity(updated, "admin.login", { type: "admin", id: updated.id, name: updated.name }, { ip, via, ...details });
    return updated;
  }

  // ------------------------------------------------------ OAuth: start

  router.get("/auth/github", { public: true }, (req, res, { query }) => {
    const mode = ["login", "link", "setup"].includes(query.mode) ? query.mode : "login";
    const next = safeNext(query.next);
    if (mode === "setup") {
      if (!needsSetup()) return redirect(res, "/login");
      if (!setupGranted(req)) return redirect(res, errorTarget(mode, "setup_code"));
    } else if (needsSetup()) {
      return redirect(res, "/setup");
    }
    if (!githubReady()) return redirect(res, errorTarget(mode, "not_configured"));

    // GitHub returns to the panel URL; the state cookie must be set on that same host.
    // (Hosts only: cookies don't care about the scheme, and an untrusted proxy
    // would otherwise make https look like http and loop.)
    let home = null;
    try {
      home = new URL(ctx.panelUrl(req));
    } catch { /* unusable panel URL */ }
    if (home && home.host.toLowerCase() !== String(requestHost(req)).toLowerCase()) {
      home = home.origin;
      if (mode === "login") return redirect(res, `${home}/auth/github${next ? `?next=${encodeURIComponent(next)}` : ""}`);
      return redirect(res, errorTarget(mode, "origin"));
    }

    const payload = { s: rand(), v: rand(), m: mode, n: next, r: callbackUrl(req), exp: Date.now() + OAUTH_TTL_MS };
    if (mode === "link") {
      // The session cookie is Strict, so it will not come back with GitHub's
      // redirect: remember (signed) who asked, and their session version.
      const admin = auth.sessionAdmin(req);
      if (!admin) return redirect(res, `/login?next=${encodeURIComponent("#/settings/security")}`);
      payload.a = admin.id;
      payload.sv = admin.sessionVersion || 0;
    }
    const org = ghConf().org;
    const params = new URLSearchParams({
      client_id: ghConf().clientId,
      redirect_uri: payload.r,
      scope: org ? "read:user user:email read:org" : "read:user user:email",
      state: payload.s,
      code_challenge: b64url(sha256(payload.v)),
      code_challenge_method: "S256",
      allow_signup: "false",
    });
    if (mode !== "login") params.set("prompt", "select_account"); // pick the right account when linking
    appendSetCookie(res, cookie(OAUTH_COOKIE, auth.seal("oauth", payload), req, config, { maxAgeMs: OAUTH_TTL_MS, path: "/auth/github" }));
    redirect(res, `${OAUTH_BASE}/login/oauth/authorize?${params}`);
  });

  // --------------------------------------------------- OAuth: callback

  /** code → token → { user, email, orgMember }. The token is revoked and dropped before returning. */
  async function identify(code, st) {
    const tok = await ghFetch(`${OAUTH_BASE}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: ghConf().clientId, client_secret: clientSecret(), code, redirect_uri: st.r, code_verifier: st.v }),
    });
    const token = tok.json?.access_token;
    if (!token) {
      const e = new Error(tok.json?.error_description || tok.json?.error || `token exchange answered ${tok.status}`);
      e.code = tok.json?.error === "incorrect_client_credentials" ? "client" : tok.json?.error === "redirect_uri_mismatch" ? "redirect" : "github_error";
      throw e;
    }
    try {
      const u = await ghFetch(`${API_BASE}/user`, { headers: apiHeaders(token) });
      if (u.status !== 200 || !Number.isSafeInteger(Number(u.json?.id)) || !validGithubLogin(u.json?.login)) {
        throw Object.assign(new Error(`/user answered ${u.status}`), { code: "github_error" });
      }
      const user = { id: Number(u.json.id), login: String(u.json.login), name: clean(u.json.name, 80), avatarUrl: safeAvatar(u.json.avatar_url) };
      let email = "";
      try {
        const em = await ghFetch(`${API_BASE}/user/emails`, { headers: apiHeaders(token) });
        if (Array.isArray(em.json)) email = String(em.json.find((e) => e && e.primary && e.verified)?.email || "").slice(0, 254);
      } catch { /* email is optional */ }
      let orgMember = null;
      const org = ghConf().org;
      if (org) {
        try {
          const m = await ghFetch(`${API_BASE}/user/memberships/orgs/${encodeURIComponent(org)}`, { headers: apiHeaders(token) });
          orgMember = m.status === 200 && m.json?.state === "active";
        } catch {
          orgMember = false;
        }
      }
      return { user, email, orgMember };
    } finally {
      revoke(token);
    }
  }

  /** Best effort: tell GitHub to forget the token right away (we never stored it). */
  function revoke(token) {
    const id = ghConf().clientId, secret = clientSecret();
    if (!id || !secret) return;
    ghFetch(`${API_BASE}/applications/${encodeURIComponent(id)}/token`, {
      method: "DELETE",
      headers: { ...apiHeaders(""), Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: token }),
      timeoutMs: 8000,
    }).catch(() => {});
  }

  const ghRecord = (user, prev = {}) => ({
    ...prev,
    id: user.id,
    login: user.login,
    avatarUrl: user.avatarUrl,
    linkedAt: prev.linkedAt || new Date().toISOString(),
  });

  router.get("/auth/github/callback", { public: true }, async (req, res, { query }) => {
    const ip = requestIp(req);
    const st = auth.unseal("oauth", readCookies(req)[OAUTH_COOKIE]);
    appendSetCookie(res, cookie(OAUTH_COOKIE, "", req, config, { maxAgeMs: 0, path: "/auth/github" }));
    const mode = ["login", "link", "setup"].includes(st?.m) ? st.m : "login";
    const fail = (code, extra = {}) => {
      auth.throttle.fail(ip);
      console.warn(`[fcc] GitHub sign-in refused (${code}${extra.login ? ` @${extra.login}` : ""}${extra.detail ? `: ${extra.detail}` : ""}) from ${ip}`);
      return redirect(res, errorTarget(mode, code, extra));
    };

    const gate = auth.throttle.check(ip);
    if (!gate.allowed) return redirect(res, errorTarget(mode, "throttled"));
    if (query.error) return fail(query.error === "access_denied" ? "denied" : "github_error", { detail: clean(query.error, 80) });
    if (!st || !query.state || !tokenMatches(query.state, st.s)) return fail("state");
    if (!query.code) return fail("github_error", { detail: "no code" });
    if (!githubReady()) return fail("not_configured");

    let who;
    try {
      who = await identify(String(query.code).slice(0, 200), st);
    } catch (err) {
      return fail(err.code || "github_error", { detail: err.message });
    }
    const { user, email, orgMember } = who;
    const org = ghConf().org;

    if (mode === "setup") {
      // Only a browser that typed the setup code could start this flow.
      if (!needsSetup()) return redirect(res, "/login?error=already_setup");
      const admin = db.insert("admins", {
        email: email.toLowerCase(),
        name: user.name || user.login,
        role: "owner",
        github: ghRecord(user),
        sessionVersion: 0,
        lastLoginAt: null,
      });
      config.auth = { ...(config.auth || {}), provider: "github" };
      ctx.saveConfig();
      removeSetupCode(ctx.dataDir);
      appendSetCookie(res, cookie(SETUP_COOKIE, "", req, config, { maxAgeMs: 0, sameSite: "Strict" }));
      ctx.activity(admin, "setup.complete", { type: "admin", id: admin.id, name: admin.name }, { github: user.login });
      console.log(`[fcc] setup complete — owner @${user.login} (GitHub id ${user.id})`);
      return finish(res, req, "/", signIn(res, req, admin, "github", { github: user.login }));
    }

    if (mode === "link") {
      const admin = st.a ? db.get("admins", st.a) : null;
      if (!admin || (admin.sessionVersion || 0) !== st.sv) return fail("session");
      const other = byGithubId(user.id);
      if (other && other.id !== admin.id) return fail("taken", { login: user.login });
      const changed = admin.github && Number(admin.github.id) !== user.id;
      db.update("admins", admin.id, { github: ghRecord(user, changed ? {} : admin.github || {}) });
      if (!admin.email && email) db.update("admins", admin.id, { email: email.toLowerCase() });
      db.save({ immediate: true });
      auth.throttle.succeed(ip);
      ctx.activity(admin, "admin.github-link", { type: "admin", id: admin.id, name: admin.name }, { github: user.login });
      return finish(res, req, "/?auth=linked#/settings/security");
    }

    // mode === "login"
    let admin = byGithubId(user.id);
    if (admin && org && admin.github?.via === "org" && !orgMember) return fail("not_admin", { login: user.login, detail: `left org ${org}` });
    if (!admin && org && orgMember) {
      admin = db.insert("admins", {
        email: email.toLowerCase(),
        name: user.name || user.login,
        role: "admin",
        github: { ...ghRecord(user), via: "org" },
        sessionVersion: 0,
        lastLoginAt: null,
      });
      ctx.activity(null, "admin.create", { type: "admin", id: admin.id, name: admin.name }, { github: user.login, via: `org ${org}` });
    }
    if (!admin) return fail("not_admin", { login: user.login });
    const patch = { github: ghRecord(user, admin.github) };
    if (!admin.name) patch.name = user.name || user.login;
    if (!admin.email && email) patch.email = email.toLowerCase();
    db.update("admins", admin.id, patch);
    return finish(res, req, landing(st.n), signIn(res, req, admin, "github", { github: user.login }));
  });

  // ------------------------------------------------- break-glass link

  router.get("/auth/recover", { public: true }, (req, res, { query }) => {
    const ip = requestIp(req);
    const bad = (code) => {
      auth.throttle.fail(ip);
      console.warn(`[fcc] recovery link refused (${code}) from ${ip}`);
      return redirect(res, `/login?error=${code}`);
    };
    if (!auth.throttle.check(ip).allowed) return redirect(res, "/login?error=throttled");
    let rec = null;
    try {
      rec = JSON.parse(fs.readFileSync(recoveryFile, "utf8"));
    } catch { /* none */ }
    if (!rec || !query.token) return bad("recovery");
    if (!(rec.exp > Date.now())) {
      try { fs.unlinkSync(recoveryFile); } catch { /* gone */ }
      return bad("recovery_expired");
    }
    if (!tokenMatches(sha256hex(String(query.token)), rec.tokenHash)) return bad("recovery");
    try {
      fs.unlinkSync(recoveryFile); // single use: gone before the session exists
    } catch {
      return bad("recovery");
    }
    const admin = db.get("admins", rec.adminId) || owner();
    if (!admin) return bad("recovery");
    return finish(res, req, "/#/settings/security", signIn(res, req, admin, "recovery"));
  });

  // ------------------------------------------------------------ setup

  router.post("/api/setup/verify", { public: true }, (req, res, { body }) => {
    sameOriginOnly(req);
    if (!needsSetup()) throw httpError(409, "This panel is already set up. Sign in instead.");
    const ip = requestIp(req);
    const key = `setup:${ip}`;
    const gate = auth.throttle.check(key);
    if (!gate.allowed) throw httpError(429, "Too many wrong codes. Wait a few minutes and try again.");
    const expected = normCode(ensureSetupCode(ctx.dataDir));
    if (!tokenMatches(normCode(body.code), expected)) {
      auth.throttle.fail(key);
      throw httpError(400, "That setup code isn't right. Copy it again from the server.");
    }
    auth.throttle.succeed(key);
    appendSetCookie(res, cookie(SETUP_COOKIE, auth.seal("setup", { exp: Date.now() + SETUP_TTL_MS }), req, config, { maxAgeMs: SETUP_TTL_MS, sameSite: "Strict" }));
    return { ok: true, ...setupDetails(req, true) };
  });

  router.post("/api/setup", { public: true }, (req, res, { body }) => {
    sameOriginOnly(req);
    if (!needsSetup()) throw httpError(409, "This panel is already set up. Sign in instead.");
    if (!setupGranted(req)) throw httpError(403, "Enter the setup code first.", { needsCode: true });
    const panelName = clean(body.panelName, 60);
    if (panelName) config.panelName = panelName;
    if (body.panelUrl !== undefined) config.panelUrl = readPanelUrl(body.panelUrl);
    const clientId = clean(body.clientId, 100);
    const secret = clean(body.clientSecret, 200);
    if (!clientId) throw httpError(400, "Paste the Client ID of your GitHub OAuth App.");
    if (!/^[A-Za-z0-9._-]+$/.test(clientId)) throw httpError(400, "That Client ID doesn't look right.");
    if (!secret && !ghConf().clientSecretEnc) throw httpError(400, "Paste the Client Secret too.");
    config.auth = {
      ...(config.auth || {}),
      provider: "github",
      github: { ...ghConf(), clientId, ...(secret ? { clientSecretEnc: ctx.secrets.encrypt(secret) } : {}) },
    };
    ctx.saveConfig();
    return { ok: true, ...setupDetails(req, true) };
  });

  function setupDetails(req, granted) {
    if (!granted) return {};
    return {
      setupVerified: true,
      panelName: config.panelName || "",
      panelUrl: config.panelUrl || "",
      suggestedPanelUrl: ctx.panelUrl(req),
      callbackPath: "/auth/github/callback",
      clientId: ghConf().clientId || "",
      clientSecretSet: !!ghConf().clientSecretEnc,
      newAppUrl: NEW_APP_URL,
    };
  }

  /** Extra fields for the public GET /api/setup (login + setup pages). */
  ctx.loginInfo = (req) => {
    const m = auth.mode();
    const fresh = needsSetup();
    return {
      auth: { github: githubReady(), githubOnly: m.githubOnly, passwordLogin: !fresh && m.passwordLogin, devLogin: DEV_LOGIN },
      ...(fresh ? { setupCodeFile: path.join(ctx.dataDir, "setup-code"), ...setupDetails(req, setupGranted(req)) } : {}),
    };
  };

  // -------------------------------------------------------- dev sign-in

  router.post("/api/auth/dev", { public: true }, (req, res, { body }) => {
    if (!DEV_LOGIN) throw httpError(404, "Not found");
    sameOriginOnly(req);
    let admin;
    if (needsSetup()) {
      admin = db.insert("admins", { email: "dev@localhost", name: "Developer", role: "owner", github: null, sessionVersion: 0, lastLoginAt: null });
      config.auth = { ...(config.auth || {}), provider: "github" };
      ctx.saveConfig();
      removeSetupCode(ctx.dataDir);
      ctx.activity(admin, "setup.complete", { type: "admin", id: admin.id, name: admin.name }, { via: "dev" });
    } else {
      admin = (body.adminId && db.get("admins", body.adminId)) || owner();
    }
    auth.setSession(res, req, signIn(res, req, admin, "dev"));
    return { ok: true, admin: publicAdmin(admin) };
  });

  // ------------------------------------------------ Settings → Security

  const secretHint = (s) => (s ? `••••${String(s).slice(-4)}` : null);

  function securityView(req, me) {
    const m = auth.mode();
    const g = ghConf();
    const admins = db.list("admins").sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const self = db.get("admins", me.id);
    const blockers = [];
    if (!githubReady()) blockers.push("Save the Client ID and Client Secret of your GitHub OAuth App.");
    if (!self?.github) blockers.push("Link your own GitHub account.");
    // Every owner must be able to sign in once passwords are gone.
    const unlinkedOwners = admins.filter((a) => a.role === "owner" && a.id !== self?.id && !a.github);
    if (unlinkedOwners.length) {
      const names = unlinkedOwners.map((a) => a.name || a.email).join(", ");
      blockers.push(`${unlinkedOwners.length === 1 ? `The owner ${names} has` : `The owners ${names} have`} to link GitHub first (in Settings → Security, or set their GitHub username under Admins).`);
    }
    return {
      githubOnly: m.githubOnly,
      githubConfigured: githubReady(),
      github: { clientId: g.clientId || "", clientSecretSet: !!g.clientSecretEnc, clientSecretHint: secretHint(clientSecret()), org: g.org || "" },
      callbackUrl: callbackUrl(req),
      homepageUrl: ctx.panelUrl(req),
      panelUrlFixed: panelUrlFixed(),
      newAppUrl: NEW_APP_URL,
      admins: admins.map((a) => ({ id: a.id, name: a.name, email: a.email || "", role: a.role, github: publicAdmin(a).github, hasPassword: !!a.passwordHash })),
      unlinked: admins.filter((a) => !a.github).map((a) => a.name || a.email),
      canSwitch: !m.githubOnly && blockers.length === 0,
      blockers: m.githubOnly ? [] : blockers,
      switchedAt: config.auth?.switchedAt || null,
      devLogin: DEV_LOGIN,
    };
  }

  router.get("/api/auth", (req, res, { admin }) => securityView(req, admin));

  router.patch("/api/auth", (req, res, { admin, body }) => {
    const g = { ...ghConf() };
    const changed = [];
    if (body.clientId !== undefined) {
      const id = clean(body.clientId, 100);
      if (id && !/^[A-Za-z0-9._-]+$/.test(id)) throw httpError(400, "That Client ID doesn't look right.");
      if (!id && auth.mode().githubOnly) throw httpError(400, "GitHub is the only way to sign in, so the Client ID can't be removed.");
      if (id !== (g.clientId || "")) changed.push("clientId");
      g.clientId = id;
    }
    if (body.clientSecret !== undefined && body.clientSecret !== "") {
      g.clientSecretEnc = ctx.secrets.encrypt(clean(body.clientSecret, 200));
      changed.push("clientSecret");
    }
    if (body.org !== undefined) {
      const org = clean(body.org, 40).replace(/^@/, "");
      if (org && !ORG_RE.test(org)) throw httpError(400, "That isn't a valid GitHub organization name.");
      if (org !== (g.org || "")) changed.push("org");
      if (org) g.org = org;
      else delete g.org;
    }
    config.auth = { ...(config.auth || {}), github: g };
    ctx.saveConfig();
    if (changed.length) ctx.activity(admin, "settings.update", { type: "settings", id: "auth", name: "Sign-in settings" }, { fields: changed });
    return securityView(req, admin);
  });

  router.post("/api/auth/github-only", (req, res, { admin }) => {
    const view = securityView(req, admin);
    if (view.githubOnly) return view;
    if (!view.canSwitch) throw httpError(400, view.blockers[0] || "Not ready to switch yet.");
    config.auth = { ...(config.auth || {}), provider: "github", switchedAt: new Date().toISOString(), switchedBy: admin.id };
    ctx.saveConfig();
    // Password hashes are no longer any use to anybody: drop them.
    for (const a of db.list("admins")) {
      const rec = db.get("admins", a.id);
      delete rec.passwordHash;
      delete rec.passwordSalt;
    }
    db.save({ immediate: true });
    // Re-issue this browser's cookie (an old password-era cookie stops working now).
    auth.setSession(res, req, db.get("admins", admin.id));
    ctx.activity(admin, "auth.github-only", { type: "settings", id: "auth", name: "Sign-in settings" }, { unlinked: view.unlinked });
    console.log(`[fcc] password sign-in turned off by ${admin.name || admin.email} — GitHub only from now on`);
    return securityView(req, admin);
  });

  router.delete("/api/me/github", (req, res, { admin }) => {
    if (auth.mode().githubOnly) throw httpError(400, "GitHub is the only way to sign in, so you can't unlink your account. Another admin can change it for you under Admins.");
    const rec = db.get("admins", admin.id);
    if (!rec.github) return publicAdmin(rec);
    if (!rec.passwordHash) throw httpError(400, "You have no password to fall back on, so unlinking would lock you out.");
    db.update("admins", admin.id, { github: null });
    const updated = auth.bumpSessions(admin.id);
    db.save({ immediate: true });
    auth.setSession(res, req, updated);
    ctx.activity(admin, "admin.github-unlink", { type: "admin", id: admin.id, name: admin.name }, { github: rec.github.login });
    return publicAdmin(updated);
  });

  router.post("/api/me/sessions/revoke", (req, res, { admin }) => {
    auth.bumpSessions(admin.id);
    db.save({ immediate: true });
    auth.clearSession(res, req);
    ctx.activity(admin, "admin.logout-everywhere", { type: "admin", id: admin.id, name: admin.name });
    return { ok: true };
  });

  // Lets core-routes resolve "add admin by GitHub username".
  ctx.githubUser = (login) => lookupGithubUser(login, panelToken());

  function readPanelUrl(raw) {
    const s = clean(raw, 300).replace(/\/+$/, "");
    if (!s) return "";
    let u;
    try {
      u = new URL(s);
    } catch {
      throw httpError(400, "Panel URL must be a full address, like https://panel.example.com");
    }
    if (!/^https?:$/.test(u.protocol)) throw httpError(400, "Panel URL must start with http:// or https://");
    if (u.pathname !== "/" || u.search || u.hash) throw httpError(400, "Panel URL is just the address, without a path (https://panel.example.com).");
    return `${u.protocol}//${u.host}`;
  }
}

/** Public POSTs have no session, so refuse cross-site ones here. */
function sameOriginOnly(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host = null;
  try {
    host = new URL(origin).host;
  } catch { /* "null" or garbage */ }
  if (host !== req.headers.host) throw httpError(403, "Cross-origin request refused.");
}
