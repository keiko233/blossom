# Multi-platform deployment and workspace migration

## Goal

Make the control plane easier to deploy on Cloudflare Workers, Vercel, Netlify and self-hosted Node/Docker, and separate portable domain code from application and runtime integration. Preserve the existing app, HTTP contracts, database schema and security behavior. The Rust server-agent remains an independent deployable.

## Boundaries

- `app/` remains the TanStack Start composition root: routes, UI, server-function wrappers, authentication, MCP and platform configuration.
- Private pnpm workspace packages under `packages/` own explicit, cohesive boundaries. Start with portable domain logic and browser-safe contracts; extract database and server services where their actual dependencies permit it. Avoid placeholder packages and cycles.
- A domain or contract package must not depend on app aliases, server secrets, Drizzle connection initialization or platform modules. Separate browser-safe exports from server-only exports; do not rely on tree shaking as a security boundary.
- Keep server functions in the app until cross-package Start compilation and import protection are proven. Their authorization, audit and publish-gate behavior must remain unchanged.
- Database schema and connection handling must retain both Neon HTTP and node-postgres semantics, including compensating behavior where interactive transactions are unavailable. Workers Hyperdrive remains available when configured. Do not modify applied migrations or apply migrations to a real database.
- Agent endpoints, authentication and generated OpenAPI remain compatible with existing agents. Do not hand-edit generated artifacts.

## Deployment design

Evaluate Nitro as the shared Vite integration for all targets, using its Cloudflare Workers, Vercel, Netlify and node-server presets. Prefer provider detection on hosted builds, with explicit preset overrides for reproducible builds and Docker. Confirm output and deployment commands for the installed Nitro version. Retain an existing platform integration if the unified path cannot meet its requirements; document concrete evidence rather than claim compatibility from a build alone.

Preserve runtime environment validation, client build-time variables, the certificate metadata ordering workaround, Workers compatibility flags, static assets, and optional Hyperdrive bindings. Never deploy or alter remote services as part of this work.

## Stages and commits

Each stage is independently reviewed and committed using explicit paths. Preserve unrelated work; do not push.

1. **Spec and baseline:** document this plan; record baseline tests and available tooling without exposing secrets.
2. **Deployment integration:** unify on Nitro where feasible, retain explicit platform builds and local development; update deployment documentation and verify each build target and runtime smoke tests where available.
3. **Workspace boundaries:** configure pnpm workspace packages and extract a meaningful set of pure domain logic and browser-safe contracts with their tests. Declare direct dependencies, public exports and test coverage. Add server/client boundary checks where needed.
4. **Data and services:** extract database and/or cohesive server-side services where dependency direction is demonstrably sound; keep framework-specific entry points in the app. Maintain transactions, publish gate, audit and API contract. Do not create empty abstraction layers merely to reach a target package count.
5. **Integration and verification:** update Docker dependency/source copying, CI and image path filters, platform monorepo settings, tests, and development guides as required by actual changes. Build all targets, test workspace packages and app, check types, and build/smoke Docker when available. Run agent checks if the agent contract changes. Verify generated artifacts are unchanged or correctly regenerated.

Stages may be combined only when necessary for a working intermediate commit. A failed experiment must not leave a broken target: retain its previous working integration and document the limitation.

## Acceptance

- Each supported target has a reproducible build and clear deploy instructions; report separately local builds, local runtime smoke tests and real platform deployments.
- The workspace graph is acyclic, each new package has explicit dependencies and public entry points, and packages are included in test/build and image rebuild triggers.
- Authentication, admin POST auditing, secret redaction, agent endpoints, transaction-dependent paths and publish gate semantics remain intact.
- No production deploy, remote database operation, push or unrelated work is included. Report any unavailable verification and unresolved compatibility limitations.

## Stage 2 outcome (deployment integration)

Evaluated against Nitro `3.0.260903-beta`:

