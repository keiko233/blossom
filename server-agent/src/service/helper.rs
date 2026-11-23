//! Privileged service-control helper and its fixed command-line entry points.
//!
//! The helper runs as root. It is the only writer of the deployment journal and
//! the protected release tree, and it owns the systemd adapter. The agent
//! connects to its local socket; the installer owns the unit files, the helper
//! executable, the socket path and the pinned release key.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context as _, Result};
use chrono::Utc;
use clap::{Args, Subcommand};
use tokio::net::UnixListener;

use super::boot::{self, BootDecision};
use super::control::{self, ControlHandler, ControlRequest, ControlResponse};
use super::journal::{ArtifactDigest, GenerationRecord};
use super::lifecycle::ServiceLifecycle;
use super::ports::{RuntimeService, ServiceIdentity};
use super::promote::{PromoteRequest, Promoter, ReleaseTrust, TrustedPromoter};
use super::store::JournalStore;
use super::systemd::SystemdAdapter;

#[derive(Debug, Args)]
pub(crate) struct ServiceControlArgs {
    #[command(subcommand)]
    command: ServiceControlCommand,
}

#[derive(Debug, Subcommand)]
enum ServiceControlCommand {
    /// Run the root-owned local control service.
    Serve(ServeArgs),
    /// Privileged `ExecStartPre=+` boot selector for one unit invocation.
    BootSelect(BootSelectArgs),
    /// Fixed launcher for the selected immutable artifacts.
    BootExec(BootExecArgs),
    /// Installs one committed generation from local installer-owned artifacts.
    Bootstrap(BootstrapArgs),
}

#[derive(Debug, Args)]
struct ServeArgs {
    #[arg(long)]
    socket: PathBuf,
    #[arg(long)]
    journal_dir: PathBuf,
    #[arg(long)]
    release_dir: PathBuf,
    #[arg(long)]
    agent_state_dir: PathBuf,
    #[arg(long)]
    trust_key: PathBuf,
    #[arg(long)]
    agent_uid: u32,
    #[arg(long)]
    runtime_gid: u32,
    #[arg(long)]
    socket_gid: u32,
}

#[derive(Debug, Args)]
struct BootSelectArgs {
    #[arg(long, value_enum)]
    service: ServiceArg,
    #[arg(long)]
    journal_dir: PathBuf,
    #[arg(long)]
    selection_dir: PathBuf,
    #[arg(long, env = "INVOCATION_ID")]
    invocation: String,
}

#[derive(Debug, Args)]
struct BootExecArgs {
    #[arg(long, value_enum)]
    service: ServiceArg,
    #[arg(long)]
    selection_dir: PathBuf,
    #[arg(long)]
    release_dir: PathBuf,
    #[arg(last = true)]
    args: Vec<String>,
}

#[derive(Debug, Args)]
struct BootstrapArgs {
    #[arg(long, value_enum)]
    service: ServiceArg,
    #[arg(long)]
    binary_source: PathBuf,
    #[arg(long)]
    config_source: PathBuf,
    #[arg(long)]
    journal_dir: PathBuf,
    #[arg(long)]
    release_dir: PathBuf,
    #[arg(long)]
    runtime_gid: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
enum ServiceArg {
    Agent,
    #[value(name = "sing-box")]
    SingBox,
}

impl From<ServiceArg> for ServiceIdentity {
    fn from(value: ServiceArg) -> Self {
        match value {
            ServiceArg::Agent => Self::Agent,
            ServiceArg::SingBox => Self::SingBox,
        }
    }
}

pub(crate) async fn run(args: ServiceControlArgs) -> Result<()> {
    match args.command {
        ServiceControlCommand::Serve(args) => serve(args).await,
        ServiceControlCommand::BootSelect(args) => run_boot_select(args),
        ServiceControlCommand::BootExec(args) => run_boot_exec(args),
        ServiceControlCommand::Bootstrap(args) => run_bootstrap(args),
    }
}

async fn serve(args: ServeArgs) -> Result<()> {
    require_root("serve")?;
    let trust = ReleaseTrust::load(&args.trust_key)?;
    let promoter = TrustedPromoter::new(
        Promoter::new(
            args.release_dir,
            args.journal_dir.clone(),
            args.agent_state_dir,
            args.agent_uid,
            args.runtime_gid,
        ),
        trust,
    );
    let handler = Arc::new(Helper::new(args.journal_dir, promoter));
    if let Some(parent) = args.socket.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("cannot create socket directory {}", parent.display()))?;
        std::fs::set_permissions(parent, std::os::unix::fs::PermissionsExt::from_mode(0o750))?;
    }
    let _ = std::fs::remove_file(&args.socket);
    let listener = UnixListener::bind(&args.socket)
        .with_context(|| format!("cannot bind control socket {}", args.socket.display()))?;
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&args.socket, std::fs::Permissions::from_mode(0o660))?;
        let path = std::ffi::CString::new(args.socket.as_os_str().as_encoded_bytes())?;
        // SAFETY: the path is a NUL-terminated absolute socket path owned by
        // the installer; failure is surfaced as an error.
        let result = unsafe { libc::chown(path.as_ptr(), u32::MAX, args.socket_gid) };
        if result != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    tracing::info!(
        socket = %args.socket.display(),
        "service-control helper listening"
    );
    control::serve(listener, args.agent_uid, handler).await?;
    Ok(())
}

