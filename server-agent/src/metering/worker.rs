//! Durable metering traffic worker.
//!
//! The worker owns one [`RuntimeMeter`] at a time. Integration supplies the
//! task 04 `RuntimeInstance`, the committed generation's inbound
//! classification, and the loopback stats endpoint. A new instance first
//! commits the old meter, then recovers the new one and subscribes again. Old
//! stream messages carry a stream id and are ignored after a switch.
//!
//! This module is deliberately not wired into `agent_v2.rs` yet. Activation
//! must reuse the existing v2 report sink, provide a complete inbound
//! classification from the committed generation, and keep the processkit path
//! unchanged until the native service lifecycle is enabled.

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use futures_util::Stream as _;
use futures_util::StreamExt as _;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use super::checkpoint::InstanceKey;
use super::filter::{FilterCounts, InboundClassification};
use super::import::LegacyImport;
use super::meter::{ApplyReport, Commit, DeferredReason, Expired, Recovery, RuntimeMeter};
use super::store::{CheckpointStore, StoreError};
use crate::service::RuntimeInstance;
use crate::stats::{ConnectionEvents, StatsClient};
use crate::traffic::{Batch, ReportSink, SendOutcome, create_private_dir, write_atomic};

const STREAM_BACKOFF_MAX: Duration = Duration::from_secs(30);
const MAX_SENDS_PER_CYCLE: usize = 20;
const MAX_REJECTED_KEPT: usize = 16;
const DEFAULT_RETENTION_DAYS: i64 = 7;

/// Metering-owned paths. The checkpoint lives under `<state_dir>/metering`;
/// the legacy queue is the existing `<state_dir>/traffic` tree.
pub(crate) struct MeteringConfig {
    pub(crate) checkpoint_dir: PathBuf,
    pub(crate) legacy_traffic_dir: PathBuf,
    pub(crate) retention: ChronoDuration,
}

impl MeteringConfig {
    #[must_use]
    pub(crate) fn new(state_dir: &Path) -> Self {
        Self {
            checkpoint_dir: state_dir.join("metering"),
            legacy_traffic_dir: state_dir.join("traffic"),
            retention: ChronoDuration::days(DEFAULT_RETENTION_DAYS),
        }
    }
}

/// A loopback stats endpoint. `Debug` never prints the per-run secret.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct StatsEndpoint {
    addr: String,
    secret: Option<String>,
}

impl StatsEndpoint {
    #[must_use]
    pub(crate) fn new(addr: impl Into<String>, secret: Option<String>) -> Self {
        Self {
            addr: addr.into(),
            secret,
        }
    }

    pub(crate) fn addr(&self) -> &str {
        &self.addr
    }

    pub(crate) fn secret(&self) -> Option<&str> {
        self.secret.as_deref()
    }
}

impl fmt::Debug for StatsEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StatsEndpoint")
            .field("addr", &self.addr)
            .field("secret", &self.secret.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

/// The task 04 observation plus the committed generation's classification.
#[derive(Debug)]
pub(crate) enum RuntimeObservation {
    Attributed {
        instance: RuntimeInstance,
        classification: InboundClassification,
        endpoint: StatsEndpoint,
    },
    /// `ServiceLifecycle::runtime_instance()` returned `None`: do not create
    /// or feed a meter for this window.
    Unattributed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UnattributedWindow {
    pub(crate) instance: Option<InstanceKey>,
    pub(crate) started_at: DateTime<Utc>,
    pub(crate) ended_at: DateTime<Utc>,
}

#[derive(Debug)]
pub(crate) struct ObservationOutcome {
    /// Whether the observation changed the active instance. When false the
    /// caller keeps the existing subscription (the instance still serves).
    pub(crate) changed: bool,
    /// `Some` when the caller must (re)subscribe under this stream id.
    pub(crate) stream: Option<u64>,
    pub(crate) recovery: Option<Recovery>,
    /// The old meter's final commit during a switch or unattributed window.
    pub(crate) detached: Option<Commit>,
    pub(crate) unattributed: Option<UnattributedWindow>,
}

#[derive(Debug)]
pub(crate) enum ApplyOutcome {
    Applied(ApplyReport),
    /// A message from a stream that was replaced by a newer observation.
    Stale,
    /// No meter is attached.
    Unattributed,
}

#[derive(Debug, Default)]
pub(crate) struct FlushReport {
    pub(crate) commit: Option<Commit>,
    pub(crate) expired: Expired,
    pub(crate) sent: usize,
    pub(crate) delivered: usize,
    pub(crate) rejected: usize,
    pub(crate) retry: Option<String>,
}

#[derive(Debug)]
pub(crate) enum MeteringError {
    Store(StoreError),
    Import(super::meter::ImportError),
    Legacy(io::Error),
    /// The same runtime instance arrived with a different classification.
    /// Classification is fixed by the generation; fail closed instead of
    /// mixing billable and peer traffic under one checkpoint.
    ClassificationChanged,
}

impl fmt::Display for MeteringError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Store(error) => error.fmt(formatter),
            Self::Import(error) => error.fmt(formatter),
            Self::Legacy(error) => write!(formatter, "cannot read legacy traffic queue: {error}"),
            Self::ClassificationChanged => formatter
                .write_str("the same runtime instance reported a different inbound classification"),
        }
    }
}

