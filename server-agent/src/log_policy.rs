//! Bounded local execution of the remote log-level policy.
//!
//! The control-plane contract is not wired yet. This module owns the local
//! state a later WebSocket binding will drive: a revision scoped to each
//! source, a baseline to restore, an optional deadline for a temporary
//! `debug`/`trace` override, and a status that keeps the requested and
//! effective levels separate from the last application error.
//!
//! State is persisted before it is applied, so an override can expire while
//! the control plane is offline or before either process starts after a
//! restart. Agent levels go through a reloadable tracing filter; sing-box
//! levels are written as a local overlay on the compiled configuration and
//! travel through the ordinary validated reload path.
//!
use std::collections::BTreeMap;
use std::fmt;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

/// Temporary override lifetime when the request does not choose one.
pub(crate) const DEFAULT_TEMPORARY: Duration = Duration::minutes(15);
/// Hard cap on a temporary override, independent of the control plane.
pub(crate) const MAX_TEMPORARY: Duration = Duration::minutes(60);
/// Minimum spacing between retries after a failed application.
pub(crate) const RETRY_INTERVAL: Duration = Duration::seconds(30);
/// Bound on a persisted error message.
const MAX_ERROR_CHARS: usize = 512;
/// Every locally controlled source, in a stable order.
pub(crate) const SOURCES: [Source; 2] = [Source::Agent, Source::SingBox];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Source {
    Agent,
    SingBox,
}

impl Source {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::SingBox => "sing-box",
        }
    }
}

impl fmt::Display for Source {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Level {
    Default,
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

impl Level {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Error => "error",
            Self::Warn => "warn",
            Self::Info => "info",
            Self::Debug => "debug",
            Self::Trace => "trace",
        }
    }

    pub(crate) fn is_temporary(self) -> bool {
        matches!(self, Self::Debug | Self::Trace)
    }

    pub(crate) fn is_requestable_baseline(self) -> bool {
        matches!(self, Self::Default | Self::Error | Self::Warn | Self::Info)
    }
}

impl fmt::Display for Level {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for Level {
    type Err = PolicyError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "default" => Ok(Self::Default),
            "error" => Ok(Self::Error),
            "warn" => Ok(Self::Warn),
            "info" => Ok(Self::Info),
            "debug" => Ok(Self::Debug),
            "trace" => Ok(Self::Trace),
            _ => Err(PolicyError::UnsupportedLevel(value.to_owned())),
        }
    }
}

/// A request as the future policy contract will deliver it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PolicyRequest {
    pub(crate) source: Source,
    pub(crate) revision: u64,
    /// The configured baseline that expiry and Restore now return to.
    pub(crate) baseline: Level,
    pub(crate) level: Level,
    pub(crate) deadline: Option<DateTime<Utc>>,
}

impl PolicyRequest {
    pub(crate) fn new(source: Source, revision: u64, level: Level) -> Self {
        Self {
            source,
            revision,
            baseline: Level::Default,
            level,
            deadline: None,
        }
    }
}

