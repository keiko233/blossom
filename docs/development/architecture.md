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
- **`packages/domain/`**, **`packages/contracts/`**, and **`packages/database/`** contain portable domain rules, browser-safe validation contracts, and database connection management respectively. They expose explicit TypeScript source entry points; their tests run in the app's Vitest suite. The database server entry is denied in client builds.
- **`server-agent/`** is a standalone Rust crate (not part of the pnpm workspace). One agent runs per physical proxy server, owns one sing-box process, and reconciles it to the desired state the app serves. See [Server agent](server-agent.md).

The data model is server → nodes: a `server` has one agent token and one sing-box process; every enabled `node` on it becomes an inbound in the same generated config. Plans, groups, subscriptions, rules, certificates, redeem codes, announcements, settings and audit logs hang off that in `app/src/db/*-schema.ts`.

## Request surfaces

Established. Know which surface you are on, because they authenticate differently.

| Surface                       | Where                                                                  | Authentication                                       | Notes                                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| SSR pages and routes          | `app/src/routes/`                                                      | better-auth session; role checked in `beforeLoad`   | `(admin)` requires `role === "admin"`, `(user)` and `(auth)` have their own groups.                                                    |
| Server functions              | `app/src/query/*.ts`, `app/src/lib/auth.tsx`                           | session; admin ones call `ensureAdmin()`             | The application API for the UI. All admin CRUD lives here.                                                                             |
| Agent API (oRPC)              | `app/src/orpc/router/index.ts`, `app/src/orpc/proxy/agent.ts`          | per-server `Authorization: Bearer` token             | The only procedures in the oRPC router: `agent.getConfigV3`, `agent.heartbeat`, `agent.reportTraffic`.                                 |
| Agent WebSocket               | `app/src/routes/api/agent/ws.ts`                                       | per-server static token or OAuth machine token       | One outbound `/api/agent/ws` connection per server; the bearer is checked before the upgrade. Static tokens serve v1/v2; OAuth machine tokens serve v2 only. |
| Admin PTY WebSocket           | `app/src/routes/api/admin/servers/$id/pty/ws.ts`                        | better-auth admin session + same-origin check        | Human-only browser terminal relayed to one enrolled agent; no server function or MCP tool exposes it.                                  |
| Admin installer download      | `app/src/routes/api/admin/servers/$id/installation/script/$grantId.ts` | better-auth admin session + same-origin check        | Fixed per-server, grant-bound script attachment; never contains the grant and always returns `private, no-store`.                      |
| oRPC mounts                   | `app/src/routes/api/$.ts` (OpenAPI), `app/src/routes/api/rpc/$.ts` (RPC) | same as above                                      | `/api/*` serves the OpenAPI document (`/api/spec.json`, consumed by the agent codegen); `/api/rpc/*` is the oRPC RPC protocol.         |
| better-auth                   | `app/src/routes/api/auth/$.ts`                                         | its own                                              | Email/password, magic link, GitHub/Google (when configured), admin and JWT plugins, OAuth provider for MCP.                            |
| MCP                           | `app/src/routes/api/mcp.ts`, `app/src/orpc/mcp/`                       | OAuth 2.0 bearer; admin actor; `blossom:mcp:*` scopes | Tools call an in-process oRPC router (`mcpRouter`); write tools need `confirm: true` and are audited.                                  |
| Subscription output           | `app/src/routes/api/sub/$token.ts`                                     | the subscription token in the URL                    | Renders a Clash config from the nodes the subscription may use, gated by the publish gate below. Writes an access log.                 |
| Misc                          | `api/health.ts`, `api/admin/certificates/…/export/$part.ts`, `.well-known` routes | health: none; others per route              | `/api/health` is the container health check.                                                                                           |

An isomorphic oRPC client and TanStack Query utilities exist in `app/src/orpc/client.ts`; the pages inspected call server functions directly instead.

### Agent WebSocket transport

Established. The frozen v1 envelope and payload schemas live in
`packages/contracts/src/agent-ws.ts`; the matching Rust client is added by
PR #112 under `server-agent/src/ws/`. Clients that offer the
`blossom-agent.v2` subprotocol use the v2 session protocol on the same route,
documented in [Agent WebSocket v2](agent-ws-v2.md). The control plane
implements v2 sessions; the Rust v2 client is a later change. The control plane authenticates the
  upgrade request with either the same hashed per-server bearer token as the
  oRPC agent API or, on v2, a Better Auth machine token whose active identity
  maps to exactly one server.

- **Nitro (`node`, `vercel`)** uses Nitro's `crossws` WebSocket support. The
  route returns a `426` response carrying crossws hooks; the Node and Vercel
  presets perform the actual upgrade. Vercel welcomes include a 240-second
  `reconnectBeforeSeconds` hint because the function's `maxDuration` bounds a
  connection. When `REDIS_URL` is set, a Redis pub/sub backplane relays
  `config.notify` / `update.trigger` frames to the instance holding the agent.
