# Rust code guide (`server-agent`)

This guide defines the Rust coding standards for `server-agent/` (Rust edition 2024, standalone crate outside the pnpm workspace). Architectural context, module ownership, safety invariants, and release packaging live in [Server agent](server-agent.md); verification commands live in [Testing and verification](testing.md).

Statements are **Established** unless marked **Recommended**. **Recommended** conventions are mandatory for new modules and features (such as WebSocket multiplexing, telemetry, PTY sessions, and agent ACME issuance), while existing legacy code is updated only within the scope of the active task.

## 1. Toolchain, Formatting, and Lints

- `server-agent/Cargo.toml` targets Rust **edition 2024**; CI checks run on `dtolnay/rust-toolchain@stable`.
- Run all Cargo commands inside `server-agent/`:
  - `cargo test --locked`
  - `cargo fmt --all -- --check`
  - `cargo clippy --locked --all-targets --all-features -- -D warnings`
- The Husky `pre-commit` hook runs `cargo fmt --all` and `cargo clippy --all-targets --all-features --fix --allow-dirty --allow-staged -- -D warnings` across the whole crate whenever `.rs` files are staged ([Workflow](workflow.md#git-hooks)).
- Do not add `#![feature(...)]` or unstable nightly attributes; keep the crate compiling on stable Rust.
- **Recommended**: Keep lint suppressions as narrow as possible (`#[expect(lint, reason = "...")]` preferred over `#[allow(...)]`) with a concrete reason. Never add crate-wide allows to bypass warnings.

## 2. Module Layout and Visibility

- **Recommended**: Keep leaf modules single-responsibility and named after their primary concept or capability role (`ports.rs`, `adapters.rs`, `error.rs`, `tests.rs` inside a capability folder such as `telemetry/`, `ws/`, `pty/`, or `acme/`).
- **Recommended**: Non-leaf `mod.rs` files hold submodule declarations, re-exports, and concise wiring only; split large implementations into focused child modules.
- **Recommended**: Use the narrowest visibility that serves real consumers: private by default, then `pub(super)`, then `pub(crate)`.
- **Recommended**: Avoid glob imports (`use foo::*`) in production modules. The permitted exceptions are `use super::*` inside inline `#[cfg(test)] mod tests` and `use Enum::*` inside functions/blocks that match extensively on one enum.
- **Recommended**: Import traits as `Trait as _` when only their methods are required (`use std::io::Write as _;`). Group `use` imports in standard order (`std`, external crates, `crate`/`super`/`self`) and let `cargo fmt` sort within groups.
- Generated OpenAPI code (`OUT_DIR/codegen.rs`, included in `src/client.rs`) is generated at build time by `build.rs` from `server-agent/openapi/spec.json`; never check generated client code into `src/`.

## 3. API Design, Types, and Traits

- **Recommended**: Accept flexible borrows in function parameters (`&str`, `&[T]`, `&Path`, `Option<&T>`) rather than `&String`, `&Vec<T>`, or `&PathBuf`. Take ownership (`String`, `Vec<u8>`, `PathBuf`) when storing into structs, spawning tasks, or sending over channels.
- **Recommended**: Replace opaque `bool` flags in non-obvious signatures with small domain enums (e.g., `TlsMode::Staging` vs `TlsMode::Production`), while keeping clear binary configuration flags (`enabled: bool`) as booleans.
- **Recommended**: Use typed enums and tagged structs for wire protocols, session state machines, and finite capabilities rather than raw strings or magic integers.
- **Recommended**: Define consumer-owned port traits (`Arc<dyn Port>`) at I/O, OS, network, and `sing-box` process boundaries so new subsystems (WebSocket transport, host/container probes, PTY allocation, ACME DNS/HTTP solvers) can be unit-tested with in-memory fakes without live Docker, network, or root privileges.
- **Recommended**: Implement standard traits (`Display`, `FromStr`, `From`, `TryFrom`) instead of ad hoc conversion helpers. Do not derive `Clone`, `Copy`, or `Default` for handles owning sockets, child processes, or file locks.
- **Recommended**: Use `#[must_use]` on pure builders, guards, and constructors whose return values must not be silently dropped. Use `#[non_exhaustive]` only when modeling externally evolving protocols (e.g., upstream `sing-box` API payloads or negotiated capabilities), keeping internal state machine enums exhaustive so missing arms fail to compile.

## 4. Serialization and Persistence Compatibility

- **Established**: `server-agent` persists runtime and update markers under `AGENT_STATE_DIR` (e.g., last-known-good config, `state/agent-update.json`, `state/*-update-failed.json`, pending traffic batches, and `certificates/<id>/generation-<n>/`).
- **Recommended**: Any newly added field on a persisted state file or backward-compatible API response must carry `#[serde(default)]`, `#[serde(default = "...")]`, or an explicit migration path so an upgraded agent cleanly decodes files written by earlier versions.
- **Recommended**: Protect wire and disk names with `#[serde(rename = "...")]` / `#[serde(rename_all = "...")]` so refactoring a Rust field never silently breaks an on-wire or on-disk contract.

## 5. Error Handling and Panics

- **Established**: Production code must never strand the proxy host ([Server agent](server-agent.md#safety-invariants)); invalid candidates and failed updates roll back cleanly.
- **Recommended**:
  - Use `Option` when absence is normal and needs no cause; use `Result` for all fallible I/O, network, process, certificate, and protocol operations.
  - Prefer typed domain error enums (`thiserror`) in capability modules where callers match, report phase-specific diagnostics (`errorPhase`), or choose retry/fallback behavior. Avoid catch-all `Other(String)` variants when a typed variant applies.
  - Keep `anyhow::Result` at the binary composition root (`main.rs`), CLI setup, and tests, adding `.context(...)` when crossing layers.
  - Never use bare `.unwrap()` in production code. Prefer `?`, `let ... else`, or `.expect("explicit invariant reason")` only for provably unreachable invariants. Inline `#[cfg(test)]` tests may use `.unwrap()` / `.expect(...)`.
  - Never recover a poisoned `std::sync::Mutex` / `RwLock` via `into_inner()`. Keep shared lock scopes tiny and never hold a blocking `std::sync` lock guard across an `.await`.

## 6. Concurrency, Async, and Process Boundaries

- **Established**: `server-agent` uses `tokio` (`features = ["full"]`), `processkit` for child supervision, and `tonic`/`prost` for `sing-box` gRPC stats streaming.
- **Recommended**:
  - Never block Tokio async worker threads with synchronous filesystem/archive extraction, blocking wait loops, or synchronous PTY syscalls; move blocking work to `tokio::task::spawn_blocking` or dedicated OS threads with descriptive names.
  - Propagate structured shutdown via `CancellationToken` (or explicit stop channels) and bound all in-memory telemetry/PTY/WS queues so a stalled network link or runaway process output triggers backpressure/drop policies rather than unbounded memory growth.
  - Use `tokio::sync` primitives only when a guard crosses `.await` or for async message passing (`mpsc`, `watch`, `broadcast`); prefer channel-owned serial state actors/loops over deeply nested `Arc<Mutex<...>>`.

## 7. Security, Secrets, and Unsafe Code

- **Established**: `Authorization: Bearer` headers are marked sensitive (`client.rs`); `tracing` must never emit tokens, private keys, or full config bodies; certificate private keys are written atomically with `0600`/`0700` permissions; TLS uses `rustls` (`ring`).
- **Recommended**:
  - Wrap sensitive strings (bearer tokens, ACME private keys, DNS challenge tokens) in redacting `Debug` wrappers or zeroize/suppress them before logging.
  - Avoid `unsafe` wherever safe Rust or vetted crates suffice. If an OS/PTY call requires `unsafe`, isolate it inside a dedicated small safe wrapper module with a `// SAFETY:` comment explaining every upheld invariant and precondition.
  - Never spawn shell pipelines (`sh -c`) with untrusted or unsanitized control-plane strings; pass `Command::arg(...)` arrays directly and enforce strict validation on versions, paths, and dimensions (e.g., PTY `cols`/`rows`).

## 8. Testing

- **Established**: Inline unit tests (`#[cfg(test)] mod tests`) sit next to the implementation and must run cleanly offline (`cargo test --locked`) without a live `sing-box` binary or network.
- **Recommended**:
  - Test protocol framing, telemetry parsing (including `/proc` / cgroup fixtures), backoff/reconnect state machines, and ACME state transitions against deterministic fakes and `tokio::time::pause()` rather than real `sleep` delays.
  - Assert specific error variants or structured phase payloads instead of `assert!(res.is_err())`.
  - Keep existing Docker end-to-end tests (`scripts/test-managed-tls-docker.sh`) green whenever config, TLS, or agent-control-plane transport contracts change.
