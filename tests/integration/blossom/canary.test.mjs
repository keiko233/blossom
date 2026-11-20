// Checks for the two-agent canary fixtures, preflight and evidence judges. No
// Docker, database, agent or sing-box is started:
//   node --test tests/integration/blossom/canary.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CANARY_EVIDENCE,
  CANARY_PREREQUISITES,
  PINNED_SING_BOX_SOURCE,
  canaryAgentLaunch,
  canaryAgentLayout,
  canaryPreflight,
  judgeDowngradeGate,
  judgeExportOnlyA,
  judgeFailureRecovery,
  judgeIsolatedRelay,
  judgeLiveRevocation,
  judgeNoDoubleBilling,
  judgeReceiverFirst,
  parsePinnedSingBox,
  planEvidence,
} from "./lib/canary.mjs";
import { run as defaultRun } from "./lib/util.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const servers = { A: "srv-a", B: "srv-b" };
const pinned = parsePinnedSingBox(readFileSync(path.join(repoRoot, PINNED_SING_BOX_SOURCE), "utf8"));

test("the canary reads the same sing-box pin as the agent test image", () => {
  assert.match(pinned.version, /^\d+\.\d+\.\d+$/);
  assert.match(pinned.digests.amd64, /^sha256:[0-9a-f]{64}$/);
  assert.match(pinned.digests.arm64, /^sha256:[0-9a-f]{64}$/);
  assert.throws(() => parsePinnedSingBox("FROM alpine\n"), /does not pin/);
});

test("the two agents share no state, home, log or credential", () => {
  const layout = canaryAgentLayout("/tmp/blossom-it-00000000-x");
  const paths = Object.values(layout).flatMap((a) => [a.stateDir, a.homeDir, a.logFile]);
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(layout.A.exportsSubscriberInbound, true);
  assert.equal(layout.B.exportsSubscriberInbound, false);

  const launch = canaryAgentLaunch(layout.B, {
    appUrl: "http://127.0.0.1:1",
    singBox: "/bin/sing-box",
    token: "token-b",
  });
  assert.deepEqual(launch.args.slice(launch.args.indexOf("--ws-protocol"), -2), [
    "--ws-protocol",
    "v2",
  ]);
  assert.ok(!launch.args.includes("token-b"), "the token stays out of argv");
  assert.equal(launch.env.AGENT_TOKEN, "token-b");
});

const contractFile = path.join(repoRoot, "server-agent/src/probe/contract.rs");
const reexportFile = path.join(repoRoot, "server-agent/src/probe/mod.rs");
const sessionFile = path.join(repoRoot, "server-agent/src/ws/v2/session.rs");

/** `wired` simulates task 08: capability advertised and request handled. */
function fakeProbe({ version, wired = false, activation = "false" }) {
  return {
    run(command) {
      if (command === "grep") {
        const files = [contractFile, reexportFile, ...(wired ? [sessionFile] : [])];
        return { status: 0, stdout: `${files.join("\n")}\n` };
      }
      return { status: 0, stdout: version };
    },
    readText(file) {
      if (file.endsWith("managed-networking.ts")) {
        return `export const MANAGED_NETWORKING_ACTIVATION_ENABLED = ${activation};`;
      }
      if (file.endsWith("agent_v2.rs")) {
        const probe = wired ? "    MANAGED_LINK_PROBE_CAPABILITY,\n" : "";
        return `const V2_CAPABILITIES: &[&str] = &[\n    "config-v3",\n${probe}];\n`;
      }
      return readFileSync(file, "utf8");
    },
  };
}

test("the task 08 indicator runs against the real agent sources", () => {
  const { facts } = canaryPreflight(
    { repoRoot, singBox: "/bin/sing-box", dockerReachable: true, systemdVm: "vm" },
    { run: defaultRun, readText: (file) => readFileSync(file, "utf8") },
  );
  // Recorded against the real tree: true once task 08 lands, false before.
  assert.match(facts.agentLinkProbe, /^capability=(true|false) handler=(true|false)$/);
});

