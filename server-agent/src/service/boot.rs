//! Boot selection and the fixed launcher used by the installed units.
//!
//! `boot-select` runs from a privileged `ExecStartPre=+` step, consumes a
//! one-shot trial if present, and writes exactly one root-owned selection for
//! the upcoming invocation. `boot-exec` runs under the unit's `User=` and
//! executes only the immutable artifacts named by that file. Disabled and
//! unprovisioned installations exit with dedicated statuses so systemd does
//! not retry them.

use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{Read as _, Write as _};
use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use super::journal::{ArtifactDigest, BootSelection, GenerationRecord};
use super::lifecycle::select_boot;
use super::ports::{InvocationId, ServiceIdentity};
use super::promote::{ReleaseComponent, ReleaseLayout};
use super::store::JournalStore;

/// Exit status for a disabled installation, listed in
/// `RestartPreventExitStatus=` by the installer.
pub(crate) const BOOT_DISABLED_EXIT: i32 = 77;
/// Exit status for an installation with no committed generation.
pub(crate) const BOOT_UNPROVISIONED_EXIT: i32 = 78;
/// Exit status for a selection that cannot be trusted or verified.
pub(crate) const BOOT_INVALID_EXIT: i32 = 79;

const SELECTION_SCHEMA: u32 = 1;
const MAX_SELECTION_BYTES: u64 = 4096;

/// The exact artifact set one invocation may execute.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BootSelectionFile {
    pub(crate) schema: u32,
    pub(crate) service: ServiceIdentity,
    pub(crate) record: GenerationRecord,
}

impl BootSelectionFile {
    fn from_selection(service: ServiceIdentity, selection: BootSelection) -> Option<Self> {
        match selection {
            BootSelection::Candidate(record) | BootSelection::Committed(record) => Some(Self {
                schema: SELECTION_SCHEMA,
                service,
                record,
            }),
            BootSelection::Disabled | BootSelection::Unprovisioned => None,
        }
    }
}

/// The result of the privileged boot-select step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BootDecision {
    Selected(BootSelectionFile),
    Disabled,
    Unprovisioned,
}

impl BootDecision {
    pub(crate) fn exit_code(&self) -> Option<i32> {
        match self {
            Self::Selected(_) => None,
            Self::Disabled => Some(BOOT_DISABLED_EXIT),
            Self::Unprovisioned => Some(BOOT_UNPROVISIONED_EXIT),
        }
    }
}

/// Path of the per-service selection below the fixed `/run` directory.
pub(crate) fn selection_path(dir: &Path, service: ServiceIdentity) -> PathBuf {
    dir.join(format!("{service}.boot.json"))
}

/// Consumes a boot decision and writes the next invocation's selection. A
/// disabled or unprovisioned decision removes any stale file so a later
/// launcher can never reuse an older generation.
pub(crate) fn select_and_write(
    store: &JournalStore,
    service: ServiceIdentity,
    invocation: InvocationId,
    now: DateTime<Utc>,
    selection_dir: &Path,
) -> Result<BootDecision, BootError> {
    let selection = select_boot(store, invocation, now)?;
    let decision = match selection {
        BootSelection::Disabled => BootDecision::Disabled,
        BootSelection::Unprovisioned => BootDecision::Unprovisioned,
        candidate @ (BootSelection::Candidate(_) | BootSelection::Committed(_)) => {
            let file = BootSelectionFile::from_selection(service, candidate)
                .ok_or(BootError::Invalid("boot decision"))?;
            write_selection(&selection_path(selection_dir, service), &file)?;
            BootDecision::Selected(file)
        }
    };
    if !matches!(decision, BootDecision::Selected(_)) {
        let _ = fs::remove_file(selection_path(selection_dir, service));
    }
    Ok(decision)
}

