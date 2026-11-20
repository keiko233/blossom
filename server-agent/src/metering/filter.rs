//! Inbound classification and subscriber identity filtering.
//!
//! The control plane encodes the billable subscriber identity in the sing-box
//! inbound user name (`blz.1.<node-length>.<subscription-length>.<node><subscription>`;
//! see `app/src/orpc/proxy/traffic-user-codec.ts`). Peer and probe listeners
//! never enter the accountant. A missing inbound tag, an unclassified tag, or
//! a subscriber user that does not decode fails closed: no further checkpoint
//! is committed for that runtime instance until a new instance is attached
//! with a complete classification.

use std::collections::{BTreeMap, HashSet};
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[cfg(test)]
use crate::stats::ConnectionEvent;
use crate::stats::ConnectionEvents;

const IDENTITY_TAG: &str = "blz.1.";
const MAX_IDENTITY_LEN: usize = 4096;
const MAX_LENGTH_DIGITS: usize = 9;

/// Runtime tag namespaces reserved by the managed networking contract. A
/// committed generation can only be metered when every inbound belongs to one
/// of them; an unrecognised tag fails closed instead of being treated as a
/// subscriber.
const SUBSCRIBER_INBOUND_TAG_PREFIX: &str = "node-";
const PEER_INBOUND_TAG_PREFIX: &str = "peer-in-";
const AGENT_OWNED_TAG_PREFIX: &str = "blossom-agent-";

/// What a configured inbound is allowed to contribute to billable traffic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum InboundKind {
    /// A subscriber entrance. Only connections whose user name decodes as a
    /// subscriber identity are billable.
    Subscriber,
    /// A managed peer listener. Infrastructure telemetry, never billable.
    Peer,
    /// An agent-owned probe listener. Infrastructure telemetry, never billable.
    Probe,
}

/// The committed generation's fixed tag-to-kind mapping. A config change is a
/// new generation and therefore a new runtime instance, so the classification
/// never changes for the lifetime of one meter.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct InboundClassification {
    kinds: BTreeMap<String, InboundKind>,
}

impl InboundClassification {
    /// Builds a classification from explicit entries. Duplicate or empty tags
    /// are rejected rather than silently producing an ambiguous mapping.
    pub(crate) fn new(
        entries: impl IntoIterator<Item = (String, InboundKind)>,
    ) -> Result<Self, ClassificationError> {
        let mut kinds = BTreeMap::new();
        for (tag, kind) in entries {
            if tag.is_empty() {
                return Err(ClassificationError::EmptyTag);
            }
            if kinds.insert(tag.clone(), kind).is_some() {
                return Err(ClassificationError::DuplicateTag(tag));
            }
        }
        Ok(Self { kinds })
    }

    /// Marks every supplied tag as a subscriber inbound. Integration must
    /// supply the tags from the committed generation, never an observed
    /// stream value.
    #[cfg(test)]
    pub(crate) fn subscriber_only(
        tags: impl IntoIterator<Item = String>,
    ) -> Result<Self, ClassificationError> {
        Self::new(tags.into_iter().map(|tag| (tag, InboundKind::Subscriber)))
    }

    pub(crate) fn kind(&self, tag: &str) -> Option<InboundKind> {
        self.kinds.get(tag).copied()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.kinds.is_empty()
    }

    /// Every tag this classification proves, for the managed capability gate.
    pub(crate) fn tags(&self) -> Vec<String> {
        self.kinds.keys().cloned().collect()
    }

    /// Classifies the inbounds of an already-compiled, committed config. Tags
    /// outside the managed runtime namespaces are rejected: metering must
    /// fail closed rather than bill an unrecognised listener.
    pub(crate) fn from_committed_config(
        config: &Map<String, Value>,
    ) -> Result<Self, ClassificationError> {
        let inbounds = match config.get("inbounds") {
            None => &[][..],
            Some(Value::Array(inbounds)) => inbounds.as_slice(),
            Some(_) => return Err(ClassificationError::MalformedInbounds),
        };
        let mut entries = Vec::with_capacity(inbounds.len());
        for inbound in inbounds {
            let tag = inbound
                .get("tag")
                .and_then(Value::as_str)
                .ok_or(ClassificationError::EmptyTag)?;
            entries.push((tag.to_string(), classify_committed_tag(tag)?));
        }
        Self::new(entries)
    }

