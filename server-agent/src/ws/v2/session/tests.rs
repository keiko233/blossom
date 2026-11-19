//! Session behaviour against a scripted peer and a fake core. Deadlines run on
//! paused time, so they are exact and the tests never sleep.

use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::{
    ApplyOutcome, ApplyResult, Command, CorePorts, CoreStatus, HelloIdentity, SessionEnd,
    SessionTiming, TrafficOutcome, TrafficPorts, TrafficRequest, Wire, channels, run,
};
use crate::ws::codec::{AgentWsFrame, UpdateStatePayload, UpdateStatusPayload, frame_type};
use crate::ws::ports::{WsCommand, WsError};
use crate::ws::v2::codec::{
    AckStage, ConfigIdentifier, ConfigState, LogLevel, LogPolicyAck, LogPolicyDesired,
    LogPolicySource, RuntimeState, TrafficEntry, TrafficReport, UpdatePolicy,
};

const D7: &str = "7:sha256:48a9e1aa59f365863b57348ccd1701026c39652cfb74b8e2b039811611802ec6";
const D8: &str = "8:sha256:2e8ae9a0be2819b1d63bef33ca897ea498557c1677a201bb59fb80fc01104422";
const D9: &str = "9:sha256:1111111111111111111111111111111111111111111111111111111111111111";

/// A text transport that reads from the peer script and records what the
/// agent sends. Closing the peer script ends the connection.
struct ScriptedWire {
    inbound: mpsc::UnboundedReceiver<Result<String, WsError>>,
    outbound: mpsc::UnboundedSender<String>,
    refresh_deadline: Option<tokio::time::Instant>,
}

impl Wire for ScriptedWire {
    async fn recv_text(&mut self) -> Result<String, WsError> {
        match self.inbound.recv().await {
            Some(item) => item,
            None => Err(WsError::Closed),
        }
    }

    async fn send_text(&mut self, text: String) -> Result<(), WsError> {
        self.outbound.send(text).map_err(|_| WsError::Closed)
    }

    async fn ping(&mut self) -> Result<(), WsError> {
        Ok(())
    }

    async fn close(&mut self) {}

    fn refresh_deadline(&self) -> Option<tokio::time::Instant> {
        self.refresh_deadline
    }
}

struct Harness {
    peer: mpsc::UnboundedSender<Result<String, WsError>>,
    sent: mpsc::UnboundedReceiver<String>,
    core: CorePorts,
    traffic: TrafficPorts,
    cancel: CancellationToken,
    task: JoinHandle<SessionEnd>,
}

fn status_with(applied: Option<&str>) -> CoreStatus {
    CoreStatus {
        applied: applied.and_then(ConfigIdentifier::from_revision),
        runtime_state: RuntimeState::Running,
        config_state: ConfigState::Applied,
        sing_box_version: Some("1.14.0".to_string()),
        active_node_ids: vec!["node-1".to_string()],
        error: None,
        deployments: Vec::new(),
        updates: UpdateStatusPayload {
            agent: Some(UpdateStatePayload {
                target_version: None,
                state: "up_to_date".to_string(),
                message: None,
                checked_at: None,
            }),
            sing_box: None,
        },
    }
}

fn identity() -> HelloIdentity {
    HelloIdentity {
        agent_version: "1.3.0".to_string(),
        agent_build_id: "test-build".to_string(),
        capabilities: vec!["config-v3".to_string(), "ws-v2".to_string()],
    }
}

fn start(applied: Option<&str>) -> Harness {
    start_with_token_deadline(applied, None)
}

fn start_with_token_deadline(
    applied: Option<&str>,
    refresh_deadline: Option<tokio::time::Instant>,
) -> Harness {
    let (mut session_ports, core, traffic) = channels(
        status_with(applied),
        UpdatePolicy {
            desired_agent_version: None,
            desired_sing_box_version: None,
        },
        Vec::new(),
    );
    let (peer, inbound) = mpsc::unbounded_channel();
    let (outbound, sent) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();
    let task = tokio::spawn(async move {
        let mut wire = ScriptedWire {
            inbound,
            outbound,
            refresh_deadline,
        };
        run(
            &mut wire,
            &mut session_ports,
            &identity(),
            &SessionTiming::default(),
            &task_cancel,
        )
        .await
    });
    Harness {
        peer,
        sent,
        core,
        traffic,
        cancel,
        task,
    }
}

