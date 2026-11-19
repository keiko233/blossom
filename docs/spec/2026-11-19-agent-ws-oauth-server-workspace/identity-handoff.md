# Agent identity: integration handoff

Status of the control-plane OAuth identity and enrollment slice (Phase 2, PR
"feat(app): add agent OAuth identity and enrollment API"). The contract below is
what the follow-up PRs (WebSocket session plumbing, shell installer, UI, Rust
credential provider) may rely on. Facts marked **Established** are enforced by
code and by the disposable-database tests named in each section.

## Machine token (Established)

Issued by `POST ${origin}/api/auth/oauth2/token` with `client_secret_basic`.

| Input | Value |
| --- | --- |
| `grant_type` | `client_credentials` |
| `resource` | `${origin}/api/agent` (exactly one resource) |
| `scope` | `blossom:agent:connect` (or omitted, which yields the same single scope) |

Response: `access_token` (JWT), `token_type` `Bearer`, `expires_in` `900`, `scope`
`blossom:agent:connect`.

Verified claims (checked against the JWKS of the pinned provider, 1.7.25):

| Claim | Required value |
| --- | --- |
| `iss` | `${origin}/api/auth` |
| `aud` | `${origin}/api/agent` (a single string, exact) |
| `scope` | exactly `blossom:agent:connect` |
| `client_id` and `azp` | the machine client id, `agent_<22 base64url chars>`, equal to each other |
| `sub` | equal to the machine client id (no user subject) |
| `exp - iat` | `900` |

Tests: `lib/oauth-provider.integration.test.ts`, `query/agent-identity.integration.test.ts`.

## Enrollment redemption (Established)

`POST ${origin}/api/agent/enrollment/redeem`, `Content-Type: application/json`,
body `{ "enrollmentGrant": "egr_<43 base64url>" }` and nothing else. At most 4 KB.

| Status | `error` | Meaning | Client action |
| --- | --- | --- | --- |
| 200 | (none) | Credentials issued. The body contains `serverId`, `identityId`, `generation`, `identityStatus: "pending"`, `clientId`, `clientSecret`, `clientAuthMethod: "client_secret_basic"`, `grantType: "client_credentials"`, `tokenEndpoint`, `issuer`, `resource`, `scope`, `tokenLifetimeSeconds: 900`. | Store the secret at once (mode `0600`). It is never returned again. |
| 400 | `invalid_grant` | Unknown, expired, or revoked grant. | Ask an administrator for a new grant. |
| 400 | `invalid_request` | Not JSON, extra keys, or a malformed grant. | Fix the request. |
| 403 | `server_disabled` | The grant's server is disabled. | Stop; report to the administrator. |
| 409 | `grant_unavailable` | Already redeemed, claimed by another attempt, or refused by the server's identity state. | Do not retry for a secret. The administrator revokes the grant and issues a new one. |
| 413 / 415 | `payload_too_large` / `unsupported_media_type` | Body too large or not `application/json`. | Fix the request. |

Responses are `Cache-Control: no-store`. Tests: `query/agent-identity.integration.test.ts`
("HTTP redeem handler", "redemption", "lost responses and recovery").

## Admin functions (Established)

Server functions in `app/src/query/agent-identity.ts`. All use `ensureAdmin()`
and `adminAudit(...)` except the GET.

| Function | Method | Audit action | Input | Result |
| --- | --- | --- | --- | --- |
| `createAgentEnrollmentGrant` | POST | `server.enrollment_grant_create` | `serverId`, `mode` (`enroll` \| `replace`), `capabilities`, `release`, `confirmReplace` (required `true` for `replace`) | `grant` (no hash) and `secret` (once) |
| `revokeAgentEnrollmentGrant` | POST | `server.enrollment_grant_revoke` | `grantId` | `serverId`, `grantStatus`. Also revokes a still-pending identity from the same attempt. |
| `revokeAgentIdentityAccess` | POST | `server.agent_identity_revoke` | `identityId` | `serverId`, `changed` |
| `getAgentIdentityState` | GET | none | `serverId` | `identities`, `grants` (no secret or hash) |

Rules: a first enrollment (`enroll`) is refused while an active identity exists;
`replace` is refused without an active identity. Neither mode changes
agent-facing config, so neither records a `config_change`.

## Verification helper (Established, for the WebSocket follow-up)

`verifyAgentAccessToken(db, token, { issuer, audience, getJwks, purpose, now? })`
in `app/src/lib/agent-oauth.ts`. It returns
`{ serverId, identityId, generation, identityStatus, clientId, expiresAt }`, or
throws `AgentAuthError` with one of these codes:

