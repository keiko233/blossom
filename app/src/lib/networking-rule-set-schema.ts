/**
 * Client-safe request contracts for the Rule sets workbench. The server
 * functions validate with these same schemas. Asset id/version regexes mirror
 * `importRuleSetAssetSchema` in `networking-schema.ts`.
 */
import { z } from "zod";

import {
  OFFICIAL_RULE_SET_MAX_NAME_LENGTH,
  OFFICIAL_RULE_SET_NAME_PATTERN,
  OFFICIAL_RULE_SET_REPOS,
} from "./github-rule-set-catalog";

export const officialRuleSetRepoSchema = z.enum(OFFICIAL_RULE_SET_REPOS);

export const officialRuleSetNameSchema = z
  .string()
  .min(1)
  .max(OFFICIAL_RULE_SET_MAX_NAME_LENGTH)
  .regex(OFFICIAL_RULE_SET_NAME_PATTERN);

export const importOfficialRuleSetSchema = z.object({
  repo: officialRuleSetRepoSchema,
  name: officialRuleSetNameSchema,
});

export type ImportOfficialRuleSetInput = z.infer<
  typeof importOfficialRuleSetSchema
>;

const ruleSetIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "Use lowercase letters, digits, dots, underscores and dashes",
  );

const ruleSetVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Invalid pinned version");

export const RULE_SET_CUSTOM_MAX_INPUT_BYTES = 1024 * 1024;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export const customRuleSetInputSchema = z
  .object({
    ruleSetId: ruleSetIdSchema,
    version: ruleSetVersionSchema,
    mode: z.enum(["structured", "json"]),
    rules: z.unknown(),
  })
  .superRefine((value, context) => {
    let serialized: string;
    try {
      serialized = JSON.stringify(value.rules);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Rules must be JSON-serializable",
        path: ["rules"],
      });
      return;
    }
    if (
      serialized === undefined ||
      utf8ByteLength(serialized) > RULE_SET_CUSTOM_MAX_INPUT_BYTES
    ) {
      context.addIssue({
        code: "custom",
        message: "Rules exceed the 1 MiB request bound",
        path: ["rules"],
      });
    }
  });

export type CustomRuleSetInput = z.infer<typeof customRuleSetInputSchema>;

export const ruleSetIdInputSchema = ruleSetIdSchema;
export const ruleSetVersionInputSchema = ruleSetVersionSchema;
