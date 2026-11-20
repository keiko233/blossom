//! Local candidate isolation for managed link probes (Task 08).
//!
//! A probe path is only trustworthy when the compiled candidate proves all of
//! the following, without relying on the control plane:
//!
//! - the agent-owned ingress is exactly one HTTP listener on loopback with
//!   local authentication and a route scoped only to the planned peer
//!   outbound and the fixed destination responder endpoint;
//! - the agent-owned responder endpoint is reachable only from the exact peer
//!   link identity on the exact peer inbound, and that exception appears
//!   before the data-plane loopback reject;
//! - every other inbox resolves destinations and rejects the complete IPv4/IPv6
//!   loopback ranges before any route or the final outbound is reachable, so
//!   neither the sing-box stats service nor other agent-owned interfaces can
//!   be reached directly or through a resolved hostname;
//! - the stats service is the single agent-injected loopback API endpoint, not
//!   a control-plane or experimental endpoint.
//!
//! The builder below produces that shape for tests and the future integration.
//! It is intentionally not called by the production apply path yet: the
//! compiler does not emit agent-owned probe objects, and the authenticated v2
//! transport is still the integration pass's scope.

use std::collections::HashSet;
use std::net::{IpAddr, SocketAddr};

use serde_json::{Map, Value, json};

use super::contract::MAX_LINK_PROBE_ID_CHARS;
use super::identity::{
    LinkCredential, PeerLinkIdentity, ProbeIdentityError, peer_inbound_credential,
    source_link_credential,
};

pub(crate) const PROBE_INGRESS_TAG: &str = "blossom-agent-link-probe-in";
pub(crate) const LOOPBACK_V4_CIDR: &str = "127.0.0.0/8";
pub(crate) const LOOPBACK_V6_CIDR: &str = "::1/128";
const MAPPED_LOOPBACK_V4_CIDR: &str = "::ffff:127.0.0.0/104";
const UNSPECIFIED_V4_CIDR: &str = "0.0.0.0/8";
const UNSPECIFIED_V6_CIDR: &str = "::/128";
const DATA_PLANE_BLOCK_CIDRS: [&str; 5] = [
    LOOPBACK_V4_CIDR,
    LOOPBACK_V6_CIDR,
    MAPPED_LOOPBACK_V4_CIDR,
    UNSPECIFIED_V4_CIDR,
    UNSPECIFIED_V6_CIDR,
];
const PEER_OUTBOUND_TAG_PREFIX: &str = "peer-out-";
const PEER_INBOUND_TAG_PREFIX: &str = "peer-in-";
const AGENT_OWNED_TAG_PREFIX: &str = "blossom-agent-";
const DIRECT_OUTBOUND_TAG: &str = "direct";

/// One fixed, authenticated agent-owned loopback ingress.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProbeIngress {
    pub(crate) tag: String,
    pub(crate) listen: SocketAddr,
    pub(crate) auth_user: String,
    pub(crate) auth_credential: LinkCredential,
    pub(crate) outbound_tag: String,
    pub(crate) responder_endpoint: SocketAddr,
}

impl ProbeIngress {
    pub(crate) fn new(
        listen: SocketAddr,
        auth_user: &str,
        auth_credential: LinkCredential,
        outbound_tag: &str,
        responder_endpoint: SocketAddr,
    ) -> Result<Self, ProbeIsolationError> {
        if !listen.ip().is_loopback() || !responder_endpoint.ip().is_loopback() {
            return Err(ProbeIsolationError::InvalidPlan(
                "probe ingress and responder must be loopback",
            ));
        }
        if listen.port() == 0 || responder_endpoint.port() == 0 || listen == responder_endpoint {
            return Err(ProbeIsolationError::InvalidPlan(
                "probe ingress and responder endpoints must be distinct",
            ));
        }
        if !valid_name(auth_user)
            || !outbound_tag.starts_with(PEER_OUTBOUND_TAG_PREFIX)
            || outbound_tag.len() > MAX_LINK_PROBE_ID_CHARS
        {
            return Err(ProbeIsolationError::InvalidPlan(
                "probe ingress names or outbound tag are invalid",
            ));
        }
        Ok(Self {
            tag: PROBE_INGRESS_TAG.to_string(),
            listen,
            auth_user: auth_user.to_string(),
            auth_credential,
            outbound_tag: outbound_tag.to_string(),
            responder_endpoint,
        })
    }
}

/// The destination-side route exception for one exact peer principal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProbeResponderRoute {
    pub(crate) peer_inbound_tag: String,
    pub(crate) peer_identity: PeerLinkIdentity,
    pub(crate) responder_endpoint: SocketAddr,
}

impl ProbeResponderRoute {
    pub(crate) fn new(
        peer_inbound_tag: &str,
        peer_identity: PeerLinkIdentity,
        responder_endpoint: SocketAddr,
    ) -> Result<Self, ProbeIsolationError> {
        if !responder_endpoint.ip().is_loopback() || responder_endpoint.port() == 0 {
            return Err(ProbeIsolationError::InvalidPlan(
                "probe responder must be loopback with a nonzero port",
            ));
        }
        if !peer_inbound_tag.starts_with(PEER_INBOUND_TAG_PREFIX)
            || peer_inbound_tag.len() > MAX_LINK_PROBE_ID_CHARS
        {
            return Err(ProbeIsolationError::InvalidPlan(
                "probe responder peer inbound tag is invalid",
            ));
        }
        Ok(Self {
            peer_inbound_tag: peer_inbound_tag.to_string(),
            peer_identity,
            responder_endpoint,
        })
    }
}

/// What a candidate must prove. `ingress` is absent on a destination-only
/// agent; `responder` is absent on a source-only agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProbeIsolationExpectation {
    pub(crate) ingress: Option<ProbeIngress>,
    pub(crate) responder: Option<ProbeResponderRoute>,
    pub(crate) stats_endpoint: SocketAddr,
}

impl ProbeIsolationExpectation {
    pub(crate) fn new(
        ingress: Option<ProbeIngress>,
        responder: Option<ProbeResponderRoute>,
        stats_endpoint: SocketAddr,
    ) -> Result<Self, ProbeIsolationError> {
        if !stats_endpoint.ip().is_loopback() || stats_endpoint.port() == 0 {
            return Err(ProbeIsolationError::InvalidPlan(
                "stats endpoint must be loopback with a nonzero port",
            ));
        }
        if let (Some(ingress), Some(responder)) = (&ingress, &responder)
            && ingress.responder_endpoint != responder.responder_endpoint
        {
            return Err(ProbeIsolationError::InvalidPlan(
                "probe ingress and responder routes name different endpoints",
            ));
        }
        Ok(Self {
            ingress,
            responder,
            stats_endpoint,
        })
    }

