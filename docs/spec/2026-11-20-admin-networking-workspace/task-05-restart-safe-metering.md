# Task 05 handoff: restart-safe metering

This handoff covers the fixture and core slice of task 05 in the [implementation plan](implementation-plan.md). It follows the restart-safe accounting part of [Independent service lifecycle](README.md#independent-service-lifecycle) in the reviewed design. The [`server-agent/src/metering/`](../../../server-agent/src/metering/mod.rs) module compiles and is tested, but the running agent does not use it yet. Live accounting still goes through [`traffic.rs`](../../../server-agent/src/traffic.rs). This slice does not change the service lifecycle, `agent_v2.rs`, the installer or Docker.

## What landed

| File                                                                | Contents                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`checkpoint.rs`](../../../server-agent/src/metering/checkpoint.rs) | `InstanceKey`, which is task 04's `RuntimeInstance` display key validated as a file-name-safe string. `Checkpoint`, the schema 1 record: instance, sequence, commit time, window start, accountant state and outbox batches.                                                     |
| [`store.rs`](../../../server-agent/src/metering/store.rs)           | `CheckpointStore` writes `<dir>/runtime.checkpoint.json` with mode `0600` (temp file, fsync, rename, directory fsync). A damaged or future-schema file is moved to `runtime.checkpoint.damaged.json`. An I/O read error is returned as an error and is never treated as damage.  |
| [`meter.rs`](../../../server-agent/src/metering/meter.rs)           | `RuntimeMeter` (`recover`, `apply`, `commit`, `sendable`, `acknowledge`), `Recovery`, `BaselineReason` and `Commit`.                                                                                                                                                             |
| [`tests.rs`](../../../server-agent/src/metering/tests.rs)           | Fixtures against a control-plane ledger that deduplicates by ID: a long connection across an agent restart, a crash before and after commit, a lost ACK, a failed commit, closed connections replayed, missing and damaged checkpoints, a future schema and runtime replacement. |

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

## Integration after task 04 lands

1. **Instance.** Build `InstanceKey::from(&instance)` from `ServiceLifecycle::runtime_instance()`. When the result is `None`, do not create or feed a meter. Report that period as an unattributed window. Use `<state_dir>/metering/`, which the agent owns. Do not use the service-control helper's journal directory.
2. **Stream.** In the opt-in native path, replace `Shared { accountant, pending }` in `traffic.rs` with a `RuntimeMeter` behind the same short-lived mutex. Never hold the lock across an `.await`. The report cycle becomes `commit`, then send `sendable()` through `ReportSink`, then `acknowledge` on `Delivered`. On `Rejected`, also `acknowledge` and keep a copy using the bounded quarantine policy.
3. **Instance change.** After trial, commit, rollback, restart or reconcile, compare `runtime_instance()` with `meter.instance()`. If they differ, stop applying messages from the old stream and attempt a final `commit` on the old meter. Then `recover` with the new key, which keeps the outbox, and resubscribe.
4. **Still to port.** Port the seven-day expiry of undeliverable batches from `PendingQueue::expire`. At first activation, import or drain the legacy `traffic/pending/` queue before the meter takes over, so batches already sealed are neither lost nor sealed again.
5. **Visibility.** Log every `Baseline` and `NewInstance` recovery with its window, and later surface it in v2 status. That field is a contract change and is not part of this slice. When wiring, remove `#[expect(dead_code, unused_imports)]` from `mod metering` in `main.rs`.
6. **Policy difference.** On a broken state directory, the current reporter keeps sending batches held in memory. The meter stops sending until a commit succeeds. Restart classification depends on the store being truthful, so this difference is intended. Alert on `StoreError`.

Processkit and Docker can adopt the same meter with `InvocationId::Process`. In that mode every agent restart also restarts sing-box, so recovery always classifies `NewInstance`. Live connections are dropped, but the outbox is preserved and nothing is charged twice.

## Pinned stats fixture verification (owed)

The pinned test binary is sing-box **1.14.4** (`Dockerfile.test`, with a digest per architecture). Unit fixtures are hand-built `ConnectionEvents`. To confirm the decoder against the real binary:

1. Capture raw `SubscribeConnections` frames from 1.14.4 by extending `examples/query_stats.rs` to dump the encoded messages. Cover one long connection, a reconnect snapshot, more than 1000 closed connections (history overflow) and a process restart. Commit them as binary fixtures and decode them in a unit test.
2. Assert the fields the agent consumes (`user` = 10, `closedAt` = 13, `uplinkTotal` = 16, `downlinkTotal` = 17, the event type and both deltas). Assert the size of the closed history. If the snapshot fills the history and its oldest `closedAt` is newer than the last commit, record a partial unobservable window.
3. Run an opt-in, `#[ignore]`d process test that uses the real binary with a long-lived loopback connection across an agent restart, and assert the ledger totals equal the sing-box totals.

## Filtering (owed)

- Read the inbound tag field number from `daemon/started_service.proto` at tag `v1.14.4`, and the protocol version that introduced it, before adding it to `stats::Connection`. This slice has not verified it.
- Filter inside `RuntimeMeter::apply`, before `ConnectionAccountant`. Peer and probe connections must never enter tracked state.
  - Classify each inbound tag from the committed generation's inbound classification. A config change creates a new generation and therefore a new instance, so the classification is fixed for the lifetime of a meter.
  - Bill only subscriber inbounds whose `user` decodes through the subscriber identity codec.
  - Drop and count unknown tags and identities that do not decode.
- If the runtime does not provide the field, keep subscriber-only servers on the current behavior and block metered activation of peer links.

## Docker profile recommendation

Ship Docker with the existing **processkit** profile and report its limits:

- one agent-owned sing-box child;
- an agent upgrade or restart also restarts sing-box and drops live connections;
- no external supervision and no multiple runtimes;
- replacing the container is a maintenance operation.

A systemd container profile needs delegated cgroups, which typical Docker hosts do not provide. s6-overlay is the only alternative worth evaluating. It would change PID 1 and the image base, and it needs an adapter limited to `s6-svc`/`s6-svstat` and an invocation identity from PID plus start time. Evaluate it separately. Do not let it gate this task, and never switch supervisors automatically.

## Exit evidence still owed

On a disposable VM with task 04's units: one established flow across an agent restart with no duplicate charge, `kill -9` around the checkpoint rename, a lost `traffic.ack`, replayed closed connections, and runtime replacement through trial and rollback.

## Checks run for this slice

From `server-agent/`: `cargo fmt --all`, `cargo clippy --locked --all-targets --all-features -- -D warnings` and `cargo test --locked -- --test-threads=1` all pass. The run covers 412 unit tests, including 10 new `metering::` tests and 3 new `accountant::` tests, plus 8 OAuth service tests and 2 v2 lifecycle tests.
