import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const ANNOUNCEMENT_LEVELS = ["info", "warning", "critical"] as const;
/**
 * Who sees an announcement: everyone, users with at least one active
 * subscription, or users with an active subscription on one of `planIds`.
 */
export const ANNOUNCEMENT_AUDIENCES = ["all", "active", "plan"] as const;

export type AnnouncementLevel = (typeof ANNOUNCEMENT_LEVELS)[number];
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

/**
 * An admin-authored notice shown on the user dashboard. `body` is plain text
 * (rendered with line breaks preserved, never as HTML). Visible only while
 * `published`, inside the optional `[startsAt, endsAt)` window.
 */
export const announcement = pgTable("announcement", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  level: text("level").$type<AnnouncementLevel>().default("info").notNull(),
  audience: text("audience")
    .$type<AnnouncementAudience>()
    .default("all")
    .notNull(),
  planIds: text("plan_ids").array().default([]).notNull(),
  pinned: boolean("pinned").default(false).notNull(),
  published: boolean("published").default(false).notNull(),
  startsAt: timestamp("starts_at"),
  endsAt: timestamp("ends_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export type Announcement = typeof announcement.$inferSelect;
export type NewAnnouncement = typeof announcement.$inferInsert;
