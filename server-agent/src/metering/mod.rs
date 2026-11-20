//! Restart-safe metering (task 05).
//!
//! One durable checkpoint per managed runtime commits, at a single atomic
//! boundary, the accountant's per-connection totals, its finalised connection
//! ids and the sealed outbox batches with their stable report ids. Batches are
//! sendable only once a commit has made them durable, so a crash either keeps
//! both the advanced counters and the batch, or neither.
//!
//! The checkpoint is keyed by the supervisor-provided
//! [`RuntimeInstance`](crate::service::RuntimeInstance). Recovery classifies
//! the attach as a resume of the same instance, a provably new instance, or a
//! baseline when the checkpoint is missing or damaged (see [`Recovery`]).
//! [`worker::MeteringWorker`] accepts those observations and resubscribes
//! under a new stream id after a replacement.
//!
//! Nothing here is wired into the running agent yet. `traffic.rs` keeps the
//! live accounting path, and processkit remains the Docker backend until
//! native service activation adopts this module.

mod checkpoint;
mod filter;
mod import;
mod meter;
mod store;
#[cfg(test)]
mod tests;
mod worker;

pub(crate) use checkpoint::{Checkpoint, InstanceKey};
pub(crate) use filter::{
    ClassificationError, FilterCounts, InboundClassification, InboundKind, ManagedMetering,
    MeteringCapabilityError, SubscriberIdentity, managed_metering,
};
pub(crate) use import::LegacyImport;
pub(crate) use meter::{
    ApplyReport, BaselineReason, Commit, DeferredReason, Expired, ImportError, ImportSummary,
    Recovery, RuntimeMeter, UnobservableWindow,
};
pub(crate) use store::{CheckpointStore, Damage, StoreError};
pub(crate) use worker::{
    ApplyOutcome, ConnectionEventSource, FlushReport, MeteringConfig, MeteringError, MeteringState,
    MeteringWorker, ObservationOutcome, RuntimeObservation, StatsEndpoint, TonicEventSource,
    UnattributedWindow,
};
