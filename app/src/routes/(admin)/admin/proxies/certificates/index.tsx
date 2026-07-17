import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  CopyIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import { z } from "zod";

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
import { isValidCertificateDomain } from "@/lib/certificate-domain";
import { m } from "@/paraglide/messages";
import {
  CERTIFICATE_CAPABILITY_QUERY_KEY,
  CERTIFICATES_QUERY_KEY,
  continueCertificateDnsChallenge,
  createCertificate,
  deleteCertificate,
  getCertificateCapability,
  listCertificates,
  reconcileCertificates,
  renewCertificate,
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

function CertificatesPage() {
  const queryClient = useQueryClient();
  const [sheetOpen, setSheetOpen] = useState(false);
  const formSchema = z.object({
    name: z.string().trim().min(1, m.admin_certificates_validation_required()),
    domains: z
      .string()
      .trim()
      .min(1, m.admin_certificates_validation_domain())
      .refine(
        (value) => splitDomains(value).every(isValidCertificateDomain),
        m.admin_certificates_validation_domain(),
      ),
    kind: z.enum(["acme", "self_signed"]),
    email: z.union([
      z.literal(""),
      z.email(m.admin_certificates_validation_email()),
    ]),
  });
  type FormValues = z.infer<typeof formSchema>;
  const formDefaultValues: FormValues = {
    name: "",
    domains: "",
    kind: "acme",
    email: "",
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
  const runOperation = async (operation: Promise<unknown>) => {
    try {
      await operation;
      await refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: m.admin_certificates_operation_error({ error: String(error) }),
      });
    }
  };
  const createMutation = useMutation({
    mutationFn: (values: FormValues) =>
      createCertificate({
        data: {
          name: values.name,
          domains: splitDomains(values.domains),
          kind: values.kind,
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
  const form = useForm({
    defaultValues: formDefaultValues,
    validators: { onSubmit: formSchema },
    onSubmit: async ({ value }) => {
      await createMutation.mutateAsync(value);
      form.reset();
      setSheetOpen(false);
    },
  });

  const kindLabels = {
    acme: m.admin_certificates_kind_acme(),
    self_signed: m.admin_certificates_kind_self_signed(),
  };
  const stateLabels = {
    pending: m.admin_certificates_state_pending(),
    issuing: m.admin_certificates_state_issuing(),
    waiting_dns: m.admin_certificates_state_waiting_dns(),
    active: m.admin_certificates_state_active(),
    renewing: m.admin_certificates_state_renewing(),
    error: m.admin_certificates_state_error(),
    expired: m.admin_certificates_state_expired(),
  };

  return (
    <div className="space-y-6 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold">
            {m.admin_certificates_title()}
          </h1>
          <p className="text-sm text-muted-foreground">
            {m.admin_certificates_description()}
          </p>
        </div>
        <Sheet
          open={sheetOpen}
          onOpenChange={(open) => {
            if (createMutation.isPending) return;
            setSheetOpen(open);
            if (!open) form.reset();
          }}
        >
          <SheetTrigger render={<Button />}>
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
                void form.handleSubmit();
              }}
            >
              <SheetPanel className="space-y-4">
                <form.Field name="name">
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
                </form.Field>
                <form.Field name="domains">
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
                </form.Field>
                <form.Field name="kind">
                  {(field) => (
                    <Select
                      value={field.state.value}
                      onValueChange={(value) =>
                        value && field.handleChange(value as FormValues["kind"])
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="acme">{kindLabels.acme}</SelectItem>
                        <SelectItem value="self_signed">
                          {kindLabels.self_signed}
                        </SelectItem>
                      </SelectPopup>
                    </Select>
                  )}
                </form.Field>
                <form.Subscribe selector={(state) => state.values.kind}>
                  {(kind) =>
                    kind === "acme" ? (
                      <>
                        <form.Field name="email">
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
                        </form.Field>
                        <p className="rounded-lg border bg-muted/32 p-3 text-xs text-muted-foreground">
                          {capability?.automatic
                            ? m.admin_certificates_dns_automatic_notice()
                            : m.admin_certificates_dns_manual_notice()}
                        </p>
                      </>
                    ) : null
                  }
                </form.Subscribe>
              </SheetPanel>
              <SheetFooter>
                <SheetClose
                  disabled={createMutation.isPending}
                  render={<Button type="button" variant="outline" />}
                >
                  {m.admin_certificates_cancel()}
                </SheetClose>
                <form.Subscribe
                  selector={(state) => ({
                    domains: state.values.domains,
                    isSubmitting: state.isSubmitting,
                    name: state.values.name,
                  })}
                >
                  {({ domains, isSubmitting, name }) => (
                    <Button
                      type="submit"
                      disabled={isSubmitting || !name || !domains}
                    >
                      {m.admin_certificates_create()}
                    </Button>
                  )}
                </form.Subscribe>
              </SheetFooter>
            </form>
          </SheetContent>
        </Sheet>
      </header>

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
                    {kindLabels[certificate.kind]}
                  </Badge>
                  <Badge variant="outline">
                    {stateLabels[certificate.state]}
                  </Badge>
                </div>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {certificate.domains.join(", ")}
                </p>
              </div>
              <div className="flex gap-1">
                {certificate.activeMaterialVersion !== null ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void runOperation(
                        renewCertificate({ data: { id: certificate.id } }),
                      )
                    }
                  >
                    <RefreshCwIcon />
                    {m.admin_certificates_renew()}
                  </Button>
                ) : null}
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={m.admin_certificates_delete()}
                  onClick={() =>
                    void runOperation(
                      deleteCertificate({ data: { id: certificate.id } }),
                    )
                  }
                >
                  <Trash2Icon />
                </Button>
              </div>
            </div>

            {certificate.challenge?.length ? (
              <div className="mt-3 rounded-lg border p-3">
                <p className="mb-2 text-sm font-medium">
                  {m.admin_certificates_dns_records_title()}
                </p>
                {certificate.challenge.map((record) => (
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
                      onClick={() =>
                        void navigator.clipboard.writeText(
                          `TXT\t${record.name}\t${record.value}`,
                        )
                      }
                    >
                      <CopyIcon />
                    </Button>
                  </div>
                ))}
                {certificate.state === "waiting_dns" ? (
                  <Button
                    className="mt-3"
                    size="sm"
                    onClick={() =>
                      void runOperation(
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
    </div>
  );
}
