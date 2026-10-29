import { useQuery } from "@tanstack/react-query";
import {
  InfoIcon,
  OctagonAlertIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { AnnouncementLevel } from "@/db/announcement-schema";
import { formatDate } from "@/lib/format";
import { m } from "@/paraglide/messages";
import {
  listMyAnnouncements,
  type MyAnnouncement,
  myAnnouncementsQueryKey,
} from "@/query/announcements";

const ALERT_VARIANT: Record<
  AnnouncementLevel,
  "default" | "warning" | "error"
> = {
  info: "default",
  warning: "warning",
  critical: "error",
};

const LEVEL_ICON: Record<AnnouncementLevel, React.ReactElement> = {
  info: <InfoIcon />,
  warning: <TriangleAlertIcon />,
  critical: <OctagonAlertIcon />,
};

/** Cap so the stored list cannot grow without bound. */
const MAX_DISMISSED = 200;

function dismissedStorageKey(userId: string): string {
  return `blossom.dismissed-announcements.${userId}`;
}

/**
 * Dismissed announcement ids for this browser. localStorage can be missing,
 * blocked or full; in that case nothing is remembered and the list simply
 * shows everything again on the next visit.
 */
function readDismissed(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function writeDismissed(key: string, ids: string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(ids.slice(-MAX_DISMISSED)));
  } catch {
    // Storage unavailable: the dismissal lasts for this page view only.
  }
}

/**
 * Announcements addressed to the signed-in user, above the dashboard content.
 * Renders nothing while loading, on error, or when there is nothing to show.
 * Pinned announcements cannot be dismissed.
 */
export function UserAnnouncements({
  userId,
}: {
  userId: string;
}): React.ReactElement | null {
  const storageKey = dismissedStorageKey(userId);
  const { data: announcements } = useQuery({
    queryKey: myAnnouncementsQueryKey(userId),
    queryFn: () => listMyAnnouncements(),
  });

  // Read after mount so the server render and the first client render match.
  const [dismissed, setDismissed] = React.useState<string[]>([]);
  React.useEffect(() => {
    setDismissed(readDismissed(storageKey));
  }, [storageKey]);

  const dismiss = (id: string) => {
    const next = [...dismissed, id];
    setDismissed(next);
    writeDismissed(storageKey, next);
  };

  const visible = (announcements ?? []).filter(
    (item) => item.pinned || !dismissed.includes(item.id),
  );
  if (visible.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-heading text-base font-semibold">
        {m.user_announcements_title()}
      </h2>
      {visible.map((item: MyAnnouncement) => (
        <Alert key={item.id} variant={ALERT_VARIANT[item.level]}>
          {LEVEL_ICON[item.level]}
          <AlertTitle>{item.title}</AlertTitle>
          <AlertDescription>
            <p className="whitespace-pre-line">{item.body}</p>
            <p className="text-xs">
              {m.user_announcements_posted_on({
                date: formatDate(item.createdAt),
              })}
            </p>
          </AlertDescription>
          {item.pinned ? null : (
            <AlertAction>
              <Button
                aria-label={m.user_announcements_dismiss()}
                size="icon-xs"
                variant="ghost"
                onClick={() => dismiss(item.id)}
              >
                <XIcon />
              </Button>
            </AlertAction>
          )}
        </Alert>
      ))}
    </section>
  );
}
