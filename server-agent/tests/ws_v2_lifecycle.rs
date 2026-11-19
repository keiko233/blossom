//! Process-level lifecycle test for the default protocol v2 path.
//!
//! The real agent binary runs against a local WebSocket control plane and a
//! fake sing-box. The control plane never serves the old HTTP agent API; any
//! such request is recorded and failed. The agent is started without
//! `--ws-protocol` (and with any inherited `AGENT_WS_PROTOCOL` removed), so
//! this is the same entry point an installed static backup uses. The test
//! covers a cold snapshot apply,
//! a traffic acknowledgement lost with the socket and replayed under the same
//! report id, a missed-notification recovery through `agent.status.ack`, a
//! failed candidate that rolls back to the last-known-good config, and an
//! offline restart from that config.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use futures_util::{SinkExt as _, StreamExt as _};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};

const D1: &str = "1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const D2: &str = "2:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SUBPROTOCOL: &str = "blossom-agent.v2";
const PROBATION_MS: u64 = 11_500;
const SNAPSHOT_CHUNK_BYTES: usize = 64 * 1024;

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("blossom-ws-v2-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Harness {
    _dir: TestDir,
    state_dir: PathBuf,
    fake_singbox: PathBuf,
    fake_log: PathBuf,
    agent_log: PathBuf,
    http_requests: Arc<Mutex<Vec<String>>>,
}

impl Harness {
    fn new() -> Self {
        let dir = TestDir::new();
        let state_dir = dir.path().join("state");
        fs::create_dir_all(state_dir.join("traffic/pending")).unwrap();
        let fake_singbox = dir.path().join("sing-box");
        let fake_log = dir.path().join("fake-sing-box.log");
        let agent_log = dir.path().join("agent.log");
        write_fake_singbox(&fake_singbox);
        write_pending_traffic(&state_dir);
        Self {
            _dir: dir,
            state_dir,
            fake_singbox,
            fake_log,
            agent_log,
            http_requests: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn spawn_agent(&self, url: &str) -> Child {
        let log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.agent_log)
            .unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_server-agent"));
        // Exercise the shipped default: a static backup token with no
        // `--ws-protocol` flag and no `AGENT_WS_PROTOCOL` override.
        command
            .env_remove("AGENT_WS_PROTOCOL")
            .arg("--url")
            .arg(url)
            .arg("--token")
            .arg("test-agent-token")
            .arg("--state-dir")
            .arg(&self.state_dir)
            .arg("--sing-box-path")
            .arg(&self.fake_singbox)
            .arg("--v2-probation-ms")
            .arg(PROBATION_MS.to_string())
            .arg("--v2-traffic-interval-seconds")
            .arg("1")
            .arg("--log-level")
            .arg("info")
            .env("FAKE_SINGBOX_LOG", &self.fake_log)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .kill_on_drop(true);
        command.spawn().unwrap()
    }

    fn runs(&self) -> usize {
        fs::read_to_string(&self.fake_log)
            .unwrap_or_default()
            .lines()
            .filter(|line| line.starts_with("run "))
            .count()
    }

    fn active_config(&self) -> String {
        fs::read_to_string(self.state_dir.join("active.json")).unwrap_or_default()
    }

    fn agent_output(&self) -> String {
        fs::read_to_string(&self.agent_log).unwrap_or_default()
    }
}

fn write_fake_singbox(path: &Path) {
    fs::write(
        path,
        r#"#!/bin/sh
set -eu
case "$1" in
  version)
    echo "sing-box version 1.14.0"
    ;;
  check)
    exit 0
    ;;
  run)
    echo "run $3" >> "$FAKE_SINGBOX_LOG"
    echo "synthetic-alpha INFO agent ready"
    echo "synthetic-warn WARN dial tcp refused" >&2
    echo "synthetic-secret ERROR authorization=Bearer topsecret-value" >&2
    if grep -q "node-runtime-fail" "$3"; then
      echo "ERROR the failing test inbound cannot start" >&2
      exit 1
    fi
    trap 'exit 0' TERM INT
    while :; do sleep 1; done
    ;;
esac
"#,
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
}

