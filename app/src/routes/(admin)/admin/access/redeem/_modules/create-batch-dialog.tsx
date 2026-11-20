import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
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
import { Textarea } from "@/components/ui/textarea";
import { toastManager } from "@/components/ui/toast";
import {
  parseIntInRange,
  REDEEM_CODES_PER_REQUEST_MAX,
  REDEEM_MODES,
  type RedeemMode,
} from "@/lib/redeem-batch";
import { m } from "@/paraglide/messages";
import { listPlans, PLANS_QUERY_KEY } from "@/query/plans";
import { createRedeemBatch, REDEEM_QUERY_KEY } from "@/query/redeem";

import { CodesRevealDialog } from "./codes-reveal-dialog";
import { MODE_LABELS } from "./redeem-labels";

const FORM_ID = "redeem-create-form";

export interface BatchFormValues {
  name: string;
  planId: string;
  mode: RedeemMode;
  /** Empty = the plan's duration. */
  durationDays: string;
  codeCount: string;
  maxRedemptionsPerCode: string;
  perUserLimit: string;
  /** `datetime-local` value, "" = never. */
  expiresAt: string;
  note: string;
}

const EMPTY_VALUES: BatchFormValues = {
  name: "",
  planId: "",
  mode: "new",
  durationDays: "",
  codeCount: "10",
  maxRedemptionsPerCode: "1",
  perUserLimit: "1",
  expiresAt: "",
  note: "",
};

type Errors = Partial<Record<keyof BatchFormValues, string>>;

function validate(values: BatchFormValues): Errors {
  const errors: Errors = {};
  if (!values.name.trim()) errors.name = m.admin_redeem_validation_name();
  if (!values.planId) errors.planId = m.admin_redeem_validation_plan();
  if (
    values.durationDays.trim() &&
    parseIntInRange(values.durationDays, 1, 3650) === null
  ) {
    errors.durationDays = m.admin_redeem_validation_number({
      min: 1,
      max: 3650,
    });
  }
  if (
    parseIntInRange(values.codeCount, 1, REDEEM_CODES_PER_REQUEST_MAX) === null
  ) {
    errors.codeCount = m.admin_redeem_validation_number({
      min: 1,
      max: REDEEM_CODES_PER_REQUEST_MAX,
    });
  }
  if (parseIntInRange(values.maxRedemptionsPerCode, 1, 100_000) === null) {
    errors.maxRedemptionsPerCode = m.admin_redeem_validation_number({
      min: 1,
      max: 100_000,
    });
  }
  if (parseIntInRange(values.perUserLimit, 1, 1000) === null) {
    errors.perUserLimit = m.admin_redeem_validation_number({
      min: 1,
      max: 1000,
    });
  }
  return errors;
}

function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-xs text-destructive">{message}</p> : null;
}

export interface CreateBatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Create-batch dialog. On success it closes and opens the one-time code reveal;
 * the form body mounts per open (Base UI), so each open starts empty.
 */
