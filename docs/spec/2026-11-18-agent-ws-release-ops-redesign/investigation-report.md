# Blossom Architecture Redesign: Investigation Report

**Date:** 2026-11-18  
**Status:** Investigation & target architecture proposal (Phase 1 baseline for PR 1–PR 7)  
**Scope:** Bidirectional `server-agent` WebSocket transport, Serverless/PaaS & Nitro `crossws` compatibility, Semver & Release workflow (`clash-nyanpasu` alignment), Agent-side SSL/ACME issuance, and Ephemeral Web SSH + One-Click Server Provisioning.

---

## Executive Summary & Locked Decisions

This investigation evaluates five interlocking limitations in Blossom's current control-plane (`app/`) and Rust agent (`server-agent/`) architecture, incorporating confirmed product decisions from the project owner:

| Decision ID | Area | Confirmed Choice |
| ----------- | ---- | ---------------- |
| **A1** | WebSocket policy & Netlify | Require native WebSocket support across all supported control-plane targets; **formally drop the Netlify deployment target** (`netlify.toml`, `build:netlify`, Netlify Nitro preset, and CI build step). |
| **A2** | Semver & Release lines | Keep **independent semver lines**: `vX.Y.Z` for the control plane (`app` / overall release) and `server-agent-vX.Y.Z` (`make_latest: false`) for `server-agent`, unified under one `publish.yml` workflow with a `target` selector (`app`, `server-agent`, `both`). |
| **A3** | Post-release image & binary publishing | Stop building GHCR images on every push to `main`. Trigger GHCR multi-arch builds (`ghcr.io/<repo>` and `ghcr.io/<repo>/server-agent`) and static agent asset releases only from published releases/tags (plus manual dispatch). Runtime deployment stays external (Watchtower / Kubernetes / manual pull). |
| **A4** | Web SSH credentials & serverless fallback | Keep SSH credentials **ephemeral in active session memory only** (never persisted in PostgreSQL or audit logs). Once `server-agent` is running, interactive terminal (`xterm.js`) runs over the agent's outbound WebSocket without SSH. When a serverless target cannot open outbound TCP:22, provide a copyable one-line bootstrap command / local CLI fallback. |

---

## 1. Agent Communication Redesign: Polling → Bidirectional WebSocket

### 1.1 Current State (Established)

Today, `server-agent/` communicates with `app/` strictly over three HTTP/OpenAPI endpoints generated from `server-agent/openapi/spec.json` (`app/src/orpc/proxy/agent.ts`):

- `GET /api/agent/config/v3` (`get_agent_config_v3`): polls full sing-box base config, `managedTlsBindings`, `certificateArtifacts`, `desiredRevision`, and `AgentPolicy` (`desiredAgentVersion`, `desiredSingBoxVersion`, intervals). Default `configPollIntervalSeconds = 60` (`app/src/orpc/proxy/schema.ts`).
- `POST /api/agent/heartbeat` (`agent_heartbeat`): reports `appliedRevision`, `certificateDeployments`, `updates`, `agentVersion`, `agentBuildId`, and `agentCapabilities`. Default `heartbeatIntervalSeconds = 30`.
- `POST /api/agent/traffic` (`report_agent_traffic`): pushes sealed per-user connection delta batches with stable report IDs for 30-day deduplication.

**Structural bottlenecks:**

1. **Latency vs. load tradeoff:** Config changes, revocations, and binary upgrade triggers wait up to `configPollIntervalSeconds` (60s), while reducing poll intervals amplifies DB reads across serverless invocations.
2. **No control-plane-to-agent commands:** The control plane cannot initiate on-demand actions (host diagnostics, port/network inspection, immediate update retry, interactive PTY, or ACME issuance) because agents have no inbound listening port and often sit behind NAT/firewalls.
3. **Opaque runtime environment:** `server` rows record versions and `appliedRevision`, but administrators cannot inspect CPU/memory/disk load, whether `server-agent` runs inside Docker (`network_mode: host` vs bridge) or bare-metal `systemd`, or which local TCP/UDP ports and network interfaces exist.

### 1.2 Target Architecture: Multiplexed Outbound WebSocket

