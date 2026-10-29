import { and } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import type { UserFilter } from "@/orpc/user/schema";

import {
  buildUserConditions,
  buildUserOrderBy,
  buildUserWhere,
} from "./user-filters";

const dialect = new PgDialect();
const now = new Date("2026-07-13T00:00:00Z");

const base: UserFilter = { sort: "createdAt", sortDir: "desc" };

function render(filter: Partial<UserFilter>) {
  const where = buildUserWhere({ ...base, ...filter }, now);
  return where ? dialect.sqlToQuery(where) : undefined;
}

describe("buildUserConditions", () => {
  it("adds nothing for an empty filter", () => {
    expect(buildUserConditions(base, now)).toEqual([]);
    expect(buildUserWhere(base, now)).toBeUndefined();
  });

  it("ignores a blank search", () => {
    expect(buildUserConditions({ ...base, search: "   " }, now)).toEqual([]);
  });

  it("searches name, email and id with an escaped pattern", () => {
    const query = render({ search: "a_b" });
    expect(query?.sql).toContain('"user"."name" ilike');
    expect(query?.sql).toContain('"user"."email" ilike');
    expect(query?.sql).toContain('"user"."id" ilike');
    expect(query?.params).toEqual(["%a\\_b%", "%a\\_b%", "%a\\_b%"]);
  });

  it("filters admins by exact role", () => {
    const query = render({ role: "admin" });
    expect(query?.sql).toBe('"user"."role" = $1');
    expect(query?.params).toEqual(["admin"]);
  });

  it("counts a null role as a plain user", () => {
    const query = render({ role: "user" });
    expect(query?.sql).toContain('"user"."role" is null');
    expect(query?.sql).toContain('"user"."role" <> $1');
    expect(query?.params).toEqual(["admin"]);
  });

  it("banned matches the stored flag", () => {
    const query = render({ status: "banned" });
    expect(query?.sql).toBe('"user"."banned" = $1');
    expect(query?.params).toEqual([true]);
  });

  it("active excludes banned users, treating null as not banned", () => {
    const query = render({ status: "active" });
    expect(query?.sql).toContain('"user"."banned" is null');
    expect(query?.sql).toContain('"user"."banned" = $1');
    expect(query?.params).toEqual([false]);
  });

  it("active-subscription filter is a correlated exists on unexpired rows", () => {
    const query = render({ subscription: "active" });
    expect(query?.sql).toContain("exists (select 1 from");
    expect(query?.sql).toContain('"subscription"."user_id" = "user"."id"');
    expect(query?.sql).toContain('"subscription"."expires_at" > ');
    expect(query?.sql).not.toContain("not exists");
    expect(query?.params).toContain("active");
    const cutoff = query?.params.at(-1) as Date | string;
    expect(new Date(cutoff).getTime()).toBe(now.getTime());
  });

  it("no-subscription filter negates the same exists", () => {
    const query = render({ subscription: "none" });
    expect(query?.sql).toContain("not exists (select 1 from");
  });

  it("combines conditions with and", () => {
    const conditions = buildUserConditions(
      { ...base, role: "admin", status: "banned", subscription: "none" },
      now,
    );
    expect(conditions).toHaveLength(3);
    expect(dialect.sqlToQuery(and(...conditions)!).sql).toContain(" and ");
  });
});

describe("buildUserOrderBy", () => {
  const sqlOf = (parts: ReturnType<typeof buildUserOrderBy>) =>
    parts.map((part) => dialect.sqlToQuery(part).sql).join(", ");

  it("sorts by createdAt with an id tiebreaker", () => {
    expect(sqlOf(buildUserOrderBy("createdAt", "desc"))).toBe(
      '"user"."created_at" desc, "user"."id" desc',
    );
  });

  it("sorts names case-insensitively", () => {
    expect(sqlOf(buildUserOrderBy("name", "asc"))).toBe(
      'lower("user"."name") asc, "user"."id" asc',
    );
  });

  it("sorts emails case-insensitively", () => {
    expect(sqlOf(buildUserOrderBy("email", "desc"))).toBe(
      'lower("user"."email") desc, "user"."id" desc',
    );
  });
});
