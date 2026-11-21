import { useQuery } from "@tanstack/react-query";
import type React from "react";

import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TrialSettings } from "@/lib/settings";
import { m } from "@/paraglide/messages";
import { listPlans, PLANS_QUERY_KEY } from "@/query/plans";

import { FieldErrors, SettingsCard, SwitchField } from "./settings-ui";
import { useSettingsSection } from "./use-settings-section";

/** Select value standing for "no plan" (Base UI selects have no empty item). */
const NO_PLAN = "__none__";

interface TrialFormValues {
  enabled: boolean;
  planId: string;
  /** Blank = use the plan's own duration. */
  durationDays: string;
}

const toForm = (values: TrialSettings): TrialFormValues => ({
  enabled: values.enabled,
  planId: values.planId ?? NO_PLAN,
  durationDays: values.durationDays === null ? "" : String(values.durationDays),
});

const toPayload = (values: TrialFormValues) => ({
  enabled: values.enabled,
  planId: values.planId === NO_PLAN ? null : values.planId,
  durationDays:
    values.durationDays.trim() === "" ? null : Number(values.durationDays),
});

export function TrialCard({
  saved,
}: {
  saved: TrialSettings;
}): React.ReactElement {
  const { form, isDirty, isSubmitting, reset } = useSettingsSection({
    section: "trial",
    saved,
    toForm,
    toPayload,
  });

  const { data: plans } = useQuery({
    queryKey: PLANS_QUERY_KEY,
    queryFn: () => listPlans(),
  });

  const planName = (id: string) =>
    id === NO_PLAN
      ? m.admin_settings_trial_plan_none()
      : (plans?.find((plan) => plan.id === id)?.name ?? id);

  return (
    <SettingsCard
      formId="settings-trial"
      title={m.admin_settings_trial_title()}
      description={m.admin_settings_trial_description()}
      isDirty={isDirty}
      isSubmitting={isSubmitting}
      onSubmit={() => void form.handleSubmit()}
      onReset={() => void reset()}
    >
      <form.Field name="enabled">
        {(field) => (
          <SwitchField
            label={m.admin_settings_trial_enabled()}
            hint={m.admin_settings_trial_enabled_hint()}
            checked={field.state.value}
            onCheckedChange={(checked) => field.handleChange(checked)}
          />
        )}
      </form.Field>

      <form.Field name="planId">
        {(field) => (
          <Field>
            <FieldLabel>{m.admin_settings_trial_plan()}</FieldLabel>
            <Select
              value={field.state.value}
              onValueChange={(value) => value && field.handleChange(value)}
            >
              <SelectTrigger>
                <SelectValue>{(value: string) => planName(value)}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={NO_PLAN}>
                  {m.admin_settings_trial_plan_none()}
                </SelectItem>
                {(plans ?? []).map((plan) => (
                  <SelectItem key={plan.id} value={plan.id}>
                    {plan.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <FieldDescription>
              {m.admin_settings_trial_plan_hint()}
            </FieldDescription>
            <FieldErrors errors={field.state.meta.errors} />
          </Field>
        )}
      </form.Field>

      <form.Field name="durationDays">
        {(field) => (
          <Field>
            <FieldLabel>{m.admin_settings_trial_duration()}</FieldLabel>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              placeholder={m.admin_settings_trial_duration_placeholder()}
              value={field.state.value}
              onValueChange={(value) => field.handleChange(value)}
              onBlur={field.handleBlur}
            />
            <FieldDescription>
              {m.admin_settings_trial_duration_hint()}
            </FieldDescription>
            <FieldErrors errors={field.state.meta.errors} />
          </Field>
        )}
      </form.Field>
    </SettingsCard>
  );
}
