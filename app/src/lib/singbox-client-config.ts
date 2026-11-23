import { createPrivateKey, createPublicKey } from "node:crypto";

import type { JsonValue } from "@/orpc/proxy/schema";
import {
  isNodeRealityEnabled,
  isNodeTlsEnabled,
  protocolSupportsTls,
} from "@/orpc/proxy/sing-box-registry";
import { passwordFor } from "@/orpc/proxy/singbox-users";
import { encodeTrafficUser } from "@/orpc/proxy/traffic-user-codec";
import type { ResolvedNode } from "@/query/subscription-access";

import { NoUsableProxiesError, type SkippedNode } from "./clash-config";
import type { NodeSkipReason } from "./clash-proxies";
import type { SubscriptionOutputSettings } from "./settings";

export { NoUsableProxiesError, type SkippedNode };
export type { NodeSkipReason };

export interface SubscriptionCredentials {
  uuid: string;
  password: string;
  subscriptionId?: string;
  username?: string;
}

export interface SingboxOutputOptions {
  urlTestUrl: string;
  urlTestIntervalSeconds: number;
}

export const DEFAULT_SINGBOX_OUTPUT: Readonly<SingboxOutputOptions> = {
  urlTestUrl: "https://www.gstatic.com/generate_204",
  urlTestIntervalSeconds: 300,
};

export function toSingboxOutputOptions(
  settings: SubscriptionOutputSettings,
): SingboxOutputOptions {
  return {
    urlTestUrl: settings.urlTestUrl,
    urlTestIntervalSeconds: settings.urlTestIntervalSeconds,
  };
}

export interface BuildSingboxOptions {
  credentials: SubscriptionCredentials;
  /**
   * Per-node credential override (publish gate): while a credential rotation
   * is still unapplied on a node's server, that node's outbound must keep
   * emitting the previous credentials.
   */
  resolveCredentials?: (node: ResolvedNode) => SubscriptionCredentials;
  output?: Partial<SingboxOutputOptions>;
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
): { publicKey: string; shortId: string } | null {
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
    publicKey,
    shortId,
  };
}

function parseTls(
  resolved: ResolvedNode,
  settings: Record<string, JsonValue>,
): Record<string, JsonValue> | null {
  const tls = settings.tls;
  if (typeof tls !== "object" || tls === null || Array.isArray(tls)) {
    return null;
  }
  const tlsObj = tls as Record<string, JsonValue>;
  if (tlsObj.enabled !== true) {
    return null;
  }

  const result: Record<string, JsonValue> = {
    enabled: true,
  };

  const sni =
    resolved.node.tlsServerName ??
    (typeof tlsObj.server_name === "string" ? tlsObj.server_name : undefined);
  if (sni !== undefined) {
    result.server_name = sni;
  }
  if (Array.isArray(tlsObj.alpn)) {
    const alpn = tlsObj.alpn.filter((v): v is string => typeof v === "string");
    if (alpn.length > 0) {
      result.alpn = alpn;
    }
  }
  if (resolved.certificateKind === "self_signed") {
    result.insecure = true;
  }

  return result;
}

function parseTransport(
  settings: Record<string, JsonValue>,
): Record<string, JsonValue> | null {
  const transport = settings.transport;
  if (
    typeof transport !== "object" ||
    transport === null ||
    Array.isArray(transport)
  ) {
    return null;
  }
  const t = transport as Record<string, JsonValue>;
  const type = typeof t.type === "string" ? t.type : "tcp";

  switch (type) {
    case "tcp":
    case "":
      return null;

    case "ws": {
      const wsOpts: Record<string, JsonValue> = {
        type: "ws",
        path: typeof t.path === "string" ? t.path : "/",
      };
      if (
        typeof t.headers === "object" &&
        t.headers !== null &&
        !Array.isArray(t.headers)
      ) {
        const headers = t.headers as Record<string, JsonValue>;
        if (typeof headers.Host === "string") {
          wsOpts.headers = { Host: headers.Host };
        }
      }
      if (typeof t.max_early_data === "number") {
        wsOpts.max_early_data = t.max_early_data;
      }
      if (typeof t.early_data_header_name === "string") {
        wsOpts.early_data_header_name = t.early_data_header_name;
      }
      return wsOpts;
    }

    case "grpc": {
      const serviceName =
        typeof t.service_name === "string" ? t.service_name : "";
      return {
        type: "grpc",
        service_name: serviceName,
      };
    }

    case "httpupgrade": {
      const opts: Record<string, JsonValue> = {
        type: "httpupgrade",
        path: typeof t.path === "string" ? t.path : "/",
      };
      if (typeof t.host === "string") {
        opts.host = t.host;
      }
      if (
        typeof t.headers === "object" &&
        t.headers !== null &&
        !Array.isArray(t.headers)
      ) {
        opts.headers = t.headers;
      }
      return opts;
    }

    case "http": {
      let hostList: string[] = [];
      if (typeof t.host === "string") {
        hostList = t.host ? [t.host] : [];
      } else if (Array.isArray(t.host)) {
        hostList = t.host.filter((v): v is string => typeof v === "string");
      }
      const opts: Record<string, JsonValue> = {
        type: "http",
        path: typeof t.path === "string" ? t.path : "/",
      };
      if (hostList.length > 0) {
        opts.host = hostList;
      }
      if (typeof t.method === "string") {
        opts.method = t.method;
      }
      return opts;
    }

    case "quic":
      return { type: "quic" };

    default:
      return null;
  }
}

