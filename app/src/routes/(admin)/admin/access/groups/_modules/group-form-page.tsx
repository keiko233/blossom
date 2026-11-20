import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import * as React from "react";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import { previewNodeSelection } from "@/lib/access-impact";
import { m } from "@/paraglide/messages";
import { listNodes, NODES_QUERY_KEY } from "@/query/nodes";

import { EffectiveNodePreviewPanel } from "./effective-node-preview";
import { GroupImpactPanel } from "./group-impact-panel";
import { GroupMembershipEditor } from "./group-membership-editor";
import { type GroupWithNodes, useGroupFormController } from "./use-group-form";

const GROUPS_LIST = "/admin/access/groups" as const;

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

  const {
    data: nodes,
    isError: nodesFailed,
    isSuccess: nodesLoaded,
  } = useQuery({
    queryKey: NODES_QUERY_KEY,
    queryFn: () => listNodes(),
  });
  const nodeOptions = React.useMemo(() => nodes ?? [], [nodes]);
  const nodeNames = React.useMemo(
    () => new Map(nodeOptions.map((n) => [n.id, n.name])),
    [nodeOptions],
  );

  return (
    <div className="flex flex-col">
      <PageHeader className="sticky top-0 z-10 gap-3 border-b bg-background/80 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label={m.admin_proxies_groups_form_back()}
            render={<Link to={GROUPS_LIST} />}
          >
            <ArrowLeftIcon />
          </Button>
          <PageHeaderTitle>
            {isEdit
              ? m.admin_proxies_groups_form_edit_title()
              : m.admin_proxies_groups_form_create_title()}
          </PageHeaderTitle>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" render={<Link to={GROUPS_LIST} />}>
            {m.admin_proxies_groups_form_cancel()}
          </Button>
          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(isSubmitting) => (
              <Button type="submit" form="group-form" loading={isSubmitting}>
                {m.admin_proxies_groups_form_save()}
              </Button>
            )}
          </form.Subscribe>
        </div>
      </PageHeader>

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

            {/* Ordered membership: form state is the draft in subscription
                order; the editor only proposes new drafts. */}
            <form.Field name="nodeIds">
              {(field) => (
                <Field>
                  <FieldLabel>
                    {m.admin_proxies_groups_field_nodes()}
                  </FieldLabel>
                  <GroupMembershipEditor
                    nodes={nodeOptions}
                    value={field.state.value}
                    onChange={(nodeIds) => field.handleChange(nodeIds)}
                  />
                  {nodesLoaded && nodeOptions.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {m.admin_access_no_nodes_hint()}{" "}
                      <Link
                        className="underline underline-offset-4"
                        rel="noopener noreferrer"
                        target="_blank"
                        to="/admin/servers"
                      >
                        {m.admin_access_create_node()}
                      </Link>{" "}
                      {m.admin_access_new_tab_hint()}
                    </p>
                  ) : null}
                </Field>
              )}
            </form.Field>
          </div>

          <form.Subscribe selector={(s) => s.values.nodeIds}>
            {(selectedNodeIds) => (
              <>
                {group ? (
                  <GroupImpactPanel
                    groupId={group.id}
                    nodeNames={nodeNames}
                    savedNodeIds={group.nodeIds}
                    selectedNodeIds={selectedNodeIds}
                  />
                ) : null}
                <EffectiveNodePreviewPanel
                  emptyMessage={m.admin_access_preview_empty_group()}
                  hasSelection={selectedNodeIds.length > 0}
                  isError={nodesFailed}
                  preview={
                    nodes
                      ? previewNodeSelection({
                          nodeIds: selectedNodeIds,
                          nodes,
                        })
                      : undefined
                  }
                />
              </>
            )}
          </form.Subscribe>
        </div>
      </form>
    </div>
  );
}
