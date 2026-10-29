export const REDACTED = "<redacted>";

// Key names whose values are never kept. Covers credentials, private key and
// certificate material (`privateKeyPem`, `fullchainPem`, ...), and session
// cookies.
const SENSITIVE_KEY_RE =
  /token|password|passphrase|secret|authorization|api[_-]?key|credential|private[_-]?key|cookie|pem$/i;
const SENSITIVE_VALUE_RE =
  /((?:token|password|passphrase|secret|authorization|api[_-]?key|credential)\s*[:=]\s*)[^\s,;}]+/gi;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
// A PEM block inside free text; an unterminated one is cut to the end.
const PEM_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g;

const MAX_DEPTH = 10;
const MAX_SERIALIZED_BYTES = 4096;

export interface RedactOptions {
  /** Strings longer than this are cut and marked with the dropped length. */
  maxStringLength?: number;
  /** Arrays longer than this keep the first items plus a count marker. */
  maxArrayItems?: number;
}

/** Scrubs secrets embedded in free text and optionally cuts it to length. */
export function redactString(value: string, maxLength?: number): string {
  const scrubbed = value
    .replace(PEM_BLOCK_RE, REDACTED)
    .replace(BEARER_RE, `$1${REDACTED}`)
    .replace(SENSITIVE_VALUE_RE, `$1${REDACTED}`);
  if (maxLength === undefined || scrubbed.length <= maxLength) {
    return scrubbed;
  }
  return `${scrubbed.slice(0, maxLength)}…(+${scrubbed.length - maxLength} chars)`;
}

function redactTree(
  value: unknown,
  depth: number,
  options: RedactOptions,
): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return redactString(value, options.maxStringLength);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    const { maxArrayItems } = options;
    const kept =
      maxArrayItems !== undefined && value.length > maxArrayItems
        ? value.slice(0, maxArrayItems)
        : value;
    const items = kept.map((v) => redactTree(v, depth + 1, options));
    if (kept.length < value.length) {
      items.push(`…(+${value.length - kept.length} more)`);
    }
    return items;
  }

  if (value instanceof Date) return value.toISOString();

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      result[key] = REDACTED;
    } else {
      result[key] = redactTree(val, depth + 1, options);
    }
  }
  return result;
}

/**
 * Redacted copy of any value, safe to store as JSON: secret-looking keys and
 * embedded secrets are replaced, long strings and arrays are cut, and a result
 * that still serializes beyond `maxBytes` collapses to a truncated preview.
 */
export function redactToJson(
  value: unknown,
  options: RedactOptions & { maxBytes?: number } = {},
): unknown {
  const { maxBytes = MAX_SERIALIZED_BYTES, ...treeOptions } = options;
  const redacted = redactTree(value, 0, treeOptions);
  const json = JSON.stringify(redacted);
  if (json === undefined) return null;
  const bytes = new TextEncoder().encode(json);
  if (bytes.length <= maxBytes) return redacted;
  const preview = new TextDecoder().decode(bytes.slice(0, maxBytes));
  return { _truncated: true, _preview: preview };
}

export function redact(
  value: unknown,
  maxBytes = MAX_SERIALIZED_BYTES,
): string {
  return JSON.stringify(redactToJson(value, { maxBytes }));
}
