import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyJwsAccessToken } = vi.hoisted(() => ({
  verifyJwsAccessToken: vi.fn(),
}));

vi.mock("better-auth/oauth2", () => ({ verifyJwsAccessToken }));

import { createMcpOAuthHandler } from "./mcp-auth";

const origin = "https://blossom.example.com";
const audience = `${origin}/api/mcp`;
const issuer = `${origin}/api/auth`;

describe("createMcpOAuthHandler", () => {
  beforeEach(() => {
    verifyJwsAccessToken.mockReset();
  });

  it("returns OAuth resource metadata when authorization is missing", async () => {
    const handler = createMcpOAuthHandler({
      origin,
      audience,
      issuer,
      getJwks: vi.fn(),
      handler: vi.fn(),
    });

    const response = await handler(new Request(audience, { method: "POST" }));

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp"`,
    );
    expect(verifyJwsAccessToken).not.toHaveBeenCalled();
  });

  it("verifies with internal JWKS and attaches MCP auth context", async () => {
    verifyJwsAccessToken.mockResolvedValue({
      sub: "admin-id",
      azp: "client-id",
      scope: "blossom:mcp:read blossom:mcp:write",
      exp: 1234,
    });
    const getJwks = vi.fn();
    const downstream = vi.fn(async (request: Request) => {
      return Response.json((request as Request & { auth: unknown }).auth);
    });
    const handler = createMcpOAuthHandler({
      origin,
      audience,
      issuer,
      getJwks,
      handler: downstream,
    });

    const response = await handler(
      new Request(audience, {
        method: "POST",
        headers: { Authorization: "Bearer access-token" },
      }),
    );

    expect(response.status).toBe(200);
    expect(verifyJwsAccessToken).toHaveBeenCalledWith(
      "access-token",
      expect.objectContaining({
        jwksFetch: getJwks,
        verifyOptions: { audience, issuer },
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      token: "access-token",
      clientId: "client-id",
      scopes: ["blossom:mcp:read", "blossom:mcp:write"],
      expiresAt: 1234,
      extra: { sub: "admin-id" },
    });
  });

  it("returns 401 when local token verification fails", async () => {
    verifyJwsAccessToken.mockRejectedValue(new Error("signature failed"));
    const handler = createMcpOAuthHandler({
      origin,
      audience,
      issuer,
      getJwks: vi.fn(),
      handler: vi.fn(),
    });

    const response = await handler(
      new Request(audience, {
        headers: { Authorization: "Bearer invalid-token" },
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe("invalid access token");
  });
});
