//! Retained-log search: validated queries, case-insensitive literal matching
//! and newest-first pages with resumable cursors.
//!
//! The store copies one bounded window out under its lock. This module
//! matches that window without holding the lock, so a slow search never
//! delays capture.

use std::error::Error;
use std::fmt;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use tokio_util::sync::CancellationToken;

use super::model::{
    GapReason, LogLevel, LogRecord, LogSource, SEARCH_PAGE_MAX, SEARCH_QUERY_MAX_CHARS,
    SearchCursor,
};
use super::ring::SearchSnapshot;

/// How often a scan checks for cancellation, in records.
const CANCEL_CHECK_EVERY: usize = 256;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct LogQuery {
    /// Literal text. Matching ignores ASCII case only; other characters must
    /// match exactly. Regular expressions are not supported.
    pub(crate) text: Option<String>,
    pub(crate) source: Option<LogSource>,
    /// Minimum severity, inclusive.
    pub(crate) min_level: Option<LogLevel>,
    /// Inclusive lower bound on record time.
    pub(crate) since: Option<DateTime<Utc>>,
    /// Exclusive upper bound on record time.
    pub(crate) until: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub(crate) struct SearchRequest {
    pub(crate) query: LogQuery,
    /// `None` starts a new search pinned to the current newest sequence.
    pub(crate) cursor: Option<SearchCursor>,
    pub(crate) limit: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QueryError {
    EmptyText,
    TextTooLong,
    LimitOutOfRange,
    InvalidRange,
}

impl fmt::Display for QueryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyText => f.write_str("search text must not be empty"),
            Self::TextTooLong => {
                write!(f, "search text exceeds {SEARCH_QUERY_MAX_CHARS} characters")
            }
            Self::LimitOutOfRange => {
                write!(f, "page size must be between 1 and {SEARCH_PAGE_MAX}")
            }
            Self::InvalidRange => f.write_str("time range start must precede its end"),
        }
    }
}

impl Error for QueryError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SearchError {
    Query(QueryError),
    /// Too many searches are already running.
    Busy,
    Cancelled,
    /// The buffer lock is poisoned, so the store cannot be read.
    Unavailable,
}

impl fmt::Display for SearchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Query(error) => fmt::Display::fmt(error, f),
            Self::Busy => f.write_str("too many concurrent log searches"),
            Self::Cancelled => f.write_str("log search was cancelled"),
            Self::Unavailable => f.write_str("log buffer is unavailable"),
        }
    }
}

impl Error for SearchError {}

impl From<QueryError> for SearchError {
    fn from(error: QueryError) -> Self {
        Self::Query(error)
    }
}

/// Coverage of one page. A set `gap` means results are incomplete, and the
/// operator should rerun the search.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Coverage {
    pub(crate) gap: Option<GapReason>,
    /// Time range of the retained buffer at the moment of this page.
    pub(crate) searchable_from: Option<DateTime<Utc>>,
    pub(crate) searchable_to: Option<DateTime<Utc>>,
}

#[derive(Debug)]
pub(crate) struct SearchPage {
    pub(crate) generation: u64,
    pub(crate) pinned_seq: u64,
    /// Newest first.
    pub(crate) matches: Vec<Arc<LogRecord>>,
    /// `None` when the scan reached the oldest retained record, or when
    /// coverage was lost.
    pub(crate) next: Option<SearchCursor>,
    pub(crate) coverage: Coverage,
}

impl LogQuery {
    pub(crate) fn validate(&self, limit: usize) -> Result<(), QueryError> {
        if let Some(text) = &self.text {
            if text.is_empty() {
                return Err(QueryError::EmptyText);
            }
            if text.chars().count() > SEARCH_QUERY_MAX_CHARS {
                return Err(QueryError::TextTooLong);
            }
        }
        if !(1..=SEARCH_PAGE_MAX).contains(&limit) {
            return Err(QueryError::LimitOutOfRange);
        }
        if let (Some(since), Some(until)) = (self.since, self.until)
            && since >= until
        {
            return Err(QueryError::InvalidRange);
        }
        Ok(())
    }

