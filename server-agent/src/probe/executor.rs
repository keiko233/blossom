//! Bounded executor for one authenticated link probe.
//!
//! Only the local stage binding chooses the ingress, the peer outbound and the
//! fixed responder endpoint. A request never contains a destination URL,
//! address, tag or arbitrary test endpoint. The executor refuses to connect
//! when the local candidate cannot prove the isolation boundary, and returns
//! only the contract's closed outcome set.

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::Engine as _;
use chrono::{DateTime, Utc};
use serde_json::Map;
use tokio::net::TcpStream;
use tokio::time::timeout;

use super::contract::{
    LinkProbeOutcome, LinkProbeRequest, LinkProbeResult, MAX_LINK_PROBE_LATENCY_MS,
    ManagedGeneration, ProbeResponse, ProbeResponseUnsigned,
};
use super::http::{HttpError, MAX_PROBE_BODY_BYTES, PROBE_PATH, PROBE_TOKEN_HEADER, read_message};
use super::identity::{
    LinkCredential, ProbeIdentityError, request_token, source_link_credential,
    verify_response_token,
};
use super::isolation::{ProbeIngress, ProbeIsolationError};

const INGRESS_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const INGRESS_IO_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProbeTransportError {
    Timeout,
    ConnectFailed,
    AuthRejected,
    TlsFailed,
    ResponderMismatch,
    Protocol,
}

impl std::fmt::Display for ProbeTransportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Timeout => "probe exchange timed out",
            Self::ConnectFailed => "probe exchange could not connect",
            Self::AuthRejected => "probe exchange authentication was rejected",
            Self::TlsFailed => "probe exchange TLS failed",
            Self::ResponderMismatch => "probe responder did not match",
            Self::Protocol => "probe exchange protocol failed",
        })
    }
}

impl std::error::Error for ProbeTransportError {}

/// Narrow transport boundary. Destination and credentials are fixed at
/// construction, so an implementation cannot be asked to reach another
/// endpoint through this trait.
#[async_trait]
pub(crate) trait ProbeTransport: Send + Sync {
    async fn exchange(
        &self,
        request: &LinkProbeRequest,
    ) -> Result<ProbeResponse, ProbeTransportError>;
}

/// Local source binding the request must match before any network call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProbeExecutionContext {
    pub(crate) source_server_id: String,
    pub(crate) source_generation: ManagedGeneration,
    pub(crate) link_id: String,
    pub(crate) destination_server_id: String,
    pub(crate) credential_generation: u64,
}

impl ProbeExecutionContext {
    fn check_request(&self, request: &LinkProbeRequest) -> Result<(), LinkProbeOutcome> {
        if request.source.server_id != self.source_server_id
            || !self.source_generation.proves(&request.source)
        {
            return Err(LinkProbeOutcome::GenerationMismatch);
        }
        if request.destination.server_id != self.destination_server_id
            || request.link_id != self.link_id
            || request.credential_generation != self.credential_generation
        {
            return Err(LinkProbeOutcome::ResponderMismatch);
        }
        Ok(())
    }
}

pub(crate) struct ProbeExecutor {
    context: ProbeExecutionContext,
    transport: Box<dyn ProbeTransport>,
    isolation: Result<(), ProbeIsolationError>,
}

impl ProbeExecutor {
    #[must_use]
    pub(crate) fn new(
        context: ProbeExecutionContext,
        transport: Box<dyn ProbeTransport>,
        isolation: Result<(), ProbeIsolationError>,
    ) -> Self {
        Self {
            context,
            transport,
            isolation,
        }
    }

    pub(crate) async fn execute(
        &self,
        request: &LinkProbeRequest,
    ) -> Result<LinkProbeResult, ProbeExecutionError> {
        self.execute_at(request, Utc::now()).await
    }

