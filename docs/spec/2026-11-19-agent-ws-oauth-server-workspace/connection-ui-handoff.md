# Workspace Connection UI handoff

The control-plane API in this document is **Established** by the atomic
credential-rotation change. The Connection tab is being built in a parallel
change; this handoff fixes the contract it consumes without changing the new
workspace layout here.

## Server DTO

`ServerDTO` (`app/src/query/server-dto.ts`) is the only server shape the UI
receives. It never contains `agentTokenHash`.

| Field | Type | Meaning |
| --- | --- | --- |
| `backupTokenEnabled` | `boolean` | A static backup credential exists. `false` is OAuth-only, or the backup was explicitly disabled. |
| `agentTokenPrefix` | `string \| null` | Non-secret display prefix. `null` when no backup credential exists. |
| other server fields | unchanged | Existing status, versions, and transport fields. |

The plaintext static token is returned exactly once by create-with-backup,
enable, or reset. Never put it in a query cache, URL, audit payload, log, or
toast that outlives the reveal dialog.

## Server functions

All mutations are TanStack POST server functions; the audit middleware records
the action.

| Function | Input | Result | Behavior |
| --- | --- | --- | --- |
| `createServer` | Existing fields plus `enableBackupToken?: boolean` (default `false`) | `{ server: ServerDTO, token: string \| null }` | OAuth-first. Writes a static hash only when `enableBackupToken` is `true`. |
| `enableServerBackupToken` | `{ id }` | `{ id, token: string }` | Creates the first static backup token. Refuses if one already exists; use reset to replace it. |
| `disableServerBackupToken` | `{ id }` | `{ id }` | Clears the hash and ends a current static session. Idempotent for the hash. Leaves an active OAuth session and pending OAuth proof untouched. |
| `resetServerBackupToken` | `{ id }` | `{ id, token: string }` | Replaces the static token, or enables it if absent, and ends a current static session. Leaves OAuth untouched. |
| `regenerateServerToken` | `{ id }` | `{ id, token: string }` | Deprecated compatibility alias with the same reset behavior. Keep it while older callers exist. |
| `getAgentIdentityState` | `{ serverId }` | `{ identities, grants }` | No secret or hash material. Identity state is `pending`, `active`, `superseded`, or `revoked`; each row carries its generation and client id. Grants carry status and timing, not the grant hash. |
| `createAgentEnrollmentGrant` | Existing enrollment input | `{ grant, secret }` | `secret` is one-time; it is the installer credential, not a static backup token. |

## Connection state to render

Use `ServerDTO.backupTokenEnabled` for the backup control and
`getAgentIdentityState` for the OAuth control.

| Observed state | UI action |
| --- | --- |
| No active identity, no pending identity, `backupTokenEnabled: false` | Installation/authorization is required. Offer enrollment; do not imply a static token exists. |
| Active identity, `backupTokenEnabled: false` | OAuth is the only agent credential. Offer backup enable and rotation/revocation controls. |
| Active identity, `backupTokenEnabled: true` | OAuth is the primary path; the static token is a backup. Offer disable and reset. |
| Pending identity exists | A replacement or first installation is proving itself. Keep showing the active generation, if any, and do not present the pending generation as connected until it becomes `active`. |
| `backupTokenEnabled: false` while an OAuth session is active | Disabling backup never displaces the OAuth socket. |

The reveal dialog is for one-time plaintext only. If create returns
`token: null`, skip the dialog and navigate as before. Do not synthesize or
persist a token client-side.

## Compatibility decision for phased rollout

- The existing create form sends no `enableBackupToken`, so it creates
  OAuth-only servers and receives `token: null`. It already guards the reveal
  dialog on a truthy token; the only required compatibility change is the
  nullable type.
- Existing "reset token" actions still call `regenerateServerToken`. That alias
  now resets or enables the backup token and preserves the old response shape.
  Updating the label to "Enable/reset backup token" is sufficient until the
  Connection tab is integrated.
- Legacy rows keep their existing `agent_token_hash` and continue to
  authenticate on HTTP, v1, and v2. There is no automatic migration to OAuth
  and no automatic deletion of the static hash. An administrator enables OAuth
  with an enrollment grant, then explicitly disables the backup when ready.
- The new-server default must remain OAuth-first. A create-time backup checkbox
  may pass `enableBackupToken: true`; it must not make a static token the
  default.

## Cross-mode guarantees

- Static tokens never authenticate as OAuth tokens, and OAuth tokens never
  authenticate on agent HTTP.
- A disabled backup credential fails HTTP, v1, and v2 because all three use the
  same static lookup.
- An expired or wrong pending proof, a revoked client, or a newer generation
  cannot promote. The old identity and fence remain usable.
- Revoking one identity clears only that identity's active or pending fence.
  Another generation's OAuth session is not displaced.
