import {
  ChevronDownIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import type React from "react";

import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { randomHex, randomPassword, randomUuid } from "@/lib/random";

import {
  type AnyZod,
  arrayElement,
  discriminatedUnion,
  enumOptions,
  fieldMeta,
  humanizeKey,
  isScalarUnion,
  listableUnion,
  objectShape,
  typeOf,
  unwrap,
} from "./introspect";
import { defaultsFromSchema } from "./schema-defaults";

/**
 * Minimal structural form contract — the renderer only ever calls `Field` with
 * dynamic string names, so it deliberately avoids the concrete TanStack generics
 * (which don't accept arbitrary paths).
 */
export interface SchemaFormApi {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Field: any;
}

/**
 * How a group field (object / union / repeatable) presents itself. `card` (default)
 * is a self-contained Collapsible card for nested groups. `flat` drops the shell
 * entirely — used when the group owns a whole tab panel, which is already the
 * container.
 */
export type GroupVariant = "card" | "flat";

export interface SchemaFieldProps {
  form: SchemaFormApi;
  name: string;
  schema: AnyZod;
  labelKey: string;
  /** Top-level groups open by default; nested groups start collapsed to tame depth. */
  defaultOpen?: boolean;
  /** Presentation for group fields. Nested groups always fall back to `card`. */
  variant?: GroupVariant;
}

/**
 * Choices for fields the sing-box schema leaves as a free `string` but which really
 * have a fixed, well-known set of valid values (documented only in the field's
 * description). Rendering these as a Select is both better UX and still exhaustive —
 * sing-box accepts nothing outside these. Any pre-existing value not listed here is
 * preserved at render time, so editing older/exotic configs never loses data.
 */
const CURATED_OPTIONS: Record<string, string[]> = {
  method: [
    "2022-blake3-aes-128-gcm",
    "2022-blake3-aes-256-gcm",
    "2022-blake3-chacha20-poly1305",
    "aes-128-gcm",
    "aes-192-gcm",
    "aes-256-gcm",
    "chacha20-ietf-poly1305",
    "xchacha20-ietf-poly1305",
    "none",
  ],
};

/**
 * Key length required by shadowsocks 2022 methods (in bytes). The generated password
 * must be exact-length random bytes, base64-encoded. Legacy methods accept any string.
 *
 * @see https://sing-box.sagernet.org/configuration/inbound/shadowsocks/
 */
function ss2022KeyBytes(method?: string): number {
  switch (method) {
    case "2022-blake3-aes-128-gcm":
      return 16;
    case "2022-blake3-aes-256-gcm":
    case "2022-blake3-chacha20-poly1305":
      return 32;
    default:
      return 24; // sensible length for legacy-method passwords
  }
}

/**
 * One-click value generators keyed by field name. When the field has a sibling
 * `method` field (as in shadowsocks inbounds), the generator reads it at click
 * time so the generated key matches the selected encryption method's requirements.
 */
function generatorFor(
  key: string,
  form: SchemaFormApi,
  name: string,
): (() => string) | null {
  switch (key) {
    case "password":
    case "psk":
      return () => {
        // Resolve the sibling "method" field to pick the right key size for
        // shadowsocks 2022 methods. Falls back to 24 bytes when there is no
        // method field or the method isn't a recognised 2022 variant.
        const parentPath = name.includes(".")
          ? name.substring(0, name.lastIndexOf("."))
          : "";
        const methodPath = parentPath ? `${parentPath}.method` : "method";
        let method: string | undefined;
        try {
          method = (
            form as unknown as { getFieldValue?: (p: string) => unknown }
          ).getFieldValue?.(methodPath) as string | undefined;
        } catch {
          // field may not exist (e.g. psk in protocols without a method select)
        }
        return randomPassword(ss2022KeyBytes(method));
      };
    case "uuid":
      return randomUuid;
    case "short_id":
      return () => randomHex(8);
    default:
      return null;
  }
}

export function SchemaField({
  form,
  name,
  schema,
  labelKey,
  defaultOpen,
  variant = "card",
}: SchemaFieldProps): React.ReactElement | null {
  const { inner, isOptional } = unwrap(schema);
  const kind = typeOf(inner);
  const label = humanizeKey(labelKey);
  const meta = fieldMeta(schema);

  // Nested object → collapsible group of its fields.
  if (kind === "object") {
    return (
      <ObjectGroup
        form={form}
        name={name}
        inner={inner}
        label={label}
        help={meta.help}
        defaultOpen={defaultOpen}
        variant={variant}
        optional={isOptional}
      />
    );
  }

  // Discriminated union → a type select that swaps the sub-fields.
  const du = kind === "union" ? discriminatedUnion(inner) : null;
  if (du) {
    return (
      <DiscriminatedGroup
        form={form}
        name={name}
        du={du}
        label={label}
        help={meta.help}
        defaultOpen={defaultOpen}
        variant={variant}
      />
    );
  }

  // Array of objects → repeatable rows. Array of scalars → comma input.
  if (kind === "array") {
    const element = arrayElement(inner);
    if (element && typeOf(unwrap(element).inner) === "object") {
      return (
        <RepeatableGroup
          form={form}
          name={name}
          element={element}
          label={label}
          help={meta.help}
          defaultOpen={defaultOpen}
          variant={variant}
        />
      );
    }
    return (
      <ScalarArrayField
        form={form}
        name={name}
        label={label}
        help={meta.help}
      />
    );
  }

  if (kind === "boolean") {
    return (
      <form.Field name={name}>
        {(field: AnyFieldApi) => (
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <Label>{label}</Label>
              {meta.help ? (
                <span className="text-xs text-muted-foreground">
                  {meta.help}
                </span>
              ) : null}
            </div>
            <Switch
              checked={Boolean(field.state.value)}
              onCheckedChange={(v) => field.handleChange(v)}
            />
          </div>
        )}
      </form.Field>
    );
  }

  const options = enumOptions(inner) ?? CURATED_OPTIONS[labelKey] ?? null;
  if (options) {
    return (
      <form.Field name={name}>
        {(field: AnyFieldApi) => {
          const current = String(field.state.value ?? "");
          // Keep an existing value that predates (or falls outside) the option set,
          // so editing never silently drops it.
          const items =
            current && !options.includes(current)
              ? [current, ...options]
              : options;
          return (
            <Field>
              <FieldLabel>{label}</FieldLabel>
              <Select
                value={current}
                onValueChange={(v) => field.handleChange(v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {items.map((opt) => (
                    <SelectItem key={opt} value={opt}>
                      {opt === "" ? "(none)" : opt}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {meta.help ? (
                <FieldDescription>{meta.help}</FieldDescription>
              ) : null}
            </Field>
          );
        }}
      </form.Field>
    );
  }

  if (kind === "number") {
    return (
      <form.Field name={name}>
        {(field: AnyFieldApi) => (
          <Field>
            <FieldLabel>{label}</FieldLabel>
            <NumberField
              value={
                typeof field.state.value === "number" ? field.state.value : null
              }
              onValueChange={(v) => field.handleChange(v ?? undefined)}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement />
                <NumberFieldInput onBlur={field.handleBlur} />
                <NumberFieldIncrement />
              </NumberFieldGroup>
            </NumberField>
            {meta.help ? (
              <FieldDescription>{meta.help}</FieldDescription>
            ) : null}
          </Field>
        )}
      </form.Field>
    );
  }

  // Listable `T | T[]` (e.g. alpn / certificate) → multi-value comma input.
  const listable = kind === "union" ? listableUnion(inner) : null;
  if (listable) {
    return (
      <ScalarArrayField
        form={form}
        name={name}
        label={label}
        help={meta.help}
        numeric={listable.elementKind === "number"}
      />
    );
  }

  // Unsupported leaf (record / exotic union) → raw JSON textarea escape hatch.
  // A union of plain scalars (e.g. FwMark = number | string) has no shape to render,
  // so it falls through to the string input below instead of the JSON textarea.
  if (kind !== "string" && !isScalarUnion(inner)) {
    return <JsonField form={form} name={name} label={label} help={meta.help} />;
  }

  // String (and scalar-union fallback treated as string).
  const generate = generatorFor(labelKey, form, name);
  return (
    <form.Field name={name}>
      {(field: AnyFieldApi) => (
        <Field>
          <FieldLabel>{label}</FieldLabel>
          <div className="flex w-full gap-2">
            <Input
              value={String(field.state.value ?? "")}
              onValueChange={(v) => field.handleChange(v)}
            />
            {generate ? (
              <Button
                type="button"
                variant="secondary"
                size="icon"
                aria-label="Generate"
                onClick={() => field.handleChange(generate())}
              >
                <RefreshCwIcon />
              </Button>
            ) : null}
          </div>
          {meta.help ? <FieldDescription>{meta.help}</FieldDescription> : null}
        </Field>
      )}
    </form.Field>
  );
}

// Loosened field api — names are dynamic so the concrete generics don't apply.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFieldApi = any;

function GroupShell({
  label,
  help,
  defaultOpen,
  variant = "card",
  children,
}: {
  label: string;
  help?: string;
  defaultOpen?: boolean;
  variant?: GroupVariant;
  children: React.ReactNode;
}): React.ReactElement {
  // Flat variant: no shell of its own — the caller (e.g. a tab panel) already
  // provides the container, so just lay the fields out.
  if (variant === "flat") {
    return (
      <div className="flex flex-col gap-4">
        {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
        {children}
      </div>
    );
  }

  // Card variant: a self-contained collapsible card (nested groups).
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="rounded-xl border bg-card shadow-xs"
    >
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="group/grp flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-medium"
          />
        }
      >
        <span>{label}</span>
        <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[panel-open]/grp:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-4 border-t px-4 py-4">
          {help ? (
            <p className="text-xs text-muted-foreground">{help}</p>
          ) : null}
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ObjectGroup({
  form,
  name,
  inner,
  label,
  help,
  defaultOpen,
  variant,
  optional,
}: {
  form: SchemaFormApi;
  name: string;
  inner: AnyZod;
  label: string;
  help?: string;
  defaultOpen?: boolean;
  variant?: GroupVariant;
  optional: boolean;
}): React.ReactElement {
  const shape = objectShape(inner) ?? {};
  if (optional) {
    return (
      <form.Field name={name}>
        {(field: AnyFieldApi) => {
          const enabled = field.state.value !== undefined;
          return (
            <GroupShell
              label={label}
              help={help}
              defaultOpen={defaultOpen}
              variant={variant}
            >
              <div className="flex items-center justify-between gap-3">
                <Label>{label}</Label>
                <Switch
                  checked={enabled}
                  onCheckedChange={(next) =>
                    field.handleChange(
                      next ? defaultsFromSchema(inner) : undefined,
                    )
                  }
                />
              </div>
              {enabled
                ? Object.entries(shape).map(([key, child]) => (
                    <SchemaField
                      key={key}
                      form={form}
                      name={`${name}.${key}`}
                      schema={child}
                      labelKey={key}
                    />
                  ))
                : null}
            </GroupShell>
          );
        }}
      </form.Field>
    );
  }
  return (
    <GroupShell
      label={label}
      help={help}
      defaultOpen={defaultOpen}
      variant={variant}
    >
      {Object.entries(shape).map(([key, child]) => (
        <SchemaField
          key={key}
          form={form}
          name={`${name}.${key}`}
          schema={child}
          labelKey={key}
        />
      ))}
    </GroupShell>
  );
}

function DiscriminatedGroup({
  form,
  name,
  du,
  label,
  help,
  defaultOpen,
  variant,
}: {
  form: SchemaFormApi;
  name: string;
  du: { key: string; byValue: Record<string, AnyZod> };
  label: string;
  help?: string;
  defaultOpen?: boolean;
  variant?: GroupVariant;
}): React.ReactElement {
  const values = Object.keys(du.byValue);
  return (
    <GroupShell
      label={label}
      help={help}
      defaultOpen={defaultOpen}
      variant={variant}
    >
      <form.Field name={`${name}.${du.key}`}>
        {(field: AnyFieldApi) => {
          const current = String(field.state.value ?? values[0] ?? "");
          const member = du.byValue[current];
          const shape = member ? (objectShape(unwrap(member).inner) ?? {}) : {};
          return (
            <>
              <Field>
                <FieldLabel>{humanizeKey(du.key)}</FieldLabel>
                <Select
                  value={current}
                  onValueChange={(v) => field.handleChange(v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {values.map((v) => (
                      <SelectItem key={v} value={v}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              {Object.entries(shape)
                .filter(([key]) => key !== du.key)
                .map(([key, child]) => (
                  <SchemaField
                    key={`${current}.${key}`}
                    form={form}
                    name={`${name}.${key}`}
                    schema={child}
                    labelKey={key}
                  />
                ))}
            </>
          );
        }}
      </form.Field>
    </GroupShell>
  );
}

function RepeatableGroup({
  form,
  name,
  element,
  label,
  help,
  defaultOpen,
  variant,
}: {
  form: SchemaFormApi;
  name: string;
  element: AnyZod;
  label: string;
  help?: string;
  defaultOpen?: boolean;
  variant?: GroupVariant;
}): React.ReactElement {
  const shape = objectShape(unwrap(element).inner) ?? {};
  return (
    <GroupShell
      label={label}
      help={help}
      defaultOpen={defaultOpen}
      variant={variant}
    >
      <form.Field name={name} mode="array">
        {(field: AnyFieldApi) => {
          const rows: unknown[] = field.state.value ?? [];
          return (
            <div className="flex flex-col gap-4">
              {rows.map((_, index) => (
                <div
                  key={index}
                  className="flex flex-col gap-3 rounded-lg border bg-background p-3"
                >
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Remove"
                      onClick={() => field.removeValue(index)}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                  {Object.entries(shape).map(([key, child]) => (
                    <SchemaField
                      key={key}
                      form={form}
                      name={`${name}[${index}].${key}`}
                      schema={child}
                      labelKey={key}
                    />
                  ))}
                </div>
              ))}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => field.pushValue(defaultsFromSchema(element))}
              >
                <PlusIcon />
                {label}
              </Button>
            </div>
          );
        }}
      </form.Field>
    </GroupShell>
  );
}

function ScalarArrayField({
  form,
  name,
  label,
  help,
  numeric,
}: {
  form: SchemaFormApi;
  name: string;
  label: string;
  help?: string;
  /** Parse entries as numbers (for listable-int fields) rather than strings. */
  numeric?: boolean;
}): React.ReactElement {
  return (
    <form.Field name={name}>
      {(field: AnyFieldApi) => {
        // A listable field may hold an array, or a single scalar from an older
        // config — normalize both so the existing value is never dropped on edit.
        const raw = field.state.value;
        const arr: unknown[] = Array.isArray(raw)
          ? raw
          : raw === undefined || raw === null || raw === ""
            ? []
            : [raw];
        return (
          <Field>
            <FieldLabel>{label}</FieldLabel>
            <Input
              value={arr.join(", ")}
              onValueChange={(v) => {
                const parts = v
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
                field.handleChange(
                  numeric
                    ? parts.map(Number).filter((n) => !Number.isNaN(n))
                    : parts,
                );
              }}
              placeholder="comma, separated"
            />
            {help ? <FieldDescription>{help}</FieldDescription> : null}
          </Field>
        );
      }}
    </form.Field>
  );
}

function JsonField({
  form,
  name,
  label,
  help,
}: {
  form: SchemaFormApi;
  name: string;
  label: string;
  help?: string;
}): React.ReactElement {
  return (
    <form.Field name={name}>
      {(field: AnyFieldApi) => (
        <Field>
          <FieldLabel>{label}</FieldLabel>
          <Textarea
            value={
              field.state.value === undefined
                ? ""
                : JSON.stringify(field.state.value, null, 2)
            }
            onChange={(e) => {
              const v = e.target.value;
              try {
                field.handleChange(v === "" ? undefined : JSON.parse(v));
              } catch {
                // keep typing; invalid JSON isn't committed
              }
            }}
            rows={4}
          />
          {help ? <FieldDescription>{help}</FieldDescription> : null}
        </Field>
      )}
    </form.Field>
  );
}
