//! Fixed authenticated loopback responder for managed link probes.
//!
//! The responder is agent-owned, binds only a loopback endpoint, serves only
//! `POST /blossom-agent-link-probe/v1`, and authenticates each request with the
//! link credential of the exact peer identity on the exact committed peer
//! inbound. It never accepts a destination, path, URL, subscriber credential,
//! or arbitrary token from the request.

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use serde_json::Map;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::debug;

use super::contract::{
    LinkProbeOutcome, LinkProbeRequest, ManagedGeneration, ProbeResponse, ProbeResponseUnsigned,
};
use super::http::{
    HttpError, MAX_PROBE_BODY_BYTES, PROBE_PATH, PROBE_TOKEN_HEADER, read_message, write_response,
};
use super::identity::{
    LinkCredential, PeerLinkIdentity, ProbeIdentityError, peer_inbound_credential, response_token,
    verify_request_token,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_IN_FLIGHT_REQUESTS: usize = 8;

/// One exact peer principal and the local committed generation it may prove.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProbeResponderBinding {
    pub(crate) listen: SocketAddr,
    /// Present when the manifest explicitly names the destination server. A
    /// config-derived fallback still binds only the exact peer identity, but
    /// cannot assert a server id that the config does not contain.
    pub(crate) local_server_id: Option<String>,
    pub(crate) peer_identity: PeerLinkIdentity,
    pub(crate) peer_credential: LinkCredential,
    pub(crate) committed: ManagedGeneration,
}

impl ProbeResponderBinding {
    /// Derives the binding from the committed candidate. The caller names the
    /// exact local peer inbound; the control plane never chooses it.
    pub(crate) fn from_committed_config(
        config: &Map<String, serde_json::Value>,
        listen: SocketAddr,
        local_server_id: &str,
        peer_inbound_tag: &str,
        peer_identity: PeerLinkIdentity,
        committed: ManagedGeneration,
    ) -> Result<Self, ProbeError> {
        if !listen.ip().is_loopback() {
            return Err(ProbeError::InvalidResponder(
                "probe responder must bind loopback",
            ));
        }
        if local_server_id.is_empty() {
            return Err(ProbeError::InvalidResponder(
                "probe responder server identity is missing",
            ));
        }
        let peer_credential = peer_inbound_credential(config, peer_inbound_tag, &peer_identity)?;
        Ok(Self {
            listen,
            local_server_id: Some(local_server_id.to_string()),
            peer_identity,
            peer_credential,
            committed,
        })
    }
}

pub(crate) struct ProbeResponder {
    local_addr: SocketAddr,
    cancel: CancellationToken,
    task: JoinHandle<()>,
}

impl ProbeResponder {
    /// Starts one fixed loopback listener serving every configured link binding.
    /// A second listener on the same endpoint or a duplicate identity fails
    /// closed instead of letting one link shadow another.
    pub(crate) async fn start(bindings: Vec<ProbeResponderBinding>) -> Result<Self, ProbeError> {
        let Some(first) = bindings.first() else {
            return Err(ProbeError::InvalidResponder(
                "probe responder has no bindings",
            ));
        };
        let listen = first.listen;
        if !listen.ip().is_loopback() {
            return Err(ProbeError::InvalidResponder(
                "probe responder must bind loopback",
            ));
        }
        if bindings.iter().any(|binding| binding.listen != listen) {
            return Err(ProbeError::InvalidResponder(
                "probe responder bindings name different endpoints",
            ));
        }
        let mut seen = HashSet::new();
        for binding in &bindings {
            if !seen.insert((
                binding.peer_identity.link_id.as_str(),
                binding.peer_identity.generation,
            )) {
                return Err(ProbeError::InvalidResponder(
                    "probe responder has an ambiguous link identity",
                ));
            }
        }
        let listener = TcpListener::bind(listen)
            .await
            .map_err(|error| ProbeError::Bind(format!("probe responder bind failed: {error}")))?;
        let local_addr = listener.local_addr().map_err(|error| {
            ProbeError::Bind(format!("probe responder address failed: {error}"))
        })?;
        if !local_addr.ip().is_loopback() {
            return Err(ProbeError::InvalidResponder(
                "probe responder bound a non-loopback address",
            ));
        }
        let cancel = CancellationToken::new();
        let state = Arc::new(bindings);
        let task = tokio::spawn(accept_loop(listener, state, cancel.clone()));
        Ok(Self {
            local_addr,
            cancel,
            task,
        })
    }

