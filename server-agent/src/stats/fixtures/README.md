# Stats captures

These files are encoded `daemon.ConnectionEvents` messages captured from the
pinned sing-box **1.14.4** binary (`Dockerfile.test`):

```sh
cargo run --example query_stats -- 127.0.0.1:<stats-port> <fixture-secret> src/stats/fixtures
```

The local fixture used a loopback mixed inbound tagged `node-n1` with user
`blz.1.2.5.n1sub-a`, a direct outbound, and a local HTTP target. `live`,
`update` and `closed` come from one connection. `closed-history` is a reconnect
snapshot after repeated short connections; that run replayed 177 closed
connections. `closed-history-1000` generated 1200 closed proxy connections after
restarting the pinned binary with `GOGC=off`, so upstream's cleanup finalizer did
not clear the retained closed list before the reconnect snapshot; the snapshot
contains exactly the 1000-entry cap. No real token, key or proxy credential
appears in these files.
