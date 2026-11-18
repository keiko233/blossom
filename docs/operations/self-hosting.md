# Self-hosting the control plane

This guide extends the root README's [self-hosting quickstart](../../README.md#self-hosting-quickstart). It uses the repository's `docker-compose.yaml` (services `db`, `migrate`, `app`).

## What the stock Compose file gives you

Verified (code), from `docker-compose.yaml` and `Dockerfile`:

- `db` is `postgres:18-alpine` with the user, password and database all set to `blossom`, data in the named volume `pgdata`, and **no published port** (only reachable from other Compose services).
- `migrate` builds the `builder` image stage and runs `pnpm db:migrate`; `app` starts only after it completes successfully.
- `app` listens on port 3000 (`PORT=3000`, published as `3000:3000`) and runs as a non-root user.
- `BETTER_AUTH_SECRET` is the placeholder `change-me`, `BETTER_AUTH_URL` is `http://localhost:3000`, and **`CERTIFICATE_MASTER_KEY` is not set**. Certificate features fail with "Certificate management requires CERTIFICATE_MASTER_KEY" until it is provided (`app/src/lib/certificate-crypto.ts`).

Treat the committed file as a starting point, not a production configuration.

## Secrets: keep them out of the committed file

The Compose file contains secrets inline. Do not commit real values. A practical pattern, **Unverified** end to end but using standard Compose features:

1. Create an untracked env file next to `docker-compose.yaml`, for example `app.env`, readable only by the deploy user (`chmod 600 app.env`), and add it to `.gitignore` or keep it outside the checkout.
2. Reference it from the `app` service with `env_file: [app.env]` and remove the inline `BETTER_AUTH_SECRET`/`DATABASE_URL` values (and change the database password; `blossom` is public knowledge).
3. Keep the `migrate` service's `DATABASE_URL` consistent with the `db` service's credentials.

