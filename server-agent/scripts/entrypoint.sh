#!/bin/sh
set -eu

# Thin runtime entrypoint. The image contains tools and this script only; the
# persistent /data volume owns both binaries and all agent state:
#
#   /data/bin/server-agent
#   /data/bin/sing-box
#   /data/state/{active,last-known-good,...}.json
#   /data/state/certificates/
#   /data/downloads/            (bootstrap/update cache)
#
# The agent replaces its own binary and exits with AGENT_RESTART_EXIT_CODE
# (75); this loop starts the replacement. Repeated quick crashes restore
# server-agent.prev (the agent keeps sing-box.prev for its own rollback).

data_dir=${AGENT_DATA_DIR:-/data}
bin_dir="$data_dir/bin"
state_dir=${AGENT_STATE_DIR:-$data_dir/state}
download_dir="$data_dir/downloads"
agent_bin=${AGENT_BIN_PATH:-$bin_dir/server-agent}
sing_box_bin=${AGENT_SING_BOX_PATH:-$bin_dir/sing-box}
seed_dir=${AGENT_SEED_DIR:-}

export AGENT_DATA_DIR="$data_dir"
export AGENT_STATE_DIR="$state_dir"
export AGENT_DOWNLOAD_DIR="$download_dir"
export AGENT_SING_BOX_PATH="$sing_box_bin"
export AGENT_SELF_UPDATE=${AGENT_SELF_UPDATE:-1}

github_api=${AGENT_GITHUB_API:-https://api.github.com}
agent_repo=${AGENT_RELEASE_REPO:-keiko233/blossom}
sing_box_repo=${AGENT_SING_BOX_RELEASE_REPO:-SagerNet/sing-box}
agent_version=${AGENT_BOOTSTRAP_VERSION:-${AGENT_VERSION:-latest}}
sing_box_version=${AGENT_SING_BOX_BOOTSTRAP_VERSION:-${AGENT_SING_BOX_VERSION:-latest}}
# Address family for GitHub requests (release resolution and asset downloads
# only, never the agent's own traffic). `prefer` tries IPv6 first and falls
# back to the default resolution order, which avoids an IPv4 egress that is
# shared, proxied or already rate limited.
github_ipv6=${AGENT_GITHUB_IPV6:-prefer}

log() {
  printf '[entrypoint] %s\n' "$*" >&2
}

fail() {
  log "$*"
  exit 1
}

for tool in curl jq tar sha256sum awk find; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool missing: $tool"
done

mkdir -p "$bin_dir" "$state_dir" "$download_dir"
chmod 700 "$state_dir" 2>/dev/null || true

case "$(uname -m)" in
  x86_64|amd64) release_arch=amd64 ;;
  aarch64|arm64) release_arch=arm64 ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

case "$github_ipv6" in
  prefer|only|off) ;;
  *) fail "AGENT_GITHUB_IPV6 must be prefer, only or off (got: $github_ipv6)" ;;
esac

# $1 is the retry count, the rest are curl arguments.
gh_curl() {
  retries=$1
  shift
  if [ -n "${AGENT_GITHUB_TOKEN:-}" ]; then
    curl -fsSL --retry "$retries" --retry-delay 2 \
      -H "Authorization: Bearer ${AGENT_GITHUB_TOKEN}" \
      "$@"
  else
    curl -fsSL --retry "$retries" --retry-delay 2 "$@"
  fi
}

gh_get() {
  case "$github_ipv6" in
    only)
      gh_curl 3 --ipv6 "$@"
      ;;
    off)
      gh_curl 3 "$@"
      ;;
    *)
      # One short IPv6 attempt, then the default order. A host without a
      # usable IPv6 route fails this quickly instead of stalling the bootstrap.
      gh_curl 0 --ipv6 --connect-timeout 10 "$@" && return 0
      log "IPv6 request failed; retrying with the default address family"
      gh_curl 3 "$@"
      ;;
  esac
}

download() {
  gh_get --connect-timeout 15 --max-time 300 -o "$2" "$1"
}

verify_digest() {
  expected=$1
  file=$2
  case "$expected" in
    sha256:*) ;;
    *) fail "release asset has an unsupported digest: $expected" ;;
  esac
  actual="sha256:$(sha256sum "$file" | awk '{print $1}')"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for $file"
}

seed_binaries() {
  [ -n "$seed_dir" ] || return 0
  if [ ! -x "$agent_bin" ] && [ -x "$seed_dir/server-agent" ]; then
    cp "$seed_dir/server-agent" "$agent_bin"
    chmod 755 "$agent_bin"
    log "seeded agent binary from $seed_dir"
  fi
  if [ ! -x "$sing_box_bin" ] && [ -x "$seed_dir/sing-box" ]; then
    cp "$seed_dir/sing-box" "$sing_box_bin"
    chmod 755 "$sing_box_bin"
    log "seeded sing-box binary from $seed_dir"
  fi
}

