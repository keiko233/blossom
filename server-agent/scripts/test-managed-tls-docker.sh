#!/bin/sh
set -eu

image=${1:-blossom/server-agent:managed-tls-test}
mock_port=${MOCK_PORT:-18765}
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/blossom-managed-tls.XXXXXX")
state_dir="$test_dir/state"
container="blossom-managed-tls-test-$$"
mock_pid=""

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  if [ -n "$mock_pid" ]; then
    kill "$mock_pid" >/dev/null 2>&1 || true
    wait "$mock_pid" 2>/dev/null || true
  fi
  rm -r "$test_dir"
}
trap cleanup EXIT INT TERM

mkdir -p "$state_dir"

# A self-signed certificate valid for a decade, so restart and stale-LKG
# scenarios never trip on an expiring fixture.
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -subj /CN=edge.example.com \
  -addext subjectAltName=DNS:edge.example.com \
  -keyout "$test_dir/private-key.pem" \
  -out "$test_dir/fullchain.pem" >/dev/null 2>&1

export EXPECTED_FINGERPRINT=$(shasum -a 256 "$test_dir/fullchain.pem" | awk '{print $1}')

python3 "$(dirname "$0")/../tests/mock_control_plane.py" \
  --port "$mock_port" \
  --certificate "$test_dir/fullchain.pem" \
  --private-key "$test_dir/private-key.pem" &
mock_pid=$!

attempt=0
until curl -fsS "http://127.0.0.1:$mock_port/health" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 20 ]; then
    echo "mock control plane did not start" >&2
    exit 1
  fi
  sleep 1
done

start_agent() {
  docker run -d --name "$container" \
    --add-host host.docker.internal:host-gateway \
    -p 127.0.0.1::18443 \
    -v "$state_dir:/var/lib/blossom-agent" \
    -e AGENT_URL="http://host.docker.internal:$mock_port/api" \
    -e AGENT_TOKEN=integration-test-token \
    -e AGENT_INTERVAL=5 \
    "$image" >/dev/null
}

stop_agent() {
  docker stop "$container" >/dev/null
  docker rm "$container" >/dev/null
}

wait_log() {
  attempt=0
  until docker logs "$container" 2>&1 | grep -q "$1"; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 90 ]; then
      echo "timed out waiting for log: $1" >&2
      docker logs "$container" >&2
      exit 1
    fi
    sleep 1
  done
}

# Waits until the agent's last heartbeat is truthful for the managed-TLS
# deployment: running, applied, the exact revision, and the certificate
# installed and in use with the exact advertised fingerprint.
wait_healthy_heartbeat() {
  attempt=0
  until curl -fsS "http://127.0.0.1:$mock_port/state" 2>/dev/null |
    python3 -c '
import json
import os
import sys

state = json.load(sys.stdin)
h = state.get("lastHeartbeat") or {}
fingerprint = os.environ.get("EXPECTED_FINGERPRINT", "")
healthy = (
    h.get("agentBuildId") is not None
    and len(h.get("agentCapabilities", [])) > 0
    and h.get("runtimeState") == "running"
    and h.get("configState") == "applied"
    and h.get("appliedRevision") == "sha256:managed-tls-integration"
    and len(h.get("certificateDeployments", [])) == 1
    and h["certificateDeployments"][0]["certificateId"] == "test-cert"
    and h["certificateDeployments"][0]["generation"] == 1
    and h["certificateDeployments"][0]["installed"] is True
    and h["certificateDeployments"][0]["inUse"] is True
    and h["certificateDeployments"][0]["fingerprintSha256"] == fingerprint
    and "error" not in h
)
sys.exit(0 if healthy else 1)
'; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 120 ]; then
      echo "timed out waiting for a healthy heartbeat" >&2
      curl -fsS "http://127.0.0.1:$mock_port/state" || true
      docker logs "$container" >&2
      exit 1
    fi
    sleep 1
  done
}

assert_clean_active() {
  docker exec "$container" sh -c '
    ! grep -q "\"certificate\":" /var/lib/blossom-agent/active.json
    ! grep -q "\"key\":" /var/lib/blossom-agent/active.json
    ! grep -q "$1" /var/lib/blossom-agent/active.json
    grep -q "generation-1/fullchain.pem" /var/lib/blossom-agent/active.json
  ' sh "$1"
}

handshake() {
  host_port=$(docker port "$container" 18443/tcp | sed -n 's/.*://p')
  test -n "$host_port"
  openssl s_client \
    -connect "127.0.0.1:$host_port" \
    -servername edge.example.com \
    -CAfile "$test_dir/fullchain.pem" \
    -verify_return_error </dev/null >"$test_dir/handshake.log" 2>&1 || true
  grep -q "Verify return code: 0 (ok)" "$test_dir/handshake.log"
}

# ── Phase 1: fresh apply + exact real TLS handshake ──────────────────────────
echo "== phase 1: fresh managed TLS apply =="
start_agent
wait_log "sing-box config .* applied"
wait_healthy_heartbeat

docker exec "$container" sh -c '
  test -s /var/lib/blossom-agent/certificates/test-cert/generation-1/fullchain.pem
  test -s /var/lib/blossom-agent/certificates/test-cert/generation-1/private-key.pem
'
assert_clean_active "ESCAPED-NOT-REAL-PEM"
handshake
echo "phase 1 ok"

# ── Phase 2: restart with persisted state (offline LKG startup) ──────────────
echo "== phase 2: restart with persisted state =="
stop_agent
start_agent
wait_healthy_heartbeat
handshake
echo "phase 2 ok"

# ── Phase 3: stale malformed LKG must be repaired, never launched ────────────
echo "== phase 3: stale malformed LKG repair =="
stop_agent

# Corrupt the authoritative LKG with the historical escaped/non-PEM inline
# material while keeping valid generation material on disk. The agent must
# repair from generation storage and never launch the malformed payload.
cat >"$state_dir/last-known-good.json" <<'JSON'
{
  "inbounds": [
    {
      "listen": "0.0.0.0",
      "listen_port": 18443,
      "tag": "node-node-test",
      "tls": {
        "certificate": [
          "-----BEGIN CERTIFICATE-----\\nESCAPED-NOT-REAL-PEM-CONTENT\\n-----END CERTIFICATE-----"
        ],
        "certificate_path": "/var/lib/blossom-agent/certificates/test-cert/generation-1/fullchain.pem",
        "enabled": true,
        "key": [
          "-----BEGIN PRIVATE KEY-----\\nESCAPED-NOT-REAL-PEM-CONTENT\\n-----END PRIVATE KEY-----"
        ],
        "key_path": "/var/lib/blossom-agent/certificates/test-cert/generation-1/private-key.pem",
        "server_name": "edge.example.com"
      },
      "type": "vless",
      "users": [
        {
          "name": "integration-test",
          "uuid": "550e8400-e29b-41d4-a716-446655440000"
        }
      ]
    }
  ],
  "log": {
    "level": "info",
    "timestamp": true
  },
  "outbounds": [
    {
      "tag": "direct",
      "type": "direct"
    }
  ]
}
JSON

start_agent
wait_healthy_heartbeat
assert_clean_active "ESCAPED-NOT-REAL-PEM"
handshake
echo "phase 3 ok"

docker logs "$container"
echo "managed TLS lifecycle test passed"
