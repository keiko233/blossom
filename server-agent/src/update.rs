//! Release downloads and self-update state for the agent and sing-box.
//!
//! Release assets are resolved through the GitHub API, verified against the
//! release asset's `digest` (SHA-256), and installed atomically. The agent can
//! replace its own executable; the supervising entrypoint restarts it on
//! [`AGENT_RESTART_EXIT_CODE`]. A pending-update marker lets the next start
//! distinguish a successful replacement from a rolled-back crash loop.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use flate2::read::GzDecoder;
use reqwest::Client;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tar::Archive;
use tracing::{info, warn};

pub const AGENT_RESTART_EXIT_CODE: i32 = 75;

/// Observes every agent/sing-box status transition. The WebSocket bridge uses
/// it to stream `update.status` frames while a triggered update runs; the
/// observer must be cheap and must not block.
pub type StatusObserver = Arc<dyn Fn(&UpdateStatus, &UpdateStatus) + Send + Sync>;

const USER_AGENT: &str = concat!("blossom-server-agent/", env!("CARGO_PKG_VERSION"));
const AGENT_TAG_PREFIX: &str = "v";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateState {
    Unknown,
    Idle,
    UpToDate,
    Checking,
    Downloading,
    Verifying,
    Applying,
    Restarting,
    Failed,
    Disabled,
}

impl UpdateState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Idle => "idle",
            Self::UpToDate => "up_to_date",
            Self::Checking => "checking",
            Self::Downloading => "downloading",
            Self::Verifying => "verifying",
            Self::Applying => "applying",
            Self::Restarting => "restarting",
            Self::Failed => "failed",
            Self::Disabled => "disabled",
        }
    }
}

#[derive(Debug, Clone)]
pub struct UpdateStatus {
    pub target_version: Option<String>,
    pub state: UpdateState,
    pub message: Option<String>,
    pub checked_at: Option<DateTime<Utc>>,
}

impl Default for UpdateStatus {
    fn default() -> Self {
        Self {
            target_version: None,
            state: UpdateState::Idle,
            message: None,
            checked_at: None,
        }
    }
}

impl UpdateStatus {
    fn set(&mut self, state: UpdateState, target: Option<String>, message: Option<String>) {
        self.state = state;
        self.target_version = target;
        self.message = message;
        self.checked_at = Some(Utc::now());
    }
}

#[derive(Debug, Clone)]
pub struct UpdateConfig {
    pub state_dir: PathBuf,
    pub download_dir: PathBuf,
    pub github_api: String,
    pub agent_repo: String,
    pub singbox_repo: String,
    pub github_token: Option<String>,
    pub self_update: bool,
    pub retry_after: Duration,
}

#[derive(Debug, Clone)]
pub struct StagedSingBox {
    pub version: String,
    pub path: PathBuf,
}

#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}

#[derive(Debug, Clone, Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
}

#[derive(Debug, Clone)]
struct ResolvedRelease {
    tag: String,
    version: String,
    assets: Vec<Asset>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PendingAgentUpdate {
    target_version: String,
    previous_version: String,
    started_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize)]
struct FailedUpdate {
    target_version: String,
    message: String,
    at: DateTime<Utc>,
}

pub struct UpdateManager {
    http: Client,
    config: UpdateConfig,
    current_agent_version: String,
    agent_status: UpdateStatus,
    singbox_status: UpdateStatus,
    failed_agent: Option<FailedUpdate>,
    failed_singbox: Option<FailedUpdate>,
    agent_latest: Option<(ResolvedRelease, Instant)>,
    singbox_latest: Option<(ResolvedRelease, Instant)>,
    status_observer: Option<StatusObserver>,
}

impl UpdateManager {
    pub fn new(
        config: UpdateConfig,
        current_agent_version: String,
        current_singbox_version: Option<String>,
    ) -> Result<Self> {
        fs::create_dir_all(&config.state_dir).with_context(|| {
            format!(
                "failed to create update state dir {}",
                config.state_dir.display()
            )
        })?;
        fs::create_dir_all(&config.download_dir).with_context(|| {
            format!(
                "failed to create update download dir {}",
                config.download_dir.display()
            )
        })?;
        let mut headers = HeaderMap::new();
        if let Some(token) = &config.github_token {
            let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
                .context("AGENT_GITHUB_TOKEN contains invalid header characters")?;
            value.set_sensitive(true);
            headers.insert(AUTHORIZATION, value);
        }
        let http = Client::builder()
            .user_agent(USER_AGENT)
            .default_headers(headers)
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(180))
            .build()
            .context("failed to build release download client")?;