test("preflight names every missing prerequisite explicitly", () => {
  const { missing, facts } = canaryPreflight(
    { repoRoot, singBox: "/bin/sing-box", dockerReachable: false },
    fakeProbe({ version: "sing-box version 1.0.0\nTags: with_v2ray_api" }),
  );
  assert.deepEqual(missing.map((m) => m.id).sort(), [
    "activation-enabled",
    "agent-link-probe-transport",
    "docker-agent-profile",
    "pinned-sing-box",
    "systemd-disposable-vm",
  ]);
  for (const entry of missing) assert.ok(CANARY_PREREQUISITES[entry.id], entry.id);
  assert.match(missing.find((m) => m.id === "agent-link-probe-transport").detail, /advertise .* or handle/);
  assert.equal(facts.activationEnabled, "false");
});

test("preflight passes once the pin, task 08 transport, gate and profiles are present", () => {
  const { missing } = canaryPreflight(
    { repoRoot, singBox: "/bin/sing-box", dockerReachable: true, systemdVm: "canary-vm" },
    fakeProbe({
      version: `sing-box version ${pinned.version}\nTags: with_v2ray_api`,
      wired: true,
      activation: "true",
    }),
  );
  assert.deepEqual(missing, []);
});

test("preflight rejects the pinned version without the stats tag", () => {
  const { missing } = canaryPreflight(
    { repoRoot, singBox: "/bin/sing-box", dockerReachable: true, systemdVm: "vm" },
    fakeProbe({ version: `sing-box version ${pinned.version}\nTags: with_quic`, activation: "true" }),
  );
  assert.match(missing.find((m) => m.id === "pinned-sing-box").detail, /with_v2ray_api/);
});

test("the plan blocks profile evidence only on its own prerequisites", () => {
  assert.equal(new Set(CANARY_EVIDENCE.map((e) => e.id)).size, CANARY_EVIDENCE.length);
  for (const evidence of CANARY_EVIDENCE) {
    for (const id of evidence.requires) assert.ok(CANARY_PREREQUISITES[id], `${evidence.id}: ${id}`);
  }
  const plan = planEvidence([{ id: "systemd-disposable-vm" }]);
  assert.deepEqual(
    plan.filter((p) => p.blockedBy.length > 0).map((p) => p.id),
    ["systemd-lifecycle"],
  );
});

// -- judges ------------------------------------------------------------------------

const t = (seconds) => new Date(Date.UTC(2026, 10, 21, 0, 0, seconds));
const goodStages = [
  { serverId: servers.B, ordinal: 1, state: "confirmed", issuedAt: t(0), confirmedAt: t(5) },
  { serverId: servers.A, ordinal: 2, state: "confirmed", issuedAt: t(6), confirmedAt: t(9) },
  { serverId: servers.A, ordinal: 3, state: "confirmed", issuedAt: t(12), confirmedAt: t(15) },
];
const goodProbes = [{ stageOrdinal: 2, outcome: "succeeded", recordedAt: t(11) }];

test("receiver-first passes only when B is proven before A moves", () => {
  const publications = [{ at: t(8), servers: [servers.A], changed: false }];
  assert.ok(judgeReceiverFirst({ stages: goodStages, probes: goodProbes, publications, servers }).pass);

  const early = goodStages.map((s) => (s.ordinal === 2 ? { ...s, issuedAt: t(4) } : s));
  assert.match(
    judgeReceiverFirst({ stages: early, probes: goodProbes, publications, servers }).failures[0],
    /issued before B's receiver/,
  );
  const unprobed = judgeReceiverFirst({ stages: goodStages, probes: [], publications, servers });
  assert.ok(unprobed.failures.includes("no successful link probe was recorded"));
  const leaked = judgeReceiverFirst({
    stages: goodStages,
    probes: goodProbes,
    publications: [{ at: t(10), servers: [servers.A], changed: true }],
    servers,
  });
  assert.ok(!leaked.pass);
});

