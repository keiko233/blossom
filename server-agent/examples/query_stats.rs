//! Manual smoke test for the hand-written `StartedService` client.
//!
//! Run sing-box >= 1.14 with the built-in `api` service enabled, push some
//! traffic through an inbound with a named user, then:
//!
//! ```sh
//! cargo run --example query_stats -- 127.0.0.1:18080 <secret>
//! ```

#[path = "../src/stats.rs"]
mod stats;

use std::time::Duration;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let addr = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "127.0.0.1:18080".to_string());
    let secret = std::env::args().nth(2);
    let mut client = stats::StatsClient::connect_lazy(&addr, secret.as_deref())?;

    let mut stream = client.subscribe_connections(Duration::from_secs(1)).await?;
    while let Some(message) = stream.message().await? {
        println!("reset={} events={}", message.reset, message.events.len());
        for event in &message.events {
            match &event.connection {
                Some(connection) => println!(
                    "  type={} id={} user={} up_total={} down_total={} up_delta={} down_delta={}",
                    event.r#type,
                    event.id,
                    connection.user,
                    connection.uplink_total,
                    connection.downlink_total,
                    event.uplink_delta,
                    event.downlink_delta,
                ),
                None => println!(
                    "  type={} id={} (no connection metadata)",
                    event.r#type, event.id
                ),
            }
        }
    }
    Ok(())
}
