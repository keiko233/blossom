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
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::log_policy::{Level as PolicyLevel, Source as PolicySource};
use crate::ws::codec::{
    AcmeDnsAckPayload, AcmeIssuePayload, CertificateDeployment, UpdateStatusPayload,
    UpdateTriggerPayload,
};

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

/// Live tail over the retained log buffer.
pub const LOGS_TAIL_CAPABILITY: &str = "logs-tail-v1";
/// Retained search and context lookup over the retained log buffer.
pub const LOGS_SEARCH_CAPABILITY: &str = "logs-search-v1";
pub const LOGS_BATCH_MAX_RECORDS: usize = 200;
pub const LOGS_RECORD_MAX_CHARS: usize = 4096;
pub const LOGS_QUERY_MAX_CHARS: usize = 256;
pub const LOGS_SEARCH_PAGE_MAX: usize = 100;
pub const LOGS_CONTEXT_MAX_LINES: usize = 50;
/// JavaScript's `Number.MAX_SAFE_INTEGER`. Contract sequence numbers stay at
/// or below it, so a control plane can carry them exactly.
pub const MAX_SAFE_SEQ: u64 = 9_007_199_254_740_991;

const AGENT_TYPES: &[&str] = &[
    "hello",
    "agent.status",
    "config.get",
    "config.ack",
    "traffic.report",
    "update.status",
    "acme.dns_present",
    "acme.dns_cleanup",
    "acme.result",
    "pty.started",
    "pty.data",
    "pty.exit",
    "log.policy.get",
    "log.policy.ack",
    "logs.batch",
    "logs.gap",
    "logs.search.result",
    "logs.context.result",
    "logs.error",
    "telemetry.sample",
    "telemetry.snapshot",
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
    "log.policy.notify",
    "log.policy.snapshot",
    "telemetry.subscribe",
    "telemetry.unsubscribe",
    "telemetry.inspect",
    "error",
    "update.trigger",
    "acme.issue",
    "acme.dns_ack",
    "pty.open",
    "pty.data",
    "pty.resize",
    "pty.close",
    "logs.subscribe",
    "logs.unsubscribe",
    "logs.search",
    "logs.search.cancel",
    "logs.context",
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

    /// The `error` frame code an agent answers with, when the contract has one.
    /// An unsupported envelope version has none: the session ends instead.
    pub fn wire_code(&self) -> Option<ErrorCode> {
        match self {
            Self::FrameTooLarge => Some(ErrorCode::FrameTooLarge),
            Self::InvalidDirection(_) => Some(ErrorCode::InvalidDirection),
            Self::InvalidJson | Self::InvalidEnvelope | Self::InvalidPayload(_) => {
                Some(ErrorCode::InvalidPayload)
            }
            Self::UnsupportedVersion => None,
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
    UpdateStatus(UpdateStatusPayload),
    AcmeDnsPresent(AcmeDnsPresent),
    AcmeDnsCleanup(AcmeDnsCleanup),
    AcmeResult(AcmeResult),
    PtyStarted(PtyStarted),
    PtyData(PtyData),
    PtyExit(PtyExit),
    LogPolicyGet(LogPolicyGet),
    LogPolicyAck(LogPolicyAck),
    LogsSubscribe(LogsSubscribe),
    LogsUnsubscribe(LogsUnsubscribe),
    LogsSearch(LogsSearch),
    LogsSearchCancel(LogsSearchCancel),
    LogsContext(LogsContext),
    TelemetrySample(TelemetrySample),
    TelemetrySnapshot(TelemetrySnapshot),
    Welcome(Welcome),
    StatusAck(StatusAck),
    ConfigNotify(ConfigNotify),
    SnapshotBegin(SnapshotBegin),
    SnapshotChunk(SnapshotChunk),
    SnapshotEnd(SnapshotEnd),
    SnapshotError(SnapshotError),
    TrafficAck(TrafficAck),
    UpdateTrigger(UpdateTriggerPayload),
    AcmeIssue(AcmeIssuePayload),
    AcmeDnsAck(AcmeDnsAckPayload),
    PtyOpen(PtyOpen),
    PtyResize(PtyResize),
    PtyClose(PtyClose),
    LogPolicyNotify(LogPolicyNotify),
    LogPolicySnapshot(LogPolicySnapshot),
    LogsBatch(LogsBatch),
    LogsGap(LogsGap),
    LogsSearchResult(LogsSearchResult),
    LogsContextResult(LogsContextResult),
    LogsError(LogsError),
    TelemetrySubscribe(TelemetrySubscribe),
    TelemetryUnsubscribe(TelemetryUnsubscribe),
    TelemetryInspect(TelemetryInspect),
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
    // Required by the contract and validated by deserialization; not read.
    #[serde(rename = "ts")]
    _ts: DateTime<Utc>,
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
    if msg_type != "pty.data" && expected_sender != sender {
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
        "update.status" => {
            Message::UpdateStatus(checked(payload, UpdateStatusPayload::check).ok_or_else(invalid)?)
        }
        "acme.dns_present" => {
            Message::AcmeDnsPresent(checked(payload, AcmeDnsPresent::check).ok_or_else(invalid)?)
        }
        "acme.dns_cleanup" => {
            Message::AcmeDnsCleanup(checked(payload, AcmeDnsCleanup::check).ok_or_else(invalid)?)
        }
        "acme.result" => {
            Message::AcmeResult(checked(payload, AcmeResult::check).ok_or_else(invalid)?)
        }
        "pty.started" => {
            Message::PtyStarted(checked(payload, PtyStarted::check).ok_or_else(invalid)?)
        }
        "pty.data" => Message::PtyData(checked(payload, PtyData::check).ok_or_else(invalid)?),
        "pty.exit" => Message::PtyExit(checked(payload, PtyExit::check).ok_or_else(invalid)?),
        "log.policy.get" => {
            Message::LogPolicyGet(checked(payload, LogPolicyGet::check).ok_or_else(invalid)?)
        }
        "log.policy.ack" => {
            Message::LogPolicyAck(checked(payload, LogPolicyAck::check).ok_or_else(invalid)?)
        }
        "logs.subscribe" => {
            Message::LogsSubscribe(checked(payload, LogsSubscribe::check).ok_or_else(invalid)?)
        }
        "logs.unsubscribe" => {
            Message::LogsUnsubscribe(checked(payload, LogsUnsubscribe::check).ok_or_else(invalid)?)
        }
        "logs.search" => {
            Message::LogsSearch(checked(payload, LogsSearch::check).ok_or_else(invalid)?)
        }
        "logs.search.cancel" => Message::LogsSearchCancel(
            checked(payload, LogsSearchCancel::check).ok_or_else(invalid)?,
        ),
        "logs.context" => {
            Message::LogsContext(checked(payload, LogsContext::check).ok_or_else(invalid)?)
        }
        "telemetry.sample" => {
            Message::TelemetrySample(checked(payload, TelemetrySample::check).ok_or_else(invalid)?)
        }
        "telemetry.snapshot" => Message::TelemetrySnapshot(
            checked(payload, TelemetrySnapshot::check).ok_or_else(invalid)?,
        ),
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
        "update.trigger" => Message::UpdateTrigger(
            checked(payload, UpdateTriggerPayload::check).ok_or_else(invalid)?,
        ),
        "acme.issue" => {
            Message::AcmeIssue(checked(payload, AcmeIssuePayload::check).ok_or_else(invalid)?)
        }
        "acme.dns_ack" => {
            Message::AcmeDnsAck(checked(payload, AcmeDnsAckPayload::check).ok_or_else(invalid)?)
        }
        "pty.open" => Message::PtyOpen(checked(payload, PtyOpen::check).ok_or_else(invalid)?),
        "pty.resize" => Message::PtyResize(checked(payload, PtyResize::check).ok_or_else(invalid)?),
        "pty.close" => Message::PtyClose(checked(payload, PtyClose::check).ok_or_else(invalid)?),
        "log.policy.notify" => {
            Message::LogPolicyNotify(checked(payload, LogPolicyNotify::check).ok_or_else(invalid)?)
        }
        "log.policy.snapshot" => Message::LogPolicySnapshot(
            checked(payload, LogPolicySnapshot::check).ok_or_else(invalid)?,
        ),
        "logs.batch" => Message::LogsBatch(checked(payload, LogsBatch::check).ok_or_else(invalid)?),
        "logs.gap" => Message::LogsGap(checked(payload, LogsGap::check).ok_or_else(invalid)?),
        "logs.search.result" => Message::LogsSearchResult(
            checked(payload, LogsSearchResult::check).ok_or_else(invalid)?,
        ),
        "logs.context.result" => Message::LogsContextResult(
            checked(payload, LogsContextResult::check).ok_or_else(invalid)?,
        ),
        "logs.error" => Message::LogsError(checked(payload, LogsError::check).ok_or_else(invalid)?),
        "telemetry.subscribe" => Message::TelemetrySubscribe(
            checked(payload, TelemetrySubscribe::check).ok_or_else(invalid)?,
        ),
        "telemetry.unsubscribe" => Message::TelemetryUnsubscribe(
            checked(payload, TelemetryUnsubscribe::check).ok_or_else(invalid)?,
        ),
        "telemetry.inspect" => Message::TelemetryInspect(
            checked(payload, TelemetryInspect::check).ok_or_else(invalid)?,
        ),
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_policy_revision: Option<u64>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_policy_revision: Option<u64>,
}

impl StatusAck {
    fn check(&self) -> bool {
        self.desired.check()
    }
}

/// The two local log-level sources. `sing-box` is the wire spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LogPolicySource {
    #[serde(rename = "agent")]
    Agent,
    #[serde(rename = "sing-box")]
    SingBox,
}

impl From<LogPolicySource> for PolicySource {
    fn from(source: LogPolicySource) -> Self {
        match source {
            LogPolicySource::Agent => PolicySource::Agent,
            LogPolicySource::SingBox => PolicySource::SingBox,
        }
    }
}

impl From<PolicySource> for LogPolicySource {
    fn from(source: PolicySource) -> Self {
        match source {
            PolicySource::Agent => Self::Agent,
            PolicySource::SingBox => Self::SingBox,
        }
    }
}

/// A wire log level. The values match the local policy API.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Default,
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

impl LogLevel {
    pub fn is_temporary(self) -> bool {
        matches!(self, Self::Debug | Self::Trace)
    }
}

impl From<LogLevel> for PolicyLevel {
    fn from(level: LogLevel) -> Self {
        match level {
            LogLevel::Default => PolicyLevel::Default,
            LogLevel::Error => PolicyLevel::Error,
            LogLevel::Warn => PolicyLevel::Warn,
            LogLevel::Info => PolicyLevel::Info,
            LogLevel::Debug => PolicyLevel::Debug,
            LogLevel::Trace => PolicyLevel::Trace,
        }
    }
}

impl From<PolicyLevel> for LogLevel {
    fn from(level: PolicyLevel) -> Self {
        match level {
            PolicyLevel::Default => Self::Default,
            PolicyLevel::Error => Self::Error,
            PolicyLevel::Warn => Self::Warn,
            PolicyLevel::Info => Self::Info,
            PolicyLevel::Debug => Self::Debug,
            PolicyLevel::Trace => Self::Trace,
        }
    }
}

/// One source of `log.policy.snapshot`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPolicyDesired {
    pub source: LogPolicySource,
    pub revision: u64,
    pub baseline: LogLevel,
    pub level: LogLevel,
    pub deadline: Option<DateTime<Utc>>,
}

impl LogPolicyDesired {
    fn check(&self) -> bool {
        if self.baseline.is_temporary() {
            false
        } else if self.level.is_temporary() {
            self.deadline.is_some()
        } else {
            self.deadline.is_none()
        }
    }
}

/// `log.policy.notify` (control plane to agent). A hint; `log.policy.get`
/// carries the authoritative snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPolicyNotify {
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<LogPolicySource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl LogPolicyNotify {
    fn check(&self) -> bool {
        self.reason.as_ref().is_none_or(|r| bounded(r, 1, 256))
    }
}

/// `log.policy.get` (agent to control plane).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPolicyGet {
    pub request_id: String,
}

