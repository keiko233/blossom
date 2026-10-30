import { describe, expect, it } from "vitest";

import {
  filterNodesByServer,
  resolveCreateServerId,
  serverContextSearchSchema,
} from "./server-node-context";

const servers = [{ id: "srv-a" }, { id: "srv-b" }];

describe("serverContextSearchSchema", () => {
  it("accepts a server id and trims it", () => {
    expect(serverContextSearchSchema.parse({ serverId: " srv-b " })).toEqual({
      serverId: "srv-b",
    });
  });

  it("drops unusable values instead of failing the route", () => {
    for (const serverId of ["", "   ", 42, null, ["a"], "x".repeat(129)]) {
      expect(serverContextSearchSchema.parse({ serverId })).toEqual({
        serverId: undefined,
      });
    }
    expect(serverContextSearchSchema.parse({})).toEqual({});
  });
});

describe("resolveCreateServerId", () => {
  it("preselects the server named by the link", () => {
    expect(
      resolveCreateServerId({
        requestedServerId: "srv-b",
        currentServerId: "",
        servers,
      }),
    ).toEqual({ serverId: "srv-b", notice: null });
  });

  it("never overrides a server the admin already selected", () => {
    expect(
      resolveCreateServerId({
        requestedServerId: "srv-b",
        currentServerId: "srv-a",
        servers,
      }),
    ).toEqual({ serverId: "srv-a", notice: null });
  });

  it("does not fall back to another server when the linked one is gone", () => {
    expect(
      resolveCreateServerId({
        requestedServerId: "removed",
        currentServerId: "",
        servers,
      }),
    ).toEqual({ serverId: "", notice: "requested_missing" });
  });

  it("keeps an explicit selection even if the link is stale", () => {
    expect(
      resolveCreateServerId({
        requestedServerId: "removed",
        currentServerId: "srv-a",
        servers,
      }),
    ).toEqual({ serverId: "srv-a", notice: null });
  });

  it("defaults to the first server when there is no link", () => {
    expect(
      resolveCreateServerId({
        requestedServerId: undefined,
        currentServerId: "",
        servers,
      }),
    ).toEqual({ serverId: "srv-a", notice: null });
  });

  it("selects nothing when no servers exist", () => {
    expect(
      resolveCreateServerId({
        requestedServerId: undefined,
        currentServerId: "",
        servers: [],
      }),
    ).toEqual({ serverId: "", notice: null });
    expect(
      resolveCreateServerId({
        requestedServerId: "srv-a",
        currentServerId: "",
        servers: [],
      }),
    ).toEqual({ serverId: "", notice: "requested_missing" });
  });
});

describe("filterNodesByServer", () => {
  const nodes = [
    { id: "1", serverId: "srv-a" },
    { id: "2", serverId: "srv-b" },
    { id: "3", serverId: "srv-a" },
  ];

  it("keeps only the requested server's nodes", () => {
    expect(filterNodesByServer(nodes, "srv-a").map((n) => n.id)).toEqual([
      "1",
      "3",
    ]);
  });

  it("returns every node without a filter and none for an unknown server", () => {
    expect(filterNodesByServer(nodes, undefined)).toHaveLength(3);
    expect(filterNodesByServer(nodes, "removed")).toEqual([]);
  });
});