        let mut manager = Self {
            http,
            config,
            current_agent_version,
            agent_status: UpdateStatus::default(),
            singbox_status: UpdateStatus {
                target_version: current_singbox_version,
                state: UpdateState::Idle,
                message: None,
                checked_at: None,
            },
            failed_agent: None,
            failed_singbox: None,
            agent_latest: None,
            singbox_latest: None,
            status_observer: None,
        };
        manager.recover_pending_update()?;
        manager.failed_agent = manager.read_failed("agent-update-failed.json");
        manager.failed_singbox = manager.read_failed("sing-box-update-failed.json");
        if let Some(failed) = &manager.failed_agent {
            manager.agent_status.set(
                UpdateState::Failed,
                Some(failed.target_version.clone()),
                Some(failed.message.clone()),
            );
        }
        if let Some(failed) = &manager.failed_singbox {
            manager.singbox_status.set(
                UpdateState::Failed,
                Some(failed.target_version.clone()),
                Some(failed.message.clone()),
            );
        }
        Ok(manager)
    }

    pub fn agent_status(&self) -> &UpdateStatus {
        &self.agent_status
    }

    pub fn singbox_status(&self) -> &UpdateStatus {
        &self.singbox_status
    }

    /// Installs a transition observer (see [`StatusObserver`]).
    pub fn set_status_observer(&mut self, observer: StatusObserver) {
        self.status_observer = Some(observer);
    }

    /// Clears a recorded agent failure so a forced trigger retries at once
    /// instead of waiting out the retry window.
    pub fn clear_agent_cooldown(&mut self) {
        self.failed_agent = None;
        let _ = fs::remove_file(self.config.state_dir.join("agent-update-failed.json"));
    }

    /// Clears a recorded sing-box failure so a forced trigger retries at once.
    pub fn clear_singbox_cooldown(&mut self) {
        self.failed_singbox = None;
        let _ = fs::remove_file(self.config.state_dir.join("sing-box-update-failed.json"));
    }

    fn notify_status(&self) {
        if let Some(observer) = &self.status_observer {
            observer(&self.agent_status, &self.singbox_status);
        }
    }

    fn set_agent_status(
        &mut self,
        state: UpdateState,
        target: Option<String>,
        message: Option<String>,
    ) {
        self.agent_status.set(state, target, message);
        self.notify_status();
    }

    fn set_singbox_status(
        &mut self,
        state: UpdateState,
        target: Option<String>,
        message: Option<String>,
    ) {
        self.singbox_status.set(state, target, message);
        self.notify_status();
    }

    /// Downloads and installs a newer agent binary when `desired` differs from
    /// the running version. Returns true when the caller must exit so the
    /// supervisor can start the replacement.
    pub async fn maybe_update_agent(&mut self, desired: &str, current_exe: &Path) -> Result<bool> {
        let desired_key = normalize_version(desired);
        if desired_key == self.current_agent_version {
            self.set_agent_status(UpdateState::UpToDate, Some(desired_key), None);
            self.clear_failed_agent();
            return Ok(false);
        }
        if !self.config.self_update {
            self.set_agent_status(
                UpdateState::Disabled,
                Some(desired_key),
                Some("self-update is disabled; restart with AGENT_SELF_UPDATE=1".to_string()),
            );
            return Ok(false);
        }

        if self.in_agent_cooldown(&desired_key) {
            return Ok(false);
        }
        self.set_agent_status(UpdateState::Checking, Some(desired_key), None);
        let release = match self.resolve_agent_release(desired).await {
            Ok(release) => release,
            Err(error) => {
                self.fail_agent(desired, &error.to_string());
                return Err(error);
            }
        };
        if release.version == self.current_agent_version {
            self.set_agent_status(UpdateState::UpToDate, Some(release.version.clone()), None);
            self.clear_failed_agent();
            return Ok(false);
        }
        if self.in_agent_cooldown(&release.version) {
            return Ok(false);
        }

        let asset_name = match release_arch() {
            Ok(arch) => format!("server-agent-linux-{arch}"),
            Err(error) => {
                self.fail_agent(desired, &error.to_string());
                return Err(error);
            }
        };
        let asset = match find_asset(&release, &asset_name) {
            Ok(asset) => asset,
            Err(error) => {
                self.fail_agent(desired, &error.to_string());
                return Err(error);
            }
        };
        let temp = self
            .config
            .download_dir
            .join(format!("server-agent-{}.new", release.version));
        self.set_agent_status(
            UpdateState::Downloading,
            Some(release.version.clone()),
            None,
        );
        if let Err(error) = self.download_asset(asset, &temp).await {
            self.fail_agent(desired, &error.to_string());
            return Err(error);
        }

        let previous = current_exe.to_path_buf();
        let backup = current_exe.with_extension("prev");
        let install_result = (|| -> Result<()> {
            set_executable(&temp)?;
            let pending = PendingAgentUpdate {
                target_version: release.version.clone(),
                previous_version: self.current_agent_version.clone(),
                started_at: Utc::now(),
            };
            self.write_json("agent-update.json", &pending)?;
            if previous.exists() {
                let backup_temp = backup.with_extension("prev.tmp");
                fs::copy(&previous, &backup_temp).with_context(|| {
                    format!("failed to back up agent binary {}", previous.display())
                })?;
                set_executable(&backup_temp)?;
                fs::rename(&backup_temp, &backup)
                    .context("failed to install previous agent binary backup")?;
            }
            fs::rename(&temp, &previous).with_context(|| {
                format!("failed to install agent binary {}", previous.display())
            })?;
            Ok(())
        })();
        if let Err(error) = install_result {
            let _ = fs::remove_file(&temp);
            let _ = fs::remove_file(self.config.state_dir.join("agent-update.json"));
            self.set_agent_status(
                UpdateState::Applying,
                Some(release.version.clone()),
                Some(error.to_string()),
            );
            self.fail_agent(desired, &error.to_string());
            return Err(error);
        }

        self.set_agent_status(UpdateState::Restarting, Some(release.version.clone()), None);
        info!(
            from = %self.current_agent_version,
            to = %release.version,
            "agent binary replaced; exiting for supervisor restart"
        );
        Ok(true)
    }

    /// Resolves and downloads a sing-box release into a staging path. The
    /// caller preflights it and installs it with [`Self::install_singbox`].
    pub async fn stage_singbox_update(
        &mut self,
        desired: &str,
        current_version: Option<&str>,
    ) -> Result<Option<StagedSingBox>> {
        let desired_key = normalize_version(desired);
        if desired_key != "latest" && current_version == Some(desired_key.as_str()) {
            self.set_singbox_status(UpdateState::UpToDate, Some(desired_key), None);
            self.clear_failed_singbox();
            return Ok(None);
        }
        if self.in_singbox_cooldown(&desired_key) {
            return Ok(None);
        }
        self.set_singbox_status(UpdateState::Checking, Some(desired_key), None);
        let release = match self.resolve_singbox_release(desired).await {
            Ok(release) => release,
            Err(error) => {
                self.fail_singbox(desired, &error.to_string());
                return Err(error);
            }
        };
        if !supports_singbox_version(&release.version) {
            let message = format!(
                "sing-box {} is too old; connection-stream traffic requires >= 1.14",
                release.version
            );
            self.fail_singbox(desired, &message);
            bail!("{message}");
        }
        if current_version == Some(release.version.as_str()) {
            self.set_singbox_status(UpdateState::UpToDate, Some(release.version.clone()), None);
            self.clear_failed_singbox();
            return Ok(None);
        }
        if self.in_singbox_cooldown(&release.version) {
            return Ok(None);
        }

        let release_arch = match release_arch() {
            Ok(arch) => arch,
            Err(error) => {
                self.fail_singbox(desired, &error.to_string());
                return Err(error);
            }
        };
        let asset_name = format!(
            "sing-box-{}-linux-{release_arch}-musl.tar.gz",
            release.version
        );
        let asset = match find_asset(&release, &asset_name) {
            Ok(asset) => asset,
            Err(error) => {
                self.fail_singbox(desired, &error.to_string());
                return Err(error);
            }
        };
        let archive = self
            .config
            .download_dir
            .join(format!("sing-box-{}.tar.gz", release.version));
        self.set_singbox_status(
            UpdateState::Downloading,
            Some(release.version.clone()),
            None,
        );
        if let Err(error) = self.download_asset(asset, &archive).await {
            self.fail_singbox(desired, &error.to_string());
            return Err(error);
        }

        self.set_singbox_status(UpdateState::Verifying, Some(release.version.clone()), None);
        let staged_path = self
            .config
            .download_dir
            .join(format!("sing-box-{}.new", release.version));
        if let Err(error) = extract_singbox(&archive, &staged_path) {
            let _ = fs::remove_file(&archive);
            let _ = fs::remove_file(&staged_path);
            self.fail_singbox(desired, &error.to_string());
            return Err(error);
        }
        let _ = fs::remove_file(&archive);
        Ok(Some(StagedSingBox {
            version: release.version,
            path: staged_path,
        }))
    }

    /// Atomically installs a preflighted sing-box binary, keeping the previous
    /// executable for rollback.
    pub fn install_singbox(
        &mut self,
        staged: &StagedSingBox,
        bin: &Path,
        desired: &str,
    ) -> Result<()> {
        self.set_singbox_status(UpdateState::Applying, Some(staged.version.clone()), None);
        if let Err(error) = set_executable(&staged.path) {
            self.fail_singbox(desired, &error.to_string());
            return Err(error);
        }
        let backup = bin.with_extension("prev");
        let result = (|| -> Result<()> {
            if bin.exists() {
                let backup_temp = backup.with_extension("prev.tmp");
                fs::copy(bin, &backup_temp)
                    .with_context(|| format!("failed to back up sing-box {}", bin.display()))?;
                set_executable(&backup_temp)?;
                fs::rename(&backup_temp, &backup)
                    .context("failed to install previous sing-box backup")?;
            }
            fs::rename(&staged.path, bin)
                .with_context(|| format!("failed to install sing-box {}", bin.display()))?;
            Ok(())
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(&staged.path);
            self.fail_singbox(desired, &error.to_string());
            return Err(error);
        }
        Ok(())
    }

    pub fn singbox_update_succeeded(&mut self, version: &str) {
        self.set_singbox_status(UpdateState::UpToDate, Some(version.to_string()), None);
        self.clear_failed_singbox();
    }

    pub fn singbox_update_failed(&mut self, version: &str, message: &str) {
        self.fail_singbox(version, message);
    }

    fn recover_pending_update(&mut self) -> Result<()> {
        let path = self.config.state_dir.join("agent-update.json");
        let pending = match read_json::<PendingAgentUpdate>(&path) {
            Ok(Some(pending)) => pending,
            Ok(None) => return Ok(()),
            Err(error) => {
                warn!("ignoring unreadable agent update marker: {error}");
                let _ = fs::remove_file(&path);
                return Ok(());
            }
        };
        if pending.target_version == self.current_agent_version {
            let _ = fs::remove_file(&path);
            let _ = fs::remove_file(self.config.state_dir.join("agent-update-failed.json"));
            self.set_agent_status(UpdateState::UpToDate, Some(pending.target_version), None);
            return Ok(());
        }
        let failed = FailedUpdate {
            target_version: pending.target_version.clone(),
            message: format!(
                "updated binary did not start; running {} after rollback",
                self.current_agent_version
            ),
            at: Utc::now(),
        };
        let _ = fs::remove_file(&path);
        self.write_json("agent-update-failed.json", &failed)?;
        self.failed_agent = Some(failed);
        Ok(())
    }

    fn fail_agent(&mut self, target: &str, message: &str) {
        let failed = FailedUpdate {
            target_version: normalize_version(target),
            message: message.chars().take(4096).collect(),
            at: Utc::now(),
        };
        let _ = self.write_json("agent-update-failed.json", &failed);
        self.set_agent_status(
            UpdateState::Failed,
            Some(failed.target_version.clone()),
            Some(failed.message.clone()),
        );
        self.failed_agent = Some(failed);
    }

    fn fail_singbox(&mut self, target: &str, message: &str) {
        let failed = FailedUpdate {
            target_version: normalize_version(target),
            message: message.chars().take(4096).collect(),
            at: Utc::now(),
        };
        let _ = self.write_json("sing-box-update-failed.json", &failed);
        self.set_singbox_status(
            UpdateState::Failed,
            Some(failed.target_version.clone()),
            Some(failed.message.clone()),
        );
        self.failed_singbox = Some(failed);
    }

    fn clear_failed_agent(&mut self) {
        if self.failed_agent.take().is_some() {
            let _ = fs::remove_file(self.config.state_dir.join("agent-update-failed.json"));
        }
    }

    fn clear_failed_singbox(&mut self) {
        if self.failed_singbox.take().is_some() {
            let _ = fs::remove_file(self.config.state_dir.join("sing-box-update-failed.json"));
        }
    }

    fn in_agent_cooldown(&mut self, target: &str) -> bool {
        let cooling = self.failed_agent.as_ref().is_some_and(|failed| {
            failed.target_version == target
                && Utc::now()
                    .signed_duration_since(failed.at)
                    .to_std()
                    .is_ok_and(|elapsed| elapsed < self.config.retry_after)
        });
        if cooling && let Some(failed) = &self.failed_agent {
            self.set_agent_status(
                UpdateState::Failed,
                Some(failed.target_version.clone()),
                Some(failed.message.clone()),
            );
        }
        cooling
    }

    fn in_singbox_cooldown(&mut self, target: &str) -> bool {
        let cooling = self.failed_singbox.as_ref().is_some_and(|failed| {
            failed.target_version == target
                && Utc::now()
                    .signed_duration_since(failed.at)
                    .to_std()
                    .is_ok_and(|elapsed| elapsed < self.config.retry_after)
        });
        if cooling && let Some(failed) = &self.failed_singbox {
            self.set_singbox_status(
                UpdateState::Failed,
                Some(failed.target_version.clone()),
                Some(failed.message.clone()),
            );
        }
        cooling
    }

    async fn resolve_agent_release(&mut self, desired: &str) -> Result<ResolvedRelease> {
        if desired == "latest" {
            if let Some((release, at)) = &self.agent_latest
                && at.elapsed() < Duration::from_secs(6 * 60 * 60)
            {
                return Ok(release.clone());
            }
            let expected_asset = format!("server-agent-linux-{}", release_arch()?);
            let url = format!(
                "{}/repos/{}/releases?per_page=30",
                self.config.github_api, self.config.agent_repo
            );
            let releases: Vec<Release> = self.get_json(&url).await?;
            let release = releases
                .into_iter()
                .find(|release| {
                    !release.draft
                        && !release.prerelease
                        && is_stable_version(AGENT_TAG_PREFIX, &release.tag_name)
                        && release
                            .assets
                            .iter()
                            .any(|asset| asset.name == expected_asset)
                })
                .context("no published v* release with server-agent binary found")?;
            let resolved = resolve_release(release, AGENT_TAG_PREFIX)?;
            self.agent_latest = Some((resolved.clone(), Instant::now()));
            return Ok(resolved);
        }
        let version = normalize_version(desired);
        let tag = format!("{AGENT_TAG_PREFIX}{version}");
        let url = format!(
            "{}/repos/{}/releases/tags/{}",
            self.config.github_api, self.config.agent_repo, tag
        );
        let release: Release = self.get_json(&url).await?;
        resolve_release(release, AGENT_TAG_PREFIX)
    }

    async fn resolve_singbox_release(&mut self, desired: &str) -> Result<ResolvedRelease> {
        if desired == "latest" {
            if let Some((release, at)) = &self.singbox_latest
                && at.elapsed() < Duration::from_secs(6 * 60 * 60)
            {
                return Ok(release.clone());
            }
            let url = format!(
                "{}/repos/{}/releases?per_page=30",
                self.config.github_api, self.config.singbox_repo
            );
            let releases: Vec<Release> = self.get_json(&url).await?;
            let release = releases
                .into_iter()
                .find(|release| {
                    !release.draft
                        && !release.prerelease
                        && is_stable_version("v", &release.tag_name)
                })
                .context("no published sing-box release found")?;
            let resolved = resolve_release(release, "v")?;
            self.singbox_latest = Some((resolved.clone(), Instant::now()));
            return Ok(resolved);
        }
        let version = normalize_version(desired);
        let tag = format!("v{version}");
        let url = format!(
            "{}/repos/{}/releases/tags/{}",
            self.config.github_api, self.config.singbox_repo, tag
        );
        let release: Release = self.get_json(&url).await?;
        resolve_release(release, "v")
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, url: &str) -> Result<T> {
        let response = self
            .http
            .get(url)
            .send()
            .await
            .with_context(|| format!("failed to query {url}"))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            bail!(
                "GitHub release query {url} returned {status}: {}",
                body.chars().take(512).collect::<String>()
            );
        }
        response
            .json()
            .await
            .with_context(|| format!("failed to decode release response from {url}"))
    }

    async fn download_asset(&self, asset: &Asset, destination: &Path) -> Result<()> {
        let digest = asset.digest.as_deref().with_context(|| {
            format!("release asset {} has no GitHub SHA-256 digest", asset.name)
        })?;
        let response = self
            .http
            .get(&asset.browser_download_url)
            .send()
            .await
            .with_context(|| format!("failed to download {}", asset.name))?;
        let status = response.status();
        if !status.is_success() {
            bail!("download of {} returned {status}", asset.name);
        }
        let bytes = response
            .bytes()
            .await
            .with_context(|| format!("failed to read {}", asset.name))?;
        verify_digest(&bytes, digest)?;
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let temp = destination.with_extension("download");
        fs::write(&temp, &bytes).with_context(|| format!("failed to write {}", temp.display()))?;
        fs::rename(&temp, destination)
            .with_context(|| format!("failed to move download into {}", destination.display()))?;
        Ok(())
    }

    fn write_json<T: Serialize>(&self, name: &str, value: &T) -> Result<()> {
        let path = self.config.state_dir.join(name);
        let temp = path.with_extension("tmp");
        let bytes = serde_json::to_vec_pretty(value)?;
        fs::write(&temp, bytes).with_context(|| format!("failed to write {}", temp.display()))?;
        fs::rename(&temp, &path).with_context(|| format!("failed to replace {}", path.display()))
    }

    fn read_failed(&self, name: &str) -> Option<FailedUpdate> {
        read_json(&self.config.state_dir.join(name)).ok().flatten()
    }
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to read {}", path.display()));
        }
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .with_context(|| format!("failed to parse {}", path.display()))
}

