/**
 * Environment variables, parsed and written the way a .env file expects.
 *
 * This exists because of one specific bug. The settings pane took a textarea
 * of KEY=value lines and did nothing more than split on the first "=", so
 *
 *     DATABASE_URL="mysql://user:pass@host:3306/db"
 *
 * became a value that literally began with a double quote. Nothing complains
 * about that until the app starts, and then it complains in a way that points
 * at the wrong thing entirely — Prisma reports
 *
 *     the URL must start with the protocol `mysql://`
 *
 * which reads like a typo in the URL rather than a quoting bug two machines
 * away. Anyone pasting out of a .env file writes the quotes, because in a .env
 * file they are correct: dotenv strips them. So this module strips them too,
 * and everything that accepts environment variables goes through it.
 *
 * The other half of the job is the reverse trip. Passing variables through the
 * process environment reaches the running app, but it does not reach the
 * tools that read a .env file for themselves — `prisma generate`, `prisma
 * migrate`, `next build` — so the deployer also writes them into the app's
 * .env, inside a marked block it owns and can rewrite without touching
 * anything a person put there by hand.
 *
 * No dependencies: the hub serves this file to the browser as well, so it has
 * to be plain ESM that runs in both places.
 */

export const BLOCK_START = "# >>> forthway command center — managed, edited from the panel >>>";
export const BLOCK_END = "# <<< forthway command center <<<";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Is this a legal environment variable name? */
export function isEnvKey(key) {
  return KEY_RE.test(String(key || ""));
}

/**
 * Strip the quoting a person carried over from a .env file.
 *
 * Matching quotes around the whole value are removed. Inside double quotes the
 * usual escapes are honoured, because that is what dotenv does and what the
 * value was written for. Inside single quotes nothing is interpreted, also
 * like dotenv. An unbalanced quote is left exactly as typed — that is far more
 * likely to be a password that happens to contain a quote than a mistake.
 */
export function cleanEnvValue(input) {
  let v = String(input ?? "");
  // Trailing "# comment" is not stripped: a value like a URL fragment or a
  // password may legitimately contain "#", and guessing wrong silently
  // truncates a secret.
  v = v.trim();
  if (v.length >= 2) {
    const q = v[0];
    if ((q === '"' || q === "'" || q === "`") && v[v.length - 1] === q) {
      const inner = v.slice(1, -1);
      // A closing quote that was itself escaped means the quotes are not a
      // wrapper at all, so leave the value alone.
      if (!/(^|[^\\])(\\\\)*\\$/.test(inner)) {
        return q === '"' || q === "`" ? unescapeDouble(inner) : inner;
      }
    }
  }
  return v;
}

function unescapeDouble(s) {
  return s.replace(/\\([\\"'`nrtf$])/g, (_, c) => {
    switch (c) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "f":
        return "\f";
      default:
        return c;
    }
  });
}

/**
 * Parse a textarea (or a whole .env file) into { env, errors }.
 *
 * Multi-line quoted values are supported, because a PEM key or a service
 * account JSON blob is a normal thing to want here and splitting it across
 * lines is the only way to paste it.
 */
export function parseEnvText(text) {
  const env = {};
  const errors = [];
  const lines = String(text ?? "").split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const bare = line.trim();
    if (!bare || bare.startsWith("#")) continue;

    // "export FOO=bar" is what people copy out of shell notes.
    const withoutExport = bare.replace(/^export\s+/, "");
    const eq = withoutExport.indexOf("=");
    if (eq < 1) {
      errors.push({ line: i + 1, text: bare, error: "no = on this line" });
      continue;
    }

    const key = withoutExport.slice(0, eq).trim();
    let raw = withoutExport.slice(eq + 1);

    // A value that opens a quote and does not close it continues onto the
    // following lines until the matching quote turns up.
    const opener = raw.trim()[0];
    if (opener === '"' || opener === "'" || opener === "`") {
      let acc = raw.trim();
      while (!closesWith(acc, opener) && i + 1 < lines.length) {
        acc += "\n" + lines[++i];
      }
      raw = acc;
    }

    if (!isEnvKey(key)) {
      errors.push({
        line: i + 1,
        text: bare,
        error: `"${key}" is not a usable variable name — letters, digits and underscores only, not starting with a digit`,
      });
      continue;
    }
    env[key] = cleanEnvValue(raw);
  }
  return { env, errors };
}

function closesWith(acc, quote) {
  if (acc.length < 2) return false;
  if (acc[acc.length - 1] !== quote) return false;
  // Not closed if that final quote is escaped.
  const inner = acc.slice(1, -1);
  return !/(^|[^\\])(\\\\)*\\$/.test(inner);
}

/** Turn a { KEY: value } object back into textarea content. */
export function formatEnvText(env = {}) {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${needsQuoting(v) ? quote(v) : v}`)
    .join("\n");
}

function needsQuoting(value) {
  const v = String(value ?? "");
  return v === "" || v !== v.trim() || /[\n\r"'`\\#]/.test(v) || /^\s|\s$/.test(v);
}

/**
 * Quote a value for a .env file.
 *
 * The subtlety is "$". dotenv-expand — which Prisma and Next both use — treats
 * ${FOO} and $FOO as references to another variable, so a password containing
 * a dollar sign followed by a letter would be silently replaced with nothing.
 * Escaping it as \$ is the documented way out. A "$" that cannot start a
 * reference is left alone, so ordinary values stay readable.
 */
