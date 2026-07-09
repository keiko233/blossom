import type { Node } from "@/db/proxy-schema";
import type { JsonValue } from "@/orpc/proxy/schema";
import { passwordFor } from "@/orpc/proxy/singbox-users";

interface SubscriptionCredentials {
  uuid: string;
  password: string;
}

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

interface TransportResult {
  network?: string;
  "ws-opts"?: Record<string, JsonValue>;
  "grpc-opts"?: Record<string, JsonValue>;
  "h2-opts"?: Record<string, JsonValue>;
}

function parseTransport(
  settings: Record<string, JsonValue>,
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
      const host = typeof t.host === "string" ? t.host : "";
      const path = typeof t.path === "string" ? t.path : "/";
      return {
        network: "h2",
        "h2-opts": { host: host ? [host] : [], path },
      };
    }

    case "quic":
      // Clash Meta does not support vmess-quic.
      return null;

    default:
      return null;
  }
}

type ProxyBuilder = (
  node: Node,
  credentials: SubscriptionCredentials,
) => Record<string, JsonValue> | null;

function baseProxy(node: Node): Record<string, JsonValue> {
  return {
    name: node.name,
    server: node.address,
    port: node.listenPort,
    udp: true,
  };
}

const BUILDERS: Record<string, ProxyBuilder> = {
  vless(node, credentials) {
    const tlsSettings = node.settings.tls;
    if (
      typeof tlsSettings === "object" &&
      tlsSettings !== null &&
      !Array.isArray(tlsSettings) &&
      (tlsSettings as Record<string, JsonValue>).reality
    ) {
      // Reality public-key derivation is not implemented yet.
      return null;
    }

    const proxy: Record<string, JsonValue> = {
      ...baseProxy(node),
      type: "vless",
      uuid: credentials.uuid,
    };
    const tls = parseTls(node.settings);
    if (tls) {
      Object.assign(proxy, tls);
    }
    const transport = parseTransport(node.settings);
    if (transport === null) {
      return null;
    }
    Object.assign(proxy, transport);
    return proxy;
  },

  vmess(node, credentials) {
    const proxy: Record<string, JsonValue> = {
      ...baseProxy(node),
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
    const transport = parseTransport(node.settings);
    if (transport === null) {
      return null;
    }
    Object.assign(proxy, transport);
    return proxy;
  },

  trojan(node, credentials) {
    const proxy: Record<string, JsonValue> = {
      ...baseProxy(node),
      type: "trojan",
      password: credentials.password,
    };
    const tls = parseTls(node.settings);
    if (tls) {
      Object.assign(proxy, tls);
    }
    const transport = parseTransport(node.settings);
    if (transport?.network === "h2") {
      // Trojan over h2 is not portable in Clash Meta; skip this node.
      return null;
    }
    if (transport === null) {
      return null;
    }
    Object.assign(proxy, transport);
    return proxy;
  },

  shadowsocks(node, credentials) {
    const method = node.settings.method;
    if (typeof method !== "string") {
      return null;
    }
    return {
      ...baseProxy(node),
      type: "ss",
      cipher: method,
      password: passwordFor(node, credentials.password),
    };
  },

  hysteria2(node, credentials) {
    const proxy: Record<string, JsonValue> = {
      ...baseProxy(node),
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

  hysteria(node, credentials) {
    const proxy: Record<string, JsonValue> = {
      ...baseProxy(node),
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
    return proxy;
  },

  tuic(node, credentials) {
    const proxy: Record<string, JsonValue> = {
      ...baseProxy(node),
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
    return proxy;
  },

  anytls(node, credentials) {
    const proxy: Record<string, JsonValue> = {
      ...baseProxy(node),
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
 * Converts a Node and subscription credentials into a Clash Meta proxy object.
 * Returns null when the protocol is unsupported or the node configuration is not
 * expressible in Clash Meta (e.g. Reality with an undecryptable private key).
 */
export function nodeToClashProxy(
  node: Node,
  credentials: SubscriptionCredentials,
): Record<string, JsonValue> | null {
  const builder = BUILDERS[node.protocol];
  if (!builder) {
    return null;
  }
  return builder(node, credentials);
}
