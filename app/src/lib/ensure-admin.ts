import { getRequest, getRequestHeaders } from "@tanstack/react-start/server";

import { getAuth } from "@/lib/auth";

type SessionResult = ReturnType<
  ReturnType<typeof getAuth>["api"]["getSession"]
>;

// One session lookup per request: a server function's audit middleware and its
// handler's `ensureAdmin` (and any server function it calls) share the result.
const sessionByRequest = new WeakMap<Request, SessionResult>();

function loadSession(): SessionResult {
  const request = getRequest();
  let pending = sessionByRequest.get(request);
  if (!pending) {
    pending = getAuth().api.getSession({ headers: getRequestHeaders() });
    sessionByRequest.set(request, pending);
  }
  return pending;
}

/**
 * The current session when it belongs to an admin, otherwise null. Never
 * throws for a missing or non-admin session.
 */
export async function getAdminSession() {
  const session = await loadSession();
  return session?.user.role === "admin" ? session : null;
}

/**
 * All admin CRUD goes through server functions (never the public API). Each one
 * asserts an authenticated admin session before touching the DB.
 */
export async function ensureAdmin() {
  const session = await loadSession();
  if (!session) {
    throw new Error("Unauthorized");
  }
  if (session.user.role !== "admin") {
    throw new Error("Forbidden");
  }
  return session;
}