`server-agent` establishes one long-lived outbound TLS WebSocket (`wss://<control-plane>/api/agent/ws`) authenticated via its existing per-server bearer token (`Authorization: Bearer <token>`, hashed against `server.agentTokenHash`), preserving the strict separation between `agent.*` and admin surfaces.

```text
  Browser Admin UI (xterm.js / Live Status / Certs)
        │  SSE / Admin WS / Server Functions (ensureAdmin)
        ▼
  Control Plane (app/) ── RealtimeHub (In-Memory / DO / PubSub)
        ▲
        │  wss://<host>/api/agent/ws (single outbound TLS WS per server)
        │  subchannels: config | update | telemetry | pty | acme | traffic
        │
  server-agent (Rust, tokio-tungstenite)
        ├─ processkit ──▶ sing-box (gRPC stats + reload)
        ├─ telemetry  ──▶ /proc, cgroups, netlink/interfaces, open sockets
        ├─ pty        ──▶ portable-pty (/bin/sh or bash)
        └─ acme       ──▶ instant-acme + rcgen
```

#### Wire Protocol & Subchannels

Use a versioned, frame-tagged JSON/binary envelope (`protocolVersion: 1`, `channel`, `requestId`, `seq`, `payload`; binary WebSocket frames reserved for high-throughput `pty.data` streams to avoid base64 overhead, or compact tagged frames with explicit `sessionId`):

| Channel | Direction | Purpose | Preserved Invariants |
| ------- | --------- | ------- | -------------------- |
| `hello` / `welcome` | Bidirectional | Negotiates `agentVersion`, `agentBuildId`, `capabilities` (e.g., `ws-v1`, `telemetry-v1`, `pty-v1`, `acme-v1`), heartbeat cadence, and initial `desiredRevisionSeq`. | Rejects unknown/revoked tokens before upgrade completion. |
| `config` (`config.notify`, `config.snapshot`, `config.ack`) | Server → Agent → Server | Control plane pushes lightweight `config.notify { desiredRevisionSeq, desiredRevision }` immediately after publish-gate mutations; agent pulls full V3 config (or receives `config.snapshot`) and acknowledges `appliedRevision` + `certificateDeployments`. | Preserves monotonic `desiredRevisionSeq`, `publish-gate` pre-row replay (`app/src/lib/publish-gate.ts`), `sing-box check` preflight, `RUNTIME_PROBATION`, and last-known-good rollback. |
| `update` (`update.trigger`, `update.status`) | Bidirectional | Control plane triggers immediate `server-agent` or `sing-box` check/install; agent streams granular progress (`checking` → `downloading` → `verifying` → `applying` → `restarting` → `up_to_date` / `failed`). | SHA-256 verification mandatory; binary rollback (`server-agent.prev`, `sing-box.prev`, exit `75`) preserved. |
| `telemetry` (`telemetry.sample`, `telemetry.inspect`) | Agent → Server / Request-Reply | Periodic lightweight summary (CPU %, RAM used/total, load, uptime, container/host badge) while an admin subscribes, plus on-demand deep snapshot (listening TCP/UDP sockets, NICs, IPv4/IPv6 routes, cgroup memory/CPU limits, Docker env). | Sensitive fields (process command lines with env secrets, internal tokens) scrubbed before emission. |
| `pty` (`pty.open`, `pty.data`, `pty.resize`, `pty.close`, `pty.exit`) | Bidirectional | Multiplexed interactive terminal sessions bound to short-lived admin session IDs. | Admin role verified + `adminAudit` logged on open/close; idle timeout (e.g., 15m) + hard max session cap; bounded ring/channel buffer prevents slow browser from stalling agent event loop. |
| `acme` (`acme.issue`, `acme.dns_present`, `acme.dns_cleanup`, `acme.result`) | Bidirectional | Dispatches issuance/renewal jobs to a designated `server-agent`; agent executes ACME and asks control plane to write/clean DNS-01 TXT records when using brokered DNS. | Private keys generated on agent and encrypted/persisted by control plane; never logged. |

#### Fallback & Reconnect Semantics

