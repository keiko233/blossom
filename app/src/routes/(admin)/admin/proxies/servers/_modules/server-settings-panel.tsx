import { useRouter } from "@tanstack/react-router";
import type React from "react";

import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import type { ServerDTO } from "@/query/servers";

import { ServerFormFields } from "./server-form-fields";
import { useServerFormController } from "./use-server-form";

export interface ServerSettingsPanelProps {
  server: ServerDTO;
}

/**
 * Settings tab: the existing server form for this server. Saving keeps the
 * operator on the tab and refreshes the route loader so the workspace header
 * shows the saved name and state.
 */
export function ServerSettingsPanel({
  server,
}: ServerSettingsPanelProps): React.ReactElement {
  const router = useRouter();

  const { form } = useServerFormController({
    server,
    onSuccess: () => router.invalidate(),
  });

  return (
    <section
      data-slot="server-settings"
      className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-xs"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">
            {m.admin_proxies_servers_settings_title()}
          </h2>
          <p className="text-xs text-muted-foreground">
            {m.admin_proxies_servers_form_description()}
          </p>
        </div>
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button
              type="submit"
              form="server-settings-form"
              loading={isSubmitting}
            >
              {m.admin_proxies_servers_form_save()}
            </Button>
          )}
        </form.Subscribe>
      </div>

      <form
        id="server-settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void form.handleSubmit();
        }}
      >
        <ServerFormFields form={form} />
      </form>
    </section>
  );
}
