import { createFileRoute } from "@tanstack/react-router";
import { stringify } from "yaml";

import type { Subscription } from "@/db/plan-schema";
import { buildClashConfig } from "@/lib/clash-config";
import { getClientIp } from "@/lib/client-ip";
import { parseClientUserAgent } from "@/lib/user-agent";
import { recordAccessLog } from "@/query/access-log-record";
import {
  findSubscriptionByToken,
  getGatedSubscriptionView,
  getSubscriptionAccessibleNodes,
} from "@/query/subscription-access";

const PROFILE_UPDATE_INTERVAL_HOURS = 24;

function isSubscriptionEligible(
  subscription: Subscription,
  user: { banned: boolean | null; banExpires: Date | null },
): boolean {
  if (subscription.status !== "active") {
    return false;
  }
  const now = new Date();
  if (subscription.expiresAt <= now) {
    return false;
  }
  if (user.banned && !(user.banExpires && new Date(user.banExpires) < now)) {
    return false;
  }
  if (
    subscription.trafficQuotaBytes !== 0 &&
    subscription.trafficUsedBytes >= subscription.trafficQuotaBytes
  ) {
    return false;
  }
  return true;
}

function buildSubscriptionUserinfoHeader(subscription: Subscription): string {
  const parts = [`upload=0`, `download=${subscription.trafficUsedBytes}`];
  if (subscription.trafficQuotaBytes !== 0) {
    parts.push(`total=${subscription.trafficQuotaBytes}`);
  }
  parts.push(`expire=${Math.floor(subscription.expiresAt.getTime() / 1000)}`);
  return parts.join("; ");
}

export const Route = createFileRoute("/api/sub/$token")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const found = await findSubscriptionByToken(params.token);
        if (!found) {
          return new Response("Not Found", { status: 404 });
        }

        const { subscription, user } = found;
        if (!isSubscriptionEligible(subscription, user)) {
          return new Response("Forbidden", { status: 403 });
        }

        const nodes = await getSubscriptionAccessibleNodes(subscription.id);
        // Publish gate: emit, per node, only the state the node's server has
        // confirmed applied — a freshly changed node/credential/authorization
        // replays its previous state (or is withheld) until the agent catches
        // up, so a fetched subscription can never describe config no agent is
        // serving. See docs/config-versioning.md.
        const gate = await getGatedSubscriptionView({
          subscription,
          user,
          nodes,
        });
        if (!gate.eligible) {
          return new Response("Forbidden", { status: 403 });
        }

        let config: unknown;
        try {
          config = buildClashConfig(gate.nodes, {
            credentials: {
              uuid: subscription.credentialUuid,
              password: subscription.credentialPassword,
            },
            resolveCredentials: (resolved) =>
              gate.credentialsByNodeId.get(resolved.node.id) ?? {
                uuid: subscription.credentialUuid,
                password: subscription.credentialPassword,
              },
          }).config;
        } catch {
          // Every visible node is still waiting on an agent apply (e.g. a
          // just-created subscription or node). Nothing servable yet — tell
          // the client to retry rather than handing it a config that cannot
          // connect.
          return new Response("Configuration is being deployed", {
            status: 503,
            headers: { "Retry-After": "30" },
          });
        }

        const userAgent = request.headers.get("user-agent");
        const { clientName, clientVersion } = parseClientUserAgent(userAgent);
        await recordAccessLog({
          subjectType: "subscription",
          subjectId: subscription.id,
          userId: subscription.userId,
          ip: getClientIp(request),
          userAgent,
          clientName,
          clientVersion,
        }).catch(() => {
          // Logging failures must not break subscription delivery.
        });

        const yaml = stringify(config, { indent: 2 });
        return new Response(yaml, {
          status: 200,
          headers: {
            "Content-Type": "text/yaml; charset=utf-8",
            "Content-Disposition": 'attachment; filename="blossom.yaml"',
            "Profile-Update-Interval": String(PROFILE_UPDATE_INTERVAL_HOURS),
            "Subscription-Userinfo":
              buildSubscriptionUserinfoHeader(subscription),
          },
        });
      },
    },
  },
});
