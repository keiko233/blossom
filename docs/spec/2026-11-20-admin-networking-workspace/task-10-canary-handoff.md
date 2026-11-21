# Task 10 handoff: two-agent canary scaffolding

This handoff covers task 10 of the [implementation plan](implementation-plan.md) and the canary/retirement gate in the [reviewed design](README.md#migration-and-release-gates). It is canary-only: the app, Rust agent, runtime and migrations are unchanged.

The framework commit is `dee27a3` (`test(canary): add reusable two-agent environment and evidence journal`). The implementation commit carries this file plus `lib/canary-scenarios.mjs`, the live CLI and this handoff.

## What landed

| Path                                                                                                                                                                                       | Contents                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`lib/canary.mjs`](../../../tests/integration/blossom/lib/canary.mjs)                                                                                                                      | The pinned sing-box reader, disjoint A/B layout and launch, prerequisite preflight, evidence plan and pure judges from the previous scaffold. Extended with the task 08 compiler-binding and task 09 apply-ingress gates and the `file#export` override contract.                                            |
| [`lib/canary-evidence.mjs`](../../../tests/integration/blossom/lib/canary-evidence.mjs)                                                                                                    | A mode-0600 atomic report. A pass needs a passing judge; missing prerequisites and unrecorded evidence are `blocked`/`not_run` and can never become a pass. Raw tokens, passwords, cookies, private keys and authorization headers are not serialized.                                                       |
| [`lib/canary-environment.mjs`](../../../tests/integration/blossom/lib/canary-environment.mjs)                                                                                              | `CanaryHarness` reuses the single-agent Harness and adds two agents with separate state/HOME/log/token, a loopback origin with a bounded per-request log, a subscription client, a peer negative-dial client and a SOCKS5 CONNECT helper used for stats isolation.                                           |
| [`lib/canary-scenarios.mjs`](../../../tests/integration/blossom/lib/canary-scenarios.mjs)                                                                                                  | Supported admin provisioning for A, B, the subscriber node, group, plan, user, subscription, self-signed peer certificate, peer inbound, link and routing drafts. Live capture for receiver-first, export-only-A, relay, billing, recovery, revocation and downgrade/drain, with an injectable Apply driver. |
| [`scripts/blossom-canary.mjs`](../../../scripts/blossom-canary.mjs)                                                                                                                        | Preflight, disposable environment, provisioning, ordered scenarios, report and cleanup. It starts nothing unless every core prerequisite is present.                                                                                                                                                         |
| [`tests/integration/blossom/canary.test.mjs`](../../../tests/integration/blossom/canary.test.mjs), [`canary-harness.test.mjs`](../../../tests/integration/blossom/canary-harness.test.mjs) | Judges, preflight, layout/token handling, evidence redaction, origin capture, SOCKS outcomes and the Apply driver. No Docker, database, agent or sing-box is started.                                                                                                                                        |

## What the live run does

1. Acquires the existing Harness lock, starts a disposable PostgreSQL container, applies migrations, builds the node app and the Rust agent, and starts the app.
2. Signs up the first admin and checks the running build reports `activationEnabled: true` from `getNetworkingWorkspace`. No SQL writes are used for provisioning.
3. Creates A and B, an A subscriber node, a group/plan/user/subscription, a B self-signed certificate, B's `vless` peer inbound, the A→B link and the immutable routing drafts. It verifies the planner puts B's receiver stage first.
4. Starts A and B on protocol v2 with independent state/HOME/log and a token passed only through `AGENT_TOKEN`. It waits for `managed-networking-v1`, an applied config and a served A subscription.
5. Runs the scenarios in order and records the observations each judge consumes. Failure and abort recovery each use a fresh disposable topology; `--recovery-kind failure` is the default and `--recovery-kind abort` runs the second pass. The report records one recovery kind per run.
   - **receiver-first**: B confirmed before A's sender/routing stages; a successful link probe before A's routing stage; no subscription lists B or changes early.
   - **export-only-A**: exactly A's subscriber endpoint in the served Clash proxies, never B's peer listener.
   - **isolated-relay**: the relayed origin request arrives from B's observed egress; a subscriber credential dialed straight at B's peer inbound is refused; SOCKS connects through A to both agents' loopback stats endpoints are refused. A and B sharing an egress address fails closed.
   - **no-double-billing**: one forwarded 3 MiB download increases `subscription.traffic_used_bytes` only at A within the single-count bound, and no B `traffic_record` exists.
   - **failure-recovery**: a candidate peer listener on an OS-occupied B port makes B's apply fail; the last confirmed version serves again, every issued stage has `recoveryProvenAt`, and a new eligible subscriber is published. Abort mode stops B to hold the first stage, calls the audited Abort, restarts B and proves the recovery target.
   - **live-revocation**: while a failed candidate is still recovering, cancellations are withdrawn immediately at the link and the data plane refuses the revoked credential before the deadline.
   - **downgrade-gate**: a legacy B session has no managed capability, Apply must refuse it, and an HTTP v3 config request for managed A must be refused. A supported `--drain-fn` must complete the reverse-order drain; without it the evidence stays blocked.