fn write_selection(path: &Path, selection: &BootSelectionFile) -> Result<(), BootError> {
    let parent = path.parent().ok_or(BootError::Invalid("selection path"))?;
    fs::create_dir_all(parent).map_err(BootError::Io)?;
    fs::set_permissions(parent, fs::Permissions::from_mode(0o755)).map_err(BootError::Io)?;
    let bytes = serde_json::to_vec(selection).map_err(BootError::Encode)?;
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let _ = fs::remove_file(&temporary);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true).mode(0o644);
    let mut file = options.open(&temporary).map_err(BootError::Io)?;
    file.write_all(&bytes).map_err(BootError::Io)?;
    file.sync_all().map_err(BootError::Io)?;
    fs::rename(&temporary, path).map_err(BootError::Io)?;
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(BootError::Io)
}

/// Reads a selection created by the root boot-select step. Ownership and
/// permission metadata are checked before decoding; a non-root or writable
/// file is refused.
pub(crate) fn read_selection(path: &Path) -> Result<BootSelectionFile, BootError> {
    read_selection_as(path, 0)
}

fn read_selection_as(path: &Path, expected_uid: u32) -> Result<BootSelectionFile, BootError> {
    let metadata = fs::metadata(path).map_err(BootError::Io)?;
    if !metadata.file_type().is_file()
        || metadata.uid() != expected_uid
        || metadata.permissions().mode() & 0o022 != 0
        || metadata.len() > MAX_SELECTION_BYTES
    {
        return Err(BootError::InvalidSelection);
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(BootError::Io)?
        .take(MAX_SELECTION_BYTES)
        .read_to_end(&mut bytes)
        .map_err(BootError::Io)?;
    let selection: BootSelectionFile = serde_json::from_slice(&bytes).map_err(BootError::Decode)?;
    if selection.schema != SELECTION_SCHEMA {
        return Err(BootError::Invalid("selection schema"));
    }
    Ok(selection)
}

/// Resolves the immutable artifacts for a service and verifies their content
/// before the launcher replaces the process image.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Launch {
    pub(crate) binary: PathBuf,
    pub(crate) config: PathBuf,
}

pub(crate) fn resolve_launch(
    layout: &ReleaseLayout,
    service: ServiceIdentity,
    selection: &BootSelectionFile,
) -> Result<Launch, BootError> {
    resolve_launch_owned(layout, service, selection, 0)
}

fn resolve_launch_owned(
    layout: &ReleaseLayout,
    service: ServiceIdentity,
    selection: &BootSelectionFile,
    expected_uid: u32,
) -> Result<Launch, BootError> {
    if selection.service != service {
        return Err(BootError::Invalid("selection service"));
    }
    let component = match service {
        ServiceIdentity::Agent => ReleaseComponent::Agent,
        ServiceIdentity::SingBox => ReleaseComponent::SingBox,
    };
    let binary = layout.binary_path(component, &selection.record.binary_sha256);
    let config = layout.config_path(&selection.record.config_sha256);
    verify_file(&binary, &selection.record.binary_sha256, expected_uid)?;
    // The agent launcher takes its flags from the unit, so its config artifact
    // is metadata only and may be runtime-group scoped. The sing-box launcher
    // reads the config and must verify it under the same ownership rule.
    if service == ServiceIdentity::SingBox {
        verify_file(&config, &selection.record.config_sha256, expected_uid)?;
    }
    Ok(Launch { binary, config })
}

fn verify_file(path: &Path, digest: &ArtifactDigest, expected_uid: u32) -> Result<(), BootError> {
    let metadata = fs::symlink_metadata(path).map_err(BootError::Io)?;
    if !metadata.file_type().is_file() || metadata.uid() != expected_uid {
        return Err(BootError::Invalid("release artifact ownership"));
    }
    let mut file = fs::File::open(path).map_err(BootError::Io)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(BootError::Io)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    let actual = ArtifactDigest::try_from(hex::encode(hasher.finalize()))
        .map_err(|_| BootError::Invalid("release digest"))?;
    if actual != *digest {
        return Err(BootError::DigestMismatch);
    }
    Ok(())
}