    pub(crate) async fn execute_at(
        &self,
        request: &LinkProbeRequest,
        now: DateTime<Utc>,
    ) -> Result<LinkProbeResult, ProbeExecutionError> {
        request.validate()?;
        if request.is_expired(now) {
            return Ok(self.result(request, LinkProbeOutcome::Expired, None));
        }
        if let Err(outcome) = self.context.check_request(request) {
            return Ok(self.result(request, outcome, None));
        }
        if self.isolation.is_err() {
            return Ok(self.result(request, LinkProbeOutcome::IsolationUnavailable, None));
        }
        let budget = request.exchange_budget(now);
        if budget.is_zero() {
            return Ok(self.result(request, LinkProbeOutcome::Expired, None));
        }
        let started = Instant::now();
        let exchange = timeout(budget, self.transport.exchange(request)).await;
        let latency = Some(latency_ms(started.elapsed()));
        let response = match exchange {
            Err(_) => return Ok(self.result(request, LinkProbeOutcome::Timeout, latency)),
            Ok(Err(error)) => {
                return Ok(self.result(request, outcome_for_transport(error), latency));
            }
            Ok(Ok(response)) => response,
        };
        if response.probe_id != request.probe_id {
            return Ok(self.result(request, LinkProbeOutcome::ResponderMismatch, latency));
        }
        let outcome = match response.outcome {
            LinkProbeOutcome::Succeeded if response.destination.proves(request) => {
                LinkProbeOutcome::Succeeded
            }
            LinkProbeOutcome::Succeeded | LinkProbeOutcome::GenerationMismatch => {
                LinkProbeOutcome::GenerationMismatch
            }
            LinkProbeOutcome::Expired => LinkProbeOutcome::Expired,
            _ => LinkProbeOutcome::ResponderMismatch,
        };
        Ok(self.result(request, outcome, latency))
    }

    fn result(
        &self,
        request: &LinkProbeRequest,
        outcome: LinkProbeOutcome,
        latency_ms: Option<i64>,
    ) -> LinkProbeResult {
        LinkProbeResult {
            probe_id: request.probe_id.clone(),
            rollout_id: request.rollout_id.clone(),
            stage_ordinal: request.stage_ordinal,
            link_id: request.link_id.clone(),
            outcome,
            applied: self.context.source_generation.applied(),
            latency_ms,
            completed_at: Utc::now(),
        }
    }
}

fn latency_ms(elapsed: Duration) -> i64 {
    i64::try_from(elapsed.as_millis())
        .unwrap_or(i64::MAX)
        .min(MAX_LINK_PROBE_LATENCY_MS)
}

fn outcome_for_transport(error: ProbeTransportError) -> LinkProbeOutcome {
    match error {
        ProbeTransportError::Timeout => LinkProbeOutcome::Timeout,
        ProbeTransportError::ConnectFailed | ProbeTransportError::Protocol => {
            LinkProbeOutcome::ConnectFailed
        }
        ProbeTransportError::AuthRejected => LinkProbeOutcome::AuthRejected,
        ProbeTransportError::TlsFailed => LinkProbeOutcome::TlsFailed,
        ProbeTransportError::ResponderMismatch => LinkProbeOutcome::ResponderMismatch,
    }
}

/// Production transport: authenticated HTTP CONNECT through the fixed loopback
/// ingress, then the fixed inner probe request. It owns the source peer
/// credential and verifies the responder token before returning.
pub(crate) struct HttpConnectProbeTransport {
    ingress: SocketAddr,
    auth_user: String,
    auth_credential: LinkCredential,
    responder_endpoint: SocketAddr,
    peer_credential: LinkCredential,
}

impl HttpConnectProbeTransport {
    pub(crate) fn new(
        ingress: &ProbeIngress,
        peer_credential: LinkCredential,
    ) -> Result<Self, ProbeExecutionError> {
        if !ingress.listen.ip().is_loopback()
            || !ingress.responder_endpoint.ip().is_loopback()
            || ingress.listen == ingress.responder_endpoint
        {
            return Err(ProbeExecutionError::InvalidTransport(
                "probe transport endpoints are not distinct loopback addresses",
            ));
        }
        Ok(Self {
            ingress: ingress.listen,
            auth_user: ingress.auth_user.clone(),
            auth_credential: ingress.auth_credential.clone(),
            responder_endpoint: ingress.responder_endpoint,
            peer_credential,
        })
    }

    /// Derives the source credential from the exact committed peer outbound.
    pub(crate) fn from_committed_config(
        config: &Map<String, serde_json::Value>,
        ingress: &ProbeIngress,
    ) -> Result<Self, ProbeExecutionError> {
        let peer_credential = source_link_credential(config, &ingress.outbound_tag)?;
        Self::new(ingress, peer_credential)
    }

