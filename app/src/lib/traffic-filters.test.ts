import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { buildTrafficConditions, buildTrafficWhere } from "./traffic-filters";

const dialect = new PgDialect();
const from = new Date("2026-10-01T00:00:00.000Z");
const to = new Date("2026-10-08T00:00:00.000Z");

describe("buildTrafficWhere", () => {
  it("is a half-open created_at range when nothing else is set", () => {
    expect(buildTrafficConditions({ from, to })).toHaveLength(2);
    const query = dialect.sqlToQuery(buildTrafficWhere({ from, to }));
    expect(query.sql).toContain('"traffic_record"."created_at" >= $1');
    expect(query.sql).toContain('"traffic_record"."created_at" < $2');
  });

  it("adds server, node and user equality filters", () => {
    const query = dialect.sqlToQuery(
      buildTrafficWhere({ from, to, serverId: "s", nodeId: "n", userId: "u" }),
    );
    expect(query.sql).toContain('"traffic_record"."server_id" = $3');
    expect(query.sql).toContain('"traffic_record"."node_id" = $4');
    expect(query.sql).toContain('"traffic_record"."user_id" = $5');
    expect(query.params.slice(2)).toEqual(["s", "n", "u"]);
  });

  it("filters by plan through the subscription, with a bound parameter", () => {
    const query = dialect.sqlToQuery(
      buildTrafficWhere({ from, to, planId: "p'; drop table x;--" }),
    );
    expect(query.sql).toContain(
      '"traffic_record"."subscription_id" in (select',
    );
    expect(query.sql).toContain('"subscription"."plan_id" = $3');
    expect(query.params[2]).toBe("p'; drop table x;--");
  });
});
