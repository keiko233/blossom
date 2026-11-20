//! Per-instance accountant and outbox committed together.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, Utc};

use super::checkpoint::{CHECKPOINT_SCHEMA, Checkpoint, InstanceKey, is_report_id};
use super::filter::{FilterCounts, InboundClassification};
use super::store::{CheckpointStore, Damage, StoreError, Stored};
use crate::accountant::ConnectionAccountant;
use crate::stats::{CLOSED_HISTORY_LIMIT, ConnectionEvents};
use crate::traffic::{
    BATCH_FORMAT_VERSION, Batch, MAX_ENTRIES_PER_REPORT, drain_entries, new_report_id,
};

/// Upper bound on entries held in committed batches. Beyond it a commit is
/// deferred: the uncommitted counter progress is recomputed from the next
/// snapshot after a crash, so nothing is charged twice.
const MAX_OUTBOX_ENTRIES: usize = 50_000;
/// Legacy import tombstones are bounded so a damaged or hostile queue cannot
/// grow the checkpoint without limit.
const MAX_LEGACY_IMPORTED: usize = 10_000;

/// How an attach to a runtime instance was classified.
#[derive(Debug)]
pub(crate) enum Recovery {
    /// The checkpoint names this instance. Counters, finalised ids and the
    /// outbox resume, and the next snapshot pays only unaccounted remainders.
    Resumed { committed_at: DateTime<Utc> },
    /// The last commit belongs to another instance, so this one has never
    /// committed or reported: its first snapshot is billable in full. The
    /// previous outbox carries over. Traffic of `previous` after
    /// `previous_committed_at` is unobservable.
    NewInstance {
        previous: InstanceKey,
        previous_committed_at: DateTime<Utc>,
        unobservable: UnobservableWindow,
    },
    /// No trustworthy record of what this instance already paid. The first
    /// snapshot is adopted without charge; traffic before it is an
    /// unobservable window with no known lower bound.
    Baseline {
        reason: BaselineReason,
        unobservable: UnobservableWindow,
    },
}

/// A period whose traffic cannot be reconstructed from the checkpoint or the
/// runtime's bounded closed-connection history. `started_at` is absent when
/// no trustworthy committed boundary exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct UnobservableWindow {
    pub(crate) started_at: Option<DateTime<Utc>>,
    pub(crate) ended_at: DateTime<Utc>,
}

#[derive(Debug)]
pub(crate) enum BaselineReason {
    /// No checkpoint exists, so a previously serving instance cannot be ruled out.
    NoCheckpoint,
    /// The checkpoint was unusable and has been moved aside, with its outbox.
    Damaged(Damage),
}

/// Whether [`RuntimeMeter::commit`] wrote a checkpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Commit {
    Committed,
    /// Nothing written; do not send any newly sealed batch.
    Deferred(DeferredReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeferredReason {
    /// The first snapshot has not been baselined yet.
    AwaitingBaseline,
    /// A missing or unclassified inbound proved that billable traffic cannot
    /// be isolated. This stays latched for the instance.
    UnprovenInboundClassification,
    /// The bounded outbox is full. Retry after acknowledgements or expiry.
    OutboxFull,
}

/// Result of filtering and applying one stream message.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ApplyReport {
    pub(crate) counts: FilterCounts,
    pub(crate) unproven: bool,
    pub(crate) charged: bool,
    /// A full closed-connection history whose oldest entry is newer than the
    /// last commit: evicted closures are an unobservable partial window.
    pub(crate) closed_history_gap: Option<UnobservableWindow>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Expired {
    pub(crate) reports: usize,
    pub(crate) entries: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ImportSummary {
    pub(crate) imported: usize,
    pub(crate) duplicates: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ImportError {
    InvalidBatch,
    Conflict { report_id: String },
    OutboxFull,
    TooManyTombstones,
}

impl std::fmt::Display for ImportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidBatch => formatter.write_str("invalid legacy traffic batch"),
            Self::Conflict { report_id } => {
                write!(
                    formatter,
                    "legacy report {report_id} conflicts with the checkpoint"
                )
            }
            Self::OutboxFull => formatter.write_str("the metering outbox is full"),
            Self::TooManyTombstones => {
                formatter.write_str("the legacy import tombstone bound is exhausted")
            }
        }
    }
}

