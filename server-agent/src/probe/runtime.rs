//! Committed lifecycle for managed link probes.
//!
//! The source side owns no listener beyond the sing-box probe ingress injected
//! into the validated candidate. The destination side owns one fixed loopback
//! responder. It is bound from the committed config and the explicit probe
//! manifest, replaced only after the candidate is ready to serve, and restored
//! from the previous committed snapshot when a candidate never commits.
//!
//! A request can only prepare an executor from the currently committed config.
//! No request target, endpoint, outbound tag or credential is accepted from the
//! control plane; the manifest and committed config own all of those.

use chrono::Utc;
use tracing::{debug, warn};

use super::contract::{
    LinkProbeOutcome, LinkProbeRequest, LinkProbeResult, ManagedApplied, ManagedGeneration,
};
use super::executor::{HttpConnectProbeTransport, ProbeExecutionContext, ProbeExecutor};
use super::isolation::{ProbeCandidateBindings, validate_probe_bindings};
use super::manifest::{PROBE_RESPONDER_ENDPOINT, ProbeBindingError, resolve_bindings};
use super::responder::{ProbeError, ProbeResponder, ProbeResponderBinding};
use crate::config::{CandidateConfig, ConfigManager};

#[derive(Debug)]
pub(crate) enum ProbeRuntimeError {
    Config(String),
    Binding(ProbeBindingError),
    Responder(ProbeError),
}

