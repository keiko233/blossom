import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  CopyIcon,
  FileKeyIcon,
  LinkIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useState } from "react";
import { z } from "zod";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { toastManager } from "@/components/ui/toast";
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

export const Route = createFileRoute("/(admin)/admin/proxies/certificates/")({
  component: CertificatesPage,
});

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

  const { data: certificates = [] } = useQuery({
    queryKey: CERTIFICATES_QUERY_KEY,
    queryFn: async () => {
      await reconcileCertificates();
      return listCertificates();
    },
    refetchInterval: 15_000,
  });
  const { data: capability } = useQuery({
    queryKey: CERTIFICATE_CAPABILITY_QUERY_KEY,
    queryFn: () => getCertificateCapability(),
  });

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
      await createMutation.mutateAsync(value);
      issueForm.reset();
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
      await importMutation.mutateAsync(value);
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
      await replaceMutation.mutateAsync({
        certificateId: replaceTarget,
        ...value,
      });
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

  return (
    <div className="space-y-6 p-4">
      <PageHeader className="flex-wrap items-start gap-3">
        <PageHeaderTitle className="text-2xl">
          {m.admin_certificates_title()}
        </PageHeaderTitle>
        <div className="flex gap-2">
          <Sheet
            open={issueSheetOpen}
            onOpenChange={(open) => {
              if (createMutation.isPending) return;
              setIssueSheetOpen(open);
              if (!open) issueForm.reset();
            }}
          >
            <SheetTrigger render={<Button variant="outline" />}>
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
                              provider === "letsencrypt" ? (
                                <p className="rounded-lg border border-amber-500/32 bg-amber-500/8 p-3 text-xs">
                                  {m.admin_certificates_letsencrypt_workers_notice()}
                                </p>
                              ) : (
                                <p
                                  className={
                                    capability?.acmeProviders.zerossl.available
                                      ? "rounded-lg border bg-muted/32 p-3 text-xs text-muted-foreground"
                                      : "rounded-lg border border-amber-500/32 bg-amber-500/8 p-3 text-xs"
                                  }
                                >
                                  {capability?.acmeProviders.zerossl.available
                                    ? m.admin_certificates_zerossl_env_configured_notice()
                                    : capability?.acmeProviders.zerossl
                                          .incomplete
                                      ? m.admin_certificates_zerossl_env_incomplete_notice()
                                      : m.admin_certificates_zerossl_env_missing_notice()}
                                </p>
                              )
                            }
                          </issueForm.Subscribe>
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
                            {capability?.automatic
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
            <SheetTrigger render={<Button />}>
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
                  <p className="rounded-lg border border-amber-500/32 bg-amber-500/8 p-3 text-xs">
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
        </div>
      </PageHeader>

      {capability?.incomplete ? (
        <p className="rounded-lg border border-amber-500/32 bg-amber-500/8 p-3 text-sm">
          {m.admin_certificates_dns_incomplete_notice()}
        </p>
      ) : null}

      <section className="space-y-3">
        {certificates.map((certificate) => (
          <article
            key={certificate.id}
            className="rounded-xl border bg-card p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <ShieldCheckIcon className="size-4" />
                  <h2 className="font-medium">{certificate.name}</h2>
                  <Badge variant="outline">
                    {certificate.kind === "acme"
                      ? acmeProviderLabels[certificate.acmeProvider]
                      : kindLabels[certificate.kind]}
                  </Badge>
                  <Badge variant="outline">
                    {stateLabels[certificate.state]}
                  </Badge>
                </div>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {certificate.domains.join(", ")}
                </p>
                {certificate.fingerprintSha256 ? (
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                    {certificate.fingerprintSha256}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-1">
                {certificate.activeMaterialVersion !== null ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      render={
                        <a
                          href={exportUrl(certificate.id, "fullchain")}
                          download
                        />
                      }
                    >
                      <LinkIcon />
                      {m.admin_certificates_download_fullchain()}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      render={
                        <a
                          href={exportUrl(certificate.id, "private-key")}
                          download
                        />
                      }
                    >
                      <FileKeyIcon />
                      {m.admin_certificates_download_private_key()}
                    </Button>
                    {certificate.kind !== "imported" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pendingOperation !== null}
                        loading={pendingOperation === `renew:${certificate.id}`}
                        onClick={() =>
                          void runOperation(`renew:${certificate.id}`, () =>
                            renewCertificate({
                              data: { id: certificate.id },
                            }),
                          )
                        }
                      >
                        <RefreshCwIcon />
                        {m.admin_certificates_renew()}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          replaceForm.reset();
                          setReplaceTarget(certificate.id);
                        }}
                      >
                        <UploadIcon />
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
                    onClick={() => {
                      replaceForm.reset();
                      setReplaceTarget(certificate.id);
                    }}
                  >
                    <UploadIcon />
                    {m.admin_certificates_replace()}
                  </Button>
                ) : null}
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={m.admin_certificates_delete()}
                  disabled={pendingOperation !== null}
                  loading={pendingOperation === `delete:${certificate.id}`}
                  onClick={() =>
                    void runOperation(`delete:${certificate.id}`, () =>
                      deleteCertificate({ data: { id: certificate.id } }),
                    )
                  }
                >
                  <Trash2Icon />
                </Button>
              </div>
            </div>

            {certificate.pendingMaterial ? (
              <div className="mt-3 rounded-lg border border-amber-500/32 bg-amber-500/8 p-3">
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
                    notBefore:
                      certificate.pendingMaterial.notBefore.toISOString(),
                    notAfter:
                      certificate.pendingMaterial.notAfter.toISOString(),
                  })}
                </p>
                <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                  {certificate.pendingMaterial.notBefore.getTime() > Date.now()
                    ? m.admin_certificates_pending_reason_not_yet_valid()
                    : m.admin_certificates_pending_reason_expired()}
                </p>
                <p className="mt-2 text-xs text-destructive">
                  {m.admin_certificates_pending_risk_warning()}
                </p>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    disabled={pendingOperation !== null}
                    loading={pendingOperation === `activate:${certificate.id}`}
                    onClick={() => {
                      if (
                        !window.confirm(
                          m.admin_certificates_pending_activation_confirm(),
                        )
                      ) {
                        return;
                      }
                      void runOperation(`activate:${certificate.id}`, () =>
                        activatePendingImportedCertificate({
                          data: { certificateId: certificate.id },
                        }),
                      );
                    }}
                  >
                    {m.admin_certificates_activate()}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pendingOperation !== null}
                    loading={pendingOperation === `discard:${certificate.id}`}
                    onClick={() =>
                      void runOperation(`discard:${certificate.id}`, () =>
                        discardPendingImportedCertificate({
                          data: { certificateId: certificate.id },
                        }),
                      )
                    }
                  >
                    {m.admin_certificates_discard()}
                  </Button>
                </div>
              </div>
            ) : null}

            {certificate.challenge?.length ? (
              <div className="mt-3 rounded-lg border p-3">
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
                          void copyRecord(
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
                    loading={
                      pendingOperation === `continue-dns:${certificate.id}`
                    }
                    onClick={() =>
                      void runOperation(`continue-dns:${certificate.id}`, () =>
                        continueCertificateDnsChallenge({
                          data: { id: certificate.id },
                        }),
                      )
                    }
                  >
                    {m.admin_certificates_continue_dns()}
                  </Button>
                ) : null}
              </div>
            ) : null}

            {certificate.lastError ? (
              <p className="mt-3 text-xs text-destructive">
                {certificate.lastError}
              </p>
            ) : null}
            {certificate.servers.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {certificate.servers.map((binding) => (
                  <Badge key={binding.serverId} variant="outline">
                    {binding.server.name} · {stateLabels[binding.state]}
                  </Badge>
                ))}
              </div>
            ) : null}
          </article>
        ))}
      </section>

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
              <p className="rounded-lg border border-amber-500/32 bg-amber-500/8 p-3 text-xs">
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
    </div>
  );
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
