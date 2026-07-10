//! Progenitor-generated client for the blossom `/api` surface, plus the Bearer
//! auth wiring (progenitor does not implement OpenAPI security schemes itself,
//! so the per-node token is injected as a default header on the reqwest client).

use std::time::Duration;

use anyhow::Context;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};

mod generated {
    #![allow(clippy::all, dead_code)]
    include!(concat!(env!("OUT_DIR"), "/codegen.rs"));
}

pub use generated::{Client, types};

/// Builds a client whose every request carries `Authorization: Bearer <token>`.
/// `base_url` must include the `/api` prefix (e.g. `http://host:3000/api`) —
/// the spec paths are relative to the OpenAPIHandler mount point.
pub fn new_client(base_url: &str, token: &str) -> anyhow::Result<Client> {
    let mut auth = HeaderValue::from_str(&format!("Bearer {token}"))
        .context("agent token contains invalid header characters")?;
    auth.set_sensitive(true);

    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, auth);

    let http = reqwest::ClientBuilder::new()
        .default_headers(headers)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .context("failed to build HTTP client")?;

    Ok(Client::new_with_client(
        base_url.trim_end_matches('/'),
        http,
    ))
}
