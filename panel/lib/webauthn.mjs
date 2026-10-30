/**
 * WebAuthn (passkeys) verification with no dependencies — the crypto half of
 * the passkey sign-in step. Routes, sessions and storage are in passkeys.mjs.
 *
 * What is checked, for both ceremonies (W3C WebAuthn Level 2, §7.1 / §7.2):
 *
 *   clientDataJSON   type ("webauthn.create" | "webauthn.get"), the challenge
 *                    we issued (exact base64url string), the origin (one of
 *                    ours, exactly) and crossOrigin !== true;
 *   authenticatorData  rpIdHash == sha256(rpId), the User Present flag and —
 *                    because a passkey is the second factor here — the User
 *                    Verified flag (biometric / device PIN, see passkeys.mjs);
 *   registration     the attested credential data (id, COSE public key) and
 *                    that the key's algorithm is one we offered. Attestation
 *                    statements are NOT verified: we ask for attestation
 *                    "none" (no vendor certificates, no privacy cost), and a
 *                    statement some browser sends anyway is ignored the same
 *                    way — the panel trusts the key because a GitHub-signed-in
 *                    admin created it, not because of who made the device;
 *   sign-in          the signature over authenticatorData ‖ sha256(clientDataJSON)
 *                    with the stored key, the userHandle when the browser sends
 *                    one, and the signature counter (a counter that goes
 *                    backwards is reported, not refused: synced passkeys keep
 *                    it at 0, and a false alarm must not lock anyone out).
 *
 * Keys: ES256 (-7, P-256), RS256 (-257, RSA PKCS#1 v1.5, ≥ 2048 bits) and
 * EdDSA (-8, Ed25519) — COSE keys are turned into JWKs and loaded with
 * crypto.createPublicKey, which is also how they are stored.
 *
 * Challenges: ChallengeStore hands out 32 random bytes per ceremony, kept in
 * memory with what they are bound to (kind, admin, session, rpId, origin) and
 * a short expiry; take() removes one whatever the outcome, so each is good for
 * exactly one attempt.
 */

import crypto from "node:crypto";

export const ALG = { ES256: -7, EdDSA: -8, RS256: -257 };
export const SUPPORTED_ALGS = [ALG.EdDSA, ALG.ES256, ALG.RS256];

// authenticatorData flags
export const FLAG_UP = 0x01; // user present
export const FLAG_UV = 0x04; // user verified
export const FLAG_BE = 0x08; // backup eligible (a multi-device / synced passkey)
export const FLAG_BS = 0x10; // backed up (currently synced)
export const FLAG_AT = 0x40; // attested credential data included
export const FLAG_ED = 0x80; // extension data included

/** Thrown for every refused credential; `code` says why (for logs and the audit trail, not the user). */
export class WebAuthnError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new WebAuthnError(code, message);
};

