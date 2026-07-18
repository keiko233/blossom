import { describe, expect, it } from "vitest";

import { DatabaseDriver, supportsInteractiveTransactions } from "./env-schema";

describe("supportsInteractiveTransactions", () => {
  it("does not call Drizzle transactions for neon-http", () => {
    expect(supportsInteractiveTransactions(DatabaseDriver.NeonHttp)).toBe(
      false,
    );
  });

  it("keeps row-lock transactions for node-postgres", () => {
    expect(supportsInteractiveTransactions(DatabaseDriver.NodePg)).toBe(true);
  });
});