    /// Proves that every tag in the committed generation is explicitly
    /// classified. Missing or extra tags fail the managed capability gate.
    pub(crate) fn prove_for(&self, configured_tags: &[String]) -> Result<(), ClassificationError> {
        if configured_tags.is_empty() {
            return Err(ClassificationError::NoInbounds);
        }
        let mut seen = HashSet::new();
        for tag in configured_tags {
            if tag.is_empty() {
                return Err(ClassificationError::EmptyTag);
            }
            if !seen.insert(tag) {
                return Err(ClassificationError::DuplicateTag(tag.clone()));
            }
            if !self.kinds.contains_key(tag) {
                return Err(ClassificationError::MissingTag(tag.clone()));
            }
        }
        if self.kinds.len() != configured_tags.len() {
            return Err(ClassificationError::UnexpectedTags);
        }
        Ok(())
    }

    /// Filters one stream message before the accountant sees it. UPDATE
    /// events carry no inbound metadata, but they can only refer to a
    /// connection that was previously admitted by this filter.
    pub(crate) fn filter(&self, message: &ConnectionEvents) -> FilteredMessage {
        let mut counts = FilterCounts::default();
        let mut events = Vec::with_capacity(message.events.len());
        let mut unproven = false;
        for event in &message.events {
            let Some(connection) = event.connection.as_ref() else {
                events.push(event.clone());
                continue;
            };
            if connection.inbound.is_empty() {
                counts.missing_inbound += 1;
                unproven = true;
                continue;
            }
            match self.kind(&connection.inbound) {
                Some(InboundKind::Subscriber) => {
                    if SubscriberIdentity::decode(&connection.user).is_none() {
                        counts.undecodable_identities += 1;
                        continue;
                    }
                    events.push(event.clone());
                }
                Some(InboundKind::Peer) => counts.peer_events += 1,
                Some(InboundKind::Probe) => counts.probe_events += 1,
                None => {
                    counts.unknown_tags += 1;
                    unproven = true;
                }
            }
        }
        FilteredMessage {
            message: ConnectionEvents {
                events,
                reset: message.reset,
            },
            counts,
            unproven,
        }
    }
}

/// The decoded subscriber identity from an inbound user name. The original
/// encoded name remains the report key; the control plane decodes it into the
/// subscription (and, when still owned by the server, the node).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SubscriberIdentity {
    pub(crate) node_id: String,
    pub(crate) subscription_id: String,
}

impl SubscriberIdentity {
    /// Decodes the versioned, length-prefixed codec. Lengths are counted in
    /// UTF-16 code units to match the JavaScript control plane. A legacy bare
    /// subscription id is not billable under managed metering.
    pub(crate) fn decode(raw: &str) -> Option<Self> {
        if raw.len() > MAX_IDENTITY_LEN || !raw.starts_with(IDENTITY_TAG) {
            return None;
        }
        let rest = &raw[IDENTITY_TAG.len()..];
        let (node_length, rest) = read_length(rest)?;
        let (subscription_length, payload) = read_length(rest)?;
        let units: Vec<u16> = payload.encode_utf16().collect();
        if units.len() != node_length + subscription_length {
            return None;
        }
        let node_id = String::from_utf16(&units[..node_length]).ok()?;
        let subscription_id = String::from_utf16(&units[node_length..]).ok()?;
        if subscription_id.is_empty() {
            return None;
        }
        Some(Self {
            node_id,
            subscription_id,
        })
    }
}

