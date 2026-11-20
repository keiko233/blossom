//! Durable deployment journal for one managed service.
//!
//! The journal is the single source of the boot selection. It links the
//! committed (last-known-good) generation, an optional candidate trial, the
//! invocation that is serving, and the durable run intent. All transitions are
//! pure; callers persist the journal before acting on the result.

use std::fmt;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use super::ports::{InvocationId, ServiceIdentity, ServiceObservation};

/// Trials of one candidate generation allowed before it is refused locally.
pub(crate) const MAX_TRIAL_ATTEMPTS: u32 = 3;

const JOURNAL_SCHEMA: u32 = 1;

/// A locally assigned, strictly increasing generation number per service.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct Generation(pub(crate) u64);

impl fmt::Display for Generation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "g{}", self.0)
    }
}

/// Lowercase hex SHA-256 of a promoted artifact.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub(crate) struct ArtifactDigest(String);

impl TryFrom<String> for ArtifactDigest {
    type Error = JournalError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.len() == 64
            && value
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        {
            Ok(Self(value))
        } else {
            Err(JournalError::InvalidDigest)
        }
    }
}

impl From<ArtifactDigest> for String {
    fn from(value: ArtifactDigest) -> Self {
        value.0
    }
}

/// The immutable artifacts one generation boots from. Paths are derived
/// locally from the digests by the promoter; none come from the control plane.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GenerationRecord {
    pub(crate) generation: Generation,
    pub(crate) binary_sha256: ArtifactDigest,
    pub(crate) config_sha256: ArtifactDigest,
}

/// Durable operator or control-plane intent for whether the service may serve.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RunIntent {
    #[default]
    Enabled,
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "kebab-case")]
pub(crate) enum TrialPhase {
    /// One-shot authorization persisted; the next invocation boots the candidate.
    Authorized,
    /// The authorization was consumed by `invocation`, which must become
    /// locally ready and be committed before `ready_by`.
    Probation {
        invocation: InvocationId,
        #[serde(rename = "readyBy")]
        ready_by: DateTime<Utc>,
    },
    /// The trial ended without commit. The committed generation boots.
    Failed { reason: TrialFailure },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum TrialFailure {
    /// A later invocation started before the candidate was committed.
    Interrupted,
    /// The local readiness deadline passed.
    DeadlineExpired,
    /// The caller rolled the candidate back.
    RolledBack,
    /// Disable intent was recorded during the trial.
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Trial {
    pub(crate) candidate: GenerationRecord,
    pub(crate) attempt: u32,
    pub(crate) probation_secs: u64,
    #[serde(flatten)]
    pub(crate) phase: TrialPhase,
}

impl Trial {
    fn is_active(&self) -> bool {
        !matches!(self.phase, TrialPhase::Failed { .. })
    }
}

/// Whether a committed generation has also been confirmed by an authenticated
/// control-plane exchange. While pending, the previous generation is retained
/// for a revert.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub(crate) enum Confirmation {
    #[default]
    Confirmed,
    Pending {
        previous: GenerationRecord,
    },
}

/// The invocation the boot selector bound to a generation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Serving {
    pub(crate) generation: Generation,
    pub(crate) invocation: InvocationId,
}

/// The unit task 05 keys runtime checkpoints by: one generation running under
/// one invocation. Counters never carry across instances.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct RuntimeInstance {
    pub(crate) service: ServiceIdentity,
    pub(crate) generation: Generation,
    pub(crate) invocation: InvocationId,
}

impl fmt::Display for RuntimeInstance {
    /// A stable key, safe as a file name component.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}-{}-{}",
            self.service, self.generation, self.invocation
        )
    }
}

/// What the next invocation must boot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BootSelection {
    /// Nothing has been committed yet; the unit must not serve.
    Unprovisioned,
    /// Disable intent is recorded; the unit must not serve.
    Disabled,
    Committed(GenerationRecord),
    /// The one-shot trial authorization was consumed for this invocation.
    Candidate(GenerationRecord),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentJournal {
    schema: u32,
    service: ServiceIdentity,
    #[serde(default)]
    intent: RunIntent,
    #[serde(default)]
    committed: Option<GenerationRecord>,
    #[serde(default)]
    confirmation: Confirmation,
    #[serde(default)]
    trial: Option<Trial>,
    #[serde(default)]
    serving: Option<Serving>,
}

