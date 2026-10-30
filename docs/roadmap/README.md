# Blossom product improvement plan

This plan turns the source investigation of 2026-10-30 into independently reviewable work. The goal is to give administrators a clear path from servers and nodes through certificates, groups, plans and user subscriptions; help users connect and manage their subscriptions; and make quota, deployment status and operational guarantees match what the interface says.

The investigation was based on source, not a live deployment or browser verification. Before each task, inspect the current code and branch state and adjust the scope if the facts have changed.

## Start here

- [Work packages and acceptance criteria](work-packages.md): scope, dependencies, file ownership, tests and completion criteria for Claude Code.
- [Parallel execution and integration](execution.md): worktrees, Sonnet 5.5, scheduling, review and cherry-picking.
- [Development handbook](../development/README.md): established project behavior and implementation rules. This roadmap is a proposal and does not replace `AGENTS.md` or the handbook.

## Product relationships

```text
server / agent --contains--> node --belongs to--> group --included in--> plan --assigned as--> user subscription
                               ^
                   certificates are used by nodes where needed and deployed to their servers
```

Preserve these entities and their many-to-many relationships. Reduce complexity through contextual actions, effective-access previews and truthful status. A setup wizard may reuse or create existing objects, but must not maintain a second authorization model or bypass audit, the publish gate or certificate deployment acknowledgement.

## Recommended priorities

1. **Trustworthy foundations:** stop logging sensitive sign-in links; disclose unenforced device limits and unmetered protocols; explain why a subscription has no usable nodes; improve traffic-report reliability.
2. **Everyday administration:** contextual navigation and creation, effective-node previews, change-impact summaries and deployment progress. Improve individual pages before adding an onboarding wizard.
3. **User self-service:** connection instructions, account recovery, and subscription-link and proxy-credential rotation with clear effects on existing clients.
4. **Operations:** scheduled certificate maintenance, alerts, backup and recovery, readiness, deployment guidance and real-component integration tests.
5. **Product decisions:** enforceable device limits, additional client formats, payment/orders, tickets and referrals. Define the product and technical contract before treating these as implementation commitments.

This is the business priority order. Use [execution.md](execution.md) for concrete dependencies, file ownership and safe parallelism.

## Findings and limits to recheck

- Plans store and display `deviceLimit`, but static inspection found no enforcement path. Do not present it as a working limit. [Plan model](../../app/src/db/plan-schema.ts), [user subscriptions](../../app/src/routes/(user)/dashboard/subscriptions/index.tsx).
- Source comments state that the present statistics mechanism cannot attribute Naive, SOCKS and HTTP traffic to individual users. Verify exact protocol/configuration behavior with the target sing-box version. [Compiler](../../app/src/orpc/proxy/singbox.ts)
- The agent keeps pending traffic reports in memory. A lost response or partially completed update can lead to a replay, and the existing request lacks a report ID for deduplication. `api-data-auth.md` and source comments claim retries cannot double-count quota, but the current history insert followed by sequential counter updates does not establish that guarantee. Reproduce the failure and correct the guide with the fix. [Agent](../../server-agent/src/traffic.rs), [server write](../../app/src/query/agent.ts), [current guide](../development/api-data-auth.md#agent-api-orpc)
- The subscription endpoint currently emits Clash Meta YAML and describes all no-usable-proxy errors as deployment in progress. [Endpoint](../../app/src/routes/api/sub/$token.ts), [generator](../../app/src/lib/clash-config.ts)
- Agent rollback, the publish gate, certificate acknowledgements, audit, redeem codes and trials already exist; new flows must preserve their semantics. [Architecture](../development/architecture.md), [agent](../development/server-agent.md)
- Certificate renewal currently advances through agent polls or an admin reconciliation; independent scheduling needs a deployment-specific design. [certificate-agent.ts](../../app/src/query/certificate-agent.ts)

## Scope and risks

This is not a production deployment plan. Runtime verification must use an explicitly created disposable database, temporary agent state and isolated ports. Do not connect to or modify existing environments. Keep real tokens, email links, subscription URLs and keys out of documentation, tests, logs and commits.

Without persistent source counters or equivalent support, traffic accounting cannot promise unconditional zero loss between sing-box resetting a counter and the agent durably recording it. Prove the actual guarantee, document any residual window and use fault injection; do not hide that boundary behind an "exactly once" claim.
