import type {
  AgentWsCertificateDeployment,
  AgentWsConfigAckPayload,
  AgentWsHelloPayload,
  AgentWsUpdateStatuses,
} from "@blossom/contracts/agent-ws";

import { type Database, db } from "@/db";
import {
  markAgentWsConnected,
  markAgentWsDisconnected,
  recordAgentConfigAck,
  recordAgentHello,
  recordAgentUpdateStatus,
} from "@/query/agent";
import { applyAgentCertificateDeployments } from "@/query/certificate-agent";

import type { AgentWsStore } from "./agent-ws-session";

export function createAgentWsStore(database: Database = db): AgentWsStore {
  return {
    markConnected: (serverId) => markAgentWsConnected(serverId, database),
    markDisconnected: (serverId, connectedAt) =>
      markAgentWsDisconnected(serverId, connectedAt, database),
    recordHello: (serverId, hello: AgentWsHelloPayload) =>
      recordAgentHello(serverId, hello, database),
    recordConfigAck: (serverId, ack: AgentWsConfigAckPayload) =>
      recordAgentConfigAck(serverId, ack, database),
    recordUpdateStatus: (serverId, updates: AgentWsUpdateStatuses) =>
      recordAgentUpdateStatus(serverId, updates, database),
    applyCertificateDeployments: (
      serverId,
      deployments: AgentWsCertificateDeployment[],
    ) => applyAgentCertificateDeployments(serverId, deployments, database),
  };
}
