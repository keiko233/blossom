//! server-agent: runs sing-box on a proxy server host, driven by the blossom
//! control plane. It pulls the server's full multi-inbound sing-box config over
//! the `/api` surface, keeps sing-box running (restart on crash and verified
//! process replacement on config change), and heartbeats its version back to
//! the server.
//! A server owns one agent token and one running sing-box process; each "node"
//! on that server is compiled as one inbound inside that single config.

mod accountant;
mod acme;
mod agent_v2;
mod certificate;
mod client;
mod config;
mod log_policy;
mod logs;
mod oauth;
mod process;
mod pty;
#[expect(
    dead_code,
    unused_imports,
    reason = "opt-in lifecycle foundation; native activation is gated on task 05"
)]
mod service;
mod stats;
#[cfg(target_os = "linux")]
mod telemetry;
mod traffic;
mod update;
mod ws;

use std::net::SocketAddr;
use std::num::NonZeroU64;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use chrono::Utc;
use clap::{Parser, Subcommand};
use tokio::signal;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::reload;
use tracing_subscriber::util::SubscriberInitExt as _;

use crate::acme::AcmeManager;
use crate::acme::instant_backend::InstantAcmeBackend;
use crate::acme::ports::DEFAULT_CHALLENGE_TIMEOUT;
use crate::acme::solver_dns01::DnsAck;
use crate::config::{AgentPolicy, CandidateConfig, ConfigError, ConfigManager, FetchStatus};
use crate::log_policy::{
    AgentFilter, DecisionReason, Level as PolicyLevel, LogOverlay, LogPolicy, PolicyAction,
    PolicyStatus, Source as PolicySource,
};
use crate::logs::{CaptureLayer, LogStore, SecretScope};
use crate::process::{ProcessState, SingBoxManager, check_config, resolve_binary, singbox_version};
use crate::traffic::TrafficReporter;
use crate::update::{
    AGENT_RESTART_EXIT_CODE, UpdateConfig, UpdateManager, UpdateStatus, supports_singbox_version,
};
use crate::ws::adapters::{SensitiveHeader, TokioWsTransport, WsTransportConfig, ws_url};
use crate::ws::codec::{
    AgentMessage, AgentWsFrame, CertificateDeployment, ConfigAckPayload, HelloPayload,
    UpdateStatePayload, UpdateStatusPayload, UpdateTarget, UpdateTriggerPayload, WelcomePayload,
    frame_type,
};
use crate::ws::ports::{AgentCommandSink, ChannelCommandSink, WsCommand, WsEvent};

const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const AGENT_BUILD_ID: &str = env!("AGENT_BUILD_ID");
const AGENT_CAPABILITIES: &[&str] = &[
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
const PTY_CAPABILITY: &str = "pty-v1";
const RUNTIME_PROBATION: Duration = Duration::from_secs(11);

fn agent_capabilities(pty_enabled: bool) -> Vec<&'static str> {
    let mut capabilities = AGENT_CAPABILITIES.to_vec();
    if pty_enabled {
        capabilities.push(PTY_CAPABILITY);
    }
    capabilities
}

#[derive(Parser)]
#[command(name = "server-agent", version, about = "blossom proxy server agent")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    #[command(flatten)]
    service: Args,
}

#[derive(Subcommand)]
enum Command {
    /// Redeem one enrollment grant and write a protected credential file.
    Enroll(oauth::EnrollArgs),
}

#[derive(clap::Args)]
struct Args {
    /// Base URL of the blossom API, including the `/api` prefix
    /// (e.g. http://localhost:3000/api).
    #[arg(long, env = "AGENT_URL")]
    url: Option<String>,

    /// Per-server agent token (shown once at server creation or token reset).
    /// Static-token mode is for legacy/backup installations; OAuth
    /// installations use `--credentials-file` instead.
    #[arg(long, env = "AGENT_TOKEN")]
    token: Option<String>,

    /// OAuth machine credential file written by `server-agent enroll`.
    /// Selecting this file enables protocol v2 automatically.
    #[arg(long, env = "AGENT_CREDENTIALS_FILE", value_name = "FILE")]
    credentials_file: Option<PathBuf>,

    /// Bootstrap interval until the control plane returns per-server settings.
    #[arg(
        long,
        default_value_t = 60,
        env = "AGENT_INTERVAL",
        value_parser = clap::value_parser!(u64).range(1..)
    )]
    interval: u64,

    /// Log level: trace, debug, info, warn, or error.
    #[arg(long, default_value = "info", env = "AGENT_LOG_LEVEL")]
    log_level: String,

    /// Path to the sing-box binary. Defaults to `./sing-box` then `sing-box` on PATH.
    #[arg(long, env = "AGENT_SING_BOX_PATH")]
    sing_box_path: Option<PathBuf>,

    /// Durable directory for the active and last-known-good sing-box configs.
    #[arg(
        long,
        default_value = "/var/lib/blossom-agent",
        env = "AGENT_STATE_DIR"
    )]
    state_dir: PathBuf,

    /// Directory for release download/extraction scratch files.
    #[arg(long, env = "AGENT_DOWNLOAD_DIR")]
    download_dir: Option<PathBuf>,

    /// Allow the agent to replace its own binary and exit for a supervisor restart.
    #[arg(
        long,
        default_value_t = false,
        num_args = 0..=1,
        default_missing_value = "true",
        env = "AGENT_SELF_UPDATE",
        value_parser = clap::builder::BoolishValueParser::new()
    )]
    self_update: bool,

    /// GitHub API base used to resolve release assets.
    #[arg(
        long,
        default_value = "https://api.github.com",
        env = "AGENT_GITHUB_API"
    )]
    github_api: String,

    /// Repository that publishes unified `v*` releases with `server-agent` static binaries.
    #[arg(long, default_value = "keiko233/blossom", env = "AGENT_RELEASE_REPO")]
    release_repo: String,

    /// Repository that publishes official sing-box releases.
    #[arg(
        long,
        default_value = "SagerNet/sing-box",
        env = "AGENT_SING_BOX_RELEASE_REPO"
    )]
    sing_box_release_repo: String,

    /// Optional GitHub token for release API/download rate limits.
    #[arg(long, env = "AGENT_GITHUB_TOKEN", hide_env_values = true)]
    github_token: Option<String>,

    /// Minimum delay before retrying a failed update to the same version.
    #[arg(
        long,
        default_value_t = 3600,
        env = "AGENT_UPDATE_RETRY_SECONDS",
        value_parser = clap::value_parser!(u64).range(60..)
    )]
    update_retry_seconds: u64,

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
    ws_enabled: bool,

    /// Agent WebSocket protocol. `v2` is the default for both OAuth credential
    /// files and explicit static backup tokens: configuration, status, and
    /// traffic travel over `blossom-agent.v2` and no HTTP agent API is used.
    /// `legacy` is an explicit opt-in for installations that still need the v1
    /// WebSocket with the HTTP config poll, heartbeat, and traffic reports.
    /// OAuth credentials are refused with `legacy`.
    #[arg(long, value_enum, env = "AGENT_WS_PROTOCOL")]
    ws_protocol: Option<WsProtocol>,

    /// Probation before a v2 candidate config is committed. A test harness knob.
    #[arg(
        long,
        hide = true,
        default_value_t = 11_000,
        env = "AGENT_V2_PROBATION_MS",
        value_parser = clap::value_parser!(u64).range(100..=60_000)
    )]
    v2_probation_ms: u64,

    /// How often v2 flushes sealed traffic reports. A test harness knob.
    #[arg(
        long,
        hide = true,
        default_value_t = 60,
        env = "AGENT_V2_TRAFFIC_INTERVAL_SECONDS",
        value_parser = clap::value_parser!(u64).range(1..=3_600)
    )]
    v2_traffic_interval_seconds: u64,

    /// Address the ephemeral HTTP-01 responder binds while an http-01 job is
    /// active. It is closed again as soon as the order finishes.
    #[arg(long, default_value = "0.0.0.0:80", env = "AGENT_ACME_HTTP_BIND")]
    acme_http_bind: SocketAddr,

    /// Delay after the control plane acknowledges a DNS TXT record and before
    /// the agent asks the CA to validate it.
    #[arg(
        long,
        default_value_t = 5,
        env = "AGENT_ACME_DNS_SETTLE_SECONDS",
        value_parser = clap::value_parser!(u64).range(0..=300)
    )]
    acme_dns_settle_seconds: u64,
    /// Enable interactive PTY sessions over the authenticated agent WebSocket.
    /// Off by default; the control plane only offers the terminal when the
    /// agent advertises `pty-v1`.
    #[arg(
        long,
        default_value_t = false,
        env = "AGENT_PTY_ENABLED",
        value_parser = clap::builder::BoolishValueParser::new()
    )]
    pty_enabled: bool,

    /// Maximum concurrent PTY sessions (1-4, default 1).
    #[arg(
        long,
        default_value_t = pty::DEFAULT_MAX_SESSIONS as u8,
        env = "AGENT_PTY_MAX_SESSIONS",
        value_parser = clap::value_parser!(u8).range(1..=4)
    )]
    pty_max_sessions: u8,

    /// Idle timeout for a PTY session in seconds (30-3600).
    #[arg(
        long,
        default_value_t = pty::DEFAULT_IDLE_TIMEOUT.as_secs(),
        env = "AGENT_PTY_IDLE_TIMEOUT_SECONDS",
        value_parser = clap::value_parser!(u64).range(30..=3600)
    )]
    pty_idle_timeout_seconds: u64,

    /// Hard maximum PTY session lifetime in seconds (60-86400).
    #[arg(
        long,
        default_value_t = pty::DEFAULT_MAX_SESSION.as_secs(),
        env = "AGENT_PTY_MAX_SESSION_SECONDS",
        value_parser = clap::value_parser!(u64).range(60..=86_400)
    )]
    pty_max_session_seconds: u64,

    /// Absolute path of the shell for PTY sessions. Unset uses the first
    /// runnable of /bin/bash and /bin/sh.
    #[arg(long, env = "AGENT_PTY_SHELL", value_parser = pty::launch::parse_shell_path)]
    pty_shell: Option<PathBuf>,

    /// Absolute working directory for PTY shells.
    #[arg(
        long,
        default_value = "/",
        env = "AGENT_PTY_WORKING_DIR",
        value_parser = pty::launch::parse_working_dir
    )]
    pty_working_dir: PathBuf,
}

