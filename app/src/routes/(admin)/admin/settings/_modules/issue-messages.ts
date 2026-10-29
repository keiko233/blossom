import type { SettingIssueCode } from "@/lib/settings";
import { m } from "@/paraglide/messages";

/** Localized text for each validation code the settings schemas can report. */
export const SETTING_ISSUE_MESSAGES: Record<SettingIssueCode, () => string> = {
  invalid_domain: () => m.admin_settings_error_invalid_domain(),
  too_many_domains: () => m.admin_settings_error_too_many_domains(),
  plan_required: () => m.admin_settings_error_plan_required(),
  trial_days_range: () => m.admin_settings_error_trial_days_range(),
  update_interval_range: () => m.admin_settings_error_update_interval_range(),
  test_interval_range: () => m.admin_settings_error_test_interval_range(),
  port_range: () => m.admin_settings_error_port_range(),
  url_invalid: () => m.admin_settings_error_url_invalid(),
  email_invalid: () => m.admin_settings_error_email_invalid(),
  text_too_long: () => m.admin_settings_error_text_too_long(),
  no_html: () => m.admin_settings_error_no_html(),
  title_invalid: () => m.admin_settings_error_title_invalid(),
};

export function settingIssueMessage(code: string): string {
  return (
    SETTING_ISSUE_MESSAGES[code as SettingIssueCode]?.() ??
    m.admin_settings_error_invalid()
  );
}
