# API, data and auth

Covers server functions, the agent oRPC API, MCP, the Drizzle schema and migrations, environment variables and authentication. For how the surfaces fit together see [Architecture](architecture.md#request-surfaces).

Statements are **Established** unless marked **Recommended**.

## Server functions (the application API)

All admin operations, and the data the UI loads, are TanStack Start server functions in `app/src/query/*.ts` (`createServerFn`). They are not oRPC procedures.

Shape of an admin mutation, from `app/src/query/servers.ts`:

```ts
export const updateServer = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("server.update", {
      targetType: "server",
      targetId: fromInput("id"),
    }),
  ])
  .validator(updateServerSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    // … db work, recordConfigChange(...) when the publish gate covers it …
  });
```

Rules:

- **Authenticate first.** Admin functions call `ensureAdmin()` (`app/src/lib/ensure-admin.ts`) at the top of the handler (by convention; the audit test below does not check this for admin functions); user-facing ones call `ensureSession()` and act only on the session user's data. Take the acting user from the session, not from the input.
- **Publish gate.** If the mutation changes state the agent must apply before subscriptions may advertise it, record it with `recordConfigChange`. The criterion and the exceptions (certificate rotation, address/name edits, routing rules) are in [Architecture](architecture.md#publish-gate); not every agent-affecting mutation needs a record.
- **Validate input with zod** through `.validator(schema)`. Plan and user contracts are in `packages/contracts/`; other shared schemas remain in `app/src/orpc/` so the form and the server use the same one.
- **Audit every POST.** `lib/admin-audit.test.ts` scans `app/src/query/*.ts` and fails if a `createServerFn({ method: "POST" })` lacks `adminAudit("<action>")`, if the action is not in `ADMIN_AUDIT_ACTIONS` (`lib/admin-audit.ts`), or if an action is unused or used twice. The only exemptions are listed in `USER_FACING_POST_FNS` in that test and must use `ensureSession`. To add an audited function: add the action to `ADMIN_AUDIT_ACTIONS` (dotted snake_case, `<family>.<verb>`), add the target type if new, and wrap the function. The middleware records failures too and never changes the mutation's result if the audit write fails.
- **Never leak secrets in DTOs.** Strip hash and secret columns before returning rows (`ServerDTO` omits `agentTokenHash`). Return one-time plaintext (agent tokens, redeem codes) only from the create/reset call that generates it.
- **Errors** are thrown as `Error` with a message the UI can show; expected business failures that the UI must localise are better returned as a typed result (`redeemCode` returns `{ ok: false, reason }`). **Recommended**: prefer typed results over matching on message text.
- Export the TanStack Query key constant beside the functions the UI caches (`SERVERS_QUERY_KEY`).
- Server-only helpers that are not endpoints (`settings-store.ts`, `config-change.ts`, `admin-audit-record.ts`, …) also live in `query/`; only exported `createServerFn` values are callable from the client.

## Agent API (oRPC)

The oRPC router (`app/src/orpc/router/index.ts`) exposes exactly the agent surface: `agent.getConfigV3` (`GET /agent/config/v3`), `agent.heartbeat` (`POST /agent/heartbeat`), `agent.reportTraffic` (`POST /agent/traffic`), mounted under `/api` (OpenAPI) and `/api/rpc` (RPC). Definitions are in `app/src/orpc/proxy/agent.ts`; request/response zod schemas in `app/src/orpc/proxy/schema.ts`.

- Procedures build on `agentProcedure`, which resolves the bearer token to exactly one `server` row by hash. Do not add admin or cross-server capability to this router.
- `POST /api/agent/enrollment/redeem` is a plain route (`routes/api/agent/enrollment/redeem.ts`), not an oRPC procedure. It has no bearer credential: the one-time enrollment grant in the body is its only authority, and it resolves to one server. The successful response is the only place a client secret is returned, with `Cache-Control: no-store`. Its handler is `lib/agent-enrollment-route.ts`, and it is not in the agent OpenAPI spec.
- `GET /api/agent/ws` is a separate authenticated WebSocket surface, not an oRPC procedure. Its open frame protocol is `packages/contracts/src/agent-ws.ts`. The v1 path uses the static token hash. The v2 path also accepts a Better Auth machine token, checked against the exact agent audience and machine scope and mapped through `agent_identity`; it rejects missing, unknown, disabled, expired, or revoked credentials with `401`. A first pending identity is promoted by its `hello`; a replacement demotes the old active generation only after the new one proves the same handshake. Fenced v2 reads/writes include the active generation and token expiry. The `hello` / `config.ack` / `update.status` paths write only their focused server columns, while HTTP heartbeat/polling remains the fallback.
- Agent-executed ACME jobs use the same socket. The control plane sends `acme.issue`; the agent returns `acme.dns_present` / `acme.dns_cleanup` and finally `acme.result`. Accepting a DNS challenge or result requires the authenticated server to match `certificate_issuance_job.issuer_server_id`, the job to be current and unexpired, and the DNS acknowledgement to match the exact TXT value. Results from older generations are ignored.
- `GET /api/admin/servers/$id/pty/ws` is the human admin terminal WebSocket. It checks an admin better-auth session and a same-origin `Origin` before upgrading, then relays `pty.*` frames to the enrolled agent's WebSocket. It is not a server function, oRPC procedure or MCP tool; the agent exposes it only when started with `AGENT_PTY_ENABLED=true` (`pty-v1`). Session start/end are audited as `server.pty_open` / `server.pty_close` with metadata only. `GET /api/admin/servers/$id/pty/status` is the same-origin readiness probe the panel calls before connecting: `403` for denied access, otherwise `{ "available": true }` or `{ "available": false, "reason": "disabled" | "offline" | "unsupported" }`.
- Type every input and output with zod: the OpenAPI document generated from them is the contract the Rust client is generated from. The one deliberately loose part today is the sing-box base config object inside `getAgentConfigV3`'s output. Give each route an explicit `operationId`; it becomes the Rust method name (`get_agent_config_v3`).
- Agents are deployed independently of the control plane, so a new control plane may meet an older agent and the reverse. The current code tolerates legacy traffic entries and adds capabilities rather than breaking fields. **Recommended**: change the contract additively; when a breaking change is unavoidable, version the path (as `v3` was) and keep the old one until agents have moved.
- After changing a route or schema, regenerate the spec and rebuild the agent: see [Generated files](generated-files.md#agent-openapi-spec-and-client) and [Server agent](server-agent.md).
- Traffic reports with an agent-supplied `reportId` are deduplicated per server. `recordAgentTraffic` claims the report, inserts history and increments subscription counters in one PostgreSQL statement, so the same transaction boundary works with `node-postgres` and `neon-http`. A replay with different content is rejected. Ledger records are retained for 30 days; the agent drops undeliverable batches after 7 days. Legacy reports without an ID are atomic but cannot be deduplicated on retry. See [Server agent](server-agent.md) for the agent-side durability limits.

## MCP API

`app/src/routes/api/mcp.ts` registers tools with `mcp-handler`; each tool calls the in-process `mcpRouter` (`app/src/orpc/mcp/`), which is not exposed over HTTP by itself.

- Auth is OAuth 2.0 (authorization code + PKCE) via the better-auth `oauthProvider` plugin. The actor must be an admin (`requireActorAdmin`). Scopes are `blossom:mcp:read` and `blossom:mcp:write` (`orpc/mcp/context.ts`).
- Write tools take `confirm: true` (`confirmLiteral`), require the write scope, and are recorded through `appendMcpToolAudit`. Results and audit payloads pass through `orpc/mcp/redact.ts`.
- A new tool needs: a zod input in `orpc/mcp/context.ts`, a procedure in `orpc/mcp/router.ts` on the read or write procedure base, an implementation in `query/mcp-tools.ts`, a `registerTool` call in `routes/api/mcp.ts`, and redaction coverage if it returns anything sensitive. `orpc/mcp/__tests__/` shows the test style. Update the README's scope table if capabilities change.

## Database (Drizzle and PostgreSQL)

- Tables are defined in `app/src/db/*-schema.ts` and re-exported from `app/src/db/schema.ts`, which is what `drizzle.config.ts` and better-auth's Drizzle adapter read. **A new schema file must be exported from `schema.ts`** or migrations and the auth adapter will not see it.
- `auth-schema.ts` and `oauth-schema.ts` mirror better-auth's tables. When upgrading better-auth, reconcile them with its schema and ship a migration (the upgrade to 1.7 did exactly this in the `better_auth_1_7_oauth` migration).
- The `db` facade from `@/db` lazily resolves a database instance: one per request on Workers, shared on Node. It is a `NeonHttpDatabase | NodePgDatabase` union; write queries that work on both, and respect the transaction limits in [Architecture](architecture.md#runtimes-and-deploy-targets).
- Prefer SQL-side atomic updates (Drizzle's `sql` template and `returning()`) over read-modify-write for counters and state transitions.
- IDs are text (UUIDs from `randomUUID()` for app tables; better-auth generates its own).

### Migrations

Migrations are folders in `app/drizzle/<timestamp>_<name>/` with `migration.sql` and `snapshot.json`, created by Drizzle Kit.

1. Edit the schema in `app/src/db/`.
2. `pnpm --filter @blossom/app db:generate` writes the new folder. Review the SQL; check destructive statements and defaults for existing rows.
   For SQL the schema DSL cannot express (triggers, functions, data backfills) use `pnpm --filter @blossom/app exec drizzle-kit generate --custom --name <name>`, which creates an empty migration (with a snapshot) for hand-written SQL; separate statements with `--> statement-breakpoint` and explain why in a leading comment, as `*_first_admin_trigger` does.
3. Commit the schema change and the generated folder together. Add a new migration rather than editing or renaming one that may already have been applied: databases that recorded it will not run the edited version.
4. Apply with `pnpm --filter @blossom/app db:migrate` (Docker Compose runs it through the `migrate` service). The README documents this as the deployment step.

The PR 6 certificate migration adds `managed_certificate.issuer_server_id`,
`challenge_type`, `issuance_mode`, and the fenced
`certificate_issuance_job` table. It does not rewrite active certificate
material or bindings: existing rows default to `legacy_control_plane` and move
to `agent_delegated` only when the next generation is actually needed.

What the commands do, so you can pick a safe target:

- `db:migrate` executes the pending `migration.sql` files against whatever database `DATABASE_URL` resolves to. `drizzle.config.ts` loads `.env.local` and then `.env`, so a developer's local env file can silently point it at a shared or real database. Check the target before running.
- `db:push` syncs the live schema to the TypeScript schema directly, with no migration file and no review step, and can drop or alter data. It is not part of the documented workflow. `db:pull` introspects a database and rewrites schema files.
- `db:generate` creates migration files from the schema. Its database connection behavior has not been verified here.
- To verify a migration or schema change, apply it to a dedicated disposable PostgreSQL database with an explicit `DATABASE_URL`, then discard it. The Compose `db` service uses a persistent volume, so do not assume it is disposable. Whether to apply anything beyond a disposable database is for the task instructions to decide.

## Environment

- Server variables are defined once in `app/src/lib/env-schema.ts` (`serverEnvSchema`) and read through `getServerEnv()` in server-only code; client variables (`VITE_*`) are in `clientEnvSchema` and `lib/env-client.ts`. Application code should not read `process.env` directly; the current exceptions are `lib/env.ts` itself, a status report in `query/settings.ts`, and the build/tool configs (`vite.config.ts`, `drizzle.config.ts`).
- To add a variable: add it to the zod schema, to `app/.env.example` with a placeholder, and to the README table if it affects deployment. Cover non-trivial parsing in `lib/env-schema.test.ts`.
- Production validates on first request, not at build, so builds need no secrets. `vite dev` validates up front unless `SKIP_ENV_VALIDATION` is set.
- `BETTER_AUTH_URL` must be `https` except for localhost.
- Local values live in `app/.env.local` (ignored by git through `*.local`) and may include real database URLs and secrets. Use `.env.example` as the reference for names and placeholders. If a task requires looking at the local file (for example to see which variables are set), keep the values out of your output, logs, tests, docs and commits, and never commit the file.

## Authentication and authorization

- better-auth is configured in `app/src/lib/auth.tsx` with the Drizzle adapter and plugins `admin`, `magicLink`, `jwt`, `oauthProvider` and `tanstackStartCookies`. Call it through `getAuth()`, which builds it lazily on the server.
- Roles are `admin` and `user` (`user.role`). Admin checks use `role === "admin"` in route `beforeLoad` and in `ensureAdmin()`. `ensureAdmin` caches one session lookup per request.
- **The first user ever inserted becomes `admin`, in the database, not in better-auth.** The `user_claim_first_admin` trigger (custom migration `*_first_admin_trigger`) claims the single-row `admin_bootstrap` table inside the user insert, so it is atomic, race-free and rolled back with a failed insert on both drivers, and better-auth's returned user, `create.after` hook and session see `role: admin`. Do not re-implement this with a read-then-write in a hook, and do not give `admin_bootstrap` a foreign key to `user` (deleting all users must not reopen the claim). Details and the security implications are in [First admin](../operations/self-hosting.md#first-admin); tests are in `app/src/db/admin-bootstrap.test.ts`.
- Registration rules (open or closed mode, plus an allowed-email-domain list) are enforced in one place, better-auth's `validateUserInfo` hook, via `createRegistrationHooks`; `emailSignUp` pre-checks only to avoid sending a link that would fail. Change rules in `packages/domain/src/registration-policy.ts` and keep its tests current.
- Sign-up grants a trial through `grantSignupTrial` when enabled in settings.
- Social providers are enabled only when both id and secret are set.
- Agent credentials are separate from user sessions: a per-server token, hashed with `hashAgentToken`, matched against `server.agentTokenHash` (`lib/agent-token.ts`).
- Agent machine identity (OAuth) is a second, additive credential path. **Established** facts (the code and its disposable-database tests enforce them):
  - Each server has at most one `active` and one `pending` `agent_identity` (`db/agent-identity-schema.ts`). Each identity owns one confidential `oauth_client` (`client_secret_basic`, `client_credentials` only, `client_credentials_scopes` = `blossom:agent:connect`) and one link to the agent resource. Client secrets are stored in the provider's hashed form.
  - The agent resource is `<origin>/api/agent`, the MCP resource is `<origin>/api/mcp` (`lib/oauth-provider-config.ts`). Machine tokens are issued for the agent resource with a 15 minute lifetime. They carry `aud` = the agent resource, `scope` = `blossom:agent:connect` exactly, and `client_id` = `azp` = `sub` = the machine client id.
  - Per-client resource enforcement is on. The machine scope and the agent resource are absent from every dynamic-registration allowlist, and the provider refuses admin link, update, or delete of the agent resource. Only enrollment writes the agent link.
  - Enrollment grants (`agent_enrollment_grant`) store only a SHA-256 hash. The admin functions in `query/agent-identity.ts` (`createAgentEnrollmentGrant`, `revokeAgentEnrollmentGrant`, `revokeAgentIdentityAccess`, `getAgentIdentityState`) are audited. The state machine and its atomicity are in `query/agent-identity-store.ts`.
  - `verifyAgentAccessToken` (`lib/agent-oauth.ts`) checks the token and then the database, so a revoked identity or disabled server fails even before the token expires. A pending identity may act only for its `handshake` purpose.
  - Machine clients never receive the MCP resource: the MCP backfill (`lib/oauth-resource-links.ts`) skips them.
- Subscription tokens are bearer credentials in a URL. Do not log full URLs containing them.

## Secrets checklist

Before finishing any change in this area: no real tokens, keys, connection strings or emails in code, tests, fixtures, docs or commit messages; test fixtures use obviously fake values; new log lines and audit payloads do not include credentials (extend `redact.ts` if you introduce a new sensitive field name).
