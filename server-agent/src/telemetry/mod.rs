mod linux;
mod ports;
mod types;

use std::{
    net::{Ipv4Addr, Ipv6Addr},
    path::{Component, Path},
    time::Duration,
};

use serde_json::Value;
use tokio::time::Instant;

use crate::ws::codec::{AgentWsFrame, ReservedFrame};

use self::{
    linux::Linux,
    ports::LinuxRead,
    types::{Listener, Sample, Snapshot, Usage},
};

#[derive(Default)]
pub(crate) struct Collector {
    last_sample: Option<Instant>,
    last_inspection: Option<Instant>,
}

impl Collector {
    pub(crate) async fn reply(&mut self, frame: ReservedFrame) -> Option<AgentWsFrame> {
        let response = match frame.frame_type.as_str() {
            "telemetry.subscribe" if frame.payload["enabled"] == true => "telemetry.sample",
            "telemetry.inspect" => "telemetry.snapshot",
            _ => return None,
        };
        let id = frame.payload["requestId"].as_str()?.to_owned();
        if id.len() != 36
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        {
            return None;
        }
        let last_request = if response == "telemetry.sample" {
            &mut self.last_sample
        } else {
            &mut self.last_inspection
        };
        if last_request.is_some_and(|time| time.elapsed() < Duration::from_secs(1)) {
            return None;
        }
        *last_request = Some(Instant::now());
        let mut payload = tokio::task::spawn_blocking(move || {
            if response == "telemetry.sample" {
                serde_json::to_value(sample(&Linux))
            } else {
                serde_json::to_value(inspect(&Linux))
            }
        })
        .await
        .ok()?
        .ok()?;
        payload["requestId"] = Value::String(id);
        AgentWsFrame::new(response, payload).ok()
    }
}

fn cpu(input: &str) -> Option<(u64, u64)> {
    let mut fields = input.lines().next()?.split_whitespace();
    if fields.next()? != "cpu" {
        return None;
    }
    let mut total = 0_u64;
    let mut idle = 0_u64;
    for (index, field) in fields.take(8).enumerate() {
        let ticks: u64 = field.parse().ok()?;
        total = total.checked_add(ticks)?;
        if index == 3 || index == 4 {
            idle = idle.checked_add(ticks)?;
        }
    }
    Some((total, idle))
}

fn cpu_percent(before: (u64, u64), after: (u64, u64)) -> Option<f64> {
    let total = after.0.checked_sub(before.0)?;
    let idle = after.1.checked_sub(before.1)?;
    (total > 0 && idle <= total).then(|| 100.0 * (total - idle) as f64 / total as f64)
}

fn memory(input: &str) -> Option<Usage> {
    let kib = |key| {
        let mut fields = input
            .lines()
            .find_map(|line| line.strip_prefix(key))?
            .split_whitespace();
        let value: u64 = fields.next()?.parse().ok()?;
        (fields.next()? == "kB").then_some(())?;
        value.checked_mul(1024)
    };
    let total = kib("MemTotal:")?;
    let available = kib("MemAvailable:")?;
    Some(Usage {
        total,
        used: total.checked_sub(available)?,
    })
}

fn cgroup_limit<T: PartialOrd>(
    membership: &str,
    mountinfo: &str,
    controller: &str,
    read: impl Fn(&str, bool) -> Option<T>,
) -> Option<T> {
    let mut limit = None;
    for line in membership.lines().take(64) {
        let Some((_, rest)) = line.split_once(':') else {
            continue;
        };
        let Some((controllers, member)) = rest.split_once(':') else {
            continue;
        };
        let unified = controllers.is_empty();
        if !unified && !controllers.split(',').any(|value| value == controller) {
            continue;
        }
        for mount in mountinfo.lines().take(2048) {
            let Some((left, right)) = mount.split_once(" - ") else {
                continue;
            };
            let mut fields = right.split_whitespace();
            let fs = fields.next();
            let options = fields.nth(1).unwrap_or_default();
            if (unified && fs != Some("cgroup2"))
                || (!unified
                    && (fs != Some("cgroup")
                        || !options.split(',').any(|value| value == controller)))
            {
                continue;
            }
            let mut paths = left.split_whitespace().skip(3);
            let (Some(root), Some(target)) = (paths.next(), paths.next()) else {
                continue;
            };
            // Only inspect cgroup mounts below the standard cgroup filesystem.
            let target = Path::new(target);
            if !target.starts_with("/sys/fs/cgroup")
                || target
                    .components()
                    .any(|part| matches!(part, Component::ParentDir))
            {
                continue;
            }
            let Ok(relative) = Path::new(member).strip_prefix(root) else {
                // A cgroup namespace can expose its own root as /.
                if member == "/"
                    && let Some(value) = read(target.to_str()?, unified)
                    && limit.as_ref().is_none_or(|old| value < *old)
                {
                    limit = Some(value);
                }
                continue;
            };
            if relative
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
            {
                continue;
            }
            let directory = if relative.as_os_str().is_empty() {
                target.to_path_buf()
            } else {
                target.join(relative)
            };
            for path in directory.ancestors().take(64) {
                if !path.starts_with(target) {
                    break;
                }
                if let Some(value) = read(path.to_str()?, unified)
                    && limit.as_ref().is_none_or(|old| value < *old)
                {
                    limit = Some(value);
                }
            }
        }
    }
    limit
}

