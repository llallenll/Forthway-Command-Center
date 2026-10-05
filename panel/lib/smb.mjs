/**
 * DATA — SMB (Windows / Samba share) backup destination through the
 * `smbclient` CLI (Debian/Ubuntu package `smbclient`). No kernel mount, no
 * mount points: every operation is one short smbclient session.
 *
 * Credentials never reach argv or the environment: each session writes a
 * one-off authentication file (`-A`, mode 0600, dataDir/tmp/smb-auth-*) and
 * removes it in `finally`.
 *
 * smbclient's `-c` parser splits commands on every `;` (quotes or not) and
 * tokenises arguments on whitespace with `"` as the only quoting character
 * (no escapes). So every user-supplied name is validated against a strict
 * character set (no `; " \ * ?`, no control characters, no `..`) and then
 * wrapped in double quotes; remote paths are joined with `\`. Commands always
 * start with a fixed verb, so input can never become a command (e.g. `!`).
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";

import { run, which, DRY_RUN } from "./sys.mjs";

export const MIN_PROTOCOLS = { SMB2: "SMB2_02", SMB3: "SMB3", NT1: "NT1" };
const CTRL = /[\u0000-\u001f\u007f]/;
// Windows-invalid in file names, plus what smbclient's command parser treats specially.
const BAD_COMPONENT = /["*:<>?\\|;\/]/;

const fail = (msg) => {
  const e = new Error(msg);
  e.status = 400;
  e.validation = true;
  return e;
};

// ------------------------------------------------------------ validation

/** Host name or IPv4 address (smbclient takes it as //server/share). */
export function validServer(v) {
  const s = String(v ?? "").trim();
  if (!s) throw fail("Enter the SMB server's host name or IP address.");
  if (net.isIPv4(s)) return s;
  if (net.isIPv6(s) || /^\[.*\]$/.test(s)) throw fail("IPv6 addresses aren't supported for SMB yet — use a host name that resolves to it.");
  if (s.length > 253 || !/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?)*$/.test(s))
    throw fail("Server must be a host name (nas.local, fileserver) or an IPv4 address — no \\\\ or // prefix, no share.");
  return s;
}

