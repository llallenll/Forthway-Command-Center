/**
 * The passkey step of signing in, and passkey management. Registered by
 * core-routes (CORE, never optional: without it nobody could finish signing in).
 *
 * Signing in is two steps. GitHub (or the dev / password / recovery sign-in)
 * leaves a PENDING session (lib/auth.mjs); every admin route, page and the
 * event stream refuse it. The admin then either
 *   - confirms with one of their passkeys (navigator.credentials.get), or
 *   - has none yet — every admin from before passkeys — and adds one
 *     (navigator.credentials.create); creating it proves the same thing,
 * and the session becomes FULL. The login page (assets/auth.js) drives it.
 *
 * Routes — the /api/auth/passkey* ones are `public` for the Router and check
 * the session (pending or full) themselves; the rest need a full session:
 *   GET    /api/auth/passkey                 state of this browser's session
 *   POST   /api/auth/passkey/register/options   → { publicKey } for create()
 *   POST   /api/auth/passkey/register        { credential, name } → stored; pending → full
 *   POST   /api/auth/passkey/verify/options  → { publicKey } for get()
 *   POST   /api/auth/passkey/verify          { credential } → pending → full
 *   GET    /api/me/passkeys                  PATCH|DELETE /api/me/passkeys/:id
 *   GET    /api/passkeys/admins              every admin's passkey count
 *   DELETE /api/admins/:id/passkeys          owner: remove someone else's (they enrol again)
 *
 * Choices:
 *   - userVerification "required": GitHub is the first factor; the passkey
 *     must add "something you are / know" (Touch ID, Windows Hello, device
 *     PIN, security-key PIN), not just "a device someone is holding". Every
 *     platform passkey does UV; a security key without a PIN gets one set up
 *     by the browser. The server refuses an assertion without the UV flag.
 *   - residentKey "preferred": discoverable when the device can, but a plain
 *     security key still works (the admin is known from GitHub, so sign-in
 *     lists their credential ids — nothing depends on discoverability).
 *   - attestation "none": see webauthn.mjs.
 *   - The relying party is the panel URL's hostname (webauthn.relyingParty),
 *     so the same passkeys work on whichever panel node is active after a
 *     failover. Passkeys live in db.json (collection `passkeys`), which
 *     replicates to standby panels with the admins; challenges live only in
 *     the active panel's memory (a failover mid-ceremony just means "try again").
 *   - Throttle: 5 failed checks per session and 10 per admin in 15 minutes.
 *   - Removing a passkey ends the admin's other sessions (a lost laptop is
 *     the usual reason); the owner's reset and `recover.mjs --reset-passkeys`
 *     end all of them and the admin adds a new passkey at the next sign-in.
 *   - Nobody removes their own last passkey from inside the panel.
 */

import { httpError } from "./http.mjs";
import { LoginThrottle, PASSKEYS, publicAdmin, requestHost, requestIp, requestProto } from "./auth.mjs";
import {
  ChallengeStore, SUPPORTED_ALGS, WebAuthnError, readClientData, relyingParty, verifyAssertion, verifyRegistration,
} from "./webauthn.mjs";
import crypto from "node:crypto";

const CEREMONY_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_PER_ADMIN = 20;
export const RECOVER_CMD = "sudo node /opt/fcc/panel/recover.mjs --reset-passkeys";

function clean(value, max = 200) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

/** Public sign-in POSTs have no full session, so refuse cross-site ones here (as login.mjs does). */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host = null;
  try {
    host = new URL(origin).host;
  } catch { /* "null" or garbage */ }
  if (host !== req.headers.host) throw httpError(403, "Cross-origin request refused.");
}