export const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** base64url (or plain base64) string → Buffer; anything else → fails with `code`. */
export function fromB64url(s, code = "format") {
  if (typeof s !== "string" || !/^[A-Za-z0-9_\-+/]*={0,2}$/.test(s)) fail(code, "not base64url");
  return Buffer.from(s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "base64url");
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest();

// ------------------------------------------------------------------ CBOR

/**
 * Minimal CBOR (RFC 8949) decoder for what WebAuthn uses: unsigned/negative
 * integers, byte and text strings, arrays, maps (returned as Map, since COSE
 * keys are integers), tags (unwrapped), false/true/null/undefined and floats.
 * Definite lengths only — CTAP2 canonical encoding never uses indefinite ones.
 * Returns { value, offset } where offset is just past the item.
 */
export function cborDecodeItem(buf, offset = 0, depth = 0) {
  if (depth > 16) fail("cbor", "CBOR nested too deeply");
  const need = (n) => {
    if (offset + n > buf.length) fail("cbor", "CBOR data is truncated");
  };
  need(1);
  const first = buf[offset++];
  const major = first >> 5;
  const info = first & 0x1f;

  let arg;
  if (info < 24) arg = info;
  else if (info === 24) { need(1); arg = buf[offset]; offset += 1; }
  else if (info === 25) { need(2); arg = buf.readUInt16BE(offset); offset += 2; }
  else if (info === 26) { need(4); arg = buf.readUInt32BE(offset); offset += 4; }
  else if (info === 27) {
    need(8);
    const big = buf.readBigUInt64BE(offset);
    offset += 8;
    if (major === 7) arg = big; // float64 bits, handled below
    else {
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) fail("cbor", "CBOR integer too large");
      arg = Number(big);
    }
  } else fail("cbor", "indefinite-length or reserved CBOR item");

  switch (major) {
    case 0:
      return { value: arg, offset };
    case 1:
      return { value: -1 - arg, offset };
    case 2:
      need(arg);
      return { value: Buffer.from(buf.subarray(offset, offset + arg)), offset: offset + arg };
    case 3:
      need(arg);
      return { value: buf.subarray(offset, offset + arg).toString("utf8"), offset: offset + arg };
    case 4: {
      if (arg > 10_000) fail("cbor", "CBOR array too long");
      const out = [];
      for (let i = 0; i < arg; i++) {
        const r = cborDecodeItem(buf, offset, depth + 1);
        out.push(r.value);
        offset = r.offset;
      }
      return { value: out, offset };
    }
    case 5: {
      if (arg > 10_000) fail("cbor", "CBOR map too long");
      const out = new Map();
      for (let i = 0; i < arg; i++) {
        const k = cborDecodeItem(buf, offset, depth + 1);
        const v = cborDecodeItem(buf, k.offset, depth + 1);
        if (out.has(k.value)) fail("cbor", "duplicate CBOR map key");
        out.set(k.value, v.value);
        offset = v.offset;
      }
      return { value: out, offset };
    }
    case 6:
      return cborDecodeItem(buf, offset, depth + 1); // tag: keep the content
    case 7: {
      if (info === 20) return { value: false, offset };
      if (info === 21) return { value: true, offset };
      if (info === 22) return { value: null, offset };
      if (info === 23) return { value: undefined, offset };
      if (info === 25) return { value: halfToFloat(arg), offset };
      if (info === 26) { const b = Buffer.alloc(4); b.writeUInt32BE(arg); return { value: b.readFloatBE(0), offset }; }
      if (info === 27) { const b = Buffer.alloc(8); b.writeBigUInt64BE(arg); return { value: b.readDoubleBE(0), offset }; }
      return { value: undefined, offset }; // other simple values: nothing we use
    }
    default:
      return fail("cbor", "bad CBOR major type");
  }
}

function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** Decode one CBOR item that must fill `buf` exactly. */
export function cborDecode(buf) {
  const { value, offset } = cborDecodeItem(Buffer.from(buf), 0);
  if (offset !== buf.length) fail("cbor", "trailing bytes after CBOR item");
  return value;
}

// ------------------------------------------------------ authenticatorData

/**
 * rpIdHash(32) ‖ flags(1) ‖ signCount(4, big-endian)
 *   [‖ aaguid(16) ‖ credIdLen(2) ‖ credId ‖ COSE key]   when AT is set
 *   [‖ extensions (CBOR map)]                          when ED is set
 */
export function parseAuthData(buf) {
  buf = Buffer.from(buf);
  if (buf.length < 37) fail("auth_data", "authenticator data is too short");
  const out = {
    rpIdHash: buf.subarray(0, 32),
    flags: buf[32],
    signCount: buf.readUInt32BE(33),
  };
  out.up = !!(out.flags & FLAG_UP);
  out.uv = !!(out.flags & FLAG_UV);
  out.be = !!(out.flags & FLAG_BE);
  out.bs = !!(out.flags & FLAG_BS);
  let offset = 37;
  if (out.flags & FLAG_AT) {
    if (buf.length < offset + 18) fail("auth_data", "attested credential data is truncated");
    out.aaguid = buf.subarray(offset, offset + 16).toString("hex");
    const len = buf.readUInt16BE(offset + 16);
    offset += 18;
    if (len < 16 || len > 1023 || buf.length < offset + len) fail("auth_data", "bad credential id length");
    out.credentialId = Buffer.from(buf.subarray(offset, offset + len));
    offset += len;
    const key = cborDecodeItem(buf, offset);
    if (!(key.value instanceof Map)) fail("auth_data", "credential public key is not a COSE map");
    out.coseKey = key.value;
    offset = key.offset;
  }
  if (out.flags & FLAG_ED) {
    const ext = cborDecodeItem(buf, offset);
    out.extensions = ext.value;
    offset = ext.offset;
  }
  if (offset !== buf.length) fail("auth_data", "unexpected bytes after authenticator data");
  return out;
}

