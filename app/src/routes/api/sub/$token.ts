import { createFileRoute } from "@tanstack/react-router";
import { createHash } from "node:crypto";
import { stringify } from "yaml";

import { dbCached } from "@/db";
import type { Subscription } from "@/db/plan-schema";
import { buildClashConfig, toClashOutputOptions } from "@/lib/clash-config";
import { getClientIp } from "@/lib/client-ip";
import { toClashRules } from "@/lib/routing-rules";
import {
  buildSingboxClientConfig,
  toSingboxOutputOptions,
} from "@/lib/singbox-client-config";
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

function determineFormat(request: Request): "clash" | "singbox" {
  const url = new URL(request.url);
  const param = url.searchParams.get("format")?.toLowerCase();
  if (param === "singbox") {
    return "singbox";
  }
  if (param === "clash") {
    return "clash";
  }
  const userAgent = request.headers.get("user-agent") ?? "";
  if (
    /(?:^|[^a-zA-Z0-9])(?:sing-box|sfa|sfi|sfm)(?:[^a-zA-Z0-9]|$)/i.test(
      userAgent,
    )
  ) {
    return "singbox";
  }
  return "clash";
}

function buildSubContentDisposition(
  title: string,
  format: "clash" | "singbox",
): string {
  const base = buildContentDisposition(title);
  if (format === "singbox") {
    return base.replaceAll(".yaml", ".json");
  }
  return base;
}

function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (!header) {
    return false;
  }
  const rawTarget = etag.replace(/^W\//, "").replace(/^"|"$/g, "");
  for (const part of header.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "*") {
      return true;
    }
    const clean = trimmed.replace(/^W\//, "").replace(/^"|"$/g, "");
    if (clean === rawTarget) {
      return true;
    }
  }
  return false;
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
        const format = determineFormat(request);

        let body: string;
        let contentType: string;
        try {
          if (format === "singbox") {
            const result = buildSingboxClientConfig(gate.nodes, {
              output: toSingboxOutputOptions(output),
              credentials: {
                uuid: subscription.credentialUuid,
                password: subscription.credentialPassword,
                subscriptionId: subscription.id,
              },
              resolveCredentials: (resolved) => {
                const creds = gate.credentialsByNodeId.get(
                  resolved.node.id,
                ) ?? {
                  uuid: subscription.credentialUuid,
                  password: subscription.credentialPassword,
                };
                return {
                  ...creds,
                  subscriptionId: subscription.id,
                };
              },
            });
            body = JSON.stringify(result.config, null, 2);
            contentType = "application/json; charset=utf-8";
          } else {
            const result = buildClashConfig(gate.nodes, {
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
            });
            body = stringify(result.config, { indent: 2 });
            contentType = "text/yaml; charset=utf-8";
          }
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

        const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
        const contentDisposition = buildSubContentDisposition(
          output.profileTitle,
          format,
        );
        const ifNoneMatch = request.headers.get("if-none-match");

        if (matchesIfNoneMatch(ifNoneMatch, etag)) {
          return new Response(null, {
            status: 304,
            headers: {
              ETag: etag,
              "Content-Disposition": contentDisposition,
              "Profile-Update-Interval": buildProfileUpdateInterval(
                output.profileUpdateIntervalHours,
              ),
              "Subscription-Userinfo":
                buildSubscriptionUserinfoHeader(subscription),
            },
          });
        }

        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": contentType,
            ETag: etag,
            "Content-Disposition": contentDisposition,
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