/// Reads one decimal length terminated by a `.` from `value`.
fn read_length(value: &str) -> Option<(usize, &str)> {
    let dot = value.find('.')?;
    if dot == 0 || dot > MAX_LENGTH_DIGITS {
        return None;
    }
    let digits = &value[..dot];
    if !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let length = digits.parse::<usize>().ok()?;
    Some((length, &value[dot + 1..]))
}

/// What the filter removed from one message.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct FilterCounts {
    pub(crate) peer_events: usize,
    pub(crate) probe_events: usize,
    pub(crate) unknown_tags: usize,
    pub(crate) missing_inbound: usize,
    pub(crate) undecodable_identities: usize,
}

impl FilterCounts {
    pub(crate) fn add(&mut self, other: Self) {
        self.peer_events += other.peer_events;
        self.probe_events += other.probe_events;
        self.unknown_tags += other.unknown_tags;
        self.missing_inbound += other.missing_inbound;
        self.undecodable_identities += other.undecodable_identities;
    }
}

#[derive(Debug)]
pub(crate) struct FilteredMessage {
    pub(super) message: ConnectionEvents,
    pub(crate) counts: FilterCounts,
    /// A missing or unclassified inbound means the runtime cannot prove that
    /// billable traffic is isolated from peer/probe traffic.
    pub(crate) unproven: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ClassificationError {
    EmptyTag,
    DuplicateTag(String),
    MissingTag(String),
    UnknownTag(String),
    UnexpectedTags,
    NoInbounds,
    MalformedInbounds,
}

impl fmt::Display for ClassificationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyTag => formatter.write_str("an inbound tag is empty"),
            Self::DuplicateTag(tag) => write!(formatter, "inbound tag {tag} is classified twice"),
            Self::MissingTag(tag) => {
                write!(
                    formatter,
                    "inbound tag {tag} has no billable classification"
                )
            }
            Self::UnknownTag(tag) => {
                write!(
                    formatter,
                    "inbound tag {tag} is outside the managed runtime namespaces"
                )
            }
            Self::UnexpectedTags => {
                formatter.write_str("classification contains an unconfigured inbound tag")
            }
            Self::NoInbounds => formatter.write_str("the configuration has no classified inbounds"),
            Self::MalformedInbounds => {
                formatter.write_str("the configuration has a malformed inbounds value")
            }
        }
    }
}

impl std::error::Error for ClassificationError {}

/// Gate for advertising managed metering. A supported stats protocol and a
/// complete, explicitly committed classification are both required; anything
/// less keeps peer links and managed metering disabled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ManagedMetering {
    Ready,
    Unsupported(MeteringCapabilityError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MeteringCapabilityError {
    UnsupportedStatsProtocol,
    Classification(ClassificationError),
}

impl fmt::Display for MeteringCapabilityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedStatsProtocol => {
                formatter.write_str("the stats protocol does not provide the inbound field")
            }
            Self::Classification(error) => error.fmt(formatter),
        }
    }
}

/// `stats_protocol_supported` comes from the existing >= 1.14 sing-box gate;
/// `configured_tags` must come from the committed generation, not the stream.
pub(crate) fn managed_metering(
    stats_protocol_supported: bool,
    classification: &InboundClassification,
    configured_tags: &[String],
) -> ManagedMetering {
    if !stats_protocol_supported {
        return ManagedMetering::Unsupported(MeteringCapabilityError::UnsupportedStatsProtocol);
    }
    match classification.prove_for(configured_tags) {
        Ok(()) => ManagedMetering::Ready,
        Err(error) => ManagedMetering::Unsupported(MeteringCapabilityError::Classification(error)),
    }
}

/// Maps one committed inbound tag to the kind that owns its traffic.
fn classify_committed_tag(tag: &str) -> Result<InboundKind, ClassificationError> {
    if let Some(id) = tag.strip_prefix(SUBSCRIBER_INBOUND_TAG_PREFIX) {
        return (!id.is_empty())
            .then_some(InboundKind::Subscriber)
            .ok_or(ClassificationError::EmptyTag);
    }
    if let Some(id) = tag.strip_prefix(PEER_INBOUND_TAG_PREFIX) {
        return (!id.is_empty())
            .then_some(InboundKind::Peer)
            .ok_or(ClassificationError::EmptyTag);
    }
    if let Some(id) = tag.strip_prefix(AGENT_OWNED_TAG_PREFIX) {
        return (!id.is_empty())
            .then_some(InboundKind::Probe)
            .ok_or(ClassificationError::EmptyTag);
    }
    Err(ClassificationError::UnknownTag(tag.to_string()))
}

