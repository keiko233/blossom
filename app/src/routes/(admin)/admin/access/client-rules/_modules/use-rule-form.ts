import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "@/components/ui/toast";
import type { RuleAction, RuleMatchType, RuleScope } from "@/db/rule-schema";
import {
  findInvalidRuleValue,
  isServerScope,
  parseRuleValuesText,
} from "@/lib/routing-rules";
import { m } from "@/paraglide/messages";
import {
  createRule,
  RULES_QUERY_KEY,
  type RuleListItem,
  updateRule,
} from "@/query/rules";

/** Values are entered one per line; `parseRuleValuesText` splits them on submit. */
export interface RuleFormValues {
  name: string;
  matchType: RuleMatchType;
  valuesText: string;
  action: RuleAction;
  scope: RuleScope;
  enabled: boolean;
}

function defaultValues(rule?: RuleListItem): RuleFormValues {
  return {
    name: rule?.name ?? "",
    matchType: rule?.matchType ?? "domain_suffix",
    valuesText: rule?.values.join("\n") ?? "",
    action: rule?.action ?? "proxy",
    scope: rule?.scope ?? "client",
    enabled: rule?.enabled ?? true,
  };
}

function toPayload(v: RuleFormValues) {
  return {
    name: v.name.trim(),
    matchType: v.matchType,
    values: parseRuleValuesText(v.valuesText),
    // Server-side rules can only reject; the dialog locks the select, this is
    // the backstop.
    action: isServerScope(v.scope) ? ("reject" as const) : v.action,
    scope: v.scope,
    enabled: v.enabled,
  };
}

/** Form-level validation with localized messages, keyed by field name. */
function validate(
  v: RuleFormValues,
): { fields: Partial<Record<keyof RuleFormValues, string>> } | undefined {
  if (!v.name.trim()) {
    return { fields: { name: m.admin_rules_validation_name() } };
  }
  const values = parseRuleValuesText(v.valuesText);
  if (values.length === 0) {
    return {
      fields: { valuesText: m.admin_rules_validation_values_required() },
    };
  }
  const invalid = findInvalidRuleValue(v.matchType, values);
  if (invalid !== null) {
    return {
      fields: {
        valuesText:
          v.matchType === "ip_cidr"
            ? m.admin_rules_validation_cidr({ value: invalid })
            : m.admin_rules_validation_domain({ value: invalid }),
      },
    };
  }
  return undefined;
}

export interface UseRuleFormOptions {
  /** Present when editing; absent for create. */
  rule?: RuleListItem;
  onSuccess: () => void;
}

/**
 * Owns the create/update mutation and the form instance for the rule dialog.
 * The dialog body mounts per open, so fresh default values apply each time.
 */
export function useRuleForm({ rule, onSuccess }: UseRuleFormOptions) {
  const queryClient = useQueryClient();
  const isEdit = Boolean(rule);

  const mutation = useMutation({
    mutationFn: async (values: RuleFormValues) => {
      const payload = toPayload(values);
      if (rule) {
        await updateRule({ data: { id: rule.id, ...payload } });
      } else {
        await createRule({ data: payload });
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: RULES_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: isEdit
          ? m.admin_rules_toast_updated()
          : m.admin_rules_toast_created(),
      });
      onSuccess();
    },
    onError: () => {
      toastManager.add({
        type: "error",
        title: m.admin_rules_toast_error(),
      });
    },
  });

  const form = useForm({
    defaultValues: defaultValues(rule),
    validators: { onSubmit: ({ value }) => validate(value) },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // onError already reported it; keep the dialog open for a retry.
      }
    },
  });

  return { form, isEdit };
}
