import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { eq } from "drizzle-orm";

import { databaseDriver, db } from "@/db";
import { plan } from "@/db/plan-schema";
import { appSetting } from "@/db/settings-schema";
import { fromInput } from "@/lib/admin-audit";
import { adminAudit } from "@/lib/admin-audit-middleware";
import { getAuth, getEnabledSocialProviders } from "@/lib/auth";
import { isEmailEnabled } from "@/lib/email";
import { ensureAdmin } from "@/lib/ensure-admin";
import { getServerEnv } from "@/lib/env";
import { detectRuntime } from "@/lib/runtime-info";
import {
  defaultSettings,
  type PublicSettings,
  toPublicSettings,
  updateSettingsSectionSchema,
} from "@/lib/settings";
import { forgetSettings, getSettings } from "@/query/settings-store";

/** TanStack Query key for the admin settings page. */
export const ADMIN_SETTINGS_QUERY_KEY = ["admin", "settings"] as const;

/** TanStack Query key for the user-safe settings (banners, support links). */
export const PUBLIC_SETTINGS_QUERY_KEY = ["settings", "public"] as const;

/**
 * Read-only facts about the deployment for the settings page. Booleans and
 * names only: no keys, secrets, tokens or connection strings.
 */
function readSystemStatus() {
  const env = getServerEnv();
  return {
    appName: env.APP_NAME,
    authUrl: env.BETTER_AUTH_URL,
    emailConfigured: isEmailEnabled,
    socialProviders: getEnabledSocialProviders(),
    runtime: detectRuntime({
      userAgent: typeof navigator === "undefined" ? null : navigator.userAgent,
      env: typeof process === "undefined" ? undefined : process.env,
      hasNodeProcess: typeof process !== "undefined",
    }),
    databaseDriver,
  };
}

export type SystemStatus = ReturnType<typeof readSystemStatus>;

export const getAdminSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    await ensureAdmin();
    return {
      settings: await getSettings(),
      status: readSystemStatus(),
    };
  },
);

export type AdminSettingsData = Awaited<ReturnType<typeof getAdminSettings>>;

export const updateSettingsSection = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("settings.update", {
      targetType: "setting",
      targetId: fromInput("section"),
    }),
  ])
  .validator(updateSettingsSectionSchema)
  .handler(async ({ data }) => {
    const session = await ensureAdmin();

    if (data.section === "trial" && data.values.planId) {
      const [planRow] = await db
        .select({ id: plan.id })
        .from(plan)
        .where(eq(plan.id, data.values.planId));
      if (!planRow) {
        throw new Error("Plan not found");
      }
    }

    await db
      .insert(appSetting)
      .values({
        key: data.section,
        value: data.values,
        updatedById: session.user.id,
      })
      .onConflictDoUpdate({
        target: appSetting.key,
        set: {
          value: data.values,
          updatedById: session.user.id,
          updatedAt: new Date(),
        },
      });
    forgetSettings();
    return { section: data.section };
  });

/**
 * The settings clients may see, for signed-out and signed-in viewers alike.
 * Admin-only values (domain allow-list, trial plan, output tuning) never leave
 * this function; the notice and maintenance flag are only reported to a
 * signed-in viewer. Falls back to the defaults if the settings cannot be read,
 * so a settings problem cannot take the sign-in page down (registration rules
 * themselves are enforced server-side, not by this value).
 */
export const getPublicSettings = createServerFn({ method: "GET" }).handler(
  async (): Promise<PublicSettings> => {
    let settings;
    try {
      settings = await getSettings();
    } catch (error) {
      console.error("[settings] could not read settings", error);
      settings = defaultSettings();
    }
    const session = await getAuth().api.getSession({
      headers: getRequestHeaders(),
    });
    return toPublicSettings(settings, { signedIn: Boolean(session) });
  },
);
