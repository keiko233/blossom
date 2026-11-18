import type { AgentWsWelcomePayload } from "@blossom/contracts/agent-ws";
import { formatDesiredRevision } from "@blossom/domain/config-revision";

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

async function compileAgentServerConfig(serverId: string, enabled: boolean) {
  const [nodes, rules] = await Promise.all([
    enabled ? listEnabledServerNodes(serverId) : [],
    listEnabledRules(),
  ]);
  const perNodeUsers = await Promise.all(
    nodes.map(async (node) => {
      const subscriptions = await getNodeActiveSubscriptions(node.id);
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
export async function buildAgentDesiredState(
  server: Pick<Server, "id" | "enabled" | "desiredRevisionSeq">,
): Promise<AgentDesiredState> {
  const [
    { config, materializedNodes, materializedNodeIds },
    certificateContext,
  ] = await Promise.all([
    compileAgentServerConfig(server.id, server.enabled),
    getCertificateAgentContext(server.id),
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
