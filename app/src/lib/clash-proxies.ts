import { createPrivateKey, createPublicKey } from "node:crypto";

import type { JsonValue } from "@/orpc/proxy/schema";
import {
  isNodeRealityEnabled,
  isNodeTlsEnabled,
  protocolSupportsTls,
} from "@/orpc/proxy/sing-box-registry";
import { passwordFor } from "@/orpc/proxy/singbox-users";
import type { ResolvedNode } from "@/query/subscription-access";

interface SubscriptionCredentials {
  uuid: string;
  password: string;
}

/**
 * Fields deliberately NOT converted from sing-box inbound to Clash Meta proxy:
 *
 * - Server-only fields that have no client meaning: trojan `fallback`,
 *   hysteria2 `masquerade` / `ignore_client_bandwidth`, anytls `padding_scheme`,
 *   TLS certificate material / `min_version` / `max_version`.
 * - `tls.ech`: the inbound only stores the server ECH key, not the config list
 *   clients need, so it is omitted. ECH-enabled servers still accept plain TLS.
 * - vless `flow`: it is deliberately not set server-side (see singbox-users.ts),
 *   so no client flow value is emitted.
 * - shadowsocks `plugin` / `plugin_opts` and `udp_over_tcp`: these are
 *   sing-box outbound-only options and can never appear in stored inbound
 *   settings, so they are not mapped to Clash Meta.
 */

interface ParsedTls {
  tls?: boolean;
  sni?: string;
  servername?: string;
  alpn?: string[];
  "skip-cert-verify"?: boolean;
  "client-fingerprint"?: string;
  "reality-opts"?: Record<string, JsonValue>;
}

function parseTls(settings: Record<string, JsonValue>): ParsedTls | null {
  const tls = settings.tls;
  if (typeof tls !== "object" || tls === null || Array.isArray(tls)) {
    return null;
  }
  const tlsObj = tls as Record<string, JsonValue>;
  const enabled = tlsObj.enabled === true;
  if (!enabled) {
    return null;
  }

  const result: ParsedTls = {
    tls: true,
    "skip-cert-verify": false,
  };

  if (typeof tlsObj.server_name === "string") {
    result.sni = tlsObj.server_name;
    result.servername = tlsObj.server_name;
  }
  if (Array.isArray(tlsObj.alpn)) {
    const alpn = tlsObj.alpn.filter((v): v is string => typeof v === "string");
    if (alpn.length > 0) {
      result.alpn = alpn;
    }
  }

  return result;
}

const PKCS8_X25519_PREFIX = Buffer.from(
  "302e020100300506032b656e04220420",
  "hex",
);

function realityPublicKey(privateKeyB64url: string): string | null {
  const raw = Buffer.from(privateKeyB64url, "base64url");
  if (raw.length !== 32) return null;
  try {
    const priv = createPrivateKey({
      key: Buffer.concat([PKCS8_X25519_PREFIX, raw]),
      format: "der",
      type: "pkcs8",
    });
    const spki = createPublicKey(priv).export({ type: "spki", format: "der" });
    return Buffer.from(spki.subarray(-32)).toString("base64url");
  } catch {
    return null;
  }
}

function parseRealityOpts(
  tlsObj: Record<string, JsonValue>,
): Record<string, JsonValue> | null {
  const reality = tlsObj.reality;
  if (
    typeof reality !== "object" ||
    reality === null ||
    Array.isArray(reality)
  ) {
    return null;
  }
  const realityObj = reality as Record<string, JsonValue>;
  const privateKey =
    typeof realityObj.private_key === "string" ? realityObj.private_key : null;
  if (!privateKey) return null;
  const publicKey = realityPublicKey(privateKey);
  if (publicKey === null) return null;

  const shortIdList = realityObj.short_id;
  const shortId =
    Array.isArray(shortIdList) && typeof shortIdList[0] === "string"
      ? shortIdList[0]
      : "";
  return {
    "public-key": publicKey,
    "short-id": shortId,
  };
}

interface TransportResult {
  network?: string;
  "ws-opts"?: Record<string, JsonValue>;
  "grpc-opts"?: Record<string, JsonValue>;
  "h2-opts"?: Record<string, JsonValue>;
  "http-opts"?: Record<string, JsonValue>;
}

