//! Validated, generation-addressed certificate store for the V3 desired-state
//! contract.
//!
//! Material lives exclusively under
//! `<state_dir>/certificates/<certificateId>/generation-<generation>/`. The
//! store validates every artifact before it is staged (PEM chain, private key,
//! key-pair match, SAN domains, validity, advertised fingerprint), normalizes
//! line endings so the historical `failed to find any PEM data` regression
//! cannot recur, and writes files with 0600/0700 permissions using atomic
//! temp+rename. Generations are never garbage collected: a generation may stay
//! referenced by the active or last-known-good config, so removal is the
//! control plane's business, not the agent's.

use std::fs::OpenOptions;
use std::io::{BufReader, Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, Utc};
use rustls::pki_types::CertificateDer;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tracing::info;
use x509_parser::{extensions::GeneralName, parse_x509_certificate};

use crate::client::types;

/// Legacy control-plane layout the agent must never trust for runtime paths.
pub const CONTROL_PLANE_CERTIFICATE_ROOT: &str = "/var/lib/blossom-agent/certificates";
/// TLS fields that carried inline material in the V2 config and caused sing-box
/// to reject otherwise-valid managed certificate paths.
pub const MANAGED_TLS_INLINE_FIELDS: [&str; 4] =
    ["certificate", "key", "acme", "certificate_provider"];
pub const MANAGED_TLS_MATERIAL_FIELDS: [&str; 6] = [
    "certificate",
    "certificate_path",
    "key",
    "key_path",
    "acme",
    "certificate_provider",
];
pub const GENERATION_DIR_PREFIX: &str = "generation-";
pub const FULLCHAIN_FILE: &str = "fullchain.pem";
pub const PRIVATE_KEY_FILE: &str = "private-key.pem";

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CertificateRef {
    pub certificate_id: String,
    pub generation: u64,
}

#[derive(Debug, Clone)]
pub struct StagedMaterial {
    pub certificate_id: String,
    pub generation: u64,
    pub fingerprint_sha256: String,
}

pub struct CertificateManager {
    root: PathBuf,
}

