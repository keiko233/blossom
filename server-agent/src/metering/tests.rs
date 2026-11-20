//! Restart-safety fixtures: agent restart with a long connection, crash
//! before and after commit, lost acknowledgement, closed-connection replay,
//! missing and damaged checkpoints, and runtime replacement.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::{DateTime, Utc};

use super::*;
use crate::accountant::ConnectionEventType;
use crate::service::{Generation, InvocationId, RuntimeInstance, ServiceIdentity};
use crate::stats::{Connection, ConnectionEvent, ConnectionEvents};
use crate::traffic::Batch;

const INVOCATION_A: &str = "0123456789abcdef0123456789abcdef";
const INVOCATION_B: &str = "fedcba9876543210fedcba9876543210";
const INVOCATION_C: &str = "00000000000000000000000000000c0c";

fn at(seconds: i64) -> DateTime<Utc> {
    DateTime::from_timestamp(1_800_000_000 + seconds, 0).unwrap()
}

fn test_dir(name: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "blossom-metering-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn instance(invocation: &str, generation: u64) -> InstanceKey {
    let invocation: InvocationId =
        serde_json::from_value(serde_json::json!({ "kind": "systemd", "id": invocation })).unwrap();
    InstanceKey::from(&RuntimeInstance {
        service: ServiceIdentity::SingBox,
        generation: Generation(generation),
        invocation,
    })
}

fn live(id: &str, user: &str, uplink: i64, downlink: i64) -> ConnectionEvent {
    ConnectionEvent {
        r#type: ConnectionEventType::New as i32,
        id: id.to_owned(),
        connection: Some(Connection {
            user: user.to_owned(),
            closed_at: 0,
            uplink_total: uplink,
            downlink_total: downlink,
        }),
        uplink_delta: 0,
        downlink_delta: 0,
        closed_at: 0,
    }
}

fn closed_history(id: &str, user: &str, uplink: i64, downlink: i64) -> ConnectionEvent {
    let mut event = live(id, user, uplink, downlink);
    event.connection.as_mut().unwrap().closed_at = 1;
    event
}

fn update(id: &str, uplink: i64, downlink: i64) -> ConnectionEvent {
    ConnectionEvent {
        r#type: ConnectionEventType::Update as i32,
        id: id.to_owned(),
        connection: None,
        uplink_delta: uplink,
        downlink_delta: downlink,
        closed_at: 0,
    }
}

fn closed(id: &str, user: &str, uplink: i64, downlink: i64) -> ConnectionEvent {
    let mut event = live(id, user, uplink, downlink);
    event.r#type = ConnectionEventType::Closed as i32;
    event.closed_at = 1;
    event
}

fn snapshot(events: Vec<ConnectionEvent>) -> ConnectionEvents {
    ConnectionEvents {
        events,
        reset: true,
    }
}

fn updates(events: Vec<ConnectionEvent>) -> ConnectionEvents {
    ConnectionEvents {
        events,
        reset: false,
    }
}

/// The control plane's contract: a report id is applied at most once.
#[derive(Default)]
struct Ledger {
    applied: HashMap<String, Batch>,
    totals: HashMap<String, (i64, i64)>,
}

impl Ledger {
    /// Delivers every sendable batch and acknowledges it unless `lose_ack`.
    fn deliver(&mut self, meter: &mut RuntimeMeter, lose_ack: bool) {
        for batch in meter.sendable().to_vec() {
            if let Some(previous) = self.applied.get(&batch.report_id) {
                assert_eq!(previous, &batch, "a report id was reused with new content");
            } else {
                for entry in &batch.entries {
                    let total = self
                        .totals
                        .entry(entry.subscription_id.clone())
                        .or_default();
                    total.0 += entry.uplink_bytes;
                    total.1 += entry.downlink_bytes;
                }
                self.applied.insert(batch.report_id.clone(), batch.clone());
            }
            if !lose_ack {
                meter.acknowledge(&batch.report_id);
            }
        }
    }

    fn total(&self, user: &str) -> (i64, i64) {
        self.totals.get(user).copied().unwrap_or_default()
    }
}

/// A store whose last commit belongs to another, already replaced instance.
fn store_after_previous_instance(name: &str) -> CheckpointStore {
    let store = CheckpointStore::new(&test_dir(name));
    let (mut meter, _) = RuntimeMeter::recover(&store, instance(INVOCATION_C, 1), at(0)).unwrap();
    meter.apply(&snapshot(Vec::new()));
    assert_eq!(meter.commit(&store, at(0)).unwrap(), Commit::Committed);
    store
}

#[test]
fn instance_keys_follow_the_runtime_instance_contract() {
    let key = instance(INVOCATION_A, 3);
    assert_eq!(
        key.to_string(),
        format!("sing-box-g3-systemd-{INVOCATION_A}")
    );
    assert_eq!(key, instance(INVOCATION_A, 3));
    assert_ne!(key, instance(INVOCATION_B, 3));
    assert!(InstanceKey::try_from("../escape".to_owned()).is_err());
    assert!(InstanceKey::try_from(String::new()).is_err());
}

