//! Wire codec for agent WebSocket protocol v2 (`blossom-agent.v2`).
//!
//! The contract is `packages/contracts/src/agent-ws-v2.ts`, and the frames in
//! `packages/contracts/fixtures/agent-ws-v2.frames.json` are the shared
//! reference. Decoding follows the contract's order: size, JSON, envelope,
//! version, direction, then payload. A known type sent in the wrong direction
//! is rejected, and an unknown type decodes to [`Message::Unknown`] so a newer
//! control plane never breaks an older agent.
//!
//! Outbound frames are stamped with a millisecond `ts`, which the contract
//! requires. Payload structs are shared by both directions.

use std::fmt;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::ws::codec::{CertificateDeployment, UpdateStatusPayload};

/// The subprotocol the agent offers and requires to see echoed.
pub const SUBPROTOCOL: &str = "blossom-agent.v2";
/// The only envelope version this codec speaks.
pub const PROTOCOL_VERSION: u64 = 2;
/// Compile-time ceilings. The control plane's `welcome.limits` may only
/// tighten them, never raise them.
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
pub const SNAPSHOT_CHUNK_BYTES: usize = 64 * 1024;
pub const MAX_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;
/// Base64 length of one full chunk: `ceil(chunk / 3) * 4`.
pub const SNAPSHOT_CHUNK_BASE64_LEN: usize = SNAPSHOT_CHUNK_BYTES.div_ceil(3) * 4;

const AGENT_TYPES: &[&str] = &[
    "hello",
    "agent.status",
    "config.get",
    "config.ack",
    "traffic.report",
];
const CONTROL_TYPES: &[&str] = &[
    "welcome",
    "agent.status.ack",
    "config.notify",
    "config.snapshot.begin",
    "config.snapshot.chunk",
    "config.snapshot.end",
    "config.snapshot.error",
    "traffic.ack",
    "error",
];

/// The side that produced a frame. The receiver is the other side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sender {
    Agent,
    ControlPlane,
}

/// A frame the receiver must reject. [`DecodeError::code`] names the contract's
/// parse error, as the fixtures spell it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    FrameTooLarge,
    InvalidJson,
    InvalidEnvelope,
    UnsupportedVersion,
    InvalidDirection(String),
    InvalidPayload(String),
}

impl DecodeError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::FrameTooLarge => "frame-too-large",
            Self::InvalidJson => "invalid-json",
            Self::InvalidEnvelope => "invalid-envelope",
            Self::UnsupportedVersion => "unsupported-version",
            Self::InvalidDirection(_) => "invalid-direction",
            Self::InvalidPayload(_) => "invalid-payload",
        }
    }
}

impl fmt::Display for DecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDirection(message_type) | Self::InvalidPayload(message_type) => {
                write!(formatter, "{} ({message_type})", self.code())
            }
            _ => formatter.write_str(self.code()),
        }
    }
}

impl std::error::Error for DecodeError {}

/// A decoded frame: the correlation id it carried and its typed message.
#[derive(Debug, Clone, PartialEq)]
pub struct Decoded {
    pub id: Option<String>,
    pub message: Message,
}

/// Typed messages. Agent-to-control-plane and control-plane-to-agent types
/// share one enum so the codec tests can check both directions.
#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    Hello(Hello),
    StatusReport(StatusReport),
    ConfigGet(ConfigGet),
    ConfigAck(ConfigAck),
    TrafficReport(TrafficReport),
    Welcome(Welcome),
    StatusAck(StatusAck),
    ConfigNotify(ConfigNotify),
    SnapshotBegin(SnapshotBegin),
    SnapshotChunk(SnapshotChunk),
    SnapshotEnd(SnapshotEnd),
    SnapshotError(SnapshotError),
    TrafficAck(TrafficAck),
    Error(ErrorFrame),
    /// A well-formed frame of a type this codec does not know. Callers ignore it.
    Unknown(String),
}

#[derive(Deserialize)]
struct Envelope {
    v: u64,
    #[serde(default)]
    id: Option<String>,
    #[serde(rename = "type")]
    msg_type: String,
    ts: DateTime<Utc>,
    #[serde(default)]
    payload: Value,
}

