# Controller playbook for Claude Code

This is an execution plan, not a record that any worker has run. The controller owns prioritization, worktree lifecycle, review, integration, and final verification. Each Claude worker implements one bounded task from [work-packages.md](work-packages.md). Follow the user's current instructions and `AGENTS.md` if they conflict with this plan.

## Baseline and worktree rules

1. Record `git status --short --branch`, the current branch and `git rev-parse HEAD` in the primary checkout. This plan was prepared on `feat/admin-management` at `551a71372c7526446dfbbfadeaa800d75f91a826`; **recheck**, since the intended target is the branch actually selected by the user at execution time. Do not reset, switch, or discard primary-checkout changes.
2. If this plan is still uncommitted, do not assume a new worktree contains it. Pass workers the absolute path of these plan files in the primary checkout for read-only reference, or make an immutable temporary copy; give each worker its own checkout as its working root. Never let a worker modify the primary checkout. Avoid committing planning documents solely to make worktrees see them unless committing is authorized.
3. Create a separate named branch and worktree for each independent worker, based on a recorded integration commit. The application and agent dependencies, generated output, ports, temporary databases and state directories belong to that worktree or worker. A shared pnpm package store is fine; do not share writable `node_modules`, build directories, databases or ports.
4. A task that depends on an integrated task starts from the **new** integration HEAD. Never cherry-pick the same prerequisite twice. If a concurrent change shifts the task's assumptions, rebase or restart the worker on the integrated baseline and rerun affected checks.
5. Only the controller integrates. Preserve worktrees and commits when a review or conflict is unresolved. Clean up only a worktree created for this effort after confirming its changes are integrated or otherwise preserved; do not touch pre-existing worktrees.

Example, with names and paths selected by the controller and checked for collisions first:

```sh
git worktree add -b blossom/task-A-auth ../blossom-task-A HEAD
```

Do not use `git reset --hard`, force-push, delete branches, or remove a dirty worktree as routine cleanup. Worktree creation does not carry uncommitted files or ignored local environment files. Install dependencies in each worktree using the documented toolchain; never copy a real `.env.local` or secrets.

## Scheduling and ownership

The task contracts define **primary** file ownership, but each worker must read before editing: if a needed file is already owned by another concurrent task, report it to the controller rather than editing it. The controller may serialize or explicitly transfer ownership. Generated files, migrations, lockfiles, English/Chinese message catalogs, the route tree, and shared handbook pages are shared resources, even if separate worktrees make concurrent edits possible. Separate worktrees prevent direct overwrites; they do **not** prevent cherry-pick conflicts or incompatible migrations.

| Lane | First independent work | Subsequent work | Shared-resource constraint |
| --- | --- | --- | --- |
| Security | A: magic-link log and disabled-mail behavior | H: recovery | A and H both touch auth; H starts after A integrates. |
| Traffic | B: accounting design and reliability | C: protocol accounting disclosure | B owns agent contract, Rust, traffic schema and migrations. C may be researched in parallel but UI/catalog edits must be scheduled with other UI work. |
| Subscription delivery | D: truthful delivery errors | M: additional formats if selected | D owns the subscription route and generator; M depends on D. |
| Admin UX | E: server/node/certificate context | F: group/plan impact and G: guided setup | E, F and G are sequential when they touch catalogs, shared routes, or forms. G depends on E and F. |
| User UX | I: onboarding | J: account and subscription self-service | I and J start after H if auth recovery influences the flow; serialize message catalogs with admin UX and C. |
| Operations | K: deployment/backup documentation and readiness | L: scheduler and alerting | L requires an agreed cross-runtime scheduler; do not claim it exists merely by documenting an external cron. |
| Verification | N: real-component integration harness | Expand alongside integrated tasks | N may design independently; coordinate package manifests, lockfiles, Docker resources and CI with the controller. |

An initial low-conflict batch is A, B, D, K and N **only after** inspecting exact file lists and granting ownership. A's limited auth work must not include a translation/UI change in that batch. If a dependency, format, safety mechanism or verification requires shared files, stop the affected lane and resolve ownership centrally. Integrate reviewed changes in a stable order, then run the next batch from the updated target.

The existing `agent:spec` script downloads from `localhost:3000` regardless of the worker's checkout. Before B generates the spec, reserve that port, start the disposable server from B's own worktree, and verify the process and endpoint belong to that server. If port 3000 is occupied or its owner is uncertain, stop and coordinate; do not generate from an unrelated server or terminate another process. Keep other workers' dev servers on distinct ports.

