# What this project is

A Next.js starter used as the base for new Forthway sites. When it is cloned it
is a hello-world page and nothing more — no product, no domain model, no
opinions about what it becomes. The first real conversation on a clone of this
repo decides that.

**So: do not assume what this site is for.** If the task is vague, ask what the
site is before scaffolding pages. Until told otherwise, treat `app/page.tsx` as
a placeholder to be replaced, not a design to preserve.

## Stack

- **Next.js 16**, App Router, TypeScript in strict mode.
- **Tailwind v4**, configured through CSS rather than a JS config file. The
  theme lives in the `@theme` block at the top of `app/globals.css`.
- **npm**. There is a `package-lock.json`; keep it in sync and commit it.
- No database, no auth, no state library. Add them when the site actually needs
  them, not preemptively.

## Layout

```
app/
  layout.tsx        the shell every page sits in
  page.tsx          the home page — placeholder, replace it
  globals.css       Tailwind import + the design tokens
  api/health/       liveness check for the Command Center
  api/version/      what the running process actually loaded
public/             static files served at /
```

## House rules

**Style through the tokens.** Colours and fonts are defined once in the
`@theme` block in `app/globals.css` and used as normal Tailwind classes —
`text-ink`, `bg-surface`, `border-line`, `text-accent-strong`. Change a site's
look by changing those values, not by scattering hex codes through components.
Reach for an arbitrary value only when a one-off genuinely is a one-off.

**Server components by default.** Add `"use client"` only to the component that
actually needs interactivity, as far down the tree as possible.

**Keep the two API routes as they are.** `app/api/health` and
`app/api/version` are what the Command Center uses to decide whether a deploy
worked. `version` deliberately reads `build-info.json` once at module load: if
new files land without a restart it keeps reporting the old version, and that
is how a failed restart gets caught instead of silently passing. Do not make it
re-read on each request, and do not make `health` touch a database — a blip
would trigger a pointless rollback.

**Bump `version` in `package.json` for anything you want to see deployed.** The
Command Center shows `1.4.2 → 1.5.0` before it commits and uses the number to
confirm the restart took. Deploying without bumping it works, but the panel
cannot then prove the new code is live.

## Commands

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # what the server runs on deploy
npm start          # production server; reads PORT
npm run typecheck  # tsc --noEmit
npm run lint
```

Run `npm run typecheck` and `npm run build` before calling work finished. A
build that fails on the server is a deploy that never happens.

## How this gets deployed

By the Forthway Command Center, which:

1. unpacks the release into a staging directory beside the app,
2. runs `npm install` (skipped when `package.json` and the lockfile are
   unchanged) then `npm run build` there — so a broken build never reaches the
   live site,
3. swaps the result into place, replacing only files that changed,
4. restarts the app and waits for `/api/health`, then confirms `/api/version`
   reports the new number,
5. restores the previous build if either check fails.

Two consequences worth remembering:

- **`.env` files, `public/uploads` and `logs/` are never touched by a deploy.**
  Secrets live on the server and survive every deploy and rollback. Do not
  commit them, and do not write code that expects to ship them.
- **Anything written at runtime into a normal source directory will be wiped**
  by the next deploy, because that directory is replaced from the archive. Put
  runtime files under a preserved path.

`build-info.json` and `.forthway/` appear in the app directory on a deployed
server. Both are the Command Center's; they are gitignored, and nothing in the
app should write to them.