fn run_boot_select(args: BootSelectArgs) -> Result<()> {
    require_root("boot-select")?;
    let service: ServiceIdentity = args.service.into();
    let invocation = boot::invocation_from_env(Some(&args.invocation))?;
    let store = JournalStore::new(&args.journal_dir, service);
    let decision =
        boot::select_and_write(&store, service, invocation, Utc::now(), &args.selection_dir)?;
    let status = decision.exit_code();
    match decision {
        BootDecision::Selected(selection) => {
            tracing::info!(
                service = %service,
                generation = selection.record.generation.0,
                "boot selector authorized one generation"
            );
            Ok(())
        }
        BootDecision::Disabled => {
            eprintln!("{service} is disabled by durable local intent");
            std::process::exit(status.unwrap_or(boot::BOOT_DISABLED_EXIT));
        }
        BootDecision::Unprovisioned => {
            eprintln!("{service} has no committed generation");
            std::process::exit(status.unwrap_or(boot::BOOT_UNPROVISIONED_EXIT));
        }
    }
}

fn run_boot_exec(args: BootExecArgs) -> Result<()> {
    let service: ServiceIdentity = args.service.into();
    let result = (|| -> Result<()> {
        let path = boot::selection_path(&args.selection_dir, service);
        let selection = boot::read_selection(&path)?;
        let layout = super::promote::ReleaseLayout::new(&args.release_dir);
        let launch = boot::resolve_launch(&layout, service, &selection)?;
        let mut command = boot::launch_command(service, &launch, &args.args);
        use std::os::unix::process::CommandExt as _;
        let error = command.exec();
        Err(anyhow::anyhow!(
            "cannot execute selected {} generation: {error}",
            service
        ))
    })();
    match result {
        Ok(()) => Ok(()),
        Err(error) => {
            eprintln!("cannot launch {service}: {error}");
            std::process::exit(boot::BOOT_INVALID_EXIT);
        }
    }
}

fn run_bootstrap(args: BootstrapArgs) -> Result<()> {
    require_root("bootstrap")?;
    let service: ServiceIdentity = args.service.into();
    let promoter = Promoter::new(
        args.release_dir.clone(),
        args.journal_dir.clone(),
        args.release_dir,
        0,
        args.runtime_gid,
    );
    let artifacts = promoter.bootstrap(service, &args.binary_source, &args.config_source)?;
    tracing::info!(
        service = %service,
        generation = artifacts.record.generation.0,
        "installer bootstrap committed the initial generation"
    );
    Ok(())
}

struct Helper {
    lifecycles: HashMap<ServiceIdentity, ServiceLifecycle>,
    promoter: TrustedPromoter,
    /// The helper is the journal's single writer, so connections are
    /// serialized even though every accepted socket gets its own task.
    operation: tokio::sync::Mutex<()>,
}

impl Helper {
    fn new(journal_dir: PathBuf, promoter: TrustedPromoter) -> Self {
        let port: Arc<dyn RuntimeService> = Arc::new(SystemdAdapter::new());
        let lifecycles = [ServiceIdentity::Agent, ServiceIdentity::SingBox]
            .into_iter()
            .map(|service| {
                (
                    service,
                    ServiceLifecycle::new(port.clone(), JournalStore::new(&journal_dir, service)),
                )
            })
            .collect();
        Self {
            lifecycles,
            promoter,
            operation: tokio::sync::Mutex::new(()),
        }
    }

