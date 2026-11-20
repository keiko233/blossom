//! Peer-link identities, local credential extraction and probe authentication.
//!
//! Peer inbounds authenticate link identities independently from subscriber
//! users. The codec matches `packages/domain/src/link-identity.ts` at
//! `e52ff41`; the single-use probe token is an HMAC over the bounded request
//! using the link's current credential generation. Both ends already hold
//! that credential in their committed config, so no subscriber credential,
//! control-plane path, or arbitrary CA material participates in the probe.

use std::collections::HashSet;
use std::fmt;

use ring::hmac;
use serde_json::{Map, Value};
use zeroize::Zeroize as _;

use super::contract::{LinkProbeRequest, MAX_LINK_PROBE_ID_CHARS, ProbeResponseUnsigned};

pub(crate) const PEER_LINK_IDENTITY_PREFIX: &str = "blz.peer.1.";

const PROBE_REQUEST_TOKEN_CONTEXT: &[u8] = b"blossom-link-probe.request.v1\0";
const PROBE_RESPONSE_TOKEN_CONTEXT: &[u8] = b"blossom-link-probe.response.v1\0";
const PEER_OUTBOUND_TAG_PREFIX: &str = "peer-out-";
const PEER_INBOUND_TAG_PREFIX: &str = "peer-in-";

/// A link identity encoded into a peer inbound user name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PeerLinkIdentity {
    pub(crate) link_id: String,
    pub(crate) generation: u64,
}

impl PeerLinkIdentity {
    pub(crate) fn new(link_id: &str, generation: u64) -> Option<Self> {
        if link_id.is_empty()
            || link_id.len() > MAX_LINK_PROBE_ID_CHARS
            || generation == 0
            || link_id.bytes().any(|byte| byte.is_ascii_control())
        {
            return None;
        }
        Some(Self {
            link_id: link_id.to_string(),
            generation,
        })
    }

    /// Exact user-name encoding. Lengths count UTF-16 code units to match the
    /// JavaScript control plane, while generation digits stay ASCII.
    #[must_use]
    pub(crate) fn user_name(&self) -> String {
        let link_units = self.link_id.encode_utf16().count();
        let generation = self.generation.to_string();
        format!(
            "{PEER_LINK_IDENTITY_PREFIX}{link_units}.{}.{}{generation}",
            generation.len(),
            self.link_id
        )
    }

    pub(crate) fn decode(value: &str) -> Option<Self> {
        let rest = value.strip_prefix(PEER_LINK_IDENTITY_PREFIX)?;
        let first_dot = rest.find('.')?;
        let second_dot = rest[first_dot + 1..]
            .find('.')
            .map(|at| first_dot + 1 + at)?;
        if first_dot == 0 || second_dot <= first_dot + 1 {
            return None;
        }
        let link_length = decimal(&rest[..first_dot])?;
        let generation_length = decimal(&rest[first_dot + 1..second_dot])?;
        let payload = &rest[second_dot + 1..];
        let units: Vec<u16> = payload.encode_utf16().collect();
        if units.len() != link_length + generation_length {
            return None;
        }
        let link_id = String::from_utf16(&units[..link_length]).ok()?;
        let generation = String::from_utf16(&units[link_length..]).ok()?;
        if link_id.is_empty()
            || generation.is_empty()
            || !generation.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        let generation = generation.parse::<u64>().ok().filter(|value| *value > 0)?;
        Self::new(&link_id, generation)
    }
}

fn decimal(value: &str) -> Option<usize> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse::<usize>().ok().filter(|value| *value > 0)
}

/// One peer credential with a redacting `Debug` and best-effort zeroization.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct LinkCredential(String);

impl LinkCredential {
    pub(crate) fn new(value: impl Into<String>) -> Option<Self> {
        let value = value.into();
        if value.is_empty() || value.bytes().any(|byte| byte.is_ascii_control()) {
            return None;
        }
        Some(Self(value))
    }

    #[must_use]
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for LinkCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted>")
    }
}

impl Drop for LinkCredential {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl zeroize::ZeroizeOnDrop for LinkCredential {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProbeIdentityError {
    MissingOutbound(String),
    MissingInbound(String),
    DuplicateInbound(String),
    UnsupportedProtocol(String),
    MissingCredential(String),
    MissingPeerUser(String),
    AmbiguousPeerUser(String),
    MalformedUsers(String),
}

impl std::fmt::Display for ProbeIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingOutbound(tag) => {
                write!(formatter, "probe outbound {tag} is missing")
            }
            Self::MissingInbound(tag) => write!(formatter, "probe peer inbound {tag} is missing"),
            Self::DuplicateInbound(tag) => {
                write!(formatter, "probe peer inbound {tag} is duplicated")
            }
            Self::UnsupportedProtocol(what) => {
                write!(formatter, "probe peer {what} uses an unsupported protocol")
            }
            Self::MissingCredential(what) => {
                write!(formatter, "probe peer {what} has no link credential")
            }
            Self::MissingPeerUser(what) => {
                write!(formatter, "probe peer {what} has no matching link identity")
            }
            Self::AmbiguousPeerUser(what) => {
                write!(
                    formatter,
                    "probe peer {what} has an ambiguous link identity"
                )
            }
            Self::MalformedUsers(what) => {
                write!(formatter, "probe peer {what} has malformed users")
            }
        }
    }
}

