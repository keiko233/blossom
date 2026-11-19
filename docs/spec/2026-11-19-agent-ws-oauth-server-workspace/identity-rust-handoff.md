# Rust agent OAuth and WebSocket v2 handoff

Status of the control-plane side implemented by the Phase 2C change. This is the
contract the Rust `server-agent` consumes; the control plane does not depend on
the Rust implementation yet. Anything marked **Established** is enforced by the
code and the disposable-database suites named below.

## Credentials

### Enrollment response

`POST ${origin}/api/agent/enrollment/redeem` with
`Content-Type: application/json` and exactly
`{ "enrollmentGrant": "egr_<43 base64url>" }`.

A successful `200` response is the only time the client secret is delivered:

```json
{
  "serverId": "…",
  "identityId": "…",
  "generation": 1,
  "identityStatus": "pending",
  "clientId": "agent_…",
  "clientSecret": "ags_…",
  "clientAuthMethod": "client_secret_basic",
  "grantType": "client_credentials",
  "tokenEndpoint": "${origin}/api/auth/oauth2/token",
  "issuer": "${origin}/api/auth",
  "resource": "${origin}/api/agent",
  "scope": "blossom:agent:connect",
  "tokenLifetimeSeconds": 900
}
```

The Rust agent must:

- write the secret to a file with mode `0600` under the credential directory,
  never to argv, a URL, shell history, a log line, or the state database;
- keep the `serverId`, `identityId`, `generation`, `clientId`, `tokenEndpoint`,
  `issuer`, `resource`, and `scope` beside it as non-secret configuration;
- treat the response as one-time. A retry after a lost response returns
  `409 grant_unavailable`; do not retry for another secret. An administrator
  revokes the pending identity and issues a fresh grant.