fn resolve_release(release: Release, tag_prefix: &str) -> Result<ResolvedRelease> {
    let version = release
        .tag_name
        .strip_prefix(tag_prefix)
        .filter(|version| !version.is_empty())
        .with_context(|| {
            format!(
                "release tag {} does not start with {tag_prefix}",
                release.tag_name
            )
        })?
        .to_string();
    Ok(ResolvedRelease {
        tag: release.tag_name,
        version,
        assets: release.assets,
    })
}

fn find_asset<'a>(release: &'a ResolvedRelease, name: &str) -> Result<&'a Asset> {
    release
        .assets
        .iter()
        .find(|asset| asset.name == name)
        .with_context(|| format!("release {} has no asset {name}", release.tag))
}

fn normalize_version(value: &str) -> String {
    let value = value.trim();
    value
        .strip_prefix("server-agent-v")
        .or_else(|| value.strip_prefix(AGENT_TAG_PREFIX))
        .unwrap_or(value)
        .to_string()
}

fn is_stable_version(tag_prefix: &str, tag: &str) -> bool {
    let Some(version) = tag.strip_prefix(tag_prefix) else {
        return false;
    };
    let mut parts = version.split('.');
    matches!(
        (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next()
        ),
        (Some(major), Some(minor), Some(patch), None)
            if [major, minor, patch]
                .iter()
                .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
    )
}

