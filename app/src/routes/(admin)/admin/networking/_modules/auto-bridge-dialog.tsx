import {
  isPeerProtocol,
  peerProtocolCapability,
  PEER_NETWORKS,
  PEER_PROTOCOLS,
  type PeerNetwork,
  type PeerProtocol,
} from "@blossom/domain/managed-networking";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import type React from "react";
import { useEffect, useState } from "react";

import {
  defaultsFromSchema,
  pruneSettings,
} from "@/components/schema-form/schema-defaults";
import { SchemaForm } from "@/components/schema-form/schema-form";
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
  AUTO_BRIDGE_MODES,
  type AutoBridgeMode,
} from "@/lib/networking-schema";
import type { JsonValue } from "@/orpc/proxy/schema";
import {
  isNodeRealityEnabled,
  isNodeTlsEnabled,
  MANAGED_CERTIFICATE_TLS_FIELDS,
  settingsSchemaFor,
  withoutNodeTlsMaterial,
} from "@/orpc/proxy/sing-box-registry";
import { m } from "@/paraglide/messages";
import { CERTIFICATES_QUERY_KEY, listCertificates } from "@/query/certificates";
import { autoBridgeServers, saveRouting } from "@/query/networking";
import type { NetworkingWorkspaceData } from "@/query/networking-read";

import { networkingWriteReasonMessage } from "./networking-write-message";
import { useInvalidateNetworking } from "./use-networking-workspace";

const NETWORK_LABEL: Record<PeerNetwork, () => string> = {
  both: m.admin_networking_network_both,
  tcp: m.admin_networking_network_tcp,
  udp: m.admin_networking_network_udp,
};

const MODE_LABEL: Record<AutoBridgeMode, () => string> = {
  auto_create_peer: m.admin_networking_auto_bridge_mode_auto_create,
  reuse_peer_inbound: m.admin_networking_auto_bridge_mode_reuse,
  bridge_existing_node: m.admin_networking_auto_bridge_mode_bridge_node,
};

function settingsForPeer(protocol: PeerProtocol): Record<string, unknown> {
  return (defaultsFromSchema(settingsSchemaFor(protocol)) ?? {}) as Record<
    string,
    unknown
  >;
}

function peerTlsVisible(
  protocol: PeerProtocol,
  settings: Record<string, unknown>,
): boolean {
  if (isNodeRealityEnabled(settings)) return false;
  const capability = peerProtocolCapability(protocol);
  return (
    capability.tlsMode === "required" ||
    (capability.tlsMode === "optional" && isNodeTlsEnabled(settings))
  );
}

function autoBridgeReasonMessage(reason: string): string {
  switch (reason) {
    case "invalid_settings":
      return m.admin_networking_write_invalid_settings();
    case "port_exhausted":
      return m.admin_networking_write_port_exhausted();
    default:
      return networkingWriteReasonMessage(reason);
  }
}

