//! Tail, search and context behavior against the real retained buffer.

use std::time::Duration;

use chrono::{DateTime, TimeZone, Utc};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use super::{Command, Session};
use crate::logs::{LogLevel, LogSource, LogStore, RingLimits};
use crate::ws::v2::codec::{
    LogCursor, LogErrorCode, LogFilter, LogGap, LogGapReason, LogGeneration, LogQuery,
    LogSearchCursor, LogSource as WireSource, LogsBatch, LogsContext, LogsError, LogsGap,
    LogsLevel as WireLevel, LogsSearch, LogsSubscribe, MAX_FRAME_BYTES, Message, Sender,
};

fn at(seconds: i64) -> DateTime<Utc> {
    Utc.timestamp_opt(1_800_000_000 + seconds, 0).unwrap()
}

fn store(limits: RingLimits) -> LogStore {
    LogStore::new(limits)
}

fn default_store() -> LogStore {
    store(RingLimits::default())
}

async fn next(session: &mut Session) -> Message {
    let text = timeout(Duration::from_secs(2), session.recv())
        .await
        .expect("a log worker reply timed out")
        .expect("the log worker stopped");
    crate::ws::v2::codec::decode(&text, Sender::Agent, MAX_FRAME_BYTES)
        .unwrap()
        .message
}

async fn next_batch(session: &mut Session) -> LogsBatch {
    loop {
        match next(session).await {
            Message::LogsBatch(batch) => return batch,
            Message::LogsGap(_) | Message::LogsError(_) => continue,
            other => panic!("expected a tail batch, got {other:?}"),
        }
    }
}

async fn next_gap(session: &mut Session, subscription_id: &str) -> LogsGap {
    loop {
        match next(session).await {
            Message::LogsGap(gap) if gap.subscription_id == subscription_id => return gap,
            Message::LogsBatch(_) | Message::LogsGap(_) | Message::LogsError(_) => continue,
            other => panic!("expected a gap for {subscription_id}, got {other:?}"),
        }
    }
}

async fn no_reply(session: &mut Session) {
    assert!(
        timeout(Duration::from_millis(50), session.recv())
            .await
            .is_err(),
        "the agent sent an unexpected frame"
    );
}

fn subscribe(
    subscription_id: &str,
    filter: LogFilter,
    resume: Option<LogCursor>,
    limit: u64,
) -> Command {
    Command::Subscribe(LogsSubscribe {
        subscription_id: subscription_id.to_string(),
        filter,
        resume,
        limit,
    })
}

#[tokio::test]
async fn tail_starts_at_the_newest_records_and_honors_the_filter() {
    let store = default_store();
    store.record_at(at(0), LogSource::Agent, LogLevel::Info, 0, "agent ready");
    store.record_at(
        at(1),
        LogSource::SingBox,
        LogLevel::Debug,
        1,
        "sing-box debug",
    );
    store.record_at(
        at(2),
        LogSource::SingBox,
        LogLevel::Warn,
        1,
        "sing-box warn",
    );
    store.record_at(
        at(3),
        LogSource::SingBox,
        LogLevel::Error,
        1,
        "sing-box error",
    );

    let cancel = CancellationToken::new();
    let mut session = Session::start(store.clone(), cancel.clone());
    session
        .handle()
        .admit(subscribe(
            "tail-1",
            LogFilter {
                source: Some(WireSource::SingBox),
                min_level: Some(WireLevel::Warn),
            },
            None,
            10,
        ))
        .unwrap();

    let batch = next_batch(&mut session).await;
    assert_eq!(batch.subscription_id, "tail-1");
    assert_eq!(
        batch
            .records
            .iter()
            .map(|record| record.text.as_str())
            .collect::<Vec<_>>(),
        vec!["sing-box warn", "sing-box error"]
    );
    assert_eq!(batch.next.seq, 4);
    assert!(!batch.has_more);

    // A new matching record reaches the open tail on its next poll.
    store.record_at(
        at(4),
        LogSource::SingBox,
        LogLevel::Error,
        1,
        "new sing-box error",
    );
    let batch = next_batch(&mut session).await;
    assert_eq!(batch.records.len(), 1);
    assert_eq!(batch.records[0].text, "new sing-box error");
    assert_eq!(batch.next.seq, 5);

    // A non-matching record only advances the cursor; it is not delivered.
    store.record_at(at(5), LogSource::Agent, LogLevel::Info, 0, "agent notice");
    let batch = next_batch(&mut session).await;
    assert!(batch.records.is_empty());
    assert_eq!(batch.next.seq, 6);

    session.shutdown().await;
}

