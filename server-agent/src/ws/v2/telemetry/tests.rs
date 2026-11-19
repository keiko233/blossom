//! Subscription scheduling, coalescing and inspection on paused time.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use chrono::Utc;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::{Command, HostSampler, INITIAL_SAMPLE_DELAY, Inspection, Measurement, Output, run};
use crate::ws::v2::codec::{
    TelemetryEnvironment, TelemetryInterface, TelemetryListener, TelemetryProtocol,
    TelemetryPurpose, TelemetrySample, TelemetrySnapshot, TelemetrySubscribe, TelemetryUsage,
};

struct FakeSampler {
    reads: Arc<AtomicUsize>,
}

impl HostSampler for FakeSampler {
    fn measure(&mut self) -> Measurement {
        let read = self.reads.fetch_add(1, Ordering::SeqCst) + 1;
        Measurement {
            sampled_at: Utc::now(),
            cpu_percent: Some(read as f64),
            memory: Some(TelemetryUsage {
                used: 512,
                total: 1024,
            }),
            disk: None,
            environment: TelemetryEnvironment::Systemd,
            cgroup_version: None,
            cpu_limit: None,
            memory_limit: None,
            scope_key: "systemd|-|-|-|eth0".to_string(),
            network: None,
        }
    }

    fn inspect(&self) -> Inspection {
        Inspection {
            partial: false,
            listeners: vec![TelemetryListener {
                protocol: TelemetryProtocol::Tcp,
                address: "127.0.0.1".to_string(),
                port: 8080,
            }],
            interfaces: vec![TelemetryInterface {
                name: "eth0".to_string(),
                address: "192.0.2.10".to_string(),
            }],
        }
    }
}

struct Harness {
    commands: mpsc::Sender<Command>,
    outputs: mpsc::Receiver<Output>,
    reads: Arc<AtomicUsize>,
    cancel: CancellationToken,
    task: JoinHandle<()>,
}

impl Harness {
    fn start() -> Self {
        let reads = Arc::new(AtomicUsize::new(0));
        let (commands, receiver) = mpsc::channel(8);
        let (outputs, output_receiver) = mpsc::channel(16);
        let cancel = CancellationToken::new();
        let task = tokio::spawn(run(
            Box::new(FakeSampler {
                reads: reads.clone(),
            }),
            receiver,
            outputs,
            cancel.clone(),
        ));
        Self {
            commands,
            outputs: output_receiver,
            reads,
            cancel,
            task,
        }
    }

    async fn subscribe(&self, id: &str, purpose: TelemetryPurpose, interval_ms: u64) {
        self.commands
            .send(Command::Subscribe(TelemetrySubscribe {
                subscription_id: id.to_string(),
                purpose,
                interval_ms,
            }))
            .await
            .unwrap();
    }

    async fn sample(&mut self) -> TelemetrySample {
        match self.outputs.recv().await.expect("a telemetry output") {
            Output::Sample(sample) => sample,
            other => panic!("expected a sample, got {other:?}"),
        }
    }

    async fn stop(self) {
        self.cancel.cancel();
        let _ = self.task.await;
    }
}

#[tokio::test(start_paused = true)]
async fn a_live_subscription_samples_at_its_cadence() {
    let mut harness = Harness::start();
    harness
        .subscribe("live-1", TelemetryPurpose::Live, 2_000)
        .await;
    tokio::time::advance(INITIAL_SAMPLE_DELAY).await;

    let first = harness.sample().await;
    assert_eq!(first.subscription_id.as_deref(), Some("live-1"));
    assert_eq!(first.purpose, TelemetryPurpose::Live);
    assert_eq!(harness.reads.load(Ordering::SeqCst), 1);

    tokio::time::advance(Duration::from_secs(2)).await;
    let second = harness.sample().await;
    assert_eq!(second.subscription_id.as_deref(), Some("live-1"));
    assert_eq!(harness.reads.load(Ordering::SeqCst), 2);
    harness.stop().await;
}