/// The local overlay for one compiled sing-box configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LogOverlay {
    pub(crate) requested: Level,
    pub(crate) baseline: Level,
    pub(crate) effective: Level,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PolicyAction {
    Agent(Level),
    SingBox(LogOverlay),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DecisionReason {
    Requested,
    Expired,
    Retry,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PolicyStatus {
    pub(crate) source: Source,
    pub(crate) revision: u64,
    pub(crate) requested: Level,
    pub(crate) baseline: Level,
    pub(crate) effective: Level,
    pub(crate) deadline: Option<DateTime<Utc>>,
    pub(crate) error: Option<String>,
    pub(crate) pending: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PolicyDecision {
    pub(crate) status: PolicyStatus,
    pub(crate) action: Option<PolicyAction>,
    pub(crate) reason: DecisionReason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PolicyError {
    UnsupportedLevel(String),
    StaleRevision {
        source: Source,
        revision: u64,
        current: u64,
    },
    ConflictingRevision {
        source: Source,
        revision: u64,
    },
    DeadlineNotAllowed {
        level: Level,
    },
    ExpiredDeadline,
    Persist(String),
}

impl fmt::Display for PolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedLevel(value) => write!(formatter, "unsupported log level {value}"),
            Self::StaleRevision {
                source,
                revision,
                current,
            } => write!(
                formatter,
                "{source} policy revision {revision} is older than the applied revision {current}"
            ),
            Self::ConflictingRevision { source, revision } => write!(
                formatter,
                "{source} policy revision {revision} conflicts with a different local request"
            ),
            Self::DeadlineNotAllowed { level } => write!(
                formatter,
                "log level {level} is a baseline and cannot carry an override deadline"
            ),
            Self::ExpiredDeadline => {
                formatter.write_str("temporary log-level deadline is not in the future")
            }
            Self::Persist(message) => write!(formatter, "failed to persist log policy: {message}"),
        }
    }
}

impl std::error::Error for PolicyError {}

/// A reloadable local level sink. The agent's tracing filter implements it in
/// production and a recording fake implements it in tests.
pub(crate) trait AgentFilter: Send + Sync {
    fn set_level(&self, level: Level) -> Result<(), String>;
}

#[derive(Debug, Clone)]
struct SourceState {
    revision: u64,
    requested: Level,
    /// The installed or generated level. `configured_baseline` overrides it
    /// until the control plane explicitly restores the default.
    local_baseline: Level,
    configured_baseline: Option<Level>,
    effective: Level,
    deadline: Option<DateTime<Utc>>,
    error: Option<String>,
    retry_at: Option<DateTime<Utc>>,
}

impl SourceState {
    fn new(local_baseline: Level) -> Self {
        Self {
            revision: 0,
            requested: Level::Default,
            local_baseline,
            configured_baseline: None,
            effective: local_baseline,
            deadline: None,
            error: None,
            retry_at: None,
        }
    }

    fn baseline(&self) -> Level {
        self.configured_baseline.unwrap_or(self.local_baseline)
    }

    fn target(&self, now: DateTime<Utc>) -> Level {
        if self.deadline.is_some_and(|deadline| deadline <= now) {
            return self.baseline();
        }
        match self.requested {
            Level::Default => self.baseline(),
            level => level,
        }
    }

    fn status(&self, source: Source, now: DateTime<Utc>) -> PolicyStatus {
        let target = self.target(now);
        PolicyStatus {
            source,
            revision: self.revision,
            requested: self.requested,
            baseline: self.baseline(),
            effective: self.effective,
            deadline: self.deadline,
            error: self.error.clone(),
            pending: target != self.effective,
        }
    }
}

#[derive(Debug, Default)]
struct Inner {
    sources: BTreeMap<Source, SourceState>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PersistedPolicy {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    sources: Vec<PersistedSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedSource {
    source: Source,
    #[serde(default)]
    revision: u64,
    #[serde(default = "default_level")]
    requested: Level,
    #[serde(default = "default_level", alias = "baseline")]
    local_baseline: Level,
    #[serde(default)]
    configured_baseline: Option<Level>,
    #[serde(default = "default_level")]
    effective: Level,
    #[serde(default)]
    deadline: Option<DateTime<Utc>>,
    #[serde(default)]
    error: Option<String>,
}

fn default_level() -> Level {
    Level::Default
}

/// The process-wide policy controller.
pub(crate) struct LogPolicy {
    state_path: PathBuf,
    inner: Mutex<Inner>,
    filter: Arc<dyn AgentFilter>,
    loaded_from_disk: bool,
}

impl LogPolicy {
    /// Loads persisted state before the subscriber is built, expires any
    /// deadline that already passed, and applies the agent's effective level
    /// through the reloadable filter. Corrupt state is bounded away and
    /// replaced by the local baseline.
    pub(crate) fn load(
        state_dir: &Path,
        agent_baseline: Level,
        filter: Arc<dyn AgentFilter>,
        now: DateTime<Utc>,
    ) -> (Self, Vec<String>) {
        let state_path = state_dir.join("log-policy.json");
        let mut warnings = Vec::new();
        let mut inner = Inner::default();
        inner
            .sources
            .insert(Source::Agent, SourceState::new(agent_baseline));
        inner
            .sources
            .insert(Source::SingBox, SourceState::new(Level::Default));

        let mut loaded_from_disk = false;
        if let Ok(bytes) = std::fs::read(&state_path) {
            match serde_json::from_slice::<PersistedPolicy>(&bytes) {
                Ok(persisted) => {
                    loaded_from_disk = true;
                    merge_persisted(&mut inner, persisted, now, &mut warnings);
                }
                Err(error) => warnings.push(format!(
                    "persisted log policy is unreadable; using local baselines: {error}"
                )),
            }
        }

        let policy = Self {
            state_path,
            inner: Mutex::new(inner),
            filter,
            loaded_from_disk,
        };
        let expired = policy.expire_locked(now);
        for decision in expired {
            if decision.action.is_some() {
                warnings.push(format!(
                    "restored the {} log baseline because its temporary override expired",
                    decision.status.source
                ));
            }
        }
        let agent_level = policy.target_level_at(Source::Agent, now);
        let result = policy.filter.set_level(agent_level);
        policy.record_locked(Source::Agent, agent_level, result, now);
        if let Err(error) = policy.persist() {
            warnings.push(error.to_string());
        }
        (policy, warnings)
    }

    pub(crate) fn status(&self, source: Source, now: DateTime<Utc>) -> PolicyStatus {
        self.inner
            .lock()
            .map(|inner| {
                inner
                    .sources
                    .get(&source)
                    .map(|state| state.status(source, now))
                    .unwrap_or_else(|| SourceState::new(Level::Default).status(source, now))
            })
            .unwrap_or_else(|_| SourceState::new(Level::Default).status(source, now))
    }

    /// True when this process read a previously persisted policy. Startup uses
    /// it to avoid mistaking an older configuration's `log.level` for the
    /// baseline when no policy file exists yet.
    pub(crate) fn has_persisted_state(&self) -> bool {
        self.loaded_from_disk
    }

    pub(crate) fn target_level_at(&self, source: Source, now: DateTime<Utc>) -> Level {
        self.inner
            .lock()
            .map(|inner| {
                inner
                    .sources
                    .get(&source)
                    .map(|state| state.target(now))
                    .unwrap_or(Level::Default)
            })
            .unwrap_or(Level::Default)
    }

    pub(crate) fn target_level(&self, source: Source) -> Level {
        self.target_level_at(source, Utc::now())
    }

    /// Resolves the local overlay for a compiled configuration.
    pub(crate) fn overlay(&self, now: DateTime<Utc>) -> LogOverlay {
        self.inner
            .lock()
            .map(|inner| overlay_from(&inner, now))
            .unwrap_or(LogOverlay {
                requested: Level::Default,
                baseline: Level::Default,
                effective: Level::Default,
            })
    }

    /// Applies an overlay to a compiled sing-box document. A `default`
    /// request restores the generated baseline instead of inventing a level:
    /// an absent baseline removes the field, an explicit baseline is written.
    pub(crate) fn apply_overlay(
        config: &mut serde_json::Map<String, serde_json::Value>,
        overlay: LogOverlay,
    ) {
        let level = match overlay.requested {
            Level::Default => match overlay.baseline {
                Level::Default => None,
                baseline => Some(baseline.as_str()),
            },
            _ => Some(overlay.effective.as_str()),
        };
        let log = config
            .entry("log")
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        if !log.is_object() {
            *log = serde_json::Value::Object(serde_json::Map::new());
        }
        let log = log.as_object_mut().expect("log is an object");
        match level {
            Some(level) => {
                log.insert("level".into(), serde_json::Value::String(level.to_owned()));
            }
            None => {
                log.remove("level");
            }
        }
        if log.is_empty() {
            config.remove("log");
        }
    }

    /// Reads the generated baseline from a compiled document before the local
    /// overlay is applied.
    pub(crate) fn config_baseline(config: &serde_json::Map<String, serde_json::Value>) -> Level {
        config
            .get("log")
            .and_then(serde_json::Value::as_object)
            .and_then(|log| log.get("level"))
            .and_then(serde_json::Value::as_str)
            .and_then(|level| Level::from_str(level).ok())
            .unwrap_or(Level::Default)
    }

    /// Updates the installed/generated sing-box baseline from a freshly
    /// compiled desired config. An explicit remote baseline still wins until
    /// the control plane clears it, so a configuration recompile cannot
    /// silently replace an administrator's baseline.
    pub(crate) fn set_singbox_baseline(
        &self,
        baseline: Level,
        now: DateTime<Utc>,
    ) -> Result<(), PolicyError> {
        let mut inner = self.lock_inner()?;
        let state = inner
            .sources
            .entry(Source::SingBox)
            .or_insert_with(|| SourceState::new(Level::Default));
        if state.local_baseline != baseline {
            state.local_baseline = baseline;
        }
        if state.deadline.is_some_and(|deadline| deadline <= now)
            && state.requested == Level::Default
        {
            state.deadline = None;
        }
        drop(inner);
        self.persist()
    }

    /// Accepts one control-plane request. The returned action is `None` when
    /// the target is already effective; the caller records the outcome with
    /// [`Self::record`] after applying it.
    pub(crate) fn request(
        &self,
        request: PolicyRequest,
        now: DateTime<Utc>,
    ) -> Result<PolicyDecision, PolicyError> {
        if !request.level.is_requestable_baseline() && !request.level.is_temporary() {
            return Err(PolicyError::UnsupportedLevel(request.level.to_string()));
        }
        if !request.baseline.is_requestable_baseline() {
            return Err(PolicyError::UnsupportedLevel(request.baseline.to_string()));
        }
        if request.level.is_temporary() && request.deadline.is_some_and(|d| d <= now) {
            return Err(PolicyError::ExpiredDeadline);
        }
        if !request.level.is_temporary() && request.deadline.is_some() {
            return Err(PolicyError::DeadlineNotAllowed {
                level: request.level,
            });
        }
        let deadline = request.level.is_temporary().then(|| {
            let requested = request.deadline.unwrap_or(now + DEFAULT_TEMPORARY);
            requested.min(now + MAX_TEMPORARY)
        });

        let mut inner = self.lock_inner()?;
        let state = inner
            .sources
            .entry(request.source)
            .or_insert_with(|| SourceState::new(Level::Default));
        let configured_baseline = match request.baseline {
            Level::Default => None,
            baseline => Some(baseline),
        };
        if request.revision < state.revision {
            return Err(PolicyError::StaleRevision {
                source: request.source,
                revision: request.revision,
                current: state.revision,
            });
        }
        if request.revision == state.revision {
            let exact_replay = state.requested == request.level
                && state.deadline == deadline
                && state.configured_baseline == configured_baseline;
            // The control plane normalizes an expired override to a baseline
            // request at the same revision. If the local deadline already
            // passed, that is the same target as the persisted temporary
            // request, not a conflicting edit.
            let expired_replay = request.level == Level::Default
                && deadline.is_none()
                && state.configured_baseline == configured_baseline
                && state.target(now) == state.baseline();
            if (exact_replay || expired_replay) && state.error.is_none() {
                return Ok(PolicyDecision {
                    status: state.status(request.source, now),
                    action: None,
                    reason: DecisionReason::Requested,
                });
            }
            return Err(PolicyError::ConflictingRevision {
                source: request.source,
                revision: request.revision,
            });
        }
        state.revision = request.revision;
        state.requested = request.level;
        state.configured_baseline = configured_baseline;
        state.deadline = deadline;
        state.error = None;
        state.retry_at = Some(now);
        let target = state.target(now);
        let effective = state.effective;
        let status = state.status(request.source, now);
        let action = if target != effective {
            Some(match request.source {
                Source::Agent => PolicyAction::Agent(target),
                Source::SingBox => PolicyAction::SingBox(overlay_from(&inner, now)),
            })
        } else {
            None
        };
        drop(inner);
        self.persist()?;
        Ok(PolicyDecision {
            status,
            action,
            reason: DecisionReason::Requested,
        })
    }

    /// Applies a control-plane snapshot entry. An expired temporary request
    /// becomes a baseline request at the same source revision, so a reconnect
    /// cannot revive an override whose deadline already passed.
    pub(crate) fn request_snapshot(
        &self,
        request: PolicyRequest,
        now: DateTime<Utc>,
    ) -> Result<PolicyDecision, PolicyError> {
        if request.level.is_temporary() && request.deadline.is_some_and(|deadline| deadline <= now)
        {
            return self.request(
                PolicyRequest {
                    level: Level::Default,
                    deadline: None,
                    ..request
                },
                now,
            );
        }
        self.request(request, now)
    }

    /// Applies an agent filter change synchronously and records the outcome.
    pub(crate) fn apply_agent(&self, level: Level, now: DateTime<Utc>) -> Option<PolicyStatus> {
        let result = self.filter.set_level(level);
        self.record(Source::Agent, level, result, now)
    }

    /// Applies a sing-box action without waiting for the supervision loop.
    /// Used by tests and by the startup path that must finish before services
    /// start.
    pub(crate) fn expire(&self, now: DateTime<Utc>) -> Vec<PolicyDecision> {
        let mut decisions = self.expire_locked(now);
        if !decisions.is_empty()
            && let Err(error) = self.persist()
        {
            for decision in &mut decisions {
                decision.status.error = Some(error.to_string());
            }
        }
        decisions
    }

    fn expire_locked(&self, now: DateTime<Utc>) -> Vec<PolicyDecision> {
        let Ok(mut inner) = self.inner.lock() else {
            return Vec::new();
        };
        let mut expired = Vec::new();
        for (source, state) in &mut inner.sources {
            let Some(deadline) = state.deadline else {
                continue;
            };
            if deadline > now {
                continue;
            }
            state.requested = Level::Default;
            state.deadline = None;
            state.error = None;
            // Keep the retry bound even when the expiry action itself is
            // handed out, so one tick cannot stage the same overlay twice.
            state.retry_at = Some(now + RETRY_INTERVAL);
            let target = state.target(now);
            expired.push((*source, target, target != state.effective));
        }
        let overlay = overlay_from(&inner, now);
        let mut decisions = Vec::new();
        for (source, target, changed) in expired {
            let action = changed.then_some(match source {
                Source::Agent => PolicyAction::Agent(target),
                Source::SingBox => PolicyAction::SingBox(overlay),
            });
            decisions.push(PolicyDecision {
                status: inner
                    .sources
                    .get(&source)
                    .map(|state| state.status(source, now))
                    .unwrap_or_else(|| SourceState::new(Level::Default).status(source, now)),
                action,
                reason: DecisionReason::Expired,
            });
        }
        decisions
    }

    /// Returns a bounded retry for a source whose last application failed or
    /// whose action has not been recorded yet.
    pub(crate) fn retry_due(&self, now: DateTime<Utc>) -> Vec<PolicyDecision> {
        let Ok(mut inner) = self.inner.lock() else {
            return Vec::new();
        };
        let overlay = overlay_from(&inner, now);
        let mut decisions = Vec::new();
        for (source, state) in &mut inner.sources {
            let target = state.target(now);
            if target == state.effective {
                continue;
            }
            if state.retry_at.is_some_and(|retry| retry > now) {
                continue;
            }
            state.retry_at = Some(now + RETRY_INTERVAL);
            decisions.push(PolicyDecision {
                status: state.status(*source, now),
                action: Some(match source {
                    Source::Agent => PolicyAction::Agent(target),
                    Source::SingBox => PolicyAction::SingBox(overlay),
                }),
                reason: DecisionReason::Retry,
            });
        }
        decisions
    }

    /// Records the result of an action. A stale completion (the target moved
    /// while the action ran) is ignored.
    pub(crate) fn record(
        &self,
        source: Source,
        level: Level,
        result: Result<(), String>,
        now: DateTime<Utc>,
    ) -> Option<PolicyStatus> {
        let status = self.record_locked(source, level, result, now)?;
        if let Err(error) = self.persist() {
            let mut status = status;
            status.error = Some(error.to_string());
            return Some(status);
        }
        Some(status)
    }

    fn record_locked(
        &self,
        source: Source,
        level: Level,
        result: Result<(), String>,
        now: DateTime<Utc>,
    ) -> Option<PolicyStatus> {
        let mut inner = self.inner.lock().ok()?;
        let state = inner.sources.get_mut(&source)?;
        if state.target(now) != level {
            return Some(state.status(source, now));
        }
        match result {
            Ok(()) => {
                state.effective = level;
                state.error = None;
                state.retry_at = None;
            }
            Err(error) => {
                state.error = Some(bound(&error));
                state.retry_at = Some(now + RETRY_INTERVAL);
            }
        }
        Some(state.status(source, now))
    }

    fn lock_inner(&self) -> Result<std::sync::MutexGuard<'_, Inner>, PolicyError> {
        self.inner
            .lock()
            .map_err(|_| PolicyError::Persist("log policy lock is poisoned".to_owned()))
    }

    fn persist(&self) -> Result<(), PolicyError> {
        let inner = self.lock_inner()?;
        let persisted = PersistedPolicy {
            version: 1,
            sources: inner
                .sources
                .iter()
                .map(|(source, state)| PersistedSource {
                    source: *source,
                    revision: state.revision,
                    requested: state.requested,
                    local_baseline: state.local_baseline,
                    configured_baseline: state.configured_baseline,
                    effective: state.effective,
                    deadline: state.deadline,
                    error: state.error.clone(),
                })
                .collect(),
        };
        let bytes = serde_json::to_vec_pretty(&persisted)
            .map_err(|error| PolicyError::Persist(error.to_string()))?;
        drop(inner);
        let temp = self.state_path.with_extension("json.tmp");
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        if let Some(parent) = self.state_path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)
                .map_err(|error| PolicyError::Persist(error.to_string()))?;
        }
        let mut file = options
            .open(&temp)
            .map_err(|error| PolicyError::Persist(error.to_string()))?;
        file.write_all(&bytes)
            .map_err(|error| PolicyError::Persist(error.to_string()))?;
        file.sync_all()
            .map_err(|error| PolicyError::Persist(error.to_string()))?;
        std::fs::rename(&temp, &self.state_path)
            .map_err(|error| PolicyError::Persist(error.to_string()))
    }
}

