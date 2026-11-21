#!/usr/bin/env node
// Two-agent managed-networking canary (task 10): preflight, disposable
// PostgreSQL/app/agents/origins, supported admin provisioning, evidence capture
// and judges. It never deploys, never uses a real host's services, never flips
// the activation gate in source, and exits non-zero when any required evidence
// is missing.
//
//   node scripts/blossom-canary.mjs [--check] [--keep] [--reuse-build]
//        [--sing-box <path>] [--agent-bin <path>] [--postgres-image <image>]
//        [--systemd-vm <name>] [--apply-fn <file>#<export>]
//        [--abort-fn <file>#<export>] [--retry-fn <file>#<export>]
//        [--drain-fn <file>#<export>] [--recovery-kind failure|abort]
//
// Exit codes: 2 a core prerequisite is missing or the live setup failed before
// evidence capture; 1 any judge failed or cleanup left something behind; 3
// evidence is incomplete (blocked or not run). 0 means every evidence item
// passed. See tests/integration/blossom/README.md#two-agent-canary and
// docs/spec/2026-11-20-admin-networking-workspace/task-10-canary-handoff.md.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CanaryHarness } from "../tests/integration/blossom/lib/canary-environment.mjs";
import { CanaryEvidenceJournal } from "../tests/integration/blossom/lib/canary-evidence.mjs";
import {
  CanaryScenarioError,
  createCanarySubscriber,
  createServerFunctionDriver,
  discoverApplyServerFns,
  provisionCanary,
  recordMissingPrerequisites,
  runDowngradeGate,
  runExportOnlyA,
  runFailureRecovery,
  runIsolatedRelay,
  runLiveRevocation,
  runNoDoubleBilling,
  runReceiverFirst,
  startCanaryAgents,
} from "../tests/integration/blossom/lib/canary-scenarios.mjs";
import {
  CANARY_EVIDENCE,
  CANARY_PREREQUISITES,
  canaryPreflight,
  parseServerFnSpec,
  planEvidence,
} from "../tests/integration/blossom/lib/canary.mjs";
import { redact } from "../tests/integration/blossom/lib/util.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const USAGE =
  "usage: node scripts/blossom-canary.mjs [--check] [--keep] [--reuse-build] [--sing-box <path>] [--agent-bin <path>] [--postgres-image <image>] [--systemd-vm <name>] [--apply-fn <file>#<export>] [--abort-fn <file>#<export>] [--retry-fn <file>#<export>] [--drain-fn <file>#<export>] [--recovery-kind failure|abort]";

function parseArgs(argv) {
  const options = {
    check: false,
    keep: false,
    reuseBuild: false,
    singBox: undefined,
    agentBin: undefined,
    postgresImage:
      process.env.BLOSSOM_IT_POSTGRES_IMAGE ?? "postgres:19-alpine",
    systemdVm: undefined,
    applyFn: undefined,
    abortFn: undefined,
    retryFn: undefined,
    drainFn: undefined,
    recoveryKind: "failure",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--check") options.check = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--reuse-build") options.reuseBuild = true;
    else if (arg === "--sing-box") options.singBox = path.resolve(value());
    else if (arg === "--agent-bin") options.agentBin = path.resolve(value());
    else if (arg === "--postgres-image") options.postgresImage = value();
    else if (arg === "--systemd-vm") options.systemdVm = value();
    else if (arg === "--apply-fn") options.applyFn = parseServerFnSpec(value());
    else if (arg === "--abort-fn") options.abortFn = parseServerFnSpec(value());
    else if (arg === "--retry-fn") options.retryFn = parseServerFnSpec(value());
    else if (arg === "--drain-fn") options.drainFn = parseServerFnSpec(value());
    else if (arg === "--recovery-kind") {
      const kind = value();
      if (!["failure", "abort"].includes(kind)) {
        throw new Error("--recovery-kind must be failure or abort");
      }
      options.recoveryKind = kind;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function applyFnLabel(fn) {
  return fn ? `${fn[0]}#${fn[1]}` : undefined;
}

function printPlan(plan) {
  console.log("evidence plan:");
  for (const item of plan) {
    const state =
      item.blockedBy.length === 0
        ? "ready"
        : `blocked by ${item.blockedBy.join(", ")}`;
    console.log(`  - ${item.id}: ${state}`);
    console.log(`      ${item.title}`);
    console.log(
      `      observe: ${CANARY_EVIDENCE.find((e) => e.id === item.id).observe}`,
    );
  }
}

const options = parseArgs(process.argv.slice(2));
const harness = new CanaryHarness({
  repoRoot,
  options: {
    ...options,
    applyFn: undefined,
  },
});
const base = await harness.preflight();
const canary = canaryPreflight(
  {
    repoRoot,
    singBox: harness.singBox,
    dockerReachable: Boolean(base.facts.docker),
    systemdVm: options.systemdVm,
    applyFn: applyFnLabel(options.applyFn),
  },
  { readText: (file) => readFileSync(file, "utf8") },
);
const missing = [
  ...base.problems.map((detail) => ({ id: "base-harness", detail })),
  ...canary.missing,
];

console.log("facts:");
for (const [key, value] of Object.entries({ ...base.facts, ...canary.facts })) {
  console.log(`  ${key}: ${value}`);
}
console.log(
  missing.length === 0
    ? "missing prerequisites: none"
    : "missing prerequisites:",
);
for (const { id, detail } of missing) {
  console.log(`  - [${CANARY_PREREQUISITES[id].scope}] ${id}: ${detail}`);
}
printPlan(planEvidence(missing));

const coreMissing = missing.some(
  ({ id }) => CANARY_PREREQUISITES[id].scope === "core",
);
if (coreMissing) {
  console.log(
    "\ncanary not runnable: core prerequisites are missing (nothing was started)",
  );
  process.exit(2);
}
if (options.check) {
  console.log("\npreflight passed (--check: nothing started)");
  process.exit(0);
}

let applyFn = options.applyFn;
if (!applyFn && canary.facts.applyIngress === "admin server function") {
  const discovered = discoverApplyServerFns(repoRoot);
  if (discovered.length === 1) {
    applyFn = discovered[0];
    console.log(`discovered Apply server function ${applyFn[0]}#${applyFn[1]}`);
  } else if (discovered.length > 1) {
    throw new Error(
      `Apply integration exposes several candidates (${discovered
        .map((fn) => `${fn[0]}#${fn[1]}`)
        .join(", ")}); pass --apply-fn`,
    );
  }
}

let tearingDown = false;
let journal;
let setupFailed = false;
let provisioned = false;
let scenariosStarted = false;

async function teardown() {
  if (tearingDown) return;
  tearingDown = true;
  await harness.stop();
  if (journal) journal.write();
  const leftovers = harness.leftovers();
  if (leftovers.length > 0) {
    console.log(`WARN  cleanup left behind: ${leftovers.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log(
      "cleanup complete: container, processes, temp directory and lock removed",
    );
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`received ${signal}, cleaning up`);
    teardown().finally(() => process.exit(130));
  });
}

