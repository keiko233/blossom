import type {
  AgentConfigV3Output,
  ManagedSnapshotExtension,
} from "@blossom/contracts/agent-config-v3";
import { MANAGED_NETWORKING_V2_CAPABILITY } from "@blossom/contracts/agent-config-v3";
import type { AgentWsWelcomePayload } from "@blossom/contracts/agent-ws";
import { formatDesiredRevision } from "@blossom/domain/config-revision";

import type { Database } from "@/db";
import type { Server } from "@/db/proxy-schema";
import { getServerEnv } from "@/lib/env";
import { toSingboxRouteRules } from "@/lib/routing-rules";
import { listEnabledServerNodes } from "@/query/agent";
import { getCertificateAgentContext } from "@/query/certificate-agent";
import { loadManagedCompileState } from "@/query/managed-compile-state";
import { listEnabledRules } from "@/query/rule-access";
import { getNodeActiveSubscriptions } from "@/query/subscription-access";

import {
  assertManagedOutputBudget,
  compileManagedServerConfig,
  ManagedCompileError,
  ManagedNetworkingRequiresV2Error,
  mergePeerCertificateArtifacts,
} from "./managed-singbox";
import {
  buildCertificateArtifacts,
  buildGenerationByCertificateId,
  buildManagedTlsBindings,
  compileServerConfig,
  computeDesiredRevision,
  filterCertificateArtifactsForBindings,
  validateMaterializedSnapshotAgainstIntent,
  type NodeInbound,
} from "./singbox";
import { buildInboundUser } from "./singbox-users";

/**
 * The longest a cached identifier may be trusted without recompiling. Inputs
 * with no change record (a temporary user ban clearing, a missed invalidation)
 * are then reflected within this bound, whether or not a push arrives.
 */
export const AGENT_DESIRED_CONFIG_MAX_AGE_MS = 120_000;

export interface AgentDesiredState {
  config: ReturnType<typeof compileServerConfig>;
  materializedNodeIds: string[];
  managedTlsBindings: ReturnType<typeof buildManagedTlsBindings>;
  certificateArtifacts: ReturnType<typeof buildCertificateArtifacts>;
  desiredRevision: string;
  /** Sequence read coherently with the managed pointer; falls back to the row. */
  desiredRevisionSeq: number;
  /** Single-unit extension, omitted for legacy servers. */
  managed?: ManagedSnapshotExtension;
  /** Raw rule-set sizes for the live/preview byte budget. */
  managedRuleSetSizes: { ruleSetId: string; rawBytes: number }[];
  /**
   * The identifier stays correct until this instant even with no change
   * record: the earliest expiry of a subscription in the compiled state, capped
   * at `AGENT_DESIRED_CONFIG_MAX_AGE_MS` after the reads began.
   */
  validUntil: Date;
}

async function compileAgentServerConfig(
  serverId: string,
  enabled: boolean,
  database?: Database,
) {
  const [nodes, rules] = await Promise.all([
    enabled ? listEnabledServerNodes(serverId, database) : [],
    listEnabledRules(database),
  ]);
  const expiries: number[] = [];
  const perNodeUsers = await Promise.all(
    nodes.map(async (node) => {
      const subscriptions = await getNodeActiveSubscriptions(node.id, database);
      for (const subscription of subscriptions) {
        expiries.push(subscription.expiresAt.getTime());
      }
      return subscriptions
        .map((subscription) => buildInboundUser(node, subscription))
        .filter((user): user is NonNullable<typeof user> => user !== null);
    }),
  );
  const built: NodeInbound[] = nodes.map((node, index) => ({
    node,
    users: perNodeUsers[index]!,
  }));
  const materialized = built.filter(({ users }) => users.length > 0);
  const legacyRouteRules = toSingboxRouteRules(rules);
  const env = getServerEnv();
  const config = compileServerConfig({
    inbounds: built,
    routeRules: legacyRouteRules,
    bootstrapDns: {
      type: env.SING_BOX_BOOTSTRAP_DNS_TYPE,
      server: env.SING_BOX_BOOTSTRAP_DNS_SERVER,
    },
  });
  return {
    config,
    legacyRouteRules,
    materializedNodes: materialized.map(({ node }) => node),
    materializedNodeIds: materialized.map(({ node }) => node.id),
    earliestExpiryMs: expiries.reduce<number | null>(
      (earliest, expiry) =>
        earliest === null || expiry < earliest ? expiry : earliest,
      null,
    ),
  };
}

