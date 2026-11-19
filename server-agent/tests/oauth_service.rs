//! Disposable control-plane checks for the OAuth enrollment CLI and the v2
//! service credential lifecycle.
//!
//! One loopback listener serves enrollment redemption, the Better Auth token
//! endpoint, and the agent WebSocket. Any legacy HTTP agent poll is recorded
//! and failed. The tests use fake sing-box binaries and temporary state only.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use futures_util::{SinkExt as _, StreamExt as _};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};

const SUBPROTOCOL: &str = "blossom-agent.v2";
const GRANT: &str = "egr_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const INITIAL_SECRET: &str = "ags_FAKE_service_secret_0001";
const ROTATED_SECRET: &str = "ags_FAKE_service_secret_0002";
const CLIENT_ID: &str = "agent_abcdefghijklmnopqrstuvwxyz";
const DESIRED: &str = "1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("blossom-oauth-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct ServerState {
    redeem_status: u16,
    redeem_body: Option<Vec<u8>>,
    redeem_requests: Vec<Vec<u8>>,
    last_redeem_body: Option<Vec<u8>>,
    token_status: u16,
    token_expires_in: u64,
    token_body: Option<Vec<u8>>,
    token_requests: Vec<(String, String)>,
    ws_tokens: Vec<String>,
    other_http: Vec<String>,
}

fn credential_bytes(base: &str, secret: &str, generation: u64, lifetime: u64) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "serverId": "server-1",
        "identityId": format!("identity-{generation}"),
        "generation": generation,
        "identityStatus": "pending",
        "clientId": CLIENT_ID,
        "clientSecret": secret,
        "clientAuthMethod": "client_secret_basic",
        "grantType": "client_credentials",
        "tokenEndpoint": format!("{base}/auth/oauth2/token"),
        "issuer": format!("{base}/auth"),
        "resource": format!("{base}/agent"),
        "scope": "blossom:agent:connect",
        "tokenLifetimeSeconds": lifetime,
    }))
    .unwrap()
}

async fn spawn_control_plane() -> (String, Arc<Mutex<ServerState>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let base = format!("http://{address}/api");
    let state = Arc::new(Mutex::new(ServerState::default()));
    let server_state = Arc::clone(&state);
    let server_base = base.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let state = Arc::clone(&server_state);
            let base = server_base.clone();
            tokio::spawn(async move {
                if peek_is_websocket(&stream).await {
                    serve_websocket(stream, state).await;
                } else {
                    serve_http(stream, state, base).await;
                }
            });
        }
    });
    (base, state)
}

async fn peek_is_websocket(stream: &TcpStream) -> bool {
    let mut buffer = vec![0u8; 8192];
    for _ in 0..200 {
        let read = timeout(Duration::from_millis(50), stream.peek(&mut buffer))
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(0);
        if read == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
            continue;
        }
        if buffer[..read]
            .windows(4)
            .any(|window| window == b"\r\n\r\n")
        {
            let headers = String::from_utf8_lossy(&buffer[..read]).to_ascii_lowercase();
            return headers.contains("upgrade: websocket");
        }
    }
    false
}

