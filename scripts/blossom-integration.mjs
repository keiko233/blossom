#!/usr/bin/env node
// Real-component verification harness: disposable PostgreSQL (Docker), the
// built app, the Rust agent supervising a real sing-box, and a sing-box
// client pushing authenticated traffic through the panel-issued credentials.
//
//   node scripts/blossom-integration.mjs [--check] [--reuse-build] [--keep]
//        [--sing-box <path>] [--agent-bin <path>] [--postgres-image <image>]
//
// See tests/integration/blossom/README.md for prerequisites and what is and
// is not covered.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { runScenario } from "../tests/integration/blossom/e2e.mjs";
import { Harness } from "../tests/integration/blossom/lib/harness.mjs";
import { redact } from "../tests/integration/blossom/lib/util.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    check: false,
    reuseBuild: false,
    keep: false,
    singBox: undefined,
    agentBin: undefined,
    postgresImage: process.env.BLOSSOM_IT_POSTGRES_IMAGE ?? "postgres:18-alpine",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--check") options.check = true;
    else if (arg === "--reuse-build") options.reuseBuild = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--sing-box") options.singBox = path.resolve(value());
    else if (arg === "--agent-bin") options.agentBin = path.resolve(value());
    else if (arg === "--postgres-image") options.postgresImage = value();
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: node scripts/blossom-integration.mjs [--check] [--reuse-build] [--keep] [--sing-box <path>] [--agent-bin <path>] [--postgres-image <image>]",
      );
      process.exit(0);
    } else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const harness = new Harness({ repoRoot, options });

const results = [];
let failed = false;

async function step(name, fn) {
  if (failed) {
    results.push({ name, status: "skipped" });
    console.log(`SKIP  ${name}`);
    return;
  }
  const started = Date.now();
  try {
    await fn();
    results.push({ name, status: "passed" });
    console.log(`PASS  ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (error) {
    failed = true;
    results.push({ name, status: "failed" });
    console.log(`FAIL  ${name}`);
    console.log(redact(error.stack ?? String(error), harness.secrets));
  }
}

let tearingDown = false;
async function teardown() {
  if (tearingDown) return;
  tearingDown = true;
  await harness.stop();
  const leftovers = harness.leftovers();
  if (leftovers.length > 0) {
    console.log(`WARN  cleanup left behind: ${leftovers.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("cleanup complete: container, processes, temp directory and lock removed");
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`received ${signal}, cleaning up`);
    teardown().finally(() => process.exit(130));
  });
}

const pre = await harness.preflight();
console.log("tool availability:");
for (const [key, value] of Object.entries(pre.facts)) console.log(`  ${key}: ${value}`);
if (!pre.ok) {
  console.log("preflight failed:");
  for (const problem of pre.problems) console.log(`  - ${problem}`);
  process.exit(2);
}
if (options.check) {
  console.log("preflight passed (--check: nothing started)");
  process.exit(0);
}

try {
  await harness.start();
  await runScenario(harness, step);
} catch (error) {
  failed = true;
  console.log("harness error:", redact(error.stack ?? String(error), harness.secrets));
} finally {
  if (failed) harness.dumpLogs();
  await teardown();
}

const passed = results.filter((r) => r.status === "passed").length;
console.log(
  `\n${passed}/${results.length} steps passed` +
    (results.some((r) => r.status === "skipped") ? " (later steps skipped after a failure)" : ""),
);
process.exitCode = failed ? 1 : process.exitCode ?? 0;
