//! Protected, signed promotion of service releases.
//!
//! The unprivileged agent downloads and stages bytes. The root helper verifies
//! a signed manifest against the installer-pinned Ed25519 key, checks the
//! SHA-256 of the staged file, and copies it into a content-addressed,
//! root-owned read-only release tree. Candidate processes never own the helper,
//! the unit files or this trust key; only the operator-controlled installer
//! changes those.

use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::Read as _;
use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};

use ring::signature::{ED25519, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use super::journal::{ArtifactDigest, Generation, GenerationRecord};
use super::ports::ServiceIdentity;
use super::store::JournalStore;

const MANIFEST_DOMAIN: &str = "blossom-release-manifest-v1";
const MANIFEST_SCHEMA: u32 = 1;
const MAX_BINARY_BYTES: u64 = 128 * 1024 * 1024;
const MAX_CONFIG_BYTES: u64 = 8 * 1024 * 1024;
const PUBLIC_KEY_BYTES: usize = 32;
const SIGNATURE_BYTES: usize = 64;

/// The fixed component a release belongs to. A candidate for the agent unit
/// can never be promoted as the sing-box runtime, and vice versa.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ReleaseComponent {
    Agent,
    SingBox,
}

impl ReleaseComponent {
    pub(crate) fn service(self) -> ServiceIdentity {
        match self {
            Self::Agent => ServiceIdentity::Agent,
            Self::SingBox => ServiceIdentity::SingBox,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::SingBox => "sing-box",
        }
    }

    fn file_name(self) -> &'static str {
        match self {
            Self::Agent => "server-agent",
            Self::SingBox => "sing-box",
        }
    }
}

impl fmt::Display for ReleaseComponent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A signed release manifest. The signature covers a fixed, newline-delimited
/// canonical form, not the JSON encoding, so field order cannot change it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SignedReleaseManifest {
    pub(crate) schema: u32,
    pub(crate) component: ReleaseComponent,
    pub(crate) platform: String,
    pub(crate) version: String,
    pub(crate) sha256: ArtifactDigest,
    pub(crate) signature: ReleaseSignature,
}

impl SignedReleaseManifest {
    pub(crate) fn canonical_bytes(&self) -> Vec<u8> {
        format!(
            "{MANIFEST_DOMAIN}\ncomponent={}\nplatform={}\nversion={}\nsha256={}\n",
            self.component, self.platform, self.version, self.sha256
        )
        .into_bytes()
    }

