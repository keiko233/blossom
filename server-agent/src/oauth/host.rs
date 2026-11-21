//! Best-effort host metadata attached to an enrollment redemption.
//!
//! Every field is optional on the control plane, so nothing here can fail an
//! enrollment. Values are bounded and sanitized before they leave the process:
//! a hostname is one trimmed line of at most 253 characters, addresses are
//! non-loopback unicast interface addresses, and only the fixed install modes
//! are reported. No command runs and no interface is probed.

use std::net::IpAddr;
use std::path::Path;

use serde::Serialize;

/// How the agent was installed. Reported to the control plane on enrollment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum InstallMode {
    Docker,
    Host,
}

impl InstallMode {
    /// An explicit `--install-mode` wins; otherwise a container is inferred
    /// from `/.dockerenv` and every other host is treated as a native install.
    fn resolve(configured: Option<Self>) -> Self {
        configured.unwrap_or_else(|| {
            if Path::new("/.dockerenv").exists() {
                Self::Docker
            } else {
                Self::Host
            }
        })
    }
}

/// The optional `hostInfo` object in `POST .../enrollment/redeem`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    hostname: Option<String>,
    ips: Vec<String>,
    os: &'static str,
    arch: &'static str,
    agent_version: &'static str,
    install_mode: InstallMode,
}

impl HostInfo {
    /// Collects the metadata. Detection is infallible and best-effort.
    pub(crate) fn detect(configured: Option<InstallMode>) -> Self {
        Self {
            hostname: detected_hostname(),
            ips: reportable_ips(interface_ips()),
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            agent_version: env!("CARGO_PKG_VERSION"),
            install_mode: InstallMode::resolve(configured),
        }
    }
}

fn detected_hostname() -> Option<String> {
    let file = std::fs::read_to_string("/etc/hostname").ok();
    if let Some(raw) = file.as_deref() {
        return bounded_hostname(Some(raw));
    }
    let env = std::env::var("HOSTNAME").ok();
    bounded_hostname(env.as_deref())
}

/// The control plane caps the hostname at 253 characters and rejects padding.
fn bounded_hostname(raw: Option<&str>) -> Option<String> {
    let line = raw?.lines().next()?.trim();
    if line.is_empty() {
        return None;
    }
    let bounded: String = line.chars().take(253).collect();
    (!bounded.is_empty()).then_some(bounded)
}

/// Keeps only non-loopback, non-link-local unicast addresses, sorted and
/// bounded so the payload can never exceed the contract's eight entries.
fn reportable_ips(mut ips: Vec<IpAddr>) -> Vec<String> {
    ips.retain(|ip| match ip {
        IpAddr::V4(ip) => {
            !ip.is_loopback() && !ip.is_unspecified() && !ip.is_link_local() && !ip.is_multicast()
        }
        IpAddr::V6(ip) => {
            let first = ip.segments()[0];
            !ip.is_loopback()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && (first & 0xffc0) != 0xfe80
        }
    });
    ips.sort_unstable();
    ips.dedup();
    ips.truncate(8);
    ips.into_iter().map(|ip| ip.to_string()).collect()
}

#[cfg(unix)]
fn interface_ips() -> Vec<IpAddr> {
    let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: `getifaddrs` writes a malloc-owned linked list into `head` and
    // reports failure through its return value. `head` starts null, so it is a
    // valid output slot.
    if unsafe { libc::getifaddrs(&mut head) } != 0 {
        return Vec::new();
    }
    let mut ips = Vec::new();
    let mut cursor = head;
    while !cursor.is_null() {
        // SAFETY: `cursor` is a node of the list allocated by `getifaddrs` and
        // remains valid until `freeifaddrs`, which runs once below.
        let entry = unsafe { &*cursor };
        if let Some(ip) = unsafe { ip_from_sockaddr(entry.ifa_addr) } {
            ips.push(ip);
        }
        cursor = entry.ifa_next;
    }
    // SAFETY: `head` is the list returned by `getifaddrs` above and is freed
    // exactly once here.
    unsafe { libc::freeifaddrs(head) };
    ips
}

#[cfg(not(unix))]
fn interface_ips() -> Vec<IpAddr> {
    Vec::new()
}

