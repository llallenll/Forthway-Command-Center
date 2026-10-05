/**
 * Admin accounts and sessions.
 *
 * Admins sign in with GitHub (lib/login.mjs). Panels installed before that
 * keep email + password sign-in (scrypt, per-user salt) until an admin
 * switches to GitHub-only in Settings → Security (config.auth.provider ===
 * "github"); after that every password path is refused.
 *
 * Sessions are stateless HMAC-signed cookies so a panel restart mid-deploy
 * does not sign anybody out. The cookie carries:
 *
 *   a    the admin id — a session for a deleted admin is refused;
 *   exp  expiry (ms since epoch);
 *   sv   the admin's sessionVersion — bumped by "sign out everywhere",
 *        unlinking/relinking GitHub and password changes, which ends every
 *        older session for that admin.
 *
 * Cookies from before sessionVersion carry `pv` (a fingerprint of the
 * password hash) instead; they are still honoured until GitHub-only is on.
 *
 * `authenticate(req)` returns the PUBLIC view of the admin
 * ({ id, email, name, role, github, createdAt, lastLoginAt }) or null.
 * Handlers never see password material.
 */

import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);

export const SESSION_COOKIE = "fcc_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
export const MIN_PASSWORD = 8;

// ------------------------------------------------------------- passwords

export async function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = await scrypt(String(password), salt, 64);
  return { salt, hash: derived.toString("hex") };
}

export async function verifyPassword(password, salt, hash) {
  if (!password || !salt || !hash) return false;
  let derived;
  try {
    derived = await scrypt(String(password), salt, 64);
  } catch {
    return false;
  }
  const b = Buffer.from(hash, "hex");
  if (derived.length !== b.length) return false;
  return crypto.timingSafeEqual(derived, b);
}

export function validatePassword(password) {
  const pw = String(password ?? "");
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 1024) return "That password is too long.";
  return null;
}

export function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

export function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

export function publicAdmin(a) {
  if (!a) return null;
  return {
    id: a.id,
    email: a.email,
    name: a.name,
    role: a.role,
    github: a.github ? { id: a.github.id, login: a.github.login, avatarUrl: a.github.avatarUrl || "" } : null,
    hasPassword: !!a.passwordHash,
    createdAt: a.createdAt,
    lastLoginAt: a.lastLoginAt || null,
  };
}

/** Add a Set-Cookie header without dropping ones already set on `res`. */
export function appendSetCookie(res, value) {
  const prev = res.getHeader("Set-Cookie");
  const list = prev ? (Array.isArray(prev) ? prev : [String(prev)]) : [];
  res.setHeader("Set-Cookie", [...list, value]);
}

// --------------------------------------------------------------- cookies

export function readCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* malformed cookie — ignore it */
    }
  }
  return out;
}

/**
 * Proxy headers (X-Forwarded-For / -Proto / -Host) are only believed when
 * FCC_TRUST_PROXY=1 — i.e. the panel sits behind its own nginx on 127.0.0.1
 * (install.sh sets it with a panel domain). Otherwise anyone could pick their
 * own IP for the login throttle by sending the header.
 */
export const TRUST_PROXY = process.env.FCC_TRUST_PROXY === "1";

function firstHeader(req, name) {
  return String(req.headers[name] || "").split(",")[0].trim();
}

/** Client IP for throttling/audit: socket address unless the proxy is trusted. */
export function requestIp(req) {
  const sock = (req.socket?.remoteAddress || "?").replace(/^::ffff:/, "");
  if (!TRUST_PROXY) return sock;
  // The LAST X-Forwarded-For entry is the one our own nginx appended
  // ($proxy_add_x_forwarded_for); earlier ones are whatever the client sent.
  const chain = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return chain[chain.length - 1] || String(req.headers["x-real-ip"] || "").trim() || sock;
}

/** "https" or "http" as the browser sees it. */
export function requestProto(req, config) {
  if (TRUST_PROXY) {
    const p = firstHeader(req, "x-forwarded-proto").toLowerCase();
    if (p === "https" || p === "http") return p;
  }
  return config?.tls || req.socket?.encrypted ? "https" : "http";
}

/** Host as the browser sees it. */
export function requestHost(req) {
  return (TRUST_PROXY && firstHeader(req, "x-forwarded-host")) || firstHeader(req, "host");
}

/** Secure cookies when the browser reached us over HTTPS (directly or via a trusted proxy). */
export function isSecureRequest(req, config) {
  return requestProto(req, config) === "https";
}

