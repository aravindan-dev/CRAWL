# CLG Search — Administrator Guide

This guide is for whoever administers your company's CLG Search installation:
activating the license, creating team accounts, and day-to-day maintenance.
For general dashboard usage, see the in-app **Guide** page.

## 1. Activating your license

The first time the dashboard opens with no valid license, you'll see a lock
screen instead of the app. It shows this machine's **fingerprint** — a short
code that identifies this specific server/PC.

**If you already have a license key** from your vendor: paste it (including
the `-----BEGIN CLG SEARCH LICENSE-----` / `-----END-----` lines) into the box
and click **Activate**. The app unlocks immediately — no restart needed.

**If you don't have a key yet**: copy the fingerprint (there's a Copy button)
and send it to your vendor. They'll email back a key bound to this exact
machine; paste it as above.

A license is tied to one machine. Moving the installation to a different
server counts as a machine change — see [§6 Moving to a new server](#6-moving-to-a-new-server-license-transfer).

## 2. First-run setup

Once licensed, if this is a brand-new installation you'll be asked to create
the **administrator account** — a username, display name, and password (10+
characters). This is the only account created automatically; everyone else is
added by an admin afterward (§3).

## 3. Team accounts and roles

Go to **Advanced → Team accounts** (visible to ADMIN only). Three roles:

| Role | Can do |
|------|--------|
| **VIEWER** | View everything — universities, crawl progress, exports, logs. Read-only. |
| **OPERATOR** | Everything VIEWER can, plus run the pipeline: crawl, revalidate, export, Change Monitor, and Aliff **DRY-RUN**. |
| **ADMIN** | Everything, plus Settings, the keyword editor, backup/restore, deleting universities, managing team accounts, license activation, and Aliff **LIVE** pushes. |

To add someone: click **Add a team member**, set a temporary password, and
give it to them — they can change it themselves afterward (top-right user
menu → Change password). To reset a forgotten password, use **Reset password**
next to their name; they'll be forced to change it at next login. Deactivating
an account (rather than deleting) keeps their history in the audit log.

Your license may cap the number of team accounts and universities — the
seat/usage counts are shown on the License page.

## 4. Audit log

Every login, settings change, keyword edit, backup/restore, delete-all, crawl
start/stop, export, and Aliff run (DRY-RUN and LIVE) is recorded. ADMIN can
view it under **Advanced → Logs → Audit tab**. Aliff credentials are never
recorded — only the run's outcome (counts, success/failure).

## 5. Backups and restore

**Advanced → Storage** (or Settings, depending on your version) lets an ADMIN
take a backup and restore from one. A backup includes:

- The university list, notes, and manual coverage overrides
- Custom keywords
- Team accounts (including password hashes — safe, since the backup file
  never leaves your server) and the last 500 audit log entries
- The license activation state

**Restoring onto a different machine does not transfer the license** — the
license is still checked against the live fingerprint of whichever machine you
restore onto, so a mismatch shows the same "different machine" message as
normal. This is intentional: restoring your data is not a way around a license
transfer (see §6).

## 6. Moving to a new server (license transfer)

1. Install CLG Search on the new machine and let it show its fingerprint.
2. Send that fingerprint to your vendor; they issue a new key bound to it.
3. Paste the new key on the new machine's License page.
4. Restore your latest backup (§5) onto the new machine to bring over your
   data and team accounts.
5. Decommission the old machine's installation.

## 7. Renewing

You'll see an amber banner starting 30 days before expiry, and licenses have a
7-day grace period after expiry (the app keeps working, with a warning) before
it locks. Contact your vendor for a renewed key — same fingerprint, later
expiry date — and paste it on the License page like any other key.

## 8. LAN access and HTTPS

By default the API listens on every network interface (`HOST=0.0.0.0` in
`.env`) so your team can reach the dashboard from their own PCs at
`http://<this-server>:3100`. **Do not expose these ports to the public
internet without HTTPS and a reverse proxy** — session cookies are sent over
plain HTTP on the assumption this is a trusted office LAN.

If you want HTTPS on the LAN (e.g. `https://clg.internal`), put a reverse
proxy in front and set `COOKIE_SECURE=true` in `.env`. A minimal Caddy example:

```caddyfile
clg.internal {
	reverse_proxy localhost:3100
}
```

Caddy issues and renews the certificate automatically for a local/internal
hostname resolved via your DNS or hosts file.

## 9. Forgot the administrator password (offline recovery)

If every admin account is locked out, someone with shell access to the server
(not a browser) can reset a password directly:

```bash
# Docker deployment:
docker exec -it clg-api node dist/cli/reset-admin.js --username admin --password "a-new-temporary-password"

# Running from source:
pnpm --filter @clg/api reset-admin -- --username admin --password "a-new-temporary-password"
```

This forces a password change at next login and writes an audit log entry
(`auth.admin-reset-by-cli`) so the reset is visible afterward. It requires
server access, not just a dashboard login — it's an intentionally offline
escape hatch.

## Troubleshooting

| Message | What it means | Fix |
|---|---|---|
| "No license was found for this installation" | No key has been activated yet | Follow §1 |
| "This license was activated on a different machine" | The install was copied, restored, or moved without transferring the license | Follow §6 |
| "This license has expired" (past the grace period) | Renewal is overdue | Contact your vendor (§7) |
| "Incorrect username or password" | Wrong credentials, or too many attempts (rate-limited) | Wait a minute and retry, or ask an admin for a reset |
| "You don't have permission to do this" | Your role doesn't allow that action | Ask an ADMIN, or see the role table in §3 |
