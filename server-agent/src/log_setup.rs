//! Tracing subscriber setup and the reloadable agent log filter.
//!
//! The subscriber is built once. The remote log policy changes the effective
//! level through a `tracing_subscriber::reload` handle, so the retained capture
//! layer, its quotas and its redaction state survive every level change.

use std::sync::Arc;

use anyhow::Result;
use chrono::Utc;
use tracing::warn;
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::reload;
use tracing_subscriber::util::SubscriberInitExt as _;

use crate::cli::Args;
use crate::log_policy::{AgentFilter, Level as PolicyLevel, LogPolicy};
use crate::logs::{CaptureLayer, LogStore};

fn parse_level(level: &str) -> tracing::Level {
    match level.to_lowercase().as_str() {
        "trace" => tracing::Level::TRACE,
        "debug" => tracing::Level::DEBUG,
        "warn" => tracing::Level::WARN,
        "error" => tracing::Level::ERROR,
        _ => tracing::Level::INFO,
    }
}

fn policy_level(level: &str) -> PolicyLevel {
    match parse_level(level) {
        tracing::Level::TRACE => PolicyLevel::Trace,
        tracing::Level::DEBUG => PolicyLevel::Debug,
        tracing::Level::WARN => PolicyLevel::Warn,
        tracing::Level::ERROR => PolicyLevel::Error,
        _ => PolicyLevel::Info,
    }
}

fn tracing_level(level: PolicyLevel) -> tracing::Level {
    match level {
        PolicyLevel::Trace => tracing::Level::TRACE,
        PolicyLevel::Debug => tracing::Level::DEBUG,
        PolicyLevel::Warn => tracing::Level::WARN,
        PolicyLevel::Error => tracing::Level::ERROR,
        // `default` is resolved to a concrete baseline before it reaches a
        // filter, so `info` is only a defensive fallback.
        PolicyLevel::Default | PolicyLevel::Info => tracing::Level::INFO,
    }
}

struct ReloadingFilter {
    handle: reload::Handle<LevelFilter, tracing_subscriber::Registry>,
}

impl AgentFilter for ReloadingFilter {
    fn set_level(&self, level: PolicyLevel) -> Result<(), String> {
        self.handle
            .reload(LevelFilter::from_level(tracing_level(level)))
            .map_err(|error| error.to_string())
    }
}

/// Installs the global subscriber, loads the persisted log policy, and returns
/// the retained log store plus the policy facade the runtimes share.
pub(crate) fn init(args: &Args) -> Result<(LogStore, Arc<LogPolicy>)> {
    let logs = LogStore::shared();
    let agent_baseline = policy_level(&args.log_level);
    let (level_filter, level_handle) =
        reload::Layer::new(LevelFilter::from_level(parse_level(&args.log_level)));
    tracing_subscriber::registry()
        .with(level_filter)
        .with(tracing_subscriber::fmt::layer())
        .with(CaptureLayer::new(logs.clone()))
        .init();
    let (log_policy, policy_warnings) = LogPolicy::load(
        &args.state_dir,
        agent_baseline,
        Arc::new(ReloadingFilter {
            handle: level_handle,
        }),
        Utc::now(),
    );
    for warning in policy_warnings {
        warn!("{warning}");
    }
    Ok((logs, Arc::new(log_policy)))
}

#[cfg(test)]
mod tests {
    use super::ReloadingFilter;
    use crate::log_policy::Level as PolicyLevel;

    #[test]
    fn reloadable_filter_changes_capture_without_rebuilding_the_layer() {
        use crate::log_policy::AgentFilter as _;
        use tracing_subscriber::layer::SubscriberExt as _;

        let store = crate::logs::LogStore::default();
        let (filter, handle) =
            tracing_subscriber::reload::Layer::new(tracing_subscriber::filter::LevelFilter::INFO);
        let subscriber = tracing_subscriber::registry()
            .with(filter)
            .with(crate::logs::CaptureLayer::new(store.clone()));
        tracing::subscriber::with_default(subscriber, || {
            tracing::debug!("dropped before the reload");
            ReloadingFilter { handle }
                .set_level(PolicyLevel::Debug)
                .expect("filter reloads");
            tracing::debug!("kept after the reload");
        });
        let texts: Vec<String> = store
            .resume(None, 10)
            .unwrap()
            .records
            .into_iter()
            .map(|record| record.text.clone())
            .collect();
        assert_eq!(texts, vec!["kept after the reload".to_string()]);
    }
}
