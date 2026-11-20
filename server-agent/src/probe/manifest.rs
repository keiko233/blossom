//! Explicit local mapping for managed link probes.
//!
//! A probe request carries identifiers only: `linkId`, a credential
//! generation, server identities and managed generations. The agent must map
//! that link to a local source `peer-out-` outbound and, on the destination, to
//! the exact `peer-in-` inbound and peer user. The compiled sing-box config
//! does not encode the link identity on the sender side, so a managed snapshot
//! may carry a bounded `managed.probeBindings` manifest:
//!
//! ```json
//! {
//!   "linkId": "link-1",
//!   "credentialGeneration": 1,
//!   "sourceServerId": "srv-a",
//!   "destinationServerId": "srv-b",
//!   "sourceOutboundTag": "peer-out-pout1",
//!   "destinationInboundTag": "peer-in-pin1"
//! }
//! ```
//!
//! Either runtime tag may be omitted on the side that does not own it. When the
//! manifest is absent the resolver derives only unambiguous bindings from the
//! committed config and encoded peer identities: a destination can bind every
//! `peer-in-` user, and a source can bind its single `peer-out-` outbound. With
//! more than one sender outbound an explicit mapping is required; the agent
//! never guesses, never accepts a target from the request, and never widens the
//! route beyond the fixed agent-owned loopback responder.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use super::contract::MAX_LINK_PROBE_ID_CHARS;
use super::identity::{
    LinkCredential, PeerLinkIdentity, ProbeIdentityError, peer_inbound_credential,
    peer_inbound_identities, source_link_credential,
};
use super::isolation::{
    ProbeCandidateBindings, ProbeIngress, ProbeIsolationError, ProbeResponderRoute,
    install_probe_bindings, validate_probe_bindings,
};

/// Agent-owned source ingress. A single listener carries one authenticated user
/// per bound link so several sender links can share it without exposing another
/// listener.
pub(crate) const PROBE_INGRESS_TAG: &str = "blossom-agent-link-probe-in";
pub(crate) const PROBE_INGRESS_LISTEN: SocketAddr =
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 39090);
/// Agent-owned destination responder. The target is a local constant, never a
/// request field, and every bound link shares the one bounded HTTP responder.
pub(crate) const PROBE_RESPONDER_ENDPOINT: SocketAddr =
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 39091);
const FALLBACK_INGRESS_USER: &str = "blossom-probe-fallback";
const PROBE_INGRESS_USER_CONTEXT: &[u8] = b"blossom-link-probe.ingress-user.v1\0";
const PROBE_INGRESS_CREDENTIAL_CONTEXT: &[u8] = b"blossom-link-probe.ingress-credential.v1\0";
const PEER_OUTBOUND_TAG_PREFIX: &str = "peer-out-";
const PEER_INBOUND_TAG_PREFIX: &str = "peer-in-";

/// One explicit link-to-runtime-tag mapping in the managed snapshot extension.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManagedProbeBinding {
    pub link_id: String,
    pub credential_generation: u64,
    pub source_server_id: String,
    pub destination_server_id: String,
    #[serde(default)]
    pub source_outbound_tag: Option<String>,
    #[serde(default)]
    pub destination_inbound_tag: Option<String>,
}

impl ManagedProbeBinding {
    fn validate(&self) -> Result<(), ProbeBindingError> {
        validate_id("linkId", &self.link_id)?;
        validate_id("sourceServerId", &self.source_server_id)?;
        validate_id("destinationServerId", &self.destination_server_id)?;
        if self.credential_generation == 0 {
            return Err(ProbeBindingError::Invalid("credentialGeneration"));
        }
        if self.source_server_id == self.destination_server_id {
            return Err(ProbeBindingError::Invalid("server identities"));
        }
        if self.source_outbound_tag.is_none() && self.destination_inbound_tag.is_none() {
            return Err(ProbeBindingError::Invalid("runtime tags"));
        }
        if let Some(tag) = &self.source_outbound_tag {
            validate_id("sourceOutboundTag", tag)?;
            if !tag.starts_with(PEER_OUTBOUND_TAG_PREFIX) {
                return Err(ProbeBindingError::Invalid("sourceOutboundTag"));
            }
        }
        if let Some(tag) = &self.destination_inbound_tag {
            validate_id("destinationInboundTag", tag)?;
            if !tag.starts_with(PEER_INBOUND_TAG_PREFIX) {
                return Err(ProbeBindingError::Invalid("destinationInboundTag"));
            }
        }
        Ok(())
    }
}

