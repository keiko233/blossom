# Blossom real-component integration harness

An end-to-end check that runs the **real** stack on one machine and judges it by what a proxy client experiences, not by a mock control plane or a heartbeat:

```text
 harness (Node) ── admin server functions / auth ──▶ built app (node target) ──▶ disposable PostgreSQL (Docker)
                                                          ▲
                              real Rust agent ── /api/agent/* ──┘
                                   │ supervises
                                   ▼
                        real sing-box (server) ◀── authenticated proxy traffic ── sing-box client (credentials taken from the served subscription)
                                   ▲
                          loopback HTTP origin the harness serves
```

## Run it

From the repository root, after `pnpm install --frozen-lockfile`:

```bash
node scripts/blossom-integration.mjs --check    # report tool availability, start nothing
node scripts/blossom-integration.mjs            # full run: app build, agent build, then the scenario
node --test tests/integration/blossom/lib.test.mjs tests/integration/blossom/harness.test.mjs   # harness unit tests, no Docker or sing-box needed
```

The unit tests start only short-lived `sh`/`sleep` processes and loopback listeners. `harness.test.mjs` also binds `127.0.0.1:8080` for one test (skipped if it is taken).

Options: `--reuse-build` (reuse an existing `app/.output`; the default rebuilds with `pnpm --filter @blossom/app build:node`), `--keep` (leave the temp directory with logs; the container is always removed), `--sing-box <path>`, `--agent-bin <path>` (skip `cargo build --locked`), `--postgres-image <image>` (default `postgres:19-alpine`, or `BLOSSOM_IT_POSTGRES_IMAGE`). The exit code is 0 only if every step passed and cleanup left nothing behind; 2 means preflight failed.

## Prerequisites

| Need                                            | Why                                                                                                                                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js 26+, pnpm, installed workspace          | harness, app build, `db:migrate`                                                                                                                                                        |
| Local Docker daemon (unix socket or named pipe) | disposable PostgreSQL (image is pulled if missing: network access once). Preflight rejects a remote `DOCKER_HOST`/context, because the database is reached on a published loopback port |
| Rust toolchain (`cargo`)                        | builds `server-agent` with `--locked` (not needed with `--agent-bin`)                                                                                                                   |
| `sing-box` built with `with_v2ray_api`          | server and client; traffic accounting needs the tag. `--check` verifies it                                                                                                              |
| `curl`                                          | drives traffic through the client's SOCKS inbound                                                                                                                                       |
| **127.0.0.1:8080 free**                         | the app hard-codes sing-box's stats API there (`V2RAY_API_LISTEN` in `app/src/orpc/proxy/singbox.ts`); the agent cannot be told otherwise. Preflight fails if it is taken               |

## What the scenario covers

1. **Bootstrap** from an empty migrated database: sign up as the first admin and prove a non-admin is rejected.
2. **Provisioning through supported flows** (admin server functions called over HTTP exactly as the browser does): server, vmess node, group, plan, two users, two subscriptions.
3. **Publish gate before any agent exists**: the subscription answers 503 `Retry-After`, not a config describing an unserved node.
4. **Apply wait**: the real agent starts, `sing-box check`s and runs the config; the harness waits for `config_state = applied` with the applied revision caught up, `runtime_state = running`, and a listening port.
5. **Subscription → client**: the Clash YAML is fetched and its vmess proxy is converted to a sing-box outbound, so the credentials under test are the ones the panel issued.
6. **Authenticated traffic**: a client with a random UUID is refused; the real one downloads through the proxy.
7. **Accounting**: a 3 MiB download is reported by the agent from sing-box's v2ray stats and lands in `subscription.traffic_used_bytes` and `traffic_record` (per node and server), within a small overhead bound; the other subscription stays at 0.
8. **Invalid config**: a schema-valid shadowsocks-2022 node with a bad key fails `sing-box check`; the agent reports `rejected` / `SINGBOX_CONFIG_INVALID`, keeps the old process serving, and the subscription does not advertise the node. Deleting the node returns the agent to `applied`.
9. **Rollback**: a node on a port the harness occupies passes `check` but cannot run; the agent reports `apply_failed` and restores the last-known-good config (traffic works again). Deleting the node recovers.
10. **Expiry**: a subscription given a 25 s lifetime works, then the link answers 403 and the proxy refuses the credential after the agent's next apply.
11. **Revoke and restore**: cancelling cuts a user off (link 403, proxy refused); re-activating is held at 503 until the agent applies it, then works.

## Isolation and cleanup

