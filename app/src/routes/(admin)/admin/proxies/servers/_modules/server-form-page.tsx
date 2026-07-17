import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import type React from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import { Switch } from "@/components/ui/switch";
import { m } from "@/paraglide/messages";
import { CERTIFICATES_QUERY_KEY, listCertificates } from "@/query/certificates";
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
  const { data: certificates = [] } = useQuery({
    queryKey: CERTIFICATES_QUERY_KEY,
    queryFn: () => listCertificates(),
  });

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

            <div className="grid gap-3 sm:grid-cols-2">
              <form.Field name="configPollIntervalSeconds">
                {(field) => (
                  <Field>
                    <FieldLabel>
                      {m.admin_proxies_servers_field_config_interval()}
                    </FieldLabel>
                    <NumberField
                      min={5}
                      max={86_400}
                      value={field.state.value}
                      onValueChange={(value) => field.handleChange(value ?? 60)}
                    >
                      <NumberFieldGroup>
                        <NumberFieldDecrement />
                        <NumberFieldInput />
                        <NumberFieldIncrement />
                      </NumberFieldGroup>
                    </NumberField>
                  </Field>
                )}
              </form.Field>

              <form.Field name="heartbeatIntervalSeconds">
                {(field) => (
                  <Field>
                    <FieldLabel>
                      {m.admin_proxies_servers_field_heartbeat_interval()}
                    </FieldLabel>
                    <NumberField
                      min={5}
                      max={300}
                      value={field.state.value}
                      onValueChange={(value) => field.handleChange(value ?? 30)}
                    >
                      <NumberFieldGroup>
                        <NumberFieldDecrement />
                        <NumberFieldInput />
                        <NumberFieldIncrement />
                      </NumberFieldGroup>
                    </NumberField>
                  </Field>
                )}
              </form.Field>
            </div>

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

            <form.Field name="certificateIds">
              {(field) => (
                <Field>
                  <FieldLabel>
                    {m.admin_proxies_servers_field_certificates()}
                  </FieldLabel>
                  <p className="text-xs text-muted-foreground">
                    {m.admin_proxies_servers_field_certificates_help()}
                  </p>
                  <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2">
                    {certificates.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {m.admin_proxies_servers_field_certificates_empty()}
                      </p>
                    ) : (
                      certificates.map((certificate) => {
                        const checked = field.state.value.includes(
                          certificate.id,
                        );
                        return (
                          <label
                            key={certificate.id}
                            className="flex cursor-pointer items-start gap-2 rounded-md p-2 hover:bg-muted/48"
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(next) =>
                                field.handleChange(
                                  next
                                    ? [...field.state.value, certificate.id]
                                    : field.state.value.filter(
                                        (id) => id !== certificate.id,
                                      ),
                                )
                              }
                            />
                            <span className="min-w-0 text-sm">
                              <span className="block font-medium">
                                {certificate.name}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {certificate.domains.join(", ")}
                              </span>
                            </span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </Field>
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