/// Structural validation used by the managed snapshot decoder before the base
/// config is materialized.
pub(crate) fn validate_manifest(bindings: &[ManagedProbeBinding]) -> Result<(), ProbeBindingError> {
    let mut seen = std::collections::HashSet::new();
    for binding in bindings {
        binding.validate()?;
        if !seen.insert((binding.link_id.as_str(), binding.credential_generation)) {
            return Err(ProbeBindingError::DuplicateLink(binding.link_id.clone()));
        }
    }
    Ok(())
}

/// One resolved source binding. `link_id` is absent only for the unambiguous
/// single-outbound fallback, where the request supplies the link identity and
/// the destination responder proves the matching credential.
#[derive(Debug, Clone)]
pub(crate) struct ProbeSourceBinding {
    pub link_id: Option<String>,
    pub credential_generation: Option<u64>,
    pub source_server_id: Option<String>,
    pub destination_server_id: Option<String>,
    pub ingress: ProbeIngress,
}

/// One resolved destination binding for an exact peer identity.
#[derive(Debug, Clone)]
pub(crate) struct ProbeDestinationBinding {
    pub link_id: String,
    pub credential_generation: u64,
    pub local_server_id: Option<String>,
    pub identity: PeerLinkIdentity,
    pub peer_credential: LinkCredential,
    pub route: ProbeResponderRoute,
}

/// Local bindings derived from the committed config plus the snapshot manifest.
#[derive(Debug, Clone, Default)]
pub(crate) struct ResolvedProbeBindings {
    pub sources: Vec<ProbeSourceBinding>,
    pub destinations: Vec<ProbeDestinationBinding>,
    pub ingresses: Vec<ProbeIngress>,
    pub responders: Vec<ProbeResponderRoute>,
}

impl ResolvedProbeBindings {
    /// The exact ingress for a request, or `None` when the mapping is missing.
    #[must_use]
    pub(crate) fn source_for(
        &self,
        link_id: &str,
        credential_generation: u64,
        destination_server_id: &str,
    ) -> Option<&ProbeSourceBinding> {
        self.sources
            .iter()
            .find(|source| {
                source.link_id.as_deref() == Some(link_id)
                    && source.credential_generation == Some(credential_generation)
                    && source.destination_server_id.as_deref() == Some(destination_server_id)
            })
            .or_else(|| {
                (self.sources.len() == 1 && self.sources[0].link_id.is_none())
                    .then_some(&self.sources[0])
            })
    }

    #[must_use]
    pub(crate) fn destinations_for(
        &self,
        link_id: &str,
        credential_generation: u64,
    ) -> Vec<&ProbeDestinationBinding> {
        self.destinations
            .iter()
            .filter(|destination| {
                destination.link_id == link_id
                    && destination.credential_generation == credential_generation
            })
            .collect()
    }
}

