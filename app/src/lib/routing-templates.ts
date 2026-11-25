/**
 * Pure routing-policy templates for the flexible relay topology.
 *
 * Templates only build `ManagedIntentRouteRule[]` and a final outbound tag. They
 * never read the database or the catalog: callers pass the runtime tags and
 * imported rule-set ids they actually have, and the result reports what is
 * missing so the UI can offer a one-click import.
 */
import type { ManagedIntentRouteRule } from "@blossom/contracts/agent-config-v3";
import { managedRuntimeTag } from "@blossom/domain/managed-networking";

import { findCuratedRuleSetEntry } from "./rule-set-catalog";

export const ROUTING_TEMPLATE_IDS = [
  "full_forward",
  "speedtest_and_quality_split",
  "cn_direct_intl_exit",
] as const;

export type RoutingTemplateId = (typeof ROUTING_TEMPLATE_IDS)[number];

/** GeoIP/Geosite sets that identify traffic needing a high-quality exit IP. */
export const HIGH_IP_QUALITY_RULE_SET_IDS = [
  "geosite-openai",
  "geosite-anthropic",
  "geosite-netflix",
  "geosite-disney",
] as const;

/** Rules that keep private and mainland traffic on the local direct egress. */
export const CN_DIRECT_RULE_SET_IDS = [
  "geoip-private",
  "geosite-private",
  "geosite-cn",
  "geoip-cn",
] as const;

export const SPEEDTEST_RULE_SET_ID = "geosite-category-speedtest";

export const BUILTIN_DIRECT_OUTBOUND_TAG = "direct";

const MAX_RUNTIME_TAG_LENGTH = 128;

export const ROUTING_TEMPLATE_ISSUE_CODES = [
  "inbound_tags_required",
  "invalid_inbound_tag",
  "inbound_not_found",
  "invalid_outbound_tag",
  "outbound_not_found",
  "invalid_rule_set_id",
  "rule_set_not_imported",
  "unknown_rule_set",
] as const;

export type RoutingTemplateIssueCode =
  (typeof ROUTING_TEMPLATE_ISSUE_CODES)[number];

export interface RoutingTemplateIssue {
  code: RoutingTemplateIssueCode;
  params: Record<string, string>;
}

interface RoutingTemplateBaseInput {
  /** Subscriber inbound runtime tags (`node-<id>`) the template applies to. */
  inboundTags: readonly string[];
  /** Outbound runtime tags available on this server (`direct` is implicit). */
  availableOutboundTags: readonly string[];
  /** Rule-set ids already imported into `managed_rule_set_asset`. */
  availableRuleSetIds?: readonly string[];
  /** When supplied, every inbound tag must be one of them. */
  availableInboundTags?: readonly string[];
}

export interface FullForwardTemplateInput extends RoutingTemplateBaseInput {
  template: "full_forward";
  exitOutboundTag: string;
  /** Whether the exit outbound carries UDP. Without it the final stays direct. */
  supportsUdp: boolean;
}

export interface SpeedtestQualityTemplateInput extends RoutingTemplateBaseInput {
  template: "speedtest_and_quality_split";
  fastOutboundTag: string;
  qualityOutboundTag: string;
  /** Final outbound for traffic matching no template rule. */
  defaultOutboundTag: string;
  /** Defaults to `HIGH_IP_QUALITY_RULE_SET_IDS`. */
  qualityRuleSetIds?: readonly string[];
}

export interface CnDirectTemplateInput extends RoutingTemplateBaseInput {
  template: "cn_direct_intl_exit";
  exitOutboundTag: string;
  /** Defaults to the built-in `direct` outbound. */
  directOutboundTag?: string;
  /** Without UDP support the catch-all rule carries TCP only. Defaults true. */
  supportsUdp?: boolean;
}

export type RoutingTemplateBuildInput =
  | FullForwardTemplateInput
  | SpeedtestQualityTemplateInput
  | CnDirectTemplateInput;

