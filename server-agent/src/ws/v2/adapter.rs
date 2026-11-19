//! `tokio-tungstenite` connector for protocol v2.
//!
//! The agent offers [`SUBPROTOCOL`] on the upgrade and requires the control
//! plane to echo it. A missing or different echo is a
//! [`WsError::SubprotocolMismatch`], which is a distinct state from a rejected
//! upgrade (an HTTP status) and from network failure. Frames are carried as
//! text, and the codec validates them, so this layer only moves bytes.

use futures_util::{SinkExt as _, StreamExt as _};
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::error::{Error as TungsteniteError, ProtocolError};
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::http::header::{
    AUTHORIZATION, SEC_WEBSOCKET_PROTOCOL, USER_AGENT,
};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_tls_with_config};
use tracing::debug;

use super::codec::{MAX_FRAME_BYTES, SUBPROTOCOL};
use crate::ws::adapters::{SensitiveHeader, WsTransportConfig, classify, web_socket_config};
use crate::ws::ports::WsError;

/// One bearer token and the instants at which it must be refreshed and when
/// it stops being valid. The session reconnects at `refresh_at`, before the
/// connection's token lease ends.
pub struct SessionToken {
    pub header: SensitiveHeader,
    pub refresh_at: Option<Instant>,
    pub expires_at: Option<Instant>,
}

/// Supplies a fresh bearer header immediately before a v2 upgrade.
#[async_trait::async_trait]
pub trait BearerSource: Send + Sync {
    async fn bearer(&self) -> Result<SessionToken, WsError>;
}

#[derive(Clone)]
enum AuthSource {
    Static(SensitiveHeader),
    OAuth(Arc<dyn BearerSource>),
}

/// Opens protocol v2 connections to one agent WebSocket URL.
#[derive(Clone)]
pub struct V2Connector {
    url: String,
    auth: AuthSource,
    connect_timeout: std::time::Duration,
}

impl V2Connector {
    /// A connector that presents a fixed static token (legacy or backup mode).
    pub fn new(config: WsTransportConfig) -> Self {
        Self::install_crypto();
        Self {
            url: config.url,
            auth: AuthSource::Static(config.token),
            connect_timeout: config.connect_timeout,
        }
    }

    /// A connector that obtains a fresh machine token before every upgrade.
    pub fn with_bearer(
        url: String,
        source: Arc<dyn BearerSource>,
        connect_timeout: std::time::Duration,
    ) -> Self {
        Self::install_crypto();
        Self {
            url,
            auth: AuthSource::OAuth(source),
            connect_timeout,
        }
    }

    fn install_crypto() {
        // The TLS connector uses the process crypto provider. Installing `ring`
        // here keeps the connector usable when the binary did not install it.
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    async fn token(&self) -> Result<SessionToken, WsError> {
        match &self.auth {
            AuthSource::Static(header) => Ok(SessionToken {
                header: header.clone(),
                refresh_at: None,
                expires_at: None,
            }),
            AuthSource::OAuth(source) => source.bearer().await,
        }
    }

    /// Performs the upgrade with the v2 subprotocol and the connect deadline.
    pub async fn connect(&self) -> Result<V2Connection, WsError> {
        let token = self.token().await?;
        let mut request = self
            .url
            .as_str()
            .into_client_request()
            .map_err(|error| WsError::Protocol(format!("invalid websocket URL: {error}")))?;
        request
            .headers_mut()
            .insert(AUTHORIZATION, token.header.header_value());
        request.headers_mut().insert(
            USER_AGENT,
            HeaderValue::from_static(concat!("blossom-server-agent/", env!("CARGO_PKG_VERSION"))),
        );
        request.headers_mut().insert(
            SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static(SUBPROTOCOL),
        );

        let handshake = tokio::time::timeout(
            self.connect_timeout,
            connect_async_tls_with_config(
                request,
                Some(web_socket_config(MAX_FRAME_BYTES)),
                false,
                None,
            ),
        )
        .await
        .map_err(|_| WsError::Io("websocket upgrade timed out".to_string()))?;

        let (stream, response) = match handshake {
            Ok(pair) => pair,
            Err(TungsteniteError::Http(response)) => {
                return Err(WsError::Rejected {
                    status: response.status().as_u16(),
                });
            }
            Err(TungsteniteError::Protocol(ProtocolError::SecWebSocketSubProtocolError(_))) => {
                return Err(WsError::SubprotocolMismatch);
            }
            Err(error) => return Err(classify(error)),
        };
        let echoed = response
            .headers()
            .get(SEC_WEBSOCKET_PROTOCOL)
            .and_then(|value| value.to_str().ok());
        if echoed != Some(SUBPROTOCOL) {
            drop(stream);
            return Err(WsError::SubprotocolMismatch);
        }
        debug!(url = %self.url, "agent websocket v2 connected");
        let refresh_deadline = match (token.refresh_at, token.expires_at) {
            (Some(refresh), Some(expires)) => Some(refresh.min(expires)),
            (Some(refresh), None) => Some(refresh),
            (None, Some(expires)) => Some(expires),
            (None, None) => None,
        };
        Ok(V2Connection {
            stream,
            refresh_deadline,
        })
    }
}

impl std::fmt::Debug for V2Connector {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("V2Connector")
            .field("url", &self.url)
            .field(
                "auth",
                &match &self.auth {
                    AuthSource::Static(_) => "static",
                    AuthSource::OAuth(_) => "oauth",
                },
            )
            .field("connect_timeout", &self.connect_timeout)
            .finish()
    }
}

/// One live v2 session.
pub struct V2Connection {
    stream: WebSocketStream<MaybeTlsStream<TcpStream>>,
    refresh_deadline: Option<Instant>,
}

