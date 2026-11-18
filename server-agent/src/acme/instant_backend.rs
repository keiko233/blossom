//! `instant-acme` adapter. All tests for this module use fake solver ports;
//! no test reaches a production CA.

use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use instant_acme::{
    Account, AuthorizationStatus, ChallengeType, ExternalAccountKey, Identifier, NewAccount,
    NewOrder, OrderStatus, RetryPolicy,
};
use rcgen::{CertificateParams, KeyPair};
use zeroize::Zeroizing;

use super::ports::{
    AcmeBackend, AcmeChallengeType, AcmeError, AcmeErrorPhase, ChallengeSolver,
    DEFAULT_CHALLENGE_TIMEOUT, DnsRecord, ExternalAccountBinding, IssueRequest, IssuedMaterial,
    JobStateMachine, SecretString,
};

const ORDER_RETRY_TIMEOUT: Duration = Duration::from_secs(5 * 60);

pub struct InstantAcmeBackend;

impl InstantAcmeBackend {
    pub fn new() -> Self {
        Self
    }

    async fn issue_inner(
        &self,
        request: &IssueRequest,
        solver: &dyn ChallengeSolver,
    ) -> Result<IssuedMaterial, AcmeError> {
        let mut job = JobStateMachine::new(request.domains.len())?;
        job.prepare()?;
        tracing::debug!(
            job_id = %request.job_id,
            certificate_id = %request.certificate_id,
            generation = request.generation,
            domains = request.domains.len(),
            "starting bounded ACME order"
        );

        let eab = request
            .external_account_binding
            .as_ref()
            .map(decode_external_account_key)
            .transpose()?;
        let contact = request
            .acme_email
            .as_ref()
            .map(|email| format!("mailto:{email}"));
        let contacts: Vec<&str> = contact.iter().map(String::as_str).collect();
        let (account, _credentials) = Account::builder()
            .map_err(|error| {
                AcmeError::new(
                    AcmeErrorPhase::Account,
                    format!("failed to create ACME client: {error}"),
                )
            })?
            .create(
                &NewAccount {
                    contact: &contacts,
                    terms_of_service_agreed: true,
                    only_return_existing: false,
                },
                request
                    .acme_provider
                    .directory_url(request.acme_staging)
                    .to_string(),
                eab.as_ref(),
            )
            .await
            .map_err(|error| {
                AcmeError::new(
                    AcmeErrorPhase::Account,
                    format!("ACME account creation failed: {error}"),
                )
            })?;

        let identifiers = request
            .domains
            .iter()
            .cloned()
            .map(Identifier::Dns)
            .collect::<Vec<_>>();
        let mut order = account
            .new_order(&NewOrder::new(&identifiers))
            .await
            .map_err(|error| {
                AcmeError::new(
                    AcmeErrorPhase::Order,
                    format!("ACME order creation failed: {error}"),
                )
            })?;
        job.start_challenges()?;

        let mut authorizations = order.authorizations();
        while let Some(result) = authorizations.next().await {
            let mut authorization = result.map_err(|error| {
                AcmeError::new(
                    AcmeErrorPhase::Challenge,
                    format!("ACME authorization fetch failed: {error}"),
                )
            })?;
            match authorization.status {
                AuthorizationStatus::Valid => {
                    job.challenge_already_valid()?;
                    continue;
                }
                AuthorizationStatus::Pending => {}
                other => {
                    return Err(AcmeError::challenge(format!(
                        "ACME authorization is not pending ({other:?})"
                    )));
                }
            }

            match request.challenge_type {
                AcmeChallengeType::Http01 => {
                    let mut challenge = authorization
                        .challenge(ChallengeType::Http01)
                        .ok_or_else(|| AcmeError::challenge("ACME server did not offer http-01"))?;
                    let token = challenge.token.clone();
                    let key_authorization = challenge.key_authorization();
                    solver
                        .serve_http(&token, key_authorization.as_str())
                        .await?;
                    job.challenge_presented()?;
                    challenge.set_ready().await.map_err(|error| {
                        AcmeError::challenge(format!(
                            "ACME http-01 challenge submission failed: {error}"
                        ))
                    })?;
                }
                AcmeChallengeType::Dns01 => {
                    let mut challenge = authorization
                        .challenge(ChallengeType::Dns01)
                        .ok_or_else(|| AcmeError::challenge("ACME server did not offer dns-01"))?;
                    let identifier = challenge.identifier().to_string();
                    let domain = identifier.strip_prefix("*.").unwrap_or(&identifier);
                    let record = DnsRecord {
                        fqdn: format!("_acme-challenge.{domain}"),
                        value: SecretString::new(challenge.key_authorization().dns_value()),
                    };
                    solver.present_dns(&request.job_id, &record).await?;
                    job.challenge_presented()?;
                    challenge.set_ready().await.map_err(|error| {
                        AcmeError::challenge(format!(
                            "ACME dns-01 challenge submission failed: {error}"
                        ))
                    })?;
                }
            }
        }
        job.start_validation()?;

        let retry = RetryPolicy::new()
            .initial_delay(Duration::from_secs(1))
            .backoff(1.5)
            .timeout(ORDER_RETRY_TIMEOUT);
        let status = order.poll_ready(&retry).await.map_err(|error| {
            AcmeError::new(
                AcmeErrorPhase::Validation,
                format!("ACME order validation failed: {error}"),
            )
        })?;
        if status != OrderStatus::Ready {
            return Err(AcmeError::validation(format!(
                "ACME order ended in {status:?} state"
            )));
        }
        job.start_finalize()?;

        let private_key =
            KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(|error| {
                AcmeError::new(
                    AcmeErrorPhase::Finalize,
                    format!("failed to generate certificate key: {error}"),
                )
            })?;
        let params = CertificateParams::new(request.domains.clone()).map_err(|error| {
            AcmeError::new(
                AcmeErrorPhase::Finalize,
                format!("failed to prepare certificate request: {error}"),
            )
        })?;
        let csr = params.serialize_request(&private_key).map_err(|error| {
            AcmeError::new(
                AcmeErrorPhase::Finalize,
                format!("failed to sign certificate request: {error}"),
            )
        })?;
        order.finalize_csr(csr.der()).await.map_err(|error| {
            AcmeError::new(
                AcmeErrorPhase::Finalize,
                format!("ACME order finalization failed: {error}"),
            )
        })?;
        let certificate_pem = order.poll_certificate(&retry).await.map_err(|error| {
            AcmeError::new(
                AcmeErrorPhase::Certificate,
                format!("ACME certificate download failed: {error}"),
            )
        })?;
        job.complete()?;
        Ok(IssuedMaterial {
            certificate_pem: SecretString::new(certificate_pem),
            private_key_pem: SecretString::new(private_key.serialize_pem()),
        })
    }
}