fn cpu_quota(quota: &str, period: &str) -> Option<f64> {
    let quota: u64 = quota.parse().ok()?;
    let period: u64 = period.parse().ok()?;
    (quota > 0 && period > 0).then_some(quota as f64 / period as f64)
}

fn sample(linux: &impl LinuxRead) -> Sample {
    let before = linux.text("/proc/stat").and_then(|input| cpu(&input));
    std::thread::sleep(Duration::from_millis(150));
    let after = linux.text("/proc/stat").and_then(|input| cpu(&input));
    let membership = linux.text("/proc/self/cgroup").unwrap_or_default();
    let mountinfo = linux.text("/proc/self/mountinfo").unwrap_or_default();
    let environment = if membership.contains("kubepods") {
        "kubernetes"
    } else if membership.contains("docker") || linux.exists("/.dockerenv") {
        "docker"
    } else if membership.contains("containerd") {
        "containerd"
    } else if linux.exists("/run/.containerenv") {
        "container"
    } else if linux.exists("/run/systemd/system") {
        "systemd"
    } else {
        "unknown"
    };
    let cgroup_version = if membership.lines().any(|line| line.starts_with("0::")) {
        Some(2)
    } else if membership.contains(':') {
        Some(1)
    } else {
        None
    };
    let cpu_limit = cgroup_limit(&membership, &mountinfo, "cpu", |path, unified| {
        if unified {
            let input = linux.text(&format!("{path}/cpu.max"))?;
            let mut fields = input.split_whitespace();
            cpu_quota(fields.next()?, fields.next()?)
        } else {
            let quota = linux.text(&format!("{path}/cpu.cfs_quota_us"))?;
            let period = linux.text(&format!("{path}/cpu.cfs_period_us"))?;
            cpu_quota(quota.trim(), period.trim())
        }
    });
    let memory_limit = cgroup_limit(&membership, &mountinfo, "memory", |path, unified| {
        let file = if unified {
            "memory.max"
        } else {
            "memory.limit_in_bytes"
        };
        let bytes: u64 = linux.text(&format!("{path}/{file}"))?.trim().parse().ok()?;
        (bytes < (1 << 60)).then_some(bytes)
    });
    Sample {
        cpu_percent: before.zip(after).and_then(|(a, b)| cpu_percent(a, b)),
        memory: linux.text("/proc/meminfo").and_then(|input| memory(&input)),
        disk: linux.disk(),
        environment,
        network_scope: "agent",
        cgroup_version,
        cpu_limit,
        memory_limit,
    }
}

fn listener(line: &str, protocol: &'static str, ipv6: bool) -> Option<Listener> {
    let mut fields = line.split_whitespace().skip(1);
    let (address, port) = fields.next()?.split_once(':')?;
    let remote = fields.next()?;
    let state = fields.next()?;
    match protocol {
        "tcp" if state == "0A" => {}
        "udp" if state == "07" && remote.bytes().all(|byte| byte == b'0' || byte == b':') => {}
        _ => return None,
    }
    let port = u16::from_str_radix(port, 16)
        .ok()
        .filter(|port| *port > 0)?;
    let bytes = hex::decode(address).ok()?;
    let address = if ipv6 {
        let mut bytes: [u8; 16] = bytes.try_into().ok()?;
        if cfg!(target_endian = "little") {
            for word in bytes.as_chunks_mut::<4>().0 {
                word.reverse();
            }
        }
        Ipv6Addr::from(bytes).to_string()
    } else {
        let mut bytes: [u8; 4] = bytes.try_into().ok()?;
        if cfg!(target_endian = "little") {
            bytes.reverse();
        }
        Ipv4Addr::from(bytes).to_string()
    };
    Some(Listener {
        protocol,
        address,
        port,
    })
}

