# Testing and verification

Choose checks that exercise what you changed, run them, and report what you ran and what you could not. A documentation-only change needs link and path checks, not a build.

Statements are **Established** unless marked **Recommended**.

## What exists

### App (Vitest)

- Config: `app/vitest.config.ts`. A standalone config on purpose: the main `vite.config.ts` loads the Cloudflare plugin, which does not work in Vitest's environment. It sets the `@` alias, the `node` environment, inlines `better-auth`, and includes only `src/**/*.test.ts`.
- Because of that include pattern, tests are `.ts` files that run in Node. There are no component/DOM tests today (`@testing-library/*` is installed but not wired into the config). **Recommended**: keep logic that matters (filters, search params, formatting, policies, CSV, gate rules) in plain modules under `lib/` so it can be tested without rendering.
- Tests sit next to the module (`lib/pagination.test.ts`), with a few in `__tests__/` folders (`orpc/mcp/__tests__/`). Most coverage is pure logic in `app/src/lib/`, config compilation in `app/src/orpc/proxy/`, and schemas.
- Code that touches the database is tested by mocking `@/db` and collaborators with `vi.mock` and hoisted state (see `app/src/query/trial-grant.test.ts`), with fake timers for time. The tests inspected while writing this guide use mocks, and no test setup starts a database.
- Structural tests exist and will fail on omissions: `lib/admin-audit.test.ts` requires every POST server function in `query/` to be audited or explicitly exempted; `lib/env-schema.test.ts` covers environment parsing.

### Server agent (cargo)

- Inline unit tests in each module; `cargo test --locked` from `server-agent/`. No sing-box binary or network needed.
- A Docker-based end-to-end managed-TLS test (`server-agent/scripts/test-managed-tls-docker.sh` with `tests/mock_control_plane.py`) runs in CI. See [Server agent](server-agent.md#checks).
- `examples/query_stats.rs` is a manual smoke test against a live sing-box, not an automated check.

### Not covered by automation

While writing this guide I found no end-to-end browser test, no test that boots the app against a real database, and no test that runs a real agent against a real app (the Docker test uses a mock control plane). Changes that depend on those (SSR rendering, real migrations, driver-specific SQL on `neon-http` vs `node-postgres`, Cloudflare/Hyperdrive behaviour) can only be verified by running the app against a disposable database, and by whatever browser or runtime tooling you have; if you cannot, say in your report that they were not verified.

## Commands

From the repo root unless noted. Taken from `package.json` and CI; the `pnpm` and `cargo` commands below are the documented ones.

| Check                    | Command                                                                              | Notes                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| App tests                | `pnpm test`                                                                          | Recompiles Paraglide, then `vitest run`. This is what CI runs.                                       |
| One app test file        | `pnpm --filter @blossom/app exec vitest run src/lib/pagination.test.ts`              | Skips the Paraglide compile; fine for pure-logic tests.                                              |
| App build                | `pnpm build`                                                                         | `vite build` for the default Cloudflare target. This is what CI runs. Also regenerates generated files. |
| Another deploy target    | `pnpm --filter @blossom/app build:node`                                              | When you touch runtime-specific code or `vite.config.ts`. `build:netlify` and `build:vercel` also exist. |
| Format                   | `pnpm fmt`                                                                           | `oxfmt`; rewrites files, so review the diff.                                                         |
| Lint                     | `pnpm lint`                                                                          | `oxlint`; only `no-unused-vars` is enabled. The pre-commit hook uses `--deny-warnings`.              |
| Type check               | `pnpm --filter @blossom/app exec tsc --noEmit`                                       | No script and not in CI; `vite build` does not type-check. Not verified whether the baseline is clean. |
| Agent tests              | `cd server-agent && cargo test --locked`                                             | CI.                                                                                                  |
| Agent format / lint      | `cd server-agent && cargo fmt --all -- --check` and `cargo clippy --locked --all-targets --all-features -- -D warnings` | CI.                                                          |

CI (`.github/workflows/test.yml`) runs `pnpm test` and `pnpm build` for the app, and test, fmt, clippy, image build and the managed-TLS script for the agent. It does not run `pnpm lint`, `pnpm fmt` or a type check for the app; the pre-commit hook is the only automated lint/format gate there. **Recommended**: run a type check yourself after non-trivial TypeScript changes, since nothing else will.

## Verification by area

| You changed                                                    | Minimum verification                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pure logic in `app/src/lib/`                                   | Add or update the colocated test; run that file, then `pnpm test`.                                                                               |
| A server function in `app/src/query/`                          | `pnpm test` (the audit test covers POST functions); if it is covered by the [publish gate](architecture.md#criterion-and-exceptions), a case in `lib/publish-gate.test.ts`; type check. |
| Agent API routes or schemas, sing-box compilation              | `orpc/proxy/*.test.ts` (notably `agent-v3.test.ts`), regenerate the spec, `cargo test --locked`. See [Generated files](generated-files.md).      |
| Drizzle schema                                                 | `db:generate`, review the SQL, `pnpm test`. To exercise the migration itself, apply it to a disposable database ([details](api-data-auth.md#migrations)). |
| Routes, pages, components, i18n                                | `pnpm build` (regenerates the route tree and Paraglide output), type check, and check both locale files have the new keys. Visual checks need a running app and database; if you did not do them, say so. |
| Env variables                                                  | `lib/env-schema.test.ts`; update `.env.example` and the README table.                                                                            |
| Auth, registration, MCP                                        | The related `lib/*.test.ts` and `orpc/mcp/__tests__/`; extend redaction tests when new fields are sensitive.                                     |
| Build config (`vite.config.ts`, Dockerfile, workflows)         | Build each affected deploy target; a Docker build if the Dockerfile changed.                                                                     |
| Rust agent                                                     | `cargo test`, `cargo fmt --check`, `cargo clippy` as above; the Docker lifecycle test for certificate/reload/heartbeat changes.                  |
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
