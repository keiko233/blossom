//! Interactive PTY sessions for the opt-in agent terminal.
//!
//! The agent never opens a listening socket for this: the control plane sends
//! `pty.open` / `pty.data` / `pty.resize` / `pty.close` over the authenticated
//! agent WebSocket, and this module runs the local shell. Sessions are bounded
//! by a concurrency cap and an idle timeout, and both output and input queues
//! are bounded so a slow browser or a stalled WebSocket cannot grow memory
//! without limit. Dropping the manager kills every remaining session.

pub mod ports;
pub mod session;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use self::ports::{PtyFactory, PtyProcess};

pub const DEFAULT_MAX_SESSIONS: usize = 2;
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
pub const DEFAULT_MAX_SESSION: Duration = Duration::from_secs(60 * 60);
pub const MIN_COLS: u16 = 20;
pub const MAX_COLS: u16 = 400;
pub const MIN_ROWS: u16 = 5;
pub const MAX_ROWS: u16 = 200;
pub const MAX_INPUT_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_WRITE_CHUNK_BYTES: usize = 16 * 1024;

/// Validated and clamped terminal dimensions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PtyDimensions {
    pub cols: u16,
    pub rows: u16,
}

impl PtyDimensions {
    pub fn clamped(cols: u32, rows: u32) -> Self {
        Self {
            cols: cols.clamp(MIN_COLS as u32, MAX_COLS as u32) as u16,
            rows: rows.clamp(MIN_ROWS as u32, MAX_ROWS as u32) as u16,
        }
    }
}

/// Why a session ended. The string form is the wire contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtyExitReason {
    Closed,
    IdleTimeout,
    AgentDisconnected,
    SessionLimit,
    InvalidSession,
    SpawnFailed,
    OutputBackpressure,
    InputBackpressure,
    FrameTooLarge,
    IoError,
    Disabled,
    SessionExpired,
    ShellExit,
}

impl PtyExitReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Closed => "closed",
            Self::IdleTimeout => "idle_timeout",
            Self::AgentDisconnected => "agent_disconnected",
            Self::SessionLimit => "session_limit",
            Self::InvalidSession => "invalid_session",
            Self::SpawnFailed => "spawn_failed",
            Self::OutputBackpressure => "output_backpressure",
            Self::InputBackpressure => "input_backpressure",
            Self::FrameTooLarge => "frame_too_large",
            Self::IoError => "io_error",
            Self::Disabled => "disabled",
            Self::SessionExpired => "session_expired",
            Self::ShellExit => "shell_exit",
        }
    }
}

/// A completed session, ready to be encoded as `pty.exit`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtyExit {
    pub session_id: String,
    pub reason: PtyExitReason,
    pub code: Option<u32>,
    pub signal: Option<String>,
}

/// Output from the blocking reader/writer threads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent {
    Data {
        session_id: String,
        data: String,
    },
    Exited {
        session_id: String,
        code: Option<u32>,
        signal: Option<String>,
    },
    ReadError {
        session_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyError {
    Disabled,
    SessionLimit,
    DuplicateSession,
    InvalidSessionId,
    Spawn(String),
    InputBackpressure,
    Closed,
    Io(String),
}

impl std::fmt::Display for PtyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disabled => formatter.write_str("PTY support is disabled"),
            Self::SessionLimit => formatter.write_str("PTY session limit reached"),
            Self::DuplicateSession => formatter.write_str("PTY session already exists"),
            Self::InvalidSessionId => formatter.write_str("invalid PTY session id"),
            Self::Spawn(message) => write!(formatter, "PTY spawn failed: {message}"),
            Self::InputBackpressure => formatter.write_str("PTY input queue is full"),
            Self::Closed => formatter.write_str("PTY session is closed"),
            Self::Io(message) => write!(formatter, "PTY I/O failed: {message}"),
        }
    }
}

impl std::error::Error for PtyError {}

/// Session policy. CLI values are clamped again here so a manual invocation
/// cannot accidentally disable the idle timeout or remove the cap.
#[derive(Debug, Clone)]
pub struct PtyLimits {
    enabled: bool,
    max_sessions: usize,
    idle_timeout: Duration,
    max_session: Duration,
}

