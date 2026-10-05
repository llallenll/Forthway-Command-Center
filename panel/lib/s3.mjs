/**
 * DATA — minimal S3-compatible client (AWS S3, Cloudflare R2, Backblaze B2,
 * MinIO, Wasabi…). AWS Signature V4 with node:crypto, uploads streamed from
 * disk with node:http(s). Single PUT only (S3 caps those at 5 GB).
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MAX_SINGLE_PUT = 5 * 1024 * 1024 * 1024;

const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
const sha256hex = (data) => crypto.createHash("sha256").update(data).digest("hex");

/** RFC 3986 encoding as SigV4 wants it; `/` kept when encoding a key path. */
export function uriEncode(str, keepSlash = false) {
  return Array.from(Buffer.from(String(str), "utf8"))
    .map((b) => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === "/")) return c;
      return `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

/**
 * Sign a request. Returns the headers to send (incl. Authorization).
 *   { method, host, path (already encoded), query: {k:v}, headers: {}, payloadHash,
 *     accessKey, secretKey, region, service = "s3", date = new Date() }
 */
export function signV4({ method, host, path, query = {}, headers = {}, payloadHash, accessKey, secretKey, region, service = "s3", date = new Date() }) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])) };
  all.host = host;
  all["x-amz-date"] = amzDate;
  all["x-amz-content-sha256"] = payloadHash;
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((k) => `${k}:${all[k].replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join("&");
  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${secretKey}`, day);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(toSign).digest("hex");
  delete all.host; // node sets Host itself
  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    _signature: signature,
  };
}

export function createS3({ endpoint, bucket, region, accessKey, secretKey, prefix = "", pathStyle = true }) {
  if (!endpoint || !bucket || !accessKey || !secretKey) throw new Error("S3 destination is incomplete (endpoint, bucket, access key and secret key are required).");
  const base = new URL(/^https?:\/\//.test(endpoint) ? endpoint : `https://${endpoint}`);
  const reg = region || "us-east-1";
  const pfx = String(prefix || "").replace(/^\/+|\/+$/g, "");

  const keyFor = (rel) => (pfx ? `${pfx}/${rel}` : rel).replace(/\/{2,}/g, "/");

  function target(key) {
    const host = pathStyle ? base.host : `${bucket}.${base.host}`;
    const basePath = base.pathname.replace(/\/+$/, "");
    const p = pathStyle ? `${basePath}/${uriEncode(bucket)}/${uriEncode(key, true)}` : `${basePath}/${uriEncode(key, true)}`;
    return { host, path: p };
  }

  function request(method, key, { headers = {}, payloadHash = EMPTY_SHA256, body = null, timeoutMs = 0 } = {}) {
    const { host, path } = target(key);
    const signed = signV4({ method, host, path, headers, payloadHash, accessKey, secretKey, region: reg });
    delete signed._signature;
    const mod = base.protocol === "http:" ? http : https;
    return new Promise((resolve, reject) => {
      const req = mod.request(
        { method, protocol: base.protocol, hostname: pathStyle ? base.hostname : `${bucket}.${base.hostname}`, port: base.port || undefined, path, headers: signed },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.length < 64 && chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ status: res.statusCode, headers: res.headers, text });
            const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
            const msg = /<Message>([^<]*)<\/Message>/.exec(text)?.[1];
            reject(new Error(`S3 ${method} ${key} failed: HTTP ${res.statusCode}${code ? ` ${code}` : ""}${msg ? ` — ${msg}` : ""}`));
          });
        },
      );
      req.on("error", reject);
      if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error("S3 request timed out")));
      if (body && typeof body.pipe === "function") body.pipe(req);
      else req.end(body || undefined);
    });
  }

  return {
    keyFor,
    /** Upload a file whose sha256 (hex) is already known. */
    async putFile(key, file, { sha256, contentType = "application/octet-stream" } = {}) {
      const size = fs.statSync(file).size;
      if (size > MAX_SINGLE_PUT) throw new Error("File is larger than 5 GB; S3 single uploads stop there.");
      const hash = sha256 || (await new Promise((res, rej) => {
        const h = crypto.createHash("sha256");
        fs.createReadStream(file).on("data", (d) => h.update(d)).on("end", () => res(h.digest("hex"))).on("error", rej);
      }));
      await request("PUT", key, {
        headers: { "content-length": String(size), "content-type": contentType },
        payloadHash: hash,
        body: fs.createReadStream(file),
      });
      return { key, size };
    },
    async putBuffer(key, buf, contentType = "text/plain") {
      await request("PUT", key, { headers: { "content-length": String(buf.length), "content-type": contentType }, payloadHash: sha256hex(buf), body: buf, timeoutMs: 30_000 });
      return { key };
    },
    async deleteObject(key) {
      await request("DELETE", key, { timeoutMs: 30_000 });
    },
    /** Write and delete a tiny object: proves endpoint, bucket and credentials work. */
    async test() {
      const key = keyFor(`.fcc-test-${Date.now()}`);
      await this.putBuffer(key, Buffer.from("fcc destination test\n"));
      await this.deleteObject(key);
      return { ok: true, key };
    },
  };
}