async function recordScenarioError(id, error) {
  if (error instanceof CanaryScenarioError && error.blockedBy.length > 0) {
    journal?.block(id, error.blockedBy, error.message);
  } else {
    journal?.fail(id, error.stack ?? String(error));
  }
}

async function step(id, fn) {
  try {
    return await fn();
  } catch (error) {
    await recordScenarioError(id, error);
    throw error;
  }
}

try {
  console.log("\nstarting the disposable canary environment");
  await harness.start();
  journal = new CanaryEvidenceJournal({
    runId: harness.runId,
    workdir: harness.workdir,
    repoRoot,
    secrets: harness.secrets,
  });
  journal.prerequisites({
    facts: { ...base.facts, ...canary.facts },
    missing,
  });
  recordMissingPrerequisites(journal, missing);
  journal.notRun(
    "docker-processkit-profile",
    "not run by the core canary: execute server-agent/scripts/test-managed-tls-docker.sh and record its result separately",
  );
  journal.notRun(
    "systemd-lifecycle",
    options.systemdVm
      ? `not executed automatically; verify on the disposable VM ${options.systemdVm}, never on this host`
      : "no disposable systemd VM was supplied",
  );

  const ctx = await step("provision", () =>
    provisionCanary({ harness, journal }),
  );
  provisioned = true;
  ctx.driver = createServerFunctionDriver(ctx.admin, {
    applyFn,
    abortFn: options.abortFn,
    retryFn: options.retryFn,
    drainFn: options.drainFn,
    harness,
  });
  await step("agents", () => startCanaryAgents(ctx));
  scenariosStarted = true;

  await step("receiver-first", () => runReceiverFirst(ctx));
  await step("export-only-a", () => runExportOnlyA(ctx));
  await step("isolated-relay", () => runIsolatedRelay(ctx));
  await step("no-double-billing", () => runNoDoubleBilling(ctx));

  const recoverySubscriber = await createCanarySubscriber(
    ctx,
    "canary-recovery",
  );
  const revocationProxy = ctx.servedProxy;
  let revocationFailure = null;
  try {
    await runFailureRecovery(ctx, {
      kind: options.recoveryKind === "abort" ? "abort" : "failure",
      recoverySubscriber,
      duringRecovery: async () => {
        try {
          await runLiveRevocation(ctx, {
            subscriber: ctx.subscription,
            proxy: revocationProxy,
          });
        } catch (error) {
          revocationFailure = error;
          await recordScenarioError("live-revocation", error);
        }
      },
    });
  } catch (error) {
    await recordScenarioError("failure-recovery", error);
    throw error;
  }
  if (options.recoveryKind === "both") {
    console.log(
      "second recovery pass (abort) is not run in the same topology; use --recovery-kind abort in a fresh run",
    );
  }

  try {
    await runDowngradeGate(ctx);
  } catch (error) {
    if (error instanceof CanaryScenarioError && error.blockedBy.length > 0) {
      journal.block("downgrade-gate", error.blockedBy, error.message);
    } else {
      await recordScenarioError("downgrade-gate", error);
      throw error;
    }
  }

  if (revocationFailure) {
    console.log(`live revocation failed: ${revocationFailure.message}`);
  }
} catch (error) {
  setupFailed = !provisioned || !scenariosStarted || !journal;
  console.log(
    "canary error:",
    redact(error.stack ?? String(error), harness.secrets),
  );
} finally {
  if (journal) {
    const report = journal.write();
    console.log(`evidence report: ${report}`);
    const summary = journal.summary();
    console.log(
      `evidence: ${summary.passed} passed, ${summary.failed} failed, ${summary.blocked} blocked, ${summary.not_run} not run`,
    );
    for (const entry of journal.entries()) {
      if (entry.status !== "passed") {
        console.log(
          `  ${entry.status.padEnd(7)} ${entry.id}: ${entry.detail ?? ""}`,
        );
      }
    }
  }
  await teardown();
}

if (setupFailed) process.exitCode = 2;
else if (process.exitCode === undefined) {
  process.exitCode = journal?.summary().exitCode ?? 2;
}
