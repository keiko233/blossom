# AGENTS.md

Blossom is a sing-box proxy subscription control plane: a TanStack Start (React 19, SSR) app in `app/` with shared packages in `packages/{domain,contracts,database}` backed by PostgreSQL/Drizzle and better-auth, plus a standalone Rust `server-agent/` that runs once per proxy server and consumes the app's `/api/agent/*` surface. See [README.md](README.md) for setup, deployment, and environment variables.

## Mandatory Reading: Development Standards

Before starting non-trivial repository work, read the [handbook index](docs/development/README.md) and the guides that apply to your area:

| Working on                                                                   | Read                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| System layout, request surfaces, deploy targets, publish gate, security      | [Architecture](docs/development/architecture.md)             |
| React/TypeScript style, grouping, UI composition, `data-slot`, `cva`         | [TypeScript and React style](docs/development/typescript.md) |
| App layout, TanStack Start/Router/Form, i18n, formatting, lint               | [App conventions](docs/development/app.md)                   |
| Admin UI layout, scroll ownership, page chrome, loading, anti-slop rules     | [UI design standard](docs/development/ui-design.md)          |
| Server functions, oRPC/agent API, MCP, Drizzle schema, migrations, env, auth | [API, data and auth](docs/development/api-data-auth.md)      |
| Rust style, visibility, ports, error handling, async, testing (`server-agent`) | [Rust code guide](docs/development/rust.md)                |
| `server-agent/` modules, OpenAPI client, sing-box supervision, updates       | [Server agent](docs/development/server-agent.md)             |
| Generated files and the commands that regenerate them                        | [Generated files](docs/development/generated-files.md)       |
| Tests and which checks to run for a change                                   | [Testing and verification](docs/development/testing.md)      |
| Commands, CI, workflows, worktrees, git hooks, commits                       | [Workflow](docs/development/workflow.md)                     |

Plans and redesign roadmaps live under [docs/spec/](docs/spec/) and [docs/roadmap/](docs/roadmap/README.md). They record proposals and phased execution contracts; they do not replace `AGENTS.md` or `docs/development/`.

## 0. Synchronization Policy

`CLAUDE.md` imports this file, so every agent tool follows the same instructions. The guides under `docs/development/` are the single source of detailed rules; this file routes to them and restates only what is most often violated.

- When a shared rule changes, update its guide in the same change, and update this file only if it restates that rule.
- Do not copy guide sections into this file; link to them.
- Keep `docs/development/` truthful: mark forward-looking conventions **Recommended** unless already enforced by code, tooling, or CI.

## 1. Think Before Coding

- State your assumptions explicitly before implementing. If multiple interpretations exist or a requirement is ambiguous, surface the tradeoffs or ask instead of guessing silently.
- For small, obvious changes a single sentence is enough; for architecture, schema, workflow, or cross-module work, be explicit.

## 2. Simplicity First

- Write the minimum code that solves the problem. No speculative features, abstractions for single-use code, or error handling for impossible scenarios.
- Do not weaken architectural or security boundaries merely to save lines.

## 3. Surgical Changes

- Every changed line must trace directly to the request. Match surrounding formatting and style; new code still follows the language guides ([TypeScript](docs/development/typescript.md), [Rust](docs/development/rust.md)), even where older adjacent code does not.
- Do not refactor or reformat unrelated code; mention unrelated issues instead of fixing them. Remove only imports, variables, and dead code orphaned by your own change.

## 4. Goal-Driven Execution

- Turn every task into verifiable criteria before editing (a test that reproduces a bug and then passes, a build across deploy targets, `cargo test --locked`, or link checks).
- Run the checks from [Testing and verification](docs/development/testing.md) that fit the changed area, and state plainly what you did not or could not verify.

## 5. Architecture & Security Invariants

Non-negotiable rules restated because violations carry high risk:

