import { useQueryClient } from "@tanstack/react-query";
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
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { useLockFn } from "@/hooks/use-lock-fn";
import {
  PORT_FORWARD_NETWORKS,
  type PortForwardNetwork,
} from "@/lib/port-forward-schema";
import { m } from "@/paraglide/messages";
import type { NetworkingWorkspaceData } from "@/query/networking-read";
import {
  PORT_FORWARDS_QUERY_KEY,
  listPortForwards,
  savePortForward,
} from "@/query/port-forwards";

import { networkingWriteReasonMessage } from "./networking-write-message";
import { useInvalidateNetworking } from "./use-networking-workspace";

export type PortForwardRow = Awaited<
  ReturnType<typeof listPortForwards>
>[number];

const NETWORK_LABEL: Record<PortForwardNetwork, () => string> = {
  both: m.admin_networking_network_both,
  tcp: m.admin_networking_network_tcp,
  udp: m.admin_networking_network_udp,
};

function portForwardReasonMessage(reason: string): string {
  switch (reason) {
    case "port_conflict":
      return m.admin_networking_port_forward_reason_port_conflict();
    case "self_forward":
      return m.admin_networking_port_forward_reason_self_forward();
    case "target_not_found":
      return m.admin_networking_port_forward_reason_target_not_found();
    default:
      return networkingWriteReasonMessage(reason);
  }
}

