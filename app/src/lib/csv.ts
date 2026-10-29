/** Characters that make a spreadsheet evaluate a cell as a formula. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Escapes one CSV field (RFC 4180). Strings that start with a formula
 * character get a leading `'` so spreadsheets show them as text; numbers are
 * written as-is (a negative number is not a formula).
 */
export function escapeCsvField(
  value: string | number | boolean | Date | null | undefined,
): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  } else if (value instanceof Date) {
    text = value.toISOString();
  } else {
    text = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  }
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Joins rows into CSV text with CRLF line endings. */
export function toCsv(
  header: readonly string[],
  rows: readonly (readonly Parameters<typeof escapeCsvField>[0][])[],
): string {
  return [header, ...rows]
    .map((row) => row.map((field) => escapeCsvField(field)).join(","))
    .join("\r\n");
}
