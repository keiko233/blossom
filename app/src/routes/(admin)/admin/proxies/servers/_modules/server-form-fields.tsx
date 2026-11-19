import type React from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import { Switch } from "@/components/ui/switch";
import { m } from "@/paraglide/messages";

import type { ServerForm } from "./use-server-form";

export interface ServerFormFieldsProps {
  form: ServerForm;
  /** Create offers an explicit static backup; editing manages it on Connection. */
  showBackupToken?: boolean;
}

/**
 * The editable server fields, shared by the create page and the Settings tab
 * so both validate and map values identically. The caller provides the
 * surrounding surface and the submit button.
 */
export function ServerFormFields({
  form,
  showBackupToken = false,
}: ServerFormFieldsProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <form.Field name="name">
        {(field) => (
          <Field>
            <FieldLabel>{m.admin_proxies_servers_field_name()}</FieldLabel>
            <Input
              value={field.state.value}
              onValueChange={(v) => field.handleChange(v)}
              onBlur={field.handleBlur}
              placeholder="us-west-server-01"
            />
          </Field>
        )}
      </form.Field>

      <form.Field name="remark">
        {(field) => (
          <Field>
            <FieldLabel>{m.admin_proxies_servers_field_remark()}</FieldLabel>
            <Input
              value={field.state.value}
              onValueChange={(v) => field.handleChange(v)}
              onBlur={field.handleBlur}
            />
          </Field>
        )}
      </form.Field>

      <form.Field name="address">
        {(field) => (
          <Field>
            <FieldLabel>{m.admin_proxies_servers_field_address()}</FieldLabel>
            <Input
              value={field.state.value}
              onValueChange={(v) => field.handleChange(v)}
              onBlur={field.handleBlur}
              placeholder="example.com"
            />
          </Field>
        )}
      </form.Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <form.Field name="desiredAgentVersion">
          {(field) => (
            <Field>
              <FieldLabel>
                {m.admin_proxies_servers_field_desired_agent_version()}
              </FieldLabel>
              <Input
                value={field.state.value}
                onValueChange={(v) => field.handleChange(v)}
                onBlur={field.handleBlur}
                placeholder="latest / 0.3.0"
              />
            </Field>
          )}
        </form.Field>

        <form.Field name="desiredSingBoxVersion">
          {(field) => (
            <Field>
              <FieldLabel>
                {m.admin_proxies_servers_field_desired_sing_box_version()}
              </FieldLabel>
              <Input
                value={field.state.value}
                onValueChange={(v) => field.handleChange(v)}
                onBlur={field.handleBlur}
                placeholder="latest / 1.14.4"
              />
            </Field>
          )}
        </form.Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <form.Field name="configPollIntervalSeconds">
          {(field) => (
            <Field>
              <FieldLabel>
                {m.admin_proxies_servers_field_config_interval()}
              </FieldLabel>
              <NumberField
                min={5}
                max={86_400}
                value={field.state.value}
                onValueChange={(value) => field.handleChange(value ?? 60)}
              >
                <NumberFieldGroup>
                  <NumberFieldDecrement />
                  <NumberFieldInput />
                  <NumberFieldIncrement />
                </NumberFieldGroup>
              </NumberField>
            </Field>
          )}
        </form.Field>

        <form.Field name="heartbeatIntervalSeconds">
          {(field) => (
            <Field>
              <FieldLabel>
                {m.admin_proxies_servers_field_heartbeat_interval()}
              </FieldLabel>
              <NumberField
                min={5}
                max={300}
                value={field.state.value}
                onValueChange={(value) => field.handleChange(value ?? 30)}
              >
                <NumberFieldGroup>
                  <NumberFieldDecrement />
                  <NumberFieldInput />
                  <NumberFieldIncrement />
                </NumberFieldGroup>
              </NumberField>
            </Field>
          )}
        </form.Field>
      </div>

      <form.Field name="enabled">
        {(field) => (
          <div className="flex items-center gap-3">
            <Switch
              checked={field.state.value}
              onCheckedChange={(v) => field.handleChange(v)}
            />
            <Label>{m.admin_proxies_servers_field_enabled()}</Label>
          </div>
        )}
      </form.Field>

      {showBackupToken ? (
        <form.Field name="enableBackupToken">
          {(field) => (
            <div className="flex flex-col gap-1 rounded-lg border bg-muted/24 p-3">
              <label className="flex items-start gap-2 text-sm font-medium">
                <Checkbox
                  checked={field.state.value}
                  onCheckedChange={(checked) =>
                    field.handleChange(checked === true)
                  }
                />
                <span>{m.admin_proxies_servers_field_backup_token()}</span>
              </label>
              <p className="text-xs text-muted-foreground">
                {m.admin_proxies_servers_field_backup_token_description()}
              </p>
            </div>
          )}
        </form.Field>
      ) : null}
    </div>
  );
}
