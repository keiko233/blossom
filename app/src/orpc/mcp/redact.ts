const REDACTED = "<redacted>";

const SENSITIVE_KEY_RE =
  /token|password|secret|authorization|api[_-]?key|credential/i;
const SENSITIVE_VALUE_RE =
  /((?:token|password|secret|authorization|api[_-]?key|credential)\s*[:=]\s*)[^\s,;}]+/gi;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

const MAX_DEPTH = 10;
const MAX_SERIALIZED_BYTES = 4096;

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value
      .replace(BEARER_RE, `$1${REDACTED}`)
      .replace(SENSITIVE_VALUE_RE, `$1${REDACTED}`);
  }
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, depth + 1));
  }

  if (value instanceof Date) return value.toISOString();

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      result[key] = REDACTED;
    } else {
      result[key] = redactValue(val, depth + 1);
    }
  }
  return result;
}

export function redact(
  value: unknown,
  maxBytes = MAX_SERIALIZED_BYTES,
): string {
  const redacted = redactValue(value, 0);
  const json = JSON.stringify(redacted);
  const bytes = new TextEncoder().encode(json);
  if (bytes.length <= maxBytes) return json;
  const preview = new TextDecoder().decode(bytes.slice(0, maxBytes));
  return JSON.stringify({ _truncated: true, _preview: preview });
}
