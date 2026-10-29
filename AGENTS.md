# AGENTS.md

Blossom is a sing-box proxy subscription control plane: a TanStack Start (React 19, SSR) app in `app/` backed by PostgreSQL/Drizzle and better-auth, plus a Rust `server-agent/` that runs once per proxy server and consumes the app's `/api/agent/*` OpenAPI surface. See the [README](README.md) for setup, deployment and environment variables.

`CLAUDE.md` imports this file, so every agent tool follows the same instructions. The detailed rules live in [docs/development/](docs/development/README.md); this file routes to them and restates only what is most often gotten wrong. When a shared rule changes, update its guide, and update this file only if it restates that rule.

## Read the guide for the area you touch

Start with the [handbook index](docs/development/README.md), then read what applies. You do not need every guide for every task.

| Working on                                                                       | Read                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| System layout, request surfaces, deploy targets, publish gate                    | [Architecture](docs/development/architecture.md)         |
| React/TypeScript, routes, UI, i18n, formatting                                   | [App conventions](docs/development/app.md)               |
| Server functions, oRPC/agent API, MCP, Drizzle schema, migrations, env, auth     | [API, data and auth](docs/development/api-data-auth.md)  |
| The Rust agent, its OpenAPI client, sing-box config handling                     | [Server agent](docs/development/server-agent.md)         |
| Generated files and the commands that regenerate them                            | [Generated files](docs/development/generated-files.md)   |
| Tests and which checks to run for a change                                       | [Testing and verification](docs/development/testing.md)  |
| Commands, CI, git hooks, commits                                                 | [Workflow](docs/development/workflow.md)                 |

## Working principles

- **Think before coding.** State assumptions; if a request has several plausible readings or something is unclear, say so (or ask) instead of guessing. For small, obvious tasks a sentence is enough.
- **Keep it simple.** Write the minimum that solves the problem. No speculative features, abstractions for single use, or error handling for impossible cases.
- **Make surgical changes.** Every changed line should trace to the request. Match surrounding style, do not refactor or reformat adjacent code, and mention unrelated problems instead of fixing them. Remove only the imports and code your own change orphaned.
- **Verify.** Turn the task into a checkable outcome (a failing test that now passes, a build that succeeds) and run the checks from [Testing and verification](docs/development/testing.md) that fit the area. Say plainly what you did not or could not verify.

## Rules that are easy to break

- Run `pnpm` commands from the repo root. App-only: `pnpm --filter @blossom/app <script>`. The Rust agent is not in the pnpm workspace; run `cargo` inside `server-agent/`.
- Admin operations are TanStack **server functions** in `app/src/query/`, not oRPC procedures. The oRPC router exposes only the per-server `agent.*` endpoints. Admin server functions call `ensureAdmin()`, and a test requires every `POST` server function in `app/src/query/` to carry `adminAudit(...)` or be explicitly exempted as user-facing. See [API, data and auth](docs/development/api-data-auth.md).
- Never hand-edit generated files (`app/src/route-tree.gen.ts`, `app/src/paraglide/`, `app/drizzle/*/snapshot.json`, `server-agent/openapi/spec*.json`, lockfiles). Regenerate them as described in [Generated files](docs/development/generated-files.md). After changing the agent-facing API, regenerate the agent spec and rebuild the agent.
- A mutation that changes state an agent must apply before subscriptions may safely advertise it (node create/update/enable/delete, credential rotation, entitlement changes, server enable/disable) records a `config_change` (publish gate). Certificate rotations, address/name edits and routing-rule edits do not. The criterion and exceptions are in [Architecture](docs/development/architecture.md#publish-gate).
- User-visible strings go through Paraglide (`m.some_key()`), with keys added to both `app/messages/en.json` and `app/messages/zh-cn.json`.
- Never expose secret values: do not print, log, paste into docs/tests/commit messages, or commit the contents of `app/.env.local` or other `*.local` env files, agent tokens, subscription tokens, OAuth or API secrets, or certificate private keys. Reading a local env file when a task needs it (for example to learn which variables are set) is fine as long as values stay out of your output.
- Some commands act on whatever `DATABASE_URL` points at or start long-running processes: `db:migrate` applies SQL, `db:push` rewrites the schema directly, `pnpm dev` and `cargo run` start servers. Know the target before running them, and use a disposable local database and state directory for verification. Whether to run them at all is up to the task instructions. See [API, data and auth](docs/development/api-data-auth.md#migrations).
- Commits, pushes and deployments follow the task instructions. If you commit, stage explicit paths and follow the [commit conventions](docs/development/workflow.md#commits).

## Finishing a task

Before reporting done: the diff contains only requested changes; generated files are current or untouched; the relevant checks ran (or the report says which did not and why); and no secrets or local-only files (`.env.local`, build output) are staged.
