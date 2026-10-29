import type {
  AnnouncementAudience,
  AnnouncementLevel,
} from "@/db/announcement-schema";

/**
 * Pure announcement helpers shared by the user-facing server function and its
 * tests. No database access: callers pass the rows and the viewer's context.
 */

export interface VisibilityAnnouncement {
  published: boolean;
  audience: AnnouncementAudience;
  planIds: readonly string[];
  startsAt: Date | null;
  endsAt: Date | null;
}

export interface VisibilityContext {
  now: Date;
  /** Plan ids of the viewer's currently active subscriptions. */
  activePlanIds: readonly string[];
}

/**
 * Whether the viewer should see the announcement right now: published, inside
 * its `[startsAt, endsAt)` window (a missing bound is unbounded), and the
 * audience matches the viewer's active subscriptions.
 */
export function isAnnouncementVisible(
  announcement: VisibilityAnnouncement,
  { now, activePlanIds }: VisibilityContext,
): boolean {
  if (!announcement.published) return false;
  const time = now.getTime();
  if (announcement.startsAt && time < announcement.startsAt.getTime()) {
    return false;
  }
  if (announcement.endsAt && time >= announcement.endsAt.getTime()) {
    return false;
  }
  switch (announcement.audience) {
    case "all":
      return true;
    case "active":
      return activePlanIds.length > 0;
    case "plan":
      return announcement.planIds.some((id) => activePlanIds.includes(id));
    default:
      return false;
  }
}

const LEVEL_RANK: Record<AnnouncementLevel, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export interface SortableAnnouncement {
  pinned: boolean;
  level: AnnouncementLevel;
  createdAt: Date;
}

/**
 * Display order: pinned first, then by severity (critical, warning, info),
 * then newest first. Returns a new array.
 */
export function sortAnnouncements<T extends SortableAnnouncement>(
  list: readonly T[],
): T[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const byLevel = LEVEL_RANK[a.level] - LEVEL_RANK[b.level];
    if (byLevel !== 0) return byLevel;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
}
