/**
 * Cloudflare's API, for the parts a tunnel needs.
 *
 * The panel can already run a connector if you paste its token, but getting
 * that token means going to the Cloudflare dashboard, making a tunnel, then
 * coming back — and every hostname after that is another round trip to a
 * different website. With an API token instead, the whole thing happens here:
 * create the connector, take its token, point hostnames at local ports, and
 * write the DNS records that make those hostnames resolve.
 *
 * The token needs three permissions:
 *   Account · Cloudflare Tunnel · Edit    (create the connector, set ingress)
 *   Zone    · DNS               · Edit    (point the hostname at it)
 *   Zone    · Zone              · Read    (list the domains you own)
 *
 * Everything here is plain fetch against api.cloudflare.com — no SDK, in
 * keeping with the rest of this codebase having no dependencies.
 */

const API = "https://api.cloudflare.com/client/v4";

/**
 * One request. Cloudflare answers with { success, errors, result }, and the
 * errors array is where anything useful lives — a bare status code tells you
 * nothing about which permission is missing.
 */
async function cf(token, path, { method = "GET", body, timeoutMs = 20_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new Error(
      err.name === "AbortError" ? "Cloudflare did not answer in time." : `Could not reach Cloudflare: ${err.message}`,
    );
  } finally {
    clearTimeout(t);
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    /* handled below */
  }
  if (!json) throw new Error(`Cloudflare returned ${res.status} with nothing readable in it.`);

  if (!json.success) {
    const first = (json.errors || [])[0];
    const detail = first?.error_chain?.[0]?.message;
    const message = [first?.message, detail].filter(Boolean).join(" — ") || `HTTP ${res.status}`;
    const err = new Error(cfHint(first?.code, message));
    err.code = first?.code;
    err.status = res.status;
    throw err;
  }
  return json.result;
}

/** Turn the codes people actually hit into something actionable. */
function cfHint(code, message) {
  if (code === 10000 || code === 9109) {
    return `${message}. The API token is missing a permission — it needs Account · Cloudflare Tunnel · Edit, Zone · DNS · Edit and Zone · Zone · Read.`;
  }
  if (code === 81053) return `${message}. A DNS record with that name already exists — pick another hostname or remove the old record.`;
  if (code === 1000) return `${message}. That looks like a Global API Key; this needs an API token instead.`;
  if (/Authorization header/i.test(message)) {
    return `${message}. Copy the whole token from the Cloudflare dashboard — it is shown once, when the token is created.`;
  }
  return message;
}

// ------------------------------------------------------------------ account

/** Is this token real, and what is it allowed to do? */
export async function verifyToken(token) {
  const result = await cf(token, "/user/tokens/verify");
  return { status: result.status, id: result.id, expiresOn: result.expires_on || null };
}

export async function listAccounts(token) {
  const result = await cf(token, "/accounts?per_page=50");
  return result.map((a) => ({ id: a.id, name: a.name }));
}

/** Every zone the token can see, so a hostname can be checked against them. */
export async function listZones(token, accountId) {
  const q = accountId ? `?account.id=${encodeURIComponent(accountId)}&per_page=50` : "?per_page=50";
  const result = await cf(token, `/zones${q}`);
  return result.map((z) => ({ id: z.id, name: z.name, status: z.status }));
}

/** The zone a hostname belongs to: the longest suffix match wins. */
export function zoneForHostname(zones, hostname) {
  const host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  if (!host) return null;
  let best = null;
  for (const z of zones) {
    const name = z.name.toLowerCase();
    if (host === name || host.endsWith(`.${name}`)) {
      if (!best || name.length > best.name.length) best = z;
    }
  }
  return best;
}

// ------------------------------------------------------------------ tunnels

export async function listTunnels(token, accountId) {
  const result = await cf(token, `/accounts/${accountId}/cfd_tunnel?is_deleted=false&per_page=50`);
  return result.map(publicTunnel);
}

export async function getTunnel(token, accountId, tunnelId) {
  return publicTunnel(await cf(token, `/accounts/${accountId}/cfd_tunnel/${tunnelId}`));
}

/**
 * A new connector, configured from Cloudflare's side.
 *
 * config_src "cloudflare" is what makes the ingress rules live in the account
 * rather than in a local config file — which is the whole point here: the
 * panel edits them through the API, and the connector picks them up without
 * being restarted.
 */
export async function createTunnel(token, accountId, name) {
  const clean = String(name || "").trim();
  if (!clean) throw new Error("The tunnel needs a name.");
  const result = await cf(token, `/accounts/${accountId}/cfd_tunnel`, {
    method: "POST",
    body: { name: clean, config_src: "cloudflare" },
  });
  return publicTunnel(result);
}

export async function deleteTunnel(token, accountId, tunnelId) {
  await cf(token, `/accounts/${accountId}/cfd_tunnel/${tunnelId}`, { method: "DELETE" });
  return { ok: true };
}

