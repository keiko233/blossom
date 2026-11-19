# Agent WebSocket protocol v2

Statements are **Established** when the control plane implements them. The Rust client implements v2 behind the explicit `--ws-protocol v2` / `AGENT_WS_PROTOCOL=v2` selection; `legacy` remains the default and keeps the v1 WebSocket with HTTP config polling, heartbeat, and traffic. The machine-checked contract is `packages/contracts/src/agent-ws-v2.ts`; the wire examples the Rust client reproduces are `packages/contracts/fixtures/agent-ws-v2.frames.json`, which `packages/contracts/src/agent-ws-v2.test.ts` validates on the control-plane side and `server-agent/src/ws/v2/codec.rs` decodes in tests.

## Negotiation

- **Established.** The client offers `Sec-WebSocket-Protocol: blossom-agent.v2` on `GET /api/agent/ws`. The route authenticates the bearer token first, then negotiates.
- A client that offers no subprotocol speaks **v1** (`packages/contracts/src/agent-ws.ts`), unchanged.
- A client that offers only unknown subprotocols receives `400 Unsupported agent WebSocket subprotocol` before the upgrade.
- The control plane echoes `blossom-agent.v2` on the upgrade response. A client that required the subprotocol and did not receive it must not proceed.
- Authentication failures stay `401`, and a non-upgrade request stays `426`.

## Envelope

Every v2 text frame is `{"v":2,"id"?:string,"type":string,"ts":RFC3339,"payload":object}`.

- `v` must be `2`. A different version is an unsupported-version error, not a parse fallback.
- `ts` is required in v2. `id` is an optional correlation id that a reply echoes when it has one (`agent.status.ack` and `welcome` echo the `hello` or `agent.status` id).
- The receiver validates direction first. A control-plane type sent by the agent (or the reverse) is rejected with `invalid_direction`. Unknown types are ignored for forward compatibility.
- A frame over 4 MiB (`maxFrameBytes`) is rejected with `frame_too_large`.

## Handshake and session lifecycle

1. The agent upgrades with the v2 subprotocol.
2. The agent sends `hello` **first**. Any other frame before `welcome` is rejected with `invalid_payload`. `hello` carries the applied configuration identifier, or `null` when the cache is empty.
3. The control plane starts a session. It writes a new `ws_session_id` and marks the transport `ws` in one statement, so an older session can no longer write. That statement also requires the credential that authenticated the upgrade to still be the server's; if it has been rotated since, the session does not start (see [Known limits](#known-limits-of-the-control-plane)). It replies with `welcome`, which carries `sessionId`, the desired configuration identifier, the update policy, the status interval, the optional `reconnectBeforeSeconds` (set on Vercel), and the limits.
4. The agent compares its applied identifier with `welcome.desired`. A mismatch or an empty cache sends `config.get`.
5. Pushes (`config.notify`) reach a session only after `welcome`.
6. On close, the control plane ends the session by its fence. A replaced session cannot clear its successor's marker.

There is no application-level heartbeat. Use WebSocket ping and pong to detect half-open connections. `agent.status` runs at `welcome.statusIntervalSeconds` (30 by default) and on significant change.

### Errors and close

- `error` frames (control plane to agent) carry `code`: `invalid_direction`, `invalid_payload`, `frame_too_large`, `server_disabled`, or `session_replaced`.
- `session_replaced` and `server_disabled` close the socket with code `4000` and the same code as the reason. Treat both as terminal for this session. `session_replaced` means a newer session exists, so reconnect and handshake again. `server_disabled` means the server is disabled, so back off and do not retry in a tight loop.
- Otherwise, reconnect with exponential backoff and jitter, starting at about 1 s and capped at 60 s. Repeat the handshake and reconciliation after every reconnect. On Vercel, reconnect before `reconnectBeforeSeconds`.

## Desired-state synchronization

