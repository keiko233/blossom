import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  EllipsisIcon,
  InfoIcon,
  PlusIcon,
  RouteIcon,
} from "lucide-react";
import * as React from "react";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toastManager } from "@/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { RuleAction } from "@/db/rule-schema";
import { m } from "@/paraglide/messages";
import {
  deleteRule,
  listRules,
  reorderRules,
  type RuleListItem,
  RULES_QUERY_KEY,
  updateRule,
} from "@/query/rules";

import { RuleDialog } from "./_modules/rule-dialog";
import {
  ACTION_LABELS,
  MATCH_TYPE_LABELS,
  SCOPE_LABELS,
} from "./_modules/rule-labels";

export const Route = createFileRoute("/(admin)/admin/proxies/rules/")({
  staticData: {
    crumb: () => m.admin_nav_proxies_item_rules(),
  },
  component: RouteComponent,
});

const columnHelper = createColumnHelper<RuleListItem>();

/** How many values show inline before the rest collapse into the tooltip. */
const VISIBLE_VALUES = 3;

const ACTION_BADGE_VARIANT: Record<RuleAction, "info" | "success" | "error"> = {
  direct: "info",
  proxy: "success",
  reject: "error",
};

function ValuesCell({ values }: { values: string[] }): React.ReactElement {
  const shown = values.slice(0, VISIBLE_VALUES);
  const hidden = values.length - shown.length;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="block max-w-72 cursor-default truncate" />}
      >
        <span className="font-mono text-xs">{shown.join(", ")}</span>
        {hidden > 0 ? (
          <span className="ml-1 text-xs text-muted-foreground">
            {m.admin_rules_values_more({ count: hidden })}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup className="max-w-sm">
        <ul className="max-h-64 overflow-y-auto font-mono text-xs">
          {values.map((value) => (
            <li key={value}>{value}</li>
          ))}
        </ul>
      </TooltipPopup>
    </Tooltip>
  );
}

