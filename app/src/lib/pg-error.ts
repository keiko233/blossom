const UNIQUE_VIOLATION = "23505";

/**
 * Whether an error is a PostgreSQL unique-constraint violation. Drivers
 * differ: node-postgres throws the `DatabaseError` itself, Drizzle may wrap it
 * (`cause`), and neon-http reports the SQLSTATE the same way. Walks the
 * `cause` chain looking for SQLSTATE 23505.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (
      typeof current === "object" &&
      "code" in current &&
      (current as { code?: unknown }).code === UNIQUE_VIOLATION
    ) {
      return true;
    }
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}