6. Writes `canary-evidence.json` (mode 0600) and stops only the processes/container/temp directory it started, including agent-supervised sing-box descendants.

## Blocked stages at this base

The live canary is implemented but not runnable on the prepared base `bbe474b` plus the framework commit. `node scripts/blossom-canary.mjs --check` currently exits 2 with these facts/blockers:

| Stage                        | State at this base                                                                                                                                               | What ends the block                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-link-probe-transport` | Blocked. `server-agent/src/agent_v2.rs` does not advertise `managed-link-probe-v1`, and the probe handler is not wired outside `server-agent/src/probe/`.        | The task 08 Rust probe wiring lands and a live `hello` records the capability on both servers.                                                                                          |
| `managed-probe-bindings`     | Blocked. Neither `packages/contracts/src/agent-config-v3.ts` nor `app/src/orpc/proxy/managed-singbox.ts` emits the sender's `probeBindings`.                     | The task 08/07 integration emits the loopback ingress/responder manifest the Rust executor consumes. A successful `managed_link_probe` row is the live proof.                           |
| `apply-ingress`              | Blocked. `app/src/query/networking.ts` does not call rollout admission; the current networking UI only plans and refuses activation.                             | The task 09 Apply integration exposes an audited server function (default discovery name or `--apply-fn <file>#<export>`) that creates a rollout and returns `{ ok: true, rolloutId }`. |
| `activation-enabled` | Ready. Managed networking is enabled by default. | Keep the default setting in the disposable build. |
| `base-harness`               | Not satisfied on the authoring host: the Docker daemon was unavailable (dependencies were installed to run the unit checks). The repository itself is unchanged. | A local Docker daemon, plus a pinned `sing-box` path (`--sing-box`).                                                                                                                    |
| `docker-agent-profile`       | Profile only; Docker was unavailable.                                                                                                                            | Run `server-agent/scripts/test-managed-tls-docker.sh` with the pinned test image; do not automate it against a real daemon/host without an explicit disposable profile.                 |
| `systemd-lifecycle`          | Profile only; no `--systemd-vm` was supplied and this host's systemd is never used.                                                                              | A disposable VM with real systemd and the task 04 units; record the runtime InvocationID before/after an agent restart and one long-flow traffic report.                                |

Consequently no live pass is claimed for any of the network evidence. The unit-level judges and harness checks pass; they prove the fail-closed reporting and observation shapes, not a running relay.

## Integration contract for task 08 and task 09

The canary does not import app internals or write rollout rows. It calls the app exactly as the browser does through [`AppClient`](../../../tests/integration/blossom/lib/serverfn.mjs).

