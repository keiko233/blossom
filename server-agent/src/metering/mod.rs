//! Restart-safe metering foundation (task 05).
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
//!
//! Nothing here is wired into the running agent yet. `traffic.rs` keeps the
//! live accounting path until native service activation adopts this module.

mod checkpoint;
mod meter;
mod store;
#[cfg(test)]
mod tests;

pub(crate) use checkpoint::{Checkpoint, InstanceKey};
pub(crate) use meter::{BaselineReason, Commit, Recovery, RuntimeMeter};
pub(crate) use store::{CheckpointStore, Damage, StoreError};
