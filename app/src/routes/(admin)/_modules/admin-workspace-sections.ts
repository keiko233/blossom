import { m } from "@/paraglide/messages";

import type { AdminWorkspaceSection } from "./admin-workspace-sidebar";

/** Text navigation for the Networking workspace. */
export function networkingSections(): AdminWorkspaceSection[] {
  return [
    {
      href: "/admin/networking/topology",
      label: m.admin_workspace_networking_topology(),
    },
    {
      href: "/admin/networking/links",
      label: m.admin_workspace_networking_links(),
    },
    {
      href: "/admin/networking/routing",
      label: m.admin_workspace_networking_routing(),
    },
    {
      href: "/admin/networking/rule-sets",
      label: m.admin_workspace_networking_rule_sets(),
    },
    {
      href: "/admin/networking/certificates",
      label: m.admin_nav_proxies_item_certificates(),
      prefix: "/admin/networking/certificates",
    },
  ];
}

/** Text navigation for the Access workspace. */
export function accessSections(): AdminWorkspaceSection[] {
  return [
    {
      href: "/admin/access/users",
      label: m.admin_nav_users(),
      prefix: "/admin/access/users",
    },
    {
      href: "/admin/access/plans",
      label: m.admin_nav_plans(),
      prefix: "/admin/access/plans",
    },
    {
      href: "/admin/access/subscriptions",
      label: m.admin_nav_subscriptions(),
    },
    {
      href: "/admin/access/redeem",
      label: m.admin_nav_redeem(),
      prefix: "/admin/access/redeem",
    },
    {
      href: "/admin/access/groups",
      label: m.admin_nav_proxies_item_groups(),
      prefix: "/admin/access/groups",
    },
    {
      href: "/admin/access/client-rules",
      label: m.admin_workspace_access_client_rules(),
    },
  ];
}

/** Text navigation for the Operations workspace. */
export function operationsSections(): AdminWorkspaceSection[] {
  return [
    {
      href: "/admin/operations/traffic",
      label: m.admin_traffic_nav(),
    },
    {
      href: "/admin/operations/announcements",
      label: m.admin_nav_announcements(),
    },
    {
      href: "/admin/operations/audit",
      label: m.admin_audit_nav(),
    },
    {
      href: "/admin/operations/mcp",
      label: m.admin_nav_mcp(),
    },
    {
      href: "/admin/operations/settings",
      label: m.admin_nav_settings(),
    },
  ];
}