fn peer_frame(kind: &str, payload: Value) -> String {
    json!({"v": 2, "type": kind, "ts": "2026-11-19T00:00:00.000Z", "payload": payload}).to_string()
}

fn identifier(revision: &str) -> Value {
    let seq: u64 = revision.split(':').next().unwrap().parse().unwrap();
    json!({"desiredRevisionSeq": seq, "desiredRevision": revision})
}

fn welcome(revision: &str, interval: u64, reconnect_before: Option<u64>) -> String {
    welcome_with_log(revision, interval, reconnect_before, None)
}

fn welcome_with_log(
    revision: &str,
    interval: u64,
    reconnect_before: Option<u64>,
    log_policy_revision: Option<u64>,
) -> String {
    let mut payload = json!({
        "sessionId": "9f1d2c3a-0000-4000-8000-000000000001",
        "serverId": "server-1",
        "serverName": "edge-1",
        "desired": identifier(revision),
        "updatePolicy": {"desiredAgentVersion": "latest", "desiredSingBoxVersion": null},
        "statusIntervalSeconds": interval,
        "limits": {"maxFrameBytes": 4194304, "snapshotChunkBytes": 65536, "maxSnapshotBytes": 8388608}
    });
    if let Some(seconds) = reconnect_before {
        payload["reconnectBeforeSeconds"] = json!(seconds);
    }
    if let Some(revision) = log_policy_revision {
        payload["logPolicyRevision"] = json!(revision);
    }
    peer_frame("welcome", payload)
}

fn log_snapshot(request_id: &str, revision: u64) -> String {
    peer_frame(
        "log.policy.snapshot",
        json!({
            "requestId": request_id,
            "revision": revision,
            "sources": [
                {
                    "source": "agent",
                    "revision": revision,
                    "baseline": "info",
                    "level": "debug",
                    "deadline": "2099-01-01T00:00:00Z",
                },
                {
                    "source": "sing-box",
                    "revision": revision,
                    "baseline": "info",
                    "level": "info",
                    "deadline": null,
                },
            ],
        }),
    )
}

fn log_ack(revision: u64) -> LogPolicyAck {
    LogPolicyAck {
        source: LogPolicySource::Agent,
        source_revision: revision,
        requested: LogLevel::Debug,
        baseline: LogLevel::Info,
        effective: LogLevel::Info,
        deadline: Some(
            chrono::DateTime::parse_from_rfc3339("2099-01-01T00:00:00Z")
                .unwrap()
                .with_timezone(&chrono::Utc),
        ),
        error: None,
        pending: true,
    }
}

/// Sends a complete one-chunk snapshot for `request_id`.
fn send_snapshot(harness: &Harness, request_id: &str, revision: &str, body: &[u8]) {
    let digest = hex::encode(Sha256::digest(body));
    harness
        .peer
        .send(Ok(peer_frame(
            "config.snapshot.begin",
            json!({
                "requestId": request_id,
                "desired": identifier(revision),
                "contentType": "application/json",
                "totalBytes": body.len(),
                "chunkCount": 1,
                "digest": digest,
            }),
        )))
        .unwrap();
    harness
        .peer
        .send(Ok(peer_frame(
            "config.snapshot.chunk",
            json!({"requestId": request_id, "index": 0, "data": STANDARD.encode(body)}),
        )))
        .unwrap();
    harness
        .peer
        .send(Ok(peer_frame(
            "config.snapshot.end",
            json!({"requestId": request_id}),
        )))
        .unwrap();
}