fn write_pending_traffic(state_dir: &Path) {
    let pending = state_dir.join("traffic/pending/report-0001.json");
    let ended = chrono::Utc::now();
    let started = ended - chrono::Duration::seconds(60);
    let batch = json!({
        "version": 1,
        "report_id": "report-0001",
        "window_started_at": started.to_rfc3339(),
        "window_ended_at": ended.to_rfc3339(),
        "entries": [{
            "subscription_id": "sub-1",
            "uplink_bytes": 1024,
            "downlink_bytes": 4096,
        }],
    });
    fs::write(pending, serde_json::to_vec(&batch).unwrap()).unwrap();
}

fn document(revision: &str, runtime_failure: bool) -> Vec<u8> {
    let tag = if runtime_failure {
        "node-runtime-fail"
    } else {
        "node-test"
    };
    // More than one chunk, so the snapshot path exercises ordering, the
    // announced chunk count, and the complete-body digest.
    let padding = "x".repeat(SNAPSHOT_CHUNK_BYTES + 512);
    let document = json!({
        "apiVersion": 3,
        "agent": {
            "configPollIntervalSeconds": 5,
            "heartbeatIntervalSeconds": 5,
        },
        "desiredRevision": revision,
        "materializedNodeIds": ["node-test"],
        "singboxConfig": {
            "log": {"level": "info", "timestamp": true},
            "inbounds": [{
                "type": "vless",
                "tag": tag,
                "listen": "127.0.0.1",
                "listen_port": 18443,
                "users": [{
                    "name": "integration-test",
                    "uuid": "550e8400-e29b-41d4-a716-446655440000",
                }],
            }],
            "outbounds": [{"type": "direct", "tag": "direct"}],
            "testPadding": padding,
        },
        "managedTlsBindings": [],
        "certificateArtifacts": [],
    });
    serde_json::to_vec(&document).unwrap()
}

fn identifier(revision: &str) -> Value {
    let seq: u64 = revision.split(':').next().unwrap().parse().unwrap();
    json!({
        "desiredRevisionSeq": seq,
        "desiredRevision": revision,
    })
}

fn welcome(revision: &str) -> Value {
    json!({
        "v": 2,
        "type": "welcome",
        "ts": chrono::Utc::now().to_rfc3339(),
        "payload": {
            "sessionId": format!("session-{revision}"),
            "serverId": "server-1",
            "serverName": "edge-1",
            "desired": identifier(revision),
            "updatePolicy": {
                "desiredAgentVersion": null,
                "desiredSingBoxVersion": null,
            },
            "statusIntervalSeconds": 30,
            "limits": {
                "maxFrameBytes": 4 * 1024 * 1024,
                "snapshotChunkBytes": SNAPSHOT_CHUNK_BYTES,
                "maxSnapshotBytes": 8 * 1024 * 1024,
            },
        },
    })
}

fn status_ack(revision: &str) -> Value {
    json!({
        "v": 2,
        "type": "agent.status.ack",
        "ts": chrono::Utc::now().to_rfc3339(),
        "payload": {
            "desired": identifier(revision),
            "updatePolicy": {
                "desiredAgentVersion": null,
                "desiredSingBoxVersion": null,
            },
        },
    })
}

fn status_ack_with_log(revision: &str, log_policy_revision: u64) -> Value {
    json!({
        "v": 2,
        "type": "agent.status.ack",
        "ts": chrono::Utc::now().to_rfc3339(),
        "payload": {
            "desired": identifier(revision),
            "updatePolicy": {
                "desiredAgentVersion": null,
                "desiredSingBoxVersion": null,
            },
            "logPolicyRevision": log_policy_revision,
        },
    })
}

fn log_policy_notify(revision: u64) -> Value {
    json!({
        "v": 2,
        "type": "log.policy.notify",
        "ts": chrono::Utc::now().to_rfc3339(),
        "payload": {
            "revision": revision,
            "source": "agent",
            "reason": "administrator changed the level",
        },
    })
}

