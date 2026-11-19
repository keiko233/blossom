//! `server-agent enroll` — the one-time grant redemption CLI.

use std::path::{Path, PathBuf};

use anyhow::{Context as _, bail};
use reqwest::header::CONTENT_TYPE;
use serde_json::Value;

use super::credentials::{
    Credentials, endpoint, parse_base_url, read_protected_file, write_atomic_protected,
};
use super::http::{MAX_RESPONSE_BYTES, client, read_bounded};

/// Maximum size of the one-line grant file: the contract caps the redeemed
/// body at 4 KB and the grant itself is 47 bytes.
const MAX_GRANT_BYTES: usize = 4 * 1024;
const GRANT_PREFIX: &str = "egr_";
const GRANT_BODY_BYTES: usize = 43;

#[derive(clap::Args)]
pub(crate) struct EnrollArgs {
    /// Base URL of the blossom API, including the `/api` prefix.
    #[arg(long, env = "AGENT_URL")]
    pub(crate) url: String,

    /// Protected one-line file containing exactly one `egr_...` enrollment
    /// grant. It is never accepted as an argument, URL part or stdin prompt.
    #[arg(long, value_name = "FILE")]
    pub(crate) grant_file: PathBuf,

    /// Destination credential file. It is written atomically with mode 0600.
    #[arg(long, value_name = "FILE")]
    pub(crate) credentials_file: PathBuf,
}

/// Redeems one enrollment grant exactly once and writes the response verbatim.
///
/// There is no retry: a lost response could have issued a secret that cannot
/// be recovered, so the administrator must revoke the grant and issue a new
/// one. Any non-200 response leaves the credentials file untouched.
pub(crate) async fn run_enroll(args: &EnrollArgs) -> anyhow::Result<()> {
    let base = parse_base_url(&args.url)?;
    let grant = read_grant(&args.grant_file)?;
    let redeem_url = endpoint(&base, "agent/enrollment/redeem")?;

    let payload = serde_json::to_vec(&serde_json::json!({ "enrollmentGrant": grant }))
        .context("cannot encode the enrollment request")?;
    let response = client()?
        .post(redeem_url)
        .header(CONTENT_TYPE, "application/json")
        .body(payload)
        .send()
        .await
        .context("cannot reach the enrollment endpoint")?;
    let status = response.status();
    let body = read_bounded(response, MAX_RESPONSE_BYTES)
        .await
        .context("cannot read the enrollment response")?;
    if status != reqwest::StatusCode::OK {
        return Err(redeem_failure(status.as_u16(), &body));
    }

    let credentials = Credentials::parse(&body, &base)
        .context("the enrollment response is not a valid machine credential")?;
    write_atomic_protected(&args.credentials_file, &body)?;

    eprintln!(
        "enrollment complete: server {} identity {} generation {}",
        credentials.server_id, credentials.identity_id, credentials.generation
    );
    Ok(())
}

fn read_grant(path: &Path) -> anyhow::Result<String> {
    let bytes = read_protected_file(path, MAX_GRANT_BYTES, "enrollment grant file")?;
    let text =
        std::str::from_utf8(&bytes).context("the enrollment grant file is not valid UTF-8")?;
    let line = text
        .strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .unwrap_or(text);
    if line.contains('\n') || line.contains('\r') {
        bail!("the enrollment grant file must contain exactly one line");
    }
    if line.trim() != line || line.is_empty() {
        bail!("the enrollment grant file must contain one unpadded grant");
    }
    let Some(body) = line.strip_prefix(GRANT_PREFIX) else {
        bail!("the enrollment grant must start with {GRANT_PREFIX}");
    };
    if body.len() != GRANT_BODY_BYTES
        || !body
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        bail!("the enrollment grant is not a valid egr_ value");
    }
    Ok(line.to_string())
}

fn redeem_failure(status: u16, body: &[u8]) -> anyhow::Error {
    match safe_error_code(body) {
        Some(code) => anyhow::anyhow!("enrollment redemption failed: HTTP {status} {code}"),
        None => anyhow::anyhow!("enrollment redemption failed: HTTP {status}"),
    }
}

/// Extracts only a bounded lowercase error code, never the response body.
fn safe_error_code(body: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let code = value.get("error")?.as_str()?;
    if code.is_empty()
        || code.len() > 64
        || !code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
    {
        return None;
    }
    Some(code.to_string())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn grant_file(contents: &[u8], mode: u32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt as _;

        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("blossom-enroll-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("grant");
        fs::write(&path, contents).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    #[test]
    fn a_single_egr_line_is_accepted_with_or_without_a_newline() {
        let grant = format!("egr_{}", "a".repeat(GRANT_BODY_BYTES));
        for contents in [grant.clone(), format!("{grant}\n"), format!("{grant}\r\n")] {
            let path = grant_file(contents.as_bytes(), 0o600);
            assert_eq!(read_grant(&path).unwrap(), grant);
            let _ = fs::remove_dir_all(path.parent().unwrap());
        }
    }

    #[test]
    fn malformed_multiline_and_padded_grants_are_rejected() {
        let valid = format!("egr_{}", "a".repeat(GRANT_BODY_BYTES));
        for contents in [
            format!("{valid}\n{valid}\n"),
            format!(" {valid}\n"),
            format!("{}\n", valid.trim_end_matches('a')),
            "agt_not_a_grant\n".to_string(),
        ] {
            let path = grant_file(contents.as_bytes(), 0o600);
            assert!(read_grant(&path).is_err(), "{contents:?}");
            let _ = fs::remove_dir_all(path.parent().unwrap());
        }
    }

    #[test]
    fn error_codes_are_bounded_and_lowercase_only() {
        assert_eq!(
            safe_error_code(br#"{"error":"invalid_grant"}"#).as_deref(),
            Some("invalid_grant")
        );
        assert_eq!(safe_error_code(br#"{"error":"Invalid Grant"}"#), None);
        assert_eq!(safe_error_code(br#"{"detail":"nothing"}"#), None);
        assert_eq!(
            safe_error_code(format!(r#"{{"error":"{}"}}"#, "a".repeat(65)).as_bytes()),
            None
        );
    }
}
