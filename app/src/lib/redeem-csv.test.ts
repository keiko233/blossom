import { describe, expect, it } from "vitest";

import {
  REDEMPTION_CSV_COLUMNS,
  redeemCodesToCsv,
  redemptionsToCsv,
} from "./redeem-csv";

describe("redeemCodesToCsv", () => {
  it("lists one code per row with the batch name", () => {
    expect(
      redeemCodesToCsv(["AAAAA-BBBBB", "CCCCC-DDDDD"], "Spring, 2026"),
    ).toBe(
      'code,batch\r\nAAAAA-BBBBB,"Spring, 2026"\r\nCCCCC-DDDDD,"Spring, 2026"',
    );
  });

  it("neutralizes spreadsheet formulas in the batch name", () => {
    expect(redeemCodesToCsv(["AAAAA"], "=1+1")).toContain("'=1+1");
  });
});

describe("redemptionsToCsv", () => {
  it("exports the prefix, never a full code", () => {
    const csv = redemptionsToCsv([
      {
        id: "r1",
        userId: "u1",
        userName: "Ann",
        userEmail: "ann@example.com",
        codePrefix: "ABCDE",
        subscriptionId: null,
        createdAt: new Date("2026-10-29T01:02:03Z"),
      },
    ]);
    const [header, row] = csv.split("\r\n");
    expect(header).toBe(REDEMPTION_CSV_COLUMNS.join(","));
    expect(row).toBe(
      "r1,u1,Ann,ann@example.com,ABCDE,,2026-10-29T01:02:03.000Z",
    );
  });
});
