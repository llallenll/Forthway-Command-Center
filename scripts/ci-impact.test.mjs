// Unit tests for CI impact analysis and planning (shared/ci-impact.mjs).
// Run: node --test scripts/ci-impact.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import { makeZip } from "../shared/zipwrite.mjs";
import {
  zipIndex,
  diffIndexes,
  parseImports,
  parseLooseJson,
  aliasesFrom,
  makeResolver,
  nextRoute,
  globToRegex,
  addedLines,
  scanFile,
  planRun,
  parseProbe,
  cleanSuites,
} from "../shared/ci-impact.mjs";

const zip = (files, root = "acme-golden-threads-abc123/") =>
  zipIndex(makeZip(Object.entries(files).map(([name, text]) => ({ name: root + name, data: Buffer.from(text) }))));

const BASE = {
  "package.json": JSON.stringify({
    name: "golden-threads",
    version: "1.0.0",
    scripts: { build: "next build", start: "next start", lint: "eslint", typecheck: "tsc --noEmit", test: "vitest run" },
    dependencies: { next: "16.3.3", react: "19.2.8" },
    devDependencies: { typescript: "5.9.3", eslint: "9.39.0", vitest: "3.2.4" },
  }),
  "tsconfig.json": `{
    // comments and trailing commas, like the real thing
    "compilerOptions": { "strict": true, "paths": { "@/*": ["./*"], }, },
  }`,
  "eslint.config.mjs": "export default [];",
  "app/layout.tsx": 'import "./globals.css";\nexport default function L({ children }) { return children; }',
  "app/globals.css": '@import "tailwindcss";',
  "app/page.tsx": 'import Nav from "@/components/Nav";\nexport default function Home() { return <Nav />; }',
  "app/about/page.tsx": 'import { Nav } from "../../components";\nexport default function About() { return <main><Nav />About us</main>; }',
  "app/shop/[slug]/page.tsx": 'import { price } from "@/lib/payments/price";\nexport default function P() { return price(1); }',
  "app/(marketing)/pricing/page.tsx": 'import { price } from "@/lib/payments/price";\nexport default function P() { return price(2); }',
  "app/api/health/route.ts": "export function GET() { return Response.json({ ok: true }); }",
  "app/api/checkout/route.ts": 'import { charge } from "@/lib/payments/charge";\nexport async function POST() { return charge(); }',
  "app/_parts/x.tsx": "export const x = 1;",
  "components/index.ts": 'export { default as Nav } from "./Nav";',
  "components/Nav.tsx": "export default function Nav() { return <nav>Home</nav>; }",
  "components/Nav.test.tsx": 'import Nav from "./Nav";\ntest("nav", () => {});',
  "lib/payments/price.ts": "export const price = (n: number) => n * 100;",
  "lib/payments/charge.ts": 'import { price } from "./price.js";\nexport const charge = () => price(3);',
  "lib/payments/charge.test.ts": 'import { charge } from "./charge";\ntest("charge", () => {});',
  "README.md": "# Golden Threads",
};

test("archive diff strips the GitHub wrapper folder", () => {
  const a = zip(BASE);
  assert.ok(a.files.has("app/page.tsx"));
  const b = zip({ ...BASE, "components/Nav.tsx": "export default function Nav() { return <nav>Shop</nav>; }", "new.ts": "x" }, "other-root/");
  const d = diffIndexes(b, a);
  assert.deepEqual(d, [
    { path: "components/Nav.tsx", kind: "modified" },
    { path: "new.ts", kind: "added" },
  ]);
  const c = zip(Object.fromEntries(Object.entries(BASE).filter(([k]) => k !== "README.md")));
  assert.deepEqual(diffIndexes(c, a), [{ path: "README.md", kind: "removed" }]);
});

test("imports, aliases and resolution", () => {
  assert.deepEqual(
    parseImports(`import a from "./a";\nimport type { B } from '@/b';\nexport * from "./c";\nconst d = await import("./d");\nrequire("e");\nimport "./side.css";`, "x.ts").sort(),
    ["./a", "./c", "./d", "./side.css", "@/b", "e"].sort(),
  );
  assert.deepEqual(parseImports('@import "./base.css";\n@import url("theme.css");', "a.css"), ["./base.css", "theme.css"]);
  const ts = parseLooseJson(BASE["tsconfig.json"]);
  assert.ok(ts.compilerOptions.strict);
  const r = makeResolver(new Set(Object.keys(BASE)), aliasesFrom(ts));
  assert.equal(r("app/page.tsx", "@/components/Nav"), "components/Nav.tsx");
  assert.equal(r("app/about/page.tsx", "../../components"), "components/index.ts");
  assert.equal(r("lib/payments/charge.ts", "./price.js"), "lib/payments/price.ts");
  assert.equal(r("app/page.tsx", "react"), null);
  assert.equal(r("app/page.tsx", "node:fs"), null);
});

