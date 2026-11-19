//! The protocol v2 agent runtime, selected with `--ws-protocol v2`.
//!
//! The WebSocket is the only control path. Configuration arrives as snapshots
//! that are verified before they reach the core, status and traffic travel
//! over the same session, and nothing polls the HTTP agent API.
//!
//! The core loop owns sing-box, the candidate and last-known-good configs,
//! and the updater. It runs one apply at a time, and the session never waits
//! on it. Network reads therefore continue during probation, a download, or a
//! sing-box restart. Status is published on change, so the session can send
//! `agent.status` as soon as the core's state moves.
//!
//! Not yet served by v2, so none is advertised: PTY, ACME, and telemetry. The
//! update targets arrive as `updatePolicy` in `welcome` and in
//! `agent.status.ack`, so v2 applies them without `update.trigger`.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, bail};
use chrono::Utc;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::config::{AgentPolicy, ConfigError, ConfigManager};
use crate::log_policy::LogPolicy;
use crate::logs::{LogStore, SecretScope};
use crate::process::{ProcessState, SingBoxManager, resolve_binary, singbox_version};
use crate::traffic::TrafficReporter;
use crate::update::{AGENT_RESTART_EXIT_CODE, UpdateManager, supports_singbox_version};
use crate::ws::RandomJitter;
use crate::ws::adapters::{SensitiveHeader, WsTransportConfig, ws_url};
use crate::ws::v2::adapter::V2Connector;
use crate::ws::v2::codec::{
    AckStage, ConfigIdentifier, ConfigState, RuntimeState, StatusError, UpdatePolicy,
};
use crate::ws::v2::link::{self, LinkOptions};
use crate::ws::v2::session::{
    self, ApplyJob, ApplyOutcome, ApplyResult, CoreStatus, HelloIdentity, SnapshotRefusal,
};
use crate::ws::v2::traffic::run_reporter;
use crate::{
    AGENT_BUILD_ID, AGENT_VERSION, AgentStatus, Args, ReportedError, apply_fetched,
    certificate_deployment, new_update_manager, reconcile_updates, record_config_error,
    shutdown_signal, start_last_known_good, update_status_payload_from,
};

/// What v2 advertises in `hello`. PTY, ACME, and telemetry are left out
/// because the v2 peer does not serve them, and `ws-v1` is not spoken on v2.
const V2_CAPABILITIES: &[&str] = &[
    "config-v3",
    "managed-tls-v3",
    "certificate-deployments-v1",
    "atomic-config-rollback",
    "connection-stream-traffic",
    "ws-v2",
    "traffic-v2",
];
const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// How often the core re-reads sing-box's process state, so a crash loop is
/// published without waiting for an apply.
const RUNTIME_SAMPLE: Duration = Duration::from_secs(5);
/// Longest status error message sent upstream; the contract caps it.
const MAX_STATUS_MESSAGE_CHARS: usize = 4096;

