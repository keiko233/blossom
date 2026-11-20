//! Native Linux systemd adapter for [`RuntimeService`].
//!
//! Calls are typed D-Bus operations against the host manager. Unit names come
//! only from [`ServiceIdentity`]. Every operation starts a systemd job, waits
//! for the matching `JobRemoved` signal with a bound, and then re-reads the
//! unit; a completed job alone does not prove the service is serving. If the
//! signal stream fails or the bus reconnects, the adapter re-reads rather than
//! trusting the earlier job result.

use std::fmt;
use std::time::Duration;

use futures_util::StreamExt as _;
use tokio::time::timeout;
use zbus::Connection;
use zbus::proxy;
use zbus::zvariant::OwnedObjectPath;

use super::ports::{
    ActiveState, InvocationId, RuntimeService, ServiceError, ServiceIdentity, ServiceObservation,
    ServiceOperation, SystemdInvocation,
};

/// systemd job completion is bounded so a wedged manager cannot hold the
/// helper's request loop forever.
const JOB_TIMEOUT: Duration = Duration::from_secs(90);

#[proxy(
    default_service = "org.freedesktop.systemd1",
    default_path = "/org/freedesktop/systemd1",
    interface = "org.freedesktop.systemd1.Manager"
)]
trait SystemdManager {
    fn get_unit(&self, name: &str) -> zbus::Result<OwnedObjectPath>;
    fn start_unit(&self, name: &str, mode: &str) -> zbus::Result<OwnedObjectPath>;
    fn stop_unit(&self, name: &str, mode: &str) -> zbus::Result<OwnedObjectPath>;
    fn restart_unit(&self, name: &str, mode: &str) -> zbus::Result<OwnedObjectPath>;
    fn reload_unit(&self, name: &str, mode: &str) -> zbus::Result<OwnedObjectPath>;

    #[zbus(signal)]
    fn job_removed(
        &self,
        id: u32,
        job: OwnedObjectPath,
        unit: String,
        result: String,
    ) -> zbus::Result<()>;
}

#[proxy(
    default_service = "org.freedesktop.systemd1",
    interface = "org.freedesktop.systemd1.Unit"
)]
trait SystemdUnit {
    #[zbus(property)]
    fn active_state(&self) -> zbus::Result<String>;

    #[zbus(property, name = "InvocationID")]
    fn invocation_id(&self) -> zbus::Result<String>;
}

/// Host systemd over the system bus. The helper constructs one adapter and
/// serializes requests, which is also the journal's single-writer boundary.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct SystemdAdapter;

impl SystemdAdapter {
    #[must_use]
    pub(crate) fn new() -> Self {
        Self
    }

    async fn inspect_with(
        &self,
        connection: &Connection,
        service: ServiceIdentity,
    ) -> Result<ServiceObservation, ServiceError> {
        let manager = SystemdManagerProxy::new(connection)
            .await
            .map_err(|error| map_bus_error(service, ServiceOperation::Start, error))?;
        let path = manager
            .get_unit(service.systemd_unit())
            .await
            .map_err(|error| map_bus_error(service, ServiceOperation::Start, error))?;
        let unit = SystemdUnitProxy::builder(connection)
            .path(path)
            .map_err(|_| ServiceError::Unavailable)?
            .build()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        let active = unit
            .active_state()
            .await
            .map_err(|error| map_bus_error(service, ServiceOperation::Start, error))?;
        let invocation = unit
            .invocation_id()
            .await
            .map_err(|error| map_bus_error(service, ServiceOperation::Start, error))?;
        observation(service, &active, &invocation)
    }

    async fn apply_with(
        &self,
        connection: &Connection,
        service: ServiceIdentity,
        operation: ServiceOperation,
    ) -> Result<ServiceObservation, ServiceError> {
        let manager = SystemdManagerProxy::new(connection)
            .await
            .map_err(|error| map_bus_error(service, operation, error))?;
        let mut removed = manager
            .receive_job_removed()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        let unit = service.systemd_unit();
        let job = match operation {
            ServiceOperation::Start => manager.start_unit(unit, "replace").await,
            ServiceOperation::Stop => manager.stop_unit(unit, "replace").await,
            ServiceOperation::Reload => manager.reload_unit(unit, "replace").await,
            ServiceOperation::Restart => manager.restart_unit(unit, "replace").await,
        }
        .map_err(|error| map_bus_error(service, operation, error))?;

        let result = timeout(JOB_TIMEOUT, async {
            while let Some(signal) = removed.next().await {
                let Ok(args) = signal.args() else {
                    return Err(JobFailure::Unavailable);
                };
                if args.job() == &job {
                    return Ok(args.result().to_string());
                }
            }
            Err(JobFailure::Unavailable)
        })
        .await;

        match result {
            Ok(Ok(result)) if result == "done" => {}
            Ok(Ok(result)) => {
                return Err(ServiceError::JobFailed {
                    service,
                    operation,
                    result,
                });
            }
            Ok(Err(JobFailure::Unavailable)) | Err(_) => {
                // A lost signal or a bus reconnect does not prove failure or
                // success. Re-read on a fresh connection and report the
                // observation; the caller decides from invocation state.
            }
        }

        let connection = Connection::system()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        self.inspect_with(&connection, service).await
    }
}

