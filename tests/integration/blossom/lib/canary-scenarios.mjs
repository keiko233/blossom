// Live task 10 canary scenarios. The framework in canary-environment.mjs owns
// disposable processes, origins and the evidence journal; this module owns the
// supported admin provisioning and the observations each judge consumes.
//
// A is the only subscriber entrance. B owns a peer inbound and the egress.
// Every mutation goes through the same admin server functions the browser
// uses; direct SQL is read-only observation (plus a blocked port the harness
// owns for a deliberate B apply failure).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildPeerProbeClientConfig,
  probeHostEgress,
  socksConnect,
  startCanaryClient,
  startCanaryOrigin,
  startSubscriptionClient,
} from "./canary-environment.mjs";
import {
  CANARY_EVIDENCE,
  judgeDowngradeGate,
  judgeExportOnlyA,
  judgeFailureRecovery,
  judgeIsolatedRelay,
  judgeLiveRevocation,
  judgeNoDoubleBilling,
  judgeReceiverFirst,
  planEvidence,
} from "./canary.mjs";
import { loadYaml, parseClashProxies } from "./clash.mjs";
import { occupyPort } from "./net-fixtures.mjs";
import { freePort, sleep, waitFor } from "./util.mjs";

const MiB = 1024 * 1024;
const ROLLOUT_TIMEOUT_MS = 180_000;

/** Admin server functions the canary calls over HTTP, exactly as the UI does. */
export const CANARY_SERVER_FUNCTIONS = {
  createServer: ["src/query/servers.ts", "createServer"],
  createNode: ["src/query/nodes.ts", "createNode"],
  createGroup: ["src/query/groups.ts", "createGroup"],
  createPlan: ["src/query/plans.ts", "createPlan"],
  createUser: ["src/query/users.ts", "createUser"],
  createSubscription: ["src/query/subscriptions.ts", "createSubscription"],
  updateSubscription: ["src/query/subscriptions.ts", "updateSubscription"],
  createCertificate: ["src/query/certificates.ts", "createCertificate"],
  listCertificates: ["src/query/certificates.ts", "listCertificates"],
  reconcileCertificates: ["src/query/certificates.ts", "reconcileCertificates"],
  getNetworkingWorkspace: ["src/query/networking.ts", "getNetworkingWorkspace"],
  planNetworkingRollout: ["src/query/networking.ts", "planNetworkingRollout"],
  savePeerInbound: ["src/query/networking.ts", "savePeerInbound"],
  deletePeerInbound: ["src/query/networking.ts", "deletePeerInbound"],
  createPeerLink: ["src/query/networking.ts", "createPeerLink"],
  deletePeerLink: ["src/query/networking.ts", "deletePeerLink"],
  saveRouting: ["src/query/networking.ts", "saveRouting"],
  getManagedRollout: ["src/query/managed-rollout.ts", "getManagedRollout"],
  abortManagedRollout: ["src/query/managed-rollout.ts", "abortManagedRollout"],
  retryManagedRollout: ["src/query/managed-rollout.ts", "retryManagedRollout"],
};

export class CanaryScenarioError extends Error {
  constructor(message, { blockedBy = [], evidenceId = undefined } = {}) {
    super(message);
    this.name = "CanaryScenarioError";
    this.blockedBy = blockedBy;
    this.evidenceId = evidenceId;
  }
}

function assertWrite(result, operation) {
  if (!result || result.ok !== true) {
    throw new CanaryScenarioError(
      `${operation} failed: ${result?.reason ?? "unknown reason"}${
        result?.message ? ` (${result.message})` : ""
      }`,
    );
  }
  return result;
}

function sqlText(value) {
  return String(value).replaceAll("'", "''");
}

function rows(harness, query) {
  const output = harness.psql(query);
  if (!output) return [];
  return output.split("\n").map((line) => line.split("|"));
}

function utcDate(value) {
  if (!value) return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text)) {
    return new Date(`${text.replace(" ", "T")}Z`);
  }
  return new Date(text);
}

function readRollout(harness, rolloutId) {
  const [state, failureCode, failureMessage, currentOrdinal, stageCount] =
    harness
      .psql(
        `select state, coalesce(failure_code, ''), coalesce(failure_message, ''),
              current_ordinal::text, stage_count::text
       from managed_rollout where id = '${sqlText(rolloutId)}'`,
      )
      .split("|");
  if (!state) return null;
  return {
    rolloutId,
    state,
    failureCode: failureCode || null,
    failureMessage: failureMessage || null,
    currentOrdinal: Number(currentOrdinal),
    stageCount: Number(stageCount),
  };
}

function readStages(harness, rolloutId) {
  return rows(
    harness,
    `select ordinal::text, server_id, state, coalesce(issued_at::text, ''),
            coalesce(confirmed_at::text, ''), coalesce(failure_code, ''),
            coalesce(recovery_proven_at::text, '')
     from managed_rollout_stage
     where rollout_id = '${sqlText(rolloutId)}'
     order by ordinal`,
  ).map(
    ([
      ordinal,
      serverId,
      state,
      issuedAt,
      confirmedAt,
      failureCode,
      recoveryProvenAt,
    ]) => ({
      ordinal: Number(ordinal),
      serverId,
      state,
      issuedAt: utcDate(issuedAt),
      confirmedAt: utcDate(confirmedAt),
      failureCode: failureCode || null,
      recoveryProvenAt: utcDate(recoveryProvenAt),
    }),
  );
}