    #[must_use]
    pub(crate) fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub(crate) fn finish(self) {
        self.cancel.cancel();
        self.task.abort();
    }

    /// Stops the accept loop and waits for the listener to drop before the
    /// fixed endpoint is rebound for the next committed generation.
    pub(crate) async fn shutdown(mut self) {
        self.cancel.cancel();
        self.task.abort();
        let _ = (&mut self.task).await;
    }
}

impl Drop for ProbeResponder {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.task.abort();
    }
}

async fn accept_loop(
    listener: TcpListener,
    bindings: Arc<Vec<ProbeResponderBinding>>,
    cancel: CancellationToken,
) {
    let permits = Arc::new(Semaphore::new(MAX_IN_FLIGHT_REQUESTS));
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return,
            accepted = listener.accept() => {
                let Ok((stream, _peer)) = accepted else {
                    continue;
                };
                if !stream.peer_addr().is_ok_and(|peer| peer.ip().is_loopback()) {
                    drop(stream);
                    continue;
                }
                let Ok(permit) = permits.clone().try_acquire_owned() else {
                    drop(stream);
                    continue;
                };
                let bindings = bindings.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let _ = handle_connection(stream, bindings).await;
                });
            }
        }
    }
}

async fn handle_connection(
    mut stream: TcpStream,
    bindings: Arc<Vec<ProbeResponderBinding>>,
) -> Result<(), HttpError> {
    let message = match tokio::time::timeout(REQUEST_TIMEOUT, async {
        read_message(&mut stream, MAX_PROBE_BODY_BYTES, true).await
    })
    .await
    {
        Ok(result) => result?,
        Err(_) => return Ok(()),
    };
    let Some((method, target)) = message.request_line() else {
        return reject(&mut stream, "400 Bad Request").await;
    };
    if method != "POST" || target != PROBE_PATH {
        return reject(&mut stream, "404 Not Found").await;
    }
    let Some(token) = message.header(PROBE_TOKEN_HEADER) else {
        return reject(&mut stream, "401 Unauthorized").await;
    };
    let request: LinkProbeRequest = match serde_json::from_slice(&message.body) {
        Ok(request) => request,
        Err(_) => return reject(&mut stream, "400 Bad Request").await,
    };
    if request.validate().is_err() {
        return reject(&mut stream, "400 Bad Request").await;
    }
    let mut matching = bindings.iter().filter(|binding| {
        binding.peer_identity.link_id == request.link_id
            && binding.peer_identity.generation == request.credential_generation
            && binding
                .local_server_id
                .as_deref()
                .is_none_or(|server_id| server_id == request.destination.server_id)
    });
    let Some(binding) = matching.next() else {
        return reject(&mut stream, "403 Forbidden").await;
    };
    if matching.next().is_some() {
        return reject(&mut stream, "403 Forbidden").await;
    }
    if !verify_request_token(&request, &binding.peer_credential, token) {
        return reject(&mut stream, "401 Unauthorized").await;
    }

    let destination = binding.committed.applied();
    let outcome = if request.is_expired(Utc::now()) {
        LinkProbeOutcome::Expired
    } else if binding.committed.proves(&request.destination) {
        LinkProbeOutcome::Succeeded
    } else {
        LinkProbeOutcome::GenerationMismatch
    };
    let unsigned = ProbeResponseUnsigned {
        probe_id: &request.probe_id,
        outcome,
        destination: &destination,
    };
    let response_token = response_token(&request, &unsigned, &binding.peer_credential);
    let response = ProbeResponse {
        probe_id: request.probe_id.clone(),
        outcome,
        destination,
        response_token,
    };
    let body = serde_json::to_vec(&response).map_err(|_| HttpError::Malformed)?;
    write_response(&mut stream, "200 OK", &body).await?;
    debug!(
        probe_id = request.probe_id.as_str(),
        "link probe responder answered"
    );
    Ok(())
}

