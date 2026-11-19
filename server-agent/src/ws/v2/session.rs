//! One protocol v2 connection: handshake, desired-state reconciliation,
//! status, and traffic acknowledgements.
//!
//! The session owns the socket and never waits on the agent core. Config
//! application, downloads, and sing-box supervision run in the core, which
//! talks to the session only through the bounded channels and `watch` values
//! in [`channels`]. The session therefore keeps reading frames, answering
//! deadlines, and draining acknowledgements while a candidate is on probation.
//!
//! Each connection starts with `hello` and must see `welcome` within a
//! deadline. The session requests a snapshot only when the control plane's
//! identifier differs from the applied one. A snapshot that verifies is handed
//! to the core as an [`ApplyJob`], and a newer job replaces one not yet taken,
//! so a stale body never overtakes a newer one.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use super::adapter::V2Connection;
use super::codec::{
    self, AckOutcome, AckStage, ConfigAck, ConfigGet, ConfigIdentifier, ConfigNotify, ConfigState,
    DecodeError, ErrorCode, ErrorFrame, GetReason, Hello, Limits, MAX_FRAME_BYTES, Message,
    RuntimeState, Sender, StatusError, StatusReason, StatusReport, TrafficReport, TrafficResult,
    UpdatePolicy,
};
use super::snapshot::{SnapshotAssembler, SnapshotError, SnapshotLimits, VerifiedSnapshot};
use crate::ws::codec::{
    AcmeDnsAckPayload, AcmeIssuePayload, AgentWsFrame, CertificateDeployment, ReservedFrame,
    UpdateStatusPayload, UpdateTriggerPayload, frame_type,
};
use crate::ws::ports::{AgentCommandSink, WsCommand, WsError};

/// The text-frame transport a session runs over. [`V2Connection`] implements
/// it; tests substitute a scripted peer.
pub trait Wire: Send {
    fn recv_text(&mut self) -> impl Future<Output = Result<String, WsError>> + Send;
    fn send_text(&mut self, text: String) -> impl Future<Output = Result<(), WsError>> + Send;
    fn ping(&mut self) -> impl Future<Output = Result<(), WsError>> + Send;
    fn close(&mut self) -> impl Future<Output = ()> + Send;
    /// When the token used for this upgrade should be refreshed. The session
    /// reconnects first, so the next handshake presents a fresh token.
    fn refresh_deadline(&self) -> Option<Instant> {
        None
    }
}

impl Wire for V2Connection {
    async fn recv_text(&mut self) -> Result<String, WsError> {
        V2Connection::recv_text(self).await
    }

    async fn send_text(&mut self, text: String) -> Result<(), WsError> {
        V2Connection::send_text(self, text).await
    }

    async fn ping(&mut self) -> Result<(), WsError> {
        V2Connection::ping(self).await
    }

    async fn close(&mut self) {
        V2Connection::close(self).await;
    }

    fn refresh_deadline(&self) -> Option<Instant> {
        V2Connection::refresh_deadline(self)
    }
}

/// What the core reports for the session to send. A publish is a significant
/// change, so the session sends `agent.status` for each one.
#[derive(Debug, Clone, PartialEq)]
pub struct CoreStatus {
    /// The applied identifier, or `None` when the cache is empty or must be
    /// re-applied before it is trusted again.
    pub applied: Option<ConfigIdentifier>,
    pub runtime_state: RuntimeState,
    pub config_state: ConfigState,
    pub sing_box_version: Option<String>,
    pub active_node_ids: Vec<String>,
    pub error: Option<StatusError>,
    pub deployments: Vec<CertificateDeployment>,
    pub updates: UpdateStatusPayload,
}

/// A configuration body the session verified and the core must apply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyJob {
    pub request_id: String,
    pub desired: ConfigIdentifier,
    pub body: Vec<u8>,
}

/// The result of one apply, which becomes `config.ack`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyResult {
    pub request_id: String,
    pub desired: ConfigIdentifier,
    pub outcome: ApplyOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyOutcome {
    Applied,
    Failed { stage: AckStage, error: String },
}

/// A snapshot the control plane refused. The core records it in status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotRefusal {
    pub code: String,
    pub message: String,
}

