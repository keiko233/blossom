//! Bounded HTTP/1.1 framing for the link-probe ingress and responder.
//!
//! The probe speaks only one fixed path and a small JSON body. Keeping the
//! parser here shared by both ends prevents either side from growing arbitrary
//! request/response surfaces.

use std::collections::HashMap;

use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpStream;

pub(crate) const PROBE_PATH: &str = "/blossom-agent-link-probe/v1";
pub(crate) const PROBE_TOKEN_HEADER: &str = "x-blossom-probe-token";
pub(crate) const MAX_PROBE_HEAD_BYTES: usize = 8 * 1024;
pub(crate) const MAX_PROBE_BODY_BYTES: usize = 4 * 1024;
const READ_CHUNK_BYTES: usize = 1024;

#[derive(Debug)]
pub(crate) struct HttpMessage {
    pub(crate) start_line: String,
    pub(crate) headers: HashMap<String, String>,
    pub(crate) body: Vec<u8>,
}

impl HttpMessage {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }

    pub(crate) fn status_code(&self) -> Option<u16> {
        let mut parts = self.start_line.split_ascii_whitespace();
        if !parts.next()?.starts_with("HTTP/1.") {
            return None;
        }
        parts.next()?.parse().ok()
    }

    pub(crate) fn request_line(&self) -> Option<(&str, &str)> {
        let mut parts = self.start_line.split_ascii_whitespace();
        let method = parts.next()?;
        let target = parts.next()?;
        if !parts.next()?.starts_with("HTTP/1.") || parts.next().is_some() {
            return None;
        }
        Some((method, target))
    }
}

#[derive(Debug)]
pub(crate) enum HttpError {
    Io(std::io::Error),
    Malformed,
    TooLarge,
    UnsupportedTransferEncoding,
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "probe HTTP I/O failed: {error}"),
            Self::Malformed => formatter.write_str("probe HTTP message is malformed"),
            Self::TooLarge => formatter.write_str("probe HTTP message exceeds its bound"),
            Self::UnsupportedTransferEncoding => {
                formatter.write_str("probe HTTP transfer encoding is unsupported")
            }
        }
    }
}

impl std::error::Error for HttpError {}

impl From<std::io::Error> for HttpError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

/// Reads one bounded HTTP/1.1 message. Content-Length is required when a body
/// is possible; chunked framing is refused rather than implemented partially.
pub(crate) async fn read_message(
    stream: &mut TcpStream,
    max_body_bytes: usize,
    body_required: bool,
) -> Result<HttpMessage, HttpError> {
    let mut buffer = Vec::new();
    let mut read = [0u8; READ_CHUNK_BYTES];
    let head_end = loop {
        if let Some(position) = find_head_end(&buffer) {
            break position;
        }
        if buffer.len() >= MAX_PROBE_HEAD_BYTES {
            return Err(HttpError::TooLarge);
        }
        let n = stream.read(&mut read).await?;
        if n == 0 {
            return Err(HttpError::Malformed);
        }
        buffer.extend_from_slice(&read[..n]);
    };
    let head = std::str::from_utf8(&buffer[..head_end]).map_err(|_| HttpError::Malformed)?;
    let mut start_line = None;
    let mut headers = HashMap::new();
    for (index, line) in head.split("\r\n").enumerate() {
        if index == 0 {
            if line.is_empty() || line.len() > MAX_PROBE_HEAD_BYTES {
                return Err(HttpError::Malformed);
            }
            start_line = Some(line.to_string());
            continue;
        }
        let (name, value) = line.split_once(':').ok_or(HttpError::Malformed)?;
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty()
            || name
                .bytes()
                .any(|byte| !byte.is_ascii_alphanumeric() && byte != b'-')
        {
            return Err(HttpError::Malformed);
        }
        let value = value.trim();
        if value.bytes().any(|byte| byte.is_ascii_control()) {
            return Err(HttpError::Malformed);
        }
        if headers.insert(name, value.to_string()).is_some() {
            return Err(HttpError::Malformed);
        }
    }
    let start_line = start_line.ok_or(HttpError::Malformed)?;
    if headers.contains_key("transfer-encoding") {
        return Err(HttpError::UnsupportedTransferEncoding);
    }
    let content_length = match headers.get("content-length") {
        Some(value) => value.parse::<usize>().map_err(|_| HttpError::Malformed)?,
        None if body_required => return Err(HttpError::Malformed),
        None => 0,
    };
    if content_length > max_body_bytes {
        return Err(HttpError::TooLarge);
    }
    let body_start = head_end + 4;
    let mut body = buffer.get(body_start..).unwrap_or_default().to_vec();
    if body.len() > content_length {
        return Err(HttpError::TooLarge);
    }
    while body.len() < content_length {
        let n = stream.read(&mut read).await?;
        if n == 0 {
            return Err(HttpError::Malformed);
        }
        body.extend_from_slice(&read[..n]);
        if body.len() > content_length {
            return Err(HttpError::TooLarge);
        }
    }
    Ok(HttpMessage {
        start_line,
        headers,
        body,
    })
}

fn find_head_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

pub(crate) async fn write_response(
    stream: &mut TcpStream,
    status: &str,
    body: &[u8],
) -> Result<(), std::io::Error> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.shutdown().await
}

#[cfg(test)]
mod tests {
    use tokio::io::AsyncWriteExt as _;
    use tokio::net::TcpListener;

    use super::*;

    #[tokio::test]
    async fn reads_a_bounded_message_and_refuses_oversized_or_chunked_input() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_message(&mut stream, MAX_PROBE_BODY_BYTES, true).await
        });
        let mut client = TcpStream::connect(addr).await.unwrap();
        client
            .write_all(b"POST /blossom-agent-link-probe/v1 HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}")
            .await
            .unwrap();
        let message = server.await.unwrap().unwrap();
        assert_eq!(message.request_line(), Some(("POST", PROBE_PATH)));
        assert_eq!(message.body, b"{}");

        for (payload, valid) in [
            (
                b"POST / HTTP/1.1\r\nContent-Length: 9999\r\n\r\n".to_vec(),
                false,
            ),
            (
                b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n".to_vec(),
                false,
            ),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                read_message(&mut stream, MAX_PROBE_BODY_BYTES, true).await
            });
            let mut client = TcpStream::connect(addr).await.unwrap();
            client.write_all(&payload).await.unwrap();
            let result = server.await.unwrap();
            assert_eq!(result.is_ok(), valid);
        }
    }
}
