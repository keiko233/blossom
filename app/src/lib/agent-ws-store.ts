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
import type { Server } from "@/db/proxy-schema";
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
  type AgentSessionCredential,
  type AgentWsV2SessionStart,
  cacheAgentDesiredRevision,
  endAgentWsSession,
  isAgentWsSessionCurrent,
  loadCurrentAgentServer,
  markAgentWsConnected,
  promoteAgentV2WsSession,
  revalidatePendingAgentV2Session,
  startAgentV2WsSession,
  markAgentWsDisconnected,
  recordAgentConfigAck,
  recordAgentHello,
  recordAgentUpdateStatus,
  recordAgentV2ConfigAck,
  recordAgentV2Hello,
  recordAgentV2Status,
  recordAgentV2UpdateStatus,
  TrafficReportConflictError,
} from "@/query/agent";
import { applyAgentCertificateDeployments } from "@/query/certificate-agent";
import {
  loadAgentLogPolicySnapshot,
  recordAgentLogPolicyAck,
} from "@/query/log-policy";

import type { AgentWsStore } from "./agent-ws-session";
import type { AgentWsV2Store } from "./agent-ws-v2-session";

export function createAgentWsStore(database: Database = db): AgentWsStore {
  return {
    markConnected: (serverId) => markAgentWsConnected(serverId, database),
    markDisconnected: (serverId, connectedAt, sessionId) =>
      markAgentWsDisconnected(serverId, connectedAt, sessionId, database),
    recordHello: (serverId, hello: AgentWsHelloPayload) =>
      recordAgentHello(serverId, hello, database),
    recordConfigAck: (serverId, ack: AgentWsConfigAckPayload) =>
      recordAgentConfigAck(serverId, ack, database),
    recordUpdateStatus: (serverId, updates: AgentWsUpdateStatuses) =>
      recordAgentUpdateStatus(serverId, updates, database),
    applyCertificateDeployments: (
      serverId,
      deployments: AgentWsCertificateDeployment[],
    ) => applyAgentCertificateDeployments(serverId, deployments, { database }),
    handleAcmeDnsPresent: (serverId, payload: AgentWsAcmeDnsPresentPayload) =>
      handleAcmeDnsPresent(serverId, payload, database),
    handleAcmeDnsCleanup: (serverId, payload: AgentWsAcmeDnsCleanupPayload) =>
      handleAcmeDnsCleanup(serverId, payload, database),
    handleAcmeResult: (serverId, payload: AgentWsAcmeResultPayload) =>
      handleAcmeResult(serverId, payload, database),
  };
}

/** The v2 port plus the handshake that makes a new session current. */
export type AgentWsV2HubStore = AgentWsV2Store & {
  /**
   * Makes a session current only while the authenticated credential is still
   * usable. A pending OAuth identity receives a proof-only session and does
   * not own the fence until `promoteSession` accepts its `hello`.
   */
  startSession(
    serverId: string,
    credential: AgentSessionCredential,
  ): Promise<AgentWsV2SessionStart | null>;
  /**
   * Completes a pending identity's proof. A first installation is promoted
   * conditionally; a replacement demotes the old active identity and promotes
   * the new generation with recovery on both database drivers.
   */
  promoteSession(
    serverId: string,
    sessionId: string,
    credential: AgentSessionCredential,
  ): Promise<Server | null>;
};

/**
 * Binds the v2 session port to the fenced queries. Every write names the
 * session, so a replaced connection's writes match no row.
 */
export function createAgentWsV2Store(
  database: Database = db,
): AgentWsV2HubStore {
  return {
    startSession: (serverId, credential) =>
      startAgentV2WsSession(serverId, credential, database),
    promoteSession: (serverId, sessionId, credential) =>
      promoteAgentV2WsSession(serverId, sessionId, credential, database),
    loadCurrentServer: (serverId, sessionId) =>
      loadCurrentAgentServer(serverId, sessionId, database),
    recordHello: (serverId, sessionId, hello) =>
      recordAgentV2Hello(serverId, sessionId, hello, database),
    recordStatus: (serverId, sessionId, status) =>
      recordAgentV2Status(serverId, sessionId, status, database),
    recordUpdateStatus: (serverId, sessionId, updates) =>
      recordAgentV2UpdateStatus(serverId, sessionId, updates, database),
    recordConfigAck: (serverId, sessionId, ack) =>
      recordAgentV2ConfigAck(serverId, sessionId, ack, database),
    cacheDesiredRevision: (serverId, sessionId, cache) =>
      cacheAgentDesiredRevision(serverId, sessionId, cache, database),
    applyCertificateDeployments: (serverId, sessionId, deployments) =>
      applyAgentCertificateDeployments(serverId, deployments, {
        sessionId,
        database,
      }),
    revalidateSession: async (serverId, sessionId, credential, pending) => {
      if (pending) {
        return (await revalidatePendingAgentV2Session(
          serverId,
          credential,
          database,
        ))
          ? "ok"
          : "replaced";
      }
      const row = await loadCurrentAgentServer(serverId, sessionId, database);
      if (!row) {
        return "replaced";
      }
      return row.enabled ? "ok" : "disabled";
    },
    handleAcmeDnsPresent: async (serverId, sessionId, payload) => {
      if (!(await isAgentWsSessionCurrent(serverId, sessionId, database))) {
        return false;
      }
      await handleAcmeDnsPresent(serverId, payload, database);
      return true;
    },
    handleAcmeDnsCleanup: async (serverId, sessionId, payload) => {
      if (!(await isAgentWsSessionCurrent(serverId, sessionId, database))) {
        return false;
      }
      await handleAcmeDnsCleanup(serverId, payload, database);
      return true;
    },
    handleAcmeResult: async (serverId, sessionId, payload) => {
      if (!(await isAgentWsSessionCurrent(serverId, sessionId, database))) {
        return false;
      }
      await handleAcmeResult(serverId, payload, database);
      return true;
    },
    applyTraffic: async (serverId, sessionId, report) => {
      try {
        const result = await applyAgentTrafficReport(serverId, report, {
          sessionId,
          database,
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
    loadLogPolicy: (serverId, sessionId) =>
      loadAgentLogPolicySnapshot(serverId, sessionId, database),
    recordLogPolicyAck: (serverId, sessionId, ack) =>
      recordAgentLogPolicyAck(serverId, sessionId, ack, database),
    compile: async (server) => {
      const desired = await buildAgentDesiredState(server, {
        database,
        advanceCertificates: false,
      });
      return {
        desiredRevision: desired.desiredRevision,
        document: buildAgentConfigV3Output(server, desired),
        validUntil: desired.validUntil,
      };
    },
    endSession: (serverId, sessionId) =>
      endAgentWsSession(serverId, sessionId, database),
  };
}
