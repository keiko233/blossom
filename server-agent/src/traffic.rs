//! Collects per-user traffic deltas from sing-box and reports them upstream.

use std::collections::HashMap;

use anyhow::Result;
use tracing::{debug, error, info, warn};

use crate::client::types::{
    ReportAgentTrafficBody, ReportAgentTrafficBodyEntriesItem,
    ReportAgentTrafficBodyEntriesItemSubscriptionId,
};
use crate::stats::{Direction, Stat, StatsClient, parse_user_counter};

const MAX_ENTRIES_PER_REPORT: usize = 10_000;

pub struct TrafficReporter {
    addr: String,
    stats: StatsClient,
    pending: HashMap<String, (u64, u64)>,
    window_started_at: chrono::DateTime<chrono::Utc>,
}

impl TrafficReporter {
    pub fn new(addr: String) -> Result<Self> {
        let stats = StatsClient::connect_lazy(&addr)?;
        Ok(Self {
            addr,
            stats,
            pending: HashMap::new(),
            window_started_at: chrono::Utc::now(),
        })
    }

    /// Rebuild the lazy channel only if the address actually changed.
    pub fn update_addr(&mut self, addr: &str) -> Result<()> {
        if self.addr == addr {
            return Ok(());
        }
        self.stats = StatsClient::connect_lazy(addr)?;
        self.addr = addr.to_string();
        Ok(())
    }

    /// One cycle: QueryStats(reset=true) -> merge -> POST -> clear on success.
    /// Every failure path logs (warn!/error!) and returns; never panics/crashes.
    pub async fn collect_and_report(&mut self, client: &crate::client::Client) {
        let stats = match self
            .stats
            .query_stats(vec!["user>>>".to_string()], true)
            .await
        {
            Ok(stats) => stats,
            Err(e) => {
                warn!("traffic stats query failed: {e}");
                return;
            }
        };

        merge_stats(&mut self.pending, &stats);

        if self.pending.is_empty() {
            self.window_started_at = chrono::Utc::now();
            debug!("no traffic deltas; advancing window");
            return;
        }

        let entries = drain_entries(&mut self.pending, MAX_ENTRIES_PER_REPORT);
        if entries.is_empty() {
            self.window_started_at = chrono::Utc::now();
            debug!("no traffic deltas; advancing window");
            return;
        }
        let window_ended_at = chrono::Utc::now();

        let body = ReportAgentTrafficBody {
            entries,
            window_ended_at: Some(window_ended_at),
            window_started_at: Some(self.window_started_at),
        };

        match client.report_agent_traffic(&body).await {
            Ok(response) => {
                let result = response.into_inner();
                info!(
                    "traffic report accepted {} dropped {}",
                    result.accepted, result.dropped
                );
                self.window_started_at = window_ended_at;
            }
            Err(e) => {
                error!("traffic report failed: {e}");
                re_merge_entries(&mut self.pending, &body.entries);
            }
        }
    }
}

fn merge_stats(pending: &mut HashMap<String, (u64, u64)>, stats: &[Stat]) {
    for stat in stats {
        let Some((sub, direction)) = parse_user_counter(&stat.name) else {
            continue;
        };
        if sub.is_empty() {
            continue;
        }
        let delta = if stat.value < 0 { 0 } else { stat.value as u64 };
        if delta == 0 {
            continue;
        }
        let entry = pending.entry(sub.to_string()).or_insert((0, 0));
        match direction {
            Direction::Uplink => entry.0 = entry.0.saturating_add(delta),
            Direction::Downlink => entry.1 = entry.1.saturating_add(delta),
        }
    }
}

fn drain_entries(
    pending: &mut HashMap<String, (u64, u64)>,
    max: usize,
) -> Vec<ReportAgentTrafficBodyEntriesItem> {
    let mut out = Vec::with_capacity(max.min(pending.len()));
    let keys: Vec<String> = pending.keys().cloned().collect();

    for key in keys {
        if out.len() >= max {
            break;
        }
        let Some((uplink, downlink)) = pending.remove(&key) else {
            continue;
        };
        if uplink == 0 && downlink == 0 {
            continue;
        }
        let Ok(subscription_id) = key.parse::<ReportAgentTrafficBodyEntriesItemSubscriptionId>()
        else {
            continue;
        };
        out.push(ReportAgentTrafficBodyEntriesItem {
            downlink_bytes: clamp_i64(downlink),
            subscription_id,
            uplink_bytes: clamp_i64(uplink),
        });
    }

    out
}

fn re_merge_entries(
    pending: &mut HashMap<String, (u64, u64)>,
    entries: &[ReportAgentTrafficBodyEntriesItem],
) {
    for entry in entries {
        let sub: &str = &entry.subscription_id;
        let e = pending.entry(sub.to_string()).or_insert((0, 0));
        e.0 = e.0.saturating_add(entry.uplink_bytes.max(0) as u64);
        e.1 = e.1.saturating_add(entry.downlink_bytes.max(0) as u64);
    }
}

