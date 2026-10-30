# Development handbook

Working notes for people and coding agents changing Blossom. [`AGENTS.md`](../../AGENTS.md) is the short entry point; these guides hold the detail. For setup, deployment and environment variables, start with the [root README](../../README.md).

For the proposed product improvements and their worker task contracts, see the [product improvement plan](../roadmap/README.md). It is a plan, not a description of current behavior.

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

- A comment in `app/src/query/config-change.ts` points to `docs/config-versioning.md`, which does not exist. The publish-gate rules are documented in the header comment of `app/src/lib/publish-gate.ts` and summarised in [Architecture](architecture.md#publish-gate).

## Maintaining these guides

- Change the guide in the same change as the rule it describes. Update `AGENTS.md` only if it restates that rule.
- Keep `CLAUDE.md` as a one-line import of `AGENTS.md`; avoid tool-specific exceptions unless a tool genuinely requires one.
- Prefer linking to code or config over copying it. Do not record secrets, tokens or real hostnames.
- Do not add a rule that the project does not already follow without saying it is **Recommended**.