async fn serve_http(mut stream: TcpStream, state: Arc<Mutex<ServerState>>, base: String) {
    let Some((method, path, headers, body)) = read_http_request(&mut stream).await else {
        return;
    };
    match (method.as_str(), path.as_str()) {
        ("POST", "/api/agent/enrollment/redeem") => {
            let status = {
                let mut state = state.lock().unwrap();
                state.redeem_requests.push(body);
                state.redeem_status
            };
            if status == 0 || status == 200 {
                let body = {
                    let mut state = state.lock().unwrap();
                    let body = state
                        .redeem_body
                        .clone()
                        .unwrap_or_else(|| credential_bytes(&base, INITIAL_SECRET, 1, 900));
                    state.last_redeem_body = Some(body.clone());
                    body
                };
                respond(&mut stream, 200, "application/json", &body).await;
            } else {
                let body = state
                    .lock()
                    .unwrap()
                    .redeem_body
                    .clone()
                    .unwrap_or_else(|| br#"{"error":"invalid_grant"}"#.to_vec());
                respond(&mut stream, status, "application/json", &body).await;
            }
        }
        ("POST", "/api/auth/oauth2/token") => {
            let credentials = headers
                .get("authorization")
                .and_then(|value| value.strip_prefix("Basic "))
                .and_then(|value| STANDARD.decode(value).ok())
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .and_then(|pair| {
                    pair.split_once(':')
                        .map(|(client, secret)| (client.to_string(), secret.to_string()))
                });
            let (status, expires_in) = {
                let mut state = state.lock().unwrap();
                if let Some(credentials) = credentials {
                    state.token_requests.push(credentials);
                }
                (state.token_status, state.token_expires_in)
            };
            if status == 0 || status == 200 {
                let index = state.lock().unwrap().token_requests.len();
                let body = {
                    let state = state.lock().unwrap();
                    state.token_body.clone().unwrap_or_else(|| {
                        serde_json::to_vec(&json!({
                            "access_token": format!("header{index}.payload.sig{index}"),
                            "token_type": "Bearer",
                            "expires_in": expires_in,
                            "scope": "blossom:agent:connect",
                        }))
                        .unwrap()
                    })
                };
                respond(&mut stream, 200, "application/json", &body).await;
            } else {
                let body = state
                    .lock()
                    .unwrap()
                    .token_body
                    .clone()
                    .unwrap_or_else(|| br#"{"error":"temporarily_unavailable"}"#.to_vec());
                respond(&mut stream, status, "application/json", &body).await;
            }
        }
        _ => {
            state.lock().unwrap().other_http.push(path.clone());
            respond(
                &mut stream,
                404,
                "application/json",
                br#"{"error":"the oauth v2 agent must not call the HTTP agent API"}"#,
            )
            .await;
        }
    }
}

async fn serve_websocket(stream: TcpStream, state: Arc<Mutex<ServerState>>) {
    let callback_state = Arc::clone(&state);
    #[expect(
        clippy::result_large_err,
        reason = "tungstenite fixes the handshake error type"
    )]
    let callback = move |request: &Request, mut response: Response| {
        let offered = request
            .headers()
            .get("sec-websocket-protocol")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if offered != SUBPROTOCOL {
            let mut error = ErrorResponse::new(None);
            *error.status_mut() = StatusCode::BAD_REQUEST;
            return Err(error);
        }
        if let Some(authorization) = request
            .headers()
            .get("authorization")
            .and_then(|value| value.to_str().ok())
        {
            callback_state
                .lock()
                .unwrap()
                .ws_tokens
                .push(authorization.to_string());
        }
        response.headers_mut().insert(
            "sec-websocket-protocol",
            HeaderValue::from_static(SUBPROTOCOL),
        );
        Ok(response)
    };
    let Ok(mut socket) = tokio_tungstenite::accept_hdr_async(stream, callback).await else {
        return;
    };
    let welcome = json!({
        "v": 2,
        "type": "welcome",
        "ts": chrono::Utc::now().to_rfc3339(),
        "payload": {
            "sessionId": "session-1",
            "serverId": "server-1",
            "serverName": "edge-1",
            "desired": {
                "desiredRevisionSeq": 1,
                "desiredRevision": DESIRED,
            },
            "updatePolicy": {
                "desiredAgentVersion": null,
                "desiredSingBoxVersion": null,
            },
            "statusIntervalSeconds": 30,
            "limits": {
                "maxFrameBytes": 4 * 1024 * 1024,
                "snapshotChunkBytes": 64 * 1024,
                "maxSnapshotBytes": 8 * 1024 * 1024,
            },
        },
    });
    if socket
        .send(Message::text(welcome.to_string()))
        .await
        .is_err()
    {
        return;
    }
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(_))) => {}
            Some(Ok(Message::Ping(payload))) => {
                let _ = socket.send(Message::Pong(payload)).await;
            }
            Some(Ok(Message::Pong(_))) | Some(Ok(Message::Frame(_))) => {}
            Some(Ok(Message::Binary(_))) | Some(Ok(Message::Close(_))) | Some(Err(_)) | None => {
                break;
            }
        }
    }
    let _ = socket.close(None).await;
}

