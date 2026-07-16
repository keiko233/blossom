# syntax=docker/dockerfile:1

# ── Stage 1: build a full-featured sing-box from source ───────────────
# Start with the upstream full non-CGO build tags for this exact sing-box
# release, then add v2ray-api because the agent uses it for traffic stats.
FROM golang:alpine AS singbox
RUN apk add --no-cache git build-base
ENV CGO_ENABLED=0
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    module_json="$(go mod download -json github.com/sagernet/sing-box@latest)" && \
    sing_box_version="$(printf '%s\n' "${module_json}" | sed -n 's/^[[:space:]]*"Version": "\([^"]*\)",$/\1/p')" && \
    module_dir="$(printf '%s\n' "${module_json}" | sed -n 's/^[[:space:]]*"Dir": "\([^"]*\)",$/\1/p')" && \
    test -n "${sing_box_version}" && test -n "${module_dir}" && \
    build_tags="$(cat "${module_dir}/release/DEFAULT_BUILD_TAGS_OTHERS"),with_v2ray_api" && \
    make -C "${module_dir}" install PREFIX=/out TAGS="${build_tags}" VERSION="${sing_box_version}"
# -> /out/bin/sing-box

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

COPY --from=singbox /out/bin/sing-box /usr/local/bin/sing-box
COPY --from=agent   /server-agent /usr/local/bin/server-agent

# The agent resolves sing-box via PATH when no explicit path is given.
ENV AGENT_SING_BOX_PATH=/usr/local/bin/sing-box
ENV AGENT_STATE_DIR=/var/lib/blossom-agent

VOLUME ["/var/lib/blossom-agent"]

ENTRYPOINT ["server-agent"]
