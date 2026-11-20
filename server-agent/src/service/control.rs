//! Typed local control protocol between the unprivileged agent and the
//! privileged service-control helper.
//!
//! The helper owns the journal, the release store and the systemd adapter. It
//! listens on a root-owned Unix socket and accepts only installer-provisioned
//! service identities. Requests cannot name units, paths for lifecycle
//! operations, or shell commands.
//!
//! Promotion is the one operation that carries a source path. The helper
//! accepts it only below the agent state directory, only from the agent uid,
//! and only after verifying the signed release manifest and digest.

use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _};
use tokio::net::{UnixListener, UnixStream};
use tokio::time::timeout;

use super::journal::{ArtifactDigest, Generation, GenerationRecord, RuntimeInstance};
use super::lifecycle::{LifecycleError, ServiceLifecycle};
use super::ports::{
    RuntimeService, ServiceError, ServiceIdentity, ServiceObservation, ServiceOperation,
};
use super::promote::{PromoteError, PromoteRequest, PromotedArtifacts};
use super::store::StoreError;

/// Largest control frame. Promotion requests carry manifests and paths, never
/// artifact bodies; release bytes stay on disk in the fixed staging area.
pub(crate) const MAX_CONTROL_FRAME: usize = 64 * 1024;
const CONTROL_TIMEOUT: Duration = Duration::from_secs(120);

/// One typed local operation. Every variant names an installer-provisioned
/// service; none can address another systemd unit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub(crate) enum ControlRequest {
    Inspect {
        service: ServiceIdentity,
    },
    Apply {
        service: ServiceIdentity,
        operation: ServiceOperation,
    },
    TrialStart {
        service: ServiceIdentity,
        candidate: GenerationRecord,
        #[serde(rename = "probationSecs")]
        probation_secs: u64,
    },
    Commit {
        service: ServiceIdentity,
        generation: Generation,
    },
    Confirm {
        service: ServiceIdentity,
        generation: Generation,
    },
    Rollback {
        service: ServiceIdentity,
    },
    Revert {
        service: ServiceIdentity,
    },
    Disable {
        service: ServiceIdentity,
    },
    Enable {
        service: ServiceIdentity,
    },
    RuntimeInstance {
        service: ServiceIdentity,
    },
    Reconcile {
        service: ServiceIdentity,
    },
    Committed {
        service: ServiceIdentity,
    },
    Promote {
        service: ServiceIdentity,
        request: PromoteRequest,
    },
    StageConfig {
        service: ServiceIdentity,
        source: PathBuf,
        digest: ArtifactDigest,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "kebab-case")]
pub(crate) enum ControlResponse {
    Observation { observation: ServiceObservation },
    Instance { instance: Option<RuntimeInstance> },
    Committed { committed: Option<GenerationRecord> },
    Record { record: GenerationRecord },
    Artifacts { artifacts: PromotedArtifacts },
    Done,
    Error { error: ControlError },
}

impl ControlResponse {
    pub(crate) fn error(error: impl Into<ControlError>) -> Self {
        Self::Error {
            error: error.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum ControlError {
    Unavailable,
    NotInstalled(ServiceIdentity),
    Denied(ServiceIdentity, ServiceOperation),
    JobFailed {
        service: ServiceIdentity,
        operation: ServiceOperation,
        result: String,
    },
    InvalidObservation(String),
    InvalidRequest(String),
    Journal(String),
    Store(String),
    Lifecycle(String),
    Promotion(String),
    Protocol(String),
}

impl fmt::Display for ControlError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable => formatter.write_str("service control helper unavailable"),
            Self::NotInstalled(service) => write!(formatter, "service {service} is not installed"),
            Self::Denied(service, operation) => {
                write!(formatter, "{operation} on service {service} was denied")
            }
            Self::JobFailed {
                service,
                operation,
                result,
            } => write!(
                formatter,
                "{operation} on service {service} ended with {result}"
            ),
            Self::InvalidObservation(field) => write!(formatter, "invalid service {field}"),
            Self::InvalidRequest(message) => {
                write!(formatter, "invalid control request: {message}")
            }
            Self::Journal(message) => write!(formatter, "deployment journal error: {message}"),
            Self::Store(message) => write!(formatter, "deployment journal store error: {message}"),
            Self::Lifecycle(message) => write!(formatter, "service lifecycle error: {message}"),
            Self::Promotion(message) => write!(formatter, "release promotion error: {message}"),
            Self::Protocol(message) => write!(formatter, "control protocol error: {message}"),
        }
    }
}

