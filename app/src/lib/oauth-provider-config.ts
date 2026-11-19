import type { oauthProvider } from "@better-auth/oauth-provider";

/**
 * OAuth provider settings shared by `auth.tsx` and the integration proof in
 * `oauth-provider.integration.test.ts`. Pure: no environment or database access,
 * so the proof runs the production options rather than a copy of them.
 */

/** Scope held only by per-server agent clients (`client_credentials`). */
export const AGENT_MACHINE_SCOPE = "blossom:agent:connect";

/** Proposed machine token lifetime (identity-installation.md). */
export const AGENT_TOKEN_LIFETIME_SECONDS = 15 * 60;

export const MCP_RESOURCE_NAME = "Blossom MCP";
export const AGENT_RESOURCE_NAME = "Blossom agent";

export interface OAuthResourceIdentifiers {
  /** Audience of MCP access tokens (user sessions, authorization code grant). */
  mcp: string;
  /** Audience of agent machine tokens. Linked only to agent identity clients. */
  agent: string;
}

export function getOAuthResourceIdentifiers(
  publicOrigin: string,
): OAuthResourceIdentifiers {
  const origin = publicOrigin.replace(/\/$/, "");
  return {
    mcp: `${origin}/api/mcp`,
    agent: `${origin}/api/agent`,
  };
}

type OAuthProviderOptions = Parameters<typeof oauthProvider>[0];

/**
 * The return type keeps the provider's contextual typing for the scope and grant
 * literals. `silenceWarnings` is not a 1.7.25 option, but the app has always
 * passed it, so it stays in the type rather than changing the configuration.
 */
export function createOAuthProviderOptions(
  resources: OAuthResourceIdentifiers,
): OAuthProviderOptions & {
  silenceWarnings: { oauthAuthServerConfig: boolean };
} {
  return {
    loginPage: "/auth/login",
    consentPage: "/auth/mcp-consent",
    silenceWarnings: {
      oauthAuthServerConfig: true,
    },
    scopes: [
      "blossom:mcp:read",
      "blossom:mcp:write",
      "offline_access",
      AGENT_MACHINE_SCOPE,
    ],
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    // Dynamic registration can never request the machine scope or the agent
    // resource: both are absent from the allowlists below.
    clientRegistrationDefaultScopes: ["blossom:mcp:read"],
    clientRegistrationAllowedScopes: ["blossom:mcp:write", "offline_access"],
    clientRegistrationDefaultResources: [resources.mcp],
    clientRegistrationAllowedResources: [resources.mcp],
    resources: [
      // No allowedScopes or lifetime override: MCP token lifetimes are unchanged.
      { identifier: resources.mcp, name: MCP_RESOURCE_NAME },
      {
        identifier: resources.agent,
        name: AGENT_RESOURCE_NAME,
        allowedScopes: [AGENT_MACHINE_SCOPE],
        accessTokenTtl: AGENT_TOKEN_LIFETIME_SECONDS,
      },
    ],
    // A client may use a resource only when linked to it in oauth_client_resource.
    // Explicit, although it is the provider default.
    enforcePerClientResources: true,
    // Linking the agent resource is reserved for enrollment code, which writes
    // the link directly. Admin link/update/delete requests through the
    // provider's own endpoints are refused for it.
    resourcePrivileges: ({ action, resourceId }) =>
      resourceId === resources.agent &&
      (action === "link" ||
        action === "unlink" ||
        action === "update" ||
        action === "delete")
        ? false
        : true,
    accessTokenExpiresIn: 60 * 60 * 24,
    // client_credentials tokens (agent machines) default to the same lifetime.
    m2mAccessTokenExpiresIn: AGENT_TOKEN_LIFETIME_SECONDS,
    refreshTokenExpiresIn: 60 * 60 * 24 * 30,
    codeExpiresIn: 600,
    grantTypes: ["authorization_code", "refresh_token", "client_credentials"],
    disableJwtPlugin: false,
  };
}
