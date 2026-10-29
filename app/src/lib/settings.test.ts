import { describe, expect, it } from "vitest";

import {
  defaultSection,
  defaultSettings,
  issuesByField,
  mergeSettings,
  SETTING_SCHEMAS,
  SETTING_SECTIONS,
  siteSettingsSchema,
  subscriptionOutputSettingsSchema,
  toPublicSettings,
  trialSettingsSchema,
  registrationSettingsSchema,
  updateSettingsSectionSchema,
} from "./settings";

describe("defaults reproduce the behaviour before settings existed", () => {
  it("registration: open, any domain, no extra verification", () => {
    expect(defaultSection("registration")).toEqual({
      mode: "open",
      allowedEmailDomains: [],
      requireEmailVerification: false,
    });
  });

  it("trial: off", () => {
    expect(defaultSection("trial")).toEqual({
      enabled: false,
      planId: null,
      durationDays: null,
    });
  });

  it("subscription output: the values buildClashConfig and the endpoint hard-coded", () => {
    expect(defaultSection("subscription_output")).toEqual({
      profileUpdateIntervalHours: 24,
      profileTitle: "blossom",
      urlTestUrl: "https://www.gstatic.com/generate_204",
      urlTestIntervalSeconds: 300,
      mixedPort: 7890,
      allowLan: false,
      ruleLanDirect: true,
      ruleCnDirect: true,
    });
  });

  it("site: nothing shown", () => {
    expect(defaultSection("site")).toEqual({
      supportUrl: null,
      supportEmail: null,
      userNotice: "",
      userNoticeLevel: "info",
      maintenanceMode: false,
    });
  });

  it("returns independent copies", () => {
    const a = defaultSettings();
    a.registration.allowedEmailDomains.push("x.com");
    expect(defaultSettings().registration.allowedEmailDomains).toEqual([]);
  });

  it("has a schema for every section", () => {
    expect(Object.keys(SETTING_SCHEMAS).sort()).toEqual(
      [...SETTING_SECTIONS].sort(),
    );
  });
});

describe("mergeSettings", () => {
  it("is all defaults for no rows", () => {
    expect(mergeSettings([])).toEqual(defaultSettings());
  });

  it("applies valid rows and fills missing fields with their defaults", () => {
    const merged = mergeSettings([
      { key: "registration", value: { mode: "closed" } },
      { key: "subscription_output", value: { mixedPort: 7897 } },
    ]);
    expect(merged.registration).toEqual({
      mode: "closed",
      allowedEmailDomains: [],
      requireEmailVerification: false,
    });
    expect(merged.subscription_output.mixedPort).toBe(7897);
    expect(merged.subscription_output.urlTestIntervalSeconds).toBe(300);
    expect(merged.site).toEqual(defaultSettings().site);
  });

  it("falls back to the section defaults for an invalid row and reports it", () => {
    const invalid: string[] = [];
    const merged = mergeSettings(
      [
        { key: "registration", value: { mode: "banana" } },
        { key: "site", value: "not an object" },
        { key: "trial", value: { enabled: true, planId: null } },
        { key: "subscription_output", value: { mixedPort: 70000 } },
      ],
      (section) => invalid.push(section),
    );
    expect(merged).toEqual(defaultSettings());
    expect(invalid.sort()).toEqual([
      "registration",
      "site",
      "subscription_output",
      "trial",
    ]);
  });

  it("ignores unknown keys and unknown fields", () => {
    const merged = mergeSettings([
      { key: "something_else", value: { a: 1 } },
      { key: "site", value: { maintenanceMode: true, legacy: "x" } },
    ]);
    expect(merged.site.maintenanceMode).toBe(true);
    expect(merged.site).not.toHaveProperty("legacy");
  });

  it("keeps good sections when another is bad", () => {
    const merged = mergeSettings([
      { key: "registration", value: { mode: "closed" } },
      { key: "site", value: 42 },
    ]);
    expect(merged.registration.mode).toBe("closed");
    expect(merged.site).toEqual(defaultSettings().site);
  });
});

