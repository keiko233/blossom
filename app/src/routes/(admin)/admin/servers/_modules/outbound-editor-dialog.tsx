import {
  MANAGEABLE_OUTBOUND_IP_FAMILIES,
  OUTBOUND_GROUP_PROTOCOLS,
  type ManageableOutboundIpFamily,
  type OutboundGroupProtocol,
} from "@blossom/domain/managed-networking";
import { useForm } from "@tanstack/react-form";
import type React from "react";
import { useEffect, useState } from "react";

import type { AnyZod } from "@/components/schema-form/introspect";
import {
  defaultsFromSchema,
  pruneSettings,
} from "@/components/schema-form/schema-defaults";
import { SchemaForm } from "@/components/schema-form/schema-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastManager } from "@/components/ui/toast";
import { useLockFn } from "@/hooks/use-lock-fn";
import type { JsonValue } from "@/orpc/proxy/schema";
import {
  CUSTOM_PROXY_OUTBOUND_PROTOCOLS,
  outboundSettingsSchemaFor,
} from "@/orpc/proxy/sing-box-registry";
import { m } from "@/paraglide/messages";
import {
  saveCustomProxyOutbound,
  saveManagedOutbound,
  saveOutboundGroup,
} from "@/query/networking";
import type {
  NetworkingOutboundView,
  ServerRoutingView,
} from "@/query/networking-read";

import { networkingWriteReasonMessage } from "../../networking/_modules/networking-write-message";
import { useInvalidateNetworking } from "../../networking/_modules/use-networking-workspace";

export type OutboundEditorKind =
  | "direct_profile"
  | "custom_proxy"
  | "outbound_group";

const IP_FAMILY_LABEL: Record<ManageableOutboundIpFamily, () => string> = {
  any: m.admin_servers_outbounds_ip_any,
  ipv4: m.admin_servers_outbounds_ip_ipv4,
  ipv6: m.admin_servers_outbounds_ip_ipv6,
};

function editableKind(
  outbound: NetworkingOutboundView | null | undefined,
  initialKind: OutboundEditorKind,
): OutboundEditorKind {
  if (
    outbound?.kind === "custom_proxy" ||
    outbound?.kind === "outbound_group"
  ) {
    return outbound.kind;
  }
  return outbound ? "direct_profile" : initialKind;
}

function settingsSchema(
  kind: OutboundEditorKind,
  protocol: string,
): AnyZod | null {
  if (kind === "custom_proxy") {
    return outboundSettingsSchemaFor(protocol);
  }
  if (kind === "outbound_group") {
    return outboundSettingsSchemaFor(protocol).omit({ outbounds: true });
  }
  return null;
}

function initialSettings(
  kind: OutboundEditorKind,
  protocol: string,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const schema = settingsSchema(kind, protocol);
  if (!schema) {
    return {};
  }
  const defaults = defaultsFromSchema(schema) as
    | Record<string, unknown>
    | undefined;
  return { ...defaults, ...existing };
}

function outboundWriteReasonMessage(reason: string): string {
  switch (reason) {
    case "invalid_settings":
      return m.admin_servers_outbounds_reason_invalid_settings();
    case "member_not_found":
      return m.admin_servers_outbounds_reason_member_not_found();
    default:
      return networkingWriteReasonMessage(reason);
  }
}

