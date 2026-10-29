import { describe, expect, it } from "vitest";

import { searchToUserFilter, usersSearchSchema } from "./user-search";

describe("usersSearchSchema", () => {
  it("accepts an empty search", () => {
    expect(usersSearchSchema.parse({})).toEqual({});
  });

  it("keeps valid values", () => {
    const search = {
      page: 3,
      pageSize: 50,
      q: "alice",
      role: "admin",
      status: "banned",
      subscription: "none",
      sort: "email",
      dir: "asc",
    };
    expect(usersSearchSchema.parse(search)).toEqual(search);
  });

  it("drops invalid values instead of failing", () => {
    expect(
      usersSearchSchema.parse({
        page: 0,
        pageSize: 7,
        role: "root",
        status: "gone",
        subscription: "maybe",
        sort: "role",
        dir: "up",
      }),
    ).toEqual({});
  });

  it("coerces numeric-looking queries to strings", () => {
    expect(usersSearchSchema.parse({ q: 1234 }).q).toBe("1234");
  });
});

describe("searchToUserFilter", () => {
  it("applies the default sort", () => {
    expect(searchToUserFilter({})).toEqual({
      search: undefined,
      role: undefined,
      status: undefined,
      subscription: undefined,
      sort: "createdAt",
      sortDir: "desc",
    });
  });

  it("maps every param and trims the query", () => {
    expect(
      searchToUserFilter({
        q: "  bob ",
        role: "user",
        status: "active",
        subscription: "active",
        sort: "name",
        dir: "asc",
      }),
    ).toEqual({
      search: "bob",
      role: "user",
      status: "active",
      subscription: "active",
      sort: "name",
      sortDir: "asc",
    });
  });

  it("treats a blank query as no search", () => {
    expect(searchToUserFilter({ q: "   " }).search).toBeUndefined();
  });
});