fn overlay_from(inner: &Inner, now: DateTime<Utc>) -> LogOverlay {
    let state = inner
        .sources
        .get(&Source::SingBox)
        .cloned()
        .unwrap_or_else(|| SourceState::new(Level::Default));
    LogOverlay {
        requested: state.requested,
        baseline: state.baseline(),
        effective: state.target(now),
    }
}

fn merge_persisted(
    inner: &mut Inner,
    persisted: PersistedPolicy,
    now: DateTime<Utc>,
    warnings: &mut Vec<String>,
) {
    for stored in persisted.sources {
        let Some(state) = inner.sources.get_mut(&stored.source) else {
            warnings.push(format!(
                "persisted log policy names an unknown source {}",
                stored.source
            ));
            continue;
        };
        let mut requested = stored.requested;
        let mut deadline = stored.deadline;
        if requested.is_temporary() && deadline.is_none() {
            warnings.push(format!(
                "persisted {} temporary log level had no deadline; restoring its baseline",
                stored.source
            ));
            requested = Level::Default;
        }
        if requested.is_temporary() && deadline.is_some_and(|d| d <= now) {
            requested = Level::Default;
            deadline = None;
        }
        if !requested.is_temporary() {
            deadline = None;
        }
        state.revision = stored.revision;
        state.requested = requested;
        if stored.source == Source::SingBox {
            state.local_baseline = stored.local_baseline;
        }
        if stored
            .configured_baseline
            .is_some_and(|baseline| !baseline.is_requestable_baseline())
        {
            warnings.push(format!(
                "persisted {} baseline is not a baseline level; restoring the installed default",
                stored.source
            ));
            state.configured_baseline = None;
        } else {
            state.configured_baseline = stored.configured_baseline;
        }
        state.effective = if requested == Level::Default {
            state.baseline()
        } else {
            stored.effective
        };
        state.deadline = deadline;
        state.error = stored.error.map(|value| bound(&value));
        state.retry_at = state.error.as_ref().map(|_| now + RETRY_INTERVAL);
    }
}