    fn validate(&self) -> Result<(), PromoteError> {
        if self.schema != MANIFEST_SCHEMA {
            return Err(PromoteError::InvalidManifest("unsupported schema"));
        }
        if !matches!(self.platform.as_str(), "linux-amd64" | "linux-arm64") {
            return Err(PromoteError::InvalidManifest("unsupported platform"));
        }
        if self.version.is_empty()
            || self.version.len() > 64
            || !self
                .version
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
        {
            return Err(PromoteError::InvalidManifest("invalid version"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub(crate) struct ReleaseSignature(String);

impl TryFrom<String> for ReleaseSignature {
    type Error = PromoteError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.len() == SIGNATURE_BYTES * 2
            && value
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        {
            Ok(Self(value))
        } else {
            Err(PromoteError::InvalidManifest(
                "signature must be lowercase hex",
            ))
        }
    }
}

impl From<ReleaseSignature> for String {
    fn from(value: ReleaseSignature) -> Self {
        value.0
    }
}

/// The installer-pinned Ed25519 trust root.
pub(crate) struct ReleaseTrust {
    public_key: [u8; PUBLIC_KEY_BYTES],
}

impl fmt::Debug for ReleaseTrust {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ReleaseTrust")
    }
}

impl ReleaseTrust {
    /// Loads a pinned key. The file must be root-owned, regular and writable
    /// only by its owner. The helper retries this on startup only.
    pub(crate) fn load(path: &Path) -> Result<Self, PromoteError> {
        let metadata = fs::symlink_metadata(path).map_err(PromoteError::Io)?;
        if !metadata.file_type().is_file() {
            return Err(PromoteError::InvalidTrustKey("key is not a regular file"));
        }
        if metadata.uid() != 0 {
            return Err(PromoteError::InvalidTrustKey("key is not root-owned"));
        }
        if metadata.permissions().mode() & 0o022 != 0 {
            return Err(PromoteError::InvalidTrustKey(
                "key is writable by group or other",
            ));
        }
        let mut bytes = String::new();
        fs::File::open(path)
            .map_err(PromoteError::Io)?
            .take(1024)
            .read_to_string(&mut bytes)
            .map_err(PromoteError::Io)?;
        Self::from_hex(bytes.trim())
    }

    pub(crate) fn from_hex(value: &str) -> Result<Self, PromoteError> {
        if value.len() != PUBLIC_KEY_BYTES * 2
            || !value
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        {
            return Err(PromoteError::InvalidTrustKey(
                "public key must be 32 bytes of lowercase hex",
            ));
        }
        let mut public_key = [0_u8; PUBLIC_KEY_BYTES];
        hex::decode_to_slice(value, &mut public_key)
            .map_err(|_| PromoteError::InvalidTrustKey("public key is not valid hex"))?;
        Ok(Self { public_key })
    }

    fn verify(&self, manifest: &SignedReleaseManifest) -> Result<(), PromoteError> {
        manifest.validate()?;
        let signature = hex::decode(&manifest.signature.0)
            .map_err(|_| PromoteError::InvalidManifest("signature is not valid hex"))?;
        UnparsedPublicKey::new(&ED25519, self.public_key.as_slice())
            .verify(&manifest.canonical_bytes(), &signature)
            .map_err(|_| PromoteError::SignatureMismatch)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PromoteRequest {
    pub(crate) manifest: SignedReleaseManifest,
    /// Staged binary below the agent state directory.
    pub(crate) binary_source: PathBuf,
    /// Staged config below the agent state directory. Its digest is recorded
    /// with the binary so a generation names one immutable artifact set.
    pub(crate) config_source: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PromotedArtifacts {
    pub(crate) record: GenerationRecord,
    pub(crate) binary_path: PathBuf,
    pub(crate) config_path: PathBuf,
}

/// Fixed, content-addressed release layout. Paths derive from verified
/// digests, never from control-plane input.
#[derive(Debug, Clone)]
pub(crate) struct ReleaseLayout {
    release_dir: PathBuf,
}

impl ReleaseLayout {
    #[must_use]
    pub(crate) fn new(release_dir: impl Into<PathBuf>) -> Self {
        Self {
            release_dir: release_dir.into(),
        }
    }

    pub(crate) fn binary_path(
        &self,
        component: ReleaseComponent,
        digest: &ArtifactDigest,
    ) -> PathBuf {
        self.release_dir
            .join("releases")
            .join(component.as_str())
            .join(digest.to_string())
            .join(component.file_name())
    }

    pub(crate) fn config_path(&self, digest: &ArtifactDigest) -> PathBuf {
        self.release_dir
            .join("releases")
            .join("config")
            .join(digest.to_string())
            .join("config.json")
    }
}

/// Owns the protected release tree for the helper. All writes are serialized
/// by the helper's single request loop.
pub(crate) struct Promoter {
    layout: ReleaseLayout,
    journal_dir: PathBuf,
    agent_state_dir: PathBuf,
    agent_uid: u32,
    runtime_gid: u32,
}

impl Promoter {
    pub(crate) fn new(
        release_dir: impl Into<PathBuf>,
        journal_dir: impl Into<PathBuf>,
        agent_state_dir: impl Into<PathBuf>,
        agent_uid: u32,
        runtime_gid: u32,
    ) -> Self {
        Self {
            layout: ReleaseLayout::new(release_dir),
            journal_dir: journal_dir.into(),
            agent_state_dir: agent_state_dir.into(),
            agent_uid,
            runtime_gid,
        }
    }

    /// Copies a config-only update. Binary updates always use
    /// [`TrustedPromoter::promote`] with a signed manifest.
    pub(crate) fn stage_config(
        &self,
        source: PathBuf,
        digest: ArtifactDigest,
    ) -> Result<ArtifactDigest, PromoteError> {
        let source = self.allowed_source(&source)?;
        let actual = hash_file(&source, MAX_CONFIG_BYTES)?;
        if actual != digest {
            return Err(PromoteError::DigestMismatch("config"));
        }
        self.copy_config(&digest, &source)?;
        Ok(digest)
    }

    /// Installer-only bootstrap: copies root-owned installer artifacts into the
    /// protected release tree and records the first committed generation. The
    /// operator-controlled installer is the only caller. Agent requests must
    /// use the signed [`TrustedPromoter::promote`] path.
    pub(crate) fn bootstrap(
        &self,
        service: ServiceIdentity,
        binary_source: &Path,
        config_source: &Path,
    ) -> Result<PromotedArtifacts, PromoteError> {
        let binary_digest = hash_file(binary_source, MAX_BINARY_BYTES)?;
        let config_digest = hash_file(config_source, MAX_CONFIG_BYTES)?;
        let component = match service {
            ServiceIdentity::Agent => ReleaseComponent::Agent,
            ServiceIdentity::SingBox => ReleaseComponent::SingBox,
        };
        let binary_path = self.copy_binary(component, &binary_digest, binary_source)?;
        let config_path = self.copy_config(&config_digest, config_source)?;
        fs::create_dir_all(&self.journal_dir).map_err(PromoteError::Io)?;
        let store = JournalStore::new(&self.journal_dir, service);
        let mut journal = store
            .load()
            .map_err(|error| PromoteError::Journal(error.to_string()))?;
        let record = GenerationRecord {
            generation: journal.next_generation_for(&binary_digest, &config_digest),
            binary_sha256: binary_digest,
            config_sha256: config_digest,
        };
        journal
            .bootstrap(record.clone())
            .map_err(|error| PromoteError::Journal(error.to_string()))?;
        store
            .persist(&journal)
            .map_err(|error| PromoteError::Journal(error.to_string()))?;
        Ok(PromotedArtifacts {
            record,
            binary_path,
            config_path,
        })
    }

    fn allowed_source(&self, source: &Path) -> Result<PathBuf, PromoteError> {
        let canonical = fs::canonicalize(source).map_err(PromoteError::Io)?;
        let root = fs::canonicalize(&self.agent_state_dir).map_err(PromoteError::Io)?;
        if !canonical.starts_with(&root) {
            return Err(PromoteError::PathNotAllowed);
        }
        let metadata = fs::metadata(&canonical).map_err(PromoteError::Io)?;
        if !metadata.file_type().is_file() {
            return Err(PromoteError::PathNotAllowed);
        }
        if metadata.uid() != self.agent_uid {
            return Err(PromoteError::PathNotAllowed);
        }
        Ok(canonical)
    }

    fn copy_binary(
        &self,
        component: ReleaseComponent,
        digest: &ArtifactDigest,
        source: &Path,
    ) -> Result<PathBuf, PromoteError> {
        let destination = self.layout.binary_path(component, digest);
        if destination.is_file() {
            if hash_file(&destination, MAX_BINARY_BYTES)? != *digest {
                return Err(PromoteError::DigestMismatch("promoted binary"));
            }
            return Ok(destination);
        }
        let parent = destination.parent().ok_or(PromoteError::PathNotAllowed)?;
        fs::create_dir_all(parent).map_err(PromoteError::Io)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o755)).map_err(PromoteError::Io)?;
        let temporary = parent.join(format!(".{}.tmp", std::process::id()));
        let _ = fs::remove_file(&temporary);
        copy_file(source, &temporary, 0o555)?;
        if hash_file(&temporary, MAX_BINARY_BYTES)? != *digest {
            let _ = fs::remove_file(&temporary);
            return Err(PromoteError::DigestMismatch("promoted binary"));
        }
        fs::rename(&temporary, &destination).map_err(PromoteError::Io)?;
        sync_directory(parent)?;
        Ok(destination)
    }

    fn copy_config(&self, digest: &ArtifactDigest, source: &Path) -> Result<PathBuf, PromoteError> {
        let destination = self.layout.config_path(digest);
        if destination.is_file() {
            if hash_file(&destination, MAX_CONFIG_BYTES)? != *digest {
                return Err(PromoteError::DigestMismatch("promoted config"));
            }
            return Ok(destination);
        }
        let parent = destination.parent().ok_or(PromoteError::PathNotAllowed)?;
        fs::create_dir_all(parent).map_err(PromoteError::Io)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o750)).map_err(PromoteError::Io)?;
        let temporary = parent.join(format!(".{}.tmp", std::process::id()));
        let _ = fs::remove_file(&temporary);
        copy_file(source, &temporary, 0o400)?;
        if hash_file(&temporary, MAX_CONFIG_BYTES)? != *digest {
            let _ = fs::remove_file(&temporary);
            return Err(PromoteError::DigestMismatch("promoted config"));
        }
        set_group(&temporary, self.runtime_gid)?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o440))
            .map_err(PromoteError::Io)?;
        fs::rename(&temporary, &destination).map_err(PromoteError::Io)?;
        sync_directory(parent)?;
        Ok(destination)
    }