function parseMultiplex(
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

  const result: Record<string, JsonValue> = {
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
      result.brutal = {
        enabled: true,
        up_mbps: b.up_mbps,
        down_mbps: b.down_mbps,
      };
    }
  }

  return result;
}

type OutboundBuilder = (
  resolved: ResolvedNode,
  credentials: SubscriptionCredentials,
) => Record<string, JsonValue> | null;

function baseOutbound(resolved: ResolvedNode): Record<string, JsonValue> {
  const outbound: Record<string, JsonValue> = {
    tag: resolved.node.name,
    server: resolved.address,
    server_port: resolved.node.listenPort,
  };
  if (resolved.node.settings.tcp_fast_open === true) {
    outbound.tcp_fast_open = true;
  }
  if (resolved.node.settings.tcp_multi_path === true) {
    outbound.tcp_multi_path = true;
  }
  return outbound;
}

const BUILDERS: Record<string, OutboundBuilder> = {
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
    const hasReality =
      tlsObj?.enabled === true &&
      typeof reality === "object" &&
      reality !== null &&
      !Array.isArray(reality) &&
      (reality as Record<string, JsonValue>).enabled === true;

    const outbound: Record<string, JsonValue> = {
      ...baseOutbound(resolved),
      type: "vless",
      uuid: credentials.uuid,
      packet_encoding: "xudp",
    };

    if (typeof node.settings.flow === "string") {
      outbound.flow = node.settings.flow;
    }

    if (hasReality && tlsObj) {
      const realityOpts = parseRealityOpts(tlsObj);
      if (realityOpts === null) return null;
      const sni =
        node.tlsServerName ??
        (typeof tlsObj.server_name === "string"
          ? tlsObj.server_name
          : undefined);
      const tls: Record<string, JsonValue> = {
        enabled: true,
        utls: {
          enabled: true,
          fingerprint: "chrome",
        },
        reality: {
          enabled: true,
          public_key: realityOpts.publicKey,
          short_id: realityOpts.shortId,
        },
      };
      if (sni !== undefined) {
        tls.server_name = sni;
      }
      if (Array.isArray(tlsObj.alpn)) {
        const alpn = tlsObj.alpn.filter(
          (v): v is string => typeof v === "string",
        );
        if (alpn.length > 0) {
          tls.alpn = alpn;
        }
      }
      outbound.tls = tls;
    } else {
      const tls = parseTls(resolved, node.settings);
      if (tls) {
        outbound.tls = tls;
      }
    }

    const transport = parseTransport(node.settings);
    if (transport) {
      outbound.transport = transport;
    }

    const multiplex = parseMultiplex(node.settings);
    if (multiplex) {
      outbound.multiplex = multiplex;
    }

    return outbound;
  },

  vmess(resolved, credentials) {
    const node = resolved.node;
    const outbound: Record<string, JsonValue> = {
      ...baseOutbound(resolved),
      type: "vmess",
      uuid: credentials.uuid,
      security: "auto",
      alter_id: 0,
      packet_encoding: "xudp",
    };
    const tls = parseTls(resolved, node.settings);
    if (tls) {
      outbound.tls = tls;
    }
    const transport = parseTransport(node.settings);
    if (transport) {
      outbound.transport = transport;
    }
    const multiplex = parseMultiplex(node.settings);
    if (multiplex) {
      outbound.multiplex = multiplex;
    }
    return outbound;
  },

  trojan(resolved, credentials) {
    const node = resolved.node;
    const outbound: Record<string, JsonValue> = {
      ...baseOutbound(resolved),
      type: "trojan",
      password: credentials.password,
    };
    const tls = parseTls(resolved, node.settings);
    if (tls) {
      outbound.tls = tls;
    }
    const transport = parseTransport(node.settings);
    if (transport) {
      outbound.transport = transport;
    }
    const multiplex = parseMultiplex(node.settings);
    if (multiplex) {
      outbound.multiplex = multiplex;
    }
    return outbound;
  },

  shadowsocks(resolved, credentials) {
    const node = resolved.node;
    const method = node.settings.method;
    if (typeof method !== "string") {
      return null;
    }
    let password = passwordFor(node, credentials.password);
    if (method.startsWith("2022-")) {
      const serverPassword = node.settings.password;
      if (typeof serverPassword !== "string" || serverPassword === "") {
        return null;
      }
      password = `${serverPassword}:${password}`;
    }

    const outbound: Record<string, JsonValue> = {
      ...baseOutbound(resolved),
      type: "shadowsocks",
      method,
      password,
    };

    const multiplex = parseMultiplex(node.settings);
    if (multiplex) {
      outbound.multiplex = multiplex;
    }

    return outbound;
  },

  hysteria2(resolved, credentials) {
    const node = resolved.node;
    const outbound: Record<string, JsonValue> = {
      ...baseOutbound(resolved),
      type: "hysteria2",
      password: credentials.password,
    };
    const tls = parseTls(resolved, node.settings);
    if (tls) {
      outbound.tls = tls;
    }
    const obfs = node.settings.obfs;
    if (typeof obfs === "object" && obfs !== null && !Array.isArray(obfs)) {
      const obfsObj = obfs as Record<string, JsonValue>;
      if (
        typeof obfsObj.type === "string" &&
        typeof obfsObj.password === "string"
      ) {
        outbound.obfs = {
          type: obfsObj.type,
          password: obfsObj.password,
        };
      }
    }
    if (typeof node.settings.up_mbps === "number") {
      outbound.up_mbps = node.settings.up_mbps;
    }
    if (typeof node.settings.down_mbps === "number") {
      outbound.down_mbps = node.settings.down_mbps;
    }
    return outbound;
  },

  hysteria(resolved, credentials) {
    const node = resolved.node;
    const outbound: Record<string, JsonValue> = {
      ...baseOutbound(resolved),
      type: "hysteria",
      auth_str: credentials.password,
    };
    const tls = parseTls(resolved, node.settings);
    if (tls) {
      outbound.tls = tls;
    }
    if (typeof node.settings.up_mbps === "number") {
      outbound.up_mbps = node.settings.up_mbps;
    }
    if (typeof node.settings.down_mbps === "number") {
      outbound.down_mbps = node.settings.down_mbps;
    }
    const obfs = node.settings.obfs;
    if (typeof obfs === "string") {
      outbound.obfs = obfs;
    }
    if (typeof node.settings.recv_window_conn === "number") {
      outbound.recv_window_conn = node.settings.recv_window_conn;
    }
    if (node.settings.disable_mtu_discovery === true) {
      outbound.disable_mtu_discovery = true;
    }
    return outbound;
  },

  tuic(resolved, credentials) {
    const node = resolved.node;
    const outbound: Record<string, JsonValue> = {
      ...baseOutbound(resolved),
      type: "tuic",
      uuid: credentials.uuid,
      password: credentials.password,
      udp_relay_mode:
        typeof node.settings.udp_relay_mode === "string"
          ? node.settings.udp_relay_mode
          : "native",
      congestion_control:
        typeof node.settings.congestion_control === "string"
          ? node.settings.congestion_control
          : "cubic",
    };
    const tls = parseTls(resolved, node.settings);
    if (tls) {
      outbound.tls = tls;
    }
    if (node.settings.zero_rtt_handshake === true) {
      outbound.zero_rtt_handshake = true;
    }
    if (typeof node.settings.heartbeat === "string") {
      outbound.heartbeat = node.settings.heartbeat;
    }
    return outbound;
  },

  anytls(resolved, credentials) {
    const node = resolved.node;
    const outbound: Record<string, JsonValue> = {
      ...baseOutbound(resolved),
      type: "anytls",
      password: credentials.password,
    };
    const tls = parseTls(resolved, node.settings);
    if (tls) {
      outbound.tls = {
        ...tls,
        utls: {
          enabled: true,
          fingerprint: "chrome",
        },
      };
    }
    return outbound;
  },

  socks(resolved, credentials) {
    const username = credentials.subscriptionId
      ? encodeTrafficUser(resolved.node.id, credentials.subscriptionId)
      : (credentials.username ?? credentials.uuid);
    const outbound: Record<string, JsonValue> = {
      ...baseOutbound(resolved),
      type: "socks",
      version: "5",
      username,
      password: credentials.password,
    };
    return outbound;
  },

  http(resolved, credentials) {
    const node = resolved.node;
    const username = credentials.subscriptionId
      ? encodeTrafficUser(resolved.node.id, credentials.subscriptionId)
      : (credentials.username ?? credentials.uuid);
    const outbound: Record<string, JsonValue> = {
      ...baseOutbound(resolved),
      type: "http",
      username,
      password: credentials.password,
    };
    const tls = parseTls(resolved, node.settings);
    if (tls) {
      outbound.tls = tls;
    }
    return outbound;
  },
};