impl DeploymentJournal {
    #[must_use]
    pub(crate) fn new(service: ServiceIdentity) -> Self {
        Self {
            schema: JOURNAL_SCHEMA,
            service,
            intent: RunIntent::Enabled,
            committed: None,
            confirmation: Confirmation::Confirmed,
            trial: None,
            serving: None,
        }
    }

    /// Validates a decoded journal against the expected service and schema.
    pub(crate) fn validate(&self, service: ServiceIdentity) -> Result<(), JournalError> {
        if self.schema != JOURNAL_SCHEMA {
            return Err(JournalError::UnsupportedSchema(self.schema));
        }
        if self.service != service {
            return Err(JournalError::ServiceMismatch);
        }
        Ok(())
    }

    pub(crate) fn service(&self) -> ServiceIdentity {
        self.service
    }

    pub(crate) fn intent(&self) -> RunIntent {
        self.intent
    }

    pub(crate) fn committed(&self) -> Option<&GenerationRecord> {
        self.committed.as_ref()
    }

    pub(crate) fn confirmation(&self) -> &Confirmation {
        &self.confirmation
    }

    pub(crate) fn trial(&self) -> Option<&Trial> {
        self.trial.as_ref()
    }

    /// Records a one-shot authorization for the next invocation to boot
    /// `candidate`. A generation names one artifact set: repeating a failed
    /// trial reuses its generation and consumes another attempt, up to
    /// [`MAX_TRIAL_ATTEMPTS`]. Generations never move backwards.
    pub(crate) fn authorize_trial(
        &mut self,
        candidate: GenerationRecord,
        probation: Duration,
    ) -> Result<(), JournalError> {
        if self.intent == RunIntent::Disabled {
            return Err(JournalError::Disabled);
        }
        let committed = self.committed.as_ref().map(|record| record.generation);
        let tried = self.trial.as_ref().map(|trial| trial.candidate.generation);
        if committed.is_some_and(|generation| candidate.generation <= generation)
            || tried.is_some_and(|generation| candidate.generation < generation)
        {
            return Err(JournalError::StaleGeneration);
        }
        let probation_secs = u64::try_from(probation.num_seconds())
            .ok()
            .filter(|secs| *secs > 0)
            .ok_or(JournalError::InvalidProbation)?;
        let attempt = match &self.trial {
            Some(trial) if trial.is_active() => return Err(JournalError::TrialInProgress),
            Some(trial) if trial.candidate.generation == candidate.generation => {
                if trial.candidate != candidate {
                    return Err(JournalError::GenerationConflict);
                }
                if trial.attempt >= MAX_TRIAL_ATTEMPTS {
                    return Err(JournalError::AttemptsExhausted);
                }
                trial.attempt + 1
            }
            _ => 1,
        };
        self.trial = Some(Trial {
            candidate,
            attempt,
            probation_secs,
            phase: TrialPhase::Authorized,
        });
        Ok(())
    }

    /// Runs once per service invocation, before anything serves. Consumes an
    /// authorized trial for `invocation`; any other invocation boots the
    /// committed generation and ends an unfinished trial.
    pub(crate) fn select_boot(
        &mut self,
        invocation: InvocationId,
        now: DateTime<Utc>,
    ) -> BootSelection {
        self.serving = None;
        if self.intent == RunIntent::Disabled {
            return BootSelection::Disabled;
        }
        if let Some(trial) = &mut self.trial {
            match trial.phase {
                TrialPhase::Authorized => {
                    let probation = i64::try_from(trial.probation_secs)
                        .map(Duration::seconds)
                        .unwrap_or(Duration::MAX);
                    trial.phase = TrialPhase::Probation {
                        invocation: invocation.clone(),
                        ready_by: now.checked_add_signed(probation).unwrap_or(now),
                    };
                    self.serving = Some(Serving {
                        generation: trial.candidate.generation,
                        invocation,
                    });
                    return BootSelection::Candidate(trial.candidate.clone());
                }
                TrialPhase::Probation { .. } => {
                    trial.phase = TrialPhase::Failed {
                        reason: TrialFailure::Interrupted,
                    };
                }
                TrialPhase::Failed { .. } => {}
            }
        }
        match &self.committed {
            Some(committed) => {
                self.serving = Some(Serving {
                    generation: committed.generation,
                    invocation,
                });
                BootSelection::Committed(committed.clone())
            }
            None => BootSelection::Unprovisioned,
        }
    }