fn body_for(revision: &str) -> Vec<u8> {
    format!(r#"{{"apiVersion":3,"desiredRevision":"{revision}"}}"#).into_bytes()
}

async fn next(harness: &mut Harness) -> Value {
    let text = harness.sent.recv().await.expect("the session sent a frame");
    serde_json::from_str(&text).unwrap()
}

/// Returns the payload of the next frame of `kind`. Periodic `agent.status`
/// frames are skipped unless they are what the test is waiting for.
async fn expect_type(harness: &mut Harness, kind: &str) -> Value {
    loop {
        let frame = next(harness).await;
        if frame["type"] == "agent.status" && kind != "agent.status" {
            continue;
        }
        assert_eq!(frame["type"], kind, "{frame}");
        return frame["payload"].clone();
    }
}

async fn expect_silence(harness: &mut Harness) {
    let result = tokio::time::timeout(Duration::from_millis(200), harness.sent.recv()).await;
    assert!(result.is_err(), "unexpected frame: {result:?}");
}

#[tokio::test(start_paused = true)]
async fn a_cold_start_fetches_the_snapshot_applies_it_and_acknowledges_it() {
    let mut harness = start(None);
    let hello = expect_type(&mut harness, "hello").await;
    assert!(
        hello["applied"].is_null(),
        "an empty cache says so: {hello}"
    );

    harness.peer.send(Ok(welcome(D7, 30, None))).unwrap();
    let get = expect_type(&mut harness, "config.get").await;
    assert_eq!(get["reason"], "initial");
    let request_id = get["requestId"].as_str().unwrap().to_string();

    let body = body_for(D7);
    send_snapshot(&harness, &request_id, D7, &body);
    let job = harness.core.apply.recv().await.expect("a verified job");
    assert_eq!(job.body, body);
    assert_eq!(job.desired.desired_revision, D7);

    harness
        .core
        .results
        .send(ApplyResult {
            request_id: job.request_id,
            desired: job.desired,
            outcome: ApplyOutcome::Applied,
        })
        .await
        .unwrap();
    let ack = expect_type(&mut harness, "config.ack").await;
    assert_eq!(ack["outcome"], "applied");
    assert_eq!(ack["desired"]["desiredRevision"], D7);
    assert!(
        ack.get("stage").is_none() && ack.get("error").is_none(),
        "{ack}"
    );
}

#[tokio::test(start_paused = true)]
async fn an_applied_identifier_that_matches_the_welcome_requests_nothing() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness.peer.send(Ok(welcome(D7, 30, None))).unwrap();
    expect_silence(&mut harness).await;
}

#[tokio::test(start_paused = true)]
async fn a_welcome_with_a_newer_log_policy_revision_fetches_and_acknowledges_it() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness
        .peer
        .send(Ok(welcome_with_log(D7, 30, None, Some(3))))
        .unwrap();

    let get = expect_type(&mut harness, "log.policy.get").await;
    let request_id = get["requestId"].as_str().unwrap().to_string();
    harness.peer.send(Ok(log_snapshot(&request_id, 3))).unwrap();
    let job = harness.core.log_jobs.recv().await.expect("a policy job");
    assert_eq!(job.revision, 3);
    assert_eq!(
        job.sources,
        vec![
            LogPolicyDesired {
                source: LogPolicySource::Agent,
                revision: 3,
                baseline: LogLevel::Info,
                level: LogLevel::Debug,
                deadline: Some(
                    chrono::DateTime::parse_from_rfc3339("2099-01-01T00:00:00Z")
                        .unwrap()
                        .with_timezone(&chrono::Utc),
                ),
            },
            LogPolicyDesired {
                source: LogPolicySource::SingBox,
                revision: 3,
                baseline: LogLevel::Info,
                level: LogLevel::Info,
                deadline: None,
            },
        ]
    );

    harness.core.log_acks.send_replace(vec![log_ack(3)]);
    let ack = expect_type(&mut harness, "log.policy.ack").await;
    assert_eq!(ack["source"], "agent");
    assert_eq!(ack["sourceRevision"], 3);
    assert_eq!(ack["requested"], "debug");
    assert_eq!(ack["effective"], "info");

    // The same status is not sent twice.
    harness.core.log_acks.send_replace(vec![log_ack(3)]);
    expect_silence(&mut harness).await;
}

#[tokio::test(start_paused = true)]
async fn a_status_ack_recovers_a_missed_log_policy_notification() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness
        .peer
        .send(Ok(welcome_with_log(D7, 30, None, Some(3))))
        .unwrap();
    let get = expect_type(&mut harness, "log.policy.get").await;
    let request_id = get["requestId"].as_str().unwrap().to_string();
    harness.peer.send(Ok(log_snapshot(&request_id, 3))).unwrap();
    let _job = harness.core.log_jobs.recv().await.expect("a policy job");

    harness
        .peer
        .send(Ok(peer_frame(
            "agent.status.ack",
            json!({
                "desired": identifier(D7),
                "updatePolicy": {"desiredAgentVersion": null, "desiredSingBoxVersion": null},
                "logPolicyRevision": 4,
            }),
        )))
        .unwrap();
    let get = expect_type(&mut harness, "log.policy.get").await;
    assert!(get["requestId"].as_str().unwrap().starts_with("log-get-"));
}