/// Runs the v2 agent until shutdown or until a self-update asks for a restart.
pub async fn run(args: &Args, logs: LogStore, log_policy: Arc<LogPolicy>) -> Result<()> {
    if !args.ws_enabled {
        bail!("--ws-protocol v2 is the WebSocket path and cannot run with --ws-enabled=false");
    }
    let url = ws_url(&args.url)?;
    let transport = V2Connector::new(WsTransportConfig {
        url: url.clone(),
        token: SensitiveHeader::bearer(&args.token)?,
        connect_timeout: WS_CONNECT_TIMEOUT,
    });
    info!("agent websocket protocol v2 selected; connecting to {url}");

    // Nothing here calls the HTTP agent API. The client only supplies the
    // configuration manager's type, and it is never used.
    let client = crate::client::new_client(&args.url, &args.token)?;
    let bin = resolve_binary(args.sing_box_path.clone());
    let mut sing_box_version = singbox_version(&bin).await;
    if let Some(version) = sing_box_version.as_deref()
        && !supports_singbox_version(version)
    {
        warn!("sing-box {version} is too old for connection-stream traffic");
    }
    let state_dir = args.state_dir.clone();
    let mut config =
        ConfigManager::new(client, state_dir.clone(), logs.clone(), log_policy.clone())?;
    logs.replace_secrets(SecretScope::StatsApi, config.api_endpoint().secret.iter())?;
    let mut updates = new_update_manager(args, sing_box_version.clone())?;

    // The committed config starts sing-box before the network is touched, so
    // a cold link leaves the proxy running on its last applied configuration.
    let (mut manager, startup_error) = start_last_known_good(&mut config, &bin).await;
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

    let endpoint = config.api_endpoint().clone();
    let reporter = TrafficReporter::new(endpoint.addr, endpoint.secret, state_dir.join("traffic"))?;

    let initial = snapshot(
        &config,
        manager.as_ref(),
        &status,
        sing_box_version.as_deref(),
        &updates,
    );
    let (mut session_ports, mut core, traffic_ports) = session::channels(
        initial.clone(),
        UpdatePolicy {
            desired_agent_version: None,
            desired_sing_box_version: None,
        },
    );
    let mut published = Some(initial);

    let cancel = CancellationToken::new();
    let options = LinkOptions::new(HelloIdentity {
        agent_version: AGENT_VERSION.to_string(),
        agent_build_id: AGENT_BUILD_ID.to_string(),
        capabilities: V2_CAPABILITIES.iter().map(|c| (*c).to_string()).collect(),
    });
    let link_cancel = cancel.clone();
    let link_task = tokio::spawn(async move {
        link::run(
            &transport,
            &mut session_ports,
            &options,
            &RandomJitter,
            &link_cancel,
        )
        .await;
    });
    let traffic_task = tokio::spawn(run_reporter(
        reporter,
        traffic_ports,
        Duration::from_secs(args.v2_traffic_interval_seconds),
        cancel.clone(),
    ));

    let probation = Duration::from_millis(args.v2_probation_ms);
    let policy = AgentPolicy {
        config_poll_interval_seconds: args.interval,
        heartbeat_interval_seconds: args.interval.min(300),
        desired_agent_version: None,
        desired_sing_box_version: None,
    };
    let mut runtime_tick = tokio::time::interval(RUNTIME_SAMPLE);
    runtime_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    runtime_tick.tick().await;
    let mut log_policy_tick = tokio::time::interval(Duration::from_secs(5));
    log_policy_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    log_policy_tick.tick().await;

    loop {
        tokio::select! {
            _ = shutdown_signal() => {
                info!("received shutdown signal");
                break;
            }
            job = core.apply.recv() => {
                let Some(job) = job else {
                    break;
                };
                let result = apply_job(job, &mut config, &mut manager, &bin, &mut status, probation).await;
                if core.results.send(result).await.is_err() {
                    break;
                }
            }
            changed = core.policy.changed() => {
                if changed.is_err() {
                    break;
                }
                let desired = core.policy.borrow_and_update().clone();
                let targets = AgentPolicy {
                    desired_agent_version: desired.desired_agent_version,
                    desired_sing_box_version: desired.desired_sing_box_version,
                    ..policy.clone()
                };
                if reconcile_updates(
                    &mut updates,
                    &targets,
                    &mut manager,
                    &bin,
                    &mut config,
                    &mut sing_box_version,
                )
                .await
                {
                    restart_for_update(manager.take()).await;
                }
            }
            refusal = core.refusals.recv() => {
                let Some(refusal) = refusal else {
                    break;
                };
                record_refusal(&mut status, refusal);
            }
            _ = log_policy_tick.tick() => {
                crate::log_policy_maintenance(
                    &log_policy,
                    &mut config,
                    &mut manager,
                    &bin,
                    probation,
                )
                .await;
            }
            _ = runtime_tick.tick() => {}
        }
        publish(
            &core.status,
            &mut published,
            snapshot(
                &config,
                manager.as_ref(),
                &status,
                sing_box_version.as_deref(),
                &updates,
            ),
        );
    }

    cancel.cancel();
    let _ = link_task.await;
    let _ = traffic_task.await;
    if let Some(manager) = manager {
        manager.shutdown().await;
    }
    info!("agent stopped (websocket protocol v2)");
    Ok(())
}

