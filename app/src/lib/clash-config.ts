import type { JsonValue } from "@/orpc/proxy/schema";
import type { ResolvedNode } from "@/query/subscription-access";

import {
  explainNodeSkip,
  type NodeSkipReason,
  nodeToClashProxy,
} from "./clash-proxies";
import type { SubscriptionOutputSettings } from "./settings";

interface SubscriptionCredentials {
  uuid: string;
  password: string;
}

interface BuildOptions {
  credentials: SubscriptionCredentials;
  /**
   * Per-node credential override (publish gate): while a credential rotation
   * is still unapplied on a node's server, that node's proxy must keep
   * emitting the previous credentials — the running agent config knows
   * nothing else. Nodes absent from the resolver use `credentials`.
   */
  resolveCredentials?: (node: ResolvedNode) => SubscriptionCredentials;
  /**
   * Compiled custom rules (`toClashRules`). They go ahead of the built-in
   * defaults so an admin rule can override the LAN/CN split; `MATCH` stays last.
   */
  rules?: readonly string[];
  /**
   * Admin-tunable parts of the output (ports, latency test, built-in rules).
   * Omitted fields keep the values the generator always used.
   */
  output?: Partial<ClashOutputOptions>;
}

export interface ClashOutputOptions {
  mixedPort: number;
  allowLan: boolean;
  urlTestUrl: string;
  urlTestIntervalSeconds: number;
  /** `GEOIP,LAN,DIRECT,no-resolve` */
  ruleLanDirect: boolean;
  /** `GEOIP,CN,DIRECT` */
  ruleCnDirect: boolean;
}

/** What the generator emitted before these became settings. */
export const DEFAULT_CLASH_OUTPUT: Readonly<ClashOutputOptions> = {
  mixedPort: 7890,
  allowLan: false,
  urlTestUrl: "https://www.gstatic.com/generate_204",
  urlTestIntervalSeconds: 300,
  ruleLanDirect: true,
  ruleCnDirect: true,
};

/** The generator's options from the stored subscription-output settings. */
export function toClashOutputOptions(
  settings: SubscriptionOutputSettings,
): ClashOutputOptions {
  return {
    mixedPort: settings.mixedPort,
    allowLan: settings.allowLan,
    urlTestUrl: settings.urlTestUrl,
    urlTestIntervalSeconds: settings.urlTestIntervalSeconds,
    ruleLanDirect: settings.ruleLanDirect,
    ruleCnDirect: settings.ruleCnDirect,
  };
}

/**
 * A node left out of the generated config. Carries ids and the node's own
 * name only — never credentials or settings — so it is safe for an admin
 * diagnostic view, but it is not meant for the subscription response body.
 */
export interface SkippedNode {
  nodeId: string;
  nodeName: string;
  protocol: string;
  reason: NodeSkipReason;
}

/**
 * Thrown when none of the nodes could be turned into a Clash proxy. Typed so
 * the endpoint can tell this expected condition from a genuine builder bug;
 * `skipped` is empty when there were no nodes at all.
 */
export class NoUsableProxiesError extends Error {
  readonly skipped: readonly SkippedNode[];

  constructor(skipped: readonly SkippedNode[]) {
    super("No usable proxies for this subscription");
    this.name = "NoUsableProxiesError";
    this.skipped = skipped;
  }
}

/** Makes proxy names unique by appending a counter when duplicated. */
function uniqueProxyNames(
  proxies: Record<string, JsonValue>[],
): Record<string, JsonValue>[] {
  const seen = new Map<string, number>();
  return proxies.map((proxy) => {
    const rawName = typeof proxy.name === "string" ? proxy.name : "Unnamed";
    const count = seen.get(rawName) ?? 0;
    seen.set(rawName, count + 1);
    const name = count === 0 ? rawName : `${rawName} ${count + 1}`;
    return { ...proxy, name };
  });
}

/**
 * Builds a complete Clash Meta configuration from accessible nodes and a
 * subscription's credentials. Nodes that cannot be expressed in Clash are
 * skipped and reported in `skipped` (partial success). Throws
 * `NoUsableProxiesError` when no proxy remains so the caller can answer with
 * an error rather than an invalid Clash config.
 */
export function buildClashConfig(
  nodes: ResolvedNode[],
  options: BuildOptions,
): { config: unknown; proxyNames: string[]; skipped: SkippedNode[] } {
  const { credentials, resolveCredentials, rules = [] } = options;
  const output = { ...DEFAULT_CLASH_OUTPUT, ...options.output };

  const converted: Record<string, JsonValue>[] = [];
  const skipped: SkippedNode[] = [];
  for (const resolved of nodes) {
    const proxy = nodeToClashProxy(
      resolved,
      resolveCredentials?.(resolved) ?? credentials,
    );
    if (proxy === null) {
      skipped.push({
        nodeId: resolved.node.id,
        nodeName: resolved.node.name,
        protocol: resolved.node.protocol,
        reason: explainNodeSkip(resolved),
      });
    } else {
      converted.push(proxy);
    }
  }
  const proxies = uniqueProxyNames(converted);

  if (proxies.length === 0) {
    throw new NoUsableProxiesError(skipped);
  }

  const proxyNames = proxies.map((proxy) => proxy.name as string);

  const config = {
    "mixed-port": output.mixedPort,
    "allow-lan": output.allowLan,
    mode: "rule",
    "log-level": "info",
    proxies,
    "proxy-groups": [
      {
        name: "PROXY",
        type: "select",
        proxies: ["Auto", ...proxyNames],
      },
      {
        name: "Auto",
        type: "url-test",
        url: output.urlTestUrl,
        interval: output.urlTestIntervalSeconds,
        proxies: proxyNames,
      },
    ],
    rules: [
      ...rules,
      ...(output.ruleLanDirect ? ["GEOIP,LAN,DIRECT,no-resolve"] : []),
      ...(output.ruleCnDirect ? ["GEOIP,CN,DIRECT"] : []),
      // The catch-all always closes the list; it is not a setting.
      "MATCH,PROXY",
    ],
  };

  return { config, proxyNames, skipped };
}
