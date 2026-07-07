# CLG Search — Seller Guide (how to sell it)

The product is **licensed, not sold**: you keep the source, the customer gets a
locked, source-free app they can only *use*. Same product → many companies.

## One-time setup
```bash
corepack enable pnpm
pnpm install
pnpm --filter @clg/database exec prisma generate
```
The licensing keypair already exists in `tools/licensing/` (`private-key.pem` is your
secret — back it up offline, never ship it).

## Build the shippable product
```bash
# 1. compiled, source-free app  → dist/CLG-Search/
node tools/package/build-dist.mjs

# 2. bundle DB + cache + browser → dist/CLG-Search/vendor/  (so the customer installs nothing)
node tools/package/bundle-vendor.mjs
```
Result: `dist/CLG-Search/` — a folder with `CLG Search.exe` and everything it needs.
Details: [tools/package/README.md](package/README.md).

## Sell to a company (per customer)
1. Zip and send **only** `dist/CLG-Search/` (never the project, never `tools/`).
2. Customer runs **Machine ID.cmd** → emails you their Machine ID.
3. You issue their license:
   ```bash
   node tools/licensing/issue-license.mjs --company "Acme Corp" \
     --machine <their-id> --expires 2027-06-30 --plan enterprise
   ```
4. Email them `tools/licensing/out/acme-corp-license.dat`; they save it as
   `license.dat` next to the .exe and restart. Done.
Details: [tools/licensing/README.md](licensing/README.md).

## NEVER ship
- ❌ the project folder / any `.ts` / `.git` / `node_modules` (your source)
- ❌ `tools/licensing/private-key.pem` (forges licenses)
- ❌ `tools/` at all — it is seller-only
- ❌ (Server Edition) your registry **push** credentials — give the customer's
  server only a **read-only pull token**, scoped to just these three images

## Before your FIRST paid sale
- **Code-sign** `CLG Search.exe` (OV/EV cert) so Windows doesn't warn customers.
- Wrap `dist/CLG-Search/` in an **Inno Setup / NSIS installer** (Program Files + shortcut).
- Have a **lawyer finalize** `LICENSE.txt` (shipped copy is a template).
- Test the zip on a **clean Windows PC** (no Node/Docker) end-to-end.

## Server Edition (customer runs it on their own Linux server, not a Windows PC)

Same principle as the Windows edition — source-free, licensed, machine-bound —
delivered as three private Docker images instead of a `.exe`. Full details:
[tools/package/docker/](package/docker/). Do this yourself; the customer only
ever runs `docker compose pull && docker compose up -d`.

```bash
# One-time: log in to your private registry (GHCR shown; Docker Hub works too)
docker login ghcr.io

# Build the three images, verify no source leaked, and push
node tools/package/docker/build-and-push.mjs \
  --registry ghcr.io/your-github-username \
  --tag v1.0.0 \
  --api-url http://<customer-server-ip-or-domain>:4100 \
  --push
```

**Deploy on the customer's server** (over SSH — recommended so the customer
never sees `docker-compose.yml`, `.env`, or the registry token):
1. Copy `docker-compose.server-edition.yml`, `.env.example` → `.env` (fill in a
   real `POSTGRES_PASSWORD` and your `REGISTRY`), and `pg-init/` to a folder on
   their server, e.g. `/opt/clg-search/`.
2. `docker login <registry>` on their server with a **read-only pull token**
   (not your personal push credentials).
3. Get their Machine ID: `cat /etc/machine-id` on their server (or run the
   bundled `tools/licensing/machine-id.mjs` — it reads the same file).
4. Issue their license exactly as in the Windows flow above, using that ID.
   Drop the resulting file as `license.dat` next to `docker-compose.server-edition.yml`.
5. `docker compose -f docker-compose.server-edition.yml pull && docker compose -f docker-compose.server-edition.yml up -d`
6. Verify: `docker compose ps` (all healthy) and open `http://<server>:3100`.

**To update a customer to a new version later:** build+push a new `--tag`,
change `IMAGE_TAG` in their `.env`, then repeat step 5 — their data (Postgres
volume) is untouched.

**Why not just `docker-compose up --build` from the source repo?** That would
put your full TypeScript source, `.git`, and everything else on their server.
The images built by `build-and-push.mjs` are multi-stage: a throwaway builder
stage has the source, but only the compiled/bundled output (esbuild-minified
`.cjs`, no comments, mangled identifiers) is copied into the final image —
verified automatically by the script (same check as the Windows `verify` step).

## Pricing (guidance)
- Perpetual license: **₹8–15 lakh / company** + **18–22%/yr** support & updates.
- Or subscription: **₹3–6 lakh / company / year**.
- Bill custom features, extra machines, and onboarding separately.
- Price to the value it creates for the buyer (analyst hours saved / admissions won),
  not to your build cost. Offer 1–2 early clients a discount for a testimonial.
