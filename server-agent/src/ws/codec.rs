//! Wire codec for the frozen agent WebSocket protocol (v1).
//!
//! Every frame is a JSON text frame carrying the `AgentWsFrame` envelope:
//!
//! ```json
//! { "v": 1, "id": "<optional>", "type": "<string>", "ts": "<RFC3339>", "payload": {} }
//! ```
//!
//! Decoding is explicit: the envelope is parsed first, then the payload is
//! deserialized into the strongly-typed message for its `type`. Frames this
//! agent does not understand (a newer control plane, or the reserved
//! `telemetry.*` / `pty.*` / future `acme.*` frames) decode to
//! [`AgentMessage::Unknown`] / a reserved channel variant instead of failing,
//! so an old agent never tears down the connection over an added frame type.
//! Optional envelope and payload fields carry `#[serde(default)]` so frames
//! written by an earlier control plane still decode.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// The only protocol version this agent speaks.
pub const PROTOCOL_VERSION: u8 = 1;

/// Frame `type` values. Message types are dotted strings on the wire.
pub mod frame_type {
    pub const HELLO: &str = "hello";
    pub const WELCOME: &str = "welcome";
    pub const PING: &str = "ping";
    pub const PONG: &str = "pong";
    pub const CONFIG_NOTIFY: &str = "config.notify";
    pub const CONFIG_ACK: &str = "config.ack";
    pub const UPDATE_TRIGGER: &str = "update.trigger";
    pub const UPDATE_STATUS: &str = "update.status";
    pub const ACME_ISSUE: &str = "acme.issue";
    pub const ACME_DNS_PRESENT: &str = "acme.dns_present";
    pub const ACME_DNS_CLEANUP: &str = "acme.dns_cleanup";
    pub const ACME_DNS_ACK: &str = "acme.dns_ack";
    pub const ACME_RESULT: &str = "acme.result";
    pub const PTY_OPEN: &str = "pty.open";
    pub const PTY_STARTED: &str = "pty.started";
    pub const PTY_DATA: &str = "pty.data";
    pub const PTY_RESIZE: &str = "pty.resize";
    pub const PTY_CLOSE: &str = "pty.close";
    pub const PTY_EXIT: &str = "pty.exit";
}

const TELEMETRY_PREFIX: &str = "telemetry.";
const PTY_PREFIX: &str = "pty.";
const ACME_PREFIX: &str = "acme.";

fn default_protocol_version() -> u8 {
    PROTOCOL_VERSION
}

fn empty_payload() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

/// The versioned JSON envelope carried in every text frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentWsFrame {
    #[serde(default = "default_protocol_version")]
    pub v: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(default = "Utc::now")]
    pub ts: DateTime<Utc>,
    #[serde(default = "empty_payload")]
    pub payload: serde_json::Value,
}

impl AgentWsFrame {
    /// Builds a frame with a freshly stamped `ts` and no correlation id.
    pub fn new(msg_type: impl Into<String>, payload: impl Serialize) -> Result<Self, CodecError> {
        Ok(Self {
            v: PROTOCOL_VERSION,
            id: None,
            msg_type: msg_type.into(),
            ts: Utc::now(),
            payload: serde_json::to_value(payload)?,
        })
    }

    /// Builds a frame that echoes a control-plane correlation id.
    pub fn reply(
        msg_type: impl Into<String>,
        id: Option<String>,
        payload: impl Serialize,
    ) -> Result<Self, CodecError> {
        let mut frame = Self::new(msg_type, payload)?;
        frame.id = id;
        Ok(frame)
    }

    pub fn encode(&self) -> Result<String, CodecError> {
        Ok(serde_json::to_string(self)?)
    }

