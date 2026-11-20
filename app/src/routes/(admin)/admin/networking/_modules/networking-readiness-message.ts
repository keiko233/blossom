import type { ManagedNetworkingReadinessReason } from "@blossom/domain/managed-networking";

import { m } from "@/paraglide/messages";

/** Localizes stable readiness codes returned by the admission service. */
export function networkingReadinessReasonMessage(
  reason: ManagedNetworkingReadinessReason,
): string {
  switch (reason) {
    case "server_disabled":
      return m.admin_networking_readiness_server_disabled();
    case "agent_offline":
      return m.admin_networking_readiness_agent_offline();
    case "capability_missing":
      return m.admin_networking_readiness_capability_missing();
    case "sing_box_version_unknown":
      return m.admin_networking_readiness_sing_box_version_unknown();
    case "sing_box_version_unsupported":
      return m.admin_networking_readiness_sing_box_version_unsupported();
    case "runtime_state_unknown":
      return m.admin_networking_readiness_runtime_unknown();
    case "runtime_not_running":
      return m.admin_networking_readiness_runtime_not_running();
    case "config_state_unknown":
      return m.admin_networking_readiness_config_unknown();
    case "config_not_applied":
      return m.admin_networking_readiness_config_not_applied();
    case "managed_state_unsettled":
      return m.admin_networking_readiness_managed_state_unsettled();
  }
}
