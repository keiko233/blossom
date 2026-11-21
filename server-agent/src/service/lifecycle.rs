//! Lifecycle operations over the runtime service port and the journal.
//!
//! The journal is re-read before every decision because the boot selector
//! runs inside each service invocation, outside this process. Intent is
//! persisted before the service is touched, so a crash between the two leaves
//! the next invocation on the durable decision.

use std::fmt;
use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};

use super::journal::{
    BootSelection, Generation, GenerationRecord, JournalError, RunIntent, RuntimeInstance,
    TrialPhase,
};
use super::ports::{
    InvocationId, RuntimeService, ServiceError, ServiceObservation, ServiceOperation,
};
use super::store::{JournalStore, StoreError};

/// Boot selection for one invocation. The privileged boot helper runs this
/// before the unit's main process starts and boots only what it returns; the
/// trial authorization is consumed and persisted before the candidate runs.
pub(crate) fn select_boot(
    store: &JournalStore,
    invocation: InvocationId,
    now: DateTime<Utc>,
) -> Result<BootSelection, StoreError> {
    let mut journal = store.load()?;
    let selection = journal.select_boot(invocation, now);
    store.persist(&journal)?;
    Ok(selection)
}

/// Trial, commit, rollback and run-intent operations for one managed service.
pub(crate) struct ServiceLifecycle {
    port: Arc<dyn RuntimeService>,
    store: JournalStore,
}

impl ServiceLifecycle {
    #[must_use]
    pub(crate) fn new(port: Arc<dyn RuntimeService>, store: JournalStore) -> Self {
        Self { port, store }
    }

    pub(crate) fn service(&self) -> super::ports::ServiceIdentity {
        self.store.service()
    }

    /// Reads the service through the backend without touching the journal.
    pub(crate) async fn inspect(&self) -> Result<ServiceObservation, LifecycleError> {
        Ok(self.port.inspect(self.store.service()).await?)
    }

    /// Applies an ordinary start, stop, reload or restart and returns the
    /// re-read service state.
    pub(crate) async fn apply(
        &self,
        operation: ServiceOperation,
    ) -> Result<ServiceObservation, LifecycleError> {
        Ok(self.port.apply(self.store.service(), operation).await?)
    }

    /// The committed (last-known-good) generation, if any.
    pub(crate) fn committed(&self) -> Result<Option<GenerationRecord>, LifecycleError> {
        Ok(self.store.load()?.committed().cloned())
    }

    /// Allocates the next local generation for an artifact set. A retry of the
    /// same failed candidate reuses its generation; a changed candidate moves
    /// forward.
    pub(crate) fn next_generation_for(
        &self,
        binary: &super::journal::ArtifactDigest,
        config: &super::journal::ArtifactDigest,
    ) -> Result<Generation, LifecycleError> {
        Ok(self.store.load()?.next_generation_for(binary, config))
    }

    /// Marks the committed generation confirmed after an authenticated
    /// control-plane exchange.
    pub(crate) fn confirm(&self, generation: Generation) -> Result<(), LifecycleError> {
        let mut journal = self.store.load()?;
        journal.confirm(generation)?;
        self.store.persist(&journal)?;
        Ok(())
    }

    /// Reverts an unconfirmed commit to the retained previous generation and
    /// restarts onto it.
    pub(crate) async fn revert_unconfirmed(&self) -> Result<RuntimeInstance, LifecycleError> {
        let mut journal = self.store.load()?;
        journal.revert_unconfirmed()?;
        self.store.persist(&journal)?;
        self.restart_committed().await
    }

    /// The instance serving now, verified against a fresh observation. An
    /// agent that restarts adopts the running service through this call.
    pub(crate) async fn runtime_instance(&self) -> Result<Option<RuntimeInstance>, LifecycleError> {
        let observed = self.port.inspect(self.store.service()).await?;
        Ok(self.store.load()?.runtime_instance(&observed))
    }

    /// Authorizes a one-shot trial of `candidate` and restarts the service
    /// onto it. On error the candidate may have failed to start; the service
    /// manager's restart policy then boots the committed generation. An
    /// authorization no invocation consumed is withdrawn, so it cannot arm an
    /// unrelated later restart.
    pub(crate) async fn begin_trial(
        &self,
        candidate: GenerationRecord,
        probation: Duration,
    ) -> Result<RuntimeInstance, LifecycleError> {
        let generation = candidate.generation;
        let mut journal = self.store.load()?;
        journal.authorize_trial(candidate, probation)?;
        self.store.persist(&journal)?;

        let observed = match self
            .port
            .apply(self.store.service(), ServiceOperation::Restart)
            .await
        {
            Ok(observed) => observed,
            Err(error) => {
                let mut journal = self.store.load()?;
                if journal
                    .trial()
                    .is_some_and(|trial| trial.phase == TrialPhase::Authorized)
                {
                    journal.rollback()?;
                    self.store.persist(&journal)?;
                }
                return Err(error.into());
            }
        };
        let journal = self.store.load()?;
        let in_probation = journal
            .trial()
            .is_some_and(|trial| matches!(trial.phase, TrialPhase::Probation { .. }));
        match journal.runtime_instance(&observed) {
            Some(instance) if in_probation && instance.generation == generation => Ok(instance),
            _ => Err(LifecycleError::CandidateNotServing),
        }
    }

