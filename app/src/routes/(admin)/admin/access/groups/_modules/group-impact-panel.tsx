import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { InfoIcon } from "lucide-react";
import type React from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { diffSelection, isGroupUnused } from "@/lib/access-impact";
import { m } from "@/paraglide/messages";
import { getGroupImpact, GROUPS_QUERY_KEY } from "@/query/groups";

export interface GroupImpactPanelProps {
  groupId: string;
  /** Members as saved. */
  savedNodeIds: readonly string[];
  /** Members as currently selected in the form. */
  selectedNodeIds: readonly string[];
  nodeNames: ReadonlyMap<string, string>;
}

function names(
  ids: readonly string[],
  nodeNames: ReadonlyMap<string, string>,
): string {
  return ids.map((id) => nodeNames.get(id) ?? id).join(", ");
}

/**
 * What an edit of an existing group reaches: the plans (and their
 * subscriptions) that bind it, and the effect of the unsaved membership
 * change. The numbers are read from the server for display only; saving does
 * not depend on them and the server decides the outcome.
 */
export function GroupImpactPanel({
  groupId,
  savedNodeIds,
  selectedNodeIds,
  nodeNames,
}: GroupImpactPanelProps): React.ReactElement {
  const { data, isPending, isError } = useQuery({
    queryKey: [...GROUPS_QUERY_KEY, "impact", groupId],
    queryFn: () => getGroupImpact({ data: { id: groupId } }),
  });
  const change = diffSelection(savedNodeIds, selectedNodeIds);

  return (
    <section
      aria-label={m.admin_access_group_used_title()}
      className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs"
    >
      <h2 className="font-medium">{m.admin_access_group_used_title()}</h2>

      {isPending ? (
        <div className="flex justify-center py-2">
          <Spinner />
        </div>
      ) : isError ? (
        <p className="text-sm text-destructive">
          {m.admin_access_impact_error()}
        </p>
      ) : isGroupUnused(data) ? (
        <p className="text-sm text-muted-foreground">
          {m.admin_access_group_unused()}{" "}
          <Link
            className="underline underline-offset-4"
            to="/admin/access/plans/new"
          >
            {m.admin_access_group_unused_action()}
          </Link>
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {m.admin_access_group_used_summary({
              plans: data.plans.length,
              subscriptions: data.subscriptionCount,
            })}
          </p>
          <ul className="flex flex-col gap-1">
            {data.plans.map((plan) => (
              <li key={plan.id} className="flex items-center gap-2 text-sm">
                <Link
                  className="font-medium underline-offset-4 hover:underline"
                  params={{ planId: plan.id }}
                  to="/admin/access/plans/$planId"
                >
                  {plan.name}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {m.admin_access_group_used_plan_subscriptions({
                    count: plan.subscriptionCount,
                  })}
                </span>
                {plan.subscriptionCount > 0 ? (
                  <Link
                    className="text-xs underline underline-offset-4"
                    search={{ plan: plan.id }}
                    to="/admin/access/subscriptions"
                  >
                    {m.admin_access_view_subscriptions()}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}

      {change.added.length > 0 || change.removed.length > 0 ? (
        <Alert role="status" variant="info">
          <InfoIcon />
          <AlertDescription>
            <p className="font-medium text-foreground">
              {m.admin_access_group_change_title()}
            </p>
            {change.added.length > 0 ? (
              <p>
                {m.admin_access_group_added({
                  count: change.added.length,
                  names: names(change.added, nodeNames),
                })}
              </p>
            ) : null}
            {change.removed.length > 0 ? (
              <p>
                {m.admin_access_group_removed({
                  count: change.removed.length,
                  names: names(change.removed, nodeNames),
                })}
              </p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
