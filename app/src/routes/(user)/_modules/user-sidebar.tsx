import { Link, useLocation } from "@tanstack/react-router";
import { LifeBuoyIcon } from "lucide-react";
import type { ComponentProps } from "react";
import DashboardLine from "~icons/mingcute/dashboard-3-line";
import WalletLine from "~icons/mingcute/wallet-line";

import { usePublicSettings } from "@/components/app-shell/site-notices";
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

/** "Get help" links to the support page and/or address the admin configured. */
function SupportLinks() {
  const { data } = usePublicSettings();
  const links: { href: string; label: string; external: boolean }[] = [];
  if (data?.supportUrl) {
    links.push({
      href: data.supportUrl,
      label: m.user_nav_get_help(),
      external: true,
    });
  }
  if (data?.supportEmail) {
    links.push({
      href: `mailto:${data.supportEmail}`,
      label: data.supportUrl
        ? m.user_nav_email_support()
        : m.user_nav_get_help(),
      external: false,
    });
  }
  if (links.length === 0) return null;

  return (
    <SidebarGroup className="mt-auto">
      <SidebarMenu>
        {links.map((link) => (
          <SidebarMenuItem key={link.href}>
            <SidebarMenuButton
              render={
                <a
                  href={link.href}
                  {...(link.external
                    ? { target: "_blank", rel: "noopener noreferrer" }
                    : {})}
                >
                  <LifeBuoyIcon />
                  <span>{link.label}</span>
                </a>
              }
            />
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
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

        <SupportLinks />
      </SidebarContent>

      <SidebarFooter>
        <UserProfileMenu user={user} />
      </SidebarFooter>
    </Sidebar>
  );
}
