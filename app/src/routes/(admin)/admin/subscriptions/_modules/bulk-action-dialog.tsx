import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { createCallable } from "react-call";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BulkSubscriptionActionInput } from "@/orpc/plan/schema";
import { m } from "@/paraglide/messages";
import { listPlans, PLANS_QUERY_KEY } from "@/query/plans";

const EXIT_MS = 200;

export type BulkActionKind = BulkSubscriptionActionInput["type"];

export interface BulkActionDialogProps {
  kind: BulkActionKind;
  /** Number of selected subscriptions the action will apply to. */
  count: number;
  /** Runs the mutation; the dialog stays open and loading until it settles. */
  onSubmit: (action: BulkSubscriptionActionInput) => Promise<unknown>;
}

const EXTEND_BASES = ["expiry", "now"] as const;
const BULK_STATUSES = ["active", "cancelled"] as const;

function titleFor(kind: BulkActionKind): string {
  switch (kind) {
    case "extend":
      return m.admin_subscriptions_bulk_extend_title();
    case "resetTraffic":
      return m.admin_subscriptions_bulk_reset_traffic_title();
    case "setStatus":
      return m.admin_subscriptions_bulk_status_title();
    case "changePlan":
      return m.admin_subscriptions_bulk_plan_title();
    case "delete":
      return m.admin_subscriptions_bulk_delete_title();
  }
}

function descriptionFor(kind: BulkActionKind, count: number): string {
  switch (kind) {
    case "extend":
      return m.admin_subscriptions_bulk_extend_description({ count });
    case "resetTraffic":
      return m.admin_subscriptions_bulk_reset_traffic_description({ count });
    case "setStatus":
      return m.admin_subscriptions_bulk_status_description({ count });
    case "changePlan":
      return m.admin_subscriptions_bulk_plan_description({ count });
    case "delete":
      return m.admin_subscriptions_bulk_delete_description({ count });
  }
}

function baseLabel(base: (typeof EXTEND_BASES)[number]): string {
  return base === "expiry"
    ? m.admin_subscriptions_bulk_extend_base_expiry()
    : m.admin_subscriptions_bulk_extend_base_now();
}

function statusLabel(status: (typeof BULK_STATUSES)[number]): string {
  return status === "active"
    ? m.admin_subscriptions_status_active()
    : m.admin_subscriptions_status_cancelled();
}

/**
 * Parameter form plus confirmation for one bulk action:
 * `await BulkActionDialog.call({ kind, count, onSubmit })`. Delete has no
 * parameters, so the dialog is only its confirmation.
 */
export const BulkActionDialog = createCallable<BulkActionDialogProps, void>(
  ({ call, kind, count, onSubmit }) => {
    const [days, setDays] = React.useState("30");
    const [base, setBase] =
      React.useState<(typeof EXTEND_BASES)[number]>("expiry");
    const [status, setStatus] =
      React.useState<(typeof BULK_STATUSES)[number]>("cancelled");
    const [planId, setPlanId] = React.useState<string | null>(null);
    const [resnapshot, setResnapshot] = React.useState(false);
    const [isSubmitting, setIsSubmitting] = React.useState(false);

    const { data: plans } = useQuery({
      queryKey: PLANS_QUERY_KEY,
      queryFn: () => listPlans(),
      enabled: kind === "changePlan",
    });

    const parsedDays = Number(days);
    const daysValid =
      Number.isInteger(parsedDays) && parsedDays >= 1 && parsedDays <= 3650;
    const canSubmit =
      (kind !== "extend" || daysValid) &&
      (kind !== "changePlan" || planId !== null);

    const buildAction = (): BulkSubscriptionActionInput => {
      switch (kind) {
        case "extend":
          return { type: "extend", days: parsedDays, base };
        case "resetTraffic":
          return { type: "resetTraffic" };
        case "setStatus":
          return { type: "setStatus", status };
        case "changePlan":
          return { type: "changePlan", planId: planId ?? "", resnapshot };
        case "delete":
          return { type: "delete" };
      }
    };

    const submit = async () => {
      if (!canSubmit) return;
      setIsSubmitting(true);
      try {
        await onSubmit(buildAction());
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
            <DialogTitle>{titleFor(kind)}</DialogTitle>
            <DialogDescription>{descriptionFor(kind, count)}</DialogDescription>
          </DialogHeader>

          {kind === "extend" ? (
            <div className="flex flex-col gap-3 px-6">
              <Field>
                <FieldLabel>
                  {m.admin_subscriptions_bulk_extend_field_days()}
                </FieldLabel>
                <Input
                  type="number"
                  min={1}
                  max={3650}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel>
                  {m.admin_subscriptions_bulk_extend_field_base()}
                </FieldLabel>
                <Select
                  items={EXTEND_BASES.map((option) => ({
                    label: baseLabel(option),
                    value: option,
                  }))}
                  value={base}
                  onValueChange={(next) =>
                    setBase(next as (typeof EXTEND_BASES)[number])
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {EXTEND_BASES.map((option) => (
                      <SelectItem key={option} value={option}>
                        {baseLabel(option)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            </div>
          ) : null}

          {kind === "setStatus" ? (
            <div className="flex flex-col gap-3 px-6">
              <Field>
                <FieldLabel>
                  {m.admin_subscriptions_bulk_status_field()}
                </FieldLabel>
                <Select
                  items={BULK_STATUSES.map((option) => ({
                    label: statusLabel(option),
                    value: option,
                  }))}
                  value={status}
                  onValueChange={(next) =>
                    setStatus(next as (typeof BULK_STATUSES)[number])
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {BULK_STATUSES.map((option) => (
                      <SelectItem key={option} value={option}>
                        {statusLabel(option)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            </div>
          ) : null}

          {kind === "changePlan" ? (
            <div className="flex flex-col gap-3 px-6">
              <Field>
                <FieldLabel>
                  {m.admin_subscriptions_bulk_plan_field()}
                </FieldLabel>
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
                      placeholder={m.admin_subscriptions_bulk_plan_placeholder()}
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
              <Field>
                <label className="flex items-center gap-2 text-sm font-medium">
                  <Checkbox
                    checked={resnapshot}
                    onCheckedChange={(checked) => setResnapshot(checked)}
                  />
                  {m.admin_subscriptions_bulk_plan_resnapshot()}
                </label>
                <FieldDescription>
                  {m.admin_subscriptions_bulk_plan_resnapshot_hint()}
                </FieldDescription>
              </Field>
            </div>
          ) : null}

          <DialogFooter>
            <DialogClose
              disabled={isSubmitting}
              render={<Button variant="ghost" />}
            >
              {m.admin_subscriptions_cancel()}
            </DialogClose>
            <Button
              disabled={!canSubmit}
              loading={isSubmitting}
              variant={kind === "delete" ? "destructive" : "default"}
              onClick={() => void submit()}
            >
              {kind === "delete"
                ? m.admin_subscriptions_bulk_delete_confirm()
                : m.admin_subscriptions_bulk_confirm()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  },
  EXIT_MS,
);
