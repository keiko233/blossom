//! Better Auth `client_credentials` token acquisition and refresh.
//!
//! The provider holds one cached access token per credential file. It reloads
//! the file when its content changes (a `replace` enrollment or an upgrade),
//! requests a fresh token before the old one expires, and backs off
//! exponentially when the token endpoint is unavailable. A still-valid cached
//! token is used while the endpoint is down so the connection that already
//! has a lease is not torn down early.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use reqwest::Url;
use reqwest::header::CONTENT_TYPE;
use serde::Deserialize;
use sha2::{Digest as _, Sha256};
use tokio::sync::Mutex;
use tokio::time::Instant;
use tracing::{info, warn};

use super::credentials::{
    Credentials, CredentialsError, MAX_CREDENTIALS_BYTES, parse_base_url, read_protected_file,
    same_origin,
};
use super::http::{MAX_RESPONSE_BYTES, client, read_bounded};
use crate::logs::{LogStore, SecretScope};
use crate::ws::adapters::SensitiveHeader;
use crate::ws::ports::WsError;
use crate::ws::v2::adapter::{BearerSource, SessionToken};

/// Refresh no later than this before expiry, so a reconnect never presents a
/// token that expires in flight.
const MAX_REFRESH_MARGIN: Duration = Duration::from_secs(60);
/// Retry delays when the token endpoint fails. Bounded and deterministic.
const REFRESH_BACKOFF: [u64; 7] = [1, 2, 4, 8, 16, 30, 60];

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    expires_in: u64,
    scope: Option<String>,
}

struct CachedToken {
    header: SensitiveHeader,
    refresh_at: Instant,
    expires_at: Instant,
}

impl CachedToken {
    fn as_session(&self, refresh_at: Instant) -> SessionToken {
        SessionToken {
            header: self.header.clone(),
            refresh_at: Some(refresh_at),
            expires_at: Some(self.expires_at),
        }
    }
}

#[derive(Default)]
struct State {
    credentials: Option<Arc<Credentials>>,
    fingerprint: Option<String>,
    token: Option<CachedToken>,
    failures: usize,
    retry_after: Option<Instant>,
}

/// Owns the credential file and the access-token cache.
pub(crate) struct OAuthTokenProvider {
    base: Url,
    credentials_path: PathBuf,
    http: reqwest::Client,
    logs: LogStore,
    state: Mutex<State>,
}

impl OAuthTokenProvider {
    /// Loads and validates the credential file once at startup.
    ///
    /// No token is requested here: the proxy starts from its last-known-good
    /// configuration while the token endpoint is unavailable.
    pub(crate) async fn load(
        credentials_path: &Path,
        base_url: &str,
        logs: LogStore,
    ) -> Result<Self, ProviderError> {
        let base = parse_base_url(base_url).map_err(ProviderError::Credentials)?;
        let path = credentials_path.to_path_buf();
        let read_path = path.clone();
        let read_base = base.clone();
        let (fingerprint, credentials) =
            tokio::task::spawn_blocking(move || load_credentials(&read_path, &read_base))
                .await
                .map_err(|error| {
                    ProviderError::Internal(format!("credential loader failed: {error}"))
                })??;
        register_secrets(&logs, &credentials, None);
        info!(
            server = %credentials.server_id,
            identity = %credentials.identity_id,
            generation = credentials.generation,
            "agent machine identity loaded; OAuth token refresh enabled"
        );
        Ok(Self {
            base,
            credentials_path: path,
            http: client().map_err(|error| ProviderError::Internal(error.to_string()))?,
            logs,
            state: Mutex::new(State {
                credentials: Some(Arc::new(credentials)),
                fingerprint: Some(fingerprint),
                ..State::default()
            }),
        })
    }

