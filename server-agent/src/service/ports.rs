//! Consumer-owned runtime service port.
//!
//! The port names only installer-fixed service identities and typed
//! operations. Unit names, executable selection and filesystem paths stay
//! local to the adapter; the agent cannot address arbitrary services.

use std::fmt;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// A service managed by the lifecycle boundary. The set is fixed by the
/// installer; there is no way to address another unit through the port.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ServiceIdentity {
    /// The agent's own unit.
    Agent,
    /// The single managed sing-box runtime unit.
    SingBox,
}

impl ServiceIdentity {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::SingBox => "sing-box",
        }
    }

    /// Installer-owned systemd unit backing this identity on native Linux.
    pub(crate) fn systemd_unit(self) -> &'static str {
        match self {
            Self::Agent => "blossom-agent.service",
            Self::SingBox => "blossom-sing-box.service",
        }
    }
}

impl fmt::Display for ServiceIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Ordinary lifecycle operations. Adapters return only after the backend job
/// completes and re-read the service state; job completion alone does not
/// prove that a configuration or binary was applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ServiceOperation {
    Start,
    Stop,
    Reload,
    Restart,
}

impl fmt::Display for ServiceOperation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Reload => "reload",
            Self::Restart => "restart",
        })
    }
}

/// Identity of one service invocation. A new invocation is a new runtime
/// instance: in-memory counters and connection ids do not carry across it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum InvocationId {
    /// systemd `InvocationID` (also `$INVOCATION_ID` inside the unit).
    Systemd { id: SystemdInvocation },
    /// Supervisors without an invocation id (s6, processkit): boot id, PID and
    /// process start time in clock ticks since boot, verified together.
    Process {
        #[serde(rename = "bootId")]
        boot_id: BootId,
        pid: u32,
        #[serde(rename = "startTime")]
        start_time: u64,
    },
}

impl fmt::Display for InvocationId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Systemd { id } => write!(formatter, "systemd-{}", id.0),
            Self::Process {
                boot_id,
                pid,
                start_time,
            } => write!(formatter, "process-{}-{pid}-{start_time}", boot_id.0),
        }
    }
}

/// A validated systemd invocation id: 32 lowercase hex digits, not all zero.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub(crate) struct SystemdInvocation(String);

impl TryFrom<String> for SystemdInvocation {
    type Error = ServiceError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let valid = value.len() == 32
            && value
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
            && value.bytes().any(|byte| byte != b'0');
        if valid {
            Ok(Self(value))
        } else {
            Err(ServiceError::InvalidObservation("invocation id"))
        }
    }
}

impl From<SystemdInvocation> for String {
    fn from(value: SystemdInvocation) -> Self {
        value.0
    }
}

/// A validated kernel boot id (`/proc/sys/kernel/random/boot_id`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub(crate) struct BootId(String);

impl TryFrom<String> for BootId {
    type Error = ServiceError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let value = value.trim().to_ascii_lowercase();
        let hex = value.bytes().filter(u8::is_ascii_hexdigit).count();
        if hex == 32
            && value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        {
            Ok(Self(value))
        } else {
            Err(ServiceError::InvalidObservation("boot id"))
        }
    }
}

impl From<BootId> for String {
    fn from(value: BootId) -> Self {
        value.0
    }
}

/// Backend-neutral activity state, modelled on systemd `ActiveState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ActiveState {
    Active,
    Reloading,
    Inactive,
    Failed,
    Activating,
    Deactivating,
    Maintenance,
    Refreshing,
}

impl std::str::FromStr for ActiveState {
    type Err = ServiceError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "active" => Ok(Self::Active),
            "reloading" => Ok(Self::Reloading),
            "inactive" => Ok(Self::Inactive),
            "failed" => Ok(Self::Failed),
            "activating" => Ok(Self::Activating),
            "deactivating" => Ok(Self::Deactivating),
            "maintenance" => Ok(Self::Maintenance),
            "refreshing" => Ok(Self::Refreshing),
            _ => Err(ServiceError::InvalidObservation("active state")),
        }
    }
}

