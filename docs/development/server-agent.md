# Server agent (Rust)

`server-agent/` is a standalone crate (edition 2024, no Cargo workspace, not part of the pnpm workspace). One agent runs per physical proxy server. It pulls the server's desired state from the control plane, keeps one sing-box process running to match it, reports its applied revision, and reports per-user traffic. Run all `cargo` commands from inside `server-agent/`.

Statements are **Established** unless marked **Recommended**.

## Linux telemetry

The `telemetry-v1` capability is advertised on Linux. Requests over the
established agent WebSocket read bounded procfs and cgroup data, root filesystem
usage, and, on demand, addresses and bound sockets in the agent's network
namespace. Resource totals reflect the agent's procfs view. The collector
reports visible cgroup quotas separately and cannot determine container host
versus bridge mode from inside all supported deployments. An occupied
configured port is an overlap indicator, since a socket can belong to the
managed sing-box process. Telemetry uses no Docker socket, host mounts or
shell commands.

## Module map

| File               | Responsibility                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.rs`      | CLI (`clap`, flags mirrored by `AGENT_*` env vars), startup from the last-known-good config, the config-poll/heartbeat loops, WebSocket event wiring, shutdown.  |
| `src/client.rs`    | Wraps the progenitor-generated client; injects the `Authorization: Bearer` token as a sensitive default header.                                                  |
| `src/config.rs`    | Fetches the v3 desired state, applies certificate bindings to the base sing-box config, writes candidates, tracks active / last-known-good, reports errors.      |
| `src/ws/codec.rs`  | Frozen v1 JSON frame envelope (`hello`/`welcome`, `ping`/`pong`, `config.*`, `update.*`) and typed message decoding that ignores unknown frames.                  |
| `src/ws/ports.rs`  | Narrow `WsTransport`/`WsConnection`/`AgentCommandSink` traits, the bounded outbound queue, and the jittered backoff/fallback policy.                            |
| `src/ws/adapters.rs` | `tokio-tungstenite` transport: `/api/agent/ws` URL derivation, sensitive bearer header, `rustls` (`ring`) TLS.                                                |
| `src/ws/mod.rs`    | Reconnect loop: `hello` on every connect, keepalive ping/pong, proactive reconnect, and HTTP-fallback signalling.                                               |
| `src/pty/`         | Opt-in interactive PTY sessions: `portable-pty` adapter, bounded reader/writer queues, session cap, idle/hard lifetime limits, and incremental UTF-8 output chunks. |
| `src/certificate.rs` | Validated, generation-addressed certificate store under `<state_dir>/certificates/<id>/generation-<n>/`.                                                      |
| `src/process.rs`   | Supervises the sing-box child (`processkit`): log forwarding, restart with backoff, graceful replacement, `sing-box check` preflight.                            |
| `src/stats.rs`     | Hand-written tonic/prost client for sing-box's built-in `api` service (`StartedService.SubscribeConnections`; no `.proto` files, no `tonic-build`).              |
| `src/accountant.rs` | Pure per-connection accounting state machine that turns connection events into per-user deltas.                                                                 |
| `src/traffic.rs`   | Runs the connection stream in the background, accumulates per-user deltas, maps them to subscription/node ids and reports them.                                  |
| `src/update.rs`    | Resolves GitHub releases, verifies the published SHA-256 digest, stages atomically replaced agent/sing-box binaries and tracks retry/rollback state.             |
| `build.rs`         | Generates the API client from `openapi/spec.json` and stamps the build id (see below).                                                                           |
| `examples/query_stats.rs` | Manual smoke test that prints the connection stream of a running sing-box >= 1.14.                                                                     |
| `scripts/entrypoint.sh` | Thin-image PID-1 helper: first-start downloads, `/data` layout, signal forwarding and crash rollback.                                                       |
| `tests/mock_control_plane.py`, `scripts/test-managed-tls-docker.sh` | Docker-based end-to-end test of the managed-TLS lifecycle, plus WebSocket push/reconnect, against a mock control plane. |

## Contract with the control plane

- The agent's build-time contract with the app is the OpenAPI document `openapi/spec.json`; at runtime it talks to the app over that API. `build.rs` reads it, rewrites OAS 3.1 nullable `anyOf: [T, {type: "null"}]` into OAS 3.0 `nullable: true` in memory, and runs progenitor to produce `OUT_DIR/codegen.rs`, included by `src/client.rs`. The generated code is never committed. A missing spec fails the build with a message pointing at `pnpm agent:spec`.
- Method names come from the spec's `operationId`s (`get_agent_config_v3`, `agent_heartbeat`, `report_agent_traffic`). Renaming an `operationId` in the app breaks the agent build — that is the intended signal.
- `--url`/`AGENT_URL` must include the `/api` prefix; spec paths are relative to it.
- The agent advertises capabilities in its heartbeat (`AGENT_CAPABILITIES` in `main.rs`: `config-v3`, `managed-tls-v3`, `certificate-deployments-v1`, `atomic-config-rollback`, `connection-stream-traffic`, `ws-v1`, plus `pty-v1` only when `AGENT_PTY_ENABLED=true`). Add a capability when the agent gains behaviour the control plane may want to depend on.
- `desiredRevision` is opaque to the agent: equality and content comparison only. The control plane parses its own sequence prefix back out of the reported `appliedRevision` for the [publish gate](architecture.md#publish-gate).
- The poll and heartbeat intervals come from the control plane per server; `AGENT_INTERVAL` is only the bootstrap value.
- The same polled `agent` object may carry `desiredAgentVersion` and `desiredSingBoxVersion` (`latest` or an exact version). The heartbeat reports the per-binary `updates` state back. The WebSocket channel feeds the same `AgentPolicy` directives without changing the reconciler.

### WebSocket push channel

The agent opens one outbound WebSocket to `<AGENT_URL>/agent/ws` (`https` -> `wss`, `http` -> `ws`) with the same per-server bearer token on the upgrade request. `--ws-enabled` / `AGENT_WS_ENABLED` (default `true`) turns it off; the token is never logged. The wire protocol is the frozen v1 JSON envelope `{ v, id, type, ts, payload }` decoded in `src/ws/codec.rs`. Unknown frame types and the reserved `telemetry.*` / `pty.*` / `acme.*` channels decode without error so a newer control plane never tears down an older agent.

- `hello` is sent on every connect and reconnect with the current version, build id, capabilities, applied revision, certificate deployments and update state; the control plane answers with `welcome`, whose intervals replace the polled `AgentPolicy` cadence (clamped identically).
- `config.notify` re-fetches the full v3 document and runs the ordinary apply path, so `sing-box check`, `RUNTIME_PROBATION`, last-known-good rollback and certificate handling are unchanged. The agent then sends `config.ack` with the committed revision (or the failure) and its deployments.
- `update.trigger` runs the ordinary update reconciler and streams `update.status` transitions through the status observer. SHA-256 verification and `server-agent.prev` / `sing-box.prev` rollback are untouched.
- Keepalive pings are answered with `pong`; `welcome.reconnectBeforeSeconds` arms a proactive reconnect for serverless targets that cap connection lifetime.
- Reconnect uses 1s -> 2s -> 5s -> 15s -> 30s backoff with jitter. A rejected upgrade (400/403/404/426/501) or a failure streak announces HTTP fallback, and the poll/heartbeat loops plus `TrafficReporter` keep running throughout.

### Interactive terminal (opt-in)

The admin terminal is disabled unless the agent starts with `--pty-enabled` / `AGENT_PTY_ENABLED=true`; only then does `hello` advertise `pty-v1`. The control plane sends `pty.open`, `pty.data`, `pty.resize` and `pty.close` over the same authenticated socket, and the agent replies with bounded `pty.data` chunks and `pty.exit`.

- At most `AGENT_PTY_MAX_SESSIONS` (default 2, hard cap 4) sessions exist. `AGENT_PTY_IDLE_TIMEOUT_SECONDS` defaults to 900 and is clamped to 30–3600; `AGENT_PTY_MAX_SESSION_SECONDS` defaults to 3600 and is clamped to 60–86400, so a continuously active shell still has a hard lifetime bound.
- `cols`/`rows` are clamped to 20–400 × 5–200. Session ids must be 1–128 ASCII alphanumerics, `-` or `_`.
- Reader, waiter and writer work runs on dedicated OS threads, never on Tokio workers. Reader output is bounded by a 64-frame queue; writer input by a 64-write queue of 16 KiB chunks. A full writer queue closes the session with `input_backpressure`; a full outbound WebSocket queue closes it with `output_backpressure` instead of growing memory.
- PTY output is decoded incrementally, so a UTF-8 character split across reads is not corrupted. A shell exit, idle timeout, protocol error or WebSocket drop kills the child and emits `pty.exit` when the socket is still available.

## Safety invariants

These are the behaviours the code and its comments establish. Preserve them when editing; each has unit tests worth extending.

- **Never strand the host.** A candidate config is written, then checked by the target sing-box binary (`sing-box check`), and only then replaces the active config. The previous good config is persisted as last-known-good in `AGENT_STATE_DIR` (the container uses `/data/state`; a bare run defaults to `/var/lib/blossom-agent`) and used for rollback and for startup after a restart. A new process must survive a probation period (`RUNTIME_PROBATION`) before the candidate is committed.
- **Do not trust the base config for certificates.** Bindings are matched by exact `inboundTag`, artifacts by exact `certificateId` + `generation`, and only local `certificate_path`/`key_path` are injected. Inline material or control-plane paths in the base config are never trusted.
- **Validate before staging.** Certificate artifacts are checked (PEM chain, key, key-pair match, SANs, validity, fingerprint), line endings are normalised, and files are written atomically with `0600`/`0700` permissions. Generations are never garbage-collected by the agent.
- **Report honestly.** `installed` is reported once material is staged and validated; `inUse` only after the candidate has been committed.
- **Self-heal.** An equal `desiredRevision` is skipped only while the active config still parses and every referenced generation still validates.
- **Secrets stay out of logs.** The token header is marked sensitive; keep tokens, keys and full config bodies out of `tracing` output.
- **The terminal is opt-in and bounded.** It is off by default, advertises `pty-v1` only when enabled, never opens a listening port, caps concurrent sessions, and kills every session when the process or WebSocket goes away. Terminal bytes are never written to logs, the database or audit rows.
- **Do not trust the base config for traffic collection.** The agent strips `experimental.v2ray_api` and any pre-existing `api` service, then injects its own `api` service bound to `127.0.0.1` on a random free port with a random per-run secret. The injected endpoint lives inside the written configs, so a restart of the same agent run stays consistent, and the secret never leaves the process.

## Traffic delivery

The agent subscribes to sing-box's built-in `api` service (`StartedService.SubscribeConnections`, sing-box >= 1.14) and turns connection events into per-user deltas: UPDATE deltas are counted as they arrive, CLOSED events pay `final total − accounted`, and every stream snapshot is reconciled by connection id (known ids contribute only the unaccounted remainder; unknown ids count in full). Deltas are sealed into batches with a stable report ID and stored under `AGENT_STATE_DIR/traffic/pending` before posting. Acknowledged batches are removed; retries and restarts reuse the same ID. The control plane deduplicates IDs per server for 30 days and applies history and quota updates in one statement. Older control planes do not acknowledge IDs and cannot guarantee replay-safe accounting. Legacy agents send no IDs and also lack that guarantee.

This is not unconditional zero-loss accounting. Traffic that arrived after the last snapshot and before a reconnect, or after the last UPDATE before a crash, is lost; a full or unavailable state directory also leaves sealed batches in memory. Pending batches older than seven days are discarded with an error to avoid replaying after the ledger retention window; permanently rejected batches are moved aside. Protect and monitor the state directory, and report these limits rather than claiming exactly-once collection. The stream model shrinks the crash-loss window for in-memory deltas to roughly one stream interval (upstream default 1 s).

## Binary updates

The thin image contains no agent or sing-box binary. `scripts/entrypoint.sh` creates `/data/{bin,state,downloads}`; on first start it resolves `AGENT_BOOTSTRAP_VERSION` / `AGENT_SING_BOX_BOOTSTRAP_VERSION` (default `latest`) through the GitHub API, downloads `server-agent-linux-<arch>` and the official `sing-box-<version>-linux-<arch>-musl.tar.gz`, verifies the release asset `digest`, and only then moves them into `/data/bin`. Existing binaries are left alone. `AGENT_GITHUB_IPV6` (`prefer` default, `only`, `off`) controls the address family those entrypoint requests use; it does not affect `src/update.rs`.

At runtime `src/update.rs` compares the polled desired versions with the running versions:

- Exact versions are fetched by tag (`server-agent-v<version>`, `v<version>` for sing-box); `latest` resolves the newest non-draft, non-prerelease release and is cached for six hours.
- Every downloaded asset is checked against the SHA-256 `digest` returned by the GitHub API. There is no unverified fallback.
- sing-box is extracted to `downloads/`, preflighted with `sing-box check` against the active config, installed atomically over `/data/bin/sing-box` (previous kept as `sing-box.prev`), and must survive `RUNTIME_PROBATION`. A failed start restores `sing-box.prev` and the previous process.
- The agent copies itself to `server-agent.prev`, replaces `/data/bin/server-agent`, writes `state/agent-update.json`, and exits with code `75`. The entrypoint restarts it; if the replacement exits three times within two minutes it restores `server-agent.prev`. On startup an unresolved pending marker is turned into a failure record.
- Failed targets are recorded in `state/*-update-failed.json` and retried after `AGENT_UPDATE_RETRY_SECONDS` (default 3600), not on every poll.
- `AGENT_SELF_UPDATE=0` disables replacing the agent binary but leaves control-plane updates of sing-box available. `AGENT_RELEASE_REPO`, `AGENT_SING_BOX_RELEASE_REPO` and `AGENT_GITHUB_API` support forks and mirrors. `AGENT_SEED_DIR` copies prebuilt binaries into an empty `/data/bin` before bootstrap and is used by the test image. `AGENT_GITHUB_IPV6` (`prefer` | `only` | `off`) applies to the entrypoint's bootstrap requests only.

## Checks

These mirror the `server-agent` job in `.github/workflows/test.yml`:

```bash
cd server-agent
cargo test --locked
cargo fmt --all -- --check
cargo clippy --locked --all-targets --all-features -- -D warnings
```

- Unit tests are inline in each module (`#[test]` / `#[tokio::test]`); they need neither sing-box nor a network. `rcgen` (dev-dependency) builds throw-away certificates for the certificate tests.
- CI additionally builds the agent image and runs the managed-TLS lifecycle test:

  ```bash
  docker build -f Dockerfile.test --build-arg BUILD_ID=managed-tls-test -t blossom/server-agent:managed-tls-test .
  scripts/test-managed-tls-docker.sh blossom/server-agent:managed-tls-test
  ```

  `Dockerfile.test` is test-only: it builds the agent and downloads the pinned official sing-box, seeding both under `/data/bin`, so the test does not need GitHub at container start. The production `Dockerfile` remains thin. The script needs Docker, `python3` and `curl`, starts a mock control plane on port 18765 (override with `MOCK_PORT`) and a container, and cleans both up on exit. The mock serves the agent WebSocket too, so the script also pushes a `config.notify` and asserts `config.ack`, drops the socket to assert a reconnect, and then takes the control plane offline to assert the HTTP fallback still reports. Run it when you change certificate handling, config application, the transport, or the heartbeat/reporting contract; skip it for unrelated edits and say so.
- The pre-commit hook runs `cargo fmt` and `cargo clippy --fix` on staged `.rs` files (see [Workflow](workflow.md#git-hooks)).
- `cargo run` starts a long-running process. It needs a reachable control plane, an agent token and a sing-box binary >= 1.14 (official release binaries include the `api` service used for traffic stats), and it launches and supervises sing-box, which binds the inbound ports the control plane assigns. Its state directory defaults to `/var/lib/blossom-agent`, so pass `--state-dir` (or `AGENT_STATE_DIR`) pointing at a temporary directory when experimenting, point `--url` at a disposable local control plane rather than a production one, and never run it on a host whose real proxy you depend on. The mock control plane used by the Docker lifecycle test is the contained way to exercise the agent end to end. Whether to run any of this is for the task instructions to decide.

## Changing the agent

1. If the change needs a new or changed API field, change the app first ([API, data and auth](api-data-auth.md#agent-api-orpc)), then regenerate the spec ([Generated files](generated-files.md#agent-openapi-spec-and-client)).
2. `cargo build` (or `cargo test`) regenerates the client; fix compile errors at the call sites.
3. Keep behaviour compatible with the control plane versions that may still be deployed. **Recommended**: when the agent starts depending on a new response field, treat its absence as the old behaviour for at least one release rather than failing.
4. Add a unit test next to the code you changed. For anything touching certificate or reload flow, run the Docker lifecycle test above.
5. The production Dockerfile has no Rust or Go build stage. The agent's build id comes from the release workflow (`AGENT_BUILD_ID`), falling back to `local-<short git sha>` or `local`; `Dockerfile.test` uses `BUILD_ID` explicitly.

## Releasing

Static binaries are published by `.github/workflows/server-agent-release.yml`, which is separate from the Docker image release in `docker.yml`:

1. Bump `version` in `server-agent/Cargo.toml` (and let `cargo check`/`cargo build` update `Cargo.lock`).
2. Tag and push the tag as `server-agent-vX.Y.Z`; it must match the `Cargo.toml` version or the workflow fails.
3. The workflow runs `cargo test --locked`, `cargo fmt --check` and `cargo clippy -D warnings`, then builds fully static musl binaries per architecture (amd64 on `ubuntu-latest`, arm64 on `ubuntu-24.04-arm`, both inside a `rust:alpine` container like `Dockerfile.test`'s build stage) and publishes a GitHub Release with `server-agent-linux-amd64`, `server-agent-linux-arm64` and a `SHA256SUMS` covering them. Asset names carry no version so `releases/download/<tag>/...` URLs stay stable (`releases/latest/download/...` does not point at these releases); releases are published with `make_latest: false`, and consumers must resolve releases via the `server-agent-v` tag prefix (GitHub API `GET /repos/{owner}/{repo}/releases` filtered by `tag_name`), since this repo also publishes app image `v*` tags that share the `latest` feed.

`workflow_dispatch` runs only build and check; a release is created only from a `server-agent-v*` tag.
