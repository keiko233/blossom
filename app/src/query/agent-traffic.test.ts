import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/query/config-change", () => ({}));

import { computeTrafficReportHash } from "./agent";

const entry = (
  subscriptionId: string,
  uplinkBytes: number,
  downlinkBytes = 0,
) => ({
  subscriptionId,
  uplinkBytes,
  downlinkBytes,
});

describe("computeTrafficReportHash", () => {
  it("ignores entry order, so a re-serialised retry matches", () => {
    expect(
      computeTrafficReportHash({ entries: [entry("a", 1), entry("b", 2)] }),
    ).toBe(
      computeTrafficReportHash({ entries: [entry("b", 2), entry("a", 1)] }),
    );
  });

  it("keeps duplicate subscription entries distinct from a merged one", () => {
    expect(
      computeTrafficReportHash({ entries: [entry("a", 1), entry("a", 1)] }),
    ).not.toBe(computeTrafficReportHash({ entries: [entry("a", 2)] }));
  });

  it.each([
    ["different bytes", { entries: [entry("a", 2)] }],
    ["different direction", { entries: [entry("a", 0, 1)] }],
    ["different subscription", { entries: [entry("b", 1)] }],
    [
      "different window",
      { windowEndedAt: "2026-10-30T00:00:00.000Z", entries: [entry("a", 1)] },
    ],
  ])("changes with %s", (_name, other) => {
    expect(computeTrafficReportHash(other)).not.toBe(
      computeTrafficReportHash({ entries: [entry("a", 1)] }),
    );
  });
});
