import { describe, expect, it } from "vitest";

import {
  filterLegacyAdminSearch,
  getAdminWorkspace,
  resolveLegacyAdminPath,
} from "./admin-workspace";

const SERVER = "srv_1";

describe("resolveLegacyAdminPath", () => {
  it.each([
    ["/admin/proxies", "/admin/servers"],
    ["/admin/proxies/servers", "/admin/servers"],
    ["/admin/proxies/servers/", "/admin/servers"],
    ["/admin/proxies/servers/new", "/admin/servers/new"],
    [`/admin/proxies/servers/${SERVER}`, `/admin/servers/${SERVER}/overview`],
    [
      `/admin/proxies/servers/${SERVER}/nodes`,
      `/admin/servers/${SERVER}/inbounds`,
    ],
    [
      `/admin/proxies/servers/${SERVER}/terminal`,
      `/admin/servers/${SERVER}/terminal`,
    ],
    [
      `/admin/proxies/servers/${SERVER}/outbounds`,
      `/admin/servers/${SERVER}/outbounds`,
    ],
    ["/admin/proxies/nodes", "/admin/servers"],
    ["/admin/proxies/nodes/new", "/admin/servers"],
    ["/admin/proxies/groups", "/admin/access/groups"],
    ["/admin/proxies/groups/grp_1", "/admin/access/groups/grp_1"],
    ["/admin/proxies/certificates", "/admin/networking/certificates"],
    ["/admin/proxies/rules", "/admin/networking/routing"],
    ["/admin/plans/new", "/admin/access/plans/new"],
    ["/admin/redeem/batch_1", "/admin/access/redeem/batch_1"],
    ["/admin/users/usr_1", "/admin/access/users/usr_1"],
    ["/admin/subscriptions", "/admin/access/subscriptions"],
    ["/admin/audit", "/admin/operations/audit"],
    ["/admin/settings", "/admin/operations/settings"],
  ])("redirects %s to %s", (from, to) => {
    expect(resolveLegacyAdminPath(from)).toEqual({
      kind: "path",
      pathname: to,
    });
  });

  it("defers node detail to an authorized owner lookup", () => {
    expect(resolveLegacyAdminPath("/admin/proxies/nodes/node_1")).toEqual({
      kind: "node",
      nodeId: "node_1",
    });
  });

  it.each([
    "/admin",
    "/admin/servers",
    `/admin/servers/${SERVER}/overview`,
    "/admin/access/plans",
    "/admin/operations/settings",
    `/admin/proxies/servers/${SERVER}/unknown`,
    "/admin/proxies/rules/extra",
    "/dashboard",
  ])("leaves %s alone", (pathname) => {
    expect(resolveLegacyAdminPath(pathname)).toBeNull();
  });
});

describe("getAdminWorkspace", () => {
  it.each([
    ["/admin", "overview"],
    ["/admin/servers/new", "servers"],
    [`/admin/servers/${SERVER}/outbounds`, "servers"],
    ["/admin/networking/topology", "networking"],
    ["/admin/access/groups", "access"],
    ["/admin/operations/mcp", "operations"],
    [`/admin/proxies/servers/${SERVER}/logs`, "servers"],
    ["/admin/proxies/nodes/node_1", "servers"],
    ["/admin/proxies/certificates", "networking"],
    ["/admin/plans", "access"],
    ["/admin/traffic", "operations"],
  ])("assigns %s to %s", (pathname, workspace) => {
    expect(getAdminWorkspace(pathname)).toBe(workspace);
  });

  it("returns null outside the admin area", () => {
    expect(getAdminWorkspace("/dashboard")).toBeNull();
  });
});

describe("filterLegacyAdminSearch", () => {
  it("keeps only allowlisted keys for the destination page", () => {
    const search = new URLSearchParams({
      page: "2",
      q: "ali",
      role: "admin",
      token: "secret",
      status: "active",
      tab: "servers",
    });

    expect(filterLegacyAdminSearch("/admin/access/users", search)).toEqual({
      page: "2",
      q: "ali",
      role: "admin",
      status: "active",
    });
  });

  it("applies nested redeem detail params to redeem routes only", () => {
    const search = new URLSearchParams({
      codesPage: "3",
      token: "secret",
    });

    expect(
      filterLegacyAdminSearch("/admin/access/redeem/batch_1", search),
    ).toEqual({ codesPage: "3" });
    expect(filterLegacyAdminSearch("/admin/access/users", search)).toEqual({});
  });

  it("drops every parameter for destinations without an allowlist", () => {
    expect(
      filterLegacyAdminSearch(
        "/admin/networking/routing",
        new URLSearchParams({ q: "drop" }),
      ),
    ).toEqual({});
  });
});
