# Agent WebSocket protocol v2

Statements are **Established** when the control plane implements them. The Rust client implements v2 behind the explicit `--ws-protocol v2` / `AGENT_WS_PROTOCOL=v2` selection; `legacy` remains the default and keeps the v1 WebSocket with HTTP config polling, heartbeat, and traffic. The machine-checked contract is `packages/contracts/src/agent-ws-v2.ts`; the wire examples the Rust client reproduces are `packages/contracts/fixtures/agent-ws-v2.frames.json`, which `packages/contracts/src/agent-ws-v2.test.ts` validates on the control-plane side and `server-agent/src/ws/v2/codec.rs` decodes in tests.

## Negotiation

- **Established.** The client offers `Sec-WebSocket-Protocol: blossom-agent.v2` on `GET /api/agent/ws`. The route authenticates the bearer token first, then negotiates.
- A client that offers no subprotocol speaks **v1** (`packages/contracts/src/agent-ws.ts`), unchanged.
- A client that offers only unknown subprotocols receives `400 Unsupported agent WebSocket subprotocol` before the upgrade.
- The control plane echoes `blossom-agent.v2` on the upgrade response. A client that required the subprotocol and did not receive it must not proceed.
- Authentication failures stay `401`, and a non-upgrade request stays `426`.
- **Established.** A per-server Better Auth machine token (`client_credentials`,
  audience `<origin>/api/agent`, scope exactly `blossom:agent:connect`) is
  accepted in place of the static token. OAuth is v2-only: an OAuth credential
  offered without the subprotocol is refused with `400` before the upgrade.
  Static tokens continue to work on both v1 and v2, and v1 is unchanged.

## Envelope

Every v2 text frame is `{"v":2,"id"?:string,"type":string,"ts":RFC3339,"payload":object}`.

- `v` must be `2`. A different version is an unsupported-version error, not a parse fallback.
- `ts` is required in v2. `id` is an optional correlation id that a reply echoes when it has one (`agent.status.ack` and `welcome` echo the `hello` or `agent.status` id).
- The receiver validates direction first. A control-plane type sent by the agent (or the reverse) is rejected with `invalid_direction`. Unknown types are ignored for forward compatibility.
- A frame over 4 MiB (`maxFrameBytes`) is rejected with `frame_too_large`.

## Handshake and session lifecycle

