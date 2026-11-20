//! Bounded link-probe request/result contract (Task 08).
//!
//! Field parity source: `packages/contracts/src/managed-link-probe.ts`.
//! The v2 codec registers these payloads as `link_probe.request` and
//! `link_probe.result`. This module only validates identifiers, generations,
//! lifetimes and the closed outcome set; it never carries endpoint details or
//! free-form error text.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Capability the control plane must see on both ends before issuing a probe.
pub(crate) const MANAGED_LINK_PROBE_CAPABILITY: &str = "managed-link-probe-v1";

/// Registered v2 message types.
pub(crate) const MANAGED_LINK_PROBE_REQUEST_TYPE: &str = "link_probe.request";
pub(crate) const MANAGED_LINK_PROBE_RESULT_TYPE: &str = "link_probe.result";

pub(crate) const MAX_LINK_PROBE_TTL_MS: i64 = 120_000;
pub(crate) const MAX_LINK_PROBE_LATENCY_MS: i64 = 60_000;
pub(crate) const MAX_LINK_PROBE_ID_CHARS: usize = 128;
const SHA256_PREFIX: &str = "sha256:";
const SHA256_HEX_CHARS: usize = 64;

/// Applied generation of one side of a managed link.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LinkProbeEndpoint {
    pub server_id: String,
    pub managed_fingerprint: String,
    pub min_revision_seq: u64,
}

/// One authenticated stage-scoped probe request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LinkProbeRequest {
    pub probe_id: String,
    pub rollout_id: String,
    pub stage_ordinal: u64,
    pub link_id: String,
    pub credential_generation: u64,
    pub source: LinkProbeEndpoint,
    pub destination: LinkProbeEndpoint,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

/// Closed outcome set. The string spelling is part of the control-plane
/// contract; unknown values are rejected by deserialization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LinkProbeOutcome {
    Succeeded,
    Timeout,
    ConnectFailed,
    TlsFailed,
    AuthRejected,
    ResponderMismatch,
    GenerationMismatch,
    Expired,
    IsolationUnavailable,
    Unsupported,
}

/// What the source agent had committed when it ran the probe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManagedApplied {
    pub desired_revision_seq: u64,
    pub managed_fingerprint: Option<String>,
}

/// Destination response over the fixed authenticated path. It carries only
/// correlation and the responder's committed generation; the source verifies
/// its HMAC before recording anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProbeResponse {
    pub probe_id: String,
    pub outcome: LinkProbeOutcome,
    pub destination: ManagedApplied,
    pub response_token: String,
}

/// Response fields covered by the responder HMAC. The token is not part of
/// its own input.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeResponseUnsigned<'a> {
    pub probe_id: &'a str,
    pub outcome: LinkProbeOutcome,
    pub destination: &'a ManagedApplied,
}

/// One authenticated probe result. No endpoint details and no free-form text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LinkProbeResult {
    pub probe_id: String,
    pub rollout_id: String,
    pub stage_ordinal: u64,
    pub link_id: String,
    pub outcome: LinkProbeOutcome,
    pub applied: ManagedApplied,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<i64>,
    pub completed_at: DateTime<Utc>,
}

/// A committed managed generation, before or after durable apply/probation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ManagedGeneration {
    pub desired_revision_seq: u64,
    pub managed_fingerprint: Option<String>,
}

impl ManagedGeneration {
    /// Success requires the applied generation to be at or above the required
    /// sequence floor with exactly the expected managed fingerprint.
    #[must_use]
    pub(crate) fn proves(&self, endpoint: &LinkProbeEndpoint) -> bool {
        self.desired_revision_seq >= endpoint.min_revision_seq
            && self.managed_fingerprint.as_deref() == Some(endpoint.managed_fingerprint.as_str())
    }

