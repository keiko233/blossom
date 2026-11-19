import type {
  AgentWsAcmeDnsCleanupPayload,
  AgentWsAcmeDnsPresentPayload,
  AgentWsAcmeResultPayload,
  AgentWsCertificateDeployment,
  AgentWsConfigAckPayload,
  AgentWsHelloPayload,
  AgentWsUpdateStatuses,
} from "@blossom/contracts/agent-ws";

import { type Database, db } from "@/db";
import {
  handleAcmeDnsCleanup,
  handleAcmeDnsPresent,
  handleAcmeResult,
} from "@/lib/certificate-issuance";
import {
  buildAgentConfigV3Output,
  buildAgentDesiredState,
} from "@/orpc/proxy/agent-desired-state";
import { applyAgentTrafficReport } from "@/orpc/proxy/agent-traffic-report";
import {
  AgentSessionReplacedError,
  cacheAgentDesiredRevision,
  endAgentWsSession,
  loadAgentServer,
  markAgentWsConnected,
  markAgentWsDisconnected,
  recordAgentConfigAck,
  recordAgentHello,
  recordAgentUpdateStatus,
  recordAgentV2ConfigAck,
  recordAgentV2Hello,
  recordAgentV2Status,
  TrafficReportConflictError,
} from "@/query/agent";
import { applyAgentCertificateDeployments } from "@/query/certificate-agent";

import type { AgentWsStore } from "./agent-ws-session";
import type { AgentWsV2Store } from "./agent-ws-v2-session";

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
    handleAcmeDnsPresent: (serverId, payload: AgentWsAcmeDnsPresentPayload) =>
      handleAcmeDnsPresent(serverId, payload, database),
    handleAcmeDnsCleanup: (serverId, payload: AgentWsAcmeDnsCleanupPayload) =>
      handleAcmeDnsCleanup(serverId, payload, database),
    handleAcmeResult: (serverId, payload: AgentWsAcmeResultPayload) =>
      handleAcmeResult(serverId, payload, database),
  };
}

/**
 * Binds the v2 session port to the fenced queries. Every write names the
 * session, so a replaced connection's writes match no row.
 */
export function createAgentWsV2Store(database: Database = db): AgentWsV2Store {
  return {
    loadServer: (serverId) => loadAgentServer(serverId, database),
    recordHello: (serverId, sessionId, hello) =>
      recordAgentV2Hello(serverId, sessionId, hello, database),
    recordStatus: (serverId, sessionId, status) =>
      recordAgentV2Status(serverId, sessionId, status, database),
    recordConfigAck: (serverId, sessionId, ack) =>
      recordAgentV2ConfigAck(serverId, sessionId, ack, database),
    cacheDesiredRevision: (serverId, sessionId, seq, revision) =>
      cacheAgentDesiredRevision(serverId, sessionId, seq, revision, database),
    applyCertificateDeployments: (serverId, deployments) =>
      applyAgentCertificateDeployments(serverId, deployments, database),
    applyTraffic: async (serverId, sessionId, report) => {
      try {
        const result = await applyAgentTrafficReport(serverId, report, {
          sessionId,
        });
        return {
          status:
            "duplicate" in result && result.duplicate ? "duplicate" : "applied",
          accepted: result.accepted,
          dropped: result.dropped,
        };
      } catch (error) {
        if (error instanceof AgentSessionReplacedError) {
          return { status: "replaced" };
        }
        if (error instanceof TrafficReportConflictError) {
          return { status: "conflict", message: error.message };
        }
        throw error;
      }
    },
    compile: async (server) => {
      const desired = await buildAgentDesiredState(server);
      return {
        desiredRevision: desired.desiredRevision,
        document: buildAgentConfigV3Output(server, desired),
      };
    },
    endSession: (serverId, sessionId) =>
      endAgentWsSession(serverId, sessionId, database),
  };
}
