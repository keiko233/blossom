import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { EllipsisIcon, InfoIcon, MegaphoneIcon, PlusIcon } from "lucide-react";
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
import { formatDateTime } from "@/lib/format";
import { m } from "@/paraglide/messages";
import {
  ANNOUNCEMENTS_QUERY_KEY,
  type AnnouncementListItem,
  deleteAnnouncement,
  listAnnouncements,
  updateAnnouncement,
} from "@/query/announcements";
import { listPlans, PLANS_QUERY_KEY } from "@/query/plans";

import { AnnouncementDialog } from "./_modules/announcement-dialog";
import {
  AUDIENCE_LABELS,
  LEVEL_BADGE_VARIANT,
  LEVEL_LABELS,
} from "./_modules/announcement-labels";

export const Route = createFileRoute("/(admin)/admin/announcements/")({
  staticData: {
    crumb: () => m.admin_nav_announcements(),
  },
  component: RouteComponent,
});

const columnHelper = createColumnHelper<AnnouncementListItem>();

/** "Start – end", "From …", "Until …" or "Always" for the schedule column. */
function scheduleText(row: AnnouncementListItem): string {
  const { startsAt, endsAt } = row;
  if (startsAt && endsAt) {
    return m.admin_announcements_schedule_range({
      start: formatDateTime(startsAt),
      end: formatDateTime(endsAt),
    });
  }
  if (startsAt) {
    return m.admin_announcements_schedule_from({
      date: formatDateTime(startsAt),
    });
  }
  if (endsAt) {
    return m.admin_announcements_schedule_until({
      date: formatDateTime(endsAt),
    });
  }
  return m.admin_announcements_schedule_always();
}

