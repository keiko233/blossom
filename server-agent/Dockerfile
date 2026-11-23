# syntax=docker/dockerfile:1

# Thin runtime image. It deliberately does not contain server-agent or
# sing-box: both are downloaded into the persistent /data volume on first
# start (and upgraded there by the agent). Rebuilding this image therefore
# never pins a sing-box version.

ARG BUILD_ID=local

FROM alpine:3.22
ARG BUILD_ID
LABEL org.opencontainers.image.revision=$BUILD_ID

RUN apk add --no-cache ca-certificates tzdata tini curl jq tar

COPY scripts/entrypoint.sh /usr/local/bin/blossom-entrypoint
RUN chmod 0755 /usr/local/bin/blossom-entrypoint

# /data is the only durable location: binaries, state, certificates and
# download cache all live below it. AGENT_STATE_DIR is kept separate so state
# remains the same when the binaries are upgraded.
ENV AGENT_DATA_DIR=/data \
    AGENT_STATE_DIR=/data/state \
    AGENT_DOWNLOAD_DIR=/data/downloads \
    AGENT_BIN_PATH=/data/bin/server-agent \
    AGENT_SING_BOX_PATH=/data/bin/sing-box \
    AGENT_SELF_UPDATE=1

VOLUME ["/data"]

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/blossom-entrypoint"]
