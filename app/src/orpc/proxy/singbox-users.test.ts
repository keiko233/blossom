import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { Subscription } from "@/db/plan-schema";
import type { Node } from "@/db/proxy-schema";

import { buildInboundUser } from "./singbox-users";
import { encodeTrafficUser } from "./traffic-user-codec";

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
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Node;
}

// 32 random bytes in base64, as generateSubscriptionCredentials produces.
const PASSWORD = Buffer.alloc(32, 7).toString("base64");
const UUID = randomUUID();

function makeSubscription(): Subscription {
  return {
    id: "sub-1",
    userId: "user-1",
    planId: "plan-1",
    status: "active",
    startedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
    trafficQuotaBytes: 0,
    trafficUsedBytes: 0,
    deviceLimit: 0,
    credentialUuid: UUID,
    credentialPassword: PASSWORD,
    token: "token",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("buildInboundUser", () => {
  const sub = makeSubscription();
  // All name-keyed protocols now carry the codec-encoded (node, sub) identifier
  // so v2ray_api per-user stats still attribute traffic to a specific inbound.
  const codedName = encodeTrafficUser("node-1", "sub-1");

  it("maps vless to name + uuid without flow", () => {
    const user = buildInboundUser(makeNode("vless"), sub);
    expect(user).toEqual({ name: codedName, uuid: UUID });
  });

  it("maps vmess to name + uuid", () => {
    const user = buildInboundUser(makeNode("vmess"), sub);
    expect(user).toEqual({ name: codedName, uuid: UUID });
  });

  it("maps trojan to name + password", () => {
    const user = buildInboundUser(makeNode("trojan"), sub);
    expect(user).toEqual({ name: codedName, password: PASSWORD });
  });

  it("keeps the stored password for classic shadowsocks methods", () => {
    const node = makeNode("shadowsocks", { method: "aes-128-gcm" });
    expect(buildInboundUser(node, sub)?.password).toBe(PASSWORD);
  });

  it("truncates the key to 16 bytes for 2022-blake3-aes-128-gcm", () => {
    const node = makeNode("shadowsocks", { method: "2022-blake3-aes-128-gcm" });
    const password = buildInboundUser(node, sub)?.password as string;
    const key = Buffer.from(password, "base64");
    expect(key.length).toBe(16);
    expect(key.equals(Buffer.from(PASSWORD, "base64").subarray(0, 16))).toBe(
      true,
    );
  });

  it("keeps the 32-byte key for 2022-blake3-aes-256-gcm", () => {
    const node = makeNode("shadowsocks", { method: "2022-blake3-aes-256-gcm" });
    expect(buildInboundUser(node, sub)?.password).toBe(PASSWORD);
  });

  it("maps tuic to name + uuid + password", () => {
    const user = buildInboundUser(makeNode("tuic"), sub);
    expect(user).toEqual({
      name: codedName,
      uuid: UUID,
      password: PASSWORD,
    });
  });

  it("maps hysteria to auth_str, not password", () => {
    const user = buildInboundUser(makeNode("hysteria"), sub);
    expect(user).toEqual({ name: codedName, auth_str: PASSWORD });
  });

  it("maps hysteria2 to name + password", () => {
    const user = buildInboundUser(makeNode("hysteria2"), sub);
    expect(user).toEqual({ name: codedName, password: PASSWORD });
  });

  it("keys naive users by username instead of name", () => {
    // Username-keyed protocols keep the bare subscription id — they have no
    // `name` field, so per-user v2ray_api stats are already keyed on `username`.
    // Per-node attribution loss is an accepted limitation for these protocols.
    const user = buildInboundUser(makeNode("naive"), sub);
    expect(user).toEqual({ username: "sub-1", password: PASSWORD });
  });

  it("returns null for inbounds without users", () => {
    expect(buildInboundUser(makeNode("direct"), sub)).toBeNull();
  });

  it("returns null for unknown protocols", () => {
    expect(buildInboundUser(makeNode("not-a-protocol"), sub)).toBeNull();
  });
});
