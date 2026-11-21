# Task 04 handoff: native service lifecycle

This handoff covers task 04 of the [implementation plan](implementation-plan.md) and follows the [Independent service lifecycle](README.md#independent-service-lifecycle) section of the reviewed design. The lifecycle stack is implemented behind explicit opt-ins and is not activated by the default installer or default agent mode. The processkit supervisor in [`process.rs`](../../../server-agent/src/process.rs), the Docker image and entrypoint, and the default native installer path are unchanged.

## What landed

| File                                                              | Contents                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`ports.rs`](../../../server-agent/src/service/ports.rs)          | The `RuntimeService` port (`inspect`, `apply(Start/Stop/Reload/Restart)`), the fixed `ServiceIdentity` set, the validated `InvocationId`, `ActiveState`, `ServiceObservation` and the typed `ServiceError`.                                      |
| [`journal.rs`](../../../server-agent/src/service/journal.rs)      | The pure `DeploymentJournal` state machine: generations, artifact digests, one-shot trials, probation deadline, bounded attempts, commit, confirmation, revert, durable run intent, installer bootstrap and `RuntimeInstance`.                   |
| [`store.rs`](../../../server-agent/src/service/store.rs)          | Atomic `0600` persistence of `<dir>/<service>.journal.json`. It fails closed on unreadable, foreign or future-schema journals.                                                                                                                   |
| [`lifecycle.rs`](../../../server-agent/src/service/lifecycle.rs)  | `select_boot` and `ServiceLifecycle` (trial, commit, rollback, revert, confirm, disable, enable, reconcile, adoption, committed generation). The tests drive these through a fake systemd with `Restart=on-failure`.                              |
| [`systemd.rs`](../../../server-agent/src/service/systemd.rs)      | Typed zbus adapter over the host manager: `GetUnit`, unit properties, `Start/Stop/Reload/RestartUnit` with mode `replace`, bounded `JobRemoved` wait and a fresh re-read after completion or a lost signal. Missing units, denial and job failures map to typed errors. |
| [`promote.rs`](../../../server-agent/src/service/promote.rs)      | Installer-pinned Ed25519 release manifests over a canonical component/platform/version/SHA-256 payload, protected content-addressed `releases/<component>/<sha256>/` storage, config staging, generation allocation and installer bootstrap.      |
| [`control.rs`](../../../server-agent/src/service/control.rs)      | Bounded length-prefixed typed local protocol, the agent client, the root helper server with `SO_PEERCRED` uid authorization, and the lifecycle facade over the journal.                                                                          |
| [`boot.rs`](../../../server-agent/src/service/boot.rs)            | Privileged boot selection into a root-owned `/run` file, dedicated disabled/unprovisioned/invalid statuses, digest and ownership verification, and the fixed launcher for exact immutable artifacts.                                              |
| [`helper.rs`](../../../server-agent/src/service/helper.rs)        | The hidden `service-control` binary surface: `serve`, `boot-select`, `boot-exec` and the installer-only `bootstrap`.                                                                                                                           |
| [`native.rs`](../../../server-agent/src/service/native.rs)        | The agent-side client adapter used by the opt-in v2 apply path.                                                                                                                                                                                  |

The old broad `#[expect(dead_code)]` on `main.rs` is gone; the lifecycle code is now reachable through the hidden `service-control` subcommand and the opt-in v2 path.

## Semantics for task 05 and later work

- **Service identity.** `ServiceIdentity` names a fixed set of services: `Agent` maps to `blossom-agent.service`, which already exists, and `SingBox` maps to `blossom-sing-box.service`, which is new. The port cannot name any other unit. Unit names, executable paths and unit files stay inside the adapter and the installer.
- **Generation.** A generation is a per-service number assigned locally that only ever increases. Each one names exactly one artifact set: the binary SHA-256 and the config SHA-256. Reusing a generation with different digests returns `GenerationConflict`. A retry of a failed trial reuses the same generation and consumes another attempt, up to `MAX_TRIAL_ATTEMPTS = 3`. Generations never move backwards (`StaleGeneration`). Artifact paths come from the digests on the host and never from the control plane.
- **Invocation.** One run of a service is identified by `InvocationId::Systemd`, the systemd `InvocationID` (32 lowercase hex digits that are not all zero). Services without that id use `InvocationId::Process`, which combines the boot id, PID and start time for s6 or processkit.
- **Runtime instance.** A `RuntimeInstance` is the service, generation and invocation that the boot selector bound together. `ServiceLifecycle::runtime_instance()` returns one only while a fresh observation shows that invocation serving. Otherwise it returns `None`, which marks a window where traffic cannot be attributed. Its `Display` string is a stable key that is safe to use as a file name. Task 05 keys its runtime checkpoint and outbox by this instance. An agent restart keeps the same instance. A new invocation always starts a new one, so counters and connection ids never carry over.
- **Single writer.** The helper is the only writer of the journal directory and the protected release tree. The agent has no journal path in its configuration, only the control socket and the release tree's read-only path for preflight.
- **Authorization boundary.** The helper accepts only the installer-provisioned agent uid and only the two fixed service identities. Lifecycle requests carry no paths, unit names or commands. Promotion carries staged paths, and only accepts regular files below the agent state directory owned by the agent uid after the signed manifest verifies.

## Lifecycle contract

