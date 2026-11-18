//! Agent-executed ACME issuance.
//!
//! The control plane sends one fenced job over the authenticated WebSocket.
//! The agent executes the CA order locally, brokers DNS-01 material through
//! the control plane when configured, and returns the PEM material once.
//! Results are replayable only for the same job id and are bounded by the
//! manager's in-memory expiry.

pub mod instant_backend;
pub mod ports;
pub mod solver_dns01;
pub mod solver_http01;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::json;
use tokio::sync::{Mutex, Semaphore};
use tokio::task::JoinHandle;
use tracing::warn;

use crate::ws::codec::{AcmeIssuePayload, AgentWsFrame, frame_type};
use crate::ws::ports::{AgentCommandSink, WsCommand};

use self::ports::{
    AcmeBackend, AcmeChallengeType, AcmeError, AcmeProvider, ChallengeSolver, DnsBroker,
    ExternalAccountBinding, IssueRequest, IssuedMaterial, MAX_CONCURRENT_JOBS, MAX_DNS_NAME_LEN,
    MAX_DOMAINS, SecretString,
};
use self::solver_dns01::{Dns01Solver, DnsAck, WsDnsBroker};
use self::solver_http01::Http01Solver;

const MAX_TRACKED_JOBS: usize = 32;

struct RuntimeChallengeSolver {
    http_bind: SocketAddr,
    http: Mutex<Option<Arc<Http01Solver>>>,
    dns: Dns01Solver,
}

impl RuntimeChallengeSolver {
    fn new(http_bind: SocketAddr, dns_broker: Arc<dyn DnsBroker>) -> Self {
        Self {
            http_bind,
            http: Mutex::new(None),
            dns: Dns01Solver::new(dns_broker),
        }
    }
}

#[async_trait]
impl ChallengeSolver for RuntimeChallengeSolver {
    async fn serve_http(&self, token: &str, key_authorization: &str) -> Result<(), AcmeError> {
        let (server, should_start) = {
            let mut http = self.http.lock().await;
            match http.as_ref() {
                Some(server) => (server.clone(), false),
                None => {
                    let server = Arc::new(Http01Solver::start(self.http_bind).await?);
                    *http = Some(server.clone());
                    (server, true)
                }
            }
        };
        if should_start {
            tracing::debug!(
                address = %server.local_addr(),
                "HTTP-01 challenge responder started"
            );
        }
        server.serve(token, key_authorization).await
    }

    async fn present_dns(&self, job_id: &str, record: &ports::DnsRecord) -> Result<(), AcmeError> {
        self.dns.present(job_id, record.clone()).await
    }

    async fn cleanup_dns(&self, job_id: &str) {
        self.dns.cleanup_all(job_id).await;
    }

    async fn finish(&self) {
        let server = self.http.lock().await.take();
        if let Some(server) = server {
            server.finish().await;
        }
    }
}

enum JobOutcome {
    Issued(IssuedMaterial),
    Failed(AcmeError),
}

struct TrackedJob {
    expires_at: Instant,
    outcome: Option<JobOutcome>,
}

