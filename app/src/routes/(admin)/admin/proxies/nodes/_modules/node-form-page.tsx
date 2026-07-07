import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import type React from "react";

import { schemaSections } from "@/components/schema-form/schema-form";
import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import type { Node } from "@/db/proxy-schema";
import {
  NODE_PROTOCOLS,
  type NodeProtocol,
  settingsSchemaFor,
} from "@/orpc/proxy/sing-box-registry";
import { m } from "@/paraglide/messages";

import { TokenRevealDialog } from "./token-reveal-dialog";
import { settingsDefaults, useNodeFormController } from "./use-node-form";

const NODES_LIST = "/admin/proxies/nodes" as const;

export interface NodeFormPageProps {
  /** Present when editing; absent for the create page. */
  node?: Node;
}

export function NodeFormPage({ node }: NodeFormPageProps): React.ReactElement {
  const navigate = useNavigate();
  const isEdit = Boolean(node);

  const goToList = () => void navigate({ to: NODES_LIST });

  const { form } = useNodeFormController({
    node,
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
            aria-label={m.admin_proxies_nodes_form_back()}
            onClick={goToList}
          >
            <ArrowLeftIcon />
          </Button>
          <h1 className="font-heading text-lg font-semibold">
            {isEdit
              ? m.admin_proxies_nodes_form_edit_title()
              : m.admin_proxies_nodes_form_create_title()}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={goToList}>
            {m.admin_proxies_nodes_form_cancel()}
          </Button>
          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(isSubmitting) => (
              <Button type="submit" form="node-form" disabled={isSubmitting}>
                {m.admin_proxies_nodes_form_save()}
              </Button>
            )}
          </form.Subscribe>
        </div>
      </header>

      <form
        id="node-form"
        className="w-full"
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void form.handleSubmit();
        }}
      >
        {/* One tab strip: the hand-written node metadata, then a tab per settings
            section (Basic settings, Tls, Multiplex…) derived from the protocol's
            sing-box schema. Subscribing to `protocol` keeps that set in sync. */}
        <form.Subscribe selector={(s) => s.values.protocol}>
          {(protocol) => {
            const sections = schemaSections(
              form,
              settingsSchemaFor(protocol),
              "settings",
            );
            return (
              <Tabs
                defaultValue="meta"
                className="mx-auto w-full max-w-3xl gap-6 p-4"
              >
                <TabsList className="flex-wrap justify-start">
                  <TabsTab value="meta" className="grow-0">
                    {m.admin_proxies_nodes_form_meta()}
                  </TabsTab>
                  {sections.map((s) => (
                    <TabsTab key={s.id} value={s.id} className="grow-0">
                      {s.label}
                    </TabsTab>
                  ))}
                </TabsList>

                {/* Node metadata (hand-written; not part of the sing-box inbound). */}
                <TabsPanel value="meta" keepMounted>
                  <div className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-xs">
                    <form.Field name="name">
                      {(field) => (
                        <Field>
                          <FieldLabel>
                            {m.admin_proxies_nodes_field_name()}
                          </FieldLabel>
                          <Input
                            value={field.state.value}
                            onValueChange={(v) => field.handleChange(v)}
                            onBlur={field.handleBlur}
                            placeholder="us-west-01"
                          />
                        </Field>
                      )}
                    </form.Field>

                    <form.Field name="remark">
                      {(field) => (
                        <Field>
                          <FieldLabel>
                            {m.admin_proxies_nodes_field_remark()}
                          </FieldLabel>
                          <Input
                            value={field.state.value}
                            onValueChange={(v) => field.handleChange(v)}
                            onBlur={field.handleBlur}
                          />
                        </Field>
                      )}
                    </form.Field>

                    <div className="grid grid-cols-[2fr_1fr] gap-3">
                      <form.Field name="address">
                        {(field) => (
                          <Field>
                            <FieldLabel>
                              {m.admin_proxies_nodes_field_address()}
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

                      <form.Field name="listenPort">
                        {(field) => (
                          <Field>
                            <FieldLabel>
                              {m.admin_proxies_nodes_field_port()}
                            </FieldLabel>
                            <NumberField
                              min={1}
                              max={65535}
                              value={field.state.value || null}
                              onValueChange={(v) => field.handleChange(v ?? 0)}
                            >
                              <NumberFieldGroup>
                                <NumberFieldDecrement />
                                <NumberFieldInput onBlur={field.handleBlur} />
                                <NumberFieldIncrement />
                              </NumberFieldGroup>
                            </NumberField>
                          </Field>
                        )}
                      </form.Field>
                    </div>

                    <form.Field name="tags">
                      {(field) => (
                        <Field>
                          <FieldLabel>
                            {m.admin_proxies_nodes_field_tags()}
                          </FieldLabel>
                          <Input
                            value={field.state.value}
                            onValueChange={(v) => field.handleChange(v)}
                            onBlur={field.handleBlur}
                            placeholder="premium, us"
                          />
                        </Field>
                      )}
                    </form.Field>

                    {/* Protocol select — switching resets settings to that protocol's defaults. */}
                    <form.Field name="protocol">
                      {(field) => (
                        <Field>
                          <FieldLabel>
                            {m.admin_proxies_nodes_field_protocol()}
                          </FieldLabel>
                          <Select
                            value={field.state.value}
                            onValueChange={(v) => {
                              const next = v as NodeProtocol;
                              field.handleChange(next);
                              form.setFieldValue(
                                "settings",
                                settingsDefaults(next),
                              );
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectPopup>
                              {NODE_PROTOCOLS.map((p) => (
                                <SelectItem key={p} value={p}>
                                  {p}
                                </SelectItem>
                              ))}
                            </SelectPopup>
                          </Select>
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
                          <Label>{m.admin_proxies_nodes_field_enabled()}</Label>
                        </div>
                      )}
                    </form.Field>
                  </div>
                </TabsPanel>

                {/* Protocol settings — one tab per section of the sing-box schema. */}
                {sections.map((s) => (
                  <TabsPanel key={s.id} value={s.id} keepMounted>
                    <div className="rounded-xl border bg-card p-4 shadow-xs">
                      {s.node}
                    </div>
                  </TabsPanel>
                ))}
              </Tabs>
            );
          }}
        </form.Subscribe>
      </form>
    </div>
  );
}