select_agent_release() {
  release_file=$1
  asset=$2
  if [ "$agent_version" = latest ]; then
    gh_get "$github_api/repos/$agent_repo/releases?per_page=30" -o "$release_file" ||
      fail "cannot query $agent_repo releases"
    jq -e --arg asset "$asset" '
      [ .[]
        | select((.draft | not) and (.prerelease | not))
        | select(.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))
        | select(any(.assets[]?; .name == $asset))
      ][0]
    ' "$release_file" >"$release_file.selected" ||
      fail "no published v* release with $asset found"
  else
    ver=${agent_version#server-agent-v}
    ver=${ver#v}
    tag="v${ver}"
    gh_get "$github_api/repos/$agent_repo/releases/tags/$tag" -o "$release_file.selected" ||
      fail "cannot resolve agent release $tag"
  fi
}

install_agent() {
  if [ -x "$agent_bin" ]; then
    log "agent binary present: $agent_bin"
    return
  fi
  [ "$agent_version" = none ] && fail "agent binary missing and AGENT_BOOTSTRAP_VERSION=none"

  release_file="$download_dir/agent-release.json"
  asset="server-agent-linux-$release_arch"
  select_agent_release "$release_file" "$asset"
  url=$(jq -er --arg name "$asset" \
    '.assets[] | select(.name == $name) | .browser_download_url' \
    "$release_file.selected") || fail "agent release has no asset $asset"
  digest=$(jq -er --arg name "$asset" \
    '.assets[] | select(.name == $name) | .digest // empty' \
    "$release_file.selected") || fail "agent asset $asset has no digest"

  tmp="$download_dir/server-agent.new"
  log "downloading $asset"
  download "$url" "$tmp"
  verify_digest "$digest" "$tmp"
  chmod 755 "$tmp"
  mv "$tmp" "$agent_bin"
}

select_sing_box_release() {
  release_file=$1
  if [ "$sing_box_version" = latest ]; then
    gh_get "$github_api/repos/$sing_box_repo/releases?per_page=30" -o "$release_file" ||
      fail "cannot query $sing_box_repo releases"
    jq -e '
      [ .[]
        | select((.draft | not) and (.prerelease | not))
        | select(.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))
      ][0]
    ' "$release_file" >"$release_file.selected" ||
      fail "no published sing-box release found"
  else
    tag="v${sing_box_version#v}"
    gh_get "$github_api/repos/$sing_box_repo/releases/tags/$tag" -o "$release_file.selected" ||
      fail "cannot resolve sing-box release $tag"
  fi
}

install_sing_box() {
  if [ -x "$sing_box_bin" ]; then
    log "sing-box binary present: $sing_box_bin"
    return
  fi
  [ "$sing_box_version" = none ] && fail "sing-box binary missing and AGENT_SING_BOX_BOOTSTRAP_VERSION=none"

  release_file="$download_dir/sing-box-release.json"
  select_sing_box_release "$release_file"
  resolved_version=$(jq -er '.tag_name | sub("^v"; "")' "$release_file.selected") ||
    fail "sing-box release has no tag"
  asset="sing-box-${resolved_version}-linux-${release_arch}-musl.tar.gz"
  url=$(jq -er --arg name "$asset" \
    '.assets[] | select(.name == $name) | .browser_download_url' \
    "$release_file.selected") || fail "sing-box release has no asset $asset"
  digest=$(jq -er --arg name "$asset" \
    '.assets[] | select(.name == $name) | .digest // empty' \
    "$release_file.selected") || fail "sing-box asset $asset has no digest"

  archive="$download_dir/$asset"
  log "downloading $asset"
  download "$url" "$archive"
  verify_digest "$digest" "$archive"

  tmpdir="$download_dir/sing-box-${resolved_version}"
  rm -rf "$tmpdir"
  mkdir -p "$tmpdir"
  tar -xzf "$archive" -C "$tmpdir"
  binary=$(find "$tmpdir" -type f -name sing-box | head -n 1)
  [ -n "$binary" ] || fail "archive $asset did not contain sing-box"
  chmod 755 "$binary"
  "$binary" version >/dev/null || fail "downloaded sing-box does not run"
  mv "$binary" "$sing_box_bin"
  rm -rf "$tmpdir" "$archive"
}

seed_binaries
if [ "${AGENT_SKIP_BOOTSTRAP:-0}" != 1 ]; then
  install_agent
  install_sing_box
fi

[ -x "$agent_bin" ] || fail "agent binary missing: $agent_bin"
[ -x "$sing_box_bin" ] || fail "sing-box binary missing: $sing_box_bin"

child_pid=
shutdown() {
  trap - TERM INT
  if [ -n "$child_pid" ]; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  exit 0
}
trap shutdown TERM INT

restart_count=0
window_started=$(date +%s)
while :; do
  "$agent_bin" "$@" &
  child_pid=$!
  set +e
  wait "$child_pid"
  code=$?
  set -e
  child_pid=

  case "$code" in
    0)
      exit 0
      ;;
    75)
      log "agent requested restart"
      restart_count=0
      window_started=$(date +%s)
      continue
      ;;
  esac

  now=$(date +%s)
  if [ $((now - window_started)) -ge 120 ]; then
    restart_count=0
    window_started=$now
  fi
  restart_count=$((restart_count + 1))
  log "agent exited with status $code (failure $restart_count in window)"

  if [ "$restart_count" -ge 3 ] && [ -x "$agent_bin.prev" ]; then
    log "agent crashed repeatedly; restoring previous binary"
    cp "$agent_bin" "$agent_bin.failed" 2>/dev/null || true
    cp "$agent_bin.prev" "$agent_bin"
    chmod 755 "$agent_bin"
    rm -f "$agent_bin.failed"
    restart_count=0
    window_started=$(date +%s)
  fi
  sleep 2
done