    #[must_use]
    pub(crate) fn applied(&self) -> ManagedApplied {
        ManagedApplied {
            desired_revision_seq: self.desired_revision_seq,
            managed_fingerprint: self.managed_fingerprint.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LinkProbeContractError {
    Identifier(&'static str),
    Fingerprint(&'static str),
    ServerIdentity,
    Lifetime,
    Latency,
}

impl std::fmt::Display for LinkProbeContractError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Identifier(field) => write!(formatter, "invalid probe {field}"),
            Self::Fingerprint(field) => {
                write!(formatter, "invalid managed fingerprint for {field}")
            }
            Self::ServerIdentity => {
                formatter.write_str("a link probe cannot target its own server")
            }
            Self::Lifetime => formatter.write_str("probe lifetime is outside its bound"),
            Self::Latency => formatter.write_str("probe latency is outside its bound"),
        }
    }
}

impl std::error::Error for LinkProbeContractError {}

impl LinkProbeRequest {
    pub(crate) fn check(&self) -> bool {
        self.validate().is_ok()
    }

    pub(crate) fn validate(&self) -> Result<(), LinkProbeContractError> {
        validate_identifier("probeId", &self.probe_id)?;
        validate_identifier("rolloutId", &self.rollout_id)?;
        validate_identifier("linkId", &self.link_id)?;
        if self.stage_ordinal == 0 || self.credential_generation == 0 {
            return Err(LinkProbeContractError::Lifetime);
        }
        self.source.validate("source")?;
        self.destination.validate("destination")?;
        if self.source.server_id == self.destination.server_id {
            return Err(LinkProbeContractError::ServerIdentity);
        }
        let ttl = self
            .expires_at
            .signed_duration_since(self.issued_at)
            .num_milliseconds();
        if ttl <= 0 || ttl > MAX_LINK_PROBE_TTL_MS {
            return Err(LinkProbeContractError::Lifetime);
        }
        Ok(())
    }

    #[must_use]
    pub(crate) fn is_expired(&self, now: DateTime<Utc>) -> bool {
        now >= self.expires_at
    }

    /// Bound passed to the network exchange: never beyond the request's
    /// deadline and never beyond the contract's maximum latency.
    #[must_use]
    pub(crate) fn exchange_budget(&self, now: DateTime<Utc>) -> std::time::Duration {
        let remaining_ms = self
            .expires_at
            .signed_duration_since(now)
            .num_milliseconds()
            .clamp(0, MAX_LINK_PROBE_LATENCY_MS);
        std::time::Duration::from_millis(u64::try_from(remaining_ms).unwrap_or(0))
    }
}

impl LinkProbeEndpoint {
    fn validate(&self, field: &'static str) -> Result<(), LinkProbeContractError> {
        validate_identifier(field, &self.server_id)?;
        validate_prefixed_sha256(field, &self.managed_fingerprint)
    }
}

impl LinkProbeResult {
    pub(crate) fn check(&self) -> bool {
        self.validate().is_ok()
    }

    pub(crate) fn validate(&self) -> Result<(), LinkProbeContractError> {
        validate_identifier("probeId", &self.probe_id)?;
        validate_identifier("rolloutId", &self.rollout_id)?;
        validate_identifier("linkId", &self.link_id)?;
        if self.stage_ordinal == 0 {
            return Err(LinkProbeContractError::Lifetime);
        }
        if let Some(latency) = self.latency_ms
            && !(0..=MAX_LINK_PROBE_LATENCY_MS).contains(&latency)
        {
            return Err(LinkProbeContractError::Latency);
        }
        if let Some(fingerprint) = &self.applied.managed_fingerprint {
            validate_prefixed_sha256("applied", fingerprint)?;
        }
        Ok(())
    }
}

fn validate_identifier(field: &'static str, value: &str) -> Result<(), LinkProbeContractError> {
    if value.is_empty()
        || value.encode_utf16().count() > MAX_LINK_PROBE_ID_CHARS
        || value.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(LinkProbeContractError::Identifier(field));
    }
    Ok(())
}

fn validate_prefixed_sha256(
    field: &'static str,
    value: &str,
) -> Result<(), LinkProbeContractError> {
    let Some(hex) = value.strip_prefix(SHA256_PREFIX) else {
        return Err(LinkProbeContractError::Fingerprint(field));
    };
    if hex.len() != SHA256_HEX_CHARS
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(LinkProbeContractError::Fingerprint(field));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, TimeZone as _};
    use serde_json::{Value, json};

    use super::*;

