//! Restart-safety fixtures: agent restart with a long connection, crash
//! before and after commit, lost acknowledgement, closed-connection replay,
//! missing and damaged checkpoints, runtime replacement, retention and
//! inbound/identity filtering.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::{DateTime, Duration, Utc};

use super::*;
use crate::accountant::ConnectionEventType;
use crate::service::{Generation, InvocationId, RuntimeInstance, ServiceIdentity};
use crate::stats::{Connection, ConnectionEvent, ConnectionEvents};
use crate::traffic::Batch;

const INVOCATION_A: &str = "0123456789abcdef0123456789abcdef";
const INVOCATION_B: &str = "fedcba9876543210fedcba9876543210";
const INVOCATION_C: &str = "00000000000000000000000000000c0c";
const USER_A: &str = "blz.1.2.5.n1sub-a";
const USER_B: &str = "blz.1.2.5.n1sub-b";

fn at(seconds: i64) -> DateTime<Utc> {
    DateTime::from_timestamp(1_800_000_000 + seconds, 0).unwrap()
}

fn coded(node: &str, subscription: &str) -> String {
    format!(
        "blz.1.{}.{}.{node}{subscription}",
        node.len(),
        subscription.len()
    )
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

fn classification() -> InboundClassification {
    InboundClassification::new([
        ("node-n1".to_string(), InboundKind::Subscriber),
        ("node-n2".to_string(), InboundKind::Subscriber),
        ("peer-b".to_string(), InboundKind::Peer),
        ("probe".to_string(), InboundKind::Probe),
    ])
    .unwrap()
}

fn live_on(inbound: &str, id: &str, user: &str, uplink: i64, downlink: i64) -> ConnectionEvent {
    ConnectionEvent {
        r#type: ConnectionEventType::New as i32,
        id: id.to_owned(),
        connection: Some(Connection {
            inbound: inbound.to_owned(),
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

fn live(id: &str, user: &str, uplink: i64, downlink: i64) -> ConnectionEvent {
    live_on("node-n1", id, user, uplink, downlink)
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

fn closed_history_at(
    id: &str,
    user: &str,
    uplink: i64,
    downlink: i64,
    closed_at: DateTime<Utc>,
) -> ConnectionEvent {
    let millis = closed_at.timestamp_millis();
    let mut event = live(id, user, uplink, downlink);
    let connection = event.connection.as_mut().unwrap();
    connection.closed_at = millis;
    event.closed_at = millis;
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

fn recover(
    store: &CheckpointStore,
    key: InstanceKey,
    now: DateTime<Utc>,
) -> Result<(RuntimeMeter, Recovery), StoreError> {
    RuntimeMeter::recover(store, key, classification(), now)
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
    let (mut meter, _) = recover(&store, instance(INVOCATION_C, 1), at(0)).unwrap();
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

    let (mut meter, recovery) = recover(&store, key.clone(), at(1)).unwrap();
    assert!(matches!(recovery, Recovery::NewInstance { .. }));
    meter.apply(&snapshot(vec![live("c1", USER_A, 100, 10)]));
    meter.apply(&updates(vec![update("c1", 50, 0)]));
    meter.commit(&store, at(2)).unwrap();
    ledger.deliver(&mut meter, false);
    drop(meter); // agent restart; the runtime keeps serving c1

    let (mut meter, recovery) = recover(&store, key, at(3)).unwrap();
    assert!(matches!(recovery, Recovery::Resumed { committed_at } if committed_at == at(2)));
    meter.apply(&snapshot(vec![live("c1", USER_A, 180, 10)]));
    meter.apply(&updates(vec![update("c1", 20, 5)]));
    meter.commit(&store, at(4)).unwrap();
    ledger.deliver(&mut meter, false);

    assert_eq!(ledger.total(USER_A), (200, 15));
}

#[test]
fn crash_before_commit_recomputes_uncommitted_progress_once() {
    let store = store_after_previous_instance("crash-before");
    let mut ledger = Ledger::default();
    let key = instance(INVOCATION_A, 1);

    let (mut meter, _) = recover(&store, key.clone(), at(1)).unwrap();
    meter.apply(&snapshot(vec![live("c1", USER_A, 100, 0)]));
    meter.commit(&store, at(2)).unwrap();
    ledger.deliver(&mut meter, false);
    meter.apply(&updates(vec![update("c1", 40, 0)]));
    drop(meter); // crash: the 40 bytes were counted in memory only

    let (mut meter, _) = recover(&store, key, at(3)).unwrap();
    // The acknowledgement was not committed, so the applied batch is resent.
    assert!(
        meter
            .sendable()
            .iter()
            .all(|batch| ledger.applied.contains_key(&batch.report_id))
    );
    meter.apply(&snapshot(vec![live("c1", USER_A, 160, 0)]));
    meter.commit(&store, at(4)).unwrap();
    ledger.deliver(&mut meter, false);

    assert_eq!(ledger.total(USER_A), (160, 0));
}

#[test]
fn crash_after_commit_resends_the_identical_report_and_lost_ack_is_a_duplicate() {
    let store = store_after_previous_instance("crash-after");
    let mut ledger = Ledger::default();
    let key = instance(INVOCATION_A, 1);

    let (mut meter, _) = recover(&store, key.clone(), at(1)).unwrap();
    meter.apply(&snapshot(vec![live("c1", USER_A, 70, 7)]));
    meter.commit(&store, at(2)).unwrap();
    let sealed = meter.sendable().to_vec();
    assert_eq!(sealed.len(), 1);
    ledger.deliver(&mut meter, true); // applied upstream, acknowledgement lost
    drop(meter);

    let (mut meter, _) = recover(&store, key, at(3)).unwrap();
    assert_eq!(meter.sendable(), sealed.as_slice(), "report ids are stable");
    meter.apply(&snapshot(vec![live("c1", USER_A, 70, 7)]));
    ledger.deliver(&mut meter, false);
    meter.commit(&store, at(4)).unwrap();

    assert!(meter.sendable().is_empty());
    assert_eq!(ledger.total(USER_A), (70, 7));
}

#[test]
fn a_failed_commit_keeps_batches_unsendable_and_retries_the_same_ids() {
    let dir = test_dir("failed-commit");
    std::fs::write(&dir, b"not a directory").unwrap();
    let broken = CheckpointStore::new(&dir);
    let healthy = store_after_previous_instance("failed-commit-healthy");

    let (mut meter, _) = recover(&healthy, instance(INVOCATION_A, 1), at(1)).unwrap();
    meter.apply(&snapshot(vec![live("c1", USER_A, 10, 0)]));
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

    let (mut meter, _) = recover(&store, key.clone(), at(1)).unwrap();
    meter.apply(&snapshot(vec![
        live("c1", USER_A, 0, 0),
        live("c2", USER_B, 5, 0),
    ]));
    meter.apply(&updates(vec![closed("c1", USER_A, 30, 3)]));
    meter.commit(&store, at(2)).unwrap();
    ledger.deliver(&mut meter, false);
    drop(meter); // c2 closes at 25 bytes while the agent is down

    let (mut meter, _) = recover(&store, key, at(3)).unwrap();
    let replay = || {
        snapshot(vec![
            closed_history("c1", USER_A, 30, 3),
            closed_history("c2", USER_B, 25, 0),
        ])
    };
    meter.apply(&replay());
    meter.apply(&replay()); // stream reconnect replays the history again
    meter.commit(&store, at(4)).unwrap();
    ledger.deliver(&mut meter, false);

    assert_eq!(ledger.total(USER_A), (30, 3));
    assert_eq!(ledger.total(USER_B), (25, 0));
}

#[test]
fn missing_checkpoint_baselines_without_historical_recharge() {
    let store = CheckpointStore::new(&test_dir("missing"));
    let mut ledger = Ledger::default();

    let (mut meter, recovery) = recover(&store, instance(INVOCATION_A, 1), at(1)).unwrap();
    assert!(matches!(
        recovery,
        Recovery::Baseline {
            reason: BaselineReason::NoCheckpoint,
            unobservable: UnobservableWindow { started_at: None, ended_at },
        } if ended_at == at(1)
    ));
    meter.apply(&updates(vec![update("c1", 999, 999)]));
    assert_eq!(
        meter.commit(&store, at(2)).unwrap(),
        Commit::Deferred(DeferredReason::AwaitingBaseline)
    );
    assert!(!store_path_exists(&store));

    meter.apply(&snapshot(vec![
        live("c1", USER_A, 5_000, 50),
        closed_history("c0", USER_B, 700, 7),
    ]));
    meter.apply(&updates(vec![update("c1", 25, 5)]));
    meter.commit(&store, at(3)).unwrap();
    ledger.deliver(&mut meter, false);

    assert_eq!(ledger.total(USER_A), (25, 5));
    assert_eq!(ledger.total(USER_B), (0, 0));
}

#[test]
fn damaged_checkpoint_is_moved_aside_and_baselined() {
    let dir = test_dir("damaged");
    let store = CheckpointStore::new(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(store.path(), b"{\"schema\":1,").unwrap();

    let (_, recovery) = recover(&store, instance(INVOCATION_A, 1), at(1)).unwrap();
    assert!(matches!(
        recovery,
        Recovery::Baseline {
            reason: BaselineReason::Damaged(Damage::Decode(_)),
            ..
        }
    ));
    assert!(!store_path_exists(&store));
    assert!(dir.join("runtime.checkpoint.damaged.json").exists());

    let (_, recovery) = recover(&store, instance(INVOCATION_A, 1), at(2)).unwrap();
    assert!(matches!(
        recovery,
        Recovery::Baseline {
            reason: BaselineReason::NoCheckpoint,
            ..
        }
    ));
}

#[test]
fn checkpoint_without_legacy_import_tombstones_still_resumes() {
    let store = store_after_previous_instance("legacy-field-default");
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(store.path()).unwrap()).unwrap();
    value.as_object_mut().unwrap().remove("legacyImported");
    std::fs::write(store.path(), serde_json::to_vec(&value).unwrap()).unwrap();

    let key = instance(INVOCATION_C, 1);
    let (_, recovery) = recover(&store, key, at(1)).unwrap();
    assert!(matches!(recovery, Recovery::Resumed { .. }));
}

#[test]
fn future_schema_checkpoint_is_damaged() {
    let store = store_after_previous_instance("future-schema");
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(store.path()).unwrap()).unwrap();
    value["schema"] = serde_json::json!(2);
    std::fs::write(store.path(), serde_json::to_vec(&value).unwrap()).unwrap();

    let (_, recovery) = recover(&store, instance(INVOCATION_C, 1), at(1)).unwrap();
    assert!(matches!(
        recovery,
        Recovery::Baseline {
            reason: BaselineReason::Damaged(Damage::Invalid(_)),
            ..
        }
    ));
}

#[test]
fn runtime_replacement_starts_fresh_counters_and_carries_the_outbox() {
    let store = store_after_previous_instance("replacement");
    let mut ledger = Ledger::default();
    let old = instance(INVOCATION_A, 1);

    let (mut meter, _) = recover(&store, old.clone(), at(1)).unwrap();
    meter.apply(&snapshot(vec![live("c1", USER_A, 100, 0)]));
    meter.commit(&store, at(2)).unwrap();
    let undelivered = meter.sendable().to_vec();
    drop(meter); // runtime restarted under a new invocation before delivery

    let new = instance(INVOCATION_B, 1);
    let (mut meter, recovery) = recover(&store, new.clone(), at(3)).unwrap();
    assert!(matches!(
        &recovery,
        Recovery::NewInstance {
            previous,
            previous_committed_at,
            unobservable: UnobservableWindow {
                started_at: Some(started_at),
                ended_at,
            },
        } if *previous == old
            && *previous_committed_at == at(2)
            && *started_at == at(2)
            && *ended_at == at(3)
    ));
    assert_eq!(meter.sendable(), undelivered.as_slice());
    // The fresh process reports its own connection from zero.
    meter.apply(&snapshot(vec![live("d1", USER_A, 40, 4)]));
    meter.commit(&store, at(4)).unwrap();
    ledger.deliver(&mut meter, false);

    assert_eq!(ledger.total(USER_A), (140, 4));
    assert_eq!(meter.instance(), &new);
}

#[test]
fn a_full_closed_history_reports_the_evicted_unobservable_window() {
    let store = store_after_previous_instance("closed-history-gap");
    let (mut meter, _) = recover(&store, instance(INVOCATION_A, 1), at(1)).unwrap();
    meter.apply(&snapshot(Vec::new()));
    meter.commit(&store, at(2)).unwrap();

    let oldest = at(2) + Duration::seconds(1);
    let short: Vec<ConnectionEvent> = (0..crate::stats::CLOSED_HISTORY_LIMIT - 1)
        .map(|index| {
            closed_history_at(
                &format!("short-{index}"),
                USER_A,
                1,
                0,
                oldest + Duration::milliseconds(index as i64),
            )
        })
        .collect();
    assert!(meter.apply(&snapshot(short)).closed_history_gap.is_none());

    let events = (0..crate::stats::CLOSED_HISTORY_LIMIT)
        .map(|index| {
            closed_history_at(
                &format!("history-{index}"),
                USER_A,
                1,
                0,
                oldest + Duration::milliseconds(index as i64),
            )
        })
        .collect();
    let report = meter.apply(&snapshot(events));
    let window = report.closed_history_gap.expect("overflow window");
    assert_eq!(window.started_at, Some(at(2)));
    assert_eq!(window.ended_at, oldest);
}

#[test]
fn peer_probe_and_undecodable_events_never_enter_accounting() {
    let store = store_after_previous_instance("filtering");
    let mut ledger = Ledger::default();
    let (mut meter, _) = recover(&store, instance(INVOCATION_A, 1), at(1)).unwrap();

    meter.apply(&snapshot(vec![
        live_on("peer-b", "peer-1", "link-peer", 900, 900),
        live_on("probe", "probe-1", "probe", 800, 800),
        live_on("node-n2", "bad-1", "bare-subscription", 700, 0),
        live_on("node-n2", "c2", USER_B, 20, 2),
    ]));
    meter.commit(&store, at(2)).unwrap();
    ledger.deliver(&mut meter, false);

    assert_eq!(ledger.total(USER_B), (20, 2));
    assert_eq!(meter.filter_counts().peer_events, 1);
    assert_eq!(meter.filter_counts().probe_events, 1);
    assert_eq!(meter.filter_counts().undecodable_identities, 1);
    assert_eq!(ledger.total("link-peer"), (0, 0));
    assert_eq!(ledger.total("probe"), (0, 0));
    assert_eq!(ledger.total("bare-subscription"), (0, 0));
}

#[test]
fn a_missing_or_unknown_inbound_latches_unproven_and_defers_commit() {
    let store = store_after_previous_instance("unproven");
    let (mut meter, _) = recover(&store, instance(INVOCATION_A, 1), at(1)).unwrap();

    meter.apply(&updates(vec![update("c1", 10, 0)]));
    let mut event = live("c1", USER_A, 10, 0);
    event.connection.as_mut().unwrap().inbound.clear();
    meter.apply(&snapshot(vec![event]));
    assert_eq!(
        meter.commit(&store, at(2)).unwrap(),
        Commit::Deferred(DeferredReason::UnprovenInboundClassification)
    );
    assert!(meter.sendable().is_empty());
    assert_eq!(meter.filter_counts().missing_inbound, 1);

    // A later complete snapshot cannot clear the latch for this instance.
    meter.apply(&snapshot(vec![live("c1", USER_A, 10, 0)]));
    assert_eq!(
        meter.commit(&store, at(3)).unwrap(),
        Commit::Deferred(DeferredReason::UnprovenInboundClassification)
    );
}

#[test]
fn expired_batches_are_removed_with_a_durable_commit() {
    let store = store_after_previous_instance("expiry");
    let (mut meter, _) = recover(&store, instance(INVOCATION_A, 1), at(1)).unwrap();
    meter.apply(&snapshot(vec![live("c1", USER_A, 10, 0)]));
    meter.commit(&store, at(2)).unwrap();
    assert_eq!(meter.sendable().len(), 1);

    let expired = meter.expire(at(2) + Duration::days(8), Duration::days(7));
    assert_eq!(
        expired,
        Expired {
            reports: 1,
            entries: 1
        }
    );
    assert!(meter.sendable().is_empty());
    meter.commit(&store, at(2) + Duration::days(8)).unwrap();

    let (meter, recovery) =
        recover(&store, instance(INVOCATION_A, 1), at(2) + Duration::days(8)).unwrap();
    assert!(matches!(recovery, Recovery::Resumed { .. }));
    assert!(meter.sendable().is_empty());
}

#[test]
fn legacy_import_keeps_ids_and_tombstones_acknowledged_batches() {
    let key = instance(INVOCATION_A, 1);
    let store = store_after_previous_instance("legacy-import");
    let (mut meter, _) = recover(&store, key.clone(), at(1)).unwrap();
    let legacy = Batch {
        version: crate::traffic::BATCH_FORMAT_VERSION,
        report_id: "legacy-report-0001".to_string(),
        window_started_at: at(0),
        window_ended_at: at(1),
        entries: vec![crate::traffic::BatchEntry {
            subscription_id: USER_A.to_string(),
            uplink_bytes: 40,
            downlink_bytes: 4,
        }],
    };
    let summary = meter.import_batches(std::slice::from_ref(&legacy)).unwrap();
    assert_eq!(summary.imported, 1);
    meter.commit(&store, at(2)).unwrap();
    assert_eq!(meter.sendable(), std::slice::from_ref(&legacy));

    meter.acknowledge(&legacy.report_id);
    meter.commit(&store, at(3)).unwrap();
    drop(meter);

    let (mut meter, _) = recover(&store, key, at(4)).unwrap();
    assert!(meter.sendable().is_empty());
    let summary = meter.import_batches(std::slice::from_ref(&legacy)).unwrap();
    assert_eq!(summary.duplicates, 1);
    assert!(meter.sendable().is_empty());
}

#[test]
fn conflicting_legacy_ids_fail_closed() {
    let key = instance(INVOCATION_A, 1);
    let store = CheckpointStore::new(&test_dir("legacy-conflict"));
    let (mut meter, _) = recover(&store, key, at(1)).unwrap();
    let batch = Batch {
        version: crate::traffic::BATCH_FORMAT_VERSION,
        report_id: "legacy-report-0002".to_string(),
        window_started_at: at(0),
        window_ended_at: at(1),
        entries: vec![crate::traffic::BatchEntry {
            subscription_id: USER_A.to_string(),
            uplink_bytes: 1,
            downlink_bytes: 1,
        }],
    };
    meter.import_batches(std::slice::from_ref(&batch)).unwrap();
    let mut conflicting = batch.clone();
    conflicting.entries[0].uplink_bytes = 2;
    assert!(matches!(
        meter.import_batches(&[conflicting]),
        Err(ImportError::Conflict { .. })
    ));
}

fn store_path_exists(store: &CheckpointStore) -> bool {
    store.path().exists()
}

#[allow(dead_code)]
fn _assert_path(_: &Path) {}