function parseTransport(
  settings: Record<string, JsonValue>,
  tlsEnabled: boolean,
): TransportResult | null {
  const transport = settings.transport;
  if (
    typeof transport !== "object" ||
    transport === null ||
    Array.isArray(transport)
  ) {
    return {};
  }
  const t = transport as Record<string, JsonValue>;
  const type = typeof t.type === "string" ? t.type : "tcp";

  switch (type) {
    case "tcp":
    case "":
      return {};

    case "ws": {
      const headers: Record<string, string> = {};
      if (
        typeof t.headers === "object" &&
        t.headers !== null &&
        !Array.isArray(t.headers)
      ) {
        const host = (t.headers as Record<string, JsonValue>).Host;
        if (typeof host === "string") {
          headers.Host = host;
        }
      }
      const wsOpts: Record<string, JsonValue> = {
        path: typeof t.path === "string" ? t.path : "/",
      };
      if (Object.keys(headers).length > 0) {
        wsOpts.headers = headers;
      }
      if (typeof t.max_early_data === "number") {
        wsOpts["max-early-data"] = t.max_early_data;
      }
      if (typeof t.early_data_header_name === "string") {
        wsOpts["early-data-header-name"] = t.early_data_header_name;
      }
      return { network: "ws", "ws-opts": wsOpts };
    }

    case "grpc": {
      const serviceName =
        typeof t.service_name === "string" ? t.service_name : "";
      return {
        network: "grpc",
        "grpc-opts": { "grpc-service-name": serviceName },
      };
    }

    case "httpupgrade": {
      const headers: Record<string, string> = {};
      if (typeof t.host === "string") {
        headers.Host = t.host;
      }
      const wsOpts: Record<string, JsonValue> = {
        path: typeof t.path === "string" ? t.path : "/",
        "v2ray-http-upgrade": true,
      };
      if (Object.keys(headers).length > 0) {
        wsOpts.headers = headers;
      }
      return { network: "ws", "ws-opts": wsOpts };
    }

    case "http": {
      let hostList: string[] = [];
      if (typeof t.host === "string") {
        hostList = t.host ? [t.host] : [];
      } else if (Array.isArray(t.host)) {
        hostList = t.host.filter((v): v is string => typeof v === "string");
      }
      const path = typeof t.path === "string" ? t.path : "/";
      if (tlsEnabled) {
        return {
          network: "h2",
          "h2-opts": { host: hostList, path },
        };
      }
      const httpOpts: Record<string, JsonValue> = {
        path: [path],
      };
      if (typeof t.method === "string") {
        httpOpts.method = t.method;
      }
      if (hostList.length > 0) {
        httpOpts.headers = { Host: hostList };
      }
      return { network: "http", "http-opts": httpOpts };
    }

    case "quic":
      // Clash Meta does not support vmess-quic.
      return null;

    default:
      return null;
  }
}

function parseSmux(
  settings: Record<string, JsonValue>,
): Record<string, JsonValue> | undefined {
  const multiplex = settings.multiplex;
  if (
    typeof multiplex !== "object" ||
    multiplex === null ||
    Array.isArray(multiplex)
  ) {
    return undefined;
  }
  const mux = multiplex as Record<string, JsonValue>;
  if (mux.enabled !== true) return undefined;

  const smux: Record<string, JsonValue> = {
    enabled: true,
    protocol: "h2mux",
    padding: mux.padding === true,
  };

  const brutal = mux.brutal;
  if (typeof brutal === "object" && brutal !== null && !Array.isArray(brutal)) {
    const b = brutal as Record<string, JsonValue>;
    if (
      b.enabled === true &&
      typeof b.up_mbps === "number" &&
      typeof b.down_mbps === "number"
    ) {
      smux["brutal-opts"] = { up: b.up_mbps, down: b.down_mbps };
    }
  }

  return smux;
}

function parseDurationMs(value: JsonValue): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
  if (!match) return undefined;
  const n = Number.parseFloat(match[1]);
  const unit = match[2];
  switch (unit) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60 * 1000;
    case "h":
      return n * 60 * 60 * 1000;
  }
  return undefined;
}

type ProxyBuilder = (
  resolved: ResolvedNode,
  credentials: SubscriptionCredentials,
) => Record<string, JsonValue> | null;

function baseProxy(resolved: ResolvedNode): Record<string, JsonValue> {
  const proxy: Record<string, JsonValue> = {
    name: resolved.node.name,
    server: resolved.address,
    port: resolved.node.listenPort,
    udp: true,
  };
  if (resolved.node.settings.tcp_fast_open === true) {
    proxy.tfo = true;
  }
  if (resolved.node.settings.tcp_multi_path === true) {
    proxy.mptcp = true;
  }
  return proxy;
}

