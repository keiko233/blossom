import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import type React from "react";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";

import { ServerFormFields } from "./server-form-fields";
import { TokenRevealDialog } from "./token-reveal-dialog";
import { useServerFormController } from "./use-server-form";

const SERVERS_LIST = "/admin/proxies/servers" as const;

/**
 * Create page for a new server, rendered in the workspace's right-hand outlet.
 * Editing an existing server happens on its Settings tab instead.
 */
export function ServerFormPage(): React.ReactElement {
  const navigate = useNavigate();

  const goToList = () => void navigate({ to: SERVERS_LIST });

  const { form } = useServerFormController({
    onSuccess: async ({ token, serverId }) => {
      // Reveal the one-time token before leaving the create page.
      if (token) {
        await TokenRevealDialog.call({ token });
      }
      // OAuth-only creates have no token to show; send the operator to the
      // Connection tab in both cases so installation starts from one place.
      if (serverId) {
        void navigate({
          to: "/admin/proxies/servers/$serverId/connection",
          params: { serverId },
        });
        return;
      }
      goToList();
    },
  });

  return (
    <div className="flex flex-col">
      <PageHeader className="sticky top-0 z-10 gap-3 border-b bg-background/80 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label={m.admin_proxies_servers_form_back()}
            render={<Link to={SERVERS_LIST} />}
          >
            <ArrowLeftIcon />
          </Button>
          <PageHeaderTitle>
            {m.admin_proxies_servers_form_create_title()}
          </PageHeaderTitle>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" render={<Link to={SERVERS_LIST} />}>
            {m.admin_proxies_servers_form_cancel()}
          </Button>
          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(isSubmitting) => (
              <Button type="submit" form="server-form" loading={isSubmitting}>
                {m.admin_proxies_servers_form_save()}
              </Button>
            )}
          </form.Subscribe>
        </div>
      </PageHeader>

      <form
        id="server-form"
        className="w-full"
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void form.handleSubmit();
        }}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
          <div className="rounded-xl border bg-card p-4 shadow-xs">
            <ServerFormFields form={form} showBackupToken />
          </div>

          <p className="text-sm text-muted-foreground">
            {m.admin_proxies_servers_form_description()}
          </p>
        </div>
      </form>
    </div>
  );
}