/// What the control plane said about one traffic report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrafficOutcome {
    /// Recorded now, or recorded earlier under the same report id.
    Accepted,
    /// The report id was already used with different content, so nothing was applied.
    Conflict(String),
    /// The control plane refused the report's payload. Retrying cannot help.
    Rejected(String),
}

/// One traffic report to send. The reply channel closes without a value when
/// the session ends first, which means no acknowledgement arrived.
#[derive(Debug)]
pub struct TrafficRequest {
    pub report: TrafficReport,
    pub reply: oneshot::Sender<TrafficOutcome>,
}

/// A validated control-plane operation for the core. The session never runs
/// updates, ACME orders, or terminal processes itself.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    UpdateTrigger(UpdateTriggerPayload),
    AcmeIssue(AcmeIssuePayload),
    AcmeDnsAck(AcmeDnsAckPayload),
    Pty(ReservedFrame),
}

/// The identifier the last apply failed on, and when. It lives with the bridge
/// rather than the connection, so a reconnect does not re-fetch it at once.
#[derive(Debug, Default)]
struct FailedApply {
    last: Option<(ConfigIdentifier, Instant)>,
}

impl FailedApply {
    fn note(&mut self, desired: &ConfigIdentifier, outcome: &ApplyOutcome) {
        self.last = match outcome {
            ApplyOutcome::Applied => None,
            ApplyOutcome::Failed { .. } => Some((desired.clone(), Instant::now())),
        };
    }

    fn holds(&self, desired: &ConfigIdentifier, hold: Duration) -> bool {
        self.last
            .as_ref()
            .is_some_and(|(failed, at)| failed == desired && at.elapsed() < hold)
    }
}

/// The session's ends of the bridge.
pub struct SessionPorts {
    status: watch::Receiver<CoreStatus>,
    apply: mpsc::Sender<ApplyJob>,
    results: mpsc::Receiver<ApplyResult>,
    policy: watch::Sender<UpdatePolicy>,
    refusals: mpsc::Sender<SnapshotRefusal>,
    traffic: mpsc::Receiver<TrafficRequest>,
    commands: mpsc::Sender<Command>,
    outbound: mpsc::Receiver<WsCommand>,
    online: watch::Sender<bool>,
    failed: FailedApply,
}

/// The core's ends of the bridge.
pub struct CorePorts {
    pub status: watch::Sender<CoreStatus>,
    pub apply: mpsc::Receiver<ApplyJob>,
    pub results: mpsc::Sender<ApplyResult>,
    pub policy: watch::Receiver<UpdatePolicy>,
    pub refusals: mpsc::Receiver<SnapshotRefusal>,
    pub commands: mpsc::Receiver<Command>,
    pub outbound: Arc<dyn AgentCommandSink>,
    pub online: watch::Receiver<bool>,
}

/// The traffic task's end: it submits reports and watches whether a session
/// is connected to acknowledge them.
pub struct TrafficPorts {
    pub requests: mpsc::Sender<TrafficRequest>,
    pub online: watch::Receiver<bool>,
}

/// Creates the bridge between the session, the core, and the traffic task.
pub fn channels(
    initial_status: CoreStatus,
    initial_policy: UpdatePolicy,
) -> (SessionPorts, CorePorts, TrafficPorts) {
    let (status_tx, status_rx) = watch::channel(initial_status);
    let (apply_tx, apply_rx) = mpsc::channel(1);
    let (results_tx, results_rx) = mpsc::channel(8);
    let (policy_tx, policy_rx) = watch::channel(initial_policy);
    let (refusals_tx, refusals_rx) = mpsc::channel(8);
    let (traffic_tx, traffic_rx) = mpsc::channel(1);
    let (commands_tx, commands_rx) = mpsc::channel(16);
    let (outbound_sink, outbound_rx) = crate::ws::ports::command_channel(64);
    let (online_tx, online_rx) = watch::channel(false);
    let core_online = online_tx.subscribe();
    (
        SessionPorts {
            status: status_rx,
            apply: apply_tx,
            results: results_rx,
            policy: policy_tx,
            refusals: refusals_tx,
            traffic: traffic_rx,
            commands: commands_tx,
            outbound: outbound_rx,
            online: online_tx,
            failed: FailedApply::default(),
        },
        CorePorts {
            status: status_tx,
            apply: apply_rx,
            results: results_tx,
            policy: policy_rx,
            refusals: refusals_rx,
            commands: commands_rx,
            outbound: Arc::new(outbound_sink),
            online: core_online,
        },
        TrafficPorts {
            requests: traffic_tx,
            online: online_rx,
        },
    )
}

