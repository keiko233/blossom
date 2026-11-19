import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "@/db";
import { fromInput, fromResult } from "@/lib/admin-audit";
import { adminAudit } from "@/lib/admin-audit-middleware";
import {
  createEnrollmentGrantInputSchema,
  revokeAgentIdentityInputSchema,
  revokeEnrollmentGrantInputSchema,
} from "@/lib/agent-enrollment";
import { ensureAdmin } from "@/lib/ensure-admin";

import {
  createEnrollmentGrant,
  listAgentIdentities,
  listEnrollmentGrants,
  revokeAgentIdentity,
  revokeEnrollmentGrant,
} from "./agent-identity-store";

/** TanStack Query key for one server's agent identity state. */
export const AGENT_IDENTITY_QUERY_KEY = ["admin", "agent-identity"] as const;

export const getAgentIdentityState = createServerFn({ method: "GET" })
  .validator(z.object({ serverId: z.string().min(1).max(64) }))
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [identities, grants] = await Promise.all([
      listAgentIdentities(db, data.serverId),
      listEnrollmentGrants(db, data.serverId),
    ]);
    return { identities, grants };
  });

/**
 * Issues a one-time enrollment grant. The plaintext `secret` is in this response
 * only; the audit row stores the input and the grant id, never the result.
 */
export const createAgentEnrollmentGrant = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("server.enrollment_grant_create", {
      targetType: "server",
      targetId: fromInput("serverId"),
    }),
  ])
  .validator(createEnrollmentGrantInputSchema)
  .handler(async ({ data }) => {
    const session = await ensureAdmin();
    const { grant, secret } = await createEnrollmentGrant(db, {
      serverId: data.serverId,
      mode: data.mode,
      capabilities: data.capabilities,
      release: data.release,
      createdById: session.user.id,
      now: new Date(),
    });
    return { grant, secret };
  });

export const revokeAgentEnrollmentGrant = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("server.enrollment_grant_revoke", {
      targetType: "server",
      targetId: fromResult("serverId"),
    }),
  ])
  .validator(revokeEnrollmentGrantInputSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const result = await revokeEnrollmentGrant(db, {
      grantId: data.grantId,
      now: new Date(),
    });
    if (!result.found) {
      throw new Error("Not found");
    }
    return { serverId: result.serverId, grantStatus: result.grantStatus };
  });

/**
 * Revokes an identity: its client stops authenticating and its agent links are
 * removed. A live agent is disconnected by the WebSocket follow-up, which checks
 * this state; until then its next token request fails.
 */
export const revokeAgentIdentityAccess = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("server.agent_identity_revoke", {
      targetType: "server",
      targetId: fromResult("serverId"),
    }),
  ])
  .validator(revokeAgentIdentityInputSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const result = await revokeAgentIdentity(db, {
      identityId: data.identityId,
      now: new Date(),
    });
    if (!result.found) {
      throw new Error("Not found");
    }
    return { serverId: result.serverId, changed: result.changed };
  });
