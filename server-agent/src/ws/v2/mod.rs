//! Agent WebSocket protocol v2 (`blossom-agent.v2`): the WebSocket-first
//! desired-state, status, and traffic path.
//!
//! The protocol is described in `docs/development/agent-ws-v2.md`, and the
//! contract is `packages/contracts/src/agent-ws-v2.ts`. The v1 frames in the
//! parent module are untouched; v2 is selected explicitly and never mixed
//! into a v1 session.

pub mod codec;
pub mod snapshot;
