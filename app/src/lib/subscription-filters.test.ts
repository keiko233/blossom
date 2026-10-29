import { and } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import type { SubscriptionFilter } from "@/orpc/plan/schema";

import {
  buildSubscriptionConditions,
  buildSubscriptionOrderBy,
  buildSubscriptionWhere,
  escapeLikePattern,
} from "./subscription-filters";

const dialect = new PgDialect();
const now = new Date("2026-07-13T00:00:00Z");

const base: SubscriptionFilter = {
  effective: true,
  sort: "createdAt",
  sortDir: "desc",
};

function render(filter: Partial<SubscriptionFilter>) {
  const where = buildSubscriptionWhere({ ...base, ...filter }, now);
  return where ? dialect.sqlToQuery(where) : undefined;
}

describe("escapeLikePattern", () => {
  it("escapes wildcards and backslashes", () => {
    expect(escapeLikePattern("50%_off\\")).toBe("50\\%\\_off\\\\");
  });

  it("leaves plain text alone", () => {
    expect(escapeLikePattern("alice")).toBe("alice");
  });
});

describe("buildSubscriptionConditions", () => {
  it("adds nothing for an empty filter", () => {
    expect(buildSubscriptionConditions(base, now)).toEqual([]);
    expect(buildSubscriptionWhere(base, now)).toBeUndefined();
  });

  it("ignores a blank search", () => {
    expect(
      buildSubscriptionConditions({ ...base, search: "   " }, now),
    ).toEqual([]);
  });

  it("searches name, email and id with an escaped pattern", () => {
    const query = render({ search: "a_b" });
    expect(query?.sql).toContain('"user"."name" ilike');
    expect(query?.sql).toContain('"user"."email" ilike');
    expect(query?.sql).toContain('"subscription"."id" ilike');
    expect(query?.params).toEqual(["%a\\_b%", "%a\\_b%", "%a\\_b%"]);
  });

  it("effective active requires an unexpired date", () => {
    const query = render({ status: "active" });
    expect(query?.sql).toContain('"subscription"."status" = $1');
    expect(query?.sql).toContain('"subscription"."expires_at" > $2');
    expect(query?.params[0]).toBe("active");
  });

  it("effective expired includes active-but-past-expiry rows", () => {
    const query = render({ status: "expired" });
    expect(query?.sql).toContain(" or ");
    expect(query?.sql).toContain('"subscription"."expires_at" <= ');
    expect(query?.params).toContain("expired");
    expect(query?.params).toContain("active");
  });

  it("stored status ignores the expiry date", () => {
    const query = render({ status: "active", effective: false });
    expect(query?.sql).not.toContain("expires_at");
    expect(query?.params).toEqual(["active"]);
  });

  it("cancelled is the stored status either way", () => {
    expect(render({ status: "cancelled" })?.params).toEqual(["cancelled"]);
  });

  it("filters by plan", () => {
    expect(render({ planId: "plan-1" })?.params).toEqual(["plan-1"]);
  });

  it("expiring window covers active subscriptions ending within N days", () => {
    const query = render({ expiringWithinDays: 3 });
    expect(query?.sql).toContain('"subscription"."expires_at" <= ');
    const cutoff = query?.params.at(-1) as Date | string;
    expect(new Date(cutoff).getTime()).toBe(
      now.getTime() + 3 * 24 * 60 * 60 * 1000,
    );
  });

  it("over quota excludes unlimited quotas", () => {
    const query = render({ quota: "over" });
    expect(query?.sql).toContain('"subscription"."traffic_quota_bytes" > ');
    expect(query?.sql).toContain(
      '"subscription"."traffic_used_bytes" >= "subscription"."traffic_quota_bytes"',
    );
  });

  it("near quota compares usage against the warning percentage", () => {
    const query = render({ quota: "near" });
    expect(query?.sql).toContain(
      '"subscription"."traffic_used_bytes" * 100 >=',
    );
  });

  it("combines conditions with and", () => {
    const conditions = buildSubscriptionConditions(
      { ...base, planId: "p", quota: "over" },
      now,
    );
    expect(conditions.length).toBeGreaterThan(2);
    expect(dialect.sqlToQuery(and(...conditions)!).sql).toContain(" and ");
  });
});

describe("buildSubscriptionOrderBy", () => {
  const sqlOf = (parts: ReturnType<typeof buildSubscriptionOrderBy>) =>
    parts.map((part) => dialect.sqlToQuery(part).sql).join(", ");

  it("sorts by createdAt with an id tiebreaker", () => {
    expect(sqlOf(buildSubscriptionOrderBy("createdAt", "desc"))).toBe(
      '"subscription"."created_at" desc, "subscription"."id" desc',
    );
  });

  it("sorts by expiry ascending", () => {
    expect(sqlOf(buildSubscriptionOrderBy("expiresAt", "asc"))).toBe(
      '"subscription"."expires_at" asc, "subscription"."id" asc',
    );
  });

  it("sorts by usage ratio, treating unlimited as zero", () => {
    const text = sqlOf(buildSubscriptionOrderBy("usage", "desc"));
    expect(text).toContain("case when");
    expect(text).toContain("::float8 /");
    expect(text).toContain("desc");
  });
});
