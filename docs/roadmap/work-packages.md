# Implementation work packages

This document gives the controller bounded tasks for Claude Code. A task is not permission to start it: select it according to the user's current request and [execution.md](execution.md). Paths are starting points and ownership boundaries; the controller must enumerate exact paths or narrow globs in each worker prompt before starting it. All workers read `AGENTS.md` and the relevant development guides. Each task includes its own tests, localization, and documentation where applicable; do not omit shared files merely to avoid a conflict.

Status at preparation: **all tasks proposed, none implemented by this plan**. Re-evaluate assumptions against the integration HEAD. References to a missing feature mean the 2026-10-30 static investigation found no implementation; they are not a production incident report.

## A — Safe magic-link failure

**Goal:** prevent logging of sign-in links and make a missing email provider fail honestly. Independent of B, D, K and N. H depends on A.

**Starting scope:** `app/src/lib/auth.tsx`, `app/src/lib/email.ts`, narrowly scoped auth tests. No user interface or shared message catalog in the initial parallel batch; if localized UI is necessary, defer it to H or obtain exclusive ownership.

**Acceptance:**

- No provider-missing or mail-failure path logs a magic-link URL, bearer value or complete callback payload. Use fake values in tests.
- Email-disabled registration/login cannot claim an email was sent. Preserve existing registration-policy and trial behavior and avoid account enumeration beyond existing behavior.
- Test the configured and unconfigured branches, including log redaction. Explain how failure reaches callers and whether a UI change is deferred.

**Checks:** related auth tests and `pnpm test`; type check for nontrivial TS changes. No real emails or external accounts.

## B — Reliable traffic report ingestion

**Goal:** eliminate replay-induced over-counting after acknowledged reports and make buffered traffic recoverable across agent restart where feasible. This is a design-and-implementation task; serialize all database migrations, `server-agent/openapi/spec.json`, agent API and shared handbook updates with other tasks.

**Starting scope:** `server-agent/src/{traffic,stats,main,config}.rs` as needed; `app/src/orpc/proxy/{agent,schema}*.ts`, `app/src/query/agent.ts`, `app/src/db/traffic-schema.ts`, generated migration and agent spec, affected tests, and `docs/development/api-data-auth.md`. Controller must expand exact scope if design requires new files. Do not touch UI/catalogs.

**Required design before coding:** document report ID ownership and lifetime, durable queue/ack semantics, crash recovery, multi-batch handling, unique server identity, retention and storage limits, request replay, and old/new control-plane/agent compatibility. Ensure duplicate report IDs with different contents are rejected. Design atomic insertion, history and counters on **both** supported drivers: `neon-http` has no interactive transaction, so prove an atomic SQL statement or another supported atomic mechanism rather than assuming ordinary sequential writes are safe. Keep a compatibility path for old agents without claiming replay safety for them.

**Acceptance:**

- Reproduce lost response and partial failure with multiple subscriptions; identical retry is applied at most once to both history and quota, including concurrent duplicates.
- Pending batches survive agent restart after durable enqueue and are retried without ID changes. Bound behavior when storage is unavailable/full and report it without losing or logging credentials.
- Address the gap between `QueryStats(reset=true)` and durable enqueue: investigate whether a non-reset cumulative strategy, persisted baselines, or another supported sing-box mechanism is viable. If no strategy can guarantee zero loss across sing-box/agent crashes, state the actual residual window and do not claim exactly-once end-to-end accounting.
- Keep reporting and attribution working for current/legacy supported agents and node moves; test control-plane upgrade and rollback compatibility. Existing expired/unknown-subscription behavior must be explicit.
- Regenerate schema migration and agent OpenAPI via the documented tools; update the misleading current claim that history-first sequential writes cannot double-count. Review migration compatibility and any retained report data policy.

**Checks:** targeted Rust and app tests, fault-injection tests for crash/retry/replay/concurrency and two independent subscriptions, disposable PostgreSQL integration for atomicity and migration; validate Neon HTTP semantics in a safe disposable environment if available or explicitly mark it unverified. Run `pnpm test`, `cargo test --locked`, formatting and clippy. Regenerate the spec with a disposable app environment, then rebuild the agent. No production database.

## C — Honest device and protocol accounting capabilities

**Goal:** stop presenting unimplemented device enforcement or unsupported per-user accounting as guaranteed. Start from integrated UI/catalog HEAD; coordinate with E/F/I. Depends on B only for describing B's final behavior, not for initial investigation.

