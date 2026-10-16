/**
 * Continuous Integration — impact analysis and checkout planning (pure, no I/O
 * beyond the zip buffers it is handed).
 *
 * The panel runs this on the main server when an update (a new release) needs
 * checking. Given the new release and the one the website is serving, it works
 * out:
 *
 *   1. what changed — file by file, from the two archives' CRCs, so it works the
 *      same for a GitHub pull and a zip upload and costs no GitHub API calls;
 *   2. what that touches — an import graph of the new release (relative imports,
 *      tsconfig/jsconfig `paths` aliases such as `@/*`, CSS @import), walked
 *      backwards from every changed file, so editing `components/Nav.tsx` pulls
 *      in every page that renders the nav;
 *   3. which routes to smoke test (Next.js App Router and Pages Router), which
 *      test files are related, and which critical suites (payments, auth…) must
 *      run — always, or because they own a touched path;
 *   4. a quick static scan of the changed lines (typos, leftover console.log,
 *      merge-conflict markers, committed secrets);
 *   5. how to split the work into checkouts that agent servers run in parallel.
 *
 * Checkouts themselves run in shared/ci.mjs. Severity scale everywhere:
 * low < medium < high < extreme.
 */

import path from "node:path";

import { listZipEntries, readZipEntry, detectRootPrefix } from "./zip.mjs";

export const CI_IMPACT_VERSION = "1.0.0";
export const SEVERITIES = ["low", "medium", "high", "extreme"];
export const sevRank = (s) => SEVERITIES.indexOf(s);
export const isSeverity = (s) => SEVERITIES.includes(s);
export const worstOf = (list) => list.reduce((w, s) => (sevRank(s) > sevRank(w) ? s : w), null);

const MAX_SOURCE_BYTES = 1024 * 1024; // larger files are not parsed for imports
const MAX_GRAPH_FILES = 8000;
const MAX_PROBES = 40;
const MAX_LIST = 400; // changed/affected lists kept in a plan

const CODE_RE = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/i;
const STYLE_RE = /\.(css|scss|sass|less)$/i;
const TEXT_RE = /\.(tsx?|jsx?|mjs|cjs|mts|cts|json|css|scss|sass|less|md|mdx|html?|php|ya?ml|txt|env(\.\w+)?)$/i;
const SKIP_DIR_RE = /^(node_modules|\.next|\.git|dist|build|out|coverage|\.turbo|\.vercel|\.forthway|\.fcc-ci)\//;
const JUNK_RE = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/i;
const RESOLVE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json", ".css", ".scss"];

/** Files whose change can affect everything: a full check instead of a targeted one. */
const GLOBAL_FILES = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^pnpm-lock\.yaml$/,
  /^tsconfig(\.[\w-]+)?\.json$/,
  /^jsconfig\.json$/,
  /^next\.config\.[cm]?[jt]s$/,
  /^(src\/)?middleware\.[jt]s$/,
  /^(src\/)?instrumentation\.[jt]s$/,
  /^(vitest|jest|vite)\.config\.[cm]?[jt]s$/,
  /^postcss\.config\.[cm]?[jt]s$/,
  /^tailwind\.config\.[cm]?[jt]s$/,
  /^\.babelrc$/,
  /^babel\.config\.[cm]?js$/,
];

export const isTestFile = (p) => /(^|\/)(__tests__|tests?)\/.+\.[cm]?[jt]sx?$|\.(test|spec)\.[cm]?[jt]sx?$/.test(p) && !SKIP_DIR_RE.test(p);
export const isGlobalFile = (p) => GLOBAL_FILES.some((re) => re.test(p));
const isCode = (p) => CODE_RE.test(p);

// ---------------------------------------------------------------- archives

/**
 * A release zip as a map of relative path → { crc, size, entry }. The wrapping
 * folder GitHub (and Finder) put around everything is stripped, like a deploy does.
 */
export function zipIndex(buf) {
  const entries = listZipEntries(buf);
  const prefix = detectRootPrefix(entries);
  const files = new Map();
  for (const e of entries) {
    if (e.isDir || JUNK_RE.test(e.name)) continue;
    const rel = prefix && e.name.startsWith(prefix) ? e.name.slice(prefix.length) : e.name;
    if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) continue;
    files.set(rel, { crc: e.crc, size: e.size, entry: e });
  }
  return { buf, files };
}

export function readText(index, rel, max = MAX_SOURCE_BYTES) {
  const f = index?.files.get(rel);
  if (!f || f.size > max) return null;
  try {
    return readZipEntry(index.buf, f.entry).toString("utf8");
  } catch {
    return null;
  }
}

/** Changed files between two indexes (oldIndex null = first deploy: everything is "added"). */
export function diffIndexes(next, prev) {
  const out = [];
  for (const [p, f] of next.files) {
    if (SKIP_DIR_RE.test(p)) continue;
    const o = prev?.files.get(p);
    if (!o) out.push({ path: p, kind: "added" });
    else if (o.crc !== f.crc || o.size !== f.size) out.push({ path: p, kind: "modified" });
  }
  if (prev) for (const p of prev.files.keys()) if (!next.files.has(p) && !SKIP_DIR_RE.test(p)) out.push({ path: p, kind: "removed" });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// ----------------------------------------------------------------- imports

const IMPORT_RES = [
  /(?:^|[^\w$.])import\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?["']([^"'\n]+)["']/g,
  /(?:^|[^\w$.])export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s+["']([^"'\n]+)["']/g,
  /(?:^|[^\w$.])import\(\s*["']([^"'\n]+)["']\s*\)/g,
  /(?:^|[^\w$.])require\(\s*["']([^"'\n]+)["']\s*\)/g,
  /(?:^|[^\w$.])(?:vi|jest)\.mock\(\s*["']([^"'\n]+)["']/g,
];
const CSS_IMPORT_RE = /@(?:import|use|forward)\s+(?:url\()?\s*["']([^"'\n]+)["']/g;

/** Module specifiers a source file imports. Over-approximates (a commented-out import still counts), never misses a plain one. */
export function parseImports(src, file = "") {
  const out = new Set();
  const res = STYLE_RE.test(file) ? [CSS_IMPORT_RE] : IMPORT_RES;
  for (const re of res) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) out.add(m[1]);
  }
  return [...out];
}

/** JSON with comments and trailing commas (tsconfig.json). Returns null when it still is not JSON. */
export function parseLooseJson(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to the lenient parse */
  }
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}

