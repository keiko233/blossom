//! Manual smoke test for the hand-written v2ray StatsService client.
//!
//! Run a sing-box (built `with_v2ray_api`) with the stats API enabled, push
//! some traffic through an inbound with a named user, then:
//!
//! ```sh
//! cargo run --example query_stats -- 127.0.0.1:18080
//! ```

#[path = "../src/stats.rs"]
mod stats;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let addr = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "127.0.0.1:18080".to_string());
    let mut client = stats::StatsClient::connect_lazy(&addr)?;

    let all = client.query_stats(vec![], false).await?;
    println!("all counters ({}):", all.len());
    for s in &all {
        println!("  {} = {}", s.name, s.value);
    }

    let users = client
        .query_stats(vec!["user>>>".to_string()], true)
        .await?;
    println!("user counters with reset=true ({}):", users.len());
    for s in &users {
        match stats::parse_user_counter(&s.name) {
            Some((sub, dir)) => println!("  sub={sub} {dir:?} delta={}", s.value),
            None => println!("  (unparsed) {} = {}", s.name, s.value),
        }
    }

    let after = client.query_stats(vec![], false).await?;
    println!("all counters after user reset ({}):", after.len());
    for s in &after {
        println!("  {} = {}", s.name, s.value);
    }
    Ok(())
}