**Starting scope:** plan/subscription UI, node protocol form and relevant capability helpers under `app/src/lib/`, `app/messages/{en,zh-cn}.json`, relevant tests. Do not change existing quotas or create a device identity system.

**Acceptance:**

- Make it clear that stored device limits are not currently enforced. Preserve saved values and existing API compatibility; avoid silently replacing them with unlimited values.
- Warn administrators when selected protocols/configurations cannot provide per-user accounting with the current agent, and distinguish unsupported from unknown. Cite or test the capability mapping against actual compiler/agent behavior; do not infer coverage solely from protocol names if configuration changes it.
- Surface the impact where an admin selects nodes/plans and wherever a user might otherwise assume a hard device guarantee. Explain polling-based quota enforcement and disconnected-agent caveat without exposing internal secrets.
- Both locales match. Test capability mapping and no regression of entitlement logic.

**Checks:** targeted logic tests, `pnpm test`, app build, type check; visually check common and empty states using disposable data when possible.

## D — Explain subscription delivery failures

**Goal:** distinguish no entitlement, no distributable/compatible node, pending deployment and genuine generation errors without leaking credentials. Independent of A, B and K; coordinate with E/F before touching shared catalogs.

**Starting scope:** `app/src/routes/api/sub/$token.ts`, `app/src/lib/clash-config.ts`, `app/src/lib/clash-proxies.ts`, `app/src/query/subscription-access.ts` as required, corresponding tests. Add admin diagnostics/UI only with separately assigned ownership.

**Acceptance:**

- Return typed internal reasons, keeping existing auth and publish gate behavior. Do not report permanent lack of nodes or unsupported configurations as temporary agent deployment.
- Keep protocol response behavior compatible with supported clients; choose and document status codes and retry headers. External error responses must not expose sensitive details or become an account-enumeration surface.
- Preserve partial success when some nodes are convertible; expose skipped-node reasons to an authenticated admin diagnostic path or a clearly specified follow-up, without leaking secrets.
- Tests cover no nodes, unsupported-only, pending gate, partially supported nodes, true builder failure and normal output.

**Checks:** focused generator, gate and endpoint tests; `pnpm test` and app type check. Do not fetch real subscription URLs.

## E — Server, node and certificate context

**Goal:** reduce navigation and explain deployment without changing the data model. Serialize with C/F/G and catalog changes.

**Starting scope:** admin server, node and certificate route modules, relevant queries, related tests, `app/messages/{en,zh-cn}.json`. Do not alter the certificate lifecycle or agent API.

**Acceptance:**

- From a server, navigate to its nodes and create a node with that server preselected; never silently override an explicit selection. Handle a removed or inaccessible preselected server.
- Explain and link certificate usage and deployment from node/certificate context. Selecting an existing usable certificate retains current bind-and-deploy semantics; Reality and non-TLS configurations are handled honestly.
- If offering create-certificate during node editing, retain unsaved values across navigation, avoid leaking secrets and return with the selected result. It is acceptable to ship a smaller link-first step if a reliable return flow needs a separate task.
- Explain pending/applied/error using existing truthful agent and certificate states; online heartbeat does not prove a real client connection. Preserve one-time agent token display.

**Checks:** form/controller tests where meaningful, `pnpm test`, app build and type check; manually verify create/edit, no servers, invalid context and failed deployment with disposable data.

## F — Groups, plans and subscription impact

**Goal:** make effective access and change impact visible while keeping groups as the source of membership. Start after E; coordinate with C/I/J and shared catalogs.

**Starting scope:** admin group/plan/subscription/user form and list modules, focused read-only queries, `app/messages/{en,zh-cn}.json`, tests. Do not silently update existing subscriptions or change authorization.

**Acceptance:**

- Add empty-state next actions and contextual links for missing nodes/groups; support searching/selecting existing resources.
- Preview unique nodes resulting from selected groups, their server, protocol, enabled/deployment state, and relevant warnings from C when available. Do not imply a filtered or pending node is currently usable.
- Before relevant edits/deletes, display affected relationships and current server-side constraints, including subscription counts. The server remains authoritative under concurrent changes.
- Clarify plan snapshot behavior: quota/device values of existing subscriptions do not silently change when plan fields change; group membership can change effective access. Subscription lists link to their user and plan.
- Verify publish-gate behavior remains unchanged; no separate entitlement table or implicit bulk resnapshot.

