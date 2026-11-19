# Agent WebSocket protocol v2

Statements are **Established** when the control plane implements them. The Rust client is not yet migrated, so anything about agent behaviour is **Recommended** until the server-agent change lands. The machine-checked contract is `packages/contracts/src/agent-ws-v2.ts`; the wire examples the Rust implementation must reproduce are `packages/contracts/fixtures/agent-ws-v2.frames.json`, which `packages/contracts/src/agent-ws-v2.test.ts` already validates on the control-plane side.

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
3. The control plane starts a session. A static or active OAuth credential writes the new `ws_session_id`, marks the transport `ws`, and records the credential kind (plus the active identity generation and token expiry for OAuth) in one statement, so an older session can no longer write. A pending OAuth identity gets a proof-only lane naming its exact session, identity, generation, and token deadline; it owns no fence until its `hello`. The proof and the switch are one statement: the old active generation is superseded, the pending generation becomes active, and the server fence moves to this socket, or none of that changes. A wrong session, an expired pending token, a revoked client, or a newer generation leaves the old credential, identity, and session intact. The session start also requires the credential that authenticated the upgrade to still be current; if it rotated since, the session does not start (see [Known limits](#known-limits-of-the-control-plane)). It replies with `welcome`, which carries `sessionId`, the desired configuration identifier, the update policy, the status interval, the optional `reconnectBeforeSeconds` (set on Vercel), and the limits.
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
- `agent.status.ack` `{desired, updatePolicy, logPolicyRevision?}` carries the control plane's identifier. If it differs from the applied identifier, send `config.get`. This is how a lost `config.notify` is recovered. The identifier is authoritative within the bounds in [Known limits](#known-limits-of-the-control-plane): a change that no path signalled is reflected at the first status exchange after the cached identifier's deadline. A newer `logPolicyRevision` recovers a missed policy notification through `log.policy.get`.

## Log policy

- `log.policy.notify` `{revision, source?, reason?}` tells a capable agent that the server-wide policy revision changed.
- `log.policy.get` `{requestId}` asks for the desired snapshot.
- `log.policy.snapshot` `{requestId, revision, sources}` carries one entry per source: source-local revision, configured baseline, requested level, and an absolute deadline for `debug`/`trace`. A baseline level has no deadline; an expired override is sent as `default` with the configured baseline.
- `log.policy.ack` `{source, sourceRevision, requested, baseline, effective, deadline, error, pending}` reports requested and effective status only. It never carries log entries. The control plane accepts it only for the current session and current desired source revision.
- `welcome` and `agent.status.ack` carry `logPolicyRevision` only when the agent advertised `log-policy-v1`. The first accepted snapshot advances the agent's known revision; a lost push or snapshot is retried by the next status exchange.
- Local expiry is authoritative even while disconnected. An expired override returns to the configured baseline (or the installed/generated default when none is configured), and the next session acknowledges that effective status. Restore now keeps the configured baseline; restore-default clears it. A logging-only edit never moves the configuration identifier or the publish gate. See [Remote log-level policy](log-policy.md).

## Traffic

- `traffic.report` `{reportId, windowStartedAt?, windowEndedAt?, entries}` has the same entries and dedupe key as the v1 HTTP report. `reportId` is **required** in v2 and matches `[A-Za-z0-9._-]{8,128}`.
- `traffic.ack` `{reportId, result, accepted?, dropped?, error?}` is sent only after the durable write commits.
  - `applied`: recorded now.
  - `duplicate`: recorded earlier. The counts are the original ones. Treat it as success.
  - `conflict`: the same `reportId` was already used with different content. The report was not applied. Surface the error and drop the batch.
- **Absence of `traffic.ack` proves nothing.** A report that was replaced before its write does not commit. But a write can commit and its acknowledgement can be lost, on a dropped socket or a replaced session, so the agent cannot tell from a missing ack whether the rows exist. Keep the report on disk and resend the **same** `reportId` and payload on the next session until a `traffic.ack` arrives. The ledger deduplicates the replay and answers `duplicate` with the original counts.
- Keep the report queue on disk until its `traffic.ack` arrives. Traffic collection must not wait on the socket.

## Operations

The admin update, certificate, and terminal surfaces use the same typed payloads as v1, carried in v2 envelopes. The control plane only sends these to the current session, and each agent-to-control write is fenced or bound to that session.

| Operation                  | Frames                                                                              | Notes                                                                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent and sing-box updates | `update.trigger`, `update.status`                                                   | `trigger` is the immediate operation; the desired versions in `welcome.updatePolicy` and every `agent.status.ack` remain the replayable policy. `update.status` streams the reconciler's state. |
| ACME                       | `acme.issue`, `acme.dns_present`, `acme.dns_cleanup`, `acme.dns_ack`, `acme.result` | Same job id, issuer-server, generation, challenge-expiry, and bounded DNS record fences as v1. The control plane also checks that the result came from the job's current agent session.         |
| Admin PTY                  | `pty.open`, `pty.started`, `pty.data`, `pty.resize`, `pty.close`, `pty.exit`        | `pty.data` is the one type valid in both directions. The admin relay binds the browser shell to the exact `wsSessionId`; a replaced session cannot receive or deliver its bytes.                |

`pty-v2` is advertised only when the agent runs with `AGENT_PTY_ENABLED=true` under a non-root service account. A v2 agent does not advertise `pty-v1`, so an older control plane never attempts the v1 relay on a v2 socket. `AGENT_PTY_MAX_SESSIONS`, the idle/hard lifetime limits, input/output backpressure, dimension clamping, and the local shell allowlist are unchanged from v1.

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

## Telemetry

Telemetry additions are additive to v2; v1 `telemetry.*` frames are unchanged.
An agent advertises `telemetry-v2` for live samples and
`telemetry-history-v2` for the independent history cadence. An agent may
advertise neither, either or both. The control plane subscribes only when the
matching capability is present.

| Frame                                                                                                                                                                     | Direction              | Notes                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `telemetry.subscribe` `{subscriptionId, purpose, intervalMs}`                                                                                                             | control plane to agent | `purpose` is `live` or `history`; `intervalMs` is 1000–300000. The control plane uses 2000 for a coalesced live stream and 60000 for history. |
| `telemetry.unsubscribe` `{subscriptionId}`                                                                                                                                | control plane to agent | Sent when the last admin viewer of a live stream leaves, or on replacement.                                                                   |
| `telemetry.inspect` `{requestId}`                                                                                                                                         | control plane to agent | Requests the existing listener/interface snapshot.                                                                                            |
| `telemetry.sample` `{subscriptionId?, purpose, sampledAt, cpuPercent, memory, disk, environment, networkScope, cgroupVersion, cpuLimit, memoryLimit, scopeKey, network?}` | agent to control plane | `network` is `{txBytesPerSecond, rxBytesPerSecond, windowMs}` or null.                                                                        |
| `telemetry.snapshot`                                                                                                                                                      | agent to control plane | Same payload as the v1 inspection snapshot.                                                                                                   |

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

None. Update, ACME, PTY, telemetry, log policy, and log tail/search are carried
in v2 for capable agents; v1 remains for clients that do not negotiate v2.

## Admin log relay

**Established (control plane).** The admin browser reaches logs through a
same-origin WebSocket at `/api/admin/servers/$id/logs/ws`. The upgrade requires:

- an `Origin` whose host equals the request host;
- a live admin session read with `disableRefresh`, so the 101 response is never
  rebuilt to apply a refreshed cookie;
- an enabled server whose current transport is a v2 WebSocket session; and
- an agent that advertised `logs-tail-v1` or `logs-search-v1` (see
  `AGENT_WS_V2_LOGS_TAIL_CAPABILITY` and
  `AGENT_WS_V2_LOGS_SEARCH_CAPABILITY` in
  `packages/contracts/src/agent-ws-v2-logs.ts`).

The control plane admits the relay against the server's current
`wsSessionId` and then rewrites every id: `subscriptionId` and `requestId` on
the agent wire are relay-generated, and the browser only ever sees its own
ids. A response for an unknown id, another server or a replaced session is
dropped.

| Browser request      | Agent request        | Agent result                         | Browser result                       |
| -------------------- | -------------------- | ------------------------------------ | ------------------------------------ |
| `logs.subscribe`     | `logs.subscribe`     | `logs.batch` / `logs.gap`            | `logs.batch` / `logs.gap`            |
| `logs.unsubscribe`   | `logs.unsubscribe`   | —                                    | —                                    |
| `logs.search`        | `logs.search`        | `logs.search.result` / `logs.error`  | `logs.search.result` / `logs.error`  |
| `logs.search.cancel` | `logs.search.cancel` | late result, dropped                 | —                                    |
| `logs.context`       | `logs.context`       | `logs.context.result` / `logs.error` | `logs.context.result` / `logs.error` |

Bounds:

- One live tail per relay, two searches and four context lookups in flight.
- Every agent request has a 10 s deadline; a timeout sends `timeout` to the
  browser and cancels a search, and a late reply is dropped.
- Tail delivery is paced at 256 KiB/s with a 1 MiB burst. A batch that does not
  fit becomes a `dropped` gap, and the tail continues.
- Batch, search, context, text and browser-frame limits come from
  `AGENT_WS_V2_LOGS_LIMITS`.

The relay re-checks authority every 30 s: the admin session row, the server's
enabled flag, the current `wsSessionId`, and the log capability. A newer agent
handshake also ends older relays immediately. Browser close codes in the 4000
range identify the state: `4001` forbidden, `4002` server disabled, `4003`
session replaced, `4004` offline, `4005` unsupported; `1000`, `1008` and `1009`
are normal close, malformed frame and oversized frame.

Audit rows carry metadata only: operator, server, source, level, UTC bounds,
limit, whether text was searched, outcome, counts and gap. Search text, records
and cursors never reach the audit log.

On Nitro and Vercel the relay lives in the in-process hub; Redis carries
control frames to the instance that owns the agent socket and log results back.
Redis delivery is best effort. In the Cloudflare `AgentSessionDO` each relay's
plain-JSON state lives in its WebSocket attachment, and one storage alarm ticks
request deadlines and runs the authority checks while the object hibernates.
The agent's `logs.*` frames reach the relay only through the current v2 session
that was current at admission.

Known limits:

- A lost Redis publish is recovered by the next agent batch or by reconnect;
  the relay does not replay control frames.
- The Cloudflare alarm is the only idle authority check; the object cannot run
  an in-memory timer across hibernation.
- The Rust agent has not implemented the log messages yet, so it must not
  advertise the capabilities. The route then refuses with `unsupported`.

## Limits

| Limit                | Value      | Notes                                                                                                                   |
| -------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `maxFrameBytes`      | 4 MiB      | Enforced on both sides.                                                                                                 |
| `snapshotChunkBytes` | 64 KiB raw | Base64 expands this by about a third.                                                                                   |
| `maxSnapshotBytes`   | 8 MiB      | Provisional. Raise it only after measuring real compiled sizes, including certificate artifacts, on each deploy target. |

The control plane advertises these values in `welcome.limits`. The agent must enforce the values it received.

## Known limits of the control plane

### Configuration identifier

The identifier is compiled from every input of the v3 document. The control plane reuses a cached identifier only while three things hold: its sequence still equals `desiredRevisionSeq`, no invalidation has reset it, and its deadline has not passed. Otherwise it recompiles from the current state and caches the result, together with the inputs version and the sequence it was compiled from. A cache write is refused if either has moved since the compile read them, so a compile that raced a change, possibly on another instance, cannot store a stale identifier.

The inputs, and how each one reaches the identifier:

| Input                                                                                                                                | Changed by                                                                                                                                                                                    | How the identifier learns of it                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server enabled state, node set and node settings, node credentials, subscription plan, status and expiry, group membership, user ban | Publish-gate mutations (`recordConfigChange`)                                                                                                                                                 | The sequence moves, so the cache no longer matches. Change notifications also invalidate.                                                                  |
| Routing rules                                                                                                                        | `app/src/query/rules.ts`                                                                                                                                                                      | Each edit invalidates every server.                                                                                                                        |
| Certificate material, active version, bindings                                                                                       | Import, replace, activate and discard (`withCertificateTransaction` in `app/src/query/certificates.ts`), and each issued install (`persistMaterial` in `app/src/lib/certificate-issuance.ts`) | Invalidated after the change commits, never before, so a concurrent compile cannot cache the old state under the new version.                              |
| Subscription expiry                                                                                                                  | The clock                                                                                                                                                                                     | The deadline is the earliest expiry among the compiled subscriptions.                                                                                      |
| Temporary user-ban expiry                                                                                                            | The clock                                                                                                                                                                                     | Bounded by the maximum cache age (below). The ban expiry is not part of the deadline.                                                                      |
| Traffic quota exhaustion                                                                                                             | Traffic reports                                                                                                                                                                               | Bounded by the maximum cache age. A report does not invalidate.                                                                                            |
| Certificate creation, renewal, deletion and DNS challenge steps                                                                      | `app/src/query/certificates.ts`                                                                                                                                                               | No direct invalidation. They change no compiled input until an install, which invalidates.                                                                 |
| Desired agent and sing-box versions, poll and heartbeat intervals, server name and address                                           | Admin edits                                                                                                                                                                                   | Not in the identifier. Versions reach the agent through `updatePolicy`. Intervals in the document body and in `welcome` take effect at the next handshake. |

Two bounds apply to anything the table does not cover, and to changes whose notification was lost. **The maximum cache age is 120 seconds** (`AGENT_DESIRED_CONFIG_MAX_AGE_MS` in `app/src/orpc/proxy/agent-desired-state.ts`), so an unsignalled change is reflected at the first status exchange after that. The deadline also caps at the earliest subscription expiry. Notifications make the update faster and are not needed for correctness. A status exchange within the deadline costs a read and no compile.

### Token rotation and disablement

- **Optional static backup.** The create form sends `enableBackupToken: false`, so UI-created servers are OAuth-only; standalone callers that omit the field keep the static-token default. `enableServerBackupToken` creates one once; `disableServerBackupToken` clears the hash and `resetServerBackupToken` replaces it. Disable and reset end a current static session in the same statement (`disableAgentBackupCredential` / `rotateAgentCredential` in `app/src/query/agent.ts`). An active OAuth fence is not displaced. `regenerateServerToken` remains as the reset alias for older callers.
- **Rotation.** Replacing a server's static backup token replaces the hash and clears only a current static session in one statement. The rotated session's fenced writes then match nothing, its `config.get` reads nothing and sends no snapshot, and it stops with `session_replaced` (close 4000) at its next frame. Its reconnect is refused with `401`, because the old token no longer matches.
- **Rotation during a handshake.** A token that changes between authentication and the session start is refused. Cloudflare returns `401` before the upgrade. On Node the upgrade is accepted and then closed with `1008` (`credential changed`), before any frame is handled.
- **Bound.** The control plane sends no proactive close on rotation. The old socket stops at the agent's next frame, which is at most one status interval (`statusIntervalSeconds`, 30 seconds by default). Until then it can still receive `config.notify` pushes, which carry identifiers and a reason label, but no configuration.
- **Disablement.** Disabling a server does not clear the fence. The session stops with `server_disabled` (close 4000) at its next status or `config.get`. Pushes reach it until then, and carry the same identifiers and reason label.
- **v1.** Static token rotation and disablement of v1 WebSocket sessions are unchanged apart from the token being optional. v1 writes are not fenced, and a v1 agent's HTTP config poll is refused once the token has rotated.
- **OAuth.** The fence also names the active identity generation and machine-token expiry. Revocation disables the client, removes its resource link, revokes its tokens, and clears the session fence; supersession by a replacement does the same by making the old generation non-active. Every fenced read and write therefore fails even for an unexpired token, and a revoked or expired identity cannot open a new session. Node re-checks the authoritative state every 30 seconds; the Cloudflare Durable Object schedules an alarm at 30 seconds or the token deadline, whichever is earlier. Idle sessions close at the next check. `session_replaced` (close `4000`) asks the agent to reconnect with a fresh token; a `401` on reconnect asks it to reauthorize.

### Vercel

The control plane advertises `reconnectBeforeSeconds`. Remote delivery across instances uses Redis when configured, which is best effort. Reconciliation on the next status exchange recovers any lost push.

## Verification status

Each target is listed separately. "Not run" means the change has no evidence on that target.

- **Automated, no database.** Contract schemas, direction and size checks, and both sides of the wire fixtures (`packages/contracts`), including PTY, update/ACME, log-policy, log tail/search and telemetry fixtures. Session state machine, snapshot chunking, deadline expiry, fenced snapshots, disabled servers, hub routing, telemetry normalization, the shared live sampler and the admin metric route (`app/src/lib/agent-ws-v2-*.test.ts`, `app/src/lib/realtime-hub-v2.test.ts`, `app/src/lib/live-metrics.test.ts`, `app/src/lib/realtime-hub-live-metrics.test.ts`, `app/src/lib/admin-metrics-route.test.ts`).
- **Disposable PostgreSQL, node-postgres and neon-http.** Fenced acknowledgements, status, update status, traffic, the version fence on cached identifiers, token rotation, the token-bound start, and v1/v2 disconnect identity (`app/src/query/agent-ws-v2-state.integration.test.ts`, `app/src/query/agent-ws-session.integration.test.ts`). Log-policy revision CAS, expiry normalization, stale and replaced ACKs, failed-apply status and reconnect snapshots (`app/src/query/log-policy.integration.test.ts`). Convergence through the real store adapter and compiler: a routing-rule change with no notification is recovered by the status exchange after the deadline, an invalidated change is reported on the next status, and a rotated credential, a disabled server and a snapshot each stop or serve as specified (`app/src/query/agent-ws-v2-convergence.integration.test.ts`). The neon-http runs use a local `/sql` proxy in front of the same database, not Neon's hosted service.
- **Disposable PostgreSQL, OAuth.** `agent-ws-v2-oauth.integration.test.ts` uses real provider tokens for the pending proof, first promotion, generation replacement, interrupted-rotation recovery, replay refusal, revocation, expiry, certificate-deployment fencing, and server deletion cleanup. Ran on node-postgres and on neon-http through a local `/sql` proxy in front of the same database.
- **Disposable PostgreSQL, v2 metric history.** A write with the exact `ws_session_id` succeeds, a replaced session id and a disabled server are fenced, and the newer receipt wins within a minute (`app/src/query/server-metric-history.integration.test.ts`, node-postgres).
- **Rust lifecycle.** `server-agent/tests/ws_v2_lifecycle.rs` runs the real agent binary against a local v2 WebSocket control plane and a fake sing-box with disposable state. It covers a cold multi-chunk snapshot apply, an unacknowledged traffic report replayed byte-for-byte under the same id, missed-notification recovery through `agent.status.ack`, a failed candidate rolling back to the last-known-good config, an offline restart from that config, history before any live viewer, a live sample with counter-derived network rates, inspection and unsubscribe, and redacted log tail/search with session reset. The control plane records and fails every plain HTTP agent API request; the test asserts none occurred.
- **Node server + Rust agent, built and run locally.** On 2026-11-19 the built Node target ran against a disposable PostgreSQL and the real `server-agent` in `--ws-protocol v2` mode with a fake sing-box and disposable state. The agent completed `hello`/`welcome`, applied the compiled snapshot, advertised `pty-v2` and both telemetry capabilities, wrote a metric history minute before any viewer, and served a live sample with network rates over the admin metric WebSocket. A first-user admin then opened the real `/api/admin/servers/$id/pty/ws` route, and `echo INTEROP_PTY_OK` round-tripped through the browser relay, Node hub, Rust PTY, and back. The earlier Node-only sequence also covered the subprotocol echo, status acknowledgement, digest-verified snapshot, a credential rotation during a live session (a `config.get` then sends no snapshot, `session_replaced` with close 4000), and the old token refused with `401`. That client is a scratch script and is not committed. Update download and ACME order execution were not driven end to end because they would need a fake release feed/CA; their frames are covered by unit and fixture tests.
- **Cloudflare, local workerd.** The earlier `wrangler dev --local` (Wrangler 4.164) run covered the Durable Object's upgrade, message path, fenced close, a 70-second idle welcome, and `server_disabled`. PTY v2 framing and exact-session routing in `pty-session.cloudflare.ts` are unit-tested, but this change did not re-run workerd or open a terminal there. Metric relay and log relay attachment/alarm paths are unit-tested with stand-in agents.
- **Cloudflare, hibernation.** Not verified. Hibernation was not observed, and timer behaviour and the `4000`-series close after a real wake were not run in any environment. Check them against a deployment before relying on them.
- **Cloudflare, hosted.** Not verified. Nothing was deployed, and hosted Hyperdrive and the `Sec-WebSocket-Protocol` response through the platform were not exercised.
- **Vercel.** Built only. Connection lifetime, `reconnectBeforeSeconds` and cross-instance Redis delivery are not verified.
- **Rust agent.** The v2 codec decodes every shared fixture; session tests cover update triggers, ACME issue/ack, PTY commands, log-policy requests/acks, log tail/search, telemetry subscriptions and outbound frames; the full Rust suite covers the existing PTY, ACME, log and telemetry managers. The process lifecycle test covers configuration, traffic, status, rollback, `log-policy-v1`, telemetry and retained logs.
- Admin log relay: reducer, route admission, Nitro relay, hub Redis routing and Cloudflare attachment/alarm relay are unit-tested with stand-in agents. Workerd hibernation and a real browser client remain unverified.