#[test]
fn one_long_connection_survives_agent_restart_without_double_charge() {
    let store = store_after_previous_instance("long-connection");
    let mut ledger = Ledger::default();
    let key = instance(INVOCATION_A, 1);

    let (mut meter, recovery) = RuntimeMeter::recover(&store, key.clone(), at(1)).unwrap();
    assert!(matches!(recovery, Recovery::NewInstance { .. }));
    meter.apply(&snapshot(vec![live("c1", "sub-a", 100, 10)]));
    meter.apply(&updates(vec![update("c1", 50, 0)]));
    meter.commit(&store, at(2)).unwrap();
    ledger.deliver(&mut meter, false);
    drop(meter); // agent restart; the runtime keeps serving c1

    let (mut meter, recovery) = RuntimeMeter::recover(&store, key, at(3)).unwrap();
    assert!(matches!(recovery, Recovery::Resumed { committed_at } if committed_at == at(2)));
    meter.apply(&snapshot(vec![live("c1", "sub-a", 180, 10)]));
    meter.apply(&updates(vec![update("c1", 20, 5)]));
    meter.commit(&store, at(4)).unwrap();
    ledger.deliver(&mut meter, false);

    assert_eq!(ledger.total("sub-a"), (200, 15));
}

#[test]
fn crash_before_commit_recomputes_uncommitted_progress_once() {
    let store = store_after_previous_instance("crash-before");
    let mut ledger = Ledger::default();
    let key = instance(INVOCATION_A, 1);

    let (mut meter, _) = RuntimeMeter::recover(&store, key.clone(), at(1)).unwrap();
    meter.apply(&snapshot(vec![live("c1", "sub-a", 100, 0)]));
    meter.commit(&store, at(2)).unwrap();
    ledger.deliver(&mut meter, false);
    meter.apply(&updates(vec![update("c1", 40, 0)]));
    drop(meter); // crash: the 40 bytes were counted in memory only

    let (mut meter, _) = RuntimeMeter::recover(&store, key, at(3)).unwrap();
    // The acknowledgement was not committed, so the applied batch is resent.
    assert!(
        meter
            .sendable()
            .iter()
            .all(|batch| ledger.applied.contains_key(&batch.report_id))
    );
    meter.apply(&snapshot(vec![live("c1", "sub-a", 160, 0)]));
    meter.commit(&store, at(4)).unwrap();
    ledger.deliver(&mut meter, false);

    assert_eq!(ledger.total("sub-a"), (160, 0));
}

#[test]
fn crash_after_commit_resends_the_identical_report_and_lost_ack_is_a_duplicate() {
    let store = store_after_previous_instance("crash-after");
    let mut ledger = Ledger::default();
    let key = instance(INVOCATION_A, 1);

    let (mut meter, _) = RuntimeMeter::recover(&store, key.clone(), at(1)).unwrap();
    meter.apply(&snapshot(vec![live("c1", "sub-a", 70, 7)]));
    meter.commit(&store, at(2)).unwrap();
    let sealed = meter.sendable().to_vec();
    assert_eq!(sealed.len(), 1);
    ledger.deliver(&mut meter, true); // applied upstream, acknowledgement lost
    drop(meter);

    let (mut meter, _) = RuntimeMeter::recover(&store, key, at(3)).unwrap();
    assert_eq!(meter.sendable(), sealed.as_slice(), "report ids are stable");
    meter.apply(&snapshot(vec![live("c1", "sub-a", 70, 7)]));
    ledger.deliver(&mut meter, false);
    meter.commit(&store, at(4)).unwrap();

    assert!(meter.sendable().is_empty());
    assert_eq!(ledger.total("sub-a"), (70, 7));
}

#[test]
fn a_failed_commit_keeps_batches_unsendable_and_retries_the_same_ids() {
    let dir = test_dir("failed-commit");
    std::fs::write(&dir, b"not a directory").unwrap();
    let broken = CheckpointStore::new(&dir);
    let healthy = store_after_previous_instance("failed-commit-healthy");

    let (mut meter, _) = RuntimeMeter::recover(&healthy, instance(INVOCATION_A, 1), at(1)).unwrap();
    meter.apply(&snapshot(vec![live("c1", "sub-a", 10, 0)]));
    assert!(matches!(
        meter.commit(&broken, at(2)),
        Err(StoreError::Write(_))
    ));
    assert!(meter.sendable().is_empty());

    meter.commit(&healthy, at(3)).unwrap();
    let sent = meter.sendable();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].window_ended_at, at(2), "sealed once, retried as is");
}

