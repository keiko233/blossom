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
import { listPlans, PLANS_QUERY_KEY } from "@/lib/plans";
import { m } from "@/paraglide/messages";

const EXIT_MS = 200;

/**
 * Plan picker for assigning a subscription: resolves with the chosen plan id,
 * or null when dismissed. The caller runs the actual mutation so cache
 * invalidation stays on the page.
 */
export const AssignPlanDialog = createCallable<void, string | null>(
  ({ call }) => {
    const [planId, setPlanId] = React.useState<string | null>(null);

    const { data: plans } = useQuery({
      queryKey: PLANS_QUERY_KEY,
      queryFn: () => listPlans(),
    });

    return (
      <Dialog
        open={!call.ended}
        onOpenChange={(open) => {
          if (!open && !call.ended) {
            call.end(null);
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
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>
              {m.admin_users_form_cancel()}
            </DialogClose>
            <Button disabled={!planId} onClick={() => call.end(planId)}>
              {m.admin_users_assign_confirm()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  },
  EXIT_MS,
);
