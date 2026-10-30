// Passkey (WebAuthn) verification: real key pairs from node:crypto play the
// authenticator, through a full register + sign-in, plus every refusal the
// panel relies on. Run: node --test scripts/
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  ALG, ChallengeStore, WebAuthnError, cborDecode, parseAuthData, readClientData, relyingParty,
  verifyAssertion, verifyRegistration,
} from "../panel/lib/webauthn.mjs";

// ------------------------------------------------- a software authenticator

/** Tiny CBOR encoder (just what an authenticator emits). */
function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
    if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const s = Buffer.from(v, "utf8"); return Buffer.concat([head(3, s.length), s]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("cbor: unsupported");
}

const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const b64u = (b) => Buffer.from(b).toString("base64url");

function makeKey(kind) {
  if (kind === "es256") {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const j = publicKey.export({ format: "jwk" });
    const cose = new Map([[1, 2], [3, ALG.ES256], [-1, 1], [-2, Buffer.from(j.x, "base64url")], [-3, Buffer.from(j.y, "base64url")]]);
    return { alg: ALG.ES256, cose, sign: (data) => crypto.sign("sha256", data, privateKey) };
  }
  if (kind === "rs256") {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const j = publicKey.export({ format: "jwk" });
    const cose = new Map([[1, 3], [3, ALG.RS256], [-1, Buffer.from(j.n, "base64url")], [-2, Buffer.from(j.e, "base64url")]]);
    return { alg: ALG.RS256, cose, sign: (data) => crypto.sign("sha256", data, { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }) };
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const j = publicKey.export({ format: "jwk" });
  const cose = new Map([[1, 1], [3, ALG.EdDSA], [-1, 6], [-2, Buffer.from(j.x, "base64url")]]);
  return { alg: ALG.EdDSA, cose, sign: (data) => crypto.sign(null, data, privateKey) };
}

/** A passkey on a fake device: create() and get() answer like navigator.credentials. */
function softAuthenticator(kind = "es256", { uv = true, counter = 0 } = {}) {
  const key = makeKey(kind);
  const credId = crypto.randomBytes(32);
  let count = counter;
  const userHandle = crypto.randomBytes(16);
  const flags = (extra) => 0x01 | (uv ? 0x04 : 0) | 0x08 | 0x10 | extra;
  const counterBuf = () => { const b = Buffer.alloc(4); b.writeUInt32BE(count); return b; };
  return {
    key,
    credId,
    setCounter(n) { count = n; },
    create({ challenge, origin, rpId, type = "webauthn.create", rpIdForHash = rpId }) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([sha256(Buffer.from(rpIdForHash)), Buffer.from([flags(0x40)]), counterBuf(), Buffer.alloc(16), len, credId, cbor(key.cose)]);
      const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
      return { id: b64u(credId), rawId: b64u(credId), type: "public-key", response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal", "hybrid"] } };
    },
    get({ challenge, origin, rpId, type = "webauthn.get", rpIdForHash = rpId, tamper = false }) {
      if (count) count++;
      const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
      const authData = Buffer.concat([sha256(Buffer.from(rpIdForHash)), Buffer.from([flags(0)]), counterBuf()]);
      let sig = key.sign(Buffer.concat([authData, sha256(clientDataJSON)]));
      if (tamper) { sig = Buffer.from(sig); sig[sig.length - 1] ^= 0xff; }
      return { id: b64u(credId), rawId: b64u(credId), type: "public-key", response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(sig), userHandle: b64u(userHandle) } };
    },
    userHandle: b64u(userHandle),
  };
}

const RP = "panel.example.com";
const ORIGIN = "https://panel.example.com";

function register(dev, store, { binding = { kind: "create", sessionKey: "s1" }, ...over } = {}) {
  const challenge = store.issue(binding);
  const cred = dev.create({ challenge, origin: ORIGIN, rpId: RP, ...over });
  const { data } = readClientData(cred.response.clientDataJSON);
  const rec = store.take(data.challenge);
  if (!rec) throw new WebAuthnError("challenge", "unknown challenge");
  const out = verifyRegistration({ credential: cred, expectedChallenge: rec.challenge, expectedOrigins: [ORIGIN], rpId: RP });
  return { ...out, userHandle: dev.userHandle };
}

