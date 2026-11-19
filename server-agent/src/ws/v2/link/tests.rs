//! Reconnect cadence, checked on paused time with scripted connections.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::time::{Instant, timeout};
use tokio_util::sync::CancellationToken;

use super::{Connector, LinkOptions, ReconnectBackoff, run};
use crate::logs::{LogStore, RingLimits};
use crate::ws::Jitter;
use crate::ws::codec::UpdateStatusPayload;
use crate::ws::ports::WsError;
use crate::ws::v2::codec::{ConfigState, RuntimeState, UpdatePolicy};
use crate::ws::v2::session::{CoreStatus, HelloIdentity, Wire, channels};

struct FixedJitter(f64);

impl Jitter for FixedJitter {
    fn next(&self) -> f64 {
        self.0
    }
}

enum Plan {
    /// The upgrade fails with this error.
    Fail(WsError),
    /// The upgrade succeeds, and these inbound frames arrive before the socket closes.
    Frames(Vec<String>),
    /// As `Frames`, but the socket then stays open until a session deadline ends it.
    Hold(Vec<String>),
}

struct DisabledConnector(ScriptConnector);

impl Connector for DisabledConnector {
    type Wire = ScriptWire;

    async fn connect(&self) -> Result<ScriptWire, WsError> {
        Connector::connect(&self.0).await
    }

    fn disabled(&self, error: &WsError) -> bool {
        matches!(error, WsError::ServerDisabled { .. })
    }
}

#[derive(Clone)]
struct ScriptConnector {
    plans: Arc<Mutex<VecDeque<Plan>>>,
    connects: Arc<Mutex<Vec<Instant>>>,
}

struct ScriptWire {
    inbound: VecDeque<String>,
    hold: bool,
}

impl Wire for ScriptWire {
    async fn recv_text(&mut self) -> Result<String, WsError> {
        match self.inbound.pop_front() {
            Some(frame) => Ok(frame),
            None if self.hold => std::future::pending().await,
            None => Err(WsError::Closed),
        }
    }

    async fn send_text(&mut self, _text: String) -> Result<(), WsError> {
        Ok(())
    }

    async fn ping(&mut self) -> Result<(), WsError> {
        Ok(())
    }

    async fn close(&mut self) {}
}

impl Connector for ScriptConnector {
    type Wire = ScriptWire;

    async fn connect(&self) -> Result<ScriptWire, WsError> {
        self.connects.lock().unwrap().push(Instant::now());
        let plan = self.plans.lock().unwrap().pop_front();
        match plan {
            Some(Plan::Fail(error)) => Err(error),
            Some(Plan::Frames(frames)) => Ok(ScriptWire {
                inbound: frames.into(),
                hold: false,
            }),
            Some(Plan::Hold(frames)) => Ok(ScriptWire {
                inbound: frames.into(),
                hold: true,
            }),
            None => Err(WsError::Io("script exhausted".to_string())),
        }
    }
}

fn welcome(reconnect_before: Option<u64>) -> String {
    let mut payload = serde_json::json!({
        "sessionId": "9f1d2c3a-0000-4000-8000-000000000001",
        "serverId": "server-1",
        "serverName": "edge-1",
        "desired": {
            "desiredRevisionSeq": 7,
            "desiredRevision": "7:sha256:48a9e1aa59f365863b57348ccd1701026c39652cfb74b8e2b039811611802ec6"
        },
        "updatePolicy": {"desiredAgentVersion": null, "desiredSingBoxVersion": null},
        "statusIntervalSeconds": 30,
        "limits": {"maxFrameBytes": 4194304, "snapshotChunkBytes": 65536, "maxSnapshotBytes": 8388608}
    });
    if let Some(seconds) = reconnect_before {
        payload["reconnectBeforeSeconds"] = serde_json::json!(seconds);
    }
    serde_json::json!({"v": 2, "type": "welcome", "ts": "2026-11-19T00:00:00.000Z", "payload": payload})
        .to_string()
}

fn error_frame(code: &str) -> String {
    serde_json::json!({
        "v": 2,
        "type": "error",
        "ts": "2026-11-19T00:00:00.000Z",
        "payload": {"code": code, "message": "test"}
    })
    .to_string()
}