fn log_policy_snapshot(
    request_id: &str,
    revision: u64,
    agent_level: &str,
    sing_box_level: &str,
) -> Value {
    json!({
        "v": 2,
        "type": "log.policy.snapshot",
        "ts": chrono::Utc::now().to_rfc3339(),
        "payload": {
            "requestId": request_id,
            "revision": revision,
            "sources": [
                {
                    "source": "agent",
                    "revision": revision,
                    "baseline": agent_level,
                    "level": agent_level,
                    "deadline": null,
                },
                {
                    "source": "sing-box",
                    "revision": revision,
                    "baseline": sing_box_level,
                    "level": sing_box_level,
                    "deadline": null,
                },
            ],
        },
    })
}

fn traffic_ack(report_id: &str) -> Value {
    json!({
        "v": 2,
        "type": "traffic.ack",
        "ts": chrono::Utc::now().to_rfc3339(),
        "payload": {
            "reportId": report_id,
            "result": "duplicate",
            "accepted": 1,
            "dropped": 0,
        },
    })
}

async fn send(socket: &mut WebSocket, value: &Value) {
    socket.send(Message::text(value.to_string())).await.unwrap();
}

async fn send_snapshot(socket: &mut WebSocket, request_id: &str, revision: &str, body: &[u8]) {
    let chunks: Vec<&[u8]> = body.chunks(SNAPSHOT_CHUNK_BYTES).collect();
    send(
        socket,
        &json!({
            "v": 2,
            "type": "config.snapshot.begin",
            "ts": chrono::Utc::now().to_rfc3339(),
            "payload": {
                "requestId": request_id,
                "desired": identifier(revision),
                "contentType": "application/json",
                "totalBytes": body.len(),
                "chunkCount": chunks.len(),
                "digest": hex::encode(Sha256::digest(body)),
            },
        }),
    )
    .await;
    for (index, chunk) in chunks.iter().enumerate() {
        send(
            socket,
            &json!({
                "v": 2,
                "type": "config.snapshot.chunk",
                "ts": chrono::Utc::now().to_rfc3339(),
                "payload": {
                    "requestId": request_id,
                    "index": index,
                    "data": STANDARD.encode(chunk),
                },
            }),
        )
        .await;
    }
    send(
        socket,
        &json!({
            "v": 2,
            "type": "config.snapshot.end",
            "ts": chrono::Utc::now().to_rfc3339(),
            "payload": {"requestId": request_id},
        }),
    )
    .await;
}

type WebSocket = tokio_tungstenite::WebSocketStream<TcpStream>;

async fn receive(socket: &mut WebSocket) -> Value {
    loop {
        let message = timeout(Duration::from_secs(60), socket.next())
            .await
            .expect("control-plane read timed out")
            .expect("the agent closed the socket")
            .expect("websocket error");
        match message {
            Message::Text(text) => return serde_json::from_str(text.as_str()).unwrap(),
            Message::Ping(payload) => {
                socket.send(Message::Pong(payload)).await.unwrap();
            }
            Message::Pong(_) | Message::Frame(_) => {}
            Message::Binary(_) => panic!("v2 carries text frames only"),
            Message::Close(_) => panic!("the agent closed the socket early"),
        }
    }
}

async fn peek_is_websocket(stream: &TcpStream) -> bool {
    let mut buffer = vec![0u8; 8192];
    for _ in 0..200 {
        let read = timeout(Duration::from_millis(50), stream.peek(&mut buffer))
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(0);
        if read == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
            continue;
        }
        if buffer[..read]
            .windows(4)
            .any(|window| window == b"\r\n\r\n")
        {
            let headers = String::from_utf8_lossy(&buffer[..read]).to_ascii_lowercase();
            return headers.contains("upgrade: websocket");
        }
    }
    false
}