/// Decodes one text frame received from `sender`.
///
/// `max_frame_bytes` is the effective limit: the smaller of the compile-time
/// ceiling and the `welcome.limits.maxFrameBytes` the control plane advertised.
pub fn decode(text: &str, sender: Sender, max_frame_bytes: usize) -> Result<Decoded, DecodeError> {
    if text.len() > max_frame_bytes {
        return Err(DecodeError::FrameTooLarge);
    }
    let value: Value = serde_json::from_str(text).map_err(|_| DecodeError::InvalidJson)?;
    if let Some(version) = value.get("v")
        && version.as_u64() != Some(PROTOCOL_VERSION)
    {
        return Err(DecodeError::UnsupportedVersion);
    }
    let envelope: Envelope =
        serde_json::from_value(value).map_err(|_| DecodeError::InvalidEnvelope)?;
    if envelope.v != PROTOCOL_VERSION
        || envelope.msg_type.is_empty()
        || envelope.msg_type.len() > 128
        || envelope.id.as_ref().is_some_and(|id| !bounded(id, 1, 128))
    {
        return Err(DecodeError::InvalidEnvelope);
    }

    let msg_type = envelope.msg_type.as_str();
    if !AGENT_TYPES.contains(&msg_type) && !CONTROL_TYPES.contains(&msg_type) {
        return Ok(Decoded {
            id: envelope.id,
            message: Message::Unknown(envelope.msg_type),
        });
    }
    let expected_sender = if AGENT_TYPES.contains(&msg_type) {
        Sender::Agent
    } else {
        Sender::ControlPlane
    };
    if expected_sender != sender {
        return Err(DecodeError::InvalidDirection(envelope.msg_type));
    }

    let payload = envelope.payload;
    let invalid = || DecodeError::InvalidPayload(msg_type.to_string());
    let message = match msg_type {
        "hello" => Message::Hello(checked(payload, Hello::check).ok_or_else(invalid)?),
        "agent.status" => {
            Message::StatusReport(checked(payload, StatusReport::check).ok_or_else(invalid)?)
        }
        "config.get" => Message::ConfigGet(checked(payload, ConfigGet::check).ok_or_else(invalid)?),
        "config.ack" => Message::ConfigAck(checked(payload, ConfigAck::check).ok_or_else(invalid)?),
        "traffic.report" => {
            Message::TrafficReport(checked(payload, TrafficReport::check).ok_or_else(invalid)?)
        }
        "welcome" => Message::Welcome(checked(payload, Welcome::check).ok_or_else(invalid)?),
        "agent.status.ack" => {
            Message::StatusAck(checked(payload, StatusAck::check).ok_or_else(invalid)?)
        }
        "config.notify" => {
            Message::ConfigNotify(checked(payload, ConfigNotify::check).ok_or_else(invalid)?)
        }
        "config.snapshot.begin" => {
            Message::SnapshotBegin(checked(payload, SnapshotBegin::check).ok_or_else(invalid)?)
        }
        "config.snapshot.chunk" => {
            Message::SnapshotChunk(checked(payload, SnapshotChunk::check).ok_or_else(invalid)?)
        }
        "config.snapshot.end" => {
            Message::SnapshotEnd(checked(payload, SnapshotEnd::check).ok_or_else(invalid)?)
        }
        "config.snapshot.error" => {
            Message::SnapshotError(checked(payload, SnapshotError::check).ok_or_else(invalid)?)
        }
        "traffic.ack" => {
            Message::TrafficAck(checked(payload, TrafficAck::check).ok_or_else(invalid)?)
        }
        "error" => Message::Error(checked(payload, ErrorFrame::check).ok_or_else(invalid)?),
        other => Message::Unknown(other.to_string()),
    };
    Ok(Decoded {
        id: envelope.id,
        message,
    })
}

/// Serializes one outbound frame with a millisecond timestamp, as the
/// contract's examples do. `id` is echoed when the frame answers a request.
pub fn encode<P: Serialize>(
    msg_type: &str,
    payload: &P,
    id: Option<&str>,
) -> serde_json::Result<String> {
    #[derive(Serialize)]
    struct Outbound<'a, P> {
        v: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<&'a str>,
        #[serde(rename = "type")]
        msg_type: &'a str,
        ts: String,
        payload: &'a P,
    }
    serde_json::to_string(&Outbound {
        v: PROTOCOL_VERSION,
        id,
        msg_type,
        ts: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        payload,
    })
}

