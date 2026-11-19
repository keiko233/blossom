import { describe, expect, it, vi } from "vitest";

import type { Server } from "@/db/proxy-schema";
import { hashAgentToken } from "@/lib/agent-token";

import { authenticateStaticAgentToken } from "./agent-static-auth";

const server = { id: "srv-1", enabled: true } as Server;

describe("static agent authentication", () => {
  it("hashes the bearer token and resolves the matching server", async () => {
    const lookup = vi.fn(async () => server);

    await expect(
      authenticateStaticAgentToken(
        "agt_backup",
        { allowDisabled: false },
        lookup,
      ),
    ).resolves.toEqual({
      server,
      tokenHash: hashAgentToken("agt_backup"),
    });
    expect(lookup).toHaveBeenCalledWith(hashAgentToken("agt_backup"));
  });

  it("refuses a disabled backup token on every surface", async () => {
    const lookup = vi.fn(async () => null);

    await expect(
      authenticateStaticAgentToken(
        "agt_disabled",
        { allowDisabled: true },
        lookup,
      ),
    ).resolves.toBeNull();
    await expect(
      authenticateStaticAgentToken(
        "agt_disabled",
        { allowDisabled: false },
        lookup,
      ),
    ).resolves.toBeNull();
  });

  it("lets HTTP reach a disabled server but refuses the WebSocket upgrade", async () => {
    const disabled = { ...server, enabled: false } as Server;
    const lookup = vi.fn(async () => disabled);

    await expect(
      authenticateStaticAgentToken(
        "agt_backup",
        { allowDisabled: true },
        lookup,
      ),
    ).resolves.toMatchObject({ server: { id: "srv-1", enabled: false } });
    await expect(
      authenticateStaticAgentToken(
        "agt_backup",
        { allowDisabled: false },
        lookup,
      ),
    ).resolves.toBeNull();
  });
});
