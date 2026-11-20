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
        reason = "Task 07 managed snapshot contract framework; live apply wiring follows Task 06"
    )
)]

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest as _, Sha256};

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
        for binding in &self.rule_set_bindings {
            binding.validate()?;
            if !seen_rule_set_tags.insert(binding.runtime_tag.as_str()) {
                return Err(ManagedContractError::InvalidRuleSetBinding(
                    binding.runtime_tag.clone(),
                ));
            }
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
        }
        Ok(doc)
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
                    } else {
                        let managed = decoded.managed.as_ref().expect(name);
                        assert_eq!(managed.schema_version, MANAGED_SNAPSHOT_SCHEMA_VERSION);
                        assert_eq!(managed.tls_bindings.len(), 2);
                        assert_eq!(managed.peer_trust_artifacts.len(), 1);
                        assert_eq!(managed.rule_set_bindings.len(), 1);
                        assert_eq!(managed.rule_set_artifacts.len(), 1);
                        let raw_srs = managed.rule_set_artifacts[0].decode_and_verify().unwrap();
                        assert_eq!(raw_srs, b"abc");
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
