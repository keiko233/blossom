//! Fetches the server's combined multi-inbound sing-box config from the blossom
//! API and materialises it on disk. The config is otherwise treated as opaque
//! JSON — the control plane has already validated it and injected the
//! `experimental.v2ray_api` hooks, so the agent only diffs and writes, never
//! interprets, with one exception: it reads `experimental.v2ray_api.listen` to
//! find the stats endpoint.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tracing::info;

use crate::certificate::CertificateManager;
use crate::client::Client;

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
        let document = response.into_inner();
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

        if self.observed_revision.as_deref() == Some(document.singbox.revision.as_str())
            || (self.active_path.exists()
                && self.persisted.applied_revision.as_deref()
                    == Some(document.singbox.revision.as_str()))
        {
            self.observed_revision = Some(document.singbox.revision);
            return Ok(FetchStatus::Unchanged(policy));
        }
        self.observed_revision = Some(document.singbox.revision.clone());
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::extract_v2ray_listen;

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
