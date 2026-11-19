# Testing and verification

Choose checks that exercise what you changed, run them, and report what you ran and what you could not. A documentation-only change needs link and path checks, not a build.

Statements are **Established** unless marked **Recommended**.

## What exists

### App (Vitest)

- Config: `app/vitest.config.ts`. A standalone config on purpose: the main `vite.config.ts` loads the Cloudflare plugin, which does not work in Vitest's environment. It sets the `@` alias, the `node` environment, inlines `better-auth`, and includes only `src/**/*.test.ts`.
- Because of that include pattern, tests are `.ts` files that run in Node. There are no component/DOM tests today (`@testing-library/*` is installed but not wired into the config). **Recommended**: keep logic that matters (filters, search params, formatting, policies, CSV, gate rules) in plain modules under `lib/` so it can be tested without rendering.
- Tests sit next to the module (`lib/pagination.test.ts`), with a few in `__tests__/` folders (`orpc/mcp/__tests__/`). Most coverage is pure logic in `app/src/lib/`, config compilation in `app/src/orpc/proxy/`, and schemas.
- Code that touches the database is tested by mocking `@/db` and collaborators with `vi.mock` and hoisted state (see `app/src/query/trial-grant.test.ts`), with fake timers for time. Those tests use mocks, and no test setup starts a database; the real-database suites below connects to a database you provide.
- **Real-PostgreSQL tests** are the exception: `app/src/db/admin-bootstrap.test.ts` runs the actual migrations, concurrent inserts, rollbacks, upgrades and better-auth sign-ups against a database named by `BLOSSOM_BOOTSTRAP_TEST_DATABASE_URL`, and is skipped when that is unset. **It wipes that database** (drops `public` and `drizzle`); it only accepts a loopback host and a database name containing `test`. CI provides a throwaway `postgres` service. To also cover `neon-http`, set `BLOSSOM_BOOTSTRAP_TEST_NEON_HTTP_URL` (the Neon-style connection string the client uses) and `BLOSSOM_BOOTSTRAP_TEST_NEON_HTTP_ENDPOINT` (the `/sql` URL of a local Neon HTTP proxy reaching the same database); CI does not run that half.
- One opt-in real-database test exists: `app/src/query/subscription-credential-rotation.integration.test.ts` (atomicity, concurrency and fetch/agent interleaving of credential rotation). It is skipped unless `BLOSSOM_TEST_PG_URL` is set to a loopback database named `blossom_disposable_*` (its `public` schema is dropped and rebuilt from `app/drizzle/`), and adds a `neon-http` run when `BLOSSOM_TEST_NEON_HTTP_URL` points at a local Neon HTTP proxy (`/sql`) in front of the same database and `BLOSSOM_TEST_NEON_CONNECTION_URL` supplies matching credentials and database using `db.localtest.me` as host. Run it with `pnpm --filter @blossom/app exec vitest run src/query/subscription-credential-rotation.integration.test.ts`. The proxy exercises the app's `neon-http` driver stack, not Neon's hosted service.
- Disposable-database suites that share one database (`agent-traffic`, `agent-ws-session`, `agent-ws-v2-state`, `agent-ws-v2-convergence`, `subscription-credential-rotation`) wipe the same tables. Run them with `vitest run --no-file-parallelism`. The agent WebSocket v2 suites are gated by `BLOSSOM_TEST_DATABASE_URL` and `BLOSSOM_TEST_CONFIRM_DISPOSABLE=yes`, and run neon-http when `BLOSSOM_TEST_NEON_HTTP_URL` and `BLOSSOM_TEST_NEON_HTTP_ENDPOINT` point at a `/sql` proxy in front of the same database. The repository does not include that proxy; any server that accepts the Neon HTTP `POST /sql` request and runs it on the disposable database will do.
- Structural tests exist and will fail on omissions: `lib/admin-audit.test.ts` requires every POST server function in `query/` to be audited or explicitly exempted; `lib/env-schema.test.ts` covers environment parsing.

### Server agent (cargo)

