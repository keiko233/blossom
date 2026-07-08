# syntax=docker/dockerfile:1

# ── Stage 1: build sing-box from source with the v2ray-api extension ──────────
# The agent drives sing-box's v2ray API (grpc) for stats/reload, so the binary
# must be compiled with `with_v2ray_api`; the release tarballs don't ship it.
FROM golang:alpine AS singbox
RUN apk add --no-cache git build-base
ENV CGO_ENABLED=0 GOBIN=/out
RUN go install -v -tags with_v2ray_api github.com/sagernet/sing-box/cmd/sing-box@latest
# -> /out/sing-box

# ── Stage 2: build the Rust agent against musl (fully static) ─────────────────
FROM rust:alpine AS agent
# musl-dev/build-base for the C toolchain; openssl (static) for reqwest's
# default-tls; pkgconf so openssl-sys can find it.
RUN apk add --no-cache musl-dev build-base openssl-dev openssl-libs-static pkgconf
# Statically link OpenSSL so the final binary needs no shared libs at runtime.
ENV OPENSSL_STATIC=1 OPENSSL_NO_VENDOR=1 PKG_CONFIG_ALL_STATIC=1

WORKDIR /app
# build.rs generates the API client from this spec, so it must be present before
# any cargo build touches the crate.
COPY Cargo.toml Cargo.lock build.rs ./
COPY openapi ./openapi
COPY src ./src

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --release && \
    cp target/release/server-agent /server-agent

# ── Stage 3: runtime ──────────────────────────────────────────────────────────
FROM alpine:latest
# ca-certificates for TLS to the blossom API; tzdata since sing-box logs local time.
RUN apk add --no-cache ca-certificates tzdata

COPY --from=singbox /out/sing-box /usr/local/bin/sing-box
COPY --from=agent   /server-agent /usr/local/bin/server-agent

# The agent resolves sing-box via PATH when no explicit path is given.
ENV AGENT_SING_BOX_PATH=/usr/local/bin/sing-box

ENTRYPOINT ["server-agent"]
