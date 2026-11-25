import type { ManagedIntentRouteRule } from "@blossom/contracts/agent-config-v3";
import type React from "react";
import { useEffect, useState } from "react";

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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  networkingRuleSchema,
  type NetworkingRuleInput,
} from "@/lib/networking-schema";
import type {
  RoutingInboundOption,
  RoutingOutboundOption,
  RoutingRuleSetOption,
} from "@/lib/networking-workspace";
import { m } from "@/paraglide/messages";

const RESOLVE_STRATEGIES = [
  "prefer_ipv4",
  "prefer_ipv6",
  "ipv4_only",
  "ipv6_only",
] as const;
type ResolveStrategy = (typeof RESOLVE_STRATEGIES)[number];

const RESOLVE_LABEL: Record<ResolveStrategy, () => string> = {
  prefer_ipv4: m.admin_networking_routing_resolve_prefer_ipv4,
  prefer_ipv6: m.admin_networking_routing_resolve_prefer_ipv6,
  ipv4_only: m.admin_networking_routing_resolve_ipv4_only,
  ipv6_only: m.admin_networking_routing_resolve_ipv6_only,
};

function splitList(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function formatList(values: readonly (string | number)[]): string {
  return values.join("\n");
}

function parsePorts(value: string): number[] {
  return splitList(value)
    .map((entry) => Number.parseInt(entry, 10))
    .filter(
      (entry) => Number.isInteger(entry) && entry >= 1 && entry <= 65_535,
    );
}

function defaultRule(
  inbounds: readonly RoutingInboundOption[],
): NetworkingRuleInput {
  return {
    ruleId: crypto.randomUUID(),
    inboundTags: inbounds[0] ? [inbounds[0].tag] : [],
    sniff: false,
    resolveStrategy: null,
    network: null,
    domains: [],
    domainSuffixes: [],
    domainKeywords: [],
    ipCidrs: [],
    ports: [],
    portRanges: [],
    protocols: [],
    invert: false,
    ruleSetTags: [],
    action: "route",
    outboundTag: "direct",
  };
}

export interface RoutingRuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule?: ManagedIntentRouteRule | null;
  inbounds: readonly RoutingInboundOption[];
  outbounds: readonly RoutingOutboundOption[];
  ruleSets: readonly RoutingRuleSetOption[];
  onSave: (rule: ManagedIntentRouteRule) => void;
}