/// The identity the agent presents in `hello`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelloIdentity {
    pub agent_version: String,
    pub agent_build_id: String,
    pub capabilities: Vec<String>,
}

/// Deadlines and cadences. The defaults follow the contract; tests shorten them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionTiming {
    /// From `hello` to `welcome`.
    pub handshake: Duration,
    /// Time allowed for a requested snapshot to arrive and verify.
    pub snapshot: Duration,
    /// WebSocket ping cadence.
    pub ping: Duration,
    /// Silence from the control plane that counts as a dead connection. The
    /// effective window is never shorter than three status intervals.
    pub liveness: Duration,
    /// Status cadence until `welcome` supplies `statusIntervalSeconds`.
    pub default_status_interval: Duration,
    /// How long a failed identifier is not requested again. Without the hold,
    /// every status exchange would re-fetch and re-apply it.
    pub failed_apply_hold: Duration,
}

impl Default for SessionTiming {
    fn default() -> Self {
        Self {
            handshake: Duration::from_secs(15),
            snapshot: Duration::from_secs(60),
            ping: Duration::from_secs(20),
            liveness: Duration::from_secs(90),
            default_status_interval: Duration::from_secs(30),
            failed_apply_hold: Duration::from_secs(60),
        }
    }
}

/// Why a session ended. The reconnect policy turns this into a delay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEnd {
    /// The agent is shutting down.
    Cancelled,
    /// Transport or handshake failure. `welcomed` is true when the handshake
    /// had completed, so the failure streak restarts.
    Lost { reason: String, welcomed: bool },
    /// A newer session replaced this one. Reconnect and handshake again.
    Replaced,
    /// The server is disabled. Back off; do not retry in a tight loop.
    ServerDisabled,
    /// The control plane asked for an early reconnect (serverless lifetime).
    Deadline,
    /// The peer speaks an envelope version this agent does not.
    Protocol(String),
}

/// The newest `config.get` this session sent.
#[derive(Debug)]
struct Requested {
    request_id: String,
    /// The identifier the request was made for.
    asked_for: ConfigIdentifier,
    /// The identifier named by `config.snapshot.begin`, which may be newer.
    announced: Option<ConfigIdentifier>,
    /// True until the verified snapshot is handed to the core. Only a snapshot
    /// still being received can time out.
    awaiting_snapshot: bool,
    at: Instant,
}

struct State {
    welcomed: bool,
    assembler: SnapshotAssembler,
    request: Option<Requested>,
    get_seq: u64,
    pending_apply: Option<ApplyJob>,
    waiters: HashMap<String, oneshot::Sender<TrafficOutcome>>,
    status_interval: Duration,
    status_due: Instant,
    last_seen: Instant,
    handshake_deadline: Instant,
    proactive_deadline: Option<Instant>,
    snapshot_timeout: Duration,
    failed_hold: Duration,
    token_deadline: Option<Instant>,
}

/// Runs one connection to completion. It returns when the connection ends, the
/// control plane replaces or disables the session, or `cancel` fires.
pub async fn run<W: Wire>(
    wire: &mut W,
    ports: &mut SessionPorts,
    identity: &HelloIdentity,
    timing: &SessionTiming,
    cancel: &CancellationToken,
) -> SessionEnd {
    let end = run_connection(wire, ports, identity, timing, cancel).await;
    // The session is over, so the traffic reports awaiting acknowledgement and
    // any queued apply belong to this connection and are dropped with it.
    let _ = ports.online.send(false);
    wire.close().await;
    end
}