    pub(crate) fn require_ingress(&self) -> Result<&ProbeIngress, ProbeIsolationError> {
        self.ingress
            .as_ref()
            .ok_or(ProbeIsolationError::MissingIngress)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProbeIsolationError {
    InvalidPlan(&'static str),
    MissingIngress,
    DuplicateIngress,
    IngressShape,
    IngressAuth,
    MissingStatsService,
    StatsServiceMismatch,
    StatsEndpointNotLoopback,
    UnsupportedInboundTag(String),
    MissingProbeAllow,
    UnsafeProbeAllow,
    MissingProbeReject,
    StatsEndpointOverlap,
    ResponderEndpointOverlap,
    Identity(ProbeIdentityError),
    MissingPeerInbound(String),
    MissingResponderAllow,
    UnsafeResponderAllow,
    UnresolvedDataPlane(String),
    UnblockedLoopback(String),
    UnsafeDataPlaneAction(String),
    MissingDirectOutbound,
    MissingRouteRules,
}

impl std::fmt::Display for ProbeIsolationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPlan(reason) => write!(formatter, "invalid probe plan: {reason}"),
            Self::MissingIngress => formatter.write_str("probe ingress is missing"),
            Self::DuplicateIngress => formatter.write_str("probe ingress tag is duplicated"),
            Self::IngressShape => formatter.write_str("probe ingress shape is not loopback HTTP"),
            Self::IngressAuth => formatter.write_str("probe ingress authentication does not match"),
            Self::MissingStatsService => formatter.write_str("agent stats service is missing"),
            Self::StatsServiceMismatch => {
                formatter.write_str("agent stats service does not match its endpoint")
            }
            Self::StatsEndpointNotLoopback => {
                formatter.write_str("agent stats endpoint is not loopback")
            }
            Self::UnsupportedInboundTag(tag) => {
                write!(formatter, "inbound {tag} is outside the managed namespaces")
            }
            Self::MissingProbeAllow => formatter.write_str("probe ingress has no exact allow rule"),
            Self::UnsafeProbeAllow => formatter.write_str("probe ingress allow rule is too broad"),
            Self::MissingProbeReject => formatter.write_str("probe ingress has no terminal reject"),
            Self::StatsEndpointOverlap => {
                formatter.write_str("probe endpoints overlap the agent stats endpoint")
            }
            Self::ResponderEndpointOverlap => {
                formatter.write_str("probe ingress and responder endpoints overlap")
            }
            Self::Identity(error) => write!(formatter, "peer identity is unavailable: {error}"),
            Self::MissingPeerInbound(tag) => {
                write!(formatter, "responder peer inbound {tag} is missing")
            }
            Self::MissingResponderAllow => {
                formatter.write_str("responder has no exact peer-principal allow rule")
            }
            Self::UnsafeResponderAllow => {
                formatter.write_str("responder allow rule is not scoped to the exact peer")
            }
            Self::UnresolvedDataPlane(tag) => {
                write!(
                    formatter,
                    "data-plane inbound {tag} does not resolve destinations first"
                )
            }
            Self::UnblockedLoopback(tag) => {
                write!(formatter, "data-plane inbound {tag} can reach loopback")
            }
            Self::UnsafeDataPlaneAction(tag) => {
                write!(
                    formatter,
                    "data-plane inbound {tag} has an unprovable action"
                )
            }
            Self::MissingDirectOutbound => {
                formatter.write_str("probe responder requires the built-in direct outbound")
            }
            Self::MissingRouteRules => formatter.write_str("candidate has no route rules array"),
        }
    }
}

impl std::error::Error for ProbeIsolationError {}

impl From<ProbeIdentityError> for ProbeIsolationError {
    fn from(error: ProbeIdentityError) -> Self {
        Self::Identity(error)
    }
}

/// The exact shape the future integration may install. `stats_endpoint` is the
/// endpoint already chosen by `ConfigManager`; it is never accepted from the
/// control plane or from a probe request.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ProbeCandidatePlan<'a> {
    pub(crate) ingress: Option<&'a ProbeIngress>,
    pub(crate) responder: Option<&'a ProbeResponderRoute>,
    pub(crate) stats_endpoint: SocketAddr,
}

/// Produces the candidate shape the validator accepts. Production activation
/// remains disabled; unit tests and the integration pass call this directly.
pub(crate) fn install_probe_candidate(
    config: &mut Map<String, Value>,
    plan: ProbeCandidatePlan<'_>,
) -> Result<(), ProbeIsolationError> {
    let data_plane = data_plane_tags(config, plan.ingress.map(|_| PROBE_INGRESS_TAG))?;
    if let Some(ingress) = plan.ingress {
        if ingress.listen == plan.stats_endpoint
            || ingress.responder_endpoint == plan.stats_endpoint
        {
            return Err(ProbeIsolationError::StatsEndpointOverlap);
        }
        if ingress.listen == ingress.responder_endpoint {
            return Err(ProbeIsolationError::ResponderEndpointOverlap);
        }
        let inbounds = config
            .get("inbounds")
            .and_then(Value::as_array)
            .ok_or(ProbeIsolationError::MissingIngress)?;
        if inbounds
            .iter()
            .any(|inbound| inbound.get("tag").and_then(Value::as_str) == Some(ingress.tag.as_str()))
        {
            return Err(ProbeIsolationError::DuplicateIngress);
        }
    }
    if let Some(responder) = plan.responder
        && responder.responder_endpoint == plan.stats_endpoint
    {
        return Err(ProbeIsolationError::StatsEndpointOverlap);
    }
    if plan.responder.is_some() && !has_direct_outbound(config) {
        return Err(ProbeIsolationError::MissingDirectOutbound);
    }
    if let Some(ingress) = plan.ingress {
        let inbounds = config
            .get_mut("inbounds")
            .and_then(Value::as_array_mut)
            .ok_or(ProbeIsolationError::MissingIngress)?;
        inbounds.push(json!({
            "type": "http",
            "tag": ingress.tag,
            "listen": ingress.listen.ip().to_string(),
            "listen_port": ingress.listen.port(),
            "users": [{
                "username": ingress.auth_user,
                "password": ingress.auth_credential.expose()
            }]
        }));
    }
    let mut prelude = Vec::new();
    if let Some(ingress) = plan.ingress {
        prelude.push(probe_allow_rule(ingress));
        prelude.push(json!({
            "inbound": [ingress.tag],
            "action": "reject"
        }));
    }
    if !data_plane.is_empty() {
        prelude.push(json!({
            "inbound": data_plane,
            "action": "resolve",
            "strategy": "prefer_ipv4"
        }));
        if let Some(responder) = plan.responder {
            prelude.push(responder_allow_rule(responder));
        }
        prelude.push(json!({
            "inbound": data_plane,
            "ip_cidr": DATA_PLANE_BLOCK_CIDRS,
            "action": "reject"
        }));
    }
    let route = config
        .get_mut("route")
        .and_then(Value::as_object_mut)
        .ok_or(ProbeIsolationError::MissingRouteRules)?;
    let rules = route
        .entry("rules")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or(ProbeIsolationError::MissingRouteRules)?;
    let mut combined = prelude;
    combined.append(rules);
    *rules = combined;
    Ok(())
}