    /// Returns a token that is valid past `refresh_at`, refreshing first when
    /// the cached one is due. A valid cached token is reused during the
    /// bounded retry cooldown.
    pub(crate) async fn session_token(&self) -> Result<SessionToken, ProviderError> {
        let mut state = self.state.lock().await;
        self.reload_if_changed(&mut state).await;

        let now = Instant::now();
        if let Some(token) = state.token.as_ref() {
            if now < token.refresh_at {
                return Ok(token.as_session(token.refresh_at));
            }
            if now < token.expires_at && state.retry_after.is_some_and(|retry| now < retry) {
                let refresh_at = state.retry_after.unwrap_or(token.refresh_at);
                return Ok(token.as_session(refresh_at.min(token.expires_at)));
            }
        }

        if let Some(retry_after) = state.retry_after
            && now < retry_after
        {
            return Err(ProviderError::Backoff {
                retry_after: retry_after.saturating_duration_since(now),
            });
        }

        let Some(credentials) = state.credentials.clone() else {
            return Err(ProviderError::Internal(
                "no machine credentials are loaded".to_string(),
            ));
        };
        self.refresh(&mut state, &credentials, now).await
    }

    async fn reload_if_changed(&self, state: &mut State) {
        let path = self.credentials_path.clone();
        let base = self.base.clone();
        let loaded = tokio::task::spawn_blocking(move || load_credentials(&path, &base)).await;
        let (fingerprint, credentials) = match loaded {
            Ok(Ok(loaded)) => loaded,
            Ok(Err(error)) => {
                warn!("machine credential reload failed; keeping the loaded identity: {error}");
                return;
            }
            Err(error) => {
                warn!("machine credential reload task failed: {error}");
                return;
            }
        };
        if state.fingerprint.as_deref() == Some(fingerprint.as_str()) {
            return;
        }
        info!(
            server = %credentials.server_id,
            identity = %credentials.identity_id,
            generation = credentials.generation,
            "machine credentials rotated; using the new identity"
        );
        register_secrets(&self.logs, &credentials, None);
        state.fingerprint = Some(fingerprint);
        state.credentials = Some(Arc::new(credentials));
        state.token = None;
        state.retry_after = None;
        state.failures = 0;
    }

    async fn refresh(
        &self,
        state: &mut State,
        credentials: &Credentials,
        now: Instant,
    ) -> Result<SessionToken, ProviderError> {
        let token_url = Url::parse(&credentials.token_endpoint).map_err(|error| {
            ProviderError::Credentials(CredentialsError::Invalid(format!(
                "tokenEndpoint is not a valid URL: {error}"
            )))
        })?;
        // Checked again immediately before the client secret leaves the
        // process, even though `Credentials::validate` checked the file.
        if !same_origin(&self.base, &token_url) {
            return Err(ProviderError::OriginRejected);
        }

        let request = self
            .http
            .post(token_url)
            .basic_auth(&credentials.client_id, Some(credentials.client_secret()))
            .form(&[
                ("grant_type", "client_credentials"),
                ("resource", credentials.resource.as_str()),
                ("scope", credentials.scope.as_str()),
            ])
            .send()
            .await;
        let response = match request {
            Ok(response) => response,
            Err(error) => {
                let error = error.without_url();
                let delay = self.record_failure(state, now);
                warn!(
                    retry_after_seconds = delay.as_secs(),
                    "OAuth token request failed ({}); keeping the proxy on its last-known-good configuration",
                    classify_request_error(&error)
                );
                return Err(ProviderError::Request);
            }
        };
        let status = response.status();
        let content_type_is_json = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("application/json"));
        let body = match read_bounded(response, MAX_RESPONSE_BYTES).await {
            Ok(body) => body,
            Err(error) => {
                let delay = self.record_failure(state, now);
                warn!(
                    retry_after_seconds = delay.as_secs(),
                    "OAuth token response could not be read: {error}"
                );
                return Err(ProviderError::Request);
            }
        };
        if status != reqwest::StatusCode::OK || !content_type_is_json {
            let delay = self.record_failure(state, now);
            warn!(
                status = status.as_u16(),
                retry_after_seconds = delay.as_secs(),
                "OAuth token endpoint rejected the request"
            );
            return Err(ProviderError::Rejected {
                status: status.as_u16(),
            });
        }

