import type { JsonValue } from "@/orpc/proxy/schema";
import type { ResolvedNode } from "@/query/subscription-access";

import { nodeToClashProxy } from "./clash-proxies";

interface SubscriptionCredentials {
  uuid: string;
  password: string;
}

interface BuildOptions {
  credentials: SubscriptionCredentials;
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
 * subscription's credentials. Throws when there are no usable proxies so the
 * caller can return a 403 rather than an invalid Clash config.
 */
export function buildClashConfig(
  nodes: ResolvedNode[],
  options: BuildOptions,
): { config: unknown; proxyNames: string[] } {
  const { credentials } = options;

  const proxies = uniqueProxyNames(
    nodes
      .map((resolved) => nodeToClashProxy(resolved, credentials))
      .filter((proxy): proxy is Record<string, JsonValue> => proxy !== null),
  );

  if (proxies.length === 0) {
    throw new Error("No usable proxies for this subscription");
  }

  const proxyNames = proxies.map((proxy) => proxy.name as string);

  const config = {
    "mixed-port": 7890,
    "allow-lan": false,
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
        url: "https://www.gstatic.com/generate_204",
        interval: 300,
        proxies: proxyNames,
      },
    ],
    rules: ["GEOIP,LAN,DIRECT,no-resolve", "GEOIP,CN,DIRECT", "MATCH,PROXY"],
  };

  return { config, proxyNames };
}
