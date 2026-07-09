# Blossom

Blossom is a sing-box proxy subscription control plane. It is a TanStack Start SSR app built with React 19, backed by an oRPC API, better-auth authentication, and Drizzle/PostgreSQL. A Rust server-agent lives under `server-agent/` and runs on proxy nodes, consuming the `/api/agent/*` OpenAPI surface.

## Development

This repo is a pnpm workspace. Run everything from the repo root:

```bash
pnpm install
pnpm dev
```

- `pnpm dev` starts the app dev server on <http://localhost:3000>.
- `pnpm test` runs the Vitest test suites in parallel across workspace packages.
- `pnpm build` builds all workspace packages in parallel.

For app-only commands, use `pnpm --filter @blossom/app <script>`.

## Deployment

The app selects its deploy target through the `DEPLOY_TARGET` build switch in `app/vite.config.ts`. Valid values are `cloudflare` (default), `netlify`, `vercel`, and `node`. Because `cloudflare` is the default, plain `pnpm build` and `pnpm dev` behave exactly as before; platform-specific builds use `pnpm build:<target>`.

> The `pnpm build:*` scripts below are defined in `app/package.json`. From the repo root, run them as `pnpm --filter @blossom/app build:<target>`.

| Platform | Build command | Config | How |
|---|---|---|---|
| Cloudflare Workers (primary) | `pnpm build:cloudflare` | `app/wrangler.jsonc` | `cd app && wrangler deploy` |
| Netlify | `pnpm build:netlify` | `netlify.toml` | Connect the repo, set base directory to `app` |
| Vercel | `pnpm build:vercel` | `app/vercel.json` | Connect the repo, set root directory to `app` |
| Railway | (Docker) | `railway.toml` | Connect the repo; Railway builds from `Dockerfile` |
| Self-host Docker | (Docker) | `Dockerfile`, `docker-compose.yaml` | `docker compose up -d` |

For Cloudflare, push secrets with `wrangler secret put <NAME>` and non-secret vars through `vars` in `app/wrangler.jsonc`. For Netlify and Vercel, configure environment variables in their dashboards; the build presets handle the rest.

### Prebuilt Docker images

Every push to `main` (and `v*` tags) runs `.github/workflows/docker.yml`, which builds and publishes multi-arch (amd64/arm64) images to GHCR:

| Image | Contents |
|---|---|
| `ghcr.io/keiko233/blossom` | The app as a self-contained Node server on port 3000 (built with `DEPLOY_TARGET=node`). |
| `ghcr.io/keiko233/blossom/server-agent` | The Rust server-agent bundled with sing-box (compiled with `with_v2ray_api`). |

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

Copy `app/.env.example` to `app/.env.local` for local development.

## Database migrations

Migrations live in `app/drizzle/` and are applied with Drizzle Kit:

```bash
pnpm --filter @blossom/app db:migrate
```

The command reads `DATABASE_URL` from the environment. Run it manually or in CI before deploying. When using Docker Compose, a one-shot `migrate` service runs automatically before the `app` service starts.

## Self-hosting quickstart

The Docker Compose setup runs Postgres, applies migrations, and starts the app:

```bash
docker compose up -d
```

This brings up:

- `db` — Postgres 17 on the internal network, persisted in `pgdata`.
- `migrate` — One-shot service that runs `pnpm db:migrate` against `db`.
- `app` — The Node server on <http://localhost:3000>, with a health check at `/api/health`.

Before any real deployment, change the placeholder `BETTER_AUTH_SECRET` and set `BETTER_AUTH_URL` to your public domain in `docker-compose.yaml`. `VITE_APP_NAME` is a Docker build ARG; rebuild the image to change the bundled client app name.

To skip building locally, point the `app` service at the prebuilt image (`image: ghcr.io/keiko233/blossom:latest` instead of `build: .`) — the `migrate` service still builds the `builder` stage locally, since migrations are not part of the runtime image.

## Server agent

The Rust server-agent in `server-agent/` consumes the control-plane OpenAPI spec at `/api/agent/*`. After changing the agent-facing API, regenerate the agent client while the dev server is running:

```bash
pnpm --filter @blossom/app agent:spec
```

See `server-agent/.env.example` for agent runtime configuration.

## Learn more

- [TanStack Start](https://tanstack.com/start)
- [TanStack Router](https://tanstack.com/router)
- [better-auth](https://www.better-auth.com)
- [Drizzle ORM](https://orm.drizzle.team)