/// The agent WebSocket protocol selected at start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
enum WsProtocol {
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
    fn startup(&self) -> Result<ServiceStartup> {
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

fn new_update_manager(args: &Args, sing_box_version: Option<String>) -> Result<UpdateManager> {
    let state_dir = args.state_dir.clone();
    UpdateManager::new(
        UpdateConfig {
            state_dir: state_dir.clone(),
            download_dir: args
                .download_dir
                .clone()
                .unwrap_or_else(|| state_dir.join("downloads")),
            github_api: args.github_api.clone(),
            agent_repo: args.release_repo.clone(),
            singbox_repo: args.sing_box_release_repo.clone(),
            github_token: args.github_token.clone(),
            self_update: args.self_update,
            retry_after: Duration::from_secs(args.update_retry_seconds),
        },
        AGENT_VERSION.to_string(),
        sing_box_version,
    )
}

fn new_pty_manager(args: &Args, events: mpsc::Sender<pty::PtyEvent>) -> (pty::PtyManager, bool) {
    // A root agent would hand the browser a root shell, so PTY stays off there
    // even when opted in. The installer runs the agent as a dedicated account.
    let identity = pty::PtyIdentity::current();
    let enabled = args.pty_enabled && !identity.is_root();
    if args.pty_enabled && !enabled {
        error!(
            "agent PTY terminal disabled: the agent runs as root; run it under its dedicated non-root service account"
        );
    }
    let launch = pty::launch::LaunchConfig {
        shell: args.pty_shell.clone(),
        working_dir: args.pty_working_dir.clone(),
    };
    let manager = pty::PtyManager::new(
        pty::PtyLimits::new(
            enabled,
            args.pty_max_sessions as usize,
            Duration::from_secs(args.pty_idle_timeout_seconds),
            Duration::from_secs(args.pty_max_session_seconds),
        ),
        identity.user.clone(),
        Box::new(pty::session::PortablePtyFactory::new(
            events,
            launch.clone(),
            identity.user.clone(),
        )),
    );
    if enabled {
        info!(
            max_sessions = manager.limits().max_sessions(),
            idle_timeout_seconds = manager.limits().idle_timeout().as_secs(),
            max_session_seconds = manager.limits().max_session().as_secs(),
            working_dir = %args.pty_working_dir.display(),
            user = %identity.user,
            "agent PTY terminal enabled"
        );
        match pty::launch::resolve_shell(launch.shell.as_deref(), pty::launch::is_runnable_file) {
            Ok(shell) => info!(shell = %shell.display(), "PTY shell resolved"),
            Err(error) => warn!("PTY sessions will fail until this is fixed: {error}"),
        }
    } else {
        info!("agent PTY terminal disabled; set AGENT_PTY_ENABLED=true to opt in");
    }
    (manager, enabled)
}

fn new_acme_manager(args: &Args, sink: Arc<dyn AgentCommandSink>) -> Arc<AcmeManager> {
    Arc::new(AcmeManager::new(
        Arc::new(InstantAcmeBackend::new()),
        args.acme_http_bind,
        sink,
        DEFAULT_CHALLENGE_TIMEOUT + Duration::from_secs(30),
        Duration::from_secs(args.acme_dns_settle_seconds),
    ))
}

fn parse_level(level: &str) -> tracing::Level {
    match level.to_lowercase().as_str() {
        "trace" => tracing::Level::TRACE,
        "debug" => tracing::Level::DEBUG,
        "warn" => tracing::Level::WARN,
        "error" => tracing::Level::ERROR,
        _ => tracing::Level::INFO,
    }
}

fn policy_level(level: &str) -> PolicyLevel {
    match parse_level(level) {
        tracing::Level::TRACE => PolicyLevel::Trace,
        tracing::Level::DEBUG => PolicyLevel::Debug,
        tracing::Level::WARN => PolicyLevel::Warn,
        tracing::Level::ERROR => PolicyLevel::Error,
        _ => PolicyLevel::Info,
    }
}

fn tracing_level(level: PolicyLevel) -> tracing::Level {
    match level {
        PolicyLevel::Trace => tracing::Level::TRACE,
        PolicyLevel::Debug => tracing::Level::DEBUG,
        PolicyLevel::Warn => tracing::Level::WARN,
        PolicyLevel::Error => tracing::Level::ERROR,
        // `default` is resolved to a concrete baseline before it reaches a
        // filter, so `info` is only a defensive fallback.
        PolicyLevel::Default | PolicyLevel::Info => tracing::Level::INFO,
    }
}

struct ReloadingFilter {
    handle: reload::Handle<LevelFilter, tracing_subscriber::Registry>,
}

impl AgentFilter for ReloadingFilter {
    fn set_level(&self, level: PolicyLevel) -> Result<(), String> {
        self.handle
            .reload(LevelFilter::from_level(tracing_level(level)))
            .map_err(|error| error.to_string())
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    if let Some(Command::Enroll(enroll)) = &cli.command {
        return oauth::run_enroll(enroll).await;
    }
    let args = cli.service;
    let startup = args.startup()?;

    let _ = rustls::crypto::ring::default_provider().install_default();
    let logs = LogStore::shared();
    let agent_baseline = policy_level(&args.log_level);
    let (level_filter, level_handle) =
        reload::Layer::new(LevelFilter::from_level(parse_level(&args.log_level)));
    tracing_subscriber::registry()
        .with(level_filter)
        .with(tracing_subscriber::fmt::layer())
        .with(CaptureLayer::new(logs.clone()))
        .init();
    let (log_policy, policy_warnings) = LogPolicy::load(
        &args.state_dir,
        agent_baseline,
        Arc::new(ReloadingFilter {
            handle: level_handle,
        }),
        Utc::now(),
    );
    let log_policy = Arc::new(log_policy);
    for warning in policy_warnings {
        warn!("{warning}");
    }
    let agent_secrets: Vec<&str> = startup
        .auth
        .static_token()
        .into_iter()
        .chain(args.github_token.as_deref())
        .collect();
    logs.replace_secrets(SecretScope::Agent, agent_secrets)?;
    if startup.protocol == WsProtocol::V2 {
        return agent_v2::run(&args, &startup, logs.clone(), log_policy).await;
    }

    let token = startup
        .auth
        .static_token()
        .expect("legacy protocol requires a static token");
    let client = client::new_client(&startup.url, token)?;

    let bin = resolve_binary(args.sing_box_path.clone());
    let mut sing_box_version = singbox_version(&bin).await;
    if let Some(version) = sing_box_version.as_deref()
        && !supports_singbox_version(version)
    {
        warn!(
            "sing-box {version} is too old for connection-stream traffic; set a desired sing-box version >= 1.14"
        );
    }
    let state_dir = args.state_dir.clone();
    let traffic_dir = state_dir.join("traffic");
    let mut config = ConfigManager::new(
        client.clone(),
        state_dir.clone(),
        logs.clone(),
        log_policy.clone(),
    )?;
    logs.replace_secrets(SecretScope::StatsApi, config.api_endpoint().secret.iter())?;
    let mut updates = new_update_manager(&args, sing_box_version.clone())?;
    let (mut manager, startup_error) = start_last_known_good(&mut config, &bin).await;
    let api_endpoint = config.api_endpoint().clone();
    let mut reporter = match TrafficReporter::new(
        api_endpoint.addr.clone(),
        api_endpoint.secret.clone(),
        traffic_dir.clone(),
    ) {
        Ok(reporter) => Some(reporter),
        Err(error) => {
            error!("failed to start traffic reporter: {error}");
            None
        }
    };
    let mut status = AgentStatus::from_config(&config);
    if let Some(message) = startup_error {
        status.error = Some(ReportedError {
            phase: "startup",
            code: "SINGBOX_START_FAILED",
            message,
            node_id: None,
            occurred_at: Utc::now(),
        });
    }
    let mut policy = AgentPolicy {
        config_poll_interval_seconds: args.interval,
        heartbeat_interval_seconds: args.interval.min(300),
        desired_agent_version: None,
        desired_sing_box_version: None,
    };
    // The push channel is optional: it is never required for correctness, and
    // every failure path leaves the HTTP poll/heartbeat loop untouched.
    let (command_sink, command_receiver) = ws::ports::command_channel(64);
    let command_sink = Arc::new(command_sink);
    let (pty_event_sender, mut pty_events) = mpsc::channel::<pty::PtyEvent>(64);
    let (mut pty_manager, pty_enabled) = new_pty_manager(&args, pty_event_sender);
    let capabilities = agent_capabilities(pty_enabled);
    let hello_snapshot = Arc::new(Mutex::new(HelloSnapshot::capture(
        &config,
        &updates,
        &capabilities,
    )));
    if args.ws_enabled {
        let sink = command_sink.clone();
        updates.set_status_observer(Arc::new(move |agent, singbox| {
            if let Ok(frame) = AgentWsFrame::new(
                frame_type::UPDATE_STATUS,
                update_status_payload_from(agent, singbox),
            ) {
                ws::enqueue_frame(sink.as_ref(), frame);
            }
        }));
    }
    let mut ws_link = if args.ws_enabled {
        start_ws(
            &startup.url,
            token,
            hello_snapshot.clone(),
            command_receiver,
            command_sink.clone(),
        )
    } else {
        info!("agent websocket disabled; using HTTP config poll and heartbeat");
        WsLink::disabled()
    };
    let acme = new_acme_manager(&args, command_sink.clone());

    match sync_config(&mut config, &mut manager, &bin, &mut status).await {
        Ok(next) => policy = next,
        Err(e) => error!("initial config sync failed: {e}"),
    }
    hello_snapshot
        .lock()
        .expect("hello snapshot lock")
        .refresh(&config, &updates);
    if reconcile_updates(
        &mut updates,
        &policy,
        &mut manager,
        &bin,
        &mut config,
        &mut sing_box_version,
    )
    .await
    {
        heartbeat(
            &client,
            &mut config,
            manager.as_ref(),
            &status,
            policy.clone(),
            sing_box_version.as_deref(),
            &updates,
            &capabilities,
        )
        .await;
        if let Some(manager) = manager.take() {
            manager.shutdown().await;
        }
        info!("agent update installed; exiting for supervisor restart");
        std::process::exit(AGENT_RESTART_EXIT_CODE);
    }
    reconcile_reporter(config.api_endpoint(), &mut reporter, &traffic_dir);
    heartbeat(
        &client,
        &mut config,
        manager.as_ref(),
        &status,
        policy.clone(),
        sing_box_version.as_deref(),
        &updates,
        &capabilities,
    )
    .await;

    info!(
        "agent running; config poll={}s heartbeat={}s",
        policy.config_poll_interval_seconds, policy.heartbeat_interval_seconds
    );
    let mut ws_events = ws_link.take_events();
    let mut ws_transport = "http-fallback";
    let mut config_sleep = Box::pin(tokio::time::sleep(Duration::from_secs(
        policy.config_poll_interval_seconds,
    )));
    let mut heartbeat_sleep = Box::pin(tokio::time::sleep(Duration::from_secs(
        policy.heartbeat_interval_seconds,
    )));
    let mut pty_tick = tokio::time::interval(Duration::from_secs(15));
    pty_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    pty_tick.tick().await;
    let mut log_policy_tick = tokio::time::interval(Duration::from_secs(5));
    log_policy_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    log_policy_tick.tick().await;

    loop {
        let ws_event = async {
            match ws_events.as_mut() {
                Some(events) => events.recv().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            _ = log_policy_tick.tick() => {
                log_policy_maintenance(
                    &log_policy,
                    &mut config,
                    &mut manager,
                    &bin,
                    RUNTIME_PROBATION,
                )
                .await;
            }
            _ = pty_tick.tick() => {
                for exit in pty_manager.reap_expired(Instant::now()) {
                    send_pty_exit(command_sink.as_ref(), exit);
                }
            }
            event = pty_events.recv() => {
                if let Some(event) = event {
                    handle_pty_event(event, &mut pty_manager, command_sink.as_ref());
                }
            }
            _ = &mut config_sleep => {
                if let Some(reporter) = reporter.as_mut() {
                    reporter.collect_and_report(&client).await;
                }
                let exit = config_cycle(
                    &mut config,
                    &mut manager,
                    &bin,
                    &mut status,
                    &mut policy,
                    &mut updates,
                    &mut sing_box_version,
                )
                .await;
                if exit {
                    exit_for_restart(
                        manager.take(),
                        &client,
                        &mut config,
                        &status,
                        &policy,
                        sing_box_version.as_deref(),
                        &updates,
                        &capabilities,
                    )
                    .await;
                }
                reconcile_reporter(config.api_endpoint(), &mut reporter, &traffic_dir);
                refresh_hello(&hello_snapshot, &config, &updates);
                heartbeat(
                    &client,
                    &mut config,
                    manager.as_ref(),
                    &status,
                    policy.clone(),
                    sing_box_version.as_deref(),
                    &updates,
                    &capabilities,
                ).await;
                config_sleep.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(policy.config_poll_interval_seconds));
                heartbeat_sleep.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(policy.heartbeat_interval_seconds));
            }
            _ = &mut heartbeat_sleep => {
                heartbeat(
                    &client,
                    &mut config,
                    manager.as_ref(),
                    &status,
                    policy.clone(),
                    sing_box_version.as_deref(),
                    &updates,
                    &capabilities,
                ).await;
                heartbeat_sleep.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(policy.heartbeat_interval_seconds));
            }
            event = ws_event => {
                let Some(event) = event else {
                    ws_events = None;
                    continue;
                };
                match event {
                    WsEvent::Connected { welcome } => {
                        ws_transport = "ws";
                        info!(
                            server = %welcome.server_name,
                            revision_seq = welcome.desired_revision_seq,
                            "agent websocket connected; HTTP polling remains as fallback"
                        );
                        apply_ws_policy(&welcome, &mut policy);
                        config_sleep.as_mut().reset(
                            tokio::time::Instant::now()
                                + Duration::from_secs(policy.config_poll_interval_seconds),
                        );
                        heartbeat_sleep.as_mut().reset(
                            tokio::time::Instant::now()
                                + Duration::from_secs(policy.heartbeat_interval_seconds),
                        );
                        refresh_hello(&hello_snapshot, &config, &updates);
                    }
                    WsEvent::Recovered => {
                        ws_transport = "ws";
                        info!("agent websocket push channel recovered");
                    }
                    WsEvent::Fallback { reason } => {
                        ws_transport = "http-fallback";
                        for exit in pty_manager.close_all(pty::PtyExitReason::AgentDisconnected) {
                            send_pty_exit(command_sink.as_ref(), exit);
                        }
                        warn!(
                            "agent websocket unavailable ({reason}); using HTTP config poll and heartbeat"
                        );
                    }
                    WsEvent::Disconnected { reason } => {
                        ws_transport = "http-fallback";
                        for exit in pty_manager.close_all(pty::PtyExitReason::AgentDisconnected) {
                            send_pty_exit(command_sink.as_ref(), exit);
                        }
                        info!("agent websocket disconnected: {reason}");
                    }
                    WsEvent::Frame(message) => {
                        handle_ws_frame(
                            message,
                            &client,
                            &mut config,
                            &mut manager,
                            &bin,
                            &mut status,
                            &mut policy,
                            &mut updates,
                            &mut sing_box_version,
                            command_sink.as_ref(),
                            &acme,
                            &capabilities,
                            &mut pty_manager,
                        )
                        .await;
                        reconcile_reporter(config.api_endpoint(), &mut reporter, &traffic_dir);
                        refresh_hello(&hello_snapshot, &config, &updates);
                    }
                }
            }
            _ = shutdown_signal() => {
                info!("received shutdown signal");
                break;
            }
        }
    }

    if let Some(manager) = manager {
        manager.shutdown().await;
    }
    acme.shutdown().await;
    ws_link.shutdown().await;
    info!("agent stopped; last transport={ws_transport}");
    Ok(())
}

#[derive(Debug, Clone)]
struct ReportedError {
    phase: &'static str,
    code: &'static str,
    message: String,
    node_id: Option<String>,
    occurred_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct AgentStatus {
    config_state: &'static str,
    observed_revision: Option<String>,
    error: Option<ReportedError>,
}

impl AgentStatus {
    fn from_config(config: &ConfigManager) -> Self {
        Self {
            config_state: if config.applied_revision().is_some() {
                "applied"
            } else {
                "unknown"
            },
            observed_revision: config.observed_revision().map(str::to_owned),
            error: None,
        }
    }
}

/// Runs the local half of the log-level policy: expires temporary overrides,
/// retries failed applications with a bound, and applies agent filter changes.
/// The v1 supervision loop and the v2 core both call it from their single
/// select loop, so it is serialized with configuration reconciliation.
async fn log_policy_maintenance(
    policy: &Arc<LogPolicy>,
    config: &mut ConfigManager,
    manager: &mut Option<SingBoxManager>,
    bin: &Path,
    probation: Duration,
) {
    let now = Utc::now();
    let mut decisions = policy.expire(now);
    decisions.extend(policy.retry_due(now));
    if decisions.is_empty() {
        return;
    }
    // Apply one source at a time. A sing-box reload awaits probation, and the
    // policy timestamps must reflect the world when that reload finishes.
    for decision in decisions {
        let Some(action) = decision.action.as_ref() else {
            continue;
        };
        match action {
            PolicyAction::Agent(level) => {
                if let Some(status) = policy.apply_agent(*level, Utc::now()) {
                    report_policy_status(&status, decision.reason);
                }
            }
            PolicyAction::SingBox(overlay) => {
                if !config.has_active_config() {
                    // There is nothing to overlay yet. Keep the request pending
                    // until a validated configuration exists.
                    continue;
                }
                let result =
                    apply_singbox_log_overlay(config, manager, bin, *overlay, probation).await;
                match policy.record(PolicySource::SingBox, overlay.effective, result, Utc::now()) {
                    Some(status) => report_policy_status(&status, decision.reason),
                    None => warn!("log policy changed while the sing-box overlay applied"),
                }
            }
        }
    }
}

fn report_policy_status(status: &PolicyStatus, reason: DecisionReason) {
    match &status.error {
        Some(error) => warn!(
            source = status.source.as_str(),
            requested = status.requested.as_str(),
            effective = status.effective.as_str(),
            ?reason,
            "log policy application failed: {error}"
        ),
        None => info!(
            source = status.source.as_str(),
            requested = status.requested.as_str(),
            effective = status.effective.as_str(),
            ?reason,
            "log policy applied"
        ),
    }
}

/// Applies one log-only sing-box change through the same preflight, promotion,
/// process replacement, probation and rollback path as a configuration apply.
/// The desired revision is untouched; only the local `log.level` overlay moves.
async fn apply_singbox_log_overlay(
    config: &mut ConfigManager,
    manager: &mut Option<SingBoxManager>,
    bin: &Path,
    overlay: LogOverlay,
    probation: Duration,
) -> Result<(), String> {
    if !config.has_active_config() {
        return Err("no active sing-box configuration to overlay".to_string());
    }
    if manager.is_some() {
        warn!(
            level = overlay.effective.as_str(),
            "applying a sing-box log level; the process restarts briefly"
        );
    }
    config
        .stage_log_overlay(overlay)
        .map_err(|error| error.to_string())?;
    if let Err(error) = check_config(bin, config.candidate_path()).await {
        return Err(error.to_string());
    }
    config
        .promote_candidate()
        .map_err(|error| error.to_string())?;

    if let Some(current) = manager.take() {
        current.shutdown().await;
    }
    match SingBoxManager::start(bin.to_path_buf(), config.config_path().clone()).await {
        Ok(started) => *manager = Some(started),
        Err(error) => {
            let rolled_back = config.rollback().unwrap_or(false);
            restore_runtime(manager, bin, config, rolled_back, probation).await;
            return Err(error.to_string());
        }
    }

    tokio::time::sleep(probation).await;
    if manager.as_ref().map(SingBoxManager::state) == Some(ProcessState::Running) {
        config
            .commit_log_overlay()
            .map_err(|error| error.to_string())?;
        config.set_runtime_confirmed(true);
        Ok(())
    } else {
        let rolled_back = config.rollback().unwrap_or(false);
        restore_runtime(manager, bin, config, rolled_back, probation).await;
        Err("sing-box did not become healthy with the new log level".to_string())
    }
}

async fn sync_config(
    config: &mut ConfigManager,
    manager: &mut Option<SingBoxManager>,
    bin: &Path,
    status: &mut AgentStatus,
) -> Result<AgentPolicy> {
    let fetched = config.fetch().await.map_err(|error| {
        record_config_error(config, status, &error);
        anyhow::Error::new(error)
    })?;
    apply_fetched(config, manager, bin, status, fetched, RUNTIME_PROBATION).await
}

/// Records a failed reconcile so the next heartbeat or config acknowledgement
/// reports it. Shared by the HTTP poll path and the WebSocket v2 path.
fn record_config_error(config: &ConfigManager, status: &mut AgentStatus, error: &ConfigError) {
    status.config_state = "apply_failed";
    status.observed_revision = config.observed_revision().map(str::to_owned);
    status.error = Some(ReportedError {
        phase: error.phase,
        code: error.code,
        message: error.message.clone(),
        node_id: error.node_id.clone(),
        occurred_at: Utc::now(),
    });
}

/// Starts sing-box from the committed config on disk, if there is one. A config
/// that fails preflight or launch is marked for re-apply, so the next reconcile
/// cannot skip it.
async fn start_last_known_good(
    config: &mut ConfigManager,
    bin: &Path,
) -> (Option<SingBoxManager>, Option<String>) {
    if !config.has_active_config() {
        return (None, config.startup_error().map(str::to_owned));
    }
    match check_config(bin, config.config_path()).await {
        Ok(()) => {
            match SingBoxManager::start(bin.to_path_buf(), config.config_path().clone()).await {
                Ok(manager) => (Some(manager), config.startup_error().map(str::to_owned)),
                Err(error) => {
                    error!("failed to start last-known-good config: {error}");
                    config.mark_needs_reapply();
                    (None, Some(error.to_string()))
                }
            }
        }
        Err(error) => {
            error!("last-known-good config failed startup preflight: {error}");
            config.mark_needs_reapply();
            (None, Some(error.to_string()))
        }
    }
}

/// Applies a compiled desired state with every safety invariant: candidate
/// preflight, promotion, process replacement, probation, then commit or
/// rollback. The HTTP poll path and the WebSocket v2 snapshot path both use it.
async fn apply_fetched(
    config: &mut ConfigManager,
    manager: &mut Option<SingBoxManager>,
    bin: &Path,
    status: &mut AgentStatus,
    fetched: FetchStatus,
    probation: Duration,
) -> Result<AgentPolicy> {
    let (policy, candidate) = match fetched {
        FetchStatus::Unchanged(policy) => {
            status.observed_revision = config.observed_revision().map(str::to_owned);
            if manager.is_none() && config.has_active_config() {
                let preflight = check_config(bin, config.config_path()).await;
                match preflight {
                    Err(error) => {
                        status.config_state = "rejected";
                        config.mark_needs_reapply();
                        status.error = Some(ReportedError {
                            phase: "startup",
                            code: "LKG_CONFIG_INVALID",
                            message: error.to_string(),
                            node_id: None,
                            occurred_at: Utc::now(),
                        });
                    }
                    Ok(()) => {
                        match SingBoxManager::start(bin.to_path_buf(), config.config_path().clone())
                            .await
                        {
                            Ok(started) => {
                                *manager = Some(started);
                                status.error = None;
                            }
                            Err(e) => {
                                error!("failed to start existing sing-box config: {e}");
                                config.mark_needs_reapply();
                                status.error = Some(ReportedError {
                                    phase: "startup",
                                    code: "SINGBOX_START_FAILED",
                                    message: e.to_string(),
                                    node_id: None,
                                    occurred_at: Utc::now(),
                                });
                            }
                        }
                    }
                }
            }
            if manager.is_some() && config.applied_revision().is_some() {
                // A successful reconcile proves the earlier transport error
                // is no longer current. Keep runtime health separate from the
                // config state; heartbeat will still report crash loops.
                status.config_state = "applied";
                status.error = None;
            }
            return Ok(policy);
        }
        FetchStatus::Updated { policy, candidate } => (policy, candidate),
    };
    status.observed_revision = Some(candidate.revision.clone());

    if let Err(e) = check_config(bin, config.candidate_path()).await {
        let message = e.to_string();
        let node_id = node_id_from_error(&message, &candidate);
        error!(
            revision = %candidate.revision,
            node_id = node_id.as_deref().unwrap_or("unknown"),
            "sing-box candidate config rejected: {message}"
        );
        status.config_state = "rejected";
        config.mark_candidate_error(&candidate, "preflight", &message);
        status.error = Some(ReportedError {
            phase: "preflight",
            code: "SINGBOX_CONFIG_INVALID",
            node_id,
            message,
            occurred_at: Utc::now(),
        });
        return Ok(policy);
    }

    if let Err(e) = config.promote_candidate() {
        error!(
            revision = %candidate.revision,
            "failed to promote sing-box candidate config: {e}"
        );
        status.config_state = "apply_failed";
        status.error = Some(ReportedError {
            phase: "promote",
            code: "CONFIG_PROMOTE_FAILED",
            message: e.to_string(),
            node_id: None,
            occurred_at: Utc::now(),
        });
        config.mark_candidate_error(&candidate, "promote", &e.to_string());
        let _ = config.rollback();
        return Ok(policy);
    }

    // Replace the process instead of relying on SIGHUP. A successful signal
    // only proves delivery: sing-box may reject the new file and keep serving
    // the previous in-memory config. Starting a new process proves that the
    // promoted config is the one actually running before we acknowledge it.
    if let Some(current) = manager.take() {
        current.shutdown().await;
    }
    let apply_result =
        match SingBoxManager::start(bin.to_path_buf(), config.config_path().clone()).await {
            Ok(started) => {
                *manager = Some(started);
                Ok(())
            }
            Err(error) => Err(error),
        };

    if let Err(e) = apply_result {
        error!(
            revision = %candidate.revision,
            "failed to apply sing-box candidate config: {e}"
        );
        config.mark_candidate_error(&candidate, "apply", &e.to_string());
        let rolled_back = config.rollback().unwrap_or(false);
        restore_runtime(manager, bin, config, rolled_back, probation).await;
        status.config_state = "apply_failed";
        status.error = Some(ReportedError {
            phase: "apply",
            code: "SINGBOX_START_FAILED",
            message: e.to_string(),
            node_id: None,
            occurred_at: Utc::now(),
        });
        return Ok(policy);
    }

    // Only commit the candidate after the replacement process survives the
    // health window.
    tokio::time::sleep(probation).await;
    if manager.as_ref().map(SingBoxManager::state) == Some(ProcessState::Running) {
        config.commit_applied(&candidate)?;
        config.set_runtime_confirmed(true);
        status.config_state = "applied";
        status.error = None;
        info!("sing-box config {} applied", candidate.revision);
    } else {
        let rolled_back = config.rollback()?;
        config.mark_candidate_error(
            &candidate,
            "health",
            "candidate did not become healthy during probation",
        );
        restore_runtime(manager, bin, config, rolled_back, probation).await;
        error!(
            revision = %candidate.revision,
            rolled_back,
            "sing-box candidate failed its health check"
        );
        status.config_state = "apply_failed";
        status.error = Some(ReportedError {
            phase: "health",
            code: "SINGBOX_HEALTH_CHECK_FAILED",
            message: if rolled_back {
                "candidate did not become healthy; restored last-known-good config".to_string()
            } else {
                "candidate did not become healthy and no last-known-good config exists".to_string()
            },
            node_id: None,
            occurred_at: Utc::now(),
        });
    }
    Ok(policy)
}

/// One reconcile pass shared by the HTTP poll timer and a `config.notify`
/// push: fetch, apply with the full safety invariants, then reconcile updates.
/// Returns true when the agent replaced itself and must exit.
async fn config_cycle(
    config: &mut ConfigManager,
    manager: &mut Option<SingBoxManager>,
    bin: &Path,
    status: &mut AgentStatus,
    policy: &mut AgentPolicy,
    updates: &mut UpdateManager,
    sing_box_version: &mut Option<String>,
) -> bool {
    match sync_config(config, manager, bin, status).await {
        Ok(next) => *policy = next,
        Err(error) => error!("config sync failed: {error}"),
    }
    reconcile_updates(updates, policy, manager, bin, config, sing_box_version).await
}

#[expect(
    clippy::too_many_arguments,
    reason = "mirrors the reconciliation context passed to heartbeat"
)]
async fn exit_for_restart(
    manager: Option<SingBoxManager>,
    client: &client::Client,
    config: &mut ConfigManager,
    status: &AgentStatus,
    policy: &AgentPolicy,
    sing_box_version: Option<&str>,
    updates: &UpdateManager,
    capabilities: &[&str],
) -> ! {
    heartbeat(
        client,
        config,
        manager.as_ref(),
        status,
        policy.clone(),
        sing_box_version,
        updates,
        capabilities,
    )
    .await;
    if let Some(manager) = manager {
        manager.shutdown().await;
    }
    info!("agent update installed; exiting for supervisor restart");
    std::process::exit(AGENT_RESTART_EXIT_CODE);
}

