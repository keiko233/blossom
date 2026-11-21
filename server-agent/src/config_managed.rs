//! Typed V3 managed snapshot extension, runtime tag classification, byte-budget
//! enforcement, and agent-owned peer TLS / rule-set binding helpers (Task 07).
//!
//! The shared contract is `packages/contracts/src/agent-config-v3.ts` and the
//! TS-to-Rust compatibility fixture is
//! `packages/contracts/fixtures/agent-config-v3.snapshots.json`.
//!
//! Legacy snapshots omit `managed` and continue through the existing V3 apply
//! path unchanged. Snapshots carrying `managed` validate per-asset (`512 KiB`),
//! aggregate rule-set (`2 MiB`), preview (`6 MiB`) and wire (`8 MiB`) caps,
//! strip untrusted inline TLS/trust overrides and control-plane rule-set
//! paths/URLs from `singboxConfig`, and resolve only agent-owned local paths.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Task 08/09 consume the remaining managed contract helpers (peer deployment reporting, tag classification and byte forecasts)"
    )
)]

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest as _, Sha256};

use crate::certificate::{FULLCHAIN_FILE, GENERATION_DIR_PREFIX, PRIVATE_KEY_FILE};

/// V2 capability advertised once managed networking apply is enabled.
pub const MANAGED_NETWORKING_CAPABILITY: &str = "managed-networking-v1";

pub const MANAGED_SNAPSHOT_SCHEMA_VERSION: u64 = 1;
pub const MANAGED_STAGE_INTENT_SCHEMA_VERSION: u64 = 1;

/// Byte budgets defined by the Admin Networking Workspace specification.
pub const MAX_RULE_SET_ASSET_RAW_BYTES: usize = 512 * 1024;
pub const MAX_RULE_SET_AGGREGATE_RAW_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_ACTIVATION_PREVIEW_BYTES: usize = 6 * 1024 * 1024;
pub const MAX_WIRE_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;

pub const BUILTIN_DIRECT_OUTBOUND_TAG: &str = "direct";
pub const SUBSCRIBER_INBOUND_TAG_PREFIX: &str = "node-";
pub const PEER_INBOUND_TAG_PREFIX: &str = "peer-in-";
pub const PEER_OUTBOUND_TAG_PREFIX: &str = "peer-out-";
pub const DIRECT_PROFILE_TAG_PREFIX: &str = "direct-";
pub const RULE_SET_TAG_PREFIX: &str = "rule-set-";
pub const AGENT_OWNED_TAG_PREFIX: &str = "blossom-agent-";

/// Untrusted outbound TLS fields that must be stripped from the base config
/// before applying agent-owned peer trust bindings.
pub const UNTRUSTED_OUTBOUND_TLS_FIELDS: [&str; 9] = [
    "certificate",
    "certificate_path",
    "key",
    "key_path",
    "client_certificate",
    "client_certificate_path",
    "client_key",
    "client_key_path",
    "insecure",
];

