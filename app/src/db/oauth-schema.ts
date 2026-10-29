import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { session, user } from "./auth-schema";

export const oauthClient = pgTable(
  "oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: jsonb("scopes").$type<string[]>(),
    clientCredentialsScopes: jsonb("client_credentials_scopes")
      .$type<string[]>()
      .default([]),
    userId: text("user_id").references(() => user.id, {
      onDelete: "cascade",
    }),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: jsonb("contacts").$type<string[]>(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
    postLogoutRedirectUris: jsonb("post_logout_redirect_uris").$type<
      string[]
    >(),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: boolean(
      "backchannel_logout_session_required",
    ),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: jsonb("grant_types").$type<string[]>(),
    responseTypes: jsonb("response_types").$type<string[]>(),
    public: boolean("public"),
    type: text("type"),
    requirePKCE: boolean("require_pkce"),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
    referenceId: text("reference_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [index("oauth_client_user_idx").on(table.userId)],
);

export type OAuthClient = typeof oauthClient.$inferSelect;
export type NewOAuthClient = typeof oauthClient.$inferInsert;

export const oauthAccessToken = pgTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token").unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, {
        onDelete: "cascade",
      }),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").references(() => user.id, {
      onDelete: "cascade",
    }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: jsonb("resources").$type<string[]>(),
    requestedUserInfoClaims: jsonb("requested_user_info_claims").$type<
      string[]
    >(),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id, {
      onDelete: "cascade",
    }),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    revoked: timestamp("revoked"),
    confirmation: jsonb("confirmation").$type<Record<string, unknown>>(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
  },
  (table) => [
    index("oauth_access_token_client_idx").on(table.clientId),
    index("oauth_access_token_user_idx").on(table.userId),
    index("oauth_access_token_session_idx").on(table.sessionId),
    index("oauth_access_token_refresh_idx").on(table.refreshId),
    index("oauth_access_token_authorization_code_idx").on(
      table.authorizationCodeId,
    ),
  ],
);

export type OAuthAccessToken = typeof oauthAccessToken.$inferSelect;
export type NewOAuthAccessToken = typeof oauthAccessToken.$inferInsert;

export const oauthRefreshToken = pgTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, {
        onDelete: "cascade",
      }),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, {
        onDelete: "cascade",
      }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: jsonb("resources").$type<string[]>(),
    requestedUserInfoClaims: jsonb("requested_user_info_claims").$type<
      string[]
    >(),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    revoked: timestamp("revoked"),
    rotatedAt: timestamp("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: timestamp("rotation_replay_expires_at"),
    authTime: timestamp("auth_time"),
    confirmation: jsonb("confirmation").$type<Record<string, unknown>>(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
  },
  (table) => [
    index("oauth_refresh_token_client_idx").on(table.clientId),
    index("oauth_refresh_token_user_idx").on(table.userId),
    index("oauth_refresh_token_session_idx").on(table.sessionId),
    index("oauth_refresh_token_authorization_code_idx").on(
      table.authorizationCodeId,
    ),
  ],
);

export type OAuthRefreshToken = typeof oauthRefreshToken.$inferSelect;
export type NewOAuthRefreshToken = typeof oauthRefreshToken.$inferInsert;

export const oauthConsent = pgTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, {
        onDelete: "cascade",
      }),
    userId: text("user_id").references(() => user.id, {
      onDelete: "cascade",
    }),
    referenceId: text("reference_id"),
    resources: jsonb("resources").$type<string[]>(),
    requestedUserInfoClaims: jsonb("requested_user_info_claims").$type<
      string[]
    >(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("oauth_consent_client_idx").on(table.clientId),
    index("oauth_consent_user_idx").on(table.userId),
  ],
);

export type OAuthConsent = typeof oauthConsent.$inferSelect;
export type NewOAuthConsent = typeof oauthConsent.$inferInsert;

export const oauthResource = pgTable("oauth_resource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: jsonb("allowed_scopes").$type<string[]>(),
  customClaims: jsonb("custom_claims").$type<Record<string, unknown>>(),
  dpopBoundAccessTokensRequired: boolean(
    "dpop_bound_access_tokens_required",
  ).default(false),
  disabled: boolean("disabled").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
  policyVersion: integer("policy_version").default(1),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
});

export type OAuthResource = typeof oauthResource.$inferSelect;
export type NewOAuthResource = typeof oauthResource.$inferInsert;

export const oauthClientResource = pgTable(
  "oauth_client_resource",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, {
        onDelete: "cascade",
      }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResource.identifier, {
        onDelete: "cascade",
      }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("oauth_client_resource_client_idx").on(table.clientId),
    index("oauth_client_resource_resource_idx").on(table.resourceId),
    uniqueIndex("oauth_client_resource_client_resource_uidx").on(
      table.clientId,
      table.resourceId,
    ),
  ],
);

export type OAuthClientResource = typeof oauthClientResource.$inferSelect;
export type NewOAuthClientResource = typeof oauthClientResource.$inferInsert;

export const oauthClientAssertion = pgTable("oauth_client_assertion", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
});

export type OAuthClientAssertion = typeof oauthClientAssertion.$inferSelect;
export type NewOAuthClientAssertion = typeof oauthClientAssertion.$inferInsert;

export const jwks = pgTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
  alg: text("alg"),
  crv: text("crv"),
});

export type Jwks = typeof jwks.$inferSelect;
export type NewJwks = typeof jwks.$inferInsert;
