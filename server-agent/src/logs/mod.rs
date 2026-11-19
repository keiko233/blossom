//! Bounded in-memory capture of the agent's events and of sing-box's stdout
//! and stderr, for tail replay, retained search and context lookup.
//!
//! Records are sanitized before insertion: secrets are redacted, controls are
//! stripped and length is capped. A fixed byte, line and age budget bounds
//! memory. Local logging is unchanged.

// Tail, search and context reads have no caller inside the binary until the
// WebSocket log binding lands; the lint is suppressed only for non-test builds.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "query APIs are consumed by the WebSocket log binding in a follow-up change"
    )
)]

mod layer;
mod model;
mod ring;
mod search;
mod store;
mod text;

#[cfg(test)]
mod tests;
