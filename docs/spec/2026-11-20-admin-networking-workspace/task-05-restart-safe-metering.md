# Task 05 handoff: restart-safe metering

This handoff covers task 05 in the [implementation plan](implementation-plan.md). It follows the restart-safe accounting part of [Independent service lifecycle](README.md#independent-service-lifecycle) in the reviewed design. The core checkpoint/worker slice landed first; the integration slice now feeds task 04 runtime observations and committed-generation inbound classification into one [`MeteringWorker`](../../../server-agent/src/metering/worker.rs) on the opt-in native path. Processkit and the shipped Docker profile keep the existing [`traffic.rs`](../../../server-agent/src/traffic.rs) reporter. The integration does not change the service lifecycle, the installer, or the select supervisor choice.

## What landed

| File                                                                | Contents                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`checkpoint.rs`](../../../server-agent/src/metering/checkpoint.rs) | `InstanceKey`, which is task 04's `RuntimeInstance` display key validated as a file-name-safe string. `Checkpoint`, the schema 1 record: instance, sequence, commit time, window start, accountant state and outbox batches.                                                     |
| [`store.rs`](../../../server-agent/src/metering/store.rs)           | `CheckpointStore` writes `<dir>/runtime.checkpoint.json` with mode `0600` (temp file, fsync, rename, directory fsync). A damaged or future-schema file is moved to `runtime.checkpoint.damaged.json`. An I/O read error is returned as an error and is never treated as damage.  |
| [`meter.rs`](../../../server-agent/src/metering/meter.rs)           | `RuntimeMeter` (`recover`, `apply`, `commit`, `sendable`, `acknowledge`), `Recovery`, `BaselineReason` and `Commit`.                                                                                                                                                             |
| [`tests.rs`](../../../server-agent/src/metering/tests.rs)           | Fixtures against a control-plane ledger that deduplicates by ID: a long connection across an agent restart, a crash before and after commit, a lost ACK, a failed commit, closed connections replayed, missing and damaged checkpoints, a future schema, runtime replacement, retention and inbound/identity filtering. |
| [`filter.rs`](../../../server-agent/src/metering/filter.rs)        | Inbound classification (`subscriber`/`peer`/`probe`), the Rust subscriber identity codec, the managed-metering capability gate and filtering before the accountant. A missing or unknown inbound latches the instance as unproven. |
| [`import.rs`](../../../server-agent/src/metering/import.rs)        | One-time scan/import of the legacy `traffic/pending` queue under its existing report ids; files are removed only after the importing checkpoint commits. |
| [`worker.rs`](../../../server-agent/src/metering/worker.rs)        | `MeteringState` and `MeteringWorker`: accepts task 04 `RuntimeInstance` observations, final-commits the old meter, recovers the new instance, invalidates old stream ids, imports the legacy queue and flushes durable batches through any `ReportSink`. The stream subscription keeps its own 1 s cadence, separate from the durable flush cadence. |
| [`native.rs`](../../../server-agent/src/metering/native.rs)        | The integration bridge: registers a committed generation's classification and stats endpoint, maps a serving `RuntimeInstance` to one observation, deduplicates repeated unattributed samples, and fails closed when evidence is missing. |
| [`stats.rs`](../../../server-agent/src/stats.rs)                  | `Connection.inbound` field 2, the pinned 1.14.4 capture fixtures and the protocol constants. Actual captures cover live/update/closed events and a closed-history snapshot. |

[`accountant.rs`](../../../server-agent/src/accountant.rs) gains `state`, `from_state` and `baseline`. Existing behavior does not change. `traffic.rs` only makes the batch format, report ID, entry drain and atomic-write helpers `pub(crate)`, so committed batches keep the existing wire format and can go through the existing `ReportSink`.

## Contract