**Checks:** focused relationship/preview tests, gate tests if mutation behavior changes, `pnpm test`, build and type check; visually inspect empty and populated cases.

## G — Optional guided setup

**Goal:** offer a resumable, understandable first setup using existing resources or creating them. Start only after E and F are integrated and the controller judges their improved navigation insufficient on its own.

**Starting scope:** a new admin workflow route and narrow modules, existing form entry points and server functions only where necessary, route tree generated by the build, paired message catalogs and focused tests. No new parallel authorization model.

**Acceptance:**

- Steps: choose/create server and retain its one-time token; choose/create node, handle certificate only when needed; choose/create group and plan; optionally assign a user subscription. Existing resources can be reused.
- Each completed step is committed through the existing validation, admin checks, audit and publish gate. A later failure leaves prior objects visible with resume/retry guidance; do not pretend the whole multi-step operation is atomic.
- Final screen differentiates saved, awaiting agent, applied and actually client-verified. Do not label a node reachable merely because it has a heartbeat. Preserve intermediate form state without persisting secrets to insecure browser storage.
- Explicitly test repeated submission, partial completion, cancel/resume, and a failed agent apply. Keep normal entity pages available.

**Checks:** focused tests, `pnpm test`, build, type check and browser walkthrough with a disposable app, database and mock or isolated agent. Document whether a real client connection was tested.

## H — Password recovery and account email behavior

**Goal:** replace the existing forgot-password placeholder with a working, secure recovery journey. Depends on A; serialize auth and message catalogs with I/J.

**Starting scope:** auth config, `(auth)/auth/forgot.tsx`, any necessary reset route and email template, relevant auth tests and paired messages, generated route tree if applicable.

**Acceptance:**

- Recovery requests and reset complete through the configured auth library, with expiring single-use tokens, consistent public responses for known/unknown accounts, and no secrets in logs.
- Explain unavailable email configuration and delivery failure without falsely claiming success; handle expired/invalid tokens and password validation. Preserve magic-link/social-only users and existing sessions according to an explicit tested policy.
- Add meaningful tests for request, reset, replay/expiry, provider-disabled and enumeration behavior. Use fake email adapter; no external mail.

**Checks:** focused auth tests, `pnpm test`, build/route generation and type check; browser walkthrough against a disposable database if available.

## I — User onboarding

**Goal:** take a user from an active subscription to client import. Serialize catalogs with C/E/F/H/J. Do not add a new subscription format in this task.

**Starting scope:** `(user)/welcome`, `(user)/dashboard/subscriptions`, small user-facing components, paired messages and focused tests.

**Acceptance:**

- Present access state, copyable subscription URL, supported platforms/client setup and clear remediation for pending, expired, exhausted or no usable nodes. Link to authoritative client download pages selected by the controller; only claim verified compatibility.
- Add QR or deep link only if it can be generated locally without exposing bearer URLs to a third party and the actual client scheme is verified. Never send subscription URLs to analytics or logs.
- Keep existing redeem flow and accessibility; work on mobile and both locales.

**Checks:** relevant tests, `pnpm test`, build/type check; browser walkthrough using fake or disposable subscriptions, with actual client import reported separately.

## J — Account and subscription self-service

**Goal:** let the signed-in owner manage basic account/session security and recover a leaked subscription link or proxy credentials. Depends on A/H and coordinates with I.

**Starting scope:** user routes and components, narrowly scoped user-facing query functions, shared credential helpers, audit/test exemptions where applicable, paired messages and generated route tree. Do not expose raw credentials beyond existing subscription output.

**Acceptance:**

- Owner-only token rotation and credential rotation share underlying semantics with existing admin operations; tests reject cross-user IDs. Explain that URL rotation invalidates the old URL immediately but does not revoke already obtained proxy credentials, while credential rotation must propagate to agents and uses the existing publish gate.
- Include a clear account/session management flow where supported by existing better-auth behavior, with current-session handling and explicit confirmation for disruptive actions. No admin impersonation/role escalation.
- Audit or deliberately exempt user-facing POST functions according to the structural audit test. Cover ownership, concurrent rotation, agent-pending and existing-session cases.

**Checks:** auth/ownership and gate tests, `pnpm test`, build/type check; run browser and real-agent checks only against disposable infrastructure and report scope.

## K — Deployment, recovery and readiness

