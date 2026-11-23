import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import type { Node } from "@/db/proxy-schema";
import type { ResolvedNode } from "@/query/subscription-access";

import { defaultSettings } from "./settings";

const mocks = vi.hoisted(() => ({
  findSubscriptionByToken: vi.fn(),
  getSubscriptionAccessibleNodes: vi.fn(),
  getGatedSubscriptionView: vi.fn(),
  listEnabledRules: vi.fn(),
  getSettings: vi.fn(),
  recordAccessLog: vi.fn(),
}));

vi.mock("@/query/subscription-access", () => ({
  findSubscriptionByToken: mocks.findSubscriptionByToken,
  getSubscriptionAccessibleNodes: mocks.getSubscriptionAccessibleNodes,
  getGatedSubscriptionView: mocks.getGatedSubscriptionView,
}));
vi.mock("@/query/rule-access", () => ({
  listEnabledRules: mocks.listEnabledRules,
}));
vi.mock("@/query/settings-store", () => ({
  getSettings: mocks.getSettings,
}));
vi.mock("@/query/access-log-record", () => ({
  recordAccessLog: mocks.recordAccessLog,
}));

import { Route } from "@/routes/api/sub/$token";

const CREDENTIAL_UUID = "550e8400-e29b-41d4-a716-446655440000";
const CREDENTIAL_PASSWORD = "fake-password-for-tests";

function subscriptionRow() {
  return {
    id: "sub-1",
    userId: "user-1",
    token: "fake-token",
    status: "active",
    expiresAt: new Date(Date.now() + 86_400_000),
    trafficQuotaBytes: 0,
    trafficUsedBytes: 0,
    credentialUuid: CREDENTIAL_UUID,
    credentialPassword: CREDENTIAL_PASSWORD,
  };
}

function makeNode(id: string, protocol: string): ResolvedNode {
  return {
    node: {
      id,
      name: `node ${id}`,
      enabled: true,
      serverId: "server-1",
      address: null,
      listenPort: 443,
      protocol,
      settings: {},
    } as unknown as Node,
    server: { id: "server-1", name: "server", address: "example.com" },
    address: "example.com",
    certificateKind: null,
  };
}

function gateOf(nodes: ResolvedNode[], eligible = true) {
  return { eligible, nodes, credentialsByNodeId: new Map() };
}

async function fetchSubscription(
  url = "https://example.test/api/sub/fake-token",
  headers: Record<string, string> = {},
): Promise<Response> {
  const handlers = (
    Route.options as unknown as {
      server: {
        handlers: {
          GET: (ctx: {
            params: { token: string };
            request: Request;
          }) => Promise<Response>;
        };
      };
    }
  ).server.handlers;
  return handlers.GET({
    params: { token: "fake-token" },
    request: new Request(url, { headers }),
  });
}

/** Wires one subscription whose accessible nodes and gate output are given. */
function arrange(accessible: ResolvedNode[], gated: ResolvedNode[]) {
  mocks.getSubscriptionAccessibleNodes.mockResolvedValue(accessible);
  mocks.getGatedSubscriptionView.mockResolvedValue(gateOf(gated));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.findSubscriptionByToken.mockResolvedValue({
    subscription: subscriptionRow(),
    user: { banned: false, banExpires: null },
  });
  mocks.listEnabledRules.mockResolvedValue([]);
  mocks.getSettings.mockResolvedValue(defaultSettings());
  mocks.recordAccessLog.mockResolvedValue(undefined);
});

