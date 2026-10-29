# Development handbook

Working notes for people and coding agents changing Blossom. [`AGENTS.md`](../../AGENTS.md) is the short entry point; these guides hold the detail. For setup, deployment and environment variables, start with the [root README](../../README.md).

## Choose a guide

| When you are working on                                                           | Read                                    |
| --------------------------------------------------------------------------------- | --------------------------------------- |
| How the pieces fit: surfaces, runtimes, deploy targets, publish gate              | [Architecture](architecture.md)         |
| React/TypeScript in `app/`: routes, UI, forms, i18n, formatting                   | [App conventions](app.md)               |
| Server functions, the agent oRPC API, MCP, Drizzle schema, migrations, env, auth  | [API, data and auth](api-data-auth.md)  |
| The Rust `server-agent/`                                                          | [Server agent](server-agent.md)         |
| Generated files and how to regenerate them                                        | [Generated files](generated-files.md)   |
| Which tests and checks to run                                                     | [Testing and verification](testing.md)  |
| Commands, CI, git hooks, commits                                                  | [Workflow](workflow.md)                 |

## How to read these guides

The guides separate two kinds of statement, because only one of them is a fact about the repository:

- **Established** — what the code, configuration or CI does today. These are stated plainly and were checked against the source. Follow them; if the code disagrees, the code wins and the guide needs fixing.
- **Recommended** — forward-looking advice that the repository does not enforce or consistently follow yet. These are marked **Recommended**. They are defaults for new code, not requirements, and nobody should rewrite existing code to satisfy them.

Where a guide says "not verified" it means the statement comes from reading configuration rather than running the tool.

## Known drift

Things in the repository that disagree with each other. Do not copy the stale side.

- The README says new agents pull `/api/agent/config/v2`. The router, the committed OpenAPI spec and the Rust client all use `/api/agent/config/v3` (`getAgentConfigV3`), and the agent advertises the capability `config-v3`. Treat v3 as current.
- The README's environment table omits `CERTIFICATE_MASTER_KEY`, `ACME_EAB_KID`, `ACME_EAB_HMAC_KEY`, `CLOUDFLARE_DNS_API_TOKEN` and `CLOUDFLARE_DNS_ZONE_ID`. They are in `app/src/lib/env-schema.ts` and `app/.env.example`; certificate management needs `CERTIFICATE_MASTER_KEY`.
- A comment in `app/src/query/config-change.ts` points to `docs/config-versioning.md`, which does not exist. The publish-gate rules are documented in the header comment of `app/src/lib/publish-gate.ts` and summarised in [Architecture](architecture.md#publish-gate).
- `.github/workflows/test.yml` puts `paths:` filters on its jobs. GitHub Actions path filters belong under `on.<event>`, so these keys likely do not filter anything (and may be rejected by the workflow validator). Not verified here; check the Actions tab before relying on path-based skipping.

## Maintaining these guides

- Change the guide in the same change as the rule it describes. Update `AGENTS.md` only if it restates that rule.
- Keep `CLAUDE.md` as a one-line import of `AGENTS.md`; avoid tool-specific exceptions unless a tool genuinely requires one.
- Prefer linking to code or config over copying it. Do not record secrets, tokens or real hostnames.
- Do not add a rule that the project does not already follow without saying it is **Recommended**.
