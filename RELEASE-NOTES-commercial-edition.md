# CLG Search — Commercial Server Edition — Release Notes

Machine-locked licensing + team login + server deployment hardening, built on
top of the existing eligibility-crawling product.

## What's new

**Licensing** (`packages/license`, `tools/license-admin`)
- Ed25519-signed license keys (same keypair the product already shipped with),
  now with an activation flow, 7-day expiry grace period, a 14-day
  pre-activation redemption window for fast-sale keys, a clock-tamper guard,
  and per-license `maxUniversities`/`maxUsers` caps.
- Every API route except `/health` and the license/auth endpoints is rejected
  with a plain-English 403 while the license is invalid; the dashboard itself
  stays up and shows a full-screen lock screen with the machine fingerprint
  and a paste-a-key activation form — no restart needed to activate.
- Vendor CLI: `pnpm --filter license-admin issue|inspect|keygen`. Replaces the
  earlier prototype (`tools/licensing/`).

**Team authentication & roles** (`apps/api/src/plugins/auth.ts`, `/auth/*`, `/users/*`, `/audit`)
- Scrypt password hashing, HMAC-signed stateless session cookies with sliding
  renewal, and a first-run setup wizard that creates the initial ADMIN account.
- Three roles — VIEWER (read-only), OPERATOR (runs the pipeline), ADMIN
  (settings, backups, team accounts, licensing, Aliff LIVE) — enforced
  server-side by a centralized role table, not just hidden in the UI.
- Full audit trail (login, settings changes, backups, deletes, Aliff runs)
  viewable by ADMIN; Aliff credentials are never recorded.
- Web: login page, setup wizard, header user menu (change password / sign
  out), and a Team accounts page.

**Server deployment hardening**
- `HOST` env var (default `0.0.0.0`) so the whole office network can reach the
  dashboard; `COOKIE_SECURE` for HTTPS-fronted deployments.
- Exports now download through an authenticated `/files/*` route (manual
  path-traversal guard) instead of unauthenticated static file serving.
- `.dockerignore` excludes `tools/license-admin` and `**/private.pem` from
  every build context; an automated test fails if the signing key's PEM
  header ever appears in `apps/` or `packages/` source.
- `docker-compose.server-edition.yml` updated for the new license system,
  with healthchecks on every service and license/backup state on a host bind
  mount (survives image updates).
- Backups now include team accounts, the recent audit trail, and the license
  activation state; restoring onto a different machine correctly re-triggers
  a machine-mismatch check rather than silently transferring the license.
- Fixed a CSP gap that would have blocked every non-server PC on a LAN
  install from reaching the API (connect-src was localhost-only).

**Docs**
- `docs/LICENSING.md` (vendor-internal: issuing, renewing, transferring, email templates)
- `docs/ADMIN-GUIDE.md` (customer-facing: activation, accounts, backups, recovery)
- `apps/api/src/cli/reset-admin.js` — offline admin password recovery for a
  locked-out installation (server shell access required, not reachable over HTTP)
- README / DOCUMENTATION.md updated with the new sign-in flow and troubleshooting

## How a new sale works, end to end

1. **Build & push images** (you, the vendor):
   ```bash
   node tools/package/docker/build-and-push.mjs \
     --registry ghcr.io/your-org --tag v1.1.0 \
     --api-url http://<customer-server>:4100 --push
   ```
2. **Customer installs**: copies `docker-compose.server-edition.yml`, `.env`
   (from `.env.example`), and `pg-init/` to their server, then
   `docker compose pull && docker compose up -d`.
3. **Fingerprint**: they open `http://<server>:3100`; the lock screen shows
   the machine fingerprint and a Copy button. They send it to you.
4. **Issue key**:
   ```bash
   pnpm --filter license-admin issue --customer "Acme Corp" --email ops@acme.example \
     --months 12 --fingerprint <hex> --max-universities 500 --max-users 25
   ```
5. **Activate**: they paste the key on the same lock screen and click Activate
   — unlocks immediately, no restart.
6. **Create admin**: the app then shows the one-time setup wizard; they create
   the administrator account.
7. **Hand over**: point them at `docs/ADMIN-GUIDE.md` for creating team
   accounts, backups, and renewals. Keep `docs/LICENSING.md` for yourself.

## Verification performed this cycle

- `pnpm typecheck` — 14/14 tasks green across the workspace.
- `pnpm test` — 12/12 test-runner tasks green (233 tests total, including new
  license/auth/download unit tests and a signing-key-leak guard).
- `pnpm build` — 8/8 build tasks green, including the new `/license` and
  `/users` pages.
- Live end-to-end smoke test against a real Postgres/Redis: issued and
  activated a license, ran first-run setup, logged in as ADMIN and OPERATOR,
  confirmed 403s on ADMIN-only routes for OPERATOR, confirmed the `maxUsers`
  cap blocks a 4th account, confirmed audit rows were written, and confirmed
  logout invalidates the session cookie.

## Known follow-ups (not yet automated — see `tools/package/README.md`)

Bundling portable Postgres/Redis/Chromium for the Windows single-PC edition,
code-signing the `.exe`, an installer wrapper, and legal review of
`LICENSE.txt` were already tracked before this work and are unchanged by it.
