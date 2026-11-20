# Task 04 handoff: native service lifecycle

This handoff covers task 04 of the [implementation plan](implementation-plan.md) and follows the [Independent service lifecycle](README.md#independent-service-lifecycle) section of the reviewed design. The architecture slice is in place and nothing is activated. The [`server-agent/src/service/`](../../../server-agent/src/service/mod.rs) module compiles, is tested, and is not wired into the running agent. The processkit supervisor in [`process.rs`](../../../server-agent/src/process.rs), the Docker image and entrypoint, and the existing native installer are unchanged.

## What landed

| File                                                             | Contents                                                                                                                                                                                                         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`ports.rs`](../../../server-agent/src/service/ports.rs)         | The `RuntimeService` port (`inspect`, `apply(Start/Stop/Reload/Restart)`), the fixed `ServiceIdentity` set, the validated `InvocationId`, `ActiveState`, `ServiceObservation` and the typed `ServiceError`.      |
| [`journal.rs`](../../../server-agent/src/service/journal.rs)     | The pure `DeploymentJournal` state machine: generations, artifact digests, one-shot trials, probation deadline, bounded attempts, commit, confirmation, revert, durable run intent and `RuntimeInstance`.        |
| [`store.rs`](../../../server-agent/src/service/store.rs)         | Atomic `0600` persistence of `<dir>/<service>.journal.json`. It fails closed on unreadable, foreign or future-schema journals.                                                                                   |
| [`lifecycle.rs`](../../../server-agent/src/service/lifecycle.rs) | `select_boot` (the per-invocation boot selector) and `ServiceLifecycle` (trial, commit, rollback, disable, enable, reconcile, adoption). The tests drive these through a fake systemd with `Restart=on-failure`. |

The module carries a narrow `#[expect(dead_code, unused_imports)]` in `main.rs`. Remove it when the module is wired in. The lint then reports anything that is still unused.

## Semantics for task 05 and later work

- **Service identity.** `ServiceIdentity` names a fixed set of services: `Agent` maps to `blossom-agent.service`, which already exists, and `SingBox` maps to `blossom-sing-box.service`, which is new. The port cannot name any other unit. Unit names, executable paths and unit files stay inside the adapter and the installer.
- **Generation.** A generation is a per-service number assigned locally that only ever increases. Each one names exactly one artifact set: the binary SHA-256 and the config SHA-256. Reusing a generation with different digests returns `GenerationConflict`. A retry of a failed trial reuses the same generation and consumes another attempt, up to `MAX_TRIAL_ATTEMPTS = 3`. Generations never move backwards (`StaleGeneration`). Artifact paths come from the digests on the host and never from the control plane.
- **Invocation.** One run of a service is identified by `InvocationId::Systemd`, the systemd `InvocationID` (32 lowercase hex digits that are not all zero). Services without that id use `InvocationId::Process`, which combines the boot id, PID and start time for s6 or processkit.
- **Runtime instance.** A `RuntimeInstance` is the service, generation and invocation that the boot selector bound together. `ServiceLifecycle::runtime_instance()` returns one only while a fresh observation shows that invocation serving. Otherwise it returns `None`, which marks a window where traffic cannot be attributed. Its `Display` string is a stable key that is safe to use as a file name. Task 05 keys its runtime checkpoint and outbox by this instance. An agent restart keeps the same instance. A new invocation always starts a new one, so counters and connection ids never carry over.

## Lifecycle contract

1. **Trial.** `begin_trial` persists a one-shot `Authorized` trial and then restarts the unit. `select_boot` runs inside the next invocation. It consumes the authorization and binds it to that invocation, then persists the journal before the candidate starts. The trial is now in `Probation` with a `readyBy` deadline. Every later invocation boots the committed generation and marks an unfinished trial `Interrupted`. This covers a crashing candidate (the restart policy falls back), a reboot, and a stop or start during probation.
2. **Commit.** `commit` succeeds only for the matching generation, before `readyBy`, and only while the observed serving invocation is the one that consumed the trial. Otherwise it returns `InvocationChanged`, `DeadlineExpired` or `NoTrial`. If a previous generation existed, the commit leaves `Confirmation::Pending { previous }`. `confirm` clears the pending state after an authenticated control-plane exchange. `revert_unconfirmed` restores the retained generation. While the host is offline the previous release is kept.
3. **Rollback.** `rollback` marks the trial `RolledBack` and restarts onto the committed generation. `reconcile(now)` enforces the deadline offline. It ends an expired probation and restarts onto the committed generation, and it stops a unit that is serving despite disable intent.
4. **Disable and boot.** `disable` persists `RunIntent::Disabled` before it stops the unit. `select_boot` then returns `Disabled` on every later invocation, including after a reboot, until `enable` runs. Disabling during a trial ends the trial. An empty journal returns `Unprovisioned`. Neither of these results may serve.