test("isolated relay needs distinguishable egress and refused negative dials", () => {
  const input = {
    token: "tok",
    origin: [{ token: "tok", remoteAddress: "172.18.0.3" }],
    egress: { A: "127.0.0.1", B: "172.18.0.3" },
    peerDials: [{ credential: "subscriber", outcome: "refused" }],
    statsDials: [
      { agent: "A", outcome: "refused" },
      { agent: "B", outcome: "refused" },
    ],
  };
  assert.ok(judgeIsolatedRelay(input).pass);
  assert.ok(!judgeIsolatedRelay({ ...input, egress: { A: "127.0.0.1", B: "127.0.0.1" } }).pass);
  assert.ok(
    !judgeIsolatedRelay({ ...input, origin: [{ token: "tok", remoteAddress: "127.0.0.1" }] }).pass,
  );
  assert.ok(!judgeIsolatedRelay({ ...input, statsDials: [{ agent: "B", outcome: "connected" }] }).pass);
});

test("export lists A's entrance and never B's peer listener", () => {
  const entrance = { server: "a.example", port: 4430 };
  const peerListener = { server: "b.example", port: 8443 };
  assert.ok(judgeExportOnlyA({ proxies: [entrance], entrance, peerListener }).pass);
  assert.ok(!judgeExportOnlyA({ proxies: [entrance, peerListener], entrance, peerListener }).pass);
  assert.ok(!judgeExportOnlyA({ proxies: [], entrance, peerListener }).pass);
});

test("a forwarded download is billed once, at A", () => {
  const bytes = 3 * 1024 * 1024;
  const once = { bytes, usedDelta: bytes + 4096, records: [{ serverId: servers.A, bytes: bytes + 4096 }], servers };
  assert.ok(judgeNoDoubleBilling(once).pass);
  const twice = {
    ...once,
    usedDelta: 2 * bytes,
    records: [
      { serverId: servers.A, bytes },
      { serverId: servers.B, bytes },
    ],
  };
  const result = judgeNoDoubleBilling(twice);
  assert.ok(result.failures.some((f) => f.includes("single-count bound")));
  assert.ok(result.failures.includes("B produced a billable traffic record"));
});

test("failure and abort recovery require proven restoration and a fresh publication", () => {
  const stages = goodStages.map((s) => ({ ...s, recoveryProvenAt: t(30) }));
  const failed = {
    kind: "failure",
    rollout: { state: "failed", failureCode: "stage_apply_failed" },
    stages,
    trafficAfter: "ok",
    newSubscriberPublished: true,
  };
  assert.ok(judgeFailureRecovery(failed).pass);
  assert.ok(
    judgeFailureRecovery({ ...failed, kind: "abort", rollout: { state: "aborted", failureCode: "aborted" } }).pass,
  );
  assert.ok(!judgeFailureRecovery({ ...failed, stages: goodStages }).pass);
  assert.ok(!judgeFailureRecovery({ ...failed, newSubscriberPublished: false }).pass);
});

test("revocation and downgrade gates fail closed", () => {
  assert.ok(judgeLiveRevocation({ subscriptionStatus: 403, proxyAfter: "refused", withinMs: 9000, deadlineMs: 30000 }).pass);
  assert.ok(!judgeLiveRevocation({ subscriptionStatus: 403, proxyAfter: "ok", withinMs: 9000, deadlineMs: 30000 }).pass);
  const gate = {
    unsupportedApply: { accepted: false },
    legacyConfigStatus: 409,
    drained: { state: "completed", activeLinks: 0 },
  };
  assert.ok(judgeDowngradeGate(gate).pass);
  assert.ok(!judgeDowngradeGate({ ...gate, unsupportedApply: { accepted: true } }).pass);
  assert.ok(!judgeDowngradeGate({ ...gate, drained: { state: "completed", activeLinks: 1 } }).pass);
});