/**
 * Compiles the opaque desired revision from the same snapshot that
 * `getConfigV3` returns. Pass the server row read before this function so the
 * publish-gate sequence and content retain the ordering documented on
 * `getAgentConfigV3`.
 */
export interface AgentDesiredStateOptions {
  /** Connection for the reads; defaults to the shared database facade. */
  database?: Database;
  /**
   * Whether compiling also advances the global certificate issuer. The HTTP
   * poll and the connection upgrade do; a Durable Object message cannot, since
   * the issuer uses the shared facade, so it passes `false` there.
   */
  advanceCertificates?: boolean;
  /**
   * `legacy` is the HTTP and v1 WebSocket path: managed state is refused so a
   * legacy compile can never replace serving peer state. `v2` requires the
   * agent's negotiated capability before compiling the managed extension.
   */
  managedDelivery?: "legacy" | "v2";
  /** Capabilities from the v2 `hello`, used only with `managedDelivery: "v2"`. */
  agentCapabilities?: readonly string[];
}

export async function buildAgentDesiredState(
  server: Pick<Server, "id" | "enabled" | "desiredRevisionSeq">,
  options: AgentDesiredStateOptions = {},
): Promise<AgentDesiredState> {
  const checkedAt = Date.now();
  const [
    {
      config,
      legacyRouteRules,
      materializedNodes,
      materializedNodeIds,
      earliestExpiryMs,
    },
    certificateContext,
    managedState,
  ] = await Promise.all([
    compileAgentServerConfig(server.id, server.enabled, options.database),
    getCertificateAgentContext(server.id, {
      database: options.database,
      advanceIssuance: options.advanceCertificates ?? true,
    }),
    loadManagedCompileState(server.id, options.database).catch((error) => {
      if (
        (options.managedDelivery ?? "legacy") === "legacy" &&
        error instanceof ManagedCompileError
      ) {
        throw new ManagedNetworkingRequiresV2Error();
      }
      throw error;
    }),
  ]);

  const generationByCertificateId =
    buildGenerationByCertificateId(certificateContext);
  const managedTlsBindings = buildManagedTlsBindings(
    materializedNodes,
    generationByCertificateId,
  );
  const baseCertificateArtifacts = filterCertificateArtifactsForBindings(
    buildCertificateArtifacts(certificateContext),
    managedTlsBindings,
  );

  if (!managedState) {
    return {
      config,
      materializedNodeIds,
      managedTlsBindings,
      certificateArtifacts: baseCertificateArtifacts,
      desiredRevisionSeq: server.desiredRevisionSeq,
      managedRuleSetSizes: [],
      desiredRevision: formatDesiredRevision(
        server.desiredRevisionSeq,
        computeDesiredRevision(
          config,
          managedTlsBindings,
          baseCertificateArtifacts,
          materializedNodeIds,
        ),
      ),
      validUntil: new Date(
        Math.min(
          checkedAt + AGENT_DESIRED_CONFIG_MAX_AGE_MS,
          earliestExpiryMs ?? Number.POSITIVE_INFINITY,
        ),
      ),
    };
  }

  if ((options.managedDelivery ?? "legacy") === "legacy") {
    throw new ManagedNetworkingRequiresV2Error();
  }
  if (
    !(options.agentCapabilities ?? []).includes(
      MANAGED_NETWORKING_V2_CAPABILITY,
    )
  ) {
    throw new ManagedCompileError(
      "unsupported_agent",
      "the connected agent did not advertise managed-networking-v1",
      managedState.fallbackRevision,
      managedState.desiredRevisionSeq,
    );
  }

  let compiled: ReturnType<typeof compileManagedServerConfig>;
  try {
    compiled = compileManagedServerConfig({
      intent: managedState.intent,
      subscriberConfig: config,
      legacyRouteRules,
      ruleSetArtifacts: managedState.ruleSetArtifacts,
      tlsMaterial: managedState.tlsMaterial,
      peerCredentials: managedState.peerCredentials,
    });
  } catch (error) {
    if (error instanceof ManagedCompileError) {
      throw new ManagedCompileError(
        error.code,
        error.message,
        managedState.fallbackRevision,
        managedState.desiredRevisionSeq,
      );
    }
    throw error;
  }
  const certificateArtifacts = mergePeerCertificateArtifacts(
    baseCertificateArtifacts,
    compiled.peerCertificateArtifacts,
  );
  const desiredRevision = formatDesiredRevision(
    managedState.desiredRevisionSeq,
    computeDesiredRevision(
      compiled.config,
      managedTlsBindings,
      certificateArtifacts,
      materializedNodeIds,
      compiled.extension,
    ),
  );

  const validationSnapshot = {
    apiVersion: 3 as const,
    agent: {
      configPollIntervalSeconds: 5,
      heartbeatIntervalSeconds: 5,
    },
    desiredRevision,
    materializedNodeIds,
    singboxConfig: compiled.config,
    managedTlsBindings,
    certificateArtifacts,
    managed: compiled.extension,
  } satisfies AgentConfigV3Output;
  const validation = validateMaterializedSnapshotAgainstIntent(
    managedState.intent,
    validationSnapshot,
  );
  if (!validation.ok) {
    throw new ManagedCompileError(
      "managed_state_inconsistent",
      `materialized snapshot does not match its pinned intent: ${validation.issues
        .map((issue) => issue.code)
        .join(", ")}`,
      managedState.fallbackRevision,
      managedState.desiredRevisionSeq,
    );
  }

  const managedCertExpiries = [
    ...managedState.tlsMaterial.inbound.map((entry) =>
      Date.parse(entry.artifact.notAfter),
    ),
    ...managedState.tlsMaterial.outboundTrust.map((entry) =>
      Date.parse(entry.artifact.notAfter),
    ),
  ].filter(Number.isFinite);

  return {
    config: compiled.config,
    materializedNodeIds,
    managedTlsBindings,
    certificateArtifacts,
    desiredRevisionSeq: managedState.desiredRevisionSeq,
    managed: compiled.extension,
    managedRuleSetSizes: compiled.embeddedRuleSetBindings.map((binding) => ({
      ruleSetId: binding.ruleSetId,
      rawBytes: binding.sizeBytes,
    })),
    desiredRevision,
    validUntil: new Date(
      Math.min(
        checkedAt + AGENT_DESIRED_CONFIG_MAX_AGE_MS,
        earliestExpiryMs ?? Number.POSITIVE_INFINITY,
        ...managedCertExpiries,
      ),
    ),
  };
}