- **One commit boundary.** `commit` seals the deltas accumulated since the last commit into batches with fresh report IDs. It then writes those batches, the counters that produced them, the finalised connection IDs and the rest of the outbox in one atomic file replacement. `sendable()` returns only batches made durable by a successful commit. If a write fails, the sealed batches stay in memory, nothing sends them, and the next commit retries them under the same IDs.
- **Crash before commit.** The counters roll back with the batch. On resume, the next snapshot recomputes that progress, and it is charged once.
- **Crash after commit and lost ACK.** The batch is resent with an identical ID and content. An acknowledgement takes effect at the next commit. Until then, a restart resends the batch and the ledger answers `duplicate`.
- **Recovery classification** (`RuntimeMeter::recover`, which must run before the first stream message of each agent run):
  - `Resumed`: the checkpoint names this instance. The next snapshot pays only remainders. The restored finalised IDs stop replayed closed history from being paid again.
  - `NewInstance { previous, previous_committed_at }`: the last commit belongs to another instance, so this instance has never committed or reported. Its first snapshot is billable in full. The previous outbox carries over. Any traffic the previous instance served after `previous_committed_at` is unobservable.
  - `Baseline(NoCheckpoint | Damaged)`: nothing proves what this instance has already paid. The first snapshot is adopted without charge, and earlier traffic is an unobservable window. `commit` returns `Deferred` until that snapshot arrives. Otherwise an empty checkpoint would turn a later restart into a full recharge.
- **Bound.** When committed batches hold 50 000 entries, `commit` returns `Deferred` and writes nothing. Counter progress that is not committed is recomputed after a crash, so it is never charged twice.

## Integration slice

The opt-in native v2 path now owns one accounting worker for the lifetime of the agent process:

1. **Worker.** `agent_v2.rs` opens `<state_dir>/metering/`, imports the legacy `traffic/pending` queue, and spawns one `MeteringWorker` fed by the existing v2 `SessionSink`. The old `TrafficReporter` is not constructed in native mode, so processkit/Docker and native never account the same runtime twice.
2. **Adoption.** At startup the bridge reads the helper's committed generation and registers only that generation's active-config classification and endpoint. A serving trial generation without a committed classification is not adopted; it is logged as an unattributed window. A missing or damaged checkpoint therefore resumes, opens a new-instance window, or baselines the first snapshot without a historical recharge.
3. **Generation fence.** Before a native trial, the staged candidate's generation is registered with its candidate classification. After `begin_trial`, commit, rollback, disable and every five-second runtime sample, the core asks `NativeRuntime::runtime_instance()`. A new invocation sends one observation; the worker final-commits the old meter, recovers the new key (keeping its outbox), invalidates the old stream id and resubscribes. A control-socket error keeps the last observation instead of detaching on missing evidence.
4. **Classification.** `InboundClassification::from_committed_config` classifies `node-<id>` as subscriber, `peer-in-<id>` as peer and `blossom-agent-<id>` as probe. An unknown or duplicate tag rejects the native candidate with `METERING_CLASSIFICATION_UNAVAILABLE` before the service is enabled or trialled. The gate also requires the sing-box >= 1.14 stats fields; otherwise the candidate is rejected with `METERING_UNAVAILABLE` and the runtime is not attached.
5. **Visibility.** Every `Baseline`, `NewInstance`, unattributed period, unknown generation, unsupported capability, dropped peer/probe event and closed-history gap is logged with its window. A v2 status field for loss remains a separate contract change.
6. **Policy difference.** On a broken state directory the processkit reporter keeps sending batches held in memory; native metering stops sending until a commit succeeds. Restart classification depends on the store being truthful, so this difference is intended and `StoreError` is logged.

Processkit and Docker can adopt the same meter with `InvocationId::Process` later. In that mode every agent restart also restarts sing-box, so recovery always classifies `NewInstance`. Live connections are dropped, but the outbox is preserved and nothing is charged twice. That path remains unchanged in this integration.

## Pinned stats fixture verification

The pinned test binary is sing-box **1.14.4** (`Dockerfile.test`, with a digest per architecture). `examples/query_stats.rs` can dump encoded `ConnectionEvents` frames, and checked-in captures under `server-agent/src/stats/fixtures/` are decoded by unit tests.