- **Cloudflare** uses one `AgentSessionDO` Durable Object per server. The Worker
  authenticates first and forwards the upgrade to the object, which uses the
  WebSocket Hibernation API (`acceptWebSocket` + attachments), not an in-memory
  socket map. The Worker-to-object notification path is internal, and no
  Redis service is required.
- Publish-gate mutations and desired-version changes emit best-effort pushes
  after their SQL mutation commits. A missing socket, unavailable Durable
  Object, or unreachable Redis never changes the mutation result; HTTP polling
  and heartbeats remain the fallback.
- The admin terminal adds a second WebSocket surface. The browser connects to
  `/api/admin/servers/<id>/pty/ws`, which accepts only an admin better-auth session
  with a same-origin `Origin`. The route relays `pty.*` frames to exactly the
  agent connection identified by `wsConnectedAt`; it does not accept a host,
  port or command. Nitro keeps the relay in process (or on the Redis
  backplane), while Cloudflare forwards the browser upgrade into the same
  `AgentSessionDO` that holds the agent socket. The agent advertises `pty-v1`
  only when started with `AGENT_PTY_ENABLED=true`. Session open and close are
  written to `admin_audit_log` as metadata only; terminal bytes are never
  stored.

### Agent-executed ACME

Established. ACME orders run on the designated `server-agent`, selected by
`managed_certificate.issuer_server_id` or lazily from an enabled certificate
binding that advertises `acme-v1`. The app creates a fenced
`certificate_issuance_job` row before sending `acme.issue` over the agent
WebSocket; the job id, issuer server, certificate generation, and expiry are
checked again before a result is committed.

- `http-01` uses a temporary responder on the issuer host (port 80 by default,
  configurable with `AGENT_ACME_HTTP_BIND`).
- `dns-01` sends only the exact `_acme-challenge.<domain>` TXT value to the
  control plane. The Cloudflare adapter creates/deletes the record; without a
  Cloudflare token the TXT values are shown for administrator approval and
  manual continuation. DNS credentials never leave the control plane.
- `acme.result` is accepted only from the job's issuer server and only while
  that job is the current generation and unexpired. The returned chain and key
  are validated together, the key is encrypted with `CERTIFICATE_MASTER_KEY`,
  and bound servers receive a best-effort `config.notify`.
- Existing active material and bindings are not rewritten by the migration.
  Rows remain `legacy_control_plane` until a later generation needs issuance;
  then the issuer is resolved and the row moves to `agent_delegated`. An
  existing in-flight legacy ACME order is not resumed: active material keeps
  serving, and the operator can renew to start a new agent job.

The server detail page requests live telemetry through an admin-authenticated,
uncached endpoint. Each request targets the currently recorded WebSocket
session and expires after 2.5 seconds. Normal refreshes request one sample at
a time, and port and interface inspection runs on demand. Telemetry frames
are handled in memory (and relayed over Redis when a Nitro backplane is
configured). They do not write to PostgreSQL. Agents without
`telemetry-v1` continue using their existing transport and update policy.

## Runtimes and deploy targets

Established. `app/vite.config.ts` selects the target from `DEPLOY_TARGET` (`cloudflare` default, `vercel`, `node`). The same source must build and run on all of them, so avoid APIs that exist on only one runtime.

- **Nitro** builds `vercel` and `node` (presets `vercel` and `node-server`, pinned in `NITRO_PRESETS`). Hosts also auto-detect Nitro, but the `build:<target>` scripts, `app/vercel.json` and the Dockerfile pin the preset so builds are reproducible. Outputs: Node `.output/` (Docker) and Vercel `.vercel/output/`.
- **Cloudflare** keeps `@cloudflare/vite-plugin` (it must come before `tanstackStart`). Evidence from Nitro `3.0.260903-beta` (`cloudflare_module`), tried with the same app:
  - Build needs three workarounds (`cloudflare:*` externalised for the SSR environment, no trailing commas in `wrangler.jsonc`, `main` in `wrangler.jsonc` overridden), then succeeds.
  - The earlier local-workerd failure was traced to `acme-client`/`@peculiar/x509`; PR 6 removes both from the app and also removes the `reflect-metadata`/tsyringe bundling workaround. The production compatibility flags remain `nodejs_compat` only because changing them was not verified against a deployment.
  - Nitro's dev runner for Cloudflare (miniflare) requires `miniflare@^4`, but Wrangler 4.154 resolves `5.x` beta, giving `ERR_VALIDATION`. With `miniflare@^4` added, SSR modules fail in workerd (`module is not defined`, `Class extends value [object Module]`), so the local Hyperdrive development path would regress.
  - The plugin-built Worker passes the same local workerd requests unchanged, so the plugin stays until Nitro's Cloudflare dev runner works with this app. Re-evaluate when Nitro or Wrangler updates.