fn refresh_hello(
    snapshot: &Arc<Mutex<HelloSnapshot>>,
    config: &ConfigManager,
    updates: &UpdateManager,
) {
    snapshot
        .lock()
        .expect("hello snapshot lock")
        .refresh(config, updates);
}

/// The `hello` payload is rebuilt before every connect so a reconnect carries
/// the current applied revision, certificate deployments and update state.
#[derive(Debug, Clone)]
struct HelloSnapshot {
    payload: HelloPayload,
}

impl HelloSnapshot {
    fn capture(config: &ConfigManager, updates: &UpdateManager, capabilities: &[&str]) -> Self {
        let mut snapshot = Self {
            payload: HelloPayload {
                agent_version: AGENT_VERSION.to_string(),
                agent_build_id: AGENT_BUILD_ID.to_string(),
                capabilities: capabilities
                    .iter()
                    .map(|capability| capability.to_string())
                    .collect(),
                applied_revision: None,
                certificate_deployments: Vec::new(),
                updates: None,
            },
        };
        snapshot.refresh(config, updates);
        snapshot
    }

    fn refresh(&mut self, config: &ConfigManager, updates: &UpdateManager) {
        self.payload.applied_revision = config.applied_revision().map(str::to_owned);
        self.payload.certificate_deployments = config
            .deployments()
            .iter()
            .map(certificate_deployment)
            .collect();
        self.payload.updates = Some(update_status_payload_from(
            updates.agent_status(),
            updates.singbox_status(),
        ));
    }