- **Admin vs. Agent boundary:** Admin operations are TanStack server functions in `app/src/query/` calling `ensureAdmin()`. A structural test (`app/src/lib/admin-audit.test.ts`) requires every `POST` server function in `app/src/query/` to carry `adminAudit(...)` or be explicitly exempted as user-facing. The oRPC router exposes only per-server `agent.*` procedures (`Authorization: Bearer` matched against hashed `server.agentTokenHash`). See [API, data and auth](docs/development/api-data-auth.md).
- **Publish gate:** Mutations that change state an agent must apply before subscriptions may safely advertise it (node create/update/enable/delete, credential rotation, entitlement changes, server enable/disable) must record a `config_change` via `recordConfigChange`. Certificate rotations, address/name edits, and routing-rule edits must not. See [Architecture](docs/development/architecture.md#publish-gate).
- **Agent & certificate trust:** `server-agent/` never trusts inline certificate material or control-plane paths from base sing-box configs and always strips `experimental.v2ray_api` / pre-existing `api` services before injecting its own loopback stats service. See [Server agent](docs/development/server-agent.md#safety-invariants).
- **Secrets out of outputs and repos:** Never print, log, paste into docs/tests/commit messages, or commit `app/.env.local` (`*.local`), agent tokens, subscription tokens, OAuth/API secrets, or certificate private keys. Keep runtime-only credentials (such as ephemeral SSH session inputs) out of persistent DB columns and audit payloads.
- **Database transactions:** Only `node-postgres` supports interactive transactions (`supportsInteractiveTransactions`). Code needing atomicity on `neon-http` must branch or use single-statement CTEs. See [Architecture](docs/development/architecture.md#runtimes-and-deploy-targets).

## 6. Generated Files, Workspaces & i18n

- Run `pnpm` commands from the repo root (app-only: `pnpm --filter @blossom/app <script>`). Run `cargo` commands inside `server-agent/`.
- Never hand-edit generated files (`app/src/route-tree.gen.ts`, `app/src/paraglide/`, `app/drizzle/*/snapshot.json`, `server-agent/openapi/spec*.json`, lockfiles). Regenerate them as documented in [Generated files](docs/development/generated-files.md). After changing the agent-facing OpenAPI surface, regenerate `server-agent/openapi/spec*.json` and rebuild/test `server-agent/`.
- All user-visible UI strings go through Paraglide (`m.some_key()`), with keys added in matching logical order to both `app/messages/en.json` and `app/messages/zh-cn.json`.

## 7. Code Style & Conventions

Follow [TypeScript and React style](docs/development/typescript.md), [App conventions](docs/development/app.md), [UI design standard](docs/development/ui-design.md) for admin UI work, and [Rust code guide](docs/development/rust.md). Apply these rules during planning as well as review: new code follows the guides even when adjacent legacy code predates them. Passing `oxfmt`/`oxlint` or `rustfmt`/`clippy` alone is not sufficient; logical grouping, narrow visibility, explicit error handling, and UI consistency are mandatory review checks.

## 8. Worktrees

Follow [Worktrees and resource reuse](docs/development/workflow.md#worktrees-and-resource-reuse).

- Place isolated worktrees as siblings of the main checkout named `../blossom-<branch-suffix>` (or a user-selected directory), using typed branches (`feat/`, `fix/`, `docs/`, `refactor/`, `chore/`).
- Check the host filesystem before seeding `server-agent/target/` (on Linux Btrfs, independent `cp -a --reflink=always` CoW clones may be used when the source target is idle; never share a writable `target/`, `CARGO_TARGET_DIR`, `node_modules/`, database, or dev port across checkouts).
- Pre-existing worktrees (e.g., `t3/*`) belong to separate threads; do not modify or remove them unless instructed.

## 9. Git Commits & Side-Effecting Commands

Follow [Workflow](docs/development/workflow.md).

- Commands such as `db:migrate`, `db:push`, `pnpm dev`, and `cargo run` act on `DATABASE_URL` or start long-running processes; verify you target a disposable local database and temporary `--state-dir` before running them.
- Stage explicit paths (`git add path/to/file`), never `git add .` or `-A`.
- Keep commits atomic and buildable; fold corrections into unpushed commits rather than creating fix-up commits. Keep subjects imperative, under 72 characters, without a trailing period.

## 10. Final Review

Before finishing any task: the diff contains only requested changes; generated files are current or untouched; relevant checks ran (or omissions are explicitly reported); and no secrets, `.env.local` files, or build outputs are staged.
