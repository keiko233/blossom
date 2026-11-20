//! Worker-level fixtures: instance replacement invalidates old streams,
//! unattributed windows, legacy queue import and retention.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, Utc};
use futures_util::StreamExt as _;

use super::{
    ConnectionEventSource, MeteringConfig, MeteringState, MeteringWorker, RuntimeObservation,
    StatsEndpoint,
};
use crate::metering::{
    ApplyOutcome, Commit, Expired, InboundClassification, InboundKind, LegacyImport, Recovery,
};
use crate::service::{Generation, InvocationId, RuntimeInstance, ServiceIdentity};
use crate::stats::{Connection, ConnectionEvent, ConnectionEvents};
use crate::traffic::{BATCH_FORMAT_VERSION, Batch, BatchEntry, ReportSink, SendOutcome};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const INVOCATION_A: &str = "0123456789abcdef0123456789abcdef";
const INVOCATION_B: &str = "fedcba9876543210fedcba9876543210";
const INVOCATION_C: &str = "00000000000000000000000000000c0c";
const USER_A: &str = "blz.1.2.5.n1sub-a";

fn at(seconds: i64) -> DateTime<Utc> {
    DateTime::from_timestamp(1_800_000_000 + seconds, 0).unwrap()
}

fn test_dir(name: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "blossom-metering-worker-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn instance(invocation: &str, generation: u64) -> RuntimeInstance {
    let invocation: InvocationId =
        serde_json::from_value(serde_json::json!({ "kind": "systemd", "id": invocation })).unwrap();
    RuntimeInstance {
        service: ServiceIdentity::SingBox,
        generation: Generation(generation),
        invocation,
    }
}

fn classification() -> InboundClassification {
    InboundClassification::new([
        ("node-n1".to_string(), InboundKind::Subscriber),
        ("peer-b".to_string(), InboundKind::Peer),
    ])
    .unwrap()
}