export function PortForwardDialog({
  open,
  onOpenChange,
  workspace,
  forward,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: NetworkingWorkspaceData;
  forward?: PortForwardRow | null;
}): React.ReactElement {
  const invalidate = useInvalidateNetworking();
  const queryClient = useQueryClient();
  const [serverId, setServerId] = useState("");
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [listenAddress, setListenAddress] = useState("::");
  const [listenPort, setListenPort] = useState("8443");
  const [network, setNetwork] = useState<PortForwardNetwork>("both");
  const [targetMode, setTargetMode] = useState<"node" | "external">("node");
  const [targetServerId, setTargetServerId] = useState("");
  const [targetNodeId, setTargetNodeId] = useState("");
  const [targetAddress, setTargetAddress] = useState("");
  const [targetPort, setTargetPort] = useState("443");
  const [outboundTag, setOutboundTag] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setServerId(forward?.serverId ?? "");
    setName(forward?.name ?? "");
    setEnabled(forward?.enabled ?? true);
    setListenAddress(forward?.listenAddress ?? "::");
    setListenPort(String(forward?.listenPort ?? 8443));
    setNetwork(forward?.network ?? "both");
    setTargetMode(forward?.targetNodeId ? "node" : "external");
    const targetNode = forward?.targetNodeId
      ? workspace.nodes.find((row) => row.id === forward.targetNodeId)
      : null;
    setTargetServerId(targetNode?.serverId ?? "");
    setTargetNodeId(forward?.targetNodeId ?? "");
    setTargetAddress(forward?.targetAddress ?? "");
    setTargetPort(String(forward?.targetPort ?? 443));
    setOutboundTag(forward?.outboundTag ?? "");
  }, [open, forward?.id, workspace.nodes]);

  const targetNodes = workspace.nodes.filter(
    (row) => !targetServerId || row.serverId === targetServerId,
  );

  const submit = useLockFn(async () => {
    setError(null);
    if (!serverId || !name.trim()) {
      setError(m.admin_networking_port_forward_required());
      return;
    }
    if (targetMode === "node" && !targetNodeId) {
      setError(m.admin_networking_port_forward_required());
      return;
    }
    if (
      targetMode === "external" &&
      (!targetAddress.trim() || !targetPort.trim())
    ) {
      setError(m.admin_networking_port_forward_required());
      return;
    }

    const result = await savePortForward({
      data: {
        id: forward?.id,
        serverId,
        expectedTopologyGeneration: workspace.topologyGeneration,
        name: name.trim(),
        enabled,
        listenAddress: listenAddress.trim(),
        listenPort: Number(listenPort),
        network,
        targetNodeId: targetMode === "node" ? targetNodeId : undefined,
        targetAddress:
          targetMode === "external" ? targetAddress.trim() : undefined,
        targetPort: targetMode === "external" ? Number(targetPort) : undefined,
        outboundTag: outboundTag.trim() || null,
      },
    });
    if (!result.ok) {
      setError(portForwardReasonMessage(result.reason));
      return;
    }

    toastManager.add({
      type: "success",
      title: forward
        ? m.admin_networking_port_forward_toast_updated()
        : m.admin_networking_port_forward_toast_created(),
    });
    await invalidate();
    await queryClient.invalidateQueries({
      queryKey: PORT_FORWARDS_QUERY_KEY,
    });
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {forward
              ? m.admin_networking_port_forward_edit_title()
              : m.admin_networking_port_forward_create_title()}
          </DialogTitle>
          <DialogDescription>
            {m.admin_networking_port_forward_dialog_description()}
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
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>
                  {m.admin_networking_port_forward_server()}
                </FieldLabel>
                <Select
                  value={serverId}
                  onValueChange={(value) => setServerId(value ?? "")}
                >
                  <SelectTrigger>
                    <SelectValue>
                      {(value: string) =>
                        workspace.servers.find((row) => row.id === value)
                          ?.name ?? m.admin_networking_links_select_server()
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {workspace.servers.map((row) => (
                      <SelectItem key={row.id} value={row.id}>
                        {row.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              <Field>
                <FieldLabel>
                  {m.admin_networking_port_forward_name()}
                </FieldLabel>
                <Input value={name} onValueChange={setName} maxLength={128} />
              </Field>
            </div>

            <Field>
              <FieldLabel>
                {m.admin_networking_port_forward_enabled()}
              </FieldLabel>
              <div className="flex items-center gap-2">
                <Switch
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  aria-label={m.admin_networking_port_forward_enabled()}
                />
                <span className="text-sm text-muted-foreground">
                  {m.admin_networking_port_forward_enabled_hint()}
                </span>
              </div>
            </Field>

            <div className="grid gap-3 sm:grid-cols-3">
              <Field>
                <FieldLabel>
                  {m.admin_networking_port_forward_listen_address()}
                </FieldLabel>
                <Input value={listenAddress} onValueChange={setListenAddress} />
              </Field>
              <Field>
                <FieldLabel>
                  {m.admin_networking_port_forward_listen_port()}
                </FieldLabel>
                <Input
                  type="number"
                  min={1}
                  max={65_535}
                  value={listenPort}
                  onValueChange={setListenPort}
                />
              </Field>
              <Field>
                <FieldLabel>
                  {m.admin_networking_port_forward_network()}
                </FieldLabel>
                <Select
                  value={network}
                  onValueChange={(value) =>
                    setNetwork(value as PortForwardNetwork)
                  }
                >
                  <SelectTrigger>
                    <SelectValue>
                      {(value: PortForwardNetwork) => NETWORK_LABEL[value]()}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {PORT_FORWARD_NETWORKS.map((entry) => (
                      <SelectItem key={entry} value={entry}>
                        {NETWORK_LABEL[entry]()}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            </div>

            <Field>
              <FieldLabel>
                {m.admin_networking_port_forward_target()}
              </FieldLabel>
              <Select
                value={targetMode}
                onValueChange={(value) =>
                  setTargetMode(value === "external" ? "external" : "node")
                }
              >
                <SelectTrigger>
                  <SelectValue>
                    {(value: string) =>
                      value === "external"
                        ? m.admin_networking_port_forward_target_external()
                        : m.admin_networking_port_forward_target_node()
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="node">
                    {m.admin_networking_port_forward_target_node()}
                  </SelectItem>
                  <SelectItem value="external">
                    {m.admin_networking_port_forward_target_external()}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </Field>

            {targetMode === "node" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel>
                    {m.admin_networking_port_forward_target_server()}
                  </FieldLabel>
                  <Select
                    value={targetServerId}
                    onValueChange={(value) => {
                      setTargetServerId(value ?? "");
                      setTargetNodeId("");
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue>
                        {(value: string) =>
                          workspace.servers.find((row) => row.id === value)
                            ?.name ?? m.admin_networking_links_select_server()
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {workspace.servers.map((row) => (
                        <SelectItem key={row.id} value={row.id}>
                          {row.name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel>
                    {m.admin_networking_port_forward_target_node_picker()}
                  </FieldLabel>
                  <Select
                    value={targetNodeId}
                    onValueChange={(value) => setTargetNodeId(value ?? "")}
                  >
                    <SelectTrigger>
                      <SelectValue>
                        {(value: string) =>
                          targetNodes.find((row) => row.id === value)?.name ??
                          m.admin_networking_auto_bridge_select_node()
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {targetNodes.map((row) => (
                        <SelectItem key={row.id} value={row.id}>
                          {row.name} · {row.protocol}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Field>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel>
                    {m.admin_networking_port_forward_target_address()}
                  </FieldLabel>
                  <Input
                    value={targetAddress}
                    onValueChange={setTargetAddress}
                    placeholder="203.0.113.10"
                  />
                </Field>
                <Field>
                  <FieldLabel>
                    {m.admin_networking_port_forward_target_port()}
                  </FieldLabel>
                  <Input
                    type="number"
                    min={1}
                    max={65_535}
                    value={targetPort}
                    onValueChange={setTargetPort}
                  />
                </Field>
              </div>
            )}

            <Field>
              <FieldLabel>
                {m.admin_networking_port_forward_outbound_tag()}
              </FieldLabel>
              <Input
                value={outboundTag}
                onValueChange={setOutboundTag}
                maxLength={128}
              />
              <FieldDescription>
                {m.admin_networking_port_forward_outbound_tag_hint()}
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