#[tokio::test(start_paused = true)]
async fn a_stale_log_policy_snapshot_changes_nothing() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness
        .peer
        .send(Ok(welcome_with_log(D7, 30, None, Some(3))))
        .unwrap();
    let get = expect_type(&mut harness, "log.policy.get").await;
    let request_id = get["requestId"].as_str().unwrap().to_string();
    harness.peer.send(Ok(log_snapshot(&request_id, 3))).unwrap();
    let _job = harness.core.log_jobs.recv().await.expect("a policy job");

    harness.peer.send(Ok(log_snapshot("stale", 2))).unwrap();
    expect_silence(&mut harness).await;
    assert!(harness.core.log_jobs.try_recv().is_err());
}

#[tokio::test(start_paused = true)]
async fn a_status_ack_with_a_newer_identifier_recovers_a_lost_notify() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness.peer.send(Ok(welcome(D7, 30, None))).unwrap();
    harness
        .peer
        .send(Ok(peer_frame(
            "agent.status.ack",
            json!({
                "desired": identifier(D8),
                "updatePolicy": {"desiredAgentVersion": null, "desiredSingBoxVersion": null}
            }),
        )))
        .unwrap();
    let get = expect_type(&mut harness, "config.get").await;
    assert_eq!(get["reason"], "mismatch");
}

#[tokio::test(start_paused = true)]
async fn repeated_notifies_for_one_identifier_request_one_snapshot() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness.peer.send(Ok(welcome(D7, 30, None))).unwrap();
    for _ in 0..2 {
        harness
            .peer
            .send(Ok(peer_frame(
                "config.notify",
                json!({"desired": identifier(D8), "reason": "node updated"}),
            )))
            .unwrap();
    }
    let get = expect_type(&mut harness, "config.get").await;
    assert_eq!(get["reason"], "notify");
    expect_silence(&mut harness).await;
}

#[tokio::test(start_paused = true)]
async fn a_digest_mismatch_is_a_receive_failure_and_stages_nothing() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness.peer.send(Ok(welcome(D7, 30, None))).unwrap();
    harness
        .peer
        .send(Ok(peer_frame(
            "config.notify",
            json!({"desired": identifier(D8)}),
        )))
        .unwrap();
    let get = expect_type(&mut harness, "config.get").await;
    let request_id = get["requestId"].as_str().unwrap().to_string();

    let body = body_for(D8);
    let mut tampered = body.clone();
    tampered[0] ^= 1;
    harness
        .peer
        .send(Ok(peer_frame(
            "config.snapshot.begin",
            json!({
                "requestId": request_id,
                "desired": identifier(D8),
                "contentType": "application/json",
                "totalBytes": body.len(),
                "chunkCount": 1,
                "digest": hex::encode(Sha256::digest(&body)),
            }),
        )))
        .unwrap();
    harness
        .peer
        .send(Ok(peer_frame(
            "config.snapshot.chunk",
            json!({"requestId": request_id, "index": 0, "data": STANDARD.encode(&tampered)}),
        )))
        .unwrap();
    harness
        .peer
        .send(Ok(peer_frame(
            "config.snapshot.end",
            json!({"requestId": request_id}),
        )))
        .unwrap();

    let ack = expect_type(&mut harness, "config.ack").await;
    assert_eq!(ack["outcome"], "failed");
    assert_eq!(ack["stage"], "receive");
    assert!(ack["error"].as_str().unwrap().contains("digest"));
    assert_eq!(ack["desired"]["desiredRevision"], D8);
    assert!(harness.core.apply.try_recv().is_err(), "nothing was staged");
}