#[test]
fn replayed_closed_connections_are_not_paid_again_after_restart() {
    let store = store_after_previous_instance("closed-replay");
    let mut ledger = Ledger::default();
    let key = instance(INVOCATION_A, 1);

    let (mut meter, _) = RuntimeMeter::recover(&store, key.clone(), at(1)).unwrap();
    meter.apply(&snapshot(vec![
        live("c1", "sub-a", 0, 0),
        live("c2", "sub-b", 5, 0),
    ]));
    meter.apply(&updates(vec![closed("c1", "sub-a", 30, 3)]));
    meter.commit(&store, at(2)).unwrap();
    ledger.deliver(&mut meter, false);
    drop(meter); // c2 closes at 25 bytes while the agent is down

    let (mut meter, _) = RuntimeMeter::recover(&store, key, at(3)).unwrap();
    let replay = || {
        snapshot(vec![
            closed_history("c1", "sub-a", 30, 3),
            closed_history("c2", "sub-b", 25, 0),
        ])
    };
    meter.apply(&replay());
    meter.apply(&replay()); // stream reconnect replays the history again
    meter.commit(&store, at(4)).unwrap();
    ledger.deliver(&mut meter, false);

    assert_eq!(ledger.total("sub-a"), (30, 3));
    assert_eq!(ledger.total("sub-b"), (25, 0));
}

#[test]
fn missing_checkpoint_baselines_without_historical_recharge() {
    let store = CheckpointStore::new(&test_dir("missing"));
    let mut ledger = Ledger::default();

    let (mut meter, recovery) =
        RuntimeMeter::recover(&store, instance(INVOCATION_A, 1), at(1)).unwrap();
    assert!(matches!(
        recovery,
        Recovery::Baseline(BaselineReason::NoCheckpoint)
    ));
    meter.apply(&updates(vec![update("c1", 999, 999)]));
    assert_eq!(meter.commit(&store, at(2)).unwrap(), Commit::Deferred);
    assert!(!store_path_exists(&store));

    meter.apply(&snapshot(vec![
        live("c1", "sub-a", 5_000, 50),
        closed_history("c0", "sub-b", 700, 7),
    ]));
    meter.apply(&updates(vec![update("c1", 25, 5)]));
    meter.commit(&store, at(3)).unwrap();
    ledger.deliver(&mut meter, false);

    assert_eq!(ledger.total("sub-a"), (25, 5));
    assert_eq!(ledger.total("sub-b"), (0, 0));
}

#[test]
fn damaged_checkpoint_is_moved_aside_and_baselined() {
    let dir = test_dir("damaged");
    let store = CheckpointStore::new(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(store.path(), b"{\"schema\":1,").unwrap();

    let (_, recovery) = RuntimeMeter::recover(&store, instance(INVOCATION_A, 1), at(1)).unwrap();
    assert!(matches!(
        recovery,
        Recovery::Baseline(BaselineReason::Damaged(Damage::Decode(_)))
    ));
    assert!(!store_path_exists(&store));
    assert!(dir.join("runtime.checkpoint.damaged.json").exists());

    let (_, recovery) = RuntimeMeter::recover(&store, instance(INVOCATION_A, 1), at(2)).unwrap();
    assert!(matches!(
        recovery,
        Recovery::Baseline(BaselineReason::NoCheckpoint)
    ));
}

#[test]
fn future_schema_checkpoint_is_damaged() {
    let store = store_after_previous_instance("future-schema");
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(store.path()).unwrap()).unwrap();
    value["schema"] = serde_json::json!(2);
    std::fs::write(store.path(), serde_json::to_vec(&value).unwrap()).unwrap();

    let (_, recovery) = RuntimeMeter::recover(&store, instance(INVOCATION_C, 1), at(1)).unwrap();
    assert!(matches!(
        recovery,
        Recovery::Baseline(BaselineReason::Damaged(Damage::Invalid(_)))
    ));
}

#[test]
fn runtime_replacement_starts_fresh_counters_and_carries_the_outbox() {
    let store = store_after_previous_instance("replacement");
    let mut ledger = Ledger::default();
    let old = instance(INVOCATION_A, 1);

    let (mut meter, _) = RuntimeMeter::recover(&store, old.clone(), at(1)).unwrap();
    meter.apply(&snapshot(vec![live("c1", "sub-a", 100, 0)]));
    meter.commit(&store, at(2)).unwrap();
    let undelivered = meter.sendable().to_vec();
    drop(meter); // runtime restarted under a new invocation before delivery

    let new = instance(INVOCATION_B, 1);
    let (mut meter, recovery) = RuntimeMeter::recover(&store, new.clone(), at(3)).unwrap();
    assert!(matches!(
        &recovery,
        Recovery::NewInstance { previous, previous_committed_at }
            if *previous == old && *previous_committed_at == at(2)
    ));
    assert_eq!(meter.sendable(), undelivered.as_slice());
    // The fresh process reports its own connection from zero.
    meter.apply(&snapshot(vec![live("d1", "sub-a", 40, 4)]));
    meter.commit(&store, at(4)).unwrap();
    ledger.deliver(&mut meter, false);

    assert_eq!(ledger.total("sub-a"), (140, 4));
    assert_eq!(meter.instance(), &new);
}

fn store_path_exists(store: &CheckpointStore) -> bool {
    store.path().exists()
}
