import { describe, expect, it } from "vitest";

import {
  ADMIN_AUDIT_CSV_COLUMNS,
  adminAuditToCsv,
  MCP_AUDIT_CSV_COLUMNS,
  mcpAuditToCsv,
} from "./admin-audit-csv";

describe("adminAuditToCsv", () => {
  const row = {
    id: "a1",
    createdAt: new Date("2026-10-29T12:00:00Z"),
    actorEmail: "root@example.com",
    actorUserId: "u-admin",
    action: "user.ban",
    targetType: "user",
    targetId: "u1",
    status: "success",
    error: null,
    ip: "1.2.3.4",
    userAgent: "Mozilla/5.0",
    impersonatedBy: null,
    durationMs: 14,
    input: { userId: "u1", reason: 'said "hi", twice' },
    metadata: null,
  };

  it("writes only the header for no rows", () => {
    expect(adminAuditToCsv([])).toBe(ADMIN_AUDIT_CSV_COLUMNS.join(","));
  });

  it("writes one line per row, input as escaped JSON", () => {
    const lines = adminAuditToCsv([row]).split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      [
        "a1",
        "2026-10-29T12:00:00.000Z",
        "root@example.com",
        "u-admin",
        "user.ban",
        "user",
        "u1",
        "success",
        "",
        "1.2.3.4",
        "Mozilla/5.0",
        "",
        "14",
        `"{""userId"":""u1"",""reason"":""said \\""hi\\"", twice""}"`,
        "",
      ].join(","),
    );
  });

  it("neutralizes formula-looking cells", () => {
    const csv = adminAuditToCsv([{ ...row, actorEmail: "=cmd|' /c calc'!A1" }]);
    expect(csv).toContain("'=cmd");
  });
});

describe("mcpAuditToCsv", () => {
  it("has a stable header and one row per entry", () => {
    const csv = mcpAuditToCsv([
      {
        id: "m1",
        createdAt: new Date("2026-10-29T12:00:00Z"),
        actorEmail: null,
        actorUserId: "u1",
        source: "mcp",
        tool: "listUsers",
        status: "error",
        redactedInput: '{"limit":5}',
        redactedError: "Tool failed",
        durationMs: 3,
      },
    ]);
    const [header, line] = csv.split("\r\n");
    expect(header).toBe(MCP_AUDIT_CSV_COLUMNS.join(","));
    expect(line).toBe(
      'm1,2026-10-29T12:00:00.000Z,,u1,mcp,listUsers,error,Tool failed,3,"{""limit"":5}"',
    );
  });
});