export interface RoutingTemplateResult {
  ok: boolean;
  template: RoutingTemplateId;
  rules: ManagedIntentRouteRule[];
  finalOutboundTag: string;
  /** Importable catalog ids the template needs but the server has not imported. */
  missingRuleSetIds: string[];
  /** Referenced outbound tags that are not materialized on this server. */
  missingOutboundTags: string[];
  issues: RoutingTemplateIssue[];
}

function isValidRuntimeTag(tag: string): boolean {
  return (
    tag.length > 0 && tag.length <= MAX_RUNTIME_TAG_LENGTH && !/\s/.test(tag)
  );
}

function routeRule(
  ruleId: string,
  inboundTags: string[],
  options: {
    outboundTag: string;
    sniff?: boolean;
    resolveStrategy?: ManagedIntentRouteRule["resolveStrategy"];
    ruleSetTags?: string[];
    network?: ManagedIntentRouteRule["network"];
  },
): ManagedIntentRouteRule {
  return {
    ruleId: ruleId.slice(0, MAX_RUNTIME_TAG_LENGTH),
    inboundTags,
    sniff: options.sniff ?? false,
    resolveStrategy: options.resolveStrategy ?? null,
    network: options.network ?? null,
    domains: [],
    domainSuffixes: [],
    domainKeywords: [],
    ipCidrs: [],
    ports: [],
    portRanges: [],
    protocols: [],
    invert: false,
    ruleSetTags: options.ruleSetTags ?? [],
    action: "route",
    outboundTag: options.outboundTag,
  };
}

interface TemplateValidation {
  inboundTags: string[];
  availableOutbounds: Set<string>;
  availableRuleSets: Set<string>;
  missingOutboundTags: string[];
  missingRuleSetIds: string[];
  issues: RoutingTemplateIssue[];
}

function validateBase(input: RoutingTemplateBaseInput): TemplateValidation {
  const issues: RoutingTemplateIssue[] = [];
  const inboundTags: string[] = [];
  const seenInbounds = new Set<string>();
  for (const tag of input.inboundTags) {
    if (!isValidRuntimeTag(tag)) {
      issues.push({ code: "invalid_inbound_tag", params: { tag } });
      continue;
    }
    if (seenInbounds.has(tag)) continue;
    seenInbounds.add(tag);
    inboundTags.push(tag);
  }
  if (inboundTags.length === 0 && issues.length === 0) {
    issues.push({ code: "inbound_tags_required", params: {} });
  }

  const availableInbounds = input.availableInboundTags
    ? new Set(input.availableInboundTags)
    : null;
  if (availableInbounds) {
    for (const tag of inboundTags) {
      if (!availableInbounds.has(tag)) {
        issues.push({ code: "inbound_not_found", params: { tag } });
      }
    }
  }

  return {
    inboundTags,
    availableOutbounds: new Set([
      BUILTIN_DIRECT_OUTBOUND_TAG,
      ...input.availableOutboundTags,
    ]),
    availableRuleSets: new Set(input.availableRuleSetIds ?? []),
    missingOutboundTags: [],
    missingRuleSetIds: [],
    issues,
  };
}

function requireOutbound(validation: TemplateValidation, tag: string): void {
  if (!isValidRuntimeTag(tag)) {
    validation.issues.push({
      code: "invalid_outbound_tag",
      params: { tag },
    });
    return;
  }
  if (!validation.availableOutbounds.has(tag)) {
    validation.missingOutboundTags.push(tag);
    validation.issues.push({ code: "outbound_not_found", params: { tag } });
  }
}

function requireRuleSets(
  validation: TemplateValidation,
  ids: readonly string[],
): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (id.length === 0 || id.length > 64 || /[\s/]/.test(id)) {
      validation.issues.push({
        code: "invalid_rule_set_id",
        params: { ruleSet: id },
      });
      continue;
    }
    const runtimeTag = managedRuntimeTag("rule_set", id);
    tags.push(runtimeTag);
    if (validation.availableRuleSets.has(id)) continue;
    validation.missingRuleSetIds.push(id);
    validation.issues.push({
      code: findCuratedRuleSetEntry(id)
        ? "rule_set_not_imported"
        : "unknown_rule_set",
      params: { ruleSet: id },
    });
  }
  return tags;
}

