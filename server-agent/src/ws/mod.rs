//! Agent WebSocket transport: codec, ports, adapter and the reconnect loop.
//!
//! The loop owns one outbound connection at a time. It sends `hello` on every
//! connect, waits for `welcome`, answers keepalive pings, forwards decoded
//! frames to the agent's main loop, and reconnects with jittered exponential
//! backoff. When the control plane asks the agent to reconnect before a
//! serverless function's `maxDuration` (`welcome.reconnectBeforeSeconds`), the
//! loop closes the session proactively and reconnects immediately.
//!
//! Repeated failures (or an upgrade rejected with 400/403/404/426/501) emit a
//! [`WsEvent::Fallback`] so the agent announces that it is running on the HTTP
//! poll/heartbeat path instead of pretending the push channel works.

pub mod adapters;
pub mod codec;
pub mod ports;
pub mod v2;

use std::time::Duration;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use self::codec::{
    AgentMessage, AgentWsFrame, HelloPayload, PingPayload, WelcomePayload, frame_type,
};
use self::ports::{
    AgentCommandSink, Backoff, ReconnectOutcome, ReconnectPolicy, WsCommand, WsConnection, WsError,
    WsEvent, WsTransport,
};

/// Default keepalive cadence until `welcome` sets the heartbeat interval.
const DEFAULT_KEEPALIVE: Duration = Duration::from_secs(25);
/// Keepalive bounds, mirroring the control plane's heartbeat clamp.
const MIN_KEEPALIVE: Duration = Duration::from_secs(5);
const MAX_KEEPALIVE: Duration = Duration::from_secs(30);
/// Cap on the proactive reconnect hint; a serverless function never runs longer
/// than this in the supported targets, and a bogus hint must not pin us open.
const MAX_PROACTIVE_RECONNECT: Duration = Duration::from_secs(800);

/// Supplies the current `hello` payload on every (re)connect so a reconnect
/// always carries the freshest applied revision, deployments and update state.
pub trait HelloSource: Send + Sync {
    fn hello(&self) -> HelloPayload;
}

impl<F> HelloSource for F
where
    F: Fn() -> HelloPayload + Send + Sync,
{
    fn hello(&self) -> HelloPayload {
        self()
    }
}

/// Draws the backoff jitter ratio in `[0, 1)`.
pub trait Jitter: Send + Sync {
    fn next(&self) -> f64;
}

/// CSPRNG-backed jitter.
#[derive(Debug, Default, Clone, Copy)]
pub struct RandomJitter;

impl Jitter for RandomJitter {
    fn next(&self) -> f64 {
        let mut bytes = [0u8; 8];
        if getrandom::fill(&mut bytes).is_err() {
            return 0.5;
        }
        let value = u64::from_le_bytes(bytes);
        (value as f64) / (u64::MAX as f64 + 1.0)
    }
}

/// Runs the reconnect loop until `cancel` fires.
///
/// Events are delivered to `events`; outbound frames come from `commands`.
/// The loop stops when cancelled, when the command channel closes, or when a
/// [`WsCommand::Close`] arrives.
pub async fn run<T, H, J>(
    transport: T,
    hello: H,
    jitter: J,
    events: mpsc::Sender<WsEvent>,
    mut commands: mpsc::Receiver<WsCommand>,
    cancel: CancellationToken,
) where
    T: WsTransport,
    H: HelloSource,
    J: Jitter,
{
    let mut backoff = Backoff::default();
    let mut policy = ReconnectPolicy::default();

    loop {
        if cancel.is_cancelled() {
            return;
        }
        match transport.connect().await {
            Ok(mut connection) => {
                match session(
                    &mut connection,
                    &hello,
                    &mut commands,
                    &events,
                    &cancel,
                    &mut policy,
                )
                .await
                {
                    SessionEnd::Cancelled | SessionEnd::Shutdown => {
                        connection.close().await;
                        return;
                    }
                    SessionEnd::Closed {
                        reason,
                        established,
                    } => {
                        connection.close().await;
                        if established {
                            backoff.reset();
                        } else {
                            // A peer that upgrades and then closes before
                            // `welcome` must keep backing off instead of
                            // spinning, and counts toward fallback.
                            let outcome = policy.record_failure(&WsError::Closed);
                            if outcome == ReconnectOutcome::Fallback {
                                warn!(
                                    "agent websocket keeps closing before welcome; continuing on HTTP poll/heartbeat"
                                );
                                let _ = events
                                    .send(WsEvent::Fallback {
                                        reason: reason.clone(),
                                    })
                                    .await;
                            }
                        }
                        debug!("agent websocket closed: {reason}");
                        let _ = events.send(WsEvent::Disconnected { reason }).await;
                    }
                }
            }
            Err(error) => {
                let outcome = policy.record_failure(&error);
                if outcome == ReconnectOutcome::Fallback {
                    warn!(
                        "agent websocket unavailable ({}); continuing on HTTP poll/heartbeat",
                        error.describe()
                    );
                    let _ = events
                        .send(WsEvent::Fallback {
                            reason: error.describe(),
                        })
                        .await;
                } else {
                    debug!("agent websocket connect failed: {}", error.describe());
                }
            }
        }

        let delay = backoff.next_delay(jitter.next());
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(delay) => {}
            command = commands.recv() => {
                if matches!(command, None | Some(WsCommand::Close)) {
                    return;
                }
            }
        }
    }
}

enum SessionEnd {
    Closed {
        reason: String,
        /// True when `welcome` arrived, i.e. the handshake completed.
        established: bool,
    },
    Cancelled,
    Shutdown,
}

