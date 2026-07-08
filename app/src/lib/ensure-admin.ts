import { getRequestHeaders } from "@tanstack/react-start/server";

import { getAuth } from "@/lib/auth";

/**
 * All admin CRUD goes through server functions (never the public API). Each one
 * asserts an authenticated admin session before touching the DB.
 */
export async function ensureAdmin() {
  const headers = getRequestHeaders();
  const session = await getAuth().api.getSession({ headers });
  if (!session) {
    throw new Error("Unauthorized");
  }
  if (session.user.role !== "admin") {
    throw new Error("Forbidden");
  }
  return session;
}