fn status() -> CoreStatus {
    CoreStatus {
        applied: None,
        runtime_state: RuntimeState::Stopped,
        config_state: ConfigState::Unknown,
        sing_box_version: None,
        active_node_ids: Vec::new(),
        error: None,
        deployments: Vec::new(),
        updates: UpdateStatusPayload::default(),
    }
}

fn options() -> LinkOptions {
    LinkOptions::new(HelloIdentity {
        agent_version: "1.3.0".into(),
        agent_build_id: "test".into(),
        capabilities: vec!["ws-v2".into()],
    })
}

/// Runs the link for `run_for`, then cancels it. Returns the connect instants
/// relative to the first connect.
async fn drive(plans: Vec<Plan>, jitter: f64, run_for: Duration) -> Vec<Duration> {
    let connector = ScriptConnector {
        plans: Arc::new(Mutex::new(plans.into())),
        connects: Arc::new(Mutex::new(Vec::new())),
    };
    let connects = connector.connects.clone();
    let (mut ports, _core, _traffic) = channels(
        status(),
        UpdatePolicy {
            desired_agent_version: None,
            desired_sing_box_version: None,
        },
        Vec::new(),
    );
    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();
    let store = LogStore::new(RingLimits::default());
    let task = tokio::spawn(async move {
        run(
            &connector,
            &mut ports,
            &options(),
            &FixedJitter(jitter),
            &task_cancel,
            &store,
        )
        .await;
    });
    tokio::time::sleep(run_for).await;
    cancel.cancel();
    task.await.unwrap();
    let times = connects.lock().unwrap().clone();
    let first = times[0];
    times.iter().map(|at| *at - first).collect()
}

#[test]
fn the_ladder_doubles_to_its_ceiling_with_jitter_below_each_base() {
    let mut backoff = ReconnectBackoff::new(Duration::from_secs(1), Duration::from_secs(60));
    let delays: Vec<Duration> = (0..9).map(|_| backoff.next_delay(0.0)).collect();
    assert_eq!(
        delays,
        [0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0, 30.0]
            .map(Duration::from_secs_f64)
            .to_vec()
    );
    let mut backoff = ReconnectBackoff::new(Duration::from_secs(1), Duration::from_secs(60));
    let high = backoff.next_delay(0.999_999);
    assert!(high < Duration::from_secs(1) && high > Duration::from_millis(999));
    backoff.reset();
    assert_eq!(backoff.next_delay(0.0), Duration::from_millis(500));
}

#[tokio::test(start_paused = true)]
async fn repeated_connect_failures_climb_the_ladder_and_stay_on_v2() {
    let plans = vec![
        Plan::Fail(WsError::SubprotocolMismatch),
        Plan::Fail(WsError::Rejected { status: 400 }),
        Plan::Fail(WsError::Io("connection reset".into())),
        Plan::Frames(vec![welcome(None)]),
    ];
    let gaps = drive(plans, 0.0, Duration::from_secs(10)).await;
    assert_eq!(gaps[1], Duration::from_millis(500));
    assert_eq!(gaps[2] - gaps[1], Duration::from_secs(1));
    assert_eq!(gaps[3] - gaps[2], Duration::from_secs(2));
}

#[tokio::test(start_paused = true)]
async fn a_welcomed_session_that_drops_restarts_the_ladder() {
    let plans = vec![
        Plan::Fail(WsError::Io("boom".into())),
        Plan::Fail(WsError::Io("boom".into())),
        Plan::Frames(vec![welcome(None)]),
        Plan::Fail(WsError::Io("after the drop".into())),
    ];
    let gaps = drive(plans, 0.0, Duration::from_secs(20)).await;
    // Connect index 2 is welcomed and then drops; index 3 follows after the reset delay.
    assert_eq!(gaps[3] - gaps[2], Duration::from_millis(500));
}

