import { type NodeHealth } from "@blossom/domain/agent-status";
import type React from "react";

import { Badge } from "@/components/ui/badge";
import type {
  EntrancePublication,
  EntranceReadiness,
} from "@/lib/group-entrance-filter";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

/** Same labels and tones as the server workspace, scoped to a node row. */
export function nodeHealthLabel(health: NodeHealth): string {
  return {
    server_disabled: m.admin_proxies_nodes_status_server_disabled(),
    disabled: m.admin_proxies_nodes_status_disabled(),
    agent_offline: m.admin_proxies_nodes_status_agent_offline(),
    runtime_error: m.admin_proxies_nodes_status_runtime_error(),
    config_error: m.admin_proxies_nodes_status_config_error(),
    serving_stale: m.admin_proxies_nodes_status_serving_stale(),
    serving: m.admin_proxies_nodes_status_serving(),
    idle: m.admin_proxies_nodes_status_idle(),
    unknown: m.admin_proxies_nodes_status_unknown(),
  }[health];
}

export function nodeHealthDotClass(health: NodeHealth): string {
  if (health === "serving") return "bg-emerald-500";
  if (health === "disabled" || health === "server_disabled") {
    return "bg-muted-foreground/64";
  }
  if (health === "serving_stale" || health === "idle" || health === "unknown") {
    return "bg-amber-500";
  }
  return "bg-red-500";
}

export interface NodeHealthBadgeProps {
  health: NodeHealth;
  className?: string;
}

/**
 * Agent-reported node state. The label is never "usable" or "reachable": it
 * restates the last report and leaves client connectivity untested.
 */
export function NodeHealthBadge({
  health,
  className,
}: NodeHealthBadgeProps): React.ReactElement {
  return (
    <Badge className={className} variant="outline">
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", nodeHealthDotClass(health))}
      />
      {nodeHealthLabel(health)}
    </Badge>
  );
}

export function entranceReadinessLabel(readiness: EntranceReadiness): string {
  return {
    ready: m.admin_proxies_groups_members_readiness_ready(),
    pending: m.admin_proxies_groups_members_readiness_pending(),
    withheld: m.admin_proxies_groups_members_readiness_withheld(),
  }[readiness];
}

export function entrancePublicationLabel(
  publication: EntrancePublication,
): string {
  return {
    withheld: m.admin_proxies_groups_members_publication_withheld,
    applied: m.admin_proxies_groups_members_publication_applied,
    pending: m.admin_proxies_groups_members_publication_pending,
    unconfirmed: m.admin_proxies_groups_members_publication_unconfirmed,
  }[publication]();
}

export interface EntrancePublicationBadgeProps {
  publication: EntrancePublication;
  className?: string;
}

/** Whether the last agent report shows this entrance applied, withheld or unconfirmed. */
export function EntrancePublicationBadge({
  publication,
  className,
}: EntrancePublicationBadgeProps): React.ReactElement {
  return (
    <Badge
      className={className}
      variant={
        publication === "withheld"
          ? "destructive"
          : publication === "unconfirmed"
            ? "warning"
            : "outline"
      }
    >
      {entrancePublicationLabel(publication)}
    </Badge>
  );
}
