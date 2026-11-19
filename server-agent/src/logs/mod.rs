//! Bounded in-memory capture of the agent's events and of sing-box's stdout
//! and stderr, for tail replay, retained search and context lookup.
//!
//! Records are sanitized before insertion: secrets are redacted, controls are
//! stripped and length is capped. A fixed byte, line and age budget bounds
//! memory. Local logging is unchanged.

mod layer;
mod model;
mod ring;
mod search;
mod store;
mod text;

pub(crate) use layer::{CaptureLayer, SING_BOX_OUTPUT_TARGET};
#[cfg(test)]
pub(crate) use model::RingLimits;
pub(crate) use model::{
    GapReason, LogCursor, LogGap, LogLevel, LogRecord, LogSource, SearchCursor,
};
pub(crate) use ring::ContextError;
pub(crate) use search::{LogQuery, SearchError, SearchPage, SearchRequest};
pub(crate) use store::LogStore;
pub(crate) use text::{PrivateKeyBlock, SecretRegistryFull, SecretScope, strip_ansi};

#[cfg(test)]
mod tests;
