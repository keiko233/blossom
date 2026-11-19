//! Store-level scenarios that cross ring, search and redaction boundaries.

use chrono::{Duration, Utc};
use tokio_util::sync::CancellationToken;

use super::model::{GapReason, LogCursor, LogLevel, LogSource, RingLimits, SearchCursor};
use super::search::{LogQuery, SearchRequest};
use super::store::LogStore;
use super::text::{MAX_SECRET_FORMS, PrivateKeyBlock, SecretScope};

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
    store.replace_secrets(SecretScope::Agent, [secret]).unwrap();
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

#[test]
fn key_block_chunks_never_reach_tail_search_or_context() {
    let store = LogStore::new(RingLimits::default());
    let mut block = PrivateKeyBlock::default();
    let lines = [
        "before the key",
        "-----BEGIN EC PRIVATE KEY-----",
        "MHcCAQEEIBODYSECRET",
        "-----END EC PRIVATE KEY-----",
        "after the key",
    ];
    for line in lines {
        store.record_line(&mut block, LogSource::SingBox, LogLevel::Info, 1, line);
    }

    let tail = store.resume(None, 10).unwrap();
    let texts: Vec<_> = tail.records.iter().map(|r| r.text.as_str()).collect();
    assert_eq!(
        texts,
        vec!["before the key", "[REDACTED PRIVATE KEY]", "after the key"]
    );

    let cancel = CancellationToken::new();
    let page = store
        .search(&text_request("BODYSECRET", None, 10), &cancel)
        .unwrap();
    assert!(page.matches.is_empty());

    let generation = store.generation().unwrap();
    let context = store.context(generation, 2, 5, 5).unwrap();
    let neighbours: Vec<_> = context
        .before
        .iter()
        .chain(context.after.iter())
        .map(|r| r.text.as_str())
        .collect();
    assert_eq!(neighbours, vec!["before the key", "after the key"]);
}

#[test]
fn rotated_credentials_are_masked_in_every_egress_path() {
    let store = LogStore::new(RingLimits::default());
    store
        .replace_secrets(SecretScope::NodeCredentials, ["node-old-pass"])
        .unwrap();
    store.record(
        LogSource::SingBox,
        LogLevel::Error,
        1,
        "outbound password=node-old-pass rejected",
    );
    store
        .replace_secrets(SecretScope::NodeCredentials, ["node-new-pass"])
        .unwrap();
    store.record(
        LogSource::SingBox,
        LogLevel::Error,
        2,
        "outbound password=node-new-pass rejected",
    );

    let cancel = CancellationToken::new();
    for needle in ["node-old", "node-new"] {
        let page = store
            .search(&text_request(needle, None, 10), &cancel)
            .unwrap();
        assert!(page.matches.is_empty(), "{needle} must not be retained");
    }
    let tail = store.resume(None, 10).unwrap();
    assert!(tail.records.iter().all(|r| r.text.contains("[REDACTED]")));
    assert_eq!(
        store.redact_message("node-old-pass and node-new-pass"),
        "[REDACTED] and [REDACTED]"
    );
}

#[test]
fn oauth_secrets_and_each_issued_token_are_masked_across_refreshes() {
    let store = LogStore::new(RingLimits::default());
    store
        .replace_secrets(
            SecretScope::OAuth,
            ["ags_FAKE_client_secret_0001", "header1.payload.sig1"],
        )
        .unwrap();
    store.record(
        LogSource::Agent,
        LogLevel::Info,
        1,
        "token header1.payload.sig1 for ags_FAKE_client_secret_0001",
    );
    store
        .replace_secrets(
            SecretScope::OAuth,
            ["ags_FAKE_client_secret_0001", "header2.payload.sig2"],
        )
        .unwrap();
    store.record(
        LogSource::Agent,
        LogLevel::Info,
        1,
        "refresh header2.payload.sig2 still ags_FAKE_client_secret_0001",
    );
    store
        .replace_secrets(
            SecretScope::OAuth,
            ["ags_FAKE_client_secret_0002", "header3.payload.sig3"],
        )
        .unwrap();
    store.record(
        LogSource::Agent,
        LogLevel::Info,
        1,
        "rotated header3.payload.sig3 and ags_FAKE_client_secret_0002",
    );

    let cancel = CancellationToken::new();
    for needle in [
        "header1.payload",
        "header2.payload",
        "header3.payload",
        "ags_FAKE_client_secret_0001",
        "ags_FAKE_client_secret_0002",
    ] {
        let page = store
            .search(&text_request(needle, None, 10), &cancel)
            .unwrap();
        assert!(page.matches.is_empty(), "{needle} must not be retained");
    }
    let tail = store.resume(None, 10).unwrap();
    assert_eq!(tail.records.len(), 3);
    assert!(
        tail.records
            .iter()
            .all(|record| record.text.contains("[REDACTED]"))
    );
}

#[test]
fn registry_overflow_masks_new_records_across_every_egress_path() {
    let store = LogStore::new(RingLimits::default());
    let many: Vec<String> = (0..=MAX_SECRET_FORMS)
        .map(|n| format!("overflow-credential-{n:05}"))
        .collect();
    assert!(
        store
            .replace_secrets(SecretScope::NodeCredentials, &many)
            .is_err()
    );
    store.record(
        LogSource::SingBox,
        LogLevel::Error,
        1,
        "looks like a credential but the registry overflowed",
    );

    let tail = store.resume(None, 10).unwrap();
    assert_eq!(tail.records[0].text, "[REDACTED]");

    let cancel = CancellationToken::new();
    let page = store
        .search(&text_request("overflow", None, 10), &cancel)
        .unwrap();
    assert!(page.matches.is_empty());

    let generation = store.generation().unwrap();
    let context = store.context(generation, 1, 5, 5).unwrap();
    assert_eq!(context.target.text, "[REDACTED]");
    assert!(context.before.is_empty());
    assert!(context.after.is_empty());
}