async fn read_http_request(
    stream: &mut TcpStream,
) -> Option<(String, String, HashMap<String, String>, Vec<u8>)> {
    let mut buffer = Vec::new();
    let header_end = loop {
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
        let mut chunk = [0u8; 4096];
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > 64 * 1024 {
            return None;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = head.lines();
    let mut request_line = lines.next()?.split_whitespace();
    let method = request_line.next()?.to_string();
    let path = request_line.next()?.to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    while buffer.len() < header_end + length {
        let mut chunk = [0u8; 4096];
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    Some((
        method,
        path,
        headers,
        buffer[header_end..header_end + length].to_vec(),
    ))
}

async fn respond(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) {
    let _ = stream
        .write_all(
            format!(
                "HTTP/1.1 {status} {}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                if status == 200 { "OK" } else { "Error" },
                body.len()
            )
            .as_bytes(),
        )
        .await;
    let _ = stream.write_all(body).await;
    let _ = stream.shutdown().await;
}

fn write_secret_file(path: &Path, bytes: &[u8]) {
    use std::os::unix::fs::PermissionsExt as _;

    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

fn write_fake_singbox(path: &Path, run_log: &Path) {
    use std::os::unix::fs::PermissionsExt as _;

    fs::write(
        path,
        format!(
            "#!/bin/sh\n\
             set -eu\n\
             case \"$1\" in\n\
               version) echo \"sing-box version 1.14.0\" ;;\n\
               check) exit 0 ;;\n\
               run) echo \"run $3\" >> '{}'; trap 'exit 0' TERM INT; while :; do sleep 1; done ;;\n\
             esac\n",
            run_log.display()
        ),
    )
    .unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

fn agent_command(base: &str, credentials: &Path, state_dir: &Path, bin: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_server-agent"));
    command
        .arg("--url")
        .arg(base)
        .arg("--credentials-file")
        .arg(credentials)
        .arg("--state-dir")
        .arg(state_dir)
        .arg("--sing-box-path")
        .arg(bin)
        .arg("--log-level")
        .arg("info")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

fn spawn_agent(base: &str, credentials: &Path, state_dir: &Path, bin: &Path, log: &Path) -> Child {
    let output = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .unwrap();
    let mut command = agent_command(base, credentials, state_dir, bin);
    command
        .stdout(Stdio::from(output.try_clone().unwrap()))
        .stderr(Stdio::from(output))
        .spawn()
        .unwrap()
}

async fn stop_agent(child: &mut Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn wait_until<F>(timeout_after: Duration, mut condition: F)
where
    F: FnMut() -> bool,
{
    let deadline = tokio::time::Instant::now() + timeout_after;
    while tokio::time::Instant::now() < deadline {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("condition did not hold within {timeout_after:?}");
}

#[tokio::test]
async fn enroll_writes_the_response_verbatim_without_printing_secrets() {
    let (base, state) = spawn_control_plane().await;
    let dir = TestDir::new();
    let grant_file = dir.path().join("grant");
    let credentials = dir.path().join("credentials.json");
    write_secret_file(&grant_file, format!("{GRANT}\n").as_bytes());

    let output = Command::new(env!("CARGO_BIN_EXE_server-agent"))
        .arg("enroll")
        .arg("--url")
        .arg(&base)
        .arg("--grant-file")
        .arg(&grant_file)
        .arg("--credentials-file")
        .arg(&credentials)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let server = state.lock().unwrap();
    assert_eq!(server.redeem_requests.len(), 1);
    assert!(
        server.other_http.is_empty(),
        "enrollment must use the /api/agent/enrollment/redeem route: {:?}",
        server.other_http
    );
    assert_eq!(
        server.redeem_requests[0],
        serde_json::to_vec(&json!({
            "enrollmentGrant": GRANT
        }))
        .unwrap()
    );
    let expected = server.last_redeem_body.as_ref().expect("redeem response");
    assert_eq!(&fs::read(&credentials).unwrap(), expected);
    drop(server);

    use std::os::unix::fs::PermissionsExt as _;
    assert_eq!(
        fs::metadata(&credentials).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stdout.contains(INITIAL_SECRET));
    assert!(!stderr.contains(INITIAL_SECRET));
    assert!(!stdout.contains(GRANT));
    assert!(!stderr.contains(GRANT));
}

#[tokio::test]
async fn enroll_refuses_an_unprotected_grant_before_any_request() {
    use std::os::unix::fs::PermissionsExt as _;

    let (base, state) = spawn_control_plane().await;
    let dir = TestDir::new();
    let grant_file = dir.path().join("grant");
    let credentials = dir.path().join("credentials.json");
    fs::write(&grant_file, format!("{GRANT}\n")).unwrap();
    fs::set_permissions(&grant_file, fs::Permissions::from_mode(0o644)).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_server-agent"))
        .arg("enroll")
        .arg("--url")
        .arg(&base)
        .arg("--grant-file")
        .arg(&grant_file)
        .arg("--credentials-file")
        .arg(&credentials)
        .output()
        .await
        .unwrap();
    assert!(!output.status.success());
    assert!(state.lock().unwrap().redeem_requests.is_empty());
    assert!(!credentials.exists());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("0600"), "{stderr}");
    assert!(!stderr.contains(GRANT), "{stderr}");
}

#[tokio::test]
async fn a_rejected_enrollment_is_attempted_once_and_writes_nothing() {
    let (base, state) = spawn_control_plane().await;
    state.lock().unwrap().redeem_status = 409;
    let dir = TestDir::new();
    let grant_file = dir.path().join("grant");
    let credentials = dir.path().join("credentials.json");
    write_secret_file(&grant_file, format!("{GRANT}\n").as_bytes());

    let output = Command::new(env!("CARGO_BIN_EXE_server-agent"))
        .arg("enroll")
        .arg("--url")
        .arg(&base)
        .arg("--grant-file")
        .arg(&grant_file)
        .arg("--credentials-file")
        .arg(&credentials)
        .output()
        .await
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(state.lock().unwrap().redeem_requests.len(), 1);
    assert!(!credentials.exists());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("invalid_grant"), "{stderr}");
    assert!(!stderr.contains(GRANT), "{stderr}");
    assert!(!stderr.contains(INITIAL_SECRET), "{stderr}");
}

#[tokio::test]
async fn enrollment_rejects_a_response_on_another_origin() {
    let (base, state) = spawn_control_plane().await;
    let mut foreign: Value =
        serde_json::from_slice(&credential_bytes(&base, INITIAL_SECRET, 1, 900)).unwrap();
    foreign["tokenEndpoint"] = json!("https://evil.example/api/auth/oauth2/token");
    state.lock().unwrap().redeem_body = Some(serde_json::to_vec(&foreign).unwrap());
    let dir = TestDir::new();
    let grant_file = dir.path().join("grant");
    let credentials = dir.path().join("credentials.json");
    write_secret_file(&grant_file, format!("{GRANT}\n").as_bytes());

    let output = Command::new(env!("CARGO_BIN_EXE_server-agent"))
        .arg("enroll")
        .arg("--url")
        .arg(&base)
        .arg("--grant-file")
        .arg(&grant_file)
        .arg("--credentials-file")
        .arg(&credentials)
        .output()
        .await
        .unwrap();
    assert!(!output.status.success());
    assert!(!credentials.exists());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stderr.contains(INITIAL_SECRET), "{stderr}");
    assert!(!stderr.contains(GRANT), "{stderr}");
}

#[tokio::test]
async fn service_uses_v2_without_the_protocol_flag_refreshes_and_rotates() {
    let (base, state) = spawn_control_plane().await;
    state.lock().unwrap().token_expires_in = 2;
    let dir = TestDir::new();
    let state_dir = dir.path().join("state");
    fs::create_dir_all(&state_dir).unwrap();
    let credentials = dir.path().join("credentials.json");
    write_secret_file(
        &credentials,
        &credential_bytes(&base, INITIAL_SECRET, 1, 900),
    );
    let run_log = dir.path().join("sing-box.log");
    let agent_log = dir.path().join("agent.log");
    let bin = dir.path().join("sing-box");
    write_fake_singbox(&bin, &run_log);

    let mut agent = spawn_agent(&base, &credentials, &state_dir, &bin, &agent_log);
    wait_until(Duration::from_secs(15), || {
        let state = state.lock().unwrap();
        state.ws_tokens.len() >= 2 && state.token_requests.len() >= 2
    })
    .await;

    {
        let state = state.lock().unwrap();
        assert_eq!(state.token_requests[0].1, INITIAL_SECRET);
        assert!(state.other_http.is_empty(), "{:?}", state.other_http);
        for token in &state.ws_tokens {
            assert!(
                token.starts_with("Bearer header"),
                "unexpected authorization header: {token}"
            );
        }
    }

    write_secret_file(
        &credentials,
        &credential_bytes(&base, ROTATED_SECRET, 2, 900),
    );
    wait_until(Duration::from_secs(15), || {
        let state = state.lock().unwrap();
        state
            .token_requests
            .iter()
            .any(|(client, secret)| client == CLIENT_ID && secret == ROTATED_SECRET)
    })
    .await;

    {
        let state = state.lock().unwrap();
        assert!(state.other_http.is_empty(), "{:?}", state.other_http);
    }
    stop_agent(&mut agent).await;
    let log = fs::read_to_string(&agent_log).unwrap_or_default();
    assert!(!log.contains(INITIAL_SECRET), "{log}");
    assert!(!log.contains(ROTATED_SECRET), "{log}");
    for index in 1..=4 {
        assert!(!log.contains(&format!("header{index}.payload")), "{log}");
    }
}

#[tokio::test]
async fn service_restarts_with_the_same_credential_and_v2_handshake() {
    let (base, state) = spawn_control_plane().await;
    state.lock().unwrap().token_expires_in = 900;
    let dir = TestDir::new();
    let state_dir = dir.path().join("state");
    fs::create_dir_all(&state_dir).unwrap();
    let credentials = dir.path().join("credentials.json");
    write_secret_file(
        &credentials,
        &credential_bytes(&base, INITIAL_SECRET, 1, 900),
    );
    let run_log = dir.path().join("sing-box.log");
    let agent_log = dir.path().join("agent.log");
    let bin = dir.path().join("sing-box");
    write_fake_singbox(&bin, &run_log);

    let mut first = spawn_agent(&base, &credentials, &state_dir, &bin, &agent_log);
    wait_until(Duration::from_secs(10), || {
        !state.lock().unwrap().ws_tokens.is_empty()
    })
    .await;
    stop_agent(&mut first).await;

    let mut second = spawn_agent(&base, &credentials, &state_dir, &bin, &agent_log);
    wait_until(Duration::from_secs(10), || {
        state.lock().unwrap().ws_tokens.len() >= 2
    })
    .await;
    {
        let state = state.lock().unwrap();
        assert!(state.token_requests.len() >= 2);
        assert!(state.other_http.is_empty(), "{:?}", state.other_http);
    }
    stop_agent(&mut second).await;
}

#[tokio::test]
async fn service_refuses_unprotected_credentials_without_printing_the_secret() {
    use std::os::unix::fs::PermissionsExt as _;

    let (base, state) = spawn_control_plane().await;
    let dir = TestDir::new();
    let state_dir = dir.path().join("state");
    fs::create_dir_all(&state_dir).unwrap();
    let credentials = dir.path().join("credentials.json");
    fs::write(
        &credentials,
        credential_bytes(&base, INITIAL_SECRET, 1, 900),
    )
    .unwrap();
    fs::set_permissions(&credentials, fs::Permissions::from_mode(0o644)).unwrap();
    let run_log = dir.path().join("sing-box.log");
    let bin = dir.path().join("sing-box");
    write_fake_singbox(&bin, &run_log);

    let output = timeout(
        Duration::from_secs(10),
        agent_command(&base, &credentials, &state_dir, &bin).output(),
    )
    .await
    .expect("the agent exited")
    .unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("0600"), "{stderr}");
    assert!(!stderr.contains(INITIAL_SECRET), "{stderr}");
    assert!(state.lock().unwrap().token_requests.is_empty());
}

#[tokio::test]
async fn an_oauth_outage_keeps_the_last_known_good_proxy_running() {
    let (base, state) = spawn_control_plane().await;
    state.lock().unwrap().token_status = 503;
    let dir = TestDir::new();
    let state_dir = dir.path().join("state");
    fs::create_dir_all(&state_dir).unwrap();
    let last_good = json!({
        "log": {"level": "info"},
        "inbounds": [{
            "type": "socks",
            "tag": "legacy",
            "listen": "127.0.0.1",
            "listen_port": 1080,
        }],
        "outbounds": [{"type": "direct", "tag": "direct"}],
    });
    fs::write(
        state_dir.join("last-known-good.json"),
        serde_json::to_vec_pretty(&last_good).unwrap(),
    )
    .unwrap();
    let credentials = dir.path().join("credentials.json");
    write_secret_file(
        &credentials,
        &credential_bytes(&base, INITIAL_SECRET, 1, 900),
    );
    let run_log = dir.path().join("sing-box.log");
    let agent_log = dir.path().join("agent.log");
    let bin = dir.path().join("sing-box");
    write_fake_singbox(&bin, &run_log);

    let mut agent = spawn_agent(&base, &credentials, &state_dir, &bin, &agent_log);
    wait_until(Duration::from_secs(10), || {
        fs::read_to_string(&run_log)
            .unwrap_or_default()
            .lines()
            .any(|line| line.starts_with("run "))
    })
    .await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(
        agent.try_wait().unwrap().is_none(),
        "the agent exited during the OAuth outage: {}",
        fs::read_to_string(&agent_log).unwrap_or_default()
    );
    assert!(
        !state.lock().unwrap().token_requests.is_empty(),
        "the agent did not retry the token endpoint"
    );
    assert!(state.lock().unwrap().other_http.is_empty());
    stop_agent(&mut agent).await;
    let log = fs::read_to_string(&agent_log).unwrap_or_default();
    assert!(!log.contains(INITIAL_SECRET), "{log}");
}
