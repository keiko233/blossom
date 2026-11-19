//! Store-level scenarios that cross ring, search and redaction boundaries.

use chrono::{Duration, Utc};
use tokio_util::sync::CancellationToken;

use super::model::{GapReason, LogCursor, LogLevel, LogSource, RingLimits, SearchCursor};
use super::search::{LogQuery, SearchRequest};
use super::store::LogStore;

fn text_request(text: &str, cursor: Option<SearchCursor>, limit: usize) -> SearchRequest {
    SearchRequest {
        query: LogQuery {
            text: Some(text.to_owned()),
            ..LogQuery::default()
        },
        cursor,
        limit,
    }
}

#[test]
fn time_budget_expires_old_records_from_resume_and_search() {
    let store = LogStore::new(RingLimits {
        max_age: Duration::minutes(10),
        ..RingLimits::default()
    });
    // Queries evict against the real clock, so the fixtures are placed relative to it.
    let now = Utc::now();
    store.record_at(
        now - Duration::hours(1),
        LogSource::Agent,
        LogLevel::Info,
        0,
        "ancient marker",
    );
    store.record_at(
        now - Duration::minutes(1),
        LogSource::Agent,
        LogLevel::Info,
        0,
        "recent marker",
    );

    let cancel = CancellationToken::new();
    let page = store
        .search(&text_request("marker", None, 10), &cancel)
        .unwrap();
    let texts: Vec<_> = page.matches.iter().map(|r| r.text.as_str()).collect();
    assert_eq!(texts, vec!["recent marker"]);
    assert_eq!(
        page.coverage.searchable_from,
        Some(now - Duration::minutes(1))
    );

    let tail = store.resume(None, 10).unwrap();
    assert_eq!(tail.records.len(), 1);
}

#[test]
fn search_reaches_records_beyond_the_live_tail() {
    let store = LogStore::new(RingLimits::default());
    store.record(LogSource::Agent, LogLevel::Info, 0, "needle at the start");
    for n in 0..1000 {
        store.record(LogSource::Agent, LogLevel::Info, 0, &format!("filler {n}"));
    }
    let tail = store.resume(None, 200).unwrap();
    assert_eq!(tail.records.len(), 200);
    assert!(tail.records.iter().all(|r| !r.text.contains("needle")));

    let cancel = CancellationToken::new();
    let page = store
        .search(&text_request("NEEDLE", None, 10), &cancel)
        .unwrap();
    assert_eq!(page.matches.len(), 1);
    assert_eq!(page.matches[0].text, "needle at the start");
}

#[test]
fn redacted_secret_in_any_form_is_not_searchable() {
    let store = LogStore::new(RingLimits::default());
    let secret = "agt_hunter2 with+space/";
    store.register_secret(secret);
    store.record(
        LogSource::SingBox,
        LogLevel::Error,
        1,
        &format!("raw {secret}"),
    );
    store.record(
        LogSource::SingBox,
        LogLevel::Error,
        1,
        "url ?token=agt_hunter2%20with%2Bspace%2F",
    );
    store.record(
        LogSource::SingBox,
        LogLevel::Error,
        1,
        r#"json {"token":"agt_hunter2 with+space/"}"#,
    );
    store.record(
        LogSource::SingBox,
        LogLevel::Error,
        1,
        "header Authorization: Bearer abc.def-123",
    );

    let cancel = CancellationToken::new();
    for needle in ["hunter2", "abc.def"] {
        let page = store
            .search(&text_request(needle, None, 10), &cancel)
            .unwrap();
        assert!(page.matches.is_empty(), "{needle} must not be retained");
    }
    let page = store
        .search(&text_request("REDACTED", None, 10), &cancel)
        .unwrap();
    assert_eq!(page.matches.len(), 4);
}

#[test]
fn cursor_from_another_buffer_generation_reports_restart() {
    let first = LogStore::new(RingLimits::default());
    first.record(LogSource::Agent, LogLevel::Info, 0, "before restart");
    let old_generation = first.generation().unwrap();

    let restarted = LogStore::new(RingLimits::default());
    restarted.record(LogSource::Agent, LogLevel::Info, 0, "after restart");
    let stale = LogCursor {
        generation: old_generation,
        seq: 1,
    };
    let batch = restarted.resume(Some(stale), 10).unwrap();
    assert_eq!(batch.gap.map(|gap| gap.reason), Some(GapReason::Restarted));
    assert_eq!(batch.records.len(), 1);
    assert_eq!(batch.records[0].text, "after restart");
}

#[test]
fn byte_budget_eviction_is_reported_to_a_slow_tail_reader() {
    let store = LogStore::new(RingLimits {
        max_bytes: 4 * 1024,
        ..RingLimits::default()
    });
    let generation = store.generation().unwrap();
    store.record(LogSource::Agent, LogLevel::Info, 0, "first");
    let reader = LogCursor { generation, seq: 1 };
    for _ in 0..40 {
        store.record(LogSource::Agent, LogLevel::Info, 0, &"x".repeat(200));
    }
    let batch = store.resume(Some(reader), 500).unwrap();
    let gap = batch.gap.expect("evicted span must be reported");
    assert_eq!(gap.reason, GapReason::Overwritten);
    assert_eq!(gap.from_seq, 2);
    assert_eq!(batch.records.last().map(|r| r.seq), Some(41));
}

#[test]
fn search_cursor_pages_across_eviction_without_silent_loss() {
    let store = LogStore::new(RingLimits {
        max_lines: 6,
        ..RingLimits::default()
    });
    for n in 0..6 {
        store.record(LogSource::Agent, LogLevel::Info, 0, &format!("hit {n}"));
    }
    let cancel = CancellationToken::new();
    let first = store
        .search(&text_request("hit", None, 2), &cancel)
        .unwrap();
    assert_eq!(first.matches.len(), 2);
    let cursor = first.next.expect("older records remain");
    for n in 6..12 {
        store.record(LogSource::Agent, LogLevel::Info, 0, &format!("hit {n}"));
    }
    let continued = store
        .search(&text_request("hit", Some(cursor), 2), &cancel)
        .unwrap();
    assert_eq!(continued.coverage.gap, Some(GapReason::Overwritten));
    assert!(continued.matches.is_empty());
    assert_eq!(continued.next, None);
}