/// Builds the exact command for a selected generation. The caller replaces the
/// process image with [`std::os::unix::process::CommandExt::exec`] in
/// production; tests inspect the command instead.
pub(crate) fn launch_command(
    service: ServiceIdentity,
    launch: &Launch,
    extra_args: &[String],
) -> std::process::Command {
    let mut command = std::process::Command::new(&launch.binary);
    match service {
        ServiceIdentity::Agent => {
            command.args(extra_args);
        }
        ServiceIdentity::SingBox => {
            command.arg("run").arg("-c").arg(&launch.config);
            command.args(extra_args);
        }
    }
    command
}

/// Parses `$INVOCATION_ID` exactly as systemd exports it.
pub(crate) fn invocation_from_env(value: Option<&str>) -> Result<InvocationId, BootError> {
    let value = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(BootError::Invalid("INVOCATION_ID"))?;
    Ok(InvocationId::Systemd {
        id: super::ports::SystemdInvocation::try_from(value.to_ascii_lowercase())
            .map_err(|_| BootError::Invalid("INVOCATION_ID"))?,
    })
}

#[derive(Debug)]
pub(crate) enum BootError {
    Store(super::store::StoreError),
    Io(std::io::Error),
    Encode(serde_json::Error),
    Decode(serde_json::Error),
    Invalid(&'static str),
    InvalidSelection,
    DigestMismatch,
}

impl From<super::store::StoreError> for BootError {
    fn from(error: super::store::StoreError) -> Self {
        Self::Store(error)
    }
}

impl fmt::Display for BootError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Store(error) => error.fmt(formatter),
            Self::Io(error) => write!(formatter, "boot selector I/O error: {error}"),
            Self::Encode(error) => write!(formatter, "cannot encode boot selection: {error}"),
            Self::Decode(error) => write!(formatter, "cannot decode boot selection: {error}"),
            Self::Invalid(field) => write!(formatter, "invalid {field}"),
            Self::InvalidSelection => formatter.write_str("boot selection file is not trusted"),
            Self::DigestMismatch => formatter.write_str("release artifact digest mismatch"),
        }
    }
}

