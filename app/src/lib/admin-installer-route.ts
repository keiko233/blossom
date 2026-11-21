import type { AgentEnrollmentMode } from "@/db/agent-identity-schema";
import {
  InstallerReleaseError,
  type AgentReleaseManifest,
  parseApprovedAgentReleases,
  selectApprovedAgentRelease,
} from "@/lib/agent-installer-release";
import { APPROVED_AGENT_RELEASES } from "@/lib/agent-installer-releases";
import { renderAgentInstallerScript } from "@/lib/agent-installer-script";

export interface AdminInstallerGrant {
  id: string;
  serverId: string;
  mode: AgentEnrollmentMode;
  capabilities: string[];
  release: string | null;
  status: string;
  expiresAt: Date;
}

export interface AdminInstallerRouteDependencies {
  publicOrigin: string;
  approvedReleases: readonly unknown[];
  authenticate(request: Request): Promise<{ user: { role: string } } | null>;
  loadGrant(
    serverId: string,
    grantId: string,
  ): Promise<AdminInstallerGrant | null>;
  now(): Date;
}

const defaultDependencies: Omit<
  AdminInstallerRouteDependencies,
  "publicOrigin"
> = {
  approvedReleases: APPROVED_AGENT_RELEASES,
  async authenticate(request) {
    const { getAuth } = await import("@/lib/auth");
    const session = await getAuth().api.getSession({
      headers: request.headers,
    });
    return session ? { user: { role: session.user.role ?? "" } } : null;
  },
  async loadGrant(serverId, grantId) {
    const [{ db }, { and, eq }, { agentEnrollmentGrant }] = await Promise.all([
      import("@/db"),
      import("drizzle-orm"),
      import("@/db/agent-identity-schema"),
    ]);
    const [row] = await db
      .select({
        id: agentEnrollmentGrant.id,
        serverId: agentEnrollmentGrant.serverId,
        mode: agentEnrollmentGrant.mode,
        capabilities: agentEnrollmentGrant.capabilities,
        release: agentEnrollmentGrant.release,
        status: agentEnrollmentGrant.status,
        expiresAt: agentEnrollmentGrant.expiresAt,
      })
      .from(agentEnrollmentGrant)
      .where(
        and(
          eq(agentEnrollmentGrant.id, grantId),
          eq(agentEnrollmentGrant.serverId, serverId),
        ),
      )
      .limit(1);
    // The query filters on this server id, so the row is always bound.
    return row ? { ...row, serverId } : null;
  },
  now: () => new Date(),
};

const NO_STORE_HEADERS = {
  "cache-control": "private, no-store",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function response(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { ...NO_STORE_HEADERS, ...headers },
  });
}

/** Rejects cross-site navigations that would ride the admin cookie. */
export function isSameOriginInstallerRequest(
  request: Request,
  publicOrigin: string,
): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return false;
  }

  const origin = request.headers.get("origin");
  if (!origin) {
    return true;
  }
  try {
    return new URL(origin).origin === new URL(publicOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * `GET /api/admin/servers/<id>/installation/script/<grantId>`.
 *
 * The path is fixed and contains no credential. The response is an attachment
 * without the enrollment grant; an inline one-time script comes only from the
 * audited create action. Every successful and failed response is `no-store`.
 */
export async function handleAdminInstallerDownload(
  request: Request,
  params: { serverId: string; grantId: string },
  dependencies: Pick<AdminInstallerRouteDependencies, "publicOrigin"> &
    Partial<AdminInstallerRouteDependencies>,
): Promise<Response> {
  const deps = { ...defaultDependencies, ...dependencies };
  const url = new URL(request.url);
  const expectedPath = `/api/admin/servers/${encodeURIComponent(params.serverId)}/installation/script/${encodeURIComponent(params.grantId)}`;

  if (url.pathname !== expectedPath || url.search !== "") {
    return response(404, "Not found");
  }
  if (!isSameOriginInstallerRequest(request, deps.publicOrigin)) {
    return response(403, "Cross-origin installer download denied");
  }

  const session = await deps.authenticate(request);
  if (!session || session.user.role !== "admin") {
    return response(403, "Forbidden");
  }

  const grant = await deps.loadGrant(params.serverId, params.grantId);
  if (!grant) {
    return response(404, "Not found");
  }
  if (grant.status !== "issued") {
    return response(
      409,
      "This enrollment grant is no longer available. Create a new grant.",
    );
  }
  if (grant.expiresAt <= deps.now()) {
    return response(409, "This enrollment grant expired. Create a new grant.");
  }
  if (!grant.release) {
    return response(
      409,
      "This enrollment grant does not pin an approved agent release.",
    );
  }

  let releases: AgentReleaseManifest[];
  try {
    releases = parseApprovedAgentReleases(deps.approvedReleases);
  } catch (error) {
    console.error("[agent-installer] invalid approved release catalog", error);
    return response(503, "The approved agent release catalog is invalid");
  }

  let release: AgentReleaseManifest;
  try {
    release = selectApprovedAgentRelease(releases, grant.release);
  } catch (error) {
    if (error instanceof InstallerReleaseError) {
      return response(409, error.message);
    }
    throw error;
  }

  let script: string;
  try {
    script = renderAgentInstallerScript({
      publicOrigin: deps.publicOrigin.replace(/\/$/, ""),
      serverId: grant.serverId,
      grantId: grant.id,
      mode: grant.mode,
      capabilities: grant.capabilities,
      release,
    });
  } catch (error) {
    console.error("[agent-installer] cannot render installer", error);
    return response(500, "The installer cannot be rendered");
  }

  return response(200, script, {
    "content-type": "text/x-shellscript; charset=utf-8",
    "content-disposition": 'attachment; filename="blossom-agent-install.sh"',
  });
}
