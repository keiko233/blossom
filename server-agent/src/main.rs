//! server-agent: runs sing-box on a proxy server host, driven by the blossom
//! control plane. It pulls the server's full multi-inbound sing-box config over
//! the `/api` surface, keeps sing-box running (restart on crash and verified
//! process replacement on config change), and heartbeats its version back to
//! the server.
//! A server owns one agent token and one running sing-box process; each "node"
//! on that server is compiled as one inbound inside that single config.
//!
//! This file is the composition root: it declares the modules, resolves the
//! CLI and startup inputs, installs logging, and dispatches to the legacy (v1)
//! runtime or the default protocol v2 core.

mod accountant;
mod acme;
mod agent_v2;
mod certificate;
mod cli;
mod client;
mod config;
mod legacy;
mod log_policy;
mod log_setup;
mod logs;
mod metering;
mod oauth;
mod probe;
mod process;
mod pty;
mod service;
mod stats;
#[cfg(target_os = "linux")]
mod telemetry;
mod traffic;
mod update;
mod ws;

use anyhow::Result;
use clap::Parser as _;

use crate::logs::SecretScope;

pub(crate) use cli::{Args, AuthMode, ServiceStartup, WsProtocol};
pub(crate) use legacy::{
    AgentStatus, NativeApply, ReportedError, apply_fetched, apply_singbox_log_overlay,
    apply_update_trigger, certificate_deployment, handle_pty_event, handle_pty_frame,
    log_policy_maintenance, new_acme_manager, new_pty_manager, new_update_manager,
    reconcile_updates, record_config_error, send_pty_exit, shutdown_signal, start_last_known_good,
    update_status_payload_from,
};

pub(crate) const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
pub(crate) const AGENT_BUILD_ID: &str = env!("AGENT_BUILD_ID");

#[tokio::main]
async fn main() -> Result<()> {
    let cli = cli::Cli::parse();
    if let Some(command) = cli.command {
        return match command {
            cli::Command::Enroll(enroll) => oauth::run_enroll(&enroll).await,
            cli::Command::ServiceControl(args) => service::run_control(args).await,
        };
    }
    let args = cli.service;
    let startup = args.startup()?;

    let _ = rustls::crypto::ring::default_provider().install_default();
    let (logs, log_policy) = log_setup::init(&args)?;
    let agent_secrets: Vec<&str> = startup
        .auth
        .static_token()
        .into_iter()
        .chain(args.github_token.as_deref())
        .collect();
    logs.replace_secrets(SecretScope::Agent, agent_secrets)?;
    if startup.protocol == WsProtocol::V2 {
        return agent_v2::run(&args, &startup, logs, log_policy).await;
    }
    legacy::run(args, startup, logs, log_policy).await
}
