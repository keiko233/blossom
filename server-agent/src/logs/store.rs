//! Shared handle to the retained log buffer.
//!
//! Writers take the lock only to push one already-sanitized record. Readers
//! take it only to copy a bounded window. Matching, formatting and redaction
//! never run under the lock, so a slow reader cannot stall process output.

use std::fmt;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use tokio_util::sync::CancellationToken;

use super::model::{
    CONTEXT_MAX_LINES, LogCursor, LogLevel, LogSource, RingLimits, SEARCH_MAX_CONCURRENT,
};
use super::ring::{ContextError, LogContext, LogResume, LogRing};
use super::search::{SearchError, SearchPage, SearchRequest, scan_page};
use super::text::{
    PrivateKeyBlock, SecretRedactor, SecretRegistryFull, SecretScope, redact_message, sanitize_line,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StoreError {
    /// The buffer lock is poisoned, so the store cannot be read or written.
    Unavailable,
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("log buffer is unavailable")
    }
}

impl std::error::Error for StoreError {}

struct Inner {
    ring: Mutex<LogRing>,
    redactor: SecretRedactor,
    process_generation: AtomicU64,
    searches_in_flight: AtomicUsize,
}

/// The process-wide buffer. The tracing layer and the sing-box supervisor
/// write to it, and the WebSocket log binding reads from it.
static SHARED: OnceLock<LogStore> = OnceLock::new();

#[derive(Clone)]
pub(crate) struct LogStore {
    inner: Arc<Inner>,
}

impl Default for LogStore {
    fn default() -> Self {
        Self::new(RingLimits::default())
    }
}

impl LogStore {
    pub(crate) fn shared() -> Self {
        SHARED.get_or_init(Self::default).clone()
    }

    pub(crate) fn new(limits: RingLimits) -> Self {
        Self {
            inner: Arc::new(Inner {
                ring: Mutex::new(LogRing::new(new_buffer_generation(), limits)),
                redactor: SecretRedactor::default(),
                process_generation: AtomicU64::new(0),
                searches_in_flight: AtomicUsize::new(0),
            }),
        }
    }

    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "asserted by the log store tests")
    )]
    pub(crate) fn generation(&self) -> Result<u64, StoreError> {
        Ok(self.lock()?.generation())
    }

    /// Makes `secrets` the complete set for `scope`. Call it before a credential
    /// is first sent, logged or written, and again whenever the set changes.
    /// If the registry bound would be exceeded it changes no registered set,
    /// fails, and makes capture redact every later line whole.
    pub(crate) fn replace_secrets<I>(
        &self,
        scope: SecretScope,
        secrets: I,
    ) -> Result<(), SecretRegistryFull>
    where
        I: IntoIterator,
        I::Item: AsRef<str>,
    {
        self.inner.redactor.replace(scope, secrets)
    }

    /// Starts a new sing-box process run and returns its generation number.
    pub(crate) fn begin_process_generation(&self) -> u64 {
        self.inner
            .process_generation
            .fetch_add(1, Ordering::Relaxed)
            + 1
    }

    pub(crate) fn current_process_generation(&self) -> u64 {
        self.inner.process_generation.load(Ordering::Relaxed)
    }

    /// Sanitizes one line from an ordered `source` and appends it. `block`
    /// must be the state of that source, so private-key bodies are dropped
    /// across lines. Returns the stored text, or `None` when the line was
    /// dropped. A poisoned lock drops the record: capture must never panic a
    /// process reader.
    pub(crate) fn record_line(
        &self,
        block: &mut PrivateKeyBlock,
        source: LogSource,
        level: LogLevel,
        process_generation: u64,
        raw: &str,
    ) -> Option<String> {
        self.record_line_at(Utc::now(), block, source, level, process_generation, raw)
    }

    fn record_line_at(
        &self,
        now: DateTime<Utc>,
        block: &mut PrivateKeyBlock,
        source: LogSource,
        level: LogLevel,
        process_generation: u64,
        raw: &str,
    ) -> Option<String> {
        let (text, truncated) = sanitize_line(raw, &self.inner.redactor, block)?;
        if let Ok(mut ring) = self.inner.ring.lock() {
            ring.push(
                now,
                source,
                level,
                process_generation,
                text.clone(),
                truncated,
            );
        }
        Some(text)
    }

    /// Redacts a multi-line message that is reported rather than logged. See
    /// [`redact_message`].
    pub(crate) fn redact_message(&self, text: &str) -> String {
        redact_message(text, &self.inner.redactor)
    }

    /// Appends one self-contained record with its own block state.
    #[cfg(test)]
    pub(crate) fn record(
        &self,
        source: LogSource,
        level: LogLevel,
        process_generation: u64,
        raw: &str,
    ) {
        self.record_at(Utc::now(), source, level, process_generation, raw);
    }

    #[cfg(test)]
    pub(crate) fn record_at(
        &self,
        now: DateTime<Utc>,
        source: LogSource,
        level: LogLevel,
        process_generation: u64,
        raw: &str,
    ) {
        self.record_line_at(
            now,
            &mut PrivateKeyBlock::default(),
            source,
            level,
            process_generation,
            raw,
        );
    }

    /// Replays after `after`, or returns the newest `limit` records when it is
    /// `None`. See [`LogRing::resume`] for the replay contract.
    pub(crate) fn resume(
        &self,
        after: Option<LogCursor>,
        limit: usize,
    ) -> Result<LogResume, StoreError> {
        let mut ring = self.lock()?;
        ring.evict(Utc::now());
        Ok(ring.resume(after, limit))
    }

    pub(crate) fn search(
        &self,
        request: &SearchRequest,
        cancel: &CancellationToken,
    ) -> Result<SearchPage, SearchError> {
        let _permit = self.acquire_search()?;
        let snapshot = {
            let mut ring = self.lock().map_err(|_| SearchError::Unavailable)?;
            ring.evict(Utc::now());
            ring.search_snapshot(request.cursor)
        };
        scan_page(snapshot, request, cancel)
    }

    /// Returns one record with up to `before` and `after` neighbours from the
    /// same source and process run. Both counts are capped.
    pub(crate) fn context(
        &self,
        generation: u64,
        seq: u64,
        before: usize,
        after: usize,
    ) -> Result<LogContext, ContextError> {
        let ring = self.lock().map_err(|_| ContextError::Unavailable)?;
        ring.context(
            generation,
            seq,
            before.min(CONTEXT_MAX_LINES),
            after.min(CONTEXT_MAX_LINES),
        )
    }

    fn lock(&self) -> Result<MutexGuard<'_, LogRing>, StoreError> {
        self.inner.ring.lock().map_err(|_| StoreError::Unavailable)
    }

    fn acquire_search(&self) -> Result<SearchPermit, SearchError> {
        let counter = &self.inner.searches_in_flight;
        let mut current = counter.load(Ordering::Acquire);
        loop {
            if current >= SEARCH_MAX_CONCURRENT {
                return Err(SearchError::Busy);
            }
            match counter.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    return Ok(SearchPermit {
                        inner: Arc::clone(&self.inner),
                    });
                }
                Err(actual) => current = actual,
            }
        }
    }
}

