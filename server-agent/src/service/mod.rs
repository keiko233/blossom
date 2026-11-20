//! Opt-in native service lifecycle foundation.
//!
//! Systemd (or another external supervisor) owns process start, restart,
//! stop and observation; this module owns the durable decisions around them:
//! a one-shot candidate trial bound to one invocation, commit only while that
//! invocation still serves, a bounded attempt count and offline readiness
//! deadline, durable disable, and boot from the committed generation.
//!
//! The processkit child supervisor in `process.rs` remains the default
//! backend. `--native-service-control` opts into the helper-backed path, and
//! production activation of independent agent/runtime restarts stays gated on
//! restart-safe metering (task 05).
//!
//! Downstream contract: a [`RuntimeInstance`] is one generation running
//! under one invocation. Runtime counters and checkpoints are keyed by it; an
//! agent restart keeps the instance, a new invocation always starts a new one.

mod boot;
mod control;
mod helper;
mod journal;
mod lifecycle;
mod native;
mod ports;
mod promote;
mod store;
mod systemd;

pub(crate) use helper::{ServiceControlArgs, run as run_control};
#[cfg(test)]
pub(crate) use journal::Generation;
pub(crate) use journal::RuntimeInstance;
pub(crate) use native::NativeRuntime;
pub(crate) use ports::ActiveState;
#[cfg(test)]
pub(crate) use ports::{InvocationId, ServiceIdentity};
