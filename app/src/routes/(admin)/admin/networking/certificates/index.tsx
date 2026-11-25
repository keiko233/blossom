import { isAgentReachable } from "@blossom/domain/agent-status";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  CopyIcon,
  FileKeyIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useState } from "react";
import { z } from "zod";

import {
  PageContent,
  PageHeader,
  PageHeaderActions,
  PageHeaderTitle,
  SectionHeader,
  SectionTitle,
} from "@/components/app-shell/page-header";
import {
  InspectorSkeleton,
  TableSkeleton,
} from "@/components/app-shell/skeletons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toastManager } from "@/components/ui/toast";
import { useMediaQuery } from "@/hooks/use-media-query";
import { formatDate } from "@/lib/format";
import {
  type CertificateNodeUsage,
  nodesUsingCertificate,
} from "@/lib/node-certificate-context";
import { m } from "@/paraglide/messages";
import {
  activatePendingImportedCertificate,
  CERTIFICATE_CAPABILITY_QUERY_KEY,
  CERTIFICATES_QUERY_KEY,
  continueCertificateDnsChallenge,
  createCertificate,
  importCertificate,
  deleteCertificate,
  discardPendingImportedCertificate,
  getCertificateCapability,
  listCertificates,
  reconcileCertificates,
  renewCertificate,
  replaceImportedCertificate,
} from "@/query/certificates";
import { listNodes, NODES_QUERY_KEY } from "@/query/nodes";
import { listServers, SERVERS_QUERY_KEY } from "@/query/servers";

type CertificateRecord = Awaited<ReturnType<typeof listCertificates>>[number];

export const Route = createFileRoute("/(admin)/admin/networking/certificates/")(
  {
    component: CertificatesPage,
  },
);

function splitDomains(value: string): string[] {
  return value.split(/[,\s]+/).filter(Boolean);
}

function FieldErrors({ errors }: { errors: readonly unknown[] }) {
  const message = errors
    .map((error) =>
      error && typeof error === "object" && "message" in error
        ? String(error.message)
        : typeof error === "string"
          ? error
          : "",
    )
    .filter(Boolean)
    .join(", ");
  return message ? <p className="text-xs text-destructive">{message}</p> : null;
}