impl std::error::Error for ControlError {}

impl From<ServiceError> for ControlError {
    fn from(error: ServiceError) -> Self {
        match error {
            ServiceError::Unavailable => Self::Unavailable,
            ServiceError::NotInstalled(service) => Self::NotInstalled(service),
            ServiceError::Denied(service, operation) => Self::Denied(service, operation),
            ServiceError::JobFailed {
                service,
                operation,
                result,
            } => Self::JobFailed {
                service,
                operation,
                result,
            },
            ServiceError::InvalidObservation(field) => Self::InvalidObservation(field.to_string()),
        }
    }
}

impl From<StoreError> for ControlError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::Invalid(error) => Self::Journal(error.to_string()),
            other => Self::Store(other.to_string()),
        }
    }
}

impl From<super::journal::JournalError> for ControlError {
    fn from(error: super::journal::JournalError) -> Self {
        Self::Journal(error.to_string())
    }
}

impl From<LifecycleError> for ControlError {
    fn from(error: LifecycleError) -> Self {
        Self::Lifecycle(error.to_string())
    }
}

impl From<PromoteError> for ControlError {
    fn from(error: PromoteError) -> Self {
        Self::Promotion(error.to_string())
    }
}

impl From<ControlError> for ServiceError {
    fn from(error: ControlError) -> Self {
        match error {
            ControlError::NotInstalled(service) => Self::NotInstalled(service),
            ControlError::Denied(service, operation) => Self::Denied(service, operation),
            ControlError::JobFailed {
                service,
                operation,
                result,
            } => Self::JobFailed {
                service,
                operation,
                result,
            },
            ControlError::InvalidObservation(_) => Self::InvalidObservation("observation"),
            _ => Self::Unavailable,
        }
    }
}

/// Agent-side client. Requests are serialized by the helper, which is the
/// journal's single writer.
#[derive(Debug, Clone)]
pub(crate) struct ControlClient {
    path: PathBuf,
    timeout: Duration,
}

