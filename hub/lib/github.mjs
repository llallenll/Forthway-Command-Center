/**
 * GitHub source fetching for the Forthway Command Center.
 *
 * The hub pulls a repository archive from GitHub and stores it as a release,
 * exactly as if you had uploaded a zip by hand. That is deliberate: the
 * artifact is kept, so a rollback is a file operation rather than a bet on
 * git history still looking the way it did, and the target machines never
 * need git, SSH keys or GitHub credentials of their own.
 *
 * No npm dependencies — GitHub's zipball endpoint hands back a real zip, and
 * shared/zip.mjs can already read one.
 */

const API = "https://api.github.com";
const UA = "forthway-command-center";

/**
 * Accepts anything a person is likely to paste and returns "owner/name".
 *   https://github.com/acme/site        → acme/site
 *   git@github.com:acme/site.git        → acme/site
 *   acme/site                           → acme/site
 */
export function normalizeRepo(input) {
  if (!input) return null;
  let s = String(input).trim();
  s = s.replace(/^git\+/, "");
  s = s.replace(/^https?:\/\/[^@]*@/i, "https://"); // strip user:token@ if pasted
  s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  s = s.replace(/^git@github\.com:/i, "");
  s = s.replace(/^github\.com\//i, "");
  s = s.replace(/\.git$/i, "");
  s = s.replace(/\/+$/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, name] = parts;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null;
  return `${owner}/${name}`;
}

function headers(token) {
  const h = {
    Accept: "application/vnd.github+json",
    "User-Agent": UA,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function api(pathname, token, { timeoutMs = 20_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}${pathname}`, { headers: headers(token), signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    if (!res.ok) throw new Error(explain(res.status, json, token));
    return json;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("GitHub did not answer in time.");
    throw err;
  } finally {
    clearTimeout(t);
  }
}

function explain(status, json, token) {
  const msg = json?.message || `HTTP ${status}`;
  if (status === 404) {
    return token
      ? "GitHub says that repository or ref does not exist (404). Check the name, and that this token can see it."
      : "GitHub says that repository or ref does not exist (404). If it is private, add a token.";
  }
  if (status === 401) return "GitHub rejected the token (401). It may be expired or mistyped.";
  if (status === 403 && /rate limit/i.test(msg)) {
    return token
      ? "GitHub rate limit reached for this token. Wait a few minutes."
      : "GitHub rate limit reached for unauthenticated requests. Add a token to raise it.";
  }
  if (status === 403) return `GitHub refused the request (403): ${msg}`;
  return `GitHub error ${status}: ${msg}`;
}

/** Does this repo exist, and can we see it? */
export async function repoInfo(repo, token) {
  const r = await api(`/repos/${repo}`, token);
  return {
    repo: r.full_name,
    private: !!r.private,
    defaultBranch: r.default_branch,
    description: r.description || "",
    htmlUrl: r.html_url,
  };
}

/** Branches and tags, for the picker in the UI. */
export async function listRefs(repo, token) {
  const [branches, tags] = await Promise.all([
    api(`/repos/${repo}/branches?per_page=100`, token).catch(() => []),
    api(`/repos/${repo}/tags?per_page=100`, token).catch(() => []),
  ]);
  return {
    branches: (branches || []).map((b) => ({ name: b.name, sha: b.commit?.sha || null })),
    tags: (tags || []).map((t) => ({ name: t.name, sha: t.commit?.sha || null })),
  };
}

/** Resolve a branch/tag/sha to the commit it points at, for display. */
export async function resolveCommit(repo, ref, token) {
  try {
    const c = await api(`/repos/${repo}/commits/${encodeURIComponent(ref)}`, token);
    return {
      sha: c.sha,
      shortSha: c.sha?.slice(0, 7) || null,
      message: (c.commit?.message || "").split("\n")[0].slice(0, 200),
      author: c.commit?.author?.name || c.author?.login || null,
      date: c.commit?.author?.date || null,
      htmlUrl: c.html_url,
    };
  } catch {
    // Not fatal — the download will fail with a better message if the ref is
    // genuinely wrong.
    return null;
  }
}

/**
 * Download the repository at `ref` as a zip.
 *
 * GitHub's zipball wraps everything in an `owner-repo-sha/` folder; the
 * extractor strips that wrapper automatically, so nothing extra to do here.
 */
export async function downloadZipball(repo, ref, token, { timeoutMs = 300_000, maxBytes = 500 * 1024 * 1024 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/repos/${repo}/zipball/${encodeURIComponent(ref)}`, {
      headers: headers(token),
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let json = null;
      try {
        json = JSON.parse(await res.text());
      } catch {
        /* ignore */
      }
      throw new Error(explain(res.status, json, token));
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error("GitHub returned an empty archive.");
    if (buf.length > maxBytes) throw new Error(`That archive is larger than the ${Math.round(maxBytes / 1e6)}MB limit.`);
    return buf;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Timed out downloading the archive from GitHub.");
    throw err;
  } finally {
    clearTimeout(t);
  }
}

/** Confirm a token works and say who it belongs to. */
export async function checkToken(token) {
  if (!token) return { ok: false, error: "No token given." };
  try {
    const me = await api("/user", token);
    return { ok: true, login: me.login, name: me.name || "" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
