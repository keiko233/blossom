import type React from "react";

import { Badge } from "@/components/ui/badge";
import { m } from "@/paraglide/messages";
import type { NetworkingRolloutPlanResult } from "@/query/networking";

import { NetworkingSection, StageRoleBadge } from "./networking-badges";
import { NetworkingIssues } from "./networking-issues";

const IMPACT_LABEL = {
  listener_change: m.admin_networking_routing_plan_listener,
  route_change: m.admin_networking_routing_plan_route,
  routing_change: m.admin_networking_routing_plan_routing,
} as const;

export function RoutingPlanPanel({
  plan,
  pending,
}: {
  plan: NetworkingRolloutPlanResult | null;
  pending: boolean;
}): React.ReactElement {
  return (
    <NetworkingSection
      title={m.admin_networking_routing_plan_title()}
      description={m.admin_networking_routing_plan_description()}
    >
      {pending ? (
        <p className="text-sm text-muted-foreground">
          {m.admin_networking_loading()}
        </p>
      ) : !plan ? (
        <p className="text-sm text-muted-foreground">
          {m.admin_networking_routing_plan_empty()}
        </p>
      ) : !plan.ok ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-destructive">
            {plan.reason === "cycle"
              ? m.admin_networking_routing_plan_cycle()
              : m.admin_networking_validation_blocked()}
          </p>
          <NetworkingIssues issues={plan.issues} />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">
              {m.admin_networking_routing_plan_stage_count({
                count: plan.stages.length,
              })}
            </Badge>
            <Badge variant="outline">
              {m.admin_networking_routing_plan_generation({
                generation: plan.topologyGeneration,
              })}
            </Badge>
            {plan.activationEnabled ? null : (
              <Badge variant="warning">
                {m.admin_networking_activation_disabled_title()}
              </Badge>
            )}
          </div>
          <ol className="flex flex-col gap-2">
            {plan.stages.map((stage) => (
              <li
                key={`${stage.ordinal}-${stage.serverId}`}
                data-slot="routing-plan-stage"
                className="flex flex-col gap-1.5 rounded-md border bg-background p-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    {stage.ordinal}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {stage.serverName}
                  </span>
                  {stage.roles.map((role) => (
                    <StageRoleBadge key={role} role={role} />
                  ))}
                </div>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>{IMPACT_LABEL[stage.processImpact]()}</span>
                  <span>
                    {m.admin_networking_routing_plan_rule_changes({
                      count: stage.changedRuleCount,
                    })}
                  </span>
                  <span>
                    {m.admin_networking_routing_plan_removals({
                      count: stage.removedRuntimeTagCount,
                    })}
                  </span>
                  {stage.probeLinkIds.length > 0 ? (
                    <span>
                      {m.admin_networking_routing_plan_probes({
                        count: stage.probeLinkIds.length,
                      })}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          <div className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-muted-foreground">
              {m.admin_networking_routing_plan_per_server()}
            </h3>
            <ul className="flex flex-col gap-1 text-xs">
              {plan.servers.map((server) => (
                <li
                  key={server.serverId}
                  className="flex flex-wrap gap-x-3 gap-y-1 rounded-md border px-2 py-1"
                >
                  <span className="font-medium">{server.serverName}</span>
                  <span>
                    {m.admin_networking_routing_diff_added()}:{" "}
                    {server.diff.addedRuleIds.length}
                  </span>
                  <span>
                    {m.admin_networking_routing_diff_removed()}:{" "}
                    {server.diff.removedRuleIds.length}
                  </span>
                  <span>
                    {m.admin_networking_routing_diff_changed()}:{" "}
                    {server.diff.changedRuleIds.length}
                  </span>
                  <span>
                    {m.admin_networking_routing_diff_peer_added()}:{" "}
                    {server.diff.peerOutboundTagsAdded.length}
                  </span>
                  <span>
                    {m.admin_networking_routing_diff_peer_removed()}:{" "}
                    {server.diff.peerOutboundTagsRemoved.length}
                  </span>
                  {server.diff.finalOutboundChanged ? (
                    <span className="text-warning-foreground">
                      {m.admin_networking_routing_diff_final_value({
                        before: server.diff.previousFinalOutboundTag,
                        after: server.diff.nextFinalOutboundTag,
                      })}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-muted-foreground">
            {m.admin_networking_routing_plan_handoff()}
          </p>
        </div>
      )}
    </NetworkingSection>
  );
}
