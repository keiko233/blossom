//! `tokio-tungstenite` adapter for [`super::ports::WsTransport`].
//!
//! The control plane's agent URL already ends in `/api`; the WebSocket lives
//! at `/api/agent/ws`. The scheme follows the configured HTTP scheme
//! (`https` -> `wss`, `http` -> `ws`) and TLS reuses the crate's `rustls`
//! (`ring`) stack with `webpki-roots`, so there is no OpenSSL or `native-tls`
//! dependency. The bearer token is injected as a sensitive header on the
//! upgrade request and is never logged.

use std::time::Duration;

use anyhow::{Context, bail};
use futures_util::{SinkExt as _, StreamExt as _};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::error::Error as TungsteniteError;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::http::header::{AUTHORIZATION, USER_AGENT};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_tls_with_config};
use tracing::debug;

use super::codec::AgentWsFrame;
use super::ports::{WsConnection, WsError, WsTransport};

const WS_PATH: &str = "agent/ws";
const MAX_MESSAGE_SIZE: usize = 1024 * 1024;

/// Builds the agent WebSocket URL from the `/api`-prefixed base URL.
///
/// `https://panel.example.com/api` -> `wss://panel.example.com/api/agent/ws`;
/// `http://localhost:3000/api` -> `ws://localhost:3000/api/agent/ws`.
pub fn ws_url(base_url: &str) -> anyhow::Result<String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    let (scheme, rest) = trimmed
        .split_once("://")
        .with_context(|| format!("agent URL {trimmed} has no scheme"))?;
    let ws_scheme = match scheme {
        "https" => "wss",
        "http" => "ws",
        "wss" | "ws" => scheme,
        other => bail!("agent URL scheme {other} cannot be upgraded to a WebSocket"),
    };
    if rest.is_empty() {
        bail!("agent URL {trimmed} has no host");
    }
    Ok(format!("{ws_scheme}://{rest}/{WS_PATH}"))
}

/// Configuration for one transport instance.
#[derive(Clone)]
pub struct WsTransportConfig {
    pub url: String,
    /// Marked sensitive; never formatted into logs or errors.
    pub token: SensitiveHeader,
    pub connect_timeout: Duration,
}

impl std::fmt::Debug for WsTransportConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WsTransportConfig")
            .field("url", &self.url)
            .field("token", &"<redacted>")
            .field("connect_timeout", &self.connect_timeout)
            .finish()
    }
}

/// A header value that redacts itself in `Debug` output.
#[derive(Clone)]
pub struct SensitiveHeader {
    value: HeaderValue,
}

impl SensitiveHeader {
    /// Wraps a bearer token. The token is never stored or logged in plain form
    /// outside the header value, which is flagged sensitive to tracing.
    pub fn bearer(token: &str) -> anyhow::Result<Self> {
        let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
            .context("agent token contains invalid header characters")?;
        value.set_sensitive(true);
        Ok(Self { value })
    }

    fn header_value(&self) -> HeaderValue {
        let mut value = self.value.clone();
        value.set_sensitive(true);
        value
    }
}

impl std::fmt::Debug for SensitiveHeader {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SensitiveHeader(<redacted>)")
    }
}

/// Real transport over `tokio-tungstenite` with the crate's `rustls` stack.
#[derive(Debug, Clone)]
pub struct TokioWsTransport {
    config: WsTransportConfig,
}

impl TokioWsTransport {
    pub fn new(config: WsTransportConfig) -> anyhow::Result<Self> {
        // The TLS connector built by `tokio-tungstenite` uses the process
        // crypto provider; installing `ring` here keeps the transport usable
        // even when the binary did not install it first.
        let _ = rustls::crypto::ring::default_provider().install_default();
        Ok(Self { config })
    }
}

fn web_socket_config() -> WebSocketConfig {
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(MAX_MESSAGE_SIZE);
    config.max_frame_size = Some(MAX_MESSAGE_SIZE);
    config
}

impl WsTransport for TokioWsTransport {
    type Connection = TokioWsConnection;

