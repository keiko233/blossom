//! Command-line surface, environment bindings, and startup resolution.
//!
//! Flags mirror the `AGENT_*` environment variables so the container entry
//! point and the systemd unit share one configuration vocabulary. Protocol
//! selection, credential exclusivity, and the WebSocket/native-services
//! compatibility rules are resolved here, before any runtime work starts.

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use tracing::warn;

use crate::oauth;
use crate::pty;
use crate::service;

pub(crate) const AGENT_CAPABILITIES: &[&str] = &[
    #[cfg(target_os = "linux")]
    "telemetry-v1",
    "config-v3",
    "managed-tls-v3",
    "certificate-deployments-v1",
    "atomic-config-rollback",
    "connection-stream-traffic",
    "ws-v1",
    "acme-v1",
];
pub(crate) const PTY_CAPABILITY: &str = "pty-v1";

pub(crate) fn agent_capabilities(pty_enabled: bool) -> Vec<&'static str> {
    let mut capabilities = AGENT_CAPABILITIES.to_vec();
    if pty_enabled {
        capabilities.push(PTY_CAPABILITY);
    }
    capabilities
}
#[derive(Parser)]
#[command(name = "server-agent", version, about = "blossom proxy server agent")]
pub(crate) struct Cli {
    #[command(subcommand)]
    pub(crate) command: Option<Command>,

    #[command(flatten)]
    pub(crate) service: Args,
}

#[derive(Subcommand)]
pub(crate) enum Command {
    /// Redeem one enrollment grant and write a protected credential file.
    Enroll(oauth::EnrollArgs),
    /// Installer-owned local service lifecycle boundary. Hidden from ordinary
    /// operation; the agent never invokes this subcommand directly.
    #[command(hide = true)]
    ServiceControl(service::ServiceControlArgs),
}

#[derive(clap::Args)]
pub(crate) struct Args {
    /// Base URL of the blossom API, including the `/api` prefix
    /// (e.g. http://localhost:3000/api).
    #[arg(long, env = "AGENT_URL")]
    pub(crate) url: Option<String>,

    /// Per-server agent token (shown once at server creation or token reset).
    /// Static-token mode is for legacy/backup installations; OAuth
    /// installations use `--credentials-file` instead.
    #[arg(long, env = "AGENT_TOKEN")]
    pub(crate) token: Option<String>,

    /// OAuth machine credential file written by `server-agent enroll`.
    /// Selecting this file enables protocol v2 automatically.
    #[arg(long, env = "AGENT_CREDENTIALS_FILE", value_name = "FILE")]
    pub(crate) credentials_file: Option<PathBuf>,