export function explainSingboxNodeSkip(resolved: ResolvedNode): NodeSkipReason {
  return BUILDERS[resolved.node.protocol]
    ? "unsupported_configuration"
    : "unsupported_protocol";
}

export function nodeToSingboxOutbound(
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
  return builder(effective, credentials);
}

const RESERVED_TAGS = new Set(["select", "auto", "direct", "block"]);

function uniqueOutboundTags(
  outbounds: Record<string, JsonValue>[],
): Record<string, JsonValue>[] {
  const seen = new Map<string, number>();
  return outbounds.map((ob) => {
    const rawTag = typeof ob.tag === "string" ? ob.tag : "Unnamed";
    let count = seen.get(rawTag) ?? 0;
    let tag =
      count === 0 && !RESERVED_TAGS.has(rawTag)
        ? rawTag
        : `${rawTag} ${count + 1}`;
    while (RESERVED_TAGS.has(tag) || (seen.has(tag) && tag !== rawTag)) {
      count++;
      tag = `${rawTag} ${count + 1}`;
    }
    seen.set(rawTag, count + 1);
    seen.set(tag, 1);
    return { ...ob, tag };
  });
}

export function buildSingboxClientConfig(
  nodes: ResolvedNode[],
  options: BuildSingboxOptions,
): { config: unknown; outboundTags: string[]; skipped: SkippedNode[] } {
  const { credentials, resolveCredentials } = options;
  const output = { ...DEFAULT_SINGBOX_OUTPUT, ...options.output };

  const converted: Record<string, JsonValue>[] = [];
  const skipped: SkippedNode[] = [];
  for (const resolved of nodes) {
    const outbound = nodeToSingboxOutbound(
      resolved,
      resolveCredentials?.(resolved) ?? credentials,
    );
    if (outbound === null) {
      skipped.push({
        nodeId: resolved.node.id,
        nodeName: resolved.node.name,
        protocol: resolved.node.protocol,
        reason: explainSingboxNodeSkip(resolved),
      });
    } else {
      converted.push(outbound);
    }
  }
  const outbounds = uniqueOutboundTags(converted);

  if (outbounds.length === 0) {
    throw new NoUsableProxiesError(skipped);
  }

  const outboundTags = outbounds.map((ob) => ob.tag as string);

  const config = {
    outbounds: [
      {
        type: "selector",
        tag: "select",
        outbounds: ["auto", ...outboundTags],
        default: "auto",
      },
      {
        type: "urltest",
        tag: "auto",
        outbounds: outboundTags,
        url: output.urlTestUrl,
        interval: `${output.urlTestIntervalSeconds}s`,
      },
      ...outbounds,
      {
        type: "direct",
        tag: "direct",
      },
      {
        type: "block",
        tag: "block",
      },
    ],
  };

  return { config, outboundTags, skipped };
}