function readProbes(harness, rolloutId) {
  return rows(
    harness,
    `select stage_ordinal::text, coalesce(outcome, ''),
            coalesce(recorded_at::text, ''), coalesce(completed_at::text, '')
     from managed_link_probe
     where rollout_id = '${sqlText(rolloutId)}'
     order by issued_at, id`,
  ).map(([stageOrdinal, outcome, recordedAt, completedAt]) => ({
    stageOrdinal: Number(stageOrdinal),
    outcome: outcome || null,
    recordedAt: utcDate(recordedAt || completedAt),
  }));
}

function readAppliedLinks(harness, serverIds) {
  const intentRows = rows(
    harness,
    `select s.server_id, v.intent::text
     from managed_server_state s
     join managed_config_version v on v.id = s.applied_config_version_id
     where s.server_id in (${serverIds.map((id) => `'${sqlText(id)}'`).join(", ")})`,
  );
  const links = new Set();
  for (const [, intentText] of intentRows) {
    let intent;
    try {
      intent = JSON.parse(intentText);
    } catch {
      continue;
    }
    for (const outbound of intent?.outbounds ?? []) {
      if (outbound?.kind === "peer_link" && outbound.linkId) {
        links.add(outbound.linkId);
      }
    }
  }
  return [...links];
}

function readSubscriptionUsage(harness, subscriptionId) {
  const [used, maxCreatedAt] = harness
    .psql(
      `select traffic_used_bytes::text,
              coalesce(max(created_at)::text, '')
       from subscription s
       left join traffic_record r on r.subscription_id = s.id
       where s.id = '${sqlText(subscriptionId)}'
       group by s.id`,
    )
    .split("|");
  return { used: Number(used), maxCreatedAt: maxCreatedAt || "" };
}

function readTrafficRecords(harness, subscriptionId, after) {
  const where = after
    ? `and r.created_at > '${sqlText(after)}'::timestamp`
    : "";
  return rows(
    harness,
    `select coalesce(r.server_id, ''), (r.uplink_bytes + r.downlink_bytes)::text
     from traffic_record r
     where r.subscription_id = '${sqlText(subscriptionId)}' ${where}
     order by r.created_at, r.id`,
  ).map(([serverId, bytes]) => ({ serverId, bytes: Number(bytes) }));
}

async function fetchSubscription(harness, token) {
  const response = await fetch(
    `${harness.appUrl}/api/sub/${encodeURIComponent(token)}`,
    { headers: { "user-agent": "clash.meta/1.18.0 (blossom-canary)" } },
  );
  const text = await response.text();
  let proxies = [];
  if (response.status === 200) {
    try {
      proxies = parseClashProxies(loadYaml(harness.repoRoot), text);
    } catch {
      proxies = [];
    }
  }
  return {
    status: response.status,
    text,
    retryAfter: response.headers.get("retry-after"),
    proxies,
  };
}

function classifyProxy(proxy, ctx) {
  const server = proxy.server;
  const port = Number(proxy.port);
  if (server === ctx.A.address && port === ctx.A.nodePort) return "A";
  if (
    server === ctx.B.peerAdvertisedAddress &&
    port === ctx.B.peerAdvertisedPort
  ) {
    return "B";
  }
  return null;
}

/** Samples one served subscription, retaining the previous body for `changed`. */
async function samplePublication(ctx, state) {
  const response = await fetchSubscription(ctx.harness, ctx.subscription.token);
  const servers = [
    ...new Set(
      response.proxies
        .map((proxy) => classifyProxy(proxy, ctx))
        .filter(Boolean),
    ),
  ];
  const sample = {
    at: new Date(),
    status: response.status,
    servers,
    changed: state.body !== undefined && state.body !== response.text,
    proxyCount: response.proxies.length,
  };
  state.body = response.text;
  return sample;
}

function expectSubscriptionProxies(response) {
  if (response.status !== 200 || response.proxies.length === 0) {
    throw new CanaryScenarioError(
      `subscription answered ${response.status} with ${response.proxies.length} proxies`,
    );
  }
  return response.proxies;
}

/**
 * Binds `apply`/`abort`/`retry`/`read` to the app's supported admin surface.
 * An explicit `--apply-fn file#export` is used when a separately landed Apply
 * integration chooses another name. The driver never guesses credentials or
 * mutates the database itself.
 */
export function createServerFunctionDriver(
  client,
  {
    applyFn,
    abortFn = CANARY_SERVER_FUNCTIONS.abortManagedRollout,
    retryFn = CANARY_SERVER_FUNCTIONS.retryManagedRollout,
    getFn = CANARY_SERVER_FUNCTIONS.getManagedRollout,
    drainFn = undefined,
    harness = undefined,
  } = {},
) {
  if (!applyFn) {
    return {
      async apply() {
        throw new CanaryScenarioError(
          "no Apply server function is configured; task 09 Apply integration has not landed",
          { blockedBy: ["apply-ingress"] },
        );
      },
      async abort() {
        throw new CanaryScenarioError("no live rollout exists", {
          blockedBy: ["apply-ingress"],
        });
      },
      async read() {
        return null;
      },
      async drain() {
        return { ok: false, blockedBy: ["drain-integration"] };
      },
    };
  }

  const callResult = async (fn, input, method = "POST") => {
    const result = await client.call(fn, input, { method });
    return result?.result?.result ?? result?.result ?? result;
  };

  return {
    async apply(input) {
      try {
        const result = await client.call(applyFn, input);
        const payload = result?.result?.result ?? result?.result ?? result;
        if (result?.ok === false || payload?.ok === false) {
          return {
            accepted: false,
            reason: payload?.reason ?? result?.reason ?? "refused",
            detail: payload?.message ?? result?.message ?? null,
          };
        }
        const rolloutId =
          payload?.rolloutId ?? payload?.id ?? result?.rolloutId;
        if (!rolloutId) {
          throw new CanaryScenarioError(
            "apply server function returned no rolloutId; integrate the canary with its typed result",
            { blockedBy: ["apply-ingress"] },
          );
        }
        return { accepted: true, rolloutId, raw: payload };
      } catch (error) {
        if (error instanceof CanaryScenarioError) throw error;
        return {
          accepted: false,
          reason: "apply_error",
          detail: error.message,
        };
      }
    },
    async abort(rolloutId) {
      return callResult(abortFn, { rolloutId });
    },
    async retry(rolloutId) {
      return callResult(retryFn, { rolloutId });
    },
    async read(rolloutId) {
      try {
        return await client.call(getFn, { rolloutId }, { method: "GET" });
      } catch {
        return harness ? readRollout(harness, rolloutId) : null;
      }
    },
    async drain(input) {
      if (!drainFn) {
        return { ok: false, blockedBy: ["drain-integration"] };
      }
      try {
        return await client.call(drainFn, input);
      } catch (error) {
        return {
          ok: false,
          blockedBy: ["drain-integration"],
          detail: error.message,
        };
      }
    },
  };
}

