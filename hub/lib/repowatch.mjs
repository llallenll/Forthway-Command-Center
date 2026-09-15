/**
 * Is a site's repository ahead of what is actually deployed?
 *
 * The panel already knows which commit every release came from, because it
 * records one when it pulls. So the question is only ever "what is at the top
 * of that branch now", and the answer is one commit lookup per site.
 *
 * The reason this is a module with a cache rather than a call in the render
 * path: GitHub allows 60 requests an hour to an anonymous caller and 5,000 to
 * a credentialled one, counted per IP. A dashboard that asked on every refresh
 * would poll roughly 300 times an hour per site, exhaust the allowance within
 * minutes, and then show nothing at all — the opposite of what checking often
 * is for. So every check goes through a cooldown, and anything that wants a
 * fresh answer asks for one and gets the cached one until the cooldown is up.
 */

const OK_EVERY_MS = 5 * 60_000; // a healthy repo, re-checked every 5 minutes
const ERR_EVERY_MS = 20 * 60_000; // a failing one backs off, rather than hammering

export class RepoWatch {
  /**
   * @param resolveCommit  (repo, ref, token) => commit | null
   * @param repoInfo       (repo, token) => { defaultBranch } — for a blank ref
   */
  constructor({ resolveCommit, repoInfo, okEveryMs = OK_EVERY_MS, errEveryMs = ERR_EVERY_MS }) {
    this.resolveCommit = resolveCommit;
    this.repoInfo = repoInfo;
    this.okEveryMs = okEveryMs;
    this.errEveryMs = errEveryMs;
    this.byId = new Map(); // siteId -> state
    this.inFlight = new Set();
  }

  state(siteId) {
    return this.byId.get(siteId) || null;
  }

  forget(siteId) {
    this.byId.delete(siteId);
  }

  /** Drop what we know when the repo or branch changes under us. */
  invalidate(siteId) {
    const st = this.byId.get(siteId);
    if (st) st.checkedAt = null;
  }

  due(siteId) {
    const st = this.byId.get(siteId);
    if (!st || !st.checkedAt) return true;
    const window = st.error ? this.errEveryMs : this.okEveryMs;
    return Date.now() - new Date(st.checkedAt).getTime() >= window;
  }

  /**
   * Look at one site. Returns the state either way — cached when the cooldown
   * has not elapsed, so callers can ask as often as they like.
   *
   * `deployedSha` is the commit the live release was built from; null when the
   * site has never been deployed from this repository, which is a different
   * thing from being up to date and is reported as such.
   */
  async check(site, { deployedSha, token, force = false } = {}) {
    const id = site.id;
    const repo = site.github?.repo || "";
    if (!repo) {
      this.byId.delete(id);
      return null;
    }
    const ref = site.github?.ref || "";

    // A repo or branch change makes the previous answer meaningless.
    const prev = this.byId.get(id);
    if (prev && (prev.repo !== repo || prev.ref !== ref)) this.byId.delete(id);

    if (!force && !this.due(id)) return this.byId.get(id) || null;
    if (this.inFlight.has(id)) return this.byId.get(id) || null;

    this.inFlight.add(id);
    try {
      let useRef = ref;
      if (!useRef) {
        const info = await this.repoInfo(repo, token).catch(() => null);
        useRef = info?.defaultBranch || "main";
      }
      const latest = await this.resolveCommit(repo, useRef, token);
      if (!latest) throw new Error(`Could not read ${repo} at ${useRef}. Check the branch, and the token if it is private.`);

      const next = {
        repo,
        ref,
        resolvedRef: useRef,
        checkedAt: new Date().toISOString(),
        error: null,
        latest,
        deployedSha: deployedSha || null,
        // Three answers, and "cannot tell" is a real one: a site deployed from
        // a zip has no commit to compare against.
        updateAvailable: deployedSha ? latest.sha !== deployedSha : null,
      };
      this.byId.set(id, next);
      return next;
    } catch (err) {
      this.byId.set(id, {
        repo,
        ref,
        checkedAt: new Date().toISOString(),
        error: err.message,
        latest: null,
        deployedSha: deployedSha || null,
        updateAvailable: null,
      });
      return this.byId.get(id);
    } finally {
      this.inFlight.delete(id);
    }
  }

  /**
   * A deploy changes which commit is live without anything changing on
   * GitHub, so the answer can be recomputed from what is already cached —
   * no request, and the badge clears the moment the deploy lands.
   */
  refreshDeployed(siteId, deployedSha) {
    const st = this.byId.get(siteId);
    if (!st) return false;
    const before = st.updateAvailable;
    st.deployedSha = deployedSha || null;
    st.updateAvailable = deployedSha && st.latest ? st.latest.sha !== deployedSha : null;
    return st.updateAvailable !== before;
  }

  /** What the dashboard is given: enough to draw a badge and say why. */
  publicState(siteId) {
    const st = this.byId.get(siteId);
    if (!st) return null;
    return {
      repo: st.repo,
      ref: st.resolvedRef || st.ref || "",
      checkedAt: st.checkedAt,
      error: st.error,
      updateAvailable: st.updateAvailable,
      deployedSha: st.deployedSha ? st.deployedSha.slice(0, 7) : null,
      latest: st.latest
        ? {
            sha: st.latest.sha,
            shortSha: st.latest.shortSha,
            message: st.latest.message,
            author: st.latest.author,
            date: st.latest.date,
            htmlUrl: st.latest.htmlUrl,
          }
        : null,
    };
  }
}