| Frame | Direction | Notes |
| --- | --- | --- |
| `config.get` `{requestId, reason}` | agent to control plane | `reason` is `initial`, `mismatch`, or `notify`. A newer request supersedes an older one that has not been sent yet. |
| `config.snapshot.begin` `{requestId, desired, contentType, totalBytes, chunkCount, digest}` | control plane to agent | `desired` names the version actually compiled, which may differ from a notification. `digest` is the lowercase SHA-256 of the complete body bytes. |
| `config.snapshot.chunk` `{requestId, index, data}` | control plane to agent | Chunks arrive in order. `data` is standard base64 of at most 64 KiB raw bytes. |
| `config.snapshot.end` `{requestId}` | control plane to agent | The agent verifies `chunkCount`, `totalBytes`, and `digest`, then validates the complete body before it applies anything. |
| `config.snapshot.error` `{requestId, code, message}` | control plane to agent | `snapshot_too_large` means the compiled configuration exceeds the limit. The agent keeps its applied configuration and reports the refusal. |
| `config.ack` `{requestId?, desired, outcome, stage?, error?}` | agent to control plane | `applied` names what was applied, after validation, durable storage, and sing-box application. `failed` names the stage (`receive`, `validate`, `store`, or `apply`). A failed ack never moves the applied identifier. |

The body is the HTTP `GET /agent/config/v3` document, byte for byte. A JSON `apiVersion: 3` object with `desiredRevision` equal to the identifier that `begin` advertises.

Discard a partial snapshot on disconnect and request a new one after reconnect. A chunk for an unknown `requestId`, an out-of-order index, or a digest mismatch is a local failure, not an applied configuration.

### Identifiers

- `desired.desiredRevisionSeq` is the publish-gate sequence. `desired.desiredRevision` is `"<seq>:sha256:<hex>"` and must begin with that same sequence.
- A version-target change travels in `welcome.updatePolicy` and `agent.status.ack.updatePolicy`. It does not change the configuration identifier, so it does not cause a configuration transfer.

## Status

- `agent.status` `{reason, runtimeState?, configState?, singBoxVersion?, activeNodeIds?, error?, certificateDeployments, updates?}` reports only the fields present. `error: null` clears the last error.
- `agent.status.ack` `{desired, updatePolicy}` carries the control plane's identifier. If it differs from the applied identifier, send `config.get`. This is how a lost `config.notify` is recovered. The identifier is authoritative within the bounds in [Known limits](#known-limits-of-the-control-plane): a change that no path signalled is reflected at the first status exchange after the cached identifier's deadline.

## Traffic

- `traffic.report` `{reportId, windowStartedAt?, windowEndedAt?, entries}` has the same entries and dedupe key as the v1 HTTP report. `reportId` is **required** in v2 and matches `[A-Za-z0-9._-]{8,128}`.
- `traffic.ack` `{reportId, result, accepted?, dropped?, error?}` is sent only after the durable write commits.
  - `applied`: recorded now.
  - `duplicate`: recorded earlier. The counts are the original ones. Treat it as success.
  - `conflict`: the same `reportId` was already used with different content. The report was not applied. Surface the error and drop the batch.
- **Absence of `traffic.ack` proves nothing.** A report that was replaced before its write does not commit. But a write can commit and its acknowledgement can be lost, on a dropped socket or a replaced session, so the agent cannot tell from a missing ack whether the rows exist. Keep the report on disk and resend the **same** `reportId` and payload on the next session until a `traffic.ack` arrives. The ledger deduplicates the replay and answers `duplicate` with the original counts.
- Keep the report queue on disk until its `traffic.ack` arrives. Traffic collection must not wait on the socket.

## Telemetry

Telemetry additions are additive to v2; v1 `telemetry.*` frames are unchanged.
An agent advertises `telemetry-v2` for live samples and
`telemetry-history-v2` for the independent history cadence. An agent may
advertise neither, either or both. The control plane subscribes only when the
matching capability is present.

| Frame | Direction | Notes |
| --- | --- | --- |
| `telemetry.subscribe` `{subscriptionId, purpose, intervalMs}` | control plane to agent | `purpose` is `live` or `history`; `intervalMs` is 1000–300000. The control plane uses 2000 for a coalesced live stream and 60000 for history. |
| `telemetry.unsubscribe` `{subscriptionId}` | control plane to agent | Sent when the last admin viewer of a live stream leaves, or on replacement. |
| `telemetry.inspect` `{requestId}` | control plane to agent | Requests the existing listener/interface snapshot. |
| `telemetry.sample` `{subscriptionId?, purpose, sampledAt, cpuPercent, memory, disk, environment, networkScope, cgroupVersion, cpuLimit, memoryLimit, scopeKey, network?}` | agent to control plane | `network` is `{txBytesPerSecond, rxBytesPerSecond, windowMs}` or null. |
| `telemetry.snapshot` | agent to control plane | Same payload as the v1 inspection snapshot. |

