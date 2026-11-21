import { Link, useLocation } from "@tanstack/react-router";
import {
  ActivityIcon,
  LayoutDashboardIcon,
  NetworkIcon,
  ServerIcon,
  UsersIcon,
} from "lucide-react";
import type { ComponentProps } from "react";

import { RoleSwitcher } from "@/components/role-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { UserProfileMenu } from "@/components/user-profile-menu";
import { getAdminWorkspace } from "@/lib/admin-workspace";
import type { SessionUser } from "@/lib/auth";
import { m } from "@/paraglide/messages";

export interface AdminSidebarProps extends ComponentProps<typeof Sidebar> {
  user: SessionUser;
}

/**
 * Icon-only activity rail. Each workspace has one icon link with a localized
 * name and a tooltip in the shared Sidebar icon mode; account and role
 * controls stay at the bottom.
 */
export function AdminSidebar({ user, ...props }: AdminSidebarProps) {
  const { pathname } = useLocation();
  const activeWorkspace = getAdminWorkspace(pathname);

  const workspaces = [
    {
      id: "overview",
      label: m.admin_workspace_overview(),
      href: "/admin",
      icon: LayoutDashboardIcon,
    },
    {
      id: "servers",
      label: m.admin_workspace_servers(),
      href: "/admin/servers",
      icon: ServerIcon,
    },
    {
      id: "networking",
      label: m.admin_workspace_networking(),
      href: "/admin/networking",
      icon: NetworkIcon,
    },
    {
      id: "access",
      label: m.admin_workspace_access(),
      href: "/admin/access",
      icon: UsersIcon,
    },
    {
      id: "operations",
      label: m.admin_workspace_operations(),
      href: "/admin/operations",
      icon: ActivityIcon,
    },
  ] as const;

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {workspaces.map((workspace) => {
              const Icon = workspace.icon;

              return (
                <SidebarMenuItem key={workspace.id}>
                  <SidebarMenuButton
                    isActive={activeWorkspace === workspace.id}
                    tooltip={workspace.label}
                    render={
                      <Link to={workspace.href} aria-label={workspace.label}>
                        <Icon />
                        <span>{workspace.label}</span>
                      </Link>
                    }
                  />
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="gap-1">
        <RoleSwitcher role="admin" isAdmin={user.role === "admin"} />
        <UserProfileMenu user={user} />
      </SidebarFooter>
    </Sidebar>
  );
}
