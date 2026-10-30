import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { InfoIcon } from "lucide-react";
import type React from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  changedSnapshotFields,
  diffEffectiveNodes,
  type PlanSnapshotField,
  type PreviewGroup,
} from "@/lib/access-impact";
import { gbToBytes } from "@/lib/format";
import { m } from "@/paraglide/messages";
import { getPlanImpact, PLANS_QUERY_KEY } from "@/query/plans";

import type { PlanFormValues, PlanWithGroups } from "./use-plan-form";

const FIELD_LABEL: Record<PlanSnapshotField, () => string> = {
  traffic: () => m.admin_access_field_traffic(),
  devices: () => m.admin_access_field_devices(),
  duration: () => m.admin_access_field_duration(),
};

export interface PlanImpactPanelProps {
  plan: PlanWithGroups;
  values: PlanFormValues;
  groups: readonly PreviewGroup[];
  nodeNames: ReadonlyMap<string, string>;
}

/**
 * What saving or deleting an existing plan reaches: the subscriptions on it,
 * which edited fields they will NOT pick up (they are snapshots), and which
 * nodes the new group list adds or removes for them. Counts are read for
 * display; the server re-checks everything when the mutation runs.
 */
export function PlanImpactPanel({
  plan,
  values,
  groups,
  nodeNames,
}: PlanImpactPanelProps): React.ReactElement {
  const { data, isPending, isError } = useQuery({
    queryKey: [...PLANS_QUERY_KEY, "impact", plan.id],
    queryFn: () => getPlanImpact({ data: { id: plan.id } }),
  });

  const snapshotChanges = changedSnapshotFields(
    {
      trafficBytes: plan.trafficBytes,
      deviceLimit: plan.deviceLimit,
      durationDays: plan.durationDays,
    },
    {
      trafficBytes: gbToBytes(values.trafficGb),
      deviceLimit: values.deviceLimit,
      durationDays: values.durationDays,
    },
  );
  const nodeChange = diffEffectiveNodes({
    beforeGroupIds: plan.groupIds,
    afterGroupIds: values.groupIds,
    groups,
  });
  const nodeLabel = (ids: string[]) =>
    ids.map((id) => nodeNames.get(id) ?? id).join(", ");
  const subscriptions = data?.subscriptionCount ?? 0;

  return (
    <section
      aria-label={m.admin_access_plan_subs_title()}
      className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs"
    >
      <h2 className="font-medium">{m.admin_access_plan_subs_title()}</h2>

      {isPending ? null : isError ? (
        <p className="text-sm text-destructive">
          {m.admin_access_impact_error()}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span>
            {subscriptions > 0
              ? m.admin_access_plan_subs_summary({
                  total: subscriptions,
                  active: data.activeSubscriptionCount,
                })
              : m.admin_access_plan_subs_none()}
          </span>
          {subscriptions > 0 ? (
            <Link
              className="underline underline-offset-4"
              search={{ plan: plan.id }}
              to="/admin/subscriptions"
            >
              {m.admin_access_view_subscriptions()}
            </Link>
          ) : null}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {m.admin_access_snapshot_note()}
      </p>

      {subscriptions > 0 && snapshotChanges.length > 0 ? (
        <Alert role="status" variant="info">
          <InfoIcon />
          <AlertDescription>
            {m.admin_access_plan_snapshot_changed({
              fields: snapshotChanges.map((f) => FIELD_LABEL[f]()).join(", "),
              count: subscriptions,
            })}
          </AlertDescription>
        </Alert>
      ) : null}

      {subscriptions > 0 &&
      (nodeChange.added.length > 0 || nodeChange.removed.length > 0) ? (
        <Alert role="status" variant="info">
          <InfoIcon />
          <AlertDescription>
            <p className="font-medium text-foreground">
              {m.admin_access_plan_groups_change_title({
                count: subscriptions,
              })}
            </p>
            {nodeChange.added.length > 0 ? (
              <p>
                {m.admin_access_group_added({
                  count: nodeChange.added.length,
                  names: nodeLabel(nodeChange.added),
                })}
              </p>
            ) : null}
            {nodeChange.removed.length > 0 ? (
              <p>
                {m.admin_access_group_removed({
                  count: nodeChange.removed.length,
                  names: nodeLabel(nodeChange.removed),
                })}
              </p>
            ) : null}
            <p>{m.admin_access_plan_groups_change_gate()}</p>
          </AlertDescription>
        </Alert>
      ) : null}

      {data ? (
        <p className="text-xs text-muted-foreground">
          {m.admin_access_plan_delete_constraints({
            batches: data.redeemBatchCount,
          })}
          {data.isTrialPlan ? ` ${m.admin_access_plan_is_trial()}` : ""}
        </p>
      ) : null}
    </section>
  );
}