function signIn(dev, stored, store, opts = {}) {
  const challenge = store.issue({ kind: "get", sessionKey: "s1" });
  const cred = dev.get({ challenge: opts.challenge || challenge, origin: opts.origin || ORIGIN, rpId: RP, ...opts });
  const { data } = readClientData(cred.response.clientDataJSON);
  const rec = store.take(data.challenge);
  if (!rec) throw new WebAuthnError("challenge", "unknown or used challenge");
  return { cred, result: verifyAssertion({ credential: cred, stored, expectedChallenge: rec.challenge, expectedOrigins: [ORIGIN], rpId: RP }) };
}

const code = (c) => (err) => err instanceof WebAuthnError && err.code === c;

// ------------------------------------------------------------------ tests

for (const kind of ["es256", "rs256", "ed25519"]) {
  test(`${kind}: register, then sign in`, () => {
    const store = new ChallengeStore();
    const dev = softAuthenticator(kind);
    const stored = register(dev, store);
    assert.equal(stored.credentialId, b64u(dev.credId));
    assert.equal(stored.alg, dev.key.alg);
    assert.equal(stored.uv, true);
    assert.equal(stored.be, true);
    assert.deepEqual(stored.transports, ["internal", "hybrid"]);
    const { result } = signIn(dev, stored, store);
    assert.equal(result.counterRegression, false);
    assert.equal(result.uv, true);
  });
}

test("refuses a challenge it never issued", () => {
  const store = new ChallengeStore();
  const dev = softAuthenticator();
  const stored = register(dev, store);
  assert.throws(() => signIn(dev, stored, store, { challenge: b64u(crypto.randomBytes(32)) }), code("challenge"));
});

test("refuses a mismatched challenge even if the store lookup is skipped", () => {
  const store = new ChallengeStore();
  const dev = softAuthenticator();
  const stored = register(dev, store);
  const cred = dev.get({ challenge: b64u(crypto.randomBytes(32)), origin: ORIGIN, rpId: RP });
  assert.throws(() => verifyAssertion({ credential: cred, stored, expectedChallenge: b64u(crypto.randomBytes(32)), expectedOrigins: [ORIGIN], rpId: RP }), code("challenge"));
});

test("refuses a replayed challenge", () => {
  const store = new ChallengeStore();
  const dev = softAuthenticator();
  const stored = register(dev, store);
  const { cred } = signIn(dev, stored, store);
  const { data } = readClientData(cred.response.clientDataJSON);
  assert.equal(store.take(data.challenge), null, "the challenge is gone after one use");
});

test("refuses an expired challenge", () => {
  let now = 1_000_000;
  const store = new ChallengeStore({ ttlMs: 1000, now: () => now });
  const c = store.issue({ kind: "get" });
  now += 1001;
  assert.equal(store.take(c), null);
});

test("refuses the wrong origin", () => {
  const store = new ChallengeStore();
  const dev = softAuthenticator();
  const stored = register(dev, store);
  assert.throws(() => signIn(dev, stored, store, { origin: "https://evil.example.net" }), code("origin"));
  assert.throws(() => register(softAuthenticator(), store, { origin: "http://panel.example.com" }), code("origin"));
});

test("refuses the wrong rpId", () => {
  const store = new ChallengeStore();
  const dev = softAuthenticator();
  const stored = register(dev, store);
  assert.throws(() => signIn(dev, stored, store, { rpIdForHash: "example.com" }), code("rp_id"));
  assert.throws(() => register(softAuthenticator(), store, { rpIdForHash: "evil.example.net" }), code("rp_id"));
});

test("refuses a bad signature", () => {
  for (const kind of ["es256", "rs256", "ed25519"]) {
    const store = new ChallengeStore();
    const dev = softAuthenticator(kind);
    const stored = register(dev, store);
    assert.throws(() => signIn(dev, stored, store, { tamper: true }), code("signature"), kind);
  }
});

