//! One-time import of the legacy `<state_dir>/traffic/pending` queue.
//!
//! Batches keep their existing report id and bytes. They are not sealed again,
//! and files are removed only after a checkpoint commit makes them durable in
//! the meter. A crash before the commit leaves them in place for the next
//! attempt; a crash after it leaves them to be deduplicated by the import
//! tombstones in the checkpoint.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};

use super::meter::{ImportError, ImportSummary, RuntimeMeter};
use crate::traffic::{Batch, create_private_dir, read_batch};

const MAX_REJECTED_KEPT: usize = 16;

pub(crate) struct LegacyImport {
    batches: Vec<Batch>,
    files: Vec<PathBuf>,
    pub(crate) expired: usize,
    pub(crate) rejected: usize,
    absorbed: bool,
}

impl LegacyImport {
    pub(crate) fn scan(
        root: &Path,
        now: DateTime<Utc>,
        retention: Duration,
    ) -> Result<Self, io::Error> {
        let pending = root.join("pending");
        let read = match fs::read_dir(&pending) {
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(Self {
                    batches: Vec::new(),
                    files: Vec::new(),
                    expired: 0,
                    rejected: 0,
                    absorbed: false,
                });
            }
            Err(error) => return Err(error),
        };
        let mut paths: Vec<PathBuf> = read.filter_map(|entry| Some(entry.ok()?.path())).collect();
        paths.sort();
        let mut batches = Vec::new();
        let mut files = Vec::new();
        let mut expired = 0;
        let mut rejected = 0;
        for path in paths {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            if name.ends_with(".tmp") {
                // An interrupted legacy write; the batch was never enqueued.
                let _ = fs::remove_file(&path);
                continue;
            }
            if !name.ends_with(".json") {
                continue;
            }
            match read_batch(&path) {
                Ok(batch) if now - batch.window_ended_at > retention => {
                    expired += 1;
                    let _ = fs::remove_file(&path);
                }
                Ok(batch) => {
                    batches.push(batch);
                    files.push(path);
                }
                Err(_) => {
                    rejected += 1;
                    quarantine(root, &path, name);
                }
            }
        }
        Ok(Self {
            batches,
            files,
            expired,
            rejected,
            absorbed: false,
        })
    }

    /// Merges the scanned batches into the meter. A conflicting id or a full
    /// outbox leaves the files in place and fails closed.
    pub(crate) fn absorb(
        &mut self,
        meter: &mut RuntimeMeter,
    ) -> Result<ImportSummary, ImportError> {
        let summary = meter.import_batches(&self.batches)?;
        self.absorbed = true;
        Ok(summary)
    }

    /// Removes the legacy files after the imported batches became durable.
    pub(crate) fn finish(self) {
        if !self.absorbed {
            return;
        }
        for path in self.files {
            let _ = fs::remove_file(path);
        }
    }

    pub(crate) fn batch_count(&self) -> usize {
        self.batches.len()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.batches.is_empty()
    }
}

fn quarantine(root: &Path, path: &Path, name: &str) {
    let rejected = root.join("rejected");
    if create_private_dir(root)
        .and_then(|()| create_private_dir(&rejected))
        .and_then(|()| fs::rename(path, rejected.join(name)))
        .is_err()
    {
        let _ = fs::remove_file(path);
    }
    if let Ok(read) = fs::read_dir(&rejected) {
        let mut kept: Vec<PathBuf> = read.filter_map(|entry| Some(entry.ok()?.path())).collect();
        kept.sort();
        while kept.len() > MAX_REJECTED_KEPT {
            let _ = fs::remove_file(kept.remove(0));
        }
    }
}
