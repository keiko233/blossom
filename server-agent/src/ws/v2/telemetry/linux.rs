//! Linux implementation of the v2 host sampler. It reuses the v1 procfs,
//! cgroup, disk and interface collector and adds the counter-derived network
//! observation.

use chrono::Utc;

use super::super::codec::{
    TelemetryEnvironment, TelemetryInterface, TelemetryListener, TelemetryProtocol,
    TelemetrySnapshot, TelemetryUsage,
};
use super::network::{self, Tracker};
use super::{HostSampler, Inspection, Measurement};
use crate::telemetry::{self, Linux};

#[derive(Default)]
pub(super) struct LinuxSampler {
    tracker: Tracker,
}

impl HostSampler for LinuxSampler {
    fn measure(&mut self) -> Measurement {
        let linux = Linux;
        let sample = telemetry::sample(&linux);
        let counters = network::read_counters(&linux);
        let observation = self.tracker.observe(counters, std::time::Instant::now());
        Measurement {
            sampled_at: Utc::now(),
            cpu_percent: sample.cpu_percent,
            memory: sample.memory.map(|usage| TelemetryUsage {
                used: usage.used,
                total: usage.total,
            }),
            disk: sample.disk.map(|usage| TelemetryUsage {
                used: usage.used,
                total: usage.total,
            }),
            environment: environment(sample.environment),
            cgroup_version: sample.cgroup_version,
            cpu_limit: sample.cpu_limit,
            memory_limit: sample.memory_limit,
            scope_key: network::scope_key(
                sample.environment,
                sample.cgroup_version,
                sample.cpu_limit,
                sample.memory_limit,
                &observation.interface_suffix,
            ),
            network: observation.network,
        }
    }

    fn inspect(&self) -> Inspection {
        let snapshot = telemetry::inspect(&Linux);
        Inspection {
            partial: snapshot.partial,
            listeners: snapshot
                .listeners
                .into_iter()
                .filter_map(|listener| {
                    let protocol = match listener.protocol {
                        "tcp" => TelemetryProtocol::Tcp,
                        "udp" => TelemetryProtocol::Udp,
                        _ => return None,
                    };
                    Some(TelemetryListener {
                        protocol,
                        address: listener.address,
                        port: listener.port,
                    })
                })
                .collect(),
            interfaces: snapshot
                .interfaces
                .into_iter()
                .map(|interface| TelemetryInterface {
                    name: interface.name,
                    address: interface.address,
                })
                .collect(),
        }
    }
}

fn environment(value: &str) -> TelemetryEnvironment {
    match value {
        "systemd" => TelemetryEnvironment::Systemd,
        "docker" => TelemetryEnvironment::Docker,
        "containerd" => TelemetryEnvironment::Containerd,
        "kubernetes" => TelemetryEnvironment::Kubernetes,
        "container" => TelemetryEnvironment::Container,
        _ => TelemetryEnvironment::Unknown,
    }
}

impl Inspection {
    pub(super) fn into_snapshot(self, request_id: String) -> TelemetrySnapshot {
        TelemetrySnapshot {
            request_id,
            partial: self.partial,
            listeners: self.listeners,
            interfaces: self.interfaces,
        }
    }
}
