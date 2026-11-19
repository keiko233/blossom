//! Keeps one protocol v2 connection alive: connect under a deadline, run the
//! session, and reconnect with jittered backoff.
//!
//! The loop never falls back to HTTP. While it is disconnected the agent keeps
//! running its last applied configuration, and it keeps retrying on the
//! configured transport. Each end reason picks a delay:
//!
//! - a welcomed session that ends restarts the ladder at one second;
//! - `session_replaced` reconnects almost at once, since a newer session exists;
//! - `server_disabled` waits about a minute, so a disabled server is not hammered;
//! - a proactive deadline from `welcome` reconnects immediately;
//! - anything else climbs the ladder from one second to a one-minute ceiling.
//!
//! Every delay is drawn into `[base / 2, base)` from the jitter source.

use std::future::Future;
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use super::adapter::V2Connector;
use super::session::{self, HelloIdentity, SessionEnd, SessionPorts, SessionTiming, Wire};
use crate::logs::LogStore;
use super::telemetry;
use crate::ws::Jitter;
use crate::ws::ports::WsError;

/// Opens one connection. The production implementation is [`V2Connector`].
pub trait Connector: Send + Sync {
    type Wire: Wire;

    fn connect(&self) -> impl Future<Output = Result<Self::Wire, WsError>> + Send;
}

impl Connector for V2Connector {
    type Wire = super::adapter::V2Connection;

    async fn connect(&self) -> Result<Self::Wire, WsError> {
        V2Connector::connect(self).await
    }
}

/// Reconnect delays. The defaults are the contract's: one second up to a
/// one-minute ceiling, with a longer wait after a disabled server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkOptions {
    pub identity: HelloIdentity,
    pub timing: SessionTiming,
    pub backoff_initial: Duration,
    pub backoff_max: Duration,
    pub disabled_delay: Duration,
}

impl LinkOptions {
    pub fn new(identity: HelloIdentity) -> Self {
        Self {
            identity,
            timing: SessionTiming::default(),
            backoff_initial: Duration::from_secs(1),
            backoff_max: Duration::from_secs(60),
            disabled_delay: Duration::from_secs(60),
        }
    }
}

/// The exponential ladder with jitter. `reset` restarts it after a session
/// that completed its handshake.
#[derive(Debug, Clone)]
pub struct ReconnectBackoff {
    initial: Duration,
    max: Duration,
    attempt: u32,
}

impl ReconnectBackoff {
    pub fn new(initial: Duration, max: Duration) -> Self {
        Self {
            initial,
            max,
            attempt: 0,
        }
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    /// Returns the next delay, drawn from `[base / 2, base)` where `base` is
    /// `initial * 2^attempt` capped at `max`.
    pub fn next_delay(&mut self, jitter: f64) -> Duration {
        let factor = 1u32.checked_shl(self.attempt).unwrap_or(u32::MAX);
        let base = self.initial.saturating_mul(factor).min(self.max);
        self.attempt = (self.attempt + 1).min(16);
        jittered(base, jitter)
    }
}

/// Draws a delay from `[base / 2, base)`.
fn jittered(base: Duration, jitter: f64) -> Duration {
    base.mul_f64(0.5 + jitter.clamp(0.0, 0.999_999) / 2.0)
}

/// Runs the connection loop until `cancel` fires.
pub async fn run<C, J>(
    connector: &C,
    ports: &mut SessionPorts,
    options: &LinkOptions,
    jitter: &J,
    cancel: &CancellationToken,
    store: &LogStore,
) where
    C: Connector,
    J: Jitter,
{
    let mut backoff = ReconnectBackoff::new(options.backoff_initial, options.backoff_max);
    loop {
        if cancel.is_cancelled() {
            return;
        }
        let delay = match connector.connect().await {
            Ok(mut wire) => {
                let end = session::run(
                    &mut wire,
                    ports,
                    &options.identity,
                    &options.timing,
                    telemetry::production_sampler(),
                    cancel,
                    store,
                )
                .await;
                match end {
                    SessionEnd::Cancelled => return,
                    SessionEnd::Lost { reason, welcomed } => {
                        info!("agent websocket v2 disconnected: {reason}");
                        if welcomed {
                            backoff.reset();
                        }
                        backoff.next_delay(jitter.next())
                    }
                    SessionEnd::Replaced => {
                        info!("agent websocket v2 session replaced; reconnecting");
                        backoff.reset();
                        backoff.next_delay(jitter.next())
                    }
                    SessionEnd::ServerDisabled => {
                        warn!("control plane disabled this server; retrying slowly");
                        jittered(options.disabled_delay, jitter.next())
                    }
                    SessionEnd::Deadline => {
                        debug!("reconnecting before the serverless connection deadline");
                        backoff.reset();
                        Duration::ZERO
                    }
                    SessionEnd::Protocol(reason) => {
                        warn!("agent websocket v2 protocol error: {reason}");
                        backoff.next_delay(jitter.next())
                    }
                }
            }
            Err(error) => {
                // The three states stay distinct in the logs: an unsupported
                // protocol, a rejected handshake, and a network failure.
                match error {
                    WsError::SubprotocolMismatch => {
                        warn!("control plane does not speak agent websocket v2; retrying v2 only")
                    }
                    WsError::Rejected { status } => {
                        warn!("agent websocket v2 handshake rejected with HTTP {status}")
                    }
                    other => debug!("agent websocket v2 connect failed: {}", other.describe()),
                }
                backoff.next_delay(jitter.next())
            }
        };
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(delay) => {}
        }
    }
}

#[cfg(test)]
mod tests;