    fn payload(&self) -> HelloPayload {
        self.payload.clone()
    }
}

impl ws::HelloSource for Arc<Mutex<HelloSnapshot>> {
    fn hello(&self) -> HelloPayload {
        self.lock().expect("hello snapshot lock").payload()
    }
}

fn certificate_deployment(deployment: &config::DeploymentRecord) -> CertificateDeployment {
    CertificateDeployment {
        certificate_id: deployment.certificate_id.clone(),
        generation: deployment.generation,
        fingerprint_sha256: deployment.fingerprint_sha256.clone(),
        installed: deployment.installed,
        in_use: deployment.in_use,
        error_phase: deployment.error_phase.clone(),
        error_message: deployment.error_message.clone(),
    }
}

fn update_state_payload(status: &UpdateStatus) -> UpdateStatePayload {
    UpdateStatePayload {
        target_version: status.target_version.clone(),
        state: status.state.as_str().to_string(),
        message: status.message.clone(),
        checked_at: status.checked_at,
    }
}

fn update_status_payload_from(agent: &UpdateStatus, singbox: &UpdateStatus) -> UpdateStatusPayload {
    UpdateStatusPayload {
        agent: Some(update_state_payload(agent)),
        sing_box: Some(update_state_payload(singbox)),
    }
}

