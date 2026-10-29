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
| Netlify | Nitro `netlify` (replaces `@netlify/vite-plugin-tanstack-start`, removed) | Builds; dev and handler smoke pass. Publish directory is now `dist`. Not deployed. |
| Cloudflare Workers | `@cloudflare/vite-plugin` retained | Nitro `cloudflare_module` blocked: needs changed compat flags to start in workerd and its dev runner cannot run the app. Evidence in [Architecture](architecture.md#runtimes-and-deploy-targets). |

The presets are pinned in `app/vite.config.ts` and the `build:<target>` scripts instead of relying on host auto-detection. The certificate `reflect-metadata` ordering plugin, the `@/lib/database-connection` alias (Cloudflare-only `cloudflare:workers` import) and client/server env validation are still required and kept. No real-platform deployment was performed.
