//! Tracing capture: the agent's own events enter the buffer as `agent` records.
//!
//! The layer sits beside the local formatter and receives the same events, so
//! local output is unchanged. It masks fields whose names suggest credentials
//! before they are formatted into the record.

use std::fmt::{self, Write as _};

use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, Layer};

use super::model::{LogLevel, LogSource};
use super::store::LogStore;
use super::text::REDACTED;

/// Tracing target of supervised sing-box output. Those lines reach the buffer
/// from the process pipe with their real source, so the layer skips them here
/// to avoid recording each line twice.
pub(crate) const SING_BOX_OUTPUT_TARGET: &str = "sing_box_output";

/// Field-name fragments whose values are masked before capture.
const SENSITIVE_FIELD_FRAGMENTS: &[&str] = &[
    "token",
    "secret",
    "password",
    "authorization",
    "private_key",
    "hmac",
];

pub(crate) struct CaptureLayer {
    store: LogStore,
}

impl CaptureLayer {
    pub(crate) fn new(store: LogStore) -> Self {
        Self { store }
    }
}

impl<S: Subscriber> Layer<S> for CaptureLayer {
    fn on_event(&self, event: &Event<'_>, _context: Context<'_, S>) {
        let metadata = event.metadata();
        if metadata.target() == SING_BOX_OUTPUT_TARGET {
            return;
        }
        let mut visitor = TextVisitor::default();
        event.record(&mut visitor);
        self.store.record(
            LogSource::Agent,
            level_of(metadata.level()),
            self.store.current_process_generation(),
            &visitor.into_text(),
        );
    }
}

fn level_of(level: &Level) -> LogLevel {
    if *level == Level::ERROR {
        LogLevel::Error
    } else if *level == Level::WARN {
        LogLevel::Warn
    } else if *level == Level::INFO {
        LogLevel::Info
    } else if *level == Level::DEBUG {
        LogLevel::Debug
    } else {
        LogLevel::Trace
    }
}

fn is_sensitive(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    SENSITIVE_FIELD_FRAGMENTS
        .iter()
        .any(|fragment| lower.contains(fragment))
}

/// Formats an event as `message field=value …`, the same shape the local
/// formatter prints, minus colour and timestamps. The message is kept apart
/// because tracing may visit it before or after the other fields.
#[derive(Default)]
struct TextVisitor {
    message: String,
    fields: String,
}

impl TextVisitor {
    fn into_text(self) -> String {
        match (self.message.is_empty(), self.fields.is_empty()) {
            (_, true) => self.message,
            (true, false) => self.fields,
            (false, false) => format!("{} {}", self.message, self.fields),
        }
    }
}

impl Visit for TextVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if field.name() == "message" {
            // `fmt::Arguments` debug-prints as its plain message text.
            let _ = write!(self.message, "{value:?}");
        } else if is_sensitive(field.name()) {
            push_pair(&mut self.fields, field.name(), REDACTED);
        } else {
            push_pair(&mut self.fields, field.name(), &format!("{value:?}"));
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message.push_str(value);
        } else if is_sensitive(field.name()) {
            push_pair(&mut self.fields, field.name(), REDACTED);
        } else {
            push_pair(&mut self.fields, field.name(), &format!("{value:?}"));
        }
    }
}

fn push_pair(out: &mut String, name: &str, value: &str) {
    if !out.is_empty() {
        out.push(' ');
    }
    let _ = write!(out, "{name}={value}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::model::RingLimits;
    use tracing_subscriber::layer::SubscriberExt as _;

    fn capture(body: impl FnOnce()) -> Vec<(LogSource, LogLevel, String)> {
        let store = LogStore::new(RingLimits::default());
        let subscriber = tracing_subscriber::registry().with(CaptureLayer::new(store.clone()));
        tracing::subscriber::with_default(subscriber, body);
        store
            .resume(None, 100)
            .unwrap()
            .records
            .iter()
            .map(|r| (r.source, r.level, r.text.clone()))
            .collect()
    }

    #[test]
    fn agent_events_are_captured_with_level_and_fields() {
        let records = capture(|| {
            tracing::warn!(attempt = 3, "restart delayed");
            tracing::error!("plain failure");
        });
        assert_eq!(
            records,
            vec![
                (
                    LogSource::Agent,
                    LogLevel::Warn,
                    "restart delayed attempt=3".to_owned()
                ),
                (
                    LogSource::Agent,
                    LogLevel::Error,
                    "plain failure".to_owned()
                ),
            ]
        );
    }

    #[test]
    fn sensitive_named_fields_are_masked_at_the_source() {
        let records = capture(|| {
            tracing::info!(github_token = "ghp_live_value", "release lookup");
            tracing::info!(authorization = "Bearer abc123", "header");
        });
        assert_eq!(records[0].2, "release lookup github_token=[REDACTED]");
        assert_eq!(records[1].2, "header authorization=[REDACTED]");
    }

    #[test]
    fn sing_box_output_target_is_not_recorded_twice() {
        let records = capture(|| {
            tracing::info!(target: SING_BOX_OUTPUT_TARGET, "sing-box: already captured");
            tracing::info!("agent line");
        });
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].2, "agent line");
    }
}