export function CreateBatchDialog({
  open,
  onOpenChange,
}: CreateBatchDialogProps): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <CreateBatchForm onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function CreateBatchForm({
  onDone,
}: {
  onDone: () => void;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<BatchFormValues>(EMPTY_VALUES);
  const [errors, setErrors] = useState<Errors>({});

  const { data: plans } = useQuery({
    queryKey: PLANS_QUERY_KEY,
    queryFn: () => listPlans(),
  });

  const set = <K extends keyof BatchFormValues>(
    key: K,
    value: BatchFormValues[K],
  ) => setValues((prev) => ({ ...prev, [key]: value }));

  const mutation = useMutation({
    mutationFn: () =>
      createRedeemBatch({
        data: {
          name: values.name.trim(),
          planId: values.planId,
          mode: values.mode,
          durationDays: values.durationDays.trim()
            ? Number(values.durationDays)
            : null,
          codeCount: Number(values.codeCount),
          maxRedemptionsPerCode: Number(values.maxRedemptionsPerCode),
          perUserLimit: Number(values.perUserLimit),
          expiresAt: values.expiresAt ? new Date(values.expiresAt) : null,
          note: values.note.trim() || null,
        },
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: REDEEM_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: m.admin_redeem_toast_created(),
      });
      onDone();
      // Not awaited: the reveal stays open independently of this dialog.
      void CodesRevealDialog.call({
        codes: result.codes,
        batchName: result.batch.name,
      });
    },
    onError: () => {
      toastManager.add({ type: "error", title: m.admin_redeem_toast_error() });
    },
  });

  const submit = () => {
    const next = validate(values);
    setErrors(next);
    if (Object.keys(next).length === 0) {
      mutation.mutate();
    }
  };

  const selectedPlan = plans?.find((p) => p.id === values.planId);

  return (
    <>
      <DialogHeader>
        <DialogTitle>{m.admin_redeem_create_title()}</DialogTitle>
        <DialogDescription>
          {m.admin_redeem_create_description()}
        </DialogDescription>
      </DialogHeader>

      <DialogPanel>
        <form
          id={FORM_ID}
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            submit();
          }}
        >
          <Field>
            <FieldLabel>{m.admin_redeem_field_name()}</FieldLabel>
            <Input value={values.name} onValueChange={(v) => set("name", v)} />
            <FieldError message={errors.name} />
          </Field>

          <Field>
            <FieldLabel>{m.admin_redeem_field_plan()}</FieldLabel>
            <Select
              items={(plans ?? []).map((p) => ({ label: p.name, value: p.id }))}
              value={values.planId || null}
              onValueChange={(v) => v && set("planId", v)}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={m.admin_redeem_field_plan_placeholder()}
                />
              </SelectTrigger>
              <SelectPopup>
                {(plans ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <FieldError message={errors.planId} />
          </Field>

          <Field>
            <FieldLabel>{m.admin_redeem_field_mode()}</FieldLabel>
            <Select
              items={REDEEM_MODES.map((mode) => ({
                label: MODE_LABELS[mode](),
                value: mode,
              }))}
              value={values.mode}
              onValueChange={(v) => v && set("mode", v as RedeemMode)}
            >
              <SelectTrigger>
                <SelectValue>{(v: RedeemMode) => MODE_LABELS[v]()}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {REDEEM_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {MODE_LABELS[mode]()}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <FieldDescription>
              {m.admin_redeem_field_mode_hint()}
            </FieldDescription>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>{m.admin_redeem_field_duration()}</FieldLabel>
              <Input
                inputMode="numeric"
                placeholder={
                  selectedPlan
                    ? m.admin_redeem_duration_plan({
                        days: selectedPlan.durationDays,
                      })
                    : m.admin_redeem_field_duration_placeholder()
                }
                value={values.durationDays}
                onValueChange={(v) => set("durationDays", v)}
              />
              <FieldDescription>
                {m.admin_redeem_field_duration_hint()}
              </FieldDescription>
              <FieldError message={errors.durationDays} />
            </Field>

            <Field>
              <FieldLabel>{m.admin_redeem_field_code_count()}</FieldLabel>
              <Input
                inputMode="numeric"
                value={values.codeCount}
                onValueChange={(v) => set("codeCount", v)}
              />
              <FieldDescription>
                {m.admin_redeem_field_code_count_hint({
                  max: REDEEM_CODES_PER_REQUEST_MAX,
                })}
              </FieldDescription>
              <FieldError message={errors.codeCount} />
            </Field>

            <Field>
              <FieldLabel>{m.admin_redeem_field_max_uses()}</FieldLabel>
              <Input
                inputMode="numeric"
                value={values.maxRedemptionsPerCode}
                onValueChange={(v) => set("maxRedemptionsPerCode", v)}
              />
              <FieldDescription>
                {m.admin_redeem_field_max_uses_hint()}
              </FieldDescription>
              <FieldError message={errors.maxRedemptionsPerCode} />
            </Field>

            <Field>
              <FieldLabel>{m.admin_redeem_field_per_user()}</FieldLabel>
              <Input
                inputMode="numeric"
                value={values.perUserLimit}
                onValueChange={(v) => set("perUserLimit", v)}
              />
              <FieldDescription>
                {m.admin_redeem_field_per_user_hint()}
              </FieldDescription>
              <FieldError message={errors.perUserLimit} />
            </Field>
          </div>

          <Field>
            <FieldLabel>{m.admin_redeem_field_expires()}</FieldLabel>
            <Input
              type="datetime-local"
              value={values.expiresAt}
              onValueChange={(v) => set("expiresAt", v)}
            />
            <FieldDescription>
              {m.admin_redeem_field_expires_hint()}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel>{m.admin_redeem_field_note()}</FieldLabel>
            <Textarea
              rows={3}
              value={values.note}
              onChange={(e) => set("note", e.target.value)}
            />
          </Field>
        </form>
      </DialogPanel>

      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>
          {m.admin_redeem_cancel()}
        </DialogClose>
        <Button type="submit" form={FORM_ID} loading={mutation.isPending}>
          {m.admin_redeem_create_submit()}
        </Button>
      </DialogFooter>
    </>
  );
}