- Secrets (database password, auth secret, certificate key, passwords, agent token) are random per run and kept in memory; log excerpts printed on failure are redacted. With `--keep` the log files in the kept directory are **not** redacted; they hold only this run's throwaway values (the directory is created mode 0700).
- The app, agent and sing-box processes get a minimal environment, not the caller's. `DATABASE_URL` is always set explicitly (so `app/.env.local` cannot redirect `drizzle-kit`) and must point at `127.0.0.1`/`localhost`; the harness asserts that before using it. The app output never reads env files. The `docker` CLI is the one exception: it receives the caller's environment so it can find the daemon, and passes into the container only the two variables named with a bare `-e`.
- Ports are OS-allocated and bound to loopback, except sing-box's own inbound, which the app configures on `[::]` (any interface) for the node port during the run, protected by a random UUID. The compiled server config also names a DNS server (`8.8.8.8`); the scenario only proxies to a loopback IP literal, so no lookup is expected, but this has not been observed with a packet capture.
- State lives in one temp directory (`$TMPDIR/blossom-it-<8 hex>-*`) and one container named `blossom-it-<8 hex>` labelled `blossom-integration`. A lock (`$TMPDIR/blossom-integration.lock`) serialises runs and lets the next run remove leftovers of a crashed one. The lock file is not trusted blindly: a stale run's container is removed only if its name matches the generated pattern and it carries the harness label, and its directory only if it is a direct child of the temp directory with the generated name. A lock directory without `info.json` is treated as a run that is still starting for 30 seconds.
- Cleanup runs on success, failure, `SIGINT` and `SIGTERM` (no new child is started once it begins). It stops only processes this run started: the agent's descendants (the sing-box it launched) are sampled once a second while it runs and are remembered with their start time, so a sing-box orphaned by an agent crash is still reaped and a recycled pid is never signalled. It then verifies that no container, directory, lock or tracked process remains; any leftover is reported and makes the exit code 1.
- It writes `app/.output` and `server-agent/target` (both git-ignored). `pnpm build:node` regenerates generated files such as the route tree and Paraglide output; if those were stale, `git status` will show them afterwards.

## Verification status

Checked by reading the current sources (commit `20068a0` plus this directory): the agent flags and env names in `server-agent/src/main.rs`; the agent error codes and `config_state` values (`rejected`, `apply_failed`, phase `preflight`); the admin server functions' names, input schemas and result shapes in `app/src/query/` and `app/src/orpc/proxy/schema.ts` / `packages/contracts`; `ensureAdmin` messages (`Unauthorized`/`Forbidden`); the subscription route's 404/403/503 + `Retry-After: 30` behaviour and `Subscription-Userinfo`; traffic accounting (`traffic_used_bytes` = up + down, one history row per report); the hard-coded stats API address; `drizzle.config.ts` not overriding an explicit `DATABASE_URL`; and that no app code loads dotenv files.

**Not yet observed:** when this directory was last reviewed the CLI would not run `node`, `docker` or `cargo`, so neither the unit tests nor the end-to-end scenario were executed by the reviewer. Treat the first real run as the real verification. Assumptions most likely to need adjustment on that run: the production wire format and error text of server functions (`x-tsr-serverFn`, seroval envelope, `Forbidden` surviving in the response), the 25 s expiry window against the 5 s poll, which of `SINGBOX_START_FAILED`/`SINGBOX_HEALTH_CHECK_FAILED` the port conflict yields (both are accepted), whether sing-box rejects the placeholder shadowsocks-2022 key at `check` time, and the `postgres:19-alpine` + `--tmpfs /var/lib/postgresql` combination.

## Not covered (be explicit when reporting)

- Only one protocol, plain-TCP vmess. TLS/Reality and managed certificates are not exercised (see `server-agent/scripts/test-managed-tls-docker.sh`).
- Only the node build target on one OS; Cloudflare/Hyperdrive, Neon HTTP, Netlify and Vercel runtimes are not exercised.
- Some assertions read the database directly.
- The host sing-box is whatever is on the machine; the agent's Docker image builds its own.
- Not wired into CI or `package.json`: it needs Docker, a Rust build and sing-box, and takes minutes.
- The single-agent scenario does not cover a browser UI, email, OAuth/MCP or certificate issuance. Multi-server behaviour is covered only by the two-agent canary section below, and only when its prerequisites are present.

## Two-agent canary

Task 10 of the [networking workspace plan](../../../docs/spec/2026-11-20-admin-networking-workspace/implementation-plan.md) runs two real agents over one disposable control plane:

```text
subscriber ──▶ A: subscriber inbound ── peer link ──▶ B: peer inbound ── direct ──▶ loopback origin
```

