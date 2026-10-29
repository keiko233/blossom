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
import { Textarea } from "@/components/ui/textarea";
import {
  MAX_USER_NOTICE_LENGTH,
  type SiteSettings,
  USER_NOTICE_LEVELS,
  type UserNoticeLevel,
} from "@/lib/settings";
import { m } from "@/paraglide/messages";

import { FieldErrors, SettingsCard, SwitchField } from "./settings-ui";
import { useSettingsSection } from "./use-settings-section";

interface SiteFormValues {
  supportUrl: string;
  supportEmail: string;
  userNotice: string;
  userNoticeLevel: UserNoticeLevel;
  maintenanceMode: boolean;
}

const toForm = (values: SiteSettings): SiteFormValues => ({
  supportUrl: values.supportUrl ?? "",
  supportEmail: values.supportEmail ?? "",
  userNotice: values.userNotice,
  userNoticeLevel: values.userNoticeLevel,
  maintenanceMode: values.maintenanceMode,
});

/** Blank support fields are sent as null by the schema's own preprocessing. */
const toPayload = (values: SiteFormValues) => ({ ...values });

const LEVEL_LABELS: Record<UserNoticeLevel, () => string> = {
  info: () => m.admin_settings_site_level_info(),
  warning: () => m.admin_settings_site_level_warning(),
};

export function SiteCard({
  saved,
}: {
  saved: SiteSettings;
}): React.ReactElement {
  const { form, isDirty, isSubmitting, reset } = useSettingsSection({
    section: "site",
    saved,
    toForm,
    toPayload,
  });

  return (
    <SettingsCard
      formId="settings-site"
      title={m.admin_settings_site_title()}
      description={m.admin_settings_site_description()}
      isDirty={isDirty}
      isSubmitting={isSubmitting}
      onSubmit={() => void form.handleSubmit()}
      onReset={() => void reset()}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <form.Field name="supportUrl">
          {(field) => (
            <Field>
              <FieldLabel>{m.admin_settings_site_support_url()}</FieldLabel>
              <Input
                type="url"
                placeholder="https://help.example.com"
                value={field.state.value}
                onValueChange={(value) => field.handleChange(value)}
                onBlur={field.handleBlur}
              />
              <FieldErrors errors={field.state.meta.errors} />
            </Field>
          )}
        </form.Field>

        <form.Field name="supportEmail">
          {(field) => (
            <Field>
              <FieldLabel>{m.admin_settings_site_support_email()}</FieldLabel>
              <Input
                type="email"
                placeholder="support@example.com"
                value={field.state.value}
                onValueChange={(value) => field.handleChange(value)}
                onBlur={field.handleBlur}
              />
              <FieldErrors errors={field.state.meta.errors} />
            </Field>
          )}
        </form.Field>
      </div>
      <FieldDescription>
        {m.admin_settings_site_support_hint()}
      </FieldDescription>

      <form.Field name="userNotice">
        {(field) => (
          <Field>
            <FieldLabel>{m.admin_settings_site_notice()}</FieldLabel>
            <Textarea
              rows={3}
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
              onBlur={field.handleBlur}
            />
            <FieldDescription>
              {m.admin_settings_site_notice_hint({
                max: MAX_USER_NOTICE_LENGTH,
              })}
            </FieldDescription>
            <FieldErrors errors={field.state.meta.errors} />
          </Field>
        )}
      </form.Field>

      <form.Field name="userNoticeLevel">
        {(field) => (
          <Field>
            <FieldLabel>{m.admin_settings_site_notice_level()}</FieldLabel>
            <Select
              value={field.state.value}
              onValueChange={(value) =>
                value && field.handleChange(value as UserNoticeLevel)
              }
            >
              <SelectTrigger>
                <SelectValue>
                  {(value: UserNoticeLevel) => LEVEL_LABELS[value]()}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {USER_NOTICE_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>
                    {LEVEL_LABELS[level]()}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
        )}
      </form.Field>

      <form.Field name="maintenanceMode">
        {(field) => (
          <SwitchField
            label={m.admin_settings_site_maintenance()}
            hint={m.admin_settings_site_maintenance_hint()}
            checked={field.state.value}
            onCheckedChange={(checked) => field.handleChange(checked)}
          />
        )}
      </form.Field>
    </SettingsCard>
  );
}
