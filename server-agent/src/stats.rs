//! Minimal client for sing-box's v2ray StatsService.
//!
//! The service is queried directly via tonic's low-level `Grpc` client using
//! hand-written prost message structs. No .proto files or tonic-build are used.

use std::time::Duration;

use anyhow::{Context, Result};
use tonic::transport::{Channel, Endpoint};

#[derive(Clone, PartialEq, prost::Message)]
pub struct QueryStatsRequest {
    #[prost(string, tag = "1")]
    pub pattern: String,
    #[prost(bool, tag = "2")]
    pub reset: bool,
    #[prost(string, repeated, tag = "3")]
    pub patterns: Vec<String>,
    #[prost(bool, tag = "4")]
    pub regexp: bool,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct Stat {
    #[prost(string, tag = "1")]
    pub name: String,
    #[prost(int64, tag = "2")]
    pub value: i64,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct QueryStatsResponse {
    #[prost(message, repeated, tag = "1")]
    pub stat: Vec<Stat>,
}

pub struct StatsClient {
    grpc: tonic::client::Grpc<Channel>,
}

impl StatsClient {
    /// addr is host:port (no scheme). Lazy connect: no I/O until first call.
    pub fn connect_lazy(addr: &str) -> Result<Self> {
        let endpoint = Endpoint::from_shared(format!("http://{addr}"))
            .with_context(|| format!("invalid stats endpoint address: {addr}"))?
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10));
        let channel = endpoint.connect_lazy();
        Ok(Self {
            grpc: tonic::client::Grpc::new(channel),
        })
    }

    /// Query stats from sing-box.
    ///
    /// sing-box ignores the deprecated singular `pattern` field and only
    /// honours the v2ray-v5 `patterns` repeated field, so callers should pass
    /// patterns via `patterns`.
    pub async fn query_stats(&mut self, patterns: Vec<String>, reset: bool) -> Result<Vec<Stat>> {
        self.grpc.ready().await.context("stats service not ready")?;

        let req = QueryStatsRequest {
            pattern: String::new(),
            reset,
            patterns,
            regexp: false,
        };
        let path = http::uri::PathAndQuery::from_static(
            "/v2ray.core.app.stats.command.StatsService/QueryStats",
        );
        let codec = tonic_prost::ProstCodec::<QueryStatsRequest, QueryStatsResponse>::default();

        let response = self
            .grpc
            .unary(tonic::Request::new(req), path, codec)
            .await
            .context("stats query failed")?;

        Ok(response.into_inner().stat)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Uplink,
    Downlink,
}

/// Parse `user>>>{sub}>>>traffic>>>uplink` -> Some((sub, Direction::Uplink)); anything else -> None.
pub fn parse_user_counter(name: &str) -> Option<(&str, Direction)> {
    let rest = name.strip_prefix("user>>>")?;
    let (sub, suffix) = rest.split_once(">>>traffic>>>")?;
    let direction = match suffix {
        "uplink" => Direction::Uplink,
        "downlink" => Direction::Downlink,
        _ => return None,
    };
    Some((sub, direction))
}

#[cfg(test)]
mod tests {
    use super::{Direction, parse_user_counter};

    #[test]
    fn parses_uplink() {
        assert_eq!(
            parse_user_counter("user>>>sub-123>>>traffic>>>uplink"),
            Some(("sub-123", Direction::Uplink))
        );
    }

    #[test]
    fn parses_downlink() {
        assert_eq!(
            parse_user_counter("user>>>sub-123>>>traffic>>>downlink"),
            Some(("sub-123", Direction::Downlink))
        );
    }

    #[test]
    fn parses_subscription_with_odd_chars() {
        assert_eq!(
            parse_user_counter("user>>>abc_DEF.789>>>traffic>>>downlink"),
            Some(("abc_DEF.789", Direction::Downlink))
        );
    }

    #[test]
    fn ignores_non_user_counter() {
        assert_eq!(
            parse_user_counter("inbound>>>node-x>>>traffic>>>uplink"),
            None
        );
    }

    #[test]
    fn rejects_truncated_name() {
        assert_eq!(parse_user_counter("user>>>sub"), None);
    }

    #[test]
    fn rejects_missing_direction() {
        assert_eq!(parse_user_counter("user>>>sub>>>traffic>>>"), None);
    }

    #[test]
    fn rejects_wrong_suffix() {
        assert_eq!(parse_user_counter("user>>>sub>>>traffic>>>total"), None);
    }
}
