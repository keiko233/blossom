//! Collects per-user traffic from sing-box's connection-event stream and
//! reports it upstream.
//!
//! Delivery model (details in docs/development/server-agent.md):
//!
//! 1. A background task subscribes to sing-box's `SubscribeConnections`
//!    stream and accumulates per-user deltas as UPDATE / CLOSED events
//!    arrive (see [`crate::accountant::ConnectionAccountant`]). The accumulator
//!    is shared with the reporter through a mutex, so the periodic reporter
//!    drains whatever has arrived since the last cycle.
//! 2. Drained deltas are immediately *sealed* into a [`Batch`] with a fresh
//!    report id and written durably (temp file, fsync, rename, directory
//!    fsync) to `<state_dir>/traffic/pending/`. A sealed batch never
//!    changes: retries and restarts resend the same id with the same
//!    content.
//! 3. Batches are posted oldest first. A batch is deleted only after the
//!    control plane acknowledged it; the control plane applies a given
//!    `(server, reportId)` at most once, so resending after a lost response
//!    or a crash cannot double count.
//!
//! This is at-least-once delivery plus server-side deduplication, not
//! exactly-once accounting: traffic produced but not yet observed by the
//! stream (or drained but not yet sealed) is lost if sing-box or the agent
//! dies. With the stream model the loss window shrinks to roughly one
//! stream interval for in-memory deltas; sealed batches remain durable.

use std::collections::HashMap;
use std::fs;
use std::future::Future;
use std::hash::{BuildHasher, Hasher};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use anyhow::Result;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use tracing::{debug, error, info, warn};

use crate::accountant::ConnectionAccountant;
use crate::client::types::{
    ReportAgentTrafficBody, ReportAgentTrafficBodyEntriesItem,
    ReportAgentTrafficBodyEntriesItemSubscriptionId,
};
use crate::stats::{ConnectionEvents, StatsClient};

/// How often the stream's periodic UPDATE flush fires (upstream default 1s).
const STREAM_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);
/// Reconnect backoff for the connection stream.
const STREAM_BACKOFF_MAX: std::time::Duration = std::time::Duration::from_secs(30);

pub(crate) const MAX_ENTRIES_PER_REPORT: usize = 10_000;
/// Upper bound on entries held in sealed batches (disk and memory). Beyond it,
/// new deltas stay in the in-memory accumulator, which is bounded by the number
/// of distinct subscriptions, until the queue drains.
const MAX_PENDING_ENTRIES: usize = 200_000;
/// A sealed batch is dropped (and reported loudly) once it is older than this.
/// Must stay well below the control plane's ledger retention (30 days) or a
/// very late replay could be counted twice.
const MAX_PENDING_AGE_DAYS: i64 = 7;
const MAX_SENDS_PER_CYCLE: usize = 20;
const MAX_REJECTED_KEPT: usize = 16;
pub(crate) const BATCH_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy)]
struct Limits {
    max_entries_per_report: usize,
    max_pending_entries: usize,
    max_age: Duration,
    max_sends_per_cycle: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_entries_per_report: MAX_ENTRIES_PER_REPORT,
            max_pending_entries: MAX_PENDING_ENTRIES,
            max_age: Duration::days(MAX_PENDING_AGE_DAYS),
            max_sends_per_cycle: MAX_SENDS_PER_CYCLE,
        }
    }
}

/// One sealed, immutable report. This is also the on-disk format.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Batch {
    pub(crate) version: u32,
    pub(crate) report_id: String,
    pub(crate) window_started_at: DateTime<Utc>,
    pub(crate) window_ended_at: DateTime<Utc>,
    pub(crate) entries: Vec<BatchEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct BatchEntry {
    pub(crate) subscription_id: String,
    pub(crate) uplink_bytes: i64,
    pub(crate) downlink_bytes: i64,
}

/// What the control plane said about one delivery attempt.
#[derive(Debug)]
pub(crate) enum SendOutcome {
    /// Acknowledged; the batch can be forgotten. `acknowledged_id` is false
    /// when the control plane ignored the report id (it predates idempotent
    /// ingestion), in which case a replay would be counted again.
    Delivered { acknowledged_id: bool },
    /// The control plane will never accept this batch (validation or id
    /// conflict). Retrying cannot help.
    Rejected(String),
    /// Network, authentication or server trouble; keep the batch and retry.
    Retry(String),
}

/// Where a sealed batch is delivered. The HTTP client and the v2 session each
/// implement it. The future must be `Send` so the reporter can run on its own task.
pub(crate) trait ReportSink: Sync {
    fn send(&self, batch: &Batch) -> impl Future<Output = SendOutcome> + Send;
}

struct ClientSink<'a>(&'a crate::client::Client);

impl ReportSink for ClientSink<'_> {
    async fn send(&self, batch: &Batch) -> SendOutcome {
        let body = match to_body(batch) {
            Ok(body) => body,
            Err(reason) => return SendOutcome::Rejected(reason),
        };
        match self.0.report_agent_traffic(&body).await {
            Ok(response) => {
                let result = response.into_inner();
                info!(
                    report_id = %batch.report_id,
                    "traffic report accepted {} dropped {}{}",
                    result.accepted,
                    result.dropped,
                    if result.duplicate == Some(true) {
                        " (already applied)"
                    } else {
                        ""
                    }
                );
                SendOutcome::Delivered {
                    acknowledged_id: result.report_id.as_deref() == Some(&batch.report_id),
                }
            }
            Err(e) => {
                let reason = e.to_string();
                match e.status() {
                    Some(status) if is_permanent_rejection(status.as_u16()) => {
                        SendOutcome::Rejected(reason)
                    }
                    _ => SendOutcome::Retry(reason),
                }
            }
        }
    }
}

