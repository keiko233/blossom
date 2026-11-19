//! Credential-file schema, origin checks, and protected `0600` file IO.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};

use anyhow::{Context as _, bail};
use reqwest::Url;
use serde::Deserialize;
use zeroize::Zeroize as _;

/// The single scope the control plane issues to machine clients.
pub(crate) const AGENT_SCOPE: &str = "blossom:agent:connect";
/// A credential file is small; anything larger is refused before parsing.
pub(crate) const MAX_CREDENTIALS_BYTES: usize = 16 * 1024;

/// A normalized `scheme://host:port` origin. Paths, queries and credentials
/// are deliberately not part of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Origin {
    scheme: String,
    host: String,
    port: u16,
}

impl Origin {
    fn from_url(url: &Url) -> Option<Self> {
        Some(Self {
            scheme: url.scheme().to_ascii_lowercase(),
            host: url.host_str()?.to_ascii_lowercase(),
            port: url.port_or_known_default()?,
        })
    }
}

impl fmt::Display for Origin {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}://{}:{}", self.scheme, self.host, self.port)
    }
}

/// True when both URLs have the same scheme, host and effective port.
pub(crate) fn same_origin(left: &Url, right: &Url) -> bool {
    match (Origin::from_url(left), Origin::from_url(right)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

/// Parses the configured agent base URL.
///
/// It must include the `/api` prefix, carry no userinfo, query or fragment,
/// and use TLS except for a loopback host (the disposable test control plane).
pub(crate) fn parse_base_url(raw: &str) -> Result<Url, CredentialsError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CredentialsError::Invalid(
            "the agent URL is empty".to_string(),
        ));
    }
    let mut url = Url::parse(trimmed)
        .map_err(|error| CredentialsError::Invalid(format!("invalid agent URL: {error}")))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(CredentialsError::Invalid(
            "the agent URL must not contain credentials".to_string(),
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(CredentialsError::Invalid(
            "the agent URL must not contain a query or fragment".to_string(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| CredentialsError::Invalid("the agent URL has no host".to_string()))?;
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback());
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        "http" => {
            return Err(CredentialsError::Invalid(
                "the agent URL must use https except on a loopback host".to_string(),
            ));
        }
        scheme => {
            return Err(CredentialsError::Invalid(format!(
                "the agent URL scheme {scheme} is not supported"
            )));
        }
    }
    let path = url.path().trim_end_matches('/').to_string();
    if path != "/api" {
        return Err(CredentialsError::Invalid(
            "the agent URL must end at the /api prefix".to_string(),
        ));
    }
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

/// Builds an endpoint below the configured base URL, keeping its prefix.
pub(crate) fn endpoint(base: &Url, suffix: &str) -> Result<Url, CredentialsError> {
    let joined = format!("{}/{}", base.as_str().trim_end_matches('/'), suffix);
    Url::parse(&joined)
        .map_err(|error| CredentialsError::Invalid(format!("invalid endpoint URL: {error}")))
}

/// The enrollment response, which is also the service credential file.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Credentials {
    pub server_id: String,
    pub identity_id: String,
    pub generation: u64,
    pub identity_status: String,
    pub client_id: String,
    client_secret: String,
    pub client_auth_method: String,
    pub grant_type: String,
    pub token_endpoint: String,
    pub issuer: String,
    pub resource: String,
    pub scope: String,
    pub token_lifetime_seconds: u64,
}

impl Credentials {
    /// Parses and validates a redemption response against the configured base
    /// URL. Every endpoint must be on that same origin before a secret can be
    /// sent there later.
    pub(crate) fn parse(bytes: &[u8], base: &Url) -> Result<Self, CredentialsError> {
        let credentials: Self = serde_json::from_slice(bytes).map_err(|error| {
            CredentialsError::Invalid(format!("invalid credential JSON: {error}"))
        })?;
        credentials.validate(base)?;
        Ok(credentials)
    }

    pub(crate) fn client_secret(&self) -> &str {
        &self.client_secret
    }

    pub(crate) fn validate(&self, base: &Url) -> Result<(), CredentialsError> {
        bounded("serverId", &self.server_id, 1, 256)?;
        bounded("identityId", &self.identity_id, 1, 256)?;
        bounded("clientId", &self.client_id, 8, 128)?;
        bounded("clientSecret", &self.client_secret, 8, 512)?;
        if !self.client_id.starts_with("agent_") {
            return Err(CredentialsError::Invalid(
                "clientId is not a machine client id".to_string(),
            ));
        }
        if !self.client_secret.starts_with("ags_") {
            return Err(CredentialsError::Invalid(
                "clientSecret is not a machine client secret".to_string(),
            ));
        }
        if !(1..=1_000_000_000).contains(&self.generation) {
            return Err(CredentialsError::Invalid(
                "generation is out of range".to_string(),
            ));
        }
        if !matches!(self.identity_status.as_str(), "pending" | "active") {
            return Err(CredentialsError::Invalid(
                "identityStatus is not pending or active".to_string(),
            ));
        }
        if self.client_auth_method != "client_secret_basic" {
            return Err(CredentialsError::Invalid(
                "clientAuthMethod is not client_secret_basic".to_string(),
            ));
        }
        if self.grant_type != "client_credentials" {
            return Err(CredentialsError::Invalid(
                "grantType is not client_credentials".to_string(),
            ));
        }
        if self.scope != AGENT_SCOPE {
            return Err(CredentialsError::Invalid(format!(
                "scope is not {AGENT_SCOPE}"
            )));
        }
        if !(1..=86_400).contains(&self.token_lifetime_seconds) {
            return Err(CredentialsError::Invalid(
                "tokenLifetimeSeconds is out of range".to_string(),
            ));
        }

        let token_endpoint = parse_endpoint("tokenEndpoint", &self.token_endpoint)?;
        let issuer = parse_endpoint("issuer", &self.issuer)?;
        let resource = parse_endpoint("resource", &self.resource)?;
        let expected_token = endpoint(base, "auth/oauth2/token")?;
        let expected_issuer = endpoint(base, "auth")?;
        let expected_resource = endpoint(base, "agent")?;
        if token_endpoint != expected_token {
            return Err(CredentialsError::Invalid(format!(
                "tokenEndpoint must be {expected_token}"
            )));
        }
        if issuer != expected_issuer {
            return Err(CredentialsError::Invalid(format!(
                "issuer must be {expected_issuer}"
            )));
        }
        if resource != expected_resource {
            return Err(CredentialsError::Invalid(format!(
                "resource must be {expected_resource}"
            )));
        }
        for (name, url) in [
            ("tokenEndpoint", &token_endpoint),
            ("issuer", &issuer),
            ("resource", &resource),
        ] {
            if !same_origin(base, url) {
                return Err(CredentialsError::Invalid(format!(
                    "{name} is not on the configured origin"
                )));
            }
        }
        Ok(())
    }
}

impl fmt::Debug for Credentials {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Credentials")
            .field("server_id", &self.server_id)
            .field("identity_id", &self.identity_id)
            .field("generation", &self.generation)
            .field("identity_status", &self.identity_status)
            .field("client_id", &self.client_id)
            .field("client_secret", &"<redacted>")
            .field("client_auth_method", &self.client_auth_method)
            .field("grant_type", &self.grant_type)
            .field("token_endpoint", &self.token_endpoint)
            .field("issuer", &self.issuer)
            .field("resource", &self.resource)
            .field("scope", &self.scope)
            .field("token_lifetime_seconds", &self.token_lifetime_seconds)
            .finish()
    }
}

