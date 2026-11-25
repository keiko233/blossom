import { ByteReader, ByteWriter } from "./bytes";
import { srsError } from "./errors";
import { buildIPSet, readIPSet, rangesToCidrs, writeIPSet } from "./ip-set";
import {
  MAX_LOGICAL_DEPTH,
  MAX_TOP_LEVEL_RULES,
  MAX_VALUES_PER_FIELD,
  MAX_VALUES_PER_RULE_SET,
  comparePortRanges,
  normalizeDomain,
  normalizeDomainSuffix,
  normalizeKeyword,
  normalizeNetwork,
  normalizePort,
  normalizePortRange,
  normalizeRegex,
  uniqueSorted,
} from "./normalize";
import {
  buildSuccinctSet,
  decodeDomainKeys,
  domainKeys,
  listKeys,
  readSuccinctSet,
  writeSuccinctSet,
} from "./succinct-set";
import {
  DEFAULT_RULE_FIELDS,
  UNSUPPORTED_RULE_FIELDS,
  defaultRuleInputSchema,
  logicalRuleInputSchema,
} from "./types";
import type {
  DefaultRule,
  RuleSetRule,
  RuleSetSource,
  SrsStats,
} from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type ParseContext = {
  values: number;
};

function fieldPath(path: string, field: string): string {
  return `${path}.${field}`;
}

function issuePath(base: string, path: readonly PropertyKey[]): string {
  let result = base;
  for (const part of path) {
    if (typeof part === "number") {
      result += `[${part}]`;
    } else {
      result += result === "" ? String(part) : `.${String(part)}`;
    }
  }
  return result;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function assertFieldSize(
  values: readonly unknown[],
  path: string,
  context: ParseContext,
): void {
  if (values.length > MAX_VALUES_PER_FIELD) {
    throw srsError("too_many_values", path, "too many values in field");
  }
  context.values += values.length;
  if (context.values > MAX_VALUES_PER_RULE_SET) {
    throw srsError("too_many_values", path, "too many values in rule set");
  }
}

function stringValues(value: unknown, path: string): string[] {
  return asList(value).map((entry, index) => {
    if (typeof entry !== "string") {
      throw srsError(
        "invalid_field",
        `${path}[${index}]`,
        "value must be a string",
      );
    }
    return entry;
  });
}

function sortedStrings(
  value: unknown,
  path: string,
  context: ParseContext,
  normalize: (entry: string, entryPath?: string) => string,
): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = stringValues(value, path);
  assertFieldSize(raw, path, context);
  const normalized = raw.map((entry, index) =>
    normalize(entry, `${path}[${index}]`),
  );
  return normalized.length > 0 ? uniqueSorted(normalized) : undefined;
}

function sortedPorts(
  value: unknown,
  path: string,
  context: ParseContext,
): number[] | undefined {
  if (value === undefined) return undefined;
  const raw = asList(value);
  assertFieldSize(raw, path, context);
  const normalized = raw.map((entry, index) => {
    if (typeof entry !== "number" && typeof entry !== "string") {
      throw srsError(
        "invalid_port",
        `${path}[${index}]`,
        "port must be a number",
      );
    }
    return normalizePort(entry, `${path}[${index}]`);
  });
  return normalized.length > 0 ? uniqueSorted(normalized) : undefined;
}

function sortedPortRanges(
  value: unknown,
  path: string,
  context: ParseContext,
): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = stringValues(value, path);
  assertFieldSize(raw, path, context);
  const normalized = raw.map((entry, index) =>
    normalizePortRange(entry, `${path}[${index}]`),
  );
  return normalized.length > 0
    ? uniqueSorted(normalized).sort(comparePortRanges)
    : undefined;
}

function sortedCidrs(
  value: unknown,
  path: string,
  context: ParseContext,
): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = stringValues(value, path);
  assertFieldSize(raw, path, context);
  const ranges = buildIPSet(raw, path).ranges;
  const cidrs = rangesToCidrs(ranges);
  return cidrs.length > 0 ? cidrs : undefined;
}

function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (allowedSet.has(key)) continue;
    if (isUnsupportedRuleField(key)) {
      throw srsError("unsupported_field", fieldPath(path, key));
    }
    throw srsError("invalid_field", fieldPath(path, key), "unknown field");
  }
}

function isUnsupportedRuleField(key: string): boolean {
  return (
    UNSUPPORTED_RULE_FIELDS.some((field) => field === key) ||
    key.startsWith("process_") ||
    key.startsWith("package_name") ||
    key.startsWith("wifi_") ||
    key.startsWith("network_is_")
  );
}

