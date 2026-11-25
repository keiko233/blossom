import { z } from "zod";

export interface DefaultRule {
  type?: "default";
  network?: string[];
  domain?: string[];
  domain_suffix?: string[];
  domain_keyword?: string[];
  domain_regex?: string[];
  source_ip_cidr?: string[];
  ip_cidr?: string[];
  source_port?: number[];
  source_port_range?: string[];
  port?: number[];
  port_range?: string[];
  invert?: boolean;
}

export interface LogicalRule {
  type: "logical";
  mode: "and" | "or";
  rules: RuleSetRule[];
  invert?: boolean;
}

export type RuleSetRule = DefaultRule | LogicalRule;

export interface RuleSetSource {
  version?: number;
  rules: RuleSetRule[];
}

export interface SrsStats {
  rules: number;
  domains: number;
  suffixes: number;
  keywords: number;
  regexes: number;
  cidrs: number;
  ports: number;
  ranges: number;
}

export interface CompiledRuleSet {
  bytes: Uint8Array;
  version: number;
  payloadBytes: number;
  stats: SrsStats;
}

export interface SrsSummary {
  version: number;
  payloadBytes: number;
  stats: SrsStats | null;
}

export const DEFAULT_RULE_FIELDS = [
  "type",
  "network",
  "domain",
  "domain_suffix",
  "domain_keyword",
  "domain_regex",
  "source_ip_cidr",
  "ip_cidr",
  "source_port",
  "source_port_range",
  "port",
  "port_range",
  "invert",
] as const;

export const UNSUPPORTED_RULE_FIELDS = [
  "query_type",
  "process_name",
  "process_path",
  "process_path_regex",
  "package_name",
  "package_name_regex",
  "wifi_ssid",
  "wifi_bssid",
  "network_type",
  "network_is_expensive",
  "network_is_constrained",
  "network_interface_address",
  "default_interface_address",
  "adguard_domain",
] as const;

const listableStringSchema = z.union([z.string(), z.array(z.string())]);
const listablePortSchema = z.union([
  z.number(),
  z.string(),
  z.array(z.union([z.number(), z.string()])),
]);

export const defaultRuleInputSchema = z
  .object({
    type: z.literal("default").optional(),
    network: listableStringSchema.optional(),
    domain: listableStringSchema.optional(),
    domain_suffix: listableStringSchema.optional(),
    domain_keyword: listableStringSchema.optional(),
    domain_regex: listableStringSchema.optional(),
    source_ip_cidr: listableStringSchema.optional(),
    ip_cidr: listableStringSchema.optional(),
    source_port: listablePortSchema.optional(),
    source_port_range: listableStringSchema.optional(),
    port: listablePortSchema.optional(),
    port_range: listableStringSchema.optional(),
    invert: z.boolean().optional(),
  })
  .strict();

export type DefaultRuleInput = z.infer<typeof defaultRuleInputSchema>;

export interface LogicalRuleInput {
  type: "logical";
  mode: "and" | "or";
  rules: RuleSetRuleInput[];
  invert?: boolean;
}

export type RuleSetRuleInput = DefaultRuleInput | LogicalRuleInput;

export const logicalRuleInputSchema: z.ZodType<LogicalRuleInput> = z
  .object({
    type: z.literal("logical"),
    mode: z.enum(["and", "or"]),
    rules: z.array(
      z.lazy((): z.ZodType<RuleSetRuleInput> => ruleSetRuleSchema),
    ),
    invert: z.boolean().optional(),
  })
  .strict();

export const ruleSetRuleSchema: z.ZodType<RuleSetRuleInput> = z.union([
  logicalRuleInputSchema,
  defaultRuleInputSchema,
]);

export const ruleSetSourceSchema = z.union([
  z.array(ruleSetRuleSchema),
  z
    .object({
      version: z.number().optional(),
      rules: z.array(ruleSetRuleSchema),
    })
    .strict(),
]);

export const ruleSetEnvelopeSchema = z.union([
  z.array(z.unknown()),
  z
    .object({
      version: z.number().optional(),
      rules: z.array(z.unknown()),
    })
    .strict(),
]);
