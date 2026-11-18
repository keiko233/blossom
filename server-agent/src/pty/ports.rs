//! Consumer-owned PTY boundaries.
//!
//! The manager owns lifecycle policy; [`PtyFactory`] owns the platform PTY
//! and its blocking reader/writer threads. Tests inject a fake factory so
//! session limits, resize clamping and idle expiry run without a real shell.

use super::{PtyDimensions, PtyError};

/// A process attached to one pseudo-terminal.
pub trait PtyProcess: Send {
    fn write(&mut self, data: &[u8]) -> Result<(), PtyError>;
    fn resize(&mut self, dimensions: PtyDimensions) -> Result<(), PtyError>;
    fn kill(&mut self);
}

/// Spawns local shells. The session id is already validated by the manager.
pub trait PtyFactory: Send + Sync {
    fn spawn(
        &self,
        session_id: &str,
        dimensions: PtyDimensions,
    ) -> Result<Box<dyn PtyProcess>, PtyError>;
}