describe("GET /api/sub/$token", () => {
  it("serves a Clash config for supported nodes", async () => {
    const nodes = [makeNode("a", "trojan")];
    arrange(nodes, nodes);
    const response = await fetchSubscription();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/yaml; charset=utf-8",
    );
    expect(response.headers.get("ETag")).toMatch(/^"[a-f0-9]{64}"$/);
    expect(response.headers.get("Content-Disposition")).toContain(
      "blossom.yaml",
    );
    const config = parseYaml(await response.text()) as {
      proxies: { type: string }[];
    };
    expect(config.proxies.map((proxy) => proxy.type)).toEqual(["trojan"]);
  });

  it("serves a native sing-box config when ?format=singbox is requested", async () => {
    const nodes = [makeNode("a", "trojan")];
    arrange(nodes, nodes);
    const response = await fetchSubscription(
      "https://example.test/api/sub/fake-token?format=singbox",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("ETag")).toMatch(/^"[a-f0-9]{64}"$/);
    expect(response.headers.get("Content-Disposition")).toContain(
      "blossom.json",
    );
    const config = JSON.parse(await response.text()) as {
      outbounds: { type: string; tag: string }[];
    };
    expect(config.outbounds).toBeDefined();
    const tags = config.outbounds.map((o) => o.tag);
    expect(tags).toContain("node a");
    expect(tags).toContain("select");
    expect(tags).toContain("auto");
  });

  it("serves a native sing-box config for sing-box User-Agent when ?format is omitted", async () => {
    const nodes = [makeNode("a", "trojan")];
    arrange(nodes, nodes);
    for (const ua of [
      "sing-box/1.9.0",
      "SFA/1.10.0 (Linux; Android 14)",
      "SFI/1.8.0",
      "SFM/1.8.0",
    ]) {
      const response = await fetchSubscription(
        "https://example.test/api/sub/fake-token",
        { "user-agent": ua },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(
        "application/json; charset=utf-8",
      );
      expect(response.headers.get("Content-Disposition")).toContain(
        "blossom.json",
      );
    }
  });

  it("keeps Clash Meta YAML when ?format=clash is specified even with sing-box UA", async () => {
    const nodes = [makeNode("a", "trojan")];
    arrange(nodes, nodes);
    const response = await fetchSubscription(
      "https://example.test/api/sub/fake-token?format=clash",
      { "user-agent": "sing-box/1.9.0" },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/yaml; charset=utf-8",
    );
    expect(response.headers.get("Content-Disposition")).toContain(
      "blossom.yaml",
    );
  });

  it("returns 304 Not Modified when If-None-Match matches ETag", async () => {
    const nodes = [makeNode("a", "trojan")];
    arrange(nodes, nodes);
    const initialResponse = await fetchSubscription();
    expect(initialResponse.status).toBe(200);
    const etag = initialResponse.headers.get("ETag")!;
    expect(etag).toBeDefined();

    // Matching strong ETag
    const cachedResponse = await fetchSubscription(
      "https://example.test/api/sub/fake-token",
      { "if-none-match": etag },
    );
    expect(cachedResponse.status).toBe(304);
    expect(cachedResponse.headers.get("ETag")).toBe(etag);
    expect(cachedResponse.headers.get("Subscription-Userinfo")).toBe(
      initialResponse.headers.get("Subscription-Userinfo"),
    );
    expect(cachedResponse.headers.get("Profile-Update-Interval")).toBe(
      initialResponse.headers.get("Profile-Update-Interval"),
    );
    expect(cachedResponse.headers.get("Content-Disposition")).toBe(
      initialResponse.headers.get("Content-Disposition"),
    );
    expect(await cachedResponse.text()).toBe("");
  });

  it("supports weak ETag in If-None-Match", async () => {
    const nodes = [makeNode("a", "trojan")];
    arrange(nodes, nodes);
    const initialResponse = await fetchSubscription();
    const etag = initialResponse.headers.get("ETag")!;

    const cachedResponse = await fetchSubscription(
      "https://example.test/api/sub/fake-token",
      { "if-none-match": `W/${etag}` },
    );
    expect(cachedResponse.status).toBe(304);
  });

  it("returns 200 when If-None-Match does not match", async () => {
    const nodes = [makeNode("a", "trojan")];
    arrange(nodes, nodes);
    const response = await fetchSubscription(
      "https://example.test/api/sub/fake-token",
      { "if-none-match": '"outdated-etag"' },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("proxies:");
  });

  it("still serves the convertible nodes when others are unsupported", async () => {
    const nodes = [makeNode("a", "wireguard"), makeNode("b", "trojan")];
    arrange(nodes, nodes);
    const response = await fetchSubscription();
    expect(response.status).toBe(200);
    const body = await response.text();
    const config = parseYaml(body) as { proxies: unknown[] };
    expect(config.proxies).toHaveLength(1);
    expect(body).not.toContain("wireguard");
  });

  it("answers 404 for an unknown token", async () => {
    mocks.findSubscriptionByToken.mockResolvedValue(null);
    const response = await fetchSubscription();
    expect(response.status).toBe(404);
  });

  it("keeps a plain 403 for an ineligible subscription", async () => {
    mocks.findSubscriptionByToken.mockResolvedValue({
      subscription: { ...subscriptionRow(), status: "cancelled" },
      user: { banned: false, banExpires: null },
    });
    const response = await fetchSubscription();
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
    expect(mocks.getSubscriptionAccessibleNodes).not.toHaveBeenCalled();
  });

  it("keeps a plain 403 when the publish gate marks it ineligible", async () => {
    const nodes = [makeNode("a", "trojan")];
    mocks.getSubscriptionAccessibleNodes.mockResolvedValue(nodes);
    mocks.getGatedSubscriptionView.mockResolvedValue(gateOf([], false));
    const response = await fetchSubscription();
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
  });

  it("reports no entitled nodes as 403 without Retry-After", async () => {
    arrange([], []);
    const response = await fetchSubscription();
    expect(response.status).toBe(403);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(await response.text()).toBe(
      "No nodes are available for this subscription",
    );
  });

  it("reports gate-withheld nodes as a retryable 503", async () => {
    arrange([makeNode("a", "trojan")], []);
    const response = await fetchSubscription();
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(await response.text()).toBe("Configuration is being deployed");
  });

  it("does not call permanently unsupported nodes a pending deployment", async () => {
    const nodes = [makeNode("a", "wireguard")];
    arrange(nodes, nodes);
    const response = await fetchSubscription();
    expect(response.status).toBe(422);
    expect(response.headers.get("Retry-After")).toBeNull();
    const body = await response.text();
    expect(body).not.toContain("wireguard");
    expect(body).not.toContain("deployed");
  });

  it("reports an unexpected builder failure as 500 and leaks nothing", async () => {
    const nodes = [makeNode("a", "trojan")];
    mocks.getSubscriptionAccessibleNodes.mockResolvedValue(nodes);
    mocks.getGatedSubscriptionView.mockResolvedValue({
      ...gateOf(nodes),
      credentialsByNodeId: {
        get: () => {
          throw new Error(`broken ${CREDENTIAL_PASSWORD}`);
        },
      },
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await fetchSubscription();
    expect(response.status).toBe(500);
    expect(response.headers.get("Retry-After")).toBeNull();
    const body = await response.text();
    expect(body).not.toContain(CREDENTIAL_PASSWORD);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
      CREDENTIAL_PASSWORD,
    );
    errorLog.mockRestore();
  });

  it("logs only a constant message, never the error's name or message", async () => {
    const nodes = [makeNode("a", "trojan")];
    mocks.getSubscriptionAccessibleNodes.mockResolvedValue(nodes);
    mocks.getGatedSubscriptionView.mockResolvedValue({
      ...gateOf(nodes),
      credentialsByNodeId: {
        get: () => {
          const error = new Error(`message ${CREDENTIAL_PASSWORD}`);
          error.name = `Name-${CREDENTIAL_PASSWORD}`;
          throw error;
        },
      },
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await fetchSubscription();
    expect(response.status).toBe(500);
    expect(errorLog.mock.calls).toEqual([
      ["[subscription] config generation failed"],
    ]);
    errorLog.mockRestore();
  });
});
