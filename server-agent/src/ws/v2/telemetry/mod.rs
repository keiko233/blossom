//! Protocol v2 telemetry: subscriptions, coalesced sampling and inspection.
//!
//! The control plane owns the cadence. `live` subscriptions are the coalesced
//! admin stream; `history` is the independent minute cadence, subscribed on
//! `hello` even when no browser is connected. Every subscription belongs to
//! one connection, so a replaced session starts with none.
//!
//! One sampler runs per session. When several subscriptions are due at the same
//! time it takes a single host measurement and emits one sample per
//! subscription, so multiple viewers or a coincident history tick never read
//! `/proc` twice. Sampling runs on a blocking thread and replies through a
//! bounded queue, so config application and traffic acknowledgements stay
//! responsive.

#[cfg(target_os = "linux")]
mod linux;
mod network;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::time::Duration;

use chrono::Utc;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use super::codec::{
    TelemetryEnvironment, TelemetryPurpose, TelemetrySample, TelemetrySnapshot, TelemetrySubscribe,
    TelemetryUsage,
};

/// A short delay before a new subscription's first sample gives a just-opened
/// session time to queue every subscription it wants on this tick, so a live
/// and history subscription that arrive together share one host read.
const INITIAL_SAMPLE_DELAY: Duration = Duration::from_millis(50);

/// A completed host measurement, before it is labelled with a subscription.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Measurement {
    pub sampled_at: chrono::DateTime<Utc>,
    pub cpu_percent: Option<f64>,
    pub memory: Option<TelemetryUsage>,
    pub disk: Option<TelemetryUsage>,
    pub environment: TelemetryEnvironment,
    pub cgroup_version: Option<u8>,
    pub cpu_limit: Option<f64>,
    pub memory_limit: Option<u64>,
    pub scope_key: String,
    pub network: Option<super::codec::TelemetryNetwork>,
}

/// The listener/interface inspection payload, without its request id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Inspection {
    pub partial: bool,
    pub listeners: Vec<super::codec::TelemetryListener>,
    pub interfaces: Vec<super::codec::TelemetryInterface>,
}

/// Blocking host sampler. The production implementation is Linux-only; tests
/// substitute a deterministic measurement.
pub(crate) trait HostSampler: Send + 'static {
    fn measure(&mut self) -> Measurement;
    fn inspect(&self) -> Inspection;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Command {
    Subscribe(TelemetrySubscribe),
    Unsubscribe(String),
    Inspect(String),
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Output {
    Sample(TelemetrySample),
    Snapshot(TelemetrySnapshot),
}

#[derive(Debug)]
struct Subscription {
    purpose: TelemetryPurpose,
    interval: Duration,
    next_due: Instant,
}

struct Engine {
    sampler: Option<Box<dyn HostSampler>>,
    subscriptions: HashMap<String, Subscription>,
}

/// Whether this build can produce host telemetry. Capability advertisement
/// must match this.
pub(crate) fn supported() -> bool {
    cfg!(target_os = "linux")
}

/// Builds the production sampler, if this target has one.
pub(crate) fn production_sampler() -> Option<Box<dyn HostSampler>> {
    #[cfg(target_os = "linux")]
    {
        Some(Box::new(linux::LinuxSampler::default()))
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// Runs one session's telemetry subscriptions until `cancel` fires or the
/// command channel closes.
pub(crate) async fn run(
    sampler: Box<dyn HostSampler>,
    mut commands: mpsc::Receiver<Command>,
    outputs: mpsc::Sender<Output>,
    cancel: CancellationToken,
) {
    let mut engine = Engine {
        sampler: Some(sampler),
        subscriptions: HashMap::new(),
    };
    loop {
        let next_due = engine.next_due();
        tokio::select! {
            _ = cancel.cancelled() => return,
            command = commands.recv() => match command {
                Some(Command::Subscribe(subscription)) => engine.subscribe(subscription),
                Some(Command::Unsubscribe(id)) => {
                    engine.subscriptions.remove(&id);
                }
                Some(Command::Inspect(request_id)) => {
                    engine.inspect(request_id, &outputs).await;
                }
                None => return,
            },
            _ = wait_until(next_due), if next_due.is_some() => {
                engine.sample_due(&outputs).await;
            }
        }
    }
}

impl Engine {
    fn next_due(&self) -> Option<Instant> {
        self.subscriptions
            .values()
            .map(|subscription| subscription.next_due)
            .min()
    }

    fn subscribe(&mut self, subscription: TelemetrySubscribe) {
        let interval = match subscription.purpose {
            // History is the independent minute cadence even if a control
            // plane advertises something shorter.
            TelemetryPurpose::History => {
                Duration::from_millis(subscription.interval_ms.max(60_000))
            }
            TelemetryPurpose::Live => Duration::from_millis(subscription.interval_ms),
        };
        self.subscriptions.insert(
            subscription.subscription_id,
            Subscription {
                purpose: subscription.purpose,
                interval,
                next_due: Instant::now() + INITIAL_SAMPLE_DELAY,
            },
        );
    }

    async fn sample_due(&mut self, outputs: &mpsc::Sender<Output>) {
        let now = Instant::now();
        let due: Vec<(String, TelemetryPurpose)> = self
            .subscriptions
            .iter()
            .filter(|(_, subscription)| subscription.next_due <= now)
            .map(|(id, subscription)| (id.clone(), subscription.purpose))
            .collect();
        if due.is_empty() {
            return;
        }
        let Some(mut sampler) = self.sampler.take() else {
            self.subscriptions.clear();
            return;
        };
        let Ok((sampler, measurement)) = tokio::task::spawn_blocking(move || {
            let measurement = sampler.measure();
            (sampler, measurement)
        })
        .await
        else {
            warn!("telemetry sampler stopped after a panic");
            self.subscriptions.clear();
            return;
        };
        self.sampler = Some(sampler);
        let completed_at = Instant::now();
        for (subscription_id, purpose) in due {
            let sample = Measurement::sample(&measurement, purpose, subscription_id.clone());
            if outputs.try_send(Output::Sample(sample)).is_err() {
                debug!("dropping a telemetry sample because the session queue is full");
            }
            if let Some(subscription) = self.subscriptions.get_mut(&subscription_id) {
                subscription.next_due = completed_at + subscription.interval;
            }
        }
    }

    async fn inspect(&mut self, request_id: String, outputs: &mpsc::Sender<Output>) {
        let Some(sampler) = self.sampler.take() else {
            return;
        };
        let Ok((sampler, inspection)) = tokio::task::spawn_blocking(move || {
            let inspection = sampler.inspect();
            (sampler, inspection)
        })
        .await
        else {
            warn!("telemetry sampler stopped after a panic");
            self.subscriptions.clear();
            return;
        };
        self.sampler = Some(sampler);
        let snapshot = inspection.into_snapshot(request_id);
        if outputs.try_send(Output::Snapshot(snapshot)).is_err() {
            debug!("dropping a telemetry snapshot because the session queue is full");
        }
    }
}

impl Measurement {
    fn sample(&self, purpose: TelemetryPurpose, subscription_id: String) -> TelemetrySample {
        TelemetrySample {
            subscription_id: Some(subscription_id),
            purpose,
            sampled_at: self.sampled_at,
            cpu_percent: self.cpu_percent,
            memory: self.memory,
            disk: self.disk,
            environment: self.environment,
            network_scope: "agent".to_string(),
            cgroup_version: self.cgroup_version,
            cpu_limit: self.cpu_limit,
            memory_limit: self.memory_limit,
            scope_key: self.scope_key.clone(),
            network: self.network,
        }
    }
}

async fn wait_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}