- **Task 08 capability/bindings.** The live runner reads `server.agent_capabilities` after each `hello`; it does not trust the static preflight. The sender snapshot must carry `probeBindings` that name only local peer tags and link/generation identifiers. The fixed responder and loopback ingress remain agent-owned; the canary only observes the bounded `managed_link_probe` outcome.
- **Task 09 Apply.** Supply one of:
  - an export discovered by name matching `/(apply|start|admit).*rollout/i` in `src/query/networking.ts` or `src/query/managed-rollout.ts`, or
  - `--apply-fn src/query/…ts#exportName`.

  Input is `{ serverIds: string[], draft?: routingDraft }` (the canary sends only `serverIds`). Result is `{ ok: true, rolloutId }` or `{ ok: false, reason }`; the driver normalizes the existing `{ result: … }` wrapper too. Admission should return once the rollout and claims exist. If it blocks until terminal, the abort scenario cannot catch an in-flight stage — keep the admin call admission-only and let the v2 reports/maintenance sweep advance it.

- **Abort/retry.** Defaults are the existing audited `abortManagedRollout` / `retryManagedRollout` server functions. Override with `--abort-fn` / `--retry-fn` only if their paths change.
- **Drain.** `--drain-fn` is required for downgrade evidence. Input is `{ sourceServerId, linkId, expectedTopologyGeneration }`; result is `{ ok: true, rolloutId }`. It must perform the design's reverse-order drain (move source traffic, confirm it, remove the source outbound, then release destination admission) and keep the rollout claim until proof. Without it, the canary records `downgrade-gate` as blocked by `drain-integration` rather than claiming retirement.
- **Failure/abort injection.** Failure mode occupies B's next peer port with the harness's own loopback listener before Apply; `sing-box check` passes and the runtime bind fails, producing the normal apply-failed recovery path. Abort mode stops B before Apply, waits for the first issued stage, calls Abort, then restarts B so the recovery target can be proven. These are disposable-harness actions, not host service mutation.

## Activation and safety

- Managed networking is enabled by default. Run `node scripts/blossom-canary.mjs` only against the disposable canary environment.
- Use `--keep` only for a failed local run. Kept logs are not redacted but hold only that run's throwaway values; the temp directory is mode 0700. The evidence report is always redacted.
- Tokens travel in `AGENT_TOKEN` or HTTP headers, never argv. The harness does not print database URLs, agent tokens, subscription tokens, certificate keys or peer credentials; `redact` covers printed failure excerpts.
- The canary starts its own PostgreSQL container, app, agents, clients and origins under the existing Harness lock. It does not touch a real host's systemd units, sing-box process, database or deployment.
- A/B need distinct observable egress addresses for `isolated-relay`. Plain host loopback cannot satisfy that check; use the container/network-namespace profile, and let the judge fail rather than weakening it.

## Checks run for this slice

From the repository root:

- `node --check scripts/blossom-canary.mjs tests/integration/blossom/lib/canary.mjs tests/integration/blossom/lib/canary-evidence.mjs tests/integration/blossom/lib/canary-environment.mjs tests/integration/blossom/lib/canary-scenarios.mjs tests/integration/blossom/canary.test.mjs tests/integration/blossom/canary-harness.test.mjs`
- `node --test tests/integration/blossom/canary.test.mjs tests/integration/blossom/canary-harness.test.mjs` — 26 tests pass (judges, preflight, layout, evidence redaction, origin capture, SOCKS, Apply driver/discovery).
- `node scripts/blossom-canary.mjs --check` — exits 2 and lists every blocked stage above; nothing is started.
- `node scripts/blossom-canary.mjs --check --sing-box /tmp/sing-box-canary` against the downloaded official 1.14.4 musl archive (SHA-256 `8f7c5f…57ca`) — the pinned-sing-box stage passes and the remaining blockers are Docker and the task 08/09 integrations.
- `git diff --check`.

Not run: any live scenario. This host has no Docker daemon, and no systemd VM was available. The actual first live run is still the real verification for the admin wire format, certificate/peer TLS, probe bindings, apply ingress, failure injection, drain and egress separation.

## Exit evidence still owed

- Receiver-first A→B over the launch protocols with B confirmed before A.
- Relay with distinguishable B egress, exported A-only subscription and single billing.
- Failed and aborted recovery with new-subscriber publication and revocation during recovery.
- Credential rotation, offline receiver recovery and reverse-order drain before downgrade.
- Docker processkit lifecycle and a disposable systemd VM lifecycle.
- Retirement of the old admin views and native child-process supervision is **not** performed here; that widening/cleanup remains a later release decision after this canary passes.