#[tokio::test(start_paused = true)]
async fn a_snapshot_for_a_superseded_request_is_ignored() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness.peer.send(Ok(welcome(D7, 30, None))).unwrap();
    harness
        .peer
        .send(Ok(peer_frame(
            "config.notify",
            json!({"desired": identifier(D8)}),
        )))
        .unwrap();
    let first = expect_type(&mut harness, "config.get").await;
    harness
        .peer
        .send(Ok(peer_frame(
            "config.notify",
            json!({"desired": identifier(D9)}),
        )))
        .unwrap();
    let second = expect_type(&mut harness, "config.get").await;
    assert_ne!(first["requestId"], second["requestId"]);

    let stale = first["requestId"].as_str().unwrap().to_string();
    send_snapshot(&harness, &stale, D8, &body_for(D8));
    expect_silence(&mut harness).await;
    assert!(harness.core.apply.try_recv().is_err());

    let current = second["requestId"].as_str().unwrap().to_string();
    send_snapshot(&harness, &current, D9, &body_for(D9));
    let job = harness.core.apply.recv().await.unwrap();
    assert_eq!(job.desired.desired_revision, D9);
}

#[tokio::test(start_paused = true)]
async fn a_replaced_session_and_a_disabled_server_end_the_connection() {
    let mut harness = start(None);
    expect_type(&mut harness, "hello").await;
    harness
        .peer
        .send(Ok(peer_frame(
            "error",
            json!({"code": "session_replaced", "message": "a newer session is active"}),
        )))
        .unwrap();
    assert_eq!(harness.task.await.unwrap(), SessionEnd::Replaced);

    let mut harness = start(None);
    expect_type(&mut harness, "hello").await;
    harness
        .peer
        .send(Ok(peer_frame(
            "error",
            json!({"code": "server_disabled", "message": "server is disabled"}),
        )))
        .unwrap();
    assert_eq!(harness.task.await.unwrap(), SessionEnd::ServerDisabled);
}

#[tokio::test(start_paused = true)]
async fn a_traffic_report_completes_when_its_report_id_is_acknowledged() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness.peer.send(Ok(welcome(D7, 30, None))).unwrap();

    let (reply, outcome) = oneshot::channel();
    harness
        .traffic
        .requests
        .send(TrafficRequest {
            report: report("report-0001"),
            reply,
        })
        .await
        .unwrap();
    let sent = expect_type(&mut harness, "traffic.report").await;
    assert_eq!(sent["reportId"], "report-0001");

    harness
        .peer
        .send(Ok(peer_frame(
            "traffic.ack",
            json!({"reportId": "report-0001", "result": "duplicate", "accepted": 1, "dropped": 0}),
        )))
        .unwrap();
    assert_eq!(outcome.await.unwrap(), TrafficOutcome::Accepted);
}

#[tokio::test(start_paused = true)]
async fn a_conflicting_traffic_replay_is_reported_and_not_retried_by_the_session() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness.peer.send(Ok(welcome(D7, 30, None))).unwrap();
    let (reply, outcome) = oneshot::channel();
    harness
        .traffic
        .requests
        .send(TrafficRequest {
            report: report("report-0002"),
            reply,
        })
        .await
        .unwrap();
    expect_type(&mut harness, "traffic.report").await;
    harness
        .peer
        .send(Ok(peer_frame(
            "traffic.ack",
            json!({"reportId": "report-0002", "result": "conflict", "error": "different content"}),
        )))
        .unwrap();
    assert_eq!(
        outcome.await.unwrap(),
        TrafficOutcome::Conflict("different content".to_string())
    );
}

#[tokio::test(start_paused = true)]
async fn a_refused_traffic_payload_releases_its_report_as_rejected() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness.peer.send(Ok(welcome(D7, 30, None))).unwrap();
    let (reply, outcome) = oneshot::channel();
    harness
        .traffic
        .requests
        .send(TrafficRequest {
            report: report("report-0004"),
            reply,
        })
        .await
        .unwrap();
    expect_type(&mut harness, "traffic.report").await;
    harness
        .peer
        .send(Ok(peer_frame(
            "error",
            json!({"code": "invalid_payload", "type": "traffic.report", "message": "frame rejected"}),
        )))
        .unwrap();
    assert_eq!(
        outcome.await.unwrap(),
        TrafficOutcome::Rejected("frame rejected".to_string())
    );
}

#[tokio::test(start_paused = true)]
async fn a_report_without_an_acknowledgement_is_released_when_the_session_ends() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness.peer.send(Ok(welcome(D7, 30, None))).unwrap();
    let (reply, outcome) = oneshot::channel();
    harness
        .traffic
        .requests
        .send(TrafficRequest {
            report: report("report-0003"),
            reply,
        })
        .await
        .unwrap();
    expect_type(&mut harness, "traffic.report").await;
    harness.peer.send(Err(WsError::Closed)).unwrap();
    let end = harness.task.await.unwrap();
    assert!(
        matches!(end, SessionEnd::Lost { welcomed: true, .. }),
        "{end:?}"
    );
    assert!(outcome.await.is_err(), "no acknowledgement means no reply");
}

