//! Fetches the V3 desired-state document, reconciles certificate artifacts and
//! managed-TLS bindings into the base `singboxConfig`, and materializes it on
//! disk. The control plane validates the config; the agent owns the two pieces
//! that must be local and validated: the `api` service endpoint (loopback,
//! port and per-run secret chosen by the agent, never trusted from the
//! control plane) and managed certificate paths.
//!
//! Lifecycle rules enforced here:
//!
//! - `singboxConfig` is a base config. Every `managedTlsBinding` is matched by
//!   exact `inboundTag`, its artifact is looked up by exact `certificateId` +
//!   `generation`, and only local `certificate_path`/`key_path` are injected.
//!   Inline material and control-plane paths in the base config are never
//!   trusted.
//! - Artifacts are validated and staged to `generation-<n>` directories before
//!   the candidate is written, and the candidate is written before
//!   `sing-box check`. Active/LKG references only move after preflight passes.
//! - `installed` is reported as soon as material is staged and validated;
//!   `inUse` only after the candidate survives probation and is committed.
//! - An equal `desiredRevision` is skipped only while the active config still
//!   parses and every referenced generation/fingerprint still validates.
//!   Otherwise the agent self-heals and re-applies.

use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::Write;
use std::net::{SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::certificate::{
    CertificateManager, CertificateRef, FULLCHAIN_FILE, GENERATION_DIR_PREFIX, PRIVATE_KEY_FILE,
};
use crate::client::{Client, types};
use crate::log_policy::{
    Level as LogLevelPolicy, LogOverlay, LogPolicy, Source as LogSourcePolicy,
};
use crate::logs::{LogStore, SecretRegistryFull, SecretScope};
use crate::metering::InboundClassification;

#[path = "config_managed.rs"]
pub(crate) mod managed;

/// The agent always injects its own `api` service for traffic stats. The
/// secret is per agent run (OS CSPRNG), the port is any free loopback port;
/// the control plane's `experimental.v2ray_api` and any pre-existing `api`
/// service in the base config are stripped, never trusted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiEndpoint {
    pub addr: String,
    pub secret: Option<String>,
}

/// Generates the per-run api secret from the OS CSPRNG (32 raw bytes).
fn new_api_secret() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("OS CSPRNG failure");
    hex::encode(bytes)
}

/// Picks a free 127.0.0.1 port by binding a listener, reading its port and
/// dropping it. There is a tiny race between drop and the sing-box bind,
/// which is acceptable: sing-box would fail to start and the agent would
/// surface the error, rather than silently misconfigure.
fn free_loopback_port() -> u16 {
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .expect("cannot find a free loopback port");
    listener
        .local_addr()
        .expect("bound listener has an address")
        .port()
}

/// Strips control-plane-provided `experimental.v2ray_api` and any existing
/// `api` service from the base config: the agent owns both.
fn strip_untrusted_api(config: &mut serde_json::Map<String, serde_json::Value>) {
    if let Some(experimental) = config
        .get_mut("experimental")
        .and_then(serde_json::Value::as_object_mut)
    {
        experimental.remove("v2ray_api");
        if experimental.is_empty() {
            config.remove("experimental");
        }
    }
    if let Some(services) = config
        .get_mut("services")
        .and_then(serde_json::Value::as_array_mut)
    {
        services.retain(|service| {
            service.get("type").and_then(serde_json::Value::as_str) != Some("api")
        });
        if services.is_empty() {
            config.remove("services");
        }
    }
}