#[tokio::test(start_paused = true)]
async fn a_replaced_session_reconnects_quickly() {
    let plans = vec![
        Plan::Frames(vec![welcome(None), error_frame("session_replaced")]),
        Plan::Frames(vec![welcome(None)]),
    ];
    let gaps = drive(plans, 0.0, Duration::from_secs(5)).await;
    assert_eq!(gaps[1], Duration::from_millis(500));
}

#[tokio::test(start_paused = true)]
async fn a_disabled_server_waits_about_a_minute_before_retrying() {
    let plans = vec![
        Plan::Frames(vec![welcome(None), error_frame("server_disabled")]),
        Plan::Frames(vec![welcome(None)]),
    ];
    let gaps = drive(plans, 0.0, Duration::from_secs(60)).await;
    assert_eq!(gaps[1], Duration::from_secs(30));
}

#[tokio::test(start_paused = true)]
async fn a_rejected_upgrade_with_the_disabled_marker_reaches_the_core() {
    let connector = DisabledConnector(ScriptConnector {
        plans: Arc::new(Mutex::new(VecDeque::from([Plan::Fail(
            WsError::ServerDisabled { status: 409 },
        )]))),
        connects: Arc::new(Mutex::new(Vec::new())),
    });
    let (mut ports, mut core, _traffic) = channels(
        status(),
        UpdatePolicy {
            desired_agent_version: None,
            desired_sing_box_version: None,
        },
        Vec::new(),
    );
    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();
    let store = LogStore::new(RingLimits::default());
    let task = tokio::spawn(async move {
        run(
            &connector,
            &mut ports,
            &options(),
            &FixedJitter(0.0),
            &task_cancel,
            &store,
        )
        .await;
    });
    assert!(
        timeout(Duration::from_secs(5), core.disabled.recv())
            .await
            .expect("the disabled signal reaches the core")
            .is_some()
    );
    cancel.cancel();
    task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn an_ordinary_auth_rejection_never_becomes_a_disable_command() {
    let plans = vec![Plan::Fail(WsError::Rejected { status: 401 })];
    let connector = DisabledConnector(ScriptConnector {
        plans: Arc::new(Mutex::new(plans.into())),
        connects: Arc::new(Mutex::new(Vec::new())),
    });
    let (mut ports, mut core, _traffic) = channels(
        status(),
        UpdatePolicy {
            desired_agent_version: None,
            desired_sing_box_version: None,
        },
        Vec::new(),
    );
    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();
    let store = LogStore::new(RingLimits::default());
    let task = tokio::spawn(async move {
        run(
            &connector,
            &mut ports,
            &options(),
            &FixedJitter(0.0),
            &task_cancel,
            &store,
        )
        .await;
    });
    assert!(
        timeout(Duration::from_secs(2), core.disabled.recv())
            .await
            .is_err(),
        "a plain 401 must remain an authentication failure"
    );
    cancel.cancel();
    task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_proactive_deadline_reconnects_at_once() {
    let plans = vec![
        Plan::Hold(vec![welcome(Some(1))]),
        Plan::Frames(vec![welcome(None)]),
    ];
    let gaps = drive(plans, 0.0, Duration::from_secs(3)).await;
    assert_eq!(gaps[1], Duration::from_millis(900));
}

#[tokio::test(start_paused = true)]
async fn cancellation_stops_the_loop_during_a_backoff() {
    let connector = ScriptConnector {
        plans: Arc::new(Mutex::new(VecDeque::from([Plan::Fail(WsError::Io(
            "x".into(),
        ))]))),
        connects: Arc::new(Mutex::new(Vec::new())),
    };
    let (mut ports, _core, _traffic) = channels(
        status(),
        UpdatePolicy {
            desired_agent_version: None,
            desired_sing_box_version: None,
        },
        Vec::new(),
    );
    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();
    let store = LogStore::new(RingLimits::default());
    let task = tokio::spawn(async move {
        run(
            &connector,
            &mut ports,
            &options(),
            &FixedJitter(0.0),
            &task_cancel,
            &store,
        )
        .await;
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    cancel.cancel();
    tokio::time::timeout(Duration::from_millis(10), task)
        .await
        .expect("the loop stops without waiting out the backoff")
        .unwrap();
}
