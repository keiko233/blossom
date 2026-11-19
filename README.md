# Blossom

Blossom is a sing-box proxy subscription control plane. It is a TanStack Start SSR app built with React 19, backed by an oRPC API, better-auth authentication, and Drizzle/PostgreSQL. A Rust server-agent lives under `server-agent/` and runs once per physical proxy server, consuming the `/api/agent/*` OpenAPI surface.

## Development

This repo is a pnpm workspace. Use Node.js 26 or newer and pnpm 12.16.1. Run everything from the repo root:

```bash
pnpm install
pnpm dev
```

- `pnpm dev` starts the app dev server on <http://localhost:3000>.
- `pnpm test` runs the Vitest test suites in parallel across workspace packages and the release-script tests.
- `pnpm build` builds all workspace packages in parallel.

For app-only commands, use `pnpm --filter @blossom/app <script>`.

## Deployment

The app selects its deploy target through the `DEPLOY_TARGET` build switch in `app/vite.config.ts`. Valid values are `cloudflare` (default), `vercel`, and `node`. Because `cloudflare` is the default, plain `pnpm build` and `pnpm dev` behave exactly as before; platform-specific builds use `pnpm build:<target>`.

Vercel and Node are built by [Nitro](https://nitro.build) (`vercel` and `node-server` presets). The preset is pinned per target rather than auto-detected, so the `build:<target>` scripts are reproducible and keep working if a host's detection changes. Cloudflare Workers keeps `@cloudflare/vite-plugin` because Nitro's `cloudflare_module` preset is not yet a drop-in replacement (see [Runtimes and deploy targets](docs/development/architecture.md#runtimes-and-deploy-targets)).

> The `pnpm build:*` scripts below are defined in `app/package.json`. From the repo root, run them as `pnpm --filter @blossom/app build:<target>`.

| Platform | Build command | Config | How |
|---|---|---|---|
| Cloudflare Workers (primary) | `pnpm build:cloudflare` | `app/wrangler.jsonc` | `cd app && wrangler deploy` |
| Vercel | `pnpm build:vercel` | `app/vercel.json` | Connect the repo, set root directory to `app` |
| Railway | (Docker) | `railway.toml` | Connect the repo; Railway builds from `Dockerfile` |
| Self-host Docker | (Docker) | `Dockerfile`, `docker-compose.yaml` | `docker compose up -d` |

For Cloudflare, push secrets with `wrangler secret put <NAME>` and non-secret vars through `vars` in `app/wrangler.jsonc`. `app/wrangler.jsonc` declares the `HYPERDRIVE` binding for this deployment; replace the config ID with one from your own Cloudflare account, or remove the binding to use `DATABASE_URL` directly. Workers use a separate database client per request. `DATABASE_URL` is still required at runtime and is used by Drizzle Kit migrations. For Vercel, configure environment variables in its dashboard; the Nitro preset handles the rest. The app depends on the private packages under `packages/`, so the host must install the whole pnpm workspace from the repository root. On Vercel keep "Include source files outside of the Root Directory in the Build Step" enabled (the default); Vercel then also rebuilds when a package the app declares in `package.json` changes. The Vercel function runtime is set by the Nitro preset (`nodejs24.x`), not by the app's Node requirement. Local builds and local handler/runtime checks do not prove a hosted deployment: verify a preview deploy on the platform before relying on it.

### Prebuilt Docker images

`v*` and `server-agent-v*` tags run `.github/workflows/docker.yml`, which builds and publishes multi-arch (amd64/arm64) images to GHCR:

| Image | Contents |
|---|---|
| `ghcr.io/keiko233/blossom` | The app as a self-contained Node server on port 3000 (built with `DEPLOY_TARGET=node`). |
| `ghcr.io/keiko233/blossom/server-agent` | Thin runtime (`curl`, `jq`, `tar`, `tini`, entrypoint). On first start it downloads the agent and official sing-box into the persistent `/data` volume. |

Tags: `latest` tracks `main`, `sha-<commit>` pins a build, and `v*` releases also get semver tags (`1.2.3`, `1.2`). Note the app image only runs the server — database migrations still need to be applied separately (see below). `VITE_APP_NAME` is baked in at build time, so a custom app name requires building the image yourself with `--build-arg VITE_APP_NAME=<name>`.

## Environment variables

Server env vars are validated at runtime on the first request, so production builds do not need secrets present at build time. Client env vars (`VITE_*`) are baked into the bundle and validated at build time.

| Variable | Required | Build / Runtime | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | Runtime | PostgreSQL connection string. |
| `DATABASE_DRIVER` | No | Runtime | `neon-http` or `node-postgres`. Auto-detected as `neon-http` for `*.neon.tech` URLs and `node-postgres` otherwise. |
| `BETTER_AUTH_URL` | Yes | Runtime | Public URL of the app, e.g. `http://localhost:3000`. |
| `BETTER_AUTH_SECRET` | Yes | Runtime | Secret key for better-auth. Generate with `pnpm dlx @better-auth/cli secret`. |
| `APP_NAME` | No | Runtime | Display name, defaults to `Blossom`. |
| `VITE_APP_NAME` | No | Build-time | Display name baked into the client bundle, defaults to `Blossom`. |
| `RESEND_API_KEY` | No | Runtime | Resend API key for email sending. |
| `RESEND_MAIL_FROM` | No | Runtime | Sender address used with Resend. |
| `GITHUB_CLIENT_ID` | No | Runtime | GitHub OAuth client ID. |
| `GITHUB_CLIENT_SECRET` | No | Runtime | GitHub OAuth client secret. |
| `GOOGLE_CLIENT_ID` | No | Runtime | Google OAuth client ID. |
| `GOOGLE_CLIENT_SECRET` | No | Runtime | Google OAuth client secret. |
| `CERTIFICATE_MASTER_KEY` | For certificates | Runtime | 32 random bytes, base64url. Encrypts stored certificate private keys; required for any certificate management. Back it up separately from database dumps; without it stored certificates cannot be decrypted. |
| `ACME_EAB_KID` | For ZeroSSL | Runtime | ACME external account binding key ID. Set together with `ACME_EAB_HMAC_KEY`. |
| `ACME_EAB_HMAC_KEY` | For ZeroSSL | Runtime | ACME external account binding HMAC key. |
| `CLOUDFLARE_DNS_API_TOKEN` | No | Runtime | Cloudflare token with DNS Edit on the zone, for automatic ACME DNS-01 validation. Set together with `CLOUDFLARE_DNS_ZONE_ID`. |
| `CLOUDFLARE_DNS_ZONE_ID` | No | Runtime | Cloudflare zone ID used with the token above. |
| `REDIS_URL` | No | Runtime | Redis pub/sub backplane for agent WebSocket fan-out across multiple Node or Vercel instances. Cloudflare Durable Objects do not use it. |
| `MAINTENANCE_TOKEN` | No | Runtime | Bearer token accepted by `/api/maintenance/server-metrics` for bounded retention cleanup. Unset disables the route. |

Copy `app/.env.example` to `app/.env.local` for local development.

When a `HYPERDRIVE` binding is declared, local Cloudflare development supplies `DATABASE_URL` to Wrangler as its local connection string unless an explicit local Hyperdrive connection string is set. Local development does not exercise remote pooling or caching.

## Database migrations

For local development, set `DATABASE_URL` in `app/.env.local` to `postgresql://blossom_dev:blossom_dev@127.0.0.1:55433/blossom_dev` and use `DATABASE_DRIVER=node-postgres` if a driver is explicitly configured. Start the development database and apply migrations:

```bash
docker compose -f docker-compose.dev.yaml up -d --wait
pnpm --filter @blossom/app db:migrate
```

For database integration tests, use the separate test database. The tests delete rows from it, so use it only for disposable test data:

```bash
docker compose -f docker-compose.test.yaml up -d --wait
DATABASE_URL=postgresql://blossom_test:blossom_test@127.0.0.1:55432/blossom_test pnpm --filter @blossom/app db:migrate
BLOSSOM_TEST_DATABASE_URL=postgresql://blossom_test:blossom_test@127.0.0.1:55432/blossom_test BLOSSOM_TEST_CONFIRM_DISPOSABLE=yes pnpm test
```

Both databases bind only to localhost and use separate persistent Compose volumes. Their credentials are for local use only. Stop either with `docker compose -f docker-compose.dev.yaml down` or `docker compose -f docker-compose.test.yaml down`; adding `-v` deletes that database's data. Environment variables supplied in the shell take precedence over `app/.env.local`, so check the target before running migrations.

Migrations live in `app/drizzle/` and are applied with Drizzle Kit:

```bash
pnpm --filter @blossom/app db:migrate
```

The command reads `DATABASE_URL` from the environment. Run it manually or in CI before deploying. When using Docker Compose, a one-shot `migrate` service runs automatically before the `app` service starts.

Host metric history is retained for 30 days. Ingestion prunes one bounded batch after each write, but a deployment that can be idle for long periods should also call `GET` or `POST /api/maintenance/server-metrics` with `Authorization: Bearer $MAINTENANCE_TOKEN` from a scheduler. `batchSize` is clamped to 5000 and `maxBatches` to 100 per call. This repository does not create a scheduler: use an external timer on Node, Vercel Cron or an operator-added Cloudflare Cron Trigger/external scheduler, and allow for the platform's minimum interval and execution limit.

## Self-hosting quickstart

The Docker Compose setup runs Postgres, applies migrations, and starts the app:

```bash
docker compose up -d
```

This brings up:

- `db` — Postgres 18 on the internal network, persisted in `pgdata`.
- `migrate` — One-shot service that runs `pnpm db:migrate` against `db`.
- `app` — The Node server on <http://localhost:3000>, with a health check at `/api/health`.

Before any real deployment, change the placeholder `BETTER_AUTH_SECRET` and set `BETTER_AUTH_URL` to your public domain in `docker-compose.yaml`. `VITE_APP_NAME` is a Docker build ARG; rebuild the image to change the bundled client app name.

To skip building locally, point the `app` service at the prebuilt image (`image: ghcr.io/keiko233/blossom:latest` instead of `build: .`) — the `migrate` service still builds the `builder` stage locally, since migrations are not part of the runtime image.

## Server agent

The Rust server-agent in `server-agent/` consumes the control-plane OpenAPI spec at `/api/agent/*`. Each server owns one agent token and one sing-box process; every enabled node assigned to that server becomes an inbound in the same generated sing-box config. Agents pull the versioned control document from `/api/agent/config/v3` (they advertise the `config-v3` capability), which carries server-managed polling intervals, desired agent/sing-box versions and the sing-box config. Candidates are checked by the target sing-box binary before reload, and the last-known-good config is persisted for rollback. The container stores both binaries, configs, certificates and update state under `/data`; first start downloads the binaries, and later updates are driven by the per-server desired versions in the admin UI. After changing the agent-facing API, regenerate the agent client while the dev server is running:

```bash
pnpm --filter @blossom/app agent:spec
```

See `server-agent/.env.example` for agent runtime configuration.

## Operations

Runbooks for hosting are in [docs/operations](docs/operations/README.md): [self-hosting, secrets and health checks](docs/operations/self-hosting.md), [installing and upgrading the agent](docs/operations/server-agent.md), [backup and recovery](docs/operations/backup-restore.md) and [local validation steps](docs/operations/local-validation.md). The server token shown when you create a server, and the `docker run` command that embeds it, are credentials: do not paste them into shared logs or tickets. The first account registered on a fresh database automatically becomes the administrator, so create yours before exposing a new deployment; see [First admin](docs/operations/self-hosting.md#first-admin).

## MCP API

The app exposes a Model Context Protocol API at `/api/mcp` for external MCP clients. It allows authenticated administrators to manage users, nodes, servers, plans, and subscriptions through MCP tools.

### OAuth authentication

MCP clients connect using OAuth 2.0 authorization code flow with PKCE. OAuth discovery is available at `/.well-known/oauth-authorization-server`; the issuer-path alias is `/.well-known/oauth-authorization-server/api/auth`, and protected-resource metadata is at `/.well-known/oauth-protected-resource/api/mcp`. After authorizing, the client receives an access token scoped to the MCP API.

### Scopes

| Scope | Permission |
|---|---|
| `blossom:mcp:read` | Read resources (users, nodes, servers, plans, subscriptions) and search/get sing-box documentation |
| `blossom:mcp:write` | Write operations (ban/unban users, set roles, create/update/delete nodes, update/delete servers, manage subscriptions) |

Write tools require explicit `confirm: true` and are recorded in the audit log.

### Admin consent

Admin users can review and approve MCP client connections at `/auth/mcp-consent`. This endpoint lists requested scopes and allows the admin to grant or deny access.

## Learn more

- [TanStack Start](https://tanstack.com/start)
- [TanStack Router](https://tanstack.com/router)
- [better-auth](https://www.better-auth.com)
- [Drizzle ORM](https://orm.drizzle.team)
