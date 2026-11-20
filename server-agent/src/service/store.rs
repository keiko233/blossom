//! Atomic `0600` persistence of one deployment journal per service.

use std::fmt;
use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use super::journal::{DeploymentJournal, JournalError};
use super::ports::ServiceIdentity;

/// Owns `<dir>/<service>.journal.json`. The directory belongs to the local
/// service-control boundary, which is the journal's single writer.
pub(crate) struct JournalStore {
    path: PathBuf,
    service: ServiceIdentity,
}

impl JournalStore {
    #[must_use]
    pub(crate) fn new(dir: &Path, service: ServiceIdentity) -> Self {
        Self {
            path: dir.join(format!("{service}.journal.json")),
            service,
        }
    }

    pub(crate) fn service(&self) -> ServiceIdentity {
        self.service
    }

    /// Loads the journal, or a fresh one when none was written yet. A present
    /// but unreadable journal is an error: guessing a boot selection could
    /// resurrect a disabled runtime or an unproven candidate.
    pub(crate) fn load(&self) -> Result<DeploymentJournal, StoreError> {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(DeploymentJournal::new(self.service));
            }
            Err(error) => return Err(StoreError::Read(error)),
        };
        let journal: DeploymentJournal =
            serde_json::from_slice(&bytes).map_err(StoreError::Decode)?;
        journal
            .validate(self.service)
            .map_err(StoreError::Invalid)?;
        Ok(journal)
    }

    pub(crate) fn persist(&self, journal: &DeploymentJournal) -> Result<(), StoreError> {
        if journal.service() != self.service {
            return Err(StoreError::Invalid(JournalError::ServiceMismatch));
        }
        let bytes = serde_json::to_vec_pretty(journal).map_err(StoreError::Encode)?;
        write_atomic(&self.path, &bytes).map_err(StoreError::Write)
    }
}

/// Writes through an exclusive `0600` temporary file in the same directory,
/// then renames it over the journal and syncs the directory entry.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    // The journal directory has a single writer, so a leftover temporary file
    // can only come from an interrupted earlier write.
    let _ = std::fs::remove_file(&temporary);
    let written = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written?;
    if let Some(parent) = path.parent() {
        std::fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[derive(Debug)]
pub(crate) enum StoreError {
    Read(std::io::Error),
    Decode(serde_json::Error),
    Encode(serde_json::Error),
    Invalid(JournalError),
    Write(std::io::Error),
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read(error) => write!(formatter, "cannot read deployment journal: {error}"),
            Self::Decode(error) => write!(formatter, "cannot decode deployment journal: {error}"),
            Self::Encode(error) => write!(formatter, "cannot encode deployment journal: {error}"),
            Self::Invalid(error) => write!(formatter, "invalid deployment journal: {error}"),
            Self::Write(error) => write!(formatter, "cannot write deployment journal: {error}"),
        }
    }
}

impl std::error::Error for StoreError {}

#[cfg(test)]
pub(super) fn test_dir(name: &str) -> PathBuf {
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "blossom-service-{name}-{}-{suffix}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use super::*;
    use crate::service::journal::fixtures::record;

    #[test]
    fn missing_journals_start_fresh_and_persisted_ones_round_trip() {
        let dir = test_dir("store-round-trip");
        let store = JournalStore::new(&dir, ServiceIdentity::SingBox);
        let mut journal = store.load().unwrap();
        assert_eq!(journal, DeploymentJournal::new(ServiceIdentity::SingBox));

        journal
            .authorize_trial(record(1), Duration::seconds(30))
            .unwrap();
        journal.disable();
        store.persist(&journal).unwrap();
        assert_eq!(store.load().unwrap(), journal);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(dir.join("sing-box.journal.json"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unreadable_or_foreign_journals_fail_closed() {
        let dir = test_dir("store-fail-closed");
        let runtime = JournalStore::new(&dir, ServiceIdentity::SingBox);
        std::fs::write(dir.join("sing-box.journal.json"), b"{").unwrap();
        assert!(matches!(runtime.load(), Err(StoreError::Decode(_))));

        let agent = JournalStore::new(&dir, ServiceIdentity::Agent);
        agent
            .persist(&DeploymentJournal::new(ServiceIdentity::Agent))
            .unwrap();
        std::fs::copy(
            dir.join("agent.journal.json"),
            dir.join("sing-box.journal.json"),
        )
        .unwrap();
        assert!(matches!(
            runtime.load(),
            Err(StoreError::Invalid(JournalError::ServiceMismatch))
        ));
        assert!(matches!(
            runtime.persist(&DeploymentJournal::new(ServiceIdentity::Agent)),
            Err(StoreError::Invalid(JournalError::ServiceMismatch))
        ));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
