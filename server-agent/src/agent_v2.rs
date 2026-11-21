//! The protocol v2 agent runtime, the default for both credential modes.
//!
//! The WebSocket is the only control path. Configuration arrives as snapshots
//! that are verified before they reach the core, status and traffic travel
//! over the same session, and nothing polls the HTTP agent API.
//! `--ws-protocol legacy` is the explicit compatibility opt-in for the v1
//! transport; this runtime never substitutes an HTTP poll when the socket is
//! unavailable.
//!
//! The core loop owns sing-box, the candidate and last-known-good configs,
//! and the updater. It runs one apply at a time, and the session never waits
//! on it. Network reads therefore continue during probation, a download, or a
//! sing-box restart. Status is published on change, so the session can send
//! `agent.status` as soon as the core's state moves.
//!
//! Not yet served by v2, so neither is advertised: PTY and ACME. Telemetry is
//! served on Linux through the additive v2 subscription frames. The update
//! targets arrive as `updatePolicy` in `welcome` and in `agent.status.ack`, so
//! v2 applies them without `update.trigger`.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, bail};
use chrono::Utc;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::acme::solver_dns01::DnsAck;
use crate::config::{AgentPolicy, ConfigError, ConfigManager};
use crate::log_policy::{LogPolicy, PolicyAction, PolicyRequest, SOURCES, Source as PolicySource};
use crate::logs::{LogStore, SecretScope};
use crate::oauth::OAuthTokenProvider;
use crate::process::{ProcessState, SingBoxManager, resolve_binary, singbox_version};
use crate::service::{ActiveState, NativeRuntime};
use crate::traffic::TrafficReporter;
use crate::update::{AGENT_RESTART_EXIT_CODE, UpdateManager, supports_singbox_version};
use crate::ws::RandomJitter;
use crate::ws::adapters::{SensitiveHeader, WsTransportConfig, ws_url};
use crate::ws::codec::{AgentWsFrame, frame_type};
use crate::ws::ports::WsCommand;
use crate::ws::v2::adapter::V2Connector;
use crate::ws::v2::codec::{
    AckStage, ConfigIdentifier, ConfigState, LOGS_SEARCH_CAPABILITY, LOGS_TAIL_CAPABILITY,
    LogPolicyAck, RuntimeState, StatusError, UpdatePolicy,
};
use crate::ws::v2::link::{self, LinkOptions};
use crate::ws::v2::session::{
    self, ApplyJob, ApplyOutcome, ApplyResult, Command, CoreStatus, HelloIdentity, LogPolicyJob,
    SnapshotRefusal,
};
use crate::ws::v2::telemetry;
use crate::ws::v2::traffic::run_reporter;
use crate::{
    AGENT_BUILD_ID, AGENT_VERSION, AgentStatus, Args, AuthMode, ReportedError, ServiceStartup,
    apply_fetched, apply_update_trigger, certificate_deployment, handle_pty_event,
    handle_pty_frame, new_acme_manager, new_pty_manager, new_update_manager, reconcile_updates,
    record_config_error, shutdown_signal, start_last_known_good, update_status_payload_from,
};

/// What v2 advertises in `hello`; `ws-v1` is not spoken on this transport.
const V2_CAPABILITIES: &[&str] = &[
    "config-v3",
    "managed-tls-v3",
    "certificate-deployments-v1",
    "atomic-config-rollback",
    "connection-stream-traffic",
    "acme-v1",
    "log-policy-v1",
    "ws-v2",
    "traffic-v2",
    LOGS_TAIL_CAPABILITY,
    LOGS_SEARCH_CAPABILITY,
];
const V2_PTY_CAPABILITY: &str = "pty-v2";

fn v2_capabilities(pty_enabled: bool) -> Vec<String> {
    let mut capabilities: Vec<String> = V2_CAPABILITIES
        .iter()
        .map(|capability| (*capability).to_string())
        .collect();
    if pty_enabled {
        capabilities.push(V2_PTY_CAPABILITY.to_string());
    }
    if telemetry::supported() {
        capabilities.push("telemetry-v2".to_string());
        capabilities.push("telemetry-history-v2".to_string());
    }
    capabilities
}
const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// How often the core re-reads sing-box's process state, so a crash loop is
/// published without waiting for an apply.
const RUNTIME_SAMPLE: Duration = Duration::from_secs(5);
/// Longest status error message sent upstream; the contract caps it.
const MAX_STATUS_MESSAGE_CHARS: usize = 4096;