1. The agent upgrades with the v2 subprotocol.
2. The agent sends `hello` **first**. Any other frame before `welcome` is rejected with `invalid_payload`. `hello` carries the applied configuration identifier, or `null` when the cache is empty.
3. The control plane starts a session. A static or active OAuth credential writes the new `ws_session_id`, marks the transport `ws`, and records the credential kind (plus the active identity generation and token expiry for OAuth) in one statement, so an older session can no longer write. A pending OAuth identity gets a proof-only session that owns no fence until its `hello` promotes it; a first installation is promoted with one conditional statement, and a replacement demotes the old generation, promotes the new one, and takes the fence with idempotent recovery between the statements. The session start also requires the credential that authenticated the upgrade to still be current; if it rotated since, the session does not start (see [Known limits](#known-limits-of-the-control-plane)). It replies with `welcome`, which carries `sessionId`, the desired configuration identifier, the update policy, the status interval, the optional `reconnectBeforeSeconds` (set on Vercel), and the limits.
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

## Not in v2 yet

These remain v1-only and are never sent to v2 sessions:

- `update.trigger` and `update.status`, and the `acme.*` messages. The control plane does not push them to v2 sessions.
- `telemetry.*`, `pty.*`, and the log policy messages.

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
- **OAuth.** The fence also names the active identity generation and machine-token expiry. Revocation disables the client, removes its resource link, revokes its tokens, and clears the session fence; supersession by a replacement does the same by making the old generation non-active. Every fenced read and write therefore fails even for an unexpired token, and a revoked or expired identity cannot open a new session. Node re-checks the authoritative state every 30 seconds; the Cloudflare Durable Object schedules an alarm at 30 seconds or the token deadline, whichever is earlier. Idle sessions close at the next check. `session_replaced` (close `4000`) asks the agent to reconnect with a fresh token; a `401` on reconnect asks it to reauthorize.

### Vercel

The control plane advertises `reconnectBeforeSeconds`. Remote delivery across instances uses Redis when configured, which is best effort. Reconciliation on the next status exchange recovers any lost push.

## Verification status

Each target is listed separately. "Not run" means the change has no evidence on that target.

- **Automated, no database (Rust client).** `server-agent/src/ws/v2/codec.rs` includes and decodes the shared fixture file directly.
- **Automated, no database.** Contract schemas, direction and size checks, and both sides of the wire fixtures (`packages/contracts`). Session state machine, snapshot chunking, deadline expiry, fenced snapshots, disabled servers and hub routing, including the token-bound start (`app/src/lib/agent-ws-v2-*.test.ts`, `app/src/lib/realtime-hub-v2.test.ts`).
- **Disposable PostgreSQL, node-postgres and neon-http.** Fenced acknowledgements, status and traffic, the version fence on cached identifiers, token rotation and the token-bound start (`app/src/query/agent-ws-v2-state.integration.test.ts`). Convergence through the real store adapter and compiler: a routing-rule change with no notification is recovered by the status exchange after the deadline, an invalidated change is reported on the next status, and a rotated credential, a disabled server and a snapshot each stop or serve as specified (`app/src/query/agent-ws-v2-convergence.integration.test.ts`). The neon-http runs use a local `/sql` proxy in front of the same database, not Neon's hosted service.
- **Disposable PostgreSQL, OAuth.** `agent-ws-v2-oauth.integration.test.ts` uses real provider tokens for the pending proof, first promotion, generation replacement, interrupted-rotation recovery, replay refusal, revocation, expiry, certificate-deployment fencing, and server deletion cleanup. Ran on node-postgres and on neon-http through a local `/sql` proxy in front of the same database.
- **Node server, built and run locally.** Against the built Node target, with PostgreSQL through node-postgres: the subprotocol echo, `hello` and `welcome`, a status acknowledgement, a snapshot whose length and digest verify, a credential rotation during a live session (a `config.get` then sends no snapshot, the session stops with `session_replaced` and close 4000), the old token refused with `401`, and the new token welcomed. Checked on 2026-11-19 with a scratch client that is not committed; the built-server handshake recorded in `adc180c` and the v1 route are not re-run here.
- **Cloudflare, local workerd.** `wrangler dev --local` (Wrangler 4.164) running a copy of the Cloudflare build, with a local Hyperdrive connection string to the same disposable PostgreSQL. Checked on 2026-11-19 with the same scratch client: the same sequence as the Node run, which covers the Durable Object's upgrade, its message path and its fenced close. A session welcomed, then left idle for 70 seconds, still accepted a status, and disabling the server stopped the next status with `server_disabled` and close 4000. Workerd does not report hibernation, so the idle run shows that the welcomed flag survived the idle period, not that the object hibernated. The `401` on the Cloudflare upgrade for a credential that rotates after authentication is covered only by the unit and database tests, not by a race on workerd.
- **Cloudflare, hibernation.** Not verified. Hibernation was not observed, and timer behaviour and the `4000`-series close after a real wake were not run in any environment. Check them against a deployment before relying on them.
- **Cloudflare, hosted.** Not verified. Nothing was deployed, and hosted Hyperdrive and the `Sec-WebSocket-Protocol` response through the platform were not exercised.
- **Vercel.** Built only. Connection lifetime, `reconnectBeforeSeconds` and cross-instance Redis delivery are not verified.
- **Rust agent, local mock control plane.** `server-agent/tests/ws_v2_lifecycle.rs` runs the real agent binary against a local v2 WebSocket control plane and a fake sing-box with disposable state: a cold multi-chunk snapshot apply, an unacknowledged traffic report replayed byte-for-byte under the same id, missed-notification recovery through `agent.status.ack`, a failed candidate rolling back to the last-known-good config, and an offline restart from that config. The control plane records and fails every plain HTTP agent API request; the test asserts none occurred. `server-agent/tests/oauth_service.rs` runs the real `enroll` CLI and the v2 service against a disposable loopback enrollment, token and WebSocket server.
- **Rust agent, built control plane.** The Rust OAuth/v2 path has not been run against the built Node control plane in this change; the mock-control-plane suites above and the database suites are the evidence.