impl ControlClient {
    #[must_use]
    pub(crate) fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            timeout: CONTROL_TIMEOUT,
        }
    }

    #[cfg(test)]
    fn with_timeout(path: impl Into<PathBuf>, timeout: Duration) -> Self {
        Self {
            path: path.into(),
            timeout,
        }
    }

    pub(crate) async fn request(
        &self,
        request: ControlRequest,
    ) -> Result<ControlResponse, ControlError> {
        let exchange = async {
            let mut stream = UnixStream::connect(&self.path)
                .await
                .map_err(|_| ControlError::Unavailable)?;
            write_frame(&mut stream, &request).await?;
            read_frame(&mut stream).await
        };
        timeout(self.timeout, exchange)
            .await
            .map_err(|_| ControlError::Unavailable)?
    }

    async fn expect(&self, request: ControlRequest) -> Result<ControlResponse, ControlError> {
        match self.request(request).await? {
            ControlResponse::Error { error } => Err(error),
            response => Ok(response),
        }
    }

    pub(crate) async fn trial_start(
        &self,
        service: ServiceIdentity,
        candidate: GenerationRecord,
        probation: Duration,
    ) -> Result<RuntimeInstance, ControlError> {
        let probation_secs = probation.as_secs();
        match self
            .expect(ControlRequest::TrialStart {
                service,
                candidate,
                probation_secs,
            })
            .await?
        {
            ControlResponse::Instance {
                instance: Some(instance),
            } => Ok(instance),
            ControlResponse::Instance { instance: None } => Err(ControlError::Lifecycle(
                "candidate did not become serving".to_string(),
            )),
            _ => Err(ControlError::Protocol(
                "unexpected trial response".to_string(),
            )),
        }
    }

    pub(crate) async fn commit(
        &self,
        service: ServiceIdentity,
        generation: Generation,
    ) -> Result<(), ControlError> {
        match self
            .expect(ControlRequest::Commit {
                service,
                generation,
            })
            .await?
        {
            ControlResponse::Done => Ok(()),
            _ => Err(ControlError::Protocol(
                "unexpected commit response".to_string(),
            )),
        }
    }

    pub(crate) async fn confirm(
        &self,
        service: ServiceIdentity,
        generation: Generation,
    ) -> Result<(), ControlError> {
        match self
            .expect(ControlRequest::Confirm {
                service,
                generation,
            })
            .await?
        {
            ControlResponse::Done => Ok(()),
            _ => Err(ControlError::Protocol(
                "unexpected confirm response".to_string(),
            )),
        }
    }

    pub(crate) async fn rollback(
        &self,
        service: ServiceIdentity,
    ) -> Result<RuntimeInstance, ControlError> {
        match self.expect(ControlRequest::Rollback { service }).await? {
            ControlResponse::Instance {
                instance: Some(instance),
            } => Ok(instance),
            _ => Err(ControlError::Lifecycle(
                "committed generation did not become serving".to_string(),
            )),
        }
    }

    #[allow(dead_code)] // exposed for installer/operator lifecycle clients
    pub(crate) async fn revert(
        &self,
        service: ServiceIdentity,
    ) -> Result<RuntimeInstance, ControlError> {
        match self.expect(ControlRequest::Revert { service }).await? {
            ControlResponse::Instance {
                instance: Some(instance),
            } => Ok(instance),
            _ => Err(ControlError::Lifecycle(
                "reverted generation did not become serving".to_string(),
            )),
        }
    }

    pub(crate) async fn disable(&self, service: ServiceIdentity) -> Result<(), ControlError> {
        match self.expect(ControlRequest::Disable { service }).await? {
            ControlResponse::Done => Ok(()),
            _ => Err(ControlError::Protocol(
                "unexpected disable response".to_string(),
            )),
        }
    }

    #[allow(dead_code)] // exposed for installer/operator lifecycle clients
    pub(crate) async fn enable(
        &self,
        service: ServiceIdentity,
    ) -> Result<RuntimeInstance, ControlError> {
        match self.expect(ControlRequest::Enable { service }).await? {
            ControlResponse::Instance {
                instance: Some(instance),
            } => Ok(instance),
            _ => Err(ControlError::Lifecycle(
                "enabled generation did not become serving".to_string(),
            )),
        }
    }

    pub(crate) async fn runtime_instance(
        &self,
        service: ServiceIdentity,
    ) -> Result<Option<RuntimeInstance>, ControlError> {
        match self
            .expect(ControlRequest::RuntimeInstance { service })
            .await?
        {
            ControlResponse::Instance { instance } => Ok(instance),
            _ => Err(ControlError::Protocol(
                "unexpected runtime instance response".to_string(),
            )),
        }
    }

    pub(crate) async fn reconcile(
        &self,
        service: ServiceIdentity,
    ) -> Result<Option<RuntimeInstance>, ControlError> {
        match self.expect(ControlRequest::Reconcile { service }).await? {
            ControlResponse::Instance { instance } => Ok(instance),
            _ => Err(ControlError::Protocol(
                "unexpected reconcile response".to_string(),
            )),
        }
    }

    pub(crate) async fn committed(
        &self,
        service: ServiceIdentity,
    ) -> Result<Option<GenerationRecord>, ControlError> {
        match self.expect(ControlRequest::Committed { service }).await? {
            ControlResponse::Committed { committed } => Ok(committed),
            _ => Err(ControlError::Protocol(
                "unexpected committed response".to_string(),
            )),
        }
    }

    #[allow(dead_code)] // exposed for installer/operator lifecycle clients
    pub(crate) async fn promote(
        &self,
        service: ServiceIdentity,
        request: PromoteRequest,
    ) -> Result<PromotedArtifacts, ControlError> {
        match self
            .expect(ControlRequest::Promote { service, request })
            .await?
        {
            ControlResponse::Artifacts { artifacts } => Ok(artifacts),
            _ => Err(ControlError::Protocol(
                "unexpected promotion response".to_string(),
            )),
        }
    }

    pub(crate) async fn stage_config(
        &self,
        service: ServiceIdentity,
        source: PathBuf,
        digest: ArtifactDigest,
    ) -> Result<GenerationRecord, ControlError> {
        match self
            .expect(ControlRequest::StageConfig {
                service,
                source,
                digest,
            })
            .await?
        {
            ControlResponse::Record { record } => Ok(record),
            _ => Err(ControlError::Protocol(
                "unexpected config stage response".to_string(),
            )),
        }
    }
}