- **Established.** Live v2 samples feed the same-origin admin WebSocket, which
  coalesces one sampler per server/session across viewers. They are not stored.
- **Established.** On `hello` with `telemetry-history-v2`, the control plane
  sends the history subscription itself, before any browser connects. The
  receipt minute is the bucket key and the write is conditional on the exact
  v2 `sessionId` still matching `server.ws_session_id`, in the same SQL
  statement as the upsert. A replaced or disabled session cannot write.
- **Established.** `scopeKey` is the canonical identity of the measurement
  denominator and network interface set. The control plane stores and charts
  by it; a changed key breaks the series instead of joining incomparable
  values. A missing measurement is null and becomes a gap.
- **Established.** The Rust agent computes network rates from counter deltas
  across a stable, non-loopback interface set, using monotonic elapsed time.
  The first observation, a restart, a counter reset or an unreadable counter
  sends `network: null`; a changed interface set also changes `scopeKey` so
  incomparable series are not joined.
- **Established.** Live and history frames never carry certificate material,
  terminal bytes or log contents.

The machine-checked frames are in
`packages/contracts/fixtures/agent-ws-v2.frames.json`. They include a live
subscription and sample with network rates, a history subscription and sample
with a missing network reading, unsubscribe, inspect and snapshot. The Rust
client must reproduce those frames byte-for-byte after JSON parsing.

### Rust agent implementation

The production Rust agent implements this surface behind `--ws-protocol v2`:

1. A Linux v2 `hello` advertises `telemetry-v2` and `telemetry-history-v2`;
   non-Linux builds and v1 sessions do not.
2. `src/ws/v2/telemetry/` decodes the three control-plane frames and keeps
   subscriptions in per-session state. A new subscription with the same id
   replaces the cadence; unsubscribe stops future sends; a replaced session
   starts empty.
3. Live samples follow `intervalMs` and carry the same `subscriptionId`.
   History is sampled independently on at least a 60-second cadence, so it
   continues with no browser and does not depend on live subscriptions.
4. One sampler serves every subscription due on the same tick, reusing the v1
   `environment`, cgroup version/limit, `/proc` and inspection collection.
   Blocking reads run behind bounded queues so config and traffic stay
   responsive.
5. Network rates sum counter deltas over the stable interface set with a
   monotonic `windowMs`; initial, reset, read-failure and window
   discontinuities send null. `scopeKey` is built from environment, cgroup
   version, limits and the sorted interface set, e.g.
   `systemd|-|-|-|eth0,eth1`.
6. `telemetry.inspect` returns the existing snapshot with the same `requestId`;
   no snapshot is sent unsolicited.
7. Outbound telemetry is checked against the negotiated `maxFrameBytes`; an
   oversized sample or snapshot is dropped instead of closing the session.

The fixtures pin the JSON shape. The Rust codec decodes them directly, and
the process-level lifecycle test exercises live, history (before a viewer),
network rates, inspection and unsubscribe.

## Not in v2 yet

These remain v1-only and are never sent to v2 sessions:

- `update.trigger` and `update.status`, and the `acme.*` messages. The control plane does not push them to v2 sessions.
- `pty.*` and the log policy messages. Telemetry is available only through the
  separate v2 capability described above.

Until the PTY moves to v2, a v2 agent **must not advertise `pty-v1`** in `hello.capabilities`. The admin terminal would otherwise offer a session that cannot start.

## Limits

| Limit | Value | Notes |
| --- | --- | --- |
| `maxFrameBytes` | 4 MiB | Enforced on both sides. |
| `snapshotChunkBytes` | 64 KiB raw | Base64 expands this by about a third. |
| `maxSnapshotBytes` | 8 MiB | Provisional. Raise it only after measuring real compiled sizes, including certificate artifacts, on each deploy target. |

The control plane advertises these values in `welcome.limits`. The agent must enforce the values it received.

## Known limits of the control plane

### Configuration identifier

The identifier is compiled from every input of the v3 document. The control plane reuses a cached identifier only while three things hold: its sequence still equals `desiredRevisionSeq`, no invalidation has reset it, and its deadline has not passed. Otherwise it recompiles from the current state and caches the result, together with the inputs version and the sequence it was compiled from. A cache write is refused if either has moved since the compile read them, so a compile that raced a change, possibly on another instance, cannot store a stale identifier.

