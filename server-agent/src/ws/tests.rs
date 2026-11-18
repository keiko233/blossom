//! Deterministic tests for the reconnect loop using in-memory fakes.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::codec::{
    AgentMessage, AgentWsFrame, HelloPayload, PingPayload, WelcomePayload, frame_type,
};
use super::ports::{WsCommand, WsConnection, WsError, WsEvent, WsTransport};
use super::{HelloSource, Jitter, run};

#[derive(Default, Clone)]
struct FakeJitter;

impl Jitter for FakeJitter {
    fn next(&self) -> f64 {
        0.0
    }
}

struct FakeHello;

impl HelloSource for FakeHello {
    fn hello(&self) -> HelloPayload {
        HelloPayload {
            agent_version: "0.2.0".into(),
            agent_build_id: "test".into(),
            capabilities: vec!["ws-v1".into()],
            applied_revision: Some("sha256:test".into()),
            certificate_deployments: vec![],
            updates: None,
        }
    }
}

/// Scripted connection: yields `inbound` frames, records outbound frames.
struct FakeConnection {
    inbound: VecDeque<Result<AgentWsFrame, WsError>>,
    sent: Arc<Mutex<Vec<AgentWsFrame>>>,
    closed: bool,
}

impl WsConnection for FakeConnection {
    async fn recv(&mut self) -> Result<AgentWsFrame, WsError> {
        match self.inbound.pop_front() {
            Some(frame) => frame,
            None => {
                // Park until the test cancels the loop.
                std::future::pending::<()>().await;
                unreachable!()
            }
        }
    }

    async fn send(&mut self, frame: AgentWsFrame) -> Result<(), WsError> {
        self.sent.lock().expect("sent frames lock").push(frame);
        Ok(())
    }

    async fn close(&mut self) {
        self.closed = true;
    }
}

type Script = Vec<Result<Vec<Result<AgentWsFrame, WsError>>, WsError>>;
type ConnectionScript = Result<VecDeque<Result<AgentWsFrame, WsError>>, WsError>;

#[derive(Clone)]
struct FakeTransport {
    script: Arc<Mutex<VecDeque<ConnectionScript>>>,
    sent: Arc<Mutex<Vec<AgentWsFrame>>>,
    connections: Arc<Mutex<u32>>,
}

impl WsTransport for FakeTransport {
    type Connection = FakeConnection;

    async fn connect(&self) -> Result<Self::Connection, WsError> {
        *self.connections.lock().expect("connection counter") += 1;
        match self.script.lock().expect("script lock").pop_front() {
            Some(Ok(inbound)) => Ok(FakeConnection {
                inbound,
                sent: self.sent.clone(),
                closed: false,
            }),
            Some(Err(error)) => Err(error),
            None => Err(WsError::Io("script exhausted".into())),
        }
    }
}

fn welcome(heartbeat: u64, reconnect_before: Option<u64>) -> AgentWsFrame {
    AgentWsFrame::new(
        frame_type::WELCOME,
        WelcomePayload {
            server_id: "srv-1".into(),
            server_name: "edge".into(),
            protocol_version: 1,
            desired_revision_seq: 1,
            desired_revision: "sha256:rev".into(),
            poll_interval_seconds: 60,
            heartbeat_interval_seconds: heartbeat,
            reconnect_before_seconds: reconnect_before,
        },
    )
    .unwrap()
}

fn frame(msg_type: &str, payload: serde_json::Value) -> AgentWsFrame {
    AgentWsFrame {
        v: 1,
        id: None,
        msg_type: msg_type.into(),
        ts: chrono::Utc::now(),
        payload,
    }
}

fn transport(script: Script) -> FakeTransport {
    FakeTransport {
        script: Arc::new(Mutex::new(
            script
                .into_iter()
                .map(|entry| entry.map(VecDeque::from))
                .collect(),
        )),
        sent: Arc::new(Mutex::new(Vec::new())),
        connections: Arc::new(Mutex::new(0)),
    }
}

async fn wait_for_event(events: &mut mpsc::Receiver<WsEvent>, label: &str) -> WsEvent {
    // The runtime is paused, so this timeout only bounds a stuck state machine:
    // tokio auto-advances virtual time to whichever timer fires first, and the
    // backoff ladder tops out at 30s.
    tokio::time::timeout(Duration::from_secs(600), events.recv())
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {label}"))
        .expect("event channel open")
}

