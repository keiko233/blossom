//! Agent-side native runtime adapter.
//!
//! This is the opt-in cutover from processkit to externally supervised systemd.
//! The helper owns the journal, promotion and systemd jobs; this adapter only
//! translates the v2 apply sequence into typed control requests. Production
//! activation stays gated on restart-safe metering (task 05).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sha2::{Digest as _, Sha256};

use super::control::{ControlClient, ControlError};
use super::journal::{ArtifactDigest, Generation, GenerationRecord, RuntimeInstance};
use super::ports::{ActiveState, RuntimeService as _, ServiceIdentity, ServiceObservation};
use super::promote::{ReleaseComponent, ReleaseLayout};

#[derive(Clone)]
pub(crate) struct NativeRuntime {
    client: Arc<ControlClient>,
    runtime: ServiceIdentity,
    layout: ReleaseLayout,
    observation: Arc<Mutex<Option<ServiceObservation>>>,
}

impl NativeRuntime {
    #[must_use]
    pub(crate) fn new(socket: impl Into<PathBuf>, release_dir: impl Into<PathBuf>) -> Self {
        Self {
            client: Arc::new(ControlClient::new(socket)),
            runtime: ServiceIdentity::SingBox,
            layout: ReleaseLayout::new(release_dir),
            observation: Arc::new(Mutex::new(None)),
        }
    }

    pub(crate) async fn committed_binary(&self) -> Result<Option<PathBuf>, ControlError> {
        Ok(self.client.committed(self.runtime).await?.map(|record| {
            self.layout
                .binary_path(ReleaseComponent::SingBox, &record.binary_sha256)
        }))
    }

    /// The generation the helper's journal has committed. The local active
    /// config describes exactly this generation; a serving trial generation
    /// differs and is not adopted as committed metering state.
    pub(crate) async fn committed_generation(&self) -> Result<Option<Generation>, ControlError> {
        Ok(self
            .client
            .committed(self.runtime)
            .await?
            .map(|record| record.generation))
    }

    pub(crate) async fn reconcile(&self) -> Result<Option<RuntimeInstance>, ControlError> {
        self.client.reconcile(ServiceIdentity::Agent).await?;
        let instance = self.client.reconcile(self.runtime).await?;
        self.refresh_observation().await;
        Ok(instance)
    }

    pub(crate) async fn refresh_observation(&self) {
        if let Ok(observation) = self.client.inspect(self.runtime).await {
            *self.observation.lock().expect("native observation lock") = Some(observation);
        }
    }

    pub(crate) fn active_state(&self) -> Option<ActiveState> {
        self.observation
            .lock()
            .expect("native observation lock")
            .as_ref()
            .map(|observation| observation.active)
    }

    pub(crate) async fn runtime_instance(&self) -> Result<Option<RuntimeInstance>, ControlError> {
        self.refresh_observation().await;
        self.client.runtime_instance(self.runtime).await
    }

    /// Copies the compiled candidate config into protected storage and returns
    /// the candidate generation bound to the currently committed binary.
    pub(crate) async fn stage_candidate_config(
        &self,
        candidate: &Path,
    ) -> Result<GenerationRecord, ControlError> {
        let bytes = tokio::fs::read(candidate)
            .await
            .map_err(|error| ControlError::InvalidRequest(error.to_string()))?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(ControlError::InvalidRequest(
                "candidate config exceeds the size bound".to_string(),
            ));
        }
        let digest = ArtifactDigest::try_from(hex::encode(Sha256::digest(&bytes)))
            .map_err(|_| ControlError::InvalidRequest("candidate digest".to_string()))?;
        self.client
            .stage_config(self.runtime, candidate.to_path_buf(), digest)
            .await
    }

    pub(crate) async fn begin_trial(
        &self,
        candidate: GenerationRecord,
        probation: Duration,
    ) -> Result<RuntimeInstance, ControlError> {
        let instance = self
            .client
            .trial_start(self.runtime, candidate, probation)
            .await?;
        self.refresh_observation().await;
        Ok(instance)
    }

    pub(crate) async fn commit_and_confirm(
        &self,
        generation: Generation,
    ) -> Result<(), ControlError> {
        self.client.commit(self.runtime, generation).await?;
        self.client.confirm(self.runtime, generation).await
    }

    pub(crate) async fn rollback(&self) -> Result<(), ControlError> {
        self.client.rollback(self.runtime).await.map(|_| ())
    }

    pub(crate) async fn enable(&self) -> Result<(), ControlError> {
        self.client.enable(self.runtime).await.map(|_| ())
    }

    pub(crate) async fn disable(&self) -> Result<(), ControlError> {
        self.client.disable(self.runtime).await
    }
}
