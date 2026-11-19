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
3. The control plane starts a session. It writes a new `ws_session_id` and marks the transport `ws` in one statement, so an older session can no longer write. It replies with `welcome`, which carries `sessionId`, the desired configuration identifier, the update policy, the status interval, the optional `reconnectBeforeSeconds` (set on Vercel), and the limits.
4. The agent compares its applied identifier with `welcome.desired`. A mismatch or an empty cache sends `config.get`.
5. Pushes (`config.notify`) reach a session only after `welcome`.
6. On close, the control plane ends the session by its fence. A replaced session cannot clear its successor's marker.

There is no application-level heartbeat. Use WebSocket ping and pong to detect half-open connections. `agent.status` runs at `welcome.statusIntervalSeconds` (30 by default) and on significant change.

### Errors and close

- `error` frames (control plane to agent) carry `code`: `invalid_direction`, `invalid_payload`, `frame_too_large`, `server_disabled`, or `session_replaced`.
- `session_replaced` and `server_disabled` close the socket with code `4000` and the same code as the reason. Treat both as terminal for this session. `session_replaced` means a newer session exists, so reconnect and handshake again. `server_disabled` means the server is disabled, so back off and do not retry in a tight loop.
- Otherwise, reconnect with exponential backoff and jitter, starting at about 1 s and capped at 60 s. Repeat the handshake and reconciliation after every reconnect. On Vercel, reconnect before `reconnectBeforeSeconds`.

## Desired-state synchronization

