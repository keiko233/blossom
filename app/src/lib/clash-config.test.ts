import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import type { Node } from "@/db/proxy-schema";

import { buildClashConfig } from "./clash-config";

const credentials = {
  uuid: "550e8400-e29b-41d4-a716-446655440000",
  password: "cXdlcnR5dWkvb3BhZnM=",
};

function makeNode(protocol: string, settings: Record<string, unknown>): Node {
  return {
    id: `node-${protocol}`,
    name: `${protocol.toUpperCase()} Node`,
    remark: null,
    tags: [],
    enabled: true,
    address: "example.com",
    listenPort: 443,
    protocol,
    settings: settings as Node["settings"],
    agentTokenHash: "hash",
    agentTokenPrefix: "pre",
    lastSeenAt: null,
    agentVersion: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("buildClashConfig", () => {
  it("throws when there are no usable proxies", () => {
    expect(() => buildClashConfig([], { credentials })).toThrow(
      "No usable proxies",
    );
  });

  it("builds a serializable vless+ws config", () => {
    const node = makeNode("vless", {
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
  });

  it("builds a vmess+grpc config", () => {
    const node = makeNode("vmess", {
      tls: { enabled: true, server_name: "example.com" },
      transport: { type: "grpc", service_name: "svc" },
    });
    const { config } = buildClashConfig([node], { credentials });
    expect(config).toMatchObject({
      proxies: [expect.objectContaining({ type: "vmess", network: "grpc" })],
    });
  });

  it("builds a trojan config", () => {
    const node = makeNode("trojan", {
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
    const node = makeNode("shadowsocks", { method: "aes-256-gcm" });
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
    const node = makeNode("shadowsocks", {
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
    const node = makeNode("shadowsocks", {
      method: "2022-blake3-aes-256-gcm",
    });
    expect(() => buildClashConfig([node], { credentials })).toThrow(
      "No usable proxies",
    );
  });

  it("produces unique proxy names", () => {
    const node = makeNode("vless", {});
    const { config } = buildClashConfig([node, node], { credentials });
    const names = (config as { proxies: { name: string }[] }).proxies.map(
      (p) => p.name,
    );
    expect(new Set(names).size).toBe(2);
    expect(names).toContain("VLESS Node");
    expect(names).toContain("VLESS Node 2");
  });

  it("serializes to YAML without errors", () => {
    const node = makeNode("vless", {
      tls: { enabled: true, server_name: "example.com" },
    });
    const { config } = buildClashConfig([node], { credentials });
    const yaml = parseYaml(JSON.stringify(config));
    expect(yaml).toBeDefined();
  });
});