async fn run_connection<W: Wire>(
    wire: &mut W,
    ports: &mut SessionPorts,
    identity: &HelloIdentity,
    timing: &SessionTiming,
    cancel: &CancellationToken,
) -> SessionEnd {
    let hello = build_hello(identity, &ports.status.borrow());
    if let Err(reason) = send(wire, "hello", &hello, None).await {
        return SessionEnd::Lost {
            reason,
            welcomed: false,
        };
    }

    let now = Instant::now();
    let token_deadline = wire.refresh_deadline();
    let mut state = State {
        welcomed: false,
        assembler: SnapshotAssembler::new(SnapshotLimits::negotiated(&default_limits())),
        request: None,
        get_seq: 0,
        pending_apply: None,
        waiters: HashMap::new(),
        status_interval: timing.default_status_interval,
        status_due: now + timing.default_status_interval,
        last_seen: now,
        handshake_deadline: now + timing.handshake,
        proactive_deadline: None,
        snapshot_timeout: timing.snapshot,
        failed_hold: timing.failed_apply_hold,
        token_deadline,
    };
    let mut frame_limit = MAX_FRAME_BYTES;
    let mut ping_tick = tokio::time::interval(timing.ping);
    ping_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping_tick.tick().await;

    let SessionPorts {
        status,
        apply,
        results,
        policy,
        refusals,
        traffic,
        commands,
        outbound,
        online,
        failed,
    } = ports;

    loop {
        let liveness_deadline = state.last_seen + liveness_window(timing, state.status_interval);
        let snapshot_deadline = state
            .request
            .as_ref()
            .filter(|requested| requested.awaiting_snapshot)
            .map(|requested| requested.at + timing.snapshot);
        let apply_ready = state.welcomed && state.pending_apply.is_some();
        let proactive = state.proactive_deadline;
        let status_due = state.status_due;

        tokio::select! {
            _ = cancel.cancelled() => return SessionEnd::Cancelled,
            _ = tokio::time::sleep_until(state.handshake_deadline), if !state.welcomed => {
                return SessionEnd::Lost {
                    reason: "no welcome before the handshake deadline".to_string(),
                    welcomed: false,
                };
            }
            _ = tokio::time::sleep_until(liveness_deadline), if state.welcomed => {
                return SessionEnd::Lost {
                    reason: "no traffic from the control plane within the liveness window".to_string(),
                    welcomed: true,
                };
            }
            _ = wait_for(proactive), if state.welcomed && proactive.is_some() => {
                return SessionEnd::Deadline;
            }
            _ = wait_for(snapshot_deadline), if snapshot_deadline.is_some() => {
                // The snapshot did not arrive in time. Report a receive failure;
                // the next status exchange asks again.
                if let Err(reason) = fail_snapshot(&mut state, wire, failed, "snapshot did not arrive before the deadline".to_string()).await {
                    return SessionEnd::Lost { reason, welcomed: state.welcomed };
                }
            }
            _ = ping_tick.tick() => {
                if let Err(error) = wire.ping().await {
                    return SessionEnd::Lost { reason: error.describe(), welcomed: state.welcomed };
                }
            }
            _ = tokio::time::sleep_until(status_due), if state.welcomed => {
                state.status_due = Instant::now() + state.status_interval;
                let payload = build_status(&status.borrow(), StatusReason::Interval);
                if let Err(reason) = send(wire, "agent.status", &payload, None).await {
                    return SessionEnd::Lost { reason, welcomed: true };
                }
            }
            changed = status.changed(), if state.welcomed => {
                if changed.is_err() {
                    return SessionEnd::Cancelled;
                }
                let payload = build_status(&status.borrow(), StatusReason::Change);
                if let Err(reason) = send(wire, "agent.status", &payload, None).await {
                    return SessionEnd::Lost { reason, welcomed: true };
                }
            }
            result = results.recv(), if state.welcomed => {
                let Some(result) = result else {
                    return SessionEnd::Cancelled;
                };
                if state.request.as_ref().is_some_and(|requested| requested.request_id == result.request_id) {
                    state.request = None;
                }
                failed.note(&result.desired, &result.outcome);
                if let Err(reason) = send_ack(wire, &result).await {
                    return SessionEnd::Lost { reason, welcomed: true };
                }
            }
            permit = apply.reserve(), if apply_ready => {
                let Ok(permit) = permit else {
                    return SessionEnd::Cancelled;
                };
                if let Some(job) = state.pending_apply.take() {
                    permit.send(job);
                }
            }
            request = traffic.recv(), if state.welcomed => {
                let Some(request) = request else {
                    return SessionEnd::Cancelled;
                };
                if request.reply.is_closed() {
                    continue;
                }
                let report_id = request.report.report_id.clone();
                state.waiters.insert(report_id, request.reply);
                if let Err(reason) = send(wire, "traffic.report", &request.report, None).await {
                    return SessionEnd::Lost { reason, welcomed: true };
                }
            }
            frame = outbound.recv(), if state.welcomed => {
                let Some(command) = frame else {
                    return SessionEnd::Cancelled;
                };
                let WsCommand::Send(frame) = command else {
                    continue;
                };
                if let Some((msg_type, payload)) = v2_outbound(&frame)
                    && let Err(reason) = send(wire, msg_type, &payload, None).await
                {
                    return SessionEnd::Lost { reason, welcomed: true };
                }
            }
            received = wire.recv_text() => {
                let text = match received {
                    Ok(text) => text,
                    Err(error) => {
                        return SessionEnd::Lost { reason: error.describe(), welcomed: state.welcomed };
                    }
                };
                state.last_seen = Instant::now();
                let decoded = match codec::decode(&text, Sender::ControlPlane, frame_limit) {
                    Ok(decoded) => decoded,
                    Err(DecodeError::UnsupportedVersion) => {
                        return SessionEnd::Protocol(
                            "control plane sent an unsupported envelope version".to_string(),
                        );
                    }
                    Err(error) => {
                        // A bad frame is answered and skipped; the connection stays up.
                        warn!("rejecting agent websocket v2 frame: {error}");
                        if let Some(code) = error.wire_code() {
                            let _ = send_error(wire, code, error_type(&error), error.to_string()).await;
                        }
                        continue;
                    }
                };
                let flow = handle(
                    decoded.message,
                    &mut state,
                    Context {
                        wire,
                        status,
                        policy,
                        refusals,
                        commands,
                        online,
                        frame_limit: &mut frame_limit,
                        failed: &mut *failed,
                    },
                )
                .await;
                match flow {
                    Ok(Flow::Continue) => {}
                    Ok(Flow::End(end)) => return end,
                    Err(reason) => return SessionEnd::Lost { reason, welcomed: state.welcomed },
                }
            }
        }
    }
}