    async fn connect_ingress(&self) -> Result<TcpStream, ProbeTransportError> {
        timeout(INGRESS_CONNECT_TIMEOUT, TcpStream::connect(self.ingress))
            .await
            .map_err(|_| ProbeTransportError::Timeout)?
            .map_err(|_| ProbeTransportError::ConnectFailed)
    }

    async fn exchange_inner(
        &self,
        stream: &mut TcpStream,
        request: &LinkProbeRequest,
    ) -> Result<ProbeResponse, ProbeTransportError> {
        let token = request_token(request, &self.peer_credential);
        let body = serde_json::to_vec(request).map_err(|_| ProbeTransportError::Protocol)?;
        if body.len() > MAX_PROBE_BODY_BYTES {
            return Err(ProbeTransportError::Protocol);
        }
        let head = format!(
            "POST {PROBE_PATH} HTTP/1.1\r\nHost: blossom-agent-link-probe\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{PROBE_TOKEN_HEADER}: {token}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        timeout(INGRESS_IO_TIMEOUT, async {
            use tokio::io::AsyncWriteExt as _;
            stream.write_all(head.as_bytes()).await?;
            stream.write_all(&body).await?;
            stream.flush().await
        })
        .await
        .map_err(|_| ProbeTransportError::Timeout)?
        .map_err(|_| ProbeTransportError::ConnectFailed)?;

        let message = timeout(
            INGRESS_IO_TIMEOUT,
            read_message(stream, MAX_PROBE_BODY_BYTES, true),
        )
        .await
        .map_err(|_| ProbeTransportError::Timeout)?;
        let message = match message {
            Ok(message) => message,
            Err(HttpError::TooLarge | HttpError::UnsupportedTransferEncoding) => {
                return Err(ProbeTransportError::ResponderMismatch);
            }
            Err(_) => return Err(ProbeTransportError::Protocol),
        };
        match message.status_code() {
            Some(200) => {}
            Some(401 | 407) => return Err(ProbeTransportError::AuthRejected),
            Some(403 | 404) => return Err(ProbeTransportError::ResponderMismatch),
            _ => return Err(ProbeTransportError::ConnectFailed),
        }
        let response: ProbeResponse = serde_json::from_slice(&message.body)
            .map_err(|_| ProbeTransportError::ResponderMismatch)?;
        let unsigned = ProbeResponseUnsigned {
            probe_id: &response.probe_id,
            outcome: response.outcome,
            destination: &response.destination,
        };
        if !verify_response_token(
            request,
            &unsigned,
            &self.peer_credential,
            &response.response_token,
        ) {
            return Err(ProbeTransportError::ResponderMismatch);
        }
        Ok(response)
    }
}

#[async_trait]
impl ProbeTransport for HttpConnectProbeTransport {
    async fn exchange(
        &self,
        request: &LinkProbeRequest,
    ) -> Result<ProbeResponse, ProbeTransportError> {
        let mut stream = self.connect_ingress().await?;
        let target = format!(
            "{}:{}",
            self.responder_endpoint.ip(),
            self.responder_endpoint.port()
        );
        let basic = base64::engine::general_purpose::STANDARD.encode(format!(
            "{}:{}",
            self.auth_user,
            self.auth_credential.expose()
        ));
        let connect = format!(
            "CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Authorization: Basic {basic}\r\nProxy-Connection: keep-alive\r\n\r\n"
        );
        timeout(INGRESS_IO_TIMEOUT, async {
            use tokio::io::AsyncWriteExt as _;
            stream.write_all(connect.as_bytes()).await?;
            stream.flush().await
        })
        .await
        .map_err(|_| ProbeTransportError::Timeout)?
        .map_err(|_| ProbeTransportError::ConnectFailed)?;
        let proxy = timeout(INGRESS_IO_TIMEOUT, read_message(&mut stream, 0, false))
            .await
            .map_err(|_| ProbeTransportError::Timeout)?;
        let proxy = proxy.map_err(|_| ProbeTransportError::Protocol)?;
        match proxy.status_code() {
            Some(200) => {}
            Some(401 | 407) => return Err(ProbeTransportError::AuthRejected),
            _ => return Err(ProbeTransportError::ConnectFailed),
        }
        self.exchange_inner(&mut stream, request).await
    }
}

