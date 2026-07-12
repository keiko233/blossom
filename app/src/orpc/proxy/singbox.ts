import { Configuration } from "@black-duty/sing-box-schema";

import type { Node } from "@/db/proxy-schema";

/**
 * Compiles a server's nodes into a single complete sing-box config. The agent
 * fetches this and applies it via process hot-reload, so the output is the
 * whole config, not a fragment. The result is validated against
 * `@black-duty/sing-box-schema`, so a malformed node surfaces here instead of
 * crashing the agent.
 *
 * `node.settings` is already a native sing-box inbound fragment (validated on
 * write); the compiler only injects the managed fields and wraps it. Two
 * forward-looking hooks:
 *  - `experimental.v2ray_api`: the stats/user API the agent uses to add users
 *    and report traffic.
 *  - `route`: an empty placeholder for the future rules module (server-side
 *    routing).
 */

export type SingboxConfig = Configuration;

export interface SingboxUser {
  /** Coded identifier for protocols keyed by `name`; absent for username-keyed. */
  name?: string;
  // Protocol-specific credential fields are merged in by the caller (password/uuid).
  [key: string]: unknown;
}

type Json = Record<string, unknown>;

const V2RAY_API_LISTEN = "127.0.0.1:8080";

/**
 * One node plus the entitlement-derived user entries to embed as the inbound's
 * `users` array. An entry whose `users` array is empty is dropped by the
 * compiler: a node with no currently-entitled subscriptions must not appear in
 * the running config at all, because sing-box treats an empty `users` array
 * differently across protocols — socks/http accept it (open proxy with no
 * authentication), while vless/naive/ss reject it or are unsafe with it. The
 * single rule "no users → no inbound" is the only safe behaviour, so callers
 * pass the pruned list and the compiler filters here.
 */
export interface NodeInbound {
  node: Node;
  users: SingboxUser[];
}

export interface CompileOptions {
  /** One entry per node to compile. The order is preserved in `inbounds`. */
  inbounds: NodeInbound[];
  /** Enable the v2ray stats/user API used for traffic reporting. Default on. */
  enableV2rayApi?: boolean;
}

/**
 * Compiles an entire server's compiled inbound set. Inbounds with zero users
 * are dropped before assembly (see `NodeInbound`): only a node with at least
 * one currently-entitled subscription is materialised into the running config.
 * When the resulting `inbounds` is empty (server disabled, or all nodes have no
 * entitled users) a valid config with an empty `inbounds` array is returned —
 * the agent applies it, tears down every previous listener, and keeps the
 * `v2ray_api` experimental hook so a later entitlement change can re-enable
 * listeners without re-architecting the agent.
 *
 * `stats.inbounds` collects every inbound tag, `stats.users` deduplicates
 * every inbound user's `name` across the multi-inbound config: each coded name
 * already encodes the producing node, so a subscription appearing on several
 * nodes still produces distinct, accurate counters. Username-keyed protocols
 * (naive/socks/http) have no `name` at all and are invisible to v2ray_api user
 * stats — their traffic is not reported per-user, a known limitation.
 */
export function compileServerConfig(options: CompileOptions): SingboxConfig {
  const { inbounds, enableV2rayApi = true } = options;

  const compiled = inbounds
    .filter(({ users }) => users.length > 0)
    .map(({ node, users }) => buildInbound(node, users));

  const draft: Json = {
    log: { level: "info", timestamp: true },
    dns: {
      servers: [{ tag: "google", type: "tls", server: "8.8.8.8" }],
    },
    inbounds: compiled,
    outbounds: [{ type: "direct", tag: "direct" }],
    // Placeholder for the future rules module: server-side routing gets injected here.
    route: { rules: [], rule_set: [], final: "direct" },
  };

  if (enableV2rayApi) {
    draft.experimental = buildV2rayApi(compiled);
  }

  // Validate the assembled config; throws on a malformed node.
  return Configuration.parse(draft);
}

function buildInbound(node: Node, users: SingboxUser[]): Json {
  // Managed fields override anything in the stored fragment.
  return {
    ...node.settings,
    type: node.protocol,
    tag: `node-${node.id}`,
    listen: "::",
    listen_port: node.listenPort,
    users,
  };
}

function buildV2rayApi(compiled: Json[]): Json {
  const tags = compiled.map((inbound) => inbound.tag as string);
  const userSet = new Set<string>();
  for (const inbound of compiled) {
    const users = inbound.users as SingboxUser[] | undefined;
    if (!Array.isArray(users)) {
      continue;
    }
    for (const user of users) {
      if (typeof user.name === "string") {
        userSet.add(user.name);
      }
    }
  }
  return {
    v2ray_api: {
      listen: V2RAY_API_LISTEN,
      stats: {
        enabled: true,
        inbounds: tags,
        // Username-keyed protocols (naive/socks/http) have no `name` field, so
        // v2ray_api never sees a per-user counter for them — their traffic is
        // not reported per user. Accepted limitation, carried over from the
        // single-inbound design.
        users: [...userSet],
      },
    },
  };
}
