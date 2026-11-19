import { describe, expect, it } from "vitest";

import {
  AgentAuthError,
  assertMachineAccessClaims,
  decideAgentIdentityUse,
  type AgentIdentityRow,
} from "./agent-oauth";
import { AGENT_MACHINE_SCOPE } from "./oauth-provider-config";

const AUDIENCE = "https://blossom.example.test/api/agent";
const NOW = 1_800_000_000;
const CLIENT = "agent_fake-client-id";

function claims(overrides: Record<string, unknown> = {}) {
  return {
    aud: AUDIENCE,
    scope: AGENT_MACHINE_SCOPE,
    client_id: CLIENT,
    azp: CLIENT,
    sub: CLIENT,
    exp: NOW + 900,
    iat: NOW,
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof AgentAuthError ? error.code : "other";
  }
}

describe("assertMachineAccessClaims", () => {
  const expected = { audience: AUDIENCE, nowSeconds: NOW };

  it("accepts a machine token with the exact audience and scope", () => {
    expect(assertMachineAccessClaims(claims(), expected)).toEqual({
      clientId: CLIENT,
      expiresAt: NOW + 900,
    });
    expect(
      assertMachineAccessClaims(claims({ aud: [AUDIENCE] }), expected).clientId,
    ).toBe(CLIENT);
  });

  it("refuses another audience, including a multi-resource one", () => {
    expect(
      codeOf(() =>
        assertMachineAccessClaims(
          claims({ aud: "https://x.example.test/api/mcp" }),
          expected,
        ),
      ),
    ).toBe("invalid_token");
    expect(
      codeOf(() =>
        assertMachineAccessClaims(
          claims({ aud: [AUDIENCE, "https://x.example.test/api/mcp"] }),
          expected,
        ),
      ),
    ).toBe("invalid_token");
    expect(
      codeOf(() =>
        assertMachineAccessClaims(claims({ aud: undefined }), expected),
      ),
    ).toBe("invalid_token");
  });

  it("requires exactly the machine scope", () => {
    expect(
      codeOf(() =>
        assertMachineAccessClaims(
          claims({ scope: "blossom:mcp:read" }),
          expected,
        ),
      ),
    ).toBe("missing_scope");
    expect(
      codeOf(() =>
        assertMachineAccessClaims(
          claims({ scope: `${AGENT_MACHINE_SCOPE} offline_access` }),
          expected,
        ),
      ),
    ).toBe("missing_scope");
    expect(
      codeOf(() => assertMachineAccessClaims(claims({ scope: "" }), expected)),
    ).toBe("missing_scope");
  });

  it("refuses user tokens and tokens without a client identity", () => {
    expect(
      codeOf(() =>
        assertMachineAccessClaims(claims({ sub: "user-123" }), expected),
      ),
    ).toBe("not_machine_token");
    expect(
      codeOf(() =>
        assertMachineAccessClaims(
          claims({ client_id: undefined, azp: undefined }),
          expected,
        ),
      ),
    ).toBe("not_machine_token");
    expect(
      codeOf(() =>
        assertMachineAccessClaims(claims({ azp: "other-client" }), expected),
      ),
    ).toBe("not_machine_token");
  });

  it("refuses expired tokens", () => {
    expect(
      codeOf(() => assertMachineAccessClaims(claims({ exp: NOW }), expected)),
    ).toBe("invalid_token");
  });
});

const row = (overrides: Partial<AgentIdentityRow> = {}): AgentIdentityRow => ({
  identityId: "identity-1",
  serverId: "srv-a",
  generation: 1,
  status: "active",
  clientDisabled: false,
  serverEnabled: true,
  ...overrides,
});

describe("decideAgentIdentityUse", () => {
  it("lets an active identity act and maps it to its server", () => {
    expect(
      decideAgentIdentityUse(row(), { linked: true, purpose: "session" }),
    ).toEqual({
      serverId: "srv-a",
      identityId: "identity-1",
      generation: 1,
      identityStatus: "active",
    });
  });

  it("lets a pending identity complete only its first handshake", () => {
    const pending = row({ status: "pending" });
    expect(
      decideAgentIdentityUse(pending, { linked: true, purpose: "handshake" })
        .identityStatus,
    ).toBe("pending");
    expect(() =>
      decideAgentIdentityUse(pending, { linked: true, purpose: "session" }),
    ).toThrow(expect.objectContaining({ code: "identity_not_usable" }));
  });

  it("refuses revoked and superseded identities", () => {
    for (const status of ["revoked", "superseded"]) {
      expect(
        codeOf(() =>
          decideAgentIdentityUse(row({ status }), {
            linked: true,
            purpose: "session",
          }),
        ),
      ).toBe("identity_not_usable");
    }
  });

  it("refuses disabled clients, unlinked clients, and disabled servers in that order", () => {
    expect(
      codeOf(() =>
        decideAgentIdentityUse(row({ clientDisabled: true }), {
          linked: false,
          purpose: "session",
        }),
      ),
    ).toBe("client_disabled");
    expect(
      codeOf(() =>
        decideAgentIdentityUse(row(), { linked: false, purpose: "session" }),
      ),
    ).toBe("resource_not_linked");
    expect(
      codeOf(() =>
        decideAgentIdentityUse(row({ serverEnabled: false }), {
          linked: true,
          purpose: "session",
        }),
      ),
    ).toBe("server_disabled");
  });

  it("uses the status purpose only to read an active identity on a disabled server", () => {
    expect(
      decideAgentIdentityUse(row({ serverEnabled: false }), {
        linked: true,
        purpose: "status",
      }),
    ).toEqual({
      serverId: "srv-a",
      identityId: "identity-1",
      generation: 1,
      identityStatus: "active",
    });
    expect(() =>
      decideAgentIdentityUse(row({ status: "pending", serverEnabled: false }), {
        linked: true,
        purpose: "status",
      }),
    ).toThrow(expect.objectContaining({ code: "identity_not_usable" }));
  });
});