/** Share name: letters, digits, spaces and a few safe symbols ($ for hidden shares). */
export function validShare(v) {
  const s = String(v ?? "").trim().replace(/^[\\/]+|[\\/]+$/g, "");
  if (!s) throw fail("Enter the share name (e.g. Backups).");
  if (s.length > 80 || CTRL.test(s) || !/^[\p{L}\p{N} _.$'()&!#@~^{}-]+$/u.test(s) || /^[ .]|[ .]$/.test(s.replace(/\$$/, "")))
    throw fail("Share names may use letters, digits, spaces and . _ - $ ' ( ) & ! # @ ~ ^ { } (no / \\ ; \" * ? : < > |).");
  return s;
}

/** One folder or file name on the share. */
export function validComponent(c, what = "Path") {
  const s = String(c ?? "");
  if (!s || s === "." || s === "..") throw fail(`${what}: empty, "." or ".." segments are not allowed.`);
  if (s.length > 255) throw fail(`${what}: a segment is longer than 255 characters.`);
  if (CTRL.test(s) || BAD_COMPONENT.test(s)) throw fail(`${what} segments can't contain control characters or any of " * : < > ? \\ | ; /`);
  if (/^ | $|\.$/.test(s)) throw fail(`${what} segments can't start or end with a space or end with a dot.`);
  return s;
}

/** Optional subfolder ("fcc/backups", "Off-site copies\\panel") → array of segments. */
export function validFolder(v, what = "Subfolder") {
  const s = String(v ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!s) return [];
  const parts = s.split(/\/+/);
  if (parts.length > 32 || s.length > 400) throw fail(`${what} is too long.`);
  return parts.map((p) => validComponent(p, what));
}

export function validUsername(v) {
  const s = String(v ?? "").trim();
  if (!s) throw fail("Enter the user name (use \"guest\" with an empty password for guest access).");
  if (s.length > 104 || CTRL.test(s) || /["\/\\\[\]:;|=,+*?<>]/.test(s))
    throw fail("User name can't contain \" / \\ [ ] : ; | = , + * ? < > — put the Windows domain in the Domain field.");
  return s;
}

export function validDomain(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62})$/.test(s)) throw fail("Domain / workgroup may use letters, digits, . _ - (e.g. WORKGROUP or corp.example.com).");
  return s;
}

/** The auth-file parser strips surrounding whitespace and ends a value at the newline. */
export function validPassword(v) {
  const s = String(v ?? "");
  if (s.length > 256) throw fail("Password is longer than 256 characters.");
  if (CTRL.test(s)) throw fail("Password can't contain control characters or line breaks.");
  if (s !== s.trim()) throw fail("Password can't start or end with a space (smbclient would strip it).");
  return s;
}

export function validPort(v) {
  if (v === undefined || v === null || v === "") return 445;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw fail("Port must be 1–65535 (SMB uses 445).");
  return n;
}

export function validMinProtocol(v) {
  const s = String(v || "SMB2").toUpperCase();
  if (!(s in MIN_PROTOCOLS)) throw fail("Minimum protocol must be SMB2, SMB3 or NT1.");
  return s;
}

// ------------------------------------------------------------ command building

/** `"a\b\c"` — every segment already validated. */
export function quoteRemote(segments) {
  const segs = segments.map((s) => validComponent(s, "Remote path"));
  return `"${segs.join("\\")}"`;
}

/** Local file for put/get: absolute, no characters that would break the -c parser. */
export function quoteLocal(p) {
  const s = String(p ?? "");
  if (!path.isAbsolute(s) || CTRL.test(s) || /[";]/.test(s)) throw fail(`Local path can't be used with smbclient (it contains " ; or control characters): ${s}`);
  return `"${s}"`;
}

/** `mkdir -p`: one mkdir per segment; "already exists" is ignored by the caller. */
export function mkdirCommands(segments) {
  const out = [];
  for (let i = 1; i <= segments.length; i++) out.push(`mkdir ${quoteRemote(segments.slice(0, i))}`);
  return out;
}

export function relSegments(rel) {
  return String(rel || "")
    .split("/")
    .filter(Boolean)
    .map((p) => validComponent(p, "Backup path"));
}

/** smbclient argv (no secrets): //server/share -A file -p port -m SMB3 --option=… -t secs -c "…". */
export function buildArgs({ server, share, port = 445, minProtocol = "SMB2", authFile, timeoutSec = 60, command }) {
  if (!authFile || !path.isAbsolute(authFile)) throw new Error("authFile must be an absolute path");
  if (CTRL.test(command)) throw new Error("command contains control characters");
  return [
    `//${validServer(server)}/${validShare(share)}`,
    "-A",
    authFile,
    "-p",
    String(validPort(port)),
    "-m",
    "SMB3",
    `--option=client min protocol=${MIN_PROTOCOLS[validMinProtocol(minProtocol)]}`,
    "-t",
    String(Math.max(5, Math.min(3600, Math.round(timeoutSec)))),
    "-c",
    command,
  ];
}

export function authFileContent({ username, password, domain }) {
  return `username = ${validUsername(username)}\npassword = ${validPassword(password)}\n${domain ? `domain = ${validDomain(domain)}\n` : ""}`;
}

// ------------------------------------------------------------ output handling

const NOISE = [/^Can't load .*smb\.conf/i, /^lpcfg_do_global_parameter: WARNING/i, /^WARNING: The ".*" option is deprecated/i, /^\s*$/];

/** Remove secrets and config-file noise from smbclient output. */
export function scrub(text, secrets = []) {
  let t = String(text || "");
  for (const s of secrets) if (s && s.length >= 3) t = t.split(s).join("••••");
  return t
    .split("\n")
    .filter((l) => !NOISE.some((r) => r.test(l)))
    .join("\n")
    .trim();
}

const HINTS = {
  NT_STATUS_LOGON_FAILURE: "the user name or password was rejected",
  NT_STATUS_ACCOUNT_DISABLED: "that account is disabled",
  NT_STATUS_BAD_NETWORK_NAME: "the share doesn't exist on that server",
  NT_STATUS_ACCESS_DENIED: "access denied — the account needs write permission on the share",
  NT_STATUS_HOST_UNREACHABLE: "the server can't be reached",
  NT_STATUS_NETWORK_UNREACHABLE: "the network is unreachable",
  NT_STATUS_CONNECTION_REFUSED: "connection refused — is SMB running and the port right?",
  NT_STATUS_IO_TIMEOUT: "timed out — check the server address, port and firewall",
  NT_STATUS_UNSUCCESSFUL: "the server couldn't be reached",
  NT_STATUS_OBJECT_PATH_NOT_FOUND: "a folder in the path doesn't exist",
  NT_STATUS_OBJECT_NAME_NOT_FOUND: "the file doesn't exist",
  NT_STATUS_DISK_FULL: "the share is full",
  NT_STATUS_INVALID_NETWORK_RESPONSE: "protocol mismatch — try a different minimum protocol",
  NT_STATUS_NOT_SUPPORTED: "the server doesn't support this protocol level — check the minimum protocol",
  NT_STATUS_CONNECTION_RESET: "the server closed the connection — often a protocol mismatch (SMB1 vs SMB2/3)",
  NT_STATUS_CONNECTION_DISCONNECTED: "the server closed the connection",
};

export function explain(output) {
  const codes = [...new Set(String(output || "").match(/NT_STATUS_[A-Z_]+/g) || [])];
  const hints = codes.filter((c) => HINTS[c]).map((c) => `${HINTS[c]} (${c})`);
  return hints.length ? hints.join("; ") : codes.join(", ");
}

/** Parse `ls` output lines: "  name   DA   0  Mon Oct  5 12:00:00 2026". */
export function parseLs(stdout) {
  const items = [];
  for (const line of String(stdout || "").split("\n")) {
    const m = /^ {2}(.+?)\s+([ADHSRNI]*)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s*$/.exec(line);
    if (!m || m[1] === "." || m[1] === "..") continue;
    const t = Date.parse(m[4].replace(/\s+/g, " "));
    items.push({ name: m[1], dir: m[2].includes("D"), size: Number(m[3]), modifiedAt: Number.isNaN(t) ? null : new Date(t).toISOString() });
  }
  return items;
}

// ------------------------------------------------------------ client

export function smbInstalled() {
  return DRY_RUN || !!which("smbclient");
}

export const INSTALL_HINT = "smbclient is not installed on this server. Install it with `apt install smbclient` (or use the Install smbclient button), then try again.";

/**
 * cfg: { server, share, path (subfolder), username, password, domain, minProtocol, port }
 * tmpDir: where auth files go (dataDir/tmp).
 */
export function createSmb(cfg, { tmpDir }) {
  const server = validServer(cfg.server);
  const share = validShare(cfg.share);
  const base = validFolder(cfg.path);
  const username = validUsername(cfg.username);
  const password = validPassword(cfg.password || "");
  const domain = validDomain(cfg.domain);
  const minProtocol = validMinProtocol(cfg.minProtocol);
  const port = validPort(cfg.port);
  const secrets = [password];

  const remoteSegs = (rel) => [...base, ...relSegments(rel)];
  const keyFor = (rel) => remoteSegs(rel).join("/");
  const location = (key) => `//${server}/${share}${key ? `/${key}` : ""}`;

  /** Run one smbclient session. Resolves { code, stdout, stderr, out } (scrubbed). */
  async function session(command, { log, signal, timeoutSec = 60, allowFail = false } = {}) {
    if (!DRY_RUN && !which("smbclient")) throw Object.assign(new Error(INSTALL_HINT), { notInstalled: true });
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const authFile = path.join(tmpDir, `smb-auth-${crypto.randomBytes(8).toString("hex")}`);
    try {
      const fd = fs.openSync(authFile, "wx", 0o600);
      try {
        fs.writeSync(fd, authFileContent({ username, password, domain }));
      } finally {
        fs.closeSync(fd);
      }
      // -t is smbclient's per-request timeout; the whole session is bounded by timeoutSec.
      const args = buildArgs({ server, share, port, minProtocol, authFile, timeoutSec: Math.min(timeoutSec, 60), command });
      const slog = log ? (l) => { const s = scrub(l, secrets); if (s) log(s); } : null;
      const r = await run(which("smbclient") || "smbclient", args, { log: slog, signal, allowFail: true, timeoutMs: (timeoutSec + 30) * 1000 });
      const out = scrub(`${r.stderr || ""}\n${r.stdout || ""}`, secrets);
      // smbclient can exit 0 after a failed command in a -c list; trust NT_STATUS errors too.
      const failed = r.code !== 0 || /NT_STATUS_(?!OK\b|OBJECT_NAME_COLLISION\b|NO_MORE_FILES\b)[A-Z_]+/.test(out);
      if (failed && !allowFail) {
        const why = r.code === null ? `timed out after ${timeoutSec}s` : explain(out) || out.split("\n").slice(-3).join(" ") || `exit code ${r.code}`;
        throw new Error(`SMB ${command.split(" ")[0]} on //${server}/${share} failed: ${why}`);
      }
      return { ...r, failed, out };
    } finally {
      fs.rmSync(authFile, { force: true });
    }
  }

  async function ensureDir(segs, opts) {
    if (!segs.length) return;
    // smbclient has no mkdir -p: one mkdir per level, "already exists" is fine.
    const r = await session(mkdirCommands(segs).join("; "), { ...opts, allowFail: true });
    const bad = (r.out.match(/NT_STATUS_[A-Z_]+/g) || []).filter((c) => c !== "NT_STATUS_OBJECT_NAME_COLLISION");
    if (bad.length) throw new Error(`SMB mkdir ${segs.join("/")} on //${server}/${share} failed: ${explain(r.out)}`);
  }

  return {
    keyFor,
    location,
    server,
    share,
    base,
    /** Upload a local file to <subfolder>/<rel>. Streams from disk. */
    async putFile(rel, file, { log, signal } = {}) {
      const segs = remoteSegs(rel);
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {}
      await ensureDir(segs.slice(0, -1), { log, signal });
      // Assume ≥ ~1 MB/s; never kill a healthy slow upload too early.
      const timeoutSec = 600 + Math.ceil(size / 1_000_000);
      try {
        await session(`put ${quoteLocal(file)} ${quoteRemote(segs)}`, { log, signal, timeoutSec });
      } catch (e) {
        await session(`del ${quoteRemote(segs)}`, { allowFail: true }).catch(() => {}); // don't leave a partial file
        throw e;
      }
      return { key: segs.join("/"), size };
    },
    /** Download <key> (as stored in the backup record) to a local file. */
    async getFile(key, file, { log, signal, size = 0 } = {}) {
      const segs = String(key).split("/").filter(Boolean).map((p) => validComponent(p, "Remote path"));
      await session(`get ${quoteRemote(segs)} ${quoteLocal(file)}`, { log, signal, timeoutSec: 600 + Math.ceil(size / 1_000_000) });
    },
    async deleteFile(key, opts = {}) {
      const segs = String(key).split("/").filter(Boolean).map((p) => validComponent(p, "Remote path"));
      await session(`del ${quoteRemote(segs)}`, opts);
    },
    /** List a folder under the subfolder (sub = "db/my-project"). */
    async list(sub = "", opts = {}) {
      const segs = [...base, ...validFolder(sub, "Folder")];
      const mask = segs.length ? `"${segs.join("\\")}\\*"` : `"*"`;
      const r = await session(`ls ${mask}`, { ...opts, allowFail: true });
      if (r.failed && !/NT_STATUS_NO_SUCH_FILE|NT_STATUS_OBJECT_NAME_NOT_FOUND/.test(r.out)) {
        throw new Error(`SMB ls on ${location(segs.join("/"))} failed: ${explain(r.out) || r.out.split("\n").slice(-2).join(" ")}`);
      }
      return { path: segs.join("/"), location: location(segs.join("/")), items: parseLs(r.stdout), dryRun: !!r.dryRun };
    },
    /** Create the subfolder, write + list + delete a small file. */
    async test({ log } = {}) {
      const name = `.fcc-test-${Date.now()}.txt`;
      fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      const local = path.join(tmpDir, `smb-test-${crypto.randomBytes(6).toString("hex")}.txt`);
      fs.writeFileSync(local, "fcc destination test\n", { mode: 0o600 });
      try {
        await ensureDir(base, { log });
        await session(`put ${quoteLocal(local)} ${quoteRemote([...base, name])}`, { log, timeoutSec: 60 });
        const listed = await this.list("", { log });
        if (!DRY_RUN && !listed.items.some((i) => i.name === name)) throw new Error("The test file was written but doesn't show up in a listing of the folder.");
        await session(`del ${quoteRemote([...base, name])}`, { log, timeoutSec: 60 });
        return { ok: true, location: location(base.join("/")), file: name };
      } finally {
        fs.rmSync(local, { force: true });
      }
    },
  };
}
