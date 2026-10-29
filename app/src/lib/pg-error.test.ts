import { describe, expect, it } from "vitest";

import { isUniqueViolation } from "./pg-error";

describe("isUniqueViolation", () => {
  it("recognizes a direct SQLSTATE 23505", () => {
    expect(
      isUniqueViolation(Object.assign(new Error("dup"), { code: "23505" })),
    ).toBe(true);
  });

  it("finds it through a wrapped cause", () => {
    const inner = Object.assign(new Error("dup"), { code: "23505" });
    const outer = new Error("Failed query", { cause: inner });
    expect(isUniqueViolation(outer)).toBe(true);
  });

  it("rejects other errors and junk", () => {
    expect(
      isUniqueViolation(Object.assign(new Error("x"), { code: "23503" })),
    ).toBe(false);
    expect(isUniqueViolation(new Error("x"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });
});