    fn next_generation(
        &self,
        service: ServiceIdentity,
        binary: &ArtifactDigest,
        config: &ArtifactDigest,
    ) -> Result<Generation, PromoteError> {
        let journal = JournalStore::new(&self.journal_dir, service)
            .load()
            .map_err(|error| PromoteError::Journal(error.to_string()))?;
        Ok(journal.next_generation_for(binary, config))
    }
}

/// A promoter with the installer-pinned trust key attached.
pub(crate) struct TrustedPromoter {
    promoter: Promoter,
    trust: ReleaseTrust,
}

impl TrustedPromoter {
    #[must_use]
    pub(crate) fn new(promoter: Promoter, trust: ReleaseTrust) -> Self {
        Self { promoter, trust }
    }

    pub(crate) fn promote(
        &self,
        service: ServiceIdentity,
        request: PromoteRequest,
    ) -> Result<PromotedArtifacts, PromoteError> {
        if request.manifest.component.service() != service {
            return Err(PromoteError::InvalidManifest(
                "manifest component does not match the service",
            ));
        }
        self.trust.verify(&request.manifest)?;
        let binary_source = self.promoter.allowed_source(&request.binary_source)?;
        let config_source = self.promoter.allowed_source(&request.config_source)?;
        let binary_digest = hash_file(&binary_source, MAX_BINARY_BYTES)?;
        if binary_digest != request.manifest.sha256 {
            return Err(PromoteError::DigestMismatch("binary"));
        }
        let config_digest = hash_file(&config_source, MAX_CONFIG_BYTES)?;
        let binary_path = self.promoter.copy_binary(
            request.manifest.component,
            &binary_digest,
            &binary_source,
        )?;
        let config_path = self.promoter.copy_config(&config_digest, &config_source)?;
        let record = GenerationRecord {
            generation: self
                .promoter
                .next_generation(service, &binary_digest, &config_digest)?,
            binary_sha256: binary_digest,
            config_sha256: config_digest,
        };
        Ok(PromotedArtifacts {
            record,
            binary_path,
            config_path,
        })
    }