Generate the two secrets once and store them in a password manager or secret store, **separately from database backups** (see [Backup and recovery](backup-restore.md#keys-that-backups-do-not-contain)):

```bash
# BETTER_AUTH_SECRET (the README's documented generator)
pnpm dlx @better-auth/cli secret

# CERTIFICATE_MASTER_KEY: 32 random bytes, base64url (command from app/.env.example)
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Rehearsed: the `openssl` pipeline output decodes to exactly 32 bytes with `Buffer.from(value, "base64url")`, which is what `certificate-crypto.ts` requires. The `@better-auth/cli` command was not run.

## Environment variables

The root README's table is the reference for the variables it lists. These additional variables exist in `app/src/lib/env-schema.ts` and `app/.env.example` (the root README table now lists them too):

| Variable                   | Needed for                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `CERTIFICATE_MASTER_KEY`   | Any certificate management. 32 random bytes, base64url. Encrypts stored certificate/private-key material (AES-256-GCM). |
| `ACME_EAB_KID`, `ACME_EAB_HMAC_KEY` | Only the ZeroSSL ACME provider. Both or neither; one without the other is reported as incomplete. |
| `CLOUDFLARE_DNS_API_TOKEN`, `CLOUDFLARE_DNS_ZONE_ID` | Optional automatic DNS-01 validation. Both or neither (`getCertificateDnsCapability`). The token needs DNS Edit on that zone. Without both, DNS challenges are manual. |

Verified (code): `BETTER_AUTH_URL` must be `https` unless the host is `localhost` or `127.0.0.1`. `BETTER_AUTH_SECRET` is **not** in the zod schema (`grep` finds it only in docs and the Compose file); better-auth reads it itself, so a missing or placeholder value is not caught by the app's own env validation. **Unverified:** what better-auth does at runtime when it is absent.

## Certificate issuance migration (agent ACME)

The PR 6 migration adds `managed_certificate.issuer_server_id`,
`challenge_type`, `issuance_mode`, and `certificate_issuance_job`. It does not
rewrite active certificate material or `certificate_server` bindings.

- Existing ACME rows keep `issuance_mode = legacy_control_plane` and continue
  deploying their current material. When the next renewal is needed, the app
  selects an enabled bound server whose agent advertises `acme-v1`, moves the
  row to `agent_delegated`, and starts a job. If no such server exists, the
  policy records an error but the currently active material remains available.
- Existing in-flight control-plane ACME state is not resumed. Any active
  material is untouched; use the certificate's **Renew** action after upgrading
  the issuer agent to start a fresh agent job.
- New ACME certificates require an issuer server and a challenge type. DNS-01
  uses the Cloudflare token/zone when both are set; without them the UI shows
  the TXT values and waits for **Continue DNS**. HTTP-01 temporarily opens port
  80 on the issuer server.
- The private key is generated on the agent, returned over the authenticated
  WebSocket, validated with the fullchain, and encrypted by the control plane
  with `CERTIFICATE_MASTER_KEY`. The plaintext key is never stored in the job
  table or logged.

Remaining scope: only Cloudflare is implemented behind the DNS provider
interface; the agent does not yet persist reusable ACME account credentials;
and HTTP-01 binds the configured address/port rather than discovering an
existing web server or reverse proxy.

## First admin

**The first account ever registered becomes the administrator, exactly once.** Everyone registered afterwards is a plain `user`.

How it works:

- A database trigger (`user_claim_first_admin`, migration `*_first_admin_trigger`) runs before every insert into `"user"`. It tries to insert the single row of `admin_bootstrap`; the insert that succeeds gets `role = 'admin'`, every other insert is left alone.
- The claim and the user insert are one statement, so they commit or roll back together. Simultaneous first registrations queue on the marker row: exactly one wins, and if the winner's insert fails (for example a duplicate email) the claim is still free for the next one. It works the same on `node-postgres` and `neon-http`, and for every sign-up path (email link, social sign-in, admin-created accounts), because better-auth returns the inserted row, so the response and the new session already carry `role: admin`.
- `admin_bootstrap` has no link to `user`. Deleting or truncating every user does **not** reopen the claim.
- **Upgrading** an installation that already has users marks the claim as spent and changes nobody's role. If such a database has no administrator, nobody is promoted automatically; this guide still has no supported procedure for that case.
- Custom SQL was unavoidable because Drizzle's schema DSL cannot express triggers; the table is generated from `app/src/db/admin-bootstrap-schema.ts` and the trigger is a Drizzle custom migration.

Security implications of "first registrant wins":

- **Whoever registers first on a fresh deployment owns it.** If the instance is reachable and registration is open before you create your account, a stranger can take the administrator role. Register your own account immediately after the first migration and before exposing the URL or sharing the address; do not leave a freshly migrated, public instance unattended.
- The claim is taken by the first *successful user insert*, not by a verified email. better-auth's email/password sign-up endpoint is enabled, so a direct API call can create the first account, and make it admin, with an address its owner never confirmed (`requireEmailVerification` only blocks signing in, it does not stop the insert). Email-link and social sign-ups prove control of the address. The registration rules (open/closed mode, allowed email domains) run before the insert, so a refused attempt does not use up the claim: an allowed-domain list narrows who can race you, and closed registration refuses everyone, including you. Sign up while registration is open and, if needed, close it afterwards.
- The first admin is created by the registration flow itself. Treat the first account like a root credential: use a strong password or a mail account you control, and check the user list afterwards.
- An empty database restored from a dump of the schema only, or a database where the `admin_bootstrap` row was deleted by hand, starts a new claim: the next registrant becomes admin. Restore the `admin_bootstrap` table with the rest of the data (see [Backup and recovery](backup-restore.md)).
- Anyone with direct write access to the database can already set any role; this feature does not change that.

Tests: `app/src/db/admin-bootstrap.test.ts` runs the migrations and real concurrent inserts, rollbacks, deletions, upgrades and better-auth sign-ups against a disposable PostgreSQL; see [Testing and verification](../development/testing.md).

## Liveness versus readiness

Verified (code): `GET /api/health` (`app/src/routes/api/health.ts`) returns the constant `{"status":"ok"}`. It does not touch the database, migrations, the auth provider, certificates or any agent. It is a cheap liveness check, and the Docker `HEALTHCHECK` (`wget` to `127.0.0.1:3000/api/health`, 30 s interval, 3 s timeout, 10 s start period) and Railway's `healthcheckPath` both use it.

Consequences:

- A database outage, a failed or missing migration, or a bad `BETTER_AUTH_SECRET` does **not** make `/api/health` fail. A passing health check means the Node process answers HTTP, nothing more.
- Because it does not depend on the database, a database outage cannot trip the health check into a restart loop.
- **There is no readiness endpoint in this checkout.** If one is added later, keep liveness cheap and separate, bound its database timeout, return no error details to unauthenticated callers, and make sure orchestrators use it only to withhold traffic, not to restart the container.
- **Unverified (general Docker behaviour):** plain Docker and Compose mark a container `unhealthy` but do not restart it for that alone; whether Railway restarts on a failing health check beyond deploy gating was not checked.

Until a readiness check exists, confirm a deployment by exercising it: sign in, load an admin page that reads the database, and see the steps in [Local validation](local-validation.md).

Two things are **not** client connectivity tests, and must not be reported as such:

- An agent heartbeat arriving means the agent can reach the control plane with a valid token. It says nothing about whether proxy clients can connect.
- A TCP port being open on the server says nothing about TLS validity, credentials or routing. Test connectivity with a real client through a real node.

## Upgrade and rollback of the control plane

Verified (code): migrations are forward-only folders (`app/drizzle/<timestamp>_<name>/migration.sql`); there are no down migrations. The Compose `migrate` service applies pending migrations on every `docker compose up`.

1. Take a [database backup](backup-restore.md#backup) first, and keep the matching `BETTER_AUTH_SECRET` and `CERTIFICATE_MASTER_KEY`.
2. Pin the app image you are leaving (`ghcr.io/keiko233/blossom:sha-<commit>`) so you can return to it.
3. Pull or build the new image and run `docker compose up -d`.
4. Roll back by restoring the pre-upgrade backup into a fresh database and starting the previous image. **Unverified:** running an older app image against a newer schema is not supported or tested.

The agent API is `GET /api/agent/config/v3` only: the router (`app/src/orpc/router/index.ts`) exposes `agent.getConfigV3`, `agent.heartbeat` and `agent.reportTraffic`. An agent that only speaks an older config version has no endpoint to pull from, so upgrade agents that predate `config-v3` before or together with the control plane. See [Server agent](server-agent.md#upgrade-and-rollback).
