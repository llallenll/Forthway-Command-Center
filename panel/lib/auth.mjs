/**
 * Admin accounts and sessions.
 *
 * Admins sign in with email + password (scrypt, per-user salt). Sessions are
 * stateless HMAC-signed cookies so a panel restart mid-deploy does not sign
 * anybody out. The cookie carries:
 *
 *   a    the admin id — a session for a deleted admin is refused;
 *   exp  expiry (ms since epoch);
 *   pv   a fingerprint of the admin's current password hash — changing or
 *        resetting a password ends every other session for that admin.
 *
 * `authenticate(req)` returns the PUBLIC view of the admin
 * ({ id, email, name, role, createdAt, lastLoginAt }) or null. Handlers never
 * see password material.
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
    createdAt: a.createdAt,
    lastLoginAt: a.lastLoginAt || null,
  };
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

  function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const mac = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
    return `${body}.${mac}`;
  }

  function unsign(token) {
    if (!token || typeof token !== "string") return null;
    const dot = token.indexOf(".");
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    const expected = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
    if (!tokenMatches(mac, expected)) return null;
    try {
      return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return null;
    }
  }

  function issue(admin) {
    const now = Date.now();
    return sign({ a: admin.id, iat: now, exp: now + SESSION_TTL_MS, pv: fingerprint(admin) });
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
    if (!tokenMatches(payload.pv, fingerprint(admin))) return null;
    return admin;
  }

  /** Public view of the signed-in admin, or null. Used by the Router. */
  async function authenticate(req) {
    return publicAdmin(sessionAdmin(req));
  }

  /** Set the session cookie on a response that is about to be sent. */
  function setSession(res, req, admin) {
    res.setHeader("Set-Cookie", cookieHeader(issue(admin), req));
  }

  function clearSession(res, req) {
    res.setHeader("Set-Cookie", clearCookieHeader(req));
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
  };
}
