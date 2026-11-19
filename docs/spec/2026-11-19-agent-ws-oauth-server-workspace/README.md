# Blossom Agent and Server Operations Workspace

**Status** — Proposed. This specification covers the control plane, the Linux server-agent, and the admin console.

## Design decisions

| Requirement | Proposal |
| --- | --- |
| Primary WebSocket transport | New agents use the existing WSS endpoint to synchronize desired configuration and send heartbeats, update status, and traffic reports. During a disconnect, sing-box continues running the last successfully applied configuration. During migration, legacy agents and explicit rollback can use the HTTP agent API. |
| OAuth authentication | Each server gets a Better Auth OAuth confidential client. The agent uses the `client_credentials` grant to obtain a short-lived machine access token. Administrators can explicitly enable a static agent token as a backup. |
| Interactive terminal | Reuse xterm.js and the PTY relay with an explicit local interactive shell. System installation offers an option to enable remote terminal access. An administrator starts each session from the terminal tab. |
| Remote logs | Follow new entries and search the agent's retained logs over WebSocket. Inspect matching lines in context and change log levels independently for the agent and sing-box. Load Shiki on demand in the browser. |
| Server workspace | Select a server in the sidebar and navigate its tabs in the right-hand route outlet. The default Overview shows live host metrics, PostgreSQL-backed metric history, and recorded billable traffic. |
| One-step system installation | Generate a separate, time-limited Linux systemd installer for each target server. A one-time enrollment grant provisions its OAuth identity and starts the service. Docker remains available through the existing container entry point. |

## Current implementation and scope

- The current agent calls HTTP `sync_config` at startup. It still fetches the v3 configuration over HTTP after a `config.notify`, and timers handle heartbeats and traffic reporting. The existing WebSocket already carries connection state, configuration acknowledgments, PTY, telemetry, and ACME. [Rust main loop](../../../server-agent/src/main.rs) · [WebSocket contract](../../../packages/contracts/src/agent-ws.ts)
- The current WebSocket upgrade looks up `server.agentTokenHash`. Better Auth already supplies an OAuth issuer and JWTs for MCP, with OAuth client and resource tables. Machine credentials and admin browser sessions have separate authorization. [WebSocket route](../../../app/src/routes/api/agent/ws.ts) · [Auth configuration](../../../app/src/lib/auth.tsx) · [OAuth schema](../../../app/src/db/oauth-schema.ts)
- The PTY uses the default program selected by `portable_pty`. The agent advertises the capability when `AGENT_PTY_ENABLED=true`. Troubleshooting should distinguish a disabled capability, a relay failure, and a local shell failure. The cause of the reported terminal issue has yet to be verified on the affected host. [PTY launch code](../../../server-agent/src/pty/session.rs) · [Current terminal behavior](../../development/server-agent.md#interactive-terminal-opt-in)
- The server list and details already provide node information, terminal access, and on-demand live telemetry. Existing historical data comes from business traffic records. Host samples are currently transient. [Server routes](../../../app/src/routes/(admin)/admin/proxies/servers/route.tsx) · [Telemetry endpoint](../../../app/src/routes/api/admin/servers/$id/stream.ts) · [Traffic schema](../../../app/src/db/traffic-schema.ts)

This proposal builds on the previous WebSocket, telemetry, PTY, and ACME work. It supersedes the previous specification's automatic HTTP fallback for v2 agents. System installation extends the existing agent release process and initially targets Linux amd64 and arm64 with systemd. [Previous roadmap](../2026-11-18-agent-ws-release-ops-redesign/worktree-roadmap.md) · [Current deployment guide](../../operations/server-agent.md)

## Specifications

1. [WebSocket protocol and agent state](transport.md)
2. [OAuth machine identity and installation](identity-installation.md)
3. [Server workspace, telemetry, terminal, and logs](server-workspace.md)
4. [Implementation, migration, and acceptance](rollout.md)
5. [OAuth identity integration handoff](identity-handoff.md): the exact claims, endpoints, failure codes, and follow-up work of the control-plane identity slice
6. [Rust agent OAuth and WebSocket v2 handoff](identity-rust-handoff.md): the credential storage, token, pending-proof, rotation, expiry and error contract the Rust agent consumes
7. [Workspace Connection UI handoff](connection-ui-handoff.md): the backup-token API, DTO state, and compatibility rules for the parallel Connection tab

Prioritize connection and configuration diagnostics, credential rotation and revocation, audit events, and installation progress and recovery. Evaluate alert notifications and centralized log archival later.
