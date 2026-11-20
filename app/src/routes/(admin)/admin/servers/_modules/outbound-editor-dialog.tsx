import {
  MANAGEABLE_OUTBOUND_IP_FAMILIES,
  type ManageableOutboundIpFamily,
} from "@blossom/domain/managed-networking";
import type React from "react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
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
import { m } from "@/paraglide/messages";
import { saveManagedOutbound } from "@/query/networking";
import type {
  NetworkingOutboundView,
  ServerRoutingView,
} from "@/query/networking-read";

import { networkingWriteReasonMessage } from "../../networking/_modules/networking-write-message";
import { useInvalidateNetworking } from "../../networking/_modules/use-networking-workspace";

const IP_FAMILY_LABEL: Record<ManageableOutboundIpFamily, () => string> = {
  any: m.admin_servers_outbounds_ip_any,
  ipv4: m.admin_servers_outbounds_ip_ipv4,
  ipv6: m.admin_servers_outbounds_ip_ipv6,
};

export function OutboundEditorDialog({
  open,
  onOpenChange,
  view,
  outbound,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: ServerRoutingView;
  outbound?: NetworkingOutboundView | null;
}): React.ReactElement {
  const invalidate = useInvalidateNetworking();
  const [name, setName] = useState("");
  const [bindInterface, setBindInterface] = useState("");
  const [ipFamily, setIpFamily] = useState<ManageableOutboundIpFamily>("any");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(outbound?.name ?? "");
    setBindInterface(outbound?.bindInterface ?? "");
    setIpFamily(
      (outbound?.ipFamily as ManageableOutboundIpFamily | null) ?? "any",
    );
  }, [open, outbound?.id]);

  const submit = useLockFn(async () => {
    setError(null);
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
      setError(networkingWriteReasonMessage(result.reason));
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
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.admin_servers_outbounds_direct_title()}</DialogTitle>
          <DialogDescription>
            {m.admin_servers_outbounds_direct_description()}
          </DialogDescription>
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
            <Field>
              <FieldLabel>{m.admin_servers_outbounds_field_name()}</FieldLabel>
              <Input value={name} onValueChange={setName} maxLength={128} />
            </Field>
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
              <FieldLabel>{m.admin_servers_outbounds_field_ip()}</FieldLabel>
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
