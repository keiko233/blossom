//! Consumer-owned ports and bounded domain types for agent-executed ACME.

use std::fmt;
use std::time::Duration;

use async_trait::async_trait;
use zeroize::{Zeroize, ZeroizeOnDrop};

pub const MAX_DOMAINS: usize = 100;
pub const MAX_DNS_NAME_LEN: usize = 253;
pub const MAX_CHALLENGE_VALUE_LEN: usize = 512;
pub const MAX_CONCURRENT_JOBS: usize = 2;
pub const DEFAULT_CHALLENGE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// A secret string with redacted `Debug` and best-effort zeroization on drop.
#[derive(Clone)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted>")
    }
}

impl PartialEq for SecretString {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}

impl Eq for SecretString {}

impl Drop for SecretString {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl ZeroizeOnDrop for SecretString {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcmeChallengeType {
    Dns01,
    Http01,
}

impl std::str::FromStr for AcmeChallengeType {
    type Err = AcmeError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "dns-01" => Ok(Self::Dns01),
            "http-01" => Ok(Self::Http01),
            other => Err(AcmeError::configuration(format!(
                "unsupported challenge type {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcmeProvider {
    LetsEncrypt,
    ZeroSsl,
}

impl AcmeProvider {
    pub fn directory_url(self, staging: bool) -> &'static str {
        match self {
            Self::LetsEncrypt if staging => {
                "https://acme-staging-v02.api.letsencrypt.org/directory"
            }
            Self::LetsEncrypt => "https://acme-v02.api.letsencrypt.org/directory",
            Self::ZeroSsl => "https://acme.zerossl.com/v2/DV90",
        }
    }
}

impl std::str::FromStr for AcmeProvider {
    type Err = AcmeError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "letsencrypt" => Ok(Self::LetsEncrypt),
            "zerossl" => Ok(Self::ZeroSsl),
            other => Err(AcmeError::configuration(format!(
                "unsupported ACME provider {other}"
            ))),
        }
    }
}

#[derive(Clone)]
pub struct ExternalAccountBinding {
    pub kid: String,
    pub hmac_key: SecretString,
}

impl fmt::Debug for ExternalAccountBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExternalAccountBinding")
            .field("kid", &self.kid)
            .field("hmac_key", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Clone)]
pub struct IssueRequest {
    pub job_id: String,
    pub certificate_id: String,
    pub generation: u64,
    pub domains: Vec<String>,
    pub acme_email: Option<String>,
    pub acme_provider: AcmeProvider,
    pub acme_staging: bool,
    pub challenge_type: AcmeChallengeType,
    pub external_account_binding: Option<ExternalAccountBinding>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct DnsRecord {
    pub fqdn: String,
    pub value: SecretString,
}

impl fmt::Debug for DnsRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DnsRecord")
            .field("fqdn", &self.fqdn)
            .field("value", &"<redacted>")
            .finish()
    }
}

pub struct IssuedMaterial {
    pub certificate_pem: SecretString,
    pub private_key_pem: SecretString,
}

impl fmt::Debug for IssuedMaterial {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IssuedMaterial")
            .field("certificate_pem", &"<redacted>")
            .field("private_key_pem", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcmeErrorPhase {
    Configuration,
    Account,
    Order,
    Challenge,
    Validation,
    Finalize,
    Certificate,
    DnsBroker,
    Timeout,
    Internal,
}

impl AcmeErrorPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Configuration => "configuration",
            Self::Account => "account",
            Self::Order => "order",
            Self::Challenge => "challenge",
            Self::Validation => "validation",
            Self::Finalize => "finalize",
            Self::Certificate => "certificate",
            Self::DnsBroker => "dns_broker",
            Self::Timeout => "timeout",
            Self::Internal => "internal",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcmeError {
    pub phase: AcmeErrorPhase,
    pub message: String,
}

impl AcmeError {
    pub fn new(phase: AcmeErrorPhase, message: impl Into<String>) -> Self {
        Self {
            phase,
            message: sanitize_error(&message.into()),
        }
    }

    pub fn configuration(message: impl Into<String>) -> Self {
        Self::new(AcmeErrorPhase::Configuration, message)
    }

    pub fn challenge(message: impl Into<String>) -> Self {
        Self::new(AcmeErrorPhase::Challenge, message)
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(AcmeErrorPhase::Validation, message)
    }

    pub fn dns(message: impl Into<String>) -> Self {
        Self::new(AcmeErrorPhase::DnsBroker, message)
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(AcmeErrorPhase::Timeout, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(AcmeErrorPhase::Internal, message)
    }
}

impl fmt::Display for AcmeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.phase.as_str(), self.message)
    }
}

impl std::error::Error for AcmeError {}

/// The control plane must never persist a private key copied into an error.
pub fn sanitize_error(message: &str) -> String {
    let mut sanitized = String::with_capacity(message.len().min(16_384));
    let mut in_pem = false;
    for line in message.lines() {
        if line.contains("-----BEGIN ") {
            in_pem = true;
            continue;
        }
        if in_pem {
            if line.contains("-----END ") {
                in_pem = false;
            }
            continue;
        }
        if !sanitized.is_empty() {
            sanitized.push('\n');
        }
        sanitized.push_str(line);
        if sanitized.len() >= 16_384 {
            break;
        }
    }
    sanitized.trim().chars().take(16_384).collect()
}

#[async_trait]
pub trait DnsBroker: Send + Sync {
    async fn present(&self, job_id: &str, record: &DnsRecord) -> Result<(), AcmeError>;
    async fn cleanup(&self, job_id: &str, record: &DnsRecord) -> Result<(), AcmeError>;
}