#[tokio::test(start_paused = true)]
async fn a_peer_that_never_welcomes_is_dropped_at_the_handshake_deadline() {
    let mut harness = start(None);
    expect_type(&mut harness, "hello").await;
    let end = harness.task.await.unwrap();
    assert_eq!(
        end,
        SessionEnd::Lost {
            reason: "no welcome before the handshake deadline".to_string(),
            welcomed: false,
        }
    );
    drop(harness.peer);
}

#[tokio::test(start_paused = true)]
async fn silence_past_the_liveness_window_ends_a_welcomed_session() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness.peer.send(Ok(welcome(D7, 30, None))).unwrap();
    let end = harness.task.await.unwrap();
    assert!(
        matches!(end, SessionEnd::Lost { welcomed: true, .. }),
        "{end:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn status_is_sent_on_the_welcome_interval_and_on_core_changes() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness.peer.send(Ok(welcome(D7, 30, None))).unwrap();

    let interval = expect_type(&mut harness, "agent.status").await;
    assert_eq!(interval["reason"], "interval");
    assert_eq!(
        interval["error"],
        Value::Null,
        "an explicit null clears the error"
    );
    assert_eq!(interval["configState"], "applied");

    let mut changed = status_with(Some(D7));
    changed.config_state = ConfigState::ApplyFailed;
    changed.error = Some(crate::ws::v2::codec::StatusError {
        phase: "health".into(),
        code: "SINGBOX_HEALTH_CHECK_FAILED".into(),
        message: "candidate did not become healthy".into(),
        node_id: None,
        occurred_at: None,
    });
    harness.core.status.send(changed).unwrap();
    let change = expect_type(&mut harness, "agent.status").await;
    assert_eq!(change["reason"], "change");
    assert_eq!(change["configState"], "apply_failed");
    assert_eq!(change["error"]["code"], "SINGBOX_HEALTH_CHECK_FAILED");
}

#[tokio::test(start_paused = true)]
async fn a_snapshot_that_never_completes_is_a_receive_failure_at_the_deadline() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness.peer.send(Ok(welcome(D7, 30, None))).unwrap();
    harness
        .peer
        .send(Ok(peer_frame(
            "config.notify",
            json!({"desired": identifier(D8)}),
        )))
        .unwrap();
    let get = expect_type(&mut harness, "config.get").await;
    let request_id = get["requestId"].as_str().unwrap().to_string();
    harness
        .peer
        .send(Ok(peer_frame(
            "config.snapshot.begin",
            json!({
                "requestId": request_id,
                "desired": identifier(D8),
                "contentType": "application/json",
                "totalBytes": 4,
                "chunkCount": 1,
                "digest": hex::encode(Sha256::digest(b"body")),
            }),
        )))
        .unwrap();
    let ack = expect_type(&mut harness, "config.ack").await;
    assert_eq!(ack["outcome"], "failed");
    assert_eq!(ack["stage"], "receive");
    assert!(ack["error"].as_str().unwrap().contains("deadline"));
}

#[tokio::test(start_paused = true)]
async fn an_early_reconnect_deadline_from_welcome_ends_the_session() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness.peer.send(Ok(welcome(D7, 30, Some(10)))).unwrap();
    let end = harness.task.await.unwrap();
    assert_eq!(end, SessionEnd::Deadline);
}

#[tokio::test(start_paused = true)]
async fn a_token_refresh_deadline_reconnects_before_the_welcome_hint() {
    let token_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut harness = start_with_token_deadline(Some(D7), Some(token_deadline));
    expect_type(&mut harness, "hello").await;
    // The serverless hint is much later, so the token lease must win.
    harness.peer.send(Ok(welcome(D7, 30, Some(60)))).unwrap();
    let end = harness.task.await.unwrap();
    assert_eq!(end, SessionEnd::Deadline);
}

#[tokio::test(start_paused = true)]
async fn welcome_publishes_the_update_policy_to_the_core() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness.peer.send(Ok(welcome(D7, 30, None))).unwrap();
    harness.core.policy.changed().await.unwrap();
    let policy = harness.core.policy.borrow().clone();
    assert_eq!(policy.desired_agent_version.as_deref(), Some("latest"));
    assert_eq!(policy.desired_sing_box_version, None);
}