    /// Ends a trial whose readiness deadline passed. Returns `true` when the
    /// running candidate must be restarted onto the committed generation.
    pub(crate) fn expire(&mut self, now: DateTime<Utc>) -> bool {
        let Some(trial) = &mut self.trial else {
            return false;
        };
        match trial.phase {
            TrialPhase::Probation { ready_by, .. } if now >= ready_by => {
                trial.phase = TrialPhase::Failed {
                    reason: TrialFailure::DeadlineExpired,
                };
                true
            }
            _ => false,
        }
    }

    /// Promotes the candidate after local readiness. Refused unless the same
    /// invocation that consumed the trial is still the one serving.
    pub(crate) fn commit(
        &mut self,
        generation: Generation,
        observed: &ServiceObservation,
        now: DateTime<Utc>,
    ) -> Result<(), JournalError> {
        let Some(trial) = &self.trial else {
            return Err(JournalError::NoTrial);
        };
        if trial.candidate.generation != generation {
            return Err(JournalError::NoTrial);
        }
        let TrialPhase::Probation {
            invocation,
            ready_by,
        } = &trial.phase
        else {
            return Err(JournalError::NoTrial);
        };
        if now >= *ready_by {
            return Err(JournalError::DeadlineExpired);
        }
        if observed.serving_invocation() != Some(invocation) {
            return Err(JournalError::InvocationChanged);
        }
        let candidate = trial.candidate.clone();
        self.confirmation = match self.committed.replace(candidate) {
            Some(previous) => Confirmation::Pending { previous },
            None => Confirmation::Confirmed,
        };
        self.trial = None;
        Ok(())
    }

    /// Records the authenticated control-plane confirmation and releases the
    /// retained previous generation.
    pub(crate) fn confirm(&mut self, generation: Generation) -> Result<(), JournalError> {
        match &self.committed {
            Some(committed) if committed.generation == generation => {
                self.confirmation = Confirmation::Confirmed;
                Ok(())
            }
            _ => Err(JournalError::NotCommitted),
        }
    }

    /// Ends the current trial. The committed generation boots next.
    pub(crate) fn rollback(&mut self) -> Result<(), JournalError> {
        match &mut self.trial {
            Some(trial) if trial.is_active() => {
                trial.phase = TrialPhase::Failed {
                    reason: TrialFailure::RolledBack,
                };
                Ok(())
            }
            _ => Err(JournalError::NoTrial),
        }
    }

    /// Reverts a committed but unconfirmed generation to the retained one.
    pub(crate) fn revert_unconfirmed(&mut self) -> Result<GenerationRecord, JournalError> {
        if self.trial.as_ref().is_some_and(Trial::is_active) {
            return Err(JournalError::TrialInProgress);
        }
        let Confirmation::Pending { previous } = std::mem::take(&mut self.confirmation) else {
            return Err(JournalError::NotPending);
        };
        self.committed = Some(previous.clone());
        Ok(previous)
    }

    /// Records durable disable intent. A trial in progress ends unconfirmed.
    pub(crate) fn disable(&mut self) {
        self.intent = RunIntent::Disabled;
        if let Some(trial) = &mut self.trial
            && trial.is_active()
        {
            trial.phase = TrialPhase::Failed {
                reason: TrialFailure::Disabled,
            };
        }
    }

    pub(crate) fn enable(&mut self) {
        self.intent = RunIntent::Enabled;
    }