enum Flow {
    Continue,
    End(SessionEnd),
}

struct Context<'a, W: Wire> {
    wire: &'a mut W,
    status: &'a mut watch::Receiver<CoreStatus>,
    policy: &'a mut watch::Sender<UpdatePolicy>,
    refusals: &'a mut mpsc::Sender<SnapshotRefusal>,
    commands: &'a mut mpsc::Sender<Command>,
    online: &'a mut watch::Sender<bool>,
    frame_limit: &'a mut usize,
    failed: &'a mut FailedApply,
}

async fn handle<W: Wire>(
    message: Message,
    state: &mut State,
    context: Context<'_, W>,
) -> Result<Flow, String> {
    let Context {
        wire,
        status,
        policy,
        refusals,
        commands,
        online,
        frame_limit,
        failed,
    } = context;
    match message {
        Message::Welcome(welcome) => {
            if state.welcomed {
                send_error(
                    wire,
                    ErrorCode::InvalidPayload,
                    Some("welcome"),
                    "welcome was already received".into(),
                )
                .await?;
                return Ok(Flow::Continue);
            }
            state.welcomed = true;
            *frame_limit = frame_limit_for(&welcome.limits);
            state.assembler = SnapshotAssembler::new(SnapshotLimits::negotiated(&welcome.limits));
            state.status_interval = Duration::from_secs(welcome.status_interval_seconds);
            state.status_due = Instant::now() + state.status_interval;
            state.proactive_deadline = welcome
                .reconnect_before_seconds
                .map(|seconds| Instant::now() + Duration::from_secs(seconds).mul_f64(0.9));
            state.proactive_deadline = earliest(state.proactive_deadline, state.token_deadline);
            let _ = policy.send_replace(welcome.update_policy);
            let _ = online.send(true);
            info!(
                server = %welcome.server_name,
                revision_seq = welcome.desired.desired_revision_seq,
                "agent websocket v2 welcomed"
            );
            let applied = status.borrow().applied.clone();
            let reason = if applied.is_none() {
                GetReason::Initial
            } else {
                GetReason::Mismatch
            };
            request_if_needed(
                &welcome.desired,
                applied.as_ref(),
                reason,
                state,
                failed,
                wire,
            )
            .await?;
        }
        Message::StatusAck(ack) => {
            require_welcome(state, wire, "agent.status.ack").await?;
            let _ = policy.send_replace(ack.update_policy);
            let applied = status.borrow().applied.clone();
            request_if_needed(
                &ack.desired,
                applied.as_ref(),
                GetReason::Mismatch,
                state,
                failed,
                wire,
            )
            .await?;
        }
        Message::ConfigNotify(ConfigNotify { desired, .. }) => {
            require_welcome(state, wire, "config.notify").await?;
            let applied = status.borrow().applied.clone();
            request_if_needed(
                &desired,
                applied.as_ref(),
                GetReason::Notify,
                state,
                failed,
                wire,
            )
            .await?;
        }
        Message::SnapshotBegin(begin) => {
            if !is_current(state, &begin.request_id) {
                debug!("ignoring a snapshot for a superseded request");
                return Ok(Flow::Continue);
            }
            if let Some(requested) = state.request.as_mut() {
                requested.announced = Some(begin.desired.clone());
            }
            if let Err(error) = state.assembler.begin(&begin) {
                fail_snapshot(state, wire, failed, error.describe()).await?;
            }
        }
        Message::SnapshotChunk(chunk) => {
            if is_current(state, &chunk.request_id) {
                match state.assembler.chunk(&chunk) {
                    Ok(()) => {}
                    Err(SnapshotError::UnknownRequest) => {}
                    Err(error) => fail_snapshot(state, wire, failed, error.describe()).await?,
                }
            }
        }
        Message::SnapshotEnd(end) => {
            if is_current(state, &end.request_id) {
                match state.assembler.end(&end) {
                    Ok(verified) => queue_apply(state, verified),
                    Err(SnapshotError::UnknownRequest) => {}
                    Err(error) => fail_snapshot(state, wire, failed, error.describe()).await?,
                }
            }
        }
        Message::SnapshotError(refused) => {
            if is_current(state, &refused.request_id) {
                state.assembler.discard();
                let requested = state.request.take();
                warn!("control plane refused the configuration snapshot");
                if let Some(requested) = requested {
                    let desired = requested.announced.unwrap_or(requested.asked_for);
                    failed.note(
                        &desired,
                        &ApplyOutcome::Failed {
                            stage: AckStage::Receive,
                            error: refused.message.clone(),
                        },
                    );
                }
                let _ = refusals.try_send(SnapshotRefusal {
                    code: snapshot_error_code(refused.code),
                    message: refused.message,
                });
            }
        }
        Message::TrafficAck(ack) => {
            if let Some(waiter) = state.waiters.remove(&ack.report_id) {
                let outcome = match ack.result {
                    TrafficResult::Conflict => {
                        TrafficOutcome::Conflict(ack.error.unwrap_or_else(|| {
                            "traffic report id reused with other content".into()
                        }))
                    }
                    TrafficResult::Applied | TrafficResult::Duplicate => TrafficOutcome::Accepted,
                };
                let _ = waiter.send(outcome);
            }
        }
        Message::UpdateTrigger(trigger) => {
            require_welcome(state, wire, "update.trigger").await?;
            let _ = commands.try_send(Command::UpdateTrigger(trigger));
        }
        Message::AcmeIssue(issue) => {
            require_welcome(state, wire, "acme.issue").await?;
            let _ = commands.try_send(Command::AcmeIssue(issue));
        }
        Message::AcmeDnsAck(ack) => {
            require_welcome(state, wire, "acme.dns_ack").await?;
            let _ = commands.try_send(Command::AcmeDnsAck(ack));
        }
        Message::PtyOpen(open) => {
            require_welcome(state, wire, "pty.open").await?;
            forward_pty(commands, frame_type::PTY_OPEN, open)?;
        }
        Message::PtyData(data) => {
            require_welcome(state, wire, "pty.data").await?;
            forward_pty(commands, frame_type::PTY_DATA, data)?;
        }
        Message::PtyResize(resize) => {
            require_welcome(state, wire, "pty.resize").await?;
            forward_pty(commands, frame_type::PTY_RESIZE, resize)?;
        }
        Message::PtyClose(close) => {
            require_welcome(state, wire, "pty.close").await?;
            forward_pty(commands, frame_type::PTY_CLOSE, close)?;
        }
        Message::Error(frame) => match frame.code {
            ErrorCode::SessionReplaced => return Ok(Flow::End(SessionEnd::Replaced)),
            ErrorCode::ServerDisabled => return Ok(Flow::End(SessionEnd::ServerDisabled)),
            // The error names no report id. Reports are sent one at a time, so
            // every waiter is the report that was refused.
            ErrorCode::InvalidPayload if frame.r#type.as_deref() == Some("traffic.report") => {
                for (_, waiter) in state.waiters.drain() {
                    let _ = waiter.send(TrafficOutcome::Rejected(frame.message.clone()));
                }
            }
            other => {
                warn!(code = ?other, "control plane rejected an agent frame: {}", frame.message)
            }
        },
        Message::Hello(_)
        | Message::StatusReport(_)
        | Message::ConfigGet(_)
        | Message::ConfigAck(_)
        | Message::TrafficReport(_)
        | Message::UpdateStatus(_)
        | Message::AcmeDnsPresent(_)
        | Message::AcmeDnsCleanup(_)
        | Message::AcmeResult(_)
        | Message::PtyStarted(_)
        | Message::PtyExit(_)
        | Message::Unknown(_) => {}
    }
    Ok(Flow::Continue)
}