/// # Safety
///
/// `addr` must be null or point to a valid `sockaddr` whose family is
/// `AF_INET` or `AF_INET6` (other families and null are rejected).
#[cfg(unix)]
unsafe fn ip_from_sockaddr(addr: *const libc::sockaddr) -> Option<IpAddr> {
    if addr.is_null() {
        return None;
    }
    // SAFETY: the caller guarantees a valid `sockaddr`; only `sa_family` is
    // read before the family-specific cast.
    let family = unsafe { (*addr).sa_family } as i32;
    match family {
        libc::AF_INET => {
            // SAFETY: `AF_INET` means the allocation is a valid `sockaddr_in`.
            let addr = addr.cast::<libc::sockaddr_in>();
            // SAFETY: as above; `sin_addr` is inside that allocation.
            let v4 = unsafe { (*addr).sin_addr };
            // The field stores the address octets in memory order, so reading
            // it as bytes preserves them on both endiannesses.
            Some(IpAddr::V4(std::net::Ipv4Addr::from(
                v4.s_addr.to_ne_bytes(),
            )))
        }
        libc::AF_INET6 => {
            // SAFETY: `AF_INET6` means the allocation is a valid `sockaddr_in6`.
            let addr = addr.cast::<libc::sockaddr_in6>();
            // SAFETY: as above; `sin6_addr` is inside that allocation.
            let v6 = unsafe { (*addr).sin6_addr };
            Some(IpAddr::V6(std::net::Ipv6Addr::from(v6.s6_addr)))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_install_mode_wins_and_docker_is_the_container_default() {
        assert_eq!(
            InstallMode::resolve(Some(InstallMode::Host)),
            InstallMode::Host
        );
        assert_eq!(
            InstallMode::resolve(Some(InstallMode::Docker)),
            InstallMode::Docker
        );
        assert_eq!(
            InstallMode::resolve(None),
            if Path::new("/.dockerenv").exists() {
                InstallMode::Docker
            } else {
                InstallMode::Host
            }
        );
    }

    #[test]
    fn hostnames_are_single_line_and_bounded() {
        assert_eq!(bounded_hostname(None), None);
        assert_eq!(bounded_hostname(Some("\n")), None);
        assert_eq!(bounded_hostname(Some("  edge-1 \n")), Some("edge-1".into()));
        let long = "a".repeat(300);
        assert_eq!(bounded_hostname(Some(&long)), Some("a".repeat(253)));
    }

    #[test]
    fn only_reportable_addresses_are_sorted_bounded_and_serialized() {
        use std::net::Ipv4Addr;

        let ips = vec![
            "127.0.0.1".parse::<IpAddr>().unwrap(),
            "10.0.0.9".parse::<IpAddr>().unwrap(),
            "10.0.0.2".parse::<IpAddr>().unwrap(),
            "169.254.1.1".parse::<IpAddr>().unwrap(),
            "::1".parse::<IpAddr>().unwrap(),
            "fe80::1".parse::<IpAddr>().unwrap(),
            "fd00::9".parse::<IpAddr>().unwrap(),
            "10.0.0.2".parse::<IpAddr>().unwrap(),
        ];
        assert_eq!(
            reportable_ips(ips),
            vec!["10.0.0.2", "10.0.0.9", "fd00::9"]
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>()
        );

        let many: Vec<IpAddr> = (1..=20)
            .map(|octet| IpAddr::V4(Ipv4Addr::new(10, 0, 0, octet)))
            .collect();
        assert_eq!(reportable_ips(many).len(), 8);
        let reports = reportable_ips(interface_ips());
        assert!(reports.iter().all(|ip| {
            ip.parse::<IpAddr>()
                .is_ok_and(|ip| !ip.is_loopback() && !ip.is_unspecified())
        }));
    }

    #[test]
    fn host_info_serializes_with_the_contract_field_names() {
        let info = HostInfo::detect(Some(InstallMode::Docker));
        let payload = serde_json::to_value(&info).unwrap();
        assert_eq!(payload["os"], std::env::consts::OS);
        assert_eq!(payload["arch"], std::env::consts::ARCH);
        assert_eq!(payload["agentVersion"], env!("CARGO_PKG_VERSION"));
        assert_eq!(payload["installMode"], "docker");
        assert!(payload["ips"].is_array());
        assert!(payload.get("hostname").is_none() || payload["hostname"].is_string());
    }
}
