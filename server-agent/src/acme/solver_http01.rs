//! Bounded, ephemeral HTTP-01 responder.
//!
//! It serves only exact `/.well-known/acme-challenge/<token>` paths for tokens
//! registered by the running order, never reads request bodies, limits headers
//! and response values, and shuts down with the order.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{RwLock, Semaphore};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::ports::{AcmeError, AcmeErrorPhase, MAX_CHALLENGE_VALUE_LEN, MAX_DOMAINS};

const MAX_HEADER_BYTES: usize = 8 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_IN_FLIGHT_CONNECTIONS: usize = 16;
const CHALLENGE_PREFIX: &str = "/.well-known/acme-challenge/";

pub struct Http01Solver {
    local_addr: SocketAddr,
    values: Arc<RwLock<HashMap<String, String>>>,
    cancel: CancellationToken,
    task: JoinHandle<()>,
}

impl Http01Solver {
    pub async fn start(bind: SocketAddr) -> Result<Self, AcmeError> {
        let listener = TcpListener::bind(bind).await.map_err(|error| {
            AcmeError::new(
                AcmeErrorPhase::Challenge,
                format!("failed to bind HTTP-01 listener: {error}"),
            )
        })?;
        let local_addr = listener.local_addr().map_err(|error| {
            AcmeError::new(
                AcmeErrorPhase::Challenge,
                format!("failed to read HTTP-01 listener address: {error}"),
            )
        })?;
        let values = Arc::new(RwLock::new(HashMap::new()));
        let cancel = CancellationToken::new();
        let task = tokio::spawn(accept_loop(listener, values.clone(), cancel.clone()));
        Ok(Self {
            local_addr,
            values,
            cancel,
            task,
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub async fn serve(&self, token: &str, key_authorization: &str) -> Result<(), AcmeError> {
        if !valid_token(token) {
            return Err(AcmeError::challenge(
                "ACME returned an invalid HTTP-01 token",
            ));
        }
        if key_authorization.is_empty()
            || key_authorization.len() > MAX_CHALLENGE_VALUE_LEN
            || key_authorization
                .bytes()
                .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
        {
            return Err(AcmeError::challenge(
                "ACME returned an invalid HTTP-01 key authorization",
            ));
        }
        let mut values = self.values.write().await;
        if values.len() >= MAX_DOMAINS && !values.contains_key(token) {
            return Err(AcmeError::challenge(
                "HTTP-01 challenge set exceeds the configured bound",
            ));
        }
        values.insert(token.to_string(), key_authorization.to_string());
        Ok(())
    }

    pub async fn finish(&self) {
        self.values.write().await.clear();
        self.cancel.cancel();
        self.task.abort();
    }
}

impl Drop for Http01Solver {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.task.abort();
    }
}

async fn accept_loop(
    listener: TcpListener,
    values: Arc<RwLock<HashMap<String, String>>>,
    cancel: CancellationToken,
) {
    let permits = Arc::new(Semaphore::new(MAX_IN_FLIGHT_CONNECTIONS));
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return,
            accepted = listener.accept() => {
                let Ok((stream, _peer)) = accepted else {
                    continue;
                };
                let Ok(permit) = permits.clone().try_acquire_owned() else {
                    drop(stream);
                    continue;
                };
                let values = values.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let _ = handle_connection(stream, values).await;
                });
            }
        }
    }
}

async fn handle_connection(
    mut stream: TcpStream,
    values: Arc<RwLock<HashMap<String, String>>>,
) -> std::io::Result<()> {
    let mut buffer = [0u8; MAX_HEADER_BYTES];
    let read = tokio::time::timeout(REQUEST_TIMEOUT, stream.read(&mut buffer)).await;
    let read = match read {
        Ok(Ok(read)) => read,
        Ok(Err(_)) | Err(_) => return Ok(()),
    };
    if read == 0 || read == buffer.len() {
        return write_response(&mut stream, "400 Bad Request", "text/plain", "bad request").await;
    }

    let headers = String::from_utf8_lossy(&buffer[..read]);
    let Some(first_line) = headers.lines().next() else {
        return write_response(&mut stream, "400 Bad Request", "text/plain", "bad request").await;
    };
    let mut parts = first_line.split_ascii_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    let version = parts.next().unwrap_or_default();
    if !matches!(method, "GET" | "HEAD") || !version.starts_with("HTTP/1.") {
        return write_response(
            &mut stream,
            "405 Method Not Allowed",
            "text/plain",
            "method not allowed",
        )
        .await;
    }
    let Some(token) = target
        .strip_prefix(CHALLENGE_PREFIX)
        .filter(|token| valid_token(token))
    else {
        return write_response(&mut stream, "404 Not Found", "text/plain", "not found").await;
    };
    let value = values.read().await.get(token).cloned();
    match value {
        Some(_) if method == "HEAD" => {
            write_response(&mut stream, "200 OK", "text/plain", "").await
        }
        Some(value) => write_response(&mut stream, "200 OK", "text/plain", &value).await,
        None => write_response(&mut stream, "404 Not Found", "text/plain", "not found").await,
    }
}

async fn write_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &str,
) -> std::io::Result<()> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await
}

fn valid_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= 256
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpStream;

    use super::{CHALLENGE_PREFIX, Http01Solver};

    async fn request(addr: SocketAddr, target: &str) -> String {
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream
            .write_all(format!("GET {target} HTTP/1.1\r\nHost: example.com\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    #[tokio::test]
    async fn serves_exact_registered_tokens_and_nothing_else() {
        let solver = Http01Solver::start("127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        solver.serve("token_1", "token_1.thumbprint").await.unwrap();

        let response = request(solver.local_addr(), &format!("{CHALLENGE_PREFIX}token_1")).await;
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.ends_with("token_1.thumbprint"));

        let missing = request(solver.local_addr(), &format!("{CHALLENGE_PREFIX}other")).await;
        assert!(missing.starts_with("HTTP/1.1 404 Not Found"));

        let traversal = request(
            solver.local_addr(),
            &format!("{CHALLENGE_PREFIX}token_1/../../secret"),
        )
        .await;
        assert!(traversal.starts_with("HTTP/1.1 404 Not Found"));

        solver.finish().await;
    }

    #[tokio::test]
    async fn rejects_invalid_or_oversized_challenge_values() {
        let solver = Http01Solver::start("127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        assert!(solver.serve("../escape", "value").await.is_err());
        assert!(solver.serve("token", "two words").await.is_err());
        assert!(solver.serve("token", &"x".repeat(513)).await.is_err());
        solver.finish().await;
    }
}