fn forward_pty<T: Serialize>(
    commands: &mpsc::Sender<Command>,
    msg_type: &'static str,
    payload: T,
) -> Result<(), String> {
    let value = serde_json::to_value(payload)
        .map_err(|error| format!("could not encode {msg_type}: {error}"))?;
    let _ = commands.try_send(Command::Pty(ReservedFrame {
        frame_type: msg_type.to_string(),
        payload: value,
    }));
    Ok(())
}

/// Converts the core's v1-shaped outbound frames into the v2 frame types the
/// contract serves. Unsupported types are ignored rather than copied.
fn v2_outbound(frame: &AgentWsFrame) -> Option<(&'static str, serde_json::Value)> {
    let msg_type = match frame.msg_type.as_str() {
        "update.status" => "update.status",
        "acme.dns_present" => "acme.dns_present",
        "acme.dns_cleanup" => "acme.dns_cleanup",
        "acme.result" => "acme.result",
        "pty.started" => "pty.started",
        "pty.data" => "pty.data",
        "pty.exit" => "pty.exit",
        _ => return None,
    };
    Some((msg_type, frame.payload.clone()))
}

/// Hands a verified body to the core. A job the core has not taken yet is
/// replaced, so the core only ever sees the newest verified body.
fn queue_apply(state: &mut State, verified: VerifiedSnapshot) {
    if let Some(requested) = state.request.as_mut() {
        requested.awaiting_snapshot = false;
    }
    state.pending_apply = Some(ApplyJob {
        request_id: verified.request_id,
        desired: verified.desired,
        body: verified.body,
    });
}

