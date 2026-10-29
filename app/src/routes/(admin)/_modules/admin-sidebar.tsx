import { Link, useLocation } from "@tanstack/react-router";
import {
  ChartColumnIcon,
  MegaphoneIcon,
  PlugIcon,
  ScrollTextIcon,
  SettingsIcon,
  TicketIcon,
} from "lucide-react";
import type { ComponentProps } from "react";
import BillLine from "~icons/mingcute/bill-line";
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
import type { SessionUser } from "@/lib/auth";
import { m } from "@/paraglide/messages";

import { NavProxies } from "./nav-proxies";

export interface AdminSidebarProps extends ComponentProps<typeof Sidebar> {
  user: SessionUser;
}

export function AdminSidebar({ user, ...props }: AdminSidebarProps) {
  const { pathname } = useLocation();

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <RoleSwitcher role="admin" isAdmin={user.role === "admin"} />
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
                isActive={pathname.startsWith("/admin/mcp")}
                render={
                  <Link to="/admin/mcp">
                    <PlugIcon />
                    <span>{m.admin_nav_mcp()}</span>
                  </Link>
                }
              />
            </SidebarMenuItem>
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
                isActive={pathname.startsWith("/admin/subscriptions")}
                render={
                  <Link to="/admin/subscriptions">
                    <BillLine />
                    <span>{m.admin_nav_subscriptions()}</span>
                  </Link>
                }
              />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/admin/redeem")}
                render={
                  <Link to="/admin/redeem">
                    <TicketIcon />
                    <span>{m.admin_nav_redeem()}</span>
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
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/admin/announcements")}
                render={
                  <Link to="/admin/announcements">
                    <MegaphoneIcon />
                    <span>{m.admin_nav_announcements()}</span>
                  </Link>
                }
              />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/admin/traffic")}
                render={
                  <Link to="/admin/traffic">
                    <ChartColumnIcon />
                    <span>{m.admin_traffic_nav()}</span>
                  </Link>
                }
              />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/admin/audit")}
                render={
                  <Link to="/admin/audit">
                    <ScrollTextIcon />
                    <span>{m.admin_audit_nav()}</span>
                  </Link>
                }
              />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/admin/settings")}
                render={
                  <Link to="/admin/settings">
                    <SettingsIcon />
                    <span>{m.admin_nav_settings()}</span>
                  </Link>
                }
              />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <UserProfileMenu user={user} />
      </SidebarFooter>
    </Sidebar>
  );
}