impl std::error::Error for ImportError {}

pub(crate) struct RuntimeMeter {
    instance: InstanceKey,
    sequence: u64,
    accountant: ConnectionAccountant,
    classification: InboundClassification,
    awaiting_baseline: bool,
    unproven: bool,
    /// Deltas since the last commit; sealed only by a commit.
    unsealed: HashMap<String, (u64, u64)>,
    window_started_at: DateTime<Utc>,
    last_committed_at: Option<DateTime<Utc>>,
    outbox: Vec<Batch>,
    /// Leading outbox batches made durable by a successful commit.
    durable: usize,
    /// Report ids already imported from the legacy queue, including batches
    /// that have since been acknowledged and removed.
    legacy_imported: HashSet<String>,
    dirty: bool,
    filter_counts: FilterCounts,
}

impl RuntimeMeter {
    /// Loads the store and classifies the attach to `instance`. Must run
    /// before the first stream message of this agent run is applied.
    pub(crate) fn recover(
        store: &CheckpointStore,
        instance: InstanceKey,
        classification: InboundClassification,
        now: DateTime<Utc>,
    ) -> Result<(Self, Recovery), StoreError> {
        let mut meter = Self {
            instance,
            sequence: 0,
            accountant: ConnectionAccountant::new(),
            classification,
            awaiting_baseline: false,
            unproven: false,
            unsealed: HashMap::new(),
            window_started_at: now,
            last_committed_at: None,
            outbox: Vec::new(),
            durable: 0,
            legacy_imported: HashSet::new(),
            dirty: false,
            filter_counts: FilterCounts::default(),
        };
        let recovery = match store.read()? {
            Stored::Present(checkpoint) if checkpoint.instance == meter.instance => {
                meter.sequence = checkpoint.sequence;
                meter.accountant = ConnectionAccountant::from_state(checkpoint.accountant);
                meter.window_started_at = checkpoint.window_started_at;
                meter.last_committed_at = Some(checkpoint.committed_at);
                meter.durable = checkpoint.outbox.len();
                meter.outbox = checkpoint.outbox;
                meter.legacy_imported = checkpoint.legacy_imported.into_iter().collect();
                Recovery::Resumed {
                    committed_at: checkpoint.committed_at,
                }
            }
            Stored::Present(checkpoint) => {
                meter.durable = checkpoint.outbox.len();
                meter.last_committed_at = Some(checkpoint.committed_at);
                meter.outbox = checkpoint.outbox;
                meter.legacy_imported = checkpoint.legacy_imported.into_iter().collect();
                Recovery::NewInstance {
                    previous: checkpoint.instance,
                    previous_committed_at: checkpoint.committed_at,
                    unobservable: UnobservableWindow {
                        started_at: Some(checkpoint.committed_at),
                        ended_at: now,
                    },
                }
            }
            Stored::Absent => {
                meter.awaiting_baseline = true;
                Recovery::Baseline {
                    reason: BaselineReason::NoCheckpoint,
                    unobservable: UnobservableWindow {
                        started_at: None,
                        ended_at: now,
                    },
                }
            }
            Stored::Damaged(damage) => {
                meter.awaiting_baseline = true;
                Recovery::Baseline {
                    reason: BaselineReason::Damaged(damage),
                    unobservable: UnobservableWindow {
                        started_at: None,
                        ended_at: now,
                    },
                }
            }
        };
        Ok((meter, recovery))
    }

    pub(crate) fn instance(&self) -> &InstanceKey {
        &self.instance
    }

    pub(crate) fn classification(&self) -> &InboundClassification {
        &self.classification
    }

    pub(crate) fn filter_counts(&self) -> FilterCounts {
        self.filter_counts
    }

    pub(crate) fn needs_commit(&self) -> bool {
        self.dirty
    }