#[async_trait]
impl RuntimeService for ControlClient {
    async fn inspect(&self, service: ServiceIdentity) -> Result<ServiceObservation, ServiceError> {
        match self
            .request(ControlRequest::Inspect { service })
            .await
            .map_err(ServiceError::from)?
        {
            ControlResponse::Observation { observation } => Ok(observation),
            ControlResponse::Error { error } => Err(error.into()),
            _ => Err(ServiceError::InvalidObservation("inspect response")),
        }
    }

    async fn apply(
        &self,
        service: ServiceIdentity,
        operation: ServiceOperation,
    ) -> Result<ServiceObservation, ServiceError> {
        match self
            .request(ControlRequest::Apply { service, operation })
            .await
            .map_err(ServiceError::from)?
        {
            ControlResponse::Observation { observation } => Ok(observation),
            ControlResponse::Error { error } => Err(error.into()),
            _ => Err(ServiceError::InvalidObservation("apply response")),
        }
    }
}

/// A request handler owned by the privileged helper.
#[async_trait]
pub(crate) trait ControlHandler: Send + Sync {
    async fn handle(&self, request: ControlRequest) -> ControlResponse;

    async fn promote(&self, service: ServiceIdentity, request: PromoteRequest) -> ControlResponse;

    async fn stage_config(
        &self,
        service: ServiceIdentity,
        source: PathBuf,
        digest: ArtifactDigest,
    ) -> ControlResponse;

    async fn committed(&self, service: ServiceIdentity) -> ControlResponse;
}

/// Serves typed requests on a root-owned Unix socket. The peer uid must match
/// the installer-provisioned agent uid; a different local identity is denied
/// before any request is decoded.
pub(crate) async fn serve(
    listener: UnixListener,
    allowed_uid: u32,
    handler: std::sync::Arc<dyn ControlHandler>,
) -> std::io::Result<()> {
    loop {
        let (stream, _) = listener.accept().await?;
        let handler = handler.clone();
        tokio::spawn(async move {
            if let Err(error) = serve_connection(stream, allowed_uid, handler).await {
                tracing::warn!("service-control connection ended: {error}");
            }
        });
    }
}

async fn serve_connection(
    mut stream: UnixStream,
    allowed_uid: u32,
    handler: std::sync::Arc<dyn ControlHandler>,
) -> std::io::Result<()> {
    let uid = stream
        .peer_cred()
        .map_err(|error| std::io::Error::other(error.to_string()))?
        .uid();
    if uid != allowed_uid {
        let error = ControlResponse::error(ControlError::InvalidRequest(
            "local caller is not the provisioned agent identity".to_string(),
        ));
        let _ = write_frame(&mut stream, &error).await;
        return Ok(());
    }
    loop {
        let request = match read_frame::<_, ControlRequest>(&mut stream).await {
            Ok(request) => request,
            Err(ControlError::Protocol(message)) if message == "control frame is empty" => {
                return Ok(());
            }
            Err(error) => {
                let _ = write_frame(&mut stream, &ControlResponse::error(error)).await;
                return Ok(());
            }
        };
        let response = match &request {
            ControlRequest::Promote { service, request } => {
                handler.promote(*service, request.clone()).await
            }
            ControlRequest::StageConfig {
                service,
                source,
                digest,
            } => {
                handler
                    .stage_config(*service, source.clone(), digest.clone())
                    .await
            }
            ControlRequest::Committed { service } => handler.committed(*service).await,
            _ => handler.handle(request).await,
        };
        write_frame(&mut stream, &response)
            .await
            .map_err(|error| std::io::Error::other(error.to_string()))?;
    }
}

/// The helper-side lifecycle facade used by the control handler.
pub(crate) struct LocalLifecycle;

impl LocalLifecycle {
    pub(crate) async fn handle(
        lifecycle: &ServiceLifecycle,
        request: ControlRequest,
    ) -> ControlResponse {
        let result = Self::dispatch(lifecycle, request).await;
        match result {
            Ok(response) => response,
            Err(error) => ControlResponse::error(error),
        }
    }

