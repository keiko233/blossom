//! Fetches the server's combined multi-inbound sing-box config from the blossom
//! API and materialises it on disk. The control plane validates the config; the
//! agent only interprets the two pieces it owns locally: the v2ray API listen
//! address and managed-certificate paths. The latter are normalized to the
//! configured state directory so stale inline material can never override files
//! the agent has validated and installed.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tracing::info;

use crate::certificate::CertificateManager;
use crate::client::Client;

const CONTROL_PLANE_CERTIFICATE_ROOT: &str = "/var/lib/blossom-agent/certificates";
const MANAGED_TLS_INLINE_FIELDS: [&str; 4] = ["certificate", "key", "acme", "certificate_provider"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentPolicy {
    pub config_poll_interval_seconds: u64,
    pub heartbeat_interval_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateConfig {
    pub revision: String,
    pub materialized_node_ids: Vec<String>,
    pub v2ray_listen: Option<String>,
}

/// Whether a fetch produced a new candidate config. Policy is returned on every
/// fetch so server-side interval changes take effect without reloading sing-box.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchStatus {
    Updated {
        policy: AgentPolicy,
        candidate: CandidateConfig,
    },
    Unchanged(AgentPolicy),
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PersistedState {
    applied_revision: Option<String>,
    active_node_ids: Vec<String>,
    applied_at: Option<DateTime<Utc>>,
}

pub struct ConfigManager {
    client: Client,
    certificate_manager: CertificateManager,
    state_dir: PathBuf,
    active_path: PathBuf,
    candidate_path: PathBuf,
    last_good_path: PathBuf,
    state_path: PathBuf,
    observed_revision: Option<String>,
    persisted: PersistedState,
    v2ray_listen: Option<String>,
}

impl ConfigManager {
    pub fn new(client: Client, state_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&state_dir)
            .with_context(|| format!("failed to create state dir {}", state_dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o700))?;
        }

        let active_path = state_dir.join("active.json");
        let candidate_path = state_dir.join("candidate.json");
        let last_good_path = state_dir.join("last-known-good.json");
        let state_path = state_dir.join("state.json");
        let persisted = std::fs::read(&state_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();

        // A previous failed promotion may have left active.json unusable. The
        // committed LKG is authoritative across agent restarts.
        if last_good_path.exists() {
            replace_from(
                &last_good_path,
                &active_path,
                &state_dir.join("active.json.restore"),
            )?;
        } else if active_path.exists() {
            // active.json is not committed until the probation window succeeds.
            // A crash during first apply must not turn that unverified candidate
            // into the startup config on the next agent boot.
            std::fs::remove_file(&active_path)
                .context("failed to discard uncommitted active config")?;
        }
        let v2ray_listen = read_v2ray_listen(&active_path);

        let certificate_manager = CertificateManager::new(client.clone(), &state_dir)?;
        Ok(Self {
            client,
            certificate_manager,
            state_dir,
            active_path,
            candidate_path,
            last_good_path,
            state_path,
            observed_revision: None,
            persisted,
            v2ray_listen,
        })
    }

    /// Path sing-box is launched against.
    pub fn config_path(&self) -> &PathBuf {
        &self.active_path
    }

    pub fn candidate_path(&self) -> &PathBuf {
        &self.candidate_path
    }

    pub fn has_active_config(&self) -> bool {
        self.active_path.exists()
    }

    pub fn observed_revision(&self) -> Option<&str> {
        self.observed_revision.as_deref()
    }

    pub fn applied_revision(&self) -> Option<&str> {
        self.persisted.applied_revision.as_deref()
    }

    pub fn active_node_ids(&self) -> &[String] {
        &self.persisted.active_node_ids
    }

    pub fn applied_at(&self) -> Option<DateTime<Utc>> {
        self.persisted.applied_at
    }

    /// The sing-box v2ray API listen address, if the latest config provided one.
    pub fn v2ray_api_listen(&self) -> Option<&str> {
        self.v2ray_listen.as_deref()
    }

    pub async fn fetch(&mut self) -> Result<FetchStatus> {
        let response = self
            .client
            .get_agent_config_v2()
            .await
            .map_err(|e| anyhow::anyhow!("failed to fetch config: {e}"))?;
        let mut document = response.into_inner();
        let policy = AgentPolicy {
            config_poll_interval_seconds: document
                .agent
                .config_poll_interval_seconds
                .clamp(5, 86_400) as u64,
            heartbeat_interval_seconds: document.agent.heartbeat_interval_seconds.clamp(5, 300)
                as u64,
        };

        // Certificate actions must complete before the candidate configuration is
        // checked or promoted because managed TLS paths are referenced by sing-box.
        self.certificate_manager
            .reconcile(&document.actions)
            .await?;

        // Observing a revision is not the same as applying it. A candidate may
        // have failed preflight or startup because a certificate/dependency was
        // temporarily unavailable; treating that revision as unchanged leaves
        // the agent heartbeating forever without a sing-box process. Only a
        // revision backed by the committed active config can be skipped.
        if is_applied_revision(
            self.active_path.exists(),
            self.persisted.applied_revision.as_deref(),
            &document.singbox.revision,
        ) {
            self.observed_revision = Some(document.singbox.revision);
            return Ok(FetchStatus::Unchanged(policy));
        }
        self.observed_revision = Some(document.singbox.revision.clone());
        let normalized =
            normalize_managed_certificate_tls(&mut document.singbox.config, &self.state_dir)?;
        for item in normalized {
            info!(
                inbound_index = item.inbound_index,
                certificate_id = %item.certificate_id,
                removed_fields = ?item.removed_fields,
                "normalized managed certificate TLS input"
            );
        }
        let v2ray_listen = extract_v2ray_listen(&document.singbox.config);

        let serialized = serde_json::to_vec_pretty(&document.singbox.config)
            .context("failed to serialize config")?;
        write_secret_file(&self.candidate_path, &serialized)?;
        info!(
            "candidate config written to {}",
            self.candidate_path.display()
        );
        Ok(FetchStatus::Updated {
            policy,
            candidate: CandidateConfig {
                revision: document.singbox.revision,
                materialized_node_ids: document.singbox.materialized_node_ids,
                v2ray_listen,
            },
        })
    }

    pub fn promote_candidate(&self) -> Result<()> {
        std::fs::rename(&self.candidate_path, &self.active_path)
            .context("failed to promote candidate config")
    }

    pub fn commit_applied(&mut self, candidate: &CandidateConfig) -> Result<()> {
        replace_from(
            &self.active_path,
            &self.last_good_path,
            &self.state_dir.join("last-known-good.json.tmp"),
        )?;
        self.persisted.applied_revision = Some(candidate.revision.clone());
        self.persisted.active_node_ids = candidate.materialized_node_ids.clone();
        self.persisted.applied_at = Some(Utc::now());
        self.v2ray_listen = candidate.v2ray_listen.clone();
        self.persist_state()
    }

    pub fn rollback(&mut self) -> Result<bool> {
        if !self.last_good_path.exists() {
            return Ok(false);
        }
        replace_from(
            &self.last_good_path,
            &self.active_path,
            &self.state_dir.join("active.json.rollback"),
        )?;
        self.v2ray_listen = read_v2ray_listen(&self.active_path);
        Ok(true)
    }

    fn persist_state(&self) -> Result<()> {
        let temp = self.state_dir.join("state.json.tmp");
        let bytes = serde_json::to_vec_pretty(&self.persisted)?;
        write_secret_file(&temp, &bytes)?;
        std::fs::rename(temp, &self.state_path).context("failed to persist agent state")
    }
}

fn write_secret_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("failed to write {}", path.display()))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn replace_from(source: &Path, destination: &Path, temp: &Path) -> Result<()> {
    let bytes =
        std::fs::read(source).with_context(|| format!("failed to read {}", source.display()))?;
    write_secret_file(temp, &bytes)?;
    std::fs::rename(temp, destination)
        .with_context(|| format!("failed to replace {}", destination.display()))
}