async fn session<C, H>(
    connection: &mut C,
    hello: &H,
    commands: &mut mpsc::Receiver<WsCommand>,
    events: &mpsc::Sender<WsEvent>,
    cancel: &CancellationToken,
    policy: &mut ReconnectPolicy,
) -> SessionEnd
where
    C: WsConnection,
    H: HelloSource,
{
    let hello_frame = match AgentWsFrame::new(frame_type::HELLO, hello.hello()) {
        Ok(frame) => frame,
        Err(error) => {
            return SessionEnd::Closed {
                reason: error.to_string(),
                established: false,
            };
        }
    };
    if let Err(error) = connection.send(hello_frame).await {
        return SessionEnd::Closed {
            reason: error.describe(),
            established: false,
        };
    }

    let mut keepalive = tokio::time::interval(DEFAULT_KEEPALIVE);
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    keepalive.tick().await;
    let proactive = tokio::time::sleep(MAX_PROACTIVE_RECONNECT);
    tokio::pin!(proactive);
    let mut proactive_armed = false;
    let mut nonce: u64 = 0;
    let mut established = false;
    #[cfg(target_os = "linux")]
    let mut telemetry = crate::telemetry::Collector::default();

    loop {
        tokio::select! {
            _ = cancel.cancelled() => return SessionEnd::Cancelled,
            _ = &mut proactive, if proactive_armed => {
                return SessionEnd::Closed {
                    reason: "reconnecting before the serverless connection deadline".to_string(),
                    established,
                };
            }
            _ = keepalive.tick() => {
                nonce = nonce.wrapping_add(1);
                let ping = AgentWsFrame::new(
                    frame_type::PING,
                    PingPayload { nonce: Some(format!("ka-{nonce}")) },
                );
                match ping {
                    Ok(frame) => {
                        if let Err(error) = connection.send(frame).await {
                            return SessionEnd::Closed { reason: error.describe(), established };
                        }
                    }
                    Err(error) => {
                        return SessionEnd::Closed { reason: error.to_string(), established };
                    }
                }
            }
            command = commands.recv() => {
                match command {
                    Some(WsCommand::Send(frame)) => {
                        if let Err(error) = connection.send(frame).await {
                            return SessionEnd::Closed { reason: error.describe(), established };
                        }
                    }
                    Some(WsCommand::Close) | None => {
                        return SessionEnd::Shutdown;
                    }
                }
            }
            received = connection.recv() => {
                let frame = match received {
                    Ok(frame) => frame,
                    Err(error) => {
                        return SessionEnd::Closed { reason: error.describe(), established };
                    }
                };
                let message = match frame.message() {
                    Ok(message) => message,
                    Err(error) => {
                        // A single malformed frame must not kill the channel;
                        // the next frame may be fine.
                        warn!("ignoring malformed agent websocket frame: {error}");
                        continue;
                    }
                };
                match message {
                    AgentMessage::Welcome(welcome) => {
                        established = true;
                        // A completed handshake proves the channel works.
                        if policy.record_success() {
                            info!("agent websocket transport recovered");
                            if events.send(WsEvent::Recovered).await.is_err() {
                                return SessionEnd::Shutdown;
                            }
                        }
                        let deadline = proactive_deadline(&welcome);
                        if let Some(deadline) = deadline {
                            proactive
                                .as_mut()
                                .reset(tokio::time::Instant::now() + deadline);
                            proactive_armed = true;
                        }
                        keepalive = keepalive_for(&welcome);
                        keepalive.tick().await;
                        if events.send(WsEvent::Connected { welcome }).await.is_err() {
                            return SessionEnd::Shutdown;
                        }
                    }
                    AgentMessage::Ping(ping) => {
                        let pong = AgentWsFrame::reply(
                            frame_type::PONG,
                            frame.id.clone(),
                            ping,
                        );
                        match pong {
                            Ok(frame) => {
                                if let Err(error) = connection.send(frame).await {
                                    return SessionEnd::Closed { reason: error.describe(), established };
                                }
                            }
                            Err(error) => {
                                return SessionEnd::Closed { reason: error.to_string(), established };
                            }
                        }
                    }
                    AgentMessage::Pong(_) => {}
                    #[cfg(target_os = "linux")]
                    AgentMessage::Telemetry(request) if established => {
                        if let Some(reply) = telemetry.reply(request).await
                            && let Err(error) = connection.send(reply).await
                        {
                            return SessionEnd::Closed { reason: error.describe(), established };
                        }
                    }
                    other => {
                        if events.send(WsEvent::Frame(other)).await.is_err() {
                            return SessionEnd::Shutdown;
                        }
                    }
                }
            }
        }
    }
}

fn keepalive_for(welcome: &WelcomePayload) -> tokio::time::Interval {
    let interval =
        Duration::from_secs(welcome.heartbeat_interval_seconds).clamp(MIN_KEEPALIVE, MAX_KEEPALIVE);
    let mut keepalive = tokio::time::interval(interval);
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    keepalive
}

fn proactive_deadline(welcome: &WelcomePayload) -> Option<Duration> {
    let seconds = welcome.reconnect_before_seconds?;
    if seconds == 0 {
        return None;
    }
    Some(Duration::from_secs(seconds).min(MAX_PROACTIVE_RECONNECT))
}

/// Convenience: enqueue a frame through any sink, logging backpressure once.
pub fn enqueue_frame(sink: &dyn AgentCommandSink, frame: AgentWsFrame) {
    if let Err(error) = sink.enqueue(WsCommand::Send(frame)) {
        debug!("dropped outbound websocket frame: {error}");
    }
}

#[cfg(test)]
mod tests;
