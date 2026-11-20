// Two-agent managed-networking canary (task 10): fixtures, prerequisites and
// evidence judges. Nothing here starts a process; the live scenario feeds
// observations into the judges below.
//
//   A ── subscriber inbound (exported) ── peer link ──▶ B ── peer inbound ── direct ──▶ origin
//
// A is the only public entrance and the only server a subscription may list.
// B owns the peer inbound and the egress; it serves no subscriber inbound.

import path from "node:path";

import { run as defaultRun } from "./util.mjs";

// -- Pinned runtime --------------------------------------------------------------

/**
 * Reads the sing-box version and official archive digests pinned by the agent
 * test image, so the canary and the Docker lifecycle test share one pin.
 */
export function parsePinnedSingBox(dockerfile) {
  const version = /^ARG SING_BOX_VERSION=([0-9.]+)\s*$/m.exec(dockerfile)?.[1];
  if (!version)
    throw new Error("Dockerfile.test does not pin SING_BOX_VERSION");
  const digests = {};
  const pattern = new RegExp(
    `${version.replaceAll(".", "\\.")}:(amd64|arm64)\\) digest="(sha256:[0-9a-f]{64})"`,
    "g",
  );
  for (const [, arch, digest] of dockerfile.matchAll(pattern))
    digests[arch] = digest;
  if (!digests.amd64 || !digests.arm64) {
    throw new Error(
      `Dockerfile.test lacks amd64 and arm64 digests for sing-box ${version}`,
    );
  }
  return { version, digests };
}

export const PINNED_SING_BOX_SOURCE = path.join(
  "server-agent",
  "Dockerfile.test",
);

// -- Two-agent layout ------------------------------------------------------------

export const CANARY_AGENTS = {
  A: { role: "entrance", exportsSubscriberInbound: true },
  B: { role: "exit", exportsSubscriberInbound: false },
};

/**
 * Disposable per-agent layout under one harness work directory. Agents share
 * no state directory, HOME, log file or token; sing-box stats endpoints are
 * agent-allocated on free loopback ports, so two agents fit on one host.
 */
export function canaryAgentLayout(workdir) {
  return Object.fromEntries(
    Object.entries(CANARY_AGENTS).map(([name, agent]) => [
      name,
      {
        name,
        ...agent,
        stateDir: path.join(workdir, `agent-${name}`, "state"),
        homeDir: path.join(workdir, `agent-${name}`, "home"),
        logFile: path.join(workdir, "logs", `agent-${name}.log`),
      },
    ]),
  );
}

/**
 * Launch arguments for one canary agent. Mirrors `Harness.startAgent`, but
 * selects protocol v2 explicitly because managed networking requires it.
 * The token travels only through the environment.
 */
export function canaryAgentLaunch(
  agent,
  { appUrl, singBox, token, protocol = "v2" },
) {
  if (protocol !== "v2" && protocol !== "legacy") {
    throw new Error(`unsupported canary agent protocol '${protocol}'`);
  }
  return {
    args: [
      "--url",
      `${appUrl}/api`,
      "--state-dir",
      agent.stateDir,
      "--sing-box-path",
      singBox,
      "--ws-protocol",
      protocol,
      "--log-level",
      "info",
    ],
    env: { HOME: agent.homeDir, AGENT_TOKEN: token },
    logFile: agent.logFile,
  };
}

// -- Prerequisites ---------------------------------------------------------------

const AGENT_SOURCE = path.join("server-agent", "src");
const AGENT_V2_SOURCE = path.join(AGENT_SOURCE, "agent_v2.rs");
const PROBE_MODULE_SOURCE = path.join(AGENT_SOURCE, "probe");
const ACTIVATION_SOURCE = path.join(
  "packages",
  "domain",
  "src",
  "managed-networking.ts",
);
const NETWORKING_QUERY_SOURCE = path.join(
  "app",
  "src",
  "query",
  "networking.ts",
);
const MANAGED_CONTRACT_SOURCE = path.join(
  "packages",
  "contracts",
  "src",
  "agent-config-v3.ts",
);
const MANAGED_COMPILER_SOURCE = path.join(
  "app",
  "src",
  "orpc",
  "proxy",
  "managed-singbox.ts",
);
const LINK_PROBE_CAPABILITY = "managed-link-probe-v1";

