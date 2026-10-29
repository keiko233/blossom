import { m } from "@/paraglide/messages";

const TARGET_LABELS: Record<string, () => string> = {
  user: () => m.admin_audit_target_user(),
  user_note: () => m.admin_audit_target_user_note(),
  subscription: () => m.admin_audit_target_subscription(),
  plan: () => m.admin_audit_target_plan(),
  group: () => m.admin_audit_target_group(),
  node: () => m.admin_audit_target_node(),
  server: () => m.admin_audit_target_server(),
  certificate: () => m.admin_audit_target_certificate(),
  rule: () => m.admin_audit_target_rule(),
  announcement: () => m.admin_audit_target_announcement(),
  redeem_batch: () => m.admin_audit_target_redeem_batch(),
  redeem_code: () => m.admin_audit_target_redeem_code(),
  audit_log: () => m.admin_audit_target_audit_log(),
  setting: () => m.admin_audit_target_setting(),
};

/** Display name of a stored target type; unknown types are shown as stored. */
export function targetTypeLabel(type: string): string {
  return TARGET_LABELS[type]?.() ?? type;
}

const STATUS_LABELS: Record<string, () => string> = {
  success: () => m.admin_audit_status_success(),
  error: () => m.admin_audit_status_error(),
  timeout: () => m.admin_audit_status_timeout(),
};

export function auditStatusLabel(status: string): string {
  return STATUS_LABELS[status]?.() ?? status;
}