| Code | Cause |
| --- | --- |
| `invalid_token` | Signature, issuer, expiry, or audience failed; or the token is tampered or for another audience. |
| `not_machine_token` | No client identity, a user subject, or `azp` and `client_id` disagree. |
| `missing_scope` | The scope is not exactly `blossom:agent:connect`. |
| `unknown_client` | No identity is bound to the client. |
| `client_disabled` | The client is disabled (revocation sets this). |
| `resource_not_linked` | The client lost its agent-resource link. |
| `server_disabled` | The mapped server is disabled. |
| `identity_not_usable` | Revoked or superseded; or pending outside `purpose: "handshake"`. |

The server is always taken from the identity mapping, never from the token. Each
call reads the database, so a revoked identity fails even for a still-unexpired token.

## WebSocket identity (Established in Phase 2C)

1. **Upgrade and pending proof.** `GET /api/agent/ws` accepts a static token on
   v1/v2 and an OAuth machine token on v2 only. OAuth calls
   `verifyAgentAccessToken` with `purpose: "handshake"` and the exact issuer,
   audience, and scope. A pending identity gets a proof-only session that owns
   no fence; its `hello` promotes it with one conditional statement and then
   takes the session fence. The static token path is unchanged.
2. **Rotation.** A `replace` grant creates generation n+1 as `pending`. The
   pending socket proves itself with `hello`; then the old active identity is
   marked `superseded` and the new one is promoted. The ordering is idempotent
   and crash-recoverable on both database drivers; a crash between demote and
   promote is completed by the next handshake. The old session's next read or
   write matches nothing.
3. **Lease, expiry and revocation.** A v2 session carries the active identity
   generation and machine-token expiry in the server fence. Every durable write
   and sensitive read checks that generation, the client's disabled flag, the
   resource link, and `exp`. Node re-checks every 30 seconds; the Cloudflare
   Durable Object schedules an alarm at the same bound or the token deadline.
   Revocation clears the fence and closes an idle socket at its next lease
   check.
4. **Certificate deployments.** V2 certificate-deployment reports are fenced by
   the session; a replaced, revoked, or expired session cannot write binding
   state. V1 keeps its historical unfenced behavior.
5. **Server deletion.** Deleting a server now revokes every identity, disables
   the clients, removes their links, revokes their tokens, deletes the identity
   rows and clients, and then deletes the server. Revoked identities no longer
   block the `restrict` foreign key, and the admin audit trail is preserved.

## Remaining follow-up work

1. **Installer and UI** consume the admin functions above. The installer must treat the
   `egr_` secret as a one-time value (no argv, no URL, no log). The fixed
   download route, the approved-release gate, and the Rust
   enrollment/credential-file contract are in
   [Operations: systemd installation](../../operations/server-agent.md#systemd-installation-oauth-enrollment).
   The Connection tab consumes the server DTO, backup-token functions, and
   proof-only pending lane described in [Workspace Connection UI
   handoff](connection-ui-handoff.md).
2. **Rust credential provider** consumes the redeem response. The exact
   credential storage, token, WebSocket, pending-proof, rotation, expiry and
   error contract is in [Rust agent OAuth and WebSocket v2
   handoff](identity-rust-handoff.md). The redeem route is not in
   `server-agent/openapi/spec.json`; the Rust side hand-writes that client
   unless the contract is added to the OpenAPI surface (regenerate per
   [Generated files](../../development/generated-files.md)).

## Failure cases covered by tests

- Concurrent redemptions of one grant: exactly one succeeds
  (`lets exactly one of many concurrent redemptions of one grant win`).
- Two grants racing for one pending slot: one succeeds, the loser's claim is released to `issued`.
- Replay after success, expired grant, revoked grant, unknown grant, disabled server.
- Lost redeem response: retry gets `grant_unavailable`; revoking the grant revokes the
  pending identity, disables its client, removes its link; a fresh grant succeeds as generation 2.
- Revocation is idempotent and finishes a partially completed cleanup.
- Revocation takes effect for an unexpired token (`client_disabled` at verification).
- Wrong audience, tampered token, wrong or disabled secret, MCP-audience reuse, machine
  client without an identity, user-managed and dynamic clients requesting the agent
  resource or machine scope.

## Not verified here

- **neon-http.** Every enrollment write is one statement (or an idempotent sequence), but no
  Neon HTTP proxy was available, so the neon-http path is unexercised. Run it with the
  Neon proxy before relying on it.
- **Production-like runtimes.** The app builds for the default (Cloudflare), Node, and
  Vercel targets. Redemption and token flows were run only against a local PostgreSQL.
- **Browser MCP consent.** The MCP regression uses the provider's consent endpoint directly,
  not the app's admin-only consent route, with an admin session.
- **Backfill race.** The MCP link backfill runs once per process before the first `/api/auth`
  request. A fresh database whose first redemption and first token request race can hit
  the provider's own resource seed once (rare; retry succeeds).
- **Legacy MCP clients on a live database.** The backfill is covered on the disposable
  database only. Confirm the link count against production before the upgrade.