/** Path aliases from tsconfig/jsconfig: [{ prefix: "@/", targets: [""] }] plus baseUrl. */
export function aliasesFrom(tsconfig) {
  const co = tsconfig?.compilerOptions || {};
  const baseUrl = typeof co.baseUrl === "string" ? path.posix.normalize(co.baseUrl).replace(/^\.\/?$/, "").replace(/^\.\//, "") : null;
  const base = baseUrl || "";
  const aliases = [];
  for (const [key, vals] of Object.entries(co.paths || {})) {
    if (!Array.isArray(vals)) continue;
    const wild = key.endsWith("*");
    const prefix = wild ? key.slice(0, -1) : key;
    const targets = vals
      .filter((v) => typeof v === "string")
      .map((v) => path.posix.normalize(path.posix.join(base, wild ? v.replace(/\*$/, "") : v)).replace(/^\.\/?/, ""));
    aliases.push({ prefix, exact: !wild, targets });
  }
  aliases.sort((a, b) => b.prefix.length - a.prefix.length);
  return { aliases, baseUrl };
}

/** resolve(fromFile, specifier) → a file in the release, or null (a package, or not found). */
export function makeResolver(fileSet, { aliases = [], baseUrl = null } = {}) {
  const tryFile = (p) => {
    p = path.posix.normalize(p).replace(/^\.\//, "");
    if (p.startsWith("../")) return null;
    if (fileSet.has(p)) return p;
    // TS ESM style: "./util.js" written for "./util.ts".
    const js = /\.(m|c)?jsx?$/.exec(p);
    if (js) {
      const stem = p.slice(0, -js[0].length);
      for (const e of js[1] === "m" ? [".mts"] : js[1] === "c" ? [".cts"] : [".ts", ".tsx"]) if (fileSet.has(stem + e)) return stem + e;
    }
    for (const e of RESOLVE_EXT) if (fileSet.has(p + e)) return p + e;
    for (const e of RESOLVE_EXT) if (fileSet.has(`${p}/index${e}`)) return `${p}/index${e}`;
    return null;
  };
  return (from, spec) => {
    if (!spec || /^[a-z][\w+.-]*:/i.test(spec)) return null; // node:fs, https://…
    spec = spec.split("?")[0];
    if (spec.startsWith(".")) return tryFile(path.posix.join(path.posix.dirname(from), spec));
    if (spec.startsWith("/")) return tryFile(spec.slice(1));
    for (const a of aliases) {
      if (a.exact ? spec !== a.prefix : !spec.startsWith(a.prefix)) continue;
      const rest = a.exact ? "" : spec.slice(a.prefix.length);
      for (const t of a.targets) {
        const hit = tryFile(path.posix.join(t || ".", rest));
        if (hit) return hit;
      }
    }
    if (spec.startsWith("~/")) return tryFile(spec.slice(2));
    if (baseUrl !== null) return tryFile(path.posix.join(baseUrl || ".", spec));
    return null;
  };
}

/** deps: file → Set(files it imports); rdeps: file → Set(files importing it). */
export function buildGraph(sources, resolve) {
  const deps = new Map();
  const rdeps = new Map();
  for (const [file, src] of sources) {
    const set = new Set();
    for (const spec of parseImports(src, file)) {
      const hit = resolve(file, spec);
      if (hit && hit !== file) set.add(hit);
    }
    deps.set(file, set);
    for (const d of set) {
      if (!rdeps.has(d)) rdeps.set(d, new Set());
      rdeps.get(d).add(file);
    }
  }
  return { deps, rdeps };
}

/** Every file that (transitively) imports one of `changed`, plus the changed files themselves. via: file → the file it was reached from. */
export function affectedBy(changed, rdeps) {
  const seen = new Set();
  const via = new Map();
  const queue = [];
  for (const c of changed) if (!seen.has(c)) (seen.add(c), queue.push(c));
  while (queue.length) {
    const f = queue.shift();
    for (const r of rdeps.get(f) || []) {
      if (seen.has(r)) continue;
      seen.add(r);
      via.set(r, f);
      queue.push(r);
    }
  }
  return { files: seen, via };
}

// ------------------------------------------------------------------ routes

const APP_ROUTE_RE = /^(?:src\/)?app\/(?:(.*)\/)?(page|route|layout|template|loading|error|not-found|default|global-error)\.(tsx|jsx|ts|js|mdx|md)$/;
const PAGES_ROUTE_RE = /^(?:src\/)?pages\/(.+)\.(tsx|jsx|ts|js|mdx|md)$/;

/**
 * The URL a Next.js file serves, or null. kind: "page" | "api" | "layout" (layout,
 * template, error… — affects every page beneath `dir`).
 */
export function nextRoute(file) {
  let m = APP_ROUTE_RE.exec(file);
  if (m) {
    const dir = m[1] || "";
    const segs = dir ? dir.split("/") : [];
    if (segs.some((s) => s.startsWith("_"))) return null; // private folders are not routes
    const urlSegs = segs.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"));
    const route = "/" + urlSegs.join("/");
    const kind = m[2] === "page" ? "page" : m[2] === "route" ? "api" : "layout";
    if (kind === "layout") return { kind, route, file, dir: file.replace(/\/[^/]+$/, "/"), dynamic: false };
    return { kind, route, file, dynamic: urlSegs.some((s) => /^\[.*\]$/.test(s)) };
  }
  m = PAGES_ROUTE_RE.exec(file);
  if (m) {
    const rel = m[1];
    if (/^_(app|document)$/.test(rel)) return { kind: "layout", route: "/", file, dir: file.replace(/[^/]+$/, ""), dynamic: false };
    if (/(^|\/)_/.test(rel) || isTestFile(file)) return null;
    const segs = rel.split("/");
    if (segs[segs.length - 1] === "index") segs.pop();
    const route = "/" + segs.join("/");
    return { kind: rel.startsWith("api/") ? "api" : "page", route, file, dynamic: segs.some((s) => /^\[.*\]$/.test(s)) };
  }
  return null;
}

// ------------------------------------------------------------------- globs

export function globToRegex(glob) {
  let re = "";
  const g = String(glob).trim().replace(/^\.\//, "").replace(/^\//, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") (i++, (re += "(?:.*/)?"));
        else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end === -1) re += "\\{";
      else {
        re += "(?:" + g.slice(i + 1, end).split(",").map((x) => x.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|") + ")";
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  // A bare folder ("lib/payments") or "lib/payments/" means everything under it.
  if (!/[*?{]/.test(g) && !/\.[\w]+$/.test(g)) re += "(?:/.*)?";
  return new RegExp(`^${re}$`);
}
export const matchesAny = (file, globs) => (globs || []).some((g) => globToRegex(g).test(file));

// ------------------------------------------------------------ static scan

/** Common misspellings → correction (lowercase). Checked in strings, JSX text and docs on changed lines. */
const TYPOS = {
  teh: "the", adn: "and", recieve: "receive", recieved: "received", reciept: "receipt", seperate: "separate", seperately: "separately",
  definately: "definitely", occured: "occurred", occurence: "occurrence", untill: "until", wich: "which", becuase: "because", beacuse: "because",
  acheive: "achieve", accomodate: "accommodate", adress: "address", agressive: "aggressive", apparantly: "apparently", arguement: "argument",
  begining: "beginning", beleive: "believe", buisness: "business", calender: "calendar", catagory: "category", comming: "coming", commited: "committed",
  completly: "completely", concious: "conscious", curiousity: "curiosity", enviroment: "environment", existance: "existence", experiance: "experience",
  familar: "familiar", finaly: "finally", foriegn: "foreign", freind: "friend", goverment: "government", gaurantee: "guarantee", happend: "happened",
  harrass: "harass", immediatly: "immediately", independant: "independent", knowlege: "knowledge", liason: "liaison", libary: "library", lisence: "license",
  maintainance: "maintenance", millenium: "millennium", neccessary: "necessary", necesary: "necessary", noticable: "noticeable", occassion: "occasion",
  persistant: "persistent", posession: "possession", prefered: "preferred", privelege: "privilege", priviledge: "privilege", publically: "publicly",
  realy: "really", recomend: "recommend", reccomend: "recommend", refered: "referred", relevent: "relevant", remeber: "remember", resistence: "resistance",
  responsability: "responsibility", rythm: "rhythm", sucess: "success", succesful: "successful", successfull: "successful", suprise: "surprise",
  tommorow: "tomorrow", tomorow: "tomorrow", truely: "truly", wierd: "weird", whereever: "wherever", writting: "writing", acount: "account",
  accross: "across", adressed: "addressed", alot: "a lot", anual: "annual", availible: "available", avaliable: "available", basicly: "basically",
  carefull: "careful", cancelation: "cancellation", checkuot: "checkout", comission: "commission", confimation: "confirmation", conection: "connection",
  contiune: "continue", custmer: "customer", costumer: "customer", delivary: "delivery", dependancy: "dependency", desciption: "description",
  diffrent: "different", dissapear: "disappear", embarass: "embarrass", emial: "email", exprience: "experience", fourty: "forty", grammer: "grammar",
  infomation: "information", informaton: "information", inital: "initial", intresting: "interesting", languege: "language", mesage: "message",
  messsage: "message", ocurred: "occurred", oppurtunity: "opportunity", paymnet: "payment", pament: "payment", passwrod: "password", perfomance: "performance",
  plese: "please", pleae: "please", proccess: "process", porduct: "product", prodcut: "product", purchace: "purchase", quantitiy: "quantity",
  recieving: "receiving", registeration: "registration", reponse: "response", sevice: "service", shiping: "shipping", shippment: "shipment",
  sigup: "signup", subcription: "subscription", subscribtion: "subscription", succeded: "succeeded", sumbit: "submit", submition: "submission",
  thier: "their", tranfer: "transfer", transfered: "transferred", unfortunatly: "unfortunately", usefull: "useful", vaild: "valid", verfy: "verify",
  welcom: "welcome", wether: "whether", youre: "you're", contactus: "contact us",
};

const SECRET_PATTERNS = [
  { re: /\bsk_live_[0-9a-zA-Z]{16,}/, sev: "extreme", what: "a live Stripe secret key" },
  { re: /\brk_live_[0-9a-zA-Z]{16,}/, sev: "extreme", what: "a live Stripe restricted key" },
  { re: /\bwhsec_[0-9a-zA-Z]{24,}/, sev: "high", what: "a Stripe webhook signing secret" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, sev: "extreme", what: "an AWS access key" },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, sev: "extreme", what: "a private key" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, sev: "extreme", what: "a GitHub token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/, sev: "extreme", what: "a GitHub token" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, sev: "high", what: "a Slack token" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, sev: "medium", what: "a Google API key" },
  { re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}/, sev: "high", what: "an AI provider API key" },
  { re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/, sev: "high", what: "a SendGrid key" },
];

/** Lines of `next` that are not in `prev` (multiset), with 1-based line numbers. prev null → every line. */
export function addedLines(next, prev) {
  const lines = String(next ?? "").split("\n");
  if (prev == null) return lines.map((text, i) => ({ line: i + 1, text }));
  const bag = new Map();
  for (const l of String(prev).split("\n")) bag.set(l, (bag.get(l) || 0) + 1);
  const out = [];
  lines.forEach((text, i) => {
    const n = bag.get(text) || 0;
    if (n > 0) bag.set(text, n - 1);
    else out.push({ line: i + 1, text });
  });
  return out;
}

const STRING_RE = /"((?:[^"\\\n]|\\.){3,})"|'((?:[^'\\\n]|\\.){3,})'|`([^`]{3,})`/g;
const JSX_TEXT_RE = />([^<>{}]*[A-Za-z]{3,}[^<>{}]*)</g;