#[async_trait]
pub trait ChallengeSolver: Send + Sync {
    async fn serve_http(&self, token: &str, key_authorization: &str) -> Result<(), AcmeError>;
    async fn present_dns(&self, job_id: &str, record: &DnsRecord) -> Result<(), AcmeError>;
    async fn cleanup_dns(&self, job_id: &str);
    async fn finish(&self);
}

#[async_trait]
pub trait AcmeBackend: Send + Sync {
    async fn issue(
        &self,
        request: &IssueRequest,
        solver: &dyn ChallengeSolver,
    ) -> Result<IssuedMaterial, AcmeError>;
}

/// Explicit lifecycle for one ACME order. The real adapter follows the same
/// phases; tests use it to prove invalid transitions fail closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobPhase {
    Received,
    Prepared,
    PresentingChallenges,
    Validating,
    Finalizing,
    Completed,
}

#[derive(Debug)]
pub struct JobStateMachine {
    phase: JobPhase,
    challenges_presented: usize,
    expected_challenges: usize,
}

impl JobStateMachine {
    pub fn new(expected_challenges: usize) -> Result<Self, AcmeError> {
        if expected_challenges == 0 || expected_challenges > MAX_DOMAINS {
            return Err(AcmeError::configuration(
                "ACME order challenge count is outside the allowed bounds",
            ));
        }
        Ok(Self {
            phase: JobPhase::Received,
            challenges_presented: 0,
            expected_challenges,
        })
    }

    #[cfg(test)]
    pub fn phase(&self) -> JobPhase {
        self.phase
    }

    pub fn prepare(&mut self) -> Result<(), AcmeError> {
        self.transition(JobPhase::Received, JobPhase::Prepared)
    }

    pub fn start_challenges(&mut self) -> Result<(), AcmeError> {
        self.transition(JobPhase::Prepared, JobPhase::PresentingChallenges)
    }

    pub fn challenge_presented(&mut self) -> Result<(), AcmeError> {
        if self.phase != JobPhase::PresentingChallenges {
            return Err(AcmeError::internal("challenge reported in the wrong phase"));
        }
        if self.challenges_presented >= self.expected_challenges {
            return Err(AcmeError::challenge(
                "ACME server returned more challenges than the bounded order",
            ));
        }
        self.challenges_presented += 1;
        Ok(())
    }

    /// An authorization may already be valid when an order is resumed. It
    /// still consumes one bounded challenge slot.
    pub fn challenge_already_valid(&mut self) -> Result<(), AcmeError> {
        self.challenge_presented()
    }

    pub fn start_validation(&mut self) -> Result<(), AcmeError> {
        if self.phase != JobPhase::PresentingChallenges
            || self.challenges_presented != self.expected_challenges
        {
            return Err(AcmeError::internal(
                "all bounded challenges must be presented before validation",
            ));
        }
        self.phase = JobPhase::Validating;
        Ok(())
    }

    pub fn start_finalize(&mut self) -> Result<(), AcmeError> {
        self.transition(JobPhase::Validating, JobPhase::Finalizing)
    }

    pub fn complete(&mut self) -> Result<(), AcmeError> {
        self.transition(JobPhase::Finalizing, JobPhase::Completed)
    }

    fn transition(&mut self, from: JobPhase, to: JobPhase) -> Result<(), AcmeError> {
        if self.phase != from {
            return Err(AcmeError::internal(format!(
                "invalid ACME job transition {:?} -> {:?}",
                self.phase, to
            )));
        }
        self.phase = to;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AcmeErrorPhase, JobPhase, JobStateMachine, MAX_DNS_NAME_LEN, SecretString, sanitize_error,
    };

    #[test]
    fn secret_debug_never_contains_the_value() {
        let secret = SecretString::new("super-secret-private-key");
        assert_eq!(format!("{secret:?}"), "<redacted>");
    }

    #[test]
    fn error_sanitizer_drops_pem_blocks_and_bounds_output() {
        let pem = format!(
            "{}BEGIN {}\nSECRET\n{}END {}",
            "-----", "PRIVATE KEY-----", "-----", "PRIVATE KEY-----"
        );
        let sanitized = sanitize_error(&format!("order failed\n{pem}\nretry"));
        assert_eq!(sanitized, "order failed\nretry");
        assert!(!sanitized.contains("SECRET"));
        assert!(sanitize_error(&"x".repeat(20_000)).len() <= 16_384);
    }

    #[test]
    fn job_state_machine_requires_every_challenge_then_finalization() {
        let mut state = JobStateMachine::new(2).unwrap();
        assert_eq!(state.phase(), JobPhase::Received);
        state.prepare().unwrap();
        state.start_challenges().unwrap();
        state.challenge_presented().unwrap();
        assert!(state.start_validation().is_err());
        state.challenge_presented().unwrap();
        assert!(state.challenge_presented().is_err());
        state.start_validation().unwrap();
        state.start_finalize().unwrap();
        state.complete().unwrap();
        assert_eq!(state.phase(), JobPhase::Completed);
    }

    #[test]
    fn job_bounds_reject_empty_or_oversized_orders() {
        assert_eq!(
            JobStateMachine::new(0).unwrap_err().phase,
            AcmeErrorPhase::Configuration
        );
        assert!(JobStateMachine::new(101).is_err());
    }

    #[test]
    fn protocol_bounds_match_the_control_plane() {
        assert_eq!(super::MAX_DOMAINS, 100);
        assert_eq!(MAX_DNS_NAME_LEN, 253);
    }
}
