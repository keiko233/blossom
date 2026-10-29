import { createHash, randomBytes } from "node:crypto";

/**
 * Redeem codes: `XXXXX-XXXXX-XXXXX-XXXXX`, drawn from an alphabet with no
 * lookalike characters. Only the SHA-256 of the normalized form is persisted
 * (same approach as agent tokens in `@/lib/agent-token`); the plaintext is
 * shown to the admin once, at generation time.
 *
 * Entropy: 20 characters over 31 symbols = 20 * log2(31) ~= 99.1 bits, so an
 * unsalted fast hash is fine (the digest of a 99-bit secret is not
 * brute-forceable), and online guessing is additionally throttled per user and
 * per IP (see `@/lib/redeem-throttle`).
 *
 * Server-only (`node:crypto`): do not import from client code.
 */

/**
 * Digits 2-9 and A-Z without I, L and O. `0`, `1`, `I`, `L` and `O` are left
 * out entirely, so no two symbols in the remaining set can be misread for one
 * another the way `0/O` or `1/I/L` are.
 */
export const REDEEM_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export const REDEEM_CODE_GROUPS = 4;
export const REDEEM_CODE_GROUP_LENGTH = 5;
export const REDEEM_CODE_LENGTH = REDEEM_CODE_GROUPS * REDEEM_CODE_GROUP_LENGTH;

/** Bits of entropy of one generated code. */
export const REDEEM_CODE_ENTROPY_BITS =
  REDEEM_CODE_LENGTH * Math.log2(REDEEM_CODE_ALPHABET.length);

/** Characters of the normalized code kept as the non-secret display prefix. */
export const REDEEM_CODE_PREFIX_LENGTH = 5;

/**
 * Lookalike folding applied by `normalizeRedeemCode`. Deliberately empty:
 * every character that could be confused (`0 O`, `1 I L`) is *not* in the
 * alphabet, so there is no valid symbol to fold it to, and folding it to some
 * other valid symbol would silently turn a typo into a different real code.
 * Such input simply fails `isWellFormedRedeemCode`. Kept as data so the tests
 * pin the decision down.
 */
export const REDEEM_CODE_LOOKALIKES: Readonly<Record<string, string>> = {};

/** Separators users type or paste: whitespace, ASCII and Unicode dashes. */
const SEPARATORS = /[\s\p{Pd}−_]+/gu;

/**
 * Canonical form of user-typed input: NFKC (folds full-width characters),
 * uppercase, separators removed. The result is what gets hashed.
 */
export function normalizeRedeemCode(input: string): string {
  const folded = input.normalize("NFKC").toUpperCase().replace(SEPARATORS, "");
  let out = "";
  for (const char of folded) {
    out += REDEEM_CODE_LOOKALIKES[char] ?? char;
  }
  return out;
}

/** Whether a normalized code has the right length and only alphabet symbols. */
export function isWellFormedRedeemCode(normalized: string): boolean {
  if (normalized.length !== REDEEM_CODE_LENGTH) return false;
  for (const char of normalized) {
    if (!REDEEM_CODE_ALPHABET.includes(char)) return false;
  }
  return true;
}

/** `ABCDE12345...` -> `ABCDE-12345-...`. */
export function formatRedeemCode(normalized: string): string {
  const groups: string[] = [];
  for (let i = 0; i < normalized.length; i += REDEEM_CODE_GROUP_LENGTH) {
    groups.push(normalized.slice(i, i + REDEEM_CODE_GROUP_LENGTH));
  }
  return groups.join("-");
}

/** SHA-256 hex digest of the normalized code: what `redeem_code.code_hash` holds. */
export function hashRedeemCode(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * `length` uniformly random alphabet symbols. Rejection sampling, not a bare
 * `byte % n`: bytes at or above the largest multiple of the alphabet size are
 * discarded, so every symbol is exactly equally likely.
 */
export function randomRedeemSymbols(
  length: number,
  random: (size: number) => Uint8Array = randomBytes,
): string {
  const size = REDEEM_CODE_ALPHABET.length;
  const limit = 256 - (256 % size);
  let out = "";
  while (out.length < length) {
    // Over-draw so one round almost always suffices (acceptance is 248/256).
    for (const byte of random(Math.max(8, (length - out.length) * 2))) {
      if (byte >= limit) continue;
      out += REDEEM_CODE_ALPHABET[byte % size];
      if (out.length === length) break;
    }
  }
  return out;
}

export interface GeneratedRedeemCode {
  /** Plaintext, formatted with dashes. Return to the admin once, never store. */
  code: string;
  /** SHA-256 of the normalized code. */
  hash: string;
  /** First symbols of the code, kept for display and search. */
  prefix: string;
}

export function generateRedeemCode(): GeneratedRedeemCode {
  const normalized = randomRedeemSymbols(REDEEM_CODE_LENGTH);
  return {
    code: formatRedeemCode(normalized),
    hash: hashRedeemCode(normalized),
    prefix: normalized.slice(0, REDEEM_CODE_PREFIX_LENGTH),
  };
}
