import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import * as React from "react";

import {
  PageHeader,
  PageHeaderActions,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { WorkbenchViewport } from "@/components/app-shell/workspace";
import { Badge } from "@/components/ui/badge";
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
import { isMembershipDraftDirty } from "@/lib/group-membership-draft";
import { m } from "@/paraglide/messages";
import { listNodes, NODES_QUERY_KEY } from "@/query/nodes";

import { EffectiveNodePreviewPanel } from "./effective-node-preview";
import { GroupConflictPanel } from "./group-conflict-panel";
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

  const {
    form,
    baseline,
    conflict,
    reloadLatestKeepingDraft,
    useLatestSavedOrder,
    retryConflictLoad,
  } = useGroupFormController({
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
  const nodeOptions = nodes ?? [];
  const nodeNames = new Map(nodeOptions.map((node) => [node.id, node.name]));

  return (
    <WorkbenchViewport
      data-slot="group-editor-page"
      className="max-md:h-auto max-md:max-h-none max-md:overflow-visible md:h-full"
    >
      <PageHeader>
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label={m.admin_proxies_groups_form_back()}
            render={<Link to={GROUPS_LIST} />}
          >
            <ArrowLeftIcon />
          </Button>
          <PageHeaderTitle className="truncate">
            {isEdit
              ? m.admin_proxies_groups_form_edit_title()
              : m.admin_proxies_groups_form_create_title()}
          </PageHeaderTitle>
          {isEdit ? (
            <Badge variant="outline">
              {m.admin_proxies_groups_form_revision({
                revision: baseline.revision,
              })}
            </Badge>
          ) : null}
          <form.Subscribe
            selector={(state) => ({
              nodeIds: state.values.nodeIds,
              isSubmitting: state.isSubmitting,
            })}
          >
            {({ nodeIds, isSubmitting }) => {
              const dirty = isMembershipDraftDirty(baseline.nodeIds, nodeIds);
              return (
                <span
                  aria-live="polite"
                  className="truncate text-xs text-muted-foreground"
                >
                  {conflict
                    ? m.admin_proxies_groups_form_status_conflict()
                    : dirty
                      ? m.admin_proxies_groups_form_status_unsaved()
                      : isEdit
                        ? m.admin_proxies_groups_form_status_saved()
                        : m.admin_proxies_groups_form_status_new()}
                  {isSubmitting
                    ? ` · ${m.admin_proxies_groups_form_saving()}`
                    : ""}
                </span>
              );
            }}
          </form.Subscribe>
        </div>
        <PageHeaderActions>
          <Button variant="ghost" size="sm" render={<Link to={GROUPS_LIST} />}>
            {m.admin_proxies_groups_form_cancel()}
          </Button>
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <Button
                type="submit"
                form="group-form"
                size="sm"
                loading={isSubmitting}
              >
                {m.admin_proxies_groups_form_save()}
              </Button>
            )}
          </form.Subscribe>
        </PageHeaderActions>
      </PageHeader>

      <form
        id="group-form"
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void form.handleSubmit();
        }}
      >
        <div className="grid min-h-0 flex-1 max-xl:overflow-y-auto xl:grid-cols-[minmax(0,1fr)_26rem]">
          <div className="flex min-h-0 flex-col gap-4 p-4 lg:p-6 xl:overflow-y-auto">
            {conflict && group ? (
              <form.Subscribe selector={(state) => state.values.nodeIds}>
                {(nodeIds) => (
                  <GroupConflictPanel
                    conflict={conflict}
                    draftNodeIds={nodeIds}
                    nodes={nodeOptions}
                    onReloadKeepingDraft={reloadLatestKeepingDraft}
                    onUseSavedOrder={useLatestSavedOrder}
                    onRetry={retryConflictLoad}
                  />
                )}
              </form.Subscribe>
            ) : null}

            <div data-slot="group-details" className="flex flex-col gap-3">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_9rem]">
                <form.Field name="name">
                  {(field) => (
                    <Field>
                      <FieldLabel>
                        {m.admin_proxies_groups_field_name()}
                      </FieldLabel>
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
              </div>
            </div>

            <form.Field name="nodeIds">
              {(field) => (
                <Field className="min-h-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <FieldLabel>
                      {m.admin_proxies_groups_field_nodes()}
                    </FieldLabel>
                    <span className="text-xs text-muted-foreground">
                      {m.admin_proxies_groups_members_order_hint()}
                    </span>
                  </div>
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

          <aside className="flex min-h-0 flex-col gap-6 border-t p-4 lg:p-6 xl:overflow-y-auto xl:border-s xl:border-t-0">
            <form.Subscribe selector={(state) => state.values.nodeIds}>
              {(selectedNodeIds) => (
                <>
                  {group ? (
                    <GroupImpactPanel
                      groupId={group.id}
                      nodeNames={nodeNames}
                      savedNodeIds={baseline.nodeIds}
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
          </aside>
        </div>

        <div
          data-slot="group-save-bar"
          className="shrink-0 border-t bg-background px-4 py-3 lg:px-6"
        >
          <form.Subscribe
            selector={(state) => ({
              nodeIds: state.values.nodeIds,
              isSubmitting: state.isSubmitting,
            })}
          >
            {({ nodeIds, isSubmitting }) => {
              const dirty = isMembershipDraftDirty(baseline.nodeIds, nodeIds);
              const missing = nodesLoaded
                ? nodeIds.filter((id) => !nodeNames.has(id)).length
                : 0;
              return (
                <div className="flex w-full flex-wrap items-center justify-between gap-2">
                  <span
                    aria-live="polite"
                    className="text-xs text-muted-foreground"
                  >
                    {conflict
                      ? m.admin_proxies_groups_form_status_conflict()
                      : missing > 0
                        ? m.admin_proxies_groups_members_missing_block()
                        : dirty
                          ? m.admin_proxies_groups_members_dirty({
                              count: nodeIds.length,
                            })
                          : m.admin_proxies_groups_members_clean({
                              count: nodeIds.length,
                            })}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" render={<Link to={GROUPS_LIST} />}>
                      {m.admin_proxies_groups_form_cancel()}
                    </Button>
                    <Button
                      type="submit"
                      form="group-form"
                      disabled={Boolean(conflict) || missing > 0}
                      loading={isSubmitting}
                    >
                      {m.admin_proxies_groups_form_save()}
                    </Button>
                  </div>
                </div>
              );
            }}
          </form.Subscribe>
        </div>
      </form>
    </WorkbenchViewport>
  );
}
