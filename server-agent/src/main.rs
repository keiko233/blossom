//! server-agent: runs sing-box on a proxy node, driven by the blossom control
//! plane. It pulls the node's full sing-box config over the `/api` surface,
//! keeps sing-box running (restart on crash, SIGHUP hot-reload on config change),
//! and heartbeats its version back to the server.

mod client;
mod config;
mod process;

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::Parser;
use tokio::signal;
use tracing::{error, info};

use crate::config::{ConfigManager, FetchStatus};
use crate::process::{SingBoxManager, resolve_binary};

const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Parser)]
#[command(name = "server-agent", version, about = "blossom proxy node agent")]
struct Args {
    /// Base URL of the blossom API, including the `/api` prefix
    /// (e.g. http://localhost:3000/api).
    #[arg(long, env = "AGENT_URL")]
    url: String,

    /// Per-node agent token (the `agt_...` value shown once at node creation).
    #[arg(long, env = "AGENT_TOKEN")]
    token: String,

    /// Seconds between config-fetch + heartbeat cycles.
    #[arg(long, default_value_t = 60)]
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

    let bin = resolve_binary(args.sing_box_path);
    let manager = SingBoxManager::start(bin, config.config_path().clone()).await?;

    // Post an immediate heartbeat so the node shows online without waiting a cycle.
    heartbeat(&client).await;

    info!("agent running; polling every {}s", args.interval);
    let mut ticker = tokio::time::interval(Duration::from_secs(args.interval));
    ticker.tick().await; // consume the immediate first tick

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                poll_once(&mut config, &manager, &client).await;
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

/// One polling cycle: refresh config (reloading sing-box if it changed) and
/// heartbeat. Errors are logged, never fatal — the loop keeps the node alive.
async fn poll_once(config: &mut ConfigManager, manager: &SingBoxManager, client: &client::Client) {
    match config.fetch().await {
        Ok(FetchStatus::Updated) => {
            info!("config changed; reloading sing-box");
            if let Err(e) = manager.reload().await {
                error!("failed to request reload: {e}");
            }
        }
        Ok(FetchStatus::Unchanged) => {}
        Err(e) => error!("config fetch failed: {e}"),
    }
    heartbeat(client).await;
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
