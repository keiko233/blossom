import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import type React from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { m } from "@/paraglide/messages";
import type { ServerDTO } from "@/query/servers";

import { TokenRevealDialog } from "./token-reveal-dialog";
import { useServerFormController } from "./use-server-form";

const SERVERS_LIST = "/admin/proxies/servers" as const;

export interface ServerFormPageProps {
  /** Present when editing; absent for the create page. */
  server?: ServerDTO;
}

export function ServerFormPage({
  server,
}: ServerFormPageProps): React.ReactElement {
  const navigate = useNavigate();
  const isEdit = Boolean(server);

  const goToList = () => void navigate({ to: SERVERS_LIST });

  const { form } = useServerFormController({
    server,
    onSuccess: async ({ token }) => {
      // On create, reveal the one-time token before returning to the list.
      if (token) {
        await TokenRevealDialog.call({ token });
      }
      goToList();
    },
  });

  return (
    <div className="flex flex-col">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-background/80 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={m.admin_proxies_servers_form_back()}
            onClick={goToList}
          >
            <ArrowLeftIcon />
          </Button>
          <h1 className="font-heading text-lg font-semibold">
            {isEdit
              ? m.admin_proxies_servers_form_edit_title()
              : m.admin_proxies_servers_form_create_title()}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={goToList}>
            {m.admin_proxies_servers_form_cancel()}
          </Button>
          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(isSubmitting) => (
              <Button type="submit" form="server-form" disabled={isSubmitting}>
                {m.admin_proxies_servers_form_save()}
              </Button>
            )}
          </form.Subscribe>
        </div>
      </header>

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
          <div className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-xs">
            <form.Field name="name">
              {(field) => (
                <Field>
                  <FieldLabel>
                    {m.admin_proxies_servers_field_name()}
                  </FieldLabel>
                  <Input
                    value={field.state.value}
                    onValueChange={(v) => field.handleChange(v)}
                    onBlur={field.handleBlur}
                    placeholder="us-west-server-01"
                  />
                </Field>
              )}
            </form.Field>

            <form.Field name="remark">
              {(field) => (
                <Field>
                  <FieldLabel>
                    {m.admin_proxies_servers_field_remark()}
                  </FieldLabel>
                  <Input
                    value={field.state.value}
                    onValueChange={(v) => field.handleChange(v)}
                    onBlur={field.handleBlur}
                  />
                </Field>
              )}
            </form.Field>

            <form.Field name="address">
              {(field) => (
                <Field>
                  <FieldLabel>
                    {m.admin_proxies_servers_field_address()}
                  </FieldLabel>
                  <Input
                    value={field.state.value}
                    onValueChange={(v) => field.handleChange(v)}
                    onBlur={field.handleBlur}
                    placeholder="example.com"
                  />
                </Field>
              )}
            </form.Field>

            <form.Field name="enabled">
              {(field) => (
                <div className="flex items-center gap-3">
                  <Switch
                    checked={field.state.value}
                    onCheckedChange={(v) => field.handleChange(v)}
                  />
                  <Label>{m.admin_proxies_servers_field_enabled()}</Label>
                </div>
              )}
            </form.Field>
          </div>

          <p className="text-sm text-muted-foreground">
            {m.admin_proxies_servers_form_description()}
          </p>
        </div>
      </form>
    </div>
  );
}
