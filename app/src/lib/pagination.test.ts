import { describe, expect, it } from "vitest";

import { getPageCount, getPaginationRange } from "./pagination";

describe("getPageCount", () => {
  it("is at least one page", () => {
    expect(getPageCount(0, 20)).toBe(1);
  });

  it("rounds partial pages up", () => {
    expect(getPageCount(20, 20)).toBe(1);
    expect(getPageCount(21, 20)).toBe(2);
  });
});

describe("getPaginationRange", () => {
  it("lists every page when few", () => {
    expect(getPaginationRange(1, 1)).toEqual([1]);
    expect(getPaginationRange(2, 4)).toEqual([1, 2, 3, 4]);
  });

  it("collapses a long run at the end", () => {
    expect(getPaginationRange(1, 10)).toEqual([1, 2, "ellipsis", 10]);
  });

  it("collapses both sides in the middle", () => {
    expect(getPaginationRange(5, 10)).toEqual([
      1,
      "ellipsis",
      4,
      5,
      6,
      "ellipsis",
      10,
    ]);
  });

  it("shows a single skipped page instead of an ellipsis", () => {
    expect(getPaginationRange(4, 10)).toEqual([1, 2, 3, 4, 5, "ellipsis", 10]);
  });

  it("collapses a long run at the start", () => {
    expect(getPaginationRange(10, 10)).toEqual([1, "ellipsis", 9, 10]);
  });
});