    pub(crate) fn stage_config(
        &self,
        source: PathBuf,
        digest: ArtifactDigest,
    ) -> Result<ArtifactDigest, PromoteError> {
        self.promoter.stage_config(source, digest)
    }
}

fn hash_file(path: &Path, max_bytes: u64) -> Result<ArtifactDigest, PromoteError> {
    let metadata = fs::metadata(path).map_err(PromoteError::Io)?;
    if metadata.len() > max_bytes {
        return Err(PromoteError::TooLarge);
    }
    let mut file = fs::File::open(path).map_err(PromoteError::Io)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut read = 0_u64;
    loop {
        let count = file.read(&mut buffer).map_err(PromoteError::Io)?;
        if count == 0 {
            break;
        }
        read += count as u64;
        if read > max_bytes {
            return Err(PromoteError::TooLarge);
        }
        hasher.update(&buffer[..count]);
    }
    ArtifactDigest::try_from(hex::encode(hasher.finalize()))
        .map_err(|_| PromoteError::DigestMismatch("artifact"))
}

fn copy_file(source: &Path, destination: &Path, mode: u32) -> Result<(), PromoteError> {
    let mut input = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(source)
        .map_err(PromoteError::Io)?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .custom_flags(libc::O_NOFOLLOW)
        .open(destination)
        .map_err(PromoteError::Io)?;
    std::io::copy(&mut input, &mut output).map_err(PromoteError::Io)?;
    output.sync_all().map_err(PromoteError::Io)
}

fn sync_directory(path: &Path) -> Result<(), PromoteError> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(PromoteError::Io)
}

fn set_group(path: &Path, gid: u32) -> Result<(), PromoteError> {
    let path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| PromoteError::PathNotAllowed)?;
    // SAFETY: `path` is a valid NUL-terminated path and the helper owns the
    // protected release tree; failure is reported rather than ignored.
    let result = unsafe { libc::chown(path.as_ptr(), u32::MAX, gid) };
    if result == 0 {
        Ok(())
    } else {
        Err(PromoteError::Io(std::io::Error::last_os_error()))
    }
}