#[tokio::test(start_paused = true)]
async fn sends_hello_then_reports_welcome_and_dispatches_frames() {
    let transport = transport(vec![Ok(vec![
        Ok(welcome(30, None)),
        Ok(frame(
            frame_type::CONFIG_NOTIFY,
            serde_json::json!({
                "desiredRevisionSeq": 4,
                "desiredRevision": "sha256:next",
                "reason": "node updated"
            }),
        )),
    ])]);
    let (event_tx, mut event_rx) = mpsc::channel(8);
    let (_command_sink, command_rx) = mpsc::channel(8);
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(run(
        transport.clone(),
        FakeHello,
        FakeJitter,
        event_tx,
        command_rx,
        cancel.clone(),
    ));

    let connected = wait_for_event(&mut event_rx, "connected").await;
    let WsEvent::Connected { welcome } = connected else {
        panic!("expected Connected, got {connected:?}");
    };
    assert_eq!(welcome.server_id, "srv-1");

    let pushed = wait_for_event(&mut event_rx, "config notify").await;
    let WsEvent::Frame(AgentMessage::ConfigNotify(notify)) = pushed else {
        panic!("expected config.notify, got {pushed:?}");
    };
    assert_eq!(notify.desired_revision_seq, 4);
    assert_eq!(notify.desired_revision, "sha256:next");

    {
        let sent = transport.sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].msg_type, frame_type::HELLO);
    }

    cancel.cancel();
    let _ = handle.await;
}

#[tokio::test(start_paused = true)]
async fn answers_control_plane_pings_with_matching_nonce() {
    let transport = transport(vec![Ok(vec![
        Ok(welcome(30, None)),
        Ok(AgentWsFrame::new(
            frame_type::PING,
            PingPayload {
                nonce: Some("abc".into()),
            },
        )
        .unwrap()),
    ])]);
    let (event_tx, mut event_rx) = mpsc::channel(8);
    let (_command_sink, command_rx) = mpsc::channel(8);
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(run(
        transport.clone(),
        FakeHello,
        FakeJitter,
        event_tx,
        command_rx,
        cancel.clone(),
    ));

    let _ = wait_for_event(&mut event_rx, "connected").await;
    // Let the pong be written.
    let pong = wait_for_sent(&transport, frame_type::PONG).await;
    assert_eq!(pong.payload, serde_json::json!({ "nonce": "abc" }));

    cancel.cancel();
    let _ = handle.await;
}

#[tokio::test(start_paused = true)]
async fn sends_queued_commands_over_the_session() {
    let transport = transport(vec![Ok(vec![Ok(welcome(30, None))])]);
    let (event_tx, mut event_rx) = mpsc::channel(8);
    let (command_sink, command_rx) = mpsc::channel(8);
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(run(
        transport.clone(),
        FakeHello,
        FakeJitter,
        event_tx,
        command_rx,
        cancel.clone(),
    ));

    let _ = wait_for_event(&mut event_rx, "connected").await;
    let ack = AgentWsFrame::new(
        frame_type::CONFIG_ACK,
        serde_json::json!({
            "appliedRevision": "sha256:rev",
            "certificateDeployments": []
        }),
    )
    .unwrap();
    command_sink.send(WsCommand::Send(ack)).await.unwrap();
    wait_for_sent(&transport, frame_type::CONFIG_ACK).await;

    cancel.cancel();
    let _ = handle.await;
}