fn checked<T: serde::de::DeserializeOwned>(payload: Value, check: fn(&T) -> bool) -> Option<T> {
    let parsed: T = serde_json::from_value(payload).ok()?;
    check(&parsed).then_some(parsed)
}

fn bounded(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len())
}

/// `null` is a value, not an absence: `error: null` clears the last error and
/// an omitted key leaves it unchanged. `Some(None)` keeps that distinction.
fn present_or_null<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

fn is_absent<T>(value: &Option<Option<T>>) -> bool {
    value.is_none()
}

/// A configuration identifier: the publish-gate sequence plus the content
/// digest, `"<seq>:sha256:<hex>"`. The prefix must equal the sequence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigIdentifier {
    pub desired_revision_seq: u64,
    pub desired_revision: String,
}

impl ConfigIdentifier {
    /// Builds the identifier an agent stored as its applied revision. Returns
    /// `None` for a string that does not begin with its canonical sequence.
    pub fn from_revision(revision: &str) -> Option<Self> {
        let (prefix, _) = revision.split_once(':')?;
        let seq: u64 = prefix.parse().ok()?;
        if seq.to_string() != prefix {
            return None;
        }
        let identifier = Self {
            desired_revision_seq: seq,
            desired_revision: revision.to_string(),
        };
        identifier.check().then_some(identifier)
    }

    fn check(&self) -> bool {
        bounded(&self.desired_revision, 1, 256)
            && self
                .desired_revision
                .starts_with(&format!("{}:", self.desired_revision_seq))
    }
}

/// `hello` (agent to control plane). Sent first on every connection. `applied`
/// is `null` when the cache is empty or must be re-applied.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub agent_version: String,
    pub agent_build_id: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub applied: Option<ConfigIdentifier>,
    #[serde(default)]
    pub certificate_deployments: Vec<CertificateDeployment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updates: Option<UpdateStatusPayload>,
}

impl Hello {
    fn check(&self) -> bool {
        bounded(&self.agent_version, 1, 128)
            && bounded(&self.agent_build_id, 1, 256)
            && self.capabilities.len() <= 1024
            && self.capabilities.iter().all(|value| bounded(value, 1, 128))
            && self.applied.as_ref().is_none_or(ConfigIdentifier::check)
            && self.certificate_deployments.len() <= 10_000
    }
}

/// `welcome` (control plane to agent). Sent once per session, in reply to
/// `hello`. Every later write from the control plane is fenced by `sessionId`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Welcome {
    pub session_id: String,
    pub server_id: String,
    pub server_name: String,
    pub desired: ConfigIdentifier,
    pub update_policy: UpdatePolicy,
    pub status_interval_seconds: u64,
    #[serde(default)]
    pub reconnect_before_seconds: Option<u64>,
    pub limits: Limits,
}

impl Welcome {
    fn check(&self) -> bool {
        bounded(&self.session_id, 1, 128)
            && bounded(&self.server_name, 1, 128)
            && !self.server_id.is_empty()
            && self.desired.check()
            && (1..=3_600).contains(&self.status_interval_seconds)
            && self
                .reconnect_before_seconds
                .is_none_or(|seconds| (1..=800).contains(&seconds))
            && self.limits.max_frame_bytes >= 1
            && self.limits.snapshot_chunk_bytes >= 1
            && self.limits.max_snapshot_bytes >= 1
    }
}

/// The control plane's limits, carried in `welcome`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_frame_bytes: u64,
    pub snapshot_chunk_bytes: u64,
    pub max_snapshot_bytes: u64,
}

/// Version targets. They travel apart from the configuration identifier, so a
/// version-target edit never causes a configuration transfer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePolicy {
    pub desired_agent_version: Option<String>,
    pub desired_sing_box_version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatusReason {
    Interval,
    Change,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeState {
    Unknown,
    Starting,
    Running,
    Stopped,
    CrashLoop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigState {
    Unknown,
    Applied,
    Rejected,
    ApplyFailed,
}

/// `agent.status` (agent to control plane). Only the fields that are present
/// are reported. `error: null` clears the last error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    pub reason: StatusReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_state: Option<RuntimeState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_state: Option<ConfigState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sing_box_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_node_ids: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "present_or_null",
        skip_serializing_if = "is_absent"
    )]
    pub error: Option<Option<StatusError>>,
    #[serde(default)]
    pub certificate_deployments: Vec<CertificateDeployment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updates: Option<UpdateStatusPayload>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusError {
    pub phase: String,
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occurred_at: Option<DateTime<Utc>>,
}