/**
 * Every prerequisite the live canary checks. `scope: "core"` blocks the whole
 * canary; `scope: "profile"` blocks only the evidence that names it.
 */
export const CANARY_PREREQUISITES = {
  "base-harness": {
    scope: "core",
    summary:
      "single-agent harness preflight (Node, pnpm, local Docker, cargo, curl)",
  },
  "pinned-sing-box": {
    scope: "core",
    summary: `sing-box version matching ${PINNED_SING_BOX_SOURCE}; the agent owns the loopback api service`,
  },
  "agent-link-probe-transport": {
    scope: "core",
    summary: `agent advertises ${LINK_PROBE_CAPABILITY} and handles link_probe.request (task 08)`,
  },
  "managed-probe-bindings": {
    scope: "core",
    summary:
      "the managed snapshot compiler emits probeBindings for every sender link (task 08 integration)",
  },
  "apply-ingress": {
    scope: "core",
    summary:
      "an audited admin apply creates a rollout and the v2 apply/status ingress advances it (task 09 integration)",
  },
  "activation-enabled": {
    scope: "core",
    summary:
      "a disposable canary build with MANAGED_NETWORKING_ACTIVATION_ENABLED; never commit the flip",
  },
  "docker-agent-profile": {
    scope: "profile",
    summary:
      "local Docker daemon to build server-agent/Dockerfile.test (processkit profile)",
  },
  "systemd-disposable-vm": {
    scope: "profile",
    summary:
      "a disposable systemd VM named with --systemd-vm; this host's systemd is never used",
  },
};

/**
 * Static readiness indicator for task 08's Rust transport: the probe
 * capability is in the advertised v2 list, and the request type is used
 * outside the probe module that defines and re-exports it. The live run must still read
 * the capability from `server.agent_capabilities` after each agent's hello.
 */
function linkProbeTransport(repoRoot, { run, readText }) {
  const advertised = /const V2_CAPABILITIES[^=]*=\s*&\[([^\]]*)\]/.exec(
    readText(path.join(repoRoot, AGENT_V2_SOURCE)),
  )?.[1];
  const advertises =
    advertised !== undefined &&
    (advertised.includes("MANAGED_LINK_PROBE_CAPABILITY") ||
      advertised.includes(`"${LINK_PROBE_CAPABILITY}"`));
  const users = run("grep", [
    "-rlE",
    "--",
    'MANAGED_LINK_PROBE_REQUEST_TYPE|"link_probe\\.request"',
    path.join(repoRoot, AGENT_SOURCE),
  ]).stdout.split("\n");
  const probeModule = path.join(repoRoot, PROBE_MODULE_SOURCE) + path.sep;
  const handles = users.some(
    (file) => file.trim() !== "" && !file.startsWith(probeModule),
  );
  return { advertises, handles };
}

/**
 * Static indicator for the compiler half of task 08: a sender's managed
 * snapshot must name its probe bindings, otherwise the Rust executor cannot
 * derive the loopback ingress and fixed responder for the link. The live run
 * still proves it end to end with a successful managed_link_probe row.
 */
function managedProbeBindings(repoRoot, { readText }) {
  const contract = readText(path.join(repoRoot, MANAGED_CONTRACT_SOURCE));
  const compiler = readText(path.join(repoRoot, MANAGED_COMPILER_SOURCE));
  return /probeBindings/.test(contract) && /probeBindings/.test(compiler);
}

/**
 * Static indicator for task 09's Apply integration: an admin server function
 * must call rollout admission. An explicit `--apply-fn` lets the canary run
 * against an integration whose export name differs, without guessing it here.
 */