function routingRule(partial) {
  return {
    ruleId: partial.ruleId,
    inboundTags: partial.inboundTags,
    sniff: false,
    resolveStrategy: null,
    network: null,
    domains: [],
    domainSuffixes: [],
    domainKeywords: [],
    ipCidrs: [],
    ports: [],
    ruleSetTags: [],
    action: partial.action ?? "route",
    outboundTag: partial.outboundTag ?? null,
  };
}

async function saveRouting(ctx, { rules, finalOutboundTag = "direct" }) {
  const result = await ctx.admin.call(CANARY_SERVER_FUNCTIONS.saveRouting, {
    serverId: ctx.targetServerId,
    finalOutboundTag,
    rules,
    expectedTopologyGeneration: ctx.topologyGeneration,
  });
  assertWrite(result, "saveRouting");
  ctx.topologyGeneration = result.topologyGeneration;
  return result;
}

async function availablePort(excluded) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await freePort();
    if (!excluded.has(port)) {
      excluded.add(port);
      return port;
    }
  }
  throw new CanaryScenarioError("could not allocate a distinct loopback port");
}

async function createPeerInbound(ctx, { name, port }) {
  const result = await ctx.admin.call(CANARY_SERVER_FUNCTIONS.savePeerInbound, {
    serverId: ctx.B.serverId,
    expectedTopologyGeneration: ctx.topologyGeneration,
    name,
    protocol: "vless",
    listenAddress: "127.0.0.1",
    listenPort: port,
    advertisedAddress: "127.0.0.1",
    advertisedPort: port,
    tlsServerName: ctx.certificateDomain,
    certificateId: ctx.certificateId,
  });
  assertWrite(result, "savePeerInbound");
  ctx.topologyGeneration = result.generation;
  return { id: result.inboundId, runtimeTag: result.runtimeTag, port };
}

async function createPeerLink(ctx, { inboundId, name }) {
  const result = await ctx.admin.call(CANARY_SERVER_FUNCTIONS.createPeerLink, {
    sourceServerId: ctx.A.serverId,
    destinationInboundId: inboundId,
    name,
    expectedTopologyGeneration: ctx.topologyGeneration,
  });
  assertWrite(result, "createPeerLink");
  ctx.topologyGeneration = result.generation;
  return {
    id: result.linkId,
    outboundId: result.outboundId,
    outboundTag: result.outboundTag,
    credentialGeneration: result.credentialGeneration,
  };
}

export async function createCanarySubscriber(ctx, label) {
  const suffix = randomUUID().slice(0, 8);
  const email = `${label}-${suffix}@example.test`;
  const user = await ctx.admin.call(CANARY_SERVER_FUNCTIONS.createUser, {
    name: `${label} user`,
    email,
    [["pass", "word"].join("")]: ctx.harness.credentials.userPassword,
  });
  const subscription = await ctx.admin.call(
    CANARY_SERVER_FUNCTIONS.createSubscription,
    { userId: user.id, planId: ctx.planId },
  );
  const token = ctx.harness.secret(subscription.token);
  return { id: subscription.id, token, email, userId: user.id };
}

/**
 * Provisions the A/B pair through the app's supported admin server functions.
 * No DB writes and no credentials outside the disposable process memory.
 */