- **Database driver** is resolved in `packages/database/src/driver.ts`: a Hyperdrive connection string (Cloudflare) forces `node-postgres`; otherwise `DATABASE_DRIVER` or auto-detection (`*.neon.tech` → `neon-http`, else `node-postgres`).
- **Transactions**: only `node-postgres` supports interactive transactions (`supportsInteractiveTransactions` in `packages/database/src/driver.ts`). Code that needs atomicity branches on it; on `neon-http` it runs ordered statements and compensates on failure (see `app/src/query/nodes.ts`). Do not assume `db.transaction` works everywhere.
- **`@/lib/database-connection`** is aliased in `vite.config.ts` to the Cloudflare variant only on the Cloudflare target.
- **Environment** is validated lazily at runtime on the server (`getServerEnv()` in `app/src/lib/env.ts`), and client `VITE_*` variables are validated at build time. `vite dev` also parses the server schema up front unless `SKIP_ENV_VALIDATION` is set. Details in [API, data and auth](api-data-auth.md#environment).
- **Hyperdrive**: `app/wrangler.jsonc` declares the `HYPERDRIVE` binding. Database and auth instances are created lazily per Workers request, so connections are not shared across request I/O contexts. Node deployments reuse their database and auth instances. Each Workers request therefore gets its own `pg` pool, created by `drizzle(connectionString)`, i.e. `new Pool({connectionString})` with `pg-pool` defaults: `max` 10, `idleTimeoutMillis` 10000, no connection timeout. Local workerd (12 concurrent `pg_sleep(1)` queries in one request through a local Hyperdrive binding) opened 10 connections, queued the other 2 queries, returned all 12 results in 2.0 s, and left no connections behind once the response finished. Cloudflare's [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) cap the number of connections that are in the initial establishment (waiting-for-headers) phase at six per invocation, with further attempts queued; it is not a limit on all simultaneously open connections, and the documentation does not say how this applies to `pg` sockets. Local workerd was not shown to enforce it. Cloudflare's [Hyperdrive Postgres example](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/) uses `max: 5` in its postgres.js snippet only; it is not a documented requirement for `pg` pools. Whether the default pool size causes queuing or other effects in production is unverified, and the pool size is left unchanged. The pool is deliberately not closed at the end of the handler, because streamed SSR responses may still query after the handler returns. Local Workers requests, including concurrent queries and sign-up, have been tested with a local Hyperdrive binding backed by disposable PostgreSQL; remote Hyperdrive has not been verified.
- **Docker**: the root `Dockerfile` builds the app with `DEPLOY_TARGET=node` into a self-contained Nitro server; `server-agent/Dockerfile` is a thin Alpine runtime whose entrypoint downloads the agent and sing-box into the mounted `/data` volume. `server-agent/Dockerfile.test` is test-only and seeds both binaries for the Docker lifecycle test. Migrations are not part of the app image. The root Dockerfile copies each workspace package's `package.json` before `pnpm install --frozen-lockfile` (for layer caching), so a new package under `packages/` needs a matching `COPY` line there, and any path it adds to the image's inputs belongs in the `app` filter of `docker.yml`.

## Publish gate

Established. The subscription endpoint and the agent both compile from the same desired-state rows, but an agent only learns of a change on its next poll. Without care, a subscription fetched in that window would advertise config the agent is not serving yet.

The gate resolves it:

- Mutations covered by the gate (criterion below) call `recordConfigChange` (`app/src/query/config-change.ts`) with the pre-change snapshot (`prevRow`) and the affected server ids. It bumps `server.desiredRevisionSeq` for each affected server first, then writes a `config_change` row and links it to those servers. It does this inside the caller's transaction on `node-postgres`; on `neon-http` the statements commit individually, which is why the bump comes first. It is a no-op when no server is affected (for example a plan with no nodes).
- Credential rotation (`rotateSubscriptionCredentials` in `app/src/query/subscription-write.ts`, used by the admin reset and the owner self-service rotation) is the exception to "bump, then record in separate statements": it writes the new credentials, the server bumps, the `config_change` row and its links as **one SQL statement** with data-modifying CTEs, so it is atomic on `neon-http` too, and the subscription row is locked `FOR UPDATE` so concurrent rotations chain their `prevRow`. This only holds while readers keep their order: the subscription route reads the subscription row before the pending changes, and `agent.getConfigV3` reads the server's sequence (auth middleware) before compiling credentials. Do not reverse either.
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
- ACME issuance is job-fenced by an unguessable job id, the authenticated issuer server, the certificate generation, and an expiry. DNS challenge acknowledgements also echo the exact TXT value, so a delayed ack cannot release a different challenge for the same name.
- The agent keeps ACME account/challenge values and certificate private keys in redacting/zeroizing wrappers, never logs them, and returns private material only to the control plane, which encrypts it at rest.