impl std::error::Error for BootError {}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use chrono::Duration;

    use super::*;
    use crate::service::journal::Generation;
    use crate::service::journal::fixtures::{at, invocation, record};
    use crate::service::store::test_dir;

    static NEXT: AtomicU64 = AtomicU64::new(1);

    fn fixture_dir(name: &str) -> PathBuf {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        test_dir(&format!("boot-{name}-{id}"))
    }

    #[test]
    fn disabled_and_unprovisioned_decisions_have_dedicated_statuses() {
        assert_eq!(BootDecision::Disabled.exit_code(), Some(BOOT_DISABLED_EXIT));
        assert_eq!(
            BootDecision::Unprovisioned.exit_code(),
            Some(BOOT_UNPROVISIONED_EXIT)
        );
        let selected = BootDecision::Selected(BootSelectionFile {
            schema: SELECTION_SCHEMA,
            service: ServiceIdentity::SingBox,
            record: record(1),
        });
        assert_eq!(selected.exit_code(), None);
    }

    #[test]
    fn selection_files_round_trip_only_for_the_expected_owner() {
        let dir = fixture_dir("selection");
        let path = selection_path(&dir, ServiceIdentity::SingBox);
        let file = BootSelectionFile {
            schema: SELECTION_SCHEMA,
            service: ServiceIdentity::SingBox,
            record: record(1),
        };
        write_selection(&path, &file).unwrap();
        let uid = fs::metadata(&path).unwrap().uid();
        assert_eq!(read_selection_as(&path, uid).unwrap(), file);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o644
        );
        assert!(matches!(
            read_selection_as(&path, uid.wrapping_add(1)),
            Err(BootError::InvalidSelection)
        ));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();
        assert!(matches!(
            read_selection_as(&path, uid),
            Err(BootError::InvalidSelection)
        ));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_trial_is_consumed_and_written_before_the_candidate_runs() {
        let dir = fixture_dir("trial");
        let store = JournalStore::new(&dir, ServiceIdentity::SingBox);
        let mut journal = store.load().unwrap();
        journal
            .authorize_trial(record(1), Duration::seconds(30))
            .unwrap();
        store.persist(&journal).unwrap();
        let selections = dir.join("run");
        let decision = select_and_write(
            &store,
            ServiceIdentity::SingBox,
            invocation(1),
            at(0),
            &selections,
        )
        .unwrap();
        let BootDecision::Selected(selected) = decision else {
            panic!("expected a candidate selection");
        };
        assert_eq!(selected.record, record(1));
        assert_eq!(
            read_selection_as(
                &selection_path(&selections, ServiceIdentity::SingBox),
                fs::metadata(selection_path(&selections, ServiceIdentity::SingBox))
                    .unwrap()
                    .uid()
            )
            .unwrap(),
            selected
        );
        let journal = store.load().unwrap();
        assert!(matches!(
            journal.trial().unwrap().phase,
            crate::service::journal::TrialPhase::Probation { .. }
        ));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn disabled_decision_removes_a_stale_selection() {
        let dir = fixture_dir("disabled");
        let store = JournalStore::new(&dir, ServiceIdentity::SingBox);
        let selections = dir.join("run");
        let path = selection_path(&selections, ServiceIdentity::SingBox);
        write_selection(
            &path,
            &BootSelectionFile {
                schema: SELECTION_SCHEMA,
                service: ServiceIdentity::SingBox,
                record: record(1),
            },
        )
        .unwrap();
        let mut journal = store.load().unwrap();
        journal.disable();
        store.persist(&journal).unwrap();
        assert_eq!(
            select_and_write(
                &store,
                ServiceIdentity::SingBox,
                invocation(2),
                at(1),
                &selections
            )
            .unwrap(),
            BootDecision::Disabled
        );
        assert!(!path.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn launch_resolution_verifies_the_exact_generation() {
        let dir = fixture_dir("launch");
        let layout = ReleaseLayout::new(&dir);
        let binary_bytes = b"runtime";
        let config_bytes = b"{}";
        let binary_digest =
            ArtifactDigest::try_from(hex::encode(Sha256::digest(binary_bytes))).unwrap();
        let config_digest =
            ArtifactDigest::try_from(hex::encode(Sha256::digest(config_bytes))).unwrap();
        let binary = layout.binary_path(ReleaseComponent::SingBox, &binary_digest);
        let config = layout.config_path(&config_digest);
        fs::create_dir_all(binary.parent().unwrap()).unwrap();
        fs::create_dir_all(config.parent().unwrap()).unwrap();
        fs::write(&binary, binary_bytes).unwrap();
        fs::write(&config, config_bytes).unwrap();
        let selection = BootSelectionFile {
            schema: SELECTION_SCHEMA,
            service: ServiceIdentity::SingBox,
            record: GenerationRecord {
                generation: Generation(7),
                binary_sha256: binary_digest,
                config_sha256: config_digest,
            },
        };
        // Test files are owned by the test user; production verification also
        // requires root ownership.
        let uid = fs::metadata(&binary).unwrap().uid();
        assert_ne!(uid, 0);
        let uid = fs::metadata(&binary).unwrap().uid();
        let launch =
            resolve_launch_owned(&layout, ServiceIdentity::SingBox, &selection, uid).unwrap();
        assert_eq!(launch.binary, binary);
        assert_eq!(launch.config, config);
        fs::write(&binary, b"tampered").unwrap();
        assert!(matches!(
            resolve_launch_owned(&layout, ServiceIdentity::SingBox, &selection, uid),
            Err(BootError::DigestMismatch)
        ));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn invocation_environment_is_strict() {
        assert!(matches!(
            invocation_from_env(None),
            Err(BootError::Invalid("INVOCATION_ID"))
        ));
        assert!(matches!(
            invocation_from_env(Some("not-hex")),
            Err(BootError::Invalid("INVOCATION_ID"))
        ));
        assert!(invocation_from_env(Some("0123456789abcdef0123456789abcdef")).is_ok());
    }
}