| Target | Integration | Result |
| --- | --- | --- |
| Node / Docker | Nitro `node-server` (unchanged) | Builds; local server smoke passes. |
| Vercel | Nitro `vercel` (unchanged) | Builds; handler smoke passes. Not deployed. |
| Netlify | Nitro `netlify` (replaces `@netlify/vite-plugin-tanstack-start`, removed) | Builds; dev and handler smoke pass. Built from the repository root; publish directory is `dist` and the function is in `.netlify/functions-internal`, both at the root. Not deployed. |
| Cloudflare Workers | `@cloudflare/vite-plugin` retained | Nitro `cloudflare_module` blocked: needs changed compat flags to start in workerd and its dev runner cannot run the app. Evidence in [Architecture](architecture.md#runtimes-and-deploy-targets). |

The presets are pinned in `app/vite.config.ts` and the `build:<target>` scripts instead of relying on host auto-detection. PR 6 removed the certificate `reflect-metadata` ordering plugin along with `acme-client`/`@peculiar/x509`; the `@/lib/database-connection` alias (Cloudflare-only `cloudflare:workers` import) and client/server env validation remain. No real-platform deployment was performed.

## Workspace outcome

Private `domain` and `contracts` packages expose portable rules and browser-safe schemas. The `database` package owns driver resolution and request-scoped database management, with a separate server entry. Table schemas, application-specific server functions, auth integration and agent API remain in the app because they are closely coupled. Docker copies workspace packages, and image change detection includes them. Local Workers with a Hyperdrive binding and a disposable PostgreSQL passed sequential and concurrent queries plus sign-up; Docker build and runtime queries also passed. Remote Hyperdrive and hosted deployments have not been tested.

## Audit outcome

A follow-up audit re-checked the stages above against the code.

- **Builds.** All four targets build from a clean tree (`cloudflare`, `node`, `vercel`, `netlify`), one after another. The Netlify and Vercel handlers and the Docker image answer `/api/health`, `/` and `/api/spec.json`; the Docker image also completes an email sign-up, and the Workers build (local `wrangler dev` with a Hyperdrive binding that points at a disposable PostgreSQL, while `DATABASE_URL` is deliberately unreachable) completes eight concurrent sign-ups. The Vercel function runtime chosen by the Nitro preset is `nodejs24.x`. Nothing was deployed to a host.
- **Database scoping.** `@blossom/database/server` is denied in the client environment by TanStack import protection; a probe route importing it failed the build with "Import denied in client environment". The database facade and `getAuth()` key their instances by the request object on Workers and are shared on Node.
- **Migrations.** All 23 migrations apply to a fresh disposable database, and `drizzle-kit generate` and `drizzle-kit check` report no schema changes, so the upgraded snapshots are consistent with the schema. The Compose `migrate` path was verified separately: the root `Dockerfile` up to and including the `builder` stage, plus `WORKDIR /repo/app` and `RUN pnpm db:migrate` (the Compose `working_dir` and `command`), was built with a cache-only build (`docker buildx build --output type=cacheonly`, no image export) against a second fresh disposable database, and applied all 23 migrations (36 public tables). This repeats, as independent evidence, a cache-only builder-stage migration test that was reported as successful in the preceding session; a separate attempt in this session that exported the whole `builder` stage as an image ran out of disk and proved nothing.
- **Rebuild triggers.** The original `netlify.toml` used `base = "app"`, which both watches only `app/` and makes Netlify look for `pnpm-lock.yaml` in `app/` (see below). Netlify is now configured from the repository root with no `base`, so every change in the repository triggers a build and no `ignore` command is needed (which also avoids skipping first or uncached builds, where `CACHED_COMMIT_REF` can equal `COMMIT_REF`). Vercel's built-in skipping follows the workspace dependencies the app declares. The Docker image filter already covered `packages/**`. CI now builds every target, and lint-staged covers `packages/`.
- **Netlify layout.** Netlify's documentation says dependencies install and `.netlify/functions-internal` is discovered relative to the base directory, a root `netlify.toml` `base` overrides the UI, and the package manager comes from the lockfile in the base directory. With `base = "app"` the root lockfile is not seen. Nitro's Netlify preset (`nitro@3.0.260903-beta`, `dist/_presets.mjs`) writes `{{ rootDir }}/.netlify/functions-internal` and `{{ rootDir }}/dist`, with `rootDir` being `app/`, so a root-based build needs the output at the root: `NITRO_OUTPUT` in `app/vite.config.ts` sets `output.dir` and `output.publicDir` for the Netlify target only (a package directory can only be set in the Netlify UI, and moving files after the build would add a second place that has to stay in step). Local checks: `netlify build --offline --filter @blossom/app` (netlify-cli, installed in a temporary directory outside the repository, no credentials) ran the configured command and resolved `publish` to `<repo>/dist`; `@netlify/zip-it-and-ship-it` listed and zipped the `server` function from `.netlify/functions-internal` (route `/*`, `prefer_static`, bundler `none`); the built handler answered `/api/health`, `/` and `/api/spec.json` with 200. The CLI refuses a monorepo without `--filter`, so the exact hosted case (no package directory) could not be run through it, and `netlify build` does not package functions, which is why the packager was run directly. A hosted Netlify build has not been run.
- **Workers database pool.** The installed Drizzle node-postgres driver builds `new pg.Pool({connectionString})`; `pg-pool` defaults are `max` 10 and `idleTimeoutMillis` 10000. In local workerd with a Hyperdrive binding, 12 concurrent queries in one request used 10 connections, the remaining 2 queued, all succeeded, and no connections remained after the response. Cloudflare's Workers limits apply a limit of six to connections in the initial establishment (waiting-for-headers) phase per invocation, with further attempts queued; this is not a limit on all open connections, the documentation does not describe its effect on `pg` sockets, and local workerd was not shown to enforce it. Cloudflare's Hyperdrive Postgres example uses `max: 5` only in its postgres.js snippet, not as a `pg` pool requirement. The pool cap is therefore left unchanged; closing the pool at the end of the handler was rejected because streamed SSR may query after the handler returns. Production behaviour with the default pool size is unverified; `max: 5` for the Hyperdrive path is a change to consider if queuing or errors are observed on a real deployment.
- **Compatibility patches.** Removed `app/src/polyfill.ts`, a Node 18/StackBlitz `File` polyfill for an oRPC schema the app does not use; every target provides `File` (Node 26, Vercel's Node 24 function runtime, Workers). PR 6 also removed the `reflect-metadata` ordering plugin and its `@peculiar/x509`/`acme-client` consumers. Kept: the `@/lib/database-connection` alias and the Cloudflare plugin (see above).
- **Limits.** Not verified on a real host: any Netlify build or function invocation (including which Node version the hosted function runs: Netlify falls back to Node 24 for unsupported build versions, so `NODE_VERSION = "26"` applies to the build and the function runtime needs preview verification), Vercel, and remote Hyperdrive behaviour. Package tests still live in `app/src` and run in the app's Vitest suite; packages have no scripts or tsconfig of their own, and are type-checked through the app.