/// A fresh read of one service. `invocation` is absent while the service has
/// never run in this boot or the backend reports none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ServiceObservation {
    pub(crate) service: ServiceIdentity,
    pub(crate) active: ActiveState,
    pub(crate) invocation: Option<InvocationId>,
}

impl ServiceObservation {
    /// The invocation currently serving, if the service is up.
    pub(crate) fn serving_invocation(&self) -> Option<&InvocationId> {
        match self.active {
            ActiveState::Active | ActiveState::Reloading | ActiveState::Refreshing => {
                self.invocation.as_ref()
            }
            _ => None,
        }
    }
}

/// Local service backend: systemd over D-Bus on native Linux, a published
/// external supervisor or processkit elsewhere.
///
/// Implementations must re-read state after each job completes and after a
/// bus reconnect, and must reject identities the installer did not provision.
#[async_trait]
pub(crate) trait RuntimeService: Send + Sync {
    async fn inspect(&self, service: ServiceIdentity) -> Result<ServiceObservation, ServiceError>;

    async fn apply(
        &self,
        service: ServiceIdentity,
        operation: ServiceOperation,
    ) -> Result<ServiceObservation, ServiceError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ServiceError {
    /// The service manager or local control boundary is unreachable.
    Unavailable,
    /// The installer has not provisioned this service.
    NotInstalled(ServiceIdentity),
    /// The local authorization boundary refused the operation.
    Denied(ServiceIdentity, ServiceOperation),
    /// The backend job finished without success (systemd job `result`).
    JobFailed {
        service: ServiceIdentity,
        operation: ServiceOperation,
        result: String,
    },
    /// The backend returned a value outside the typed contract.
    InvalidObservation(&'static str),
}

impl fmt::Display for ServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable => formatter.write_str("service manager unavailable"),
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
        }
    }
}

impl std::error::Error for ServiceError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn systemd_invocation_ids_are_strict() {
        let valid = "0123456789abcdef0123456789abcdef".to_owned();
        assert!(SystemdInvocation::try_from(valid).is_ok());
        for invalid in [
            "",
            "0123456789ABCDEF0123456789ABCDEF",
            "0123456789abcdef",
            "00000000000000000000000000000000",
            "0123456789abcdef0123456789abcdeg",
        ] {
            assert_eq!(
                SystemdInvocation::try_from(invalid.to_owned()),
                Err(ServiceError::InvalidObservation("invocation id")),
                "{invalid}"
            );
        }
        let decoded: Result<InvocationId, _> =
            serde_json::from_str(r#"{"kind":"systemd","id":"not-hex"}"#);
        assert!(decoded.is_err());
    }

    #[test]
    fn process_invocations_round_trip_with_stable_wire_names() {
        let invocation = InvocationId::Process {
            boot_id: BootId::try_from("6F9C3A1E-0B4D-4C2A-9E77-1D2B3C4D5E6F\n".to_owned()).unwrap(),
            pid: 42,
            start_time: 9001,
        };
        let json = serde_json::to_value(&invocation).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "kind": "process",
                "bootId": "6f9c3a1e-0b4d-4c2a-9e77-1d2b3c4d5e6f",
                "pid": 42,
                "startTime": 9001,
            })
        );
        assert_eq!(
            serde_json::from_value::<InvocationId>(json).unwrap(),
            invocation
        );
    }

    #[test]
    fn only_up_states_report_a_serving_invocation() {
        let invocation = InvocationId::Systemd {
            id: SystemdInvocation::try_from("0123456789abcdef0123456789abcdef".to_owned()).unwrap(),
        };
        let observe = |active| ServiceObservation {
            service: ServiceIdentity::SingBox,
            active,
            invocation: Some(invocation.clone()),
        };
        assert!(observe(ActiveState::Active).serving_invocation().is_some());
        assert!(observe(ActiveState::Failed).serving_invocation().is_none());
        assert!(
            observe(ActiveState::Activating)
                .serving_invocation()
                .is_none()
        );
        assert_eq!("maintenance".parse(), Ok(ActiveState::Maintenance));
        assert_eq!(
            "unknown".parse::<ActiveState>(),
            Err(ServiceError::InvalidObservation("active state"))
        );
    }
}
