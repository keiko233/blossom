# Architecture

Blossom has two deployables that meet at one HTTP contract.

```text
 browser ──SSR/server fns──┐
 MCP clients ──/api/mcp────┤                      ┌───────────────┐
 proxy clients ─/api/sub/…─┼──▶  app/ (TanStack   │  PostgreSQL   │
 server-agent ─/api/agent/*┘     Start, oRPC,  ──▶│  (Drizzle)    │
        ▲                        better-auth)    └───────────────┘
        │  desired state (sing-box config, TLS bindings, certificates)
        └─ heartbeats, applied revision, traffic deltas
```

- **`app/`** (`@blossom/app`) is the control plane: admin console, user dashboard, authentication, subscription output, the agent API and the MCP API.
- **`packages/domain/`** and **`packages/contracts/`** contain portable domain rules and browser-safe validation contracts. They expose explicit TypeScript source entry points consumed by the app's bundler; their tests run in the app's Vitest suite.
- **`server-agent/`** is a standalone Rust crate (not part of the pnpm workspace). One agent runs per physical proxy server, owns one sing-box process, and reconciles it to the desired state the app serves. See [Server agent](server-agent.md).

The data model is server → nodes: a `server` has one agent token and one sing-box process; every enabled `node` on it becomes an inbound in the same generated config. Plans, groups, subscriptions, rules, certificates, redeem codes, announcements, settings and audit logs hang off that in `app/src/db/*-schema.ts`.

## Request surfaces

Established. Know which surface you are on, because they authenticate differently.

| Surface                       | Where                                                                  | Authentication                                       | Notes                                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| SSR pages and routes          | `app/src/routes/`                                                      | better-auth session; role checked in `beforeLoad`   | `(admin)` requires `role === "admin"`, `(user)` and `(auth)` have their own groups.                                                    |
| Server functions              | `app/src/query/*.ts`, `app/src/lib/auth.tsx`                           | session; admin ones call `ensureAdmin()`             | The application API for the UI. All admin CRUD lives here.                                                                             |
| Agent API (oRPC)              | `app/src/orpc/router/index.ts`, `app/src/orpc/proxy/agent.ts`          | per-server `Authorization: Bearer` token             | The only procedures in the oRPC router: `agent.getConfigV3`, `agent.heartbeat`, `agent.reportTraffic`.                                 |
| oRPC mounts                   | `app/src/routes/api/$.ts` (OpenAPI), `app/src/routes/api/rpc/$.ts` (RPC) | same as above                                      | `/api/*` serves the OpenAPI document (`/api/spec.json`, consumed by the agent codegen); `/api/rpc/*` is the oRPC RPC protocol.         |
| better-auth                   | `app/src/routes/api/auth/$.ts`                                         | its own                                              | Email/password, magic link, GitHub/Google (when configured), admin and JWT plugins, OAuth provider for MCP.                            |
| MCP                           | `app/src/routes/api/mcp.ts`, `app/src/orpc/mcp/`                       | OAuth 2.0 bearer; admin actor; `blossom:mcp:*` scopes | Tools call an in-process oRPC router (`mcpRouter`); write tools need `confirm: true` and are audited.                                  |
| Subscription output           | `app/src/routes/api/sub/$token.ts`                                     | the subscription token in the URL                    | Renders a Clash config from the nodes the subscription may use, gated by the publish gate below. Writes an access log.                 |
| Misc                          | `api/health.ts`, `api/admin/certificates/…/export/$part.ts`, `.well-known` routes | health: none; others per route              | `/api/health` is the container health check.                                                                                           |

An isomorphic oRPC client and TanStack Query utilities exist in `app/src/orpc/client.ts`; the pages inspected call server functions directly instead.

## Runtimes and deploy targets

Established. `app/vite.config.ts` selects the target from `DEPLOY_TARGET` (`cloudflare` default, `netlify`, `vercel`, `node`). The same source must build and run on all of them, so avoid APIs that exist on only one runtime.

- **Nitro** builds `netlify`, `vercel` and `node` (presets `netlify`, `vercel`, `node-server`, pinned in `NITRO_PRESETS`). Hosts also auto-detect Nitro, but the `build:<target>` scripts, `netlify.toml`, `app/vercel.json` and the Dockerfile pin the preset so builds are reproducible. Outputs: Node `.output/` (Docker); Vercel `.vercel/output/`; Netlify `dist/` (publish) plus `.netlify/functions-internal/server/`.
- **Cloudflare** keeps `@cloudflare/vite-plugin` (it must come before `tanstackStart`). Evidence from Nitro `3.0.260903-beta` (`cloudflare_module`), tried with the same app:
  - Build needs three workarounds (`cloudflare:*` externalised for the SSR environment, no trailing commas in `wrangler.jsonc`, `main` in `wrangler.jsonc` overridden), then succeeds.
  - The built Worker crashes at startup in local workerd (`wrangler dev --local`): `process.stderr` is undefined in `acme-client`'s `debug`. Adding `enable_nodejs_process_v2` moves the failure to `No such module "node:fs"`; adding `enable_nodejs_fs_module` as well makes local requests pass (`/api/health`, `/`, `/api/spec.json`). That changes the production compatibility flags (currently `nodejs_compat` only), which cannot be verified without a deployment.
  - Nitro's dev runner for Cloudflare (miniflare) requires `miniflare@^4`, but Wrangler 4.154 resolves `5.x` beta, giving `ERR_VALIDATION`. With `miniflare@^4` added, SSR modules fail in workerd (`module is not defined`, `Class extends value [object Module]`), so the local Hyperdrive development path would regress.
  - The plugin-built Worker passes the same local workerd requests unchanged, so the plugin stays until Nitro's Cloudflare dev runner works with this app. Re-evaluate when Nitro or Wrangler updates.
