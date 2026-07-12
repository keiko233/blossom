//! server-agent: runs sing-box on a proxy server host, driven by the blossom
//! control plane. It pulls the server's full multi-inbound sing-box config over
//! the `/api` surface, keeps sing-box running (restart on crash, SIGHUP
//! hot-reload on config change), and heartbeats its version back to the server.
//! A server owns one agent token and one running sing-box process; each "node"
//! on that server is compiled as one inbound inside that single config.

mod client;
mod config;
mod process;
mod stats;
mod traffic;

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::Parser;
use tokio::signal;
use tracing::{error, info};

use crate::config::{ConfigManager, FetchStatus};
use crate::process::{SingBoxManager, resolve_binary};
use crate::traffic::TrafficReporter;

const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Parser)]
#[command(name = "server-agent", version, about = "blossom proxy server agent")]
struct Args {
    /// Base URL of the blossom API, including the `/api` prefix
    /// (e.g. http://localhost:3000/api).
    #[arg(long, env = "AGENT_URL")]
    url: String,

    /// Per-server agent token (shown once at server creation or token reset).
    #[arg(long, env = "AGENT_TOKEN")]
    token: String,

    /// Seconds between config-fetch + heartbeat cycles.
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

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    tracing_subscriber::fmt()
        .with_max_level(parse_level(&args.log_level))
        .init();

    let client = client::new_client(&args.url, &args.token)?;

    // Pull the initial config and materialise it before launching sing-box.
    let mut config = ConfigManager::new(client.clone())?;
    config
        .fetch()
        .await
        .context("initial config fetch failed")?;

    let mut reporter: Option<TrafficReporter> = config
        .v2ray_api_listen()
        .map(|addr| {
            TrafficReporter::new(addr.to_string()).context("failed to create traffic reporter")
        })
        .transpose()?;
    if reporter.is_none() {
        info!("v2ray_api not configured; traffic reporting disabled");
    }

    let bin = resolve_binary(args.sing_box_path);
    let manager = SingBoxManager::start(bin, config.config_path().clone()).await?;

    // Post an immediate heartbeat so the server shows online without waiting a cycle.
    heartbeat(&client).await;

    info!("agent running; polling every {}s", args.interval);
    let mut ticker = tokio::time::interval(Duration::from_secs(args.interval));
    ticker.tick().await; // consume the immediate first tick

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                poll_once(&mut config, &manager, &client, &mut reporter).await;
            }
            _ = signal::ctrl_c() => {
                info!("received ctrl-c, shutting down");
                break;
            }
        }
    }

    manager.shutdown().await;
    info!("agent stopped");
    Ok(())
}

/// One polling cycle: collect traffic deltas, refresh config (reloading sing-box
/// if it changed), reconcile the traffic reporter, and heartbeat. Errors are
/// logged, never fatal — the loop keeps the server agent alive.
async fn poll_once(
    config: &mut ConfigManager,
    manager: &SingBoxManager,
    client: &client::Client,
    reporter: &mut Option<TrafficReporter>,
) {
    // Drain counters before any potential config reload, which would zero them.
    if let Some(reporter) = reporter.as_mut() {
        reporter.collect_and_report(client).await;
    }

    let fetch_status = match config.fetch().await {
        Ok(status) => Some(status),
        Err(e) => {
            error!("config fetch failed: {e}");
            None
        }
    };

    if fetch_status.is_some() {
        reconcile_reporter(config.v2ray_api_listen(), reporter);
    }

    if fetch_status == Some(FetchStatus::Updated) {
        info!("config changed; reloading sing-box");
        if let Err(e) = manager.reload().await {
            error!("failed to request reload: {e}");
        }
    }

    heartbeat(client).await;
}

fn reconcile_reporter(addr: Option<&str>, reporter: &mut Option<TrafficReporter>) {
    match (addr, reporter.as_mut()) {
        (Some(addr), Some(reporter)) => {
            if let Err(e) = reporter.update_addr(addr) {
                error!("failed to update traffic stats address: {e}");
            }
        }
        (Some(addr), None) => match TrafficReporter::new(addr.to_string()) {
            Ok(r) => {
                info!("traffic reporting enabled");
                *reporter = Some(r);
            }
            Err(e) => error!("failed to enable traffic reporting: {e}"),
        },
        (None, Some(_)) => {
            info!("v2ray_api no longer configured; traffic reporting disabled");
            *reporter = None;
        }
        (None, None) => {}
    }
}

async fn heartbeat(client: &client::Client) {
    let body = client::types::AgentHeartbeatBody {
        agent_version: Some(AGENT_VERSION.to_string()),
    };
    match client.agent_heartbeat(&body).await {
        Ok(_) => info!("heartbeat ok"),
        Err(e) => error!("heartbeat failed: {e}"),
    }
}