/// Applies the control plane's negotiated intervals. The welcome values are
/// authoritative for cadence but are clamped exactly like the HTTP document.
fn apply_ws_policy(welcome: &WelcomePayload, policy: &mut AgentPolicy) {
    policy.config_poll_interval_seconds = welcome.poll_interval_seconds.clamp(5, 86_400);
    policy.heartbeat_interval_seconds = welcome.heartbeat_interval_seconds.clamp(5, 3_600);
}

/// Runs one `update.trigger` through the ordinary reconciler. A missing
/// version means "resolve latest"; a single-target trigger never touches the
/// other binary. The v1 and v2 transports share this policy translation.
pub(crate) async fn apply_update_trigger(
    trigger: UpdateTriggerPayload,
    updates: &mut UpdateManager,
    manager: &mut Option<SingBoxManager>,
    bin: &Path,
    config: &mut ConfigManager,
    sing_box_version: &mut Option<String>,
    policy: &AgentPolicy,
) -> bool {
    if trigger.force {
        match trigger.target {
            UpdateTarget::Agent | UpdateTarget::All => updates.clear_agent_cooldown(),
            UpdateTarget::SingBox => {}
        }
        if matches!(trigger.target, UpdateTarget::SingBox | UpdateTarget::All) {
            updates.clear_singbox_cooldown();
        }
    }
    let mut targeted = policy.clone();
    targeted.desired_agent_version = match trigger.target {
        UpdateTarget::Agent | UpdateTarget::All => Some(
            trigger
                .desired_agent_version
                .clone()
                .unwrap_or_else(|| "latest".to_string()),
        ),
        UpdateTarget::SingBox => None,
    };
    targeted.desired_sing_box_version = match trigger.target {
        UpdateTarget::SingBox | UpdateTarget::All => Some(
            trigger
                .desired_sing_box_version
                .clone()
                .unwrap_or_else(|| "latest".to_string()),
        ),
        UpdateTarget::Agent => None,
    };
    reconcile_updates(updates, &targeted, manager, bin, config, sing_box_version).await
}

