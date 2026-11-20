/**
 * Route ownership for the admin activity rail. Each workspace owns one
 * canonical `/admin/<workspace>` subtree (Overview owns `/admin` itself), and
 * every pre-workspace admin URL maps to a canonical destination so old
 * bookmarks keep working once their pages move.
 */

export const ADMIN_WORKSPACE_IDS = [
  "overview",
  "servers",
  "networking",
  "access",
  "operations",
] as const;

export type AdminWorkspaceId = (typeof ADMIN_WORKSPACE_IDS)[number];

/**
 * Where a legacy admin URL goes. Node detail URLs carry no server, so the
 * caller resolves the owning server through an authorized lookup.
 */
export type LegacyAdminDestination =
  | { kind: "path"; pathname: string }
  | { kind: "node"; nodeId: string };

const LEGACY_SERVER_TABS: Record<string, string> = {
  nodes: "inbounds",
  settings: "settings",
  connection: "connection",
  logs: "logs",
  terminal: "terminal",
};

/** Legacy top-level sections that keep their subpaths under a workspace. */
const LEGACY_SECTION_WORKSPACES: Record<string, AdminWorkspaceId> = {
  plans: "access",
  subscriptions: "access",
  redeem: "access",
  users: "access",
  traffic: "operations",
  announcements: "operations",
  audit: "operations",
  mcp: "operations",
  settings: "operations",
};

function adminSegments(pathname: string): string[] | null {
  const segments = pathname.split("/").filter(Boolean);
  return segments[0] === "admin" ? segments.slice(1) : null;
}

function path(...segments: string[]): LegacyAdminDestination {
  return { kind: "path", pathname: `/admin/${segments.join("/")}` };
}

function resolveLegacyProxiesPath(
  rest: string[],
): LegacyAdminDestination | null {
  const [section, id, tab, ...extra] = rest;

  switch (section) {
    case "servers":
      if (id === undefined || id === "new") {
        return tab === undefined ? path("servers", ...(id ? [id] : [])) : null;
      }
      if (tab === undefined) {
        return path("servers", id, "overview");
      }
      return LEGACY_SERVER_TABS[tab] && extra.length === 0
        ? path("servers", id, LEGACY_SERVER_TABS[tab])
        : null;
    case "nodes":
      if (id === undefined || id === "new") {
        return tab === undefined ? path("servers") : null;
      }
      return tab === undefined ? { kind: "node", nodeId: id } : null;
    case "groups":
      return path("access", "groups", ...rest.slice(1));
    case "certificates":
      return id === undefined ? path("networking", "certificates") : null;
    case "rules":
      return id === undefined ? path("networking", "routing") : null;
    default:
      return null;
  }
}

/**
 * Maps a pre-workspace admin pathname to its canonical destination, or `null`
 * when the pathname is already canonical or unknown. Search parameters are
 * the caller's to allowlist and carry over.
 */
export function resolveLegacyAdminPath(
  pathname: string,
): LegacyAdminDestination | null {
  const segments = adminSegments(pathname);
  if (!segments || segments.length === 0) {
    return null;
  }

  const [section, ...rest] = segments;
  if (section === "proxies") {
    return resolveLegacyProxiesPath(rest);
  }

  const workspace = LEGACY_SECTION_WORKSPACES[section];
  return workspace ? path(workspace, section, ...rest) : null;
}

/**
 * The rail workspace that owns a pathname, or `null` outside `/admin`. Legacy
 * URLs resolve through their canonical destination so the rail stays correct
 * while pages migrate; node detail belongs to Servers.
 */
export function getAdminWorkspace(pathname: string): AdminWorkspaceId | null {
  const legacy = resolveLegacyAdminPath(pathname);
  if (legacy?.kind === "node") {
    return "servers";
  }

  const segments = adminSegments(legacy?.pathname ?? pathname);
  if (!segments) {
    return null;
  }

  return ADMIN_WORKSPACE_IDS.find((id) => id === segments[0]) ?? "overview";
}