/**
 * Builds one routing-policy template. The result is deterministic and contains
 * no DB, network or agent input; callers merge `rules` into a draft and persist
 * `finalOutboundTag` beside them.
 */
export function buildRoutingTemplate(
  input: RoutingTemplateBuildInput,
): RoutingTemplateResult {
  const validation = validateBase(input);
  const { inboundTags } = validation;
  const rules: ManagedIntentRouteRule[] = [];
  let finalOutboundTag = BUILTIN_DIRECT_OUTBOUND_TAG;

  if (input.template === "full_forward") {
    requireOutbound(validation, input.exitOutboundTag);
    if (inboundTags.length > 0) {
      if (input.supportsUdp) {
        // The compiler rejects a UDP-incapable final outbound, so a UDP-capable
        // exit can consume every network in `route.final`.
        finalOutboundTag = input.exitOutboundTag;
      } else {
        // Keep `direct` final so the compiler emits a TCP route plus a UDP
        // reject for these inbounds.
        finalOutboundTag = BUILTIN_DIRECT_OUTBOUND_TAG;
        rules.push(
          ...inboundTags.map((tag, index) =>
            routeRule(`template-full-forward-${index}`, [tag], {
              outboundTag: input.exitOutboundTag,
            }),
          ),
        );
      }
    }
  } else if (input.template === "speedtest_and_quality_split") {
    requireOutbound(validation, input.fastOutboundTag);
    requireOutbound(validation, input.qualityOutboundTag);
    requireOutbound(validation, input.defaultOutboundTag);
    finalOutboundTag = input.defaultOutboundTag;

    if (inboundTags.length > 0) {
      const qualityIds =
        input.qualityRuleSetIds ?? HIGH_IP_QUALITY_RULE_SET_IDS;
      const speedtestTags = requireRuleSets(validation, [
        SPEEDTEST_RULE_SET_ID,
      ]);
      const qualityTags = requireRuleSets(validation, qualityIds);
      rules.push(
        routeRule("template-speedtest", inboundTags, {
          outboundTag: input.fastOutboundTag,
          sniff: true,
          ruleSetTags: speedtestTags,
        }),
      );
      if (qualityTags.length > 0) {
        rules.push(
          routeRule("template-high-ip-quality", inboundTags, {
            outboundTag: input.qualityOutboundTag,
            sniff: true,
            ruleSetTags: qualityTags,
          }),
        );
      }
    }
  } else {
    requireOutbound(validation, input.exitOutboundTag);
    requireOutbound(
      validation,
      input.directOutboundTag ?? BUILTIN_DIRECT_OUTBOUND_TAG,
    );
    finalOutboundTag = input.exitOutboundTag;
    const directOutbound =
      input.directOutboundTag ?? BUILTIN_DIRECT_OUTBOUND_TAG;

    if (inboundTags.length > 0) {
      const directTags = requireRuleSets(validation, CN_DIRECT_RULE_SET_IDS);
      rules.push(
        routeRule("template-cn-direct", inboundTags, {
          outboundTag: directOutbound,
          sniff: true,
          resolveStrategy: "prefer_ipv4",
          ruleSetTags: directTags,
        }),
      );
      if (input.supportsUdp === false) {
        // Mirror full-forward: the compiler rejects a TCP-only `route.final`,
        // so scope the exit catch-all to these inbounds and keep direct final.
        finalOutboundTag = BUILTIN_DIRECT_OUTBOUND_TAG;
        rules.push(
          routeRule("template-cn-intl-exit", inboundTags, {
            outboundTag: input.exitOutboundTag,
          }),
        );
      }
    }
  }

  return {
    ok: validation.issues.length === 0,
    template: input.template,
    rules,
    finalOutboundTag,
    missingRuleSetIds: validation.missingRuleSetIds,
    missingOutboundTags: validation.missingOutboundTags,
    issues: validation.issues,
  };
}
