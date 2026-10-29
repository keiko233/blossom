import { z } from "zod";

import {
  USER_PAGE_SIZES,
  type UserFilterInput,
  userRoleSchema,
  userSortSchema,
} from "@/orpc/user/schema";

/**
 * URL search params of the users page. Defaults are left out of the URL
 * (undefined), and every field falls back to undefined on garbage input so a
 * hand-edited link never breaks the page.
 */
export const usersSearchSchema = z.object({
  page: z.number().int().min(1).optional().catch(undefined),
  pageSize: z
    .number()
    .refine((value) => (USER_PAGE_SIZES as readonly number[]).includes(value))
    .optional()
    .catch(undefined),
  // Numeric-looking queries are parsed as numbers by the router.
  q: z
    .union([z.string(), z.number()])
    .transform(String)
    .optional()
    .catch(undefined),
  role: userRoleSchema.optional().catch(undefined),
  status: z.enum(["active", "banned"]).optional().catch(undefined),
  subscription: z.enum(["active", "none"]).optional().catch(undefined),
  sort: userSortSchema.optional().catch(undefined),
  dir: z.enum(["asc", "desc"]).optional().catch(undefined),
});

export type UsersSearch = z.infer<typeof usersSearchSchema>;

/** The server-side filter a set of search params stands for. */
export function searchToUserFilter(search: UsersSearch): UserFilterInput {
  return {
    search: search.q?.trim() || undefined,
    role: search.role,
    status: search.status,
    subscription: search.subscription,
    sort: search.sort ?? "createdAt",
    sortDir: search.dir ?? "desc",
  };
}
