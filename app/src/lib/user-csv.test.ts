import { describe, expect, it } from "vitest";

import { USER_CSV_COLUMNS, type UserCsvRow, usersToCsv } from "./user-csv";

const row: UserCsvRow = {
  id: "u1",
  name: "Alice",
  email: "alice@example.com",
  emailVerified: true,
  role: "admin",
  banned: false,
  banReason: null,
  banExpires: null,
  subscriptionCount: 2,
  createdAt: new Date("2026-07-01T10:00:00Z"),
};

describe("usersToCsv", () => {
  it("writes the header row even with no users", () => {
    expect(usersToCsv([])).toBe(USER_CSV_COLUMNS.join(","));
  });

  it("writes one CRLF-separated line per user", () => {
    const lines = usersToCsv([row, { ...row, id: "u2" }]).split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(
      "u1,Alice,alice@example.com,true,admin,false,,,2,2026-07-01T10:00:00.000Z",
    );
  });

  it("defaults a null role to user and a null ban flag to false", () => {
    const line = usersToCsv([{ ...row, role: null, banned: null }]).split(
      "\r\n",
    )[1];
    expect(line).toContain(",true,user,false,");
  });

  it("includes the ban details", () => {
    const line = usersToCsv([
      {
        ...row,
        banned: true,
        banReason: "spam, abuse",
        banExpires: new Date("2026-08-01T00:00:00Z"),
      },
    ]).split("\r\n")[1];
    expect(line).toContain(',true,"spam, abuse",2026-08-01T00:00:00.000Z,');
  });

  it("neutralizes spreadsheet formulas in names and emails", () => {
    const line = usersToCsv([{ ...row, name: "=HYPERLINK(1)" }]).split(
      "\r\n",
    )[1];
    expect(line).toContain("u1,'=HYPERLINK(1),");
  });

  it("never exposes credential columns", () => {
    expect(USER_CSV_COLUMNS.join(",")).not.toMatch(/password|token|hash/);
  });
});