    /// Commits the candidate after local readiness, provided the invocation
    /// that consumed the trial is still serving.
    pub(crate) async fn commit(
        &self,
        generation: Generation,
        now: DateTime<Utc>,
    ) -> Result<(), LifecycleError> {
        let observed = self.port.inspect(self.store.service()).await?;
        let mut journal = self.store.load()?;
        journal.commit(generation, &observed, now)?;
        self.store.persist(&journal)?;
        Ok(())
    }

    /// Ends the trial and restarts onto the committed generation.
    pub(crate) async fn rollback(&self) -> Result<RuntimeInstance, LifecycleError> {
        let mut journal = self.store.load()?;
        journal.rollback()?;
        self.store.persist(&journal)?;
        self.restart_committed().await
    }

    /// Records durable disable intent, then stops the service. Any later
    /// invocation, including one after reboot, refuses to serve.
    pub(crate) async fn disable(&self) -> Result<(), LifecycleError> {
        let mut journal = self.store.load()?;
        journal.disable();
        self.store.persist(&journal)?;
        self.port
            .apply(self.store.service(), ServiceOperation::Stop)
            .await?;
        Ok(())
    }

    /// Clears disable intent and starts the committed generation.
    pub(crate) async fn enable(&self) -> Result<RuntimeInstance, LifecycleError> {
        let mut journal = self.store.load()?;
        journal.enable();
        self.store.persist(&journal)?;
        let observed = self
            .port
            .apply(self.store.service(), ServiceOperation::Start)
            .await?;
        self.committed_instance(&observed)
    }

    /// Reconciles durable intent with the observed service, for example after
    /// an agent restart or while offline: an expired trial restarts onto the
    /// committed generation and a disabled service is stopped.
    pub(crate) async fn reconcile(
        &self,
        now: DateTime<Utc>,
    ) -> Result<Option<RuntimeInstance>, LifecycleError> {
        let mut journal = self.store.load()?;
        if journal.expire(now) {
            self.store.persist(&journal)?;
            return self.restart_committed().await.map(Some);
        }
        let observed = self.port.inspect(self.store.service()).await?;
        if journal.intent() == RunIntent::Disabled && observed.serving_invocation().is_some() {
            self.port
                .apply(self.store.service(), ServiceOperation::Stop)
                .await?;
            return Ok(None);
        }
        Ok(journal.runtime_instance(&observed))
    }

    async fn restart_committed(&self) -> Result<RuntimeInstance, LifecycleError> {
        let observed = self
            .port
            .apply(self.store.service(), ServiceOperation::Restart)
            .await?;
        self.committed_instance(&observed)
    }

    fn committed_instance(
        &self,
        observed: &ServiceObservation,
    ) -> Result<RuntimeInstance, LifecycleError> {
        let journal = self.store.load()?;
        let committed = journal.committed().map(|record| record.generation);
        match journal.runtime_instance(observed) {
            Some(instance) if Some(instance.generation) == committed => Ok(instance),
            _ => Err(LifecycleError::CommittedNotServing),
        }
    }
}

#[derive(Debug)]
pub(crate) enum LifecycleError {
    Service(ServiceError),
    Journal(JournalError),
    Store(StoreError),
    /// The restart did not leave the candidate serving under its trial.
    CandidateNotServing,
    /// The service is not serving the committed generation.
    CommittedNotServing,
}

impl From<ServiceError> for LifecycleError {
    fn from(error: ServiceError) -> Self {
        Self::Service(error)
    }
}

impl From<JournalError> for LifecycleError {
    fn from(error: JournalError) -> Self {
        Self::Journal(error)
    }
}

impl From<StoreError> for LifecycleError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

impl fmt::Display for LifecycleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Service(error) => error.fmt(formatter),
            Self::Journal(error) => error.fmt(formatter),
            Self::Store(error) => error.fmt(formatter),
            Self::CandidateNotServing => formatter.write_str("candidate generation is not serving"),
            Self::CommittedNotServing => formatter.write_str("committed generation is not serving"),
        }
    }
}