fn probe_allow_rule(ingress: &ProbeIngress) -> Value {
    json!({
        "inbound": [ingress.tag],
        "ip_cidr": [single_cidr(ingress.responder_endpoint.ip())],
        "port": [ingress.responder_endpoint.port()],
        "network": ["tcp"],
        "action": "route",
        "outbound": ingress.outbound_tag
    })
}

fn responder_allow_rule(responder: &ProbeResponderRoute) -> Value {
    json!({
        "inbound": [responder.peer_inbound_tag],
        "auth_user": [responder.peer_identity.user_name()],
        "ip_cidr": [single_cidr(responder.responder_endpoint.ip())],
        "port": [responder.responder_endpoint.port()],
        "network": ["tcp"],
        "action": "route",
        "outbound": DIRECT_OUTBOUND_TAG
    })
}

/// Proves the compiled candidate enforces the Task 08 probe trust boundary.
pub(crate) fn validate_candidate(
    config: &Map<String, Value>,
    expected: &ProbeIsolationExpectation,
) -> Result<(), ProbeIsolationError> {
    if !expected.stats_endpoint.ip().is_loopback() {
        return Err(ProbeIsolationError::StatsEndpointNotLoopback);
    }
    validate_stats_service(config, expected)?;
    let stats = expected.stats_endpoint;
    let data_plane = data_plane_tags(config, expected.ingress.as_ref().map(|i| i.tag.as_str()))?;

    if let Some(ingress) = &expected.ingress {
        if ingress.responder_endpoint == stats || ingress.listen == stats {
            return Err(ProbeIsolationError::StatsEndpointOverlap);
        }
        if ingress.listen == ingress.responder_endpoint {
            return Err(ProbeIsolationError::ResponderEndpointOverlap);
        }
        validate_ingress(config, ingress)?;
        source_link_credential(config, &ingress.outbound_tag)?;
        validate_probe_rules(config, ingress)?;
    }
    if let Some(responder) = &expected.responder {
        if responder.responder_endpoint == stats {
            return Err(ProbeIsolationError::StatsEndpointOverlap);
        }
        if !data_plane
            .iter()
            .any(|tag| tag == &responder.peer_inbound_tag)
        {
            return Err(ProbeIsolationError::MissingPeerInbound(
                responder.peer_inbound_tag.clone(),
            ));
        }
        peer_inbound_credential(
            config,
            &responder.peer_inbound_tag,
            &responder.peer_identity,
        )?;
        if !has_direct_outbound(config) {
            return Err(ProbeIsolationError::MissingDirectOutbound);
        }
    }

    validate_data_plane(config, &data_plane, expected.responder.as_ref())
}

fn validate_stats_service(
    config: &Map<String, Value>,
    expected: &ProbeIsolationExpectation,
) -> Result<(), ProbeIsolationError> {
    if config
        .get("experimental")
        .and_then(Value::as_object)
        .is_some_and(|experimental| experimental.contains_key("v2ray_api"))
    {
        return Err(ProbeIsolationError::StatsServiceMismatch);
    }
    let services = config
        .get("services")
        .and_then(Value::as_array)
        .ok_or(ProbeIsolationError::MissingStatsService)?;
    let mut api = services
        .iter()
        .filter(|service| service.get("type").and_then(Value::as_str) == Some("api"));
    let service = api
        .next()
        .and_then(Value::as_object)
        .ok_or(ProbeIsolationError::MissingStatsService)?;
    if api.next().is_some() {
        return Err(ProbeIsolationError::StatsServiceMismatch);
    }
    let listen = service
        .get("listen")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<IpAddr>().ok())
        .ok_or(ProbeIsolationError::StatsServiceMismatch)?;
    let port = service
        .get("listen_port")
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .ok_or(ProbeIsolationError::StatsServiceMismatch)?;
    if !listen.is_loopback()
        || listen != expected.stats_endpoint.ip()
        || port != expected.stats_endpoint.port()
    {
        return Err(ProbeIsolationError::StatsServiceMismatch);
    }
    Ok(())
}

fn validate_ingress(
    config: &Map<String, Value>,
    ingress: &ProbeIngress,
) -> Result<(), ProbeIsolationError> {
    let inbounds = config
        .get("inbounds")
        .and_then(Value::as_array)
        .ok_or(ProbeIsolationError::MissingIngress)?;
    let mut found = None;
    for inbound in inbounds {
        if inbound.get("tag").and_then(Value::as_str) == Some(ingress.tag.as_str()) {
            if found.is_some() {
                return Err(ProbeIsolationError::DuplicateIngress);
            }
            found = inbound.as_object();
        }
    }
    let inbound = found.ok_or(ProbeIsolationError::MissingIngress)?;
    if inbound.get("type").and_then(Value::as_str) != Some("http") {
        return Err(ProbeIsolationError::IngressShape);
    }
    let listen = inbound
        .get("listen")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<IpAddr>().ok())
        .ok_or(ProbeIsolationError::IngressShape)?;
    let port = inbound
        .get("listen_port")
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .ok_or(ProbeIsolationError::IngressShape)?;
    if !listen.is_loopback() || listen != ingress.listen.ip() || port != ingress.listen.port() {
        return Err(ProbeIsolationError::IngressShape);
    }
    let users = inbound
        .get("users")
        .and_then(Value::as_array)
        .filter(|users| users.len() == 1)
        .ok_or(ProbeIsolationError::IngressAuth)?;
    let user = users[0]
        .as_object()
        .ok_or(ProbeIsolationError::IngressAuth)?;
    let username = user
        .get("username")
        .and_then(Value::as_str)
        .ok_or(ProbeIsolationError::IngressAuth)?;
    let credential = user
        .get("password")
        .and_then(Value::as_str)
        .ok_or(ProbeIsolationError::IngressAuth)?;
    if username != ingress.auth_user || credential != ingress.auth_credential.expose() {
        return Err(ProbeIsolationError::IngressAuth);
    }
    Ok(())
}