#[derive(Debug)]
pub(crate) enum PromoteError {
    InvalidManifest(&'static str),
    InvalidTrustKey(&'static str),
    SignatureMismatch,
    DigestMismatch(&'static str),
    PathNotAllowed,
    TooLarge,
    Journal(String),
    Io(std::io::Error),
}

impl fmt::Display for PromoteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidManifest(message) => {
                write!(formatter, "invalid release manifest: {message}")
            }
            Self::InvalidTrustKey(message) => {
                write!(formatter, "invalid release trust key: {message}")
            }
            Self::SignatureMismatch => formatter.write_str("release manifest signature mismatch"),
            Self::DigestMismatch(artifact) => write!(formatter, "{artifact} digest mismatch"),
            Self::PathNotAllowed => formatter.write_str("staged artifact path is not allowed"),
            Self::TooLarge => formatter.write_str("staged artifact exceeds the size bound"),
            Self::Journal(message) => write!(formatter, "deployment journal error: {message}"),
            Self::Io(error) => write!(formatter, "release promotion I/O error: {error}"),
        }
    }
}

impl std::error::Error for PromoteError {}

#[cfg(test)]
mod tests {
    use super::*;

    const PUBLIC_KEY: &str = "4127fa23da180825db362cb6d52d709245a8b8bbbd16beece34534496dddeeab";
    const SIGNATURE_ZERO: &str = "818999d83b5bfdce573c01abb025c43a3635c3ab3e5b780c6c53223251d193d8f5d061c64738ec3e3b36e18bd54815082182e57dff67ac1af90b91bfd3695b06";
    const SIGNATURE_CANDIDATE: &str = "c6a03acc997429c0a6ca35ad197949985c6778b4fc9d524f763319c840255cd355f99d9464d39767df7d9732bb491ab1bb5b1341a8fbfd4b0503b1f2f5557802";
    const SHA256_ONE: &str = "0000000000000000000000000000000000000000000000000000000000000001";
    const SHA256_CANDIDATE: &str =
        "fe0de257b7d934ddcf889d120f7b648a593ae5727a747019da1c9128ac4fe636";

    fn manifest(digest: &str, signature: &str) -> SignedReleaseManifest {
        SignedReleaseManifest {
            schema: 1,
            component: ReleaseComponent::SingBox,
            platform: "linux-amd64".to_string(),
            version: "1.14.4".to_string(),
            sha256: ArtifactDigest::try_from(digest.to_string()).unwrap(),
            signature: ReleaseSignature::try_from(signature.to_string()).unwrap(),
        }
    }