function parseDefaultRule(
  value: Record<string, unknown>,
  path: string,
  context: ParseContext,
): DefaultRule {
  checkKeys(value, DEFAULT_RULE_FIELDS, path);
  const parsed = defaultRuleInputSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw srsError(
      "invalid_field",
      issue ? issuePath(path, issue.path) : path,
      issue?.message,
    );
  }
  const input = parsed.data;

  const rule: DefaultRule = { type: "default" };
  const network = sortedStrings(
    input.network,
    fieldPath(path, "network"),
    context,
    normalizeNetwork,
  );
  const domain = sortedStrings(
    input.domain,
    fieldPath(path, "domain"),
    context,
    normalizeDomain,
  );
  const suffix = sortedStrings(
    input.domain_suffix,
    fieldPath(path, "domain_suffix"),
    context,
    normalizeDomainSuffix,
  );
  const keyword = sortedStrings(
    input.domain_keyword,
    fieldPath(path, "domain_keyword"),
    context,
    normalizeKeyword,
  );
  const regex = sortedStrings(
    input.domain_regex,
    fieldPath(path, "domain_regex"),
    context,
    normalizeRegex,
  );
  const sourceCidr = sortedCidrs(
    input.source_ip_cidr,
    fieldPath(path, "source_ip_cidr"),
    context,
  );
  const cidr = sortedCidrs(input.ip_cidr, fieldPath(path, "ip_cidr"), context);
  const sourcePort = sortedPorts(
    input.source_port,
    fieldPath(path, "source_port"),
    context,
  );
  const sourcePortRange = sortedPortRanges(
    input.source_port_range,
    fieldPath(path, "source_port_range"),
    context,
  );
  const port = sortedPorts(input.port, fieldPath(path, "port"), context);
  const portRange = sortedPortRanges(
    input.port_range,
    fieldPath(path, "port_range"),
    context,
  );

  const hasItems = [
    network,
    domain,
    suffix,
    keyword,
    regex,
    sourceCidr,
    cidr,
    sourcePort,
    sourcePortRange,
    port,
    portRange,
  ].some((items) => items !== undefined);
  if (!hasItems) throw srsError("empty_rule", path);

  const canonicalDomains = decodeDomainKeys(
    domainKeys(domain ?? [], suffix ?? []),
  );
  const canonicalDomain =
    canonicalDomains.domains.length > 0 ? canonicalDomains.domains : undefined;
  const canonicalSuffix =
    canonicalDomains.suffixes.length > 0
      ? canonicalDomains.suffixes
      : undefined;

  if (network) rule.network = network;
  if (canonicalDomain) rule.domain = canonicalDomain;
  if (canonicalSuffix) rule.domain_suffix = canonicalSuffix;
  if (keyword) rule.domain_keyword = keyword;
  if (regex) rule.domain_regex = regex;
  if (sourceCidr) rule.source_ip_cidr = sourceCidr;
  if (cidr) rule.ip_cidr = cidr;
  if (sourcePort) rule.source_port = sourcePort;
  if (sourcePortRange) rule.source_port_range = sourcePortRange;
  if (port) rule.port = port;
  if (portRange) rule.port_range = portRange;
  if (input.invert) rule.invert = true;
  return rule;
}

function parseLogicalRule(
  value: Record<string, unknown>,
  path: string,
  depth: number,
  context: ParseContext,
): RuleSetRule {
  checkKeys(value, ["type", "mode", "rules", "invert"], path);
  const parsed = logicalRuleInputSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw srsError(
      "invalid_field",
      issue ? issuePath(path, issue.path) : path,
      issue?.message,
    );
  }
  if (depth >= MAX_LOGICAL_DEPTH) throw srsError("too_deep", path);
  if (parsed.data.rules.length === 0) throw srsError("empty_rule", path);

  return {
    type: "logical",
    mode: parsed.data.mode,
    rules: parsed.data.rules.map((child, index) =>
      parseRule(child, `${path}.rules[${index}]`, depth + 1, context),
    ),
    ...(parsed.data.invert ? { invert: true } : {}),
  };
}

function parseRule(
  input: unknown,
  path: string,
  depth: number,
  context: ParseContext,
): RuleSetRule {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw srsError("invalid_field", path, "rule must be an object");
  }
  const value = input as Record<string, unknown>;
  const type = value.type ?? "default";
  if (type === "default") {
    return parseDefaultRule(value, path, context);
  }
  if (type === "logical") {
    return parseLogicalRule(value, path, depth, context);
  }
  throw srsError("invalid_field", fieldPath(path, "type"), "unknown rule type");
}