fn live(id: &str, user: &str, uplink: i64, downlink: i64) -> ConnectionEvent {
    ConnectionEvent {
        r#type: 0,
        id: id.to_owned(),
        connection: Some(Connection {
            inbound: "node-n1".to_owned(),
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

fn snapshot(events: Vec<ConnectionEvent>) -> ConnectionEvents {
    ConnectionEvents {
        events,
        reset: true,
    }
}

fn observation(instance: RuntimeInstance) -> RuntimeObservation {
    RuntimeObservation::Attributed {
        instance,
        classification: classification(),
        endpoint: StatsEndpoint::new("127.0.0.1:9", Some("fixture-secret".to_string())),
    }
}

#[derive(Clone)]
struct Sink {
    sent: Arc<Mutex<Vec<Batch>>>,
    outcome: SinkOutcome,
}

#[derive(Clone, Copy)]
enum SinkOutcome {
    Delivered,
    Retry,
}

impl Sink {
    fn delivered() -> Self {
        Self {
            sent: Arc::new(Mutex::new(Vec::new())),
            outcome: SinkOutcome::Delivered,
        }
    }

    fn retrying() -> Self {
        Self {
            sent: Arc::new(Mutex::new(Vec::new())),
            outcome: SinkOutcome::Retry,
        }
    }

    fn sent(&self) -> Vec<Batch> {
        self.sent.lock().unwrap().clone()
    }
}

impl ReportSink for Sink {
    async fn send(&self, batch: &Batch) -> SendOutcome {
        self.sent.lock().unwrap().push(batch.clone());
        match self.outcome {
            SinkOutcome::Delivered => SendOutcome::Delivered {
                acknowledged_id: true,
            },
            SinkOutcome::Retry => SendOutcome::Retry("fixture session offline".to_string()),
        }
    }
}

#[tokio::test]
async fn replacement_finalises_the_old_meter_and_invalidates_its_stream() {
    let state_dir = test_dir("replacement");
    let mut state = MeteringState::open(MeteringConfig::new(&state_dir), at(0)).unwrap();
    // An earlier committed instance makes the first attach below a provably
    // new instance rather than a baseline.
    let previous = state
        .observe(observation(instance(INVOCATION_C, 1)), at(0))
        .unwrap();
    state.apply(previous.stream.unwrap(), &snapshot(Vec::new()));
    state.flush(&Sink::delivered(), at(0)).await.unwrap();

    let first = state
        .observe(observation(instance(INVOCATION_A, 1)), at(1))
        .unwrap();
    assert!(first.changed);
    let stream_a = first.stream.expect("attached stream");
    let applied = state.apply(stream_a, &snapshot(vec![live("c1", USER_A, 10, 1)]));
    assert!(matches!(applied, ApplyOutcome::Applied(_)));

    let second = state
        .observe(observation(instance(INVOCATION_B, 1)), at(2))
        .unwrap();
    assert!(second.changed);
    assert!(matches!(
        second.recovery,
        Some(Recovery::NewInstance { .. })
    ));
    let stream_b = second.stream.expect("replacement stream");
    assert_ne!(stream_a, stream_b);

    // A late message from the old subscription cannot reach the new meter.
    assert!(matches!(
        state.apply(stream_a, &snapshot(vec![live("old", USER_A, 90, 0)])),
        ApplyOutcome::Stale
    ));
    let applied = state.apply(stream_b, &snapshot(vec![live("d1", USER_A, 20, 2)]));
    assert!(matches!(applied, ApplyOutcome::Applied(_)));

    let sink = Sink::delivered();
    let report = state.flush(&sink, at(3)).await.unwrap();
    assert!(report.delivered >= 1);
    let total: (i64, i64) = sink
        .sent()
        .iter()
        .flat_map(|batch| &batch.entries)
        .fold((0, 0), |total, entry| {
            (total.0 + entry.uplink_bytes, total.1 + entry.downlink_bytes)
        });
    assert_eq!(total, (30, 3), "old and new instance totals are paid once");
}

#[tokio::test]
async fn unattributed_window_starts_at_the_last_attributed_observation() {
    let state_dir = test_dir("unattributed");
    let mut state = MeteringState::open(MeteringConfig::new(&state_dir), at(1)).unwrap();
    let observed = state
        .observe(observation(instance(INVOCATION_A, 1)), at(1))
        .unwrap();
    let stream = observed.stream.unwrap();
    state.apply(stream, &snapshot(vec![live("c1", USER_A, 5, 0)]));
    assert_eq!(state.shutdown(at(2)).unwrap(), Some(Commit::Committed));

    // Reattach after the stop: the same invocation resumes its checkpoint.
    let observed = state
        .observe(observation(instance(INVOCATION_A, 1)), at(3))
        .unwrap();
    assert!(matches!(observed.recovery, Some(Recovery::Resumed { .. })));
    assert_eq!(observed.stream, Some(stream + 1));

    let unattributed = state
        .observe(RuntimeObservation::Unattributed, at(10))
        .unwrap();
    let window = unattributed.unattributed.expect("unattributed window");
    assert_eq!(window.started_at, at(3));
    assert_eq!(window.ended_at, at(10));
    assert!(matches!(
        state.apply(stream + 1, &snapshot(vec![live("late", USER_A, 9, 0)])),
        ApplyOutcome::Stale
    ));
}

#[tokio::test]
async fn legacy_queue_is_imported_under_its_id_and_removed_after_commit() {
    let state_dir = test_dir("legacy");
    let pending = state_dir.join("traffic/pending");
    std::fs::create_dir_all(&pending).unwrap();
    let batch = Batch {
        version: BATCH_FORMAT_VERSION,
        report_id: "legacy-report-0001".to_string(),
        window_started_at: at(0),
        window_ended_at: at(1),
        entries: vec![BatchEntry {
            subscription_id: USER_A.to_string(),
            uplink_bytes: 12,
            downlink_bytes: 3,
        }],
    };
    let path = pending.join("legacy-report-0001.json");
    std::fs::write(&path, serde_json::to_vec(&batch).unwrap()).unwrap();

    let mut state = MeteringState::open(MeteringConfig::new(&state_dir), at(2)).unwrap();
    let observed = state
        .observe(observation(instance(INVOCATION_A, 1)), at(2))
        .unwrap();
    let stream = observed.stream.unwrap();
    state.apply(stream, &snapshot(Vec::new()));
    let sink = Sink::delivered();
    state.flush(&sink, at(3)).await.unwrap();

    assert_eq!(sink.sent(), vec![batch]);
    assert!(!path.exists(), "imported files are removed after commit");
}

#[test]
fn expired_legacy_files_are_discarded_and_not_imported() {
    let state_dir = test_dir("legacy-expired");
    let pending = state_dir.join("traffic/pending");
    std::fs::create_dir_all(&pending).unwrap();
    let batch = Batch {
        version: BATCH_FORMAT_VERSION,
        report_id: "legacy-report-old0".to_string(),
        window_started_at: at(0),
        window_ended_at: at(0),
        entries: vec![BatchEntry {
            subscription_id: USER_A.to_string(),
            uplink_bytes: 1,
            downlink_bytes: 0,
        }],
    };
    std::fs::write(
        pending.join("legacy-report-old0.json"),
        serde_json::to_vec(&batch).unwrap(),
    )
    .unwrap();

    let import = LegacyImport::scan(
        &state_dir.join("traffic"),
        at(1) + Duration::days(30),
        Duration::days(7),
    )
    .unwrap();
    assert_eq!(import.expired, 1);
    assert_eq!(import.batch_count(), 0);
    assert!(!pending.join("legacy-report-old0.json").exists());
}

#[tokio::test]
async fn retention_expiry_is_durable_and_never_sends_old_batches() {
    let state_dir = test_dir("retention");
    let mut state = MeteringState::open(MeteringConfig::new(&state_dir), at(1)).unwrap();
    let observed = state
        .observe(observation(instance(INVOCATION_A, 1)), at(1))
        .unwrap();
    let stream = observed.stream.unwrap();
    // First snapshot is the baseline; only traffic after it is billable.
    state.apply(stream, &snapshot(vec![live("c1", USER_A, 0, 0)]));
    let report = state.flush(&Sink::delivered(), at(2)).await.unwrap();
    assert_eq!(report.sent, 0);
    state.apply(stream, &snapshot(vec![live("c1", USER_A, 10, 0)]));
    let retrying = Sink::retrying();
    let report = state.flush(&retrying, at(2)).await.unwrap();
    assert_eq!(report.sent, 1);
    assert!(report.retry.is_some());

    let sink = Sink::delivered();
    let report = state.flush(&sink, at(2) + Duration::days(8)).await.unwrap();
    assert_eq!(
        report.expired,
        Expired {
            reports: 1,
            entries: 1
        }
    );
    assert_eq!(report.sent, 0, "expired batches are never sent");
    assert!(sink.sent().is_empty());

    let mut reopened = MeteringState::open(MeteringConfig::new(&state_dir), at(10)).unwrap();
    reopened
        .observe(observation(instance(INVOCATION_A, 1)), at(10))
        .unwrap();
    let sink = Sink::delivered();
    reopened.flush(&sink, at(10)).await.unwrap();
    assert!(sink.sent().is_empty(), "the expiry survived a restart");
}

struct FakeSource {
    streams: Mutex<VecDeque<Vec<ConnectionEvents>>>,
}

impl FakeSource {
    fn one(messages: Vec<ConnectionEvents>) -> Self {
        Self {
            streams: Mutex::new(VecDeque::from([messages])),
        }
    }
}

#[async_trait::async_trait]
impl ConnectionEventSource for FakeSource {
    async fn subscribe(
        &self,
        _endpoint: &StatsEndpoint,
        _interval: StdDuration,
    ) -> Result<super::BoxEventStream, String> {
        let Some(messages) = self.streams.lock().unwrap().pop_front() else {
            return Ok(Box::pin(futures_util::stream::pending()));
        };
        Ok(Box::pin(
            futures_util::stream::iter(messages.into_iter().map(Ok))
                .chain(futures_util::stream::pending()),
        ))
    }
}

#[tokio::test(start_paused = true)]
async fn the_entrypoint_subscribes_applies_and_flushes_durable_batches() {
    let state_dir = test_dir("worker-entrypoint");
    let state = MeteringState::open(MeteringConfig::new(&state_dir), at(1)).unwrap();
    let source = Arc::new(FakeSource::one(vec![
        snapshot(vec![live("c1", USER_A, 0, 0)]),
        snapshot(vec![live("c1", USER_A, 10, 0)]),
    ]));
    let worker = MeteringWorker::new(state, source);
    let sink = Sink::delivered();
    let (observations, receiver) = mpsc::channel(2);
    let cancel = CancellationToken::new();
    let task = tokio::spawn(worker.run(
        receiver,
        sink.clone(),
        StdDuration::from_secs(1),
        cancel.clone(),
    ));
    observations
        .send(observation(instance(INVOCATION_A, 1)))
        .await
        .unwrap();
    tokio::time::sleep(StdDuration::from_secs(3)).await;
    let total: (i64, i64) = sink
        .sent()
        .iter()
        .flat_map(|batch| &batch.entries)
        .fold((0, 0), |total, entry| {
            (total.0 + entry.uplink_bytes, total.1 + entry.downlink_bytes)
        });
    assert_eq!(total, (10, 0), "the worker delivered the charged batch");
    cancel.cancel();
    task.await.unwrap();
}
