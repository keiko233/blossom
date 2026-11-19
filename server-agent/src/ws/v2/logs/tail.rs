//! One live tail subscription: replay from a cursor, coalesce new records, and
//! report a restart or eviction gap instead of skipping it.

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{
    TAIL_POLL, batch_limit, cursor, emit_batch, emit_error, emit_gap, filter, gap, matches, record,
};
use crate::logs::{LogCursor, LogStore};
use crate::ws::v2::codec::{LogErrorCode, LogsBatch, LogsSubscribe};

pub(super) async fn run(
    store: LogStore,
    replies: mpsc::Sender<String>,
    cancel: CancellationToken,
    request: LogsSubscribe,
) {
    let (source, min_level) = filter(&request.filter);
    let limit = batch_limit(request.limit);
    let mut after = request.resume.map(|cursor| LogCursor {
        generation: cursor.generation.get(),
        seq: cursor.seq,
    });

    loop {
        let resume = match store.resume(after, limit) {
            Ok(resume) => resume,
            Err(_) => {
                emit_error(
                    &replies,
                    &cancel,
                    LogErrorCode::Unavailable,
                    Some(&request.subscription_id),
                    None,
                    "the retained log buffer is unavailable",
                )
                .await;
                return;
            }
        };
        let generation = resume.generation;
        let next = resume.next;
        let has_more = resume.has_more;
        let reported_gap = resume.gap;
        let advanced = match after {
            None => true,
            Some(previous) => previous.generation != next.generation || previous.seq != next.seq,
        };
        let records: Vec<_> = resume
            .records
            .iter()
            .filter(|record| matches(record, source, min_level))
            .map(|record| record.as_ref())
            .map(record)
            .collect();

        if let Some(reported_gap) = reported_gap
            && !emit_gap(
                &replies,
                &cancel,
                &request.subscription_id,
                generation,
                gap(reported_gap),
            )
            .await
        {
            return;
        }
        if advanced || has_more || !records.is_empty() {
            let batch = LogsBatch {
                subscription_id: request.subscription_id.clone(),
                next: cursor(next),
                has_more,
                records,
            };
            if !emit_batch(&replies, &cancel, batch).await {
                return;
            }
        }
        after = Some(next);

        if has_more {
            continue;
        }
        // An idle tail checks for new records at a fixed, cheap cadence. The
        // sleep is cancelled with the connection, so a reconnect leaves no
        // subscription behind.
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(TAIL_POLL) => {}
        }
    }
}
