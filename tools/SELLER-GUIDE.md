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

## Before your FIRST paid sale
- **Code-sign** `CLG Search.exe` (OV/EV cert) so Windows doesn't warn customers.
- Wrap `dist/CLG-Search/` in an **Inno Setup / NSIS installer** (Program Files + shortcut).
- Have a **lawyer finalize** `LICENSE.txt` (shipped copy is a template).
- Test the zip on a **clean Windows PC** (no Node/Docker) end-to-end.

## Pricing (guidance)
- Perpetual license: **₹8–15 lakh / company** + **18–22%/yr** support & updates.
- Or subscription: **₹3–6 lakh / company / year**.
- Bill custom features, extra machines, and onboarding separately.
- Price to the value it creates for the buyer (analyst hours saved / admissions won),
  not to your build cost. Offer 1–2 early clients a discount for a testimonial.
