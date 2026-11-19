import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import { AGENT_ENROLLMENT_MODES } from "@/db/agent-identity-schema";

/**
 * Pure enrollment helpers: secret formats, hashing and the redeem request body.
 * The store that claims grants and creates identities is `query/agent-identity-store.ts`.
 */

/** Proposed grant lifetime (identity-installation.md). */
export const ENROLLMENT_GRANT_TTL_MINUTES = 15;

const GRANT_PREFIX = "egr_";
const CLIENT_SECRET_PREFIX = "ags_";

export function hashEnrollmentGrantSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export interface GeneratedEnrollmentGrant {
  /** Plaintext grant. Returned to the administrator once; never stored. */
  secret: string;
  /** SHA-256 hex digest stored in `agent_enrollment_grant.token_hash`. */
  tokenHash: string;
}

export function generateEnrollmentGrant(): GeneratedEnrollmentGrant {
  const secret = `${GRANT_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { secret, tokenHash: hashEnrollmentGrantSecret(secret) };
}

/**
 * The provider stores `client_secret` as `base64url(sha256(secret))` without
 * padding (its default hasher for `storeClientSecret: "hashed"`). Enrollment
 * writes the same value so `client_secret_basic` verifies. The integration proof
 * in `lib/oauth-provider.integration.test.ts` pins this equivalence.
 */
export function hashMachineClientSecret(clientSecret: string): string {
  return createHash("sha256").update(clientSecret).digest("base64url");
}

export interface GeneratedMachineCredential {
  clientId: string;
  /** Plaintext client secret. Returned once in the successful redeem response only. */
  clientSecret: string;
  /** Provider-hashed secret stored in `oauth_client.client_secret`. */
  secretHash: string;
}

export function generateMachineCredential(): GeneratedMachineCredential {
  const clientSecret = `${CLIENT_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    clientId: `agent_${randomBytes(16).toString("base64url")}`,
    clientSecret,
    secretHash: hashMachineClientSecret(clientSecret),
  };
}

/** Body of `POST /api/agent/enrollment/redeem`. Strict: unknown keys are refused. */
export const redeemEnrollmentBodySchema = z
  .object({
    // "egr_" plus 32 random bytes in base64url (43 characters).
    enrollmentGrant: z.string().regex(/^egr_[A-Za-z0-9_-]{43}$/),
  })
  .strict();

export type RedeemEnrollmentBody = z.infer<typeof redeemEnrollmentBodySchema>;

/** Admin input for a new grant. Replacing an identity needs an explicit confirmation. */
export const createEnrollmentGrantInputSchema = z
  .object({
    serverId: z.string().min(1).max(64),
    mode: z.enum(AGENT_ENROLLMENT_MODES),
    capabilities: z
      .array(z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/))
      .max(16)
      .default([]),
    release: z.string().trim().min(1).max(64).nullable().default(null),
    confirmReplace: z.boolean().optional(),
    /**
     * `inline` returns a complete one-time script from the audited create
     * action. `stdin` returns the grant once and a script that reads it from
     * protected stdin.
     */
    delivery: z.enum(["inline", "stdin"]).default("stdin"),
  })
  .superRefine((input, ctx) => {
    if (input.mode === "replace" && input.confirmReplace !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["confirmReplace"],
        message: "Replacing the active identity requires confirmReplace",
      });
    }
  });

export const revokeEnrollmentGrantInputSchema = z.object({
  grantId: z.string().min(1).max(64),
});

export const revokeAgentIdentityInputSchema = z.object({
  identityId: z.string().min(1).max(64),
});