#[tokio::test(start_paused = true)]
async fn two_due_subscriptions_share_one_host_read() {
    let mut harness = Harness::start();
    harness
        .subscribe("live-a", TelemetryPurpose::Live, 60_000)
        .await;
    harness
        .subscribe("live-b", TelemetryPurpose::Live, 60_000)
        .await;
    tokio::time::advance(INITIAL_SAMPLE_DELAY).await;

    let first = harness.sample().await;
    let second = harness.sample().await;
    let mut ids = [
        first.subscription_id.unwrap(),
        second.subscription_id.unwrap(),
    ];
    ids.sort();
    assert_eq!(ids, ["live-a".to_string(), "live-b".to_string()]);
    assert_eq!(harness.reads.load(Ordering::SeqCst), 1);
    harness.stop().await;
}

#[tokio::test(start_paused = true)]
async fn history_runs_without_a_live_view_and_honours_a_minute_floor() {
    let mut harness = Harness::start();
    harness
        .subscribe("history-1", TelemetryPurpose::History, 1_000)
        .await;
    tokio::time::advance(INITIAL_SAMPLE_DELAY).await;
    let first = harness.sample().await;
    assert_eq!(first.purpose, TelemetryPurpose::History);
    assert_eq!(first.subscription_id.as_deref(), Some("history-1"));

    tokio::time::advance(Duration::from_secs(59)).await;
    tokio::task::yield_now().await;
    assert!(
        harness.outputs.try_recv().is_err(),
        "history must not sample faster than a minute"
    );

    tokio::time::advance(Duration::from_secs(2)).await;
    let second = harness.sample().await;
    assert_eq!(second.purpose, TelemetryPurpose::History);
    assert_eq!(harness.reads.load(Ordering::SeqCst), 2);
    harness.stop().await;
}

#[tokio::test(start_paused = true)]
async fn unsubscribe_stops_future_samples() {
    let mut harness = Harness::start();
    harness
        .subscribe("live-1", TelemetryPurpose::Live, 1_000)
        .await;
    tokio::time::advance(INITIAL_SAMPLE_DELAY).await;
    harness.sample().await;

    harness
        .commands
        .send(Command::Unsubscribe("live-1".to_string()))
        .await
        .unwrap();
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(10)).await;
    tokio::task::yield_now().await;
    assert!(harness.outputs.try_recv().is_err());
    harness.stop().await;
}

#[tokio::test(start_paused = true)]
async fn the_same_subscription_id_replaces_the_cadence() {
    let mut harness = Harness::start();
    harness
        .subscribe("live-1", TelemetryPurpose::Live, 1_000)
        .await;
    tokio::time::advance(INITIAL_SAMPLE_DELAY).await;
    harness.sample().await;

    harness
        .subscribe("live-1", TelemetryPurpose::Live, 10_000)
        .await;
    tokio::time::advance(INITIAL_SAMPLE_DELAY).await;
    harness.sample().await;

    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::task::yield_now().await;
    assert!(harness.outputs.try_recv().is_err());

    tokio::time::advance(Duration::from_secs(8)).await;
    let replaced = harness.sample().await;
    assert_eq!(replaced.subscription_id.as_deref(), Some("live-1"));
    harness.stop().await;
}

#[tokio::test(start_paused = true)]
async fn inspection_is_a_one_off_snapshot() {
    let mut harness = Harness::start();
    harness
        .commands
        .send(Command::Inspect("inspect-1".to_string()))
        .await
        .unwrap();
    let snapshot = match harness.outputs.recv().await.expect("an output") {
        Output::Snapshot(snapshot) => snapshot,
        other => panic!("expected a snapshot, got {other:?}"),
    };
    assert_eq!(
        snapshot,
        TelemetrySnapshot {
            request_id: "inspect-1".to_string(),
            partial: false,
            listeners: vec![TelemetryListener {
                protocol: TelemetryProtocol::Tcp,
                address: "127.0.0.1".to_string(),
                port: 8080,
            }],
            interfaces: vec![TelemetryInterface {
                name: "eth0".to_string(),
                address: "192.0.2.10".to_string(),
            }],
        }
    );
    tokio::task::yield_now().await;
    assert!(harness.outputs.try_recv().is_err());
    harness.stop().await;
}
