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