fn bound(message: &str) -> String {
    message
        .replace(
            |character: char| character.is_control() && character != '\n',
            "",
        )
        .chars()
        .take(MAX_ERROR_CHARS)
        .collect()
}

#[cfg(test)]
pub(crate) struct RecordingFilter {
    levels: Mutex<Vec<Level>>,
    fail: Mutex<Option<String>>,
}

#[cfg(test)]
impl RecordingFilter {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            levels: Mutex::new(Vec::new()),
            fail: Mutex::new(None),
        })
    }

    pub(crate) fn fail_with(&self, error: &str) {
        *self.fail.lock().unwrap() = Some(error.to_owned());
    }

    pub(crate) fn levels(&self) -> Vec<Level> {
        self.levels.lock().unwrap().clone()
    }
}

#[cfg(test)]
impl AgentFilter for RecordingFilter {
    fn set_level(&self, level: Level) -> Result<(), String> {
        if let Some(error) = self.fail.lock().unwrap().clone() {
            return Err(error);
        }
        self.levels.lock().unwrap().push(level);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "blossom-log-policy-{name}-{}-{suffix}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn load(dir: &Path, filter: Arc<RecordingFilter>) -> LogPolicy {
        let (policy, warnings) = LogPolicy::load(
            dir,
            Level::Info,
            filter,
            DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
        );
        assert!(warnings.is_empty(), "{warnings:?}");
        policy
    }