    /// Bootstrap interval until the control plane returns per-server settings.
    #[arg(
        long,
        default_value_t = 60,
        env = "AGENT_INTERVAL",
        value_parser = clap::value_parser!(u64).range(1..)
    )]
    pub(crate) interval: u64,

    /// Log level: trace, debug, info, warn, or error.
    #[arg(long, default_value = "info", env = "AGENT_LOG_LEVEL")]
    pub(crate) log_level: String,

    /// Path to the sing-box binary. Defaults to `./sing-box` then `sing-box` on PATH.
    #[arg(long, env = "AGENT_SING_BOX_PATH")]
    pub(crate) sing_box_path: Option<PathBuf>,

    /// Durable directory for the active and last-known-good sing-box configs.
    #[arg(
        long,
        default_value = "/var/lib/blossom-agent",
        env = "AGENT_STATE_DIR"
    )]
    pub(crate) state_dir: PathBuf,

    /// Directory for release download/extraction scratch files.
    #[arg(long, env = "AGENT_DOWNLOAD_DIR")]
    pub(crate) download_dir: Option<PathBuf>,

    /// Allow the agent to replace its own binary and exit for a supervisor restart.
    #[arg(
        long,
        default_value_t = false,
        num_args = 0..=1,
        default_missing_value = "true",
        env = "AGENT_SELF_UPDATE",
        value_parser = clap::builder::BoolishValueParser::new()
    )]
    pub(crate) self_update: bool,

    /// GitHub API base used to resolve release assets.
    #[arg(
        long,
        default_value = "https://api.github.com",
        env = "AGENT_GITHUB_API"
    )]
    pub(crate) github_api: String,

    /// Repository that publishes unified `v*` releases with `server-agent` static binaries.
    #[arg(long, default_value = "keiko233/blossom", env = "AGENT_RELEASE_REPO")]
    pub(crate) release_repo: String,

    /// Repository that publishes official sing-box releases.
    #[arg(
        long,
        default_value = "SagerNet/sing-box",
        env = "AGENT_SING_BOX_RELEASE_REPO"
    )]
    pub(crate) sing_box_release_repo: String,

    /// Optional GitHub token for release API/download rate limits.
    #[arg(long, env = "AGENT_GITHUB_TOKEN", hide_env_values = true)]
    pub(crate) github_token: Option<String>,

    /// Minimum delay before retrying a failed update to the same version.
    #[arg(
        long,
        default_value_t = 3600,
        env = "AGENT_UPDATE_RETRY_SECONDS",
        value_parser = clap::value_parser!(u64).range(60..)
    )]
    pub(crate) update_retry_seconds: u64,

    /// Connect the push WebSocket. This is required for protocol v2; the
    /// explicit legacy protocol may run with it disabled and use only the HTTP
    /// config poll and heartbeat.
    #[arg(
        long,
        default_value_t = true,
        num_args = 0..=1,
        default_missing_value = "true",
        env = "AGENT_WS_ENABLED",
        value_parser = clap::builder::BoolishValueParser::new()
    )]
    pub(crate) ws_enabled: bool,

    /// Agent WebSocket protocol. `v2` is the default for both OAuth credential
    /// files and explicit static backup tokens: configuration, status, and
    /// traffic travel over `blossom-agent.v2` and no HTTP agent API is used.
    /// `legacy` is an explicit opt-in for installations that still need the v1
    /// WebSocket with the HTTP config poll, heartbeat, and traffic reports.
    /// OAuth credentials are refused with `legacy`.
    #[arg(long, value_enum, env = "AGENT_WS_PROTOCOL")]
    pub(crate) ws_protocol: Option<WsProtocol>,

    /// Opt in to the installed native service lifecycle. The agent talks to
    /// the root-owned `blossom-service-control` helper instead of supervising
    /// sing-box as a child. Requires protocol v2; the installer enables it only
    /// on native Linux hosts after task 05 metering is ready.
    #[arg(
        long,
        default_value_t = false,
        env = "AGENT_NATIVE_SERVICE_CONTROL",
        value_parser = clap::builder::BoolishValueParser::new()
    )]
    pub(crate) native_service_control: bool,

    /// Local control socket of the privileged service-control helper.
    #[arg(
        long,
        default_value = "/run/blossom-service-control/control.sock",
        env = "AGENT_SERVICE_CONTROL_SOCKET"
    )]
    pub(crate) service_control_socket: PathBuf,

    /// Root-owned release tree used by the native helper.
    #[arg(
        long,
        default_value = "/var/lib/blossom-service-control",
        env = "AGENT_SERVICE_CONTROL_RELEASE_DIR"
    )]
    pub(crate) service_control_release_dir: PathBuf,

    /// Probation before a v2 candidate config is committed. A test harness knob.
    #[arg(
        long,
        hide = true,
        default_value_t = 11_000,
        env = "AGENT_V2_PROBATION_MS",
        value_parser = clap::value_parser!(u64).range(100..=60_000)
    )]
    pub(crate) v2_probation_ms: u64,

    /// How often v2 flushes sealed traffic reports. A test harness knob.
    #[arg(
        long,
        hide = true,
        default_value_t = 60,
        env = "AGENT_V2_TRAFFIC_INTERVAL_SECONDS",
        value_parser = clap::value_parser!(u64).range(1..=3_600)
    )]
    pub(crate) v2_traffic_interval_seconds: u64,

    /// Address the ephemeral HTTP-01 responder binds while an http-01 job is
    /// active. It is closed again as soon as the order finishes.
    #[arg(long, default_value = "0.0.0.0:80", env = "AGENT_ACME_HTTP_BIND")]
    pub(crate) acme_http_bind: SocketAddr,

    /// Delay after the control plane acknowledges a DNS TXT record and before
    /// the agent asks the CA to validate it.
    #[arg(
        long,
        default_value_t = 5,
        env = "AGENT_ACME_DNS_SETTLE_SECONDS",
        value_parser = clap::value_parser!(u64).range(0..=300)
    )]
    pub(crate) acme_dns_settle_seconds: u64,
    /// Enable interactive PTY sessions over the authenticated agent WebSocket.
    /// Off by default; the control plane only offers the terminal when the
    /// agent advertises `pty-v1`.
    #[arg(
        long,
        default_value_t = false,
        env = "AGENT_PTY_ENABLED",
        value_parser = clap::builder::BoolishValueParser::new()
    )]
    pub(crate) pty_enabled: bool,

    /// Maximum concurrent PTY sessions (1-4, default 1).
    #[arg(
        long,
        default_value_t = pty::DEFAULT_MAX_SESSIONS as u8,
        env = "AGENT_PTY_MAX_SESSIONS",
        value_parser = clap::value_parser!(u8).range(1..=4)
    )]
    pub(crate) pty_max_sessions: u8,

    /// Idle timeout for a PTY session in seconds (30-3600).
    #[arg(
        long,
        default_value_t = pty::DEFAULT_IDLE_TIMEOUT.as_secs(),
        env = "AGENT_PTY_IDLE_TIMEOUT_SECONDS",
        value_parser = clap::value_parser!(u64).range(30..=3600)
    )]
    pub(crate) pty_idle_timeout_seconds: u64,

    /// Hard maximum PTY session lifetime in seconds (60-86400).
    #[arg(
        long,
        default_value_t = pty::DEFAULT_MAX_SESSION.as_secs(),
        env = "AGENT_PTY_MAX_SESSION_SECONDS",
        value_parser = clap::value_parser!(u64).range(60..=86_400)
    )]
    pub(crate) pty_max_session_seconds: u64,

    /// Absolute path of the shell for PTY sessions. Unset uses the first
    /// runnable of /bin/bash and /bin/sh.
    #[arg(long, env = "AGENT_PTY_SHELL", value_parser = pty::launch::parse_shell_path)]
    pub(crate) pty_shell: Option<PathBuf>,

    /// Absolute working directory for PTY shells.
    #[arg(
        long,
        default_value = "/",
        env = "AGENT_PTY_WORKING_DIR",
        value_parser = pty::launch::parse_working_dir
    )]
    pub(crate) pty_working_dir: PathBuf,
}