    /// Applies one stream message. While a baseline is pending, the first
    /// proven snapshot is adopted without charge and earlier updates are
    /// ignored. A missing or unclassified inbound latches `unproven`, after
    /// which no message is applied or committed for this instance.
    pub(crate) fn apply(&mut self, message: &ConnectionEvents) -> ApplyReport {
        let closed_history_gap = if !self.unproven && message.reset {
            closed_history_gap(message, self.last_committed_at)
        } else {
            None
        };
        if self.unproven {
            return ApplyReport {
                counts: FilterCounts::default(),
                unproven: true,
                charged: false,
                closed_history_gap: None,
            };
        }
        let filtered = self.classification.filter(message);
        self.filter_counts.add(filtered.counts);
        if filtered.unproven {
            self.unproven = true;
            return ApplyReport {
                counts: filtered.counts,
                unproven: true,
                charged: false,
                closed_history_gap,
            };
        }
        if self.awaiting_baseline {
            if message.reset {
                self.accountant.baseline(&filtered.message);
                self.awaiting_baseline = false;
                self.dirty = true;
                return ApplyReport {
                    counts: filtered.counts,
                    unproven: false,
                    charged: false,
                    closed_history_gap: None,
                };
            }
            return ApplyReport {
                counts: filtered.counts,
                unproven: false,
                charged: false,
                closed_history_gap,
            };
        }
        let mut charged = false;
        for (user, (uplink, downlink)) in self.accountant.apply(&filtered.message) {
            if uplink == 0 && downlink == 0 {
                continue;
            }
            let entry = self.unsealed.entry(user).or_insert((0, 0));
            entry.0 = entry.0.saturating_add(uplink);
            entry.1 = entry.1.saturating_add(downlink);
            charged = true;
            self.dirty = true;
        }
        ApplyReport {
            counts: filtered.counts,
            unproven: false,
            charged,
            closed_history_gap,
        }
    }

    /// Drops out-of-retention batches before they can be sent. Removal becomes
    /// durable with the next successful commit.
    pub(crate) fn expire(&mut self, now: DateTime<Utc>, retention: Duration) -> Expired {
        let mut expired = Expired::default();
        let mut durable = self.durable;
        for index in (0..self.outbox.len()).rev() {
            if now - self.outbox[index].window_ended_at <= retention {
                continue;
            }
            expired.reports += 1;
            expired.entries += self.outbox[index].entries.len();
            self.outbox.remove(index);
            if index < durable {
                durable -= 1;
            }
        }
        self.durable = durable;
        if expired.reports > 0 {
            self.dirty = true;
        }
        expired
    }

    /// Imports legacy pending batches under their existing report ids. An
    /// already-present or previously-imported id is skipped; the same id with
    /// different content, an invalid batch, or a full outbox fails closed.
    pub(crate) fn import_batches(
        &mut self,
        batches: &[Batch],
    ) -> Result<ImportSummary, ImportError> {
        let queued: usize = self.outbox.iter().map(|batch| batch.entries.len()).sum();
        let mut summary = ImportSummary::default();
        let mut new_ids: Vec<&str> = Vec::new();
        let mut new_batches: Vec<&Batch> = Vec::new();
        let mut new_entries = 0_usize;
        for batch in batches {
            if !valid_import_batch(batch) {
                return Err(ImportError::InvalidBatch);
            }
            if let Some(existing) = self
                .outbox
                .iter()
                .find(|existing| existing.report_id == batch.report_id)
                .or_else(|| {
                    new_batches
                        .iter()
                        .find(|existing| existing.report_id == batch.report_id)
                        .copied()
                })
            {
                if existing.entries != batch.entries
                    || existing.window_started_at != batch.window_started_at
                    || existing.window_ended_at != batch.window_ended_at
                {
                    return Err(ImportError::Conflict {
                        report_id: batch.report_id.clone(),
                    });
                }
                summary.duplicates += 1;
                continue;
            }
            if self.legacy_imported.contains(&batch.report_id) {
                summary.duplicates += 1;
                continue;
            }
            if queued + new_entries + batch.entries.len() > MAX_OUTBOX_ENTRIES {
                return Err(ImportError::OutboxFull);
            }
            new_entries += batch.entries.len();
            new_ids.push(batch.report_id.as_str());
            new_batches.push(batch);
            summary.imported += 1;
        }
        if self.legacy_imported.len() + new_ids.len() > MAX_LEGACY_IMPORTED {
            return Err(ImportError::TooManyTombstones);
        }
        for batch in batches {
            if new_ids.contains(&batch.report_id.as_str()) {
                self.outbox.push(batch.clone());
                self.legacy_imported.insert(batch.report_id.clone());
            } else if self.outbox.iter().any(|e| e.report_id == batch.report_id) {
                self.legacy_imported.insert(batch.report_id.clone());
            }
        }
        if summary.imported > 0 || summary.duplicates > 0 {
            self.dirty = true;
        }
        Ok(summary)
    }