async fn refuse_http(stream: &mut TcpStream, requests: &Mutex<Vec<String>>) {
    let mut buffer = vec![0u8; 8192];
    let read = timeout(Duration::from_secs(5), stream.read(&mut buffer))
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(0);
    let request = String::from_utf8_lossy(&buffer[..read]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("<unparsed>")
        .to_string();
    requests.lock().unwrap().push(path);
    let body = b"{\"error\":\"the v2 agent must not call the HTTP agent API\"}";
    let _ = stream
        .write_all(
            format!(
                "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .as_bytes(),
        )
        .await;
    let _ = stream.write_all(body).await;
    let _ = stream.shutdown().await;
}

async fn upgrade(stream: TcpStream) -> WebSocket {
    #[expect(
        clippy::result_large_err,
        reason = "tungstenite fixes the handshake error type"
    )]
    let callback = |request: &Request, mut response: Response| {
        let offered = request
            .headers()
            .get("sec-websocket-protocol")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if offered != SUBPROTOCOL {
            let mut error = ErrorResponse::new(None);
            *error.status_mut() = StatusCode::BAD_REQUEST;
            return Err(error);
        }
        response.headers_mut().insert(
            "sec-websocket-protocol",
            HeaderValue::from_static(SUBPROTOCOL),
        );
        Ok(response)
    };
    let socket: WebSocket = tokio_tungstenite::accept_hdr_async(stream, callback)
        .await
        .expect("websocket upgrade");
    socket
}

