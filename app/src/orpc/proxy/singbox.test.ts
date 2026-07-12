import { describe, expect, it } from "vitest";

import type { Node } from "@/db/proxy-schema";

import { compileServerConfig, type NodeInbound } from "./singbox";
import { encodeTrafficUser } from "./traffic-user-codec";

const UUID_A = "550e8400-e29b-41d4-a716-446655440000";
const UUID_B = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function makeNode(id: string, protocol: string): Node {
  return {
    id,
    name: `${id}-name`,
    remark: null,
    tags: [],
    enabled: true,
    serverId: "srv-1",
    address: null,
    listenPort: 443,
    protocol,
    settings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Node;
}

describe("compileServerConfig", () => {
  it("compiles one inbound per node, each with its own tag", () => {
    const inbounds: NodeInbound[] = [
      {
        node: makeNode("n1", "vless"),
        users: [{ name: encodeTrafficUser("n1", "s1"), uuid: UUID_A }],
      },
      {
        node: makeNode("n2", "vmess"),
        users: [{ name: encodeTrafficUser("n2", "s2"), uuid: UUID_B }],
      },
    ];
    const config = compileServerConfig({ inbounds }) as unknown as Record<
      string,
      unknown
    >;
    const inb = config.inbounds as { tag: string }[];
    expect(inb.map((i) => i.tag)).toEqual(["node-n1", "node-n2"]);
  });

  it("drops inbounds with no users so sing-box never opens an open-proxy / users-required inbound", () => {
    // sing-box diverges on empty `users`: socks/http accept it (open proxy),
    // vless/naive/ss require users — unsafe to assume. The only uniform rule is
    // "no users → no inbound"; the compiler enforces it here.
    const inbounds: NodeInbound[] = [
      {
        node: makeNode("n1", "vless"),
        users: [{ name: encodeTrafficUser("n1", "s1"), uuid: UUID_A }],
      },
      { node: makeNode("n2", "trojan"), users: [] },
    ];
    const config = compileServerConfig({ inbounds }) as unknown as Record<
      string,
      unknown
    >;
    const inb = config.inbounds as { tag: string }[];
    expect(inb.map((i) => i.tag)).toEqual(["node-n1"]);
  });

  it("emits a valid empty-inbounds config when no nodes are provided", () => {
    const config = compileServerConfig({ inbounds: [] }) as unknown as Record<
      string,
      unknown
    >;
    expect((config.inbounds as unknown[]).length).toBe(0);
    const experimental = config.experimental as {
      v2ray_api: { stats: { inbounds: string[]; users: string[] } };
    };
    expect(experimental.v2ray_api.stats.inbounds).toEqual([]);
    expect(experimental.v2ray_api.stats.users).toEqual([]);
  });

  it("keeps each coded user name distinct when a subscription spans multiple nodes", () => {
    const codedS1 = encodeTrafficUser("n1", "s1");
    const codedS1FromN2 = encodeTrafficUser("n2", "s1");
    const inbounds: NodeInbound[] = [
      {
        node: makeNode("n1", "vless"),
        users: [{ name: codedS1, uuid: UUID_A }],
      },
      {
        node: makeNode("n2", "vmess"),
        users: [{ name: codedS1FromN2, uuid: UUID_A }],
      },
    ];
    const config = compileServerConfig({ inbounds }) as unknown as Record<
      string,
      unknown
    >;
    const experimental = config.experimental as {
      v2ray_api: { stats: { inbounds: string[]; users: string[] } };
    };
    // Each coded name encodes the producing node, so the two entries are
    // distinct — stats.users distinguishes per node correctly.
    expect(experimental.v2ray_api.stats.users).toEqual(
      expect.arrayContaining([codedS1, codedS1FromN2]),
    );
    expect(experimental.v2ray_api.stats.users).toHaveLength(2);
    expect(experimental.v2ray_api.stats.inbounds).toEqual([
      "node-n1",
      "node-n2",
    ]);
  });

  it("preserves the v2ray_api hook on an empty config", () => {
    const config = compileServerConfig({ inbounds: [] }) as unknown as Record<
      string,
      unknown
    >;
    expect(config.experimental).toBeDefined();
    expect(
      (config.experimental as { v2ray_api: unknown }).v2ray_api,
    ).toBeDefined();
  });

  it("still parses when v2ray_api is disabled", () => {
    const inbounds: NodeInbound[] = [
      {
        node: makeNode("n1", "vless"),
        users: [{ name: encodeTrafficUser("n1", "s1"), uuid: UUID_A }],
      },
    ];
    const config = compileServerConfig({
      inbounds,
      enableV2rayApi: false,
    }) as unknown as Record<string, unknown>;
    expect(config.experimental).toBeUndefined();
  });
});
