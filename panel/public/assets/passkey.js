// Passkeys in the browser: the login page's passkey step (auth.js) and Settings → Passkeys
// (views/settings-security.js). The server half is panel/lib/passkeys.mjs + webauthn.mjs.
// Options arrive as JSON with base64url strings; WebAuthn wants ArrayBuffers, and the
// answer goes back as base64url again.
import { post } from "./api.js";

const toBuf = (s) => {
  const b = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out.buffer;
};
const toB64url = (buf) => {
  if (!buf) return null;
  let s = "";
  for (const x of new Uint8Array(buf)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const IP = /^(\d{1,3}(\.\d{1,3}){3}|\[.*\])$/;

/**
 * Can this page use passkeys at all? { ok } or { ok: false, message }.
 * The server says the same (rp.ok) with the panel URL in hand; this catches the browser side.
 */
export function browserSupport() {
  if (!window.isSecureContext) return { ok: false, reason: "insecure", message: "Passkeys need a secure (HTTPS) connection to the panel." };
  if (IP.test(location.hostname)) return { ok: false, reason: "ip", message: "Passkeys need the panel's HTTPS address (a domain name, not an IP address)." };
  if (!window.PublicKeyCredential || !navigator.credentials?.create) return { ok: false, reason: "browser", message: "This browser doesn't support passkeys. Use a current Safari, Chrome, Edge or Firefox." };
  return { ok: true };
}

/** "Mac · Safari", "iPhone · Safari", "Windows · Edge"… — the suggested name of a new passkey. */
export function defaultPasskeyName() {
  const ua = navigator.userAgent || "";
  const platform = navigator.userAgentData?.platform || "";
  const device = /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "iPad"
      : /Android/.test(ua) ? "Android"
        : /Mac/.test(platform) || /Macintosh/.test(ua) ? "Mac"
          : /Win/.test(platform) || /Windows/.test(ua) ? "Windows"
            : /CrOS/.test(ua) ? "Chromebook"
              : /Linux/.test(platform) || /Linux/.test(ua) ? "Linux" : "This device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) || /CriOS/.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return browser ? `${device} · ${browser}` : device;
}

/** A WebAuthn DOMException → a sentence for people. */
export function passkeyErrorMessage(e, kind = "get") {
  const n = e?.name || "";
  if (n === "NotAllowedError" || n === "AbortError") return kind === "create"
    ? "The passkey wasn't created — the prompt was closed or timed out. Try again when you're ready."
    : "No passkey was used — the prompt was closed or timed out. Try again when you're ready.";
  if (n === "InvalidStateError") return "This device (or password manager) already has a passkey for your account here. Use it, or add the backup on another device or a security key.";
  if (n === "SecurityError") return "This address can't use passkeys. Open the panel at its HTTPS address.";
  if (n === "NotSupportedError") return "This device can't make a passkey the panel accepts. Try another device or a security key.";
  return e?.message || "Something went wrong with the passkey prompt.";
}

function credentialJSON(c) {
  const r = c.response;
  const out = { id: c.id, rawId: toB64url(c.rawId), type: c.type, response: { clientDataJSON: toB64url(r.clientDataJSON) } };
  if (r.attestationObject) {
    out.response.attestationObject = toB64url(r.attestationObject);
    try { out.response.transports = r.getTransports?.() || []; } catch { out.response.transports = []; }
  }
  if (r.authenticatorData) {
    out.response.authenticatorData = toB64url(r.authenticatorData);
    out.response.signature = toB64url(r.signature);
    out.response.userHandle = toB64url(r.userHandle);
  }
  return out;
}

/** Create a passkey (options → browser prompt → stored). Resolves with the server's answer. */
export async function addPasskey(name) {
  const { publicKey: o } = await post("/api/auth/passkey/register/options", {});
  const publicKey = {
    ...o,
    challenge: toBuf(o.challenge),
    user: { ...o.user, id: toBuf(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) })),
  };
  let cred;
  try { cred = await navigator.credentials.create({ publicKey }); }
  catch (e) { throw Object.assign(new Error(passkeyErrorMessage(e, "create")), { cancelled: e?.name === "NotAllowedError" }); }
  return post("/api/auth/passkey/register", { credential: credentialJSON(cred), name });
}

/** Confirm with a passkey (the second sign-in step). */
export async function confirmPasskey() {
  const { publicKey: o } = await post("/api/auth/passkey/verify/options", {});
  const publicKey = { ...o, challenge: toBuf(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) })) };
  let cred;
  try { cred = await navigator.credentials.get({ publicKey }); }
  catch (e) { throw Object.assign(new Error(passkeyErrorMessage(e, "get")), { cancelled: e?.name === "NotAllowedError" }); }
  return post("/api/auth/passkey/verify", { credential: credentialJSON(cred) });
}