    /// Decodes a text frame, rejecting only a different protocol version.
    pub fn decode(text: &str) -> Result<DecodedFrame, CodecError> {
        let frame: Self = serde_json::from_str(text)?;
        if frame.v != PROTOCOL_VERSION {
            return Err(CodecError::UnsupportedVersion(frame.v));
        }
        let message = decode_message(&frame.msg_type, frame.payload.clone())?;
        Ok(DecodedFrame { frame, message })
    }

    /// Decodes just the payload of an already-parsed envelope.
    pub fn message(&self) -> Result<AgentMessage, CodecError> {
        decode_message(&self.msg_type, self.payload.clone())
    }
}

/// An envelope plus its decoded message.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedFrame {
    pub frame: AgentWsFrame,
    pub message: AgentMessage,
}

/// Strongly-typed protocol messages. Reserved channel variants keep the raw
/// payload until the PR that owns that channel adds its handlers.
#[derive(Debug, Clone, PartialEq)]
pub enum AgentMessage {
    Hello(HelloPayload),
    Welcome(WelcomePayload),
    Ping(PingPayload),
    Pong(PingPayload),
    ConfigNotify(ConfigNotifyPayload),
    ConfigAck(ConfigAckPayload),
    UpdateTrigger(UpdateTriggerPayload),
    UpdateStatus(UpdateStatusPayload),
    AcmeIssue(AcmeIssuePayload),
    AcmeDnsAck(AcmeDnsAckPayload),
    /// `telemetry.*`, reserved for the host/container telemetry work.
    Telemetry(ReservedFrame),
    /// `pty.*`, reserved for the interactive terminal work.
    Pty(ReservedFrame),
    /// An unrecognized `acme.*` frame; typed ACME frames have their own arms.
    Acme(ReservedFrame),
    /// A frame type this agent does not know; callers ignore it.
    Unknown {
        frame_type: String,
    },
}

/// A reserved-channel frame kept as raw JSON.
#[derive(Debug, Clone, PartialEq)]
pub struct ReservedFrame {
    pub frame_type: String,
    pub payload: serde_json::Value,
}

fn decode_message(
    frame_type: &str,
    payload: serde_json::Value,
) -> Result<AgentMessage, CodecError> {
    fn payload_of<T: serde::de::DeserializeOwned>(
        frame_type: &str,
        payload: serde_json::Value,
    ) -> Result<T, CodecError> {
        serde_json::from_value(payload).map_err(|source| CodecError::Payload {
            frame_type: frame_type.to_string(),
            source,
        })
    }

    let message = match frame_type {
        frame_type::HELLO => AgentMessage::Hello(payload_of(frame_type, payload)?),
        frame_type::WELCOME => AgentMessage::Welcome(payload_of(frame_type, payload)?),
        frame_type::PING => AgentMessage::Ping(payload_of(frame_type, payload)?),
        frame_type::PONG => AgentMessage::Pong(payload_of(frame_type, payload)?),
        frame_type::CONFIG_NOTIFY => AgentMessage::ConfigNotify(payload_of(frame_type, payload)?),
        frame_type::CONFIG_ACK => AgentMessage::ConfigAck(payload_of(frame_type, payload)?),
        frame_type::UPDATE_TRIGGER => AgentMessage::UpdateTrigger(payload_of(frame_type, payload)?),
        frame_type::UPDATE_STATUS => AgentMessage::UpdateStatus(payload_of(frame_type, payload)?),
        frame_type::ACME_ISSUE => AgentMessage::AcmeIssue(payload_of(frame_type, payload)?),
        frame_type::ACME_DNS_ACK => AgentMessage::AcmeDnsAck(payload_of(frame_type, payload)?),
        other if other.starts_with(TELEMETRY_PREFIX) => AgentMessage::Telemetry(ReservedFrame {
            frame_type: other.to_string(),
            payload,
        }),
        other if other.starts_with(PTY_PREFIX) => AgentMessage::Pty(ReservedFrame {
            frame_type: other.to_string(),
            payload,
        }),
        other if other.starts_with(ACME_PREFIX) => AgentMessage::Acme(ReservedFrame {
            frame_type: other.to_string(),
            payload,
        }),
        other => AgentMessage::Unknown {
            frame_type: other.to_string(),
        },
    };
    Ok(message)
}

