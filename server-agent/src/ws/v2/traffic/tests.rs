//! The v2 traffic sink against a fake session, and the durable replay of a
//! report whose acknowledgement was lost.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use tokio::sync::{mpsc, watch};

use super::SessionSink;
use crate::traffic::{Batch, BatchEntry, ReportSink, SendOutcome, TrafficReporter};
use crate::ws::v2::session::{TrafficOutcome, TrafficRequest};

fn batch(report_id: &str) -> Batch {
    Batch {
        version: 1,
        report_id: report_id.to_string(),
        // Recent, so the outbox does not expire the batch as too old to replay.
        window_started_at: Utc::now() - chrono::Duration::seconds(60),
        window_ended_at: Utc::now(),
        entries: vec![BatchEntry {
            subscription_id: "sub-1".to_string(),
            uplink_bytes: 1024,
            downlink_bytes: 4096,
        }],
    }
}

fn sink(
    online: bool,
) -> (
    SessionSink,
    mpsc::Receiver<TrafficRequest>,
    watch::Sender<bool>,
) {
    let (requests, receiver) = mpsc::channel(1);
    let (online_tx, online_rx) = watch::channel(online);
    (SessionSink::new(requests, online_rx), receiver, online_tx)
}

fn unique_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "blossom-v2-traffic-{label}-{}-{}",
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn pending_files(root: &Path) -> Vec<String> {
    fs::read_dir(root.join("pending"))
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test(start_paused = true)]
async fn an_offline_session_retries_without_queueing_a_request() {
    let (sink, mut requests, _online) = sink(false);
    let outcome = sink.send(&batch("report-offline-1")).await;
    assert!(matches!(outcome, SendOutcome::Retry(_)), "{outcome:?}");
    assert!(requests.try_recv().is_err());
}

#[tokio::test(start_paused = true)]
async fn an_applied_or_duplicate_acknowledgement_is_delivered() {
    let (sink, mut requests, _online) = sink(true);
    let session = tokio::spawn(async move {
        let request = requests.recv().await.unwrap();
        assert_eq!(request.report.report_id, "report-applied-1");
        assert_eq!(request.report.entries[0].uplink_bytes, 1024);
        request.reply.send(TrafficOutcome::Accepted).unwrap();
    });
    let outcome = sink.send(&batch("report-applied-1")).await;
    session.await.unwrap();
    assert!(matches!(
        outcome,
        SendOutcome::Delivered {
            acknowledged_id: true
        }
    ));
}

#[tokio::test(start_paused = true)]
async fn a_conflicting_report_is_rejected_not_retried() {
    let (sink, mut requests, _online) = sink(true);
    let session = tokio::spawn(async move {
        let request = requests.recv().await.unwrap();
        request
            .reply
            .send(TrafficOutcome::Conflict("different content".to_string()))
            .unwrap();
    });
    let outcome = sink.send(&batch("report-conflict-1")).await;
    session.await.unwrap();
    assert!(matches!(outcome, SendOutcome::Rejected(ref reason) if reason == "different content"));
}

#[tokio::test(start_paused = true)]
async fn a_session_that_ends_before_the_ack_leaves_the_report_for_a_retry() {
    let (sink, mut requests, _online) = sink(true);
    let session = tokio::spawn(async move {
        let request = requests.recv().await.unwrap();
        drop(request.reply);
    });
    let outcome = sink.send(&batch("report-lost-1")).await;
    session.await.unwrap();
    assert!(matches!(outcome, SendOutcome::Retry(_)), "{outcome:?}");
}

#[tokio::test(start_paused = true)]
async fn a_missing_acknowledgement_is_retried_at_the_deadline() {
    let (sink, mut requests, _online) = sink(true);
    let silent_session = tokio::spawn(async move {
        let request = requests.recv().await.unwrap();
        // Keep the reply open, so only the deadline can end the wait.
        std::future::pending::<()>().await;
        drop(request);
    });
    let outcome = sink.send(&batch("report-silent-1")).await;
    silent_session.abort();
    assert!(matches!(outcome, SendOutcome::Retry(ref reason) if reason.contains("deadline")));
}

#[tokio::test(start_paused = true)]
async fn a_report_the_wire_would_refuse_is_rejected_locally() {
    let (sink, mut requests, _online) = sink(true);
    let outcome = sink.send(&batch("bad id")).await;
    assert!(matches!(outcome, SendOutcome::Rejected(_)), "{outcome:?}");
    assert!(requests.try_recv().is_err(), "nothing was sent");
}

#[tokio::test]
async fn a_report_lost_with_its_session_is_resent_under_the_same_id_and_counted_once() {
    let root = unique_dir("replay");
    fs::create_dir_all(root.join("pending")).unwrap();
    let sealed = batch("report-replay-0001");
    fs::write(
        root.join("pending").join("report-replay-0001.json"),
        serde_json::to_vec(&sealed).unwrap(),
    )
    .unwrap();

    let (sink, mut requests, _online) = sink(true);
    // The first session drops before its acknowledgement, and the second one
    // acknowledges the replay as a duplicate of the ledger's earlier write.
    let session = tokio::spawn(async move {
        let first = requests.recv().await.unwrap();
        let first_entries = first.report.entries.clone();
        let first_id = first.report.report_id.clone();
        drop(first.reply);

        let second = requests.recv().await.unwrap();
        assert_eq!(second.report.report_id, first_id);
        assert_eq!(second.report.entries, first_entries);
        second.reply.send(TrafficOutcome::Accepted).unwrap();
    });

    let mut reporter = TrafficReporter::new("127.0.0.1:9".to_string(), None, root.clone()).unwrap();
    reporter.collect_and_flush(&sink).await;
    assert_eq!(
        pending_files(&root),
        vec!["report-replay-0001.json".to_string()]
    );
    reporter.collect_and_flush(&sink).await;
    session.await.unwrap();
    assert!(
        pending_files(&root).is_empty(),
        "the acknowledged report is forgotten"
    );

    fs::remove_dir_all(&root).unwrap();
}