    fn matches(&self, record: &LogRecord, needle: Option<&[u8]>) -> bool {
        self.source.is_none_or(|source| source == record.source)
            && self.min_level.is_none_or(|min| record.level >= min)
            && self.since.is_none_or(|since| record.time >= since)
            && self.until.is_none_or(|until| record.time < until)
            && needle
                .is_none_or(|needle| contains_ascii_insensitive(record.text.as_bytes(), needle))
    }
}

/// Matches a literal needle with ASCII-only case folding. Non-ASCII bytes
/// compare exactly, so a window never splits a UTF-8 sequence.
fn contains_ascii_insensitive(haystack: &[u8], needle: &[u8]) -> bool {
    needle.is_empty()
        || haystack
            .windows(needle.len())
            .any(|window| window.eq_ignore_ascii_case(needle))
}

/// Matches one snapshot window and builds the page. Returns `Cancelled` as
/// soon as the token fires, so a replaced query stops scanning quickly.
pub(crate) fn scan_page(
    snapshot: SearchSnapshot,
    request: &SearchRequest,
    cancel: &CancellationToken,
) -> Result<SearchPage, SearchError> {
    request.query.validate(request.limit)?;
    if cancel.is_cancelled() {
        return Err(SearchError::Cancelled);
    }

    let (searchable_from, searchable_to) = match snapshot.searchable {
        Some((from, to)) => (Some(from), Some(to)),
        None => (None, None),
    };
    let coverage = Coverage {
        gap: snapshot.gap,
        searchable_from,
        searchable_to,
    };
    if snapshot.gap.is_some() {
        return Ok(SearchPage {
            generation: snapshot.generation,
            pinned_seq: snapshot.pinned_seq,
            matches: Vec::new(),
            next: None,
            coverage,
        });
    }

    let needle = request.query.text.as_deref().map(str::as_bytes);
    let mut matches = Vec::new();
    for (index, record) in snapshot.records.iter().enumerate() {
        if index % CANCEL_CHECK_EVERY == 0 && cancel.is_cancelled() {
            return Err(SearchError::Cancelled);
        }
        if !request.query.matches(record, needle) {
            continue;
        }
        matches.push(Arc::clone(record));
        if matches.len() == request.limit {
            // Resume just below this match. Records older than it remain
            // when the window has more after it, or the store has more.
            let older = index + 1 < snapshot.records.len() || snapshot.more_retained;
            let next = older.then(|| SearchCursor {
                generation: snapshot.generation,
                pinned_seq: snapshot.pinned_seq,
                before: record.seq,
                floor: snapshot.floor,
            });
            return Ok(SearchPage {
                generation: snapshot.generation,
                pinned_seq: snapshot.pinned_seq,
                matches,
                next,
                coverage,
            });
        }
    }

    let next = if snapshot.more_retained {
        snapshot.records.last().map(|oldest| SearchCursor {
            generation: snapshot.generation,
            pinned_seq: snapshot.pinned_seq,
            before: oldest.seq,
            floor: snapshot.floor,
        })
    } else {
        None
    };
    Ok(SearchPage {
        generation: snapshot.generation,
        pinned_seq: snapshot.pinned_seq,
        matches,
        next,
        coverage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::model::RingLimits;
    use crate::logs::ring::LogRing;
    use chrono::TimeZone;

    fn at(secs: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(1_800_000_000 + secs, 0).unwrap()
    }

    fn ring_with(lines: &[(LogSource, LogLevel, &str)]) -> LogRing {
        let mut ring = LogRing::new(9, RingLimits::default());
        for (index, (source, level, text)) in lines.iter().enumerate() {
            ring.push(
                at(i64::try_from(index).unwrap()),
                *source,
                *level,
                1,
                (*text).to_owned(),
                false,
            );
        }
        ring
    }

    fn run(
        ring: &LogRing,
        query: LogQuery,
        cursor: Option<SearchCursor>,
        limit: usize,
    ) -> Result<SearchPage, SearchError> {
        let request = SearchRequest {
            query,
            cursor,
            limit,
        };
        scan_page(
            ring.search_snapshot(cursor),
            &request,
            &CancellationToken::new(),
        )
    }

    fn texts(page: &SearchPage) -> Vec<&str> {
        page.matches.iter().map(|r| r.text.as_str()).collect()
    }

    fn text_query(text: &str) -> LogQuery {
        LogQuery {
            text: Some(text.to_owned()),
            ..LogQuery::default()
        }
    }

    #[test]
    fn query_validation_rejects_bad_inputs() {
        assert_eq!(text_query("").validate(10), Err(QueryError::EmptyText));
        assert_eq!(
            text_query(&"a".repeat(SEARCH_QUERY_MAX_CHARS + 1)).validate(10),
            Err(QueryError::TextTooLong)
        );
        assert!(
            text_query(&"é".repeat(SEARCH_QUERY_MAX_CHARS))
                .validate(10)
                .is_ok()
        );
        assert_eq!(
            LogQuery::default().validate(0),
            Err(QueryError::LimitOutOfRange)
        );
        assert_eq!(
            LogQuery::default().validate(SEARCH_PAGE_MAX + 1),
            Err(QueryError::LimitOutOfRange)
        );
        let inverted = LogQuery {
            since: Some(at(5)),
            until: Some(at(5)),
            ..LogQuery::default()
        };
        assert_eq!(inverted.validate(10), Err(QueryError::InvalidRange));
    }

    #[test]
    fn text_match_is_case_insensitive_and_literal() {
        let ring = ring_with(&[
            (
                LogSource::Agent,
                LogLevel::Info,
                "Connection REFUSED by peer",
            ),
            (
                LogSource::Agent,
                LogLevel::Info,
                "refused.* is literal here",
            ),
            (LogSource::Agent, LogLevel::Info, "unrelated"),
        ]);
        let page = run(&ring, text_query("refused"), None, 10).unwrap();
        assert_eq!(
            texts(&page),
            vec!["refused.* is literal here", "Connection REFUSED by peer"]
        );
        let literal = run(&ring, text_query("ed.*"), None, 10).unwrap();
        assert_eq!(texts(&literal), vec!["refused.* is literal here"]);
    }

    #[test]
    fn only_ascii_letters_fold_case() {
        let ring = ring_with(&[(LogSource::Agent, LogLevel::Info, "Ärger in Zürich")]);
        // ASCII letters fold, so `zürich` matches `Zürich`.
        assert_eq!(
            texts(&run(&ring, text_query("zürich"), None, 10).unwrap()),
            vec!["Ärger in Zürich"]
        );
        // `ü` and `Ü` are not ASCII, so they must match exactly.
        assert!(
            run(&ring, text_query("ZÜRICH"), None, 10)
                .unwrap()
                .matches
                .is_empty()
        );
    }

    #[test]
    fn source_severity_and_time_filters_compose() {
        let ring = ring_with(&[
            (LogSource::Agent, LogLevel::Info, "a0"),
            (LogSource::SingBox, LogLevel::Error, "s1"),
            (LogSource::SingBox, LogLevel::Debug, "s2"),
            (LogSource::Agent, LogLevel::Warn, "a3"),
            (LogSource::SingBox, LogLevel::Info, "s4"),
        ]);
        let by_source = LogQuery {
            source: Some(LogSource::SingBox),
            ..LogQuery::default()
        };
        assert_eq!(
            texts(&run(&ring, by_source, None, 10).unwrap()),
            vec!["s4", "s2", "s1"]
        );

        let warn_up = LogQuery {
            min_level: Some(LogLevel::Warn),
            ..LogQuery::default()
        };
        assert_eq!(
            texts(&run(&ring, warn_up, None, 10).unwrap()),
            vec!["a3", "s1"]
        );

        let window = LogQuery {
            since: Some(at(1)),
            until: Some(at(4)),
            source: Some(LogSource::Agent),
            ..LogQuery::default()
        };
        assert_eq!(texts(&run(&ring, window, None, 10).unwrap()), vec!["a3"]);
    }

    #[test]
    fn pages_are_newest_first_and_continue_exactly() {
        let lines: Vec<_> = (0..7)
            .map(|n| {
                (
                    LogSource::Agent,
                    LogLevel::Info,
                    if n % 2 == 0 { "hit" } else { "miss" },
                )
            })
            .collect();
        let ring = ring_with(&lines);
        let first = run(&ring, text_query("hit"), None, 2).unwrap();
        let first_seqs: Vec<_> = first.matches.iter().map(|r| r.seq).collect();
        assert_eq!(first_seqs, vec![7, 5]);
        let second = run(&ring, text_query("hit"), first.next, 2).unwrap();
        let second_seqs: Vec<_> = second.matches.iter().map(|r| r.seq).collect();
        assert_eq!(second_seqs, vec![3, 1]);
        assert_eq!(second.next, None);
        assert_eq!(second.pinned_seq, 7);
        assert_eq!(second.coverage.gap, None);
    }

    #[test]
    fn continuation_after_overwrite_reports_gap_and_stops() {
        let mut ring = LogRing::new(
            9,
            RingLimits {
                max_lines: 4,
                ..RingLimits::default()
            },
        );
        for n in 0..4 {
            ring.push(
                at(n),
                LogSource::Agent,
                LogLevel::Info,
                1,
                "hit".into(),
                false,
            );
        }
        let first = run(&ring, text_query("hit"), None, 1).unwrap();
        assert_eq!(first.matches[0].seq, 4);
        let cursor = first.next.expect("older records remain");
        // Eviction overtakes the continuation before it runs.
        for n in 4..8 {
            ring.push(
                at(n),
                LogSource::Agent,
                LogLevel::Info,
                1,
                "hit".into(),
                false,
            );
        }
        let stale = run(&ring, text_query("hit"), Some(cursor), 10).unwrap();
        assert_eq!(stale.coverage.gap, Some(GapReason::Overwritten));
        assert!(stale.matches.is_empty());
        assert_eq!(stale.next, None);
    }

    #[test]
    fn search_for_other_generation_reports_restart() {
        let ring = ring_with(&[(LogSource::Agent, LogLevel::Info, "hit")]);
        let cursor = SearchCursor {
            generation: 1,
            pinned_seq: 1,
            before: 1,
            floor: 0,
        };
        let page = run(&ring, text_query("hit"), Some(cursor), 10).unwrap();
        assert_eq!(page.coverage.gap, Some(GapReason::Restarted));
        assert_eq!(page.generation, 9);
    }

    #[test]
    fn scan_budget_pages_through_history_without_losing_records() {
        let lines: Vec<_> = (0..(crate::logs::model::SEARCH_SCAN_MAX_RECORDS + 10))
            .map(|n| {
                (
                    LogSource::Agent,
                    LogLevel::Info,
                    if n % 500 == 0 { "hit" } else { "miss" },
                )
            })
            .collect();
        let ring = ring_with(&lines);
        let mut cursor = None;
        let mut found = Vec::new();
        loop {
            let page = run(&ring, text_query("hit"), cursor, 100).unwrap();
            found.extend(page.matches.iter().map(|r| r.seq));
            cursor = page.next;
            if cursor.is_none() {
                break;
            }
        }
        let expected: Vec<_> = (0..lines.len())
            .filter(|n| n % 500 == 0)
            .rev()
            .map(|n| u64::try_from(n).unwrap() + 1)
            .collect();
        assert_eq!(found, expected);
    }

    #[test]
    fn cancelled_token_stops_scan_with_typed_error() {
        let ring = ring_with(&[(LogSource::Agent, LogLevel::Info, "hit")]);
        let request = SearchRequest {
            query: text_query("hit"),
            cursor: None,
            limit: 10,
        };
        let cancel = CancellationToken::new();
        cancel.cancel();
        let result = scan_page(ring.search_snapshot(None), &request, &cancel);
        assert_eq!(result.unwrap_err(), SearchError::Cancelled);
    }

    #[test]
    fn empty_buffer_reports_no_searchable_range() {
        let ring = LogRing::new(9, RingLimits::default());
        let page = run(&ring, LogQuery::default(), None, 10).unwrap();
        assert!(page.matches.is_empty());
        assert_eq!(page.coverage.searchable_from, None);
        assert_eq!(page.coverage.gap, None);
    }
}
