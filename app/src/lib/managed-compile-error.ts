/**
 * Lightweight managed compile errors. Kept apart from the sing-box compiler so
 * the v2 session and WebSocket route can import the error classes without
 * pulling the sing-box schema or Node-only helpers into their module graph.
 */
export type ManagedCompileErrorCode =
  | "managed_intent_invalid"
  | "managed_state_inconsistent"
  | "managed_state_unavailable"
  | "unsupported_agent"
  | "missing_peer_credential"
  | "missing_peer_tls_artifact"
  | "missing_rule_set_artifact"
  | "invalid_rule_set_artifact"
  | "unsupported_peer_network"
  | "unknown_route_outbound"
  | "unknown_final_outbound"
  | "unsupported_final_outbound"
  | "snapshot_config_invalid"
  | "rule_set_asset_too_large"
  | "rule_set_aggregate_too_large"
  | "wire_cap_exceeded"
  | "preview_budget_exceeded";

/**
 * A typed compile refusal. `fallbackRevision` lets a v2 session advertise the
 * server's last issued identifier without compiling a legacy payload, so an
 * unsupported agent keeps its last-known-good state instead of overwriting
 * managed listeners. Task 08 owns rollout recovery after such a refusal.
 */
export class ManagedCompileError extends Error {
  constructor(
    readonly code: ManagedCompileErrorCode,
    message: string,
    readonly fallbackRevision?: string,
    readonly desiredRevisionSeq?: number,
  ) {
    super(message);
    this.name = "ManagedCompileError";
  }
}

/**
 * Legacy HTTP/v1 delivery is refused while a server has managed desired or
 * last-known-good state. Carry a stable message so the route can return 409.
 */
export class ManagedNetworkingRequiresV2Error extends Error {
  constructor() {
    super(
      "Managed networking requires the blossom-agent.v2 subprotocol; legacy config delivery is disabled for this server",
    );
    this.name = "ManagedNetworkingRequiresV2Error";
  }
}