impl Drop for Credentials {
    fn drop(&mut self) {
        self.client_secret.zeroize();
    }
}

fn parse_endpoint(name: &str, value: &str) -> Result<Url, CredentialsError> {
    Url::parse(value)
        .map_err(|error| CredentialsError::Invalid(format!("{name} is not a valid URL: {error}")))
}

fn bounded(name: &str, value: &str, min: usize, max: usize) -> Result<(), CredentialsError> {
    if value.len() < min || value.len() > max {
        return Err(CredentialsError::Invalid(format!(
            "{name} must be {min}-{max} bytes"
        )));
    }
    if !value.is_ascii()
        || value
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return Err(CredentialsError::Invalid(format!(
            "{name} contains unsupported characters"
        )));
    }
    Ok(())
}

/// Credential or origin validation failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CredentialsError {
    Invalid(String),
}

impl fmt::Display for CredentialsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for CredentialsError {}

/// Reads a protected one-owner file without following a symlink.
///
/// The file must be a regular file owned by the effective user with exactly
/// mode `0600`. The size is checked before and during the read.
pub(crate) fn read_protected_file(
    path: &Path,
    limit: usize,
    label: &str,
) -> anyhow::Result<Vec<u8>> {
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::OpenOptionsExt as _;
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .with_context(|| format!("cannot open {label} {}", path.display()))?
    };
    #[cfg(not(unix))]
    let file =
        File::open(path).with_context(|| format!("cannot open {label} {}", path.display()))?;

    let metadata = file
        .metadata()
        .with_context(|| format!("cannot read {label} metadata"))?;
    if !metadata.file_type().is_file() {
        bail!("{label} {} is not a regular file", path.display());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        let mode = metadata.mode() & 0o777;
        if mode != 0o600 {
            bail!(
                "{label} {} must have mode 0600 (found {mode:03o})",
                path.display()
            );
        }
        let effective = unsafe { libc::geteuid() };
        if metadata.uid() != effective {
            bail!(
                "{label} {} must be owned by the effective user",
                path.display()
            );
        }
    }
    if metadata.len() > limit as u64 {
        bail!("{label} {} exceeds {limit} bytes", path.display());
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("cannot read {label} {}", path.display()))?;
    if bytes.len() > limit {
        bail!("{label} {} exceeds {limit} bytes", path.display());
    }
    Ok(bytes)
}

