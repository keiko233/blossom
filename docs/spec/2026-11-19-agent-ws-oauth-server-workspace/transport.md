# Agent WebSocket Protocol

## Negotiation and lifecycle

Reuse `/api/agent/ws`, the shared contract, and the existing Nitro and Cloudflare hubs. Preserve the v1 wire format. The v2 client requests v2 with a WebSocket subprotocol and becomes ready after the server echoes that subprotocol and completes `hello` and `welcome`. The v2 JSON envelope carries a version and retains correlation IDs. Both sides validate message direction, payload, and negotiated capabilities. Existing clients that omit the subprotocol continue using v1. Deploy the compatible control plane first.

Configure authentication and transport separately. New installations default to OAuth and WSS v2. WSS v2 also supports static backup tokens; both credential inputs select v2 by default. During migration, `legacy-http` requires explicit local configuration and an enabled backup token on the server. Report unsupported protocol, rejected handshake, and network failure as distinct states. WSS clients retry within their configured transport and never downgrade to HTTP automatically.

`hello` carries the agent version, capabilities, and the applied configuration sequence and digest. The control plane resolves the server ID from the authenticated credential, generates a unique session ID, and atomically replaces the current session marker in the database. Fence subsequent durable writes by the current session ID. Disconnect callbacks and delayed acknowledgments from replaced connections can only affect their original session. Where a write must validate the session and mutate business state together, use a transaction or a conditional write in one SQL statement. Notify the connection owner on server disablement or credential revocation. Periodic lease validation covers missed notifications.

Reconnect with exponential backoff and jitter, starting at a proposed one second and capped at 60 seconds. While offline, continue supervising sing-box with the last successfully applied configuration and persist unacknowledged traffic reports locally. A fresh installation with an empty cache waits for enrollment and reports that it is awaiting its first configuration. Repeat the handshake and reconciliation after backoff or connection expiry.

## Application messages

The names below are proposed. Reuse the domain logic for existing `config.notify`, `config.ack`, update, and ACME messages in v2.

| Message | Direction | Behavior |
| --- | --- | --- |
| `hello` / `welcome` | Agent → control plane / control plane → agent | Establish the session and exchange desired configuration version, update policy version, capabilities, and connection limits. Reconcile on every connection. |
| `config.notify` / `config.get` / `config.snapshot` | Downstream / upstream / downstream | A notification carries the desired state identifier. The agent requests a full snapshot on an initial mismatch, a configuration change, or discovery of a missed notification. Reuse HTTP v3 configuration compilation and certificate binding logic. The response identifies the version actually compiled. |
| `config.ack` | Agent → control plane | Report the applied version or the stage that failed. Acknowledge success after validation, durable storage, and successful application by sing-box. |
| `agent.status` / `agent.status.ack` | Upstream / downstream | Send status at a proposed 30-second interval and on significant changes. The response carries authoritative desired state identifiers to recover missed notifications. Transport ping/pong detects half-open connections. |
| `traffic.report` / `traffic.ack` | Upstream / downstream | Reuse the report payload, durable queue, and deduplication ledger. Return the report ID and processing result after the database commit. |
| `update.trigger` / `update.status`, `acme.*` | Both directions | Recover update policy on reconnect or via the status acknowledgment. Preserve ACME checks for job ID, issuer, generation, and expiry. |
| Telemetry, PTY, `logs.*` | Both directions | See the capability and subscription lifecycle in the [workspace specification](server-workspace.md). |
| `log.policy.notify` / `log.policy.get` / `log.policy.snapshot` / `log.policy.ack` | Downstream / upstream / downstream / upstream | Synchronize per-source log levels with agents that advertise log policy support. Reconcile a separate policy revision on welcome and status acknowledgment. Report requested and effective levels, override deadline, and apply errors. |

A configuration identifier includes `desiredRevisionSeq` and a full configuration digest. This covers changes such as certificate rotation that can leave the publish revision unchanged. Status acknowledgments use authoritative identifiers. Maintain or reuse a lightweight version marker so each heartbeat can return the identifier without compiling a full configuration. Serialize configuration reconciliation per server and coalesce duplicate notifications. An older in-flight snapshot must never overwrite a newer applied snapshot. Reapply when the sequence matches and the digest changes. Track the update policy separately so a version-target edit alone does not trigger a configuration transfer. Share domain logic between v2 WebSocket and v1 HTTP, including sing-box safety checks, certificate path handling, and publish-gate semantics. The gate requires a successful application acknowledgment for the relevant revision. [Publish gate](../../development/architecture.md#publish-gate)

Preserve support for existing v3 document sizes by sending bounded, numbered chunks with a total byte count and digest. Use observed configuration sizes to set an aggregate limit before implementation and verify frame limits on all three deploy targets. Validate the complete snapshot before applying it atomically. Discard partial data on disconnect and request a new snapshot after reconnect. Report an oversized snapshot explicitly and continue using the applied version.

Keep traffic collection independent of network I/O. If an acknowledgment is lost, replay the same report ID and payload. Quarantine conflicting reports and surface the error. Retain existing queue eviction behavior and align it with server-side deduplication retention. Report queue overflow, expired reports, and data loss. Prioritize status, configuration acknowledgments, and traffic reports over diagnostic streams. Bound the PTY and log queues and frames independently. Keep configuration application, release downloads, and log highlighting off the WebSocket I/O path. Replacing a session clears its subscriptions and drops frames addressed to it.

## Deploy targets

- **Node.** Use the in-process hub for a single instance and Redis for cross-instance routing. Redis delivery is best effort. Reconnect reconciliation and durable acknowledgments recover business state.
- **Cloudflare.** Reuse the Durable Object keyed by server ID. Store session and subscription metadata needed for hibernation recovery in WebSocket attachments. Forward sensitive payloads within the request or session. Verify hibernation and timer behavior independently.
- **Vercel.** Function invocations impose connection lifetime limits. Production remote diagnostics require cross-instance relay. Deployment preflight should verify Redis, WebSocket upgrades, the effective connection limit, and reconnect behavior. Advertise the early reconnect deadline in `welcome`. Resubscribe automatically to resumable streams. Administrators start a new PTY session after a disconnect. [Vercel WebSocket support](https://vercel.com/changelog/websocket-support-is-now-generally-available)

HTTP continues to handle OAuth token requests, enrollment redemption, release downloads, and explicitly selected legacy API requests. WSS carries v2 configuration, heartbeat, and traffic synchronization.