/// 400/409/413/422 mean the request itself is unacceptable. Everything else
/// (401/403 token trouble, 404 during a rollout, 408/425/429, 5xx, transport
/// errors) may heal, so the batch is kept.
fn is_permanent_rejection(status: u16) -> bool {
    matches!(status, 400 | 409 | 413 | 422)
}

fn to_body(batch: &Batch) -> Result<ReportAgentTrafficBody, String> {
    let entries = batch
        .entries
        .iter()
        .map(|entry| {
            Ok(ReportAgentTrafficBodyEntriesItem {
                downlink_bytes: entry.downlink_bytes,
                subscription_id: entry
                    .subscription_id
                    .parse::<ReportAgentTrafficBodyEntriesItemSubscriptionId>()
                    .map_err(|e| format!("invalid subscription id in batch: {e}"))?,
                uplink_bytes: entry.uplink_bytes,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(ReportAgentTrafficBody {
        entries,
        report_id: Some(
            batch
                .report_id
                .parse()
                .map_err(|e| format!("invalid report id: {e}"))?,
        ),
        window_ended_at: Some(batch.window_ended_at),
        window_started_at: Some(batch.window_started_at),
    })
}

/// 12 hex digits of epoch milliseconds (so ids sort by age) followed by 128
/// random bits. Random bits come from the std hasher's per-instance OS-seeded
/// keys; uniqueness only has to hold per server, across restarts, for the
/// control plane's retention window. Matches `[A-Za-z0-9._-]{8,128}`.
pub(crate) fn new_report_id(now: DateTime<Utc>) -> String {
    let random = || {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_i64(now.timestamp_nanos_opt().unwrap_or_default());
        hasher.finish()
    };
    format!(
        "{:012x}-{:016x}{:016x}",
        now.timestamp_millis().max(0),
        random(),
        random()
    )
}

/// Sealed batches, mirrored in memory and (when storage works) on disk.
struct PendingQueue {
    root: PathBuf,
    items: Vec<Queued>,
    storage_error_logged: bool,
}

struct Queued {
    batch: Batch,
    persisted: bool,
}

impl PendingQueue {
    /// Never fails: unreadable storage only means nothing is recovered and new
    /// batches are held in memory (and retried onto disk) until it works.
    fn open(root: PathBuf) -> Self {
        let mut queue = Self {
            root,
            items: Vec::new(),
            storage_error_logged: false,
        };
        queue.load();
        queue
    }

    fn pending_dir(&self) -> PathBuf {
        self.root.join("pending")
    }

    fn rejected_dir(&self) -> PathBuf {
        self.root.join("rejected")
    }

    fn file_path(&self, report_id: &str) -> PathBuf {
        self.pending_dir().join(format!("{report_id}.json"))
    }

    fn entry_count(&self) -> usize {
        self.items.iter().map(|q| q.batch.entries.len()).sum()
    }

    fn load(&mut self) {
        let dir = self.pending_dir();
        let read = match fs::read_dir(&dir) {
            Ok(read) => read,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return,
            Err(e) => {
                error!(
                    "cannot read pending traffic reports in {}: {e}",
                    dir.display()
                );
                return;
            }
        };
        let mut paths: Vec<PathBuf> = read.filter_map(|entry| Some(entry.ok()?.path())).collect();
        paths.sort();
        for path in paths {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.ends_with(".tmp") {
                // An interrupted write; the batch was never durably enqueued.
                let _ = fs::remove_file(&path);
                continue;
            }
            if !name.ends_with(".json") {
                continue;
            }
            match read_batch(&path) {
                Ok(batch) => self.items.push(Queued {
                    batch,
                    persisted: true,
                }),
                Err(reason) => {
                    error!(
                        "discarding unreadable pending traffic report {name}: {reason}; moved aside"
                    );
                    self.move_aside(&path, name);
                }
            }
        }
        self.items
            .sort_by(|a, b| a.batch.report_id.cmp(&b.batch.report_id));
        if !self.items.is_empty() {
            info!(
                "recovered {} pending traffic report(s) from {}",
                self.items.len(),
                dir.display()
            );
        }
    }

    /// Adds a sealed batch. It is queued in memory even when it cannot be
    /// written, so a full or broken disk degrades durability, not delivery.
    fn push(&mut self, batch: Batch) {
        let persisted = match self.persist(&batch) {
            Ok(()) => true,
            Err(e) => {
                self.note_storage_error(&e);
                false
            }
        };
        if persisted {
            self.storage_error_logged = false;
        }
        self.items.push(Queued { batch, persisted });
    }

    fn note_storage_error(&mut self, error: &io::Error) {
        if !self.storage_error_logged {
            self.storage_error_logged = true;
            warn!(
                "cannot persist pending traffic reports under {}: {error}; \
                 holding them in memory, they will not survive an agent restart",
                self.root.display()
            );
        }
    }

    fn retry_persist(&mut self) {
        for index in 0..self.items.len() {
            if self.items[index].persisted {
                continue;
            }
            match self.persist(&self.items[index].batch) {
                Ok(()) => {
                    self.items[index].persisted = true;
                    self.storage_error_logged = false;
                }
                Err(e) => {
                    self.note_storage_error(&e);
                    return;
                }
            }
        }
    }

    fn persist(&self, batch: &Batch) -> io::Result<()> {
        let dir = self.pending_dir();
        create_private_dir(&self.root)?;
        create_private_dir(&dir)?;
        let bytes = serde_json::to_vec(batch).map_err(io::Error::other)?;
        write_atomic(&dir, &format!("{}.json", batch.report_id), &bytes)
    }

    /// Forgets a batch. If the file cannot be deleted it stays behind and is
    /// replayed after a restart, which the control plane answers as a duplicate.
    fn remove(&mut self, report_id: &str) {
        self.items.retain(|q| q.batch.report_id != report_id);
        match fs::remove_file(self.file_path(report_id)) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => warn!("could not delete delivered traffic report {report_id}: {e}"),
        }
    }

    /// Keeps a never-acceptable batch for inspection (bounded) instead of
    /// retrying it forever or silently deleting it.
    fn quarantine(&mut self, report_id: &str) {
        self.items.retain(|q| q.batch.report_id != report_id);
        let path = self.file_path(report_id);
        self.move_aside(&path, &format!("{report_id}.json"));
    }

    fn move_aside(&self, path: &Path, name: &str) {
        let dir = self.rejected_dir();
        let moved = create_private_dir(&self.root)
            .and_then(|()| create_private_dir(&dir))
            .and_then(|()| fs::rename(path, dir.join(name)));
        if moved.is_err() {
            let _ = fs::remove_file(path);
        }
        if let Ok(read) = fs::read_dir(&dir) {
            let mut kept: Vec<PathBuf> = read.filter_map(|e| Some(e.ok()?.path())).collect();
            kept.sort();
            while kept.len() > MAX_REJECTED_KEPT {
                let _ = fs::remove_file(kept.remove(0));
            }
        }
    }

    fn expire(&mut self, now: DateTime<Utc>, max_age: Duration) {
        let expired: Vec<(String, usize)> = self
            .items
            .iter()
            .filter(|q| now - q.batch.window_ended_at > max_age)
            .map(|q| (q.batch.report_id.clone(), q.batch.entries.len()))
            .collect();
        for (report_id, entries) in expired {
            error!(
                report_id = %report_id,
                "discarding undeliverable traffic report older than {} days ({entries} entries); this traffic is not accounted",
                max_age.num_days()
            );
            self.remove(&report_id);
        }
    }
}

fn read_batch(path: &Path) -> Result<Batch, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let batch: Batch = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    if batch.version != BATCH_FORMAT_VERSION {
        return Err(format!("unsupported batch version {}", batch.version));
    }
    if batch.report_id != stem {
        return Err("report id does not match file name".to_string());
    }
    Ok(batch)
}

pub(crate) fn create_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Durable write: temp file, fsync, rename, fsync of the directory.
pub(crate) fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    let tmp = dir.join(format!("{name}.tmp"));
    let target = dir.join(name);
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, &target)?;
        #[cfg(unix)]
        fs::File::open(dir)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Deltas read from sing-box, sealed batches awaiting delivery, and the window
/// bookkeeping between them.
struct Outbox {
    queue: PendingQueue,
    /// Read from sing-box but not yet sealed. Only non-empty when the queue is
    /// at its entry cap; bounded by the number of distinct subscriptions.
    unsealed: HashMap<String, (u64, u64)>,
    window_started_at: DateTime<Utc>,
    limits: Limits,
    capacity_warned: bool,
    unacknowledged_warned: bool,
}

impl Outbox {
    fn open(root: PathBuf, now: DateTime<Utc>) -> Self {
        Self::with_limits(root, now, Limits::default())
    }

    fn with_limits(root: PathBuf, now: DateTime<Utc>, limits: Limits) -> Self {
        Self {
            queue: PendingQueue::open(root),
            unsealed: HashMap::new(),
            window_started_at: now,
            limits,
            capacity_warned: false,
            unacknowledged_warned: false,
        }
    }

    /// Takes freshly drained per-user deltas and seals them straight away:
    /// this is the durable-enqueue step that follows draining the shared
    /// connection-event accumulator.
    fn ingest(&mut self, deltas: &HashMap<String, (u64, u64)>, now: DateTime<Utc>) {
        for (user, (uplink, downlink)) in deltas {
            if *uplink == 0 && *downlink == 0 {
                continue;
            }
            let entry = self.unsealed.entry(user.clone()).or_insert((0, 0));
            entry.0 = entry.0.saturating_add(*uplink);
            entry.1 = entry.1.saturating_add(*downlink);
        }
        self.seal(now);
    }

    fn seal(&mut self, now: DateTime<Utc>) {
        if self.unsealed.is_empty() {
            self.window_started_at = now;
            debug!("no traffic deltas; advancing window");
            return;
        }
        while !self.unsealed.is_empty() {
            let take = self.unsealed.len().min(self.limits.max_entries_per_report);
            if self.queue.entry_count() + take > self.limits.max_pending_entries {
                if !self.capacity_warned {
                    self.capacity_warned = true;
                    warn!(
                        "pending traffic queue is full ({} entries); keeping new deltas in memory until it drains",
                        self.queue.entry_count()
                    );
                }
                return;
            }
            let entries = drain_entries(&mut self.unsealed, self.limits.max_entries_per_report);
            if entries.is_empty() {
                continue;
            }
            self.queue.push(Batch {
                version: BATCH_FORMAT_VERSION,
                report_id: new_report_id(now),
                window_started_at: self.window_started_at,
                window_ended_at: now,
                entries,
            });
        }
        self.capacity_warned = false;
        self.window_started_at = now;
    }

    /// Posts sealed batches oldest first. Stops at the first transient failure
    /// so an unreachable control plane is not hammered.
    async fn flush<S: ReportSink>(&mut self, sink: &S, now: DateTime<Utc>) {
        self.queue.expire(now, self.limits.max_age);
        self.queue.retry_persist();

        for _ in 0..self.limits.max_sends_per_cycle {
            let Some(batch) = self.queue.items.first().map(|q| q.batch.clone()) else {
                break;
            };
            match sink.send(&batch).await {
                SendOutcome::Delivered { acknowledged_id } => {
                    self.queue.remove(&batch.report_id);
                    if !acknowledged_id && !self.unacknowledged_warned {
                        self.unacknowledged_warned = true;
                        warn!(
                            "control plane did not acknowledge report ids; it predates idempotent traffic ingestion, so a retry after a lost response may be counted twice"
                        );
                    }
                }
                SendOutcome::Rejected(reason) => {
                    error!(
                        report_id = %batch.report_id,
                        "traffic report rejected permanently, moved aside: {reason}"
                    );
                    self.queue.quarantine(&batch.report_id);
                }
                SendOutcome::Retry(reason) => {
                    warn!(
                        report_id = %batch.report_id,
                        "traffic report not delivered, will retry with the same id: {reason}"
                    );
                    break;
                }
            }
        }
    }
}

/// Accountant plus the deltas it produced since the last drain. Lock is held
/// only for the (synchronous) apply/drain, never across an await.
#[derive(Default)]
struct Shared {
    accountant: ConnectionAccountant,
    pending: HashMap<String, (u64, u64)>,
}

/// Handle shared between the background stream consumer and the reporter.
#[derive(Clone)]
struct SharedHandle(std::sync::Arc<std::sync::Mutex<Shared>>);

impl SharedHandle {
    fn new() -> Self {
        Self(std::sync::Arc::new(std::sync::Mutex::new(Shared {
            accountant: ConnectionAccountant::new(),
            pending: HashMap::new(),
        })))
    }

    /// Applies one stream message to the accumulator. A poisoned mutex is
    /// treated as a lost accumulator; it only ever held unsealed in-memory
    /// deltas, which the at-least-once contract already covers.
    fn apply(&self, message: &ConnectionEvents) {
        let Ok(mut shared) = self.0.lock() else {
            return;
        };
        for (user, delta) in shared.accountant.apply(message) {
            let entry = shared.pending.entry(user).or_insert((0, 0));
            entry.0 = entry.0.saturating_add(delta.0);
            entry.1 = entry.1.saturating_add(delta.1);
        }
    }

    fn drain(&self) -> HashMap<String, (u64, u64)> {
        let Ok(mut shared) = self.0.lock() else {
            return HashMap::new();
        };
        std::mem::take(&mut shared.pending)
    }
}

/// Subscribes to the connection stream until the task is aborted. Reconnects
/// with backoff; every first message of a stream is a snapshot, reconciled by
/// the accountant against what it already knows (same-instance recovery).
async fn stream_loop(addr: String, secret: Option<String>, shared: SharedHandle) {
    let mut backoff = std::time::Duration::from_secs(1);
    loop {
        let mut client = match StatsClient::connect_lazy(&addr, secret.as_deref()) {
            Ok(client) => client,
            Err(e) => {
                warn!("invalid traffic stream endpoint {addr}: {e}; retrying in {backoff:?}");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(STREAM_BACKOFF_MAX);
                continue;
            }
        };
        match client.subscribe_connections(STREAM_INTERVAL).await {
            Ok(stream) => {
                info!("connection stream established to {addr}");
                backoff = std::time::Duration::from_secs(1);
                consume_stream(stream, &shared).await;
                warn!("connection stream to {addr} ended; reconnecting in {backoff:?}");
            }
            Err(e) => {
                warn!(
                    "cannot subscribe to connection stream on {addr}: {e}; retrying in {backoff:?}"
                );
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(STREAM_BACKOFF_MAX);
    }
}

async fn consume_stream(mut stream: tonic::Streaming<ConnectionEvents>, shared: &SharedHandle) {
    loop {
        match stream.message().await {
            Ok(Some(message)) => shared.apply(&message),
            Ok(None) => return,
            Err(e) => {
                warn!("connection stream error: {e}");
                return;
            }
        }
    }
}

pub struct TrafficReporter {
    addr: String,
    secret: Option<String>,
    stream: Option<tokio::task::JoinHandle<()>>,
    shared: SharedHandle,
    outbox: Outbox,
}

impl TrafficReporter {
    /// `traffic_dir` holds the durable queue (`<state_dir>/traffic`); batches
    /// left by a previous run are recovered here.
    pub fn new(addr: String, secret: Option<String>, traffic_dir: PathBuf) -> Result<Self> {
        let shared = SharedHandle::new();
        let stream = tokio::spawn(stream_loop(addr.clone(), secret.clone(), shared.clone()));
        Ok(Self {
            addr,
            secret,
            stream: Some(stream),
            shared,
            outbox: Outbox::open(traffic_dir, Utc::now()),
        })
    }

    /// Restarts the stream consumer only if the endpoint actually changed.
    /// A restart is a fresh subscription to the same sing-box process; the
    /// accountant reconciles the snapshot against what it already knows; ids
    /// from a replaced sing-box process never appear in it, so stale state
    /// cannot leak across process generations.
    pub fn update_endpoint(&mut self, addr: &str, secret: Option<&str>) -> Result<()> {
        if self.addr == addr && self.secret.as_deref() == secret {
            return Ok(());
        }
        if let Some(handle) = self.stream.take() {
            handle.abort();
        }
        self.addr = addr.to_string();
        self.secret = secret.map(str::to_owned);
        self.stream = Some(tokio::spawn(stream_loop(
            self.addr.clone(),
            self.secret.clone(),
            self.shared.clone(),
        )));
        Ok(())
    }

    /// One cycle: drain the shared accumulator -> seal durably -> POST
    /// pending batches -> forget acknowledged ones. Stream failures are the
    /// consumer task's problem; this only reports what has arrived. Every
    /// failure path logs (warn!/error!) and returns; never panics/crashes.
    pub async fn collect_and_report(&mut self, client: &crate::client::Client) {
        self.collect_and_flush(&ClientSink(client)).await;
    }

    /// The same cycle with any delivery sink: the HTTP client or the v2 session.
    pub(crate) async fn collect_and_flush<S: ReportSink>(&mut self, sink: &S) {
        let deltas = self.shared.drain();
        self.outbox.ingest(&deltas, Utc::now());
        self.outbox.flush(sink, Utc::now()).await;
    }
}

pub(crate) fn drain_entries(
    pending: &mut HashMap<String, (u64, u64)>,
    max: usize,
) -> Vec<BatchEntry> {
    let mut out = Vec::with_capacity(max.min(pending.len()));
    let keys: Vec<String> = pending.keys().cloned().collect();

    for key in keys {
        if out.len() >= max {
            break;
        }
        let Some((uplink, downlink)) = pending.remove(&key) else {
            continue;
        };
        if uplink == 0 && downlink == 0 {
            continue;
        }
        out.push(BatchEntry {
            subscription_id: key,
            uplink_bytes: clamp_i64(uplink),
            downlink_bytes: clamp_i64(downlink),
        });
    }

    out
}

fn clamp_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, Ordering};

    use chrono::{DateTime, Duration, Utc};

    use super::{
        Batch, BatchEntry, Limits, Outbox, ReportSink, SendOutcome, clamp_i64, drain_entries,
        new_report_id,
    };

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000 + seconds, 0).unwrap()
    }

    fn unique_dir() -> PathBuf {
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "blossom-traffic-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ))
    }

    /// Per-user deltas as the stream accumulator reports them.
    fn deltas(rows: &[(&str, u64, u64)]) -> HashMap<String, (u64, u64)> {
        rows.iter()
            .map(|(user, up, down)| ((*user).to_string(), (*up, *down)))
            .collect()
    }

    enum Fault {
        /// Request never reaches the control plane.
        Unavailable,
        /// Control plane applies the report, but the response is lost.
        LoseResponse,
        Reject,
    }

    /// Model of the control plane's contract: a report id is applied at most
    /// once and a reused id with different content is refused.
    #[derive(Default)]
    struct FakeControlPlane {
        script: Mutex<VecDeque<Fault>>,
        applied: Mutex<HashMap<String, Vec<BatchEntry>>>,
        totals: Mutex<HashMap<String, (i64, i64)>>,
        attempts: Mutex<Vec<Batch>>,
        echo_report_id: bool,
    }

    impl FakeControlPlane {
        fn new() -> Self {
            Self {
                echo_report_id: true,
                ..Default::default()
            }
        }

        fn script(&self, faults: impl IntoIterator<Item = Fault>) {
            self.script.lock().unwrap().extend(faults);
        }

        fn apply(&self, batch: &Batch) -> Result<(), String> {
            let mut applied = self.applied.lock().unwrap();
            if let Some(previous) = applied.get(&batch.report_id) {
                return if *previous == batch.entries {
                    Ok(())
                } else {
                    Err("id reused with different content".to_string())
                };
            }
            applied.insert(batch.report_id.clone(), batch.entries.clone());
            let mut totals = self.totals.lock().unwrap();
            for entry in &batch.entries {
                let total = totals.entry(entry.subscription_id.clone()).or_default();
                total.0 += entry.uplink_bytes;
                total.1 += entry.downlink_bytes;
            }
            Ok(())
        }

        fn total(&self, sub: &str) -> (i64, i64) {
            self.totals
                .lock()
                .unwrap()
                .get(sub)
                .copied()
                .unwrap_or_default()
        }

        fn attempted_ids(&self) -> Vec<String> {
            self.attempts
                .lock()
                .unwrap()
                .iter()
                .map(|b| b.report_id.clone())
                .collect()
        }
    }

    impl ReportSink for FakeControlPlane {
        async fn send(&self, batch: &Batch) -> SendOutcome {
            self.attempts.lock().unwrap().push(batch.clone());
            let fault = self.script.lock().unwrap().pop_front();
            match fault {
                Some(Fault::Unavailable) => SendOutcome::Retry("connection refused".to_string()),
                Some(Fault::Reject) => SendOutcome::Rejected("400".to_string()),
                Some(Fault::LoseResponse) => {
                    let _ = self.apply(batch);
                    SendOutcome::Retry("response lost".to_string())
                }
                None => match self.apply(batch) {
                    Ok(()) => SendOutcome::Delivered {
                        acknowledged_id: self.echo_report_id,
                    },
                    Err(reason) => SendOutcome::Rejected(reason),
                },
            }
        }
    }

    fn pending_files(root: &std::path::Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(root.join("pending"))
            .map(|read| {
                read.filter_map(|e| Some(e.ok()?.file_name().to_string_lossy().into_owned()))
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    fn small_limits() -> Limits {
        Limits {
            max_entries_per_report: 2,
            ..Limits::default()
        }
    }

    #[test]
    fn drain_removes_keys_and_skips_zeros() {
        let mut pending = HashMap::new();
        pending.insert("zero".to_string(), (0, 0));
        pending.insert("active".to_string(), (10, 20));
        pending.insert("also".to_string(), (0, 5));

        let entries = drain_entries(&mut pending, 10);

        assert!(pending.is_empty());
        let total_uplink: i64 = entries.iter().map(|e| e.uplink_bytes).sum();
        let total_downlink: i64 = entries.iter().map(|e| e.downlink_bytes).sum();
        assert_eq!(total_uplink, 10);
        assert_eq!(total_downlink, 25);
    }

    #[test]
    fn drain_respects_cap_and_leaves_remainder() {
        let mut pending = HashMap::new();
        for i in 0..5 {
            pending.insert(format!("sub-{i}"), (i as u64 + 1, 0));
        }

        let entries = drain_entries(&mut pending, 2);

        assert_eq!(entries.len(), 2);
        assert_eq!(pending.len(), 3);
        let drained: u64 = entries.iter().map(|e| e.uplink_bytes as u64).sum();
        let remaining: u64 = pending.values().map(|(u, _)| *u).sum();
        assert_eq!(drained + remaining, 1 + 2 + 3 + 4 + 5);
    }

    #[test]
    fn drain_empty_map_returns_empty_vec() {
        let mut pending: HashMap<String, (u64, u64)> = HashMap::new();
        assert!(drain_entries(&mut pending, 10).is_empty());
    }

    #[test]
    fn clamp_i64_caps_at_max() {
        assert_eq!(clamp_i64(i64::MAX as u64), i64::MAX);
        assert_eq!(clamp_i64(u64::MAX), i64::MAX);
    }

    #[test]
    fn report_ids_are_unique_and_match_the_control_plane_format() {
        let ids: HashSet<String> = (0..500).map(|_| new_report_id(at(0))).collect();
        assert_eq!(ids.len(), 500);
        for id in &ids {
            assert!((8..=128).contains(&id.len()));
            assert!(
                id.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
            );
        }
        // Older ids sort first, which is the order batches are sent in.
        assert!(new_report_id(at(0)) < new_report_id(at(1)));
    }

    #[tokio::test]
    async fn seals_durably_before_any_send() {
        let root = unique_dir();
        let mut outbox = Outbox::open(root.clone(), at(0));

        outbox.ingest(&deltas(&[("a", 10, 20)]), at(60));

        assert_eq!(pending_files(&root).len(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = root.join("pending").join(&pending_files(&root)[0]);
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn delivered_batch_is_forgotten_and_window_advances() {
        let root = unique_dir();
        let plane = FakeControlPlane::new();
        let mut outbox = Outbox::open(root.clone(), at(0));

        outbox.ingest(&deltas(&[("a", 10, 20)]), at(60));
        outbox.flush(&plane, at(61)).await;

        assert_eq!(plane.total("a"), (10, 20));
        assert!(pending_files(&root).is_empty());
        let sent = plane.attempts.lock().unwrap()[0].clone();
        assert_eq!(
            (sent.window_started_at, sent.window_ended_at),
            (at(0), at(60))
        );

        outbox.ingest(&deltas(&[("a", 1, 1)]), at(120));
        assert_eq!(outbox.queue.items[0].batch.window_started_at, at(60));
        fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn lost_response_resends_the_same_id_and_content_and_counts_once() {
        let root = unique_dir();
        let plane = FakeControlPlane::new();
        plane.script([Fault::LoseResponse]);
        let mut outbox = Outbox::open(root.clone(), at(0));

        outbox.ingest(&deltas(&[("a", 10, 0), ("b", 0, 7)]), at(60));
        outbox.flush(&plane, at(61)).await;
        // Next cycle: new traffic is sealed separately, the old batch is resent.
        outbox.ingest(&deltas(&[("a", 5, 0)]), at(120));
        outbox.flush(&plane, at(121)).await;

        let attempts = plane.attempted_ids();
        assert_eq!(attempts[0], attempts[1], "retry must reuse the report id");
        assert_ne!(attempts[1], attempts[2], "new traffic gets a new id");
        let first = plane.attempts.lock().unwrap()[0].entries.clone();
        let second = plane.attempts.lock().unwrap()[1].entries.clone();
        assert_eq!(first, second);
        assert_eq!(plane.total("a"), (15, 0));
        assert_eq!(plane.total("b"), (0, 7));
        assert!(pending_files(&root).is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn pending_batches_survive_a_restart_with_unchanged_ids() {
        let root = unique_dir();
        let plane = FakeControlPlane::new();
        plane.script([Fault::LoseResponse, Fault::Unavailable]);
        let mut first_run = Outbox::open(root.clone(), at(0));
        first_run.ingest(&deltas(&[("a", 10, 0), ("b", 0, 7)]), at(60));
        first_run.flush(&plane, at(61)).await;
        let sealed = first_run.queue.items[0].batch.clone();
        drop(first_run); // agent crash: only the files remain

        let mut second_run = Outbox::open(root.clone(), at(100));
        assert_eq!(second_run.queue.items.len(), 1);
        assert_eq!(second_run.queue.items[0].batch, sealed);
        second_run.flush(&plane, at(101)).await;

        assert_eq!(plane.attempted_ids(), vec![sealed.report_id.clone(); 2]);
        assert_eq!(plane.total("a"), (10, 0));
        assert_eq!(plane.total("b"), (0, 7));
        assert_eq!(pending_files(&root).len(), 1);
        second_run.flush(&plane, at(102)).await;
        assert_eq!(plane.attempted_ids(), vec![sealed.report_id.clone(); 3]);
        assert!(pending_files(&root).is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn two_subscriptions_split_across_batches_survive_partial_failure() {
        let root = unique_dir();
        let plane = FakeControlPlane::new();
        // First batch delivered; the second one's response is lost, then the
        // control plane is unreachable, then everything works.
        plane.script([Fault::LoseResponse]);
        let mut outbox = Outbox::with_limits(root.clone(), at(0), small_limits());
        outbox.ingest(
            &deltas(&[
                ("a", 1, 2),
                ("b", 3, 4),
                ("c", 5, 6),
                ("d", 7, 8),
                ("e", 9, 10),
            ]),
            at(60),
        );
        assert_eq!(outbox.queue.items.len(), 3, "5 entries / 2 per report");

        plane.script([Fault::Unavailable]);
        outbox.flush(&plane, at(61)).await; // 1st: response lost -> stop
        outbox.flush(&plane, at(62)).await; // 1st again: unavailable -> stop
        outbox.flush(&plane, at(63)).await; // everything delivered

        for (sub, up, down) in [
            ("a", 1, 2),
            ("b", 3, 4),
            ("c", 5, 6),
            ("d", 7, 8),
            ("e", 9, 10),
        ] {
            assert_eq!(plane.total(sub), (up, down), "{sub}");
        }
        let distinct: HashSet<_> = plane.attempted_ids().into_iter().collect();
        assert_eq!(distinct.len(), 3);
        assert!(outbox.queue.items.is_empty() && pending_files(&root).is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn permanent_rejection_is_moved_aside_without_blocking_the_rest() {
        let root = unique_dir();
        let plane = FakeControlPlane::new();
        plane.script([Fault::Reject]);
        let mut outbox = Outbox::with_limits(root.clone(), at(0), small_limits());
        outbox.ingest(&deltas(&[("a", 1, 0), ("b", 1, 0), ("c", 1, 0)]), at(60));

        outbox.flush(&plane, at(61)).await;

        assert_eq!(plane.attempts.lock().unwrap().len(), 2);
        assert!(outbox.queue.items.is_empty());
        assert!(pending_files(&root).is_empty());
        assert_eq!(fs::read_dir(root.join("rejected")).unwrap().count(), 1);
        fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn sends_at_most_the_per_cycle_limit() {
        let root = unique_dir();
        let plane = FakeControlPlane::new();
        let limits = Limits {
            max_sends_per_cycle: 2,
            ..small_limits()
        };
        let mut outbox = Outbox::with_limits(root.clone(), at(0), limits);
        outbox.ingest(
            &deltas(&[
                ("a", 1, 0),
                ("b", 1, 0),
                ("c", 1, 0),
                ("d", 1, 0),
                ("e", 1, 0),
            ]),
            at(60),
        );

        outbox.flush(&plane, at(61)).await;
        assert_eq!(plane.attempts.lock().unwrap().len(), 2);
        assert_eq!(outbox.queue.items.len(), 1);
        fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn unwritable_storage_degrades_to_memory_without_losing_traffic() {
        let root = unique_dir();
        fs::write(&root, "a file where the queue directory should be").unwrap();
        let plane = FakeControlPlane::new();
        plane.script([Fault::Unavailable]);
        let mut outbox = Outbox::open(root.clone(), at(0));

        outbox.ingest(&deltas(&[("a", 10, 0)]), at(60));
        assert!(!outbox.queue.items[0].persisted);
        outbox.flush(&plane, at(61)).await; // unavailable: stays in memory
        outbox.ingest(&deltas(&[("a", 5, 0)]), at(120));
        outbox.flush(&plane, at(121)).await;

        assert_eq!(plane.total("a"), (15, 0));
        assert!(outbox.queue.items.is_empty());
        fs::remove_file(&root).unwrap();
    }

    #[tokio::test]
    async fn memory_only_batches_are_written_once_storage_recovers() {
        let root = unique_dir();
        fs::write(&root, "blocked").unwrap();
        let plane = FakeControlPlane::new();
        plane.script([Fault::Unavailable]);
        let mut outbox = Outbox::open(root.clone(), at(0));
        outbox.ingest(&deltas(&[("a", 10, 0)]), at(60));
        fs::remove_file(&root).unwrap(); // the disk problem is fixed

        outbox.flush(&plane, at(61)).await;

        assert!(outbox.queue.items[0].persisted);
        assert_eq!(pending_files(&root).len(), 1);
        fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn full_queue_keeps_deltas_in_memory_until_it_drains() {
        let root = unique_dir();
        let plane = FakeControlPlane::new();
        plane.script([Fault::Unavailable]);
        let limits = Limits {
            max_entries_per_report: 2,
            max_pending_entries: 3,
            ..Limits::default()
        };
        let mut outbox = Outbox::with_limits(root.clone(), at(0), limits);

        outbox.ingest(
            &deltas(&[("a", 1, 0), ("b", 1, 0), ("c", 1, 0), ("d", 1, 0)]),
            at(60),
        );
        assert_eq!(outbox.queue.entry_count(), 2);
        assert_eq!(
            outbox.unsealed.len(),
            2,
            "overflow stays in the accumulator"
        );

        outbox.flush(&plane, at(61)).await; // unavailable
        outbox.ingest(&deltas(&[("a", 4, 0)]), at(120)); // still full, merges
        outbox.flush(&plane, at(121)).await; // drains the queue
        outbox.ingest(&HashMap::new(), at(180)); // room again: remainder is sealed
        outbox.flush(&plane, at(181)).await;

        assert_eq!(plane.total("a"), (5, 0));
        for sub in ["b", "c", "d"] {
            assert_eq!(plane.total(sub), (1, 0), "{sub}");
        }
        assert!(outbox.unsealed.is_empty() && outbox.queue.items.is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn batches_older_than_the_limit_are_discarded_not_sent() {
        let root = unique_dir();
        let plane = FakeControlPlane::new();
        let limits = Limits {
            max_age: Duration::hours(1),
            ..Limits::default()
        };
        let mut outbox = Outbox::with_limits(root.clone(), at(0), limits);
        outbox.ingest(&deltas(&[("a", 10, 0)]), at(60));

        outbox.flush(&plane, at(60 + 2 * 3600)).await;

        assert!(plane.attempts.lock().unwrap().is_empty());
        assert!(outbox.queue.items.is_empty());
        assert!(pending_files(&root).is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn corrupt_and_interrupted_files_are_set_aside_on_startup() {
        let root = unique_dir();
        let mut writer = Outbox::open(root.clone(), at(0));
        writer.ingest(&deltas(&[("a", 10, 0)]), at(60));
        let good = writer.queue.items[0].batch.clone();
        let pending = root.join("pending");
        fs::write(pending.join("garbage.json"), "{ not json").unwrap();
        fs::write(pending.join("half-written.json.tmp"), "{").unwrap();
        let mismatched = serde_json::to_vec(&Batch {
            report_id: "someone-else".to_string(),
            ..good.clone()
        })
        .unwrap();
        fs::write(pending.join("renamed-0000.json"), mismatched).unwrap();

        let recovered = Outbox::open(root.clone(), at(100));

        assert_eq!(recovered.queue.items.len(), 1);
        assert_eq!(recovered.queue.items[0].batch, good);
        assert_eq!(
            pending_files(&root),
            vec![format!("{}.json", good.report_id)]
        );
        assert_eq!(fs::read_dir(root.join("rejected")).unwrap().count(), 2);
        fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn a_control_plane_that_ignores_report_ids_still_gets_deliveries_acknowledged() {
        let root = unique_dir();
        let plane = FakeControlPlane {
            echo_report_id: false,
            ..FakeControlPlane::default()
        };
        let mut outbox = Outbox::open(root.clone(), at(0));
        outbox.ingest(&deltas(&[("a", 10, 0)]), at(60));

        outbox.flush(&plane, at(61)).await;

        assert!(outbox.queue.items.is_empty());
        assert!(outbox.unacknowledged_warned);
        fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn quiet_cycles_create_no_batches() {
        let root = unique_dir();
        let plane = FakeControlPlane::new();
        let mut outbox = Outbox::open(root.clone(), at(0));

        outbox.ingest(&deltas(&[("a", 0, 0)]), at(60));
        outbox.flush(&plane, at(61)).await;

        assert!(plane.attempts.lock().unwrap().is_empty());
        assert!(pending_files(&root).is_empty());
        let _ = fs::remove_dir_all(&root);
    }
}
