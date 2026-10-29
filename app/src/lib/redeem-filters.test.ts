import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import type { RedeemBatchFilter } from "@/orpc/redeem/schema";

import {
  buildRedeemBatchConditions,
  buildRedeemBatchOrderBy,
  buildRedeemBatchWhere,
} from "./redeem-filters";

const dialect = new PgDialect();
const now = new Date("2026-10-29T00:00:00Z");
const base: RedeemBatchFilter = { sort: "createdAt", sortDir: "desc" };

function render(filter: Partial<RedeemBatchFilter>) {
  const where = buildRedeemBatchWhere({ ...base, ...filter }, now);
  return where ? dialect.sqlToQuery(where) : undefined;
}

describe("buildRedeemBatchConditions", () => {
  it("adds nothing for an empty filter", () => {
    expect(buildRedeemBatchConditions(base, now)).toEqual([]);
    expect(buildRedeemBatchWhere(base, now)).toBeUndefined();
  });

  it("searches name and note with an escaped pattern", () => {
    const query = render({ search: "50%_off" });
    expect(query?.sql).toContain('"redeem_batch"."name" ilike');
    expect(query?.sql).toContain('"redeem_batch"."note" ilike');
    expect(query?.params).toEqual(["%50\\%\\_off%", "%50\\%\\_off%"]);
  });

  it("filters by plan and mode", () => {
    const query = render({ planId: "p1", mode: "extend" });
    expect(query?.sql).toContain('"redeem_batch"."plan_id" = $1');
    expect(query?.sql).toContain('"redeem_batch"."mode" = $2');
    expect(query?.params).toEqual(["p1", "extend"]);
  });

  it("filters disabled batches on the stored flag alone", () => {
    const query = render({ status: "disabled" });
    expect(query?.sql).toBe('"redeem_batch"."disabled" = $1');
    expect(query?.params).toEqual([true]);
  });

  it("filters expired batches relative to now, excluding disabled ones", () => {
    const query = render({ status: "expired" });
    expect(query?.sql).toContain('"redeem_batch"."disabled" = $1');
    expect(query?.sql).toContain('"redeem_batch"."expires_at" is not null');
    expect(query?.sql).toContain('"redeem_batch"."expires_at" <= $2');
    expect(query?.params[1]).toBe(now.toISOString());
  });

  it("filters exhausted and active batches with the use totals", () => {
    for (const status of ["exhausted", "active"] as const) {
      const query = render({ status });
      expect(query?.sql, status).toContain("coalesce(sum(");
      expect(query?.sql, status).toContain(
        '"redeem_batch"."max_redemptions_per_code"',
      );
    }
    expect(render({ status: "active" })?.sql).toContain("not (");
  });
});

describe("buildRedeemBatchOrderBy", () => {
  function renderOrder(
    sort: RedeemBatchFilter["sort"],
    dir: RedeemBatchFilter["sortDir"],
  ) {
    return buildRedeemBatchOrderBy(sort, dir).map(
      (part) => dialect.sqlToQuery(part).sql,
    );
  }

  it("always ends with the id tiebreaker", () => {
    expect(renderOrder("createdAt", "desc")).toEqual([
      '"redeem_batch"."created_at" desc',
      '"redeem_batch"."id" desc',
    ]);
  });

  it("sorts names case-insensitively", () => {
    expect(renderOrder("name", "asc")[0]).toBe(
      'lower("redeem_batch"."name") asc',
    );
  });

  it("keeps never-expiring batches last in both directions", () => {
    expect(renderOrder("expiresAt", "asc")[0]).toBe(
      '"redeem_batch"."expires_at" asc nulls last',
    );
    expect(renderOrder("expiresAt", "desc")[0]).toBe(
      '"redeem_batch"."expires_at" desc nulls last',
    );
  });
});
