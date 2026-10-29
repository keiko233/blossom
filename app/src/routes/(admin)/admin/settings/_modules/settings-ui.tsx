import type React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardPanel,
  CardTitle,
} from "@/components/ui/card";
import { FieldDescription } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { m } from "@/paraglide/messages";

/** Validation messages of a TanStack Form field, under its input. */
export function FieldErrors({
  errors,
}: {
  errors: readonly unknown[];
}): React.ReactElement | null {
  const message = errors
    .map((error) =>
      typeof error === "string"
        ? error
        : error && typeof error === "object" && "message" in error
          ? String(error.message)
          : "",
    )
    .filter(Boolean)
    .join(", ");
  return message ? <p className="text-xs text-destructive">{message}</p> : null;
}

/** A labelled switch with optional helper text underneath. */
export function SwitchField({
  label,
  hint,
  checked,
  onCheckedChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <Switch checked={checked} onCheckedChange={onCheckedChange} />
        <Label>{label}</Label>
      </div>
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </div>
  );
}

export interface SettingsCardProps {
  /** DOM id of the section's `<form>`, so the footer button can submit it. */
  formId: string;
  title: string;
  description: string;
  isDirty: boolean;
  isSubmitting: boolean;
  onSubmit: () => void;
  onReset: () => void;
  children: React.ReactNode;
}

/**
 * Shell shared by the four editable sections: header, the form body, and a
 * footer with "reset to defaults", an unsaved-changes marker and Save.
 */
export function SettingsCard({
  formId,
  title,
  description,
  isDirty,
  isSubmitting,
  onSubmit,
  onReset,
  children,
}: SettingsCardProps): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>

      <CardPanel>
        <form
          id={formId}
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onSubmit();
          }}
        >
          {children}
        </form>
      </CardPanel>

      <CardFooter className="justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={isSubmitting}
          onClick={onReset}
        >
          {m.admin_settings_reset()}
        </Button>
        <div className="flex items-center gap-3">
          {isDirty ? (
            <Badge variant="warning">{m.admin_settings_unsaved()}</Badge>
          ) : null}
          <Button
            type="submit"
            form={formId}
            disabled={!isDirty}
            loading={isSubmitting}
          >
            {m.admin_settings_save()}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
