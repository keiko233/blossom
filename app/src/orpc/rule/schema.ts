import { z } from "zod";

import { RULE_ACTIONS, RULE_MATCH_TYPES, RULE_SCOPES } from "@/db/rule-schema";
import {
  findInvalidRuleValue,
  isActionAllowedForScope,
  normalizeRuleValues,
} from "@/lib/routing-rules";

/**
 * Routing rule input schemas. `values` is trimmed and de-duplicated here;
 * cross-field rules (per-match-type value format, server scope requiring
 * `reject`) live in `getRuleIssues` so `updateRule` can re-run them against the
 * merged row when only some fields are submitted.
 */

export const ruleMatchTypeSchema = z.enum(RULE_MATCH_TYPES);
export const ruleActionSchema = z.enum(RULE_ACTIONS);
export const ruleScopeSchema = z.enum(RULE_SCOPES);

export type RuleIssuePath = "values" | "action";

export interface RuleIssue {
  path: RuleIssuePath;
  message: string;
}

/**
 * Cross-field validation over whichever of the fields are present. Issues for
 * a combination are only reported when both sides are known.
 */
export function getRuleIssues(rule: {
  matchType?: z.infer<typeof ruleMatchTypeSchema>;
  values?: readonly string[];
  action?: z.infer<typeof ruleActionSchema>;
  scope?: z.infer<typeof ruleScopeSchema>;
}): RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (rule.matchType && rule.values) {
    const invalid = findInvalidRuleValue(rule.matchType, rule.values);
    if (invalid !== null) {
      issues.push({
        path: "values",
        message:
          rule.matchType === "ip_cidr"
            ? `Invalid CIDR: ${invalid}`
            : `Invalid ${rule.matchType} value (no whitespace or commas): ${invalid}`,
      });
    }
  }
  if (
    rule.action &&
    rule.scope &&
    !isActionAllowedForScope(rule.action, rule.scope)
  ) {
    issues.push({
      path: "action",
      message: "Server-side rules can only use the reject action",
    });
  }
  return issues;
}

function addRuleIssues(
  rule: Parameters<typeof getRuleIssues>[0],
  ctx: z.RefinementCtx,
): void {
  for (const issue of getRuleIssues(rule)) {
    ctx.addIssue({
      code: "custom",
      path: [issue.path],
      message: issue.message,
    });
  }
}

const ruleMetaSchema = z.object({
  name: z.string().trim().min(1).max(128),
  enabled: z.boolean(),
  // Omitted on create to append after the existing rules.
  sortOrder: z.number().int(),
  matchType: ruleMatchTypeSchema,
  values: z
    .array(z.string().max(255))
    .transform(normalizeRuleValues)
    .pipe(z.array(z.string().min(1)).min(1).max(500)),
  action: ruleActionSchema,
  scope: ruleScopeSchema,
});

export const createRuleSchema = ruleMetaSchema
  .extend({
    enabled: ruleMetaSchema.shape.enabled.default(true),
    sortOrder: ruleMetaSchema.shape.sortOrder.optional(),
    scope: ruleMetaSchema.shape.scope.default("client"),
  })
  .superRefine(addRuleIssues);

export const updateRuleSchema = ruleMetaSchema
  .partial()
  .extend({ id: z.string().min(1) })
  .superRefine(addRuleIssues);

export type CreateRuleInput = z.infer<typeof createRuleSchema>;
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;

export const ruleIdSchema = z.object({ id: z.string().min(1) });

/** Full desired order, first = evaluated first; rewrites every `sortOrder`. */
export const reorderRulesSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Duplicate rule id",
    }),
});
