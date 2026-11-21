import { createServerFn } from "@tanstack/react-start";
import { setResponseHeaders } from "@tanstack/react-start/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { agentEnrollmentGrant } from "@/db/agent-identity-schema";
import { server } from "@/db/proxy-schema";
import { fromInput, fromResult } from "@/lib/admin-audit";
import { adminAudit } from "@/lib/admin-audit-middleware";
import {
  assertBootstrapOrigin,
  buildBootstrapCommands,
  normalizeBootstrapVersion,
} from "@/lib/agent-bootstrap";
import {
  createBootstrapGrantInputSchema,
  createEnrollmentGrantInputSchema,
  createOnboardingGrantInputSchema,
  ENROLLMENT_GRANT_TTL_MINUTES,
  getOnboardingGrantStatusInputSchema,
  revokeAgentIdentityInputSchema,
  revokeEnrollmentGrantInputSchema,
} from "@/lib/agent-enrollment";
import {
  AGENT_INSTALLER_REQUIRED_CAPABILITIES,
  isAgentReleaseCompatible,
  parseApprovedAgentReleases,
  selectApprovedAgentRelease,
} from "@/lib/agent-installer-release";
import { APPROVED_AGENT_RELEASES } from "@/lib/agent-installer-releases";
import {
  assertInstallerIdentifier,
  assertInstallerOrigin,
  renderAgentInstallerScript,
} from "@/lib/agent-installer-script";
import { listAgentReleaseVersions } from "@/lib/agent-release-feed";
import { ensureAdmin } from "@/lib/ensure-admin";
import { getServerEnv } from "@/lib/env";

import {
  createEnrollmentGrant,
  createOnboardingGrant,
  listAgentIdentities,
  listEnrollmentGrants,
  revokeAgentIdentity,
  revokeEnrollmentGrant,
} from "./agent-identity-store";

/** TanStack Query key for one server's agent identity state. */
export const AGENT_IDENTITY_QUERY_KEY = ["admin", "agent-identity"] as const;
/** TanStack Query key for the control plane's approved installer catalog. */
export const AGENT_INSTALLER_OPTIONS_QUERY_KEY = [
  "admin",
  "agent-installer-options",
] as const;
/** TanStack Query key for the GitHub release version selector. */
export const AGENT_RELEASE_VERSION_QUERY_KEY = [
  "admin",
  "agent-release-versions",
] as const;
/** TanStack Query key for one onboarding grant's redemption and connection state. */
export const AGENT_ONBOARDING_GRANT_QUERY_KEY = [
  "admin",
  "agent-onboarding-grant",
] as const;

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
 * Approved installer releases and the grant lifetime the UI may display. An
 * empty catalog is a normal state: it disables installer actions instead of
 * offering an unapproved build.
 */
export const getAgentInstallerOptions = createServerFn({
  method: "GET",
}).handler(async () => {
  await ensureAdmin();
  const releases = parseApprovedAgentReleases(APPROVED_AGENT_RELEASES);
  return {
    releases: releases.map((release) => ({
      version: release.version,
      tag: release.tag,
      singBoxVersion: release.singBox.version,
      capabilities: release.agent.capabilities,
      compatible: isAgentReleaseCompatible(release),
    })),
    requiredCapabilities: [...AGENT_INSTALLER_REQUIRED_CAPABILITIES],
    grantLifetimeMinutes: ENROLLMENT_GRANT_TTL_MINUTES,
  };
});

/**
 * GitHub release versions for the onboarding selector, plus any releases the
 * control plane has curated. Network failures fall back to `latest`.
 */
export const getAgentReleaseVersions = createServerFn({
  method: "GET",
}).handler(async () => {
  await ensureAdmin();
  let approved: ReturnType<typeof parseApprovedAgentReleases> = [];
  try {
    approved = parseApprovedAgentReleases(APPROVED_AGENT_RELEASES);
  } catch {
    approved = [];
  }
  const versions = await listAgentReleaseVersions({ approved });
  return {
    versions,
    grantLifetimeMinutes: ENROLLMENT_GRANT_TTL_MINUTES,
  };
});

/**
 * Creates an unbound one-time grant for the "add a server" flow. The server
 * row is created when the agent redeems the grant, so no half-configured
 * server exists if the command is never run. The plaintext grant appears only
 * in the returned commands (and the install URL), never in the audit row.
 */
export const createAgentOnboardingGrant = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("server.onboarding_grant_create", {
      targetType: "server",
      targetId: fromResult("grantId"),
    }),
  ])
  .validator(createOnboardingGrantInputSchema)
  .handler(async ({ data }) => {
    const session = await ensureAdmin();
    const origin = assertBootstrapOrigin(
      getServerEnv().BETTER_AUTH_URL.replace(/\/$/, ""),
    );
    const release = normalizeBootstrapVersion(data.release).version;
    const { grant, secret } = await createOnboardingGrant(db, {
      capabilities: data.capabilities,
      release,
      createdById: session.user.id,
      now: new Date(),
    });

    setResponseHeaders(
      new Headers({
        "cache-control": "private, no-store",
        pragma: "no-cache",
      }),
    );

    const commands = buildBootstrapCommands({
      publicOrigin: origin,
      enrollmentGrant: secret,
    });
    return {
      grantId: grant.id,
      expiresAt: grant.expiresAt,
      ...commands,
    };
  });