    /// Seals the deltas since the last commit into batches with fresh report
    /// ids and commits them with the counters that produced them and the
    /// remaining outbox in one atomic write. After a failed write the sealed
    /// batches stay in memory, unsendable, and the next commit retries them
    /// under the same ids.
    pub(crate) fn commit(
        &mut self,
        store: &CheckpointStore,
        now: DateTime<Utc>,
    ) -> Result<Commit, StoreError> {
        // An empty checkpoint for this instance would turn a later restart
        // into a resume that pays the not-yet-baselined snapshot in full.
        if self.awaiting_baseline {
            return Ok(Commit::Deferred(DeferredReason::AwaitingBaseline));
        }
        if self.unproven {
            return Ok(Commit::Deferred(
                DeferredReason::UnprovenInboundClassification,
            ));
        }
        let queued: usize = self.outbox.iter().map(|batch| batch.entries.len()).sum();
        if queued >= MAX_OUTBOX_ENTRIES {
            return Ok(Commit::Deferred(DeferredReason::OutboxFull));
        }
        while !self.unsealed.is_empty() {
            let entries = drain_entries(&mut self.unsealed, MAX_ENTRIES_PER_REPORT);
            if entries.is_empty() {
                continue;
            }
            self.outbox.push(Batch {
                version: BATCH_FORMAT_VERSION,
                report_id: new_report_id(now),
                window_started_at: self.window_started_at,
                window_ended_at: now,
                entries,
            });
        }
        let mut legacy_imported: Vec<String> = self.legacy_imported.iter().cloned().collect();
        legacy_imported.sort();
        let checkpoint = Checkpoint {
            schema: CHECKPOINT_SCHEMA,
            instance: self.instance.clone(),
            sequence: self.sequence + 1,
            committed_at: now,
            window_started_at: now,
            accountant: self.accountant.state(),
            outbox: self.outbox.clone(),
            legacy_imported,
        };
        store.commit(&checkpoint)?;
        self.sequence = checkpoint.sequence;
        self.window_started_at = now;
        self.last_committed_at = Some(now);
        self.durable = self.outbox.len();
        self.dirty = false;
        Ok(Commit::Committed)
    }

    /// Committed batches, oldest first. Only these may be sent.
    pub(crate) fn sendable(&self) -> &[Batch] {
        &self.outbox[..self.durable]
    }

    /// Forgets an acknowledged or permanently rejected batch. The removal
    /// becomes durable with the next commit; a crash before it resends the
    /// identical report, which the control plane answers as a duplicate.
    pub(crate) fn acknowledge(&mut self, report_id: &str) {
        let Some(index) = self
            .outbox
            .iter()
            .position(|batch| batch.report_id == report_id)
        else {
            return;
        };
        self.outbox.remove(index);
        if index < self.durable {
            self.durable -= 1;
        }
        self.dirty = true;
    }
}

fn closed_history_gap(
    message: &ConnectionEvents,
    last_committed_at: Option<DateTime<Utc>>,
) -> Option<UnobservableWindow> {
    let last_committed_at = last_committed_at?;
    let closed: Vec<DateTime<Utc>> = message
        .events
        .iter()
        .filter_map(|event| {
            let millis = event
                .connection
                .as_ref()
                .map(|connection| connection.closed_at)
                .filter(|millis| *millis > 0)
                .unwrap_or(event.closed_at);
            (millis > 0)
                .then(|| DateTime::from_timestamp_millis(millis))
                .flatten()
        })
        .collect();
    if closed.len() < CLOSED_HISTORY_LIMIT {
        return None;
    }
    let oldest = closed.iter().min().copied()?;
    (oldest > last_committed_at).then_some(UnobservableWindow {
        started_at: Some(last_committed_at),
        ended_at: oldest,
    })
}

fn valid_import_batch(batch: &Batch) -> bool {
    batch.version == BATCH_FORMAT_VERSION
        && is_report_id(&batch.report_id)
        && batch.entries.iter().all(|entry| {
            !entry.subscription_id.is_empty()
                && entry.uplink_bytes >= 0
                && entry.downlink_bytes >= 0
        })
}