/// The agent WebSocket protocol selected at start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub(crate) enum WsProtocol {
    /// Explicit legacy mode: the v1 WebSocket with HTTP config poll,
    /// heartbeat, and traffic.
    Legacy,
    /// Protocol v2 (the default): WebSocket-only, with no HTTP agent API calls.
    V2,
}

/// The credential input selected for this process. Exactly one is present.
pub(crate) enum AuthMode {
    Static(String),
    OAuth(PathBuf),
}

impl AuthMode {
    pub(crate) fn static_token(&self) -> Option<&str> {
        match self {
            Self::Static(token) => Some(token),
            Self::OAuth(_) => None,
        }
    }
}

/// Validated service startup inputs.
pub(crate) struct ServiceStartup {
    pub(crate) url: String,
    pub(crate) auth: AuthMode,
    pub(crate) protocol: WsProtocol,
}

/// The explicit WebSocket-disabled deprecation warning. It names the exact
/// action that keeps an existing static-token installation running and the
/// action that removes HTTP from the deployment.
const WS_DISABLED_DEPRECATION: &str = concat!(
    "agent websocket disabled without an explicit protocol; starting legacy HTTP-only mode. ",
    "This implicit fallback is deprecated: keep it explicitly with --ws-protocol legacy ",
    "(or AGENT_WS_PROTOCOL=legacy), or enable the websocket with --ws-enabled=true ",
    "(or AGENT_WS_ENABLED=true) to use protocol v2"
);