The inputs, and how each one reaches the identifier:

| Input | Changed by | How the identifier learns of it |
| --- | --- | --- |
| Server enabled state, node set and node settings, node credentials, subscription plan, status and expiry, group membership, user ban | Publish-gate mutations (`recordConfigChange`) | The sequence moves, so the cache no longer matches. Change notifications also invalidate. |
| Routing rules | `app/src/query/rules.ts` | Each edit invalidates every server. |
| Certificate material, active version, bindings | Import, replace, activate and discard (`withCertificateTransaction` in `app/src/query/certificates.ts`), and each issued install (`persistMaterial` in `app/src/lib/certificate-issuance.ts`) | Invalidated after the change commits, never before, so a concurrent compile cannot cache the old state under the new version. |
| Subscription expiry | The clock | The deadline is the earliest expiry among the compiled subscriptions. |
| Temporary user-ban expiry | The clock | Bounded by the maximum cache age (below). The ban expiry is not part of the deadline. |
| Traffic quota exhaustion | Traffic reports | Bounded by the maximum cache age. A report does not invalidate. |
| Certificate creation, renewal, deletion and DNS challenge steps | `app/src/query/certificates.ts` | No direct invalidation. They change no compiled input until an install, which invalidates. |
| Desired agent and sing-box versions, poll and heartbeat intervals, server name and address | Admin edits | Not in the identifier. Versions reach the agent through `updatePolicy`. Intervals in the document body and in `welcome` take effect at the next handshake. |

Two bounds apply to anything the table does not cover, and to changes whose notification was lost. **The maximum cache age is 120 seconds** (`AGENT_DESIRED_CONFIG_MAX_AGE_MS` in `app/src/orpc/proxy/agent-desired-state.ts`), so an unsignalled change is reflected at the first status exchange after that. The deadline also caps at the earliest subscription expiry. Notifications make the update faster and are not needed for correctness. A status exchange within the deadline costs a read and no compile.

### Token rotation and disablement

- **Rotation.** Regenerating a server's static agent token replaces the hash and clears `ws_session_id` in one statement (`rotateAgentCredential` in `app/src/query/agent.ts`). The rotated session's fenced writes then match nothing, its `config.get` reads nothing and sends no snapshot, and it stops with `session_replaced` (close 4000) at its next frame. Its reconnect is refused with `401`, because the old token no longer matches.
- **Rotation during a handshake.** A token that changes between authentication and the session start is refused. Cloudflare returns `401` before the upgrade. On Node the upgrade is accepted and then closed with `1008` (`credential changed`), before any frame is handled.
- **Bound.** The control plane sends no proactive close on rotation. The old socket stops at the agent's next frame, which is at most one status interval (`statusIntervalSeconds`, 30 seconds by default). Until then it can still receive `config.notify` pushes, which carry identifiers and a reason label, but no configuration.
- **Disablement.** Disabling a server does not clear the fence. The session stops with `server_disabled` (close 4000) at its next status or `config.get`. Pushes reach it until then, and carry the same identifiers and reason label.
- **v1.** Static token rotation and disablement of v1 WebSocket sessions are unchanged. v1 writes are not fenced, and a v1 agent's HTTP config poll is refused once the token has rotated.

### Vercel

The control plane advertises `reconnectBeforeSeconds`. Remote delivery across instances uses Redis when configured, which is best effort. Reconciliation on the next status exchange recovers any lost push.

## Verification status

Each target is listed separately. "Not run" means the change has no evidence on that target.