async fn session_one(stream: TcpStream) -> Value {
    let mut socket = upgrade(stream).await;
    let hello = receive(&mut socket).await;
    assert_eq!(hello["type"], "hello", "first session: {hello}");
    assert!(
        hello["payload"]["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "ws-v2"),
        "first session: {hello}"
    );
    assert!(
        hello["payload"]["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "log-policy-v1"),
        "the v2 agent advertises log policy: {hello}"
    );
    assert!(
        hello["payload"]["applied"].is_null(),
        "a cold start reports an empty cache: {hello}"
    );
    send(&mut socket, &welcome(D1)).await;
    let traffic = run_first_session(&mut socket).await;
    let _ = socket.close(None).await;
    traffic
}

async fn session_two(stream: TcpStream, first_traffic: Value) {
    let mut socket = upgrade(stream).await;
    let hello = receive(&mut socket).await;
    assert_eq!(hello["type"], "hello", "second session: {hello}");
    assert_eq!(
        hello["payload"]["applied"],
        identifier(D1),
        "the reconnected session reports the committed configuration: {hello}"
    );
    send(&mut socket, &welcome(D1)).await;
    run_second_session(&mut socket, first_traffic).await;
    let _ = socket.close(None).await;
}

async fn run_first_session(socket: &mut WebSocket) -> Value {
    let mut config_acked = false;
    let mut traffic = None;
    let mut history_seen = false;
    let mut live_seen = false;
    let mut snapshot_seen = false;
    let has_interfaces = has_non_loopback_interface();
    send(
        socket,
        &telemetry_subscribe("history-session-1", "history", 60_000),
    )
    .await;
    while !config_acked || traffic.is_none() || !history_seen || !live_seen || !snapshot_seen {
        let frame = receive(socket).await;
        match frame["type"].as_str().unwrap() {
            "config.get" => {
                assert_eq!(frame["payload"]["reason"], "initial", "{frame}");
                let request_id = frame["payload"]["requestId"].as_str().unwrap();
                send_snapshot(socket, request_id, D1, &document(D1, false)).await;
            }
            "config.ack" => {
                assert_eq!(frame["payload"]["outcome"], "applied", "{frame}");
                assert_eq!(frame["payload"]["desired"], identifier(D1), "{frame}");
                config_acked = true;
            }
            "traffic.report" => traffic = Some(frame["payload"].clone()),
            "telemetry.sample" => {
                let payload = &frame["payload"];
                let purpose = payload["purpose"].as_str().unwrap();
                assert!(!payload["scopeKey"].as_str().unwrap().contains(' '));
                assert!(
                    payload["sampledAt"].as_str().unwrap().contains('T'),
                    "{frame}"
                );
                if purpose == "history" {
                    assert_eq!(payload["subscriptionId"], "history-session-1");
                    assert!(!history_seen, "one history sample before any live view");
                    history_seen = true;
                    send(
                        socket,
                        &telemetry_subscribe("live-session-1", "live", 1_000),
                    )
                    .await;
                } else {
                    assert_eq!(purpose, "live", "{frame}");
                    assert_eq!(payload["subscriptionId"], "live-session-1");
                    if has_interfaces {
                        let network = &payload["network"];
                        assert!(
                            network.is_object(),
                            "a second observation with interfaces must yield rates: {frame}"
                        );
                        assert!(network["windowMs"].as_u64().unwrap() >= 1);
                        assert!(network["txBytesPerSecond"].is_number(), "{frame}");
                        assert!(network["rxBytesPerSecond"].is_number(), "{frame}");
                    }
                    live_seen = true;
                    send(
                        socket,
                        &json!({
                            "v": 2,
                            "type": "telemetry.inspect",
                            "ts": chrono::Utc::now().to_rfc3339(),
                            "payload": {"requestId": "inspect-1"},
                        }),
                    )
                    .await;
                }
            }
            "telemetry.snapshot" => {
                assert_eq!(frame["payload"]["requestId"], "inspect-1");
                assert_eq!(frame["payload"]["partial"], false);
                assert!(frame["payload"]["listeners"].is_array());
                snapshot_seen = true;
                send(
                    socket,
                    &json!({
                        "v": 2,
                        "type": "telemetry.unsubscribe",
                        "ts": chrono::Utc::now().to_rfc3339(),
                        "payload": {"subscriptionId": "live-session-1"},
                    }),
                )
                .await;
                send(
                    socket,
                    &json!({
                        "v": 2,
                        "type": "telemetry.unsubscribe",
                        "ts": chrono::Utc::now().to_rfc3339(),
                        "payload": {"subscriptionId": "history-session-1"},
                    }),
                )
                .await;
            }
            "agent.status" => {}
            "log.policy.ack" => {}
            other => panic!("unexpected frame in the first session: {other}: {frame}"),
        }
    }
    send(socket, &log_policy_notify(1)).await;
    let get = loop {
        let frame = receive(socket).await;
        match frame["type"].as_str().unwrap() {
            "log.policy.get" => break frame,
            "agent.status" => {}
            "log.policy.ack" => {}
            other => panic!("unexpected frame before log.policy.get: {other}: {frame}"),
        }
    };
    let request_id = get["payload"]["requestId"].as_str().unwrap();
    send(socket, &log_policy_snapshot(request_id, 1, "info", "info")).await;
    let mut agent_acked = false;
    let mut sing_box_acked = false;
    while !agent_acked || !sing_box_acked {
        let frame = receive(socket).await;
        match frame["type"].as_str().unwrap() {
            "log.policy.ack" => {
                if frame["payload"]["sourceRevision"] != 1 {
                    continue;
                }
                assert_eq!(frame["payload"]["error"], Value::Null, "{frame}");
                assert_eq!(frame["payload"]["pending"], false, "{frame}");
                match frame["payload"]["source"].as_str().unwrap() {
                    "agent" => {
                        assert_eq!(frame["payload"]["sourceRevision"], 1, "{frame}");
                        assert_eq!(frame["payload"]["requested"], "info", "{frame}");
                        assert_eq!(frame["payload"]["baseline"], "info", "{frame}");
                        assert_eq!(frame["payload"]["effective"], "info", "{frame}");
                        agent_acked = true;
                    }
                    "sing-box" => {
                        assert_eq!(frame["payload"]["sourceRevision"], 1, "{frame}");
                        assert_eq!(frame["payload"]["effective"], "info", "{frame}");
                        sing_box_acked = true;
                    }
                    other => panic!("unknown log policy source {other}: {frame}"),
                }
            }
            "agent.status" => {}
            other => panic!("unexpected frame while log policy applied: {other}: {frame}"),
        }
    }

    // A lost notification is recovered from the status acknowledgement.
    send(socket, &status_ack_with_log(D1, 2)).await;
    let get = loop {
        let frame = receive(socket).await;
        match frame["type"].as_str().unwrap() {
            "log.policy.get" => break frame,
            "agent.status" => {}
            "log.policy.ack" => {}
            other => panic!("unexpected frame before log policy reconciliation: {other}: {frame}"),
        }
    };
    let request_id = get["payload"]["requestId"].as_str().unwrap();
    send(socket, &log_policy_snapshot(request_id, 2, "warn", "info")).await;
    loop {
        let frame = receive(socket).await;
        match frame["type"].as_str().unwrap() {
            "log.policy.ack" => {
                if frame["payload"]["source"] == "agent" && frame["payload"]["sourceRevision"] == 2
                {
                    assert_eq!(frame["payload"]["sourceRevision"], 2, "{frame}");
                    assert_eq!(frame["payload"]["requested"], "warn", "{frame}");
                    assert_eq!(frame["payload"]["baseline"], "warn", "{frame}");
                    assert_eq!(frame["payload"]["effective"], "warn", "{frame}");
                    break;
                }
            }
            "agent.status" => {}
            other => panic!("unexpected frame while log policy reconciled: {other}: {frame}"),
        }
    }
    check_tail(socket).await;
    // Close without acknowledging the report: the durable queue must resend it
    // under the same id on the next session.
    traffic.unwrap()
}

async fn check_tail(socket: &mut WebSocket) {
    send(
        socket,
        &json!({
            "v": 2,
            "type": "logs.subscribe",
            "ts": chrono::Utc::now().to_rfc3339(),
            "payload": {
                "subscriptionId": "tail-1",
                "filter": {"source": "sing-box", "minLevel": "info"},
                "resume": null,
                "limit": 50,
            },
        }),
    )
    .await;
    loop {
        let frame = receive(socket).await;
        match frame["type"].as_str().unwrap() {
            "logs.batch" => {
                assert_eq!(frame["payload"]["subscriptionId"], "tail-1", "{frame}");
                let records = frame["payload"]["records"].as_array().unwrap();
                let texts: Vec<_> = records
                    .iter()
                    .map(|record| record["text"].as_str().unwrap())
                    .collect();
                assert!(
                    texts.iter().any(|text| text.contains("synthetic-alpha")),
                    "the tail did not return the retained sing-box output: {frame}"
                );
                assert!(
                    texts.iter().any(|text| text.contains("dial tcp refused")),
                    "the tail did not return the warning line: {frame}"
                );
                assert!(
                    texts.iter().any(|text| text.contains("[REDACTED]")),
                    "the retained secret was not redacted: {frame}"
                );
                assert!(
                    texts.iter().all(|text| !text.contains("topsecret-value")),
                    "the retained secret reached the wire: {frame}"
                );
                assert!(
                    records.iter().all(|record| record["source"] == "sing-box"),
                    "the tail filter leaked another source: {frame}"
                );
                return;
            }
            "agent.status" | "traffic.report" | "config.get" | "log.policy.ack" => {}
            other => panic!("unexpected frame while tailing logs: {other}: {frame}"),
        }
    }
}

fn telemetry_subscribe(subscription_id: &str, purpose: &str, interval_ms: u64) -> Value {
    json!({
        "v": 2,
        "type": "telemetry.subscribe",
        "ts": chrono::Utc::now().to_rfc3339(),
        "payload": {
            "subscriptionId": subscription_id,
            "purpose": purpose,
            "intervalMs": interval_ms,
        },
    })
}

fn has_non_loopback_interface() -> bool {
    std::fs::read_to_string("/proc/net/dev")
        .map(|input| {
            input.lines().skip(2).any(|line| {
                line.split_once(':')
                    .is_some_and(|(name, _)| !name.trim().is_empty() && name.trim() != "lo")
            })
        })
        .unwrap_or(false)
}

async fn run_second_session(socket: &mut WebSocket, first_traffic: Value) {
    loop {
        let frame = receive(socket).await;
        match frame["type"].as_str().unwrap() {
            "traffic.report" => {
                assert_eq!(
                    frame["payload"], first_traffic,
                    "a replay must repeat the exact report payload"
                );
                let report_id = frame["payload"]["reportId"].as_str().unwrap();
                send(socket, &traffic_ack(report_id)).await;
                break;
            }
            "agent.status" => {}
            "log.policy.ack" => {}
            other => panic!("unexpected frame before the traffic replay: {other}: {frame}"),
        }
    }

    // A lost `config.notify` is recovered by the authoritative identifier in
    // the status acknowledgement.
    send(socket, &status_ack(D2)).await;
    let config_get = loop {
        let frame = receive(socket).await;
        match frame["type"].as_str().unwrap() {
            "config.get" => break frame,
            "agent.status" => {}
            "log.policy.ack" => {}
            other => panic!("unexpected frame before config.get: {other}: {frame}"),
        }
    };
    assert_eq!(config_get["payload"]["reason"], "mismatch", "{config_get}");
    let request_id = config_get["payload"]["requestId"].as_str().unwrap();
    send_snapshot(socket, request_id, D2, &document(D2, true)).await;

    loop {
        let frame = receive(socket).await;
        match frame["type"].as_str().unwrap() {
            "config.ack" => {
                assert_eq!(frame["payload"]["outcome"], "failed", "{frame}");
                assert_eq!(frame["payload"]["stage"], "apply", "{frame}");
                assert_eq!(frame["payload"]["desired"], identifier(D2), "{frame}");
                break;
            }
            "agent.status" => {}
            "log.policy.ack" => {}
            other => panic!("unexpected frame while the candidate failed: {other}: {frame}"),
        }
    }

    // The failed identifier must not move the applied one. The next
    // authoritative status names the still-applied D1 and must not re-fetch.
    send(socket, &status_ack(D1)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while tokio::time::Instant::now() < deadline {
        match timeout(Duration::from_millis(200), socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                let frame: Value = serde_json::from_str(text.as_str()).unwrap();
                assert_ne!(
                    frame["type"], "config.get",
                    "the applied identifier must not be fetched again: {frame}"
                );
            }
            Ok(Some(Ok(Message::Ping(payload)))) => {
                socket.send(Message::Pong(payload)).await.unwrap();
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(error))) => panic!("websocket error: {error}"),
            Ok(None) => break,
            Err(_) => {}
        }
    }

    // The reconnect must not inherit the first session's tail subscription.
    let quiet = tokio::time::Instant::now() + Duration::from_secs(1);
    while tokio::time::Instant::now() < quiet {
        match timeout(Duration::from_millis(200), socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                let frame: Value = serde_json::from_str(text.as_str()).unwrap();
                assert!(
                    !frame["type"]
                        .as_str()
                        .unwrap_or_default()
                        .starts_with("logs."),
                    "a log subscription survived the reconnect: {frame}"
                );
            }
            Ok(Some(Ok(Message::Ping(payload)))) => {
                socket.send(Message::Pong(payload)).await.unwrap();
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(error))) => panic!("websocket error: {error}"),
            Ok(None) => break,
            Err(_) => {}
        }
    }
    check_search_and_context(socket).await;
}

