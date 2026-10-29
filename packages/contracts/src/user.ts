import { z } from "zod";

/**
 * Admin user-management input schemas. Mutations proxy to the better-auth
 * admin plugin (which owns session revocation and ban bookkeeping); these
 * schemas only shape the server-fn boundary.
 */

export const userIdSchema = z.object({ id: z.string().min(1) });

export const banUserSchema = z.object({
  userId: z.string().min(1),
  reason: z.string().max(512).optional(),
  // Days from now; omitted means a permanent ban.
  expiresInDays: z.number().int().min(1).optional(),
});

export const setUserRoleSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["admin", "user"]),
});

export type BanUserInput = z.infer<typeof banUserSchema>;
export type SetUserRoleInput = z.infer<typeof setUserRoleSchema>;

// --- Admin user management ---------------------------------------------------

export const USER_PAGE_SIZES = [10, 20, 50, 100] as const;

/** Largest id list a single bulk request may carry. */
export const BULK_USER_MAX_IDS = 500;

/** Hard cap on rows a CSV export returns. */
export const USER_EXPORT_MAX_ROWS = 10_000;

/** Bounds better-auth's default password policy enforces on sign-up. */
const passwordSchema = z.string().min(8).max(128);

export const userRoleSchema = z.enum(["admin", "user"]);
export const userSortSchema = z.enum(["createdAt", "name", "email"]);

/** Filters shared by the user list and the CSV export. */
export const userFilterSchema = z.object({
  // Matches name, email or user id (substring, case-insensitive).
  search: z.string().trim().max(200).optional(),
  role: userRoleSchema.optional(),
  status: z.enum(["active", "banned"]).optional(),
  // active: at least one unexpired active subscription; none: no such one.
  subscription: z.enum(["active", "none"]).optional(),
  sort: userSortSchema.default("createdAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

export const listUsersSchema = userFilterSchema.extend({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});

export type UserFilter = z.infer<typeof userFilterSchema>;
export type UserFilterInput = z.input<typeof userFilterSchema>;
export type ListUsersInput = z.input<typeof listUsersSchema>;

export const createUserSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().max(320).pipe(z.email()),
  // Blank/omitted creates the account without a password.
  password: passwordSchema.optional(),
  role: userRoleSchema.default("user"),
  // Optional plan to subscribe the new user to straight away.
  planId: z.string().min(1).optional(),
  // Email a magic sign-in link after creating a password-less account.
  sendSignInLink: z.boolean().default(false),
});

export const updateUserSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().max(320).pipe(z.email()),
  emailVerified: z.boolean(),
});

export const setUserPasswordSchema = z.object({
  id: z.string().min(1),
  password: passwordSchema,
});

export const userSessionSchema = z.object({
  userId: z.string().min(1),
  sessionId: z.string().min(1),
});

export const userNoteIdSchema = z.object({ id: z.string().min(1) });

export const addUserNoteSchema = z.object({
  userId: z.string().min(1),
  body: z.string().trim().min(1).max(2000),
});

export const bulkUserActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ban"),
    reason: z.string().max(512).optional(),
    expiresInDays: z.number().int().min(1).optional(),
  }),
  z.object({ type: z.literal("unban") }),
  z.object({ type: z.literal("setRole"), role: userRoleSchema }),
  z.object({ type: z.literal("delete") }),
]);

export const bulkUserSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(BULK_USER_MAX_IDS),
  action: bulkUserActionSchema,
});

export type CreateUserInput = z.input<typeof createUserSchema>;
export type BulkUserAction = z.infer<typeof bulkUserActionSchema>;
export type BulkUserActionInput = z.input<typeof bulkUserActionSchema>;
export type BulkUserInput = z.input<typeof bulkUserSchema>;

export interface BulkUserResult {
  succeeded: number;
  failed: { id: string; message: string }[];
  /** Ids left out because they are the calling admin's own account. */
  skipped: string[];
}
