import {
  createAgentWsFrame,
  encodeAgentWsFrame,
  parseAgentWsFrame,
  type AgentWsAcmeDnsCleanupPayload,
  type AgentWsAcmeDnsPresentPayload,
  type AgentWsAcmeResultPayload,
  type AgentWsCertificateDeployment,
  type AgentWsConfigAckPayload,
  type AgentWsHelloPayload,
  type AgentWsUpdateStatuses,
  type AgentWsWelcomePayload,
} from "@blossom/contracts/agent-ws";
import { randomUUID } from "node:crypto";

export interface AgentWsPeer {
  send(data: string): unknown;
}

/** The identity of one WebSocket handshake. */
export interface AgentWsConnection {
  connectedAt: Date;
  sessionId: string;
}

/**
 * Narrow persistence port so the protocol state machine is testable without a
 * database or a WebSocket adapter.
 */
export interface AgentWsStore {
  markConnected(serverId: string): Promise<AgentWsConnection>;
  markDisconnected(serverId: string, sessionId: string): Promise<void>;
  recordHello(serverId: string, hello: AgentWsHelloPayload): Promise<void>;
  recordConfigAck(
    serverId: string,
    ack: AgentWsConfigAckPayload,
  ): Promise<void>;
  recordUpdateStatus(
    serverId: string,
    updates: AgentWsUpdateStatuses,
  ): Promise<void>;
  applyCertificateDeployments(
    serverId: string,
    deployments: AgentWsCertificateDeployment[],
  ): Promise<void>;
  handleAcmeDnsPresent(
    serverId: string,
    payload: AgentWsAcmeDnsPresentPayload,
  ): Promise<void>;
  handleAcmeDnsCleanup(
    serverId: string,
    payload: AgentWsAcmeDnsCleanupPayload,
  ): Promise<void>;
  handleAcmeResult(
    serverId: string,
    payload: AgentWsAcmeResultPayload,
  ): Promise<void>;
}

export interface AgentWsSession {
  serverId: string;
  welcome: AgentWsWelcomePayload;
  connectedAt: Date;
  sessionId: string;
  store: AgentWsStore;
  welcomeSent: boolean;
}

export interface OpenAgentWsSessionOptions {
  serverId: string;
  welcome: AgentWsWelcomePayload;
  store: AgentWsStore;
  /** Pre-recorded by a transport adapter that must persist before upgrading. */
  session?: AgentWsConnection;
}

function logFailure(operation: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`agent websocket ${operation} failed: ${message}`);
}

export async function openAgentWsSession(
  options: OpenAgentWsSessionOptions,
): Promise<AgentWsSession> {
  let session = options.session;
  if (!session) {
    try {
      session = await options.store.markConnected(options.serverId);
    } catch (error) {
      logFailure("connect", error);
      session = { connectedAt: new Date(), sessionId: randomUUID() };
    }
  }
  return {
    serverId: options.serverId,
    welcome: options.welcome,
    connectedAt: session.connectedAt,
    sessionId: session.sessionId,
    store: options.store,
    welcomeSent: false,
  };
}

async function sendWelcome(
  session: AgentWsSession,
  peer: AgentWsPeer,
): Promise<void> {
  const frame = createAgentWsFrame("welcome", session.welcome);
  peer.send(encodeAgentWsFrame(frame));
  session.welcomeSent = true;
}

async function handleHello(
  session: AgentWsSession,
  peer: AgentWsPeer,
  hello: AgentWsHelloPayload,
): Promise<void> {
  try {
    await session.store.recordHello(session.serverId, hello);
  } catch (error) {
    logFailure("hello", error);
  }

  if (hello.certificateDeployments.length > 0) {
    try {
      await session.store.applyCertificateDeployments(
        session.serverId,
        hello.certificateDeployments,
      );
    } catch (error) {
      logFailure("certificate deployments", error);
    }
  }

  await sendWelcome(session, peer);
}

async function handleConfigAck(
  session: AgentWsSession,
  ack: AgentWsConfigAckPayload,
): Promise<void> {
  try {
    await session.store.recordConfigAck(session.serverId, ack);
  } catch (error) {
    logFailure("config ack", error);
  }

  if (ack.certificateDeployments && ack.certificateDeployments.length > 0) {
    try {
      await session.store.applyCertificateDeployments(
        session.serverId,
        ack.certificateDeployments,
      );
    } catch (error) {
      logFailure("certificate deployments", error);
    }
  }
}

export async function handleAgentWsMessage(
  session: AgentWsSession,
  peer: AgentWsPeer,
  text: string,
): Promise<void> {
  const parsed = parseAgentWsFrame(text);
  if (!parsed.ok) {
    if (parsed.code !== "invalid-json") {
      console.warn(
        `ignoring malformed agent websocket frame${parsed.type ? ` ${parsed.type}` : ""}: ${parsed.code}`,
      );
    }
    return;
  }

  const { frame, message } = parsed;
  switch (message.kind) {
    case "hello":
      await handleHello(session, peer, message.payload);
      return;
    case "config.ack":
      await handleConfigAck(session, message.payload);
      return;
    case "update.status":
      try {
        await session.store.recordUpdateStatus(
          session.serverId,
          message.payload,
        );
      } catch (error) {
        logFailure("update status", error);
      }
      return;
    case "acme.dns_present":
      try {
        await session.store.handleAcmeDnsPresent(
          session.serverId,
          message.payload,
        );
      } catch (error) {
        logFailure("acme dns present", error);
      }
      return;
    case "acme.dns_cleanup":
      try {
        await session.store.handleAcmeDnsCleanup(
          session.serverId,
          message.payload,
        );
      } catch (error) {
        logFailure("acme dns cleanup", error);
      }
      return;
    case "acme.result":
      try {
        await session.store.handleAcmeResult(session.serverId, message.payload);
      } catch (error) {
        logFailure("acme result", error);
      }
      return;
    case "ping": {
      const options = frame.id ? { id: frame.id } : {};
      const pong = createAgentWsFrame("pong", message.payload, options);
      peer.send(encodeAgentWsFrame(pong));
      return;
    }
    case "pong":
    case "welcome":
    case "config.notify":
    case "update.trigger":
    case "acme.issue":
    case "acme.dns_ack":
    case "reserved":
    case "unknown":
      return;
  }
}

export async function closeAgentWsSession(
  session: AgentWsSession,
): Promise<void> {
  try {
    await session.store.markDisconnected(session.serverId, session.sessionId);
  } catch (error) {
    logFailure("disconnect", error);
  }
}