    fn fixture() -> LinkProbeRequest {
        serde_json::from_value(json!({
            "probeId": "probe-1",
            "rolloutId": "rollout-1",
            "stageOrdinal": 2,
            "linkId": "link-1",
            "credentialGeneration": 1,
            "source": {
                "serverId": "srv-a",
                "managedFingerprint": format!("sha256:{}", "a".repeat(64)),
                "minRevisionSeq": 20
            },
            "destination": {
                "serverId": "srv-b",
                "managedFingerprint": format!("sha256:{}", "b".repeat(64)),
                "minRevisionSeq": 10
            },
            "issuedAt": "2026-11-20T00:00:00.000Z",
            "expiresAt": "2026-11-20T00:01:00.000Z"
        }))
        .expect("fixture decodes")
    }

    #[test]
    fn field_parity_and_bounds_match_the_committed_contract() {
        let request = fixture();
        request.validate().expect("bounded request");

        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["stageOrdinal"], 2);
        assert_eq!(value["source"]["minRevisionSeq"], 20);
        assert_eq!(value["issuedAt"], "2026-11-20T00:00:00Z");

        let mut too_long = request.clone();
        too_long.expires_at = too_long.issued_at + Duration::milliseconds(120_001);
        assert_eq!(
            too_long.validate().unwrap_err(),
            LinkProbeContractError::Lifetime
        );

        let mut self_probe = request.clone();
        self_probe.destination.server_id = "srv-a".to_string();
        assert_eq!(
            self_probe.validate().unwrap_err(),
            LinkProbeContractError::ServerIdentity
        );

        let mut bad_id = request.clone();
        bad_id.link_id = "line\nbreak".to_string();
        assert!(bad_id.validate().is_err());

        let mut bad_fingerprint = request;
        bad_fingerprint.source.managed_fingerprint = "not-a-digest".to_string();
        assert!(bad_fingerprint.validate().is_err());
    }

    #[test]
    fn result_uses_the_closed_outcome_set_and_bounded_latency() {
        let result = LinkProbeResult {
            probe_id: "probe-1".to_string(),
            rollout_id: "rollout-1".to_string(),
            stage_ordinal: 2,
            link_id: "link-1".to_string(),
            outcome: LinkProbeOutcome::Succeeded,
            applied: ManagedApplied {
                desired_revision_seq: 21,
                managed_fingerprint: Some(format!("sha256:{}", "a".repeat(64))),
            },
            latency_ms: Some(42),
            completed_at: Utc
                .with_ymd_and_hms(2026, 11, 20, 0, 0, 5)
                .single()
                .expect("valid timestamp"),
        };
        result.validate().unwrap();
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["outcome"], "succeeded");

        let mut unknown: Value = serde_json::to_value(&result).unwrap();
        unknown["outcome"] = Value::String("connect refused by 10.0.0.2:443".to_string());
        assert!(serde_json::from_value::<LinkProbeResult>(unknown).is_err());

        let mut slow = result;
        slow.latency_ms = Some(MAX_LINK_PROBE_LATENCY_MS + 1);
        assert_eq!(
            slow.validate().unwrap_err(),
            LinkProbeContractError::Latency
        );
    }

    #[test]
    fn generation_proof_requires_the_exact_fingerprint_at_or_above_the_floor() {
        let endpoint = fixture().source;
        let fingerprint = endpoint.managed_fingerprint.clone();
        assert!(
            ManagedGeneration {
                desired_revision_seq: 20,
                managed_fingerprint: Some(fingerprint.clone()),
            }
            .proves(&endpoint)
        );
        assert!(
            !ManagedGeneration {
                desired_revision_seq: 19,
                managed_fingerprint: Some(fingerprint.clone()),
            }
            .proves(&endpoint)
        );
        assert!(
            !ManagedGeneration {
                desired_revision_seq: 25,
                managed_fingerprint: None,
            }
            .proves(&endpoint)
        );
        assert!(
            !ManagedGeneration {
                desired_revision_seq: 25,
                managed_fingerprint: Some(format!("sha256:{}", "c".repeat(64))),
            }
            .proves(&endpoint)
        );
    }
}
