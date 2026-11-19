import { describe, expect, it } from "vitest";

import {
  AGENT_MACHINE_SCOPE,
  AGENT_TOKEN_LIFETIME_SECONDS,
  createOAuthProviderOptions,
  getOAuthResourceIdentifiers,
} from "./oauth-provider-config";

const resources = getOAuthResourceIdentifiers("https://blossom.example.test/");
const options = createOAuthProviderOptions(resources);

describe("getOAuthResourceIdentifiers", () => {
  it("derives MCP and agent audiences from the canonical origin", () => {
    expect(resources).toEqual({
      mcp: "https://blossom.example.test/api/mcp",
      agent: "https://blossom.example.test/api/agent",
    });
  });
});

describe("createOAuthProviderOptions", () => {
  it("keeps the machine scope out of every dynamic registration allowlist", () => {
    expect(options.scopes).toContain(AGENT_MACHINE_SCOPE);
    expect(options.clientRegistrationAllowedScopes).not.toContain(
      AGENT_MACHINE_SCOPE,
    );
    expect(options.clientRegistrationDefaultScopes).not.toContain(
      AGENT_MACHINE_SCOPE,
    );
  });

  it("registers only the MCP resource for dynamic registration", () => {
    expect(options.clientRegistrationAllowedResources).toEqual([resources.mcp]);
    expect(options.clientRegistrationDefaultResources).toEqual([resources.mcp]);
    expect(options.clientRegistrationAllowedResources).not.toContain(
      resources.agent,
    );
  });

  it("limits the agent resource to the machine scope with a 15 minute lifetime", () => {
    const agent = options.resources?.find(
      (resource) =>
        typeof resource !== "string" && resource.identifier === resources.agent,
    );
    expect(agent).toMatchObject({
      allowedScopes: [AGENT_MACHINE_SCOPE],
      accessTokenTtl: AGENT_TOKEN_LIFETIME_SECONDS,
    });
    expect(AGENT_TOKEN_LIFETIME_SECONDS).toBe(900);
  });

  it("leaves the MCP resource without a lifetime override or scope ceiling", () => {
    const mcp = options.resources?.find(
      (resource) =>
        typeof resource !== "string" && resource.identifier === resources.mcp,
    );
    expect(mcp).toEqual({ identifier: resources.mcp, name: "Blossom MCP" });
  });

  it("enforces per-client resource links and enables client_credentials", () => {
    expect(options.enforcePerClientResources).toBe(true);
    expect(options.grantTypes).toEqual(
      expect.arrayContaining([
        "authorization_code",
        "refresh_token",
        "client_credentials",
      ]),
    );
    expect(options.accessTokenExpiresIn).toBe(60 * 60 * 24);
  });

  it("refuses link, unlink, update and delete of the agent resource only", () => {
    const privileges = options.resourcePrivileges!;
    for (const action of ["link", "unlink", "update", "delete"] as const) {
      expect(
        privileges({
          headers: new Headers(),
          action,
          resourceId: resources.agent,
        }),
      ).toBe(false);
    }
    expect(
      privileges({
        headers: new Headers(),
        action: "read",
        resourceId: resources.agent,
      }),
    ).toBe(true);
    expect(
      privileges({
        headers: new Headers(),
        action: "link",
        resourceId: resources.mcp,
      }),
    ).toBe(true);
  });
});
