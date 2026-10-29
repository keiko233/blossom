export interface AgentStatusLike {
  enabled: boolean;
  lastSeenAt: Date | string | null;
  heartbeatIntervalSeconds: number;
  runtimeState: string;
  configState: string;
  appliedRevision: string | null;
  activeNodeIds: string[];
}

export type ServerHealth =
  | "disabled"
  | "agent_offline"
  | "runtime_error"
  | "config_error"
  | "degraded"
  | "online"
  | "unknown";

export type NodeHealth =
  | "server_disabled"
  | "disabled"
  | "agent_offline"
  | "runtime_error"
  | "config_error"
  | "serving_stale"
  | "serving"
  | "idle"
  | "unknown";

export function isAgentReachable(
  server: AgentStatusLike,
  now = Date.now(),
): boolean {
  if (!server.lastSeenAt) {
    return false;
  }
  const graceSeconds = Math.max(server.heartbeatIntervalSeconds * 3, 30);
  return now - new Date(server.lastSeenAt).getTime() < graceSeconds * 1000;
}

export function deriveServerHealth(
  server: AgentStatusLike,
  now = Date.now(),
): ServerHealth {
  if (!server.enabled) return "disabled";
  if (!isAgentReachable(server, now)) return "agent_offline";
  if (["stopped", "crash_loop"].includes(server.runtimeState)) {
    return "runtime_error";
  }
  if (["rejected", "apply_failed"].includes(server.configState)) {
    return server.runtimeState === "running" && server.appliedRevision
      ? "degraded"
      : "config_error";
  }
  if (server.runtimeState === "running" && server.configState === "applied") {
    return "online";
  }
  return "unknown";
}

export function deriveNodeHealth(
  nodeId: string,
  nodeEnabled: boolean,
  server: AgentStatusLike,
  now = Date.now(),
): NodeHealth {
  if (!server.enabled) return "server_disabled";
  if (!nodeEnabled) return "disabled";
  const serverHealth = deriveServerHealth(server, now);
  if (serverHealth === "agent_offline") return "agent_offline";
  if (serverHealth === "runtime_error") return "runtime_error";

  const active = server.activeNodeIds.includes(nodeId);
  if (["rejected", "apply_failed"].includes(server.configState)) {
    return active ? "serving_stale" : "config_error";
  }
  if (serverHealth === "online") {
    return active ? "serving" : "idle";
  }
  return "unknown";
}