test("Next.js routes", () => {
  assert.deepEqual(nextRoute("app/page.tsx"), { kind: "page", route: "/", file: "app/page.tsx", dynamic: false });
  assert.equal(nextRoute("app/(marketing)/pricing/page.tsx").route, "/pricing");
  assert.equal(nextRoute("src/app/shop/[slug]/page.tsx").dynamic, true);
  assert.equal(nextRoute("app/api/checkout/route.ts").kind, "api");
  assert.equal(nextRoute("app/_parts/page.tsx"), null);
  assert.equal(nextRoute("app/@modal/login/page.tsx").route, "/login");
  assert.equal(nextRoute("app/shop/layout.tsx").kind, "layout");
  assert.equal(nextRoute("pages/index.tsx").route, "/");
  assert.equal(nextRoute("pages/api/hello.ts").kind, "api");
  assert.equal(nextRoute("components/Nav.tsx"), null);
});

test("globs", () => {
  assert.ok(globToRegex("lib/payments/**").test("lib/payments/stripe/charge.ts"));
  assert.ok(globToRegex("lib/payments").test("lib/payments/charge.ts"));
  assert.ok(globToRegex("app/api/*/route.ts").test("app/api/checkout/route.ts"));
  assert.ok(!globToRegex("app/api/*/route.ts").test("app/api/a/b/route.ts"));
  assert.ok(globToRegex("**/*.{ts,tsx}").test("a/b/c.tsx"));
  assert.ok(globToRegex("**/*.md").test("README.md"));
});

test("scan: only added lines; typos low, secrets extreme, conflicts high", () => {
  assert.deepEqual(addedLines("a\nb\nc", "a\nc"), [{ line: 2, text: "b" }]);
  const old = 'export const t = "Welcome";\n';
  const next = old + 'export const m = "Please recieve your order";\nconst k = "sk_live_abcdefghijklmnop1234";\n<<<<<<< HEAD\nconsole.log("x");\n';
  const f = scanFile("app/page.tsx", next, old);
  const by = (s) => f.filter((x) => x.severity === s).map((x) => x.title);
  assert.deepEqual(by("low").sort(), ['Typo: "recieve" → "receive"', "console.log left in"].sort());
  assert.deepEqual(by("extreme"), ["Looks like a live Stripe secret key is committed"]);
  assert.deepEqual(by("high"), ["Merge conflict marker left in the file"]);
  // Unchanged lines are never reported again.
  assert.deepEqual(scanFile("app/page.tsx", next, next), []);
  // Class lists and imports are not prose.
  assert.deepEqual(scanFile("a.tsx", 'import x from "./teh";\n<div className="flex teh-x">ok</div>', null), []);
  assert.equal(scanFile(".env", "A=1", null)[0].severity, "high");
});

test("suites and probes", () => {
  assert.deepEqual(parseProbe("POST /api/checkout 400 contains:error"), { method: "POST", path: "/api/checkout", expect: 400, contains: "error" });
  assert.deepEqual(parseProbe("/api/health"), { method: "GET", path: "/api/health", expect: null, contains: "" });
  const [s] = cleanSuites([{ name: "Payments", paths: ["lib/payments/**"], command: "npm run test:payments" }], "panel");
  assert.equal(s.always, false);
  assert.equal(s.severity, "extreme");
  const [h] = cleanSuites([{ name: "Health", probes: ["GET /api/health 200"] }], "panel");
  assert.equal(h.always, true);
  assert.equal(h.needsBuild, true);
});