impl std::fmt::Display for ProbeRuntimeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Config(error) => write!(formatter, "committed config is unavailable: {error}"),
            Self::Binding(error) => write!(formatter, "{error}"),
            Self::Responder(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for ProbeRuntimeError {}

impl From<anyhow::Error> for ProbeRuntimeError {
    fn from(error: anyhow::Error) -> Self {
        Self::Config(error.to_string())
    }
}

impl From<ProbeBindingError> for ProbeRuntimeError {
    fn from(error: ProbeBindingError) -> Self {
        Self::Binding(error)
    }
}

impl From<ProbeError> for ProbeRuntimeError {
    fn from(error: ProbeError) -> Self {
        Self::Responder(error)
    }
}

#[derive(Debug, Clone)]
struct ResponderSnapshot {
    seq: u64,
    fingerprint: String,
    bindings: Vec<ProbeResponderBinding>,
}

/// The destination-side responder plus the last committed snapshot needed to
/// restore it if a candidate fails before commit.
pub(crate) struct ProbeRuntime {
    responder: Option<ProbeResponder>,
    snapshot: Option<ResponderSnapshot>,
    committed: Option<ResponderSnapshot>,
}

impl ProbeRuntime {
    #[must_use]
    pub(crate) fn new() -> Self {
        Self {
            responder: None,
            snapshot: None,
            committed: None,
        }
    }

    /// Reports whether a destination responder is currently serving the
    /// committed generation.
    #[must_use]
    pub(crate) fn is_listening(&self) -> bool {
        self.responder.is_some()
    }

    /// Prepares destination readiness for a candidate that is about to be
    /// promoted. It binds the same fixed endpoint with the candidate generation
    /// so a post-commit probe cannot race a cold bind. A source-only candidate
    /// leaves the old responder alone until the commit or rollback sync.
    pub(crate) async fn prepare_candidate(
        &mut self,
        config: &ConfigManager,
        candidate: &CandidateConfig,
    ) -> Result<(), ProbeRuntimeError> {
        let Some(fingerprint) = candidate.managed_fingerprint.as_deref() else {
            return Ok(());
        };
        let Some(seq) = revision_seq(&candidate.revision) else {
            return Ok(());
        };
        let config_map = config.candidate_config_map()?;
        let resolved = resolve_bindings(&config_map, &candidate.managed_probe_bindings)?;
        if resolved.destinations.is_empty() {
            return Ok(());
        }
        let bindings = destination_bindings(&resolved.destinations, seq, fingerprint);
        if self.is_snapshot(&bindings, seq, fingerprint) {
            return Ok(());
        }
        let fallback = self.committed.clone();
        self.replace_responder(bindings, seq, fingerprint, fallback)
            .await
    }

    /// Reconciles the responder with the committed active config. Called at
    /// startup, after a commit, after rollback and after administrative
    /// teardown. A disabled or unmanaged empty state stops the responder.
    pub(crate) async fn sync_committed(
        &mut self,
        config: &ConfigManager,
    ) -> Result<(), ProbeRuntimeError> {
        let (Some(seq), Some(fingerprint)) =
            (config.served_revision_seq(), config.managed_fingerprint())
        else {
            self.stop();
            return Ok(());
        };
        let config_map = config.active_config_map()?;
        let configured = config.managed_probe_bindings();
        let resolved = resolve_bindings(&config_map, configured)?;
        if resolved.destinations.is_empty() {
            self.stop();
            return Ok(());
        }
        let bindings = destination_bindings(&resolved.destinations, seq, fingerprint);
        if self.is_snapshot(&bindings, seq, fingerprint) {
            self.committed = self.snapshot.clone();
            return Ok(());
        }
        let fallback = self.committed.clone();
        self.replace_responder(bindings, seq, fingerprint, fallback)
            .await?;
        self.committed = self.snapshot.clone();
        Ok(())
    }

    fn stop(&mut self) {
        if let Some(responder) = self.responder.take() {
            responder.finish();
        }
        self.snapshot = None;
        self.committed = None;
    }

    fn is_snapshot(&self, bindings: &[ProbeResponderBinding], seq: u64, fingerprint: &str) -> bool {
        self.responder.is_some()
            && self.snapshot.as_ref().is_some_and(|snapshot| {
                snapshot.seq == seq
                    && snapshot.fingerprint == fingerprint
                    && snapshot.bindings == bindings
            })
    }

    async fn replace_responder(
        &mut self,
        bindings: Vec<ProbeResponderBinding>,
        seq: u64,
        fingerprint: &str,
        fallback: Option<ResponderSnapshot>,
    ) -> Result<(), ProbeRuntimeError> {
        let previous = self.responder.take();
        self.snapshot = None;
        if let Some(previous) = previous {
            previous.shutdown().await;
        }
        match ProbeResponder::start(bindings.clone()).await {
            Ok(next) => {
                self.responder = Some(next);
                self.snapshot = Some(ResponderSnapshot {
                    seq,
                    fingerprint: fingerprint.to_string(),
                    bindings,
                });
                debug!(
                    bindings = self
                        .snapshot
                        .as_ref()
                        .map_or(0, |state| state.bindings.len()),
                    "managed probe responder ready"
                );
                Ok(())
            }
            Err(error) => {
                // The candidate never became ready. Rebind the previous
                // committed snapshot on the same fixed endpoint so a failed
                // stage does not leave the last-known-good responder cold.
                if let Some(snapshot) = fallback {
                    match ProbeResponder::start(snapshot.bindings.clone()).await {
                        Ok(restored) => {
                            self.responder = Some(restored);
                            self.snapshot = Some(snapshot.clone());
                            self.committed = Some(snapshot);
                        }
                        Err(restore_error) => {
                            warn!("cannot restore the previous probe responder: {restore_error}");
                        }
                    }
                }
                Err(ProbeRuntimeError::Responder(error))
            }
        }
    }
}

fn destination_bindings(
    destinations: &[super::manifest::ProbeDestinationBinding],
    seq: u64,
    fingerprint: &str,
) -> Vec<ProbeResponderBinding> {
    let committed = ManagedGeneration {
        desired_revision_seq: seq,
        managed_fingerprint: Some(fingerprint.to_string()),
    };
    destinations
        .iter()
        .map(|destination| ProbeResponderBinding {
            listen: PROBE_RESPONDER_ENDPOINT,
            local_server_id: destination.local_server_id.clone(),
            peer_identity: destination.identity.clone(),
            peer_credential: destination.peer_credential.clone(),
            committed: committed.clone(),
        })
        .collect()
}

/// What the source core should do for one request.
pub(crate) enum ProbeExecution {
    Run(ProbeExecutor),
    Finish(LinkProbeOutcome),
}

impl ProbeRuntime {
    /// Builds an executor from the currently committed config. Every failure
    /// becomes a closed result outcome; none reaches a network endpoint.
    pub(crate) fn prepare_execution(
        config: &ConfigManager,
        authenticated_server_id: &str,
        request: &LinkProbeRequest,
    ) -> Result<ProbeExecution, ProbeRuntimeError> {
        if request.validate().is_err() {
            return Ok(ProbeExecution::Finish(LinkProbeOutcome::Unsupported));
        }
        if request.is_expired(Utc::now()) {
            return Ok(ProbeExecution::Finish(LinkProbeOutcome::Expired));
        }
        let (Some(seq), Some(fingerprint)) =
            (config.served_revision_seq(), config.managed_fingerprint())
        else {
            return Ok(ProbeExecution::Finish(LinkProbeOutcome::Unsupported));
        };
        let config_map = config.active_config_map()?;
        let configured = config.managed_probe_bindings();
        let resolved = resolve_bindings(&config_map, configured)?;
        let Some(source) = resolved.source_for(
            &request.link_id,
            request.credential_generation,
            &request.destination.server_id,
        ) else {
            return Ok(ProbeExecution::Finish(LinkProbeOutcome::Unsupported));
        };
        if source
            .source_server_id
            .as_deref()
            .is_some_and(|server_id| server_id != authenticated_server_id)
            || source
                .destination_server_id
                .as_deref()
                .is_some_and(|server_id| server_id != request.destination.server_id)
        {
            return Ok(ProbeExecution::Finish(LinkProbeOutcome::ResponderMismatch));
        }
        let stats_endpoint = config.api_endpoint().addr.parse().map_err(|_| {
            ProbeRuntimeError::Binding(ProbeBindingError::Invalid("stats endpoint"))
        })?;
        let isolation = validate_probe_bindings(
            &config_map,
            &ProbeCandidateBindings {
                ingresses: &resolved.ingresses,
                responders: &resolved.responders,
                stats_endpoint,
            },
        );
        let transport =
            match HttpConnectProbeTransport::from_committed_config(&config_map, &source.ingress) {
                Ok(transport) => transport,
                Err(error) => {
                    warn!("link probe transport is unavailable: {error}");
                    return Ok(ProbeExecution::Finish(
                        LinkProbeOutcome::IsolationUnavailable,
                    ));
                }
            };
        let context = ProbeExecutionContext {
            source_server_id: source
                .source_server_id
                .clone()
                .unwrap_or_else(|| authenticated_server_id.to_string()),
            source_generation: ManagedGeneration {
                desired_revision_seq: seq,
                managed_fingerprint: Some(fingerprint.to_string()),
            },
            link_id: request.link_id.clone(),
            destination_server_id: source
                .destination_server_id
                .clone()
                .unwrap_or_else(|| request.destination.server_id.clone()),
            credential_generation: request.credential_generation,
        };
        Ok(ProbeExecution::Run(ProbeExecutor::new(
            context,
            Box::new(transport),
            isolation,
        )))
    }
}

/// Outcome for a request that never reached an executor. `applied` reports the
/// committed source generation when one exists; it is never fabricated.
#[must_use]
pub(crate) fn unavailable_result(
    config: &ConfigManager,
    request: &LinkProbeRequest,
    outcome: LinkProbeOutcome,
) -> LinkProbeResult {
    closed_result(request, outcome, applied_generation(config), None)
}

/// Builds the bounded result for an outcome that never produced an executor
/// result, including a post-execution error.
#[must_use]
pub(crate) fn closed_result(
    request: &LinkProbeRequest,
    outcome: LinkProbeOutcome,
    applied: ManagedApplied,
    latency_ms: Option<i64>,
) -> LinkProbeResult {
    LinkProbeResult {
        probe_id: request.probe_id.clone(),
        rollout_id: request.rollout_id.clone(),
        stage_ordinal: request.stage_ordinal,
        link_id: request.link_id.clone(),
        outcome,
        applied,
        latency_ms,
        completed_at: Utc::now(),
    }
}

#[must_use]
pub(crate) fn applied_generation(config: &ConfigManager) -> ManagedApplied {
    ManagedApplied {
        desired_revision_seq: config.served_revision_seq().unwrap_or(0),
        managed_fingerprint: config
            .served_revision()
            .and(config.managed_fingerprint())
            .map(str::to_string),
    }
}

fn revision_seq(revision: &str) -> Option<u64> {
    let (prefix, _) = revision.split_once(':')?;
    prefix.parse().ok()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::config::FetchStatus;
    use crate::log_policy::{Level as PolicyLevel, LogPolicy, RecordingFilter};
    use crate::logs::LogStore;

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new() -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "blossom-probe-runtime-state-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn policy(dir: &std::path::Path) -> Arc<LogPolicy> {
        Arc::new(
            LogPolicy::load(
                dir,
                PolicyLevel::Info,
                RecordingFilter::new(),
                chrono::Utc::now(),
            )
            .0,
        )
    }

    fn manager(dir: &std::path::Path) -> ConfigManager {
        ConfigManager::new(
            crate::client::new_client("http://127.0.0.1:1/api", "test-token")
                .expect("client builds"),
            dir.to_path_buf(),
            LogStore::default(),
            policy(dir),
        )
        .expect("config manager builds")
    }

    fn document(revision: &str, fingerprint: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "apiVersion": 3,
            "agent": {"configPollIntervalSeconds": 60, "heartbeatIntervalSeconds": 30},
            "desiredRevision": revision,
            "materializedNodeIds": [],
            "singboxConfig": {
                "log": {"level": "info", "timestamp": true},
                "dns": {"servers": [{"type": "local", "tag": "local-dns"}], "final": "local-dns"},
                "inbounds": [{
                    "type": "trojan",
                    "tag": "peer-in-pin1",
                    "listen": "127.0.0.1",
                    "listen_port": 9443,
                    "users": [{
                        "name": "blz.peer.1.6.1.link-11",
                        "password": "11111111-1111-1111-1111-111111111111"
                    }]
                }],
                "outbounds": [{"type": "direct", "tag": "direct"}],
                "route": {
                    "default_domain_resolver": "local-dns",
                    "rules": [],
                    "final": "direct"
                }
            },
            "managedTlsBindings": [],
            "certificateArtifacts": [],
            "managed": {
                "schemaVersion": 1,
                "configVersionId": "mcv-runtime-1",
                "intentDigest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
                "managedFingerprint": fingerprint,
                "tlsBindings": [],
                "peerTrustArtifacts": [],
                "ruleSetBindings": [],
                "ruleSetArtifacts": [],
                "probeBindings": [{
                    "linkId": "link-1",
                    "credentialGeneration": 1,
                    "sourceServerId": "srv-a",
                    "destinationServerId": "srv-b",
                    "destinationInboundTag": "peer-in-pin1"
                }]
            }
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn responder_follows_commit_rollback_and_administrative_teardown() {
        let dir = TempDir::new();
        let mut manager = manager(&dir.0);
        let first = "5:sha256:probe-one";
        let fingerprint_one =
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        manager
            .compile_snapshot(&document(first, fingerprint_one), first)
            .unwrap();
        let candidate = match manager.compile_snapshot(&document(first, fingerprint_one), first) {
            Ok(FetchStatus::Updated { candidate, .. }) => candidate,
            _ => panic!("first managed candidate must stage"),
        };
        // The second compile above saw the same bytes; promote the staged
        // candidate that was already written and commit it.
        manager.promote_candidate().unwrap();
        manager.commit_applied(&candidate).unwrap();

        let mut runtime = ProbeRuntime::new();
        runtime.sync_committed(&manager).await.unwrap();
        assert!(runtime.is_listening());

        let second = "6:sha256:probe-two";
        let fingerprint_two =
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let candidate = match manager
            .compile_snapshot(&document(second, fingerprint_two), second)
            .unwrap()
        {
            FetchStatus::Updated { candidate, .. } => candidate,
            _ => panic!("second managed candidate must stage"),
        };
        runtime
            .prepare_candidate(&manager, &candidate)
            .await
            .unwrap();
        assert!(runtime.is_listening(), "candidate responder is ready");

        // The second candidate never commits: sync must restore the active
        // first generation rather than keep answering for the candidate.
        runtime.sync_committed(&manager).await.unwrap();
        assert!(runtime.is_listening());
        assert_eq!(
            runtime.snapshot.as_ref().map(|snapshot| snapshot.seq),
            Some(5)
        );

        manager.apply_administrative_teardown().unwrap();
        runtime.sync_committed(&manager).await.unwrap();
        assert!(!runtime.is_listening(), "disable stops the responder");
    }
}
