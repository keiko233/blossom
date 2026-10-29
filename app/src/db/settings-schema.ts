import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { user } from "./auth-schema";

/**
 * Admin-editable system settings: one row per settings section (see
 * `SETTING_SECTIONS` in `@/lib/settings`), the value being that section's JSON.
 * A missing row means "use the defaults", so a fresh install needs no rows.
 * Deleting the admin who last saved a section keeps the row with the editor
 * shown as unknown.
 */
export const appSetting = pgTable("app_setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  updatedById: text("updated_by_id").references(() => user.id, {
    onDelete: "set null",
  }),
});

export type AppSettingRow = typeof appSetting.$inferSelect;