/** Human-language fragments of one code line: string literals and JSX text. */
function proseOf(text, file) {
  if (/\.(md|mdx|txt|html?)$/i.test(file)) return [text];
  if (!isCode(file)) return [];
  const out = [];
  let m;
  STRING_RE.lastIndex = 0;
  while ((m = STRING_RE.exec(text))) {
    const s = m[1] ?? m[2] ?? m[3];
    if (/^[\w./@-]+$/.test(s) && !/\s/.test(s)) continue; // looks like an identifier, path, class list or import
    if (/^(?:[a-z0-9:_/[\]-]+\s*)+$/.test(s) && /[-:]/.test(s)) continue; // Tailwind classes
    out.push(s);
  }
  JSX_TEXT_RE.lastIndex = 0;
  while ((m = JSX_TEXT_RE.exec(text))) out.push(m[1]);
  return out;
}

export function typosIn(fragment) {
  const found = [];
  for (const w of String(fragment).match(/[A-Za-z][a-z]{2,}/g) || []) {
    const fix = TYPOS[w.toLowerCase()];
    if (fix) found.push({ word: w, fix });
  }
  return found;
}

/**
 * Findings for one changed file: { severity, check: "scan", title, detail, file, line }.
 * Only lines the update added are looked at, except for secrets in a newly
 * committed .env file, which are reported whatever the diff says.
 */