1. **Trial.** `begin_trial` persists a one-shot `Authorized` trial and then restarts the unit. `select_boot` runs inside the next invocation. It consumes the authorization and binds it to that invocation, then persists the journal before the candidate starts. The trial is now in `Probation` with a `readyBy` deadline. Every later invocation boots the committed generation and marks an unfinished trial `Interrupted`. This covers a crashing candidate (the restart policy falls back), a reboot, and a stop or start during probation.
2. **Commit.** `commit` succeeds only for the matching generation, before `readyBy`, and only while the observed serving invocation is the one that consumed the trial. Otherwise it returns `InvocationChanged`, `DeadlineExpired` or `NoTrial`. If a previous generation existed, the commit leaves `Confirmation::Pending { previous }`. `confirm` clears the pending state after an authenticated control-plane exchange. `revert_unconfirmed` restores the retained generation. While the host is offline the previous release is kept.
3. **Rollback.** `rollback` marks the trial `RolledBack` and restarts onto the committed generation. `reconcile(now)` enforces the deadline offline. It ends an expired probation and restarts onto the committed generation, and it stops a unit that is serving despite disable intent.
4. **Disable and boot.** `disable` persists `RunIntent::Disabled` before it stops the unit. `select_boot` then returns `Disabled` on every later invocation, including after a reboot, until `enable` runs. Disabling during a trial ends the trial. An empty journal returns `Unprovisioned`. Neither of these results may serve.
5. **Boot files.** `boot-select` writes `<service>.boot.json` with the exact generation under a root-owned read-only `/run` file. `boot-exec` refuses a file that is not root-owned, group/world writable, oversized or for another service, verifies both artifact digests, and only then replaces the process image. `Disabled` exits 77, `Unprovisioned` 78 and an untrusted selection 79; all three are in `RestartPreventExitStatus=`.
6. **Promotion.** The helper verifies the installer-pinned public key, the canonical signed payload, the component-to-service match, the staged file owner/path and the SHA-256 before atomically copying into read-only content-addressed storage. A generation record is returned only after the copy. A candidate cannot replace the helper, unit files or trust key; those paths are installer-owned.

All operations write intent to the journal before they touch the service, and they re-read the journal after every service job, because `select_boot` writes it from inside the unit. If the restart in `begin_trial` fails while the trial is still `Authorized`, the authorization is withdrawn as `RolledBack` (one attempt is spent), so it cannot arm an unrelated later restart. That check is race-free only under the single-writer helper.

## Agent and installer wiring

- **Agent.** `--native-service-control` / `AGENT_NATIVE_SERVICE_CONTROL=1` selects the helper-backed v2 path. It is refused with legacy HTTP-only mode. Startup calls `reconcile` instead of starting a child; configuration apply preflights with the committed release binary, stages the candidate config, enables the service, trials it, waits probation, commits only for the same invocation, and confirms on the authenticated session. Administrative disable records native disable intent. Log-level overlays and update triggers are not served by this adapter yet and are reported rather than silently applied. Shutdown never stops the native runtime.
- **Installer.** `BLOSSOM_NATIVE_SERVICE=1` with `BLOSSOM_RELEASE_PUBLIC_KEY` (64 lowercase hex Ed25519 public key bytes) is the explicit opt-in. The default path still installs the existing processkit unit and no helper or runtime unit. Native mode creates the `blossom-runtime` user, installs the root helper and pinned key, bootstraps the initial agent/sing-box generations, installs both extra units with `ExecStartPre=+` boot selection, starts the helper before the runtime, and rolls back to the previous unit on failure. PTY is not enabled in this mode: the agent and its shell would share the helper-authorized uid, so the safe boundary is to keep the terminal off until a separate PTY service identity lands.

## Checks run for this slice

From `server-agent/`:

- `cargo fmt --all -- --check` passes.
- `cargo clippy --offline --locked --all-targets --all-features -- -D warnings` passes.
- `cargo test --offline --locked -- --test-threads=1` passes: 417 unit tests, 8 OAuth service tests and 2 v2 lifecycle tests, including the `service::` suite.
- The default parallel `cargo test --locked` still has the pre-existing `main.rs` CLI race: `an_environment_ws_disable_has_the_same_precedence_as_the_flag` sets `AGENT_WS_ENABLED` for the whole process while sibling tests parse the same environment. This slice does not change that.

From the repo root:

- `pnpm --filter @blossom/app exec vitest run src/lib/agent-installer-script.test.ts src/lib/agent-installer-e2e.test.ts` passes: 12 installer tests, including the native opt-in sandbox and its refusal to switch an existing native host silently.
- `sh -n app/src/lib/agent-installer-template.sh` passes.

## Exit evidence still owed

These require a disposable VM with real systemd and must never run on a host in use:

- the runtime starts offline from the committed generation;
- a reboot during a trial boots the committed generation;
- a failing agent candidate and a failing sing-box candidate both roll back within the attempt bound;
- disable survives a reboot;
- the installer cutover from processkit, and recovery from a cutover that was interrupted part-way;
- helper `SO_PEERCRED` rejection by a different uid on the installed socket;
- installer-pinned promotion of a signed release and rejection of a mismatched signature/digest.

A static musl build with the new zbus dependency was not available in this worktree. Task 05 must also show that an established flow survives an agent restart without a duplicate traffic charge before independent restarts are enabled on metered servers.
