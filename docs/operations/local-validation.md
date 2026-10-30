# Local validation

Concrete steps to validate the other operations guides later. Everything here uses disposable resources with fake credentials. **Do not point any step at a real database, a production control plane, or a host whose proxy you rely on.**

Conventions: pick a fresh scratch directory (`SCRATCH=$(mktemp -d)`), use random high ports, and clean up with a `trap` so a failed step still removes containers and files.

## 1. Documentation checks (no services)

```bash
# Run from the repository root. Every relative link and heading anchor in
# README.md and docs/operations/*.md must resolve.
python3 -I - <<'PY'
import glob, os, re
def slug(h):
    h = h.strip().lower().replace('`', '')
    return re.sub(r'[^\w\- ]', '', h).replace(' ', '-')
files = ['README.md'] + glob.glob('docs/**/*.md', recursive=True)
anchors = {os.path.normpath(f): {slug(m.group(1)) for m in re.finditer(r'^#+\s+(.*)$', open(f).read(), re.M)} for f in files}
bad = 0
for f in ['README.md'] + glob.glob('docs/operations/*.md'):
    fence = chr(96) * 3  # skip fenced code blocks
    text = re.sub(fence + '.*?' + fence, '', open(f).read(), flags=re.S)
    for m in re.finditer(r'\]\(([^)\s]+)\)', text):
        link = m.group(1)
        if link.startswith(('http', 'mailto')):
            continue
        path, _, frag = link.partition('#')
        target = os.path.normpath(os.path.join(os.path.dirname(f), path)) if path else os.path.normpath(f)
        if not os.path.exists(target):
            print('BROKEN', f, link); bad += 1
        elif frag and target.endswith('.md') and frag not in anchors.get(target, ()):
            print('BAD ANCHOR', f, link); bad += 1
print('bad links:', bad)
PY
```

## 2. Backup and restore rehearsal (PostgreSQL only)

This reproduces the rehearsal recorded in [Backup and recovery](backup-restore.md#rehearsal-that-was-run). Needs Docker and the `postgres:18-alpine` image.

```bash
SCRATCH=$(mktemp -d); N=blossom-ops-rehearsal-$$
trap 'docker stop "$N" >/dev/null 2>&1; rm -rf "$SCRATCH"' EXIT
docker run -d --rm --name "$N" -e POSTGRES_USER=blossom -e POSTGRES_PASSWORD=local-rehearsal-only \
  -e POSTGRES_DB=blossom postgres:18-alpine
# wait over TCP, then a little more: the entrypoint restarts the server once
until docker exec "$N" pg_isready -h 127.0.0.1 -U blossom -d blossom; do sleep 1; done
for d in $(ls app/drizzle | sort); do
  docker exec -i "$N" psql -q -v ON_ERROR_STOP=1 -U blossom -d blossom < "app/drizzle/$d/migration.sql"
done
docker exec "$N" psql -U blossom -d blossom -c "insert into \"user\"(id,name,email) values ('u-fake','Fake','fake@example.invalid')"
docker exec "$N" pg_dump -U blossom -d blossom -Fc --no-owner > "$SCRATCH/blossom.dump"
docker exec "$N" createdb -U blossom blossom_restore
docker exec -i "$N" pg_restore -U blossom -d blossom_restore --no-owner --exit-on-error < "$SCRATCH/blossom.dump"
for db in blossom blossom_restore; do
  docker exec "$N" psql -U blossom -d "$db" -Atc "select count(*) from information_schema.tables where table_schema='public'"
  docker exec "$N" psql -U blossom -d "$db" -Atc 'select count(*) from "user"'
done
```

Pass: both databases report the same table and user counts. (If the TCP wait still races, add a short `sleep 3` after it.)

## 3. Full application restore (extends step 2)

Needs `pnpm install --frozen-lockfile` in a checkout. Use a published port on `127.0.0.1` only (for example `-p 127.0.0.1:55432:5432`), and an explicit, throwaway `DATABASE_URL`.

1. Use `pnpm --filter @blossom/app db:migrate` (not the hand-applied SQL) against the scratch database; confirm `drizzle.__drizzle_migrations` exists. This closes the journal gap noted in the backup guide.
2. Generate throwaway secrets (do not reuse real ones) and run the Node build against the scratch database: set `DATABASE_URL`, `BETTER_AUTH_URL=http://localhost:<port>`, `BETTER_AUTH_SECRET`, `CERTIFICATE_MASTER_KEY`.
3. Create a certificate through a supported flow (import a throwaway self-signed one), dump, restore into a second database, start a second app instance on another port against the restore with the **same** `CERTIFICATE_MASTER_KEY`, and confirm the certificate decrypts.
4. Repeat with a **different** `CERTIFICATE_MASTER_KEY` and confirm decryption fails with "Unable to decrypt certificate secret". This proves why the key must be protected and kept.

## 4. Agent with a mock control plane

The repository already contains a contained harness; see [Server agent handbook](../development/server-agent.md#checks):

```bash
docker build --build-arg BUILD_ID=ops-validation -t blossom/server-agent:ops-validation server-agent
server-agent/scripts/test-managed-tls-docker.sh blossom/server-agent:ops-validation
```

The image build compiles sing-box and is slow. The script starts a mock control plane on port 18765 (`MOCK_PORT` overrides it) and cleans up on exit.

### Agent shutdown timing

To resolve the SIGTERM question in [Server agent](server-agent.md#upgrade-and-rollback), run the image against the mock control plane (or a disposable local app), then:

```bash
CONTAINER=my-agent-container   # replace with the real name from `docker ps`
time docker stop "$CONTAINER"      # default grace is 10 s
docker inspect -f '{{.State.ExitCode}}' "$CONTAINER"
```

A time near 10 s with exit code 137 means the agent did not handle SIGTERM and was killed.

### State persistence

With a named volume, run the agent until it reports an applied revision, `docker rm -f` the container, start a new one with the same volume and a **blocked** control-plane URL, and confirm sing-box starts from `last-known-good.json` (the log shows the startup preflight). Repeat with the anonymous-volume `docker run` command from the admin UI to confirm the state is orphaned after re-creation.

## 5. Liveness behaviour

With a scratch app and database: `curl -fsS http://127.0.0.1:<port>/api/health` returns `{"status":"ok"}`. Stop the database container and repeat. Expected from the code: it still returns ok. That confirms liveness does not reflect database state and that a database outage cannot cause a health-driven restart loop.

## Open verification gaps

Not verified when these guides were written; each is worth closing:

- `docker compose exec -T db ...` forms (the rehearsal used `docker exec` on a standalone container).
- `drizzle-kit migrate` against a restored database, and presence of the Drizzle journal in a dump.
- Certificate decryption after restore; behaviour with a wrong `CERTIFICATE_MASTER_KEY` end to end.
- What better-auth does without or with a changed `BETTER_AUTH_SECRET`.
- Running an older app image against a newer schema, and older agent against newer state files.
- Agent SIGTERM handling, anonymous-volume orphaning, and the failure mode of a local service holding `127.0.0.1:8080`.
- Publish-gate behaviour after restoring an older database.
- Secret handling with `env_file` in the app's Compose file.
- Anything on Cloudflare, Netlify, Vercel, Railway or Neon (backup, health checks, scheduling).
- The first-admin claim is covered by `app/src/db/admin-bootstrap.test.ts` against a disposable database, not by these steps; see [Self-hosting](self-hosting.md#first-admin).
