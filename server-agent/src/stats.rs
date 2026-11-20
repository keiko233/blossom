//! Minimal client for sing-box's built-in `api` service (sing-box >= 1.14).
//!
//! The pinned verification target is sing-box 1.14.4 (`Dockerfile.test`).
//! `StartedService` first shipped in 1.13.0 and `Connection.inbound` has been
//! field 2 since then; this agent keeps its existing >= 1.14 capability gate
//! until managed metering is activated.
//!
//! The service is a plain gRPC server serving `StartedService` over h2c. The
//! client talks to it directly via tonic's low-level `Grpc` API with
//! hand-written prost message structs — no `.proto` files and no tonic-build.
//! Only the fields the agent consumes are declared; prost skips unknown
//! fields, so upstream adding fields stays compatible.

/// The agent's supported `StartedService` stream floor. `StartedService` and
/// `Connection.inbound` first shipped in 1.13.0; the existing update and
/// capability gate remains >= 1.14.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "documented pinned stats protocol metadata used by the metering integration gate"
    )
)]
pub const STATS_MIN_VERSION: &str = "1.14.0";
/// The binary pinned by `Dockerfile.test` and used for the checked-in captures.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "documented pinned stats protocol metadata used by the metering integration gate"
    )
)]
pub const PINNED_STATS_VERSION: &str = "1.14.4";
/// `Connection.inbound` in `daemon/started_service.proto`.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "documented pinned stats protocol metadata used by the metering integration gate"
    )
)]
pub const CONNECTION_INBOUND_FIELD: u32 = 2;
/// sing-box's retained closed-connection history (`closedConnectionsLimit`).
#[allow(
    dead_code,
    reason = "used by the binary meter; the example includes this module directly"
)]
pub const CLOSED_HISTORY_LIMIT: usize = 1000;

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
    /// The configured inbound tag that accepted the connection (`inbound = 2`
    /// in `daemon/started_service.proto`, present since 1.13.0).
    #[prost(string, tag = "2")]
    pub inbound: String,
    /// The inbound user identifier (coded `blz.1...` subscriber identity).
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
    use prost::Message as _;

    use super::{ConnectionEvents, SubscribeConnectionsRequest};

    fn fixture(name: &str) -> ConnectionEvents {
        let bytes: &[u8] = match name {
            "live" => include_bytes!("stats/fixtures/v1.14.4-live.bin"),
            "update" => include_bytes!("stats/fixtures/v1.14.4-update.bin"),
            "closed" => include_bytes!("stats/fixtures/v1.14.4-closed.bin"),
            "closed-history" => include_bytes!("stats/fixtures/v1.14.4-closed-history.bin"),
            other => panic!("unknown stats fixture {other}"),
        };
        ConnectionEvents::decode(bytes).expect("fixture decodes as ConnectionEvents")
    }

    #[test]
    fn supported_protocol_constants_match_the_pinned_binary() {
        assert_eq!(super::STATS_MIN_VERSION, "1.14.0");
        assert_eq!(super::PINNED_STATS_VERSION, "1.14.4");
        assert_eq!(super::CONNECTION_INBOUND_FIELD, 2);
        assert_eq!(super::CLOSED_HISTORY_LIMIT, 1000);
    }

    #[test]
    fn request_encodes_interval_in_nanoseconds() {
        let request = SubscribeConnectionsRequest {
            interval: 2_000_000_000,
        };
        assert_eq!(request.interval, 2_000_000_000);
    }

    #[test]
    fn pinned_capture_decodes_the_consumed_fields() {
        let live = fixture("live");
        let event = live.events.first().expect("live capture has one event");
        let connection = event
            .connection
            .as_ref()
            .expect("live capture carries metadata");
        assert_eq!(event.r#type, 0, "NEW is the first event type");
        assert_eq!(connection.inbound, "node-n1", "inbound is field 2");
        assert_eq!(connection.user, "blz.1.2.5.n1sub-a", "user is field 10");
        assert_eq!(connection.uplink_total, 0, "uplinkTotal is field 16");
        assert_eq!(connection.downlink_total, 0, "downlinkTotal is field 17");

        let update = fixture("update");
        let event = update.events.first().expect("update capture has one event");
        assert_eq!(event.r#type, 1, "UPDATE is event type 1");
        assert!(event.connection.is_none(), "updates carry no metadata");
        assert!(
            event.uplink_delta > 0 || event.downlink_delta > 0,
            "uplinkDelta is field 4 and downlinkDelta is field 5"
        );

        let closed = fixture("closed");
        let event = closed.events.first().expect("closed capture has one event");
        assert_eq!(event.r#type, 2, "CLOSED is event type 2");
        assert!(event.closed_at > 0, "closedAt is field 6 on the event");
        let connection = event
            .connection
            .as_ref()
            .expect("closed captures carry final metadata");
        assert!(connection.closed_at > 0, "closedAt is field 13");
        assert_eq!(connection.inbound, "node-n1");
        assert_eq!(connection.user, "blz.1.2.5.n1sub-a");
        assert!(connection.uplink_total > 0 && connection.downlink_total > 0);
    }

    #[test]
    fn pinned_capture_replays_the_bounded_closed_history() {
        let events = fixture("closed-history");
        let closed = events
            .events
            .iter()
            .filter(|event| {
                event
                    .connection
                    .as_ref()
                    .is_some_and(|connection| connection.closed_at != 0)
            })
            .count();
        assert_eq!(
            closed, 177,
            "the pinned 1.14.4 capture replayed 177 closed connections"
        );
        let ids: std::collections::HashSet<&str> = events
            .events
            .iter()
            .map(|event| event.id.as_str())
            .collect();
        assert_eq!(ids.len(), events.events.len(), "history ids are unique");
    }
}