test("refuses another passkey's signature", () => {
  const store = new ChallengeStore();
  const a = softAuthenticator(), b = softAuthenticator();
  const storedA = register(a, store);
  assert.throws(() => signIn(b, { ...storedA, userHandle: undefined }, store), code("signature"));
});

test("refuses a ceremony of the wrong type", () => {
  const store = new ChallengeStore();
  const dev = softAuthenticator();
  const stored = register(dev, store);
  assert.throws(() => signIn(dev, stored, store, { type: "webauthn.create" }), code("type"));
});

test("requires user verification", () => {
  const store = new ChallengeStore();
  assert.throws(() => register(softAuthenticator("es256", { uv: false }), store), code("user_verification"));
});

test("reports a signature counter that goes backwards", () => {
  const store = new ChallengeStore();
  const dev = softAuthenticator("es256", { counter: 5 });
  const stored = register(dev, store);
  assert.equal(stored.signCount, 5);
  const first = signIn(dev, stored, store).result;
  assert.equal(first.signCount, 6);
  assert.equal(first.counterRegression, false);
  dev.setCounter(2); // a cloned authenticator would look like this
  const second = signIn(dev, { ...stored, signCount: first.signCount }, store).result;
  assert.equal(second.counterRegression, true);
});

test("a userHandle for someone else is refused", () => {
  const store = new ChallengeStore();
  const dev = softAuthenticator();
  const stored = register(dev, store);
  assert.throws(() => signIn(dev, { ...stored, userHandle: b64u(crypto.randomBytes(16)) }, store), code("user_handle"));
});

test("CBOR decoder: maps with integer keys, nesting, refusals", () => {
  const m = cborDecode(cbor(new Map([[1, 2], [-1, Buffer.from([1, 2])], ["a", [1, "x"]]])));
  assert.equal(m.get(1), 2);
  assert.deepEqual(m.get(-1), Buffer.from([1, 2]));
  assert.deepEqual(m.get("a"), [1, "x"]);
  assert.throws(() => cborDecode(Buffer.from([0x5f])), code("cbor")); // indefinite
  assert.throws(() => cborDecode(Buffer.from([0x43, 1])), code("cbor")); // truncated
  assert.throws(() => cborDecode(Buffer.from([0x01, 0x02])), code("cbor")); // trailing
  assert.throws(() => parseAuthData(Buffer.alloc(10)), code("auth_data"));
});

test("challenge store binds and bounds", () => {
  const store = new ChallengeStore({ perKey: 2 });
  const a = store.issue({ sessionKey: "s" }), b = store.issue({ sessionKey: "s" }), c = store.issue({ sessionKey: "s" });
  assert.equal(store.take(a), null, "oldest dropped past the per-session limit");
  assert.equal(store.take(b).sessionKey, "s");
  assert.ok(store.take(c));
});

test("relying party: panel URL, localhost, plain http and IP addresses", () => {
  assert.deepEqual(relyingParty("https://panel.example.com", "https://panel.example.com"), { ok: true, rpId: "panel.example.com", origin: "https://panel.example.com" });
  // An untrusted proxy can make https look like http; the panel URL's host wins.
  assert.equal(relyingParty("http://panel.example.com", "https://panel.example.com").origin, "https://panel.example.com");
  assert.deepEqual(relyingParty("http://localhost:4120", ""), { ok: true, rpId: "localhost", origin: "http://localhost:4120" });
  assert.equal(relyingParty("http://localhost:4000", "https://panel.example.com").rpId, "localhost");
  const ip = relyingParty("http://203.0.113.9:4000", "https://panel.example.com");
  assert.equal(ip.ok, false);
  assert.equal(ip.reason, "other_host");
  assert.equal(ip.panelUrl, "https://panel.example.com");
  assert.equal(relyingParty("http://203.0.113.9:4000", "").reason, "ip");
  assert.equal(relyingParty("https://203.0.113.9:4000", "").reason, "ip");
  assert.equal(relyingParty("http://panel.example.com", "").reason, "insecure");
  // A panel URL that can't carry passkeys doesn't hold the browser back from a good one.
  assert.equal(relyingParty("https://panel.example.com", "http://203.0.113.9:4000").rpId, "panel.example.com");
});
