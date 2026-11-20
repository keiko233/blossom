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
//! The opt-in native service path in `agent_v2.rs` feeds task 04 runtime
//! observations here; processkit and the Docker profile keep the existing
//! `traffic.rs` reporter. [`NativeMetering`] registers a committed generation's
//! classification and sends one observation per serving invocation, so one
//! worker owns one meter at a time.

mod checkpoint;
mod filter;
mod import;
mod meter;
mod native;
mod store;
#[cfg(test)]
mod tests;
mod worker;

#[cfg(test)]
pub(crate) use checkpoint::InstanceKey;
pub(crate) use filter::InboundClassification;
#[cfg(test)]
pub(crate) use filter::InboundKind;
#[cfg(test)]
pub(crate) use import::LegacyImport;
#[cfg(test)]
pub(crate) use meter::{
    BaselineReason, Commit, DeferredReason, Expired, ImportError, Recovery, RuntimeMeter,
    UnobservableWindow,
};
pub(crate) use native::NativeMetering;
#[cfg(test)]
pub(crate) use store::{CheckpointStore, Damage, StoreError};
#[cfg(test)]
pub(crate) use worker::ApplyOutcome;
pub(crate) use worker::{
    MeteringConfig, MeteringState, MeteringWorker, StatsEndpoint, TonicEventSource,
};