/// Owns bounded in-flight jobs and replays a completed result for the same
/// job id until its short in-memory expiry. A late result from an old job can
/// never be applied by the control plane because the job id is its fence.
pub struct AcmeManager {
    backend: Arc<dyn AcmeBackend>,
    http_bind: SocketAddr,
    dns_broker: Arc<WsDnsBroker>,
    sink: Arc<dyn AgentCommandSink>,
    jobs: Arc<Mutex<HashMap<String, TrackedJob>>>,
    permits: Arc<Semaphore>,
    job_timeout: Duration,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl AcmeManager {
    pub fn new(
        backend: Arc<dyn AcmeBackend>,
        http_bind: SocketAddr,
        sink: Arc<dyn AgentCommandSink>,
        job_timeout: Duration,
        settle: Duration,
    ) -> Self {
        let dns_broker = Arc::new(WsDnsBroker::with_defaults(sink.clone(), settle));
        Self {
            backend,
            http_bind,
            dns_broker,
            sink,
            jobs: Arc::new(Mutex::new(HashMap::new())),
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT_JOBS)),
            job_timeout,
            tasks: Mutex::new(Vec::new()),
        }
    }

    pub async fn handle_issue(&self, payload: AcmeIssuePayload) -> Result<(), AcmeError> {
        let request = validate_issue(payload)?;
        let job_id = request.job_id.clone();

        {
            let mut jobs = self.jobs.lock().await;
            prune_expired(&mut jobs);
            if let Some(existing) = jobs.get(&job_id) {
                match &existing.outcome {
                    Some(outcome) => {
                        send_outcome(self.sink.as_ref(), &job_id, outcome);
                    }
                    None => {
                        tracing::debug!(job_id = %job_id, "duplicate ACME job is already running");
                    }
                }
                return Ok(());
            }
            if jobs.len() >= MAX_TRACKED_JOBS {
                return Err(AcmeError::internal(
                    "ACME job tracker is at its bounded capacity",
                ));
            }
        }

        let Ok(permit) = self.permits.clone().try_acquire_owned() else {
            warn!(job_id = %job_id, "ACME job queue is full; leaving the job queued for retry");
            return Ok(());
        };

        {
            let mut jobs = self.jobs.lock().await;
            prune_expired(&mut jobs);
            if jobs.contains_key(&job_id) {
                drop(permit);
                return Ok(());
            }
            if jobs.len() >= MAX_TRACKED_JOBS {
                drop(permit);
                return Err(AcmeError::internal(
                    "ACME job tracker is at its bounded capacity",
                ));
            }
            jobs.insert(
                job_id.clone(),
                TrackedJob {
                    expires_at: Instant::now() + self.job_timeout + Duration::from_secs(60),
                    outcome: None,
                },
            );
        }

        let backend = self.backend.clone();
        let dns_broker = self.dns_broker.clone();
        let sink = self.sink.clone();
        let tracker = self.jobs.clone();
        let http_bind = self.http_bind;
        let job_timeout = self.job_timeout;
        let task = tokio::spawn(async move {
            let solver = RuntimeChallengeSolver::new(http_bind, dns_broker.clone());
            let outcome =
                match tokio::time::timeout(job_timeout, backend.issue(&request, &solver)).await {
                    Ok(Ok(material)) => JobOutcome::Issued(material),
                    Ok(Err(error)) => JobOutcome::Failed(error),
                    Err(_) => JobOutcome::Failed(AcmeError::timeout(
                        "ACME job exceeded its execution deadline",
                    )),
                };
            solver.finish().await;
            dns_broker.cancel_job(&job_id).await;
            if let Some(tracked) = tracker.lock().await.get_mut(&job_id) {
                send_outcome(sink.as_ref(), &job_id, &outcome);
                tracked.outcome = Some(outcome);
            }
            drop(permit);
        });
        self.tasks.lock().await.push(task);
        Ok(())
    }

    pub async fn handle_dns_ack(&self, ack: DnsAck) {
        self.dns_broker.handle_ack(ack).await;
    }

    pub async fn shutdown(&self) {
        let tasks = std::mem::take(&mut *self.tasks.lock().await);
        for task in tasks {
            task.abort();
        }
    }
}

fn prune_expired(jobs: &mut HashMap<String, TrackedJob>) {
    let now = Instant::now();
    jobs.retain(|_, job| job.expires_at > now);
}

fn send_outcome(sink: &dyn AgentCommandSink, job_id: &str, outcome: &JobOutcome) {
    let payload = match outcome {
        JobOutcome::Issued(material) => json!({
            "jobId": job_id,
            "certificatePem": material.certificate_pem.expose(),
            "privateKeyPem": material.private_key_pem.expose(),
        }),
        JobOutcome::Failed(error) => json!({
            "jobId": job_id,
            "error": error.message,
            "errorPhase": error.phase.as_str(),
        }),
    };
    match AgentWsFrame::new(frame_type::ACME_RESULT, payload) {
        Ok(frame) => {
            if let Err(error) = sink.enqueue(WsCommand::Send(frame)) {
                warn!(job_id = %job_id, error = %error.describe(), "failed to enqueue ACME result");
            }
        }
        Err(error) => {
            warn!(job_id = %job_id, "failed to encode ACME result: {error}");
        }
    }
}

fn validate_issue(payload: AcmeIssuePayload) -> Result<IssueRequest, AcmeError> {
    if payload.job_id.is_empty() || payload.job_id.len() > 128 {
        return Err(AcmeError::configuration("invalid ACME job id"));
    }
    if payload.certificate_id.is_empty() || payload.certificate_id.len() > 128 {
        return Err(AcmeError::configuration("invalid certificate id"));
    }
    if payload.generation == 0 {
        return Err(AcmeError::configuration(
            "certificate generation must be positive",
        ));
    }
    if payload.domains.is_empty() || payload.domains.len() > MAX_DOMAINS {
        return Err(AcmeError::configuration(
            "ACME domain count is outside the allowed bounds",
        ));
    }
    let mut unique = std::collections::HashSet::new();
    for domain in &payload.domains {
        if !valid_domain(domain) {
            return Err(AcmeError::configuration(
                "ACME job contains an invalid DNS name",
            ));
        }
        if !unique.insert(domain.clone()) {
            return Err(AcmeError::configuration(
                "ACME job contains duplicate DNS names",
            ));
        }
    }

    let acme_provider: AcmeProvider = payload.acme_provider.parse()?;
    let challenge_type: AcmeChallengeType = payload.challenge_type.parse()?;
    if acme_provider == AcmeProvider::ZeroSsl && payload.external_account_binding.is_none() {
        return Err(AcmeError::configuration(
            "ZeroSSL issuance requires external account binding",
        ));
    }
    if acme_provider == AcmeProvider::LetsEncrypt && payload.external_account_binding.is_some() {
        return Err(AcmeError::configuration(
            "Let's Encrypt does not use external account binding",
        ));
    }
    let external_account_binding =
        payload
            .external_account_binding
            .map(|binding| ExternalAccountBinding {
                kid: binding.kid,
                hmac_key: SecretString::new(binding.hmac_key),
            });

    Ok(IssueRequest {
        job_id: payload.job_id,
        certificate_id: payload.certificate_id,
        generation: payload.generation,
        domains: payload.domains,
        acme_email: payload.acme_email,
        acme_provider,
        acme_staging: payload.acme_staging,
        challenge_type,
        external_account_binding,
    })
}