describe("registration schema", () => {
  it("normalizes and de-duplicates domain patterns", () => {
    const parsed = registrationSettingsSchema.parse({
      allowedEmailDomains: ["Example.com", "@example.com", "*.Corp.io"],
    });
    expect(parsed.allowedEmailDomains).toEqual(["example.com", "*.corp.io"]);
  });

  it("rejects an invalid domain with a stable code", () => {
    const result = registrationSettingsSchema.safeParse({
      allowedEmailDomains: ["ok.com", "not a domain"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(issuesByField(result.error)).toEqual({
        allowedEmailDomains: "invalid_domain",
      });
    }
  });

  it("caps the list length", () => {
    const many = Array.from({ length: 101 }, (_, i) => `d${i}.com`);
    expect(
      registrationSettingsSchema.safeParse({ allowedEmailDomains: many })
        .success,
    ).toBe(false);
  });
});

describe("trial schema", () => {
  it("needs a plan once enabled", () => {
    const result = trialSettingsSchema.safeParse({ enabled: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(issuesByField(result.error)).toEqual({ planId: "plan_required" });
    }
  });

  it("allows a configured but disabled trial", () => {
    expect(trialSettingsSchema.parse({ enabled: false, planId: "p1" })).toEqual(
      { enabled: false, planId: "p1", durationDays: null },
    );
  });

  it("treats blank plan and duration as unset", () => {
    expect(
      trialSettingsSchema.parse({
        enabled: false,
        planId: "",
        durationDays: "",
      }),
    ).toEqual({ enabled: false, planId: null, durationDays: null });
  });

  it("bounds the duration override", () => {
    for (const durationDays of [0, -1, 1.5, 4000]) {
      expect(
        trialSettingsSchema.safeParse({
          enabled: true,
          planId: "p",
          durationDays,
        }).success,
        String(durationDays),
      ).toBe(false);
    }
    expect(
      trialSettingsSchema.parse({ enabled: true, planId: "p", durationDays: 7 })
        .durationDays,
    ).toBe(7);
  });
});

describe("subscription output schema", () => {
  const fails = (input: unknown) =>
    !subscriptionOutputSettingsSchema.safeParse(input).success;

  it("bounds ports, intervals and the profile interval", () => {
    expect(fails({ mixedPort: 0 })).toBe(true);
    expect(fails({ mixedPort: 65536 })).toBe(true);
    expect(fails({ mixedPort: 80.5 })).toBe(true);
    expect(fails({ urlTestIntervalSeconds: 5 })).toBe(true);
    expect(fails({ profileUpdateIntervalHours: 0 })).toBe(true);
    expect(fails({ profileUpdateIntervalHours: 721 })).toBe(true);
    expect(fails({ mixedPort: 1, profileUpdateIntervalHours: 720 })).toBe(
      false,
    );
  });

  it("only accepts http(s) URLs for the latency test", () => {
    expect(fails({ urlTestUrl: "ftp://example.com/x" })).toBe(true);
    expect(fails({ urlTestUrl: "javascript:alert(1)" })).toBe(true);
    expect(fails({ urlTestUrl: "nope" })).toBe(true);
    expect(fails({ urlTestUrl: "http://cp.cloudflare.com/generate_204" })).toBe(
      false,
    );
  });

  it("keeps header-hostile characters out of the profile title", () => {
    for (const profileTitle of ['a"b', "a\\b", "a/b", "a\nb", "", "   "]) {
      expect(fails({ profileTitle }), JSON.stringify(profileTitle)).toBe(true);
    }
    expect(
      subscriptionOutputSettingsSchema.parse({ profileTitle: "  花朵 VPN " })
        .profileTitle,
    ).toBe("花朵 VPN");
  });
});

describe("site schema", () => {
  it("treats blank support fields as unset", () => {
    expect(
      siteSettingsSchema.parse({ supportUrl: "  ", supportEmail: "" }),
    ).toMatchObject({ supportUrl: null, supportEmail: null });
  });

  it("validates the support link and address", () => {
    expect(
      siteSettingsSchema.parse({
        supportUrl: "https://help.example.com/x",
        supportEmail: "help@example.com",
      }),
    ).toMatchObject({
      supportUrl: "https://help.example.com/x",
      supportEmail: "help@example.com",
    });
    expect(
      siteSettingsSchema.safeParse({ supportUrl: "javascript:x" }).success,
    ).toBe(false);
    expect(siteSettingsSchema.safeParse({ supportEmail: "nope" }).success).toBe(
      false,
    );
  });

  it("rejects HTML in the notice but allows ordinary punctuation", () => {
    for (const bad of [
      "<b>hi</b>",
      "x <script>alert(1)</script>",
      "<!-- c -->",
    ]) {
      const result = siteSettingsSchema.safeParse({ userNotice: bad });
      expect(result.success, bad).toBe(false);
      if (!result.success) {
        expect(issuesByField(result.error)).toEqual({ userNotice: "no_html" });
      }
    }
    expect(
      siteSettingsSchema.parse({ userNotice: "5 < 6 & 7 > 3, ok?" }).userNotice,
    ).toBe("5 < 6 & 7 > 3, ok?");
  });

  it("caps the notice length", () => {
    expect(
      siteSettingsSchema.safeParse({ userNotice: "a".repeat(501) }).success,
    ).toBe(false);
  });

  it("only knows info and warning levels", () => {
    expect(
      siteSettingsSchema.safeParse({ userNoticeLevel: "critical" }).success,
    ).toBe(false);
  });
});

describe("updateSettingsSectionSchema", () => {
  it("picks the schema by section", () => {
    const parsed = updateSettingsSectionSchema.parse({
      section: "site",
      values: { maintenanceMode: true },
    });
    expect(parsed.section).toBe("site");
    expect(parsed.values).toMatchObject({ maintenanceMode: true });
  });

  it("validates values against that section only", () => {
    expect(
      updateSettingsSectionSchema.safeParse({
        section: "site",
        values: { mode: "closed", supportUrl: "bad" },
      }).success,
    ).toBe(false);
    expect(
      updateSettingsSectionSchema.safeParse({
        section: "registration",
        values: { mode: "closed" },
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown section", () => {
    expect(
      updateSettingsSectionSchema.safeParse({ section: "secrets", values: {} })
        .success,
    ).toBe(false);
  });
});

describe("toPublicSettings", () => {
  const settings = mergeSettings([
    {
      key: "registration",
      value: { mode: "closed", allowedEmailDomains: ["x.com"] },
    },
    {
      key: "site",
      value: {
        supportUrl: "https://help.example.com",
        supportEmail: "help@example.com",
        userNotice: "Heads up",
        userNoticeLevel: "warning",
        maintenanceMode: true,
      },
    },
  ]);

  it("gives signed-in viewers the notice and maintenance flag", () => {
    expect(toPublicSettings(settings, { signedIn: true })).toEqual({
      registrationMode: "closed",
      supportUrl: "https://help.example.com",
      supportEmail: "help@example.com",
      userNotice: { text: "Heads up", level: "warning" },
      maintenanceMode: true,
    });
  });

  it("withholds them from anonymous viewers", () => {
    expect(toPublicSettings(settings, { signedIn: false })).toMatchObject({
      userNotice: null,
      maintenanceMode: false,
    });
  });

  it("never carries admin-only fields", () => {
    const keys = Object.keys(toPublicSettings(settings, { signedIn: true }));
    expect(keys.sort()).toEqual(
      [
        "maintenanceMode",
        "registrationMode",
        "supportEmail",
        "supportUrl",
        "userNotice",
      ].sort(),
    );
    expect(
      JSON.stringify(toPublicSettings(settings, { signedIn: true })),
    ).not.toContain("x.com");
  });

  it("has no notice when the text is empty", () => {
    expect(
      toPublicSettings(defaultSettings(), { signedIn: true }).userNotice,
    ).toBeNull();
  });
});
