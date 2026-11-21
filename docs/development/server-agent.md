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

The same Linux collector also serves protocol v2. The default v2 agent
advertises `telemetry-v2` and `telemetry-history-v2`; an explicit legacy agent
keeps `telemetry-v1`. One sampler runs per v2 connection. `live` subscriptions use
the control plane's coalesced interval, while `history` runs on its own
minute-or-longer cadence, including when no admin viewer is connected. A
replaced session starts with no subscriptions.

Network rates are sums of counter deltas across a stable, sorted set of
non-loopback `/proc/net/dev` interfaces, divided by a monotonic elapsed
window. The first observation, a counter reset, an interface-set change, a
failed read, or a non-monotonic/oversized window sends `network: null`; a
changed interface set also changes `scopeKey`. `scopeKey` is
`environment|cgroup|cpulimit|memorylimit|interfaces` with `-` for absent
values, for example `systemd|-|-|-|eth0,eth1`. Sampling and inspection run on
blocking threads behind bounded queues, so config application and traffic
acknowledgements stay responsive. See
[Agent WebSocket v2](agent-ws-v2.md#telemetry).

## Module map

| File                                                                | Responsibility                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main.rs`                                                       | Composition root: module declarations, crate re-exports, and top-level dispatch to `enroll`, `service`, `agent_v2`, or `legacy`.                                                                                                                                                                             |
| `src/cli.rs`                                                        | CLI (`clap`, flags mirrored by `AGENT_*` env vars), `WsProtocol`/`AuthMode`/`ServiceStartup` validation, and capability helpers.                                                                                                                                                                             |
| `src/log_setup.rs`                                                  | Tracing subscriber initialization, `ReloadingFilter`, and log-level mapping helpers.                                                                                                                                                                                                                         |
| `src/legacy.rs`                                                     | Explicit legacy v1/HTTP runtime loop: startup from last-known-good config, config-poll/heartbeat loops, WebSocket v1 event wiring, shared apply/update/PTY/ACME/status helpers, and shutdown.                                                                                                                |
| `src/agent_v2.rs`                                                   | Default protocol v2 core loop: no HTTP agent API, snapshot apply/rollback, status publication, update/ACME/PTY operations, and v2 traffic reporting.                                                                                                                                                         |
| `src/client.rs`                                                     | Wraps the progenitor-generated client; injects the `Authorization: Bearer` token as a sensitive default header.                                                                                                                                                                                              |
| `src/config.rs`                                                     | Fetches the v3 desired state, applies certificate bindings to the base sing-box config, writes candidates, tracks active / last-known-good, reports errors.                                                                                                                                                  |
| `src/ws/codec.rs`                                                   | Frozen v1 JSON frame envelope (`hello`/`welcome`, `ping`/`pong`, `config.*`, `update.*`) and typed message decoding that ignores unknown frames.                                                                                                                                                             |
| `src/ws/ports.rs`                                                   | Narrow `WsTransport`/`WsConnection`/`AgentCommandSink` traits, the bounded outbound queue, and the jittered backoff/fallback policy.                                                                                                                                                                         |
| `src/ws/adapters.rs`                                                | `tokio-tungstenite` transport: `/api/agent/ws` URL derivation, sensitive bearer header, `rustls` (`ring`) TLS.                                                                                                                                                                                               |
| `src/ws/mod.rs`                                                     | Reconnect loop: `hello` on every connect, keepalive ping/pong, proactive reconnect, and HTTP-fallback signalling.                                                                                                                                                                                            |
| `src/ws/v2/`                                                        | Opt-in protocol v2: `serde`-backed codec, subprotocol adapter, bounded snapshot assembler, session state machine, reconnect/backoff, and traffic acknowledgement routing.                                                                                                                                    |
| `src/ws/v2/logs/`                                                   | Session-scoped v2 log binding: bounded tails with resume/gap reporting, cancellable retained search, context lookup, and per-connection reset.                                                                                                                                                               |
| `src/ws/v2/telemetry/`                                              | v2 subscriptions and coalesced sampling: Linux collector reuse, scoped network counter deltas, inspection snapshots, and bounded output queues.                                                                                                                                                              |
| `src/acme/mod.rs`                                                   | Bounded ACME job manager: typed issue/ack dispatch, per-job deadline, duplicate-result replay, and challenge solver wiring.                                                                                                                                                                                  |
| `src/acme/ports.rs`                                                 | Consumer-owned ACME/DNS/challenge ports, redacting secret wrappers, typed error phases, and the order state machine.                                                                                                                                                                                         |
| `src/acme/instant_backend.rs`                                       | `instant-acme` adapter for Let's Encrypt/ZeroSSL, EAB decoding, order/finalize/certificate flow, and cleanup on every exit path.                                                                                                                                                                             |
| `src/acme/solver_http01.rs`                                         | Ephemeral bounded HTTP-01 responder that serves only exact registered challenge tokens.                                                                                                                                                                                                                      |
| `src/acme/solver_dns01.rs`                                          | DNS-01 relay over the agent WebSocket with exact TXT-value acknowledgement matching and cleanup tracking.                                                                                                                                                                                                    |
| `src/oauth/`                                                        | Protected `0600` credential files, the one-shot `enroll` redemption CLI, same-origin validation, and the Better Auth `client_credentials` token cache/refresh loop.                                                                                                                                          |
| `src/pty/`                                                          | Opt-in interactive PTY sessions: `launch.rs` (explicit shell, controlled environment), `session.rs` (`portable-pty` adapter, bounded reader/writer queues, session-wide cleanup), `sys.rs` (Linux account and session lookups), session cap, idle/hard lifetime limits, and incremental UTF-8 output chunks. |
| `src/certificate.rs`                                                | Validated, generation-addressed certificate store under `<state_dir>/certificates/<id>/generation-<n>/`.                                                                                                                                                                                                     |
| `src/process.rs`                                                    | Supervises the sing-box child (`processkit`): stdout/stderr capture into the log buffer and tracing, restart with backoff, graceful replacement, `sing-box check` preflight.                                                                                                                                 |
| `src/service/`                                                      | Opt-in native service lifecycle: `RuntimeService` systemd adapter, fixed service identities and invocation ids, durable trial/commit/rollback/disable journal, signed protected promotion, privileged local control helper and the boot selector/launcher ([handoff](../spec/2026-11-20-admin-networking-workspace/task-04-native-service-lifecycle.md)). |
| `src/metering/`                                                     | Native-only restart-safe metering: accountant counters and outbox batches committed together in one checkpoint keyed by runtime instance, with resume, new-instance and baseline recovery, committed-generation inbound classification, legacy queue import, retention expiry, a resubscribing traffic worker and the generation-to-observation bridge ([handoff](../spec/2026-11-20-admin-networking-workspace/task-05-restart-safe-metering.md)). |
| `src/logs/`                                                         | Bounded in-memory log buffer: tracing capture (`layer.rs`), byte/line/age budgets (`ring.rs`, `model.rs`), known-secret redaction and normalization (`text.rs`), retained search (`search.rs`), and the locked facade (`store.rs`).                                                                          |
| `src/log_policy.rs`                                                 | Bounded local log-level policy: per-source revisions, persisted baseline/deadline, agent tracing-filter reloads, sing-box `log.level` overlays, expiry restoration and retry status.                                                                                                                         |
| `src/stats.rs`                                                      | Hand-written tonic/prost client for sing-box's built-in `api` service (`StartedService.SubscribeConnections`; no `.proto` files, no `tonic-build`).                                                                                                                                                          |
| `src/accountant.rs`                                                 | Pure per-connection accounting state machine that turns connection events into per-user deltas.                                                                                                                                                                                                              |
| `src/traffic.rs`                                                    | Runs the connection stream in the background, accumulates per-user deltas, maps them to subscription/node ids and reports them.                                                                                                                                                                              |
| `src/update.rs`                                                     | Resolves GitHub releases, verifies the published SHA-256 digest, stages atomically replaced agent/sing-box binaries and tracks retry/rollback state.                                                                                                                                                         |
| `build.rs`                                                          | Generates the API client from `openapi/spec.json` and stamps the build id (see below).                                                                                                                                                                                                                       |
| `examples/query_stats.rs`                                           | Manual smoke test that prints the connection stream of a running sing-box >= 1.14.                                                                                                                                                                                                                           |
| `scripts/entrypoint.sh`                                             | Thin-image PID-1 helper: first-start downloads, `/data` layout, signal forwarding and crash rollback.                                                                                                                                                                                                        |
| `tests/mock_control_plane.py`, `scripts/test-managed-tls-docker.sh` | Docker-based end-to-end test of the managed-TLS lifecycle, plus WebSocket push/reconnect, against a mock control plane.                                                                                                                                                                                      |

## Contract with the control plane

- The agent's build-time contract with the app is the OpenAPI document `openapi/spec.json`; at runtime it talks to the app over that API. `build.rs` reads it, rewrites OAS 3.1 nullable `anyOf: [T, {type: "null"}]` into OAS 3.0 `nullable: true` in memory, and runs progenitor to produce `OUT_DIR/codegen.rs`, included by `src/client.rs`. The generated code is never committed. A missing spec fails the build with a message pointing at `pnpm agent:spec`.
- Method names come from the spec's `operationId`s (`get_agent_config_v3`, `agent_heartbeat`, `report_agent_traffic`). Renaming an `operationId` in the app breaks the agent build — that is the intended signal.
- `--url`/`AGENT_URL` must include the `/api` prefix; spec paths are relative to it.
- The agent advertises capabilities in `hello`/heartbeat. An explicit legacy agent keeps `AGENT_CAPABILITIES` in `main.rs` (`config-v3`, `managed-tls-v3`, `certificate-deployments-v1`, `atomic-config-rollback`, `connection-stream-traffic`, `ws-v1`, `telemetry-v1`, `acme-v1`, plus `pty-v1` only when `AGENT_PTY_ENABLED=true`). The default v2 agent advertises `V2_CAPABILITIES` in `agent_v2.rs` (`config-v3`, `managed-tls-v3`, `certificate-deployments-v1`, `atomic-config-rollback`, `connection-stream-traffic`, `acme-v1`, `log-policy-v1`, `ws-v2`, `traffic-v2`, log tail/search, plus `pty-v2` and Linux telemetry when available). Add a capability when the agent gains behaviour the control plane may want to depend on.
- The control plane registers the Task 08 `link_probe.request` / `link_probe.result` frames in
  `@blossom/contracts`. The shipped v2 agent advertises `managed-link-probe-v1`,
  decodes the shared `packages/contracts/fixtures/agent-ws-v2-link-probe.frames.json`
  frames, installs only the loopback ingress/responder routes derived from
  `managed.probeBindings` and the committed config, and reports only a bounded outcome
  plus the source's applied generation. An older agent ignores the unknown frames and
  never answers a probe.
- `desiredRevision` is opaque to the agent: equality and content comparison only. The control plane parses its own sequence prefix back out of the reported `appliedRevision` for the [publish gate](architecture.md#publish-gate).
- The poll and heartbeat intervals come from the control plane per server; `AGENT_INTERVAL` is only the bootstrap value.
- The same polled `agent` object may carry `desiredAgentVersion` and `desiredSingBoxVersion` (`latest` or an exact version). The heartbeat reports the per-binary `updates` state back. The WebSocket channel feeds the same `AgentPolicy` directives without changing the reconciler.

### WebSocket push channel

An explicit legacy agent opens one outbound WebSocket to `<AGENT_URL>/agent/ws` (`https` -> `wss`, `http` -> `ws`) with the same per-server bearer token on the upgrade request. `--ws-enabled` / `AGENT_WS_ENABLED` (default `true`) turns it off; the token is never logged. The wire protocol is the frozen v1 JSON envelope `{ v, id, type, ts, payload }` decoded in `src/ws/codec.rs`. Unknown frame types and the still-reserved `telemetry.*` / `pty.*` channels decode without error so a newer control plane never tears down an older agent.

- `hello` is sent on every connect and reconnect with the current version, build id, capabilities, applied revision, certificate deployments and update state; the control plane answers with `welcome`, whose intervals replace the polled `AgentPolicy` cadence (clamped identically).
- `config.notify` re-fetches the full v3 document and runs the ordinary apply path, so `sing-box check`, `RUNTIME_PROBATION`, last-known-good rollback and certificate handling are unchanged. The agent then sends `config.ack` with the committed revision (or the failure) and its deployments.
- `update.trigger` runs the ordinary update reconciler and streams `update.status` transitions through the status observer. SHA-256 verification and `server-agent.prev` / `sing-box.prev` rollback are untouched.
- Keepalive pings are answered with `pong`; `welcome.reconnectBeforeSeconds` arms a proactive reconnect for serverless targets that cap connection lifetime.
- Reconnect uses 1s -> 2s -> 5s -> 15s -> 30s backoff with jitter. A rejected upgrade (400/403/404/426/501) or a failure streak announces HTTP fallback, and the poll/heartbeat loops plus `TrafficReporter` keep running throughout.

### Protocol v2 (default)

Protocol v2 in `src/agent_v2.rs` is the default for both `--credentials-file` and an explicit static `--token`. `--ws-protocol legacy` / `AGENT_WS_PROTOCOL=legacy` is the explicit compatibility opt-in for the v1 WebSocket plus HTTP poll, heartbeat, and traffic. An existing static-token installation that explicitly disables the WebSocket (`--ws-enabled=false` or `AGENT_WS_ENABLED=false`) and names no protocol still starts in legacy HTTP-only mode for compatibility; it logs an actionable deprecation warning telling the operator to make the legacy selection explicit or re-enable the WebSocket. `--ws-protocol v2` with the WebSocket disabled and OAuth with legacy mode are rejected. The v2 client offers `blossom-agent.v2`, requires the echo before it proceeds, and makes no HTTP agent API calls. Configuration, status, and traffic all travel over that session. A v2 failure keeps the last-known-good sing-box process running and retries the socket; it never downgrades to HTTP.

- A control-plane disable is a **positive, authenticated** signal, not a guessed outage: a current static token or an active OAuth identity mapped to a disabled server receives `409` with `x-blossom-agent-state: disabled`, and an open session receives a v2 `server_disabled` error. Invalid, revoked, expired, pending or client-disabled credentials get an ordinary `401`; the route starts no session, updates no fence, and returns no configuration for the disable response.
- On that signal the core commits a local no-inbound teardown (empty `inbounds`, a direct outbound, the loopback stats service, and the local log overlay) as both active and last-known-good, stops the serving sing-box, and starts the teardown. The persisted `disabled` flag makes every later startup reconstruct that teardown before connecting, so a restart, crash or control-plane outage cannot restore a previously served inbound. A disabled agent does not advertise the teardown under the control plane's identifier namespace (the locally applied `server-disabled` name does not parse as an identifier), so the control plane must send a fresh authoritative enabled snapshot; only its successful probation and commit clear the flag. Ordinary socket, HTTP, network and authentication failures never trigger this path and keep the last-known-good process running.
- Configuration arrives as bounded, ordered, digest-validated snapshots and only the verified body reaches the ordinary compile, preflight, promote, probation, and rollback path. A partial snapshot is discarded on disconnect; a failed identifier (including a refused snapshot) is held briefly so status reconciliation cannot spin on the same request.
- `hello` reports the applied identifier or `null`. `welcome` and `agent.status.ack` carry the authoritative identifier, so a missed `config.notify` is recovered on the next status exchange. Deadlines, liveness, proactive `reconnectBeforeSeconds`, and jittered backoff (about 1 s to 60 s) are handled in `src/ws/v2/link.rs`; no HTTP fallback is attempted.
- Traffic uses the same durable outbox as v1. A report stays on disk until `traffic.ack`; a lost acknowledgement or session resends the identical `reportId` and payload, and the control-plane ledger answers `duplicate`.
- Updates, ACME, PTY, remote log policy, retained log tail/search, and telemetry are served over v2. `update.trigger` and `update.status` use the v1 payloads, while `welcome.updatePolicy` and `agent.status.ack.updatePolicy` still replay the version targets. The v2 `hello` advertises `acme-v1`, `pty-v2` when local PTY sessions are enabled under a non-root account, `log-policy-v1`, `logs-tail-v1`/`logs-search-v1`, and `telemetry-v2`/`telemetry-history-v2` when the sampler is available; it never advertises the v1 PTY, ACME or telemetry capabilities. V1 remains available only through the explicit legacy protocol.
- Telemetry v2 is served on Linux: `telemetry.subscribe` starts or replaces a `live`/`history` cadence, `telemetry.unsubscribe` stops it, `telemetry.inspect` answers with the existing snapshot, and samples carry a `scopeKey` plus counter-derived network rates. Subscriptions belong to one connection and are dropped when it ends.

### Native service lifecycle (opt-in)

`--native-service-control` / `AGENT_NATIVE_SERVICE_CONTROL=true` selects an
externally supervised native runtime instead of processkit. It requires
protocol v2 and a root-owned `blossom-service-control` helper at
`--service-control-socket` (default `/run/blossom-service-control/control.sock`).
The helper is the only writer of the deployment journal and the protected
`releases/` tree, and the only caller of the host systemd manager. The agent
stages downloads and candidate configs; the helper verifies the installer-pinned
signed release manifest and digest before copying bytes into
`releases/<component>/<sha256>/`.

`blossom-agent.service` and `blossom-sing-box.service` each run a privileged
`ExecStartPre=+ ... boot-select` step that consumes a one-shot trial and writes
a root-owned selection under `/run`, then a fixed `boot-exec` launcher that
verifies and executes only that generation. `Disabled` exits 77,
`Unprovisioned` exits 78 and an untrusted selection exits 79; all are listed in
`RestartPreventExitStatus=`. The runtime unit is independent of the agent unit:
there is no `PartOf=` or `BindsTo=`, so an agent restart leaves the serving
runtime running.

The v2 apply path preflights with the committed release binary, stages the
candidate config, records disable/enable intent durably, trials the candidate,
waits probation, commits only while the same invocation serves, and confirms on
the authenticated session. Administrative disable persists native disable
intent before stopping the unit. Log-level overlays and update triggers are not
implemented in this adapter yet and are reported; agent/sing-box binaries in
native mode are promoted through the helper rather than the processkit updater.

The default agent and installer paths are unchanged. The installer opt-in is
`BLOSSOM_NATIVE_SERVICE=1` plus `BLOSSOM_RELEASE_PUBLIC_KEY` (64 lowercase hex
Ed25519 public key bytes); it installs the helper, runtime identity, units,
socket and pinned key, bootstraps the initial generations, and leaves the
existing unit path as the default. Native mode keeps PTY off because the agent
and its shell would share the helper-authorized uid; a separate PTY service
identity is still required before the terminal can be enabled there.

### Agent-executed ACME

The agent advertises `acme-v1`. A job is bounded to 100 unique lowercase DNS
names, one current job per id, at most two running jobs, 15 minutes of execution,
and a fixed provider allowlist (Let's Encrypt production/staging or ZeroSSL
with per-job EAB). It never accepts an arbitrary CA directory URL.

- `http-01` binds a temporary listener (`--acme-http-bind` /
  `AGENT_ACME_HTTP_BIND`, default `0.0.0.0:80`) and serves only the exact
  registered `/.well-known/acme-challenge/<token>` paths. The listener and
  challenge map are dropped when the job ends.
- `dns-01` sends `acme.dns_present` with the exact TXT name/value and waits for
  `acme.dns_ack` for that same value before marking the challenge ready. The
  control plane owns DNS credentials. After validation (or failure) the agent
  sends `acme.dns_cleanup`.
- `acme.result` contains either the fullchain and private-key PEMs or a typed
  error phase. Private keys and EAB HMAC values use redacting/zeroizing wrappers
  and never appear in logs. A duplicate job id replays the cached result until
  the bounded in-memory expiry; a different job id is a separate order.

### OAuth machine identity

`server-agent enroll --url ... --grant-file ... --credentials-file ...` reads a
one-line `egr_...` grant from a regular file owned by the effective user with
mode `0600`, makes exactly one same-origin
`POST /api/enrollment/redeem`, validates the bounded response, and writes it
verbatim through an atomic `0600` replace. There is no retry and no output that
contains the grant or the client secret.

At service start, `--credentials-file` selects protocol v2 automatically. The
provider checks the file's owner and mode again, enforces the configured
origin for `tokenEndpoint`, `issuer` and `resource`, and requests
`client_credentials` tokens with the credential's `resource` and
`blossom:agent:connect`. A token is refreshed before its advertised lifetime
ends; the session reconnects at that deadline and the retry ladder is bounded.
A still-valid cached token covers a transient token-endpoint failure, while the
last-known-good sing-box process keeps running. A content change in the
credential file rotates the identity on the next refresh.

`--token` is an explicit static backup mode. It also defaults to v2; pass
`--ws-protocol legacy` only for an installation that needs the v1 transport.
It is refused together with `--credentials-file`. OAuth mode never downgrades
to a static token or the HTTP agent API, and v2 never downgrades to HTTP. The
client secret and current access token are registered in the `OAuth`
log-redaction scope before use; replaced secrets stay masked.

### Interactive terminal (opt-in)

The admin terminal is disabled unless the agent starts with `--pty-enabled` / `AGENT_PTY_ENABLED=true`; only then does the default v2 `hello` advertise `pty-v2` (an explicit legacy agent advertises `pty-v1`). The agent refuses to enable it while running as root, because the shell would then be root. The control plane sends `pty.open`, `pty.data`, `pty.resize` and `pty.close` over the same authenticated socket. The agent answers `pty.open` with `pty.started` (shell path and account) once the shell exists, or with `pty.exit` carrying a typed reason and a sanitized `detail`, then streams bounded `pty.data` chunks.

- At most `AGENT_PTY_MAX_SESSIONS` (default 1, hard cap 4) sessions exist. `AGENT_PTY_IDLE_TIMEOUT_SECONDS` defaults to 300 and is clamped to 30–3600; `AGENT_PTY_MAX_SESSION_SECONDS` defaults to 1800 and is clamped to 60–86400, so a continuously active shell still has a hard lifetime bound.
- The shell is `AGENT_PTY_SHELL` (an absolute path) when set, and otherwise the first runnable of `/bin/bash` then `/bin/sh`. An explicit path is authoritative: a broken setting fails the session instead of silently starting another shell. The shell starts with `-i` in `AGENT_PTY_WORKING_DIR` (default `/`). Startup checks run in order: working directory, shell executable, PTY allocation, spawn. The failures map to `shell_unavailable`, `pty_unavailable` and `spawn_failed`.
- The shell environment is rebuilt from an allowlist: `TERM`, `COLORTERM`, a fixed `PATH`, `SHELL`, `USER`/`LOGNAME`, `HOME`, and `LANG`/`LC_*`/`TZ` when set. `AGENT_*`, `GITHUB_TOKEN` and anything else in the agent's environment are not inherited.
- Closing the session, the shell exiting, or the PTY manager being dropped SIGKILLs every process in the shell's session on Linux (found through `/proc`), so background jobs do not outlive the terminal. Other platforms signal only the shell process.
- The control plane's relays re-check the admin session, its admin role, the server and the agent connection every 30 seconds and close the shell with `authorization_revoked` on failure. The Cloudflare Durable Object re-checks from a storage alarm, so it also runs while the object hibernates; the agent's idle and hard limits still bound a shell whose relay is gone. The browser's status probe (`GET /api/admin/servers/$id/pty/status`) distinguishes denied, disabled, offline and unsupported before it opens a socket.
- `cols`/`rows` are clamped to 20–400 × 5–200. Session ids must be 1–128 ASCII alphanumerics, `-` or `_`.
- Reader, waiter and writer work runs on dedicated OS threads, never on Tokio workers. Reader output is bounded by a 64-frame queue; writer input by a 64-write queue of 16 KiB chunks. A full writer queue closes the session with `input_backpressure`; a full outbound WebSocket queue closes it with `output_backpressure` instead of growing memory.
- PTY output is decoded incrementally, so a UTF-8 character split across reads is not corrupted. A shell exit, idle timeout, protocol error or WebSocket drop kills the child and emits `pty.exit` when the socket is still available.

### Local log-level policy

The v2 agent advertises `log-policy-v1` and serves the [remote policy](log-policy.md). `log.policy.snapshot` entries are mapped to the existing `PolicyRequest`/`PolicyAction` API, and `PolicyStatus` is published as a bounded `log.policy.ack`. There is no v1 or HTTP policy path.

- `src/log_policy.rs` persists one record per source (`agent`, `sing-box`) in `<state_dir>/log-policy.json` (mode `0600`). Each record carries a revision scoped to that source, the requested level, the generated or local baseline, the effective level, an optional deadline and the last error.
- Requests accept `error`, `warn`, `info` and `default` as baselines. `debug` and `trace` are temporary only: the default lifetime is 15 minutes and the local maximum is 60 minutes, regardless of a longer control-plane deadline. A baseline request carrying a deadline and a stale revision are rejected.
- Agent levels change a `tracing_subscriber::reload` layer shared by local formatting and the retained `CaptureLayer`, so the buffer, its quotas and its redaction state are never rebuilt. A filter reload failure leaves the previous level effective and records the error.
- Sing-box levels are a local overlay on `log.level` in the compiled candidate. The overlay is applied after certificate bindings and the agent `api` service, and the desired revision and digest are untouched. A log-only change writes a candidate, runs `sing-box check`, promotes and restarts the process, waits through probation and commits to last-known-good; any failure rolls back to the working configuration. The applied revision, node set and publish sequencing do not change.
- Every desired-config compile re-reads the generated `log.level` as the new baseline and reapplies the current overlay, so refreshes, retries and a malformed `log` object converge on the same combined config. Newly received node credentials are registered for retained-log redaction before validation errors can be captured.
- Supervisors call policy maintenance on a local timer even when the control plane is offline. Expired overrides restore the baseline through the same reload path, and a failed restoration keeps the working configuration, reports the requested/effective/error status and retries with a 30-second bound. At startup the persisted state is loaded and the committed and last-known-good configs are rewritten before `start_last_known_good`, so an override never outlives a restart.

The v2 core maps an authenticated `log-policy-v1` entry to `PolicyRequest`, calls `LogPolicy::request_snapshot` (which ignores an already-expired temporary override), then executes the returned `PolicyAction` in its single supervision loop. An agent action calls `LogPolicy::apply_agent`; a sing-box action stages the overlay through the validated reload path and calls `LogPolicy::record` with the outcome. The session publishes changed `PolicyStatus` values as `log.policy.ack`. `welcome` and `agent.status.ack` carry the server-wide policy revision, so a lost push, offline edit or reconnect recovers through `log.policy.get`.

Snapshot entries are idempotent per source revision. A lower revision is ignored, a conflicting level for the same revision is reported, and a temporary request is never extended beyond the local 60-minute cap. Local expiry runs on the supervision timer even while disconnected; the resulting effective baseline is persisted and acknowledged when a session returns. Log policy never changes the applied configuration identifier, node set or publish-gate sequence.

## Safety invariants

These are the behaviours the code and its comments establish. Preserve them when editing; each has unit tests worth extending.

- **Never strand the host.** A candidate config is written, then checked by the target sing-box binary (`sing-box check`), and only then replaces the active config. The previous good config is persisted as last-known-good in `AGENT_STATE_DIR` (the container uses `/data/state`; a bare run defaults to `/var/lib/blossom-agent`) and used for rollback and for startup after a restart. A new process must survive a probation period (`RUNTIME_PROBATION`) before the candidate is committed.
- **Do not trust the base config for certificates.** Bindings are matched by exact `inboundTag`, artifacts by exact `certificateId` + `generation`, and only local `certificate_path`/`key_path` are injected. Inline material or control-plane paths in the base config are never trusted.
- **Validate before staging.** Certificate artifacts are checked (PEM chain, key, key-pair match, SANs, validity, fingerprint), line endings are normalised, and files are written atomically with `0600`/`0700` permissions. Generations are never garbage-collected by the agent.
- **Report honestly.** `installed` is reported once material is staged and validated; `inUse` only after the candidate has been committed.
- **Self-heal.** An equal `desiredRevision` is skipped only while the active config still parses and every referenced generation still validates.
- **Secrets stay out of logs.** The token header is marked sensitive; keep tokens, keys and full config bodies out of `tracing` output.
- **Retained logs are bounded and redacted.** The in-memory log buffer (`src/logs/`) redacts registered agent credentials (the agent token, the GitHub token and the per-run stats secret), `Bearer` tokens, whole PEM private-key blocks and the credential fields of every inbound `users` entry before insertion, then applies byte, line and age budgets. The current stats secret and both active and staged-candidate node credentials are registered on startup, fetch, promotion and rollback, and replaced sets stay redacted until the fixed registry bound retires them. A registration that would exceed the bound makes capture fail closed: every later line is stored as `[REDACTED]` rather than left exposed, while the proxy keeps running. Local host logging is unchanged; only the retained buffer is redacted.
- **OAuth credentials need their own registration handoff.** When OAuth machine identity lands, add a dedicated `SecretScope` and register the client secret plus the current access token (and any refresh token) before the first token request or authenticated call, then replace that set on every refresh and rotation. The static-token `Agent` scope is not enough, because its set never rotates. Until then, only the configured static agent token is covered.
- **ACME secrets stay bounded.** The agent accepts only the built-in ACME providers, validates every job/domain/challenge value, never logs or persists the generated private key, and returns it only over the authenticated WebSocket for control-plane encryption.
- **The terminal is opt-in and bounded.** It is off by default, advertises `pty-v2` (or `pty-v1` in explicit legacy mode) only when enabled, never opens a listening port, caps concurrent sessions, and kills every session when the process or WebSocket goes away. Terminal bytes are never written to logs, the database or audit rows.
- **The shell is non-root and environment-scoped.** A root agent keeps PTY disabled even when opted in. The shell never inherits the agent's tokens or unrelated variables, and the identity it runs as is reported to the browser in `pty.started`.
- **Do not trust the base config for traffic collection.** The agent strips `experimental.v2ray_api` and any pre-existing `api` service, then injects its own `api` service bound to `127.0.0.1` on a random free port with a random per-run secret. The injected endpoint lives inside the written configs, so a restart of the same agent run stays consistent, and the secret never leaves the process.

## Traffic delivery

The agent subscribes to sing-box's built-in `api` service (`StartedService.SubscribeConnections`, sing-box >= 1.14) and turns connection events into per-user deltas: UPDATE deltas are counted as they arrive, CLOSED events pay `final total − accounted`, and every stream snapshot is reconciled by connection id (known ids contribute only the unaccounted remainder; unknown ids count in full). Deltas are sealed into batches with a stable report ID and stored under `AGENT_STATE_DIR/traffic/pending` before posting. Acknowledged batches are removed; retries and restarts reuse the same ID. The control plane deduplicates IDs per server for 30 days and applies history and quota updates in one statement. Older control planes do not acknowledge IDs and cannot guarantee replay-safe accounting. Legacy agents send no IDs and also lack that guarantee.

This is not unconditional zero-loss accounting. Traffic that arrived after the last snapshot and before a reconnect, or after the last UPDATE before a crash, is lost; a full or unavailable state directory also leaves sealed batches in memory. Pending batches older than seven days are discarded with an error to avoid replaying after the ledger retention window; permanently rejected batches are moved aside. Protect and monitor the state directory, and report these limits rather than claiming exactly-once collection. The stream model shrinks the crash-loss window for in-memory deltas to roughly one stream interval (upstream default 1 s).

The opt-in native service path uses restart-safe metering. `agent_v2.rs` registers the committed generation's inbound classification and stats endpoint, then feeds one `RuntimeObservation` per serving invocation to one `MeteringWorker`. The worker keys one checkpoint and outbox by a task 04 `RuntimeInstance`, commits counters and stable report ids together, imports the legacy `traffic/pending` files under their existing ids, applies the same seven-day retention, and reports an unobservable window for a missing/damaged checkpoint, a replaced runtime, an unattributed period, or a full closed-connection history whose oldest retained closure is newer than the last commit. A new generation is registered before its trial; a serving trial generation without a committed classification, a non-serving runtime, or a stats protocol below the 1.14 floor keeps the worker unattached and logs the window instead of billing it. `RuntimeMeter::apply` filters before the accountant: `Connection.inbound` (field 2 in `StartedService`, present since sing-box 1.13.0 and verified against the pinned 1.14.4 captures) is matched against the committed generation's classification, peer and probe events are dropped, and a subscriber must decode through the `blz.1...` identity codec. A missing or unknown inbound latches the instance as unproven and defers every later commit, so managed metering fails closed rather than charging traffic it cannot classify. `MeteringWorker` final-commits the old meter, recovers the new instance and invalidates the old stream id before subscribing again.

Processkit and the shipped Docker profile keep the existing `TrafficReporter` and `Shared` accumulator. Agent restarts there also restart sing-box, so metering recovery would only ever classify `NewInstance`; the profile therefore keeps its existing durable outbox and does not select the native worker automatically.

Classification comes from the compiled config's inbound tags: `node-<id>` is a subscriber, `peer-in-<id>` is peer infrastructure, and `blossom-agent-<id>` is probe infrastructure. Any other tag rejects the native candidate until its namespace is defined, rather than treating an unknown listener as billable.

## Docker processkit profile

The shipped Docker image and entrypoint keep the **processkit** backend. It supervises exactly one agent-owned sing-box child:

- restarting or upgrading the agent also restarts sing-box and drops live connections;
- there is no external supervisor and no multi-runtime support in this profile;
- replacing the container restarts every process inside it and is a maintenance operation.

Native Linux moves to the independent systemd units from task 04; Docker does not select a different supervisor automatically and does not gain independent runtime restarts. Durable metering still protects reports across the restart, but a dropping connection is visible to clients.

## Binary updates

The thin image contains no agent or sing-box binary. `scripts/entrypoint.sh` creates `/data/{bin,state,downloads}`; on first start it resolves `AGENT_BOOTSTRAP_VERSION` / `AGENT_SING_BOX_BOOTSTRAP_VERSION` (default `latest`) through the GitHub API, downloads `server-agent-linux-<arch>` and the official `sing-box-<version>-linux-<arch>-musl.tar.gz`, verifies the release asset `digest`, and only then moves them into `/data/bin`. Existing binaries are left alone. `AGENT_GITHUB_IPV6` (`prefer` default, `only`, `off`) controls the address family those entrypoint requests use; it does not affect `src/update.rs`.

At runtime `src/update.rs` compares the polled desired versions with the running versions:

- Exact versions are fetched by tag (`v<version>` for both `server-agent` and `sing-box`); `latest` resolves the newest non-draft, non-prerelease release that includes the expected `server-agent-linux-<arch>` asset and is cached for six hours.
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
- `tests/ws_v2_lifecycle.rs` is a process-level, loopback-only test. It runs the built agent with a temporary state directory, a fake sing-box, and a local v2 WebSocket control plane that fails and records any HTTP agent API request. It covers cold apply, exact traffic replay after a lost `traffic.ack`, status reconciliation, failed-apply rollback, offline last-known-good startup, a history sample with no viewer, a live sample with network rates, inspection, and unsubscribed sessions. It runs as part of `cargo test --locked`.
- CI additionally builds the agent image and runs the managed-TLS lifecycle test:

  ```bash
  docker build -f Dockerfile.test --build-arg BUILD_ID=managed-tls-test -t blossom/server-agent:managed-tls-test .
  scripts/test-managed-tls-docker.sh blossom/server-agent:managed-tls-test
  ```

  `Dockerfile.test` is test-only: it builds the agent and downloads the pinned official sing-box, seeding both under `/data/bin`, so the test does not need GitHub at container start. The production `Dockerfile` remains thin. The script needs Docker, `python3` and `curl`, starts a mock control plane on port 18765 (override with `MOCK_PORT`) and a container, and cleans both up on exit. It sets `AGENT_WS_PROTOCOL=legacy` because it exercises the v1 WebSocket and HTTP fallback. The mock serves the agent WebSocket too, so the script also pushes a `config.notify` and asserts `config.ack`, drops the socket to assert a reconnect, and then takes the control plane offline to assert the HTTP fallback still reports. Run it when you change certificate handling, config application, the transport, or the heartbeat/reporting contract; skip it for unrelated edits and say so.

- The pre-commit hook runs `cargo fmt` and `cargo clippy --fix` on staged `.rs` files (see [Workflow](workflow.md#git-hooks)).
- `cargo run` starts a long-running process. It needs a reachable control plane, an agent token and a sing-box binary >= 1.14 (official release binaries include the `api` service used for traffic stats), and it launches and supervises sing-box, which binds the inbound ports the control plane assigns. Its state directory defaults to `/var/lib/blossom-agent`, so pass `--state-dir` (or `AGENT_STATE_DIR`) pointing at a temporary directory when experimenting, point `--url` at a disposable local control plane rather than a production one, and never run it on a host whose real proxy you depend on. The mock control plane used by the Docker lifecycle test is the contained way to exercise the agent end to end. Whether to run any of this is for the task instructions to decide.

## Changing the agent

1. If the change needs a new or changed API field, change the app first ([API, data and auth](api-data-auth.md#agent-api-orpc)), then regenerate the spec ([Generated files](generated-files.md#agent-openapi-spec-and-client)).
2. `cargo build` (or `cargo test`) regenerates the client; fix compile errors at the call sites.
3. Keep behaviour compatible with the control plane versions that may still be deployed. **Recommended**: when the agent starts depending on a new response field, treat its absence as the old behaviour for at least one release rather than failing.
4. Add a unit test next to the code you changed. For anything touching certificate or reload flow, run the Docker lifecycle test above.
5. The production Dockerfile has no Rust or Go build stage. The agent's build id comes from the release workflow (`AGENT_BUILD_ID`), falling back to `local-<short git sha>` or `local`; `Dockerfile.test` uses `BUILD_ID` explicitly.

## Releasing

The server agent shares the control plane's `vX.Y.Z` release line. Follow the [release workflow](workflow.md#ci-and-github-workflows) to prepare the draft and publish it on GitHub.

Release CI verifies that the tag matches the package and Cargo versions. The Agent workflow then runs `cargo test --locked`, `cargo fmt --check`, and `cargo clippy -D warnings`. It builds static musl binaries in `rust:alpine` on native amd64 and arm64 runners and uploads `server-agent-linux-amd64`, `server-agent-linux-arm64`, and `SHA256SUMS` to the published release. Asset names stay stable across versions.

The systemd installer does not resolve GitHub releases at runtime. After
reviewing a published release's `SHA256SUMS`, add its exact version, both
architecture asset URLs and SHA-256 digests to
`app/src/lib/agent-installer-releases.ts`. The entry must declare
`installerContract: 1` and the `oauth-enrollment-cli-v1`,
`credentials-file-v1` and `oauth-ws-v1` capabilities; the installer gate
refuses an unapproved or incompatible release. Host-facing setup and the exact
Rust `enroll`/`--credentials-file` contract are in
[Installing and running the server agent](../operations/server-agent.md#systemd-installation-oauth-enrollment).