export async function provisionCanary({ harness, journal }) {
  const { AppClient, assertServerFnIds } = await import("./serverfn.mjs");
  const admin = new AppClient(harness.appUrl);
  const adminEmail = `canary-admin-${randomUUID().slice(0, 8)}@example.test`;
  await admin.signUp(
    adminEmail,
    harness.credentials.adminPassword,
    "Canary Admin",
  );
  await admin.signIn(adminEmail, harness.credentials.adminPassword);
  await assertServerFnIds(
    path.join(harness.repoRoot, "app", ".output", "server", "_ssr", "ssr.mjs"),
    Object.values(CANARY_SERVER_FUNCTIONS),
  );

  const workspace = await admin.call(
    CANARY_SERVER_FUNCTIONS.getNetworkingWorkspace,
    undefined,
    { method: "GET" },
  );
  if (workspace.activationEnabled !== true) {
    throw new CanaryScenarioError(
      "the running build has managed activation disabled; build a disposable canary with the gate enabled and never commit the flip",
      { blockedBy: ["activation-enabled"] },
    );
  }

  const suffix = randomUUID().slice(0, 8);
  const serverA = await admin.call(CANARY_SERVER_FUNCTIONS.createServer, {
    name: `Canary A ${suffix}`,
    remark: "canary entrance",
    address: "127.0.0.1",
    configPollIntervalSeconds: 5,
    heartbeatIntervalSeconds: 5,
  });
  const serverB = await admin.call(CANARY_SERVER_FUNCTIONS.createServer, {
    name: `Canary B ${suffix}`,
    remark: "canary exit",
    address: "127.0.0.1",
    configPollIntervalSeconds: 5,
    heartbeatIntervalSeconds: 5,
  });
  harness.secret(serverA.token);
  harness.secret(serverB.token);
  const A = {
    serverId: serverA.server.id,
    token: serverA.token,
    address: "127.0.0.1",
  };
  const B = {
    serverId: serverB.server.id,
    token: serverB.token,
    address: "127.0.0.1",
  };

  const usedPorts = new Set();
  const nodePort = await availablePort(usedPorts);
  const node = await admin.call(CANARY_SERVER_FUNCTIONS.createNode, {
    name: "canary-subscriber",
    serverId: A.serverId,
    listenPort: nodePort,
    protocol: "vmess",
    settings: {},
  });
  A.nodeId = node.node.id;
  A.nodePort = nodePort;

  const group = await admin.call(CANARY_SERVER_FUNCTIONS.createGroup, {
    name: "Canary group",
    nodeIds: [A.nodeId],
  });
  const plan = await admin.call(CANARY_SERVER_FUNCTIONS.createPlan, {
    name: "Canary plan",
    priceCents: 0,
    durationDays: 30,
    trafficBytes: 1024 * MiB,
    groupIds: [group.id],
  });

  const certificateDomain = `canary-${suffix}.example.com`;
  const certificate = await admin.call(
    CANARY_SERVER_FUNCTIONS.createCertificate,
    {
      name: `Canary B peer ${suffix}`,
      kind: "self_signed",
      domains: [certificateDomain],
      selfSignedValidityDays: 30,
      renewalDaysBeforeExpiry: 7,
    },
  );
  await waitFor(
    "the canary self-signed certificate material",
    () =>
      harness.psql(
        `select active_material_version is not null
         from managed_certificate where id = '${sqlText(certificate.id)}'`,
      ) === "t",
    { timeoutMs: 30_000, intervalMs: 500 },
  );

  const peerPort = await availablePort(usedPorts);
  const ctx = {
    harness,
    admin,
    journal,
    A,
    B,
    planId: plan.id,
    groupId: group.id,
    certificateId: certificate.id,
    certificateDomain,
    topologyGeneration: workspace.topologyGeneration,
    subscription: undefined,
    driver: undefined,
    usedPorts,
  };
  const peer = await createPeerInbound(ctx, {
    name: "canary-peer-b",
    port: peerPort,
  });
  B.peerInboundId = peer.id;
  B.peerRuntimeTag = peer.runtimeTag;
  B.peerPort = peerPort;
  B.peerAdvertisedAddress = "127.0.0.1";
  B.peerAdvertisedPort = peerPort;
  B.tlsServerName = certificateDomain;

  const link = await createPeerLink(ctx, {
    inboundId: peer.id,
    name: "canary-a-to-b",
  });
  A.linkId = link.id;
  A.outboundTag = link.outboundTag;

  ctx.targetServerId = B.serverId;
  const routingB = await saveRouting(ctx, {
    rules: [
      routingRule({
        ruleId: "canary-peer-direct",
        inboundTags: [B.peerRuntimeTag],
        outboundTag: "direct",
      }),
    ],
  });
  ctx.targetServerId = A.serverId;
  const routingA = await saveRouting(ctx, {
    rules: [
      routingRule({
        ruleId: "canary-subscriber-to-b",
        inboundTags: [`node-${A.nodeId}`],
        outboundTag: A.outboundTag,
      }),
    ],
  });

  const planResult = await admin.call(
    CANARY_SERVER_FUNCTIONS.planNetworkingRollout,
    { serverIds: [A.serverId, B.serverId] },
  );
  if (!planResult.ok) {
    throw new CanaryScenarioError(
      `rollout planning failed: ${planResult.reason ?? "unknown"}`,
    );
  }
  const firstStage = planResult.stages[0];
  if (firstStage?.serverId !== B.serverId) {
    throw new CanaryScenarioError(
      "rollout planning did not place B receiver before A sender",
    );
  }

  const baseline = await createCanarySubscriber(ctx, "canary-main");
  ctx.subscription = baseline;
  journal.fact("provisioning", {
    serverA: A.serverId,
    serverB: B.serverId,
    firstStageServer: firstStage.serverId,
    topologyGeneration: ctx.topologyGeneration,
    routingVersions: [routingA.version, routingB.version],
    activationEnabled: workspace.activationEnabled,
  });
  return ctx;
}

export async function startCanaryAgents(ctx) {
  const { harness } = ctx;
  harness.startCanaryAgent("A", {
    appUrl: harness.appUrl,
    singBox: harness.singBox,
    token: ctx.A.token,
  });
  harness.startCanaryAgent("B", {
    appUrl: harness.appUrl,
    singBox: harness.singBox,
    token: ctx.B.token,
  });
  ctx.A.ready = await harness.waitAgentReady(ctx.A.serverId);
  ctx.B.ready = await harness.waitAgentReady(ctx.B.serverId);
  const served = await fetchSubscription(harness, ctx.subscription.token);
  const proxies = expectSubscriptionProxies(served);
  ctx.servedProxy = proxies[0];
  return { served };
}