// ------------------------------------------------------------- COSE keys

/** COSE_Key (Map) → { alg, jwk } for ES256 / RS256 / EdDSA; anything else is refused. */
export function coseToJwk(cose) {
  if (!(cose instanceof Map)) fail("key", "public key is not a COSE map");
  const kty = cose.get(1), alg = cose.get(3);
  const bytes = (label, len) => {
    const v = cose.get(label);
    if (!Buffer.isBuffer(v) || (len && v.length !== len)) fail("key", `bad COSE key parameter ${label}`);
    return v;
  };
  let jwk;
  if (alg === ALG.ES256) {
    if (kty !== 2 || cose.get(-1) !== 1) fail("key", "ES256 key must be EC2 on P-256");
    jwk = { kty: "EC", crv: "P-256", x: b64url(bytes(-2, 32)), y: b64url(bytes(-3, 32)) };
  } else if (alg === ALG.RS256) {
    if (kty !== 3) fail("key", "RS256 key must be RSA");
    const n = bytes(-1);
    if (n.length < 256) fail("key", "RSA keys must be at least 2048 bits");
    jwk = { kty: "RSA", n: b64url(n), e: b64url(bytes(-2)) };
  } else if (alg === ALG.EdDSA) {
    if (kty !== 1 || cose.get(-1) !== 6) fail("key", "EdDSA key must be OKP on Ed25519");
    jwk = { kty: "OKP", crv: "Ed25519", x: b64url(bytes(-2, 32)) };
  } else {
    fail("alg", `unsupported key algorithm ${alg}`);
  }
  try {
    publicKeyFromJwk(jwk); // proves the point is on the curve / the key parses
  } catch (err) {
    if (err instanceof WebAuthnError) throw err;
    fail("key", `public key does not load: ${err.message}`);
  }
  return { alg, jwk };
}

export function publicKeyFromJwk(jwk) {
  return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

/** Verify a WebAuthn signature: ES256 is DER-encoded ECDSA, RS256 PKCS#1 v1.5, EdDSA raw Ed25519. */
export function verifySignature(alg, jwk, data, signature) {
  let key;
  try {
    key = publicKeyFromJwk(jwk);
  } catch {
    return false;
  }
  try {
    if (alg === ALG.ES256) return crypto.verify("sha256", data, { key, dsaEncoding: "der" }, signature);
    if (alg === ALG.RS256) return crypto.verify("sha256", data, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, signature);
    if (alg === ALG.EdDSA) return crypto.verify(null, data, key, signature);
  } catch {
    return false; // malformed signature bytes
  }
  return false;
}

// ----------------------------------------------------------- clientData

/** Decode and parse clientDataJSON (base64url) — before verification, to find the challenge. */
export function readClientData(clientDataJSON) {
  const raw = fromB64url(clientDataJSON, "client_data");
  if (!raw.length || raw.length > 4096) fail("client_data", "clientDataJSON is empty or too large");
  let cd;
  try {
    cd = JSON.parse(raw.toString("utf8"));
  } catch {
    fail("client_data", "clientDataJSON is not JSON");
  }
  if (!cd || typeof cd !== "object" || typeof cd.challenge !== "string" || typeof cd.type !== "string" || typeof cd.origin !== "string") {
    fail("client_data", "clientDataJSON is missing fields");
  }
  return { raw, data: cd };
}

function checkClientData(cd, { type, expectedChallenge, expectedOrigins }) {
  if (cd.type !== type) fail("type", `expected ${type}, got ${cd.type}`);
  const want = Buffer.from(String(expectedChallenge));
  const got = Buffer.from(String(cd.challenge).replace(/=+$/, ""));
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) fail("challenge", "challenge does not match");
  const origins = (Array.isArray(expectedOrigins) ? expectedOrigins : [expectedOrigins]).filter(Boolean);
  if (!origins.includes(cd.origin)) fail("origin", `origin ${cd.origin} is not this panel`);
  if (cd.crossOrigin === true) fail("origin", "cross-origin (iframe) ceremonies are refused");
}