#[tokio::test]
async fn resume_reports_restart_and_overwritten_gaps() {
    let store = store(RingLimits {
        max_lines: 3,
        ..RingLimits::default()
    });
    for n in 0..6 {
        store.record_at(
            at(n),
            LogSource::Agent,
            LogLevel::Info,
            0,
            &format!("line {n}"),
        );
    }
    let generation = store.generation().unwrap();

    let cancel = CancellationToken::new();
    let mut session = Session::start(store.clone(), cancel.clone());

    // The generation changed, so the reader restarts at the newest records.
    session
        .handle()
        .admit(subscribe(
            "tail-restart",
            LogFilter::default(),
            Some(LogCursor {
                generation: LogGeneration::new(generation.wrapping_add(1)),
                seq: 1,
            }),
            10,
        ))
        .unwrap();
    let LogsGap { gap, .. } = next_gap(&mut session, "tail-restart").await;
    assert_eq!(gap.reason, LogGapReason::Restarted);
    assert_eq!((gap.from_seq, gap.to_seq), (0, 0));
    let batch = next_batch(&mut session).await;
    assert_eq!(
        batch
            .records
            .iter()
            .map(|record| record.seq)
            .collect::<Vec<_>>(),
        vec![4, 5, 6]
    );

    // Eviction overtook this cursor, so the missing span is named.
    session
        .handle()
        .admit(subscribe(
            "tail-old",
            LogFilter::default(),
            Some(LogCursor {
                generation: LogGeneration::new(generation),
                seq: 1,
            }),
            10,
        ))
        .unwrap();
    let LogsGap { gap, .. } = next_gap(&mut session, "tail-old").await;
    assert_eq!(
        gap,
        LogGap {
            reason: LogGapReason::Overwritten,
            from_seq: 2,
            to_seq: 3,
        }
    );
    let batch = next_batch(&mut session).await;
    assert_eq!(
        batch
            .records
            .iter()
            .map(|record| record.seq)
            .collect::<Vec<_>>(),
        vec![4, 5, 6]
    );

    session.shutdown().await;
}

#[tokio::test]
async fn searches_filter_and_page_newest_first() {
    let store = default_store();
    let lines = [
        ("dial tcp refused", LogSource::SingBox, LogLevel::Error),
        ("agent started", LogSource::Agent, LogLevel::Info),
        ("dial tcp retry", LogSource::SingBox, LogLevel::Warn),
        ("DIAL TCP refused", LogSource::SingBox, LogLevel::Error),
        ("unrelated", LogSource::SingBox, LogLevel::Error),
    ];
    for (index, (text, source, level)) in lines.iter().enumerate() {
        store.record_at(at(i64::try_from(index).unwrap()), *source, *level, 1, text);
    }

    let cancel = CancellationToken::new();
    let mut session = Session::start(store.clone(), cancel.clone());
    session
        .handle()
        .admit(Command::Search(LogsSearch {
            request_id: "search-1".to_string(),
            query: LogQuery {
                text: Some("dial tcp".to_string()),
                source: Some(WireSource::SingBox),
                min_level: Some(WireLevel::Warn),
                since: Some(at(0)),
                until: Some(at(5)),
            },
            cursor: None,
            limit: 1,
        }))
        .unwrap();

    let Message::LogsSearchResult(first) = next(&mut session).await else {
        panic!("expected a search result");
    };
    assert_eq!(first.request_id, "search-1");
    assert_eq!(first.matches[0].seq, 4);
    assert_eq!(first.matches[0].text, "DIAL TCP refused");
    assert!(first.coverage.gap.is_none());
    assert!(first.coverage.searchable_from.is_some());
    let continuation = first.next.expect("an older match remains");
    assert_eq!(continuation.before, 4);

    session
        .handle()
        .admit(Command::Search(LogsSearch {
            request_id: "search-2".to_string(),
            query: LogQuery {
                text: Some("dial tcp".to_string()),
                source: Some(WireSource::SingBox),
                min_level: Some(WireLevel::Warn),
                since: Some(at(0)),
                until: Some(at(5)),
            },
            cursor: Some(LogSearchCursor {
                generation: continuation.generation,
                pinned_seq: continuation.pinned_seq,
                before: continuation.before,
                floor: continuation.floor,
            }),
            limit: 1,
        }))
        .unwrap();
    let Message::LogsSearchResult(second) = next(&mut session).await else {
        panic!("expected a second search result");
    };
    assert_eq!(second.matches[0].seq, 3);
    assert_eq!(second.matches[0].text, "dial tcp retry");
    let continuation = second
        .next
        .expect("the scan has not reached the oldest record");
    session
        .handle()
        .admit(Command::Search(LogsSearch {
            request_id: "search-3".to_string(),
            query: LogQuery {
                text: Some("dial tcp".to_string()),
                source: Some(WireSource::SingBox),
                min_level: Some(WireLevel::Warn),
                since: Some(at(0)),
                until: Some(at(5)),
            },
            cursor: Some(LogSearchCursor {
                generation: continuation.generation,
                pinned_seq: continuation.pinned_seq,
                before: continuation.before,
                floor: continuation.floor,
            }),
            limit: 1,
        }))
        .unwrap();
    let Message::LogsSearchResult(third) = next(&mut session).await else {
        panic!("expected the final search result");
    };
    assert_eq!(third.matches[0].seq, 1);
    assert_eq!(third.matches[0].text, "dial tcp refused");
    assert!(third.next.is_none());

    // Cancelling an unknown request is harmless and produces no frame.
    session
        .handle()
        .admit(Command::CancelSearch("missing".to_string()))
        .unwrap();
    no_reply(&mut session).await;

    session.shutdown().await;
}

