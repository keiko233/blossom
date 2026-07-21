use std::fs::OpenOptions;
use std::io::{BufReader, Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, Utc};
use rustls::pki_types::CertificateDer;
use serde::Deserialize;
use serde_json::Value;
use tracing::{info, warn};
use x509_parser::{extensions::GeneralName, parse_x509_certificate};

use crate::client::{Client, types};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CertificateAction {
    id: String,
    #[serde(rename = "type")]
    type_: String,
    certificate_id: String,
    generation: u64,
    #[serde(default)]
    domains: Vec<String>,
    #[serde(default)]
    material: Option<InstallMaterial>,
    #[serde(default)]
    report_required: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallMaterial {
    certificate_pem: String,
    private_key_pem: String,
    not_before: DateTime<Utc>,
    not_after: DateTime<Utc>,
    fingerprint_sha256: String,
}

pub struct CertificateManager {
    client: Client,
    root: PathBuf,
}

impl CertificateManager {
    pub fn new(client: Client, state_dir: &Path) -> Result<Self> {
        let root = state_dir.join("certificates");
        std::fs::create_dir_all(&root)
            .with_context(|| format!("failed to create {}", root.display()))?;
        set_directory_permissions(&root)?;
        Ok(Self { client, root })
    }

    pub async fn reconcile(
        &self,
        actions: &[types::GetAgentConfigV2ResponseActionsItem],
    ) -> Result<()> {
        for raw in actions {
            if !raw.type_.starts_with("certificate.") {
                continue;
            }
            let mut value = Value::Object(raw.extra.clone());
            let object = value
                .as_object_mut()
                .ok_or_else(|| anyhow!("certificate action is not an object"))?;
            object.insert("id".into(), Value::String(raw.id.clone()));
            object.insert("type".into(), Value::String(raw.type_.clone()));
            let action: CertificateAction =
                serde_json::from_value(value).context("failed to decode certificate action")?;
            if let Err(error) = self.reconcile_one(&action).await {
                warn!(
                    certificate_id = %action.certificate_id,
                    action_id = %action.id,
                    "certificate action failed: {error:#}"
                );
                if let Err(report_error) = self
                    .report(
                        &action,
                        "error",
                        None,
                        Some(sanitize_error(&error.to_string())),
                    )
                    .await
                {
                    warn!(
                        certificate_id = %action.certificate_id,
                        action_id = %action.id,
                        "failed to report certificate action error: {report_error:#}"
                    );
                }
                return Err(error).with_context(|| {
                    format!(
                        "certificate action {} failed; refusing to apply config",
                        action.id
                    )
                });
            }
        }
        Ok(())
    }

    async fn reconcile_one(&self, action: &CertificateAction) -> Result<()> {
        match action.type_.as_str() {
            "certificate.install" => {
                let material = action
                    .material
                    .as_ref()
                    .ok_or_else(|| anyhow!("install action has no material"))?;
                validate_material(material, &action.domains)?;
                let current = self.root.join(&action.certificate_id).join("current");
                let material_changed = !installed_material_matches(&current, material);
                if material_changed {
                    self.install(action, material)?;
                }
                if material_changed || action.report_required {
                    self.report(action, "active", Some(material), None).await
                } else {
                    Ok(())
                }
            }
            "certificate.remove" => {
                let dir = self.root.join(&action.certificate_id);
                if dir.exists() {
                    std::fs::remove_dir_all(dir)?;
                }
                self.report(action, "removed", None, None).await
            }
            other => bail!("unsupported certificate action: {other}"),
        }
    }

    fn install(&self, action: &CertificateAction, material: &InstallMaterial) -> Result<()> {
        let certificate_dir = self.root.join(&action.certificate_id);
        std::fs::create_dir_all(&certificate_dir)?;
        set_directory_permissions(&certificate_dir)?;
        let version_name = format!("generation-{}", action.generation);
        let version_dir = certificate_dir.join(&version_name);
        std::fs::create_dir_all(&version_dir)?;
        set_directory_permissions(&version_dir)?;
        write_secret_file(
            &version_dir.join("fullchain.pem"),
            material.certificate_pem.as_bytes(),
        )?;
        write_secret_file(
            &version_dir.join("private-key.pem"),
            material.private_key_pem.as_bytes(),
        )?;
        replace_current_link(&certificate_dir, &version_name)?;
        info!(
            certificate_id = %action.certificate_id,
            generation = action.generation,
            "certificate material installed"
        );
        Ok(())
    }

    async fn report(
        &self,
        action: &CertificateAction,
        state: &str,
        material: Option<&InstallMaterial>,
        error: Option<String>,
    ) -> Result<()> {
        let value = serde_json::json!({
            "actionId": action.id,
            "certificateId": action.certificate_id,
            "generation": action.generation,
            "state": state,
            "notBefore": material.map(|item| item.not_before),
            "notAfter": material.map(|item| item.not_after),
            "fingerprintSha256": material.map(|item| item.fingerprint_sha256.as_str()),
            "challenge": [],
            "error": error,
        });
        let body: types::ReportCertificateEventBody = serde_json::from_value(value)?;
        self.client
            .report_certificate_event(&body)
            .await
            .map_err(|error| anyhow!("failed to report certificate event: {error}"))?;
        Ok(())
    }
}

fn installed_material_matches(current: &Path, material: &InstallMaterial) -> bool {
    std::fs::read(current.join("fullchain.pem"))
        .is_ok_and(|bytes| bytes == material.certificate_pem.as_bytes())
        && std::fs::read(current.join("private-key.pem"))
            .is_ok_and(|bytes| bytes == material.private_key_pem.as_bytes())
}

fn validate_material(material: &InstallMaterial, domains: &[String]) -> Result<()> {
    let certificates =
        rustls_pemfile::certs(&mut BufReader::new(Cursor::new(&material.certificate_pem)))
            .collect::<std::result::Result<Vec<CertificateDer<'static>>, _>>()?;
    if certificates.is_empty() {
        bail!("certificate chain is empty");
    }
    let private_key =
        rustls_pemfile::private_key(&mut BufReader::new(Cursor::new(&material.private_key_pem)))?
            .ok_or_else(|| anyhow!("private key is missing"))?;
    rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(certificates.clone(), private_key)
        .context("certificate and private key do not match")?;

    let (_, certificate) = parse_x509_certificate(certificates[0].as_ref())
        .map_err(|error| anyhow!("invalid certificate: {error}"))?;
    if certificate.validity().not_after.timestamp() <= Utc::now().timestamp() {
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
    Ok(())
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

#[cfg(unix)]
fn replace_current_link(certificate_dir: &Path, version_name: &str) -> Result<()> {
    use std::os::unix::fs::symlink;
    let temporary = certificate_dir.join("current.new");
    if temporary.symlink_metadata().is_ok() {
        std::fs::remove_file(&temporary)?;
    }
    symlink(version_name, &temporary)?;
    std::fs::rename(temporary, certificate_dir.join("current"))?;
    Ok(())
}

#[cfg(not(unix))]
fn replace_current_link(certificate_dir: &Path, version_name: &str) -> Result<()> {
    let current = certificate_dir.join("current");
    if current.exists() {
        std::fs::remove_dir_all(&current)?;
    }
    std::fs::create_dir_all(&current)?;
    std::fs::copy(
        certificate_dir.join(version_name).join("fullchain.pem"),
        current.join("fullchain.pem"),
    )?;
    std::fs::copy(
        certificate_dir.join(version_name).join("private-key.pem"),
        current.join("private-key.pem"),
    )?;
    Ok(())
}

fn sanitize_error(value: &str) -> String {
    value
        .replace(
            |character: char| character.is_control() && character != '\n',
            "",
        )
        .chars()
        .take(4096)
        .collect()
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use chrono::{TimeZone, Utc};

    use super::{InstallMaterial, installed_material_matches};

    fn material() -> InstallMaterial {
        InstallMaterial {
            certificate_pem: "certificate".into(),
            private_key_pem: "private-key".into(),
            not_before: Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
            not_after: Utc.timestamp_opt(2_000_000_000, 0).unwrap(),
            fingerprint_sha256: "fingerprint".into(),
        }
    }

    #[test]
    fn missing_current_material_needs_repair() {
        let missing = std::env::temp_dir().join("blossom-agent-missing-certificate-test");
        assert!(!installed_material_matches(&missing, &material()));
    }

    #[test]
    fn matching_current_material_is_idempotent() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let current = std::env::temp_dir().join(format!(
            "blossom-agent-certificate-test-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&current).unwrap();
        std::fs::write(current.join("fullchain.pem"), "certificate").unwrap();
        std::fs::write(current.join("private-key.pem"), "private-key").unwrap();

        assert!(installed_material_matches(&current, &material()));

        std::fs::write(current.join("fullchain.pem"), "different").unwrap();
        assert!(!installed_material_matches(&current, &material()));
        std::fs::remove_dir_all(current).unwrap();
    }
}
