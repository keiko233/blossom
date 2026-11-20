//! Managed link-probe executor, local isolation and v2 runtime (Task 08).
//!
//! The module provides the bounded contract types, the explicit
//! `managed.probeBindings` mapping, peer-link authentication, a fixed
//! authenticated loopback ingress/responder pair, a candidate validator that
//! proves the data-plane cannot reach agent-owned loopback endpoints, and a
//! reusable executor. The authenticated v2 request/result wire and capability
//! advertisement are wired in `ws/v2` and `agent_v2`.
//!
//! Trust boundary: a probe is scoped to one planned link, one credential
//! generation and one stage attempt; it authenticates with the peer link
//! credential rather than a subscriber credential; it can reach only the fixed
//! responder endpoint through the planned peer outbound; and success requires
//! the source and destination committed managed generations to prove the
//! request's generation floors and fingerprints.

#![allow(
    dead_code,
    reason = "the probe runtime keeps compatibility helpers used by tests and the managed snapshot path"
)]

mod contract;
mod executor;
mod http;
mod identity;
mod isolation;
mod manifest;
mod responder;
mod runtime;

pub(crate) use contract::{
    LinkProbeOutcome, LinkProbeRequest, LinkProbeResult, MANAGED_LINK_PROBE_CAPABILITY,
    ManagedApplied,
};
pub(crate) use manifest::{ManagedProbeBinding, install_probe_config, validate_manifest};
pub(crate) use runtime::{
    ProbeExecution, ProbeRuntime, applied_generation, closed_result, unavailable_result,
};
