import { Configuration } from "@black-duty/sing-box-schema";
import { describe, expect, it } from "vitest";

import type { Node } from "@/db/proxy-schema";
import type { ResolvedNode } from "@/query/subscription-access";

import {
  buildSingboxClientConfig,
  explainSingboxNodeSkip,
  nodeToSingboxOutbound,
  NoUsableProxiesError,
} from "./singbox-client-config";

const credentials = {
  uuid: "550e8400-e29b-41d4-a716-446655440000",
  password: "cXdlcnR5dWkvb3BhZnM=",
  subscriptionId: "sub-123",
};

// Known valid 32-byte base64url private key for Reality tests:
// 32 bytes of 'a'
const REALITY_PRIVATE_KEY = Buffer.alloc(32, 0x61).toString("base64url");

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
    certificateKind: null,
    ...overrides,
  };
}

describe("buildSingboxClientConfig", () => {
  it("throws when there are no usable nodes", () => {
    expect(() => buildSingboxClientConfig([], { credentials })).toThrow(
      "No usable proxies",
    );
  });

  it("throws a typed error with no skipped nodes when given none", () => {
    try {
      buildSingboxClientConfig([], { credentials });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(NoUsableProxiesError);
      expect((error as NoUsableProxiesError).skipped).toEqual([]);
    }
  });

  it("reports why every node was skipped when none is usable", () => {
    const unsupported = makeResolved("wireguard", {});
    const unrepresentable = makeResolved("shadowsocks", {
      method: "2022-blake3-aes-256-gcm",
      // SS2022 multi-user requires server password; omitting it causes skip
    });
    try {
      buildSingboxClientConfig([unsupported, unrepresentable], { credentials });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(NoUsableProxiesError);
      expect((error as NoUsableProxiesError).skipped).toEqual([
        {
          nodeId: "node-wireguard",
          nodeName: "WIREGUARD Node",
          protocol: "wireguard",
          reason: "unsupported_protocol",
        },
        {
          nodeId: "node-shadowsocks",
          nodeName: "SHADOWSOCKS Node",
          protocol: "shadowsocks",
          reason: "unsupported_configuration",
        },
      ]);
    }
  });

  it("keeps convertible nodes and reports skipped ones", () => {
    const good = makeResolved("trojan", {});
    const bad = makeResolved("wireguard", {});
    const { config, outboundTags, skipped } = buildSingboxClientConfig(
      [bad, good],
      { credentials },
    );
    expect(outboundTags).toEqual(["TROJAN Node"]);
    expect(skipped).toEqual([
      {
        nodeId: "node-wireguard",
        nodeName: "WIREGUARD Node",
        protocol: "wireguard",
        reason: "unsupported_protocol",
      },
    ]);
    const parsed = Configuration.parse(config);
    expect(parsed.outbounds).toBeDefined();
  });

  it("never puts credentials or settings in skipped-node reports", () => {
    const secret = "super-secret-psk";
    const bad = makeResolved("shadowsocks", {
      method: "2022-blake3-aes-256-gcm",
      password: "",
      note: secret,
    });
    const { skipped } = buildSingboxClientConfig(
      [bad, makeResolved("trojan", {})],
      { credentials },
    );
    const text = JSON.stringify(skipped);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(credentials.uuid);
    expect(text).not.toContain(credentials.password);
  });

  it("makes duplicate and reserved outbound tags unique", () => {
    const node1 = makeResolved(
      "trojan",
      {},
      {
        node: {
          id: "1",
          name: "select",
          protocol: "trojan",
          listenPort: 443,
          settings: {},
        } as unknown as Node,
      },
    );
    const node2 = makeResolved(
      "trojan",
      {},
      {
        node: {
          id: "2",
          name: "select",
          protocol: "trojan",
          listenPort: 444,
          settings: {},
        } as unknown as Node,
      },
    );
    const { outboundTags, config } = buildSingboxClientConfig([node1, node2], {
      credentials,
    });
    expect(outboundTags).toEqual(["select 1", "select 2"]);
    const parsed = Configuration.parse(config);
    const tags = parsed.outbounds?.map((o) => o.tag);
    expect(tags).toEqual([
      "select",
      "auto",
      "select 1",
      "select 2",
      "direct",
      "block",
    ]);
  });

  it("builds a valid vless+ws config with tls and multiplex", () => {
    const node = makeResolved("vless", {
      flow: "xtls-rprx-vision",
      tls: {
        enabled: true,
        server_name: "example.com",
        alpn: ["h2", "http/1.1"],
      },
      transport: {
        type: "ws",
        path: "/ws",
        headers: { Host: "example.com" },
        max_early_data: 2048,
        early_data_header_name: "Sec-WebSocket-Protocol",
      },
      multiplex: {
        enabled: true,
        padding: true,
        brutal: {
          enabled: true,
          up_mbps: 50,
          down_mbps: 100,
        },
      },
      tcp_fast_open: true,
      tcp_multi_path: true,
    });
    const { config, outboundTags } = buildSingboxClientConfig([node], {
      credentials,
    });
    expect(outboundTags).toEqual(["VLESS Node"]);
    const parsed = Configuration.parse(config);
    const vlessOutbound = parsed.outbounds?.find((o) => o.tag === "VLESS Node");
    expect(vlessOutbound).toMatchObject({
      type: "vless",
      tag: "VLESS Node",
      server: "example.com",
      server_port: 443,
      uuid: credentials.uuid,
      flow: "xtls-rprx-vision",
      packet_encoding: "xudp",
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
      multiplex: {
        enabled: true,
        protocol: "h2mux",
        padding: true,
        brutal: {
          enabled: true,
          up_mbps: 50,
          down_mbps: 100,
        },
      },
      tcp_fast_open: true,
      tcp_multi_path: true,
    });
  });

  it("builds a valid vless with Reality and tlsServerName", () => {
    const node = makeResolved(
      "vless",
      {
        tls: {
          enabled: true,
          server_name: "old.example.com",
          reality: {
            enabled: true,
            private_key: REALITY_PRIVATE_KEY,
            short_id: ["0123456789abcdef"],
          },
        },
      },
      {
        node: {
          id: "node-vless",
          name: "VLESS Reality",
          listenPort: 443,
          protocol: "vless",
          tlsServerName: "reality.example.com",
          settings: {
            tls: {
              enabled: true,
              server_name: "old.example.com",
              reality: {
                enabled: true,
                private_key: REALITY_PRIVATE_KEY,
                short_id: ["0123456789abcdef"],
              },
            },
          },
        } as unknown as Node,
      },
    );
    const { config } = buildSingboxClientConfig([node], { credentials });
    const parsed = Configuration.parse(config);
    const outbound = parsed.outbounds?.find((o) => o.tag === "VLESS Reality");
    expect(outbound).toMatchObject({
      type: "vless",
      tls: {
        enabled: true,
        server_name: "reality.example.com",
        utls: {
          enabled: true,
          fingerprint: "chrome",
        },
        reality: {
          enabled: true,
          short_id: "0123456789abcdef",
        },
      },
    });
    expect(
      (outbound as { tls: { reality: { public_key: string } } }).tls.reality
        .public_key,
    ).toBeTypeOf("string");
  });

  it("builds a valid vmess+grpc config", () => {
    const node = makeResolved("vmess", {
      tls: { enabled: true, server_name: "example.com" },
      transport: { type: "grpc", service_name: "grpc-svc" },
    });
    const { config } = buildSingboxClientConfig([node], { credentials });
    const parsed = Configuration.parse(config);
    const outbound = parsed.outbounds?.find((o) => o.tag === "VMESS Node");
    expect(outbound).toMatchObject({
      type: "vmess",
      uuid: credentials.uuid,
      security: "auto",
      alter_id: 0,
      transport: {
        type: "grpc",
        service_name: "grpc-svc",
      },
    });
  });

  it("builds a valid trojan config", () => {
    const node = makeResolved("trojan", {
      tls: { enabled: true, server_name: "example.com" },
    });
    const { config } = buildSingboxClientConfig([node], { credentials });
    const parsed = Configuration.parse(config);
    const outbound = parsed.outbounds?.find((o) => o.tag === "TROJAN Node");
    expect(outbound).toMatchObject({
      type: "trojan",
      password: credentials.password,
      tls: { enabled: true, server_name: "example.com" },
    });
  });

  it("builds a valid shadowsocks config for classic and 2022 multi-user", () => {
    const classic = makeResolved(
      "shadowsocks",
      {
        method: "aes-256-gcm",
      },
      {
        node: {
          id: "ss-1",
          name: "SS Classic",
          protocol: "shadowsocks",
          listenPort: 8388,
          settings: { method: "aes-256-gcm" },
        } as unknown as Node,
      },
    );

    const ss2022 = makeResolved(
      "shadowsocks",
      {
        method: "2022-blake3-aes-128-gcm",
        password: "serverPSKbase64",
      },
      {
        node: {
          id: "ss-2",
          name: "SS 2022",
          protocol: "shadowsocks",
          listenPort: 8389,
          settings: {
            method: "2022-blake3-aes-128-gcm",
            password: "serverPSKbase64",
          },
        } as unknown as Node,
      },
    );

    const { config } = buildSingboxClientConfig([classic, ss2022], {
      credentials,
    });
    const parsed = Configuration.parse(config);
    const ob1 = parsed.outbounds?.find((o) => o.tag === "SS Classic");
    const ob2 = parsed.outbounds?.find((o) => o.tag === "SS 2022");
    expect(ob1).toMatchObject({
      type: "shadowsocks",
      method: "aes-256-gcm",
      password: credentials.password,
    });
    expect(ob2).toMatchObject({
      type: "shadowsocks",
      method: "2022-blake3-aes-128-gcm",
    });
    expect((ob2 as { password: string }).password).toContain(
      "serverPSKbase64:",
    );
  });

  it("builds a valid hysteria2 config with obfs and bandwidth limits", () => {
    const node = makeResolved("hysteria2", {
      tls: { enabled: true, server_name: "hy2.example.com" },
      obfs: { type: "salamander", password: "obfs-password" },
      up_mbps: 100,
      down_mbps: 200,
    });
    const { config } = buildSingboxClientConfig([node], { credentials });
    const parsed = Configuration.parse(config);
    const outbound = parsed.outbounds?.find((o) => o.tag === "HYSTERIA2 Node");
    expect(outbound).toMatchObject({
      type: "hysteria2",
      password: credentials.password,
      up_mbps: 100,
      down_mbps: 200,
      obfs: {
        type: "salamander",
        password: "obfs-password",
      },
    });
  });

  it("builds a valid hysteria v1 config", () => {
    const node = makeResolved("hysteria", {
      tls: { enabled: true, server_name: "hy1.example.com" },
      up_mbps: 50,
      down_mbps: 100,
      obfs: "obfs-key",
      recv_window_conn: 1048576,
      disable_mtu_discovery: true,
    });
    const { config } = buildSingboxClientConfig([node], { credentials });
    const parsed = Configuration.parse(config);
    const outbound = parsed.outbounds?.find((o) => o.tag === "HYSTERIA Node");
    expect(outbound).toMatchObject({
      type: "hysteria",
      auth_str: credentials.password,
      up_mbps: 50,
      down_mbps: 100,
      obfs: "obfs-key",
      recv_window_conn: 1048576,
      disable_mtu_discovery: true,
    });
  });

  it("builds a valid tuic config", () => {
    const node = makeResolved("tuic", {
      tls: { enabled: true, server_name: "tuic.example.com" },
      congestion_control: "bbr",
      udp_relay_mode: "native",
      zero_rtt_handshake: true,
      heartbeat: "15s",
    });
    const { config } = buildSingboxClientConfig([node], { credentials });
    const parsed = Configuration.parse(config);
    const outbound = parsed.outbounds?.find((o) => o.tag === "TUIC Node");
    expect(outbound).toMatchObject({
      type: "tuic",
      uuid: credentials.uuid,
      password: credentials.password,
      congestion_control: "bbr",
      udp_relay_mode: "native",
      zero_rtt_handshake: true,
      heartbeat: "15s",
    });
  });

  it("builds a valid anytls config with chrome utls", () => {
    const node = makeResolved("anytls", {
      tls: { enabled: true, server_name: "anytls.example.com" },
    });
    const { config } = buildSingboxClientConfig([node], { credentials });
    const parsed = Configuration.parse(config);
    const outbound = parsed.outbounds?.find((o) => o.tag === "ANYTLS Node");
    expect(outbound).toMatchObject({
      type: "anytls",
      password: credentials.password,
      tls: {
        enabled: true,
        server_name: "anytls.example.com",
        utls: {
          enabled: true,
          fingerprint: "chrome",
        },
      },
    });
  });

  it("builds a valid socks and http config with encoded user", () => {
    const socksNode = makeResolved(
      "socks",
      {},
      {
        node: {
          id: "socks-1",
          name: "SOCKS Node",
          protocol: "socks",
          listenPort: 1080,
          settings: {},
        } as unknown as Node,
      },
    );
    const httpNode = makeResolved(
      "http",
      {
        tls: { enabled: true, server_name: "http.example.com" },
      },
      {
        node: {
          id: "http-1",
          name: "HTTP Node",
          protocol: "http",
          listenPort: 8080,
          settings: {
            tls: { enabled: true, server_name: "http.example.com" },
          },
        } as unknown as Node,
      },
    );

    const { config } = buildSingboxClientConfig([socksNode, httpNode], {
      credentials,
    });
    const parsed = Configuration.parse(config);
    const socksOutbound = parsed.outbounds?.find((o) => o.tag === "SOCKS Node");
    const httpOutbound = parsed.outbounds?.find((o) => o.tag === "HTTP Node");

    expect(socksOutbound).toMatchObject({
      type: "socks",
      version: "5",
      password: credentials.password,
    });
    expect((socksOutbound as { username: string }).username).toContain(
      "blz.1.",
    );

    expect(httpOutbound).toMatchObject({
      type: "http",
      password: credentials.password,
      tls: { enabled: true, server_name: "http.example.com" },
    });
    expect((httpOutbound as { username: string }).username).toContain("blz.1.");
  });

  it("sets insecure = true on self-signed managed certificates", () => {
    const node = makeResolved(
      "trojan",
      { tls: { enabled: true, server_name: "example.com" } },
      {
        certificateKind: "self_signed",
        node: {
          id: "trojan-1",
          name: "Trojan SelfSigned",
          protocol: "trojan",
          certificateId: "cert-1",
          tlsServerName: "trojan.custom.com",
          listenPort: 443,
          settings: { tls: { enabled: true } },
        } as unknown as Node,
      },
    );
    const { config } = buildSingboxClientConfig([node], { credentials });
    const parsed = Configuration.parse(config);
    const outbound = parsed.outbounds?.find(
      (o) => o.tag === "Trojan SelfSigned",
    );
    expect(outbound).toMatchObject({
      type: "trojan",
      tls: {
        enabled: true,
        server_name: "trojan.custom.com",
        insecure: true,
      },
    });
  });

  it("supports per-node credential resolver", () => {
    const nodeA = makeResolved(
      "trojan",
      {},
      {
        node: {
          id: "a",
          name: "Node A",
          protocol: "trojan",
          listenPort: 443,
          settings: {},
        } as unknown as Node,
      },
    );
    const nodeB = makeResolved(
      "trojan",
      {},
      {
        node: {
          id: "b",
          name: "Node B",
          protocol: "trojan",
          listenPort: 444,
          settings: {},
        } as unknown as Node,
      },
    );
    const { config } = buildSingboxClientConfig([nodeA, nodeB], {
      credentials,
      resolveCredentials: (res) =>
        res.node.id === "b"
          ? { uuid: "old-uuid", password: "old-password" }
          : credentials,
    });
    const parsed = Configuration.parse(config);
    const obA = parsed.outbounds?.find((o) => o.tag === "Node A");
    const obB = parsed.outbounds?.find((o) => o.tag === "Node B");
    expect(obA).toMatchObject({ password: credentials.password });
    expect(obB).toMatchObject({ password: "old-password" });
  });

  it("exports explainSingboxNodeSkip and nodeToSingboxOutbound", () => {
    const wireguard = makeResolved("wireguard", {});
    expect(explainSingboxNodeSkip(wireguard)).toBe("unsupported_protocol");
    expect(nodeToSingboxOutbound(wireguard, credentials)).toBeNull();

    const trojan = makeResolved("trojan", {});
    expect(explainSingboxNodeSkip(trojan)).toBe("unsupported_configuration");
    const outbound = nodeToSingboxOutbound(trojan, credentials);
    expect(outbound).not.toBeNull();
    expect(outbound?.type).toBe("trojan");
  });
});
