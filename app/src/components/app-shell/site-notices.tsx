import { useQuery } from "@tanstack/react-query";
import { InfoIcon, TriangleAlertIcon, WrenchIcon } from "lucide-react";
import type React from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { m } from "@/paraglide/messages";
import { getPublicSettings, PUBLIC_SETTINGS_QUERY_KEY } from "@/query/settings";

/** The user-safe settings (banners, support links), cached briefly. */
export function usePublicSettings() {
  return useQuery({
    queryKey: PUBLIC_SETTINGS_QUERY_KEY,
    queryFn: () => getPublicSettings(),
    staleTime: 60_000,
  });
}

/**
 * Site-wide banners above the signed-in pages: the maintenance notice and the
 * admin's global notice. Both are plain text (rendered as text, never HTML).
 * Renders nothing while loading or on error. The subscription endpoint is
 * unaffected by maintenance mode, which the banner says.
 */
export function SiteNotices(): React.ReactElement | null {
  const { data } = usePublicSettings();
  if (!data || (!data.maintenanceMode && !data.userNotice)) return null;

  return (
    <div className="flex flex-col gap-3 px-4 pt-4">
      {data.maintenanceMode ? (
        <Alert variant="warning">
          <WrenchIcon />
          <AlertTitle>{m.user_maintenance_title()}</AlertTitle>
          <AlertDescription>
            {m.user_maintenance_description()}
          </AlertDescription>
        </Alert>
      ) : null}
      {data.userNotice ? (
        <Alert
          variant={data.userNotice.level === "warning" ? "warning" : "info"}
        >
          {data.userNotice.level === "warning" ? (
            <TriangleAlertIcon />
          ) : (
            <InfoIcon />
          )}
          <AlertDescription>
            <p className="whitespace-pre-line">{data.userNotice.text}</p>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
