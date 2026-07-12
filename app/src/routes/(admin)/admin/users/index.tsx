import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { EllipsisIcon, UsersIcon } from "lucide-react";
import type React from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { m } from "@/paraglide/messages";
import { listUsers, type UserListItem, USERS_QUERY_KEY } from "@/query/users";

import { useUserActions } from "./_modules/use-user-actions";

export const Route = createFileRoute("/(admin)/admin/users/")({
  component: RouteComponent,
});

const columnHelper = createColumnHelper<UserListItem>();

function RouteComponent(): React.ReactElement {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: users, isPending } = useQuery({
    queryKey: USERS_QUERY_KEY,
    queryFn: () => listUsers(),
  });

  const actions = useUserActions(() =>
    queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY }),
  );

  const openDetail = (user: UserListItem) =>
    void navigate({
      to: "/admin/users/$userId",
      params: { userId: user.id },
    });

  const columns = [
    columnHelper.accessor("name", {
      header: () => m.admin_users_col_user(),
      cell: (info) => {
        const user = info.row.original;
        return (
          <div className="flex items-center gap-2.5">
            <Avatar className="size-8">
              {user.image ? <AvatarImage src={user.image} /> : null}
              <AvatarFallback>
                {user.name.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">{user.name}</span>
              <span className="text-xs text-muted-foreground">
                {user.email}
              </span>
            </div>
          </div>
        );
      },
    }),
    columnHelper.accessor("role", {
      header: () => m.admin_users_col_role(),
      cell: (info) =>
        info.getValue() === "admin" ? (
          <Badge>{m.admin_users_role_admin()}</Badge>
        ) : (
          <Badge variant="outline">{m.admin_users_role_user()}</Badge>
        ),
    }),
    columnHelper.accessor("banned", {
      header: () => m.admin_users_col_status(),
      cell: (info) =>
        info.getValue() ? (
          <Badge variant="outline">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-destructive"
            />
            {m.admin_users_status_banned()}
          </Badge>
        ) : (
          <Badge variant="outline">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-emerald-500"
            />
            {m.admin_users_status_active()}
          </Badge>
        ),
    }),
    columnHelper.accessor("subscriptionCount", {
      header: () => m.admin_users_col_subscriptions(),
      cell: (info) => <Badge variant="outline">{info.getValue()}</Badge>,
    }),
    columnHelper.accessor("createdAt", {
      header: () => m.admin_users_col_created(),
      cell: (info) => (
        <span className="text-xs text-muted-foreground">
          {new Date(info.getValue()).toLocaleDateString()}
        </span>
      ),
    }),
    columnHelper.display({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: (info) => {
        const user = info.row.original;
        return (
          <div className="flex justify-end">
            <Menu>
              <MenuTrigger
                render={<Button size="icon" variant="ghost" />}
                aria-label="Actions"
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => openDetail(user)}>
                  {m.admin_users_action_view()}
                </MenuItem>
                <MenuItem onClick={() => actions.toggleRole(user)}>
                  {user.role === "admin"
                    ? m.admin_users_action_make_user()
                    : m.admin_users_action_make_admin()}
                </MenuItem>
                <MenuSeparator />
                {user.banned ? (
                  <MenuItem onClick={() => actions.unban(user)}>
                    {m.admin_users_action_unban()}
                  </MenuItem>
                ) : (
                  <MenuItem
                    variant="destructive"
                    onClick={() => void actions.requestBan(user)}
                  >
                    {m.admin_users_action_ban()}
                  </MenuItem>
                )}
              </MenuPopup>
            </Menu>
          </div>
        );
      },
    }),
  ];

  const table = useReactTable({
    data: users ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-lg font-semibold">
          {m.admin_nav_users()}
        </h1>
      </div>

      {isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : users && users.length > 0 ? (
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
              <TableRow key={row.id}>
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
              <UsersIcon />
            </EmptyMedia>
            <EmptyTitle>{m.admin_users_empty_title()}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}