fn read_v2ray_listen(path: &Path) -> Option<String> {
    let config = std::fs::read(path).ok()?;
    let config: serde_json::Map<String, serde_json::Value> =
        serde_json::from_slice(&config).ok()?;
    extract_v2ray_listen(&config)
}

/// Reads `experimental.v2ray_api.listen` from a sing-box config object.
fn extract_v2ray_listen(config: &serde_json::Map<String, serde_json::Value>) -> Option<String> {
    config
        .get("experimental")?
        .get("v2ray_api")?
        .get("listen")?
        .as_str()
        .map(String::from)
}

fn is_applied_revision(
    active_config_exists: bool,
    applied_revision: Option<&str>,
    fetched_revision: &str,
) -> bool {
    active_config_exists && applied_revision == Some(fetched_revision)
}

#[derive(Debug, PartialEq, Eq)]
struct ManagedTlsNormalization {
    inbound_index: usize,
    certificate_id: String,
    removed_fields: Vec<&'static str>,
}

fn normalize_managed_certificate_tls(
    config: &mut serde_json::Map<String, serde_json::Value>,
    state_dir: &Path,
) -> Result<Vec<ManagedTlsNormalization>> {
    let Some(inbounds) = config
        .get_mut("inbounds")
        .and_then(|value| value.as_array_mut())
    else {
        return Ok(Vec::new());
    };
    let local_root = state_dir.join("certificates");
    let control_plane_root = Path::new(CONTROL_PLANE_CERTIFICATE_ROOT);
    let mut normalized = Vec::new();

    for (inbound_index, inbound) in inbounds.iter_mut().enumerate() {
        let Some(tls) = inbound
            .as_object_mut()
            .and_then(|inbound| inbound.get_mut("tls"))
            .and_then(|tls| tls.as_object_mut())
        else {
            continue;
        };
        let certificate_path = tls
            .get("certificate_path")
            .and_then(|value| value.as_str())
            .map(str::to_owned);
        let key_path = tls
            .get("key_path")
            .and_then(|value| value.as_str())
            .map(str::to_owned);
        let certificate_id = certificate_path
            .as_deref()
            .map(|path| {
                parse_managed_material_path(path, &local_root, control_plane_root, "fullchain.pem")
            })
            .transpose()?
            .flatten();
        let key_certificate_id = key_path
            .as_deref()
            .map(|path| {
                parse_managed_material_path(
                    path,
                    &local_root,
                    control_plane_root,
                    "private-key.pem",
                )
            })
            .transpose()?
            .flatten();

        let certificate_id = match (certificate_id, key_certificate_id) {
            (None, None) => continue,
            (Some(certificate_id), Some(key_certificate_id))
                if certificate_id == key_certificate_id =>
            {
                certificate_id
            }
            (certificate_id, key_certificate_id) => {
                bail!(
                    "inbound[{inbound_index}] managed certificate/key paths do not identify the same certificate: certificate={certificate_id:?}, key={key_certificate_id:?}"
                );
            }
        };

        let mut removed_fields = Vec::new();
        for field in MANAGED_TLS_INLINE_FIELDS {
            if tls.remove(field).is_some() {
                removed_fields.push(field);
            }
        }
        let current = local_root.join(&certificate_id).join("current");
        tls.insert(
            "certificate_path".into(),
            serde_json::Value::String(current.join("fullchain.pem").to_string_lossy().into_owned()),
        );
        tls.insert(
            "key_path".into(),
            serde_json::Value::String(
                current
                    .join("private-key.pem")
                    .to_string_lossy()
                    .into_owned(),
            ),
        );
        normalized.push(ManagedTlsNormalization {
            inbound_index,
            certificate_id,
            removed_fields,
        });
    }
    Ok(normalized)
}