/** The connector token — the same string the dashboard shows you to paste. */
export async function tunnelToken(token, accountId, tunnelId) {
  const result = await cf(token, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`);
  if (typeof result !== "string" || !result) throw new Error("Cloudflare did not return a connector token for that tunnel.");
  return result;
}

function publicTunnel(t) {
  return {
    id: t.id,
    name: t.name,
    status: t.status || null, // healthy | degraded | down | inactive
    createdAt: t.created_at || null,
    connections: (t.connections || []).length,
    // A tunnel whose config lives locally cannot be edited from here.
    remotelyManaged: t.remote_config !== false,
  };
}

// ------------------------------------------------------------------ ingress

/**
 * The hostname → local service rules.
 *
 * Cloudflare stores them as an ordered list ending in a catch-all; that last
 * entry has no hostname and is not something anyone means to edit, so it is
 * kept out of the way here and put back on every write.
 */
export async function getRoutes(token, accountId, tunnelId) {
  const result = await cf(token, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`);
  const ingress = result?.config?.ingress || [];
  return ingress
    .filter((r) => r.hostname)
    .map((r) => ({ hostname: r.hostname, path: r.path || "", service: r.service }));
}

export async function putRoutes(token, accountId, tunnelId, routes) {
  const ingress = routes
    .filter((r) => r.hostname && r.service)
    .map((r) => {
      const rule = { hostname: r.hostname, service: r.service };
      if (r.path) rule.path = r.path;
      return rule;
    });
  // Without a catch-all Cloudflare rejects the whole configuration.
  ingress.push({ service: "http_status:404" });
  await cf(token, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
    method: "PUT",
    body: { config: { ingress } },
  });
  return ingress.length - 1;
}

// ---------------------------------------------------------------------- DNS

/**
 * Point a hostname at the tunnel.
 *
 * A proxied CNAME to <tunnel id>.cfargotunnel.com is how a tunnel hostname
 * resolves; it has to be proxied, because that target only means anything
 * inside Cloudflare's network.
 */
export async function pointHostnameAtTunnel(token, zoneId, hostname, tunnelId) {
  const content = `${tunnelId}.cfargotunnel.com`;
  const existing = await cf(
    token,
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}&per_page=10`,
  );
  const mine = existing.find((r) => r.type === "CNAME" && r.content === content);
  if (mine) return { id: mine.id, created: false, replaced: false };

  const clash = existing[0];
  if (clash) {
    // Overwriting someone's A record silently would be unforgivable; but a
    // CNAME already pointing at another tunnel is ours to move.
    if (clash.type !== "CNAME" || !/\.cfargotunnel\.com$/.test(clash.content || "")) {
      throw new Error(
        `${hostname} already has a ${clash.type} record pointing at ${clash.content}. Remove it in Cloudflare first, or use a different hostname.`,
      );
    }
    const updated = await cf(token, `/zones/${zoneId}/dns_records/${clash.id}`, {
      method: "PUT",
      body: { type: "CNAME", name: hostname, content, proxied: true, ttl: 1 },
    });
    return { id: updated.id, created: false, replaced: true };
  }

  const made = await cf(token, `/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: {
      type: "CNAME",
      name: hostname,
      content,
      proxied: true,
      ttl: 1,
      comment: "Forthway Command Center",
    },
  });
  return { id: made.id, created: true, replaced: false };
}

/** Remove the CNAME for a hostname, but only if it is one of ours. */
export async function unpointHostname(token, zoneId, hostname) {
  const existing = await cf(
    token,
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}&per_page=10`,
  );
  const mine = existing.find((r) => r.type === "CNAME" && /\.cfargotunnel\.com$/.test(r.content || ""));
  if (!mine) return { deleted: false };
  await cf(token, `/zones/${zoneId}/dns_records/${mine.id}`, { method: "DELETE" });
  return { deleted: true };
}

/** A hostname is only usable if it is a real host under a zone we can edit. */
export function validHostname(hostname) {
  const h = String(hostname || "").trim().toLowerCase();
  if (!h || h.length > 253) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) return null;
  return h;
}

// ------------------------------------------------------- logging in instead

/**
 * What `cloudflared tunnel login` leaves behind.
 *
 * The browser login writes an origin certificate, and tucked into the end of
 * that PEM file is a base64 blob holding the account it was issued for and an
 * API token scoped to it. That is what makes "log in" an alternative to
 * "make a token in the dashboard and paste it": the same credentials arrive,
 * they just arrive by a different road.
 *
 * The block is cloudflared's own format rather than a documented API, so this
 * reads it defensively and returns null rather than guessing when the shape is
 * not what we expect — the caller falls back to asking for a token.
 */
export function readOriginCert(text) {
  const m = String(text || "").match(/-----BEGIN ARGO TUNNEL TOKEN-----([\s\S]*?)-----END ARGO TUNNEL TOKEN-----/);
  if (!m) return null;
  let json;
  try {
    json = JSON.parse(Buffer.from(m[1].replace(/\s+/g, ""), "base64").toString("utf8"));
  } catch {
    return null;
  }
  const accountId = json.accountID || json.accountTag || json.account_id || "";
  const apiToken = json.apiToken || json.api_token || "";
  if (!accountId || !apiToken) return null;
  return { accountId, apiToken, zoneId: json.zoneID || json.zone_id || "" };
}

/**
 * Can these credentials actually do the work?
 *
 * The token inside the certificate is scoped by Cloudflare, not by us, so
 * rather than assume, ask: list the account's tunnels. If that works, every
 * other call here will too.
 */
export async function canManageTunnels(token, accountId) {
  try {
    await cf(token, `/accounts/${accountId}/cfd_tunnel?per_page=1`);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
