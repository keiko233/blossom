"use client";

import { Field as FieldPrimitive } from "@base-ui/react/field";
import type { AnyFieldApi } from "@tanstack/react-form";
import { cloneElement, createContext, use } from "react";
import type React from "react";

import { useFormContext } from "@/components/ui/form";
import { cn } from "@/lib/utils";

const FieldContext = createContext<AnyFieldApi | null>(null);

export function useFieldContext(): AnyFieldApi {
  const field = use(FieldContext);

  if (!field) {
    throw new Error("useFieldContext must be used within a <FormField>.");
  }

  return field;
}

export interface FormFieldProps extends Omit<
  FieldPrimitive.Root.Props,
  "children" | "name"
> {
  name: string;
  children?: React.ReactNode | ((field: AnyFieldApi) => React.ReactNode);
}

/**
 * Binds a TanStack Form field to a Base UI `Field`. Provides the field API to
 * descendants (`FieldLabel`, `FieldControl`, `FieldError`) through context and
 * wires validity/dirty/touched state, so consumers don't repeat the plumbing.
 */
export function FormField({
  name,
  className,
  children,
  ...props
}: FormFieldProps): React.ReactElement {
  const form = useFormContext();

  return (
    <form.Field name={name}>
      {(field: AnyFieldApi) => (
        <FieldContext.Provider value={field}>
          <FieldPrimitive.Root
            name={field.name}
            invalid={!field.state.meta.isValid}
            dirty={field.state.meta.isDirty}
            touched={field.state.meta.isTouched}
            className={cn("flex flex-col items-start gap-2", className)}
            data-slot="field"
            {...props}
          >
            {typeof children === "function" ? children(field) : children}
          </FieldPrimitive.Root>
        </FieldContext.Provider>
      )}
    </form.Field>
  );
}

export function Field({
  className,
  ...props
}: FieldPrimitive.Root.Props): React.ReactElement {
  return (
    <FieldPrimitive.Root
      className={cn("flex flex-col items-start gap-2", className)}
      data-slot="field"
      {...props}
    />
  );
}

export function FieldLabel({
  className,
  ...props
}: FieldPrimitive.Label.Props): React.ReactElement {
  return (
    <FieldPrimitive.Label
      className={cn(
        "inline-flex items-center gap-2 text-base/4.5 font-medium text-foreground data-disabled:opacity-64 sm:text-sm/4",
        className,
      )}
      data-slot="field-label"
      {...props}
    />
  );
}

export interface FieldControlProps {
  /**
   * The input element to render. Any Base UI input control (e.g. `Input`) works
   * out of the box; its `value`, `onValueChange` and `onBlur` are wired to the
   * TanStack Form field automatically.
   */
  render: React.ReactElement<Record<string, unknown>>;
}

export function FieldControl({
  render,
}: FieldControlProps): React.ReactElement {
  const field = useFieldContext();

  return cloneElement(render, {
    name: field.name,
    value: field.state.value,
    onValueChange: (value: string) => field.handleChange(value),
    onBlur: field.handleBlur,
  });
}

export function FieldItem({
  className,
  ...props
}: FieldPrimitive.Item.Props): React.ReactElement {
  return (
    <FieldPrimitive.Item
      className={cn("flex", className)}
      data-slot="field-item"
      {...props}
    />
  );
}

export function FieldDescription({
  className,
  ...props
}: FieldPrimitive.Description.Props): React.ReactElement {
  return (
    <FieldPrimitive.Description
      className={cn("text-xs text-muted-foreground", className)}
      data-slot="field-description"
      {...props}
    />
  );
}

export interface FieldErrorProps extends Omit<
  FieldPrimitive.Error.Props,
  "children"
> {
  /**
   * Override the message. When omitted, the field's validation errors are shown.
   */
  children?: React.ReactNode;
}

export function FieldError({
  className,
  children,
  ...props
}: FieldErrorProps): React.ReactElement | null {
  const field = useFieldContext();

  const message =
    children ??
    field.state.meta.errors
      .map((error) =>
        typeof error === "string" ? error : (error?.message ?? ""),
      )
      .filter(Boolean)
      .join(", ");

  if (!message) {
    return null;
  }

  return (
    <FieldPrimitive.Error
      match
      className={cn("text-xs text-destructive-foreground", className)}
      data-slot="field-error"
      {...props}
    >
      {message}
    </FieldPrimitive.Error>
  );
}

export const FieldValidity: typeof FieldPrimitive.Validity =
  FieldPrimitive.Validity;

export { FieldPrimitive };