/// Reports a receive-stage failure for the snapshot in flight and drops it.
async fn fail_snapshot<W: Wire>(
    state: &mut State,
    wire: &mut W,
    failed: &mut FailedApply,
    error: String,
) -> Result<(), String> {
    state.assembler.discard();
    let Some(requested) = state.request.take() else {
        return Ok(());
    };
    let result = ApplyResult {
        request_id: requested.request_id,
        desired: requested.announced.unwrap_or(requested.asked_for),
        outcome: ApplyOutcome::Failed {
            stage: AckStage::Receive,
            error,
        },
    };
    failed.note(&result.desired, &result.outcome);
    send_ack(wire, &result).await
}

fn is_current(state: &State, request_id: &str) -> bool {
    state
        .request
        .as_ref()
        .is_some_and(|requested| requested.request_id == request_id)
}

async fn require_welcome<W: Wire>(
    state: &State,
    wire: &mut W,
    message_type: &str,
) -> Result<(), String> {
    if state.welcomed {
        return Ok(());
    }
    let _ = send_error(
        wire,
        ErrorCode::InvalidPayload,
        Some(message_type),
        "hello must precede other messages".into(),
    )
    .await;
    Err(format!("{message_type} arrived before welcome"))
}

/// Requests a snapshot when `desired` differs from the applied identifier. A
/// request already in flight for the same identifier is not repeated, unless
/// it has outlived the snapshot deadline.
async fn request_if_needed<W: Wire>(
    desired: &ConfigIdentifier,
    applied: Option<&ConfigIdentifier>,
    reason: GetReason,
    state: &mut State,
    failed: &FailedApply,
    wire: &mut W,
) -> Result<(), String> {
    if applied == Some(desired) || failed.holds(desired, state.failed_hold) {
        return Ok(());
    }
    if let Some(requested) = state.request.as_ref()
        && requested.asked_for == *desired
        && requested.at.elapsed() < state.snapshot_timeout
    {
        return Ok(());
    }
    state.get_seq += 1;
    let request_id = format!("snap-{}", state.get_seq);
    state.request = Some(Requested {
        request_id: request_id.clone(),
        asked_for: desired.clone(),
        announced: None,
        awaiting_snapshot: true,
        at: Instant::now(),
    });
    send(wire, "config.get", &ConfigGet { request_id, reason }, None).await
}

