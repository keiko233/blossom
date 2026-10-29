import { z } from "zod";

import type {
  RoutingRule,
  RuleAction,
  RuleMatchType,
  RuleScope,
} from "@/db/rule-schema";

/**
 * Pure routing-rule helpers: value normalization/validation shared by the
 * admin input schema and the compilers, and the two compilers themselves.
 * `toClashRules` feeds the subscription's Clash `rules`, `toSingboxRouteRules`
 * the server-side sing-box `route.rules`. Neither touches the database — the
 * callers load the enabled rows and pass them in.
 */

/** The subset of a `routing_rule` row the compilers need. */
export type CompilableRule = Pick<
  RoutingRule,
  | "id"
  | "enabled"
  | "sortOrder"
  | "matchType"
  | "values"
  | "action"
  | "scope"
  | "createdAt"
>;

/** A sing-box route rule in rule-action syntax (sing-box >= 1.11). */
export type SingboxRouteRule = Partial<Record<RuleMatchType, string[]>> & {
  action: "reject";
};

/** Select group name in `buildClashConfig` that `proxy` rules point at. */
const CLASH_PROXY_GROUP = "PROXY";

const CLASH_MATCH_KEYWORDS: Record<
  Exclude<RuleMatchType, "ip_cidr">,
  string
> = {
  domain: "DOMAIN",
  domain_suffix: "DOMAIN-SUFFIX",
  domain_keyword: "DOMAIN-KEYWORD",
};

const CLASH_ACTIONS: Record<RuleAction, string> = {
  direct: "DIRECT",
  proxy: CLASH_PROXY_GROUP,
  reject: "REJECT",
};

/** Whether the scope reaches the servers' sing-box config. */
export function isServerScope(scope: RuleScope): boolean {
  return scope === "server" || scope === "both";
}

/** Whether the scope reaches the Clash subscription. */
export function isClientScope(scope: RuleScope): boolean {
  return scope === "client" || scope === "both";
}

/**
 * Server-side rules run in sing-box whose only outbound is `direct`, so the
 * only meaningful server action is `reject`.
 */
export function isActionAllowedForScope(
  action: RuleAction,
  scope: RuleScope,
): boolean {
  return !isServerScope(scope) || action === "reject";
}

/** Trims, drops blanks and removes duplicates, keeping first-seen order. */
export function normalizeRuleValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (value) {
      seen.add(value);
    }
  }
  return [...seen];
}

/** Splits a one-value-per-line textarea into normalized values. */
export function parseRuleValuesText(text: string): string[] {
  return normalizeRuleValues(text.split(/\r?\n/));
}

/** IP family of a CIDR string (`10.0.0.0/8`, `fd00::/8`), or null if invalid. */
export function cidrFamily(value: string): 4 | 6 | null {
  if (z.cidrv4().safeParse(value).success) {
    return 4;
  }
  if (z.cidrv6().safeParse(value).success) {
    return 6;
  }
  return null;
}

/**
 * Whether one (already trimmed) value is acceptable for the match type.
 * Domain-style values must be non-empty with no whitespace and no commas — a
 * comma would split the generated Clash rule string.
 */
export function isValidRuleValue(
  matchType: RuleMatchType,
  value: string,
): boolean {
  if (matchType === "ip_cidr") {
    return cidrFamily(value) !== null;
  }
  return value.length > 0 && !/[\s,]/.test(value);
}

/** First value that is invalid for the match type, or null when all are fine. */
export function findInvalidRuleValue(
  matchType: RuleMatchType,
  values: readonly string[],
): string | null {
  return values.find((value) => !isValidRuleValue(matchType, value)) ?? null;
}

function compareRules(a: CompilableRule, b: CompilableRule): number {
  return (
    a.sortOrder - b.sortOrder ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Values that survive validation; stored rows are validated on write already. */
function usableValues(rule: CompilableRule): string[] {
  return normalizeRuleValues(rule.values).filter((value) =>
    isValidRuleValue(rule.matchType, value),
  );
}

/**
 * Compiles enabled `client`/`both` rules into Clash rule strings, evaluated in
 * `sortOrder` order (ties: createdAt, then id). One line per value.
 */
export function toClashRules(rules: readonly CompilableRule[]): string[] {
  return rules
    .filter((rule) => rule.enabled && isClientScope(rule.scope))
    .sort(compareRules)
    .flatMap((rule) => {
      const action = CLASH_ACTIONS[rule.action];
      return usableValues(rule).map((value) => {
        if (rule.matchType === "ip_cidr") {
          const keyword = cidrFamily(value) === 6 ? "IP-CIDR6" : "IP-CIDR";
          return `${keyword},${value},${action},no-resolve`;
        }
        return `${CLASH_MATCH_KEYWORDS[rule.matchType]},${value},${action}`;
      });
    });
}

/**
 * Compiles enabled `server`/`both` rules into sing-box route rules. Only
 * `reject` is emitted (the server's sole outbound is `direct`); a stored rule
 * with any other action is skipped rather than producing a rule sing-box would
 * route nowhere. One route rule per source rule, in `sortOrder` order.
 */
export function toSingboxRouteRules(
  rules: readonly CompilableRule[],
): SingboxRouteRule[] {
  return rules
    .filter(
      (rule) =>
        rule.enabled && isServerScope(rule.scope) && rule.action === "reject",
    )
    .sort(compareRules)
    .flatMap((rule) => {
      const values = usableValues(rule);
      return values.length > 0
        ? [{ [rule.matchType]: values, action: "reject" as const }]
        : [];
    });
}