        let token = match parse_token_response(&body, credentials) {
            Ok(token) => token,
            Err(error) => {
                let delay = self.record_failure(state, now);
                warn!(
                    retry_after_seconds = delay.as_secs(),
                    "OAuth token response failed validation: {error}"
                );
                return Err(error);
            }
        };
        let lifetime = Duration::from_secs(token.expires_in);
        let refresh_margin = refresh_margin(lifetime);
        let expires_at = now + lifetime;
        let refresh_at = expires_at.checked_sub(refresh_margin).unwrap_or(now);
        let cached = CachedToken {
            header: token.header,
            refresh_at,
            expires_at,
        };
        register_secrets(&self.logs, credentials, Some(&token.access_token));
        state.token = Some(cached);
        state.failures = 0;
        state.retry_after = None;
        info!(
            expires_in_seconds = lifetime.as_secs(),
            "OAuth machine token acquired"
        );
        let session = state
            .token
            .as_ref()
            .expect("token was just stored")
            .as_session(refresh_at);
        Ok(session)
    }

    fn record_failure(&self, state: &mut State, now: Instant) -> Duration {
        state.failures = (state.failures + 1).min(REFRESH_BACKOFF.len());
        let delay = Duration::from_secs(REFRESH_BACKOFF[state.failures - 1]);
        state.retry_after = Some(now + delay);
        delay
    }
}

impl fmt::Debug for OAuthTokenProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OAuthTokenProvider")
            .field("origin", &self.base.origin())
            .field("credentials_path", &self.credentials_path)
            .finish_non_exhaustive()
    }
}

#[async_trait::async_trait]
impl BearerSource for OAuthTokenProvider {
    async fn bearer(&self) -> Result<SessionToken, WsError> {
        self.session_token()
            .await
            .map_err(|error| WsError::Auth(error.to_string()))
    }
}

/// Credential or token lifecycle failure. Messages never contain a secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProviderError {
    Credentials(CredentialsError),
    Backoff { retry_after: Duration },
    Request,
    Rejected { status: u16 },
    OriginRejected,
    Invalid(&'static str),
    Internal(String),
}

impl fmt::Display for ProviderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Credentials(error) => {
                write!(formatter, "machine credentials are invalid: {error}")
            }
            Self::Backoff { retry_after } => write!(
                formatter,
                "OAuth token endpoint is cooling down for {}s",
                retry_after.as_secs()
            ),
            Self::Request => formatter.write_str("OAuth token request failed"),
            Self::Rejected { status } => {
                write!(formatter, "OAuth token endpoint returned HTTP {status}")
            }
            Self::OriginRejected => formatter
                .write_str("refusing to send the client secret to a different configured origin"),
            Self::Invalid(message) => {
                write!(formatter, "OAuth token response is invalid: {message}")
            }
            Self::Internal(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for ProviderError {}

fn load_credentials(path: &Path, base: &Url) -> Result<(String, Credentials), ProviderError> {
    let bytes = read_protected_file(path, MAX_CREDENTIALS_BYTES, "OAuth credentials file")
        .map_err(|error| {
            ProviderError::Credentials(CredentialsError::Invalid(error.to_string()))
        })?;
    let fingerprint = hex::encode(Sha256::digest(&bytes));
    let credentials = Credentials::parse(&bytes, base).map_err(ProviderError::Credentials)?;
    Ok((fingerprint, credentials))
}

fn register_secrets(logs: &LogStore, credentials: &Credentials, token: Option<&str>) {
    let mut secrets = vec![credentials.client_secret()];
    if let Some(token) = token {
        secrets.push(token);
    }
    if let Err(error) = logs.replace_secrets(SecretScope::OAuth, secrets) {
        // The redactor switches to fail-closed capture when the registry is
        // full; keep the token request moving rather than failing the link.
        warn!("OAuth secrets could not be registered for redaction: {error}");
    }
}

struct ValidatedToken {
    header: SensitiveHeader,
    access_token: String,
    expires_in: u64,
}

impl fmt::Debug for ValidatedToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ValidatedToken")
            .field("header", &"<redacted>")
            .field("access_token", &"<redacted>")
            .field("expires_in", &self.expires_in)
            .finish()
    }
}