function CertificateUsage({ usages }: { usages: CertificateNodeUsage[] }) {
  return (
    <div className="mt-3 space-y-2">
      <p className="text-sm font-medium">
        {m.admin_certificates_usage_title()}
      </p>
      {usages.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {usages.map((usage) => (
            <li key={usage.nodeId} className="flex flex-wrap gap-x-2">
              <Link
                to="/admin/servers/$serverId/inbounds/$nodeId"
                params={{ serverId: usage.serverId, nodeId: usage.nodeId }}
                className="underline underline-offset-4"
              >
                {usage.nodeName}
              </Link>
              <span className="text-muted-foreground">
                {m.admin_certificates_usage_node_server({
                  server: usage.serverName,
                })}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          {m.admin_certificates_usage_none()}
        </p>
      )}
    </div>
  );
}

function exportUrl(
  certificateId: string,
  part: "fullchain" | "private-key",
): string {
  return `/api/admin/certificates/${encodeURIComponent(certificateId)}/export/${part}`;
}

const MAX_FULLCHAIN_BYTES = 1024 * 1024;
const MAX_PRIVATE_KEY_BYTES = 256 * 1024;

function isFile(value: unknown): value is File {
  return typeof File !== "undefined" && value instanceof File;
}

const pemFileSchema = (maximumBytes: number) =>
  z
    .custom<File>(isFile, m.admin_certificates_validation_file_required())
    .refine(
      (file) => file.size <= maximumBytes,
      m.admin_certificates_validation_file_too_large(),
    );

function CertificatesPage() {
  const queryClient = useQueryClient();
  const [issueSheetOpen, setIssueSheetOpen] = useState(false);
  const [importSheetOpen, setImportSheetOpen] = useState(false);
  const [replaceTarget, setReplaceTarget] = useState<string | null>(null);
  const [pendingOperation, setPendingOperation] = useState<string | null>(null);
  const [copyingRecord, setCopyingRecord] = useState<string | null>(null);
  const [issuerServerId, setIssuerServerId] = useState("");
  const [challengeType, setChallengeType] = useState<"dns-01" | "http-01">(
    "dns-01",
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const isWide = useMediaQuery("xl");

  const issueFormSchema = z.object({
    name: z.string().trim().min(1, m.admin_certificates_validation_required()),
    domains: z
      .string()
      .trim()
      .min(1, m.admin_certificates_validation_domain())
      .refine(
        (value) => splitDomains(value).every(isValidIssueDomain),
        m.admin_certificates_validation_domain(),
      ),
    kind: z.enum(["acme", "self_signed"]),
    acmeProvider: z.enum(["letsencrypt", "zerossl"]),
    email: z.union([
      z.literal(""),
      z.email(m.admin_certificates_validation_email()),
    ]),
  });
  type IssueFormValues = z.infer<typeof issueFormSchema>;
  const issueFormDefaultValues: IssueFormValues = {
    name: "",
    domains: "",
    kind: "acme",
    acmeProvider: "letsencrypt",
    email: "",
  };

  const importFormSchema = z.object({
    name: z.string().trim().min(1, m.admin_certificates_validation_required()),
    fullchainFile: pemFileSchema(MAX_FULLCHAIN_BYTES),
    privateKeyFile: pemFileSchema(MAX_PRIVATE_KEY_BYTES),
  });
  type ImportFormValues = {
    name: string;
    fullchainFile: File | null;
    privateKeyFile: File | null;
  };
  const importFormDefaultValues: ImportFormValues = {
    name: "",
    fullchainFile: null,
    privateKeyFile: null,
  };

  const replaceFormSchema = z.object({
    fullchainFile: pemFileSchema(MAX_FULLCHAIN_BYTES),
    privateKeyFile: pemFileSchema(MAX_PRIVATE_KEY_BYTES),
  });
  type ReplaceFormValues = {
    fullchainFile: File | null;
    privateKeyFile: File | null;
  };
  const replaceFormDefaultValues: ReplaceFormValues = {
    fullchainFile: null,
    privateKeyFile: null,
  };

  const { data: certificates = [], isPending: certificatesPending } = useQuery({
    queryKey: CERTIFICATES_QUERY_KEY,
    queryFn: async () => {
      await reconcileCertificates();
      return listCertificates();
    },
    refetchInterval: 15_000,
  });
  // Read-only context for "used by nodes" and agent recency; the certificate
  // list itself stays the source of truth for deployment state.
  const { data: nodes = [] } = useQuery({
    queryKey: NODES_QUERY_KEY,
    queryFn: () => listNodes(),
    refetchInterval: 15_000,
  });
  const { data: servers = [] } = useQuery({
    queryKey: SERVERS_QUERY_KEY,
    queryFn: () => listServers(),
    refetchInterval: 15_000,
  });
  const { data: capability } = useQuery({
    queryKey: CERTIFICATE_CAPABILITY_QUERY_KEY,
    queryFn: () => getCertificateCapability(),
  });
  const capableIssuers = servers.filter(
    (item) => item.enabled && item.agentCapabilities.includes("acme-v1"),
  );
  const issuerNameById = new Map(servers.map((item) => [item.id, item.name]));

  // Heartbeat recency only; unknown servers are not reported as stale.
  const isAgentStale = (serverId: string): boolean => {
    const owner = servers.find((item) => item.id === serverId);
    return owner ? !isAgentReachable(owner) : false;
  };

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: CERTIFICATES_QUERY_KEY });
  const runOperation = async (
    key: string,
    operation: () => Promise<unknown>,
  ) => {
    if (pendingOperation) return;
    setPendingOperation(key);
    try {
      await operation();
      await refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: m.admin_certificates_operation_error({ error: String(error) }),
      });
    } finally {
      setPendingOperation(null);
    }
  };
  const copyRecord = async (key: string, text: string) => {
    if (copyingRecord) return;
    setCopyingRecord(key);
    try {
      await navigator.clipboard.writeText(text);
    } finally {
      setCopyingRecord(null);
    }
  };

  const createMutation = useMutation({
    mutationFn: (values: IssueFormValues) =>
      createCertificate({
        data: {
          name: values.name,
          domains: splitDomains(values.domains),
          kind: values.kind,
          acmeProvider: values.acmeProvider,
          acmeEmail:
            values.kind === "acme" && values.email ? values.email : undefined,
          acmeStaging: false,
          issuerServerId: values.kind === "acme" ? issuerServerId : undefined,
          challengeType,
          selfSignedValidityDays: 365,
          renewalDaysBeforeExpiry: 30,
        },
      }),
    onSuccess: async () => {
      await refresh();
      toastManager.add({
        type: "success",
        title: m.admin_certificates_created(),
      });
    },
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: m.admin_certificates_operation_error({ error: String(error) }),
      }),
  });
  const issueForm = useForm({
    defaultValues: issueFormDefaultValues,
    validators: { onSubmit: issueFormSchema },
    onSubmit: async ({ value }) => {
      try {
        await createMutation.mutateAsync(value);
      } catch {
        return;
      }
      issueForm.reset();
      setIssuerServerId("");
      setChallengeType("dns-01");
      setIssueSheetOpen(false);
    },
  });

  const importMutation = useMutation({
    mutationFn: async (values: ImportFormValues) => {
      if (!values.fullchainFile || !values.privateKeyFile) return;
      return importCertificate({
        data: {
          name: values.name,
          fullchainPem: await values.fullchainFile.text(),
          privateKeyPem: await values.privateKeyFile.text(),
        },
      });
    },
    onSuccess: async () => {
      await refresh();
      toastManager.add({
        type: "success",
        title: m.admin_certificates_imported(),
      });
    },
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: m.admin_certificates_operation_error({ error: String(error) }),
      }),
  });
  const importForm = useForm({
    defaultValues: importFormDefaultValues,
    validators: { onSubmit: importFormSchema },
    onSubmit: async ({ value }) => {
      try {
        await importMutation.mutateAsync(value);
      } catch {
        return;
      }
      importForm.reset();
      setImportSheetOpen(false);
    },
  });

  const replaceMutation = useMutation({
    mutationFn: async (
      values: ReplaceFormValues & { certificateId: string },
    ) => {
      if (!values.fullchainFile || !values.privateKeyFile) return;
      return replaceImportedCertificate({
        data: {
          certificateId: values.certificateId,
          fullchainPem: await values.fullchainFile.text(),
          privateKeyPem: await values.privateKeyFile.text(),
        },
      });
    },
    onSuccess: async () => {
      await refresh();
      toastManager.add({
        type: "success",
        title: m.admin_certificates_replaced(),
      });
    },
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: m.admin_certificates_operation_error({ error: String(error) }),
      }),
  });
  const replaceForm = useForm({
    defaultValues: replaceFormDefaultValues,
    validators: { onSubmit: replaceFormSchema },
    onSubmit: async ({ value }) => {
      if (!replaceTarget) return;
      try {
        await replaceMutation.mutateAsync({
          certificateId: replaceTarget,
          ...value,
        });
      } catch {
        return;
      }
      replaceForm.reset();
      setReplaceTarget(null);
    },
  });

  const kindLabels = {
    acme: m.admin_certificates_kind_acme(),
    self_signed: m.admin_certificates_kind_self_signed(),
    imported: m.admin_certificates_kind_imported(),
  };
  const acmeProviderLabels = {
    letsencrypt: m.admin_certificates_provider_letsencrypt(),
    zerossl: m.admin_certificates_provider_zerossl(),
  };
  const stateLabels = {
    pending: m.admin_certificates_state_pending(),
    issuing: m.admin_certificates_state_issuing(),
    waiting_dns: m.admin_certificates_state_waiting_dns(),
    active: m.admin_certificates_state_active(),
    renewing: m.admin_certificates_state_renewing(),
    error: m.admin_certificates_state_error(),
    expired: m.admin_certificates_state_expired(),
    not_yet_valid: m.admin_certificates_state_not_yet_valid(),
  };
  const deployLabels = {
    pending: m.admin_certificates_deploy_pending(),
    installed: m.admin_certificates_deploy_installed(),
    in_use: m.admin_certificates_deploy_in_use(),
    error: m.admin_certificates_deploy_error(),
  };
  const selected =
    certificates.find((certificate) => certificate.id === selectedId) ?? null;

  return (
    <>
      <PageHeader>
        <PageHeaderTitle>{m.admin_certificates_title()}</PageHeaderTitle>
        <PageHeaderActions>
          <Sheet
            open={issueSheetOpen}
            onOpenChange={(open) => {
              if (createMutation.isPending) return;
              if (open) {
                setIssuerServerId(capableIssuers[0]?.id ?? "");
                setChallengeType("dns-01");
              }
              setIssueSheetOpen(open);
              if (!open) issueForm.reset();
            }}
          >
            <SheetTrigger render={<Button size="sm" variant="outline" />}>
              <PlusIcon />
              {m.admin_certificates_create_title()}
            </SheetTrigger>
            <SheetContent variant="inset">
              <SheetHeader>
                <SheetTitle>{m.admin_certificates_create_title()}</SheetTitle>
                <SheetDescription>
                  {m.admin_certificates_create_description()}
                </SheetDescription>
              </SheetHeader>
              <form
                className="flex min-h-0 flex-1 flex-col"
                onSubmit={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void issueForm.handleSubmit();
                }}
              >
                <SheetPanel className="space-y-4">
                  <issueForm.Field name="name">
                    {(field) => (
                      <div>
                        <Input
                          value={field.state.value}
                          onValueChange={field.handleChange}
                          onBlur={field.handleBlur}
                          placeholder={m.admin_certificates_name_placeholder()}
                        />
                        <FieldErrors errors={field.state.meta.errors} />
                      </div>
                    )}
                  </issueForm.Field>
                  <issueForm.Field name="domains">
                    {(field) => (
                      <div>
                        <Input
                          value={field.state.value}
                          onValueChange={field.handleChange}
                          onBlur={field.handleBlur}
                          placeholder={m.admin_certificates_domains_placeholder()}
                        />
                        <FieldErrors errors={field.state.meta.errors} />
                      </div>
                    )}
                  </issueForm.Field>
                  <issueForm.Field name="kind">
                    {(field) => (
                      <Select
                        items={{
                          acme: kindLabels.acme,
                          self_signed: kindLabels.self_signed,
                        }}
                        value={field.state.value}
                        onValueChange={(value) =>
                          value &&
                          field.handleChange(value as IssueFormValues["kind"])
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopup>
                          <SelectItem value="acme">
                            {kindLabels.acme}
                          </SelectItem>
                          <SelectItem value="self_signed">
                            {kindLabels.self_signed}
                          </SelectItem>
                        </SelectPopup>
                      </Select>
                    )}
                  </issueForm.Field>
                  <issueForm.Subscribe selector={(state) => state.values.kind}>
                    {(kind) =>
                      kind === "acme" ? (
                        <>
                          <issueForm.Field name="acmeProvider">
                            {(field) => (
                              <Select
                                items={acmeProviderLabels}
                                value={field.state.value}
                                onValueChange={(value) =>
                                  value &&
                                  field.handleChange(
                                    value as IssueFormValues["acmeProvider"],
                                  )
                                }
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectPopup>
                                  <SelectItem value="letsencrypt">
                                    {acmeProviderLabels.letsencrypt}
                                  </SelectItem>
                                  <SelectItem value="zerossl">
                                    {acmeProviderLabels.zerossl}
                                  </SelectItem>
                                </SelectPopup>
                              </Select>
                            )}
                          </issueForm.Field>
                          <issueForm.Subscribe
                            selector={(state) => state.values.acmeProvider}
                          >
                            {(provider) =>
                              provider === "zerossl" ? (
                                <p
                                  className={
                                    capability?.acmeProviders.zerossl.available
                                      ? "rounded-lg border bg-muted/32 p-3 text-xs text-muted-foreground"
                                      : "rounded-lg border border-warning/32 bg-warning/8 p-3 text-xs"
                                  }
                                >
                                  {capability?.acmeProviders.zerossl.available
                                    ? m.admin_certificates_zerossl_env_configured_notice()
                                    : capability?.acmeProviders.zerossl
                                          .incomplete
                                      ? m.admin_certificates_zerossl_env_incomplete_notice()
                                      : m.admin_certificates_zerossl_env_missing_notice()}
                                </p>
                              ) : null
                            }
                          </issueForm.Subscribe>
                          <div>
                            <label className="mb-1 block text-sm font-medium">
                              {m.admin_certificates_issuer_label()}
                            </label>
                            <Select
                              items={capableIssuers.map((issuer) => ({
                                label: issuer.name,
                                value: issuer.id,
                              }))}
                              value={issuerServerId}
                              onValueChange={(value) =>
                                value && setIssuerServerId(value)
                              }
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectPopup>
                                {capableIssuers.map((issuer) => (
                                  <SelectItem key={issuer.id} value={issuer.id}>
                                    {issuer.name}
                                  </SelectItem>
                                ))}
                              </SelectPopup>
                            </Select>
                            {capableIssuers.length === 0 ? (
                              <p className="mt-1 text-xs text-destructive">
                                {m.admin_certificates_issuer_missing()}
                              </p>
                            ) : null}
                          </div>
                          <div>
                            <label className="mb-1 block text-sm font-medium">
                              {m.admin_certificates_challenge_type_label()}
                            </label>
                            <Select
                              items={{
                                "dns-01": m.admin_certificates_challenge_dns(),
                                "http-01":
                                  m.admin_certificates_challenge_http(),
                              }}
                              value={challengeType}
                              onValueChange={(value) =>
                                value &&
                                setChallengeType(value as "dns-01" | "http-01")
                              }
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectPopup>
                                <SelectItem value="dns-01">
                                  {m.admin_certificates_challenge_dns()}
                                </SelectItem>
                                <SelectItem value="http-01">
                                  {m.admin_certificates_challenge_http()}
                                </SelectItem>
                              </SelectPopup>
                            </Select>
                          </div>
                          <issueForm.Field name="email">
                            {(field) => (
                              <div>
                                <Input
                                  type="email"
                                  value={field.state.value}
                                  onValueChange={field.handleChange}
                                  onBlur={field.handleBlur}
                                  placeholder={m.admin_certificates_email_placeholder()}
                                />
                                <FieldErrors errors={field.state.meta.errors} />
                              </div>
                            )}
                          </issueForm.Field>
                          <p className="rounded-lg border bg-muted/32 p-3 text-xs text-muted-foreground">
                            {challengeType === "http-01"
                              ? m.admin_certificates_http_notice()
                              : capability?.automatic
                                ? m.admin_certificates_dns_automatic_notice()
                                : m.admin_certificates_dns_manual_notice()}
                          </p>
                        </>
                      ) : null
                    }
                  </issueForm.Subscribe>
                </SheetPanel>
                <SheetFooter>
                  <SheetClose
                    disabled={createMutation.isPending}
                    render={<Button type="button" variant="outline" />}
                  >
                    {m.admin_certificates_cancel()}
                  </SheetClose>
                  <issueForm.Subscribe
                    selector={(state) => ({
                      acmeProvider: state.values.acmeProvider,
                      domains: state.values.domains,
                      isSubmitting: state.isSubmitting,
                      kind: state.values.kind,
                      name: state.values.name,
                    })}
                  >
                    {({ acmeProvider, domains, isSubmitting, kind, name }) => (
                      <Button
                        type="submit"
                        disabled={
                          !name ||
                          !domains ||
                          (kind === "acme" &&
                            (!issuerServerId || capableIssuers.length === 0)) ||
                          (kind === "acme" &&
                            acmeProvider === "zerossl" &&
                            capability?.acmeProviders.zerossl.available ===
                              false)
                        }
                        loading={isSubmitting}
                      >
                        {m.admin_certificates_create()}
                      </Button>
                    )}
                  </issueForm.Subscribe>
                </SheetFooter>
              </form>
            </SheetContent>
          </Sheet>

          <Sheet
            open={importSheetOpen}
            onOpenChange={(open) => {
              if (importMutation.isPending) return;
              setImportSheetOpen(open);
              if (!open) importForm.reset();
            }}
          >
            <SheetTrigger render={<Button size="sm" />}>
              <UploadIcon />
              {m.admin_certificates_import_title()}
            </SheetTrigger>
            <SheetContent variant="inset">
              <SheetHeader>
                <SheetTitle>{m.admin_certificates_import_title()}</SheetTitle>
                <SheetDescription>
                  {m.admin_certificates_import_description()}
                </SheetDescription>
              </SheetHeader>
              <form
                className="flex min-h-0 flex-1 flex-col"
                onSubmit={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void importForm.handleSubmit();
                }}
              >
                <SheetPanel className="space-y-4">
                  <importForm.Field name="name">
                    {(field) => (
                      <div>
                        <Input
                          value={field.state.value}
                          onValueChange={field.handleChange}
                          onBlur={field.handleBlur}
                          placeholder={m.admin_certificates_name_placeholder()}
                        />
                        <FieldErrors errors={field.state.meta.errors} />
                      </div>
                    )}
                  </importForm.Field>
                  <importForm.Field name="fullchainFile">
                    {(field) => (
                      <div>
                        <label className="mb-1 block text-sm font-medium">
                          {m.admin_certificates_fullchain_file()}
                        </label>
                        <Input
                          nativeInput
                          type="file"
                          accept=".pem,application/x-pem-file,text/plain"
                          onChange={(event) =>
                            field.handleChange(
                              event.currentTarget.files?.[0] ?? null,
                            )
                          }
                          onBlur={field.handleBlur}
                        />
                        <FieldErrors errors={field.state.meta.errors} />
                      </div>
                    )}
                  </importForm.Field>
                  <importForm.Field name="privateKeyFile">
                    {(field) => (
                      <div>
                        <label className="mb-1 block text-sm font-medium">
                          {m.admin_certificates_private_key_file()}
                        </label>
                        <Input
                          nativeInput
                          type="file"
                          accept=".pem,application/x-pem-file,text/plain"
                          onChange={(event) =>
                            field.handleChange(
                              event.currentTarget.files?.[0] ?? null,
                            )
                          }
                          onBlur={field.handleBlur}
                        />
                        <FieldErrors errors={field.state.meta.errors} />
                      </div>
                    )}
                  </importForm.Field>
                  <p className="rounded-lg border border-warning/32 bg-warning/8 p-3 text-xs">
                    {m.admin_certificates_import_warning()}
                  </p>
                </SheetPanel>
                <SheetFooter>
                  <SheetClose
                    disabled={importMutation.isPending}
                    render={<Button type="button" variant="outline" />}
                  >
                    {m.admin_certificates_cancel()}
                  </SheetClose>
                  <importForm.Subscribe
                    selector={(state) => ({
                      isSubmitting: state.isSubmitting,
                      name: state.values.name,
                      fullchainFile: state.values.fullchainFile,
                      privateKeyFile: state.values.privateKeyFile,
                    })}
                  >
                    {({
                      isSubmitting,
                      name,
                      fullchainFile,
                      privateKeyFile,
                    }) => (
                      <Button
                        type="submit"
                        disabled={!name || !fullchainFile || !privateKeyFile}
                        loading={isSubmitting}
                      >
                        {m.admin_certificates_import()}
                      </Button>
                    )}
                  </importForm.Subscribe>
                </SheetFooter>
              </form>
            </SheetContent>
          </Sheet>
        </PageHeaderActions>
      </PageHeader>

      <PageContent>
        {capability?.incomplete ? (
          <Alert variant="warning">
            <AlertDescription>
              {m.admin_certificates_dns_incomplete_notice()}
            </AlertDescription>
          </Alert>
        ) : null}

        {certificatesPending ? (
          <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
            <TableSkeleton columns={5} rows={8} />
            <InspectorSkeleton className="hidden xl:flex" />
          </div>
        ) : certificates.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileKeyIcon />
              </EmptyMedia>
              <EmptyTitle>{m.admin_page_certificates_empty()}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
            <Table variant="pane">
              <TableHeader className="top-(--page-header-h)!">
                <TableRow>
                  <TableHead>{m.admin_page_certificates_col_name()}</TableHead>
                  <TableHead className="hidden lg:table-cell">
                    {m.admin_page_certificates_col_domains()}
                  </TableHead>
                  <TableHead>{m.admin_page_certificates_col_state()}</TableHead>
                  <TableHead className="hidden lg:table-cell">
                    {m.admin_page_certificates_col_validity()}
                  </TableHead>
                  <TableHead className="hidden 2xl:table-cell">
                    {m.admin_page_certificates_col_issuer()}
                  </TableHead>
                  <TableHead className="hidden xl:table-cell">
                    {m.admin_page_certificates_col_deployment()}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {certificates.map((certificate) => (
                  <TableRow
                    key={certificate.id}
                    data-state={
                      selectedId === certificate.id ? "selected" : undefined
                    }
                  >
                    <TableCell>
                      <button
                        aria-pressed={selectedId === certificate.id}
                        className="flex min-w-0 flex-col gap-0.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24"
                        onClick={() => setSelectedId(certificate.id)}
                        type="button"
                      >
                        <span className="truncate font-medium">
                          {certificate.name}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {certificate.kind === "acme"
                            ? acmeProviderLabels[certificate.acmeProvider]
                            : kindLabels[certificate.kind]}
                        </span>
                      </button>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <span className="block max-w-64 truncate font-mono text-xs text-muted-foreground">
                        {certificate.domains.join(", ")}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={certificateStateVariant(certificate.state)}
                      >
                        {stateLabels[certificate.state]}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {certificate.notAfter
                          ? formatDate(certificate.notAfter)
                          : "–"}
                      </span>
                    </TableCell>
                    <TableCell className="hidden 2xl:table-cell">
                      <span className="text-xs text-muted-foreground">
                        {certificate.kind === "acme"
                          ? certificate.issuerServerId
                            ? (issuerNameById.get(certificate.issuerServerId) ??
                              certificate.issuerServerId)
                            : m.admin_certificates_issuer_auto()
                          : "–"}
                      </span>
                    </TableCell>
                    <TableCell className="hidden xl:table-cell">
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {certificate.servers.length > 0
                          ? m.admin_page_certificates_server_count({
                              count: certificate.servers.length,
                            })
                          : "–"}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <aside className="hidden min-w-0 xl:block">
              <CertificateInspector
                certificate={selected}
                nodes={nodes}
                copyingRecord={copyingRecord}
                pendingOperation={pendingOperation}
                stateLabels={stateLabels}
                deployLabels={deployLabels}
                issuerNameById={issuerNameById}
                isAgentStale={isAgentStale}
                onCopyRecord={copyRecord}
                onDelete={(certificateId) =>
                  void runOperation(`delete:${certificateId}`, () =>
                    deleteCertificate({ data: { id: certificateId } }),
                  )
                }
                onRenew={(certificateId) =>
                  void runOperation(`renew:${certificateId}`, () =>
                    renewCertificate({ data: { id: certificateId } }),
                  )
                }
                onReplace={(certificateId) => {
                  replaceForm.reset();
                  setReplaceTarget(certificateId);
                }}
                onActivate={(certificateId) => {
                  if (
                    !window.confirm(
                      m.admin_certificates_pending_activation_confirm(),
                    )
                  ) {
                    return;
                  }
                  void runOperation(`activate:${certificateId}`, () =>
                    activatePendingImportedCertificate({
                      data: { certificateId },
                    }),
                  );
                }}
                onDiscard={(certificateId) =>
                  void runOperation(`discard:${certificateId}`, () =>
                    discardPendingImportedCertificate({
                      data: { certificateId },
                    }),
                  )
                }
                onContinueDns={(certificateId) =>
                  void runOperation(`continue-dns:${certificateId}`, () =>
                    continueCertificateDnsChallenge({
                      data: { id: certificateId },
                    }),
                  )
                }
              />
            </aside>
          </div>
        )}
      </PageContent>

      <Sheet
        open={!isWide && selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <SheetContent className="max-w-2xl">
          <SheetHeader>
            <SheetTitle>{m.admin_page_certificates_details()}</SheetTitle>
            <SheetDescription>
              {m.admin_page_certificates_select_prompt()}
            </SheetDescription>
          </SheetHeader>
          <SheetPanel>
            <CertificateInspector
              embedded
              certificate={selected}
              nodes={nodes}
              copyingRecord={copyingRecord}
              pendingOperation={pendingOperation}
              stateLabels={stateLabels}
              deployLabels={deployLabels}
              issuerNameById={issuerNameById}
              isAgentStale={isAgentStale}
              onCopyRecord={copyRecord}
              onDelete={(certificateId) => {
                setSelectedId(null);
                void runOperation(`delete:${certificateId}`, () =>
                  deleteCertificate({ data: { id: certificateId } }),
                );
              }}
              onRenew={(certificateId) =>
                void runOperation(`renew:${certificateId}`, () =>
                  renewCertificate({ data: { id: certificateId } }),
                )
              }
              onReplace={(certificateId) => {
                replaceForm.reset();
                setReplaceTarget(certificateId);
              }}
              onActivate={(certificateId) => {
                if (
                  !window.confirm(
                    m.admin_certificates_pending_activation_confirm(),
                  )
                ) {
                  return;
                }
                void runOperation(`activate:${certificateId}`, () =>
                  activatePendingImportedCertificate({
                    data: { certificateId },
                  }),
                );
              }}
              onDiscard={(certificateId) =>
                void runOperation(`discard:${certificateId}`, () =>
                  discardPendingImportedCertificate({
                    data: { certificateId },
                  }),
                )
              }
              onContinueDns={(certificateId) =>
                void runOperation(`continue-dns:${certificateId}`, () =>
                  continueCertificateDnsChallenge({
                    data: { id: certificateId },
                  }),
                )
              }
            />
          </SheetPanel>
        </SheetContent>
      </Sheet>

      <Sheet
        open={replaceTarget !== null}
        onOpenChange={(open) => {
          if (replaceMutation.isPending) return;
          if (!open) {
            replaceForm.reset();
            setReplaceTarget(null);
          }
        }}
      >
        <SheetContent variant="inset">
          <SheetHeader>
            <SheetTitle>{m.admin_certificates_replace_title()}</SheetTitle>
            <SheetDescription>
              {m.admin_certificates_replace_description()}
            </SheetDescription>
          </SheetHeader>
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void replaceForm.handleSubmit();
            }}
          >
            <SheetPanel className="space-y-4">
              <replaceForm.Field name="fullchainFile">
                {(field) => (
                  <div>
                    <label className="mb-1 block text-sm font-medium">
                      {m.admin_certificates_fullchain_file()}
                    </label>
                    <Input
                      nativeInput
                      type="file"
                      accept=".pem,application/x-pem-file,text/plain"
                      onChange={(event) =>
                        field.handleChange(
                          event.currentTarget.files?.[0] ?? null,
                        )
                      }
                      onBlur={field.handleBlur}
                    />
                    <FieldErrors errors={field.state.meta.errors} />
                  </div>
                )}
              </replaceForm.Field>
              <replaceForm.Field name="privateKeyFile">
                {(field) => (
                  <div>
                    <label className="mb-1 block text-sm font-medium">
                      {m.admin_certificates_private_key_file()}
                    </label>
                    <Input
                      nativeInput
                      type="file"
                      accept=".pem,application/x-pem-file,text/plain"
                      onChange={(event) =>
                        field.handleChange(
                          event.currentTarget.files?.[0] ?? null,
                        )
                      }
                      onBlur={field.handleBlur}
                    />
                    <FieldErrors errors={field.state.meta.errors} />
                  </div>
                )}
              </replaceForm.Field>
              <p className="rounded-lg border border-warning/32 bg-warning/8 p-3 text-xs">
                {m.admin_certificates_replace_warning()}
              </p>
            </SheetPanel>
            <SheetFooter>
              <SheetClose
                disabled={replaceMutation.isPending}
                render={<Button type="button" variant="outline" />}
              >
                {m.admin_certificates_cancel()}
              </SheetClose>
              <replaceForm.Subscribe
                selector={(state) => ({
                  isSubmitting: state.isSubmitting,
                  fullchainFile: state.values.fullchainFile,
                  privateKeyFile: state.values.privateKeyFile,
                })}
              >
                {({ isSubmitting, fullchainFile, privateKeyFile }) => (
                  <Button
                    type="submit"
                    disabled={!fullchainFile || !privateKeyFile}
                    loading={isSubmitting}
                  >
                    {m.admin_certificates_replace()}
                  </Button>
                )}
              </replaceForm.Subscribe>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}