fn valid_domain(domain: &str) -> bool {
    if domain.is_empty()
        || domain.len() > MAX_DNS_NAME_LEN
        || domain.to_ascii_lowercase() != domain
        || domain.ends_with('.')
    {
        return false;
    }
    let without_wildcard = domain.strip_prefix("*.").unwrap_or(domain);
    if without_wildcard.is_empty() || without_wildcard.contains('*') {
        return false;
    }
    without_wildcard.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;
    use std::sync::Arc;
    use std::time::Duration;

    use crate::acme::ports::{
        AcmeBackend, AcmeChallengeType, AcmeError, ChallengeSolver, IssueRequest, IssuedMaterial,
        SecretString,
    };
    use crate::acme::solver_dns01::DnsAck;
    use crate::ws::codec::{AcmeIssuePayload, AgentWsFrame};
    use crate::ws::ports::{WsCommand, command_channel};
    use async_trait::async_trait;

    use super::{AcmeManager, valid_domain};

    struct FakeBackend;

    #[async_trait]
    impl AcmeBackend for FakeBackend {
        async fn issue(
            &self,
            request: &IssueRequest,
            solver: &dyn ChallengeSolver,
        ) -> Result<IssuedMaterial, AcmeError> {
            assert_eq!(request.challenge_type, AcmeChallengeType::Dns01);
            solver
                .present_dns(
                    &request.job_id,
                    &crate::acme::ports::DnsRecord {
                        fqdn: "_acme-challenge.example.com".into(),
                        value: SecretString::new("digest"),
                    },
                )
                .await?;
            Ok(IssuedMaterial {
                certificate_pem: SecretString::new("test-cert"),
                private_key_pem: SecretString::new("test-key"),
            })
        }
    }

    fn issue() -> AcmeIssuePayload {
        AcmeIssuePayload {
            job_id: "job-1".into(),
            certificate_id: "cert-1".into(),
            generation: 1,
            domains: vec!["example.com".into()],
            acme_email: None,
            acme_provider: "letsencrypt".into(),
            acme_staging: true,
            challenge_type: "dns-01".into(),
            external_account_binding: None,
        }
    }

    fn frame(command: WsCommand) -> AgentWsFrame {
        match command {
            WsCommand::Send(frame) => frame,
            WsCommand::Close => panic!("unexpected close"),
        }
    }

    #[tokio::test]
    async fn manager_brokers_dns_and_replays_the_fenced_result() {
        let (sink, mut commands) = command_channel(16);
        let sink: Arc<dyn crate::ws::ports::AgentCommandSink> = Arc::new(sink);
        let manager = Arc::new(AcmeManager::new(
            Arc::new(FakeBackend),
            "127.0.0.1:0".parse::<SocketAddr>().unwrap(),
            sink,
            Duration::from_secs(5),
            Duration::ZERO,
        ));
        manager.handle_issue(issue()).await.unwrap();

        let present = frame(commands.recv().await.unwrap());
        assert_eq!(present.msg_type, "acme.dns_present");
        manager
            .handle_dns_ack(DnsAck {
                job_id: "job-1".into(),
                fqdn: "_acme-challenge.example.com".into(),
                txt_value: "digest".into(),
                accepted: true,
                error: None,
            })
            .await;

        let result = frame(commands.recv().await.unwrap());
        assert_eq!(result.msg_type, "acme.result");
        assert_eq!(result.payload["jobId"], "job-1");
        assert_eq!(result.payload["certificatePem"], "test-cert");

        manager.handle_issue(issue()).await.unwrap();
        let replay = frame(commands.recv().await.unwrap());
        assert_eq!(replay.msg_type, "acme.result");
        assert_eq!(replay.payload["privateKeyPem"], "test-key");
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_rejects_out_of_bounds_jobs_before_spawning() {
        let (sink, _commands) = command_channel(1);
        let sink: Arc<dyn crate::ws::ports::AgentCommandSink> = Arc::new(sink);
        let manager = AcmeManager::new(
            Arc::new(FakeBackend),
            "127.0.0.1:0".parse().unwrap(),
            sink,
            Duration::from_secs(5),
            Duration::ZERO,
        );
        let mut payload = issue();
        payload.domains = vec!["EXAMPLE.com".into()];
        assert!(manager.handle_issue(payload).await.is_err());
        let mut payload = issue();
        payload.domains = (0..101)
            .map(|index| format!("d{index}.example.com"))
            .collect();
        assert!(manager.handle_issue(payload).await.is_err());
    }

    #[test]
    fn domain_validation_only_accepts_bounded_dns_names() {
        assert!(valid_domain("example.com"));
        assert!(valid_domain("*.example.com"));
        assert!(!valid_domain("Example.com"));
        assert!(!valid_domain("example.com."));
        assert!(!valid_domain("../example.com"));
    }
}