/** Polls whether an onboarding grant was redeemed and which server it created. */
export const getOnboardingGrantStatus = createServerFn({ method: "GET" })
  .validator(getOnboardingGrantStatusInputSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [row] = await db
      .select({
        grantId: agentEnrollmentGrant.id,
        serverId: agentEnrollmentGrant.serverId,
        status: agentEnrollmentGrant.status,
        expiresAt: agentEnrollmentGrant.expiresAt,
        redeemedAt: agentEnrollmentGrant.redeemedAt,
        serverName: server.name,
        serverLastSeenAt: server.lastSeenAt,
        serverWsConnectedAt: server.wsConnectedAt,
      })
      .from(agentEnrollmentGrant)
      .leftJoin(server, eq(server.id, agentEnrollmentGrant.serverId))
      .where(eq(agentEnrollmentGrant.id, data.grantId))
      .limit(1);
    if (!row) {
      throw new Error("Not found");
    }
    const status =
      row.status === "issued" && row.expiresAt <= new Date()
        ? "expired"
        : row.status;
    return {
      grantId: row.grantId,
      status,
      expiresAt: row.expiresAt,
      redeemedAt: row.redeemedAt,
      server:
        row.serverId === null
          ? null
          : {
              id: row.serverId,
              name: row.serverName,
              lastSeenAt: row.serverLastSeenAt,
              wsConnectedAt: row.serverWsConnectedAt,
            },
    };
  });

/**
 * Creates a one-time bootstrap grant for the Connection tab. The generated
 * one-line command installs a new agent or upgrades an existing host through
 * the public installer, so no approved installer catalog is required.
 */
export const createServerBootstrapGrant = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("server.bootstrap_grant_create", {
      targetType: "server",
      targetId: fromInput("serverId"),
    }),
  ])
  .validator(createBootstrapGrantInputSchema)
  .handler(async ({ data }) => {
    const session = await ensureAdmin();
    const origin = assertBootstrapOrigin(
      getServerEnv().BETTER_AUTH_URL.replace(/\/$/, ""),
    );
    const release = normalizeBootstrapVersion(data.release).version;
    const { grant, secret } = await createEnrollmentGrant(db, {
      serverId: data.serverId,
      mode: data.mode,
      capabilities: [],
      release,
      createdById: session.user.id,
      now: new Date(),
    });

    setResponseHeaders(
      new Headers({
        "cache-control": "private, no-store",
        pragma: "no-cache",
      }),
    );

    return {
      grant,
      ...buildBootstrapCommands({
        publicOrigin: origin,
        enrollmentGrant: secret,
      }),
    };
  });

/**
 * Issues a one-time enrollment grant. The plaintext grant is returned once:
 * either as `secret` for protected-stdin delivery or embedded in the inline
 * script. The audit row stores the input and the grant id, never the result.
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
    const publicOrigin = assertInstallerOrigin(
      getServerEnv().BETTER_AUTH_URL.replace(/\/$/, ""),
    );
    assertInstallerIdentifier("serverId", data.serverId);
    const approvedReleases = parseApprovedAgentReleases(
      APPROVED_AGENT_RELEASES,
    );
    const release = selectApprovedAgentRelease(approvedReleases, data.release);
    const { grant, secret } = await createEnrollmentGrant(db, {
      serverId: data.serverId,
      mode: data.mode,
      capabilities: data.capabilities,
      release: release.version,
      createdById: session.user.id,
      now: new Date(),
    });

    setResponseHeaders(
      new Headers({
        "cache-control": "private, no-store",
        pragma: "no-cache",
      }),
    );

    const downloadPath = `/api/admin/servers/${encodeURIComponent(data.serverId)}/installation/script/${encodeURIComponent(grant.id)}`;
    if (data.delivery === "inline") {
      let content: string;
      try {
        content = renderAgentInstallerScript({
          publicOrigin,
          serverId: data.serverId,
          grantId: grant.id,
          mode: grant.mode,
          capabilities: grant.capabilities,
          release,
          enrollmentGrant: secret,
        });
      } catch (error) {
        await revokeEnrollmentGrant(db, {
          grantId: grant.id,
          now: new Date(),
        }).catch(() => undefined);
        throw error;
      }
      return {
        grant,
        downloadPath,
        script: {
          filename: "blossom-agent-install.sh",
          content,
        },
      };
    }
    return { grant, downloadPath, secret };
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