/// Applies one verified snapshot with the same safety invariants as the HTTP
/// path: preflight, promotion, process replacement, probation, then commit or
/// rollback. The result is what the session turns into `config.ack`.
async fn apply_job(
    job: ApplyJob,
    config: &mut ConfigManager,
    manager: &mut Option<SingBoxManager>,
    bin: &Path,
    status: &mut AgentStatus,
    probation: Duration,
) -> ApplyResult {
    let ApplyJob {
        request_id,
        desired,
        body,
    } = job;
    info!(
        revision_seq = desired.desired_revision_seq,
        "configuration snapshot verified; applying"
    );
    let outcome = match config.compile_snapshot(&body, &desired.desired_revision) {
        Err(error) => {
            record_config_error(config, status, &error);
            failed_from_config(&error)
        }
        Ok(fetched) => {
            match apply_fetched(config, manager, bin, status, fetched, probation).await {
                Err(error) => {
                    error!(revision = %desired.desired_revision, "configuration commit failed: {error}");
                    ApplyOutcome::Failed {
                        stage: AckStage::Store,
                        error: error.to_string(),
                    }
                }
                Ok(_)
                    if status.config_state == "applied"
                        && config.applied_revision() == Some(desired.desired_revision.as_str()) =>
                {
                    info!(
                        revision_seq = desired.desired_revision_seq,
                        "configuration applied"
                    );
                    ApplyOutcome::Applied
                }
                Ok(_) => match status.error.as_ref() {
                    Some(reported) => ApplyOutcome::Failed {
                        stage: stage_of(reported.phase, reported.code),
                        error: bounded(&reported.message),
                    },
                    None => ApplyOutcome::Failed {
                        stage: AckStage::Apply,
                        error: "the candidate was not applied".to_string(),
                    },
                },
            }
        }
    };
    ApplyResult {
        request_id,
        desired,
        outcome,
    }
}

fn failed_from_config(error: &ConfigError) -> ApplyOutcome {
    ApplyOutcome::Failed {
        stage: stage_of(error.phase, error.code),
        error: bounded(&error.message),
    }
}

/// Maps the failing reconcile phase to the contract's `config.ack` stage.
fn stage_of(phase: &str, code: &str) -> AckStage {
    match (phase, code) {
        (_, "CANDIDATE_WRITE_FAILED" | "STATE_PERSIST_FAILED") | ("promote", _) => AckStage::Store,
        ("fetch" | "receive", _) => AckStage::Receive,
        ("reconcile" | "preflight", _) => AckStage::Validate,
        _ => AckStage::Apply,
    }
}

/// Records a control-plane refusal. The applied configuration is kept.
fn record_refusal(status: &mut AgentStatus, refusal: SnapshotRefusal) {
    let code = match refusal.code.as_str() {
        "snapshot_too_large" => "SNAPSHOT_TOO_LARGE",
        "unavailable" => "SNAPSHOT_UNAVAILABLE",
        "internal" => "SNAPSHOT_INTERNAL",
        _ => "SNAPSHOT_REFUSED",
    };
    warn!(code, "control plane refused the configuration snapshot");
    status.error = Some(ReportedError {
        phase: "snapshot",
        code,
        message: bounded(&refusal.message),
        node_id: None,
        occurred_at: Utc::now(),
    });
}

/// The state the session reports. Crash loops take precedence over the last
/// reconcile error, as they do on the HTTP heartbeat.
fn snapshot(
    config: &ConfigManager,
    manager: Option<&SingBoxManager>,
    status: &AgentStatus,
    sing_box_version: Option<&str>,
    updates: &UpdateManager,
) -> CoreStatus {
    let runtime = manager.map(SingBoxManager::state);
    let crash = manager
        .filter(|manager| manager.state() == ProcessState::CrashLoop)
        .and_then(SingBoxManager::last_error);
    let error = match (crash, status.error.as_ref()) {
        (Some(message), _) => Some(StatusError {
            phase: "runtime".to_string(),
            code: "SINGBOX_CRASH_LOOP".to_string(),
            message: bounded(&message),
            node_id: None,
            occurred_at: None,
        }),
        (None, Some(reported)) => Some(StatusError {
            phase: reported.phase.to_string(),
            code: reported.code.to_string(),
            message: bounded(&reported.message),
            node_id: reported.node_id.clone(),
            occurred_at: None,
        }),
        (None, None) => None,
    };
    CoreStatus {
        // A config that must be re-applied is not trusted, so it is not
        // reported as applied. The control plane then sends a snapshot.
        applied: if config.needs_reapply() {
            None
        } else {
            config
                .applied_revision()
                .and_then(ConfigIdentifier::from_revision)
        },
        runtime_state: runtime.map_or(RuntimeState::Stopped, runtime_state_of),
        config_state: config_state_of(status.config_state),
        sing_box_version: sing_box_version.map(str::to_owned),
        active_node_ids: config.active_node_ids().to_vec(),
        error,
        deployments: config
            .deployments()
            .iter()
            .map(certificate_deployment)
            .collect(),
        updates: update_status_payload_from(updates.agent_status(), updates.singbox_status()),
    }
}

