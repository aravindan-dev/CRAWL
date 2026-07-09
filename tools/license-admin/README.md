# License Admin — VENDOR ONLY

Issues, inspects, and tracks CLG Search licenses. **Never ship this folder to a
customer.** It is excluded from every Docker build context and from `.gitignore`
covers its secrets (`keys/private.pem`, `issued/`).

## Files

| Path | Ship to customer? | Purpose |
|------|-------------------|---------|
| `keys/private.pem` | ❌ **NEVER** | Secret Ed25519 key that signs licenses. If it leaks, anyone can forge licenses. Back it up offline. |
| `keys/public.pem` | ✅ (already embedded) | Matching public key, compiled into `packages/license/src/publicKey.ts` so the product can verify but never forge licenses. |
| `keygen.ts` | ❌ | One-time: generates the keypair above. |
| `issue.ts` | ❌ | Signs a license for one company. |
| `inspect.ts` | ❌ | Decodes + verifies any `.key` file. |
| `issued/*.key` | ✅ one per customer | The signed license you send. |
| `issued/registry.csv` | ❌ | Sales ledger — every license ever issued. |

## One-time setup

```bash
pnpm --filter license-admin keygen
```

Paste the printed public key into `packages/license/src/publicKey.ts` (already done
for the keypair this repo ships with — only needed again if you rotate keys).

## How a sale works

### Path A — fast sales flow (pre-activation key)

1. Issue a key with no `--fingerprint`:

   ```bash
   pnpm --filter license-admin issue \
     --customer "Aliff Overseas Pvt Ltd" --email ops@aliff.example \
     --months 12 --max-universities 500 --max-users 25
   ```

2. Email the generated `issued/<customer>-<id>.key`. The customer pastes it on the
   Activation page (`/license`) — the app verifies it, binds it to their machine's
   live fingerprint immediately, and shows that fingerprint with a "send to vendor"
   note.
3. The customer sends you that fingerprint. Issue the **final**, fingerprint-bound
   key (see Path B) so the license survives a re-image/backup-restore cleanly, and
   email it to replace the pre-activation one. This step is optional but recommended.

Pre-activation keys expire for redemption 14 days after issue if never activated —
they can't circulate indefinitely.

### Path B — fingerprint-first (most secure)

1. Customer installs CLG Search and opens the lock screen, which shows *"Machine
   fingerprint: ab12…"* with a copy button. They send it to you.
2. Issue a bound key:

   ```bash
   pnpm --filter license-admin issue \
     --customer "Aliff Overseas Pvt Ltd" --email ops@aliff.example \
     --months 12 --fingerprint ab12cd34ef56... \
     --max-universities 500 --max-users 25
   ```

3. Email the `.key` file; the customer pastes it and it activates immediately —
   bound to that exact machine from the start.

## Inspecting a key before sending it

```bash
pnpm --filter license-admin inspect issued/aliff-overseas-pvt-ltd-<id>.key
```

## Renewing / transferring

- **Renewal:** re-run `issue` with the same `--fingerprint` and a later `--months`;
  customer pastes the new key on `/license` (requires ADMIN login once auth exists).
- **Transfer to a new server:** customer sends the new machine's fingerprint; issue a
  fresh key bound to it.
- **If `keys/private.pem` ever leaks:** run `keygen --force`, update
  `packages/license/src/publicKey.ts` with the new public key, rebuild the product,
  and re-issue every customer — old keys stop verifying the moment the public key
  changes.

## Why this is safe to sell to many companies

The signature is **asymmetric**: the product only carries the *public* key, so it
can *check* a license but can never *create* one. Each license is bound to one
machine fingerprint, so a copied install won't activate elsewhere. The same product
build serves every customer, each with their own key.
