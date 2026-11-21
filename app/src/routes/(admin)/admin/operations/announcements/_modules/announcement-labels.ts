import type {
  AnnouncementAudience,
  AnnouncementLevel,
} from "@/db/announcement-schema";
import { m } from "@/paraglide/messages";

export const LEVEL_LABELS: Record<AnnouncementLevel, () => string> = {
  info: () => m.admin_announcements_level_info(),
  warning: () => m.admin_announcements_level_warning(),
  critical: () => m.admin_announcements_level_critical(),
};

export const LEVEL_BADGE_VARIANT: Record<
  AnnouncementLevel,
  "info" | "warning" | "error"
> = {
  info: "info",
  warning: "warning",
  critical: "error",
};

export const AUDIENCE_LABELS: Record<AnnouncementAudience, () => string> = {
  all: () => m.admin_announcements_audience_all(),
  active: () => m.admin_announcements_audience_active(),
  plan: () => m.admin_announcements_audience_plan(),
};
