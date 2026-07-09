import clashMetaSchemaJson from "meta-json-schema/schemas/meta-json-schema.json";
import z from "zod";
import type { JSONSchema } from "zod/v4/core";

/**
 * The meta-json-schema uses draft-7 features (conditional if/then/else) that
 * zod's fromJSONSchema does not fully support at runtime, so construction is
 * wrapped in a try/catch. Consumers can still use this as a typed Zod schema;
 * if construction fails it falls back to `z.any()` to avoid crashing the import.
 */
export const clashMetaSchema = (() => {
  try {
    return z.fromJSONSchema(clashMetaSchemaJson as JSONSchema.BaseSchema, {
      defaultTarget: "draft-7",
    });
  } catch {
    return z.any();
  }
})();
