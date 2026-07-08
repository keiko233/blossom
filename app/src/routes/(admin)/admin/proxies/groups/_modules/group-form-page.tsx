import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxValue,
} from "@/components/ui/combobox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import type { Node } from "@/db/proxy-schema";
import { listNodes, NODES_QUERY_KEY } from "@/lib/nodes";
import { m } from "@/paraglide/messages";

import { type GroupWithNodes, useGroupFormController } from "./use-group-form";

const GROUPS_LIST = "/admin/proxies/groups" as const;

export interface GroupFormPageProps {
  /** Present when editing; absent for the create page. */
  group?: GroupWithNodes;
}

export function GroupFormPage({
  group,
}: GroupFormPageProps): React.ReactElement {
  const navigate = useNavigate();
  const isEdit = Boolean(group);

  const goToList = () => void navigate({ to: GROUPS_LIST });

  const { form } = useGroupFormController({
    group,
    onSuccess: goToList,
  });

  const { data: nodes } = useQuery({
    queryKey: NODES_QUERY_KEY,
    queryFn: () => listNodes(),
  });
  const nodeOptions = React.useMemo(() => nodes ?? [], [nodes]);

  return (
    <div className="flex flex-col">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-background/80 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={m.admin_proxies_groups_form_back()}
            onClick={goToList}
          >
            <ArrowLeftIcon />
          </Button>
          <h1 className="font-heading text-lg font-semibold">
            {isEdit
              ? m.admin_proxies_groups_form_edit_title()
              : m.admin_proxies_groups_form_create_title()}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={goToList}>
            {m.admin_proxies_groups_form_cancel()}
          </Button>
          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(isSubmitting) => (
              <Button type="submit" form="group-form" disabled={isSubmitting}>
                {m.admin_proxies_groups_form_save()}
              </Button>
            )}
          </form.Subscribe>
        </div>
      </header>

      <form
        id="group-form"
        className="w-full"
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void form.handleSubmit();
        }}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
          <div className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-xs">
            <form.Field name="name">
              {(field) => (
                <Field>
                  <FieldLabel>{m.admin_proxies_groups_field_name()}</FieldLabel>
                  <Input
                    value={field.state.value}
                    onValueChange={(v) => field.handleChange(v)}
                    onBlur={field.handleBlur}
                    placeholder="Premium"
                  />
                </Field>
              )}
            </form.Field>

            <form.Field name="remark">
              {(field) => (
                <Field>
                  <FieldLabel>
                    {m.admin_proxies_groups_field_remark()}
                  </FieldLabel>
                  <Input
                    value={field.state.value}
                    onValueChange={(v) => field.handleChange(v)}
                    onBlur={field.handleBlur}
                  />
                </Field>
              )}
            </form.Field>

            <form.Field name="sortOrder">
              {(field) => (
                <Field>
                  <FieldLabel>
                    {m.admin_proxies_groups_field_sort_order()}
                  </FieldLabel>
                  <NumberField
                    value={field.state.value}
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

            {/* Membership multi-select. Form state keeps node ids; the combobox
                works with node objects, so map at this boundary. */}
            <form.Field name="nodeIds">
              {(field) => {
                const selected = nodeOptions.filter((n) =>
                  field.state.value.includes(n.id),
                );
                return (
                  <Field>
                    <FieldLabel>
                      {m.admin_proxies_groups_field_nodes()}
                    </FieldLabel>
                    <Combobox
                      multiple
                      items={nodeOptions}
                      value={selected}
                      onValueChange={(next: Node[]) =>
                        field.handleChange(next.map((n) => n.id))
                      }
                      itemToStringLabel={(n: Node) => n.name}
                    >
                      <ComboboxChips>
                        <ComboboxValue>
                          {(value: Node[]) => (
                            <>
                              {value.map((n) => (
                                <ComboboxChip key={n.id} aria-label={n.name}>
                                  {n.name}
                                </ComboboxChip>
                              ))}
                              <ComboboxChipsInput
                                placeholder={
                                  value.length
                                    ? undefined
                                    : m.admin_proxies_groups_field_nodes_placeholder()
                                }
                              />
                            </>
                          )}
                        </ComboboxValue>
                      </ComboboxChips>
                      <ComboboxPopup>
                        <ComboboxEmpty>
                          {m.admin_proxies_groups_field_nodes_empty()}
                        </ComboboxEmpty>
                        <ComboboxList>
                          {(n: Node) => (
                            <ComboboxItem key={n.id} value={n}>
                              <div className="flex flex-col">
                                <span>{n.name}</span>
                                <span className="font-mono text-xs text-muted-foreground">
                                  {n.address}:{n.listenPort}
                                </span>
                              </div>
                            </ComboboxItem>
                          )}
                        </ComboboxList>
                      </ComboboxPopup>
                    </Combobox>
                  </Field>
                );
              }}
            </form.Field>
          </div>
        </div>
      </form>
    </div>
  );
}