export function parseRuleSetSource(input: unknown): RuleSetSource {
  let rawRules: unknown[];
  if (Array.isArray(input)) {
    rawRules = input;
  } else if (typeof input === "object" && input !== null) {
    const value = input as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      if (key !== "version" && key !== "rules") {
        throw srsError("invalid_field", key, "unknown field");
      }
    }
    if (value.version !== undefined && typeof value.version !== "number") {
      throw srsError("invalid_field", "version", "version must be a number");
    }
    if (!Array.isArray(value.rules)) {
      throw srsError("invalid_field", "rules", "rules must be an array");
    }
    rawRules = value.rules;
  } else {
    throw srsError("invalid_field", undefined, "rule set must be an object");
  }
  if (rawRules.length > MAX_TOP_LEVEL_RULES) {
    throw srsError("too_many_values", "rules", "too many top-level rules");
  }

  const context: ParseContext = { values: 0 };
  return {
    rules: rawRules.map((rule, index) =>
      parseRule(rule, `rules[${index}]`, 0, context),
    ),
  };
}

function writeStringList(writer: ByteWriter, values: readonly string[]): void {
  writer.writeUvarint(values.length);
  for (const value of values) {
    const bytes = encoder.encode(value);
    writer.writeUvarint(bytes.length);
    writer.writeBytes(bytes);
  }
}

function writeU16List(writer: ByteWriter, values: readonly number[]): void {
  writer.writeUvarint(values.length);
  for (const value of values) writer.writeU16BE(value);
}

function writeDomainItem(
  writer: ByteWriter,
  domains: readonly string[],
  suffixes: readonly string[],
): void {
  const keys = domainKeys(domains, suffixes);
  if (keys.length === 0) return;
  writer.writeByte(2);
  writeSuccinctSet(writer, buildSuccinctSet(keys));
}

function writeIpItem(
  writer: ByteWriter,
  type: 5 | 6,
  values: readonly string[],
): void {
  const set = buildIPSet(values);
  if (set.ranges.length === 0) return;
  writer.writeByte(type);
  writeIPSet(writer, set);
}

function writeDefaultRule(writer: ByteWriter, rule: DefaultRule): void {
  writer.writeByte(0);
  if (rule.network && rule.network.length > 0) {
    writer.writeByte(1);
    writeStringList(writer, rule.network);
  }
  writeDomainItem(writer, rule.domain ?? [], rule.domain_suffix ?? []);
  if (rule.domain_keyword && rule.domain_keyword.length > 0) {
    writer.writeByte(3);
    writeStringList(writer, rule.domain_keyword);
  }
  if (rule.domain_regex && rule.domain_regex.length > 0) {
    writer.writeByte(4);
    writeStringList(writer, rule.domain_regex);
  }
  if (rule.source_ip_cidr && rule.source_ip_cidr.length > 0) {
    writeIpItem(writer, 5, rule.source_ip_cidr);
  }
  if (rule.ip_cidr && rule.ip_cidr.length > 0) {
    writeIpItem(writer, 6, rule.ip_cidr);
  }
  if (rule.source_port && rule.source_port.length > 0) {
    writer.writeByte(7);
    writeU16List(writer, rule.source_port);
  }
  if (rule.source_port_range && rule.source_port_range.length > 0) {
    writer.writeByte(8);
    writeStringList(writer, rule.source_port_range);
  }
  if (rule.port && rule.port.length > 0) {
    writer.writeByte(9);
    writeU16List(writer, rule.port);
  }
  if (rule.port_range && rule.port_range.length > 0) {
    writer.writeByte(10);
    writeStringList(writer, rule.port_range);
  }
  writer.writeByte(0xff);
  writer.writeByte(rule.invert ? 1 : 0);
}

function writeRule(writer: ByteWriter, rule: RuleSetRule): void {
  if (rule.type === "logical") {
    writer.writeByte(1);
    writer.writeByte(rule.mode === "and" ? 0 : 1);
    writer.writeUvarint(rule.rules.length);
    for (const child of rule.rules) writeRule(writer, child);
    writer.writeByte(rule.invert ? 1 : 0);
    return;
  }
  writeDefaultRule(writer, rule);
}

export function encodePayload(source: RuleSetSource): Uint8Array {
  const canonical = parseRuleSetSource(source);
  const writer = new ByteWriter();
  writer.writeUvarint(canonical.rules.length);
  for (const rule of canonical.rules) writeRule(writer, rule);
  return writer.toBytes();
}

function readStringList(reader: ByteReader): string[] {
  const count = reader.readUvarintNumber();
  if (count > reader.remaining) throw srsError("truncated");
  return Array.from({ length: count }, () => {
    const length = reader.readUvarintNumber();
    return decoder.decode(reader.readBytes(length));
  });
}

function readU16List(reader: ByteReader): number[] {
  const count = reader.readUvarintNumber();
  if (count > reader.remaining / 2) throw srsError("truncated");
  return Array.from({ length: count }, () => reader.readU16BE());
}