fn clamp_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{
        ReportAgentTrafficBodyEntriesItem, clamp_i64, drain_entries, merge_stats, re_merge_entries,
    };
    use crate::stats::{Direction, Stat, parse_user_counter};

    fn stat(name: &str, value: i64) -> Stat {
        Stat {
            name: name.to_string(),
            value,
        }
    }

    #[test]
    fn merge_accumulates_across_two_merges() {
        let mut pending = HashMap::new();
        merge_stats(
            &mut pending,
            &[
                stat("user>>>a>>>traffic>>>uplink", 100),
                stat("user>>>a>>>traffic>>>downlink", 200),
            ],
        );
        merge_stats(
            &mut pending,
            &[
                stat("user>>>a>>>traffic>>>uplink", 50),
                stat("user>>>b>>>traffic>>>downlink", 30),
            ],
        );
        assert_eq!(pending.get("a"), Some(&(150, 200)));
        assert_eq!(pending.get("b"), Some(&(0, 30)));
    }

    #[test]
    fn merge_clamps_negative_values_to_zero() {
        let mut pending = HashMap::new();
        merge_stats(&mut pending, &[stat("user>>>neg>>>traffic>>>uplink", -42)]);
        assert!(pending.is_empty());
    }

    #[test]
    fn merge_skips_zero_value_stat() {
        let mut pending = HashMap::new();
        merge_stats(&mut pending, &[stat("user>>>z>>>traffic>>>uplink", 0)]);
        assert!(pending.is_empty());
    }

    #[test]
    fn merge_records_nonzero_direction_when_other_is_zero() {
        let mut pending = HashMap::new();
        merge_stats(
            &mut pending,
            &[
                stat("user>>>mixed>>>traffic>>>uplink", 0),
                stat("user>>>mixed>>>traffic>>>downlink", 5),
            ],
        );
        assert_eq!(pending.get("mixed"), Some(&(0, 5)));
    }

    #[test]
    fn merge_ignores_unknown_counter_names() {
        let mut pending = HashMap::new();
        merge_stats(
            &mut pending,
            &[
                stat("inbound>>>node-x>>>traffic>>>uplink", 999),
                stat("user>>>x>>>traffic>>>total", 1),
                stat("user>>>x", 2),
            ],
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn merge_saturates_u64_addition() {
        let mut pending = HashMap::new();
        pending.insert("max".to_string(), (u64::MAX, 0));
        merge_stats(&mut pending, &[stat("user>>>max>>>traffic>>>uplink", 1)]);
        assert_eq!(pending.get("max"), Some(&(u64::MAX, 0)));
    }

    #[test]
    fn drain_removes_keys_and_skips_zeros() {
        let mut pending = HashMap::new();
        pending.insert("zero".to_string(), (0, 0));
        pending.insert("active".to_string(), (10, 20));
        pending.insert("also".to_string(), (0, 5));

        let entries = drain_entries(&mut pending, 10);

        assert!(pending.is_empty());
        let total_uplink: i64 = entries.iter().map(|e| e.uplink_bytes).sum();
        let total_downlink: i64 = entries.iter().map(|e| e.downlink_bytes).sum();
        assert_eq!(total_uplink, 10);
        assert_eq!(total_downlink, 25);
    }

    #[test]
    fn drain_respects_cap_and_leaves_remainder() {
        let mut pending = HashMap::new();
        for i in 0..5 {
            pending.insert(format!("sub-{i}"), (i as u64 + 1, 0));
        }

        let entries = drain_entries(&mut pending, 2);

        assert_eq!(entries.len(), 2);
        assert_eq!(pending.len(), 3);
        let drained: u64 = entries.iter().map(|e| e.uplink_bytes as u64).sum();
        let remaining: u64 = pending.values().map(|(u, _)| *u).sum();
        assert_eq!(drained + remaining, 1 + 2 + 3 + 4 + 5);
    }

    #[test]
    fn drain_empty_map_returns_empty_vec() {
        let mut pending: HashMap<String, (u64, u64)> = HashMap::new();
        assert!(drain_entries(&mut pending, 10).is_empty());
    }

    #[test]
    fn re_merge_preserves_totals_after_failure() {
        let mut pending = HashMap::new();
        pending.insert("a".to_string(), (100, 200));
        pending.insert("b".to_string(), (50, 0));

        let entries = drain_entries(&mut pending, 10);
        assert!(pending.is_empty());

        re_merge_entries(&mut pending, &entries);

        assert_eq!(pending.get("a"), Some(&(100, 200)));
        assert_eq!(pending.get("b"), Some(&(50, 0)));
    }

    #[test]
    fn re_merge_saturates_when_pending_grew_in_the_meantime() {
        let mut pending = HashMap::new();
        pending.insert("a".to_string(), (u64::MAX, 0));
        let entries = vec![ReportAgentTrafficBodyEntriesItem {
            subscription_id: "a".parse().unwrap(),
            uplink_bytes: 1,
            downlink_bytes: 0,
        }];
        re_merge_entries(&mut pending, &entries);
        assert_eq!(pending.get("a"), Some(&(u64::MAX, 0)));
    }

    #[test]
    fn clamp_i64_caps_at_max() {
        assert_eq!(clamp_i64(i64::MAX as u64), i64::MAX);
        assert_eq!(clamp_i64(u64::MAX), i64::MAX);
    }

    #[test]
    fn parse_direction_round_trips() {
        assert_eq!(
            parse_user_counter("user>>>id>>>traffic>>>uplink"),
            Some(("id", Direction::Uplink))
        );
        assert_eq!(
            parse_user_counter("user>>>id>>>traffic>>>downlink"),
            Some(("id", Direction::Downlink))
        );
    }
}