function RouteComponent(): React.ReactElement {
  const queryClient = useQueryClient();

  const {
    data: rules,
    isPending,
    isError,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: RULES_QUERY_KEY,
    queryFn: () => listRules(),
  });

  // Dialog state: `editing` undefined means create. The dialog stays mounted
  // so Base UI can play its exit animation; its form remounts per open.
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<RuleListItem | undefined>();

  const openCreate = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };
  const openEdit = (rule: RuleListItem) => {
    setEditing(rule);
    setDialogOpen(true);
  };

  const onMutationError = () =>
    toastManager.add({
      type: "error",
      title: m.admin_rules_toast_error(),
    });

  const toggleMutation = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      updateRule({ data: input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: RULES_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: m.admin_rules_toast_updated(),
      });
    },
    onError: onMutationError,
  });

  const reorderMutation = useMutation({
    mutationFn: (ids: string[]) => reorderRules({ data: { ids } }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: RULES_QUERY_KEY }),
    onError: onMutationError,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteRule({ data: { id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: RULES_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: m.admin_rules_toast_deleted(),
      });
    },
    onError: onMutationError,
  });

  const requestDelete = async (rule: RuleListItem) => {
    await Confirm.call({
      title: m.admin_rules_delete_title(),
      description: m.admin_rules_delete_description(),
      confirmLabel: m.admin_rules_action_delete(),
      cancelLabel: m.admin_rules_form_cancel(),
      destructive: true,
      onConfirm: () => deleteMutation.mutateAsync(rule.id),
    });
  };

  // Swap a rule with its neighbour and rewrite the whole order in one call.
  const move = (index: number, offset: -1 | 1) => {
    if (!rules) return;
    const ids = rules.map((rule) => rule.id);
    const target = index + offset;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorderMutation.mutate(ids);
  };

  const columns = [
    columnHelper.accessor("name", {
      header: () => m.admin_rules_col_name(),
      cell: (info) => <span className="font-medium">{info.getValue()}</span>,
    }),
    columnHelper.accessor("matchType", {
      header: () => m.admin_rules_col_match(),
      cell: (info) => MATCH_TYPE_LABELS[info.getValue()](),
    }),
    columnHelper.accessor("values", {
      header: () => m.admin_rules_col_values(),
      cell: (info) => <ValuesCell values={info.getValue()} />,
    }),
    columnHelper.accessor("action", {
      header: () => m.admin_rules_col_action(),
      cell: (info) => (
        <Badge variant={ACTION_BADGE_VARIANT[info.getValue()]}>
          {ACTION_LABELS[info.getValue()]()}
        </Badge>
      ),
    }),
    columnHelper.accessor("scope", {
      header: () => m.admin_rules_col_scope(),
      cell: (info) => (
        <Badge variant="outline">{SCOPE_LABELS[info.getValue()]()}</Badge>
      ),
    }),
    columnHelper.accessor("enabled", {
      header: () => m.admin_rules_col_enabled(),
      cell: (info) => {
        const rule = info.row.original;
        return (
          <Switch
            aria-label={m.admin_rules_toggle_enabled()}
            checked={rule.enabled}
            disabled={
              toggleMutation.isPending &&
              toggleMutation.variables?.id === rule.id
            }
            onCheckedChange={(enabled) =>
              toggleMutation.mutate({ id: rule.id, enabled })
            }
          />
        );
      },
    }),
    columnHelper.display({
      id: "order",
      header: () => m.admin_rules_col_order(),
      cell: (info) => {
        const index = info.row.index;
        return (
          <div className="flex gap-1">
            <Button
              aria-label={m.admin_rules_move_up()}
              disabled={index === 0 || reorderMutation.isPending}
              size="icon"
              variant="ghost"
              onClick={() => move(index, -1)}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              aria-label={m.admin_rules_move_down()}
              disabled={
                index === (rules?.length ?? 0) - 1 || reorderMutation.isPending
              }
              size="icon"
              variant="ghost"
              onClick={() => move(index, 1)}
            >
              <ArrowDownIcon />
            </Button>
          </div>
        );
      },
    }),
    columnHelper.display({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: (info) => {
        const rule = info.row.original;
        return (
          <div className="flex justify-end">
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    loading={
                      deleteMutation.isPending &&
                      deleteMutation.variables === rule.id
                    }
                    size="icon"
                    variant="ghost"
                  />
                }
                aria-label="Actions"
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => openEdit(rule)}>
                  {m.admin_rules_action_edit()}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  variant="destructive"
                  onClick={() => void requestDelete(rule)}
                >
                  {m.admin_rules_action_delete()}
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        );
      },
    }),
  ];

  const table = useReactTable({
    data: rules ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader>
        <PageHeaderTitle>{m.admin_nav_proxies_item_rules()}</PageHeaderTitle>
        <Button onClick={openCreate}>
          <PlusIcon />
          {m.admin_rules_add()}
        </Button>
      </PageHeader>

      <Alert variant="info">
        <InfoIcon />
        <AlertTitle>{m.admin_rules_note_title()}</AlertTitle>
        <AlertDescription>
          <p>{m.admin_rules_note_client()}</p>
          <p>{m.admin_rules_note_server()}</p>
        </AlertDescription>
      </Alert>

      {isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : isError ? (
        <div className="flex flex-col items-center gap-4 py-16">
          <Alert variant="error" className="max-w-md">
            <AlertTitle>{m.admin_rules_error_title()}</AlertTitle>
            <AlertDescription>
              {m.admin_rules_error_description()}
            </AlertDescription>
          </Alert>
          <Button loading={isFetching} onClick={() => void refetch()}>
            {m.admin_rules_error_retry()}
          </Button>
        </div>
      ) : rules.length > 0 ? (
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                className={row.original.enabled ? undefined : "opacity-60"}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RouteIcon />
            </EmptyMedia>
            <EmptyTitle>{m.admin_rules_empty_title()}</EmptyTitle>
          </EmptyHeader>
          <Button onClick={openCreate}>
            <PlusIcon />
            {m.admin_rules_add()}
          </Button>
        </Empty>
      )}

      <RuleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        rule={editing}
      />
    </div>
  );
}