fn parse_managed_material_path(
    value: &str,
    local_root: &Path,
    control_plane_root: &Path,
    expected_file: &str,
) -> Result<Option<String>> {
    let path = Path::new(value);
    let relative = match path.strip_prefix(local_root) {
        Ok(relative) => Some(relative),
        Err(_) => path.strip_prefix(control_plane_root).ok(),
    };
    let Some(relative) = relative else {
        return Ok(None);
    };
    let components = relative.components().collect::<Vec<_>>();
    let [
        std::path::Component::Normal(certificate_id),
        std::path::Component::Normal(current),
        std::path::Component::Normal(file),
    ] = components.as_slice()
    else {
        bail!("invalid managed certificate path: {value}");
    };
    if *current != "current" || *file != expected_file {
        bail!("invalid managed certificate path: {value}");
    }
    let certificate_id = certificate_id
        .to_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("invalid managed certificate id in path: {value}"))?;
    Ok(Some(certificate_id.to_owned()))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::json;

    use super::{
        ManagedTlsNormalization, extract_v2ray_listen, is_applied_revision,
        normalize_managed_certificate_tls,
    };

    #[test]
    fn managed_tls_removes_inline_material_and_uses_local_state_dir() {
        let mut config = json!({
            "inbounds": [{
                "type": "vless",
                "tls": {
                    "enabled": true,
                    "certificate": ["stale-certificate"],
                    "certificate_path": "/var/lib/blossom-agent/certificates/cert-1/current/fullchain.pem",
                    "key": ["stale-key"],
                    "key_path": "/var/lib/blossom-agent/certificates/cert-1/current/private-key.pem",
                    "acme": { "domain": ["legacy.example.com"] },
                    "certificate_provider": "legacy"
                }
            }]
        })
        .as_object()
        .unwrap()
        .clone();

        let normalized =
            normalize_managed_certificate_tls(&mut config, Path::new("/custom/blossom-state"))
                .unwrap();

        assert_eq!(
            normalized,
            vec![ManagedTlsNormalization {
                inbound_index: 0,
                certificate_id: "cert-1".into(),
                removed_fields: vec!["certificate", "key", "acme", "certificate_provider"],
            }]
        );
        let tls = config["inbounds"][0]["tls"].as_object().unwrap();
        assert_eq!(
            tls["certificate_path"],
            "/custom/blossom-state/certificates/cert-1/current/fullchain.pem"
        );
        assert_eq!(
            tls["key_path"],
            "/custom/blossom-state/certificates/cert-1/current/private-key.pem"
        );
        for field in ["certificate", "key", "acme", "certificate_provider"] {
            assert!(!tls.contains_key(field));
        }
    }

    #[test]
    fn manual_tls_paths_are_not_modified() {
        let mut config = json!({
            "inbounds": [{
                "tls": {
                    "enabled": true,
                    "certificate": ["manual-certificate"],
                    "certificate_path": "/etc/sing-box/fullchain.pem",
                    "key": ["manual-key"],
                    "key_path": "/etc/sing-box/private-key.pem"
                }
            }]
        })
        .as_object()
        .unwrap()
        .clone();
        let original = config.clone();

        assert!(
            normalize_managed_certificate_tls(&mut config, Path::new("/custom/state"))
                .unwrap()
                .is_empty()
        );
        assert_eq!(config, original);
    }

    #[test]
    fn mismatched_managed_certificate_paths_are_rejected() {
        let mut config = json!({
            "inbounds": [{
                "tls": {
                    "certificate_path": "/var/lib/blossom-agent/certificates/cert-1/current/fullchain.pem",
                    "key_path": "/var/lib/blossom-agent/certificates/cert-2/current/private-key.pem"
                }
            }]
        })
        .as_object()
        .unwrap()
        .clone();

        let error = normalize_managed_certificate_tls(&mut config, Path::new("/custom/state"))
            .unwrap_err()
            .to_string();
        assert!(error.contains("do not identify the same certificate"));
    }

    #[test]
    fn observed_but_unapplied_revision_must_be_retried() {
        assert!(!is_applied_revision(false, None, "revision-1"));
        assert!(!is_applied_revision(
            false,
            Some("revision-1"),
            "revision-1"
        ));
        assert!(!is_applied_revision(true, None, "revision-1"));
    }

    #[test]
    fn committed_active_revision_is_unchanged() {
        assert!(is_applied_revision(true, Some("revision-1"), "revision-1"));
        assert!(!is_applied_revision(true, Some("revision-1"), "revision-2"));
    }

    #[test]
    fn extracts_listen_when_present() {
        let config = json!({
            "experimental": {
                "v2ray_api": {
                    "listen": "127.0.0.1:8080"
                }
            }
        })
        .as_object()
        .unwrap()
        .clone();
        assert_eq!(
            extract_v2ray_listen(&config),
            Some("127.0.0.1:8080".to_string())
        );
    }

    #[test]
    fn returns_none_when_experimental_missing() {
        let config = json!({}).as_object().unwrap().clone();
        assert_eq!(extract_v2ray_listen(&config), None);
    }

    #[test]
    fn returns_none_when_v2ray_api_missing() {
        let config = json!({ "experimental": {} }).as_object().unwrap().clone();
        assert_eq!(extract_v2ray_listen(&config), None);
    }

    #[test]
    fn returns_none_when_listen_not_string() {
        let config = json!({
            "experimental": {
                "v2ray_api": {
                    "listen": 8080
                }
            }
        })
        .as_object()
        .unwrap()
        .clone();
        assert_eq!(extract_v2ray_listen(&config), None);
    }
}