/// `hello` (agent -> server, sent on every connect/reconnect).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloPayload {
    pub agent_version: String,
    pub agent_build_id: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub certificate_deployments: Vec<CertificateDeployment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updates: Option<UpdateStatusPayload>,
}

/// A certificate generation this agent has staged and/or committed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateDeployment {
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

/// `welcome` (server -> agent).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WelcomePayload {
    pub server_id: String,
    pub server_name: String,
    pub protocol_version: u8,
    pub desired_revision_seq: u64,
    pub desired_revision: String,
    pub poll_interval_seconds: u64,
    pub heartbeat_interval_seconds: u64,
    /// Vercel Fluid Compute caps a connection at the function's `maxDuration`;
    /// the control plane tells the agent to reconnect before that point.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reconnect_before_seconds: Option<u64>,
}

/// `ping` / `pong` payload.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
}

/// `config.notify` (server -> agent).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigNotifyPayload {
    pub desired_revision_seq: u64,
    pub desired_revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `config.ack` (agent -> server), sent once the candidate committed or failed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigAckPayload {
    pub applied_revision: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub certificate_deployments: Vec<CertificateDeployment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `update.trigger` target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateTarget {
    Agent,
    SingBox,
    All,
}

/// `update.trigger` (server -> agent). A missing or `null` desired version
/// means "resolve the latest release".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTriggerPayload {
    pub target: UpdateTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desired_agent_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desired_sing_box_version: Option<String>,
    #[serde(default)]
    pub force: bool,
}

/// `update.status` (agent -> server).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatusPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<UpdateStatePayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sing_box: Option<UpdateStatePayload>,
}

/// Per-binary update state. `state` uses the control plane's snake_case names
/// (`checking`, `downloading`, `verifying`, `applying`, `restarting`,
/// `up_to_date`, `failed`, ...).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatePayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_version: Option<String>,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<DateTime<Utc>>,
}

/// `acme.issue` (control plane -> designated issuer agent).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcmeIssuePayload {
    pub job_id: String,
    pub certificate_id: String,
    pub generation: u64,
    pub domains: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acme_email: Option<String>,
    pub acme_provider: String,
    #[serde(default)]
    pub acme_staging: bool,
    pub challenge_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_account_binding: Option<ExternalAccountBindingPayload>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAccountBindingPayload {
    pub kid: String,
    pub hmac_key: String,
}

impl std::fmt::Debug for ExternalAccountBindingPayload {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ExternalAccountBindingPayload")
            .field("kid", &self.kid)
            .field("hmac_key", &"<redacted>")
            .finish()
    }
}

/// `acme.dns_ack` (control plane -> issuer agent).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcmeDnsAckPayload {
    pub job_id: String,
    pub fqdn: String,
    pub txt_value: String,
    pub accepted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug)]
pub enum CodecError {
    Json(serde_json::Error),
    UnsupportedVersion(u8),
    Payload {
        frame_type: String,
        source: serde_json::Error,
    },
}

impl std::fmt::Display for CodecError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Json(error) => write!(formatter, "invalid frame envelope: {error}"),
            Self::UnsupportedVersion(version) => {
                write!(formatter, "unsupported protocol version {version}")
            }
            Self::Payload { frame_type, source } => {
                write!(formatter, "invalid {frame_type} payload: {source}")
            }
        }
    }
}

impl std::error::Error for CodecError {}

