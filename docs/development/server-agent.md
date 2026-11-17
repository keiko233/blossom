# Server agent (Rust)

`server-agent/` is a standalone crate (edition 2024, no Cargo workspace, not part of the pnpm workspace). One agent runs per physical proxy server. It pulls the server's desired state from the control plane, keeps one sing-box process running to match it, reports its applied revision, and reports per-user traffic. Run all `cargo` commands from inside `server-agent/`.

Statements are **Established** unless marked **Recommended**.

## Module map

| File               | Responsibility                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.rs`      | CLI (`clap`, flags mirrored by `AGENT_*` env vars), startup from the last-known-good config, the config-poll and heartbeat loops, shutdown.                      |
| `src/client.rs`    | Wraps the progenitor-generated client; injects the `Authorization: Bearer` token as a sensitive default header.                                                  |
| `src/config.rs`    | Fetches the v3 desired state, applies certificate bindings to the base sing-box config, writes candidates, tracks active / last-known-good, reports errors.      |
| `src/certificate.rs` | Validated, generation-addressed certificate store under `<state_dir>/certificates/<id>/generation-<n>/`.                                                      |
| `src/process.rs`   | Supervises the sing-box child (`processkit`): log forwarding, restart with backoff, graceful replacement, `sing-box check` preflight.                            |
| `src/stats.rs`     | Hand-written tonic/prost client for sing-box's v2ray `StatsService` (no `.proto` files, no `tonic-build`).                                                       |
| `src/traffic.rs`   | Collects per-user counter deltas, maps them to subscription/node ids and reports them.                                                                           |
| `build.rs`         | Generates the API client from `openapi/spec.json` and stamps the build id (see below).                                                                           |
| `examples/query_stats.rs` | Manual smoke test for the stats client against a running sing-box built `with_v2ray_api`.                                                               |
| `tests/mock_control_plane.py`, `scripts/test-managed-tls-docker.sh` | Docker-based end-to-end test of the managed-TLS lifecycle against a mock control plane.                                |

## Contract with the control plane

- The agent's build-time contract with the app is the OpenAPI document `openapi/spec.json`; at runtime it talks to the app over that API. `build.rs` reads it, rewrites OAS 3.1 nullable `anyOf: [T, {type: "null"}]` into OAS 3.0 `nullable: true` in memory, and runs progenitor to produce `OUT_DIR/codegen.rs`, included by `src/client.rs`. The generated code is never committed. A missing spec fails the build with a message pointing at `pnpm agent:spec`.
- Method names come from the spec's `operationId`s (`get_agent_config_v3`, `agent_heartbeat`, `report_agent_traffic`). Renaming an `operationId` in the app breaks the agent build — that is the intended signal.
- `--url`/`AGENT_URL` must include the `/api` prefix; spec paths are relative to it.
- The agent advertises capabilities in its heartbeat (`AGENT_CAPABILITIES` in `main.rs`: `config-v3`, `managed-tls-v3`, `certificate-deployments-v1`, `atomic-config-rollback`). Add a capability when the agent gains behaviour the control plane may want to depend on.
- `desiredRevision` is opaque to the agent: equality and content comparison only. The control plane parses its own sequence prefix back out of the reported `appliedRevision` for the [publish gate](architecture.md#publish-gate).
- The poll and heartbeat intervals come from the control plane per server; `AGENT_INTERVAL` is only the bootstrap value.

## Safety invariants

These are the behaviours the code and its comments establish. Preserve them when editing; each has unit tests worth extending.

- **Never strand the host.** A candidate config is written, then checked by the target sing-box binary (`sing-box check`), and only then replaces the active config. The previous good config is persisted as last-known-good in `AGENT_STATE_DIR` (default `/var/lib/blossom-agent`) and used for rollback and for startup after a restart. A new process must survive a probation period (`RUNTIME_PROBATION`) before the candidate is committed.
- **Do not trust the base config for certificates.** Bindings are matched by exact `inboundTag`, artifacts by exact `certificateId` + `generation`, and only local `certificate_path`/`key_path` are injected. Inline material or control-plane paths in the base config are never trusted.
- **Validate before staging.** Certificate artifacts are checked (PEM chain, key, key-pair match, SANs, validity, fingerprint), line endings are normalised, and files are written atomically with `0600`/`0700` permissions. Generations are never garbage-collected by the agent.
- **Report honestly.** `installed` is reported once material is staged and validated; `inUse` only after the candidate has been committed.
- **Self-heal.** An equal `desiredRevision` is skipped only while the active config still parses and every referenced generation still validates.
- **Secrets stay out of logs.** The token header is marked sensitive; keep tokens, keys and full config bodies out of `tracing` output.

## Traffic delivery

The agent reads and resets sing-box user counters, seals each batch with a stable report ID, and stores pending batches under `AGENT_STATE_DIR/traffic/pending` before posting them. Acknowledged batches are removed; retries and restarts reuse the same ID. The control plane deduplicates IDs per server for 30 days and applies history and quota updates in one statement. Older control planes do not acknowledge IDs and cannot guarantee replay-safe accounting. Legacy agents send no IDs and also lack that guarantee.

This is not unconditional zero-loss accounting. Counters can be lost if sing-box or the agent crashes before they are collected and persisted; a full or unavailable state directory also leaves data in memory. Pending batches older than seven days are discarded with an error to avoid replaying after the ledger retention window; permanently rejected batches are moved aside. Protect and monitor the state directory, and report these limits rather than claiming exactly-once collection.

## Checks

These mirror the `server-agent` job in `.github/workflows/test.yml`:

```bash
cd server-agent
cargo test --locked
cargo fmt --all -- --check
cargo clippy --locked --all-targets --all-features -- -D warnings
```

- Unit tests are inline in each module (`#[test]` / `#[tokio::test]`); they need neither sing-box nor a network. `rcgen` (dev-dependency) builds throw-away certificates for the certificate tests.
- CI additionally builds the agent image and runs the managed-TLS lifecycle test:

  ```bash
  docker build --build-arg BUILD_ID=managed-tls-test -t blossom/server-agent:managed-tls-test .
  scripts/test-managed-tls-docker.sh blossom/server-agent:managed-tls-test
  ```

  The image build compiles sing-box from source and is slow; the script needs Docker, `python3` and `curl`, starts a mock control plane on port 18765 (override with `MOCK_PORT`) and a container, and cleans both up on exit. Run it when you change certificate handling, config application or the heartbeat/reporting contract; skip it for unrelated edits and say so.
