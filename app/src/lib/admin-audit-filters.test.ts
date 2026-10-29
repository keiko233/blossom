import { and } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import type { AdminAuditFilter, McpAuditFilter } from "@/orpc/audit/schema";

import {
  buildAdminAuditConditions,
  buildAdminAuditOrderBy,
  buildAdminAuditWhere,
  buildMcpAuditConditions,
  buildMcpAuditWhere,
} from "./admin-audit-filters";

const dialect = new PgDialect();
const base: AdminAuditFilter = { sortDir: "desc" };
const mcpBase: McpAuditFilter = { sortDir: "desc" };

function render(filter: Partial<AdminAuditFilter>) {
  const where = buildAdminAuditWhere({ ...base, ...filter });
  return where ? dialect.sqlToQuery(where) : undefined;
}

function renderMcp(filter: Partial<McpAuditFilter>) {
  const where = buildMcpAuditWhere({ ...mcpBase, ...filter });
  return where ? dialect.sqlToQuery(where) : undefined;
}

describe("buildAdminAuditConditions", () => {
  it("adds nothing for an empty filter", () => {
    expect(buildAdminAuditConditions(base)).toEqual([]);
    expect(buildAdminAuditWhere(base)).toBeUndefined();
  });

  it("ignores blank text filters", () => {
    expect(
      buildAdminAuditConditions({
        ...base,
        actor: " ",
        action: "",
        targetId: " ",
      }),
    ).toEqual([]);
  });

  it("matches the actor by email substring or exact user id", () => {
    const query = render({ actor: "a_b@x.io" });
    expect(query?.sql).toContain('"admin_audit_log"."actor_email" ilike $1');
    expect(query?.sql).toContain('"admin_audit_log"."actor_user_id" = $2');
    expect(query?.params).toEqual(["%a\\_b@x.io%", "a_b@x.io"]);
  });

  it("matches an action prefix literally", () => {
    const query = render({ action: "user.set_" });
    expect(query?.sql).toBe('"admin_audit_log"."action" ilike $1');
    expect(query?.params).toEqual(["user.set\\_%"]);
  });

  it("filters by target type and status exactly", () => {
    const query = render({ targetType: "user", status: "error" });
    expect(query?.sql).toBe(
      '(("admin_audit_log"."target_type" = $1) and ("admin_audit_log"."status" = $2))',
    );
    expect(query?.params).toEqual(["user", "error"]);
  });

  it("target id also matches bulk entries listing the id in metadata", () => {
    const query = render({ targetId: "u1" });
    expect(query?.sql).toContain('"admin_audit_log"."target_id" = $1');
    expect(query?.sql).toContain('"admin_audit_log"."metadata" @> $2::jsonb');
    expect(query?.params).toEqual(["u1", JSON.stringify({ ids: ["u1"] })]);
  });

  it("date range is from-inclusive, to-exclusive", () => {
    const from = "2026-10-01T00:00:00.000Z";
    const to = "2026-10-08T00:00:00.000Z";
    const query = render({ from, to });
    expect(query?.sql).toContain('"admin_audit_log"."created_at" >= $1');
    expect(query?.sql).toContain('"admin_audit_log"."created_at" < $2');
    expect(new Date(query?.params[0] as string).toISOString()).toBe(from);
    expect(new Date(query?.params[1] as string).toISOString()).toBe(to);
  });

  it("combines every filter with AND", () => {
    const conditions = buildAdminAuditConditions({
      ...base,
      actor: "a",
      action: "user.",
      targetType: "user",
      targetId: "u1",
      status: "success",
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-02T00:00:00.000Z",
    });
    expect(conditions).toHaveLength(7);
    expect(and(...conditions)).toBeDefined();
  });
});

describe("buildAdminAuditOrderBy", () => {
  it("orders by time with the id as a tiebreaker", () => {
    const desc = buildAdminAuditOrderBy("desc").map(
      (sql) => dialect.sqlToQuery(sql).sql,
    );
    expect(desc).toEqual([
      '"admin_audit_log"."created_at" desc',
      '"admin_audit_log"."id" desc',
    ]);
    const asc = buildAdminAuditOrderBy("asc").map(
      (sql) => dialect.sqlToQuery(sql).sql,
    );
    expect(asc[0]).toBe('"admin_audit_log"."created_at" asc');
  });
});

describe("buildMcpAuditConditions", () => {
  it("adds nothing for an empty filter", () => {
    expect(buildMcpAuditConditions(mcpBase)).toEqual([]);
  });

  it("matches the actor by joined email, name or exact id", () => {
    const query = renderMcp({ actor: "bob" });
    expect(query?.sql).toContain('"user"."email" ilike');
    expect(query?.sql).toContain('"user"."name" ilike');
    expect(query?.sql).toContain('"mcp_tool_audit"."actor_user_id" = ');
    expect(query?.params).toEqual(["%bob%", "%bob%", "bob"]);
  });

  it("matches a tool prefix and status", () => {
    const query = renderMcp({ tool: "list", status: "timeout" });
    expect(query?.sql).toContain('"mcp_tool_audit"."tool" ilike $1');
    expect(query?.sql).toContain('"mcp_tool_audit"."status" = $2');
    expect(query?.params).toEqual(["list%", "timeout"]);
  });

  it("applies the same half-open date range", () => {
    const query = renderMcp({
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-02T00:00:00.000Z",
    });
    expect(query?.sql).toContain('"mcp_tool_audit"."created_at" >= $1');
    expect(query?.sql).toContain('"mcp_tool_audit"."created_at" < $2');
  });
});
