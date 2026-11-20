//! Opt-in native service lifecycle foundation.
//!
//! Systemd (or another external supervisor) owns process start, restart,
//! stop and observation; this module owns the durable decisions around them:
//! a one-shot candidate trial bound to one invocation, commit only while that
//! invocation still serves, a bounded attempt count and offline readiness
//! deadline, durable disable, and boot from the committed generation.
//!
//! Nothing here is wired into the running agent yet. The processkit child
//! supervisor in `process.rs` remains the only active backend until native
//! activation is gated on restart-safe metering (task 05).
//!
//! Downstream contract: a [`RuntimeInstance`] is one generation running
//! under one invocation. Runtime counters and checkpoints are keyed by it; an
//! agent restart keeps the instance, a new invocation always starts a new one.

mod journal;
mod lifecycle;
mod ports;
mod store;

pub(crate) use journal::{
    ArtifactDigest, BootSelection, Generation, GenerationRecord, RuntimeInstance,
};
pub(crate) use lifecycle::{LifecycleError, ServiceLifecycle, select_boot};
pub(crate) use ports::{
    InvocationId, RuntimeService, ServiceError, ServiceIdentity, ServiceObservation,
    ServiceOperation,
};
pub(crate) use store::JournalStore;
