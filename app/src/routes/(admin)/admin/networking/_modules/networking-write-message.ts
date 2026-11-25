import { m } from "@/paraglide/messages";

/** Localizes the stable write/draft failure codes returned by the server. */
export function networkingWriteReasonMessage(reason: string): string {
  switch (reason) {
    case "activation_disabled":
      return m.admin_networking_issue_activation_disabled();
    case "certificate_not_found":
      return m.admin_networking_issue_certificate_missing({ certificate: "" });
    case "asset_too_large":
      return m.admin_networking_write_asset_too_large();
    case "invalid_asset":
      return m.admin_networking_write_invalid_asset();
    case "credential_key_unavailable":
      return m.admin_networking_write_credential_key_unavailable();
    case "duplicate":
      return m.admin_networking_write_duplicate();
    case "duplicate_rule_set":
      return m.admin_networking_write_duplicate_rule_set();
    case "upstream_unavailable":
      return m.admin_networking_write_upstream_unavailable();
    case "upstream_not_found":
      return m.admin_networking_write_upstream_not_found();
    case "upstream_rate_limited":
      return m.admin_networking_write_upstream_rate_limited();
    case "upstream_invalid_asset":
      return m.admin_networking_write_upstream_invalid_asset();
    case "invalid_link":
      return m.admin_networking_write_invalid_link();
    case "not_found":
      return m.admin_networking_write_not_found();
    case "peer_port_conflict":
      return m.admin_networking_issue_peer_port_conflict();
    case "referenced":
      return m.admin_networking_issue_referenced_resource();
    case "stale_topology":
      return m.admin_networking_issue_stale_topology();
    case "topology_conflict":
      return m.admin_networking_issue_topology_conflict();
    case "unsupported":
      return m.admin_networking_write_unsupported();
    default:
      return m.admin_networking_write_failed();
  }
}

/** Localizes Retry/Abort result reasons from the audited rollout adapter. */
export function networkingRolloutReasonMessage(reason: string): string {
  switch (reason) {
    case "activation_disabled":
      return m.admin_networking_rollout_reason_activation_disabled();
    case "not_retryable":
      return m.admin_networking_rollout_reason_not_retryable();
    case "paused":
      return m.admin_networking_rollout_reason_paused();
    case "rollout_not_found":
      return m.admin_networking_rollout_reason_rollout_not_found();
    case "rollout_inactive":
      return m.admin_networking_rollout_reason_rollout_inactive();
    case "already_recovering":
      return m.admin_networking_rollout_reason_already_recovering();
    case "stage_conflict":
      return m.admin_networking_rollout_reason_stage_conflict();
    case "topology_conflict":
      return m.admin_networking_rollout_reason_topology_conflict();
    case "probe_stage_not_confirmed":
      return m.admin_networking_rollout_reason_probe_stage_not_confirmed();
    case "probe_link_mismatch":
      return m.admin_networking_rollout_reason_probe_link_mismatch();
    case "probe_destination_missing":
      return m.admin_networking_rollout_reason_probe_destination_missing();
    case "probe_credential_missing":
      return m.admin_networking_rollout_reason_probe_credential_missing();
    case "probe_capability_missing":
      return m.admin_networking_rollout_reason_probe_capability_missing();
    default:
      return m.admin_networking_rollout_toast_action_failed();
  }
}

/** Localizes the audited Apply admission result before any stage is issued. */
export function networkingApplyReasonMessage(reason: string): string {
  switch (reason) {
    case "activation_disabled":
      return m.admin_networking_issue_activation_disabled();
    case "validation":
      return m.admin_networking_validation_blocked();
    case "cycle":
      return m.admin_networking_routing_plan_cycle();
    case "readiness":
      return m.admin_networking_apply_readiness_blocked();
    case "budget":
      return m.admin_networking_apply_budget_blocked();
    case "topology_conflict":
      return m.admin_networking_apply_conflict();
    case "claim_conflict":
      return m.admin_networking_apply_claim_conflict();
    case "config_version_conflict":
      return m.admin_networking_apply_config_version_conflict();
    case "state_conflict":
      return m.admin_networking_apply_revision_conflict();
    case "rollout_exists":
      return m.admin_networking_apply_rollout_exists();
    case "invalid_admission":
    default:
      return m.admin_networking_apply_failed();
  }
}