function checkAuthFlags(auth, { rpId, requireUV }) {
  const want = sha256(Buffer.from(String(rpId), "utf8"));
  if (!crypto.timingSafeEqual(want, auth.rpIdHash)) fail("rp_id", "credential is for a different relying party");
  if (!auth.up) fail("user_presence", "the authenticator did not confirm a person was present");
  if (requireUV && !auth.uv) fail("user_verification", "the authenticator did not verify the user (PIN / biometric)");
}

// ----------------------------------------------------------- ceremonies

/**
 * Registration (navigator.credentials.create) → the credential to store.
 *   credential: { id, rawId?, type?, response: { clientDataJSON, attestationObject, transports? } } (base64url strings)
 * Returns { credentialId (base64url), alg, jwk, signCount, aaguid, uv, be, bs, fmt, transports }.
 */
export function verifyRegistration({ credential, expectedChallenge, expectedOrigins, rpId, requireUV = true, algs = SUPPORTED_ALGS }) {
  const r = credential?.response;
  if (!r || typeof r !== "object") fail("format", "credential response is missing");
  if (credential.type !== undefined && credential.type !== "public-key") fail("format", "not a public-key credential");
  const { data: cd } = readClientData(r.clientDataJSON);
  checkClientData(cd, { type: "webauthn.create", expectedChallenge, expectedOrigins });

  const attObj = cborDecode(fromB64url(r.attestationObject, "attestation"));
  if (!(attObj instanceof Map) || !Buffer.isBuffer(attObj.get("authData")) || typeof attObj.get("fmt") !== "string") {
    fail("attestation", "attestationObject is malformed");
  }
  const auth = parseAuthData(attObj.get("authData"));
  checkAuthFlags(auth, { rpId, requireUV });
  if (!auth.credentialId || !auth.coseKey) fail("attestation", "no attested credential data");
  const idGiven = credential.rawId ?? credential.id;
  if (idGiven !== undefined && !fromB64url(String(idGiven), "format").equals(auth.credentialId)) fail("format", "credential id does not match the authenticator data");

  const { alg, jwk } = coseToJwk(auth.coseKey);
  if (!algs.includes(alg)) fail("alg", `algorithm ${alg} was not offered`);
  const transports = Array.isArray(r.transports) ? r.transports.filter((t) => typeof t === "string" && /^[a-z-]{1,20}$/.test(t)).slice(0, 8) : [];
  return {
    credentialId: b64url(auth.credentialId),
    alg,
    jwk,
    signCount: auth.signCount,
    aaguid: auth.aaguid,
    uv: auth.uv,
    be: auth.be,
    bs: auth.bs,
    fmt: attObj.get("fmt"),
    transports,
  };
}

/**
 * Sign-in (navigator.credentials.get) against a stored credential
 * { alg, jwk, signCount, userHandle? }.
 *   credential: { id, response: { clientDataJSON, authenticatorData, signature, userHandle? } }
 * Returns { signCount, counterRegression, uv, be, bs }.
 */
export function verifyAssertion({ credential, stored, expectedChallenge, expectedOrigins, rpId, requireUV = true }) {
  const r = credential?.response;
  if (!r || typeof r !== "object") fail("format", "credential response is missing");
  const { raw: cdRaw, data: cd } = readClientData(r.clientDataJSON);
  checkClientData(cd, { type: "webauthn.get", expectedChallenge, expectedOrigins });
  const authRaw = fromB64url(r.authenticatorData, "auth_data");
  const auth = parseAuthData(authRaw);
  checkAuthFlags(auth, { rpId, requireUV });

  if (r.userHandle && stored.userHandle) {
    const uh = fromB64url(String(r.userHandle), "format");
    if (!uh.equals(fromB64url(stored.userHandle))) fail("user_handle", "the passkey belongs to a different account");
  }
  const signature = fromB64url(r.signature, "signature");
  const signed = Buffer.concat([authRaw, sha256(cdRaw)]);
  if (!verifySignature(stored.alg, stored.jwk, signed, signature)) fail("signature", "signature does not verify");

  // §7.2 step 21: if either counter is non-zero, the new one must be larger.
  const prev = Number(stored.signCount) || 0;
  const counterRegression = (auth.signCount !== 0 || prev !== 0) && auth.signCount <= prev;
  return { signCount: auth.signCount, counterRegression, uv: auth.uv, be: auth.be, bs: auth.bs };
}

