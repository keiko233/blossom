# Development workflow

Statements are **Established** unless marked **Recommended**.

## Prerequisites and setup

- Node.js 26 or newer and pnpm 12.16.1 (`engines` and `packageManager` in the root `package.json`). The Docker images and CI use Node 26.
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

The deploy-target build scripts are `build:cloudflare`, `build:netlify`, `build:vercel` and `build:node` (the example above uses the last); plain `pnpm build` uses the default `cloudflare` target (`@cloudflare/vite-plugin`); the other three targets are built by Nitro with a pinned preset. `db:migrate` acts on the database `DATABASE_URL` points at, and `agent:spec` needs the dev server running; see [API, data and auth](api-data-auth.md#migrations) and [Generated files](generated-files.md#agent-openapi-spec-and-client).

The root `dev`, `build` and `test` scripts use `pnpm --parallel` over the workspace. The app consumes the private domain, contracts and database packages as TypeScript source and runs their tests in its Vitest suite; they do not need a separate build. The agent is built and tested with `cargo` separately. Which checks to run for a change is in [Testing and verification](testing.md).

## Scope and verification

- State assumptions and ambiguities before implementing; ask when a wrong guess would be expensive, otherwise proceed and say what you assumed.
- Keep changes focused on the request and match surrounding code. Do not reformat or refactor adjacent code; the formatter runs on staged files at commit time, which is enough.
- Define a checkable outcome before editing. For a bug, reproduce it first; for a refactor, check behaviour before and after.
- **Recommended**: do not merge or push to `main` while CI is red, and fix a red `main` before landing more on it.

## Git hooks

Husky runs two hooks (`.husky/`):

- `pre-commit` → `pnpm lint-staged` (`lint-staged.config.js`):
  - `{app,packages}/**/*.{js,jsx,ts,tsx,json,css,md}` → `oxfmt`
  - `{app,packages}/**/*.{js,jsx,ts,tsx}` → `oxlint --fix --deny-warnings`
  - `server-agent/**/*.rs` → `cargo fmt --all` and `cargo clippy --all-targets --all-features --fix --allow-dirty --allow-staged -- -D warnings` (whole crate, not per file)
- `commit-msg` → `commitlint` with `@commitlint/config-conventional`.

Markdown outside `app/` (including these guides) is not formatted by the hook. If a hook fails, fixing the cause is usually better than bypassing it with `--no-verify`, which skips the formatting and commit-message checks the project relies on. `HUSKY=0` makes Husky a no-op for environments without `.git`, such as the Docker build.

## Commits

Conventional Commits are enforced by `commitlint`. Existing history uses `type(scope): subject`, for example `fix(auth): migrate oauth schema for better-auth 1.7`, `feat(web): add admin console pages and user onboarding`, `feat(server): add admin management data model and server functions`, `chore(deps): upgrade project dependencies and node to 26`. Common types are `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `build`, `ci`.

- Whether to commit or push is up to the task instructions.
- One commit should do one thing. Keep a schema change, its generated migration folder and the code that needs them together; keep unrelated dependency or lockfile churn out.
- **Recommended**: stage explicit paths (`git add path/to/file`) rather than `git add .` or `-A`, so local files such as `.env.local` and build output cannot slip in.
- **Recommended**: write the subject in the imperative, keep it under about 72 characters, and explain *why* in the body for anything non-obvious.
- Rewriting history that has already been pushed affects everyone who pulled it; do it only when the task calls for it.

## CI

Two workflows in `.github/workflows/`:

| Workflow            | Trigger                                  | What it does                                                                                                                                              |
| ------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test.yml` (`CI`)   | pull requests, manual                    | Job `app`: `pnpm install --frozen-lockfile`, `pnpm test`, then one build per deploy target (`pnpm build` for Cloudflare, `build:node`, `build:vercel`, `build:netlify`). Job `server-agent`: `cargo test --locked`, `cargo fmt --check`, `cargo clippy -D warnings`, image build, managed-TLS lifecycle test. |
| `docker.yml`        | push to `main`, `v*` tags, manual        | Builds only the images whose sources changed (tags and manual runs build both), natively per architecture (amd64, arm64), and publishes multi-arch manifests to GHCR. |

Keep job names stable if you edit workflows: branch protection and badges may refer to them. Both test jobs run on each pull request. Changing `docker.yml` can publish images on the next push to `main` (it includes itself in its change filters, so both images rebuild), so edits there are release-affecting.

## Deployment and external effects

Deployment is outside the normal development loop, and these operations have effects beyond your checkout: `wrangler deploy` publishes a Worker, `wrangler secret put` writes a live secret, pushing to `main` or a `v*` tag triggers `docker.yml` and publishes images to GHCR, and `db:migrate` changes the database `DATABASE_URL` points at. Authorization to do any of them comes from the task instructions; for verification, prefer local builds (`pnpm build`), a disposable database and local Docker. Keep real secrets out of files in the repo. Target-specific configuration: `app/wrangler.jsonc` (Cloudflare; the `HYPERDRIVE` binding is not declared in the file), `netlify.toml` (publish `dist`), `app/vercel.json`, `railway.toml`, `Dockerfile`, `docker-compose.yaml`. Deployment instructions are in the [README](../../README.md#deployment).

## Documentation

- User-facing setup and deployment belong in the README; engineering conventions belong in these guides. Do not duplicate: link.
- When behaviour documented here changes, update the guide in the same change (see [Maintaining these guides](README.md#maintaining-these-guides)).