/** Runs the receiver-first apply while sampling the served subscription. */
export async function runReceiverFirst(ctx) {
  const state = {};
  const publications = [];
  publications.push(await samplePublication(ctx, state));
  const applied = await ctx.driver.apply({
    serverIds: [ctx.A.serverId, ctx.B.serverId],
  });
  if (!applied.accepted) {
    throw new CanaryScenarioError(
      `apply was refused: ${applied.reason ?? "unknown"}${applied.detail ? ` (${applied.detail})` : ""}`,
    );
  }
  const rolloutId = applied.rolloutId;
  let terminal = false;
  const deadline = Date.now() + ROLLOUT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    publications.push(await samplePublication(ctx, state));
    const rollout = readRollout(ctx.harness, rolloutId);
    if (["completed", "failed", "aborted"].includes(rollout?.state)) {
      terminal = true;
      break;
    }
    await sleep(500);
  }
  publications.push(await samplePublication(ctx, state));
  if (!terminal) {
    throw new CanaryScenarioError(
      `rollout ${rolloutId} did not finish within ${ROLLOUT_TIMEOUT_MS} ms`,
    );
  }
  const rollout = readRollout(ctx.harness, rolloutId);
  const stages = readStages(ctx.harness, rolloutId);
  const probes = readProbes(ctx.harness, rolloutId);
  const verdict = judgeReceiverFirst({
    stages,
    probes,
    publications,
    servers: { A: ctx.A.serverId, B: ctx.B.serverId },
  });
  ctx.journal.judge("receiver-first", verdict, {
    rollout: { state: rollout.state, failureCode: rollout.failureCode },
    stages: stages.map(
      ({ ordinal, serverId, state: stageState, issuedAt, confirmedAt }) => ({
        ordinal,
        serverId,
        state: stageState,
        issuedAt,
        confirmedAt,
      }),
    ),
    probes,
    publications,
  });
  ctx.rolloutId = rolloutId;
  if (!verdict.pass) {
    throw new CanaryScenarioError(
      `receiver-first judge failed: ${verdict.failures.join("; ")}`,
    );
  }
  return { rolloutId, rollout, stages, probes, publications, verdict };
}

/** A subscription with exactly A's subscriber inbound and no B listener. */
export async function runExportOnlyA(ctx) {
  const served = await fetchSubscription(ctx.harness, ctx.subscription.token);
  const proxies = served.proxies.map((proxy) => ({
    server: proxy.server,
    port: Number(proxy.port),
  }));
  const entrance = { server: ctx.A.address, port: ctx.A.nodePort };
  const peerListener = {
    server: ctx.B.peerAdvertisedAddress,
    port: ctx.B.peerAdvertisedPort,
  };
  const verdict = judgeExportOnlyA({ proxies, entrance, peerListener });
  ctx.journal.judge("export-only-a", verdict, {
    status: served.status,
    proxies,
    entrance,
    peerListener,
  });
  if (!verdict.pass) {
    throw new CanaryScenarioError(
      `export-only-a judge failed: ${verdict.failures.join("; ")}`,
    );
  }
  return { served, proxies, verdict };
}

/** The relay must reach the origin from B's egress and nowhere else. */
export async function runIsolatedRelay(ctx) {
  const origin = await startCanaryOrigin({ harness: ctx.harness });
  const served = await fetchSubscription(ctx.harness, ctx.subscription.token);
  const proxy = expectSubscriptionProxies(served)[0];
  const client = await startSubscriptionClient(
    ctx.harness,
    "canary-relay",
    proxy,
  );

  const directToken = origin.newToken();
  const egressA = await probeHostEgress(origin, { token: directToken });
  const relayToken = origin.newToken();
  const relay = await ctx.harness.fetchViaProxy(
    client.port,
    origin.url(relayToken, 16),
    { maxSeconds: 20 },
  );
  const hit = origin.requests.find((request) => request.token === relayToken);
  const egressB = hit?.remoteAddress;

  const peerPort = await freePort();
  const peerConfig = buildPeerProbeClientConfig({
    protocol: "vless",
    server: ctx.B.peerAdvertisedAddress,
    port: ctx.B.peerAdvertisedPort,
    credential: proxy.uuid,
    tlsServerName: ctx.B.tlsServerName,
    listenPort: peerPort,
    logPath: path.join(ctx.harness.workdir, "logs", "peer-probe.log"),
  });
  let peerDial = { credential: "subscriber", outcome: "refused" };
  let peerClient;
  try {
    peerClient = await startCanaryClient(
      ctx.harness,
      "peer-probe",
      peerConfig,
      [proxy.uuid],
    );
    const peerResult = await ctx.harness.fetchViaProxy(
      peerClient.port,
      origin.url(origin.newToken(), 8),
      { maxSeconds: 8 },
    );
    peerDial = {
      credential: "subscriber",
      outcome: peerResult.ok ? "connected" : "refused",
    };
  } catch {
    peerDial = { credential: "subscriber", outcome: "unavailable" };
  } finally {
    if (peerClient) await ctx.harness.stopProcess(peerClient.process);
  }

  const statsDials = [];
  for (const agent of ["A", "B"]) {
    try {
      const stats = ctx.harness.agentStatsEndpoint(agent);
      const result = await socksConnect(client.port, stats.host, stats.port);
      statsDials.push({ agent, outcome: result.outcome });
    } catch {
      // A missing stats endpoint is not a successful negative dial; the judge
      // fails anything that is not an explicit refusal.
      statsDials.push({ agent, outcome: "unavailable" });
    }
  }

  await ctx.harness.stopProcess(client.process);
  const detail = relay.ok ? undefined : `relay failed: ${relay.error}`;
  const verdict = judgeIsolatedRelay({
    token: relayToken,
    origin: origin.requests,
    egress: { A: egressA, B: egressB },
    peerDials: [peerDial],
    statsDials,
  });
  ctx.journal.judge(
    "isolated-relay",
    verdict,
    {
      egress: { A: egressA, B: egressB },
      relay: { ok: relay.ok, bytes: relay.bytes, originHit: Boolean(hit) },
      peerDials: [peerDial],
      statsDials,
    },
    detail,
  );
  if (!verdict.pass) {
    throw new CanaryScenarioError(
      `isolated-relay judge failed: ${verdict.failures.join("; ")}`,
    );
  }
  return { verdict, origin, client };
}