1. Actual 1.14.4 captures cover a live NEW event, UPDATE deltas, a CLOSED event with final totals, and reconnect snapshots with replayed closed history. The original snapshot carried 177 closed connections. A second run generated 1200 closed proxy connections with the pinned binary under `GOGC=off` (upstream's cleanup finalizer otherwise clears the retained list); the reconnect snapshot decoded exactly the 1000-entry cap and is checked in as `v1.14.4-closed-history-1000.bin`.
2. The tests assert the fields the agent consumes: `inbound` = 2, `user` = 10, event/`Connection` `closedAt` = 6/13, `uplinkTotal` = 16, `downlinkTotal` = 17, the event type and both deltas. They also assert the captured closed-history size and unique ids. A 1000-entry snapshot whose oldest `closedAt` is newer than the last commit yields an unobservable gap from that commit to the oldest retained closure.
3. The full-history capture now covers the overflow case. The opt-in real-binary restart test across a process restart, and task 04's disposable systemd/VM checks, remain owed.

## Filtering

- `Connection.inbound` is field 2 in `daemon/started_service.proto`. It was present when `StartedService` first shipped in 1.13.0, and the pinned 1.14.4 binary returns it. The agent keeps its existing >= 1.14 floor.
- `RuntimeMeter::apply` filters inside the meter, before `ConnectionAccountant`. Peer and probe connections never enter tracked state.
  - Each inbound tag comes from the committed generation's explicit classification. A config change creates a new generation and therefore a new instance, so the classification is fixed for the lifetime of a meter.
  - Only subscriber inbounds whose `user` decodes through the `blz.1...` codec are billable. A bare legacy id is dropped under managed metering.
  - Unknown tags, missing inbound fields and undecodable identities are dropped and counted. A missing or unknown inbound latches `unproven` for the instance and defers every later commit.
- `managed_metering` requires a supported stats protocol and a classification that proves every committed tag. The native apply path uses it to reject a billable candidate before the service is enabled or trialled; processkit and Docker remain on the existing reporter.

## Docker profile recommendation

Ship Docker with the existing **processkit** profile and report its limits:

- one agent-owned sing-box child;
- an agent upgrade or restart also restarts sing-box and drops live connections;
- no external supervision and no multiple runtimes;
- replacing the container is a maintenance operation.

A systemd container profile needs delegated cgroups, which typical Docker hosts do not provide. s6-overlay is the only alternative worth evaluating. It would change PID 1 and the image base, and it needs an adapter limited to `s6-svc`/`s6-svstat` and an invocation identity from PID plus start time. Evaluate it separately. Do not let it gate this task, and never switch supervisors automatically.

## Exit evidence still owed

On a disposable VM with task 04's units: one established flow across an agent restart with no duplicate charge, `kill -9` around the checkpoint rename, a lost `traffic.ack`, replayed closed connections, and runtime replacement through trial and rollback. A real-binary agent restart against a disposable control plane is also still owed; the worktree has no disposable systemd VM, no Docker daemon, and no installed musl target.

The actual 1.14.4 closed-history run is recorded above: 1200 closed connections produced a full 1000-entry reset snapshot, and the checked-in fixture decodes it. That covers the capture side of the overflow case; the meter's unobservable-gap decision remains covered by synthetic fixtures because the gap depends on the last checkpoint time.

## Checks run for this slice

From `server-agent/`: `cargo fmt --all`, `cargo fmt --all -- --check`, `cargo clippy --locked --all-targets --all-features -- -D warnings` and `cargo test --locked -- --test-threads=1` pass. The run covers 455 unit tests (including 5 filter tests, 3 native bridge tests, 6 worker tests and 5 pinned-stats tests), plus 8 OAuth service tests and 2 v2 lifecycle tests. The full suite includes the actual 1000-entry closed-history fixture. The default parallel `cargo test --locked` still reproduces the pre-existing `main.rs` `AGENT_WS_ENABLED` race described in the task 04 handoff; the isolated failing test passes. Native systemd/VM and musl checks were not available in this worktree.