export function AutoBridgeDialog({
  open,
  onOpenChange,
  workspace,
  defaultSourceServerId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: NetworkingWorkspaceData;
  defaultSourceServerId?: string;
}): React.ReactElement {
  const invalidate = useInvalidateNetworking();
  const settingsForm = useForm({
    defaultValues: {
      settings: settingsForPeer(PEER_PROTOCOLS[0]),
    },
  });
  const [sourceServerId, setSourceServerId] = useState("");
  const [destinationServerId, setDestinationServerId] = useState("");
  const [mode, setMode] = useState<AutoBridgeMode>("auto_create_peer");
  const [protocol, setProtocol] = useState<PeerProtocol>(PEER_PROTOCOLS[0]);
  const [network, setNetwork] = useState<PeerNetwork | "default">("default");
  const [existingPeerInboundId, setExistingPeerInboundId] = useState("");
  const [existingNodeId, setExistingNodeId] = useState("");
  const [certificateId, setCertificateId] = useState("");
  const [fullForward, setFullForward] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: certificates } = useQuery({
    queryKey: [...CERTIFICATES_QUERY_KEY],
    queryFn: () => listCertificates(),
    enabled: open && mode === "auto_create_peer",
  });

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSourceServerId(defaultSourceServerId ?? "");
    setDestinationServerId("");
    setMode("auto_create_peer");
    setProtocol(PEER_PROTOCOLS[0]);
    setNetwork("default");
    setExistingPeerInboundId("");
    setExistingNodeId("");
    setCertificateId("");
    setFullForward(false);
    settingsForm.reset({ settings: settingsForPeer(PEER_PROTOCOLS[0]) });
  }, [open, defaultSourceServerId, settingsForm]);

  const destinationServers = workspace.servers.filter(
    (row) => row.id !== sourceServerId,
  );
  const destinationInbounds = workspace.peerInbounds.filter(
    (row) => row.serverId === destinationServerId,
  );
  const destinationNodes = workspace.nodes.filter(
    (row) =>
      row.serverId === destinationServerId && isPeerProtocol(row.protocol),
  );
  const hiddenTlsFields = new Set(
    MANAGED_CERTIFICATE_TLS_FIELDS.map((key) => `settings.tls.${key}`),
  );

  const selectedInbound = destinationInbounds.find(
    (row) => row.id === existingPeerInboundId,
  );
  const selectedNode = destinationNodes.find(
    (row) => row.id === existingNodeId,
  );
  const effectiveProtocol: PeerProtocol =
    mode === "reuse_peer_inbound"
      ? (selectedInbound?.protocol ?? protocol)
      : mode === "bridge_existing_node"
        ? ((selectedNode?.protocol as PeerProtocol | undefined) ?? protocol)
        : protocol;

  const selectProtocol = (next: PeerProtocol) => {
    setProtocol(next);
    setCertificateId("");
    settingsForm.reset({ settings: settingsForPeer(next) });
  };

  const submit = useLockFn(async () => {
    setError(null);
    if (!sourceServerId || !destinationServerId) {
      setError(m.admin_networking_auto_bridge_required());
      return;
    }
    if (mode === "reuse_peer_inbound" && !existingPeerInboundId) {
      setError(m.admin_networking_auto_bridge_required());
      return;
    }
    if (mode === "bridge_existing_node" && !existingNodeId) {
      setError(m.admin_networking_auto_bridge_required());
      return;
    }

    const currentSettings = settingsForm.state.values.settings;
    const settings = (pruneSettings(
      withoutNodeTlsMaterial(currentSettings),
      settingsSchemaFor(effectiveProtocol),
    ) ?? {}) as Record<string, JsonValue>;
    const result = await autoBridgeServers({
      data: {
        sourceServerId,
        destinationServerId,
        expectedTopologyGeneration: workspace.topologyGeneration,
        protocol: effectiveProtocol,
        mode,
        settings: mode === "auto_create_peer" ? settings : undefined,
        network:
          mode === "auto_create_peer" && network !== "default"
            ? network
            : undefined,
        existingPeerInboundId:
          mode === "reuse_peer_inbound" ? existingPeerInboundId : undefined,
        existingNodeId:
          mode === "bridge_existing_node" ? existingNodeId : undefined,
        certificateId:
          mode === "auto_create_peer" && certificateId
            ? certificateId
            : undefined,
        fullForward,
      },
    });
    if (!result.ok) {
      setError(autoBridgeReasonMessage(result.reason));
      return;
    }

    toastManager.add({
      type: "success",
      title: m.admin_networking_auto_bridge_toast_created(),
    });

    if (fullForward && result.fullForward) {
      const routing = await saveRouting({
        data: {
          serverId: sourceServerId,
          expectedTopologyGeneration: result.generation,
          rules: result.fullForward.rules,
          finalOutboundTag: result.fullForward.finalOutboundTag,
        },
      });
      toastManager.add(
        routing.ok
          ? {
              type: "success",
              title: m.admin_networking_auto_bridge_toast_full_forward(),
            }
          : {
              type: "warning",
              title: m.admin_networking_auto_bridge_full_forward_failed(),
            },
      );
    }

    await invalidate();
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{m.admin_networking_auto_bridge_title()}</DialogTitle>
          <DialogDescription>
            {m.admin_networking_auto_bridge_description()}
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
                  {m.admin_networking_auto_bridge_source()}
                </FieldLabel>
                <Select
                  value={sourceServerId}
                  onValueChange={(value) => {
                    setSourceServerId(value ?? "");
                    setDestinationServerId("");
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
                  {m.admin_networking_auto_bridge_destination()}
                </FieldLabel>
                <Select
                  value={destinationServerId}
                  onValueChange={(value) => {
                    setDestinationServerId(value ?? "");
                    setExistingPeerInboundId("");
                    setExistingNodeId("");
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
                    {destinationServers.map((row) => (
                      <SelectItem key={row.id} value={row.id}>
                        {row.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            </div>

            <Field>
              <FieldLabel>{m.admin_networking_auto_bridge_mode()}</FieldLabel>
              <Select
                value={mode}
                onValueChange={(value) => {
                  if (!value) return;
                  const next = value as AutoBridgeMode;
                  setMode(next);
                  setExistingPeerInboundId("");
                  setExistingNodeId("");
                  if (next === "auto_create_peer") {
                    settingsForm.reset({
                      settings: settingsForPeer(protocol),
                    });
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue>
                    {(value: AutoBridgeMode) => MODE_LABEL[value]()}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {AUTO_BRIDGE_MODES.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {MODE_LABEL[entry]()}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <FieldDescription>
                {m.admin_networking_auto_bridge_mode_hint()}
              </FieldDescription>
            </Field>

            {mode === "reuse_peer_inbound" ? (
              <Field>
                <FieldLabel>
                  {m.admin_networking_auto_bridge_existing_inbound()}
                </FieldLabel>
                <Select
                  value={existingPeerInboundId}
                  onValueChange={(value) => {
                    setExistingPeerInboundId(value ?? "");
                    const inbound = workspace.peerInbounds.find(
                      (row) => row.id === value,
                    );
                    if (inbound) {
                      setProtocol(inbound.protocol);
                      settingsForm.reset({
                        settings: settingsForPeer(inbound.protocol),
                      });
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue>
                      {(value: string) =>
                        destinationInbounds.find((row) => row.id === value)
                          ?.name ?? m.admin_networking_links_select_inbound()
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {destinationInbounds.map((row) => (
                      <SelectItem key={row.id} value={row.id}>
                        {row.name} · {row.protocol}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {destinationInbounds.length === 0 ? (
                  <FieldDescription>
                    {m.admin_networking_auto_bridge_no_inbounds()}
                  </FieldDescription>
                ) : null}
              </Field>
            ) : null}

            {mode === "bridge_existing_node" ? (
              <Field>
                <FieldLabel>
                  {m.admin_networking_auto_bridge_existing_node()}
                </FieldLabel>
                <Select
                  value={existingNodeId}
                  onValueChange={(value) => {
                    setExistingNodeId(value ?? "");
                    const node = destinationNodes.find(
                      (row) => row.id === value,
                    );
                    if (node) {
                      const next = node.protocol as PeerProtocol;
                      setProtocol(next);
                      settingsForm.reset({
                        settings: settingsForPeer(next),
                      });
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue>
                      {(value: string) =>
                        destinationNodes.find((row) => row.id === value)
                          ?.name ?? m.admin_networking_auto_bridge_select_node()
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {destinationNodes.map((row) => (
                      <SelectItem key={row.id} value={row.id}>
                        {row.name} · {row.protocol}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {destinationNodes.length === 0 ? (
                  <FieldDescription>
                    {m.admin_networking_auto_bridge_no_nodes()}
                  </FieldDescription>
                ) : null}
              </Field>
            ) : null}

            {mode === "auto_create_peer" ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field>
                    <FieldLabel>
                      {m.admin_networking_auto_bridge_protocol()}
                    </FieldLabel>
                    <Select
                      value={protocol}
                      onValueChange={(value) => {
                        if (value) selectProtocol(value as PeerProtocol);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue>{(value: string) => value}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {PEER_PROTOCOLS.map((entry) => (
                          <SelectItem key={entry} value={entry}>
                            {entry}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel>
                      {m.admin_networking_auto_bridge_network()}
                    </FieldLabel>
                    <Select
                      value={network}
                      onValueChange={(value) =>
                        setNetwork(
                          (value ?? "default") as PeerNetwork | "default",
                        )
                      }
                    >
                      <SelectTrigger>
                        <SelectValue>
                          {(value: string) =>
                            value === "default"
                              ? m.admin_networking_auto_bridge_network_default()
                              : NETWORK_LABEL[value as PeerNetwork]()
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="default">
                          {m.admin_networking_auto_bridge_network_default()}
                        </SelectItem>
                        {PEER_NETWORKS.map((entry) => (
                          <SelectItem key={entry} value={entry}>
                            {NETWORK_LABEL[entry]()}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                    <FieldDescription>
                      {m.admin_networking_auto_bridge_network_hint()}
                    </FieldDescription>
                  </Field>
                </div>

                <SchemaForm
                  form={settingsForm}
                  schema={settingsSchemaFor(protocol)}
                  namePrefix="settings"
                  hiddenFields={hiddenTlsFields}
                />

                <settingsForm.Subscribe
                  selector={(state) => ({ settings: state.values.settings })}
                >
                  {({ settings }) =>
                    peerTlsVisible(protocol, settings) ? (
                      <Field>
                        <FieldLabel>
                          {m.admin_networking_auto_bridge_certificate()}
                        </FieldLabel>
                        <Select
                          value={certificateId}
                          onValueChange={(value) =>
                            setCertificateId(value ?? "")
                          }
                        >
                          <SelectTrigger>
                            <SelectValue>
                              {(value: string) =>
                                certificates?.find((row) => row.id === value)
                                  ?.name ??
                                m.admin_networking_links_select_certificate()
                              }
                            </SelectValue>
                          </SelectTrigger>
                          <SelectPopup>
                            {(certificates ?? []).map((row) => (
                              <SelectItem key={row.id} value={row.id}>
                                {row.name} · {row.kind}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                        <FieldDescription>
                          {m.admin_networking_auto_bridge_certificate_hint()}
                        </FieldDescription>
                        {certificates?.length === 0 ? (
                          <FieldDescription>
                            {m.admin_networking_links_no_certificates()}
                          </FieldDescription>
                        ) : null}
                      </Field>
                    ) : null
                  }
                </settingsForm.Subscribe>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                {m.admin_networking_auto_bridge_mode_uses_existing()}
              </p>
            )}

            <Field>
              <FieldLabel>
                {m.admin_networking_auto_bridge_full_forward()}
              </FieldLabel>
              <div className="flex items-center gap-2">
                <Switch
                  checked={fullForward}
                  onCheckedChange={setFullForward}
                  aria-label={m.admin_networking_auto_bridge_full_forward()}
                />
                <span className="text-sm text-muted-foreground">
                  {m.admin_networking_auto_bridge_full_forward_hint()}
                </span>
              </div>
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
              <Button type="submit">
                {m.admin_networking_auto_bridge_submit()}
              </Button>
            </DialogFooter>
          </form>
        </DialogPanel>
      </DialogContent>
    </Dialog>
  );
}