    async fn dispatch(
        lifecycle: &ServiceLifecycle,
        request: ControlRequest,
    ) -> Result<ControlResponse, ControlError> {
        let response = match request {
            ControlRequest::Inspect { service } => {
                ensure_service(service, lifecycle)?;
                ControlResponse::Observation {
                    observation: lifecycle.inspect().await?,
                }
            }
            ControlRequest::Apply { service, operation } => {
                ensure_service(service, lifecycle)?;
                ControlResponse::Observation {
                    observation: lifecycle.apply(operation).await?,
                }
            }
            ControlRequest::TrialStart {
                service,
                candidate,
                probation_secs,
            } => {
                ensure_service(service, lifecycle)?;
                let probation =
                    ChronoDuration::seconds(i64::try_from(probation_secs).map_err(|_| {
                        ControlError::InvalidRequest("probation is too long".to_string())
                    })?);
                ControlResponse::Instance {
                    instance: Some(lifecycle.begin_trial(candidate, probation).await?),
                }
            }
            ControlRequest::Commit {
                service,
                generation,
            } => {
                ensure_service(service, lifecycle)?;
                lifecycle.commit(generation, Utc::now()).await?;
                ControlResponse::Done
            }
            ControlRequest::Confirm {
                service,
                generation,
            } => {
                ensure_service(service, lifecycle)?;
                lifecycle.confirm(generation)?;
                ControlResponse::Done
            }
            ControlRequest::Rollback { service } => {
                ensure_service(service, lifecycle)?;
                ControlResponse::Instance {
                    instance: Some(lifecycle.rollback().await?),
                }
            }
            ControlRequest::Revert { service } => {
                ensure_service(service, lifecycle)?;
                ControlResponse::Instance {
                    instance: Some(lifecycle.revert_unconfirmed().await?),
                }
            }
            ControlRequest::Disable { service } => {
                ensure_service(service, lifecycle)?;
                lifecycle.disable().await?;
                ControlResponse::Done
            }
            ControlRequest::Enable { service } => {
                ensure_service(service, lifecycle)?;
                ControlResponse::Instance {
                    instance: Some(lifecycle.enable().await?),
                }
            }
            ControlRequest::RuntimeInstance { service } => {
                ensure_service(service, lifecycle)?;
                ControlResponse::Instance {
                    instance: lifecycle.runtime_instance().await?,
                }
            }
            ControlRequest::Reconcile { service } => {
                ensure_service(service, lifecycle)?;
                ControlResponse::Instance {
                    instance: lifecycle.reconcile(Utc::now()).await?,
                }
            }
            ControlRequest::Promote { .. }
            | ControlRequest::StageConfig { .. }
            | ControlRequest::Committed { .. } => {
                return Err(ControlError::InvalidRequest(
                    "request is handled by the privileged helper".to_string(),
                ));
            }
        };
        Ok(response)
    }
}

fn ensure_service(
    service: ServiceIdentity,
    lifecycle: &ServiceLifecycle,
) -> Result<(), ControlError> {
    if service == lifecycle.service() {
        Ok(())
    } else {
        Err(ControlError::InvalidRequest(
            "request names another service".to_string(),
        ))
    }
}

async fn write_frame<W, T>(writer: &mut W, value: &T) -> Result<(), ControlError>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let bytes = serde_json::to_vec(value)
        .map_err(|error| ControlError::Protocol(format!("cannot encode control frame: {error}")))?;
    if bytes.len() > MAX_CONTROL_FRAME {
        return Err(ControlError::InvalidRequest(
            "control frame exceeds the size limit".to_string(),
        ));
    }
    let length = u32::try_from(bytes.len())
        .map_err(|_| ControlError::InvalidRequest("control frame is too large".to_string()))?;
    writer
        .write_all(&length.to_be_bytes())
        .await
        .map_err(|error| ControlError::Protocol(format!("cannot write control frame: {error}")))?;
    writer
        .write_all(&bytes)
        .await
        .map_err(|error| ControlError::Protocol(format!("cannot write control frame: {error}")))?;
    writer
        .flush()
        .await
        .map_err(|error| ControlError::Protocol(format!("cannot flush control frame: {error}")))
}