fn parse_token_response(
    body: &[u8],
    credentials: &Credentials,
) -> Result<ValidatedToken, ProviderError> {
    let response: TokenResponse =
        serde_json::from_slice(body).map_err(|_| ProviderError::Invalid("response is not JSON"))?;
    if !response.token_type.eq_ignore_ascii_case("bearer") {
        return Err(ProviderError::Invalid("tokenType is not Bearer"));
    }
    if response.expires_in == 0 || response.expires_in > 86_400 {
        return Err(ProviderError::Invalid("expiresIn is out of range"));
    }
    if response.scope.as_deref() != Some(credentials.scope.as_str()) {
        return Err(ProviderError::Invalid(
            "scope does not match the credential",
        ));
    }
    let token = &response.access_token;
    if token.len() < 8
        || token.len() > 8192
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(ProviderError::Invalid("accessToken has an invalid shape"));
    }
    let header = SensitiveHeader::bearer(token)
        .map_err(|_| ProviderError::Invalid("accessToken is unusable"))?;
    Ok(ValidatedToken {
        header,
        access_token: response.access_token,
        expires_in: response.expires_in,
    })
}

fn refresh_margin(lifetime: Duration) -> Duration {
    let fifth = (lifetime / 5).max(Duration::from_secs(1));
    fifth.min(MAX_REFRESH_MARGIN).min(lifetime / 2)
}

fn classify_request_error(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else {
        "request"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credentials(base: &str) -> Credentials {
        Credentials::parse(
            serde_json::to_vec(&serde_json::json!({
                "serverId": "server-1",
                "identityId": "identity-1",
                "generation": 1,
                "identityStatus": "pending",
                "clientId": "agent_abcdefghijklmnopqrstuvwxyz",
                "clientSecret": "ags_abcdefghijklmnopqrstuvwxyz0123456789",
                "clientAuthMethod": "client_secret_basic",
                "grantType": "client_credentials",
                "tokenEndpoint": format!("{base}/auth/oauth2/token"),
                "issuer": format!("{base}/auth"),
                "resource": format!("{base}/agent"),
                "scope": "blossom:agent:connect",
                "tokenLifetimeSeconds": 900,
            }))
            .unwrap()
            .as_slice(),
            &parse_base_url(base).unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn refresh_keeps_a_margin_before_expiry() {
        assert_eq!(
            refresh_margin(Duration::from_secs(900)),
            Duration::from_secs(60)
        );
        assert_eq!(
            refresh_margin(Duration::from_secs(10)),
            Duration::from_secs(2)
        );
        assert_eq!(
            refresh_margin(Duration::from_secs(2)),
            Duration::from_secs(1)
        );
        assert_eq!(
            refresh_margin(Duration::from_secs(1)),
            Duration::from_millis(500)
        );
    }

    #[test]
    fn token_response_requires_bearer_exact_scope_and_bounded_token() {
        let credentials = credentials("https://blossom.example.com/api");
        let good = serde_json::to_vec(&serde_json::json!({
            "access_token": "header.payload.signature-_",
            "token_type": "Bearer",
            "expires_in": 900,
            "scope": "blossom:agent:connect",
        }))
        .unwrap();
        assert!(parse_token_response(&good, &credentials).is_ok());

        let bad_scope = serde_json::to_vec(&serde_json::json!({
            "access_token": "header.payload.signature-_",
            "token_type": "Bearer",
            "expires_in": 900,
            "scope": "blossom:agent:admin",
        }))
        .unwrap();
        assert_eq!(
            parse_token_response(&bad_scope, &credentials).unwrap_err(),
            ProviderError::Invalid("scope does not match the credential")
        );
    }

    #[test]
    fn token_errors_do_not_embed_the_secret() {
        let credentials = credentials("https://blossom.example.com/api");
        let error = parse_token_response(b"not-json", &credentials).unwrap_err();
        assert!(!error.to_string().contains(credentials.client_secret()));
    }
}