impl std::error::Error for LifecycleError {}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::*;
    use crate::service::journal::fixtures::{at, invocation, record};
    use crate::service::journal::{DeploymentJournal, TrialFailure};
    use crate::service::ports::{ActiveState, ServiceIdentity};
    use crate::service::store::test_dir;

    const RUNTIME: ServiceIdentity = ServiceIdentity::SingBox;

    /// A fake service manager that runs the boot selector inside every
    /// invocation and applies a `Restart=on-failure` policy once.
    struct FakeSystemd {
        store: JournalStore,
        state: Mutex<FakeState>,
    }

    struct FakeState {
        active: ActiveState,
        invocation: Option<InvocationId>,
        next: u8,
        failing_generation: Option<Generation>,
        unavailable: bool,
        operations: Vec<ServiceOperation>,
    }

    impl FakeSystemd {
        fn new(dir: &Path) -> Arc<Self> {
            Arc::new(Self {
                store: JournalStore::new(dir, RUNTIME),
                state: Mutex::new(FakeState {
                    active: ActiveState::Inactive,
                    invocation: None,
                    next: 1,
                    failing_generation: None,
                    unavailable: false,
                    operations: Vec::new(),
                }),
            })
        }

        fn fail_generation(&self, generation: u64) {
            self.state.lock().unwrap().failing_generation = Some(Generation(generation));
        }

        /// A host reboot: the unit is enabled, so it starts a new invocation.
        fn reboot(&self) {
            self.invoke(&mut self.state.lock().unwrap(), true);
        }

        fn operations(&self) -> Vec<ServiceOperation> {
            self.state.lock().unwrap().operations.clone()
        }

        fn invoke(&self, state: &mut FakeState, retry_on_failure: bool) {
            let current = invocation(state.next);
            state.next += 1;
            state.invocation = Some(current.clone());
            let selection = select_boot(&self.store, current, at(i64::from(state.next))).unwrap();
            state.active = match selection {
                BootSelection::Committed(_) => ActiveState::Active,
                BootSelection::Candidate(candidate)
                    if Some(candidate.generation) != state.failing_generation =>
                {
                    ActiveState::Active
                }
                BootSelection::Candidate(_) if retry_on_failure => {
                    return self.invoke(state, false);
                }
                BootSelection::Candidate(_) => ActiveState::Failed,
                BootSelection::Disabled | BootSelection::Unprovisioned => ActiveState::Inactive,
            };
        }

        fn observe(&self, state: &FakeState) -> ServiceObservation {
            ServiceObservation {
                service: RUNTIME,
                active: state.active,
                invocation: state.invocation.clone(),
            }
        }
    }

    #[async_trait]
    impl RuntimeService for FakeSystemd {
        async fn inspect(
            &self,
            service: ServiceIdentity,
        ) -> Result<ServiceObservation, ServiceError> {
            assert_eq!(service, RUNTIME);
            Ok(self.observe(&self.state.lock().unwrap()))
        }

        async fn apply(
            &self,
            service: ServiceIdentity,
            operation: ServiceOperation,
        ) -> Result<ServiceObservation, ServiceError> {
            assert_eq!(service, RUNTIME);
            let mut state = self.state.lock().unwrap();
            if state.unavailable {
                return Err(ServiceError::Unavailable);
            }
            state.operations.push(operation);
            match operation {
                ServiceOperation::Stop => state.active = ActiveState::Inactive,
                ServiceOperation::Start if state.active == ActiveState::Active => {}
                ServiceOperation::Start | ServiceOperation::Restart => {
                    self.invoke(&mut state, true);
                }
                ServiceOperation::Reload => {}
            }
            Ok(self.observe(&state))
        }
    }

    /// Commits generation 1 so later trials have a last-known-good to fall
    /// back to.
    async fn provisioned(name: &str) -> (Arc<FakeSystemd>, ServiceLifecycle, PathBuf) {
        let dir = test_dir(name);
        let fake = FakeSystemd::new(&dir);
        let lifecycle = ServiceLifecycle::new(fake.clone(), JournalStore::new(&dir, RUNTIME));
        lifecycle
            .begin_trial(record(1), Duration::seconds(30))
            .await
            .unwrap();
        lifecycle.commit(Generation(1), at(3)).await.unwrap();
        (fake, lifecycle, dir)
    }

    fn journal(fake: &FakeSystemd) -> DeploymentJournal {
        fake.store.load().unwrap()
    }

    #[tokio::test]
    async fn a_candidate_is_trialled_committed_and_adopted_by_a_fresh_agent() {
        let (fake, lifecycle, dir) = provisioned("lifecycle-commit").await;

        let instance = lifecycle
            .begin_trial(record(2), Duration::seconds(30))
            .await
            .unwrap();
        assert_eq!(instance.generation, Generation(2));
        lifecycle.commit(Generation(2), at(4)).await.unwrap();
        assert_eq!(journal(&fake).committed(), Some(&record(2)));

        let restarted_agent = ServiceLifecycle::new(fake.clone(), JournalStore::new(&dir, RUNTIME));
        assert_eq!(
            restarted_agent.runtime_instance().await.unwrap(),
            Some(instance)
        );
        assert_eq!(
            fake.operations(),
            [ServiceOperation::Restart, ServiceOperation::Restart]
        );
    }

    #[tokio::test]
    async fn a_failing_candidate_falls_back_to_the_committed_generation() {
        let (fake, lifecycle, _) = provisioned("lifecycle-candidate-failure").await;
        fake.fail_generation(2);

        assert!(matches!(
            lifecycle
                .begin_trial(record(2), Duration::seconds(30))
                .await,
            Err(LifecycleError::CandidateNotServing)
        ));
        let instance = lifecycle.runtime_instance().await.unwrap().unwrap();
        assert_eq!(instance.generation, Generation(1));
        assert_eq!(
            journal(&fake).trial().unwrap().phase,
            TrialPhase::Failed {
                reason: TrialFailure::Interrupted
            }
        );
        assert!(matches!(
            lifecycle.commit(Generation(2), at(10)).await,
            Err(LifecycleError::Journal(JournalError::NoTrial))
        ));
    }

    #[tokio::test]
    async fn an_unconsumed_authorization_is_withdrawn_when_the_restart_fails() {
        let (fake, lifecycle, _) = provisioned("lifecycle-unavailable").await;
        fake.state.lock().unwrap().unavailable = true;

        assert!(matches!(
            lifecycle
                .begin_trial(record(2), Duration::seconds(30))
                .await,
            Err(LifecycleError::Service(ServiceError::Unavailable))
        ));
        assert_eq!(
            journal(&fake).trial().unwrap().phase,
            TrialPhase::Failed {
                reason: TrialFailure::RolledBack
            }
        );
        fake.state.lock().unwrap().unavailable = false;
        fake.reboot();
        assert_eq!(
            lifecycle
                .runtime_instance()
                .await
                .unwrap()
                .unwrap()
                .generation,
            Generation(1)
        );
    }

    #[tokio::test]
    async fn a_reboot_during_probation_boots_the_committed_generation() {
        let (fake, lifecycle, _) = provisioned("lifecycle-reboot").await;
        lifecycle
            .begin_trial(record(2), Duration::seconds(30))
            .await
            .unwrap();

        fake.reboot();

        let instance = lifecycle.runtime_instance().await.unwrap().unwrap();
        assert_eq!(instance.generation, Generation(1));
        assert!(matches!(
            lifecycle.commit(Generation(2), at(5)).await,
            Err(LifecycleError::Journal(JournalError::NoTrial))
        ));
    }

    #[tokio::test]
    async fn an_expired_trial_is_rolled_back_offline_by_reconcile() {
        let (fake, lifecycle, _) = provisioned("lifecycle-expiry").await;
        lifecycle
            .begin_trial(record(2), Duration::seconds(30))
            .await
            .unwrap();

        assert_eq!(
            lifecycle
                .reconcile(at(10))
                .await
                .unwrap()
                .unwrap()
                .generation,
            Generation(2)
        );
        let instance = lifecycle.reconcile(at(60)).await.unwrap().unwrap();
        assert_eq!(instance.generation, Generation(1));
        assert_eq!(
            journal(&fake).trial().unwrap().phase,
            TrialPhase::Failed {
                reason: TrialFailure::DeadlineExpired
            }
        );
    }

    #[tokio::test]
    async fn rollback_restarts_onto_the_committed_generation() {
        let (fake, lifecycle, _) = provisioned("lifecycle-rollback").await;
        lifecycle
            .begin_trial(record(2), Duration::seconds(30))
            .await
            .unwrap();

        let instance = lifecycle.rollback().await.unwrap();
        assert_eq!(instance.generation, Generation(1));
        assert_eq!(
            journal(&fake).trial().unwrap().phase,
            TrialPhase::Failed {
                reason: TrialFailure::RolledBack
            }
        );
    }

    #[tokio::test]
    async fn disable_survives_reboot_until_enabled() {
        let (fake, lifecycle, _) = provisioned("lifecycle-disable").await;

        lifecycle.disable().await.unwrap();
        fake.reboot();
        assert_eq!(lifecycle.runtime_instance().await.unwrap(), None);
        assert_eq!(lifecycle.reconcile(at(10)).await.unwrap(), None);
        assert!(matches!(
            lifecycle
                .begin_trial(record(2), Duration::seconds(30))
                .await,
            Err(LifecycleError::Journal(JournalError::Disabled))
        ));

        let instance = lifecycle.enable().await.unwrap();
        assert_eq!(instance.generation, Generation(1));
    }
}
