# Installing and running the server agent

One `server-agent` runs per physical proxy server, separately from the control plane. It pulls that server's desired state, runs one sing-box process, reports its applied revision and traffic, and persists a last-known-good config. Developer-facing detail is in the [Server agent handbook](../development/server-agent.md).

## Contract with the control plane

Verified (code):

- Config endpoint: `GET <AGENT_URL>/agent/config/v3` (operation `getAgentConfigV3`). `AGENT_URL` **must include the `/api` prefix**, e.g. `https://blossom.example.com/api`, because spec paths are relative to it.
- Other endpoints: `POST /agent/heartbeat` and `POST /agent/traffic`. All three authenticate with `Authorization: Bearer <agent token>`, resolved to exactly one server by hash.
- The agent advertises capabilities `config-v3`, `managed-tls-v3`, `certificate-deployments-v1`, `atomic-config-rollback`, `connection-stream-traffic`, `ws-v1`, `telemetry-v1`, and `acme-v1` in its heartbeat. It adds `pty-v1` only when the interactive terminal is enabled.
- Intervals come from the control plane per server (config poll 5–86400 s, heartbeat 5–300 s). `AGENT_INTERVAL` (default 60) is only the bootstrap value.
- A candidate config is checked with `sing-box check` before it replaces the active one; the previous good config is kept and used for rollback and for startup.

Older notes and agents may refer to `/agent/config/v2`. The control plane no longer serves it; v3 is the only config endpoint.

### Interactive terminal (opt-in)

The admin server page can open an interactive shell through the agent's existing outbound WebSocket. This is **off by default**: restart the agent with `AGENT_PTY_ENABLED=true` (or `--pty-enabled`) to advertise `pty-v1`. Optional bounds are `AGENT_PTY_MAX_SESSIONS` (default 2, maximum 4), `AGENT_PTY_IDLE_TIMEOUT_SECONDS` (default 900) and `AGENT_PTY_MAX_SESSION_SECONDS` (default 3600). The shell runs as the agent's OS user, with that user's filesystem and network permissions; session start and end are written to the admin audit log, but terminal input and output are never stored. No inbound agent port is opened. If the agent is not on the WebSocket transport, the terminal is unavailable.

## Install

1. In the admin UI, create the server (or reset its token). The plaintext token (`agt_...`) is shown **once**; only a hash and a short prefix are stored.
2. On the proxy server, from a checkout of the `server-agent/` directory (or with a copy of its `docker-compose.yaml` and `.env.example`):

   ```bash
   cp .env.example .env
   chmod 600 .env
   # edit .env: AGENT_URL=https://blossom.example.com/api  AGENT_TOKEN=<token>
   docker compose up -d
   ```

   Verified (code): `server-agent/docker-compose.yaml` requires `AGENT_URL` and `AGENT_TOKEN` (`:?` guards), uses host networking, `NET_ADMIN` and `/dev/net/tun`, a named volume `agent-data` at `/data`, `restart: unless-stopped` and log rotation (10 MB × 3). The image is a thin runtime: it contains `curl`, `jq`, `tar`, `tini` and the entrypoint, not sing-box or the agent binary.

3. On first start the entrypoint downloads the requested agent and sing-box releases into `/data/bin` and verifies the SHA-256 digest GitHub reports for each asset. Defaults are `AGENT_BOOTSTRAP_VERSION=latest` and `AGENT_SING_BOX_BOOTSTRAP_VERSION=latest`. Set either to an exact version (or `none` to refuse an automatic download) for a pinned bootstrap. Existing binaries are never overwritten by the bootstrap; later upgrades are driven by the control plane.
   The agent download requires a published `server-agent-v*` GitHub release. Until one exists (or when using a fork/mirror), set `AGENT_RELEASE_REPO`/`AGENT_GITHUB_API` to the release source, or provide `AGENT_SEED_DIR` with `server-agent` and `sing-box` binaries for an offline first start.

   For that offline start, drop the two binaries in a directory on the host and mount it read-only; any binary already executable under `/data/bin` is left alone, so nothing is fetched:

   ```yaml
       volumes:
         - agent-data:/data
         - /opt/blossom-seed:/seed:ro
       environment:
         AGENT_SEED_DIR: /seed
   ```

   Seeding can also be done without a rebuild by copying into the volume directly (`docker create -v agent-data:/data …`, `docker cp server-agent <container>:/data/bin/server-agent`, then `docker rm`). `AGENT_SKIP_BOOTSTRAP=1` additionally refuses any download on start; it needs both binaries present.