/// Resolves local bindings without mutating the config. Used both while
/// compiling a candidate and while executing a committed probe.
pub(crate) fn resolve_bindings(
    config: &serde_json::Map<String, serde_json::Value>,
    bindings: &[ManagedProbeBinding],
) -> Result<ResolvedProbeBindings, ProbeBindingError> {
    validate_manifest(bindings)?;
    let peer_outbounds = peer_outbound_tags(config)?;
    let mut resolved = ResolvedProbeBindings::default();

    let has_explicit_sources = bindings
        .iter()
        .any(|binding| binding.source_outbound_tag.is_some());
    for binding in bindings {
        if let Some(tag) = &binding.source_outbound_tag {
            let credential = source_link_credential(config, tag)?;
            let ingress = ingress_for(binding, &credential)?;
            resolved.ingresses.push(ingress.clone());
            resolved.sources.push(ProbeSourceBinding {
                link_id: Some(binding.link_id.clone()),
                credential_generation: Some(binding.credential_generation),
                source_server_id: Some(binding.source_server_id.clone()),
                destination_server_id: Some(binding.destination_server_id.clone()),
                ingress,
            });
        }
    }
    if !has_explicit_sources && bindings.is_empty() && peer_outbounds.len() == 1 {
        let tag = &peer_outbounds[0];
        // A managed document may still carry an incomplete peer outbound that
        // sing-box itself will reject later. Only derive a binding when the
        // credential is actually present; an explicit manifest remains
        // strict and fails the whole candidate.
        if let Ok(credential) = source_link_credential(config, tag) {
            let ingress = ProbeIngress::new(
                PROBE_INGRESS_LISTEN,
                FALLBACK_INGRESS_USER,
                fallback_ingress_credential(&credential),
                tag,
                PROBE_RESPONDER_ENDPOINT,
            )?;
            resolved.ingresses.push(ingress.clone());
            resolved.sources.push(ProbeSourceBinding {
                link_id: None,
                credential_generation: None,
                source_server_id: None,
                destination_server_id: None,
                ingress,
            });
        }
    }

    let all_identities = peer_inbound_identities(config)?;
    let has_explicit_destinations = bindings
        .iter()
        .any(|binding| binding.destination_inbound_tag.is_some());
    if bindings.is_empty() {
        for (inbound_tag, identity) in &all_identities {
            if let Some(destination) =
                destination_binding(config, None, inbound_tag, identity, None)?
            {
                resolved.responders.push(destination.route.clone());
                resolved.destinations.push(destination);
            }
        }
    } else {
        for binding in bindings {
            let identity = PeerLinkIdentity::new(&binding.link_id, binding.credential_generation)
                .ok_or(ProbeBindingError::Invalid("linkId"))?;
            let tag = match &binding.destination_inbound_tag {
                Some(tag) => tag.clone(),
                None if has_explicit_destinations => continue,
                None => {
                    let matches: Vec<&String> = all_identities
                        .iter()
                        .filter(|(_, candidate)| candidate == &identity)
                        .map(|(tag, _)| tag)
                        .collect();
                    match matches.as_slice() {
                        [tag] => tag.to_string(),
                        [] => continue,
                        _ => {
                            return Err(ProbeBindingError::AmbiguousIdentity(
                                binding.link_id.clone(),
                            ));
                        }
                    }
                }
            };
            if let Some(destination) = destination_binding(
                config,
                Some(binding),
                &tag,
                &identity,
                Some(binding.destination_server_id.clone()),
            )? {
                resolved.responders.push(destination.route.clone());
                resolved.destinations.push(destination);
            }
        }
    }
    Ok(resolved)
}

/// Injects the fixed ingress/responder routes into a candidate and proves the
/// resulting isolation before the candidate can be checked by sing-box.
pub(crate) fn install_probe_config(
    config: &mut serde_json::Map<String, serde_json::Value>,
    bindings: &[ManagedProbeBinding],
    stats_endpoint: SocketAddr,
) -> Result<ResolvedProbeBindings, ProbeBindingError> {
    let resolved = resolve_bindings(config, bindings)?;
    if resolved.ingresses.is_empty() && resolved.responders.is_empty() {
        return Ok(resolved);
    }
    install_probe_bindings(
        config,
        &ProbeCandidateBindings {
            ingresses: &resolved.ingresses,
            responders: &resolved.responders,
            stats_endpoint,
        },
    )?;
    validate_probe_bindings(
        config,
        &ProbeCandidateBindings {
            ingresses: &resolved.ingresses,
            responders: &resolved.responders,
            stats_endpoint,
        },
    )?;
    Ok(resolved)
}