    async fn connect(&self) -> Result<Self::Connection, WsError> {
        let mut request = self
            .config
            .url
            .as_str()
            .into_client_request()
            .map_err(|error| WsError::Protocol(format!("invalid websocket URL: {error}")))?;
        request
            .headers_mut()
            .insert(AUTHORIZATION, self.config.token.header_value());
        request.headers_mut().insert(
            USER_AGENT,
            HeaderValue::from_static(concat!("blossom-server-agent/", env!("CARGO_PKG_VERSION"))),
        );

        let handshake = tokio::time::timeout(
            self.config.connect_timeout,
            connect_async_tls_with_config(request, Some(web_socket_config()), false, None),
        )
        .await
        .map_err(|_| WsError::Io("websocket upgrade timed out".to_string()))?;

        let (stream, _response) = match handshake {
            Ok(pair) => pair,
            Err(TungsteniteError::Http(response)) => {
                return Err(WsError::Rejected {
                    status: response.status().as_u16(),
                });
            }
            Err(error) => return Err(classify(error)),
        };
        debug!(url = %self.config.url, "agent websocket connected");
        Ok(TokioWsConnection { stream })
    }
}

fn classify(error: TungsteniteError) -> WsError {
    match error {
        TungsteniteError::ConnectionClosed | TungsteniteError::AlreadyClosed => WsError::Closed,
        TungsteniteError::Io(error) => WsError::Io(error.to_string()),
        TungsteniteError::Tls(error) => WsError::Io(format!("TLS: {error}")),
        other => WsError::Protocol(other.to_string()),
    }
}

/// One live session over `tokio-tungstenite`.
pub struct TokioWsConnection {
    stream: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl std::fmt::Debug for TokioWsConnection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("TokioWsConnection")
    }
}

impl WsConnection for TokioWsConnection {
    async fn recv(&mut self) -> Result<AgentWsFrame, WsError> {
        loop {
            let message = match self.stream.next().await {
                Some(Ok(message)) => message,
                Some(Err(error)) => return Err(classify(error)),
                None => return Err(WsError::Closed),
            };
            match message {
                tokio_tungstenite::tungstenite::Message::Text(text) => {
                    return AgentWsFrame::decode(text.as_str())
                        .map(|decoded| decoded.frame)
                        .map_err(|error| WsError::Protocol(error.to_string()));
                }
                tokio_tungstenite::tungstenite::Message::Ping(_)
                | tokio_tungstenite::tungstenite::Message::Pong(_) => {
                    // tungstenite queues the pong; flush it so the control
                    // plane's keepalive sees a prompt answer.
                    self.stream.flush().await.map_err(classify)?;
                }
                tokio_tungstenite::tungstenite::Message::Close(_) => return Err(WsError::Closed),
                tokio_tungstenite::tungstenite::Message::Binary(_)
                | tokio_tungstenite::tungstenite::Message::Frame(_) => {}
            }
        }
    }

    async fn send(&mut self, frame: AgentWsFrame) -> Result<(), WsError> {
        let text = frame
            .encode()
            .map_err(|error| WsError::Protocol(error.to_string()))?;
        self.stream
            .send(tokio_tungstenite::tungstenite::Message::text(text))
            .await
            .map_err(classify)
    }

    async fn close(&mut self) {
        let _ = self.stream.close(None).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{SensitiveHeader, TokioWsTransport, WsTransportConfig, ws_url};

    #[test]
    fn derives_wss_from_https_base_url() {
        assert_eq!(
            ws_url("https://panel.example.com/api").unwrap(),
            "wss://panel.example.com/api/agent/ws"
        );
        assert_eq!(
            ws_url("https://panel.example.com/api/").unwrap(),
            "wss://panel.example.com/api/agent/ws"
        );
        assert_eq!(
            ws_url("http://localhost:3000/api").unwrap(),
            "ws://localhost:3000/api/agent/ws"
        );
    }

    #[test]
    fn rejects_unusable_base_urls() {
        assert!(ws_url("panel.example.com/api").is_err());
        assert!(ws_url("ftp://panel.example.com/api").is_err());
        assert!(ws_url("https://").is_err());
    }

    #[test]
    fn transport_debug_redacts_the_token() {
        let config = WsTransportConfig {
            url: "wss://panel.example.com/api/agent/ws".into(),
            token: SensitiveHeader::bearer("super-secret-token").unwrap(),
            connect_timeout: std::time::Duration::from_secs(10),
        };
        let transport = TokioWsTransport::new(config).unwrap();
        let rendered = format!("{transport:?}");
        assert!(rendered.contains("<redacted>"));
        assert!(!rendered.contains("super-secret-token"));
    }
}
