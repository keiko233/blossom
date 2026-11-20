#!/usr/bin/env node
// Two-agent managed-networking canary (task 10). Reports which prerequisites
// are missing and which evidence each one blocks; it starts nothing.
//
//   node scripts/blossom-canary.mjs [--check] [--sing-box <path>]
//        [--agent-bin <path>] [--systemd-vm <name>]
//
// Exit codes: 2 a core prerequisite is missing; with --check 0 otherwise
// (profile prerequisites only block their own evidence); without --check 3,
// because the live scenario is not implemented yet.
// See tests/integration/blossom/README.md#two-agent-canary.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANARY_EVIDENCE,
  CANARY_PREREQUISITES,
  canaryPreflight,
  planEvidence,
} from "../tests/integration/blossom/lib/canary.mjs";
import { Harness } from "../tests/integration/blossom/lib/harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE =
  "usage: node scripts/blossom-canary.mjs [--check] [--sing-box <path>] [--agent-bin <path>] [--systemd-vm <name>]";

function parseArgs(argv) {
  const options = { check: false, singBox: undefined, agentBin: undefined, systemdVm: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--check") options.check = true;
    else if (arg === "--sing-box") options.singBox = path.resolve(value());
    else if (arg === "--agent-bin") options.agentBin = path.resolve(value());
    else if (arg === "--systemd-vm") options.systemdVm = value();
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const harness = new Harness({ repoRoot, options });
const base = await harness.preflight();
const canary = canaryPreflight(
  {
    repoRoot,
    singBox: harness.singBox,
    dockerReachable: Boolean(base.facts.docker),
    systemdVm: options.systemdVm,
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
console.log(missing.length === 0 ? "missing prerequisites: none" : "missing prerequisites:");
for (const { id, detail } of missing) {
  console.log(`  - [${CANARY_PREREQUISITES[id].scope}] ${id}: ${detail}`);
}
console.log("evidence plan:");
const plan = planEvidence(missing);
for (const item of plan) {
  const state = item.blockedBy.length === 0 ? "ready" : `blocked by ${item.blockedBy.join(", ")}`;
  console.log(`  - ${item.id}: ${state}`);
  console.log(`      ${item.title}`);
  console.log(`      observe: ${CANARY_EVIDENCE.find((e) => e.id === item.id).observe}`);
}

const coreMissing = missing.some(({ id }) => CANARY_PREREQUISITES[id].scope === "core");
if (coreMissing) {
  console.log("\ncanary not runnable: core prerequisites are missing (nothing was started)");
  process.exit(2);
}
if (options.check) process.exit(0);
console.log("\nprerequisites present, but the live two-agent scenario is not implemented yet");
process.exit(3);