const BUILDERS: Record<string, ProxyBuilder> = {
  vless(resolved, credentials) {
    const node = resolved.node;
    const tlsSettings = node.settings.tls;
    const tlsObj =
      typeof tlsSettings === "object" &&
      tlsSettings !== null &&
      !Array.isArray(tlsSettings)
        ? (tlsSettings as Record<string, JsonValue>)
        : null;
    const reality = tlsObj?.reality;
    // A stored reality object with enabled !== true means Reality is switched
    // off; the node is then a plain-TLS (or plaintext) vless inbound.
    const hasReality =
      tlsObj?.enabled === true &&
      typeof reality === "object" &&
      reality !== null &&
      !Array.isArray(reality) &&
      (reality as Record<string, JsonValue>).enabled === true;

    const proxy: Record<string, JsonValue> = {
      ...baseProxy(resolved),
      type: "vless",
      uuid: credentials.uuid,
    };

    let tlsEnabled = false;
    if (hasReality && tlsObj) {
      const realityOpts = parseRealityOpts(tlsObj);
      if (realityOpts === null) return null;
      tlsEnabled = true;
      proxy.tls = true;
      if (typeof tlsObj.server_name === "string") {
        proxy.servername = tlsObj.server_name;
        proxy.sni = tlsObj.server_name;
      }
      proxy["client-fingerprint"] = "chrome";
      proxy["reality-opts"] = realityOpts;
      if (Array.isArray(tlsObj.alpn)) {
        const alpn = tlsObj.alpn.filter(
          (v): v is string => typeof v === "string",
        );
        if (alpn.length > 0) {
          proxy.alpn = alpn;
        }
      }
    } else {
      const tls = parseTls(node.settings);
      if (tls) {
        tlsEnabled = true;
        Object.assign(proxy, tls);
      }
    }

    const transport = parseTransport(node.settings, tlsEnabled);
    if (transport === null) {
      return null;
    }
    Object.assign(proxy, transport);

    const smux = parseSmux(node.settings);
    if (smux) {
      proxy.smux = smux;
    }

    return proxy;
  },

  vmess(resolved, credentials) {
    const node = resolved.node;
    const proxy: Record<string, JsonValue> = {
      ...baseProxy(resolved),
      type: "vmess",
      uuid: credentials.uuid,
      alterId: 0,
      cipher: "auto",
    };
    const tls = parseTls(node.settings);
    if (tls) {
      proxy.tls = true;
      if (tls.servername) {
        proxy.servername = tls.servername;
      }
      if (tls.sni) {
        proxy.sni = tls.sni;
      }
      if (tls.alpn) {
        proxy.alpn = tls.alpn;
      }
      if (tls["skip-cert-verify"] !== undefined) {
        proxy["skip-cert-verify"] = tls["skip-cert-verify"];
      }
    }
    const transport = parseTransport(node.settings, tls !== null);
    if (transport === null) {
      return null;
    }
    Object.assign(proxy, transport);

    const smux = parseSmux(node.settings);
    if (smux) {
      proxy.smux = smux;
    }

    return proxy;
  },

  trojan(resolved, credentials) {
    const node = resolved.node;
    const proxy: Record<string, JsonValue> = {
      ...baseProxy(resolved),
      type: "trojan",
      password: credentials.password,
    };
    const tls = parseTls(node.settings);
    if (tls) {
      Object.assign(proxy, tls);
    }
    const transport = parseTransport(node.settings, tls !== null);
    if (transport?.network === "h2") {
      // Trojan over h2 is not portable in Clash Meta; skip this node.
      return null;
    }
    if (transport === null) {
      return null;
    }
    Object.assign(proxy, transport);

    const smux = parseSmux(node.settings);
    if (smux) {
      proxy.smux = smux;
    }

    return proxy;
  },

  shadowsocks(resolved, credentials) {
    const node = resolved.node;
    const method = node.settings.method;
    if (typeof method !== "string") {
      return null;
    }
    let password = passwordFor(node, credentials.password);
    if (method.startsWith("2022-")) {
      // SS2022 multi-user: the client authenticates with an identity header
      // encrypted by the server PSK, so its password is `serverPSK:userPSK`.
      // A bare user PSK fails server-side with "invalid request".
      const serverPassword = node.settings.password;
      if (typeof serverPassword !== "string" || serverPassword === "") {
        return null;
      }
      password = `${serverPassword}:${password}`;
    }

    const proxy: Record<string, JsonValue> = {
      ...baseProxy(resolved),
      type: "ss",
      cipher: method,
      password,
    };

    const smux = parseSmux(node.settings);
    if (smux) {
      proxy.smux = smux;
    }

    return proxy;
  },

  hysteria2(resolved, credentials) {
    const node = resolved.node;
    const proxy: Record<string, JsonValue> = {
      ...baseProxy(resolved),
      type: "hysteria2",
      password: credentials.password,
    };
    const tls = parseTls(node.settings);
    if (tls) {
      Object.assign(proxy, tls);
    }
    const obfs = node.settings.obfs;
    if (typeof obfs === "object" && obfs !== null && !Array.isArray(obfs)) {
      const obfsObj = obfs as Record<string, JsonValue>;
      if (typeof obfsObj.type === "string") {
        proxy.obfs = obfsObj.type;
      }
      if (typeof obfsObj.password === "string") {
        proxy["obfs-password"] = obfsObj.password;
      }
    }
    const upMbps = node.settings.up_mbps;
    const downMbps = node.settings.down_mbps;
    if (typeof upMbps === "number") {
      proxy.up = `${upMbps} Mbps`;
    }
    if (typeof downMbps === "number") {
      proxy.down = `${downMbps} Mbps`;
    }
    return proxy;
  },

  hysteria(resolved, credentials) {
    const node = resolved.node;
    const proxy: Record<string, JsonValue> = {
      ...baseProxy(resolved),
      type: "hysteria",
      "auth-str": credentials.password,
    };
    const tls = parseTls(node.settings);
    if (tls) {
      Object.assign(proxy, tls);
    }
    const upMbps = node.settings.up_mbps;
    const downMbps = node.settings.down_mbps;
    if (typeof upMbps === "number") {
      proxy.up = `${upMbps} Mbps`;
    }
    if (typeof downMbps === "number") {
      proxy.down = `${downMbps} Mbps`;
    }
    const obfs = node.settings.obfs;
    if (typeof obfs === "string") {
      proxy.obfs = obfs;
    }
    if (typeof node.settings.recv_window_conn === "number") {
      proxy["recv-window-conn"] = node.settings.recv_window_conn;
    }
    if (node.settings.disable_mtu_discovery === true) {
      proxy["disable-mtu-discovery"] = true;
    }
    return proxy;
  },

  tuic(resolved, credentials) {
    const node = resolved.node;
    const proxy: Record<string, JsonValue> = {
      ...baseProxy(resolved),
      type: "tuic",
      uuid: credentials.uuid,
      password: credentials.password,
      "udp-relay-mode": "native",
    };
    const tls = parseTls(node.settings);
    if (tls) {
      Object.assign(proxy, tls);
    }
    const congestion = node.settings.congestion_control;
    if (typeof congestion === "string") {
      proxy["congestion-controller"] = congestion;
    } else {
      proxy["congestion-controller"] = "cubic";
    }
    if (node.settings.zero_rtt_handshake === true) {
      proxy["reduce-rtt"] = true;
    }
    const heartbeatMs = parseDurationMs(node.settings.heartbeat);
    if (typeof heartbeatMs === "number") {
      proxy["heartbeat-interval"] = heartbeatMs;
    }
    return proxy;
  },

  anytls(resolved, credentials) {
    const node = resolved.node;
    const proxy: Record<string, JsonValue> = {
      ...baseProxy(resolved),
      type: "anytls",
      password: credentials.password,
      "client-fingerprint": "chrome",
    };
    const tls = parseTls(node.settings);
    if (tls) {
      Object.assign(proxy, tls);
    }
    return proxy;
  },
};