    fn fixture_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "blossom-promote-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn trust() -> ReleaseTrust {
        ReleaseTrust::from_hex(PUBLIC_KEY).unwrap()
    }

    #[test]
    fn signatures_cover_the_fixed_canonical_manifest() {
        let manifest = manifest(SHA256_ONE, SIGNATURE_ZERO);
        trust().verify(&manifest).unwrap();

        let mut changed = manifest.clone();
        changed.version = "1.14.5".to_string();
        assert!(matches!(
            trust().verify(&changed),
            Err(PromoteError::SignatureMismatch)
        ));
        let mut changed = manifest;
        changed.platform = "linux-arm64".to_string();
        assert!(matches!(
            trust().verify(&changed),
            Err(PromoteError::SignatureMismatch)
        ));
    }

    #[test]
    fn invalid_manifests_and_keys_are_refused() {
        let mut wrong_schema = manifest(SHA256_ONE, SIGNATURE_ZERO);
        wrong_schema.schema = 2;
        assert!(matches!(
            trust().verify(&wrong_schema),
            Err(PromoteError::InvalidManifest(_))
        ));
        let mut wrong_component = manifest(SHA256_ONE, SIGNATURE_ZERO);
        wrong_component.component = ReleaseComponent::Agent;
        assert!(matches!(
            trust().verify(&wrong_component),
            Err(PromoteError::SignatureMismatch)
        ));
        assert!(matches!(
            ReleaseTrust::from_hex("not-hex"),
            Err(PromoteError::InvalidTrustKey(_))
        ));
    }

    #[test]
    fn a_signed_candidate_is_promoted_and_gets_the_next_generation() {
        let root = fixture_dir("promote");
        let state = root.join("state");
        fs::create_dir_all(&state).unwrap();
        let binary_source = state.join("sing-box.candidate");
        let config_source = state.join("config.candidate.json");
        fs::write(&binary_source, b"candidate binary").unwrap();
        fs::write(&config_source, b"{\"log\":{}}").unwrap();
        assert_eq!(
            hash_file(&binary_source, MAX_BINARY_BYTES)
                .unwrap()
                .to_string(),
            SHA256_CANDIDATE
        );
        let promoter = TrustedPromoter::new(
            Promoter::new(
                root.join("releases"),
                root.join("journal"),
                &state,
                unsafe { libc::geteuid() },
                unsafe { libc::getegid() },
            ),
            trust(),
        );
        let promoted = promoter
            .promote(
                ServiceIdentity::SingBox,
                PromoteRequest {
                    manifest: manifest(SHA256_CANDIDATE, SIGNATURE_CANDIDATE),
                    binary_source,
                    config_source,
                },
            )
            .unwrap();
        assert_eq!(promoted.record.generation, Generation(1));
        assert_eq!(promoted.record.binary_sha256.to_string(), SHA256_CANDIDATE);
        assert_eq!(
            fs::read(&promoted.binary_path).unwrap(),
            b"candidate binary"
        );
        assert_eq!(
            fs::metadata(&promoted.binary_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o555
        );
        assert_eq!(
            fs::metadata(&promoted.config_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o440
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn installer_bootstrap_commits_the_first_generation() {
        let root = fixture_dir("bootstrap");
        let binary = root.join("server-agent");
        let config = root.join("installation.json");
        fs::write(&binary, b"installer agent").unwrap();
        fs::write(&config, b"server_id=test\n").unwrap();
        let promoter = Promoter::new(
            root.join("releases"),
            root.join("journal"),
            &root,
            0,
            unsafe { libc::getegid() },
        );
        let artifacts = promoter
            .bootstrap(ServiceIdentity::Agent, &binary, &config)
            .unwrap();
        assert_eq!(artifacts.record.generation, Generation(1));
        let journal = JournalStore::new(&root.join("journal"), ServiceIdentity::Agent)
            .load()
            .unwrap();
        assert_eq!(journal.committed(), Some(&artifacts.record));
        assert_eq!(
            fs::metadata(&artifacts.binary_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o555
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn promotion_refuses_unsigned_digests_and_sources_outside_state() {
        let root = fixture_dir("refuse");
        let state = root.join("state");
        let outside = root.join("outside");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let binary = state.join("binary");
        let config = state.join("config");
        fs::write(&binary, b"candidate binary").unwrap();
        fs::write(&config, b"{}").unwrap();
        fs::write(outside.join("config"), b"x").unwrap();
        let promoter = TrustedPromoter::new(
            Promoter::new(
                root.join("releases"),
                root.join("journal"),
                &state,
                unsafe { libc::geteuid() },
                unsafe { libc::getegid() },
            ),
            trust(),
        );
        assert!(matches!(
            promoter.promote(
                ServiceIdentity::SingBox,
                PromoteRequest {
                    manifest: manifest(SHA256_CANDIDATE, SIGNATURE_CANDIDATE),
                    binary_source: binary,
                    config_source: outside.join("config"),
                }
            ),
            Err(PromoteError::PathNotAllowed)
        ));
        assert!(matches!(
            promoter.stage_config(
                outside.join("config"),
                ArtifactDigest::try_from(SHA256_ONE.to_string()).unwrap()
            ),
            Err(PromoteError::PathNotAllowed)
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn config_only_staging_is_content_addressed() {
        let root = fixture_dir("config");
        let state = root.join("state");
        fs::create_dir_all(&state).unwrap();
        let config = state.join("config");
        fs::write(&config, b"{\"log\":{}}").unwrap();
        let digest = hash_file(&config, MAX_CONFIG_BYTES).unwrap();
        let promoter = Promoter::new(
            root.join("releases"),
            root.join("journal"),
            &state,
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() },
        );
        assert_eq!(
            promoter
                .stage_config(config.clone(), digest.clone())
                .unwrap(),
            digest
        );
        assert!(matches!(
            promoter.stage_config(
                config,
                ArtifactDigest::try_from(SHA256_ONE.to_string()).unwrap()
            ),
            Err(PromoteError::DigestMismatch("config"))
        ));
        let _ = fs::remove_dir_all(root);
    }
}