impl StatusReport {
    fn check(&self) -> bool {
        let error_ok = match &self.error {
            Some(Some(error)) => {
                bounded(&error.phase, 1, 64)
                    && bounded(&error.code, 1, 128)
                    && bounded(&error.message, 1, 16_384)
            }
            _ => true,
        };
        error_ok
            && self
                .sing_box_version
                .as_ref()
                .is_none_or(|v| bounded(v, 1, 128))
            && self
                .active_node_ids
                .as_ref()
                .is_none_or(|ids| ids.len() <= 10_000)
            && self.certificate_deployments.len() <= 10_000
    }
}

/// `agent.status.ack` (control plane to agent). Carries the authoritative
/// identifier, which recovers a missed `config.notify`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusAck {
    pub desired: ConfigIdentifier,
    pub update_policy: UpdatePolicy,
}

impl StatusAck {
    fn check(&self) -> bool {
        self.desired.check()
    }
}

/// `config.notify` (control plane to agent). A hint, which the agent verifies
/// by requesting the snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigNotify {
    pub desired: ConfigIdentifier,
    #[serde(default)]
    pub reason: Option<String>,
}

impl ConfigNotify {
    fn check(&self) -> bool {
        self.desired.check() && self.reason.as_ref().is_none_or(|r| bounded(r, 1, 256))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GetReason {
    Initial,
    Mismatch,
    Notify,
}

/// `config.get` (agent to control plane). A newer request supersedes an older one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigGet {
    pub request_id: String,
    pub reason: GetReason,
}

impl ConfigGet {
    fn check(&self) -> bool {
        bounded(&self.request_id, 1, 128)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AckOutcome {
    Applied,
    Failed,
}

/// The stage that failed. `receive` covers transfer and digest failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AckStage {
    Receive,
    Validate,
    Store,
    Apply,
}

/// `config.ack` (agent to control plane). `applied` names the identifier the
/// agent applied. A failure names its stage and never moves the applied one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigAck {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub desired: ConfigIdentifier,
    pub outcome: AckOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<AckStage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ConfigAck {
    /// Applied acks carry no stage or error; failed acks carry both.
    fn check(&self) -> bool {
        self.desired.check()
            && match self.outcome {
                AckOutcome::Applied => self.stage.is_none() && self.error.is_none(),
                AckOutcome::Failed => self.stage.is_some() && self.error.is_some(),
            }
            && self.error.as_ref().is_none_or(|e| bounded(e, 1, 16_384))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficEntry {
    pub subscription_id: String,
    pub uplink_bytes: i64,
    pub downlink_bytes: i64,
}

/// `traffic.report` (agent to control plane). `reportId` is required, so a
/// replay after a lost acknowledgement is deduplicated by the ledger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficReport {
    pub report_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_started_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_ended_at: Option<DateTime<Utc>>,
    pub entries: Vec<TrafficEntry>,
}

impl TrafficReport {
    fn check(&self) -> bool {
        report_id_ok(&self.report_id)
            && self.entries.len() <= 10_000
            && self.entries.iter().all(|entry| {
                !entry.subscription_id.is_empty()
                    && entry.uplink_bytes >= 0
                    && entry.downlink_bytes >= 0
            })
    }
}

/// `traffic.ack` (control plane to agent), sent only after the durable write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficAck {
    pub report_id: String,
    pub result: TrafficResult,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dropped: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrafficResult {
    Applied,
    Duplicate,
    Conflict,
}

impl TrafficAck {
    fn check(&self) -> bool {
        bounded(&self.report_id, 8, 128) && self.error.as_ref().is_none_or(|e| bounded(e, 1, 1024))
    }
}

/// Report ids match `[A-Za-z0-9._-]{8,128}`.
pub fn report_id_ok(report_id: &str) -> bool {
    bounded(report_id, 8, 128)
        && report_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// `config.snapshot.begin` (control plane to agent). `desired` names the version
/// actually compiled, which may be newer than the notified one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotBegin {
    pub request_id: String,
    pub desired: ConfigIdentifier,
    pub content_type: String,
    pub total_bytes: u64,
    pub chunk_count: u64,
    /// Lowercase hex SHA-256 of the complete body.
    pub digest: String,
}

impl SnapshotBegin {
    fn check(&self) -> bool {
        bounded(&self.request_id, 1, 128)
            && self.desired.check()
            && self.content_type == "application/json"
            && (1..=MAX_SNAPSHOT_BYTES as u64).contains(&self.total_bytes)
            && self.chunk_count == self.total_bytes.div_ceil(SNAPSHOT_CHUNK_BYTES as u64)
            && self.digest.len() == 64
            && self
                .digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }
}

/// `config.snapshot.chunk` (control plane to agent). Chunks arrive in order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotChunk {
    pub request_id: String,
    pub index: u64,
    /// Standard base64 of the raw chunk bytes.
    pub data: String,
}

impl SnapshotChunk {
    fn check(&self) -> bool {
        bounded(&self.request_id, 1, 128)
            && self.index < (MAX_SNAPSHOT_BYTES / SNAPSHOT_CHUNK_BYTES) as u64
            && bounded(&self.data, 1, SNAPSHOT_CHUNK_BASE64_LEN)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEnd {
    pub request_id: String,
}

impl SnapshotEnd {
    fn check(&self) -> bool {
        bounded(&self.request_id, 1, 128)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotErrorCode {
    SnapshotTooLarge,
    Unavailable,
    Internal,
}

/// `config.snapshot.error` (control plane to agent): the snapshot was refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotError {
    pub request_id: String,
    pub code: SnapshotErrorCode,
    pub message: String,
}

impl SnapshotError {
    fn check(&self) -> bool {
        bounded(&self.request_id, 1, 128) && bounded(&self.message, 1, 2048)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidDirection,
    InvalidPayload,
    FrameTooLarge,
    ServerDisabled,
    SessionReplaced,
}

/// `error` (control plane to agent). `session_replaced` and `server_disabled`
/// also close the socket with code 4000.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorFrame {
    pub code: ErrorCode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub message: String,
}

impl ErrorFrame {
    fn check(&self) -> bool {
        bounded(&self.message, 1, 1024)
            && self.r#type.as_ref().is_none_or(|t| bounded(t, 1, 128))
            && self.request_id.as_ref().is_none_or(|r| bounded(r, 1, 128))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURES: &str =
        include_str!("../../../../packages/contracts/fixtures/agent-ws-v2.frames.json");

    fn sender_of(name: &str) -> Sender {
        match name {
            "agent" => Sender::Agent,
            "control-plane" => Sender::ControlPlane,
            other => panic!("unknown fixture sender {other}"),
        }
    }

    #[test]
    fn fixtures_decode_exactly_as_the_contract_expects() {
        let document: Value = serde_json::from_str(FIXTURES).unwrap();
        assert_eq!(document["subprotocol"], SUBPROTOCOL);
        let frames = document["frames"].as_array().unwrap();
        assert!(frames.len() >= 26, "fixture set shrank");

        for entry in frames {
            let name = entry["name"].as_str().unwrap();
            let sender = sender_of(entry["sender"].as_str().unwrap());
            let text = serde_json::to_string(&entry["frame"]).unwrap();
            let expect = entry["expect"].as_str().unwrap();
            let result = decode(&text, sender, MAX_FRAME_BYTES);
            match expect {
                "ok" => {
                    let decoded = result.unwrap_or_else(|error| panic!("{name}: {error}"));
                    assert!(
                        !matches!(decoded.message, Message::Unknown(_)),
                        "{name}: a known type decoded as unknown"
                    );
                }
                "unknown" => {
                    let decoded = result.unwrap_or_else(|error| panic!("{name}: {error}"));
                    assert!(matches!(decoded.message, Message::Unknown(_)), "{name}");
                }
                code => {
                    let error = result.expect_err(name);
                    assert_eq!(error.code(), code, "{name}: {error}");
                }
            }
        }
    }

    #[test]
    fn welcome_fixture_keeps_its_correlation_id_and_limits() {
        let document: Value = serde_json::from_str(FIXTURES).unwrap();
        let welcome = document["frames"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == "control welcome for a new session")
            .unwrap();
        let text = serde_json::to_string(&welcome["frame"]).unwrap();
        let decoded = decode(&text, Sender::ControlPlane, MAX_FRAME_BYTES).unwrap();
        assert_eq!(decoded.id.as_deref(), Some("hello-1"));
        let Message::Welcome(payload) = decoded.message else {
            panic!("expected welcome");
        };
        assert_eq!(payload.limits.snapshot_chunk_bytes, 65_536);
        assert_eq!(payload.reconnect_before_seconds, Some(240));
    }

    #[test]
    fn frames_over_the_effective_limit_are_rejected_before_parsing() {
        let text = format!(
            r#"{{"v":2,"type":"future.thing","ts":"2026-11-19T00:00:00Z","payload":{{"pad":"{}"}}}}"#,
            "x".repeat(64)
        );
        assert_eq!(
            decode(&text, Sender::ControlPlane, 128).unwrap_err(),
            DecodeError::FrameTooLarge
        );
        assert!(decode(&text, Sender::ControlPlane, text.len()).is_ok());
    }

    #[test]
    fn a_status_error_distinguishes_null_from_absent() {
        let cleared = r#"{"v":2,"type":"agent.status","ts":"2026-11-19T00:00:00Z","payload":{"reason":"change","error":null}}"#;
        let Message::StatusReport(report) = decode(cleared, Sender::Agent, MAX_FRAME_BYTES)
            .unwrap()
            .message
        else {
            panic!("expected agent.status");
        };
        assert_eq!(report.error, Some(None));

        let absent = r#"{"v":2,"type":"agent.status","ts":"2026-11-19T00:00:00Z","payload":{"reason":"change"}}"#;
        let Message::StatusReport(report) = decode(absent, Sender::Agent, MAX_FRAME_BYTES)
            .unwrap()
            .message
        else {
            panic!("expected agent.status");
        };
        assert_eq!(report.error, None);
    }

    #[test]
    fn outbound_frames_round_trip_through_the_control_plane_decoder() {
        let hello = Hello {
            agent_version: "1.3.0".into(),
            agent_build_id: "local-test".into(),
            capabilities: vec!["ws-v2".into()],
            applied: ConfigIdentifier::from_revision(
                "7:sha256:48a9e1aa59f365863b57348ccd1701026c39652cfb74b8e2b039811611802ec6",
            ),
            certificate_deployments: Vec::new(),
            updates: None,
        };
        let text = encode("hello", &hello, Some("hello-9")).unwrap();
        let decoded = decode(&text, Sender::Agent, MAX_FRAME_BYTES).unwrap();
        assert_eq!(decoded.id.as_deref(), Some("hello-9"));
        assert_eq!(decoded.message, Message::Hello(hello));
        // Millisecond precision, as the contract's examples use.
        let value: Value = serde_json::from_str(&text).unwrap();
        let ts = value["ts"].as_str().unwrap();
        assert_eq!(ts.len(), 24, "{ts}");
        assert!(ts.ends_with(".000Z") || ts.as_bytes()[23] == b'Z', "{ts}");
    }

    #[test]
    fn a_control_plane_frame_from_the_agent_is_a_direction_error() {
        let text = r#"{"v":2,"type":"welcome","ts":"2026-11-19T00:00:00Z","payload":{}}"#;
        assert_eq!(
            decode(text, Sender::Agent, MAX_FRAME_BYTES).unwrap_err(),
            DecodeError::InvalidDirection("welcome".into())
        );
    }

    #[test]
    fn identifiers_must_name_their_own_sequence() {
        let digest = "a".repeat(64);
        assert!(ConfigIdentifier::from_revision(&format!("12:sha256:{digest}")).is_some());
        assert!(ConfigIdentifier::from_revision(&format!("012:sha256:{digest}")).is_none());
        assert!(ConfigIdentifier::from_revision("sha256:abc").is_none());
    }

    #[test]
    fn report_ids_follow_the_control_plane_pattern() {
        assert!(report_id_ok("report-0001"));
        assert!(report_id_ok("2026.11-19_a"));
        assert!(!report_id_ok("short"));
        assert!(!report_id_ok("has space in it"));
    }
}