impl From<serde_json::Error> for CodecError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone as _, Utc};

    use super::{
        AgentMessage, AgentWsFrame, CertificateDeployment, CodecError, ConfigAckPayload,
        HelloPayload, PROTOCOL_VERSION, PingPayload, UpdateStatePayload, UpdateStatusPayload,
        UpdateTarget, UpdateTriggerPayload, WelcomePayload, frame_type,
    };

    fn hello() -> HelloPayload {
        HelloPayload {
            agent_version: "0.2.0".into(),
            agent_build_id: "local-test".into(),
            capabilities: vec!["config-v3".into(), "ws-v1".into()],
            applied_revision: Some("sha256:abc".into()),
            certificate_deployments: vec![CertificateDeployment {
                certificate_id: "cert-1".into(),
                generation: 2,
                fingerprint_sha256: "deadbeef".into(),
                installed: true,
                in_use: false,
                error_phase: None,
                error_message: None,
            }],
            updates: Some(UpdateStatusPayload {
                agent: Some(UpdateStatePayload {
                    target_version: Some("0.3.0".into()),
                    state: "checking".into(),
                    message: None,
                    checked_at: Some(Utc.timestamp_opt(1_700_000_000, 0).unwrap()),
                }),
                sing_box: None,
            }),
        }
    }

    #[test]
    fn hello_frame_round_trips_with_camel_case_fields() {
        let frame = AgentWsFrame::new(frame_type::HELLO, hello()).unwrap();
        let encoded = frame.encode().unwrap();
        assert!(encoded.contains("\"agentBuildId\":\"local-test\""));
        assert!(encoded.contains("\"appliedRevision\":\"sha256:abc\""));

        let decoded = AgentWsFrame::decode(&encoded).unwrap();
        assert_eq!(decoded.frame.v, PROTOCOL_VERSION);
        assert_eq!(decoded.message, AgentMessage::Hello(hello()));
    }

    #[test]
    fn welcome_round_trips_and_omits_the_reconnect_hint() {
        let welcome = WelcomePayload {
            server_id: "srv-1".into(),
            server_name: "edge".into(),
            protocol_version: 1,
            desired_revision_seq: 7,
            desired_revision: "sha256:rev".into(),
            poll_interval_seconds: 60,
            heartbeat_interval_seconds: 30,
            reconnect_before_seconds: None,
        };
        let encoded = serde_json::to_string(&welcome).unwrap();
        assert!(!encoded.contains("reconnectBeforeSeconds"));

        let decoded: WelcomePayload = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, welcome);
    }

    #[test]
    fn missing_optional_envelope_fields_still_decode() {
        let decoded = AgentWsFrame::decode(r#"{"type":"ping","payload":{}}"#).unwrap();
        assert_eq!(decoded.frame.v, PROTOCOL_VERSION);
        assert_eq!(decoded.frame.id, None);
        assert_eq!(decoded.message, AgentMessage::Ping(PingPayload::default()));
    }

    #[test]
    fn frame_without_payload_decodes_for_ping() {
        let decoded = AgentWsFrame::decode(r#"{"v":1,"type":"pong"}"#).unwrap();
        assert_eq!(decoded.message, AgentMessage::Pong(PingPayload::default()));
    }

    #[test]
    fn unknown_frame_types_are_ignored_not_rejected() {
        let decoded =
            AgentWsFrame::decode(r#"{"v":1,"type":"future.thing","payload":{"anything":true}}"#)
                .unwrap();
        assert_eq!(
            decoded.message,
            AgentMessage::Unknown {
                frame_type: "future.thing".into()
            }
        );
    }

    #[test]
    fn reserved_channels_decode_without_handlers() {
        let telemetry =
            AgentWsFrame::decode(r#"{"v":1,"type":"telemetry.sample","payload":{"cpu":1}}"#)
                .unwrap();
        assert!(matches!(telemetry.message, AgentMessage::Telemetry(_)));

        let pty = AgentWsFrame::decode(r#"{"v":1,"type":"pty.data","payload":{}}"#).unwrap();
        assert!(matches!(pty.message, AgentMessage::Pty(_)));

        let acme = AgentWsFrame::decode(r#"{"v":1,"type":"acme.future","payload":{}}"#).unwrap();
        assert!(matches!(acme.message, AgentMessage::Acme(_)));
    }

    #[test]
    fn acme_control_frames_decode_with_bounded_fields_and_redacted_eab() {
        let decoded = AgentWsFrame::decode(
            r#"{"v":1,"type":"acme.issue","payload":{"jobId":"job-1","certificateId":"cert-1","generation":2,"domains":["example.com"],"acmeProvider":"zerossl","challengeType":"dns-01","externalAccountBinding":{"kid":"kid-1","hmacKey":"redacted-test-value"}}}"#,
        )
        .unwrap();
        let AgentMessage::AcmeIssue(issue) = decoded.message else {
            panic!("expected acme.issue");
        };
        assert_eq!(issue.job_id, "job-1");
        assert_eq!(issue.generation, 2);
        assert!(!format!("{issue:?}").contains("redacted-test-value"));

        let ack = AgentWsFrame::decode(
            r#"{"v":1,"type":"acme.dns_ack","payload":{"jobId":"job-1","fqdn":"_acme-challenge.example.com","txtValue":"digest","accepted":true}}"#,
        )
        .unwrap();
        let AgentMessage::AcmeDnsAck(ack) = ack.message else {
            panic!("expected acme.dns_ack");
        };
        assert!(ack.accepted);
    }

    #[test]
    fn rejects_a_different_protocol_version() {
        let error = AgentWsFrame::decode(r#"{"v":2,"type":"ping","payload":{}}"#).unwrap_err();
        assert!(matches!(error, CodecError::UnsupportedVersion(2)));
    }

    #[test]
    fn config_ack_and_update_trigger_round_trip() {
        let ack = ConfigAckPayload {
            applied_revision: "sha256:abc".into(),
            certificate_deployments: vec![],
            error: Some("preflight failed".into()),
        };
        let decoded = AgentWsFrame::decode(
            &AgentWsFrame::new(frame_type::CONFIG_ACK, ack.clone())
                .unwrap()
                .encode()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(decoded.message, AgentMessage::ConfigAck(ack));

        let trigger = UpdateTriggerPayload {
            target: UpdateTarget::SingBox,
            desired_agent_version: None,
            desired_sing_box_version: Some("1.15.0".into()),
            force: true,
        };
        let encoded = serde_json::to_string(&trigger).unwrap();
        assert!(encoded.contains("\"target\":\"sing-box\""));
        assert!(encoded.contains("\"force\":true"));
        let decoded: UpdateTriggerPayload = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, trigger);
    }

    #[test]
    fn null_desired_version_is_treated_as_latest() {
        let decoded = AgentWsFrame::decode(
            r#"{"v":1,"type":"update.trigger","payload":{"target":"agent","desiredAgentVersion":null}}"#,
        )
        .unwrap();
        let AgentMessage::UpdateTrigger(trigger) = decoded.message else {
            panic!("expected update.trigger");
        };
        assert_eq!(trigger.target, UpdateTarget::Agent);
        assert_eq!(trigger.desired_agent_version, None);
    }

    #[test]
    fn malformed_known_payload_reports_the_frame_type() {
        let error = AgentWsFrame::decode(r#"{"v":1,"type":"welcome","payload":{}}"#).unwrap_err();
        match error {
            CodecError::Payload { frame_type, .. } => assert_eq!(frame_type, "welcome"),
            other => panic!("unexpected error: {other}"),
        }
    }

    #[test]
    fn reply_echoes_the_correlation_id() {
        let frame = AgentWsFrame::reply(
            frame_type::PONG,
            Some("req-1".into()),
            PingPayload::default(),
        )
        .unwrap();
        let encoded = frame.encode().unwrap();
        let decoded = AgentWsFrame::decode(&encoded).unwrap();
        assert_eq!(decoded.frame.id.as_deref(), Some("req-1"));
    }
}