/** Constant-time compare for tokens. */
export function tokenMatches(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// -------------------------------------------------------------- throttle

/** In-memory throttle so passwords cannot be brute-forced (per IP). */
export class LoginThrottle {
  constructor({ maxAttempts = 8, windowMs = 10 * 60 * 1000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.byKey = new Map();
  }

  check(key) {
    const rec = this.byKey.get(key);
    if (!rec) return { allowed: true };
    if (Date.now() - rec.first > this.windowMs) {
      this.byKey.delete(key);
      return { allowed: true };
    }
    if (rec.count >= this.maxAttempts) {
      return { allowed: false, retryAfterMs: this.windowMs - (Date.now() - rec.first) };
    }
    return { allowed: true };
  }

  fail(key) {
    const rec = this.byKey.get(key);
    if (!rec || Date.now() - rec.first > this.windowMs) {
      this.byKey.set(key, { first: Date.now(), count: 1 });
    } else {
      rec.count++;
    }
    // Keep the map from growing without bound under a spray of addresses.
    if (this.byKey.size > 10_000) {
      for (const [k, r] of this.byKey) if (Date.now() - r.first > this.windowMs) this.byKey.delete(k);
    }
  }

  succeed(key) {
    this.byKey.delete(key);
  }
}

// -------------------------------------------------------------- sessions

/**
 * Bind the session helpers to the panel's db and config.
 */
export function createAuth({ db, config }) {
  const secret = () => config.sessionSecret;

  const fingerprint = (admin) =>
    crypto.createHmac("sha256", secret()).update(`pv:${admin.passwordHash || ""}`).digest("base64url").slice(0, 16);

  /** Where sign-in may come from right now (config.auth, see lib/login.mjs). */
  function mode() {
    const a = config.auth || {};
    const gh = a.github || {};
    const githubOnly = a.provider === "github";
    return { githubConfigured: !!(gh.clientId && gh.clientSecretEnc), githubOnly, passwordLogin: !githubOnly };
  }

  // Session tokens MAC the body alone (unchanged, so existing cookies stay
  // valid); every other purpose MACs "<purpose>.<body>". A base64url body
  // never contains ".", so one kind can never pass for another.
  const mac = (body, purpose) =>
    crypto.createHmac("sha256", secret()).update(purpose ? `${purpose}.${body}` : body).digest("base64url");

  function sign(payload, purpose = "") {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${mac(body, purpose)}`;
  }

  function unsign(token, purpose = "") {
    if (!token || typeof token !== "string") return null;
    const dot = token.indexOf(".");
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const mac_ = token.slice(dot + 1);
    const expected = mac(body, purpose);
    if (!tokenMatches(mac_, expected)) return null;
    try {
      return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return null;
    }
  }

  function issue(admin) {
    const now = Date.now();
    return sign({ a: admin.id, iat: now, exp: now + SESSION_TTL_MS, sv: admin.sessionVersion || 0 });
  }

  function cookieHeader(token, req) {
    const parts = [
      `${SESSION_COOKIE}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (isSecureRequest(req, config)) parts.push("Secure");
    return parts.join("; ");
  }

  function clearCookieHeader(req) {
    const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
    if (isSecureRequest(req, config)) parts.push("Secure");
    return parts.join("; ");
  }

  /** The full admin record behind a request's session, or null. */
  function sessionAdmin(req) {
    const payload = unsign(readCookies(req)[SESSION_COOKIE]);
    if (!payload || typeof payload.exp !== "number" || payload.exp <= Date.now()) return null;
    const admin = db.get("admins", payload.a);
    if (!admin) return null;
    if (typeof payload.sv === "number") {
      if (payload.sv !== (admin.sessionVersion || 0)) return null;
    } else if (payload.pv && !mode().githubOnly) {
      if (!admin.passwordHash || !tokenMatches(payload.pv, fingerprint(admin))) return null; // pre-sessionVersion cookie
    } else {
      return null;
    }
    return admin;
  }

  /** Public view of the signed-in admin, or null. Used by the Router. */
  async function authenticate(req) {
    return publicAdmin(sessionAdmin(req));
  }

  /** Set the session cookie on a response that is about to be sent. */
  function setSession(res, req, admin) {
    appendSetCookie(res, cookieHeader(issue(admin), req));
  }

  function clearSession(res, req) {
    appendSetCookie(res, clearCookieHeader(req));
  }

  /** End every session of an admin (theirs and anyone holding an old cookie). Returns the record. */
  function bumpSessions(adminId) {
    const a = db.get("admins", adminId);
    if (!a) return null;
    return db.update("admins", adminId, { sessionVersion: (a.sessionVersion || 0) + 1 });
  }

  /** Look up an admin by email (case-insensitive). Full record. */
  function findByEmail(email) {
    const e = normalizeEmail(email);
    return db.list("admins").find((a) => a.email === e) || null;
  }

  // A real hash to burn time on when the email is unknown, so response time
  // does not reveal which emails have accounts.
  let dummy = null;
  async function checkCredentials(email, password) {
    const admin = findByEmail(email);
    if (admin && !admin.passwordHash) {
      // GitHub-only admin: burn the same time as a wrong password.
      dummy ||= await hashPassword(crypto.randomBytes(12).toString("hex"));
      await verifyPassword(String(password ?? ""), dummy.salt, dummy.hash);
      return null;
    }
    if (!admin) {
      dummy ||= await hashPassword(crypto.randomBytes(12).toString("hex"));
      await verifyPassword(String(password ?? ""), dummy.salt, dummy.hash);
      return null;
    }
    return (await verifyPassword(password, admin.passwordSalt, admin.passwordHash)) ? admin : null;
  }

  return {
    throttle: new LoginThrottle(),
    authenticate,
    sessionAdmin,
    setSession,
    clearSession,
    findByEmail,
    checkCredentials,
    issue,
    bumpSessions,
    mode,
    seal: (purpose, payload) => sign(payload, purpose),
    unseal: (purpose, token) => {
      const p = unsign(token, purpose);
      return p && typeof p.exp === "number" && p.exp > Date.now() ? p : null;
    },
  };
}