export function scanFile(file, next, prev) {
  const out = [];
  const add = (severity, title, line, detail = "") => out.push({ severity, check: "scan", title, detail, file, line: line || null });
  const base = file.split("/").pop();
  const isEnvFile = /^\.env(\.[\w.-]+)?$/.test(base) && !/example|sample|template|dist/i.test(base);
  if (isEnvFile && prev == null) {
    add("high", `Environment file ${base} is part of the release`, null, "Secrets belong in the website's Environment tab on the panel, not in the repository. Remove it and rotate anything it contained.");
  }
  if (next == null) return out;
  const test = isTestFile(file);
  const lines = addedLines(next, prev);
  let typoCount = 0;
  let logCount = 0;
  for (const { line, text } of lines) {
    if (/^(<{7}|>{7})(\s|$)|^={7}$/.test(text)) add("high", "Merge conflict marker left in the file", line, text.trim());
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(text) && !/process\.env|import\.meta\.env|example|placeholder|xxxx/i.test(text)) {
        add(test ? sevDown(p.sev) : p.sev, `Looks like ${p.what} is committed`, line, "Anyone who can read the repository or the release can use it. Move it to the panel's environment variables and rotate it.");
        break;
      }
    }
    if (!isCode(file)) {
      if (/\.(md|mdx|txt|html?)$/i.test(file) && typoCount < 20) {
        for (const t of typosIn(text)) (typoCount++, add("low", `Typo: "${t.word}" → "${t.fix}"`, line, text.trim().slice(0, 160)));
      }
      continue;
    }
    if (/^\s*debugger\s*;?\s*$/.test(text)) add("medium", "debugger statement left in", line, text.trim());
    if (!test && /(^|[^\w.])console\.log\(/.test(text) && !/^\s*\/\//.test(text) && logCount < 10) {
      logCount++;
      add("low", "console.log left in", line, text.trim().slice(0, 160));
    }
    if (typoCount < 20) {
      for (const frag of proseOf(text, file)) for (const t of typosIn(frag)) (typoCount++, add("low", `Typo: "${t.word}" → "${t.fix}"`, line, frag.trim().slice(0, 160)));
    }
  }
  return out;
}
const sevDown = (s) => SEVERITIES[Math.max(0, sevRank(s) - 1)];

// ------------------------------------------------------------ capabilities

const pick = (o, k) => (o && typeof o === "object" ? o[k] : undefined);

