/**
 * HTTP plumbing shared by every panel module.
 *
 * Each feature module exports `register(router, ctx)` and adds its routes
 * here; server.mjs owns the one http.Server and hands every request to
 * `router.handle()`. Handlers return a plain object (sent as JSON 200), or
 * write to `res` themselves and return `undefined`, or throw `httpError()`.
 *
 *   router.get("/api/projects/:id", async (req, res, { params, query, body, admin }) => {...})
 *
 * Options (third argument, before the handler is also accepted):
 *   { public: true }   no admin session needed (login, setup, healthz)
 *   { agent: true }    no admin session; the module authenticates the node itself
 *   { raw: true }      body is NOT parsed; read `req` yourself (uploads)
 *   { limit: bytes }   JSON body size limit (default 5 MB)
 */

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function httpError(status, message, extra) {
  return new HttpError(status, message, extra);
}

export function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  const isObject = !isBuffer && body !== null && typeof body === "object";
  const data = isBuffer || typeof body === "string" ? body : JSON.stringify(body ?? null);
  res.writeHead(status, {
    "Content-Type": isObject ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    ...headers,
  });
  res.end(data);
}

export function sendJson(res, status, obj) {
  send(res, status, obj, { "Content-Type": "application/json; charset=utf-8" });
}

export function redirect(res, to) {
  res.writeHead(302, { Location: to, "Cache-Control": "no-store" });
  res.end();
}

export function clientIp(req) {
  return (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "?").trim();
}

export async function readBody(req, limitBytes = 5 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw httpError(413, "Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody(req, limitBytes) {
  const buf = await readBody(req, limitBytes);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw httpError(400, "Body is not valid JSON");
  }
}

function compile(pattern) {
  const keys = [];
  const re = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, k) => {
      keys.push(k);
      return "/([^/]+)";
    })
    .replace(/\/\*$/, "/(.*)");
  if (pattern.endsWith("/*")) keys.push("rest");
  return { re: new RegExp(`^${re}$`), keys };
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, a, b) {
    const opts = typeof a === "function" ? {} : a || {};
    const fn = typeof a === "function" ? a : b;
    const { re, keys } = compile(pattern);
    this.routes.push({ method, pattern, re, keys, opts, fn });
    return this;
  }

  get(p, a, b) { return this.add("GET", p, a, b); }
  post(p, a, b) { return this.add("POST", p, a, b); }
  put(p, a, b) { return this.add("PUT", p, a, b); }
  patch(p, a, b) { return this.add("PATCH", p, a, b); }
  delete(p, a, b) { return this.add("DELETE", p, a, b); }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(method === "HEAD" && r.method === "GET")) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }

  /**
   * Returns true when a route handled the request, false when nothing matched
   * (so server.mjs can fall through to static files). `authenticate(req)`
   * resolves to the signed-in admin or null.
   */
  async handle(req, res, url, { authenticate }) {
    const hit = this.match(req.method, url.pathname);
    if (!hit) return false;
    if (hit.methodNotAllowed) {
      sendJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    const { route, params } = hit;
    try {
      let admin = null;
      if (!route.opts.public && !route.opts.agent) {
        admin = await authenticate(req);
        if (!admin) throw httpError(401, "Sign in first.");
        // Cookie auth + JSON API: refuse cross-site writes outright.
        if (req.method !== "GET" && req.method !== "HEAD") {
          const origin = req.headers.origin;
          if (origin) {
            let host = null;
            try {
              host = new URL(origin).host;
            } catch {
              host = null; // "null" (sandboxed/opaque origins) is never same-origin
            }
            if (host !== req.headers.host) throw httpError(403, "Cross-origin request refused.");
          }
        }
      }
      const query = Object.fromEntries(url.searchParams);
      let body = {};
      if (!route.opts.raw && req.method !== "GET" && req.method !== "HEAD") {
        body = await readJsonBody(req, route.opts.limit);
      }
      const out = await route.fn(req, res, { params, query, body, admin, url });
      if (!res.headersSent && !res.writableEnded) {
        sendJson(res, 200, out === undefined ? { ok: true } : out);
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(`[fcc] ${req.method} ${url.pathname}`, err);
      if (!res.headersSent) sendJson(res, status, { error: err.message, ...(err.extra || {}) });
      else res.end();
    }
    return true;
  }
}
