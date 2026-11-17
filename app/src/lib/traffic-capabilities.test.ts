import { describe, expect, it } from "vitest";

import type { Subscription } from "@/db/plan-schema";
import type { Node } from "@/db/proxy-schema";
import { NODE_PROTOCOLS } from "@/orpc/proxy/sing-box-registry";
import { compileServerConfig } from "@/orpc/proxy/singbox";
import { buildInboundUser } from "@/orpc/proxy/singbox-users";

import {
  classifyNodeAccounting,
  DEVICE_LIMIT_ENFORCED,
  describeDeviceLimit,
  summarizeAccounting,
} from "./traffic-capabilities";

function makeNode(
  protocol: string,
  settings: Record<string, unknown> = {},
): Node {
  return {
    id: "node-1",
    name: "test node",
    remark: null,
    tags: [],
    enabled: true,
    serverId: "server-1",
    address: null,
    listenPort: 443,
    protocol,
    settings,
    certificateId: null,
    tlsServerName: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Node;
}

const SUB = {
  id: "sub-1",
  credentialUuid: "550e8400-e29b-41d4-a716-446655440000",
  credentialPassword: Buffer.alloc(32, 7).toString("base64"),
} as unknown as Subscription;

/** The inbound user the real compiler embeds for this node. */
function compiledUser(node: Node): {
  user: NonNullable<ReturnType<typeof buildInboundUser>>;
  compiledUsers: unknown[];
} {
  const user = buildInboundUser(node, SUB)!;
  const config = compileServerConfig({ inbounds: [{ node, users: [user] }] });
  const inbounds = config.inbounds as { users?: unknown[] }[];
  return { user, compiledUsers: inbounds[0]?.users ?? [] };
}

describe("classifyNodeAccounting", () => {
  it.each([
    "vless",
    "vmess",
    "trojan",
    "shadowsocks",
    "hysteria2",
    "hysteria",
    "tuic",
    "anytls",
  ])("accounts %s per user", (protocol) => {
    expect(classifyNodeAccounting({ protocol })).toEqual({
      status: "accounted",
      reason: "name-keyed-user",
    });
  });

  it.each(["naive", "socks", "http", "mixed"])(
    "accounts %s by username without per-node attribution",
    (protocol) => {
      expect(classifyNodeAccounting({ protocol })).toEqual({
        status: "accounted",
        reason: "username-keyed-user",
      });
    },
  );

  it("never calls an unregistered protocol accounted or unaccounted", () => {
    for (const protocol of [
      "wireguard",
      "future-proto",
      "VLESS",
      " vless",
      "",
    ]) {
      expect(classifyNodeAccounting({ protocol })).toEqual({
        status: "unknown",
        reason: "unregistered-protocol",
      });
    }
  });

  it("does not resolve Object.prototype members as protocols", () => {
    for (const protocol of [
      "constructor",
      "toString",
      "hasOwnProperty",
      "__proto__",
    ]) {
      expect(classifyNodeAccounting({ protocol }).status).toBe("unknown");
    }
  });

  it("treats registered inbounds without a users model as unknown", () => {
    for (const protocol of ["tun", "redirect", "tproxy", "direct"]) {
      expect(classifyNodeAccounting({ protocol })).toEqual({
        status: "unknown",
        reason: "no-user-model",
      });
    }
  });

  it("does not trust the protocol name alone for shadowtls", () => {
    // Its users have a `name`, but it only fronts a detour inbound.
    expect(classifyNodeAccounting({ protocol: "shadowtls" })).toEqual({
      status: "unknown",
      reason: "front-end-protocol",
    });
  });

  it("downgrades shadowsocks relay and managed modes to unknown", () => {
    const unknown = {
      status: "unknown",
      reason: "non-multi-user-mode",
    };
    expect(
      classifyNodeAccounting({
        protocol: "shadowsocks",
        settings: {
          destinations: [{ name: "a", server: "h", server_port: 1 }],
        },
      }),
    ).toEqual(unknown);
    expect(
      classifyNodeAccounting({
        protocol: "shadowsocks",
        settings: { managed: true },
      }),
    ).toEqual(unknown);
  });

  it("keeps ordinary shadowsocks settings accounted", () => {
    for (const settings of [
      null,
      undefined,
      {},
      { method: "2022-blake3-aes-256-gcm" },
      { destinations: [], managed: false },
    ]) {
      expect(
        classifyNodeAccounting({ protocol: "shadowsocks", settings }).status,
      ).toBe("accounted");
    }
  });

  it("does not let settings change a username-keyed protocol", () => {
    expect(
      classifyNodeAccounting({
        protocol: "socks",
        settings: { managed: true, destinations: [{}] },
      }).status,
    ).toBe("accounted");
  });

  it("classifies every node protocol into exactly one non-throwing state", () => {
    for (const protocol of NODE_PROTOCOLS) {
      const { status } = classifyNodeAccounting({ protocol });
      expect(["accounted", "unaccounted", "unknown"]).toContain(status);
    }
  });
});

describe("classification vs. the real compiler", () => {
  // Protocols whose stored settings must be non-empty to survive
  // Configuration.parse in this fixture.
  const SETTINGS: Record<string, Record<string, unknown>> = {};

  const compilable = NODE_PROTOCOLS.filter((protocol) => {
    try {
      compiledUser(makeNode(protocol, SETTINGS[protocol]));
      return true;
    } catch {
      return false;
    }
  });

  it("exercises the common and username-keyed protocols", () => {
    for (const protocol of [
      "vless",
      "vmess",
      "trojan",
      "hysteria2",
      "naive",
      "socks",
      "http",
    ]) {
      expect(compilable).toContain(protocol);
    }
  });

  it("accounted ⇔ the compiler embeds a user identifier", () => {
    for (const protocol of compilable) {
      if (protocol === "shadowtls") {
        continue; // `name` exists but classification is deliberately unknown.
      }
      const node = makeNode(protocol, SETTINGS[protocol]);
      const { user, compiledUsers } = compiledUser(node);
      const { status } = classifyNodeAccounting(node);
      if (status === "accounted") {
        const identifier = "name" in user ? user.name : user.username;
        expect(typeof identifier, protocol).toBe("string");
        expect(compiledUsers, protocol).toContainEqual(user);
      } else {
        expect(status, protocol).toBe("unknown");
      }
    }
  });

  it("matches the buildInboundUser key choice for every compilable protocol", () => {
    for (const protocol of compilable) {
      const node = makeNode(protocol, SETTINGS[protocol]);
      const user = buildInboundUser(node, SUB)!;
      const { reason } = classifyNodeAccounting(node);
      if (protocol === "shadowtls") {
        expect(reason).toBe("front-end-protocol");
      } else {
        expect(reason, protocol).toBe(
          "name" in user ? "name-keyed-user" : "username-keyed-user",
        );
      }
    }
  });
});

describe("summarizeAccounting", () => {
  const node = (protocol: string, id = protocol) => ({ id, protocol });

  it("does not warn for an empty selection and is not 'fully accounted'", () => {
    const summary = summarizeAccounting([]);
    expect(summary.shouldWarnQuotaIncomplete).toBe(false);
    expect(summary.isFullyAccounted).toBe(false);
    expect(summary.hasUnaccounted).toBe(false);
    expect(summary.hasUnknown).toBe(false);
  });

  it("is fully accounted with no warning for common named-user protocols", () => {
    const summary = summarizeAccounting([
      node("vless"),
      node("trojan"),
      node("hysteria2"),
    ]);
    expect(summary.accounted).toHaveLength(3);
    expect(summary.shouldWarnQuotaIncomplete).toBe(false);
    expect(summary.isFullyAccounted).toBe(true);
  });

  it("accounts username-keyed protocols without a warning", () => {
    const naive = node("naive", "n-1");
    const summary = summarizeAccounting([node("vless"), naive]);
    expect(summary.accounted).toEqual([node("vless"), naive]);
    expect(summary.unaccounted).toEqual([]);
    expect(summary.hasUnaccounted).toBe(false);
    expect(summary.hasUnknown).toBe(false);
    expect(summary.shouldWarnQuotaIncomplete).toBe(false);
    expect(summary.isFullyAccounted).toBe(true);
  });

  it("warns for unknown protocols", () => {
    const summary = summarizeAccounting([node("vless"), node("future-proto")]);
    expect(summary.unknown).toHaveLength(1);
    expect(summary.hasUnknown).toBe(true);
    expect(summary.hasUnaccounted).toBe(false);
    expect(summary.shouldWarnQuotaIncomplete).toBe(true);
    expect(summary.isFullyAccounted).toBe(false);
  });

  it("keeps accounted and unknown distinct in a mixed selection", () => {
    const summary = summarizeAccounting([
      node("vmess"),
      node("socks"),
      node("http"),
      node("wireguard"),
      node("shadowtls"),
    ]);
    expect(summary.accounted.map((n) => n.protocol)).toEqual([
      "vmess",
      "socks",
      "http",
    ]);
    expect(summary.unaccounted).toEqual([]);
    expect(summary.unknown.map((n) => n.protocol)).toEqual([
      "wireguard",
      "shadowtls",
    ]);
  });

  it("uses node settings when classifying", () => {
    const relay = {
      protocol: "shadowsocks",
      settings: { destinations: [{ name: "a" }] },
    };
    expect(summarizeAccounting([relay]).unknown).toEqual([relay]);
  });
});

describe("describeDeviceLimit", () => {
  it("never reports enforcement", () => {
    expect(DEVICE_LIMIT_ENFORCED).toBe(false);
    for (const limit of [0, 1, 3, -1, 1.5, NaN, null, undefined]) {
      expect(describeDeviceLimit(limit).enforced).toBe(false);
    }
  });

  it("treats 0 as unlimited: nothing stored, nothing to warn about", () => {
    expect(describeDeviceLimit(0)).toEqual({
      state: "unlimited",
      enforced: false,
      storedLimit: 0,
      shouldWarnNotEnforced: false,
    });
  });

  it("flags a positive stored limit as not enforced and preserves it", () => {
    expect(describeDeviceLimit(3)).toEqual({
      state: "stored-not-enforced",
      enforced: false,
      storedLimit: 3,
      shouldWarnNotEnforced: true,
    });
  });

  it("does not read invalid values as unlimited", () => {
    for (const limit of [-1, 1.5, NaN, Infinity, null, undefined]) {
      const result = describeDeviceLimit(limit);
      expect(result.state).toBe("invalid");
      expect(result.shouldWarnNotEnforced).toBe(true);
    }
    expect(describeDeviceLimit(-1).storedLimit).toBe(-1);
    expect(describeDeviceLimit(NaN).storedLimit).toBeNull();
    expect(describeDeviceLimit(null).storedLimit).toBeNull();
  });
});