/// Writes `bytes` to `path` atomically with mode `0600`.
///
/// The temporary file lives in the destination directory, is created with
/// `O_EXCL`, synced, renamed over the destination, and the directory entry is
/// synced. A failure removes the temporary file and leaves any previous
/// credentials untouched.
pub(crate) fn write_atomic_protected(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    if path.file_name().is_none() {
        bail!("credentials path {} has no file name", path.display());
    }
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            bail!("credentials path {} must not be a symlink", path.display());
        }
        if metadata.file_type().is_dir() {
            bail!("credentials path {} is a directory", path.display());
        }
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if !parent.is_dir() {
        bail!("credentials directory {} does not exist", parent.display());
    }

    let mut last_error = None;
    for attempt in 0..3 {
        let temporary = temporary_path(parent, attempt);
        match write_temporary(&temporary, bytes) {
            Ok(()) => {
                if let Err(error) = fs::rename(&temporary, path) {
                    let _ = fs::remove_file(&temporary);
                    return Err(error).with_context(|| {
                        format!("cannot replace credentials file {}", path.display())
                    });
                }
                sync_directory(parent);
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                last_error = Some(error);
            }
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                return Err(error).with_context(|| {
                    format!("cannot create credentials file in {}", parent.display())
                });
            }
        }
    }
    Err(last_error
        .map(anyhow::Error::new)
        .unwrap_or_else(|| anyhow::anyhow!("cannot create a temporary credentials file")))
}

fn temporary_path(parent: &Path, attempt: u32) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    parent.join(format!(
        ".blossom-credentials-{}-{nanos}-{attempt}.tmp",
        std::process::id()
    ))
}

fn write_temporary(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    file.sync_all()?;
    Ok(())
}

fn sync_directory(parent: &Path) {
    #[cfg(unix)]
    {
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
    }
    #[cfg(not(unix))]
    let _ = parent;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn directory() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "blossom-credentials-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn base_url_requires_api_and_tls_off_loopback() {
        assert!(parse_base_url("https://blossom.example.com/api").is_ok());
        assert!(parse_base_url("http://127.0.0.1:3000/api").is_ok());
        assert!(parse_base_url("http://localhost:3000/api/").is_ok());
        assert!(parse_base_url("http://blossom.example.com/api").is_err());
        assert!(parse_base_url("https://blossom.example.com/prefix/api").is_err());
        assert!(parse_base_url("https://blossom.example.com/agent").is_err());
        assert!(parse_base_url("https://blossom.example.com/api?next=x").is_err());
    }

    fn credential_json(base: &str) -> serde_json::Value {
        serde_json::json!({
            "serverId": "server-1",
            "identityId": "identity-1",
            "generation": 1,
            "identityStatus": "pending",
            "clientId": "agent_abcdefghijklmnopqrstuvwxyz",
            "clientSecret": "ags_abcdefghijklmnopqrstuvwxyz0123456789",
            "clientAuthMethod": "client_secret_basic",
            "grantType": "client_credentials",
            "tokenEndpoint": format!("{base}/auth/oauth2/token"),
            "issuer": format!("{base}/auth"),
            "resource": format!("{base}/agent"),
            "scope": AGENT_SCOPE,
            "tokenLifetimeSeconds": 900,
        })
    }

    #[test]
    fn credentials_must_stay_on_the_configured_origin() {
        let base = parse_base_url("https://blossom.example.com/api").unwrap();
        let good = serde_json::to_vec(&credential_json("https://blossom.example.com/api")).unwrap();
        Credentials::parse(&good, &base).expect("same-origin credentials");

        let foreign = serde_json::to_vec(&credential_json("https://evil.example/api")).unwrap();
        let error = Credentials::parse(&foreign, &base).unwrap_err();
        assert!(error.to_string().contains("tokenEndpoint"), "{error}");
    }

    #[test]
    fn credentials_require_the_exact_scope_and_machine_secret() {
        let base = parse_base_url("https://blossom.example.com/api").unwrap();
        let mut value = credential_json("https://blossom.example.com/api");
        value["scope"] = serde_json::json!("blossom:agent:admin");
        let error = Credentials::parse(&serde_json::to_vec(&value).unwrap(), &base).unwrap_err();
        assert!(error.to_string().contains("scope"), "{error}");
    }

    #[test]
    fn protected_reads_require_exactly_0600() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = directory();
        let path = dir.join("grant");
        fs::write(&path, b"egr_test\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            read_protected_file(&path, 4096, "grant").unwrap(),
            b"egr_test\n"
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let error = read_protected_file(&path, 4096, "grant").unwrap_err();
        assert!(error.to_string().contains("0600"), "{error}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn atomic_writes_replace_with_0600_and_leave_no_temporary_file() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = directory();
        let path = dir.join("credentials.json");
        fs::write(&path, b"old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        write_atomic_protected(&path, b"{\"new\":true}").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"{\"new\":true}");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name() != "credentials.json")
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        let _ = fs::remove_dir_all(dir);
    }
}
