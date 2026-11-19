//! Sequence-numbered ring of captured records under byte, line and age budgets.
//!
//! The ring takes no lock and reads no clock. Callers pass the wall-clock
//! instant and serialize access. Records are shared as `Arc`s so readers can
//! copy them out of the lock cheaply.

use std::collections::VecDeque;
use std::sync::Arc;

use chrono::{DateTime, Utc};

use super::model::{
    GapReason, LogCursor, LogGap, LogLevel, LogRecord, LogSource, RESUME_MAX_RECORDS, RingLimits,
    SEARCH_SCAN_MAX_BYTES, SEARCH_SCAN_MAX_RECORDS, SearchCursor,
};

pub(crate) struct LogRing {
    generation: u64,
    /// Sequence assigned to the next record. Starts at 1 so 0 means "none".
    next_seq: u64,
    records: VecDeque<Arc<LogRecord>>,
    bytes: usize,
    /// Highest sequence evicted so far, or 0 when nothing has been evicted.
    /// Eviction is FIFO, so every sequence at or below this value is gone.
    evicted_through: u64,
    limits: RingLimits,
}

/// Result of a tail or resume read.
#[derive(Debug)]
pub(crate) struct LogResume {
    pub(crate) generation: u64,
    pub(crate) gap: Option<LogGap>,
    /// Ascending by sequence, at most the requested limit.
    pub(crate) records: Vec<Arc<LogRecord>>,
    /// Position after the last delivered record. Pass it back as `after`.
    pub(crate) next: LogCursor,
    pub(crate) has_more: bool,
}

/// One search scan window, copied out under the lock. Records are newest first.
#[derive(Debug)]
pub(crate) struct SearchSnapshot {
    pub(crate) generation: u64,
    pub(crate) pinned_seq: u64,
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "asserted by the search-snapshot tests")
    )]
    pub(crate) before: u64,
    pub(crate) floor: u64,
    /// Set when coverage is lost. `records` is empty in that case.
    pub(crate) gap: Option<GapReason>,
    /// Oldest and newest retained record times, when the buffer is non-empty.
    pub(crate) searchable: Option<(DateTime<Utc>, DateTime<Utc>)>,
    pub(crate) records: Vec<Arc<LogRecord>>,
    /// Older retained records remain beyond this window.
    pub(crate) more_retained: bool,
}

