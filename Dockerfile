# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS builder
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY app/package.json app/
# Husky's `prepare` script installs git hooks, but .git is excluded by
# .dockerignore. Setting HUSKY=0 makes husky a no-op while still allowing
# dependency build scripts (e.g. @parcel/watcher, esbuild, sharp) to run.
ENV HUSKY=0
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY app/ app/
ARG VITE_APP_NAME
ENV VITE_APP_NAME=${VITE_APP_NAME:-Blossom}
ENV DEPLOY_TARGET=node
RUN pnpm --filter @blossom/app build

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
# nitro node-server output is self-contained — no node_modules needed
COPY --from=builder --chown=app:app /repo/app/.output ./.output
USER app
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", ".output/server/index.mjs"]
