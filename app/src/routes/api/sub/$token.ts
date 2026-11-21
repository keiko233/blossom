import { createFileRoute } from "@tanstack/react-router";
import { stringify } from "yaml";

import { dbCached } from "@/db";
import type { Subscription } from "@/db/plan-schema";
import { buildClashConfig, toClashOutputOptions } from "@/lib/clash-config";
import { getClientIp } from "@/lib/client-ip";
import { toClashRules } from "@/lib/routing-rules";
import {
  classifyDeliveryFailure,
  deliveryFailureResponse,
} from "@/lib/subscription-delivery";
import {
  buildContentDisposition,
  buildProfileUpdateInterval,
} from "@/lib/subscription-headers";
import { parseClientUserAgent } from "@/lib/user-agent";
import { recordAccessLog } from "@/query/access-log-record";
import { listEnabledRules } from "@/query/rule-access";
import { getSettings } from "@/query/settings-store";
import {
  findSubscriptionByToken,
  getGatedSubscriptionView,
  getSubscriptionAccessibleNodes,
} from "@/query/subscription-access";

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

        const [enabledRules, { subscription_output: output }] =
          await Promise.all([listEnabledRules(dbCached), getSettings()]);
        const rules = toClashRules(enabledRules);

        let config: unknown;
        try {
          config = buildClashConfig(gate.nodes, {
            rules,
            output: toClashOutputOptions(output),
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
        } catch (error) {
          // Say why there is nothing to serve: only a publish-gate wait is
          // worth a retry. The body stays generic; details (node names,
          // protocols) belong to an authenticated admin view, not to whoever
          // holds the link.
          const failure = classifyDeliveryFailure({
            accessibleCount: nodes.length,
            gatedCount: gate.nodes.length,
            error,
          });
          if (failure.reason === "generation_failed") {
            // Constant message: error names and messages can carry node
            // settings or credentials.
            console.error("[subscription] config generation failed");
          }
          return deliveryFailureResponse(failure);
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
            "Content-Disposition": buildContentDisposition(output.profileTitle),
            "Profile-Update-Interval": buildProfileUpdateInterval(
              output.profileUpdateIntervalHours,
            ),
            "Subscription-Userinfo":
              buildSubscriptionUserinfoHeader(subscription),
          },
        });
      },
    },
  },
});
