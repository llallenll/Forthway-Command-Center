/**
 * Password gate for the Forthway Command Center.
 *
 * Single shared password (this is a one-operator tool), stored as a scrypt
 * hash. Sessions are stateless signed cookies so a hub restart mid-deploy
 * does not log you out.
 */

import crypto from "node:crypto";

const SESSION_COOKIE = "fcc_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash: derived };
}

export function verifyPassword(password, salt, hash) {
  if (!password || !salt || !hash) return false;
  let derived;
  try {
    derived = crypto.scryptSync(password, salt, 64).toString("hex");
  } catch {
    return false;
  }
  const a = Buffer.from(derived, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function unsign(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function issueSession(secret) {
  const now = Date.now();
  return sign({ iat: now, exp: now + SESSION_TTL_MS }, secret);
}

export function readCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isAuthed(req, secret) {
  const token = readCookies(req)[SESSION_COOKIE];
  const payload = unsign(token, secret);
  if (!payload) return false;
  return typeof payload.exp === "number" && payload.exp > Date.now();
}

export function sessionCookieHeader(token, { secure }) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** Simple in-memory throttle so the password cannot be brute-forced. */
export class LoginThrottle {
  constructor({ maxAttempts = 8, windowMs = 10 * 60 * 1000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.byIp = new Map();
  }

  check(ip) {
    const rec = this.byIp.get(ip);
    if (!rec) return { allowed: true };
    if (Date.now() - rec.first > this.windowMs) {
      this.byIp.delete(ip);
      return { allowed: true };
    }
    if (rec.count >= this.maxAttempts) {
      return { allowed: false, retryAfterMs: this.windowMs - (Date.now() - rec.first) };
    }
    return { allowed: true };
  }

  fail(ip) {
    const rec = this.byIp.get(ip);
    if (!rec || Date.now() - rec.first > this.windowMs) {
      this.byIp.set(ip, { first: Date.now(), count: 1 });
    } else {
      rec.count++;
    }
  }

  succeed(ip) {
    this.byIp.delete(ip);
  }
}

/** Constant-time compare for agent tokens. */
export function tokenMatches(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
