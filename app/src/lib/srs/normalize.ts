import { srsError } from "./errors";

const DOMAIN_PATTERN = /^[a-z0-9_.-]+$/;
const SUFFIX_PATTERN = /^\.?[a-z0-9_.-]+$/;
const PORT_RANGE_PATTERN = /^(\d*):(\d*)$/;
const RE2_UNSUPPORTED = [
  /\(\?=/,
  /\(\?!/,
  /\(\?<=/,
  /\(\?<!/,
  /\(\?>/,
  /[*+?]\+/,
  /\\[1-9]/,
  /\\k</,
];

export const MAX_VALUES_PER_FIELD = 20_000;
export const MAX_VALUES_PER_RULE_SET = 50_000;
export const MAX_TOP_LEVEL_RULES = 64;
export const MAX_LOGICAL_DEPTH = 8;

export function normalizeDomain(value: string, path?: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") {
    throw srsError("invalid_domain", path, "domain is empty");
  }
  if (/[/:@?#%*\s]/.test(trimmed)) {
    throw srsError(
      "invalid_domain",
      path,
      "domain contains invalid characters",
    );
  }

  let ascii: string;
  try {
    ascii = new URL(`http://${trimmed}`).hostname;
  } catch {
    throw srsError("invalid_domain", path, "domain is not valid");
  }

  const withoutDot = ascii.endsWith(".") ? ascii.slice(0, -1) : ascii;
  const inputWithoutDot = trimmed.endsWith(".")
    ? trimmed.slice(0, -1)
    : trimmed;
  const dotCount = (text: string) => text.split(".").length - 1;
  if (
    withoutDot === "" ||
    withoutDot.length > 253 ||
    dotCount(withoutDot) !== dotCount(inputWithoutDot) ||
    withoutDot.startsWith(".") ||
    withoutDot.endsWith(".") ||
    withoutDot.includes("..") ||
    !DOMAIN_PATTERN.test(withoutDot) ||
    /[/:@?#%*\s]/.test(withoutDot)
  ) {
    throw srsError("invalid_domain", path, "domain is not valid");
  }
  if (withoutDot.split(".").some((label) => label.length > 63)) {
    throw srsError("invalid_domain", path, "domain label is too long");
  }
  return withoutDot;
}

export function normalizeDomainSuffix(value: string, path?: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") {
    throw srsError("invalid_domain", path, "domain suffix is empty");
  }

  const leadingDot = trimmed.startsWith(".");
  const withoutTrailingDot = trimmed.endsWith(".")
    ? trimmed.slice(0, -1)
    : trimmed;
  const withoutDot = leadingDot
    ? withoutTrailingDot.slice(1)
    : withoutTrailingDot;
  if (withoutDot === "" || withoutDot.startsWith(".")) {
    throw srsError("invalid_domain", path, "domain suffix is empty");
  }

  const normalized = normalizeDomain(withoutDot, path);
  if (!SUFFIX_PATTERN.test(normalized)) {
    throw srsError("invalid_domain", path, "domain suffix is not valid");
  }
  return leadingDot ? `.${normalized}` : normalized;
}

export function normalizeKeyword(value: string, path?: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "") {
    throw srsError("invalid_field", path, "keyword is empty");
  }
  if (normalized.length > 128) {
    throw srsError("invalid_field", path, "keyword is too long");
  }
  return normalized;
}

export function normalizeRegex(value: string, path?: string): string {
  const normalized = value.trim();
  if (normalized === "") {
    throw srsError("invalid_regex", path, "regular expression is empty");
  }
  if (normalized.length > 512) {
    throw srsError("invalid_regex", path, "regular expression is too long");
  }
  if (RE2_UNSUPPORTED.some((pattern) => pattern.test(normalized))) {
    throw srsError(
      "invalid_regex",
      path,
      "regular expression uses unsupported constructs",
    );
  }
  try {
    new RegExp(normalized);
  } catch {
    throw srsError(
      "invalid_regex",
      path,
      "regular expression does not compile",
    );
  }
  return normalized;
}

export function normalizeNetwork(value: string, path?: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "tcp" && normalized !== "udp" && normalized !== "icmp") {
    throw srsError("invalid_field", path, "network must be tcp, udp or icmp");
  }
  return normalized;
}

export function normalizePort(value: number | string, path?: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw srsError("invalid_port", path, "port must be between 1 and 65535");
  }
  return parsed;
}

export function normalizePortRange(value: string, path?: string): string {
  const normalized = value.trim();
  const match = PORT_RANGE_PATTERN.exec(normalized);
  if (!match) {
    throw srsError("invalid_port", path, "port range must use a:b form");
  }

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") {
    throw srsError("invalid_port", path, "port range needs a bound");
  }
  const start = rawStart === "" ? 1 : normalizePort(rawStart!, path);
  const end = rawEnd === "" ? 65_535 : normalizePort(rawEnd!, path);
  if (start > end) {
    throw srsError("invalid_port", path, "port range start exceeds end");
  }
  return `${start}:${end}`;
}

export function uniqueSorted<T extends number | string>(
  values: readonly T[],
): T[] {
  return [...new Set(values)].sort((left, right) =>
    typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left) < String(right)
        ? -1
        : String(left) > String(right)
          ? 1
          : 0,
  );
}

export function comparePortRanges(left: string, right: string): number {
  const [leftStart, leftEnd] = left.split(":").map(Number);
  const [rightStart, rightEnd] = right.split(":").map(Number);
  return leftStart! - rightStart! || leftEnd! - rightEnd!;
}