async fn read_frame<R, T>(reader: &mut R) -> Result<T, ControlError>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut length = [0_u8; 4];
    match reader.read_exact(&mut length).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
            return Err(ControlError::Protocol("control frame is empty".to_string()));
        }
        Err(error) => {
            return Err(ControlError::Protocol(format!(
                "cannot read control frame: {error}"
            )));
        }
    }
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_CONTROL_FRAME {
        return Err(ControlError::InvalidRequest(
            "control frame length is outside the allowed bound".to_string(),
        ));
    }
    let mut bytes = vec![0_u8; length];
    reader
        .read_exact(&mut bytes)
        .await
        .map_err(|error| ControlError::Protocol(format!("cannot read control frame: {error}")))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| ControlError::Protocol(format!("cannot decode control frame: {error}")))
}

use serde::de::DeserializeOwned;

/// A test-only lifecycle facade over the in-memory fake systemd used by the
/// service module tests.
#[cfg(test)]
pub(crate) mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::service::journal::Generation;
    use crate::service::journal::fixtures::{active, invocation, record};
    use crate::service::journal::{DeploymentJournal, TrialPhase};
    use crate::service::store::test_dir;

    #[tokio::test]
    async fn control_frames_round_trip_and_reject_oversized_input() {
        let (mut client, mut server) = tokio::io::duplex(1024);
        let request = ControlRequest::Inspect {
            service: ServiceIdentity::SingBox,
        };
        write_frame(&mut client, &request).await.unwrap();
        assert_eq!(
            read_frame::<_, ControlRequest>(&mut server).await.unwrap(),
            request
        );

        write_frame(
            &mut client,
            &ControlRequest::Apply {
                service: ServiceIdentity::SingBox,
                operation: ServiceOperation::Restart,
            },
        )
        .await
        .unwrap();
        assert!(read_frame::<_, ControlRequest>(&mut server).await.is_ok());
    }

    #[tokio::test]
    async fn a_foreign_peer_is_denied_before_reading_a_request() {
        let dir = test_dir("control-peer");
        let path = dir.join("control.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let handler = Arc::new(TestHandler);
        let server = tokio::spawn(serve(listener, u32::MAX, handler));

        let mut stream = UnixStream::connect(&path).await.unwrap();
        write_frame(
            &mut stream,
            &ControlRequest::Inspect {
                service: ServiceIdentity::SingBox,
            },
        )
        .await
        .unwrap();
        let response: ControlResponse = read_frame(&mut stream).await.unwrap();
        assert!(matches!(
            response,
            ControlResponse::Error {
                error: ControlError::InvalidRequest(_)
            }
        ));
        server.abort();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn the_client_round_trips_every_typed_lifecycle_operation() {
        let dir = test_dir("control-client");
        let path = dir.join("control.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let handler = Arc::new(EchoHandler);
        let server = tokio::spawn(serve(listener, unsafe { libc::geteuid() }, handler));
        let client = ControlClient::with_timeout(&path, Duration::from_secs(5));
        let service = ServiceIdentity::SingBox;
        let instance = RuntimeInstance {
            service,
            generation: Generation(2),
            invocation: invocation(9),
        };

        assert!(matches!(
            client.inspect(service).await.unwrap(),
            ServiceObservation { .. }
        ));
        assert!(matches!(
            client
                .apply(service, ServiceOperation::Restart)
                .await
                .unwrap(),
            ServiceObservation { .. }
        ));
        assert_eq!(
            client
                .trial_start(service, record(2), Duration::from_secs(30))
                .await
                .unwrap(),
            instance
        );
        client.commit(service, Generation(2)).await.unwrap();
        client.confirm(service, Generation(2)).await.unwrap();
        assert_eq!(client.rollback(service).await.unwrap(), instance.clone());
        assert_eq!(client.revert(service).await.unwrap(), instance.clone());
        client.disable(service).await.unwrap();
        assert_eq!(client.enable(service).await.unwrap(), instance.clone());
        assert_eq!(
            client.runtime_instance(service).await.unwrap(),
            Some(instance.clone())
        );
        assert_eq!(client.reconcile(service).await.unwrap(), Some(instance));
        assert_eq!(client.committed(service).await.unwrap(), None);
        assert_eq!(
            client
                .stage_config(
                    service,
                    PathBuf::from("/tmp/config"),
                    record(2).config_sha256
                )
                .await
                .unwrap(),
            record(2)
        );
        assert_eq!(
            client
                .promote(
                    service,
                    PromoteRequest {
                        manifest: signed_manifest(record(2).binary_sha256),
                        binary_source: PathBuf::from("/tmp/binary"),
                        config_source: PathBuf::from("/tmp/config"),
                    }
                )
                .await
                .unwrap(),
            artifacts(record(2))
        );
        server.abort();
        let _ = std::fs::remove_dir_all(dir);
    }

    fn signed_manifest(digest: ArtifactDigest) -> super::super::promote::SignedReleaseManifest {
        super::super::promote::SignedReleaseManifest {
            schema: 1,
            component: super::super::promote::ReleaseComponent::SingBox,
            platform: "linux-amd64".to_string(),
            version: "1.14.4".to_string(),
            sha256: digest,
            signature: super::super::promote::ReleaseSignature::try_from("00".repeat(64)).unwrap(),
        }
    }

    fn artifacts(record: GenerationRecord) -> PromotedArtifacts {
        PromotedArtifacts {
            record,
            binary_path: PathBuf::from("/tmp/binary"),
            config_path: PathBuf::from("/tmp/config"),
        }
    }

    struct EchoHandler;

    #[async_trait]
    impl ControlHandler for EchoHandler {
        async fn handle(&self, request: ControlRequest) -> ControlResponse {
            let instance = RuntimeInstance {
                service: ServiceIdentity::SingBox,
                generation: Generation(2),
                invocation: invocation(9),
            };
            match request {
                ControlRequest::Inspect { service } | ControlRequest::Apply { service, .. } => {
                    ControlResponse::Observation {
                        observation: active(service, &invocation(9)),
                    }
                }
                ControlRequest::TrialStart { .. }
                | ControlRequest::Rollback { .. }
                | ControlRequest::Revert { .. }
                | ControlRequest::Enable { .. } => ControlResponse::Instance {
                    instance: Some(instance),
                },
                ControlRequest::RuntimeInstance { .. } | ControlRequest::Reconcile { .. } => {
                    ControlResponse::Instance {
                        instance: Some(instance),
                    }
                }
                ControlRequest::Committed { .. } => ControlResponse::Committed { committed: None },
                ControlRequest::StageConfig { .. } => ControlResponse::Record { record: record(2) },
                ControlRequest::Promote { .. } => ControlResponse::Artifacts {
                    artifacts: artifacts(record(2)),
                },
                _ => ControlResponse::Done,
            }
        }

        async fn promote(
            &self,
            _service: ServiceIdentity,
            _request: PromoteRequest,
        ) -> ControlResponse {
            ControlResponse::Artifacts {
                artifacts: artifacts(record(2)),
            }
        }

        async fn stage_config(
            &self,
            _service: ServiceIdentity,
            _source: PathBuf,
            _digest: ArtifactDigest,
        ) -> ControlResponse {
            ControlResponse::Record { record: record(2) }
        }

        async fn committed(&self, _service: ServiceIdentity) -> ControlResponse {
            ControlResponse::Committed { committed: None }
        }
    }

    struct TestHandler;

    #[async_trait]
    impl ControlHandler for TestHandler {
        async fn handle(&self, _request: ControlRequest) -> ControlResponse {
            ControlResponse::Done
        }

        async fn promote(
            &self,
            _service: ServiceIdentity,
            _request: PromoteRequest,
        ) -> ControlResponse {
            ControlResponse::Done
        }

        async fn stage_config(
            &self,
            _service: ServiceIdentity,
            _source: PathBuf,
            _digest: ArtifactDigest,
        ) -> ControlResponse {
            ControlResponse::Done
        }

        async fn committed(&self, _service: ServiceIdentity) -> ControlResponse {
            ControlResponse::Committed { committed: None }
        }
    }

    #[allow(dead_code)]
    fn assert_journal_types() {
        let journal = DeploymentJournal::new(ServiceIdentity::SingBox);
        let _ = (
            journal.trial(),
            TrialPhase::Authorized,
            active,
            invocation,
            record(1),
        );
    }
}