function applyIngress(repoRoot, { readText }) {
  return /admitManagedRollout\s*\(/.test(
    readText(path.join(repoRoot, NETWORKING_QUERY_SOURCE)),
  );
}

/** `file#export` for a canary server-function override. */
export function parseServerFnSpec(spec) {
  const [file, exportName, ...rest] = String(spec).split("#");
  if (!file || !exportName || rest.length > 0) {
    throw new Error(`expected <file>#<export>, received '${spec}'`);
  }
  return [file, exportName];
}

/**
 * Canary-specific preflight. `probe` is injectable for tests: `run(cmd,args)`
 * and `readText(path)`. Returns facts plus one entry per missing prerequisite;
 * the base harness preflight is merged in by the caller.
 */
export function canaryPreflight(
  { repoRoot, singBox, dockerReachable, systemdVm, applyFn },
  probe = {},
) {
  const { run = defaultRun, readText } = probe;
  const facts = {};
  const missing = [];
  const miss = (id, detail) => missing.push({ id, detail });

  const pinned = parsePinnedSingBox(
    readText(path.join(repoRoot, PINNED_SING_BOX_SOURCE)),
  );
  facts.pinnedSingBox = pinned.version;
  if (!singBox) {
    miss("pinned-sing-box", "no sing-box binary found; pass --sing-box <path>");
  } else {
    const version = run(singBox, ["version"]);
    const reported = /sing-box version (\S+)/.exec(version.stdout)?.[1];
    facts.singBoxVersion = reported ?? "unknown";
    if (version.status !== 0 || reported !== pinned.version) {
      miss(
        "pinned-sing-box",
        `${singBox} reports ${reported ?? "no version"}, expected ${pinned.version}`,
      );
    }
    // The agent now owns the loopback `api` service used for stats; the
    // pinned official release carries it without a legacy with_v2ray_api tag.
  }

  const { advertises, handles } = linkProbeTransport(repoRoot, {
    run,
    readText,
  });
  facts.agentLinkProbe = `capability=${advertises} handler=${handles}`;
  if (!advertises || !handles) {
    const gaps = [
      advertises ? undefined : `advertise ${LINK_PROBE_CAPABILITY}`,
      handles ? undefined : "handle link_probe.request",
    ].filter(Boolean);
    miss(
      "agent-link-probe-transport",
      `server-agent/src does not ${gaps.join(" or ")} (task 08 Rust transport not landed)`,
    );
  }

  const bindings = managedProbeBindings(repoRoot, { readText });
  facts.managedProbeBindings = bindings;
  if (!bindings) {
    miss(
      "managed-probe-bindings",
      `${MANAGED_COMPILER_SOURCE} does not emit probeBindings for sender links (task 08 control-plane integration not landed)`,
    );
  }

  const administrativeApply = applyIngress(repoRoot, { readText });
  facts.applyIngress = applyFn
    ? `explicit ${applyFn}`
    : administrativeApply
      ? "admin server function"
      : "missing";
  if (!applyFn && !administrativeApply) {
    miss(
      "apply-ingress",
      `${NETWORKING_QUERY_SOURCE} does not admit a rollout (task 09 Apply integration not landed); pass --apply-fn <file>#<export> when it lands`,
    );
  }

  const activation =
    /MANAGED_NETWORKING_ACTIVATION_ENABLED\s*=\s*(true|false)/.exec(
      readText(path.join(repoRoot, ACTIVATION_SOURCE)),
    )?.[1];
  facts.activationEnabled = activation ?? "unknown";
  if (activation !== "true") {
    miss(
      "activation-enabled",
      `${ACTIVATION_SOURCE} sets the compile-time gate to ${activation ?? "an unknown value"}`,
    );
  }

  facts.dockerProfile = dockerReachable ? "daemon reachable" : "unavailable";
  if (!dockerReachable)
    miss("docker-agent-profile", "the Docker daemon is not reachable");

  facts.systemdVm = systemdVm ?? "none";
  if (!systemdVm) {
    miss(
      "systemd-disposable-vm",
      "no --systemd-vm given; only the fake-systemd sandbox (lib/agent-installer-e2e.test.ts) applies",
    );
  }

  return { facts, missing };
}

// -- Evidence --------------------------------------------------------------------

/**
 * The evidence the canary must record, in run order. `requires` names the
 * prerequisites; `observe` states where each observation comes from.
 */
export const CANARY_EVIDENCE = [
  {
    id: "receiver-first",
    title: "B's receiver stage is proven before A's sender and routing stages",
    requires: [
      "base-harness",
      "pinned-sing-box",
      "agent-link-probe-transport",
      "managed-probe-bindings",
      "apply-ingress",
      "activation-enabled",
    ],
    observe:
      "managed_rollout_stage rows (serverId, ordinal, state, issuedAt, confirmedAt), managed_link_probe rows, and subscription fetches taken during the rollout",
  },
  {
    id: "isolated-relay",
    title:
      "A-to-B relay carries the subscriber flow and nothing else reaches B",
    requires: [
      "base-harness",
      "pinned-sing-box",
      "agent-link-probe-transport",
      "managed-probe-bindings",
      "apply-ingress",
      "activation-enabled",
    ],
    observe:
      "origin request log (path token, remote address), direct dials to B's peer inbound with the subscriber credential, and dials through A to each agent's loopback stats endpoint",
  },
  {
    id: "export-only-a",
    title: "subscriptions list only A's subscriber inbound",
    requires: [
      "base-harness",
      "pinned-sing-box",
      "agent-link-probe-transport",
      "managed-probe-bindings",
      "apply-ingress",
      "activation-enabled",
    ],
    observe:
      "served Clash proxies (server, port) against A's node and B's peer listener",
  },
  {
    id: "no-double-billing",
    title: "the forwarded download is billed once, at A",
    requires: [
      "base-harness",
      "pinned-sing-box",
      "agent-link-probe-transport",
      "managed-probe-bindings",
      "apply-ingress",
      "activation-enabled",
    ],
    observe:
      "subscription.traffic_used_bytes delta and traffic_record rows per server",
  },
  {
    id: "failure-recovery",
    title: "failed and aborted stages restore the last confirmed version",
    requires: [
      "base-harness",
      "pinned-sing-box",
      "agent-link-probe-transport",
      "managed-probe-bindings",
      "apply-ingress",
      "activation-enabled",
    ],
    observe:
      "managed_rollout / managed_rollout_stage after an injected B failure and an Abort during apply; subscriber traffic after recovery",
  },
  {
    id: "live-revocation",
    title:
      "revocation reaches the data plane while a networking candidate is failed",
    requires: [
      "base-harness",
      "pinned-sing-box",
      "agent-link-probe-transport",
      "managed-probe-bindings",
      "apply-ingress",
      "activation-enabled",
    ],
    observe:
      "subscription status code and a proxied request through A after cancelling the subscription",
  },
  {
    id: "downgrade-gate",
    title:
      "unsupported agents block activation and managed state drains before downgrade",
    requires: [
      "base-harness",
      "pinned-sing-box",
      "agent-link-probe-transport",
      "managed-probe-bindings",
      "apply-ingress",
      "activation-enabled",
    ],
    observe:
      "apply result with B on a build lacking managed-networking-v1, legacy config request status for A, and rollout state after draining the link",
  },
  {
    id: "docker-processkit-profile",
    title:
      "the Docker processkit profile applies, rolls back and restarts as documented",
    requires: ["docker-agent-profile", "pinned-sing-box"],
    observe:
      "server-agent/scripts/test-managed-tls-docker.sh outcome and sing-box restarting with the agent container",
  },
  {
    id: "systemd-lifecycle",
    title: "the native systemd profile keeps serving across an agent restart",
    requires: ["systemd-disposable-vm"],
    observe:
      "unit InvocationID of the runtime before and after an agent restart, and the traffic report for one long flow",
  },
];

/** Splits the evidence into what can run and what each blocked item waits for. */
export function planEvidence(missing) {
  const absent = new Set(missing.map((m) => m.id));
  return CANARY_EVIDENCE.map((evidence) => ({
    id: evidence.id,
    title: evidence.title,
    blockedBy: evidence.requires.filter((id) => absent.has(id)),
  }));
}

const verdict = (failures) => ({ pass: failures.length === 0, failures });
const time = (value) => (value == null ? undefined : new Date(value).getTime());

/**
 * stages: [{ serverId, ordinal, state, issuedAt, confirmedAt }];
 * probes: [{ stageOrdinal, outcome, recordedAt }];
 * publications: [{ at, servers: [serverId], changed }] subscription fetches,
 * `changed` meaning the body differs from the pre-rollout fetch.
 */
export function judgeReceiverFirst({ stages, probes, publications, servers }) {
  const failures = [];
  const ordered = [...stages].sort((a, b) => a.ordinal - b.ordinal);
  const receiver = ordered[0];
  const senders = ordered.slice(1);
  if (!receiver || receiver.serverId !== servers.B) {
    failures.push("the first stage does not belong to B");
  } else if (
    receiver.state !== "confirmed" ||
    time(receiver.confirmedAt) === undefined
  ) {
    failures.push("B's receiver stage has no authenticated confirmation");
  }
  if (senders.length === 0 || senders.some((s) => s.serverId !== servers.A)) {
    failures.push("the later stages are not all on A");
  }
  const receiverAt = time(receiver?.confirmedAt) ?? Infinity;
  for (const stage of senders) {
    if (!(time(stage.issuedAt) > receiverAt)) {
      failures.push(
        `stage ${stage.ordinal} was issued before B's receiver was proven`,
      );
    }
  }
  const probe = probes.find((p) => p.outcome === "succeeded");
  const routing = senders.at(-1);
  if (!probe) failures.push("no successful link probe was recorded");
  else if (routing && !(time(routing.issuedAt) > time(probe.recordedAt))) {
    failures.push(
      "A's routing stage was issued before the link probe succeeded",
    );
  }
  const routedAt = time(routing?.confirmedAt) ?? Infinity;
  for (const publication of publications) {
    if (publication.servers.includes(servers.B))
      failures.push("a subscription listed B");
    if (time(publication.at) < routedAt && publication.changed) {
      failures.push(
        "the subscription changed before A's routing stage was confirmed",
      );
    }
  }
  return verdict(failures);
}

/**
 * origin: [{ token, remoteAddress }]; egress: { A, B } addresses the origin
 * sees for each server's direct egress; peerDials/statsDials: outcomes of the
 * negative dials ("refused" | "connected").
 */
export function judgeIsolatedRelay({
  token,
  origin,
  egress,
  peerDials,
  statsDials,
}) {
  const failures = [];
  if (egress.A === egress.B) {
    failures.push(
      "A and B share an egress address, so the origin cannot tell relay from direct: give B a distinct egress (container or loopback alias)",
    );
  }
  const hits = origin.filter((request) => request.token === token);
  if (hits.length === 0)
    failures.push("the relayed request never reached the origin");
  for (const hit of hits) {
    if (hit.remoteAddress !== egress.B) {
      failures.push(
        `the relayed request arrived from ${hit.remoteAddress}, not B's egress`,
      );
    }
  }
  for (const dial of peerDials) {
    if (dial.outcome !== "refused") {
      failures.push(
        `B's peer inbound accepted a ${dial.credential} credential`,
      );
    }
  }
  for (const dial of statsDials) {
    if (dial.outcome !== "refused") {
      failures.push(
        `subscriber traffic reached ${dial.agent}'s stats endpoint`,
      );
    }
  }
  return verdict(failures);
}

/** proxies: [{ server, port }] from the served Clash YAML. */
export function judgeExportOnlyA({ proxies, entrance, peerListener }) {
  const failures = [];
  const key = (p) => `${p.server}:${p.port}`;
  const listed = new Set(proxies.map(key));
  if (!listed.has(key(entrance)))
    failures.push("A's subscriber inbound is not exported");
  if (listed.has(key(peerListener)))
    failures.push("B's peer listener is exported");
  if (listed.size !== 1)
    failures.push(`expected exactly one entrance, found ${listed.size}`);
  return verdict(failures);
}

/**
 * Billing for one forwarded download of `bytes`. records: traffic_record rows
 * created by the download ({ serverId, bytes }); usedDelta: change of
 * subscription.traffic_used_bytes. `overhead` bounds protocol overhead.
 */
export function judgeNoDoubleBilling({
  bytes,
  usedDelta,
  records,
  servers,
  overhead = 0.25,
}) {
  const failures = [];
  if (usedDelta < bytes)
    failures.push(`billed ${usedDelta} bytes for a ${bytes}-byte download`);
  if (usedDelta > bytes * (1 + overhead)) {
    failures.push(`billed ${usedDelta} bytes, above the single-count bound`);
  }
  if (records.some((record) => record.serverId === servers.B)) {
    failures.push("B produced a billable traffic record");
  }
  const atA = records.filter((record) => record.serverId === servers.A);
  const sum = atA.reduce((total, record) => total + record.bytes, 0);
  if (atA.length === 0) failures.push("A produced no billable traffic record");
  else if (sum !== usedDelta)
    failures.push(`A's records sum to ${sum}, not ${usedDelta}`);
  return verdict(failures);
}

/**
 * rollout: { state, failureCode }; stages as in judgeReceiverFirst plus
 * recoveryProvenAt; trafficAfter: the subscriber's proxied request outcome;
 * newSubscriberPublished: an eligible subscriber added after recovery appears.
 */
export function judgeFailureRecovery({
  kind,
  rollout,
  stages,
  trafficAfter,
  newSubscriberPublished,
}) {
  const failures = [];
  const expected =
    kind === "abort"
      ? ["aborted", "aborted"]
      : ["failed", "stage_apply_failed"];
  if (rollout.state !== expected[0])
    failures.push(`rollout ended ${rollout.state}, not ${expected[0]}`);
  if (rollout.failureCode !== expected[1]) {
    failures.push(
      `failure code ${rollout.failureCode ?? "none"}, not ${expected[1]}`,
    );
  }
  const touched = stages.filter((stage) => stage.issuedAt != null);
  for (const stage of touched) {
    if (stage.recoveryProvenAt == null) {
      failures.push(`stage ${stage.ordinal} has no proven recovery`);
    }
  }
  if (trafficAfter !== "ok")
    failures.push("subscriber traffic did not recover");
  if (!newSubscriberPublished)
    failures.push("a new eligible subscriber was not published");
  return verdict(failures);
}

/** Outcomes after cancelling a subscription while a candidate is failed. */
export function judgeLiveRevocation({
  subscriptionStatus,
  proxyAfter,
  withinMs,
  deadlineMs,
}) {
  const failures = [];
  if (subscriptionStatus !== 403)
    failures.push(`subscription answered ${subscriptionStatus}`);
  if (proxyAfter !== "refused")
    failures.push("A still accepts the revoked credential");
  if (!(withinMs <= deadlineMs))
    failures.push(`revocation took ${withinMs} ms`);
  return verdict(failures);
}

/**
 * unsupportedApply: apply result with B lacking the capability;
 * legacyConfigStatus: HTTP status of a legacy config request for managed A;
 * drained: rollout state after removing the link before downgrade.
 */
export function judgeDowngradeGate({
  unsupportedApply,
  legacyConfigStatus,
  drained,
}) {
  const failures = [];
  if (unsupportedApply.accepted)
    failures.push("apply was accepted for an unsupported agent");
  if (legacyConfigStatus < 400)
    failures.push("a legacy config request for a managed server succeeded");
  if (drained.state !== "completed" || drained.activeLinks !== 0) {
    failures.push("managed links were not drained before downgrade");
  }
  return verdict(failures);
}
