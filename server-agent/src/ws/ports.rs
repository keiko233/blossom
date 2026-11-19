//! Consumer-owned ports for the agent WebSocket transport.
//!
//! [`WsTransport`] / [`WsConnection`] sit at the network boundary so the
//! reconnect and dispatch state machine in [`super`] can be driven by
//! deterministic in-memory fakes. [`AgentCommandSink`] is the narrow,
//! non-blocking handle other subsystems use to enqueue outbound frames without
//! owning the socket. The queue is bounded, so a stalled link applies
//! backpressure instead of growing memory without limit.

use std::future::Future;
use std::time::Duration;

use tokio::sync::mpsc;

use super::codec::{AgentMessage, AgentWsFrame, WelcomePayload};

/// A failure at the WebSocket boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WsError {
    /// The upgrade was refused with an HTTP status (404/426/501 from an older
    /// control plane or a proxy that does not forward upgrades).
    Rejected { status: u16 },
    /// The credential is valid, but the authoritative control plane confirmed
    /// the server is disabled. This is the only positive disablement signal.
    ServerDisabled { status: u16 },
    /// TCP/TLS/WebSocket I/O failed before or during the session.
    Io(String),
    /// The peer violated the protocol (bad frame, bad UTF-8, oversized message).
    Protocol(String),
    /// The connection closed, normally or otherwise.
    Closed,
    /// The bounded outbound queue is full; the caller may retry later.
    QueueFull,
    /// The upgrade succeeded but the control plane did not echo the required
    /// subprotocol, so it does not speak it (an older control plane, or a
    /// proxy that strips the header).
    SubprotocolMismatch,
    /// A machine access token could not be obtained. The agent keeps its
    /// last-known-good configuration and retries with bounded backoff.
    Auth(String),
}

impl WsError {
    /// Statuses that mean "this control plane or proxy cannot do WebSockets",
    /// where retrying immediately is pointless and HTTP fallback should be
    /// announced at once.
    pub fn is_hard_rejection(&self) -> bool {
        matches!(
            self,
            Self::Rejected { status } if matches!(status, 400 | 403 | 404 | 426 | 501)
        )
    }

    pub fn describe(&self) -> String {
        match self {
            Self::Rejected { status } => format!("upgrade rejected with HTTP {status}"),
            Self::ServerDisabled { status } => {
                format!("control plane confirmed the server is disabled with HTTP {status}")
            }
            Self::Io(message) => format!("websocket I/O error: {message}"),
            Self::Protocol(message) => format!("websocket protocol error: {message}"),
            Self::Closed => "websocket closed".to_string(),
            Self::QueueFull => "outbound websocket queue is full".to_string(),
            Self::SubprotocolMismatch => {
                "control plane did not accept the required websocket subprotocol".to_string()
            }
            Self::Auth(message) => format!("agent authentication unavailable: {message}"),
        }
    }
}

impl std::fmt::Display for WsError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.describe())
    }
}

impl std::error::Error for WsError {}

/// An outbound instruction for the connection task.
#[derive(Debug, Clone, PartialEq)]
pub enum WsCommand {
    Send(AgentWsFrame),
    /// Close the current session and stop reconnecting.
    Close,
}

/// Something the connection task observed, delivered to the agent's main loop.
#[derive(Debug, Clone, PartialEq)]
pub enum WsEvent {
    /// A `welcome` frame completed the handshake; carries negotiated policy.
    Connected { welcome: WelcomePayload },
    /// A decoded frame that the main loop must act on.
    Frame(AgentMessage),
    /// The session ended; a reconnect (or fallback) follows.
    Disconnected { reason: String },
    /// WebSockets are not usable right now; keep the HTTP poll/heartbeat path.
    Fallback { reason: String },
    /// A session recovered after a fallback streak.
    Recovered,
}

/// A source of connections.
pub trait WsTransport: Send {
    type Connection: WsConnection;

    fn connect(&self) -> impl Future<Output = Result<Self::Connection, WsError>> + Send;
}

/// One live WebSocket session.
pub trait WsConnection: Send {
    fn recv(&mut self) -> impl Future<Output = Result<AgentWsFrame, WsError>> + Send;
    fn send(&mut self, frame: AgentWsFrame) -> impl Future<Output = Result<(), WsError>> + Send;
    fn close(&mut self) -> impl Future<Output = ()> + Send;
}

/// Non-blocking outbound queue shared with the config/update reconcilers.
pub trait AgentCommandSink: Send + Sync {
    fn enqueue(&self, command: WsCommand) -> Result<(), WsError>;
}

/// [`AgentCommandSink`] backed by a bounded Tokio channel.
#[derive(Debug, Clone)]
pub struct ChannelCommandSink {
    sender: mpsc::Sender<WsCommand>,
}

impl ChannelCommandSink {
    pub fn new(sender: mpsc::Sender<WsCommand>) -> Self {
        Self { sender }
    }
}

impl AgentCommandSink for ChannelCommandSink {
    fn enqueue(&self, command: WsCommand) -> Result<(), WsError> {
        self.sender.try_send(command).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => WsError::QueueFull,
            mpsc::error::TrySendError::Closed(_) => WsError::Closed,
        })
    }
}

/// Creates a bounded command queue and its receiving half.
pub fn command_channel(capacity: usize) -> (ChannelCommandSink, mpsc::Receiver<WsCommand>) {
    let (sender, receiver) = mpsc::channel(capacity);
    (ChannelCommandSink::new(sender), receiver)
}

/// The reconnect ladder from the redesign: 1s -> 2s -> 5s -> 15s -> 30s.
pub const BACKOFF_SCHEDULE: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(15),
    Duration::from_secs(30),
];

