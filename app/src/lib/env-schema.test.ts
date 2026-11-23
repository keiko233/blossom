import { describe, expect, it } from "vitest";

import {
  DatabaseDriver,
  serverEnvSchema,
  supportsInteractiveTransactions,
} from "./env-schema";

describe("bootstrap DNS environment", () => {
  const { SING_BOX_BOOTSTRAP_DNS_TYPE, SING_BOX_BOOTSTRAP_DNS_SERVER } =
    serverEnvSchema.shape;

  it("defaults to TLS on 8.8.8.8 when unset", () => {
    expect(SING_BOX_BOOTSTRAP_DNS_TYPE.parse(undefined)).toBe("tls");
    expect(SING_BOX_BOOTSTRAP_DNS_SERVER.parse(undefined)).toBe("8.8.8.8");
  });

  it("accepts IPv4 and IPv6 literal servers only", () => {
    expect(SING_BOX_BOOTSTRAP_DNS_SERVER.safeParse("223.5.5.5").success).toBe(
      true,
    );
    expect(
      SING_BOX_BOOTSTRAP_DNS_SERVER.safeParse("2400:3200::1").success,
    ).toBe(true);
    expect(
      SING_BOX_BOOTSTRAP_DNS_SERVER.safeParse("dns.example.com").success,
    ).toBe(false);
  });

  it("accepts only the supported bootstrap types", () => {
    for (const type of ["tls", "udp", "local"]) {
      expect(SING_BOX_BOOTSTRAP_DNS_TYPE.safeParse(type).success).toBe(true);
    }
    expect(SING_BOX_BOOTSTRAP_DNS_TYPE.safeParse("https").success).toBe(false);
  });
});

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