impl LogPolicyGet {
    fn check(&self) -> bool {
        bounded(&self.request_id, 1, 128)
    }
}

/// `log.policy.snapshot` (control plane to agent). Each source appears once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPolicySnapshot {
    pub request_id: String,
    pub revision: u64,
    pub sources: Vec<LogPolicyDesired>,
}

impl LogPolicySnapshot {
    fn check(&self) -> bool {
        bounded(&self.request_id, 1, 128)
            && (1..=2).contains(&self.sources.len())
            && self.sources.iter().all(LogPolicyDesired::check)
            && self.sources.iter().enumerate().all(|(index, source)| {
                self.sources
                    .iter()
                    .skip(index + 1)
                    .all(|other| other.source != source.source)
            })
    }
}

/// `log.policy.ack` (agent to control plane): requested/effective status only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPolicyAck {
    pub source: LogPolicySource,
    pub source_revision: u64,
    pub requested: LogLevel,
    pub baseline: LogLevel,
    pub effective: LogLevel,
    pub deadline: Option<DateTime<Utc>>,
    pub error: Option<String>,
    pub pending: bool,
}

impl LogPolicyAck {
    fn check(&self) -> bool {
        let deadline_ok = if self.requested.is_temporary() {
            self.deadline.is_some()
        } else {
            self.deadline.is_none()
        };
        deadline_ok && self.error.as_ref().is_none_or(|e| bounded(e, 1, 512))
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

/// A buffer generation, carried as a decimal `u64` string because JavaScript
/// numbers cannot hold the full range. Sequence numbers stay JS-safe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LogGeneration(u64);

impl LogGeneration {
    pub fn new(value: u64) -> Self {
        Self(value)
    }

    pub fn get(self) -> u64 {
        self.0
    }
}

impl fmt::Display for LogGeneration {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.0)
    }
}

