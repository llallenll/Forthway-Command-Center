import pkg from "../package.json";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-6 py-20">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-ink-faint">
        {pkg.name} · v{pkg.version}
      </p>

      <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">Hello, world.</h1>

      <p className="mt-4 text-lg leading-relaxed text-ink-soft">
        This is the starting point. Next.js, TypeScript and Tailwind are wired up, the health and
        version endpoints the Command Center relies on are already here, and nothing else is
        assumed — say what this site is meant to be and build from here.
      </p>

      <div className="mt-10 rounded-xl border border-line bg-surface p-5">
        <h2 className="text-sm font-semibold">Where things are</h2>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 font-mono text-[13px] text-ink-soft">
          <dt className="text-ink">app/page.tsx</dt>
          <dd>this page</dd>
          <dt className="text-ink">app/layout.tsx</dt>
          <dd>the shell every page sits in</dd>
          <dt className="text-ink">app/globals.css</dt>
          <dd>colours, fonts and spacing tokens</dd>
          <dt className="text-ink">app/api/health</dt>
          <dd>liveness check — leave it alone</dd>
          <dt className="text-ink">app/api/version</dt>
          <dd>what is actually running — leave it alone</dd>
          <dt className="text-ink">CLAUDE.md</dt>
          <dd>notes for Claude about this project</dd>
        </dl>
      </div>

      <p className="mt-8 font-mono text-[13px] text-ink-faint">
        <a className="text-accent-strong underline underline-offset-4" href="/api/version">
          /api/version
        </a>{" "}
        reports the build this process actually loaded.
      </p>
    </main>
  );
}