fn validate_probe_rules(
    config: &Map<String, Value>,
    ingress: &ProbeIngress,
) -> Result<(), ProbeIsolationError> {
    let rules = route_rules(config)?;
    let mut allow = false;
    let mut reject = false;
    for rule in rules {
        let Some(object) = rule.as_object() else {
            return Err(ProbeIsolationError::UnsafeProbeAllow);
        };
        let explicit = has_effective_inbound_scope(object);
        let scope = explicit_scope(object);
        if explicit && !scope.contains(&ingress.tag.as_str()) {
            continue;
        }
        if explicit
            && scope
                .iter()
                .any(|tag| !tag.starts_with(AGENT_OWNED_TAG_PREFIX))
        {
            return Err(ProbeIsolationError::UnsafeProbeAllow);
        }
        match object.get("action").and_then(Value::as_str) {
            Some("sniff" | "resolve") if !explicit => continue,
            Some("route") if !explicit => {
                // A global terminal route applies to the probe ingress too.
                // It is unreachable only after the explicit probe reject.
                if !reject {
                    return Err(ProbeIsolationError::UnsafeProbeAllow);
                }
                continue;
            }
            Some("reject") if !explicit => {
                if !allow {
                    return Err(ProbeIsolationError::MissingProbeAllow);
                }
                return Err(ProbeIsolationError::UnsafeProbeAllow);
            }
            Some("sniff") => continue,
            Some("route") => {
                if allow || reject {
                    return Err(ProbeIsolationError::UnsafeProbeAllow);
                }
                if !is_probe_allow(object, ingress) {
                    return Err(ProbeIsolationError::UnsafeProbeAllow);
                }
                allow = true;
            }
            Some("reject") => {
                if !allow {
                    return Err(ProbeIsolationError::MissingProbeAllow);
                }
                if !is_bare_reject(object) {
                    return Err(ProbeIsolationError::UnsafeProbeAllow);
                }
                reject = true;
            }
            _ => return Err(ProbeIsolationError::UnsafeProbeAllow),
        }
    }
    if !allow {
        return Err(ProbeIsolationError::MissingProbeAllow);
    }
    if !reject {
        return Err(ProbeIsolationError::MissingProbeReject);
    }
    Ok(())
}

fn is_probe_allow(object: &Map<String, Value>, ingress: &ProbeIngress) -> bool {
    if object.get("action").and_then(Value::as_str) != Some("route")
        || object.get("outbound").and_then(Value::as_str) != Some(ingress.outbound_tag.as_str())
        || object
            .get("inbound")
            .and_then(Value::as_array)
            .is_none_or(|tags| tags.len() != 1 || tags[0].as_str() != Some(ingress.tag.as_str()))
    {
        return false;
    }
    if !object_keys_are(
        object,
        &[
            "inbound", "ip_cidr", "port", "network", "action", "outbound",
        ],
    ) {
        return false;
    }
    exact_cidr(object, ingress.responder_endpoint.ip())
        && exact_port(object, ingress.responder_endpoint.port())
        && tcp_only(object)
}

fn is_responder_allow(object: &Map<String, Value>, responder: &ProbeResponderRoute) -> bool {
    if object.get("action").and_then(Value::as_str) != Some("route")
        || object.get("outbound").and_then(Value::as_str) != Some(DIRECT_OUTBOUND_TAG)
        || object
            .get("inbound")
            .and_then(Value::as_array)
            .is_none_or(|tags| {
                tags.len() != 1 || tags[0].as_str() != Some(responder.peer_inbound_tag.as_str())
            })
    {
        return false;
    }
    if !object_keys_are(
        object,
        &[
            "inbound",
            "auth_user",
            "ip_cidr",
            "port",
            "network",
            "action",
            "outbound",
        ],
    ) {
        return false;
    }
    let expected = responder.peer_identity.user_name();
    let auth = match object.get("auth_user") {
        Some(Value::String(value)) => vec![value.as_str()],
        Some(Value::Array(values)) => values.iter().filter_map(Value::as_str).collect(),
        _ => return false,
    };
    auth == vec![expected.as_str()]
        && exact_cidr(object, responder.responder_endpoint.ip())
        && exact_port(object, responder.responder_endpoint.port())
        && tcp_only(object)
}

fn looks_like_responder_allow(
    object: &Map<String, Value>,
    responder: &ProbeResponderRoute,
) -> bool {
    object.get("action").and_then(Value::as_str) == Some("route")
        && object.get("outbound").and_then(Value::as_str) == Some(DIRECT_OUTBOUND_TAG)
        && object
            .get("inbound")
            .and_then(Value::as_array)
            .is_some_and(|tags| {
                tags.len() == 1 && tags[0].as_str() == Some(responder.peer_inbound_tag.as_str())
            })
        && object.get("auth_user").is_some()
}

fn validate_data_plane(
    config: &Map<String, Value>,
    tags: &[String],
    responder: Option<&ProbeResponderRoute>,
) -> Result<(), ProbeIsolationError> {
    if tags.is_empty() {
        return Ok(());
    }
    let rules = route_rules(config)?;
    if !has_route_resolver(config, rules, tags) {
        return Err(ProbeIsolationError::UnresolvedDataPlane(tags[0].clone()));
    }
    // One exact responder exception must be reachable before the generic
    // loopback reject. Only the exact principal and destination are admitted.
    let mut responder_allow = false;
    if let Some(responder) = responder {
        let mut blocked_for_peer_before_allow = false;
        for rule in rules {
            let Some(object) = rule.as_object() else {
                continue;
            };
            let covers_peer = !has_effective_inbound_scope(object)
                || explicit_scope(object).contains(&responder.peer_inbound_tag.as_str());
            if !covers_peer {
                continue;
            }
            if is_pure_loopback_block(object)
                && object_keys_are(object, &["inbound", "ip_cidr", "action"])
            {
                blocked_for_peer_before_allow = true;
                continue;
            }
            if looks_like_responder_allow(object, responder) {
                if !is_responder_allow(object, responder) {
                    return Err(ProbeIsolationError::UnsafeResponderAllow);
                }
                if blocked_for_peer_before_allow {
                    return Err(ProbeIsolationError::MissingResponderAllow);
                }
                responder_allow = true;
            }
        }
        if !responder_allow {
            return Err(ProbeIsolationError::MissingResponderAllow);
        }
    } else if rules.iter().any(|rule| {
        rule.as_object().is_some_and(|object| {
            object.get("action").and_then(Value::as_str) == Some("route")
                && object.get("auth_user").is_some()
        })
    }) {
        return Err(ProbeIsolationError::UnsafeResponderAllow);
    }

    for tag in tags {
        let mut resolved = false;
        let mut blocked = EndpointCoverage::default();
        let mut exact_responder = false;
        for rule in rules {
            let Some(object) = rule.as_object() else {
                return Err(ProbeIsolationError::UnsafeDataPlaneAction(tag.clone()));
            };
            if !rule_covers(object, tag) {
                continue;
            }
            match object.get("action").and_then(Value::as_str) {
                Some("sniff") => continue,
                Some("resolve") => {
                    resolved = true;
                }
                Some("reject") => {
                    if is_pure_loopback_block(object) {
                        blocked = blocked.merge(endpoint_coverage(object));
                    }
                }
                Some("route")
                    if responder.is_some_and(|route| {
                        route.peer_inbound_tag == tag.as_str() && is_responder_allow(object, route)
                    }) =>
                {
                    if blocked.complete() {
                        return Err(ProbeIsolationError::MissingResponderAllow);
                    }
                    exact_responder = true;
                }
                Some("route") | Some("bypass") => {
                    if !blocked.complete() {
                        return Err(ProbeIsolationError::UnblockedLoopback(tag.clone()));
                    }
                    if !resolved {
                        return Err(ProbeIsolationError::UnresolvedDataPlane(tag.clone()));
                    }
                }
                _ => return Err(ProbeIsolationError::UnsafeDataPlaneAction(tag.clone())),
            }
        }
        if !blocked.complete() {
            return Err(ProbeIsolationError::UnblockedLoopback(tag.clone()));
        }
        if !resolved {
            return Err(ProbeIsolationError::UnresolvedDataPlane(tag.clone()));
        }
        if responder.is_some_and(|route| route.peer_inbound_tag == tag.as_str()) && !exact_responder
        {
            return Err(ProbeIsolationError::MissingResponderAllow);
        }
    }
    Ok(())
}

