//! server-agent: runs sing-box on a proxy server host, driven by the blossom
//! control plane. It pulls the server's full multi-inbound sing-box config over
//! the `/api` surface, keeps sing-box running (restart on crash and verified
//! process replacement on config change), and heartbeats its version back to
//! the server.
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
const AGENT_BUILD_ID: &str = env!("AGENT_BUILD_ID");
const AGENT_CAPABILITIES: [&str; 4] = [
    "config-v3",
    "managed-tls-v3",
    "certificate-deployments-v1",
    "atomic-config-rollback",
];
const RUNTIME_PROBATION: Duration = Duration::from_secs(11);

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
        match check_config(&bin, config.config_path()).await {
            Ok(()) => {
                match SingBoxManager::start(bin.clone(), config.config_path().clone()).await {
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
    } else {
        (None, config.startup_error().map(str::to_owned))
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
        &mut config,
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
                    &mut config,
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
                    &mut config,
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
    let fetched = config.fetch().await.map_err(|error| {
        status.config_state = "apply_failed";
        status.observed_revision = config.observed_revision().map(str::to_owned);
        status.error = Some(ReportedError {
            phase: error.phase,
            code: error.code,
            message: error.message.clone(),
            node_id: error.node_id.clone(),
            occurred_at: Utc::now(),
        });
        anyhow::Error::new(error)
    })?;
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
        restore_runtime(manager, bin, config, rolled_back).await;
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
    tokio::time::sleep(RUNTIME_PROBATION).await;
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
        restore_runtime(manager, bin, config, rolled_back).await;
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

async fn restore_runtime(
    manager: &mut Option<SingBoxManager>,
    bin: &Path,
    config: &mut ConfigManager,
    rolled_back: bool,
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
    tokio::time::sleep(RUNTIME_PROBATION).await;
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
    config: &mut ConfigManager,
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
        agent_capabilities: AGENT_CAPABILITIES
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
            referenced_generations: vec![],
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