impl std::error::Error for MeteringError {}

impl From<StoreError> for MeteringError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

impl From<super::meter::ImportError> for MeteringError {
    fn from(error: super::meter::ImportError) -> Self {
        Self::Import(error)
    }
}

/// Pure state machine behind the async worker. It has no network or timer of
/// its own, so restart, replacement, retention and import tests run without a
/// live sing-box or control plane.
pub(crate) struct MeteringState {
    config: MeteringConfig,
    store: CheckpointStore,
    meter: Option<RuntimeMeter>,
    legacy: Option<LegacyImport>,
    active_stream: Option<u64>,
    next_stream: u64,
    last_observation_at: Option<DateTime<Utc>>,
    attributed_instance: Option<InstanceKey>,
}

impl MeteringState {
    pub(crate) fn open(config: MeteringConfig, now: DateTime<Utc>) -> Result<Self, MeteringError> {
        let legacy = LegacyImport::scan(&config.legacy_traffic_dir, now, config.retention)
            .map_err(MeteringError::Legacy)?;
        if legacy.expired > 0 {
            warn!(
                expired = legacy.expired,
                "discarded legacy traffic reports older than the metering retention"
            );
        }
        if legacy.rejected > 0 {
            warn!(
                rejected = legacy.rejected,
                "moved unreadable legacy traffic reports aside"
            );
        }
        let store = CheckpointStore::new(&config.checkpoint_dir);
        Ok(Self {
            config,
            store,
            meter: None,
            legacy: Some(legacy),
            active_stream: None,
            next_stream: 0,
            last_observation_at: None,
            attributed_instance: None,
        })
    }

    /// Accepts a task 04 observation. Attaching a new instance finalises the
    /// old meter before recovery and invalidates its stream id.
    pub(crate) fn observe(
        &mut self,
        observation: RuntimeObservation,
        now: DateTime<Utc>,
    ) -> Result<ObservationOutcome, MeteringError> {
        match observation {
            RuntimeObservation::Attributed {
                instance,
                classification,
                ..
            } => {
                let key = InstanceKey::from(&instance);
                if let Some(meter) = &self.meter
                    && meter.instance() == &key
                {
                    if meter.classification() != &classification {
                        return Err(MeteringError::ClassificationChanged);
                    }
                    self.last_observation_at = Some(now);
                    return Ok(ObservationOutcome {
                        changed: false,
                        stream: self.active_stream,
                        recovery: None,
                        detached: None,
                        unattributed: None,
                    });
                }

                let detached = self.detach(now)?;
                let (mut meter, recovery) =
                    RuntimeMeter::recover(&self.store, key.clone(), classification, now)?;
                if let Some(legacy) = &mut self.legacy {
                    let summary = legacy.absorb(&mut meter)?;
                    if summary.imported > 0 || summary.duplicates > 0 {
                        info!(
                            imported = summary.imported,
                            duplicates = summary.duplicates,
                            "imported the legacy traffic queue into the metering checkpoint"
                        );
                    }
                }
                self.next_stream += 1;
                let stream = self.next_stream;
                self.active_stream = Some(stream);
                self.attributed_instance = Some(key);
                self.last_observation_at = Some(now);
                self.meter = Some(meter);
                Ok(ObservationOutcome {
                    changed: true,
                    stream: Some(stream),
                    recovery: Some(recovery),
                    detached,
                    unattributed: None,
                })
            }
            RuntimeObservation::Unattributed => {
                let started_at = self.last_observation_at.unwrap_or(now);
                let instance = self.attributed_instance.take();
                self.active_stream = None;
                let detached = self.detach(now)?;
                self.last_observation_at = Some(now);
                Ok(ObservationOutcome {
                    changed: true,
                    stream: None,
                    recovery: None,
                    detached,
                    unattributed: Some(UnattributedWindow {
                        instance,
                        started_at,
                        ended_at: now,
                    }),
                })
            }
        }
    }

