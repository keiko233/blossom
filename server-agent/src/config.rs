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

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::certificate::{
    CertificateManager, CertificateRef, FULLCHAIN_FILE, GENERATION_DIR_PREFIX, PRIVATE_KEY_FILE,
};
use crate::client::{Client, types};

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
    active_node_ids: Vec<String>,
    applied_at: Option<chrono::DateTime<chrono::Utc>>,
    deployments: Vec<DeploymentRecord>,
}

pub struct ConfigManager {
    client: Client,
    certificate_manager: CertificateManager,
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
    pub fn new(client: Client, state_dir: PathBuf) -> Result<Self> {
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
        manager.recompute_installed_deployments();
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

    pub fn startup_error(&self) -> Option<&str> {
        self.startup_error.as_deref()
    }

    /// Forces the next fetch to re-apply instead of skipping, even for an equal
    /// revision. Used when startup preflight/launch fails so the agent cannot
    /// permanently skip a committed config that sing-box rejects.
    pub fn mark_needs_reapply(&mut self) {
        self.needs_reapply = true;
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
        let document = response.into_inner();
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
                    let message = sanitize_error(&error.to_string());
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
        if self.needs_reapply {
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
        let record = self.persisted.deployments.iter_mut().find(|record| {
            record.certificate_id == certificate_id && record.generation == generation
        });
        match record {
            Some(record) => {
                record.error_phase = Some(phase.to_string());
                record.error_message = Some(sanitize_error(message));
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
        self.persist_state()
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
        ApiEndpoint, DeploymentRecord, extract_api_endpoint, inject_api_service,
        materialize_bindings, sanitize_error, strip_base_tls_material, strip_untrusted_api,
    };
    use crate::certificate::StagedMaterial;
    use crate::client::types;

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
}