impl Args {
    /// Resolves the base URL, the one credential input, and the transport.
    ///
    /// Both OAuth credential files and explicit static backup tokens default to
    /// protocol v2, so the installer unit and the container entry point need no
    /// protocol flag. `--ws-protocol legacy` is the explicit compatibility
    /// opt-in; OAuth never falls back to a static token or HTTP.
    pub(crate) fn startup(&self) -> Result<ServiceStartup> {
        let url = self
            .url
            .as_deref()
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .ok_or_else(|| anyhow::anyhow!("--url (or AGENT_URL) is required"))?
            .to_string();

        let (auth, default_protocol) = match (self.token.as_deref(), &self.credentials_file) {
            (Some(token), None) => (AuthMode::Static(token.to_string()), WsProtocol::V2),
            (None, Some(path)) => (AuthMode::OAuth(path.clone()), WsProtocol::V2),
            (Some(_), Some(_)) => {
                return Err(anyhow::anyhow!(
                    "choose either --token (static backup) or --credentials-file (OAuth), not both"
                ));
            }
            (None, None) => {
                return Err(anyhow::anyhow!(
                    "one of --token (static) or --credentials-file (OAuth) is required"
                ));
            }
        };
        // A WS-disabled installation predates the v2 default. With no protocol
        // flag it keeps its HTTP poll/heartbeat path instead of failing to
        // start, but the fallback is explicit in the log and deprecated. An
        // explicit v2 request with the WebSocket disabled stays incompatible.
        let protocol = match (self.ws_protocol, self.ws_enabled) {
            (None, false) => WsProtocol::Legacy,
            (Some(protocol), _) => protocol,
            (None, true) => default_protocol,
        };
        let implicit_legacy = self.ws_protocol.is_none() && !self.ws_enabled;
        if matches!(auth, AuthMode::OAuth(_)) && protocol != WsProtocol::V2 {
            return Err(anyhow::anyhow!(
                "OAuth credentials require protocol v2; legacy HTTP-only mode needs a static token and --ws-protocol legacy"
            ));
        }
        if !self.ws_enabled && protocol == WsProtocol::V2 {
            return Err(anyhow::anyhow!(
                "protocol v2 is the WebSocket path and cannot run with --ws-enabled=false; use --ws-protocol legacy with a static token for HTTP-only mode"
            ));
        }
        if self.native_service_control && protocol != WsProtocol::V2 {
            return Err(anyhow::anyhow!(
                "the native service lifecycle requires protocol v2; legacy HTTP-only mode keeps processkit supervision"
            ));
        }
        if implicit_legacy {
            warn!(WS_DISABLED_DEPRECATION);
        }
        Ok(ServiceStartup {
            url,
            auth,
            protocol,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{AGENT_CAPABILITIES, Cli, PTY_CAPABILITY, WsProtocol, agent_capabilities};
    use clap::Parser as _;

    #[test]
    fn advertises_the_websocket_capability() {
        assert!(AGENT_CAPABILITIES.contains(&"ws-v1"));
        assert!(AGENT_CAPABILITIES.contains(&"acme-v1"));
    }

    #[test]
    fn advertises_pty_only_when_opted_in() {
        assert!(!agent_capabilities(false).contains(&PTY_CAPABILITY));
        assert!(agent_capabilities(true).contains(&PTY_CAPABILITY));
    }

    /// Serializes startup parsing because clap reads the process environment.
    static SERVICE_STARTUP_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn parse_service_startup(arguments: &[&str]) -> anyhow::Result<super::ServiceStartup> {
        let mut argv = vec!["server-agent"];
        argv.extend_from_slice(arguments);
        let cli = Cli::try_parse_from(argv).expect("CLI parses");
        cli.service.startup()
    }

    fn service_startup(arguments: &[&str]) -> anyhow::Result<super::ServiceStartup> {
        let _guard = SERVICE_STARTUP_ENV
            .lock()
            .expect("startup environment lock");
        parse_service_startup(arguments)
    }

    #[test]
    fn a_credentials_file_selects_v2_without_an_explicit_protocol() {
        let startup = service_startup(&[
            "--url",
            "http://127.0.0.1:1/api",
            "--credentials-file",
            "/tmp/credentials.json",
        ])
        .expect("OAuth startup resolves");
        assert_eq!(startup.protocol, WsProtocol::V2);
        assert!(startup.auth.static_token().is_none());
    }

    #[test]
    fn a_static_token_selects_v2_by_default_and_can_opt_into_legacy() {
        let default = service_startup(&["--url", "http://127.0.0.1:1/api", "--token", "agt_test"])
            .expect("static startup resolves");
        assert_eq!(default.protocol, WsProtocol::V2);
        assert_eq!(default.auth.static_token(), Some("agt_test"));

        let legacy = service_startup(&[
            "--url",
            "http://127.0.0.1:1/api",
            "--token",
            "agt_test",
            "--ws-protocol",
            "legacy",
        ])
        .expect("static legacy startup resolves");
        assert_eq!(legacy.protocol, WsProtocol::Legacy);
    }

    #[test]
    fn a_ws_disabled_static_installation_without_a_protocol_starts_legacy() {
        let cli = service_startup(&[
            "--url",
            "http://127.0.0.1:1/api",
            "--token",
            "agt_test",
            "--ws-enabled=false",
        ])
        .expect("disabled websocket plus a static token keeps HTTP-only mode");
        assert_eq!(cli.protocol, WsProtocol::Legacy);
        assert_eq!(cli.auth.static_token(), Some("agt_test"));

        let enabled_false = service_startup(&[
            "--url",
            "http://127.0.0.1:1/api",
            "--token",
            "agt_test",
            "--ws-protocol",
            "legacy",
            "--ws-enabled=false",
        ])
        .expect("explicit legacy plus disabled websocket resolves");
        assert_eq!(enabled_false.protocol, WsProtocol::Legacy);
    }

    #[test]
    fn an_environment_ws_disable_has_the_same_precedence_as_the_flag() {
        const KEY: &str = "AGENT_WS_ENABLED";
        // Startup parsing takes the same lock, so no concurrent test can
        // observe this test's temporary environment value.
        let _guard = SERVICE_STARTUP_ENV
            .lock()
            .expect("startup environment lock");
        let parse = |value: &str| {
            // SAFETY: the startup environment lock is held across the set,
            // parse and removal.
            unsafe { std::env::set_var(KEY, value) };
            let result =
                parse_service_startup(&["--url", "http://127.0.0.1:1/api", "--token", "agt_test"]);
            // SAFETY: paired with the set above while the lock is still held.
            unsafe { std::env::remove_var(KEY) };
            result
        };
        let startup = parse("false").expect("AGENT_WS_ENABLED=false resolves legacy");
        assert_eq!(startup.protocol, WsProtocol::Legacy);
        let startup = parse("true").expect("AGENT_WS_ENABLED=true keeps the v2 default");
        assert_eq!(startup.protocol, WsProtocol::V2);
    }

    #[test]
    fn an_incompatible_explicit_protocol_and_websocket_state_is_rejected() {
        assert!(
            service_startup(&[
                "--url",
                "http://127.0.0.1:1/api",
                "--token",
                "agt_test",
                "--ws-protocol",
                "v2",
                "--ws-enabled=false",
            ])
            .is_err()
        );
        assert!(
            service_startup(&[
                "--url",
                "http://127.0.0.1:1/api",
                "--credentials-file",
                "/tmp/credentials.json",
                "--ws-enabled=false",
            ])
            .is_err()
        );
    }

    #[test]
    fn oauth_never_downgrades_to_legacy_or_accepts_two_credentials() {
        assert!(
            service_startup(&[
                "--url",
                "http://127.0.0.1:1/api",
                "--credentials-file",
                "/tmp/credentials.json",
                "--ws-protocol",
                "legacy",
            ])
            .is_err()
        );
        assert!(
            service_startup(&[
                "--url",
                "http://127.0.0.1:1/api",
                "--credentials-file",
                "/tmp/credentials.json",
                "--token",
                "agt_test",
            ])
            .is_err()
        );
    }

    #[test]
    fn the_installer_self_update_value_is_accepted() {
        let parse = |arguments: &[&str]| {
            let mut argv = vec!["server-agent"];
            argv.extend_from_slice(arguments);
            Cli::try_parse_from(argv).expect("CLI parses")
        };

        assert!(!parse(&[]).service.self_update);
        assert!(!parse(&["--self-update=false"]).service.self_update);
        assert!(parse(&["--self-update=true"]).service.self_update);
        assert!(parse(&["--self-update"]).service.self_update);
    }
}
