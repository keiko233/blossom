export const SRS_ERROR_CODES = [
  "invalid_magic",
  "unsupported_version",
  "inflate_failed",
  "payload_too_large",
  "file_too_large",
  "truncated",
  "unknown_item",
  "unsupported_item",
  "unsupported_field",
  "invalid_field",
  "invalid_domain",
  "invalid_cidr",
  "invalid_port",
  "invalid_regex",
  "empty_rule",
  "too_many_values",
  "too_deep",
] as const;

export type SrsErrorCode = (typeof SRS_ERROR_CODES)[number];

export class SrsError extends Error {
  readonly code: SrsErrorCode;
  readonly path?: string;
  readonly detail?: string;

  constructor(code: SrsErrorCode, path?: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : path ? `${code}: ${path}` : code);
    this.name = "SrsError";
    this.code = code;
    this.path = path;
    this.detail = detail;
  }
}

export function srsError(
  code: SrsErrorCode,
  path?: string,
  detail?: string,
): SrsError {
  return new SrsError(code, path, detail);
}

export function isSrsError(error: unknown): error is SrsError {
  return error instanceof SrsError;
}