impl CertificateManager {
    pub fn new(state_dir: &Path) -> Result<Self> {
        let root = state_dir.join("certificates");
        std::fs::create_dir_all(&root)
            .with_context(|| format!("failed to create {}", root.display()))?;
        set_directory_permissions(&root)?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn generation_dir(&self, certificate_id: &str, generation: u64) -> PathBuf {
        self.root
            .join(certificate_id)
            .join(format!("{GENERATION_DIR_PREFIX}{generation}"))
    }

    pub fn material_paths(&self, certificate: &CertificateRef) -> Result<(PathBuf, PathBuf)> {
        let dir = self.generation_dir(&certificate.certificate_id, certificate.generation);
        Ok((dir.join(FULLCHAIN_FILE), dir.join(PRIVATE_KEY_FILE)))
    }

    /// Validates the artifact and stages it under the exact generation
    /// directory. Idempotent: identical validated material is not rewritten.
    pub fn stage(
        &self,
        artifact: &types::GetAgentConfigV3ResponseCertificateArtifactsItem,
    ) -> Result<StagedMaterial> {
        let certificate_id = artifact.certificate_id.to_string();
        validate_certificate_id(&certificate_id)?;
        let generation = artifact.generation.get();
        let domains = artifact
            .domains
            .iter()
            .map(|domain| domain.to_string())
            .collect::<Vec<_>>();
        let (certificate_pem, private_key_pem, fingerprint_sha256) = validate_material(
            &artifact.certificate_pem,
            &artifact.private_key_pem,
            &domains,
            Some(&artifact.fingerprint_sha256),
        )?;

        let not_before = parse_rfc3339(&artifact.not_before)
            .with_context(|| format!("invalid advertised notBefore {}", artifact.not_before))?;
        let not_after = parse_rfc3339(&artifact.not_after)
            .with_context(|| format!("invalid advertised notAfter {}", artifact.not_after))?;
        let now = Utc::now();
        if now < not_before {
            bail!("advertised certificate validity has not started");
        }
        if now >= not_after {
            bail!("advertised certificate validity has expired");
        }

        let dir = self.generation_dir(&certificate_id, generation);
        if installed_material_matches(&dir, &certificate_pem, &private_key_pem) {
            set_directory_permissions(&dir)?;
            set_file_permissions(&dir.join(FULLCHAIN_FILE))?;
            set_file_permissions(&dir.join(PRIVATE_KEY_FILE))?;
        } else {
            // A generation is an immutable content address. Reusing it for a
            // different valid key pair could silently change what an LKG
            // config loads after restart. Corrupt/partial directories may be
            // repaired, but valid material must receive a new generation.
            if dir.exists()
                && let (Ok(existing_certificate), Ok(existing_key)) = (
                    std::fs::read_to_string(dir.join(FULLCHAIN_FILE)),
                    std::fs::read_to_string(dir.join(PRIVATE_KEY_FILE)),
                )
                && validate_material(&existing_certificate, &existing_key, &[], None).is_ok()
            {
                bail!(
                    "certificate {certificate_id} generation {generation} already contains different valid material"
                );
            }
            self.stage_generation_directory(
                &certificate_id,
                generation,
                &certificate_pem,
                &private_key_pem,
            )?;
            info!(
                certificate_id = %certificate_id,
                generation = generation,
                fingerprint_sha256 = %fingerprint_sha256,
                "certificate material staged"
            );
        }

        Ok(StagedMaterial {
            certificate_id,
            generation,
            fingerprint_sha256,
        })
    }

    fn stage_generation_directory(
        &self,
        certificate_id: &str,
        generation: u64,
        certificate_pem: &str,
        private_key_pem: &str,
    ) -> Result<()> {
        let certificate_dir = self.root.join(certificate_id);
        std::fs::create_dir_all(&certificate_dir)
            .with_context(|| format!("failed to create {}", certificate_dir.display()))?;
        set_directory_permissions(&certificate_dir)?;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let staging = certificate_dir.join(format!(
            ".{GENERATION_DIR_PREFIX}{generation}.staging-{}-{nonce}",
            std::process::id()
        ));
        let backup = certificate_dir.join(format!(
            ".{GENERATION_DIR_PREFIX}{generation}.backup-{}-{nonce}",
            std::process::id()
        ));
        let destination = self.generation_dir(certificate_id, generation);

        std::fs::create_dir(&staging)
            .with_context(|| format!("failed to create {}", staging.display()))?;
        set_directory_permissions(&staging)?;
        let stage_result = (|| -> Result<()> {
            write_secret_file(&staging.join(FULLCHAIN_FILE), certificate_pem.as_bytes())?;
            write_secret_file(&staging.join(PRIVATE_KEY_FILE), private_key_pem.as_bytes())?;
            let staged_fullchain = std::fs::read_to_string(staging.join(FULLCHAIN_FILE))?;
            let staged_key = std::fs::read_to_string(staging.join(PRIVATE_KEY_FILE))?;
            validate_material(&staged_fullchain, &staged_key, &[], None)
                .context("staged certificate material failed round-trip validation")?;

            let had_destination = destination.exists();
            if had_destination {
                std::fs::rename(&destination, &backup).with_context(|| {
                    format!("failed to preserve existing {}", destination.display())
                })?;
            }
            if let Err(error) = std::fs::rename(&staging, &destination) {
                if had_destination {
                    let _ = std::fs::rename(&backup, &destination);
                }
                return Err(error).with_context(|| {
                    format!("failed to install staged {}", destination.display())
                });
            }
            if had_destination {
                std::fs::remove_dir_all(&backup)
                    .with_context(|| format!("failed to remove replaced {}", backup.display()))?;
            }
            Ok(())
        })();
        if staging.exists() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        stage_result
    }

    /// Re-validates the on-disk material for a generation. When an advertised
    /// fingerprint is provided it must still match the material; this is what
    /// the startup and equal-revision skip checks rely on.
    pub fn validate_generation_on_disk(
        &self,
        certificate: &CertificateRef,
        expected_fingerprint: Option<&str>,
    ) -> Result<()> {
        let (fullchain, key) = self.material_paths(certificate)?;
        let certificate_pem = std::fs::read_to_string(&fullchain)
            .with_context(|| format!("missing {}", fullchain.display()))?;
        let private_key_pem =
            std::fs::read_to_string(&key).with_context(|| format!("missing {}", key.display()))?;
        validate_material(
            &certificate_pem,
            &private_key_pem,
            &[],
            expected_fingerprint,
        )?;
        Ok(())
    }

    /// Validated generations available for a certificate, ascending.
    pub fn list_generations(&self, certificate_id: &str) -> Vec<u64> {
        let mut generations = std::fs::read_dir(self.root.join(certificate_id))
            .map(|entries| {
                entries
                    .filter_map(std::result::Result::ok)
                    .filter_map(|entry| {
                        let name = entry.file_name().to_string_lossy().into_owned();
                        name.strip_prefix(GENERATION_DIR_PREFIX)?.parse().ok()
                    })
                    .collect::<Vec<u64>>()
            })
            .unwrap_or_default();
        generations.sort_unstable();
        generations
    }

    /// Rewrites a stale/last-known-good config so managed TLS inbounds point at
    /// validated local generation material and never carry inline PEM.
    /// Unrepairable managed references return an error. Manual or inline TLS is
    /// deliberately rejected: node-owned X.509 material no longer exists.
    pub fn repair_config(&self, config: &mut Map<String, Value>) -> Result<()> {
        let Some(inbounds) = config.get_mut("inbounds").and_then(Value::as_array_mut) else {
            return Ok(());
        };
        for inbound in inbounds {
            let Some(tls) = inbound.get_mut("tls").and_then(Value::as_object_mut) else {
                continue;
            };
            let has_material = MANAGED_TLS_MATERIAL_FIELDS
                .iter()
                .any(|field| tls.contains_key(*field));
            if !has_material {
                continue;
            }
            let certificate_path = tls.get("certificate_path").and_then(Value::as_str);
            let key_path = tls.get("key_path").and_then(Value::as_str);
            let (Some(certificate_path), Some(key_path)) = (certificate_path, key_path) else {
                bail!("inline or incomplete TLS material cannot be repaired safely");
            };
            let certificate_ref = parse_managed_material_path(certificate_path, &self.root)
                .ok_or_else(|| anyhow!("unmanaged certificate_path is forbidden"))?;
            let key_ref = parse_managed_material_path(key_path, &self.root)
                .ok_or_else(|| anyhow!("unmanaged key_path is forbidden"))?;
            if certificate_ref != key_ref {
                bail!("certificate_path and key_path reference different material");
            }
            let (certificate_id, preferred_generation) = certificate_ref;
            let generation = self.resolve_generation(&certificate_id, preferred_generation)?;
            for field in MANAGED_TLS_INLINE_FIELDS {
                tls.remove(field);
            }
            let certificate = CertificateRef {
                certificate_id: certificate_id.clone(),
                generation,
            };
            let (fullchain, key) = self.material_paths(&certificate)?;
            tls.insert(
                "certificate_path".into(),
                Value::String(fullchain.to_string_lossy().into_owned()),
            );
            tls.insert(
                "key_path".into(),
                Value::String(key.to_string_lossy().into_owned()),
            );
            info!(
                certificate_id = %certificate_id,
                generation = generation,
                "repaired managed TLS reference from generation material"
            );
        }
        Ok(())
    }

    /// The exact generation material referenced by a config's managed TLS
    /// inbounds. Used to decide whether an equal revision can be skipped and to
    /// recompute `inUse` after restart.
    pub fn referenced_generations(&self, config: &Map<String, Value>) -> Vec<CertificateRef> {
        let mut referenced = Vec::new();
        let Some(inbounds) = config.get("inbounds").and_then(Value::as_array) else {
            return referenced;
        };
        for inbound in inbounds {
            let Some(tls) = inbound.get("tls").and_then(Value::as_object) else {
                continue;
            };
            for field in ["certificate_path", "key_path"] {
                let Some(path) = tls.get(field).and_then(Value::as_str) else {
                    continue;
                };
                let Some((certificate_id, Some(generation))) =
                    parse_managed_material_path(path, &self.root)
                else {
                    continue;
                };
                let reference = CertificateRef {
                    certificate_id,
                    generation,
                };
                if !referenced.contains(&reference) {
                    referenced.push(reference);
                }
            }
        }
        referenced
    }

    fn resolve_generation(&self, certificate_id: &str, preferred: Option<u64>) -> Result<u64> {
        let mut candidates: Vec<u64> = Vec::new();
        if let Some(generation) = preferred {
            candidates.push(generation);
        }
        candidates.extend(self.list_generations(certificate_id));
        for generation in candidates {
            let certificate = CertificateRef {
                certificate_id: certificate_id.to_owned(),
                generation,
            };
            if self.validate_generation_on_disk(&certificate, None).is_ok() {
                return Ok(generation);
            }
        }
        bail!("no valid generation material available for certificate {certificate_id}")
    }
}

/// Normalizes CRLF / lone CR line endings and trims stray surrounding
/// whitespace so PEM parsers never trip over transport-level line endings.
fn normalize_pem(input: &str) -> String {
    let normalized = input.replace("\r\n", "\n").replace('\r', "\n");
    format!("{}\n", normalized.trim())
}

/// Validates a certificate/key pair and returns the normalized PEM plus the
/// canonical fingerprint. `expected_fingerprint`, when provided, must match the
/// advertised SHA-256 of either the PEM text or the leaf DER (raw hex or
/// colon-separated are accepted).
fn validate_material(
    certificate_pem: &str,
    private_key_pem: &str,
    domains: &[String],
    expected_fingerprint: Option<&str>,
) -> Result<(String, String, String)> {
    let certificate_pem = normalize_pem(certificate_pem);
    let private_key_pem = normalize_pem(private_key_pem);

    let certificates = rustls_pemfile::certs(&mut BufReader::new(Cursor::new(&certificate_pem)))
        .collect::<std::result::Result<Vec<CertificateDer<'static>>, _>>()
        .context("failed to parse certificate chain")?;
    if certificates.is_empty() {
        bail!("certificate chain is empty");
    }
    let private_key =
        rustls_pemfile::private_key(&mut BufReader::new(Cursor::new(&private_key_pem)))
            .context("failed to parse private key")?
            .ok_or_else(|| anyhow!("private key is missing"))?;
    rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(certificates.clone(), private_key)
        .context("certificate and private key do not match")?;

    let (_, certificate) = parse_x509_certificate(certificates[0].as_ref())
        .map_err(|error| anyhow!("invalid certificate: {error}"))?;
    let now = Utc::now().timestamp();
    if certificate.validity().not_before.timestamp() > now {
        bail!("certificate validity has not started");
    }
    if certificate.validity().not_after.timestamp() <= now {
        bail!("certificate has expired");
    }
    let names = certificate
        .subject_alternative_name()?
        .map(|extension| {
            extension
                .value
                .general_names
                .iter()
                .filter_map(|name| match name {
                    GeneralName::DNSName(value) => Some((*value).to_string()),
                    _ => None,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for domain in domains {
        if !names.iter().any(|name| name.eq_ignore_ascii_case(domain)) {
            bail!("certificate SAN does not contain {domain}");
        }
    }

    let pem_fingerprint = hex_digest(certificate_pem.as_bytes());
    let der_fingerprint = hex_digest(certificates[0].as_ref());
    let advertised = expected_fingerprint.map(|value| value.trim().to_lowercase().replace(':', ""));
    if let Some(advertised) = advertised {
        if advertised != pem_fingerprint && advertised != der_fingerprint {
            bail!(
                "advertised SHA-256 fingerprint {advertised} does not match staged material (pem {pem_fingerprint}, leaf {der_fingerprint})"
            );
        }
        Ok((certificate_pem, private_key_pem, advertised))
    } else {
        Ok((certificate_pem, private_key_pem, pem_fingerprint))
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn parse_rfc3339(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|datetime| datetime.with_timezone(&Utc))
}

/// Parses a managed material path (`<local root>|<control-plane root>/<id>/
/// generation-<n>|current/<file>`) into a certificate id and optional
/// generation. Returns `None` for paths that are not managed material.
fn parse_managed_material_path(path: &str, local_root: &Path) -> Option<(String, Option<u64>)> {
    let candidate = Path::new(path);
    let relative = candidate.strip_prefix(local_root).ok().or_else(|| {
        candidate
            .strip_prefix(Path::new(CONTROL_PLANE_CERTIFICATE_ROOT))
            .ok()
    })?;
    let mut components = relative.components();
    let certificate_id = components.next()?.as_os_str().to_str()?.to_owned();
    if validate_certificate_id(&certificate_id).is_err() {
        return None;
    }
    let version = components.next()?.as_os_str().to_str()?.to_owned();
    let file = components.next()?.as_os_str().to_str()?;
    if !matches!(file, FULLCHAIN_FILE | PRIVATE_KEY_FILE) || components.next().is_some() {
        return None;
    }
    if let Some(generation) = version.strip_prefix(GENERATION_DIR_PREFIX) {
        let generation = generation.parse::<u64>().ok()?;
        Some((certificate_id, Some(generation)))
    } else if version == "current" {
        Some((certificate_id, None))
    } else {
        None
    }
}

fn validate_certificate_id(certificate_id: &str) -> Result<()> {
    if certificate_id.is_empty()
        || certificate_id == "."
        || certificate_id == ".."
        || certificate_id.contains('/')
        || certificate_id.contains('\\')
        || certificate_id.contains('\0')
    {
        bail!("certificate id is not a safe path component");
    }
    Ok(())
}

fn installed_material_matches(dir: &Path, certificate_pem: &str, private_key_pem: &str) -> bool {
    std::fs::read(dir.join(FULLCHAIN_FILE)).is_ok_and(|bytes| bytes == certificate_pem.as_bytes())
        && std::fs::read(dir.join(PRIVATE_KEY_FILE))
            .is_ok_and(|bytes| bytes == private_key_pem.as_bytes())
}

fn write_secret_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        set_directory_permissions(parent)?;
    }
    let temporary = path.with_extension("tmp");
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    set_file_permissions(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(temporary, path)?;
    Ok(())
}

fn set_directory_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn set_file_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{BufReader, Cursor};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use rcgen::generate_simple_self_signed;
    use serde_json::json;
    use sha2::{Digest, Sha256};

    use super::{
        CertificateManager, CertificateRef, hex_digest, normalize_pem, parse_managed_material_path,
        validate_material,
    };

    #[allow(dead_code)]
    const TEST_CERT: &str = "-----BEGIN CERTIFICATE-----
MIIC6TCCAdGgAwIBAgIJAK6WACBVJkogMA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNV
BAMMEGVkZ2UuZXhhbXBsZS5jb20wHhcNMjYwODA2MTYxNjMxWhcNMzYwODAzMTYx
NjMxWjAbMRkwFwYDVQQDDBBlZGdlLmV4YW1wbGUuY29tMIIBIjANBgkqhkiG9w0B
AQEFAAOCAQ8AMIIBCgKCAQEAxBFoX2OSyhrEAmusy2MVVf/a6DaoSG6BqpR5p5bV
mc/8GzcmiAE72fl6mn4jnG1lFb1QOu1w2F+W6bxahFcQrlIGEzGDWRUIKXHvltx3
QTFwkxU+yeAFp4RAAMUmB+j5TVfqyD/2iBptpgnTTkbdBAbfMkuCnDwBp5Cm4qtw
f487xAZy7K1ll6Ck7iyC59BWaI+RqrhZORMZSwSJJi2vTL7fHJcrFzMuswP04zss
E4D1R7YdV0ra9k4Egh9+ZJ6/9tJsIt0giLBjAxVmd4S0WCkc8gy16rCvLW0c1ZoN
c3RoI2L4o81fx1xsLdVvQpeAqKO33ECLrM9CV9qITumu4wIDAQABozAwLjAsBgNV
HREEJTAjghBlZGdlLmV4YW1wbGUuY29tgg9hcGkuZXhhbXBsZS5jb20wDQYJKoZI
hvcNAQELBQADggEBABw3iKE9CFvp0+bY9O5FbSFRZvwR88r320NkUw9I/ghgIkvd
Yo06qQetdbhn54nP6Zgtwtfpgz0o1h67Ejoyu1sYOAlFK5KdDPGd6JXMJy6vLKmq
bXeuM2G5PVCdDrbTrn2/GXfK7xtY+b+AvPBhb3RtLQTR3Cv9VQ1fCUcAqkE7XRIy
lHikYxaxhn9uGLJJbh2sWBNp6HLPtwbfDHGZLk7TH3wFIvWAs4TPY9bbV4W7axOq
j+iWCU9rhJuhzg1OkCD5A4ouj1vYZB8gSgwh2ft65l8s2KLUeJ2NYSFxHoRoNrgs
6rtz1J4tvm8AM5wW0PcZoxBF8MNrBeYQg15STUg=
-----END CERTIFICATE-----
";

    #[allow(dead_code)]
    const TEST_KEY: &str = "-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDEEWhfY5LKGsQC
a6zLYxVV/9roNqhIboGqlHmnltWZz/wbNyaIATvZ+XqafiOcbWUVvVA67XDYX5bp
vFqEVxCuUgYTMYNZFQgpce+W3HdBMXCTFT7J4AWnhEAAxSYH6PlNV+rIP/aIGm2m
CdNORt0EBt8yS4KcPAGnkKbiq3B/jzvEBnLsrWWXoKTuLILn0FZoj5GquFk5ExlL
BIkmLa9Mvt8clysXMy6zA/TjOywTgPVHth1XStr2TgSCH35knr/20mwi3SCIsGMD
FWZ3hLRYKRzyDLXqsK8tbRzVmg1zdGgjYvijzV/HXGwt1W9Cl4Coo7fcQIusz0JX
2ohO6a7jAgMBAAECggEAThVwr6yEJSELtrsTEdzf/mPq1lgOJOp9kWWYHXogjyUZ
je0k1z1GjMSiYyyhGgcnHsVKUm2FZ2aKP4PXuKTD6+iWqsYpPSz3Fypc9IPQqpH5
91maq+Mf3Vr58lSRlMzfnEHLKvzuPb3otRtsn9vw4U2rTehsl7P+JLGjBNqp7uJ1
wGkdr1ftclfen/1h1wDrDBM1NwRW9sGbiNWXN5n/PUmHeDQexoMuOeAO9hd+c8ft
yvvY76P/DNLCJYWlM6wJN22mceao9PPhQfLsvq12LVfBJVl+S4gfA/T35weM9eX6
r38BESNX5BO1NZ6TEUN0dM3xVwkRmHFaJgCPEC/0wQKBgQDi1UVZSj0PQL6gPSAv
bgbHVR6wbUl/vISybe1X2dNiGFyYVj83vlO4/Feo+4dt7J/kdmWGipyvxHX0KwUn
3rQVjBuH8Ruy3gmVpgAY0MEoDjMhULLr6wUoJjOvHE5hbHv0IpG9NkWSjEgiCR7V
L4XHhV0I7bdifOxe2bhIsdymWQKBgQDdR28ArWiPrUM63+6vyfQ5nXt11eFGXnVZ
Jal0koeqyLgSu99HFdevLjwoiM+X5/bTMS+YI3TIW1/wtxISeprvHs7sW//cRS9a
ZBCltyRURl8k5LBrq7m0f9Q0/eu01zG6h+vx3P1L7BEFRnTW42otqM3clxl00JkQ
ihLRtmfPmwKBgQCQOPPH6ujZutu5PEQrg/RxZtCFcmcp/W4NmNEwa0H4e+7buPKm
+a93zZHa0lpwbOPYueKhYZ5wLySkI3o6uGGd1aBnlch7uKs1Z/9lx80YL7cYtpuc
Xqi/t1JjQ0cesIA7YINzX39qxyDR6yScfYO8sTHPDH3t8+nCAQInzlaxuQKBgDm+
QFs+5UBJCHg+o3zACLlYPTV8wLKqR5kh2NyQuFJ62n4ZBKT6MDSIri4ttW6Am8p0
1WSwK/N01M5uF4s272Ni+MB5KYWDkF3YKvfzmMldK8rm2preTzGpAelqMa4ZUeLJ
QWr2Lis3ySFFR4wkADs2B7J+w6fWH3tPbKXJIcHtAoGBALjDnmunSzgjGpwYOHVL
fUqnbG2/fNsWS1o7VTewVDOEFmYemJcFvnFfoq3ynjXQGJ5UAfOOFv1yo8n8CgAm
6y/wZuvJ+0v9AD+cIftzIpjP99/bMa9jch29RqBQm6kfGzzopnc8pAfc6T8Otoug
/HOrPV2SitVqaJ5lPPskzau4
-----END PRIVATE KEY-----
";

    fn unique_dir() -> std::path::PathBuf {
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("blossom-cert-{}-{suffix}-{id}", std::process::id()))
    }

    #[test]
    fn normalizes_crlf_and_trailing_whitespace() {
        assert_eq!(
            normalize_pem("-----BEGIN TEST-----\r\nBODY\r\n-----END TEST-----\r\n"),
            "-----BEGIN TEST-----\nBODY\n-----END TEST-----\n"
        );
        assert_eq!(
            normalize_pem("-----BEGIN TEST-----\nBODY\n-----END TEST-----"),
            "-----BEGIN TEST-----\nBODY\n-----END TEST-----\n"
        );
    }

    #[test]
    fn validates_material_with_pem_fingerprint() {
        let (test_cert, test_key) = test_material();
        let (cert, key, fingerprint) = validate_material(
            &test_cert,
            &test_key,
            &[
                "edge.example.com".to_string(),
                "api.example.com".to_string(),
            ],
            Some(&hex_digest_for(&test_cert)),
        )
        .unwrap();
        assert_eq!(cert, normalize_pem(&test_cert));
        assert_eq!(key, normalize_pem(&test_key));
        assert_eq!(fingerprint, hex_digest_for(&test_cert));
    }

    #[test]
    fn accepts_leaf_der_fingerprint_in_colon_format() {
        let (test_cert, test_key) = test_material();
        let leaf_der = rustls_pemfile::certs(&mut BufReader::new(Cursor::new(
            normalize_pem(&test_cert).as_bytes(),
        )))
        .next()
        .unwrap()
        .unwrap();
        let hex = hex_digest(&leaf_der);
        let colon_upper = hex
            .chars()
            .enumerate()
            .map(|(i, c)| {
                if i > 0 && i % 2 == 0 {
                    format!(":{c}")
                } else {
                    c.to_string()
                }
            })
            .collect::<String>()
            .to_uppercase();
        let (_cert, _key, fingerprint) =
            validate_material(&test_cert, &test_key, &[], Some(&colon_upper)).unwrap();
        assert_eq!(fingerprint, colon_upper.to_lowercase().replace(':', ""));
    }

    #[test]
    fn rejects_mismatched_key_pair() {
        let (_test_cert, test_key) = test_material();
        let (other_cert, _other_key) = test_material();
        let error = validate_material(
            &other_cert,
            &test_key,
            &[],
            Some(&hex_digest_for(&other_cert)),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("do not match"), "{error}");
    }

    #[test]
    fn rejects_missing_san_domain() {
        let (test_cert, test_key) = test_material();
        let error = validate_material(
            &test_cert,
            &test_key,
            &["missing.example.net".to_string()],
            Some(&hex_digest_for(&test_cert)),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("SAN does not contain"), "{error}");
    }

    #[test]
    fn rejects_wrong_fingerprint() {
        let (test_cert, test_key) = test_material();
        let error = validate_material(&test_cert, &test_key, &[], Some("deadbeef"))
            .unwrap_err()
            .to_string();
        assert!(error.contains("does not match"), "{error}");
    }

    #[test]
    fn rejects_empty_chain() {
        let (test_cert, test_key) = test_material();
        let error = validate_material(
            "not a pem",
            &test_key,
            &[],
            Some(&hex_digest_for(&test_cert)),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("chain") || error.contains("PEM"), "{error}");
    }

    #[test]
    fn stage_writes_generation_and_validates_round_trip() {
        let state = unique_dir();
        let manager = CertificateManager::new(&state).unwrap();
        let generation_dir = manager.generation_dir("cert-1", 1);
        let artifact = artifact(1, "cert-1");
        let expected_certificate = artifact.certificate_pem.to_string();
        let expected_fingerprint = artifact.fingerprint_sha256.to_string();
        assert!(manager.stage(&artifact).is_ok());

        assert!(generation_dir.join("fullchain.pem").exists());
        assert!(generation_dir.join("private-key.pem").exists());
        let on_disk = std::fs::read_to_string(generation_dir.join("fullchain.pem")).unwrap();
        assert_eq!(on_disk, normalize_pem(&expected_certificate));

        manager
            .validate_generation_on_disk(
                &CertificateRef {
                    certificate_id: "cert-1".into(),
                    generation: 1,
                },
                Some(&expected_fingerprint),
            )
            .unwrap();
        std::fs::remove_dir_all(&state).unwrap();
    }

    #[test]
    fn rejects_reusing_generation_for_different_valid_material() {
        let state = unique_dir();
        let manager = CertificateManager::new(&state).unwrap();
        let first = artifact(1, "cert-1");
        let first_certificate = first.certificate_pem.to_string();
        manager.stage(&first).unwrap();

        let replacement = artifact(1, "cert-1");
        let error = manager.stage(&replacement).unwrap_err().to_string();
        assert!(error.contains("different valid material"), "{error}");
        assert_eq!(
            std::fs::read_to_string(manager.generation_dir("cert-1", 1).join("fullchain.pem"))
                .unwrap(),
            normalize_pem(&first_certificate)
        );
        std::fs::remove_dir_all(&state).unwrap();
    }

    #[test]
    fn repairs_stale_config_with_inline_material() {
        let state = unique_dir();
        let manager = CertificateManager::new(&state).unwrap();
        manager.stage(&artifact(1, "cert-1")).unwrap();

        let mut config = json!({
            "inbounds": [{
                "type": "vless",
                "tag": "node-1",
                "tls": {
                    "enabled": true,
                    "certificate": ["-----BEGIN CERTIFICATE-----\\nESCAPED-NOT-PEM\\n-----END CERTIFICATE-----"],
                    "certificate_path": "/var/lib/blossom-agent/certificates/cert-1/current/fullchain.pem",
                    "key": ["stale"],
                    "key_path": "/var/lib/blossom-agent/certificates/cert-1/current/private-key.pem"
                }
            }]
        })
        .as_object()
        .unwrap()
        .clone();

        manager.repair_config(&mut config).unwrap();
        let tls = config["inbounds"][0]["tls"].as_object().unwrap();
        for field in ["certificate", "key", "acme", "certificate_provider"] {
            assert!(
                !tls.contains_key(field),
                "stale field {field} left in place"
            );
        }
        let fullchain: &str = tls["certificate_path"].as_str().unwrap();
        assert!(
            fullchain.ends_with("cert-1/generation-1/fullchain.pem"),
            "{fullchain}"
        );
        assert!(
            tls["key_path"]
                .as_str()
                .unwrap()
                .ends_with("cert-1/generation-1/private-key.pem")
        );
        std::fs::remove_dir_all(&state).unwrap();
    }

    #[test]
    fn manual_tls_is_rejected_at_startup() {
        let state = unique_dir();
        let manager = CertificateManager::new(&state).unwrap();
        let mut config = json!({
            "inbounds": [{
                "tag": "manual",
                "tls": {
                    "certificate_path": "/etc/sing-box/fullchain.pem",
                    "key_path": "/etc/sing-box/private-key.pem"
                }
            }]
        })
        .as_object()
        .unwrap()
        .clone();
        let error = manager.repair_config(&mut config).unwrap_err().to_string();
        assert!(error.contains("unmanaged certificate_path"), "{error}");
        std::fs::remove_dir_all(&state).unwrap();
    }

    #[test]
    fn rejects_unsafe_certificate_id() {
        let state = unique_dir();
        let manager = CertificateManager::new(&state).unwrap();
        let error = manager
            .stage(&artifact(1, "../escape"))
            .unwrap_err()
            .to_string();
        assert!(error.contains("safe path component"), "{error}");
        assert!(!state.join("escape").exists());
        std::fs::remove_dir_all(&state).unwrap();
    }

    #[test]
    fn parses_managed_path_variants() {
        let root = std::path::Path::new("/custom/state/certificates");
        assert_eq!(
            parse_managed_material_path(
                "/custom/state/certificates/cert-1/generation-2/fullchain.pem",
                root,
            ),
            Some(("cert-1".to_string(), Some(2)))
        );
        assert_eq!(
            parse_managed_material_path(
                "/var/lib/blossom-agent/certificates/cert-1/current/private-key.pem",
                root,
            ),
            Some(("cert-1".to_string(), None))
        );
        assert_eq!(
            parse_managed_material_path("/etc/sing-box/fullchain.pem", root),
            None
        );
        assert_eq!(
            parse_managed_material_path(
                "/custom/state/certificates/cert-1/generation-2/fullchain.pem/extra",
                root,
            ),
            None
        );
    }

    #[test]
    fn referenced_generations_scans_config() {
        let state = unique_dir();
        let manager = CertificateManager::new(&state).unwrap();
        manager.stage(&artifact(1, "cert-1")).unwrap();
        let config = json!({
            "inbounds": [
                { "tag": "a", "tls": {
                    "certificate_path": format!("{}/cert-1/generation-1/fullchain.pem", manager.root().display()),
                    "key_path": format!("{}/cert-1/generation-1/private-key.pem", manager.root().display())
                } },
                { "tag": "b", "tls": {
                    "certificate_path": "/etc/manual/fullchain.pem"
                } }
            ]
        })
        .as_object()
        .unwrap()
        .clone();
        let referenced = manager.referenced_generations(&config);
        assert_eq!(
            referenced,
            vec![CertificateRef {
                certificate_id: "cert-1".into(),
                generation: 1,
            }]
        );
        std::fs::remove_dir_all(&state).unwrap();
    }

    fn hex_digest_for(pem: &str) -> String {
        format!("{:x}", Sha256::digest(normalize_pem(pem).as_bytes()))
    }

    fn artifact(
        generation: u64,
        certificate_id: &str,
    ) -> crate::client::types::GetAgentConfigV3ResponseCertificateArtifactsItem {
        let (certificate_pem, private_key_pem) = test_material();
        crate::client::types::GetAgentConfigV3ResponseCertificateArtifactsItem {
            certificate_id: certificate_id.parse().unwrap(),
            generation: std::num::NonZeroU64::new(generation).unwrap(),
            domains: vec![
                "edge.example.com".parse().unwrap(),
                "api.example.com".parse().unwrap(),
            ],
            fingerprint_sha256: hex_digest_for(&certificate_pem).parse().unwrap(),
            not_before: "2026-01-01T00:00:00Z".to_string(),
            not_after: "2030-01-01T00:00:00Z".to_string(),
            certificate_pem: certificate_pem.parse().unwrap(),
            private_key_pem: private_key_pem.parse().unwrap(),
        }
    }

    fn test_material() -> (String, String) {
        let certified = generate_simple_self_signed(vec![
            "edge.example.com".to_string(),
            "api.example.com".to_string(),
        ])
        .unwrap();
        (certified.cert.pem(), certified.signing_key.serialize_pem())
    }
}