/// Untrusted rule-set location fields that must be stripped from
/// `route.rule_set` entries before binding agent-staged `.srs` files.
pub const UNTRUSTED_RULE_SET_LOCATION_FIELDS: [&str; 3] = ["path", "url", "download_detour"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeTagKind<'a> {
    BuiltinDirect,
    SubscriberInbound(&'a str),
    PeerInbound(&'a str),
    PeerOutbound(&'a str),
    DirectProfile(&'a str),
    RuleSet(&'a str),
    AgentOwned(&'a str),
}

#[must_use]
pub fn classify_runtime_tag(tag: &str) -> Option<RuntimeTagKind<'_>> {
    if tag == BUILTIN_DIRECT_OUTBOUND_TAG {
        return Some(RuntimeTagKind::BuiltinDirect);
    }
    if let Some(purpose) = tag.strip_prefix(AGENT_OWNED_TAG_PREFIX) {
        return (!purpose.is_empty()).then_some(RuntimeTagKind::AgentOwned(purpose));
    }
    if let Some(id) = tag.strip_prefix(SUBSCRIBER_INBOUND_TAG_PREFIX) {
        return (!id.is_empty()).then_some(RuntimeTagKind::SubscriberInbound(id));
    }
    if let Some(id) = tag.strip_prefix(PEER_INBOUND_TAG_PREFIX) {
        return (!id.is_empty()).then_some(RuntimeTagKind::PeerInbound(id));
    }
    if let Some(id) = tag.strip_prefix(PEER_OUTBOUND_TAG_PREFIX) {
        return (!id.is_empty()).then_some(RuntimeTagKind::PeerOutbound(id));
    }
    if let Some(id) = tag.strip_prefix(DIRECT_PROFILE_TAG_PREFIX) {
        return (!id.is_empty()).then_some(RuntimeTagKind::DirectProfile(id));
    }
    if let Some(id) = tag.strip_prefix(RULE_SET_TAG_PREFIX) {
        return (!id.is_empty()).then_some(RuntimeTagKind::RuleSet(id));
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerTlsDirection {
    Inbound,
    Outbound,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerTlsOwnerKind {
    PeerInbound,
    PeerOutbound,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerTlsUsage {
    IdentityFullchainAndKey,
    PeerCaTrust,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedPeerTlsBinding {
    pub binding_id: String,
    pub runtime_tag: String,
    pub direction: PeerTlsDirection,
    pub owner_kind: PeerTlsOwnerKind,
    pub owner_id: String,
    pub certificate_id: String,
    pub generation: u64,
    pub fingerprint_sha256: String,
    pub server_name: String,
    pub usage: PeerTlsUsage,
}

impl ManagedPeerTlsBinding {
    #[must_use]
    pub fn expected_binding_id(&self) -> String {
        let direction = match self.direction {
            PeerTlsDirection::Inbound => "inbound",
            PeerTlsDirection::Outbound => "outbound",
        };
        let owner_kind = match self.owner_kind {
            PeerTlsOwnerKind::PeerInbound => "peer_inbound",
            PeerTlsOwnerKind::PeerOutbound => "peer_outbound",
        };
        format!(
            "peer-tls:{direction}:{owner_kind}:{}:{}:{}",
            self.owner_id, self.certificate_id, self.generation
        )
    }

    pub fn validate(&self) -> Result<(), ManagedContractError> {
        if self.owner_id.is_empty()
            || self.certificate_id.is_empty()
            || self.generation == 0
            || self.server_name.is_empty()
            || self.fingerprint_sha256.is_empty()
        {
            return Err(ManagedContractError::InvalidPeerTlsBinding(
                self.binding_id.clone(),
            ));
        }
        let (expected_owner, expected_tag, expected_usage) = match self.direction {
            PeerTlsDirection::Inbound => (
                PeerTlsOwnerKind::PeerInbound,
                format!("{PEER_INBOUND_TAG_PREFIX}{}", self.owner_id),
                PeerTlsUsage::IdentityFullchainAndKey,
            ),
            PeerTlsDirection::Outbound => (
                PeerTlsOwnerKind::PeerOutbound,
                format!("{PEER_OUTBOUND_TAG_PREFIX}{}", self.owner_id),
                PeerTlsUsage::PeerCaTrust,
            ),
        };
        if self.owner_kind != expected_owner
            || self.runtime_tag != expected_tag
            || self.usage != expected_usage
            || self.binding_id != self.expected_binding_id()
        {
            return Err(ManagedContractError::InvalidPeerTlsBinding(
                self.binding_id.clone(),
            ));
        }
        Ok(())
    }
}

/// Public-only certificate trust artifact for a self-signed peer outbound.
/// Never carries a private key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedPeerTrustArtifact {
    pub certificate_id: String,
    pub generation: u64,
    pub domains: Vec<String>,
    pub fingerprint_sha256: String,
    pub not_before: String,
    pub not_after: String,
    pub certificate_pem: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedPeerCertificateDeployment {
    pub binding_id: String,
    pub runtime_tag: String,
    pub direction: PeerTlsDirection,
    pub owner_kind: PeerTlsOwnerKind,
    pub owner_id: String,
    pub certificate_id: String,
    pub generation: u64,
    pub fingerprint_sha256: String,
    pub installed: bool,
    pub in_use: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_phase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

impl ManagedPeerCertificateDeployment {
    pub fn validate(&self) -> Result<(), ManagedContractError> {
        if self.in_use && !self.installed {
            return Err(ManagedContractError::InvalidPeerDeployment(
                self.binding_id.clone(),
            ));
        }
        let usage = match self.direction {
            PeerTlsDirection::Inbound => PeerTlsUsage::IdentityFullchainAndKey,
            PeerTlsDirection::Outbound => PeerTlsUsage::PeerCaTrust,
        };
        ManagedPeerTlsBinding {
            binding_id: self.binding_id.clone(),
            runtime_tag: self.runtime_tag.clone(),
            direction: self.direction,
            owner_kind: self.owner_kind,
            owner_id: self.owner_id.clone(),
            certificate_id: self.certificate_id.clone(),
            generation: self.generation,
            fingerprint_sha256: self.fingerprint_sha256.clone(),
            server_name: "deployment.internal".to_string(),
            usage,
        }
        .validate()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleSetFormat {
    Binary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuleSetBinding {
    pub runtime_tag: String,
    pub rule_set_id: String,
    pub version: String,
    pub format: RuleSetFormat,
    pub sha256: String,
    pub size_bytes: u64,
}

impl ManagedRuleSetBinding {
    pub fn validate(&self) -> Result<(), ManagedContractError> {
        if self.rule_set_id.is_empty()
            || self.version.is_empty()
            || self.runtime_tag != format!("{RULE_SET_TAG_PREFIX}{}", self.rule_set_id)
            || !is_lowercase_sha256_hex(&self.sha256)
        {
            return Err(ManagedContractError::InvalidRuleSetBinding(
                self.runtime_tag.clone(),
            ));
        }
        let size = usize::try_from(self.size_bytes).unwrap_or(usize::MAX);
        if size == 0 || size > MAX_RULE_SET_ASSET_RAW_BYTES {
            return Err(ManagedContractError::RuleSetAssetTooLarge {
                rule_set_id: self.rule_set_id.clone(),
                size_bytes: self.size_bytes,
                limit_bytes: MAX_RULE_SET_ASSET_RAW_BYTES,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuleSetArtifact {
    pub rule_set_id: String,
    pub version: String,
    pub format: RuleSetFormat,
    pub sha256: String,
    pub size_bytes: u64,
    pub content_base64: String,
}

impl ManagedRuleSetArtifact {
    /// Decodes the base64 payload and verifies its exact byte size (`<= 512 KiB`)
    /// and SHA-256 digest before staging.
    pub fn decode_and_verify(&self) -> Result<Vec<u8>, ManagedContractError> {
        let size = usize::try_from(self.size_bytes).unwrap_or(usize::MAX);
        if size == 0 || size > MAX_RULE_SET_ASSET_RAW_BYTES {
            return Err(ManagedContractError::RuleSetAssetTooLarge {
                rule_set_id: self.rule_set_id.clone(),
                size_bytes: self.size_bytes,
                limit_bytes: MAX_RULE_SET_ASSET_RAW_BYTES,
            });
        }
        if !is_lowercase_sha256_hex(&self.sha256) {
            return Err(ManagedContractError::InvalidRuleSetArtifact {
                rule_set_id: self.rule_set_id.clone(),
                reason: "sha256 must be 64 lowercase hex characters".to_string(),
            });
        }
        let decoded = STANDARD
            .decode(self.content_base64.as_bytes())
            .map_err(|_| ManagedContractError::InvalidRuleSetArtifact {
                rule_set_id: self.rule_set_id.clone(),
                reason: "contentBase64 is not valid standard base64".to_string(),
            })?;
        if decoded.len() != size {
            return Err(ManagedContractError::InvalidRuleSetArtifact {
                rule_set_id: self.rule_set_id.clone(),
                reason: format!(
                    "decoded size {} does not match advertised sizeBytes {}",
                    decoded.len(),
                    self.size_bytes
                ),
            });
        }
        let digest = hex::encode(Sha256::digest(&decoded));
        if digest != self.sha256 {
            return Err(ManagedContractError::InvalidRuleSetArtifact {
                rule_set_id: self.rule_set_id.clone(),
                reason: format!("sha256 mismatch: expected {}, got {digest}", self.sha256),
            });
        }
        Ok(decoded)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSnapshotExtension {
    pub schema_version: u64,
    pub config_version_id: String,
    pub intent_digest: String,
    pub managed_fingerprint: String,
    pub tls_bindings: Vec<ManagedPeerTlsBinding>,
    pub peer_trust_artifacts: Vec<ManagedPeerTrustArtifact>,
    pub rule_set_bindings: Vec<ManagedRuleSetBinding>,
    pub rule_set_artifacts: Vec<ManagedRuleSetArtifact>,
}

impl ManagedSnapshotExtension {
    pub fn validate(&self) -> Result<(), ManagedContractError> {
        if self.schema_version != MANAGED_SNAPSHOT_SCHEMA_VERSION
            || self.config_version_id.is_empty()
            || !is_prefixed_sha256(&self.intent_digest)
            || !is_prefixed_sha256(&self.managed_fingerprint)
        {
            return Err(ManagedContractError::InvalidExtensionHeader);
        }

        let mut seen_binding_ids = HashSet::new();
        let mut seen_inbound_tags = HashSet::new();
        for binding in &self.tls_bindings {
            binding.validate()?;
            if !seen_binding_ids.insert(binding.binding_id.as_str()) {
                return Err(ManagedContractError::InvalidPeerTlsBinding(
                    binding.binding_id.clone(),
                ));
            }
            if binding.direction == PeerTlsDirection::Inbound
                && !seen_inbound_tags.insert(binding.runtime_tag.as_str())
            {
                return Err(ManagedContractError::InvalidPeerTlsBinding(
                    binding.binding_id.clone(),
                ));
            }
        }

        let mut seen_rule_set_tags = HashSet::new();
        let artifact_keys: HashSet<(String, String)> = self
            .rule_set_artifacts
            .iter()
            .map(|artifact| (artifact.rule_set_id.clone(), artifact.version.clone()))
            .collect();
        for binding in &self.rule_set_bindings {
            binding.validate()?;
            if !seen_rule_set_tags.insert(binding.runtime_tag.as_str()) {
                return Err(ManagedContractError::InvalidRuleSetBinding(
                    binding.runtime_tag.clone(),
                ));
            }
            let key = (binding.rule_set_id.clone(), binding.version.clone());
            let Some(artifact) = self
                .rule_set_artifacts
                .iter()
                .find(|artifact| (artifact.rule_set_id.clone(), artifact.version.clone()) == key)
            else {
                return Err(ManagedContractError::Materialize(format!(
                    "rule-set binding {} has no artifact",
                    binding.runtime_tag
                )));
            };
            if artifact.format != binding.format
                || artifact.sha256 != binding.sha256
                || artifact.size_bytes != binding.size_bytes
            {
                return Err(ManagedContractError::InvalidRuleSetArtifact {
                    rule_set_id: binding.rule_set_id.clone(),
                    reason: "binding does not match its artifact".to_string(),
                });
            }
        }
        if artifact_keys.len() != self.rule_set_artifacts.len() {
            return Err(ManagedContractError::InvalidRuleSetArtifact {
                rule_set_id: "<duplicate>".to_string(),
                reason: "duplicate rule-set artifact identity".to_string(),
            });
        }

        let mut aggregate_bytes: usize = 0;
        for artifact in &self.rule_set_artifacts {
            let decoded = artifact.decode_and_verify()?;
            aggregate_bytes = aggregate_bytes.saturating_add(decoded.len());
            if aggregate_bytes > MAX_RULE_SET_AGGREGATE_RAW_BYTES {
                return Err(ManagedContractError::RuleSetAggregateTooLarge {
                    aggregate_bytes,
                    limit_bytes: MAX_RULE_SET_AGGREGATE_RAW_BYTES,
                });
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacySubscriberTlsBinding {
    pub node_id: String,
    pub inbound_tag: String,
    pub certificate_id: String,
    pub generation: u64,
    pub server_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3CertificateArtifact {
    pub certificate_id: String,
    pub generation: u64,
    pub domains: Vec<String>,
    pub fingerprint_sha256: String,
    pub not_before: String,
    pub not_after: String,
    pub certificate_pem: String,
    pub private_key_pem: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3AgentDirectives {
    pub config_poll_interval_seconds: i64,
    pub heartbeat_interval_seconds: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desired_agent_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desired_sing_box_version: Option<String>,
}

/// Shared V3 configuration document supporting both the legacy subscriber-only
/// payload and the additive `managed` single-unit snapshot extension.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigV3Document {
    pub api_version: u64,
    pub agent: V3AgentDirectives,
    pub desired_revision: String,
    pub materialized_node_ids: Vec<String>,
    pub singbox_config: Map<String, Value>,
    pub managed_tls_bindings: Vec<LegacySubscriberTlsBinding>,
    pub certificate_artifacts: Vec<V3CertificateArtifact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed: Option<ManagedSnapshotExtension>,
}

impl AgentConfigV3Document {
    pub fn decode_and_validate(bytes: &[u8]) -> Result<Self, ManagedContractError> {
        if bytes.len() > MAX_WIRE_SNAPSHOT_BYTES {
            return Err(ManagedContractError::WireCapExceeded {
                actual_bytes: bytes.len(),
                limit_bytes: MAX_WIRE_SNAPSHOT_BYTES,
            });
        }
        let doc: Self = serde_json::from_slice(bytes)
            .map_err(|error| ManagedContractError::InvalidJson(error.to_string()))?;
        if doc.api_version != 3 || doc.desired_revision.is_empty() {
            return Err(ManagedContractError::InvalidDocumentHeader);
        }
        if let Some(managed) = &doc.managed {
            managed.validate()?;
            doc.validate_managed_links(managed)?;
        }
        Ok(doc)
    }

    /// Every managed TLS binding must name the exact key-pair or public trust
    /// artifact that ships in the same document. The agent refuses to stage a
    /// candidate whose bindings and artifacts disagree.
    fn validate_managed_links(
        &self,
        managed: &ManagedSnapshotExtension,
    ) -> Result<(), ManagedContractError> {
        for binding in &managed.tls_bindings {
            let keypair = self.certificate_artifacts.iter().find(|artifact| {
                artifact.certificate_id == binding.certificate_id
                    && artifact.generation == binding.generation
                    && artifact.fingerprint_sha256 == binding.fingerprint_sha256
            });
            let public = managed.peer_trust_artifacts.iter().find(|artifact| {
                artifact.certificate_id == binding.certificate_id
                    && artifact.generation == binding.generation
                    && artifact.fingerprint_sha256 == binding.fingerprint_sha256
            });
            let present = match binding.direction {
                PeerTlsDirection::Inbound => keypair.is_some(),
                PeerTlsDirection::Outbound => public.is_some(),
            };
            if !present {
                return Err(ManagedContractError::Materialize(format!(
                    "peer TLS binding {} has no matching artifact",
                    binding.binding_id
                )));
            }
            if binding.direction == PeerTlsDirection::Outbound && public.is_some() {
                // A public trust artifact must never carry private key material;
                // the struct cannot express one, and the TS contract also omits it.
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManagedContractError {
    WireCapExceeded {
        actual_bytes: usize,
        limit_bytes: usize,
    },
    InvalidJson(String),
    InvalidDocumentHeader,
    InvalidExtensionHeader,
    InvalidPeerTlsBinding(String),
    InvalidPeerDeployment(String),
    InvalidRuleSetBinding(String),
    RuleSetAssetTooLarge {
        rule_set_id: String,
        size_bytes: u64,
        limit_bytes: usize,
    },
    RuleSetAggregateTooLarge {
        aggregate_bytes: usize,
        limit_bytes: usize,
    },
    InvalidRuleSetArtifact {
        rule_set_id: String,
        reason: String,
    },
    InvalidRuleSetFormat {
        rule_set_id: String,
    },
    Materialize(String),
    StageFailed {
        path: String,
        reason: String,
    },
}

impl std::fmt::Display for ManagedContractError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WireCapExceeded {
                actual_bytes,
                limit_bytes,
            } => write!(
                formatter,
                "snapshot of {actual_bytes} bytes exceeds wire cap of {limit_bytes} bytes"
            ),
            Self::InvalidJson(message) => write!(formatter, "invalid v3 snapshot JSON: {message}"),
            Self::InvalidDocumentHeader => write!(formatter, "invalid v3 snapshot header"),
            Self::InvalidExtensionHeader => write!(formatter, "invalid managed snapshot header"),
            Self::InvalidPeerTlsBinding(id) => {
                write!(formatter, "invalid peer TLS binding {id}")
            }
            Self::InvalidPeerDeployment(id) => {
                write!(formatter, "invalid peer certificate deployment {id}")
            }
            Self::InvalidRuleSetBinding(tag) => {
                write!(formatter, "invalid rule-set binding {tag}")
            }
            Self::RuleSetAssetTooLarge {
                rule_set_id,
                size_bytes,
                limit_bytes,
            } => write!(
                formatter,
                "rule-set {rule_set_id} is {size_bytes} bytes, exceeding {limit_bytes} byte limit"
            ),
            Self::RuleSetAggregateTooLarge {
                aggregate_bytes,
                limit_bytes,
            } => write!(
                formatter,
                "aggregate rule-set size {aggregate_bytes} exceeds {limit_bytes} byte limit"
            ),
            Self::InvalidRuleSetArtifact {
                rule_set_id,
                reason,
            } => write!(
                formatter,
                "invalid rule-set artifact {rule_set_id}: {reason}"
            ),
            Self::InvalidRuleSetFormat { rule_set_id } => {
                write!(formatter, "rule-set {rule_set_id} is not binary SRS data")
            }
            Self::Materialize(message) => {
                write!(
                    formatter,
                    "managed config materialization failed: {message}"
                )
            }
            Self::StageFailed { path, reason } => {
                write!(formatter, "failed to stage {path}: {reason}")
            }
        }
    }
}

impl std::error::Error for ManagedContractError {}

/// Strips untrusted TLS material, client keys, paths, and `insecure` overrides
/// from every outbound TLS object in a base sing-box config.
pub fn strip_untrusted_outbound_tls(config: &mut Map<String, Value>) {
    let Some(outbounds) = config.get_mut("outbounds").and_then(Value::as_array_mut) else {
        return;
    };
    for outbound in outbounds {
        let Some(tls) = outbound.get_mut("tls").and_then(Value::as_object_mut) else {
            continue;
        };
        for field in UNTRUSTED_OUTBOUND_TLS_FIELDS {
            tls.remove(field);
        }
    }
}

/// Strips control-plane filesystem paths and remote URLs from `route.rule_set`
/// entries so only agent-assigned local paths can be mounted.
pub fn strip_untrusted_rule_set_locations(config: &mut Map<String, Value>) {
    let Some(route) = config.get_mut("route").and_then(Value::as_object_mut) else {
        return;
    };
    let Some(rule_sets) = route.get_mut("rule_set").and_then(Value::as_array_mut) else {
        return;
    };
    for entry in rule_sets {
        let Some(object) = entry.as_object_mut() else {
            continue;
        };
        for field in UNTRUSTED_RULE_SET_LOCATION_FIELDS {
            object.remove(field);
        }
        object.insert("type".to_string(), Value::String("local".to_string()));
    }
}

/// Agent-owned local filesystem path for a staged public peer-trust CA bundle.
#[must_use]
pub fn local_peer_trust_ca_path(
    state_dir: &Path,
    certificate_id: &str,
    generation: u64,
) -> PathBuf {
    state_dir
        .join("peer-trust")
        .join(certificate_id)
        .join(format!("generation-{generation}"))
        .join("ca.pem")
}

/// Agent-owned local filesystem path for a digest-verified binary `.srs` asset.
#[must_use]
pub fn local_rule_set_srs_path(
    state_dir: &Path,
    rule_set_id: &str,
    version: &str,
    sha256: &str,
) -> PathBuf {
    state_dir
        .join("rule-sets")
        .join(rule_set_id)
        .join(format!("{version}-{sha256}.srs"))
}

/// One local file the applied configuration references. `sha256` is set for
/// digest-addressed rule-set assets; certificate files are checked for
/// presence because their generation directory is validated at stage time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedFileRef {
    pub path: PathBuf,
    pub sha256: Option<String>,
}

/// Local paths produced by staging the managed extension. They are retained
/// across rollback so the last-known-good configuration never loses an artifact
/// it still references. Task 08 owns retirement/GC after reverse-order cleanup.
#[derive(Debug, Default)]
pub struct StagedManagedArtifacts {
    pub peer_trust: HashMap<(String, u64), PathBuf>,
    /// One concatenated CA bundle per peer outbound trust binding tag. The
    /// pinned sing-box outbound TLS `certificate_path` is a single string, so
    /// overlapping trust generations are bundled atomically there.
    pub peer_trust_bundles: HashMap<String, PathBuf>,
    pub rule_sets: HashMap<(String, String, String), PathBuf>,
}

fn write_managed_file(path: &Path, bytes: &[u8]) -> Result<(), ManagedContractError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| ManagedContractError::StageFailed {
            path: parent.display().to_string(),
            reason: error.to_string(),
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).map_err(|error| {
                ManagedContractError::StageFailed {
                    path: parent.display().to_string(),
                    reason: error.to_string(),
                }
            })?;
        }
    }
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| ManagedContractError::StageFailed {
            path: path.display().to_string(),
            reason: error.to_string(),
        })?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| ManagedContractError::StageFailed {
            path: path.display().to_string(),
            reason: error.to_string(),
        })
}

/// Stages digest-verified public peer trust and binary rule-set assets under
/// the agent's own state directory. Nothing here writes control-plane paths.
pub fn stage_managed_artifacts(
    managed: &ManagedSnapshotExtension,
    state_dir: &Path,
) -> Result<StagedManagedArtifacts, ManagedContractError> {
    let mut staged = StagedManagedArtifacts::default();
    for artifact in &managed.peer_trust_artifacts {
        let path =
            local_peer_trust_ca_path(state_dir, &artifact.certificate_id, artifact.generation);
        write_managed_file(&path, artifact.certificate_pem.as_bytes())?;
        staged
            .peer_trust
            .insert((artifact.certificate_id.clone(), artifact.generation), path);
    }
    let mut bundles: HashMap<String, Vec<String>> = HashMap::new();
    for binding in &managed.tls_bindings {
        if binding.direction != PeerTlsDirection::Outbound {
            continue;
        }
        let artifact = managed
            .peer_trust_artifacts
            .iter()
            .find(|artifact| {
                artifact.certificate_id == binding.certificate_id
                    && artifact.generation == binding.generation
            })
            .ok_or_else(|| {
                ManagedContractError::Materialize(format!(
                    "peer outbound {} trust artifact is missing",
                    binding.runtime_tag
                ))
            })?;
        bundles
            .entry(binding.runtime_tag.clone())
            .or_default()
            .push(artifact.certificate_pem.clone());
    }
    for (tag, mut certificates) in bundles {
        certificates.sort();
        let bundle = certificates.join("\n");
        let digest = hex::encode(Sha256::digest(bundle.as_bytes()));
        let path = state_dir
            .join("peer-trust")
            .join(&tag)
            .join(format!("{digest}.pem"));
        write_managed_file(&path, bundle.as_bytes())?;
        staged.peer_trust_bundles.insert(tag, path);
    }
    for artifact in &managed.rule_set_artifacts {
        let raw = artifact.decode_and_verify()?;
        // The pinned sing-box binary only consumes SRS files. Refuse a
        // misplaced JSON/YAML rule-set before it reaches `sing-box check`.
        if raw.len() < 4 || &raw[..3] != b"SRS" {
            return Err(ManagedContractError::InvalidRuleSetFormat {
                rule_set_id: artifact.rule_set_id.clone(),
            });
        }
        let path = local_rule_set_srs_path(
            state_dir,
            &artifact.rule_set_id,
            &artifact.version,
            &artifact.sha256,
        );
        write_managed_file(&path, &raw)?;
        staged.rule_sets.insert(
            (
                artifact.rule_set_id.clone(),
                artifact.version.clone(),
                artifact.sha256.clone(),
            ),
            path,
        );
    }
    Ok(staged)
}

fn unique_object_mut<'a>(
    config: &'a mut Map<String, Value>,
    array: &str,
    tag: &str,
    kind: &str,
) -> Result<&'a mut Map<String, Value>, ManagedContractError> {
    let Some(values) = config.get_mut(array).and_then(Value::as_array_mut) else {
        return Err(ManagedContractError::Materialize(format!(
            "{kind} {tag}: base config has no {array} array"
        )));
    };
    let mut found = None;
    for (index, value) in values.iter_mut().enumerate() {
        if value.get("tag").and_then(Value::as_str) == Some(tag) {
            if found.is_some() {
                return Err(ManagedContractError::Materialize(format!(
                    "{kind} {tag} is duplicated in the base config"
                )));
            }
            found = Some(index);
        }
    }
    let Some(index) = found else {
        return Err(ManagedContractError::Materialize(format!(
            "{kind} {tag} is missing from the base config"
        )));
    };
    values[index]
        .as_object_mut()
        .ok_or_else(|| ManagedContractError::Materialize(format!("{kind} {tag} is not an object")))
}

/// Injects only agent-local paths for receiver identities, sender public trust
/// and rule-set artifacts. Every control-plane path was stripped by the caller.
/// `certificate_root` is the CertificateManager generation root; receiver
/// key-pairs are already staged there by the ordinary certificate path.
pub fn materialize_managed_config(
    config: &mut Map<String, Value>,
    managed: &ManagedSnapshotExtension,
    staged: &StagedManagedArtifacts,
    certificate_root: &Path,
) -> Result<Vec<ManagedFileRef>, ManagedContractError> {
    let mut refs = Vec::new();
    let mut outbound_trust: HashMap<String, String> = HashMap::new();

    for binding in &managed.tls_bindings {
        match binding.direction {
            PeerTlsDirection::Inbound => {
                let inbound =
                    unique_object_mut(config, "inbounds", &binding.runtime_tag, "inbound")?;
                let tls = inbound
                    .get_mut("tls")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| {
                        ManagedContractError::Materialize(format!(
                            "inbound {} has no tls object",
                            binding.runtime_tag
                        ))
                    })?;
                let generation_dir = certificate_root
                    .join(&binding.certificate_id)
                    .join(format!("{GENERATION_DIR_PREFIX}{}", binding.generation));
                let certificate_path = generation_dir.join(FULLCHAIN_FILE);
                let key_path = generation_dir.join(PRIVATE_KEY_FILE);
                tls.insert("enabled".into(), Value::Bool(true));
                tls.insert(
                    "server_name".into(),
                    Value::String(binding.server_name.clone()),
                );
                tls.insert(
                    "certificate_path".into(),
                    Value::String(certificate_path.to_string_lossy().into_owned()),
                );
                tls.insert(
                    "key_path".into(),
                    Value::String(key_path.to_string_lossy().into_owned()),
                );
                refs.push(ManagedFileRef {
                    path: certificate_path,
                    sha256: None,
                });
                refs.push(ManagedFileRef {
                    path: key_path,
                    sha256: None,
                });
            }
            PeerTlsDirection::Outbound => {
                if !staged.peer_trust_bundles.contains_key(&binding.runtime_tag) {
                    return Err(ManagedContractError::Materialize(format!(
                        "peer trust bundle for binding {} was not staged",
                        binding.binding_id
                    )));
                }
                let entry = outbound_trust
                    .entry(binding.runtime_tag.clone())
                    .or_insert_with(|| binding.server_name.clone());
                if entry != &binding.server_name {
                    return Err(ManagedContractError::Materialize(format!(
                        "outbound {} has conflicting TLS server names",
                        binding.runtime_tag
                    )));
                }
            }
        }
    }

    for (tag, server_name) in outbound_trust {
        let bundle = staged
            .peer_trust_bundles
            .get(&tag)
            .ok_or_else(|| {
                ManagedContractError::Materialize(format!(
                    "peer trust bundle for outbound {tag} was not staged"
                ))
            })?
            .clone();
        let outbound = unique_object_mut(config, "outbounds", &tag, "outbound")?;
        let tls = outbound
            .get_mut("tls")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| {
                ManagedContractError::Materialize(format!("outbound {tag} has no tls object"))
            })?;
        tls.insert("enabled".into(), Value::Bool(true));
        tls.insert("server_name".into(), Value::String(server_name));
        tls.insert(
            "certificate_path".into(),
            Value::String(bundle.to_string_lossy().into_owned()),
        );
        tls.remove("certificate");
        tls.remove("insecure");
        refs.push(ManagedFileRef {
            path: bundle,
            sha256: None,
        });
    }

    for binding in &managed.rule_set_bindings {
        let path = staged
            .rule_sets
            .get(&(
                binding.rule_set_id.clone(),
                binding.version.clone(),
                binding.sha256.clone(),
            ))
            .ok_or_else(|| {
                ManagedContractError::Materialize(format!(
                    "rule-set {} was not staged",
                    binding.runtime_tag
                ))
            })?;
        let route = config
            .get_mut("route")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| {
                ManagedContractError::Materialize("base config has no route object".to_string())
            })?;
        let Some(rule_sets) = route.get_mut("rule_set").and_then(Value::as_array_mut) else {
            return Err(ManagedContractError::Materialize(
                "base config has no route.rule_set array".to_string(),
            ));
        };
        let entry = rule_sets
            .iter_mut()
            .find(|entry| entry.get("tag").and_then(Value::as_str) == Some(&binding.runtime_tag))
            .ok_or_else(|| {
                ManagedContractError::Materialize(format!(
                    "rule-set {} is missing from route.rule_set",
                    binding.runtime_tag
                ))
            })?;
        let object = entry.as_object_mut().ok_or_else(|| {
            ManagedContractError::Materialize(format!(
                "rule-set {} is not an object",
                binding.runtime_tag
            ))
        })?;
        object.insert("type".into(), Value::String("local".to_string()));
        object.insert("format".into(), Value::String("binary".to_string()));
        object.insert(
            "path".into(),
            Value::String(path.to_string_lossy().into_owned()),
        );
        refs.push(ManagedFileRef {
            path: path.clone(),
            sha256: Some(binding.sha256.clone()),
        });
    }

    Ok(refs)
}

fn is_lowercase_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_prefixed_sha256(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .is_some_and(is_lowercase_sha256_hex)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::Value;

    use super::*;
    use crate::client::types;

    const SNAPSHOT_FIXTURES: &str =
        include_str!("../../packages/contracts/fixtures/agent-config-v3.snapshots.json");

    #[test]
    fn shared_v3_snapshot_fixtures_decode_and_enforce_contracts() {
        let fixture: Value = serde_json::from_str(SNAPSHOT_FIXTURES).unwrap();
        assert_eq!(fixture["apiVersion"].as_u64(), Some(3));
        assert_eq!(
            fixture["capability"].as_str(),
            Some(MANAGED_NETWORKING_CAPABILITY)
        );
        assert_eq!(
            fixture["stageIntent"]["schemaVersion"].as_u64(),
            Some(MANAGED_STAGE_INTENT_SCHEMA_VERSION)
        );
        assert_eq!(
            fixture["budgets"]["maxRuleSetAssetRawBytes"].as_u64(),
            Some(MAX_RULE_SET_ASSET_RAW_BYTES as u64)
        );
        assert_eq!(
            fixture["budgets"]["maxRuleSetAggregateRawBytes"].as_u64(),
            Some(MAX_RULE_SET_AGGREGATE_RAW_BYTES as u64)
        );
        assert_eq!(
            fixture["budgets"]["maxActivationPreviewBytes"].as_u64(),
            Some(MAX_ACTIVATION_PREVIEW_BYTES as u64)
        );
        assert_eq!(
            fixture["budgets"]["maxWireSnapshotBytes"].as_u64(),
            Some(MAX_WIRE_SNAPSHOT_BYTES as u64)
        );

        let snapshots = fixture["snapshots"].as_array().unwrap();
        assert!(snapshots.len() >= 4);

        for entry in snapshots {
            let name = entry["name"].as_str().unwrap();
            let expected = entry["expect"].as_str().unwrap();
            let kind = entry["kind"].as_str().unwrap();
            let bytes = serde_json::to_vec(&entry["document"]).unwrap();

            match expected {
                "ok" => {
                    // Legacy V3 response decoder compatibility check.
                    let generated: types::GetAgentConfigV3Response = serde_json::from_slice(&bytes)
                        .unwrap_or_else(|error| panic!("{name} progenitor decode: {error}"));
                    assert_eq!(generated.materialized_node_ids.len(), 1);

                    let decoded = AgentConfigV3Document::decode_and_validate(&bytes)
                        .unwrap_or_else(|error| panic!("{name} managed decode: {error}"));
                    if kind == "legacy" {
                        assert!(decoded.managed.is_none(), "{name}");
                        assert!(generated.managed.is_none(), "{name}");
                    } else {
                        let managed = decoded.managed.as_ref().expect(name);
                        assert_eq!(managed.schema_version, MANAGED_SNAPSHOT_SCHEMA_VERSION);
                        assert_eq!(managed.tls_bindings.len(), 2);
                        assert_eq!(managed.peer_trust_artifacts.len(), 1);
                        assert_eq!(managed.rule_set_bindings.len(), 1);
                        assert_eq!(managed.rule_set_artifacts.len(), 1);
                        let raw_srs = managed.rule_set_artifacts[0].decode_and_verify().unwrap();
                        assert_eq!(raw_srs.len(), 34);
                        assert_eq!(&raw_srs[..3], b"SRS");

                        // The generated decoder must expose the same extension
                        // through the shared OpenAPI component names.
                        let generated_managed = generated.managed.as_ref().expect(name);
                        assert_eq!(*generated_managed.schema_version, 1.0);
                        assert_eq!(generated_managed.tls_bindings.len(), 2);
                        assert_eq!(generated_managed.peer_trust_artifacts.len(), 1);
                        assert_eq!(generated_managed.rule_set_bindings.len(), 1);
                        assert_eq!(generated_managed.rule_set_artifacts.len(), 1);
                        assert_eq!(
                            generated_managed.config_version_id.to_string(),
                            managed.config_version_id
                        );
                    }
                }
                "invalid" => {
                    assert!(
                        AgentConfigV3Document::decode_and_validate(&bytes).is_err(),
                        "{name} should have been rejected"
                    );
                }
                other => panic!("unexpected fixture expectation {other}"),
            }
        }
    }

    #[test]
    fn sanitizes_untrusted_outbound_tls_and_rule_set_paths_and_builds_local_paths() {
        let fixture: Value = serde_json::from_str(SNAPSHOT_FIXTURES).unwrap();
        let managed_entry = fixture["snapshots"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == "managed-v3-single-unit")
            .unwrap();
        let bytes = serde_json::to_vec(&managed_entry["document"]).unwrap();
        let mut doc = AgentConfigV3Document::decode_and_validate(&bytes).unwrap();

        strip_untrusted_outbound_tls(&mut doc.singbox_config);
        strip_untrusted_rule_set_locations(&mut doc.singbox_config);

        let outbound_tls = doc.singbox_config["outbounds"][2]["tls"]
            .as_object()
            .unwrap();
        assert_eq!(outbound_tls["enabled"], Value::Bool(true));
        assert_eq!(
            outbound_tls["server_name"],
            Value::String("peer-b.internal.example.com".to_string())
        );
        for field in UNTRUSTED_OUTBOUND_TLS_FIELDS {
            assert!(
                !outbound_tls.contains_key(field),
                "untrusted outbound TLS field {field} remained"
            );
        }

        let rule_set_entry = doc.singbox_config["route"]["rule_set"][0]
            .as_object()
            .unwrap();
        assert_eq!(rule_set_entry["type"], Value::String("local".to_string()));
        for field in UNTRUSTED_RULE_SET_LOCATION_FIELDS {
            assert!(
                !rule_set_entry.contains_key(field),
                "untrusted rule-set field {field} remained"
            );
        }

        let state_dir = Path::new("/var/lib/blossom-agent");
        assert_eq!(
            local_peer_trust_ca_path(state_dir, "cert-peer-b", 5),
            Path::new("/var/lib/blossom-agent/peer-trust/cert-peer-b/generation-5/ca.pem")
        );
        assert_eq!(
            local_rule_set_srs_path(
                state_dir,
                "geoip-cn",
                "20261120",
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ),
            Path::new(
                "/var/lib/blossom-agent/rule-sets/geoip-cn/20261120-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.srs"
            )
        );
    }

    #[test]
    fn runtime_tag_classification_matches_domain_rules() {
        assert_eq!(
            classify_runtime_tag("direct"),
            Some(RuntimeTagKind::BuiltinDirect)
        );
        assert_eq!(
            classify_runtime_tag("node-n1"),
            Some(RuntimeTagKind::SubscriberInbound("n1"))
        );
        assert_eq!(
            classify_runtime_tag("peer-in-pin1"),
            Some(RuntimeTagKind::PeerInbound("pin1"))
        );
        assert_eq!(
            classify_runtime_tag("peer-out-pout1"),
            Some(RuntimeTagKind::PeerOutbound("pout1"))
        );
        assert_eq!(
            classify_runtime_tag("direct-dprof1"),
            Some(RuntimeTagKind::DirectProfile("dprof1"))
        );
        assert_eq!(
            classify_runtime_tag("rule-set-geoip-cn"),
            Some(RuntimeTagKind::RuleSet("geoip-cn"))
        );
        assert_eq!(
            classify_runtime_tag("blossom-agent-probe"),
            Some(RuntimeTagKind::AgentOwned("probe"))
        );
        assert_eq!(classify_runtime_tag("peer-in-"), None);
        assert_eq!(classify_runtime_tag("custom"), None);
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir()
                .join(format!("blossom-managed-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn managed_fixture_document() -> AgentConfigV3Document {
        let fixture: Value = serde_json::from_str(SNAPSHOT_FIXTURES).unwrap();
        let entry = fixture["snapshots"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == "managed-v3-single-unit")
            .unwrap();
        let bytes = serde_json::to_vec(&entry["document"]).unwrap();
        AgentConfigV3Document::decode_and_validate(&bytes).unwrap()
    }

    #[test]
    fn stages_managed_artifacts_and_materializes_only_local_paths() {
        let mut document = managed_fixture_document();
        let managed = document.managed.as_ref().unwrap();
        let dir = TempDir::new();
        let staged = stage_managed_artifacts(managed, &dir.0).unwrap();

        strip_untrusted_outbound_tls(&mut document.singbox_config);
        strip_untrusted_rule_set_locations(&mut document.singbox_config);
        let certificate_root = dir.0.join("certificates");
        let refs = materialize_managed_config(
            &mut document.singbox_config,
            managed,
            &staged,
            &certificate_root,
        )
        .unwrap();
        assert!(refs.iter().any(|entry| entry.sha256.is_some()));

        let inbound = &document.singbox_config["inbounds"][1]["tls"];
        assert_eq!(inbound["enabled"], Value::Bool(true));
        assert!(
            inbound["certificate_path"]
                .as_str()
                .unwrap()
                .starts_with(&dir.0.display().to_string())
        );
        assert!(
            inbound["key_path"]
                .as_str()
                .unwrap()
                .starts_with(&dir.0.display().to_string())
        );

        let outbound = &document.singbox_config["outbounds"][2]["tls"];
        let certificate_path = outbound["certificate_path"].as_str().unwrap();
        assert!(certificate_path.starts_with(&dir.0.display().to_string()));
        assert!(Path::new(certificate_path).exists());
        assert!(!outbound.as_object().unwrap().contains_key("insecure"));
        assert!(!outbound.as_object().unwrap().contains_key("certificate"));

        let rule_set = &document.singbox_config["route"]["rule_set"][0];
        assert_eq!(rule_set["format"], Value::String("binary".to_string()));
        assert!(
            rule_set["path"]
                .as_str()
                .unwrap()
                .starts_with(&dir.0.display().to_string())
        );
        assert_ne!(
            rule_set["path"].as_str().unwrap(),
            "/etc/untrusted/geoip-cn.srs"
        );
    }

    #[test]
    fn rejects_non_srs_rule_set_content_before_staging() {
        let mut document = managed_fixture_document();
        let managed = document.managed.as_mut().unwrap();
        managed.rule_set_artifacts[0].content_base64 = STANDARD.encode(b"abc");
        managed.rule_set_artifacts[0].size_bytes = 3;
        managed.rule_set_artifacts[0].sha256 = hex::encode(Sha256::digest(b"abc"));
        managed.rule_set_bindings[0].sha256 = managed.rule_set_artifacts[0].sha256.clone();
        managed.rule_set_bindings[0].size_bytes = 3;

        let dir = TempDir::new();
        assert!(matches!(
            stage_managed_artifacts(managed, &dir.0),
            Err(ManagedContractError::InvalidRuleSetFormat { .. })
        ));
    }

    #[test]
    fn peer_certificate_deployment_validates_parity_and_in_use_invariant() {
        let valid = ManagedPeerCertificateDeployment {
            binding_id: "peer-tls:outbound:peer_outbound:pout1:cert-peer-b:5".to_string(),
            runtime_tag: "peer-out-pout1".to_string(),
            direction: PeerTlsDirection::Outbound,
            owner_kind: PeerTlsOwnerKind::PeerOutbound,
            owner_id: "pout1".to_string(),
            certificate_id: "cert-peer-b".to_string(),
            generation: 5,
            fingerprint_sha256: "4444444444444444444444444444444444444444444444444444444444444444"
                .to_string(),
            installed: true,
            in_use: true,
            error_phase: None,
            error_message: None,
        };
        assert!(valid.validate().is_ok());

        let invalid = ManagedPeerCertificateDeployment {
            installed: false,
            in_use: true,
            ..valid
        };
        assert_eq!(
            invalid.validate().unwrap_err(),
            ManagedContractError::InvalidPeerDeployment(
                "peer-tls:outbound:peer_outbound:pout1:cert-peer-b:5".to_string()
            )
        );
    }
}