    /// The runtime instance serving now, if the observed invocation is the one
    /// the boot selector bound. `None` is an unattributed window.
    pub(crate) fn runtime_instance(
        &self,
        observed: &ServiceObservation,
    ) -> Option<RuntimeInstance> {
        let serving = self.serving.as_ref()?;
        if observed.service != self.service
            || observed.serving_invocation() != Some(&serving.invocation)
        {
            return None;
        }
        Some(RuntimeInstance {
            service: self.service,
            generation: serving.generation,
            invocation: serving.invocation.clone(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JournalError {
    UnsupportedSchema(u32),
    ServiceMismatch,
    InvalidDigest,
    InvalidProbation,
    Disabled,
    StaleGeneration,
    GenerationConflict,
    TrialInProgress,
    AttemptsExhausted,
    NoTrial,
    DeadlineExpired,
    InvocationChanged,
    NotCommitted,
    NotPending,
}

impl fmt::Display for JournalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedSchema(schema) => {
                write!(formatter, "unsupported deployment journal schema {schema}")
            }
            Self::ServiceMismatch => {
                formatter.write_str("deployment journal names another service")
            }
            Self::InvalidDigest => formatter.write_str("artifact digest is not lowercase SHA-256"),
            Self::InvalidProbation => formatter.write_str("probation must be at least one second"),
            Self::Disabled => formatter.write_str("service is disabled"),
            Self::StaleGeneration => {
                formatter.write_str("candidate generation is not newer than the committed one")
            }
            Self::GenerationConflict => {
                formatter.write_str("candidate generation was reused with different artifacts")
            }
            Self::TrialInProgress => formatter.write_str("a trial is already in progress"),
            Self::AttemptsExhausted => {
                formatter.write_str("candidate trial attempts are exhausted")
            }
            Self::NoTrial => formatter.write_str("no matching trial is in probation"),
            Self::DeadlineExpired => formatter.write_str("candidate readiness deadline passed"),
            Self::InvocationChanged => {
                formatter.write_str("service invocation changed during probation")
            }
            Self::NotCommitted => formatter.write_str("generation is not committed"),
            Self::NotPending => formatter.write_str("no unconfirmed generation to revert"),
        }
    }
}

impl std::error::Error for JournalError {}

#[cfg(test)]
pub(super) mod fixtures {
    use super::*;
    use crate::service::ports::{ActiveState, SystemdInvocation};

    pub(crate) fn record(generation: u64) -> GenerationRecord {
        let digest = |seed: u64| ArtifactDigest::try_from(format!("{seed:064x}")).unwrap();
        GenerationRecord {
            generation: Generation(generation),
            binary_sha256: digest(generation),
            config_sha256: digest(generation + 1000),
        }
    }

    pub(crate) fn invocation(seed: u8) -> InvocationId {
        InvocationId::Systemd {
            id: SystemdInvocation::try_from(format!("{seed:032x}")).unwrap(),
        }
    }

    pub(crate) fn active(
        service: ServiceIdentity,
        invocation: &InvocationId,
    ) -> ServiceObservation {
        ServiceObservation {
            service,
            active: ActiveState::Active,
            invocation: Some(invocation.clone()),
        }
    }

    pub(crate) fn at(secs: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000 + secs, 0).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::{active, at, invocation, record};
    use super::*;

    const RUNTIME: ServiceIdentity = ServiceIdentity::SingBox;

    fn committed_journal() -> DeploymentJournal {
        let mut journal = DeploymentJournal::new(RUNTIME);
        journal
            .authorize_trial(record(1), Duration::seconds(30))
            .unwrap();
        journal.select_boot(invocation(1), at(0));
        journal
            .commit(Generation(1), &active(RUNTIME, &invocation(1)), at(1))
            .unwrap();
        journal
    }

    #[test]
    fn a_trial_authorization_is_consumed_by_exactly_one_invocation() {
        let mut journal = committed_journal();
        journal
            .authorize_trial(record(2), Duration::seconds(30))
            .unwrap();

        assert_eq!(
            journal.select_boot(invocation(2), at(10)),
            BootSelection::Candidate(record(2))
        );
        assert_eq!(
            journal.select_boot(invocation(3), at(11)),
            BootSelection::Committed(record(1))
        );
        assert_eq!(
            journal.trial().unwrap().phase,
            TrialPhase::Failed {
                reason: TrialFailure::Interrupted
            }
        );
        assert_eq!(
            journal.commit(Generation(2), &active(RUNTIME, &invocation(2)), at(12)),
            Err(JournalError::NoTrial)
        );
    }

    #[test]
    fn commit_requires_the_consuming_invocation_to_still_serve() {
        let mut journal = committed_journal();
        journal
            .authorize_trial(record(2), Duration::seconds(30))
            .unwrap();
        journal.select_boot(invocation(2), at(10));

        assert_eq!(
            journal.commit(Generation(2), &active(RUNTIME, &invocation(9)), at(11)),
            Err(JournalError::InvocationChanged)
        );
        let mut stopped = active(RUNTIME, &invocation(2));
        stopped.active = crate::service::ports::ActiveState::Failed;
        assert_eq!(
            journal.commit(Generation(2), &stopped, at(11)),
            Err(JournalError::InvocationChanged)
        );
        journal
            .commit(Generation(2), &active(RUNTIME, &invocation(2)), at(12))
            .unwrap();
        assert_eq!(journal.committed(), Some(&record(2)));
        assert_eq!(
            journal.confirmation(),
            &Confirmation::Pending {
                previous: record(1)
            }
        );
    }

    #[test]
    fn the_readiness_deadline_ends_probation_offline() {
        let mut journal = committed_journal();
        journal
            .authorize_trial(record(2), Duration::seconds(30))
            .unwrap();
        journal.select_boot(invocation(2), at(10));

        assert!(!journal.expire(at(39)));
        assert_eq!(
            journal.commit(Generation(2), &active(RUNTIME, &invocation(2)), at(40)),
            Err(JournalError::DeadlineExpired)
        );
        assert!(journal.expire(at(40)));
        assert!(!journal.expire(at(41)));
        assert_eq!(
            journal.select_boot(invocation(3), at(42)),
            BootSelection::Committed(record(1))
        );
    }

    #[test]
    fn trial_attempts_are_bounded_per_generation() {
        let mut journal = committed_journal();
        for attempt in 1..=MAX_TRIAL_ATTEMPTS {
            journal
                .authorize_trial(record(2), Duration::seconds(30))
                .unwrap();
            assert_eq!(journal.trial().unwrap().attempt, attempt);
            assert_eq!(
                journal.authorize_trial(record(2), Duration::seconds(30)),
                Err(JournalError::TrialInProgress)
            );
            journal.rollback().unwrap();
        }
        assert_eq!(
            journal.authorize_trial(record(2), Duration::seconds(30)),
            Err(JournalError::AttemptsExhausted)
        );
        let mut reused = record(2);
        reused.config_sha256 = record(7).config_sha256;
        assert_eq!(
            journal.authorize_trial(reused, Duration::seconds(30)),
            Err(JournalError::GenerationConflict)
        );
        journal
            .authorize_trial(record(3), Duration::seconds(30))
            .unwrap();
        assert_eq!(journal.trial().unwrap().attempt, 1);
        assert_eq!(
            journal.authorize_trial(record(4), Duration::seconds(30)),
            Err(JournalError::TrialInProgress)
        );
        journal.rollback().unwrap();
        assert_eq!(
            journal.authorize_trial(record(2), Duration::seconds(30)),
            Err(JournalError::StaleGeneration)
        );
    }

    #[test]
    fn stale_or_invalid_candidates_are_refused() {
        let mut journal = committed_journal();
        assert_eq!(
            journal.authorize_trial(record(1), Duration::seconds(30)),
            Err(JournalError::StaleGeneration)
        );
        assert_eq!(
            journal.authorize_trial(record(2), Duration::zero()),
            Err(JournalError::InvalidProbation)
        );
        assert_eq!(
            ArtifactDigest::try_from("ABC".to_owned()),
            Err(JournalError::InvalidDigest)
        );
    }

    #[test]
    fn disable_is_durable_and_ends_a_trial() {
        let mut journal = committed_journal();
        journal
            .authorize_trial(record(2), Duration::seconds(30))
            .unwrap();
        journal.disable();

        assert_eq!(
            journal.select_boot(invocation(2), at(10)),
            BootSelection::Disabled
        );
        assert_eq!(
            journal.authorize_trial(record(3), Duration::seconds(30)),
            Err(JournalError::Disabled)
        );
        assert!(
            journal
                .runtime_instance(&active(RUNTIME, &invocation(2)))
                .is_none()
        );

        journal.enable();
        assert_eq!(
            journal.select_boot(invocation(3), at(11)),
            BootSelection::Committed(record(1))
        );
        assert_eq!(
            journal.trial().unwrap().phase,
            TrialPhase::Failed {
                reason: TrialFailure::Disabled
            }
        );
    }

    #[test]
    fn unconfirmed_commits_revert_and_confirmed_ones_do_not() {
        let mut journal = committed_journal();
        assert_eq!(journal.revert_unconfirmed(), Err(JournalError::NotPending));
        journal
            .authorize_trial(record(2), Duration::seconds(30))
            .unwrap();
        journal.select_boot(invocation(2), at(10));
        journal
            .commit(Generation(2), &active(RUNTIME, &invocation(2)), at(11))
            .unwrap();

        assert_eq!(journal.revert_unconfirmed(), Ok(record(1)));
        assert_eq!(journal.committed(), Some(&record(1)));

        journal
            .authorize_trial(record(3), Duration::seconds(30))
            .unwrap();
        journal.select_boot(invocation(3), at(20));
        journal
            .commit(Generation(3), &active(RUNTIME, &invocation(3)), at(21))
            .unwrap();
        assert_eq!(
            journal.confirm(Generation(1)),
            Err(JournalError::NotCommitted)
        );
        journal.confirm(Generation(3)).unwrap();
        assert_eq!(journal.revert_unconfirmed(), Err(JournalError::NotPending));
    }

    #[test]
    fn runtime_instances_follow_the_bound_invocation() {
        let mut journal = DeploymentJournal::new(RUNTIME);
        assert_eq!(
            journal.select_boot(invocation(1), at(0)),
            BootSelection::Unprovisioned
        );
        let mut journal = committed_journal();
        journal.select_boot(invocation(4), at(5));

        let instance = journal
            .runtime_instance(&active(RUNTIME, &invocation(4)))
            .unwrap();
        assert_eq!(instance.generation, Generation(1));
        assert_eq!(
            instance.to_string(),
            format!("sing-box-g1-systemd-{:032x}", 4)
        );
        assert!(
            journal
                .runtime_instance(&active(RUNTIME, &invocation(5)))
                .is_none()
        );
        assert!(
            journal
                .runtime_instance(&active(ServiceIdentity::Agent, &invocation(4)))
                .is_none()
        );
    }

    #[test]
    fn journals_round_trip_and_reject_foreign_or_future_files() {
        let mut journal = committed_journal();
        journal
            .authorize_trial(record(2), Duration::seconds(30))
            .unwrap();
        journal.select_boot(invocation(2), at(10));
        let encoded = serde_json::to_value(&journal).unwrap();
        assert_eq!(encoded["trial"]["phase"], "probation");
        assert_eq!(encoded["trial"]["candidate"]["generation"], 2);

        let decoded: DeploymentJournal = serde_json::from_value(encoded.clone()).unwrap();
        assert_eq!(decoded, journal);
        decoded.validate(RUNTIME).unwrap();
        assert_eq!(
            decoded.validate(ServiceIdentity::Agent),
            Err(JournalError::ServiceMismatch)
        );
        let mut future = encoded;
        future["schema"] = serde_json::json!(2);
        let future: DeploymentJournal = serde_json::from_value(future).unwrap();
        assert_eq!(
            future.validate(RUNTIME),
            Err(JournalError::UnsupportedSchema(2))
        );
    }
}
