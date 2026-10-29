import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import type { Node } from "@/db/proxy-schema";
import type { ResolvedNode } from "@/query/subscription-access";

import {
  buildClashConfig,
  DEFAULT_CLASH_OUTPUT,
  toClashOutputOptions,
} from "./clash-config";
import { defaultSection, subscriptionOutputSettingsSchema } from "./settings";

const credentials = {
  uuid: "550e8400-e29b-41d4-a716-446655440000",
  password: "cXdlcnR5dWkvb3BhZnM=",
};

function makeNode(): ResolvedNode {
  const node = {
    id: "node-vless",
    name: "VLESS Node",
    remark: null,
    tags: [],
    enabled: true,
    serverId: "server-vless",
    address: null,
    listenPort: 443,
    protocol: "vless",
    settings: { tls: { enabled: true, server_name: "example.com" } },
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Node;
  return {
    node,
    server: { id: "server-vless", name: "S", address: "example.com" },
    address: "example.com",
    certificateKind: null,
  };
}

interface BuiltConfig {
  "mixed-port": number;
  "allow-lan": boolean;
  "proxy-groups": { name: string; url?: string; interval?: number }[];
  rules: string[];
}

function build(options: Parameters<typeof buildClashConfig>[1]): BuiltConfig {
  return buildClashConfig([makeNode()], options).config as BuiltConfig;
}

describe("buildClashConfig output options", () => {
  it("emits exactly the historical values when no options are given", () => {
    const config = build({ credentials });
    expect(config["mixed-port"]).toBe(7890);
    expect(config["allow-lan"]).toBe(false);
    const auto = config["proxy-groups"].find((g) => g.name === "Auto");
    expect(auto).toMatchObject({
      url: "https://www.gstatic.com/generate_204",
      interval: 300,
    });
    expect(config.rules).toEqual([
      "GEOIP,LAN,DIRECT,no-resolve",
      "GEOIP,CN,DIRECT",
      "MATCH,PROXY",
    ]);
  });

  it("is identical for no options, default constants and default settings", () => {
    const bare = build({ credentials });
    expect(build({ credentials, output: DEFAULT_CLASH_OUTPUT })).toEqual(bare);
    expect(
      build({
        credentials,
        output: toClashOutputOptions(defaultSection("subscription_output")),
      }),
    ).toEqual(bare);
  });

  it("serializes default settings to byte-identical YAML", () => {
    const bare = stringify(build({ credentials }), { indent: 2 });
    const withDefaults = stringify(
      build({
        credentials,
        output: toClashOutputOptions(defaultSection("subscription_output")),
      }),
      { indent: 2 },
    );
    expect(withDefaults).toBe(bare);
    expect(bare).toContain("mixed-port: 7890\nallow-lan: false\n");
    expect(bare).toContain("url: https://www.gstatic.com/generate_204\n");
  });

  it("applies the port, LAN and latency-test settings", () => {
    const config = build({
      credentials,
      output: {
        mixedPort: 7897,
        allowLan: true,
        urlTestUrl: "http://cp.cloudflare.com/generate_204",
        urlTestIntervalSeconds: 120,
      },
    });
    expect(config["mixed-port"]).toBe(7897);
    expect(config["allow-lan"]).toBe(true);
    expect(config["proxy-groups"].find((g) => g.name === "Auto")).toMatchObject(
      { url: "http://cp.cloudflare.com/generate_204", interval: 120 },
    );
  });

  it("drops each toggled-off default rule independently", () => {
    expect(
      build({ credentials, output: { ruleLanDirect: false } }).rules,
    ).toEqual(["GEOIP,CN,DIRECT", "MATCH,PROXY"]);
    expect(
      build({ credentials, output: { ruleCnDirect: false } }).rules,
    ).toEqual(["GEOIP,LAN,DIRECT,no-resolve", "MATCH,PROXY"]);
  });

  it("always ends with MATCH,PROXY, even with every default rule off", () => {
    const rules = build({
      credentials,
      rules: ["DOMAIN,example.org,PROXY"],
      output: { ruleLanDirect: false, ruleCnDirect: false },
    }).rules;
    expect(rules).toEqual(["DOMAIN,example.org,PROXY", "MATCH,PROXY"]);
  });

  it("keeps custom rules ahead of the remaining defaults", () => {
    const rules = build({
      credentials,
      rules: ["DOMAIN,example.org,PROXY"],
      output: { ruleCnDirect: false },
    }).rules;
    expect(rules).toEqual([
      "DOMAIN,example.org,PROXY",
      "GEOIP,LAN,DIRECT,no-resolve",
      "MATCH,PROXY",
    ]);
  });
});

describe("toClashOutputOptions", () => {
  it("maps stored settings one to one", () => {
    const settings = subscriptionOutputSettingsSchema.parse({
      mixedPort: 1080,
      allowLan: true,
      urlTestUrl: "https://example.com/204",
      urlTestIntervalSeconds: 60,
      ruleLanDirect: false,
      ruleCnDirect: false,
    });
    expect(toClashOutputOptions(settings)).toEqual({
      mixedPort: 1080,
      allowLan: true,
      urlTestUrl: "https://example.com/204",
      urlTestIntervalSeconds: 60,
      ruleLanDirect: false,
      ruleCnDirect: false,
    });
  });

  it("does not carry endpoint-only fields into the config", () => {
    expect(
      Object.keys(
        toClashOutputOptions(defaultSection("subscription_output")),
      ).sort(),
    ).toEqual(Object.keys(DEFAULT_CLASH_OUTPUT).sort());
  });
});