async fn wait_for_sent(transport: &FakeTransport, msg_type: &str) -> AgentWsFrame {
    tokio::time::timeout(Duration::from_secs(600), async {
        loop {
            if let Some(frame) = transport
                .sent
                .lock()
                .expect("sent frames lock")
                .iter()
                .find(|frame| frame.msg_type == msg_type)
                .cloned()
            {
                return frame;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for a sent {msg_type} frame"))
}

#[tokio::test(start_paused = true)]
async fn hard_rejection_announces_http_fallback() {
    let transport = transport(vec![Err(WsError::Rejected { status: 404 })]);
    let (event_tx, mut event_rx) = mpsc::channel(8);
    let (_command_sink, command_rx) = mpsc::channel(8);
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(run(
        transport.clone(),
        FakeHello,
        FakeJitter,
        event_tx,
        command_rx,
        cancel.clone(),
    ));

    let event = wait_for_event(&mut event_rx, "fallback").await;
    let WsEvent::Fallback { reason } = event else {
        panic!("expected Fallback, got {event:?}");
    };
    assert!(reason.contains("404"), "{reason}");

    cancel.cancel();
    let _ = handle.await;
}

#[tokio::test(start_paused = true)]
async fn retries_with_backoff_and_recovers() {
    let transport = transport(vec![
        Err(WsError::Io("connection reset".into())),
        Err(WsError::Io("connection reset".into())),
        Err(WsError::Io("connection reset".into())),
        Ok(vec![Ok(welcome(30, None))]),
    ]);
    let (event_tx, mut event_rx) = mpsc::channel(8);
    let (_command_sink, command_rx) = mpsc::channel(8);
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(run(
        transport.clone(),
        FakeHello,
        FakeJitter,
        event_tx,
        command_rx,
        cancel.clone(),
    ));

    // Three transient failures reach the fallback threshold, then success.
    let first = wait_for_event(&mut event_rx, "first failure").await;
    assert!(matches!(first, WsEvent::Fallback { .. }), "{first:?}");
    let recovered = wait_for_event(&mut event_rx, "recovered").await;
    assert_eq!(recovered, WsEvent::Recovered);
    let connected = wait_for_event(&mut event_rx, "connected").await;
    assert!(matches!(connected, WsEvent::Connected { .. }));

    assert_eq!(*transport.connections.lock().unwrap(), 4);

    cancel.cancel();
    let _ = handle.await;
}

#[tokio::test(start_paused = true)]
async fn proactive_deadline_closes_the_session_before_the_cap() {
    let transport = transport(vec![
        Ok(vec![Ok(welcome(30, Some(5)))]),
        Ok(vec![Ok(welcome(30, Some(5)))]),
    ]);
    let (event_tx, mut event_rx) = mpsc::channel(8);
    let (_command_sink, command_rx) = mpsc::channel(8);
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(run(
        transport.clone(),
        FakeHello,
        FakeJitter,
        event_tx,
        command_rx,
        cancel.clone(),
    ));

    let _ = wait_for_event(&mut event_rx, "connected").await;
    let disconnected = wait_for_event(&mut event_rx, "proactive disconnect").await;
    let WsEvent::Disconnected { reason } = disconnected else {
        panic!("expected Disconnected, got {disconnected:?}");
    };
    assert!(reason.contains("serverless"), "{reason}");
    let reconnected = wait_for_event(&mut event_rx, "reconnected").await;
    assert!(matches!(reconnected, WsEvent::Connected { .. }));
    assert_eq!(*transport.connections.lock().unwrap(), 2);

    cancel.cancel();
    let _ = handle.await;
}

#[tokio::test(start_paused = true)]
async fn unknown_frames_are_forwarded_without_breaking_the_session() {
    let transport = transport(vec![Ok(vec![
        Ok(welcome(30, None)),
        Ok(frame("future.frame", serde_json::json!({ "x": 1 }))),
        Ok(frame(
            frame_type::UPDATE_STATUS,
            serde_json::json!({ "agent": { "state": "checking" } }),
        )),
    ])]);
    let (event_tx, mut event_rx) = mpsc::channel(8);
    let (_command_sink, command_rx) = mpsc::channel(8);
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(run(
        transport.clone(),
        FakeHello,
        FakeJitter,
        event_tx,
        command_rx,
        cancel.clone(),
    ));

    let _ = wait_for_event(&mut event_rx, "connected").await;
    let unknown = wait_for_event(&mut event_rx, "unknown frame").await;
    assert_eq!(
        unknown,
        WsEvent::Frame(AgentMessage::Unknown {
            frame_type: "future.frame".into()
        })
    );
    let status = wait_for_event(&mut event_rx, "update status").await;
    assert!(matches!(
        status,
        WsEvent::Frame(AgentMessage::UpdateStatus(_))
    ));

    cancel.cancel();
    let _ = handle.await;
}

#[tokio::test(start_paused = true)]
async fn a_peer_that_closes_before_welcome_keeps_backing_off() {
    // The connection upgrades, then closes before `welcome`. Three such
    // failures reach the fallback threshold rather than spinning.
    let transport = transport(vec![
        Ok(vec![Err(WsError::Closed)]),
        Ok(vec![Err(WsError::Closed)]),
        Ok(vec![Err(WsError::Closed)]),
        Ok(vec![Ok(welcome(30, None))]),
    ]);
    let (event_tx, mut event_rx) = mpsc::channel(8);
    let (_command_sink, command_rx) = mpsc::channel(8);
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(run(
        transport.clone(),
        FakeHello,
        FakeJitter,
        event_tx,
        command_rx,
        cancel.clone(),
    ));

    loop {
        let event = wait_for_event(&mut event_rx, "fallback").await;
        match event {
            WsEvent::Fallback { .. } => break,
            WsEvent::Disconnected { .. } => continue,
            other => panic!("unexpected event before fallback: {other:?}"),
        }
    }
    loop {
        let event = wait_for_event(&mut event_rx, "connected").await;
        match event {
            WsEvent::Connected { .. } => break,
            WsEvent::Recovered | WsEvent::Disconnected { .. } => continue,
            other => panic!("unexpected event before connect: {other:?}"),
        }
    }

    cancel.cancel();
    let _ = handle.await;
}