    pub(crate) fn active_stream(&self) -> Option<u64> {
        self.active_stream
    }

    pub(crate) fn instance(&self) -> Option<&InstanceKey> {
        self.meter.as_ref().map(RuntimeMeter::instance)
    }

    pub(crate) fn apply(&mut self, stream_id: u64, message: &ConnectionEvents) -> ApplyOutcome {
        if self.active_stream != Some(stream_id) {
            return ApplyOutcome::Stale;
        }
        let Some(meter) = self.meter.as_mut() else {
            return ApplyOutcome::Unattributed;
        };
        ApplyOutcome::Applied(meter.apply(message))
    }

    /// Seals, commits, then sends only durable batches. A rejected batch is
    /// copied to the bounded quarantine tree before it is acknowledged.
    pub(crate) async fn flush<S: ReportSink>(
        &mut self,
        sink: &S,
        now: DateTime<Utc>,
    ) -> Result<FlushReport, MeteringError> {
        let Some(meter) = self.meter.as_mut() else {
            return Ok(FlushReport::default());
        };
        let expired = meter.expire(now, self.config.retention);
        if expired.reports > 0 {
            error!(
                reports = expired.reports,
                entries = expired.entries,
                "discarding undeliverable metering reports older than the retention window; this traffic is not accounted"
            );
        }
        let mut report = FlushReport {
            expired,
            ..FlushReport::default()
        };
        let commit = if meter.needs_commit() {
            Some(meter.commit(&self.store, now)?)
        } else {
            None
        };
        if let Some(Commit::Deferred(reason)) = commit {
            report.commit = Some(Commit::Deferred(reason));
            if matches!(
                reason,
                DeferredReason::AwaitingBaseline | DeferredReason::UnprovenInboundClassification
            ) {
                return Ok(report);
            }
        } else {
            report.commit = commit;
        }

        let checkpoint_dir = self.config.checkpoint_dir.clone();
        let mut retry = None;
        for batch in meter.sendable().to_vec() {
            if report.sent >= MAX_SENDS_PER_CYCLE {
                break;
            }
            report.sent += 1;
            match sink.send(&batch).await {
                SendOutcome::Delivered { acknowledged_id } => {
                    if !acknowledged_id {
                        warn!(
                            report_id = %batch.report_id,
                            "control plane did not acknowledge the report id; a retry could be counted twice"
                        );
                    }
                    report.delivered += 1;
                    meter.acknowledge(&batch.report_id);
                }
                SendOutcome::Rejected(reason) => {
                    error!(
                        report_id = %batch.report_id,
                        "traffic report rejected permanently; copy moved aside: {reason}"
                    );
                    quarantine(&checkpoint_dir, &batch);
                    report.rejected += 1;
                    meter.acknowledge(&batch.report_id);
                }
                SendOutcome::Retry(reason) => {
                    warn!(
                        report_id = %batch.report_id,
                        "traffic report not delivered, will retry with the same id: {reason}"
                    );
                    retry = Some(reason);
                    break;
                }
            }
        }
        report.retry = retry;

        let mut finish_legacy = matches!(commit, Some(Commit::Committed));
        if meter.needs_commit() {
            match meter.commit(&self.store, now)? {
                Commit::Committed => {
                    finish_legacy = true;
                    report.commit = Some(Commit::Committed);
                }
                Commit::Deferred(reason) => report.commit = Some(Commit::Deferred(reason)),
            }
        }
        if finish_legacy {
            // The borrow of `meter` ends before this call.
            self.finish_legacy();
        }
        Ok(report)
    }

    /// Final commit on shutdown or observation loss. A failure is returned so
    /// the caller can log it; nothing is sent from here.
    pub(crate) fn shutdown(&mut self, now: DateTime<Utc>) -> Result<Option<Commit>, MeteringError> {
        self.active_stream = None;
        self.attributed_instance = None;
        self.detach(now)
    }

    fn detach(&mut self, now: DateTime<Utc>) -> Result<Option<Commit>, MeteringError> {
        let Some(mut meter) = self.meter.take() else {
            return Ok(None);
        };
        let expired = meter.expire(now, self.config.retention);
        let commit = if meter.needs_commit() || expired.reports > 0 {
            Some(meter.commit(&self.store, now)?)
        } else {
            None
        };
        if matches!(commit, Some(Commit::Committed)) {
            self.finish_legacy();
        }
        Ok(commit)
    }

    fn finish_legacy(&mut self) {
        if let Some(legacy) = self.legacy.take() {
            legacy.finish();
        }
    }
}