async fn reject(stream: &mut TcpStream, status: &str) -> Result<(), HttpError> {
    write_response(stream, status, b"{}").await?;
    Ok(())
}

#[derive(Debug)]
pub(crate) enum ProbeError {
    InvalidResponder(&'static str),
    Bind(String),
    Identity(ProbeIdentityError),
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidResponder(reason) => {
                write!(formatter, "invalid probe responder: {reason}")
            }
            Self::Bind(message) => formatter.write_str(message),
            Self::Identity(error) => write!(formatter, "probe identity is unavailable: {error}"),
        }
    }
}

impl std::error::Error for ProbeError {}

impl From<ProbeIdentityError> for ProbeError {
    fn from(error: ProbeIdentityError) -> Self {
        Self::Identity(error)
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpStream;

    use super::*;
    use crate::probe::contract::{LinkProbeEndpoint, ManagedApplied};

    fn identity() -> PeerLinkIdentity {
        PeerLinkIdentity::new("link-1", 1).unwrap()
    }

    fn config() -> Map<String, serde_json::Value> {
        serde_json::json!({
            "inbounds": [{
                "type": "trojan",
                "tag": "peer-in-pin1",
                "listen": "127.0.0.1",
                "listen_port": 9443,
                "users": [{
                    "name": identity().user_name(),
                    "password": "11111111-1111-1111-1111-111111111111"
                }],
                "tls": {"enabled": true, "server_name": "peer-b.internal.example.com"}
            }]
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn request() -> LinkProbeRequest {
        let endpoint = |server: &str, hex: &str, seq: u64| LinkProbeEndpoint {
            server_id: server.to_string(),
            managed_fingerprint: format!("sha256:{hex}"),
            min_revision_seq: seq,
        };
        LinkProbeRequest {
            probe_id: "probe-1".to_string(),
            rollout_id: "rollout-1".to_string(),
            stage_ordinal: 2,
            link_id: "link-1".to_string(),
            credential_generation: 1,
            source: endpoint("srv-a", &"a".repeat(64), 1),
            destination: endpoint("srv-b", &"b".repeat(64), 2),
            issued_at: Utc::now() - chrono::Duration::seconds(1),
            expires_at: Utc::now() + chrono::Duration::seconds(60),
        }
    }

    async fn binding(committed: ManagedGeneration) -> ProbeResponder {
        ProbeResponder::start(vec![
            ProbeResponderBinding::from_committed_config(
                &config(),
                "127.0.0.1:0".parse().unwrap(),
                "srv-b",
                "peer-in-pin1",
                identity(),
                committed,
            )
            .unwrap(),
        ])
        .await
        .unwrap()
    }

    async fn post(
        addr: SocketAddr,
        request: &LinkProbeRequest,
        token: Option<&str>,
        path: &str,
    ) -> String {
        let body = serde_json::to_vec(request).unwrap();
        let token = token
            .map(str::to_string)
            .unwrap_or_else(|| crate::probe::identity::request_token(request, &credential()));
        let mut stream = TcpStream::connect(addr).await.unwrap();
        let head = format!(
            "POST {path} HTTP/1.1\r\nHost: probe\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{PROBE_TOKEN_HEADER}: {token}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(head.as_bytes()).await.unwrap();
        stream.write_all(&body).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    fn credential() -> LinkCredential {
        peer_inbound_credential(&config(), "peer-in-pin1", &identity()).unwrap()
    }

    fn committed() -> ManagedGeneration {
        ManagedGeneration {
            desired_revision_seq: 5,
            managed_fingerprint: Some(format!("sha256:{}", "b".repeat(64))),
        }
    }

    #[tokio::test]
    async fn serves_only_the_exact_authenticated_peer_and_generation() {
        let responder = binding(committed()).await;
        let request = request();
        let response = post(
            responder.local_addr(),
            &request,
            None,
            "/blossom-agent-link-probe/v1",
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        let body = response
            .split_once("\r\n\r\n")
            .map(|(_, body)| body)
            .unwrap();
        let value: ProbeResponse = serde_json::from_str(body).unwrap();
        assert_eq!(value.outcome, LinkProbeOutcome::Succeeded);
        assert_eq!(
            value.destination,
            ManagedApplied {
                desired_revision_seq: 5,
                managed_fingerprint: Some(format!("sha256:{}", "b".repeat(64))),
            }
        );

        let mut stale = request.clone();
        stale.destination.managed_fingerprint = format!("sha256:{}", "c".repeat(64));
        let response = post(responder.local_addr(), &stale, None, PROBE_PATH).await;
        let body = response.split_once("\r\n\r\n").unwrap().1;
        let value: ProbeResponse = serde_json::from_str(body).unwrap();
        assert_eq!(value.outcome, LinkProbeOutcome::GenerationMismatch);

        let mut wrong_link = request.clone();
        wrong_link.link_id = "link-2".to_string();
        let response = post(responder.local_addr(), &wrong_link, None, PROBE_PATH).await;
        assert!(response.starts_with("HTTP/1.1 403 Forbidden"));

        let response = post(responder.local_addr(), &request, Some("00"), PROBE_PATH).await;
        assert!(response.starts_with("HTTP/1.1 401 Unauthorized"));

        let response = post(
            responder.local_addr(),
            &request,
            None,
            "/arbitrary/destination",
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 404 Not Found"));
        responder.finish();
    }

    #[tokio::test]
    async fn several_link_identities_share_one_fixed_responder_endpoint() {
        let mut config = config();
        let second = PeerLinkIdentity::new("link-2", 1).unwrap();
        config["inbounds"][0]["users"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "name": second.user_name(),
                "password": "11111111-1111-1111-1111-111111111111"
            }));
        let listen = "127.0.0.1:0".parse().unwrap();
        let first = ProbeResponderBinding::from_committed_config(
            &config,
            listen,
            "srv-b",
            "peer-in-pin1",
            identity(),
            committed(),
        )
        .unwrap();
        let second_binding = ProbeResponderBinding::from_committed_config(
            &config,
            listen,
            "srv-b",
            "peer-in-pin1",
            second.clone(),
            committed(),
        )
        .unwrap();
        let responder = ProbeResponder::start(vec![first, second_binding])
            .await
            .unwrap();
        let first_request = request();
        let response = post(responder.local_addr(), &first_request, None, PROBE_PATH).await;
        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");

        let mut second_request = request();
        second_request.probe_id = "probe-2".to_string();
        second_request.link_id = second.link_id.clone();
        let second_credential = peer_inbound_credential(&config, "peer-in-pin1", &second).unwrap();
        let token = crate::probe::identity::request_token(&second_request, &second_credential);
        let response = post(
            responder.local_addr(),
            &second_request,
            Some(&token),
            PROBE_PATH,
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        responder.finish();
    }

    #[tokio::test]
    async fn expired_requests_are_authenticated_then_report_expired() {
        let responder = binding(committed()).await;
        let mut request = request();
        request.issued_at = Utc::now() - chrono::Duration::seconds(120);
        request.expires_at = Utc::now() - chrono::Duration::seconds(60);
        let response = post(responder.local_addr(), &request, None, PROBE_PATH).await;
        let body = response.split_once("\r\n\r\n").unwrap().1;
        let value: ProbeResponse = serde_json::from_str(body).unwrap();
        assert_eq!(value.outcome, LinkProbeOutcome::Expired);
        responder.finish();
    }

    #[tokio::test]
    async fn oversized_requests_and_non_loopback_bindings_are_refused() {
        let responder = binding(committed()).await;
        let addr = responder.local_addr();
        let mut stream = TcpStream::connect(addr).await.unwrap();
        let body = vec![b'x'; MAX_PROBE_BODY_BYTES + 1];
        let head = format!(
            "POST {PROBE_PATH} HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        stream.write_all(head.as_bytes()).await.unwrap();
        stream.write_all(&body).await.unwrap();
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response).await;
        responder.finish();

        let binding = ProbeResponderBinding::from_committed_config(
            &config(),
            "0.0.0.0:19500".parse().unwrap(),
            "srv-b",
            "peer-in-pin1",
            identity(),
            committed(),
        );
        assert!(binding.is_err());
    }
}
