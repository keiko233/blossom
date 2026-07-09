import { createFileRoute } from "@tanstack/react-router";
import { stringify } from "yaml";

import type { Subscription } from "@/db/plan-schema";
import { recordAccessLog } from "@/lib/access-log-record";
import { buildClashConfig } from "@/lib/clash-config";
import {
  findSubscriptionByToken,
  getSubscriptionAccessibleNodes,
} from "@/lib/subscription-access";
import { parseClientUserAgent } from "@/lib/user-agent";

const PROFILE_UPDATE_INTERVAL_HOURS = 24;

function getClientIp(request: Request): string | null {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) {
    return cf.trim();
  }
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || null;
  }
  return null;
}

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
        const { config } = buildClashConfig(nodes, {
          credentials: {
            uuid: subscription.credentialUuid,
            password: subscription.credentialPassword,
          },
        });

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