impl PtyLimits {
    pub fn new(
        enabled: bool,
        max_sessions: usize,
        idle_timeout: Duration,
        max_session: Duration,
    ) -> Self {
        Self {
            enabled,
            max_sessions: max_sessions.clamp(1, 4),
            idle_timeout: idle_timeout.clamp(Duration::from_secs(30), Duration::from_secs(3600)),
            max_session: max_session.clamp(Duration::from_secs(60), Duration::from_secs(86_400)),
        }
    }

    pub fn max_sessions(&self) -> usize {
        self.max_sessions
    }

    pub fn idle_timeout(&self) -> Duration {
        self.idle_timeout
    }

    pub fn max_session(&self) -> Duration {
        self.max_session
    }
}

struct ManagedSession {
    process: Box<dyn PtyProcess>,
    opened_at: Instant,
    last_activity: Instant,
}

pub struct PtyManager {
    limits: PtyLimits,
    factory: Box<dyn PtyFactory>,
    sessions: HashMap<String, ManagedSession>,
}

impl PtyManager {
    pub fn new(limits: PtyLimits, factory: Box<dyn PtyFactory>) -> Self {
        Self {
            limits,
            factory,
            sessions: HashMap::new(),
        }
    }

    pub fn limits(&self) -> &PtyLimits {
        &self.limits
    }

    #[cfg(test)]
    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    pub fn open(&mut self, session_id: &str, dimensions: PtyDimensions) -> Result<(), PtyError> {
        if !self.limits.enabled {
            return Err(PtyError::Disabled);
        }
        if !valid_session_id(session_id) {
            return Err(PtyError::InvalidSessionId);
        }
        if self.sessions.contains_key(session_id) {
            return Err(PtyError::DuplicateSession);
        }
        if self.sessions.len() >= self.limits.max_sessions {
            return Err(PtyError::SessionLimit);
        }
        let process = self.factory.spawn(session_id, dimensions)?;
        self.sessions.insert(
            session_id.to_string(),
            ManagedSession {
                process,
                opened_at: Instant::now(),
                last_activity: Instant::now(),
            },
        );
        Ok(())
    }

    pub fn write(&mut self, session_id: &str, data: &[u8]) -> Result<(), PtyError> {
        let session = self.sessions.get_mut(session_id).ok_or(PtyError::Closed)?;
        session.last_activity = Instant::now();
        for chunk in data.chunks(MAX_WRITE_CHUNK_BYTES) {
            session.process.write(chunk)?;
        }
        Ok(())
    }

    pub fn resize(&mut self, session_id: &str, dimensions: PtyDimensions) -> Result<(), PtyError> {
        let session = self.sessions.get_mut(session_id).ok_or(PtyError::Closed)?;
        session.last_activity = Instant::now();
        session.process.resize(dimensions)
    }

    pub fn note_output(&mut self, session_id: &str, now: Instant) {
        if let Some(session) = self.sessions.get_mut(session_id) {
            session.last_activity = now;
        }
    }

    pub fn close(&mut self, session_id: &str, reason: PtyExitReason) -> Option<PtyExit> {
        let mut session = self.sessions.remove(session_id)?;
        session.process.kill();
        Some(PtyExit {
            session_id: session_id.to_string(),
            reason,
            code: None,
            signal: None,
        })
    }

    pub fn remove_exited(
        &mut self,
        session_id: &str,
        code: Option<u32>,
        signal: Option<String>,
    ) -> Option<PtyExit> {
        self.sessions.remove(session_id)?;
        Some(PtyExit {
            session_id: session_id.to_string(),
            reason: PtyExitReason::ShellExit,
            code,
            signal,
        })
    }

    pub fn reap_expired(&mut self, now: Instant) -> Vec<PtyExit> {
        let idle_timeout = self.limits.idle_timeout;
        let max_session = self.limits.max_session;
        let expired: Vec<(String, PtyExitReason)> = self
            .sessions
            .iter()
            .filter_map(|(session_id, session)| {
                if now.saturating_duration_since(session.opened_at) >= max_session {
                    Some((session_id.clone(), PtyExitReason::SessionExpired))
                } else if now.saturating_duration_since(session.last_activity) >= idle_timeout {
                    Some((session_id.clone(), PtyExitReason::IdleTimeout))
                } else {
                    None
                }
            })
            .collect();
        expired
            .into_iter()
            .filter_map(|(session_id, reason)| self.close(&session_id, reason))
            .collect()
    }