function quote(value) {
  const escaped = String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$(?=[A-Za-z_{])/g, "\\$")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

/** One KEY="value" line per variable, always quoted — this goes to disk. */
export function renderEnvBlock(env = {}) {
  const body = Object.entries(env)
    .filter(([k]) => isEnvKey(k))
    .map(([k, v]) => `${k}=${quote(v)}`)
    .join("\n");
  return `${BLOCK_START}\n# Anything you write between these markers is replaced on the next deploy.\n${body}\n${BLOCK_END}`;
}

/**
 * Merge the managed block into an existing .env, leaving every hand-written
 * line where it was.
 *
 * Returns null when nothing would change, so a caller can skip the write and
 * keep the file's mtime — which matters, because a changed .env is one of the
 * things a watching dev server restarts for.
 */
export function mergeEnvFile(existing, env = {}) {
  const current = String(existing ?? "");
  const block = Object.keys(env).length ? renderEnvBlock(env) : "";

  const startAt = current.indexOf(BLOCK_START);
  let next;

  if (startAt === -1) {
    if (!block) return null; // nothing to add, nothing to remove
    const head = current.replace(/\s*$/, "");
    next = head ? `${head}\n\n${block}\n` : `${block}\n`;
  } else {
    const endIdx = current.indexOf(BLOCK_END, startAt);
    const after = endIdx === -1 ? "" : current.slice(endIdx + BLOCK_END.length).replace(/^\n/, "");
    const before = current.slice(0, startAt);
    if (!block) {
      next = `${before.replace(/\n{2,}$/, "\n")}${after}`;
    } else {
      next = `${before}${block}\n${after}`;
    }
  }

  return next === current ? null : next;
}

/**
 * Which of these variables would shadow a hand-written line in the same file?
 *
 * The managed block is written last, so it wins — worth saying out loud in the
 * job log rather than leaving someone to wonder why their edit did nothing.
 */
export function shadowedKeys(existing, env = {}) {
  const current = String(existing ?? "");
  const startAt = current.indexOf(BLOCK_START);
  const endIdx = startAt === -1 ? -1 : current.indexOf(BLOCK_END, startAt);
  const outside =
    startAt === -1
      ? current
      : current.slice(0, startAt) + (endIdx === -1 ? "" : current.slice(endIdx + BLOCK_END.length));
  const { env: theirs } = parseEnvText(outside);
  return Object.keys(env).filter((k) => Object.prototype.hasOwnProperty.call(theirs, k));
}

/**
 * Sanity checks that catch the mistakes people actually make, without
 * pretending to validate every possible value.
 */
export function lintEnv(env = {}) {
  const notes = [];
  for (const [key, value] of Object.entries(env)) {
    const v = String(value ?? "");
    if (/^["'`]/.test(v) || /["'`]$/.test(v)) {
      notes.push(`${key} still has a quote at one end — check it is meant to be part of the value.`);
    }
    if (/^\w+:\/\//.test(v)) {
      const note = lintConnectionUrl(key, v);
      if (note) notes.push(note);
    }
    if (/\s$/.test(v) || /^\s/.test(v)) notes.push(`${key} has whitespace at one end.`);
  }
  return notes;
}

/**
 * A database URL whose password contains "@", ":", "/" or "?" is ambiguous:
 * the parser has no way to tell the password apart from the host. Percent-
 * encoding is the fix, and it is worth naming the exact characters rather than
 * saying "special characters" and leaving someone to guess.
 */
export function lintConnectionUrl(key, value) {
  const m = /^(\w+):\/\/([^/]*)(\/.*)?$/.exec(String(value));
  if (!m) return null;
  const authority = m[2];
  const at = authority.lastIndexOf("@");
  if (at === -1) return null;
  const userinfo = authority.slice(0, at);
  const colon = userinfo.indexOf(":");
  if (colon === -1) return null;
  const password = userinfo.slice(colon + 1);
  const bad = [...new Set([...password].filter((c) => "@:/?#[]".includes(c)))];
  if (!bad.length) return null;
  return (
    `${key}: the password contains ${bad.map((c) => `"${c}"`).join(", ")}, which a URL parser reads as ` +
    `structure rather than as part of the password. Percent-encode it — ` +
    `${bad.map((c) => `"${c}" → "${encodeURIComponent(c)}"`).join(", ")}.`
  );
}

/** Percent-encode the password inside a connection URL, leaving the rest be. */
export function encodeUrlPassword(value) {
  const m = /^(\w+:\/\/)([^/]*)(.*)$/.exec(String(value));
  if (!m) return value;
  const [, scheme, authority, rest] = m;
  const at = authority.lastIndexOf("@");
  if (at === -1) return value;
  const userinfo = authority.slice(0, at);
  const host = authority.slice(at + 1);
  const colon = userinfo.indexOf(":");
  if (colon === -1) return value;
  const user = userinfo.slice(0, colon);
  const password = userinfo.slice(colon + 1);
  const encoded = [...password]
    .map((c) => (/[A-Za-z0-9\-._~!$&'()*+,;=]/.test(c) ? c : encodeURIComponent(c)))
    .join("");
  return `${scheme}${user}:${encoded}@${host}${rest}`;
}