**Goal:** make self-hosting and recovery repeatable and distinguish liveness from readiness. Independent of A/B/D if its file ownership is kept separate from N/L.

**Starting scope:** `README.md`, deployment-specific documentation, `app/src/routes/api/health.ts` or a new readiness route if justified, corresponding tests and route tree if created. Do not touch production resources.

**Acceptance:**

- Document first admin provisioning based on a verified existing mechanism; if none exists, identify it as a gap and propose a separately scoped bootstrap design rather than inventing a command.
- Cover separate agent install, state persistence, ports, upgrade/rollback, one-time token handling, certificate variables, `/api/agent/config/v3`, and recovery. Explain that the generated Docker command embeds a secret and must not be pasted into shared logs; recommend an appropriate secret-handling approach.
- Document PostgreSQL backup and restore with independently protected auth/certificate master keys, restore verification and agent state needs. Use examples with placeholders, no actual credentials.
- Keep liveness cheap. If adding database readiness, bound timeouts and information disclosure and verify that readiness failures do not cause destructive restart loops; do not call agent heartbeat or TCP reachability a client connectivity test.

**Checks:** local Markdown links and command review; relevant tests/build if code changes; optionally rehearse backup/restore on a newly created disposable database and report whether done.

## L — Certificate scheduling and notifications

**Goal:** provide a dependable, observable certificate maintenance trigger and actionable operator alerts across supported deployment models. Depends on a chosen scheduler/delivery contract and on K; serialize migrations, settings, catalogs and deployment config with other tasks.

**Design gate:** compare Node/Compose and serverless scheduling, authentication for any external trigger, lease/concurrency, repeated execution, execution duration, network/provider failures and platform limits. State which platforms are actually supported and what operators configure; a background timer alone does not work reliably on serverless. Select notification transport and identify secrets before implementation.

**Acceptance:**

- Issuance/renewal can progress without a live agent poll, with existing leases and manual DNS challenge flow preserved. No unsafe unauthenticated public trigger.
- Alert on certificate expiry/failure, agent offline and persistent apply failure with deduplication, recovery notifications, clear timestamps and bounded retries. No secrets or subscription URLs in alerts. If external delivery is not configured, status is visible and setup is explicit.
- Tests cover repeated/concurrent trigger, paused/failed DNS validation, expiry thresholds, notification retries and provider failure. Document operational guarantees separately for each platform.

**Checks:** focused tests, `pnpm test`, target-specific builds, disposable scheduler integration; hosted platform and real notification delivery only if explicitly authorized and available.

## M — Additional client formats (product decision)

**Goal:** support a deliberately selected client format. Depends on D. No implementation until supported clients, formats, protocol matrix, routing/DNS defaults and version policy are selected.

**Acceptance:** separate formatter and explicit selection, reused authorization/publish gate, no user-agent-only ambiguity, compatibility matrix and tests for all offered protocols. Verify with real supported client parsers; document unsupported nodes rather than silently dropping them. Preserve Clash output compatibility and bearer-token privacy.

## N — Real-component verification harness

**Goal:** create a repeatable local end-to-end path that tests the app against disposable PostgreSQL and a real agent/sing-box where available. Design may start in parallel; own CI, Docker, manifests and test scaffolding exclusively when editing.

**Acceptance:** from empty migrated database, provision a test admin/user/server/node/group/plan/subscription using supported flows; wait for agent apply, fetch the subscription, verify authenticated proxy traffic and reporting, expiry or revoke behavior, plus one invalid config/rollback case. Include isolated secrets, ports, temporary state and cleanup even on failure. Avoid relying solely on mock control plane or heartbeat as proof of connectivity. If a platform cannot run a full test, provide runnable partial checks and explicitly mark the gap.

**Checks:** execute the harness where local Docker/sing-box/PostgreSQL are available; document exact prerequisites and results. Do not require real accounts, existing databases or hosted services.

## Out of scope until selected

- Actual multi-device enforcement: choose device identity, trusted client behavior, privacy, limits and disconnected-agent policy first. A subscription fetch count or IP count is not a reliable device identity.
- Payment, order, refunds, billing and tickets: define intended business model, provider, currency, callback verification, idempotency, reconciliation and customer support policy first. Do not treat plan `priceCents` as an existing checkout.
- Periodic quota resets, notifications to end users, public APIs, RBAC, migration from other panels, and full rule/profile editors are separate proposals. Add task contracts only after their requirements are decided.