fn quarantine(root: &Path, batch: &Batch) {
    let dir = root.join("rejected");
    let bytes = match serde_json::to_vec(batch) {
        Ok(bytes) => bytes,
        Err(error) => {
            error!(report_id = %batch.report_id, "cannot serialize rejected report: {error}");
            return;
        }
    };
    if let Err(error) = create_private_dir(root)
        .and_then(|()| create_private_dir(&dir))
        .and_then(|()| write_atomic(&dir, &format!("{}.json", batch.report_id), &bytes))
    {
        error!(report_id = %batch.report_id, "cannot keep a rejected report copy: {error}");
        return;
    }
    if let Ok(read) = std::fs::read_dir(&dir) {
        let mut kept: Vec<PathBuf> = read.filter_map(|entry| Some(entry.ok()?.path())).collect();
        kept.sort();
        while kept.len() > MAX_REJECTED_KEPT {
            let _ = std::fs::remove_file(kept.remove(0));
        }
    }
}

/// One subscription factory. Tests inject a scripted source; production uses
/// [`TonicEventSource`] with the existing hand-written stats client.
#[async_trait]
pub(crate) trait ConnectionEventSource: Send + Sync {
    async fn subscribe(
        &self,
        endpoint: &StatsEndpoint,
        interval: Duration,
    ) -> Result<BoxEventStream, String>;
}

pub(crate) type BoxEventStream =
    Pin<Box<dyn futures_util::Stream<Item = Result<ConnectionEvents, String>> + Send>>;

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct TonicEventSource;

#[async_trait]
impl ConnectionEventSource for TonicEventSource {
    async fn subscribe(
        &self,
        endpoint: &StatsEndpoint,
        interval: Duration,
    ) -> Result<BoxEventStream, String> {
        let mut client = StatsClient::connect_lazy(endpoint.addr(), endpoint.secret())
            .map_err(|error| format!("invalid stats endpoint: {error}"))?;
        let stream = client
            .subscribe_connections(interval)
            .await
            .map_err(|error| format!("cannot subscribe to connections: {error}"))?;
        Ok(Box::pin(
            stream.map(|message| message.map_err(|error| error.to_string())),
        ))
    }
}

#[derive(Debug, Default)]
struct StreamMessage {
    stream_id: u64,
    message: ConnectionEvents,
}

pub(crate) struct MeteringWorker {
    state: MeteringState,
    source: Arc<dyn ConnectionEventSource>,
}

impl MeteringWorker {
    #[must_use]
    pub(crate) fn new(state: MeteringState, source: Arc<dyn ConnectionEventSource>) -> Self {
        Self { state, source }
    }

    /// Runs until cancelled. It flushes on a timer and after each observation
    /// change, and always final-commits before dropping an instance.
    pub(crate) async fn run<S: ReportSink>(
        self,
        mut observations: mpsc::Receiver<RuntimeObservation>,
        sink: S,
        interval: Duration,
        cancel: CancellationToken,
    ) {
        let Self { mut state, source } = self;
        let mut stream: Option<ActiveStream> = None;
        let mut events: Option<mpsc::Receiver<StreamMessage>> = None;
        let mut tick = tokio::time::interval(interval);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await;

        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    stop_stream(&mut stream);
                    if let Err(error) = state.shutdown(Utc::now()) {
                        error!("metering final commit failed on shutdown: {error}");
                    }
                    return;
                }
                observation = observations.recv() => {
                    let Some(observation) = observation else {
                        stop_stream(&mut stream);
                        if let Err(error) = state.shutdown(Utc::now()) {
                            error!("metering final commit failed: {error}");
                        }
                        return;
                    };
                    let endpoint = match &observation {
                        RuntimeObservation::Attributed { endpoint, .. } => Some(endpoint.clone()),
                        RuntimeObservation::Unattributed => None,
                    };
                    match state.observe(observation, Utc::now()) {
                        Ok(outcome) => {
                            log_observation(&outcome);
                            if outcome.changed {
                                stop_stream(&mut stream);
                                events = None;
                                if let (Some(stream_id), Some(endpoint)) = (outcome.stream, endpoint) {
                                    let (tx, rx) = mpsc::channel(64);
                                    events = Some(rx);
                                    let source = source.clone();
                                    let cancel = cancel.clone();
                                    stream = Some(ActiveStream {
                                        task: tokio::spawn(async move {
                                            run_subscription(source, endpoint, interval, stream_id, tx, cancel).await;
                                        }),
                                    });
                                }
                            }
                            if let Err(error) = state.flush(&sink, Utc::now()).await {
                                error!("metering flush after observation failed: {error}");
                            }
                        }
                        Err(error) => {
                            error!("metering observation rejected: {error}");
                            stop_stream(&mut stream);
                            events = None;
                        }
                    }
                }
                message = recv_stream(&mut events) => {
                    let Some(message) = message else { continue };
                    match state.apply(message.stream_id, &message.message) {
                        ApplyOutcome::Applied(report) => {
                            if report.unproven {
                                error!("metering stopped: inbound identity/classification cannot be proven");
                            }
                            if report.counts != FilterCounts::default() {
                                warn!(
                                    peer = report.counts.peer_events,
                                    probe = report.counts.probe_events,
                                    unknown_tags = report.counts.unknown_tags,
                                    missing_inbound = report.counts.missing_inbound,
                                    undecodable = report.counts.undecodable_identities,
                                    "dropped non-billable connection events before accounting"
                                );
                            }
                            if let Some(window) = report.closed_history_gap {
                                warn!(
                                    window_start = ?window.started_at,
                                    window_end = %window.ended_at,
                                    "closed-connection history overflowed; evicted closures are an unobservable window"
                                );
                            }
                        }
                        ApplyOutcome::Stale => {}
                        ApplyOutcome::Unattributed => {}
                    }
                }
                _ = tick.tick() => {
                    if let Err(error) = state.flush(&sink, Utc::now()).await {
                        error!("metering flush failed: {error}");
                    }
                }
            }
        }
    }
}

