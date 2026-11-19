//! Network counter deltas for v2 telemetry.
//!
//! Rates come only from a stable interface set: the names in
//! `/proc/net/dev` (excluding loopback), read together on each sample. The
//! first observation, a counter reset, an interface-set change, a failed read
//! or a non-monotonic/oversized window produces a null reading and a fresh
//! baseline. The interface set is part of the scope key, so a change starts a
//! new series instead of joining incomparable values.

use std::time::Instant;

use sha2::{Digest as _, Sha256};

use crate::telemetry::LinuxRead;
use crate::ws::v2::codec::TelemetryNetwork;

/// Longest window the contract accepts; a longer one is treated as a
/// discontinuity.
const MAX_WINDOW_MS: u128 = 300_000;
/// Longest readable interface list carried in a scope key. A larger set is
/// represented by a stable digest so the contract's 256-character cap can
/// never be exceeded.
const MAX_INTERFACE_SUFFIX: usize = 180;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct InterfaceCounters {
    pub name: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Observation {
    pub interface_suffix: String,
    pub network: Option<TelemetryNetwork>,
}

#[derive(Debug)]
struct Baseline {
    at: Instant,
    counters: Vec<InterfaceCounters>,
}

#[derive(Debug, Default)]
pub(super) struct Tracker {
    names: Vec<String>,
    baseline: Option<Baseline>,
}

impl Tracker {
    /// Records one counter read and returns the interface identity and rate,
    /// if this read can be compared with a previous one.
    pub(super) fn observe(
        &mut self,
        counters: Option<Vec<InterfaceCounters>>,
        at: Instant,
    ) -> Observation {
        let Some(mut counters) = counters else {
            return self.unavailable();
        };
        counters.sort_unstable_by(|left, right| left.name.cmp(&right.name));
        counters.dedup_by(|left, right| left.name == right.name);
        let names: Vec<String> = counters
            .iter()
            .map(|counter| counter.name.clone())
            .collect();
        if names != self.names {
            self.names = names;
            self.baseline = Some(Baseline { at, counters });
            return self.unavailable();
        }
        let Some(previous) = self.baseline.take() else {
            self.baseline = Some(Baseline { at, counters });
            return self.unavailable();
        };
        let Some(elapsed) = at.checked_duration_since(previous.at) else {
            self.baseline = Some(Baseline { at, counters });
            return self.unavailable();
        };
        let window_ms = elapsed.as_millis();
        if window_ms == 0 || window_ms > MAX_WINDOW_MS {
            self.baseline = Some(Baseline { at, counters });
            return self.unavailable();
        }

        let mut tx = 0_u64;
        let mut rx = 0_u64;
        for current in &counters {
            let Some(previous) = previous
                .counters
                .iter()
                .find(|counter| counter.name == current.name)
            else {
                self.baseline = Some(Baseline { at, counters });
                return self.unavailable();
            };
            let Some(tx_delta) = current.tx_bytes.checked_sub(previous.tx_bytes) else {
                self.baseline = Some(Baseline { at, counters });
                return self.unavailable();
            };
            let Some(rx_delta) = current.rx_bytes.checked_sub(previous.rx_bytes) else {
                self.baseline = Some(Baseline { at, counters });
                return self.unavailable();
            };
            let Some(next_tx) = tx.checked_add(tx_delta) else {
                self.baseline = Some(Baseline { at, counters });
                return self.unavailable();
            };
            let Some(next_rx) = rx.checked_add(rx_delta) else {
                self.baseline = Some(Baseline { at, counters });
                return self.unavailable();
            };
            tx = next_tx;
            rx = next_rx;
        }

        let divisor = window_ms as f64;
        self.baseline = Some(Baseline { at, counters });
        Observation {
            interface_suffix: self.interface_suffix(),
            network: Some(TelemetryNetwork {
                tx_bytes_per_second: Some(tx as f64 * 1000.0 / divisor),
                rx_bytes_per_second: Some(rx as f64 * 1000.0 / divisor),
                window_ms: window_ms as u64,
            }),
        }
    }

    fn unavailable(&self) -> Observation {
        Observation {
            interface_suffix: self.interface_suffix(),
            network: None,
        }
    }

    fn interface_suffix(&self) -> String {
        if self.names.is_empty() {
            return "-".to_string();
        }
        let joined = self.names.join(",");
        if joined.len() <= MAX_INTERFACE_SUFFIX {
            return joined;
        }
        let digest = Sha256::digest(joined.as_bytes());
        format!("~{}", hex::encode(&digest[..8]))
    }
}

/// Reads and parses `/proc/net/dev`; `None` means the file could not be read,
/// which is different from a successful read with no usable interfaces.
pub(super) fn read_counters(linux: &impl LinuxRead) -> Option<Vec<InterfaceCounters>> {
    linux
        .text("/proc/net/dev")
        .map(|input| parse_counters(&input))
}

fn parse_counters(input: &str) -> Vec<InterfaceCounters> {
    let mut counters = Vec::new();
    for line in input.lines().skip(2) {
        let Some((name, fields)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() || name == "lo" || name.contains(',') || name.contains('|') {
            continue;
        }
        let mut fields = fields.split_whitespace();
        let Some(rx_bytes) = fields.next().and_then(|value| value.parse().ok()) else {
            continue;
        };
        let Some(tx_bytes) = fields.nth(7).and_then(|value| value.parse().ok()) else {
            continue;
        };
        counters.push(InterfaceCounters {
            name: name.to_string(),
            rx_bytes,
            tx_bytes,
        });
    }
    counters
}

/// Canonical measurement identity: environment, cgroup version and limits,
/// and the sorted interface set used for the rate deltas.
pub(super) fn scope_key(
    environment: &str,
    cgroup_version: Option<u8>,
    cpu_limit: Option<f64>,
    memory_limit: Option<u64>,
    interface_suffix: &str,
) -> String {
    let cgroup = cgroup_version
        .map(|version| format!("cg{version}"))
        .unwrap_or_else(|| "-".to_string());
    let cpu = cpu_limit
        .filter(|limit| limit.is_finite() && *limit > 0.0)
        .map(|limit| format!("cpu{limit}"))
        .unwrap_or_else(|| "-".to_string());
    let memory = memory_limit
        .map(|limit| format!("mem{limit}"))
        .unwrap_or_else(|| "-".to_string());
    let interfaces = if interface_suffix.is_empty() {
        "-"
    } else {
        interface_suffix
    };
    format!("{environment}|{cgroup}|{cpu}|{memory}|{interfaces}")
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::Duration;

    use super::*;
    use crate::telemetry::types::{Interface, Usage};

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

    fn counters(entries: &[(&str, u64, u64)]) -> Vec<InterfaceCounters> {
        entries
            .iter()
            .map(|(name, rx_bytes, tx_bytes)| InterfaceCounters {
                name: (*name).to_string(),
                rx_bytes: *rx_bytes,
                tx_bytes: *tx_bytes,
            })
            .collect()
    }

    #[test]
    fn parses_proc_net_dev_and_ignores_loopback() {
        let input = concat!(
            "Inter-|   Receive                                                |  Transmit\n",
            " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n",
            "    lo: 111 0 0 0 0 0 0 0 222 0 0 0 0 0 0 0\n",
            "  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n",
            " eth1: 3000 0 0 0 0 0 0 0 4000 0 0 0 0 0 0 0\n",
        );
        assert_eq!(
            parse_counters(input),
            counters(&[("eth0", 1000, 2000), ("eth1", 3000, 4000)])
        );
    }

    #[test]
    fn a_read_failure_keeps_the_last_interface_identity() {
        let linux = Fixture(HashMap::new());
        assert!(read_counters(&linux).is_none());
    }

    #[test]
    fn initial_observation_yields_no_rate_and_a_stable_identity() {
        let mut tracker = Tracker::default();
        let start = Instant::now();
        let first = tracker.observe(Some(counters(&[("eth0", 100, 200)])), start);
        assert_eq!(first.interface_suffix, "eth0");
        assert!(first.network.is_none());

        let second = tracker.observe(
            Some(counters(&[("eth0", 100 + 4096, 200 + 8192)])),
            start + Duration::from_secs(2),
        );
        assert_eq!(second.interface_suffix, "eth0");
        let rate = second.network.expect("a comparable window");
        assert_eq!(rate.rx_bytes_per_second, Some(2048.0));
        assert_eq!(rate.tx_bytes_per_second, Some(4096.0));
        assert_eq!(rate.window_ms, 2000);
    }

    #[test]
    fn a_counter_reset_is_null_then_a_new_baseline() {
        let mut tracker = Tracker::default();
        let start = Instant::now();
        tracker.observe(Some(counters(&[("eth0", 500, 700)])), start);
        let reset = tracker.observe(
            Some(counters(&[("eth0", 3, 4)])),
            start + Duration::from_secs(1),
        );
        assert!(reset.network.is_none());

        let after = tracker.observe(
            Some(counters(&[("eth0", 13, 24)])),
            start + Duration::from_secs(2),
        );
        let rate = after.network.expect("a new baseline");
        assert_eq!(rate.rx_bytes_per_second, Some(10.0));
        assert_eq!(rate.tx_bytes_per_second, Some(20.0));
    }

    #[test]
    fn an_interface_change_changes_the_scope_and_clears_the_rate() {
        let mut tracker = Tracker::default();
        let start = Instant::now();
        tracker.observe(Some(counters(&[("eth0", 10, 20), ("eth1", 30, 40)])), start);
        let changed = tracker.observe(
            Some(counters(&[("eth0", 110, 220), ("eth2", 30, 40)])),
            start + Duration::from_secs(1),
        );
        assert_eq!(changed.interface_suffix, "eth0,eth2");
        assert!(changed.network.is_none());
    }

    #[test]
    fn a_missing_read_returns_null_without_losing_the_identity() {
        let mut tracker = Tracker::default();
        let start = Instant::now();
        tracker.observe(Some(counters(&[("eth0", 10, 20)])), start);
        let missing = tracker.observe(None, start + Duration::from_secs(1));
        assert_eq!(missing.interface_suffix, "eth0");
        assert!(missing.network.is_none());
    }

    #[test]
    fn an_oversized_window_is_a_discontinuity() {
        let mut tracker = Tracker::default();
        let start = Instant::now();
        tracker.observe(Some(counters(&[("eth0", 10, 20)])), start);
        let late = tracker.observe(
            Some(counters(&[("eth0", 110, 220)])),
            start + Duration::from_secs(301),
        );
        assert!(late.network.is_none());
    }

    #[test]
    fn scope_key_matches_the_documented_encoding() {
        assert_eq!(
            scope_key("systemd", None, None, None, "eth0,eth1"),
            "systemd|-|-|-|eth0,eth1"
        );
        assert_eq!(
            scope_key("docker", Some(2), Some(2.0), Some(8_589_934_592), "eth0"),
            "docker|cg2|cpu2|mem8589934592|eth0"
        );
        assert_eq!(
            scope_key("systemd", None, None, None, "-"),
            "systemd|-|-|-|-"
        );
    }

    #[test]
    fn a_large_interface_set_is_hashed_into_a_bounded_scope_key() {
        let mut tracker = Tracker::default();
        let counters: Vec<InterfaceCounters> = (0..40)
            .map(|index| InterfaceCounters {
                name: format!("interface-{index:02}-abcdefghijkl"),
                rx_bytes: 0,
                tx_bytes: 0,
            })
            .collect();
        let observation = tracker.observe(Some(counters), Instant::now());
        assert!(observation.interface_suffix.starts_with('~'));
        assert!(observation.interface_suffix.len() <= 17);
        let key = scope_key("systemd", None, None, None, &observation.interface_suffix);
        assert!(key.len() <= 256, "{key}");
    }
}