#[derive(Debug)]
pub(crate) enum ProbeExecutionError {
    Contract(super::contract::LinkProbeContractError),
    Identity(ProbeIdentityError),
    Isolation(ProbeIsolationError),
    InvalidTransport(&'static str),
}

impl std::fmt::Display for ProbeExecutionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Contract(error) => write!(formatter, "probe request is invalid: {error}"),
            Self::Identity(error) => write!(formatter, "probe identity is unavailable: {error}"),
            Self::Isolation(error) => write!(formatter, "probe isolation is unavailable: {error}"),
            Self::InvalidTransport(reason) => {
                write!(formatter, "invalid probe transport: {reason}")
            }
        }
    }
}

impl std::error::Error for ProbeExecutionError {}

impl From<super::contract::LinkProbeContractError> for ProbeExecutionError {
    fn from(error: super::contract::LinkProbeContractError) -> Self {
        Self::Contract(error)
    }
}

impl From<ProbeIdentityError> for ProbeExecutionError {
    fn from(error: ProbeIdentityError) -> Self {
        Self::Identity(error)
    }
}

impl From<ProbeIsolationError> for ProbeExecutionError {
    fn from(error: ProbeIsolationError) -> Self {
        Self::Isolation(error)
    }
}

trait DestinationProof {
    fn proves(&self, request: &LinkProbeRequest) -> bool;
}

impl DestinationProof for super::contract::ManagedApplied {
    fn proves(&self, request: &LinkProbeRequest) -> bool {
        self.desired_revision_seq >= request.destination.min_revision_seq
            && self.managed_fingerprint.as_deref()
                == Some(request.destination.managed_fingerprint.as_str())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde_json::json;

    use super::*;
    use crate::probe::contract::{LinkProbeEndpoint, ManagedApplied};

    fn request() -> LinkProbeRequest {
        let endpoint = |server: &str, hex: &str, seq: u64| LinkProbeEndpoint {
            server_id: server.to_string(),
            managed_fingerprint: format!("sha256:{hex}"),
            min_revision_seq: seq,
        };
        serde_json::from_value(json!({
            "probeId": "probe-1",
            "rolloutId": "rollout-1",
            "stageOrdinal": 2,
            "linkId": "link-1",
            "credentialGeneration": 1,
            "source": endpoint("srv-a", &"a".repeat(64), 2),
            "destination": endpoint("srv-b", &"b".repeat(64), 4),
            "issuedAt": "2026-11-20T00:00:00.000Z",
            "expiresAt": "2026-11-20T00:01:00.000Z"
        }))
        .unwrap()
    }

    fn context() -> ProbeExecutionContext {
        ProbeExecutionContext {
            source_server_id: "srv-a".to_string(),
            source_generation: ManagedGeneration {
                desired_revision_seq: 5,
                managed_fingerprint: Some(format!("sha256:{}", "a".repeat(64))),
            },
            link_id: "link-1".to_string(),
            destination_server_id: "srv-b".to_string(),
            credential_generation: 1,
        }
    }

    struct FakeTransport {
        calls: AtomicUsize,
        result: Result<ProbeResponse, ProbeTransportError>,
    }

    #[async_trait]
    impl ProbeTransport for FakeTransport {
        async fn exchange(
            &self,
            _request: &LinkProbeRequest,
        ) -> Result<ProbeResponse, ProbeTransportError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.result.clone()
        }
    }

    fn response(outcome: LinkProbeOutcome, destination: ManagedApplied) -> ProbeResponse {
        ProbeResponse {
            probe_id: "probe-1".to_string(),
            outcome,
            destination,
            response_token: "0".repeat(64),
        }
    }

    fn executor_with(
        result: Result<ProbeResponse, ProbeTransportError>,
    ) -> (ProbeExecutor, Arc<FakeTransport>) {
        let transport = Arc::new(FakeTransport {
            calls: AtomicUsize::new(0),
            result,
        });
        let executor = ProbeExecutor::new(
            context(),
            Box::new(TransportHandle(transport.clone())),
            Ok(()),
        );
        (executor, transport)
    }

    struct TransportHandle(Arc<FakeTransport>);

