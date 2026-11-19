# Remote log-level policy

Statements are **Established** unless marked **Recommended**.

This is the backend and admin surface of [log-level controls](../spec/2026-11-19-agent-ws-oauth-server-workspace/server-workspace.md#log-level-controls). The Logs tab consumes the audited read/update/reset functions below for per-source level controls; tail/search, Shiki highlighting and their UI copy belong to their own changes.

## Contract and capability

The frozen contract is `packages/contracts/src/log-policy.ts`; the shared frames live in `packages/contracts/fixtures/agent-ws-v2.frames.json` and are decoded by both `packages/contracts/src/agent-ws-v2.test.ts` and `server-agent/src/ws/v2/codec.rs`. The capability is `log-policy-v1`.

The policy is a v2-only message family:

| Frame                 | Direction             | Meaning                                                                                 |
| --------------------- | --------------------- | --------------------------------------------------------------------------------------- |
| `log.policy.notify`   | control plane → agent | The server-wide policy revision changed. A hint only.                                   |
| `log.policy.get`      | agent → control plane | Ask for the current desired snapshot.                                                   |
| `log.policy.snapshot` | control plane → agent | Server revision plus one desired entry per source: baseline, requested level, deadline. |
| `log.policy.ack`      | agent → control plane | Requested, baseline and effective levels, deadline, bounded error and pending flag.     |

`welcome` and `agent.status.ack` carry `logPolicyRevision` when the agent advertised `log-policy-v1`. The agent compares it with the last snapshot revision it accepted. A newer value, a missed notification or a reconnect makes it send `log.policy.get`; the snapshot is the only message that advances the known revision. There is no HTTP polling and no v1 fallback.

## Durable model

- `server.log_policy_revision` is the server-wide monotonic compare-and-swap revision. Every admin write or reset increments it in the same statement that writes the source row. It is independent of `server.desiredRevisionSeq` and `server.desired_config_revision`.
- `server_log_policy` has one row per `(server_id, source)` with the desired revision, the configured baseline, the requested level and its optional deadline, the admin actor, and the last acknowledged effective revision/level/baseline/deadline/error/pending flag.
- `desired_baseline` and `desired_level` are distinct. A temporary `debug`/`trace` request changes only `desired_level` and its deadline; it never overwrites the configured baseline. `default` in either column means the installed or generated default, so a configured `warn` baseline survives an override, its expiry, Restore now and a fresh agent. An explicit restore-default clears `desired_baseline` back to `default` and is a separate action from clearing an override.
- A source revision is scoped to that source and only moves forward. The snapshot returns both sources, including the implicit revision `0` / `default` state for a server that has never been edited.
- `error`, `warn`, `info` and `default` are baselines and never carry a deadline. `debug` and `trace` are temporary: the admin default is 15 minutes, the hard maximum is 60 minutes, and the Rust agent independently clamps to the same maximum. An expired temporary request is serialized as level `default` with the configured baseline at the same source revision, so an offline or newly enrolled agent restores that baseline instead of reviving the override.
- The snapshot read is one SQL statement joined to the fenced server row. A concurrent write cannot pair a new server revision with stale source rows.
- Acknowledgements are accepted only while `server.ws_session_id` names the connection that sent them and `ack.sourceRevision` equals the row's current desired revision. A replaced session, a late ack and a superseded revision change nothing. Replaying the current ack is idempotent.
- Apply errors are bounded to 512 characters and contain no log lines, request bodies, tokens or certificate material.

## Admin server functions

All three are audited admin POST server functions in `app/src/query/server-log-policy.ts`. They authenticate with `ensureAdmin()`, validate with zod, and never touch `recordConfigChange` or the publish gate.

```ts
type LogPolicySource = "agent" | "sing-box";
type LogPolicyLevel =
  | "default" | "error" | "warn" | "info" | "debug" | "trace";

interface ServerLogPolicySourceView {
  source: LogPolicySource;
  present: boolean;
  desiredRevision: number;
  desiredBaseline: LogPolicyLevel;   // configured baseline; "default" = installed/generated
  desiredLevel: LogPolicyLevel;
  desiredDeadline: Date | null;
  expired: boolean;
  targetLevel: LogPolicyLevel;       // active override or configured baseline
  effectiveRevision: number | null;
  effectiveLevel: LogPolicyLevel | null;
  effectiveBaseline: LogPolicyLevel | null;
  effectiveDeadline: Date | null;
  effectiveError: string | null;
  effectivePending: boolean;
  effectiveAt: Date | null;
  pending: boolean;                  // agent has not acked this revision
}

interface ServerLogPolicyView {
  serverId: string;
  revision: number;                  // pass back as expectedRevision
  sources: Record<LogPolicySource, ServerLogPolicySourceView>;
}

type ServerLogPolicyMutationResult =
  | { ok: true; policy: ServerLogPolicyView;
      previous: ServerLogPolicySourceView;
      next: ServerLogPolicySourceView }
  | { ok: false; reason: "conflict";
      policy: ServerLogPolicyView | null };

getServerLogPolicy(input: { serverId: string }): Promise<ServerLogPolicyView>;

updateServerLogPolicy(input: {
  serverId: string;
  source: LogPolicySource;
  level: LogPolicyLevel;
  temporarySeconds?: number;         // 30..3600; debug/trace only
  expectedRevision: number;
}): Promise<ServerLogPolicyMutationResult>;

resetServerLogPolicy(input: {
  serverId: string;
  source: LogPolicySource;
  expectedRevision: number;
  mode?: "restore-baseline" | "restore-default"; // default "restore-baseline"
}): Promise<ServerLogPolicyMutationResult>;
```

Audit actions are `server.log_policy_read`, `server.log_policy_write` and `server.log_policy_reset`. Write/reset metadata records the previous and next source views; input records the requested source, level, duration and expected revision.

`updateServerLogPolicy` with a baseline level (`default`, `error`, `warn`, `info`) replaces the configured baseline and clears any override. With `debug` or `trace` it keeps the current configured baseline and writes only a temporary override. For a temporary level, omit `temporarySeconds` to use 15 minutes, or pass a value from 30 to 3600 seconds. The server returns the absolute `desiredDeadline`.

`resetServerLogPolicy` never calls the agent synchronously. `mode: "restore-baseline"` (the default, and what the UI calls Restore now) clears only the override and returns to the configured baseline. `mode: "restore-default"` clears the override and the configured baseline, returning to the agent's installed or generated default. The two must remain separate controls.

`ok: false` with `reason: "conflict"` means another edit moved `server.log_policy_revision`. Reload with `getServerLogPolicy` and retry with the new revision. A missing server is a thrown `Not found` before a mutation.

## Agent application

- The v2 agent advertises `log-policy-v1` and bridges snapshots into the existing `LogPolicy`/`PolicyRequest`/`PolicyAction`/`PolicyStatus` API. It does not reimplement level rules. Each snapshot entry carries its configured baseline, which the local state persists independently of the requested override.
- Agent levels reload the shared tracing filter; sing-box levels are staged as the local `log.level` overlay through `sing-box check`, promotion, probation, commit or rollback. A failed apply keeps the working configuration, records the bounded error and retries on the existing 30-second bound.
- Snapshot entries are idempotent: the same source revision, baseline and level produce no new action; a lower source revision is rejected; a conflicting level or baseline for the same revision is reported. An expired temporary entry is converted to a `default` request that restores the carried baseline before it reaches the local API.
- Local expiry clears only the override and applies the configured baseline, including after a restart with no control plane. A reconnect snapshot at the same revision confirms that state without re-applying it. Restore now behaves the same way; restore-default clears the configured baseline and returns to the installed/generated default.
- The core publishes changed acknowledgements only. Local expiry, retry and successful application all update the same status view, so the control plane learns the effective level even without a new admin edit.
- A change while sing-box is on probation or has no active configuration stays pending and is retried by the maintenance tick. Log policy never changes `desiredRevision`, the applied configuration identifier, active node ids or publish-gate sequencing.
- Log buffers and stream quotas remain active at every level. Policy messages and status never carry log entries.

## Verification

- Contract, direction, fixture decoding and expiry/baseline rules: `packages/contracts/src/log-policy.test.ts`, `packages/contracts/src/agent-ws-v2.test.ts`, `server-agent/src/ws/v2/codec.rs`.
- Fenced CAS, expiry normalization, baseline preservation through offline expiry and fresh agents, Restore now versus restore-default, independent sources, failed-apply status, stale ACK and reconnect snapshot revision: `app/src/query/log-policy.integration.test.ts` against a disposable PostgreSQL on node-postgres, and neon-http when the local `/sql` proxy variables are set.
- Admin role, conflict and reset behavior: `app/src/query/server-log-policy.test.ts` and the structural `app/src/lib/admin-audit.test.ts`.
- Session reconciliation and stale snapshots: `server-agent/src/ws/v2/session/tests.rs`, `app/src/lib/agent-ws-v2-session.test.ts`, `app/src/lib/realtime-hub-v2.test.ts`. The Nitro and Cloudflare hub paths are covered by `realtime-hub-v2.test.ts` and `realtime-hub-cloudflare-log-policy.test.ts`; both hubs share the same store adapter, so the fenced ACK behavior is the same.
- Real agent over v2 with no HTTP agent API: `server-agent/tests/ws_v2_lifecycle.rs`, including a notification, snapshot acknowledgement and status-ack recovery.
- Logs tab controls: `app/src/lib/log-policy-view.test.ts` covers the per-source status cues, Restore now/installed-default distinction and bounded duration conversion; typecheck and the app build cover the panel and hook wiring.
- Not verified in this change: a browser focus/keyboard run or a live mutation against a seeded agent, live tail/search rendering, Shiki, hosted Cloudflare hibernation and a hosted deployment.

## Sibling integration

- The Logs tab consumes `getServerLogPolicy`, `updateServerLogPolicy` and `resetServerLogPolicy`; it renders `desiredBaseline`, `desiredLevel`, `targetLevel`, `effectiveLevel`, `desiredDeadline`, `expired`, `pending` and `effectiveError`, and treats `conflict` as a reload-and-retry state.
- The level controls expose two distinct affordances: Restore now (`resetServerLogPolicy` with `mode: "restore-baseline"`) and Restore installed default (`mode: "restore-default"`). The second is not labeled as clearing an override, and the panel explains the difference.
- The tail/search PR owns `logs.*`; do not reuse log policy frames for log data.
- The Shiki PR owns browser rendering; policy status contains no log text.
- Any UI that offers level controls must gate them on the agent's `log-policy-v1` capability. The server functions still reject unauthorized callers, but an older agent will simply leave the edit pending.
