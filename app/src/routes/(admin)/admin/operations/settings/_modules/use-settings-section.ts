import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Confirm } from "@/components/ui/confirm";
import { toastManager } from "@/components/ui/toast";
import {
  defaultSection,
  issuesByField,
  SETTING_SCHEMAS,
  type SettingSection,
  type SettingValues,
  type UpdateSettingsSectionInput,
} from "@/lib/settings";
import { m } from "@/paraglide/messages";
import {
  ADMIN_SETTINGS_QUERY_KEY,
  PUBLIC_SETTINGS_QUERY_KEY,
  updateSettingsSection,
} from "@/query/settings";

import { settingIssueMessage } from "./issue-messages";

export interface UseSettingsSectionOptions<
  S extends SettingSection,
  V extends object,
> {
  section: S;
  /** The values as currently saved (defaults merged in). */
  saved: SettingValues<S>;
  /** Saved values -> form state (strings for text/number inputs). */
  toForm: (values: SettingValues<S>) => V;
  /** Form state -> the object the section's schema validates and stores. */
  toPayload: (form: V) => unknown;
}

/** Whether a failed save was the server refusing a plan that no longer exists. */
function isPlanMissing(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Plan not found");
}

/**
 * One settings card's form: validation with localized messages, save, dirty
 * tracking and "reset to defaults". The form is re-based on the saved values
 * after each successful save, so it reads as clean until edited again.
 */
export function useSettingsSection<S extends SettingSection, V extends object>({
  section,
  saved,
  toForm,
  toPayload,
}: UseSettingsSectionOptions<S, V>) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: unknown) =>
      updateSettingsSection({
        data: { section, values } as UpdateSettingsSectionInput,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: PUBLIC_SETTINGS_QUERY_KEY }),
      ]);
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: isPlanMissing(error)
          ? m.admin_settings_error_plan_missing()
          : m.admin_settings_toast_error(),
      });
    },
  });

  /** Validates, saves and re-bases the form on what the server now holds. */
  const persist = async (payload: unknown, onSaved: (values: V) => void) => {
    const parsed = SETTING_SCHEMAS[section].parse(payload) as SettingValues<S>;
    await mutation.mutateAsync(payload);
    onSaved(toForm(parsed));
    toastManager.add({
      type: "success",
      title: m.admin_settings_toast_saved(),
    });
  };

  const form = useForm({
    defaultValues: toForm(saved),
    validators: {
      onSubmit: ({ value }) => {
        const result = SETTING_SCHEMAS[section].safeParse(toPayload(value));
        if (result.success) return undefined;
        const fields: Record<string, string> = {};
        for (const [field, code] of Object.entries(
          issuesByField(result.error),
        )) {
          fields[field] = settingIssueMessage(code);
        }
        return { fields };
      },
    },
    onSubmit: async ({ value, formApi }) => {
      try {
        await persist(toPayload(value), (next) => formApi.reset(next));
      } catch {
        // onError already reported it; keep the edits for a retry.
      }
    },
  });

  const isDirty = useStore(form.store, (state) => !state.isDefaultValue);
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);

  /** Asks first, then stores the section's defaults. */
  const reset = async () => {
    await Confirm.call({
      title: m.admin_settings_reset_title(),
      description: m.admin_settings_reset_description(),
      confirmLabel: m.admin_settings_reset_confirm(),
      cancelLabel: m.admin_settings_cancel(),
      destructive: true,
      onConfirm: () =>
        persist(defaultSection(section), (next) => form.reset(next)),
    });
  };

  return { form, isDirty, isSubmitting, reset };
}
