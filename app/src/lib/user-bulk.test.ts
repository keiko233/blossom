import { describe, expect, it } from "vitest";

import { planUserBulk } from "./user-bulk";

describe("planUserBulk", () => {
  it("targets every id when the caller is not selected", () => {
    expect(planUserBulk(["a", "b"], "me")).toEqual({
      targets: ["a", "b"],
      skipped: [],
    });
  });

  it("skips the calling admin", () => {
    expect(planUserBulk(["a", "me", "b"], "me")).toEqual({
      targets: ["a", "b"],
      skipped: ["me"],
    });
  });

  it("deduplicates ids, keeping request order", () => {
    expect(planUserBulk(["b", "a", "b", "me", "me"], "me")).toEqual({
      targets: ["b", "a"],
      skipped: ["me"],
    });
  });

  it("can end up with nothing to do", () => {
    expect(planUserBulk(["me"], "me")).toEqual({
      targets: [],
      skipped: ["me"],
    });
  });
});
