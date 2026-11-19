//! Bounded HTTP helpers shared by enrollment and token requests.
//!
//! Redirects are disabled so a grant or a client secret can only ever reach
//! the configured origin. Response bodies are read through a hard byte cap;
//! `Content-Length` is checked first and chunked bodies are counted as they
//! arrive.

use std::fmt;
use std::time::Duration;

use reqwest::Response;

pub(crate) const MAX_RESPONSE_BYTES: usize = 16 * 1024;

/// A response body could not be read within the configured bound.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BodyError {
    TooLarge { limit: usize },
    Read(String),
}

impl fmt::Display for BodyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge { limit } => {
                write!(formatter, "response body exceeds the {limit}-byte limit")
            }
            Self::Read(message) => write!(formatter, "response body could not be read: {message}"),
        }
    }
}

impl std::error::Error for BodyError {}

/// Builds the one HTTP client used for enrollment and token requests.
///
/// No redirects are followed: the one-time grant and the client secret are
/// sent only to a URL derived from the configured origin or to the
/// same-origin token endpoint named by the credential file.
pub(crate) fn client() -> anyhow::Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("blossom-server-agent/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(anyhow::Error::new)
}

/// Reads a response body, refusing anything above `limit` bytes.
pub(crate) async fn read_bounded(
    mut response: Response,
    limit: usize,
) -> Result<Vec<u8>, BodyError> {
    if let Some(length) = response.content_length()
        && length > limit as u64
    {
        return Err(BodyError::TooLarge { limit });
    }
    let mut body = Vec::new();
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|error| BodyError::Read(error.without_url().to_string()))?;
        let Some(chunk) = chunk else {
            return Ok(body);
        };
        if body.len() + chunk.len() > limit {
            return Err(BodyError::TooLarge { limit });
        }
        body.extend_from_slice(&chunk);
    }
}
