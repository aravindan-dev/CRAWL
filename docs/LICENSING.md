# Licensing — VENDOR-INTERNAL

How CLG Search licenses work, how to issue one, and the email templates for a
sale. This is your (the seller's) reference — never share this file or
`tools/license-admin/` with a customer.

For the full CLI reference (keygen/issue/inspect flags), see
[tools/license-admin/README.md](../tools/license-admin/README.md). This doc
covers the parts that file doesn't: the day-to-day workflow and what to say to
customers.

## One-time setup (already done for this codebase)

The Ed25519 keypair that signs every license already exists at
`tools/license-admin/keys/`. You only re-run `pnpm --filter license-admin
keygen --force` if the private key is ever compromised — doing so invalidates
every license issued so far, so treat it as a last resort. Back up
`keys/private.pem` somewhere safe and offline; if it's lost, you can never
issue a license for old customers to renew into (they'd need a full new key
and a matched public-key rebuild).

## The two activation paths

**Fast sale (pre-activation key)** — you don't need the customer's fingerprint
up front. Issue a key with no `--fingerprint`; it activates on whichever
machine pastes it first, within 14 days of issue. Good for closing a deal
quickly; follow up with a fingerprint-bound final key once they've installed.

**Fingerprint-first (most secure)** — the customer installs first, sends you
the fingerprint shown on the lock screen, and you issue a key already bound to
it. No unbound key ever exists.

Either way, the customer never sees `tools/license-admin/` or the private key —
they only ever paste a block of text on the License page.

## Day-to-day commands

```bash
# Issue
pnpm --filter license-admin issue --customer "Acme Corp" --email ops@acme.example \
  --months 12 --fingerprint <hex> --max-universities 500 --max-users 25

# Inspect a key before sending it
pnpm --filter license-admin inspect issued/acme-corp-<id>.key

# Renew: same fingerprint, later --months
pnpm --filter license-admin issue --customer "Acme Corp" --email ops@acme.example \
  --months 12 --fingerprint <hex>   # same fingerprint as their current license

# Transfer to a new server: fingerprint from the NEW machine
pnpm --filter license-admin issue --customer "Acme Corp" --email ops@acme.example \
  --months 12 --fingerprint <new-hex>
```

Every issue appends a row to `tools/license-admin/issued/registry.csv` — your
sales ledger. Back that file up periodically (it's gitignored, local only).

## Email templates

### 1. Requesting a fingerprint (fingerprint-first flow)

> Subject: CLG Search — one detail needed to activate your license
>
> Hi [name],
>
> To activate CLG Search, open the dashboard — it will show a lock screen with
> a "Machine fingerprint" and a Copy button. Please send that fingerprint back
> to us and we'll issue your license key within one business day.
>
> Thanks,
> [you]

### 2. Delivering a license key

> Subject: Your CLG Search license
>
> Hi [name],
>
> Attached is your license key (also pasted below). On the dashboard's License
> page, paste the entire block — including the BEGIN/END lines — into the
> activation box and click Activate.
>
> ```
> -----BEGIN CLG SEARCH LICENSE-----
> ...
> -----END CLG SEARCH LICENSE-----
> ```
>
> This license covers [N] universities and [N] team accounts, and is valid
> through [date]. We'll follow up before it expires.
>
> Thanks,
> [you]

### 3. Renewal reminder (send ~30 days before expiry)

> Subject: Your CLG Search license expires on [date]
>
> Hi [name],
>
> Your CLG Search license expires on [date] (the dashboard will also show a
> banner as this approaches, and a 7-day grace period afterward so nothing
> stops working abruptly). Let us know if you'd like to renew, and whether
> your usage has changed (more universities or team members).
>
> Thanks,
> [you]

## Troubleshooting a customer's license issue

Ask them to open the License page (or read it off the lock screen) and send
you the exact error code shown (`LICENSE_EXPIRED`, `LICENSE_MACHINE_MISMATCH`,
etc.) plus their fingerprint. `pnpm --filter license-admin inspect
<their-file>` decodes any key they send you so you can confirm what's actually
in it without touching the running product.
