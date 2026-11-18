//! DNS-01 broker over the authenticated agent WebSocket.
//!
//! The agent computes the TXT digest and sends only the record name/value to
//! the control plane. The control plane owns DNS credentials, writes the
//! record, and acknowledges the exact job/FQDN pair before the challenge is
//! marked ready.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, oneshot};

use crate::ws::codec::{AgentWsFrame, frame_type};
use crate::ws::ports::AgentCommandSink;

use super::ports::{
    AcmeError, AcmeErrorPhase, DnsBroker, DnsRecord, MAX_CHALLENGE_VALUE_LEN, MAX_DNS_NAME_LEN,
    MAX_DOMAINS,
};

const DEFAULT_ACK_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DnsAck {
    pub job_id: String,
    pub fqdn: String,
    pub txt_value: String,
    pub accepted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

type WaiterKey = (String, String, String);

pub struct WsDnsBroker {
    sink: Arc<dyn AgentCommandSink>,
    waiters: Mutex<HashMap<WaiterKey, oneshot::Sender<DnsAck>>>,
    ack_timeout: Duration,
    settle: Duration,
}

impl fmt::Debug for WsDnsBroker {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WsDnsBroker")
            .field("sink", &"<agent websocket>")
            .field("ack_timeout", &self.ack_timeout)
            .field("settle", &self.settle)
            .finish()
    }
}

impl WsDnsBroker {
    pub fn new(sink: Arc<dyn AgentCommandSink>, ack_timeout: Duration, settle: Duration) -> Self {
        Self {
            sink,
            waiters: Mutex::new(HashMap::new()),
            ack_timeout,
            settle,
        }
    }

    pub fn with_defaults(sink: Arc<dyn AgentCommandSink>, settle: Duration) -> Self {
        Self::new(sink, DEFAULT_ACK_TIMEOUT, settle)
    }

    pub async fn handle_ack(&self, ack: DnsAck) {
        let mut waiters = self.waiters.lock().await;
        if let Some(waiter) =
            waiters.remove(&(ack.job_id.clone(), ack.fqdn.clone(), ack.txt_value.clone()))
        {
            let _ = waiter.send(ack);
        }
    }

    pub async fn cancel_job(&self, job_id: &str) {
        let mut waiters = self.waiters.lock().await;
        waiters.retain(|(waiting_job, _, _), _| waiting_job != job_id);
    }

    async fn register(
        &self,
        job_id: &str,
        fqdn: &str,
        txt_value: &str,
    ) -> Result<oneshot::Receiver<DnsAck>, AcmeError> {
        let mut waiters = self.waiters.lock().await;
        if waiters.len() >= MAX_DOMAINS {
            return Err(AcmeError::dns(
                "DNS challenge broker already has the maximum pending records",
            ));
        }
        let key = (job_id.to_string(), fqdn.to_string(), txt_value.to_string());
        if waiters.contains_key(&key) {
            return Err(AcmeError::dns(
                "DNS challenge broker already has a pending request for this name",
            ));
        }
        let (sender, receiver) = oneshot::channel();
        waiters.insert(key, sender);
        Ok(receiver)
    }

    async fn remove_waiter(&self, job_id: &str, fqdn: &str, txt_value: &str) {
        self.waiters.lock().await.remove(&(
            job_id.to_string(),
            fqdn.to_string(),
            txt_value.to_string(),
        ));
    }
}

#[async_trait]
impl DnsBroker for WsDnsBroker {
    async fn present(&self, job_id: &str, record: &DnsRecord) -> Result<(), AcmeError> {
        validate_record(record)?;
        let receiver = self
            .register(job_id, &record.fqdn, record.value.expose())
            .await?;
        let payload = serde_json::json!({
            "jobId": job_id,
            "fqdn": record.fqdn,
            "txtValue": record.value.expose(),
        });
        let frame = AgentWsFrame::new(frame_type::ACME_DNS_PRESENT, payload).map_err(|error| {
            AcmeError::dns(format!("failed to encode DNS challenge request: {error}"))
        })?;
        if let Err(error) = self.sink.enqueue(crate::ws::ports::WsCommand::Send(frame)) {
            self.remove_waiter(job_id, &record.fqdn, record.value.expose())
                .await;
            return Err(AcmeError::dns(format!(
                "failed to send DNS challenge request: {}",
                error.describe()
            )));
        }

        let ack = match tokio::time::timeout(self.ack_timeout, receiver).await {
            Ok(Ok(ack)) => ack,
            Ok(Err(_)) => {
                self.remove_waiter(job_id, &record.fqdn, record.value.expose())
                    .await;
                return Err(AcmeError::dns(
                    "DNS challenge acknowledgement channel closed",
                ));
            }
            Err(_) => {
                self.remove_waiter(job_id, &record.fqdn, record.value.expose())
                    .await;
                return Err(AcmeError::new(
                    AcmeErrorPhase::Timeout,
                    "control plane did not acknowledge the DNS challenge",
                ));
            }
        };
        if !ack.accepted {
            return Err(AcmeError::dns(ack.error.unwrap_or_else(|| {
                "control plane rejected the DNS record".to_string()
            })));
        }
        if !self.settle.is_zero() {
            tokio::time::sleep(self.settle).await;
        }
        Ok(())
    }