/// Consecutive non-rejection failures tolerated before announcing fallback.
pub const FALLBACK_AFTER_FAILURES: u32 = 3;

/// Exponential backoff with jitter.
///
/// The schedule is fixed; `jitter` is a ratio in `[0, 1)` supplied by the
/// caller (the real transport draws it from the OS CSPRNG) so the state
/// machine stays deterministic under test. Each delay lands in
/// `[base / 2, base)`.
#[derive(Debug, Default, Clone)]
pub struct Backoff {
    attempt: usize,
}

impl Backoff {
    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    #[cfg(test)]
    fn attempt(&self) -> usize {
        self.attempt
    }

    /// Returns the next delay and advances the ladder.
    pub fn next_delay(&mut self, jitter: f64) -> Duration {
        let base = BACKOFF_SCHEDULE[self.attempt.min(BACKOFF_SCHEDULE.len() - 1)];
        self.attempt = (self.attempt + 1).min(BACKOFF_SCHEDULE.len() - 1);
        let jitter = jitter.clamp(0.0, 0.999_999);
        base.mul_f64(0.5 + jitter / 2.0)
    }
}

/// What to do after a failed attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconnectOutcome {
    /// Retry after the backoff delay.
    Retry,
    /// Announce HTTP fallback (and keep retrying at the cap).
    Fallback,
}

/// Decides when a failure streak is bad enough to surface fallback.
#[derive(Debug)]
pub struct ReconnectPolicy {
    consecutive_failures: u32,
    announced_fallback: bool,
    fallback_threshold: u32,
}

impl Default for ReconnectPolicy {
    fn default() -> Self {
        Self::new(FALLBACK_AFTER_FAILURES)
    }
}

impl ReconnectPolicy {
    pub fn new(fallback_threshold: u32) -> Self {
        Self {
            consecutive_failures: 0,
            announced_fallback: false,
            fallback_threshold: fallback_threshold.max(1),
        }
    }

    pub fn record_failure(&mut self, error: &WsError) -> ReconnectOutcome {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        let threshold_reached = self.consecutive_failures >= self.fallback_threshold;
        if (error.is_hard_rejection() || threshold_reached) && !self.announced_fallback {
            self.announced_fallback = true;
            return ReconnectOutcome::Fallback;
        }
        ReconnectOutcome::Retry
    }

    /// Returns true when this success ends a fallback streak.
    pub fn record_success(&mut self) -> bool {
        let recovered = self.announced_fallback;
        self.consecutive_failures = 0;
        self.announced_fallback = false;
        recovered
    }

    #[cfg(test)]
    fn in_fallback(&self) -> bool {
        self.announced_fallback
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{
        AgentCommandSink as _, BACKOFF_SCHEDULE, Backoff, ReconnectOutcome, ReconnectPolicy,
        WsCommand, WsError, command_channel,
    };
    use crate::ws::codec::{AgentWsFrame, PingPayload, frame_type};

    #[test]
    fn backoff_follows_the_documented_ladder() {
        let mut backoff = Backoff::default();
        let delays: Vec<Duration> = (0..6).map(|_| backoff.next_delay(0.0)).collect();
        assert_eq!(delays[0], Duration::from_millis(500));
        assert_eq!(delays[1], Duration::from_secs(1));
        assert_eq!(delays[2], Duration::from_millis(2_500));
        assert_eq!(delays[3], Duration::from_millis(7_500));
        assert_eq!(delays[4], Duration::from_secs(15));
        assert_eq!(delays[5], Duration::from_secs(15));
        assert_eq!(backoff.attempt(), BACKOFF_SCHEDULE.len() - 1);

        backoff.reset();
        assert_eq!(backoff.next_delay(0.0), Duration::from_millis(500));
    }

    #[test]
    fn jitter_stays_below_the_base_delay() {
        let mut backoff = Backoff::default();
        let low = backoff.next_delay(0.0);
        backoff.reset();
        let high = backoff.next_delay(0.999_999);
        assert!(low < high);
        assert!(high < Duration::from_secs(1));
    }

    #[test]
    fn hard_rejection_announces_fallback_immediately() {
        let mut policy = ReconnectPolicy::default();
        assert_eq!(
            policy.record_failure(&WsError::Rejected { status: 426 }),
            ReconnectOutcome::Fallback
        );
        assert!(policy.in_fallback());
        assert_eq!(
            policy.record_failure(&WsError::Rejected { status: 426 }),
            ReconnectOutcome::Retry
        );
        assert!(policy.record_success());
        assert!(!policy.in_fallback());
        assert!(!policy.record_success());
    }

    #[test]
    fn transient_failures_fall_back_after_the_threshold() {
        let mut policy = ReconnectPolicy::default();
        let error = WsError::Io("connection reset".into());
        assert_eq!(policy.record_failure(&error), ReconnectOutcome::Retry);
        assert_eq!(policy.record_failure(&error), ReconnectOutcome::Retry);
        assert_eq!(policy.record_failure(&error), ReconnectOutcome::Fallback);
        assert_eq!(policy.record_failure(&error), ReconnectOutcome::Retry);
    }

    #[tokio::test]
    async fn bounded_command_queue_reports_backpressure() {
        let (sink, mut receiver) = command_channel(1);
        let frame = AgentWsFrame::new(frame_type::PING, PingPayload::default()).unwrap();
        assert!(sink.enqueue(WsCommand::Send(frame.clone())).is_ok());
        assert_eq!(
            sink.enqueue(WsCommand::Send(frame.clone())),
            Err(WsError::QueueFull)
        );
        assert_eq!(receiver.recv().await, Some(WsCommand::Send(frame)));
        drop(receiver);
        assert_eq!(sink.enqueue(WsCommand::Close), Err(WsError::Closed));
    }
}