`identityStatus` is `pending` in the redeem response by design. A first
installation becomes `active` only after the agent presents the machine token
at the v2 WebSocket handshake and sends `hello`; see [Pending proof](#pending-proof-and-rotation).

### Token request

```
POST ${tokenEndpoint}
Authorization: Basic base64(clientId + ":" + clientSecret)
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&resource=${origin}/api/agent
&scope=blossom:agent:connect
```

The response is a JWT `access_token` with `expires_in: 900`, `token_type:
Bearer`, and `scope: blossom:agent:connect`. The verified claims are:

| Claim | Required value |
| --- | --- |
| `iss` | `${origin}/api/auth` |
| `aud` | `${origin}/api/agent` (single string, exactly) |
| `scope` | exactly `blossom:agent:connect` |
| `client_id`, `azp`, `sub` | the machine client id, all equal |
| `exp - iat` | `900` |

An access token is a live credential. Keep it in memory only, never write it to
the state directory, logs, metrics labels, or the traffic queue. Do not put it in
a URL: the WebSocket authenticates with the `Authorization` header.

## WebSocket connection

```
GET ${origin}/api/agent/ws
Authorization: Bearer <machine access token>
Sec-WebSocket-Protocol: blossom-agent.v2
```

**Established.**

- OAuth machine tokens are accepted only with the v2 subprotocol. A token sent
  without the subprotocol is refused with `400` before the upgrade, because v1
  has no identity-generation semantics.
- Static backup tokens remain accepted on both v1 and v2. Preserve the existing
  v1 fallback.
- The upgrade echoes `Sec-WebSocket-Protocol: blossom-agent.v2`. A Rust client
  that required the subprotocol must refuse to continue if the echo is absent.
- Missing, invalid, expired, revoked, disabled, or wrong-server credentials are
  `401`. A non-upgrade request is `426`.
- OAuth tokens for another audience, the MCP audience, a user subject, a missing
  or extra scope, a disabled client, an unlinked client, or a superseded
  identity are all refused. The server is always resolved from
  `agent_identity`, never from a token claim.

After the upgrade the connection must send `hello` first, with the applied
configuration identifier or `null`. The control plane replies with `welcome`
exactly as it does for a static v2 session. The rest of the v2 frames are
unchanged (`config.get`, snapshots, `config.ack`, `agent.status`,
`traffic.report`).

## Pending proof and rotation

**Established.**

1. On a first installation, the redeem response creates generation 1 as
   `pending`. The agent connects with its token. Before `hello`, that socket is
   a proof-only session: it does not own the server's lane and receives no
   pushes. On `hello`, the control plane promotes the identity to `active` with
   one conditional statement, takes the session fence, and welcomes the agent.
2. On a replacement, the administrator creates a `replace` grant. Redemption
   creates generation n+1 as `pending` while generation n stays `active`. The
   new agent may connect and prove its credential with `hello`; until that
   proof, the live generation and its connection are untouched.
3. The first valid `hello` from the pending generation makes the switch:
   generation n is marked `superseded`, generation n+1 becomes `active`, and the
   session fence moves to the new socket. The old socket's next frame or lease
   check fails with `session_replaced` (close `4000`). A crash between the
   demote and promote is recovered by the next handshake, which promotes the
   still-pending generation when no active identity exists.
4. The Rust agent must keep its local proxy running if a replacement or
   reauthorization fails. A failed rotation leaves the old credential and the
   running proxy available. Do not delete the old secret until the new identity
   has completed `hello` and received `welcome`.

## Expiry, revocation and lease checks

**Established.**

- The session deadline is the machine token expiry. The control plane refuses
  every fenced read and write after `exp` and closes an idle session at that
  deadline.
- The control plane re-reads the identity every 30 seconds and on each frame.
  Revocation disables the client, removes its resource link, revokes its tokens,
  and clears the server's session fence. An idle socket closes with
  `session_replaced` at its next lease check; a new connection is refused with
  `401`.
- The agent should refresh before expiry: obtain a token with the same
  `client_credentials` grant and reconnect. A reasonable policy is to refresh
  about 60 seconds before `exp`, then reconnect and repeat `hello`/
  reconciliation. If the token endpoint returns `invalid_client` or the
  identity has been revoked, stop retrying and surface the need to reauthorize.
- Do not treat a `traffic.ack` absence as proof that nothing was written. Keep
  the report on disk and replay the same `reportId` on the next session until
  an acknowledgement arrives.
- Close codes remain `4000` with reason `session_replaced` or `server_disabled`.
  Reconnect with backoff and jitter (about 1 s to 60 s). After a `401`, do not
  hot-loop the token endpoint; follow the reauthorization path.

## Static backup token

**Established.**

- Existing servers keep the static `Authorization: Bearer <token>` on v1 and
  v2. Regenerating it clears the current session fence and refuses the old
  token at the next upgrade.
- OAuth is the installer default. Static mode is an explicit backup choice; the
  agent must use the configured authentication mode even when OAuth is refused.
- The static token is not accepted as an OAuth credential and is never sent to
  the token endpoint.

## Error map

| Surface | Status / code | Rust action |
| --- | --- | --- |
| Redeem `200` | credentials | Store once (secret mode `0600`), then connect. |
| Redeem `400 invalid_grant` | unknown, expired, or revoked grant | Ask an administrator for a new grant. |
| Redeem `409 grant_unavailable` | used, claimed, or refused by identity state | Do not retry for a secret; ask for a fresh grant. |
| Redeem `403 server_disabled` | server disabled | Stop and report. |
| Token `invalid_client` / `401` | bad/disabled client secret | Surface reauthorization; do not log the secret. |
| WS `401` | token invalid, expired, revoked, or wrong server | Refresh once, then surface reauthorization. |
| WS `400 OAuth requires …` | OAuth without the v2 subprotocol | Fix the client offer; OAuth cannot use v1. |
| WS `426` | not a WebSocket upgrade | Fix the request. |
| v2 error `session_replaced` / close `4000` | replaced, expired, or revoked | Reconnect with a fresh token; if still `401`, reauthorize. |
| v2 error `server_disabled` / close `4000` | disabled server | Back off; do not hot-loop. |

## Verification

- `query/agent-ws-v2-oauth.integration.test.ts` on a disposable PostgreSQL,
  through node-postgres and a local neon-http `/sql` proxy:
  opaque proof, first promotion, replacement, interrupted-rotation recovery,
  replay refusal, revocation, expiry, certificate-deployment fencing, and server
  deletion cleanup while preserving the audit row.
- `lib/agent-oauth.test.ts` and `query/agent-identity.integration.test.ts`:
  exact audience/scope, machine claims, revocation and disabled clients.
- `lib/agent-ws-v2-session.test.ts` and `lib/realtime-hub-v2.test.ts`: pending
  proof, lease stop, welcome and push gating.
