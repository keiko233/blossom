//! Atomic `0600` persistence of the single runtime checkpoint.

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

use super::checkpoint::{Checkpoint, CheckpointError};
use crate::traffic::{create_private_dir, write_atomic};

const CHECKPOINT_FILE: &str = "runtime.checkpoint.json";
const DAMAGED_FILE: &str = "runtime.checkpoint.damaged.json";

/// Owns `<dir>/runtime.checkpoint.json` for the one managed runtime. The agent
/// is its single writer; each commit replaces the whole file atomically.
pub(crate) struct CheckpointStore {
    dir: PathBuf,
}

/// What the store holds before an attach is classified.
#[derive(Debug)]
pub(super) enum Stored {
    Absent,
    /// Present but unusable. The file has been moved aside so later loads
    /// see `Absent` and never retry it.
    Damaged(Damage),
    Present(Checkpoint),
}

#[derive(Debug)]
pub(crate) enum Damage {
    Decode(serde_json::Error),
    Invalid(CheckpointError),
}

impl fmt::Display for Damage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Decode(error) => write!(formatter, "cannot decode checkpoint: {error}"),
            Self::Invalid(error) => write!(formatter, "invalid checkpoint: {error}"),
        }
    }
}

impl CheckpointStore {
    #[must_use]
    pub(crate) fn new(dir: &Path) -> Self {
        Self {
            dir: dir.to_path_buf(),
        }
    }

    pub(super) fn path(&self) -> PathBuf {
        self.dir.join(CHECKPOINT_FILE)
    }

    /// Reads the checkpoint. An unreadable file (permissions, I/O) is an
    /// error rather than damage: the caller retries instead of discarding a
    /// checkpoint that may still be intact.
    pub(super) fn read(&self) -> Result<Stored, StoreError> {
        let path = self.path();
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Stored::Absent),
            Err(error) => return Err(StoreError::Read(error)),
        };
        let damage = match serde_json::from_slice::<Checkpoint>(&bytes) {
            Ok(checkpoint) => match checkpoint.validate() {
                Ok(()) => return Ok(Stored::Present(checkpoint)),
                Err(error) => Damage::Invalid(error),
            },
            Err(error) => Damage::Decode(error),
        };
        std::fs::rename(&path, self.dir.join(DAMAGED_FILE)).map_err(StoreError::Write)?;
        Ok(Stored::Damaged(damage))
    }

    /// Replaces the checkpoint durably (temp file, fsync, rename, directory
    /// fsync). Only after this returns may the committed batches be sent.
    pub(super) fn commit(&self, checkpoint: &Checkpoint) -> Result<(), StoreError> {
        let bytes = serde_json::to_vec(checkpoint).map_err(StoreError::Encode)?;
        create_private_dir(&self.dir).map_err(StoreError::Write)?;
        write_atomic(&self.dir, CHECKPOINT_FILE, &bytes).map_err(StoreError::Write)
    }
}

#[derive(Debug)]
pub(crate) enum StoreError {
    Read(io::Error),
    Encode(serde_json::Error),
    Write(io::Error),
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read(error) => write!(formatter, "cannot read metering checkpoint: {error}"),
            Self::Encode(error) => write!(formatter, "cannot encode metering checkpoint: {error}"),
            Self::Write(error) => write!(formatter, "cannot write metering checkpoint: {error}"),
        }
    }
}

impl std::error::Error for StoreError {}
