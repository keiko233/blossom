import type React from "react";

import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { RegistrationSettings } from "@/lib/settings";
import { m } from "@/paraglide/messages";

import { FieldErrors, SettingsCard, SwitchField } from "./settings-ui";
import { useSettingsSection } from "./use-settings-section";

interface RegistrationFormValues {
  mode: RegistrationSettings["mode"];
  /** One pattern per line (commas and spaces also separate). */
  allowedEmailDomains: string;
  requireEmailVerification: boolean;
}

const toForm = (values: RegistrationSettings): RegistrationFormValues => ({
  mode: values.mode,
  allowedEmailDomains: values.allowedEmailDomains.join("\n"),
  requireEmailVerification: values.requireEmailVerification,
});

const toPayload = (values: RegistrationFormValues) => ({
  mode: values.mode,
  allowedEmailDomains: values.allowedEmailDomains
    .split(/[\s,;]+/)
    .filter(Boolean),
  requireEmailVerification: values.requireEmailVerification,
});

const MODE_LABELS: Record<RegistrationSettings["mode"], () => string> = {
  open: () => m.admin_settings_registration_mode_open(),
  closed: () => m.admin_settings_registration_mode_closed(),
};

export function RegistrationCard({
  saved,
}: {
  saved: RegistrationSettings;
}): React.ReactElement {
  const { form, isDirty, isSubmitting, reset } = useSettingsSection({
    section: "registration",
    saved,
    toForm,
    toPayload,
  });

  return (
    <SettingsCard
      formId="settings-registration"
      title={m.admin_settings_registration_title()}
      description={m.admin_settings_registration_description()}
      isDirty={isDirty}
      isSubmitting={isSubmitting}
      onSubmit={() => void form.handleSubmit()}
      onReset={() => void reset()}
    >
      <form.Field name="mode">
        {(field) => (
          <Field>
            <FieldLabel>{m.admin_settings_registration_mode()}</FieldLabel>
            <Select
              value={field.state.value}
              onValueChange={(value) =>
                value &&
                field.handleChange(value as RegistrationFormValues["mode"])
              }
            >
              <SelectTrigger>
                <SelectValue>
                  {(value: RegistrationSettings["mode"]) =>
                    MODE_LABELS[value]()
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {(["open", "closed"] as const).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {MODE_LABELS[mode]()}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <FieldDescription>
              {m.admin_settings_registration_mode_hint()}
            </FieldDescription>
          </Field>
        )}
      </form.Field>

      <form.Field name="allowedEmailDomains">
        {(field) => (
          <Field>
            <FieldLabel>{m.admin_settings_registration_domains()}</FieldLabel>
            <Textarea
              rows={4}
              placeholder={"example.com\n*.university.edu"}
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
              onBlur={field.handleBlur}
            />
            <FieldDescription>
              {m.admin_settings_registration_domains_hint()}
            </FieldDescription>
            <FieldErrors errors={field.state.meta.errors} />
          </Field>
        )}
      </form.Field>

      <form.Field name="requireEmailVerification">
        {(field) => (
          <SwitchField
            label={m.admin_settings_registration_verify()}
            hint={m.admin_settings_registration_verify_hint()}
            checked={field.state.value}
            onCheckedChange={(checked) => field.handleChange(checked)}
          />
        )}
      </form.Field>
    </SettingsCard>
  );
}
