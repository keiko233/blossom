#!/bin/sh
# Blossom one-line server-agent installer.
#
# Fetch:
#   curl -fsSL <origin>/api/agent/install/<grant>.sh | sh
#   curl -fsSL <origin>/api/agent/install/<grant>.sh | sh -s -- --host
#
# The first form runs the published container image (Docker, default). The
# second installs the binaries and a systemd unit on the host.
#
# This template is rendered by the control plane with validated values. The
# grant in it is a one-time credential: never enable `set -x`, never echo it,
# and keep it out of process arguments on the target host.
set -eu

ORIGIN=@@ORIGIN@@
ENROLLMENT_GRANT=@@ENROLLMENT_GRANT@@
AGENT_VERSION=@@AGENT_VERSION@@
IMAGE=@@IMAGE@@
AGENT_REPO=@@AGENT_REPO@@
SING_BOX_REPO=@@SING_BOX_REPO@@

MODE=docker
for arg in "$@"; do
  case "$arg" in
    --host) MODE=host ;;
    --docker) MODE=docker ;;
    -h|--help)
      cat >&2 <<'USAGE'
Usage: sh -s -- [--host|--docker]
  --docker  Run the published container image (default).
  --host    Install server-agent and sing-box plus a systemd unit.
USAGE
      exit 0
      ;;
    *)
      printf '[blossom] error: unknown option: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

log() {
  printf '[blossom] %s\n' "$*" >&2
}

fail() {
  log "error: $*"
  exit 1
}

case "$ORIGIN" in
  https://*) ;;
  http://localhost:*|http://127.0.0.1:*|http://\[::1\]:*) ;;
  *) fail "the control-plane origin must use https:// (http is allowed only for loopback)" ;;
esac

case "$ENROLLMENT_GRANT" in
  egr_*) ;;
  *) fail "the install link does not contain a valid enrollment grant" ;;
esac
case "$ENROLLMENT_GRANT" in
  *[!A-Za-z0-9_-]*|"") fail "the install link does not contain a valid enrollment grant" ;;
esac
[ "${#ENROLLMENT_GRANT}" -eq 47 ] || fail "the install link does not contain a valid enrollment grant"

download() {
  curl --fail --show-error --silent --location \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --retry 2 --retry-delay 2 --connect-timeout 15 --max-time 300 \
    --output "$2" "$1"
}

install_docker() {
  command -v docker >/dev/null 2>&1 ||
    fail "docker is required; install Docker or rerun with --host"

  volume=blossom-agent-data
  docker volume create "$volume" >/dev/null

  # The image downloads both binaries into /data on first start. `--version`
  # runs nothing else, so this only primes the volume.
  log "preparing the $IMAGE runtime in the $volume volume"
  docker run --rm -v "$volume:/data" \
    -e AGENT_BOOTSTRAP_VERSION="$AGENT_VERSION" \
    -e AGENT_SING_BOX_BOOTSTRAP_VERSION=latest \
    "$IMAGE" --version >/dev/null

  # The grant is written through stdin, so it is not a process argument.
  printf '%s\n' "$ENROLLMENT_GRANT" |
    docker run --rm -i -v "$volume:/data" --entrypoint sh "$IMAGE" -c \
      'umask 077; cat > /data/enrollment-grant; chmod 600 /data/enrollment-grant'
  ENROLLMENT_GRANT=

  log "redeeming the one-time enrollment grant"
  enrolled=0
  docker run --rm --network host -v "$volume:/data" --entrypoint /data/bin/server-agent "$IMAGE" \
    enroll \
    --url "$ORIGIN/api" \
    --grant-file /data/enrollment-grant \
    --credentials-file /data/credentials.json &&
    enrolled=1

  # Remove the spent (or still-unspent) grant from the volume either way.
  docker run --rm -v "$volume:/data" --entrypoint sh "$IMAGE" -c \
    'rm -f /data/enrollment-grant' >/dev/null 2>&1 || true

  [ "$enrolled" -eq 1 ] ||
    fail "enrollment failed; ask an administrator for a fresh install link"

  docker rm -f blossom-agent >/dev/null 2>&1 || true

  # shellcheck disable=SC2086
  docker run -d \
    --name blossom-agent \
    --restart unless-stopped \
    --network host \
    --cap-add NET_ADMIN \
    --device /dev/net/tun:/dev/net/tun \
    -v "$volume:/data" \
    -e AGENT_URL="$ORIGIN/api" \
    -e AGENT_CREDENTIALS_FILE=/data/credentials.json \
    -e AGENT_BOOTSTRAP_VERSION="$AGENT_VERSION" \
    -e AGENT_SING_BOX_BOOTSTRAP_VERSION=latest \
    "$IMAGE" >/dev/null

  log "container blossom-agent started; the server connects when its first handshake succeeds"
  log "follow logs with: docker logs -f blossom-agent"
}

