import { describe, expect, it } from "vitest";

import {
  formatRedeemCode,
  generateRedeemCode,
  hashRedeemCode,
  isWellFormedRedeemCode,
  normalizeRedeemCode,
  randomRedeemSymbols,
  REDEEM_CODE_ALPHABET,
  REDEEM_CODE_ENTROPY_BITS,
  REDEEM_CODE_LENGTH,
  REDEEM_CODE_LOOKALIKES,
  REDEEM_CODE_PREFIX_LENGTH,
} from "./redeem-code";

describe("alphabet", () => {
  it("has no ambiguous characters and no duplicates", () => {
    for (const char of "01ILO") {
      expect(REDEEM_CODE_ALPHABET).not.toContain(char);
    }
    expect(new Set(REDEEM_CODE_ALPHABET).size).toBe(
      REDEEM_CODE_ALPHABET.length,
    );
    expect(REDEEM_CODE_ALPHABET).toMatch(/^[2-9A-Z]+$/);
  });

  it("gives at least ~80 bits of entropy per code", () => {
    expect(REDEEM_CODE_ENTROPY_BITS).toBeGreaterThanOrEqual(80);
  });
});

describe("generateRedeemCode", () => {
  it("formats as four dash-separated groups of five alphabet symbols", () => {
    const { code } = generateRedeemCode();
    expect(code).toMatch(
      /^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/,
    );
    expect(isWellFormedRedeemCode(normalizeRedeemCode(code))).toBe(true);
  });

  it("only ever emits alphabet characters", () => {
    for (let i = 0; i < 500; i++) {
      for (const char of normalizeRedeemCode(generateRedeemCode().code)) {
        expect(REDEEM_CODE_ALPHABET).toContain(char);
      }
    }
  });

  it("hashes the normalized form and exposes a display prefix", () => {
    const { code, hash, prefix } = generateRedeemCode();
    const normalized = normalizeRedeemCode(code);
    expect(hash).toBe(hashRedeemCode(normalized));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(prefix).toBe(normalized.slice(0, REDEEM_CODE_PREFIX_LENGTH));
    // The hash never contains the plaintext.
    expect(hash).not.toContain(normalized);
  });

  it("is unique across a large sample", () => {
    const codes = new Set<string>();
    const hashes = new Set<string>();
    for (let i = 0; i < 20_000; i++) {
      const generated = generateRedeemCode();
      codes.add(generated.code);
      hashes.add(generated.hash);
    }
    expect(codes.size).toBe(20_000);
    expect(hashes.size).toBe(20_000);
  });
});

describe("normalizeRedeemCode", () => {
  it("round-trips a generated code however it is typed", () => {
    const { code, hash } = generateRedeemCode();
    const normalized = normalizeRedeemCode(code);
    expect(normalized).toHaveLength(REDEEM_CODE_LENGTH);
    expect(formatRedeemCode(normalized)).toBe(code);

    const variants = [
      code.toLowerCase(),
      code.replaceAll("-", ""),
      code.replaceAll("-", " "),
      `  ${code}\n`,
      code.replaceAll("-", "–"),
      code.replaceAll("-", "‑"),
      code.replaceAll("-", "_"),
      code.toLowerCase().replaceAll("-", " - "),
    ];
    for (const variant of variants) {
      expect(normalizeRedeemCode(variant), variant).toBe(normalized);
      expect(hashRedeemCode(normalizeRedeemCode(variant))).toBe(hash);
    }
  });

  it("folds full-width characters", () => {
    expect(normalizeRedeemCode("ＡＢＣ２３")).toBe("ABC23");
  });

  it("maps no lookalikes: the ambiguous characters are not in the alphabet", () => {
    expect(REDEEM_CODE_LOOKALIKES).toEqual({});
    for (const char of "01ILO") {
      // Left as is, so the code is rejected rather than silently rewritten.
      expect(normalizeRedeemCode(char)).toBe(char);
      expect(isWellFormedRedeemCode(`ABCDE${char}`.padEnd(20, "2"))).toBe(
        false,
      );
    }
  });
});

describe("isWellFormedRedeemCode", () => {
  it("checks length and alphabet", () => {
    expect(isWellFormedRedeemCode("ABCDE23456FGHJK78MNP")).toBe(true);
    expect(isWellFormedRedeemCode("ABCDE23456FGHJK78MN")).toBe(false);
    expect(isWellFormedRedeemCode("ABCDE23456FGHJK78MNPQ")).toBe(false);
    expect(isWellFormedRedeemCode("ABCDE23456FGHJK78MN0")).toBe(false);
    expect(isWellFormedRedeemCode("")).toBe(false);
  });
});

describe("randomRedeemSymbols (no modulo bias)", () => {
  it("is uniform over the alphabet", () => {
    const symbols = 310_000;
    const counts = new Map<string, number>();
    const sample = randomRedeemSymbols(symbols);
    expect(sample).toHaveLength(symbols);
    for (const char of sample) counts.set(char, (counts.get(char) ?? 0) + 1);

    const expected = symbols / REDEEM_CODE_ALPHABET.length;
    expect(counts.size).toBe(REDEEM_CODE_ALPHABET.length);
    // Chi-square against a uniform distribution; df = 30, the 99.99% critical
    // value is ~63, so this fails for any real bias yet essentially never for
    // a correct sampler.
    let chiSquare = 0;
    for (const char of REDEEM_CODE_ALPHABET) {
      const observed = counts.get(char) ?? 0;
      chiSquare += (observed - expected) ** 2 / expected;
    }
    expect(chiSquare).toBeLessThan(63);
  });

  it("discards bytes that would cause modulo bias", () => {
    const size = REDEEM_CODE_ALPHABET.length;
    const limit = 256 - (256 % size);
    // Bytes in [limit, 255] are rejected, so with only those the sampler would
    // never finish; feed them first and then one good byte per round.
    let round = 0;
    const out = randomRedeemSymbols(1, (n) => {
      round += 1;
      const bytes = new Uint8Array(n).fill(255);
      if (round > 1) bytes[0] = 0;
      return bytes;
    });
    expect(round).toBe(2);
    expect(out).toBe(REDEEM_CODE_ALPHABET[0]);
    expect(limit).toBeLessThan(256);
  });

  it("maps every accepted byte value exactly evenly", () => {
    const size = REDEEM_CODE_ALPHABET.length;
    const limit = 256 - (256 % size);
    const counts = new Map<string, number>();
    for (let byte = 0; byte < limit; byte++) {
      const symbol = randomRedeemSymbols(1, () => new Uint8Array(8).fill(byte));
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }
    expect(new Set(counts.values()).size).toBe(1);
  });
});