- **Reconnect:** Exponential backoff (`1s` → `2s` → `5s` → `15s` → `30s` max + jitter). Every reconnect emits a fresh `hello` with current `appliedRevision`, `certificateDeployments`, and update state so no push missed during a disconnect is lost.
- **HTTP coexistence:** Retain `GET /api/agent/config/v3` and `POST /api/agent/traffic` during migration (and keep HTTP heartbeat/config polling as an automatic degraded fallback if a reverse proxy breaks WS upgrades, surfaced clearly in the UI as `"Transport: HTTP Fallback (WS unavailable)"`). Existing `tests/mock_control_plane.py` and `server-agent` backwards compatibility stay intact across PRs.

### 1.3 Host & Container Telemetry Design (Linux)

`server-agent` targets Linux (`amd64` / `arm64` static musl). Telemetry should use pure Rust `/proc` and `/sys` readers plus standard netlink/interface enumeration without shelling out to fragile tools:

- **Execution environment detection:**
  - Detect container indicators (`/.dockerenv`, `/run/.containerenv`, `/proc/1/cgroup` matching `docker`/`containerd`/`kubepods`, PID 1 process name).
  - Read container limits when containerized: cgroup v2 (`/sys/fs/cgroup/memory.max`, `memory.current`, `cpu.max`, `cpu.stat`) with cgroup v1 fallback (`/sys/fs/cgroup/memory/memory.limit_in_bytes`, `cpu.cfs_quota_us`). Report host totals vs. container quota transparently so an admin never mistakes a 1 GiB container cap on a 64 GiB host for 64 GiB free.
  - Detect network mode (`host` vs `bridge`): check `/proc/net/fib_trie` / interface list (`docker0`/`eth0` private bridge vs host NICs). Note `server-agent/docker-compose.yaml` defaults to `network_mode: host`, where `/proc/net/{tcp,tcp6,udp,udp6}` reflects host sockets directly.
- **Ports & network snapshot:** Parse `/proc/net/{tcp,tcp6,udp,udp6}` (with optional inode → `/proc/<pid>/fd` mapping when `CAP_NET_ADMIN` / root / same user permits) and enumerate interfaces (`ifaddrs` / `/sys/class/net/*` + IPv4/IPv6 addresses) so admins can diagnose port conflicts before adding a `sing-box` inbound.

---

## 2. Serverless / PaaS WebSocket Compatibility & Nitro `crossws` Analysis

### 2.1 Direct Findings from Installed Nitro & `crossws`

Blossom currently uses `nitro@3.0.260903-beta` (`app/package.json`) with `app/vite.config.ts` selecting `@cloudflare/vite-plugin` for `cloudflare` and Nitro presets (`node-server`, `vercel`, `netlify`) for the others.

Inspection of `node_modules/.pnpm/nitro@3.0.260903-beta/node_modules/nitro/dist/presets/` and `crossws` confirms:

