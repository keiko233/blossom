/**
 * Pure state helpers for the server Live tab. They stay isomorphic because the
 * same transport rules decide whether the browser may open the telemetry
 * stream and how the stream status is presented.
 */

export type ServerLiveCapability = "v1" | "v2";

export type ServerLiveState =
  | "connected"
  | "fallback"
  | "legacy"
  | "disabled"
  | "unavailable";

export type ServerLivePhase =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "paused"
  | "error";

export type ServerLiveTone =
  | "success"
  | "warning"
  | "info"
  | "danger"
  | "muted";

export interface ServerLiveStateInput {
  enabled: boolean;
  transportMode: string;
  wsConnectedAt: Date | string | null;
  agentCapabilities: readonly string[];
}

/** The highest telemetry contract the agent advertises, if any. */
export function capabilityOf(
  server: Pick<ServerLiveStateInput, "agentCapabilities">,
): ServerLiveCapability | null {
  if (server.agentCapabilities.includes("telemetry-v2")) return "v2";
  if (server.agentCapabilities.includes("telemetry-v1")) return "v1";
  return null;
}

/**
 * Whether the live stream can connect. HTTP fallback cannot stream, so it is
 * reported separately from an agent that is connected but lacks telemetry.
 */
export function liveStateOf(server: ServerLiveStateInput): ServerLiveState {
  if (!server.enabled) return "disabled";
  if (server.transportMode !== "ws" || !server.wsConnectedAt) {
    return "fallback";
  }
  return capabilityOf(server) ? "connected" : "legacy";
}

/** Percentage used by the live gauges; missing, zero and over-100 are null. */
export function usagePercent(
  used: number | null,
  total: number | null,
): number | null {
  if (used === null || total === null || total <= 0 || used > total) {
    return null;
  }
  return (100 * used) / total;
}

/** GiB pair for a gauge, or the shared missing label. */
export function formatUsage(
  used: number | null,
  total: number | null,
  format: (used: string, total: string) => string,
  missing: string,
): string {
  if (used === null || total === null) return missing;
  return format((used / 1024 ** 3).toFixed(1), (total / 1024 ** 3).toFixed(1));
}

/** Status dot tone for each stream phase. */
export function streamTone(phase: ServerLivePhase): ServerLiveTone {
  switch (phase) {
    case "connected":
      return "success";
    case "connecting":
      return "info";
    case "reconnecting":
      return "warning";
    case "error":
      return "danger";
    case "paused":
      return "muted";
    case "idle":
      return "muted";
  }
}
