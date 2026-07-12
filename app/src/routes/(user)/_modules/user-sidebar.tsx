import { Link, useLocation } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import DashboardLine from "~icons/mingcute/dashboard-3-line";
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

export interface UserSidebarProps extends ComponentProps<typeof Sidebar> {
  user: SessionUser;
}

export function UserSidebar({ user, ...props }: UserSidebarProps) {
  const { pathname } = useLocation();

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <RoleSwitcher role="user" isAdmin={user.role === "admin"} />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname === "/dashboard"}
                render={
                  <Link to="/dashboard">
                    <DashboardLine />
                    <span>{m.user_nav_dashboard()}</span>
                  </Link>
                }
              />
            </SidebarMenuItem>

            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/dashboard/subscriptions")}
                render={
                  <Link to="/dashboard/subscriptions">
                    <WalletLine />
                    <span>{m.user_nav_subscriptions()}</span>
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