async fn send_ack<W: Wire>(wire: &mut W, result: &ApplyResult) -> Result<(), String> {
    let (outcome, stage, error) = match &result.outcome {
        ApplyOutcome::Applied => (AckOutcome::Applied, None, None),
        ApplyOutcome::Failed { stage, error } => {
            (AckOutcome::Failed, Some(*stage), Some(error.clone()))
        }
    };
    let ack = ConfigAck {
        request_id: Some(result.request_id.clone()),
        desired: result.desired.clone(),
        outcome,
        stage,
        error,
    };
    send(wire, "config.ack", &ack, None).await
}

async fn send_error<W: Wire>(
    wire: &mut W,
    code: ErrorCode,
    message_type: Option<&str>,
    message: String,
) -> Result<(), String> {
    let frame = ErrorFrame {
        code,
        r#type: message_type.map(str::to_owned),
        request_id: None,
        message,
    };
    send(wire, "error", &frame, None).await
}

async fn send<W: Wire, P: Serialize>(
    wire: &mut W,
    message_type: &str,
    payload: &P,
    id: Option<&str>,
) -> Result<(), String> {
    let text = codec::encode(message_type, payload, id).map_err(|error| error.to_string())?;
    wire.send_text(text).await.map_err(|error| error.describe())
}

fn build_hello(identity: &HelloIdentity, status: &CoreStatus) -> Hello {
    Hello {
        agent_version: identity.agent_version.clone(),
        agent_build_id: identity.agent_build_id.clone(),
        capabilities: identity.capabilities.clone(),
        applied: status.applied.clone(),
        certificate_deployments: status.deployments.clone(),
        updates: Some(status.updates.clone()),
    }
}

fn build_status(status: &CoreStatus, reason: StatusReason) -> StatusReport {
    StatusReport {
        reason,
        runtime_state: Some(status.runtime_state),
        config_state: Some(status.config_state),
        sing_box_version: status.sing_box_version.clone(),
        active_node_ids: Some(status.active_node_ids.clone()),
        // `Some(None)` clears the last error on the control plane.
        error: Some(status.error.clone()),
        certificate_deployments: status.deployments.clone(),
        updates: Some(status.updates.clone()),
    }
}

fn liveness_window(timing: &SessionTiming, status_interval: Duration) -> Duration {
    timing.liveness.max(status_interval * 3)
}

fn frame_limit_for(limits: &Limits) -> usize {
    usize::try_from(limits.max_frame_bytes)
        .unwrap_or(usize::MAX)
        .min(MAX_FRAME_BYTES)
}

/// Limits assumed before `welcome`: only the compile-time ceilings apply.
fn default_limits() -> Limits {
    Limits {
        max_frame_bytes: MAX_FRAME_BYTES as u64,
        snapshot_chunk_bytes: codec::SNAPSHOT_CHUNK_BYTES as u64,
        max_snapshot_bytes: codec::MAX_SNAPSHOT_BYTES as u64,
    }
}

fn error_type(error: &DecodeError) -> Option<&str> {
    match error {
        DecodeError::InvalidDirection(message_type) | DecodeError::InvalidPayload(message_type) => {
            Some(message_type.as_str())
        }
        _ => None,
    }
}

fn snapshot_error_code(code: codec::SnapshotErrorCode) -> String {
    match code {
        codec::SnapshotErrorCode::SnapshotTooLarge => "snapshot_too_large",
        codec::SnapshotErrorCode::Unavailable => "unavailable",
        codec::SnapshotErrorCode::Internal => "internal",
    }
    .to_string()
}

async fn wait_for(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// The earlier of two optional deadlines, treating an absent one as absent.
fn earliest(left: Option<Instant>, right: Option<Instant>) -> Option<Instant> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (Some(deadline), None) | (None, Some(deadline)) => Some(deadline),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests;