impl Default for InstantAcmeBackend {
    fn default() -> Self {
        Self::new()
    }
}

fn decode_external_account_key(
    binding: &ExternalAccountBinding,
) -> Result<ExternalAccountKey, AcmeError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(binding.hmac_key.expose())
        .or_else(|_| STANDARD.decode(binding.hmac_key.expose()))
        .map_err(|_| {
            AcmeError::configuration("ACME external account HMAC key is not valid base64")
        })?;
    let decoded = Zeroizing::new(decoded);
    Ok(ExternalAccountKey::new(binding.kid.clone(), &decoded))
}

#[async_trait]
impl AcmeBackend for InstantAcmeBackend {
    async fn issue(
        &self,
        request: &IssueRequest,
        solver: &dyn ChallengeSolver,
    ) -> Result<IssuedMaterial, AcmeError> {
        let outcome = match tokio::time::timeout(
            DEFAULT_CHALLENGE_TIMEOUT,
            self.issue_inner(request, solver),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(AcmeError::timeout("ACME issuance exceeded its time bound")),
        };
        solver.cleanup_dns(&request.job_id).await;
        solver.finish().await;
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::InstantAcmeBackend;

    #[test]
    fn backend_has_no_configurable_ca_url() {
        let _backend = InstantAcmeBackend::new();
    }
}
