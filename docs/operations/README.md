# Operations guide

Runbooks for people who host Blossom: deploying the control plane, installing agents on proxy servers, backing up and restoring, and judging whether a deployment is healthy. For development rules see the [development handbook](../development/README.md); for build commands and deploy targets see the [root README](../../README.md#deployment).

| Topic                                                                                   | Guide                                    |
| --------------------------------------------------------------------------------------- | ---------------------------------------- |
| Compose deployment, secrets, certificate variables, first admin, liveness vs readiness   | [Self-hosting](self-hosting.md)          |
| Installing and upgrading `server-agent` on a proxy server, ports, state, tokens          | [Server agent](server-agent.md)          |
| PostgreSQL backup and restore, master keys, agent state, restore verification            | [Backup and recovery](backup-restore.md) |
| Concrete disposable-environment steps to validate everything above                       | [Local validation](local-validation.md)  |

## How to read these guides

Each statement is one of:

- **Verified (code)** — read from the source or configuration at the commit these guides were written against. Paths are given so you can recheck.
- **Rehearsed** — actually executed against a disposable container with fake credentials. Each rehearsal says exactly what ran.
- **Unverified** — inferred, taken from general Docker/PostgreSQL behaviour, or depends on a platform that was not available. These are marked **Unverified** and listed again in [Local validation](local-validation.md#open-verification-gaps).

All values in these guides are placeholders (`<...>`, `example.com`, `agt_replace_me`). Never paste real tokens, keys or connection strings into tickets, chat or shared logs.

## Scope

These guides cover the Docker Compose / Node self-hosting path in detail, because it is the only path with committed deployment files for both the app and the agent. Cloudflare, Netlify and Vercel build instructions stay in the root README; their runtime behaviour (scheduling, backups, health checks) is not covered here and was not verified.