struct ActiveStream {
    task: JoinHandle<()>,
}

fn stop_stream(stream: &mut Option<ActiveStream>) {
    if let Some(stream) = stream.take() {
        stream.task.abort();
    }
}

async fn recv_stream(events: &mut Option<mpsc::Receiver<StreamMessage>>) -> Option<StreamMessage> {
    match events {
        Some(events) => events.recv().await,
        None => std::future::pending().await,
    }
}

async fn run_subscription(
    source: Arc<dyn ConnectionEventSource>,
    endpoint: StatsEndpoint,
    interval: Duration,
    stream_id: u64,
    messages: mpsc::Sender<StreamMessage>,
    cancel: CancellationToken,
) {
    let mut backoff = Duration::from_secs(1);
    loop {
        if cancel.is_cancelled() {
            return;
        }
        match source.subscribe(&endpoint, interval).await {
            Ok(mut stream) => {
                info!(
                    addr = endpoint.addr(),
                    stream_id, "connection stream established"
                );
                backoff = Duration::from_secs(1);
                while let Some(message) = stream.next().await {
                    let message = match message {
                        Ok(message) => message,
                        Err(error) => {
                            warn!(
                                addr = endpoint.addr(),
                                stream_id, "connection stream error: {error}"
                            );
                            break;
                        }
                    };
                    let message = StreamMessage { stream_id, message };
                    tokio::select! {
                        _ = cancel.cancelled() => return,
                        result = messages.send(message) => {
                            if result.is_err() {
                                return;
                            }
                        }
                    }
                }
                warn!(
                    addr = endpoint.addr(),
                    stream_id, "connection stream ended; reconnecting"
                );
            }
            Err(error) => {
                warn!(
                    addr = endpoint.addr(),
                    stream_id, "cannot subscribe to connections: {error}"
                );
            }
        }
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(backoff) => {}
        }
        backoff = (backoff * 2).min(STREAM_BACKOFF_MAX);
    }
}

fn log_observation(outcome: &ObservationOutcome) {
    if let Some(recovery) = &outcome.recovery {
        match recovery {
            Recovery::Resumed { committed_at } => {
                info!(committed_at = %committed_at, "metering resumed the same runtime instance")
            }
            Recovery::NewInstance {
                previous,
                previous_committed_at,
                unobservable,
            } => warn!(
                previous = %previous,
                previous_committed_at = %previous_committed_at,
                window_start = ?unobservable.started_at,
                window_end = %unobservable.ended_at,
                "new runtime instance; traffic served by the previous instance after its last commit is unobservable"
            ),
            Recovery::Baseline {
                reason,
                unobservable,
            } => warn!(
                reason = ?reason,
                window_start = ?unobservable.started_at,
                window_end = %unobservable.ended_at,
                "metering baseline adopted without historical recharge; earlier traffic is unobservable"
            ),
        }
    }
    if let Some(window) = &outcome.unattributed {
        warn!(
            instance = ?window.instance,
            started_at = %window.started_at,
            ended_at = %window.ended_at,
            "runtime instance could not be attributed; this traffic window is unobservable"
        );
    }
    if let Some(Commit::Deferred(reason)) = outcome.detached {
        warn!(reason = ?reason, "old meter could not commit before the instance change");
    }
}

#[cfg(test)]
mod tests;
