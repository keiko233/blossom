# Agent WebSocket protocol v2

Statements are **Established** when the control plane implements them. The Rust client is not yet migrated, so anything about agent behaviour is **Recommended** until the server-agent change lands. The machine-checked contract is `packages/contracts/src/agent-ws-v2.ts`; the wire examples the Rust implementation must reproduce are `packages/contracts/fixtures/agent-ws-v2.frames.json`, which `packages/contracts/src/agent-ws-v2.test.ts` already validates on the control-plane side.

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
- `agent.status.ack` `{desired, updatePolicy}` carries the authoritative identifier. If it differs from the applied identifier, send `config.get`. This is how a lost `config.notify` is recovered.

## Traffic

- `traffic.report` `{reportId, windowStartedAt?, windowEndedAt?, entries}` has the same entries and dedupe key as the v1 HTTP report. `reportId` is **required** in v2 and matches `[A-Za-z0-9._-]{8,128}`.
- `traffic.ack` `{reportId, result, accepted?, dropped?, error?}` is sent only after the durable write commits.
  - `applied`: recorded now.
  - `duplicate`: recorded earlier. The counts are the original ones. Treat it as success.
  - `conflict`: the same `reportId` was already used with different content. The report was not applied. Surface the error and drop the batch.
- No `traffic.ack` means the session was replaced. The write did not happen. Resend the **same** `reportId` and payload on the new session, and the ledger will deduplicate it.
- Keep the report queue on disk until its `traffic.ack` arrives. Traffic collection must not wait on the socket.

## Not in v2 yet

These remain v1-only and are never sent to v2 sessions:

- `update.trigger` and `update.status`, and the `acme.*` messages. The control plane does not push them to v2 sessions.
- `telemetry.*`, `pty.*`, and the log level policy messages. Log tail, retained search and context lookup are part of v2; see [Admin log relay](#admin-log-relay).

Until the PTY moves to v2, a v2 agent **must not advertise `pty-v1`** in `hello.capabilities`. The admin terminal would otherwise offer a session that cannot start.

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

| Browser request | Agent request | Agent result | Browser result |
| --- | --- | --- | --- |
| `logs.subscribe` | `logs.subscribe` | `logs.batch` / `logs.gap` | `logs.batch` / `logs.gap` |
| `logs.unsubscribe` | `logs.unsubscribe` | — | — |
| `logs.search` | `logs.search` | `logs.search.result` / `logs.error` | `logs.search.result` / `logs.error` |
| `logs.search.cancel` | `logs.search.cancel` | late result, dropped | — |
| `logs.context` | `logs.context` | `logs.context.result` / `logs.error` | `logs.context.result` / `logs.error` |

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

| Limit | Value | Notes |
| --- | --- | --- |
| `maxFrameBytes` | 4 MiB | Enforced on both sides. |
| `snapshotChunkBytes` | 64 KiB raw | Base64 expands this by about a third. |
| `maxSnapshotBytes` | 8 MiB | Provisional. Raise it only after measuring real compiled sizes, including certificate artifacts, on each deploy target. |

The control plane advertises these values in `welcome.limits`. The agent must enforce the values it received.

## Known limits of the control plane

- **Cached identifier.** The status acknowledgment returns `server.desiredConfigRevision`, which the control plane recompiles when it has been cleared. It is cleared by change notifications and routing-rule edits, so those reach v2 agents through the status exchange even if the push is lost. A change that alters the compiled configuration without either path (for example, a new global setting) is picked up at the next compile, which happens on reconnect or `config.get`. Sequence changes never depend on this cache.
- **Token rotation.** Rotating a server's static agent token does not close an existing v2 session. It takes effect on the next reconnect. Disablement does close a session, at the next status exchange.
- **Vercel.** The control plane advertises `reconnectBeforeSeconds`. Remote delivery across instances uses Redis when configured, which is best effort. Reconciliation on the next status exchange recovers any lost push.

## Verification status

- Contract schemas, direction and size checks, and both sides of the wire fixtures: unit-tested.
- Session state machine, snapshot chunking, and hub delivery: unit-tested with fakes.
- Session and traffic fencing, configuration acknowledgement, and status writes: exercised against a disposable PostgreSQL through node-postgres and neon-http (the latter through a loopback `/sql` shim).
- The built Node server: a real v2 session (hello, welcome, snapshot with digest, applied ack, status, traffic and its replay, direction error, fenced disconnect) and the v1 handshake on the same route.
- Cloudflare Durable Object: built, not run under workerd in this change. The state machine is the same, but hibernation rehydration, the `Sec-WebSocket-Protocol` response header, and the 4000-series close are unverified on Cloudflare and must be checked before deployment.
- Vercel: built only.
- Admin log relay: reducer, route admission, Nitro relay, hub Redis routing and
  Cloudflare attachment/alarm relay are unit-tested with stand-in agents.
  Workerd hibernation and a real browser client remain unverified.