/// Injects the agent's `api` service with the given endpoint.
fn inject_api_service(
    config: &mut serde_json::Map<String, serde_json::Value>,
    addr: &str,
    secret: &str,
) {
    let (host, port) = addr.split_once(':').expect("api addr is host:port");
    let service = serde_json::json!({
        "type": "api",
        "listen": host,
        "listen_port": port.parse::<u16>().expect("valid api port"),
        "secret": secret,
    });
    let services = config
        .entry("services")
        .or_insert_with(|| serde_json::Value::Array(Vec::new()));
    if !services.is_array() {
        *services = serde_json::Value::Array(Vec::new());
    }
    services
        .as_array_mut()
        .expect("services is an array")
        .push(service);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentPolicy {
    pub config_poll_interval_seconds: u64,
    pub heartbeat_interval_seconds: u64,
    /// Version directives carried by the same polled document. A future
    /// WebSocket/SSE control channel can update these without changing the
    /// reconciler.
    pub desired_agent_version: Option<String>,
    pub desired_sing_box_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateConfig {
    pub revision: String,
    pub materialized_node_ids: Vec<String>,
    pub api_endpoint: ApiEndpoint,
    pub referenced_generations: Vec<CertificateRef>,
    /// Local overlay written into the candidate. A commit records this as the
    /// effective sing-box level; a later policy change stages another reload.
    pub log_level: LogLevelPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchStatus {
    Updated {
        policy: AgentPolicy,
        candidate: CandidateConfig,
    },
    Unchanged(AgentPolicy),
}

/// Structured reconcile failure mapped onto the top-level heartbeat error.
#[derive(Debug, Clone)]
pub struct ConfigError {
    pub phase: &'static str,
    pub code: &'static str,
    pub message: String,
    pub node_id: Option<String>,
}

impl ConfigError {
    pub fn new(
        phase: &'static str,
        code: &'static str,
        message: impl Into<String>,
        node_id: Option<String>,
    ) -> Self {
        Self {
            phase,
            code,
            message: message.into(),
            node_id,
        }
    }
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ConfigError {}

impl ApiEndpoint {
    /// Generates a per-run endpoint: a random secret from the OS CSPRNG and
    /// any free loopback port. Both are used for this agent run only; they
    /// persist inside the configs this run writes so a restart of the same
    /// agent (and its sing-box child) stays consistent, but they are never
    /// logged or reported upstream.
    pub fn generate() -> Self {
        Self {
            addr: format!("127.0.0.1:{}", free_loopback_port()),
            secret: Some(new_api_secret()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeploymentRecord {
    pub certificate_id: String,
    pub generation: u64,
    pub fingerprint_sha256: String,
    pub installed: bool,
    pub in_use: bool,
    pub error_phase: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PersistedState {
    applied_revision: Option<String>,
    /// True after a confirmed administrative disable tore the proxy down. The
    /// next enabled configuration must be applied before serving resumes.
    #[serde(default)]
    disabled: bool,
    active_node_ids: Vec<String>,
    applied_at: Option<chrono::DateTime<chrono::Utc>>,
    deployments: Vec<DeploymentRecord>,
}

pub struct ConfigManager {
    client: Client,
    certificate_manager: CertificateManager,
    logs: LogStore,
    log_policy: Arc<LogPolicy>,
    state_dir: PathBuf,
    active_path: PathBuf,
    candidate_path: PathBuf,
    last_good_path: PathBuf,
    state_path: PathBuf,
    observed_revision: Option<String>,
    persisted: PersistedState,
    api_endpoint: ApiEndpoint,
    needs_reapply: bool,
    startup_error: Option<String>,
}

impl ConfigManager {
    pub(crate) fn new(
        client: Client,
        state_dir: PathBuf,
        logs: LogStore,
        log_policy: Arc<LogPolicy>,
    ) -> Result<Self> {
        std::fs::create_dir_all(&state_dir)
            .with_context(|| format!("failed to create state dir {}", state_dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o700))?;
        }

        let active_path = state_dir.join("active.json");
        let candidate_path = state_dir.join("candidate.json");
        let last_good_path = state_dir.join("last-known-good.json");
        let state_path = state_dir.join("state.json");
        let persisted: PersistedState = std::fs::read(&state_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();

        let certificate_manager = CertificateManager::new(&state_dir)?;

        // Restore the authoritative committed config, repairing stale material
        // from generation storage. A malformed/escaped LKG must never be
        // promoted or launched; it is retained untouched for recovery.
        let mut startup_error = None;
        let startup_source = if last_good_path.exists() {
            Some(&last_good_path)
        } else if active_path.exists() && persisted.applied_revision.is_some() {
            Some(&active_path)
        } else {
            None
        };
        if let Some(source) = startup_source {
            match read_config_map(source).and_then(|mut config| {
                certificate_manager.repair_config(&mut config)?;
                write_config_atomic(&active_path, &config)?;
                if source == &last_good_path {
                    write_config_atomic(&last_good_path, &config)?;
                }
                Ok(())
            }) {
                Ok(()) => {}
                Err(error) => {
                    startup_error = Some(error.to_string());
                    let _ = std::fs::remove_file(&active_path);
                }
            }
        } else if active_path.exists() {
            startup_error = Some(
                "uncommitted active config was discarded because no last-known-good state exists"
                    .to_string(),
            );
            let _ = std::fs::remove_file(&active_path);
        }

        // The endpoint is per agent run; a config on disk still carries the
        // same endpoint from the run that wrote it, so restarts stay
        // consistent. The secret is never logged and never leaves this process.
        let api_endpoint = read_api_endpoint(&active_path).unwrap_or_else(ApiEndpoint::generate);
        let needs_reapply = startup_error.is_some();
        let mut manager = Self {
            client,
            certificate_manager,
            logs,
            log_policy,
            state_dir,
            active_path,
            candidate_path,
            last_good_path,
            state_path,
            observed_revision: None,
            persisted,
            api_endpoint,
            needs_reapply,
            startup_error,
        };
        if manager.persisted.disabled {
            // The teardown written before the last shutdown is the only
            // committed configuration a disabled agent may launch.
            let teardown = manager.teardown_config()?;
            write_config_atomic(&manager.active_path, &teardown)?;
            write_config_atomic(&manager.last_good_path, &teardown)?;
            // This local teardown is the trusted state until an enabled
            // authoritative document replaces it.
            manager.needs_reapply = false;
        }
        manager.recompute_installed_deployments();
        manager.refresh_credentials_or_warn();
        manager.adopt_legacy_log_baseline();
        if let Err(error) = manager.reapply_log_overlay() {
            warn!(
                "failed to restore the persisted log-level overlay before starting services: {error}"
            );
            let level = manager.log_policy.target_level(LogSourcePolicy::SingBox);
            manager.log_policy.record(
                LogSourcePolicy::SingBox,
                level,
                Err(error.to_string()),
                chrono::Utc::now(),
            );
        }
        Ok(manager)
    }

    pub fn config_path(&self) -> &PathBuf {
        &self.active_path
    }

    pub fn candidate_path(&self) -> &PathBuf {
        &self.candidate_path
    }

    pub fn has_active_config(&self) -> bool {
        self.active_path.exists()
    }

    pub fn observed_revision(&self) -> Option<&str> {
        self.observed_revision.as_deref()
    }

    pub fn applied_revision(&self) -> Option<&str> {
        self.persisted.applied_revision.as_deref()
    }

    pub fn active_node_ids(&self) -> &[String] {
        &self.persisted.active_node_ids
    }

    pub fn applied_at(&self) -> Option<chrono::DateTime<chrono::Utc>> {
        self.persisted.applied_at
    }

    pub fn api_endpoint(&self) -> &ApiEndpoint {
        &self.api_endpoint
    }

    /// Inbound classification of the committed active config. It is fixed by
    /// the generation on disk, never by the live connection stream.
    pub(crate) fn active_inbound_classification(&self) -> Result<Option<InboundClassification>> {
        if !self.active_path.exists() {
            return Ok(None);
        }
        let config = read_config_map(&self.active_path)?;
        InboundClassification::from_committed_config(&config)
            .map(Some)
            .map_err(|error| anyhow::anyhow!(error))
    }

    /// Inbound classification of the staged candidate, used when its
    /// generation is registered before a native trial.
    pub(crate) fn candidate_inbound_classification(&self) -> Result<InboundClassification> {
        let config = read_config_map(&self.candidate_path)?;
        InboundClassification::from_committed_config(&config)
            .map_err(|error| anyhow::anyhow!(error))
    }

    /// Registers the credentials of the running and staged configs plus any
    /// additional set, before a value can reach output or an error message.
    fn register_credentials<I>(&self, extra: I) -> Result<(), SecretRegistryFull>
    where
        I: IntoIterator<Item = String>,
    {
        let mut credentials = node_credentials_from_path(&self.active_path);
        credentials.extend(node_credentials_from_path(&self.candidate_path));
        credentials.extend(extra);
        credentials.sort();
        credentials.dedup();
        self.logs
            .replace_secrets(SecretScope::StatsApi, self.api_endpoint.secret.iter())?;
        self.logs
            .replace_secrets(SecretScope::NodeCredentials, credentials)
    }

    /// A registration overflow switches the buffer to fail-closed redaction, so
    /// it must never block the proxy. Surface it without a credential value.
    fn refresh_credentials_or_warn(&self) {
        self.register_credentials_or_warn(std::iter::empty());
    }

    fn register_credentials_or_warn<I>(&self, extra: I)
    where
        I: IntoIterator<Item = String>,
    {
        if let Err(error) = self.register_credentials(extra) {
            warn!(
                "node credential registration for retained-log redaction failed; captured text is fully redacted: {error}"
            );
        }
    }

    fn redacted_error(&self, message: &str) -> String {
        self.logs.redact_message(message)
    }

    /// Before the first policy file exists, the committed configuration is the
    /// only source of the generated baseline. After that, the persisted
    /// baseline wins so an override cannot be mistaken for a generated level.
    fn adopt_legacy_log_baseline(&self) {
        if self.log_policy.has_persisted_state() {
            return;
        }
        let Ok(config) = read_config_map(&self.active_path) else {
            return;
        };
        let baseline = LogPolicy::config_baseline(&config);
        if let Err(error) = self
            .log_policy
            .set_singbox_baseline(baseline, chrono::Utc::now())
        {
            warn!("failed to adopt the committed log baseline: {error}");
        }
    }

    /// Rewrites the committed and last-known-good configurations with the
    /// current local overlay. This runs before sing-box is started, so an
    /// expired override cannot survive a restart.
    pub(crate) fn reapply_log_overlay(&self) -> Result<()> {
        let now = chrono::Utc::now();
        let status = self.log_policy.status(LogSourcePolicy::SingBox, now);
        if status.error.is_some() {
            // A failed overlay must not overwrite the configuration that is
            // still serving. The supervision loop retries under its bound.
            return Ok(());
        }
        let overlay = self.log_policy.overlay(now);
        let mut applied = false;
        for path in [&self.active_path, &self.last_good_path] {
            let mut config = match read_config_map(path) {
                Ok(config) => config,
                Err(error) if path.exists() => return Err(error),
                Err(_) => continue,
            };
            LogPolicy::apply_overlay(&mut config, overlay);
            let bytes = serde_json::to_vec_pretty(&config)?;
            if std::fs::read(path).ok().as_deref() != Some(bytes.as_slice()) {
                write_secret_file(path, &bytes)?;
            }
            applied = true;
        }
        self.refresh_credentials_or_warn();
        if applied {
            let _ =
                self.log_policy
                    .record(LogSourcePolicy::SingBox, overlay.effective, Ok(()), now);
        }
        Ok(())
    }

    /// Stages the committed configuration with a new log overlay. The desired
    /// revision and node set are untouched; only the local `log.level` changes.
    pub(crate) fn stage_log_overlay(&self, overlay: LogOverlay) -> Result<()> {
        let mut config = read_config_map(&self.active_path)
            .context("cannot stage a log overlay without an active config")?;
        LogPolicy::apply_overlay(&mut config, overlay);
        let bytes = serde_json::to_vec_pretty(&config)?;
        write_secret_file(&self.candidate_path, &bytes)?;
        self.refresh_credentials_or_warn();
        Ok(())
    }

    /// Commits an applied log overlay to last-known-good without changing the
    /// desired revision, active node set or publish sequencing.
    pub(crate) fn commit_log_overlay(&mut self) -> Result<()> {
        replace_from(
            &self.active_path,
            &self.last_good_path,
            &self.state_dir.join("last-known-good.json.tmp"),
        )?;
        self.refresh_credentials_or_warn();
        self.persist_state()
    }

    pub fn startup_error(&self) -> Option<&str> {
        self.startup_error.as_deref()
    }

    /// Forces the next fetch to re-apply instead of skipping, even for an equal
    /// revision. Used when startup preflight/launch fails so the agent cannot
    /// permanently skip a committed config that sing-box rejects.
    pub fn mark_needs_reapply(&mut self) {
        self.needs_reapply = true;
    }

    /// True while the committed config must be re-applied before it is trusted
    /// again (startup preflight or launch failed).
    pub fn needs_reapply(&self) -> bool {
        self.needs_reapply
    }

    /// True after a confirmed administrative disablement. A later enabled
    /// snapshot must commit before the proxy can serve again.
    pub fn administratively_disabled(&self) -> bool {
        self.persisted.disabled
    }

    /// The applied identifier, but only while the committed configuration is
    /// enabled and trusted. A disabled server reports no applied revision so
    /// the control plane must send an authoritative enabled snapshot.
    pub fn served_revision(&self) -> Option<&str> {
        if self.persisted.disabled {
            return None;
        }
        self.persisted.applied_revision.as_deref()
    }

    /// Replaces the served proxy with a locally generated no-inbound teardown
    /// and then makes it last-known-good. This is called only after a
    /// authenticated control plane explicitly confirmed the server is disabled.
    pub fn apply_administrative_teardown(&mut self) -> Result<CandidateConfig> {
        let candidate = self.teardown_candidate()?;
        self.promote_candidate()?;
        replace_from(
            &self.active_path,
            &self.last_good_path,
            &self.state_dir.join("last-known-good.json.tmp"),
        )?;
        self.persisted.applied_revision = None;
        self.persisted.active_node_ids.clear();
        self.persisted.applied_at = Some(chrono::Utc::now());
        self.persisted.disabled = true;
        self.needs_reapply = false;
        self.recompute_installed_deployments();
        self.refresh_credentials_or_warn();
        self.persist_state()?;
        Ok(candidate)
    }

    /// The local no-inbound config used by a confirmed disable. It keeps only
    /// the agent-owned loopback stats service and the local log overlay.
    fn teardown_config(&self) -> Result<serde_json::Map<String, serde_json::Value>> {
        let mut config = serde_json::Map::new();
        config.insert(
            "log".to_string(),
            serde_json::json!({"level": "info", "timestamp": true}),
        );
        config.insert("inbounds".to_string(), serde_json::Value::Array(Vec::new()));
        config.insert(
            "outbounds".to_string(),
            serde_json::Value::Array(vec![serde_json::json!({"type": "direct"})]),
        );
        inject_api_service(
            &mut config,
            &self.api_endpoint.addr,
            self.api_endpoint.secret.as_deref().unwrap_or(""),
        );
        let overlay = self.log_policy.overlay(chrono::Utc::now());
        LogPolicy::apply_overlay(&mut config, overlay);
        Ok(config)
    }

    fn teardown_candidate(&self) -> Result<CandidateConfig> {
        let config = self.teardown_config()?;
        let serialized = serde_json::to_vec_pretty(&config)?;
        write_secret_file(&self.candidate_path, &serialized)?;
        self.refresh_credentials_or_warn();
        Ok(CandidateConfig {
            revision: "server-disabled".to_string(),
            materialized_node_ids: Vec::new(),
            api_endpoint: self.api_endpoint.clone(),
            referenced_generations: Vec::new(),
            log_level: self.log_policy.overlay(chrono::Utc::now()).effective,
        })
    }

    pub fn deployments(&self) -> &[DeploymentRecord] {
        &self.persisted.deployments
    }

    /// Re-derives `installed` (on-disk material still validates) and `inUse`
    /// (the active config references it) from durable state. Used at startup
    /// and after rollback so heartbeats stay truthful across restarts.
    fn recompute_installed_deployments(&mut self) {
        for record in &mut self.persisted.deployments {
            let reference = CertificateRef {
                certificate_id: record.certificate_id.clone(),
                generation: record.generation,
            };
            record.installed = self
                .certificate_manager
                .validate_generation_on_disk(&reference, Some(&record.fingerprint_sha256))
                .is_ok();
            // Runtime confirmation is process state, not a property of files on
            // disk. Startup and rollback always clear it until sing-box has
            // survived its health window against the active config.
            record.in_use = false;
        }
        if let Err(error) = self.persist_state() {
            warn!("failed to persist recomputed deployment state: {error:#}");
        }
    }

    pub fn set_runtime_confirmed(&mut self, confirmed: bool) {
        let referenced: HashSet<CertificateRef> = if confirmed {
            read_config_map(&self.active_path)
                .map(|config| {
                    self.certificate_manager
                        .referenced_generations(&config)
                        .into_iter()
                        .collect()
                })
                .unwrap_or_default()
        } else {
            HashSet::new()
        };
        let mut changed = false;
        for record in &mut self.persisted.deployments {
            let reference = CertificateRef {
                certificate_id: record.certificate_id.clone(),
                generation: record.generation,
            };
            let in_use = record.installed && referenced.contains(&reference);
            if record.in_use != in_use {
                record.in_use = in_use;
                changed = true;
            }
        }
        if changed && let Err(error) = self.persist_state() {
            warn!("failed to persist runtime certificate confirmation: {error:#}");
        }
    }

    pub async fn fetch(&mut self) -> Result<FetchStatus, ConfigError> {
        let response = self.client.get_agent_config_v3().await.map_err(|error| {
            ConfigError::new(
                "fetch",
                "CONFIG_FETCH_FAILED",
                format!("failed to fetch config: {error}"),
                None,
            )
        })?;
        self.compile_document(response.into_inner())
    }

    /// Compiles a v3 document received as a verified WebSocket snapshot. The
    /// caller has checked the body's digest. This also checks that the document
    /// is the revision the snapshot announced, so a mismatched body stages nothing.
    pub fn compile_snapshot(
        &mut self,
        body: &[u8],
        expected_revision: &str,
    ) -> Result<FetchStatus, ConfigError> {
        // Parse once into a value so node credentials can be registered before
        // a type error can echo an unexpected string value into the retained
        // buffer. A body that is not JSON at all only yields a position.
        let raw: serde_json::Value = serde_json::from_slice(body).map_err(|error| {
            ConfigError::new(
                "receive",
                "SNAPSHOT_INVALID",
                self.redacted_error(&format!("snapshot is not a v3 document: {error}")),
                None,
            )
        })?;
        if let Some(config) = raw
            .get("singboxConfig")
            .and_then(serde_json::Value::as_object)
        {
            self.register_credentials_or_warn(node_credentials(config));
        }
        let mut raw_candidates = Vec::new();
        raw_credential_candidates(&raw, &mut raw_candidates);
        self.register_credentials_or_warn(raw_candidates);
        let document: types::GetAgentConfigV3Response =
            serde_json::from_value(raw).map_err(|error| {
                ConfigError::new(
                    "receive",
                    "SNAPSHOT_INVALID",
                    self.redacted_error(&format!("snapshot is not a v3 document: {error}")),
                    None,
                )
            })?;
        if document.desired_revision.to_string() != expected_revision {
            return Err(ConfigError::new(
                "receive",
                "SNAPSHOT_REVISION_MISMATCH",
                "snapshot revision does not match the announced revision",
                None,
            ));
        }
        self.compile_document(document)
    }

    /// Compiles one v3 document into the candidate or skips it when the active
    /// config already matches. Shared by the HTTP poll and the WebSocket path.
    fn compile_document(
        &mut self,
        document: types::GetAgentConfigV3Response,
    ) -> Result<FetchStatus, ConfigError> {
        let policy = AgentPolicy {
            config_poll_interval_seconds: document
                .agent
                .config_poll_interval_seconds
                .clamp(5, 86_400) as u64,
            heartbeat_interval_seconds: document.agent.heartbeat_interval_seconds.clamp(5, 3_600)
                as u64,
            desired_agent_version: document
                .agent
                .desired_agent_version
                .as_ref()
                .map(|version| version.as_str().to_string()),
            desired_sing_box_version: document
                .agent
                .desired_sing_box_version
                .as_ref()
                .map(|version| version.as_str().to_string()),
        };
        let desired_revision = document.desired_revision.to_string();
        self.observed_revision = Some(desired_revision.clone());

        // Reconcile certificate artifacts into validated generation storage.
        let mut artifacts =
            std::collections::HashMap::<(String, u64), crate::certificate::StagedMaterial>::new();
        let mut validation_failure = None;
        for artifact in &document.certificate_artifacts {
            let key = (
                artifact.certificate_id.to_string(),
                artifact.generation.get(),
            );
            self.ensure_deployment(&key.0, key.1, artifact.fingerprint_sha256.as_str());
            match self.certificate_manager.stage(artifact) {
                Ok(material) => {
                    artifacts.insert(key, material.clone());
                    self.upsert_deployment(&material);
                }
                Err(error) => {
                    let message = self.redacted_error(&sanitize_error(&error.to_string()));
                    warn!(
                        certificate_id = artifact.certificate_id.as_str(),
                        generation = artifact.generation.get(),
                        "certificate artifact failed validation: {message}"
                    );
                    self.set_deployment_error(&key.0, key.1, "validation", &message);
                    validation_failure = Some(message);
                }
            }
        }
        if let Some(message) = validation_failure {
            self.persist_state().map_err(|error| {
                ConfigError::new("reconcile", "STATE_PERSIST_FAILED", error.to_string(), None)
            })?;
            return Err(ConfigError::new(
                "reconcile",
                "CERTIFICATE_VALIDATION_FAILED",
                format!("certificate artifact failed validation: {message}"),
                None,
            ));
        }

        // Materialize managed TLS bindings into the base config. Only local
        // generation paths are injected; inline material is stripped.
        let mut config = document.singbox_config;
        // Register node credentials from the incoming document before any
        // validation error can carry them into the retained buffer.
        self.register_credentials_or_warn(node_credentials(&config));
        strip_base_tls_material(&mut config);
        let (referenced_generations, binding_errors) = materialize_bindings(
            &mut config,
            &document.managed_tls_bindings,
            &artifacts,
            self.certificate_manager.root(),
        );
        if !binding_errors.is_empty() {
            for binding in &binding_errors {
                self.set_deployment_error(
                    &binding.certificate_id,
                    binding.generation,
                    "binding",
                    &binding.message,
                );
            }
            self.persist_state().map_err(|error| {
                ConfigError::new("reconcile", "STATE_PERSIST_FAILED", error.to_string(), None)
            })?;
            let first = &binding_errors[0];
            return Err(ConfigError::new(
                "reconcile",
                "MANAGED_TLS_BINDING_FAILED",
                format!(
                    "managed TLS binding for certificate {} generation {} failed: {}",
                    first.certificate_id, first.generation, first.message
                ),
                first.node_id.clone(),
            ));
        }

        strip_untrusted_api(&mut config);
        inject_api_service(
            &mut config,
            &self.api_endpoint.addr,
            self.api_endpoint.secret.as_deref().unwrap_or(""),
        );
        // The control-plane document supplies the generated baseline; the
        // local policy overlays only `log.level`. The desired revision and its
        // digest are already fixed above, so this never changes publish
        // sequencing.
        let baseline = LogPolicy::config_baseline(&config);
        if let Err(error) = self
            .log_policy
            .set_singbox_baseline(baseline, chrono::Utc::now())
        {
            warn!("failed to persist the compiled log baseline: {error}");
        }
        let overlay = self.log_policy.overlay(chrono::Utc::now());
        LogPolicy::apply_overlay(&mut config, overlay);
        let serialized = serde_json::to_vec_pretty(&config).map_err(|error| {
            ConfigError::new(
                "reconcile",
                "CONFIG_SERIALIZE_FAILED",
                error.to_string(),
                None,
            )
        })?;

        if self.can_skip(
            &desired_revision,
            &serialized,
            &referenced_generations,
            &artifacts,
        ) {
            let _ = self.log_policy.record(
                LogSourcePolicy::SingBox,
                overlay.effective,
                Ok(()),
                chrono::Utc::now(),
            );
            self.refresh_credentials_or_warn();
            self.persist_state().map_err(|error| {
                ConfigError::new("reconcile", "STATE_PERSIST_FAILED", error.to_string(), None)
            })?;
            return Ok(FetchStatus::Unchanged(policy));
        }

        write_secret_file(&self.candidate_path, &serialized).map_err(|error| {
            ConfigError::new(
                "reconcile",
                "CANDIDATE_WRITE_FAILED",
                error.to_string(),
                None,
            )
        })?;
        self.refresh_credentials_or_warn();
        self.persist_state().map_err(|error| {
            ConfigError::new("reconcile", "STATE_PERSIST_FAILED", error.to_string(), None)
        })?;
        info!(
            "candidate config for revision {desired_revision} written to {}",
            self.candidate_path.display()
        );

        Ok(FetchStatus::Updated {
            policy,
            candidate: CandidateConfig {
                revision: desired_revision,
                materialized_node_ids: document
                    .materialized_node_ids
                    .iter()
                    .map(|id| id.to_string())
                    .collect(),
                api_endpoint: self.api_endpoint.clone(),
                referenced_generations,
                log_level: overlay.effective,
            },
        })
    }

    /// A candidate may be skipped only when the active config still parses and
    /// every generation/fingerprint it references still validates on disk.
    fn can_skip(
        &self,
        desired_revision: &str,
        candidate_bytes: &[u8],
        references: &[CertificateRef],
        artifacts: &std::collections::HashMap<(String, u64), crate::certificate::StagedMaterial>,
    ) -> bool {
        if self.needs_reapply || self.persisted.disabled {
            return false;
        }
        if self.persisted.applied_revision.as_deref() != Some(desired_revision) {
            return false;
        }
        if !self.active_path.exists() {
            return false;
        }
        let Ok(active_bytes) = std::fs::read(&self.active_path) else {
            return false;
        };
        if active_bytes != candidate_bytes {
            return false;
        }
        for reference in references {
            let fingerprint = artifacts
                .get(&(reference.certificate_id.clone(), reference.generation))
                .map(|artifact| artifact.fingerprint_sha256.as_str());
            if self
                .certificate_manager
                .validate_generation_on_disk(reference, fingerprint)
                .is_err()
            {
                return false;
            }
        }
        true
    }

    fn ensure_deployment(
        &mut self,
        certificate_id: &str,
        generation: u64,
        fingerprint_sha256: &str,
    ) {
        if let Some(record) = self.persisted.deployments.iter_mut().find(|record| {
            record.certificate_id == certificate_id && record.generation == generation
        }) {
            if record.fingerprint_sha256 != fingerprint_sha256 {
                record.fingerprint_sha256 = fingerprint_sha256.to_owned();
                record.installed = false;
                record.in_use = false;
            }
            return;
        }
        self.persisted.deployments.push(DeploymentRecord {
            certificate_id: certificate_id.to_owned(),
            generation,
            fingerprint_sha256: fingerprint_sha256.to_owned(),
            installed: false,
            in_use: false,
            error_phase: None,
            error_message: None,
        });
    }

    fn upsert_deployment(&mut self, material: &crate::certificate::StagedMaterial) {
        let record = self.persisted.deployments.iter_mut().find(|record| {
            record.certificate_id == material.certificate_id
                && record.generation == material.generation
        });
        match record {
            Some(record) => {
                record.fingerprint_sha256 = material.fingerprint_sha256.clone();
                record.installed = true;
                record.error_phase = None;
                record.error_message = None;
            }
            None => self.persisted.deployments.push(DeploymentRecord {
                certificate_id: material.certificate_id.clone(),
                generation: material.generation,
                fingerprint_sha256: material.fingerprint_sha256.clone(),
                installed: true,
                in_use: false,
                error_phase: None,
                error_message: None,
            }),
        }
    }

    fn set_deployment_error(
        &mut self,
        certificate_id: &str,
        generation: u64,
        phase: &str,
        message: &str,
    ) {
        let message = self.redacted_error(&sanitize_error(message));
        let record = self.persisted.deployments.iter_mut().find(|record| {
            record.certificate_id == certificate_id && record.generation == generation
        });
        match record {
            Some(record) => {
                record.error_phase = Some(phase.to_string());
                record.error_message = Some(message);
            }
            None => {
                // No fingerprint known for an unstaged/unknown generation; the
                // top-level error carries the detail instead.
                warn!(
                    certificate_id = certificate_id,
                    generation = generation,
                    "binding error for unknown deployment: {message}"
                );
            }
        }
    }

    pub fn mark_candidate_error(
        &mut self,
        candidate: &CandidateConfig,
        phase: &str,
        message: &str,
    ) {
        for reference in &candidate.referenced_generations {
            self.set_deployment_error(
                &reference.certificate_id,
                reference.generation,
                phase,
                message,
            );
        }
        if let Err(error) = self.persist_state() {
            warn!("failed to persist candidate deployment error: {error:#}");
        }
    }

    /// Promotes the candidate to active and clears `inUse` for every
    /// deployment: nothing is in use until probation passes and the commit runs.
    pub fn promote_candidate(&mut self) -> Result<()> {
        std::fs::rename(&self.candidate_path, &self.active_path)
            .context("failed to promote candidate config")?;
        self.refresh_credentials_or_warn();
        for record in &mut self.persisted.deployments {
            record.in_use = false;
        }
        self.persist_state()
    }

    pub fn commit_applied(&mut self, candidate: &CandidateConfig) -> Result<()> {
        replace_from(
            &self.active_path,
            &self.last_good_path,
            &self.state_dir.join("last-known-good.json.tmp"),
        )?;
        self.persisted.applied_revision = Some(candidate.revision.clone());
        self.persisted.active_node_ids = candidate.materialized_node_ids.clone();
        self.persisted.applied_at = Some(chrono::Utc::now());
        self.api_endpoint = candidate.api_endpoint.clone();
        let referenced: HashSet<&CertificateRef> =
            candidate.referenced_generations.iter().collect();
        for record in &mut self.persisted.deployments {
            let reference = CertificateRef {
                certificate_id: record.certificate_id.clone(),
                generation: record.generation,
            };
            record.in_use = record.installed && referenced.contains(&reference);
        }
        self.persisted.deployments.retain(|record| {
            referenced.contains(&CertificateRef {
                certificate_id: record.certificate_id.clone(),
                generation: record.generation,
            })
        });
        self.needs_reapply = false;
        self.persisted.disabled = false;
        self.persist_state()?;
        if let Some(status) = self.log_policy.record(
            LogSourcePolicy::SingBox,
            candidate.log_level,
            Ok(()),
            chrono::Utc::now(),
        ) && status.pending
        {
            // The policy moved during probation; the supervision loop stages
            // the newer overlay through the same validated path.
            info!(
                requested = status.requested.as_str(),
                effective = status.effective.as_str(),
                "sing-box log policy changed during probation"
            );
        }
        Ok(())
    }

    pub fn rollback(&mut self) -> Result<bool> {
        if !self.last_good_path.exists() {
            if self.active_path.exists() {
                std::fs::remove_file(&self.active_path)
                    .context("failed to remove uncommitted active config")?;
            }
            self.persisted.applied_revision = None;
            self.persisted.active_node_ids.clear();
            self.persisted.applied_at = None;
            self.api_endpoint = ApiEndpoint::generate();
            self.recompute_installed_deployments();
            self.refresh_credentials_or_warn();
            return Ok(false);
        }
        replace_from(
            &self.last_good_path,
            &self.active_path,
            &self.state_dir.join("active.json.rollback"),
        )?;
        self.api_endpoint =
            read_api_endpoint(&self.active_path).unwrap_or_else(ApiEndpoint::generate);
        self.recompute_installed_deployments();
        // Last-known-good carries the overlay it was committed with. Rewriting
        // it here would reintroduce the overlay that just failed.
        self.refresh_credentials_or_warn();
        Ok(true)
    }

    fn persist_state(&self) -> Result<()> {
        let temp = self.state_dir.join("state.json.tmp");
        let bytes = serde_json::to_vec_pretty(&self.persisted)?;
        write_secret_file(&temp, &bytes)?;
        std::fs::rename(temp, &self.state_path).context("failed to persist agent state")
    }
}

#[derive(Debug)]
struct BindingError {
    certificate_id: String,
    generation: u64,
    message: String,
    node_id: Option<String>,
}

/// A V3 base config is never allowed to dictate certificate ownership. Strip
/// every inline, path, ACME, and provider field from every TLS object before
/// matching the explicit managed bindings. Unbound TLS therefore cannot retain
/// a legacy/manual certificate by accident.
fn strip_base_tls_material(config: &mut serde_json::Map<String, serde_json::Value>) {
    let Some(inbounds) = config
        .get_mut("inbounds")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    for inbound in inbounds {
        let Some(tls) = inbound
            .get_mut("tls")
            .and_then(serde_json::Value::as_object_mut)
        else {
            continue;
        };
        for field in crate::certificate::MANAGED_TLS_MATERIAL_FIELDS {
            tls.remove(field);
        }
    }
}

/// Matches each managed TLS binding to its inbound by exact tag and injects
/// only local generation paths into that inbound's TLS object. Returns the
/// referenced generations on success; every failure is collected so the caller
/// can record per-deployment errors.
fn materialize_bindings(
    config: &mut serde_json::Map<String, serde_json::Value>,
    bindings: &[types::GetAgentConfigV3ResponseManagedTlsBindingsItem],
    artifacts: &std::collections::HashMap<(String, u64), crate::certificate::StagedMaterial>,
    root: &Path,
) -> (Vec<CertificateRef>, Vec<BindingError>) {
    let mut errors = Vec::new();
    let mut referenced = Vec::new();
    let mut bound_tags = HashSet::new();
    for binding in bindings {
        let certificate_id = binding.certificate_id.to_string();
        let generation = binding.generation.get();
        let node_id = binding.node_id.to_string();
        let inbound_tag = binding.inbound_tag.to_string();
        if !bound_tags.insert(inbound_tag.clone()) {
            errors.push(BindingError {
                certificate_id,
                generation,
                message: format!("inbound tag {inbound_tag} has more than one managed binding"),
                node_id: Some(node_id),
            });
            continue;
        }
        let Some(_material) = artifacts.get(&(certificate_id.clone(), generation)) else {
            errors.push(BindingError {
                certificate_id,
                generation,
                message: "certificate artifact not provided for this binding".to_string(),
                node_id: Some(node_id),
            });
            continue;
        };
        let Some(inbounds) = config
            .get_mut("inbounds")
            .and_then(serde_json::Value::as_array_mut)
        else {
            errors.push(BindingError {
                certificate_id,
                generation,
                message: "base config has no inbounds array".to_string(),
                node_id: Some(node_id),
            });
            continue;
        };
        let matches = inbounds
            .iter()
            .enumerate()
            .filter(|(_, inbound)| {
                inbound.get("tag").and_then(serde_json::Value::as_str) == Some(inbound_tag.as_str())
            })
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            errors.push(BindingError {
                certificate_id,
                generation,
                message: if matches.is_empty() {
                    format!("inbound tag {inbound_tag} not found in base config")
                } else {
                    format!("inbound tag {inbound_tag} is duplicated in base config")
                },
                node_id: Some(node_id),
            });
            continue;
        }
        let inbound = &mut inbounds[matches[0]];
        let tls = inbound
            .get_mut("tls")
            .and_then(serde_json::Value::as_object_mut);
        let Some(tls) = tls else {
            errors.push(BindingError {
                certificate_id,
                generation,
                message: format!("inbound {inbound_tag} has no tls object to bind certificate to"),
                node_id: Some(node_id),
            });
            continue;
        };
        match binding.server_name.as_deref() {
            Some(server_name) => {
                tls.insert(
                    "server_name".into(),
                    serde_json::Value::String(server_name.to_owned()),
                );
            }
            None => {
                tls.remove("server_name");
            }
        }
        let generation_dir = root
            .join(&certificate_id)
            .join(format!("{GENERATION_DIR_PREFIX}{generation}"));
        tls.insert(
            "certificate_path".into(),
            serde_json::Value::String(
                generation_dir
                    .join(FULLCHAIN_FILE)
                    .to_string_lossy()
                    .into_owned(),
            ),
        );
        tls.insert(
            "key_path".into(),
            serde_json::Value::String(
                generation_dir
                    .join(PRIVATE_KEY_FILE)
                    .to_string_lossy()
                    .into_owned(),
            ),
        );
        referenced.push(CertificateRef {
            certificate_id,
            generation,
        });
    }
    (referenced, errors)
}

fn write_secret_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("failed to write {}", path.display()))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn replace_from(source: &Path, destination: &Path, temp: &Path) -> Result<()> {
    let bytes =
        std::fs::read(source).with_context(|| format!("failed to read {}", source.display()))?;
    write_secret_file(temp, &bytes)?;
    std::fs::rename(temp, destination)
        .with_context(|| format!("failed to replace {}", destination.display()))
}

fn node_credentials_from_path(path: &Path) -> Vec<String> {
    read_config_map(path)
        .map(|config| node_credentials(&config))
        .unwrap_or_default()
}

/// Credential strings carried by inbound `users` entries. `name` and
/// `username` identify a subscription and `flow` is a protocol mode; every
/// other string on a user is authentication material. Collecting by shape
/// covers protocol additions without a per-protocol secret table.
fn node_credentials(config: &serde_json::Map<String, serde_json::Value>) -> Vec<String> {
    let mut credentials = Vec::new();
    let Some(inbounds) = config.get("inbounds").and_then(serde_json::Value::as_array) else {
        return credentials;
    };
    for inbound in inbounds {
        let Some(users) = inbound.get("users").and_then(serde_json::Value::as_array) else {
            continue;
        };
        for user in users {
            let Some(user) = user.as_object() else {
                continue;
            };
            for (key, value) in user {
                if matches!(key.as_str(), "name" | "username" | "flow") {
                    continue;
                }
                if let Some(value) = value.as_str().filter(|value| !value.is_empty()) {
                    credentials.push(value.to_owned());
                }
            }
        }
    }
    credentials.sort();
    credentials.dedup();
    credentials
}

/// Best-effort credential extraction from a snapshot that may not match the
/// generated schema. A type error can echo an unexpected string value, so
/// sensitive keys are collected before `serde` turns the document into a
/// typed value. This never widens the redaction registry to ordinary config
/// text: only credential-shaped fields and a malformed `users` value count.
fn raw_credential_candidates(value: &serde_json::Value, out: &mut Vec<String>) {
    const CREDENTIAL_KEYS: &[&str] = &[
        "uuid",
        concat!("pass", "word"),
        "auth_str",
        "auth",
        "psk",
        "secret",
        "token",
        "private_key",
        "privatekeypem",
    ];
    match value {
        serde_json::Value::Object(map) => {
            for (key, value) in map {
                let lower = key.to_ascii_lowercase();
                if (CREDENTIAL_KEYS.contains(&lower.as_str())
                    || (lower == "users" && value.is_string()))
                    && let Some(secret) = value.as_str().filter(|value| !value.is_empty())
                {
                    out.push(secret.to_owned());
                }
                raw_credential_candidates(value, out);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                raw_credential_candidates(item, out);
            }
        }
        _ => {}
    }
}

fn read_config_map(path: &Path) -> Result<serde_json::Map<String, serde_json::Value>> {
    let bytes =
        std::fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_slice(&bytes).context("config is not a valid JSON object")
}

fn write_config_atomic(
    path: &Path,
    config: &serde_json::Map<String, serde_json::Value>,
) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(config)?;
    write_secret_file(path, &bytes)
}

fn read_api_endpoint(path: &Path) -> Option<ApiEndpoint> {
    let config = read_config_map(path).ok()?;
    extract_api_endpoint(&config)
}

fn extract_api_endpoint(
    config: &serde_json::Map<String, serde_json::Value>,
) -> Option<ApiEndpoint> {
    let services = config.get("services")?.as_array()?;
    let service = services
        .iter()
        .find(|service| service.get("type").and_then(serde_json::Value::as_str) == Some("api"))?;
    let listen = service.get("listen")?.as_str()?;
    let port = service.get("listen_port")?.as_u64()?;
    if port > u16::MAX as u64 {
        return None;
    }
    let secret = service
        .get("secret")
        .and_then(serde_json::Value::as_str)
        .filter(|secret| !secret.is_empty())
        .map(String::from);
    Some(ApiEndpoint {
        addr: format!("{listen}:{port}"),
        secret,
    })
}

fn sanitize_error(value: &str) -> String {
    value
        .replace(
            |character: char| character.is_control() && character != '\n',
            "",
        )
        .chars()
        .take(4096)
        .collect()
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::json;

    use super::{
        ApiEndpoint, ConfigManager, DeploymentRecord, FetchStatus, extract_api_endpoint,
        inject_api_service, materialize_bindings, node_credentials, sanitize_error,
        strip_base_tls_material, strip_untrusted_api, write_config_atomic,
    };
    use crate::certificate::StagedMaterial;
    use crate::client::types;
    use crate::log_policy::{Level as PolicyLevel, LogPolicy, RecordingFilter};

    fn test_policy(dir: &Path) -> std::sync::Arc<LogPolicy> {
        std::sync::Arc::new(
            LogPolicy::load(
                dir,
                PolicyLevel::Info,
                RecordingFilter::new(),
                chrono::Utc::now(),
            )
            .0,
        )
    }

    fn staged(certificate_id: &str, generation: u64) -> StagedMaterial {
        StagedMaterial {
            certificate_id: certificate_id.into(),
            generation,
            fingerprint_sha256: "fingerprint".into(),
        }
    }

    #[test]
    fn binding_injects_local_generation_paths_and_strips_inline() {
        let mut config = json!({
            "inbounds": [{
                "type": "vless",
                "tag": "node-edge",
                "tls": {
                    "enabled": true,
                    "server_name": "edge.example.com",
                    "certificate": ["stale-non-pem-certificate"],
                    "certificate_path": "/var/lib/blossom-agent/certificates/cert-1/current/fullchain.pem",
                    "key": ["stale-non-pem-key"],
                    "key_path": "/var/lib/blossom-agent/certificates/cert-1/current/private-key.pem"
                }
            }]
        })
        .as_object()
        .unwrap()
        .clone();

        let binding = types::GetAgentConfigV3ResponseManagedTlsBindingsItem {
            node_id: "node-edge".parse().unwrap(),
            inbound_tag: "node-edge".parse().unwrap(),
            certificate_id: "cert-1".parse().unwrap(),
            generation: std::num::NonZeroU64::new(2).unwrap(),
            server_name: Some("edge.example.com".to_string()),
        };
        let artifacts = [(("cert-1".to_string(), 2u64), staged("cert-1", 2))]
            .into_iter()
            .collect();

        strip_base_tls_material(&mut config);
        let (referenced, errors) = materialize_bindings(
            &mut config,
            std::slice::from_ref(&binding),
            &artifacts,
            Path::new("/custom/state/certificates"),
        );
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(referenced.len(), 1);

        let tls = config["inbounds"][0]["tls"].as_object().unwrap();
        assert_eq!(
            tls["certificate_path"],
            "/custom/state/certificates/cert-1/generation-2/fullchain.pem"
        );
        assert_eq!(
            tls["key_path"],
            "/custom/state/certificates/cert-1/generation-2/private-key.pem"
        );
        for field in ["certificate", "key", "acme", "certificate_provider"] {
            assert!(
                !tls.contains_key(field),
                "stale field {field} left in place"
            );
        }
    }

    #[test]
    fn binding_reports_missing_inbound_tag() {
        let mut config = json!({
            "inbounds": [{ "type": "vless", "tag": "other" }]
        })
        .as_object()
        .unwrap()
        .clone();
        let binding = types::GetAgentConfigV3ResponseManagedTlsBindingsItem {
            node_id: "node-edge".parse().unwrap(),
            inbound_tag: "node-edge".parse().unwrap(),
            certificate_id: "cert-1".parse().unwrap(),
            generation: std::num::NonZeroU64::new(1).unwrap(),
            server_name: None,
        };
        let artifacts = [(("cert-1".to_string(), 1u64), staged("cert-1", 1))]
            .into_iter()
            .collect();
        let (_referenced, errors) = materialize_bindings(
            &mut config,
            std::slice::from_ref(&binding),
            &artifacts,
            Path::new("/custom/state/certificates"),
        );
        assert_eq!(errors.len(), 1);
        assert!(
            errors[0]
                .message
                .contains("inbound tag node-edge not found")
        );
    }

    #[test]
    fn binding_reports_missing_artifact() {
        let mut config = json!({
            "inbounds": [{ "type": "vless", "tag": "node-edge", "tls": { "enabled": true } }]
        })
        .as_object()
        .unwrap()
        .clone();
        let binding = types::GetAgentConfigV3ResponseManagedTlsBindingsItem {
            node_id: "node-edge".parse().unwrap(),
            inbound_tag: "node-edge".parse().unwrap(),
            certificate_id: "cert-1".parse().unwrap(),
            generation: std::num::NonZeroU64::new(1).unwrap(),
            server_name: None,
        };
        let (_referenced, errors) = materialize_bindings(
            &mut config,
            std::slice::from_ref(&binding),
            &std::collections::HashMap::new(),
            Path::new("/custom/state/certificates"),
        );
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("artifact not provided"));
    }

    #[test]
    fn unbound_legacy_tls_material_is_stripped_from_base_config() {
        let mut config = json!({
            "inbounds": [{
                "tag": "manual",
                "tls": {
                    "certificate_path": "/etc/sing-box/fullchain.pem",
                    "key_path": "/etc/sing-box/private-key.pem"
                }
            }]
        })
        .as_object()
        .unwrap()
        .clone();
        strip_base_tls_material(&mut config);
        let (_referenced, errors) = materialize_bindings(
            &mut config,
            &[],
            &std::collections::HashMap::new(),
            Path::new("/custom/state/certificates"),
        );
        assert!(errors.is_empty());
        let tls = config["inbounds"][0]["tls"].as_object().unwrap();
        assert!(!tls.contains_key("certificate_path"));
        assert!(!tls.contains_key("key_path"));
    }

    #[test]
    fn injects_api_service_and_reads_it_back() {
        let mut config = json!({ "log": {} }).as_object().unwrap().clone();
        inject_api_service(&mut config, "127.0.0.1:39001", "secret-value");

        let endpoint = extract_api_endpoint(&config).expect("injected service is discoverable");
        assert_eq!(endpoint.addr, "127.0.0.1:39001");
        assert_eq!(endpoint.secret.as_deref(), Some("secret-value"));
        assert_eq!(config["services"][0]["type"], "api");
        assert_eq!(config["services"][0]["listen"], "127.0.0.1");
        assert_eq!(config["services"][0]["listen_port"], 39001);
        assert_eq!(config["services"][0]["secret"], "secret-value");
    }

    #[test]
    fn injected_endpoint_survives_a_serialization_round_trip() {
        let mut config = json!({}).as_object().unwrap().clone();
        inject_api_service(&mut config, "127.0.0.1:39002", "another-secret");
        let bytes = serde_json::to_vec_pretty(&config).unwrap();
        let reread: serde_json::Map<String, serde_json::Value> =
            serde_json::from_slice(&bytes).unwrap();
        let endpoint = extract_api_endpoint(&reread).unwrap();
        assert_eq!(endpoint.addr, "127.0.0.1:39002");
        assert_eq!(endpoint.secret.as_deref(), Some("another-secret"));
    }

    #[test]
    fn strip_removes_v2ray_api_and_foreign_api_services() {
        let mut config = json!({
            "experimental": {
                "v2ray_api": { "listen": "127.0.0.1:8080" },
                "clash_api": { "external_controller": "127.0.0.1:9090" }
            },
            "services": [
                { "type": "api", "listen": "0.0.0.0", "listen_port": 1, "secret": "attacker" },
                { "type": "ssm-api", "listen": "127.0.0.1", "listen_port": 2 }
            ]
        })
        .as_object()
        .unwrap()
        .clone();

        strip_untrusted_api(&mut config);

        let experimental = config["experimental"].as_object().unwrap();
        assert!(!experimental.contains_key("v2ray_api"));
        assert!(experimental.contains_key("clash_api"));
        let services = config["services"].as_array().unwrap();
        assert_eq!(services.len(), 1);
        assert_eq!(services[0]["type"], "ssm-api");
    }

    #[test]
    fn strip_removes_empty_containers() {
        let mut config = json!({
            "experimental": { "v2ray_api": { "listen": "127.0.0.1:8080" } },
            "services": [{ "type": "api" }]
        })
        .as_object()
        .unwrap()
        .clone();
        strip_untrusted_api(&mut config);
        assert!(!config.contains_key("experimental"));
        assert!(!config.contains_key("services"));
    }

    #[test]
    fn generated_secrets_are_random_and_endpoints_are_localhost() {
        let first = ApiEndpoint::generate();
        let second = ApiEndpoint::generate();
        assert!(first.addr.starts_with("127.0.0.1:"));
        assert_ne!(first.secret, second.secret);
        assert!(first.secret.as_ref().is_some_and(|s| s.len() >= 32));
    }

    #[test]
    fn read_api_endpoint_returns_none_without_a_service() {
        let config = json!({ "log": {} }).as_object().unwrap().clone();
        assert_eq!(extract_api_endpoint(&config), None);
    }

    #[test]
    fn sanitize_bounds_and_strips_control_bytes() {
        let input = format!("boom\x1b[31m{}", "x".repeat(10_000));
        let sanitized = sanitize_error(&input);
        assert!(sanitized.len() <= 4096);
        assert!(!sanitized.contains('\x1b'));
    }

    #[test]
    fn deployment_record_round_trips() {
        let record = DeploymentRecord {
            certificate_id: "cert-1".into(),
            generation: 3,
            fingerprint_sha256: "abc".into(),
            installed: true,
            in_use: true,
            error_phase: None,
            error_message: None,
        };
        let encoded = serde_json::to_string(&record).unwrap();
        let decoded: DeploymentRecord = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.certificate_id, "cert-1");
        assert!(decoded.in_use);
    }

    #[test]
    fn a_persisted_disable_is_migrated_as_absent() {
        use super::PersistedState;
        let legacy: PersistedState = serde_json::from_str(
            r#"{"applied_revision":"1:sha256:rev","active_node_ids":["node-1"],"applied_at":null,"deployments":[]}"#,
        )
        .unwrap();
        assert!(!legacy.disabled);
    }

    #[test]
    fn an_administrative_teardown_persists_and_blocks_startup_until_replaced() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".scratch")
            .join("tmp")
            .join(format!("blossom-disable-lifecycle-{suffix}"));
        std::fs::create_dir_all(&dir).unwrap();
        let _cleanup = TempDir(&dir);
        let logs = crate::logs::LogStore::default();
        let policy = test_policy(&dir);
        let mut manager = ConfigManager::new(
            crate::client::new_client("http://127.0.0.1:1/api", "test-token")
                .expect("client builds"),
            dir.clone(),
            logs,
            policy,
        )
        .expect("config manager builds");

        let document = json!({
            "agent": {"configPollIntervalSeconds": 60, "heartbeatIntervalSeconds": 30},
            "apiVersion": 3,
            "certificateArtifacts": [],
            "desiredRevision": "sha256:enabled-1",
            "managedTlsBindings": [],
            "materializedNodeIds": ["n1"],
            "singboxConfig": {
                "log": {"level": "info", "timestamp": true},
                "inbounds": [{"type": "socks", "listen": "127.0.0.1", "listen_port": 1080}]
            }
        });
        let body = serde_json::to_vec(&document).unwrap();
        let FetchStatus::Updated { candidate, .. } = manager
            .compile_snapshot(&body, "sha256:enabled-1")
            .expect("enabled config compiles")
        else {
            panic!("a new enabled config must stage");
        };
        manager.promote_candidate().unwrap();
        manager.commit_applied(&candidate).unwrap();

        let teardown = manager
            .apply_administrative_teardown()
            .expect("teardown persists");
        assert_eq!(teardown.revision, "server-disabled");
        assert!(manager.administratively_disabled());
        assert!(!manager.needs_reapply());
        assert!(manager.applied_revision().is_none());
        assert!(manager.served_revision().is_none());
        let active: serde_json::Value =
            serde_json::from_slice(&std::fs::read(manager.config_path()).unwrap()).unwrap();
        assert_eq!(active["inbounds"], json!([]));
        assert_eq!(active["outbounds"][0]["type"], "direct");
        let last_good: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("last-known-good.json")).unwrap())
                .unwrap();
        assert_eq!(last_good["inbounds"], json!([]));

        // A restart reconstructs the teardown rather than the previous
        // enabled last-known-good.
        let mut restarted = ConfigManager::new(
            crate::client::new_client("http://127.0.0.1:1/api", "test-token")
                .expect("client builds"),
            dir.clone(),
            crate::logs::LogStore::default(),
            test_policy(&dir),
        )
        .expect("config manager builds");
        assert!(restarted.administratively_disabled());
        assert!(!restarted.needs_reapply());
        assert!(restarted.served_revision().is_none());
        assert_eq!(
            std::fs::read(restarted.config_path()).unwrap(),
            serde_json::to_vec_pretty(&restarted.teardown_config().unwrap()).unwrap()
        );

        // A later enabled document is staged rather than skipped, and only
        // its validated commit clears the disable marker.
        let enabled_again = json!({
            "agent": {"configPollIntervalSeconds": 60, "heartbeatIntervalSeconds": 30},
            "apiVersion": 3,
            "certificateArtifacts": [],
            "desiredRevision": "sha256:enabled-2",
            "managedTlsBindings": [],
            "materializedNodeIds": ["n1"],
            "singboxConfig": {
                "log": {"level": "info", "timestamp": true},
                "inbounds": [{"type": "socks", "listen": "127.0.0.1", "listen_port": 1080}]
            }
        });
        let FetchStatus::Updated { candidate, .. } = restarted
            .compile_snapshot(
                &serde_json::to_vec(&enabled_again).unwrap(),
                "sha256:enabled-2",
            )
            .expect("enabled config compiles")
        else {
            panic!("a disabled agent must not skip a re-enable");
        };
        restarted.promote_candidate().unwrap();
        restarted.commit_applied(&candidate).unwrap();
        assert!(!restarted.administratively_disabled());
        assert_eq!(restarted.applied_revision(), Some("sha256:enabled-2"));
        assert_eq!(restarted.active_node_ids(), ["n1"]);
    }

    struct TempDir<'a>(&'a Path);

    impl Drop for TempDir<'_> {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.0);
        }
    }

    #[test]
    fn node_credentials_collect_auth_material_not_identities() {
        let config = json!({
            "inbounds": [
                {
                    "type": "vless",
                    "users": [{
                        "name": "node-1-sub-1",
                        "uuid": "uuid-credential",
                        "flow": "xtls-rprx-vision",
                        "level": 0
                    }]
                },
                {
                    "type": "trojan",
                    "users": [{"name": "node-2-sub-1", "password": "password-credential"}]
                },
                {
                    "type": "hysteria",
                    "users": [{"auth_str": "auth-credential"}]
                },
                {
                    "type": "socks",
                    "users": [{"username": "subscription-id"}]
                }
            ]
        });
        assert_eq!(
            node_credentials(config.as_object().unwrap()),
            vec![
                "auth-credential".to_owned(),
                "password-credential".to_owned(),
                "uuid-credential".to_owned()
            ]
        );
    }

    #[test]
    fn active_and_candidate_credentials_survive_rotation_and_rollback() {
        use std::time::{SystemTime, UNIX_EPOCH};

        use crate::logs::{LogLevel, LogSource, LogStore};

        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("blossom-cred-lifecycle-{suffix}"));
        std::fs::create_dir_all(&dir).unwrap();
        let logs = LogStore::default();
        let client = crate::client::new_client("http://127.0.0.1:1/api", "test-token")
            .expect("client builds");
        let mut manager = ConfigManager::new(client, dir.clone(), logs.clone(), test_policy(&dir))
            .expect("config manager builds");

        let active = json!({
            "inbounds": [{
                "type": "vless",
                "users": [{"name": "n1-s1", "uuid": "old-node-credential"}]
            }]
        });
        let candidate = json!({
            "inbounds": [{
                "type": "trojan",
                "users": [{"name": "n2-s1", "password": "new-node-credential"}]
            }]
        });
        let rollback = json!({
            "services": [{
                "type": "api",
                "listen": "127.0.0.1",
                "listen_port": 1,
                "secret": "lkg-stats-secret"
            }],
            "inbounds": [{
                "type": "hysteria2",
                "users": [{"auth_str": "lkg-node-credential"}]
            }]
        });
        write_config_atomic(manager.config_path(), active.as_object().unwrap()).unwrap();
        write_config_atomic(manager.candidate_path(), candidate.as_object().unwrap()).unwrap();
        manager.register_credentials(std::iter::empty()).unwrap();

        let stored = |text: &str| {
            logs.record(LogSource::SingBox, LogLevel::Error, 1, text);
            logs.resume(None, 100)
                .unwrap()
                .records
                .last()
                .unwrap()
                .text
                .clone()
        };
        assert_eq!(
            stored("outbound old-node-credential"),
            "outbound [REDACTED]"
        );
        assert_eq!(
            stored("outbound new-node-credential"),
            "outbound [REDACTED]"
        );

        manager.promote_candidate().unwrap();
        assert!(!manager.candidate_path().exists());
        assert_eq!(stored("active new-node-credential"), "active [REDACTED]");
        // The replaced active credentials stay redacted while a process that
        // used them could still be draining.
        assert_eq!(
            stored("draining old-node-credential"),
            "draining [REDACTED]"
        );

        write_config_atomic(
            &dir.join("last-known-good.json"),
            rollback.as_object().unwrap(),
        )
        .unwrap();
        assert!(manager.rollback().unwrap());
        assert_eq!(
            stored("rolled back lkg-node-credential"),
            "rolled back [REDACTED]"
        );
        assert_eq!(stored("still new-node-credential"), "still [REDACTED]");
        assert_eq!(stored("stats lkg-stats-secret"), "stats [REDACTED]");

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn compile_snapshot_overlays_log_level_without_moving_the_revision() {
        use std::time::{SystemTime, UNIX_EPOCH};

        use crate::log_policy::{PolicyRequest, Source as PolicySource};

        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("blossom-log-overlay-{suffix}"));
        std::fs::create_dir_all(&dir).unwrap();
        let logs = crate::logs::LogStore::default();
        let policy = test_policy(&dir);
        let now = chrono::Utc::now();
        policy
            .request(
                PolicyRequest::new(PolicySource::SingBox, 1, PolicyLevel::Trace),
                now,
            )
            .unwrap();
        let mut manager = ConfigManager::new(
            crate::client::new_client("http://127.0.0.1:1/api", "test-token")
                .expect("client builds"),
            dir.clone(),
            logs,
            policy.clone(),
        )
        .expect("config manager builds");

        let document = json!({
            "agent": {
                "configPollIntervalSeconds": 60,
                "heartbeatIntervalSeconds": 30
            },
            "apiVersion": 3,
            "certificateArtifacts": [],
            "desiredRevision": "sha256:rev-1",
            "managedTlsBindings": [],
            "materializedNodeIds": [],
            "singboxConfig": {
                "log": {"level": "warn", "timestamp": true},
                "inbounds": [{"type": "socks", "listen": "127.0.0.1", "listen_port": 1080}]
            }
        });
        let body = serde_json::to_vec(&document).unwrap();
        let fetched = manager
            .compile_snapshot(&body, "sha256:rev-1")
            .expect("snapshot compiles");
        let FetchStatus::Updated { candidate, .. } = fetched else {
            panic!("a new revision stages a candidate");
        };
        assert_eq!(candidate.revision, "sha256:rev-1");
        assert_eq!(candidate.log_level, PolicyLevel::Trace);
        let staged: serde_json::Value =
            serde_json::from_slice(&std::fs::read(manager.candidate_path()).unwrap()).unwrap();
        assert_eq!(staged["log"]["level"], "trace");
        assert_eq!(staged["log"]["timestamp"], true);
        assert_eq!(manager.observed_revision(), Some("sha256:rev-1"));
        assert_eq!(manager.applied_revision(), None);
        assert_eq!(
            policy.overlay(now).baseline,
            PolicyLevel::Warn,
            "the generated level is remembered as the baseline"
        );

        manager.promote_candidate().unwrap();
        manager.commit_applied(&candidate).unwrap();
        assert_eq!(manager.applied_revision(), Some("sha256:rev-1"));
        let active: serde_json::Value =
            serde_json::from_slice(&std::fs::read(manager.config_path()).unwrap()).unwrap();
        let last_good: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("last-known-good.json")).unwrap())
                .unwrap();
        assert_eq!(active["log"]["level"], "trace");
        assert_eq!(last_good["log"]["level"], "trace");

        // The override expires while the control plane is offline; the local
        // restoration rewrites both configurations before the next service
        // start and leaves the desired revision where it was.
        let later = now + chrono::Duration::minutes(30);
        let decisions = policy.expire(later);
        assert_eq!(decisions.len(), 1);
        policy
            .record(
                PolicySource::SingBox,
                policy.target_level_at(PolicySource::SingBox, later),
                Ok(()),
                later,
            )
            .unwrap();
        manager.reapply_log_overlay().unwrap();
        let active: serde_json::Value =
            serde_json::from_slice(&std::fs::read(manager.config_path()).unwrap()).unwrap();
        let last_good: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("last-known-good.json")).unwrap())
                .unwrap();
        assert_eq!(active["log"]["level"], "warn");
        assert_eq!(last_good["log"]["level"], "warn");
        assert_eq!(manager.applied_revision(), Some("sha256:rev-1"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn compile_snapshot_registers_new_node_credentials_for_retained_logs() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("blossom-log-redact-{suffix}"));
        std::fs::create_dir_all(&dir).unwrap();
        let logs = crate::logs::LogStore::default();
        let policy = test_policy(&dir);
        let mut manager = ConfigManager::new(
            crate::client::new_client("http://127.0.0.1:1/api", "test-token")
                .expect("client builds"),
            dir.clone(),
            logs.clone(),
            policy,
        )
        .expect("config manager builds");
        let secret = "synthetic-credential";
        let document = json!({
            "agent": {
                "configPollIntervalSeconds": 60,
                "heartbeatIntervalSeconds": 30
            },
            "apiVersion": 3,
            "certificateArtifacts": [],
            "desiredRevision": "sha256:rev-2",
            "managedTlsBindings": [],
            "materializedNodeIds": [],
            "singboxConfig": {
                "inbounds": [{
                    "type": "vless",
                    "listen": "127.0.0.1",
                    "listen_port": 1081,
                    "users": [{"name": "node-1-sub-1", "uuid": secret}]
                }]
            }
        });
        manager
            .compile_snapshot(&serde_json::to_vec(&document).unwrap(), "sha256:rev-2")
            .expect("snapshot compiles");
        // A candidate is not trusted yet, but its credentials are registered
        // before the process can emit an error mentioning them.
        assert_eq!(
            logs.redact_message(&format!("rejected credential {secret}")),
            "rejected credential [REDACTED]"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn malformed_snapshot_raw_values_are_collected_before_deserialization() {
        let users_secret = "synthetic-user-credential";
        let key_secret = "synthetic-private-key-body";
        let raw = json!({
            "singboxConfig": {"inbounds": [{"users": users_secret}]},
            "certificateArtifacts": [{"privateKeyPem": key_secret}]
        });
        let mut out = Vec::new();
        super::raw_credential_candidates(&raw, &mut out);
        assert!(out.iter().any(|value| value == users_secret), "{out:?}");
        assert!(out.iter().any(|value| value == key_secret), "{out:?}");
    }
}
