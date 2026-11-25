import {
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
import {
  createPeerLink,
  getServerRouting,
  savePeerInbound,
  updatePeerLink,
} from "@/query/networking";
import type {
  NetworkingLinkView,
  NetworkingWorkspaceData,
} from "@/query/networking-read";

import { networkingWriteReasonMessage } from "./networking-write-message";
import { useInvalidateNetworking } from "./use-networking-workspace";

export interface LinkEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: NetworkingWorkspaceData;
  link?: NetworkingLinkView | null;
  defaultSourceServerId?: string;
}

const NETWORK_LABEL: Record<PeerNetwork, () => string> = {
  both: m.admin_networking_network_both,
  tcp: m.admin_networking_network_tcp,
  udp: m.admin_networking_network_udp,
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

export function LinkEditorDialog({
  open,
  onOpenChange,
  workspace,
  link,
  defaultSourceServerId,
}: LinkEditorDialogProps): React.ReactElement {
  const invalidate = useInvalidateNetworking();
  const isEdit = Boolean(link);
  const settingsForm = useForm({
    defaultValues: {
      settings: settingsForPeer(PEER_PROTOCOLS[0]),
    },
  });
  const [sourceServerId, setSourceServerId] = useState("");
  const [destinationInboundId, setDestinationInboundId] = useState("");
  const [name, setName] = useState("");
  const [createInbound, setCreateInbound] = useState(false);
  const [newServerId, setNewServerId] = useState("");
  const [newName, setNewName] = useState("");
  const [protocol, setProtocol] = useState<PeerProtocol>(PEER_PROTOCOLS[0]);
  const [network, setNetwork] = useState<PeerNetwork>(
    peerProtocolCapability(PEER_PROTOCOLS[0]).defaultNetwork,
  );
  const [listenAddress, setListenAddress] = useState("0.0.0.0");
  const [listenPort, setListenPort] = useState("443");
  const [advertisedAddress, setAdvertisedAddress] = useState("");
  const [advertisedPort, setAdvertisedPort] = useState("443");
  const [tlsServerName, setTlsServerName] = useState("");
  const [certificateId, setCertificateId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data: certificates } = useQuery({
    queryKey: [...CERTIFICATES_QUERY_KEY],
    queryFn: () => listCertificates(),
    enabled: open && createInbound && !isEdit,
  });

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (link) {
      setSourceServerId(link.sourceServerId);
      setDestinationInboundId(link.destinationInboundId);
      setName(link.outboundName);
      setCreateInbound(false);
      return;
    }
    setSourceServerId(defaultSourceServerId ?? "");
    setDestinationInboundId("");
    setName("");
    setCreateInbound(false);
    setNewServerId("");
    setNewName("");
    setProtocol(PEER_PROTOCOLS[0]);
    setNetwork(peerProtocolCapability(PEER_PROTOCOLS[0]).defaultNetwork);
    setListenAddress("0.0.0.0");
    setListenPort("443");
    setAdvertisedAddress("");
    setAdvertisedPort("443");
    setTlsServerName("");
    setCertificateId("");
    settingsForm.reset({ settings: settingsForPeer(PEER_PROTOCOLS[0]) });
  }, [open, link?.id, defaultSourceServerId, settingsForm]);

  const destinationInbounds = workspace.peerInbounds.filter(
    (inbound) => inbound.serverId !== sourceServerId,
  );
  const hiddenTlsFields = new Set(
    MANAGED_CERTIFICATE_TLS_FIELDS.map((key) => `settings.tls.${key}`),
  );

  const submit = useLockFn(async () => {
    setError(null);
    if (isEdit && link) {
      const result = await updatePeerLink({
        data: {
          id: link.id,
          name: name.trim(),
          expectedTopologyGeneration: workspace.topologyGeneration,
        },
      });
      if (!result.ok) {
        setError(networkingWriteReasonMessage(result.reason));
        return;
      }
      toastManager.add({
        type: "success",
        title: m.admin_networking_links_toast_updated(),
      });
      await invalidate();
      onOpenChange(false);
      return;
    }

    if (!sourceServerId || !name.trim()) {
      setError(m.admin_networking_links_required());
      return;
    }

    let destinationId = destinationInboundId;
    let generation = workspace.topologyGeneration;

    if (createInbound) {
      if (!newServerId || !newName.trim() || !advertisedAddress.trim()) {
        setError(m.admin_networking_links_required());
        return;
      }
      const currentSettings = settingsForm.state.values.settings;
      const tlsVisible = peerTlsVisible(protocol, currentSettings);
      if (tlsVisible && (!tlsServerName.trim() || !certificateId)) {
        setError(m.admin_networking_links_required());
        return;
      }
      if (newServerId === sourceServerId) {
        setError(m.admin_networking_write_invalid_link());
        return;
      }
      const view = await getServerRouting({ data: { serverId: newServerId } });
      const schema = settingsSchemaFor(protocol);
      const settings = (pruneSettings(
        withoutNodeTlsMaterial(currentSettings),
        schema,
      ) ?? {}) as Record<string, JsonValue>;
      const input = {
        serverId: newServerId,
        expectedTopologyGeneration: view.topologyGeneration,
        name: newName.trim(),
        protocol,
        listenAddress: listenAddress.trim(),
        listenPort: Number(listenPort),
        advertisedAddress: advertisedAddress.trim(),
        advertisedPort: Number(advertisedPort),
        network,
        settings,
        tlsServerName: tlsVisible ? tlsServerName.trim() : null,
        certificateId: tlsVisible ? certificateId : null,
      };
      const saved = await savePeerInboundFromClient(input);
      if (!saved.ok) {
        setError(networkingWriteReasonMessage(saved.reason));
        return;
      }
      destinationId = saved.inboundId;
      generation = saved.generation;
    }

    if (!destinationId) {
      setError(m.admin_networking_links_required());
      return;
    }
    const result = await createPeerLink({
      data: {
        sourceServerId,
        destinationInboundId: destinationId,
        name: name.trim(),
        expectedTopologyGeneration: generation,
      },
    });
    if (!result.ok) {
      setError(networkingWriteReasonMessage(result.reason));
      return;
    }
    toastManager.add({
      type: "success",
      title: m.admin_networking_links_toast_created(),
    });
    await invalidate();
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? m.admin_networking_links_edit_title()
              : m.admin_networking_links_create_title()}
          </DialogTitle>
          <DialogDescription>
            {m.admin_networking_links_editor_description()}
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
            {isEdit ? null : (
              <>
                <Field>
                  <FieldLabel>
                    {m.admin_networking_links_field_source()}
                  </FieldLabel>
                  <Select
                    value={sourceServerId}
                    onValueChange={(value) => {
                      setSourceServerId(value ?? "");
                      setDestinationInboundId("");
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
                    {m.admin_networking_links_field_new_inbound()}
                  </FieldLabel>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={createInbound}
                      onCheckedChange={setCreateInbound}
                      aria-label={m.admin_networking_links_field_new_inbound()}
                    />
                    <span className="text-sm text-muted-foreground">
                      {m.admin_networking_links_new_inbound_hint()}
                    </span>
                  </div>
                </Field>
              </>
            )}

            {createInbound && !isEdit ? (
              <>
                <Field>
                  <FieldLabel>
                    {m.admin_networking_links_field_destination_server()}
                  </FieldLabel>
                  <Select
                    value={newServerId}
                    onValueChange={(value) => setNewServerId(value ?? "")}
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
                      {workspace.servers
                        .filter((row) => row.id !== sourceServerId)
                        .map((row) => (
                          <SelectItem key={row.id} value={row.id}>
                            {row.name}
                          </SelectItem>
                        ))}
                    </SelectPopup>
                  </Select>
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field>
                    <FieldLabel>
                      {m.admin_networking_links_field_inbound_name()}
                    </FieldLabel>
                    <Input
                      value={newName}
                      onValueChange={setNewName}
                      maxLength={128}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>
                      {m.admin_networking_links_field_protocol()}
                    </FieldLabel>
                    <Select
                      value={protocol}
                      onValueChange={(value) => {
                        if (!value) return;
                        const next = value as PeerProtocol;
                        setProtocol(next);
                        setNetwork(peerProtocolCapability(next).defaultNetwork);
                        setTlsServerName("");
                        setCertificateId("");
                        settingsForm.reset({
                          settings: settingsForPeer(next),
                        });
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
                </div>
                <Field>
                  <FieldLabel>
                    {m.admin_networking_links_field_network()}
                  </FieldLabel>
                  <Select
                    value={network}
                    onValueChange={(value) => setNetwork(value as PeerNetwork)}
                  >
                    <SelectTrigger>
                      <SelectValue>
                        {(value: PeerNetwork) => NETWORK_LABEL[value]()}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {PEER_NETWORKS.map((entry) => (
                        <SelectItem key={entry} value={entry}>
                          {NETWORK_LABEL[entry]()}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <FieldDescription>
                    {m.admin_networking_links_field_network_hint()}
                  </FieldDescription>
                </Field>
                <SchemaForm
                  form={settingsForm}
                  schema={settingsSchemaFor(protocol)}
                  namePrefix="settings"
                  hiddenFields={hiddenTlsFields}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field>
                    <FieldLabel>
                      {m.admin_networking_links_field_listen_address()}
                    </FieldLabel>
                    <Input
                      value={listenAddress}
                      onValueChange={setListenAddress}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>
                      {m.admin_networking_links_field_listen_port()}
                    </FieldLabel>
                    <Input
                      type="number"
                      min={1}
                      max={65_535}
                      value={listenPort}
                      onValueChange={setListenPort}
                    />
                  </Field>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field>
                    <FieldLabel>
                      {m.admin_networking_links_field_advertised_address()}
                    </FieldLabel>
                    <Input
                      value={advertisedAddress}
                      onValueChange={setAdvertisedAddress}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>
                      {m.admin_networking_links_field_advertised_port()}
                    </FieldLabel>
                    <Input
                      type="number"
                      min={1}
                      max={65_535}
                      value={advertisedPort}
                      onValueChange={setAdvertisedPort}
                    />
                  </Field>
                </div>
                <settingsForm.Subscribe
                  selector={(state) => ({
                    settings: state.values.settings,
                  })}
                >
                  {({ settings }) =>
                    peerTlsVisible(protocol, settings) ? (
                      <>
                        <Field>
                          <FieldLabel>
                            {m.admin_networking_links_field_tls_server_name()}
                          </FieldLabel>
                          <Input
                            value={tlsServerName}
                            onValueChange={setTlsServerName}
                          />
                          <FieldDescription>
                            {m.admin_networking_links_field_tls_server_name_hint()}
                          </FieldDescription>
                        </Field>
                        <Field>
                          <FieldLabel>
                            {m.admin_networking_links_field_certificate()}
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
                          {certificates?.length === 0 ? (
                            <FieldDescription>
                              {m.admin_networking_links_no_certificates()}
                            </FieldDescription>
                          ) : null}
                        </Field>
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {m.admin_networking_links_tls_not_required()}
                      </p>
                    )
                  }
                </settingsForm.Subscribe>
              </>
            ) : null}

            {createInbound && !isEdit ? null : (
              <Field>
                <FieldLabel>
                  {isEdit
                    ? m.admin_networking_links_field_name()
                    : m.admin_networking_links_field_destination()}
                </FieldLabel>
                {isEdit ? (
                  <Input value={name} onValueChange={setName} maxLength={128} />
                ) : (
                  <Select
                    value={destinationInboundId}
                    onValueChange={(value) => {
                      setDestinationInboundId(value ?? "");
                      const inbound = workspace.peerInbounds.find(
                        (row) => row.id === value,
                      );
                      if (inbound && !name) setName(`${inbound.name} link`);
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
                )}
              </Field>
            )}

            {createInbound && !isEdit ? (
              <Field>
                <FieldLabel>
                  {m.admin_networking_links_field_outbound_name()}
                </FieldLabel>
                <Input value={name} onValueChange={setName} maxLength={128} />
              </Field>
            ) : null}

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
                {isEdit
                  ? m.admin_networking_action_save()
                  : m.admin_networking_action_create()}
              </Button>
            </DialogFooter>
          </form>
        </DialogPanel>
      </DialogContent>
    </Dialog>
  );
}

// The inline peer-inbound save is kept behind the audited server function so
// this dialog never imports the writer or opens a second write boundary.
async function savePeerInboundFromClient(input: {
  serverId: string;
  expectedTopologyGeneration: number;
  name: string;
  protocol: PeerProtocol;
  listenAddress: string;
  listenPort: number;
  advertisedAddress: string;
  advertisedPort: number;
  network: PeerNetwork;
  settings: Record<string, JsonValue>;
  tlsServerName: string | null;
  certificateId: string | null;
}): Promise<
  | { ok: true; inboundId: string; generation: number }
  | { ok: false; reason: string; message?: string }
> {
  const result = await savePeerInbound({ data: input });
  return result;
}
