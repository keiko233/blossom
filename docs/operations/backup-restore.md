# Backup and recovery

A recoverable Blossom deployment is **the PostgreSQL database plus two independent secrets**. The commands use the Compose service names and the Compose default database `blossom` with placeholder credentials; adapt names for your deployment and never paste real connection strings into shared places.

## What holds what

| Item                                  | Where it lives                              | Needed to restore? |
| ------------------------------------- | ------------------------------------------- | ------------------ |
| Users, sessions, servers, nodes, plans, subscriptions, traffic, settings, audit, ACME/certificate rows | PostgreSQL | Yes |
| Certificate and private-key material  | PostgreSQL, as AES-256-GCM ciphertext        | Yes, and it is **unreadable without `CERTIFICATE_MASTER_KEY`** |
| `BETTER_AUTH_SECRET`                  | App environment                              | Yes |
| `CERTIFICATE_MASTER_KEY`              | App environment                              | Yes, if any certificate is stored |
| ACME EAB, Cloudflare token, OAuth and email provider secrets | App environment | Re-obtainable from the providers, but record where they are kept |
| Agent tokens                          | Only a hash in PostgreSQL; plaintext only on each agent host | Agents keep working if the DB is restored from a backup that has the same token hashes; otherwise reset tokens |
| Agent state volumes                   | One per proxy server                         | No (see [Agent state](#agent-state)) |

## Keys that backups do not contain

Database dumps deliberately do **not** include the environment secrets. Protect them independently:

- **Store `BETTER_AUTH_SECRET` and `CERTIFICATE_MASTER_KEY` in a secret store or password manager, separate from the backup location and separate from each other.** Whoever holds a dump and `CERTIFICATE_MASTER_KEY` can decrypt every stored certificate private key; keeping them apart is the point of encrypting at rest.
- **Lose `CERTIFICATE_MASTER_KEY` and the stored certificate ciphertext is unrecoverable.** Verified (code): decryption fails with "Unable to decrypt certificate secret" (`app/src/lib/certificate-crypto.ts`). You would have to re-import or re-issue every certificate.
- **Do not rotate it by swapping the value.** The envelope format is `v1:<iv>:<tag>:<ciphertext>` with no key identifier, and no re-encryption command was found in the repository, so there is no supported rotation procedure. Treat the key as permanent unless a rotation tool is added.
- `BETTER_AUTH_SECRET` is used by better-auth, not by app code. The database has a `jwks` table with a `private_key` column (`app/src/db/oauth-schema.ts`). **Unverified:** how better-auth uses the secret (cookie signing, key encryption). Assume restoring with a different value invalidates existing sessions and may break stored signing keys; keep the original.
- A dump file contains user emails, password hashes, session tokens, subscription tokens and certificate ciphertext. Store it encrypted and access-controlled, and do not attach it to tickets.

## Backup

Use PostgreSQL's custom format so you can restore selectively and verify the archive. With the stock Compose file (the `db` service has no published port, so run the tools inside it):

```bash
# Timestamped file name, e.g. blossom-202610301530.dump; keep it outside the repository
BACKUP="blossom-$(date +%Y%m%d%H%M).dump"
docker compose exec -T db pg_dump -U blossom -d blossom -Fc --no-owner > "$BACKUP"
```

- Take one before every upgrade ([Self-hosting](self-hosting.md#upgrade-and-rollback-of-the-control-plane)) and on a schedule you can defend. Scheduling and retention are yours to define; none is provided.
- Run the dump from the same or a newer PostgreSQL major version than the server. The rehearsal below used the `postgres:18-alpine` image (pg_dump 18.6).
- A `pg_dump` is a consistent snapshot of the database but not point-in-time recovery. For a lower recovery-point objective use your PostgreSQL platform's WAL archiving or managed backups. **Not covered or verified here**, including Neon.
- Never run `docker compose down -v`: it deletes the `pgdata` volume.

## Restore

Always restore into a **new, empty** database first and verify before cutting over. Do not restore on top of a live database.

```bash
# 1. Create an empty database next to the live one (or on a fresh server)
docker compose exec -T db createdb -U blossom blossom_restore

# 2. Restore; stop at the first error. BACKUP is the dump file's actual name,
#    e.g. BACKUP=blossom-202610301530.dump
docker compose exec -T db pg_restore -U blossom -d blossom_restore \
  --no-owner --exit-on-error < "$BACKUP"
```

Then:

1. Stop the app (`docker compose stop app`) so nothing writes while you switch.
2. Point the app at the restored database (change `DATABASE_URL` for both `migrate` and `app`, or rename databases), with **the same `BETTER_AUTH_SECRET` and `CERTIFICATE_MASTER_KEY` as when the backup was taken**.
3. Start the stack. The `migrate` service applies any migration newer than the backup. **Unverified:** this relies on the dump containing Drizzle's migration journal (`drizzle.__drizzle_migrations`); the rehearsal below applied the SQL by hand and did not exercise it.
4. Run the verification checklist.

### Rehearsal that was run

On 2026-10-30, with a throwaway `postgres:18-alpine` container, fake credentials and no published port:

1. Applied every committed `app/drizzle/*/migration.sql`, in order, with plain `psql` (36 public tables resulted).
2. Inserted one fake user (`fake@example.invalid`).
3. Ran `pg_dump -Fc --no-owner` inside the container and wrote it to a temporary host directory.
4. Created an empty second database and ran `pg_restore --no-owner --exit-on-error` into it: exit status 0, 36 tables, 1 user, matching the source.
5. Removed the container (started with `--rm`) and the temporary directory.

Not covered by that run: restoring through Docker Compose, `drizzle-kit migrate` against the restored database, certificate decryption with the master key, the app starting against the restore, agent behaviour after restore. Use [Local validation](local-validation.md) for those.

One practical finding: the Postgres image's entrypoint briefly runs a temporary server that answers `pg_isready` over the Unix socket before the real server starts, so a script that applies SQL immediately after `pg_isready` can fail with "database does not exist" or "shutting down". Check readiness over TCP (`pg_isready -h 127.0.0.1`) or wait for the second "ready to accept connections" log line.

## Restore verification checklist

After the app starts against the restored database, with the original secrets:

1. `GET /api/health` returns ok (this proves only that the process is up; see [Liveness versus readiness](self-hosting.md#liveness-versus-readiness)).
2. An existing admin can sign in. (If the database has users but no admin, nobody is promoted automatically; see [First admin](self-hosting.md#first-admin).)
3. The admin certificate page lists certificates and an export or detail view decrypts one. This is the check that the `CERTIFICATE_MASTER_KEY` is correct.
4. Servers, nodes, plans and subscriptions counts match the source.
5. Each agent heartbeats again. Test with a **real client** that a node works end to end; a heartbeat is not a connectivity test.

## Agent state

- Agents need no restore step for a control-plane restore. They pull the full desired state, including certificate artifacts, from `/api/agent/config/v3` on their next poll.
- If the restored backup is older than a token reset, the old plaintext token is back in force and the new one is not: agents using the newer token get unauthorized. Reset the token in the admin UI and update the agent's `.env`.
- Revisions: the publish gate tracks each server's desired sequence and the agent's applied sequence. After restoring an older backup these can disagree with what agents last applied. **Unverified.** Do not rely on the gate's behaviour until every agent has heartbeated since the restore, and spot-check one change end to end.
- Data written after the backup (traffic, new subscriptions, account changes) is lost, and subscription tokens revert to the backed-up ones.
- Backing up an agent's state volume is optional. It lets an agent start its last-known-good config while the control plane is down. It contains certificate private keys in plaintext, so protect it like a key store. If you do not back it up, recreating the agent with the same token is enough.