/// A record with its same-source, same-process-run neighbours.
#[derive(Debug)]
pub(crate) struct LogContext {
    pub(crate) target: Arc<LogRecord>,
    /// Ascending, nearest last.
    pub(crate) before: Vec<Arc<LogRecord>>,
    /// Ascending, nearest first.
    pub(crate) after: Vec<Arc<LogRecord>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ContextError {
    /// The buffer generation changed since the record was seen.
    Restarted,
    /// The record existed but eviction has removed it.
    Overwritten,
    /// The sequence was never assigned in this generation.
    NotFound,
    /// The buffer lock is poisoned.
    Unavailable,
}

impl LogRing {
    pub(crate) fn new(generation: u64, limits: RingLimits) -> Self {
        Self {
            generation,
            next_seq: 1,
            records: VecDeque::new(),
            bytes: 0,
            evicted_through: 0,
            limits,
        }
    }

    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "asserted by the log store tests")
    )]
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn newest_seq(&self) -> u64 {
        self.next_seq - 1
    }

    /// Pushes a normalized, redacted record and applies the budgets. The
    /// record just written is never evicted for size, so one oversized record
    /// cannot empty the buffer it lands in.
    pub(crate) fn push(
        &mut self,
        now: DateTime<Utc>,
        source: LogSource,
        level: LogLevel,
        process_generation: u64,
        text: String,
        truncated: bool,
    ) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        let record = LogRecord {
            seq,
            time: now,
            source,
            level,
            process_generation,
            text,
            truncated,
        };
        self.bytes += record.cost();
        self.records.push_back(Arc::new(record));
        self.evict(now);
        seq
    }

    /// Applies the age budget, then the byte and line budgets.
    pub(crate) fn evict(&mut self, now: DateTime<Utc>) {
        while let Some(front) = self.records.front() {
            let expired = now.signed_duration_since(front.time) > self.limits.max_age;
            let over_budget =
                self.bytes > self.limits.max_bytes || self.records.len() > self.limits.max_lines;
            // The newest record survives budget pressure, but not expiry.
            if !expired && !(over_budget && self.records.len() > 1) {
                break;
            }
            let Some(evicted) = self.records.pop_front() else {
                break;
            };
            self.bytes -= evicted.cost();
            self.evicted_through = evicted.seq;
        }
    }

    /// Replays records after `after`, or the newest `limit` records when
    /// `after` is `None`. Within one generation the result is sequence-exact:
    /// successive calls that pass back `next` deliver every retained record
    /// once, and any evicted span is reported as a gap rather than skipped.
    pub(crate) fn resume(&self, after: Option<LogCursor>, limit: usize) -> LogResume {
        let limit = limit.clamp(1, RESUME_MAX_RECORDS);
        let newest = self.newest_seq();
        let Some(cursor) = after else {
            return self.tail_resume(None, limit);
        };
        if cursor.generation != self.generation || cursor.seq > newest {
            return self.tail_resume(Some(GapReason::Restarted), limit);
        }

        let oldest = self.oldest_seq();
        let first_wanted = cursor.seq + 1;
        let mut gap = None;
        let mut start = first_wanted;
        if first_wanted < oldest {
            gap = Some(LogGap {
                reason: GapReason::Overwritten,
                from_seq: first_wanted,
                to_seq: oldest - 1,
            });
            start = oldest;
        }

        let begin = self.records.partition_point(|r| r.seq < start);
        let records: Vec<_> = self.records.range(begin..).take(limit).cloned().collect();
        let has_more = begin + records.len() < self.records.len();
        let next_seq = match (records.last(), gap) {
            (Some(last), _) => last.seq,
            (None, Some(gap)) => gap.to_seq,
            (None, None) => cursor.seq,
        };
        LogResume {
            generation: self.generation,
            gap,
            records,
            next: LogCursor {
                generation: self.generation,
                seq: next_seq,
            },
            has_more,
        }
    }

    /// Newest `limit` records, reporting the restart gap when `reason` is set.
    fn tail_resume(&self, reason: Option<GapReason>, limit: usize) -> LogResume {
        let skip = self.records.len().saturating_sub(limit);
        let records: Vec<_> = self.records.range(skip..).cloned().collect();
        let gap = reason.map(|reason| LogGap {
            reason,
            from_seq: 0,
            to_seq: 0,
        });
        LogResume {
            generation: self.generation,
            gap,
            records,
            next: LogCursor {
                generation: self.generation,
                seq: self.newest_seq(),
            },
            has_more: false,
        }
    }

    /// Copies one search window: up to the scan budgets, newest first, below
    /// the continuation position. Matching happens outside the lock.
    pub(crate) fn search_snapshot(&self, cursor: Option<SearchCursor>) -> SearchSnapshot {
        let newest_seq = self.newest_seq();
        let searchable = self
            .records
            .front()
            .zip(self.records.back())
            .map(|(oldest, newest)| (oldest.time, newest.time));
        let (before, pinned_seq, floor, gap) = match cursor {
            None => (self.next_seq, newest_seq, self.evicted_through, None),
            Some(cursor)
                if cursor.generation != self.generation || cursor.before > self.next_seq =>
            {
                (
                    0,
                    newest_seq,
                    self.evicted_through,
                    Some(GapReason::Restarted),
                )
            }
            Some(cursor) => {
                // Anything evicted after the search started and below `before`
                // is missing from the continuation.
                let overwritten =
                    self.evicted_through > cursor.floor && cursor.floor + 1 < cursor.before;
                let gap = overwritten.then_some(GapReason::Overwritten);
                (cursor.before, cursor.pinned_seq, cursor.floor, gap)
            }
        };

        let mut records = Vec::new();
        let mut more_retained = false;
        if gap.is_none() {
            let end = self.records.partition_point(|r| r.seq < before);
            let mut bytes = 0;
            for record in self.records.range(..end).rev() {
                let over_bytes =
                    !records.is_empty() && bytes + record.text.len() > SEARCH_SCAN_MAX_BYTES;
                if records.len() == SEARCH_SCAN_MAX_RECORDS || over_bytes {
                    more_retained = true;
                    break;
                }
                bytes += record.text.len();
                records.push(Arc::clone(record));
            }
        }

        SearchSnapshot {
            generation: self.generation,
            pinned_seq: if gap == Some(GapReason::Restarted) {
                newest_seq
            } else {
                pinned_seq
            },
            before,
            floor,
            gap,
            searchable,
            records,
            more_retained,
        }
    }

    /// Returns `seq` with its neighbours from the same source and process run.
    pub(crate) fn context(
        &self,
        generation: u64,
        seq: u64,
        before_max: usize,
        after_max: usize,
    ) -> Result<LogContext, ContextError> {
        if generation != self.generation {
            return Err(ContextError::Restarted);
        }
        let index = match self.records.binary_search_by_key(&seq, |r| r.seq) {
            Ok(index) => index,
            Err(_) if seq >= 1 && seq <= self.evicted_through => {
                return Err(ContextError::Overwritten);
            }
            Err(_) => return Err(ContextError::NotFound),
        };
        let target = Arc::clone(&self.records[index]);
        let same_run = |other: &LogRecord| {
            other.source == target.source && other.process_generation == target.process_generation
        };
        let mut before: Vec<_> = self
            .records
            .range(..index)
            .rev()
            .filter(|r| same_run(r))
            .take(before_max)
            .cloned()
            .collect();
        before.reverse();
        let after: Vec<_> = self
            .records
            .range(index + 1..)
            .filter(|r| same_run(r))
            .take(after_max)
            .cloned()
            .collect();
        Ok(LogContext {
            target,
            before,
            after,
        })
    }

    fn oldest_seq(&self) -> u64 {
        self.records
            .front()
            .map_or(self.next_seq, |record| record.seq)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::model::RECORD_OVERHEAD_BYTES;
    use chrono::{Duration, TimeZone};

    fn at(secs: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(1_800_000_000 + secs, 0).unwrap()
    }

    fn small(max_bytes: usize, max_lines: usize, max_age_secs: i64) -> RingLimits {
        RingLimits {
            max_bytes,
            max_lines,
            max_age: Duration::seconds(max_age_secs),
        }
    }

    fn push(ring: &mut LogRing, now: DateTime<Utc>, text: &str) -> u64 {
        ring.push(
            now,
            LogSource::Agent,
            LogLevel::Info,
            0,
            text.to_owned(),
            false,
        )
    }

    #[test]
    fn line_budget_evicts_oldest_and_tracks_watermark() {
        let mut ring = LogRing::new(7, small(usize::MAX / 2, 3, 3600));
        for n in 0..5 {
            push(&mut ring, at(n), "x");
        }
        assert_eq!(ring.oldest_seq(), 3);
        assert_eq!(ring.evicted_through, 2);
        assert_eq!(ring.records.len(), 3);
    }

    #[test]
    fn byte_budget_counts_text_and_overhead() {
        let cost = 10 + RECORD_OVERHEAD_BYTES;
        let mut ring = LogRing::new(7, small(cost * 2, 100, 3600));
        push(&mut ring, at(0), "0123456789");
        push(&mut ring, at(1), "0123456789");
        assert_eq!(ring.records.len(), 2);
        assert_eq!(ring.bytes, cost * 2);
        push(&mut ring, at(2), "0123456789");
        assert_eq!(ring.records.len(), 2);
        assert_eq!(ring.bytes, cost * 2);
        assert_eq!(ring.evicted_through, 1);
    }

    #[test]
    fn oversized_newest_record_survives_budget_pressure() {
        let mut ring = LogRing::new(7, small(10, 100, 3600));
        push(&mut ring, at(0), "a much longer line than the byte budget");
        assert_eq!(ring.records.len(), 1);
        assert_eq!(ring.evicted_through, 0);
    }

    #[test]
    fn age_budget_expires_records_even_without_writes() {
        let mut ring = LogRing::new(7, small(usize::MAX / 2, 100, 60));
        push(&mut ring, at(0), "old");
        push(&mut ring, at(30), "recent");
        ring.evict(at(61));
        assert_eq!(ring.records.len(), 1);
        assert_eq!(ring.records[0].text, "recent");
        ring.evict(at(200));
        assert!(ring.records.is_empty());
        assert_eq!(ring.evicted_through, 2);
    }

    #[test]
    fn bytes_accounting_stays_exact_after_eviction_cycles() {
        let mut ring = LogRing::new(7, small(500, 4, 3600));
        for n in 0..50 {
            push(
                &mut ring,
                at(n),
                &"y".repeat(usize::try_from(n % 9).unwrap()),
            );
        }
        let expected: usize = ring.records.iter().map(|r| r.cost()).sum();
        assert_eq!(ring.bytes, expected);
    }

    #[test]
    fn resume_from_none_returns_newest_tail() {
        let mut ring = LogRing::new(7, RingLimits::default());
        for n in 0..10 {
            push(&mut ring, at(n), &format!("line {n}"));
        }
        let tail = ring.resume(None, 3);
        let seqs: Vec<_> = tail.records.iter().map(|r| r.seq).collect();
        assert_eq!(seqs, vec![8, 9, 10]);
        assert_eq!(tail.gap, None);
        assert_eq!(
            tail.next,
            LogCursor {
                generation: 7,
                seq: 10
            }
        );
    }

    #[test]
    fn resume_replays_every_record_exactly_once_in_batches() {
        let mut ring = LogRing::new(7, RingLimits::default());
        for n in 0..25 {
            push(&mut ring, at(n), "x");
        }
        let mut cursor = Some(LogCursor {
            generation: 7,
            seq: 0,
        });
        let mut seen = Vec::new();
        loop {
            let batch = ring.resume(cursor, 4);
            assert_eq!(batch.gap, None);
            seen.extend(batch.records.iter().map(|r| r.seq));
            cursor = Some(batch.next);
            if !batch.has_more {
                break;
            }
        }
        assert_eq!(seen, (1..=25).collect::<Vec<_>>());
    }

    #[test]
    fn resume_reports_evicted_span_as_gap_without_skipping_silently() {
        let mut ring = LogRing::new(7, small(usize::MAX / 2, 3, 3600));
        for n in 0..6 {
            push(&mut ring, at(n), "x");
        }
        // Reader last saw seq 1; seqs 2 and 3 were evicted.
        let batch = ring.resume(
            Some(LogCursor {
                generation: 7,
                seq: 1,
            }),
            10,
        );
        assert_eq!(
            batch.gap,
            Some(LogGap {
                reason: GapReason::Overwritten,
                from_seq: 2,
                to_seq: 3,
            })
        );
        let seqs: Vec<_> = batch.records.iter().map(|r| r.seq).collect();
        assert_eq!(seqs, vec![4, 5, 6]);
        assert_eq!(batch.next.seq, 6);
    }

    #[test]
    fn resume_across_full_eviction_advances_past_the_gap() {
        let mut ring = LogRing::new(7, small(usize::MAX / 2, 1, 3600));
        push(&mut ring, at(0), "a");
        push(&mut ring, at(1), "b");
        push(&mut ring, at(2), "c");
        // Newest is seq 3; the reader at seq 0 misses 1..=2 and gets 3.
        let batch = ring.resume(
            Some(LogCursor {
                generation: 7,
                seq: 0,
            }),
            10,
        );
        assert_eq!(batch.gap.map(|g| (g.from_seq, g.to_seq)), Some((1, 2)));
        assert_eq!(batch.records.len(), 1);
        assert_eq!(batch.next.seq, 3);
    }

    #[test]
    fn resume_after_restart_reports_restart_gap_and_tail() {
        let mut ring = LogRing::new(7, RingLimits::default());
        push(&mut ring, at(0), "a");
        let batch = ring.resume(
            Some(LogCursor {
                generation: 6,
                seq: 9,
            }),
            10,
        );
        assert_eq!(
            batch.gap,
            Some(LogGap {
                reason: GapReason::Restarted,
                from_seq: 0,
                to_seq: 0,
            })
        );
        assert_eq!(batch.records.len(), 1);
        assert_eq!(batch.generation, 7);
    }

    #[test]
    fn resume_with_cursor_beyond_newest_is_treated_as_restart() {
        let mut ring = LogRing::new(7, RingLimits::default());
        push(&mut ring, at(0), "a");
        let batch = ring.resume(
            Some(LogCursor {
                generation: 7,
                seq: 50,
            }),
            10,
        );
        assert_eq!(batch.gap.map(|g| g.reason), Some(GapReason::Restarted));
    }

    #[test]
    fn search_snapshot_pins_newest_and_reports_continuation_loss() {
        let mut ring = LogRing::new(7, small(usize::MAX / 2, 3, 3600));
        for n in 0..3 {
            push(&mut ring, at(n), "x");
        }
        let first = ring.search_snapshot(None);
        assert_eq!(first.pinned_seq, 3);
        assert_eq!(first.before, 4);
        assert_eq!(first.floor, 0);

        // Continuation before seq 3 with nothing evicted since the search began.
        let cursor = SearchCursor {
            generation: 7,
            pinned_seq: 3,
            before: 3,
            floor: 0,
        };
        assert_eq!(ring.search_snapshot(Some(cursor)).gap, None);

        // Eviction after the search started removes seqs below `before`.
        for n in 3..6 {
            push(&mut ring, at(n), "x");
        }
        assert_eq!(ring.evicted_through, 3);
        let stale = ring.search_snapshot(Some(cursor));
        assert_eq!(stale.gap, Some(GapReason::Overwritten));
        assert!(stale.records.is_empty());
    }

    #[test]
    fn search_snapshot_for_other_generation_reports_restart() {
        let ring = LogRing::new(7, RingLimits::default());
        let cursor = SearchCursor {
            generation: 3,
            pinned_seq: 9,
            before: 9,
            floor: 0,
        };
        assert_eq!(
            ring.search_snapshot(Some(cursor)).gap,
            Some(GapReason::Restarted)
        );
    }

    #[test]
    fn context_returns_same_source_and_process_run_only() {
        let mut ring = LogRing::new(7, RingLimits::default());
        ring.push(
            at(0),
            LogSource::Agent,
            LogLevel::Info,
            1,
            "a0".into(),
            false,
        );
        ring.push(
            at(1),
            LogSource::SingBox,
            LogLevel::Info,
            1,
            "s1".into(),
            false,
        );
        ring.push(
            at(2),
            LogSource::Agent,
            LogLevel::Info,
            1,
            "a2".into(),
            false,
        );
        ring.push(
            at(3),
            LogSource::Agent,
            LogLevel::Info,
            2,
            "a3".into(),
            false,
        );
        ring.push(
            at(4),
            LogSource::Agent,
            LogLevel::Info,
            1,
            "a4".into(),
            false,
        );
        let context = ring.context(7, 3, 5, 5).unwrap();
        assert_eq!(context.target.text, "a2");
        let before: Vec<_> = context.before.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(before, vec!["a0"]);
        let after: Vec<_> = context.after.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(after, vec!["a4"]);
    }

    #[test]
    fn context_distinguishes_overwritten_from_unknown_and_restart() {
        let mut ring = LogRing::new(7, small(usize::MAX / 2, 2, 3600));
        for n in 0..4 {
            push(&mut ring, at(n), "x");
        }
        assert_eq!(
            ring.context(7, 1, 1, 1).unwrap_err(),
            ContextError::Overwritten
        );
        assert_eq!(
            ring.context(7, 99, 1, 1).unwrap_err(),
            ContextError::NotFound
        );
        assert_eq!(
            ring.context(6, 3, 1, 1).unwrap_err(),
            ContextError::Restarted
        );
    }
}