/// Test-only helper mirroring a new/closed event with a tagged inbound.
#[cfg(test)]
pub(crate) fn test_event(
    event_type: i32,
    id: &str,
    inbound: &str,
    user: &str,
    uplink_total: i64,
    downlink_total: i64,
    closed_at: i64,
) -> ConnectionEvent {
    use crate::stats::Connection;

    ConnectionEvent {
        r#type: event_type,
        id: id.to_owned(),
        connection: Some(Connection {
            inbound: inbound.to_owned(),
            user: user.to_owned(),
            closed_at,
            uplink_total,
            downlink_total,
        }),
        uplink_delta: 0,
        downlink_delta: 0,
        closed_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(events: Vec<ConnectionEvent>) -> ConnectionEvents {
        ConnectionEvents {
            events,
            reset: true,
        }
    }

    fn event(inbound: &str, user: &str) -> ConnectionEvent {
        test_event(0, "c1", inbound, user, 10, 2, 0)
    }

    #[test]
    fn subscriber_identity_decodes_the_control_plane_codec() {
        let identity = SubscriberIdentity::decode("blz.1.2.5.n1sub-a").unwrap();
        assert_eq!(identity.node_id, "n1");
        assert_eq!(identity.subscription_id, "sub-a");
        assert!(SubscriberIdentity::decode("bare-subscription").is_none());
        assert!(SubscriberIdentity::decode("blz.1.2.5.n1sub").is_none());
        assert!(SubscriberIdentity::decode("blz.1.x.5.n1sub-a").is_none());
        assert!(SubscriberIdentity::decode("blz.1.2.5.").is_none());
    }

    #[test]
    fn classification_requires_every_committed_tag_and_no_extra_tags() {
        let tags = vec!["node-n1".to_string(), "peer-b".to_string()];
        let classification = InboundClassification::new([
            ("node-n1".to_string(), InboundKind::Subscriber),
            ("peer-b".to_string(), InboundKind::Peer),
        ])
        .unwrap();
        assert!(classification.prove_for(&tags).is_ok());

        let missing =
            InboundClassification::new([("node-n1".to_string(), InboundKind::Subscriber)]).unwrap();
        assert!(matches!(
            missing.prove_for(&tags),
            Err(ClassificationError::MissingTag(tag)) if tag == "peer-b"
        ));

        let extra = InboundClassification::new([
            ("node-n1".to_string(), InboundKind::Subscriber),
            ("peer-b".to_string(), InboundKind::Peer),
            ("probe".to_string(), InboundKind::Probe),
        ])
        .unwrap();
        assert!(matches!(
            extra.prove_for(&tags),
            Err(ClassificationError::UnexpectedTags)
        ));
        assert!(matches!(
            InboundClassification::new([("".to_string(), InboundKind::Subscriber)]),
            Err(ClassificationError::EmptyTag)
        ));
        assert!(matches!(
            InboundClassification::new([
                ("node-n1".to_string(), InboundKind::Subscriber),
                ("node-n1".to_string(), InboundKind::Peer),
            ]),
            Err(ClassificationError::DuplicateTag(tag)) if tag == "node-n1"
        ));
    }

    #[test]
    fn committed_config_maps_runtime_namespaces_and_rejects_unrecognised_tags() {
        let config = serde_json::json!({
            "inbounds": [
                { "tag": "node-n1" },
                { "tag": "peer-in-b" },
                { "tag": "blossom-agent-probe" }
            ]
        });
        let classification =
            InboundClassification::from_committed_config(config.as_object().unwrap()).unwrap();
        assert_eq!(
            classification.kind("node-n1"),
            Some(InboundKind::Subscriber)
        );
        assert_eq!(classification.kind("peer-in-b"), Some(InboundKind::Peer));
        assert_eq!(
            classification.kind("blossom-agent-probe"),
            Some(InboundKind::Probe)
        );
        assert_eq!(
            classification.tags(),
            vec![
                "blossom-agent-probe".to_string(),
                "node-n1".to_string(),
                "peer-in-b".to_string(),
            ]
        );

        let unknown = serde_json::json!({ "inbounds": [{ "tag": "legacy" }] });
        assert!(matches!(
            InboundClassification::from_committed_config(unknown.as_object().unwrap()),
            Err(ClassificationError::UnknownTag(tag)) if tag == "legacy"
        ));
        let empty_namespace = serde_json::json!({ "inbounds": [{ "tag": "node-" }] });
        assert!(matches!(
            InboundClassification::from_committed_config(empty_namespace.as_object().unwrap()),
            Err(ClassificationError::EmptyTag)
        ));
        let missing_tag = serde_json::json!({ "inbounds": [{}] });
        assert!(matches!(
            InboundClassification::from_committed_config(missing_tag.as_object().unwrap()),
            Err(ClassificationError::EmptyTag)
        ));
        let malformed = serde_json::json!({ "inbounds": "not-an-array" });
        assert!(matches!(
            InboundClassification::from_committed_config(malformed.as_object().unwrap()),
            Err(ClassificationError::MalformedInbounds)
        ));
        let disabled = serde_json::json!({ "inbounds": [] });
        let classification =
            InboundClassification::from_committed_config(disabled.as_object().unwrap()).unwrap();
        assert!(classification.tags().is_empty());
        assert!(matches!(
            managed_metering(true, &classification, &classification.tags()),
            ManagedMetering::Unsupported(MeteringCapabilityError::Classification(
                ClassificationError::NoInbounds
            ))
        ));
    }

    #[test]
    fn managed_metering_fails_closed_without_protocol_or_classification() {
        let tags = vec!["node-n1".to_string()];
        let classification = InboundClassification::subscriber_only(tags.clone()).unwrap();
        assert_eq!(
            managed_metering(true, &classification, &tags),
            ManagedMetering::Ready
        );
        assert_eq!(
            managed_metering(false, &classification, &tags),
            ManagedMetering::Unsupported(MeteringCapabilityError::UnsupportedStatsProtocol)
        );
        assert!(matches!(
            managed_metering(true, &InboundClassification::default(), &tags),
            ManagedMetering::Unsupported(MeteringCapabilityError::Classification(
                ClassificationError::MissingTag(_)
            ))
        ));
        assert!(matches!(
            managed_metering(true, &classification, &[]),
            ManagedMetering::Unsupported(MeteringCapabilityError::Classification(
                ClassificationError::NoInbounds
            ))
        ));
    }

    #[test]
    fn filter_drops_peer_probe_and_unproven_events_before_accounting() {
        let classification = InboundClassification::new([
            ("node-n1".to_string(), InboundKind::Subscriber),
            ("peer-b".to_string(), InboundKind::Peer),
            ("probe".to_string(), InboundKind::Probe),
        ])
        .unwrap();
        let filtered = classification.filter(&snapshot(vec![
            event("node-n1", "blz.1.2.5.n1sub-a"),
            event("peer-b", "link"),
            event("probe", "probe"),
            event("node-n1", "bare"),
            event("", "blz.1.2.5.n1sub-a"),
            event("unknown", "blz.1.2.5.n1sub-a"),
        ]));
        assert_eq!(filtered.message.events.len(), 1);
        assert_eq!(filtered.counts.peer_events, 1);
        assert_eq!(filtered.counts.probe_events, 1);
        assert_eq!(filtered.counts.undecodable_identities, 1);
        assert_eq!(filtered.counts.missing_inbound, 1);
        assert_eq!(filtered.counts.unknown_tags, 1);
        assert!(filtered.unproven);
    }
}
