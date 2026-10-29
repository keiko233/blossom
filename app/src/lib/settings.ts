import { z } from "zod";

import { normalizeDomainPattern } from "./registration-policy";
import {
  DEFAULT_PROFILE_TITLE,
  DEFAULT_PROFILE_UPDATE_INTERVAL_HOURS,
} from "./subscription-headers";

/**
 * Typed registry of the admin-editable system settings. One zod schema per
 * section; every field has a default that reproduces the behaviour before
 * settings existed, so an install with no `app_setting` rows behaves exactly
 * as it always did.
 *
 * Constraint messages are stable codes (`SettingIssueCode`), not prose: the UI
 * maps them to localized text, the server only needs to know it was refused.
 */

export type SettingIssueCode =
  | "invalid_domain"
  | "too_many_domains"
  | "plan_required"
  | "trial_days_range"
  | "update_interval_range"
  | "test_interval_range"
  | "port_range"
  | "url_invalid"
  | "email_invalid"
  | "text_too_long"
  | "no_html"
  | "title_invalid";

const code = (value: SettingIssueCode): SettingIssueCode => value;

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** A blank string means "not set" for the optional text fields. */
const blankToNull = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? null : value;

const integer = (min: number, max: number, issue: SettingIssueCode) =>
  z
    .number(code(issue))
    .int(code(issue))
    .min(min, code(issue))
    .max(max, code(issue));

/** Whether a string contains control characters, quotes, backslashes or slashes. */
function hasUnsafeFilenameChar(value: string): boolean {
  for (const char of value) {
    const point = char.codePointAt(0)!;
    if (point < 0x20 || point === 0x7f) return true;
    if (char === '"' || char === "\\" || char === "/") return true;
  }
  return false;
}

/** HTML-looking markup (`<b>`, `</p>`, `<!--`, `<?xml`). Plain `<` is fine. */
function looksLikeHtml(value: string): boolean {
  return /<\s*\/?\s*[a-z!?]/i.test(value);
}

// --- Registration ------------------------------------------------------------

export const MAX_ALLOWED_EMAIL_DOMAINS = 100;

const domainPatternSchema = z.string().transform((value, ctx) => {
  const normalized = normalizeDomainPattern(value);
  if (normalized === null) {
    ctx.addIssue({ code: "custom", message: code("invalid_domain") });
    return z.NEVER;
  }
  return normalized;
});

export const registrationSettingsSchema = z.object({
  /** `closed`: no self-service sign-ups; admins can still create users. */
  mode: z.enum(["open", "closed"]).default("open"),
  /** Exact (`example.com`) or subdomain (`*.example.com`) patterns; empty = any. */
  allowedEmailDomains: z
    .array(domainPatternSchema)
    .max(MAX_ALLOWED_EMAIL_DOMAINS, code("too_many_domains"))
    .transform((list) => [...new Set(list)])
    .default([]),
  /**
   * Refuse sign-in to accounts whose email is unverified. Email-link and social
   * sign-ups arrive verified; today's password sign-in never required it.
   */
  requireEmailVerification: z.boolean().default(false),
});

// --- New-user trial ----------------------------------------------------------

export const MAX_TRIAL_DAYS = 3650;

export const trialSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    planId: z
      .preprocess(
        blankToNull,
        z.string().min(1, code("plan_required")).max(200).nullable(),
      )
      .default(null),
    /** Overrides the plan's own duration when set. */
    durationDays: z
      .preprocess(
        (value) => (value === "" ? null : value),
        integer(1, MAX_TRIAL_DAYS, "trial_days_range").nullable(),
      )
      .default(null),
  })
  .refine((value) => !value.enabled || value.planId !== null, {
    path: ["planId"],
    message: code("plan_required"),
  });

// --- Subscription output -----------------------------------------------------

export const DEFAULT_URL_TEST_URL = "https://www.gstatic.com/generate_204";

export const subscriptionOutputSettingsSchema = z.object({
  /** `Profile-Update-Interval` header, in hours. */
  profileUpdateIntervalHours: integer(1, 720, "update_interval_range").default(
    DEFAULT_PROFILE_UPDATE_INTERVAL_HOURS,
  ),
  /** Profile name: the download's file name without `.yaml`. */
  profileTitle: z
    .string()
    .trim()
    .min(1, code("title_invalid"))
    .max(64, code("title_invalid"))
    .refine((value) => !hasUnsafeFilenameChar(value), code("title_invalid"))
    .default(DEFAULT_PROFILE_TITLE),
  urlTestUrl: z
    .string()
    .trim()
    .max(2048, code("url_invalid"))
    .refine(isHttpUrl, code("url_invalid"))
    .default(DEFAULT_URL_TEST_URL),
  urlTestIntervalSeconds: integer(10, 86_400, "test_interval_range").default(
    300,
  ),
  mixedPort: integer(1, 65_535, "port_range").default(7890),
  allowLan: z.boolean().default(false),
  /** `GEOIP,LAN,DIRECT,no-resolve`. */
  ruleLanDirect: z.boolean().default(true),
  /** `GEOIP,CN,DIRECT`. */
  ruleCnDirect: z.boolean().default(true),
});

// --- Site & support ----------------------------------------------------------

export const USER_NOTICE_LEVELS = ["info", "warning"] as const;
export type UserNoticeLevel = (typeof USER_NOTICE_LEVELS)[number];

export const MAX_USER_NOTICE_LENGTH = 500;

