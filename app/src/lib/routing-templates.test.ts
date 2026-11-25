import { describe, expect, it } from "vitest";

import {
  BUILTIN_DIRECT_OUTBOUND_TAG,
  buildRoutingTemplate,
  CN_DIRECT_RULE_SET_IDS,
  HIGH_IP_QUALITY_RULE_SET_IDS,
  SPEEDTEST_RULE_SET_ID,
  type RoutingTemplateBuildInput,
} from "./routing-templates";

const importedRuleSets = [
  SPEEDTEST_RULE_SET_ID,
  ...HIGH_IP_QUALITY_RULE_SET_IDS,
  ...CN_DIRECT_RULE_SET_IDS,
];

const inbounds = ["node-fast", "node-bulk"];
const availableInboundTags = inbounds;

describe("full_forward", () => {
  it("uses the exit as the final outbound when it carries UDP", () => {
    const result = buildRoutingTemplate({
      template: "full_forward",
      inboundTags: inbounds,
      availableInboundTags,
      availableOutboundTags: ["peer-out-exit"],
      availableRuleSetIds: importedRuleSets,
      exitOutboundTag: "peer-out-exit",
      supportsUdp: true,
    });

    expect(result.ok).toBe(true);
    expect(result.finalOutboundTag).toBe("peer-out-exit");
    expect(result.rules).toEqual([]);
    expect(result.missingOutboundTags).toEqual([]);
    expect(result.missingRuleSetIds).toEqual([]);
  });

  it("emits a catch-all route per inbound when the exit is TCP-only", () => {
    const result = buildRoutingTemplate({
      template: "full_forward",
      inboundTags: inbounds,
      availableInboundTags,
      availableOutboundTags: ["peer-out-exit"],
      exitOutboundTag: "peer-out-exit",
      supportsUdp: false,
    });

    expect(result.ok).toBe(true);
    expect(result.finalOutboundTag).toBe(BUILTIN_DIRECT_OUTBOUND_TAG);
    expect(result.rules).toHaveLength(2);
    expect(result.rules.map((rule) => rule.inboundTags)).toEqual([
      ["node-fast"],
      ["node-bulk"],
    ]);
    for (const rule of result.rules) {
      expect(rule).toMatchObject({
        action: "route",
        outboundTag: "peer-out-exit",
        network: null,
      });
      expect(rule.ruleSetTags).toEqual([]);
    }
  });

  it("reports a missing exit outbound instead of emitting an unusable final", () => {
    const result = buildRoutingTemplate({
      template: "full_forward",
      inboundTags: inbounds,
      availableOutboundTags: [],
      exitOutboundTag: "peer-out-missing",
      supportsUdp: true,
    });

    expect(result.ok).toBe(false);
    expect(result.missingOutboundTags).toEqual(["peer-out-missing"]);
    expect(result.issues).toContainEqual({
      code: "outbound_not_found",
      params: { tag: "peer-out-missing" },
    });
  });
});