function RouteComponent(): React.ReactElement {
  const queryClient = useQueryClient();

  const {
    data: announcements,
    isPending,
    isError,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ANNOUNCEMENTS_QUERY_KEY,
    queryFn: () => listAnnouncements(),
  });

  const { data: plans } = useQuery({
    queryKey: PLANS_QUERY_KEY,
    queryFn: () => listPlans(),
  });

  const planNameById = new Map(
    (plans ?? []).map((plan) => [plan.id, plan.name]),
  );

  // Dialog state: `editing` undefined means create. The dialog stays mounted
  // so Base UI can play its exit animation; its form remounts per open.
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<
    AnnouncementListItem | undefined
  >();

  const openCreate = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };
  const openEdit = (announcement: AnnouncementListItem) => {
    setEditing(announcement);
    setDialogOpen(true);
  };

  const onMutationError = () =>
    toastManager.add({
      type: "error",
      title: m.admin_announcements_toast_error(),
    });

  const togglePublishedMutation = useMutation({
    mutationFn: (input: { id: string; published: boolean }) =>
      updateAnnouncement({ data: input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ANNOUNCEMENTS_QUERY_KEY,
      });
      toastManager.add({
        type: "success",
        title: m.admin_announcements_toast_updated(),
      });
    },
    onError: onMutationError,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAnnouncement({ data: { id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ANNOUNCEMENTS_QUERY_KEY,
      });
      toastManager.add({
        type: "success",
        title: m.admin_announcements_toast_deleted(),
      });
    },
    onError: onMutationError,
  });

  const requestDelete = async (announcement: AnnouncementListItem) => {
    await Confirm.call({
      title: m.admin_announcements_delete_title(),
      description: m.admin_announcements_delete_description(),
      confirmLabel: m.admin_announcements_action_delete(),
      cancelLabel: m.admin_announcements_form_cancel(),
      destructive: true,
      onConfirm: () => deleteMutation.mutateAsync(announcement.id),
    });
  };

  const columns = [
    columnHelper.accessor("title", {
      header: () => m.admin_announcements_col_title(),
      cell: (info) => (
        <div className="flex max-w-80 flex-col gap-0.5">
          <span className="truncate font-medium">{info.getValue()}</span>
          <span className="truncate text-xs text-muted-foreground">
            {info.row.original.body}
          </span>
        </div>
      ),
    }),
    columnHelper.accessor("level", {
      header: () => m.admin_announcements_col_level(),
      cell: (info) => (
        <Badge variant={LEVEL_BADGE_VARIANT[info.getValue()]}>
          {LEVEL_LABELS[info.getValue()]()}
        </Badge>
      ),
    }),
    columnHelper.accessor("audience", {
      header: () => m.admin_announcements_col_audience(),
      cell: (info) => {
        const row = info.row.original;
        if (row.audience !== "plan") {
          return AUDIENCE_LABELS[info.getValue()]();
        }
        const names = row.planIds.map(
          (id) => planNameById.get(id) ?? m.admin_announcements_plan_unknown(),
        );
        return (
          <div className="flex flex-col gap-0.5">
            <span>{AUDIENCE_LABELS.plan()}</span>
            <span className="text-xs text-muted-foreground">
              {names.join(", ")}
            </span>
          </div>
        );
      },
    }),
    columnHelper.display({
      id: "schedule",
      header: () => m.admin_announcements_col_schedule(),
      cell: (info) => (
        <span className="text-sm">{scheduleText(info.row.original)}</span>
      ),
    }),
    columnHelper.accessor("pinned", {
      header: () => m.admin_announcements_col_pinned(),
      cell: (info) =>
        info.getValue() ? (
          <Badge variant="outline">{m.admin_announcements_pinned_on()}</Badge>
        ) : (
          <span className="text-sm text-muted-foreground">
            {m.admin_announcements_pinned_off()}
          </span>
        ),
    }),
    columnHelper.accessor("published", {
      header: () => m.admin_announcements_col_published(),
      cell: (info) => {
        const announcement = info.row.original;
        return (
          <Switch
            aria-label={m.admin_announcements_toggle_published()}
            checked={announcement.published}
            disabled={
              togglePublishedMutation.isPending &&
              togglePublishedMutation.variables?.id === announcement.id
            }
            onCheckedChange={(published) =>
              togglePublishedMutation.mutate({
                id: announcement.id,
                published,
              })
            }
          />
        );
      },
    }),
    columnHelper.display({
      id: "actions",
      header: () => (
        <span className="sr-only">{m.admin_announcements_col_actions()}</span>
      ),
      cell: (info) => {
        const announcement = info.row.original;
        return (
          <div className="flex justify-end">
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    loading={
                      deleteMutation.isPending &&
                      deleteMutation.variables === announcement.id
                    }
                    size="icon"
                    variant="ghost"
                  />
                }
                aria-label={m.admin_announcements_col_actions()}
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => openEdit(announcement)}>
                  {m.admin_announcements_action_edit()}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  variant="destructive"
                  onClick={() => void requestDelete(announcement)}
                >
                  {m.admin_announcements_action_delete()}
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        );
      },
    }),
  ];

  const table = useReactTable({
    data: announcements ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader>
        <PageHeaderTitle>{m.admin_nav_announcements()}</PageHeaderTitle>
        <Button onClick={openCreate}>
          <PlusIcon />
          {m.admin_announcements_add()}
        </Button>
      </PageHeader>

      <Alert variant="info">
        <InfoIcon />
        <AlertDescription>
          <p>{m.admin_announcements_note()}</p>
        </AlertDescription>
      </Alert>

      {isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : isError ? (
        <div className="flex flex-col items-center gap-4 py-16">
          <Alert variant="error" className="max-w-md">
            <AlertTitle>{m.admin_announcements_error_title()}</AlertTitle>
            <AlertDescription>
              {m.admin_announcements_error_description()}
            </AlertDescription>
          </Alert>
          <Button loading={isFetching} onClick={() => void refetch()}>
            {m.admin_announcements_error_retry()}
          </Button>
        </div>
      ) : announcements.length > 0 ? (
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
                className={row.original.published ? undefined : "opacity-60"}
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
              <MegaphoneIcon />
            </EmptyMedia>
            <EmptyTitle>{m.admin_announcements_empty_title()}</EmptyTitle>
          </EmptyHeader>
          <Button onClick={openCreate}>
            <PlusIcon />
            {m.admin_announcements_add()}
          </Button>
        </Empty>
      )}

      <AnnouncementDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        announcement={editing}
      />
    </div>
  );
}
