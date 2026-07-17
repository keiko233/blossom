//! server-agent: runs sing-box on a proxy server host, driven by the blossom
//! control plane. It pulls the server's full multi-inbound sing-box config over
//! the `/api` surface, keeps sing-box running (restart on crash, SIGHUP
//! hot-reload on config change), and heartbeats its version back to the server.
//! A server owns one agent token and one running sing-box process; each "node"
//! on that server is compiled as one inbound inside that single config.

mod certificate;
mod client;
mod config;
mod process;
mod stats;
mod traffic;

use std::num::NonZeroU64;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Result;
use chrono::Utc;
use clap::Parser;
use tokio::signal;
use tracing::{error, info};

use crate::config::{AgentPolicy, CandidateConfig, ConfigManager, FetchStatus};
use crate::process::{ProcessState, SingBoxManager, check_config, resolve_binary, singbox_version};
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
    let _ = rustls::crypto::ring::default_provider().install_default();
    let args = Args::parse();
    tracing_subscriber::fmt()
        .with_max_level(parse_level(&args.log_level))
        .init();

    let client = client::new_client(&args.url, &args.token)?;

    let bin = resolve_binary(args.sing_box_path);
    let sing_box_version = singbox_version(&bin).await;
    let mut config = ConfigManager::new(client.clone(), args.state_dir)?;
    let (mut manager, startup_error) = if config.has_active_config() {
        match SingBoxManager::start(bin.clone(), config.config_path().clone()).await {
            Ok(manager) => (Some(manager), None),
            Err(e) => {
                error!("failed to start last-known-good config: {e}");
                (None, Some(e.to_string()))
            }
        }
    } else {
        (None, None)
    };
    let mut reporter = config
        .v2ray_api_listen()
        .and_then(|addr| TrafficReporter::new(addr.to_string()).ok());
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
    };

    match sync_config(&mut config, &mut manager, &bin, &mut status).await {
        Ok(next) => policy = next,
        Err(e) => error!("initial config sync failed: {e}"),
    }
    reconcile_reporter(config.v2ray_api_listen(), &mut reporter);
    heartbeat(
        &client,
        &config,
        manager.as_ref(),
        &status,
        policy,
        sing_box_version.as_deref(),
    )
    .await;

    info!(
        "agent running; config poll={}s heartbeat={}s",
        policy.config_poll_interval_seconds, policy.heartbeat_interval_seconds
    );
    let mut config_sleep = Box::pin(tokio::time::sleep(Duration::from_secs(
        policy.config_poll_interval_seconds,
    )));
    let mut heartbeat_sleep = Box::pin(tokio::time::sleep(Duration::from_secs(
        policy.heartbeat_interval_seconds,
    )));

    loop {
        tokio::select! {
            _ = &mut config_sleep => {
                if let Some(reporter) = reporter.as_mut() {
                    reporter.collect_and_report(&client).await;
                }
                match sync_config(&mut config, &mut manager, &bin, &mut status).await {
                    Ok(next) => policy = next,
                    Err(e) => error!("config sync failed: {e}"),
                }
                reconcile_reporter(config.v2ray_api_listen(), &mut reporter);
                heartbeat(
                    &client,
                    &config,
                    manager.as_ref(),
                    &status,
                    policy,
                    sing_box_version.as_deref(),
                ).await;
                config_sleep.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(policy.config_poll_interval_seconds));
                heartbeat_sleep.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(policy.heartbeat_interval_seconds));
            }
            _ = &mut heartbeat_sleep => {
                heartbeat(
                    &client,
                    &config,
                    manager.as_ref(),
                    &status,
                    policy,
                    sing_box_version.as_deref(),
                ).await;
                heartbeat_sleep.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(policy.heartbeat_interval_seconds));
            }
            _ = signal::ctrl_c() => {
                info!("received ctrl-c, shutting down");
                break;
            }
        }
    }

    if let Some(manager) = manager {
        manager.shutdown().await;
    }
    info!("agent stopped");
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

