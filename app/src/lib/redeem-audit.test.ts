import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildAdminAuditRow, fromInput, fromResult } from "./admin-audit";
import { generateRedeemCode } from "./redeem-code";

describe("redeem audit records", () => {
  const codes = Array.from({ length: 5 }, () => generateRedeemCode().code);

  it("never stores plaintext codes returned by create / add-codes", () => {
    const create = buildAdminAuditRow({
      id: "a1",
      action: "redeem.batch_create",
      meta: {
        targetType: "redeem_batch",
        targetId: fromResult("batch", "id"),
      },
      input: { name: "Spring", planId: "p1", codeCount: 5, note: null },
      result: { batch: { id: "b1", name: "Spring" }, codes },
      failed: false,
      actor: { id: "admin", email: "admin@example.com" },
      durationMs: 3,
    });
    expect(create.targetId).toBe("b1");

    const add = buildAdminAuditRow({
      id: "a2",
      action: "redeem.codes_add",
      meta: { targetType: "redeem_batch", targetId: fromInput("batchId") },
      input: { batchId: "b1", count: 5 },
      result: { batchId: "b1", batchName: "Spring", codes },
      failed: false,
      actor: { id: "admin", email: "admin@example.com" },
      durationMs: 3,
    });
    expect(add.targetId).toBe("b1");

    for (const row of [create, add]) {
      const stored = JSON.stringify(row);
      for (const code of codes) {
        expect(stored).not.toContain(code);
        expect(stored).not.toContain(code.replaceAll("-", ""));
      }
    }
  });

  it("does not wire a metadata resolver onto the code-producing actions", () => {
    // A `metadata` resolver would be handed the handler result (the codes).
    // The audit rows must only ever resolve ids from it.
    const source = readFileSync(
      fileURLToPath(new URL("../query/redeem.ts", import.meta.url)),
      "utf8",
    );
    const audits = source.match(/adminAudit\([\s\S]*?\}\),?\s*\]\)/g) ?? [];
    expect(audits.length).toBe(5);
    for (const audit of audits) {
      expect(audit).not.toContain("metadata");
    }
  });
});