impl std::error::Error for ProbeIdentityError {}

/// Extracts the source outbound credential. The outbound tag is already chosen
/// by the local stage binding; the control-plane payload never supplies one.
pub(crate) fn source_link_credential(
    config: &Map<String, Value>,
    outbound_tag: &str,
) -> Result<LinkCredential, ProbeIdentityError> {
    if !outbound_tag.starts_with(PEER_OUTBOUND_TAG_PREFIX)
        || outbound_tag.len() > MAX_LINK_PROBE_ID_CHARS
    {
        return Err(ProbeIdentityError::MissingOutbound(
            outbound_tag.to_string(),
        ));
    }
    let outbound = object_with_tag(config, "outbounds", outbound_tag)?
        .ok_or_else(|| ProbeIdentityError::MissingOutbound(outbound_tag.to_string()))?;
    let protocol = protocol(outbound)?;
    credential_from_object(outbound, protocol)
        .ok_or_else(|| ProbeIdentityError::MissingCredential(outbound_tag.to_string()))
}

/// Extracts the destination credential for the exact peer identity on the
/// exact `peer-in-` inbound. A duplicate user name fails closed.
pub(crate) fn peer_inbound_credential(
    config: &Map<String, Value>,
    inbound_tag: &str,
    identity: &PeerLinkIdentity,
) -> Result<LinkCredential, ProbeIdentityError> {
    if !inbound_tag.starts_with(PEER_INBOUND_TAG_PREFIX)
        || inbound_tag.len() > MAX_LINK_PROBE_ID_CHARS
    {
        return Err(ProbeIdentityError::MissingInbound(inbound_tag.to_string()));
    }
    let inbound = object_with_tag(config, "inbounds", inbound_tag)?
        .ok_or_else(|| ProbeIdentityError::MissingInbound(inbound_tag.to_string()))?;
    let protocol = protocol(inbound)?;
    let users = inbound
        .get("users")
        .and_then(Value::as_array)
        .ok_or_else(|| ProbeIdentityError::MalformedUsers(inbound_tag.to_string()))?;
    let expected = identity.user_name();
    let mut found = None;
    for user in users {
        let Some(user) = user.as_object() else {
            return Err(ProbeIdentityError::MalformedUsers(inbound_tag.to_string()));
        };
        if user.get("name").and_then(Value::as_str) != Some(expected.as_str()) {
            continue;
        }
        let credential = credential_from_object(user, protocol)
            .ok_or_else(|| ProbeIdentityError::MissingCredential(expected.clone()))?;
        if found.is_some() {
            return Err(ProbeIdentityError::AmbiguousPeerUser(
                inbound_tag.to_string(),
            ));
        }
        found = Some(credential);
    }
    found.ok_or_else(|| ProbeIdentityError::MissingPeerUser(inbound_tag.to_string()))
}

/// Every peer identity admitted by every `peer-in-` inbound. Used by the
/// candidate validator to prove probes cannot widen beyond peer principals.
pub(crate) fn peer_inbound_identities(
    config: &Map<String, Value>,
) -> Result<Vec<(String, PeerLinkIdentity)>, ProbeIdentityError> {
    let inbounds = config
        .get("inbounds")
        .and_then(Value::as_array)
        .ok_or_else(|| ProbeIdentityError::MalformedUsers("inbounds".to_string()))?;
    let mut seen_tags = HashSet::new();
    let mut identities = Vec::new();
    for inbound in inbounds {
        let Some(object) = inbound.as_object() else {
            continue;
        };
        let Some(tag) = object.get("tag").and_then(Value::as_str) else {
            continue;
        };
        if !tag.starts_with(PEER_INBOUND_TAG_PREFIX) {
            continue;
        }
        if !seen_tags.insert(tag.to_string()) {
            return Err(ProbeIdentityError::DuplicateInbound(tag.to_string()));
        }
        let users = object
            .get("users")
            .and_then(Value::as_array)
            .ok_or_else(|| ProbeIdentityError::MalformedUsers(tag.to_string()))?;
        for user in users {
            let Some(user) = user.as_object() else {
                return Err(ProbeIdentityError::MalformedUsers(tag.to_string()));
            };
            let Some(name) = user.get("name").and_then(Value::as_str) else {
                continue;
            };
            let Some(identity) = PeerLinkIdentity::decode(name) else {
                continue;
            };
            identities.push((tag.to_string(), identity));
        }
    }
    Ok(identities)
}

