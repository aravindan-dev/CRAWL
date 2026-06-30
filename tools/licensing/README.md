# Licensing — SELLER ONLY

This folder issues the license files customers need to run CLG Search. **Keep it
private. Never ship anything from here to a customer except a generated
`out/*-license.dat`.**

## Files

| File | Ship to customer? | Purpose |
|------|-------------------|---------|
| `private-key.pem` | ❌ **NEVER** | Secret Ed25519 key that signs licenses. If this leaks, anyone can forge licenses. Back it up offline. |
| `public-key.pem` | ✅ (already embedded) | The matching public key. It is compiled into the product (`packages/shared/src/license.ts`) so the app can verify licenses but never forge them. |
| `issue-license.mjs` | ❌ | Seller tool — signs a license for one company. |
| `machine-id.mjs` | ✅ (shipped as `Machine ID.cmd`) | Customer tool — prints the PC's Machine ID. |
| `out/*-license.dat` | ✅ one per customer | The signed license you email to the customer. |

## How a sale works

1. **Customer installs** CLG Search and double-clicks **`Machine ID.cmd`**. It prints
   a 24-character Machine ID. They email it to you.
2. **You issue a license** bound to that machine:

   ```bash
   node tools/licensing/issue-license.mjs \
     --company "Acme Corp" \
     --machine 9d04f79b2f6d76094a953370 \
     --expires 2027-06-30 \
     --plan enterprise --seats 1 --features scholarship,monitor
   ```

   Options:
   - `--machine "*"` — activates on any machine (convenient, less secure).
   - `--expires none` — perpetual license (no expiry).
   - `--features` — comma list (e.g. `scholarship,monitor`); omit for base.

3. **You email** the generated `out/acme-corp-license.dat`. The customer saves it as
   `license.dat` next to `CLG Search.exe` and restarts. Done.

## Why this is safe to sell to many companies

The signature is **asymmetric**: the product only carries the *public* key, so it can
*check* a license but can never *create* one. Each customer's license is bound to their
machine, so a copied install will not activate elsewhere. The same product binary is
licensed to many companies, each with their own key.

## Rotating / re-issuing

- **Renewal:** issue a new `license.dat` with a later `--expires`; customer replaces the file.
- **New machine (e.g. customer replaced a PC):** re-issue with the new Machine ID.
- **If `private-key.pem` ever leaks:** generate a new keypair, update
  `LICENSE_PUBLIC_KEY_PEM` in `packages/shared/src/license.ts`, rebuild the product,
  and re-issue all customers. (Regenerate with:
  `openssl genpkey -algorithm ed25519 -out private-key.pem && openssl pkey -in private-key.pem -pubout -out public-key.pem`)
