import type { RuleAction, RuleMatchType, RuleScope } from "@/db/rule-schema";
import { m } from "@/paraglide/messages";

export const MATCH_TYPE_LABELS: Record<RuleMatchType, () => string> = {
  domain: () => m.admin_rules_match_domain(),
  domain_suffix: () => m.admin_rules_match_domain_suffix(),
  domain_keyword: () => m.admin_rules_match_domain_keyword(),
  ip_cidr: () => m.admin_rules_match_ip_cidr(),
};

export const ACTION_LABELS: Record<RuleAction, () => string> = {
  direct: () => m.admin_rules_action_direct(),
  proxy: () => m.admin_rules_action_proxy(),
  reject: () => m.admin_rules_action_reject(),
};

export const SCOPE_LABELS: Record<RuleScope, () => string> = {
  client: () => m.admin_rules_scope_client(),
  server: () => m.admin_rules_scope_server(),
  both: () => m.admin_rules_scope_both(),
};
