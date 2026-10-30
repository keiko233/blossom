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

## First admin

**There is no verified bootstrap mechanism for the first admin. This is a gap.**

What the code shows:

- New accounts get `role = 'user'` (`app/src/db/auth-schema.ts`). The better-auth `admin()` plugin is registered with no options (`app/src/lib/auth.tsx`), so no admin user IDs or default admin role are configured.
- Every code path that assigns `admin` is itself admin-gated: the `setUserRole` server function (`app/src/query/users.ts`, `ensureAdmin()` first) and the admin-only MCP tool. The admin-only create-user dialog can set a role but requires an existing admin.
- The repository has no seed script, CLI command or environment variable for creating an admin, and the agent API cannot reach admin operations.

So a fresh deployment has no documented, tested way to obtain its first administrator. This guide deliberately does not provide a command or SQL statement, because none is verified or supported. Editing the `role` column of the `user` table by hand is outside any tested procedure; do not treat this note as a recommendation.

### Proposal for a separately scoped bootstrap design

Not implemented. Needs its own task, tests and handbook update:

- A one-shot, explicit operation, for example a script run inside the app image against the configured `DATABASE_URL`, or a single environment variable naming the bootstrap email, honoured **only while zero admins exist**.
- It must refuse to run once any admin exists, be idempotent, not log the email-link or any credential, and write an audit entry.
- It must be safe under concurrent execution. A single SQL statement is not assumed to be enough: under PostgreSQL's default isolation, two concurrent "promote if no admin exists" statements can both see zero admins. The design must choose and justify an explicit uniqueness or serialization mechanism (for example a database constraint that permits only one bootstrap record, or an advisory lock or equivalent serialization), and prove it with concurrent tests.
- That mechanism must work on both database drivers; `neon-http` has no interactive transactions, so a lock held across several statements is not available there.
- It must be tested against a disposable PostgreSQL database, including many simultaneous bootstrap attempts (exactly one succeeds) and the case where open registration lets someone else register first.

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