function CertificateInspector({
  certificate,
  nodes,
  copyingRecord,
  pendingOperation,
  stateLabels,
  deployLabels,
  issuerNameById,
  isAgentStale,
  embedded = false,
  onCopyRecord,
  onDelete,
  onRenew,
  onReplace,
  onActivate,
  onDiscard,
  onContinueDns,
}: {
  certificate: CertificateRecord | null;
  nodes: Parameters<typeof nodesUsingCertificate>[1];
  copyingRecord: string | null;
  pendingOperation: string | null;
  stateLabels: Record<string, string>;
  deployLabels: Record<string, string>;
  issuerNameById: ReadonlyMap<string, string>;
  isAgentStale: (serverId: string) => boolean;
  embedded?: boolean;
  onCopyRecord: (key: string, text: string) => Promise<void>;
  onDelete: (certificateId: string) => void;
  onRenew: (certificateId: string) => void;
  onReplace: (certificateId: string) => void;
  onActivate: (certificateId: string) => void;
  onDiscard: (certificateId: string) => void;
  onContinueDns: (certificateId: string) => void;
}) {
  if (!certificate) {
    return (
      <section
        className={
          embedded
            ? "flex min-w-0 flex-col gap-4"
            : "sticky top-(--page-header-h) flex min-w-0 flex-col gap-4"
        }
        data-slot="certificate-inspector"
      >
        <SectionHeader className="border-b pb-2">
          <SectionTitle>{m.admin_page_certificates_details()}</SectionTitle>
        </SectionHeader>
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {m.admin_page_certificates_select_prompt()}
        </p>
      </section>
    );
  }

  return (
    <section
      className={
        embedded
          ? "flex min-w-0 flex-col gap-4"
          : "sticky top-(--page-header-h) flex min-w-0 flex-col gap-4"
      }
      data-slot="certificate-inspector"
    >
      <SectionHeader className="border-b pb-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <SectionTitle>{certificate.name}</SectionTitle>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {certificate.domains.join(", ")}
          </span>
        </div>
      </SectionHeader>

      <div className="flex flex-wrap gap-1">
        <Badge variant="outline">
          {certificate.kind === "acme"
            ? m.admin_certificates_issuer_value({
                server:
                  issuerNameById.get(certificate.issuerServerId ?? "") ??
                  m.admin_certificates_issuer_auto(),
              })
            : certificate.kind === "self_signed"
              ? m.admin_certificates_kind_self_signed()
              : m.admin_certificates_kind_imported()}
        </Badge>
        <Badge variant={certificateStateVariant(certificate.state)}>
          {stateLabels[certificate.state]}
        </Badge>
        {certificate.kind === "acme" ? (
          <Badge variant="outline">
            {certificate.challengeType === "http-01"
              ? m.admin_certificates_challenge_http()
              : m.admin_certificates_challenge_dns()}
          </Badge>
        ) : null}
      </div>

      {certificate.fingerprintSha256 ? (
        <p className="font-mono text-xs break-all text-muted-foreground">
          {certificate.fingerprintSha256}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-1">
        {certificate.activeMaterialVersion !== null ? (
          <>
            <Button
              size="sm"
              variant="outline"
              render={
                <a href={exportUrl(certificate.id, "fullchain")} download />
              }
            >
              {m.admin_certificates_download_fullchain()}
            </Button>
            <Button
              size="sm"
              variant="outline"
              render={
                <a href={exportUrl(certificate.id, "private-key")} download />
              }
            >
              {m.admin_certificates_download_private_key()}
            </Button>
            {certificate.kind !== "imported" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pendingOperation !== null}
                loading={pendingOperation === `renew:${certificate.id}`}
                onClick={() => onRenew(certificate.id)}
              >
                {m.admin_certificates_renew()}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onReplace(certificate.id)}
              >
                {m.admin_certificates_replace()}
              </Button>
            )}
          </>
        ) : null}
        {certificate.kind === "imported" &&
        certificate.activeMaterialVersion === null ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onReplace(certificate.id)}
          >
            {m.admin_certificates_replace()}
          </Button>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={m.admin_certificates_delete()}
          disabled={pendingOperation !== null}
          loading={pendingOperation === `delete:${certificate.id}`}
          onClick={() => onDelete(certificate.id)}
        >
          <Trash2Icon />
        </Button>
      </div>

      {certificate.pendingMaterial ? (
        <Alert variant="warning">
          <p className="mb-2 text-sm font-medium">
            {m.admin_certificates_pending_title()}
          </p>
          <p className="font-mono text-xs text-muted-foreground">
            {certificate.pendingMaterial.domains.join(", ")}
          </p>
          <p className="font-mono text-xs text-muted-foreground">
            {certificate.pendingMaterial.fingerprintSha256}
          </p>
          <p className="text-xs text-muted-foreground">
            {m.admin_certificates_pending_validity({
              notBefore: certificate.pendingMaterial.notBefore.toISOString(),
              notAfter: certificate.pendingMaterial.notAfter.toISOString(),
            })}
          </p>
          <p className="mt-1 text-xs font-medium text-warning-foreground">
            {certificate.pendingMaterial.notBefore.getTime() > Date.now()
              ? m.admin_certificates_pending_reason_not_yet_valid()
              : m.admin_certificates_pending_reason_expired()}
          </p>
          <p className="mt-2 text-xs text-destructive">
            {m.admin_certificates_pending_risk_warning()}
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              disabled={pendingOperation !== null}
              loading={pendingOperation === `activate:${certificate.id}`}
              onClick={() => onActivate(certificate.id)}
            >
              {m.admin_certificates_activate()}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pendingOperation !== null}
              loading={pendingOperation === `discard:${certificate.id}`}
              onClick={() => onDiscard(certificate.id)}
            >
              {m.admin_certificates_discard()}
            </Button>
          </div>
        </Alert>
      ) : null}

      {certificate.challenge?.length ? (
        <div className="rounded-lg border p-3">
          <p className="mb-2 text-sm font-medium">
            {m.admin_certificates_dns_records_title()}
          </p>
          {certificate.challenge.map((record) => {
            const copyKey = `${certificate.id}:${record.name}:${record.value}`;
            return (
              <div
                key={`${record.name}:${record.value}`}
                className="mt-2 flex items-start gap-2 rounded-md bg-muted/32 p-2 font-mono text-xs"
              >
                <span className="min-w-0 flex-1 break-all">
                  TXT {record.name} {record.value}
                </span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={copyingRecord !== null}
                  loading={copyingRecord === copyKey}
                  onClick={() =>
                    void onCopyRecord(
                      copyKey,
                      `TXT\t${record.name}\t${record.value}`,
                    )
                  }
                >
                  <CopyIcon />
                </Button>
              </div>
            );
          })}
          {certificate.state === "waiting_dns" ? (
            <Button
              className="mt-3"
              size="sm"
              disabled={pendingOperation !== null}
              loading={pendingOperation === `continue-dns:${certificate.id}`}
              onClick={() => onContinueDns(certificate.id)}
            >
              {m.admin_certificates_continue_dns()}
            </Button>
          ) : null}
        </div>
      ) : null}

      {certificate.lastError ? (
        <p className="text-xs text-destructive">{certificate.lastError}</p>
      ) : null}
      <CertificateUsage usages={nodesUsingCertificate(certificate.id, nodes)} />
      {certificate.servers.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            {m.admin_certificates_deployment_title()}
          </p>
          <p className="text-xs text-muted-foreground">
            {m.admin_certificates_deployment_help()}
          </p>
          {certificate.servers.map((binding) => {
            const deployment = binding.deploymentStatus;
            const variant =
              deployment.status === "error"
                ? "destructive"
                : deployment.status === "in_use"
                  ? "default"
                  : "outline";
            return (
              <div
                key={binding.serverId}
                className="flex items-center gap-2 border-t py-1.5"
              >
                <Link
                  to="/admin/servers/$serverId/overview"
                  params={{ serverId: binding.serverId }}
                  className="min-w-0 flex-1 truncate text-sm underline-offset-4 hover:underline"
                >
                  {binding.server.name}
                </Link>
                {deployment.status !== "in_use" &&
                isAgentStale(binding.serverId) ? (
                  <span className="text-xs text-muted-foreground">
                    {m.admin_certificates_deploy_agent_stale()}
                  </span>
                ) : null}
                <Badge variant={variant}>
                  {deployLabels[deployment.status]}
                </Badge>
                {deployment.status === "error" &&
                (deployment.phase || deployment.message) ? (
                  <span className="min-w-0 flex-1 truncate text-xs text-destructive">
                    {deployment.phase ? `${deployment.phase}: ` : ""}
                    {deployment.message}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function certificateStateVariant(
  state: CertificateRecord["state"],
): "default" | "warning" | "destructive" | "outline" | "success" {
  return state === "error" || state === "expired"
    ? "destructive"
    : state === "active"
      ? "success"
      : state === "waiting_dns" ||
          state === "pending" ||
          state === "not_yet_valid"
        ? "warning"
        : "outline";
}

function isValidIssueDomain(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (
    !/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      normalized,
    )
  ) {
    return false;
  }
  const topLevelDomain = normalized.slice(normalized.lastIndexOf(".") + 1);
  return /[a-z]/.test(topLevelDomain);
}