fn destination_binding(
    config: &serde_json::Map<String, serde_json::Value>,
    manifest: Option<&ManagedProbeBinding>,
    inbound_tag: &str,
    identity: &PeerLinkIdentity,
    local_server_id: Option<String>,
) -> Result<Option<ProbeDestinationBinding>, ProbeBindingError> {
    let credential = match peer_inbound_credential(config, inbound_tag, identity) {
        Ok(credential) => credential,
        Err(ProbeIdentityError::MissingPeerUser(_) | ProbeIdentityError::MissingCredential(_))
            if manifest.is_none() =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
    };
    let route = ProbeResponderRoute::new(inbound_tag, identity.clone(), PROBE_RESPONDER_ENDPOINT)?;
    Ok(Some(ProbeDestinationBinding {
        link_id: identity.link_id.clone(),
        credential_generation: identity.generation,
        local_server_id,
        identity: identity.clone(),
        peer_credential: credential,
        route,
    }))
}

fn ingress_for(
    binding: &ManagedProbeBinding,
    credential: &LinkCredential,
) -> Result<ProbeIngress, ProbeBindingError> {
    Ok(ProbeIngress::new(
        PROBE_INGRESS_LISTEN,
        &probe_ingress_user(&binding.link_id, binding.credential_generation),
        probe_ingress_credential(credential, &binding.link_id, binding.credential_generation),
        binding
            .source_outbound_tag
            .as_deref()
            .ok_or(ProbeBindingError::Invalid("sourceOutboundTag"))?,
        PROBE_RESPONDER_ENDPOINT,
    )?)
}

fn peer_outbound_tags(
    config: &serde_json::Map<String, serde_json::Value>,
) -> Result<Vec<String>, ProbeBindingError> {
    let outbounds = config
        .get("outbounds")
        .and_then(serde_json::Value::as_array)
        .ok_or(ProbeBindingError::Invalid("outbounds"))?;
    let mut tags = Vec::new();
    for outbound in outbounds {
        let Some(tag) = outbound.get("tag").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if tag.starts_with(PEER_OUTBOUND_TAG_PREFIX) {
            tags.push(tag.to_string());
        }
    }
    Ok(tags)
}