    fn lifecycle(&self, service: ServiceIdentity) -> Option<&ServiceLifecycle> {
        self.lifecycles.get(&service)
    }

    async fn lifecycle_response(
        &self,
        service: ServiceIdentity,
        request: ControlRequest,
    ) -> ControlResponse {
        let Some(lifecycle) = self.lifecycle(service) else {
            return unknown_service();
        };
        control::LocalLifecycle::handle(lifecycle, request).await
    }
}

#[async_trait::async_trait]
impl ControlHandler for Helper {
    async fn handle(&self, request: ControlRequest) -> ControlResponse {
        let _guard = self.operation.lock().await;
        let Some(service) = request_service(&request) else {
            return unknown_service();
        };
        self.lifecycle_response(service, request).await
    }

    async fn promote(&self, service: ServiceIdentity, request: PromoteRequest) -> ControlResponse {
        let _guard = self.operation.lock().await;
        if self.lifecycle(service).is_none() {
            return unknown_service();
        }
        match self.promoter.promote(service, request) {
            Ok(artifacts) => ControlResponse::Artifacts { artifacts },
            Err(error) => ControlResponse::error(error),
        }
    }

    async fn stage_config(
        &self,
        service: ServiceIdentity,
        source: PathBuf,
        digest: ArtifactDigest,
    ) -> ControlResponse {
        let _guard = self.operation.lock().await;
        if service != ServiceIdentity::SingBox {
            return ControlResponse::error(control::ControlError::InvalidRequest(
                "only the sing-box runtime stages configuration artifacts".to_string(),
            ));
        }
        let Some(lifecycle) = self.lifecycle(service) else {
            return unknown_service();
        };
        let committed = match lifecycle.committed() {
            Ok(Some(committed)) => committed,
            Ok(None) => {
                return ControlResponse::error(control::ControlError::InvalidRequest(
                    "the service has no committed release to stage a config against".to_string(),
                ));
            }
            Err(error) => return ControlResponse::error(error),
        };
        match self.promoter.stage_config(source, digest) {
            Ok(config_digest) => {
                match lifecycle.next_generation_for(&committed.binary_sha256, &config_digest) {
                    Ok(generation) => ControlResponse::Record {
                        record: GenerationRecord {
                            generation,
                            binary_sha256: committed.binary_sha256,
                            config_sha256: config_digest,
                        },
                    },
                    Err(error) => ControlResponse::error(error),
                }
            }
            Err(error) => ControlResponse::error(error),
        }
    }

    async fn committed(&self, service: ServiceIdentity) -> ControlResponse {
        let _guard = self.operation.lock().await;
        let Some(lifecycle) = self.lifecycle(service) else {
            return unknown_service();
        };
        match lifecycle.committed() {
            Ok(committed) => ControlResponse::Committed { committed },
            Err(error) => ControlResponse::error(error),
        }
    }
}

fn require_root(operation: &str) -> Result<()> {
    if unsafe { libc::geteuid() } != 0 {
        anyhow::bail!("{operation} must run as root");
    }
    Ok(())
}

fn unknown_service() -> ControlResponse {
    ControlResponse::error(control::ControlError::InvalidRequest(
        "request names an unknown service".to_string(),
    ))
}

fn request_service(request: &ControlRequest) -> Option<ServiceIdentity> {
    match request {
        ControlRequest::Inspect { service }
        | ControlRequest::Apply { service, .. }
        | ControlRequest::TrialStart { service, .. }
        | ControlRequest::Commit { service, .. }
        | ControlRequest::Confirm { service, .. }
        | ControlRequest::Rollback { service }
        | ControlRequest::Revert { service }
        | ControlRequest::Disable { service }
        | ControlRequest::Enable { service }
        | ControlRequest::RuntimeInstance { service }
        | ControlRequest::Reconcile { service }
        | ControlRequest::Committed { service }
        | ControlRequest::Promote { service, .. }
        | ControlRequest::StageConfig { service, .. } => Some(*service),
    }
}