test("plan: a component change reaches its pages and tests, not the payments code", () => {
  const prev = zip(BASE);
  const next = zip({ ...BASE, "components/Nav.tsx": 'export default function Nav() { return <nav>Shop teh range</nav>; }' });
  const ci = { suites: [{ name: "Payments", severity: "extreme", paths: ["lib/payments/**", "app/api/checkout/**"], command: "npm run test:payments" }, { name: "Health", probes: ["GET /api/health 200"] }], maxCheckouts: 4 };
  const plan = planRun({ next, prev, site: { type: "node" }, ci, runners: 3 });
  assert.equal(plan.scope, "targeted");
  assert.deepEqual(plan.changed.map((c) => c.path), ["components/Nav.tsx"]);
  assert.deepEqual(plan.routes.map((r) => r.route).sort(), ["/", "/about"]);
  assert.deepEqual(plan.tests, ["components/Nav.test.tsx"]);
  const suites = Object.fromEntries(plan.suites.map((s) => [s.id, s.reason]));
  assert.equal(suites.payments, null);
  assert.equal(suites.health, "always runs");
  assert.deepEqual(plan.findings.map((f) => f.title), ['Typo: "teh" → "the"']);
  const kinds = plan.checkouts.map((c) => c.key);
  assert.deepEqual(kinds, ["build", "verify", "tests-1"]);
  const smoke = plan.checkouts[0].steps.find((s) => s.kind === "smoke");
  assert.deepEqual(smoke.probes.map((p) => p.path).sort(), ["/", "/about"]);
  assert.equal(smoke.healthPath, "/api/health");
  assert.equal(smoke.suites[0].name, "Health");
  const lint = plan.checkouts[1].steps.find((s) => s.kind === "lint");
  assert.match(lint.cmd, /components\/Nav\.tsx/);
  assert.match(lint.cmd, /app\/about\/page\.tsx/);
});

test("plan: a payments change triggers the extreme suite, its tests carry its severity, dynamic routes need samples", () => {
  const prev = zip(BASE);
  const next = zip({ ...BASE, "lib/payments/price.ts": "export const price = (n: number) => n * 101;" });
  const ci = { suites: [{ name: "Payments", severity: "extreme", paths: ["lib/payments/**"], command: "npm run test:payments" }], maxCheckouts: 4 };
  const plan = planRun({ next, prev, site: { type: "node" }, ci, runners: 2 });
  assert.match(plan.suites.find((s) => s.id === "payments").reason, /touches lib\/payments\/price\.ts/);
  assert.deepEqual(plan.routes.map((r) => r.route).sort(), ["/api/checkout", "/pricing", "/shop/[slug]"]);
  assert.deepEqual(plan.probes.map((p) => p.path).sort(), ["/api/checkout", "/pricing"]);
  assert.ok(plan.notes.some((n) => /shop\/\[slug\]/.test(n)));
  const tests = plan.checkouts.find((c) => c.kind === "tests").steps.find((s) => s.kind === "tests");
  assert.deepEqual(tests.files, ["lib/payments/charge.test.ts"]);
  assert.equal(tests.severityOf["lib/payments/charge.test.ts"], "extreme");
  assert.ok(plan.checkouts.some((c) => c.steps.some((s) => s.kind === "suite" && s.severity === "extreme")));

  const withSample = planRun({ next, prev, site: { type: "node" }, ci: { ...ci, samples: { "/shop/[slug]": "/shop/red-scarf" } }, runners: 2 });
  assert.ok(withSample.probes.some((p) => p.path === "/shop/red-scarf"));
});

test("plan: first deploy and project-wide files mean a full check", () => {
  const next = zip(BASE);
  const full = planRun({ next, prev: null, site: { type: "node" }, ci: {}, runners: 1 });
  assert.equal(full.scope, "full");
  assert.equal(full.tests.length, 2);
  const g = planRun({ next: zip({ ...BASE, "package.json": BASE["package.json"].replace("1.0.0", "1.0.1") }), prev: next, site: { type: "node" }, ci: {}, runners: 1 });
  assert.equal(g.scope, "global");
  assert.ok(g.routes.length >= 5);
});

test("plan: a codebase with no test tooling still gets build + smoke", () => {
  const bare = { "package.json": JSON.stringify({ scripts: { build: "next build", start: "next start" }, dependencies: { next: "16" } }), "app/page.tsx": "export default () => 1;" };
  const plan = planRun({ next: zip(bare), prev: null, site: { type: "node" }, ci: {}, runners: 2 });
  assert.deepEqual(plan.checkouts.map((c) => c.key), ["build"]);
  assert.ok(plan.checkouts[0].steps.some((s) => s.kind === "smoke"));
  assert.ok(plan.tips.some((t) => /No test runner/.test(t.text)));
});

test("plan: a layout change reaches the pages under it, not API routes", () => {
  const prev = zip(BASE);
  const next = zip({ ...BASE, "app/layout.tsx": BASE["app/layout.tsx"] + "\n// tweak" });
  const plan = planRun({ next, prev, site: { type: "node" }, ci: {}, runners: 1 });
  const routes = plan.routes.map((r) => r.route).sort();
  assert.ok(routes.includes("/") && routes.includes("/about") && routes.includes("/pricing"));
  assert.ok(!routes.includes("/api/health") && !routes.includes("/api/checkout"));
});