enum JobFailure {
    Unavailable,
}

#[async_trait::async_trait]
impl RuntimeService for SystemdAdapter {
    async fn inspect(&self, service: ServiceIdentity) -> Result<ServiceObservation, ServiceError> {
        let connection = Connection::system()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        self.inspect_with(&connection, service).await
    }

    async fn apply(
        &self,
        service: ServiceIdentity,
        operation: ServiceOperation,
    ) -> Result<ServiceObservation, ServiceError> {
        let connection = Connection::system()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        self.apply_with(&connection, service, operation).await
    }
}

fn observation(
    service: ServiceIdentity,
    active: &str,
    invocation_id: &str,
) -> Result<ServiceObservation, ServiceError> {
    let active = active
        .parse::<ActiveState>()
        .map_err(|_| ServiceError::InvalidObservation("active state"))?;
    let invocation = match invocation_id.trim() {
        "" => None,
        value => Some(InvocationId::Systemd {
            id: SystemdInvocation::try_from(value.to_ascii_lowercase())?,
        }),
    };
    Ok(ServiceObservation {
        service,
        active,
        invocation,
    })
}

fn map_bus_error(
    service: ServiceIdentity,
    operation: ServiceOperation,
    error: zbus::Error,
) -> ServiceError {
    match &error {
        zbus::Error::MethodError(name, _, _) => map_error_name(name.as_str(), service, operation),
        _ => ServiceError::Unavailable,
    }
}

fn map_error_name(
    name: &str,
    service: ServiceIdentity,
    operation: ServiceOperation,
) -> ServiceError {
    match name {
        "org.freedesktop.systemd1.NoSuchUnit" => ServiceError::NotInstalled(service),
        "org.freedesktop.DBus.Error.AccessDenied"
        | "org.freedesktop.DBus.Error.AuthFailed"
        | "org.freedesktop.DBus.Error.InteractiveAuthorizationRequired" => {
            ServiceError::Denied(service, operation)
        }
        _ => ServiceError::Unavailable,
    }
}

impl fmt::Display for JobFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("systemd job observation was lost")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observations_validate_active_state_and_invocation() {
        let valid = "0123456789abcdef0123456789abcdef";
        let observed = observation(ServiceIdentity::SingBox, "active", valid).unwrap();
        assert_eq!(observed.active, ActiveState::Active);
        assert_eq!(
            observed.serving_invocation(),
            Some(&InvocationId::Systemd {
                id: SystemdInvocation::try_from(valid.to_string()).unwrap()
            })
        );
        let observed = observation(ServiceIdentity::SingBox, "inactive", "").unwrap();
        assert_eq!(observed.active, ActiveState::Inactive);
        assert_eq!(observed.invocation, None);
        assert_eq!(
            observation(ServiceIdentity::SingBox, "unknown", "").unwrap_err(),
            ServiceError::InvalidObservation("active state")
        );
        assert_eq!(
            observation(ServiceIdentity::SingBox, "active", "not-hex").unwrap_err(),
            ServiceError::InvalidObservation("invocation id")
        );
    }

    #[test]
    fn bus_errors_map_to_the_typed_control_boundary() {
        assert_eq!(
            map_error_name(
                "org.freedesktop.systemd1.NoSuchUnit",
                ServiceIdentity::Agent,
                ServiceOperation::Restart,
            ),
            ServiceError::NotInstalled(ServiceIdentity::Agent)
        );
        assert_eq!(
            map_error_name(
                "org.freedesktop.DBus.Error.AccessDenied",
                ServiceIdentity::Agent,
                ServiceOperation::Stop,
            ),
            ServiceError::Denied(ServiceIdentity::Agent, ServiceOperation::Stop)
        );
        assert_eq!(
            map_error_name(
                "org.freedesktop.DBus.Error.NoReply",
                ServiceIdentity::Agent,
                ServiceOperation::Stop,
            ),
            ServiceError::Unavailable
        );
    }
}