/// Runs the v2 agent until shutdown or until a self-update asks for a restart.
pub async fn run(
    args: &Args,
    startup: &ServiceStartup,
    logs: LogStore,
    log_policy: Arc<LogPolicy>,
) -> Result<()> {
    if !args.ws_enabled {
        bail!("protocol v2 is the WebSocket path and cannot run with --ws-enabled=false");
    }
    let url = ws_url(&startup.url)?;
    let transport = match &startup.auth {
        AuthMode::Static(token) => V2Connector::new(WsTransportConfig {
            url: url.clone(),
            token: SensitiveHeader::bearer(token)?,
            connect_timeout: WS_CONNECT_TIMEOUT,
        }),
        AuthMode::OAuth(path) => {
            let provider =
                Arc::new(OAuthTokenProvider::load(path, &startup.url, logs.clone()).await?);
            V2Connector::with_bearer(url.clone(), provider, WS_CONNECT_TIMEOUT)
        }
    };
    info!("agent websocket protocol v2 selected; connecting to {url}");

    // Nothing here calls the HTTP agent API. The client only supplies the
    // configuration manager's type, and it is never used.
    let client = crate::client::new_client(&startup.url, "v2-does-not-use-http")?;
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
    let native = args.native_service_control.then(|| {
        NativeRuntime::new(
            &args.service_control_socket,
            &args.service_control_release_dir,
        )
    });

    // The committed config starts sing-box before the network is touched, so
    // a cold link leaves the proxy running on its last applied configuration.
    // In native mode systemd already made that decision in its own
    // `ExecStartPre=+` step before this process started.
    let (mut manager, startup_error) = match &native {
        Some(native) => {
            if let Err(error) = native.reconcile().await {
                warn!("native service reconcile failed at startup: {error}");
            }
            (None, None)
        }
        None => start_last_known_good(&mut config, &bin).await,
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

    let endpoint = config.api_endpoint().clone();
    let reporter = TrafficReporter::new(endpoint.addr, endpoint.secret, state_dir.join("traffic"))?;

    let initial = snapshot(
        &config,
        manager.as_ref(),
        native.as_ref().and_then(NativeRuntime::active_state),
        &status,
        sing_box_version.as_deref(),
        &updates,
    );
    let mut log_policy_errors = BTreeMap::new();
    let initial_log_acks = log_policy_acks(&log_policy, &log_policy_errors);
    let (mut session_ports, mut core, traffic_ports) = session::channels(
        initial.clone(),
        UpdatePolicy {
            desired_agent_version: None,
            desired_sing_box_version: None,
        },
        initial_log_acks.clone(),
    );
    let mut published = Some(initial);
    let (pty_event_sender, mut pty_events) = tokio::sync::mpsc::channel(64);
    let (mut pty_manager, pty_enabled) = new_pty_manager(args, pty_event_sender);
    let capabilities = v2_capabilities(pty_enabled);
    {
        let sink = core.outbound.clone();
        updates.set_status_observer(std::sync::Arc::new(move |agent, singbox| {
            if let Ok(frame) = AgentWsFrame::new(
                frame_type::UPDATE_STATUS,
                update_status_payload_from(agent, singbox),
            ) {
                let _ = sink.enqueue(WsCommand::Send(frame));
            }
        }));
    }
    let acme = new_acme_manager(args, core.outbound.clone());
    let mut published_log = Some(initial_log_acks);

    let cancel = CancellationToken::new();
    let options = LinkOptions::new(HelloIdentity {
        agent_version: AGENT_VERSION.to_string(),
        agent_build_id: AGENT_BUILD_ID.to_string(),
        capabilities,
    });
    let link_cancel = cancel.clone();
    let link_logs = logs.clone();
    let link_task = tokio::spawn(async move {
        link::run(
            &transport,
            &mut session_ports,
            &options,
            &RandomJitter,
            &link_cancel,
            &link_logs,
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
    let mut pty_tick = tokio::time::interval(Duration::from_secs(15));
    pty_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    pty_tick.tick().await;
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
                let result = apply_job(
                    job,
                    &mut config,
                    &mut manager,
                    &bin,
                    &mut status,
                    probation,
                    native.as_ref(),
                )
                .await;
                if core.results.send(result).await.is_err() {
                    break;
                }
            }
            Some(()) = core.disabled.recv() => {
                apply_administrative_disable(&mut config, &mut manager, &bin, native.as_ref()).await;
            }
            job = core.log_jobs.recv() => {
                let Some(job) = job else {
                    break;
                };
                if native.is_some() {
                    warn!("log-level policy is not served by the native runtime adapter yet");
                } else {
                    apply_log_policy_job(
                        &log_policy,
                        &mut config,
                        &mut manager,
                        &bin,
                        probation,
                        job,
                        &mut log_policy_errors,
                    )
                    .await;
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
                if native.is_none()
                    && reconcile_updates(
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
            command = core.commands.recv() => {
                let Some(command) = command else {
                    break;
                };
                match command {
                    Command::UpdateTrigger(trigger) => {
                        info!(
                            target = ?trigger.target,
                            force = trigger.force,
                            "update push received on v2; reconciling immediately"
                        );
                        if native.is_some() {
                            warn!("native runtime updates require the installer promoter; update trigger ignored");
                        } else {
                            let exit = apply_update_trigger(
                                trigger,
                                &mut updates,
                                &mut manager,
                                &bin,
                                &mut config,
                                &mut sing_box_version,
                                &policy,
                            )
                            .await;
                            if exit {
                                restart_for_update(manager.take()).await;
                            }
                        }
                    }
                    Command::AcmeIssue(issue) => {
                        info!(
                            job_id = %issue.job_id,
                            certificate_id = %issue.certificate_id,
                            generation = issue.generation,
                            challenge = %issue.challenge_type,
                            "ACME issuance job received on v2"
                        );
                        if let Err(error) = acme.handle_issue(issue).await {
                            warn!(
                                phase = error.phase.as_str(),
                                "ACME job rejected: {}", error.message
                            );
                        }
                    }
                    Command::AcmeDnsAck(ack) => {
                        acme.handle_dns_ack(DnsAck {
                            job_id: ack.job_id,
                            fqdn: ack.fqdn,
                            txt_value: ack.txt_value,
                            accepted: ack.accepted,
                            error: ack.error,
                        })
                        .await;
                    }
                    Command::Pty(frame) => {
                        handle_pty_frame(frame, &mut pty_manager, core.outbound.as_ref());
                    }
                }
            }
            event = pty_events.recv() => {
                if let Some(event) = event {
                    handle_pty_event(event, &mut pty_manager, core.outbound.as_ref());
                }
            }
            _ = pty_tick.tick() => {
                for exit in pty_manager.reap_expired(std::time::Instant::now()) {
                    crate::send_pty_exit(core.outbound.as_ref(), exit);
                }
            }
            online = core.online.changed() => {
                if online.is_err() {
                    break;
                }
                if !*core.online.borrow() {
                    for exit in pty_manager.close_all(
                        crate::pty::PtyExitReason::AgentDisconnected,
                    ) {
                        crate::send_pty_exit(core.outbound.as_ref(), exit);
                    }
                }
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
            _ = runtime_tick.tick() => {
                if let Some(native) = native.as_ref() {
                    native.refresh_observation().await;
                }
            }
        }
        publish(
            &core.status,
            &mut published,
            snapshot(
                &config,
                manager.as_ref(),
                native.as_ref().and_then(NativeRuntime::active_state),
                &status,
                sing_box_version.as_deref(),
                &updates,
            ),
        );
        publish_log_acks(
            &core.log_acks,
            &mut published_log,
            &log_policy,
            &log_policy_errors,
        );
    }

    cancel.cancel();
    let _ = link_task.await;
    let _ = traffic_task.await;
    for exit in pty_manager.close_all(crate::pty::PtyExitReason::AgentDisconnected) {
        crate::send_pty_exit(core.outbound.as_ref(), exit);
    }
    acme.shutdown().await;
    if let Some(manager) = manager {
        manager.shutdown().await;
    }
    info!("agent stopped (websocket protocol v2)");
    Ok(())
}

/// A positive disablement: stop the serving process, atomically replace the
/// active and last-known-good configs with a local no-inbound teardown, and
/// launch that teardown. The persisted disabled flag prevents startup from
/// serving the old inbound after a crash or restart. Only a later enabled
/// authoritative configuration can clear it.
async fn apply_administrative_disable(
    config: &mut ConfigManager,
    manager: &mut Option<SingBoxManager>,
    bin: &Path,
    native: Option<&NativeRuntime>,
) {
    if config.administratively_disabled() {
        if let Some(native) = native
            && let Err(error) = native.disable().await
        {
            error!("failed to repeat native disable intent: {error}");
        }
        return;
    }
    let candidate = match config.apply_administrative_teardown() {
        Ok(candidate) => candidate,
        Err(error) => {
            error!("failed to persist the administrative teardown: {error:#}");
            return;
        }
    };
    // Persist the teardown before stopping the process that still serves the
    // previous memory configuration. A failed write therefore leaves the proxy
    // untouched and the signal can safely be retried by the next link.
    if let Some(native) = native {
        if let Err(error) = native.disable().await {
            error!("failed to record native disable intent: {error}");
            return;
        }
        info!(
            revision = %candidate.revision,
            "control plane disabled this server; durable native disable intent applied"
        );
        return;
    }
    if let Some(current) = manager.take() {
        current.shutdown().await;
    }
    match SingBoxManager::start(bin.to_path_buf(), config.config_path().clone()).await {
        Ok(started) => {
            manager.replace(started);
            info!(
                revision = %candidate.revision,
                "control plane disabled this server; proxy inbound teardown applied"
            );
        }
        Err(error) => {
            warn!("administrative teardown persisted but sing-box did not start: {error}");
        }
    }
}

/// Applies the desired levels from one control-plane snapshot through the
/// existing local policy API. The core loop owns this work, so it is serialized
/// with configuration reconciliation and sing-box probation.
async fn apply_log_policy_job(
    policy: &LogPolicy,
    config: &mut ConfigManager,
    manager: &mut Option<SingBoxManager>,
    bin: &Path,
    probation: Duration,
    job: LogPolicyJob,
    errors: &mut BTreeMap<PolicySource, String>,
) {
    for desired in job.sources {
        let source: PolicySource = desired.source.into();
        let mut request = PolicyRequest::new(source, desired.revision, desired.level.into());
        request.baseline = desired.baseline.into();
        request.deadline = desired.deadline;
        match policy.request_snapshot(request, Utc::now()) {
            Ok(decision) => {
                errors.remove(&source);
                let Some(action) = decision.action else {
                    continue;
                };
                match action {
                    PolicyAction::Agent(level) => {
                        policy.apply_agent(level, Utc::now());
                    }
                    PolicyAction::SingBox(overlay) => {
                        if !config.has_active_config() {
                            // The request stays pending and the maintenance
                            // tick retries once a validated config exists.
                            continue;
                        }
                        let result = crate::apply_singbox_log_overlay(
                            config, manager, bin, overlay, probation,
                        )
                        .await;
                        policy.record(PolicySource::SingBox, overlay.effective, result, Utc::now());
                    }
                }
            }
            Err(error) => {
                errors.insert(
                    source,
                    error.to_string().chars().take(512).collect::<String>(),
                );
            }
        }
    }
}

/// The status the core publishes to the session for both sources. Errors are
/// bounded and never include log lines or configuration bodies.
fn log_policy_acks(
    policy: &LogPolicy,
    errors: &BTreeMap<PolicySource, String>,
) -> Vec<LogPolicyAck> {
    let now = Utc::now();
    SOURCES
        .iter()
        .map(|source| {
            let status = policy.status(*source, now);
            LogPolicyAck {
                source: (*source).into(),
                source_revision: status.revision,
                requested: status.requested.into(),
                baseline: status.baseline.into(),
                effective: status.effective.into(),
                deadline: status.deadline,
                error: errors.get(source).cloned().or(status.error),
                pending: status.pending || errors.contains_key(source),
            }
        })
        .collect()
}

fn publish_log_acks(
    sender: &watch::Sender<Vec<LogPolicyAck>>,
    last: &mut Option<Vec<LogPolicyAck>>,
    policy: &LogPolicy,
    errors: &BTreeMap<PolicySource, String>,
) {
    let next = log_policy_acks(policy, errors);
    if last.as_ref() == Some(&next) {
        return;
    }
    sender.send_replace(next.clone());
    *last = Some(next);
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
    native: Option<&NativeRuntime>,
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
            match apply_fetched(config, manager, bin, status, fetched, probation, native).await {
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
    native_active: Option<ActiveState>,
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
                .served_revision()
                .and_then(ConfigIdentifier::from_revision)
        },
        runtime_state: runtime
            .map(runtime_state_of)
            .or_else(|| native_active.map(native_runtime_state_of))
            .unwrap_or(RuntimeState::Stopped),
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

fn native_runtime_state_of(state: ActiveState) -> RuntimeState {
    match state {
        ActiveState::Active | ActiveState::Reloading | ActiveState::Refreshing => {
            RuntimeState::Running
        }
        ActiveState::Activating => RuntimeState::Starting,
        ActiveState::Inactive | ActiveState::Deactivating => RuntimeState::Stopped,
        ActiveState::Failed | ActiveState::Maintenance => RuntimeState::CrashLoop,
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
    use super::{V2_CAPABILITIES, bounded, config_state_of, stage_of, v2_capabilities};
    use crate::ws::v2::codec::{
        AckStage, ConfigState, LOGS_SEARCH_CAPABILITY, LOGS_TAIL_CAPABILITY,
    };

    #[test]
    fn v2_advertises_only_what_the_v2_peer_serves() {
        for withheld in ["pty-v1", "telemetry-v1", "ws-v1"] {
            assert!(
                !V2_CAPABILITIES.contains(&withheld),
                "{withheld} must not be advertised on v2"
            );
        }
        assert!(V2_CAPABILITIES.contains(&"ws-v2"));
        assert!(V2_CAPABILITIES.contains(&"acme-v1"));
        assert!(!v2_capabilities(false).contains(&"pty-v2".to_string()));
        assert!(v2_capabilities(true).contains(&"pty-v2".to_string()));
        assert!(V2_CAPABILITIES.contains(&"log-policy-v1"));
        for served in [LOGS_TAIL_CAPABILITY, LOGS_SEARCH_CAPABILITY] {
            assert!(
                V2_CAPABILITIES.contains(&served),
                "{served} must be advertised"
            );
        }
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
