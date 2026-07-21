#!/bin/sh
set -eu

image=${1:-blossom/server-agent:managed-tls-test}
mock_port=${MOCK_PORT:-18765}
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/blossom-managed-tls.XXXXXX")
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

openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj /CN=edge.example.com \
  -addext subjectAltName=DNS:edge.example.com \
  -keyout "$test_dir/private-key.pem" \
  -out "$test_dir/fullchain.pem" >/dev/null 2>&1

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

docker run -d --name "$container" \
  --add-host host.docker.internal:host-gateway \
  -p 127.0.0.1::18443 \
  -e AGENT_URL="http://host.docker.internal:$mock_port/api" \
  -e AGENT_TOKEN=integration-test-token \
  -e AGENT_INTERVAL=5 \
  "$image" >/dev/null

attempt=0
until docker logs "$container" 2>&1 | grep -q "sing-box config .* applied"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 40 ]; then
    docker logs "$container" >&2
    exit 1
  fi
  sleep 1
done

docker exec "$container" sh -c '
  test -s /var/lib/blossom-agent/certificates/test-cert/current/fullchain.pem
  test -s /var/lib/blossom-agent/certificates/test-cert/current/private-key.pem
  ! grep -q '"certificate":' /var/lib/blossom-agent/active.json
  ! grep -q '"key":' /var/lib/blossom-agent/active.json
'

host_port=$(docker port "$container" 18443/tcp | sed -n 's/.*://p')
test -n "$host_port"
openssl s_client \
  -connect "127.0.0.1:$host_port" \
  -servername edge.example.com \
  -CAfile "$test_dir/fullchain.pem" \
  -verify_return_error </dev/null >"$test_dir/handshake.log" 2>&1 || true
grep -q "Verify return code: 0 (ok)" "$test_dir/handshake.log"

curl -fsS "http://127.0.0.1:$mock_port/state" | python3 -c '
import json, sys
state = json.load(sys.stdin)
heartbeat = state["heartbeat"]
assert heartbeat["configState"] == "applied", heartbeat
assert heartbeat["runtimeState"] == "running", heartbeat
assert heartbeat["appliedRevision"] == "sha256:managed-tls-integration", heartbeat
event = state["certificateEvent"]
assert event["state"] == "active", event
'

docker logs "$container"