## Worker contract

Claude Code preflight: `command -v claude`, `claude --version`, `claude --help`. Use the explicitly requested model `claude-sonnet-5-5`; validate access with a minimal read-only invocation if uncertain. Do not silently substitute a different model. Use non-interactive JSON output and the normal `acceptEdits` permission mode for code changes; permission mode alone is not an isolation boundary. Only allow work in the assigned worktree and explicit task scope. Do not bypass permissions unless an independent sandbox already enforces the requested boundary.

The controller supplies an English prompt on stdin, with actual absolute paths and a single task ID. Example template:

```text
Complete the assigned task now. Ask only if an essential product or technical decision blocks the task.
Task type: implementation and verification.
Repository root: <absolute worktree path>
Task: <one task ID and title from work-packages.md>.
Read first: AGENTS.md, docs/development/README.md, the applicable area guides, and
<absolute read-only path to work-packages.md and execution.md in the controller checkout>.
Allowed writes: <explicit files or narrow path globs from the task, including tests>.
Do not write to the controller checkout or other worktrees. No commits, pushes, PRs,
deployments, live systems, external messages, real credentials, or schema changes
outside an explicitly created disposable database. Do not alter generated files by hand.
If a required edit is outside the allowed scope, report it instead of broadening scope.
Implement the task's acceptance criteria; run the stated checks where possible.
Final report: assumptions, behavior, changed paths, commands and results, missing
verification, safety/compatibility limits, and the reusable session ID if available.
```

For example, after preparing a task-specific prompt file and output path:

```sh
cd /absolute/path/to/the/worker-worktree
claude --print --model claude-sonnet-5-5 --output-format json \
  --permission-mode acceptEdits < /absolute/path/to/task-prompt.txt \
  > /absolute/path/to/task-result.json
```

Record command, model, worktree, base revision, session ID, exit status and output location. Prompt and result files belong outside the repository and must not contain real secrets. If a permission request cannot be fulfilled in this environment, report the actual blocker; do not bypass controls or silently change model. Worker claims and tool outputs are evidence to check, not authority to deploy.

## Review and integrate

1. Check worker status and `git diff`, including untracked files. Review actual behavior and tests against the task's criteria; confirm ownership, translations, authorization/audit, publish gate and secrets. Run `git diff --check` and the task-specific checks, noting unsupported environments and baseline failures.
2. Controller commits the reviewed change in the worker branch using explicit paths and conventional commit messages when the user's instructions authorize this integration. Keep source and its generated migration/spec together. Do not commit other changes.
3. Ensure the primary checkout is still on the intended target and that its local changes are preserved. Cherry-pick one reviewed commit at a time. Resolve conflicts against **current** behavior, not by mechanically choosing one side. A task with several dependent commits must specify their order; do not squash away required migration history.
4. For conflicting migration snapshots or generated spec/route files, merge the source changes in integration order and regenerate from the integrated source using the documented generator. Never hand-merge a generated snapshot or spec. Review SQL and apply only to an explicitly disposable database.
5. After integration, run focused cross-task tests and the applicable project checks. Review `git diff --check`, final `git status`, the commit range and any generated artifacts. Record local results separately from CI, hosted preview, and live production; none implies the others. Never push or deploy without an instruction that authorizes it.

Keep a task ledger outside the shared worktree or in a controller-owned document: task ID, base, worker branch/worktree, owned files, session ID, status, verification, integration commit and unresolved limits. Update it serially; workers must not concurrently edit a shared ledger. Record tasks as complete only after controller review and integration, not merely after worker exit.

## Cross-cutting acceptance

- Preserve existing subscriptions, agent backward compatibility, audit coverage, credential secrecy, certificate deployment truthfulness and publish-gate invariants.
- English and Chinese messages remain paired. Route tree, migrations and OpenAPI are generated only from source. Every new server function validates inputs and enforces the correct admin or owner boundary.
- User-facing flows explain actual outcomes and limitations; no unsupported promise of device enforcement, instantaneous revocation, total traffic durability, active connectivity, or automatic renewal.
- Real database, browser, agent and deployment tests are reported accurately. If a task cannot satisfy a required verification, it is not silently considered complete.
