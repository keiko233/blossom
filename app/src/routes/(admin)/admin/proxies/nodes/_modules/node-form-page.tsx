import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import type React from "react";
import { useEffect } from "react";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { schemaSections } from "@/components/schema-form/schema-form";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
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
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import {
  isNodeRealityEnabled,
  isNodeTlsEnabled,
  MANAGED_CERTIFICATE_TLS_FIELDS,
  NODE_PROTOCOLS,
  type NodeProtocol,
  settingsSchemaFor,
} from "@/orpc/proxy/sing-box-registry";
import { m } from "@/paraglide/messages";
import { CERTIFICATES_QUERY_KEY, listCertificates } from "@/query/certificates";
import type { NodeDetail } from "@/query/nodes";
import { listServers, SERVERS_QUERY_KEY } from "@/query/servers";

import { settingsDefaults, useNodeFormController } from "./use-node-form";

const NODES_LIST = "/admin/proxies/nodes" as const;
const SERVERS_NEW = "/admin/proxies/servers/new" as const;

export interface NodeFormPageProps {
  /** Present when editing; absent for the create page. */
  node?: NodeDetail;
}

export function NodeFormPage({ node }: NodeFormPageProps): React.ReactElement {
  const navigate = useNavigate();
  const isEdit = Boolean(node);

  const goToList = () => void navigate({ to: NODES_LIST });

  const { data: servers, isPending: isServersPending } = useQuery({
    queryKey: SERVERS_QUERY_KEY,
    queryFn: () => listServers(),
  });
  const { data: certificates } = useQuery({
    queryKey: CERTIFICATES_QUERY_KEY,
    queryFn: () => listCertificates(),
  });

  const formController = useNodeFormController({
    node,
    onSuccess: goToList,
  });
  const { form } = formController;
  const serverOptions = servers ?? [];
  const firstServerId = servers?.[0]?.id;

  // The form is created before the server query necessarily resolves. Select
  // the first server once on create, without mutating form state during render.
  useEffect(() => {
    if (!isEdit && !form.store.state.values.serverId && firstServerId) {
      form.setFieldValue("serverId", firstServerId);
    }
  }, [firstServerId, form, isEdit]);

  if (isServersPending) {
    return (
      <div className="flex min-h-40 items-center justify-center p-4">
        <Spinner />
      </div>
    );
  }

  // No servers → cannot create a node; show an explicit CTA and disable save
  // so the user never has to read a generic backend FK error.
  if (!isEdit && serverOptions.length === 0) {
    return (
      <div className="flex flex-col">
        <PageHeader className="sticky top-0 z-10 justify-start gap-3 border-b bg-background/80 px-4 py-3 backdrop-blur">
          <Button
            variant="ghost"
            size="icon"
            aria-label={m.admin_proxies_nodes_form_back()}
            render={<Link to={NODES_LIST} />}
          >
            <ArrowLeftIcon />
          </Button>
          <PageHeaderTitle>
            {m.admin_proxies_nodes_form_create_title()}
          </PageHeaderTitle>
        </PageHeader>
        <div className="p-4">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>
                {m.admin_proxies_nodes_form_no_server_title()}
              </EmptyTitle>
              <EmptyDescription>
                {m.admin_proxies_nodes_form_no_server_description()}
              </EmptyDescription>
            </EmptyHeader>
            <Button render={<Link to={SERVERS_NEW} />}>
              {m.admin_proxies_nodes_form_no_server_action()}
            </Button>
          </Empty>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <PageHeader className="sticky top-0 z-10 gap-3 border-b bg-background/80 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label={m.admin_proxies_nodes_form_back()}
            render={<Link to={NODES_LIST} />}
          >
            <ArrowLeftIcon />
          </Button>
          <PageHeaderTitle>
            {isEdit
              ? m.admin_proxies_nodes_form_edit_title()
              : m.admin_proxies_nodes_form_create_title()}
          </PageHeaderTitle>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" render={<Link to={NODES_LIST} />}>
            {m.admin_proxies_nodes_form_cancel()}
          </Button>
          <form.Subscribe
            selector={(s) => ({
              certificateId: s.values.certificateId,
              isSubmitting: s.isSubmitting,
              serverId: s.values.serverId,
              settings: s.values.settings,
              tlsMode: s.values.tlsMode,
            })}
          >
            {({ certificateId, isSubmitting, serverId, settings, tlsMode }) => (
              <Button
                type="submit"
                form="node-form"
                disabled={
                  !serverId ||
                  (tlsMode === "managed" &&
                    isNodeTlsEnabled(settings) &&
                    !certificateId)
                }
                loading={isSubmitting}
              >
                {m.admin_proxies_nodes_form_save()}
              </Button>
            )}
          </form.Subscribe>
        </div>
      </PageHeader>

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
        <form.Subscribe
          selector={(s) => ({
            certificateId: s.values.certificateId,
            protocol: s.values.protocol,
            tlsMode: s.values.tlsMode,
          })}
        >
          {({ protocol, tlsMode }) => {
            const managedTlsFields = new Set(
              MANAGED_CERTIFICATE_TLS_FIELDS.map(
                (key) => `settings.tls.${key}`,
              ),
            );
            const sections = schemaSections(
              form,
              settingsSchemaFor(protocol),
              "settings",
            );
            const managedSections = schemaSections(
              form,
              settingsSchemaFor(protocol),
              "settings",
              managedTlsFields,
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

                    <form.Field name="serverId">
                      {(field) => (
                        <Field>
                          <FieldLabel>
                            {m.admin_proxies_nodes_field_server()}
                          </FieldLabel>
                          <Select
                            value={field.state.value}
                            onValueChange={(v) => {
                              const nextServerId = v ?? "";
                              if (nextServerId !== field.state.value) {
                                form.setFieldValue("certificateId", "");
                                form.setFieldValue("tlsServerName", "");
                              }
                              field.handleChange(nextServerId);
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue
                                placeholder={m.admin_proxies_nodes_field_server_placeholder()}
                              />
                            </SelectTrigger>
                            <SelectPopup>
                              {serverOptions.length === 0 ? (
                                <div className="px-3 py-2 text-xs text-muted-foreground">
                                  {m.admin_proxies_nodes_field_server_empty()}
                                </div>
                              ) : (
                                serverOptions.map((s) => (
                                  <SelectItem key={s.id} value={s.id}>
                                    <div className="flex flex-col">
                                      <span>{s.name}</span>
                                      <span className="font-mono text-xs text-muted-foreground">
                                        {s.address}
                                      </span>
                                    </div>
                                  </SelectItem>
                                ))
                              )}
                            </SelectPopup>
                          </Select>
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
                              onValueChange={(v) => field.handleChange(v ?? "")}
                              onBlur={field.handleBlur}
                              placeholder={m.admin_proxies_nodes_field_address_placeholder()}
                            />
                            <p className="text-xs text-muted-foreground">
                              {m.admin_proxies_nodes_field_address_helper()}
                            </p>
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
                              if (!v) {
                                return;
                              }
                              const next = v as NodeProtocol;
                              field.handleChange(next);
                              form.setFieldValue(
                                "settings",
                                settingsDefaults(next),
                              );
                              form.setFieldValue("certificateId", "");
                              form.setFieldValue("tlsServerName", "");
                              form.setFieldValue("tlsMode", "manual");
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
                    <div className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-xs">
                      {s.id === "settings.tls" ? (
                        <form.Subscribe
                          selector={(state) => ({
                            serverId: state.values.serverId,
                            settings: state.values.settings,
                          })}
                        >
                          {({ serverId, settings }) => {
                            if (
                              !isNodeTlsEnabled(settings) ||
                              isNodeRealityEnabled(settings)
                            ) {
                              return s.node;
                            }
                            const available = (certificates ?? []).filter(
                              (certificate) =>
                                certificate.servers.some(
                                  (item) => item.serverId === serverId,
                                ),
                            );
                            const managedNode = managedSections.find(
                              (section) => section.id === s.id,
                            )?.node;
                            return (
                              <Tabs
                                value={tlsMode}
                                onValueChange={(value) => {
                                  const mode = value as "managed" | "manual";
                                  form.setFieldValue("tlsMode", mode);
                                  if (mode === "manual") {
                                    form.setFieldValue("certificateId", "");
                                    form.setFieldValue("tlsServerName", "");
                                  }
                                }}
                                className="gap-4"
                              >
                                <TabsList>
                                  <TabsTab value="managed">
                                    {m.admin_proxies_nodes_tls_mode_managed()}
                                  </TabsTab>
                                  <TabsTab value="manual">
                                    {m.admin_proxies_nodes_tls_mode_manual()}
                                  </TabsTab>
                                </TabsList>
                                <TabsPanel value="managed">
                                  <div className="space-y-4">
                                    <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2">
                                      <form.Field name="certificateId">
                                        {(field) => (
                                          <Field>
                                            <FieldLabel>
                                              {m.admin_proxies_nodes_field_certificate()}
                                            </FieldLabel>
                                            <Select
                                              value={field.state.value}
                                              onValueChange={(id) => {
                                                field.handleChange(id ?? "");
                                                const selected = available.find(
                                                  (item) => item.id === id,
                                                );
                                                form.setFieldValue(
                                                  "tlsServerName",
                                                  selected?.domains[0] ?? "",
                                                );
                                              }}
                                            >
                                              <SelectTrigger>
                                                <SelectValue
                                                  placeholder={m.admin_proxies_nodes_field_certificate_placeholder()}
                                                />
                                              </SelectTrigger>
                                              <SelectPopup>
                                                {available.map(
                                                  (certificate) => (
                                                    <SelectItem
                                                      key={certificate.id}
                                                      value={certificate.id}
                                                    >
                                                      {certificate.name} ·{" "}
                                                      {certificate.domains.join(
                                                        ", ",
                                                      )}
                                                    </SelectItem>
                                                  ),
                                                )}
                                              </SelectPopup>
                                            </Select>
                                            <p className="text-xs text-muted-foreground">
                                              {m.admin_proxies_nodes_field_certificate_managed_help()}
                                            </p>
                                          </Field>
                                        )}
                                      </form.Field>
                                      <form.Field name="tlsServerName">
                                        {(field) => (
                                          <Field>
                                            <FieldLabel>
                                              {m.admin_proxies_nodes_field_tls_server_name()}
                                            </FieldLabel>
                                            <Input
                                              value={field.state.value}
                                              disabled={
                                                !form.store.state.values
                                                  .certificateId
                                              }
                                              onValueChange={(value) =>
                                                field.handleChange(value)
                                              }
                                            />
                                          </Field>
                                        )}
                                      </form.Field>
                                    </div>
                                    {managedNode}
                                  </div>
                                </TabsPanel>
                                <TabsPanel value="manual">
                                  <p className="mb-4 text-xs text-muted-foreground">
                                    {m.admin_proxies_nodes_tls_mode_manual_help()}
                                  </p>
                                  {s.node}
                                </TabsPanel>
                              </Tabs>
                            );
                          }}
                        </form.Subscribe>
                      ) : (
                        s.node
                      )}
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