export function OutboundEditorDialog({
  open,
  onOpenChange,
  view,
  outbound,
  initialKind = "direct_profile",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: ServerRoutingView;
  outbound?: NetworkingOutboundView | null;
  initialKind?: OutboundEditorKind;
}): React.ReactElement {
  const invalidate = useInvalidateNetworking();
  const settingsForm = useForm({
    defaultValues: {
      settings: {} as Record<string, unknown>,
    },
  });
  const [kind, setKind] = useState<OutboundEditorKind>(
    editableKind(outbound, initialKind),
  );
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState("");
  const [bindInterface, setBindInterface] = useState("");
  const [ipFamily, setIpFamily] = useState<ManageableOutboundIpFamily>("any");
  const [memberTags, setMemberTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    const nextKind = editableKind(outbound, initialKind);
    const nextProtocol =
      outbound?.protocol ??
      (nextKind === "outbound_group"
        ? OUTBOUND_GROUP_PROTOCOLS[0]
        : CUSTOM_PROXY_OUTBOUND_PROTOCOLS[0]);
    setKind(nextKind);
    setProtocol(nextProtocol ?? "");
    setName(outbound?.name ?? "");
    setBindInterface(outbound?.bindInterface ?? "");
    setIpFamily(
      (outbound?.ipFamily as ManageableOutboundIpFamily | null) ?? "any",
    );
    setMemberTags(outbound?.memberOutboundTags ?? []);
    settingsForm.reset({
      settings: initialSettings(
        nextKind,
        nextProtocol ?? "",
        outbound?.settings as Record<string, unknown> | undefined,
      ),
    });
  }, [open, outbound?.id, initialKind, settingsForm]);

  const schema = settingsSchema(kind, protocol);
  const members = view.outbounds.filter(
    (row) => row.id !== outbound?.id && row.runtimeTag !== outbound?.runtimeTag,
  );

  const selectProtocol = (next: string) => {
    setProtocol(next);
    settingsForm.reset({
      settings: initialSettings(kind, next, undefined),
    });
  };

  const toggleMember = (tag: string, checked: boolean | "indeterminate") => {
    setMemberTags((current) =>
      checked === true
        ? [...current, tag]
        : current.filter((entry) => entry !== tag),
    );
  };

  const prunedSettings = (): Record<string, JsonValue> => {
    if (!schema) return {};
    return (pruneSettings(settingsForm.state.values.settings, schema) ??
      {}) as Record<string, JsonValue>;
  };

  const submit = useLockFn(async () => {
    setError(null);
    if (!name.trim()) {
      setError(m.admin_servers_outbounds_reason_name_required());
      return;
    }

    if (kind === "direct_profile") {
      const result = await saveManagedOutbound({
        data: {
          id: outbound?.id ?? undefined,
          serverId: view.server.id,
          expectedTopologyGeneration: view.topologyGeneration,
          name: name.trim(),
          bindInterface: bindInterface.trim() || undefined,
          ipFamily,
        },
      });
      if (!result.ok) {
        setError(outboundWriteReasonMessage(result.reason));
        return;
      }
      toastManager.add({
        type: "success",
        title: outbound
          ? m.admin_servers_outbounds_toast_updated()
          : m.admin_servers_outbounds_toast_created(),
      });
      await invalidate();
      onOpenChange(false);
      return;
    }

    if (kind === "custom_proxy") {
      const result = await saveCustomProxyOutbound({
        data: {
          id: outbound?.id ?? undefined,
          serverId: view.server.id,
          expectedTopologyGeneration: view.topologyGeneration,
          name: name.trim(),
          protocol,
          settings: prunedSettings(),
        },
      });
      if (!result.ok) {
        setError(outboundWriteReasonMessage(result.reason));
        return;
      }
      toastManager.add({
        type: "success",
        title: outbound
          ? m.admin_servers_outbounds_toast_custom_updated()
          : m.admin_servers_outbounds_toast_custom_created(),
      });
      await invalidate();
      onOpenChange(false);
      return;
    }

    if (memberTags.length === 0) {
      setError(m.admin_servers_outbounds_group_members_required());
      return;
    }
    const groupProtocol = protocol as OutboundGroupProtocol;
    const result = await saveOutboundGroup({
      data: {
        id: outbound?.id ?? undefined,
        serverId: view.server.id,
        expectedTopologyGeneration: view.topologyGeneration,
        name: name.trim(),
        protocol: groupProtocol,
        memberOutboundTags: memberTags,
        settings: prunedSettings(),
      },
    });
    if (!result.ok) {
      setError(outboundWriteReasonMessage(result.reason));
      return;
    }
    toastManager.add({
      type: "success",
      title: outbound
        ? m.admin_servers_outbounds_toast_group_updated()
        : m.admin_servers_outbounds_toast_group_created(),
    });
    await invalidate();
    onOpenChange(false);
  });

  const title =
    kind === "custom_proxy"
      ? m.admin_servers_outbounds_custom_title()
      : kind === "outbound_group"
        ? m.admin_servers_outbounds_group_title()
        : m.admin_servers_outbounds_direct_title();
  const description =
    kind === "custom_proxy"
      ? m.admin_servers_outbounds_custom_description()
      : kind === "outbound_group"
        ? m.admin_servers_outbounds_group_description()
        : m.admin_servers_outbounds_direct_description();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={kind === "direct_profile" ? undefined : "max-w-3xl"}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void submit();
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">
                {kind === "custom_proxy"
                  ? m.admin_servers_outbounds_kind_custom()
                  : kind === "outbound_group"
                    ? m.admin_servers_outbounds_kind_group()
                    : m.admin_servers_outbounds_kind_profile()}
              </Badge>
              {kind === "direct_profile" ? null : (
                <Badge variant="outline">{protocol}</Badge>
              )}
            </div>

            <Field>
              <FieldLabel>{m.admin_servers_outbounds_field_name()}</FieldLabel>
              <Input value={name} onValueChange={setName} maxLength={128} />
            </Field>

            {kind === "direct_profile" ? (
              <>
                <Field>
                  <FieldLabel>
                    {m.admin_servers_outbounds_field_interface()}
                  </FieldLabel>
                  <Input
                    value={bindInterface}
                    onValueChange={setBindInterface}
                    maxLength={128}
                    placeholder="eth0"
                  />
                  <FieldDescription>
                    {m.admin_servers_outbounds_field_interface_hint()}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>
                    {m.admin_servers_outbounds_field_ip()}
                  </FieldLabel>
                  <Select
                    value={ipFamily}
                    onValueChange={(value) =>
                      setIpFamily(value as ManageableOutboundIpFamily)
                    }
                  >
                    <SelectTrigger>
                      <SelectValue>
                        {(value: ManageableOutboundIpFamily) =>
                          IP_FAMILY_LABEL[value]()
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {MANAGEABLE_OUTBOUND_IP_FAMILIES.map((family) => (
                        <SelectItem key={family} value={family}>
                          {IP_FAMILY_LABEL[family]()}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <FieldDescription>
                    {m.admin_servers_outbounds_field_ip_hint()}
                  </FieldDescription>
                </Field>
              </>
            ) : (
              <Field>
                <FieldLabel>
                  {m.admin_servers_outbounds_field_protocol()}
                </FieldLabel>
                <Select
                  value={protocol}
                  onValueChange={(value) => {
                    if (value) selectProtocol(value);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue>{(value: string) => value}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {(kind === "custom_proxy"
                      ? CUSTOM_PROXY_OUTBOUND_PROTOCOLS
                      : OUTBOUND_GROUP_PROTOCOLS
                    ).map((entry) => (
                      <SelectItem key={entry} value={entry}>
                        {entry}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <FieldDescription>
                  {kind === "custom_proxy"
                    ? m.admin_servers_outbounds_custom_protocol_hint()
                    : m.admin_servers_outbounds_group_protocol_hint()}
                </FieldDescription>
              </Field>
            )}

            {kind === "custom_proxy" && outbound ? (
              <p className="text-xs text-muted-foreground">
                {m.admin_servers_outbounds_custom_edit_hint()}
              </p>
            ) : null}

            {kind === "outbound_group" ? (
              <Field>
                <FieldLabel>
                  {m.admin_servers_outbounds_group_members()}
                </FieldLabel>
                <div className="grid gap-2 sm:grid-cols-2">
                  {members.map((member) => (
                    <label
                      key={member.runtimeTag}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Checkbox
                        checked={memberTags.includes(member.runtimeTag)}
                        onCheckedChange={(checked) =>
                          toggleMember(member.runtimeTag, checked)
                        }
                      />
                      <span className="min-w-0 truncate">
                        {member.name}
                        <span className="ms-1 text-muted-foreground">
                          ({member.runtimeTag})
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                <FieldDescription>
                  {protocol === "urltest"
                    ? m.admin_servers_outbounds_group_urltest_hint()
                    : m.admin_servers_outbounds_group_members_hint()}
                </FieldDescription>
              </Field>
            ) : null}

            {kind === "direct_profile" || schema === null ? null : (
              <SchemaForm
                form={settingsForm}
                schema={schema}
                namePrefix="settings"
              />
            )}

            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <DialogFooter variant="bare">
              <DialogClose render={<Button variant="outline" />}>
                {m.admin_networking_action_cancel()}
              </DialogClose>
              <Button type="submit">{m.admin_networking_action_save()}</Button>
            </DialogFooter>
          </form>
        </DialogPanel>
      </DialogContent>
    </Dialog>
  );
}
