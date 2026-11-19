import { describe, expect, it } from "vitest";

import type { Server } from "@/db/proxy-schema";

import { toServerDTO } from "./server-dto";

function serverRow(
  overrides: Partial<Pick<Server, "agentTokenHash" | "agentTokenPrefix">> = {},
): Server {
  return {
    id: "srv-1",
    name: "edge",
    agentTokenHash: "sha256-secret-material",
    agentTokenPrefix: "agt_12345678",
    ...overrides,
  } as Server;
}

describe("server DTO", () => {
  it("never carries the credential hash and reports an enabled backup token", () => {
    const dto = toServerDTO(serverRow());

    expect(Object.hasOwn(dto, "agentTokenHash")).toBe(false);
    expect(dto).not.toHaveProperty("agentTokenHash");
    expect(dto.backupTokenEnabled).toBe(true);
    expect(dto.agentTokenPrefix).toBe("agt_12345678");
    expect(JSON.stringify(dto)).not.toContain("sha256-secret-material");
  });

  it("represents an OAuth-only server without hash material", () => {
    const dto = toServerDTO(
      serverRow({ agentTokenHash: null, agentTokenPrefix: null }),
    );

    expect(dto.backupTokenEnabled).toBe(false);
    expect(dto.agentTokenPrefix).toBeNull();
    expect(Object.hasOwn(dto, "agentTokenHash")).toBe(false);
  });
});
