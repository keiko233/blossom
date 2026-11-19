import type { AdminLogsActor } from "@/query/log-audit";

/**
 * Everything a runtime needs to accept an admin log WebSocket and bind it to
 * one server and one current agent session. The browser cookie and bearer
 * token are deliberately absent: the relay keeps only the admin session row id
 * for its later authority checks.
 */
export interface AdminLogsAcceptContext {
  serverId: string;
  serverName: string;
  /** The server's current v2 agent session at admission time. */
  agentSessionId: string;
  /** better-auth session row id; never the cookie or token. */
  authSessionId: string;
  relayId: string;
  actor: AdminLogsActor;
  startedAt: Date;
}

/** Agent frames (or loss of the agent) addressed to one admin relay. */
export type AgentLogRelayEvent =
  | { type: "frame"; frame: string }
  | { type: "agentGone"; reason: "agent_disconnected" | "session_replaced" };

export type AgentLogRelayHandler = (event: AgentLogRelayEvent) => void;
