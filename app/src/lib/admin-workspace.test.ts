import { describe, expect, it } from "vitest";

import { getAdminWorkspace, resolveLegacyAdminPath } from "./admin-workspace";

const SERVER = "srv_1";

describe("resolveLegacyAdminPath", () => {
  it.each([
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