// ----------------------------------------------------------- challenges

/**
 * Single-use challenges, in memory. issue() returns the base64url challenge;
 * take() returns its record once (and forgets it), or null when unknown,
 * already used or expired. Bounded: at most `perKey` outstanding per binding
 * key (the session) and `max` overall; the oldest go first.
 */
export class ChallengeStore {
  constructor({ ttlMs = 5 * 60 * 1000, max = 5000, perKey = 5, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.perKey = perKey;
    this.now = now;
    this.items = new Map(); // challenge -> record (insertion order = age)
  }

  issue(binding = {}) {
    this.prune();
    const key = binding.sessionKey || "";
    const mine = [...this.items].filter(([, r]) => r.sessionKey === key);
    for (const [c] of mine.slice(0, Math.max(0, mine.length - this.perKey + 1))) this.items.delete(c);
    while (this.items.size >= this.max) this.items.delete(this.items.keys().next().value);
    const challenge = b64url(crypto.randomBytes(32));
    this.items.set(challenge, { ...binding, challenge, exp: this.now() + this.ttlMs });
    return challenge;
  }

  take(challenge) {
    const c = String(challenge || "").replace(/=+$/, "");
    const rec = this.items.get(c);
    if (!rec) return null;
    this.items.delete(c);
    return rec.exp > this.now() ? rec : null;
  }

  prune() {
    const t = this.now();
    for (const [c, r] of this.items) if (r.exp <= t) this.items.delete(c);
  }
}

// ------------------------------------------------------ relying party

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
export const isIpHost = (hostname) => IPV4.test(hostname) || hostname.includes(":") || /^\[.*\]$/.test(hostname);
export const isLocalhost = (hostname) => hostname === "localhost" || hostname.endsWith(".localhost");

/** Can a browser use passkeys on this origin? (secure context, and a domain name: an IP can't be an rpId) */
export function passkeyCapable(u) {
  if (!u) return false;
  if (isIpHost(u.hostname)) return false;
  return u.protocol === "https:" || (u.protocol === "http:" && isLocalhost(u.hostname));
}

/**
 * Which relying party a request should use.
 *   here      the origin the browser is on (proto://host as the panel sees it)
 *   panelUrl  config.panelUrl / FCC_PANEL_URL, or ""
 * → { ok: true, rpId, origin } or { ok: false, reason: "other_host"|"insecure"|"ip", here, panelUrl? }
 *
 * One rpId everywhere is what makes passkeys work on every panel node after a
 * failover (they all serve the same panel URL, and config.json replicates),
 * so when the panel URL can carry passkeys it is the only place they are made
 * and used. localhost always works (dev, or an SSH tunnel when the panel URL
 * itself is broken): only someone on the server can open it.
 */
export function relyingParty(here, panelUrl) {
  let h = null, p = null;
  try { h = new URL(here); } catch { /* unusable */ }
  try { p = panelUrl ? new URL(panelUrl) : null; } catch { /* unusable */ }
  if (h && /^https?:$/.test(h.protocol) && isLocalhost(h.hostname)) return { ok: true, rpId: h.hostname, origin: h.origin };
  if (p && passkeyCapable(p)) {
    if (h && h.host.toLowerCase() === p.host.toLowerCase()) return { ok: true, rpId: p.hostname.toLowerCase(), origin: p.origin };
    return { ok: false, reason: "other_host", here: h?.origin || "", panelUrl: p.origin };
  }
  if (h && passkeyCapable(h)) return { ok: true, rpId: h.hostname.toLowerCase(), origin: h.origin };
  return { ok: false, reason: h && isIpHost(h.hostname) ? "ip" : "insecure", here: h?.origin || "", panelUrl: p ? p.origin : "" };
}