/**
 * The v3 configuration document: the HTTP `GET /agent/config/v3` body and the
 * WebSocket v2 snapshot body are the same bytes, so an agent can switch
 * transports without its applied configuration changing meaning.
 */
export function buildAgentConfigV3Output(
  server: Pick<
    Server,
    | "configPollIntervalSeconds"
    | "heartbeatIntervalSeconds"
    | "desiredAgentVersion"
    | "desiredSingBoxVersion"
  >,
  desired: AgentDesiredState,
) {
  const output = {
    apiVersion: 3 as const,
    agent: {
      configPollIntervalSeconds: server.configPollIntervalSeconds,
      heartbeatIntervalSeconds: server.heartbeatIntervalSeconds,
      ...(server.desiredAgentVersion
        ? { desiredAgentVersion: server.desiredAgentVersion }
        : {}),
      ...(server.desiredSingBoxVersion
        ? { desiredSingBoxVersion: server.desiredSingBoxVersion }
        : {}),
    },
    desiredRevision: desired.desiredRevision,
    materializedNodeIds: desired.materializedNodeIds,
    singboxConfig: desired.config,
    managedTlsBindings: desired.managedTlsBindings,
    certificateArtifacts: desired.certificateArtifacts,
    ...(desired.managed ? { managed: desired.managed } : {}),
  };
  if (desired.managed) {
    assertManagedOutputBudget(output, desired.managedRuleSetSizes);
  }
  return output;
}

export async function buildAgentWelcome(
  server: Server,
): Promise<AgentWsWelcomePayload> {
  const desired = await buildAgentDesiredState(server);
  return {
    serverId: server.id,
    serverName: server.name,
    protocolVersion: 1,
    desiredRevisionSeq: desired.desiredRevisionSeq,
    desiredRevision: desired.desiredRevision,
    pollIntervalSeconds: server.configPollIntervalSeconds,
    heartbeatIntervalSeconds: server.heartbeatIntervalSeconds,
  };
}
