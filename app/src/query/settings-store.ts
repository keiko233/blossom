import { getRequest } from "@tanstack/react-start/server";

import { db } from "@/db";
import { appSetting } from "@/db/settings-schema";
import { type AppSettings, mergeSettings } from "@/lib/settings";

/**
 * Server-only reader of the admin-editable settings, kept apart from the
 * server-function module (`@/query/settings`) because that one is imported by
 * client pages, and a plain exported function that touches `db` would not be
 * stripped from the client bundle the way a server function handler is.
 */

// One settings read per request, shared by everything that asks during it (the
// better-auth hooks, the page's server functions). Deliberately not a
// cross-request cache: on Workers a module-level value may be served by an
// isolate that never sees another isolate's admin edit.
const settingsByRequest = new WeakMap<Request, Promise<AppSettings>>();

async function loadSettings(): Promise<AppSettings> {
  const rows = await db
    .select({ key: appSetting.key, value: appSetting.value })
    .from(appSetting);
  return mergeSettings(rows, (section, error) => {
    console.warn(
      `[settings] stored "${section}" settings are invalid, using defaults:`,
      error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  });
}

/** The current request, or null outside one (scripts, tests). */
function currentRequest(): Request | null {
  try {
    return getRequest();
  } catch {
    return null;
  }
}

/**
 * All settings, each section validated and defaulted. One query, memoized for
 * the lifetime of the request. A database failure propagates: the caller
 * cannot do its job without the database anyway.
 */
export function getSettings(): Promise<AppSettings> {
  const request = currentRequest();
  if (!request) return loadSettings();

  let pending = settingsByRequest.get(request);
  if (!pending) {
    pending = loadSettings();
    settingsByRequest.set(request, pending);
    // Never memoize a failure.
    pending.catch(() => {
      if (settingsByRequest.get(request) === pending) {
        settingsByRequest.delete(request);
      }
    });
  }
  return pending;
}

/** Forget this request's memoized read, e.g. right after saving. */
export function forgetSettings(): void {
  const request = currentRequest();
  if (request) settingsByRequest.delete(request);
}