#[tokio::test]
async fn context_returns_same_source_neighbours_and_typed_errors() {
    let store = default_store();
    for n in 0..4 {
        store.record_at(
            at(n),
            LogSource::Agent,
            LogLevel::Info,
            1,
            &format!("agent {n}"),
        );
    }
    store.record_at(at(4), LogSource::SingBox, LogLevel::Error, 1, "sing-box");
    store.record_at(at(5), LogSource::Agent, LogLevel::Warn, 1, "agent 4");
    let generation = store.generation().unwrap();

    let cancel = CancellationToken::new();
    let mut session = Session::start(store.clone(), cancel.clone());
    session
        .handle()
        .admit(Command::Context(LogsContext {
            request_id: "ctx-1".to_string(),
            generation: LogGeneration::new(generation),
            seq: 4,
            before: 2,
            after: 1,
        }))
        .unwrap();
    let Message::LogsContextResult(result) = next(&mut session).await else {
        panic!("expected a context result");
    };
    assert_eq!(result.target.text, "agent 3");
    assert_eq!(
        result
            .before
            .iter()
            .map(|record| record.text.as_str())
            .collect::<Vec<_>>(),
        vec!["agent 1", "agent 2"]
    );
    assert_eq!(
        result
            .after
            .iter()
            .map(|record| record.text.as_str())
            .collect::<Vec<_>>(),
        vec!["agent 4"]
    );

    session
        .handle()
        .admit(Command::Context(LogsContext {
            request_id: "ctx-restarted".to_string(),
            generation: LogGeneration::new(generation.wrapping_add(1)),
            seq: 1,
            before: 0,
            after: 0,
        }))
        .unwrap();
    let Message::LogsError(LogsError {
        code, request_id, ..
    }) = next(&mut session).await
    else {
        panic!("expected a restart error");
    };
    assert_eq!(code, LogErrorCode::Restarted);
    assert_eq!(request_id.as_deref(), Some("ctx-restarted"));

    session
        .handle()
        .admit(Command::Context(LogsContext {
            request_id: "ctx-missing".to_string(),
            generation: LogGeneration::new(generation),
            seq: 99,
            before: 0,
            after: 0,
        }))
        .unwrap();
    let Message::LogsError(LogsError { code, .. }) = next(&mut session).await else {
        panic!("expected a not-found error");
    };
    assert_eq!(code, LogErrorCode::NotFound);

    session.shutdown().await;
}

#[tokio::test]
async fn a_reconnect_drops_every_subscription_and_queued_job() {
    let store = default_store();
    store.record_at(at(0), LogSource::Agent, LogLevel::Info, 0, "one");
    let cancel = CancellationToken::new();
    let mut first = Session::start(store.clone(), cancel.clone());
    first
        .handle()
        .admit(subscribe("tail-1", LogFilter::default(), None, 10))
        .unwrap();
    let _ = next_batch(&mut first).await;
    first.shutdown().await;
    assert!(first.recv().await.is_none(), "the first worker is gone");

    let second_cancel = CancellationToken::new();
    let mut second = Session::start(store, second_cancel.clone());
    no_reply(&mut second).await;
    second.shutdown().await;
}

#[tokio::test]
async fn duplicate_and_overflowing_requests_are_rejected() {
    let store = default_store();
    store.record_at(at(0), LogSource::Agent, LogLevel::Info, 0, "hit");
    let cancel = CancellationToken::new();
    let mut session = Session::start(store, cancel.clone());
    session
        .handle()
        .admit(Command::Subscribe(LogsSubscribe {
            subscription_id: "tail-1".to_string(),
            filter: LogFilter::default(),
            resume: None,
            limit: 10,
        }))
        .unwrap();
    for n in 2..=17 {
        session
            .handle()
            .admit(Command::Subscribe(LogsSubscribe {
                subscription_id: format!("tail-{n}"),
                filter: LogFilter::default(),
                resume: None,
                limit: 10,
            }))
            .unwrap();
    }
    let mut rejected = None;
    for _ in 0..32 {
        if let Message::LogsError(error) = next(&mut session).await {
            rejected = Some(error);
            break;
        }
    }
    let rejected = rejected.expect("the 17th tail must be refused");
    assert_eq!(rejected.code, LogErrorCode::Busy);
    assert!(rejected.subscription_id.is_some());

    session.shutdown().await;
}
