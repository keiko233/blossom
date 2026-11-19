//! Traffic reports over protocol v2.
//!
//! The durable outbox in [`crate::traffic`] seals each batch to disk and
//! releases it only after an acknowledgement. Over v2 the acknowledgement is
//! `traffic.ack`, which the control plane sends after its ledger commits. A
//! report with no acknowledgement (a dropped session, or a deadline) stays
//! queued under the same `reportId`, so the next session resends it and the
//! ledger answers `duplicate`.
//!
//! Collection never waits on the socket. The reporter runs on its own task,
//! and each flush is a bounded round trip to the session task.

use std::future::Future;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;
use tracing::error;

use super::codec::{TrafficEntry, TrafficReport, report_id_ok};
use super::session::{TrafficOutcome, TrafficPorts, TrafficRequest};
use crate::traffic::{Batch, ReportSink, SendOutcome, TrafficReporter};

/// How long a report may wait for its `traffic.ack` before it is retried.
pub const ACK_DEADLINE: Duration = Duration::from_secs(15);

/// Delivers sealed batches through the live v2 session.
pub struct SessionSink {
    requests: mpsc::Sender<TrafficRequest>,
    online: watch::Receiver<bool>,
}

impl SessionSink {
    pub fn new(requests: mpsc::Sender<TrafficRequest>, online: watch::Receiver<bool>) -> Self {
        Self { requests, online }
    }
}

impl ReportSink for SessionSink {
    fn send(&self, batch: &Batch) -> impl Future<Output = SendOutcome> + Send {
        let online = *self.online.borrow();
        let report = to_report(batch);
        let requests = self.requests.clone();
        async move {
            if !online {
                return SendOutcome::Retry(
                    "the control plane session is not connected".to_string(),
                );
            }
            let report = match report {
                Ok(report) => report,
                Err(reason) => return SendOutcome::Rejected(reason),
            };
            let (reply, outcome) = oneshot::channel();
            match tokio::time::timeout(
                ACK_DEADLINE,
                requests.send(TrafficRequest { report, reply }),
            )
            .await
            {
                Ok(Ok(())) => {}
                Ok(Err(_)) => {
                    return SendOutcome::Retry("the traffic channel is closed".to_string());
                }
                Err(_) => {
                    return SendOutcome::Retry("timed out queueing the traffic report".to_string());
                }
            }
            match tokio::time::timeout(ACK_DEADLINE, outcome).await {
                Ok(Ok(TrafficOutcome::Accepted)) => SendOutcome::Delivered {
                    acknowledged_id: true,
                },
                Ok(Ok(TrafficOutcome::Conflict(reason) | TrafficOutcome::Rejected(reason))) => {
                    SendOutcome::Rejected(reason)
                }
                Ok(Err(_)) => {
                    SendOutcome::Retry("the connection ended before traffic.ack".to_string())
                }
                Err(_) => SendOutcome::Retry("no traffic.ack before the deadline".to_string()),
            }
        }
    }
}

/// Converts a sealed batch to the wire payload. A batch the wire would refuse
/// is rejected locally, so it cannot block the queue behind it.
fn to_report(batch: &Batch) -> Result<TrafficReport, String> {
    if !report_id_ok(&batch.report_id) {
        return Err(format!("invalid traffic report id {}", batch.report_id));
    }
    let entries = batch
        .entries
        .iter()
        .map(|entry| {
            if entry.subscription_id.is_empty()
                || entry.uplink_bytes < 0
                || entry.downlink_bytes < 0
            {
                return Err("invalid traffic entry".to_string());
            }
            Ok(TrafficEntry {
                subscription_id: entry.subscription_id.clone(),
                uplink_bytes: entry.uplink_bytes,
                downlink_bytes: entry.downlink_bytes,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(TrafficReport {
        report_id: batch.report_id.clone(),
        window_started_at: Some(batch.window_started_at),
        window_ended_at: Some(batch.window_ended_at),
        entries,
    })
}

/// Drives the reporter until `cancel` fires. It flushes on each interval and
/// as soon as a session comes online, so reports queued while offline (or
/// before a restart) go out without waiting for the next tick.
pub async fn run_reporter(
    mut reporter: TrafficReporter,
    ports: TrafficPorts,
    interval: Duration,
    cancel: CancellationToken,
) {
    let TrafficPorts {
        requests,
        mut online,
    } = ports;
    let sink = SessionSink::new(requests, online.clone());
    let mut tick = tokio::time::interval(interval);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tick.tick() => reporter.collect_and_flush(&sink).await,
            changed = online.changed() => {
                if changed.is_err() {
                    error!("traffic reporter stopped: the session bridge closed");
                    return;
                }
                if *online.borrow() {
                    reporter.collect_and_flush(&sink).await;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
