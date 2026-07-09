# Packaging — SELLER ONLY

Builds the **source-free** distribution at `dist/CLG-Search/` that customers run but
cannot read or modify.

## Build

```bash
# 1. one-time prerequisites
corepack enable pnpm
pnpm install
pnpm db:generate          # generates the Prisma client the bundle needs

# 2. build the distribution
node tools/package/build-dist.mjs              # all steps
# or run subsets:
node tools/package/build-dist.mjs --only=bundle,launcher,assets,verify
node tools/package/build-dist.mjs --skip=node  # use the customer's system Node instead of bundling
```

Steps: `clean → bundle → web → deps → prisma → node → launcher → assets → verify`.

## What each step does

| Step | Output | Notes |
|------|--------|-------|
| `bundle` | `runtime/api/server.cjs`, `runtime/crawler/main.cjs` | **The IP-hiding step.** esbuild inlines every `@clg/*` package into one minified `.cjs`, keeping only npm deps external. No `.ts`, no comments, mangled identifiers. |
| `web` | `runtime/web/` | `next build` (output:standalone) → compiled server + chunks. No page source. Heavy (~minutes). |
| `deps` | `runtime/{api,crawler}/node_modules` | `pnpm deploy --prod` production deps; our `@clg/*` stripped (already inlined); Prisma client copied in. Heavy. |
| `prisma` | `runtime/prisma/` | schema + raw SQL + migrations for first-run DB setup (no `.ts`). |
| `node` | `runtime/node/node.exe` | portable Node so customers need nothing pre-installed. |
| `launcher` | `CLG Search.exe` + `runtime/launch.cjs` | C# launcher compiled with the Windows-bundled `csc.exe`; it runs the Node orchestrator. |
| `assets` | `.env`, `LICENSE.txt`, `README.txt` | customer-facing files. |
| `verify` | — | fails the build if any `.ts`/`.git`/source leaks outside `node_modules`. |

## ✅ Done (works today)

- Source hidden: minified bundles, `verify` enforces no source leaks.
- License gate: every business route 403s without a valid, in-date, machine-bound
  license; the dashboard's own lock screen shows the fingerprint and accepts a
  pasted key — no separate tool or file to place by hand (see `packages/license/`).
- Real `CLG Search.exe` launcher (no extra runtime needed).
- Seller license issuing (see `tools/license-admin`).

## ⚠️ Before your first real sale — still required

These are deliberately **not** automated because they need external binaries, money,
or a lawyer:

1. **Bundle PostgreSQL + Redis.** The app needs both locally. Drop portable builds into
   `dist/CLG-Search/vendor/postgres/` and `dist/CLG-Search/vendor/redis/` — `launch.cjs`
   auto-starts them if present. Otherwise document Docker as a prerequisite.
   - Postgres (portable, Windows zip): https://www.enterprisedb.com/download-postgresql-binaries
   - Redis for Windows: https://github.com/redis-windows/redis-windows
   Run `initdb`/create the `clg` database+user once and ship the `data/` dir, or have the
   launcher run first-run init.
2. **Bundle Chromium for Playwright.** Set `PLAYWRIGHT_BROWSERS_PATH` to a `vendor/chromium`
   folder and ship the browser (~150 MB), or run `playwright install chromium` on first run.
3. **First-run DB migration.** Have the launcher run `prisma db push` + `constraints.sql`
   against the bundled Postgres on first start (schema is in `runtime/prisma/`).
4. **Code signing.** Sign `CLG Search.exe` with an OV/EV certificate so Windows
   SmartScreen doesn't warn customers. (~₹15–40k/yr for a cert.)
5. **Windows installer.** Wrap `dist/CLG-Search/` in Inno Setup or NSIS to install into
   `C:\Program Files\CLG Search\` with a Start-menu shortcut.
6. **Legal.** Have a lawyer finalize `LICENSE.txt` (the shipped copy is a template).

## Reverse-engineering reality

No client-side software is 100% protected — a determined expert can inspect any binary.
This package makes it *impractical*: minified opaque bundles, no source, license checks,
plus the legal agreement. That combination is the industry-standard deterrent.