    #[test]
    fn revisions_are_scoped_per_source_and_idempotent() {
        let dir = test_dir("revisions");
        let policy = load(&dir, RecordingFilter::new());
        let now = Utc::now();
        let agent = policy
            .request(PolicyRequest::new(Source::Agent, 7, Level::Warn), now)
            .unwrap();
        assert_eq!(agent.status.requested, Level::Warn);
        assert_eq!(agent.action, Some(PolicyAction::Agent(Level::Warn)));
        // The same revision is a replay, not a conflict.
        assert!(
            policy
                .request(PolicyRequest::new(Source::Agent, 7, Level::Warn), now)
                .is_ok()
        );
        // A lower revision is rejected, but the other source is independent.
        assert!(matches!(
            policy.request(PolicyRequest::new(Source::Agent, 6, Level::Info), now),
            Err(PolicyError::StaleRevision { .. })
        ));
        assert!(
            policy
                .request(PolicyRequest::new(Source::SingBox, 1, Level::Info), now)
                .is_ok()
        );
        // Reusing a revision with a different level conflicts.
        assert!(matches!(
            policy.request(PolicyRequest::new(Source::Agent, 7, Level::Info), now),
            Err(PolicyError::ConflictingRevision { .. })
        ));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn temporary_levels_are_short_and_baseline_levels_cannot_carry_a_deadline() {
        let dir = test_dir("deadlines");
        let policy = load(&dir, RecordingFilter::new());
        let now = Utc::now();
        let decision = policy
            .request(PolicyRequest::new(Source::SingBox, 1, Level::Debug), now)
            .unwrap();
        let deadline = decision.status.deadline.expect("debug has a deadline");
        assert_eq!(deadline, now + DEFAULT_TEMPORARY);

        let far = now + Duration::hours(5);
        let mut request = PolicyRequest::new(Source::SingBox, 2, Level::Trace);
        request.deadline = Some(far);
        let decision = policy.request(request, now).unwrap();
        assert_eq!(
            decision.status.deadline,
            Some(now + MAX_TEMPORARY),
            "the local cap wins over a longer control-plane deadline"
        );

        let mut baseline = PolicyRequest::new(Source::SingBox, 3, Level::Warn);
        baseline.deadline = Some(now + Duration::minutes(5));
        assert!(matches!(
            policy.request(baseline, now),
            Err(PolicyError::DeadlineNotAllowed { .. })
        ));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn expiry_restores_the_baseline_even_without_a_control_plane() {
        let dir = test_dir("expiry");
        let filter = RecordingFilter::new();
        let policy = load(&dir, filter);
        let now = Utc::now();
        let decision = policy
            .request(PolicyRequest::new(Source::SingBox, 1, Level::Debug), now)
            .unwrap();
        let PolicyAction::SingBox(overlay) = decision.action.unwrap() else {
            panic!("expected a sing-box overlay");
        };
        policy
            .record(Source::SingBox, overlay.effective, Ok(()), now)
            .unwrap();

        // Before the deadline nothing changes.
        assert!(policy.expire(now + Duration::minutes(1)).is_empty());
        let expired = policy.expire(now + DEFAULT_TEMPORARY);
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].status.requested, Level::Default);
        assert_eq!(expired[0].status.effective, Level::Debug);
        assert_eq!(
            expired[0].action,
            Some(PolicyAction::SingBox(LogOverlay {
                requested: Level::Default,
                baseline: Level::Default,
                effective: Level::Default,
            }))
        );
        assert!(policy.expire(now + DEFAULT_TEMPORARY).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn persisted_deadline_is_applied_before_the_next_start() {
        let dir = test_dir("restart");
        let filter = RecordingFilter::new();
        let policy = load(&dir, filter.clone());
        let now = Utc::now();
        let decision = policy
            .request(PolicyRequest::new(Source::SingBox, 4, Level::Trace), now)
            .unwrap();
        let PolicyAction::SingBox(overlay) = decision.action.unwrap() else {
            panic!("expected a sing-box overlay");
        };
        policy
            .record(Source::SingBox, overlay.effective, Ok(()), now)
            .unwrap();
        drop(policy);

        let (restarted, warnings) =
            LogPolicy::load(&dir, Level::Info, filter.clone(), now + DEFAULT_TEMPORARY);
        assert!(warnings.is_empty(), "{warnings:?}");
        let status = restarted.status(Source::SingBox, now + DEFAULT_TEMPORARY);
        assert_eq!(status.requested, Level::Default);
        assert_eq!(status.effective, Level::Default);
        assert_eq!(status.deadline, None);
        assert_eq!(filter.levels().last(), Some(&Level::Info));
        // The persisted file now carries the restored state.
        let stored: PersistedPolicy =
            serde_json::from_slice(&std::fs::read(dir.join("log-policy.json")).unwrap()).unwrap();
        let singbox = stored
            .sources
            .iter()
            .find(|source| source.source == Source::SingBox)
            .unwrap();
        assert_eq!(singbox.requested, Level::Default);
        assert_eq!(singbox.deadline, None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_warn_baseline_survives_local_expiry_and_reconnect() {
        let dir = test_dir("baseline-expiry");
        let filter = RecordingFilter::new();
        let policy = load(&dir, filter.clone());
        let now = Utc::now();

        let mut baseline = PolicyRequest::new(Source::Agent, 1, Level::Warn);
        baseline.baseline = Level::Warn;
        let decision = policy.request_snapshot(baseline, now).unwrap();
        assert_eq!(decision.status.baseline, Level::Warn);
        assert_eq!(decision.action, Some(PolicyAction::Agent(Level::Warn)));
        policy
            .record(Source::Agent, Level::Warn, Ok(()), now)
            .unwrap();

        let mut override_request = PolicyRequest::new(Source::Agent, 2, Level::Debug);
        override_request.baseline = Level::Warn;
        let decision = policy.request_snapshot(override_request, now).unwrap();
        assert_eq!(decision.status.baseline, Level::Warn);
        assert_eq!(decision.action, Some(PolicyAction::Agent(Level::Debug)));
        policy
            .record(Source::Agent, Level::Debug, Ok(()), now)
            .unwrap();

        let expired = policy.expire(now + DEFAULT_TEMPORARY);
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].status.requested, Level::Default);
        assert_eq!(expired[0].status.baseline, Level::Warn);
        assert_eq!(expired[0].status.effective, Level::Debug);
        assert_eq!(expired[0].action, Some(PolicyAction::Agent(Level::Warn)));
        policy
            .record(Source::Agent, Level::Warn, Ok(()), now + DEFAULT_TEMPORARY)
            .unwrap();

        // The control plane serializes an expired override as `default` with
        // the configured baseline at the same revision. Reapplying it is
        // idempotent and does not revive the override or conflict.
        let replay = PolicyRequest {
            source: Source::Agent,
            revision: 2,
            baseline: Level::Warn,
            level: Level::Default,
            deadline: None,
        };
        let decision = policy
            .request_snapshot(replay, now + DEFAULT_TEMPORARY)
            .unwrap();
        assert_eq!(decision.action, None);
        assert_eq!(decision.status.requested, Level::Default);
        assert_eq!(decision.status.baseline, Level::Warn);
        assert_eq!(decision.status.effective, Level::Warn);
        assert!(
            policy
                .request_snapshot(replay, now + DEFAULT_TEMPORARY)
                .is_ok()
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_now_keeps_the_baseline_and_restore_default_clears_it() {
        let dir = test_dir("restore");
        let filter = RecordingFilter::new();
        let policy = load(&dir, filter);
        let now = Utc::now();

        let mut baseline = PolicyRequest::new(Source::Agent, 1, Level::Warn);
        baseline.baseline = Level::Warn;
        policy.request(baseline, now).unwrap();
        policy
            .record(Source::Agent, Level::Warn, Ok(()), now)
            .unwrap();

        let mut override_request = PolicyRequest::new(Source::Agent, 2, Level::Debug);
        override_request.baseline = Level::Warn;
        policy.request(override_request, now).unwrap();
        policy
            .record(Source::Agent, Level::Debug, Ok(()), now)
            .unwrap();

        // Restore now clears only the override.
        let mut restore_now = PolicyRequest::new(Source::Agent, 3, Level::Default);
        restore_now.baseline = Level::Warn;
        let decision = policy.request(restore_now, now).unwrap();
        assert_eq!(decision.status.baseline, Level::Warn);
        assert_eq!(decision.action, Some(PolicyAction::Agent(Level::Warn)));
        policy
            .record(Source::Agent, Level::Warn, Ok(()), now)
            .unwrap();

        // Restoring the installed default clears the configured baseline.
        let restore_default = PolicyRequest::new(Source::Agent, 4, Level::Default);
        let decision = policy.request(restore_default, now).unwrap();
        assert_eq!(decision.status.baseline, Level::Info);
        assert_eq!(decision.action, Some(PolicyAction::Agent(Level::Info)));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_fresh_agent_recovers_a_remote_baseline() {
        let dir = test_dir("fresh");
        let filter = RecordingFilter::new();
        let policy = load(&dir, filter);
        let now = Utc::now();

        let mut snapshot = PolicyRequest::new(Source::Agent, 1, Level::Default);
        snapshot.baseline = Level::Warn;
        let decision = policy.request_snapshot(snapshot, now).unwrap();
        assert_eq!(decision.status.requested, Level::Default);
        assert_eq!(decision.status.baseline, Level::Warn);
        assert_eq!(decision.action, Some(PolicyAction::Agent(Level::Warn)));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn configured_baselines_are_independent_per_source() {
        let dir = test_dir("independent");
        let filter = RecordingFilter::new();
        let policy = load(&dir, filter);
        let now = Utc::now();

        let mut agent = PolicyRequest::new(Source::Agent, 1, Level::Warn);
        agent.baseline = Level::Warn;
        policy.request(agent, now).unwrap();
        let mut sing_box = PolicyRequest::new(Source::SingBox, 2, Level::Error);
        sing_box.baseline = Level::Error;
        policy.request(sing_box, now).unwrap();
        let mut agent_override = PolicyRequest::new(Source::Agent, 3, Level::Debug);
        agent_override.baseline = Level::Warn;
        policy.request(agent_override, now).unwrap();

        let agent_status = policy.status(Source::Agent, now);
        assert_eq!(agent_status.requested, Level::Debug);
        assert_eq!(agent_status.baseline, Level::Warn);
        let sing_box_status = policy.status(Source::SingBox, now);
        assert_eq!(sing_box_status.revision, 2);
        assert_eq!(sing_box_status.requested, Level::Error);
        assert_eq!(sing_box_status.baseline, Level::Error);
        assert_eq!(policy.overlay(now).baseline, Level::Error);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_configured_baseline_persists_across_a_restart_after_expiry() {
        let dir = test_dir("baseline-restart");
        let filter = RecordingFilter::new();
        let policy = load(&dir, filter.clone());
        let now = Utc::now();

        let mut baseline = PolicyRequest::new(Source::Agent, 1, Level::Warn);
        baseline.baseline = Level::Warn;
        policy.request(baseline, now).unwrap();
        policy
            .record(Source::Agent, Level::Warn, Ok(()), now)
            .unwrap();
        let mut override_request = PolicyRequest::new(Source::Agent, 2, Level::Trace);
        override_request.baseline = Level::Warn;
        policy.request(override_request, now).unwrap();
        policy
            .record(Source::Agent, Level::Trace, Ok(()), now)
            .unwrap();
        drop(policy);

        let (restarted, warnings) =
            LogPolicy::load(&dir, Level::Info, filter.clone(), now + DEFAULT_TEMPORARY);
        assert!(warnings.is_empty(), "{warnings:?}");
        let status = restarted.status(Source::Agent, now + DEFAULT_TEMPORARY);
        assert_eq!(status.requested, Level::Default);
        assert_eq!(status.baseline, Level::Warn);
        assert_eq!(status.effective, Level::Warn);
        assert_eq!(filter.levels().last(), Some(&Level::Warn));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn failed_application_keeps_the_working_level_and_retries_are_bounded() {
        let dir = test_dir("retry");
        let policy = load(&dir, RecordingFilter::new());
        let now = Utc::now();
        let decision = policy
            .request(PolicyRequest::new(Source::SingBox, 1, Level::Error), now)
            .unwrap();
        let PolicyAction::SingBox(overlay) = decision.action.unwrap() else {
            panic!("expected a sing-box overlay");
        };
        let status = policy
            .record(
                Source::SingBox,
                overlay.effective,
                Err("candidate rejected".to_owned()),
                now,
            )
            .unwrap();
        assert_eq!(status.requested, Level::Error);
        assert_eq!(status.effective, Level::Default);
        assert_eq!(status.error.as_deref(), Some("candidate rejected"));
        assert!(policy.retry_due(now + Duration::seconds(1)).is_empty());
        let retry = policy.retry_due(now + RETRY_INTERVAL);
        assert_eq!(retry.len(), 1);
        assert_eq!(retry[0].reason, DecisionReason::Retry);
        // A retry was handed out, so the next tick is bounded again.
        assert!(
            policy
                .retry_due(now + RETRY_INTERVAL + Duration::seconds(1))
                .is_empty()
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_persisted_state_falls_back_to_the_local_baseline() {
        let dir = test_dir("corrupt");
        std::fs::write(dir.join("log-policy.json"), b"{not json").unwrap();
        let filter = RecordingFilter::new();
        let (policy, warnings) = LogPolicy::load(&dir, Level::Warn, filter.clone(), Utc::now());
        assert!(
            warnings
                .iter()
                .any(|warning| warning.contains("unreadable"))
        );
        assert_eq!(policy.target_level(Source::Agent), Level::Warn);
        assert_eq!(filter.levels(), vec![Level::Warn]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn agent_filter_failure_is_reported_without_losing_the_working_level() {
        let dir = test_dir("filter-failure");
        let filter = RecordingFilter::new();
        let policy = load(&dir, filter.clone());
        let now = Utc::now();
        let decision = policy
            .request(PolicyRequest::new(Source::Agent, 3, Level::Debug), now)
            .unwrap();
        let PolicyAction::Agent(level) = decision.action.unwrap() else {
            panic!("expected an agent action");
        };
        filter.fail_with("subscriber is unavailable");
        let status = policy.apply_agent(level, now).unwrap();
        assert_eq!(status.requested, Level::Debug);
        assert_eq!(status.effective, Level::Info);
        assert_eq!(status.error.as_deref(), Some("subscriber is unavailable"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn overlay_restores_the_generated_baseline_exactly() {
        let mut config = serde_json::json!({
            "log": {"level": "warn", "timestamp": true},
            "inbounds": []
        })
        .as_object()
        .unwrap()
        .clone();
        assert_eq!(LogPolicy::config_baseline(&config), Level::Warn);
        LogPolicy::apply_overlay(
            &mut config,
            LogOverlay {
                requested: Level::Trace,
                baseline: Level::Warn,
                effective: Level::Trace,
            },
        );
        assert_eq!(config["log"]["level"], "trace");
        assert_eq!(config["log"]["timestamp"], true);
        LogPolicy::apply_overlay(
            &mut config,
            LogOverlay {
                requested: Level::Default,
                baseline: Level::Warn,
                effective: Level::Warn,
            },
        );
        assert_eq!(config["log"]["level"], "warn");
        LogPolicy::apply_overlay(
            &mut config,
            LogOverlay {
                requested: Level::Default,
                baseline: Level::Default,
                effective: Level::Default,
            },
        );
        assert!(
            config["log"].get("level").is_none(),
            "an absent generated baseline stays absent"
        );

        // A broken `log` shape is repaired by the local overlay instead of
        // making the log policy unable to apply.
        let mut broken = serde_json::json!({"log": "not-an-object"})
            .as_object()
            .unwrap()
            .clone();
        LogPolicy::apply_overlay(
            &mut broken,
            LogOverlay {
                requested: Level::Debug,
                baseline: Level::Default,
                effective: Level::Debug,
            },
        );
        assert_eq!(broken["log"]["level"], "debug");
    }

    #[test]
    fn a_new_compiled_baseline_keeps_an_active_override() {
        let dir = test_dir("baseline");
        let policy = load(&dir, RecordingFilter::new());
        let now = Utc::now();
        policy
            .request(PolicyRequest::new(Source::SingBox, 1, Level::Trace), now)
            .unwrap();
        policy
            .set_singbox_baseline(Level::Error, now)
            .expect("baseline persists");
        let overlay = policy.overlay(now);
        assert_eq!(overlay.baseline, Level::Error);
        assert_eq!(overlay.effective, Level::Trace);
        let _ = std::fs::remove_dir_all(dir);
    }
}
