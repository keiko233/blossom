import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { createCallable } from "react-call";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { distributableCount, previewEffectiveNodes } from "@/lib/access-impact";
import { formatTraffic } from "@/lib/format";
import { m } from "@/paraglide/messages";
import { GROUPS_QUERY_KEY, listGroups } from "@/query/groups";
import { listNodes, NODES_QUERY_KEY } from "@/query/nodes";
import { listPlans, PLANS_QUERY_KEY } from "@/query/plans";

const EXIT_MS = 200;

/**
 * Plan picker for assigning a subscription. It runs the caller's mutation and
 * stays open with a loading state until the request finishes.
 */
export interface AssignPlanDialogProps {
  onAssign: (planId: string) => Promise<unknown>;
}

export const AssignPlanDialog = createCallable<AssignPlanDialogProps, void>(
  ({ call, onAssign }) => {
    const [planId, setPlanId] = React.useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = React.useState(false);

    const { data: plans } = useQuery({
      queryKey: PLANS_QUERY_KEY,
      queryFn: () => listPlans(),
    });

    const { data: groups } = useQuery({
      queryKey: GROUPS_QUERY_KEY,
      queryFn: () => listGroups(),
    });
    const { data: nodes } = useQuery({
      queryKey: NODES_QUERY_KEY,
      queryFn: () => listNodes(),
    });
    const selectedPlan = plans?.find((plan) => plan.id === planId);
    const preview =
      selectedPlan && groups && nodes
        ? previewEffectiveNodes({
            groupIds: selectedPlan.groupIds,
            groups,
            nodes,
          })
        : undefined;

    const submit = async () => {
      if (!planId) return;
      setIsSubmitting(true);
      try {
        await onAssign(planId);
        call.end();
      } catch {
        // The mutation reports the error. Leave the dialog open for retrying.
      } finally {
        setIsSubmitting(false);
      }
    };

    return (
      <Dialog
        open={!call.ended}
        onOpenChange={(open) => {
          if (!open && !call.ended && !isSubmitting) {
            call.end();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{m.admin_users_assign_title()}</DialogTitle>
            <DialogDescription>
              {m.admin_users_assign_description()}
            </DialogDescription>
          </DialogHeader>
          <div className="px-6">
            <Field>
              <FieldLabel>{m.admin_users_assign_field_plan()}</FieldLabel>
              <Select
                items={(plans ?? []).map((plan) => ({
                  label: plan.name,
                  value: plan.id,
                }))}
                value={planId}
                onValueChange={(next) => setPlanId(next as string | null)}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={m.admin_users_assign_field_plan_placeholder()}
                  />
                </SelectTrigger>
                <SelectPopup>
                  {(plans ?? []).map((plan) => (
                    <SelectItem key={plan.id} value={plan.id}>
                      {plan.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            {selectedPlan ? (
              <div className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground">
                <p>
                  {m.admin_access_assign_summary({
                    traffic:
                      selectedPlan.trafficBytes === 0
                        ? m.admin_plans_device_unlimited()
                        : formatTraffic(selectedPlan.trafficBytes),
                    devices:
                      selectedPlan.deviceLimit === 0
                        ? m.admin_plans_device_unlimited()
                        : selectedPlan.deviceLimit,
                    days: selectedPlan.durationDays,
                  })}
                </p>
                {selectedPlan.groupIds.length === 0 ? (
                  <p className="text-warning-foreground">
                    {m.admin_access_assign_no_groups()}
                  </p>
                ) : preview && distributableCount(preview) === 0 ? (
                  <p className="text-warning-foreground">
                    {m.admin_access_assign_no_nodes()}
                  </p>
                ) : preview ? (
                  <p>
                    {m.admin_access_assign_nodes({
                      count: distributableCount(preview),
                      attention: preview.needsAttentionCount,
                    })}
                  </p>
                ) : null}
                <p>{m.admin_access_device_not_enforced()}</p>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <DialogClose
              disabled={isSubmitting}
              render={<Button variant="ghost" />}
            >
              {m.admin_users_form_cancel()}
            </DialogClose>
            <Button
              disabled={!planId}
              loading={isSubmitting}
              onClick={() => void submit()}
            >
              {m.admin_users_assign_confirm()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  },
  EXIT_MS,
);
