import { describe, expect, it } from "vitest";

import {
  searchToFilter,
  subscriptionsSearchSchema,
} from "./subscription-search";

describe("subscriptionsSearchSchema", () => {
  it("accepts an empty search", () => {
    expect(subscriptionsSearchSchema.parse({})).toEqual({});
  });

  it("keeps valid values", () => {
    expect(
      subscriptionsSearchSchema.parse({
        page: 3,
        pageSize: 50,
        q: "alice",
        status: "expired",
        stored: true,
        plan: "p1",
        expiring: 7,
        quota: "near",
        sort: "usage",
        dir: "asc",
      }),
    ).toEqual({
      page: 3,
      pageSize: 50,
      q: "alice",
      status: "expired",
      stored: true,
      plan: "p1",
      expiring: 7,
      quota: "near",
      sort: "usage",
      dir: "asc",
    });
  });

  it("drops invalid values instead of failing", () => {
    expect(
      subscriptionsSearchSchema.parse({
        page: -1,
        pageSize: 7,
        status: "bogus",
        stored: false,
        expiring: 0,
        quota: "x",
        sort: "name",
        dir: "up",
      }),
    ).toEqual({});
  });

  it("stringifies numeric queries", () => {
    expect(subscriptionsSearchSchema.parse({ q: 1234 }).q).toBe("1234");
  });
});

describe("searchToFilter", () => {
  it("applies defaults", () => {
    expect(searchToFilter({})).toEqual({
      search: undefined,
      status: undefined,
      effective: true,
      planId: undefined,
      expiringWithinDays: undefined,
      quota: undefined,
      sort: "createdAt",
      sortDir: "desc",
    });
  });

  it("maps URL names to filter names", () => {
    expect(
      searchToFilter({
        q: "  bob ",
        status: "active",
        stored: true,
        plan: "p",
        expiring: 14,
        quota: "over",
        sort: "expiresAt",
        dir: "asc",
      }),
    ).toEqual({
      search: "bob",
      status: "active",
      effective: false,
      planId: "p",
      expiringWithinDays: 14,
      quota: "over",
      sort: "expiresAt",
      sortDir: "asc",
    });
  });
});
