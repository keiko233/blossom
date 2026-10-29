import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { user } from "./auth-schema";

/**
 * Private admin notes about a user (support context, manual-billing remarks).
 * Deleting the user deletes their notes; deleting the author keeps the note
 * with the author shown as unknown.
 */
export const userNote = pgTable(
  "user_note",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => user.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("user_note_user_idx").on(table.userId, table.createdAt)],
);

export type UserNote = typeof userNote.$inferSelect;
export type NewUserNote = typeof userNote.$inferInsert;