fn inspect(linux: &impl LinuxRead) -> Snapshot {
    let mut listeners = Vec::new();
    let mut partial = false;
    for (path, protocol, ipv6) in [
        ("/proc/net/tcp", "tcp", false),
        ("/proc/net/tcp6", "tcp", true),
        ("/proc/net/udp", "udp", false),
        ("/proc/net/udp6", "udp", true),
    ] {
        if let Some(input) = linux.text(path) {
            listeners.extend(
                input
                    .lines()
                    .skip(1)
                    .filter_map(|line| listener(line, protocol, ipv6))
                    .take(129),
            );
        } else {
            partial = true;
        }
    }
    listeners.truncate(129);
    partial |= listeners.len() > 128;
    listeners.truncate(128);
    listeners.sort_unstable();
    listeners.dedup();
    let mut interfaces = linux.interfaces();
    partial |= interfaces.is_empty() || interfaces.len() > 128;
    interfaces.truncate(128);
    Snapshot {
        listeners,
        interfaces,
        partial,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::types::Interface;
    use super::*;

    struct Fixture(HashMap<&'static str, &'static str>);

    impl LinuxRead for Fixture {
        fn text(&self, path: &str) -> Option<String> {
            self.0.get(path).map(ToString::to_string)
        }

        fn exists(&self, path: &str) -> bool {
            self.0.contains_key(path)
        }

        fn disk(&self) -> Option<Usage> {
            None
        }

        fn interfaces(&self) -> Vec<Interface> {
            Vec::new()
        }
    }

    #[test]
    fn procfs_cpu_and_memory_fields() {
        let before = cpu("cpu  10 0 10 80 0 0 0 0 9 0");
        let after = cpu("cpu  12 0 10 85 3 0 0 0 10 0");
        assert_eq!(
            before.zip(after).and_then(|(a, b)| cpu_percent(a, b)),
            Some(20.0)
        );
        let usage = memory("MemTotal: 1024 kB\nMemFree: 16 kB\nMemAvailable: 512 kB\n")
            .expect("meminfo fixture");
        assert_eq!(usage.used, 512 * 1024);
        assert_eq!(usage.total, 1024 * 1024);
        assert!(memory("MemTotal: 1024 kB\n").is_none());
    }

    #[test]
    fn parses_ipv6_tcp_listeners_and_excludes_established_sockets() {
        let address = if cfg!(target_endian = "little") {
            "00000000000000000000000001000000"
        } else {
            "00000000000000000000000000000001"
        };
        let row = format!("0: {address}:01BB 00000000000000000000000000000000:0000");
        let socket = listener(&format!("{row} 0A"), "tcp", true).expect("listener");
        assert_eq!(socket.address, "::1");
        assert_eq!(socket.port, 443);
        assert!(listener(&format!("{row} 01"), "tcp", true).is_none());
    }

    #[test]
    fn cgroup_v2_resolves_membership_and_ancestor_limit() {
        let linux = Fixture(HashMap::from([
            ("/proc/self/cgroup", "0::/workload/agent"),
            (
                "/proc/self/mountinfo",
                "21 20 0:23 / /sys/fs/cgroup rw - cgroup2 cgroup rw",
            ),
            ("/sys/fs/cgroup/workload/agent/cpu.max", "max 100000"),
            ("/sys/fs/cgroup/workload/cpu.max", "150000 100000"),
            ("/sys/fs/cgroup/workload/memory.max", "67108864"),
        ]));
        let sample = sample(&linux);
        assert_eq!(sample.cgroup_version, Some(2));
        assert_eq!(sample.cpu_limit, Some(1.5));
        assert_eq!(sample.memory_limit, Some(67_108_864));
    }

    #[test]
    fn cgroup_v1_resolves_separate_controller_mounts() {
        let linux = Fixture(HashMap::from([
            (
                "/proc/self/cgroup",
                "3:cpu,cpuacct:/docker/example\n4:memory:/docker/example",
            ),
            (
                "/proc/self/mountinfo",
                concat!(
                    "21 20 0:23 /docker/example /sys/fs/cgroup/cpu rw - cgroup cgroup rw,cpu,cpuacct\n",
                    "22 20 0:24 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory",
                ),
            ),
            ("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "200000\n"),
            ("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "100000\n"),
            (
                "/sys/fs/cgroup/memory/docker/example/memory.limit_in_bytes",
                "9223372036854771712",
            ),
        ]));
        let sample = sample(&linux);
        assert_eq!(sample.environment, "docker");
        assert_eq!(sample.cgroup_version, Some(1));
        assert_eq!(sample.cpu_limit, Some(2.0));
        assert_eq!(sample.memory_limit, None);
    }
}