1. **Nitro unified WebSocket API (`crossws`):**
   - Nitro v3 exposes `features: { websocket: true }` in `nitro.config` and `defineWebSocketHandler({ upgrade, open, message, close, error })` (or `.ws.ts` route handlers).
   - `node_server` (`nitro/dist/presets/node/runtime/node-server.mjs`): Uses `crossws/adapters/node` directly on the Node HTTP server's `upgrade` event. Supports full long-lived bidirectional WebSockets, binary frames, and `peer.publish()`. Works out of the box in single-container Docker (`Dockerfile`). Horizontal multi-replica Node deployments still require an external pub/sub backplane (Redis or PostgreSQL `LISTEN/NOTIFY`) so admin requests hitting replica A reach an agent connected to replica B.
   - `vercel` (`nitro/dist/presets/vercel/runtime/vercel.node.mjs` + `crossws/adapters/vercel`): Uses `Symbol.for("@vercel/request-context").upgradeWebSocket()`. **Vercel Functions added native WebSocket server GA support on Fluid Compute (Oct 2026)**, charging zero active CPU while idle. **However, three hard constraints remain:**
     1. Every WebSocket connection is still bounded by the Function's `maxDuration` (**300s Hobby / 800s Pro**), requiring seamless client reconnection.
     2. Connections pin to a single Function instance — there is **no built-in cross-instance pub/sub** like Cloudflare Durable Objects. An admin HTTP request or mutation on instance B cannot reach an agent WebSocket on instance A without an external pub/sub / state backplane (e.g., Upstash Redis / Redis URL).
     3. Outbound raw TCP sockets (`net.connect` to arbitrary port `22`) are **not supported** on Vercel serverless/Fluid functions (see Part 5).
   - `cloudflare_module` / `cloudflare_durable` (`nitro/dist/presets/cloudflare/runtime/cloudflare-durable.mjs` + `crossws/adapters/cloudflare`): Nitro integrates `crossws` via a `$DurableObject` export using **Cloudflare Durable Objects WebSocket Hibernation** (up to 32,768 WebSockets per DO instance, 32 MiB max message, hibernation after ~10s inactivity at zero duration billing while keeping connections alive, `setWebSocketAutoResponse` for cheap heartbeats, and `serializeAttachment` up to 16 KiB per socket).
     - **Important Blossom synergy:** As documented in [`docs/development/architecture.md`](../../development/architecture.md#runtimes-and-deploy-targets), Blossom currently keeps `@cloudflare/vite-plugin` instead of Nitro `cloudflare_module` because `acme-client` (`debug` → `process.stderr`, `@peculiar/x509` → `tsyringe`/`reflect-metadata`, `node:fs`) crashes local `workerd` and because Nitro's `miniflare@^4` clashed with Wrangler 4.154 (`5.x`). **Moving ACME issuance to `server-agent` in PR 6 removes `acme-client`, `@peculiar/x509`, `tsyringe`, and `reflect-metadata` from `app/` completely**, eliminating the main Workers bundle workaround (`tsyringeReflectMetadata()` in `app/vite.config.ts`). Even before migrating away from `@cloudflare/vite-plugin`, `@cloudflare/vite-plugin` natively supports named Durable Object exports in `app/src/server.ts` and `app/wrangler.jsonc`!
   - `netlify` (`nitro/dist/presets/netlify/runtime/netlify{,-edge}.mjs`): **No `crossws` WebSocket support exists** (`_websocket` is absent in both Node Functions and Edge Functions; Netlify Functions cap at 60s and Edge Functions cap at 50ms CPU). Netlify's "Netlify Server" container preview (Nov 2026) has no Nitro integration. **Per decision A1, Netlify is dropped cleanly in PR 1.**

### 2.2 Market Platform Compatibility Matrix (2026)

| Platform / Runtime | WebSocket Support | Connection Limit / Timeout | Cross-Instance Routing (`app` → `agent`) | Outbound Raw TCP:22 (Web SSH) | Verdict for Blossom |
| ------------------ | ----------------- | -------------------------- | ---------------------------------------- | ----------------------------- | ------------------- |
| **Node.js / Docker (`node-server`)** | Native (`crossws/adapters/node`) | Unbounded (OS/proxy limits) | In-memory (1 replica); Redis/PG pubsub (>1 replica) | Full (`ssh2` / Node `net`) | **Primary Tier-1 target** |
| **Cloudflare Workers + Durable Objects** | Native (`DO` WebSocket Hibernation) | 32,768 WS/DO; 32 MiB msg; unlimited duration while hibernating | Native! Deterministic DO ID (`idFromName(serverId)` or sharded hub) routes any Worker request to the exact connected DO | `cloudflare:sockets` `connect()` supports port 22 (blocks hibernation while open; no CF-proxied/RFC1918 IPs without Workers VPC; `ssh2` compat requires validation) | **Tier-1 Serverless target** (Web SSH falls back to script if `ssh2` shim unsuitable) |
| **Vercel (Fluid Compute)** | Native (`crossws/adapters/vercel`, GA Oct 2026) | `maxDuration` cap (**300s Hobby / 800s Pro**); 0 CPU cost when idle | No built-in routing; requires Redis/Upstash backplane (`REDIS_URL`) for push/PTY | Unsupported | **Supported for Agent WS (with reconnect + backplane); Web SSH uses fallback** |
| **Fly.io / Railway / Render** | Full native (Node Docker image) | Unbounded (Fly needs `min_machines_running >= 1` or `auto_stop_machines = "off"`; Railway exempts WS from 15m HTTP timeout unless Serverless sleep enabled; Render free tier sleeps after 15m) | Same as Node Docker (`REDIS_URL` if scaled >1 replica) | Full (`ssh2` / Node `net`) | **Fully supported via `Dockerfile` (`node-server`)** |
| **Netlify** | None in Serverless/Edge/Nitro | 60s Functions / 50ms Edge | N/A | Unsupported | **Dropped (Decision A1)** |
| **Deno Deploy** | `Deno.upgradeWebSocket` (no Blossom preset) | Legacy platform **announcing shutdown ~Apr 2027** | BroadcastChannel / KV | Restricted | **Do not target** |
| **AWS Lambda + API Gateway WS** | Proprietary connectionId + `@connections` REST API | 2h connection max, 10m idle, 32 KB frame / 128 KB msg | DynamoDB + Management API | Unsupported | **Incompatible with Nitro `crossws`; do not target** |

### 2.3 Control-Plane `RealtimeHub` Abstraction

To preserve "same source runs on all supported deploy targets" without runtime-specific sprawl in feature routes, introduce a narrow `RealtimeHub` adapter boundary in `app/`:

- **`NodeRealtimeHub` (`node-server`):** In-memory `Map<ServerId, Peer>` for single-instance Docker, optionally backed by `REDIS_URL` pub/sub (and/or PostgreSQL `LISTEN/NOTIFY` via dedicated `pg.Client` on `node-postgres`) when running multiple replicas.
- **`CloudflareRealtimeHub` (`@cloudflare/vite-plugin` + `AgentSessionDO`):** Deterministic Durable Object keyed per server (or shard) holds the live `server-agent` WebSocket using Hibernation APIs (`ctx.acceptWebSocket(ws)` + `webSocketMessage`/`webSocketClose`), plus an internal `fetch`/RPC handler so any Worker request (`ensureAdmin()` server function, publish-gate hook, or browser admin WS) relays commands directly to the DO holding that server's socket. Zero external Redis needed!
- **`VercelRealtimeHub` (`vercel` Nitro `crossws`):** Uses `crossws` WebSocket handler for `server-agent` + automatic 240s/700s proactive client reconnect before `maxDuration` expiry. When `REDIS_URL` is configured, bridges admin→agent pushes across Function instances via Redis Pub/Sub + short-lived streams; when unconfigured, marks multi-instance push as unsupported while `config.notify` falls back safely to shorter reconnect/poll intervals.

---

## 3. Semver & Release Publish Workflow Redesign

### 3.1 Current State & GitHub Branch Protection Findings

Inspected workflows and repository protection rules on `keiko233/blossom`:

- `.github/workflows/docker.yml`: Triggers on `push: branches: [main]` and `tags: ["v*"]`, rebuilding and pushing multi-arch GHCR images (`ghcr.io/keiko233/blossom` and `ghcr.io/keiko233/blossom/server-agent`) on **every merge to `main`**.
- `.github/workflows/server-agent-release.yml`: Triggers on `server-agent-v*` tags and validates manual `Cargo.toml`/`Cargo.lock` tag agreement, building static musl binaries (`server-agent-linux-amd64`, `server-agent-linux-arm64`, `SHA256SUMS`) with `make_latest: false`.
- `.github/workflows/test.yml`: Runs on `pull_request` / `workflow_dispatch` with job display names **`App tests and build`** and **`Server agent tests`**.
- **Branch protection on `main` (`gh api repos/keiko233/blossom/branches/main/protection`):**
  - `enforce_admins: true`
  - `required_status_checks.strict: true`
  - Required status check contexts: **`App tests and build`** and **`Server agent tests`**.

**Critical consequence:** Just like `libnyanpasu/clash-nyanpasu` (which solved the exact same `RequireCI` ruleset restriction in `.github/workflows/publish.yml`), GitHub rejects direct `git push` commits to `main` from `GITHUB_TOKEN` (and even admins without passing PR checks). Any automated `publish.yml` committing version bumps and `CHANGELOG.md` updates to `main` **must** use either:
1. A configured **GitHub App bypass actor** (`RELEASE_APP_ID` + `RELEASE_APP_PRIVATE_KEY` secrets) creating the verified commit via GitHub GraphQL `createCommitOnBranch` and tagging via `repos/{owner}/{repo}/git/tags`, **or**
2. When no Release App secret is present (fallback mode), opening a release PR `chore/release-<target>-v<version>` instead of failing with HTTP 403.

### 3.2 `clash-nyanpasu` Alignment & Independent Dual-Semver Design

Align Blossom's `.github/workflows/` with `clash-nyanpasu` standards:

1. **Workflow display naming (`[Category] Action Object`):**
   - `test.yml` → `[CI] Run App and Agent Tests` (keeping job display names **`App tests and build`** and **`Server agent tests`** **identical** so branch protection never breaks!)
   - `publish.yml` → `[Release] Prepare Version and Release`
   - `docker.yml` → `[Release] Build and Publish Container Images`
   - `server-agent-release.yml` → `[Release] Build and Publish Server Agent Binaries`
   - Also adopt `actions.lock` / SHA pinning recommendation for release workflows.
2. **Independent Semver & `publish.yml` (`workflow_dispatch`):**
   - Inputs:
     - `target`: choice (`app` | `server-agent` | `both`)
     - `versionType`: choice (`major` | `minor` | `patch` | `premajor` | `preminor` | `prepatch` | `prerelease`)
     - `preid`: choice (`beta` | `rc`, default `beta`)
   - Versioning mechanics (via a tested `scripts/src/release.ts` script following semver):
     - **`app` target:** Bumps root/app version (`app/package.json` and root `package.json`), generates section in `CHANGELOG.md` via `git-cliff --config cliff.toml` matching `tag_pattern = 'v[0-9].*'`, creates tag `v<version>` and GitHub Release (`draft: false` or auto-published).
     - **`server-agent` target:** Bumps `server-agent/Cargo.toml` and syncs `server-agent/Cargo.lock` (`cargo check --locked` / `cargo update -p server-agent --offline`), generates section in `server-agent/CHANGELOG.md` via `git-cliff --config cliff-agent.toml` matching `tag_pattern = 'server-agent-v[0-9].*'`, creates tag `server-agent-v<version>` and GitHub Release with **`make_latest: false`**.
     - **`both` target:** Bumps and tags both in one atomic commit (or sequentially tagged on the same commit) cleanly.
   - **Pre-release changelog folding (from `clash-nyanpasu`):** Each section in `CHANGELOG.md` records changes since the previous tag (including prereleases), while a stable GitHub Release body folds all changes since the previous stable release (`--ignore-tags 'v.*-.*'`).
3. **Downstream image & binary builds (Decision A3):**
   - Remove `push: branches: [main]` from `docker.yml`.
   - `docker.yml` triggers on:
     - `release: types: [published]` (preferred: guarantees `publish.yml` release notes exist before `latest` moves, or tag pushes `v*` / `server-agent-v*` filtered by tag prefix)
     - `workflow_dispatch` (explicit `targets: app | server-agent | both` input for recovery rebuilds).
   - Tagging matrix:
     - `vX.Y.Z` tag/release builds `ghcr.io/<repo>` (`X.Y.Z`, `X.Y`, `latest` for stable non-prerelease) and *does not* unnecessarily rebuild `server-agent` unless `server-agent-v*` was released (or manual dispatch requested `both`).
     - `server-agent-vX.Y.Z` tag/release triggers both `server-agent-release.yml` (static musl binaries + `SHA256SUMS` uploaded directly to that release) and `docker.yml` building `ghcr.io/<repo>/server-agent` (`X.Y.Z`, `X.Y`, `latest` for stable).

---

## 4. Moving SSL / ACME Certificate Issuance to `server-agent`

### 4.1 Current Limitations (Established)

Inspecting `app/src/lib/certificate-issuance.ts`, `app/src/lib/acme-directory.ts`, and `app/vite.config.ts`:

- `app/` depends on `acme-client@^5.4.0`, `@peculiar/x509@^3.1.0`, and `reflect-metadata@^0.2.2`, plus the custom `tsyringeReflectMetadata()` Vite plugin (`app/vite.config.ts`).
- `acme-directory.ts` explicitly works around Cloudflare Workers HTTP `525` SSL handshake failures against Let's Encrypt's ACME directory (`isLetsEncryptDirectoryTlsFailure`).
- Serverless functions cannot answer **HTTP-01** challenges on the proxy node's IP/port `:80`.
- DNS-01 automation in `certificate-issuance.ts` is hardwired solely to Cloudflare (`CLOUDFLARE_DNS_API_TOKEN` + `CLOUDFLARE_DNS_ZONE_ID` in `app/src/lib/env-schema.ts`).

### 4.2 Target Architecture: Agent-Executed ACME with Brokered Challenge Support

Move ACME order execution and key generation (`instant-acme` + `rcgen` + `x509-parser` on Rust `rustls`) into `server-agent/`, while keeping PostgreSQL (`managed_certificate`, `certificate_material`, `certificate_server`) and `CERTIFICATE_MASTER_KEY` encryption as the single control-plane System of Record:

1. **Issuer selection & policy (`managed_certificate`):**
   - Each ACME certificate policy adds `issuanceMode` (`agent_delegated`, future-proofing vs `imported` / `self_signed`), `issuerServerId` (which `server-agent` executes ACME; defaults to the primary bound server or admin-selected healthy agent), and `challengeType` (`dns-01` | `http-01`).
2. **Protocol & Network Isolation solved:**
   - The designated `server-agent` runs `instant-acme` directly from the proxy server's OS stack using `rustls`, bypassing Cloudflare Workers HTTP 525 errors and regional CA blocks completely.
3. **Challenge solvers:**
   - **HTTP-01 (no DNS credentials required!):** When `challengeType === "http-01"`, the issuing `server-agent` validates port `:80` availability (either via a temporary lightweight `hyper`/Tokio HTTP-01 listener on `[::]:80` / `0.0.0.0:80` during the challenge window or an optional local challenge directory / hook), serves `/.well-known/acme-challenge/<token>`, completes verification, and shuts down the temporary listener.
   - **DNS-01 (Brokered by Control Plane — zero DNS secrets on edge nodes):** Edge proxy servers should *not* hold master Cloudflare/Route53/Aliyun DNS API tokens. Instead, `server-agent` computes the DNS-01 TXT digest locally, sends `acme.dns_present { jobId, fqdn, txtValue }` over its authenticated WebSocket to `app/`, and `app/` creates the TXT record via an extensible `DnsProvider` adapter (starting with existing `CLOUDFLARE_DNS_API_TOKEN` / `CLOUDFLARE_DNS_ZONE_ID`, extendable to multi-account/provider settings later). Once `server-agent` verifies public/authoritative TXT visibility (or configurable settle delay), it notifies the ACME server and finally sends `acme.dns_cleanup`.
4. **Encrypted persistence & multi-server fan-out:**
   - `server-agent` sends the issued fullchain PEM and private key PEM to `app/` via `acme.result` (or authenticated `POST /api/agent/acme/result`).
   - `app/` validates the chain, encrypts the private key with `CERTIFICATE_MASTER_KEY` (`certificate-crypto.ts`), writes a new `generation` row in `certificate_material`, and triggers `config.notify` to all servers binding that certificate — reusing the exact existing stale-safe `certificateServer` deployment & `appliedRevision` acknowledgement loop!
5. **Control-plane cleanup:**
   - Remove `acme-client`, `@peculiar/x509`, `reflect-metadata`, and `tsyringeReflectMetadata()` from `app/package.json` and `app/vite.config.ts`. (Self-signed generation can use lightweight WebCrypto / `@noble/curves` or also execute on agent/WebCrypto without `tsyringe`.)

---

## 5. Admin Web SSH Client (`xterm.js`), One-Click Bootstrap, and Serverless Fallback

### 5.1 Two Terminal Modes: Day-2 Agent PTY vs. Day-0 Ephemeral Web SSH

| Mode | When Used | Transport | Credentials Needed | Serverless Support |
| ---- | --------- | --------- | ------------------ | ------------------ |
| **Agent PTY Terminal** | Whenever `server-agent` is online (`ws-v1` + `pty-v1`) | Browser `xterm.js` ↔ `app/` Admin WS ↔ `RealtimeHub` ↔ `server-agent` outbound WS (`portable-pty`) | **None** (uses existing admin better-auth session + agent bearer token) | **100% supported on Node, Cloudflare DO, and Vercel Fluid (with backplane)** |
| **Ephemeral Web SSH** | Day-0 provisioning before `server-agent` is installed, or disaster recovery if agent is down | Browser `xterm.js` ↔ `app/` Admin WS `/api/admin/ssh/ws` ↔ TCP:22 SSH2 client | Ephemeral `host`, `port`, `username`, `password` OR `privateKey` (+ `passphrase`), optional `hostKeyFingerprint` | **Node Docker: Full.** **Cloudflare Workers: Conditional (`cloudflare:sockets`).** **Vercel / Private IPs: Graceful fallback.** |

### 5.2 Ephemeral Credential Security Contract (Decision A4)

- **Zero persistence:** SSH passwords, private keys, and passphrases are **never** stored in PostgreSQL, Drizzle tables, `localStorage`, URL params, cookies, or `adminAudit` detail JSON.
- **Session-scoped lifetime:** Credentials arrive from the admin modal over HTTPS (`POST` handshake minting a short-lived single-use opaque WebSocket session ticket kept in process/DO memory for ≤30s, or directly inside the authenticated WSS initial control frame), are used once to open the SSH2 transport, and are cleared from JS buffers immediately after authentication completes.
- **Host-key trust:** Return the SSH server's SHA-256 host key fingerprint during handshake (TOFU prompt or compare against optional user-supplied expected fingerprint) before allocating the shell channel.
- **Audit trail:** `adminAudit` records only non-secret session metadata (`ssh.connect`, `ssh.disconnect`, `serverId`, `host`, `port`, `username`, duration).

### 5.3 Serverless TCP:22 Investigation & Graceful Fallback

1. **Node.js (`node-server` Docker / Fly / Railway / Render):** Full support using `ssh2` over Node `net.Socket`.
2. **Cloudflare Workers (`cloudflare:sockets`):**
   - Workers' `import { connect } from "cloudflare:sockets"` permits outbound TCP connections including port `22` (only port `25` is blocked).
   - **Verified limitations:**
     - Up to **6 concurrent connecting sockets** per invocation; active sockets keep a Durable Object **awake (no hibernation)** for the session duration (up to ~15 minutes).
     - Cannot connect directly to Cloudflare-proxied hostnames, `localhost`, or RFC1918 private IPs (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) unless routed via **Cloudflare Workers VPC / Tunnel** bindings.
     - Standard npm `ssh2` relies heavily on Node's `net`, `crypto`, `zlib`, and `events`/`stream` internals; PR 7 must run a dedicated bundle + local `workerd` compatibility spike to verify whether `ssh2` with a `cloudflare:sockets` `Duplex` adapter works cleanly or whether Web SSH should be gated off cleanly on `DEPLOY_TARGET=cloudflare` until a pure WebCrypto/WASM SSH2 client (`russh` WASM / `@aspect-build` / custom) is warranted.
3. **Vercel Functions:** Outbound arbitrary TCP sockets are not supported; `runtimeCapabilities.webSshSupported = false`.

#### Graceful Fallback & One-Click Provisioning

In all targets, the Server Provisioning drawer supports both **Automated SSH Execution** (when `webSshSupported === true`) and **One-Click Copyable Fallback** (always available, highlighted automatically when `webSshSupported === false` or targeting a private NAT host):

- **Short-lived bootstrap endpoint:** Admin clicks **"Generate Install Script"** (valid e.g. 15 minutes, one-time token or freshly rotated `AGENT_TOKEN` shown once).
- **Idempotent bootstrap shell script (`curl -fsSL https://<panel>/api/bootstrap/<token>.sh | sudo sh` or copyable snippet):**
  1. Checks OS/arch (`amd64`/`arm64`) and checks `docker` + `docker compose` (offering an interactive/flagged step to install Docker cleanly via `get.docker.com` if missing).
  2. Writes `/opt/blossom-agent/docker-compose.yml` and `chmod 600 /opt/blossom-agent/.env` with `AGENT_URL=https://<panel>/api` and `AGENT_TOKEN=<token>`.
  3. Runs `docker compose pull && docker compose up -d`.
- When running inside **Web SSH**, clicking **"Install Docker & Deploy Agent"** streams the same vetted non-secret setup script into the visible `xterm.js` session so the admin sees real-time logs, and the UI transitions live to **Connected (WS)** as soon as the new container completes its `hello` handshake.
- **Optional local SSH-WS relay fallback:** For operators on Vercel/Cloudflare who still want in-browser `xterm.js` over SSH to a private/NAT host without opening local terminal windows manually, document/ship a tiny optional local bridge command (`npx @blossom/ssh-relay` or `ssh -tt user@host '...'` copy button) rather than adding fragile crypto polyfills to serverless bundles.
