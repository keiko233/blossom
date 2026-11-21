//! Native-runtime metering bridge.
//!
//! The v2 core remains the single owner of runtime observation. After startup,
//! every apply transition and the periodic runtime sample, it asks this bridge
//! to translate a task 04 [`RuntimeInstance`] and the committed generation's
//! inbound classification into a [`RuntimeObservation`] for the one
//! [`MeteringWorker`](super::worker::MeteringWorker).
//!
//! A generation whose classification is unknown, a runtime instance without
//! one, or an unsupported stats protocol never creates or feeds a meter. That
//! is the fail-closed managed capability: the caller logs the unavailable
//! window and the worker keeps no checkpoint for traffic it cannot classify.

use std::collections::BTreeMap;

use tokio::sync::mpsc;
use tracing::{error, info, warn};

use super::filter::{
    InboundClassification, ManagedMetering, MeteringCapabilityError, managed_metering,
};
use super::worker::{RuntimeObservation, StatsEndpoint};
use crate::service::{Generation, NativeRuntime};

struct CommittedRuntime {
    classification: InboundClassification,
    endpoint: StatsEndpoint,
}

/// Bridges task 04 observations to the one accounting worker.
pub(crate) struct NativeMetering {
    observations: mpsc::Sender<RuntimeObservation>,
    /// Classification and endpoint are fixed by the committed generation, not
    /// by the currently observed stream or the mutable config pointer.
    committed: BTreeMap<u64, CommittedRuntime>,
    stats_supported: bool,
    /// The last runtime instance sent to the worker. Repeated samples of the
    /// same serving invocation do not create another subscription.
    last_instance: Option<String>,
    /// Whether the worker already saw an unattributed window. It is cleared by
    /// the next attributed observation.
    unattributed: bool,
}

impl NativeMetering {
    #[must_use]
    pub(crate) fn new(
        observations: mpsc::Sender<RuntimeObservation>,
        stats_supported: bool,
    ) -> Self {
        Self {
            observations,
            committed: BTreeMap::new(),
            stats_supported,
            last_instance: None,
            unattributed: false,
        }
    }

    /// Records the classification and endpoint of one committed generation.
    /// A retried candidate reuses its generation, so the same entry is
    /// replaced only with identical contract data.
    pub(crate) fn register(
        &mut self,
        generation: Generation,
        classification: InboundClassification,
        endpoint: StatsEndpoint,
    ) {
        self.committed.insert(
            generation.0,
            CommittedRuntime {
                classification,
                endpoint,
            },
        );
    }

    /// The managed-metering gate used before a native candidate is trialled.
    pub(crate) fn require_ready(
        &self,
        classification: &InboundClassification,
    ) -> Result<(), MeteringCapabilityError> {
        let tags = classification.tags();
        match managed_metering(self.stats_supported, classification, &tags) {
            ManagedMetering::Ready => Ok(()),
            ManagedMetering::Unsupported(error) => Err(error),
        }
    }

    /// Samples the current runtime and sends a new observation only when the
    /// serving invocation or attribution state changed. A control-socket
    /// error keeps the last meter attached; it is not evidence that the
    /// runtime stopped serving.
    pub(crate) async fn observe(&mut self, native: &NativeRuntime) {
        match native.runtime_instance().await {
            Ok(Some(instance)) => {
                let key = instance.to_string();
                if self.last_instance.as_deref() == Some(key.as_str()) {
                    return;
                }
                let Some(committed) = self.committed.get(&instance.generation.0) else {
                    warn!(
                        generation = %instance.generation,
                        "no committed inbound classification for the serving runtime generation; this traffic window is unobservable"
                    );
                    self.send_unattributed().await;
                    return;
                };
                match self.require_ready(&committed.classification) {
                    Ok(()) => {
                        info!(
                            instance = %key,
                            inbounds = committed.classification.tags().len(),
                            "native runtime metering attached"
                        );
                        let observation = RuntimeObservation::Attributed {
                            instance,
                            classification: committed.classification.clone(),
                            endpoint: committed.endpoint.clone(),
                        };
                        if self.send(observation).await {
                            self.last_instance = Some(key);
                            self.unattributed = false;
                        }
                    }
                    Err(capability) => {
                        warn!(
                            instance = %key,
                            "managed metering is unavailable for this runtime; this traffic window is unobservable: {capability}"
                        );
                        self.send_unattributed().await;
                    }
                }
            }
            Ok(None) => self.send_unattributed().await,
            Err(error) => {
                warn!(
                    "runtime metering evidence is unavailable; the last observation is kept: {error}"
                );
            }
        }
    }

    async fn send_unattributed(&mut self) {
        if self.unattributed && self.last_instance.is_none() {
            return;
        }
        if self.send(RuntimeObservation::Unattributed).await {
            self.last_instance = None;
            self.unattributed = true;
        }
    }

    async fn send(&self, observation: RuntimeObservation) -> bool {
        if self.observations.send(observation).await.is_err() {
            error!("metering worker stopped; no accounting worker is attached to this runtime");
            return false;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint() -> StatsEndpoint {
        StatsEndpoint::new("127.0.0.1:9", Some("fixture-secret".to_string()))
    }

    fn classification() -> InboundClassification {
        InboundClassification::new([
            (
                "node-n1".to_string(),
                super::super::filter::InboundKind::Subscriber,
            ),
            (
                "peer-in-b".to_string(),
                super::super::filter::InboundKind::Peer,
            ),
        ])
        .unwrap()
    }

    #[test]
    fn a_generation_is_only_meterable_with_its_committed_classification() {
        let (sender, _receiver) = mpsc::channel(1);
        let mut bridge = NativeMetering::new(sender, true);
        assert!(bridge.require_ready(&classification()).is_ok());
        bridge.register(Generation(2), classification(), endpoint());
        assert!(matches!(
            bridge.require_ready(&InboundClassification::default()),
            Err(MeteringCapabilityError::Classification(_))
        ));
        assert!(bridge.committed.contains_key(&2));
    }

    #[test]
    fn an_unsupported_stats_protocol_never_reports_ready() {
        let (sender, _receiver) = mpsc::channel(1);
        let bridge = NativeMetering::new(sender, false);
        assert!(matches!(
            bridge.require_ready(&classification()),
            Err(MeteringCapabilityError::UnsupportedStatsProtocol)
        ));
    }

    #[tokio::test]
    async fn repeated_unattributed_samples_do_not_spam_the_worker() {
        let (sender, mut receiver) = mpsc::channel(4);
        let mut bridge = NativeMetering::new(sender, true);
        bridge.send_unattributed().await;
        bridge.send_unattributed().await;
        assert!(matches!(
            receiver.recv().await,
            Some(RuntimeObservation::Unattributed)
        ));
        assert!(receiver.try_recv().is_err());
        assert!(bridge.unattributed);
        assert!(bridge.last_instance.is_none());
    }
}
