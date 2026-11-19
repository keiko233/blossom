//! Record, cursor and budget types shared by the retained log buffer.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

/// Total retained text plus per-record overhead, in bytes.
pub(crate) const DEFAULT_MAX_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const DEFAULT_MAX_LINES: usize = 10_000;
pub(crate) const DEFAULT_MAX_AGE_HOURS: i64 = 24;
/// Longest retained text per record. Longer lines are cut on a char boundary.
pub(crate) const MAX_TEXT_BYTES: usize = 4096;
/// Fixed accounting added to each record's text, approximating struct, `Arc`
/// and queue overhead so the byte budget tracks real memory use.
pub(crate) const RECORD_OVERHEAD_BYTES: usize = 96;
/// Largest batch a resume call returns; a client loops while `has_more`.
pub(crate) const RESUME_MAX_RECORDS: usize = 500;
pub(crate) const CONTEXT_MAX_LINES: usize = 50;
pub(crate) const SEARCH_QUERY_MAX_CHARS: usize = 256;
pub(crate) const SEARCH_PAGE_MAX: usize = 100;
/// Per-call scan budgets. A page returns a continuation cursor when a budget
/// stops it early, so one call never walks an unbounded amount of history.
pub(crate) const SEARCH_SCAN_MAX_RECORDS: usize = 2048;
pub(crate) const SEARCH_SCAN_MAX_BYTES: usize = 1024 * 1024;
pub(crate) const SEARCH_MAX_CONCURRENT: usize = 2;

/// Where a record came from. The agent's own tracing events and sing-box's
/// supervised stdout and stderr are separate sources so they can be filtered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum LogSource {
    Agent,
    SingBox,
}

/// Ordered from least to most severe, so `>=` expresses "at least this level".
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogRecord {
    pub(crate) seq: u64,
    pub(crate) time: DateTime<Utc>,
    pub(crate) source: LogSource,
    pub(crate) level: LogLevel,
    /// Which sing-box process run emitted the record. Agent records carry the
    /// run that was current when they were written.
    pub(crate) process_generation: u64,
    /// Normalized and redacted before insertion.
    pub(crate) text: String,
    pub(crate) truncated: bool,
}

impl LogRecord {
    pub(crate) fn cost(&self) -> usize {
        self.text.len() + RECORD_OVERHEAD_BYTES
    }
}

/// Why records a reader expected are not available.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum GapReason {
    /// The agent restarted, so the buffer generation changed.
    Restarted,
    /// Eviction removed records the reader had not yet received.
    Overwritten,
}

/// A run of sequence numbers that is no longer retained. Bounds are inclusive
/// and both zero for a restart, where no sequence range is meaningful.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogGap {
    pub(crate) reason: GapReason,
    pub(crate) from_seq: u64,
    pub(crate) to_seq: u64,
}

/// Tail-reader position: the last sequence delivered from one buffer generation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogCursor {
    pub(crate) generation: u64,
    pub(crate) seq: u64,
}

/// Search continuation. `before` is exclusive and walks newest to oldest.
/// `pinned_seq` is the newest sequence at search start, and `floor` is the
/// eviction watermark at search start. Eviction past `floor` for sequences
/// below `before` means the continuation has lost coverage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchCursor {
    pub(crate) generation: u64,
    pub(crate) pinned_seq: u64,
    pub(crate) before: u64,
    pub(crate) floor: u64,
}

/// Retention budgets. Eviction keeps the buffer under all three.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RingLimits {
    pub(crate) max_bytes: usize,
    pub(crate) max_lines: usize,
    pub(crate) max_age: Duration,
}

impl Default for RingLimits {
    fn default() -> Self {
        Self {
            max_bytes: DEFAULT_MAX_BYTES,
            max_lines: DEFAULT_MAX_LINES,
            max_age: Duration::hours(DEFAULT_MAX_AGE_HOURS),
        }
    }
}
