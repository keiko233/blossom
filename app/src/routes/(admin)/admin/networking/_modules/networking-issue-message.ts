import type { NetworkingIssue } from "@/lib/networking-schema";
import { m } from "@/paraglide/messages";

/**
 * Stable issue-code to Paraglide message mapping. Subject values are ids and
 * labels only; credential material never reaches this layer.
 */
export function networkingIssueMessage(issue: NetworkingIssue): string {
  switch (issue.code) {
    case "activation_disabled":
      return m.admin_networking_issue_activation_disabled();
    case "certificate_missing":
      return m.admin_networking_issue_certificate_missing({
        certificate: String(issue.params?.certificate ?? ""),
      });
    case "certificate_material_missing":
      return m.admin_networking_issue_certificate_material_missing({
        certificate: String(issue.params?.certificate ?? ""),
      });
    case "certificate_generation_missing":
      return m.admin_networking_issue_certificate_generation_missing();
    case "credential_missing":
      return m.admin_networking_issue_credential_missing({
        link: String(issue.params?.link ?? ""),
      });
    case "duplicate_link":
      return m.admin_networking_issue_duplicate_link();
    case "duplicate_rule_id":
      return m.admin_networking_issue_duplicate_rule_id({
        rule: String(issue.params?.rule ?? issue.subjectId ?? ""),
      });
    case "empty_rule_scope":
      return m.admin_networking_issue_empty_rule_scope();
    case "final_outbound_is_peer":
      return m.admin_networking_issue_final_outbound_is_peer();
    case "inbound_not_found":
      return m.admin_networking_issue_inbound_not_found({
        tag: String(issue.params?.tag ?? ""),
      });
    case "link_not_found":
      return m.admin_networking_issue_link_not_found({
        link: String(issue.params?.link ?? ""),
      });
    case "no_outbounds":
      return m.admin_networking_issue_no_outbounds();
    case "outbound_not_found":
      return m.admin_networking_issue_outbound_not_found({
        tag: String(issue.params?.tag ?? ""),
      });
    case "peer_inbound_not_found":
      return m.admin_networking_issue_peer_inbound_not_found();
    case "peer_port_conflict":
      return m.admin_networking_issue_peer_port_conflict();
    case "referenced_resource":
      return m.admin_networking_issue_referenced_resource();
    case "rule_set_not_found":
      return m.admin_networking_issue_rule_set_not_found({
        ruleSet: String(issue.params?.ruleSet ?? ""),
      });
    case "stale_topology":
      return m.admin_networking_issue_stale_topology();
    case "topology_conflict":
      return m.admin_networking_issue_topology_conflict();
    case "udp_peer_route":
      return m.admin_networking_issue_udp_peer_route();
    case "unknown_final_outbound":
      return m.admin_networking_issue_unknown_final_outbound({
        tag: String(issue.params?.tag ?? ""),
      });
    case "unknown_outbound":
      return m.admin_networking_issue_unknown_outbound();
    case "unknown_rule_set":
      return m.admin_networking_issue_unknown_rule_set({
        tag: String(issue.params?.tag ?? ""),
      });
    case "unresolved_destination_ip":
      return m.admin_networking_issue_unresolved_destination_ip();
    case "shadowed_rule":
      return m.admin_networking_issue_shadowed_rule({
        rule: String(issue.params?.rule ?? ""),
        earlier: String(issue.params?.earlier ?? ""),
      });
  }
}
