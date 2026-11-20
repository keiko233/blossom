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