function readDomainItem(reader: ByteReader): {
  domain?: string[];
  domain_suffix?: string[];
} {
  const keys = listKeys(readSuccinctSet(reader));
  const decoded = decodeDomainKeys(keys);
  return {
    ...(decoded.domains.length > 0 ? { domain: decoded.domains } : {}),
    ...(decoded.suffixes.length > 0 ? { domain_suffix: decoded.suffixes } : {}),
  };
}

function readIpItem(reader: ByteReader): string[] {
  return rangesToCidrs(readIPSet(reader).ranges);
}

function readDefaultRule(reader: ByteReader): DefaultRule {
  const rule: DefaultRule = { type: "default" };
  const seen = new Set<number>();
  for (;;) {
    const type = reader.readU8();
    if (type === 0xff) break;
    if (type === 0) {
      throw srsError(
        "unsupported_item",
        undefined,
        "query_type is not supported",
      );
    }
    if (type > 10) {
      if (type >= 11 && type <= 23) {
        throw srsError("unsupported_item", undefined, `item type ${type}`);
      }
      throw srsError("unknown_item", undefined, `item type ${type}`);
    }
    if (seen.has(type)) {
      throw srsError("invalid_field", undefined, `duplicate item type ${type}`);
    }
    seen.add(type);
    switch (type) {
      case 1:
        rule.network = uniqueSorted(readStringList(reader));
        break;
      case 2:
        Object.assign(rule, readDomainItem(reader));
        break;
      case 3:
        rule.domain_keyword = uniqueSorted(readStringList(reader));
        break;
      case 4:
        rule.domain_regex = uniqueSorted(readStringList(reader));
        break;
      case 5:
        rule.source_ip_cidr = readIpItem(reader);
        break;
      case 6:
        rule.ip_cidr = readIpItem(reader);
        break;
      case 7:
        rule.source_port = uniqueSorted(readU16List(reader));
        break;
      case 8:
        rule.source_port_range = uniqueSorted(readStringList(reader)).sort(
          comparePortRanges,
        );
        break;
      case 9:
        rule.port = uniqueSorted(readU16List(reader));
        break;
      case 10:
        rule.port_range = uniqueSorted(readStringList(reader)).sort(
          comparePortRanges,
        );
        break;
    }
  }
  const invert = reader.readU8();
  if (invert > 1) {
    throw srsError("invalid_field", undefined, "invert must be 0 or 1");
  }
  if (invert === 1) rule.invert = true;
  return rule;
}

function readRule(reader: ByteReader, depth: number): RuleSetRule {
  const type = reader.readU8();
  if (type === 0) return readDefaultRule(reader);
  if (type !== 1)
    throw srsError("unknown_item", undefined, "unknown rule type");
  if (depth >= MAX_LOGICAL_DEPTH) throw srsError("too_deep");

  const mode = reader.readU8();
  if (mode > 1) {
    throw srsError("invalid_field", undefined, "unknown logical mode");
  }
  const count = reader.readUvarintNumber();
  if (count > reader.remaining) throw srsError("truncated");
  const rules = Array.from({ length: count }, () =>
    readRule(reader, depth + 1),
  );
  const invert = reader.readU8();
  if (invert > 1) {
    throw srsError("invalid_field", undefined, "invert must be 0 or 1");
  }
  return {
    type: "logical",
    mode: mode === 0 ? "and" : "or",
    rules,
    ...(invert === 1 ? { invert: true } : {}),
  };
}

export function decodePayload(payload: Uint8Array): RuleSetSource {
  const reader = new ByteReader(payload);
  const count = reader.readUvarintNumber();
  if (count > reader.remaining) throw srsError("truncated");
  const rules = Array.from({ length: count }, () => readRule(reader, 0));
  if (reader.remaining !== 0) {
    throw srsError("invalid_field", undefined, "trailing payload bytes");
  }
  return { rules };
}

export function computeStats(source: RuleSetSource): SrsStats {
  const stats: SrsStats = {
    rules: 0,
    domains: 0,
    suffixes: 0,
    keywords: 0,
    regexes: 0,
    cidrs: 0,
    ports: 0,
    ranges: 0,
  };

  const visit = (rule: RuleSetRule): void => {
    stats.rules++;
    if (rule.type === "logical") {
      for (const child of rule.rules) visit(child);
      return;
    }
    stats.domains += rule.domain?.length ?? 0;
    stats.suffixes += rule.domain_suffix?.length ?? 0;
    stats.keywords += rule.domain_keyword?.length ?? 0;
    stats.regexes += rule.domain_regex?.length ?? 0;
    stats.cidrs +=
      (rule.source_ip_cidr?.length ?? 0) + (rule.ip_cidr?.length ?? 0);
    stats.ports += (rule.source_port?.length ?? 0) + (rule.port?.length ?? 0);
    stats.ranges +=
      (rule.source_port_range?.length ?? 0) + (rule.port_range?.length ?? 0);
  };

  for (const rule of source.rules) visit(rule);
  return stats;
}