pub(crate) fn request_token(request: &LinkProbeRequest, credential: &LinkCredential) -> String {
    let message = request_message(request);
    let key = hmac::Key::new(hmac::HMAC_SHA256, credential.expose().as_bytes());
    hex::encode(hmac::sign(&key, &message).as_ref())
}

pub(crate) fn verify_request_token(
    request: &LinkProbeRequest,
    credential: &LinkCredential,
    token: &str,
) -> bool {
    verify_token(credential, &request_message(request), token)
}

pub(crate) fn response_token(
    request: &LinkProbeRequest,
    response: &ProbeResponseUnsigned<'_>,
    credential: &LinkCredential,
) -> String {
    let message = response_message(request, response);
    let key = hmac::Key::new(hmac::HMAC_SHA256, credential.expose().as_bytes());
    hex::encode(hmac::sign(&key, &message).as_ref())
}

pub(crate) fn verify_response_token(
    request: &LinkProbeRequest,
    response: &ProbeResponseUnsigned<'_>,
    credential: &LinkCredential,
    token: &str,
) -> bool {
    verify_token(credential, &response_message(request, response), token)
}

fn verify_token(credential: &LinkCredential, message: &[u8], token: &str) -> bool {
    if token.len() != 64 {
        return false;
    }
    let Ok(tag) = hex::decode(token) else {
        return false;
    };
    let key = hmac::Key::new(hmac::HMAC_SHA256, credential.expose().as_bytes());
    hmac::verify(&key, message, &tag).is_ok()
}

fn request_message(request: &LinkProbeRequest) -> Vec<u8> {
    let body = serde_json::to_vec(request).expect("probe request serializes");
    framed(PROBE_REQUEST_TOKEN_CONTEXT, &body)
}

fn response_message(request: &LinkProbeRequest, response: &ProbeResponseUnsigned<'_>) -> Vec<u8> {
    let request = serde_json::to_vec(request).expect("probe request serializes");
    let response = serde_json::to_vec(response).expect("probe response serializes");
    framed(
        PROBE_RESPONSE_TOKEN_CONTEXT,
        &[request.as_slice(), b"\0", response.as_slice()].concat(),
    )
}

fn framed(context: &[u8], body: &[u8]) -> Vec<u8> {
    let mut message = Vec::with_capacity(context.len() + body.len());
    message.extend_from_slice(context);
    message.extend_from_slice(body);
    message
}

fn object_with_tag<'a>(
    config: &'a Map<String, Value>,
    array: &str,
    tag: &str,
) -> Result<Option<&'a Map<String, Value>>, ProbeIdentityError> {
    let values = config
        .get(array)
        .and_then(Value::as_array)
        .ok_or_else(|| ProbeIdentityError::MalformedUsers(array.to_string()))?;
    let mut found = None;
    for value in values {
        if value.get("tag").and_then(Value::as_str) == Some(tag) {
            if found.is_some() {
                return Err(ProbeIdentityError::DuplicateInbound(tag.to_string()));
            }
            found = value.as_object();
        }
    }
    Ok(found)
}

fn protocol(object: &Map<String, Value>) -> Result<&str, ProbeIdentityError> {
    let protocol = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| ProbeIdentityError::UnsupportedProtocol("endpoint".to_string()))?;
    if matches!(protocol, "trojan" | "vless") {
        Ok(protocol)
    } else {
        Err(ProbeIdentityError::UnsupportedProtocol(
            protocol.to_string(),
        ))
    }
}