All operations write intent to the journal before they touch the service, and they re-read the journal after every service job, because `select_boot` writes it from inside the unit. If the restart in `begin_trial` fails while the trial is still `Authorized`, the authorization is withdrawn as `RolledBack` (one attempt is spent), so it cannot arm an unrelated later restart. That check is race-free only under the single-writer helper from step 2.

## Implementation handoff

Do these in order. Each step stays behind an opt-in until task 05 passes, and the gate is separate from managed networking.

1. **systemd adapter.** Evaluate `zbus` and the generated `zbus_systemd` bindings against the distro matrix, the stable toolchain and the static musl release build before adding either dependency. Implement `RuntimeService`:
   - `inspect` reads `ActiveState` and `InvocationID` for the unit of an installer-provisioned identity.
   - `apply` calls `StartUnit`, `StopUnit`, `ReloadUnit` or `RestartUnit` with mode `replace`, waits for the matching `JobRemoved`, and then re-reads the unit.
   - After a bus reconnect, re-read the state instead of trusting job results.
   - Map a missing unit to `NotInstalled`, a polkit or peer refusal to `Denied`, and a job result other than `done` to `JobFailed`.
2. **Privileged service-control boundary.** Add a small root-owned helper (`blossom-service-control`) and make it the only writer of the journal directory, for example `/var/lib/blossom-service-control/`. The helper listens on a local socket and checks the caller with `SO_PEERCRED` against the agent's service uid. It exposes only typed operations: inspect, trial-start, commit, confirm, rollback, revert, disable and enable, each for an installer-provisioned identity and generation. It accepts no paths, unit names or shell commands. The agent's side becomes a client port with the same operations. The PTY identity gets no access to the socket.
3. **Boot selection in the unit.** Run `select_boot` with `$INVOCATION_ID` from a privileged `ExecStartPre=+` step. It writes the selected digests to a root-owned file under `/run`, and a fixed launcher in `ExecStart=` executes exactly those immutable artifacts under the unit's `User=`. `Disabled` and `Unprovisioned` exit with a dedicated status listed in `RestartPreventExitStatus=`, so systemd does not keep retrying them. Do not use `PartOf=` or `BindsTo=` between the agent unit and the runtime unit. Check on the oldest supported systemd that `EnvironmentFile=` and `$INVOCATION_ID` behave as this design assumes before relying on them.
4. **Protected signed promotion.** The unprivileged agent only stages downloads. The helper then:
   - verifies a signed release manifest (component, platform, version and SHA-256) against the release-signing public key that the installer pinned;
   - copies the verified file into root-owned, read-only `releases/<component>/<sha256>/` storage;
   - records the `GenerationRecord`.

   Agent and sing-box updates use the same promoter. A candidate can never replace the helper, the unit files or the trust key. Those change only when the operator reruns the installer or upgrades the package. The existing GitHub digest check in [`update.rs`](../../../server-agent/src/update.rs) stays in place for Docker and processkit.

5. **Installer.** Add an opt-in mode to [`agent-installer-template.sh`](../../../app/src/lib/agent-installer-template.sh) that creates the dedicated runtime user, the helper, both units, the socket and the pinned key. The migration preflights the units, moves listener ownership from the processkit child to the runtime unit once, and keeps enrollment and last-known-good state. Keep the current installer path as the default.
6. **Agent wiring.** Behind a CLI or env opt-in, have the v2 apply path in [`agent_v2.rs`](../../../server-agent/src/agent_v2.rs) use the client port instead of `SingBoxManager`: preflight, trial-start, probation, commit or rollback, then `confirm` after an authenticated exchange. On startup, call `runtime_instance()` and `reconcile` instead of starting a child. Keep reporting `RuntimeState` from observations.

Out of scope here and in the next steps: production activation, a runtime canary (task 10), the Docker supervision profile (task 05), connection-preserving reload or binary handoff (both stay restart-only until tested), and multiple runtime units.

## Exit evidence still owed

Verify these on a disposable VM, never on a host in use:

- the runtime starts offline from the committed generation;
- a reboot during a trial boots the committed generation;
- a failing agent candidate and a failing sing-box candidate both roll back within the attempt bound;
- disable survives a reboot;
- the installer cutover from processkit, and recovery from a cutover that was interrupted part-way.

Task 05 must also show that an established flow survives an agent restart without a duplicate traffic charge before independent restarts are enabled on metered servers.

## Checks run for this slice

From `server-agent/`:

- `cargo fmt --all -- --check` passes.
- `cargo clippy --locked --all-targets --all-features -- -D warnings` passes.
- `cargo test --locked -- --test-threads=1` passes: 399 unit tests, 8 OAuth service tests and 2 v2 lifecycle tests, including 21 new `service::` tests.
- The default parallel `cargo test --locked` sometimes fails in `main.rs` CLI tests that predate this slice. `an_environment_ws_disable_has_the_same_precedence_as_the_flag` sets `AGENT_WS_ENABLED` for the whole process while sibling tests parse the same environment. This slice does not change that.
