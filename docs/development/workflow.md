# Development workflow

Statements are **Established** unless marked **Recommended**.

## Prerequisites and setup

- Node.js 26 or newer and pnpm 12.16.1 (`engines` and `packageManager` in the root `package.json`). Docker images and CI use Node 26.
- Rust (stable; CI uses `dtolnay/rust-toolchain@stable`) for `server-agent/`. The agent crate uses edition 2024.
- PostgreSQL for running the app. Docker Compose at the repo root can provide it along with migrations; see the [README](../../README.md#self-hosting-quickstart).
- `pnpm install` from the repo root installs the workspace and, through the `prepare` script, the Husky git hooks.
- Copy `app/.env.example` to `app/.env.local` and fill it in. See [Environment](api-data-auth.md#environment). It is git-ignored (`*.local`); keep it out of commits and its values out of logs and documentation.

## Everyday commands

From the repo root:

| Task                          | Command                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| Install                       | `pnpm install`                                                 |
| Dev server (port 3000)        | `pnpm dev`                                                     |
| Build                         | `pnpm build`                                                   |
| Tests                         | `pnpm test`                                                    |
| Format / lint                 | `pnpm fmt` / `pnpm lint`                                       |
| App-only script               | `pnpm --filter @blossom/app <script>`                          |
| Build for a deploy target     | `pnpm --filter @blossom/app build:node`                        |
| Generate a migration          | `pnpm --filter @blossom/app db:generate`                       |
| Apply migrations              | `pnpm --filter @blossom/app db:migrate`                        |
| Regenerate the agent spec     | `pnpm --filter @blossom/app agent:spec` (dev server running)   |
| Preview email templates       | `pnpm --filter @blossom/app email:dev`                         |
| Agent checks                  | `cd server-agent && cargo test --locked`                       |

Currently, the deploy-target build scripts are `build:cloudflare`, `build:netlify`, `build:vercel`, and `build:node`; plain `pnpm build` uses the default `cloudflare` target (`@cloudflare/vite-plugin`), while the other three are built by Nitro with pinned presets. (See [the architecture redesign spec](../spec/2026-11-18-agent-ws-release-ops-redesign/investigation-report.md) for the planned removal of `netlify` in PR 1.) `db:migrate` acts on the database `DATABASE_URL` points at, and `agent:spec` needs the dev server running; see [API, data and auth](api-data-auth.md#migrations) and [Generated files](generated-files.md#agent-openapi-spec-and-client).

The root `dev`, `build`, and `test` scripts use `pnpm --parallel` over the workspace. The app consumes `packages/{domain,contracts,database}` as TypeScript source and runs their tests in its Vitest suite; they do not need a separate build. The agent is built and tested with `cargo` separately. Which checks to run for a change is in [Testing and verification](testing.md).

## Scope and verification

- State assumptions and ambiguities before implementing; ask when a wrong guess would be expensive, otherwise proceed and explain what you assumed.
- Plan and implement to the language guides ([TypeScript and React](typescript.md), [App conventions](app.md), and [Rust](rust.md)): new code follows the guides even where nearby legacy code predates them.
- Keep changes focused on the request and match surrounding code. Do not reformat or refactor adjacent code; the formatter runs on staged files at commit time.
- Define an observable success criterion before editing. Reproduce bugs with a test first; verify behavior before and after refactors.
- **Recommended:** Do not merge pull requests or advance `main` while CI is red; fix a red `main` before landing further work.

## Git hooks

Husky runs two hooks (`.husky/`):

- `pre-commit` → `pnpm lint-staged` (`lint-staged.config.js`):
  - `{app,packages}/**/*.{js,jsx,ts,tsx,json,css,md}` → `oxfmt`
  - `{app,packages}/**/*.{js,jsx,ts,tsx}` → `oxlint --fix --deny-warnings`
  - `server-agent/**/*.rs` → `cargo fmt --all` and `cargo clippy --all-targets --all-features --fix --allow-dirty --allow-staged -- -D warnings` (whole crate, not per file)
- `commit-msg` → `commitlint` with `@commitlint/config-conventional`.

Markdown outside `app/` and `packages/` (including these guides) is not formatted by the hook. Fix hook failures rather than bypassing them with `--no-verify`. `HUSKY=0` makes Husky a no-op for environments without `.git`, such as Docker builds.

## Commits

Conventional Commits are enforced by `commitlint`. Existing history uses `type(scope): subject`, for example `fix(auth): migrate oauth schema for better-auth 1.7`, `feat(server-agent): prefer IPv6 for bootstrap GitHub requests`, `chore(deps): update rust crate clap to v4.6.8`. Common types are `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `build`, `ci`.

- Whether to commit or push is up to the task instructions.
- Stage explicit paths (`git add path/to/file`) rather than `git add .`, `-A`, `--all`, or `*`, so `.env.local`, build outputs, or unrelated changes cannot slip in. Review `git status` and `git diff --cached --stat` before committing.
- **Recommended (atomic commits & no fix-ups):** One commit should do one thing, be complete, and build on its own. Keep schema changes, their generated migration folder, OpenAPI spec updates, and dependent code in the atomic unit that needs them. Do not make patch-style fix-up commits on a development branch; if an unpushed commit is incomplete or flawed, fold the fix with `git reset --soft HEAD~1` and recommit. Rewriting pushed history requires explicit consent.
- **Recommended (message content):** Keep the imperative subject within 72 characters without a trailing period. Explain *why* (root cause, tradeoffs, non-obvious constraints) in the body; do not enumerate diffs file-by-file or state "tests passed".

## Worktrees and resource reuse

For multi-PR feature or refactoring work, run changes in isolated git worktrees by default rather than mixing concurrent work in the main checkout.

- **Naming & placement:** Use typed branch names (`feat/<name>`, `fix/<name>`, `docs/<name>`, `refactor/<name>`, `chore/<name>`). Place worktrees outside the main repository as siblings named `../blossom-<branch-suffix>` (or a developer-specified path), e.g., branch `feat/agent-ws-client` in `/home/keiko/Code/blossom` uses `/home/keiko/Code/blossom-agent-ws-client`. Preserve pre-existing worktrees belonging to other threads (e.g., `t3/*`) untouched.
- **Independent dependencies & outputs:** Each worktree runs its own `pnpm install --frozen-lockfile --prefer-offline` (reusing the global pnpm store safely while keeping `node_modules/` isolated), owns its own generated `app/src/paraglide/` and `app/src/route-tree.gen.ts`, and uses its own disposable PostgreSQL database, `--state-dir`, and dev server ports.
- **Exclusive `agent:spec` port:** `pnpm --filter @blossom/app agent:spec` currently reads `http://localhost:3000/api/spec.json`. Coordinate port `3000` so a worker regenerating `server-agent/openapi/spec*.json` connects only to its own worktree's dev server, and run non-spec dev servers on distinct ports (`--port 3001`, etc.).
- **Cargo `server-agent/target/` reuse policy:** Never share a writable `server-agent/target/` directory across worktrees via symlinks, hardlinks, junctions, or a shared `CARGO_TARGET_DIR`. Inspect the host filesystem (`df -T`) before seeding a new worktree's absent `server-agent/target/`:
  - **Linux Btrfs / XFS (with reflinks enabled):** When the source target is on the same volume and no `cargo`, `rustc`, or `rust-analyzer` process is writing to it, you may seed an independent CoW clone via `cp -a --reflink=always <source>/server-agent/target server-agent/target` (never use a full-copy fallback as default; verify block sharing or omit seeding if unsupported). Validate with `cargo check` / `cargo test --locked` inside the new worktree.
  - **Linux ext4 / unsupported / cross-volume:** Skip seeding and let Cargo build an independent `server-agent/target/` inside the worktree.

## CI and GitHub workflows

Currently three workflows exist in `.github/workflows/`:

| Workflow                    | Trigger                             | What it does                                                                                                                                                                     |
| --------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test.yml` (`CI`)           | pull requests, manual               | Job `app` (`App tests and build`): `pnpm install --frozen-lockfile`, `pnpm test` (with Postgres service), then `pnpm build` (Cloudflare), `build:node`, `build:vercel`, `build:netlify`. Job `server-agent` (`Server agent tests`): `cargo test --locked`, `cargo fmt --check`, `cargo clippy -D warnings`, Docker builds, managed-TLS lifecycle test. |
| `docker.yml` (`Docker`)     | push to `main`, `v*` tags, manual   | Filters changed paths and builds/publishes multi-arch GHCR manifests (`ghcr.io/<repo>` and `ghcr.io/<repo>/server-agent`). *(Target redesign moves publishing to release tags via `publish.yml`.)* |
| `server-agent-release.yml`  | `server-agent-v*` tags, manual      | Checks `Cargo.toml`/`Cargo.lock` tag agreement, runs Rust tests/fmt/clippy, builds static amd64/arm64 musl binaries, publishes GitHub Release with `make_latest: false`.         |

### Workflow conventions

- **Established (branch protection):** `main` branch protection enforces `enforce_admins: true` and strict required status checks referencing the exact job display names **`App tests and build`** and **`Server agent tests`** in `.github/workflows/test.yml`. Keep those job display names stable whenever editing CI.
- **Recommended (display naming):** Name workflows using **`[Category] Action Object`** with categories `CI`, `Release`, `Maintenance`, and `Reusable` (e.g. `[CI] App and Agent Tests`, `[Release] Prepare Version and Release`, `[Release] Build and Publish Images`, `[Release] Build and Publish Server Agent`). Separate adjacent steps in workflow YAML with one blank line.
- **Recommended (action integrity):** When adding or updating release/publish workflows, prefer full commit-SHA pinning (or an action lockfile such as `.github/workflows/actions.lock` verified in CI) rather than floating major tags.

## Deployment and external effects

Deployment is outside the normal development loop, and these operations have effects beyond your checkout: `wrangler deploy` publishes a Worker, `wrangler secret put` writes a live secret, pushing to `main` (currently) or release tags triggers GHCR/release publishing, and `db:migrate` mutates `DATABASE_URL`. Authorization to run them comes from explicit task instructions; for verification, prefer local builds, disposable databases, and isolated Docker containers. Keep real secrets out of repository files. Target-specific configuration lives in `app/wrangler.jsonc`, `netlify.toml` (planned for removal in PR 1), `app/vercel.json`, `railway.toml`, `Dockerfile`, and `docker-compose.yaml`. Deployment instructions are in the [README](../../README.md#deployment).

## Documentation

- User-facing setup and deployment belong in the README and [docs/operations/](../operations/README.md); engineering rules belong in `docs/development/`; architectural investigations and multi-PR plans belong in `docs/spec/` and `docs/roadmap/`. Do not duplicate: link.
- When established behavior documented here changes, update the affected guide in the same change (see [Maintaining these guides](README.md#maintaining-these-guides)).