async fn sync_config(
    config: &mut ConfigManager,
    manager: &mut Option<SingBoxManager>,
    bin: &Path,
    status: &mut AgentStatus,
) -> Result<AgentPolicy> {
    let (policy, candidate) = match config.fetch().await? {
        FetchStatus::Unchanged(policy) => {
            if manager.is_none() && config.has_active_config() {
                match SingBoxManager::start(bin.to_path_buf(), config.config_path().clone()).await {
                    Ok(started) => {
                        *manager = Some(started);
                        status.error = None;
                    }
                    Err(e) => {
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
            return Ok(policy);
        }
        FetchStatus::Updated { policy, candidate } => (policy, candidate),
    };
    status.observed_revision = Some(candidate.revision.clone());

    if let Err(e) = check_config(bin, config.candidate_path()).await {
        let message = e.to_string();
        status.config_state = "rejected";
        status.error = Some(ReportedError {
            phase: "preflight",
            code: "SINGBOX_CONFIG_INVALID",
            node_id: node_id_from_error(&message, &candidate),
            message,
            occurred_at: Utc::now(),
        });
        return Ok(policy);
    }

    if let Err(e) = config.promote_candidate() {
        status.config_state = "apply_failed";
        status.error = Some(ReportedError {
            phase: "promote",
            code: "CONFIG_PROMOTE_FAILED",
            message: e.to_string(),
            node_id: None,
            occurred_at: Utc::now(),
        });
        return Ok(policy);
    }

    let apply_result = if let Some(current) = manager.as_ref() {
        current.reload().await
    } else {
        match SingBoxManager::start(bin.to_path_buf(), config.config_path().clone()).await {
            Ok(started) => {
                *manager = Some(started);
                Ok(())
            }
            Err(e) => Err(e),
        }
    };

    if let Err(e) = apply_result {
        let _ = config.rollback();
        status.config_state = "apply_failed";
        status.error = Some(ReportedError {
            phase: "reload",
            code: "SINGBOX_RELOAD_FAILED",
            message: e.to_string(),
            node_id: None,
            occurred_at: Utc::now(),
        });
        return Ok(policy);
    }

    // sing-box performs its own check on SIGHUP, then recreates and starts the
    // service. Only commit the candidate after it survives the health window.
    tokio::time::sleep(Duration::from_secs(11)).await;
    if manager.as_ref().map(SingBoxManager::state) == Some(ProcessState::Running) {
        config.commit_applied(&candidate)?;
        status.config_state = "applied";
        status.error = None;
        info!("sing-box config {} applied", candidate.revision);
    } else {
        let rolled_back = config.rollback()?;
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

fn node_id_from_error(message: &str, candidate: &CandidateConfig) -> Option<String> {
    let start = message.find("inbounds[")? + "inbounds[".len();
    let end = message[start..].find(']')? + start;
    let index = message[start..end].parse::<usize>().ok()?;
    candidate.materialized_node_ids.get(index).cloned()
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

async fn heartbeat(
    client: &client::Client,
    config: &ConfigManager,
    manager: Option<&SingBoxManager>,
    status: &AgentStatus,
    policy: AgentPolicy,
    sing_box_version: Option<&str>,
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
    let body = types::AgentHeartbeatBody {
        active_node_ids: config
            .active_node_ids()
            .iter()
            .filter_map(|id| id.as_str().try_into().ok())
            .collect(),
        agent_version: Some(AGENT_VERSION.to_string()),
        applied_at: config.applied_at(),
        applied_revision: config
            .applied_revision()
            .and_then(|revision| revision.try_into().ok()),
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
    };
    match client.agent_heartbeat(&body).await {
        Ok(_) => info!("heartbeat ok"),
        Err(e) => error!("heartbeat failed: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{CandidateConfig, node_id_from_error};

    #[test]
    fn maps_singbox_inbound_index_back_to_node() {
        let candidate = CandidateConfig {
            revision: "sha256:test".to_string(),
            materialized_node_ids: vec!["node-a".to_string(), "node-b".to_string()],
            v2ray_listen: None,
        };
        assert_eq!(
            node_id_from_error(
                "decode config: inbounds[1].tls.acme: unknown provider",
                &candidate,
            ),
            Some("node-b".to_string()),
        );
    }
}
