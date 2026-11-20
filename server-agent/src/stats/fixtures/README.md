# Stats captures

These files are encoded `daemon.ConnectionEvents` messages captured from the
pinned sing-box **1.14.4** binary (`Dockerfile.test`):

```sh
cargo run --example query_stats -- 127.0.0.1:<stats-port> <fixture-secret> src/stats/fixtures
```

The local fixture used a loopback SOCKS inbound tagged `node-n1` with user
`blz.1.2.5.n1sub-a`, a direct outbound, and a local HTTP target. `live`,
`update` and `closed` come from one connection. `closed-history` is a reconnect
snapshot after repeated short connections; that run replayed 177 closed
connections, not the 1000-entry cap the source allows. No real token, key or
proxy credential appears in these files.