| Frame                                                                                       | Direction              | Notes                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.get` `{requestId, reason}`                                                          | agent to control plane | `reason` is `initial`, `mismatch`, or `notify`. A newer request supersedes an older one that has not been sent yet.                                                                                                    |
| `config.snapshot.begin` `{requestId, desired, contentType, totalBytes, chunkCount, digest}` | control plane to agent | `desired` names the version actually compiled, which may differ from a notification. `digest` is the lowercase SHA-256 of the complete body bytes.                                                                     |
| `config.snapshot.chunk` `{requestId, index, data}`                                          | control plane to agent | Chunks arrive in order. `data` is standard base64 of at most 64 KiB raw bytes.                                                                                                                                         |
| `config.snapshot.end` `{requestId}`                                                         | control plane to agent | The agent verifies `chunkCount`, `totalBytes`, and `digest`, then validates the complete body before it applies anything.                                                                                              |
| `config.snapshot.error` `{requestId, code, message}`                                        | control plane to agent | `snapshot_too_large` means the compiled configuration exceeds the limit. The agent keeps its applied configuration and reports the refusal.                                                                            |
| `config.ack` `{requestId?, desired, outcome, stage?, error?}`                               | agent to control plane | `applied` names what was applied, after validation, durable storage, and sing-box application. `failed` names the stage (`receive`, `validate`, `store`, or `apply`). A failed ack never moves the applied identifier. |

The body is the HTTP `GET /agent/config/v3` document, byte for byte. A JSON `apiVersion: 3` object with `desiredRevision` equal to the identifier that `begin` advertises.

Discard a partial snapshot on disconnect and request a new one after reconnect. A chunk for an unknown `requestId`, an out-of-order index, or a digest mismatch is a local failure, not an applied configuration.

### Identifiers

- `desired.desiredRevisionSeq` is the publish-gate sequence. `desired.desiredRevision` is `"<seq>:sha256:<hex>"` and must begin with that same sequence.
- A version-target change travels in `welcome.updatePolicy` and `agent.status.ack.updatePolicy`. It does not change the configuration identifier, so it does not cause a configuration transfer.

## Status

- `agent.status` `{reason, runtimeState?, configState?, singBoxVersion?, activeNodeIds?, error?, certificateDeployments, updates?}` reports only the fields present. `error: null` clears the last error.
- `agent.status.ack` `{desired, updatePolicy}` carries the authoritative identifier. If it differs from the applied identifier, send `config.get`. This is how a lost `config.notify` is recovered.

## Traffic

- `traffic.report` `{reportId, windowStartedAt?, windowEndedAt?, entries}` has the same entries and dedupe key as the v1 HTTP report. `reportId` is **required** in v2 and matches `[A-Za-z0-9._-]{8,128}`.
- `traffic.ack` `{reportId, result, accepted?, dropped?, error?}` is sent only after the durable write commits.
  - `applied`: recorded now.
  - `duplicate`: recorded earlier. The counts are the original ones. Treat it as success.
  - `conflict`: the same `reportId` was already used with different content. The report was not applied. Surface the error and drop the batch.
- No `traffic.ack` means the session was replaced. The write did not happen. Resend the **same** `reportId` and payload on the new session, and the ledger will deduplicate it.
- Keep the report queue on disk until its `traffic.ack` arrives. Traffic collection must not wait on the socket.

## Logs

The Rust agent serves the retained redacted log buffer over v2 when it advertises:

- `logs-tail-v1`: `logs.subscribe`, `logs.unsubscribe`, `logs.batch` and `logs.gap`.
- `logs-search-v1`: `logs.search`, `logs.search.cancel`, `logs.context`, `logs.search.result`, `logs.context.result` and `logs.error`.

The contract and its fixtures were imported from PR #137 (`d9426331f54ef9cc67565f41ae6eca2f4a4df9e0`; contract commit `0fe9488946fec717ecd549a037de98a0d2622cd5`) without modification. The Rust codec decodes `packages/contracts/fixtures/agent-ws-v2-logs.frames.json` for the agent wire.

- **Source.** Every outbound record comes from the bounded, already-redacted retained buffer. Tail, search and context never format process output, tracing directly, or the local log file.
- **Tail.** `resume: null` returns the newest retained records that match the source and minimum-level filter. A cursor replays sequence-exact records after it. A generation change reports `restarted`; eviction reports an `overwritten` range. An open tail checks for new records every 500 ms and coalesces them into `logs.batch`, up to 200 records.
- **Search.** Matching is case-insensitive ASCII literal text over the retained buffer, with optional source, minimum severity and UTC `since`/`until` bounds. Pages are newest first, at most 100 records, and carry the pinned sequence, eviction floor and a continuation cursor. A cursor that lost coverage reports the gap instead of skipping records.
- **Context.** `logs.context` returns the target plus up to 50 same-source, same-process-run neighbours before and after it. A changed generation, eviction or missing sequence is a typed `logs.error`.
- **Bounds and deadlines.** One connection serves at most 16 tails, two searches and eight context lookups. Requests queue on a bounded channel; overflow is `busy`. Searches and context lookups run on blocking workers with an 8 s deadline and a cancellation token, so the v2 socket loop keeps handling status and configuration.
- **Session scope.** The worker and all of its tails and requests belong to one WebSocket connection. A reconnect, replacement or close cancels them, so a late result can never answer the next session. Request and subscription ids are echoed exactly.

## Not in v2 yet

These remain v1-only and are never sent to v2 sessions:

- `update.trigger` and `update.status`, and the `acme.*` messages. The control plane does not push them to v2 sessions.
- `telemetry.*`, `pty.*`, and the remote log-level policy messages (`log-policy-v1`). Live tail and retained search are served; changing a source's level remains a separate change.

Until the PTY moves to v2, a v2 agent **must not advertise `pty-v1`** in `hello.capabilities`. The admin terminal would otherwise offer a session that cannot start.

## Limits

| Limit                | Value      | Notes                                                                                                                   |
| -------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `maxFrameBytes`      | 4 MiB      | Enforced on both sides.                                                                                                 |
| `snapshotChunkBytes` | 64 KiB raw | Base64 expands this by about a third.                                                                                   |
| `maxSnapshotBytes`   | 8 MiB      | Provisional. Raise it only after measuring real compiled sizes, including certificate artifacts, on each deploy target. |

The control plane advertises these values in `welcome.limits`. The agent must enforce the values it received.

## Known limits of the control plane

- **Cached identifier.** The status acknowledgment returns `server.desiredConfigRevision`, which the control plane recompiles when it has been cleared. It is cleared by change notifications and routing-rule edits, so those reach v2 agents through the status exchange even if the push is lost. A change that alters the compiled configuration without either path (for example, a new global setting) is picked up at the next compile, which happens on reconnect or `config.get`. Sequence changes never depend on this cache.
- **Token rotation.** Rotating a server's static agent token does not close an existing v2 session. It takes effect on the next reconnect. Disablement does close a session, at the next status exchange.
- **Vercel.** The control plane advertises `reconnectBeforeSeconds`. Remote delivery across instances uses Redis when configured, which is best effort. Reconciliation on the next status exchange recovers any lost push.

## Verification status

- Contract schemas, direction and size checks, and both sides of the wire fixtures: unit-tested. `server-agent/src/ws/v2/codec.rs` includes and decodes the shared fixture file directly.
- Session state machine, snapshot chunking, and hub delivery: unit-tested with fakes.
- Retained tail, search, context, gaps and session reset: unit-tested against the real in-memory buffer and the shared log fixtures.
- Rust lifecycle: `server-agent/tests/ws_v2_lifecycle.rs` runs the real agent binary against a local v2 WebSocket control plane and a fake sing-box with disposable state. It covers a cold multi-chunk snapshot apply, an unacknowledged traffic report replayed byte-for-byte under the same id, missed-notification recovery through `agent.status.ack`, a failed candidate rolling back to the last-known-good config, and an offline restart from that config. The control plane records and fails every plain HTTP agent API request; the test asserts none occurred.
- The same lifecycle test streams the fake sing-box's synthetic stdout and stderr through `logs.subscribe`, asserts that a redacted credential never reaches the wire, checks that a reconnect drops the old tail, and drives paginated search and context over the retained buffer.
- The Rust log surface was not exercised through the Node relay or under workerd in this change. The control plane side remains covered by the shared contract fixtures and the PR #137 relay tests.
- Session and traffic fencing, configuration acknowledgement, and status writes: exercised against a disposable PostgreSQL through node-postgres and neon-http (the latter through a loopback `/sql` shim).
- The built Node server: a real v2 session (hello, welcome, snapshot with digest, applied ack, status, traffic and its replay, direction error, fenced disconnect) and the v1 handshake on the same route.
- Cloudflare Durable Object: built, not run under workerd in this change. The state machine is the same, but hibernation rehydration, the `Sec-WebSocket-Protocol` response header, and the 4000-series close are unverified on Cloudflare and must be checked before deployment.
- Vercel: built only.
