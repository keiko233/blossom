# Installing and running the server agent

One `server-agent` runs per physical proxy server, separately from the control plane. It pulls that server's desired state, runs one sing-box process, reports its applied revision and traffic, and persists a last-known-good config. Developer-facing detail is in the [Server agent handbook](../development/server-agent.md).

## Contract with the control plane

Verified (code):

- Config endpoint: `GET <AGENT_URL>/agent/config/v3` (operation `getAgentConfigV3`). `AGENT_URL` **must include the `/api` prefix**, e.g. `https://blossom.example.com/api`, because spec paths are relative to it.
- Other endpoints: `POST /agent/heartbeat` and `POST /agent/traffic`. All three authenticate with `Authorization: Bearer <agent token>`, resolved to exactly one server by hash.
- The agent advertises capabilities `config-v3`, `managed-tls-v3`, `certificate-deployments-v1`, `atomic-config-rollback` in its heartbeat (`server-agent/src/main.rs`).
- Intervals come from the control plane per server (config poll 5–86400 s, heartbeat 5–300 s). `AGENT_INTERVAL` (default 60) is only the bootstrap value.
- A candidate config is checked with `sing-box check` before it replaces the active one; the previous good config is kept and used for rollback and for startup.

Older notes and agents may refer to `/agent/config/v2`. The control plane no longer serves it; v3 is the only config endpoint.

## Install

1. In the admin UI, create the server (or reset its token). The plaintext token (`agt_...`) is shown **once**; only a hash and a short prefix are stored.
2. On the proxy server, from a checkout of the `server-agent/` directory (or with a copy of its `docker-compose.yaml` and `.env.example`):

   ```bash
   cp .env.example .env
   chmod 600 .env
   # edit .env: AGENT_URL=https://blossom.example.com/api  AGENT_TOKEN=<token>
   docker compose up -d
   ```

   Verified (code): `server-agent/docker-compose.yaml` requires `AGENT_URL` and `AGENT_TOKEN` (`:?` guards), uses host networking, `NET_ADMIN` and `/dev/net/tun`, a named volume `agent-state` at `/var/lib/blossom-agent`, `restart: unless-stopped` and log rotation (10 MB × 3). By default it **builds** the image locally, which compiles sing-box and is slow; the file has a commented `image:` line for a prebuilt image.

3. Prefer a pinned prebuilt image over `latest`: `ghcr.io/keiko233/blossom/server-agent:sha-<commit>` or a semver tag (tags are listed in the root README).

### The generated Docker command embeds the secret

The admin UI's token dialog offers a ready-made `docker run` command that contains `-e AGENT_TOKEN=<token>` in plain text (`token-reveal-dialog.tsx`). Anyone who sees that command sees the credential for that server's config, which includes proxy user credentials. Do not paste it into chat, tickets, CI logs, screenshots or shared terminal recordings.

Recommended handling:

- Use the `.env` + Compose route above. The token then lives in a `0600` file instead of shell history and process listings. It is still visible to anyone who can run `docker inspect` on the container, so restrict Docker access on that host.
- The agent reads the token only from `AGENT_TOKEN` or `--token` (verified in `main.rs`); there is no `*_FILE` variant, so Docker/Compose file-based secrets cannot be consumed without a wrapper.
- If a command or token was exposed, reset the server's token in the admin UI and update the agent's `.env`. A reset replaces the stored hash, so the old token stops authenticating on its next request (code path inspected; not exercised).
- The generated command has no volume for the state directory; see below before using it for anything beyond a trial.

## State persistence

The agent's state directory defaults to `/var/lib/blossom-agent` (`AGENT_STATE_DIR`; the image sets it and declares it a `VOLUME`). Verified (code):

| Path under the state dir                      | Contents                                                          |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `active.json`, `candidate.json`, `last-known-good.json` | sing-box configs: running, being checked, and previous good |
| `state.json`                                  | applied revision, active node IDs, certificate deployment records |
| `certificates/<id>/generation-<n>/`           | `fullchain.pem` and `private-key.pem`, files `0600`, directories `0700` |

Implications:

- The generated `docker run` command mounts nothing, so Docker creates an **anonymous** volume. It survives `docker restart`, but if you remove and re-create the container (the normal upgrade flow) the new container gets a fresh empty volume and the old state is orphaned. Add `-v blossom-agent-state:/var/lib/blossom-agent` to that command, or use the Compose file's named volume. **Unverified:** anonymous-volume behaviour is general Docker semantics, not tested here.
- Losing the state volume is recoverable: the next successful pull re-fetches config and certificate artifacts from the control plane. What is lost is the ability to start the last-known-good config while the control plane is unreachable.
- The volume holds certificate **private keys** in plaintext files. Protect any backup of it like a key store. See [Backup and recovery](backup-restore.md#agent-state).
- The token is not stored in the state directory; keep it in your secret store.
- The agent never garbage-collects certificate generations, so the volume grows slowly.

## Ports

Verified (code):

- The agent itself opens **no listening port**. It makes outbound HTTPS requests to `AGENT_URL`.
- sing-box inbounds listen on `::` at each node's configured `listenPort` (`app/src/orpc/proxy/singbox.ts`). Host networking means these are real host ports: allow them in the host firewall and any cloud security group. Which of TCP/UDP each protocol needs was not verified here.
- The v2ray stats API listens on `127.0.0.1:8080` (`V2RAY_API_LISTEN`). It is loopback-only, but it does occupy loopback port 8080 on that host, so another local service using that port would conflict. **Unverified:** the failure mode of such a conflict.
- The control plane listens on 3000 (the Docker image), and PostgreSQL on 5432 inside the Compose network only.

## Upgrade and rollback

1. Note the currently running tag/digest and keep the `.env` (token) unchanged.
2. Change the image tag (or pull the new build) and run `docker compose up -d`. Compose recreates the container and reuses the named `agent-state` volume.
3. On start, the agent runs `sing-box check` on its last-known-good config, starts sing-box from it, then syncs with the control plane. If the new agent cannot start the stored config it reports the error in its heartbeat and keeps retrying (`SINGBOX_START_FAILED`/`LKG_CONFIG_INVALID` in `main.rs`).
4. Roll back by setting the previous tag and running `docker compose up -d` again, with the same volume.

**Unverified:** that state files written by a newer agent are readable by an older one. If you must roll back across a release that changed persisted formats, discard the volume and let the agent re-pull (accepting a short outage).

**Unverified:** `docker stop` sends SIGTERM, and `main.rs` installs a handler only for Ctrl-C (SIGINT); as container PID 1 the agent may therefore not shut down gracefully and Docker may kill it after the stop timeout. This was not tested. [Local validation](local-validation.md#agent-shutdown-timing) has a rehearsal.

Compatibility: only `config-v3` is served by the control plane, so agents older than that cannot sync. Upgrade such agents before (or together with) the control plane.

## Health of an agent

The agent image has no `HEALTHCHECK`, and the Compose file defines none. The control plane records each server's last-seen time and applied revision (`server.last_seen_at`, `applied_revision` in `app/src/db/proxy-schema.ts`); which of these the admin UI displays was not checked. Remember that this proves the agent reaches the control plane with a valid token. It does not prove clients can connect: verify with a real client.