fn has_route_resolver(config: &Map<String, Value>, rules: &[Value], tags: &[String]) -> bool {
    let default = config
        .get("route")
        .and_then(|route| route.get("default_domain_resolver"))
        .is_some_and(|value| match value {
            Value::String(value) => !value.is_empty(),
            Value::Object(value) => !value.is_empty(),
            _ => false,
        });
    if default {
        return true;
    }
    tags.iter().all(|tag| {
        rules.iter().any(|rule| {
            rule.as_object().is_some_and(|object| {
                object.get("action").and_then(Value::as_str) == Some("resolve")
                    && rule_covers(object, tag)
                    && object
                        .get("server")
                        .and_then(Value::as_str)
                        .is_some_and(|server| !server.is_empty())
            })
        })
    })
}

fn is_bare_reject(object: &Map<String, Value>) -> bool {
    object_keys_are(object, &["inbound", "action"])
        && object.get("action").and_then(Value::as_str) == Some("reject")
}

fn is_pure_loopback_block(object: &Map<String, Value>) -> bool {
    if object.get("action").and_then(Value::as_str) != Some("reject") {
        return false;
    }
    if object.get("invert").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    if !object_keys_are(object, &["inbound", "ip_cidr", "action"]) {
        return false;
    }
    endpoint_coverage(object).any()
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct EndpointCoverage {
    loopback_v4: bool,
    loopback_v6: bool,
    mapped_loopback_v4: bool,
    unspecified_v4: bool,
    unspecified_v6: bool,
}

impl EndpointCoverage {
    fn merge(self, other: Self) -> Self {
        Self {
            loopback_v4: self.loopback_v4 || other.loopback_v4,
            loopback_v6: self.loopback_v6 || other.loopback_v6,
            mapped_loopback_v4: self.mapped_loopback_v4 || other.mapped_loopback_v4,
            unspecified_v4: self.unspecified_v4 || other.unspecified_v4,
            unspecified_v6: self.unspecified_v6 || other.unspecified_v6,
        }
    }

    fn any(self) -> bool {
        self.loopback_v4
            || self.loopback_v6
            || self.mapped_loopback_v4
            || self.unspecified_v4
            || self.unspecified_v6
    }

    fn complete(self) -> bool {
        self.loopback_v4
            && self.loopback_v6
            && self.mapped_loopback_v4
            && self.unspecified_v4
            && self.unspecified_v6
    }
}

fn endpoint_coverage(object: &Map<String, Value>) -> EndpointCoverage {
    let mut coverage = EndpointCoverage::default();
    if let Some(cidrs) = object.get("ip_cidr") {
        for cidr in string_or_array(cidrs) {
            match cidr {
                LOOPBACK_V4_CIDR => coverage.loopback_v4 = true,
                LOOPBACK_V6_CIDR => coverage.loopback_v6 = true,
                MAPPED_LOOPBACK_V4_CIDR => coverage.mapped_loopback_v4 = true,
                UNSPECIFIED_V4_CIDR => coverage.unspecified_v4 = true,
                UNSPECIFIED_V6_CIDR => coverage.unspecified_v6 = true,
                _ => {}
            }
        }
    }
    coverage
}

fn exact_cidr(object: &Map<String, Value>, ip: IpAddr) -> bool {
    object
        .get("ip_cidr")
        .and_then(Value::as_array)
        .is_some_and(|values| {
            values.len() == 1 && values[0].as_str() == Some(single_cidr(ip).as_str())
        })
}

fn exact_port(object: &Map<String, Value>, port: u16) -> bool {
    object
        .get("port")
        .and_then(Value::as_array)
        .is_some_and(|values| values.len() == 1 && values[0].as_u64() == Some(u64::from(port)))
}

fn tcp_only(object: &Map<String, Value>) -> bool {
    let network = object.get("network");
    match network {
        Some(Value::String(value)) => value == "tcp",
        Some(Value::Array(values)) => values.len() == 1 && values[0].as_str() == Some("tcp"),
        _ => false,
    }
}

fn object_keys_are(object: &Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().all(|key| allowed.contains(&key.as_str()))
}

fn has_effective_inbound_scope(object: &Map<String, Value>) -> bool {
    match object.get("inbound") {
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(values)) => !values.is_empty(),
        _ => false,
    }
}

fn rule_covers(object: &Map<String, Value>, tag: &str) -> bool {
    match object.get("inbound") {
        None => true,
        Some(Value::String(value)) => value == tag,
        Some(Value::Array(values)) => {
            values.is_empty() || values.iter().any(|value| value.as_str() == Some(tag))
        }
        Some(_) => false,
    }
}