/**
 * Converts a resolved node and subscription credentials into a Clash Meta proxy
 * object. The resolved address (per-node override or server fallback) is used
 * for `server`; the protocol `settings` come from the node row. Returns null
 * when the protocol is unsupported or the node configuration is not expressible
 * in Clash Meta (e.g. Reality with an undecryptable private key).
 */
export function nodeToClashProxy(
  resolved: ResolvedNode,
  credentials: SubscriptionCredentials,
): Record<string, JsonValue> | null {
  const builder = BUILDERS[resolved.node.protocol];
  if (!builder) {
    return null;
  }
  let effective = resolved;
  const usesManagedCertificate = Boolean(
    resolved.node.certificateId &&
    protocolSupportsTls(resolved.node.protocol) &&
    isNodeTlsEnabled(resolved.node.settings) &&
    !isNodeRealityEnabled(resolved.node.settings),
  );
  if (usesManagedCertificate) {
    const previousTls =
      typeof resolved.node.settings.tls === "object" &&
      resolved.node.settings.tls !== null &&
      !Array.isArray(resolved.node.settings.tls)
        ? (resolved.node.settings.tls as Record<string, JsonValue>)
        : {};
    effective = {
      ...resolved,
      node: {
        ...resolved.node,
        settings: {
          ...resolved.node.settings,
          tls: {
            ...previousTls,
            ...(resolved.node.tlsServerName
              ? { server_name: resolved.node.tlsServerName }
              : {}),
          },
        },
      },
    };
  }
  const proxy = builder(effective, credentials);
  if (
    proxy &&
    usesManagedCertificate &&
    resolved.certificateKind === "self_signed"
  ) {
    proxy["skip-cert-verify"] = true;
  }
  return proxy;
}