    pub fn close_all(&mut self, reason: PtyExitReason) -> Vec<PtyExit> {
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        ids.into_iter()
            .filter_map(|session_id| self.close(&session_id, reason))
            .collect()
    }
}

impl Drop for PtyManager {
    fn drop(&mut self) {
        for session in self.sessions.values_mut() {
            session.process.kill();
        }
    }
}

pub fn valid_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= 128
        && session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

/// Incremental UTF-8 decoder for PTY output. A read boundary may split a
/// multi-byte character; the incomplete suffix stays buffered for the next
/// chunk instead of turning into a replacement character.
#[derive(Debug, Default)]
pub struct Utf8Chunker {
    pending: Vec<u8>,
}

impl Utf8Chunker {
    pub fn feed(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut output = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    output.push_str(text);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    if valid > 0 {
                        output.push_str(
                            std::str::from_utf8(&self.pending[..valid])
                                .expect("valid_up_to is valid UTF-8"),
                        );
                        self.pending.drain(..valid);
                    }
                    match error.error_len() {
                        Some(invalid) => {
                            output.push('\u{fffd}');
                            self.pending.drain(..invalid);
                        }
                        None => break,
                    }
                }
            }
        }
        output
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use super::ports::{PtyFactory, PtyProcess};
    use super::{
        DEFAULT_MAX_SESSION, MAX_COLS, MAX_ROWS, MIN_COLS, MIN_ROWS, PtyDimensions, PtyError,
        PtyExitReason, PtyLimits, PtyManager, Utf8Chunker, valid_session_id,
    };

    #[derive(Debug, Default)]
    struct FakeState {
        spawned: Vec<(String, PtyDimensions)>,
        writes: Vec<Vec<u8>>,
        resizes: Vec<PtyDimensions>,
        killed: usize,
    }

    struct FakeFactory {
        state: std::sync::Arc<Mutex<FakeState>>,
    }

    struct FakeProcess {
        state: std::sync::Arc<Mutex<FakeState>>,
    }

    impl PtyFactory for FakeFactory {
        fn spawn(
            &self,
            session_id: &str,
            dimensions: PtyDimensions,
        ) -> Result<Box<dyn PtyProcess>, PtyError> {
            self.state
                .lock()
                .expect("fake pty state")
                .spawned
                .push((session_id.to_string(), dimensions));
            Ok(Box::new(FakeProcess {
                state: self.state.clone(),
            }))
        }
    }

    impl PtyProcess for FakeProcess {
        fn write(&mut self, data: &[u8]) -> Result<(), PtyError> {
            self.state
                .lock()
                .expect("fake pty state")
                .writes
                .push(data.to_vec());
            Ok(())
        }

        fn resize(&mut self, dimensions: PtyDimensions) -> Result<(), PtyError> {
            self.state
                .lock()
                .expect("fake pty state")
                .resizes
                .push(dimensions);
            Ok(())
        }

        fn kill(&mut self) {
            self.state.lock().expect("fake pty state").killed += 1;
        }
    }

    fn manager(
        enabled: bool,
        max_sessions: usize,
    ) -> (PtyManager, std::sync::Arc<Mutex<FakeState>>) {
        let state = std::sync::Arc::new(Mutex::new(FakeState::default()));
        let factory = FakeFactory {
            state: state.clone(),
        };
        (
            PtyManager::new(
                PtyLimits::new(
                    enabled,
                    max_sessions,
                    Duration::from_secs(60),
                    DEFAULT_MAX_SESSION,
                ),
                Box::new(factory),
            ),
            state,
        )
    }

    #[test]
    fn dimensions_are_clamped_to_safe_bounds() {
        assert_eq!(
            PtyDimensions::clamped(1, 1),
            PtyDimensions {
                cols: MIN_COLS,
                rows: MIN_ROWS,
            }
        );
        assert_eq!(
            PtyDimensions::clamped(10_000, 10_000),
            PtyDimensions {
                cols: MAX_COLS,
                rows: MAX_ROWS,
            }
        );
    }

    #[test]
    fn session_ids_reject_paths_and_empty_values() {
        assert!(valid_session_id("pty-1234"));
        assert!(valid_session_id("A_b-9"));
        assert!(!valid_session_id(""));
        assert!(!valid_session_id("../shell"));
        assert!(!valid_session_id("shell;rm"));
        assert!(!valid_session_id(&"x".repeat(129)));
    }

    #[test]
    fn disabled_and_limited_sessions_fail_without_spawning() {
        let (mut disabled, disabled_state) = manager(false, 2);
        assert_eq!(
            disabled.open("pty-1", PtyDimensions::clamped(80, 24)),
            Err(PtyError::Disabled)
        );
        assert!(disabled_state.lock().expect("state").spawned.is_empty());

        let (mut limited, limited_state) = manager(true, 1);
        limited
            .open("pty-1", PtyDimensions::clamped(80, 24))
            .expect("first session");
        assert_eq!(
            limited.open("pty-2", PtyDimensions::clamped(80, 24)),
            Err(PtyError::SessionLimit)
        );
        assert_eq!(limited_state.lock().expect("state").spawned.len(), 1);
    }

    #[test]
    fn writes_are_chunked_and_resizes_are_forwarded() {
        let (mut manager, state) = manager(true, 1);
        manager
            .open("pty-1", PtyDimensions::clamped(80, 24))
            .expect("session opens");
        manager
            .write("pty-1", &vec![b'a'; super::MAX_WRITE_CHUNK_BYTES + 1])
            .expect("write succeeds");
        manager
            .resize("pty-1", PtyDimensions::clamped(120, 40))
            .expect("resize succeeds");

        let state = state.lock().expect("state");
        assert_eq!(state.writes.len(), 2);
        assert_eq!(state.writes[0].len(), super::MAX_WRITE_CHUNK_BYTES);
        assert_eq!(state.writes[1].len(), 1);
        assert_eq!(
            state.resizes,
            vec![PtyDimensions {
                cols: 120,
                rows: 40
            }]
        );
    }

    #[test]
    fn idle_sessions_expire_and_close_kills_the_process() {
        let (mut manager, state) = manager(true, 1);
        manager
            .open("pty-1", PtyDimensions::clamped(80, 24))
            .expect("session opens");
        let later = Instant::now() + Duration::from_secs(120);
        let exits = manager.reap_expired(later);
        assert_eq!(exits.len(), 1);
        assert_eq!(exits[0].reason, PtyExitReason::IdleTimeout);
        assert_eq!(manager.session_count(), 0);
        assert_eq!(state.lock().expect("state").killed, 1);
    }

    #[test]
    fn output_activity_postpones_idle_expiry() {
        let (mut manager, _) = manager(true, 1);
        manager
            .open("pty-1", PtyDimensions::clamped(80, 24))
            .expect("session opens");
        let now = Instant::now();
        manager.note_output("pty-1", now + Duration::from_secs(50));
        assert!(
            manager
                .reap_expired(now + Duration::from_secs(100))
                .is_empty()
        );
        assert_eq!(
            manager.reap_expired(now + Duration::from_secs(120))[0].reason,
            PtyExitReason::IdleTimeout
        );
    }

    #[test]
    fn active_sessions_still_expire_at_the_hard_limit() {
        let (mut manager, state) = manager(true, 1);
        manager
            .open("pty-1", PtyDimensions::clamped(80, 24))
            .expect("session opens");
        let later = Instant::now() + DEFAULT_MAX_SESSION + Duration::from_secs(1);
        manager.note_output("pty-1", later - Duration::from_secs(1));
        let exits = manager.reap_expired(later);
        assert_eq!(exits.len(), 1);
        assert_eq!(exits[0].reason, PtyExitReason::SessionExpired);
        assert_eq!(state.lock().expect("state").killed, 1);
    }

    #[test]
    fn utf8_chunker_preserves_split_characters() {
        let mut chunker = Utf8Chunker::default();
        let euro = "€".as_bytes();
        assert_eq!(chunker.feed(&euro[..1]), "");
        assert_eq!(chunker.feed(&euro[1..2]), "");
        assert_eq!(chunker.feed(&euro[2..]), "€");
        assert_eq!(chunker.feed(b"ok"), "ok");
    }

    #[test]
    fn utf8_chunker_replaces_invalid_bytes() {
        let mut chunker = Utf8Chunker::default();
        assert_eq!(chunker.feed(&[0xff, b'a']), "\u{fffd}a");
    }
}
