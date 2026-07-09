import { Configuration } from "@black-duty/sing-box-schema";

import type { Node } from "@/db/proxy-schema";

/**
 * Compiles a node row into a complete sing-box config JSON. The agent fetches this
 * and applies it via process hot-reload, so the output is the whole config, not a
 * fragment. The result is validated against `@black-duty/sing-box-schema`, so a
 * malformed node surfaces here instead of crashing the agent.
 *
 * `node.settings` is already a native sing-box inbound fragment (validated on write);
 * the compiler only injects the managed fields and wraps it. Two forward-looking hooks:
 *  - `experimental.v2ray_api`: the stats/user API the agent uses to add users and report
 *    traffic. `users` starts empty until the subscribers module wires in.
 *  - `route`: an empty placeholder for the future rules module (server-side routing).
 */

export type SingboxConfig = Configuration;

export interface SingboxUser {
  /** Subscription id; absent for protocols keyed by `username` (naive/socks/http). */
  name?: string;
  // Protocol-specific credential fields are merged in by the caller (password/uuid).
  [key: string]: unknown;
}

type Json = Record<string, unknown>;

const V2RAY_API_LISTEN = "127.0.0.1:8080";

export interface CompileOptions {
  /** Subscribers to embed as inbound users. Empty until the users module wires in. */
  users?: SingboxUser[];
  /** Enable the v2ray stats/user API used for traffic reporting. Default on. */
  enableV2rayApi?: boolean;
}

export function nodeToSingboxConfig(
  node: Node,
  options: CompileOptions = {},
): SingboxConfig {
  const { users = [], enableV2rayApi = true } = options;

  // Managed fields override anything in the stored fragment.
  const inbound: Json = {
    ...node.settings,
    type: node.protocol,
    tag: `node-${node.id}`,
    listen: "::",
    listen_port: node.listenPort,
    users,
  };

  const draft: Json = {
    log: { level: "info", timestamp: true },
    dns: {
      servers: [{ tag: "google", type: "tls", server: "8.8.8.8" }],
    },
    inbounds: [inbound],
    outbounds: [{ type: "direct", tag: "direct" }],
    // Placeholder for the future rules module: server-side routing gets injected here.
    route: { rules: [], rule_set: [], final: "direct" },
  };

  if (enableV2rayApi) {
    draft.experimental = {
      v2ray_api: {
        listen: V2RAY_API_LISTEN,
        stats: {
          enabled: true,
          inbounds: [`node-${node.id}`],
          // username-keyed protocols (naive/socks/http) have no `name` and are
          // invisible to v2ray_api user stats — their traffic goes unreported.
          users: users.flatMap((u) =>
            typeof u.name === "string" ? u.name : [],
          ),
        },
      },
    };
  }

  // Validate the assembled config; throws on a malformed node.
  return Configuration.parse(draft);
}