/** What a release brings for testing (package.json, configs, test files) — drives the plan and the readiness card. */
export function capabilities(index) {
  const has = (p) => index.files.has(p);
  const pkg = parseLooseJson(readText(index, "package.json")) || null;
  const scripts = pick(pkg, "scripts") || {};
  const deps = { ...(pick(pkg, "dependencies") || {}), ...(pick(pkg, "devDependencies") || {}) };
  const tsconfigFile = has("tsconfig.json") ? "tsconfig.json" : has("jsconfig.json") ? "jsconfig.json" : null;
  const testFiles = [...index.files.keys()].filter((p) => isTestFile(p) && !p.startsWith("e2e/") && !/(^|\/)(playwright|cypress)\//.test(p));
  const hasFile = (re) => [...index.files.keys()].some((p) => re.test(p));
  let runner = null;
  if (deps.vitest) runner = "vitest";
  else if (deps.jest || deps["ts-jest"]) runner = "jest";
  else if (/\bnode\s+--test\b/.test(scripts.test || "")) runner = "node";
  else if (scripts.test && !/no test specified/.test(scripts.test)) runner = "script";
  const typecheckScript = ["typecheck", "type-check", "check-types", "tsc"].find((k) => scripts[k]) || null;
  const eslintConfig = hasFile(/^(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.[\w]+)?)$/);
  let ci = null;
  if (has("fcc-ci.json")) {
    ci = parseLooseJson(readText(index, "fcc-ci.json"));
    if (!ci || typeof ci !== "object") ci = { error: "fcc-ci.json is not valid JSON — it was ignored." };
  }
  return {
    packageJson: !!pkg,
    packageName: pick(pkg, "name") || null,
    version: pick(pkg, "version") || null,
    next: !!deps.next,
    nextVersion: deps.next || null,
    scripts: Object.keys(scripts),
    build: !!scripts.build,
    start: !!scripts.start,
    typescript: !!(tsconfigFile === "tsconfig.json" && deps.typescript),
    tsconfigFile,
    typecheckScript,
    lint: !!(deps.eslint && eslintConfig),
    lintScript: scripts.lint ? "lint" : null,
    testRunner: runner,
    testScript: scripts.test && !/no test specified/.test(scripts.test) ? "test" : null,
    testFiles: testFiles.length,
    healthRoute: hasFile(/^(src\/)?app\/api\/health\/route\.[jt]s$/) || hasFile(/^(src\/)?pages\/api\/health\.[jt]s$/),
    versionRoute: hasFile(/^(src\/)?app\/api\/version\/route\.[jt]s$/),
    fccCi: ci,
    php: hasFile(/\.php$/),
  };
}

/** What would make CI better for this codebase, in plain words. Empty = nothing to add. */
export function readinessTips(caps, siteType = "node") {
  const tips = [];
  if (siteType === "php") {
    if (!caps.php) tips.push({ level: "info", text: "No .php files found in the release." });
    return tips;
  }
  if (!caps.packageJson) return [{ level: "warn", text: "No package.json — only the static scan and file checks can run." }];
  if (!caps.build) tips.push({ level: "warn", text: 'No "build" script: CI cannot prove the code compiles.' });
  if (caps.tsconfigFile === "tsconfig.json" && !caps.typescript) tips.push({ level: "info", text: "There is a tsconfig.json but typescript is not a dependency, so type checking is skipped." });
  if (!caps.typecheckScript && caps.typescript) tips.push({ level: "info", text: 'Add "typecheck": "tsc --noEmit" to package.json scripts — CI already runs tsc, but the script lets you run the same check locally.' });
  if (!caps.lint) tips.push({ level: "info", text: "No ESLint setup: lint checks are skipped." });
  if (!caps.testRunner) tips.push({ level: "warn", text: "No test runner (vitest or jest). CI still builds, smoke tests the affected pages and runs your critical suites, but there are no unit tests to pick from." });
  else if (!caps.testFiles && caps.testRunner !== "script") tips.push({ level: "info", text: `${caps.testRunner} is installed but there are no *.test.* files yet.` });
  if (siteType === "node" && !caps.healthRoute) tips.push({ level: "info", text: "No /api/health route — the smoke test waits for the home page instead." });
  if (!caps.fccCi) tips.push({ level: "info", text: "No fcc-ci.json: critical suites and sample paths for dynamic routes can live in the repository too (download a starter with the fcc-ci.json button)." });
  else if (caps.fccCi.error) tips.push({ level: "warn", text: caps.fccCi.error });
  return tips;
}

// ------------------------------------------------------------------ suites

/**
 * Critical suites from the panel and from the repository's fcc-ci.json, merged
 * (panel wins on the same id). A suite: { id, name, severity, always, paths[],
 * command?, needsBuild?, probes: [{ method, path, expect, contains? }] }.
 */
export function cleanSuites(list, source) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || typeof s !== "object") continue;
    const name = String(s.name || s.id || "").trim().slice(0, 80);
    if (!name) continue;
    const id = String(s.id || name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "suite";
    const probes = (Array.isArray(s.probes) ? s.probes : [])
      .map((p) => (typeof p === "string" ? parseProbe(p) : p))
      .filter((p) => p && typeof p.path === "string" && p.path.startsWith("/"))
      .slice(0, 20)
      .map((p) => ({
        method: /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/i.test(p.method || "") ? p.method.toUpperCase() : "GET",
        path: p.path.slice(0, 300),
        expect: Number.isInteger(+p.expect) && +p.expect >= 100 && +p.expect < 600 ? +p.expect : null,
        contains: typeof p.contains === "string" ? p.contains.slice(0, 200) : "",
        body: typeof p.body === "string" ? p.body.slice(0, 4000) : p.body && typeof p.body === "object" ? JSON.stringify(p.body).slice(0, 4000) : "",
      }));
    const command = typeof s.command === "string" ? s.command.trim().slice(0, 1000) : "";
    if (!command && !probes.length) continue;
    out.push({
      id,
      name,
      source,
      severity: isSeverity(s.severity) ? s.severity : "extreme",
      always: s.always !== false && !(Array.isArray(s.paths) && s.paths.length && s.always !== true),
      paths: (Array.isArray(s.paths) ? s.paths : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 40),
      command,
      needsBuild: !!s.needsBuild || (!command && probes.length > 0),
      probes,
    });
  }
  return out;
}