#[tokio::test(start_paused = true)]
async fn a_frame_from_the_wrong_direction_is_answered_and_the_session_continues() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness
        .peer
        .send(Ok(peer_frame("hello", json!({}))))
        .unwrap();
    let error = expect_type(&mut harness, "error").await;
    assert_eq!(error["code"], "invalid_direction");
    assert_eq!(error["type"], "hello");

    harness.peer.send(Ok(welcome(D7, 30, None))).unwrap();
    expect_silence(&mut harness).await;
}

#[tokio::test(start_paused = true)]
async fn an_unsupported_envelope_version_ends_the_session_as_a_protocol_error() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness
        .peer
        .send(Ok(
            r#"{"v":1,"type":"pong","ts":"2026-11-19T00:00:00Z","payload":{}}"#.to_string(),
        ))
        .unwrap();
    let end = harness.task.await.unwrap();
    assert!(matches!(end, SessionEnd::Protocol(_)), "{end:?}");
}

#[tokio::test(start_paused = true)]
async fn cancellation_ends_the_session_without_a_reason_to_retry() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness.cancel.cancel();
    assert_eq!(harness.task.await.unwrap(), SessionEnd::Cancelled);
}

#[tokio::test(start_paused = true)]
async fn the_hello_reports_the_applied_identifier_and_build() {
    let mut harness = start(Some(D7));
    let hello = expect_type(&mut harness, "hello").await;
    assert_eq!(hello["applied"]["desiredRevisionSeq"], 7);
    assert_eq!(hello["agentBuildId"], "test-build");
    assert_eq!(hello["capabilities"], json!(["config-v3", "ws-v2"]));
}

#[tokio::test(start_paused = true)]
async fn a_failed_apply_is_held_across_status_exchanges_and_then_retried() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness.peer.send(Ok(welcome(D7, 30, None))).unwrap();
    let status_ack = |revision: &str| {
        peer_frame(
            "agent.status.ack",
            json!({
                "desired": identifier(revision),
                "updatePolicy": {"desiredAgentVersion": null, "desiredSingBoxVersion": null}
            }),
        )
    };

    harness.peer.send(Ok(status_ack(D8))).unwrap();
    let get = expect_type(&mut harness, "config.get").await;
    send_snapshot(
        &harness,
        get["requestId"].as_str().unwrap(),
        D8,
        &body_for(D8),
    );
    let job = harness.core.apply.recv().await.unwrap();
    harness
        .core
        .results
        .send(ApplyResult {
            request_id: job.request_id,
            desired: job.desired,
            outcome: ApplyOutcome::Failed {
                stage: AckStage::Apply,
                error: "candidate did not become healthy".into(),
            },
        })
        .await
        .unwrap();
    let ack = expect_type(&mut harness, "config.ack").await;
    assert_eq!(ack["outcome"], "failed");

    // The next status exchange still names the failed identifier. It must not
    // restart the fetch and apply cycle inside the hold.
    harness.peer.send(Ok(status_ack(D8))).unwrap();
    expect_silence(&mut harness).await;

    tokio::time::advance(Duration::from_secs(61)).await;
    harness.peer.send(Ok(status_ack(D8))).unwrap();
    let retry = expect_type(&mut harness, "config.get").await;
    assert_eq!(retry["reason"], "mismatch");
}

#[tokio::test(start_paused = true)]
async fn a_refused_snapshot_is_held_across_status_exchanges_and_then_retried() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness.peer.send(Ok(welcome(D7, 30, None))).unwrap();
    let status_ack = |revision: &str| {
        peer_frame(
            "agent.status.ack",
            json!({
                "desired": identifier(revision),
                "updatePolicy": {"desiredAgentVersion": null, "desiredSingBoxVersion": null}
            }),
        )
    };

    harness.peer.send(Ok(status_ack(D8))).unwrap();
    let get = expect_type(&mut harness, "config.get").await;
    harness
        .peer
        .send(Ok(peer_frame(
            "config.snapshot.error",
            json!({
                "requestId": get["requestId"],
                "code": "snapshot_too_large",
                "message": "the compiled configuration exceeds the snapshot limit",
            }),
        )))
        .unwrap();
    let refusal = harness.core.refusals.recv().await.unwrap();
    assert_eq!(refusal.code, "snapshot_too_large");

    // The same refused identifier must not restart the compile and transfer
    // on the next status exchange.
    harness.peer.send(Ok(status_ack(D8))).unwrap();
    expect_silence(&mut harness).await;

    tokio::time::advance(Duration::from_secs(61)).await;
    harness.peer.send(Ok(status_ack(D8))).unwrap();
    let retry = expect_type(&mut harness, "config.get").await;
    assert_eq!(retry["reason"], "mismatch");
}

