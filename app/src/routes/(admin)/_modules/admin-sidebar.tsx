import { Link, useLocation } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import DashboardLine from "~icons/mingcute/dashboard-3-line";
import UserLine from "~icons/mingcute/user-3-line";
import WalletLine from "~icons/mingcute/wallet-line";

import { RoleSwitcher } from "@/components/role-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { UserProfileMenu } from "@/components/user-profile-menu";
import { m } from "@/paraglide/messages";

import { NavProxies } from "./nav-proxies";

export function AdminSidebar({ ...props }: ComponentProps<typeof Sidebar>) {
  const { pathname } = useLocation();

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <RoleSwitcher />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          {/* <SidebarGroupLabel>Overview</SidebarGroupLabel> */}
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname === "/admin"}
                render={
                  <Link to="/admin">
                    <DashboardLine />
                    <span>{m.admin_nav_dashboard()}</span>
                  </Link>
                }
              />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup>
          {/* <SidebarGroupLabel>Management</SidebarGroupLabel> */}
          <SidebarMenu>
            <NavProxies />
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/admin/plans")}
                render={
                  <Link to="/admin/plans">
                    <WalletLine />
                    <span>{m.admin_nav_plans()}</span>
                  </Link>
                }
              />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/admin/users")}
                render={
                  <Link to="/admin/users">
                    <UserLine />
                    <span>{m.admin_nav_users()}</span>
                  </Link>
                }
              />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <UserProfileMenu />
      </SidebarFooter>
    </Sidebar>
  );
}