/** "GET /api/health 200" / "POST /api/checkout 400 contains:error" → probe. */
export function parseProbe(line) {
  const m = /^\s*(?:(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s+)?(\/\S*)(?:\s+(\d{3}))?(?:\s+contains:(.+))?\s*$/i.exec(String(line || ""));
  if (!m) return null;
  return { method: (m[1] || "GET").toUpperCase(), path: m[2], expect: m[3] ? Number(m[3]) : null, contains: m[4]?.trim() || "" };
}

export function mergeSuites(panelSuites, repoSuites) {
  const map = new Map();
  for (const s of cleanSuites(repoSuites, "repo")) map.set(s.id, s);
  for (const s of cleanSuites(panelSuites, "panel")) map.set(s.id, s);
  return [...map.values()];
}

// -------------------------------------------------------------------- plan

const sh = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

/**
 * The whole plan for one CI run.
 *
 *   planRun({ next: zipIndex, prev: zipIndex|null, site: { type, settings }, ci: siteCiSettings, runners: n })
 *   → { changed, affected, routes, probes, tests, suites, caps, tips, notes, scope, findings, checkouts }
 *
 * Each checkout: { key, name, kind: "build"|"verify"|"tests"|"php", steps: [{ id, label, kind, cmd?, … }] }.
 */
export function planRun({ next, prev = null, site = {}, ci = {}, runners = 1, buildCommands = {} }) {
  const notes = [];
  const type = site.type || "node";
  const caps = capabilities(next);
  const repo = caps.fccCi && !caps.fccCi.error ? caps.fccCi : {};
  const ignore = [...(Array.isArray(repo.ignore) ? repo.ignore : []), ...(ci.ignore || [])];

  // 1. what changed
  const changedAll = diffIndexes(next, prev);
  const changed = changedAll.filter((c) => !matchesAny(c.path, ignore));
  const changedPaths = changed.filter((c) => c.kind !== "removed").map((c) => c.path);
  const removedPaths = changed.filter((c) => c.kind === "removed").map((c) => c.path);
  const global = !prev || changed.some((c) => isGlobalFile(c.path));
  if (!prev) notes.push("Nothing is deployed yet, so everything counts as changed: a full check.");
  else if (global) notes.push(`A project-wide file changed (${changed.find((c) => isGlobalFile(c.path)).path}): every route and test is in scope.`);
  if (prev && !changed.length) notes.push("This release has the same files as the one that is live.");

  // 2. import graph of the new release
  const tsconfig = parseLooseJson(readText(next, caps.tsconfigFile || "tsconfig.json"));
  const resolve = makeResolver(new Set(next.files.keys()), aliasesFrom(tsconfig));
  const sources = new Map();
  for (const [p] of next.files) {
    if (sources.size >= MAX_GRAPH_FILES) break;
    if (SKIP_DIR_RE.test(p) || !(isCode(p) || STYLE_RE.test(p))) continue;
    const t = readText(next, p);
    if (t != null) sources.set(p, t);
  }
  const { rdeps } = buildGraph(sources, resolve);
  // A removed module: whoever still imports it (by the old graph) is affected too.
  const seeds = [...changedPaths];
  if (removedPaths.length && prev) {
    const oldSources = new Map();
    const oldResolve = makeResolver(new Set(prev.files.keys()), aliasesFrom(parseLooseJson(readText(prev, "tsconfig.json"))));
    for (const [p] of prev.files) if (!SKIP_DIR_RE.test(p) && isCode(p) && next.files.has(p)) oldSources.set(p, readText(prev, p) || "");
    const old = buildGraph(oldSources, oldResolve);
    for (const r of removedPaths) for (const imp of old.rdeps.get(r) || []) seeds.push(imp);
  }
  const { files: affectedSet, via } = affectedBy(seeds, rdeps);
  const allFiles = [...next.files.keys()].filter((p) => !SKIP_DIR_RE.test(p));
  const inScope = global ? new Set(allFiles) : affectedSet;

  // 3. routes
  const routeFiles = allFiles.map(nextRoute).filter(Boolean);
  const layouts = routeFiles.filter((r) => r.kind === "layout" && inScope.has(r.file));
  const routes = [];
  for (const r of routeFiles) {
    if (r.kind === "layout") continue;
    let reason = null;
    if (global) reason = "full check";
    else if (changedPaths.includes(r.file)) reason = "changed";
    else if (affectedSet.has(r.file)) reason = `imports ${chainFrom(r.file, via)}`;
    else if (r.kind === "page") {
      // Layouts, templates and error boundaries wrap pages — never route handlers.
      const l = layouts.find((x) => r.file.startsWith(x.dir));
      if (l) reason = `under ${l.file}`;
    }
    if (reason) routes.push({ ...r, reason });
  }
  const samples = { ...(repo.samples && typeof repo.samples === "object" ? repo.samples : {}), ...(ci.samples || {}) };
  const probes = [];
  const skippedRoutes = [];
  for (const r of routes.sort((a, b) => rankReason(a.reason) - rankReason(b.reason) || a.route.localeCompare(b.route))) {
    const sample = samples[r.route];
    if (r.dynamic && !sample) {
      skippedRoutes.push(r.route);
      continue;
    }
    for (const p of (Array.isArray(sample) ? sample : sample ? [sample] : [r.route]).slice(0, 3)) {
      if (probes.length >= MAX_PROBES) break;
      probes.push({ route: r.route, path: String(p), kind: r.kind, file: r.file, method: "GET" });
    }
  }
  if (skippedRoutes.length) notes.push(`Dynamic route${skippedRoutes.length === 1 ? "" : "s"} ${skippedRoutes.slice(0, 6).join(", ")}${skippedRoutes.length > 6 ? "…" : ""} not smoke tested — add a sample path for ${skippedRoutes.length === 1 ? "it" : "them"} under CI → Sample paths (or "samples" in fcc-ci.json).`);
  if (routes.length > MAX_PROBES) notes.push(`${routes.length} routes are affected; the first ${MAX_PROBES} are smoke tested.`);

  // 4. tests
  let tests = [];
  if (caps.testRunner && caps.testRunner !== "script") {
    const all = allFiles.filter((p) => isTestFile(p) && (caps.testRunner !== "node" || /\.[cm]?js$/.test(p)));
    tests = global ? all : all.filter((t) => inScope.has(t));
  }

  // 5. critical suites
  const suites = mergeSuites(ci.suites, repo.suites).map((s) => {
    if (s.always) return { ...s, reason: "always runs" };
    const hit = changedPaths.find((f) => matchesAny(f, s.paths)) || [...affectedSet].find((f) => matchesAny(f, s.paths)) || removedPaths.find((f) => matchesAny(f, s.paths));
    return hit ? { ...s, reason: `touches ${hit}` } : global ? { ...s, reason: "full check" } : { ...s, reason: null };
  });
  const selected = suites.filter((s) => s.reason);
  // A failing test that belongs to a critical suite carries that suite's severity.
  const testSeverity = (file) => worstOf(selected.filter((s) => matchesAny(file, s.paths)).map((s) => s.severity)) || "high";

  // 6. static scan of the changed lines (runs here, on the panel)
  const findings = [];
  for (const f of changedPaths) {
    if (!TEXT_RE.test(f) && !/(^|\/)\.env/.test(f)) continue;
    const n = readText(next, f, 2 * 1024 * 1024);
    const o = prev?.files.has(f) ? readText(prev, f, 2 * 1024 * 1024) : null;
    findings.push(...scanFile(f, n, o));
    const sz = next.files.get(f)?.size || 0;
    if (sz > 5 * 1024 * 1024 && !prev?.files.has(f)) findings.push({ severity: "low", check: "scan", title: `Large file added (${Math.round(sz / 1048576)} MB)`, detail: "Big files slow every deploy down. Object storage or a CDN is usually a better home.", file: f, line: null });
  }
  // A changed file that belongs to a suite marks scan findings in it at least "medium".
  for (const fd of findings) {
    const s = selected.find((x) => matchesAny(fd.file, x.paths));
    if (s && fd.severity === "low") fd.detail = `${fd.detail}${fd.detail ? "\n" : ""}(In ${s.name}.)`;
  }

  // 7. checkouts
  const checkouts = [];
  const b = buildCommands;
  const install = b.install ?? "npm install --no-audit --no-fund --include=dev";
  const node = type !== "php" && caps.packageJson;
  const lintable = [...inScope].filter((p) => isCode(p) && !p.endsWith(".d.ts") && !SKIP_DIR_RE.test(p) && next.files.has(p)).sort();
  const suiteCommands = selected.filter((s) => s.command);
  const suiteProbes = selected.filter((s) => s.probes.length);

  if (node) {
    const buildSteps = [{ id: "install", label: "Install dependencies", kind: "install", cmd: install, gate: true }];
    if (b.prepare) buildSteps.push({ id: "prepare", label: "Prepare", kind: "command", cmd: b.prepare, gate: true, severity: "high" });
    const buildCmd = b.build ?? (caps.build ? "npm run build" : "");
    if (buildCmd) buildSteps.push({ id: "build", label: "Build", kind: "build", cmd: buildCmd, gate: true });
    const canStart = type === "node" && (caps.start || b.start);
    if (canStart && (probes.length || suiteProbes.length)) {
      buildSteps.push({
        id: "smoke",
        label: `Smoke test ${probes.length} route${probes.length === 1 ? "" : "s"}`,
        kind: "smoke",
        start: b.start || "npm start",
        healthPath: b.healthPath || (caps.healthRoute ? "/api/health" : "/"),
        probes,
        suites: suiteProbes.map((s) => ({ id: s.id, name: s.name, severity: s.severity, probes: s.probes })),
      });
    } else if (type === "node" && !canStart && probes.length) notes.push('No "start" script, so affected routes cannot be smoke tested.');
    if (type === "static" && buildCmd) buildSteps.push({ id: "output", label: "Check build output", kind: "static-output", root: b.root || "" });
    for (const s of suiteCommands.filter((x) => x.needsBuild)) buildSteps.push({ id: `suite-${s.id}`, label: s.name, kind: "suite", cmd: s.command, severity: s.severity, suite: s.id });
    checkouts.push({ key: "build", name: buildCmd ? "Build & smoke test" : "Install & smoke test", kind: "build", steps: buildSteps });

    const verify = [];
    if (caps.typescript) {
      verify.push({ id: "typecheck", label: "Type check", kind: "typecheck", cmd: caps.typecheckScript ? `npm run -s ${caps.typecheckScript}` : "npx --no-install tsc --noEmit --pretty false" });
    }
    if (caps.lint && lintable.length) {
      const files = lintable.slice(0, 300);
      verify.push({ id: "lint", label: `Lint ${files.length} file${files.length === 1 ? "" : "s"}`, kind: "lint", cmd: `npx --no-install eslint -f json ${files.map(sh).join(" ")}` });
    }
    if (verify.length) checkouts.push({ key: "verify", name: verify.length === 2 ? "Types & lint" : verify[0].label, kind: "verify", steps: [{ id: "install", label: "Install dependencies", kind: "install", cmd: install, gate: true }, ...verify] });

    // Tests, split across as many checkouts as there are servers to run them.
    const plainSuites = suiteCommands.filter((x) => !x.needsBuild);
    const testRun = caps.testRunner === "script" ? (global || changed.length ? "all" : null) : tests.length ? "files" : null;
    const shards = Math.max(1, Math.min(Number(ci.maxCheckouts) > 2 ? Number(ci.maxCheckouts) - checkouts.length : 1, runners, testRun === "files" ? Math.ceil(tests.length / 3) : 1, 6));
    const buckets = Array.from({ length: shards }, () => ({ tests: [], suites: [] }));
    if (testRun === "files") tests.forEach((t, i) => buckets[i % shards].tests.push(t));
    plainSuites.forEach((s, i) => buckets[(i + (testRun === "files" ? 0 : 0)) % shards].suites.push(s));
    buckets.forEach((bk, i) => {
      const steps = [{ id: "install", label: "Install dependencies", kind: "install", cmd: install, gate: true }];
      if (testRun === "all" && i === 0) steps.push({ id: "tests", label: "Test suite", kind: "tests", runner: "script", cmd: "npm test", files: [] });
      if (bk.tests.length) {
        const out = ".fcc-ci/tests.json";
        const files = bk.tests.map(sh).join(" ");
        const cmd =
          caps.testRunner === "vitest" ? `npx --no-install vitest run --reporter=default --reporter=json --outputFile=${out} ${files}`
          : caps.testRunner === "jest" ? `npx --no-install jest --ci --json --outputFile=${out} --runTestsByPath ${files}`
          : `node --test ${files}`;
        steps.push({ id: "tests", label: `${bk.tests.length} related test file${bk.tests.length === 1 ? "" : "s"}`, kind: "tests", runner: caps.testRunner, cmd, files: bk.tests, report: out, severityOf: Object.fromEntries(bk.tests.map((t) => [t, testSeverity(t)])) });
      }
      for (const s of bk.suites) steps.push({ id: `suite-${s.id}`, label: s.name, kind: "suite", cmd: s.command, severity: s.severity, suite: s.id });
      if (steps.length > 1) checkouts.push({ key: `tests-${i + 1}`, name: shards > 1 ? `Tests ${i + 1}/${shards}` : "Tests", kind: "tests", steps });
    });
    if (caps.testRunner && caps.testRunner !== "script" && !tests.length && caps.testFiles) notes.push("No test file imports anything this update changed, so no unit tests were picked.");
  } else if (type === "php" || caps.php) {
    const phpFiles = [...inScope].filter((p) => p.endsWith(".php")).slice(0, 400);
    if (phpFiles.length) checkouts.push({ key: "php", name: "PHP syntax", kind: "php", steps: [{ id: "php-lint", label: `php -l on ${phpFiles.length} file${phpFiles.length === 1 ? "" : "s"}`, kind: "php-lint", files: phpFiles }] });
    for (const s of suiteCommands) (checkouts[0] ||= { key: "php", name: "Suites", kind: "php", steps: [] }).steps.push({ id: `suite-${s.id}`, label: s.name, kind: "suite", cmd: s.command, severity: s.severity, suite: s.id });
  }

  return {
    version: CI_IMPACT_VERSION,
    scope: !prev ? "full" : global ? "global" : "targeted",
    changed: changed.slice(0, MAX_LIST),
    changedCount: changed.length,
    affected: [...affectedSet].filter((f) => !changedPaths.includes(f)).sort().slice(0, MAX_LIST),
    affectedCount: Math.max(0, affectedSet.size - changedPaths.length),
    routes: routes.slice(0, MAX_LIST).map(({ route, kind, file, dynamic, reason }) => ({ route, kind, file, dynamic, reason })),
    probes,
    tests,
    suites: suites.map(({ id, name, severity, source, reason, always, paths, command, probes: p }) => ({ id, name, severity, source, reason, always, paths, command, probes: p.length })),
    caps: { ...caps, fccCi: caps.fccCi ? (caps.fccCi.error ? { error: caps.fccCi.error } : { present: true }) : null },
    tips: readinessTips(caps, type),
    notes,
    findings,
    checkouts,
  };
}

function rankReason(r) {
  return r === "changed" ? 0 : r?.startsWith("imports") ? 1 : 2;
}
function chainFrom(file, via, max = 3) {
  const chain = [];
  let f = via.get(file);
  while (f && chain.length < max) {
    chain.push(f);
    f = via.get(f);
  }
  return chain.length ? chain[chain.length - 1] + (chain.length > 1 ? ` (via ${chain[0]})` : "") : "a changed file";
}

/** A starter fcc-ci.json for a codebase (download from the panel). */
export function starterConfig(caps = {}, suites = []) {
  return {
    $schema: "https://forthway.dev/schemas/fcc-ci.json",
    "//": "Read by the Forthway Command Center's CI. Suites run on every update (always) or when an update touches their paths; their severity decides whether a failure blocks the deploy.",
    suites: suites.length
      ? suites.map(({ name, severity, always, paths, command, probes }) => ({ name, severity, always, paths, ...(command ? { command } : {}), ...(probes?.length ? { probes } : {}) }))
      : [
          { name: "Health", severity: "extreme", always: true, probes: ["GET /api/health 200"] },
          ...(caps.testRunner ? [{ name: "Payments", severity: "extreme", paths: ["app/api/checkout/**", "lib/payments/**"], command: "npm run test:payments" }] : []),
        ],
    samples: { "/blog/[slug]": "/blog/hello-world" },
    ignore: ["**/*.md", "docs/**"],
  };
}