4. Prefer a pinned prebuilt image over `latest`: `ghcr.io/keiko233/blossom/server-agent:sha-<commit>` or a semver tag (tags are listed in the root README). Pinning the image now pins only the runtime/entrypoint, not sing-box.

The first start needs outbound access to `api.github.com`, `github.com` release downloads and the blossom API. If unauthenticated GitHub API rate limits are a problem, set `AGENT_GITHUB_TOKEN` (a read-only token is enough); it is used only for release API/download requests and is never logged.

`AGENT_GITHUB_IPV6` selects the address family for those entrypoint requests (never for the agent's own API/update traffic):

| Value             | Behaviour                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `prefer` (default) | One short IPv6 attempt per request, then the default resolution order                         |
| `only`            | IPv6 only; bootstrap fails when an AAAA record or route is missing                             |
| `off`             | No family preference (curl's default)                                                          |

This only helps when the host has IPv6 connectivity *and* the name resolves to AAAA: some resolvers (and `api.github.com` on some networks) return A records only, and then the request stays on IPv4 regardless. A rate-limited IPv4 egress is fixed by `AGENT_GITHUB_TOKEN` or by seeding binaries, not by the family preference.

## Systemd installation (OAuth enrollment)

Phase 2B installs a Linux systemd service with a per-server OAuth machine identity. The control plane renders one fixed installer template from trusted data; the archive download cannot replace the expected SHA-256. The installer defaults to OAuth and does not use `AGENT_TOKEN`.

The installer requires Linux, amd64 or arm64, systemd, root for the one-time setup, `curl`, `sha256sum`, `tar`, and the standard systemd account tools. It refuses command-line arguments, unsupported architectures, missing prerequisites, HTTP release URLs, and digest or version mismatches.

### Approved release gate

The control plane approves releases in [`app/src/lib/agent-installer-releases.ts`](../../app/src/lib/agent-installer-releases.ts). The catalog is empty until a release is reviewed. An entry pins the release version, both architecture URLs, both agent SHA-256 digests and the compatible sing-box version/digests. A release is usable only when it declares `installerContract: 1` and these capabilities:

- `oauth-enrollment-cli-v1` — the binary implements the `enroll` command below.
- `credentials-file-v1` — the runtime accepts `--credentials-file`.
- `oauth-ws-v1` — the agent can authenticate its WebSocket session with the machine identity.

Until a compatible entry exists, `createAgentEnrollmentGrant` and the download route refuse with a conflict. Do not add a digest obtained from an unverified mirror; copy it from the reviewed release after checking `SHA256SUMS`.

### One-time script delivery

The audited `createAgentEnrollmentGrant` POST selects the approved release and creates a 15-minute grant. Its `delivery` field chooses one of two modes:

- `inline` returns `script.content` once. The script contains the grant, takes no arguments and changes its own mode to `0600` when it is a regular file. Save it on the administrator's machine with mode `0600`, run it once as root on the target host, then delete it. If the response is lost, revoke the grant and create a fresh one; the download route never reveals it.
- `stdin` (the default) returns `secret` once and a `downloadPath`, not a secret-bearing file. Download the script from the fixed same-origin admin route:

  ```text
  /api/admin/servers/<serverId>/installation/script/<grantId>
  ```

  The route requires the admin session, checks that the grant belongs to that server and is still unspent and unexpired, and returns an attachment with `Cache-Control: private, no-store`. Every later download omits the grant. Put the one-time grant in a `0600` file and pipe it without putting it in argv:

  ```bash
  install -m 600 /dev/null /root/blossom-enrollment-grant
  # Write exactly one egr_... line into the protected file, then:
  sudo BLOSSOM_GRANT_STDIN=1 sh /root/blossom-agent-install.sh < /root/blossom-enrollment-grant
  rm -f /root/blossom-enrollment-grant
  ```

Neither mode puts the grant or client secret in a filename, URL, audit payload or process argument. The script passes only a temporary grant-file path to the Rust client.

### Rust enrollment CLI and credential handoff

The approved binary must implement this exact issuance interface. The installer calls it after staging and verifying both binaries:

```bash
/usr/local/lib/blossom-agent/server-agent enroll \
  --url https://blossom.example.com/api \
  --grant-file /protected/one-line-grant \
  --credentials-file /protected/credentials.json
```

The client:

1. Reads the `egr_...` grant from the one-line file (mode `0600`) and never accepts it as a positional argument, flag, environment value, URL component or stdin prompt.
2. POSTs `{ "enrollmentGrant": "..." }` to `<url>/agent/enrollment/redeem` with `Content-Type: application/json`.
3. Writes the successful response body atomically to `--credentials-file` with mode `0600`, and writes no secret to stdout, stderr or logs.
4. Exits non-zero without writing credentials on any non-200 response. A lost response is not retried for a secret; an administrator revokes the grant/pending identity and issues a fresh grant.

The credential file is the redemption response verbatim and contains:

```json
{
  "serverId": "...",
  "identityId": "...",
  "generation": 1,
  "identityStatus": "pending",
  "clientId": "agent_...",
  "clientSecret": "ags_...",
  "clientAuthMethod": "client_secret_basic",
  "grantType": "client_credentials",
  "tokenEndpoint": "https://blossom.example.com/api/auth/oauth2/token",
  "issuer": "https://blossom.example.com/api/auth",
  "resource": "https://blossom.example.com/api/agent",
  "scope": "blossom:agent:connect",
  "tokenLifetimeSeconds": 900
}
```

The service runs the binary with the same credential file; the file is the only OAuth credential input:

```bash
/usr/local/lib/blossom-agent/server-agent \
  --url https://blossom.example.com/api \
  --credentials-file /etc/blossom-agent/credentials.json \
  --state-dir /var/lib/blossom-agent \
  --sing-box-path /usr/local/lib/blossom-agent/sing-box \
  --download-dir /var/lib/blossom-agent/downloads \
  --self-update=false
```

The WebSocket client obtains and refreshes its token from `tokenEndpoint`, `clientId` and `clientSecret`; it must not print or audit those fields. A first enrollment remains pending until the WebSocket handshake promotion in the companion change. A `replace` grant is also pending until that companion promotes the new generation.

The credential file selects protocol v2 automatically, so the unit above does
not pass `--ws-protocol`. A static `--token` remains an explicit legacy or
backup mode: it defaults to v1 unless `--ws-protocol v2` is also given, and the
agent refuses to combine it with `--credentials-file`. OAuth failures never
fall back to a static token or the HTTP agent API.

At startup the service checks that the credential file is a regular file owned
by the service user with exactly mode `0600`. It also re-checks that
`tokenEndpoint`, `issuer` and `resource` are on the configured origin before
it sends the client secret. Tokens are requested with
`grant_type=client_credentials`, the credential's `resource` and
`blossom:agent:connect`, and are refreshed before their advertised lifetime
ends. A refresh failure retries with bounded backoff (1s to 60s); while the
token endpoint or WebSocket is unavailable the agent keeps the last-known-good
sing-box process running and does not poll `/agent/config/v3`, `/heartbeat` or
`/traffic`. Replacing the credential file with a new `replace` grant is picked
up on the next refresh, and a service restart reuses the same file.

The client secret and every issued token are registered with the bounded,
scoped log redactor under a dedicated OAuth scope, and previous token values
stay masked after a refresh or rotation. The grant, the secret and the token
are never written to stdout, stderr, tracing output or the retained log buffer.

### Installed layout and permissions

| Path | Owner and mode | Contents |
| --- | --- | --- |
| `/usr/local/lib/blossom-agent/server-agent` | `root:root 0755` | verified agent |
| `/usr/local/lib/blossom-agent/sing-box` | `root:root 0755` | verified sing-box |
| `/usr/local/lib/blossom-agent/*.previous` | `root:root 0755` | previous agent, sing-box and unit after a successful replacement |
| `/etc/blossom-agent/` | `blossom-agent:blossom-agent 0700` | installation metadata and credentials |
| `/etc/blossom-agent/credentials.json` | `blossom-agent:blossom-agent 0600` | OAuth machine credential |
| `/etc/blossom-agent/installation.json` | `root:root 0600` | server ID, origin, release, grant ID and mode |
| `/var/lib/blossom-agent/` | `blossom-agent:blossom-agent 0700` | configs, certificates, traffic queue, downloads |
| `/etc/systemd/system/blossom-agent.service` | `root:root 0644` | fixed unit |

The unit runs as `User=blossom-agent`/`Group=blossom-agent`, not root. It sets `UMask=0077`, `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=true`, a read-write exception only for `/var/lib/blossom-agent`, and only `CAP_NET_BIND_SERVICE` (needed for low ports such as an ACME HTTP-01 responder). `--self-update=false` keeps binary replacement under this installer.

Upgrade a systemd installation by rerunning a script created from the new approved release. The service account cannot replace the root-owned binaries, and agent self-update is disabled; do not depend on control-plane desired-version updates for this layout.

### Reruns, conflicts and rollback

- Running the same script for the same server and grant is a no-op when the installed binary exists and the service is active. It does not download or redeem again. If the service is inactive, it restarts the existing installation with the existing credential.
- The same server and origin with a new grant is a normal credential replacement or upgrade. The script stages and verifies new artifacts, replaces the service atomically and keeps the existing state, certificates and traffic queue.
- A different server, origin or unidentifiable existing installation requires `BLOSSOM_INSTALL_CONFIRM=replace`. The previous state directory is moved to `/var/lib/blossom-agent.previous-<UTC timestamp>` so a different server cannot inherit its config or certificates.
- If staging, enrollment, replacement or service activation fails after commit starts, the script stops the new unit and restores the previous binary, sing-box, unit, credentials, metadata and state. It then reloads systemd and starts the previous service. On a clean install it removes the new unit and files. `systemctl status blossom-agent --no-pager` reports the local service separately from the control plane's first configuration acknowledgment.

Uninstall on the host:

```bash
systemctl disable --now blossom-agent
rm -f /etc/systemd/system/blossom-agent.service
systemctl daemon-reload
rm -rf /usr/local/lib/blossom-agent /etc/blossom-agent /var/lib/blossom-agent
userdel blossom-agent
```

Choose whether to preserve `/var/lib/blossom-agent` before deleting it; it contains certificate private keys and the traffic queue. Revoke the server's identity in the control plane before discarding the credential or reusing the host.

### The generated Docker command embeds the secret

The admin UI's token dialog offers a ready-made `docker run` command that contains `-e AGENT_TOKEN=<token>` in plain text (`token-reveal-dialog.tsx`). Anyone who sees that command sees the credential for that server's config, which includes proxy user credentials. Do not paste it into chat, tickets, CI logs, screenshots or shared terminal recordings.

Recommended handling:

- Use the `.env` + Compose route above. The token then lives in a `0600` file instead of shell history and process listings. It is still visible to anyone who can run `docker inspect` on the container, so restrict Docker access on that host.
- The agent reads the token only from `AGENT_TOKEN` or `--token` (verified in `main.rs`); there is no `*_FILE` variant, so Docker/Compose file-based secrets cannot be consumed without a wrapper.
- If a command or token was exposed, reset the server's token in the admin UI and update the agent's `.env`. A reset replaces the stored hash, so the old token stops authenticating on its next request (code path inspected; not exercised).
- The generated command now mounts `-v blossom-agent-data:/data`; without a persistent volume, recreating the container loses both binaries and state.

## State persistence

The image declares `/data` as a volume. Do not mount only a subdirectory: mount the whole `/data` volume so the downloaded binaries and the agent state travel together. Verified (code):

| Path under `/data`                                         | Contents                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------- |
| `bin/server-agent`, `bin/server-agent.prev`                | running agent and the previous binary kept for crash rollback    |
| `bin/sing-box`, `bin/sing-box.prev`                        | running sing-box and the previous binary kept for rollback       |
| `state/active.json`, `state/candidate.json`, `state/last-known-good.json` | sing-box configs: running, being checked, and previous good |
| `state/state.json`                                         | applied revision, active node IDs, certificate deployment records |
| `state/certificates/<id>/generation-<n>/`                  | `fullchain.pem` and `private-key.pem`, files `0600`, directories `0700` |
| `state/agent-update.json`, `state/*-update-failed.json`    | in-flight/failed update markers used for rollback and retry cooldown |
| `downloads/`                                               | bootstrap/update cache; safe to delete while the agent is stopped |

Implications:

- The generated `docker run` command mounts `blossom-agent-data:/data`, and Compose uses a named volume with the same intent. A container without a volume gets an anonymous one: it survives `docker restart`, but recreating the container strands both the binaries and the state.
- Losing the state volume is recoverable: the next successful pull re-fetches config and certificate artifacts from the control plane. What is lost is the ability to start the last-known-good config while the control plane is unreachable.
- The volume holds certificate **private keys** in plaintext files. Protect any backup of it like a key store. See [Backup and recovery](backup-restore.md#agent-state).
- The token is not stored in the state directory; keep it in your secret store.
- The agent never garbage-collects certificate generations, so the volume grows slowly.

## Ports

Verified (code):

- The agent normally opens **no listening port**. It makes outbound HTTPS/WebSocket requests to `AGENT_URL`. The exception is an `http-01` ACME job, which temporarily binds `AGENT_ACME_HTTP_BIND` (default `0.0.0.0:80`) only while that job is active; port 80 must be publicly reachable on the issuer server for that challenge.
- sing-box inbounds listen on `::` at each node's configured `listenPort` (`app/src/orpc/proxy/singbox.ts`). Host networking means these are real host ports: allow them in the host firewall and any cloud security group. Which of TCP/UDP each protocol needs was not verified here.
- The agent injects a traffic-stats `api` service into the sing-box config, bound to `127.0.0.1` on a random free port with a random per-run secret. It is loopback-only and no longer uses the fixed port 8080 from the old `V2RAY_API_LISTEN` config. Requires sing-box >= 1.14 (official release binaries include the `api` service). Traffic is read as a stream of connection events, so a crash loses roughly one stream interval of in-memory deltas instead of everything since the last poll.
- The control plane listens on 3000 (the Docker image), and PostgreSQL on 5432 inside the Compose network only.

ACME DNS-01 uses `AGENT_ACME_DNS_SETTLE_SECONDS` (default 5, maximum 300) after
the control plane acknowledges a TXT record. ZeroSSL credentials are sent in the
job, not stored on the agent. The agent does not cache ACME account credentials
across jobs; each job creates an account with the configured provider.

## Upgrade and rollback

There are two independent upgrade paths:

- **Runtime image:** change the image tag and run `docker compose up -d`. The image supplies only the entrypoint and tools; the same `/data` volume supplies both binaries and state. Recreating the container is safe as long as `/data` is preserved.
- **agent and sing-box:** set the desired version on the server in the admin UI (or leave it blank and pin `AGENT_BOOTSTRAP_VERSION`/`AGENT_SING_BOX_BOOTSTRAP_VERSION` for first start only). The agent polls the directive, resolves the release through the GitHub API, verifies the SHA-256 digest, and installs atomically.

Sing-box upgrades are preflighted with `sing-box check` against the active config. The old process is stopped, the new binary must survive the normal runtime probation, and a failure restores `sing-box.prev` and the previous process. Agent self-updates replace `server-agent`, write a pending-update marker and exit with code `75`; the entrypoint restarts the new binary. If the new agent crashes three times within two minutes, the entrypoint restores `server-agent.prev`. Failed updates are retried after `AGENT_UPDATE_RETRY_SECONDS` (default 3600) unless the desired version changes.

The admin server list shows the running and desired versions plus the last update state. The heartbeat reports failures in `agentUpdateError`/`singBoxUpdateError`.

To roll back manually, set the desired version back to the previous exact version. If the agent cannot reach the control plane, stop the container, replace `/data/bin/sing-box` with `sing-box.prev` (or `/data/bin/server-agent` with `server-agent.prev`), and start it again.

**Unverified:** that state files written by a newer agent are readable by an older one. If you must roll back across a release that changed persisted formats, discard the volume and let the agent re-pull (accepting a short outage).

The agent handles both SIGINT and SIGTERM and shuts down its sing-box process before exiting; the entrypoint forwards the container stop signal to the agent. This is still covered by [local validation](local-validation.md#agent-shutdown-timing) rather than a hosted check.

Compatibility: only `config-v3` is served by the control plane, so agents older than that cannot sync. Upgrade such agents before (or together with) the control plane.

## Health of an agent

The runtime image has no `HEALTHCHECK`, and the Compose file defines none. The control plane records each server's last-seen time, applied revision and per-binary update state (`server.last_seen_at`, `applied_revision`, `agent_update_state`, `sing_box_update_state` in `app/src/db/proxy-schema.ts`). Remember that this proves the agent reaches the control plane with a valid token. It does not prove clients can connect: verify with a real client.