fn logs_frame(kind: &str, payload: Value) -> Value {
    json!({
        "v": 2,
        "type": kind,
        "ts": chrono::Utc::now().to_rfc3339(),
        "payload": payload,
    })
}

async fn search_result(
    socket: &mut WebSocket,
    request_id: &str,
    query: Value,
    cursor: Value,
) -> Value {
    send(
        socket,
        &logs_frame(
            "logs.search",
            json!({
                "requestId": request_id,
                "query": query,
                "cursor": cursor,
                "limit": 1,
            }),
        ),
    )
    .await;
    loop {
        let frame = receive(socket).await;
        match frame["type"].as_str().unwrap() {
            "logs.search.result" => {
                assert_eq!(
                    frame["payload"]["requestId"], request_id,
                    "a search reply must echo its request id: {frame}"
                );
                return frame;
            }
            "logs.error" => panic!("the agent refused a search: {frame}"),
            "agent.status" | "agent.status.ack" | "config.get" | "logs.batch" | "logs.gap" => {}
            other => panic!("unexpected frame while searching: {other}: {frame}"),
        }
    }
}

async fn check_search_and_context(socket: &mut WebSocket) {
    let query = json!({
        "text": "synthetic",
        "source": "sing-box",
        "minLevel": "info",
    });
    let first = search_result(socket, "search-1", query.clone(), Value::Null).await;
    let payload = &first["payload"];
    assert_eq!(
        payload["matches"].as_array().unwrap().len(),
        1,
        "the page must honor its limit: {first}"
    );
    assert!(
        payload["coverage"]["gap"].is_null(),
        "the search lost coverage: {first}"
    );
    assert!(
        payload["coverage"]["searchableFrom"].is_string(),
        "the search did not report its range: {first}"
    );
    let continuation = payload["next"].clone();
    assert!(
        continuation.is_object(),
        "a further match must offer a continuation: {first}"
    );

    let second = search_result(socket, "search-2", query, continuation).await;
    assert_eq!(
        second["payload"]["matches"].as_array().unwrap().len(),
        1,
        "the continuation must return the next match: {second}"
    );
    assert_ne!(
        first["payload"]["matches"][0]["seq"], second["payload"]["matches"][0]["seq"],
        "pagination must not repeat a record"
    );

    let target = &second["payload"]["matches"][0];
    let generation = second["payload"]["generation"].clone();
    send(
        socket,
        &logs_frame(
            "logs.context",
            json!({
                "requestId": "ctx-1",
                "generation": generation,
                "seq": target["seq"],
                "before": 2,
                "after": 2,
            }),
        ),
    )
    .await;
    loop {
        let frame = receive(socket).await;
        match frame["type"].as_str().unwrap() {
            "logs.context.result" => {
                assert_eq!(frame["payload"]["requestId"], "ctx-1", "{frame}");
                assert_eq!(frame["payload"]["target"]["seq"], target["seq"], "{frame}");
                assert_eq!(
                    frame["payload"]["target"]["text"], target["text"],
                    "{frame}"
                );
                return;
            }
            "logs.error" => panic!("the agent refused the context lookup: {frame}"),
            "agent.status" | "logs.batch" | "logs.gap" => {}
            other => panic!("unexpected frame while loading context: {other}: {frame}"),
        }
    }
}