- **Automated, no database.** Contract schemas, direction and size checks, and both sides of the wire fixtures (`packages/contracts`). Session state machine, snapshot chunking, deadline expiry, fenced snapshots, disabled servers and hub routing, including the token-bound start (`app/src/lib/agent-ws-v2-*.test.ts`, `app/src/lib/realtime-hub-v2.test.ts`).
- **Automated, no database, telemetry.** The additive v2 telemetry schemas and fixtures, v2 history subscription on welcome, v2 sample normalization, the 120-point browser window, admin metric route authorization, and one shared v1 sampler for two viewers (`packages/contracts/src/agent-ws-v2.test.ts`, `app/src/lib/live-metrics.test.ts`, `app/src/lib/realtime-hub-live-metrics.test.ts`, `app/src/lib/admin-metrics-route.test.ts`, `app/src/lib/agent-ws-v2-session.test.ts`).
- **Disposable PostgreSQL, node-postgres and neon-http.** Fenced acknowledgements, status and traffic, the version fence on cached identifiers, token rotation and the token-bound start (`app/src/query/agent-ws-v2-state.integration.test.ts`). Convergence through the real store adapter and compiler: a routing-rule change with no notification is recovered by the status exchange after the deadline, an invalidated change is reported on the next status, and a rotated credential, a disabled server and a snapshot each stop or serve as specified (`app/src/query/agent-ws-v2-convergence.integration.test.ts`). The neon-http runs use a local `/sql` proxy in front of the same database, not Neon's hosted service.
- **Disposable PostgreSQL, v2 metric history.** A write with the exact `ws_session_id` succeeds, a replaced session id and a disabled server are fenced, and the newer receipt wins within a minute (`app/src/query/server-metric-history.integration.test.ts`, node-postgres).
- **Node server, built and run locally.** Against the built Node target, with PostgreSQL through node-postgres: the subprotocol echo, `hello` and `welcome`, a status acknowledgement, a snapshot whose length and digest verify, a credential rotation during a live session (a `config.get` then sends no snapshot, the session stops with `session_replaced` and close 4000), the old token refused with `401`, and the new token welcomed. Checked on 2026-11-19 with a scratch client that is not committed; the built-server handshake recorded in `adc180c` and the v1 route are not re-run here.
- **Node server, real Rust agent, v2 telemetry.** Against the built Node target, a disposable native PostgreSQL 18 cluster and the real `--ws-protocol v2` agent with a synthetic sing-box binary: the agent advertised both telemetry capabilities, wrote a history minute before any admin metric viewer existed, served a live sample with counter-derived network rates over the admin metric WebSocket, answered inspection, reconnected after its `ws_session_id` was replaced and resumed history. The disposable database's fencing suite (`server-metric-history.integration.test.ts`, 14 tests) separately proves a replaced session and disabled server cannot write. Checked on 2026-11-19; no real sing-box binary, Docker, Cloudflare or Vercel runtime was used.
- **Cloudflare, local workerd.** `wrangler dev --local` (Wrangler 4.164) running a copy of the Cloudflare build, with a local Hyperdrive connection string to the same disposable PostgreSQL. Checked on 2026-11-19 with the same scratch client: the same sequence as the Node run, which covers the Durable Object's upgrade, its message path and its fenced close. A session welcomed, then left idle for 70 seconds, still accepted a status, and disabling the server stopped the next status with `server_disabled` and close 4000. Workerd does not report hibernation, so the idle run shows that the welcomed flag survived the idle period, not that the object hibernated. The `401` on the Cloudflare upgrade for a credential that rotates after authentication is covered only by the unit and database tests, not by a race on workerd.
- **Cloudflare, hibernation.** Not verified. Hibernation was not observed, and timer behaviour and the `4000`-series close after a real wake were not run in any environment. Check them against a deployment before relying on them.
- **Cloudflare, hosted.** Not verified. Nothing was deployed, and hosted Hyperdrive and the `Sec-WebSocket-Protocol` response through the platform were not exercised.
- **Vercel.** Built only. Connection lifetime, `reconnectBeforeSeconds` and cross-instance Redis delivery are not verified.
- **Rust agent.** `server-agent/src/ws/v2/codec.rs` includes and decodes the shared fixture file directly, and the opt-in lifecycle (`--ws-protocol v2`) is selected explicitly; `legacy` remains the default. Its telemetry engine has paused-time subscription/coalescing tests and pure network-delta tests for initial observation, reset, interface change and oversized windows.
- Rust lifecycle: `server-agent/tests/ws_v2_lifecycle.rs` runs the real agent binary against a local v2 WebSocket control plane and a fake sing-box with disposable state. It covers a cold multi-chunk snapshot apply, an unacknowledged traffic report replayed byte-for-byte under the same id, missed-notification recovery through `agent.status.ack`, a failed candidate rolling back to the last-known-good config, an offline restart from that config, history before any live subscription, a live sample with network rates, inspection, and unsubscribe. The control plane records and fails every plain HTTP agent API request; the test asserts none occurred.