export function registerPasskeys(router, ctx) {
  const { db, config } = ctx;
  const auth = ctx.auth;
  const challenges = new ChallengeStore({ ttlMs: CEREMONY_TIMEOUT_MS });
  const perSession = new LoginThrottle({ maxAttempts: 5, windowMs: 15 * 60 * 1000 });
  const perAdmin = new LoginThrottle({ maxAttempts: 10, windowMs: 15 * 60 * 1000 });

  const listFor = (adminId) => db.list(PASSKEYS, (p) => p.adminId === adminId).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const target = (admin) => ({ type: "admin", id: admin.id, name: admin.name || admin.github?.login || admin.email });

  /** Relying party for this request (see webauthn.relyingParty), plus what the UI needs to explain a refusal. */
  function rpFor(req) {
    const here = `${requestProto(req, config)}://${requestHost(req)}`;
    const fixed = String(config.panelUrl || process.env.FCC_PANEL_URL || "").replace(/\/+$/, "");
    return relyingParty(here, fixed);
  }
  function rpView(rp) {
    if (rp.ok) return { ok: true, rpId: rp.rpId, origin: rp.origin };
    const message = rp.reason === "other_host"
      ? `Passkeys work on the panel's own address. Open ${rp.panelUrl} to continue.`
      : rp.reason === "ip"
        ? "Passkeys need the panel's HTTPS address (a domain name, not an IP address)."
        : "Passkeys need a secure (HTTPS) connection to the panel.";
    return { ok: false, reason: rp.reason, message, panelUrl: rp.panelUrl || "", here: rp.here || "" };
  }
  function requireRp(req) {
    const rp = rpFor(req);
    if (!rp.ok) throw httpError(400, rpView(rp).message, { code: "passkey_origin", rp: rpView(rp) });
    return rp;
  }

  /** The session behind a /api/auth/passkey* request (pending or full), or 401 signed_out. */
  function session(req) {
    const info = auth.sessionInfo(req);
    if (!info) throw httpError(401, "Your sign-in has expired. Sign in again.", { code: "signed_out" });
    return info;
  }

  function view(p, currentId = null) {
    return {
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      lastUsedAt: p.lastUsedAt || null,
      rpId: p.rpId,
      synced: !!p.be, // multi-device (iCloud Keychain, Google Password Manager…) vs. one device / security key
      backedUp: !!p.bs,
      transports: p.transports || [],
      counterWarning: !!p.counterWarningAt,
      current: p.id === currentId,
    };
  }

  /** Stable per-admin user handle for create(): random, stored on their first passkey. */
  function userHandleFor(adminId) {
    const existing = listFor(adminId).find((p) => p.userHandle);
    return existing ? existing.userHandle : crypto.randomBytes(16).toString("base64url");
  }

  function throttled(info) {
    const s = perSession.check(`s:${info.sid}`), a = perAdmin.check(`a:${info.admin.id}`);
    if (s.allowed && a.allowed) return null;
    return Math.max(s.retryAfterMs || 0, a.retryAfterMs || 0);
  }
  function refuseThrottled(res, ms) {
    const minutes = Math.max(1, Math.ceil(ms / 60000));
    res.setHeader("Retry-After", String(Math.ceil(ms / 1000)));
    throw httpError(429, `Too many failed passkey attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, or sign out and back in.`, { code: "throttled" });
  }

  /** A refused credential: count it, audit it, and answer in plain words. */
  function refuse(req, info, step, err) {
    perSession.fail(`s:${info.sid}`);
    perAdmin.fail(`a:${info.admin.id}`);
    const reason = err instanceof WebAuthnError ? err.code : err?.code || "error";
    console.warn(`[fcc] passkey ${step} refused for ${info.admin.name || info.admin.id} (${reason}: ${err?.message || ""}) from ${requestIp(req)}`);
    ctx.activity(info.admin, "admin.passkey.fail", target(info.admin), { step, reason, ip: requestIp(req) });
    const msg = reason === "challenge"
      ? "That passkey prompt expired or was already used. Try again."
      : reason === "origin" || reason === "rp_id"
        ? "That passkey answer came from a different address than this panel's. Open the panel at its usual address and try again."
        : reason === "user_verification"
          ? "Your device didn't confirm it was you (fingerprint, face or PIN). Try again and complete that check."
          : reason === "unknown"
            ? "That passkey isn't registered to your account on this panel. Pick a different one."
            : step === "register"
              ? "That passkey couldn't be added. Try again."
              : "That passkey didn't check out. Try again.";
    return httpError(400, msg, { code: "passkey_failed", reason });
  }

  // ------------------------------------------------------------ state

  router.get("/api/auth/passkey", { public: true }, (req) => {
    const info = session(req);
    const a = info.admin;
    const mine = listFor(a.id);
    const rp = rpFor(req);
    const usable = rp.ok ? mine.filter((p) => p.rpId === rp.rpId).length : 0;
    return {
      state: info.full ? "full" : "pending",
      needs: info.full ? null : mine.length ? "verify" : "setup",
      admin: { name: a.name || "", login: a.github?.login || "", avatarUrl: a.github?.avatarUrl || "", role: a.role },
      passkeys: mine.length,
      usableHere: usable,
      // Hosts their passkeys were made on, when none of them works on this one.
      otherHosts: rp.ok && mine.length && !usable ? [...new Set(mine.map((p) => p.rpId))] : [],
      rp: rpView(rp),
      recoverCmd: RECOVER_CMD,
    };
  });

  // ----------------------------------------------------- registration

  router.post("/api/auth/passkey/register/options", { public: true }, (req, res) => {
    sameOrigin(req);
    const info = session(req);
    const a = info.admin;
    const mine = listFor(a.id);
    if (!info.full && mine.length) throw httpError(403, "Confirm it's you with one of your passkeys first.", { code: "passkey_required" });
    if (mine.length >= MAX_PER_ADMIN) throw httpError(400, `You already have ${MAX_PER_ADMIN} passkeys. Remove one you no longer use first.`);
    const wait = throttled(info);
    if (wait) refuseThrottled(res, wait);
    const rp = requireRp(req);
    const userHandle = userHandleFor(a.id);
    const challenge = challenges.issue({ kind: "create", adminId: a.id, sessionKey: info.sid, rpId: rp.rpId, origin: rp.origin, userHandle });
    const label = a.github?.login ? `@${a.github.login}` : a.email || a.name || "admin";
    return {
      publicKey: {
        rp: { id: rp.rpId, name: clean(config.panelName, 60) || "Forthway Command Center" },
        user: { id: userHandle, name: label, displayName: a.name || label },
        challenge,
        pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: "public-key", alg })),
        timeout: CEREMONY_TIMEOUT_MS,
        attestation: "none",
        authenticatorSelection: { residentKey: "preferred", requireResidentKey: false, userVerification: "required" },
        // Don't make a second passkey on a device that already has one for this admin.
        excludeCredentials: mine.filter((p) => p.rpId === rp.rpId).map((p) => ({ type: "public-key", id: p.credentialId, transports: p.transports || [] })),
      },
    };
  });

  router.post("/api/auth/passkey/register", { public: true, limit: 64 * 1024 }, (req, res, { body }) => {
    sameOrigin(req);
    const info = session(req);
    const a = info.admin;
    const wait = throttled(info);
    if (wait) refuseThrottled(res, wait);
    let rec, out;
    try {
      const { data } = readClientData(body.credential?.response?.clientDataJSON);
      rec = challenges.take(data.challenge);
      if (!rec || rec.kind !== "create" || rec.adminId !== a.id || rec.sessionKey !== info.sid) throw new WebAuthnError("challenge", "unknown, used or foreign challenge");
      out = verifyRegistration({ credential: body.credential, expectedChallenge: rec.challenge, expectedOrigins: [rec.origin], rpId: rec.rpId, requireUV: true });
    } catch (err) {
      throw refuse(req, info, "register", err);
    }
    // Checked again now: another tab may have added the first passkey meanwhile.
    const mine = listFor(a.id);
    if (!info.full && mine.length) throw httpError(403, "Confirm it's you with one of your passkeys first.", { code: "passkey_required" });
    if (db.list(PASSKEYS, (p) => p.credentialId === out.credentialId).length) throw httpError(409, "That passkey is already registered.");
    const pk = db.insert(PASSKEYS, {
      id: db.newId("pk"),
      adminId: a.id,
      name: clean(body.name, 60) || "Passkey",
      credentialId: out.credentialId,
      alg: out.alg,
      jwk: out.jwk,
      signCount: out.signCount,
      userHandle: rec.userHandle,
      rpId: rec.rpId,
      aaguid: out.aaguid,
      be: out.be,
      bs: out.bs,
      transports: out.transports,
      lastUsedAt: info.full ? null : new Date().toISOString(),
    });
    db.save({ immediate: true });
    perSession.succeed(`s:${info.sid}`);
    ctx.activity(a, "admin.passkey.add", target(a), { passkey: pk.name, ip: requestIp(req), atSignIn: !info.full, synced: !!out.be });
    // The first passkey, made in a pending session, completes the sign-in.
    if (!info.full) {
      perAdmin.succeed(`a:${a.id}`);
      auth.setSession(res, req, a, { passkey: pk.id });
    }
    return { ok: true, state: "full", passkey: view(pk, info.full ? info.passkeyId : pk.id), passkeys: listFor(a.id).length };
  });

  // ---------------------------------------------------------- sign-in

  router.post("/api/auth/passkey/verify/options", { public: true }, (req, res) => {
    sameOrigin(req);
    const info = session(req);
    const a = info.admin;
    const mine = listFor(a.id);
    if (!mine.length) throw httpError(409, "You don't have a passkey yet. Add one to finish signing in.", { code: "passkey_setup_required" });
    const wait = throttled(info);
    if (wait) refuseThrottled(res, wait);
    const rp = requireRp(req);
    const here = mine.filter((p) => p.rpId === rp.rpId);
    if (!here.length) {
      const hosts = [...new Set(mine.map((p) => p.rpId))];
      throw httpError(409, `Your passkeys were made for ${hosts.join(", ")}. Open the panel at that address to sign in.`, { code: "passkey_other_host", hosts });
    }
    const challenge = challenges.issue({ kind: "get", adminId: a.id, sessionKey: info.sid, rpId: rp.rpId, origin: rp.origin });
    return {
      publicKey: {
        challenge,
        rpId: rp.rpId,
        timeout: CEREMONY_TIMEOUT_MS,
        userVerification: "required",
        allowCredentials: here.map((p) => ({ type: "public-key", id: p.credentialId, transports: p.transports || [] })),
      },
    };
  });

  router.post("/api/auth/passkey/verify", { public: true, limit: 64 * 1024 }, (req, res, { body }) => {
    sameOrigin(req);
    const info = session(req);
    const a = info.admin;
    if (info.full) return { ok: true, state: "full" };
    const wait = throttled(info);
    if (wait) {
      ctx.activity(a, "admin.passkey.throttled", target(a), { ip: requestIp(req) });
      refuseThrottled(res, wait);
    }
    let pk, out;
    try {
      const { data } = readClientData(body.credential?.response?.clientDataJSON);
      const rec = challenges.take(data.challenge);
      if (!rec || rec.kind !== "get" || rec.adminId !== a.id || rec.sessionKey !== info.sid) throw new WebAuthnError("challenge", "unknown, used or foreign challenge");
      const id = String(body.credential?.rawId || body.credential?.id || "").replace(/=+$/, "");
      pk = db.list(PASSKEYS, (p) => p.adminId === a.id && p.credentialId === id && p.rpId === rec.rpId)[0];
      if (!pk) throw new WebAuthnError("unknown", "credential is not one of this admin's passkeys");
      out = verifyAssertion({ credential: body.credential, stored: pk, expectedChallenge: rec.challenge, expectedOrigins: [rec.origin], rpId: rec.rpId, requireUV: true });
    } catch (err) {
      throw refuse(req, info, "verify", err);
    }
    const now = new Date().toISOString();
    const patch = { signCount: Math.max(out.signCount, Number(pk.signCount) || 0), lastUsedAt: now, bs: out.bs };
    if (out.counterRegression) {
      // Possibly a cloned authenticator — or a device that reset. Not refused (see webauthn.mjs), but on the record.
      patch.counterWarningAt = now;
      console.warn(`[fcc] passkey "${pk.name}" of ${a.name || a.id}: signature counter went backwards (${pk.signCount} → ${out.signCount})`);
      ctx.activity(a, "admin.passkey.counter", target(a), { passkey: pk.name, stored: pk.signCount, received: out.signCount, ip: requestIp(req) });
    }
    db.update(PASSKEYS, pk.id, patch);
    db.save({ immediate: true });
    perSession.succeed(`s:${info.sid}`);
    perAdmin.succeed(`a:${a.id}`);
    auth.setSession(res, req, a, { passkey: pk.id });
    ctx.activity(a, "admin.passkey.verify", target(a), { passkey: pk.name, ip: requestIp(req) });
    return { ok: true, state: "full" };
  });

  // ------------------------------------------------- your own passkeys

  const getMine = (admin, id) => {
    const p = db.get(PASSKEYS, id);
    if (!p || p.adminId !== admin.id) throw httpError(404, "Passkey not found.");
    return p;
  };

  router.get("/api/me/passkeys", (req, res, { admin }) => {
    const current = auth.sessionInfo(req)?.passkeyId || null;
    const items = listFor(admin.id).map((p) => view(p, current));
    return { items, rp: rpView(rpFor(req)), canRemove: items.length > 1, recoverCmd: RECOVER_CMD };
  });

  router.patch("/api/me/passkeys/:id", (req, res, { admin, params, body }) => {
    const p = getMine(admin, params.id);
    const name = clean(body.name, 60);
    if (!name) throw httpError(400, "Give the passkey a name.");
    if (name !== p.name) {
      db.update(PASSKEYS, p.id, { name });
      ctx.activity(admin, "admin.passkey.rename", target(admin), { passkey: name, was: p.name });
    }
    return view(db.get(PASSKEYS, p.id), auth.sessionInfo(req)?.passkeyId);
  });

  router.delete("/api/me/passkeys/:id", (req, res, { admin, params }) => {
    const p = getMine(admin, params.id);
    if (listFor(admin.id).length <= 1) {
      throw httpError(400, "This is your only passkey, so it can't be removed — you'd have no way to finish signing in. Add another one first.");
    }
    const current = auth.sessionInfo(req)?.passkeyId;
    db.remove(PASSKEYS, p.id);
    // Your other sessions end (that device may be lost); this browser carries on.
    const updated = auth.bumpSessions(admin.id);
    db.save({ immediate: true });
    auth.setSession(res, req, updated, { passkey: current === p.id ? listFor(admin.id)[0].id : current });
    ctx.activity(admin, "admin.passkey.remove", target(admin), { passkey: p.name });
    return { ok: true };
  });

  // ------------------------------------------------ everybody's (owner)

  router.get("/api/passkeys/admins", (req, res, { admin }) => ({
    canReset: admin.role === "owner",
    items: db.list("admins").sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1)).map((a) => {
      const list = listFor(a.id);
      const used = list.map((p) => p.lastUsedAt).filter(Boolean).sort();
      return { ...publicAdmin(a), passkeys: list.length, lastUsedAt: used[used.length - 1] || null, counterWarning: list.some((p) => p.counterWarningAt) };
    }),
  }));

  router.delete("/api/admins/:id/passkeys", (req, res, { admin, params }) => {
    if (admin.role !== "owner") throw httpError(403, "Only an owner can remove another admin's passkeys.");
    const t = db.get("admins", params.id);
    if (!t) throw httpError(404, "Admin not found.");
    if (t.id === admin.id) throw httpError(400, "Manage your own passkeys in the list above — your last one can't be removed from inside the panel.");
    const removed = reset(t.id, { by: admin, via: "owner" });
    return { ok: true, removed };
  });

  /**
   * Remove every passkey of an admin and end all their sessions; they add a
   * new passkey at their next sign-in. Used by the owner (above) and by the
   * break-glass link from `recover.mjs --reset-passkeys` (login.mjs).
   */
  function reset(adminId, { by = null, via = "owner" } = {}) {
    const t = db.get("admins", adminId);
    if (!t) return 0;
    const removed = db.removeWhere(PASSKEYS, (p) => p.adminId === adminId);
    auth.bumpSessions(adminId);
    db.save({ immediate: true });
    perAdmin.succeed(`a:${adminId}`);
    ctx.activity(by, "admin.passkey.reset", target(t), { count: removed.length, via });
    console.log(`[fcc] passkeys of ${t.name || t.id} reset (${removed.length} removed, via ${via})`);
    return removed.length;
  }

  ctx.passkeys = { reset, count: (adminId) => listFor(adminId).length, rpFor: (req) => rpView(rpFor(req)) };
}