async fn stop_agent(child: &mut Child) {
    let Some(pid) = child.id() else {
        return;
    };
    let _ = Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status()
        .await;
    if timeout(Duration::from_secs(15), child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
}

#[tokio::test]
async fn the_default_agent_completes_its_lifecycle_without_the_http_agent_api() {
    let harness = Harness::new();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::clone(&harness.http_requests);
    let server = tokio::spawn(async move {
        let mut first = None;
        for session in 1..=2 {
            loop {
                let (stream, _) = listener.accept().await.expect("accept");
                if peek_is_websocket(&stream).await {
                    if session == 1 {
                        first = Some(session_one(stream).await);
                    } else {
                        session_two(stream, first.take().expect("first traffic report")).await;
                    }
                    break;
                }
                let mut stream = stream;
                refuse_http(&mut stream, &requests).await;
            }
        }
    });

    let url = format!("http://{address}/api");
    let mut agent = harness.spawn_agent(&url);
    timeout(Duration::from_secs(70), server)
        .await
        .expect("the v2 lifecycle took too long")
        .expect("control-plane session failed");

    assert!(
        harness.http_requests.lock().unwrap().is_empty(),
        "the v2 agent called the HTTP agent API: {:?}",
        harness.http_requests.lock().unwrap()
    );
    assert!(
        !harness.active_config().contains("node-runtime-fail"),
        "the failed candidate must roll back to the last-known-good config:\n{}",
        harness.active_config()
    );
    assert!(
        !harness
            .state_dir
            .join("traffic/pending/report-0001.json")
            .exists(),
        "the acknowledged report must leave the durable queue"
    );

    let runs = harness.runs();
    stop_agent(&mut agent).await;

    // The control plane is gone. A restart must still launch sing-box from the
    // committed configuration before any network connection succeeds.
    let mut offline = harness.spawn_agent(&format!("http://{address}/api"));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while harness.runs() <= runs && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        harness.runs() > runs,
        "the offline restart did not launch the last-known-good config:\n{}",
        harness.agent_output()
    );
    assert!(
        offline.try_wait().unwrap().is_none(),
        "the offline agent exited:\n{}",
        harness.agent_output()
    );
    stop_agent(&mut offline).await;
    assert!(
        harness.http_requests.lock().unwrap().is_empty(),
        "the offline v2 agent called the HTTP agent API: {:?}",
        harness.http_requests.lock().unwrap()
    );
}