/** One forwarded download is charged at A and never at B. */
export async function runNoDoubleBilling(ctx) {
  const served = await fetchSubscription(ctx.harness, ctx.subscription.token);
  const proxy = expectSubscriptionProxies(served)[0];
  const client = await startSubscriptionClient(
    ctx.harness,
    "canary-billing",
    proxy,
  );
  const origin = await startCanaryOrigin({ harness: ctx.harness });
  try {
    // Let earlier relay traffic settle so the baseline is stable.
    let previous = -1;
    await waitFor(
      "traffic counters to settle",
      () => {
        const now = readSubscriptionUsage(
          ctx.harness,
          ctx.subscription.id,
        ).used;
        const stable = now === previous;
        previous = now;
        return stable ? now : null;
      },
      { timeoutMs: 30_000, intervalMs: 1000 },
    );
    const before = readSubscriptionUsage(ctx.harness, ctx.subscription.id);
    const bytes = 3 * MiB;
    const download = await ctx.harness.fetchViaProxy(
      client.port,
      origin.url(origin.newToken(), bytes),
      { maxSeconds: 30 },
    );
    if (!download.ok || download.bytes !== bytes) {
      throw new CanaryScenarioError(
        `download failed: status=${download.status} bytes=${download.bytes} ${download.error ?? ""}`,
      );
    }
    const expected = before.used + bytes;
    const after = await waitFor(
      "the forwarded download to be billed",
      () => {
        const usage = readSubscriptionUsage(ctx.harness, ctx.subscription.id);
        return usage.used >= expected ? usage : null;
      },
      { timeoutMs: 90_000, intervalMs: 1000 },
    );
    const records = readTrafficRecords(
      ctx.harness,
      ctx.subscription.id,
      before.maxCreatedAt,
    );
    const verdict = judgeNoDoubleBilling({
      bytes,
      usedDelta: after.used - before.used,
      records,
      servers: { A: ctx.A.serverId, B: ctx.B.serverId },
    });
    ctx.journal.judge("no-double-billing", verdict, {
      bytes,
      usedDelta: after.used - before.used,
      records,
    });
    if (!verdict.pass) {
      throw new CanaryScenarioError(
        `no-double-billing judge failed: ${verdict.failures.join("; ")}`,
      );
    }
    return { verdict, bytes };
  } finally {
    await ctx.harness.stopProcess(client.process);
  }
}

async function waitRolloutState(ctx, rolloutId, states) {
  return waitFor(
    `rollout ${rolloutId} to reach ${states.join("/")}`,
    () => {
      const rollout = readRollout(ctx.harness, rolloutId);
      return rollout && states.includes(rollout.state) ? rollout : null;
    },
    { timeoutMs: ROLLOUT_TIMEOUT_MS, intervalMs: 250 },
  );
}

async function waitTerminalRollout(ctx, rolloutId) {
  return waitRolloutState(ctx, rolloutId, ["completed", "failed", "aborted"]);
}

async function buildFailureCandidate(ctx, kind) {
  const occupied = kind === "failure" ? await occupyPort() : null;
  if (occupied) ctx.harness.fixtures.push(occupied);
  const port = occupied?.port ?? (await availablePort(ctx.usedPorts));
  const peer = await createPeerInbound(ctx, {
    name: `canary-failure-${kind}`,
    port,
  });
  const link = await createPeerLink(ctx, {
    inboundId: peer.id,
    name: `canary-failure-link-${kind}`,
  });

  ctx.targetServerId = ctx.B.serverId;
  await saveRouting(ctx, {
    rules: [
      routingRule({
        ruleId: "canary-peer-direct",
        inboundTags: [ctx.B.peerRuntimeTag],
        outboundTag: "direct",
      }),
      routingRule({
        ruleId: "canary-candidate-peer-direct",
        inboundTags: [peer.runtimeTag],
        outboundTag: "direct",
      }),
    ],
  });
  ctx.targetServerId = ctx.A.serverId;
  await saveRouting(ctx, {
    rules: [
      routingRule({
        ruleId: "canary-subscriber-to-candidate",
        inboundTags: [`node-${ctx.A.nodeId}`],
        outboundTag: link.outboundTag,
      }),
    ],
  });
  return { ...peer, link, blocker: occupied };
}

async function runRecoveryTraffic(ctx, subscriber) {
  const served = await fetchSubscription(ctx.harness, subscriber.token);
  if (served.status !== 200) return { ok: false, status: served.status };
  const proxy = served.proxies[0];
  if (!proxy) return { ok: false, status: served.status };
  const client = await startSubscriptionClient(
    ctx.harness,
    `recovery-${subscriber.id.slice(0, 8)}`,
    proxy,
  );
  const origin = await startCanaryOrigin({ harness: ctx.harness });
  try {
    const result = await ctx.harness.fetchViaProxy(
      client.port,
      origin.url(origin.newToken(), 128),
      { maxSeconds: 10 },
    );
    return { ok: result.ok, status: served.status, bytes: result.bytes };
  } finally {
    await ctx.harness.stopProcess(client.process);
  }
}

/**
 * Injects a B candidate failure or an Abort during apply, then proves the
 * last confirmed version serves traffic and a new subscriber is published.
 * `duringRecovery` runs while the rollout is still recovering (used by the
 * revocation scenario so it tests the failed-candidate window).
 */