impl Serialize for LogGeneration {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for LogGeneration {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct GenerationVisitor;

        impl Visitor<'_> for GenerationVisitor {
            type Value = LogGeneration;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a decimal u64 generation string")
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                if value.is_empty()
                    || value.len() > 20
                    || !value.bytes().all(|byte| byte.is_ascii_digit())
                {
                    return Err(E::custom("generation must be a decimal u64 string"));
                }
                value
                    .parse::<u64>()
                    .map(LogGeneration)
                    .map_err(|_| E::custom("generation exceeds 64 bits"))
            }
        }

        deserializer.deserialize_str(GenerationVisitor)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogGapReason {
    Restarted,
    Overwritten,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogSource {
    Agent,
    #[serde(rename = "sing-box")]
    SingBox,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogsLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogCursor {
    pub generation: LogGeneration,
    pub seq: u64,
}

impl LogCursor {
    fn check(&self) -> bool {
        self.seq <= MAX_SAFE_SEQ
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSearchCursor {
    pub generation: LogGeneration,
    pub pinned_seq: u64,
    pub before: u64,
    pub floor: u64,
}

impl LogSearchCursor {
    fn check(&self) -> bool {
        self.pinned_seq <= MAX_SAFE_SEQ && self.before <= MAX_SAFE_SEQ && self.floor <= MAX_SAFE_SEQ
    }
}

/// One retained, already-redacted record. The agent only encodes this type;
/// decoding it keeps the shared wire fixtures checkable in both directions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRecord {
    pub seq: u64,
    pub time: DateTime<Utc>,
    pub source: LogSource,
    pub level: LogsLevel,
    pub process_generation: u64,
    pub text: String,
    pub truncated: bool,
}

impl LogRecord {
    fn check(&self) -> bool {
        self.seq >= 1
            && self.seq <= MAX_SAFE_SEQ
            && self.process_generation <= MAX_SAFE_SEQ
            && chars_bounded(&self.text, 0, LOGS_RECORD_MAX_CHARS)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFilter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<LogSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_level: Option<LogsLevel>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<LogSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_level: Option<LogsLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<DateTime<Utc>>,
}

impl LogQuery {
    fn check(&self) -> bool {
        self.text
            .as_ref()
            .is_none_or(|text| chars_bounded(text, 1, LOGS_QUERY_MAX_CHARS))
            && !matches!((self.since, self.until), (Some(since), Some(until)) if since >= until)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogGap {
    pub reason: LogGapReason,
    pub from_seq: u64,
    pub to_seq: u64,
}

impl LogGap {
    fn check(&self) -> bool {
        match self.reason {
            LogGapReason::Restarted => self.from_seq == 0 && self.to_seq == 0,
            LogGapReason::Overwritten => {
                self.from_seq >= 1 && self.to_seq >= self.from_seq && self.to_seq <= MAX_SAFE_SEQ
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogCoverage {
    pub gap: Option<LogGapReason>,
    pub searchable_from: Option<DateTime<Utc>>,
    pub searchable_to: Option<DateTime<Utc>>,
}

/// `logs.subscribe` (control plane to agent). `resume: null` starts from the
/// newest `limit` records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsSubscribe {
    pub subscription_id: String,
    pub filter: LogFilter,
    pub resume: Option<LogCursor>,
    pub limit: u64,
}

impl LogsSubscribe {
    fn check(&self) -> bool {
        log_id_ok(&self.subscription_id)
            && self.resume.as_ref().is_none_or(LogCursor::check)
            && (1..=LOGS_BATCH_MAX_RECORDS as u64).contains(&self.limit)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsUnsubscribe {
    pub subscription_id: String,
}

impl LogsUnsubscribe {
    fn check(&self) -> bool {
        log_id_ok(&self.subscription_id)
    }
}

/// `logs.search` (control plane to agent). `cursor: null` starts a new search
/// pinned at the newest record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsSearch {
    pub request_id: String,
    pub query: LogQuery,
    pub cursor: Option<LogSearchCursor>,
    pub limit: u64,
}

impl LogsSearch {
    fn check(&self) -> bool {
        log_id_ok(&self.request_id)
            && self.query.check()
            && self.cursor.as_ref().is_none_or(LogSearchCursor::check)
            && (1..=LOGS_SEARCH_PAGE_MAX as u64).contains(&self.limit)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsSearchCancel {
    pub request_id: String,
}

impl LogsSearchCancel {
    fn check(&self) -> bool {
        log_id_ok(&self.request_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsContext {
    pub request_id: String,
    pub generation: LogGeneration,
    pub seq: u64,
    pub before: u64,
    pub after: u64,
}

impl LogsContext {
    fn check(&self) -> bool {
        log_id_ok(&self.request_id)
            && self.seq >= 1
            && self.seq <= MAX_SAFE_SEQ
            && self.before <= LOGS_CONTEXT_MAX_LINES as u64
            && self.after <= LOGS_CONTEXT_MAX_LINES as u64
    }
}

/// `logs.batch` (agent to control plane). `next` is the position after the
/// last record the agent scanned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsBatch {
    pub subscription_id: String,
    pub next: LogCursor,
    pub has_more: bool,
    pub records: Vec<LogRecord>,
}

impl LogsBatch {
    fn check(&self) -> bool {
        log_id_ok(&self.subscription_id)
            && self.next.check()
            && self.records.len() <= LOGS_BATCH_MAX_RECORDS
            && self.records.iter().all(LogRecord::check)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsGap {
    pub subscription_id: String,
    pub generation: LogGeneration,
    pub gap: LogGap,
}

impl LogsGap {
    fn check(&self) -> bool {
        log_id_ok(&self.subscription_id) && self.gap.check()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsSearchResult {
    pub request_id: String,
    pub generation: LogGeneration,
    pub pinned_seq: u64,
    pub matches: Vec<LogRecord>,
    pub next: Option<LogSearchCursor>,
    pub coverage: LogCoverage,
}

impl LogsSearchResult {
    fn check(&self) -> bool {
        log_id_ok(&self.request_id)
            && self.pinned_seq <= MAX_SAFE_SEQ
            && self.matches.len() <= LOGS_SEARCH_PAGE_MAX
            && self.matches.iter().all(LogRecord::check)
            && self.next.as_ref().is_none_or(LogSearchCursor::check)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsContextResult {
    pub request_id: String,
    pub generation: LogGeneration,
    pub target: LogRecord,
    pub before: Vec<LogRecord>,
    pub after: Vec<LogRecord>,
}

impl LogsContextResult {
    fn check(&self) -> bool {
        log_id_ok(&self.request_id)
            && self.target.check()
            && self.before.len() <= LOGS_CONTEXT_MAX_LINES
            && self.after.len() <= LOGS_CONTEXT_MAX_LINES
            && self.before.iter().all(LogRecord::check)
            && self.after.iter().all(LogRecord::check)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogErrorCode {
    InvalidRequest,
    Unsupported,
    Busy,
    Restarted,
    Overwritten,
    NotFound,
    Unavailable,
}

/// `logs.error` (agent to control plane). Exactly one of the two ids names the
/// request it answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsError {
    pub code: LogErrorCode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscription_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub message: String,
}

impl LogsError {
    fn check(&self) -> bool {
        let subscription = self.subscription_id.as_deref().is_none_or(log_id_ok);
        let request = self.request_id.as_deref().is_none_or(log_id_ok);
        subscription
            && request
            && self.subscription_id.is_some() != self.request_id.is_some()
            && chars_bounded(&self.message, 1, 1024)
    }
}

fn log_id_ok(value: &str) -> bool {
    bounded(value, 1, 128)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

/// Counts UTF-16 code units, as the TypeScript contract's `String#length` does.
fn chars_bounded(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.encode_utf16().count())
}

/// Report ids match `[A-Za-z0-9._-]{8,128}`.
pub fn report_id_ok(report_id: &str) -> bool {
    bounded(report_id, 8, 128)
        && report_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// `[A-Za-z0-9._-]{1,128}`, the subscription-id shape shared by the
/// telemetry control frames and samples.
fn subscription_id_ok(subscription_id: &str) -> bool {
    bounded(subscription_id, 1, 128)
        && subscription_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TelemetryPurpose {
    Live,
    History,
}

/// `telemetry.subscribe` (control plane to agent). A subscription is live or
/// the control plane's independent history cadence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySubscribe {
    pub subscription_id: String,
    pub purpose: TelemetryPurpose,
    pub interval_ms: u64,
}

impl TelemetrySubscribe {
    fn check(&self) -> bool {
        subscription_id_ok(&self.subscription_id) && (1_000..=300_000).contains(&self.interval_ms)
    }
}

/// `telemetry.unsubscribe` (control plane to agent). The subscription's future
/// samples stop; one already handed to the session may still be in flight.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryUnsubscribe {
    pub subscription_id: String,
}

impl TelemetryUnsubscribe {
    fn check(&self) -> bool {
        subscription_id_ok(&self.subscription_id)
    }
}

/// `telemetry.inspect` (control plane to agent): asks for the v1 inspection
/// snapshot, with the same request id echoed back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryInspect {
    pub request_id: String,
}

impl TelemetryInspect {
    fn check(&self) -> bool {
        bounded(&self.request_id, 1, 128)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TelemetryEnvironment {
    Systemd,
    Docker,
    Containerd,
    Kubernetes,
    Container,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryUsage {
    pub used: u64,
    pub total: u64,
}

impl TelemetryUsage {
    fn check(&self) -> bool {
        self.used <= self.total
    }
}

/// Counter-derived network rates. A rate is null when that counter could not
/// be compared across the window; the whole object is null when no usable
/// baseline exists.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryNetwork {
    pub tx_bytes_per_second: Option<f64>,
    pub rx_bytes_per_second: Option<f64>,
    pub window_ms: u64,
}

impl TelemetryNetwork {
    fn check(&self) -> bool {
        rate_ok(self.tx_bytes_per_second)
            && rate_ok(self.rx_bytes_per_second)
            && (1..=300_000).contains(&self.window_ms)
    }
}

fn rate_ok(value: Option<f64>) -> bool {
    value.is_none_or(|rate| rate.is_finite() && rate >= 0.0)
}

mod rfc3339_millis {
    use super::*;

    pub fn serialize<S: serde::Serializer>(
        value: &DateTime<Utc>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_rfc3339_opts(SecondsFormat::Millis, true))
    }

    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<DateTime<Utc>, D::Error> {
        let text = String::deserialize(deserializer)?;
        DateTime::parse_from_rfc3339(&text)
            .map(|value| value.with_timezone(&Utc))
            .map_err(serde::de::Error::custom)
    }
}

/// `telemetry.sample` (agent to control plane). Measurements use the v1 shape
/// where possible, plus a `scopeKey` and counter-derived network rates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySample {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscription_id: Option<String>,
    pub purpose: TelemetryPurpose,
    #[serde(with = "rfc3339_millis")]
    pub sampled_at: DateTime<Utc>,
    pub cpu_percent: Option<f64>,
    pub memory: Option<TelemetryUsage>,
    pub disk: Option<TelemetryUsage>,
    pub environment: TelemetryEnvironment,
    pub network_scope: String,
    pub cgroup_version: Option<u8>,
    pub cpu_limit: Option<f64>,
    pub memory_limit: Option<u64>,
    pub scope_key: String,
    pub network: Option<TelemetryNetwork>,
}

impl TelemetrySample {
    fn check(&self) -> bool {
        self.subscription_id
            .as_ref()
            .is_none_or(|id| subscription_id_ok(id))
            && self
                .cpu_percent
                .is_none_or(|cpu| cpu.is_finite() && (0.0..=100.0).contains(&cpu))
            && self.memory.as_ref().is_none_or(TelemetryUsage::check)
            && self.disk.as_ref().is_none_or(TelemetryUsage::check)
            && self.network_scope == "agent"
            && self
                .cgroup_version
                .is_none_or(|version| matches!(version, 1 | 2))
            && self
                .cpu_limit
                .is_none_or(|limit| limit.is_finite() && limit > 0.0)
            && bounded(&self.scope_key, 1, 256)
            && self.network.as_ref().is_none_or(TelemetryNetwork::check)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TelemetryProtocol {
    Tcp,
    Udp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TelemetryListener {
    pub protocol: TelemetryProtocol,
    pub address: String,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TelemetryInterface {
    pub name: String,
    pub address: String,
}

/// `telemetry.snapshot` (agent to control plane): the v1 inspection snapshot,
/// answered only for a `telemetry.inspect` request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySnapshot {
    pub request_id: String,
    pub partial: bool,
    pub listeners: Vec<TelemetryListener>,
    pub interfaces: Vec<TelemetryInterface>,
}

impl TelemetrySnapshot {
    fn check(&self) -> bool {
        bounded(&self.request_id, 1, 128)
            && self.listeners.len() <= 128
            && self.listeners.iter().all(|listener| {
                listener.port > 0 && !listener.address.is_empty() && listener.address.len() <= 64
            })
            && self.interfaces.len() <= 128
            && self.interfaces.iter().all(|interface| {
                bounded(&interface.name, 1, 32)
                    && !interface.address.is_empty()
                    && interface.address.len() <= 64
            })
    }
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

/// `update.status` reuses the v1 per-binary status shape.
impl UpdateStatusPayload {
    fn check(&self) -> bool {
        self.agent.as_ref().is_none_or(update_state_ok)
            && self.sing_box.as_ref().is_none_or(update_state_ok)
    }
}

fn update_state_ok(state: &crate::ws::codec::UpdateStatePayload) -> bool {
    bounded(&state.state, 1, 64)
        && state
            .target_version
            .as_deref()
            .is_none_or(|value| bounded(value, 1, 64))
        && state
            .message
            .as_deref()
            .is_none_or(|value| bounded(value, 1, 4096))
}

/// `update.trigger` uses the v1 target and optional version strings.
impl UpdateTriggerPayload {
    fn check(&self) -> bool {
        self.desired_agent_version
            .as_deref()
            .is_none_or(|value| bounded(value, 1, 64))
            && self
                .desired_sing_box_version
                .as_deref()
                .is_none_or(|value| bounded(value, 1, 64))
    }
}

/// `acme.issue` is the same bounded order v1 carries.
impl AcmeIssuePayload {
    fn check(&self) -> bool {
        bounded(&self.job_id, 1, 128)
            && bounded(&self.certificate_id, 1, 128)
            && !self.domains.is_empty()
            && self.domains.len() <= 100
            && self.domains.iter().all(|domain| bounded(domain, 1, 253))
            && matches!(self.acme_provider.as_str(), "letsencrypt" | "zerossl")
            && matches!(self.challenge_type.as_str(), "dns-01" | "http-01")
            && self
                .external_account_binding
                .as_ref()
                .is_none_or(|binding| {
                    bounded(&binding.kid, 1, 256) && bounded(&binding.hmac_key, 1, 1024)
                })
    }
}

/// `acme.dns_ack` answers one exact DNS broker request.
impl AcmeDnsAckPayload {
    fn check(&self) -> bool {
        bounded(&self.job_id, 1, 128)
            && bounded(&self.fqdn, 1, 253)
            && bounded(&self.txt_value, 1, 512)
            && self
                .error
                .as_deref()
                .is_none_or(|value| bounded(value, 1, 2048))
    }
}

/// `acme.dns_present` asks the control plane to publish one challenge record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcmeDnsPresent {
    pub job_id: String,
    pub fqdn: String,
    pub txt_value: String,
}

impl AcmeDnsPresent {
    fn check(&self) -> bool {
        bounded(&self.job_id, 1, 128)
            && bounded(&self.fqdn, 1, 253)
            && bounded(&self.txt_value, 1, 512)
    }
}

/// `acme.dns_cleanup` asks for the same challenge record to be removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcmeDnsCleanup {
    pub job_id: String,
    pub fqdn: String,
    pub txt_value: String,
}

impl AcmeDnsCleanup {
    fn check(&self) -> bool {
        bounded(&self.job_id, 1, 128)
            && bounded(&self.fqdn, 1, 253)
            && bounded(&self.txt_value, 1, 512)
    }
}

/// `acme.result` carries either both PEM values or a typed error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcmeResult {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub certificate_pem: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_key_pem: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_phase: Option<String>,
}

impl AcmeResult {
    fn check(&self) -> bool {
        let success = self.certificate_pem.is_some() && self.private_key_pem.is_some();
        success != self.error.is_some()
            && bounded(&self.job_id, 1, 128)
            && self
                .certificate_pem
                .as_deref()
                .is_none_or(|value| bounded(value, 1, 1024 * 1024))
            && self
                .private_key_pem
                .as_deref()
                .is_none_or(|value| bounded(value, 1, 256 * 1024))
            && self
                .error
                .as_deref()
                .is_none_or(|value| bounded(value, 1, 16_384))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOpen {
    pub session_id: String,
    pub cols: u32,
    pub rows: u32,
}

impl PtyOpen {
    fn check(&self) -> bool {
        bounded(&self.session_id, 1, 128)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyStarted {
    pub session_id: String,
    pub shell: String,
    pub user: String,
}

impl PtyStarted {
    fn check(&self) -> bool {
        bounded(&self.session_id, 1, 128)
            && bounded(&self.shell, 1, 512)
            && bounded(&self.user, 1, 64)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyData {
    pub session_id: String,
    pub data: String,
}

impl PtyData {
    fn check(&self) -> bool {
        bounded(&self.session_id, 1, 128) && self.data.len() <= 1024 * 1024
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyResize {
    pub session_id: String,
    pub cols: u32,
    pub rows: u32,
}

impl PtyResize {
    fn check(&self) -> bool {
        bounded(&self.session_id, 1, 128)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyClose {
    pub session_id: String,
}

impl PtyClose {
    fn check(&self) -> bool {
        bounded(&self.session_id, 1, 128)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExit {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl PtyExit {
    fn check(&self) -> bool {
        bounded(&self.session_id, 1, 128)
            && self
                .reason
                .as_deref()
                .is_none_or(|value| bounded(value, 1, 64))
            && self
                .signal
                .as_deref()
                .is_none_or(|value| bounded(value, 0, 64))
            && self
                .detail
                .as_deref()
                .is_none_or(|value| bounded(value, 0, 256))
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
    const LOG_FIXTURES: &str =
        include_str!("../../../../packages/contracts/fixtures/agent-ws-v2-logs.frames.json");

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
    fn telemetry_fixtures_decode_to_the_shared_shape() {
        let document: Value = serde_json::from_str(FIXTURES).unwrap();
        let frames = document["frames"].as_array().unwrap();
        let decode_named = |name: &str, sender| {
            let entry = frames.iter().find(|entry| entry["name"] == name).unwrap();
            let text = serde_json::to_string(&entry["frame"]).unwrap();
            decode(&text, sender, MAX_FRAME_BYTES).unwrap().message
        };

        let Message::TelemetrySubscribe(subscribe) = decode_named(
            "control telemetry subscription for a coalesced live stream",
            Sender::ControlPlane,
        ) else {
            panic!("expected telemetry.subscribe");
        };
        assert_eq!(subscribe.subscription_id, "live-srv-1");
        assert_eq!(subscribe.purpose, TelemetryPurpose::Live);
        assert_eq!(subscribe.interval_ms, 2000);

        let Message::TelemetrySample(sample) = decode_named(
            "agent live telemetry sample with network rates and a scope key",
            Sender::Agent,
        ) else {
            panic!("expected telemetry.sample");
        };
        assert_eq!(sample.purpose, TelemetryPurpose::Live);
        assert_eq!(sample.subscription_id.as_deref(), Some("live-srv-1"));
        assert_eq!(sample.scope_key, "systemd|-|-|-|eth0,eth1");
        let network = sample.network.expect("live network rates");
        assert_eq!(network.tx_bytes_per_second, Some(8192.5));
        assert_eq!(network.rx_bytes_per_second, Some(65_536.0));
        assert_eq!(network.window_ms, 2000);

        let Message::TelemetrySample(history) = decode_named(
            "agent history telemetry sample with a missing network reading",
            Sender::Agent,
        ) else {
            panic!("expected telemetry.sample");
        };
        assert_eq!(history.purpose, TelemetryPurpose::History);
        assert_eq!(history.environment, TelemetryEnvironment::Docker);
        assert_eq!(history.cgroup_version, Some(2));
        assert_eq!(history.cpu_limit, Some(2.0));
        assert_eq!(history.memory_limit, Some(8_589_934_592));
        assert!(history.network.is_none());

        let Message::TelemetryInspect(inspect) = decode_named(
            "control on-demand telemetry inspection",
            Sender::ControlPlane,
        ) else {
            panic!("expected telemetry.inspect");
        };
        assert_eq!(inspect.request_id, "inspect-1");

        let Message::TelemetrySnapshot(snapshot) =
            decode_named("agent telemetry snapshot for an inspection", Sender::Agent)
        else {
            panic!("expected telemetry.snapshot");
        };
        assert_eq!(snapshot.request_id, "inspect-1");
        assert_eq!(snapshot.listeners.len(), 1);
        assert_eq!(snapshot.listeners[0].protocol, TelemetryProtocol::Tcp);
        assert_eq!(snapshot.listeners[0].port, 8080);
        assert_eq!(snapshot.interfaces[0].name, "eth0");
    }

    #[test]
    fn outbound_telemetry_round_trips_with_millisecond_time() {
        let sample = TelemetrySample {
            subscription_id: Some("live-srv-1".into()),
            purpose: TelemetryPurpose::Live,
            sampled_at: DateTime::parse_from_rfc3339("2026-11-19T00:02:02.000Z")
                .unwrap()
                .with_timezone(&Utc),
            cpu_percent: Some(37.5),
            memory: Some(TelemetryUsage {
                used: 1024,
                total: 2048,
            }),
            disk: None,
            environment: TelemetryEnvironment::Systemd,
            network_scope: "agent".into(),
            cgroup_version: None,
            cpu_limit: None,
            memory_limit: None,
            scope_key: "systemd|-|-|-|eth0".into(),
            network: Some(TelemetryNetwork {
                tx_bytes_per_second: Some(1.5),
                rx_bytes_per_second: Some(2.0),
                window_ms: 2000,
            }),
        };
        let text = encode("telemetry.sample", &sample, None).unwrap();
        assert!(text.contains("\"sampledAt\":\"2026-11-19T00:02:02.000Z\""));
        let decoded = decode(&text, Sender::Agent, MAX_FRAME_BYTES).unwrap();
        assert_eq!(decoded.message, Message::TelemetrySample(sample));
    }

    #[test]
    fn telemetry_rejects_out_of_contract_values() {
        let bad_interval = r#"{"v":2,"type":"telemetry.subscribe","ts":"2026-11-19T00:00:00Z","payload":{"subscriptionId":"live-1","purpose":"live","intervalMs":999}}"#;
        assert_eq!(
            decode(bad_interval, Sender::ControlPlane, MAX_FRAME_BYTES).unwrap_err(),
            DecodeError::InvalidPayload("telemetry.subscribe".into())
        );
        let bad_window = r#"{"v":2,"type":"telemetry.sample","ts":"2026-11-19T00:00:00Z","payload":{"purpose":"live","sampledAt":"2026-11-19T00:00:00Z","cpuPercent":null,"memory":null,"disk":null,"environment":"unknown","networkScope":"agent","cgroupVersion":null,"cpuLimit":null,"memoryLimit":null,"scopeKey":"unknown|-|-|-|-","network":{"txBytesPerSecond":null,"rxBytesPerSecond":null,"windowMs":0}}}"#;
        assert_eq!(
            decode(bad_window, Sender::Agent, MAX_FRAME_BYTES).unwrap_err(),
            DecodeError::InvalidPayload("telemetry.sample".into())
        );
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

    #[test]
    fn log_fixtures_decode_exactly_as_the_contract_expects() {
        let document: Value = serde_json::from_str(LOG_FIXTURES).unwrap();
        assert_eq!(document["subprotocol"], SUBPROTOCOL);
        let frames = document["frames"].as_array().unwrap();
        let mut agent_wire = 0;
        let mut seen = std::collections::HashSet::new();

        for entry in frames {
            let sender = entry["sender"].as_str().unwrap();
            // Browser frames belong to the admin relay, not the agent wire.
            if sender == "browser" || sender == "control-plane-browser" {
                continue;
            }
            agent_wire += 1;
            let name = entry["name"].as_str().unwrap();
            let text = serde_json::to_string(&entry["frame"]).unwrap();
            let expect = entry["expect"].as_str().unwrap();
            let sender = sender_of(sender);
            let result = decode(&text, sender, MAX_FRAME_BYTES);
            match expect {
                "ok" => {
                    let decoded = result.unwrap_or_else(|error| panic!("{name}: {error}"));
                    assert!(
                        !matches!(decoded.message, Message::Unknown(_)),
                        "{name}: a known log type decoded as unknown"
                    );
                    seen.insert(entry["frame"]["type"].as_str().unwrap());
                }
                code => {
                    let error = result.expect_err(name);
                    assert_eq!(error.code(), code, "{name}: {error}");
                }
            }
        }
        assert!(agent_wire >= 23, "agent log fixture set shrank");
        for message_type in [
            "logs.subscribe",
            "logs.unsubscribe",
            "logs.search",
            "logs.search.cancel",
            "logs.context",
            "logs.batch",
            "logs.gap",
            "logs.search.result",
            "logs.context.result",
            "logs.error",
        ] {
            assert!(seen.contains(message_type), "{message_type} has no fixture");
        }
    }

    #[test]
    fn log_results_round_trip_through_the_control_plane_decoder() {
        let generation = LogGeneration::new(u64::MAX);
        let record = LogRecord {
            seq: 9,
            time: Utc::now(),
            source: LogSource::SingBox,
            level: LogsLevel::Warn,
            process_generation: 2,
            text: "dial tcp refused".to_string(),
            truncated: false,
        };
        let cursor = LogCursor { generation, seq: 9 };
        let batch = Message::LogsBatch(LogsBatch {
            subscription_id: "tail-1".to_string(),
            next: cursor,
            has_more: false,
            records: vec![record.clone()],
        });
        let gap = Message::LogsGap(LogsGap {
            subscription_id: "tail-1".to_string(),
            generation,
            gap: LogGap {
                reason: LogGapReason::Overwritten,
                from_seq: 3,
                to_seq: 8,
            },
        });
        let search = Message::LogsSearchResult(LogsSearchResult {
            request_id: "req-search-2".to_string(),
            generation,
            pinned_seq: 42,
            matches: vec![record.clone()],
            next: Some(LogSearchCursor {
                generation,
                pinned_seq: 42,
                before: 9,
                floor: 0,
            }),
            coverage: LogCoverage {
                gap: None,
                searchable_from: Some(record.time),
                searchable_to: Some(record.time),
            },
        });
        let context = Message::LogsContextResult(LogsContextResult {
            request_id: "req-ctx-1".to_string(),
            generation,
            target: record.clone(),
            before: vec![record.clone()],
            after: Vec::new(),
        });
        let error = Message::LogsError(LogsError {
            code: LogErrorCode::Busy,
            subscription_id: None,
            request_id: Some("req-search-2".to_string()),
            message: "too many concurrent log searches".to_string(),
        });

        for (message_type, message) in [
            ("logs.batch", batch),
            ("logs.gap", gap),
            ("logs.search.result", search),
            ("logs.context.result", context),
            ("logs.error", error),
        ] {
            let text = match &message {
                Message::LogsBatch(payload) => encode(message_type, payload, None),
                Message::LogsGap(payload) => encode(message_type, payload, None),
                Message::LogsSearchResult(payload) => encode(message_type, payload, None),
                Message::LogsContextResult(payload) => encode(message_type, payload, None),
                Message::LogsError(payload) => encode(message_type, payload, None),
                _ => unreachable!(),
            }
            .unwrap();
            assert_eq!(
                decode(&text, Sender::Agent, MAX_FRAME_BYTES)
                    .unwrap()
                    .message,
                message,
                "{message_type}"
            );
        }
    }

    #[test]
    fn log_generations_and_error_shapes_are_strict() {
        let number = r#"{"v":2,"type":"logs.context","ts":"2026-11-19T00:00:00Z","payload":{"requestId":"r","generation":7,"seq":1,"before":0,"after":0}}"#;
        assert_eq!(
            decode(number, Sender::ControlPlane, MAX_FRAME_BYTES).unwrap_err(),
            DecodeError::InvalidPayload("logs.context".to_string())
        );
        let oversized = format!(
            r#"{{"v":2,"type":"logs.context","ts":"2026-11-19T00:00:00Z","payload":{{"requestId":"r","generation":"{}","seq":1,"before":0,"after":0}}}}"#,
            u128::from(u64::MAX) + 1
        );
        assert_eq!(
            decode(&oversized, Sender::ControlPlane, MAX_FRAME_BYTES).unwrap_err(),
            DecodeError::InvalidPayload("logs.context".to_string())
        );
        let both_ids = LogsError {
            code: LogErrorCode::Busy,
            subscription_id: Some("tail-1".to_string()),
            request_id: Some("req".to_string()),
            message: "ambiguous".to_string(),
        };
        assert!(!both_ids.check());
        let neither = LogsError {
            subscription_id: None,
            request_id: None,
            ..both_ids
        };
        assert!(!neither.check());
    }
}
