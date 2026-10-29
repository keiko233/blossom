import { describe, expect, it } from "vitest";

import {
  auditSearchSchema,
  dayRangeToInstants,
  parseDay,
  searchToAdminFilter,
  searchToMcpFilter,
} from "./admin-audit-search";

describe("auditSearchSchema", () => {
  it("accepts an empty search", () => {
    expect(auditSearchSchema.parse({})).toEqual({});
  });

  it("parses valid params", () => {
    expect(
      auditSearchSchema.parse({
        tab: "mcp",
        page: 3,
        pageSize: 50,
        actor: "root@x.io",
        action: "user.",
        targetType: "user",
        targetId: "u1",
        status: "error",
        from: "2026-10-01",
        to: "2026-10-07",
        dir: "asc",
      }),
    ).toEqual({
      tab: "mcp",
      page: 3,
      pageSize: 50,
      actor: "root@x.io",
      action: "user.",
      targetType: "user",
      targetId: "u1",
      status: "error",
      from: "2026-10-01",
      to: "2026-10-07",
      dir: "asc",
    });
  });

  it("drops garbage instead of failing the page", () => {
    expect(
      auditSearchSchema.parse({
        tab: "nope",
        page: 0,
        pageSize: 7,
        status: "weird",
        from: "yesterday",
        to: "2026-02-31",
        dir: "sideways",
      }),
    ).toEqual({});
  });

  it("coerces numeric-looking text", () => {
    expect(auditSearchSchema.parse({ targetId: 12345, actor: 7 })).toEqual({
      targetId: "12345",
      actor: "7",
    });
  });
});

describe("parseDay", () => {
  it("returns local midnight for a real day", () => {
    const date = parseDay("2026-10-29");
    expect(date).toEqual(new Date(2026, 9, 29));
  });

  it("rejects impossible and malformed days", () => {
    expect(parseDay("2026-02-31")).toBeUndefined();
    expect(parseDay("2026-13-01")).toBeUndefined();
    expect(parseDay("10/29/2026")).toBeUndefined();
    expect(parseDay(undefined)).toBeUndefined();
  });
});

describe("dayRangeToInstants", () => {
  it("covers whole local days: start of from up to the day after to", () => {
    const { from, to } = dayRangeToInstants("2026-10-01", "2026-10-07");
    expect(from).toBe(new Date(2026, 9, 1).toISOString());
    expect(to).toBe(new Date(2026, 9, 8).toISOString());
  });

  it("handles month ends and open ranges", () => {
    expect(dayRangeToInstants(undefined, "2026-12-31")).toEqual({
      from: undefined,
      to: new Date(2027, 0, 1).toISOString(),
    });
    expect(dayRangeToInstants("2026-10-01", undefined)).toEqual({
      from: new Date(2026, 9, 1).toISOString(),
      to: undefined,
    });
  });
});

describe("searchToAdminFilter", () => {
  it("maps params to the server filter with defaults", () => {
    expect(searchToAdminFilter({})).toEqual({
      actor: undefined,
      action: undefined,
      targetType: undefined,
      targetId: undefined,
      status: undefined,
      from: undefined,
      to: undefined,
      sortDir: "desc",
    });
  });

  it("trims text, keeps the status and honours the sort direction", () => {
    const filter = searchToAdminFilter({
      actor: "  root ",
      action: "user.",
      targetType: "user",
      targetId: "u1",
      status: "error",
      dir: "asc",
    });
    expect(filter).toMatchObject({
      actor: "root",
      action: "user.",
      targetType: "user",
      targetId: "u1",
      status: "error",
      sortDir: "asc",
    });
  });

  it("drops the MCP-only timeout status", () => {
    expect(searchToAdminFilter({ status: "timeout" }).status).toBeUndefined();
  });
});

describe("searchToMcpFilter", () => {
  it("uses the action param as the tool prefix", () => {
    expect(
      searchToMcpFilter({ action: "list", status: "timeout", actor: "bob" }),
    ).toMatchObject({ tool: "list", status: "timeout", actor: "bob" });
  });
});
