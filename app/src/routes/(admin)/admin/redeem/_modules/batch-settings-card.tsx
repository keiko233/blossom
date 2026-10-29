import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toastManager } from "@/components/ui/toast";
import { toDatetimeLocalValue } from "@/lib/format";
import {
  parseIntInRange,
  REDEEM_MODES,
  type RedeemMode,
  totalRedeemUses,
} from "@/lib/redeem-batch";
import { m } from "@/paraglide/messages";
import { listPlans, PLANS_QUERY_KEY } from "@/query/plans";
import {
  type RedeemBatchDetail,
  REDEEM_QUERY_KEY,
  updateRedeemBatch,
} from "@/query/redeem";

import { durationLabel, MODE_LABELS } from "./redeem-labels";

export interface BatchSettingsCardProps {
  batch: RedeemBatchDetail;
}

/**
 * Editable batch settings. Plan, mode and duration are only editable while
 * nothing was redeemed (the server enforces the same rule); the per-code use
 * count is fixed at creation and shown read-only. Mount with a `key` that
 * changes on save so the form re-initialises from the saved values.
 */
export function BatchSettingsCard({
  batch,
}: BatchSettingsCardProps): React.ReactElement {
  const queryClient = useQueryClient();
  const locked = batch.redemptionCount > 0;

  const [name, setName] = useState(batch.name);
  const [note, setNote] = useState(batch.note ?? "");
  const [expiresAt, setExpiresAt] = useState(
    batch.expiresAt ? toDatetimeLocalValue(batch.expiresAt) : "",
  );
  const [disabled, setDisabled] = useState(batch.disabled);
  const [perUserLimit, setPerUserLimit] = useState(String(batch.perUserLimit));
  const [planId, setPlanId] = useState(batch.planId);
  const [mode, setMode] = useState<RedeemMode>(batch.mode);
  const [durationDays, setDurationDays] = useState(
    batch.durationDays === null ? "" : String(batch.durationDays),
  );
  const [errors, setErrors] = useState<{
    name?: string;
    perUserLimit?: string;
    durationDays?: string;
  }>({});

  const { data: plans } = useQuery({
    queryKey: PLANS_QUERY_KEY,
    queryFn: () => listPlans(),
    enabled: !locked,
  });

  const mutation = useMutation({
    mutationFn: (input: Parameters<typeof updateRedeemBatch>[0]["data"]) =>
      updateRedeemBatch({ data: input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: REDEEM_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: m.admin_redeem_toast_updated(),
      });
    },
    onError: () => {
      toastManager.add({ type: "error", title: m.admin_redeem_toast_error() });
    },
  });

  const save = () => {
    const next: typeof errors = {};
    if (!name.trim()) next.name = m.admin_redeem_validation_name();
    const limit = parseIntInRange(perUserLimit, 1, 1000);
    if (limit === null) {
      next.perUserLimit = m.admin_redeem_validation_number({
        min: 1,
        max: 1000,
      });
    }
    const days = durationDays.trim()
      ? parseIntInRange(durationDays, 1, 3650)
      : null;
    if (durationDays.trim() && days === null) {
      next.durationDays = m.admin_redeem_validation_number({
        min: 1,
        max: 3650,
      });
    }
    setErrors(next);
    if (Object.keys(next).length > 0 || limit === null) return;

    mutation.mutate({
      id: batch.id,
      name: name.trim(),
      note: note.trim() || null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      disabled,
      perUserLimit: limit,
      ...(locked ? {} : { planId, mode, durationDays: days }),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.admin_redeem_settings_title()}</CardTitle>
        <CardDescription>
          {locked
            ? m.admin_redeem_settings_locked()
            : m.admin_redeem_settings_description()}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 sm:grid-cols-2"
          id="redeem-settings-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Field className="sm:col-span-2">
            <FieldLabel>{m.admin_redeem_field_name()}</FieldLabel>
            <Input value={name} onValueChange={setName} />
            {errors.name ? (
              <p className="text-xs text-destructive">{errors.name}</p>
            ) : null}
          </Field>

          <Field>
            <FieldLabel>{m.admin_redeem_field_plan()}</FieldLabel>
            {locked ? (
              <Input readOnly value={batch.planName} />
            ) : (
              <Select
                items={(plans ?? []).map((p) => ({
                  label: p.name,
                  value: p.id,
                }))}
                value={planId}
                onValueChange={(v) => v && setPlanId(v)}
              >
                <SelectTrigger>
                  <SelectValue>
                    {(v: string) =>
                      plans?.find((p) => p.id === v)?.name ?? batch.planName
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {(plans ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
          </Field>

          <Field>
            <FieldLabel>{m.admin_redeem_field_mode()}</FieldLabel>
            {locked ? (
              <Input readOnly value={MODE_LABELS[batch.mode]()} />
            ) : (
              <Select
                items={REDEEM_MODES.map((value) => ({
                  label: MODE_LABELS[value](),
                  value,
                }))}
                value={mode}
                onValueChange={(v) => v && setMode(v as RedeemMode)}
              >
                <SelectTrigger>
                  <SelectValue>
                    {(v: RedeemMode) => MODE_LABELS[v]()}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {REDEEM_MODES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {MODE_LABELS[value]()}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
          </Field>

          <Field>
            <FieldLabel>{m.admin_redeem_field_duration()}</FieldLabel>
            {locked ? (
              <Input
                readOnly
                value={durationLabel(
                  batch.durationDays,
                  batch.planDurationDays,
                )}
              />
            ) : (
              <>
                <Input
                  inputMode="numeric"
                  placeholder={m.admin_redeem_duration_plan({
                    days:
                      plans?.find((p) => p.id === planId)?.durationDays ??
                      batch.planDurationDays,
                  })}
                  value={durationDays}
                  onValueChange={setDurationDays}
                />
                <FieldDescription>
                  {m.admin_redeem_field_duration_hint()}
                </FieldDescription>
                {errors.durationDays ? (
                  <p className="text-xs text-destructive">
                    {errors.durationDays}
                  </p>
                ) : null}
              </>
            )}
          </Field>

          <Field>
            <FieldLabel>{m.admin_redeem_field_max_uses()}</FieldLabel>
            <Input readOnly value={String(batch.maxRedemptionsPerCode)} />
            <FieldDescription>
              {m.admin_redeem_field_max_uses_fixed({
                total: totalRedeemUses(
                  batch.codeCount,
                  batch.maxRedemptionsPerCode,
                ),
              })}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel>{m.admin_redeem_field_per_user()}</FieldLabel>
            <Input
              inputMode="numeric"
              value={perUserLimit}
              onValueChange={setPerUserLimit}
            />
            <FieldDescription>
              {m.admin_redeem_field_per_user_hint()}
            </FieldDescription>
            {errors.perUserLimit ? (
              <p className="text-xs text-destructive">{errors.perUserLimit}</p>
            ) : null}
          </Field>

          <Field>
            <FieldLabel>{m.admin_redeem_field_expires()}</FieldLabel>
            <Input
              type="datetime-local"
              value={expiresAt}
              onValueChange={setExpiresAt}
            />
            <FieldDescription>
              {m.admin_redeem_field_expires_hint()}
            </FieldDescription>
          </Field>

          <Field className="sm:col-span-2">
            <FieldLabel>{m.admin_redeem_field_note()}</FieldLabel>
            <Textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>

          <div className="flex flex-col gap-1 sm:col-span-2">
            <div className="flex items-center gap-3">
              <Switch checked={disabled} onCheckedChange={setDisabled} />
              <Label>{m.admin_redeem_field_disabled()}</Label>
            </div>
            <FieldDescription>
              {m.admin_redeem_field_disabled_hint()}
            </FieldDescription>
          </div>
        </form>
      </CardContent>
      <CardFooter className="justify-end">
        <Button
          form="redeem-settings-form"
          loading={mutation.isPending}
          type="submit"
        >
          {m.admin_redeem_save()}
        </Button>
      </CardFooter>
    </Card>
  );
}
