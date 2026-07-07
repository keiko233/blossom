import type React from "react";

import { m } from "@/paraglide/messages";

import {
  type AnyZod,
  fieldMeta,
  humanizeKey,
  isGroupField,
  objectShape,
  typeOf,
  unwrap,
} from "./introspect";
import { SchemaField, type SchemaFormApi } from "./schema-field";

export interface SchemaFormProps {
  form: SchemaFormApi;
  /** The (managed-fields-omitted) inbound schema for the selected protocol. */
  schema: AnyZod;
  /** Form path the settings object lives under, e.g. "settings". */
  namePrefix: string;
}

/**
 * Renders a form for a sing-box inbound settings schema as a single stacked column.
 * Every field is generated from the Zod schema — controls, labels, help text and
 * validation all derive from it. Deprecated fields are tucked into a collapsed
 * "advanced" section at the end. For the tabbed node editor, see {@link schemaSections}.
 */
export function SchemaForm({
  form,
  schema,
  namePrefix,
}: SchemaFormProps): React.ReactElement {
  const shape = objectShape(unwrap(schema).inner) ?? {};
  const entries = Object.entries(shape);

  const primary = entries.filter(([, s]) => !fieldMeta(s).deprecated);
  const deprecated = entries.filter(([, s]) => fieldMeta(s).deprecated);

  return (
    <div className="flex flex-col gap-4">
      {primary.map(([key, child]) => (
        <SchemaField
          key={key}
          form={form}
          name={`${namePrefix}.${key}`}
          schema={child}
          labelKey={key}
        />
      ))}

      {deprecated.length > 0 ? (
        <AdvancedGroup>
          {deprecated.map(([key, child]) => (
            <SchemaField
              key={key}
              form={form}
              name={`${namePrefix}.${key}`}
              schema={child}
              labelKey={key}
            />
          ))}
        </AdvancedGroup>
      ) : null}
    </div>
  );
}

/** One tab's worth of the settings schema: an id, a label and its rendered fields. */
export interface SchemaSection {
  /** Stable tab id — also the settings sub-path for real groups. */
  id: string;
  label: string;
  node: React.ReactNode;
}

/**
 * Splits a sing-box inbound settings schema into tab sections: a "Basic settings"
 * section for the loose scalars, one section per group (Tls, Multiplex, Transport…)
 * and an "Advanced / deprecated" section. The caller owns the Tabs container so the
 * node-metadata tab can sit alongside these in a single tab strip.
 */
export function schemaSections(
  form: SchemaFormApi,
  schema: AnyZod,
  namePrefix: string,
): SchemaSection[] {
  const shape = objectShape(unwrap(schema).inner) ?? {};
  const entries = Object.entries(shape);

  const primary = entries.filter(([, s]) => !fieldMeta(s).deprecated);
  const deprecated = entries.filter(([, s]) => fieldMeta(s).deprecated);
  const scalars = primary.filter(([, s]) => !isGroupField(s));
  const groups = primary.filter(([, s]) => isGroupField(s));

  const sections: SchemaSection[] = [];

  if (scalars.length > 0) {
    sections.push({
      id: `${namePrefix}.__basics`,
      label: m.admin_proxies_nodes_form_basics(),
      node: (
        <div className="flex flex-col gap-4">
          {scalars.map(([key, child]) => (
            <SchemaField
              key={key}
              form={form}
              name={`${namePrefix}.${key}`}
              schema={child}
              labelKey={key}
            />
          ))}
        </div>
      ),
    });
  }

  for (const [key, child] of groups) {
    sections.push({
      id: `${namePrefix}.${key}`,
      label: humanizeKey(key),
      // `flat` because the tab panel is already the group's container.
      node: (
        <SchemaField
          form={form}
          name={`${namePrefix}.${key}`}
          schema={child}
          labelKey={key}
          variant="flat"
        />
      ),
    });
  }

  if (deprecated.length > 0) {
    sections.push({
      id: `${namePrefix}.__advanced`,
      label: m.admin_proxies_nodes_form_advanced(),
      node: (
        <div className="flex flex-col gap-4">
          {deprecated.map(([key, child]) => (
            <SchemaField
              key={key}
              form={form}
              name={`${namePrefix}.${key}`}
              schema={child}
              labelKey={key}
            />
          ))}
        </div>
      ),
    });
  }

  return sections;
}

function AdvancedGroup({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <details className="rounded-xl border bg-muted/32 p-4">
      <summary className="cursor-default text-sm font-medium text-muted-foreground">
        {m.admin_proxies_nodes_form_advanced()}
      </summary>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </details>
  );
}

/** Whether a schema type has a renderable control (used to skip pure-literal fields). */
export function isRenderable(schema: AnyZod): boolean {
  return typeOf(unwrap(schema).inner) !== "literal";
}