A is the only exported entrance. B owns the peer listener and the egress. The harness provisions both servers and the link through the same admin server functions the browser uses, starts each agent with its own state directory, HOME, log and token, and records each judge observation in `canary-evidence.json` (mode 0600, secrets redacted).

```bash
node scripts/blossom-canary.mjs --check [--sing-box <path>] [--agent-bin <path>]
node scripts/blossom-canary.mjs [--keep] [--reuse-build] [--systemd-vm <name>] [--recovery-kind failure|abort]
node --test tests/integration/blossom/canary.test.mjs tests/integration/blossom/canary-harness.test.mjs
```

`--check` prints facts, every missing prerequisite and which evidence it blocks; it exits 2 while a core prerequisite is missing. A live run exits 0 only when every evidence item passed, 1 when a judge failed or cleanup left something behind, 2 when a core prerequisite or the initial setup failed, and 3 when evidence is blocked or not run. It never reports a blocked prerequisite as a pass.

| Prerequisite                 | Scope   | Detected by                                                                                                                                                                                     |
| ---------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base-harness`               | core    | the single-agent harness preflight above                                                                                                                                                        |
| `pinned-sing-box`            | core    | `sing-box version` equals `SING_BOX_VERSION` in `server-agent/Dockerfile.test`; the legacy `with_v2ray_api` tag is not required because the agent owns the loopback `api` service               |
| `agent-link-probe-transport` | core    | `managed-link-probe-v1` in the agent's `V2_CAPABILITIES` and `link_probe.request` used outside `server-agent/src/probe/` (static indicator; the live run must read `server.agent_capabilities`) |
| `managed-probe-bindings`     | core    | the managed snapshot compiler emits `probeBindings` for sender links, so the Rust executor can derive its loopback ingress and fixed responder                                                  |
| `apply-ingress`              | core    | an audited admin Apply creates a rollout, or `--apply-fn <file>#<export>` names the separately landed integration                                                                               |
| `activation-enabled`         | core    | `MANAGED_NETWORKING_ACTIVATION_ENABLED` is `true`; use a disposable canary build                                                                                      |
| `docker-agent-profile`       | profile | local Docker daemon for the processkit profile (`server-agent/scripts/test-managed-tls-docker.sh`)                                                                                              |
| `systemd-disposable-vm`      | profile | an explicit `--systemd-vm`; this host's systemd is never used, and the fake-systemd sandbox (`app/src/lib/agent-installer-e2e.test.ts`) is the only local coverage                              |

The shared single-agent preflight still mentions the legacy `with_v2ray_api` tag and a hard-coded 8080; `CanaryHarness` filters only those two stale checks because the current agent injects its own loopback `api` service on an OS-allocated port. All other Harness prerequisites still apply.

The evidence and its pass criteria live in `lib/canary.mjs` (`CANARY_EVIDENCE` and the `judge*` functions): receiver-first stage proof, isolated A-to-B relay, export of A only, single billing at A, failed and aborted recovery, live revocation while recovering, the downgrade gate, and the Docker and systemd profiles. Each agent gets its own state directory, HOME, log and token (`canaryAgentLayout`, `canaryAgentLaunch`). The relay judge refuses to pass when A and B share an egress address, so B needs a distinct egress (a container or network-namespace profile) for the origin to tell relay from direct.

### Running after the integration lands

1. Use a disposable checkout and database. Never point the canary at a deployed app or a host whose services you depend on.
2. Run `node scripts/blossom-canary.mjs` in that disposable checkout with the default activation setting.
3. If task 09 uses another export name, pass `--apply-fn <file>#<export>`; abort/retry default to the existing audited functions and `--drain-fn` is required before the downgrade gate can pass a drain. The driver expects an apply result with `{ ok: true, rolloutId }` and a refusal with `{ ok: false, reason }`; it does not write rollout rows itself.
   The failure and abort recovery variants each run their own disposable topology; use `--recovery-kind abort` for the second pass. A combined report is not synthesized from two runs.

4. Inspect `canary-evidence.json` in the printed work directory (or the kept directory with `--keep`). With `--keep` the log files are not redacted; they contain only that run's throwaway values and the directory is mode 0700.

The current blocked stages at this base are listed in the [task 10 handoff](../../../docs/spec/2026-11-20-admin-networking-workspace/task-10-canary-handoff.md): task 08's Rust probe transport and compiler bindings, task 09's Apply ingress, the activation gate, and the profile verification. The live runner is implemented, but those dependencies were not present in this checkout, so no live evidence is claimed here.