pub fn supports_singbox_version(version: &str) -> bool {
    let version = normalize_version(version);
    let mut parts = version.split('.');
    let major = parts.next().and_then(|part| part.parse::<u64>().ok());
    let minor = parts.next().and_then(|part| part.parse::<u64>().ok());
    matches!((major, minor), (Some(major), Some(minor)) if major > 1 || (major == 1 && minor >= 14))
}

fn release_arch() -> Result<&'static str> {
    match std::env::consts::ARCH {
        "x86_64" => Ok("amd64"),
        "aarch64" => Ok("arm64"),
        other => bail!("no server-agent/sing-box release asset for architecture {other}"),
    }
}

fn set_executable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))
            .with_context(|| format!("failed to make {} executable", path.display()))?;
    }
    Ok(())
}

fn verify_digest(bytes: &[u8], digest: &str) -> Result<()> {
    let expected = digest
        .strip_prefix("sha256:")
        .with_context(|| format!("unsupported release digest format {digest}"))?;
    let actual = hex::encode(Sha256::digest(bytes));
    if !actual.eq_ignore_ascii_case(expected) {
        bail!("release checksum mismatch: expected {expected}, got {actual}");
    }
    Ok(())
}

fn extract_singbox(archive_path: &Path, destination: &Path) -> Result<()> {
    let file = fs::File::open(archive_path)
        .with_context(|| format!("failed to open {}", archive_path.display()))?;
    let mut archive = Archive::new(GzDecoder::new(file));
    let mut found = false;
    for entry in archive
        .entries()
        .context("failed to read sing-box archive")?
    {
        let mut entry = entry.context("failed to read sing-box archive entry")?;
        let path = entry.path().context("invalid sing-box archive path")?;
        if path.file_name().and_then(|name| name.to_str()) != Some("sing-box") {
            continue;
        }
        let mut output = fs::File::create(destination)
            .with_context(|| format!("failed to create {}", destination.display()))?;
        std::io::copy(&mut entry, &mut output)
            .with_context(|| format!("failed to extract {}", destination.display()))?;
        output.flush()?;
        found = true;
        break;
    }
    if !found {
        bail!("sing-box archive did not contain a sing-box binary");
    }
    set_executable(destination)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use flate2::Compression;
    use flate2::write::GzEncoder;
    use sha2::Digest;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::{
        Asset, Release, ResolvedRelease, UpdateConfig, UpdateManager, UpdateState, find_asset,
        is_stable_version, normalize_version, release_arch, resolve_release,
        supports_singbox_version, verify_digest,
    };

    fn release(tag: &str) -> Release {
        Release {
            tag_name: tag.to_string(),
            draft: false,
            prerelease: false,
            assets: vec![Asset {
                name: "asset".to_string(),
                browser_download_url: "https://example.invalid/asset".to_string(),
                digest: Some(format!("sha256:{}", "0".repeat(64))),
            }],
        }
    }

    #[test]
    fn normalizes_version_prefixes() {
        assert_eq!(normalize_version("v1.2.3"), "1.2.3");
        assert_eq!(normalize_version("server-agent-v1.2.3"), "1.2.3");
        assert_eq!(normalize_version(" latest "), "latest");
    }

    #[test]
    fn resolves_release_versions_from_tags() {
        let resolved = resolve_release(release("v0.3.0"), "v").unwrap();
        assert_eq!(resolved.version, "0.3.0");
        assert!(resolve_release(release("server-agent-v0.3.0"), "v").is_err());
    }

    #[test]
    fn latest_only_accepts_plain_semver_tags() {
        assert!(is_stable_version("v", "v1.14.4"));
        assert!(is_stable_version("v", "v0.3.0"));
        assert!(!is_stable_version("v", "server-agent-v0.3.0"));
        assert!(!is_stable_version("v", "v1.15.0-alpha.1"));
        assert!(!is_stable_version("v", "v1.14"));
        assert!(!is_stable_version("v", "latest"));
    }

    #[test]
    fn singbox_updates_require_the_stream_api_version() {
        assert!(supports_singbox_version("1.14.0"));
        assert!(supports_singbox_version("v1.14.4"));
        assert!(supports_singbox_version("2.0.0"));
        assert!(!supports_singbox_version("1.13.9"));
        assert!(!supports_singbox_version("latest"));
    }

    #[test]
    fn rejects_checksum_mismatches() {
        let digest = format!("sha256:{}", hex::encode(sha2::Sha256::digest(b"payload")));
        assert!(verify_digest(b"payload", &digest).is_ok());
        assert!(verify_digest(b"tampered", &digest).is_err());
        assert!(verify_digest(b"payload", "sha512:00").is_err());
    }

    #[test]
    fn requires_expected_asset() {
        let resolved = ResolvedRelease {
            tag: "v1.0.0".to_string(),
            version: "1.0.0".to_string(),
            assets: release("v1.0.0").assets,
        };
        assert!(find_asset(&resolved, "asset").is_ok());
        assert!(find_asset(&resolved, "missing").is_err());
    }

    async fn serve_with<F>(build: F) -> String
    where
        F: FnOnce(&str) -> HashMap<String, Vec<u8>>,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let api = format!("http://{address}");
        let responses = build(&api);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let responses = responses.clone();
                tokio::spawn(async move {
                    let mut buffer = [0u8; 8192];
                    let Ok(read) = socket.read(&mut buffer).await else {
                        return;
                    };
                    let request = String::from_utf8_lossy(&buffer[..read]);
                    let path = request
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or("/");
                    let (status, body) = match responses.get(path) {
                        Some(body) => ("200 OK", body.clone()),
                        None => ("404 Not Found", b"not found".to_vec()),
                    };
                    let header = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(header.as_bytes()).await;
                    let _ = socket.write_all(&body).await;
                });
            }
        });
        api
    }

    fn temp_dir(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "blossom-update-{label}-{}-{suffix}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn update_config(api: String, dir: &Path) -> UpdateConfig {
        UpdateConfig {
            state_dir: dir.join("state"),
            download_dir: dir.join("downloads"),
            github_api: api,
            agent_repo: "acme/blossom".to_string(),
            singbox_repo: "acme/sing-box".to_string(),
            github_token: None,
            self_update: true,
            retry_after: Duration::from_secs(3600),
        }
    }

    #[tokio::test]
    async fn agent_update_downloads_verifies_and_installs() {
        let dir = temp_dir("agent");
        let executable = dir.join("server-agent");
        std::fs::write(&executable, b"old-agent").unwrap();
        let replacement = b"#!/bin/sh\necho new-agent\n";
        let asset_name = format!("server-agent-linux-{}", release_arch().unwrap());
        let digest = hex::encode(sha2::Sha256::digest(replacement));
        let api = serve_with(|api| {
            HashMap::from([
                (
                    "/repos/acme/blossom/releases/tags/v0.3.0".to_string(),
                    serde_json::to_vec(&serde_json::json!({
                        "tag_name": "v0.3.0",
                        "draft": false,
                        "prerelease": false,
                        "assets": [{
                            "name": asset_name,
                            "browser_download_url": format!("{api}/agent"),
                            "digest": format!("sha256:{digest}")
                        }]
                    }))
                    .unwrap(),
                ),
                ("/agent".to_string(), replacement.to_vec()),
            ])
        })
        .await;

        let mut manager =
            UpdateManager::new(update_config(api.clone(), &dir), "0.2.0".to_string(), None)
                .unwrap();
        assert!(
            manager
                .maybe_update_agent("0.3.0", &executable)
                .await
                .unwrap()
        );
        assert_eq!(std::fs::read(&executable).unwrap(), replacement);
        assert_eq!(
            std::fs::read(dir.join("server-agent.prev")).unwrap(),
            b"old-agent"
        );
        assert!(dir.join("state/agent-update.json").exists());

        let recovered =
            UpdateManager::new(update_config(api, &dir), "0.3.0".to_string(), None).unwrap();
        assert_eq!(recovered.agent_status().state, UpdateState::UpToDate);
        assert!(!dir.join("state/agent-update.json").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn latest_agent_release_skips_releases_without_agent_binary() {
        let dir = temp_dir("latest-agent");
        let executable = dir.join("server-agent");
        std::fs::write(&executable, b"old-agent").unwrap();
        let replacement = b"#!/bin/sh\necho latest-agent\n";
        let asset_name = format!("server-agent-linux-{}", release_arch().unwrap());
        let digest = hex::encode(sha2::Sha256::digest(replacement));
        let api = serve_with(|api| {
            HashMap::from([
                (
                    "/repos/acme/blossom/releases?per_page=30".to_string(),
                    serde_json::to_vec(&serde_json::json!([
                        {
                            "tag_name": "v1.5.0-rc.1",
                            "draft": false,
                            "prerelease": true,
                            "assets": [{
                                "name": asset_name,
                                "browser_download_url": format!("{api}/wrong"),
                                "digest": format!("sha256:{digest}")
                            }]
                        },
                        {
                            "tag_name": "v1.4.1",
                            "draft": false,
                            "prerelease": false,
                            "assets": []
                        },
                        {
                            "tag_name": "v1.4.0",
                            "draft": false,
                            "prerelease": false,
                            "assets": [{
                                "name": asset_name,
                                "browser_download_url": format!("{api}/agent"),
                                "digest": format!("sha256:{digest}")
                            }]
                        }
                    ]))
                    .unwrap(),
                ),
                ("/agent".to_string(), replacement.to_vec()),
            ])
        })
        .await;

        let mut manager =
            UpdateManager::new(update_config(api, &dir), "1.3.0".to_string(), None).unwrap();
        assert!(
            manager
                .maybe_update_agent("latest", &executable)
                .await
                .unwrap()
        );
        assert_eq!(std::fs::read(&executable).unwrap(), replacement);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn status_observer_sees_every_transition() {
        use std::sync::{Arc, Mutex};

        let dir = temp_dir("observer");
        let executable = dir.join("server-agent");
        std::fs::write(&executable, b"old-agent").unwrap();
        let replacement = b"#!/bin/sh\necho new-agent\n";
        let asset_name = format!("server-agent-linux-{}", release_arch().unwrap());
        let digest = hex::encode(sha2::Sha256::digest(replacement));
        let api = serve_with(|api| {
            HashMap::from([
                (
                    "/repos/acme/blossom/releases/tags/v0.3.0".to_string(),
                    serde_json::to_vec(&serde_json::json!({
                        "tag_name": "v0.3.0",
                        "draft": false,
                        "prerelease": false,
                        "assets": [{
                            "name": asset_name,
                            "browser_download_url": format!("{api}/agent"),
                            "digest": format!("sha256:{digest}")
                        }]
                    }))
                    .unwrap(),
                ),
                ("/agent".to_string(), replacement.to_vec()),
            ])
        })
        .await;

        let states = Arc::new(Mutex::new(Vec::new()));
        let recorded = states.clone();
        let mut manager =
            UpdateManager::new(update_config(api, &dir), "0.2.0".to_string(), None).unwrap();
        manager.set_status_observer(Arc::new(move |agent, _singbox| {
            recorded
                .lock()
                .expect("state log lock")
                .push(agent.state.as_str());
        }));
        manager
            .maybe_update_agent("0.3.0", &executable)
            .await
            .unwrap();

        let states = states.lock().unwrap().clone();
        assert!(states.contains(&"checking"), "{states:?}");
        assert!(states.contains(&"downloading"), "{states:?}");
        assert!(states.contains(&"restarting"), "{states:?}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn singbox_update_extracts_verifies_and_installs() {
        let dir = temp_dir("singbox");
        let executable = dir.join("sing-box");
        std::fs::write(&executable, b"old-sing-box").unwrap();
        let script = b"#!/bin/sh\necho sing-box version 1.15.0\n";
        let asset_name = format!(
            "sing-box-1.15.0-linux-{}-musl.tar.gz",
            release_arch().unwrap()
        );

        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut archive = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header
            .set_path(format!(
                "sing-box-1.15.0-linux-{}-musl/sing-box",
                release_arch().unwrap()
            ))
            .unwrap();
        header.set_size(script.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        archive.append(&header, &script[..]).unwrap();
        let encoder = archive.into_inner().unwrap();
        let tarball = encoder.finish().unwrap();
        let digest = hex::encode(sha2::Sha256::digest(&tarball));
        let api = serve_with(|api| {
            HashMap::from([
                (
                    "/repos/acme/sing-box/releases/tags/v1.15.0".to_string(),
                    serde_json::to_vec(&serde_json::json!({
                        "tag_name": "v1.15.0",
                        "draft": false,
                        "prerelease": false,
                        "assets": [{
                            "name": asset_name,
                            "browser_download_url": format!("{api}/sing-box.tar.gz"),
                            "digest": format!("sha256:{digest}")
                        }]
                    }))
                    .unwrap(),
                ),
                ("/sing-box.tar.gz".to_string(), tarball),
            ])
        })
        .await;

        let mut manager = UpdateManager::new(
            update_config(api, &dir),
            "0.2.0".to_string(),
            Some("1.14.4".into()),
        )
        .unwrap();
        let staged = manager
            .stage_singbox_update("1.15.0", Some("1.14.4"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(staged.version, "1.15.0");
        manager
            .install_singbox(&staged, &executable, "1.15.0")
            .unwrap();
        assert_eq!(std::fs::read(&executable).unwrap(), script);
        assert_eq!(
            std::fs::read(dir.join("sing-box.prev")).unwrap(),
            b"old-sing-box"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