impl std::fmt::Debug for V2Connection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("V2Connection")
    }
}

impl V2Connection {
    /// When the session should reconnect to present a fresh machine token.
    pub fn refresh_deadline(&self) -> Option<Instant> {
        self.refresh_deadline
    }

    /// Waits for the next text frame. Protocol pings are answered by the
    /// library, and binary frames are not part of v2, so they are skipped.
    pub async fn recv_text(&mut self) -> Result<String, WsError> {
        loop {
            let message = match self.stream.next().await {
                Some(Ok(message)) => message,
                Some(Err(error)) => return Err(classify(error)),
                None => return Err(WsError::Closed),
            };
            match message {
                Message::Text(text) => return Ok(text.as_str().to_owned()),
                Message::Ping(_) | Message::Pong(_) => {
                    // Queued replies are flushed here, so the peer's liveness
                    // check sees a prompt answer.
                    self.stream.flush().await.map_err(classify)?;
                }
                Message::Close(_) => return Err(WsError::Closed),
                Message::Binary(_) | Message::Frame(_) => {}
            }
        }
    }

    pub async fn send_text(&mut self, text: String) -> Result<(), WsError> {
        self.stream
            .send(Message::text(text))
            .await
            .map_err(classify)
    }

    /// A WebSocket-level ping, which detects a half-open connection.
    pub async fn ping(&mut self) -> Result<(), WsError> {
        self.stream
            .send(Message::Ping(Vec::new().into()))
            .await
            .map_err(classify)
    }

    pub async fn close(&mut self) {
        let _ = self.stream.close(None).await;
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
    use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};

    use super::V2Connector;
    use crate::ws::adapters::{SensitiveHeader, WsTransportConfig};
    use crate::ws::ports::WsError;
    use crate::ws::v2::codec::SUBPROTOCOL;

    #[derive(Clone, Copy)]
    enum Peer {
        /// Echoes the required subprotocol, then sends one text frame.
        Echoes,
        /// Accepts the upgrade without a subprotocol, as an older control plane does.
        Silent,
        /// Echoes a subprotocol the agent did not offer.
        WrongEcho,
        /// Refuses the upgrade with an HTTP status.
        Refuses(u16),
    }

    async fn spawn_peer(peer: Peer) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            // The handshake callback's error type is fixed by tungstenite.
            #[expect(
                clippy::result_large_err,
                reason = "tungstenite fixes the handshake error type"
            )]
            let callback = move |request: &Request, mut response: Response| {
                let offered = request
                    .headers()
                    .get("sec-websocket-protocol")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_string();
                match peer {
                    Peer::Echoes if offered != SUBPROTOCOL => {
                        let mut error = ErrorResponse::new(None);
                        *error.status_mut() = StatusCode::BAD_REQUEST;
                        Err(error)
                    }
                    Peer::Echoes => {
                        response.headers_mut().insert(
                            "sec-websocket-protocol",
                            HeaderValue::from_static(SUBPROTOCOL),
                        );
                        Ok(response)
                    }
                    Peer::Silent => Ok(response),
                    Peer::WrongEcho => {
                        response.headers_mut().insert(
                            "sec-websocket-protocol",
                            HeaderValue::from_static("blossom-agent.v1"),
                        );
                        Ok(response)
                    }
                    Peer::Refuses(status) => {
                        let mut error = ErrorResponse::new(None);
                        *error.status_mut() = StatusCode::from_u16(status).unwrap();
                        Err(error)
                    }
                }
            };
            let Ok(mut socket) = tokio_tungstenite::accept_hdr_async(stream, callback).await else {
                return;
            };
            if matches!(peer, Peer::Echoes) {
                use futures_util::SinkExt as _;
                let _ = socket
                    .send(Message::text(r#"{"v":2,"type":"error","ts":"2026-11-19T00:00:00Z","payload":{"code":"session_replaced","message":"test"}}"#))
                    .await;
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });
        format!("ws://{address}/api/agent/ws")
    }

    fn connector(url: String) -> V2Connector {
        V2Connector::new(WsTransportConfig {
            url,
            token: SensitiveHeader::bearer("test-token").unwrap(),
            connect_timeout: Duration::from_secs(5),
        })
    }

    #[tokio::test]
    async fn an_echoed_subprotocol_connects_and_carries_text_frames() {
        let url = spawn_peer(Peer::Echoes).await;
        let mut connection = connector(url).connect().await.unwrap();
        let frame = connection.recv_text().await.unwrap();
        assert!(frame.contains("session_replaced"));
    }

    #[tokio::test]
    async fn a_peer_that_ignores_the_subprotocol_is_a_mismatch_not_a_rejection() {
        let url = spawn_peer(Peer::Silent).await;
        assert_eq!(
            connector(url).connect().await.unwrap_err(),
            WsError::SubprotocolMismatch
        );
    }

    #[tokio::test]
    async fn a_different_echo_is_a_mismatch() {
        let url = spawn_peer(Peer::WrongEcho).await;
        assert_eq!(
            connector(url).connect().await.unwrap_err(),
            WsError::SubprotocolMismatch
        );
    }

    #[tokio::test]
    async fn an_http_refusal_is_reported_as_a_rejected_handshake() {
        let url = spawn_peer(Peer::Refuses(400)).await;
        assert_eq!(
            connector(url).connect().await.unwrap_err(),
            WsError::Rejected { status: 400 }
        );
    }

    #[tokio::test]
    async fn an_unreachable_peer_is_a_network_failure() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let error = connector(format!("ws://{address}/api/agent/ws"))
            .connect()
            .await
            .unwrap_err();
        assert!(matches!(error, WsError::Io(_)), "{error:?}");
    }
}