/// Dispatches a pushed frame through the same reconcilers the poll timer uses.
///
/// `config.notify` re-fetches the full v3 document (never trusting the push
/// payload as config) and then acks the committed or failed revision.
/// `update.trigger` runs the ordinary update reconciler and acks nothing; the
/// status observer streams transitions back over the socket.
#[allow(clippy::too_many_arguments)]
async fn handle_ws_frame(
    message: AgentMessage,
    client: &client::Client,
    config: &mut ConfigManager,
    manager: &mut Option<SingBoxManager>,
    bin: &Path,
    status: &mut AgentStatus,
    policy: &mut AgentPolicy,
    updates: &mut UpdateManager,
    sing_box_version: &mut Option<String>,
    sink: &dyn AgentCommandSink,
    acme: &Arc<AcmeManager>,
    capabilities: &[&str],
    pty: &mut pty::PtyManager,
) {
    match message {
        AgentMessage::ConfigNotify(notify) => {
            info!(
                revision_seq = notify.desired_revision_seq,
                revision = %notify.desired_revision,
                reason = notify.reason.as_deref().unwrap_or("unspecified"),
                "config push received; reconciling immediately"
            );
            let exit = config_cycle(
                config,
                manager,
                bin,
                status,
                policy,
                updates,
                sing_box_version,
            )
            .await;
            send_config_ack(sink, config, status);
            if exit {
                exit_for_restart(
                    manager.take(),
                    client,
                    config,
                    status,
                    policy,
                    sing_box_version.as_deref(),
                    updates,
                    capabilities,
                )
                .await;
            }
        }
        AgentMessage::UpdateTrigger(trigger) => {
            info!(
                target = ?trigger.target,
                force = trigger.force,
                "update push received; reconciling immediately"
            );
            let exit = apply_update_trigger(
                trigger,
                updates,
                manager,
                bin,
                config,
                sing_box_version,
                policy,
            )
            .await;
            if exit {
                exit_for_restart(
                    manager.take(),
                    client,
                    config,
                    status,
                    policy,
                    sing_box_version.as_deref(),
                    updates,
                    capabilities,
                )
                .await;
            }
        }
        AgentMessage::Welcome(welcome) => {
            apply_ws_policy(&welcome, policy);
        }
        AgentMessage::Hello(_)
        | AgentMessage::Ping(_)
        | AgentMessage::Pong(_)
        | AgentMessage::ConfigAck(_)
        | AgentMessage::UpdateStatus(_) => {}
        AgentMessage::AcmeIssue(issue) => {
            info!(
                job_id = %issue.job_id,
                certificate_id = %issue.certificate_id,
                generation = issue.generation,
                challenge = %issue.challenge_type,
                "ACME issuance job received"
            );
            if let Err(error) = acme.handle_issue(issue).await {
                warn!(
                    phase = error.phase.as_str(),
                    "ACME job rejected: {}", error.message
                );
            }
        }
        AgentMessage::AcmeDnsAck(ack) => {
            acme.handle_dns_ack(DnsAck {
                job_id: ack.job_id,
                fqdn: ack.fqdn,
                txt_value: ack.txt_value,
                accepted: ack.accepted,
                error: ack.error,
            })
            .await;
        }
        AgentMessage::Pty(frame) => {
            handle_pty_frame(frame, pty, sink);
        }
        AgentMessage::Telemetry(frame) | AgentMessage::Acme(frame) => {
            tracing::debug!(frame_type = %frame.frame_type, "ignoring reserved websocket channel");
        }
        AgentMessage::Unknown { frame_type } => {
            tracing::debug!(frame_type = %frame_type, "ignoring unknown websocket frame");
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PtyOpenRequest {
    session_id: String,
    cols: u32,
    rows: u32,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PtyDataRequest {
    session_id: String,
    data: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PtyResizeRequest {
    session_id: String,
    cols: u32,
    rows: u32,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PtyCloseRequest {
    session_id: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyDataPayload<'a> {
    session_id: &'a str,
    data: &'a str,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyStartedPayload<'a> {
    session_id: &'a str,
    shell: &'a str,
    user: &'a str,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExitPayload<'a> {
    session_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signal: Option<&'a str>,
    reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'a str>,
}

fn handle_pty_frame(
    frame: crate::ws::codec::ReservedFrame,
    manager: &mut pty::PtyManager,
    sink: &dyn AgentCommandSink,
) {
    match frame.frame_type.as_str() {
        frame_type::PTY_OPEN => {
            let Ok(payload) = serde_json::from_value::<PtyOpenRequest>(frame.payload) else {
                warn!("ignoring pty.open with an invalid payload");
                return;
            };
            let dimensions = pty::PtyDimensions::clamped(payload.cols, payload.rows);
            match manager.open(&payload.session_id, dimensions) {
                Ok(started) => send_pty_started(sink, &payload.session_id, &started),
                Err(error) => {
                    warn!(
                        session = %payload.session_id,
                        "pty.open rejected: {error}"
                    );
                    send_pty_exit(
                        sink,
                        pty::PtyExit {
                            session_id: payload.session_id,
                            reason: error.exit_reason(),
                            code: None,
                            signal: None,
                            detail: Some(bounded_detail(&error.to_string())),
                        },
                    );
                }
            }
        }
        frame_type::PTY_DATA => {
            let Ok(payload) = serde_json::from_value::<PtyDataRequest>(frame.payload) else {
                warn!("ignoring pty.data with an invalid payload");
                return;
            };
            if payload.data.len() > pty::MAX_INPUT_FRAME_BYTES {
                if let Some(exit) =
                    manager.close(&payload.session_id, pty::PtyExitReason::FrameTooLarge)
                {
                    send_pty_exit(sink, exit);
                }
                return;
            }
            if let Err(error) = manager.write(&payload.session_id, payload.data.as_bytes()) {
                match error {
                    pty::PtyError::InputBackpressure => {
                        warn!(
                            session = %payload.session_id,
                            "pty input queue is full; closing the session"
                        );
                        if let Some(exit) = manager
                            .close(&payload.session_id, pty::PtyExitReason::InputBackpressure)
                        {
                            send_pty_exit(sink, exit);
                        }
                    }
                    pty::PtyError::Closed => {}
                    other => {
                        warn!(
                            session = %payload.session_id,
                            "pty input failed: {other}"
                        );
                    }
                }
            }
        }
        frame_type::PTY_RESIZE => {
            let Ok(payload) = serde_json::from_value::<PtyResizeRequest>(frame.payload) else {
                warn!("ignoring pty.resize with an invalid payload");
                return;
            };
            let dimensions = pty::PtyDimensions::clamped(payload.cols, payload.rows);
            if let Err(error) = manager.resize(&payload.session_id, dimensions) {
                warn!(
                    session = %payload.session_id,
                    "pty.resize failed: {error}"
                );
            }
        }
        frame_type::PTY_CLOSE => {
            let Ok(payload) = serde_json::from_value::<PtyCloseRequest>(frame.payload) else {
                warn!("ignoring pty.close with an invalid payload");
                return;
            };
            if let Some(exit) = manager.close(&payload.session_id, pty::PtyExitReason::Closed) {
                send_pty_exit(sink, exit);
            }
        }
        other => {
            tracing::debug!(frame_type = %other, "ignoring agent-to-agent PTY frame");
        }
    }
}

fn handle_pty_event(
    event: pty::PtyEvent,
    manager: &mut pty::PtyManager,
    sink: &dyn AgentCommandSink,
) {
    match event {
        pty::PtyEvent::Data { session_id, data } => {
            manager.note_output(&session_id, Instant::now());
            if !send_pty_data(sink, &session_id, &data)
                && let Some(exit) =
                    manager.close(&session_id, pty::PtyExitReason::OutputBackpressure)
            {
                send_pty_exit(sink, exit);
            }
        }
        pty::PtyEvent::Exited {
            session_id,
            code,
            signal,
        } => {
            if let Some(exit) = manager.remove_exited(&session_id, code, signal) {
                send_pty_exit(sink, exit);
            }
        }
        pty::PtyEvent::ReadError { session_id } => {
            if let Some(exit) = manager.close(&session_id, pty::PtyExitReason::IoError) {
                send_pty_exit(sink, exit);
            }
        }
    }
}

fn send_pty_data(sink: &dyn AgentCommandSink, session_id: &str, data: &str) -> bool {
    if data.is_empty() {
        return true;
    }
    match AgentWsFrame::new(frame_type::PTY_DATA, PtyDataPayload { session_id, data }) {
        Ok(frame) => enqueue_pty_frame(sink, frame),
        Err(error) => {
            warn!("failed to encode pty.data: {error}");
            false
        }
    }
}

fn send_pty_started(sink: &dyn AgentCommandSink, session_id: &str, started: &pty::PtyStarted) {
    match AgentWsFrame::new(
        frame_type::PTY_STARTED,
        PtyStartedPayload {
            session_id,
            shell: &started.shell,
            user: &started.user,
        },
    ) {
        Ok(frame) => {
            let _ = enqueue_pty_frame(sink, frame);
        }
        Err(error) => warn!("failed to encode pty.started: {error}"),
    }
}

/// Startup diagnostics are short; the control plane bounds them to 256 chars.
fn bounded_detail(message: &str) -> String {
    message.chars().take(256).collect()
}

fn send_pty_exit(sink: &dyn AgentCommandSink, exit: pty::PtyExit) {
    match AgentWsFrame::new(
        frame_type::PTY_EXIT,
        PtyExitPayload {
            session_id: &exit.session_id,
            code: exit.code,
            signal: exit.signal.as_deref(),
            reason: exit.reason.as_str(),
            detail: exit.detail.as_deref(),
        },
    ) {
        Ok(frame) => {
            let _ = enqueue_pty_frame(sink, frame);
        }
        Err(error) => warn!("failed to encode pty.exit: {error}"),
    }
}

fn enqueue_pty_frame(sink: &dyn AgentCommandSink, frame: AgentWsFrame) -> bool {
    match sink.enqueue(WsCommand::Send(frame)) {
        Ok(()) => true,
        Err(error) => {
            debug!("pty outbound queue backpressure: {error}");
            false
        }
    }
}

/// Sends `config.ack` with the revision the agent actually committed and the
/// current deployments. When nothing was ever committed this is the empty
/// string rather than the desired revision: the control plane must not read a
/// failed apply as an applied one.
fn send_config_ack(sink: &dyn AgentCommandSink, config: &ConfigManager, status: &AgentStatus) {
    let applied_revision = config.applied_revision().unwrap_or_default().to_string();
    let error = status.error.as_ref().map(|error| error.message.clone());
    let payload = ConfigAckPayload {
        applied_revision,
        certificate_deployments: config
            .deployments()
            .iter()
            .map(certificate_deployment)
            .collect(),
        error,
    };
    match AgentWsFrame::new(frame_type::CONFIG_ACK, payload) {
        Ok(frame) => ws::enqueue_frame(sink, frame),
        Err(error) => warn!("failed to encode config.ack: {error}"),
    }
}

/// Handle to the background WebSocket task. Dropping the task's cancellation
/// token stops the loop; [`WsLink::shutdown`] also waits for it to finish.
struct WsLink {
    events: Option<mpsc::Receiver<WsEvent>>,
    cancel: CancellationToken,
    sink: Option<Arc<ChannelCommandSink>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl WsLink {
    fn disabled() -> Self {
        Self {
            events: None,
            cancel: CancellationToken::new(),
            sink: None,
            task: None,
        }
    }

    fn take_events(&mut self) -> Option<mpsc::Receiver<WsEvent>> {
        self.events.take()
    }

    async fn shutdown(mut self) {
        if let Some(sink) = self.sink.take() {
            let _ = sink.enqueue(WsCommand::Close);
        }
        self.cancel.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

fn start_ws(
    base_url: &str,
    token: &str,
    hello: Arc<Mutex<HelloSnapshot>>,
    commands: mpsc::Receiver<WsCommand>,
    sink: Arc<ChannelCommandSink>,
) -> WsLink {
    let url = match ws_url(base_url) {
        Ok(url) => url,
        Err(error) => {
            warn!("agent websocket disabled: {error}");
            return WsLink::disabled();
        }
    };
    let token = match SensitiveHeader::bearer(token) {
        Ok(token) => token,
        Err(error) => {
            warn!("agent websocket disabled: {error}");
            return WsLink::disabled();
        }
    };
    let transport = match TokioWsTransport::new(WsTransportConfig {
        url: url.clone(),
        token,
        connect_timeout: Duration::from_secs(15),
    }) {
        Ok(transport) => transport,
        Err(error) => {
            warn!("agent websocket disabled: {error}");
            return WsLink::disabled();
        }
    };
    info!("connecting agent websocket at {url}");
    let (event_sender, event_receiver) = mpsc::channel(32);
    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();
    let task = tokio::spawn(async move {
        ws::run(
            transport,
            hello,
            ws::RandomJitter,
            event_sender,
            commands,
            task_cancel,
        )
        .await;
    });
    WsLink {
        events: Some(event_receiver),
        cancel,
        sink: Some(sink),
        task: Some(task),
    }
}

async fn restore_runtime(
    manager: &mut Option<SingBoxManager>,
    bin: &Path,
    config: &mut ConfigManager,
    rolled_back: bool,
    probation: Duration,
) {
    if !rolled_back || !config.has_active_config() {
        if let Some(current) = manager.take() {
            current.shutdown().await;
        }
        config.set_runtime_confirmed(false);
        return;
    }

    if let Some(current) = manager.take() {
        current.shutdown().await;
    }
    match SingBoxManager::start(bin.to_path_buf(), config.config_path().clone()).await {
        Ok(started) => *manager = Some(started),
        Err(error) => {
            error!("failed to restart last-known-good config after rollback: {error}");
            config.set_runtime_confirmed(false);
            return;
        }
    }
    tokio::time::sleep(probation).await;
    config.set_runtime_confirmed(
        manager.as_ref().map(SingBoxManager::state) == Some(ProcessState::Running),
    );
}

fn node_id_from_error(message: &str, candidate: &CandidateConfig) -> Option<String> {
    let start = message.find("inbounds[")? + "inbounds[".len();
    let end = message[start..].find(']')? + start;
    let index = message[start..end].parse::<usize>().ok()?;
    candidate.materialized_node_ids.get(index).cloned()
}

fn reconcile_reporter(
    endpoint: &crate::config::ApiEndpoint,
    reporter: &mut Option<TrafficReporter>,
    traffic_dir: &Path,
) {
    if let Some(current) = reporter.as_mut() {
        if let Err(error) = current.update_endpoint(&endpoint.addr, endpoint.secret.as_deref()) {
            error!("failed to update traffic stream endpoint: {error}");
        }
        return;
    }
    match TrafficReporter::new(
        endpoint.addr.clone(),
        endpoint.secret.clone(),
        traffic_dir.to_path_buf(),
    ) {
        Ok(created) => {
            info!("traffic reporting enabled");
            *reporter = Some(created);
        }
        Err(error) => error!("failed to enable traffic reporting: {error}"),
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate = signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler");
        tokio::select! {
            _ = signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = signal::ctrl_c().await;
    }
}

/// Applies version directives from the polled agent document. Returns true
/// when the agent replaced itself and must exit for the supervisor.
///
/// sing-box is updated first: its candidate is preflighted against the active
/// config, the old process is stopped, and the new binary must survive the same
/// probation as a config candidate. A failed probation restores the previous
/// binary and process.
async fn reconcile_updates(
    updates: &mut UpdateManager,
    policy: &AgentPolicy,
    manager: &mut Option<SingBoxManager>,
    bin: &Path,
    config: &mut ConfigManager,
    sing_box_version: &mut Option<String>,
) -> bool {
    if let Some(desired) = policy.desired_sing_box_version.as_deref() {
        match updates
            .stage_singbox_update(desired, sing_box_version.as_deref())
            .await
        {
            Ok(Some(staged)) => {
                let preflight = if config.has_active_config() {
                    check_config(&staged.path, config.config_path()).await
                } else {
                    Ok(())
                };
                if let Err(error) = preflight {
                    let _ = std::fs::remove_file(&staged.path);
                    updates.singbox_update_failed(
                        desired,
                        &format!("sing-box preflight failed: {error}"),
                    );
                    error!("sing-box {} preflight failed: {error}", staged.version);
                } else {
                    if let Some(current) = manager.take() {
                        current.shutdown().await;
                    }
                    if let Err(error) = updates.install_singbox(&staged, bin, desired) {
                        error!("failed to install sing-box {}: {error}", staged.version);
                        *manager = start_singbox_if_configured(bin, config).await;
                    } else {
                        let mut healthy = true;
                        if config.has_active_config() {
                            match SingBoxManager::start(
                                bin.to_path_buf(),
                                config.config_path().clone(),
                            )
                            .await
                            {
                                Ok(started) => {
                                    *manager = Some(started);
                                    tokio::time::sleep(RUNTIME_PROBATION).await;
                                    healthy = manager.as_ref().map(SingBoxManager::state)
                                        == Some(ProcessState::Running);
                                }
                                Err(error) => {
                                    error!("failed to start sing-box {}: {error}", staged.version);
                                    healthy = false;
                                }
                            }
                        }
                        if healthy {
                            *sing_box_version = singbox_version(bin).await;
                            updates.singbox_update_succeeded(&staged.version);
                            info!("sing-box updated to {}", staged.version);
                        } else {
                            if let Some(current) = manager.take() {
                                current.shutdown().await;
                            }
                            let backup = bin.with_extension("prev");
                            if backup.exists()
                                && let Err(error) = std::fs::rename(&backup, bin)
                            {
                                error!("failed to restore previous sing-box: {error}");
                            }
                            *sing_box_version = singbox_version(bin).await;
                            *manager = start_singbox_if_configured(bin, config).await;
                            updates.singbox_update_failed(
                                desired,
                                "new sing-box did not become healthy; restored previous binary",
                            );
                        }
                    }
                }
            }
            Ok(None) => {}
            Err(error) => error!("sing-box update failed: {error}"),
        }
    }

    if let Some(desired) = policy.desired_agent_version.as_deref() {
        let executable = match std::env::current_exe() {
            Ok(path) => path,
            Err(error) => {
                error!("cannot determine agent executable for self-update: {error}");
                return false;
            }
        };
        match updates.maybe_update_agent(desired, &executable).await {
            Ok(restart) => return restart,
            Err(error) => error!("agent update failed: {error}"),
        }
    }
    false
}

async fn start_singbox_if_configured(bin: &Path, config: &ConfigManager) -> Option<SingBoxManager> {
    if !config.has_active_config() {
        return None;
    }
    match SingBoxManager::start(bin.to_path_buf(), config.config_path().clone()).await {
        Ok(manager) => Some(manager),
        Err(error) => {
            error!("failed to restart sing-box after binary update: {error}");
            None
        }
    }
}

fn update_status_body(status: &UpdateStatus) -> client::types::AgentHeartbeatBodyUpdatesAgent {
    client::types::AgentHeartbeatBodyUpdatesAgent {
        target_version: status
            .target_version
            .as_deref()
            .and_then(|version| version.try_into().ok()),
        state: status.state.as_str().parse().expect("valid update state"),
        message: status
            .message
            .as_deref()
            .and_then(|message| message.try_into().ok()),
        checked_at: status.checked_at,
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "heartbeat mirrors the agent's reconciliation inputs"
)]
async fn heartbeat(
    client: &client::Client,
    config: &mut ConfigManager,
    manager: Option<&SingBoxManager>,
    status: &AgentStatus,
    policy: AgentPolicy,
    sing_box_version: Option<&str>,
    updates: &UpdateManager,
    capabilities: &[&str],
) {
    use client::types;

    let runtime_error = manager.and_then(|manager| {
        if manager.state() == ProcessState::CrashLoop {
            manager.last_error().map(|message| ReportedError {
                phase: "runtime",
                code: "SINGBOX_CRASH_LOOP",
                message,
                node_id: None,
                occurred_at: Utc::now(),
            })
        } else {
            None
        }
    });
    let error = runtime_error
        .as_ref()
        .or(status.error.as_ref())
        .and_then(|error| {
            Some(types::AgentHeartbeatBodyError {
                code: error.code.try_into().ok()?,
                message: error.message.clone().try_into().ok()?,
                node_id: error.node_id.as_deref().and_then(|id| id.try_into().ok()),
                occurred_at: Some(error.occurred_at),
                phase: error.phase.try_into().ok()?,
            })
        });
    let runtime_state = manager
        .map(SingBoxManager::state)
        .map(ProcessState::as_str)
        .unwrap_or("stopped");
    config.set_runtime_confirmed(runtime_state == "running");
    let certificate_deployments = config
        .deployments()
        .iter()
        .filter_map(|deployment| {
            Some(types::AgentHeartbeatBodyCertificateDeploymentsItem {
                certificate_id: deployment.certificate_id.as_str().try_into().ok()?,
                error_message: deployment
                    .error_message
                    .as_deref()
                    .and_then(|message| message.try_into().ok()),
                error_phase: deployment
                    .error_phase
                    .as_deref()
                    .and_then(|phase| phase.try_into().ok()),
                fingerprint_sha256: deployment.fingerprint_sha256.as_str().try_into().ok()?,
                generation: NonZeroU64::new(deployment.generation)?,
                in_use: deployment.in_use,
                installed: deployment.installed,
            })
        })
        .collect();
    let body = types::AgentHeartbeatBody {
        active_node_ids: config
            .active_node_ids()
            .iter()
            .filter_map(|id| id.as_str().try_into().ok())
            .collect(),
        agent_build_id: AGENT_BUILD_ID.parse().expect("valid compile-time build id"),
        agent_capabilities: capabilities
            .iter()
            .map(|capability| capability.parse().expect("valid capability"))
            .collect(),
        agent_version: Some(AGENT_VERSION.to_string()),
        applied_at: config.applied_at(),
        applied_revision: config
            .applied_revision()
            .and_then(|revision| revision.try_into().ok()),
        certificate_deployments,
        clear_active_node_ids: Some(config.active_node_ids().is_empty()),
        clear_error: Some(error.is_none() && status.config_state == "applied"),
        config_state: status.config_state.parse().ok(),
        effective_config_poll_interval_seconds: NonZeroU64::new(
            policy.config_poll_interval_seconds,
        ),
        effective_heartbeat_interval_seconds: NonZeroU64::new(policy.heartbeat_interval_seconds),
        error,
        observed_revision: status
            .observed_revision
            .as_deref()
            .and_then(|revision| revision.try_into().ok()),
        runtime_state: runtime_state.parse().ok(),
        sing_box_version: sing_box_version.map(str::to_owned),
        updates: Some(types::AgentHeartbeatBodyUpdates {
            agent: Some(update_status_body(updates.agent_status())),
            sing_box: Some(types::AgentHeartbeatBodyUpdatesSingBox {
                target_version: updates
                    .singbox_status()
                    .target_version
                    .as_deref()
                    .and_then(|version| version.try_into().ok()),
                state: updates
                    .singbox_status()
                    .state
                    .as_str()
                    .parse()
                    .expect("valid update state"),
                message: updates
                    .singbox_status()
                    .message
                    .as_deref()
                    .and_then(|message| message.try_into().ok()),
                checked_at: updates.singbox_status().checked_at,
            }),
        }),
    };
    match client.agent_heartbeat(&body).await {
        Ok(_) => info!("heartbeat ok"),
        Err(e) => error!("heartbeat failed: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AGENT_CAPABILITIES, CandidateConfig, Cli, HelloSnapshot, PTY_CAPABILITY, WsProtocol,
        agent_capabilities, apply_singbox_log_overlay, apply_ws_policy, node_id_from_error,
    };
    use crate::config::AgentPolicy;
    use crate::log_policy::{
        Level as PolicyLevel, LogPolicy, PolicyRequest, RecordingFilter, Source as PolicySource,
    };
    use crate::ws::codec::WelcomePayload;
    use chrono::Utc;
    use clap::Parser as _;

    #[test]
    fn maps_singbox_inbound_index_back_to_node() {
        let candidate = CandidateConfig {
            revision: "sha256:test".to_string(),
            materialized_node_ids: vec!["node-a".to_string(), "node-b".to_string()],
            api_endpoint: crate::config::ApiEndpoint {
                addr: "127.0.0.1:0".to_string(),
                secret: None,
            },
            referenced_generations: vec![],
            log_level: PolicyLevel::Default,
        };
        assert_eq!(
            node_id_from_error(
                "decode config: inbounds[1].tls.acme: unknown provider",
                &candidate,
            ),
            Some("node-b".to_string()),
        );
    }

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

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn log_overlay_reloads_the_fake_process_and_keeps_the_revision() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!(
            "blossom-log-overlay-process-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let state_dir = dir.join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        let logs = crate::logs::LogStore::default();
        let policy = std::sync::Arc::new(
            LogPolicy::load(
                &state_dir,
                PolicyLevel::Info,
                RecordingFilter::new(),
                Utc::now(),
            )
            .0,
        );
        policy
            .request(
                PolicyRequest::new(PolicySource::SingBox, 1, PolicyLevel::Debug),
                Utc::now(),
            )
            .unwrap();
        let mut config = crate::config::ConfigManager::new(
            crate::client::new_client("http://127.0.0.1:1/api", "test-token")
                .expect("client builds"),
            state_dir.clone(),
            logs.clone(),
            policy.clone(),
        )
        .expect("config manager builds");
        std::fs::write(
            config.config_path(),
            serde_json::to_vec_pretty(&serde_json::json!({
                "log": {"level": "info"},
                "inbounds": [{"type": "socks", "listen": "127.0.0.1", "listen_port": 1080}]
            }))
            .unwrap(),
        )
        .unwrap();

        let level_file = dir.join("level");
        let bin = dir.join("fake-sing-box");
        std::fs::write(
            &bin,
            format!(
                "#!/bin/sh\n\
                 if [ \"$1\" = \"check\" ]; then exit 0; fi\n\
                 grep -o '\"level\": \"[a-z]*\"' \"$3\" | head -1 > '{}'\n\
                 echo 'INFO level applied'\n\
                 exec sleep 30\n",
                level_file.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();

        let mut manager = Some(
            crate::process::SingBoxManager::start_with_logs(
                bin.clone(),
                config.config_path().clone(),
                logs.clone(),
            )
            .await
            .expect("fake sing-box starts"),
        );
        let overlay = policy.overlay(Utc::now());
        assert_eq!(overlay.effective, PolicyLevel::Debug);
        apply_singbox_log_overlay(
            &mut config,
            &mut manager,
            &bin,
            overlay,
            std::time::Duration::from_secs(11),
        )
        .await
        .expect("log overlay applies through the validated path");
        assert_eq!(
            manager.as_ref().map(crate::process::SingBoxManager::state),
            Some(crate::process::ProcessState::Running)
        );
        let active: serde_json::Value =
            serde_json::from_slice(&std::fs::read(config.config_path()).unwrap()).unwrap();
        assert_eq!(active["log"]["level"], "debug");
        let last_good: serde_json::Value =
            serde_json::from_slice(&std::fs::read(state_dir.join("last-known-good.json")).unwrap())
                .unwrap();
        assert_eq!(last_good["log"]["level"], "debug");
        let level = std::fs::read_to_string(&level_file).unwrap();
        assert!(level.contains("debug"), "{level}");
        assert_eq!(config.observed_revision(), None);
        assert_eq!(config.applied_revision(), None);

        if let Some(manager) = manager.take() {
            manager.shutdown().await;
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reloadable_filter_changes_capture_without_rebuilding_the_layer() {
        use crate::log_policy::AgentFilter as _;
        use tracing_subscriber::layer::SubscriberExt as _;

        let store = crate::logs::LogStore::default();
        let (filter, handle) =
            tracing_subscriber::reload::Layer::new(tracing_subscriber::filter::LevelFilter::INFO);
        let subscriber = tracing_subscriber::registry()
            .with(filter)
            .with(crate::logs::CaptureLayer::new(store.clone()));
        tracing::subscriber::with_default(subscriber, || {
            tracing::debug!("dropped before the reload");
            super::ReloadingFilter { handle }
                .set_level(PolicyLevel::Debug)
                .expect("filter reloads");
            tracing::debug!("kept after the reload");
        });
        let texts: Vec<String> = store
            .resume(None, 10)
            .unwrap()
            .records
            .into_iter()
            .map(|record| record.text.clone())
            .collect();
        assert_eq!(texts, vec!["kept after the reload".to_string()]);
    }

    #[test]
    fn welcome_intervals_are_clamped_like_the_http_document() {
        let welcome = WelcomePayload {
            server_id: "srv-1".into(),
            server_name: "edge".into(),
            protocol_version: 1,
            desired_revision_seq: 1,
            desired_revision: "sha256:rev".into(),
            poll_interval_seconds: 1,
            heartbeat_interval_seconds: 100_000,
            reconnect_before_seconds: None,
        };
        let mut policy = AgentPolicy {
            config_poll_interval_seconds: 60,
            heartbeat_interval_seconds: 30,
            desired_agent_version: None,
            desired_sing_box_version: None,
        };
        apply_ws_policy(&welcome, &mut policy);
        assert_eq!(policy.config_poll_interval_seconds, 5);
        assert_eq!(policy.heartbeat_interval_seconds, 3_600);
    }

    #[test]
    fn hello_snapshot_carries_the_capabilities_and_build_id() {
        let state_dir = std::env::temp_dir().join(format!("blossom-hello-{}", std::process::id()));
        let policy = std::sync::Arc::new(
            LogPolicy::load(
                &state_dir,
                PolicyLevel::Info,
                RecordingFilter::new(),
                Utc::now(),
            )
            .0,
        );
        let config = crate::config::ConfigManager::new(
            crate::client::new_client("http://127.0.0.1:1/api", "test-token")
                .expect("client builds"),
            state_dir.clone(),
            crate::logs::LogStore::default(),
            policy,
        )
        .expect("config manager builds");
        let updates = crate::update::UpdateManager::new(
            crate::update::UpdateConfig {
                state_dir: std::env::temp_dir()
                    .join(format!("blossom-hello-state-{}", std::process::id())),
                download_dir: std::env::temp_dir()
                    .join(format!("blossom-hello-downloads-{}", std::process::id())),
                github_api: "https://api.github.com".into(),
                agent_repo: "acme/blossom".into(),
                singbox_repo: "acme/sing-box".into(),
                github_token: None,
                self_update: false,
                retry_after: std::time::Duration::from_secs(3600),
            },
            "0.2.0".to_string(),
            None,
        )
        .expect("update manager builds");
        let snapshot = HelloSnapshot::capture(&config, &updates, &["ws-v1"]);
        let payload = snapshot.payload();
        assert!(payload.capabilities.iter().any(|value| value == "ws-v1"));
        assert!(!payload.agent_build_id.is_empty());
        assert!(payload.updates.is_some());
        let _ = std::fs::remove_dir_all(state_dir);
        let _ = std::fs::remove_dir_all(
            std::env::temp_dir().join(format!("blossom-hello-state-{}", std::process::id())),
        );
        let _ = std::fs::remove_dir_all(
            std::env::temp_dir().join(format!("blossom-hello-downloads-{}", std::process::id())),
        );
    }

    fn pty_open_frame(session_id: &str) -> crate::ws::codec::ReservedFrame {
        crate::ws::codec::ReservedFrame {
            frame_type: "pty.open".to_owned(),
            payload: serde_json::json!({ "sessionId": session_id, "cols": 80, "rows": 24 }),
        }
    }

    fn pty_manager(shell: Option<&str>, limit: usize) -> crate::pty::PtyManager {
        let (events, _pty_events) = tokio::sync::mpsc::channel(8);
        let factory = crate::pty::session::PortablePtyFactory::new(
            events,
            crate::pty::launch::LaunchConfig {
                shell: shell.map(std::path::PathBuf::from),
                working_dir: std::path::PathBuf::from("/"),
            },
            "tester".to_owned(),
        );
        crate::pty::PtyManager::new(
            crate::pty::PtyLimits::new(
                true,
                limit,
                crate::pty::DEFAULT_IDLE_TIMEOUT,
                crate::pty::DEFAULT_MAX_SESSION,
            ),
            "tester".to_owned(),
            Box::new(factory),
        )
    }

    #[tokio::test]
    async fn pty_open_answers_with_started_or_a_typed_exit() {
        use crate::ws::ports::{WsCommand, command_channel};

        let (sink, mut commands) = command_channel(8);
        let sink = std::sync::Arc::new(sink);
        let mut manager = pty_manager(Some("/bin/sh"), 1);

        super::handle_pty_frame(pty_open_frame("pty-1"), &mut manager, sink.as_ref());
        let Some(WsCommand::Send(started)) = commands.recv().await else {
            panic!("expected pty.started");
        };
        assert_eq!(started.msg_type, "pty.started");
        assert_eq!(started.payload["sessionId"], "pty-1");
        assert_eq!(started.payload["shell"], "/bin/sh");
        assert_eq!(started.payload["user"], "tester");

        super::handle_pty_frame(pty_open_frame("pty-2"), &mut manager, sink.as_ref());
        let Some(WsCommand::Send(refused)) = commands.recv().await else {
            panic!("expected pty.exit for the session limit");
        };
        assert_eq!(refused.msg_type, "pty.exit");
        assert_eq!(refused.payload["reason"], "session_limit");
        assert_eq!(refused.payload["sessionId"], "pty-2");

        let mut missing = pty_manager(Some("/nonexistent/blossom-shell"), 1);
        super::handle_pty_frame(pty_open_frame("pty-3"), &mut missing, sink.as_ref());
        let Some(WsCommand::Send(failed)) = commands.recv().await else {
            panic!("expected pty.exit for the missing shell");
        };
        assert_eq!(failed.msg_type, "pty.exit");
        assert_eq!(failed.payload["reason"], "shell_unavailable");
        assert!(
            failed.payload["detail"]
                .as_str()
                .is_some_and(|detail| detail.contains("/nonexistent/blossom-shell"))
        );
    }

    fn service_startup(arguments: &[&str]) -> anyhow::Result<super::ServiceStartup> {
        let mut argv = vec!["server-agent"];
        argv.extend_from_slice(arguments);
        let cli = Cli::try_parse_from(argv).expect("CLI parses");
        cli.service.startup()
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
        let parse = |value: &str| {
            // SAFETY: this test owns the variable and no other test reads it.
            unsafe { std::env::set_var(KEY, value) };
            let result =
                service_startup(&["--url", "http://127.0.0.1:1/api", "--token", "agt_test"]);
            // SAFETY: paired with the set above in this single test.
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
