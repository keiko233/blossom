import { getLocale } from "@/paraglide/runtime";

/**
 * Runtime introspection helpers for zod v4 schemas, used to drive the generic
 * schema-form renderer. Zod's internal `def` isn't part of the public types, so this
 * module is deliberately loosely typed and is the single place that touches it.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyZod = any;

const WRAPPERS = new Set([
  "optional",
  "nullable",
  "nullish",
  "default",
  "catch",
]);

export interface Unwrapped {
  /** The schema with optional/default/nullable wrappers stripped. */
  inner: AnyZod;
  /** True if any wrapper made the field optional/nullable. */
  isOptional: boolean;
  /** The declared default value, if any. */
  defaultValue: unknown;
}

export function unwrap(schema: AnyZod): Unwrapped {
  let s = schema;
  let isOptional = false;
  let defaultValue: unknown;

  while (s?.def && WRAPPERS.has(s.def.type)) {
    if (s.def.type !== "default" && s.def.type !== "catch") {
      isOptional = true;
    }
    if (s.def.type === "default") {
      const raw = s.def.defaultValue;
      defaultValue = typeof raw === "function" ? raw() : raw;
    }
    s = s.def.innerType;
  }

  return { inner: s, isOptional, defaultValue };
}

export function typeOf(inner: AnyZod): string {
  return inner?.def?.type ?? "unknown";
}

export function objectShape(inner: AnyZod): Record<string, AnyZod> | null {
  return inner?.def?.type === "object" ? inner.def.shape : null;
}

export function enumOptions(inner: AnyZod): string[] | null {
  if (inner?.def?.type === "enum") {
    return Object.keys(inner.def.entries ?? {});
  }
  // A union that offers an enum (e.g. `network: enum | enum[]`) is still a fixed
  // set of choices — surface the enum's values so it renders as a Select.
  if (inner?.def?.type === "union") {
    for (const option of inner.def.options ?? []) {
      const u = unwrap(option).inner;
      if (u?.def?.type === "enum") {
        return Object.keys(u.def.entries ?? {});
      }
      if (u?.def?.type === "array") {
        const el = unwrap(u.def.element).inner;
        if (el?.def?.type === "enum") {
          return Object.keys(el.def.entries ?? {});
        }
      }
    }
  }
  return null;
}

export function arrayElement(inner: AnyZod): AnyZod | null {
  return inner?.def?.type === "array" ? inner.def.element : null;
}

export function literalValue(inner: AnyZod): unknown {
  if (inner?.def?.type !== "literal") {
    return undefined;
  }
  return inner.def.values?.[0] ?? inner.def.value;
}

const SCALAR_KINDS = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "literal",
  "enum",
]);

/**
 * A union of plain scalars (e.g. sing-box `FwMark = number | string`). These have no
 * object shape to render as a group, so the form treats them as a single text input
 * rather than dropping to the raw-JSON escape hatch.
 */
export function isScalarUnion(inner: AnyZod): boolean {
  if (inner?.def?.type !== "union") {
    return false;
  }
  const options: AnyZod[] = inner.def.options ?? [];
  return (
    options.length > 0 &&
    options.every((o) => SCALAR_KINDS.has(typeOf(unwrap(o).inner)))
  );
}

/**
 * A "listable" union `T | T[]` (sing-box's `listable` helper, e.g. `listableString`
 * for alpn/certificate) where `T` is a scalar. Returns the element kind so the form
 * can render it as a multi-value input and coerce entries to the right type; null if
 * the union isn't a listable of scalars.
 */
export function listableUnion(inner: AnyZod): { elementKind: string } | null {
  if (inner?.def?.type !== "union") {
    return null;
  }
  const options: AnyZod[] = inner.def.options ?? [];
  if (options.length === 0) {
    return null;
  }

  let hasArray = false;
  let elementKind: string | undefined;
  for (const option of options) {
    const u = unwrap(option).inner;
    const kind = typeOf(u);
    if (kind === "array") {
      hasArray = true;
      const el = typeOf(unwrap(u.def.element).inner);
      if (!SCALAR_KINDS.has(el)) {
        return null;
      }
      elementKind ??= el;
    } else if (SCALAR_KINDS.has(kind)) {
      elementKind ??= kind;
    } else {
      return null;
    }
  }

  return hasArray && elementKind ? { elementKind } : null;
}

export interface DiscriminatedUnion {
  key: string;
  byValue: Record<string, AnyZod>;
}

/**
 * Detects a discriminated union of objects and returns its discriminator key + a
 * map from discriminant value to the member schema. Falls back to inferring the key
 * when zod doesn't expose `discriminator` (e.g. some nested unions).
 */
export function discriminatedUnion(inner: AnyZod): DiscriminatedUnion | null {
  if (inner?.def?.type !== "union") {
    return null;
  }
  const options: AnyZod[] = inner.def.options ?? [];
  if (!options.length || !options.every((o) => o?.def?.type === "object")) {
    return null;
  }

  let key: string | undefined = inner.def.discriminator;
  if (!key) {
    const candidates = Object.keys(options[0].def.shape);
    key = candidates.find((k) =>
      options.every((o) => {
        const field = o.def.shape[k];
        return field && literalValue(unwrap(field).inner) !== undefined;
      }),
    );
  }
  if (!key) {
    return null;
  }

  const byValue: Record<string, AnyZod> = {};
  for (const option of options) {
    const lit = literalValue(unwrap(option.def.shape[key]).inner);
    if (typeof lit === "string") {
      byValue[lit] = option;
    }
  }

  return Object.keys(byValue).length ? { key, byValue } : null;
}

export interface FieldMeta {
  help?: string;
  deprecated: boolean;
}

/**
 * Reads a field's help text and deprecated flag from the sing-box schema metadata,
 * localizing to the current app locale (`description_zh` for zh-cn, else `description`).
 */
export function fieldMeta(schema: AnyZod): FieldMeta {
  const outer = schema?.meta?.() ?? {};
  const inner = unwrap(schema).inner?.meta?.() ?? {};
  const meta = { ...inner, ...outer };
  const zh = getLocale?.() === "zh-cn";
  return {
    help: (zh ? meta.description_zh : undefined) ?? meta.description,
    deprecated: Boolean(meta.deprecated),
  };
}

/**
 * Whether a field renders as a self-contained group (object, discriminated union, or
 * array of objects) rather than a single scalar control. Used by the masonry layout
 * to give each group its own card and bundle the loose scalars together.
 */
export function isGroupField(schema: AnyZod): boolean {
  const inner = unwrap(schema).inner;
  const kind = typeOf(inner);
  if (kind === "object") {
    return true;
  }
  if (kind === "union") {
    return discriminatedUnion(inner) != null;
  }
  if (kind === "array") {
    const element = arrayElement(inner);
    return element != null && typeOf(unwrap(element).inner) === "object";
  }
  return false;
}

/** "server_name" -> "Server name". */
export function humanizeKey(key: string): string {
  const spaced = key.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
