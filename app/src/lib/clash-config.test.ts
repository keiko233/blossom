import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import type { Node } from "@/db/proxy-schema";
import type { ResolvedNode } from "@/query/subscription-access";

import { buildClashConfig } from "./clash-config";
import { clashMetaSchema } from "./clash-meta-schema";

const credentials = {
  uuid: "550e8400-e29b-41d4-a716-446655440000",
  password: "cXdlcnR5dWkvb3BhZnM=",
};

function makeResolved(
  protocol: string,
  settings: Record<string, unknown>,
  overrides: Partial<ResolvedNode> = {},
): ResolvedNode {
  const node: Node = {
    id: `node-${protocol}`,
    name: `${protocol.toUpperCase()} Node`,
    remark: null,
    tags: [],
    enabled: true,
    serverId: `server-${protocol}`,
    address: null,
    listenPort: 443,
    protocol,
    settings: settings as Node["settings"],
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Node;
  return {
    node,
    server: {
      id: `server-${protocol}`,
      name: `${protocol.toUpperCase()} Server`,
      address: "example.com",
    },
    address: "example.com",
    ...overrides,
  };
}

// The bundled JSON schema uses draft-7 conditionals that zod's fromJSONSchema
// does not fully support; if construction failed it falls back to z.any().
function schemaIsEffectivelyAny(): boolean {
  try {
    return clashMetaSchema.safeParse({ not: "a valid clash config" }).success;
  } catch {
    return true;
  }
}

const expectSchema = schemaIsEffectivelyAny()
  ? () => {
      /* schema construction failed; skip validation */
    }
  : (config: unknown) => {
      const result = clashMetaSchema.safeParse(config);
      expect(result.success).toBe(true);
    };

describe("buildClashConfig", () => {
  it("throws when there are no usable proxies", () => {
    expect(() => buildClashConfig([], { credentials })).toThrow(
      "No usable proxies",
    );
  });

  it("builds a serializable vless+ws config", () => {
    const node = makeResolved("vless", {
      tls: {
        enabled: true,
        server_name: "example.com",
        alpn: ["h2", "http/1.1"],
      },
      transport: {
        type: "ws",
        path: "/ws",
        headers: { Host: "example.com" },
      },
    });
    const { config } = buildClashConfig([node], { credentials });
    expect(config).toMatchObject({
      "mixed-port": 7890,
      mode: "rule",
      proxies: [
        expect.objectContaining({
          type: "vless",
          server: "example.com",
          port: 443,
          uuid: credentials.uuid,
          sni: "example.com",
          network: "ws",
        }),
      ],
    });
    expect(() => parseYaml(JSON.stringify(config))).not.toThrow();
    expectSchema(config);
  });

  it("builds a vmess+grpc config", () => {
    const node = makeResolved("vmess", {
      tls: { enabled: true, server_name: "example.com" },
      transport: { type: "grpc", service_name: "svc" },
    });
    const { config } = buildClashConfig([node], { credentials });
    expect(config).toMatchObject({
      proxies: [expect.objectContaining({ type: "vmess", network: "grpc" })],
    });
  });

  it("builds a trojan config", () => {
    const node = makeResolved("trojan", {
      tls: { enabled: true, server_name: "example.com" },
    });
    const { config } = buildClashConfig([node], { credentials });
    expect(config).toMatchObject({
      proxies: [
        expect.objectContaining({
          type: "trojan",
          password: credentials.password,
        }),
      ],
    });
  });

  it("builds a shadowsocks config", () => {
    const node = makeResolved("shadowsocks", { method: "aes-256-gcm" });
    const { config } = buildClashConfig([node], { credentials });
    expect(config).toMatchObject({
      proxies: [
        expect.objectContaining({
          type: "ss",
          cipher: "aes-256-gcm",
          password: credentials.password,
        }),
      ],
    });
  });

  it("prefixes the server PSK for shadowsocks 2022 methods", () => {
    const serverPsk = Buffer.alloc(32, 7).toString("base64");
    const node = makeResolved("shadowsocks", {
      method: "2022-blake3-aes-256-gcm",
      password: serverPsk,
    });
    const { config } = buildClashConfig([node], { credentials });
    expect(config).toMatchObject({
      proxies: [
        expect.objectContaining({
          type: "ss",
          cipher: "2022-blake3-aes-256-gcm",
          password: `${serverPsk}:${credentials.password}`,
        }),
      ],
    });
  });

  it("skips shadowsocks 2022 nodes without a server PSK", () => {
    const node = makeResolved("shadowsocks", {
      method: "2022-blake3-aes-256-gcm",
    });
    expect(() => buildClashConfig([node], { credentials })).toThrow(
      "No usable proxies",
    );
  });

  it("produces unique proxy names", () => {
    const node = makeResolved("vless", {});
    const { config } = buildClashConfig([node, node], { credentials });
    const names = (config as { proxies: { name: string }[] }).proxies.map(
      (p) => p.name,
    );
    expect(new Set(names).size).toBe(2);
    expect(names).toContain("VLESS Node");
    expect(names).toContain("VLESS Node 2");
  });

  it("serializes to YAML without errors", () => {
    const node = makeResolved("vless", {
      tls: { enabled: true, server_name: "example.com" },
    });
    const { config } = buildClashConfig([node], { credentials });
    const yaml = parseYaml(JSON.stringify(config));
    expect(yaml).toBeDefined();
  });

  it("applies tfo and mptcp to proxies", () => {
    const vlessNode = makeResolved("vless", {
      tcp_fast_open: true,
      tcp_multi_path: true,
      tls: { enabled: true, server_name: "example.com" },
    });
    const ssNode = makeResolved("shadowsocks", {
      method: "aes-256-gcm",
      tcp_fast_open: true,
    });
    const { config } = buildClashConfig([vlessNode, ssNode], { credentials });
    const proxies = (config as { proxies: Record<string, unknown>[] }).proxies;
    expect(proxies[0]).toMatchObject({ tfo: true, mptcp: true });
    expect(proxies[1]).toMatchObject({ tfo: true });
    expect(proxies[1]).not.toHaveProperty("mptcp");
  });

  it("maps multiplex to smux with padding and brutal options", () => {
    const node = makeResolved("vless", {
      tls: { enabled: true, server_name: "example.com" },
      multiplex: {
        enabled: true,
        padding: true,
        brutal: { enabled: true, up_mbps: 100, down_mbps: 50 },
      },
    });
    const { config } = buildClashConfig([node], { credentials });
    expect(config).toMatchObject({
      proxies: [
        expect.objectContaining({
          smux: {
            enabled: true,
            protocol: "h2mux",
            padding: true,
            "brutal-opts": { up: 100, down: 50 },
          },
        }),
      ],
    });
  });

  it("maps multiplex to smux without brutal when speeds are missing", () => {
    const node = makeResolved("trojan", {
      tls: { enabled: true, server_name: "example.com" },
      multiplex: { enabled: true, padding: false },
    });
    const { config } = buildClashConfig([node], { credentials });
    expect(config).toMatchObject({
      proxies: [
        expect.objectContaining({
          smux: {
            enabled: true,
            protocol: "h2mux",
            padding: false,
          },
        }),
      ],
    });
    expect(
      (config as { proxies: { smux: Record<string, unknown> }[] }).proxies[0]
        .smux,
    ).not.toHaveProperty("brutal-opts");
  });

  it("derives the vless Reality public key from the private key", () => {
    const privateKey = "RU-e9PZ4FAHqaQSBSQl4Jq0_CVNZN1q493YbS7C5I7g";
    const expectedPublicKey = "K21PpkAl6FKaZ3jKtE8oyu_Sqk75g9eCzIVzyCU5rgw";
    const node = makeResolved("vless", {
      tls: {
        enabled: true,
        server_name: "example.com",
        reality: {
          enabled: true,
          private_key: privateKey,
          short_id: ["0123456789abcdef"],
        },
      },
    });
    const { config } = buildClashConfig([node], { credentials });
    expect(config).toMatchObject({
      proxies: [
        expect.objectContaining({
          type: "vless",
          tls: true,
          servername: "example.com",
          "client-fingerprint": "chrome",
          "reality-opts": {
            "public-key": expectedPublicKey,
            "short-id": "0123456789abcdef",
          },
        }),
      ],
    });
  });

  it("skips vless Reality nodes with an invalid private key", () => {
    const node = makeResolved("vless", {
      tls: {
        enabled: true,
        server_name: "example.com",
        reality: { enabled: true, private_key: "not-a-key" },
      },
    });
    expect(() => buildClashConfig([node], { credentials })).toThrow(
      "No usable proxies",
    );
  });

  it("treats vless with a disabled reality object as plain TLS", () => {
    const node = makeResolved("vless", {
      tls: {
        enabled: true,
        server_name: "example.com",
        reality: { enabled: false, private_key: "not-a-key" },
      },
    });
    const { config } = buildClashConfig([node], { credentials });
    const proxy = (config as { proxies: Record<string, unknown>[] }).proxies[0];
    expect(proxy).toMatchObject({
      type: "vless",
      tls: true,
      servername: "example.com",
    });
    expect(proxy).not.toHaveProperty("reality-opts");
  });

  it("maps transport http with TLS to h2", () => {
    const node = makeResolved("vless", {
      tls: { enabled: true, server_name: "example.com" },
      transport: { type: "http", host: "example.com", path: "/h2" },
    });
    const { config } = buildClashConfig([node], { credentials });
    expect(config).toMatchObject({
      proxies: [
        expect.objectContaining({
          network: "h2",
          "h2-opts": { host: ["example.com"], path: "/h2" },
        }),
      ],
    });
  });

  it("maps transport http without TLS to http with array-valued opts", () => {
    const node = makeResolved("vmess", {
      transport: {
        type: "http",
        host: "example.com",
        path: "/http",
        method: "GET",
      },
    });
    const { config } = buildClashConfig([node], { credentials });
    expect(config).toMatchObject({
      proxies: [
        expect.objectContaining({
          network: "http",
          "http-opts": {
            method: "GET",
            path: ["/http"],
            headers: { Host: ["example.com"] },
          },
        }),
      ],
    });
  });

  it("maps transport http host array to h2 with all hosts", () => {
    const node = makeResolved("vless", {
      tls: { enabled: true, server_name: "example.com" },
      transport: {
        type: "http",
        host: ["a.example.com", "b.example.com"],
        path: "/h2",
      },
    });
    const { config } = buildClashConfig([node], { credentials });
    expect(config).toMatchObject({
      proxies: [
        expect.objectContaining({
          network: "h2",
          "h2-opts": {
            host: ["a.example.com", "b.example.com"],
            path: "/h2",
          },
        }),
      ],
    });
  });

  it("maps transport http host array to http headers with all hosts", () => {
    const node = makeResolved("vmess", {
      transport: {
        type: "http",
        host: ["a.example.com", "b.example.com"],
        path: "/http",
      },
    });
    const { config } = buildClashConfig([node], { credentials });
    expect(config).toMatchObject({
      proxies: [
        expect.objectContaining({
          network: "http",
          "http-opts": {
            path: ["/http"],
            headers: { Host: ["a.example.com", "b.example.com"] },
          },
        }),
      ],
    });
  });

  it("maps tuic reduce-rtt and heartbeat interval", () => {
    const node = makeResolved("tuic", {
      tls: { enabled: true, server_name: "example.com" },
      zero_rtt_handshake: true,
      heartbeat: "10s",
    });
    const { config } = buildClashConfig([node], { credentials });
    expect(config).toMatchObject({
      proxies: [
        expect.objectContaining({
          type: "tuic",
          "reduce-rtt": true,
          "heartbeat-interval": 10000,
        }),
      ],
    });
  });

  it("parses tuic heartbeat in milliseconds", () => {
    const node = makeResolved("tuic", {
      tls: { enabled: true, server_name: "example.com" },
      heartbeat: "500ms",
    });
    const { config } = buildClashConfig([node], { credentials });
    expect(config).toMatchObject({
      proxies: [
        expect.objectContaining({
          "heartbeat-interval": 500,
        }),
      ],
    });
  });

  it("maps hysteria v1 receive window conn and mtu discovery", () => {
    const node = makeResolved("hysteria", {
      tls: { enabled: true, server_name: "example.com" },
      recv_window_conn: 4194304,
      disable_mtu_discovery: true,
    });
    const { config } = buildClashConfig([node], { credentials });
    expect(config).toMatchObject({
      proxies: [
        expect.objectContaining({
          type: "hysteria",
          "recv-window-conn": 4194304,
          "disable-mtu-discovery": true,
        }),
      ],
    });
    expect(
      (config as { proxies: Record<string, unknown>[] }).proxies[0],
    ).not.toHaveProperty("recv-window");
  });

  it("passes the clash-meta JSON schema when the schema loaded", () => {
    if (schemaIsEffectivelyAny()) {
      // zod could not convert the draft-7 conditional schema; skip.
      return;
    }
    const nodes = [
      makeResolved("vless", {
        tls: { enabled: true, server_name: "example.com" },
      }),
      makeResolved("vmess", {
        tls: { enabled: true, server_name: "example.com" },
      }),
      makeResolved("trojan", {
        tls: { enabled: true, server_name: "example.com" },
      }),
      makeResolved("shadowsocks", { method: "aes-256-gcm" }),
      makeResolved("hysteria2", {
        tls: { enabled: true, server_name: "example.com" },
      }),
      makeResolved("hysteria", {
        tls: { enabled: true, server_name: "example.com" },
      }),
      makeResolved("tuic", {
        tls: { enabled: true, server_name: "example.com" },
      }),
      makeResolved("anytls", {
        tls: { enabled: true, server_name: "example.com" },
      }),
    ];
    const { config } = buildClashConfig(nodes, { credentials });
    const result = clashMetaSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});
