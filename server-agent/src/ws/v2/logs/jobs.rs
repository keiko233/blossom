//! Retained search and context lookup.
//!
//! Both run on `spawn_blocking` with a deadline and a cancellation token, so a
//! scan never occupies the v2 socket loop. The store copies a bounded window
//! under its lock and then releases it before matching.

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{JOB_DEADLINE, context_limit, emit, emit_error, record, search_cursor};
use crate::logs::{
    ContextError, GapReason, LogLevel, LogQuery, LogSource, LogStore, SearchError, SearchPage,
    SearchRequest,
};
use crate::ws::v2::codec::{
    self, LogCoverage, LogErrorCode, LogsContext, LogsContextResult, LogsSearch, LogsSearchResult,
};

pub(super) async fn search(
    store: LogStore,
    replies: mpsc::Sender<String>,
    cancel: CancellationToken,
    request: LogsSearch,
) {
    let job_cancel = cancel.child_token();
    let search = SearchRequest {
        query: query(&request.query),
        cursor: request.cursor.map(|cursor| crate::logs::SearchCursor {
            generation: cursor.generation.get(),
            pinned_seq: cursor.pinned_seq,
            before: cursor.before,
            floor: cursor.floor,
        }),
        limit: usize::try_from(request.limit)
            .unwrap_or(codec::LOGS_SEARCH_PAGE_MAX)
            .min(codec::LOGS_SEARCH_PAGE_MAX),
    };
    let scan_store = store.clone();
    let scan_cancel = job_cancel.clone();
    let scanned = tokio::time::timeout(
        JOB_DEADLINE,
        tokio::task::spawn_blocking(move || scan_store.search(&search, &scan_cancel)),
    )
    .await;

    let page = match scanned {
        Err(_) => {
            job_cancel.cancel();
            emit_error(
                &replies,
                &cancel,
                LogErrorCode::Unavailable,
                None,
                Some(&request.request_id),
                "the log search exceeded its deadline",
            )
            .await;
            return;
        }
        Ok(Err(error)) => {
            emit_error(
                &replies,
                &cancel,
                LogErrorCode::Unavailable,
                None,
                Some(&request.request_id),
                &format!("the log search task failed: {error}"),
            )
            .await;
            return;
        }
        Ok(Ok(Err(SearchError::Cancelled))) => return,
        Ok(Ok(Err(error))) => {
            let (code, message) = match error {
                SearchError::Query(error) => (LogErrorCode::InvalidRequest, error.to_string()),
                SearchError::Busy => (
                    LogErrorCode::Busy,
                    "too many concurrent log searches".to_string(),
                ),
                SearchError::Unavailable => (
                    LogErrorCode::Unavailable,
                    "the retained log buffer is unavailable".to_string(),
                ),
                SearchError::Cancelled => return,
            };
            emit_error(
                &replies,
                &cancel,
                code,
                None,
                Some(&request.request_id),
                &message,
            )
            .await;
            return;
        }
        Ok(Ok(Ok(page))) => page,
    };

    // A cancel that arrived while the scan ran suppresses the late reply.
    if job_cancel.is_cancelled() {
        return;
    }
    let payload = result(&request.request_id, page);
    let _ = emit(&replies, "logs.search.result", &payload, &cancel).await;
}

pub(super) async fn context(
    store: LogStore,
    replies: mpsc::Sender<String>,
    cancel: CancellationToken,
    request: LogsContext,
) {
    let generation = request.generation.get();
    let seq = request.seq;
    let before = context_limit(request.before);
    let after = context_limit(request.after);
    let found = tokio::time::timeout(
        JOB_DEADLINE,
        tokio::task::spawn_blocking(move || store.context(generation, seq, before, after)),
    )
    .await;

    match found {
        Err(_) => {
            emit_error(
                &replies,
                &cancel,
                LogErrorCode::Unavailable,
                None,
                Some(&request.request_id),
                "the log context lookup exceeded its deadline",
            )
            .await;
        }
        Ok(Err(error)) => {
            emit_error(
                &replies,
                &cancel,
                LogErrorCode::Unavailable,
                None,
                Some(&request.request_id),
                &format!("the log context task failed: {error}"),
            )
            .await;
        }
        Ok(Ok(Err(error))) => {
            let (code, message) = match error {
                ContextError::Restarted => (LogErrorCode::Restarted, "the log buffer restarted"),
                ContextError::Overwritten => (LogErrorCode::Overwritten, "the record was evicted"),
                ContextError::NotFound => (LogErrorCode::NotFound, "the record was not found"),
                ContextError::Unavailable => (
                    LogErrorCode::Unavailable,
                    "the retained log buffer is unavailable",
                ),
            };
            emit_error(
                &replies,
                &cancel,
                code,
                None,
                Some(&request.request_id),
                message,
            )
            .await;
        }
        Ok(Ok(Ok(found))) => {
            let payload = LogsContextResult {
                request_id: request.request_id,
                generation: codec::LogGeneration::new(generation),
                target: record(found.target.as_ref()),
                before: found
                    .before
                    .iter()
                    .map(|record| super::record(record.as_ref()))
                    .collect(),
                after: found
                    .after
                    .iter()
                    .map(|record| super::record(record.as_ref()))
                    .collect(),
            };
            let _ = emit(&replies, "logs.context.result", &payload, &cancel).await;
        }
    }
}

fn query(query: &codec::LogQuery) -> LogQuery {
    LogQuery {
        text: query.text.clone(),
        source: query.source.map(source),
        min_level: query.min_level.map(level),
        since: query.since,
        until: query.until,
    }
}

fn source(source: codec::LogSource) -> LogSource {
    match source {
        codec::LogSource::Agent => LogSource::Agent,
        codec::LogSource::SingBox => LogSource::SingBox,
    }
}

fn level(level: codec::LogLevel) -> LogLevel {
    match level {
        codec::LogLevel::Trace => LogLevel::Trace,
        codec::LogLevel::Debug => LogLevel::Debug,
        codec::LogLevel::Info => LogLevel::Info,
        codec::LogLevel::Warn => LogLevel::Warn,
        codec::LogLevel::Error => LogLevel::Error,
    }
}

fn result(request_id: &str, page: SearchPage) -> LogsSearchResult {
    LogsSearchResult {
        request_id: request_id.to_string(),
        generation: codec::LogGeneration::new(page.generation),
        pinned_seq: page.pinned_seq,
        matches: page
            .matches
            .iter()
            .map(|record| super::record(record.as_ref()))
            .collect(),
        next: page.next.map(search_cursor),
        coverage: LogCoverage {
            gap: page.coverage.gap.map(gap_reason),
            searchable_from: page.coverage.searchable_from,
            searchable_to: page.coverage.searchable_to,
        },
    }
}

fn gap_reason(reason: GapReason) -> codec::LogGapReason {
    match reason {
        GapReason::Restarted => codec::LogGapReason::Restarted,
        GapReason::Overwritten => codec::LogGapReason::Overwritten,
    }
}
