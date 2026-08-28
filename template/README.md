# Forthway site template

A hello-world Next.js site, ready to become something else.

```bash
npm install
npm run dev     # http://localhost:3000
```

Next.js 16 (App Router) · TypeScript · Tailwind v4 · npm. No database, no auth,
nothing else assumed.

## Using it

Push this folder to its own GitHub repository. Then, for each new site:

1. Fork or template the repo on GitHub.
2. In the Forthway Command Center, add a site, set its app directory and port,
   and point it at the new repo.
3. **Pull & deploy.**

That is a live test site in about a minute, and every deploy after it is one
click.

## What is already wired up

- `app/api/health` — the liveness check the Command Center polls after a
  restart.
- `app/api/version` — reports the build the running process actually loaded, so
  a restart that silently did not happen gets caught rather than passing.
- A `@theme` token block in `app/globals.css` — change the colours there and
  the whole site follows.
- `.gitignore` covering `build-info.json` and `.forthway/`, which the Command
  Center writes into the app directory on the server.

`CLAUDE.md` explains the same ground to Claude, plus the house rules worth
keeping to when building on top of this.

## Deploy settings that match this template

| Setting | Value |
|---|---|
| Install | `npm install --no-audit --no-fund` |
| Prepare | *(blank)* |
| Build | `npm run build` |
| Must exist after a build | `.next/BUILD_ID` |
| Restart mode | pm2 — first start command `npm start` |
| Port | whatever you assign the site |
| Health / version URL | leave blank; they are derived from the port |

Those are the Command Center's defaults, so in practice you only fill in the
app directory, the port and the pm2 process name.