    async fn cleanup(&self, job_id: &str, record: &DnsRecord) -> Result<(), AcmeError> {
        validate_record(record)?;
        self.remove_waiter(job_id, &record.fqdn, record.value.expose())
            .await;
        let payload = serde_json::json!({
            "jobId": job_id,
            "fqdn": record.fqdn,
            "txtValue": record.value.expose(),
        });
        let frame = AgentWsFrame::new(frame_type::ACME_DNS_CLEANUP, payload).map_err(|error| {
            AcmeError::dns(format!("failed to encode DNS cleanup request: {error}"))
        })?;
        self.sink
            .enqueue(crate::ws::ports::WsCommand::Send(frame))
            .map_err(|error| {
                AcmeError::dns(format!(
                    "failed to send DNS cleanup request: {}",
                    error.describe()
                ))
            })
    }
}

fn validate_record(record: &DnsRecord) -> Result<(), AcmeError> {
    let fqdn = record.fqdn.as_str();
    if fqdn.is_empty()
        || fqdn.len() > MAX_DNS_NAME_LEN
        || fqdn.starts_with('.')
        || fqdn.ends_with('.')
        || !fqdn
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(AcmeError::challenge(
            "ACME returned an invalid DNS-01 record name",
        ));
    }
    if record.value.expose().is_empty()
        || record.value.expose().len() > MAX_CHALLENGE_VALUE_LEN
        || record
            .value
            .expose()
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
    {
        return Err(AcmeError::challenge(
            "ACME returned an invalid DNS-01 challenge value",
        ));
    }
    Ok(())
}

/// Wraps DNS solver state with the exact records that need cleanup.
pub struct Dns01Solver {
    broker: Arc<dyn DnsBroker>,
    records: Mutex<Vec<DnsRecord>>,
}

impl Dns01Solver {
    pub fn new(broker: Arc<dyn DnsBroker>) -> Self {
        Self {
            broker,
            records: Mutex::new(Vec::new()),
        }
    }

    pub async fn present(&self, job_id: &str, record: DnsRecord) -> Result<(), AcmeError> {
        let mut records = self.records.lock().await;
        if records.len() >= MAX_DOMAINS {
            return Err(AcmeError::challenge(
                "DNS-01 challenge set exceeds the configured bound",
            ));
        }
        // Record before sending: a timeout after the control plane created the
        // TXT record must still produce a cleanup request.
        records.push(record.clone());
        drop(records);
        self.broker.present(job_id, &record).await
    }

