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
import { m } from "@/paraglide/messages";
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