fn explicit_scope(object: &Map<String, Value>) -> Vec<&str> {
    match object.get("inbound") {
        Some(Value::String(value)) => vec![value.as_str()],
        Some(Value::Array(values)) => values.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

fn string_or_array(value: &Value) -> Vec<&str> {
    match value {
        Value::String(value) => vec![value.as_str()],
        Value::Array(values) => values.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

fn route_rules(config: &Map<String, Value>) -> Result<&[Value], ProbeIsolationError> {
    config
        .get("route")
        .and_then(|route| route.get("rules"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or(ProbeIsolationError::MissingRouteRules)
}

fn has_direct_outbound(config: &Map<String, Value>) -> bool {
    config
        .get("outbounds")
        .and_then(Value::as_array)
        .is_some_and(|outbounds| {
            outbounds.iter().any(|outbound| {
                outbound.get("tag").and_then(Value::as_str) == Some(DIRECT_OUTBOUND_TAG)
                    && outbound.get("type").and_then(Value::as_str) == Some("direct")
            })
        })
}

/// Every candidate inbound except the agent-owned probe ingress. Unknown or
/// additional agent-owned listener namespaces fail closed.
pub(crate) fn data_plane_tags(
    config: &Map<String, Value>,
    ingress_tag: Option<&str>,
) -> Result<Vec<String>, ProbeIsolationError> {
    let inbounds = config
        .get("inbounds")
        .and_then(Value::as_array)
        .ok_or(ProbeIsolationError::MissingIngress)?;
    let mut seen = HashSet::new();
    let mut tags = Vec::new();
    for inbound in inbounds {
        let tag = inbound
            .get("tag")
            .and_then(Value::as_str)
            .filter(|tag| !tag.is_empty() && tag.len() <= MAX_LINK_PROBE_ID_CHARS)
            .ok_or(ProbeIsolationError::UnsupportedInboundTag(
                "<missing>".to_string(),
            ))?;
        if !seen.insert(tag.to_string()) {
            return Err(ProbeIsolationError::UnsupportedInboundTag(tag.to_string()));
        }
        if ingress_tag.is_some_and(|ingress| ingress == tag) {
            continue;
        }
        if tag.starts_with(AGENT_OWNED_TAG_PREFIX) {
            return Err(ProbeIsolationError::UnsupportedInboundTag(tag.to_string()));
        }
        if !tag.starts_with("node-") && !tag.starts_with(PEER_INBOUND_TAG_PREFIX) {
            return Err(ProbeIsolationError::UnsupportedInboundTag(tag.to_string()));
        }
        tags.push(tag.to_string());
    }
    Ok(tags)
}

fn single_cidr(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(_) => format!("{ip}/32"),
        IpAddr::V6(_) => format!("{ip}/128"),
    }
}

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_LINK_PROBE_ID_CHARS
        && !value.bytes().any(|byte| byte.is_ascii_control())
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use serde_json::Map;

    use super::*;
    use crate::probe::identity::{LinkCredential, PeerLinkIdentity};

    fn identity() -> PeerLinkIdentity {
        PeerLinkIdentity::new("link-1", 1).unwrap()
    }

    fn ingress() -> ProbeIngress {
        ProbeIngress::new(
            "127.0.0.1:19080".parse().unwrap(),
            "probe-local",
            LinkCredential::new("ingress-secret").unwrap(),
            "peer-out-pout1",
            "127.0.0.1:19500".parse().unwrap(),
        )
        .unwrap()
    }

    fn responder() -> ProbeResponderRoute {
        ProbeResponderRoute::new(
            "peer-in-pin1",
            identity(),
            "127.0.0.1:19500".parse().unwrap(),
        )
        .unwrap()
    }

    fn source_config() -> Map<String, Value> {
        json!({
            "log": {"level": "info", "timestamp": true},
            "dns": {"servers": [{"type": "local", "tag": "local-dns"}], "final": "local-dns"},
            "services": [{
                "type": "api",
                "listen": "127.0.0.1",
                "listen_port": 19081,
                "secret": "stats-secret"
            }],
            "inbounds": [{
                "type": "vless",
                "tag": "node-n1",
                "listen": "127.0.0.1",
                "listen_port": 8443,
                "users": [{"name": "sub-user", "uuid": "00000000-0000-0000-0000-000000000001"}]
            }],
            "outbounds": [
                {"type": "direct", "tag": "direct"},
                {
                    "type": "trojan",
                    "tag": "peer-out-pout1",
                    "server": "127.0.0.1",
                    "server_port": 9443,
                    "password": "peer-credential",
                    "tls": {"enabled": true, "server_name": "peer-b.internal.example.com"}
                }
            ],
            "route": {
                "default_domain_resolver": "local-dns",
                "rules": [{
                    "inbound": ["node-n1"],
                    "network": ["tcp"],
                    "action": "route",
                    "outbound": "peer-out-pout1"
                }],
                "final": "direct"
            }
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn destination_config() -> Map<String, Value> {
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
                        "name": identity().user_name(),
                        "password": "peer-credential"
                    }],
                    "tls": {"enabled": true, "server_name": "peer-b.internal.example.com"}
                },
                {
                    "type": "vless",
                    "tag": "node-n1",
                    "listen": "127.0.0.1",
                    "listen_port": 8443,
                    "users": [{"name": "sub-user", "uuid": "00000000-0000-0000-0000-000000000001"}]
                }
            ],
            "outbounds": [{"type": "direct", "tag": "direct"}],
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

    fn source_expectation() -> ProbeIsolationExpectation {
        ProbeIsolationExpectation::new(Some(ingress()), None, "127.0.0.1:19081".parse().unwrap())
            .unwrap()
    }

    fn destination_expectation() -> ProbeIsolationExpectation {
        ProbeIsolationExpectation::new(None, Some(responder()), "127.0.0.1:19081".parse().unwrap())
            .unwrap()
    }

    #[test]
    fn installed_source_and_destination_candidates_prove_isolation() {
        let mut source = source_config();
        install_probe_candidate(
            &mut source,
            ProbeCandidatePlan {
                ingress: Some(&ingress()),
                responder: None,
                stats_endpoint: "127.0.0.1:19081".parse().unwrap(),
            },
        )
        .unwrap();
        validate_candidate(&source, &source_expectation()).unwrap();

        let mut destination = destination_config();
        install_probe_candidate(
            &mut destination,
            ProbeCandidatePlan {
                ingress: None,
                responder: Some(&responder()),
                stats_endpoint: "127.0.0.1:19081".parse().unwrap(),
            },
        )
        .unwrap();
        validate_candidate(&destination, &destination_expectation()).unwrap();
    }

    #[test]
    fn non_loopback_ingress_and_overlapping_endpoints_are_refused() {
        assert!(
            ProbeIngress::new(
                "0.0.0.0:19080".parse().unwrap(),
                "probe-local",
                LinkCredential::new("ingress-secret").unwrap(),
                "peer-out-pout1",
                "127.0.0.1:19500".parse().unwrap(),
            )
            .is_err()
        );
        assert!(
            ProbeIngress::new(
                "127.0.0.1:19080".parse().unwrap(),
                "probe-local",
                LinkCredential::new("ingress-secret").unwrap(),
                "peer-out-pout1",
                "127.0.0.1:19080".parse().unwrap(),
            )
            .is_err()
        );
        let mut source = source_config();
        install_probe_candidate(
            &mut source,
            ProbeCandidatePlan {
                ingress: Some(&ingress()),
                responder: None,
                stats_endpoint: "127.0.0.1:19081".parse().unwrap(),
            },
        )
        .unwrap();
        source["services"][0]["listen_port"] = json!(19500);
        let mut expectation = source_expectation();
        expectation.stats_endpoint = "127.0.0.1:19500".parse().unwrap();
        assert_eq!(
            validate_candidate(&source, &expectation).unwrap_err(),
            ProbeIsolationError::StatsEndpointOverlap
        );
    }

    #[test]
    fn probe_allow_cannot_widen_beyond_the_fixed_responder() {
        let mut source = source_config();
        let ingress = ingress();
        install_probe_candidate(
            &mut source,
            ProbeCandidatePlan {
                ingress: Some(&ingress),
                responder: None,
                stats_endpoint: "127.0.0.1:19081".parse().unwrap(),
            },
        )
        .unwrap();
        let allow = source["route"]["rules"][0].as_object_mut().unwrap();
        allow["port"] = json!([19500, 19081]);
        assert_eq!(
            validate_candidate(&source, &source_expectation()).unwrap_err(),
            ProbeIsolationError::UnsafeProbeAllow
        );

        let mut source = source_config();
        install_probe_candidate(
            &mut source,
            ProbeCandidatePlan {
                ingress: Some(&ingress),
                responder: None,
                stats_endpoint: "127.0.0.1:19081".parse().unwrap(),
            },
        )
        .unwrap();
        let allow = source["route"]["rules"][0].as_object_mut().unwrap();
        allow.insert(
            "inbound".to_string(),
            json!(["blossom-agent-link-probe-in", "node-n1"]),
        );
        assert_eq!(
            validate_candidate(&source, &source_expectation()).unwrap_err(),
            ProbeIsolationError::UnsafeProbeAllow
        );
    }

    #[test]
    fn a_global_route_before_the_probe_terminal_reject_is_refused() {
        let mut source = source_config();
        install_probe_candidate(
            &mut source,
            ProbeCandidatePlan {
                ingress: Some(&ingress()),
                responder: None,
                stats_endpoint: "127.0.0.1:19081".parse().unwrap(),
            },
        )
        .unwrap();
        let rules = source["route"]["rules"].as_array_mut().unwrap();
        rules.insert(
            0,
            json!({
                "network": ["tcp"],
                "action": "route",
                "outbound": "peer-out-pout1"
            }),
        );
        assert_eq!(
            validate_candidate(&source, &source_expectation()).unwrap_err(),
            ProbeIsolationError::UnsafeProbeAllow
        );
    }

    #[test]
    fn stats_requires_loopback_reject_and_resolution_before_any_route() {
        let mut source = source_config();
        install_probe_candidate(
            &mut source,
            ProbeCandidatePlan {
                ingress: Some(&ingress()),
                responder: None,
                stats_endpoint: "127.0.0.1:19081".parse().unwrap(),
            },
        )
        .unwrap();
        let rules = source["route"]["rules"].as_array_mut().unwrap();
        // Replace the complete loopback block with a narrower stats-only
        // reject: a resolved hostname could still reach the loopback range.
        rules[3]["ip_cidr"] = json!(["127.0.0.1/32"]);
        assert_eq!(
            validate_candidate(&source, &source_expectation()).unwrap_err(),
            ProbeIsolationError::UnblockedLoopback("node-n1".to_string())
        );

        let mut source = source_config();
        install_probe_candidate(
            &mut source,
            ProbeCandidatePlan {
                ingress: Some(&ingress()),
                responder: None,
                stats_endpoint: "127.0.0.1:19081".parse().unwrap(),
            },
        )
        .unwrap();
        let rules = source["route"]["rules"].as_array_mut().unwrap();
        rules.remove(2); // resolve
        assert_eq!(
            validate_candidate(&source, &source_expectation()).unwrap_err(),
            ProbeIsolationError::UnresolvedDataPlane("node-n1".to_string())
        );
    }

    #[test]
    fn responder_requires_the_exact_peer_identity_and_destination() {
        let mut destination = destination_config();
        install_probe_candidate(
            &mut destination,
            ProbeCandidatePlan {
                ingress: None,
                responder: Some(&responder()),
                stats_endpoint: "127.0.0.1:19081".parse().unwrap(),
            },
        )
        .unwrap();
        let allow = destination["route"]["rules"][1].as_object_mut().unwrap();
        allow["auth_user"] = json!(["*"]);
        assert_eq!(
            validate_candidate(&destination, &destination_expectation()).unwrap_err(),
            ProbeIsolationError::UnsafeResponderAllow
        );

        let mut destination = destination_config();
        install_probe_candidate(
            &mut destination,
            ProbeCandidatePlan {
                ingress: None,
                responder: Some(&responder()),
                stats_endpoint: "127.0.0.1:19081".parse().unwrap(),
            },
        )
        .unwrap();
        destination["route"]["rules"][1]["port"] = json!([19500, 19081]);
        assert_eq!(
            validate_candidate(&destination, &destination_expectation()).unwrap_err(),
            ProbeIsolationError::UnsafeResponderAllow
        );

        let mut destination = destination_config();
        install_probe_candidate(
            &mut destination,
            ProbeCandidatePlan {
                ingress: None,
                responder: Some(&responder()),
                stats_endpoint: "127.0.0.1:19081".parse().unwrap(),
            },
        )
        .unwrap();
        destination["route"]["rules"][1]["ip_cidr"] = json!(["127.0.0.0/8"]);
        assert_eq!(
            validate_candidate(&destination, &destination_expectation()).unwrap_err(),
            ProbeIsolationError::UnsafeResponderAllow
        );
    }

    #[test]
    fn unknown_agent_owned_tags_and_stats_mismatch_fail_closed() {
        let mut source = source_config();
        source["inbounds"].as_array_mut().unwrap().push(json!({
            "type": "socks",
            "tag": "blossom-agent-extra",
            "listen": "127.0.0.1",
            "listen_port": 19082
        }));
        let expectation = source_expectation();
        assert_eq!(
            validate_candidate(&source, &expectation).unwrap_err(),
            ProbeIsolationError::UnsupportedInboundTag("blossom-agent-extra".to_string())
        );

        let mut source = source_config();
        source["services"] = json!([]);
        assert_eq!(
            validate_candidate(&source, &expectation).unwrap_err(),
            ProbeIsolationError::MissingStatsService
        );

        let mut destination = destination_config();
        destination["inbounds"][0]["users"][0]["name"] =
            json!(PeerLinkIdentity::new("link-1", 2).unwrap().user_name());
        assert_eq!(
            validate_candidate(&destination, &destination_expectation()).unwrap_err(),
            ProbeIsolationError::Identity(ProbeIdentityError::MissingPeerUser(
                "peer-in-pin1".to_string()
            ))
        );
    }

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new() -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "blossom-probe-check-{}-{nanos}",
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

    struct ChildGuard(std::process::Child);

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    async fn wait_for_listener(port: u16, child: &mut std::process::Child) {
        for _ in 0..200 {
            if tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_ok()
            {
                return;
            }
            assert!(
                child.try_wait().unwrap().is_none(),
                "sing-box exited before binding loopback port {port}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("sing-box did not bind loopback port {port}");
    }

    async fn socks_connect_domain(proxy_port: u16, target: &str, port: u16) -> bool {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", proxy_port))
            .await
            .unwrap();
        stream.write_all(&[5, 1, 0]).await.unwrap();
        let mut selected = [0u8; 2];
        if stream.read_exact(&mut selected).await.is_err() || selected != [5, 0] {
            return false;
        }
        let mut request = vec![5, 1, 0, 3, u8::try_from(target.len()).unwrap()];
        request.extend_from_slice(target.as_bytes());
        request.extend_from_slice(&port.to_be_bytes());
        stream.write_all(&request).await.unwrap();
        let mut reply = [0u8; 4];
        if stream.read_exact(&mut reply).await.is_err() {
            return false;
        }
        reply[1] == 0
    }

    #[tokio::test]
    async fn pinned_sing_box_blocks_literal_and_resolved_loopback_from_data_plane() {
        let Ok(bin) = std::env::var("SING_BOX_BIN") else {
            return;
        };
        let dir = TempDir::new();
        let node_port = "127.0.0.1:0";
        let node_port = std::net::TcpListener::bind(node_port)
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let stats_port = std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let sentinel = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let sentinel_port = sentinel.local_addr().unwrap().port();
        let accepted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let accepted_task = accepted.clone();
        let sentinel_task = tokio::spawn(async move {
            if let Ok((mut stream, _)) = sentinel.accept().await {
                use tokio::io::AsyncWriteExt as _;
                accepted_task.store(true, std::sync::atomic::Ordering::SeqCst);
                let _ = stream.write_all(b"unexpected").await;
            }
        });

        let config = json!({
            "log": {"level": "warn", "timestamp": true},
            "dns": {"servers": [{"type": "local", "tag": "local-dns"}], "final": "local-dns"},
            "services": [{
                "type": "api",
                "listen": "127.0.0.1",
                "listen_port": stats_port,
                "secret": "sentinel-stats-secret"
            }],
            "inbounds": [{
                "type": "mixed",
                "tag": "node-n1",
                "listen": "127.0.0.1",
                "listen_port": node_port
            }],
            "outbounds": [{"type": "direct", "tag": "direct"}],
            "route": {
                "default_domain_resolver": "local-dns",
                "rules": [],
                "final": "direct"
            }
        });
        let mut config = config.as_object().unwrap().clone();
        install_probe_candidate(
            &mut config,
            ProbeCandidatePlan {
                ingress: None,
                responder: None,
                stats_endpoint: format!("127.0.0.1:{stats_port}").parse().unwrap(),
            },
        )
        .unwrap();
        let expectation = ProbeIsolationExpectation::new(
            None,
            None,
            format!("127.0.0.1:{stats_port}").parse().unwrap(),
        )
        .unwrap();
        validate_candidate(&config, &expectation).unwrap();
        let path = dir.0.join("data-plane.json");
        std::fs::write(&path, serde_json::to_vec_pretty(&config).unwrap()).unwrap();
        let mut child = std::process::Command::new(&bin)
            .args(["run", "-c"])
            .arg(&path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("pinned sing-box data-plane fixture runs");
        wait_for_listener(node_port, &mut child).await;
        let _guard = ChildGuard(child);

        assert!(
            !socks_connect_domain(node_port, "127.0.0.1", sentinel_port).await,
            "literal loopback reached the local sentinel"
        );
        assert!(
            !socks_connect_domain(node_port, "localhost", sentinel_port).await,
            "resolved loopback reached the local sentinel"
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(!accepted.load(std::sync::atomic::Ordering::SeqCst));
        sentinel_task.abort();
    }

    #[test]
    fn pinned_sing_box_accepts_the_installed_probe_candidates() {
        let Ok(bin) = std::env::var("SING_BOX_BIN") else {
            return;
        };
        let dir = TempDir::new();
        let certified =
            rcgen::generate_simple_self_signed(vec!["peer-b.internal.example.com".to_string()])
                .unwrap();
        let cert_path = dir.0.join("peer-b.pem");
        let key_path = dir.0.join("peer-b.key");
        std::fs::write(&cert_path, certified.cert.pem()).unwrap();
        std::fs::write(&key_path, certified.signing_key.serialize_pem()).unwrap();

        let mut source = source_config();
        source["outbounds"][1]["tls"]["certificate_path"] = json!(cert_path.to_string_lossy());
        install_probe_candidate(
            &mut source,
            ProbeCandidatePlan {
                ingress: Some(&ingress()),
                responder: None,
                stats_endpoint: "127.0.0.1:19081".parse().unwrap(),
            },
        )
        .unwrap();

        let mut destination = destination_config();
        destination["inbounds"][0]["tls"]["certificate_path"] = json!(cert_path.to_string_lossy());
        destination["inbounds"][0]["tls"]["key_path"] = json!(key_path.to_string_lossy());
        install_probe_candidate(
            &mut destination,
            ProbeCandidatePlan {
                ingress: None,
                responder: Some(&responder()),
                stats_endpoint: "127.0.0.1:19081".parse().unwrap(),
            },
        )
        .unwrap();

        let source_expectation = source_expectation();
        let destination_expectation = destination_expectation();
        for (name, config, expectation) in [
            ("source", source, &source_expectation),
            ("destination", destination, &destination_expectation),
        ] {
            validate_candidate(&config, expectation).unwrap();
            let path = dir.0.join(format!("{name}.json"));
            std::fs::write(&path, serde_json::to_vec_pretty(&config).unwrap()).unwrap();
            let output = std::process::Command::new(&bin)
                .arg("check")
                .arg("-c")
                .arg(&path)
                .output()
                .expect("pinned sing-box runs");
            assert!(
                output.status.success(),
                "pinned sing-box rejected the {name} probe candidate:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[test]
    fn source_plan_binds_the_ingress_to_a_committed_peer_outbound_credential() {
        let mut source = source_config();
        install_probe_candidate(
            &mut source,
            ProbeCandidatePlan {
                ingress: Some(&ingress()),
                responder: None,
                stats_endpoint: "127.0.0.1:19081".parse().unwrap(),
            },
        )
        .unwrap();
        source["outbounds"][1]
            .as_object_mut()
            .unwrap()
            .remove("password");
        let error = validate_candidate(&source, &source_expectation()).unwrap_err();
        assert!(matches!(
            error,
            ProbeIsolationError::Identity(ProbeIdentityError::MissingCredential(_))
        ));
    }

    #[test]
    fn source_plan_requires_an_authenticated_loopback_http_ingress() {
        let mut source = source_config();
        install_probe_candidate(
            &mut source,
            ProbeCandidatePlan {
                ingress: Some(&ingress()),
                responder: None,
                stats_endpoint: "127.0.0.1:19081".parse().unwrap(),
            },
        )
        .unwrap();
        source["inbounds"][1]["listen"] = json!("0.0.0.0");
        assert_eq!(
            validate_candidate(&source, &source_expectation()).unwrap_err(),
            ProbeIsolationError::IngressShape
        );
        assert_eq!(
            ProbeIsolationExpectation::new(
                None,
                None,
                "127.0.0.1:19081".parse::<SocketAddr>().unwrap()
            )
            .unwrap()
            .require_ingress()
            .unwrap_err(),
            ProbeIsolationError::MissingIngress
        );
    }
}
