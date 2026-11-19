# Development handbook

Working notes and engineering standards for human contributors and coding agents changing Blossom. [`AGENTS.md`](../../AGENTS.md) is the short entry point; these guides hold the detailed rules. For setup, deployment, and environment variables, start with the [root README](../../README.md).

Forward-looking proposals and phased execution plans live under [docs/spec/](../spec/) and the [product improvement plan](../roadmap/README.md). They are plans, not descriptions of current repository behavior, and do not replace `AGENTS.md` or these guides.

## Choose a guide

| When you are working on                                                           | Read                                                     |
| --------------------------------------------------------------------------------- | -------------------------------------------------------- |
| How the pieces fit: surfaces, runtimes, deploy targets, publish gate              | [Architecture](architecture.md)                          |
| TypeScript & React style: grouping, `data-slot`, `cva()`, modals, module scope    | [TypeScript and React style](typescript.md)              |
| App structure in `app/`: routes, forms, queries, i18n, formatting                 | [App conventions](app.md)                                |
| Server functions, the agent oRPC API, MCP, Drizzle schema, migrations, env, auth  | [API, data and auth](api-data-auth.md)                   |
| Rust style for `server-agent/`: visibility, ports, errors, async, tests           | [Rust code guide](rust.md)                               |
| `server-agent/` architecture, OpenAPI client, sing-box supervision, updates       | [Server agent](server-agent.md)                          |
| Generated files and how to regenerate them                                        | [Generated files](generated-files.md)                    |
| Which tests and checks to run                                                     | [Testing and verification](testing.md)                   |
| Agent WebSocket v2: negotiation, handshake, snapshots, status, traffic            | [Agent WebSocket v2](agent-ws-v2.md)                     |
| Commands, CI, workflows, worktrees, git hooks, commits                            | [Workflow](workflow.md)                                  |

## How to read these guides

The guides separate two kinds of statement so current facts are never confused with aspirational rules:

- **Established** — what the code, configuration, or CI does today. These are stated plainly and were checked against the source. Follow them; if the code disagrees, the code wins and the guide needs fixing.
- **Recommended** — forward-looking standards and defaults for new or refactored code that the repository does not uniformly enforce yet. These are marked **Recommended**; follow them for new code and do not rewrite unrelated legacy code solely to match them.

Where a guide says "not verified", the statement comes from reading configuration rather than executing the tool.

## Known drift

Things in the repository that disagree with each other. Do not copy the stale side.

- A comment in `app/src/query/config-change.ts` points to `docs/config-versioning.md`, which does not exist. The publish-gate rules are documented in the header comment of `app/src/lib/publish-gate.ts` and summarised in [Architecture](architecture.md#publish-gate).

## Maintaining these guides

- Change the guide in the same change as the rule it describes. Update `AGENTS.md` only if it restates that rule.
- Keep `CLAUDE.md` as a one-line import of `AGENTS.md`; avoid tool-specific exceptions unless a tool genuinely requires one.
- Prefer linking to code or config over copying it. Do not record secrets, tokens, or real hostnames.
- Never present a proposed rule as **Established** before code, tooling, or CI enforces it; mark it **Recommended**.
