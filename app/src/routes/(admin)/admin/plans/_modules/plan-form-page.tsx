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
import { Label } from "@/components/ui/label";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { m } from "@/paraglide/messages";
import type { GroupListItem } from "@/query/groups";
import { GROUPS_QUERY_KEY, listGroups } from "@/query/groups";

import { type PlanWithGroups, usePlanFormController } from "./use-plan-form";

const PLANS_LIST = "/admin/plans" as const;

export interface PlanFormPageProps {
  /** Present when editing; absent for the create page. */
  plan?: PlanWithGroups;
}

export function PlanFormPage({ plan }: PlanFormPageProps): React.ReactElement {
  const navigate = useNavigate();
  const isEdit = Boolean(plan);

  const goToList = () => void navigate({ to: PLANS_LIST });

  const { form } = usePlanFormController({
    plan,
    onSuccess: goToList,
  });

  const { data: groups } = useQuery({
    queryKey: GROUPS_QUERY_KEY,
    queryFn: () => listGroups(),
  });
  const groupOptions = React.useMemo(() => groups ?? [], [groups]);

  return (
    <div className="flex flex-col">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-background/80 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={m.admin_plans_form_back()}
            onClick={goToList}
          >
            <ArrowLeftIcon />
          </Button>
          <h1 className="font-heading text-lg font-semibold">
            {isEdit
              ? m.admin_plans_form_edit_title()
              : m.admin_plans_form_create_title()}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={goToList}>
            {m.admin_plans_form_cancel()}
          </Button>
          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(isSubmitting) => (
              <Button type="submit" form="plan-form" loading={isSubmitting}>
                {m.admin_plans_form_save()}
              </Button>
            )}
          </form.Subscribe>
        </div>
      </header>

      <form
        id="plan-form"
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
                  <FieldLabel>{m.admin_plans_field_name()}</FieldLabel>
                  <Input
                    value={field.state.value}
                    onValueChange={(v) => field.handleChange(v)}
                    onBlur={field.handleBlur}
                    placeholder="Premium Monthly"
                  />
                </Field>
              )}
            </form.Field>

            <form.Field name="description">
              {(field) => (
                <Field>
                  <FieldLabel>{m.admin_plans_field_description()}</FieldLabel>
                  <Textarea
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                  />
                </Field>
              )}
            </form.Field>

            <div className="grid grid-cols-2 gap-3">
              <form.Field name="price">
                {(field) => (
                  <Field>
                    <FieldLabel>{m.admin_plans_field_price()}</FieldLabel>
                    <NumberField
                      min={0}
                      step={0.01}
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

              <form.Field name="durationDays">
                {(field) => (
                  <Field>
                    <FieldLabel>
                      {m.admin_plans_field_duration_days()}
                    </FieldLabel>
                    <NumberField
                      min={1}
                      value={field.state.value}
                      onValueChange={(v) => field.handleChange(v ?? 1)}
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

              <form.Field name="trafficGb">
                {(field) => (
                  <Field>
                    <FieldLabel>{m.admin_plans_field_traffic_gb()}</FieldLabel>
                    <NumberField
                      min={0}
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

              <form.Field name="deviceLimit">
                {(field) => (
                  <Field>
                    <FieldLabel>
                      {m.admin_plans_field_device_limit()}
                    </FieldLabel>
                    <NumberField
                      min={0}
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
            </div>

            <form.Field name="sortOrder">
              {(field) => (
                <Field>
                  <FieldLabel>{m.admin_plans_field_sort_order()}</FieldLabel>
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

            {/* Group binding multi-select. Form state keeps group ids; the
                combobox works with group objects, so map at this boundary. */}
            <form.Field name="groupIds">
              {(field) => {
                const selected = groupOptions.filter((g) =>
                  field.state.value.includes(g.id),
                );
                return (
                  <Field>
                    <FieldLabel>{m.admin_plans_field_groups()}</FieldLabel>
                    <Combobox
                      multiple
                      items={groupOptions}
                      value={selected}
                      onValueChange={(next: GroupListItem[]) =>
                        field.handleChange(next.map((g) => g.id))
                      }
                      itemToStringLabel={(g: GroupListItem) => g.name}
                    >
                      <ComboboxChips>
                        <ComboboxValue>
                          {(value: GroupListItem[]) => (
                            <>
                              {value.map((g) => (
                                <ComboboxChip key={g.id} aria-label={g.name}>
                                  {g.name}
                                </ComboboxChip>
                              ))}
                              <ComboboxChipsInput
                                placeholder={
                                  value.length
                                    ? undefined
                                    : m.admin_plans_field_groups_placeholder()
                                }
                              />
                            </>
                          )}
                        </ComboboxValue>
                      </ComboboxChips>
                      <ComboboxPopup>
                        <ComboboxEmpty>
                          {m.admin_plans_field_groups_empty()}
                        </ComboboxEmpty>
                        <ComboboxList>
                          {(g: GroupListItem) => (
                            <ComboboxItem key={g.id} value={g}>
                              <div className="flex flex-col">
                                <span>{g.name}</span>
                                {g.remark ? (
                                  <span className="text-xs text-muted-foreground">
                                    {g.remark}
                                  </span>
                                ) : null}
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

            <form.Field name="visible">
              {(field) => (
                <div className="flex items-center gap-3">
                  <Switch
                    checked={field.state.value}
                    onCheckedChange={(v) => field.handleChange(v)}
                  />
                  <Label>{m.admin_plans_field_visible()}</Label>
                </div>
              )}
            </form.Field>
          </div>
        </div>
      </form>
    </div>
  );
}