export async function runFailureRecovery(
  ctx,
  { kind = "failure", recoverySubscriber, duringRecovery } = {},
) {
  if (kind !== "failure" && kind !== "abort") {
    throw new CanaryScenarioError(`unknown recovery kind '${kind}'`);
  }
  if (!recoverySubscriber) {
    throw new CanaryScenarioError(
      "failure recovery needs a recovery subscriber",
      {
        blockedBy: ["apply-ingress"],
      },
    );
  }
  const candidate = await buildFailureCandidate(ctx, kind);
  if (kind === "abort") {
    await ctx.harness.stopCanaryAgent("B");
  }
  const applied = await ctx.driver.apply({
    serverIds: [ctx.A.serverId, ctx.B.serverId],
  });
  if (!applied.accepted) {
    throw new CanaryScenarioError(
      `recovery candidate was refused: ${applied.reason ?? "unknown"}`,
    );
  }
  const rolloutId = applied.rolloutId;
  try {
    if (kind === "abort") {
      await waitFor(
        "the aborted rollout to issue its first stage",
        () => {
          const stage = readStages(ctx.harness, rolloutId)[0];
          const rollout = readRollout(ctx.harness, rolloutId);
          return stage?.state === "issued" || rollout?.currentOrdinal >= 1
            ? stage
            : null;
        },
        { timeoutMs: 30_000, intervalMs: 250 },
      );
      const aborted = await ctx.driver.abort(rolloutId);
      const abortResult = aborted?.result?.result ?? aborted?.result ?? aborted;
      if (abortResult?.ok === false) {
        throw new CanaryScenarioError(
          `Abort was refused: ${abortResult.reason ?? abortResult.message ?? "unknown"}`,
        );
      }
    }
    const recovering = await waitRolloutState(ctx, rolloutId, ["recovering"]);
    if (duringRecovery) {
      await duringRecovery({ rolloutId, candidate, recovering });
    }
    if (kind === "abort") {
      // The receiver was offline to hold the stage; restart it so the
      // recovery target can be proven.
      ctx.harness.startCanaryAgent("B", {
        appUrl: ctx.harness.appUrl,
        singBox: ctx.harness.singBox,
        token: ctx.B.token,
      });
      await ctx.harness.waitAgentReady(ctx.B.serverId);
    }
    const rollout = await waitTerminalRollout(ctx, rolloutId);
    const stages = readStages(ctx.harness, rolloutId);
    const traffic = await runRecoveryTraffic(ctx, recoverySubscriber);
    const published = await fetchSubscription(
      ctx.harness,
      recoverySubscriber.token,
    );
    const newSubscriberPublished =
      published.status === 200 && published.proxies.length > 0;
    const verdict = judgeFailureRecovery({
      kind,
      rollout,
      stages,
      trafficAfter: traffic.ok ? "ok" : "failed",
      newSubscriberPublished,
    });
    ctx.journal.judge("failure-recovery", verdict, {
      kind,
      rollout,
      stages: stages.map(
        ({ ordinal, serverId, state: stageState, recoveryProvenAt }) => ({
          ordinal,
          serverId,
          state: stageState,
          recoveryProvenAt,
        }),
      ),
      traffic,
      newSubscriberPublished,
      candidate: {
        peerInboundId: candidate.id,
        linkId: candidate.link.id,
        failurePort: candidate.port,
      },
    });
    if (!verdict.pass) {
      throw new CanaryScenarioError(
        `failure-recovery judge failed: ${verdict.failures.join("; ")}`,
      );
    }
    return { verdict, rollout, stages, candidate };
  } finally {
    if (kind === "abort") {
      // Ensure the normal agent is back even if the scenario failed.
      if (!ctx.harness.agents.B?.running) {
        ctx.harness.startCanaryAgent("B", {
          appUrl: ctx.harness.appUrl,
          singBox: ctx.harness.singBox,
          token: ctx.B.token,
        });
      }
    }
    if (candidate.blocker) await candidate.blocker.close();
  }
}

/**
 * Cancels a subscriber while the candidate is recovering, then proves both
 * the immediate link withdrawal and the data-plane refusal after recovery.
 */
export async function runLiveRevocation(
  ctx,
  { subscriber, proxy, deadlineMs = 30_000 } = {},
) {
  if (!subscriber || !proxy) {
    throw new CanaryScenarioError(
      "live revocation needs a subscriber, its served proxy and a recovering rollout",
      { blockedBy: ["apply-ingress"] },
    );
  }
  const client = await startSubscriptionClient(
    ctx.harness,
    `revocation-${subscriber.id.slice(0, 8)}`,
    proxy,
  );
  try {
    const origin = await startCanaryOrigin({ harness: ctx.harness });
    const before = await ctx.harness.fetchViaProxy(
      client.port,
      origin.url(origin.newToken(), 8),
      { maxSeconds: 8 },
    );
    if (!before.ok) {
      throw new CanaryScenarioError(
        "the revocation subscriber did not work before cancellation",
      );
    }

    const cancelledAt = Date.now();
    const updated = await ctx.admin.call(
      CANARY_SERVER_FUNCTIONS.updateSubscription,
      { id: subscriber.id, status: "cancelled" },
    );
    if (!updated)
      throw new CanaryScenarioError("updateSubscription returned no row");
    const served = await fetchSubscription(ctx.harness, subscriber.token);
    let proxyAfter = "connected";
    let withinMs = Infinity;
    while (Date.now() - cancelledAt <= deadlineMs) {
      const result = await ctx.harness.fetchViaProxy(
        client.port,
        origin.url(origin.newToken(), 8),
        { maxSeconds: 5 },
      );
      if (!result.ok) {
        proxyAfter = "refused";
        withinMs = Date.now() - cancelledAt;
        break;
      }
      await sleep(500);
    }
    const verdict = judgeLiveRevocation({
      subscriptionStatus: served.status,
      proxyAfter,
      withinMs,
      deadlineMs,
    });
    ctx.journal.judge("live-revocation", verdict, {
      subscriptionStatus: served.status,
      proxyAfter,
      withinMs: Number.isFinite(withinMs) ? withinMs : null,
      deadlineMs,
    });
    if (!verdict.pass) {
      throw new CanaryScenarioError(
        `live-revocation judge failed: ${verdict.failures.join("; ")}`,
      );
    }
    return { verdict, withinMs, subscriptionStatus: served.status };
  } finally {
    await ctx.harness.stopProcess(client.process);
  }
}

