import type { AgentWsWelcomePayload } from "@blossom/contracts/agent-ws";
import { formatDesiredRevision } from "@blossom/domain/config-revision";

import type { Database } from "@/db";
import type { Server } from "@/db/proxy-schema";
import { toSingboxRouteRules } from "@/lib/routing-rules";
import { listEnabledServerNodes } from "@/query/agent";
import { getCertificateAgentContext } from "@/query/certificate-agent";
import { listEnabledRules } from "@/query/rule-access";
import { getNodeActiveSubscriptions } from "@/query/subscription-access";

import {
  buildCertificateArtifacts,
  buildGenerationByCertificateId,
  buildManagedTlsBindings,
  compileServerConfig,
  computeDesiredRevision,
  filterCertificateArtifactsForBindings,
  type NodeInbound,
} from "./singbox";
import { buildInboundUser } from "./singbox-users";

export interface AgentDesiredState {
  config: ReturnType<typeof compileServerConfig>;
  materializedNodeIds: string[];
  managedTlsBindings: ReturnType<typeof buildManagedTlsBindings>;
  certificateArtifacts: ReturnType<typeof buildCertificateArtifacts>;
  desiredRevision: string;
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
  const perNodeUsers = await Promise.all(
    nodes.map(async (node) => {
      const subscriptions = await getNodeActiveSubscriptions(node.id, database);
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
  const config = compileServerConfig({
    inbounds: built,
    routeRules: toSingboxRouteRules(rules),
  });
  return {
    config,
    materializedNodes: materialized.map(({ node }) => node),
    materializedNodeIds: materialized.map(({ node }) => node.id),
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
}

export async function buildAgentDesiredState(
  server: Pick<Server, "id" | "enabled" | "desiredRevisionSeq">,
  options: AgentDesiredStateOptions = {},
): Promise<AgentDesiredState> {
  const [
    { config, materializedNodes, materializedNodeIds },
    certificateContext,
  ] = await Promise.all([
    compileAgentServerConfig(server.id, server.enabled, options.database),
    getCertificateAgentContext(server.id, {
      database: options.database,
      advanceIssuance: options.advanceCertificates ?? true,
    }),
  ]);

  const generationByCertificateId =
    buildGenerationByCertificateId(certificateContext);
  const managedTlsBindings = buildManagedTlsBindings(
    materializedNodes,
    generationByCertificateId,
  );
  const certificateArtifacts = filterCertificateArtifactsForBindings(
    buildCertificateArtifacts(certificateContext),
    managedTlsBindings,
  );

  return {
    config,
    materializedNodeIds,
    managedTlsBindings,
    certificateArtifacts,
    desiredRevision: formatDesiredRevision(
      server.desiredRevisionSeq,
      computeDesiredRevision(
        config,
        managedTlsBindings,
        certificateArtifacts,
        materializedNodeIds,
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
  return {
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
  };
}

export async function buildAgentWelcome(
  server: Server,
): Promise<AgentWsWelcomePayload> {
  const desired = await buildAgentDesiredState(server);
  return {
    serverId: server.id,
    serverName: server.name,
    protocolVersion: 1,
    desiredRevisionSeq: server.desiredRevisionSeq,
    desiredRevision: desired.desiredRevision,
    pollIntervalSeconds: server.configPollIntervalSeconds,
    heartbeatIntervalSeconds: server.heartbeatIntervalSeconds,
  };
}
