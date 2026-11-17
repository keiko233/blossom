//! Minimal client for sing-box's built-in `api` service (sing-box >= 1.14).
//!
//! The service is a plain gRPC server serving `StartedService` over h2c. The
//! client talks to it directly via tonic's low-level `Grpc` API with
//! hand-written prost message structs — no `.proto` files and no tonic-build.
//! Only the fields the agent consumes are declared; prost skips unknown
//! fields, so upstream adding fields stays compatible.

use std::time::Duration;

use anyhow::{Context, Result};
use tonic::metadata::{MetadataKey, MetadataValue};
use tonic::transport::{Channel, Endpoint};

#[derive(Clone, PartialEq, prost::Message)]
pub struct SubscribeConnectionsRequest {
    #[prost(int64, tag = "1")]
    pub interval: i64,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct ConnectionEvent {
    #[prost(int32, tag = "1")]
    pub r#type: i32,
    #[prost(string, tag = "2")]
    pub id: String,
    #[prost(message, optional, tag = "3")]
    pub connection: Option<Connection>,
    #[prost(int64, tag = "4")]
    pub uplink_delta: i64,
    #[prost(int64, tag = "5")]
    pub downlink_delta: i64,
    #[prost(int64, tag = "6")]
    pub closed_at: i64,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct ConnectionEvents {
    #[prost(message, repeated, tag = "1")]
    pub events: Vec<ConnectionEvent>,
    #[prost(bool, tag = "2")]
    pub reset: bool,
}

/// Only the fields sing-box actually fills and the agent consumes.
#[derive(Clone, PartialEq, prost::Message)]
pub struct Connection {
    #[prost(string, tag = "10")]
    pub user: String,
    /// Unix milliseconds; non-zero on connections that were already closed
    /// when a snapshot was taken (sing-box replays up to 1000 of them).
    #[prost(int64, tag = "13")]
    pub closed_at: i64,
    #[prost(int64, tag = "16")]
    pub uplink_total: i64,
    #[prost(int64, tag = "17")]
    pub downlink_total: i64,
}

/// Long-lived streaming client for `StartedService.SubscribeConnections`.
pub struct StatsClient {
    grpc: tonic::client::Grpc<Channel>,
    authorization: Option<MetadataValue<tonic::metadata::Ascii>>,
    path: http::uri::PathAndQuery,
}

impl StatsClient {
    /// addr is host:port (no scheme). Lazy connect: no I/O until first call.
    pub fn connect_lazy(addr: &str, secret: Option<&str>) -> Result<Self> {
        let endpoint = Endpoint::from_shared(format!("http://{addr}"))
            .with_context(|| format!("invalid stats endpoint address: {addr}"))?
            .connect_timeout(Duration::from_secs(5))
            // A server that accepts the call and never streams (old sing-box,
            // firewall) would otherwise block forever; disconnecting lets the
            // reporter reconnect and the restart logic see the outage.
            .timeout(Duration::from_secs(30));
        let authorization = secret
            .filter(|secret| !secret.is_empty())
            .map(|secret| {
                format!("Bearer {secret}")
                    .parse::<MetadataValue<_>>()
                    .context("invalid api secret")
            })
            .transpose()?;
        Ok(Self {
            grpc: tonic::client::Grpc::new(endpoint.connect_lazy()),
            authorization,
            path: http::uri::PathAndQuery::from_static(
                "/daemon.StartedService/SubscribeConnections",
            ),
        })
    }

    /// Opens the connection-event stream. Yields `ConnectionEvents` until the
    /// server or transport drops the call.
    pub async fn subscribe_connections(
        &mut self,
        interval: Duration,
    ) -> Result<tonic::Streaming<ConnectionEvents>> {
        self.grpc.ready().await.context("api service not ready")?;
        let mut request = tonic::Request::new(SubscribeConnectionsRequest {
            interval: interval.as_nanos().min(i64::MAX as u128) as i64,
        });
        if let Some(authorization) = self.authorization.clone() {
            request
                .metadata_mut()
                .insert(MetadataKey::from_static("authorization"), authorization);
        }
        let codec =
            tonic_prost::ProstCodec::<SubscribeConnectionsRequest, ConnectionEvents>::default();
        let response = self
            .grpc
            .server_streaming(request, self.path.clone(), codec)
            .await
            .context("subscribe_connections failed")?;
        Ok(response.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::SubscribeConnectionsRequest;

    #[test]
    fn request_encodes_interval_in_nanoseconds() {
        let request = SubscribeConnectionsRequest {
            interval: 2_000_000_000,
        };
        assert_eq!(request.interval, 2_000_000_000);
    }
}