- The pre-commit hook runs `cargo fmt` and `cargo clippy --fix` on staged `.rs` files (see [Workflow](workflow.md#git-hooks)).
- `cargo run` starts a long-running process. It needs a reachable control plane, an agent token and a sing-box binary (built with the `with_v2ray_api` tag for traffic stats), and it launches and supervises sing-box, which binds the inbound ports the control plane assigns. Its state directory defaults to `/var/lib/blossom-agent`, so pass `--state-dir` (or `AGENT_STATE_DIR`) pointing at a temporary directory when experimenting, point `--url` at a disposable local control plane rather than a production one, and never run it on a host whose real proxy you depend on. The mock control plane used by the Docker lifecycle test is the contained way to exercise the agent end to end. Whether to run any of this is for the task instructions to decide.

## Changing the agent

1. If the change needs a new or changed API field, change the app first ([API, data and auth](api-data-auth.md#agent-api-orpc)), then regenerate the spec ([Generated files](generated-files.md#agent-openapi-spec-and-client)).
2. `cargo build` (or `cargo test`) regenerates the client; fix compile errors at the call sites.
3. Keep behaviour compatible with the control plane versions that may still be deployed. **Recommended**: when the agent starts depending on a new response field, treat its absence as the old behaviour for at least one release rather than failing.
4. Add a unit test next to the code you changed. For anything touching certificate or reload flow, run the Docker lifecycle test above.
5. Docker images: the build id comes from `BUILD_ID` / `AGENT_BUILD_ID`, falling back to `local-<short git sha>` or `local`. CI passes the commit SHA.

## Releasing

Static binaries are published by `.github/workflows/server-agent-release.yml`, which is separate from the Docker image release in `docker.yml`:

1. Bump `version` in `server-agent/Cargo.toml` (and let `cargo check`/`cargo build` update `Cargo.lock`).
2. Tag and push the tag as `server-agent-vX.Y.Z`; it must match the `Cargo.toml` version or the workflow fails.
3. The workflow runs `cargo test --locked`, `cargo fmt --check` and `cargo clippy -D warnings`, then builds fully static musl binaries per architecture (amd64 on `ubuntu-latest`, arm64 on `ubuntu-24.04-arm`, both inside a `rust:alpine` container like the Dockerfile's build stage) and publishes a GitHub Release with `server-agent-linux-amd64`, `server-agent-linux-arm64` and a `SHA256SUMS` covering them. Asset names carry no version so `releases/download/<tag>/...` URLs stay stable (`releases/latest/download/...` does not point at these releases); releases are published with `make_latest: false`, and consumers must resolve releases via the `server-agent-v` tag prefix (GitHub API `GET /repos/{owner}/{repo}/releases` filtered by `tag_name`), since this repo also publishes app image `v*` tags that share the `latest` feed.

`workflow_dispatch` runs only build and check; a release is created only from a `server-agent-v*` tag.