    #[async_trait]
    impl ProbeTransport for TransportHandle {
        async fn exchange(
            &self,
            request: &LinkProbeRequest,
        ) -> Result<ProbeResponse, ProbeTransportError> {
            self.0.exchange(request).await
        }
    }

    #[tokio::test]
    async fn maps_closed_outcomes_without_contacting_the_transport_on_refusal() {
        let now = "2026-11-20T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let (executor, transport) = executor_with(Ok(response(
            LinkProbeOutcome::Succeeded,
            ManagedApplied {
                desired_revision_seq: 6,
                managed_fingerprint: Some(format!("sha256:{}", "b".repeat(64))),
            },
        )));
        let success = executor.execute_at(&request(), now).await.unwrap();
        assert_eq!(success.outcome, LinkProbeOutcome::Succeeded);
        assert!(success.latency_ms.is_some());
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);

        let mut stale = request();
        stale.source.min_revision_seq = 9;
        let result = executor.execute_at(&stale, now).await.unwrap();
        assert_eq!(result.outcome, LinkProbeOutcome::GenerationMismatch);
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);

        let mut wrong_link = request();
        wrong_link.link_id = "link-2".to_string();
        let result = executor.execute_at(&wrong_link, now).await.unwrap();
        assert_eq!(result.outcome, LinkProbeOutcome::ResponderMismatch);
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);

        let mut expired = request();
        expired.issued_at = now - chrono::Duration::seconds(60);
        expired.expires_at = now - chrono::Duration::milliseconds(1);
        let result = executor.execute_at(&expired, now).await.unwrap();
        assert_eq!(result.outcome, LinkProbeOutcome::Expired);

        let (executor, transport) = {
            let (_executor, transport) = executor_with(Ok(response(
                LinkProbeOutcome::Succeeded,
                ManagedApplied {
                    desired_revision_seq: 6,
                    managed_fingerprint: Some(format!("sha256:{}", "b".repeat(64))),
                },
            )));
            (
                ProbeExecutor::new(
                    context(),
                    Box::new(TransportHandle(transport.clone())),
                    Err(ProbeIsolationError::UnblockedLoopback(
                        "node-n1".to_string(),
                    )),
                ),
                transport,
            )
        };
        let result = executor.execute_at(&request(), now).await.unwrap();
        assert_eq!(result.outcome, LinkProbeOutcome::IsolationUnavailable);
        assert_eq!(transport.calls.load(Ordering::SeqCst), 0);
    }

    struct ChildGuard(std::process::Child);

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    struct RuntimeDir(std::path::PathBuf);

    impl RuntimeDir {
        fn new() -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "blossom-probe-runtime-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for RuntimeDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn free_port() -> u16 {
        std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    async fn wait_for_listener(port: u16, child: &mut std::process::Child) {
        for _ in 0..200 {
            if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
                return;
            }
            assert!(
                child.try_wait().unwrap().is_none(),
                "sing-box exited before binding loopback port {port}"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("sing-box did not bind loopback port {port}");
    }

    #[tokio::test]
    async fn pinned_sing_box_carries_one_authenticated_probe_end_to_end() {
        let Ok(bin) = std::env::var("SING_BOX_BIN") else {
            return;
        };
        use crate::probe::identity::{LinkCredential, PeerLinkIdentity, peer_inbound_credential};
        use crate::probe::isolation::{
            ProbeIngress, ProbeIsolationExpectation, ProbeResponderRoute, install_probe_candidate,
            validate_candidate,
        };
        use crate::probe::responder::{ProbeResponder, ProbeResponderBinding};

        let dir = RuntimeDir::new();
        let certified =
            rcgen::generate_simple_self_signed(vec!["peer-b.internal.example.com".to_string()])
                .unwrap();
        let cert_path = dir.0.join("peer-b.pem");
        let key_path = dir.0.join("peer-b.key");
        std::fs::write(&cert_path, certified.cert.pem()).unwrap();
        std::fs::write(&key_path, certified.signing_key.serialize_pem()).unwrap();

        let ingress_port = free_port();
        let source_stats_port = free_port();
        let peer_port = free_port();
        let destination_stats_port = free_port();
        let responder_port = free_port();
        let node_port = free_port();
        let link = PeerLinkIdentity::new("link-1", 1).unwrap();
        let ingress_credential = LinkCredential::new("local-ingress-credential").unwrap();
        let peer_credential = LinkCredential::new("peer-link-credential").unwrap();
        let ingress = ProbeIngress::new(
            format!("127.0.0.1:{ingress_port}").parse().unwrap(),
            "probe-local",
            ingress_credential,
            "peer-out-pout1",
            format!("127.0.0.1:{responder_port}").parse().unwrap(),
        )
        .unwrap();
        let responder_route = ProbeResponderRoute::new(
            "peer-in-pin1",
            link.clone(),
            format!("127.0.0.1:{responder_port}").parse().unwrap(),
        )
        .unwrap();

        let mut source = serde_json::json!({
            "log": {"level": "warn", "timestamp": true},
            "dns": {"servers": [{"type": "local", "tag": "local-dns"}], "final": "local-dns"},
            "services": [{
                "type": "api",
                "listen": "127.0.0.1",
                "listen_port": source_stats_port,
                "secret": "source-stats-secret"
            }],
            "inbounds": [{
                "type": "vless",
                "tag": "node-n1",
                "listen": "127.0.0.1",
                "listen_port": node_port,
                "users": [{"name": "sub-user", "uuid": "00000000-0000-0000-0000-000000000001"}]
            }],
            "outbounds": [
                {"type": "direct", "tag": "direct"},
                {
                    "type": "trojan",
                    "tag": "peer-out-pout1",
                    "server": "127.0.0.1",
                    "server_port": peer_port,
                    "password": peer_credential.expose(),
                    "tls": {
                        "enabled": true,
                        "server_name": "peer-b.internal.example.com",
                        "certificate_path": cert_path.to_string_lossy()
                    }
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
        .clone();
        install_probe_candidate(
            &mut source,
            crate::probe::isolation::ProbeCandidatePlan {
                ingress: Some(&ingress),
                responder: None,
                stats_endpoint: format!("127.0.0.1:{source_stats_port}").parse().unwrap(),
            },
        )
        .unwrap();
        let source_expectation = ProbeIsolationExpectation::new(
            Some(ingress.clone()),
            None,
            format!("127.0.0.1:{source_stats_port}").parse().unwrap(),
        )
        .unwrap();
        validate_candidate(&source, &source_expectation).unwrap();

        let mut destination = serde_json::json!({
            "log": {"level": "warn", "timestamp": true},
            "dns": {"servers": [{"type": "local", "tag": "local-dns"}], "final": "local-dns"},
            "services": [{
                "type": "api",
                "listen": "127.0.0.1",
                "listen_port": destination_stats_port,
                "secret": "destination-stats-secret"
            }],
            "inbounds": [{
                "type": "trojan",
                "tag": "peer-in-pin1",
                "listen": "127.0.0.1",
                "listen_port": peer_port,
                "users": [{"name": link.user_name(), "password": peer_credential.expose()}],
                "tls": {
                    "enabled": true,
                    "server_name": "peer-b.internal.example.com",
                    "certificate_path": cert_path.to_string_lossy(),
                    "key_path": key_path.to_string_lossy()
                }
            }],
            "outbounds": [{"type": "direct", "tag": "direct"}],
            "route": {
                "default_domain_resolver": "local-dns",
                "rules": [],
                "final": "direct"
            }
        })
        .as_object()
        .unwrap()
        .clone();
        install_probe_candidate(
            &mut destination,
            crate::probe::isolation::ProbeCandidatePlan {
                ingress: None,
                responder: Some(&responder_route),
                stats_endpoint: format!("127.0.0.1:{destination_stats_port}")
                    .parse()
                    .unwrap(),
            },
        )
        .unwrap();
        let destination_expectation = ProbeIsolationExpectation::new(
            None,
            Some(responder_route.clone()),
            format!("127.0.0.1:{destination_stats_port}")
                .parse()
                .unwrap(),
        )
        .unwrap();
        validate_candidate(&destination, &destination_expectation).unwrap();

        let source_committed = ManagedGeneration {
            desired_revision_seq: 5,
            managed_fingerprint: Some(format!("sha256:{}", "a".repeat(64))),
        };
        let destination_committed = ManagedGeneration {
            desired_revision_seq: 5,
            managed_fingerprint: Some(format!("sha256:{}", "b".repeat(64))),
        };

        let responder = ProbeResponder::start(
            ProbeResponderBinding::from_committed_config(
                &destination,
                format!("127.0.0.1:{responder_port}").parse().unwrap(),
                "srv-b",
                "peer-in-pin1",
                link.clone(),
                destination_committed.clone(),
            )
            .unwrap(),
        )
        .await
        .unwrap();

        let source_path = dir.0.join("source.json");
        let destination_path = dir.0.join("destination.json");
        std::fs::write(&source_path, serde_json::to_vec_pretty(&source).unwrap()).unwrap();
        std::fs::write(
            &destination_path,
            serde_json::to_vec_pretty(&destination).unwrap(),
        )
        .unwrap();
        let mut destination_child = std::process::Command::new(&bin)
            .args(["run", "-c"])
            .arg(&destination_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("pinned sing-box destination runs");
        wait_for_listener(peer_port, &mut destination_child).await;
        let destination_guard = ChildGuard(destination_child);
        let mut source_child = std::process::Command::new(&bin)
            .args(["run", "-c"])
            .arg(&source_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("pinned sing-box source runs");
        wait_for_listener(ingress_port, &mut source_child).await;
        let source_guard = ChildGuard(source_child);

        let transport = HttpConnectProbeTransport::new(&ingress, peer_credential).unwrap();
        let executor = ProbeExecutor::new(
            ProbeExecutionContext {
                source_server_id: "srv-a".to_string(),
                source_generation: source_committed,
                link_id: "link-1".to_string(),
                destination_server_id: "srv-b".to_string(),
                credential_generation: 1,
            },
            Box::new(transport),
            Ok(()),
        );
        let now = Utc::now();
        let mut request = request();
        request.issued_at = now;
        request.expires_at = now + chrono::Duration::seconds(10);
        request.source.min_revision_seq = 5;
        request.destination.min_revision_seq = 5;
        request.source.managed_fingerprint = format!("sha256:{}", "a".repeat(64));
        request.destination.managed_fingerprint = format!("sha256:{}", "b".repeat(64));
        let result = executor.execute_at(&request, now).await.unwrap();
        assert_eq!(result.outcome, LinkProbeOutcome::Succeeded);
        assert!(result.latency_ms.is_some());

        // The probe ingress must not tunnel the agent stats endpoint even with
        // valid local proxy credentials.
        let mut stream = TcpStream::connect(("127.0.0.1", ingress_port))
            .await
            .unwrap();
        let basic = base64::engine::general_purpose::STANDARD
            .encode(format!("probe-local:{}", "local-ingress-credential"));
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        stream
            .write_all(
                format!(
                    "CONNECT 127.0.0.1:{source_stats_port} HTTP/1.1\r\nHost: 127.0.0.1:{source_stats_port}\r\nProxy-Authorization: Basic {basic}\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut response = Vec::new();
        let _ = stream.read(&mut response).await;
        let response = String::from_utf8_lossy(&response);
        let accepted = response
            .lines()
            .next()
            .is_some_and(|line| line.starts_with("HTTP/1.1 200"));
        assert!(
            !accepted,
            "probe ingress tunnelled the stats endpoint: {response}"
        );

        let responder = responder;
        responder.finish();
        drop(source_guard);
        drop(destination_guard);
    }

    #[tokio::test]
    async fn destination_generation_and_token_bearing_response_are_not_trusted_blindly() {
        let now = "2026-11-20T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let (executor, transport) = executor_with(Ok(response(
            LinkProbeOutcome::Succeeded,
            ManagedApplied {
                desired_revision_seq: 3,
                managed_fingerprint: Some(format!("sha256:{}", "b".repeat(64))),
            },
        )));
        let result = executor.execute_at(&request(), now).await.unwrap();
        assert_eq!(result.outcome, LinkProbeOutcome::GenerationMismatch);

        let (executor, _) = executor_with(Err(ProbeTransportError::AuthRejected));
        let result = executor.execute_at(&request(), now).await.unwrap();
        assert_eq!(result.outcome, LinkProbeOutcome::AuthRejected);

        let (executor, _) = executor_with(Err(ProbeTransportError::Timeout));
        let result = executor.execute_at(&request(), now).await.unwrap();
        assert_eq!(result.outcome, LinkProbeOutcome::Timeout);
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
    }
}