/// Releases a concurrent-search slot when dropped.
struct SearchPermit {
    inner: Arc<Inner>,
}

impl Drop for SearchPermit {
    fn drop(&mut self) {
        self.inner.searches_in_flight.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Random per-buffer generation. A restarted agent gets a new one, so a
/// reader's cursor from before the restart can be detected.
fn new_buffer_generation() -> u64 {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_ok() {
        return u64::from_le_bytes(bytes);
    }
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(1, |elapsed| u64::try_from(elapsed.as_nanos()).unwrap_or(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::search::{LogQuery, QueryError};

    fn store() -> LogStore {
        LogStore::new(RingLimits::default())
    }

    #[test]
    fn recorded_text_is_redacted_before_it_is_stored() {
        let store = store();
        store
            .replace_secrets(SecretScope::Agent, ["agt_secret_value"])
            .unwrap();
        store.record(
            LogSource::Agent,
            LogLevel::Info,
            0,
            "auth agt_secret_value\x1b[0m ok",
        );
        let page = store.resume(None, 10).unwrap();
        assert_eq!(page.records[0].text, "auth [REDACTED] ok");
    }

    #[test]
    fn search_rejects_invalid_queries_before_locking() {
        let store = store();
        let request = SearchRequest {
            query: LogQuery::default(),
            cursor: None,
            limit: 0,
        };
        let cancel = CancellationToken::new();
        assert_eq!(
            store.search(&request, &cancel).unwrap_err(),
            SearchError::Query(QueryError::LimitOutOfRange)
        );
    }

    #[test]
    fn concurrent_searches_are_capped_and_permits_release() {
        let store = store();
        let permits: Vec<_> = (0..SEARCH_MAX_CONCURRENT)
            .map(|_| store.acquire_search().unwrap())
            .collect();
        assert_eq!(store.acquire_search().err(), Some(SearchError::Busy));
        drop(permits);
        assert!(store.acquire_search().is_ok());
    }

    #[test]
    fn context_returns_neighbours_from_the_store() {
        let store = store();
        for n in 0..3 {
            store.record(LogSource::Agent, LogLevel::Info, 0, &format!("line {n}"));
        }
        let generation = store.generation().unwrap();
        let context = store.context(generation, 2, 10_000, 10_000).unwrap();
        assert_eq!(context.before.len(), 1);
        assert_eq!(context.after.len(), 1);
    }

    #[test]
    fn process_generations_increase_monotonically() {
        let store = store();
        assert_eq!(store.begin_process_generation(), 1);
        assert_eq!(store.begin_process_generation(), 2);
        assert_eq!(store.current_process_generation(), 2);
    }
}
