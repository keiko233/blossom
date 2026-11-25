import { useRouter } from "@tanstack/react-router";
import type React from "react";

import { PageContent, PageToolbar } from "@/components/app-shell/page-header";
import { WorkspaceViewport } from "@/components/app-shell/workspace";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import type { ServerDTO } from "@/query/servers";

import { ServerFormFields } from "./server-form-fields";
import { useServerFormController } from "./use-server-form";

export interface ServerSettingsPanelProps {
  server: ServerDTO;
}

/** Settings: the server form in the R4 narrow column, flat on the page. */
export function ServerSettingsPanel({
  server,
}: ServerSettingsPanelProps): React.ReactElement {
  const router = useRouter();

  const { form } = useServerFormController({
    server,
    onSuccess: () => router.invalidate(),
  });

  return (
    <WorkspaceViewport
      scrollId={`server-${server.id}-settings`}
      className="[--page-header-h:0px]"
    >
      <PageToolbar>
        <span className="text-xs text-muted-foreground">
          {m.admin_proxies_servers_settings_title()}
        </span>
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button
              className="ms-auto"
              size="sm"
              type="submit"
              form="server-settings-form"
              loading={isSubmitting}
            >
              {m.admin_proxies_servers_form_save()}
            </Button>
          )}
        </form.Subscribe>
      </PageToolbar>

      <PageContent width="form">
        <p className="text-xs text-muted-foreground">
          {m.admin_proxies_servers_form_description()}
        </p>
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
      </PageContent>
    </WorkspaceViewport>
  );
}