fn runtime_state_of(state: ProcessState) -> RuntimeState {
    match state {
        ProcessState::Starting => RuntimeState::Starting,
        ProcessState::Running => RuntimeState::Running,
        ProcessState::Stopped => RuntimeState::Stopped,
        ProcessState::CrashLoop => RuntimeState::CrashLoop,
    }
}

fn config_state_of(state: &str) -> ConfigState {
    match state {
        "applied" => ConfigState::Applied,
        "rejected" => ConfigState::Rejected,
        "apply_failed" => ConfigState::ApplyFailed,
        _ => ConfigState::Unknown,
    }
}

fn bounded(message: &str) -> String {
    message.chars().take(MAX_STATUS_MESSAGE_CHARS).collect()
}

/// Sends the state to the session only when it differs from the last value,
/// since every `watch` publish is a significant change to the session.
fn publish(sender: &watch::Sender<CoreStatus>, last: &mut Option<CoreStatus>, next: CoreStatus) {
    if last.as_ref() == Some(&next) {
        return;
    }
    sender.send_replace(next.clone());
    *last = Some(next);
}

/// Exits for the supervisor after a self-update. Over v2 the next start reports
/// the new version in its `hello`, so no final HTTP heartbeat is needed.
async fn restart_for_update(manager: Option<SingBoxManager>) -> ! {
    info!("agent update installed; exiting for supervisor restart");
    if let Some(manager) = manager {
        manager.shutdown().await;
    }
    std::process::exit(AGENT_RESTART_EXIT_CODE)
}

#[cfg(test)]
mod tests {
    use super::{V2_CAPABILITIES, bounded, config_state_of, stage_of};
    use crate::ws::v2::codec::{AckStage, ConfigState};

    #[test]
    fn v2_advertises_only_what_the_v2_peer_serves() {
        for withheld in ["pty-v1", "acme-v1", "telemetry-v1", "ws-v1"] {
            assert!(
                !V2_CAPABILITIES.contains(&withheld),
                "{withheld} must not be advertised on v2"
            );
        }
        assert!(V2_CAPABILITIES.contains(&"ws-v2"));
    }

    #[test]
    fn reconcile_phases_map_to_the_contract_stages() {
        assert_eq!(stage_of("fetch", "CONFIG_FETCH_FAILED"), AckStage::Receive);
        assert_eq!(stage_of("receive", "SNAPSHOT_INVALID"), AckStage::Receive);
        assert_eq!(
            stage_of("reconcile", "CERTIFICATE_VALIDATION_FAILED"),
            AckStage::Validate
        );
        assert_eq!(
            stage_of("preflight", "SINGBOX_CONFIG_INVALID"),
            AckStage::Validate
        );
        assert_eq!(
            stage_of("reconcile", "CANDIDATE_WRITE_FAILED"),
            AckStage::Store
        );
        assert_eq!(
            stage_of("promote", "CONFIG_PROMOTE_FAILED"),
            AckStage::Store
        );
        assert_eq!(stage_of("apply", "SINGBOX_START_FAILED"), AckStage::Apply);
        assert_eq!(
            stage_of("health", "SINGBOX_HEALTH_CHECK_FAILED"),
            AckStage::Apply
        );
    }

    #[test]
    fn config_states_use_the_contract_names() {
        assert_eq!(config_state_of("apply_failed"), ConfigState::ApplyFailed);
        assert_eq!(config_state_of("applied"), ConfigState::Applied);
        assert_eq!(config_state_of("anything else"), ConfigState::Unknown);
    }

    #[test]
    fn status_messages_are_bounded_to_the_contract() {
        let long = "x".repeat(10_000);
        assert_eq!(bounded(&long).chars().count(), 4096);
        assert_eq!(bounded("short"), "short");
    }
}
