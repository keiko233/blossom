//! Fetches the node's sing-box config from the blossom API and materialises it
//! on disk for sing-box to read. The config is otherwise treated as opaque JSON
//! — the server has already validated it and injected the `experimental.v2ray_api`
//! hooks, so the agent only diffs and writes, never interprets, with one
//! exception: it reads `experimental.v2ray_api.listen` to find the stats
//! endpoint.

use std::path::PathBuf;

use anyhow::{Context, Result};
use temp_dir::TempDir;
use tracing::info;

use crate::client::Client;

/// Whether a fetch produced a config different from what is already on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchStatus {
    /// The runtime file was rewritten; sing-box needs a reload.
    Updated,
    /// Config identical to the last write; nothing to do.
    Unchanged,
}

pub struct ConfigManager {
    client: Client,
    /// Kept alive so the temp dir (and the secret-bearing config in it) is
    /// removed on drop; never persisted to a durable path.
    _temp: TempDir,
    config_path: PathBuf,
    /// Serialized form of the last config written, for cheap diffing.
    last: Option<String>,
    /// The sing-box v2ray API listen address extracted from the latest config.
    v2ray_listen: Option<String>,
}

impl ConfigManager {
    pub fn new(client: Client) -> Result<Self> {
        let temp = TempDir::new().context("failed to create temp dir")?;
        let config_path = temp.child("singbox-runtime.json");
        Ok(Self {
            client,
            _temp: temp,
            config_path,
            last: None,
            v2ray_listen: None,
        })
    }

    /// Path sing-box is launched against.
    pub fn config_path(&self) -> &PathBuf {
        &self.config_path
    }

    /// The sing-box v2ray API listen address, if the latest config provided one.
    pub fn v2ray_api_listen(&self) -> Option<&str> {
        self.v2ray_listen.as_deref()
    }

    /// Pulls the latest config, writes it if it changed, and reports whether a
    /// reload is needed. The comparison is against the last write this process
    /// made (and, on the first call, an existing file left by a prior run).
    pub async fn fetch(&mut self) -> Result<FetchStatus> {
        let response = self
            .client
            .get_agent_config()
            .await
            .map_err(|e| anyhow::anyhow!("failed to fetch config: {e}"))?;
        let config = response.into_inner();
        self.v2ray_listen = extract_v2ray_listen(&config);

        // Pretty-print so the on-disk file is human-inspectable during debugging;
        // the exact bytes are what we diff against next time.
        let serialized =
            serde_json::to_string_pretty(&config).context("failed to serialize config")?;

        if self.is_unchanged(&serialized) {
            info!("config unchanged, skipping write");
            return Ok(FetchStatus::Unchanged);
        }

        std::fs::write(&self.config_path, &serialized)
            .with_context(|| format!("failed to write config to {}", self.config_path.display()))?;
        self.last = Some(serialized);
        info!("config written to {}", self.config_path.display());
        Ok(FetchStatus::Updated)
    }

    fn is_unchanged(&self, serialized: &str) -> bool {
        if let Some(last) = &self.last {
            return last == serialized;
        }
        // First fetch of this process: fall back to the file, so a restart that
        // pulls an identical config doesn't force an unnecessary reload.
        std::fs::read_to_string(&self.config_path)
            .map(|existing| existing == serialized)
            .unwrap_or(false)
    }
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