fn probe_ingress_user(link_id: &str, generation: u64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(PROBE_INGRESS_USER_CONTEXT);
    hasher.update(link_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(generation.to_be_bytes());
    format!("probe-{}", &hex::encode(hasher.finalize())[..24])
}

fn probe_ingress_credential(
    peer: &LinkCredential,
    link_id: &str,
    generation: u64,
) -> LinkCredential {
    let mut hasher = Sha256::new();
    hasher.update(PROBE_INGRESS_CREDENTIAL_CONTEXT);
    hasher.update(peer.expose().as_bytes());
    hasher.update(b"\0");
    hasher.update(link_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(generation.to_be_bytes());
    LinkCredential::new(hex::encode(hasher.finalize()))
        .expect("an ingress hash is a bounded non-control credential")
}

fn fallback_ingress_credential(peer: &LinkCredential) -> LinkCredential {
    let mut hasher = Sha256::new();
    hasher.update(PROBE_INGRESS_CREDENTIAL_CONTEXT);
    hasher.update(b"fallback\0");
    hasher.update(peer.expose().as_bytes());
    LinkCredential::new(hex::encode(hasher.finalize()))
        .expect("an ingress hash is a bounded non-control credential")
}

fn validate_id(field: &'static str, value: &str) -> Result<(), ProbeBindingError> {
    if value.is_empty()
        || value.encode_utf16().count() > MAX_LINK_PROBE_ID_CHARS
        || value.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(ProbeBindingError::Invalid(field));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProbeBindingError {
    Invalid(&'static str),
    DuplicateLink(String),
    AmbiguousIdentity(String),
    Identity(ProbeIdentityError),
    Isolation(ProbeIsolationError),
}

impl std::fmt::Display for ProbeBindingError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(field) => write!(formatter, "invalid probe binding {field}"),
            Self::DuplicateLink(link_id) => {
                write!(formatter, "duplicate probe binding for link {link_id}")
            }
            Self::AmbiguousIdentity(link_id) => {
                write!(
                    formatter,
                    "probe link {link_id} has no unambiguous peer inbound"
                )
            }
            Self::Identity(error) => write!(formatter, "probe identity is unavailable: {error}"),
            Self::Isolation(error) => write!(formatter, "probe isolation failed: {error}"),
        }
    }
}

impl std::error::Error for ProbeBindingError {}

impl From<ProbeIdentityError> for ProbeBindingError {
    fn from(error: ProbeIdentityError) -> Self {
        Self::Identity(error)
    }
}

impl From<ProbeIsolationError> for ProbeBindingError {
    fn from(error: ProbeIsolationError) -> Self {
        Self::Isolation(error)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Map, Value, json};

    use super::*;

    fn binding(link: &str, outbound: &str, inbound: &str) -> ManagedProbeBinding {
        ManagedProbeBinding {
            link_id: link.to_string(),
            credential_generation: 1,
            source_server_id: "srv-a".to_string(),
            destination_server_id: "srv-b".to_string(),
            source_outbound_tag: Some(outbound.to_string()),
            destination_inbound_tag: Some(inbound.to_string()),
        }
    }

    fn config() -> Map<String, Value> {
        json!({
            "log": {"level": "info", "timestamp": true},
            "dns": {"servers": [{"type": "local", "tag": "local-dns"}], "final": "local-dns"},
            "services": [{
                "type": "api",
                "listen": "127.0.0.1",
                "listen_port": 19081,
                "secret": "stats-secret"
            }],
            "inbounds": [
                {
                    "type": "trojan",
                    "tag": "peer-in-pin1",
                    "listen": "127.0.0.1",
                    "listen_port": 9443,
                    "users": [{
                        "name": PeerLinkIdentity::new("link-1", 1).unwrap().user_name(),
                        "password": "11111111-1111-1111-1111-111111111111"
                    }]
                },
                {
                    "type": "trojan",
                    "tag": "peer-in-pin2",
                    "listen": "127.0.0.1",
                    "listen_port": 9444,
                    "users": [{
                        "name": PeerLinkIdentity::new("link-2", 1).unwrap().user_name(),
                        "password": "11111111-1111-1111-1111-111111111111"
                    }]
                }
            ],
            "outbounds": [
                {"type": "direct", "tag": "direct"},
                {
                    "type": "trojan",
                    "tag": "peer-out-pout1",
                    "server": "127.0.0.1",
                    "server_port": 9443,
                    "password": "11111111-1111-1111-1111-111111111111"
                },
                {
                    "type": "trojan",
                    "tag": "peer-out-pout2",
                    "server": "127.0.0.1",
                    "server_port": 9444,
                    "password": "11111111-1111-1111-1111-111111111111"
                }
            ],
            "route": {
                "default_domain_resolver": "local-dns",
                "rules": [],
                "final": "direct"
            }
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn several_link_bindings_share_fixed_routes_without_widening_them() {
        let mut config = config();
        let bindings = vec![
            binding("link-1", "peer-out-pout1", "peer-in-pin1"),
            binding("link-2", "peer-out-pout2", "peer-in-pin2"),
        ];
        let stats = "127.0.0.1:19081".parse().unwrap();
        let resolved = install_probe_config(&mut config, &bindings, stats).unwrap();
        assert_eq!(resolved.sources.len(), 2);
        assert_eq!(resolved.destinations.len(), 2);
        assert_eq!(resolved.ingresses.len(), 2);
        assert_eq!(resolved.responders.len(), 2);
        assert_eq!(resolved.sources[0].ingress.tag, PROBE_INGRESS_TAG);
        assert_eq!(
            resolved.sources[0].ingress.listen, PROBE_INGRESS_LISTEN,
            "one fixed listener carries every source user"
        );
        let inbound = &config["inbounds"].as_array().unwrap()[2];
        assert_eq!(inbound["tag"], PROBE_INGRESS_TAG);
        assert_eq!(inbound["users"].as_array().unwrap().len(), 2);
        assert_eq!(config["route"]["rules"].as_array().unwrap().len(), 7);

        let source = resolved
            .source_for("link-2", 1, "srv-b")
            .expect("the second link maps to its own outbound");
        assert_eq!(source.ingress.outbound_tag, "peer-out-pout2");
        assert!(
            resolved.source_for("link-2", 2, "srv-b").is_none(),
            "the wrong credential generation must not fall back to another link"
        );
        assert_eq!(resolved.destinations_for("link-1", 1).len(), 1);

        let wrong = resolve_bindings(
            &config,
            &[binding("link-9", "peer-out-pout1", "peer-in-pin1")],
        );
        assert!(wrong.is_err(), "an unknown tag must fail closed");
    }

    #[test]
    fn single_link_derivation_requires_an_unambiguous_outbound() {
        let mut config = config();
        let only_one = ManagedProbeBinding {
            link_id: "link-1".to_string(),
            credential_generation: 1,
            source_server_id: "srv-a".to_string(),
            destination_server_id: "srv-b".to_string(),
            source_outbound_tag: None,
            destination_inbound_tag: Some("peer-in-pin1".to_string()),
        };
        let resolved = resolve_bindings(&config, &[only_one]).unwrap();
        assert!(resolved.sources.is_empty());
        assert_eq!(resolved.destinations.len(), 1);

        let empty = resolve_bindings(&config, &[]).unwrap();
        assert!(
            empty.sources.is_empty(),
            "two sender outbounds are ambiguous"
        );
        assert_eq!(
            empty.destinations.len(),
            2,
            "destination identities are derived from the committed config"
        );
        assert!(install_probe_config(&mut config, &[], "127.0.0.1:19081".parse().unwrap()).is_ok());
    }

    #[test]
    fn pinned_sing_box_accepts_the_multi_link_probe_candidate() {
        let Ok(bin) = std::env::var("SING_BOX_BIN") else {
            return;
        };
        let mut config = config();
        let bindings = vec![
            binding("link-1", "peer-out-pout1", "peer-in-pin1"),
            binding("link-2", "peer-out-pout2", "peer-in-pin2"),
        ];
        install_probe_config(&mut config, &bindings, "127.0.0.1:19081".parse().unwrap()).unwrap();
        let path = std::env::temp_dir().join(format!(
            "blossom-probe-manifest-check-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, serde_json::to_vec_pretty(&config).unwrap()).unwrap();
        let output = std::process::Command::new(&bin)
            .arg("check")
            .arg("-c")
            .arg(&path)
            .output()
            .expect("pinned sing-box runs");
        let _ = std::fs::remove_file(&path);
        assert!(
            output.status.success(),
            "pinned sing-box rejected the multi-link probe candidate:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn malformed_or_duplicate_manifests_are_refused_before_mutation() {
        let mut config = config();
        let duplicate = [
            binding("link-1", "peer-out-pout1", "peer-in-pin1"),
            binding("link-1", "peer-out-pout2", "peer-in-pin2"),
        ];
        assert!(matches!(
            install_probe_config(&mut config, &duplicate, "127.0.0.1:19081".parse().unwrap()),
            Err(ProbeBindingError::DuplicateLink(link)) if link == "link-1"
        ));
        let mut missing = binding("link-1", "peer-out-pout1", "peer-in-pin1");
        missing.source_outbound_tag = None;
        missing.destination_inbound_tag = None;
        assert!(matches!(
            install_probe_config(&mut config, &[missing], "127.0.0.1:19081".parse().unwrap()),
            Err(ProbeBindingError::Invalid("runtime tags"))
        ));
        assert!(config["inbounds"].as_array().unwrap().len() == 2);
    }
}