#[tokio::test(start_paused = true)]
async fn control_plane_operations_are_forwarded_to_the_core() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness.peer.send(Ok(welcome(D7, 30, None))).unwrap();

    harness
        .peer
        .send(Ok(peer_frame(
            "update.trigger",
            json!({"target": "agent", "desiredAgentVersion": "latest", "force": true}),
        )))
        .unwrap();
    let update = harness.core.commands.recv().await.unwrap();
    assert!(matches!(update, Command::UpdateTrigger(trigger) if trigger.force));

    harness
        .peer
        .send(Ok(peer_frame(
            "acme.issue",
            json!({
                "jobId": "job-1",
                "certificateId": "cert-1",
                "generation": 2,
                "domains": ["example.com"],
                "acmeProvider": "letsencrypt",
                "challengeType": "dns-01"
            }),
        )))
        .unwrap();
    let issue = harness.core.commands.recv().await.unwrap();
    assert!(matches!(issue, Command::AcmeIssue(issue) if issue.job_id == "job-1"));

    harness
        .peer
        .send(Ok(peer_frame(
            "acme.dns_ack",
            json!({
                "jobId": "job-1",
                "fqdn": "_acme-challenge.example.com",
                "txtValue": "digest",
                "accepted": true
            }),
        )))
        .unwrap();
    let ack = harness.core.commands.recv().await.unwrap();
    assert!(matches!(ack, Command::AcmeDnsAck(ack) if ack.accepted));

    harness
        .peer
        .send(Ok(peer_frame(
            "pty.open",
            json!({"sessionId": "pty-1", "cols": 80, "rows": 24}),
        )))
        .unwrap();
    let pty = harness.core.commands.recv().await.unwrap();
    assert!(matches!(
        pty,
        Command::Pty(frame) if frame.frame_type == frame_type::PTY_OPEN
    ));
}

#[tokio::test(start_paused = true)]
async fn core_terminal_frames_are_sent_as_v2_frames() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness.peer.send(Ok(welcome(D7, 30, None))).unwrap();

    let frame = AgentWsFrame::new(
        frame_type::PTY_DATA,
        json!({"sessionId": "pty-1", "data": "hello"}),
    )
    .unwrap();
    harness
        .core
        .outbound
        .enqueue(WsCommand::Send(frame))
        .unwrap();

    let sent = expect_type(&mut harness, "pty.data").await;
    assert_eq!(sent["sessionId"], "pty-1");
    assert_eq!(sent["data"], "hello");
}

#[tokio::test(start_paused = true)]
async fn pty_data_is_accepted_in_both_directions_but_other_types_are_not() {
    let mut harness = start(Some(D7));
    expect_type(&mut harness, "hello").await;
    harness.peer.send(Ok(welcome(D7, 30, None))).unwrap();

    harness
        .peer
        .send(Ok(peer_frame(
            "pty.data",
            json!({"sessionId": "pty-1", "data": "ls"}),
        )))
        .unwrap();
    let command = harness.core.commands.recv().await.unwrap();
    assert!(matches!(
        command,
        Command::Pty(frame) if frame.frame_type == frame_type::PTY_DATA
    ));

    harness
        .peer
        .send(Ok(peer_frame("pty.exit", json!({"sessionId": "pty-1"}))))
        .unwrap();
    let error = expect_type(&mut harness, "error").await;
    assert_eq!(error["code"], "invalid_direction");
}

fn report(report_id: &str) -> TrafficReport {
    TrafficReport {
        report_id: report_id.to_string(),
        window_started_at: None,
        window_ended_at: None,
        entries: vec![TrafficEntry {
            subscription_id: "sub-1".to_string(),
            uplink_bytes: 1024,
            downlink_bytes: 4096,
        }],
    }
}
