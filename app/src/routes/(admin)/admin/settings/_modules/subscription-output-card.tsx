import type React from "react";

import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { SubscriptionOutputSettings } from "@/lib/settings";
import { m } from "@/paraglide/messages";

import { FieldErrors, SettingsCard, SwitchField } from "./settings-ui";
import { useSettingsSection } from "./use-settings-section";

interface OutputFormValues {
  profileTitle: string;
  profileUpdateIntervalHours: string;
  urlTestUrl: string;
  urlTestIntervalSeconds: string;
  mixedPort: string;
  allowLan: boolean;
  ruleLanDirect: boolean;
  ruleCnDirect: boolean;
}

const toForm = (values: SubscriptionOutputSettings): OutputFormValues => ({
  profileTitle: values.profileTitle,
  profileUpdateIntervalHours: String(values.profileUpdateIntervalHours),
  urlTestUrl: values.urlTestUrl,
  urlTestIntervalSeconds: String(values.urlTestIntervalSeconds),
  mixedPort: String(values.mixedPort),
  allowLan: values.allowLan,
  ruleLanDirect: values.ruleLanDirect,
  ruleCnDirect: values.ruleCnDirect,
});

/** `Number("")` is 0, which the range checks then reject with a message. */
const toPayload = (values: OutputFormValues) => ({
  profileTitle: values.profileTitle,
  profileUpdateIntervalHours: Number(values.profileUpdateIntervalHours),
  urlTestUrl: values.urlTestUrl,
  urlTestIntervalSeconds: Number(values.urlTestIntervalSeconds),
  mixedPort: Number(values.mixedPort),
  allowLan: values.allowLan,
  ruleLanDirect: values.ruleLanDirect,
  ruleCnDirect: values.ruleCnDirect,
});

type TextFieldName =
  | "profileTitle"
  | "profileUpdateIntervalHours"
  | "urlTestUrl"
  | "urlTestIntervalSeconds"
  | "mixedPort";

export function SubscriptionOutputCard({
  saved,
}: {
  saved: SubscriptionOutputSettings;
}): React.ReactElement {
  const { form, isDirty, isSubmitting, reset } = useSettingsSection({
    section: "subscription_output",
    saved,
    toForm,
    toPayload,
  });

  const textField = (
    name: TextFieldName,
    label: string,
    hint: string,
    type: "text" | "number" = "text",
  ) => (
    <form.Field name={name}>
      {(field) => (
        <Field>
          <FieldLabel>{label}</FieldLabel>
          <Input
            type={type}
            inputMode={type === "number" ? "numeric" : undefined}
            value={field.state.value}
            onValueChange={(value) => field.handleChange(value)}
            onBlur={field.handleBlur}
          />
          <FieldDescription>{hint}</FieldDescription>
          <FieldErrors errors={field.state.meta.errors} />
        </Field>
      )}
    </form.Field>
  );

  return (
    <SettingsCard
      formId="settings-subscription-output"
      title={m.admin_settings_output_title()}
      description={m.admin_settings_output_description()}
      isDirty={isDirty}
      isSubmitting={isSubmitting}
      onSubmit={() => void form.handleSubmit()}
      onReset={() => void reset()}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {textField(
          "profileTitle",
          m.admin_settings_output_profile_title(),
          m.admin_settings_output_profile_title_hint(),
        )}
        {textField(
          "profileUpdateIntervalHours",
          m.admin_settings_output_update_interval(),
          m.admin_settings_output_update_interval_hint(),
          "number",
        )}
        {textField(
          "urlTestUrl",
          m.admin_settings_output_test_url(),
          m.admin_settings_output_test_url_hint(),
        )}
        {textField(
          "urlTestIntervalSeconds",
          m.admin_settings_output_test_interval(),
          m.admin_settings_output_test_interval_hint(),
          "number",
        )}
        {textField(
          "mixedPort",
          m.admin_settings_output_mixed_port(),
          m.admin_settings_output_mixed_port_hint(),
          "number",
        )}
      </div>

      <form.Field name="allowLan">
        {(field) => (
          <SwitchField
            label={m.admin_settings_output_allow_lan()}
            hint={m.admin_settings_output_allow_lan_hint()}
            checked={field.state.value}
            onCheckedChange={(checked) => field.handleChange(checked)}
          />
        )}
      </form.Field>

      <div className="flex flex-col gap-3 rounded-lg border p-3">
        <p className="text-sm font-medium">
          {m.admin_settings_output_rules_title()}
        </p>
        <form.Field name="ruleLanDirect">
          {(field) => (
            <SwitchField
              label={m.admin_settings_output_rule_lan()}
              hint="GEOIP,LAN,DIRECT,no-resolve"
              checked={field.state.value}
              onCheckedChange={(checked) => field.handleChange(checked)}
            />
          )}
        </form.Field>
        <form.Field name="ruleCnDirect">
          {(field) => (
            <SwitchField
              label={m.admin_settings_output_rule_cn()}
              hint="GEOIP,CN,DIRECT"
              checked={field.state.value}
              onCheckedChange={(checked) => field.handleChange(checked)}
            />
          )}
        </form.Field>
        <p className="text-xs text-muted-foreground">
          {m.admin_settings_output_rules_match()}
        </p>
      </div>
    </SettingsCard>
  );
}