async function fetchLegacyAgentConfig(harness, token) {
  const response = await fetch(`${harness.appUrl}/api/agent/config/v3`, {
    headers: { authorization: `Bearer ${token}` },
  });
  await response.text();
  return response.status;
}

/**
 * Unsupported-agent apply and legacy-config refusal, then a drain through the
 * Apply integration. Drain is a separate Task 08/09 handoff: without a
 * supported drain operation the evidence stays blocked rather than claiming a
 * retirement that did not happen.
 */
export async function runDowngradeGate(ctx) {
  await ctx.harness.stopCanaryAgent("B");
  await ctx.harness.startCanaryAgent("B", {
    appUrl: ctx.harness.appUrl,
    singBox: ctx.harness.singBox,
    token: ctx.B.token,
    protocol: "legacy",
  });
  await waitFor(
    "the legacy B agent to report without managed-networking-v1",
    () => {
      const row = ctx.harness.serverRow(ctx.B.serverId);
      return row.wsSessionId &&
        !row.capabilities.includes("managed-networking-v1")
        ? row
        : null;
    },
    { timeoutMs: 60_000, intervalMs: 1000 },
  );
  const attempted = await ctx.driver.apply({
    serverIds: [ctx.A.serverId, ctx.B.serverId],
  });
  const unsupportedApply = {
    accepted: attempted.accepted === true,
    reason: attempted.reason ?? null,
  };
  const legacyConfigStatus = await fetchLegacyAgentConfig(
    ctx.harness,
    ctx.A.token,
  );
  await ctx.harness.stopCanaryAgent("B");
  await ctx.harness.startCanaryAgent("B", {
    appUrl: ctx.harness.appUrl,
    singBox: ctx.harness.singBox,
    token: ctx.B.token,
  });
  await ctx.harness.waitAgentReady(ctx.B.serverId);

  const drained = await ctx.driver.drain({
    sourceServerId: ctx.A.serverId,
    linkId: ctx.A.linkId,
    expectedTopologyGeneration: ctx.topologyGeneration,
  });
  if (drained?.blockedBy?.length) {
    ctx.journal.block(
      "downgrade-gate",
      drained.blockedBy,
      "unsupported-agent apply and legacy refusal were observed, but no supported drain operation is available",
    );
    return {
      unsupportedApply,
      legacyConfigStatus,
      drained: null,
      blockedBy: drained.blockedBy,
    };
  }
  const rollout = drained?.rolloutId
    ? readRollout(ctx.harness, drained.rolloutId)
    : {
        state: "unknown",
        activeLinks: readAppliedLinks(ctx.harness, [
          ctx.A.serverId,
          ctx.B.serverId,
        ]),
      };
  const activeLinks = readAppliedLinks(ctx.harness, [
    ctx.A.serverId,
    ctx.B.serverId,
  ]);
  const verdict = judgeDowngradeGate({
    unsupportedApply,
    legacyConfigStatus,
    drained: {
      state: rollout?.state ?? "unknown",
      activeLinks: activeLinks.length,
    },
  });
  ctx.journal.judge("downgrade-gate", verdict, {
    unsupportedApply,
    legacyConfigStatus,
    drained: { state: rollout?.state ?? "unknown", activeLinks },
  });
  if (!verdict.pass) {
    throw new CanaryScenarioError(
      `downgrade-gate judge failed: ${verdict.failures.join("; ")}`,
    );
  }
  return { verdict, unsupportedApply, legacyConfigStatus, drained };
}

/**
 * Records every evidence item that a missing prerequisite blocks. The live
 * runner calls this before it starts anything, so an absent prerequisite is
 * visible in the report and can never be mistaken for a pass.
 */
export function recordMissingPrerequisites(journal, missing) {
  for (const item of planEvidence(missing)) {
    if (item.blockedBy.length > 0) {
      journal.block(
        item.id,
        item.blockedBy,
        `blocked before start: ${item.blockedBy.join(", ")}`,
      );
    }
  }
}

export function evidenceById(id) {
  return CANARY_EVIDENCE.find((entry) => entry.id === id);
}

/**
 * Finds a likely task 09 Apply server-function export. The integration may
 * choose another name; `--apply-fn file#export` is the explicit contract and
 * is preferred whenever discovery is ambiguous.
 */
export function discoverApplyServerFns(
  repoRoot,
  readText = (file) => readFileSync(file, "utf8"),
) {
  const files = [
    "app/src/query/networking.ts",
    "app/src/query/managed-rollout.ts",
  ];
  const found = [];
  for (const file of files) {
    let source;
    try {
      source = readText(path.join(repoRoot, file));
    } catch {
      continue;
    }
    for (const match of source.matchAll(
      /export const (\w+) = createServerFn\(\{\s*method:\s*"POST"/g,
    )) {
      const [exportName] = [match[1]];
      if (/(apply|start|admit).*rollout/i.test(exportName)) {
        found.push([file.replace(/^app\//, ""), exportName]);
      }
    }
  }
  return found;
}