export function RoutingRuleDialog({
  open,
  onOpenChange,
  rule,
  inbounds,
  outbounds,
  ruleSets,
  onSave,
}: RoutingRuleDialogProps): React.ReactElement {
  const [draft, setDraft] = useState<NetworkingRuleInput>(() =>
    defaultRule(inbounds),
  );
  const [domains, setDomains] = useState("");
  const [suffixes, setSuffixes] = useState("");
  const [keywords, setKeywords] = useState("");
  const [ipCidrs, setIpCidrs] = useState("");
  const [ports, setPorts] = useState("");
  const [portRanges, setPortRanges] = useState("");
  const [protocols, setProtocols] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (rule) {
      setDraft(rule);
      setDomains(formatList(rule.domains));
      setSuffixes(formatList(rule.domainSuffixes));
      setKeywords(formatList(rule.domainKeywords));
      setIpCidrs(formatList(rule.ipCidrs));
      setPorts(formatList(rule.ports));
      setPortRanges(formatList(rule.portRanges ?? []));
      setProtocols(formatList(rule.protocols ?? []));
    } else {
      setDraft(defaultRule(inbounds));
      setDomains("");
      setSuffixes("");
      setKeywords("");
      setIpCidrs("");
      setPorts("");
      setPortRanges("");
      setProtocols("");
    }
  }, [open, rule?.ruleId]);

  const update = <K extends keyof NetworkingRuleInput>(
    key: K,
    value: NetworkingRuleInput[K],
  ) => setDraft((current) => ({ ...current, [key]: value }));

  const toggle = (
    tags: string[],
    tag: string,
    checked: boolean | "indeterminate",
  ) => {
    if (checked === true) return [...tags, tag];
    return tags.filter((entry) => entry !== tag);
  };

  const submit = () => {
    const candidate: NetworkingRuleInput = {
      ...draft,
      domains: splitList(domains),
      domainSuffixes: splitList(suffixes),
      domainKeywords: splitList(keywords),
      ipCidrs: splitList(ipCidrs),
      ports: parsePorts(ports),
      portRanges: splitList(portRanges),
      protocols: splitList(protocols),
      invert: draft.invert ?? false,
      outboundTag: draft.action === "reject" ? null : draft.outboundTag,
    };
    const parsed = networkingRuleSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }
    if (parsed.data.inboundTags.length === 0) {
      setError(m.admin_networking_issue_empty_rule_scope());
      return;
    }
    onSave(parsed.data);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {rule
              ? m.admin_networking_routing_rule_edit_title()
              : m.admin_networking_routing_rule_create_title()}
          </DialogTitle>
          <DialogDescription>
            {m.admin_networking_routing_rule_description()}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              submit();
            }}
          >
            <Field>
              <FieldLabel>{m.admin_networking_routing_rule_scope()}</FieldLabel>
              <div className="grid gap-2 sm:grid-cols-2">
                {inbounds.map((inbound) => (
                  <label
                    key={inbound.tag}
                    className="flex items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={draft.inboundTags.includes(inbound.tag)}
                      onCheckedChange={(checked) =>
                        update(
                          "inboundTags",
                          toggle(draft.inboundTags, inbound.tag, checked),
                        )
                      }
                    />
                    <span className="min-w-0 truncate">
                      {inbound.name}
                      <span className="ms-1 text-muted-foreground">
                        ({inbound.tag})
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <FieldDescription>
                {m.admin_networking_routing_rule_scope_hint()}
              </FieldDescription>
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>
                  {m.admin_networking_routing_rule_network()}
                </FieldLabel>
                <Select
                  value={draft.network ?? "any"}
                  onValueChange={(value) =>
                    update(
                      "network",
                      value === "tcp" || value === "udp" ? value : null,
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue>
                      {(value: string) =>
                        value === "tcp"
                          ? m.admin_networking_routing_network_tcp()
                          : value === "udp"
                            ? m.admin_networking_routing_network_udp()
                            : m.admin_networking_routing_network_any()
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="any">
                      {m.admin_networking_routing_network_any()}
                    </SelectItem>
                    <SelectItem value="tcp">
                      {m.admin_networking_routing_network_tcp()}
                    </SelectItem>
                    <SelectItem value="udp">
                      {m.admin_networking_routing_network_udp()}
                    </SelectItem>
                  </SelectPopup>
                </Select>
              </Field>

              <Field>
                <FieldLabel>
                  {m.admin_networking_routing_rule_action()}
                </FieldLabel>
                <Select
                  value={draft.action}
                  onValueChange={(value) => {
                    if (value !== "route" && value !== "reject") return;
                    update("action", value);
                    update("outboundTag", value === "reject" ? null : "direct");
                  }}
                >
                  <SelectTrigger>
                    <SelectValue>
                      {(value: string) =>
                        value === "reject"
                          ? m.admin_networking_routing_rule_reject()
                          : m.admin_networking_routing_rule_route()
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="route">
                      {m.admin_networking_routing_rule_route()}
                    </SelectItem>
                    <SelectItem value="reject">
                      {m.admin_networking_routing_rule_reject()}
                    </SelectItem>
                  </SelectPopup>
                </Select>
              </Field>
            </div>

            {draft.action === "route" ? (
              <Field>
                <FieldLabel>
                  {m.admin_networking_routing_rule_outbound()}
                </FieldLabel>
                <Select
                  value={draft.outboundTag ?? "direct"}
                  onValueChange={(value) => update("outboundTag", value)}
                >
                  <SelectTrigger>
                    <SelectValue>
                      {(value: string) =>
                        outbounds.find((row) => row.tag === value)?.name ??
                        value
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {outbounds.map((row) => (
                      <SelectItem key={row.tag} value={row.tag}>
                        {row.name} ({row.kind})
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <FieldDescription>
                  {m.admin_networking_routing_rule_outbound_hint()}
                </FieldDescription>
              </Field>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>
                  {m.admin_networking_routing_rule_domains()}
                </FieldLabel>
                <Textarea
                  value={domains}
                  onChange={(event) => setDomains(event.target.value)}
                  rows={3}
                  placeholder={"example.com\nexample.org"}
                />
              </Field>
              <Field>
                <FieldLabel>
                  {m.admin_networking_routing_rule_suffixes()}
                </FieldLabel>
                <Textarea
                  value={suffixes}
                  onChange={(event) => setSuffixes(event.target.value)}
                  rows={3}
                  placeholder={"example.com\nexample.org"}
                />
              </Field>
              <Field>
                <FieldLabel>
                  {m.admin_networking_routing_rule_keywords()}
                </FieldLabel>
                <Textarea
                  value={keywords}
                  onChange={(event) => setKeywords(event.target.value)}
                  rows={3}
                />
              </Field>
              <Field>
                <FieldLabel>
                  {m.admin_networking_routing_rule_cidrs()}
                </FieldLabel>
                <Textarea
                  value={ipCidrs}
                  onChange={(event) => setIpCidrs(event.target.value)}
                  rows={3}
                  placeholder={"10.0.0.0/8\n2001:db8::/32"}
                />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>
                  {m.admin_networking_routing_rule_ports()}
                </FieldLabel>
                <Input
                  value={ports}
                  onValueChange={setPorts}
                  placeholder="443, 8443"
                />
              </Field>
              <Field>
                <FieldLabel>
                  {m.admin_networking_routing_rule_sniff()}
                </FieldLabel>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={draft.sniff}
                    onCheckedChange={(checked) => update("sniff", checked)}
                  />
                  <span className="text-sm text-muted-foreground">
                    {m.admin_networking_routing_rule_sniff_hint()}
                  </span>
                </div>
              </Field>
              <Field>
                <FieldLabel>
                  {m.admin_networking_routing_rule_port_ranges()}
                </FieldLabel>
                <Input
                  value={portRanges}
                  onValueChange={setPortRanges}
                  placeholder="1000:2000, 3000:4000"
                />
              </Field>
              <Field>
                <FieldLabel>
                  {m.admin_networking_routing_rule_protocols()}
                </FieldLabel>
                <Input
                  value={protocols}
                  onValueChange={setProtocols}
                  placeholder="tls, quic, http"
                />
              </Field>
            </div>

            <Field>
              <FieldLabel>
                {m.admin_networking_routing_rule_invert()}
              </FieldLabel>
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={draft.invert ?? false}
                  onCheckedChange={(checked) =>
                    update("invert", checked === true)
                  }
                />
                <span className="text-sm text-muted-foreground">
                  {m.admin_networking_routing_rule_invert_hint()}
                </span>
              </div>
            </Field>

            <Field>
              <FieldLabel>
                {m.admin_networking_routing_rule_resolve()}
              </FieldLabel>
              <Select
                value={draft.resolveStrategy ?? "none"}
                onValueChange={(value) =>
                  update(
                    "resolveStrategy",
                    value === "none" ? null : (value as ResolveStrategy),
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue>
                    {(value: string) =>
                      value === "none"
                        ? m.admin_networking_routing_resolve_none()
                        : RESOLVE_LABEL[value as ResolveStrategy]()
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="none">
                    {m.admin_networking_routing_resolve_none()}
                  </SelectItem>
                  {RESOLVE_STRATEGIES.map((strategy) => (
                    <SelectItem key={strategy} value={strategy}>
                      {RESOLVE_LABEL[strategy]()}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <FieldDescription>
                {m.admin_networking_routing_rule_resolve_hint()}
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel>
                {m.admin_networking_routing_rule_rule_sets()}
              </FieldLabel>
              <div className="grid gap-2 sm:grid-cols-2">
                {ruleSets.map((ruleSet) => (
                  <label
                    key={ruleSet.runtimeTag}
                    className="flex items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={draft.ruleSetTags.includes(ruleSet.runtimeTag)}
                      onCheckedChange={(checked) =>
                        update(
                          "ruleSetTags",
                          toggle(
                            draft.ruleSetTags,
                            ruleSet.runtimeTag,
                            checked,
                          ),
                        )
                      }
                    />
                    <span className="min-w-0 truncate">
                      {ruleSet.ruleSetId} · {ruleSet.version}
                    </span>
                  </label>
                ))}
              </div>
              {ruleSets.length === 0 ? (
                <FieldDescription>
                  {m.admin_networking_routing_rule_no_rule_sets()}
                </FieldDescription>
              ) : null}
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