- **Database driver** is resolved in `app/src/db/config.ts`: a Hyperdrive connection string (Cloudflare) forces `node-postgres`; otherwise `DATABASE_DRIVER` or auto-detection (`*.neon.tech` → `neon-http`, else `node-postgres`).
- **Transactions**: only `node-postgres` supports interactive transactions (`supportsInteractiveTransactions` in `app/src/lib/env-schema.ts`). Code that needs atomicity branches on it; on `neon-http` it runs ordered statements and compensates on failure (see `app/src/query/nodes.ts`). Do not assume `db.transaction` works everywhere.
- **`@/lib/database-connection`** is aliased in `vite.config.ts` to the Cloudflare variant only on the Cloudflare target.
- **Environment** is validated lazily at runtime on the server (`getServerEnv()` in `app/src/lib/env.ts`), and client `VITE_*` variables are validated at build time. `vite dev` also parses the server schema up front unless `SKIP_ENV_VALIDATION` is set. Details in [API, data and auth](api-data-auth.md#environment).
- **Bundling quirk**: `vite.config.ts` injects `reflect-metadata` ahead of `tsyringe` (pulled in via `@peculiar/x509`/`acme-client`) so chunk ordering cannot break module evaluation. Keep that plugin if you touch certificate/ACME imports.
- **Hyperdrive**: `app/wrangler.jsonc` does not declare a Hyperdrive binding (the repo has never contained one), so the `HYPERDRIVE` binding is expected to be configured on the Cloudflare side. Locally, a binding declared with a local connection string fails with "Disallowed operation called within global scope" because `src/db/index.ts` reads `connectionString` at module load; this reproduces on the pre-existing plugin build too and was not changed here.
- **Docker**: the root `Dockerfile` builds the app with `DEPLOY_TARGET=node` into a self-contained Nitro server; `server-agent/Dockerfile` builds sing-box and the agent. Migrations are not part of the app image.

## Publish gate

Established. The subscription endpoint and the agent both compile from the same desired-state rows, but an agent only learns of a change on its next poll. Without care, a subscription fetched in that window would advertise config the agent is not serving yet.

The gate resolves it:

- Mutations covered by the gate (criterion below) call `recordConfigChange` (`app/src/query/config-change.ts`) with the pre-change snapshot (`prevRow`) and the affected server ids. It bumps `server.desiredRevisionSeq` for each affected server first, then writes a `config_change` row and links it to those servers. It does this inside the caller's transaction on `node-postgres`; on `neon-http` the statements commit individually, which is why the bump comes first. It is a no-op when no server is affected (for example a plan with no nodes).
- The agent reports the revision it applied in its heartbeat; the app stores it as the server's applied sequence.
- `app/src/lib/publish-gate.ts` (the pure half) replays changes that are ahead of a server's applied sequence backwards from their `prevRow` snapshot. Additions and enablements are withheld until applied; removals and disables take effect immediately, because withholding nothing new can never strand a client.
- `desiredRevision` pairs the server's sequence with a content hash of the desired state (`packages/domain/src/config-revision.ts`); the agent treats it as opaque.

### Criterion and exceptions

Record a change when **the agent must apply new state before the subscription may safely advertise the result**: the subscription payload would otherwise describe something the agent is not serving yet. The kinds the gate understands are `node`, `credential`, `authorization` and `server` (plus a `certificate` kind that exists in `CONFIG_CHANGE_KINDS` and the gate's tests but that no mutation path records today). In practice, from the header of `app/src/lib/publish-gate.ts` and the call sites in `app/src/query/`:

- Recorded: node create/update/enable/delete (an update records only when the node's config actually changed, and a node created disabled records nothing, since disabled nodes are in neither payload); credential creation (new subscription) and rotation (credential reset); authorization changes (subscription plan/status/expiry, plan-to-group bindings, group membership, user ban/unban); server enable/disable. The gate hides removals (node deletion, disabling, revoked access) immediately rather than waiting for the agent.
- Not recorded, by design:
  - **Certificate rotation/renewal.** It changes the agent's desired state, which the revision hash already carries, but never the client-facing payload (same domains/SNI).
  - **Node or server address and name edits.** The address is resolved client-side and the agent listens on a wildcard, so there is no agent-side state to wait for.
  - **Routing rule edits** (`app/src/query/rules.ts`). Server-side rules ride the compiled sing-box config, which is hashed into `desiredRevision`; client-side rules only change the Clash payload.
  - Anything that touches no server (the call is a no-op).

When you add a mutation, work out which of those cases it is. If it falls under the recorded cases, add the `recordConfigChange` call, store a `prevRow` the gate can replay (see the `*PrevRow` types in `publish-gate.ts`), and add a case to `lib/publish-gate.test.ts`. If it only changes state carried by the revision hash or the client-only payload, no record is needed. If you cannot tell, read the header comment of `publish-gate.ts` and the nearest existing mutation of the same kind rather than guessing, and note the decision in your change description.

## Security boundaries

Established.

- Admin operations are never reachable through the agent API. The oRPC router is deliberately limited to `agent.*` (see the comment in `app/src/orpc/base.ts`).
- Agent tokens are stored hashed (`server.agentTokenHash`); only a non-secret prefix is shown, and the plaintext is returned once on create/reset. DTOs strip the hash (`ServerDTO`).
- Audit logs and MCP tool results run through a redactor (`app/src/orpc/mcp/redact.ts`) that masks sensitive keys, bearer tokens and PEM blocks.
- Certificate private keys are encrypted at rest with an AES-256-GCM envelope keyed by `CERTIFICATE_MASTER_KEY` (`app/src/lib/certificate-crypto.ts`).
- The agent never trusts inline certificate material or control-plane paths from the config; it injects only local paths it has validated.
