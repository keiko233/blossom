//! Fetches the node's sing-box config from the blossom API and materialises it
//! on disk for sing-box to read. The config is treated as opaque JSON — the
//! server has already validated it and injected the `experimental.v2ray_api`
//! hooks, so the agent only diffs and writes, never interprets.

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
        })
    }

    /// Path sing-box is launched against.
    pub fn config_path(&self) -> &PathBuf {
        &self.config_path
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

        // Pretty-print so the on-disk file is human-inspectable during debugging;
        // the exact bytes are what we diff against next time.
        let serialized =
            serde_json::to_string_pretty(&config).context("failed to serialize config")?;

        if self.is_unchanged(&serialized) {
            info!("config unchanged, skipping write");
            return Ok(FetchStatus::Unchanged);
        }

        std::fs::write(&self.config_path, &serialized).with_context(|| {
            format!("failed to write config to {}", self.config_path.display())
        })?;
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
