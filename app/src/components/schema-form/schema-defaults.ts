import isEqual from "lodash-es/isEqual";

import {
  type AnyZod,
  discriminatedUnion,
  listableUnion,
  literalValue,
  objectShape,
  typeOf,
  unwrap,
} from "./introspect";

/**
 * Builds an initial form value for a schema: declared defaults where present, else a
 * type-appropriate empty value. Objects recurse so every field is controlled.
 */
export function defaultsFromSchema(schema: AnyZod): unknown {
  const { inner, defaultValue } = unwrap(schema);
  if (defaultValue !== undefined) {
    return defaultValue;
  }

  switch (typeOf(inner)) {
    case "object": {
      const shape = objectShape(inner) ?? {};
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(shape)) {
        out[key] = defaultsFromSchema(shape[key]);
      }
      return out;
    }
    case "string":
      return "";
    case "boolean":
      return false;
    case "enum":
      return Object.keys(inner.def.entries ?? {})[0] ?? "";
    case "array":
      return [];
    case "literal":
      return literalValue(inner);
    case "union": {
      const du = discriminatedUnion(inner);
      if (du) {
        const first = Object.values(du.byValue)[0];
        return defaultsFromSchema(first);
      }
      // Listable `T | T[]` fields start as an empty list; scalar unions as "".
      if (listableUnion(inner)) {
        return [];
      }
      return "";
    }
    // number and unknown leaves start unset so they prune away unless edited.
    default:
      return undefined;
  }
}

/**
 * Produces a minimal fragment for storage: drops optional fields left at their
 * default/empty value, while always keeping required fields. Keeps the stored
 * sing-box settings small and readable.
 */
export function pruneSettings(value: unknown, schema: AnyZod): unknown {
  const { inner, isOptional } = unwrap(schema);

  if (typeOf(inner) === "object") {
    const shape = objectShape(inner) ?? {};
    const source = (value ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      const pruned = pruneSettings(source[key], shape[key]);
      if (pruned !== undefined) {
        out[key] = pruned;
      }
    }
    if (Object.keys(out).length === 0) {
      return isOptional ? undefined : {};
    }
    return out;
  }

  // Leaf / array / union.
  if (value === undefined || value === null) {
    return isOptional ? undefined : value;
  }
  if (!isOptional) {
    return value;
  }
  if (value === "") {
    return undefined;
  }
  if (Array.isArray(value) && value.length === 0) {
    return undefined;
  }
  if (isEqual(value, defaultsFromSchema(schema))) {
    return undefined;
  }
  return value;
}