install_host() {
  for tool in curl sed head grep find wc tar uname systemctl id install mkdir mktemp mv rm chmod chown useradd; do
    command -v "$tool" >/dev/null 2>&1 || fail "required tool missing: $tool"
  done
  [ "$(id -u)" -eq 0 ] || fail "run as root (for example: sudo sh -s -- --host)"
  systemctl --version >/dev/null 2>&1 || fail "systemd is required for --host"

  case "$(uname -m)" in
    x86_64|amd64) architecture=amd64 ;;
    aarch64|arm64) architecture=arm64 ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac

  AGENT_FILE=/usr/local/lib/blossom-agent/server-agent
  SING_BOX_FILE=/usr/local/lib/blossom-agent/sing-box
  CONFIG_DIR=/etc/blossom-agent
  STATE_DIR=/var/lib/blossom-agent
  CREDENTIALS_FILE=$CONFIG_DIR/credentials.json
  UNIT_FILE=/etc/systemd/system/blossom-agent.service
  SERVICE_USER=blossom-agent

  if [ "$AGENT_VERSION" = latest ]; then
    agent_url="https://github.com/$AGENT_REPO/releases/latest/download/server-agent-linux-$architecture"
  else
    agent_url="https://github.com/$AGENT_REPO/releases/download/v$AGENT_VERSION/server-agent-linux-$architecture"
  fi

  if [ "${SING_BOX_VERSION:-latest}" = latest ]; then
    sing_box_version=$(curl --fail --show-error --silent --location \
      --retry 2 --retry-delay 2 --connect-timeout 15 --max-time 60 \
      "https://api.github.com/repos/$SING_BOX_REPO/releases/latest" |
      sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -n 1)
    [ -n "$sing_box_version" ] || fail "cannot resolve the latest sing-box release"
  else
    sing_box_version=${SING_BOX_VERSION#v}
  fi
  sing_box_url="https://github.com/$SING_BOX_REPO/releases/download/v$sing_box_version/sing-box-${sing_box_version}-linux-${architecture}-musl.tar.gz"

  staging=$(mktemp -d)
  trap 'rm -rf "$staging"' EXIT HUP INT TERM
  umask 077

  log "downloading server-agent $AGENT_VERSION for $architecture"
  download "$agent_url" "$staging/server-agent"
  chmod 0755 "$staging/server-agent"

  log "downloading sing-box $sing_box_version for $architecture"
  download "$sing_box_url" "$staging/sing-box.tar.gz"
  tar -tzf "$staging/sing-box.tar.gz" >"$staging/sing-box-members"
  if grep -Eq '(^/|(^|/)\.\.(/|$))' "$staging/sing-box-members"; then
    fail "the sing-box archive contains an unsafe path"
  fi
  mkdir -m 0700 "$staging/sing-box"
  tar -xzf "$staging/sing-box.tar.gz" -C "$staging/sing-box"
  sing_box_candidates=$(find "$staging/sing-box" -type f -name sing-box | wc -l)
  [ "$sing_box_candidates" -eq 1 ] || fail "the sing-box archive must contain exactly one sing-box binary"
  staged_sing_box=$(find "$staging/sing-box" -type f -name sing-box)
  chmod 0755 "$staged_sing_box"

  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$SERVICE_USER" ||
      fail "cannot create the $SERVICE_USER service account"
  fi

  install -d -m 0755 /usr/local/lib/blossom-agent
  install -d -m 0700 "$CONFIG_DIR" "$STATE_DIR"
  chown "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR" "$STATE_DIR"

  install -m 0755 "$staging/server-agent" "$AGENT_FILE"
  install -m 0755 "$staged_sing_box" "$SING_BOX_FILE"

  printf '%s\n' "$ENROLLMENT_GRANT" >"$staging/enrollment-grant"
  chmod 0600 "$staging/enrollment-grant"
  ENROLLMENT_GRANT=

  log "redeeming the one-time enrollment grant"
  "$AGENT_FILE" enroll \
    --url "$ORIGIN/api" \
    --grant-file "$staging/enrollment-grant" \
    --credentials-file "$staging/credentials.json" ||
    fail "enrollment failed; ask an administrator for a fresh install link"
  rm -f "$staging/enrollment-grant"
  [ -s "$staging/credentials.json" ] || fail "the enrollment client did not write credentials"

  install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0600 \
    "$staging/credentials.json" "$CREDENTIALS_FILE"

  cat >"$staging/blossom-agent.service" <<EOF_UNIT
[Unit]
Description=Blossom server agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$STATE_DIR
ExecStart=$AGENT_FILE --url $ORIGIN/api --credentials-file $CREDENTIALS_FILE --state-dir $STATE_DIR --sing-box-path $SING_BOX_FILE --download-dir $STATE_DIR/downloads --self-update=false
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictSUIDSGID=true
LockPersonality=true
MemoryDenyWriteExecute=true
CapabilityBoundingSet=CAP_NET_BIND_SERVICE CAP_NET_ADMIN
AmbientCapabilities=CAP_NET_BIND_SERVICE CAP_NET_ADMIN
ReadWritePaths=$STATE_DIR

[Install]
WantedBy=multi-user.target
EOF_UNIT

  install -m 0644 "$staging/blossom-agent.service" "$UNIT_FILE"
  systemctl daemon-reload
  systemctl enable --now blossom-agent >/dev/null
  [ "${BLOSSOM_INSTALL_HEALTH_SECONDS:-5}" -eq 0 ] || sleep "${BLOSSOM_INSTALL_HEALTH_SECONDS:-5}"
  systemctl is-active --quiet blossom-agent ||
    fail "blossom-agent did not become active; inspect: systemctl status blossom-agent"

  log "installed server-agent $AGENT_VERSION and sing-box $sing_box_version"
  log "the server connects when its first handshake succeeds; inspect: systemctl status blossom-agent"
}

case "$MODE" in
  docker) install_docker ;;
  host) install_host ;;
  *) fail "unknown installation mode" ;;
esac
