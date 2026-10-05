/**
 * Encryption for secrets kept in db.json (database passwords, MySQL root
 * password, per-site GitHub tokens…).
 *
 * AES-256-GCM with `config.secretKey` (32 random bytes, hex, created on first
 * boot). Ciphertext format: `v1:<iv b64url>:<tag b64url>:<data b64url>`.
 *
 * This protects secrets in backups and copies of db.json that travel without
 * config.json. It is not a defence against someone who can read both files —
 * keep config.json (mode 600) out of backups you hand to anyone. Losing
 * config.json means losing the key: anything encrypted with it cannot be read
 * back, so the server backup includes it.
 */

import crypto from "node:crypto";

const PREFIX = "v1";

function keyFrom(secretKey) {
  if (!secretKey || typeof secretKey !== "string") throw new Error("secretKey is not set");
  const buf = /^[0-9a-f]{64}$/i.test(secretKey)
    ? Buffer.from(secretKey, "hex")
    : crypto.createHash("sha256").update(secretKey).digest(); // tolerate a hand-written key
  return buf;
}

export function createSecrets(secretKey) {
  const key = keyFrom(secretKey);
  return {
    /** Encrypt a string. Empty / null input returns "" (nothing to protect). */
    encrypt(plain) {
      if (plain == null || plain === "") return "";
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [PREFIX, iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(":");
    },

    /**
     * Decrypt a value produced by encrypt(). Empty input returns "". Throws
     * when the value was tampered with or encrypted with a different key.
     */
    decrypt(value) {
      if (value == null || value === "") return "";
      const parts = String(value).split(":");
      if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error("Not an encrypted value");
      const [, iv, tag, data] = parts.map((p, i) => (i ? Buffer.from(p, "base64url") : p));
      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
      } catch {
        throw new Error("Could not decrypt a stored secret (wrong panel key, or the value was altered)");
      }
    },

    /** True when the value looks like something encrypt() produced. */
    isEncrypted(value) {
      return typeof value === "string" && value.startsWith(`${PREFIX}:`) && value.split(":").length === 4;
    },
  };
}
