//! Per-instance accountant and outbox committed together.

use std::collections::HashMap;

use chrono::{DateTime, Utc};

use super::checkpoint::{CHECKPOINT_SCHEMA, Checkpoint, InstanceKey};
use super::store::{CheckpointStore, Damage, StoreError, Stored};
use crate::accountant::ConnectionAccountant;
use crate::stats::ConnectionEvents;
use crate::traffic::{
    BATCH_FORMAT_VERSION, Batch, MAX_ENTRIES_PER_REPORT, drain_entries, new_report_id,
};

/// Upper bound on entries held in committed batches. Beyond it a commit is
/// deferred: the uncommitted counter progress is recomputed from the next
/// snapshot after a crash, so nothing is charged twice.
const MAX_OUTBOX_ENTRIES: usize = 50_000;

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
    },
    /// No trustworthy record of what this instance already paid. The first
    /// snapshot is adopted without charge; traffic before it is unobservable.
    Baseline(BaselineReason),
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
    /// Nothing written: the first snapshot has not been baselined yet, or the
    /// outbox is full. Retry after the next snapshot or acknowledgement.
    Deferred,
}

pub(crate) struct RuntimeMeter {
    instance: InstanceKey,
    sequence: u64,
    accountant: ConnectionAccountant,
    awaiting_baseline: bool,
    /// Deltas since the last commit; sealed only by a commit.
    unsealed: HashMap<String, (u64, u64)>,
    window_started_at: DateTime<Utc>,
    outbox: Vec<Batch>,
    /// Leading outbox batches made durable by a successful commit.
    durable: usize,
}

impl RuntimeMeter {
    /// Loads the store and classifies the attach to `instance`. Must run
    /// before the first stream message of this agent run is applied.
    pub(crate) fn recover(
        store: &CheckpointStore,
        instance: InstanceKey,
        now: DateTime<Utc>,
    ) -> Result<(Self, Recovery), StoreError> {
        let mut meter = Self {
            instance,
            sequence: 0,
            accountant: ConnectionAccountant::new(),
            awaiting_baseline: false,
            unsealed: HashMap::new(),
            window_started_at: now,
            outbox: Vec::new(),
            durable: 0,
        };
        let recovery = match store.read()? {
            Stored::Present(checkpoint) if checkpoint.instance == meter.instance => {
                meter.sequence = checkpoint.sequence;
                meter.accountant = ConnectionAccountant::from_state(checkpoint.accountant);
                meter.window_started_at = checkpoint.window_started_at;
                meter.durable = checkpoint.outbox.len();
                meter.outbox = checkpoint.outbox;
                Recovery::Resumed {
                    committed_at: checkpoint.committed_at,
                }
            }
            Stored::Present(checkpoint) => {
                meter.durable = checkpoint.outbox.len();
                meter.outbox = checkpoint.outbox;
                Recovery::NewInstance {
                    previous: checkpoint.instance,
                    previous_committed_at: checkpoint.committed_at,
                }
            }
            Stored::Absent => {
                meter.awaiting_baseline = true;
                Recovery::Baseline(BaselineReason::NoCheckpoint)
            }
            Stored::Damaged(damage) => {
                meter.awaiting_baseline = true;
                Recovery::Baseline(BaselineReason::Damaged(damage))
            }
        };
        Ok((meter, recovery))
    }

    pub(crate) fn instance(&self) -> &InstanceKey {
        &self.instance
    }

    /// Applies one stream message. While a baseline is pending, the first
    /// snapshot is adopted without charge and earlier updates are ignored.
    pub(crate) fn apply(&mut self, message: &ConnectionEvents) {
        if self.awaiting_baseline {
            if message.reset {
                self.accountant.baseline(message);
                self.awaiting_baseline = false;
            }
            return;
        }
        for (user, (uplink, downlink)) in self.accountant.apply(message) {
            let entry = self.unsealed.entry(user).or_insert((0, 0));
            entry.0 = entry.0.saturating_add(uplink);
            entry.1 = entry.1.saturating_add(downlink);
        }
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
            return Ok(Commit::Deferred);
        }
        let queued: usize = self.outbox.iter().map(|batch| batch.entries.len()).sum();
        if queued >= MAX_OUTBOX_ENTRIES {
            return Ok(Commit::Deferred);
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
        let checkpoint = Checkpoint {
            schema: CHECKPOINT_SCHEMA,
            instance: self.instance.clone(),
            sequence: self.sequence + 1,
            committed_at: now,
            window_started_at: now,
            accountant: self.accountant.state(),
            outbox: self.outbox.clone(),
        };
        store.commit(&checkpoint)?;
        self.sequence = checkpoint.sequence;
        self.window_started_at = now;
        self.durable = self.outbox.len();
        Ok(Commit::Committed)
    }

    /// Committed batches, oldest first. Only these may be sent.
    pub(crate) fn sendable(&self) -> &[Batch] {
        &self.outbox[..self.durable]
    }

    /// Forgets an acknowledged batch. The removal becomes durable with the
    /// next commit; a crash before it resends the identical report, which the
    /// control plane answers as a duplicate.
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
    }
}