describe("speedtest_and_quality_split", () => {
  const input: RoutingTemplateBuildInput = {
    template: "speedtest_and_quality_split",
    inboundTags: ["node-fast"],
    availableInboundTags: ["node-fast"],
    availableOutboundTags: [
      "peer-out-fast",
      "peer-out-quality",
      BUILTIN_DIRECT_OUTBOUND_TAG,
    ],
    availableRuleSetIds: importedRuleSets,
    fastOutboundTag: "peer-out-fast",
    qualityOutboundTag: "peer-out-quality",
    defaultOutboundTag: BUILTIN_DIRECT_OUTBOUND_TAG,
  };

  it("routes speedtest to the fast exit and high-quality sets to the quality exit", () => {
    const result = buildRoutingTemplate(input);

    expect(result.ok).toBe(true);
    expect(result.finalOutboundTag).toBe(BUILTIN_DIRECT_OUTBOUND_TAG);
    expect(result.rules).toHaveLength(2);
    expect(result.rules[0]).toMatchObject({
      inboundTags: ["node-fast"],
      sniff: true,
      outboundTag: "peer-out-fast",
      ruleSetTags: ["rule-set-geosite-category-speedtest"],
    });
    expect(result.rules[1]).toMatchObject({
      inboundTags: ["node-fast"],
      sniff: true,
      outboundTag: "peer-out-quality",
      ruleSetTags: [
        "rule-set-geosite-openai",
        "rule-set-geosite-anthropic",
        "rule-set-geosite-netflix",
        "rule-set-geosite-disney",
      ],
    });
  });

  it("reports catalog ids the server has not imported", () => {
    const result = buildRoutingTemplate({
      ...input,
      availableRuleSetIds: ["geosite-openai"],
    });

    expect(result.ok).toBe(false);
    expect(result.missingRuleSetIds).toEqual([
      "geosite-category-speedtest",
      "geosite-anthropic",
      "geosite-netflix",
      "geosite-disney",
    ]);
    expect(result.issues).toContainEqual({
      code: "rule_set_not_imported",
      params: { ruleSet: "geosite-category-speedtest" },
    });
  });

  it("distinguishes an unknown rule-set id from an unimported catalog entry", () => {
    const result = buildRoutingTemplate({
      ...input,
      availableRuleSetIds: [],
      qualityRuleSetIds: ["custom-set"],
    });

    expect(result.missingRuleSetIds).toEqual([
      "geosite-category-speedtest",
      "custom-set",
    ]);
    expect(result.issues).toContainEqual({
      code: "unknown_rule_set",
      params: { ruleSet: "custom-set" },
    });
  });

  it("reports missing outbound tags", () => {
    const result = buildRoutingTemplate({
      ...input,
      availableOutboundTags: [BUILTIN_DIRECT_OUTBOUND_TAG],
    });

    expect(result.ok).toBe(false);
    expect(result.missingOutboundTags).toEqual([
      "peer-out-fast",
      "peer-out-quality",
    ]);
  });
});

describe("cn_direct_intl_exit", () => {
  const input: RoutingTemplateBuildInput = {
    template: "cn_direct_intl_exit",
    inboundTags: inbounds,
    availableInboundTags,
    availableOutboundTags: ["peer-out-exit"],
    availableRuleSetIds: importedRuleSets,
    exitOutboundTag: "peer-out-exit",
  };

  it("keeps private and mainland traffic on direct and exits everything else", () => {
    const result = buildRoutingTemplate(input);

    expect(result.ok).toBe(true);
    expect(result.finalOutboundTag).toBe("peer-out-exit");
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]).toMatchObject({
      inboundTags: inbounds,
      sniff: true,
      resolveStrategy: "prefer_ipv4",
      outboundTag: BUILTIN_DIRECT_OUTBOUND_TAG,
      ruleSetTags: [
        "rule-set-geoip-private",
        "rule-set-geosite-private",
        "rule-set-geosite-cn",
        "rule-set-geoip-cn",
      ],
    });
  });

  it("scopes the exit catch-all when the exit cannot carry UDP", () => {
    const result = buildRoutingTemplate({
      ...input,
      supportsUdp: false,
    });

    expect(result.finalOutboundTag).toBe(BUILTIN_DIRECT_OUTBOUND_TAG);
    expect(result.rules).toHaveLength(2);
    expect(result.rules[1]).toMatchObject({
      inboundTags: inbounds,
      outboundTag: "peer-out-exit",
      action: "route",
    });
  });

  it("requires at least one subscriber inbound", () => {
    const result = buildRoutingTemplate({ ...input, inboundTags: [] });

    expect(result.ok).toBe(false);
    expect(result.rules).toEqual([]);
    expect(result.issues).toContainEqual({
      code: "inbound_tags_required",
      params: {},
    });
  });
});