export const siteSettingsSchema = z.object({
  supportUrl: z
    .preprocess(
      blankToNull,
      z
        .string()
        .trim()
        .max(2048, code("url_invalid"))
        .refine(isHttpUrl, code("url_invalid"))
        .nullable(),
    )
    .default(null),
  supportEmail: z
    .preprocess(
      blankToNull,
      z
        .string()
        .trim()
        .max(254, code("email_invalid"))
        .refine(
          (value) => z.email().safeParse(value).success,
          code("email_invalid"),
        )
        .nullable(),
    )
    .default(null),
  /** Plain-text banner for signed-in users; empty = none. Never rendered as HTML. */
  userNotice: z
    .string()
    .trim()
    .max(MAX_USER_NOTICE_LENGTH, code("text_too_long"))
    .refine((value) => !looksLikeHtml(value), code("no_html"))
    .default(""),
  userNoticeLevel: z.enum(USER_NOTICE_LEVELS).default("info"),
  /** Users see a maintenance banner; the subscription endpoint keeps serving. */
  maintenanceMode: z.boolean().default(false),
});

// --- Registry ----------------------------------------------------------------

export const SETTING_SECTIONS = [
  "registration",
  "trial",
  "subscription_output",
  "site",
] as const;
export type SettingSection = (typeof SETTING_SECTIONS)[number];

export const SETTING_SCHEMAS = {
  registration: registrationSettingsSchema,
  trial: trialSettingsSchema,
  subscription_output: subscriptionOutputSettingsSchema,
  site: siteSettingsSchema,
} as const satisfies Record<SettingSection, z.ZodType>;

export type SettingValues<S extends SettingSection> = z.output<
  (typeof SETTING_SCHEMAS)[S]
>;

export type AppSettings = { [S in SettingSection]: SettingValues<S> };

export type RegistrationSettings = SettingValues<"registration">;
export type TrialSettings = SettingValues<"trial">;
export type SubscriptionOutputSettings = SettingValues<"subscription_output">;
export type SiteSettings = SettingValues<"site">;

export function isSettingSection(value: unknown): value is SettingSection {
  return (SETTING_SECTIONS as readonly unknown[]).includes(value);
}

/** A fresh copy of a section's defaults (callers may mutate it). */
export function defaultSection<S extends SettingSection>(
  section: S,
): SettingValues<S> {
  return SETTING_SCHEMAS[section].parse({}) as SettingValues<S>;
}

export function defaultSettings(): AppSettings {
  return {
    registration: defaultSection("registration"),
    trial: defaultSection("trial"),
    subscription_output: defaultSection("subscription_output"),
    site: defaultSection("site"),
  };
}

export interface StoredSetting {
  key: string;
  value: unknown;
}

/**
 * Settings from stored rows. A missing row yields the section's defaults; so
 * does a value that fails its schema (reported through `onInvalid`, never
 * thrown: a bad row must not take the app down). Unknown keys are ignored.
 * Fields missing from an otherwise valid value take their field default, so
 * adding a field later needs no data migration.
 */
export function mergeSettings(
  rows: readonly StoredSetting[],
  onInvalid?: (section: SettingSection, error: z.ZodError) => void,
): AppSettings {
  const settings = defaultSettings();
  for (const section of SETTING_SECTIONS) {
    const row = rows.find((candidate) => candidate.key === section);
    if (!row) continue;
    const parsed = SETTING_SCHEMAS[section].safeParse(row.value);
    if (parsed.success) {
      (settings as Record<SettingSection, unknown>)[section] = parsed.data;
    } else {
      onInvalid?.(section, parsed.error);
    }
  }
  return settings;
}

/** Body of `updateSettingsSection`: the section name picks the schema. */
export const updateSettingsSectionSchema = z.discriminatedUnion("section", [
  z.object({
    section: z.literal("registration"),
    values: registrationSettingsSchema,
  }),
  z.object({ section: z.literal("trial"), values: trialSettingsSchema }),
  z.object({
    section: z.literal("subscription_output"),
    values: subscriptionOutputSettingsSchema,
  }),
  z.object({ section: z.literal("site"), values: siteSettingsSchema }),
]);

export type UpdateSettingsSectionInput = z.input<
  typeof updateSettingsSectionSchema
>;

/**
 * First issue code per top-level field of a failed parse, for showing a
 * localized message under the right input.
 */
export function issuesByField(
  error: z.ZodError,
): Record<string, SettingIssueCode> {
  const result: Record<string, SettingIssueCode> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "");
    if (field && !(field in result)) {
      result[field] = issue.message as SettingIssueCode;
    }
  }
  return result;
}

// --- Public projection -------------------------------------------------------

/** What clients may know. Nothing here is admin-only. */
export interface PublicSettings {
  registrationMode: RegistrationSettings["mode"];
  supportUrl: string | null;
  supportEmail: string | null;
  /** Only for signed-in viewers; null otherwise or when empty. */
  userNotice: { text: string; level: UserNoticeLevel } | null;
  /** Only reported to signed-in viewers. */
  maintenanceMode: boolean;
}

export function toPublicSettings(
  settings: AppSettings,
  viewer: { signedIn: boolean },
): PublicSettings {
  const { site, registration } = settings;
  return {
    registrationMode: registration.mode,
    supportUrl: site.supportUrl,
    supportEmail: site.supportEmail,
    userNotice:
      viewer.signedIn && site.userNotice
        ? { text: site.userNotice, level: site.userNoticeLevel }
        : null,
    maintenanceMode: viewer.signedIn && site.maintenanceMode,
  };
}
