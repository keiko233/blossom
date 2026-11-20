//! Managed link-probe executor and local isolation (Task 08, Rust side).
//!
//! This module is not activated or advertised yet. It provides the bounded
//! contract types, peer-link authentication, a fixed authenticated loopback
//! ingress/responder pair, a candidate validator that proves the data-plane
//! cannot reach agent-owned loopback endpoints, and a reusable executor. The
//! authenticated v2 request/result wire, capability advertisement and
//! control-plane rollout glue belong to the integration pass.
//!
//! Trust boundary: a probe is scoped to one planned link, one credential
//! generation and one stage attempt; it authenticates with the peer link
//! credential rather than a subscriber credential; it can reach only the fixed
//! responder endpoint through the planned peer outbound; and success requires
//! the source and destination committed managed generations to prove the
//! request's generation floors and fingerprints.

#![allow(
    unused_imports,
    reason = "integration re-exports stay unused until the authenticated v2 probe wire lands"
)]
#![allow(
    dead_code,
    reason = "Task 08 Rust pieces remain unwired until the authenticated v2 probe integration lands"
)]

mod contract;
mod executor;
mod http;
mod identity;
mod isolation;
mod responder;

#[cfg(test)]
pub(crate) use contract::LinkProbeEndpoint;
pub(crate) use contract::{
    LinkProbeOutcome, LinkProbeRequest, LinkProbeResult, MANAGED_LINK_PROBE_CAPABILITY,
    MANAGED_LINK_PROBE_REQUEST_TYPE, MANAGED_LINK_PROBE_RESULT_TYPE, ManagedApplied,
    ManagedGeneration,
};
#[cfg(test)]
pub(crate) use executor::ProbeTransportError;
pub(crate) use executor::{
    HttpConnectProbeTransport, ProbeExecutionContext, ProbeExecutionError, ProbeExecutor,
    ProbeTransport,
};
pub(crate) use identity::{LinkCredential, PeerLinkIdentity, ProbeIdentityError};
pub(crate) use isolation::{
    ProbeCandidatePlan, ProbeIngress, ProbeIsolationError, ProbeIsolationExpectation,
    ProbeResponderRoute, install_probe_candidate, validate_candidate,
};
pub(crate) use responder::{ProbeError, ProbeResponder, ProbeResponderBinding};
