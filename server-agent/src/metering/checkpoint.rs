//! The durable runtime checkpoint and the instance key it is bound to.

use std::collections::HashSet;
use std::fmt;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::accountant::AccountantState;
use crate::service::RuntimeInstance;
use crate::traffic::{BATCH_FORMAT_VERSION, Batch};

pub(super) const CHECKPOINT_SCHEMA: u32 = 1;

const MAX_INSTANCE_KEY_LEN: usize = 160;

/// The stable [`RuntimeInstance`] key a checkpoint belongs to. It survives an
/// agent restart and changes with every new runtime invocation.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub(crate) struct InstanceKey(String);

impl From<&RuntimeInstance> for InstanceKey {
    fn from(instance: &RuntimeInstance) -> Self {
        Self(instance.to_string())
    }
}

impl TryFrom<String> for InstanceKey {
    type Error = CheckpointError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let valid = !value.is_empty()
            && value.len() <= MAX_INSTANCE_KEY_LEN
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
        if valid {
            Ok(Self(value))
        } else {
            Err(CheckpointError::InvalidInstance)
        }
    }
}

impl From<InstanceKey> for String {
    fn from(value: InstanceKey) -> Self {
        value.0
    }
}

impl fmt::Display for InstanceKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Everything one commit makes durable. Counters and the batches they were
/// sealed into are never persisted separately.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Checkpoint {
    pub(super) schema: u32,
    pub(super) instance: InstanceKey,
    /// Commits for this instance, starting at 1.
    pub(super) sequence: u64,
    pub(super) committed_at: DateTime<Utc>,
    pub(super) window_started_at: DateTime<Utc>,
    pub(super) accountant: AccountantState,
    /// Sealed, unacknowledged batches, oldest first.
    pub(super) outbox: Vec<Batch>,
}

impl Checkpoint {
    pub(crate) fn instance(&self) -> &InstanceKey {
        &self.instance
    }

    pub(crate) fn committed_at(&self) -> DateTime<Utc> {
        self.committed_at
    }

    pub(super) fn validate(&self) -> Result<(), CheckpointError> {
        if self.schema != CHECKPOINT_SCHEMA {
            return Err(CheckpointError::UnsupportedSchema(self.schema));
        }
        let mut report_ids = HashSet::new();
        for batch in &self.outbox {
            if batch.version != BATCH_FORMAT_VERSION {
                return Err(CheckpointError::InvalidBatch);
            }
            if !is_report_id(&batch.report_id) || !report_ids.insert(batch.report_id.as_str()) {
                return Err(CheckpointError::InvalidBatch);
            }
        }
        Ok(())
    }
}

/// The control plane's report id grammar: `[A-Za-z0-9._-]{8,128}`.
fn is_report_id(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CheckpointError {
    UnsupportedSchema(u32),
    InvalidInstance,
    InvalidBatch,
}

impl fmt::Display for CheckpointError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedSchema(schema) => {
                write!(formatter, "unsupported checkpoint schema {schema}")
            }
            Self::InvalidInstance => formatter.write_str("invalid runtime instance key"),
            Self::InvalidBatch => formatter.write_str("invalid outbox batch"),
        }
    }
}

impl std::error::Error for CheckpointError {}