fn credential_from_object(object: &Map<String, Value>, protocol: &str) -> Option<LinkCredential> {
    let field = match protocol {
        "trojan" => "password",
        "vless" => "uuid",
        _ => return None,
    };
    object
        .get(field)
        .and_then(Value::as_str)
        .and_then(LinkCredential::new)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::probe::contract::{
        LinkProbeEndpoint, LinkProbeOutcome, ManagedApplied, ManagedGeneration,
    };

    fn identity() -> PeerLinkIdentity {
        PeerLinkIdentity::new("link-1", 1).unwrap()
    }

    fn request() -> LinkProbeRequest {
        let endpoint = |server: &str, hex: &str| LinkProbeEndpoint {
            server_id: server.to_string(),
            managed_fingerprint: format!("sha256:{hex}"),
            min_revision_seq: 1,
        };
        LinkProbeRequest {
            probe_id: "probe-1".to_string(),
            rollout_id: "rollout-1".to_string(),
            stage_ordinal: 2,
            link_id: "link-1".to_string(),
            credential_generation: 1,
            source: endpoint("srv-a", &"a".repeat(64)),
            destination: endpoint("srv-b", &"b".repeat(64)),
            issued_at: "2026-11-20T00:00:00Z".parse().unwrap(),
            expires_at: "2026-11-20T00:01:00Z".parse().unwrap(),
        }
    }

    fn approved_config() -> Map<String, Value> {
        json!({
            "inbounds": [{
                "type": "trojan",
                "tag": "peer-in-pin1",
                "listen": "127.0.0.1",
                "listen_port": 9443,
                "users": [{
                    "name": identity().user_name(),
                    "password": "peer-credential"
                }],
                "tls": {"enabled": true, "server_name": "peer-b.internal.example.com"}
            }],
            "outbounds": [{
                "type": "trojan",
                "tag": "peer-out-pout1",
                "server": "127.0.0.1",
                "server_port": 9443,
                "password": "peer-credential",
                "tls": {"enabled": true, "server_name": "peer-b.internal.example.com"}
            }]
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn peer_identity_codec_matches_the_shared_encoding() {
        let identity = identity();
        assert_eq!(identity.user_name(), "blz.peer.1.6.1.link-11");
        assert_eq!(
            PeerLinkIdentity::decode("blz.peer.1.6.1.link-11"),
            Some(identity)
        );
        assert_eq!(PeerLinkIdentity::decode("blz.peer.1.6.0.link-10"), None);
        assert_eq!(PeerLinkIdentity::decode("blz.peer.1.6.1.link-1"), None);
        assert_eq!(PeerLinkIdentity::decode("blz.1.6.1.link-11"), None);
        assert_eq!(PeerLinkIdentity::decode("blz.peer.1.0.1.x1"), None);
    }

    #[test]
    fn credentials_come_only_from_the_exact_committed_tags() {
        let config = approved_config();
        let source = source_link_credential(&config, "peer-out-pout1").unwrap();
        let destination = peer_inbound_credential(&config, "peer-in-pin1", &identity()).unwrap();
        assert_eq!(source, destination);
        assert_eq!(source.expose(), "peer-credential");
        assert!(!format!("{source:?}").contains("peer-credential"));

        assert!(source_link_credential(&config, "direct").is_err());
        assert!(peer_inbound_credential(&config, "node-n1", &identity()).is_err());
        assert!(
            peer_inbound_credential(
                &config,
                "peer-in-pin1",
                &PeerLinkIdentity::new("link-1", 2).unwrap()
            )
            .is_err()
        );
        assert_eq!(
            peer_inbound_identities(&config).unwrap(),
            vec![("peer-in-pin1".to_string(), identity())]
        );
    }

    #[test]
    fn duplicate_peer_users_fail_closed() {
        let mut config = approved_config();
        let users = config["inbounds"][0]["users"].as_array_mut().unwrap();
        let mut duplicate = users[0].clone();
        duplicate["password"] = Value::String("other-credential".to_string());
        users.push(duplicate);
        assert_eq!(
            peer_inbound_credential(&config, "peer-in-pin1", &identity()).unwrap_err(),
            ProbeIdentityError::AmbiguousPeerUser("peer-in-pin1".to_string())
        );
    }

    #[test]
    fn probe_tokens_bind_every_correlation_field_and_the_response() {
        let config = approved_config();
        let credential = source_link_credential(&config, "peer-out-pout1").unwrap();
        let request = request();
        let token = request_token(&request, &credential);
        assert!(verify_request_token(&request, &credential, &token));

        let mut tampered = request.clone();
        tampered.stage_ordinal = 3;
        assert!(!verify_request_token(&tampered, &credential, &token));

        let destination = ManagedApplied {
            desired_revision_seq: 21,
            managed_fingerprint: Some(format!("sha256:{}", "b".repeat(64))),
        };
        let response = ProbeResponseUnsigned {
            probe_id: &request.probe_id,
            outcome: LinkProbeOutcome::Succeeded,
            destination: &destination,
        };
        let response_token = response_token(&request, &response, &credential);
        assert!(verify_response_token(
            &request,
            &response,
            &credential,
            &response_token
        ));

        let mut tampered_destination = destination.clone();
        tampered_destination.desired_revision_seq += 1;
        let tampered_response = ProbeResponseUnsigned {
            probe_id: &request.probe_id,
            outcome: LinkProbeOutcome::Succeeded,
            destination: &tampered_destination,
        };
        assert!(!verify_response_token(
            &request,
            &tampered_response,
            &credential,
            &response_token
        ));
        assert!(!verify_request_token(
            &request,
            &LinkCredential::new("different-credential").unwrap(),
            &token
        ));
        let _ = ManagedGeneration {
            desired_revision_seq: 5,
            managed_fingerprint: None,
        };
    }
}