- Inline unit tests in each module; `cargo test --locked` from `server-agent/`. No sing-box binary or network needed.
- `server-agent/tests/ws_v2_lifecycle.rs` runs the real agent binary against a loopback v2 WebSocket control plane and a fake sing-box in a disposable state directory. It asserts that no HTTP agent API call occurs, and covers apply, exact traffic replay after a lost acknowledgement, status reconciliation, rollback, and offline last-known-good startup.
- A Docker-based end-to-end managed-TLS test (`server-agent/scripts/test-managed-tls-docker.sh` with `tests/mock_control_plane.py`) runs in CI. See [Server agent](server-agent.md#checks).
- `examples/query_stats.rs` is a manual smoke test against a live sing-box, not an automated check.

### Not covered by automation

There is no automated end-to-end browser test. The opt-in [real-component harness](../../tests/integration/blossom/README.md) runs the app, PostgreSQL, agent and sing-box locally; it does not verify hosted Cloudflare/Hyperdrive or Neon services. Report the checks actually run.

## Commands

From the repo root unless noted. Taken from `package.json` and CI; the `pnpm` and `cargo` commands below are the documented ones.

| Check                    | Command                                                                              | Notes                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| App tests                | `pnpm test`                                                                          | Recompiles Paraglide, then `vitest run`. This is what CI runs.                                       |
| One app test file        | `pnpm --filter @blossom/app exec vitest run src/lib/pagination.test.ts`              | Skips the Paraglide compile; fine for pure-logic tests.                                              |
| App build                | `pnpm build`                                                                         | `vite build` for the default Cloudflare target. This is what CI runs. Also regenerates generated files. |
| Another deploy target    | `pnpm --filter @blossom/app build:node`                                              | When you touch runtime-specific code or `vite.config.ts`. `build:vercel` also exists. |
| Format                   | `pnpm fmt`                                                                           | `oxfmt`; rewrites files, so review the diff.                                                         |
| Lint                     | `pnpm lint`                                                                          | `oxlint`; only `no-unused-vars` is enabled. The pre-commit hook uses `--deny-warnings`.              |
| Type check               | `pnpm --filter @blossom/app exec tsc --noEmit`                                       | No script and not in CI; `vite build` does not type-check. Not verified whether the baseline is clean. |
| Agent tests              | `cd server-agent && cargo test --locked`                                             | CI.                                                                                                  |
| Agent format / lint      | `cd server-agent && cargo fmt --all -- --check` and `cargo clippy --locked --all-targets --all-features -- -D warnings` | CI.                                                          |

CI (`.github/workflows/test.yml`) runs `pnpm test` and a build of every deploy target (`pnpm build`, then `build:node`, `build:vercel`) for the app, and test, fmt, clippy, image build and the managed-TLS script for the agent. It does not run `pnpm lint`, `pnpm fmt` or a type check for the app; the pre-commit hook is the only automated lint/format gate there. **Recommended**: run a type check yourself after non-trivial TypeScript changes, since nothing else will.

## Verification by area

| You changed                                                    | Minimum verification                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pure logic in `app/src/lib/`                                   | Add or update the colocated test; run that file, then `pnpm test`.                                                                               |
| A server function in `app/src/query/`                          | `pnpm test` (the audit test covers POST functions); if it is covered by the [publish gate](architecture.md#criterion-and-exceptions), a case in `lib/publish-gate.test.ts`; type check. |
| Agent API routes or schemas, sing-box compilation              | `orpc/proxy/*.test.ts` (notably `agent-v3.test.ts`), regenerate the spec, `cargo test --locked`. See [Generated files](generated-files.md).      |
| Agent WebSocket contract, hub or route                         | `packages/contracts/src/agent-ws.test.ts`, `lib/agent-ws-*.test.ts`, `lib/realtime-hub.test.ts`; type check and build each deploy target.       |
| Agent WebSocket v2 (contract, session, hubs, PTY/update/ACME parity, fenced writes) | `packages/contracts/src/agent-ws-v2.test.ts` (shared fixtures), `lib/agent-ws-v2-*.test.ts`, `lib/realtime-hub-v2.test.ts`, PTY relay/Auth tests, and with a disposable database `query/agent-ws-*.integration.test.ts` on both drivers; build each deploy target. |
| Admin PTY terminal and relay                                   | `packages/contracts/src/agent-ws.test.ts`, `lib/pty-protocol.test.ts`, `lib/pty-authorization.test.ts`, `lib/admin-pty-route.test.ts`, `lib/realtime-hub-pty.test.ts`, `durable-objects/pty-session.cloudflare.test.ts`; Rust PTY tests; type check and build each deploy target. The Cloudflare re-check SQL also has an opt-in real-database test, `durable-objects/pty-session.integration.test.ts`, which runs when `BLOSSOM_TEST_PG_URL` names a loopback `blossom_disposable_*` database with the migrations applied. |
| Drizzle schema                                                 | `db:generate`, review the SQL, `pnpm test`. To exercise the migration itself, apply it to a disposable database ([details](api-data-auth.md#migrations)). |
| Routes, pages, components, i18n                                | `pnpm build` (regenerates the route tree and Paraglide output), type check, and check both locale files have the new keys. Visual checks need a running app and database; if you did not do them, say so. |
| Env variables                                                  | `lib/env-schema.test.ts`; update `.env.example` and the README table.                                                                            |
| Auth, registration, MCP                                        | The related `lib/*.test.ts` and `orpc/mcp/__tests__/`; extend redaction tests when new fields are sensitive.                                     |
| Build config (`vite.config.ts`, Dockerfile, workflows)         | Build each affected deploy target; a Docker build if the Dockerfile changed. Local runtime smoke (not a deployment check): run the Node output with `node .output/server/index.mjs`, call the Vercel function handler with a `Request`, or run the Cloudflare output with `wrangler dev --local` from a copy of `dist/` with disposable `vars` (no `.env.local`); request `/api/health`, `/`, `/api/spec.json`. Record the PID of anything you start and stop only that PID. |
| Rust agent                                                     | `cargo test`, `cargo fmt --check`, `cargo clippy` as above; the Docker lifecycle test for certificate/reload/heartbeat changes.                  |
| Agent WebSocket v2 lifecycle                                   | `cargo test --locked --test ws_v2_lifecycle`; the shared v2 fixtures are decoded by `cargo test --locked ws::v2::codec`, which also runs in the full suite. The Docker managed-TLS lifecycle still covers the v1 transport and HTTP fallback. |
| Agent ACME                                                     | `cargo test --locked` (fake CA/DNS ports), app certificate ACME/DNS/self-signed tests, type check, and all three app build targets. Never call a production CA or DNS provider in verification. |
| Documentation only                                             | Local links and referenced paths/commands resolve; `git diff --check`.                                                                           |

## Writing tests

- Test behaviour through the module's public functions with plain values; build small fixtures inline.
- Fake collaborators at the module boundary (`vi.mock("@/db")`, injected clocks via `vi.useFakeTimers`) rather than reaching into internals. Reset mocks in `beforeEach`.
- Keep unit tests independent of the real network, a database, the wall clock and the developer's environment. Use obviously fake secrets and placeholder hosts; never put real secret values in fixtures.
- For a bug fix, write the test that reproduces it first.
- **Recommended**: when a rule must hold across a directory (as the audit test does for server functions), prefer a structural test over a review comment.

## Review before submitting

- Every changed line traces to the request; unrelated problems are mentioned, not fixed.
- Generated files are current if their sources changed, and untouched otherwise ([Generated files](generated-files.md)).
- New server functions authenticate, validate with zod, are audited (POST) and return no secrets.
- Mutations that the [publish gate](architecture.md#criterion-and-exceptions) covers record a config change; ones that fall under its exceptions (certificate rotation, address/name edits, routing rules) do not.
- User-visible strings use Paraglide and exist in both locales.
- No secret values, local env files (`.env.local`) or build output in the diff, and none in your report.
- The relevant checks above ran, and the report lists any that did not.