    pub async fn cleanup_all(&self, job_id: &str) {
        let records = std::mem::take(&mut *self.records.lock().await);
        for record in records {
            if let Err(error) = self.broker.cleanup(job_id, &record).await {
                tracing::warn!(
                    job_id = %job_id,
                    fqdn = %record.fqdn,
                    phase = error.phase.as_str(),
                    "DNS cleanup request failed"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::sync::mpsc;

    use crate::ws::codec::AgentWsFrame;
    use crate::ws::ports::{ChannelCommandSink, WsCommand, command_channel};

    use super::{Dns01Solver, DnsAck, WsDnsBroker};
    use crate::acme::ports::{DnsBroker as _, DnsRecord, SecretString};

    fn record() -> DnsRecord {
        DnsRecord {
            fqdn: "_acme-challenge.example.com".into(),
            value: SecretString::new("txt-digest"),
        }
    }

    fn decode(command: WsCommand) -> AgentWsFrame {
        match command {
            WsCommand::Send(frame) => frame,
            WsCommand::Close => panic!("unexpected close command"),
        }
    }

    #[tokio::test]
    async fn present_waits_for_the_exact_control_plane_ack() {
        let (sink, mut commands) = command_channel(8);
        let sink: Arc<dyn crate::ws::ports::AgentCommandSink> = Arc::new(sink);
        let broker = Arc::new(WsDnsBroker::new(
            sink,
            Duration::from_secs(1),
            Duration::ZERO,
        ));
        let broker_for_ack = broker.clone();
        let present = tokio::spawn(async move { broker.present("job-1", &record()).await });

        let command = commands.recv().await.unwrap();
        let frame = decode(command);
        assert_eq!(frame.msg_type, "acme.dns_present");
        assert_eq!(frame.payload["fqdn"], "_acme-challenge.example.com");
        assert_eq!(frame.payload["txtValue"], "txt-digest");

        broker_for_ack
            .handle_ack(DnsAck {
                job_id: "job-1".into(),
                fqdn: "_acme-challenge.example.com".into(),
                txt_value: "txt-digest".into(),
                accepted: true,
                error: None,
            })
            .await;
        present.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn rejected_or_unanswered_requests_fail_without_hanging() {
        let (sink, mut commands) = command_channel(8);
        let sink: Arc<dyn crate::ws::ports::AgentCommandSink> = Arc::new(sink);
        let broker = Arc::new(WsDnsBroker::new(
            sink,
            Duration::from_millis(20),
            Duration::ZERO,
        ));

        let present = tokio::spawn({
            let broker = broker.clone();
            async move { broker.present("job-1", &record()).await }
        });
        let _ = commands.recv().await.unwrap();
        let error = present.await.unwrap().unwrap_err();
        assert_eq!(error.phase, crate::acme::ports::AcmeErrorPhase::Timeout);

        let present = tokio::spawn({
            let broker = broker.clone();
            async move { broker.present("job-2", &record()).await }
        });
        let _ = commands.recv().await.unwrap();
        broker
            .handle_ack(DnsAck {
                job_id: "job-2".into(),
                fqdn: "_acme-challenge.example.com".into(),
                txt_value: "txt-digest".into(),
                accepted: false,
                error: Some("zone not authorized".into()),
            })
            .await;
        let error = present.await.unwrap().unwrap_err();
        assert_eq!(error.phase, crate::acme::ports::AcmeErrorPhase::DnsBroker);
    }

    #[tokio::test]
    async fn ack_for_a_different_txt_value_does_not_release_the_challenge() {
        let (sink, mut commands) = command_channel(8);
        let sink: Arc<dyn crate::ws::ports::AgentCommandSink> = Arc::new(sink);
        let broker = Arc::new(WsDnsBroker::new(
            sink,
            Duration::from_millis(30),
            Duration::ZERO,
        ));
        let present = tokio::spawn({
            let broker = broker.clone();
            async move { broker.present("job-1", &record()).await }
        });
        let _ = commands.recv().await.unwrap();
        broker
            .handle_ack(DnsAck {
                job_id: "job-1".into(),
                fqdn: "_acme-challenge.example.com".into(),
                txt_value: "different-value".into(),
                accepted: true,
                error: None,
            })
            .await;
        let error = present.await.unwrap().unwrap_err();
        assert_eq!(error.phase, crate::acme::ports::AcmeErrorPhase::Timeout);
    }

    #[tokio::test]
    async fn solver_tracks_presented_records_for_cleanup() {
        let (sink, mut commands) = command_channel(8);
        let sink: Arc<dyn crate::ws::ports::AgentCommandSink> = Arc::new(sink);
        let broker = Arc::new(WsDnsBroker::new(
            sink,
            Duration::from_secs(1),
            Duration::ZERO,
        ));
        let solver = Dns01Solver::new(broker.clone());
        let cleanup = tokio::spawn({
            let solver = Arc::new(solver);
            let broker = broker.clone();
            async move {
                let present = tokio::spawn({
                    let solver = solver.clone();
                    async move {
                        solver
                            .present(
                                "job-1",
                                DnsRecord {
                                    fqdn: "_acme-challenge.example.com".into(),
                                    value: SecretString::new("txt-digest"),
                                },
                            )
                            .await
                    }
                });
                let present_frame = decode(commands.recv().await.unwrap());
                assert_eq!(present_frame.msg_type, "acme.dns_present");
                broker
                    .handle_ack(DnsAck {
                        job_id: "job-1".into(),
                        fqdn: "_acme-challenge.example.com".into(),
                        txt_value: "txt-digest".into(),
                        accepted: true,
                        error: None,
                    })
                    .await;
                present.await.unwrap().unwrap();
                solver.cleanup_all("job-1").await;
                decode(commands.recv().await.unwrap())
            }
        });

        let cleanup_frame = cleanup.await.unwrap();
        assert_eq!(cleanup_frame.msg_type, "acme.dns_cleanup");
    }

    #[test]
    fn channel_sink_is_exported_for_the_real_agent() {
        let (sender, _receiver) = mpsc::channel(1);
        let _ = ChannelCommandSink::new(sender);
    }
}
